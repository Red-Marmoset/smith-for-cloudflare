#include <Test/Test.h>
#include <SmithAgent/HostedAgent.h>
#include <SmithAgent/HostedAiSession.h>
#include <SmithAgent/ToolMaintenance.h>
#include <SmithAgent/HostedApproval.h>
#include <SmithAgent/HostedCodexServer.h>
#include <SmithAgent/HostedCrewRun.h>
#include <SmithAgent/HostedCheckIn.h>
#include <SmithAgent/HostedCrewTurn.h>
#include <SmithAgent/HostedGitHost.h>
#include <SmithAgent/HostedGitInit.h>
#include <zip.h>
#include <SmithAgent/HostedGitRelay.h>
#include <SmithAgent/HostedGitTasks.h>
#include <SmithAgent/HostedImport.h>
#include <SmithAgent/HostedLfsTasks.h>
#include <SmithAgent/HostedTransport.h>
#include <SmithAgent/HostedPull.h>
#include <SmithAgent/HostedToolSetup.h>
#include <SmithAgent/HostedUpdate.h>
#include <json/single_include/nlohmann/json.hpp>
#include <map>
#include <cstdio>
#include <SmithAgent/HostedPlatform.h>
#include <SmithAgent/HostedRepoCache.h>
#include <SmithCore/Uuid.h>
#include <SmithCore/Process.h>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <limits>
#include <mutex>
#include <future>
#include <sstream>
using namespace std::string_literals;
namespace Test {
int TestMain(const CommandLine::Parser&) {
    int failed = 0, passed = 0;
#define CHECK(c) do { if (!(c)) { printf("FAIL line %d: %s\n", __LINE__, #c); ++failed; } else ++passed; } while(0)
    CHECK(nlohmann::json::parse(Smith::HostedCheckInReport("event", std::string(40, 'a'), std::string(40, 'b'), std::string("1\t2\tsrc/a.cpp\0", 14), true))["changes"].size() == 1);
    CHECK(nlohmann::json::parse(Smith::HostedCheckInReport("event", std::string(40, 'a'), std::string(40, 'b'), "1\t2\t../escape", true))["complete"] == false);
    CHECK(Smith::HostedCrewScopeAllows({"Modules/"}, "Modules/a.cpp"));
    CHECK(!Smith::HostedCrewScopeAllows({"Modules/"}, "Other/a.cpp"));
    CHECK(!Smith::HostedCrewScopeAllows({"Modules/"}, "Modules/../secret"));
    CHECK(!Smith::HostedCrewScopeAllows({""}, ".git/config"));
    CHECK(!Smith::HostedCrewScopeAllows({""}, "a/.git/config"));
    CHECK(!Smith::HostedCrewScopeAllows({"Modules/"}, "modules/a.cpp"));
    CHECK(!Smith::HostedCrewScopeAllows({"Modules/"}, "Modules/a:stream"));
    CHECK(!Smith::HostedCrewScopeAllows({"Modules/"}, "Modules/a./b"));
    CHECK(Smith::ToolMaintenanceDue(100, 0));
    CHECK(!Smith::ToolMaintenanceDue(86499, 100));
    CHECK(Smith::ToolMaintenanceDue(86500, 100));
    CHECK(!Smith::ToolMaintenanceDue(99, 100));
    {
        std::shared_mutex gate;
        std::atomic<bool> stop{false};
        bool claimed = false;
        Smith::RunHostedAiLoop([&](const std::string&, const std::string&, std::string&) {
            claimed = true;
            // Even the claim must exclude maintenance: otherwise an update could
            // start between accepting a turn and launching its CLI.
            CHECK(std::async(std::launch::async, [&]() {
                std::unique_lock<std::shared_mutex> maintenance(gate, std::try_to_lock);
                return !maintenance.owns_lock();
            }).get());
            return 404;
        }, "unused", stop, gate);
        CHECK(claimed);
    }
    {
        const auto path = std::filesystem::temp_directory_path() / ("smith-tools-lock-" + Smith::MakeUuid());
        auto first = Smith::HostedTryToolLock(path.string(), false);
        auto second = Smith::HostedTryToolLock(path.string(), false);
        CHECK(first && second);
        CHECK(!Smith::HostedTryToolLock(path.string(), true));
        first.reset(); second.reset();
        auto update = Smith::HostedTryToolLock(path.string(), true);
        CHECK(update != nullptr);
        CHECK(!Smith::HostedTryToolLock(path.string(), false));
        CHECK(!Smith::HostedTryToolLock(path.string(), true));
        update.reset(); std::filesystem::remove(path);
    }
    {
        std::vector<std::string> updates;
        Smith::UpdateAgentTools("linux", [&](const std::string& tool, const std::vector<std::string>& args) {
            if (tool == "npm" && args[0] == "ls") return Smith::ToolCommandResult{0, R"({"dependencies":{"@openai/codex":{},"wrangler":{},"unrelated":{}}})"};
            if (tool == "npm" && args[0] == "install") { updates.push_back(args.back()); return Smith::ToolCommandResult{0, ""}; }
            return Smith::ToolCommandResult{-1, ""};
        });
        CHECK(updates == std::vector<std::string>({"@openai/codex@latest", "wrangler@latest", "npm@latest"}));
        updates.clear();
        Smith::UpdateAgentTools("linux", [&](const std::string& tool, const std::vector<std::string>& args) {
            if (tool == "claude" && args[0] == "--version") return Smith::ToolCommandResult{0, "2.1.0"};
            if (tool == "claude" && args[0] == "update") { updates.push_back(tool); return Smith::ToolCommandResult{0, ""}; }
            return Smith::ToolCommandResult{-1, ""};
        });
        CHECK(updates == std::vector<std::string>({"claude"}));
        updates.clear();
        Smith::UpdateAgentTools("windows", [&](const std::string& tool, const std::vector<std::string>& args) {
            if (tool == "claude" && args[0] == "--version") return Smith::ToolCommandResult{0, "2.1.0"};
            if (tool == "winget" && args[0] == "list") return Smith::ToolCommandResult{0, "Anthropic.ClaudeCode"};
            if (args[0] == "upgrade" || args[0] == "update") { updates.push_back(tool); return Smith::ToolCommandResult{0, ""}; }
            return Smith::ToolCommandResult{-1, ""};
        });
        CHECK(updates == std::vector<std::string>({"winget"}));
        updates.clear();
        Smith::UpdateAgentTools("mac", [&](const std::string& tool, const std::vector<std::string>& args) {
            if (tool == "brew" && args[0] == "list" && args.back() == "codex") return Smith::ToolCommandResult{0, "codex"};
            if (args[0] == "upgrade") { updates.push_back(tool + ":" + args.back()); return Smith::ToolCommandResult{0, ""}; }
            return Smith::ToolCommandResult{-1, ""};
        });
        CHECK(updates == std::vector<std::string>({"brew:codex"}));
        updates.clear();
        Smith::UpdateAgentTools("linux", [&](const std::string& tool, const std::vector<std::string>& args) {
            if (tool == "npm" && args[0] == "ls") return Smith::ToolCommandResult{1, R"({"dependencies":{"@openai/codex":{},"wrangler":{}}})"};
            if (args[0] == "install") {
                CHECK(args[2] == "--engine-strict"); updates.push_back(args.back());
                return Smith::ToolCommandResult{1, "permission denied"};
            }
            return Smith::ToolCommandResult{-1, ""};
        });
        CHECK(updates == std::vector<std::string>({"@openai/codex@latest", "wrangler@latest", "npm@latest"}));
    }
    CHECK(Smith::HostedOriginValid("https://exp.redmarmosetstudios.com"));
    for (const auto& s : {"http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?x", "https://example.com\nheader", "https://"}) CHECK(!Smith::HostedOriginValid(s));
    CHECK(Smith::HostedRelativePathValid("repo/sub folder"));
    CHECK(Smith::HostedRelativePathValid("."));
    for (const auto& s : {"../escape", "repo/../../secret", "C:\\secret", "/tmp", "\\\\server\\path", "repo:stream", "repo/..", "repo\\..\\escape"}) CHECK(!Smith::HostedRelativePathValid(s));
    Smith::JobSpec spec; spec.command = {"exe", "cmd.exe", {"/d", "/c", "echo hello"}};
    CHECK(Smith::ValidateHostedSpec(spec).empty());
    auto argv = Smith::HostedCommandArgv(spec.command, "unused"); CHECK(!argv.empty() && argv[0] == "cmd.exe");
    spec.repos.push_back({"main", "https://github.com/example/repo.git", "main", "", "main", ""});
    CHECK(!Smith::ValidateHostedSpec(spec).empty());
    spec.repos[0].commit = "0123456789abcdef0123456789abcdef01234567";
    CHECK(Smith::ValidateHostedSpec(spec).empty());
    spec.repos[0].checkoutDir = "../outside"; CHECK(!Smith::ValidateHostedSpec(spec).empty()); spec.repos[0].checkoutDir = "main";
    spec.repos[0].authToken = "secret"; CHECK(!Smith::ValidateHostedSpec(spec).empty()); spec.repos[0].authToken.clear();
    // Cloudflare Artifacts: the one host whose repo token a hosted job may carry.
    const std::string artifactsRemote = "https://bab833826312fe2b0c81bd7608a6dbf7.artifacts.cloudflare.net/git/default/bab833826312-smith.git";
    CHECK(Smith::HostedArtifactsRemote(artifactsRemote));
    for (const auto& s : {"http://bab833826312fe2b0c81bd7608a6dbf7.artifacts.cloudflare.net/git/default/repo.git",
                          "https://x:tok@bab833826312fe2b0c81bd7608a6dbf7.artifacts.cloudflare.net/git/default/repo.git",
                          "https://bab833826312fe2b0c81bd7608a6dbf7.artifacts.cloudflare.net/git/default/repo",
                          "https://bab833826312fe2b0c81bd7608a6dbf7.artifacts.cloudflare.net/git/repo.git",
                          "https://evil.example/git/default/repo.git", "https://github.com/example/repo.git",
                          "https://bab833826312fe2b0c81bd7608a6dbf7.artifacts.cloudflare.net/git/default/repo.git?x=1",
                          "https://bab833826312fe2b0c81bd7608a6dbf7.artifacts.cloudflare.net/git/default/re po.git"}) CHECK(!Smith::HostedArtifactsRemote(s));
    {
        auto env = Smith::HostedGitAuthEnv(artifactsRemote, "art_v1_abc?expires=1");
        CHECK(env["GIT_TERMINAL_PROMPT"] == "0");
        CHECK(env["GIT_CONFIG_COUNT"] == "1");
        CHECK(env["GIT_CONFIG_KEY_0"] == "http.https://bab833826312fe2b0c81bd7608a6dbf7.artifacts.cloudflare.net/.extraheader");
        CHECK(env["GIT_CONFIG_VALUE_0"] == "Authorization: Bearer art_v1_abc?expires=1");
        for (const auto& kv : env) CHECK(kv.first.find("art_v1") == std::string::npos);   // the token is only ever a value
        auto none = Smith::HostedGitAuthEnv("https://github.com/example/repo.git", "");
        CHECK(none.size() == 1 && none.count("GIT_TERMINAL_PROMPT"));
    }
    spec.repos[0].url = artifactsRemote; spec.repos[0].authToken = "art_v1_read?expires=1"; CHECK(Smith::ValidateHostedSpec(spec).empty());
    spec.repos[0].authToken = "bad token"; CHECK(!Smith::ValidateHostedSpec(spec).empty());
    spec.repos[0].authToken.clear(); spec.repos[0].url = "https://github.com/example/repo.git";
    // Mirror jobs: a single source repo plus an Artifacts push target with a write token.
    spec.mirror.remote = artifactsRemote; CHECK(!Smith::ValidateHostedSpec(spec).empty());   // a build job must not carry a target
    spec.kind = "mirror"; CHECK(!Smith::ValidateHostedSpec(spec).empty());                   // ...and a mirror needs a token
    spec.mirror.authToken = "art_v1_write?expires=1"; spec.mirror.branch = "main"; CHECK(Smith::ValidateHostedSpec(spec).empty());
    spec.mirror.branch = "../x"; CHECK(!Smith::ValidateHostedSpec(spec).empty()); spec.mirror.branch = "feature/cloudflare-experiment"; CHECK(Smith::ValidateHostedSpec(spec).empty());
    spec.mirror.remote = "https://github.com/example/other.git"; CHECK(!Smith::ValidateHostedSpec(spec).empty()); spec.mirror.remote = artifactsRemote;
    {
        // Push to a linked repository: Smith's copy (read token) out to another host with the machine's own Git login.
        Smith::JobSpec push; push.kind = "mirror"; push.command = {"exe", "cmd.exe", {"/d", "/c", "echo Smith Cloudflare smoke"}};   // the coordinator's placeholder
        push.repos.push_back({"main", artifactsRemote, "main", "", ".", "art_v1_read?expires=1"});
        push.mirror = {"https://github.com/example/repo.git", "", "main", true};
        CHECK(Smith::ValidateHostedSpec(push).empty());
        push.mirror.remote = "git@github.com:example/repo.git"; CHECK(Smith::ValidateHostedSpec(push).empty());
        push.mirror.authToken = "art_v1_write?expires=1"; CHECK(!Smith::ValidateHostedSpec(push).empty()); push.mirror.authToken.clear();   // no token leaves for another host
        push.mirror.remote = "https://x:tok@github.com/example/repo.git"; CHECK(!Smith::ValidateHostedSpec(push).empty());
        push.mirror.remote = "file:///tmp/repo"; CHECK(!Smith::ValidateHostedSpec(push).empty());
        push.mirror.remote = artifactsRemote; CHECK(!Smith::ValidateHostedSpec(push).empty());          // an Artifacts target needs its write token
        push.mirror.remote = "https://github.com/example/repo.git";
        push.repos[0].branch.clear(); CHECK(!Smith::ValidateHostedSpec(push).empty()); push.repos[0].branch = "main";   // a branch tip needs the branch
        // Pull: the linked repository's branch tip into Smith's copy with a write token.
        Smith::JobSpec pull = push;
        pull.repos[0] = {"main", "git@github.com:example/repo.git", "main", "", ".", ""};
        pull.mirror = {artifactsRemote, "art_v1_write?expires=1", "main", true};
        CHECK(Smith::ValidateHostedSpec(pull).empty());
        // Only Smith's copy may be pushed to a linked repository.
        pull.mirror = {"https://gitlab.com/example/other.git", "", "main", true}; CHECK(!Smith::ValidateHostedSpec(pull).empty());
        CHECK(Smith::HostedPushFailure("R", {" ! [rejected]        main -> main (fetch first)", "error: failed to push some refs to 'R'"}) == "Push to R refused: not a fast-forward; nothing was overwritten");
        CHECK(Smith::HostedPushFailure("R", {" ! [rejected]        main -> main (non-fast-forward)"}).find("not a fast-forward") != std::string::npos);
        CHECK(Smith::HostedPushFailure("R", {"remote: Permission to example/repo.git denied to someone.", "fatal: unable to access 'R/': The requested URL returned error: 403"}) == "Push to R failed: fatal: unable to access 'R/': The requested URL returned error: 403");
        CHECK(Smith::HostedPushFailure("R", {}) == "Push to R failed");
    }
    spec.repos.push_back(spec.repos[0]); spec.repos[1].checkoutDir = "second"; CHECK(!Smith::ValidateHostedSpec(spec).empty()); spec.repos.pop_back();
    spec.kind = "deploy"; CHECK(!Smith::ValidateHostedSpec(spec).empty());
    spec.kind = "build"; spec.mirror = {};
    spec.inputs.push_back({}); CHECK(!Smith::ValidateHostedSpec(spec).empty()); spec.inputs.clear();
    spec.handoff.push_back({}); CHECK(!Smith::ValidateHostedSpec(spec).empty()); spec.handoff.clear();
    spec.artifacts.globs.push_back("*.zip"); CHECK(!Smith::ValidateHostedSpec(spec).empty()); spec.artifacts.globs.clear();
    spec.workingDir = "../elsewhere"; CHECK(!Smith::ValidateHostedSpec(spec).empty()); spec.workingDir.clear();
    spec.artifacts.package = "none";
    spec.artifacts.globs = {"Build/smith-release.zip"}; CHECK(Smith::ValidateHostedSpec(spec).empty());
    spec.artifacts.globs = {"Build/a.zip", "Other/a.zip"}; CHECK(!Smith::ValidateHostedSpec(spec).empty());
    spec.artifacts.globs = {"a", "b", "c", "d", "e"}; CHECK(!Smith::ValidateHostedSpec(spec).empty());
    spec.artifacts.globs = {"../outside.zip"}; CHECK(!Smith::ValidateHostedSpec(spec).empty());
    spec.artifacts.globs = {"Build/release.zip"}; spec.artifacts.package = "zip"; CHECK(!Smith::ValidateHostedSpec(spec).empty());
    spec.artifacts.package = "none"; spec.artifacts.globs.clear();
    spec.command.interpreter = "unknown"; CHECK(!Smith::ValidateHostedSpec(spec).empty());
    {
        const auto models = Smith::HostedParseOllamaTags(R"({"models":[
            {"name":"qwen3.5:9b","model":"qwen3.5:9b","size":6000000000},
            {"name":"kimi-k2.6:cloud","size":0,"remote_host":"https://ollama.com:443"},
            {"name":"gpt-oss:120b-cloud"},
            {"name":"../../etc/passwd","size":1},
            {"name":42},
            "not an object"]})");
        CHECK(models.size() == 3);
        CHECK(models.size() == 3 && models[0].name == "qwen3.5:9b" && models[0].sizeBytes == 6000000000LL && !models[0].remote);
        CHECK(models.size() == 3 && models[1].remote && models[2].remote && models[2].sizeBytes == 0);
        CHECK(Smith::HostedParseOllamaTags("").empty());
        CHECK(Smith::HostedParseOllamaTags("{\"models\":{}}").empty());
        std::string many = "{\"models\":[";
        for (int i = 0; i < 60; ++i) many += std::string(i ? "," : "") + "{\"name\":\"m" + std::to_string(i) + "\"}";
        CHECK(Smith::HostedParseOllamaTags(many + "]}").size() == 50);
        CHECK(Smith::HostedToolVersion("\r\n  2.1.4 (Claude Code)\r\nextra\n") == "2.1.4 (Claude Code)");
        CHECK(Smith::HostedToolVersion("codex-cli 0.90.0") == "codex-cli 0.90.0");
        CHECK(Smith::HostedToolVersion(std::string(100, 'v')).size() == 64);
        CHECK(Smith::HostedToolVersion("\x1b[1mbold\x1b[0m") == "[1mbold[0m");
        CHECK(Smith::HostedToolVersion("\n\n").empty());
    }
    {
        // Tools are found where their installers put them, not only on the agent's PATH.
        const std::map<std::string, std::string> winEnv = {{"USERPROFILE", "C:\\Users\\a"}, {"APPDATA", "C:\\Users\\a\\AppData\\Roaming"}, {"ProgramFiles", "C:\\Program Files"}};
        const auto win = Smith::HostedToolSearchDirs("windows", [&](const std::string& name) { auto it = winEnv.find(name); return it == winEnv.end() ? std::string() : it->second; });
        CHECK(!win.empty() && win[0] == "C:\\Users\\a\\.local\\bin");
        CHECK(std::find(win.begin(), win.end(), "C:\\Users\\a\\AppData\\Roaming\\npm") != win.end());
        CHECK(std::find(win.begin(), win.end(), "C:\\Program Files\\nodejs") != win.end());
        CHECK(std::none_of(win.begin(), win.end(), [](const std::string& dir) { return dir.empty() || dir[0] == '\\'; })); // unset variables add nothing
        const auto mac = Smith::HostedToolSearchDirs("mac", [](const std::string& name) { return name == "HOME" ? std::string("/Users/a") : std::string(); });
        CHECK(!mac.empty() && mac[0] == "/Users/a/.local/bin");
        CHECK(std::find(mac.begin(), mac.end(), "/opt/homebrew/bin") != mac.end() && std::find(mac.begin(), mac.end(), "/Users/a/Library/pnpm") != mac.end());
        CHECK(std::none_of(mac.begin(), mac.end(), [](const std::string& dir) { return dir.empty(); }));
        CHECK(Smith::HostedFindTool("smith-no-such-tool-7f3a").empty());
        CHECK(!Smith::HostedFindTool("git").empty());
        { const auto here = Smith::DetectHostedAiTools(); printf("AI tools on this machine: %s; installable: %s\n", here.tools.c_str(), here.installable.c_str()); }
        // An API key must never quietly replace the owner's own login.
        CHECK(Smith::HostedApiKeyVars("claude-code") == std::vector<std::string>({"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"}));
        CHECK(Smith::HostedApiKeyVars("codex") == std::vector<std::string>({"OPENAI_API_KEY", "CODEX_API_KEY"}));
        CHECK(Smith::HostedApiKeyVars("other").empty());
        // Nothing a CLI does may open a window on the owner's screen.
        CHECK(Smith::HostedNoBrowser("windows") == "where.exe" && Smith::HostedNoBrowser("linux") == "true" && Smith::HostedNoBrowser("mac") == "true");
        const auto quiet = Smith::HostedCliQuietEnv("windows");
        CHECK(quiet.at("BROWSER") == "where.exe" && quiet.at("GCM_INTERACTIVE") == "never" && quiet.at("GIT_TERMINAL_PROMPT") == "0" && quiet.at("SSH_ASKPASS_REQUIRE") == "never");
        CHECK(Smith::HostedClaudeSignedIn("{\n  \"loggedIn\": true,\n  \"authMethod\": \"claude.ai\"\n}") == 1);
        CHECK(Smith::HostedClaudeSignedIn("{\"loggedIn\": false}") == 0);
        CHECK(Smith::HostedClaudeSignedIn("error: unknown command 'auth'") == -1);
        CHECK(Smith::HostedClaudeSignedIn("{\"loggedIn\": \"yes\"}") == -1);
        CHECK(Smith::HostedCodexSignedIn("Logged in using ChatGPT\n", 0) == 1);
        CHECK(Smith::HostedCodexSignedIn("\x1b[2mNot logged in\x1b[0m\n", 1) == 0);
        CHECK(Smith::HostedCodexSignedIn("Logged in using ChatGPT\n", 2) == -1);
        CHECK(Smith::HostedCodexSignedIn("error: unrecognized subcommand 'status'", 2) == -1);
        // Installs never need an administrator; without npm (or Homebrew) Codex is not offered.
        const auto claudeWin = Smith::HostedInstallPlan("claude-code", "windows", false, false);
        CHECK(claudeWin.size() == 1 && claudeWin[0].tool == "powershell" && claudeWin[0].args.back() == "irm https://claude.ai/install.ps1 | iex");
        const auto claudeLinux = Smith::HostedInstallPlan("claude-code", "linux", false, false);
        CHECK(claudeLinux.size() == 1 && claudeLinux[0].tool == "bash" && claudeLinux[0].args.back() == "curl -fsSL https://claude.ai/install.sh | bash");
        const auto codexNpm = Smith::HostedInstallPlan("codex", "windows", true, false);
        CHECK(codexNpm.size() == 1 && codexNpm[0].tool == "npm" && codexNpm[0].args == std::vector<std::string>({"install", "--global", "@openai/codex@latest"}));
        const auto codexBrew = Smith::HostedInstallPlan("codex", "mac", false, true);
        CHECK(codexBrew.size() == 1 && codexBrew[0].tool == "brew");
        CHECK(Smith::HostedInstallPlan("codex", "linux", false, true).empty());
        CHECK(Smith::HostedInstallPlan("codex", "windows", false, false).empty());
        CHECK(Smith::HostedInstallPlan("other", "windows", true, true).empty());
        const auto features = Smith::HostedAiFeatures();
        CHECK(std::find(features.begin(), features.end(), "setup") != features.end() && std::find(features.begin(), features.end(), "api-key-choice") != features.end());
        CHECK(std::find(features.begin(), features.end(), "named-branches") != features.end());
        CHECK(std::find(features.begin(), features.end(), "login-models") != features.end());
    }
    {
        // A claim may hand out a setup task beside (or instead of) a turn. It runs on its own thread,
        // reports its outcome through /ai/setup/events, and asks for the tools to be reported again.
        std::shared_mutex gate; std::atomic<bool> stop{false}; std::atomic<unsigned> changed{0};
        std::mutex lock; std::vector<std::string> finishes; int claims = 0;
        Smith::RunHostedAiLoop([&](const std::string& route, const std::string& body, std::string& response) {
            std::lock_guard<std::mutex> guard(lock);
            if (route == "/ai/claims") {
                if (++claims == 1) { response = R"({"turn":null,"setup":{"setupId":"s1","leaseToken":"t1","tool":"codex","action":"unknown"}})"; return 200; }
                return 404;
            }
            if (route == "/ai/setup/events") {
                const auto json = nlohmann::json::parse(body);
                CHECK(json["setupId"] == "s1" && json["leaseToken"] == "t1");
                if (json.contains("finish")) finishes.push_back(json["finish"]["status"].get<std::string>());
                response = R"({"stop":false,"input":[]})"; return 200;
            }
            return 500;
        }, "unused", stop, gate, &changed);
        CHECK(finishes == std::vector<std::string>({"failed"}));
        CHECK(changed.load() == 1);
    }
    {
        const auto args = Smith::HostedClaudeArgs("acceptEdits", "");
        CHECK(args == std::vector<std::string>({"-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"}));
        const auto resumed = Smith::HostedClaudeArgs("plan", "b1d9a6c2-0000-4000-8000-000000000001");
        CHECK(resumed.size() == 8 && resumed[6] == "--resume" && resumed[7] == "b1d9a6c2-0000-4000-8000-000000000001");
        CHECK(Smith::HostedClaudeArgs("default", "").empty());              // ask mode needs dashboard prompts
        CHECK(Smith::HostedClaudeArgs("dangerously", "").empty());
        CHECK(Smith::HostedClaudeArgs("plan", "x --dangerously-skip-permissions").empty());
        CHECK(Smith::HostedClaudeArgs("plan", "--dangerously-skip-permissions").empty()); // an ID must not read as a flag
        CHECK(Smith::HostedClampJsonLine("not json", 100).empty());
        CHECK(Smith::HostedClampJsonLine("[1,2]", 100).empty());
        CHECK(Smith::HostedClampJsonLine(R"({"type":"result","n":1})", 100) == R"({"n":1,"type":"result"})");
        const auto clamped = Smith::HostedClampJsonLine("{\"a\":{\"b\":[\"" + std::string(5000, 'x') + "\"]}}", 100);
        CHECK(clamped.find(std::string(100, 'x') + "... [truncated by Smith]") != std::string::npos && clamped.size() < 200);
        CHECK(Smith::HostedClampJsonLine("{\"a\":\"" + std::string(200000, 'y') + "\"}", 100000).size() <= 30000);
        // Ask mode: Claude Code asks Smith's approval helper, started from an --mcp-config file.
        CHECK(Smith::HostedClaudeArgs("default", "", "/w/mcp-1.json") == std::vector<std::string>({"-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "default",
              "--mcp-config", "/w/mcp-1.json", "--permission-prompt-tool", "mcp__smith_approval__approve"}));
        CHECK(Smith::HostedClaudeArgs("acceptEdits", "", "/w/mcp-1.json").empty());
        // The coordinator's briefing rides in the system prompt as one argument; one that could read as a flag, or is not plain text, is refused.
        const std::string briefing = "You are working in a Smith chat on the project \"Smith\".\nDo not push.";
        const auto briefed = Smith::HostedClaudeArgs("acceptEdits", "", "", briefing);
        CHECK(briefed.size() == 8 && briefed[6] == "--append-system-prompt" && briefed[7] == briefing);
        CHECK(Smith::HostedBriefing(briefing) == briefing && Smith::HostedBriefing("").empty());
        CHECK(Smith::HostedBriefing("--dangerously-skip-permissions").empty() && Smith::HostedBriefing(" You").empty() && Smith::HostedBriefing("You\x01").empty());
        CHECK(Smith::HostedBriefing(std::string(8193, 'a')).empty() && Smith::HostedBriefing(std::string(8192, 'a')).size() == 8192);
        CHECK(Smith::HostedClaudeArgs("acceptEdits", "", "", "--append-system-prompt").empty());
        // Codex has no system prompt: the briefing goes ahead of the first message of a thread only.
        CHECK(Smith::HostedCodexPrompt(briefing, "Fix it", false) == "Context from Smith (the tool running you; not from the person):\n" + briefing + "\n\nThe person's message:\nFix it");
        CHECK(Smith::HostedCodexPrompt(briefing, "Fix it", true) == "Fix it" && Smith::HostedCodexPrompt("", "Fix it", false) == "Fix it");
        CHECK(Smith::HostedApprovalMcpConfig("/opt/smith/Smith", "/w/approvals-1") ==
              R"({"mcpServers":{"smith_approval":{"args":["ai-approve","/w/approvals-1"],"command":"/opt/smith/Smith","type":"stdio"}}})");
        CHECK(Smith::HostedApprovalResult("allow", "", R"({"command":"npm test"})") == R"({"behavior":"allow","updatedInput":{"command":"npm test"}})");
        CHECK(Smith::HostedApprovalResult("deny", "Use notes/ instead", "{}") == R"({"behavior":"deny","message":"Use notes/ instead"})");
        CHECK(Smith::HostedApprovalResult("maybe", "", R"({"command":"rm -rf /"})").find(R"("behavior":"deny")") != std::string::npos);
        CHECK(Smith::HostedApprovalIdValid("toolu_01ABC") && !Smith::HostedApprovalIdValid("../x") && !Smith::HostedApprovalIdValid(""));
        CHECK(Smith::HostedApprovalToolValid("mcp__smith__start_build") && !Smith::HostedApprovalToolValid("Bash(rm -rf)"));
        CHECK(Smith::HostedCodexArgs("workspace-write", "") == std::vector<std::string>({"exec", "--sandbox", "workspace-write", "--json", "-"}));
        CHECK(Smith::HostedCodexArgs("read-only", "0199a213-81c0-7800-8aa1-bbab2a035a53") ==
              std::vector<std::string>({"exec", "--sandbox", "read-only", "resume", "0199a213-81c0-7800-8aa1-bbab2a035a53", "--json", "-"}));
        CHECK(!Smith::HostedCodexArgs("danger-full-access", "").empty());
        CHECK(Smith::HostedCodexArgs("acceptEdits", "").empty());            // Claude Code's word, not Codex's
        CHECK(Smith::HostedCodexArgs("read-only", "--last").empty());
        CHECK(Smith::HostedCodexArgs("read-only", "x --dangerously-bypass-approvals-and-sandbox").empty());
        CHECK(Smith::HostedCodexEventRelayed(R"({"type":"item.completed","item":{"type":"agent_message","text":"hi"}})"));
        CHECK(Smith::HostedCodexEventRelayed(R"({"type":"item.started","item":{"type":"command_execution","command":"make"}})"));
        CHECK(!Smith::HostedCodexEventRelayed(R"({"type":"item.started","item":{"type":"reasoning"}})"));
        CHECK(!Smith::HostedCodexEventRelayed(R"({"type":"item.updated","item":{"type":"todo_list"}})"));
        CHECK(Smith::HostedCodexEventRelayed(R"({"type":"turn.completed","usage":{}})"));
        CHECK(Smith::HostedAiGitArgv({"push", "--no-verify", "https://github.com/o/r.git", "refs/heads/smith/ai-1:refs/heads/smith/ai-1"}, "/w/ai/s/no-hooks") ==
              std::vector<std::string>({"git", "-c", "core.hooksPath=/w/ai/s/no-hooks", "-c", "core.fsmonitor=false", "push", "--no-verify", "https://github.com/o/r.git", "refs/heads/smith/ai-1:refs/heads/smith/ai-1"}));
        {
            // Every platform can name its own executable, which ask mode hands Claude Code as its helper;
            // "crew" tells the coordinator this agent understands autonomous crew turns.
            const auto features = Smith::HostedAiFeatures();
            for (const char* feature : {"push", "ask", "ollama", "codex-ask", "crew"}) CHECK(std::find(features.begin(), features.end(), feature) != features.end());
            CHECK(std::filesystem::is_regular_file(Smith::HostedExecutablePath()));
        }
        // Ollama: Codex runs the local model; Claude Code talks to Ollama's Anthropic-compatible API.
        CHECK(Smith::HostedCodexArgs("read-only", "0199a213-81c0-7800-8aa1-bbab2a035a53", "qwen3:8b") == std::vector<std::string>({"exec", "--oss", "--local-provider", "ollama", "-m", "qwen3:8b",
              "--sandbox", "read-only", "resume", "0199a213-81c0-7800-8aa1-bbab2a035a53", "--json", "-"}));
        CHECK(Smith::HostedCodexArgs("read-only", "", "--yolo").empty());
        CHECK(Smith::HostedLoginModelValid("claude-opus-5-5") && Smith::HostedLoginModelValid("claude-fable-5-1") && !Smith::HostedLoginModelValid("-m")
              && !Smith::HostedLoginModelValid("--dangerously-skip-permissions") && !Smith::HostedLoginModelValid("a b") && !Smith::HostedLoginModelValid(""));
        CHECK(Smith::HostedOllamaModelValid("hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M") && !Smith::HostedOllamaModelValid("-m") && !Smith::HostedOllamaModelValid("a b"));
        {
            const auto own = Smith::HostedOllamaEnv("claude-code", "qwen3:8b", "");
            CHECK(own.at("ANTHROPIC_BASE_URL") == "http://127.0.0.1:11434" && own.at("ANTHROPIC_AUTH_TOKEN") == "ollama" && own.at("ANTHROPIC_API_KEY").empty());
            CHECK(own.at("ANTHROPIC_SMALL_FAST_MODEL") == "qwen3:8b" && !own.count("CLAUDE_CONFIG_DIR") && !own.count("OPENAI_API_KEY"));
            const auto guest = Smith::HostedOllamaEnv("claude-code", "qwen3:8b", "/w/ai/s/guest-claude");
            CHECK(guest.at("CLAUDE_CONFIG_DIR") == "/w/ai/s/guest-claude" && guest.at("OPENAI_API_KEY").empty() && guest.at("GITHUB_TOKEN").empty());
            const auto codexGuest = Smith::HostedOllamaEnv("codex", "qwen3:8b", "/w/ai/s/guest-codex");
            CHECK(codexGuest.at("CODEX_HOME") == "/w/ai/s/guest-codex" && !codexGuest.count("ANTHROPIC_BASE_URL"));
        }
        {
            const auto owner = Smith::HostedOllamaEnvUnset("claude-code", false), guest = Smith::HostedOllamaEnvUnset("claude-code", true);
            for (const char* pattern : {"ANTHROPIC_*", "CLAUDE_CODE_*", "CLAUDE_SESSION_INGRESS_TOKEN_FILE"}) CHECK(std::find(owner.begin(), owner.end(), pattern) != owner.end());
            CHECK(std::find(owner.begin(), owner.end(), "CLAUDE_*") == owner.end());          // an owner keeps their CLAUDE_CONFIG_DIR
            CHECK(std::find(guest.begin(), guest.end(), "CLAUDE_*") != guest.end() && std::find(guest.begin(), guest.end(), "OPENAI_*") != guest.end());
            CHECK(Smith::HostedOllamaEnvUnset("codex", false).empty());
        }
        CHECK(Smith::HostedGuestModeAllowed("claude-code", "plan") && Smith::HostedGuestModeAllowed("codex", "workspace-write"));
        CHECK(!Smith::HostedGuestModeAllowed("claude-code", "bypassPermissions") && !Smith::HostedGuestModeAllowed("claude-code", "default") && !Smith::HostedGuestModeAllowed("codex", "danger-full-access"));
        // Codex's app server, relayed in `codex exec --json` shapes the dashboard renders.
        CHECK(Smith::HostedCodexServerEvent("item/completed", R"({"item":{"type":"agentMessage","id":"m1","text":"Done."},"threadId":"t","turnId":"u"})") ==
              R"({"item":{"id":"m1","text":"Done.","type":"agent_message"},"type":"item.completed"})");
        CHECK(Smith::HostedCodexServerEvent("item/started", R"({"item":{"type":"commandExecution","id":"c1","command":"npm test","status":"inProgress"}})") ==
              R"({"item":{"aggregated_output":"","command":"npm test","exit_code":null,"id":"c1","status":"in_progress","type":"command_execution"},"type":"item.started"})");
        CHECK(Smith::HostedCodexServerEvent("item/started", R"({"item":{"type":"agentMessage","id":"m1","text":""}})").empty());
        CHECK(Smith::HostedCodexServerEvent("item/completed", R"({"item":{"type":"fileChange","id":"f1","status":"completed","changes":[{"path":"a.txt","kind":{"type":"add"},"diff":""}]}})") ==
              R"({"item":{"changes":[{"kind":"add","path":"a.txt"}],"id":"f1","status":"completed","type":"file_change"},"type":"item.completed"})");
        CHECK(Smith::HostedCodexServerEvent("turn/completed", R"({"turn":{"id":"u","status":"completed"}})") == R"({"type":"turn.completed"})");
        CHECK(Smith::HostedCodexServerEvent("turn/completed", R"({"turn":{"id":"u","status":"interrupted","error":null}})") == R"({"error":{"message":"Stopped"},"type":"turn.failed"})");
        CHECK(Smith::HostedCodexServerEvent("error", R"({"error":{"message":"rate limited"},"willRetry":true})").empty());
        CHECK(Smith::HostedCodexServerEvent("thread/tokenUsage/updated", "{}").empty());
        CHECK(Smith::HostedCodexServerQuestion("item/commandExecution/requestApproval", R"({"itemId":"call_1","command":"rm -rf build","cwd":"/w","reason":"cleanup"})", "") ==
              R"({"id":"call_1","input":{"command":"rm -rf build","cwd":"/w","reason":"cleanup"},"tool":"Command"})");
        CHECK(Smith::HostedCodexServerQuestion("item/fileChange/requestApproval", R"({"itemId":"f1"})", R"({"type":"fileChange","id":"f1","changes":[{"path":"src/a.c","kind":{"type":"update","move_path":null}}]})") ==
              R"({"id":"f1","input":{"changes":[{"kind":"update","path":"src/a.c"}]},"tool":"FileChange"})");
        CHECK(Smith::HostedCodexServerQuestion("item/tool/requestUserInput", "{}", "").empty());
        CHECK(Smith::HostedCodexServerQuestion("item/commandExecution/requestApproval", R"({"itemId":"../../etc"})", "").find("../") == std::string::npos);
        CHECK(Smith::HostedPlainText("\x1b[2m2026-10-05\x1b[0m \x1b[31mERROR\x1b[0m codex: bubblewrap") == "2026-10-05 ERROR codex: bubblewrap");
        CHECK(Smith::HostedPlainText("\x1b]0;title\x07plain \x1b[1;32mgreen\x1b[K") == "plain green");
        CHECK(Smith::HostedCodexWindowsSandbox("model = \"gpt-5\"\n", false) == "not-set-up");
        CHECK(Smith::HostedCodexWindowsSandbox("[windows]\nsandbox = \"unelevated\"\n", false) == "ready");
        CHECK(Smith::HostedCodexWindowsSandbox("[windows]  # native\nsandbox = \"elevated\"\n", false) == "setup-pending");
        CHECK(Smith::HostedCodexWindowsSandbox("[windows]\nsandbox = \"elevated\"\n", true) == "ready");
        CHECK(Smith::HostedCodexWindowsSandbox("windows.sandbox = \"unelevated\"\n[profiles.x]\n", false) == "ready");
        CHECK(Smith::HostedCodexWindowsSandbox("[profiles.fast]\nsandbox = \"unelevated\"\n", false) == "not-set-up");   // another table's key
        CHECK(Smith::HostedCodexWindowsSandbox("[features]\nexperimental_windows_sandbox = true\n", false) == "ready");
        CHECK(Smith::HostedAiBranchValid("smith/ai-3576a6da"));
        CHECK(!Smith::HostedAiBranchValid("main") && !Smith::HostedAiBranchValid("smith/ai-3576a6da; rm") && !Smith::HostedAiBranchValid("smith/ai-XYZ"));
        // Named chat branches: smith/ai-<slug>-<8 hex>, the slug lower-case, at most 32 characters, never a flag or a path trick.
        CHECK(Smith::HostedAiBranchValid("smith/ai-fix-the-flaky-test-tidy-up-3576a6da") && Smith::HostedAiBranchValid("smith/ai-x-3576a6da"));
        CHECK(!Smith::HostedAiBranchValid("smith/ai--3576a6da") && !Smith::HostedAiBranchValid("smith/ai-Fix-3576a6da") && !Smith::HostedAiBranchValid("smith/ai-a/b-3576a6da"));
        CHECK(!Smith::HostedAiBranchValid("smith/ai-" + std::string(33, 'a') + "-3576a6da") && !Smith::HostedAiBranchValid("smith/ai-..-3576a6da"));
    }
    const auto testRoot = std::filesystem::temp_directory_path() / ("smith-hosted-test-" + Smith::MakeUuid());
    std::filesystem::create_directory(testRoot);
    const auto secret = testRoot / "secret";
    { std::ofstream out(secret); out << "unencrypted transport credential"; }
    CHECK(!Smith::HostedFileIsPrivate(secret.string()));
    Smith::HostedSecureDirectory(testRoot.string());
    Smith::HostedSecureWrite(secret.string(), "first");
    CHECK(Smith::HostedFileIsPrivate(secret.string()));
    Smith::HostedSecureWrite(secret.string(), "second");
    { std::ifstream in(secret); std::string value; in >> value; CHECK(value == "second"); }
    auto lock = Smith::HostedLockWorkspace((testRoot/"lock").string());
    bool rejected = false;
    try { auto duplicate = Smith::HostedLockWorkspace((testRoot/"lock").string()); } catch (...) { rejected = true; }
    CHECK(rejected);
    lock.reset();
    auto restartLock = Smith::HostedLockWorkspace((testRoot/"lock").string()); CHECK(restartLock != nullptr); restartLock.reset();
    if (Smith::HostedCrashContainmentAvailable()) {
        CHECK(Smith::HostedSha256("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        CHECK(Smith::HostedReadArtifact(testRoot.string(), "secret", 6) == "second");
        rejected = false; try { Smith::HostedReadArtifact(testRoot.string(), "secret", 5); } catch (...) { rejected = true; } CHECK(rejected);
        rejected = false; try { Smith::HostedReadArtifact(testRoot.string(), "../secret", 6); } catch (...) { rejected = true; } CHECK(rejected);
        CHECK(!Smith::HostedDrainRequested((testRoot/"missing").string()));
        CHECK(Smith::HostedDrainRequested(secret.string()));
        const auto hardlink = testRoot/"hardlink";
        std::filesystem::create_hard_link(secret,hardlink);
        rejected = false; try { Smith::HostedReadArtifact(testRoot.string(), "hardlink", 6); } catch (...) { rejected = true; } CHECK(rejected);
        rejected = false; try { Smith::HostedDrainRequested(hardlink.string()); } catch (...) { rejected = true; } CHECK(rejected);
        std::filesystem::remove(hardlink);
        // A link anywhere in the path is refused: a junction on Windows (not an
        // fs::is_symlink), a directory symlink elsewhere.
        const auto junction = testRoot/"junction";
#ifdef _WIN32
        Smith::Process junctionProcess;Smith::ProcessOptions junctionOptions;
        junctionOptions.argv = {"cmd.exe","/d","/c","mklink","/J",junction.string(),testRoot.string()};junctionOptions.timeoutSeconds=10;
        CHECK(junctionProcess.Run(junctionOptions,nullptr)==0);
#else
        std::filesystem::create_directory_symlink(testRoot, junction);
#endif
        rejected = false; try { Smith::HostedReadArtifact(testRoot.string(), "junction/secret", 6); } catch (...) { rejected = true; } CHECK(rejected);
        rejected = false; try { Smith::HostedDrainRequested((junction/"secret").string()); } catch (...) { rejected = true; } CHECK(rejected);
        std::filesystem::remove(junction);
        rejected = false; try { Smith::HostedDrainRequested("relative-drain"); } catch (...) { rejected = true; } CHECK(rejected);
        // The running binary resolves to a real file whose digest is stable.
        const auto self = Smith::HostedExecutablePath();
        CHECK(std::filesystem::is_regular_file(self) && std::filesystem::path(self).is_absolute());
        const auto selfBytes = Smith::HostedReadArtifact(std::filesystem::path(self).parent_path().string(), std::filesystem::path(self).filename().string(), 256*1024*1024);
        CHECK(!selfBytes.empty() && Smith::HostedSha256(selfBytes) == Smith::HostedSha256(selfBytes) && Smith::HostedSha256(selfBytes).size() == 64);
        CHECK(Smith::HostedSha256("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        CHECK(Smith::HostedSha256(std::string(1000, 'a')) == "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
        // A contained build still runs to completion, reports its exit code, and
        // its output pipes close promptly (the sentinel must not hold them open).
        {
            Smith::Process contained; Smith::ProcessOptions options; options.stopWithParent = true; options.timeoutSeconds = 20;
#ifdef _WIN32
            options.argv = {"cmd.exe","/d","/c","echo contained-ok& exit 7"};
#else
            options.argv = {"/bin/sh","-c","echo contained-ok; exit 7"};
#endif
            std::string seen; const auto started = std::chrono::steady_clock::now();
            const int rc = contained.Run(options, [&](bool, const std::string& line) { seen += line; });
            CHECK(rc == 7); CHECK(seen == "contained-ok");
            CHECK(std::chrono::steady_clock::now() - started < std::chrono::seconds(10));
        }
    }
    {
        // The approval helper as Claude Code drives it: handshake, list, then questions answered,
        // refused outright, and left unanswered.
        const auto approvals = testRoot / "approvals"; Smith::HostedSecureDirectory(approvals.string());
        Smith::HostedSecureWrite((approvals / "toolu_1.response.json").string(), R"({"behavior":"allow","message":""})");
        std::istringstream in(
            R"({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}})" "\n"
            R"({"jsonrpc":"2.0","method":"notifications/initialized"})" "\n"
            R"({"jsonrpc":"2.0","id":2,"method":"tools/list"})" "\n"
            R"({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"approve","arguments":{"tool_name":"Bash","input":{"command":"npm test"},"tool_use_id":"toolu_1"}}})" "\n"
            R"j({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"approve","arguments":{"tool_name":"Bash(rm)","input":{}}}})j" "\n"
            R"({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"approve","arguments":{"tool_name":"Write","input":{"file_path":"a"},"tool_use_id":"toolu_2"}}})" "\r\n"
            R"({"jsonrpc":"2.0","id":6,"method":"server/discover","params":{}})" "\n"
            R"({"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}})" "\n"
            "not json\n"
            R"({"jsonrpc":"2.0","id":8,"method":"resources/list"})" "\n");
        std::ostringstream out;
        CHECK(Smith::RunHostedApprovalServer(in, out, approvals.string(), 1) == 0);
        std::vector<std::string> lines; std::istringstream replies(out.str());
        for (std::string line; std::getline(replies, line);) lines.push_back(line);
        CHECK(lines.size() == 9);
        if (lines.size() == 9) {
            CHECK(lines[0].find(R"("protocolVersion":"2025-06-18")") != std::string::npos && lines[0].find("resultType") == std::string::npos);
            CHECK(lines[1].find(R"("name":"approve")") != std::string::npos && lines[1].find("ttlMs") == std::string::npos);
            CHECK(lines[2].find(R"(\"behavior\":\"allow\",\"updatedInput\":{\"command\":\"npm test\"})") != std::string::npos && lines[2].find(R"("id":3)") != std::string::npos);
            CHECK(lines[3].find(R"(\"behavior\":\"deny\")") != std::string::npos && lines[3].find("cannot show") != std::string::npos);
            CHECK(lines[4].find("Nobody answered") != std::string::npos && lines[4].find(R"("id":5)") != std::string::npos);
            CHECK(lines[5].find(R"("supportedVersions":["2026-07-28")") != std::string::npos && lines[5].find(R"("resultType":"complete")") != std::string::npos);
            CHECK(lines[6].find(R"("ttlMs":3600000)") != std::string::npos && lines[6].find(R"("resultType":"complete")") != std::string::npos);
            CHECK(lines[7].find("-32700") != std::string::npos);
            CHECK(lines[8].find("-32601") != std::string::npos);
        }
        CHECK(std::filesystem::is_empty(approvals)); // answered and abandoned questions leave nothing behind
    }
    {
        Smith::HostedCrewArgs in; in.mode = "acceptEdits"; in.schemaInline = R"({"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]})";
        in.runControlDir = "C:/w/ai/crew/m/runs/s/control"; in.inputDir = "C:/w/ai/crew/m/runs/s/input"; in.newProjectDir = "C:/w/ai/crew/m/runs/s/new-project"; in.usdPerRun = 1.5;
        const auto args = Smith::HostedCrewClaudeArgs(in);
        auto has = [&](const std::string& s) { return std::find(args.begin(), args.end(), s) != args.end(); };
        CHECK(has("--restricted") && has("--strict-mcp-config") && has("--json-schema") && has("--max-budget-usd") && has("1.50"));
        CHECK(!has("--bare") && !has("bypassPermissions"));
        CHECK(Smith::HostedCrewClaudeArgs(Smith::HostedCrewArgs{"bypassPermissions", in.schemaInline, in.runControlDir, in.inputDir, in.newProjectDir, "", "", 1.0}).empty());
        Smith::HostedCrewArgs bad = in; bad.schemaInline = R"({"a":"b c"})";   // a space would be re-parsed by cmd.exe
        CHECK(Smith::HostedCrewClaudeArgs(bad).empty());
        CHECK(Smith::HostedCrewSchemaCmdSafe(in.schemaInline) && !Smith::HostedCrewSchemaCmdSafe("{\"x\":\"a&b\"}"));
        for (const double budget : {0.0, -1.0, 0.004, 1000.01, std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()}) { Smith::HostedCrewArgs b = in; b.usdPerRun = budget; CHECK(Smith::HostedCrewClaudeArgs(b).empty()); }
        for (const auto& [budget, sent] : std::vector<std::pair<double, std::string>>{{0.01, "0.01"}, {0.014, "0.01"}, {1.5, "1.50"}, {1000.0, "1000.00"}}) {   // judged, and sent, as the rounded cents
            Smith::HostedCrewArgs b = in; b.usdPerRun = budget; const auto a = Smith::HostedCrewClaudeArgs(b);
            const auto flag = std::find(a.begin(), a.end(), "--max-budget-usd");
            CHECK(flag != a.end() && flag + 1 != a.end() && *(flag + 1) == sent);
        }
        { Smith::HostedCrewArgs r = in; r.resume = "9f1c2a3b-sess"; r.model = "qwen3:8b"; const auto withBoth = Smith::HostedCrewClaudeArgs(r);
          CHECK(!withBoth.empty() && withBoth[withBoth.size() - 4] == "--resume" && withBoth[withBoth.size() - 3] == "9f1c2a3b-sess" && withBoth[withBoth.size() - 2] == "--model" && withBoth.back() == "qwen3:8b");
          r.resume = "x y"; CHECK(Smith::HostedCrewClaudeArgs(r).empty()); r.resume = ""; r.model = "a b"; CHECK(Smith::HostedCrewClaudeArgs(r).empty()); }
        CHECK(Smith::HostedCrewExtractReport(R"({"type":5,"structured_output":{"a":1}})").empty() && Smith::HostedCrewExtractReport(R"({"type":"result","structured_output":"text"})").empty());
        for (const char* brain : {"api-key", "ollama", "own-login", ""}) {   // every brain but login loses the whole families
            const auto unset = Smith::HostedCrewEnvUnset(brain);
            for (const char* p : {"ANTHROPIC_*", "CLAUDE_*", "OPENAI_*", "CODEX_*", "AWS_*", "GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK", "CLOUDFLARE_*", "STEAM_*"}) CHECK(std::find(unset.begin(), unset.end(), p) != unset.end());
        }
        {   // login: the machine's own Claude Code sign-in, kept as a chat keeps it (only the API-key variables go), and nothing else changes
            const auto unset = Smith::HostedCrewEnvUnset("login"), crew = Smith::HostedCrewEnvUnset("api-key");
            const auto has = [&](const char* p) { return std::find(unset.begin(), unset.end(), p) != unset.end(); };
            CHECK(!has("ANTHROPIC_*") && !has("CLAUDE_*") && has("ANTHROPIC_API_KEY") && has("ANTHROPIC_AUTH_TOKEN"));
            for (const auto& p : Smith::HostedApiKeyVars("claude-code")) CHECK(has(p.c_str()));
            for (const auto& p : crew) if (p != "ANTHROPIC_*" && p != "CLAUDE_*") CHECK(has(p.c_str()));
            CHECK(unset.size() == crew.size());   // the two families out, the two API-key names in
            const auto login = Smith::HostedCrewEnv("login", {{"ANTHROPIC_API_KEY", "sk-ant-test"}, {"CLAUDE_CONFIG_DIR", "C:/elsewhere"}}, "C:/w/cfg", "smith_run_x");
            CHECK(login.count("ANTHROPIC_API_KEY") == 0 && login.count("CLAUDE_CONFIG_DIR") == 0 && login.at("SMITH_RUN_TOKEN") == "smith_run_x" && login.at("GIT_TERMINAL_PROMPT") == "0");
            CHECK(login.at("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC") == "1" && login.size() == 3);
        }
        const auto env = Smith::HostedCrewEnv("api-key", {{"ANTHROPIC_API_KEY", "sk-ant-test"}}, "C:/w/cfg", "smith_run_x");
        CHECK(env.at("ANTHROPIC_API_KEY") == "sk-ant-test" && env.at("CLAUDE_CONFIG_DIR") == "C:/w/cfg" && env.at("SMITH_RUN_TOKEN") == "smith_run_x" && env.at("GIT_TERMINAL_PROMPT") == "0");
        {   // the brain's variables are kept, but cannot override the fixed ones; a brain Smith does not know contributes none
            const auto hostile = Smith::HostedCrewEnv("ollama", {{"CLAUDE_CONFIG_DIR", "C:/owner/.claude"}, {"SMITH_RUN_TOKEN", "stolen"}, {"GIT_TERMINAL_PROMPT", "1"},
                {"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "0"}, {"ANTHROPIC_BASE_URL", "http://127.0.0.1:11434"}}, "C:/w/cfg", "smith_run_x");
            CHECK(hostile.at("CLAUDE_CONFIG_DIR") == "C:/w/cfg" && hostile.at("SMITH_RUN_TOKEN") == "smith_run_x" && hostile.at("GIT_TERMINAL_PROMPT") == "0" && hostile.at("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC") == "1");
            CHECK(hostile.at("ANTHROPIC_BASE_URL") == "http://127.0.0.1:11434");
            const auto unknown = Smith::HostedCrewEnv("own-login", {{"ANTHROPIC_API_KEY", "sk-ant-test"}, {"CLAUDE_CONFIG_DIR", "C:/owner/.claude"}}, "C:/w/cfg", "smith_run_x");
            CHECK(unknown.count("ANTHROPIC_API_KEY") == 0 && unknown.at("CLAUDE_CONFIG_DIR") == "C:/w/cfg" && unknown.size() == 4);
        }
        {   // Codex: read-only for plan, workspace-write (no network, no temp folders, new-project/ writable) for acceptEdits; only Smith's MCP server
            const auto codex = Smith::HostedCrewCodexArgs(in, "C:/w/control/schema.json", "C:/w/control/last-message.json", "https://exp.example.com/mcp");
            const auto at = [&](const std::vector<std::string>& a, const std::string& v) { return std::find(a.begin(), a.end(), v); };
            CHECK(!codex.empty() && codex[0] == "exec" && codex.back() == "-" && at(codex, "--json") != codex.end());
            CHECK(at(codex, "workspace-write") != codex.end() && *(at(codex, "--add-dir") + 1) == in.newProjectDir && *(at(codex, "--output-schema") + 1) == "C:/w/control/schema.json");
            CHECK(*(at(codex, "--output-last-message") + 1) == "C:/w/control/last-message.json");
            for (const char* setting : {"approval_policy=never", "sandbox_workspace_write.network_access=false", "mcp_servers={}", "mcp_servers.smith.url=https://exp.example.com/mcp",
                                        "mcp_servers.smith.bearer_token_env_var=SMITH_RUN_TOKEN", "sandbox_workspace_write.exclude_slash_tmp=true"}) CHECK(at(codex, setting) != codex.end());
            CHECK(at(codex, "mcp_servers={}") < at(codex, "mcp_servers.smith.url=https://exp.example.com/mcp"));   // the machine's own servers dropped first
            CHECK(at(codex, "--oss") == codex.end() && at(codex, "danger-full-access") == codex.end() && at(codex, "--dangerously-bypass-approvals-and-sandbox") == codex.end());
            Smith::HostedCrewArgs plan = in; plan.mode = "plan"; plan.model = "qwen3:8b";
            const auto readOnly = Smith::HostedCrewCodexArgs(plan, "s.json", "m.json", "https://exp.example.com/mcp");
            CHECK(at(readOnly, "read-only") != readOnly.end() && at(readOnly, "--add-dir") == readOnly.end() && at(readOnly, "--oss") != readOnly.end() && *(at(readOnly, "-m") + 1) == "qwen3:8b");
            Smith::HostedCrewArgs full = in; full.mode = "bypassPermissions"; CHECK(Smith::HostedCrewCodexArgs(full, "s", "m", "https://exp.example.com/mcp").empty());
            Smith::HostedCrewArgs model = in; model.model = "a b"; CHECK(Smith::HostedCrewCodexArgs(model, "s", "m", "https://exp.example.com/mcp").empty());
            for (const char* url : {"http://exp.example.com/mcp", "https://exp.example.com/mcp?a=1&b=2", "https://exp.example.com/m cp", "https://exp.example.com/\"mcp", "https://a/%20"})
                CHECK(Smith::HostedCrewCodexArgs(in, "s", "m", url).empty());
            // Environment: a Codex sign-in keeps CODEX_HOME and the machine's settings but not its API keys; a local model gets an empty CODEX_HOME.
            const auto loginUnset = Smith::HostedCrewEnvUnset("login", "codex"), localUnset = Smith::HostedCrewEnvUnset("ollama", "codex");
            const auto in_ = [](const std::vector<std::string>& v, const char* p) { return std::find(v.begin(), v.end(), p) != v.end(); };
            CHECK(!in_(loginUnset, "CODEX_*") && !in_(loginUnset, "OPENAI_*") && in_(loginUnset, "OPENAI_API_KEY") && in_(loginUnset, "CODEX_API_KEY") && in_(loginUnset, "ANTHROPIC_*") && in_(loginUnset, "CLAUDE_*"));
            CHECK(in_(localUnset, "CODEX_*") && in_(localUnset, "OPENAI_*") && in_(localUnset, "ANTHROPIC_*") && in_(localUnset, "GITHUB_TOKEN"));
            const auto loginEnv = Smith::HostedCrewEnv("login", {{"OPENAI_API_KEY", "sk-x"}}, "C:/w/cfg", "smith_run_x", "codex", "C:/w/codex-home");
            CHECK(loginEnv.size() == 2 && loginEnv.at("SMITH_RUN_TOKEN") == "smith_run_x" && loginEnv.at("GIT_TERMINAL_PROMPT") == "0");
            const auto localEnv = Smith::HostedCrewEnv("ollama", {{"CODEX_HOME", "C:/owner/.codex"}}, "C:/w/cfg", "smith_run_x", "codex", "C:/w/codex-home");
            CHECK(localEnv.at("CODEX_HOME") == "C:/w/codex-home" && localEnv.count("CLAUDE_CONFIG_DIR") == 0);
            // The report: Codex's last message, a JSON object (fenced or not); anything else is no report.
            CHECK(Smith::HostedCrewExtractCodexReport(R"({"summary":"ok","findings":[]})") == R"({"findings":[],"summary":"ok"})");
            CHECK(Smith::HostedCrewExtractCodexReport("```json\n{\"summary\":\"ok\",\"findings\":[]}\n```\n") == R"({"findings":[],"summary":"ok"})");
            CHECK(Smith::HostedCrewExtractCodexReport("I could not finish.").empty() && Smith::HostedCrewExtractCodexReport("[1]").empty() && Smith::HostedCrewExtractCodexReport("").empty());
            CHECK(Smith::HostedCrewSchemaValid(R"({"type":"object","properties":{"a":{"type":["string","null"]}}})") && !Smith::HostedCrewSchemaValid("[]") && !Smith::HostedCrewSchemaValid("{") &&
                  !Smith::HostedCrewSchemaValid("{\"a\":\"" + std::string(17000, 'x') + "\"}"));
            const auto codexCommit = Smith::HostedCrewCommitArgv("Standards", "standards", "Tidy", "sess-1", "codex");
            CHECK(codexCommit.back().find("Co-Authored-By: Codex <noreply@openai.com>") != std::string::npos);
            CHECK(Smith::HostedCrewCommitArgv("Standards", "standards", "Tidy", "sess-1").back().find("Co-Authored-By: Claude Code") != std::string::npos);
            // A staged private key is never committed, whatever kind; a removed one or a mention in prose is not one.
            CHECK(Smith::HostedCrewPrivateKeyLine("+-----BEGIN OPENSSH PRIVATE KEY-----") && Smith::HostedCrewPrivateKeyLine("+-----BEGIN RSA PRIVATE KEY-----") &&
                  Smith::HostedCrewPrivateKeyLine("+key = \"-----BEGIN PRIVATE KEY-----") && Smith::HostedCrewPrivateKeyLine("+-----BEGIN PGP PRIVATE KEY BLOCK-----"));
            CHECK(!Smith::HostedCrewPrivateKeyLine("------BEGIN RSA PRIVATE KEY-----") && !Smith::HostedCrewPrivateKeyLine("+-----BEGIN PUBLIC KEY-----") && !Smith::HostedCrewPrivateKeyLine("+++ b/id_rsa"));
            const auto features = Smith::HostedAiFeatures();
            CHECK(std::find(features.begin(), features.end(), "crew-codex") != features.end());
        }
        const auto dirs = Smith::HostedCrewDirsFor("C:/w", "member1", "0123456789abcdef-sess");
        CHECK(Smith::HostedCrewPathsIsolated(dirs));
        CHECK(dirs.codexHome.rfind(dirs.runControl, 0) == 0 && dirs.codexHome != dirs.claudeConfig);
        {   // the predicate refuses every overlap however the paths are spelled, and still accepts the real layout in any spelling
            using Dirs = Smith::HostedCrewDirs;
            const auto isolated = [&](const auto& change) { Dirs d = dirs; change(d); return Smith::HostedCrewPathsIsolated(d); };
            const auto fwd = [](std::string s) { std::replace(s.begin(), s.end(), '\\', '/'); return s; };
            const auto bwd = [](std::string s) { std::replace(s.begin(), s.end(), '/', '\\'); return s; };
            const auto upper = [](std::string s) { for (char& c : s) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c))); return s; };
            CHECK(isolated([&](Dirs& d) { for (std::string* p : {&d.repo, &d.gitconfig, &d.input, &d.newProject, &d.runControl}) *p = fwd(*p); }));
            CHECK(isolated([&](Dirs& d) { for (std::string* p : {&d.repo, &d.gitconfig, &d.input, &d.newProject, &d.runControl}) *p = bwd(*p); }));
            CHECK(isolated([&](Dirs& d) { d.input += "/"; d.newProject += "\\"; d.repo += "/./"; d.runControl = upper(d.runControl); }));
            CHECK(isolated([&](Dirs& d) { d.input = d.input + "/sub/.."; d.gitconfig = bwd(d.gitconfig); d.newProject = fwd(d.newProject); }));
            CHECK(!Smith::HostedCrewPathsIsolated(Dirs{}) && !isolated([&](Dirs& d) { d.input.clear(); }) && !isolated([&](Dirs& d) { d.runControl.clear(); }));
            // input = run: the input dir then holds the run's control dir, whatever the separator, trailing separator, case or dot segment
            CHECK(!isolated([&](Dirs& d) { d.input = d.run; }));
            CHECK(!isolated([&](Dirs& d) { d.input = fwd(d.run); }) && !isolated([&](Dirs& d) { d.input = bwd(d.run); }));
            CHECK(!isolated([&](Dirs& d) { d.input = d.run + "/"; }) && !isolated([&](Dirs& d) { d.input = d.run + "\\"; }));
            CHECK(!isolated([&](Dirs& d) { d.input = upper(d.run); }) && !isolated([&](Dirs& d) { d.input = d.run + "/./"; }) && !isolated([&](Dirs& d) { d.input = d.input + "/.."; }));
            CHECK(!isolated([&](Dirs& d) { d.newProject = d.run; }) && !isolated([&](Dirs& d) { d.newProject = fwd(d.run) + "/"; }));
            // an add-dir holding the member's gitconfig (and the repo)
            CHECK(!isolated([&](Dirs& d) { d.newProject = d.memberRoot; }) && !isolated([&](Dirs& d) { d.input = d.memberControl; }));
            CHECK(!isolated([&](Dirs& d) { d.input = d.memberRoot + "/"; d.gitconfig = "C:/elsewhere/gitconfig"; d.runControl = "C:/elsewhere/control"; }));   // holds the repo alone
            // an add-dir that is, or sits inside, the member's repo
            CHECK(!isolated([&](Dirs& d) { d.input = d.repo + "/x"; }) && !isolated([&](Dirs& d) { d.input = d.repo + "\\x"; }));
            CHECK(!isolated([&](Dirs& d) { d.input = d.repo; }) && !isolated([&](Dirs& d) { d.newProject = d.repo + "/"; }) && !isolated([&](Dirs& d) { d.newProject = upper(d.repo); }));
            // the run's control dir or the gitconfig inside, or equal to, an add-dir
            CHECK(!isolated([&](Dirs& d) { d.runControl = d.input + "/control"; }) && !isolated([&](Dirs& d) { d.runControl = d.input + "\\control"; }));
            CHECK(!isolated([&](Dirs& d) { d.runControl = d.input; }) && !isolated([&](Dirs& d) { d.runControl = d.newProject + "/c"; }));
            CHECK(!isolated([&](Dirs& d) { d.gitconfig = d.input + "/g"; }) && !isolated([&](Dirs& d) { d.gitconfig = d.newProject; }) && !isolated([&](Dirs& d) { d.gitconfig = d.input + "/"; }));
            // the run's control dir or the gitconfig inside, or equal to, the repo
            CHECK(!isolated([&](Dirs& d) { d.runControl = d.repo; }) && !isolated([&](Dirs& d) { d.runControl = d.repo + "/control"; }));
            CHECK(!isolated([&](Dirs& d) { d.gitconfig = d.repo; }) && !isolated([&](Dirs& d) { d.gitconfig = d.repo + "\\config"; }));
        }
        CHECK(dirs.input.rfind(dirs.repo, 0) != 0 && dirs.gitconfig.rfind(dirs.input, 0) != 0 && dirs.gitconfig.rfind(dirs.newProject, 0) != 0);
        CHECK(Smith::HostedAiBranchValid("smith/crew-standards-0123abcd") && Smith::HostedAiBranchValid("smith/ai-0123abcd") && !Smith::HostedAiBranchValid("smith/crew-Standards-0123abcd") && !Smith::HostedAiBranchValid("main"));
        CHECK(Smith::HostedCrewSkip("abc", "abc") && !Smith::HostedCrewSkip("abc", "") && !Smith::HostedCrewSkip("", "abc") && !Smith::HostedCrewSkip("abc", "def"));
        const auto commit = Smith::HostedCrewCommitArgv("Standards", "standards", "Tidy includes", "sess-1");
        CHECK(std::find(commit.begin(), commit.end(), "--author=Standards (Smith crew) <crew-standards@smith.invalid>") != commit.end());
        CHECK(std::find(commit.begin(), commit.end(), "Smith crew standards: Tidy includes") != commit.end());
        CHECK(Smith::HostedCrewExtractReport(R"({"type":"result","structured_output":{"summary":"ok","findings":[]}})") == R"({"findings":[],"summary":"ok"})");
        CHECK(Smith::HostedCrewExtractReport(R"({"type":"result"})").empty() && Smith::HostedCrewExtractReport("not json").empty());
        const auto settings = Smith::HostedCrewSettingsJson(false, "C:\\w\\in", "C:\\w\\repo");
        CHECK(settings.find("mcp__smith__crew_report") != std::string::npos && settings.find("crew_create_project") == std::string::npos && settings.find("Bash(*)") != std::string::npos);
        CHECK(Smith::HostedCrewSettingsJson(true, "C:\\w\\in", "C:\\w\\repo").find("mcp__smith__crew_create_project") != std::string::npos);
        {   // Edit and Write denied in the input dir and the checkout's .git, native and in the //-prefixed forward-slash form
            const auto denies = [](const std::string& json, const std::string& rule) {   // as settings.json spells it: backslashes doubled
                std::string quoted = "\""; for (const char c : rule) { if (c == '\\') quoted += '\\'; quoted += c; }
                return json.find(quoted + "\"") != std::string::npos;
            };
            for (const std::string tool : {"Edit", "Write", "NotebookEdit"}) {
                CHECK(denies(settings, tool + "(C:\\w\\in/**)") && denies(settings, tool + "(//C:/w/in/**)"));
                CHECK(denies(settings, tool + "(C:\\w\\repo/.git/**)") && denies(settings, tool + "(//C:/w/repo/.git/**)"));
            }
            // a POSIX path is already absolute: its // form gains one slash
            const auto posix = Smith::HostedCrewSettingsJson(false, "/w/in", "/w/repo");
            CHECK(denies(posix, "Edit(/w/in/**)") && denies(posix, "Edit(//w/in/**)") && denies(posix, "Write(/w/repo/.git/**)") && denies(posix, "Write(//w/repo/.git/**)"));
            // the third form Claude Code normalises a Windows path to before matching: drive letter lower-cased, no colon
            for (const std::string tool : {"Edit", "Write", "NotebookEdit"}) CHECK(denies(settings, tool + "(//c/w/in/**)") && denies(settings, tool + "(//c/w/repo/.git/**)"));
            CHECK(denies(posix, "NotebookEdit(/w/in/**)") && denies(posix, "NotebookEdit(//w/in/**)") && denies(posix, "NotebookEdit(/w/repo/.git/**)") && denies(posix, "NotebookEdit(//w/repo/.git/**)"));
            CHECK(Smith::HostedCrewSettingsJson(false, "D:\\x", "D:\\r").find("Edit(//d/x/**)") != std::string::npos);
            CHECK(posix.find("//w/in/**") != std::string::npos && posix.find("Edit(///w") == std::string::npos);   // no drive, no third form
        }
        {   // gitlink guard: a staged entry whose new mode is 160000 (a nested repository) is caught; a file, or a removed gitlink, is not
            CHECK(Smith::HostedCrewGitlinkLine(":000000 160000 0000000000000000000000000000000000000000 1234567890abcdef1234567890abcdef12345678 A\tsub"));
            CHECK(Smith::HostedCrewGitlinkLine(":100644 160000 1111111 2222222 T\tvendor/lib"));
            CHECK(!Smith::HostedCrewGitlinkLine(":000000 100644 0000000 2222222 A\tsub/file.txt"));
            CHECK(!Smith::HostedCrewGitlinkLine(":160000 000000 1111111 0000000 D\told-submodule"));
            CHECK(!Smith::HostedCrewGitlinkLine("") && !Smith::HostedCrewGitlinkLine("160000 abc 0\tsub"));
        }
        {   // Smith's own git in a crew turn reads the member's empty gitconfig, never the machine owner's global one; the Git
            // installation's system config (its CA bundle on Windows) stays
            const auto d = Smith::HostedCrewDirsFor("C:/w", "member1", "0123456789abcdef0123456789abcdef0123");
            const auto gitEnv = Smith::HostedCrewGitEnv(d);
            CHECK(gitEnv.size() == 1 && gitEnv.at("GIT_CONFIG_GLOBAL") == d.gitconfig && !gitEnv.count("GIT_CONFIG_NOSYSTEM") && d.gitconfig.rfind(d.memberControl, 0) == 0);
        }
        {   // a build-finished run's log: input/build-<jobId>.log, for a job ID that is a plain file-name token only
            CHECK(Smith::HostedCrewBuildLogName("0f6c2a4e-5b7d-4e3a-9c1f-2d8e6b4a7c90") == "build-0f6c2a4e-5b7d-4e3a-9c1f-2d8e6b4a7c90.log");
            for (const auto& badId : std::vector<std::string>{"", "../x", "a/b", "a.b", "a\\b", std::string(65, 'a')}) CHECK(Smith::HostedCrewBuildLogName(badId).empty());
            CHECK(Smith::HostedCrewBuildLogName(std::string(64, 'a')) == "build-" + std::string(64, 'a') + ".log");
        }
        {   // run directories: every run's but the current one's goes at the start of a turn
            CHECK((Smith::HostedCrewStaleRuns({"a", "current", "b"}, "current") == std::vector<std::string>{"a", "b"}));
            CHECK(Smith::HostedCrewStaleRuns({"current"}, "current").empty() && Smith::HostedCrewStaleRuns({}, "current").empty());
            CHECK(Smith::HostedCrewStaleRuns({"x"}, "").empty());   // without a current session nothing is judged stale
        }
        CHECK(Smith::HostedCrewMcpConfigJson("https://x/mcp").find("${SMITH_RUN_TOKEN}") != std::string::npos);
        // a report with keys the schema does not name is still the report (the coordinator validates it)
        CHECK(Smith::HostedCrewExtractReport(R"({"type":"result","total_cost_usd":0.01,"structured_output":{"summary":"ok","findings":[],"extra":{"x":[1]}}})") == R"({"extra":{"x":[1]},"findings":[],"summary":"ok"})");
        {   // changes.diff is cut at a line end, never inside a character, and says it was cut
            CHECK(Smith::HostedCrewCapText("a\nb\n", 4) == "a\nb\n");
            CHECK(Smith::HostedCrewCapText(std::string(3000, 'x') + "\n" + std::string(3000, 'y') + "\n", 4096) == std::string(3000, 'x') + "\n[cut by Smith at 4 KB]\n");
            // no line end within the limit: the 2-byte character the limit would split goes whole
            CHECK(Smith::HostedCrewCapText(std::string(4095, 'z') + "\xC3\xA9" + "tail", 4096) == std::string(4095, 'z') + "\n[cut by Smith at 4 KB]\n");
        }
        {   // a crew push: Smith's copy only with its token; a GitHub project only with this machine's own Git login, as a chat
            const std::string copy = "https://bab833826312fe2b0c81bd7608a6dbf7.artifacts.cloudflare.net/git/default/repo.git";
            CHECK(Smith::HostedCrewPushRefusal(copy, "art_v1_token").empty());
            CHECK(!Smith::HostedCrewPushRefusal(copy, "").empty());
            for (const char* github : {"https://github.com/Red-Marmoset/smith.git", "git@github.com:Red-Marmoset/smith.git"}) {
                CHECK(Smith::HostedCrewPushRefusal(github, "").empty());
                CHECK(!Smith::HostedCrewPushRefusal(github, "art_v1_token").empty());
            }
        }
        {   // ls-remote: the SHA for exactly the ref asked, not for one that merely ends the same way
            const std::string listing = std::string(40, 'a') + "\trefs/heads/x/refs/heads/main\n" + std::string(40, 'b') + "\tHEAD\r\n" + std::string(40, 'c') + "\trefs/heads/main\n";
            CHECK(Smith::HostedCrewRemoteSha(listing, "refs/heads/main") == std::string(40, 'c') && Smith::HostedCrewRemoteSha(listing, "HEAD") == std::string(40, 'b'));
            CHECK(Smith::HostedCrewRemoteSha(listing, "refs/heads/dev").empty() && Smith::HostedCrewRemoteSha("", "HEAD").empty() && Smith::HostedCrewRemoteSha("xyz\tHEAD\n", "HEAD").empty());
        }
        {   // another repository's instruction files, Claude Code's personal one included
            const auto strip = Smith::HostedCrewStripFiles();
            for (const char* file : {"CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude", ".mcp.json"}) CHECK(std::find(strip.begin(), strip.end(), file) != strip.end());
        }
        {   // redaction: every occurrence, overlapping and nested secrets as one, an empty secret ignored, no secrets a no-op
            CHECK(Smith::HostedRedact("x TOKEN y TOKEN", {"TOKEN"}) == "x [redacted] y [redacted]");
            CHECK(Smith::HostedRedact("abcd", {"abc", "bcd"}) == "[redacted]" && Smith::HostedRedact("secretkey123 key", {"key", "secretkey123"}) == "[redacted] [redacted]");
            CHECK(Smith::HostedRedact("abc", {""}) == "abc" && Smith::HostedRedact("abc", {"", "b"}) == "a[redacted]c");
            CHECK(Smith::HostedRedact("abc", {}) == "abc" && Smith::HostedRedact("", {"abc"}).empty());
        }
        {   // the changed paths ai-finish takes: at most 500, each 1-512 bytes without control characters, in at most 24 KiB of JSON
            size_t total = 0;
            CHECK(Smith::HostedCrewFinishFiles(std::string("a\0b c\0", 6), total) == std::vector<std::string>({"a", "b c"}) && total == 2);
            CHECK(Smith::HostedCrewFinishFiles(std::string("a\0b", 3), total) == std::vector<std::string>({"a", "b"}) && total == 2);   // no final NUL
            CHECK(Smith::HostedCrewFinishFiles(std::string("ok\0bad\x01\0", 8) + std::string(513, 'x') + std::string(1, '\0'), total) == std::vector<std::string>({"ok"}) && total == 3);
            std::string many; for (int i = 0; i < 600; ++i) many += std::to_string(i) + std::string(1, '\0');
            CHECK(Smith::HostedCrewFinishFiles(many, total).size() == 500 && total == 600);
            // 500 quotes are 1002 bytes of JSON each: 24 fit in 24 KiB ([, 24 x 1002, 23 commas, ]), the 25th would not
            std::string quoted; for (int i = 0; i < 100; ++i) quoted += std::string(500, '"') + std::string(1, '\0');
            CHECK(Smith::HostedCrewFinishFiles(quoted, total).size() == 24 && total == 100);
            CHECK(Smith::HostedCrewFinishFiles("", total).empty() && total == 0);
            // smith.json and build scripts (.ps1 .sh .bat .cmd .py, any case, anywhere) are listed first, so 500 paths that sort
            // before them cannot push them off the list Verify's guard reads; the list keeps git's order.
            std::string crowded; for (int i = 0; i < 600; ++i) crowded += "a/" + std::to_string(1000 + i) + std::string(1, '\0');
            for (const char* guarded : {"smith.json", "sub/Smith.JSON", "tools/Build.PS1", "z/run.sh", "x.BAT", "y.cmd", "gen.py"}) crowded += std::string(guarded) + std::string(1, '\0');
            const auto listed = Smith::HostedCrewFinishFiles(crowded, total);
            CHECK(listed.size() == 500 && total == 607);
            for (const char* guarded : {"smith.json", "sub/Smith.JSON", "tools/Build.PS1", "z/run.sh", "x.BAT", "y.cmd", "gen.py"}) CHECK(std::find(listed.begin(), listed.end(), guarded) != listed.end());
            CHECK(listed.front() == "a/1000" && listed[492] == "a/1492" && listed.back() == "gen.py");
            CHECK(std::find(listed.begin(), listed.end(), "a/1493") == listed.end());   // the ordinary paths fill what is left
            CHECK((Smith::HostedCrewFinishFiles(std::string("notes.pyc\0build.ps1x\0smith.json.bak\0", 36), total) == std::vector<std::string>{"notes.pyc", "build.ps1x", "smith.json.bak"}));
        }
    }
#ifdef _WIN32
    {   // the inline schema survives cmd.exe, which HostedToolArgv wraps the CLI in. cmd.exe hands the rest of its
        // command line on verbatim and echo prints it, so what comes back is the argument as the launcher quoted it
        // (the schema in quotes, its own quotes as \"); decoding that as a CLI's argv parser would must give the schema back.
        const std::string schema = R"({"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]})";
        Smith::Process p; Smith::ProcessOptions o; std::string out;
        o.argv = Smith::HostedToolArgv("cmd.exe", {"/c", "echo", schema});
        p.Run(o, [&](bool e, const std::string& l) { if (!e) out += l; });
        std::string decoded;
        for (size_t i = 0; i < out.size(); ++i) {
            if (out[i] == '\\' && i + 1 < out.size() && out[i + 1] == '"') { decoded += '"'; ++i; }
            else if (out[i] != '"') decoded += out[i];
        }
        CHECK(decoded == schema);
    }
#endif
    {   // a crew-created project's directory holds plain files and folders only: no .git, no symlink, no junction
        namespace fs = std::filesystem;
        const auto dir = testRoot / "new-project", link = dir / "src" / "link";
        fs::create_directories(dir / "src");
        { std::ofstream(dir / "src" / "main.cpp") << "int main() {}\n"; }
        CHECK(Smith::HostedCrewNewProjectDirValid(dir.string()) && !Smith::HostedCrewNewProjectDirValid((testRoot / "absent").string()));
        CHECK(!Smith::HostedCrewNewProjectDirValid((dir / "src" / "main.cpp").string()));   // a file is not a project directory
#ifdef _WIN32
        Smith::Process mklink; Smith::ProcessOptions mklinkOptions;
        mklinkOptions.argv = {"cmd.exe", "/d", "/c", "mklink", "/J", link.string(), testRoot.string()}; mklinkOptions.timeoutSeconds = 10;
        CHECK(mklink.Run(mklinkOptions, nullptr) == 0);
#else
        fs::create_directory_symlink(testRoot, link);
#endif
        CHECK(!Smith::HostedCrewNewProjectDirValid(dir.string()));   // a link inside, which fs::is_symlink alone misses on Windows
        fs::remove(link);
        CHECK(Smith::HostedCrewNewProjectDirValid(dir.string()));
        fs::create_directory(dir / ".GIT");
        CHECK(!Smith::HostedCrewNewProjectDirValid(dir.string()));
        fs::remove_all(dir);
    }
    {   // the projects a run created: new-project/<id> folders with a usable ID and only plain files; a planted .git is refused
        namespace fs = std::filesystem;
        const auto root = testRoot / "created" / "new-project";
        fs::create_directories(root / "tool-lib" / "src"); fs::create_directories(root / "planted" / "src"); fs::create_directories(root / "Bad_Id");
        { std::ofstream(root / "tool-lib" / "README.md") << "# Tool lib\n"; std::ofstream(root / "planted" / "README.md") << "x\n"; std::ofstream(root / "stray.txt") << "x\n"; }
        fs::create_directories(root / "planted" / "src" / ".git");   // a repository the model planted, anywhere inside, is not pushed
        CHECK(Smith::HostedCrewNewProjectDirValid((root / "tool-lib").string()) && !Smith::HostedCrewNewProjectDirValid((root / "planted").string()));
        std::vector<std::string> refused;
        CHECK((Smith::HostedCrewNewProjectIds(root.string(), refused) == std::vector<std::string>{"tool-lib"}));
        // A folder holding one of the run's secrets is refused too, before anything of it is committed.
        CHECK(Smith::HostedCrewNewProjectIds(root.string(), refused, {"no-such-secret"}).size() == 1);
        CHECK(Smith::HostedCrewNewProjectIds(root.string(), refused, {"# Tool"}).empty() && std::find(refused.begin(), refused.end(), "tool-lib") != refused.end());
        CHECK(Smith::HostedCrewNewProjectIds(root.string(), refused, {""}).size() == 1);   // an empty secret matches nothing
        CHECK((refused == std::vector<std::string>{"Bad_Id", "planted", "stray.txt"}));
        CHECK(Smith::HostedCrewNewProjectIds((testRoot / "absent").string(), refused).empty() && refused.empty());
        for (int i = 0; i < 6; ++i) fs::create_directories(root / ("lib-" + std::to_string(i)));
        CHECK(Smith::HostedCrewNewProjectIds(root.string(), refused).size() == 5);   // the coordinator takes at most five per run
        CHECK(Smith::HostedCrewProjectIdValid("tool-lib") && !Smith::HostedCrewProjectIdValid("x") && !Smith::HostedCrewProjectIdValid("-x") && !Smith::HostedCrewProjectIdValid(std::string(41, 'a')));

        // A push claim's createdProjects: only an Artifacts remote with a plain token and a usable ID is pushed.
        const std::string remote = "https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/default/ws-tool-lib.git";
        size_t dropped = 0;
        const auto claimed = Smith::HostedCrewCreatedFromClaim(nlohmann::json::array({{{"id", "tool-lib"}, {"remote", remote}, {"authToken", "art_v1_w?expires=1"}},
            {{"id", "planted"}, {"remote", remote}, {"authToken", "art_v1_w"}}, {{"id", "elsewhere"}, {"remote", "https://github.com/o/r.git"}, {"authToken", "t"}},
            {{"id", "no-token"}, {"remote", remote}, {"authToken", ""}}, {{"id", "spaced"}, {"remote", remote}, {"authToken", "a b"}}, "junk"}).dump(), dropped);
        CHECK(claimed.size() == 2 && claimed[0].id == "tool-lib" && claimed[1].id == "planted" && dropped == 4);
        CHECK(Smith::HostedCrewCreatedFromClaim("not json", dropped).empty() && Smith::HostedCrewCreatedFromClaim("{}", dropped).empty());

        // Pushing: each folder becomes the first commit on main, with a git dir outside the folder and the member's own gitconfig (the
        // system config kept); the planted repository is refused before any git runs for it.
        const auto d = Smith::HostedCrewDirsFor((testRoot / "created").string(), "member1", "0123456789abcdef0123456789abcdef0123");
        fs::create_directories(d.runControl); fs::remove_all(d.newProject); fs::rename(root, d.newProject);
        std::vector<std::pair<std::vector<std::string>, std::map<std::string, std::string>>> calls; std::vector<std::string> said;
        Smith::HostedCrewGitIo io;
        io.git = [&](const std::vector<std::string>& args, const std::string& cwd, const std::map<std::string, std::string>& env) {
            calls.push_back({args, env}); CHECK(cwd == (fs::path(d.newProject) / "tool-lib").string()); return 0; };
        io.capture = [&](const std::vector<std::string>&, const std::string&, const std::map<std::string, std::string>&) { return std::string(40, 'b') + "\n"; };
        io.status = [&](const std::string& text) { said.push_back(text); };
        io.stopped = [] { return false; };
        std::vector<std::vector<std::string>> scans; int scanResult = 0;
        io.scan = [&](const std::vector<std::string>& args, const std::string& cwd) { scans.push_back(args); CHECK(cwd == (fs::path(d.newProject) / "tool-lib").string()); return scanResult; };
        const auto pushed = Smith::HostedCrewPushCreated(claimed, d, "Toolsmith", "toolsmith", "0123456789abcdef0123456789abcdef0123", io);
        CHECK(pushed.size() == 1 && pushed[0].id == "tool-lib" && pushed[0].commit == std::string(40, 'b'));
        const std::string gitDir = "--git-dir=" + (fs::path(d.runControl) / "new-project-tool-lib.git").string(), workTree = "--work-tree=" + (fs::path(d.newProject) / "tool-lib").string();
        CHECK(calls.size() == 4 && calls[0].first == (std::vector<std::string>{gitDir, workTree, "init", "-q"}) && calls[1].first == (std::vector<std::string>{gitDir, workTree, "add", "-A"}));
        CHECK(calls.size() == 4 && std::find(calls[2].first.begin(), calls[2].first.end(), "--author=Toolsmith (Smith crew) <crew-toolsmith@smith.invalid>") != calls[2].first.end());
        CHECK(calls.size() == 4 && calls[3].first == (std::vector<std::string>{gitDir, workTree, "push", "--no-verify", remote, "HEAD:refs/heads/main"}));
        for (const auto& call : calls) CHECK(!call.second.count("GIT_CONFIG_NOSYSTEM") && call.second.at("GIT_CONFIG_GLOBAL") == d.gitconfig);
        CHECK(calls.size() == 4 && calls[3].second.at("GIT_CONFIG_VALUE_0") == "Authorization: Bearer art_v1_w?expires=1");
        CHECK(std::any_of(said.begin(), said.end(), [](const std::string& s) { return s.find("new-project/planted") != std::string::npos; }));
        // The staged change is searched for the turn's secrets between add and commit, as CommitAll does for a run's own change.
        CHECK((scans == std::vector<std::vector<std::string>>{{gitDir, workTree, "diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--text"}}));
        for (const int found : {1, -1}) {   // a secret in it, or a search git could not run: nothing is committed or pushed
            calls.clear(); said.clear(); scanResult = found;
            CHECK(Smith::HostedCrewPushCreated(claimed, d, "Toolsmith", "toolsmith", "0123456789abcdef0123456789abcdef0123", io).empty() && calls.size() == 2);
            CHECK(std::any_of(said.begin(), said.end(), [&](const std::string& s) { return s.find(found > 0 ? "contained a secret" : "could not check") != std::string::npos; }));
        }
        scanResult = 0;
        // A push git refuses reports nothing for that project.
        calls.clear(); io.git = [&](const std::vector<std::string>& args, const std::string&, const std::map<std::string, std::string>& env) { calls.push_back({args, env}); return args.size() > 2 && args[2] == "push" ? 1 : 0; };
        CHECK(Smith::HostedCrewPushCreated(claimed, d, "Toolsmith", "toolsmith", "0123456789abcdef0123456789abcdef0123", io).empty() && calls.size() == 4);
        fs::remove_all(testRoot / "created");
    }
    std::filesystem::remove_all(testRoot);

    // ---- Repository projects: scans and branch-tip builds ----
    {
        Smith::JobSpec scan; scan.kind = "scan";
        scan.repos.push_back({"main", "git@github.com:Red-Marmoset/senet.git", "", "", ".", ""});
        CHECK(Smith::ValidateHostedSpec(scan).empty());                 // no commit, no command needed
        scan.repos[0].branch = "../x"; CHECK(!Smith::ValidateHostedSpec(scan).empty());
        scan.repos[0].branch = "feature/x"; CHECK(Smith::ValidateHostedSpec(scan).empty());
        scan.repos.push_back(scan.repos[0]); scan.repos[1].checkoutDir = "other"; CHECK(!Smith::ValidateHostedSpec(scan).empty());

        Smith::JobSpec tip; tip.repos.push_back({"main", "https://github.com/o/r.git", "main", "", ".", ""});
        CHECK(!Smith::ValidateHostedSpec(tip).empty());                  // an empty commit needs a resolve action
        tip.resolve.action = "build-check"; CHECK(Smith::ValidateHostedSpec(tip).empty());
        tip.kind = "mirror"; CHECK(!Smith::ValidateHostedSpec(tip).empty());
        tip.kind = "build"; tip.resolve.action = std::string("bad\naction"); CHECK(!Smith::ValidateHostedSpec(tip).empty());

        CHECK(Smith::HostedClassifyGitFailure({"git@github.com: Permission denied (publickey).", "fatal: Could not read from remote repository."}) == "repo_access");
        CHECK(Smith::HostedClassifyGitFailure({"ERROR: Repository not found."}) == "repo_access");
        CHECK(Smith::HostedClassifyGitFailure({"remote: Repository not found.", "fatal: repository 'https://github.com/o/r.git/' not found"}) == "repo_access");
        CHECK(Smith::HostedClassifyGitFailure({"fatal: could not read Username for 'https://github.com': terminal prompts disabled"}) == "repo_access");
        CHECK(Smith::HostedClassifyGitFailure({"ssh: Could not resolve hostname github.com: No such host is known.", "fatal: Could not read from remote repository."}).empty());
        CHECK(Smith::HostedClassifyGitFailure({"fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"}).empty());
        // The line worth showing a person: the refusal itself, else git's last fatal line.
        CHECK(Smith::HostedGitFailureReason({"Cloning into 'x'...", "git@github.com: Permission denied (publickey).", "fatal: Could not read from remote repository."}) == "git@github.com: Permission denied (publickey).");
        CHECK(Smith::HostedGitFailureReason({"Cloning into 'x'...", "fatal: unable to access 'https://h/': Could not resolve host: h", ""}) == "fatal: unable to access 'https://h/': Could not resolve host: h");
        CHECK(Smith::HostedGitFailureReason({}).empty());
        CHECK(Smith::HostedGitFailureReason({std::string(500, 'x')}).size() == 200);

        std::vector<std::string> many(25000, std::string(10, 'p'));
        const auto report = Smith::HostedScanReport(std::string(40, 'a'), "main", true, "{\"project\":{\"id\":\"x\"}}", many);
        CHECK(report.find("\"truncated\":true") != std::string::npos);
        CHECK(report.find("\"smithJson\":\"{\\\"project\\\"") != std::string::npos);
        CHECK(Smith::HostedScanReport(std::string(40, 'a'), "main", false, "", {"a"}).find("\"smithJson\":null") != std::string::npos);
        bool threw = false; try { Smith::HostedScanReport(std::string(40, 'a'), "main", true, std::string(256 * 1024 + 1, ' '), {}); } catch (const std::exception&) { threw = true; }
        CHECK(threw);
    }
    {
        // Self-update: the heartbeat offer, package entries, and the swap with its undo.
        Smith::HostedUpdateOffer offer;
        const std::string sha(64, 'c');
        CHECK(Smith::HostedParseUpdateOffer("{\"accepted\":true,\"update\":{\"version\":\"hosted-0123456789ab\",\"sha256\":\"" + sha + "\",\"size\":10}}", offer));
        CHECK(offer.version == "hosted-0123456789ab" && offer.sha256 == sha && offer.size == 10);
        CHECK(!Smith::HostedParseUpdateOffer("{\"accepted\":true}", offer));
        CHECK(!Smith::HostedParseUpdateOffer("{\"update\":{\"version\":\"latest\"}}", offer));
        CHECK(!Smith::HostedParseUpdateOffer("{\"update\":{\"version\":\"hosted-0123456789ab\",\"sha256\":\"zz\"}}", offer));
        CHECK(!Smith::HostedParseUpdateOffer("{\"update\":{\"version\":\"hosted-0123456789ab\",\"size\":0}}", offer));
        CHECK(!Smith::HostedParseUpdateOffer("not json", offer));
        CHECK(Smith::HostedPackageEntryValid("Smith.exe") && Smith::HostedPackageEntryValid("start-smith.sh") && Smith::HostedPackageEntryValid("libc++.so.1"));
        CHECK(!Smith::HostedPackageEntryValid("../Smith.exe") && !Smith::HostedPackageEntryValid("sub/Smith") && !Smith::HostedPackageEntryValid("sub\\Smith"));
        CHECK(!Smith::HostedPackageEntryValid(".update-previous") && !Smith::HostedPackageEntryValid("") && !Smith::HostedPackageEntryValid("a b"));

        namespace ufs = std::filesystem;
        const ufs::path dir = ufs::temp_directory_path() / ("smith-update-" + Smith::MakeUuid());
        const ufs::path install = dir / "install", staging = install / ".update-staging";
        ufs::create_directories(staging);
        auto write = [](const ufs::path& path, const std::string& text) { std::ofstream(path, std::ios::binary) << text; };
        auto read = [](const ufs::path& path) { std::ifstream in(path, std::ios::binary); std::stringstream text; text << in.rdbuf(); return text.str(); };
        write(install / "Smith", "old binary"); write(install / "keep.txt", "untouched");
        write(staging / "Smith", "new binary"); write(staging / "added.txt", "new file");
        Smith::HostedApplyStagedPackage(install.string(), staging.string(), "hosted-aaaaaaaaaaaa", "hosted-bbbbbbbbbbbb");
        CHECK(read(install / "Smith") == "new binary" && read(install / "added.txt") == "new file" && read(install / "keep.txt") == "untouched");
        CHECK(read(install / ".update-previous" / "Smith") == "old binary" && !ufs::exists(staging));
        CHECK(Smith::HostedPendingUpdate(install.string()) == "hosted-bbbbbbbbbbbb");
        CHECK(Smith::HostedRejectedVersion(install.string()).empty());
        Smith::HostedConfirmUpdate(install.string());
        CHECK(Smith::HostedPendingUpdate(install.string()).empty() && !ufs::exists(install / ".update-previous"));
        // What the launcher does on a failed start: the pending marker becomes the rejected one.
        write(install / "update-rejected.json", "{\"from\":\"hosted-aaaaaaaaaaaa\",\"to\":\"hosted-cccccccccccc\",\"at\":\"x\"}");
        CHECK(Smith::HostedRejectedVersion(install.string()) == "hosted-cccccccccccc");
        std::error_code ec; ufs::remove_all(dir, ec);
    }
    const auto cacheRoot = std::filesystem::temp_directory_path() / ("smith-repo-cache-test-" + Smith::MakeUuid());
    std::filesystem::create_directories(cacheRoot);
    {   // one shared store per repository: every spelling of a repository's URL maps to the same cache
        CHECK(Smith::HostedCanonicalRepoUrl("https://github.com/Owner/Repo.git") == "https://github.com/owner/repo");
        CHECK(Smith::HostedCanonicalRepoUrl("HTTPS://GitHub.com/owner/repo/") == "https://github.com/owner/repo");
        CHECK(Smith::HostedCanonicalRepoUrl("https://x-access-token@github.com/owner/repo") == "https://github.com/owner/repo");
        CHECK(Smith::HostedCanonicalRepoUrl("git@github.com:owner/repo.git") == "ssh://github.com/owner/repo");
        CHECK(Smith::HostedCanonicalRepoUrl("ssh://git@github.com/owner/repo.git") == "ssh://github.com/owner/repo");
        // Elsewhere the path keeps its case: two Artifacts namespaces that differ only by case stay apart.
        CHECK(Smith::HostedCanonicalRepoUrl("https://acct.artifacts.cloudflare.net/git/Ns/Repo.git") == "https://acct.artifacts.cloudflare.net/git/Ns/Repo");
        CHECK(Smith::HostedCanonicalRepoUrl("https://acct.artifacts.cloudflare.net/git/ns/repo") != Smith::HostedCanonicalRepoUrl("https://acct.artifacts.cloudflare.net/git/Ns/Repo"));
        CHECK(Smith::HostedCanonicalRepoUrl("C:\\repos\\thing\\") == "C:\\repos\\thing" && Smith::HostedCanonicalRepoUrl("/srv/git/thing/") == "/srv/git/thing");   // a local path is itself
        const auto a = Smith::HostedRepoCachePath("/w", "https://github.com/owner/repo.git"), b = Smith::HostedRepoCachePath("/w", "git@github.com:Owner/Repo");
        CHECK(a != b && a.parent_path() == std::filesystem::path("/w") / "repos" && a.extension() == ".git");
        CHECK(Smith::HostedRepoCachePath("/w", "https://github.com/owner/repo") == a && Smith::HostedRepoCachePath("/w", "https://GITHUB.com/Owner/Repo/") == a);
        CHECK(!Smith::HostedRepoCacheExists(cacheRoot, "https://github.com/owner/repo"));
    }
    {   // the cache end to end against a local remote: a second workspace's job finds the store filled and clones from it
        namespace fs = std::filesystem;
        const auto remote = cacheRoot / "remote.git", work = cacheRoot / "remote-work", node = cacheRoot / "node";
        std::vector<std::string> trace;
        const Smith::HostedGitRunFn git = [&](std::vector<std::string> argv, const fs::path& cwd, const std::map<std::string, std::string>& env,
                                              std::vector<std::string>* out, std::vector<std::string>* errors) {
            trace.push_back(argv.size() > 1 ? argv[1] : "");
            Smith::Process process; Smith::ProcessOptions options; options.argv = std::move(argv); options.workingDir = cwd.string(); options.timeoutSeconds = 120;
            options.envOverride = env; options.envOverride["GIT_TERMINAL_PROMPT"] = "0";
            return process.Run(options, [&](bool error, const std::string& line) { if (out && !error) out->push_back(line); if (errors && error) errors->push_back(line); });
        };
        auto plain = [&](std::vector<std::string> args, const fs::path& cwd, std::vector<std::string>* out = nullptr) {
            args.insert(args.begin(), "git"); return git(std::move(args), cwd, {}, out, nullptr);
        };
        auto head = [&](const fs::path& dir, const std::string& ref = "HEAD") { std::vector<std::string> out; plain({"rev-parse", ref}, dir, &out); return out.empty() ? std::string() : out[0]; };
        fs::create_directories(work);
        CHECK(plain({"init", "--quiet", "--initial-branch=trunk"}, work) == 0);
        CHECK(plain({"-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--allow-empty", "-m", "one"}, work) == 0);
        const auto first = head(work);
        CHECK(plain({"-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--allow-empty", "-m", "two"}, work) == 0);
        const auto second = head(work);
        CHECK(plain({"clone", "--quiet", "--bare", "--", work.string(), remote.string()}, cacheRoot) == 0);
        CHECK(plain({"symbolic-ref", "HEAD", "refs/heads/trunk"}, remote) == 0);
        const std::string url = remote.string();
        const auto cache = Smith::HostedRepoCachePath(node, url);
        std::vector<std::string> errors;
        // Workspace A builds the pinned commit: the store is created and filled.
        { const auto lock = Smith::HostedLockRepoCache(cache); CHECK(Smith::HostedUpdateRepoCache(cache, url, first, {}, git, &errors)); }
        CHECK(errors.empty() && Smith::HostedRepoCacheExists(node, url) && head(cache, "refs/heads/trunk") == second && head(cache) == second);
        CHECK(Smith::HostedCloneFromRepoCache(cache, url, "", node / "jobs" / "a" / "src", git, &errors));
        std::vector<std::string> origin; plain({"remote", "get-url", "origin"}, node / "jobs" / "a" / "src", &origin);
        CHECK(!origin.empty() && origin[0] == url);   // the checkout's remote is the real one, not the store
        CHECK(plain({"checkout", "--quiet", "--detach", first}, node / "jobs" / "a" / "src") == 0 && head(node / "jobs" / "a" / "src") == first);
        // Workspace B (a chat, say) wants the same repository by another spelling: no second clone, a fetch into the one store.
        trace.clear();
        const std::string spelt = url + "/";
        CHECK(Smith::HostedRepoCachePath(node, spelt) == cache);
        { const auto lock = Smith::HostedLockRepoCache(cache); CHECK(Smith::HostedUpdateRepoCache(cache, spelt, second, {}, git, &errors)); }
        CHECK(std::count(trace.begin(), trace.end(), "init") == 0 && std::count(trace.begin(), trace.end(), "fetch") == 1);
        CHECK(Smith::HostedCloneFromRepoCache(cache, spelt, "trunk", node / "ai" / "s" / "repo", git, &errors) && head(node / "ai" / "s" / "repo") == second);
        // Only one history on disk: the two checkouts hard-link the store's objects (the same inode on POSIX).
        std::error_code ec;
#ifndef _WIN32
        size_t shared = 0;
        for (fs::recursive_directory_iterator it(node / "jobs" / "a" / "src" / ".git" / "objects", ec), end; !ec && it != end; it.increment(ec))
            if (it->is_regular_file() && fs::hard_link_count(it->path(), ec) > 1) ++shared;
        CHECK(shared > 0);
#endif
        // A commit the remote gains later is fetched by the next update, and a store Git cannot read is rebuilt.
        CHECK(plain({"-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--allow-empty", "-m", "three"}, work) == 0);
        CHECK(plain({"push", "--quiet", "--", remote.string(), "trunk:trunk"}, work) == 0);
        const auto third = head(work);
        { const auto lock = Smith::HostedLockRepoCache(cache); CHECK(Smith::HostedUpdateRepoCache(cache, url, third, {}, git, &errors) && head(cache) == third); }
        { std::error_code wipe; fs::remove_all(cache / "objects", wipe); } { std::ofstream(cache / "HEAD") << "garbage\n"; }
        trace.clear(); errors.clear();
        { const auto lock = Smith::HostedLockRepoCache(cache); CHECK(Smith::HostedUpdateRepoCache(cache, url, third, {}, git, &errors)); }
        CHECK(std::count(trace.begin(), trace.end(), "init") == 1 && head(cache) == third);
        // A remote that cannot be reached fails with Git's reason, and a store made for it is not left behind
        // (a later scan of that repository keeps its cheap shallow path).
        errors.clear();
        const std::string missing = (cacheRoot / "no-such.git").string();
        CHECK(!Smith::HostedUpdateRepoCache(Smith::HostedRepoCachePath(node, missing), missing, "", {}, git, &errors) && !errors.empty());
        CHECK(!Smith::HostedRepoCacheExists(node, missing));
    }
    { std::error_code ec; std::filesystem::remove_all(cacheRoot, ec); }
    // Smith-hosted git: this machine as a host for Smith's copies, and builds that use them.
    {
        using namespace Smith;
        CHECK(HostedGitVersion("git version 2.39.5 (Apple Git-154)") == "2.39.5");
        CHECK(HostedGitVersion("git version 2.47.1.windows.1") == "2.47.1");
        CHECK(HostedGitVersion("git version 2.36.0") == "2.36.0" && HostedGitVersion("bash: git: command not found").empty() && HostedGitVersion("").empty());
        CHECK(HostedGitVersionAtLeast("2.36.0", 2, 36) && HostedGitVersionAtLeast("3.0", 2, 36) && HostedGitVersionAtLeast("2.47.1", 2, 36));
        CHECK(!HostedGitVersionAtLeast("2.35.9", 2, 36) && !HostedGitVersionAtLeast("2.30", 2, 36) && !HostedGitVersionAtLeast("", 2, 36));
        const int64_t gb = 1024LL * 1024 * 1024;
        CHECK(HostedGitHostAbility("git version 2.43.0", true, 50 * gb, true).able);
        CHECK(HostedGitHostAbility("", true, 50 * gb, true).reason == "git is not installed or not on PATH");
        CHECK(HostedGitHostAbility("git version 2.28.0", true, 50 * gb, true).reason == "git 2.28.0 is older than 2.36");
        CHECK(HostedGitHostAbility("git version 2.35.1", true, 50 * gb, true).reason == "git 2.35.1 is older than 2.36");
        CHECK(!HostedGitHostAbility("git version 2.43.0", false, 50 * gb, true).able);
        CHECK(HostedGitHostAbility("git version 2.43.0", true, gb + gb / 5, true).reason == "only 1.2 GB free");
        CHECK(!HostedGitHostAbility("git version 2.43.0", true, 50 * gb, false).able);
        CHECK(HostedRefGlob("refs/heads/*", "refs/heads/feature/x") && HostedRefGlob("refs/heads/smith/crew-ab-*", "refs/heads/smith/crew-ab-1") && HostedRefGlob("refs/heads/main", "refs/heads/main"));
        CHECK(!HostedRefGlob("refs/heads/*", "refs/tags/v1") && !HostedRefGlob("refs/heads/smith/crew-ab-*", "refs/heads/smith/crew-ac-1") && !HostedRefGlob("", "refs/heads/main"));
        const auto policy = HostedParseRefPolicy(R"({"allow":["refs/heads/*","refs/tags/*","bad ref"],"protected":["refs/heads/main"],"denyDelete":false})");
        CHECK(policy.allow.size() == 2 && policy.protectedRefs.size() == 1 && !policy.denyDelete);
        CHECK(HostedParseRefPolicy("not json").allow.empty() && HostedParseRefPolicy(R"({"denyDelete":true})").denyDelete);
        CHECK(HostedGitServeArgv("upload-pack", "info-refs", "/s/r.git") == std::vector<std::string>({"git", "upload-pack", "--http-backend-info-refs", "/s/r.git"}));
        CHECK(HostedGitServeArgv("receive-pack", "rpc", "/s/r.git") == std::vector<std::string>({"git", "receive-pack", "--stateless-rpc", "/s/r.git"}));
        CHECK(HostedGitServeArgv("http-backend", "rpc", "/s/r.git").empty() && HostedGitServeArgv("upload-pack", "cgi", "/s/r.git").empty() && HostedGitServeArgv("upload-pack", "rpc", "").empty());
        auto env = HostedGitServeEnv("version=2", policy, "/dev/null");
        CHECK(env["GIT_PROTOCOL"] == "version=2" && env["GIT_CONFIG_NOSYSTEM"] == "1" && env["GIT_CONFIG_GLOBAL"] == "/dev/null" && env["GIT_TERMINAL_PROMPT"] == "0");
        CHECK(env["SMITH_ALLOWED_REFS"] == "refs/heads/* refs/tags/*" && env["SMITH_PROTECTED_REFS"] == "refs/heads/main" && env["SMITH_DENY_DELETE"] == "0");
        CHECK(!HostedGitServeEnv("", policy, "/dev/null").count("GIT_PROTOCOL") && !HostedGitServeEnv("version=2; rm -rf", policy, "/dev/null").count("GIT_PROTOCOL"));
        const auto unset = HostedGitServeEnvUnset();
        CHECK(std::find(unset.begin(), unset.end(), "GIT_*") != unset.end() && std::find(unset.begin(), unset.end(), "GITHUB_TOKEN") != unset.end());
        CHECK(HostedGitInfoRefsPreamble("upload-pack") == "001e# service=git-upload-pack\n0000" && HostedGitInfoRefsPreamble("receive-pack") == "001f# service=git-receive-pack\n0000");
        CHECK(HostedPktErr("No host") == "0010ERR No host\n" && HostedPktErr("a\nb") == "000cERR a b\n");
        const std::string zero(40, '0'), sha(40, 'a');
        auto pkt = [](const std::string& payload) { char n[8]; snprintf(n, sizeof n, "%04x", (unsigned)(payload.size() + 4)); return n + payload; };
        CHECK(HostedGitRefuseReceive(pkt(zero + " " + sha + " refs/heads/main\0report-status side-band-64k"s) + "0000PACK").empty());
        CHECK(HostedGitRefuseReceive(pkt(sha + " " + sha + " refs/heads/a\n") + pkt(sha + " " + zero + " refs/heads/b\n") + "0000").empty());
        CHECK(HostedGitRefuseReceive(pkt("shallow " + sha + "\n") + pkt(zero + " " + sha + " refs/heads/main\n") + "0000") == "pushes from shallow clones are not accepted");
        CHECK(HostedGitRefuseReceive(pkt(zero + " " + sha + " refs/heads/main\0report-status push-cert=abc"s) + "0000") == "signed pushes are not accepted");
        CHECK(HostedGitRefuseReceive(pkt(zero + " " + sha + " refs/heads/main\0report-status push-options"s) + "0000") == "push options are not accepted");
        CHECK(HostedGitRefuseReceive("0000") == "the push names no refs" && HostedGitRefuseReceive("PACK....") == "the push command list could not be read" && HostedGitRefuseReceive("").find("could not be read") != std::string::npos);
        CHECK(HostedGitRefuseReceive(pkt("garbage line\n") + "0000") == "the push command list could not be read");
        CHECK(HostedGitRefuseReceive(pkt(zero + " " + sha + " refs/heads/main\n").substr(0, 20)).empty());   // only the head was read
        const auto hook = HostedGitUpdateHook();
        CHECK(hook.rfind("#!/bin/sh\n", 0) == 0 && hook.find("set -f") != std::string::npos && hook.find("merge-base --is-ancestor") != std::string::npos && hook.find("refs/smith/*") != std::string::npos && hook.find('\r') == std::string::npos);
        auto tips = HostedGitParseTips(sha + " refs/heads/main\n" + std::string(40, 'b') + " refs/tags/v1\n" + std::string(40, 'c') + " refs/smith/recovered/x\n" + std::string(40, 'd') + " refs/heads/feature\r\n");
        CHECK(tips.size() == 3 && tips[0].second == "refs/heads/feature" && tips[1].second == "refs/heads/main" && tips[2].second == "refs/tags/v1" && tips[1].first == sha);
        CHECK(HostedGitTipsJson(tips).rfind("[[\"dddd", 0) == 0);
        // Annotated tags carry what they point to (a third column); plain refs leave it empty.
        bool threw = false; std::map<std::string, std::string> peeled;
        const auto withPeeled = HostedGitParseTips(sha + " refs/heads/main \n" + std::string(40, 'b') + " refs/tags/v1 " + std::string(40, 'e') + "\n", &peeled);
        CHECK(withPeeled.size() == 2 && peeled.size() == 1 && peeled["refs/tags/v1"] == std::string(40, 'e'));
        CHECK(HostedGitPeeledJson(peeled) == "{\"refs/tags/v1\":\"" + std::string(40, 'e') + "\"}" && HostedGitPeeledJson({}) == "{}");
        threw = false; try { HostedGitParseTips(sha + " refs/tags/v1 notasha\n"); } catch (const std::exception&) { threw = true; } CHECK(threw);
        threw = false; try { HostedGitParseTips("nonsense\n"); } catch (const std::exception&) { threw = true; } CHECK(threw);
        threw = false; try { HostedGitParseTips(sha + " refs/heads/bad..ref\n"); } catch (const std::exception&) { threw = true; } CHECK(threw);
        CHECK(HostedGitCountedBytes({"count: 3", "size: 12", "in-pack: 9", "size-pack: 100", "garbage: 0"}) == 112 * 1024);
        const auto config = HostedGitStoreConfig("/h");
        CHECK(std::find(config.begin(), config.end(), std::make_pair(std::string("receive.fsckObjects"), std::string("true"))) != config.end());
        CHECK(std::find(config.begin(), config.end(), std::make_pair(std::string("core.hooksPath"), std::string("/h"))) != config.end());
        const std::string ws(64, 'f'), uuid = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
        CHECK(HostedGitUuidValid(uuid) && !HostedGitUuidValid("../x") && !HostedGitUuidValid("ABC") && !HostedGitUuidValid("short"));
        CHECK(std::filesystem::path(HostedGitStorePath("/root", ws, uuid)) == std::filesystem::path("/root") / "git" / "ffffffffffff" / (uuid + ".git"));
        threw = false; try { HostedGitStorePath("/root", ws, "../escape"); } catch (const std::exception&) { threw = true; } CHECK(threw);
        threw = false; try { HostedGitStorePath("/root", "short", uuid); } catch (const std::exception&) { threw = true; } CHECK(threw);
        CHECK(HostedGitDiskSufficient(4 * gb, 100 * 1024 * 1024) && !HostedGitDiskSufficient(gb, 100 * 1024 * 1024) && !HostedGitDiskSufficient(10 * gb, -1));
        const auto completion = nlohmann::json::parse(HostedGitCompletionJson("r1", "lease", 200, 1234, "", HostedGitTipsJson(tips), 5000));
        CHECK(completion["relayId"] == "r1" && completion["leaseToken"] == "lease" && completion["status"] == 200 && completion["size"] == 1234 && completion["tips"].size() == 3 && completion["bytes"] == 5000);
        const auto plain = nlohmann::json::parse(HostedGitCompletionJson("r1", "lease", 500, 0, "git failed", "", -1));
        CHECK(!plain.contains("tips") && !plain.contains("bytes") && plain["message"] == "git failed");
        CHECK(HostedGitPollDelayMs(100000, 90000, false) == 500 && HostedGitPollDelayMs(100000, 30000, false) == 3000 && HostedGitPollDelayMs(100000, 0, false) == 3000 && HostedGitPollDelayMs(100000, 99000, true) == 600000);
        // Smith remotes and the ticket environment, once the agent knows its coordinator.
        HostedSetCoordinator("https://exp.example.test", "smn.node-secret");
        CHECK(HostedSmithRemote("https://exp.example.test/git/soccer-boy.git") && HostedCredentialRemote("https://exp.example.test/git/soccer-boy.git"));
        for (const auto& bad : {"https://exp.example.test/git/soccer-boy", "https://exp.example.test/git/Soccer.git", "https://other.example.test/git/soccer-boy.git", "https://exp.example.test/git/a/b.git", "https://exp.example.test/git/../x.git", "http://exp.example.test/git/x.git"}) CHECK(!HostedSmithRemote(bad));
        auto ticketEnv = HostedGitAuthEnv("https://exp.example.test/git/soccer-boy.git", "smith_git_ticket");
        CHECK(ticketEnv["GIT_CONFIG_COUNT"] == "3");
        CHECK(ticketEnv["GIT_CONFIG_KEY_0"] == "http.https://exp.example.test/git/soccer-boy.git/.extraheader" && ticketEnv["GIT_CONFIG_VALUE_0"] == "Authorization: Bearer smith_git_ticket");
        CHECK(ticketEnv["GIT_CONFIG_KEY_1"] == "http.https://exp.example.test/git/soccer-boy.git/.extraheader" && ticketEnv["GIT_CONFIG_VALUE_1"] == "X-Smith-Node: smn.node-secret");
        CHECK(ticketEnv["GIT_CONFIG_KEY_2"] == "credential.helper" && ticketEnv["GIT_CONFIG_VALUE_2"].empty());
        for (const auto& kv : ticketEnv) CHECK(kv.first.find("smith_git") == std::string::npos && kv.first.find("node-secret") == std::string::npos);
        // Large files: lfs.url and the ticket header ride the same git config env, renumbered after what is there.
        Smith::JobSpec lfsSpec; lfsSpec.lfs.url = "https://exp.example.test/git/senet.git"; lfsSpec.lfs.authToken = "smith_git_lfs";
        auto lfsEnv = HostedLfsEnv(lfsSpec, HostedGitAuthEnv("https://github.com/example/repo.git", ""));
        CHECK(lfsEnv["GIT_CONFIG_COUNT"] == "3");
        CHECK(lfsEnv["GIT_CONFIG_KEY_0"] == "lfs.url" && lfsEnv["GIT_CONFIG_VALUE_0"] == "https://exp.example.test/git/senet.git/info/lfs");
        CHECK(lfsEnv["GIT_CONFIG_KEY_1"] == "http.https://exp.example.test/git/senet.git/.extraheader" && lfsEnv["GIT_CONFIG_VALUE_1"] == "Authorization: Bearer smith_git_lfs");
        CHECK(lfsEnv["GIT_CONFIG_KEY_2"] == "http.https://exp.example.test/git/senet.git/.extraheader" && lfsEnv["GIT_CONFIG_VALUE_2"] == "X-Smith-Node: smn.node-secret");
        // Same remote as the checkout: the header is already there, only lfs.url is added.
        lfsSpec.lfs.authToken = "smith_git_ticket";
        auto merged = HostedLfsEnv(lfsSpec, HostedGitAuthEnv("https://exp.example.test/git/senet.git", "smith_git_ticket"));
        CHECK(merged["GIT_CONFIG_COUNT"] == "4" && merged["GIT_CONFIG_KEY_3"] == "lfs.url");
        Smith::JobSpec noLfs; CHECK(HostedLfsEnv(noLfs, {{"GIT_TERMINAL_PROMPT", "0"}}).size() == 1);
        // Validation: only Smith remotes with a plain ticket.
        Smith::JobSpec lfsBuild; lfsBuild.command = {"exe", "cmd.exe", {"/d", "/c", "echo hello"}};
        lfsBuild.repos.push_back({"main", "https://github.com/example/repo.git", "main", "0123456789abcdef0123456789abcdef01234567", "main", ""});
        CHECK(ValidateHostedSpec(lfsBuild).empty());
        lfsBuild.lfs = {"https://exp.example.test/git/senet.git", "smith_git_t"}; CHECK(ValidateHostedSpec(lfsBuild).empty());
        lfsBuild.lfs.url = "https://github.com/example/repo.git"; CHECK(ValidateHostedSpec(lfsBuild) == "Invalid large-file source");
        lfsBuild.lfs.url = "https://exp.example.test/git/senet.git"; lfsBuild.lfs.authToken = "bad token"; CHECK(ValidateHostedSpec(lfsBuild) == "Invalid large-file source");
        lfsBuild.lfs.authToken.clear(); CHECK(ValidateHostedSpec(lfsBuild) == "Invalid large-file source");
        // Large files kept on this machine (spec §8): task parsing, the store path, the completion report, file hashing.
        {
            const auto tmp = std::filesystem::temp_directory_path() / ("smith-lfs-" + Smith::MakeUuid());
            std::filesystem::create_directories(tmp);
            { std::ofstream out(tmp / "abc", std::ios::binary); out << "abc"; }
            CHECK(Smith::HostedSha256File((tmp / "abc").string()) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
            { std::ofstream out(tmp / "big", std::ios::binary); std::string chunk(1 << 20, 'z'); for (int i = 0; i < 3; ++i) out << chunk; }
            CHECK(Smith::HostedSha256File((tmp / "big").string()) == Smith::HostedSha256(std::string(3 << 20, 'z')));
            const std::string oid(64, 'a');
            CHECK(Smith::HostedLfsObjectPath("C:/root", "ws", oid) == (std::filesystem::path("C:/root") / "lfs" / "ws" / "aa" / "aa" / oid).string());
            Smith::HostedLfsTask task; std::string problem;
            CHECK(Smith::HostedParseLfsTask(nlohmann::json({{"id", "t1"}, {"leaseToken", "lease"}, {"kind", "fetch"}, {"repoId", "senet"}, {"oid", oid}, {"size", 12}, {"leaseExpiresAt", 5}}), task, problem));
            CHECK(task.kind == "fetch" && task.repoId == "senet" && task.oid == oid && task.size == 12 && task.leaseExpiresAt == 5);
            for (const auto& bad : {nlohmann::json({{"id", "t1"}, {"leaseToken", "lease"}, {"kind", "steal"}, {"repoId", "senet"}, {"oid", oid}, {"size", 12}}),
                                    nlohmann::json({{"id", "t1"}, {"leaseToken", "lease"}, {"kind", "fetch"}, {"repoId", "senet"}, {"oid", "zz"}, {"size", 12}}),
                                    nlohmann::json({{"id", "t1"}, {"leaseToken", "lease"}, {"kind", "fetch"}, {"repoId", "../x"}, {"oid", oid}, {"size", 12}}),
                                    nlohmann::json({{"id", "t1"}, {"leaseToken", "lease"}, {"kind", "fetch"}, {"repoId", "senet"}, {"oid", oid}, {"size", -1}})})
                CHECK(!Smith::HostedParseLfsTask(bad, task, problem));
            Smith::HostedLfsTaskResult result; result.ok = true; result.size = 12;
            const auto report = nlohmann::json::parse(Smith::HostedLfsCompletionJson(task, result));
            CHECK(report["taskId"] == "t1" && report["leaseToken"] == "lease" && report["ok"] == true && report["size"] == 12 && report["message"] == "" && !report.contains("held"));
            // A restore that found no intact copy says so (held: false), so the coordinator forgets this holder; any
            // other failure keeps the copy on record and is retried.
            Smith::HostedLfsTaskResult missing; missing.message = "box holds no copy of this object"; missing.copyGone = true;
            const auto gone = nlohmann::json::parse(Smith::HostedLfsCompletionJson(task, missing));
            CHECK(gone["ok"] == false && gone["held"] == false);
            Smith::HostedLfsTaskResult transient; transient.message = "Upload failed (HTTP 502)";
            CHECK(!nlohmann::json::parse(Smith::HostedLfsCompletionJson(task, transient)).contains("held"));
            // A drop removes the copy; a fetch of a copy already held and intact is a no-op success.
            Smith::HostedGitLoopConfig config; config.workspaceRoot = tmp.string(); config.workspaceId = "ws"; config.hostname = "box";
            const auto object = std::filesystem::path(Smith::HostedLfsObjectPath(tmp.string(), "ws", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
            std::filesystem::create_directories(object.parent_path()); std::filesystem::copy_file(tmp / "abc", object);
            Smith::HostedTransport transport; std::atomic<bool> stop{false};
            Smith::HostedLfsTask have; have.id = "t2"; have.kind = "fetch"; have.repoId = "senet"; have.oid = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; have.size = 3;
            CHECK(Smith::RunHostedLfsTask(transport, config, have, stop).ok);
            have.kind = "drop"; CHECK(Smith::RunHostedLfsTask(transport, config, have, stop).ok && !std::filesystem::exists(object));
            std::filesystem::remove_all(tmp);
        }
        // Host jobs and builds from a local copy in ValidateHostedSpec.
        Smith::JobSpec host; host.jobId = "h1"; host.kind = "host"; host.timeoutSeconds = 3600;
        host.repos.push_back({}); host.repos[0].url = "https://github.com/example/repo.git"; host.repos[0].branch = "main"; host.repos[0].checkoutDir = ".";
        host.host.repoUuid = uuid; host.host.defaultBranch = "main"; host.host.maxBytes = gb;
        CHECK(ValidateHostedSpec(host).empty());
        host.repos[0].commit = std::string(40, 'a'); CHECK(ValidateHostedSpec(host).empty()); host.repos[0].commit.clear();
        host.host.repoUuid = "../x"; CHECK(!ValidateHostedSpec(host).empty()); host.host.repoUuid = uuid;
        host.repos[0].authToken = "smith_git_t"; CHECK(!ValidateHostedSpec(host).empty()); host.repos[0].authToken.clear();
        host.repos.push_back(host.repos[0]); host.repos[1].checkoutDir = "other"; CHECK(!ValidateHostedSpec(host).empty()); host.repos.pop_back();
        Smith::JobSpec build = host; build.kind = "build"; build.command.interpreter = "sh"; build.command.script = "build.sh"; build.repos[0].commit = std::string(40, 'a');
        CHECK(!ValidateHostedSpec(build).empty());   // only host jobs carry a host target
        build.host = {}; CHECK(ValidateHostedSpec(build).empty());
        build.repos[0].url = "https://exp.example.test/git/repo.git"; build.repos[0].authToken = "smith_git_ticket"; CHECK(ValidateHostedSpec(build).empty());
        build.repos[0].authToken.clear(); build.repos[0].hostedUuid = uuid; build.repos[0].tip = std::string(40, 'a'); CHECK(ValidateHostedSpec(build).empty());
        build.repos[0].tip = "abc"; CHECK(!ValidateHostedSpec(build).empty()); build.repos[0].tip.clear();
        build.repos[0].url = "https://github.com/example/repo.git"; CHECK(!ValidateHostedSpec(build).empty());   // a local copy only stands in for Smith's own repository
        HostedSetCoordinator("", "");
    }
    // Import (HostedImport.h): the pure helpers.
    {
        using namespace Smith;
        const std::string a(40, 'a'), b(40, 'b'), c(40, 'c');
        const auto blobs = HostedImportLargeBlobs({"120 " + a + " Assets/big.psd", "30 " + b + " small.txt", "500 " + c + " Assets/big.psd", "77 " + std::string(40, 'd'), "x y z"}, 100);
        CHECK(blobs.size() == 1 && blobs[0].path == "Assets/big.psd" && blobs[0].size == 500 && blobs[0].oid == c);
        CHECK(HostedImportLargeBlobs({"120 " + a + " Assets/big.psd"}, 120).empty());   // over, not at
        const auto argv = HostedImportMigrateArgv(10485760);
        CHECK(argv == std::vector<std::string>({"git", "lfs", "migrate", "import", "--everything", "--yes", "--above=10485760b"}));
        CHECK(HostedImportSlices({"1", "2", "3", "4", "5"}, 2) == std::vector<std::string>({"2", "4", "5"}));
        CHECK(HostedImportSlices({}, 2).empty() && HostedImportSlices({"1"}, 0) == std::vector<std::string>({"1"}));
        CHECK(HostedImportStoreBytes({"count: 3", "size: 12", "in-pack: 9", "size-pack: 1024", "garbage: 0"}) == 1036 * 1024);
        HostedImportOutcome o; o.rewritten = true; o.commit = a; o.branch = "main"; o.scanJson = "{\"commit\":\"" + a + "\",\"branch\":\"main\",\"smithJson\":null,\"paths\":[],\"truncated\":false}";
        o.movedFiles = 2; o.movedBytes = 620; o.lfsObjects = 2; o.lfsBytes = 620; o.bundleSize = 99; o.bundleSha256 = std::string(64, 'e');
        const auto report = nlohmann::json::parse(HostedImportReportJson(o));
        CHECK(report["rewritten"] == true && report["commit"] == a && report["scan"]["branch"] == "main" && report["movedFiles"] == 2 && report["originalBundle"]["size"] == 99 && report["originalBundle"]["sha256"] == std::string(64, 'e'));
        HostedImportOutcome plain; plain.commit = b; plain.branch = "main"; plain.scanJson = o.scanJson;
        CHECK(!nlohmann::json::parse(HostedImportReportJson(plain)).contains("originalBundle"));
        // ValidateHostedSpec: an import job names its source, Artifacts target, Smith remote and threshold; nothing else.
        HostedSetCoordinator("https://exp.example.test", "smn.node-secret");
        JobSpec spec; spec.kind = "import"; spec.import.source = "git@github.com:Red-Marmoset/senet.git"; spec.import.artifactsRemote = "https://" + std::string(32, 'a') + ".artifacts.cloudflare.net/git/default/ws-senet.git";
        spec.import.artifactsToken = "art_v1_x"; spec.import.smithRemote = HostedCoordinatorOrigin() + "/git/senet.git"; spec.import.thresholdBytes = 10485760; spec.import.maxRepoBytes = 1073741824; spec.import.originalBlob = "original.bundle";
        spec.lfs.url = spec.import.smithRemote; spec.lfs.authToken = "smith_git_t";
        CHECK(ValidateHostedSpec(spec).empty());
        JobSpec bad = spec; bad.import.thresholdBytes = 40 * 1024 * 1024; CHECK(ValidateHostedSpec(bad) == "Import threshold must be 1 MiB to 32 MiB");
        bad = spec; bad.import.artifactsRemote = "https://github.com/x/y.git"; CHECK(ValidateHostedSpec(bad) == "An import pushes to Smith's storage only");
        bad = spec; bad.import.artifactsToken = "bad token"; CHECK(ValidateHostedSpec(bad) == "Invalid storage token");
        bad = spec; bad.repos.push_back({}); CHECK(ValidateHostedSpec(bad) == "An import names its source in the import field");
        bad = spec; bad.lfs.url = ""; bad.lfs.authToken = ""; CHECK(ValidateHostedSpec(bad) == "An import needs its large-file ticket");
        bad = spec; bad.import.originalBlob = "../x"; CHECK(ValidateHostedSpec(bad) == "Invalid blob name");
        JobSpec build; build.kind = "build"; build.import.source = "x"; CHECK(ValidateHostedSpec(build) == "Only import jobs may carry an import source");
        HostedSetCoordinator("", "");
    }
    // Real git: an import mirrors a source, finds large blobs, bundles the original, rewrites to LFS (when git-lfs is here),
    // pushes to a local "Artifacts" and reports. git-lfs absent: the rewrite is refused with a reason instead.
    {
        using namespace Smith; namespace gfs = std::filesystem;
        const gfs::path root = gfs::temp_directory_path() / ("smith-import-" + MakeUuid()); gfs::create_directories(root);
        auto run = [&](const std::vector<std::string>& argv, const std::string& cwd, const std::map<std::string, std::string>& env, std::vector<std::string>* out, std::vector<std::string>* errors, const std::string& stdoutFile) {
            Process process; ProcessOptions options; options.argv = argv; options.workingDir = cwd; options.timeoutSeconds = 300; options.envOverride = env; options.stopWithParent = true; options.stdoutFile = stdoutFile;
            if (!process.Start(options, [&](bool isError, const std::string& line) { if (isError) { if (errors) errors->push_back(line); } else if (out) out->push_back(line); })) return -1;
            return process.Wait();
        };
        auto git = [&](const gfs::path& cwd, std::vector<std::string> args, std::vector<std::string>* out = nullptr) {
            args.insert(args.begin(), "git");
            return run(args, cwd.string(), {{"GIT_TERMINAL_PROMPT", "0"}, {"GIT_CONFIG_NOSYSTEM", "1"}, {"GIT_AUTHOR_NAME", "t"}, {"GIT_COMMITTER_NAME", "t"}, {"GIT_AUTHOR_EMAIL", "t@example.test"}, {"GIT_COMMITTER_EMAIL", "t@example.test"}}, out, nullptr, "");
        };
        // A file:// URL for a local repository: git-lfs moves objects to and from one through its standalone file agent.
        auto fileUrl = [](const gfs::path& path) { std::string s = path.generic_string(); return "file://" + (s.size() > 1 && s[1] == ':' ? "/" + s : s); };
        // Incompressible bytes: a repository's size is what count-objects says, and zlib would shrink a run of one byte to nothing.
        auto noise = [](const gfs::path& path, size_t bytes) { std::ofstream out(path, std::ios::binary); uint32_t x = 2463534242u ^ (uint32_t)std::hash<std::string>{}(path.generic_string()); std::string chunk; chunk.reserve(65536); for (size_t i = 0; i < bytes; ++i) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; chunk.push_back((char)(x & 0xff)); if (chunk.size() == 65536) { out.write(chunk.data(), (std::streamsize)chunk.size()); chunk.clear(); } } out.write(chunk.data(), (std::streamsize)chunk.size()); };
        std::vector<std::string> version; const bool lfs = run({"git", "lfs", "version"}, root.string(), {}, &version, nullptr, "") == 0;
        if (!lfs) std::printf("git-lfs not installed: the import rewrite steps are skipped\n");
        // A source with a small file, a 12 MB file and a tag; a bare "Artifacts"; a bare repository standing in for Smith's large-file store.
        const gfs::path source = root / "source"; gfs::create_directories(source / "Assets");
        CHECK(git(source, {"init", "-q", "-b", "main"}) == 0);
        { std::ofstream(source / "a.txt") << "small\n"; } noise(source / "Assets" / "big.bin", 12 * 1024 * 1024);
        CHECK(git(source, {"add", "."}) == 0 && git(source, {"commit", "-q", "-m", "one"}) == 0 && git(source, {"tag", "v1"}) == 0);
        const gfs::path artifacts = root / "artifacts.git"; CHECK(git(root, {"init", "-q", "--bare", "-b", "main", artifacts.string()}) == 0);
        const gfs::path lfsStore = root / "lfs.git"; CHECK(git(root, {"init", "-q", "--bare", "-b", "main", lfsStore.string()}) == 0);
        HostedImportRequest request; request.source = source.string(); request.artifactsRemote = artifacts.string(); request.artifactsToken = ""; request.smithRemote = fileUrl(lfsStore); request.lfsTicket = "";
        request.scratch = (root / "job").string(); request.thresholdBytes = 10 * 1024 * 1024; request.maxRepoBytes = 1024LL * 1024 * 1024;
        gfs::create_directories(request.scratch);
        std::vector<std::string> logged; std::string uploadedSha; int64_t uploadedSize = 0;
        auto upload = [&](const std::string& path, int64_t size, std::string& sha256) { uploadedSize = size; sha256 = std::string(64, 'f'); uploadedSha = sha256; return gfs::exists(path) && size > 0; };
        auto result = RunHostedImport(request, run, [&](const std::string& line) { logged.push_back(line); }, upload, lfs);
        if (lfs) {
            CHECK(result.ok && result.outcome.rewritten && result.outcome.movedFiles == 1 && result.outcome.movedBytes == 12 * 1024 * 1024);
            if (!result.ok) std::printf("import: %s\n", result.message.c_str());
            CHECK(uploadedSize > 0 && result.outcome.bundleSha256 == uploadedSha && result.outcome.bundleSize == uploadedSize);
            CHECK(result.outcome.lfsObjects == 1 && result.outcome.lfsBytes == 12 * 1024 * 1024);
            std::vector<std::string> attrs; CHECK(git(root, {"--git-dir=" + artifacts.string(), "show", "HEAD:.gitattributes"}, &attrs) == 0 && !attrs.empty());   // the rewrite tracked the file
            std::vector<std::string> pointer; CHECK(git(root, {"--git-dir=" + artifacts.string(), "show", "HEAD:Assets/big.bin"}, &pointer) == 0 && !pointer.empty() && pointer[0].rfind("version https://git-lfs", 0) == 0);
            // The object reached the large-file store, and the original history is a bundle git can read.
            size_t stored = 0; std::error_code ec; for (const auto& entry : gfs::recursive_directory_iterator(lfsStore / "lfs" / "objects", ec)) if (entry.is_regular_file()) stored += (size_t)entry.file_size();
            CHECK(stored == 12 * 1024 * 1024);
        } else {
            CHECK(!result.ok && result.message.find("over the threshold") != std::string::npos);
        }
        std::vector<std::string> tags; CHECK(git(root, {"--git-dir=" + artifacts.string(), "tag"}, &tags) == 0 && (!lfs || (tags.size() == 1 && tags[0] == "v1")));
        // No large blobs: untouched history, no bundle, the scan carries the paths, the commit is the source's.
        const gfs::path plain = root / "plain"; gfs::create_directories(plain);
        CHECK(git(plain, {"init", "-q", "-b", "main"}) == 0);
        { std::ofstream(plain / "smith.json") << "{\"project\":{\"name\":\"Plain\"},\"buildProducts\":[]}\n"; } noise(plain / "noise.bin", 4096);
        CHECK(git(plain, {"add", "."}) == 0 && git(plain, {"commit", "-q", "-m", "one"}) == 0);
        std::vector<std::string> head; CHECK(git(plain, {"rev-parse", "HEAD"}, &head) == 0 && head.size() == 1);
        const gfs::path artifacts2 = root / "artifacts2.git"; CHECK(git(root, {"init", "-q", "--bare", "-b", "main", artifacts2.string()}) == 0);
        request.source = plain.string(); request.artifactsRemote = artifacts2.string(); request.scratch = (root / "job2").string(); gfs::create_directories(request.scratch);
        uploadedSize = 0;
        result = RunHostedImport(request, run, [&](const std::string& line) { logged.push_back(line); }, upload, lfs);
        CHECK(result.ok && !result.outcome.rewritten && result.outcome.commit == head[0] && result.outcome.branch == "main" && uploadedSize == 0);
        if (!result.ok) std::printf("import: %s\n", result.message.c_str());
        CHECK(nlohmann::json::parse(result.outcome.scanJson)["smithJson"].is_string() && nlohmann::json::parse(result.outcome.scanJson)["paths"].size() == 2);
        std::vector<std::string> pushedHead; CHECK(git(root, {"--git-dir=" + artifacts2.string(), "rev-parse", "refs/heads/main"}, &pushedHead) == 0 && pushedHead == head);
        // Oversize: measured before any rewrite; nothing pushed, nothing bundled.
        request.maxRepoBytes = 1; request.scratch = (root / "job3").string(); gfs::create_directories(request.scratch);
        result = RunHostedImport(request, run, [&](const std::string&) {}, upload, lfs);
        CHECK(!result.ok && result.oversize && result.failure == "oversize" && uploadedSize == 0);
        // Measured again after the rewrite: a limit the rewritten store fits but the original did not goes to storage.
        if (lfs) {
            request.source = source.string(); request.artifactsRemote = (root / "artifacts3.git").string(); CHECK(git(root, {"init", "-q", "--bare", "-b", "main", request.artifactsRemote}) == 0);
            request.scratch = (root / "job4").string(); gfs::create_directories(request.scratch); request.maxRepoBytes = 6 * 1024 * 1024;   // the 12 MB blob is over, the pointer repository is under
            result = RunHostedImport(request, run, [&](const std::string&) {}, upload, lfs);
            CHECK(result.ok && result.outcome.rewritten && !result.oversize);
            if (!result.ok) std::printf("import: %s\n", result.message.c_str());
        }
        // Existing LFS objects move without a rewrite (the source tracks *.png below the threshold); a large-file store that
        // cannot be reached fails the import after the objects were fetched, with the step named.
        if (lfs) {
            const gfs::path tracked = root / "tracked"; gfs::create_directories(tracked);
            CHECK(git(tracked, {"init", "-q", "-b", "main"}) == 0 && git(tracked, {"lfs", "install", "--local"}) == 0 && git(tracked, {"lfs", "track", "*.png"}) == 0);
            noise(tracked / "icon.png", 2 * 1024 * 1024);
            CHECK(git(tracked, {"add", "."}) == 0 && git(tracked, {"commit", "-q", "-m", "png"}) == 0);
            std::vector<std::string> trackedHead; CHECK(git(tracked, {"rev-parse", "HEAD"}, &trackedHead) == 0);
            request.source = fileUrl(tracked); request.artifactsRemote = (root / "artifacts4.git").string(); CHECK(git(root, {"init", "-q", "--bare", "-b", "main", request.artifactsRemote}) == 0);
            request.scratch = (root / "job5").string(); gfs::create_directories(request.scratch); request.maxRepoBytes = 1024LL * 1024 * 1024;
            request.smithRemote = "https://exp.example.test/git/p.git"; request.lfsTicket = "smith_git_t";
            result = RunHostedImport(request, run, [&](const std::string&) {}, upload, lfs);
            CHECK(!result.ok && !result.outcome.rewritten && result.outcome.commit == trackedHead[0] && result.outcome.lfsObjects == 1 && result.message.find("large files to Smith") != std::string::npos);
            if (result.ok || result.outcome.lfsObjects != 1) std::printf("import: %s\n", result.message.c_str());
            // With a store that can be reached, the same import lands: the pointer commit untouched, the object stored.
            request.smithRemote = fileUrl(lfsStore); request.lfsTicket = ""; request.artifactsRemote = (root / "artifacts5.git").string(); CHECK(git(root, {"init", "-q", "--bare", "-b", "main", request.artifactsRemote}) == 0);
            request.scratch = (root / "job6").string(); gfs::create_directories(request.scratch);
            result = RunHostedImport(request, run, [&](const std::string&) {}, upload, lfs);
            CHECK(result.ok && !result.outcome.rewritten && result.outcome.commit == trackedHead[0] && result.outcome.lfsObjects == 1 && result.outcome.lfsBytes == 2 * 1024 * 1024);
            if (!result.ok) std::printf("import: %s\n", result.message.c_str());
        }
        // Storage that refuses a push over a size limit (spec §9: the sliced push against a refusing server): the history goes
        // in slices, forced, so a halving after a partial success does not trip over what already landed.
        {
            const gfs::path sliced = root / "sliced"; gfs::create_directories(sliced);
            CHECK(git(sliced, {"init", "-q", "-b", "main"}) == 0);
            const size_t sizes[] = {100 * 1024, 100 * 1024, 100 * 1024, 900 * 1024, 100 * 1024, 100 * 1024};
            for (size_t i = 0; i < 6; ++i) { noise(sliced / ("f" + std::to_string(i) + ".bin"), sizes[i]); CHECK(git(sliced, {"add", "."}) == 0 && git(sliced, {"commit", "-q", "-m", "c" + std::to_string(i)}) == 0); }
            CHECK(git(sliced, {"tag", "v2"}) == 0);
            std::vector<std::string> slicedHead; CHECK(git(sliced, {"rev-parse", "HEAD"}, &slicedHead) == 0);
            const gfs::path limited = root / "limited.git"; CHECK(git(root, {"init", "-q", "--bare", "-b", "main", limited.string()}) == 0);
            { std::ofstream hook((limited / "hooks" / "pre-receive").string(), std::ios::binary);
              // Like a pack-size limit: only the objects a push brings count (a tag of commits already there brings one object).
              hook << "#!/bin/sh\nlimit=1048576\nwhile read old new ref; do\n"
                      "  bytes=$(git rev-list --objects \"$new\" --not --all | git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' | awk '$1==\"blob\"{s+=$2} END{print s+0}')\n"
                      "  if [ \"$bytes\" -gt \"$limit\" ]; then echo \"pack too large: $bytes bytes\" >&2; exit 1; fi\ndone\nexit 0\n"; }
            request.source = sliced.string(); request.artifactsRemote = limited.string(); request.smithRemote = fileUrl(lfsStore); request.lfsTicket = "";
            request.scratch = (root / "job7").string(); gfs::create_directories(request.scratch); request.maxRepoBytes = 1024LL * 1024 * 1024;
            result = RunHostedImport(request, run, [&](const std::string&) {}, upload, lfs);
            CHECK(result.ok && !result.outcome.rewritten && result.outcome.commit == slicedHead[0]);
            if (!result.ok) std::printf("import: %s\n", result.message.c_str());
            std::vector<std::string> landed; CHECK(git(root, {"--git-dir=" + limited.string(), "rev-parse", "refs/heads/main"}, &landed) == 0 && landed == slicedHead);
            std::vector<std::string> landedTags; CHECK(git(root, {"--git-dir=" + limited.string(), "tag"}, &landedTags) == 0 && landedTags == std::vector<std::string>({"v2"}));
        }
        // Storage refusing the credential: said so, and worded so the coordinator retries with a fresh token.
        {
            const gfs::path refusing = root / "refusing.git"; CHECK(git(root, {"init", "-q", "--bare", "-b", "main", refusing.string()}) == 0);
            { std::ofstream hook((refusing / "hooks" / "pre-receive").string(), std::ios::binary); hook << "#!/bin/sh\necho 'Authentication failed for the storage token' >&2\nexit 1\n"; }
            request.source = plain.string(); request.artifactsRemote = refusing.string(); request.scratch = (root / "job8").string(); gfs::create_directories(request.scratch);
            result = RunHostedImport(request, run, [&](const std::string&) {}, upload, lfs);
            CHECK(!result.ok && result.message.find("try again") != std::string::npos);
            if (result.ok || result.message.find("try again") == std::string::npos) std::printf("import: %s\n", result.message.c_str());
        }
        std::error_code ec; gfs::remove_all(root, ec);
    }
    // Real git: a store with Smith's config and hook serves an advertisement and an ls-refs RPC through files, and the
    // hook enforces the ref policy on real pushes. Skipped (with a note) where git is not installed.
    {
        using namespace Smith;
        namespace gfs = std::filesystem;
        std::string tail; std::vector<std::string> lines;
        auto git = [&](const gfs::path& cwd, std::vector<std::string> args, std::map<std::string, std::string> env = {}) {
            ProcessOptions o; o.argv = {"git"}; o.argv.insert(o.argv.end(), args.begin(), args.end()); o.workingDir = cwd.string();
            o.envOverride = env; o.envOverride["GIT_CONFIG_NOSYSTEM"] = "1"; o.envOverride["GIT_TERMINAL_PROMPT"] = "0";
            for (const char* k : {"GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"}) o.envOverride[k] = "smith-test";
            for (const char* k : {"GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"}) o.envOverride[k] = "smith-test@example.invalid";
            o.timeoutSeconds = 120; tail.clear(); lines.clear();
            Process p; return p.Run(o, [&](bool err, const std::string& line) { if (err) tail += line + "\n"; else lines.push_back(line); });
        };
        const gfs::path root = gfs::temp_directory_path() / ("smith-githost-" + MakeUuid());
        gfs::create_directories(root);
        if (git(root, {"--version"}) != 0) printf("note: git is not installed; the real-git host checks were skipped\n");
        else {
            const gfs::path source = root / "source", hooks = root / "hooks", work = root / "work";
            gfs::create_directories(source);
            CHECK(git(source, {"init", "-q"}) == 0 && git(source, {"checkout", "-q", "-b", "main"}) == 0);
            { std::ofstream(source / "a.txt") << "one\n"; }
            // count-objects reports whole KiB, and Git for Windows counts a loose object's real size rather than its disk
            // blocks: a few tiny objects read as 0. 4 KiB that zlib cannot shrink keeps the size above zero everywhere.
            { std::ofstream bin(source / "noise.bin", std::ios::binary); uint32_t x = 2463534242u; for (int i = 0; i < 4096; ++i) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; bin.put((char)(x & 0xff)); } }
            CHECK(git(source, {"add", "."}) == 0 && git(source, {"commit", "-q", "-m", "one"}) == 0 && git(source, {"branch", "feature"}) == 0 && git(source, {"tag", "-a", "-m", "release one", "v1"}) == 0);
            const std::string ws(64, 'a'), uuid = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
            const std::string store = HostedGitStorePath(root.string(), ws, uuid);
            gfs::create_directories(gfs::path(store).parent_path());
            CHECK(git(root, {"clone", "--mirror", "-q", "--", source.string(), store}) == 0 && git(root, {"--git-dir=" + store, "remote", "remove", "origin"}) == 0);
            HostedGitProvisionHooks(hooks.string());
            CHECK(gfs::is_regular_file(hooks / "update"));
            CHECK(HostedGitInitStore(store, hooks.string()).empty() && HostedGitStoreTrusted(store));
            int64_t bytes = 0; std::string error; std::map<std::string, std::string> peeled;
            auto tips = HostedGitStoreTips(store, bytes, error, &peeled);
            CHECK(error.empty() && tips.size() == 3 && bytes > 0 && tips[1].second == "refs/heads/main");
            // The annotated tag's target is the commit it was made on; branches have no peeled value.
            CHECK(peeled.size() == 1 && peeled.count("refs/tags/v1") && peeled["refs/tags/v1"] == tips[1].first && tips[2].first != tips[1].first);
            HostedRefPolicy human; human.allow = {"refs/heads/*", "refs/tags/*"}; human.protectedRefs = {"refs/heads/main"};
            const std::string nullConfig = HostedGitEmptyConfig(root.string());
            CHECK(gfs::is_regular_file(nullConfig) && gfs::file_size(nullConfig) == 0);
            auto serve = [&](const std::string& service, const std::string& op, const std::string& protocol, const std::string& body) {
                const gfs::path dir = root / ("relay-" + MakeUuid()); gfs::create_directories(dir);
                if (!body.empty()) { std::ofstream(dir / "req", std::ios::binary) << body; }
                ProcessOptions o; o.argv = HostedGitServeArgv(service, op, store); o.envUnset = HostedGitServeEnvUnset(); o.envOverride = HostedGitServeEnv(protocol, human, nullConfig);
                o.workingDir = store; o.stdinFile = body.empty() ? "" : (dir / "req").string(); o.stdoutFile = (dir / "res").string(); o.timeoutSeconds = 120;
                Process p; const int rc = p.Run(o, nullptr);
                std::ifstream in(dir / "res", std::ios::binary); std::string out((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
                return std::make_pair(rc, out);
            };
            auto adv = serve("upload-pack", "info-refs", "version=2", "");
            CHECK(adv.first == 0 && adv.second.rfind("000eversion 2\n", 0) == 0 && adv.second.find("ls-refs") != std::string::npos);
            auto adv0 = serve("upload-pack", "info-refs", "", "");
            CHECK(adv0.first == 0 && adv0.second.find("refs/heads/main") != std::string::npos);
            auto ls = serve("upload-pack", "rpc", "version=2", "0014command=ls-refs\n00010000");
            CHECK(ls.first == 0 && ls.second.find("refs/heads/feature") != std::string::npos && ls.second.find("refs/tags/v1") != std::string::npos);
            auto radv = serve("receive-pack", "info-refs", "", "");
            CHECK(radv.first == 0 && radv.second.find("report-status") != std::string::npos);
            // The hook, through real pushes (receive-pack inherits the policy from the environment, as it does from the relay).
            CHECK(git(root, {"clone", "-q", "--", store, work.string()}) == 0);
            const auto policyEnv = [&](const HostedRefPolicy& p) { return HostedGitServeEnv("", p, nullConfig); };
            { std::ofstream(work / "c.txt") << "three\n"; }
            CHECK(git(work, {"add", "."}) == 0 && git(work, {"commit", "-q", "-m", "three"}) == 0);
            CHECK(git(work, {"push", "-q", "origin", "main"}, policyEnv(human)) == 0);
            CHECK(git(work, {"commit", "-q", "--amend", "-m", "three again"}) == 0);
            CHECK(git(work, {"push", "-q", "--force", "origin", "main"}, policyEnv(human)) != 0 && tail.find("protected") != std::string::npos);
            HostedRefPolicy twoProtected = human; twoProtected.protectedRefs.push_back("refs/heads/feature");
            CHECK(git(work, {"push", "-q", "origin", "--delete", "feature"}, policyEnv(twoProtected)) != 0 && tail.find("deleting refs/heads/feature is not allowed") != std::string::npos);
            CHECK(git(work, {"push", "-q", "--force", "origin", "HEAD:refs/heads/feature"}, policyEnv(human)) == 0);
            CHECK(git(work, {"push", "-q", "origin", "HEAD:refs/smith/x"}, policyEnv(human)) != 0 && tail.find("reserved") != std::string::npos);
            CHECK(git(work, {"push", "-q", "origin", "HEAD:refs/notes/x"}, policyEnv(human)) != 0 && tail.find("cannot push to refs/notes/x") != std::string::npos);
            HostedRefPolicy crew; crew.allow = {"refs/heads/smith/crew-ab-*"}; crew.denyDelete = true;
            CHECK(git(work, {"push", "-q", "origin", "HEAD:refs/heads/smith/crew-ab-1"}, policyEnv(crew)) == 0);
            CHECK(git(work, {"push", "-q", "origin", "HEAD:refs/heads/other"}, policyEnv(crew)) != 0);
            CHECK(git(work, {"push", "-q", "origin", "--delete", "smith/crew-ab-1"}, policyEnv(crew)) != 0);
            CHECK(git(work, {"push", "-q", "origin", "--delete", "smith/crew-ab-1"}, policyEnv(human)) == 0);
            tips = HostedGitStoreTips(store, bytes, error);
            CHECK(error.empty() && tips.size() == 3);
            CHECK(git(root, {"--git-dir=" + store, "config", "receive.fsckObjects", "false"}) == 0 && !HostedGitStoreTrusted(store));
        }
        std::error_code ec; gfs::remove_all(root, ec);
    }
    // Tasks between relays: the poll's task object, the completion report, and the pure replication/bundle rules.
    {
        using namespace Smith;
        const std::string uuid = "11111111-2222-3333-4444-555555555555";
        std::string problem; HostedGitTask parsed;
        CHECK(HostedParseGitTask({{"id", "aaaaaaaa-0000-0000-0000-000000000009"}, {"leaseToken", "x.y"}, {"kind", "backup"}, {"repoId", "senet"}, {"repoUuid", uuid}, {"defaultBranch", "main"}, {"payload", {{"kind", "full"}}}}, parsed, problem) && parsed.payload["kind"] == "full" && parsed.kind == "backup");
        CHECK(!HostedParseGitTask({{"id", "x"}, {"leaseToken", "y"}, {"kind", "format"}, {"repoId", "s"}, {"repoUuid", uuid}}, parsed, problem) && problem == "task kind");
        CHECK(!HostedParseGitTask({{"id", "x"}, {"leaseToken", "y"}, {"kind", "backup"}, {"repoId", "s"}, {"repoUuid", "../x"}}, parsed, problem) && problem == "task identity");
        CHECK(!HostedParseGitTask({{"id", "x"}, {"leaseToken", "y"}, {"kind", "backup"}, {"repoId", "s"}, {"repoUuid", uuid}, {"defaultBranch", "a..b"}}, parsed, problem) && problem == "default branch");
        HostedGitTaskResult r; r.ok = true; r.tipsJson = "[[\"" + std::string(40, 'a') + "\",\"refs/heads/main\"]]"; r.bytes = 7; r.size = 99; r.sha256 = "abc"; r.kind = "full";
        const auto completion = nlohmann::json::parse(HostedGitTaskCompletionJson(parsed, r));
        CHECK(completion["ok"] == true && completion["tips"].size() == 1 && completion["bytes"] == 7 && completion["size"] == 99 && completion["sha256"] == "abc" && completion["kind"] == "full" && !completion.contains("recovered"));
        HostedGitTaskResult failedResult; failedResult.message = "no disk";
        const auto refusal = nlohmann::json::parse(HostedGitTaskCompletionJson(parsed, failedResult));
        CHECK(refusal["ok"] == false && refusal["message"] == "no disk" && !refusal.contains("tips") && !refusal.contains("bytes"));
        CHECK(HostedGitRecoveredRef(1700000000, "refs/heads/wip") == "refs/smith/recovered/1700000000/heads/wip");
        const auto rep = HostedGitReplicateArgv("/s.git", "https://x/git/a.git");
        CHECK(rep[0] == "git" && rep[2] == "fetch" && rep.back() == "+refs/tags/*:refs/tags/*" && std::find(rep.begin(), rep.end(), "--prune") != rep.end() && std::find(rep.begin(), rep.end(), "--atomic") != rep.end() && std::find(rep.begin(), rep.end(), "https://x/git/a.git") != rep.end());
        const auto bundleArgv = HostedGitBundleArgv("/s.git", "/f", {std::string(40, 'a'), std::string(40, 'a'), "bad"});
        CHECK(bundleArgv.size() == 8 && bundleArgv[7] == "^" + std::string(40, 'a') && bundleArgv[6] == "--all");
        using T = std::vector<std::pair<std::string, std::string>>;
        const T before = {{"1", "refs/heads/a"}, {"2", "refs/heads/b"}, {"3", "refs/heads/c"}, {"4", "refs/smith/recovered/1/heads/x"}}, after = {{"9", "refs/heads/a"}, {"8", "refs/heads/b"}};
        const auto rec = HostedGitRecoverable(before, after, [](const std::string& o, const std::string& n) { return o == "1" && n == "9"; }, [](const std::string& o) { return o == "3"; });
        CHECK(rec.size() == 1 && rec[0].first == "2" && rec[0].second == "refs/heads/b");   // a moved forward, c is still contained, x is Smith's own
        CHECK(HostedGitRestoreDeletions({{"1", "refs/heads/a"}, {"2", "refs/heads/gone"}, {"3", "refs/smith/recovered/1/x"}}, {{"1", "refs/heads/a"}}) == std::vector<std::string>({"refs/heads/gone"}));
    }
    // Real git: a copy replicates from a primary and keeps aside what a force-push there would have lost; bundles (full
    // then incremental) restore into a store equal to the primary; discard moves a copy to the trash.
    {
        using namespace Smith;
        namespace gfs = std::filesystem;
        std::string tail;
        auto git = [&](const gfs::path& cwd, std::vector<std::string> args, std::vector<std::string>* out = nullptr) {
            ProcessOptions o; o.argv = {"git"}; o.argv.insert(o.argv.end(), args.begin(), args.end()); o.workingDir = cwd.string();
            o.envOverride = {{"GIT_CONFIG_NOSYSTEM", "1"}, {"GIT_TERMINAL_PROMPT", "0"}};
            for (const char* k : {"GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"}) o.envOverride[k] = "smith-test";
            for (const char* k : {"GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"}) o.envOverride[k] = "smith-test@example.invalid";
            o.timeoutSeconds = 120; tail.clear();
            Process p; return p.Run(o, [&](bool err, const std::string& line) { if (err) tail += line + "\n"; else if (out) out->push_back(line); });
        };
        const gfs::path root = gfs::temp_directory_path() / ("smith-gittasks-" + MakeUuid()); gfs::create_directories(root);
        if (git(root, {"--version"}) != 0) printf("note: git is not installed; the real-git task checks were skipped\n");
        else {
            auto sha = [&](const gfs::path& repo, const std::string& ref) { std::vector<std::string> l; git(repo, {"rev-parse", ref}, &l); return l.empty() ? std::string() : l[0]; };
            const std::string ws(64, 'b'), uuid = "11111111-2222-3333-4444-555555555555";
            HostedGitLoopConfig config{root.string(), ws, "test-host"};
            HostedTransport transport; transport.base = "https://127.0.0.1:9"; transport.directory = root / "transport"; gfs::create_directories(transport.directory);
            std::atomic<bool> stop{false};
            const gfs::path source = root / "source", primary = root / "primary.git", work = root / "work"; gfs::create_directories(source);
            CHECK(git(source, {"init", "-q"}) == 0 && git(source, {"checkout", "-q", "-b", "main"}) == 0);
            { std::ofstream(source / "a.txt") << "one\n"; } CHECK(git(source, {"add", "."}) == 0 && git(source, {"commit", "-q", "-m", "one"}) == 0);
            { std::ofstream(source / "b.txt") << "two\n"; } CHECK(git(source, {"add", "."}) == 0 && git(source, {"commit", "-q", "-m", "two"}) == 0 && git(source, {"tag", "v1"}) == 0);
            CHECK(git(root, {"clone", "-q", "--mirror", "--", source.string(), primary.string()}) == 0);
            HostedGitTask task; task.id = "aaaaaaaa-0000-0000-0000-000000000001"; task.leaseToken = "lease"; task.kind = "replicate"; task.repoId = "senet"; task.repoUuid = uuid; task.defaultBranch = "main";
            task.payload = {{"remote", primary.string()}, {"ticket", ""}, {"bytes", 1000}};   // a local path stands in for the relayed remote
            auto result = RunHostedGitTask(transport, config, task, stop);
            CHECK(result.ok); CHECK(result.bytes > 0); CHECK(nlohmann::json::parse(result.tipsJson.empty() ? "[]" : result.tipsJson).size() == 2);
            const std::string store = HostedGitStorePath(root.string(), ws, uuid);
            CHECK(HostedGitStoreTrusted(store));
            std::vector<std::string> head; CHECK(git(root, {"--git-dir=" + store, "symbolic-ref", "HEAD"}, &head) == 0 && head.size() == 1 && head[0] == "refs/heads/main");
            // The copy gains a commit and a branch the primary never had; the primary then force-moves main.
            CHECK(git(root, {"clone", "-q", "--", store, work.string()}) == 0);
            { std::ofstream(work / "c.txt") << "three\n"; } CHECK(git(work, {"add", "."}) == 0 && git(work, {"commit", "-q", "-m", "three (lost)"}) == 0);
            const std::string lost = sha(work, "HEAD");
            CHECK(git(work, {"push", "-q", "origin", "main"}) == 0 && git(work, {"push", "-q", "origin", "HEAD:refs/heads/only-here"}) == 0);
            { std::ofstream(source / "d.txt") << "four\n"; } CHECK(git(source, {"add", "."}) == 0 && git(source, {"commit", "-q", "-m", "four"}) == 0);
            CHECK(git(source, {"push", "-q", "--force", "--", primary.string(), "main"}) == 0);
            task.id = "aaaaaaaa-0000-0000-0000-000000000002";
            result = RunHostedGitTask(transport, config, task, stop);
            CHECK(result.ok);
            bool kept = false; for (const auto& r : nlohmann::json::parse(result.recoveredJson.empty() ? "[]" : result.recoveredJson)) kept = kept || r[0] == lost;
            CHECK(kept);
            std::vector<std::string> refs; git(root, {"--git-dir=" + store, "for-each-ref", "--format=%(refname)"}, &refs);
            bool recovered = false, onlyHere = false; for (const auto& r : refs) { recovered = recovered || r.rfind("refs/smith/recovered/", 0) == 0; onlyHere = onlyHere || r == "refs/heads/only-here"; }
            CHECK(recovered && !onlyHere);
            CHECK(sha(gfs::path(store), "refs/heads/main") == sha(primary, "refs/heads/main"));
            // Bundles: full, then incremental on its tips; restored in order they equal the primary.
            const gfs::path full = root / "full.bundle", inc = root / "inc.bundle"; std::string error; int64_t bytes = 0;
            auto argv = HostedGitBundleArgv(primary.string(), full.string(), {}); argv.erase(argv.begin(), argv.begin() + 2);
            CHECK(HostedGitRunStore(primary.string(), argv, nullptr, error, 120) == 0);
            const auto fullTips = HostedGitStoreTips(primary.string(), bytes, error);
            { std::ofstream(source / "e.txt") << "five\n"; } CHECK(git(source, {"add", "."}) == 0 && git(source, {"commit", "-q", "-m", "five"}) == 0 && git(source, {"tag", "v2"}) == 0);
            CHECK(git(source, {"push", "-q", "--", primary.string(), "main", "v2"}) == 0);
            std::vector<std::string> base; for (const auto& t : fullTips) base.push_back(t.first);
            argv = HostedGitBundleArgv(primary.string(), inc.string(), base); argv.erase(argv.begin(), argv.begin() + 2);
            CHECK(HostedGitRunStore(primary.string(), argv, nullptr, error, 120) == 0);
            CHECK(gfs::file_size(inc) < gfs::file_size(full));
            const auto manifest = HostedGitStoreTips(primary.string(), bytes, error);
            const std::string restored = (root / "restored.git").string();
            CHECK(HostedGitInitBare(restored, (root / "git" / "hooks").string()).empty());
            for (const auto& bundle : {full, inc}) {
                CHECK(HostedGitRunStore(restored, {"bundle", "verify", "--quiet", bundle.string()}, nullptr, error, 120) == 0);
                CHECK(HostedGitRunStore(restored, {"fetch", "--quiet", "--atomic", "--", bundle.string(), "+refs/*:refs/*"}, nullptr, error, 120) == 0);
            }
            const auto restoredTips = HostedGitStoreTips(restored, bytes, error);
            CHECK(HostedGitRestoreDeletions(restoredTips, manifest).empty() && HostedGitTipsJson(restoredTips) == HostedGitTipsJson(manifest));
            CHECK(HostedGitRunStore(restored, {"fsck", "--connectivity-only"}, nullptr, error, 120) == 0);
            task.id = "aaaaaaaa-0000-0000-0000-000000000003"; task.kind = "discard"; task.payload = nlohmann::json::object();
            result = RunHostedGitTask(transport, config, task, stop);
            CHECK(result.ok && !gfs::exists(store));
            auto trashed = [&]() { size_t n = 0; std::error_code e; for (const auto& entry : gfs::directory_iterator(root / "git" / "trash", e)) { (void)entry; ++n; } return n; };
            CHECK(trashed() == 1);
            HostedGitPurgeTrash(root.string(), 7 * 86400); CHECK(trashed() == 1);
            HostedGitPurgeTrash(root.string(), -1); CHECK(trashed() == 0);
        }
        std::error_code ec; gfs::remove_all(root, ec);
    }
    {
        // Smith's pull requests: a diff uploads exactly its two files, a merge carries who merges, a publish goes to
        // another remote with the machine's own login (never Smith's copy), and no other job carries a pull request.
        Smith::JobSpec pull; pull.kind = "diff"; pull.command = {"exe", "cmd.exe", {"/d", "/c", "echo"}};
        pull.repos.push_back({"main", artifactsRemote, "", std::string(40, 'a'), ".", "art_v1_token"});
        // As the coordinator sends it (pulls.ts): hosted artifacts are exact files, so package is "none".
        pull.pull.baseBranch = "main"; pull.artifacts.package = "none"; pull.artifacts.globs = {Smith::kHostedPullPatch, Smith::kHostedPullFiles};
        CHECK(Smith::ValidateHostedSpec(pull).empty());
        pull.pull.baseBranch = "main..x"; CHECK(!Smith::ValidateHostedSpec(pull).empty()); pull.pull.baseBranch = "main";
        pull.artifacts.globs = {"other.txt"}; CHECK(!Smith::ValidateHostedSpec(pull).empty()); pull.artifacts.globs.clear();
        pull.kind = "merge"; CHECK(!Smith::ValidateHostedSpec(pull).empty());
        pull.pull.message = "Merge pull request #1"; pull.pull.authorName = "Sem"; pull.pull.authorEmail = "sem@users.smith.invalid";
        CHECK(Smith::ValidateHostedSpec(pull).empty());
        pull.pull.authorName = "Sem <evil@x>"; CHECK(!Smith::ValidateHostedSpec(pull).empty()); pull.pull.authorName = "Sem";
        CHECK(Smith::HostedPullMergeArgs(pull.pull, std::string(40, 'a')).back() == std::string(40, 'a'));
        pull.kind = "publish"; CHECK(!Smith::ValidateHostedSpec(pull).empty());
        pull.pull.message.clear(); pull.pull.authorName.clear(); pull.pull.authorEmail.clear();
        pull.pull.targetRemote = "https://github.com/example/repo.git"; pull.pull.targetBranch = "smith/crew-a";
        CHECK(Smith::ValidateHostedSpec(pull).empty());
        pull.pull.targetRemote = artifactsRemote; CHECK(!Smith::ValidateHostedSpec(pull).empty());
        pull.pull.targetRemote = "https://user:tok@github.com/example/repo.git"; CHECK(!Smith::ValidateHostedSpec(pull).empty());
        pull.kind = "build"; pull.pull = {}; pull.pull.baseBranch = "main"; pull.repos[0].authToken.clear(); pull.repos[0].url = "https://github.com/example/repo.git";
        CHECK(!Smith::ValidateHostedSpec(pull).empty());
        const auto conflicted = Smith::HostedParseMergeTree(1, {std::string(40, 'b'), "a.txt", "b.txt", "a.txt"});
        CHECK(conflicted.mergeable == 0 && conflicted.conflicts == std::vector<std::string>({"a.txt", "b.txt"}));
        CHECK(Smith::HostedParseMergeTree(0, {std::string(40, 'b')}).mergeable == 1 && Smith::HostedParseMergeTree(129, {"usage: git merge-tree"}).mergeable == -1);
        const auto cut = Smith::HostedPullPatchText("m", "h", "line1\nline2\nline3\n", 39);
        CHECK(cut.truncated && cut.text == "# smith pull diff m..h\nline1\nline2\n");
        CHECK(!Smith::HostedPullPatchText("", "h", "x\n", 1000).truncated);
        CHECK(Smith::HostedPullFilesText("m", "h", {"1\t2\ta.txt"}) == "# smith pull files m..h\n1\t2\ta.txt\n");
    }
    {
        // A project started in Smith: zip entry names are checked before anything is written, one wrapping folder is
        // unwrapped, .git and macOS metadata are left out, and the first commit honours the zip's .gitignore.
        namespace fs = std::filesystem;
        CHECK(Smith::HostedZipCommonRoot({"game/", "game/a.txt", "game/src/b.c", "__MACOSX/game/._a.txt"}) == "game/");
        CHECK(Smith::HostedZipCommonRoot({"game/a.txt", "readme.txt"}).empty());
        CHECK(Smith::HostedZipCommonRoot({"a/x.txt", "b/y.txt"}).empty());
        std::string problem;
        CHECK(Smith::HostedZipEntryPath("game/src/b.c", "game/", problem) == "src/b.c" && problem.empty());
        CHECK(Smith::HostedZipEntryPath("game\\src\\b.c", "game/", problem) == "src/b.c");
        CHECK(Smith::HostedZipEntryPath("game/", "game/", problem).empty() && problem.empty());
        CHECK(Smith::HostedZipEntryPath("game/.git/config", "game/", problem).empty() && problem.empty());
        CHECK(Smith::HostedZipEntryPath("game/.GIT/HEAD", "game/", problem).empty() && problem.empty());
        CHECK(Smith::HostedZipEntryPath("__MACOSX/game/._a.txt", "game/", problem).empty() && problem.empty());
        CHECK(Smith::HostedZipEntryPath("game/.gitignore", "game/", problem) == ".gitignore");
        CHECK(Smith::HostedZipEntryPath("../evil.txt", "", problem).empty() && !problem.empty());
        CHECK(Smith::HostedZipEntryPath("a/../../evil.txt", "", problem).empty() && !problem.empty());
        CHECK(Smith::HostedZipEntryPath("/etc/passwd", "", problem).empty() && !problem.empty());
        CHECK(Smith::HostedZipEntryPath("C:/Windows/x.dll", "", problem).empty() && !problem.empty());
        CHECK(Smith::HostedZipEntryPath("a/CON.txt", "", problem).empty() && !problem.empty());
        CHECK(Smith::HostedZipEntryPath("a/what?.txt", "", problem).empty() && !problem.empty());
        CHECK(Smith::HostedZipEntryPath("a/trailing. ", "", problem).empty() && !problem.empty());
        CHECK(Smith::HostedGitInitMessage("zip", "My Game", "old.zip") == "Import My Game from old.zip" && Smith::HostedGitInitMessage("empty", "My Game", "") == "Start My Game");
        CHECK(Smith::HostedGitInitReadme("My Game").rfind("# My Game\n", 0) == 0);

        // The job: an init host job carries no repository, a name, a branch, and an upload only for a zip.
        Smith::JobSpec host; host.kind = "host"; host.host.repoUuid = "0123abcd-0000"; host.host.defaultBranch = "main";
        host.host.init.kind = "empty"; host.host.init.name = "My Game";
        CHECK(Smith::ValidateHostedSpec(host).empty());
        host.host.init.archiveSize = 5; CHECK(!Smith::ValidateHostedSpec(host).empty());
        host.host.init.kind = "zip"; host.host.init.archiveName = "a.zip"; CHECK(Smith::ValidateHostedSpec(host).empty());
        host.host.init.archiveSize = 200LL * 1024 * 1024; CHECK(!Smith::ValidateHostedSpec(host).empty()); host.host.init.archiveSize = 5;
        host.host.init.name = "two\nlines"; CHECK(!Smith::ValidateHostedSpec(host).empty()); host.host.init.name = "My Game";
        host.host.defaultBranch = ""; CHECK(!Smith::ValidateHostedSpec(host).empty()); host.host.defaultBranch = "main";
        host.repos.push_back({"main", "https://github.com/example/repo.git", "main", "", ".", ""}); CHECK(!Smith::ValidateHostedSpec(host).empty()); host.repos.clear();
        host.host.init.kind = "tarball"; CHECK(!Smith::ValidateHostedSpec(host).empty());
        Smith::JobSpec build; build.kind = "build"; build.host.init.kind = "empty"; CHECK(!Smith::ValidateHostedSpec(build).empty());
        // A copy of a project that lives on Cloudflare Artifacts clones it with a read token; any other source uses the machine's own login.
        Smith::JobSpec dupe; dupe.kind = "host"; dupe.host.repoUuid = "0123abcd-0001"; dupe.host.defaultBranch = "main";
        dupe.repos.push_back({"main", artifactsRemote, "main", "", ".", "art_v1_token"}); CHECK(Smith::ValidateHostedSpec(dupe).empty());
        dupe.repos[0].authToken = "art v1"; CHECK(!Smith::ValidateHostedSpec(dupe).empty());
        dupe.repos[0] = {"main", "https://github.com/example/repo.git", "main", "", ".", "ghp_token"}; CHECK(!Smith::ValidateHostedSpec(dupe).empty());

        // Extraction and the first commit, with real files and git.
        const fs::path root = fs::temp_directory_path() / ("smith-init-" + Smith::MakeUuid());
        fs::create_directories(root);
        auto makeZip = [&](const fs::path& path, const std::vector<std::pair<std::string, std::string>>& entries) {
            struct zip_t* zip = zip_open(path.string().c_str(), 6, 'w');
            for (const auto& [name, data] : entries) { zip_entry_open(zip, name.c_str()); zip_entry_write(zip, data.data(), data.size()); zip_entry_close(zip); }
            zip_close(zip);
        };
        const fs::path good = root / "good.zip", evil = root / "evil.zip";
        makeZip(good, {{"game/README.md", "# Game\n"}, {"game/src/main.c", "int main(void){return 0;}\n"}, {"game/.gitignore", "build/\n"}, {"game/build/out.bin", "junk"},
                       {"game/.git/config", "[core]\n\thooksPath = /tmp/evil\n"}, {"__MACOSX/game/._README.md", "meta"}});
        // kuba zip drops ".." when it writes a name, so the hostile entry is written under "zz/" and renamed in place
        // (same length; the CRC covers the data, not the name), as a zip made by another tool could carry it.
        makeZip(evil, {{"ok.txt", "fine"}, {"zz/escape.txt", "nope"}});
        {
            std::ifstream in(evil, std::ios::binary); std::string bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>()); in.close();
            for (size_t at = bytes.find("zz/escape.txt"); at != std::string::npos; at = bytes.find("zz/escape.txt", at)) bytes.replace(at, 2, "..");
            std::ofstream(evil, std::ios::binary | std::ios::trunc) << bytes;
        }
        int64_t files = 0;
        fs::create_directories(root / "out");
        CHECK(Smith::HostedExtractProjectZip(good.string(), (root / "out").string(), files).empty());
        CHECK(files == 4 && fs::exists(root / "out" / "src" / "main.c") && fs::exists(root / "out" / ".gitignore") && !fs::exists(root / "out" / ".git") && !fs::exists(root / "out" / "game"));
        fs::create_directories(root / "evil-out");
        CHECK(Smith::HostedExtractProjectZip(evil.string(), (root / "evil-out").string(), files).find("leaves the project folder") != std::string::npos);
        CHECK(!fs::exists(root / "escape.txt"));
        CHECK(!Smith::HostedExtractProjectZip((root / "missing.zip").string(), (root / "out").string(), files).empty());

        const Smith::HostedGitInitRun git = [](const std::vector<std::string>& argv, const std::string& cwd, const std::map<std::string, std::string>& env, std::vector<std::string>* errors) {
            Smith::Process process; Smith::ProcessOptions options; options.argv = argv; options.workingDir = cwd; options.timeoutSeconds = 120; options.envOverride = env;
            return process.Run(options, [&](bool error, const std::string& line) { if (errors && error) errors->push_back(line); });
        };
        auto lines = [&](const fs::path& dir, std::vector<std::string> args) {
            args.insert(args.begin(), "git"); std::vector<std::string> out;
            Smith::Process process; Smith::ProcessOptions options; options.argv = args; options.workingDir = dir.string(); options.timeoutSeconds = 60;
            process.Run(options, [&](bool error, const std::string& line) { if (!error) out.push_back(line); });
            return out;
        };
        std::string workTree;
        CHECK(Smith::HostedGitInitWorkTree({"zip", "Game", "game.zip", "main", good.string(), (root / "zip-job").string()}, git, workTree).empty());
        auto tracked = lines(workTree, {"ls-files"}); std::sort(tracked.begin(), tracked.end());
        CHECK(tracked == std::vector<std::string>({".gitignore", "README.md", "src/main.c"}));
        CHECK(lines(workTree, {"log", "--format=%an|%s"}) == std::vector<std::string>({"Smith|Import Game from game.zip"}));
        CHECK(lines(workTree, {"symbolic-ref", "--short", "HEAD"}) == std::vector<std::string>({"main"}));
        CHECK(Smith::HostedGitInitWorkTree({"empty", "New Thing", "", "trunk", "", (root / "empty-job").string()}, git, workTree).empty());
        CHECK(lines(workTree, {"ls-files"}) == std::vector<std::string>({"README.md"}));
        CHECK(lines(workTree, {"symbolic-ref", "--short", "HEAD"}) == std::vector<std::string>({"trunk"}));
        CHECK(Smith::HostedGitInitWorkTree({"zip", "Bad", "evil.zip", "main", evil.string(), (root / "evil-job").string()}, git, workTree).find("leaves the project folder") != std::string::npos);
        std::error_code ec; fs::remove_all(root, ec);
    }
    printf("Hosted policy: %d passed, %d failed\n", passed, failed); return failed;
}
}
