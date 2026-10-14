// HostedGitHost.cpp - see HostedGitHost.h.
#include "HostedGitHost.h"
#include "HostedPlatform.h"
#include <SmithCore/Process.h>
#include <json/single_include/nlohmann/json.hpp>
#include <algorithm>
#include <cstdio>
#include <set>
#include <filesystem>
#include <fstream>
#include <regex>
#include <stdexcept>
namespace fs = std::filesystem;
namespace Smith {
namespace {
using Json = nlohmann::json;
bool Hex(const std::string& s, size_t a, size_t b) {
    if (s.size() != a && s.size() != b) return false;
    for (char c : s) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    return true;
}
bool RefNameValid(const std::string& ref) {
    if (ref.size() > 512 || ref.rfind("refs/", 0) != 0 || ref.back() == '/' || ref.back() == '.') return false;
    for (unsigned char c : ref) if (c <= 32 || c == 127 || c == '~' || c == '^' || c == ':' || c == '?' || c == '*' || c == '[' || c == '\\') return false;
    return ref.find("..") == std::string::npos && ref.find("//") == std::string::npos && ref.find("@{") == std::string::npos && ref.find("/.") == std::string::npos && ref.find(".lock/") == std::string::npos && !(ref.size() >= 5 && ref.compare(ref.size() - 5, 5, ".lock") == 0);
}
std::string Join(const std::vector<std::string>& items) { std::string out; for (const auto& item : items) { if (!out.empty()) out += ' '; out += item; } return out; }
std::string PktLine(const std::string& payload) { char length[8]; std::snprintf(length, sizeof length, "%04x", (unsigned)(payload.size() + 4)); return length + payload; }
int RunStoreGit(const std::string& bareDir, std::vector<std::string> args, std::vector<std::string>* lines, std::string& error, int timeout = 600) { return HostedGitRunStore(bareDir, args, lines, error, timeout); }
}
int HostedGitRunStore(const std::string& bareDir, const std::vector<std::string>& args, std::vector<std::string>* lines, std::string& error, int timeoutSeconds, const std::map<std::string, std::string>& extraEnv) {
    ProcessOptions options; options.argv = {"git", "--git-dir=" + bareDir}; options.argv.insert(options.argv.end(), args.begin(), args.end());
    options.envUnset = HostedGitServeEnvUnset(); options.envOverride = {{"GIT_CONFIG_NOSYSTEM", "1"}, {"GIT_CONFIG_GLOBAL", HostedGitEmptyConfig(fs::path(bareDir).parent_path().string())}, {"GIT_TERMINAL_PROMPT", "0"}};
    for (const auto& kv : extraEnv) options.envOverride[kv.first] = kv.second;
    options.timeoutSeconds = timeoutSeconds; options.stopWithParent = true;
    Process process;
    return process.Run(options, [&](bool isError, const std::string& line) {
        if (isError) { if (error.size() < 2000) error += line.substr(0, 400) + "\n"; }
        else if (lines && lines->size() < 20000) lines->push_back(line);
    });
}
std::string HostedGitVersion(const std::string& versionLine) {
    const std::string prefix = "git version ";
    const auto at = versionLine.find(prefix);
    if (at == std::string::npos) return "";
    std::string version; size_t i = at + prefix.size();
    while (i < versionLine.size()) {
        const char c = versionLine[i];
        if (c >= '0' && c <= '9') version += c;
        else if (c == '.' && i + 1 < versionLine.size() && versionLine[i + 1] >= '0' && versionLine[i + 1] <= '9' && !version.empty()) version += c;
        else break;
        ++i;
    }
    return version.empty() || version.find('.') == std::string::npos ? "" : version;
}
bool HostedGitVersionAtLeast(const std::string& version, int major, int minor) {
    int a = 0, b = 0; if (std::sscanf(version.c_str(), "%d.%d", &a, &b) < 1) return false;
    return a > major || (a == major && b >= minor);
}
HostedHostingAbility HostedGitHostAbility(const std::string& gitVersionLine, bool execPathOk, int64_t freeBytes, bool storeOk) {
    HostedHostingAbility ability;
    const auto version = HostedGitVersion(gitVersionLine);
    if (version.empty()) { ability.reason = "git is not installed or not on PATH"; return ability; }
    if (!HostedGitVersionAtLeast(version, 2, 36)) { ability.reason = "git " + version + " is older than 2.36"; return ability; }
    if (!execPathOk) { ability.reason = "git's exec path (git --exec-path) is missing"; return ability; }
    if (freeBytes < kHostedGitMinFreeBytes) { char text[64]; std::snprintf(text, sizeof text, "only %.1f GB free", (double)freeBytes / (1024.0 * 1024 * 1024)); ability.reason = text; return ability; }
    if (!storeOk) { ability.reason = "the agent's workspace could not be made private"; return ability; }
    ability.able = true; return ability;
}
HostedRefPolicy HostedParseRefPolicy(const std::string& json) {
    HostedRefPolicy policy;
    const auto value = Json::parse(json, nullptr, false);
    if (!value.is_object()) return policy;
    static const std::regex pattern("[A-Za-z0-9/_.*-]{1,256}");
    const auto list = [&](const char* key, std::vector<std::string>& out) {
        if (!value.contains(key) || !value[key].is_array()) return;
        for (const auto& item : value[key]) if (item.is_string() && out.size() < 32 && std::regex_match(item.get<std::string>(), pattern)) out.push_back(item.get<std::string>());
    };
    list("allow", policy.allow); list("protected", policy.protectedRefs);
    policy.denyDelete = value.value("denyDelete", false);
    return policy;
}
bool HostedRefGlob(const std::string& pattern, const std::string& ref) {
    if (pattern.empty() || ref.empty()) return false;
    size_t p = 0, r = 0, star = std::string::npos, mark = 0;
    while (r < ref.size()) {
        if (p < pattern.size() && pattern[p] == '*') { star = p++; mark = r; }
        else if (p < pattern.size() && pattern[p] == ref[r]) { ++p; ++r; }
        else if (star != std::string::npos) { p = star + 1; r = ++mark; }
        else return false;
    }
    while (p < pattern.size() && pattern[p] == '*') ++p;
    return p == pattern.size();
}
std::vector<std::string> HostedGitServeArgv(const std::string& service, const std::string& op, const std::string& bareDir) {
    if ((service != "upload-pack" && service != "receive-pack") || bareDir.empty()) return {};
    if (op == "info-refs") return {"git", service, "--http-backend-info-refs", bareDir};
    if (op == "rpc") return {"git", service, "--stateless-rpc", bareDir};
    return {};
}
std::map<std::string, std::string> HostedGitServeEnv(const std::string& gitProtocol, const HostedRefPolicy& policy, const std::string& emptyGlobalConfig) {
    std::map<std::string, std::string> env = {
        {"GIT_CONFIG_NOSYSTEM", "1"}, {"GIT_CONFIG_GLOBAL", emptyGlobalConfig}, {"GIT_TERMINAL_PROMPT", "0"},
        {"SMITH_ALLOWED_REFS", Join(policy.allow)}, {"SMITH_PROTECTED_REFS", Join(policy.protectedRefs)}, {"SMITH_DENY_DELETE", policy.denyDelete ? "1" : "0"}};
    static const std::regex protocolPattern("[A-Za-z0-9=:_-]{1,64}");
    if (std::regex_match(gitProtocol, protocolPattern)) env["GIT_PROTOCOL"] = gitProtocol;
    return env;
}
std::vector<std::string> HostedGitServeEnvUnset() {
    return {"GIT_*", "SSH_ASKPASS", "SSH_AUTH_SOCK", "GCM_*", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "AWS_*", "CLOUDFLARE_*", "CF_API_TOKEN", "BUTLER_API_KEY", "STEAM_*", "ANTHROPIC_*", "OPENAI_*", "CODEX_*", "CLAUDE_*"};
}
std::string HostedGitInfoRefsPreamble(const std::string& service) { return PktLine("# service=git-" + service + "\n") + "0000"; }
std::string HostedPktErr(const std::string& message) {
    std::string clean;
    for (char c : message.substr(0, 900)) clean += (c == '\r' || c == '\n' || c == '\0') ? ' ' : c;
    return PktLine("ERR " + clean + "\n");
}
std::string HostedGitRefuseReceive(const std::string& body) {
    static const std::regex command("[0-9a-f]{40}(?:[0-9a-f]{24})? [0-9a-f]{40}(?:[0-9a-f]{24})? refs/\\S+");
    size_t at = 0, commands = 0;
    while (true) {
        if (body.size() - at < 4) return commands ? "" : "the push command list could not be read";
        unsigned length = 0;
        if (std::sscanf(body.substr(at, 4).c_str(), "%4x", &length) != 1 || body.substr(at, 4).find_first_not_of("0123456789abcdef") != std::string::npos) return "the push command list could not be read";
        if (length == 0) return commands ? "" : "the push names no refs";
        if (length < 4) return "the push command list could not be read";
        if (at + length > body.size()) return "";   // only the head was read; git parses the rest
        std::string line = body.substr(at + 4, length - 4);
        if (!line.empty() && line.back() == '\n') line.pop_back();
        const auto nul = line.find('\0');
        const std::string capabilities = nul == std::string::npos ? "" : " " + line.substr(nul + 1) + " ";
        line = line.substr(0, nul);
        if (line.rfind("shallow ", 0) == 0) return "pushes from shallow clones are not accepted";
        if (line.rfind("push-cert", 0) == 0 || capabilities.find(" push-cert") != std::string::npos) return "signed pushes are not accepted";
        if (capabilities.find(" push-options ") != std::string::npos) return "push options are not accepted";
        if (!std::regex_match(line, command)) return "the push command list could not be read";
        ++commands; at += length;
    }
}
std::string HostedGitUpdateHook() {
    return
        "#!/bin/sh\n"
        "# Smith update hook: the ref policy of the credential whose push the coordinator relayed here.\n"
        "# SMITH_ALLOWED_REFS / SMITH_PROTECTED_REFS hold space-separated glob patterns; SMITH_DENY_DELETE=1 refuses deletions.\n"
        "set -f   # patterns are matched by case, never expanded against the store's own files\n"
        "ref=\"$1\" old=\"$2\" new=\"$3\"\n"
        "matches() {\n"
        "  for pattern in $1; do\n"
        "    case \"$2\" in $pattern) return 0 ;; esac\n"
        "  done\n"
        "  return 1\n"
        "}\n"
        "is_zero() {\n"
        "  case \"$1\" in 0000000000000000000000000000000000000000|0000000000000000000000000000000000000000000000000000000000000000) return 0 ;; esac\n"
        "  return 1\n"
        "}\n"
        "case \"$ref\" in refs/smith/*) echo \"Smith: refs/smith/* is reserved for Smith\" >&2; exit 1 ;; esac\n"
        "if [ -n \"$SMITH_ALLOWED_REFS\" ] && ! matches \"$SMITH_ALLOWED_REFS\" \"$ref\"; then\n"
        "  echo \"Smith: this credential cannot push to $ref\" >&2; exit 1\n"
        "fi\n"
        "if is_zero \"$new\"; then\n"
        "  if [ \"$SMITH_DENY_DELETE\" = \"1\" ] || matches \"$SMITH_PROTECTED_REFS\" \"$ref\"; then\n"
        "    echo \"Smith: deleting $ref is not allowed\" >&2; exit 1\n"
        "  fi\n"
        "  exit 0\n"
        "fi\n"
        "if ! is_zero \"$old\" && matches \"$SMITH_PROTECTED_REFS\" \"$ref\"; then\n"
        "  if ! git merge-base --is-ancestor \"$old\" \"$new\" >/dev/null 2>&1; then\n"
        "    echo \"Smith: $ref is protected; a force-push is refused. Pull, merge or rebase, then push again\" >&2; exit 1\n"
        "  fi\n"
        "fi\n"
        "exit 0\n";
}
std::vector<std::pair<std::string, std::string>> HostedGitParseTips(const std::string& output, std::map<std::string, std::string>* peeled) {
    std::vector<std::pair<std::string, std::string>> tips;
    size_t start = 0;
    while (start < output.size()) {
        size_t end = output.find('\n', start); if (end == std::string::npos) end = output.size();
        std::string line = output.substr(start, end - start); start = end + 1;
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
        if (line.empty()) continue;
        const auto space = line.find(' ');
        if (space == std::string::npos) throw std::runtime_error("Malformed ref line");
        const std::string sha = line.substr(0, space);
        std::string ref = line.substr(space + 1), target;
        const auto second = ref.find(' ');
        if (second != std::string::npos) { target = ref.substr(second + 1); ref = ref.substr(0, second); }
        if (!Hex(sha, 40, 64) || !RefNameValid(ref) || (!target.empty() && !Hex(target, 40, 64))) throw std::runtime_error("Malformed ref line: " + ref.substr(0, 80));
        if (ref.rfind("refs/smith/", 0) == 0) continue;
        tips.emplace_back(sha, ref);
        if (peeled && !target.empty()) (*peeled)[ref] = target;
    }
    std::sort(tips.begin(), tips.end(), [](const auto& a, const auto& b) { return a.second < b.second; });
    tips.erase(std::unique(tips.begin(), tips.end(), [](const auto& a, const auto& b) { return a.second == b.second; }), tips.end());
    if (tips.size() > 10000) throw std::runtime_error("The repository has more than 10000 refs");
    return tips;
}
std::string HostedGitTipsJson(const std::vector<std::pair<std::string, std::string>>& tips) {
    Json list = Json::array();
    for (const auto& tip : tips) list.push_back({tip.first, tip.second});
    return list.dump();
}
std::string HostedGitPeeledJson(const std::map<std::string, std::string>& peeled) {
    Json object = Json::object();
    for (const auto& entry : peeled) object[entry.first] = entry.second;
    return object.dump();
}
int64_t HostedGitCountedBytes(const std::vector<std::string>& lines) {
    int64_t kib = 0;
    for (const auto& line : lines) { const auto colon = line.find(':'); if (colon == std::string::npos) continue; const auto key = line.substr(0, colon); if (key == "size" || key == "size-pack") kib += std::strtoll(line.c_str() + colon + 1, nullptr, 10); }
    return kib * 1024;
}
std::vector<std::pair<std::string, std::string>> HostedGitStoreConfig(const std::string& hooksDir) {
    return {{"receive.fsckObjects", "true"}, {"transfer.fsckObjects", "true"}, {"fetch.fsckObjects", "true"}, {"receive.maxInputSize", "104857600"},
            {"receive.advertiseAtomic", "true"}, {"uploadpack.allowFilter", "true"}, {"core.logAllRefUpdates", "true"}, {"core.hooksPath", hooksDir}};
}
std::string HostedGitEmptyConfig(const std::string& dir) {
    const fs::path file = fs::path(dir) / ".empty-gitconfig"; std::error_code ec;
    if (!fs::is_regular_file(fs::symlink_status(file, ec)) || fs::file_size(file, ec) != 0) { fs::create_directories(dir, ec); HostedSecureWrite(file.string(), ""); }
    return file.string();
}
bool HostedGitUuidValid(const std::string& uuid) { static const std::regex pattern("[a-f0-9][a-f0-9-]{7,63}"); return std::regex_match(uuid, pattern); }
std::string HostedGitStorePath(const std::string& root, const std::string& workspaceId, const std::string& repoUuid) {
    if (!HostedGitUuidValid(repoUuid) || !Hex(workspaceId, 64, 64)) throw std::runtime_error("Unsafe repository identity");
    return (fs::path(root) / "git" / workspaceId.substr(0, 12) / (repoUuid + ".git")).string();
}
void HostedGitProvisionHooks(const std::string& hooksDir) {
    HostedSecureDirectory(hooksDir);
    const fs::path hook = fs::path(hooksDir) / "update";
    const std::string wanted = HostedGitUpdateHook();
    std::error_code ec;
    if (fs::is_regular_file(fs::symlink_status(hook, ec))) { std::ifstream in(hook, std::ios::binary); std::string current((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>()); if (current == wanted) { fs::permissions(hook, fs::perms::owner_all, ec); return; } }
    HostedSecureWrite(hook.string(), wanted);
    fs::permissions(hook, fs::perms::owner_all, ec);
}
std::string HostedGitInitStore(const std::string& bareDir, const std::string& hooksDir) {
    std::string error;
    for (const auto& entry : HostedGitStoreConfig(hooksDir)) if (RunStoreGit(bareDir, {"config", entry.first, entry.second}, nullptr, error, 60) != 0) return error.empty() ? "git config failed" : error;
    std::ifstream in(fs::path(bareDir) / "config", std::ios::binary); std::string config((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    if (config.empty()) return "the repository has no config file";
    HostedSecureWrite(bareDir + ".config", config);
    return "";
}
bool HostedGitStoreTrusted(const std::string& bareDir) {
    const fs::path config = fs::path(bareDir) / "config", snapshot = bareDir + ".config";
    std::error_code ec;
    if (!fs::is_regular_file(fs::symlink_status(config, ec)) || !fs::is_regular_file(fs::symlink_status(snapshot, ec))) return false;
    if (fs::file_size(config, ec) > 64 * 1024) return false;
    std::ifstream a(config, std::ios::binary), b(snapshot, std::ios::binary);
    const std::string current((std::istreambuf_iterator<char>(a)), std::istreambuf_iterator<char>()), expected((std::istreambuf_iterator<char>(b)), std::istreambuf_iterator<char>());
    return !current.empty() && current == expected;
}
std::vector<std::pair<std::string, std::string>> HostedGitStoreTips(const std::string& bareDir, int64_t& bytes, std::string& error, std::map<std::string, std::string>* peeled) {
    std::vector<std::string> lines; bytes = 0;
    if (RunStoreGit(bareDir, {"for-each-ref", kHostedGitTipsFormat}, &lines, error, 300) != 0) { if (error.empty()) error = "git for-each-ref failed"; return {}; }
    std::string joined; for (const auto& line : lines) { joined += line; joined += '\n'; }
    std::vector<std::pair<std::string, std::string>> tips;
    if (peeled) peeled->clear();
    try { tips = HostedGitParseTips(joined, peeled); } catch (const std::exception& e) { error = e.what(); return {}; }
    lines.clear();
    if (RunStoreGit(bareDir, {"count-objects", "-v"}, &lines, error, 300) != 0) { if (error.empty()) error = "git count-objects failed"; return {}; }
    bytes = HostedGitCountedBytes(lines);
    return tips;
}
std::vector<std::string> HostedGitReplicateArgv(const std::string& bareDir, const std::string& remote) {
    return {"git", "--git-dir=" + bareDir, "fetch", "--prune", "--atomic", "--no-tags", "--quiet", "--", remote, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"};
}
std::vector<std::pair<std::string, std::string>> HostedGitRecoverable(const std::vector<std::pair<std::string, std::string>>& before, const std::vector<std::pair<std::string, std::string>>& after,
    const std::function<bool(const std::string&, const std::string&)>& isAncestor, const std::function<bool(const std::string&)>& contained) {
    std::map<std::string, std::string> now; for (const auto& tip : after) now[tip.second] = tip.first;
    std::vector<std::pair<std::string, std::string>> recovered;
    for (const auto& tip : before) {
        if (tip.second.rfind("refs/smith/", 0) == 0) continue;
        const auto it = now.find(tip.second);
        if (it != now.end() && it->second == tip.first) continue;
        if (it != now.end() && isAncestor(tip.first, it->second)) continue;   // moved forward: nothing lost
        if (contained(tip.first)) continue;                                   // still reachable from some ref
        recovered.push_back(tip);
    }
    return recovered;
}
std::string HostedGitRecoveredRef(int64_t unixSeconds, const std::string& ref) {
    const std::string rest = ref.rfind("refs/", 0) == 0 ? ref.substr(5) : ref;
    return "refs/smith/recovered/" + std::to_string(unixSeconds) + "/" + rest;
}
std::vector<std::string> HostedGitBundleArgv(const std::string& bareDir, const std::string& file, const std::vector<std::string>& baseShas) {
    std::vector<std::string> argv = {"git", "--git-dir=" + bareDir, "bundle", "create", "--quiet", file, "--all"};
    std::set<std::string> seen;
    for (const auto& sha : baseShas) if (Hex(sha, 40, 64) && seen.insert(sha).second) argv.push_back("^" + sha);
    return argv;
}
std::vector<std::string> HostedGitRestoreDeletions(const std::vector<std::pair<std::string, std::string>>& restored, const std::vector<std::pair<std::string, std::string>>& manifest) {
    std::set<std::string> keep; for (const auto& tip : manifest) keep.insert(tip.second);
    std::vector<std::string> gone;
    for (const auto& tip : restored) if (!keep.count(tip.second) && tip.second.rfind("refs/smith/", 0) != 0) gone.push_back(tip.second);
    return gone;
}
std::string HostedGitInitBare(const std::string& bareDir, const std::string& hooksDir) {
    std::error_code ec; fs::create_directories(fs::path(bareDir).parent_path(), ec);
    std::string error;
    ProcessOptions options; options.argv = {"git", "init", "--quiet", "--bare", bareDir};
    options.envUnset = HostedGitServeEnvUnset(); options.envOverride = {{"GIT_CONFIG_NOSYSTEM", "1"}, {"GIT_CONFIG_GLOBAL", HostedGitEmptyConfig(fs::path(bareDir).parent_path().string())}, {"GIT_TERMINAL_PROMPT", "0"}};
    options.timeoutSeconds = 120; options.stopWithParent = true;
    Process process;
    if (process.Run(options, [&](bool isError, const std::string& line) { if (isError && error.size() < 2000) error += line + "\n"; }) != 0) return error.empty() ? "git init failed" : error;
    HostedGitProvisionHooks(hooksDir);
    return HostedGitInitStore(bareDir, hooksDir);
}
}
