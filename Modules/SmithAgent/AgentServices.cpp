// AgentServices.cpp - hosted auxiliary services: the embedded Discord bot
// (provision/start/stop/reconcile) and the Steam Guard relay task.
// Split from Agent.cpp (800-line standard); pure moves, no behavior change.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Agent.h"
#include "AgentUtil.h"
#include "DiscordBotAsset.h"

#include <SmithCore/Process.h>
#include <SmithCore/Handoff.h>
#include <SmithCore/TimeUtil.h>
#include <SmithCore/Strings.h>
#include <SmithProtocol/WireJson.h>
#include <Log/Log.h>

#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <thread>

namespace fs = std::filesystem;

namespace Smith
{
    void Agent::ServiceLoop()
    {
        while (!m_stop)
        {
            try { PollService(); }
            catch (const std::exception& e) { LOG_ERROR("Smith", "service iteration error (continuing): %s", e.what()); }
            catch (...) { LOG_ERROR("Smith", "service iteration error (continuing): unknown exception"); }
            for (int i = 0; i < m_cfg.heartbeatSec * 20 && !m_stop; ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        StopBotService();
    }

    // Ask the coordinator what auxiliary service (if any) this agent should be running and
    // reconcile to it. Best-effort: any error just leaves the current state untouched.
    void Agent::PollService()
    {
        Http::Result res = DoGet(m_cfg, "/api/agents/" + m_nodeId + "/service");
        if (!res.ok || res.status != 200) return;
        ServiceSpec spec;
        if (FromJson(res.body, spec)) ReconcileService(spec);
    }

    void Agent::ReconcileService(const ServiceSpec& spec)
    {
        if (spec.action != "run")
        {
            if (m_serviceProc) StopBotService();
            std::lock_guard<std::mutex> lock(m_serviceMutex);
            m_serviceStatus.clear();             // not hosting -> nothing to report
            m_serviceDetail.clear();
            return;
        }
        if (m_serviceProc && m_serviceProc->Running() && m_serviceHash == spec.specHash) return;  // healthy, nothing to do
        if (m_serviceProc && !m_serviceProc->Running())
        {
            // Died on its own: remember why (its last output line) until a relaunch succeeds.
            std::lock_guard<std::mutex> lock(m_serviceMutex);
            m_serviceStatus = "exited";
            m_serviceDetail = m_serviceLastLine;
        }
        if (m_serviceProc) StopBotService();                                          // reap a crashed/stale bot
        // Back off relaunching the SAME spec so a bot that can't start (missing deps, bad
        // token, ...) doesn't crash-loop and flood the log. A new spec relaunches at once.
        int64_t now = NowMillis();
        if (spec.specHash == m_serviceAttemptHash && now - m_serviceLastAttemptMs < 30000) return;
        m_serviceAttemptHash = spec.specHash;
        m_serviceLastAttemptMs = now;
        // A throw here (e.g. bad_alloc while provisioning) must not escape to the
        // heartbeat thread. Record it as a "failed" status so the coordinator benches
        // this host and fails the bot over to a healthy peer instead of re-trying us.
        try { StartBotService(spec); }
        catch (const std::exception& e)
        {
            LOG_ERROR("Smith", "Discord bot: launch threw (%s); reporting failed so the coordinator re-places it", e.what());
            std::lock_guard<std::mutex> lock(m_serviceMutex);
            m_serviceStatus = "failed";
            m_serviceDetail = std::string("bot launch error: ") + e.what();
        }
        catch (...)
        {
            LOG_ERROR("Smith", "Discord bot: launch threw (unknown); reporting failed");
            std::lock_guard<std::mutex> lock(m_serviceMutex);
            m_serviceStatus = "failed";
            m_serviceDetail = "bot launch error (unknown exception)";
        }
    }

    void Agent::StopBotService()
    {
        if (!m_serviceProc) return;
        LOG_INFO("Smith", "Discord bot: stopping");
        m_serviceProc->Kill();
        m_serviceProc.reset();
        m_serviceHash.clear();
    }

    // Return a python interpreter that can `import discord, requests`, or "" if none can be
    // provisioned. Prefers a venv under <dir>/venv (created + pip-installed once, marker-guarded,
    // bootstrapping pip via ensurepip if the venv lacks it); falls back to the system python3 if
    // it already has the deps. requirements.txt must already be materialized in dir.
    std::string Agent::ProvisionBotPython(const std::string& dirStr)
    {
        std::error_code ec;
        fs::path dir(dirStr);
#ifdef _WIN32
        fs::path venvPy = dir / "venv" / "Scripts" / "python.exe";
#else
        fs::path venvPy = dir / "venv" / "bin" / "python";
#endif
        auto run = [&](std::vector<std::string> argv, int tmo) {
            ProcessOptions o; o.argv = std::move(argv); o.workingDir = dir.string(); o.timeoutSeconds = tmo;
            Process p; return p.Run(o, [](bool e, const std::string& l) { if (!l.empty()) LOG_INFO("Smith", "[bot-setup]%s %s", e ? "(err)" : "", l.c_str()); });
        };
        auto withArgs = [](std::vector<std::string> base, std::initializer_list<const char*> extra) {
            for (const char* a : extra) base.push_back(a);
            return base;
        };
        auto canImport = [&](const std::vector<std::string>& py) {
            ProcessOptions o; o.argv = withArgs(py, { "-c", "import discord, requests" }); o.timeoutSeconds = 30;
            Process p; return p.Run(o, nullptr) == 0;
        };

        std::string marker = ".deps-" + std::to_string(std::hash<std::string>{}(std::string(kDiscordRequirements)));

        // Fast path: venv already provisioned for exactly these requirements.
        if (fs::exists(venvPy, ec) && fs::exists(dir / marker, ec) && canImport({ venvPy.string() }))
            return venvPy.string();

        std::vector<std::string> basePython;
        for (const auto& cand : PythonCandidates())
        {
            ProcessOptions o; o.argv = withArgs(cand, { "-c", "import sys" }); o.timeoutSeconds = 30;
            Process p;
            if (p.Run(o, nullptr) == 0) { basePython = cand; break; }
        }

        if (!fs::exists(venvPy, ec) && !basePython.empty())
        {
            LOG_INFO("Smith", "Discord bot: creating Python venv with '%s'", basePython[0].c_str());
            run(withArgs(basePython, { "-m", "venv", "venv" }), 120);
        }
        if (fs::exists(venvPy, ec))
        {
            ProcessOptions pc; pc.argv = { venvPy.string(), "-m", "pip", "--version" }; pc.timeoutSeconds = 30;
            Process pp;
            if (pp.Run(pc, nullptr) != 0) run({ venvPy.string(), "-m", "ensurepip", "--upgrade" }, 120);  // bootstrap pip if absent
            run({ venvPy.string(), "-m", "pip", "install", "-q", "-r", "requirements.txt" }, 600);
            if (canImport({ venvPy.string() }))
            {
                std::ofstream(dir / marker, std::ios::binary | std::ios::trunc) << kDiscordRequirements;
                return venvPy.string();
            }
        }
        // Fallback: the system interpreter already satisfies the deps (no usable venv pip).
        if (!basePython.empty() && canImport(basePython))
        {
            LOG_INFO("Smith", "Discord bot: using system %s", basePython[0].c_str());
            return basePython[0];
        }
        return "";
    }

    bool Agent::StartBotService(const ServiceSpec& spec)
    {
        std::error_code ec;
        fs::path dir = fs::path(m_cfg.workspace) / ".smith-discord";
        fs::create_directories(dir, ec);

        // Materialize the embedded bot + requirements (overwrite to track the binary).
        { std::ofstream o(dir / "smith-discord-bot.py", std::ios::binary | std::ios::trunc); o << kDiscordBotPy; }
        { std::ofstream o(dir / "requirements.txt", std::ios::binary | std::ios::trunc); o << kDiscordRequirements; }

        std::string py = ProvisionBotPython(dir.string());
        if (py.empty())
        {
#ifdef _WIN32
            const char* hint = "install Python 3 (e.g. winget install Python.Python.3.12)";
#else
            const char* hint = "install python3-venv + python3-pip";
#endif
            LOG_ERROR("Smith", "Discord bot: no usable Python 3 with discord.py + requests. %s on this agent, "
                              "or pre-install the deps (pip install discord.py requests).", hint);
            std::lock_guard<std::mutex> lock(m_serviceMutex);
            m_serviceStatus = "failed";
            m_serviceDetail = std::string("no usable Python 3 with discord.py + requests (") + hint + ")";
            return false;
        }

        ProcessOptions o;
        o.argv = { py, "smith-discord-bot.py" };
        o.workingDir = dir.string();
        o.timeoutSeconds = 0;                 // long-lived daemon
        o.envOverride = spec.env;             // discord/ollama/notify config from the coordinator
        // Per-agent bits the coordinator can't know: how *we* reach it, and our node identity.
        o.envOverride["SMITH_COORDINATOR_URL"] = m_cfg.coordinatorUrl;
        o.envOverride["SMITH_API_TOKEN"] = m_cfg.token;
        o.envOverride["SMITH_NODE"] = m_cfg.name;

        m_serviceProc = std::make_unique<Process>();
        if (!m_serviceProc->Start(o, [this](bool isErr, const std::string& l) {
                if (!l.empty()) { std::lock_guard<std::mutex> lock(m_serviceMutex); m_serviceLastLine = l; }
                LOG_INFO("Smith", "[discord-bot]%s %s", isErr ? "(err)" : "", l.c_str()); }))
        {
            LOG_ERROR("Smith", "Discord bot: failed to launch");
            m_serviceProc.reset();
            std::lock_guard<std::mutex> lock(m_serviceMutex);
            m_serviceStatus = "failed";
            m_serviceDetail = "process failed to launch";
            return false;
        }
        m_serviceHash = spec.specHash;
        LOG_INFO("Smith", "Discord bot: launched with %s (spec %s)", py.c_str(), spec.specHash.c_str());
        {
            std::lock_guard<std::mutex> lock(m_serviceMutex);
            m_serviceStatus = "running";
            m_serviceDetail.clear();
        }
        return true;
    }

    void Agent::RunSteamGuardTask(const SteamGuardTask& task)
    {
        bool expected = false;
        if (!m_guardBusy.compare_exchange_strong(expected, true))
        {
            LOG_WARNING("Smith", "Steam Guard: a task is already running; dropping request %s", task.requestId.c_str());
            return;
        }
        // Off-thread: steamcmd can take a minute, and a blocked heartbeat loop would
        // make this node look offline.
        std::thread([this, task]() {
            std::string detail;
            bool ok = false;

            std::error_code ec;
            std::string credFile = fs::absolute("smith-agent-credentials.json", ec).string();
            std::map<std::string, std::string> creds = ResolveCredentials(credFile, task.credentialRef);
            std::string user = creds.count("username") ? creds["username"] : "";
            std::string pass = creds.count("password") ? creds["password"] : "";
            if (user.empty())
            {
                detail = "no credentials for '" + task.credentialRef + "' in smith-agent-credentials.json";
            }
            else
            {
                LOG_INFO("Smith", "Steam Guard: entering code for credential '%s' (request %s)",
                         task.credentialRef.c_str(), task.requestId.c_str());   // never the code
                ProcessOptions o;
                // The code must be set BEFORE the login that consumes it.
                o.argv = { "steamcmd", "+set_steam_guard_code", task.code, "+login", user };
                if (!pass.empty()) o.argv.push_back(pass);
                o.argv.push_back("+quit");
                o.timeoutSeconds = 240;
                bool loggedIn = false;
                std::string lastLine;
                Process p;
                int rc = p.Run(o, [&](bool isErr, const std::string& l) {
                    if (!l.empty()) lastLine = l;
                    if (l.find("Logged in OK") != std::string::npos) loggedIn = true;
                    LOG_INFO("Smith", "[steam-guard]%s %s", isErr ? "(err)" : "", l.c_str());
                });
                ok = (rc == 0 && loggedIn);
                detail = ok ? "Logged in OK" : (lastLine.empty() ? ("steamcmd exit " + std::to_string(rc)) : lastLine);
                if (detail.size() > 300) detail = detail.substr(detail.size() - 300);
            }

            std::string body = std::string("{\"ok\":") + (ok ? "true" : "false") +
                               ",\"detail\":\"" + JsonEscape(detail) + "\"}";
            DoPost(m_cfg, "/api/steam-guard/" + task.requestId + "/result", body);
            LOG_INFO("Smith", "Steam Guard: request %s %s", task.requestId.c_str(), ok ? "succeeded" : "failed");
            m_guardBusy = false;
        }).detach();
    }

}
