// Store.cpp - flat-file persistence.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Store.h"
#include "BuildDiagnosticsJson.h"
#include "JsonFile.h"

#include <SmithProtocol/WireJson.h>
#include <json/single_include/nlohmann/json.hpp>

#include <fstream>
#include <sstream>
#include <filesystem>
#include <cctype>
#include <algorithm>

using nlohmann::json;
namespace fs = std::filesystem;

namespace Smith
{
    static bool ReadWholeFile(const fs::path& path, std::string& out)
    {
        std::ifstream in(path, std::ios::binary);
        if (!in) return false;
        std::stringstream ss;
        ss << in.rdbuf();
        out = ss.str();
        return true;
    }

    static json RecordToJson(const BuildRecord& r)
    {
        return json{
            {"jobId", r.jobId}, {"projectId", r.projectId}, {"product", r.product},
            {"variant", r.variant}, {"targetOs", r.targetOs}, {"rule", r.rule}, {"buildNumber", r.buildNumber},
            {"branch", r.branch}, {"commit", r.commit},
            {"authorName", r.authorName}, {"authorEmail", r.authorEmail},
            {"reason", r.reason}, {"batchId", r.batchId}, {"clean", r.clean}, {"status", r.status},
            {"phase", r.phase}, {"nodeId", r.nodeId}, {"nodeName", r.nodeName}, {"createdAt", r.createdAt},
            {"startedAt", r.startedAt}, {"finishedAt", r.finishedAt}, {"exitCode", r.exitCode},
            {"durationMs", r.durationMs}, {"artifacts", r.artifacts},
            {"attempt", r.attempt}, {"avoidNodeName", r.avoidNodeName}, {"retryOfJobId", r.retryOfJobId},
            {"diagnostics", DiagnosticsToJson(r.diagnostics)}};
    }

    static BuildRecord RecordFromJson(const json& j)
    {
        BuildRecord r;
        r.jobId = j.value("jobId", std::string());
        r.projectId = j.value("projectId", std::string());
        r.product = j.value("product", std::string());
        r.variant = j.value("variant", std::string());
        r.targetOs = j.value("targetOs", std::string());
        r.rule = j.value("rule", std::string());
        r.buildNumber = j.value("buildNumber", 0);
        r.branch = j.value("branch", std::string());
        r.commit = j.value("commit", std::string());
        r.authorName = j.value("authorName", std::string());
        r.authorEmail = j.value("authorEmail", std::string());
        r.reason = j.value("reason", std::string());
        r.batchId = j.value("batchId", std::string());
        r.clean = j.value("clean", false);
        r.status = j.value("status", std::string("queued"));
        r.phase = j.value("phase", std::string("queued"));
        r.nodeId = j.value("nodeId", std::string());
        r.nodeName = j.value("nodeName", std::string());
        r.createdAt = j.value("createdAt", (int64_t)0);
        r.startedAt = j.value("startedAt", (int64_t)0);
        r.finishedAt = j.value("finishedAt", (int64_t)0);
        r.exitCode = j.value("exitCode", 0);
        r.durationMs = j.value("durationMs", (int64_t)0);
        r.artifacts = j.value("artifacts", std::vector<std::string>());
        r.attempt = j.value("attempt", 1);
        r.avoidNodeName = j.value("avoidNodeName", std::string());
        r.retryOfJobId = j.value("retryOfJobId", std::string());
        return r;
    }

    Store::Store(std::string dataDir) : m_dataDir(std::move(dataDir)) {}

    std::string Store::ProjectDir(const std::string& projectId)
    {
        return (fs::path(m_dataDir) / "projects" / projectId).string();
    }
    std::string Store::BuildsDir(const std::string& projectId)
    {
        return (fs::path(ProjectDir(projectId)) / "builds").string();
    }
    std::string Store::BuildDir(const BuildRecord& r)
    {
        std::string dir = std::to_string(r.buildNumber) + "-" + r.jobId;
        return (fs::path(BuildsDir(r.projectId)) / dir).string();
    }
    std::string Store::ArtifactsDir(const BuildRecord& r)
    {
        return (fs::path(BuildDir(r)) / "artifacts").string();
    }
    std::string Store::LogPath(const BuildRecord& r)
    {
        return (fs::path(BuildDir(r)) / "console.log").string();
    }

    bool Store::Init()
    {
        std::error_code ec;
        fs::create_directories(fs::path(m_dataDir) / "nodes", ec);
        fs::create_directories(fs::path(m_dataDir) / "projects", ec);
        return !ec;
    }

    int Store::NextBuildNumber(const std::string& projectId)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_maxBuild.find(projectId);
        if (it == m_maxBuild.end())
        {
            int maxN = 0;
            std::error_code ec;
            fs::path builds(BuildsDir(projectId));
            if (fs::is_directory(builds, ec))
            {
                for (const auto& entry : fs::directory_iterator(builds, ec))
                {
                    if (!entry.is_directory()) continue;
                    std::string name = entry.path().filename().string();
                    size_t dash = name.find('-');
                    std::string num = dash == std::string::npos ? name : name.substr(0, dash);
                    if (!num.empty() && std::all_of(num.begin(), num.end(),
                        [](unsigned char c) { return std::isdigit(c) != 0; }))
                    {
                        try { maxN = std::max(maxN, std::stoi(num)); } catch (...) {}
                    }
                }
            }
            it = m_maxBuild.emplace(projectId, maxN).first;
        }
        it->second += 1;
        return it->second;
    }

    bool Store::SaveRecord(const BuildRecord& r)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        fs::path path = fs::path(BuildDir(r)) / "record.json";
        return WriteFileAtomic(path.string(), RecordToJson(r).dump(2));
    }

    std::vector<BuildRecord> Store::LoadAllRecords()
    {
        std::vector<BuildRecord> records;
        std::error_code ec;
        fs::path projects(fs::path(m_dataDir) / "projects");
        if (!fs::is_directory(projects, ec)) return records;

        for (const auto& proj : fs::directory_iterator(projects, ec))
        {
            if (!proj.is_directory()) continue;
            fs::path builds = proj.path() / "builds";
            if (!fs::is_directory(builds, ec)) continue;
            for (const auto& b : fs::directory_iterator(builds, ec))
            {
                if (!b.is_directory()) continue;
                std::string text;
                if (!ReadWholeFile(b.path() / "record.json", text)) continue;
                json j = json::parse(text, nullptr, false);
                if (j.is_discarded() || !j.is_object()) continue;
                records.push_back(RecordFromJson(j));
            }
        }
        return records;
    }

    bool Store::DeleteBuild(const BuildRecord& r)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        std::error_code ec;
        fs::remove_all(fs::path(BuildDir(r)), ec);
        return !ec;
    }

    bool Store::ClearProjectBuilds(const std::string& projectId)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        std::error_code ec;
        fs::remove_all(fs::path(BuildsDir(projectId)), ec);
        m_maxBuild.erase(projectId);   // numbering restarts once the history is gone
        return !ec;
    }

    void Store::AppendLog(const BuildRecord& r, const std::string& text)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        std::error_code ec;
        fs::create_directories(BuildDir(r), ec);
        std::ofstream o(LogPath(r), std::ios::binary | std::ios::app);
        if (o) o.write(text.data(), (std::streamsize)text.size());
    }

    bool Store::ReadLog(const BuildRecord& r, std::string& out)
    {
        return ReadWholeFile(LogPath(r), out);
    }

    bool Store::SaveArtifact(const BuildRecord& r, const std::string& name, const std::string& bytes)
    {
        // Guard against path traversal in the artifact name.
        fs::path safe = fs::path(name).filename();
        if (safe.empty()) return false;
        fs::path path = fs::path(ArtifactsDir(r)) / safe;
        return WriteFileAtomic(path.string(), bytes);
    }

    bool Store::LoadArtifact(const BuildRecord& r, const std::string& name, std::string& bytesOut)
    {
        fs::path safe = fs::path(name).filename();
        if (safe.empty()) return false;
        return ReadWholeFile(fs::path(ArtifactsDir(r)) / safe, bytesOut);
    }

    void Store::SaveNode(const NodeInfo& n)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        fs::path path = fs::path(m_dataDir) / "nodes" / (n.nodeId + ".json");
        WriteFileAtomic(path.string(), ToJson(n));
    }

    std::vector<NodeInfo> Store::LoadNodes()
    {
        std::vector<NodeInfo> nodes;
        std::error_code ec;
        fs::path dir(fs::path(m_dataDir) / "nodes");
        if (!fs::is_directory(dir, ec)) return nodes;
        for (const auto& e : fs::directory_iterator(dir, ec))
        {
            if (e.path().extension() != ".json") continue;
            std::string text;
            if (!ReadWholeFile(e.path(), text)) continue;
            NodeInfo n;
            if (FromJson(text, n)) nodes.push_back(n);
        }
        return nodes;
    }
}
