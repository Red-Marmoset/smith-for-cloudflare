// HostedLfsTasks.cpp - see HostedLfsTasks.h.
#include "HostedLfsTasks.h"
#include "HostedPlatform.h"
#include "HostedTransport.h"
#include <SmithCore/Housekeeping.h>
#include <filesystem>
#include <map>
#include <regex>
namespace fs = std::filesystem;
namespace Smith {
namespace {
using Json = nlohmann::json;
std::string Field(const Json& j, const char* key, size_t max) { if (!j.contains(key) || !j[key].is_string()) return ""; const auto s = j[key].get<std::string>(); return s.size() <= max ? s : ""; }
constexpr int64_t kMaxObject = 5LL * 1024 * 1024 * 1024;
}
bool HostedParseLfsTask(const Json& j, HostedLfsTask& out, std::string& problem) {
    static const std::regex id("[A-Za-z0-9-]{1,64}"), token("[A-Za-z0-9._-]{1,300}"), repo("[a-z0-9][a-z0-9-]{0,63}"), oid("[a-f0-9]{64}");
    out.id = Field(j, "id", 64); out.leaseToken = Field(j, "leaseToken", 300); out.kind = Field(j, "kind", 16); out.repoId = Field(j, "repoId", 64); out.oid = Field(j, "oid", 64);
    if (!std::regex_match(out.id, id) || !std::regex_match(out.leaseToken, token)) { problem = "task identity"; return false; }
    if (out.kind != "fetch" && out.kind != "restore" && out.kind != "drop") { problem = "task kind"; return false; }
    if (!std::regex_match(out.repoId, repo)) { problem = "repository id"; return false; }
    if (!std::regex_match(out.oid, oid)) { problem = "object id"; return false; }
    if (!j.contains("size") || !j["size"].is_number_integer() || j["size"].get<int64_t>() < 0 || j["size"].get<int64_t>() > kMaxObject) { problem = "object size"; return false; }
    out.size = j["size"].get<int64_t>();
    out.leaseExpiresAt = j.contains("leaseExpiresAt") && j["leaseExpiresAt"].is_number_integer() ? j["leaseExpiresAt"].get<int64_t>() : 0;
    return true;
}
std::string HostedLfsObjectPath(const std::string& workspaceRoot, const std::string& workspaceId, const std::string& oid) {
    return (fs::path(workspaceRoot) / "lfs" / workspaceId / oid.substr(0, 2) / oid.substr(2, 2) / oid).string();
}
std::string HostedLfsCompletionJson(const HostedLfsTask& task, const HostedLfsTaskResult& result) {
    Json j = {{"taskId", task.id}, {"leaseToken", task.leaseToken}, {"ok", result.ok}, {"message", result.message.substr(0, 300)}};
    if (result.size >= 0) j["size"] = result.size;
    if (result.copyGone) j["held"] = false;
    return j.dump();
}
HostedLfsTaskResult RunHostedLfsTask(const HostedTransport& transport, const HostedGitLoopConfig& config, const HostedLfsTask& task, const std::atomic<bool>& stop) {
    HostedLfsTaskResult result; std::error_code ec;
    const fs::path object = HostedLfsObjectPath(config.workspaceRoot, config.workspaceId, task.oid);
    const std::map<std::string, std::string> lease = {{"X-Smith-Lease-Token", task.leaseToken}};
    const auto intact = [&]() { return fs::is_regular_file(object, ec) && (int64_t)fs::file_size(object, ec) == task.size && HostedSha256File(object.string()) == task.oid; };
    if (task.kind == "drop") { fs::remove(object, ec); result.ok = !fs::exists(object, ec); if (!result.ok) result.message = "Could not delete the copy"; return result; }
    if (task.kind == "fetch") {
        if (intact()) { result.ok = true; result.size = task.size; return result; }
        if ((int64_t)FreeDiskBytes(config.workspaceRoot) < task.size + 1024LL * 1024 * 1024) { result.message = "Not enough free disk on " + config.hostname; return result; }
        fs::create_directories(object.parent_path(), ec);
        const fs::path temp = object.string() + ".part-" + task.id;
        const int status = stop ? 0 : transport.Download("/lfs/task/" + task.id + "/body", temp, task.size + 1024, 3600, lease);
        if (status != 200 || !fs::is_regular_file(temp, ec) || (int64_t)fs::file_size(temp, ec) != task.size) { fs::remove(temp, ec); result.message = "Download failed (HTTP " + std::to_string(status) + ")"; return result; }
        if (HostedSha256File(temp.string()) != task.oid) { fs::remove(temp, ec); result.message = "Downloaded data does not match the object id"; return result; }
        fs::rename(temp, object, ec); if (ec) { fs::remove(temp, ec); result.message = "Could not place the copy"; return result; }
        result.ok = true; result.size = task.size; return result;
    }
    // restore: the copy goes back, straight to R2 when the coordinator hands out a presigned URL, else through it.
    if (!fs::is_regular_file(object, ec) || (int64_t)fs::file_size(object, ec) != task.size) { result.message = config.hostname + " holds no copy of this object"; result.copyGone = true; return result; }
    if (!intact()) { fs::remove(object, ec); result.message = "The copy on " + config.hostname + " is corrupt and was deleted"; result.copyGone = true; return result; }
    const auto target = transport.PostBytes("/lfs/task/" + task.id + "/target", "{}", "application/json", lease, 30, 1024 * 1024);
    if (!target.Ok()) { result.message = "The coordinator refused the restore (HTTP " + std::to_string(target.status) + ")"; return result; }
    const std::string href = target.body.value("href", "");
    if (!href.empty() && href.rfind("https://", 0) != 0) { result.message = "The coordinator named an invalid upload target"; return result; }
    const int status = href.empty()
        ? transport.PutFile("/lfs/task/" + task.id + "/object", object, {{"X-Smith-Lease-Token", task.leaseToken}, {"Content-Type", "application/octet-stream"}}, 7200)
        : transport.PutFile(href, object, {{"Content-Type", "application/octet-stream"}}, 7200);
    if (status < 200 || status >= 300) { result.message = "Upload failed (HTTP " + std::to_string(status) + ")"; return result; }
    result.ok = true; result.size = task.size; return result;
}
}
