// HostedUpdate.cpp - see HostedUpdate.h.
#include "HostedUpdate.h"
#include "HostedPlatform.h"
#include <SmithCore/Process.h>
#include <SmithCore/TimeUtil.h>
#include <json/single_include/nlohmann/json.hpp>
#include <zip.h>
#include <cstdlib>
#include <filesystem>
#include <regex>
#include <stdexcept>
#include <vector>
namespace fs = std::filesystem;
namespace Smith {
namespace {
using Json = nlohmann::json;
constexpr const char* kPending = "update-pending.json";
constexpr const char* kRejected = "update-rejected.json";
constexpr const char* kPrevious = ".update-previous";
constexpr unsigned long long kMaxEntryBytes = 256ull * 1024 * 1024;
constexpr size_t kMaxEntries = 256;
bool VersionValid(const std::string& v) { return std::regex_match(v, std::regex("hosted-[a-f0-9]{12}")); }
// The "to" field of a small marker file the agent wrote, or "" when it is missing or unreadable.
std::string MarkerVersion(const std::string& installDir, const char* name) {
    std::error_code ec;
    if (!fs::exists(fs::symlink_status(fs::path(installDir) / name, ec))) return "";
    try {
        const auto marker = Json::parse(HostedReadArtifact(installDir, name, 4096));
        const auto to = marker.value("to", std::string());
        return VersionValid(to) ? to : "";
    } catch (...) { return ""; }
}
bool IsExecutableName(const std::string& name) {
    return name == "Smith" || name == "Smith.exe" || (name.size() > 3 && name.compare(name.size() - 3, 3, ".sh") == 0);
}
}

bool HostedParseUpdateOffer(const std::string& heartbeatReply, HostedUpdateOffer& offer) {
    const auto reply = Json::parse(heartbeatReply, nullptr, false);
    if (!reply.is_object() || !reply.contains("update") || !reply["update"].is_object()) return false;
    const auto& u = reply["update"];
    if (!u.contains("version") || !u["version"].is_string() || !VersionValid(u["version"].get<std::string>())) return false;
    HostedUpdateOffer parsed; parsed.version = u["version"].get<std::string>();
    if (u.contains("sha256")) {
        if (!u["sha256"].is_string() || !std::regex_match(u["sha256"].get<std::string>(), std::regex("[a-f0-9]{64}"))) return false;
        parsed.sha256 = u["sha256"].get<std::string>();
    }
    if (u.contains("size")) {
        if (!u["size"].is_number_integer() || u["size"].get<long long>() < 1 || u["size"].get<long long>() > 512ll * 1024 * 1024) return false;
        parsed.size = u["size"].get<long long>();
    }
    offer = parsed; return true;
}

bool HostedPackageEntryValid(const std::string& name) {
    if (name.empty() || name.size() > 128 || name == "." || name == "..") return false;
    for (char c : name) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_' || c == '+';
        if (!ok) return false;
    }
    return name[0] != '.';
}

std::string HostedPackageVersion(const std::string& directory, const std::string& executableName) {
    const auto info = Json::parse(HostedReadArtifact(directory, "release-info.json", 16384));
    const auto commit = info.at("commit").get<std::string>(), sha256 = info.at("sha256").get<std::string>();
    if (info.value("schemaVersion", 0) != 1 || info.value("protocolVersion", 0) != 2 ||
        !std::regex_match(commit, std::regex("[a-f0-9]{40}|[a-f0-9]{64}")) ||
        !std::regex_match(sha256, std::regex("[a-f0-9]{64}"))) throw std::runtime_error("Invalid release identity metadata");
    const auto bytes = HostedReadArtifact(directory, executableName, 64 * 1024 * 1024);
    if (HostedSha256(bytes) != sha256) throw std::runtime_error("Release identity hash does not match the running binary");
    return "hosted-" + commit.substr(0, 12);
}

bool HostedSelfUpdateEnabled(std::string& reason) {
    const char* off = std::getenv("SMITH_AGENT_AUTO_UPDATE");
    if (off && std::string(off) == "0") { reason = "SMITH_AGENT_AUTO_UPDATE=0"; return false; }
    const char* supervised = std::getenv("SMITH_UPDATE_SUPERVISED");
    if (!supervised || std::string(supervised) != "1") { reason = "not started by Start-Smith.bat / start-smith.sh"; return false; }
    std::error_code ec;
    const auto dir = fs::path(HostedExecutablePath()).parent_path();
    if (!fs::exists(dir / "release-info.json", ec)) { reason = "not running from a Smith agent package"; return false; }
    return true;
}

std::string HostedRejectedVersion(const std::string& installDir) { return MarkerVersion(installDir, kRejected); }
std::string HostedPendingUpdate(const std::string& installDir) { return MarkerVersion(installDir, kPending); }

void HostedConfirmUpdate(const std::string& installDir) {
    std::error_code ec;
    fs::remove(fs::path(installDir) / kPending, ec);
    fs::remove_all(fs::path(installDir) / kPrevious, ec);
}

std::string HostedStagePackage(const std::string& zipPath, const std::string& stagingDir,
                               const std::string& executableName, const std::string& version) {
    std::error_code ec;
    fs::remove_all(stagingDir, ec);
    fs::create_directories(stagingDir, ec);
    if (ec) return "cannot create " + stagingDir + ": " + ec.message();
    struct zip_t* zip = zip_open(zipPath.c_str(), 0, 'r');
    if (!zip) return "the package is not a readable zip";
    std::string problem;
    const ssize_t total = zip_entries_total(zip);
    if (total <= 0 || (size_t)total > kMaxEntries) problem = "the package has no files or too many";
    for (ssize_t i = 0; problem.empty() && i < total; ++i) {
        if (zip_entry_openbyindex(zip, (size_t)i) != 0) { problem = "cannot read package entry " + std::to_string(i); break; }
        const std::string name = zip_entry_name(zip) ? zip_entry_name(zip) : "";
        if (zip_entry_isdir(zip) || !HostedPackageEntryValid(name)) problem = "unexpected package entry \"" + name + "\" (packages hold plain files only)";
        else if (zip_entry_size(zip) > kMaxEntryBytes) problem = "package entry " + name + " is too large";
        else if (fs::exists(fs::path(stagingDir) / name, ec)) problem = "package entry " + name + " appears twice";
        else if (zip_entry_fread(zip, (fs::path(stagingDir) / name).string().c_str()) != 0) problem = "cannot unpack " + name;
        zip_entry_close(zip);
        if (problem.empty()) {
            fs::permissions(fs::path(stagingDir) / name, IsExecutableName(name) ? fs::perms(0755) : fs::perms(0644), fs::perm_options::replace, ec);
        }
    }
    zip_close(zip);
    if (!problem.empty()) return problem;
    try {
        const auto staged = HostedPackageVersion(stagingDir, executableName);
        if (staged != version) return "the package is " + staged + ", not the advertised " + version;
    } catch (const std::exception& error) { return std::string("the package's release identity is invalid: ") + error.what(); }
    // The staged agent must at least start (its libraries are next to it in the staging folder).
    ProcessOptions options; options.argv = {(fs::path(stagingDir) / executableName).string(), "version"};
    options.workingDir = stagingDir; options.timeoutSeconds = 60;
    Process process;
    const int rc = process.Run(options, [](bool, const std::string&) {});
    if (rc != 0) return "the new agent did not start (\"Smith version\" exited with " + std::to_string(rc) + ")";
    return "";
}

void HostedApplyStagedPackage(const std::string& installDir, const std::string& stagingDir,
                              const std::string& fromVersion, const std::string& toVersion) {
    const fs::path install(installDir), staging(stagingDir), previous = install / kPrevious;
    std::error_code ec;
    fs::remove_all(previous, ec);
    fs::create_directories(previous);
    std::vector<std::string> names;
    for (const auto& entry : fs::directory_iterator(staging)) names.push_back(entry.path().filename().string());
    // Each step is recorded so a failure part-way can be undone in reverse.
    struct Step { std::string name; bool hadOld; bool placedNew; };
    std::vector<Step> done;
    try {
        for (const auto& name : names) {
            Step step{name, false, false};
            if (fs::exists(fs::symlink_status(install / name))) {
                // Renaming works on the running executable and loaded libraries too.
                fs::rename(install / name, previous / name); step.hadOld = true;
            }
            done.push_back(step);
            fs::rename(staging / name, install / name); done.back().placedNew = true;
        }
        Json marker = {{"from", fromVersion}, {"to", toVersion}, {"at", NowIso()}};
        HostedSecureWrite((install / kPending).string(), marker.dump());
    } catch (...) {
        for (auto it = done.rbegin(); it != done.rend(); ++it) {
            if (it->placedNew) fs::rename(install / it->name, staging / it->name, ec);
            if (it->hadOld) fs::rename(previous / it->name, install / it->name, ec);
        }
        fs::remove(install / kPending, ec);
        throw;
    }
    fs::remove_all(staging, ec);
}
}
