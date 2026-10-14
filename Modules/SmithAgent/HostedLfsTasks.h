// HostedLfsTasks.h - copies of a workspace's large files (Git LFS) kept on this machine: fetch an object from the
// coordinator into the store, send a lost one back (restore), delete one (drop). Parsing and the completion
// report are pure; RunHostedLfsTask moves bytes through the transport under the task's lease.
#pragma once
#include "HostedGitRelay.h"
#include <json/single_include/nlohmann/json.hpp>
#include <atomic>
#include <cstdint>
#include <string>
namespace Smith {
    class HostedTransport;
    struct HostedLfsTask { std::string id, leaseToken, kind, repoId, oid; int64_t size = 0, leaseExpiresAt = 0; };
    // Pure: one entry of a poll reply's `lfs` list; false (with the offending field) when it is not a task this agent runs.
    bool HostedParseLfsTask(const nlohmann::json& task, HostedLfsTask& out, std::string& problem);
    // Pure: where this machine keeps an object: <workspaceRoot>/lfs/<workspaceId>/<oid[0:2]>/<oid[2:4]>/<oid>.
    std::string HostedLfsObjectPath(const std::string& workspaceRoot, const std::string& workspaceId, const std::string& oid);
    // copyGone: a restore found no intact copy here (reported as held: false, so the coordinator forgets this holder).
    struct HostedLfsTaskResult { bool ok = false; std::string message; int64_t size = -1; bool copyGone = false; };
    // Pure: the completion body: {taskId, leaseToken, ok, message[, size][, held: false]}.
    std::string HostedLfsCompletionJson(const HostedLfsTask& task, const HostedLfsTaskResult& result);
    HostedLfsTaskResult RunHostedLfsTask(const HostedTransport& transport, const HostedGitLoopConfig& config, const HostedLfsTask& task, const std::atomic<bool>& stop);
}
