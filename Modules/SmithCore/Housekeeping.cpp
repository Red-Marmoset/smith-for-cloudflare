// Housekeeping.cpp
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Housekeeping.h"
#include "GitRepo.h"

#include <filesystem>
#include <algorithm>
#include <vector>
#include <chrono>

namespace fs = std::filesystem;

namespace Smith
{
    static std::string Mb(uint64_t bytes) { return std::to_string(bytes / (1024 * 1024)) + " MB"; }

    uint64_t FreeDiskBytes(const std::string& path)
    {
        std::error_code ec;
        // space() needs an existing path; walk up to the nearest one that exists.
        fs::path p = fs::absolute(path, ec);
        while (!p.empty() && !fs::exists(p, ec)) p = p.parent_path();
        if (p.empty()) return 0;
        fs::space_info si = fs::space(p, ec);
        return ec ? 0 : (uint64_t)si.available;
    }

    void TouchDir(const std::string& dir)
    {
        std::error_code ec;
        if (fs::exists(dir, ec))
            fs::last_write_time(dir, fs::file_time_type::clock::now(), ec);
    }

    int PruneLogs(const std::string& logDir, int keepDays, int keepMax, const HouseLog& log)
    {
        std::error_code ec;
        if (!fs::is_directory(logDir, ec)) return 0;

        struct Entry { fs::path path; fs::file_time_type mtime; };
        std::vector<Entry> files;
        for (const auto& e : fs::directory_iterator(logDir, ec))
        {
            if (!e.is_regular_file(ec)) continue;
            files.push_back({ e.path(), e.last_write_time(ec) });
        }
        // Newest first, so the keepMax cutoff keeps the most recent.
        std::sort(files.begin(), files.end(),
                  [](const Entry& a, const Entry& b) { return a.mtime > b.mtime; });

        const auto now = fs::file_time_type::clock::now();
        const auto maxAge = std::chrono::hours(24) * (keepDays > 0 ? keepDays : 0);

        int removed = 0;
        for (size_t i = 0; i < files.size(); ++i)
        {
            bool tooMany = keepMax > 0 && (int)i >= keepMax;
            bool tooOld  = keepDays > 0 && (now - files[i].mtime) > maxAge;
            if (!tooMany && !tooOld) continue;
            if (fs::remove(files[i].path, ec)) ++removed;
        }
        if (removed > 0 && log)
            log(false, "Housekeeping: pruned " + std::to_string(removed) + " old build log(s)");
        return removed;
    }

    uint64_t ReclaimWorkspaces(const std::string& wsRoot, const std::string& protectDir,
                               uint64_t targetFreeBytes, const HouseLog& log)
    {
        std::error_code ec;
        if (!fs::is_directory(wsRoot, ec)) return FreeDiskBytes(wsRoot);

        struct Proj { fs::path path; fs::file_time_type mtime; };
        std::vector<Proj> projects;
        for (const auto& e : fs::directory_iterator(wsRoot, ec))
        {
            if (!e.is_directory(ec)) continue;
            std::string name = e.path().filename().string();
            if (name == "_agent-logs" || name == protectDir) continue;   // never evict
            projects.push_back({ e.path(), e.last_write_time(ec) });
        }

        // First, a cheap pass: gc every checkout (including the protected one)
        // to reclaim git history without throwing away any working tree.
        GitRepo::Gc((fs::path(wsRoot) / protectDir).string(), log);
        for (const auto& p : projects) GitRepo::Gc(p.path.string(), log);
        if (FreeDiskBytes(wsRoot) >= targetFreeBytes) return FreeDiskBytes(wsRoot);

        // Still short: evict whole workspaces, least-recently-used first, until
        // the target is met or only the protected project remains.
        std::sort(projects.begin(), projects.end(),
                  [](const Proj& a, const Proj& b) { return a.mtime < b.mtime; });
        for (const auto& p : projects)
        {
            uint64_t free = FreeDiskBytes(wsRoot);
            if (free >= targetFreeBytes) break;
            if (log) log(true, "Housekeeping: evicting workspace " + p.path.filename().string() +
                               " to reclaim disk (was " + Mb(free) + " free)");
            fs::remove_all(p.path, ec);
            if (ec && log) log(true, "Housekeeping: could not remove " + p.path.string() + ": " + ec.message());
        }
        return FreeDiskBytes(wsRoot);
    }
}
