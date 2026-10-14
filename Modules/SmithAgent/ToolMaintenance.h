#pragma once
#include <atomic>
#include <functional>
#include <shared_mutex>
#include <string>
#include <thread>
#include <vector>
#include "HostedPlatform.h"
namespace Smith {
    struct ToolCommandResult { int exitCode = -1; std::string output; };
    using ToolCommandRunner = std::function<ToolCommandResult(const std::string&, const std::vector<std::string>&)>;
    // Updates only recognized global tools; never operates inside a project checkout.
    void UpdateAgentTools(const std::string& os, const ToolCommandRunner& run);
    bool ToolMaintenanceDue(long long now, long long lastAttempt);
    std::unique_ptr<HostedWorkspaceLock> TryAgentToolUse();
    class ToolMaintenance {
    public:
        ToolMaintenance();
        ~ToolMaintenance();
        std::shared_mutex gate;
        std::atomic<unsigned> generation{0};
    private:
        std::atomic<bool> m_stop{false};
        std::thread m_thread;
    };
}
