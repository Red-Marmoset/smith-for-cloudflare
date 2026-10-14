#include "ToolMaintenance.h"
#include "HostedPlatform.h"
#include <SmithCore/Config.h>
#include <SmithCore/Process.h>
#include <json/single_include/nlohmann/json.hpp>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <future>
#include <mutex>
#include <stdexcept>
namespace Smith {
namespace {
std::filesystem::path ToolDirectory() {
    const char* home = std::getenv(DetectOs() == "windows" ? "USERPROFILE" : "HOME");
    if (!home || !*home) throw std::runtime_error("Agent tool maintenance needs a user home directory");
    auto directory = std::filesystem::path(home) / ".smith-tool-maintenance";
    std::filesystem::create_directories(directory);
    return directory;
}
}
std::unique_ptr<HostedWorkspaceLock> TryAgentToolUse() {
    try { return HostedTryToolLock((ToolDirectory() / "tools.lock").string(), false); }
    catch (const std::exception& error) {
        // A read-only service account cannot maintain tools. Keep its existing build
        // behavior rather than making a writable home a new agent prerequisite.
        static std::once_flag warning;
        std::call_once(warning, [&]() { std::printf("Agent tool coordination unavailable: %s; tools require manual maintenance.\n", error.what()); });
        return std::make_unique<HostedWorkspaceLock>();
    }
}
bool ToolMaintenanceDue(long long now, long long lastAttempt) {
    return lastAttempt == 0 || (now >= lastAttempt && now - lastAttempt >= 86400);
}
void UpdateAgentTools(const std::string& os, const ToolCommandRunner& run) {
    using Json = nlohmann::json;
    // npm may return nonzero for an unrelated broken global package. Its valid inventory
    // still identifies installed packages. Missing npm never triggers a bootstrap install.
    const auto inventory = run("npm", {"ls", "--global", "--depth=0", "--json"});
    const auto parsed = Json::parse(inventory.output, nullptr, false);
    const auto packages = parsed.is_object() && parsed.contains("dependencies") && parsed["dependencies"].is_object()
        ? parsed["dependencies"] : Json::object();
    auto update = [&](const std::string& tool, const std::vector<std::string>& args) {
        const auto result = run(tool, args);
        std::string command = tool;
        for (const auto& arg : args) command += " " + arg;
        std::printf("Tool maintenance: %s %s (exit %d).\n", command.c_str(),
                    result.exitCode == 0 ? "completed" : "failed; will retry next day", result.exitCode);
        std::fflush(stdout);
    };
    if (run("claude", {"--version"}).exitCode == 0) {
        if (packages.contains("@anthropic-ai/claude-code"))
            update("npm", {"install", "--global", "--engine-strict", "@anthropic-ai/claude-code@latest"});
        else if (os == "mac" && run("brew", {"list", "--cask", "claude-code"}).exitCode == 0)
            update("brew", {"upgrade", "--cask", "claude-code"});
        else if (os == "mac" && run("brew", {"list", "--cask", "claude-code@latest"}).exitCode == 0)
            update("brew", {"upgrade", "--cask", "claude-code@latest"});
        else if (os == "windows" && run("winget", {"list", "--id", "Anthropic.ClaudeCode", "--exact", "--disable-interactivity"}).exitCode == 0)
            update("winget", {"upgrade", "--id", "Anthropic.ClaudeCode", "--exact", "--silent", "--disable-interactivity"});
        else update("claude", {"update"});
    }
    if (packages.contains("@openai/codex"))
        update("npm", {"install", "--global", "--engine-strict", "@openai/codex@latest"});
    else if (os == "mac" && run("brew", {"list", "--cask", "codex"}).exitCode == 0)
        update("brew", {"upgrade", "--cask", "codex"});
    if (packages.contains("wrangler"))
        update("npm", {"install", "--global", "--engine-strict", "wrangler@latest"});
    // npm also supplies npx. engine-strict rejects releases incompatible with this Node,
    // preserving the current installation; Node itself remains OS/package-manager owned.
    if (parsed.is_object() && parsed.contains("dependencies"))
        update("npm", {"install", "--global", "--engine-strict", "npm@latest"});
}
ToolMaintenance::ToolMaintenance() {
    const char* disabled = std::getenv("SMITH_AUTO_UPDATE_TOOLS");
    if (disabled && std::string(disabled) == "0") return;
    m_thread = std::thread([this]() {
      try {
        namespace fs = std::filesystem;
        // Global installations are shared by every agent running as this account.
        const auto directory = ToolDirectory();
        const auto stamp = directory / "attempt";
        long long lastAttempt = 0;
        { std::ifstream input(stamp); input >> lastAttempt; }
        while (!m_stop) {
            const auto now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
            if (ToolMaintenanceDue(now, lastAttempt)) {
                std::unique_lock<std::shared_mutex> idle(gate, std::try_to_lock);
                if (idle.owns_lock()) {
                    try {
                        auto accountIdle = HostedTryToolLock((directory / "tools.lock").string(), true);
                        if (!accountIdle) {
                            idle.unlock();
                            for (int i = 0; i < 300 && !m_stop; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
                            continue;
                        }
                        { std::ifstream input(stamp); input >> lastAttempt; }
                        if (!ToolMaintenanceDue(now, lastAttempt)) continue;
                        fs::create_directories(stamp.parent_path());
                        HostedSecureWrite(stamp.string(), std::to_string(now));
                        lastAttempt = now;
                        UpdateAgentTools(DetectOs(), [this, &directory](const std::string& tool, const std::vector<std::string>& args) {
                            ToolCommandResult result;
                            if (m_stop) return result;
                            Process process; ProcessOptions options;
                            options.argv = HostedToolArgv(tool, args); options.workingDir = directory.string();
                            options.timeoutSeconds = args.front() == "install" || args.front() == "upgrade" || args.front() == "update" ? 600 : 30;
                            if (!process.Start(options, [&](bool error, const std::string& line) {
                                if (!error && result.output.size() < 1024 * 1024)
                                    result.output += (line + "\n").substr(0, 1024 * 1024 - result.output.size());
                            })) return result;
                            // Wait owns child reaping. On POSIX, Running() also reaps the
                            // child and would discard a failed installer's exit status.
                            auto completion = std::async(std::launch::async, [&]() { return process.Wait(); });
                            while (completion.wait_for(std::chrono::milliseconds(100)) != std::future_status::ready)
                                if (m_stop) { process.Kill(); break; }
                            result.exitCode = completion.get(); return result;
                        });
                        ++generation;
                    } catch (const std::exception& error) {
                        lastAttempt = now;
                        std::printf("Tool maintenance failed: %s\n", error.what());
                    }
                }
            }
            for (int i = 0; i < 300 && !m_stop; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
      } catch (const std::exception& error) {
        std::printf("Tool maintenance disabled: %s\n", error.what());
      }
    });
}
ToolMaintenance::~ToolMaintenance() { m_stop = true; if (m_thread.joinable()) m_thread.join(); }
}
