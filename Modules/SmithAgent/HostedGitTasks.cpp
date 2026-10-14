// HostedGitTasks.cpp - see HostedGitTasks.h.
#include "HostedGitTasks.h"
#include "HostedAgent.h"
#include "HostedGitHost.h"
#include "HostedPlatform.h"
#include "HostedTransport.h"
#include <SmithCore/Housekeeping.h>
#include <SmithCore/TimeUtil.h>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <regex>
#include <thread>
namespace fs = std::filesystem;
namespace Smith {
namespace {
using Json = nlohmann::json;
using Tips = std::vector<std::pair<std::string, std::string>>;
std::string Field(const Json& j, const char* key, size_t max) { if (!j.contains(key) || !j[key].is_string()) return ""; const auto s = j[key].get<std::string>(); return s.size() <= max ? s : ""; }
Tips TipsOf(const Json& list) {
    Tips tips; if (!list.is_array()) return tips;
    for (const auto& item : list) if (item.is_array() && item.size() == 2 && item[0].is_string() && item[1].is_string()) tips.emplace_back(item[0].get<std::string>(), item[1].get<std::string>());
    return tips;
}
std::string Join(const Tips& tips) { return HostedGitTipsJson(tips); }
std::string ReadAll(const fs::path& file, size_t maximum) { std::ifstream in(file, std::ios::binary); std::string text(maximum, '\0'); in.read(text.data(), (std::streamsize)text.size()); text.resize((size_t)in.gcount()); return text; }
struct Context {
    const HostedTransport& transport; const HostedGitLoopConfig& config; const HostedGitTask& task; const std::atomic<bool>& stop;
    fs::path hooks, work; std::string store;
    std::map<std::string, std::string> Lease() const { return {{"X-Smith-Lease-Token", task.leaseToken}}; }
    HostedGitTaskResult Fail(const std::string& message) const { HostedGitTaskResult r; r.message = message.substr(0, 1000); return r; }
    // Every task ends by reporting the store's refs and size, so the record knows what this copy holds.
    HostedGitTaskResult Report(const std::string& bareDir, HostedGitTaskResult result) const {
        std::string error; int64_t bytes = 0; std::map<std::string, std::string> peeled;
        const auto tips = HostedGitStoreTips(bareDir, bytes, error, &peeled);
        if (!error.empty()) return Fail("Could not read the copy's refs: " + error);
        result.tipsJson = Join(tips); result.peeledJson = HostedGitPeeledJson(peeled); result.bytes = bytes; result.ok = true; return result;
    }
    std::string Git(const std::string& bareDir, const std::vector<std::string>& args, std::vector<std::string>* lines, int timeout, const std::map<std::string, std::string>& env = {}) const {
        std::string error;
        if (HostedGitRunStore(bareDir, args, lines, error, timeout, env) != 0) return error.empty() ? "git " + args[0] + " failed" : error;
        return "";
    }
    // Uploads a file in 5 MiB parts to the task's part route; false when a part could not be stored.
    bool UploadParts(const fs::path& file, int64_t fileSize) const {
        std::ifstream in(file, std::ios::binary); int part = 0; int64_t remaining = fileSize;
        while (remaining > 0 && !stop) {
            const auto want = (size_t)std::min<int64_t>(kHostedGitPartBytes, remaining);
            std::string chunk(want, '\0'); in.read(chunk.data(), (std::streamsize)want); chunk.resize((size_t)in.gcount());
            if (chunk.empty()) return false;
            ++part; bool stored = false;
            for (int attempt = 0; attempt < 3 && !stop; ++attempt) {
                const auto response = transport.PostBytes("/git/task/" + task.id + "/part?part=" + std::to_string(part), chunk, "application/octet-stream", Lease(), 300, (size_t)kHostedGitPartBytes + 1024);
                if (response.Ok() && response.body.value("accepted", false) && response.body.value("size", (int64_t)-1) == (int64_t)chunk.size()) { stored = true; break; }
                if (response.status >= 400 && response.status < 500) break;
                std::this_thread::sleep_for(std::chrono::seconds(2));
            }
            if (!stored) return false;
            remaining -= (int64_t)chunk.size();
        }
        return remaining == 0;
    }
};
// Replicate: the copy fetches heads and tags from the primary through the coordinator with the task's ticket. What it
// held beyond the record is kept under refs/smith/recovered/* and reported, never silently pruned.
HostedGitTaskResult Replicate(const Context& c) {
    const std::string remote = Field(c.task.payload, "remote", 512), ticket = Field(c.task.payload, "ticket", 512);
    if (!HostedSmithRemote(remote) && remote.rfind("file://", 0) != 0 && !fs::is_directory(remote)) return c.Fail("The copy's source is not Smith's own repository");
    std::error_code ec;
    if (!fs::is_directory(c.store, ec)) { const auto problem = HostedGitInitBare(c.store, c.hooks.string()); if (!problem.empty()) return c.Fail("Could not create the copy: " + problem); }
    if (!HostedGitStoreTrusted(c.store)) return c.Fail("The copy on " + c.config.hostname + " was altered outside Smith and is not synced");
    std::string error; int64_t bytes = 0;
    const Tips before = HostedGitStoreTips(c.store, bytes, error);
    if (!error.empty()) return c.Fail("Could not read the copy's refs: " + error);
    const int64_t need = 2 * (int64_t)c.task.payload.value("bytes", (int64_t)0) + 1024LL * 1024 * 1024;
    if ((int64_t)FreeDiskBytes(c.config.workspaceRoot) < need) return c.Fail("Not enough free disk on " + c.config.hostname + " for this copy");
    auto argv = HostedGitReplicateArgv(c.store, remote); argv.erase(argv.begin(), argv.begin() + 2);   // HostedGitRunStore adds git --git-dir
    const auto fetched = c.Git(c.store, argv, nullptr, 3600, HostedGitAuthEnv(remote, ticket));
    if (!fetched.empty()) return c.Fail("Fetching the copy failed: " + fetched);
    const Tips after = HostedGitStoreTips(c.store, bytes, error);
    if (!error.empty()) return c.Fail("Could not read the copy's refs: " + error);
    const auto isAncestor = [&](const std::string& old, const std::string& now) { std::string e; return HostedGitRunStore(c.store, {"merge-base", "--is-ancestor", old, now}, nullptr, e, 120) == 0; };
    const auto contained = [&](const std::string& old) { std::vector<std::string> refs; std::string e; HostedGitRunStore(c.store, {"for-each-ref", "--format=%(refname)", "--contains", old, "refs/heads", "refs/tags"}, &refs, e, 120); return !refs.empty(); };
    Tips recovered;
    const auto stamp = NowMillis() / 1000;
    for (const auto& tip : HostedGitRecoverable(before, after, isAncestor, contained)) {
        const auto kept = HostedGitRecoveredRef(stamp, tip.second);
        if (c.Git(c.store, {"update-ref", kept, tip.first}, nullptr, 60).empty()) recovered.emplace_back(tip.first, kept);
    }
    if (!c.task.defaultBranch.empty()) for (const auto& tip : after) if (tip.second == "refs/heads/" + c.task.defaultBranch) { c.Git(c.store, {"symbolic-ref", "HEAD", tip.second}, nullptr, 60); break; }
    HostedGitTaskResult result; if (!recovered.empty()) result.recoveredJson = Join(recovered);
    result.message = recovered.empty() ? "" : std::to_string(recovered.size()) + " ref(s) this copy held beyond the record were kept aside";
    return c.Report(c.store, result);
}
// Backup: a bundle of every ref (minus what the base bundle holds), verified, uploaded in parts.
HostedGitTaskResult Backup(const Context& c) {
    if (!HostedGitStoreTrusted(c.store)) return c.Fail("The copy on " + c.config.hostname + " was altered outside Smith and is not backed up");
    std::string kind = Field(c.task.payload, "kind", 16); if (kind != "incremental") kind = "full";
    std::vector<std::string> base; for (const auto& tip : TipsOf(c.task.payload.value("baseTips", Json::array()))) base.push_back(tip.first);
    const fs::path file = c.work / "bundle"; std::error_code ec; fs::remove(file, ec);
    std::string error;
    for (int round = 0; ; ++round) {
        auto argv = HostedGitBundleArgv(c.store, file.string(), kind == "incremental" ? base : std::vector<std::string>{}); argv.erase(argv.begin(), argv.begin() + 2);
        if (HostedGitRunStore(c.store, argv, nullptr, error, 3600) == 0) break;
        // The base bundle's tips are gone (a force-push, then gc): take a full bundle instead.
        if (kind == "incremental" && round == 0) { kind = "full"; error.clear(); fs::remove(file, ec); continue; }
        return c.Fail("git bundle create failed: " + error);
    }
    if (HostedGitRunStore(c.store, {"bundle", "verify", "--quiet", file.string()}, nullptr, error, 600) != 0) return c.Fail("The bundle did not verify: " + error);
    const int64_t size = fs::is_regular_file(file, ec) ? (int64_t)fs::file_size(file, ec) : 0;
    if (size <= 0) return c.Fail("The bundle is empty");
    std::string sha256 = size <= 256LL * 1024 * 1024 ? HostedSha256(ReadAll(file, (size_t)size)) : "";
    if (!c.UploadParts(file, size)) return c.Fail("The bundle could not be uploaded");
    HostedGitTaskResult result; result.kind = kind; result.size = size; result.sha256 = sha256;
    fs::remove(file, ec);
    return c.Report(c.store, result);
}
// Restore: the bundles come down in order into a fresh store, refs the newest manifest lacks are deleted, HEAD is set,
// connectivity is checked, and only then does the store take its place (never over an existing copy).
HostedGitTaskResult Restore(const Context& c) {
    std::error_code ec;
    if (fs::exists(c.store, ec)) return c.Fail(c.config.hostname + " already holds a copy of this repository");
    const std::string temp = c.store + ".restore-" + c.task.id;
    struct Cleanup { std::string path; bool keep = false; ~Cleanup() { if (!keep) { std::error_code e; fs::remove_all(path, e); fs::remove(path + ".config", e); } } } cleanup{temp};
    fs::remove_all(temp, ec); fs::remove(temp + ".config", ec);
    const auto& backups = c.task.payload.value("backups", Json::array());
    if (!backups.is_array() || backups.empty()) return c.Fail("There is no backup to restore from");
    int64_t total = 0; for (const auto& b : backups) total += b.value("size", (int64_t)0);
    if ((int64_t)FreeDiskBytes(c.config.workspaceRoot) < 3 * total + 1024LL * 1024 * 1024) return c.Fail("Not enough free disk on " + c.config.hostname + " to restore");
    auto problem = HostedGitInitBare(temp, c.hooks.string()); if (!problem.empty()) return c.Fail("Could not create the store: " + problem);
    int index = 0;
    for (const auto& b : backups) {
        const std::string id = Field(b, "id", 64), sha256 = Field(b, "sha256", 64); const int64_t size = b.value("size", (int64_t)0);
        if (!std::regex_match(id, std::regex("[a-f0-9-]{1,64}")) || size <= 0) return c.Fail("The backup list is invalid");
        const fs::path file = c.work / ("bundle-" + std::to_string(++index));
        const int status = c.transport.Download("/git/task/" + c.task.id + "/body?backup=" + id, file, size + 1024, 3600, c.Lease());
        if (status != 200 || !fs::is_regular_file(file, ec) || (int64_t)fs::file_size(file, ec) != size) return c.Fail("Backup " + std::to_string(index) + " could not be downloaded (HTTP " + std::to_string(status) + ")");
        if (!sha256.empty() && size <= 256LL * 1024 * 1024 && HostedSha256(ReadAll(file, (size_t)size)) != sha256) return c.Fail("Backup " + std::to_string(index) + " does not match its checksum");
        std::string error;
        if (HostedGitRunStore(temp, {"bundle", "verify", "--quiet", file.string()}, nullptr, error, 600) != 0) return c.Fail("Backup " + std::to_string(index) + " did not verify: " + error);
        if (HostedGitRunStore(temp, {"fetch", "--quiet", "--atomic", "--", file.string(), "+refs/*:refs/*"}, nullptr, error, 3600) != 0) return c.Fail("Backup " + std::to_string(index) + " could not be applied: " + error);
        fs::remove(file, ec);
    }
    std::string error; int64_t bytes = 0;
    const Tips restored = HostedGitStoreTips(temp, bytes, error);
    if (!error.empty()) return c.Fail("Could not read the restored refs: " + error);
    const Tips manifest = TipsOf(c.task.payload.value("newestTips", Json::array()));
    for (const auto& ref : HostedGitRestoreDeletions(restored, manifest)) c.Git(temp, {"update-ref", "-d", ref}, nullptr, 60);
    std::string head; for (const auto& tip : manifest) if (tip.second == "refs/heads/" + c.task.defaultBranch) head = tip.second;
    if (head.empty()) for (const auto& tip : manifest) if (tip.second.rfind("refs/heads/", 0) == 0) { head = tip.second; break; }
    if (!head.empty()) c.Git(temp, {"symbolic-ref", "HEAD", head}, nullptr, 60);
    if (HostedGitRunStore(temp, {"fsck", "--connectivity-only"}, nullptr, error, 3600) != 0) return c.Fail("The restored repository is not whole: " + error);
    // The snapshot taken by HostedGitInitBare covers the config as it is now (nothing above changed it).
    if (!HostedGitStoreTrusted(temp)) return c.Fail("The restored store's config changed while restoring");
    if (fs::exists(c.store, ec)) return c.Fail(c.config.hostname + " received a copy of this repository meanwhile");
    fs::rename(temp + ".config", c.store + ".config", ec); if (ec) return c.Fail("Could not place the store's config snapshot");
    fs::rename(temp, c.store, ec); if (ec) { fs::remove(c.store + ".config", ec); return c.Fail("Could not place the restored store"); }
    cleanup.keep = true;
    HostedGitTaskResult result; result.message = head.empty() ? "Restored; the repository has no branches" : "Restored with HEAD at " + head;
    return c.Report(c.store, result);
}
// Discard: the copy moves to the trash (purged after a week), so a mistaken switch-off costs nothing for seven days.
HostedGitTaskResult Discard(const Context& c) {
    std::error_code ec; HostedGitTaskResult result; result.ok = true;
    if (!fs::exists(c.store, ec)) { result.message = "No copy to discard"; return result; }
    const fs::path trash = fs::path(c.config.workspaceRoot) / "git" / "trash"; HostedSecureDirectory(trash.string());
    const auto target = trash / (fs::path(c.store).filename().string() + "-" + std::to_string(NowMillis() / 1000));
    fs::rename(c.store, target, ec); if (ec) return c.Fail("Could not move the copy to the trash");
    fs::remove(c.store + ".config", ec);
    result.message = "Copy moved to the trash"; return result;
}
// Promote: push a recovered ref to the primary through the coordinator with the task's ticket, then drop the kept copy.
HostedGitTaskResult Promote(const Context& c) {
    const std::string remote = Field(c.task.payload, "remote", 512), ticket = Field(c.task.payload, "ticket", 512), sha = Field(c.task.payload, "sha", 64), ref = Field(c.task.payload, "ref", 512), kept = Field(c.task.payload, "recoveredRef", 512);
    if (!HostedSmithRemote(remote) || !std::regex_match(sha, std::regex("[a-f0-9]{40}([a-f0-9]{24})?")) || ref.rfind("refs/", 0) != 0 || kept.rfind("refs/smith/recovered/", 0) != 0) return c.Fail("The promote task is invalid");
    if (!HostedGitStoreTrusted(c.store)) return c.Fail("The copy on " + c.config.hostname + " was altered outside Smith");
    const auto pushed = c.Git(c.store, {"push", "--quiet", "--", remote, sha + ":" + ref}, nullptr, 1800, HostedGitAuthEnv(remote, ticket));
    if (!pushed.empty()) return c.Fail("The push was refused: " + pushed);
    c.Git(c.store, {"update-ref", "-d", kept}, nullptr, 60);
    HostedGitTaskResult result; result.ok = true; result.message = "Pushed " + ref; return result;
}
HostedGitTaskResult DiscardRecovered(const Context& c) {
    const std::string kept = Field(c.task.payload, "recoveredRef", 512);
    if (kept.rfind("refs/smith/recovered/", 0) != 0) return c.Fail("The recovered ref is invalid");
    std::error_code ec; HostedGitTaskResult result; result.ok = true;
    if (fs::is_directory(c.store, ec)) c.Git(c.store, {"update-ref", "-d", kept}, nullptr, 60);
    return result;
}
}
bool HostedParseGitTask(const Json& j, HostedGitTask& out, std::string& problem) {
    static const std::regex id("[A-Za-z0-9-]{1,64}"), token("[A-Za-z0-9._-]{1,300}");
    out.id = Field(j, "id", 64); out.leaseToken = Field(j, "leaseToken", 300); out.kind = Field(j, "kind", 32); out.repoId = Field(j, "repoId", 64); out.repoUuid = Field(j, "repoUuid", 64); out.defaultBranch = Field(j, "defaultBranch", 256);
    out.leaseExpiresAt = j.contains("leaseExpiresAt") && j["leaseExpiresAt"].is_number_integer() ? j["leaseExpiresAt"].get<int64_t>() : 0;
    if (!std::regex_match(out.id, id) || !std::regex_match(out.leaseToken, token) || !HostedGitUuidValid(out.repoUuid)) { problem = "task identity"; return false; }
    static const char* const kinds[] = {"replicate", "backup", "restore", "discard", "promote", "discard-recovered"};
    bool known = false; for (const char* k : kinds) known = known || out.kind == k;
    if (!known) { problem = "task kind"; return false; }
    if (!out.defaultBranch.empty() && (!std::regex_match(out.defaultBranch, std::regex("[A-Za-z0-9][A-Za-z0-9/_.-]*")) || out.defaultBranch.find("..") != std::string::npos)) { problem = "default branch"; return false; }
    out.payload = j.contains("payload") && j["payload"].is_object() ? j["payload"] : Json::object();
    return true;
}
std::string HostedGitTaskCompletionJson(const HostedGitTask& task, const HostedGitTaskResult& result) {
    Json body = {{"taskId", task.id}, {"leaseToken", task.leaseToken}, {"ok", result.ok}, {"message", result.message.substr(0, 1000)}};
    if (!result.tipsJson.empty()) body["tips"] = Json::parse(result.tipsJson);
    if (!result.tipsJson.empty() && !result.peeledJson.empty() && result.peeledJson != "{}") body["peeled"] = Json::parse(result.peeledJson);
    if (result.bytes >= 0) body["bytes"] = result.bytes;
    if (!result.recoveredJson.empty()) body["recovered"] = Json::parse(result.recoveredJson);
    if (result.size >= 0) body["size"] = result.size;
    if (!result.sha256.empty()) body["sha256"] = result.sha256;
    if (!result.kind.empty()) body["kind"] = result.kind;
    return body.dump(-1, ' ', false, Json::error_handler_t::replace);
}
HostedGitTaskResult RunHostedGitTask(const HostedTransport& transport, const HostedGitLoopConfig& config, const HostedGitTask& task, const std::atomic<bool>& stop) {
    Context c{transport, config, task, stop, fs::path(config.workspaceRoot) / "git" / "hooks", fs::path(config.workspaceRoot) / "git" / "relay" / ("task-" + task.id), ""};
    try {
        c.store = HostedGitStorePath(config.workspaceRoot, config.workspaceId, task.repoUuid);
        // HostedSecureDirectory makes one level, so secure the parents too rather than rely on the relay host having made them.
        HostedSecureDirectory((fs::path(config.workspaceRoot) / "git").string()); HostedSecureDirectory(c.work.parent_path().string());
        HostedSecureDirectory(c.work.string());
        struct Cleanup { fs::path path; ~Cleanup() { std::error_code e; fs::remove_all(path, e); } } cleanup{c.work};
        if (task.kind == "replicate") return Replicate(c);
        if (task.kind == "backup") return Backup(c);
        if (task.kind == "restore") return Restore(c);
        if (task.kind == "discard") return Discard(c);
        if (task.kind == "promote") return Promote(c);
        return DiscardRecovered(c);
    } catch (const std::exception& error) { return c.Fail(error.what()); }
}
void HostedGitPurgeTrash(const std::string& workspaceRoot, int64_t olderThanSeconds) {
    std::error_code ec; const fs::path trash = fs::path(workspaceRoot) / "git" / "trash";
    const auto now = NowMillis() / 1000;
    for (const auto& entry : fs::directory_iterator(trash, ec)) {
        const auto name = entry.path().filename().string(); const auto dash = name.rfind('-');
        if (dash == std::string::npos) continue;
        const auto stamp = std::strtoll(name.c_str() + dash + 1, nullptr, 10);
        if (stamp > 0 && now - stamp > olderThanSeconds) fs::remove_all(entry.path(), ec);
    }
}
}
