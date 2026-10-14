// HostedGitRelay.cpp - see HostedGitRelay.h.
#include "HostedGitRelay.h"
#include "HostedGitHost.h"
#include "HostedGitTasks.h"
#include "HostedLfsTasks.h"
#include "HostedCrewRun.h"
#include "HostedPlatform.h"
#include "HostedTransport.h"
#include <SmithCore/Housekeeping.h>
#include <SmithCore/Process.h>
#include <SmithCore/TimeUtil.h>
#include <json/single_include/nlohmann/json.hpp>
#include <chrono>
#include <cstdio>
#include <deque>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <regex>
#include <set>
#include <thread>
namespace fs = std::filesystem;
namespace Smith {
namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
constexpr int64_t kMaxBody = 100LL * 1024 * 1024 + 1024;
struct Relay { std::string id, leaseToken, repoUuid, service, op, gitProtocol, userLabel; bool writer = false, hasBody = false; int64_t bodySize = 0; HostedRefPolicy policy; };
std::string Field(const Json& j, const char* key, size_t max) { if (!j.contains(key) || !j[key].is_string()) return ""; const auto s = j[key].get<std::string>(); return s.size() <= max ? s : ""; }
bool ParseRelay(const Json& j, Relay& relay, std::string& problem) {
    static const std::regex id("[A-Za-z0-9-]{1,64}"), token("[A-Za-z0-9._-]{1,300}");
    relay.id = Field(j, "id", 64); relay.leaseToken = Field(j, "leaseToken", 300); relay.repoUuid = Field(j, "repoUuid", 64);
    relay.service = Field(j, "service", 16); relay.op = Field(j, "op", 16); relay.gitProtocol = Field(j, "gitProtocol", 64); relay.userLabel = Field(j, "userLabel", 64);
    if (!std::regex_match(relay.id, id) || !std::regex_match(relay.leaseToken, token) || !HostedGitUuidValid(relay.repoUuid)) { problem = "relay identity"; return false; }
    if ((relay.service != "upload-pack" && relay.service != "receive-pack") || (relay.op != "info-refs" && relay.op != "rpc")) { problem = "relay service"; return false; }
    if (!j.value("writer", Json()).is_boolean() || !j.value("hasBody", Json()).is_boolean()) { problem = "relay flags"; return false; }
    relay.writer = j["writer"].get<bool>(); relay.hasBody = j["hasBody"].get<bool>();
    relay.bodySize = j.contains("bodySize") && j["bodySize"].is_number_integer() ? j["bodySize"].get<int64_t>() : 0;
    if (relay.bodySize < 0 || relay.bodySize > kMaxBody) { problem = "relay body size"; return false; }
    if (relay.writer != (relay.service == "receive-pack" && relay.op == "rpc")) { problem = "relay writer flag"; return false; }
    relay.policy = HostedParseRefPolicy(j.contains("refPolicy") ? j["refPolicy"].dump() : "{}");
    return true;
}
std::string ReadHead(const fs::path& file, size_t maximum) { std::ifstream in(file, std::ios::binary); std::string text(maximum, '\0'); in.read(text.data(), (std::streamsize)text.size()); text.resize((size_t)in.gcount()); return text; }
class Host {
public:
    Host(const HostedTransport& transport, const HostedGitLoopConfig& config, const std::atomic<bool>& stop, std::atomic<int>* busy)
        : m_transport(transport), m_config(config), m_stop(stop), m_busy(busy), m_relayRoot(fs::path(config.workspaceRoot) / "git" / "relay") {
        HostedSecureDirectory((fs::path(config.workspaceRoot) / "git").string()); HostedSecureDirectory(m_relayRoot.string());
        m_emptyConfig = HostedGitEmptyConfig((fs::path(config.workspaceRoot) / "git").string());
    }
    // One poll: renews what this machine holds and takes any relay the coordinator hands it. Returns the HTTP status.
    int Poll() {
        const auto response = m_transport.Post("/git/poll", Json::object());
        if (!response.Ok()) return response.status;
        if (response.body.contains("relay") && response.body["relay"].is_object()) {
            Relay relay; std::string problem;
            if (ParseRelay(response.body["relay"], relay, problem)) m_pending.push_back(relay);
            else Say("Ignoring a relayed request with an invalid " + problem);
        }
        if (response.body.contains("held") && response.body["held"].is_array()) ReportHeld(response.body["held"]);
        if (response.body.contains("task") && response.body["task"].is_object() && !m_taskRunning) {
            HostedGitTask task; std::string problem;
            if (!HostedParseGitTask(response.body["task"], task, problem)) Say("Ignoring a task with an invalid " + problem);
            else StartTask(task);
        }
        // Large files this machine keeps (spec §8): copies to fetch, lost objects to send back, copies to drop.
        if (response.body.contains("lfs") && response.body["lfs"].is_array()) {
            for (const auto& entry : response.body["lfs"]) {
                HostedLfsTask task; std::string problem;
                if (!HostedParseLfsTask(entry, task, problem)) { Say("Ignoring a large-file task with an invalid " + problem); continue; }
                QueueLfs(task);
            }
        }
        return response.status;
    }
    ~Host() { if (m_taskThread.joinable()) m_taskThread.join(); if (m_lfsThread.joinable()) m_lfsThread.join(); }
    bool TaskRunning() const { return m_taskRunning || m_lfsRunning; }
    // Week-old discarded copies go; checked every ten minutes.
    void Housekeeping() {
        const auto now = Clock::now();
        if (now - m_lastPurge < std::chrono::minutes(10)) return;
        m_lastPurge = now; HostedGitPurgeTrash(m_config.workspaceRoot, 7 * 86400);
    }
    bool HasWork() const { return !m_pending.empty(); }
    void ServeNext() {
        if (m_pending.empty()) return;
        Relay relay = m_pending.front(); m_pending.pop_front();
        struct Busy { std::atomic<int>* counter; explicit Busy(std::atomic<int>* c) : counter(c) { if (counter) ++*counter; } ~Busy() { if (counter) --*counter; } } busy(m_busy);
        try { Serve(relay); } catch (const std::exception& error) { Say(std::string("Relay failed: ") + error.what()); }
    }
    // Pushes whose completion never reached the coordinator: report their tips now (git/tips), then forget them.
    void ReplayJournal() {
        std::error_code ec;
        for (const auto& entry : fs::directory_iterator(m_relayRoot, ec)) {
            const auto journal = entry.path() / "tips.json";
            if (!fs::is_regular_file(fs::symlink_status(journal, ec))) { if (fs::last_write_time(entry.path(), ec) + std::chrono::hours(24) < fs::file_time_type::clock::now()) fs::remove_all(entry.path(), ec); continue; }
            Json report = Json::parse(ReadHead(journal, 2 * 1024 * 1024), nullptr, false);
            if (!report.is_object()) { fs::remove_all(entry.path(), ec); continue; }
            const auto response = m_transport.Post("/git/tips", report);
            if (response.status == 0 || response.status >= 500 || response.status == 401 || response.status == 403) return;   // try again later
            Say(response.Ok() ? "Reported the refs of a push whose completion was lost" : "The coordinator refused a journaled push report (HTTP " + std::to_string(response.status) + "); dropping it");
            fs::remove_all(entry.path(), ec);
        }
    }
private:
    const HostedTransport& m_transport; HostedGitLoopConfig m_config; const std::atomic<bool>& m_stop; std::atomic<int>* m_busy; fs::path m_relayRoot;
    std::deque<Relay> m_pending; std::string m_emptyConfig;
    std::thread m_taskThread; std::atomic<bool> m_taskRunning{false}; Clock::time_point m_lastPurge{};
    std::thread m_lfsThread; std::atomic<bool> m_lfsRunning{false}; std::mutex m_lfsMutex; std::deque<HostedLfsTask> m_lfsQueue; std::set<std::string> m_lfsSeen;
    std::map<std::string, Clock::time_point> m_reported;
    // Copies the record calls lost or stale (a machine switched off and on again, a report that never arrived): tell the
    // coordinator what this machine still holds, at most every ten minutes per repository.
    void ReportHeld(const Json& held) {
        for (const auto& item : held) {
            if (!item.is_object()) continue;
            const std::string uuid = Field(item, "uuid", 64), state = Field(item, "state", 16);
            if (!HostedGitUuidValid(uuid) || (state != "lost" && state != "stale")) continue;
            const auto last = m_reported.find(uuid);
            if (last != m_reported.end() && Clock::now() - last->second < std::chrono::minutes(10)) continue;
            m_reported[uuid] = Clock::now();
            std::error_code ec; const auto store = HostedGitStorePath(m_config.workspaceRoot, m_config.workspaceId, uuid);
            if (!fs::is_directory(store, ec) || !HostedGitStoreTrusted(store)) continue;
            std::string error; int64_t bytes = 0; std::map<std::string, std::string> peeled;
            const auto tips = HostedGitStoreTips(store, bytes, error, &peeled);
            if (!error.empty()) continue;
            const auto response = m_transport.Post("/git/tips", Json({{"repoUuid", uuid}, {"tips", Json::parse(HostedGitTipsJson(tips))}, {"peeled", Json::parse(HostedGitPeeledJson(peeled))}, {"bytes", bytes}}));
            if (response.Ok()) Say("Reported the refs this machine holds for a copy the coordinator had given up on");
        }
    }
    // Tasks (copies, bundles, restores) run beside relays, one at a time, so a busy copy keeps serving while it syncs.
    void StartTask(const HostedGitTask& task) {
        if (m_taskThread.joinable()) m_taskThread.join();
        m_taskRunning = true;
        m_taskThread = std::thread([this, task]() {
            struct Busy { std::atomic<int>* counter; explicit Busy(std::atomic<int>* c) : counter(c) { if (counter) ++*counter; } ~Busy() { if (counter) --*counter; } } busy(m_busy);
            Say("Starting " + task.kind + " of repository " + task.repoId);
            HostedGitTaskResult result;
            try { result = RunHostedGitTask(m_transport, m_config, task, m_stop); } catch (const std::exception& error) { result.ok = false; result.message = error.what(); }
            const auto body = Json::parse(HostedGitTaskCompletionJson(task, result));
            bool recorded = false;
            for (int attempt = 0; attempt < 3 && !m_stop; ++attempt) {
                const auto response = m_transport.Post("/git/task/" + task.id + "/complete", body);
                if (response.Ok()) { recorded = true; break; }
                if (response.status >= 400 && response.status < 500) { Say("The coordinator refused the " + task.kind + " report (HTTP " + std::to_string(response.status) + ")"); break; }
                std::this_thread::sleep_for(std::chrono::seconds(2));
            }
            Say((result.ok ? "Finished " : "Failed ") + task.kind + " of repository " + task.repoId + (result.message.empty() ? "" : ": " + result.message) + (recorded ? "" : " (not recorded)"));
            m_taskRunning = false;
        });
    }
    // Large-file tasks (copies, restores, drops) run one after another on their own thread, beside git tasks and relays.
    void QueueLfs(const HostedLfsTask& task) {
        std::lock_guard<std::mutex> lock(m_lfsMutex);
        if (!m_lfsSeen.insert(task.id).second) return;
        m_lfsQueue.push_back(task);
        if (m_lfsRunning) return;
        if (m_lfsThread.joinable()) m_lfsThread.join();
        m_lfsRunning = true;
        m_lfsThread = std::thread([this]() {
            struct Busy { std::atomic<int>* counter; explicit Busy(std::atomic<int>* c) : counter(c) { if (counter) ++*counter; } ~Busy() { if (counter) --*counter; } } busy(m_busy);
            for (;;) {
                HostedLfsTask next;
                { std::lock_guard<std::mutex> lock(m_lfsMutex); if (m_lfsQueue.empty() || m_stop) { m_lfsRunning = false; return; } next = m_lfsQueue.front(); m_lfsQueue.pop_front(); }
                HostedLfsTaskResult result;
                try { result = RunHostedLfsTask(m_transport, m_config, next, m_stop); } catch (const std::exception& error) { result.ok = false; result.message = error.what(); }
                const auto body = Json::parse(HostedLfsCompletionJson(next, result));
                bool recorded = false;
                for (int attempt = 0; attempt < 3 && !m_stop; ++attempt) {
                    const auto response = m_transport.Post("/lfs/task/" + next.id + "/complete", body);
                    if (response.Ok()) { recorded = true; break; }
                    if (response.status >= 400 && response.status < 500) break;
                    std::this_thread::sleep_for(std::chrono::seconds(2));
                }
                if (!result.ok || !recorded) Say((result.ok ? "Finished " : "Failed ") + next.kind + " of large file " + next.oid.substr(0, 12) + (result.message.empty() ? "" : ": " + result.message) + (recorded ? "" : " (not recorded)"));
                { std::lock_guard<std::mutex> lock(m_lfsMutex); m_lfsSeen.erase(next.id); }
            }
        });
    }
    void Say(const std::string& text) const { std::printf("Git host: %s\n", HostedRedact(text, {m_transport.token}).c_str()); std::fflush(stdout); }
    std::map<std::string, std::string> LeaseHeader(const Relay& relay) const { return {{"X-Smith-Lease-Token", relay.leaseToken}}; }
    // Records the outcome; a push that landed carries the store's refs so the coordinator's record moves even if the client left.
    bool Complete(const Relay& relay, int status, int64_t size, const std::string& message, const std::string& tipsJson, int64_t bytes, const std::string& peeledJson = "") {
        const auto body = Json::parse(HostedGitCompletionJson(relay.id, relay.leaseToken, status, size, message, tipsJson, bytes, peeledJson));
        for (int attempt = 0; attempt < 3 && !m_stop; ++attempt) {
            const auto response = m_transport.Post("/git/relay/" + relay.id + "/complete", body);
            if (response.Ok()) return true;
            if (response.status >= 400 && response.status < 500) { Say("The coordinator refused the completion of a relayed request (HTTP " + std::to_string(response.status) + ")"); return false; }
            std::this_thread::sleep_for(std::chrono::seconds(2));
        }
        return false;
    }
    // Uploads prefix + file in 5 MiB parts; false when a part could not be stored.
    bool UploadResponse(const Relay& relay, const std::string& prefix, const fs::path& file, int64_t fileSize) {
        std::ifstream in(file, std::ios::binary);
        std::string buffer = prefix; int part = 0; int64_t remaining = fileSize;
        while (true) {
            while ((int64_t)buffer.size() < kHostedGitPartBytes && remaining > 0) {
                const auto want = (size_t)std::min<int64_t>(kHostedGitPartBytes - (int64_t)buffer.size(), remaining);
                std::string chunk(want, '\0'); in.read(chunk.data(), (std::streamsize)want); chunk.resize((size_t)in.gcount());
                if (chunk.empty()) return false;
                remaining -= (int64_t)chunk.size(); buffer += chunk;
            }
            if (buffer.empty()) return true;
            ++part; bool stored = false;
            for (int attempt = 0; attempt < 3 && !m_stop; ++attempt) {
                const auto response = m_transport.PostBytes("/git/relay/" + relay.id + "/response?part=" + std::to_string(part), buffer, "application/octet-stream", LeaseHeader(relay), 180, (size_t)kHostedGitPartBytes + 1024);
                if (response.Ok() && response.body.value("accepted", false) && response.body.value("size", (int64_t)-1) == (int64_t)buffer.size()) { stored = true; break; }
                if (response.status >= 400 && response.status < 500) break;
                std::this_thread::sleep_for(std::chrono::seconds(2));
            }
            if (!stored) return false;
            buffer.clear();
            if (remaining == 0) return true;
        }
    }
    void Serve(const Relay& relay) {
        const auto started = Clock::now();
        const auto store = HostedGitStorePath(m_config.workspaceRoot, m_config.workspaceId, relay.repoUuid);
        std::error_code ec;
        if (!fs::is_directory(store, ec)) { Complete(relay, 500, 0, "The machine chosen for this request no longer holds the repository", "", -1); return; }
        if (!HostedGitStoreTrusted(store)) { Complete(relay, 500, 0, "The repository copy on " + m_config.hostname + " was altered outside Smith and is not served", "", -1); Say("Refusing to serve " + relay.repoUuid + ": its config changed since Smith created it"); return; }
        const fs::path dir = m_relayRoot / relay.id; HostedSecureDirectory(dir.string());
        struct Cleanup { fs::path path; bool keep = false; ~Cleanup() { std::error_code e; if (keep) { fs::remove(path / "req", e); fs::remove(path / "res", e); } else fs::remove_all(path, e); } } cleanup{dir};
        const fs::path request = dir / "req", response = dir / "res";
        if (relay.hasBody) {
            if (relay.writer && !HostedGitDiskSufficient((int64_t)FreeDiskBytes(m_config.workspaceRoot), relay.bodySize)) { Complete(relay, 507, 0, "Not enough free disk on " + m_config.hostname + " to take this push", "", -1); return; }
            const int status = m_transport.Download("/git/relay/" + relay.id + "/body", request, relay.bodySize + 1024, 600, LeaseHeader(relay));
            if (status != 200 || !fs::is_regular_file(request, ec) || (int64_t)fs::file_size(request, ec) != relay.bodySize) { Complete(relay, 502, 0, "The request body could not be fetched by " + m_config.hostname, "", -1); return; }
            if (relay.writer) { const auto refusal = HostedGitRefuseReceive(ReadHead(request, 64 * 1024)); if (!refusal.empty()) { Complete(relay, 400, 0, "Smith: " + refusal, "", -1); return; } }
        }
        ProcessOptions options;
        options.argv = HostedGitServeArgv(relay.service, relay.op, store);
        options.envUnset = HostedGitServeEnvUnset(); options.envOverride = HostedGitServeEnv(relay.gitProtocol, relay.policy, m_emptyConfig);
        options.workingDir = store; options.stdinFile = relay.hasBody ? request.string() : ""; options.stdoutFile = response.string();
        options.timeoutSeconds = relay.writer ? 1800 : 900; options.stopWithParent = true;
        std::string stderrTail; Process process;
        if (!process.Start(options, [&](bool, const std::string& line) { stderrTail = line.substr(0, 300); })) { Complete(relay, 500, 0, "git could not be started on " + m_config.hostname, "", -1); return; }
        // Keep the lease (and take queued requests) while a long clone or push runs.
        auto nextPoll = Clock::now() + std::chrono::seconds(20);
        while (process.Running()) { if (m_stop) { process.Kill(); break; } if (Clock::now() >= nextPoll) { Poll(); nextPoll = Clock::now() + std::chrono::seconds(20); } std::this_thread::sleep_for(std::chrono::milliseconds(50)); }
        const int rc = process.Wait();
        if (rc != 0) { Complete(relay, 500, 0, "git " + relay.service + " failed on " + m_config.hostname + (stderrTail.empty() ? "" : ": " + stderrTail), "", -1); Say("git " + relay.service + " exited with " + std::to_string(rc) + (stderrTail.empty() ? "" : ": " + stderrTail)); return; }
        std::string tipsJson, peeledJson; int64_t bytes = -1;
        if (relay.writer) {
            std::string error; int64_t counted = 0; std::map<std::string, std::string> peeled;
            const auto tips = HostedGitStoreTips(store, counted, error, &peeled);
            if (error.empty()) { tipsJson = HostedGitTipsJson(tips); peeledJson = HostedGitPeeledJson(peeled); bytes = counted; HostedSecureWrite((dir / "tips.json").string(), Json({{"repoUuid", relay.repoUuid}, {"tips", Json::parse(tipsJson)}, {"peeled", Json::parse(peeledJson)}, {"bytes", bytes}}).dump()); cleanup.keep = true; }
            else Say("Could not read the refs after a push: " + error);
        }
        const std::string prefix = relay.op == "info-refs" ? HostedGitInfoRefsPreamble(relay.service) : "";
        const int64_t fileSize = fs::is_regular_file(response, ec) ? (int64_t)fs::file_size(response, ec) : 0;
        if (!UploadResponse(relay, prefix, response, fileSize)) { Say("Could not upload the response of a relayed " + relay.service + "; the coordinator will time it out"); return; }
        const bool accepted = Complete(relay, 200, (int64_t)prefix.size() + fileSize, "", tipsJson, bytes, peeledJson);
        if (accepted) { cleanup.keep = false; }
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - started).count();
        Say("Served " + relay.service + " " + relay.op + " for " + (relay.userLabel.empty() ? "a client" : relay.userLabel) + " (" + std::to_string((int64_t)prefix.size() + fileSize) + " bytes, " + std::to_string(ms) + " ms)" + (accepted ? "" : "; completion not recorded"));
    }
};
}
bool HostedGitDiskSufficient(int64_t freeBytes, int64_t bodyBytes) { return bodyBytes >= 0 && freeBytes >= 3 * bodyBytes + 1024LL * 1024 * 1024; }
std::string HostedGitCompletionJson(const std::string& relayId, const std::string& leaseToken, int status, int64_t size, const std::string& message, const std::string& tipsJson, int64_t bytes, const std::string& peeledJson) {
    Json body = {{"relayId", relayId}, {"leaseToken", leaseToken}, {"status", status}, {"size", size}, {"message", message.substr(0, 1000)}};
    if (!tipsJson.empty()) body["tips"] = Json::parse(tipsJson);
    if (!tipsJson.empty() && !peeledJson.empty() && peeledJson != "{}") body["peeled"] = Json::parse(peeledJson);
    if (bytes >= 0) body["bytes"] = bytes;
    return body.dump(-1, ' ', false, Json::error_handler_t::replace);
}
int HostedGitPollDelayMs(int64_t nowMs, int64_t lastRelayMs, bool unsupported) {
    if (unsupported) return 600000;
    return lastRelayMs > 0 && nowMs - lastRelayMs < 60000 ? 500 : 3000;
}
void RunHostedGitLoop(const HostedTransport& transport, const HostedGitLoopConfig& config, const std::atomic<bool>& stop, const std::atomic<bool>& wanted, std::atomic<int>* busy) {
    Host host(transport, config, stop, busy);
    auto millis = []() { return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch()).count(); };
    int64_t lastRelay = 0, nextPoll = 0; bool unsupported = false, announced = false;
    while (!stop) {
        // Polls stop when the coordinator no longer wants them, except while a task still runs (its lease lives on polls).
        if ((!wanted && !host.TaskRunning()) || millis() < nextPoll) { std::this_thread::sleep_for(std::chrono::milliseconds(100)); continue; }
        if (!announced) { std::printf("Git host: this machine keeps copies of repositories; serving requests relayed by the coordinator.\n"); std::fflush(stdout); announced = true; }
        host.ReplayJournal(); host.Housekeeping();
        const int status = host.Poll();
        if (status == 404 && !unsupported) { std::printf("Git host: the coordinator does not relay git requests yet; checking again every 10 minutes.\n"); std::fflush(stdout); }
        unsupported = status == 404;
        while (host.HasWork() && !stop) { host.ServeNext(); lastRelay = millis(); }
        // A running task keeps the lease alive through polls, so it never waits out the idle interval.
        nextPoll = millis() + (host.TaskRunning() ? 10000 : HostedGitPollDelayMs(millis(), lastRelay, unsupported));
    }
}
}
