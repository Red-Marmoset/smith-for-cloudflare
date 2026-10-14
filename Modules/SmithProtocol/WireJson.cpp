// WireJson.cpp - nlohmann-backed (de)serialization for the wire types.
// The only translation unit that includes nlohmann/json.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "WireJson.h"

#include <json/single_include/nlohmann/json.hpp>

using nlohmann::json;

namespace Smith
{
    // --- to_json / from_json (found by ADL). Parsing is lenient via j.value(). ---

    static void to_json(json& j, const NodeInfo& v)
    {
        j = json{{"nodeId", v.nodeId}, {"hostname", v.hostname}, {"os", v.os},
                 {"arch", v.arch}, {"labels", v.labels}, {"agentVersion", v.agentVersion},
                 {"gpuTotalMb", v.gpuTotalMb}, {"gpuFreeMb", v.gpuFreeMb}, {"ollamaUp", v.ollamaUp}};
    }
    static void from_json(const json& j, NodeInfo& v)
    {
        v.nodeId = j.value("nodeId", std::string());
        v.hostname = j.value("hostname", std::string());
        v.os = j.value("os", std::string());
        v.arch = j.value("arch", std::string());
        v.labels = j.value("labels", std::vector<std::string>());
        v.agentVersion = j.value("agentVersion", std::string());
        v.gpuTotalMb = j.value("gpuTotalMb", 0);
        v.gpuFreeMb = j.value("gpuFreeMb", 0);
        v.ollamaUp = j.value("ollamaUp", false);
    }

    static void to_json(json& j, const RegisterRequest& v)
    {
        j = json{{"hostname", v.hostname}, {"os", v.os}, {"arch", v.arch},
                 {"labels", v.labels}, {"agentVersion", v.agentVersion},
                 {"protocolVersion", v.protocolVersion},
                 {"gpuTotalMb", v.gpuTotalMb}, {"gpuFreeMb", v.gpuFreeMb}, {"ollamaUp", v.ollamaUp}};
    }
    static void from_json(const json& j, RegisterRequest& v)
    {
        v.hostname = j.value("hostname", std::string());
        v.os = j.value("os", std::string());
        v.arch = j.value("arch", std::string());
        v.labels = j.value("labels", std::vector<std::string>());
        v.agentVersion = j.value("agentVersion", std::string());
        v.protocolVersion = j.value("protocolVersion", 0);
        v.gpuTotalMb = j.value("gpuTotalMb", 0);
        v.gpuFreeMb = j.value("gpuFreeMb", 0);
        v.ollamaUp = j.value("ollamaUp", false);
    }

    static void to_json(json& j, const RegisterResponse& v)
    {
        j = json{{"accepted", v.accepted}, {"nodeId", v.nodeId},
                 {"heartbeatIntervalSec", v.heartbeatIntervalSec},
                 {"protocolVersion", v.protocolVersion}, {"message", v.message}};
    }
    static void from_json(const json& j, RegisterResponse& v)
    {
        v.accepted = j.value("accepted", false);
        v.nodeId = j.value("nodeId", std::string());
        v.heartbeatIntervalSec = j.value("heartbeatIntervalSec", 10);
        v.protocolVersion = j.value("protocolVersion", 0);
        v.message = j.value("message", std::string());
    }

    static void to_json(json& j, const Heartbeat& v)
    {
        j = json{{"status", v.status}, {"currentJobId", v.currentJobId}, {"gpuFreeMb", v.gpuFreeMb},
                 {"serviceStatus", v.serviceStatus}, {"serviceDetail", v.serviceDetail},
                 {"ollamaUp", v.ollamaUp}};
    }
    static void from_json(const json& j, Heartbeat& v)
    {
        v.status = j.value("status", std::string());
        v.currentJobId = j.value("currentJobId", std::string());
        v.gpuFreeMb = j.value("gpuFreeMb", 0);
        v.serviceStatus = j.value("serviceStatus", std::string());
        v.serviceDetail = j.value("serviceDetail", std::string());
        v.ollamaUp = j.value("ollamaUp", false);
    }

    static void to_json(json& j, const SteamGuardTask& v)
    {
        j = json{{"requestId", v.requestId}, {"credentialRef", v.credentialRef}, {"code", v.code}};
    }
    static void from_json(const json& j, SteamGuardTask& v)
    {
        v.requestId = j.value("requestId", std::string());
        v.credentialRef = j.value("credentialRef", std::string());
        v.code = j.value("code", std::string());
    }

    static void to_json(json& j, const HeartbeatResponse& v)
    {
        j = json{{"steamGuard", v.steamGuard}};
    }
    static void from_json(const json& j, HeartbeatResponse& v)
    {
        v.steamGuard = j.value("steamGuard", SteamGuardTask());
    }

    static void to_json(json& j, const CommandSpec& v)
    {
        j = json{{"interpreter", v.interpreter}, {"script", v.script}, {"args", v.args}};
    }
    static void from_json(const json& j, CommandSpec& v)
    {
        v.interpreter = j.value("interpreter", std::string());
        v.script = j.value("script", std::string());
        v.args = j.value("args", std::vector<std::string>());
    }

    static void to_json(json& j, const RepoCheckout& v)
    {
        j = json{{"name", v.name}, {"url", v.url}, {"branch", v.branch},
                 {"commit", v.commit}, {"checkoutDir", v.checkoutDir}, {"authToken", v.authToken}};
        if (!v.hostedUuid.empty()) j["hostedUuid"] = v.hostedUuid;
        if (!v.tip.empty()) j["tip"] = v.tip;
    }
    static void from_json(const json& j, RepoCheckout& v)
    {
        v.name = j.value("name", std::string());
        v.url = j.value("url", std::string());
        v.branch = j.value("branch", std::string());
        v.commit = j.value("commit", std::string());
        v.checkoutDir = j.value("checkoutDir", std::string());
        v.authToken = j.value("authToken", std::string());
        v.hostedUuid = j.value("hostedUuid", std::string());
        v.tip = j.value("tip", std::string());
    }

    static void to_json(json& j, const ArtifactSpec& v)
    {
        j = json{{"globs", v.globs}, {"exclude", v.exclude}, {"excludeDefaults", v.excludeDefaults},
                 {"package", v.package}, {"archiveName", v.archiveName}};
    }
    static void from_json(const json& j, ArtifactSpec& v)
    {
        v.globs = j.value("globs", std::vector<std::string>());
        v.exclude = j.value("exclude", std::vector<std::string>());
        v.excludeDefaults = j.value("excludeDefaults", true);
        v.package = j.value("package", std::string());
        v.archiveName = j.value("archiveName", std::string());
    }

    static void to_json(json& j, const HandoffStep& v)
    {
        j = json{{"name", v.name}, {"type", v.type}, {"fields", v.fields},
                 {"continueOnError", v.continueOnError}};
    }
    static void from_json(const json& j, HandoffStep& v)
    {
        v.name = j.value("name", std::string());
        v.type = j.value("type", std::string());
        v.fields = j.value("fields", std::map<std::string, std::string>());
        v.continueOnError = j.value("continueOnError", false);
    }

    static void to_json(json& j, const ArtifactInput& v)
    {
        j = json{{"jobId", v.jobId}, {"archiveName", v.archiveName}, {"product", v.product},
                 {"variant", v.variant}, {"buildNumber", v.buildNumber}, {"commit", v.commit}};
    }
    static void from_json(const json& j, ArtifactInput& v)
    {
        v.jobId = j.value("jobId", std::string());
        v.archiveName = j.value("archiveName", std::string());
        v.product = j.value("product", std::string());
        v.variant = j.value("variant", std::string());
        v.buildNumber = j.value("buildNumber", 0);
        v.commit = j.value("commit", std::string());
    }

    static void to_json(json& j, const MirrorSpec& v)
    {
        j = json{{"remote", v.remote}, {"authToken", v.authToken}, {"branch", v.branch}, {"pushTags", v.pushTags}, {"allRefs", v.allRefs}};
    }
    static void from_json(const json& j, MirrorSpec& v)
    {
        v.remote = j.value("remote", std::string());
        v.authToken = j.value("authToken", std::string());
        v.branch = j.value("branch", std::string());
        v.pushTags = j.value("pushTags", true);
        v.allRefs = j.value("allRefs", false);
    }

    static void to_json(json& j, const ResolveSpec& v)
    {
        j = json{{"action", v.action}};
    }
    static void from_json(const json& j, ResolveSpec& v)
    {
        v.action = j.value("action", std::string());
    }

    static void to_json(json& j, const CheckInSpec& v) { j = json{{"eventId", v.eventId}, {"baseCommit", v.baseCommit}, {"headCommit", v.headCommit}}; }
    static void from_json(const json& j, CheckInSpec& v) { v.eventId = j.value("eventId", std::string()); v.baseCommit = j.value("baseCommit", std::string()); v.headCommit = j.value("headCommit", std::string()); }
    static void to_json(json& j, const HostSpec& v)
    {
        j = json{{"repoUuid", v.repoUuid}, {"defaultBranch", v.defaultBranch}, {"maxBytes", v.maxBytes}};
        if (!v.init.kind.empty()) j["init"] = json{{"kind", v.init.kind}, {"name", v.init.name}, {"archiveName", v.init.archiveName}, {"archiveSize", v.init.archiveSize}};
    }
    static void from_json(const json& j, HostSpec& v)
    {
        v.repoUuid = j.value("repoUuid", std::string());
        v.defaultBranch = j.value("defaultBranch", std::string());
        v.maxBytes = j.value("maxBytes", (int64_t)0);
        if (j.contains("init") && j.at("init").is_object()) {
            const auto& i = j.at("init");
            v.init.kind = i.value("kind", std::string()); v.init.name = i.value("name", std::string());
            v.init.archiveName = i.value("archiveName", std::string()); v.init.archiveSize = i.value("archiveSize", (int64_t)0);
        }
    }
    static void to_json(json& j, const PullSpec& v)
    {
        j = json{{"baseBranch", v.baseBranch}, {"message", v.message}, {"authorName", v.authorName}, {"authorEmail", v.authorEmail},
                 {"targetRemote", v.targetRemote}, {"targetBranch", v.targetBranch}};
    }
    static void from_json(const json& j, PullSpec& v)
    {
        v.baseBranch = j.value("baseBranch", std::string());
        v.message = j.value("message", std::string());
        v.authorName = j.value("authorName", std::string());
        v.authorEmail = j.value("authorEmail", std::string());
        v.targetRemote = j.value("targetRemote", std::string());
        v.targetBranch = j.value("targetBranch", std::string());
    }

    static void to_json(json& j, const LfsSpec& v) { j = json{{"url", v.url}, {"authToken", v.authToken}}; }
    static void from_json(const json& j, LfsSpec& v)
    {
        v.url = j.value("url", std::string());
        v.authToken = j.value("authToken", std::string());
    }

    static void to_json(json& j, const ImportSpec& v)
    {
        j = json{{"source", v.source}, {"artifactsRemote", v.artifactsRemote}, {"artifactsToken", v.artifactsToken}, {"smithRemote", v.smithRemote},
                 {"originalBlob", v.originalBlob}, {"thresholdBytes", v.thresholdBytes}, {"maxRepoBytes", v.maxRepoBytes}};
    }
    static void from_json(const json& j, ImportSpec& v)
    {
        v.source = j.value("source", std::string());
        v.artifactsRemote = j.value("artifactsRemote", std::string());
        v.artifactsToken = j.value("artifactsToken", std::string());
        v.smithRemote = j.value("smithRemote", std::string());
        v.originalBlob = j.value("originalBlob", std::string());
        v.thresholdBytes = j.value("thresholdBytes", int64_t(0));
        v.maxRepoBytes = j.value("maxRepoBytes", int64_t(0));
    }

    static void to_json(json& j, const JobSpec& v)
    {
        j = json{{"jobId", v.jobId}, {"kind", v.kind}, {"projectId", v.projectId}, {"buildNumber", v.buildNumber},
                 {"repos", v.repos}, {"command", v.command}, {"steps", v.steps}, {"workingDir", v.workingDir},
                 {"env", v.env}, {"timeoutSeconds", v.timeoutSeconds},
                 {"successExitCodes", v.successExitCodes}, {"artifacts", v.artifacts},
                 {"handoff", v.handoff}, {"inputs", v.inputs}, {"clean", v.clean}, {"mirror", v.mirror}, {"resolve", v.resolve}, {"host", v.host}, {"pull", v.pull}};
        if (v.kind == "checkin") j["checkIn"] = v.checkIn;
        if (!v.lfs.url.empty()) j["lfs"] = v.lfs;
        if (!v.import.source.empty()) j["import"] = v.import;
    }
    static void from_json(const json& j, JobSpec& v)
    {
        v.jobId = j.value("jobId", std::string());
        v.kind = j.value("kind", std::string("build"));
        if (v.kind.empty()) v.kind = "build";
        v.projectId = j.value("projectId", std::string());
        v.buildNumber = j.value("buildNumber", 0);
        v.repos = j.value("repos", std::vector<RepoCheckout>());
        v.command = j.value("command", CommandSpec());
        v.steps = j.value("steps", std::vector<CommandSpec>());
        v.workingDir = j.value("workingDir", std::string());
        v.env = j.value("env", std::map<std::string, std::string>());
        v.timeoutSeconds = j.value("timeoutSeconds", 0);
        v.successExitCodes = j.value("successExitCodes", std::vector<int>());
        v.artifacts = j.value("artifacts", ArtifactSpec());
        v.handoff = j.value("handoff", std::vector<HandoffStep>());
        v.inputs = j.value("inputs", std::vector<ArtifactInput>());
        v.clean = j.value("clean", false);
        v.mirror = j.value("mirror", MirrorSpec());
        v.resolve = j.value("resolve", ResolveSpec());
        v.checkIn = j.value("checkIn", CheckInSpec());
        v.host = j.value("host", HostSpec());
        v.lfs = j.value("lfs", LfsSpec());
        v.pull = j.value("pull", PullSpec());
        v.import = j.value("import", ImportSpec());
    }

    static void to_json(json& j, const JobAssignment& v)
    {
        j = json{{"hasJob", v.hasJob}, {"jobId", v.jobId}, {"spec", v.spec}};
    }
    static void from_json(const json& j, JobAssignment& v)
    {
        v.hasJob = j.value("hasJob", false);
        v.jobId = j.value("jobId", std::string());
        v.spec = j.value("spec", JobSpec());
    }

    static void to_json(json& j, const LogChunk& v)
    {
        j = json{{"seq", v.seq}, {"stream", v.stream}, {"lines", v.lines}};
    }
    static void from_json(const json& j, LogChunk& v)
    {
        v.seq = j.value("seq", (int64_t)0);
        v.stream = j.value("stream", std::string());
        v.lines = j.value("lines", std::vector<std::string>());
    }

    static void to_json(json& j, const JobResult& v)
    {
        j = json{{"status", v.status}, {"exitCode", v.exitCode},
                 {"durationMs", v.durationMs}, {"message", v.message}};
    }
    static void from_json(const json& j, JobResult& v)
    {
        v.status = j.value("status", std::string());
        v.exitCode = j.value("exitCode", 0);
        v.durationMs = j.value("durationMs", (int64_t)0);
        v.message = j.value("message", std::string());
    }

    static void to_json(json& j, const ServiceSpec& v)
    {
        j = json{{"action", v.action}, {"name", v.name}, {"specHash", v.specHash}, {"env", v.env}};
    }
    static void from_json(const json& j, ServiceSpec& v)
    {
        v.action = j.value("action", std::string());
        v.name = j.value("name", std::string());
        v.specHash = j.value("specHash", std::string());
        v.env = j.value("env", std::map<std::string, std::string>());
    }

    static void to_json(json& j, const TriggerRequest& v)
    {
        j = json{{"projectId", v.projectId}, {"product", v.product}, {"branch", v.branch},
                 {"commit", v.commit}, {"profile", v.profile}, {"targetOs", v.targetOs},
                 {"reason", v.reason}, {"clean", v.clean}};
    }
    static void from_json(const json& j, TriggerRequest& v)
    {
        v.projectId = j.value("projectId", std::string());
        v.product = j.value("product", std::string());
        v.branch = j.value("branch", std::string());
        v.commit = j.value("commit", std::string());
        v.profile = j.value("profile", std::string());
        v.targetOs = j.value("targetOs", std::string());
        v.reason = j.value("reason", std::string());
        v.clean = j.value("clean", false);
    }

    // --- Public API ---

    template <typename T>
    static std::string ToJsonT(const T& v)
    {
        json j = v;
        return j.dump();
    }

    template <typename T>
    static bool FromJsonT(const std::string& s, T& out)
    {
        json j = json::parse(s, nullptr, false);
        if (j.is_discarded() || !j.is_object()) return false;
        try { out = j.get<T>(); }
        catch (...) { return false; }
        return true;
    }

    std::string ToJson(const NodeInfo& v) { return ToJsonT(v); }
    std::string ToJson(const RegisterRequest& v) { return ToJsonT(v); }
    std::string ToJson(const RegisterResponse& v) { return ToJsonT(v); }
    std::string ToJson(const Heartbeat& v) { return ToJsonT(v); }
    std::string ToJson(const JobSpec& v) { return ToJsonT(v); }
    std::string ToJson(const JobAssignment& v) { return ToJsonT(v); }
    std::string ToJson(const LogChunk& v) { return ToJsonT(v); }
    std::string ToJson(const JobResult& v) { return ToJsonT(v); }
    std::string ToJson(const TriggerRequest& v) { return ToJsonT(v); }
    std::string ToJson(const ServiceSpec& v) { return ToJsonT(v); }
    std::string ToJson(const HeartbeatResponse& v) { return ToJsonT(v); }

    bool FromJson(const std::string& s, NodeInfo& v) { return FromJsonT(s, v); }
    bool FromJson(const std::string& s, RegisterRequest& v) { return FromJsonT(s, v); }
    bool FromJson(const std::string& s, RegisterResponse& v) { return FromJsonT(s, v); }
    bool FromJson(const std::string& s, Heartbeat& v) { return FromJsonT(s, v); }
    bool FromJson(const std::string& s, JobSpec& v) { return FromJsonT(s, v); }
    bool FromJson(const std::string& s, JobAssignment& v) { return FromJsonT(s, v); }
    bool FromJson(const std::string& s, LogChunk& v) { return FromJsonT(s, v); }
    bool FromJson(const std::string& s, JobResult& v) { return FromJsonT(s, v); }
    bool FromJson(const std::string& s, TriggerRequest& v) { return FromJsonT(s, v); }
    bool FromJson(const std::string& s, ServiceSpec& v) { return FromJsonT(s, v); }
    bool FromJson(const std::string& s, HeartbeatResponse& v) { return FromJsonT(s, v); }
}
