// HostedAiSession.cpp - dashboard chat turns run by the machine owner's own coding CLI.
#include "HostedAiSession.h"
#include "ToolMaintenance.h"
#include "HostedApproval.h"
#include "HostedCodexServer.h"
#include "HostedAgent.h"
#include "HostedPlatform.h"
#include "HostedRepoCache.h"
#include "HostedCrewRun.h"
#include "HostedCrewTurn.h"
#include "HostedToolSetup.h"
#include <SmithCore/Config.h>
#include <SmithCore/Process.h>
#include <json/single_include/nlohmann/json.hpp>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <deque>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <regex>
#include <set>
#include <sstream>
#include <thread>
namespace fs = std::filesystem;
namespace Smith {
namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
constexpr size_t kMaxEventBytes = 30000;   // the coordinator accepts 32 KiB per event
constexpr size_t kMaxBatchBytes = 48000;   // and 64 KiB per request
constexpr size_t kMaxCrewInputBytes = 400 * 1024;   // changes.md and changes.diff
constexpr size_t kMaxFinishReportBytes = 32 * 1024;   // the coordinator's limit for a crew finish's report
constexpr const char* kCrewUnsupported = "this agent does not support the requested crew settings";

void Clamp(Json& value, size_t maxString) {
    if (value.is_string()) {
        auto& text = value.get_ref<std::string&>();
        if (text.size() > maxString) { text.resize(maxString); text += "... [truncated by Smith]"; }
    } else if (value.is_array() || value.is_object()) for (auto& item : value) Clamp(item, maxString);
}
std::string Dump(const Json& value) { return value.dump(-1, ' ', false, Json::error_handler_t::replace); }
bool RepoUrlValid(const std::string& url) {
    if (url.empty() || url.size() > 512 || url.find_first_of(std::string("\r\n\t \0", 5)) != std::string::npos) return false;
    if (url.rfind("ssh://", 0) == 0 || url.rfind("git@", 0) == 0) return true;
    return url.rfind("https://", 0) == 0 && url.substr(8, url.find('/', 8) - 8).find('@') == std::string::npos;
}
void SleepUnless(const std::atomic<bool>& stop, int milliseconds) {
    for (int waited = 0; waited < milliseconds && !stop; waited += 100) std::this_thread::sleep_for(std::chrono::milliseconds(100));
}

class Turn {
public:
    Turn(const HostedPostFn& post, const fs::path& root, const std::atomic<bool>& shutdown, Json turn)
        : m_post(post), m_root(root), m_shutdown(shutdown), m_turn(std::move(turn)) {}
    void Run() {
        m_seq = m_turn.at("nextEventSeq").get<int64_t>();
        std::thread pump([this] { Pump(); });
        Json result = {{"status", "failed"}, {"message", "Turn failed"}, {"commit", nullptr}};
        try { result = Execute(); }
        catch (const std::exception& error) { Status(std::string("Smith could not run this turn: ") + error.what()); result["message"] = error.what(); }
        m_done = true; pump.join();
        if (m_lost) { std::printf("Chat turn %s was fenced; its result was not recorded.\n", TurnId().c_str()); return; }
        Redact(result);   // a crew run's report or error text is model output: it never carries the turn's secrets
        Finish(result);
    }
private:
    const HostedPostFn& m_post; fs::path m_root; const std::atomic<bool>& m_shutdown; Json m_turn;
    std::mutex m_queueMutex, m_processMutex; std::deque<Json> m_queue; Process* m_active = nullptr;
    std::atomic<bool> m_done{false}, m_lost{false}, m_stopRequested{false}; int64_t m_seq = 0;
    // Ask mode: the folder where Claude Code's questions and the dashboard's answers meet. The
    // question sets are only touched by the pump thread.
    std::mutex m_approvalMutex; fs::path m_approvalDir; std::set<std::string> m_asked, m_answered;

    std::string TurnId() const { return m_turn.at("turnId").get<std::string>(); }
    void Event(const char* kind, Json data) {
        // CLIs color their logs for a terminal; the dashboard shows plain text.
        if (data.is_string()) data = HostedPlainText(data.get<std::string>());
        Redact(data);
        std::lock_guard<std::mutex> lock(m_queueMutex); if (m_queue.size() < 5000) m_queue.push_back({{"kind", kind}, {"data", std::move(data)}});
    }
    void Status(const std::string& text) { Event("status", Redacted(text).substr(0, 2000)); }
    // A crew run's token, API key and repository tokens (Smith's git holds those, never the CLI), never relayed: set before the run starts a process, then replaced with
    // [redacted] in every string of an event, before anything is cut, so no part of one survives a clamp.
    std::vector<std::string> m_secrets;
    std::string Redacted(const std::string& text) const { return m_secrets.empty() ? text : HostedRedact(text, m_secrets); }
    void Redact(Json& value) const {
        if (m_secrets.empty()) return;
        if (value.is_string()) value = Redacted(value.get<std::string>());
        else if (value.is_array() || value.is_object()) for (auto& item : value) Redact(item);
    }
    void Kill() { std::lock_guard<std::mutex> lock(m_processMutex); if (m_active) m_active->Kill(); }
    // `jsonKind` names the event kind for a CLI's own JSON lines ("claude" or "codex"); null relays plain lines.
    // `env` adds to the scrubbed environment (Smith's own git calls pass a repository token this way;
    // the CLI never gets one). `resultLine` receives the last JSON line of type "result", as the CLI wrote it.
    int Run(std::vector<std::string> argv, const fs::path& cwd, int timeout, const std::string& stdinFile, const char* jsonKind,
            const std::map<std::string, std::string>& env = {}, const std::vector<std::string>& unset = {}, std::string* resultLine = nullptr) {
        Process process; ProcessOptions options; options.argv = std::move(argv); options.workingDir = cwd.string(); options.timeoutSeconds = timeout;
        options.stopWithParent = Orchestrated();
        options.stdinFile = stdinFile; options.envOverride = WithGitEnv(ScrubbedEnv(env)); options.envUnset = unset;
        auto onLine = [&](bool error, const std::string& raw) {
            const auto line = Redacted(raw);
            if (resultLine && jsonKind && !error) {
                const auto value = Json::parse(raw, nullptr, false);
                if (value.is_object() && value.contains("type") && value["type"] == "result") *resultLine = raw;
            }
            if (jsonKind && !error) {
                auto clamped = HostedClampJsonLine(line, 4000);
                if (!clamped.empty()) {
                    if (std::string(jsonKind) != "codex" || HostedCodexEventRelayed(clamped)) Event(jsonKind, Json::parse(clamped));
                    return;
                }
            }
            if (!line.empty()) Event(error ? "stderr" : "status", line.substr(0, 2000));
        };
        {
            std::lock_guard<std::mutex> lock(m_processMutex);
            if (m_lost || m_stopRequested || m_shutdown) return -1;
            if (!process.Start(options, onLine)) return -1;
            m_active = &process;
        }
        const int rc = process.Wait();
        std::lock_guard<std::mutex> lock(m_processMutex); m_active = nullptr; return rc;
    }
    // Keep deployment credentials out of agent-driven sessions; nothing here may publish. Nothing
    // here may open a window on the owner's screen either (a browser tab, a Git login dialog).
    static std::map<std::string, std::string> ScrubbedEnv(const std::map<std::string, std::string>& extra) {
        std::map<std::string, std::string> env = {{"CLOUDFLARE_API_TOKEN", ""}, {"CLOUDFLARE_API_KEY", ""}, {"CF_API_TOKEN", ""},
                                                  {"BUTLER_API_KEY", ""}, {"STEAM_PASSWORD", ""}, {"STEAM_TOTP_SECRET", ""}};
        for (const auto& [key, value] : HostedCliQuietEnv(DetectOs())) env[key] = value;
        for (const auto& [key, value] : extra) env[key] = value;
        return env;
    }
    // Codex in ask mode: a conversation with `codex app-server`, whose approval requests become
    // dashboard questions in the turn's approval folder (relayed by the pump like Claude Code's).
    int RunCodexServer(const fs::path& checkout, const std::map<std::string, std::string>& env, const std::vector<std::string>& unset, const std::string& prompt,
                       const std::string& resume, const std::string& model, const fs::path& approvalDir) {
        HostedCodexServerTurn turn; turn.argv = HostedToolArgv("codex", {"app-server"}); turn.cwd = checkout.string(); turn.env = ScrubbedEnv(env); turn.envUnset = unset;
        turn.prompt = prompt; turn.threadId = resume; turn.model = model; turn.approvalDir = approvalDir.string();
        HostedCodexServerIo io;
        io.event = [this](const std::string& json) { const auto clamped = HostedClampJsonLine(json, 4000); if (!clamped.empty()) Event("codex", Json::parse(clamped)); };
        io.stderrLine = [this](const std::string& line) { Event("stderr", line.substr(0, 2000)); };
        io.stopRequested = [this] { return m_lost || m_stopRequested || m_shutdown; };
        io.running = [this](Process* process) {
            std::lock_guard<std::mutex> lock(m_processMutex); m_active = process;
            if (process && (m_lost || m_stopRequested || m_shutdown)) process->Kill();
        };
        return RunHostedCodexServerTurn(turn, io);
    }
    // A command's stdout (cut a line past `limit` bytes), or "" when it fails; `env` adds to the environment. With
    // `exitCode`, what it printed comes back even when it fails or times out (-1), and the code says which.
    std::string Capture(std::vector<std::string> argv, const fs::path& cwd, const std::map<std::string, std::string>& env = {}, size_t limit = 65536, int* exitCode = nullptr) {
        Process process; ProcessOptions options; options.argv = std::move(argv); options.workingDir = cwd.string(); options.timeoutSeconds = 120;
        options.envOverride = WithGitEnv(env); options.envOverride["GIT_TERMINAL_PROMPT"] = "0";
        std::string out;
        const int rc = process.Run(options, [&](bool error, const std::string& line) { if (!error && out.size() < limit) out += line + "\n"; });
        if (exitCode) *exitCode = rc;
        return rc == 0 || exitCode ? out : "";
    }
    std::string Head(const fs::path& checkout, const std::string& ref = "HEAD") {
        auto head = Capture(Git({"rev-parse", "--verify", "-q", ref}), checkout);
        while (!head.empty() && (head.back() == '\n' || head.back() == '\r')) head.pop_back();
        return std::regex_match(head, std::regex("[a-f0-9]{40}")) ? head : "";
    }
    // Every git command Smith runs in the chat's copy goes through here (see HostedAiGitArgv).
    fs::path m_noHooks;
    std::vector<std::string> Git(const std::vector<std::string>& args) const { return HostedAiGitArgv(args, m_noHooks.string()); }
    // A crew turn's processes (Smith's git, and the CLI's) read the member's own gitconfig, never the owner's (HostedCrewGitEnv).
    std::map<std::string, std::string> m_gitEnv;
    std::map<std::string, std::string> WithGitEnv(std::map<std::string, std::string> env) const { for (const auto& [key, value] : m_gitEnv) env[key] = value; return env; }
    // The copy's .git/config as Smith left it. A CLI that may only edit files (every mode except
    // bypass / full access) has no business changing it, and a changed config could point Smith's
    // own git at another remote or a program, so Smith then stops using git in that copy.
    static std::string ReadText(const fs::path& path) { std::ifstream in(path, std::ios::binary); std::stringstream text; text << in.rdbuf(); return text.str(); }
    void SnapshotGitConfig(const fs::path& checkout, const fs::path& sessionDir) {
        HostedSecureWrite((sessionDir / "git-config.snapshot").string(), ReadText(checkout / ".git" / "config"));
    }
    // Without a snapshot, a chat from before this check is trusted on first use; a crew clone always has one, so for it
    // (`trustFirstUse` false) a missing snapshot means untrusted.
    bool GitConfigTrusted(const fs::path& checkout, const fs::path& sessionDir, bool trustFirstUse = true) {
        const auto snapshot = sessionDir / "git-config.snapshot";
        std::error_code missing;
        if (!fs::exists(snapshot, missing)) { if (!trustFirstUse) return false; SnapshotGitConfig(checkout, sessionDir); return true; }
        return fs::is_regular_file(checkout / ".git" / "config", missing) && ReadText(checkout / ".git" / "config") == ReadText(snapshot);
    }
    // A new copy of `url` at `checkout` (no working tree), cloned locally from this machine's shared store for the
    // repository (HostedRepoCache.h: one per repository, whichever workspaces, chats, crew members and builds use it),
    // so the copy hard-links the history instead of fetching and holding its own. `commit` (40 hex), when set, is
    // fetched into the store if the branches did not bring it; `branch` selects the copy's HEAD.
    void CloneFromStore(const std::string& url, const std::string& commit, const std::string& branch, const fs::path& checkout, const std::map<std::string, std::string>& gitEnv) {
        const HostedGitRunFn storeGit = [&](std::vector<std::string> argv, const fs::path& cwd, const std::map<std::string, std::string>& env,
                                            std::vector<std::string>* out, std::vector<std::string>* errors) {
            if (!out && !errors) return Run(std::move(argv), cwd, 1800, "", nullptr, env);
            int rc = 0; const auto text = Capture(std::move(argv), cwd, env, 65536, &rc);
            if (out) { std::istringstream lines(text); for (std::string line; std::getline(lines, line);) out->push_back(line); }
            return rc;
        };
        const auto store = HostedRepoCachePath(m_root, url);
        const auto lock = HostedLockRepoCache(store);
        if (!HostedUpdateRepoCache(store, url, std::regex_match(commit, std::regex("[a-f0-9]{40}")) ? commit : std::string(), gitEnv, storeGit, nullptr)) throw std::runtime_error("git fetch failed");
        if (!HostedCloneFromRepoCache(store, url, branch, checkout, storeGit, nullptr)) throw std::runtime_error("git clone failed");
    }
    static std::string Host(const std::string& url) {
        const auto scheme = url.find("://"); const auto start = scheme == std::string::npos ? url.find('@') + 1 : scheme + 3;
        const auto end = url.find_first_of(scheme == std::string::npos ? ":" : "/", start);
        return url.substr(start, end == std::string::npos ? std::string::npos : end - start);
    }
    // Pushes the chat's own branch, by explicit URL and refspec so nothing in the copy can redirect
    // or widen it, never forced. The machine's Git login does the rest, or (`withToken`) the token
    // Smith minted for its copy of the project. A crew run's branch (`crew`) is pushed the same way.
    Json Push(const fs::path& checkout, const fs::path& sessionDir, const std::string& url, const std::string& branch, const std::map<std::string, std::string>& gitEnv, bool crew = false, bool withToken = false) {
        if (!fs::exists(checkout / ".git")) throw std::runtime_error(crew ? "this computer has no copy of the crew member's project to push" : "this computer has no copy of the chat's project to push");
        if (!GitConfigTrusted(checkout, sessionDir, !crew))
            return {{"status", "failed"}, {"commit", nullptr}, {"message", crew ? "The crew member's copy has Git settings (.git/config) Smith did not leave there, so Smith will not push from it"
                                                                                : "The chat changed its copy's Git settings (.git/config), so Smith will not push from it"}};
        const auto sha = Head(checkout, "refs/heads/" + branch);
        if (sha.empty()) throw std::runtime_error(crew ? "the crew run's branch is missing from this computer's copy" : "the chat's branch is missing from this computer's copy");
        Status("Pushing " + branch + " (" + sha.substr(0, 12) + ") to " + Host(url) + " ...");
        const int rc = Run(Git({"push", "--no-verify", url, "refs/heads/" + branch + ":refs/heads/" + branch}), checkout, 900, "", nullptr, gitEnv);
        if (m_lost) return {};
        if (m_stopRequested || m_shutdown) return {{"status", "stopped"}, {"commit", nullptr}, {"message", "Stopped"}};
        if (rc != 0) return {{"status", "failed"}, {"commit", nullptr}, {"message", "git push failed (exit " + std::to_string(rc) + "); the output above says why. Pushing uses " +
                             (withToken ? "Smith's token for its copy of the project at " : "this computer's own Git login for ") + Host(url) + "."}};
        Status("Pushed " + branch + " at " + sha.substr(0, 12) + ".");
        return {{"status", "completed"}, {"commit", sha}, {"message", "Pushed " + branch + " to " + Host(url)}};
    }
    // Whether any line `git <args>` prints in the copy matches `hit`, read line by line so a large change is searched whole;
    // -1 when git fails.
    int ScanGit(const fs::path& checkout, const std::vector<std::string>& args, const std::function<bool(const std::string&)>& hit) {
        Process process; ProcessOptions options; options.argv = Git(args);
        options.workingDir = checkout.string(); options.timeoutSeconds = 600; options.envOverride = WithGitEnv({{"GIT_TERMINAL_PROMPT", "0"}});
        bool found = false;
        const int rc = process.Run(options, [&](bool error, const std::string& line) { if (!error && !found) found = hit(line); });
        return found ? 1 : rc == 0 ? 0 : -1;
    }
    // Stages everything in the copy and commits it, under a clearly labelled identity when this machine has no Git
    // identity configured. A turn that holds secrets first searches the staged change for them, and a crew turn
    // (`refuseGitlinks`) refuses a nested repository: such a change (or one git cannot show) is not committed, and the
    // reason comes back; "" otherwise.
    std::string CommitAll(const fs::path& checkout, const std::vector<std::string>& message, const std::string& labelName, const std::string& labelEmail, const std::string& failText,
                          bool refuseGitlinks = false) {
        Run(Git({"add", "-A"}), checkout, 600, "", nullptr);
        if (refuseGitlinks) {
            const int scan = ScanGit(checkout, {"diff", "--cached", "--raw", "--no-renames", "--no-color"}, HostedCrewGitlinkLine);
            if (scan != 0) return scan > 0 ? "the change contained a nested repository and was not committed" : "Smith could not list the change, so it was not committed";
            // A crew CLI can read files outside its checkout (Codex's sandbox confines writes, not reads): no key it found is committed.
            const int keys = ScanGit(checkout, {"diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--text"}, HostedCrewPrivateKeyLine);
            if (keys != 0) return keys > 0 ? "the change contained a private key and was not committed" : "Smith could not check the change for private keys, so it was not committed";
        }
        if (!m_secrets.empty()) {
            // No external diff or textconv program runs.
            const int scan = ScanGit(checkout, {"diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--text"}, [&](const std::string& line) { return HostedRedact(line, m_secrets) != line; });
            if (scan > 0) return "the change contained a secret and was not committed";
            if (scan < 0) return "Smith could not check the change for secrets, so it was not committed";
        }
        if (Run(Git(message), checkout, 600, "", nullptr) != 0) {
            auto labelled = message; labelled.insert(labelled.begin(), {"-c", "user.name=" + labelName, "-c", "user.email=" + labelEmail});
            if (Run(Git(labelled), checkout, 600, "", nullptr) != 0) Status(failText);
        }
        return "";
    }
    Json Execute() {
        if (m_turn.value("sessionKind", "chat") == "crew") return ExecuteCrew();
        const auto sessionId = m_turn.at("sessionId").get<std::string>();
        const auto& repo = m_turn.at("repo");
        const auto url = repo.at("url").get<std::string>(), commit = repo.at("commit").get<std::string>(), branch = repo.at("branch").get<std::string>();
        const auto prompt = m_turn.at("prompt").get<std::string>();
        const auto resume = m_turn.at("resume").is_string() ? m_turn.at("resume").get<std::string>() : std::string();
        // Each tool's own CLI, with the owner's own login on this machine.
        const auto tool = m_turn.value("tool", ""), mode = m_turn.at("permissionMode").get<std::string>();
        const bool codex = tool == "codex";
        const auto seqText = std::to_string(m_turn.at("seq").get<int64_t>());
        const bool ask = tool == "claude-code" && mode == "default", codexAsk = codex && mode == "untrusted";
        const auto approvalDir = m_root / "ai" / sessionId / ("approvals-" + seqText), approvalConfig = m_root / "ai" / sessionId / ("mcp-" + seqText + ".json");
        const auto kind = m_turn.value("kind", "message");
        // The model: the owner's own login, or a local Ollama model. A guest (another member using this
        // machine's shared models) only ever gets Ollama, in a mode that cannot leave its own copy.
        const auto brain = m_turn.value("brain", "");
        const auto model = m_turn.contains("model") && m_turn.at("model").is_string() ? m_turn.at("model").get<std::string>() : std::string();
        const bool guest = m_turn.value("shared", false), ollama = brain == "ollama";
        // With your own login Claude Code may be given a model of its own (Fable, Opus, Sonnet...); Codex uses its default.
        const bool loginModel = brain == "own-login" && !model.empty();
        const bool brainValid = (brain == "own-login" && !guest && (model.empty() || (tool == "claude-code" && HostedLoginModelValid(model)))) || (ollama && HostedOllamaModelValid(model) && (!guest || HostedGuestModeAllowed(tool, mode)));
        // The coordinator's note on where the CLI is: Claude Code gets it in its system prompt, Codex ahead of its first message.
        const auto briefing = HostedBriefing(m_turn.contains("briefing") && m_turn.at("briefing").is_string() ? m_turn.at("briefing").get<std::string>() : std::string());
        auto args = kind == "push" ? std::vector<std::string>{"push"} : codexAsk ? std::vector<std::string>{"app-server"} : codex ? HostedCodexArgs(mode, resume, ollama ? model : "")
                  : tool == "claude-code" ? HostedClaudeArgs(mode, resume, ask ? approvalConfig.string() : "", briefing) : std::vector<std::string>();
        if ((ollama || loginModel) && tool == "claude-code" && !args.empty()) { args.push_back("--model"); args.push_back(model); }
        const std::string name = codex ? "Codex" : "Claude Code";
        // A project hosted on Cloudflare Artifacts comes with a repository token for this turn only.
        const auto token = repo.contains("authToken") && repo.at("authToken").is_string() ? repo.at("authToken").get<std::string>() : std::string();
        if (!std::regex_match(sessionId, std::regex("[a-f0-9-]{36}")) || !RepoUrlValid(url) || !std::regex_match(commit, std::regex("[a-f0-9]{40}")) ||
            !HostedAiBranchValid(branch) || args.empty() || !brainValid || (codexAsk && !resume.empty() && !std::regex_match(resume, std::regex("[A-Za-z0-9][A-Za-z0-9-]{0,63}"))) || (kind != "message" && kind != "push") || (guest && kind != "message") ||
            (!token.empty() && (!HostedCredentialRemote(url) || token.size() > 512 || token.find_first_of("\r\n\t \"") != std::string::npos)))
            throw std::runtime_error("this agent does not support the requested session settings");
        const auto gitEnv = HostedGitAuthEnv(url, token);
        const auto aiRoot = m_root / "ai", sessionDir = aiRoot / sessionId, checkout = sessionDir / "repo";
        HostedSecureDirectory(aiRoot.string()); HostedSecureDirectory(sessionDir.string());
        m_noHooks = sessionDir / "no-hooks"; // never created: git finds no hooks there
        if (kind == "push") return Push(checkout, sessionDir, url, branch, gitEnv, false, !token.empty());
        if (!fs::exists(checkout / ".git")) {
            Status("Preparing a private copy of the project on " + branch + " ...");
            CloneFromStore(url, commit, "", checkout, gitEnv);
            if (Run(Git({"fetch", "origin", commit}), checkout, 1800, "", nullptr, gitEnv) != 0) throw std::runtime_error("fetching the pinned commit failed");
            if (Run(Git({"checkout", "-b", branch, commit}), checkout, 600, "", nullptr) != 0) throw std::runtime_error("creating the session branch failed");
            SnapshotGitConfig(checkout, sessionDir);
        } else Status("Continuing in this session's copy of the project (" + branch + ").");
        const bool fullAccess = mode == "bypassPermissions" || mode == "danger-full-access";
        if (!fullAccess && !GitConfigTrusted(checkout, sessionDir))
            throw std::runtime_error("the chat changed its copy's Git settings (.git/config) in an earlier reply, so Smith will not run Git in it; continue in a full-access mode or start a new chat");
        const auto before = Head(checkout);
        const auto promptFile = sessionDir / ("prompt-" + std::to_string(m_turn.at("seq").get<int64_t>()) + ".txt");
        HostedSecureWrite(promptFile.string(), codex ? HostedCodexPrompt(briefing, prompt, !resume.empty()) : prompt);
        std::error_code ignored;
        if (ask || codexAsk) {
            // The CLI's questions wait in this folder for the dashboard's answers.
            fs::remove_all(approvalDir, ignored); HostedSecureDirectory(approvalDir.string());
        }
        if (ask) {
            // Claude Code asks Smith's helper before acting; the helper waits for the dashboard's answer.
            std::string self;
            try { self = HostedExecutablePath(); }
            catch (const std::exception&) { throw std::runtime_error("ask mode is not available on this computer's platform yet; pick another permission mode"); }
            HostedSecureWrite(approvalConfig.string(), HostedApprovalMcpConfig(self, approvalDir.string()));
        }
        if (ask || codexAsk) { std::lock_guard<std::mutex> lock(m_approvalMutex); m_approvalDir = approvalDir; }
        std::map<std::string, std::string> cliEnv; std::vector<std::string> cliUnset;
        if (ollama) {
            // A guest's CLI keeps its state (and so its resumable conversation) in a config folder of its own.
            std::string guestConfig;
            if (guest) { const auto dir = sessionDir / ("guest-" + std::string(codex ? "codex" : "claude")); HostedSecureDirectory(dir.string()); guestConfig = dir.string(); }
            cliEnv = HostedOllamaEnv(tool, model, guestConfig); cliUnset = HostedOllamaEnvUnset(tool, guest);
        } else {
            // An API key in this machine's environment would quietly replace the owner's own login
            // (Claude Code then drops their claude.ai connectors, and bills the API account), so it
            // is only used when the owner ticked "use the API key" for this message.
            std::string keys;
            for (const auto& variable : HostedApiKeyVars(tool)) { const char* value = std::getenv(variable.c_str()); if (value && *value) keys += (keys.empty() ? "" : ", ") + variable; }
            if (m_turn.value("useApiKey", false)) { if (!keys.empty()) Status("Using the API key set on this machine (" + keys + ") instead of your " + name + " login."); }
            else { cliUnset = HostedApiKeyVars(tool); if (!keys.empty()) Status(keys + " is set on this machine but not used: " + name + " runs with your own login."); }
        }
        const auto with = ollama ? "the local Ollama model " + model : loginModel ? model + " (your login)" : std::string("your login");
        Status(resume.empty() ? "Starting " + name + " with " + with + " on this machine." : "Resuming the " + name + " conversation (" + with + ").");
        const int rc = codexAsk ? RunCodexServer(checkout, cliEnv, cliUnset, HostedCodexPrompt(briefing, prompt, !resume.empty()), resume, ollama ? model : "", approvalDir)
                                : Run(HostedToolArgv(codex ? "codex" : "claude", args), checkout, 6 * 3600, promptFile.string(), codex ? "codex" : "claude", cliEnv, cliUnset);
        fs::remove(promptFile, ignored);
        if (ask || codexAsk) { { std::lock_guard<std::mutex> lock(m_approvalMutex); m_approvalDir.clear(); } fs::remove(approvalConfig, ignored); fs::remove_all(approvalDir, ignored); }
        if (m_lost) return {};
        const bool stopped = m_stopRequested || m_shutdown;
        Json result = {{"status", stopped ? "stopped" : rc == 0 ? "completed" : "failed"}, {"commit", nullptr},
                       {"message", stopped ? "Stopped" : rc == 0 ? name + " finished" : name + " exited with code " + std::to_string(rc)}};
        // A CLI with full access was trusted with everything, including Git settings; otherwise Smith
        // only runs git in a copy whose settings are as it left them.
        if (fullAccess) SnapshotGitConfig(checkout, sessionDir);
        else if (!GitConfigTrusted(checkout, sessionDir)) {
            Status("The chat changed its copy's Git settings (.git/config), so Smith will not run Git in it. Its changes stay uncommitted on this computer.");
            result["status"] = "failed"; result["message"] = "Git settings in the chat's copy were changed";
            return result;
        }
        // Record the turn's work on the session branch, whatever its outcome, so nothing is lost.
        if (!Capture(Git({"status", "--porcelain"}), checkout).empty()) {
            const auto subject = prompt.substr(0, prompt.find('\n')).substr(0, 72);
            const std::vector<std::string> message = {"commit", "-q", "--no-verify", "-m", "Smith AI session: " + subject, "-m", "Session " + sessionId + ", message " + std::to_string(m_turn.at("seq").get<int64_t>()) + "."};
            CommitAll(checkout, message, "Smith AI session", "smith-ai@localhost", "The changes could not be committed; they remain in the session's copy.");
        }
        // Report a commit only when this turn moved the branch (by Smith's commit or the CLI's own).
        const auto head = Head(checkout);
        if (!head.empty() && head != before) {
            result["commit"] = head;
            const auto stat = Capture(Git({"diff", "--shortstat", before.empty() ? commit : before, head}), checkout);
            Status("Committed " + head.substr(0, 12) + " on " + branch + (stat.empty() ? "" : ":" + stat.substr(0, stat.find('\n'))));
        } else if (!stopped) Status("No file changes in this reply.");
        return result;
    }

    // ---- Crew runs (see HostedCrewRun.h): Claude Code unattended and restricted, on the member's persistent clone
    // (dirs.repo, never deleted here), with the run's files beside it; then a "push" turn in which Smith pushes the branch.
    static std::string Field(const Json& object, const char* key) { return object.is_object() && object.contains(key) && object[key].is_string() ? object[key].get<std::string>() : std::string(); }
    static bool RefValid(const std::string& ref) { return ref.empty() || (std::regex_match(ref, std::regex("[A-Za-z0-9][A-Za-z0-9/_.-]{0,255}")) && ref.find("..") == std::string::npos); }
    static bool TokenValid(const std::string& url, const std::string& token) {
        return token.empty() || (HostedCredentialRemote(url) && token.size() <= 512 && token.find_first_of("\r\n\t \"") == std::string::npos);
    }
    // Smith's git for the projects a run created (HostedCrewTurn.h), relayed and redacted like the rest of the turn.
    HostedCrewGitIo CrewGitIo() {
        using Env = std::map<std::string, std::string>; HostedCrewGitIo io;
        io.git = [this](const std::vector<std::string>& args, const std::string& cwd, const Env& env) { return Run(Git(args), cwd, 900, "", nullptr, env); };
        io.capture = [this](const std::vector<std::string>& args, const std::string& cwd, const Env& env) { return Capture(Git(args), cwd, env); };
        io.scan = [this](const std::vector<std::string>& args, const std::string& cwd) { return ScanGit(cwd, args, [this](const std::string& line) { return HostedRedact(line, m_secrets) != line; }); };
        io.status = [this](const std::string& text) { Status(text); }; io.stopped = [this] { return m_lost || m_stopRequested || m_shutdown; }; return io;
    }
    bool Orchestrated() const { return m_turn.contains("orchestration") && !m_turn["orchestration"].is_null(); }
    bool CrewReader() const { return Orchestrated() && m_turn["orchestration"]["mode"] == "read_only"; }
    void CheckOrchestration() const {
        if (!Orchestrated()) return;
        const auto& o = m_turn["orchestration"];
        const std::regex sha("[a-f0-9]{40}");
        if (!o.is_object() || o.value("version", 0) != 1 || Field(o, "eventId").empty() ||
            !std::regex_match(Field(o, "baseCommit"), sha) || !std::regex_match(Field(o, "headCommit"), sha) ||
            Field(o, "baseCommit") == std::string(40, '0') || Field(o, "headCommit") == std::string(40, '0') ||
            !o.contains("writeScopes") || !o["writeScopes"].is_array() || !o.contains("lease")) throw std::runtime_error("Invalid pinned crew orchestration claim");
        const bool reader = Field(o, "mode") == "read_only";
        if (!reader && Field(o, "mode") != "write") throw std::runtime_error("Invalid orchestration mode");
        if (Field(m_turn, "kind") == "message" && Field(m_turn, "permissionMode") != (reader ? "plan" : "acceptEdits")) throw std::runtime_error("Orchestration permission mismatch");
        if (reader) {
            if (!o["lease"].is_null() || !o["writeScopes"].empty() || Field(m_turn, "kind") == "push") throw std::runtime_error("Readers cannot hold write scopes or push");
        } else {
            if (o["writeScopes"].empty() || o["writeScopes"].size() > 32) throw std::runtime_error("Writer needs bounded directory scopes");
            for (const auto& scope : o["writeScopes"]) {
                if (!scope.is_string()) throw std::runtime_error("Invalid write scope");
                const auto prefix = scope.get<std::string>();
                if (!prefix.empty() && (prefix.back() != '/' || !HostedCrewScopeAllows({""}, prefix + "file"))) throw std::runtime_error("Invalid write scope");
            }
            const auto& lease = o["lease"];
            const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
            if (!lease.is_object() || Field(lease, "id").empty() || !lease.contains("generation") || !lease["generation"].is_number_integer() || lease["generation"].get<int64_t>() < 1 ||
                !lease.contains("expiresAt") || !lease["expiresAt"].is_number_integer() || lease["expiresAt"].get<int64_t>() <= now) throw std::runtime_error("Writer lease missing or expired");
        }
    }
    // Every path is examined before staging, including deletions and both rename endpoints (no-renames).
    void CheckCrewChanges(const std::string& repo) {
        if (!Orchestrated()) return;
        CheckOrchestration();
        if (!HostedCrewTreePlain(repo)) throw std::runtime_error("Crew checkout contains a link, junction or unreadable path");
        const auto head = Field(m_turn["orchestration"], "headCommit");
        if (Head(repo) != head && Field(m_turn, "kind") != "push") throw std::runtime_error("Crew changed its pinned HEAD");
        for (const auto& command : std::vector<std::vector<std::string>>{
                 {"diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", head, "--"},
                 {"diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", head, "--"},
                 {"ls-files", "--others", "-z"}}) {
            int rc = 0; auto paths = Capture(Git(command), repo, {}, 10 * 1024 * 1024 + 1, &rc);
            if (rc || paths.size() > 10 * 1024 * 1024) throw std::runtime_error("Complete changed path list unavailable");
            if (!paths.empty() && paths.back() == '\n') paths.pop_back();
            size_t begin = 0;
            while (begin < paths.size()) {
                const auto end = paths.find('\0', begin);
                if (end == std::string::npos) throw std::runtime_error("Invalid changed path list");
                const auto path = paths.substr(begin, end - begin); begin = end + 1;
                if (CrewReader() || !HostedCrewScopeAllows(m_turn["orchestration"]["writeScopes"].get<std::vector<std::string>>(), path)) throw std::runtime_error("Crew wrote outside its permitted scope");
            }
        }
    }
    Json ExecuteCrew() {
        CheckOrchestration();
        const auto repo = m_turn.value("repo", Json::object()), member = m_turn.value("member", Json::object());
        const auto sessionId = Field(m_turn, "sessionId"), kind = Field(m_turn, "kind"), memberId = Field(member, "id");
        const auto url = Field(repo, "url"), branch = Field(repo, "branch"), token = Field(repo, "authToken");
        const std::regex id("[a-f0-9-]{36}");
        if (!std::regex_match(sessionId, id) || !std::regex_match(memberId, id) || !RepoUrlValid(url) || !HostedAiBranchValid(branch) || branch.rfind("smith/crew-", 0) != 0 || !TokenValid(url, token))
            throw std::runtime_error(kCrewUnsupported);
        const auto dirs = HostedCrewDirsFor(m_root.string(), memberId, sessionId);
        const auto gitEnv = HostedGitAuthEnv(url, token);
        m_noHooks = fs::path(dirs.memberControl) / "no-hooks"; // never created: git finds no hooks there
        m_gitEnv = HostedCrewGitEnv(dirs);
        HostedCrewRemoveStaleRuns(dirs, sessionId);   // a failed or stopped run's files stay only until the member's next turn
        if (kind == "push") {
            if (Orchestrated()) {
                if (!GitConfigTrusted(dirs.repo, dirs.memberControl, false)) throw std::runtime_error("Untrusted Git settings");
                CheckCrewChanges(dirs.repo);
                if (Head(dirs.repo, branch) != Head(dirs.repo) || Run(Git({"merge-base", "--is-ancestor", Field(m_turn["orchestration"], "headCommit"), branch}), dirs.repo, 60, "", nullptr) != 0)
                    throw std::runtime_error("Push branch does not descend from the pinned checkout");
                if (!m_turn.value("createdProjects", Json::array()).empty()) throw std::runtime_error("Orchestrated runs cannot create projects");
            }
            // Smith's push, not the CLI's, so the brain plays no part. Smith's copy takes the token minted for this turn; a
            // GitHub project is pushed with this computer's own Git login, exactly as a chat's Push branch is. Each created
            // project goes to its own repository with its own token (HostedCrewTurn.h).
            size_t dropped = 0; const auto created = HostedCrewCreatedFromClaim(m_turn.value("createdProjects", Json::array()).dump(), dropped);
            m_secrets = {token}; for (const auto& p : created) m_secrets.push_back(p.authToken);
            Json result = {{"status", "completed"}, {"commit", nullptr}, {"message", "Nothing to push"}};
            if (m_turn.value("pushBranch", true)) {
                if (const auto refusal = HostedCrewPushRefusal(url, token); !refusal.empty()) throw std::runtime_error(refusal);
                result = Push(dirs.repo, dirs.memberControl, url, branch, gitEnv, true, !token.empty()); if (m_lost) return {};
            }
            if (dropped) Status("Left out " + std::to_string(dropped) + " new project(s) whose ID, address or token Smith does not accept.");
            if (!created.empty()) {
                const auto author = m_turn.value("author", Json::object()); Json pushed = Json::array();
                for (const auto& p : HostedCrewPushCreated(created, dirs, Field(author, "name"), Field(author, "slug"), sessionId, CrewGitIo())) pushed.push_back({{"id", p.id}, {"commit", p.commit}});
                if (m_lost) return {}; else result["createdProjects"] = pushed;
                if (!m_turn.value("pushBranch", true)) result["message"] = "Pushed " + std::to_string(pushed.size()) + " of " + std::to_string(created.size()) + " new projects";
                if (pushed.size() < created.size() && (m_stopRequested || m_shutdown)) { result["status"] = "stopped"; result["message"] = "Stopped"; }
            }
            if (std::error_code ignored; result["status"] == "completed") fs::remove_all(dirs.run, ignored);   // the run's new-project folders were kept for this push
            return result;
        }
        // A message turn: the run itself.
        const auto mcp = m_turn.value("mcp", Json::object()), budget = m_turn.value("budget", Json::object()), env = m_turn.value("env", Json::object());
        const auto brain = Field(m_turn, "brain"), model = Field(m_turn, "model"), projectBranch = Field(m_turn, "projectBranch"), runToken = Field(mcp, "token");
        // The CLI the coordinator resolved this run to (an older coordinator names none: Claude Code).
        const auto tool = m_turn.contains("tool") ? Field(m_turn, "tool") : std::string("claude-code");
        const bool codex = tool == "codex";
        const std::string toolName = codex ? "Codex" : "Claude Code";
        const auto name = Field(member, "name"), slug = Field(member, "slug"), skipIfCommit = Field(m_turn, "skipIfCommit"), changesSince = Field(m_turn, "changesSince");
        std::map<std::string, std::string> brainEnv; bool envValid = env.is_object();
        if (envValid) for (const auto& item : env.items()) { if (item.value().is_string()) brainEnv[item.key()] = item.value().get<std::string>(); else envValid = false; }
        const bool ollama = brain == "ollama", login = brain == "login", dryRun = m_turn.value("dryRun", false);
        m_secrets = {runToken, token}; for (const auto& entry : m_turn.value("related", Json::array())) m_secrets.push_back(Field(entry, "authToken"));
        const auto apiKey = brainEnv.find("ANTHROPIC_API_KEY");
        if (brain == "api-key" && apiKey != brainEnv.end()) m_secrets.push_back(apiKey->second);
        // A login run keeps the machine's sign-in; a token in its environment is never relayed either.
        if (const char* oauth = login ? std::getenv("CLAUDE_CODE_OAUTH_TOKEN") : nullptr; oauth && *oauth) m_secrets.push_back(oauth);
        const int64_t maxMinutes = budget.is_object() && budget.contains("maxMinutes") && budget["maxMinutes"].is_number_integer() ? budget["maxMinutes"].get<int64_t>() : 0;
        HostedCrewArgs cli; cli.mode = Field(m_turn, "permissionMode"); cli.schemaInline = Field(m_turn, "schema"); cli.runControlDir = dirs.runControl; cli.inputDir = dirs.input;
        cli.newProjectDir = dirs.newProject; cli.model = model; cli.usdPerRun = budget.is_object() && budget.contains("usdPerRun") && budget["usdPerRun"].is_number() ? budget["usdPerRun"].get<double>() : 0;
        // Codex reads its schema from a file and writes its last message (the report) to one; neither is under the checkout.
        // Check-in orchestrated writers rely on Claude Code's permission prompts for their write scope, so they never run in Codex.
        const auto schemaFile = (fs::path(dirs.runControl) / "schema.json").string(), lastMessageFile = (fs::path(dirs.runControl) / "last-message.json").string();
        auto args = codex ? (HostedCrewSchemaValid(cli.schemaInline) && !Orchestrated() ? HostedCrewCodexArgs(cli, schemaFile, lastMessageFile, Field(mcp, "url")) : std::vector<std::string>()) : HostedCrewClaudeArgs(cli);
        if (!codex && Orchestrated() && !CrewReader()) for (size_t i = 0; i + 1 < args.size(); ++i) if (args[i] == "--permission-mode") args[i + 1] = "default";
        const std::regex sha("[a-f0-9]{40}");
        // The name lands in --author: no control character, DEL or angle bracket.
        const bool nameValid = !name.empty() && name.size() <= 100 && std::none_of(name.begin(), name.end(), [](char c) { return static_cast<unsigned char>(c) < 0x20 || c == 0x7f || c == '<' || c == '>'; });
        if (kind != "message" || (tool != "claude-code" && !codex) || (codex && brain == "api-key") ||
            (brain != "api-key" && !(login && model.empty()) && !(ollama && HostedOllamaModelValid(model))) || !envValid || Field(mcp, "url").rfind("https://", 0) != 0 || runToken.empty() ||
            maxMinutes < 1 || maxMinutes > 180 || args.empty() || !RefValid(projectBranch) || !std::regex_match(slug, std::regex("[a-z0-9][a-z0-9-]{0,31}")) || !nameValid ||
            !(skipIfCommit.empty() || std::regex_match(skipIfCommit, sha)) || !(changesSince.empty() || std::regex_match(changesSince, sha)))
            throw std::runtime_error(kCrewUnsupported);
        if (!HostedCrewPathsIsolated(dirs)) throw std::runtime_error("the crew run's folders are not kept apart from its checkout and control files");
        std::error_code ignored; fs::remove_all(dirs.run, ignored);   // a replayed claim prepares its run's files afresh
        for (const auto& dir : {(m_root / "ai").string(), fs::path(dirs.memberRoot).parent_path().string(), dirs.memberRoot, dirs.memberControl, fs::path(dirs.run).parent_path().string(),
                                dirs.run, dirs.input, dirs.related, dirs.newProject, dirs.runControl, dirs.claudeConfig, dirs.codexHome}) HostedSecureDirectory(dir);
        if (!fs::exists(dirs.gitconfig, ignored)) HostedSecureWrite(dirs.gitconfig, "");
        // Nothing new since the member last looked: done without touching the clone or starting the CLI.
        const auto tipRef = projectBranch.empty() ? std::string("HEAD") : "refs/heads/" + projectBranch;
        const auto tip = Orchestrated() ? Field(m_turn["orchestration"], "headCommit") : HostedCrewRemoteSha(Capture({"git", "ls-remote", url, tipRef}, dirs.memberRoot, gitEnv), tipRef);
        if (!Orchestrated() && HostedCrewSkip(tip, skipIfCommit)) {
            Status("No new commits since " + tip.substr(0, 12) + "; skipped.");
            fs::remove_all(dirs.run, ignored);
            return {{"status", "completed"}, {"message", "skipped"}, {"commit", nullptr}, {"baseCommit", tip}, {"report", {{"summary", "No new commits"}, {"findings", Json::array()}, {"skipped", true}}}};
        }
        // A Stop while git prepares the copy ends the run as stopped, not as a failed clone or fetch.
        const Json stopped = {{"status", "stopped"}, {"commit", nullptr}, {"message", "Stopped"}};
        std::string base;
        try { base = CrewCheckout(dirs, url, Orchestrated() ? tip : tipRef, branch, gitEnv); CrewRelatedClones(m_turn.value("related", Json::array()), dirs.related); }
        catch (const std::exception&) { if (m_stopRequested || m_shutdown) return stopped; throw; }
        if (m_stopRequested || m_shutdown) return stopped;
        if (Orchestrated()) {
            const auto previous = Field(m_turn["orchestration"], "baseCommit");
            if (base != tip) throw std::runtime_error("Pinned head unavailable");
            if (Head(dirs.repo, previous + "^{commit}") != previous && Run(Git({"fetch", "-q", url, previous}), dirs.repo, 60, "", nullptr, gitEnv) != 0) throw std::runtime_error("Pinned base unavailable");
            if (Head(dirs.repo, previous + "^{commit}") != previous) throw std::runtime_error("Pinned base unavailable");
            CheckCrewChanges(dirs.repo);
        }
        CrewInputs(dirs, Orchestrated() ? Field(m_turn["orchestration"], "baseCommit") : changesSince, !Orchestrated() && member.value("mayCreateProjects", false), Field(mcp, "url"));
        if (dryRun) {
            Status("Dry run: the inputs are prepared; " + toolName + " is not started.");
            fs::remove_all(dirs.run, ignored);
            return {{"status", "completed"}, {"message", "dry run"}, {"commit", nullptr}, {"baseCommit", base}, {"report", {{"summary", "Dry run: inputs prepared; no CLI run"}, {"findings", Json::array()}}}};
        }
        const auto cliEnv = HostedCrewEnv(brain, ollama && !codex ? HostedOllamaEnv("claude-code", model, "") : brainEnv, dirs.claudeConfig, runToken, tool, dirs.codexHome);
        Status("Starting " + toolName + " for " + name + " with " + (ollama ? "the local Ollama model " + model : login ? "this machine's " + toolName + " sign-in" : std::string("the workspace's Anthropic API key")) +
               ", for up to " + std::to_string(maxMinutes) + " minutes.");
        int cliSeconds = static_cast<int>(maxMinutes) * 60;
        if (Orchestrated() && !CrewReader()) {
            const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
            const auto remaining = (m_turn["orchestration"]["lease"]["expiresAt"].get<int64_t>() - now) / 1000;
            if (remaining < 1) throw std::runtime_error("Writer lease expired before CLI start");
            cliSeconds = static_cast<int>(std::min<int64_t>(cliSeconds, remaining));
        }
        std::string resultLine, promptFile = (fs::path(dirs.runControl) / "prompt.txt").string();
        if (codex) {
            // Codex has no system-prompt option: the system text leads its stdin, and the schema goes to a file.
            HostedSecureWrite(schemaFile, cli.schemaInline);
            promptFile = (fs::path(dirs.runControl) / "codex-prompt.txt").string();
            HostedSecureWrite(promptFile, Field(m_turn, "systemPrompt") + "\n\n---\n\n" + Field(m_turn, "prompt"));
        }
        const int rc = Run(HostedToolArgv(codex ? "codex" : "claude", args), dirs.repo, cliSeconds, promptFile, codex ? "codex" : "claude", cliEnv, HostedCrewEnvUnset(brain, tool), &resultLine); if (m_lost) return {};
        std::string reportText;
        if (codex) { std::ifstream in(lastMessageFile, std::ios::binary); std::stringstream text; if (in.is_open()) text << in.rdbuf(); reportText = HostedCrewExtractCodexReport(text.str()); }
        else reportText = HostedCrewExtractReport(resultLine);
        auto result = CrewResult(dirs, rc, base, branch, name, slug, sessionId, codex ? std::string() : resultLine, reportText, tool);
        // The projects it created: the new-project/<id> folders the push turn pushes, so a completed run's folder stays until then.
        std::vector<std::string> refused; const auto created = !Orchestrated() && member.value("mayCreateProjects", false) ? HostedCrewNewProjectIds(dirs.newProject, refused, m_secrets) : std::vector<std::string>();
        for (const auto& entry : refused) Status("Smith will not push new-project/" + Redacted(entry).substr(0, 64) + ": a new project is a folder named by its ID (see crew_create_project) holding only plain files and folders, without .git, links or any of the run's secrets (at most five).");
        if (!created.empty()) { result["createdProjects"] = Json::array(); for (const auto& projectId : created) result["createdProjects"].push_back({{"id", projectId}}); }
        if (result["status"] == "completed" && created.empty()) fs::remove_all(dirs.run, ignored);
        return result;
    }
    // The member's clone on a fresh run branch at the project branch's tip (`fetchRef`), returning that commit. A clone whose
    // Git settings are not as Smith left them is replaced; one pointing elsewhere (the member's project changed) is re-pointed.
    std::string CrewCheckout(const HostedCrewDirs& dirs, const std::string& url, const std::string& fetchRef, const std::string& branch, const std::map<std::string, std::string>& gitEnv) {
        const fs::path repo = dirs.repo; std::error_code ignored;
        if (Orchestrated() && fs::exists(repo) && !HostedCrewTreePlain(dirs.repo)) {
            // Do not ask Git clean or a recursive delete to walk an untrusted junction.
            fs::rename(repo, fs::path(dirs.memberRoot) / ("quarantine-" + Field(m_turn, "sessionId")), ignored);
            if (ignored) throw std::runtime_error("Unsafe prior checkout requires manual cleanup");
            Status("Quarantined a checkout containing links; preparing a fresh pinned copy.");
        }
        if (fs::exists(repo / ".git") && !GitConfigTrusted(repo, dirs.memberControl, false)) {
            Status("The crew member's copy has Git settings Smith did not leave there; starting again from a fresh copy.");
            fs::remove_all(repo, ignored);
            if (fs::exists(repo, ignored)) throw std::runtime_error("Smith could not remove the crew member's copy, whose Git settings it no longer trusts");
        }
        if (!fs::exists(repo / ".git")) {
            fs::remove_all(repo, ignored);
            Status("Preparing the crew member's copy of the project ...");
            CloneFromStore(url, Orchestrated() ? fetchRef : std::string(), "", repo, gitEnv);
            SnapshotGitConfig(repo, dirs.memberControl);
        } else {
            auto origin = Capture(Git({"config", "--get", "remote.origin.url"}), repo);
            while (!origin.empty() && (origin.back() == '\n' || origin.back() == '\r')) origin.pop_back();
            if (origin != url) {
                Status("The project's address changed; pointing the crew member's copy at " + Host(url) + ".");
                if (Run(Git({"remote", "set-url", "origin", url}), repo, 120, "", nullptr) != 0) throw std::runtime_error("pointing the crew member's copy at the project failed");
                SnapshotGitConfig(repo, dirs.memberControl);
            }
            // -ff: a nested repository an earlier run left (a stopped run's sub/.git) goes too, or it would be staged as a gitlink.
            for (const auto& step : std::vector<std::vector<std::string>>{{"reset", "-q", "--hard"}, {"clean", "-q", "-ffdx"}})
                if (Run(Git(step), repo, 600, "", nullptr) != 0) throw std::runtime_error("resetting the crew member's copy failed");
        }
        if ((!Orchestrated() || Head(repo, fetchRef + "^{commit}") != fetchRef) &&
            Run(Git({"fetch", "-q", url, fetchRef}), repo, 1800, "", nullptr, gitEnv) != 0) throw std::runtime_error("fetching the project's branch failed");
        if (Run(Git({"checkout", "-q", "-B", branch, Orchestrated() ? fetchRef : "FETCH_HEAD"}), repo, 600, "", nullptr) != 0) throw std::runtime_error("creating the run branch failed");
        const auto base = Head(repo);
        if (base.empty()) throw std::runtime_error("the crew member's copy has no commit to start from");
        return base;
    }
    // Related projects, read-only beside the checkout, at their commit (or their branch's tip), without instruction files.
    // A project Smith cannot clone is reported and left out: the run goes on without it.
    void CrewRelatedClones(const Json& related, const fs::path& into) {
        if (!related.is_array()) return;
        const std::regex projectId("[a-z0-9][a-z0-9-]{0,63}"), sha("[a-f0-9]{40}");
        for (const auto& entry : related) {
            const auto id = Field(entry, "projectId"), url = Field(entry, "url"), commit = Field(entry, "commit"), branch = Field(entry, "branch"), token = Field(entry, "authToken");
            if (!std::regex_match(id, projectId) || !RepoUrlValid(url) || !(commit.empty() || std::regex_match(commit, sha)) || !RefValid(branch) || !TokenValid(url, token)) {
                Status("Left out a related project whose ID, address, commit or branch Smith does not accept."); continue;
            }
            const auto dir = into / id; const auto env = HostedGitAuthEnv(url, token); std::error_code ignored;
            // From the machine's shared store, like the member's own copy, so a run's related projects cost only their files.
            bool cloned = true;
            try { CloneFromStore(url, commit, commit.empty() ? branch : std::string(), dir, env); } catch (const std::exception&) { cloned = false; }
            // A pinned commit the clone already holds is not fetched: a server may refuse to send one it does not advertise.
            cloned = cloned && (commit.empty() || !Head(dir, commit + "^{commit}").empty() || Run(Git({"fetch", "-q", "origin", commit}), dir, 1800, "", nullptr, env) == 0) &&
                     Run(Git({"checkout", "-q", "--detach", commit.empty() ? std::string("HEAD") : commit}), dir, 600, "", nullptr) == 0;
            if (!cloned) { fs::remove_all(dir, ignored); Status("Could not clone the related project " + id + "; this run goes on without it."); continue; }
            HostedCrewStripInstructionFiles(dir.string());
        }
    }
    // The run's read-only inputs and its control files; prompt.txt is also the CLI's stdin.
    void CrewInputs(const HostedCrewDirs& dirs, const std::string& changesSince, bool mayCreateProjects, const std::string& mcpUrl) {
        const fs::path input = dirs.input, control = dirs.runControl;
        HostedSecureWrite((input / "memory.md").string(), Field(m_turn, "memory"));
        std::string inbox; const auto messages = m_turn.value("inbox", Json::array());
        if (messages.is_array()) for (const auto& message : messages) {
            auto from = Field(message, "from").substr(0, 64); std::replace_if(from.begin(), from.end(), [](char c) { return static_cast<unsigned char>(c) < 0x20; }, ' ');
            const auto seq = message.is_object() && message.contains("seq") && message["seq"].is_number_integer() ? std::to_string(message["seq"].get<int64_t>()) : std::string("?");
            std::string quoted = "> "; for (const char c : Field(message, "body")) { quoted += c; if (c == '\n') quoted += "> "; }
            inbox += "From " + (from.empty() ? std::string("unknown") : from) + " (message " + seq + ", untrusted):\n" + quoted + "\n\n";
        }
        HostedSecureWrite((input / "inbox.md").string(), inbox.empty() ? "No messages.\n" : inbox);
        // The commits since the member's last run, or the latest 20 when it has none (or no longer knows that commit).
        const bool since = !changesSince.empty() && !Head(dirs.repo, changesSince + "^{commit}").empty();
        const auto log = since ? Git({"log", "--stat", changesSince + "..HEAD"}) : Git({"log", "--stat", "-20"});
        const auto diff = since ? Git({"diff", "--no-ext-diff", "--no-textconv", changesSince + "..HEAD"}) : Git({"log", "-p", "-20"});
        // One byte past the cap is read, so output that reaches it is marked as cut; a failed command keeps what it printed and says so.
        const auto capped = [&](const std::vector<std::string>& argv, const std::string& what) {
            int rc = 0; const auto text = HostedCrewCapText(Capture(argv, dirs.repo, {}, kMaxCrewInputBytes + 1, &rc), kMaxCrewInputBytes);
            return rc == 0 ? text : text + "(" + what + " unavailable: " + (rc < 0 ? std::string("git timed out or could not start") : "git exited with code " + std::to_string(rc)) + ")\n";
        };
        HostedSecureWrite((input / "changes.md").string(), capped(log, "the commit list"));
        HostedSecureWrite((input / "changes.diff").string(), capped(diff, "the diff"));
        if (const auto woke = m_turn.value("buildLog", Json::object()); !HostedCrewBuildLogName(Field(woke, "jobId")).empty())   // the build that woke a build-finished run
            HostedSecureWrite((input / HostedCrewBuildLogName(Field(woke, "jobId"))).string(), Field(woke, "text"));
        HostedSecureWrite((control / "system.txt").string(), Field(m_turn, "systemPrompt"));
        HostedSecureWrite((control / "prompt.txt").string(), Field(m_turn, "prompt"));
        auto settings = HostedCrewSettingsJson(mayCreateProjects, dirs.input, dirs.repo);
        if (Orchestrated()) settings = HostedCrewScopedSettings(settings, dirs.repo, m_turn["orchestration"]["writeScopes"].get<std::vector<std::string>>(), CrewReader());
        HostedSecureWrite((control / "settings.json").string(), settings);
        HostedSecureWrite((control / "mcp.json").string(), HostedCrewMcpConfigJson(mcpUrl));
    }
    // After the CLI: its report and cost from the final result event, Smith's commit of its changes, and the files changed with
    // their counts (sent after the CLI only, so the coordinator knows it ran). The finish stays within what the coordinator takes:
    // files at most 500 paths of up to 512 bytes and 24 KiB serialised, the report at most 32 KiB, the request at most 64 KiB (48 KB here).
    // `resultLine` is Claude Code's final result event ("" for Codex, which reports no cost); `reportText` the report either CLI gave.
    Json CrewResult(const HostedCrewDirs& dirs, int rc, const std::string& base, const std::string& branch, const std::string& name, const std::string& slug,
                    const std::string& sessionId, const std::string& resultLine, const std::string& reportText, const std::string& tool) {
        const bool stopped = m_stopRequested || m_shutdown;
        const std::string toolName = tool == "codex" ? "Codex" : "Claude Code";
        const auto event = Json::parse(resultLine, nullptr, false), report = Json::parse(reportText, nullptr, false);
        // The result event can report an error (a limit reached, the API failing) though the CLI exits 0.
        const bool cliError = event.is_object() && event.contains("is_error") && event["is_error"] == true;
        std::string detail = Field(event, "result"); if (detail.empty()) detail = Field(event, "error"); if (detail.empty()) detail = Field(event, "subtype");
        Json result = {{"status", stopped ? "stopped" : rc == 0 && !cliError ? "completed" : "failed"}, {"commit", nullptr}, {"baseCommit", base}, {"files", Json::array()}, {"filesTotal", 0}, {"filesTruncated", false},
                       {"message", stopped ? "Stopped" : cliError ? toolName + " reported an error: " + (detail.empty() ? std::string("no detail given") : Redacted(detail).substr(0, 2000))
                                                       : rc == 0 ? toolName + " finished" : toolName + " exited with code " + std::to_string(rc)}};
        if (event.is_object() && event.contains("total_cost_usd") && event["total_cost_usd"].is_number() && event["total_cost_usd"].get<double>() >= 0) result["costUsd"] = event["total_cost_usd"];
        if (report.is_object()) result["report"] = report;
        // Measured as it is sent: a report over the coordinator's limit, or one that would take the finish past 48 KB, is left out.
        const auto fitted = [&] {
            Redact(result);
            if (result.contains("report") && (Dump(result["report"]).size() > kMaxFinishReportBytes || Dump(result).size() > kMaxBatchBytes)) {
                result.erase("report");
                result["message"] = result["message"].get<std::string>() + " (its report was too large to send)";
                Status("The run's report is too large for Smith to send, so the run is recorded without one.");
            }
            return result;
        };
        if (!GitConfigTrusted(dirs.repo, dirs.memberControl, false)) {
            Status("The run changed the Git settings (.git/config) of the crew member's copy, so Smith will not run Git in it; its next run starts from a fresh copy.");
            result["status"] = "failed"; result["message"] = "Git settings in the crew member's copy were changed";
            return fitted();
        }
        try { CheckCrewChanges(dirs.repo); }
        catch (const std::exception& error) { result["status"] = "failed"; result["message"] = error.what(); return fitted(); }
        if (CrewReader() || (Orchestrated() && result["status"] != "completed")) return fitted();
        std::string refused;
        if (!Capture(Git({"status", "--porcelain"}), dirs.repo).empty()) {
            // The subject: the report's proposal title, or the prompt's first line that is not a heading. The author stays the member.
            auto subject = report.is_object() && report.contains("proposal") ? Field(report["proposal"], "title") : std::string();
            std::stringstream prompt(Field(m_turn, "prompt"));
            for (std::string line; subject.empty() && std::getline(prompt, line);) if (!line.empty() && line[0] != '#') subject = line;
            refused = CommitAll(dirs.repo, HostedCrewCommitArgv(name, slug, Redacted(subject.substr(0, subject.find('\n'))), sessionId, tool), "Smith crew", "smith-crew@localhost",
                                "The changes could not be committed; the crew member's next run discards them.", true);
            if (!refused.empty()) { Status("Smith did not commit this run's changes: " + refused + "."); result["status"] = "failed"; result["message"] = refused; }
        }
        // A Stop while Smith commits (its secret scan is not the active process) still ends the run as stopped.
        if (result["status"] == "completed" && (m_stopRequested || m_shutdown)) { result["status"] = "stopped"; result["message"] = "Stopped"; }
        const auto head = Head(dirs.repo);
        if (!head.empty() && head != base) {
            result["commit"] = head;
            auto names = Capture(Git({"diff", "--name-only", "-z", base + ".." + head}), dirs.repo);   // -z: paths as they are, never quoted
            if (!names.empty() && names.back() == '\n') names.pop_back();                                // the line end Capture adds
            size_t total = 0; result["files"] = HostedCrewFinishFiles(names, total); result["filesTotal"] = total; result["filesTruncated"] = result["files"].size() < total;
            if (result["files"].size() < total) result["message"] = result["message"].get<std::string>() + " (" + std::to_string(result["files"].size()) + " of " + std::to_string(total) + " changed files listed, so Verify is off)";
            Status("Committed " + head.substr(0, 12) + " on " + branch + " (" + std::to_string(total) + " files).");
        } else if (result["status"] != "stopped" && refused.empty()) Status("No file changes in this run.");
        return fitted();
    }
    void Pump() {
        auto lastSent = Clock::now(), lastAccepted = Clock::now();
        for (;;) {
            CollectQuestions();
            Json batch = Json::array(); size_t bytes = 0, count = 0;
            {
                std::lock_guard<std::mutex> lock(m_queueMutex);
                for (const auto& event : m_queue) {
                    const auto size = Dump(event).size();
                    if (count >= 32 || bytes + size > kMaxBatchBytes) break;
                    batch.push_back(event); bytes += size; ++count;
                }
            }
            const bool idle = batch.empty();
            if (idle && m_done) return;
            // Empty batches double as the lease heartbeat while the CLI is quiet, and are how a
            // Stop pressed in the dashboard reaches this machine, so keep them frequent.
            // While Claude Code waits for an answer, check for it every second.
            const auto heartbeat = m_asked.size() > m_answered.size() ? std::chrono::seconds(1) : std::chrono::seconds(3);
            if (!idle || Clock::now() - lastSent > heartbeat) {
                Json body = {{"turnId", TurnId()}, {"leaseToken", m_turn.at("leaseToken")}, {"seq", m_seq}, {"events", batch}};
                std::string response; const int status = m_post("/ai/events", Dump(body), response); lastSent = Clock::now();
                if (status >= 200 && status < 300) {
                    lastAccepted = Clock::now();
                    const auto reply = Json::parse(response, nullptr, false);
                    { std::lock_guard<std::mutex> lock(m_queueMutex); for (size_t i = 0; i < count && !m_queue.empty(); ++i) m_queue.pop_front(); }
                    m_seq += (int64_t)count;
                    if (reply.is_object() && reply.value("stop", false) && !m_stopRequested) { m_stopRequested = true; Kill(); }
                    if (reply.is_object() && reply.contains("answers") && reply["answers"].is_array()) DeliverAnswers(reply["answers"]);
                } else if (status == 401 || status == 403 || status == 409) { m_lost = true; Kill(); return; }
                else if (status == 413) { std::lock_guard<std::mutex> lock(m_queueMutex); m_queue.clear(); m_stopRequested = true; Kill(); }
                else if (status == 400) { std::lock_guard<std::mutex> lock(m_queueMutex); if (!m_queue.empty()) m_queue.pop_front(); } // drop an event the coordinator refuses
            }
            if (m_shutdown && !m_stopRequested) { m_stopRequested = true; Kill(); }
            // Without an accepted report the lease lapses after 90 seconds; stop before that.
            if (Clock::now() - lastAccepted > std::chrono::seconds(75)) { m_lost = true; Kill(); return; }
            std::this_thread::sleep_for(std::chrono::milliseconds(idle ? 500 : 150));
        }
    }
    fs::path ApprovalDir() { std::lock_guard<std::mutex> lock(m_approvalMutex); return m_approvalDir; }
    // Relays each new question Claude Code asked the approval helper to the dashboard.
    void CollectQuestions() {
        const auto dir = ApprovalDir(); if (dir.empty()) return;
        const std::string suffix = ".request.json";
        std::error_code error;
        for (fs::directory_iterator it(dir, error), end; !error && it != end; it.increment(error)) {
            const auto name = it->path().filename().string();
            if (name.size() <= suffix.size() || name.compare(name.size() - suffix.size(), suffix.size(), suffix) != 0) continue;
            const auto id = name.substr(0, name.size() - suffix.size());
            if (!HostedApprovalIdValid(id) || m_asked.count(id)) continue;
            std::ifstream in(it->path(), std::ios::binary); std::stringstream text; text << in.rdbuf();
            const auto request = Json::parse(text.str(), nullptr, false);
            if (!request.is_object() || !request.contains("tool") || !request["tool"].is_string()) continue;
            m_asked.insert(id);
            // The dashboard shows the request; long inputs (a whole file for Write) are shortened for display only.
            const auto shown = HostedClampJsonLine(Dump({{"id", id}, {"tool", request["tool"]}, {"input", request.value("input", Json::object())}}), 2000);
            Event("approval", shown.empty() ? Json{{"id", id}, {"tool", request["tool"]}, {"input", Json::object()}} : Json::parse(shown));
        }
    }
    // Hands the dashboard's answers to the waiting approval helper.
    void DeliverAnswers(const Json& answers) {
        const auto dir = ApprovalDir(); if (dir.empty()) return;
        for (const auto& answer : answers) {
            if (!answer.is_object() || !answer.contains("id") || !answer["id"].is_string() || !answer.contains("behavior") || !answer["behavior"].is_string()) continue;
            const auto id = answer["id"].get<std::string>(), behavior = answer["behavior"].get<std::string>();
            if (!m_asked.count(id) || m_answered.count(id) || (behavior != "allow" && behavior != "deny")) continue;
            const auto message = answer.contains("message") && answer["message"].is_string() ? answer["message"].get<std::string>() : std::string();
            try { HostedSecureWrite((dir / (id + ".response.json")).string(), Dump({{"behavior", behavior}, {"message", message}})); m_answered.insert(id); }
            catch (const std::exception&) {} // the next report carries the answer again
        }
    }
    void Finish(const Json& result) {
        Json body = {{"turnId", TurnId()}, {"leaseToken", m_turn.at("leaseToken")}, {"result", result}};
        for (int attempt = 0; attempt < 6; ++attempt) {
            std::string response; const int status = m_post("/ai/finish", Dump(body), response);
            if ((status >= 200 && status < 300) || status == 409 || status == 401 || status == 403) return;
            std::this_thread::sleep_for(std::chrono::seconds(2));
        }
        std::printf("Chat turn %s could not report its result; the dashboard will mark it lost.\n", TurnId().c_str());
    }
};
}

std::vector<std::string> HostedClaudeArgs(const std::string& permissionMode, const std::string& resumeId, const std::string& approvalConfig, const std::string& briefing) {
    const bool ask = permissionMode == "default";
    if (permissionMode != "plan" && permissionMode != "acceptEdits" && permissionMode != "bypassPermissions" && !ask) return {};
    if (ask == approvalConfig.empty()) return {}; // ask mode, and only ask mode, has somewhere to ask
    if (!resumeId.empty() && !std::regex_match(resumeId, std::regex("[A-Za-z0-9][A-Za-z0-9-]{0,63}"))) return {};
    if (!briefing.empty() && HostedBriefing(briefing) != briefing) return {};
    std::vector<std::string> args = {"-p", "--output-format", "stream-json", "--verbose", "--permission-mode", permissionMode};
    if (ask) for (const char* arg : {"--mcp-config", approvalConfig.c_str(), "--permission-prompt-tool", kHostedApprovalTool}) args.push_back(arg);
    if (!resumeId.empty()) { args.push_back("--resume"); args.push_back(resumeId); }
    if (!briefing.empty()) { args.push_back("--append-system-prompt"); args.push_back(briefing); }
    return args;
}
std::string HostedBriefing(const std::string& text) {
    if (text.empty() || text.size() > 8192 || !std::isalpha(static_cast<unsigned char>(text[0]))) return "";
    for (const char c : text) if ((static_cast<unsigned char>(c) < 0x20 && c != '\n' && c != '\t') || c == 0x7f) return "";
    return text;
}
std::string HostedCodexPrompt(const std::string& briefing, const std::string& prompt, bool resumed) {
    if (briefing.empty() || resumed) return prompt;
    return "Context from Smith (the tool running you; not from the person):\n" + briefing + "\n\nThe person's message:\n" + prompt;
}
std::vector<std::string> HostedCodexArgs(const std::string& sandbox, const std::string& resumeId, const std::string& ollamaModel) {
    if (sandbox != "read-only" && sandbox != "workspace-write" && sandbox != "danger-full-access") return {};
    if (!resumeId.empty() && !std::regex_match(resumeId, std::regex("[A-Za-z0-9][A-Za-z0-9-]{0,63}"))) return {};
    if (!ollamaModel.empty() && !HostedOllamaModelValid(ollamaModel)) return {};
    // `--sandbox` (and the model options) belong to `exec` itself, so they precede `resume`; the
    // trailing "-" reads the prompt from stdin. Approvals stay at exec's default (never ask), so
    // anything the sandbox refuses is reported back to Codex and shown in the dashboard.
    std::vector<std::string> args = {"exec"};
    if (!ollamaModel.empty()) for (const auto& arg : {std::string("--oss"), std::string("--local-provider"), std::string("ollama"), std::string("-m"), ollamaModel}) args.push_back(arg);
    args.push_back("--sandbox"); args.push_back(sandbox);
    if (!resumeId.empty()) { args.push_back("resume"); args.push_back(resumeId); }
    args.push_back("--json"); args.push_back("-");
    return args;
}
bool HostedOllamaModelValid(const std::string& model) { return std::regex_match(model, std::regex("[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}")); }
bool HostedLoginModelValid(const std::string& model) { return std::regex_match(model, std::regex("[a-z][a-z0-9.-]{0,63}")); }
std::map<std::string, std::string> HostedOllamaEnv(const std::string& tool, const std::string& model, const std::string& guestConfigDir) {
    std::map<std::string, std::string> env;
    if (tool == "claude-code") {
        env = {{"ANTHROPIC_BASE_URL", "http://127.0.0.1:11434"}, {"ANTHROPIC_AUTH_TOKEN", "ollama"}, {"ANTHROPIC_API_KEY", ""},
               {"ANTHROPIC_MODEL", model}, {"ANTHROPIC_SMALL_FAST_MODEL", model}, {"ANTHROPIC_DEFAULT_HAIKU_MODEL", model},
               {"ANTHROPIC_DEFAULT_SONNET_MODEL", model}, {"ANTHROPIC_DEFAULT_OPUS_MODEL", model}, {"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"}};
        if (!guestConfigDir.empty()) env["CLAUDE_CONFIG_DIR"] = guestConfigDir;
    } else if (tool == "codex") {
        if (!guestConfigDir.empty()) env["CODEX_HOME"] = guestConfigDir;
    }
    if (!guestConfigDir.empty())
        for (const char* name : {"OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "AWS_ACCESS_KEY_ID",
                                 "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AZURE_OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "HF_TOKEN", "SSH_AUTH_SOCK"})
            env[name] = "";
    return env;
}
std::vector<std::string> HostedOllamaEnvUnset(const std::string& tool, bool guest) {
    std::vector<std::string> unset;
    if (tool == "claude-code") unset = {"ANTHROPIC_*", "CLAUDE_CODE_*", "CLAUDE_SESSION_INGRESS_TOKEN_FILE", "AWS_BEARER_TOKEN_BEDROCK"};
    if (guest) for (const char* pattern : {"CLAUDE_*", "OPENAI_*", "CODEX_*", "AZURE_OPENAI_*"}) unset.push_back(pattern);
    return unset;
}
bool HostedGuestModeAllowed(const std::string& tool, const std::string& mode) {
    return (tool == "claude-code" && (mode == "acceptEdits" || mode == "plan")) || (tool == "codex" && (mode == "workspace-write" || mode == "read-only"));
}
std::string HostedClampJsonLine(const std::string& line, size_t maxString) {
    auto value = Json::parse(line, nullptr, false);
    if (!value.is_object()) return "";
    for (size_t limit = maxString; limit >= 64; limit /= 4) {
        auto copy = value; Clamp(copy, limit);
        auto text = Dump(copy);
        if (text.size() <= kMaxEventBytes) return text;
    }
    return "";
}
std::string HostedCodexWindowsSandbox(const std::string& configToml, bool setupMarkerExists) {
    std::string mode, table; std::stringstream lines(configToml); std::string line;
    const std::regex header(R"(^\s*\[\s*([A-Za-z0-9_.-]+)\s*\]\s*(#.*)?$)"), key(R"(^\s*(windows\.)?sandbox\s*=\s*"(elevated|unelevated|mxc)\")"),
        legacy(R"(^\s*(features\.)?(experimental|elevated)_windows_sandbox\s*=\s*true)");
    std::smatch match;
    while (std::getline(lines, line)) {
        if (std::regex_search(line, match, header)) { table = match[1]; continue; }
        if (std::regex_search(line, match, key) && (table == "windows" || (table.empty() && match[1].matched))) mode = match[2];
        else if (std::regex_search(line, match, legacy) && (table == "features" || (table.empty() && match[1].matched))) mode = match[2] == "elevated" ? "elevated" : "unelevated";
    }
    if (mode.empty()) return "not-set-up";
    return mode == "elevated" && !setupMarkerExists ? "setup-pending" : "ready";
}
std::string HostedPlainText(const std::string& line) {
    static const std::regex escapes("\x1b\\[[0-9;?]*[ -/]*[@-~]|\x1b\\][^\x07\x1b]*(\x07|\x1b\\\\)?|\x1b[@-Z\\\\-_]");
    return std::regex_replace(line, escapes, "");
}
bool HostedAiBranchValid(const std::string& branch) { return std::regex_match(branch, std::regex("smith/(ai-([a-z0-9][a-z0-9-]{0,31}-)?[a-f0-9]{8}|crew-[a-z0-9][a-z0-9-]{0,31}-[a-f0-9]{8})")); }
std::vector<std::string> HostedAiFeatures() {
    std::vector<std::string> features = {"push", "ollama", "codex-ask", "crew", "crew-orchestration-v1", "setup", "api-key-choice", "named-branches", "crew-codex", "login-models"};
    // Ask mode starts this executable as Claude Code's approval helper, so it needs to know its own path.
    try { if (!HostedExecutablePath().empty()) features.push_back("ask"); } catch (const std::exception&) {}
    return features;
}
std::vector<std::string> HostedAiGitArgv(const std::vector<std::string>& args, const std::string& noHooksDir) {
    std::vector<std::string> argv = {"git", "-c", "core.hooksPath=" + noHooksDir, "-c", "core.fsmonitor=false"};
    argv.insert(argv.end(), args.begin(), args.end());
    return argv;
}

void RunHostedAiLoop(const HostedPostFn& post, const std::string& workspaceRoot, const std::atomic<bool>& stop, std::shared_mutex& toolGate, std::atomic<unsigned>* toolsChanged, std::atomic<int>* busy) {
    struct Busy { std::atomic<int>* count; explicit Busy(std::atomic<int>* c) : count(c) { if (count) ++*count; } ~Busy() { if (count) --*count; } };
    // Installs and sign-ins from the dashboard run beside chats on a thread of their own, one at a time.
    struct Setup { std::thread thread; std::atomic<bool> running{false}; ~Setup() { if (thread.joinable()) thread.join(); } } setup;
    while (!stop) {
        std::shared_lock<std::shared_mutex> tools(toolGate, std::try_to_lock);
        if (!tools.owns_lock()) { SleepUnless(stop, 1000); continue; }
        auto accountTools = TryAgentToolUse();
        if (!accountTools) { tools.unlock(); SleepUnless(stop, 1000); continue; }
        std::string response; const int status = post("/ai/claims", "{}", response);
        if (status == 404) { std::printf("This coordinator does not offer AI chat sessions; chat is disabled for this agent.\n"); return; }
        if (status == 401 || status == 403) return;
        const auto reply = Json::parse(response, nullptr, false);
        if (status >= 200 && status < 300 && reply.is_object() && reply.contains("setup") && reply["setup"].is_object() && !setup.running) {
            if (setup.thread.joinable()) setup.thread.join();
            setup.running = true;
            if (busy) ++*busy;
            setup.thread = std::thread([&post, &stop, &toolGate, &setup, toolsChanged, busy, task = Dump(reply["setup"])] {
                try { RunHostedSetupTask(post, task, stop, toolGate); }
                catch (const std::exception& error) { std::printf("Setup task failed: %s\n", error.what()); }
                // Report the new state of the tools straight away rather than at the next detection.
                if (toolsChanged) ++*toolsChanged;
                setup.running = false;
                if (busy) --*busy;
            });
        }
        if (status < 200 || status >= 300 || !reply.is_object() || !reply.contains("turn") || !reply["turn"].is_object()) { accountTools.reset(); tools.unlock(); SleepUnless(stop, status ? 3000 : 10000); continue; }
        const auto turn = reply["turn"];
        std::printf("Running a chat message for session %s.\n", turn.value("sessionId", "").c_str()); std::fflush(stdout);
        try { Busy running(busy); Turn(post, fs::path(workspaceRoot), stop, turn).Run(); }
        catch (const std::exception& error) { std::printf("Chat turn failed: %s\n", error.what()); SleepUnless(stop, 5000); }
    }
}
}
