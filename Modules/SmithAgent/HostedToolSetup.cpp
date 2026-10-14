// HostedToolSetup.cpp - finding, installing and signing in to the coding CLIs from the dashboard.
#include "HostedToolSetup.h"
#include "HostedAgent.h"
#include "HostedPlatform.h"
#include "ToolMaintenance.h"
#include <SmithCore/Config.h>
#include <SmithCore/Process.h>
#include <json/single_include/nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <mutex>
#include <sstream>
#include <thread>
namespace fs = std::filesystem;
namespace Smith {
namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
const char* ToolBinary(const std::string& tool) { return tool == "codex" ? "codex" : "claude"; }
const char* ToolName(const std::string& tool) { return tool == "codex" ? "Codex" : "Claude Code"; }
std::string Env(const std::string& name) { const char* value = std::getenv(name.c_str()); return value ? value : ""; }
std::string Lower(std::string text) { std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return (char)std::tolower(c); }); return text; }
std::string Dump(const Json& value) { return value.dump(-1, ' ', false, Json::error_handler_t::replace); }
bool IsTool(const fs::path& path, bool windows) {
    std::error_code error;
    if (!fs::is_regular_file(path, error)) return false;
    if (windows) return true;
    const auto perms = fs::status(path, error).permissions();
    return !error && (perms & (fs::perms::owner_exec | fs::perms::group_exec | fs::perms::others_exec)) != fs::perms::none;
}
struct Captured { int exitCode = -1; std::string output; };
// A short command whose output Smith reads (versions, sign-in status), with API keys removed so a
// status reports the subscription login, and nothing able to open a window.
Captured Capture(const std::string& tool, const std::vector<std::string>& args, const std::string& apiKeyTool = "") {
    Captured result; Process process; ProcessOptions options;
    options.argv = HostedToolArgv(tool, args); options.timeoutSeconds = 20; options.envOverride = HostedCliQuietEnv(DetectOs());
    if (!apiKeyTool.empty()) options.envUnset = HostedApiKeyVars(apiKeyTool);
    result.exitCode = process.Run(options, [&](bool, const std::string& line) { if (result.output.size() < 16384) result.output += line + "\n"; });
    return result;
}
int SignedIn(const std::string& tool) {
    if (tool == "codex") { const auto status = Capture("codex", {"login", "status"}, tool); return HostedCodexSignedIn(status.output, status.exitCode); }
    return HostedClaudeSignedIn(Capture("claude", {"auth", "status", "--json"}, tool).output);
}
std::string InstalledVersion(const std::string& tool) {
    if (HostedFindTool(ToolBinary(tool)).empty()) return "";
    const auto version = Capture(ToolBinary(tool), {"--version"});
    return version.exitCode == 0 ? HostedToolVersion(version.output) : "";
}
bool HasApiKey(const std::string& tool) { for (const auto& name : HostedApiKeyVars(tool)) if (!Env(name).empty()) return true; return false; }

// One install or sign-in, run to its end. Its output goes to the page through a pump like a chat
// turn's; what the owner types on the page (a sign-in code) arrives in the replies.
class SetupTask {
public:
    SetupTask(const HostedPostFn& post, Json setup, const std::atomic<bool>& stop) : m_post(post), m_setup(std::move(setup)), m_shutdown(stop) {}
    void Run() {
        std::thread pump([this] { Pump(); });
        Json finish = {{"status", "failed"}, {"message", "Setup failed"}};
        try { finish = Execute(); }
        catch (const std::exception& error) { Line(std::string("Smith could not finish: ") + error.what()); finish["message"] = std::string(error.what()).substr(0, 400); }
        if (m_stopRequested && finish["status"] != "succeeded") finish = {{"status", "stopped"}, {"message", "Stopped"}};
        m_done = true; pump.join();
        if (m_lost) return;
        Json body = {{"setupId", Id()}, {"leaseToken", m_setup.at("leaseToken")}, {"lines", Take(64)}, {"finish", finish}};
        for (int attempt = 0; attempt < 6; ++attempt) {
            std::string response; const int status = m_post("/ai/setup/events", Dump(body), response);
            if ((status >= 200 && status < 300) || status == 409 || status == 401 || status == 403) return;
            std::this_thread::sleep_for(std::chrono::seconds(2));
        }
    }
private:
    const HostedPostFn& m_post; Json m_setup; const std::atomic<bool>& m_shutdown;
    std::mutex m_mutex, m_processMutex; std::deque<std::string> m_lines; Process* m_active = nullptr;
    std::atomic<bool> m_done{false}, m_lost{false}, m_stopRequested{false};

    std::string Id() const { return m_setup.at("setupId").get<std::string>(); }
    void Line(const std::string& text) {
        const auto plain = HostedPlainText(text);
        if (plain.find_first_not_of(" \t") == std::string::npos) return;
        std::lock_guard<std::mutex> lock(m_mutex); if (m_lines.size() < 2000) m_lines.push_back(plain.substr(0, 4000));
    }
    Json Take(size_t most) {
        Json lines = Json::array(); std::lock_guard<std::mutex> lock(m_mutex);
        while (!m_lines.empty() && lines.size() < most) { lines.push_back(m_lines.front()); m_lines.pop_front(); }
        return lines;
    }
    void Kill() { std::lock_guard<std::mutex> lock(m_processMutex); if (m_active) m_active->Kill(); }
    int Run(const std::string& tool, const std::vector<std::string>& args, int timeout, bool interactive, const std::function<std::string(const std::string&)>& reword = {}) {
        Process process; ProcessOptions options; options.argv = HostedToolArgv(tool, args); options.timeoutSeconds = timeout;
        options.envOverride = HostedCliQuietEnv(DetectOs()); options.envUnset = HostedApiKeyVars(m_setup.at("tool").get<std::string>());
        options.stdinPipe = interactive; options.stopWithParent = true;
        auto onLine = [&](bool, const std::string& line) { Line(reword ? reword(HostedPlainText(line)) : line); };
        {
            std::lock_guard<std::mutex> lock(m_processMutex);
            if (m_lost || m_stopRequested || m_shutdown) return -1;
            if (!process.Start(options, onLine)) { Line("Could not start " + tool + "."); return -1; }
            m_active = &process;
        }
        const int rc = process.Wait();
        std::lock_guard<std::mutex> lock(m_processMutex); m_active = nullptr; return rc;
    }
    void Input(const std::string& text) {
        std::lock_guard<std::mutex> lock(m_processMutex);
        if (m_active && m_active->WriteStdin(text + "\n")) Line("(code sent)"); else Line("Nothing is waiting for a code right now.");
    }
    static Json Done(const std::string& status, const std::string& message) { return {{"status", status}, {"message", message}}; }
    Json Execute() {
        const auto tool = m_setup.at("tool").get<std::string>(), action = m_setup.at("action").get<std::string>();
        if ((tool != "claude-code" && tool != "codex") || (action != "install" && action != "sign-in")) return Done("failed", "This agent does not support that setup task.");
        const std::string name = ToolName(tool), os = DetectOs();
        if (action == "install") {
            if (const auto version = InstalledVersion(tool); !version.empty()) return Done("succeeded", name + " is already installed (" + version + ").");
            const auto plan = HostedInstallPlan(tool, os, !HostedFindTool("npm").empty(), os == "mac" && !HostedFindTool("brew").empty());
            if (plan.empty()) return Done("failed", name + " installs with npm, which isn't on this computer. Install Node.js LTS from nodejs.org" + std::string(os == "mac" ? " (or Homebrew)" : "") + ", then click Install again.");
            Line("Installing " + name + " on this computer...");
            for (const auto& step : plan) {
                std::string shown = step.tool; for (const auto& arg : step.args) shown += " " + arg;
                Line("> " + shown);
                const int rc = Run(step.tool, step.args, 900, false);
                if (m_stopRequested) return Done("stopped", "Stopped");
                if (rc != 0) return Done("failed", "The installer exited with code " + std::to_string(rc) + "; its output is above.");
            }
            const auto version = InstalledVersion(tool);
            if (version.empty()) return Done("failed", "The installer finished, but Smith cannot find " + name + " in the usual places.");
            Line("Installed " + version + ".");
            return Done("succeeded", "Installed " + version + ".");
        }
        if (InstalledVersion(tool).empty()) return Done("failed", name + " isn't installed on this computer yet.");
        // Starting a sign-in throws away the current one (Codex does), so only ever start one when
        // the CLI says plainly that it is signed out.
        const int before = SignedIn(tool);
        if (before == 1) return Done("succeeded", "Already signed in to " + name + ".");
        if (before != 0) return Done("failed", "Smith couldn't tell whether " + name + " is signed in, so it did not start a new sign-in (that would replace an existing one).");
        Line("Signing in to " + name + ". Open the link below; nothing opens on this computer by itself.");
        int rc;
        if (tool == "codex") rc = Run("codex", {"login", "--device-auth"}, 900, true);
        else rc = Run("claude", {"auth", "login", "--claudeai"}, 900, true, [](const std::string& line) {
            // Claude Code's own wording assumes it opened a browser; Smith never lets it.
            if (line.rfind("Opening browser", 0) == 0) return std::string();
            const auto at = line.find("https://");
            if (at != std::string::npos && line.find("oauth") != std::string::npos)
                return "Sign in here: " + line.substr(at) + "\nThen paste the code that page shows into the box below.";
            return line;
        });
        if (m_stopRequested) return Done("stopped", "Stopped");
        if (SignedIn(tool) == 1) { Line("Signed in."); return Done("succeeded", "Signed in to " + name + "."); }
        return Done("failed", rc == 0 ? name + " did not finish signing in." : "Signing in did not finish (exit " + std::to_string(rc) + ").");
    }
    void Pump() {
        auto lastSent = Clock::now() - std::chrono::seconds(10), lastAccepted = Clock::now();
        for (;;) {
            bool idle;
            { std::lock_guard<std::mutex> lock(m_mutex); idle = m_lines.empty(); }
            if (idle && m_done) return;
            // Empty reports keep the lease and bring the page's input and Stop; a second apart is quick
            // enough for a pasted code to feel immediate.
            if (!idle || Clock::now() - lastSent > std::chrono::seconds(1)) {
                Json lines = Take(64);
                Json body = {{"setupId", Id()}, {"leaseToken", m_setup.at("leaseToken")}, {"lines", lines}};
                std::string response; const int status = m_post("/ai/setup/events", Dump(body), response); lastSent = Clock::now();
                if (status >= 200 && status < 300) {
                    lastAccepted = Clock::now();
                    const auto reply = Json::parse(response, nullptr, false);
                    if (reply.is_object() && reply.value("stop", false) && !m_stopRequested) { m_stopRequested = true; Kill(); }
                    if (reply.is_object() && reply.contains("input") && reply["input"].is_array())
                        for (const auto& text : reply["input"]) if (text.is_string()) Input(text.get<std::string>());
                } else if (status == 401 || status == 403 || status == 409) { m_lost = true; m_stopRequested = true; Kill(); return; }
                else if (status != 400) { // not delivered: send these lines again next time
                    std::lock_guard<std::mutex> lock(m_mutex);
                    for (auto it = lines.rbegin(); it != lines.rend(); ++it) m_lines.push_front(it->get<std::string>());
                }
            }
            if (m_shutdown && !m_stopRequested) { m_stopRequested = true; Kill(); }
            if (Clock::now() - lastAccepted > std::chrono::seconds(75)) { m_lost = true; m_stopRequested = true; Kill(); return; }
            std::this_thread::sleep_for(std::chrono::milliseconds(idle ? 300 : 100));
        }
    }
};
}

std::vector<std::string> HostedToolSearchDirs(const std::string& os, const std::function<std::string(const std::string&)>& env) {
    std::vector<std::string> dirs;
    auto add = [&](const std::string& base, const std::string& rest) { if (!base.empty()) dirs.push_back(base + rest); };
    if (os == "windows") {
        const auto home = env("USERPROFILE"), appData = env("APPDATA"), local = env("LOCALAPPDATA");
        add(home, "\\.local\\bin");                       // Claude Code's own installer
        add(appData, "\\npm");                             // npm install --global
        add(env("ProgramFiles"), "\\nodejs");
        add(local, "\\Microsoft\\WinGet\\Links");
        add(home, "\\scoop\\shims");
        add(env("ProgramData"), "\\chocolatey\\bin");
        add(local, "\\Volta\\bin");
        add(local, "\\pnpm");
        add(home, "\\.bun\\bin");
        return dirs;
    }
    const auto home = env("HOME");
    add(home, "/.local/bin"); add(home, "/.claude/local"); add(home, "/.npm-global/bin"); add(env("NVM_BIN"), "");
    add(home, "/.volta/bin"); add(home, "/.bun/bin");
    if (os == "mac") add(home, "/Library/pnpm");
    add(home, "/.local/share/pnpm");
    for (const char* dir : {"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"}) dirs.push_back(dir);
    return dirs;
}
std::string HostedFindTool(const std::string& tool) {
    const auto os = DetectOs(); const bool windows = os == "windows";
    std::vector<std::string> dirs;
    const auto path = Env("PATH"); const char separator = windows ? ';' : ':';
    for (size_t start = 0; start <= path.size();) {
        auto end = path.find(separator, start); if (end == std::string::npos) end = path.size();
        auto dir = path.substr(start, end - start);
        if (dir.size() >= 2 && dir.front() == '"' && dir.back() == '"') dir = dir.substr(1, dir.size() - 2);
        if (!dir.empty()) dirs.push_back(dir);
        start = end + 1;
    }
    for (const auto& dir : HostedToolSearchDirs(os, Env)) dirs.push_back(dir);
    // nvm installs per Node version; a logon task's environment rarely has NVM_BIN.
    std::error_code error; const fs::path nvm = fs::path(Env("HOME")) / ".nvm" / "versions" / "node";
    if (!windows && !Env("HOME").empty() && fs::is_directory(nvm, error)) {
        std::vector<fs::path> versions;
        for (fs::directory_iterator it(nvm, error), end; !error && it != end; it.increment(error)) versions.push_back(it->path() / "bin");
        std::sort(versions.rbegin(), versions.rend());
        for (const auto& dir : versions) dirs.push_back(dir.string());
    }
    const bool hasExtension = fs::path(tool).has_extension();
    const std::vector<std::string> extensions = windows && !hasExtension ? std::vector<std::string>{".exe", ".cmd", ".bat"} : std::vector<std::string>{""};
    for (const auto& dir : dirs)
        for (const auto& extension : extensions) {
            const auto candidate = fs::path(dir) / (tool + extension);
            if (IsTool(candidate, windows)) return candidate.string();
        }
    return "";
}
std::vector<std::string> HostedApiKeyVars(const std::string& tool) {
    if (tool == "claude-code") return {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"};
    if (tool == "codex") return {"OPENAI_API_KEY", "CODEX_API_KEY"};
    return {};
}
std::string HostedNoBrowser(const std::string& os) { return os == "windows" ? "where.exe" : "true"; }
std::map<std::string, std::string> HostedCliQuietEnv(const std::string& os) {
    // No browser tab, no Git Credential Manager window, no SSH passphrase dialog: anything that would
    // need the owner answers on the page instead, or fails and says so.
    return {{"BROWSER", HostedNoBrowser(os)}, {"GIT_TERMINAL_PROMPT", "0"}, {"GCM_INTERACTIVE", "never"}, {"SSH_ASKPASS_REQUIRE", "never"}};
}
int HostedClaudeSignedIn(const std::string& statusOutput) {
    const auto start = statusOutput.find('{'), end = statusOutput.rfind('}');
    if (start == std::string::npos || end == std::string::npos || end < start) return -1;
    const auto status = Json::parse(statusOutput.substr(start, end - start + 1), nullptr, false);
    if (!status.is_object() || !status.contains("loggedIn") || !status["loggedIn"].is_boolean()) return -1;
    return status["loggedIn"].get<bool>() ? 1 : 0;
}
int HostedCodexSignedIn(const std::string& statusOutput, int exitCode) {
    const auto text = Lower(HostedPlainText(statusOutput));
    if (text.find("not logged in") != std::string::npos) return 0;
    if (exitCode == 0 && text.find("logged in") != std::string::npos) return 1;
    return -1;
}
std::vector<HostedInstallStep> HostedInstallPlan(const std::string& tool, const std::string& os, bool hasNpm, bool hasBrew) {
    // Anthropic's native installer puts Claude Code in the owner's home: no Node.js, no administrator.
    if (tool == "claude-code") {
        if (os == "windows") return {{"powershell", {"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"}}};
        return {{"bash", {"-c", "curl -fsSL https://claude.ai/install.sh | bash"}}};
    }
    if (tool == "codex") {
        if (hasNpm) return {{"npm", {"install", "--global", "@openai/codex@latest"}}};
        if (os == "mac" && hasBrew) return {{"brew", {"install", "--cask", "codex"}}};
    }
    return {};
}
HostedAiToolReport DetectHostedAiTools() {
    Json tools = Json::array(), installable = Json::array();
    const auto os = DetectOs(); const bool hasNpm = !HostedFindTool("npm").empty(), hasBrew = os == "mac" && !HostedFindTool("brew").empty();
    for (const std::string tool : {"claude-code", "codex"}) {
        const auto version = InstalledVersion(tool);
        if (version.empty()) { if (!HostedInstallPlan(tool, os, hasNpm, hasBrew).empty()) installable.push_back(tool); continue; }
        Json entry = {{"id", tool}, {"version", version}};
        if (const int signedIn = SignedIn(tool); signedIn >= 0) entry["signedIn"] = signedIn == 1;
        if (HasApiKey(tool)) entry["apiKey"] = true;
        tools.push_back(entry);
    }
    return {Dump(tools), Dump(installable)};
}
void RunHostedSetupTask(const HostedPostFn& post, const std::string& setupJson, const std::atomic<bool>& stop, std::shared_mutex& toolGate) {
    const auto setup = Json::parse(setupJson, nullptr, false);
    if (!setup.is_object() || !setup.contains("setupId") || !setup["setupId"].is_string() || !setup.contains("leaseToken") || !setup["leaseToken"].is_string() ||
        !setup.contains("tool") || !setup["tool"].is_string() || !setup.contains("action") || !setup["action"].is_string()) return;
    // Daily tool maintenance must not update these tools while they are being installed.
    std::shared_lock<std::shared_mutex> tools(toolGate, std::defer_lock);
    while (!stop && !tools.try_lock()) std::this_thread::sleep_for(std::chrono::milliseconds(200));
    if (stop) return;
    std::printf("Running a %s task for %s from the dashboard.\n", setup["action"].get<std::string>().c_str(), setup["tool"].get<std::string>().c_str()); std::fflush(stdout);
    SetupTask(post, setup, stop).Run();
}
}
