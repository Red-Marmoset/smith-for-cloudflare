// HostedGitRelay.h - the git thread of a hosted agent that keeps copies of repositories: it polls
// the coordinator for relayed git requests (clones, fetches and pushes people and builds make
// through https://<coordinator>/git/<project>.git), serves each one against the local bare copy,
// uploads the response in parts and reports the copy's refs. Runs beside the build loop so hosting
// continues during builds.
#pragma once
#include <atomic>
#include <cstdint>
#include <string>
namespace Smith {
    class HostedTransport;
    struct HostedGitLoopConfig { std::string workspaceRoot, workspaceId, hostname; };
    // Runs until `stop`. Polls only while `wanted` (the last heartbeat said this machine keeps copies in some workspace).
    // `busy` (optional) counts relays in flight, so the agent never updates itself mid-request.
    void RunHostedGitLoop(const HostedTransport& transport, const HostedGitLoopConfig& config, const std::atomic<bool>& stop, const std::atomic<bool>& wanted, std::atomic<int>* busy);
    // Pure: a writer relay starts only when free disk covers three times the body plus 1 GiB.
    bool HostedGitDiskSufficient(int64_t freeBytes, int64_t bodyBytes);
    // Pure: the completion the coordinator records: {relayId, leaseToken, status, size, message[, tips, bytes]}.
    std::string HostedGitCompletionJson(const std::string& relayId, const std::string& leaseToken, int status, int64_t size, const std::string& message, const std::string& tipsJson, int64_t bytes, const std::string& peeledJson = "");
    // Pure: the poll interval in milliseconds: 500 for a minute after the last relay, else 3000; 600000 once the
    // coordinator answered 404 (it predates git hosting).
    int HostedGitPollDelayMs(int64_t nowMs, int64_t lastRelayMs, bool unsupported);
}
