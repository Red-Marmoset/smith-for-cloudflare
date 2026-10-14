// Housekeeping.h - agent workspace disk management.
//
// The agent reuses per-project checkouts across builds (fast, but they grow:
// git history, build outputs, staged inputs) and writes one local log per
// build. Left unmanaged these fill the disk and the next build dies mid-way.
// These helpers cap log retention and, when free space runs low, reclaim it by
// gc-ing and evicting the least-recently-used project workspaces. Pure
// filesystem + git; no HTTP, no wx.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>
#include <functional>
#include <cstdint>

namespace Smith
{
    using HouseLog = std::function<void(bool isStderr, const std::string& line)>;

    // Bytes free on the volume holding `path` (0 if it cannot be queried).
    uint64_t FreeDiskBytes(const std::string& path);

    // Stamp a directory's modification time to "now" so it sorts as
    // most-recently-used for eviction. No-op if the dir does not exist.
    void TouchDir(const std::string& dir);

    // Delete build logs in `logDir` older than keepDays, and any beyond the
    // keepMax newest (whichever removes more). A value <= 0 disables that bound.
    // Returns the number of files removed.
    int PruneLogs(const std::string& logDir, int keepDays, int keepMax, const HouseLog& log);

    // Try to get at least `targetFreeBytes` free on the volume under `wsRoot` by
    // (1) gc-ing each project checkout, then (2) evicting whole project
    // workspaces oldest-first (the next build re-clones them). The directory
    // named `protectDir` (the current job's project) and `_agent-logs` are never
    // evicted. Returns the free bytes remaining when it stops (target met or
    // nothing left to evict).
    uint64_t ReclaimWorkspaces(const std::string& wsRoot, const std::string& protectDir,
                               uint64_t targetFreeBytes, const HouseLog& log);
}
