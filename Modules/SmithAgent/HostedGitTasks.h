// HostedGitTasks.h - the work a hosting machine does for Smith's copies between relayed requests: fetch a copy
// from the primary (replicate), bundle the primary into the coordinator's bucket (backup), rebuild a lost
// repository from those bundles (restore), drop a copy (discard), and push or drop refs the copy held that the
// record never had (promote, discard-recovered). Parsing and the completion report are pure; RunHostedGitTask
// runs git and moves bytes through the transport under the task's lease.
#pragma once
#include "HostedGitRelay.h"
#include <json/single_include/nlohmann/json.hpp>
#include <atomic>
#include <cstdint>
#include <string>
namespace Smith {
    class HostedTransport;
    struct HostedGitTask { std::string id, leaseToken, kind, repoId, repoUuid, defaultBranch; nlohmann::json payload = nlohmann::json::object(); int64_t leaseExpiresAt = 0; };
    // Pure: the task object of a poll reply; false (with the offending field) when it is not one this agent runs.
    bool HostedParseGitTask(const nlohmann::json& task, HostedGitTask& out, std::string& problem);
    struct HostedGitTaskResult { bool ok = false; std::string message, tipsJson, peeledJson, recoveredJson, sha256, kind; int64_t bytes = -1, size = -1; };
    // Pure: the completion body: {taskId, leaseToken, ok, message[, tips, peeled, bytes, recovered, size, sha256, kind]}.
    std::string HostedGitTaskCompletionJson(const HostedGitTask& task, const HostedGitTaskResult& result);
    HostedGitTaskResult RunHostedGitTask(const HostedTransport& transport, const HostedGitLoopConfig& config, const HostedGitTask& task, const std::atomic<bool>& stop);
    // Copies a discard moved to <workspace>/git/trash are deleted once older than `olderThanSeconds`.
    void HostedGitPurgeTrash(const std::string& workspaceRoot, int64_t olderThanSeconds);
}
