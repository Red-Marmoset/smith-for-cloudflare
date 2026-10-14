// App.cpp - subcommand dispatch for the Smith binary.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "App.h"

#include <SmithCore/Config.h>
#include <SmithCore/Discovery.h>
#include <SmithCoordinator/Coordinator.h>
#include <SmithAgent/Agent.h>
#include <SmithAgent/HostedAgent.h>
#include <SmithAgent/HostedApproval.h>
#include <Http/Http.h>
#include <Log/Log.h>

#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>
#include <chrono>

namespace Smith
{
    static const char* kVersion = "0.1.0";

    // Tiny extractor for a string field's value ("key":"value") in a flat JSON
    // blob - enough for the CLI to read jobId/status/phase without a JSON dep.
    static std::string JsonStr(const std::string& body, const std::string& key)
    {
        std::string pat = "\"" + key + "\":\"";
        size_t p = body.find(pat);
        if (p == std::string::npos) return "";
        p += pat.size();
        size_t e = body.find('"', p);
        return e == std::string::npos ? "" : body.substr(p, e - p);
    }

    const char* VersionString() { return kVersion; }

    static int PrintUsage()
    {
        std::printf(
            "Smith %s - System for Managed Integration, Testing & Handoff\n"
            "HTTP backend: cpp-httplib %s\n"
            "\n"
            "Usage:\n"
            "  smith coordinator [--config FILE] [--host H] [--port N] [--data-dir DIR] [--web-dir DIR] [--token T]\n"
            "                    [--project PATH ...] [--project-repo URL ...] [--no-discovery] [--discovery-port N]\n"
            "                    [--google-client-id ID] [--google-allowed-domains a,b] [--require-login]\n"
            "                    [--with-agent [--agent-labels a,b,c]] [--repo-override id/repo=url ...]\n"
            "  smith agent       [--coordinator URL | --no-discover] [--discovery-port N] [--name N] [--labels a,b,c]\n"
            "                    [--workspace DIR] [--os windows|mac|linux] [--token T]\n"
            "  smith hosted-agent --workspace DIR [--workspace-id ID] [--coordinator HTTPS_ORIGIN]\n"
            "                     [--enrollment-file FILE] [--labels a,b] [--drain-file ABSOLUTE_PATH] [--once]\n"
            "                     [--enroll-only]   # connect and save the credential, then exit\n"
            "  smith discover    [--discovery-port N]   # scan the LAN for a coordinator\n"
            "  smith trigger     <project> <product> [--profile P] [--branch B] [--wait] [--coordinator URL] [--token T]\n"
            "  smith logs        <jobId> [--coordinator URL] [--token T]\n"
            "  smith status      <project> [--coordinator URL] [--token T]\n"
            "  smith cancel      <jobId> [--coordinator URL] [--token T]\n"
            "  smith version\n"
            "  smith help [command]\n\n"
            "Each command accepts --help or -h without starting or connecting.\n"
            "Dashboard Help covers setup, smith.json, troubleshooting and planned tasks.\n",
            kVersion, Http::Version());
        return 0;
    }

    static int PrintCommandHelp(const char* command)
    {
        if (std::strcmp(command, "coordinator") == 0)
            std::puts(
                "Native / LAN coordinator: queues builds and serves the dashboard.\nUsage: smith coordinator [options]\n\n"
                "  --config FILE             Runtime config; default ./smith-coordinator.json if present.\n"
                "  --host ADDRESS            Bind address (default 0.0.0.0).\n"
                "  --port N                  HTTP port (default 9876).\n"
                "  --data-dir DIR            Persistent state (default OS Smith data directory).\n"
                "  --web-dir DIR             Override embedded dashboard assets.\n"
                "  --project PATH            smith.json or repository directory; repeatable.\n"
                "  --project-repo URL[#BRANCH] Clone a managed project; repeatable.\n"
                "  --repo-override ID/NAME=URL Override a repository for testing; repeatable.\n"
                "  --with-agent              Run an embedded build agent.\n"
                "  --agent-labels a,b        Embedded agent capabilities.\n"
                "  --env KEY=VALUE           Build environment on every agent; repeatable.\n"
                "  --agent-env KEY=VALUE     Build environment alias; --env wins.\n"
                "  --token SECRET            Shared API/agent token for non-loopback requests when set.\n"
                "  --require-token           Require token even on loopback.\n"
                "  --no-discovery            Disable LAN UDP discovery replies.\n"
                "  --discovery-port N        UDP port (default 9877).\n"
                "  --poll-interval-sec N     Default Git poll interval (default 60).\n"
                "  --job-wait-ms N           Long-poll hold (default 20000).\n"
                "  --cancel-running-on-new-commit Abort running automatic builds on newer pushes (off by default).\n"
                "  --notify-command COMMAND Completion hook with SMITH_* environment.\n"
                "  --notify-on failed|all    Notification filter (default failed).\n"
                "  --google-client-id ID     Enable optional Google sign-in.\n"
                "  --google-allowed-domains a,b  Allowed Workspace domains.\n"
                "  --google-allowed-emails a,b   Additional allowed email addresses.\n"
                "  --admin-emails a,b        Admin role on first sign-in.\n"
                "  --require-login           Require browser login for human routes.\n"
                "  --token-verify-command CMD Override Google verification ({token} placeholder).\n\n"
                "CLI scalars override runtime config; project lists append. smith.json is the\n"
                "separate repository pipeline. DNS, Discord, GitHub credentials and batch defaults\n"
                "are configured in the runtime file. Repair invalid JSON and restart if warned.\n"
                "Example: smith coordinator --project C:/code/my-project --with-agent --agent-labels unity6\n"
                "Open http://localhost:9876 and choose Help. WAN use needs a TLS proxy/tunnel.\n"
                "This command does not start the Cloudflare-hosted coordinator.");
        else if (std::strcmp(command, "agent") == 0)
            std::puts(
                "Native / LAN agent: checks out and builds on this computer.\nUsage: smith agent [options]\n\n"
                "  --coordinator URL         Native coordinator URL; disables discovery.\n"
                "  --no-discover             Skip discovery; default URL http://127.0.0.1:9876.\n"
                "  --discovery-port N        UDP port (default 9877).\n"
                "  --token SECRET            Coordinator's shared token.\n"
                "  --name NAME               Display name (default hostname).\n"
                "  --labels a,b              Capabilities; all required labels must match.\n"
                "  --workspace DIR           Checkout/log/cache directory (default smith-agent-workspace).\n"
                "  --os windows|mac|linux    Override detected OS; does not install a toolchain.\n"
                "  --arch ARCH               Override detected architecture.\n"
                "  --env KEY=VALUE           Build environment; repeatable.\n"
                "  --poll-ms N               Poll delay (default 1500).\n"
                "  --min-free-mb N           Free-space floor (default 5120; 0 disables).\n"
                "  --log-keep-days N         Log age cap (default 14; 0 disables).\n"
                "  --log-keep-max N          Log count cap (default 200; 0 disables).\n\n"
                "Discovery scans the LAN then falls back to localhost. Run as your build user\n"
                "so Git credentials and tools are available. Labels do not install capabilities.\n"
                "UNA_ENGINE_PATH is captured automatically and advertises una-engine.\n"
                "Keep running or use your OS startup wrapper.\n"
                "Example: smith agent --coordinator http://BUILD-HOST:9876 --labels unity6\n"
                "For Cloudflare use hosted-agent or Start-Smith instead. See docs/user-guide.md.");
        else if (std::strcmp(command, "hosted-agent") == 0)
            std::puts(
                "Cloudflare hosted agent: isolated Windows builds and personal coding chats.\n"
                "Usage: smith hosted-agent --workspace-id ID --workspace DIR [options]\n\n"
                "  --workspace-id ID         Dashboard workspace ID (64 lowercase hex characters).\n"
                "  --workspace DIR           Dedicated private state/job folder; required.\n"
                "  --coordinator ORIGIN      HTTPS origin only, no path or credentials.\n"
                "                            Default https://exp.redmarmosetstudios.com\n"
                "  --enrollment-file FILE    Private file containing a one-use code; otherwise hidden prompt.\n"
                "  --labels a,b              Extra labels in addition to detected capabilities.\n"
                "  --drain-file ABSOLUTE_PATH Exit between builds after reconciling completion.\n"
                "  --once                    Claim at most one build then exit; no queued build exits 0.\n\n"
                "Enrollment codes come from Connect build machine or Connect my computer and\n"
                "expire after ten minutes. Later starts reuse saved enrollment. Never put codes\n"
                "in command arguments or share state. Only one agent may use a folder. Revoked\n"
                "credentials need fresh enrollment in a new dedicated directory. Run as the\n"
                "user with Git/toolchain access. Hosted Linux/macOS execution is not supported yet.\n"
                "Artifacts: four exact files at most, 20 MiB each, package=none; no inputs/handoffs.\n"
                "Packaged example: Start-Smith.bat agent --workspace-id <dashboard-id>\n"
                "Keep its terminal open. SmithAgent.bat stop finishes build work gracefully;\n"
                "Disconnect revokes access and interrupts work. Stop personal chats separately.\n"
                "For chats install/sign in to Claude Code or Codex locally. Read Dashboard Help\n"
                "or the package README for setup and recovery.");
        else if (std::strcmp(command, "discover") == 0)
            std::puts("Usage: smith discover [--discovery-port N]\nScan for a native LAN coordinator (UDP 9877); does not enroll an agent.");
        else if (std::strcmp(command, "trigger") == 0)
            std::puts("Usage: smith trigger <project> <product> [--profile P] [--branch B] [--wait] [--coordinator URL] [--token T]\nQueue a native build; --wait waits for its result. Hosted Smith uses a different API;\nuse its dashboard or Smith MCP integration instead.");
        else if (std::strcmp(command, "logs") == 0)
            std::puts("Usage: smith logs <jobId> [--coordinator URL] [--token T]\nPrint the stored native log (snapshot, not a live stream).");
        else if (std::strcmp(command, "status") == 0)
            std::puts("Usage: smith status <project> [--coordinator URL] [--token T]\nShow the latest native project build status.");
        else if (std::strcmp(command, "cancel") == 0)
            std::puts("Usage: smith cancel <jobId> [--coordinator URL] [--token T]\nCancel native queued/active work; cannot undo script side effects.");
        else if (std::strcmp(command, "version") == 0 || std::strcmp(command, "help") == 0)
            return PrintUsage();
        else { std::printf("Unknown help topic '%s'.\n", command); return 2; }
        return 0;
    }

    static int RunCoordinator(int argc, char** argv)
    {
        CoordinatorConfig cfg = ParseCoordinatorArgs(argc, argv, 2);
        std::printf("Smith coordinator starting on http://%s:%d\n", cfg.host.c_str(), cfg.port);
        Coordinator coord(cfg);
        coord.LoadProjects();
        if (!coord.Start())
        {
            std::printf("ERROR: coordinator failed to bind %s:%d (already in use?)\n", cfg.host.c_str(), cfg.port);
            return 1;
        }
        return 0;
    }

    static int RunAgent(int argc, char** argv)
    {
        AgentConfig cfg = ParseAgentArgs(argc, argv, 2);
        std::printf("Smith agent '%s' (%s) connecting to %s\n",
                    cfg.name.c_str(), cfg.os.c_str(), cfg.coordinatorUrl.c_str());
        Agent agent(cfg);
        if (!agent.Run())
        {
            std::printf("ERROR: agent could not register with %s\n", cfg.coordinatorUrl.c_str());
            return 1;
        }
        return 0;
    }

    // One-shot LAN scan: broadcast a discovery probe and print any coordinator
    // that answers. Handy for verifying discovery and for checking whether a
    // coordinator is reachable on the network before starting an agent.
    static int RunDiscover(int argc, char** argv)
    {
        int port = kDefaultDiscoveryPort;
        for (int i = 2; i + 1 < argc; ++i)
            if (std::strcmp(argv[i], "--discovery-port") == 0) port = std::atoi(argv[i + 1]);

        std::printf("Scanning for a Smith coordinator on udp/%d ...\n", port);
        DiscoveryResult r = DiscoverCoordinator(port, 1000, 8);   // ~8s worst case
        if (r.found)
        {
            std::printf("Found coordinator '%s' at %s\n", r.name.c_str(), r.url.c_str());
            std::printf("  start an agent with:  smith agent --coordinator %s\n", r.url.c_str());
            return 0;
        }
        std::printf("No coordinator answered on udp/%d.\n", port);
        std::printf("  (check the coordinator is up, on the same LAN/broadcast domain, and using\n");
        std::printf("   the same discovery port; or connect explicitly: smith agent --coordinator http://HOST:9876)\n");
        return 1;
    }

    static const char* ArgVal(int argc, char** argv, const char* flag, const char* def)
    {
        for (int i = 2; i + 1 < argc; ++i)
            if (std::strcmp(argv[i], flag) == 0) return argv[i + 1];
        return def;
    }

    static bool HasArg(int argc, char** argv, const char* flag)
    {
        for (int i = 2; i < argc; ++i) if (std::strcmp(argv[i], flag) == 0) return true;
        return false;
    }

    // Resolve the coordinator URL from --coordinator, or auto-discover it on the
    // LAN. Returns "" if neither is available.
    static std::string ResolveCoordinatorUrl(int argc, char** argv)
    {
        std::string url = ArgVal(argc, argv, "--coordinator", "");
        if (!url.empty()) return url;
        DiscoveryResult d = DiscoverCoordinator(kDefaultDiscoveryPort, 1000, 5);
        return d.found ? d.url : std::string();
    }

    // Poll a build to completion, printing phase changes. Returns 0 if it
    // succeeded, 1 otherwise - so scripts/CI get a meaningful exit code.
    static int WaitForBuild(const std::string& url, const char* token, const std::string& jobId)
    {
        std::string lastPhase;
        for (;;)
        {
            Http::Client c(url);
            if (token && *token) c.SetBearerToken(token);
            c.SetTimeoutSeconds(15);
            Http::Result r = c.Get("/api/builds/" + jobId);
            if (r.ok && r.status == 200)
            {
                std::string status = JsonStr(r.body, "status");
                std::string phase = JsonStr(r.body, "phase");
                if (phase != lastPhase) { std::printf("  [%s] %s\n", status.c_str(), phase.c_str()); lastPhase = phase; }
                if (status == "success") { std::printf("Build succeeded.\n"); return 0; }
                if (status == "failed" || status == "error" || status == "lost")
                { std::printf("Build %s.\n", status.c_str()); return 1; }
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(1000));
        }
    }

    // Kick off a build from the command line (for scripts / cron / manual use).
    // smith trigger <project> <product> [--profile P] [--branch B] [--coordinator URL] [--token T]
    static int RunTrigger(int argc, char** argv)
    {
        const char* project = (argc > 2 && argv[2][0] != '-') ? argv[2] : "";
        const char* product = (argc > 3 && argv[3][0] != '-') ? argv[3] : "";
        if (!*project || !*product)
        {
            std::printf("usage: smith trigger <project> <product> "
                        "[--profile P] [--branch B] [--coordinator URL] [--token T]\n");
            return 2;
        }
        const char* profile = ArgVal(argc, argv, "--profile", "");
        const char* branch  = ArgVal(argc, argv, "--branch", "");
        const char* token   = ArgVal(argc, argv, "--token", "");
        std::string url = ResolveCoordinatorUrl(argc, argv);
        if (url.empty()) { std::printf("ERROR: no --coordinator given and none discovered on the LAN\n"); return 1; }

        std::string body = std::string("{\"projectId\":\"") + project + "\",\"product\":\"" + product +
                           "\",\"branch\":\"" + branch + "\",\"profile\":\"" + profile + "\"}";
        Http::Client c(url);
        if (*token) c.SetBearerToken(token);
        c.SetTimeoutSeconds(15);
        Http::Result r = c.Post("/api/trigger", body, "application/json");
        if (!r.ok) { std::printf("ERROR: trigger failed: %s\n", r.error.c_str()); return 1; }
        if (r.status != 200) { std::printf("ERROR: coordinator returned %d: %s\n", r.status, r.body.c_str()); return 1; }

        std::string label = std::string(project) + "/" + product;
        if (*profile) label += std::string(" [") + profile + "]";
        std::printf("Triggered %s on %s -> %s\n", label.c_str(), url.c_str(), r.body.c_str());

        // --wait: block until the build finishes; the exit code reflects pass/fail.
        if (HasArg(argc, argv, "--wait"))
        {
            std::string jobId = JsonStr(r.body, "jobId");
            if (!jobId.empty()) return WaitForBuild(url, token, jobId);
        }
        return 0;
    }

    // smith logs <jobId> [--coordinator URL] [--token T]   # print a build's log
    static int RunLogs(int argc, char** argv)
    {
        const char* jobId = (argc > 2 && argv[2][0] != '-') ? argv[2] : "";
        if (!*jobId) { std::printf("usage: smith logs <jobId> [--coordinator URL] [--token T]\n"); return 2; }
        const char* token = ArgVal(argc, argv, "--token", "");
        std::string url = ResolveCoordinatorUrl(argc, argv);
        if (url.empty()) { std::printf("ERROR: no coordinator found\n"); return 1; }
        Http::Client c(url);
        if (*token) c.SetBearerToken(token);
        c.SetTimeoutSeconds(30);
        Http::Result r = c.Get(std::string("/api/builds/") + jobId + "/log");
        if (!r.ok) { std::printf("ERROR: %s\n", r.error.c_str()); return 1; }
        if (r.status != 200) { std::printf("ERROR: coordinator returned %d\n", r.status); return 1; }
        std::fwrite(r.body.data(), 1, r.body.size(), stdout);
        if (!r.body.empty() && r.body.back() != '\n') std::printf("\n");
        return 0;
    }

    // smith status <project> [--coordinator URL] [--token T]  # latest build status
    static int RunStatus(int argc, char** argv)
    {
        const char* project = (argc > 2 && argv[2][0] != '-') ? argv[2] : "";
        if (!*project) { std::printf("usage: smith status <project> [--coordinator URL] [--token T]\n"); return 2; }
        const char* token = ArgVal(argc, argv, "--token", "");
        std::string url = ResolveCoordinatorUrl(argc, argv);
        if (url.empty()) { std::printf("ERROR: no coordinator found\n"); return 1; }
        Http::Client c(url);
        if (*token) c.SetBearerToken(token);
        c.SetTimeoutSeconds(15);
        Http::Result r = c.Get(std::string("/api/projects/") + project + "/builds");
        if (!r.ok || r.status != 200) { std::printf("ERROR: could not read builds (%s)\n", r.error.c_str()); return 1; }
        // Builds are newest-first; the first record is the latest.
        std::string status = JsonStr(r.body, "status");
        std::string product = JsonStr(r.body, "product");
        if (status.empty()) { std::printf("%s: no builds yet\n", project); return 0; }
        std::printf("%s/%s: %s\n", project, product.c_str(), status.c_str());
        return (status == "failed" || status == "error" || status == "lost") ? 1 : 0;
    }

    // smith cancel <jobId> [--coordinator URL] [--token T]
    static int RunCancel(int argc, char** argv)
    {
        const char* jobId = (argc > 2 && argv[2][0] != '-') ? argv[2] : "";
        if (!*jobId) { std::printf("usage: smith cancel <jobId> [--coordinator URL] [--token T]\n"); return 2; }
        const char* token = ArgVal(argc, argv, "--token", "");
        std::string url = ResolveCoordinatorUrl(argc, argv);
        if (url.empty()) { std::printf("ERROR: no coordinator found\n"); return 1; }
        Http::Client c(url);
        if (*token) c.SetBearerToken(token);
        c.SetTimeoutSeconds(15);
        Http::Result r = c.Post(std::string("/api/builds/") + jobId + "/cancel", "", "application/json");
        if (!r.ok) { std::printf("ERROR: %s\n", r.error.c_str()); return 1; }
        if (r.status != 200) { std::printf("ERROR: coordinator returned %d: %s\n", r.status, r.body.c_str()); return 1; }
        std::printf("%s\n", r.body.c_str());
        return 0;
    }

    int AppMain(int argc, char** argv)
    {
        if (argc < 2) return PrintUsage();
        const char* cmd = argv[1];

        if (std::strcmp(cmd, "version") == 0 || std::strcmp(cmd, "--version") == 0)
        {
            std::printf("Smith %s (cpp-httplib %s)\n", kVersion, Http::Version());
            return 0;
        }
        if (std::strcmp(cmd, "help") == 0 || std::strcmp(cmd, "--help") == 0 || std::strcmp(cmd, "-h") == 0)
            return argc > 2 ? PrintCommandHelp(argv[2]) : PrintUsage();
        // Help exits before configuration loading, network activity or enrollment.
        if (HasArg(argc, argv, "--help") || HasArg(argc, argv, "-h"))
            return PrintCommandHelp(cmd);
        if (std::strcmp(cmd, "coordinator") == 0) return RunCoordinator(argc, argv);
        if (std::strcmp(cmd, "agent") == 0) return RunAgent(argc, argv);
        if (std::strcmp(cmd, "hosted-agent") == 0) return RunHostedAgent(argc, argv);
        // Started by Claude Code itself (in a dashboard chat's ask mode) as a stdio MCP server, so
        // nothing else may be printed to stdout. Unanswered questions are declined after 15 minutes.
        if (std::strcmp(cmd, "ai-approve") == 0 && argc == 3) return RunHostedApprovalServer(std::cin, std::cout, argv[2], 15 * 60);
        if (std::strcmp(cmd, "discover") == 0) return RunDiscover(argc, argv);
        if (std::strcmp(cmd, "trigger") == 0) return RunTrigger(argc, argv);
        if (std::strcmp(cmd, "logs") == 0) return RunLogs(argc, argv);
        if (std::strcmp(cmd, "status") == 0) return RunStatus(argc, argv);
        if (std::strcmp(cmd, "cancel") == 0) return RunCancel(argc, argv);

        std::printf("Unknown command '%s'.\n\n", cmd);
        PrintUsage();
        return 2;
    }
}
