#include "HostedCrewRun.h"
#include "HostedAiSession.h"
#include "HostedToolSetup.h"
#include "HostedAgent.h"
#include "HostedPlatform.h"
#include <json/single_include/nlohmann/json.hpp>
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <regex>
#include <sstream>
namespace Smith {
namespace {
// A path as the containment check sees it: one separator style, no ".", "..", doubled or trailing separators,
// and case-folded. Windows ignores case; folding on every platform can only make the check refuse a layout, never accept one.
std::string HostedCrewPathKey(const std::string& path) {
    std::string unified = path;
    std::replace(unified.begin(), unified.end(), '\\', '/');
    std::string key = std::filesystem::path(unified).lexically_normal().generic_string();
    while (key.size() > 1 && key.back() == '/') key.pop_back();
    for (char& c : key) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return key;
}
// True when path is dir itself or lies anywhere beneath it (both already keys, dir not empty).
bool HostedCrewContains(const std::string& dir, const std::string& path) {
    const std::string prefix = dir.back() == '/' ? dir : dir + "/";
    return path == dir || path.compare(0, prefix.size(), prefix) == 0;
}
}
bool HostedCrewScopeAllows(const std::vector<std::string>& scopes, const std::string& path) {
    if (path.empty() || path.size() > 512 || path.front() == '/' || path.back() == '/') return false;
    for (unsigned char c : path) if (c < 32 || c == 127 || std::string("\\:*?[]{}()\"").find(c) != std::string::npos) return false;
    std::stringstream parts(path); std::string part;
    while (std::getline(parts, part, '/')) {
        if (part.empty() || part == "." || part == ".." || part.back() == '.' || part.back() == ' ') return false;
        for (char& c : part) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if (part == ".git" || part == ".claude" || part == ".mcp.json" || part == "claude.md" || part == "claude.local.md" || part == "agents.md") return false;
        const auto stem = part.substr(0, part.find('.'));
        if (stem == "con" || stem == "prn" || stem == "aux" || stem == "nul" || std::regex_match(stem, std::regex("(com|lpt)[0-9]"))) return false;
    }
    for (const auto& scope : scopes) if (scope.empty() || (scope.back() == '/' && path.compare(0, scope.size(), scope) == 0)) return true;
    return false;
}
bool HostedCrewTreePlain(const std::string& root) {
    namespace fs = std::filesystem; std::error_code ec;
    const auto plain = [&](const fs::path& p) {
        if (HostedIsLink(p.string())) return false;
        const auto type = fs::symlink_status(p, ec).type();
        return !ec && (type == fs::file_type::directory || type == fs::file_type::regular);
    };
    if (!plain(fs::path(root))) return false;
    for (fs::recursive_directory_iterator it(root, ec), end; !ec && it != end; it.increment(ec)) {
        if (!plain(it->path())) return false;
        if (it->path().filename() == ".git") it.disable_recursion_pending();
    }
    return !ec;
}
std::string HostedCrewScopedSettings(const std::string& settings, const std::string& repo, const std::vector<std::string>& scopes, bool reader) {
    auto value = nlohmann::json::parse(settings);
    auto& allow = value["permissions"]["allow"]; auto& deny = value["permissions"]["deny"];
    allow.push_back("mcp__smith__crew_request_review");
    if (reader) { for (const char* tool : {"Edit", "Write", "NotebookEdit"}) deny.push_back(tool); }
    else for (const auto& scope : scopes) {
        std::string path = repo; std::replace(path.begin(), path.end(), '\\', '/');
        std::vector<std::string> forms = {(path.front() == '/' ? "/" : "//") + path};
        if (path.size() > 1 && path[1] == ':') forms.push_back("//" + std::string(1, static_cast<char>(std::tolower(path[0]))) + path.substr(2));
        for (const auto& form : forms) for (const char* tool : {"Edit", "Write", "NotebookEdit"}) allow.push_back(std::string(tool) + "(" + form + "/" + scope + "**)");
    }
    // Control/instruction files are never writable, even for a whole-repository lease.
    for (const char* file : {".git", ".claude", ".mcp.json", "CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"})
        for (const char* tool : {"Edit", "Write", "NotebookEdit"}) { deny.push_back(std::string(tool) + "(**/" + file + ")"); deny.push_back(std::string(tool) + "(**/" + file + "/**)"); }
    return value.dump();
}
std::vector<std::string> HostedCrewClaudeArgs(const HostedCrewArgs& in) {
    if (in.mode != "plan" && in.mode != "acceptEdits") return {};
    if (!HostedCrewSchemaCmdSafe(in.schemaInline)) return {};
    // The budget is judged as the cents it is sent as, so one that rounds to $0.00 is refused. Written so NaN fails too.
    const double cents = std::round(in.usdPerRun * 100.0);
    if (!(cents >= 1 && cents <= 100000)) return {};
    const std::regex id("[A-Za-z0-9][A-Za-z0-9-]{0,63}");
    if (!in.resume.empty() && !std::regex_match(in.resume, id)) return {};
    if (!in.model.empty() && !HostedOllamaModelValid(in.model)) return {};
    char usd[32]; std::snprintf(usd, sizeof usd, "%.2f", cents / 100.0);
    const auto control = [&](const char* name) { return (std::filesystem::path(in.runControlDir) / name).string(); };
    std::vector<std::string> args = {"-p", "--output-format", "stream-json", "--verbose", "--permission-mode", in.mode,
        "--restricted", "--strict-mcp-config", "--permission-prompts", "none", "--add-dir", in.inputDir, "--add-dir", in.newProjectDir,
        "--append-system-prompt-file", control("system.txt"), "--json-schema", in.schemaInline, "--max-budget-usd", usd,
        "--mcp-config", control("mcp.json"), "--settings", control("settings.json"), "--disallowedTools", "WebFetch,WebSearch,Task,EnterWorktree,ExitWorktree"};
    if (!in.resume.empty()) { args.push_back("--resume"); args.push_back(in.resume); }
    if (!in.model.empty()) { args.push_back("--model"); args.push_back(in.model); }
    return args;
}
std::vector<std::string> HostedCrewCodexArgs(const HostedCrewArgs& in, const std::string& schemaFile, const std::string& lastMessageFile, const std::string& mcpUrl) {
    if (in.mode != "plan" && in.mode != "acceptEdits") return {};
    if (!in.model.empty() && !HostedOllamaModelValid(in.model)) return {};
    // Plain https with nothing cmd.exe or TOML would read as syntax; Codex takes an unquoted -c value as a string.
    static const std::regex url("https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._-]+)*/?");
    if (!std::regex_match(mcpUrl, url)) return {};
    const bool edits = in.mode == "acceptEdits";
    std::vector<std::string> args = {"exec"};
    if (!in.model.empty()) for (const auto& arg : {std::string("--oss"), std::string("--local-provider"), std::string("ollama"), std::string("-m"), in.model}) args.push_back(arg);
    args.insert(args.end(), {"--sandbox", edits ? "workspace-write" : "read-only"});
    if (edits) args.insert(args.end(), {"--add-dir", in.newProjectDir});
    for (const std::string& setting : {std::string("approval_policy=never"), std::string("sandbox_workspace_write.network_access=false"), std::string("sandbox_workspace_write.exclude_slash_tmp=true"),
                                       std::string("sandbox_workspace_write.exclude_tmpdir_env_var=true"), std::string("mcp_servers={}"), "mcp_servers.smith.url=" + mcpUrl,
                                       std::string("mcp_servers.smith.bearer_token_env_var=SMITH_RUN_TOKEN")}) args.insert(args.end(), {"-c", setting});
    args.insert(args.end(), {"--output-schema", schemaFile, "--output-last-message", lastMessageFile, "--json", "-"});
    return args;
}
bool HostedCrewSchemaCmdSafe(const std::string& s) {
    if (s.empty() || s.size() > 8000) return false;
    for (unsigned char c : s) if (!(std::isalnum(c) || c == '_' || c == '{' || c == '}' || c == '[' || c == ']' || c == '"' || c == ':' || c == ',')) return false;
    return true;
}
std::vector<std::string> HostedCrewEnvUnset(const std::string& brain, const std::string& tool) {
    const bool codex = tool == "codex", login = brain == "login";
    std::vector<std::string> unset = {"ANTHROPIC_*", "CLAUDE_*"};
    if (login && !codex) unset = HostedApiKeyVars("claude-code");   // exactly what a chat on the owner's login removes
    if (login && codex) { const auto keys = HostedApiKeyVars("codex"); unset.insert(unset.end(), keys.begin(), keys.end()); }
    else unset.insert(unset.end(), {"OPENAI_*", "CODEX_*"});
    unset.insert(unset.end(), {"AZURE_OPENAI_*", "AWS_*", "GOOGLE_API_KEY", "GEMINI_API_KEY", "HF_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "SSH_AUTH_SOCK",
                               "CLOUDFLARE_*", "CF_API_TOKEN", "BUTLER_API_KEY", "STEAM_*"});
    return unset;
}
std::map<std::string, std::string> HostedCrewEnv(const std::string& brain, const std::map<std::string, std::string>& brainEnv, const std::string& claudeConfigDir, const std::string& runToken,
                                                 const std::string& tool, const std::string& codexHome) {
    std::map<std::string, std::string> env;
    const bool codex = tool == "codex";
    if (!codex && (brain == "api-key" || brain == "ollama")) env = brainEnv;
    // Set after the brain's variables, so a brain can never repoint the CLI's config dir or swap the run token.
    env["GIT_TERMINAL_PROMPT"] = "0"; env["SMITH_RUN_TOKEN"] = runToken;
    if (codex) { if (brain != "login") env["CODEX_HOME"] = codexHome; return env; }   // empty: no sign-in is reachable from it
    env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
    if (brain != "login") env["CLAUDE_CONFIG_DIR"] = claudeConfigDir;   // empty: no sign-in is reachable from it
    return env;
}
std::string HostedCrewSettingsJson(bool allowCreateProject, const std::string& inputDir, const std::string& repoDir) {
    nlohmann::json allow = {"mcp__smith__crew_report", "mcp__smith__crew_remember", "mcp__smith__crew_inbox", "mcp__smith__crew_send", "mcp__smith__crew_list",
                            "mcp__smith__list_projects", "mcp__smith__list_builds", "mcp__smith__get_build", "mcp__smith__read_build_log"};
    if (allowCreateProject) allow.push_back("mcp__smith__crew_create_project");
    // Each path rule comes native, as "//" plus the path in forward slashes (//C:/w/in/**), Claude Code's absolute form, and
    // for a drive path as //c/w/in/** (the form Claude Code's docs say Windows paths are normalised to before matching), so
    // the deny holds whichever form the CLI matches.
    nlohmann::json deny = {"Bash(*)"};
    for (const auto& dir : {inputDir, repoDir + "/.git"}) {
        std::string unified = dir; std::replace(unified.begin(), unified.end(), '\\', '/');
        std::vector<std::string> forms = {dir, (unified.rfind('/', 0) == 0 ? "/" : "//") + unified};   // a POSIX path already starts with one
        if (unified.size() >= 2 && std::isalpha(static_cast<unsigned char>(unified[0])) && unified[1] == ':')
            forms.push_back("//" + std::string(1, static_cast<char>(std::tolower(static_cast<unsigned char>(unified[0])))) + unified.substr(2));
        for (const char* tool : {"Edit", "Write", "NotebookEdit"}) for (const auto& path : forms) deny.push_back(std::string(tool) + "(" + path + "/**)");
    }
    return nlohmann::json{{"permissions", {{"allow", allow}, {"deny", deny}}}}.dump();
}
bool HostedCrewSkip(const std::string& remoteSha, const std::string& skipIfCommit) { return !remoteSha.empty() && !skipIfCommit.empty() && remoteSha == skipIfCommit; }
HostedCrewDirs HostedCrewDirsFor(const std::string& root, const std::string& memberId, const std::string& sessionId) {
    namespace fs = std::filesystem; HostedCrewDirs d;
    const fs::path member = fs::path(root) / "ai" / "crew" / memberId, run = member / "runs" / sessionId;
    d.memberRoot = member.string(); d.repo = (member / "repo").string(); d.memberControl = (member / "control").string(); d.gitconfig = (member / "control" / "gitconfig").string();
    d.run = run.string(); d.input = (run / "input").string(); d.related = (run / "input" / "related").string(); d.newProject = (run / "new-project").string();
    d.runControl = (run / "control").string(); d.claudeConfig = (run / "control" / "claude-config").string(); d.codexHome = (run / "control" / "codex-home").string();
    return d;
}
bool HostedCrewPathsIsolated(const HostedCrewDirs& d) {
    for (const auto* path : {&d.repo, &d.gitconfig, &d.input, &d.newProject, &d.runControl}) if (path->empty()) return false;
    const std::string repo = HostedCrewPathKey(d.repo), gitconfig = HostedCrewPathKey(d.gitconfig), runControl = HostedCrewPathKey(d.runControl);
    for (const auto* addDir : {&d.input, &d.newProject}) {
        const std::string dir = HostedCrewPathKey(*addDir);
        // An add-dir that is, holds or sits inside a protected path hands the CLI that path.
        if (HostedCrewContains(dir, gitconfig) || HostedCrewContains(dir, runControl) || HostedCrewContains(dir, repo) || HostedCrewContains(repo, dir)) return false;
    }
    return !HostedCrewContains(repo, runControl) && !HostedCrewContains(repo, gitconfig);
}
std::vector<std::string> HostedCrewCommitArgv(const std::string& name, const std::string& slug, const std::string& subject, const std::string& sessionId, const std::string& tool) {
    const std::string coAuthor = tool == "codex" ? "Codex <noreply@openai.com>" : "Claude Code <noreply@anthropic.com>";
    return {"commit", "-q", "--no-verify", "--author=" + name + " (Smith crew) <crew-" + slug + "@smith.invalid>", "-m", "Smith crew " + slug + ": " + subject.substr(0, 72),
            "-m", "Crew run " + sessionId + ".\n\nCo-Authored-By: " + coAuthor};
}
std::string HostedCrewExtractReport(const std::string& line) {
    const auto v = nlohmann::json::parse(line, nullptr, false);
    // Compare rather than value<std::string>(): a line whose "type" is not a string must read as "no report", not throw.
    if (!v.is_object() || !v.contains("type") || v["type"] != "result" || !v.contains("structured_output") || !v["structured_output"].is_object()) return "";
    return v["structured_output"].dump();   // nlohmann sorts keys, so the CHECK compares canonical text
}
std::string HostedCrewExtractCodexReport(const std::string& lastMessage) {
    auto text = lastMessage;
    // A model may still wrap the JSON in a Markdown fence; the schema is enforced, the fence is not.
    static const std::regex fenced(R"(^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$)");
    std::smatch match;
    if (std::regex_match(text, match, fenced)) text = match[1];
    const auto v = nlohmann::json::parse(text, nullptr, false);
    return v.is_object() ? v.dump() : std::string();
}
bool HostedCrewSchemaValid(const std::string& schema) {
    if (schema.empty() || schema.size() > 16384) return false;
    const auto v = nlohmann::json::parse(schema, nullptr, false);
    return v.is_object();
}
bool HostedCrewPrivateKeyLine(const std::string& line) {
    static const std::regex key(R"(^\+.*-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----)");
    return std::regex_search(line, key);
}
bool HostedCrewNewProjectDirValid(const std::string& dir) {
    namespace fs = std::filesystem; std::error_code ec; const fs::path p(dir);
    // Only plain directories and files: symlink_status reports a symlink, an NTFS junction (which
    // fs::is_symlink misses) or a special file as some other type, so it is refused wherever it sits.
    if (fs::symlink_status(p, ec).type() != fs::file_type::directory || ec) return false;
    for (fs::recursive_directory_iterator it(p, fs::directory_options::skip_permission_denied, ec), end; !ec && it != end; it.increment(ec)) {
        std::string name = it->path().filename().string();
        for (char& c : name) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));   // NTFS treats .GIT as .git
        const auto type = it->symlink_status(ec).type();
        if (name == ".git" || ec || (type != fs::file_type::directory && type != fs::file_type::regular)) return false;
    }
    return !ec;
}
bool HostedCrewProjectIdValid(const std::string& id) { static const std::regex rule("[a-z0-9][a-z0-9-]{1,39}"); return std::regex_match(id, rule); }
namespace {
// Whether any file under `dir` (already HostedCrewNewProjectDirValid: plain files and folders only) holds one of `secrets`.
bool HostedCrewDirHoldsSecret(const std::string& dir, const std::vector<std::string>& secrets) {
    namespace fs = std::filesystem; std::error_code ec;
    if (std::all_of(secrets.begin(), secrets.end(), [](const std::string& s) { return s.empty(); })) return false;
    for (fs::recursive_directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
        if (!it->is_regular_file(ec)) continue;
        std::ifstream in(it->path(), std::ios::binary);
        if (!in.is_open()) return true;   // a file Smith cannot read cannot be shown clean
        std::stringstream text; text << in.rdbuf();
        if (HostedRedact(text.str(), secrets) != text.str()) return true;
    }
    return static_cast<bool>(ec);
}
}
std::vector<std::string> HostedCrewNewProjectIds(const std::string& newProjectDir, std::vector<std::string>& refused, const std::vector<std::string>& secrets) {
    namespace fs = std::filesystem; std::error_code ec; std::vector<std::string> names, ids;
    refused.clear();
    for (fs::directory_iterator it(newProjectDir, ec), end; !ec && it != end; it.increment(ec)) names.push_back(it->path().filename().string());
    std::sort(names.begin(), names.end());
    for (const auto& name : names) {
        const auto dir = (fs::path(newProjectDir) / name).string();
        if (ids.size() < 5 && HostedCrewProjectIdValid(name) && HostedCrewNewProjectDirValid(dir) && !HostedCrewDirHoldsSecret(dir, secrets)) ids.push_back(name);
        else refused.push_back(name);
    }
    return ids;
}
std::vector<std::string> HostedCrewStripFiles() { return {"CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude", ".mcp.json"}; }
void HostedCrewStripInstructionFiles(const std::string& dir) {
    namespace fs = std::filesystem;
    const auto lower = [](std::string text) { for (char& c : text) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c))); return text; };
    std::vector<std::string> names; for (const auto& name : HostedCrewStripFiles()) names.push_back(lower(name));
    std::vector<fs::path> found; std::error_code error;
    for (fs::recursive_directory_iterator it(dir, error), end; !error && it != end; it.increment(error)) {
        const auto name = lower(it->path().filename().string());
        const bool strip = std::find(names.begin(), names.end(), name) != names.end();
        if (name == ".git" || strip) { if (strip) found.push_back(it->path()); it.disable_recursion_pending(); }
    }
    for (const auto& path : found) fs::remove_all(path, error);
}
std::string HostedCrewMcpConfigJson(const std::string& url) {
    return nlohmann::json{{"mcpServers", {{"smith", {{"type", "http"}, {"url", url}, {"headers", {{"Authorization", "Bearer ${SMITH_RUN_TOKEN}"}}}}}}}}.dump();
}
std::string HostedCrewCapText(const std::string& text, size_t maxBytes) {
    if (text.size() <= maxBytes) return text;
    size_t cut = maxBytes ? text.rfind('\n', maxBytes - 1) : std::string::npos;
    if (cut != std::string::npos) ++cut;   // keep that line end
    else for (cut = maxBytes; cut > 0 && (static_cast<unsigned char>(text[cut]) & 0xC0) == 0x80; --cut) {}   // back to the split character's first byte
    const std::string kept = text.substr(0, cut);
    return kept + (kept.empty() || kept.back() == '\n' ? "" : "\n") + "[cut by Smith at " + std::to_string(maxBytes / 1024) + " KB]\n";
}
std::string HostedCrewRemoteSha(const std::string& lsRemoteOutput, const std::string& ref) {
    std::istringstream lines(lsRemoteOutput); std::string line;
    const std::regex sha("[a-f0-9]{40}");
    while (std::getline(lines, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.size() > 41 && line[40] == '\t' && line.compare(41, std::string::npos, ref) == 0 && std::regex_match(line.substr(0, 40), sha)) return line.substr(0, 40);
    }
    return "";
}
std::string HostedRedact(const std::string& text, const std::vector<std::string>& secrets) {
    std::vector<bool> hidden;
    for (const auto& secret : secrets) {
        if (secret.empty()) continue;
        for (size_t at = text.find(secret); at != std::string::npos; at = text.find(secret, at + 1)) {
            if (hidden.empty()) hidden.assign(text.size(), false);
            std::fill(hidden.begin() + static_cast<std::ptrdiff_t>(at), hidden.begin() + static_cast<std::ptrdiff_t>(at + secret.size()), true);
        }
    }
    if (hidden.empty()) return text;
    std::string out;
    for (size_t i = 0; i < text.size(); ++i) {
        if (!hidden[i]) out += text[i];
        else if (i == 0 || !hidden[i - 1]) out += "[redacted]";
    }
    return out;
}
std::vector<std::string> HostedCrewFinishFiles(const std::string& nameOnlyZ, size_t& total) {
    constexpr size_t maxFiles = 500, maxPath = 512, maxJson = 24 * 1024;
    std::vector<std::string> paths;   // the plain ones, in git's order; the rest are counted, never listed
    total = 0;
    for (size_t start = 0; start < nameOnlyZ.size();) {
        const size_t end = std::min(nameOnlyZ.find('\0', start), nameOnlyZ.size());
        const std::string path = nameOnlyZ.substr(start, end - start);
        start = end + 1;
        if (path.empty()) continue;
        ++total;
        if (path.size() <= maxPath && std::none_of(path.begin(), path.end(), [](char c) { return static_cast<unsigned char>(c) < 0x20; })) paths.push_back(path);
    }
    std::vector<bool> chosen(paths.size(), false); size_t json = 2, count = 0;   // "[]"
    // Measured as the finish serialises it, so a path full of quotes or backslashes counts at its escaped size.
    const auto take = [&](size_t i) {
        const size_t size = nlohmann::json(paths[i]).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace).size() + (count ? 1 : 0);
        if (count >= maxFiles || json + size > maxJson) return false;
        chosen[i] = true; json += size; ++count; return true;
    };
    for (size_t i = 0; i < paths.size(); ++i) if (HostedCrewGuardedPath(paths[i])) take(i);                    // what Verify's guard reads, first
    for (size_t i = 0; i < paths.size(); ++i) if (!chosen[i] && !HostedCrewGuardedPath(paths[i]) && !take(i)) break;   // then the rest while they fit
    std::vector<std::string> files;
    for (size_t i = 0; i < paths.size(); ++i) if (chosen[i]) files.push_back(paths[i]);
    return files;
}
bool HostedCrewGuardedPath(const std::string& path) {
    std::string name = path.substr(path.find_last_of("/\\") == std::string::npos ? 0 : path.find_last_of("/\\") + 1);
    for (char& c : name) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (name == "smith.json") return true;
    for (const std::string ext : {".ps1", ".sh", ".bat", ".cmd", ".py"}) if (name.size() > ext.size() && name.compare(name.size() - ext.size(), ext.size(), ext) == 0) return true;
    return false;
}
std::string HostedCrewBuildLogName(const std::string& jobId) {
    static const std::regex id("[A-Za-z0-9_-]{1,64}");
    return std::regex_match(jobId, id) ? "build-" + jobId + ".log" : std::string();
}
bool HostedCrewGitlinkLine(const std::string& line) {
    // ":<old mode> <new mode> <old sha> <new sha> <status>\t<path>"
    if (line.empty() || line[0] != ':') return false;
    std::istringstream fields(line.substr(1)); std::string oldMode, newMode;
    return static_cast<bool>(fields >> oldMode >> newMode) && newMode == "160000";
}
std::map<std::string, std::string> HostedCrewGitEnv(const HostedCrewDirs& d) { return {{"GIT_CONFIG_GLOBAL", d.gitconfig}}; }
std::vector<std::string> HostedCrewStaleRuns(const std::vector<std::string>& runIds, const std::string& sessionId) {
    std::vector<std::string> stale;
    if (!sessionId.empty()) for (const auto& id : runIds) if (id != sessionId) stale.push_back(id);
    return stale;
}
void HostedCrewRemoveStaleRuns(const HostedCrewDirs& d, const std::string& sessionId) {
    namespace fs = std::filesystem; std::error_code ec;
    const fs::path runs = fs::path(d.memberRoot) / "runs";
    std::vector<std::string> ids;
    for (fs::directory_iterator it(runs, ec), end; !ec && it != end; it.increment(ec)) ids.push_back(it->path().filename().string());
    for (const auto& id : HostedCrewStaleRuns(ids, sessionId)) fs::remove_all(runs / id, ec);
}
std::string HostedCrewPushRefusal(const std::string& url, const std::string& token) {
    const bool copy = HostedArtifactsRemote(url);
    if (copy && token.empty()) return "this crew push to Smith's copy of the project came without its token";
    if (!copy && !token.empty()) return "this crew push came with a Smith token for a project that is not Smith's copy";
    return "";
}
}
