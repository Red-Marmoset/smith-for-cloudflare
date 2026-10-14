// Coordinator.h - the Smith coordinator: HTTP API, build queue, node registry,
// flat-file persistence and live (SSE) log streaming.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <SmithCore/Config.h>
#include <SmithCore/Store.h>
#include <SmithCore/Domain.h>
#include <SmithCore/BuildRecord.h>
#include <SmithCore/Batches.h>
#include <SmithCore/Discovery.h>
#include <SmithCore/GoogleAuth.h>
#include <SmithProtocol/WireTypes.h>
#include <Http/Http.h>

#include <map>
#include <set>
#include <vector>
#include <string>
#include <mutex>
#include <memory>
#include <atomic>
#include <thread>
#include <condition_variable>

namespace Smith
{
    class Agent;

    struct NodeRuntime
    {
        NodeInfo info;
        int64_t lastSeenMs = 0;
        std::string status = "idle";     // idle | busy | offline
        std::string currentJobId;
        std::string serviceStatus;       // hosted-service (Discord bot) health from heartbeats
        std::string serviceDetail;       // the "why" when failed/exited
    };

    class Coordinator
    {
    public:
        explicit Coordinator(CoordinatorConfig cfg);

        bool LoadProjects();   // parse configured smith.json files
        bool Start();          // bind + serve (blocking); false if bind fails
        void Stop();

        ~Coordinator();

        // Enqueue a build; returns the jobId, or "" if nothing matched.
        std::string EnqueueBuild(const std::string& projectId, const std::string& product,
                                 const std::string& branch, const std::string& commit,
                                 const std::string& reason, const std::string& profile = "",
                                 const std::string& targetOs = "", bool clean = false);

        // Clone (or fetch) a repo by URL into the coordinator's own checkout, read
        // its smith.json and register the project. Returns the project id, or "".
        std::string AddProjectByUrl(const std::string& url, const std::string& branch, std::string& error);

    private:
        void RegisterRoutes();
        bool Authorized(const Http::Request& req) const;        // agents/infra: session OR token OR loopback
        bool AuthorizedHuman(const Http::Request& req) const;   // UI/data: when requireLogin, a session (or operator token) is mandatory
        bool AuthFeatureOn() const;                             // is Google sign-in configured (--google-client-id)?

        // Handlers
        void HandleRegister(const Http::Request&, Http::Response&);
        void HandleHeartbeat(const Http::Request&, Http::Response&);
        void HandleJobsNext(const Http::Request&, Http::Response&);
        void HandleLog(const Http::Request&, Http::Response&);
        void HandleStatus(const Http::Request&, Http::Response&);
        void HandleResult(const Http::Request&, Http::Response&);
        void HandleArtifactUpload(const Http::Request&, Http::Response&);
        void HandleTrigger(const Http::Request&, Http::Response&);
        void HandleNodes(const Http::Request&, Http::Response&);
        void HandleProjects(const Http::Request&, Http::Response&);
        void HandleProjectBuilds(const Http::Request&, Http::Response&);
        // Everything the dashboard renders, in one response - counts plus the newest
        // few builds across all projects. GET /api/overview[?since=<epochMs>]
        void HandleOverview(const Http::Request&, Http::Response&);
        void HandlePipeline(const Http::Request&, Http::Response&);   // raw smith.json of a project's source
        // Batches/chains: several builds queued in parallel + a success-gated
        // follow-up (CoordinatorBatches.cpp). State machine is SmithCore/Batches.
        void HandleBatchCreate(const Http::Request&, Http::Response&);    // POST /api/batch
        void HandleBatchGet(const Http::Request&, Http::Response&);       // GET  /api/batch/:id
        void HandleProjectBatches(const Http::Request&, Http::Response&); // GET  /api/projects/:id/batches
        // Steam Guard relay: a short-lived 2FA code posted from chat is delivered to
        // the steamcmd agent in its next heartbeat response; the outcome flows back.
        void HandleSteamGuard(const Http::Request&, Http::Response&);        // POST /api/steam-guard {code, credentialRef?}
        void HandleSteamGuardStatus(const Http::Request&, Http::Response&);  // GET  /api/steam-guard/:id
        void HandleSteamGuardResult(const Http::Request&, Http::Response&);  // POST /api/steam-guard/:id/result (agent)
        void HandleBadge(const Http::Request&, Http::Response&);   // public SVG status badge
        void HandleBuild(const Http::Request&, Http::Response&);
        void HandleBuildDiagnostics(const Http::Request&, Http::Response&);
        void HandleBuildLog(const Http::Request&, Http::Response&);
        void HandleArtifactDownload(const Http::Request&, Http::Response&);
        void HandleRerun(const Http::Request&, Http::Response&);    // re-queue a build with the same params
        void HandleCancel(const Http::Request&, Http::Response&);   // cancel a queued/running build
        // Re-sync a cloned project source + re-read smith.json, so a manual trigger
        // or rerun builds with the repo-tip rule definitions (parity with the
        // poll/autobuild refresh). No-op for local --project trees. Takes m_mutex.
        void RefreshProjectSource(const std::string& projectId);
        // Read <branch>'s own smith.json (git show origin/<branch>:smith.json - the work
        // tree is never touched) into m_branchProjects, so a branch can build products its
        // default branch doesn't have yet. No-op (true) for the source's tracked branch,
        // whose smith.json is the project def itself. `fetch` = fetch first. Takes m_mutex.
        bool LoadBranchProject(const std::string& projectId, const std::string& branch,
                               bool fetch, std::string& error);
        // Load overlays for branches that queued builds / enabled autobuilds still need
        // (they are in-memory, so a restart would otherwise strand those builds). Startup.
        void WarmBranchProjects();
        // GET /api/projects/:id/branch-products?branch=X -> the products that build X,
        // read from X's own smith.json (drives the Autobuild + Trigger product pickers).
        void HandleBranchProducts(const Http::Request&, Http::Response&);

        // Batch internals (CoordinatorBatches.cpp; all assume m_mutex held)
        void OnJobTerminalLocked(const std::string& jobId);   // advance batches containing the job
        void AdvanceAllBatchesLocked();                       // startup: settle batches whose jobs went lost
        void CancelBuildLocked(const std::string& jobId);     // queued -> cancelled, running -> cancel signal
        // A node is gone (re-registered under a new id, or reaped): its in-flight builds can
        // never report back, so settle them as "lost" now. Caller holds m_mutex.
        void MarkNodeBuildsLostLocked(const std::string& nodeId, const std::string& why);
        void SaveBatchesLocked();
        void LoadBatches();                                   // takes m_mutex itself (startup)
        void EmitBatchEvent(const BatchDef& b);               // SSE {type:"batch", ...}
        // Variant by name OR slug ("Steam (Windows)" / "steam-windows"); null if unknown.
        const ProductVariant* ResolveVariantRef(const BuildProductDef&, const std::string& ref) const;
        std::string EnqueueBuildLocked(const std::string& projectId, const std::string& product,
                                       const std::string& branch, const std::string& commit,
                                       const std::string& reason, const std::string& profile,
                                       const std::string& targetOs, bool clean = false);
        // Commit-driven coalescing: when a fresh poll/autobuild/webhook commit is enqueued,
        // any still-queued build from those triggers for the same (project, product, branch,
        // variant, targetOs) is stale - only the newest commit matters. Mark those
        // "superseded" and drop them from the queue so we don't run four builds where one
        // would do. With cfg.cancelRunningOnNewCommit the build already RUNNING for that
        // target is aborted too. Caller holds m_mutex.
        void SupersedeStaleAutoBuildsLocked(const std::string& projectId, const std::string& product,
                                            const std::string& branch, const std::string& profile,
                                            const std::string& targetOs);

        // Helpers (assume caller holds m_mutex unless noted)
        bool NodeOnlineLocked(const NodeRuntime& n, int64_t now) const;
        const ProjectDef* FindProject(const std::string& id) const;
        const BuildProductDef* FindProduct(const ProjectDef&, const std::string& name) const;
        // FindProduct, but a branch's own smith.json (m_branchProjects) wins over the
        // project def when it has the product - a build runs the rules on its branch.
        const BuildProductDef* FindProductForBranch(const ProjectDef&, const std::string& name,
                                                    const std::string& branch) const;
        const BuildRuleDef* FindRule(const BuildProductDef&, const std::string& branch) const;
        bool ResolveJobSpec(const BuildRecord& rec, const NodeInfo& node, JobSpec& out) const;
        bool GetBuildCopy(const std::string& jobId, BuildRecord& out);

        // Auto-retry: a node/environment failure (not a code error) is re-dispatched
        // once to a different capable node. MaybeRetry classifies OFF the lock (it reads
        // + parses the build log), then takes m_mutex to enqueue.
        void MaybeRetryOnAnotherNode(const BuildRecord& finished);
        std::string EnqueueRetryLocked(const BuildRecord& orig, const std::string& avoidHost);
        bool HasOtherCapableNodeLocked(const BuildRecord& rec, const std::string& avoidHost) const;

        // Run the configured --notify-command on build finish (build info passed via
        // SMITH_* env), so a project can post to Slack/Discord/email/etc. Smith's own
        // HTTP is plaintext-only, so the actual (HTTPS) notify is delegated to the
        // command (e.g. curl). No-op if --notify-command is unset.
        void NotifyBuildFinished(const BuildRecord& rec) const;

        // Parse a terminal build's console.log into diagnostics once, cache + persist.
        // Returns false if the build is unknown or not yet terminal (out left default).
        bool EnsureDiagnostics(const std::string& jobId, BuildDiagnostics& out);
        void EnsureAuthor(const std::string& jobId);   // resolve commit author from the project checkout
        static bool IsTerminal(const std::string& status);

        // Project sources the coordinator clones + watches. [CoordinatorProjects.cpp]
        bool LoadProjectRepos();
        void RegisterProject(const ProjectDef& def);
        void DiscoverProjectVariants(ProjectDef& def) const;   // glob the checkout for build variants
        void SaveSources();
        void LoadSources();

        // Async add-project queue: HandleAddProject validates + enqueues and returns
        // immediately; a worker thread clones each request in the background so the UI
        // never blocks and several can be added at once. Requests persist across runs.
        std::string EnqueueProjectRequest(const std::string& url, const std::string& branch);
        void AddWorkerLoop();
        void SaveRequests();
        void LoadRequests();

        // Flat-file user accounts (users.json). FindUserByEmail powers failure
        // attribution; SaveUsers/LoadUsers persist the registry.
        void SaveUsers();
        void LoadUsers();
        std::string FindUserByEmail(const std::string& email) const;

        // Co-located embedded agent (--with-agent).
        void StartEmbeddedAgent();
        void StopEmbeddedAgent();

        // Triggers: git poller + cron scheduler. [CoordinatorTriggers.cpp]
        void TriggerLoop();
        void PollProjectBranches(const std::string& projectId);
        void LoadPollState();   // restore per-branch last-seen SHAs so a restart doesn't re-baseline (and skip) commits
        void SavePollState();

        // Handlers (M3).
        void HandleAddProject(const Http::Request&, Http::Response&);
        void HandleProjectRequests(const Http::Request&, Http::Response&);
        void HandleClearBuilds(const Http::Request&, Http::Response&);
        void HandleUsers(const Http::Request&, Http::Response&);
        void HandleDeleteUser(const Http::Request&, Http::Response&);
        void HandleWebhook(const Http::Request&, Http::Response&);

        // Nested data types (declared before the methods + members that use them).
        struct ProjectSource { std::string url; std::string branch; std::string dir; std::string projectId; bool local = false; };
        // A poll/autobuild saw a new commit on a non-tracked <branch>: refresh its overlay
        // and return true; false for the tracked branch (CoordinatorTriggers.cpp).
        bool RefreshBranchOverlay(const ProjectSource& src, const std::string& projectId,
                                  const std::string& branch);

        // An add-project attempt. status: pending | cloning | done | failed
        struct ProjectRequest
        {
            std::string id, url, branch, status, projectId, error;
            int64_t createdAt = 0, finishedAt = 0;
        };

        // A Smith user/account: a Google sign-in identity (email + googleSub) plus
        // the set of git emails used to attribute a build failure to the person at
        // fault (Part D) and target notifications.
        struct User
        {
            std::string id, displayName, role;       // role: admin | member
            std::string email;                       // primary Google identity (lowercased); also the explicit-allow grant
            std::string googleSub;                   // stable Google subject id (recorded on first login)
            std::vector<std::string> gitEmails;
            bool notifyOwnFailuresOnly = true;
        };

        // An issued browser session: an opaque random bearer token kept
        // server-side in sessions.json. No JWT/HMAC (Smith has no crypto) - the
        // token is just a lookup key into this map.
        struct Session
        {
            std::string token, userId, email;
            int64_t createdAt = 0, expiresAt = 0;
        };

        // A UI-managed autobuild rule: poll <branch> of <projectId> every
        // intervalSeconds and build <product> (optionally pinned to targetOs) when the
        // branch's commit changes. Stored server-side in autobuilds.json - NOT the repo's
        // smith.json - so polling can be configured for any project from the web UI.
        struct AutobuildRule
        {
            std::string id, projectId, branch, product, targetOs;
            int intervalSeconds = 300;
            bool enabled = true;
            int64_t createdAt = 0;
            std::string lastSha;        // per-rule baseline (persisted)
            int64_t lastPolledAt = 0;   // runtime only (not persisted)
        };

        // Google Workspace sign-in (CoordinatorAuth.cpp). Off unless --google-client-id.
        void HandleAuthConfig(const Http::Request&, Http::Response&);   // public: {enabled, clientId, domains}
        void HandleAuthGoogle(const Http::Request&, Http::Response&);   // public: verify id_token -> issue session
        void HandleAuthMe(const Http::Request&, Http::Response&);       // current user (session required)
        void HandleAuthLogout(const Http::Request&, Http::Response&);   // invalidate the session

        // Sessions + Google identity (CoordinatorAuth.cpp).
        bool RequestHasSession(const Http::Request& req) const;        // a live (unexpired) session bearer is present
        bool CurrentSession(const Http::Request& req, Session& out) const;
        bool SessionTokenLive(const std::string& token) const;         // is this exact token a live session? (for the SSE ?access_token=)
        std::set<std::string> AllowedEmailSet() const;                 // config emails u provisioned-user emails (lowercased)
        bool VerifyGoogleIdToken(const std::string& idToken, GoogleClaims& out, std::string& err);
        User UpsertGoogleUser(const GoogleClaims& claims);             // find-or-create; binds googleSub; caller persists
        std::string IssueSession(const User& u);                       // create + persist a session, return its token
        void SaveSessions();
        void LoadSessions();

        // UI-managed autobuilds (CoordinatorAutobuilds.cpp; poller in CoordinatorTriggers.cpp).
        void HandleAutobuilds(const Http::Request&, Http::Response&);       // GET list / POST create-or-update (per project)
        void HandleDeleteAutobuild(const Http::Request&, Http::Response&);  // POST remove a rule
        void SaveAutobuilds();
        void LoadAutobuilds();
        void PollAutobuildRules();   // one pass over due rules; called from TriggerLoop

        // Optional dynamic DNS (CoordinatorDns.cpp): keep a Cloudflare A record pointed at this box's public IP.
        bool DnsConfigured() const;
        bool RunDnsUpdate();         // one update cycle (curl public IP + Cloudflare API)
        void DnsLoop();              // background thread; runs while DNS is configured
        void RestartDnsThread();     // apply DNS config changes live (join + restart)
        void HandleConfig(const Http::Request&, Http::Response&);   // GET/POST /api/config (Settings UI)
        // GET /api/config/status: is the config file healthy? Startup fallback + the file as
        // it is on disk now. Drives the web UI banner and the Discord bot's complaint.
        void HandleConfigStatus(const Http::Request&, Http::Response&);

        // Optional Discord bot (CoordinatorDiscord.cpp): a Python bot the coordinator places on
        // the online agent with the most free GPU memory (for a local Ollama LLM).
        bool DiscordConfigured() const;          // enabled + token set
        void DiscordLoop();                      // background thread: (re)compute placement, migrate
        void RestartDiscordThread();             // apply config changes live (join + restart)
        std::string PickBotHostNode();           // nodeId of the chosen host ("" if none); honors pinNode
        std::string BotSpecHash() const;         // hash of the bot's launch env (config-derived)
        ServiceSpec BuildBotService(const std::string& forNodeId);   // the spec returned to an agent's /service poll
        void HandleAgentService(const Http::Request&, Http::Response&);  // GET /api/agents/:nodeId/service

        // Build-lifecycle events broadcast over SSE (GET /api/events). The Discord bot (and
        // any future consumer) subscribes for start/running/terminal notifications. Appends
        // are cheap + guarded by m_eventsMutex (NOT m_mutex), so emit points can hold m_mutex.
        void EmitBuildEvent(const std::string& type, const BuildRecord& rec);
        // The shared ring append behind every Emit*Event (payload = dumped JSON).
        void PushEvent(std::string payload);

        struct SteamGuardRequest
        {
            std::string id;
            std::string credentialRef;
            std::string code;                 // cleared once the agent reports back
            std::string nodeId;
            std::string nodeName;
            std::string status = "pending";   // pending | sent | done | failed
            std::string detail;
            int64_t createdMs = 0;
        };
        std::map<std::string, SteamGuardRequest> m_steamGuard;   // guarded by m_mutex
        std::map<std::string, int64_t> m_botFailures;             // HOSTNAME -> when bot hosting failed (placement cooldown; keyed by hostname, not nodeId, so it survives an agent reconnecting with a fresh nodeId)
        std::map<std::string, BatchDef> m_batches;                // guarded by m_mutex; persisted to batches.json

        CoordinatorConfig m_cfg;
        Store m_store;
        Http::Server m_server;

        mutable std::mutex m_mutex;
        std::map<std::string, ProjectDef> m_projects;
        std::map<std::string, NodeRuntime> m_nodes;
        std::map<std::string, BuildRecord> m_builds;
        std::vector<std::string> m_queue;   // queued jobIds, FIFO
        std::set<std::string> m_cancelRequested;   // jobIds the user asked to cancel (signalled to the agent)
        std::set<std::string> m_supersededRunning; // subset of the above Smith cancelled itself: a newer commit replaced them, so they settle as "superseded", not "cancelled"

        std::map<std::string, ProjectSource> m_sources;                        // projectId -> source repo
        std::map<std::string, std::map<std::string, std::string>> m_pollState; // projectId -> branch -> last sha
        std::map<std::string, AutobuildRule> m_autobuilds;                     // ruleId -> UI-managed autobuild rule
        std::map<std::string, std::map<std::string, ProjectDef>> m_branchProjects; // projectId -> branch -> that branch's smith.json (non-tracked branches only)

        std::map<std::string, ProjectRequest> m_requests;   // requestId -> add-project attempt
        std::vector<std::string> m_addQueue;                // pending request ids, FIFO
        std::thread m_addThread;
        std::atomic<bool> m_stopAdd{ false };
        std::mutex m_addMutex;                              // guards m_requests + m_addQueue
        std::condition_variable m_addCv;

        std::map<std::string, User> m_users;               // userId -> account (guarded by m_mutex)
        std::map<std::string, Session> m_sessions;         // sessionToken -> session (guarded by m_mutex)

        std::unique_ptr<Agent> m_embeddedAgent;
        std::thread m_agentThread;
        std::thread m_triggerThread;
        std::atomic<bool> m_stopTriggers{ false };
        std::thread m_dnsThread;
        std::atomic<bool> m_stopDns{ false };
        std::string m_dnsZoneId;     // cached Cloudflare zone id
        std::string m_dnsLastIp;     // last public IP we successfully applied

        // HandleConfigStatus re-parses the config file only when its size/mtime moves.
        std::mutex m_cfgCheckMutex;
        bool m_cfgCheckDone = false;
        uint64_t m_cfgCheckSize = 0;
        int64_t m_cfgCheckMtime = 0;
        std::string m_cfgCheckError;

        std::thread m_discordThread;
        std::atomic<bool> m_stopDiscord{ false };
        std::string m_botHostNode;   // nodeId currently asked to run the bot ("" = none)
        std::string m_botHostName;   // hostname of that node, kept so a host that vanishes (crash) can be benched by its stable hostname
        std::string m_discordStatus; // human runtime status for the Settings UI

        std::mutex m_eventsMutex;                                   // guards the build-events ring
        std::vector<std::pair<int64_t, std::string>> m_events;      // (seq, json) recent build events, capped
        int64_t m_eventSeq = 0;

        DiscoveryResponder m_discovery;   // answers LAN discovery probes (UDP)
    };
}
