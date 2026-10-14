// BuildRecord.h - the persisted state of one build.
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include "BuildDiagnostics.h"

#include <string>
#include <vector>
#include <cstdint>

namespace Smith
{
    // status:  queued | running | success | failed | error | lost
    // phase:   queued | checkout | building | collecting | handoff | done
    struct BuildRecord
    {
        std::string jobId;
        std::string projectId;
        std::string product;
        std::string variant;       // chosen build variant/profile (empty = none)
        std::string targetOs;      // pinned build platform: "" (any) | windows | mac | linux
        std::string rule;
        int buildNumber = 0;
        std::string branch;
        std::string commit;
        std::string authorName;    // triggering commit's author (filled at checkout)
        std::string authorEmail;   // used to attribute a failure to the person at fault
        std::string reason;        // manual | poll | autobuild | webhook | schedule | rerun | retry | batch:<name>
                                   // (poll/autobuild/webhook are the commit-driven ones that coalesce - see SupersedeStaleAutoBuildsLocked)
        std::string batchId;       // owning batch/chain (deploy steps use it to consume that run's artifacts)
        bool clean = false;        // force a clean checkout (purge untracked/ignored files)
        std::string status = "queued";
        std::string phase = "queued";
        std::string nodeId;
        std::string nodeName;      // agent hostname at assignment (nodeIds are transient uuids)
        int64_t createdAt = 0;
        int64_t startedAt = 0;
        int64_t finishedAt = 0;
        int exitCode = 0;
        int64_t durationMs = 0;
        std::vector<std::string> artifacts;   // stored filenames
        BuildDiagnostics diagnostics;         // parsed errors/warnings/tests (lazy)
        // Auto-retry on another node: a node/environment failure (not a code error)
        // is re-dispatched once to a different capable node.
        int attempt = 1;             // 1 = first try; a retry on another node makes this 2 (one retry max)
        std::string avoidNodeName;   // hostname the prior attempt failed on; dispatch skips it for this job
        std::string retryOfJobId;    // the build this is a retry of (UI/trace link); empty on the first attempt
    };
}
