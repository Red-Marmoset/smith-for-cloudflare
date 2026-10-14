// AgentHandoff.cpp - post-build handoff steps: the built-in deploy commands
// (steam/itch/cloudflare/script/copyShare) with live progress-file tailing.
// Split from Agent.cpp (800-line standard); pure moves, no behavior change.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Agent.h"
#include "AgentUtil.h"

#include <SmithCore/Process.h>
#include <SmithCore/Handoff.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <thread>

namespace fs = std::filesystem;
using LogFn = std::function<void(bool, const std::string&)>;

namespace Smith
{
    static std::string MapGet(const std::map<std::string, std::string>& m, const std::string& k)
    {
        auto it = m.find(k);
        return it == m.end() ? std::string() : it->second;
    }

    bool Agent::RunHandoffCommand(const std::string& type, const HandoffCommand& cmd, const LogFn& log)
    {
        ProcessOptions o;
        o.argv = cmd.argv;
        o.workingDir = cmd.workingDir;
        o.envOverride = cmd.env;
        // Log only the program name, never the full argv/env: deploy steps carry
        // secrets (steam '+login <user> <pass>', API tokens injected as env).
        log(false, "Handoff " + type + ": running " +
                   (cmd.argv.empty() ? std::string("(empty)") : cmd.argv[0]) +
                   " (" + std::to_string(cmd.argv.size()) + " args)");

        // Tail *.log files in the command's tailDirs while it runs: deploy tools
        // (steamcmd) block-buffer their piped stdout, so their progress files are
        // the only live signal. Pre-existing files tail from their current end.
        std::atomic<bool> tailStop{ false };
        std::thread tailer;
        if (!cmd.tailDirs.empty())
        {
            std::vector<std::string> dirs = cmd.tailDirs;
            tailer = std::thread([dirs, &tailStop, &log]() {
                std::map<std::string, std::streamoff> offsets;
                std::error_code ec;
                for (const auto& d : dirs)
                    for (fs::directory_iterator it(d, ec), end; it != end; it.increment(ec))
                        if (it->path().extension() == ".log")
                            offsets[it->path().string()] = (std::streamoff)fs::file_size(it->path(), ec);
                auto sweep = [&](bool final) {
                    for (const auto& d : dirs)
                    {
                        std::error_code sec;
                        for (fs::directory_iterator it(d, sec), end; it != end; it.increment(sec))
                        {
                            if (it->path().extension() != ".log") continue;
                            std::string key = it->path().string();
                            if (!offsets.count(key)) offsets[key] = 0;   // new file: tail from the top
                            std::ifstream f(it->path(), std::ios::binary);
                            if (!f) continue;
                            f.seekg(offsets[key]);
                            std::string line;
                            while (std::getline(f, line))
                            {
                                // A line without its newline yet is a partial write -
                                // leave it for the next sweep (tellg is -1 at eof, so
                                // the offset must not be taken from this read either).
                                // The final sweep emits it anyway: there is no later one.
                                if (f.eof() && !final) break;
                                if (!f.eof()) offsets[key] = f.tellg();
                                while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.pop_back();
                                if (!line.empty())
                                    log(false, "[" + it->path().stem().string() + "] " + line);
                            }
                        }
                    }
                };
                while (!tailStop)
                {
                    for (int i = 0; i < 10 && !tailStop; ++i)
                        std::this_thread::sleep_for(std::chrono::milliseconds(50));
                    sweep(false);
                }
                sweep(true);   // final sweep so nothing written at the very end is lost
            });
        }

        Process p;
        int rc = p.Run(o, [&](bool e, const std::string& l) { log(e, l); });
        tailStop = true;
        if (tailer.joinable()) tailer.join();
        if (p.TimedOut()) log(true, "Handoff " + type + " timed out");
        log(false, "Handoff " + type + " exited with code " + std::to_string(rc));
        return rc == 0;
    }

    bool Agent::DoCopyShare(const std::map<std::string, std::string>& fields, const std::string& workingDir, const LogFn& log)
    {
        std::string dest = MapGet(fields, "dest");
        if (dest.empty()) { log(true, "copyShare handoff requires a 'dest' field"); return false; }
        std::string from = MapGet(fields, "from");
        fs::path src = from.empty() ? fs::path(workingDir) : fs::path(ResolveDir(workingDir, from));

        std::error_code ec;
        if (!fs::exists(src, ec)) { log(true, "copyShare source missing: " + src.string()); return false; }
        fs::create_directories(dest, ec);
        fs::copy(src, dest, fs::copy_options::recursive | fs::copy_options::overwrite_existing, ec);
        if (ec) { log(true, "copyShare failed: " + ec.message()); return false; }
        log(false, "Handoff copyShare: copied " + src.string() + " -> " + dest);
        return true;
    }

    bool Agent::RunHandoff(const JobSpec& spec, const std::string& workingDir, const LogFn& log)
    {
        // Variables available for ${...} substitution in handoff fields.
        std::map<std::string, std::string> vars = {
            { "PROJECT_ID", spec.projectId },
            { "BUILD_NUMBER", std::to_string(spec.buildNumber) },
            { "WORKSPACE", workingDir },
            { "ARTIFACTS_DIR", workingDir },
        };
        if (!spec.repos.empty())
        {
            vars["BRANCH"] = spec.repos[0].branch;
            vars["COMMIT"] = spec.repos[0].commit;
            vars["COMMIT_SHORT"] = spec.repos[0].commit.substr(0, std::min<size_t>(7, spec.repos[0].commit.size()));
        }
        auto te = spec.env.find("TARGET_ENV");
        if (te != spec.env.end()) vars["TARGET_ENV"] = te->second;

        // Credentials are resolved locally on the agent and never logged.
        std::error_code ec;
        std::string credFile = fs::absolute("smith-agent-credentials.json", ec).string();

        for (const auto& step : spec.handoff)
        {
            std::map<std::string, std::string> fields;
            for (const auto& kv : step.fields) fields[kv.first] = SubstituteVars(kv.second, vars);

            bool ok = true;
            if (step.type == "collect")
            {
                log(false, "Handoff: collect (artifacts already uploaded).");
            }
            else if (step.type == "copyShare")
            {
                ok = DoCopyShare(fields, workingDir, log);
            }
            else if (step.type == "script" || step.type == "steam" || step.type == "itch" || step.type == "cloudflare")
            {
                HandoffCommand cmd;
                if (step.type == "script")
                {
                    cmd = BuildScriptCommand(fields, workingDir);
                }
                else
                {
                    std::map<std::string, std::string> creds = ResolveCredentials(credFile, MapGet(fields, "credentialRef"));
                    // Default the Steamworks upload description to the Smith build
                    // number + source branch, so every upload is traceable back to
                    // the build that produced it. A 'desc' field in smith.json
                    // (with ${VAR} substitution) overrides this.
                    if (step.type == "steam" && MapGet(fields, "desc").empty())
                    {
                        std::string d = "Smith build #" + std::to_string(spec.buildNumber);
                        std::string branch = MapGet(vars, "BRANCH"), sha = MapGet(vars, "COMMIT_SHORT");
                        if (!branch.empty()) d += " (" + branch + (sha.empty() ? "" : " @ " + sha) + ")";
                        fields["desc"] = d;
                    }
                    if (step.type == "steam") cmd = BuildSteamCommand(fields, creds, workingDir);
                    else if (step.type == "itch") cmd = BuildItchCommand(fields, creds, workingDir);
                    else cmd = BuildCloudflareCommand(fields, creds, workingDir);
                }
                if (!cmd.error.empty()) { log(true, "Handoff " + step.type + ": " + cmd.error); ok = false; }
                else ok = RunHandoffCommand(step.type, cmd, log);
            }
            else
            {
                log(false, "Handoff: unknown step type '" + step.type + "' (skipped).");
            }

            if (!ok)
            {
                if (step.continueOnError)
                {
                    log(true, "Handoff step '" + step.type + "' failed; continuing (continueOnError).");
                }
                else
                {
                    log(true, "Handoff step '" + step.type + "' failed; aborting remaining handoff.");
                    return false;
                }
            }
        }
        return true;
    }

}
