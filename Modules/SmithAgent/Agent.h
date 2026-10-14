// Agent.h - the Smith build agent. Registers with a coordinator, long-polls for
// jobs, checks out the repo, runs the build-rule script with live log streaming,
// collects artifacts, runs handoff steps and reports the result.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <SmithCore/Config.h>
#include <SmithProtocol/WireTypes.h>

#include <string>
#include <vector>
#include <map>
#include <atomic>
#include <thread>
#include <mutex>
#include <memory>
#include <functional>

namespace Smith
{
    class Process;   // forward decl: the agent kills the active build process on cancel

    class Agent
    {
    public:
        explicit Agent(AgentConfig cfg);
        ~Agent();

        // Register, then loop polling for and executing jobs. Blocks until Stop().
        // Returns false if registration fails.
        bool Run();
        void Stop();

    private:
        bool Register();
        // (Re)discover the coordinator on the LAN and update m_cfg.coordinatorUrl.
        // Returns true if one answered. 'why' is a short tag for the log line.
        bool RediscoverCoordinator(const char* why);
        void HeartbeatLoop();
        void ServiceLoop();
        void ProcessJob(JobSpec spec);   // by value: the resolved commit is filled in after checkout

        // Long-lived auxiliary service (the Discord bot). Polled from its own loop so
        // dependency provisioning cannot delay liveness heartbeats:
        // reconcile to the coordinator's ServiceSpec - launch/relaunch on "run" (or when
        // the spec hash changes), terminate on "stop". Materializes the bundled bot script
        // + a Python venv under <workspace>/.smith-discord on first launch.
        void PollService();
        void ReconcileService(const ServiceSpec& spec);
        bool StartBotService(const ServiceSpec& spec);
        void StopBotService();
        // Return a python that can import discord.py + requests (a venv under dir, else the
        // system interpreter), or "" if none can be provisioned.
        std::string ProvisionBotPython(const std::string& dir);

        // Run a one-shot Steam Guard task delivered in a heartbeat response (enter the
        // 2FA code via `steamcmd +set_steam_guard_code`), off-thread, and report the
        // outcome back to the coordinator. Credentials resolve locally by ref.
        void RunSteamGuardTask(const SteamGuardTask& task);

        // Job phases.
        // Prune old build logs and guard against a full disk before checkout: if
        // free space is below the configured floor, reclaim it (gc + evict the
        // least-recently-used project workspaces, never the current one); returns
        // false if it is still below the floor, so the job fails fast instead of
        // filling the disk mid-build.
        bool EnsureWorkspaceHealthy(const JobSpec& spec, const std::string& logDir, const std::function<void(bool,const std::string&)>& log);
        bool Checkout(const JobSpec& spec, std::string& primaryDirOut, const std::function<void(bool,const std::string&)>& log);
        // Stage the job's declared artifact inputs (fan-in): download each from the
        // coordinator and unpack into the working dir (zips extract in place, other
        // files land under their name). False on any download/extract failure.
        bool StageInputs(const JobSpec& spec, const std::string& workingDir, const std::function<void(bool,const std::string&)>& log);
        int RunBuild(const JobSpec& spec, const std::string& workingDir, const std::function<void(bool,const std::string&)>& log);
        void CollectArtifacts(const JobSpec& spec, const std::string& workingDir,
                              std::vector<std::string>& uploadedOut, const std::function<void(bool,const std::string&)>& log);
        bool RunHandoff(const JobSpec& spec, const std::string& workingDir, const std::function<void(bool,const std::string&)>& log);
        bool DoCopyShare(const std::map<std::string,std::string>& fields, const std::string& workingDir, const std::function<void(bool,const std::string&)>& log);
        bool RunHandoffCommand(const std::string& type, const struct HandoffCommand& cmd, const std::function<void(bool,const std::string&)>& log);

        // Coordinator calls.
        void PostStatus(const std::string& jobId, const std::string& phase, const std::string& commit = "");
        void PostResult(const std::string& jobId, const JobResult& result);

        // Kill the in-flight build process (called when the coordinator signals a
        // cancel via a log-post response). Thread-safe against RunBuild.
        void RequestCancelCurrent();

        AgentConfig m_cfg;
        std::string m_nodeId;
        std::atomic<bool> m_stop{ false };
        std::atomic<bool> m_busy{ false };
        std::string m_currentJobId;
        std::thread m_heartbeatThread;
        std::thread m_serviceThread;

        bool m_hasGpu = false;       // an NVIDIA GPU was detected at startup
        std::string m_blender;       // FindBlender() at registration (SMITH_BLENDER; runs an exe step named "blender")
        int m_gpuTotalMb = 0;        // cached total VRAM (heartbeats only refresh free)
        bool m_ollamaUp = false;     // a local Ollama answered the last probe
        int m_beatCount = 0;         // heartbeat counter (Ollama re-probe cadence)

        std::mutex m_procMutex;                  // guards m_activeProc
        Process* m_activeProc = nullptr;         // the running build's process, or null
        std::atomic<bool> m_cancelled{ false };  // set when the current job was cancelled
        std::atomic<bool> m_guardBusy{ false };  // one Steam Guard task at a time

        std::unique_ptr<Process> m_serviceProc;  // the running Discord bot, or null
        std::string m_serviceHash;               // spec hash of the running bot ("" = none)
        std::string m_serviceAttemptHash;        // last spec we tried to launch (crash-loop backoff)
        int64_t m_serviceLastAttemptMs = 0;      // when we last tried (throttle relaunches)

        // Service health, reported in heartbeats so the coordinator can show liveness,
        // not just placement. m_serviceLastLine is written from the bot's output-reader
        // thread; the mutex guards all three.
        std::mutex m_serviceMutex;
        std::string m_serviceStatus;             // "" (not hosting) | "running" | "failed" | "exited"
        std::string m_serviceDetail;             // the "why" when failed/exited (last output line)
        std::string m_serviceLastLine;           // most recent bot output line
    };
}
