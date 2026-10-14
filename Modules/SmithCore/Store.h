// Store.h - flat-file persistence for build records, logs, artifacts and nodes.
//
// No database: build records are JSON files, logs are plain text, artifacts are
// files on disk. The coordinator is the only writer (agents send over HTTP), so
// a single process-wide mutex serializes writes.
//
// Layout:
//   <dataDir>/nodes/<nodeId>.json
//   <dataDir>/projects/<projectId>/builds/<number>-<jobId>/record.json
//   <dataDir>/projects/<projectId>/builds/<number>-<jobId>/console.log
//   <dataDir>/projects/<projectId>/builds/<number>-<jobId>/artifacts/<name>
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include "BuildRecord.h"
#include <SmithProtocol/WireTypes.h>

#include <string>
#include <vector>
#include <map>
#include <mutex>

namespace Smith
{
    class Store
    {
    public:
        explicit Store(std::string dataDir);

        bool Init();   // create the directory tree

        // Per-project monotonic build number (scans existing builds once).
        int NextBuildNumber(const std::string& projectId);

        bool SaveRecord(const BuildRecord& r);
        std::vector<BuildRecord> LoadAllRecords();   // scan everything (startup)
        bool DeleteBuild(const BuildRecord& r);            // remove one build's directory
        bool ClearProjectBuilds(const std::string& projectId);   // remove all of a project's builds

        void AppendLog(const BuildRecord& r, const std::string& text);
        std::string LogPath(const BuildRecord& r);
        bool ReadLog(const BuildRecord& r, std::string& out);

        std::string BuildDir(const BuildRecord& r);
        std::string ArtifactsDir(const BuildRecord& r);
        bool SaveArtifact(const BuildRecord& r, const std::string& name, const std::string& bytes);
        bool LoadArtifact(const BuildRecord& r, const std::string& name, std::string& bytesOut);

        void SaveNode(const NodeInfo& n);
        std::vector<NodeInfo> LoadNodes();

        const std::string& DataDir() const { return m_dataDir; }

    private:
        std::string ProjectDir(const std::string& projectId);
        std::string BuildsDir(const std::string& projectId);

        std::string m_dataDir;
        std::map<std::string, int> m_maxBuild;
        std::mutex m_mutex;
    };
}
