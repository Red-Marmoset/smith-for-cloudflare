// WireTypes.h - Shared coordinator<->agent message types.
//
// Plain value structs with no JSON dependency, so both the coordinator and the
// agent compile against one source of truth for the wire format. Serialization
// lives in WireJson (the only place that includes nlohmann).
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>
#include <vector>
#include <map>
#include <cstdint>

namespace Smith
{
    // Bumped when the wire format changes incompatibly; checked at registration.
    constexpr int kProtocolVersion = 1;

    struct NodeInfo
    {
        std::string nodeId;
        std::string hostname;
        std::string os;            // "windows" | "mac" | "linux"
        std::string arch;          // "x64" | "arm64" | ...
        std::vector<std::string> labels;
        std::string agentVersion;
        int gpuTotalMb = 0;        // total NVIDIA VRAM (MiB), 0 = none/unknown
        int gpuFreeMb = 0;         // latest free VRAM (MiB), refreshed via heartbeat
        bool ollamaUp = false;     // a local Ollama answers on this box (Discord bot placement)
    };

    struct RegisterRequest
    {
        std::string hostname;
        std::string os;
        std::string arch;
        std::vector<std::string> labels;
        std::string agentVersion;
        int protocolVersion = 0;
        int gpuTotalMb = 0;        // total NVIDIA VRAM (MiB) detected at startup, 0 = none
        int gpuFreeMb = 0;         // free VRAM (MiB) at registration
        bool ollamaUp = false;     // a local Ollama answered the startup probe
    };

    struct RegisterResponse
    {
        bool accepted = false;
        std::string nodeId;
        int heartbeatIntervalSec = 10;
        int protocolVersion = 0;
        std::string message;
    };

    struct Heartbeat
    {
        std::string status;        // "idle" | "busy"
        std::string currentJobId;  // empty when idle
        int gpuFreeMb = 0;         // latest free NVIDIA VRAM (MiB), 0 = none/unknown
        // Health of the hosted auxiliary service (the Discord bot), so the
        // coordinator can show placement AND liveness, not just placement.
        std::string serviceStatus; // "" (not hosting) | "starting" | "running" | "failed" | "exited"
        std::string serviceDetail; // last output line when failed/exited - the "why"
        bool ollamaUp = false;     // a local Ollama answers on this box (refreshed periodically)
    };

    // One-shot task piggybacked on the heartbeat response: enter a Steam Guard
    // two-factor code on this agent (the steamcmd box). The agent resolves
    // credentialRef to username/password locally - no secrets on the wire beyond
    // the short-lived code itself. Empty requestId = no task.
    struct SteamGuardTask
    {
        std::string requestId;
        std::string credentialRef;
        std::string code;
    };

    // What a heartbeat POST returns. Agents that predate this ignore the body.
    struct HeartbeatResponse
    {
        SteamGuardTask steamGuard;
    };

    struct CommandSpec
    {
        std::string interpreter;   // "ps1" | "bat" | "sh" | "python" | "exe"
        std::string script;        // path relative to workingDir (or program for "exe")
        std::vector<std::string> args;
    };

    struct RepoCheckout
    {
        std::string name;
        std::string url;
        std::string branch;
        std::string commit;        // empty = tip of branch
        std::string checkoutDir;   // relative to the job workspace
        std::string authToken;     // optional repository credential (an Artifacts token or a Smith ticket; never a GitHub PAT on the
                                   // hosted path), kept off the URL/.git/config and sent as a git http.extraheader
        std::string hostedUuid;    // hosted path: this machine keeps a current copy of the repository in its own store with this
                                   // UUID, so the checkout clones that store instead of the coordinator relay (verifying `tip`)
        std::string tip;           // the commit the branch is expected to be at in that copy ("" = not checked)
    };

    struct ArtifactSpec
    {
        std::vector<std::string> globs;
        std::vector<std::string> exclude;   // path globs subtracted from globs (e.g. Unity debug dirs)
        bool excludeDefaults = true;         // also drop built-in never-ship dirs (DefaultArtifactExcludes)
        std::string package;       // "zip" | "none"
        std::string archiveName;
    };

    struct HandoffStep
    {
        std::string name;
        std::string type;          // "collect"|"copyShare"|"script"|"steam"|"itch"|"cloudflare"
        std::map<std::string, std::string> fields;
        bool continueOnError = false;
    };

    // One artifact a job consumes from an earlier build (fan-in). Fully resolved
    // by the coordinator - the agent just downloads jobId/archiveName and stages
    // it (zips extract into the working dir, other files are written under their
    // name). product/variant/buildNumber/commit are for logging and the
    // commit-divergence warning only.
    struct ArtifactInput
    {
        std::string jobId;
        std::string archiveName;
        std::string product;
        std::string variant;
        int buildNumber = 0;
        std::string commit;
    };

    // A "mirror" job's push target: copy the (single) source repo's pinned commit (or,
    // with an empty commit, its branch tip) and tags into a Cloudflare Artifacts repository,
    // or from Smith's Artifacts copy out to a project's linked repository. Only the hosted
    // coordinator emits these; the LAN coordinator never sets JobSpec::mirror.
    struct MirrorSpec
    {
        std::string remote;        // https://<account>.artifacts.cloudflare.net/git/<ns>/<repo>.git, or the linked repository
        std::string authToken;     // short-lived Artifacts write token (never in argv / .git/config); empty for a linked repository
        std::string branch;        // branch to create at the pinned commit
        bool pushTags = true;
        bool allRefs = false;      // push every branch and tag (Move to storage), not one branch
    };

    // A build of a repository project's branch tip: after checkout the agent posts what it found
    // to the coordinator's /resolve, which answers with the command smith.json defines for `action`.
    struct ResolveSpec
    {
        std::string action;
    };

    // A "host" job: the machine clones the (single) source repository into a bare mirror it keeps
    // and serves from then on (Smith-hosted repositories). Only the hosted coordinator emits these.
    struct HostSpec
    {
        std::string repoUuid;      // names the store under the agent's git root
        std::string defaultBranch; // what HEAD points at when the source has no usable HEAD ("" = the source's)
        int64_t maxBytes = 0;      // refuse a repository larger than this (0 = no limit)
        // A project started in Smith: no repository to copy, so the machine creates one. kind "" = a copy (the default),
        // "empty" = one commit holding a README, "zip" = one commit holding the uploaded zip's files (downloaded with the lease).
        struct Init { std::string kind, name, archiveName; int64_t archiveSize = 0; } init;
    };

    // A Smith pull request's job (kind "diff" | "merge" | "publish"), hosted coordinator only. The
    // single repo is checked out at the pull request's head commit; `baseBranch` is the branch it
    // merges into. A diff reports the change and whether it merges cleanly; a merge commits it into
    // the base branch and pushes that branch (never forced); a publish pushes the head to another
    // remote's branch (a GitHub origin) with the machine's own Git login.
    struct PullSpec
    {
        std::string baseBranch;
        std::string message;       // merge: the merge commit's message
        std::string authorName;    // merge: the merge commit's author and committer
        std::string authorEmail;
        std::string targetRemote;  // publish: where the head goes
        std::string targetBranch;
    };

    // The fully-resolved unit of work an agent can execute with no further lookups.
    struct CheckInSpec { std::string eventId, baseCommit, headCommit; };

    // Large files (Git LFS): the Smith remote whose /info/lfs endpoint holds the project's objects and a read ticket
    // for it. Set by the coordinator at claim for builds of projects that keep any; the agent turns it into git config.
    struct LfsSpec
    {
        std::string url;
        std::string authToken;
    };

    // An "import" job (hosted coordinator only): mirror-clone `source` with this machine's own login, move blobs over
    // `thresholdBytes` to Git LFS (the original history goes up as the job blob `originalBlob` first), push the objects to
    // `smithRemote`'s LFS endpoint (the ticket rides in JobSpec::lfs) and the mirror to `artifactsRemote` with `artifactsToken`.
    struct ImportSpec
    {
        std::string source;
        std::string artifactsRemote;
        std::string artifactsToken;
        std::string smithRemote;
        std::string originalBlob;
        int64_t thresholdBytes = 0;
        int64_t maxRepoBytes = 0;
    };

    struct JobSpec
    {
        std::string jobId;
        std::string kind = "build";                   // "build" | "mirror" | "scan" | "host" | "diff" | "merge" | "publish" | "import" (absent in v1 JSON -> build)
        std::string projectId;
        int buildNumber = 0;
        std::vector<RepoCheckout> repos;
        CommandSpec command;                          // single command (or first of steps)
        std::vector<CommandSpec> steps;               // ordered steps; if non-empty, run these
        std::string workingDir;                       // relative to primary repo checkout
        std::map<std::string, std::string> env;
        int timeoutSeconds = 0;
        std::vector<int> successExitCodes;            // empty = treat {0} as success
        ArtifactSpec artifacts;
        std::vector<HandoffStep> handoff;
        std::vector<ArtifactInput> inputs;            // artifacts staged before the command runs
        bool clean = false;                           // wipe untracked/ignored files before building
        MirrorSpec mirror;                            // kind == "mirror" only
        CheckInSpec checkIn;
        ResolveSpec resolve;                          // kind == "build" with an unpinned repo only
        HostSpec host;                                // kind == "host" only
        LfsSpec lfs;                                  // builds of projects with large files only
        PullSpec pull;                                // kind == "diff" | "merge" | "publish" only
        ImportSpec import;                            // kind == "import" only
    };

    struct JobAssignment
    {
        bool hasJob = false;
        std::string jobId;
        JobSpec spec;
    };

    struct LogChunk
    {
        int64_t seq = 0;
        std::string stream;        // "stdout" | "stderr"
        std::vector<std::string> lines;
    };

    struct JobResult
    {
        std::string status;        // "success" | "failed" | "error"
        int exitCode = 0;
        int64_t durationMs = 0;
        std::string message;
    };

    // A long-lived auxiliary process (today: the Discord bot) the coordinator asks a
    // specific agent to run, separate from the one-shot build job queue. The agent
    // reconciles to this each heartbeat: launch on "run" (or when specHash changes),
    // terminate on "stop".
    struct ServiceSpec
    {
        std::string action;        // "run" | "stop" | "none"
        std::string name;          // service id, e.g. "discord-bot"
        std::string specHash;      // changes when env changes -> agent relaunches
        std::map<std::string, std::string> env;   // environment for the service process
    };

    struct TriggerRequest
    {
        std::string projectId;
        std::string product;
        std::string branch;
        std::string commit;
        std::string profile;       // chosen build variant (optional)
        std::string targetOs;      // pinned build platform: "" (any) | windows | mac | linux
        std::string reason;        // "manual" | "poll" | "schedule" | "webhook"
        bool clean = false;        // force a clean checkout (purge untracked/ignored files)
    };
}
