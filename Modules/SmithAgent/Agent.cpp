// Agent.cpp - Smith build agent runtime.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Agent.h"
#include "ToolMaintenance.h"
#include "AgentUtil.h"

#include <SmithCore/Process.h>
#include <SmithCore/GitRepo.h>
#include <SmithCore/Handoff.h>
#include <SmithCore/TimeUtil.h>
#include <SmithCore/Discovery.h>
#include <SmithCore/Capabilities.h>
#include <SmithCore/Strings.h>
#include <SmithCore/Housekeeping.h>
#include "DiscordBotAsset.h"
#include <SmithProtocol/WireJson.h>
#include <Http/Http.h>
#include <Log/Log.h>

#include <zip.h>   // kuba--/zip (miniz): artifact packaging when package == "zip"

#include <filesystem>
#include <fstream>
#include <sstream>
#include <functional>
#include <regex>
#include <mutex>
#include <atomic>
#include <chrono>
#include <algorithm>
#include <cstring>
#include <cctype>

namespace fs = std::filesystem;
using LogFn = std::function<void(bool, const std::string&)>;

namespace Smith
{
    // True if a usable Python 3 exists - advertised as a 'python3' capability label
    // so nodeSelectors can target it (and so bot-hosting failures are explicable).
    static bool ProbePython3()
    {
        for (auto argv : PythonCandidates())
        {
            argv.push_back("-c");
            argv.push_back("import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)");
            ProcessOptions o; o.argv = std::move(argv); o.timeoutSeconds = 10;
            Process p;
            if (p.Run(o, nullptr) == 0) return true;
        }
        return false;
    }

    // The Discord bot is self-provisioning only after Python can create a venv.
    // On Debian/Ubuntu, a bare python3 interpreter may be present while the
    // python3-venv package is not; advertising that machine as a bot host would
    // make the coordinator repeatedly migrate the bot there only for setup to fail.
    static bool ProbePythonVenv()
    {
        for (auto argv : PythonCandidates())
        {
            argv.push_back("-m");
            argv.push_back("venv");
            argv.push_back("--help");
            ProcessOptions o; o.argv = std::move(argv); o.timeoutSeconds = 10;
            Process p;
            if (p.Run(o, nullptr) == 0) return true;
        }
        return false;
    }

    // True if a local Ollama answers - the Discord bot needs one on its host, so the
    // coordinator prefers Ollama-equipped nodes when placing it. Cheap (2s timeout),
    // probed at registration and refreshed every ~minute from the heartbeat loop.
    static bool ProbeOllama()
    {
        Http::Client c("http://127.0.0.1:11434");
        c.SetTimeoutSeconds(2);
        Http::Result r = c.Get("/api/version");
        return r.ok && r.status == 200;
    }

    static std::string Join(const std::vector<std::string>& argv)
    {
        std::string s;
        for (size_t i = 0; i < argv.size(); ++i) { if (i) s += ' '; s += argv[i]; }
        return s;
    }

    static bool IsSuccess(int rc, const std::vector<int>& codes)
    {
        if (codes.empty()) return rc == 0;
        return std::find(codes.begin(), codes.end(), rc) != codes.end();
    }

    static bool ReadWholeFile(const fs::path& p, std::string& out)
    {
        std::ifstream in(p, std::ios::binary);
        if (!in) return false;
        std::stringstream ss; ss << in.rdbuf(); out = ss.str();
        return true;
    }

    static std::string UrlEncode(const std::string& s)
    {
        static const char* hex = "0123456789ABCDEF";
        std::string out;
        for (unsigned char c : s)
        {
            if (std::isalnum(c) || c == '-' || c == '_' || c == '.') out += (char)c;
            else { out += '%'; out += hex[c >> 4]; out += hex[c & 0xF]; }
        }
        return out;
    }

    static std::vector<std::string> BuildArgv(const CommandSpec& cmd, const std::string& workingDir)
    {
        std::string scriptAbs = (fs::path(workingDir) / cmd.script).string();
        std::vector<std::string> argv;
        const std::string& interp = cmd.interpreter;
        if (interp == "ps1") argv = { "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptAbs };
        else if (interp == "bat") argv = { "cmd", "/c", scriptAbs };
        else if (interp == "sh") argv = { "/bin/sh", scriptAbs };
        else if (interp == "python") argv = { "python", scriptAbs };
        else if (interp == "exe") argv = { scriptAbs };
        else return {};
        for (const auto& a : cmd.args) argv.push_back(a);
        return argv;
    }

    Agent::Agent(AgentConfig cfg) : m_cfg(std::move(cfg)) {}
    Agent::~Agent() { Stop(); }

    bool Agent::Register()
    {
        RegisterRequest rr;
        rr.hostname = m_cfg.name;
        rr.os = m_cfg.os;
        rr.arch = m_cfg.arch;
        rr.labels = m_cfg.labels;
        // Auto-advertise capability labels derived from the environment (e.g. una-engine
        // when a bootstrapped Una engine is present), merged with any manual --agent-labels.
        // So an agent on a box with UNA_ENGINE_PATH set can run Una builds with no hand-tagging.
        {
            std::string enginePath;
            auto it = m_cfg.buildEnv.find("UNA_ENGINE_PATH");
            if (it != m_cfg.buildEnv.end()) enginePath = it->second;
            if (enginePath.empty()) { const char* e = std::getenv("UNA_ENGINE_PATH"); if (e) enginePath = e; }
            std::vector<std::string> caps = DetectCapabilityLabels(enginePath);
            for (const auto& cap : caps)
                if (std::find(rr.labels.begin(), rr.labels.end(), cap) == rr.labels.end()) rr.labels.push_back(cap);
            // Say WHY una-engine was not advertised - a missing env var in the agent's
            // launch context looks identical to a missing engine otherwise.
            if (std::find(caps.begin(), caps.end(), "una-engine") == caps.end())
            {
                if (enginePath.empty())
                    LOG_WARNING("Smith", "una-engine label not advertised: UNA_ENGINE_PATH is not set for this agent");
                else
                    LOG_WARNING("Smith", "una-engine label not advertised: no bootstrapped BuildTool under %s", enginePath.c_str());
            }
        }
        rr.agentVersion = "0.1.0";
        rr.protocolVersion = kProtocolVersion;

        // Report NVIDIA VRAM so the coordinator can place the Discord bot (Ollama) on
        // the agent with the most free GPU memory. Detect once; heartbeats refresh free.
        {
            GpuInfo gpu = DetectGpu();
            m_hasGpu = gpu.present;
            m_gpuTotalMb = gpu.totalMb;
            rr.gpuTotalMb = gpu.totalMb;
            rr.gpuFreeMb = gpu.freeMb;
            if (gpu.present)
                LOG_INFO("Smith", "GPU detected: %d MiB total, %d MiB free", gpu.totalMb, gpu.freeMb);
        }
        m_ollamaUp = ProbeOllama();
        rr.ollamaUp = m_ollamaUp;
        if (m_ollamaUp)
        {
            // Also advertise it as a capability label: visible in the nodes UI and
            // usable in nodeSelector, like any other capability. The heartbeat field
            // stays the live signal for bot placement (Ollama can stop mid-session).
            if (std::find(rr.labels.begin(), rr.labels.end(), "ollama") == rr.labels.end())
                rr.labels.push_back("ollama");
            LOG_INFO("Smith", "Local Ollama detected (eligible to host the Discord bot)");
        }
        bool hasPython3 = ProbePython3();
        if (hasPython3)
        {
            if (std::find(rr.labels.begin(), rr.labels.end(), "python3") == rr.labels.end())
                rr.labels.push_back("python3");
        }
        else
            LOG_WARNING("Smith", "python3 label not advertised: no usable Python 3 on this machine");
        if (hasPython3 && ProbePythonVenv())
        {
            rr.labels.push_back("discord-host");
            LOG_INFO("Smith", "Discord bot hosting capability detected: Python venv is available");
        }
        else if (hasPython3)
            LOG_WARNING("Smith", "Discord bot hosting unavailable: Python venv support is missing (install python3-venv + python3-pip on Linux)");
        // Unity Linux build support (incl. the IL2CPP cross-toolchain) earns
        // unity-linux / unity-linux-il2cpp, so Linux player builds can dispatch to
        // Windows/mac nodes that have the Hub module installed.
        std::vector<std::string> unityPlatformCaps = DetectUnityLinuxLabels(DefaultUnityEditorRoots());
        // iOS / Android build-support modules earn unity-ios / unity-android.
        for (const auto& cap : DetectUnityMobileLabels(DefaultUnityEditorRoots()))
            unityPlatformCaps.push_back(cap);
        for (const auto& cap : unityPlatformCaps)
        {
            if (std::find(rr.labels.begin(), rr.labels.end(), cap) == rr.labels.end())
                rr.labels.push_back(cap);
            LOG_INFO("Smith", "Unity capability detected: %s", cap.c_str());
        }
        // Installed Unity editors also advertise their major version (e.g. unity6),
        // so nodeSelectors can pin a build to a node that has the right editor.
        for (const auto& cap : DetectUnityVersionLabels(DefaultUnityEditorRoots()))
        {
            if (std::find(rr.labels.begin(), rr.labels.end(), cap) == rr.labels.end())
                rr.labels.push_back(cap);
            LOG_INFO("Smith", "Unity capability detected: %s", cap.c_str());
        }
        // Common build tools / interpreters on PATH (cmake/gcc/clang/node/npm/ruby/
        // sbcl/wrangler), the shells available here (bash/cmd/powershell) and installed Unreal
        // engines (unreal + unreal<major>) are advertised the same way.
        {
            std::vector<std::string> tools = DetectPathToolLabels();
            for (const auto& cap : DetectShellLabels()) tools.push_back(cap);
            for (const auto& cap : DetectUnrealLabels()) tools.push_back(cap);
            // Blender's installers leave PATH alone, so it is looked for where it installs.
            m_blender = FindBlender();
            if (!m_blender.empty()) { tools.push_back("blender"); LOG_INFO("Smith", "Blender detected: %s", m_blender.c_str()); }
            for (const auto& cap : tools)
                if (std::find(rr.labels.begin(), rr.labels.end(), cap) == rr.labels.end())
                    rr.labels.push_back(cap);
        }

        { std::string ls; for (size_t i = 0; i < rr.labels.size(); ++i) { if (i) ls += ","; ls += rr.labels[i]; }
          LOG_INFO("Smith", "Agent capability labels: %s", ls.empty() ? "(none)" : ls.c_str()); }

        Http::Result res = DoPost(m_cfg, "/api/agents/register", ToJson(rr));
        if (!res.ok) { LOG_ERROR("Smith", "register failed: %s", res.error.c_str()); return false; }
        RegisterResponse resp;
        if (!FromJson(res.body, resp) || !resp.accepted)
        {
            LOG_ERROR("Smith", "register rejected: %s", resp.message.c_str());
            return false;
        }
        m_nodeId = resp.nodeId;
        LOG_INFO("Smith", "Registered with %s as node %s", m_cfg.coordinatorUrl.c_str(), m_nodeId.c_str());
        return true;
    }

    void Agent::HeartbeatLoop()
    {
        while (!m_stop)
        {
            for (int i = 0; i < m_cfg.heartbeatSec * 20 && !m_stop; ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
            if (m_stop) break;
            // A throw anywhere below (GPU probe, JSON, or HTTP)
            // must not unwind out of this thread - that aborts the whole process
            // (std::terminate). Log and keep beating, mirroring the coordinator's
            // DiscordLoop guard.
            const char* step = "begin";
            try
            {
            Heartbeat hb;
            hb.status = m_busy ? "busy" : "idle";
            hb.currentJobId = m_currentJobId;
            // Refresh free VRAM each beat (only if a GPU was found at startup, so boxes
            // without nvidia-smi don't spawn a doomed subprocess every 10s).
            step = "DetectGpu";
            if (m_hasGpu) hb.gpuFreeMb = DetectGpu().freeMb;
            // Re-probe the local Ollama every ~minute (it can be installed/started
            // without the agent restarting).
            step = "ProbeOllama";
            if (++m_beatCount % 6 == 0) m_ollamaUp = ProbeOllama();
            hb.ollamaUp = m_ollamaUp;
            {
                std::lock_guard<std::mutex> lock(m_serviceMutex);
                hb.serviceStatus = m_serviceStatus;
                hb.serviceDetail = m_serviceDetail;
            }
            step = "ToJson/DoPost heartbeat";
            Http::Result hbRes = DoPost(m_cfg, "/api/agents/" + m_nodeId + "/heartbeat", ToJson(hb));
            // The response may carry a one-shot Steam Guard task for this box.
            step = "FromJson(HeartbeatResponse)";
            HeartbeatResponse hr;
            if (hbRes.ok && hbRes.status == 200 && FromJson(hbRes.body, hr) && !hr.steamGuard.requestId.empty())
                RunSteamGuardTask(hr.steamGuard);
            }
            catch (const std::exception& e) { LOG_ERROR("Smith", "heartbeat iteration error at [%s] (continuing): %s", step, e.what()); }
            catch (...) { LOG_ERROR("Smith", "heartbeat iteration error (continuing): unknown exception"); }
        }
        StopBotService();    // tear the bot down when the agent shuts down
    }

    bool Agent::RediscoverCoordinator(const char* why)
    {
        LOG_INFO("Smith", "Discovering coordinator on udp/%d (%s) ...", m_cfg.discoveryPort, why);
        DiscoveryResult d = DiscoverCoordinator(m_cfg.discoveryPort, 1000, 5);
        if (d.found)
        {
            if (d.url != m_cfg.coordinatorUrl)
                LOG_INFO("Smith", "Discovered coordinator '%s' at %s", d.name.c_str(), d.url.c_str());
            m_cfg.coordinatorUrl = d.url;
            return true;
        }
        LOG_WARNING("Smith", "No coordinator answered discovery; keeping %s", m_cfg.coordinatorUrl.c_str());
        return false;
    }

    bool Agent::Run()
    {
        // Make the connection mode explicit in the log: a pinned coordinator
        // (remote/WAN-friendly - never broadcasts) vs zero-config LAN discovery.
        if (m_cfg.discover)
            LOG_INFO("Smith", "Agent discovering a coordinator on udp/%d (no --coordinator pinned)", m_cfg.discoveryPort);
        else
            LOG_INFO("Smith", "Agent using pinned coordinator %s (discovery off, no LAN broadcast)", m_cfg.coordinatorUrl.c_str());

        // Zero-config: when no --coordinator was given, broadcast on the LAN and
        // adopt the first coordinator that answers. On no reply, fall back to the
        // configured URL (localhost) rather than aborting.
        if (m_cfg.discover) RediscoverCoordinator("startup");

        // Retry registration so the agent tolerates being started before the
        // coordinator (and so the co-located embedded agent can wait for the
        // server thread to bind). When discovery is on we never give up: we keep
        // rescanning the LAN so the agent reconnects after a coordinator restart.
        // Cloudflare handoffs run a bare `wrangler`; install it on any Node-capable box
        // so the node advertises the label and can take those jobs. Once, before the
        // register retries - DetectPathToolLabels then picks it up.
        EnsureNpmGlobalTool("wrangler", "wrangler");

        int attempts = 0;
        while (!m_stop && !Register())
        {
            if (++attempts >= 30)
            {
                if (m_cfg.discover)
                {
                    LOG_WARNING("Smith", "no coordinator after %d attempts; rescanning the LAN", attempts);
                    attempts = 0;
                    RediscoverCoordinator("retry");
                    for (int i = 0; i < 30 && !m_stop; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
                    continue;
                }
                LOG_ERROR("Smith", "could not register with %s after %d attempts", m_cfg.coordinatorUrl.c_str(), attempts);
                return false;
            }
            for (int i = 0; i < 20 && !m_stop; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        if (m_stop) return true;
        m_heartbeatThread = std::thread(&Agent::HeartbeatLoop, this);
        m_serviceThread = std::thread(&Agent::ServiceLoop, this);
        LOG_INFO("Smith", "Agent '%s' (%s) registered with %s as node %s; polling every %dms",
                 m_cfg.name.c_str(), m_cfg.os.c_str(), m_cfg.coordinatorUrl.c_str(),
                 m_nodeId.c_str(), m_cfg.pollIntervalMs);
        {
            auto it = m_cfg.buildEnv.find("UNA_ENGINE_PATH");
            if (it != m_cfg.buildEnv.end()) LOG_INFO("Smith", "Builds will run with UNA_ENGINE_PATH=%s", it->second.c_str());
        }

        ToolMaintenance maintenance;
        int consecutiveFailures = 0;
        while (!m_stop)
        {
          try
          {
            std::shared_lock<std::shared_mutex> tools(maintenance.gate,std::try_to_lock);
            if (!tools.owns_lock()) { std::this_thread::sleep_for(std::chrono::milliseconds(100)); continue; }
            auto accountTools = TryAgentToolUse();
            if (!accountTools) { std::this_thread::sleep_for(std::chrono::milliseconds(100)); continue; }
            Http::Result res = DoGet(m_cfg, "/api/jobs/next?nodeId=" + m_nodeId);
            if (res.ok && res.status == 200)
            {
                consecutiveFailures = 0;
                JobAssignment asn;
                if (FromJson(res.body, asn) && asn.hasJob) { ProcessJob(asn.spec); continue; }
            }
            else if (res.ok && res.status == 404)
            {
                consecutiveFailures = 0;
                LOG_WARNING("Smith", "coordinator does not know this node; re-registering");
                Register();
            }
            else if (!res.ok)
            {
                ++consecutiveFailures;
                LOG_WARNING("Smith", "poll error (%d): %s", consecutiveFailures, res.error.c_str());
                // The coordinator may have moved (restarted on a new port/host).
                // After a few failures, rescan the LAN and re-register if it turns
                // up somewhere new, so the agent self-heals without a restart.
                if (m_cfg.discover && consecutiveFailures >= 4)
                {
                    std::string before = m_cfg.coordinatorUrl;
                    if (RediscoverCoordinator("reconnect") && m_cfg.coordinatorUrl != before)
                    {
                        if (Register())
                        {
                            LOG_INFO("Smith", "reconnected to coordinator at %s", m_cfg.coordinatorUrl.c_str());
                            consecutiveFailures = 0;
                        }
                    }
                }
            }
          }
          catch (const std::exception& e) { LOG_ERROR("Smith", "poll iteration error (continuing): %s", e.what()); }
          catch (...) { LOG_ERROR("Smith", "poll iteration error (continuing): unknown exception"); }
            for (int i = 0; i < m_cfg.pollIntervalMs / 50 && !m_stop; ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        return true;
    }

    void Agent::Stop()
    {
        m_stop = true;
        if (m_heartbeatThread.joinable()) m_heartbeatThread.join();
        if (m_serviceThread.joinable()) m_serviceThread.join();
    }

    void Agent::RequestCancelCurrent()
    {
        std::lock_guard<std::mutex> lk(m_procMutex);
        m_cancelled = true;
        if (m_activeProc) m_activeProc->Kill();   // unblocks RunBuild's p.Run()
    }

    void Agent::PostStatus(const std::string& jobId, const std::string& phase, const std::string& commit)
    {
        std::string body = "{\"phase\":\"" + phase + "\"";
        if (!commit.empty()) body += ",\"commit\":\"" + commit + "\"";   // a git sha: hex only, no escaping needed
        DoPost(m_cfg, "/api/jobs/" + jobId + "/status", body + "}");
    }

    void Agent::PostResult(const std::string& jobId, const JobResult& result)
    {
        DoPost(m_cfg, "/api/jobs/" + jobId + "/result", ToJson(result));
    }

    bool Agent::EnsureWorkspaceHealthy(const JobSpec& spec, const std::string& logDir, const LogFn& log)
    {
        // Cheap every build: keep the local build-log dir bounded.
        PruneLogs(logDir, m_cfg.logKeepDays, m_cfg.logKeepMax, log);

        if (m_cfg.minFreeDiskMb <= 0) return true;   // guard disabled

        std::error_code ec;
        fs::path wsRoot = fs::absolute(m_cfg.workspace, ec);
        fs::create_directories(wsRoot, ec);
        const uint64_t target = (uint64_t)m_cfg.minFreeDiskMb * 1024ull * 1024ull;

        uint64_t freeB = FreeDiskBytes(wsRoot.string());
        if (freeB < target)
        {
            log(true, "LOW DISK: " + std::to_string(freeB / (1024 * 1024)) + " MB free, below the " +
                      std::to_string(m_cfg.minFreeDiskMb) + " MB floor; reclaiming workspace space...");
            freeB = ReclaimWorkspaces(wsRoot.string(), spec.projectId, target, log);
            if (freeB < target)
            {
                log(true, "LOW DISK: still only " + std::to_string(freeB / (1024 * 1024)) +
                          " MB free after reclaiming; refusing this job to avoid filling the disk.");
                return false;
            }
            log(false, "Disk reclaimed: " + std::to_string(freeB / (1024 * 1024)) + " MB free.");
        }

        // Mark this project's workspace most-recently-used so it is evicted last.
        TouchDir((wsRoot / spec.projectId).string());
        return true;
    }

    bool Agent::Checkout(const JobSpec& spec, std::string& primaryDirOut, const LogFn& log)
    {
        std::error_code ec;
        fs::path wsRoot = fs::absolute(m_cfg.workspace, ec) / spec.projectId;
        fs::create_directories(wsRoot, ec);

        for (size_t i = 0; i < spec.repos.size(); ++i)
        {
            const RepoCheckout& repo = spec.repos[i];
            fs::path target = (repo.checkoutDir.empty() || repo.checkoutDir == ".") ? wsRoot : wsRoot / repo.checkoutDir;
            if (!GitRepo::Sync(repo.url, target.string(), repo.branch, repo.commit, log, repo.authToken, spec.clean))
                return false;
            if (i == 0) primaryDirOut = target.string();
        }
        if (primaryDirOut.empty()) primaryDirOut = wsRoot.string();
        return true;
    }

    bool Agent::StageInputs(const JobSpec& spec, const std::string& workingDir, const LogFn& log)
    {
        if (spec.inputs.empty()) return true;
        std::error_code ec;

        // The platform builds run independently, so the picked inputs may span
        // commits. That's allowed (latest-success semantics) but worth shouting
        // about: a deploy mixing versions is usually a half-rebuilt pipeline.
        std::vector<std::string> commits;
        for (const auto& in : spec.inputs)
        {
            std::string c = in.commit.substr(0, 7);
            if (!c.empty() && std::find(commits.begin(), commits.end(), c) == commits.end())
                commits.push_back(c);
        }
        if (commits.size() > 1)
        {
            std::string list;
            for (size_t i = 0; i < commits.size(); ++i) { if (i) list += ", "; list += commits[i]; }
            log(true, "INPUTS: WARNING - inputs span " + std::to_string(commits.size()) +
                      " different commits (" + list + "); the staged builds are not all from the same version.");
        }

        for (size_t i = 0; i < spec.inputs.size(); ++i)
        {
            const ArtifactInput& in = spec.inputs[i];
            std::string from = in.product + (in.variant.empty() ? "" : "/" + in.variant) +
                               " build #" + std::to_string(in.buildNumber) +
                               (in.commit.empty() ? "" : " (" + in.commit.substr(0, 7) + ")");
            log(false, "INPUTS: staging " + in.archiveName + " from " + from);

            bool isZip = in.archiveName.size() >= 4 &&
                         in.archiveName.compare(in.archiveName.size() - 4, 4, ".zip") == 0;

            // Stream the artifact straight to disk instead of buffering the whole
            // (often 100s of MB) body in memory. The co-located agent downloads from
            // its OWN coordinator in-process, and double-buffering a large body there
            // could hand zip_extract a short/truncated file - the cryptic
            // "zip_extract rc -1". A zip goes to a temp file we extract; any other input
            // lands at its destination. Entries are relative to the producing job's
            // working dir, so extracting at this job's working dir lines the trees up
            // (both rules keeping the default workingDir "." is the usual contract).
            fs::path dest = isZip
                ? fs::temp_directory_path() / ("smith-input-" + spec.jobId + "-" + std::to_string(i) + ".zip")
                : fs::path(workingDir) / in.archiveName;

            Http::Client cli(m_cfg.coordinatorUrl);
            if (!m_cfg.token.empty()) cli.SetBearerToken(m_cfg.token);
            cli.SetTimeoutSeconds(600);   // large artifacts over a slow or loopback link
            long long expected = -1, written = 0;
            Http::Result res = cli.GetToFile("/api/jobs/" + in.jobId + "/artifacts/" + UrlEncode(in.archiveName),
                                             dest.string(), &expected, &written);
            if (!res.ok || res.status != 200)
            {
                log(true, "INPUTS: download failed for " + in.archiveName +
                          (res.error.empty() ? (" (HTTP " + std::to_string(res.status) + ")") : (": " + res.error)));
                fs::remove(dest, ec);
                return false;
            }
            // A short read silently writing a truncated file is exactly what produced the
            // unreadable zip; catch it here with a clear message instead of downstream.
            if (expected >= 0 && written != expected)
            {
                log(true, "INPUTS: download truncated for " + in.archiveName + " - got " +
                          std::to_string(written) + " of " + std::to_string(expected) + " bytes");
                fs::remove(dest, ec);
                return false;
            }

            if (isZip)
            {
                int rc = zip_extract(dest.string().c_str(), workingDir.c_str(), nullptr, nullptr);
                fs::remove(dest, ec);
                if (rc != 0)
                {
                    log(true, "INPUTS: could not extract " + in.archiveName + " (zip_extract rc " + std::to_string(rc) + ")");
                    return false;
                }
            }
            log(false, "INPUTS: staged " + in.archiveName + " (" + std::to_string(written) + " bytes)");
        }
        return true;
    }

    int Agent::RunBuild(const JobSpec& spec, const std::string& workingDir, const LogFn& log)
    {
        // A rule is either a single command or an ordered list of steps (e.g.
        // config.bat then build.bat). Run them in sequence; a non-zero exit from an
        // intermediate step aborts the rest. The last step's exit code is returned
        // and checked against successExitCodes by the caller.
        const std::vector<CommandSpec> cmds = spec.steps.empty()
            ? std::vector<CommandSpec>{ spec.command } : spec.steps;

        int rc = 0;
        for (size_t i = 0; i < cmds.size(); ++i)
        {
            CommandSpec cmd = cmds[i];
            if (!m_blender.empty() && cmd.interpreter == "exe" && cmd.script == "blender") cmd.script = m_blender;
            std::vector<std::string> argv = BuildArgv(cmd, workingDir);
            if (argv.empty())
            {
                log(true, "unsupported interpreter '" + cmds[i].interpreter + "'");
                return -1;
            }
            ProcessOptions o;
            o.argv = argv;
            o.workingDir = workingDir;
            o.envOverride = m_cfg.buildEnv;                                       // node env (e.g. UNA_ENGINE_PATH)
            if (!m_blender.empty()) o.envOverride["SMITH_BLENDER"] = m_blender;  // detected Blender (rule env may override)
            for (const auto& kv : spec.env) o.envOverride[kv.first] = kv.second;  // rule env overrides node env
            o.timeoutSeconds = spec.timeoutSeconds;
            if (cmds.size() > 1)
                log(false, "--- Step " + std::to_string(i + 1) + "/" + std::to_string(cmds.size()) + " ---");
            log(false, "Running: " + Join(argv));
            log(false, "Working dir: " + workingDir);

            Process p;
            { std::lock_guard<std::mutex> lk(m_procMutex); m_activeProc = &p; }
            rc = p.Run(o, [&](bool e, const std::string& l) { log(e, l); });
            { std::lock_guard<std::mutex> lk(m_procMutex); m_activeProc = nullptr; }
            if (p.TimedOut()) log(true, "Build timed out after " + std::to_string(spec.timeoutSeconds) + "s");
            if (m_cancelled) { log(true, "Build cancelled."); return rc; }
            log(false, "Build process exited with code " + std::to_string(rc));

            if (rc != 0 && i + 1 < cmds.size())
            {
                log(true, "Step " + std::to_string(i + 1) + " failed (exit " + std::to_string(rc) +
                          "); aborting remaining steps.");
                return rc;
            }
        }
        return rc;
    }

    void Agent::CollectArtifacts(const JobSpec& spec, const std::string& workingDir,
                                 std::vector<std::string>& uploadedOut, const LogFn& log)
    {
        if (spec.artifacts.globs.empty()) { log(false, "No artifacts declared."); return; }

        std::vector<std::regex> regexes;
        for (const auto& g : spec.artifacts.globs)
        {
            try { regexes.push_back(GlobToRegex(g)); } catch (...) {}
        }
        // Globs to subtract: the project's own excludes plus the built-in never-ship
        // dirs (e.g. Unity's *_DoNotShip / *_ButDontShipItWithYourGame), unless the
        // project opted out with excludeDefaults:false.
        std::vector<std::regex> excludeRegexes;
        for (const auto& g : EffectiveArtifactExcludes(spec.artifacts.exclude, spec.artifacts.excludeDefaults))
        {
            try { excludeRegexes.push_back(GlobToRegex(g)); } catch (...) {}
        }

        std::error_code ec;
        fs::path base(workingDir);
        if (!fs::is_directory(base, ec)) { log(true, "working dir missing for artifact collection"); return; }

        // Gather files matching the globs (disk path + path relative to the working
        // dir, which doubles as the zip entry name so structure is preserved). The
        // high cap is just a runaway guard - a packaged build (e.g. a .app bundle)
        // routinely has thousands of files, all of which belong in the one archive.
        const size_t kMaxFiles = 50000;
        std::vector<std::pair<fs::path, std::string>> matched;
        int excludedCount = 0;
        for (auto it = fs::recursive_directory_iterator(base, ec);
             it != fs::recursive_directory_iterator(); it.increment(ec))
        {
            if (ec) break;
            if (!it->is_regular_file(ec)) continue;
            fs::path rel = fs::relative(it->path(), base, ec);
            std::string relStr = rel.generic_string();
            bool included = false;
            for (auto& re : regexes)
                if (std::regex_match(relStr, re)) { included = true; break; }
            if (!included) continue;
            bool excluded = false;
            for (auto& re : excludeRegexes)
                if (std::regex_match(relStr, re)) { excluded = true; break; }
            if (excluded) { ++excludedCount; continue; }
            matched.emplace_back(it->path(), relStr);
            if (matched.size() >= kMaxFiles) { log(false, "Artifact file cap (50000) reached; stopping collection."); break; }
        }
        if (excludedCount > 0)
            log(false, "ARTIFACTS: excluded " + std::to_string(excludedCount) +
                       " file(s) matching never-ship/exclude patterns.");
        if (matched.empty())
        {
            std::string gl;
            for (size_t i = 0; i < spec.artifacts.globs.size(); ++i) { if (i) gl += ", "; gl += spec.artifacts.globs[i]; }
            log(true, "ARTIFACTS: nothing matched [" + gl + "] under the working dir - the build produced no "
                      "collectable output (check the product's outputPath / artifact globs).");
            return;
        }
        {
            std::uintmax_t total = 0;
            for (const auto& m : matched) { std::error_code sec; total += fs::file_size(m.first, sec); }
            log(false, "ARTIFACTS: collecting " + std::to_string(matched.size()) + " file(s), " +
                       std::to_string(total / (1024 * 1024)) + " MB" +
                       (spec.artifacts.package == "zip" ? " into one zip" : " individually"));
        }

        auto upload = [&](const std::string& name, const std::string& bytes) -> bool {
            for (int attempt = 1; attempt <= 3; ++attempt)   // retry transient upload failures
            {
                Http::Result res = DoPost(m_cfg, "/api/jobs/" + spec.jobId + "/artifacts/" + UrlEncode(name),
                                          bytes, "application/octet-stream");
                if (res.ok && res.status == 200) { uploadedOut.push_back(name); return true; }
                log(true, "ARTIFACTS: upload attempt " + std::to_string(attempt) + "/3 failed for " + name +
                          (res.error.empty() ? (" (HTTP " + std::to_string(res.status) + ")") : (": " + res.error)));
            }
            return false;
        };

        if (spec.artifacts.package == "zip")
        {
            // Bundle every matched file into one archive and upload that.
            std::string archive = spec.artifacts.archiveName.empty() ? "artifacts.zip"
                                                                      : spec.artifacts.archiveName;
            fs::path zipPath = fs::temp_directory_path() / ("smith-" + spec.jobId + ".zip");
            struct zip_t* z = zip_open(zipPath.string().c_str(), ZIP_DEFAULT_COMPRESSION_LEVEL, 'w');
            if (!z) { log(true, "could not create zip archive " + archive); return; }
            int added = 0, failedFiles = 0;
            for (const auto& m : matched)
            {
                if (zip_entry_open(z, m.second.c_str()) != 0) { ++failedFiles; continue; }
                if (zip_entry_fwrite(z, m.first.string().c_str()) == 0) ++added; else ++failedFiles;
                zip_entry_close(z);
            }
            zip_close(z);
            if (failedFiles > 0)
                log(true, "ARTIFACTS: " + std::to_string(failedFiles) + " of " + std::to_string((int)matched.size()) +
                          " file(s) could not be added to " + archive);

            std::string bytes;
            if (!ReadWholeFile(zipPath, bytes)) { log(true, "could not read zip archive"); fs::remove(zipPath, ec); return; }
            fs::remove(zipPath, ec);
            if (upload(archive, bytes))
                log(false, "Packaged " + std::to_string(added) + " file(s) into " + archive +
                           " (" + std::to_string(bytes.size()) + " bytes)");
        }
        else
        {
            // package "none": upload each matched file individually. Cap the number
            // of separate uploads (use package "zip" to ship many files as one).
            const int kMaxIndividual = 200;
            int count = 0;
            for (const auto& m : matched)
            {
                if (count >= kMaxIndividual)
                {
                    log(false, "Individual-artifact cap (200) reached; use package \"zip\" to ship more.");
                    break;
                }
                std::string bytes;
                if (!ReadWholeFile(m.first, bytes)) continue;
                std::string name = m.first.filename().string();
                if (upload(name, bytes))
                {
                    ++count;
                    log(false, "Collected artifact " + name + " (" + std::to_string(bytes.size()) + " bytes)");
                }
            }
        }
    }

    void Agent::ProcessJob(JobSpec spec)
    {
        m_busy = true;
        m_cancelled = false;
        m_currentJobId = spec.jobId;
        LOG_INFO("Smith", "Starting job %s (%s #%d): interp=%s script='%s' args=[%s] env=%d var(s), %d repo(s)",
                 spec.jobId.c_str(), spec.projectId.c_str(), spec.buildNumber,
                 spec.command.interpreter.c_str(), spec.command.script.c_str(),
                 Join(spec.command.args).c_str(), (int)spec.env.size(), (int)spec.repos.size());
        for (const auto& r : spec.repos)
            LOG_INFO("Smith", "  repo %s -> %s @ %s", r.url.c_str(),
                     (r.checkoutDir.empty() ? "." : r.checkoutDir.c_str()),
                     (r.commit.empty() ? r.branch.c_str() : r.commit.c_str()));
        int64_t t0 = NowMillis();

        // Mirror the whole build log to a local file (flushed per line) so it can
        // be inspected even when the coordinator connection is flaky.
        std::error_code lec;
        fs::path logDir = fs::path(m_cfg.workspace) / "_agent-logs";
        fs::create_directories(logDir, lec);
        fs::path localLogPath = logDir / (spec.projectId + "-" + std::to_string(spec.buildNumber) + "-" + spec.jobId + ".log");
        auto localLog = std::make_shared<std::ofstream>(localLogPath, std::ios::binary);
        LOG_INFO("Smith", "Build log -> %s", localLogPath.string().c_str());

        // Batched live log forwarder (a background thread posts every ~200ms).
        std::mutex mu;
        std::vector<std::string> buf;
        std::atomic<int64_t> seq{ 0 };
        std::atomic<bool> done{ false };
        // 'force' posts even with no new lines, so a quiet build (no output) still
        // polls the coordinator for a cancel request via the post response.
        auto flush = [&](bool force) {
            std::vector<std::string> out;
            { std::lock_guard<std::mutex> lk(mu); if (buf.empty() && !force) return; out.swap(buf); }
            LogChunk ch; ch.seq = seq++; ch.stream = "stdout"; ch.lines = out;
            Http::Result lr = DoPost(m_cfg, "/api/jobs/" + spec.jobId + "/log", ToJson(ch));
            // The coordinator signals a cancel request via the log-post response.
            if (lr.ok && lr.body.find("\"cancel\":true") != std::string::npos) RequestCancelCurrent();
        };
        std::thread flusher([&]() {
            int tick = 0;
            while (!done)
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(200));
                flush(++tick % 5 == 0);   // force a poll ~every 1s even with no output
            }
            flush(false);
        });
        LogFn log = [&, localLog](bool isErr, const std::string& line) {
            std::lock_guard<std::mutex> lk(mu);
            std::string entry = isErr ? ("[stderr] " + line) : line;
            buf.push_back(entry);
            if (localLog && localLog->is_open()) { (*localLog) << entry << '\n'; localLog->flush(); }
        };

        JobResult result;
        result.status = "error";
        result.exitCode = -1;

        try
        {
            std::string primaryDir;
            PostStatus(spec.jobId, "checkout");
            if (!EnsureWorkspaceHealthy(spec, logDir.string(), log))
            {
                result.status = "error";   // detail already streamed to the build log
            }
            else if (Checkout(spec, primaryDir, log) &&
                StageInputs(spec, ResolveDir(primaryDir, spec.workingDir), log))
            {
                std::string workdir = ResolveDir(primaryDir, spec.workingDir);
                // A build of the branch tip (manual, discord, rerun of one) carries no
                // commit. Record the sha we actually checked out so the build shows its
                // revision, and so the script (SMITH_COMMIT) and handoff (${COMMIT}) see it.
                if (!spec.repos.empty() && spec.repos[0].commit.empty())
                {
                    std::string sha = GitRepo::HeadSha(primaryDir);
                    if (!sha.empty())
                    {
                        spec.repos[0].commit = sha;
                        spec.env["SMITH_COMMIT"] = sha;
                        log(false, "Checked out " + spec.repos[0].branch + " @ " + sha.substr(0, 12));
                    }
                }
                PostStatus(spec.jobId, "building", spec.repos.empty() ? std::string() : spec.repos[0].commit);
                int rc = RunBuild(spec, workdir, log);
                result.exitCode = rc;
                if (IsSuccess(rc, spec.successExitCodes))
                {
                    PostStatus(spec.jobId, "collecting");
                    std::vector<std::string> uploaded;
                    CollectArtifacts(spec, workdir, uploaded, log);
                    // A build that DECLARES artifact globs but delivers nothing almost
                    // always means it never really ran (e.g. the editor failed to launch
                    // yet the script still exited 0). Don't let that masquerade as success,
                    // and don't run handoff (steam/itch/...) on an empty output set.
                    if (!spec.artifacts.globs.empty() && uploaded.empty())
                    {
                        result.status = "failed";
                        log(true, "Build produced no artifacts despite declaring " +
                                  std::to_string(spec.artifacts.globs.size()) +
                                  " glob(s); marking failed instead of shipping nothing.");
                    }
                    else
                    {
                        PostStatus(spec.jobId, "handoff");
                        if (RunHandoff(spec, workdir, log))
                        {
                            result.status = "success";
                        }
                        else
                        {
                            result.status = "failed";
                            log(true, "One or more handoff steps failed.");
                        }
                    }
                }
                else
                {
                    result.status = "failed";
                    log(true, "Build failed (exit " + std::to_string(rc) + ").");
                }
            }
            else
            {
                result.status = "error";
            }
        }
        catch (const std::exception& e)
        {
            result.status = "error";
            log(true, std::string("agent exception: ") + e.what());
        }

        if (m_cancelled) result.status = "cancelled";
        result.durationMs = NowMillis() - t0;
        result.message = result.status;

        done = true;
        if (flusher.joinable()) flusher.join();

        PostResult(spec.jobId, result);
        LOG_INFO("Smith", "Job %s done: %s (exit %d, %lldms)", spec.jobId.c_str(),
                 result.status.c_str(), result.exitCode, (long long)result.durationMs);
        m_busy = false;
        m_currentJobId.clear();
    }
}
