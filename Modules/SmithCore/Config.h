// Config.h - coordinator/agent runtime configuration (from argv flags).
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>
#include <vector>
#include <map>

namespace Smith
{
    struct CoordinatorConfig
    {
        std::string host = "0.0.0.0";
        int port = 9876;
        std::string dataDir = "smith-data";
        std::string webDir;                            // empty -> auto-detect "web" next to the exe
        std::string token;                             // empty -> auth disabled (LAN)
        std::vector<std::string> projectConfigPaths;   // smith.json files or dirs containing one
        int jobWaitMs = 20000;                         // long-poll hold for /api/jobs/next
        bool requireTokenAlways = false;               // if true, even loopback must send the token
        std::map<std::string, std::string> repoOverrides; // "projectId/repoName" -> url (local testing)
        std::vector<std::string> projectRepos;         // "url" or "url#branch": coordinator clones + watches
        bool withAgent = false;                        // run a co-located agent in-process
        std::vector<std::string> agentLabels;          // labels for the embedded agent
        int pollIntervalSec = 60;                      // default git-poll cadence
        int nodeOfflineAfterSec = 30;                  // a node is offline after this long without a heartbeat
        int preferOsGraceSec = 25;                     // soft affinity: hold a preferOs job this long for its native agent
        bool discoveryEnabled = true;                  // answer LAN discovery probes (UDP)
        int discoveryPort = 9877;                      // UDP port for discovery (HTTP port + 1)
        std::map<std::string, std::string> agentBuildEnv; // env injected into every build, on every agent (e.g. UNA_ENGINE_PATH)
        std::string notifyCommand;                     // run on build finish (build info in SMITH_* env); does Slack/Discord/email/etc.
        std::string notifyOn = "failed";               // "failed" (default) | "all"
        std::string githubToken;                       // optional GitHub PAT so agents clone private GitHub repos over HTTPS without per-host SSH keys - secret, never logged

        // Google Workspace sign-in (optional). The whole feature is OFF while
        // googleClientId is empty (default) - behaviour is then exactly as before.
        // Token authenticity is verified out-of-process (curl -> Google tokeninfo);
        // see SmithCoordinator/CoordinatorAuth.cpp.
        std::string googleClientId;                    // --google-client-id; empty => auth feature off
        std::vector<std::string> googleAllowedDomains; // --google-allowed-domains a.com,b.com
        std::vector<std::string> googleAllowedEmails;  // --google-allowed-emails a@x.com,... (allowed regardless of domain)
        std::vector<std::string> adminEmails;          // --admin-emails ...: role=admin on first login
        bool requireLogin = false;                     // --require-login: human routes require a valid session
        std::string tokenVerifyCommand;                // --token-verify-command: override the curl tokeninfo call ({token} placeholder)

        // Dynamic DNS (optional). When dnsRecord + dnsApiToken are set, the coordinator
        // keeps a Cloudflare A record pointed at its current public IP (curl -> Cloudflare
        // API). OFF otherwise. See SmithCoordinator/CoordinatorDns.cpp + docs.
        std::string dnsProvider = "cloudflare";        // only "cloudflare" supported today
        std::string dnsApiToken;                       // Cloudflare API token (DNS:Edit on the zone) - secret, never logged
        std::string dnsZone;                           // zone name, e.g. redmarmosetstudios.com
        std::string dnsRecord;                         // A record to keep current, e.g. smith.redmarmosetstudios.com
        bool dnsProxied = true;                        // keep the record Cloudflare-proxied (orange cloud)
        int dnsIntervalSec = 300;                      // how often to re-check the public IP

        // Discord bot (optional). OFF unless discordEnabled && discordToken are set. The bot is a
        // separate Python process (discord.py) the coordinator places on the agent with the most
        // free GPU memory (for a local Ollama LLM). See SmithCoordinator/CoordinatorDiscord.cpp +
        // tools/smith-discord-bot.py. Discord needs TLS, which Smith's C++ deliberately avoids -
        // hence an out-of-process bot driving Smith over the plain-HTTP LAN API.
        bool discordEnabled = false;
        std::string discordToken;                      // Discord bot token - secret, never logged
        std::string discordAppId;                      // application id (slash-command registration)
        std::string discordGuildId;                    // guild id for fast slash-command registration (optional)
        std::string discordNotifyChannelId;            // channel id for build notifications
        std::vector<std::string> discordCommandChannels; // channel ids where commands are accepted (empty = any)
        std::vector<std::string> discordAllowRoles;    // role ids allowed to command the bot (empty = anyone in allowed channels)
        std::vector<std::string> discordAllowUsers;    // user ids allowed to command the bot
        std::string discordPinNode;                    // optional: pin the bot to this node hostname (empty = auto best-GPU)
        std::string ollamaUrl = "http://127.0.0.1:11434";
        std::string ollamaModel = "qwen3.5:9b";
        bool discordNotifyStart = true;                // notify when a build starts running
        bool discordNotifyRunning = false;             // notify on intermediate phase changes (noisy)
        bool discordNotifySuccess = true;              // notify on success
        bool discordNotifyFail = true;                 // notify on failed/error/lost
        bool discordConfirmDeploy = true;              // a /deploy needs an explicit confirm step
        int discordMigrateMarginMb = 2048;             // min free-VRAM gain before a healthy bot host is abandoned
        int discordHostFailureCooldownSec = 600;       // bench a node this long after it fails to host the bot

        // Commit-driven trigger coalescing. A build queued by poll / autobuild / webhook
        // means "build the tip of this branch", so a newer one always supersedes a still-
        // QUEUED build of the same target: a burst of pushes leaves one queued build, on
        // the newest commit, instead of one per commit. That part is always on.
        // cancelRunningOnNewCommit extends it to the build already RUNNING on an agent -
        // it is aborted so the newest commit starts straight away. OFF by default: when
        // commits land faster than a build takes, nothing would ever finish.
        bool cancelRunningOnNewCommit = false;

        // Build batches/chains (parallel multi-builds with a success-gated follow-up).
        // These are the coordinator-wide defaults; a chain in smith.json or a batch
        // request can override onFailure / pinCommit per use.
        std::string batchOnFailure = "finish";         // "finish": siblings run on after a failure | "cancel"
        bool batchPinCommit = true;                    // resolve the branch tip once; all batch jobs build that commit
        int batchKeep = 50;                            // batches retained in batches.json

        std::string configPath;                        // file this config was loaded from (write-back target for the Settings UI); empty = none

        // Config-file health at startup. A hand edit that broke the JSON used to drop the
        // WHOLE file (no login, no embedded agent, no Discord bot) behind a one-line stderr
        // warning. Now a good load is copied to a last-known-good file beside it, a bad
        // one falls back to that copy, and the parse error is surfaced (web UI + bot).
        std::string configError;                       // why configPath failed to load at startup ("" = loaded fine)
        bool configUsingLastKnownGood = false;         // configError set AND the last-known-good copy was applied
    };

    struct AgentConfig
    {
        std::string coordinatorUrl = "http://127.0.0.1:9876";
        std::string token;
        std::string name;                              // empty -> hostname
        std::string os;                                // empty -> auto-detected
        std::string arch;                              // empty -> auto-detected
        std::vector<std::string> labels;
        std::string workspace = "smith-agent-workspace";
        int pollIntervalMs = 1500;
        int heartbeatSec = 10;
        bool discover = true;                          // broadcast to find the coordinator
        int discoveryPort = 9877;                      // UDP discovery port (matches coordinator)
        std::map<std::string, std::string> buildEnv;   // env injected into every build (e.g. UNA_ENGINE_PATH)
        // Workspace housekeeping. Before each build the agent prunes old logs and,
        // if free disk falls below minFreeDiskMb, reclaims space (gc + LRU-evict
        // old project checkouts); if still below, the job fails fast rather than
        // filling the disk mid-build. 0 minFreeDiskMb disables the guard.
        int minFreeDiskMb = 5120;                      // ~5 GB free floor
        int logKeepDays = 14;                          // delete build logs older than this (0 = no age cap)
        int logKeepMax = 200;                          // keep at most this many build logs (0 = no count cap)
    };

    // Apply a JSON config file's known keys onto an existing config (called before
    // CLI flags, so flags override the file). Nothing is applied unless the whole file
    // parses. Returns false (reason in *error) for a missing, unreadable or invalid
    // file. See smith-coordinator.example.json.
    bool LoadCoordinatorConfigFile(const std::string& path, CoordinatorConfig& c, std::string* error);
    void LoadCoordinatorConfigFile(const std::string& path, CoordinatorConfig& c);
    // Write the UI-editable parts of a coordinator config (general / auth / dns) back to a
    // JSON file, preserving any other keys already present. Used by the Settings UI.
    // Refuses (returns false) to overwrite an existing file that does not parse: starting
    // from an empty object would silently discard every hand-edited, non-UI key.
    bool SaveCoordinatorConfigFile(const std::string& path, const CoordinatorConfig& c);

    // Last-known-good copy of a config file: "x.json" -> "x.lkg.json".
    std::string LastKnownGoodConfigPath(const std::string& configPath);
    // Copy configPath (which must parse) over its last-known-good file. No-op if identical.
    void StoreLastKnownGoodConfig(const std::string& configPath);
    // Does the file currently parse as a config object? "" = yes (or the file is absent),
    // otherwise the reason. Parse errors carry line/column but never file content: the
    // text is shown in the web UI and posted to Discord, and the file holds secrets.
    std::string CheckCoordinatorConfigFile(const std::string& path);

    CoordinatorConfig ParseCoordinatorArgs(int argc, char** argv, int startIndex);
    AgentConfig ParseAgentArgs(int argc, char** argv, int startIndex);

    std::string DetectOs();        // "windows" | "mac" | "linux"
    std::string DetectArch();      // "x64" | "arm64" | "arm" | "x86"
    std::string DetectHostname();
    std::string DefaultDataDir();  // %ProgramData%\Smith (Windows) | ~/.smith (mac/linux)
}
