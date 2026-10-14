// Batches.h - the pure state machine for build batches/chains.
//
// A batch queues several builds in parallel and, only when ALL of them succeed,
// queues its `then` jobs (typically a deploy whose rule consumes the freshly
// collected artifacts via `inputs`). The transition logic here is pure - the
// coordinator owns the records, persistence and enqueueing - so it unit-tests
// without HTTP or a queue.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>
#include <vector>
#include <map>
#include <cstdint>

namespace Smith
{
    // One job a batch asked for (build phase or then phase).
    struct BatchJobRef
    {
        std::string jobId;
        std::string product;
        std::string variant;
    };

    // status: building -> deploying -> succeeded | failed
    //         building -> failed              (a build failed; `then` never runs)
    struct BatchDef
    {
        std::string id;
        std::string projectId;
        std::string name;             // chain name, or "ad-hoc"
        std::string branch;
        std::string commit;           // pinned tip at creation ("" = unpinned)
        std::string onFailure;        // "finish" | "cancel" (resolved, never empty)
        bool clean = false;           // force a clean checkout for every build in the batch
        std::vector<BatchJobRef> builds;
        std::vector<BatchJobRef> then;     // specs at creation; jobIds filled when queued
        std::string status = "building";
        std::string detail;           // human summary of the latest transition
        int64_t createdAt = 0;
        int64_t finishedAt = 0;
    };

    // What the coordinator should do after a status change of one of the batch's
    // jobs. Computed by BatchAdvance from the batch + a jobId->status view.
    struct BatchActions
    {
        bool changed = false;             // batch status/detail changed -> persist + emit event
        bool queueThen = false;           // all builds succeeded -> enqueue the then jobs
        std::vector<std::string> cancelJobIds;   // onFailure=="cancel": queued/running siblings to cancel
    };

    // True for success | failed | error | lost | cancelled.
    bool IsTerminalStatus(const std::string& status);

    // Advance `b` given the current status of every referenced job (missing ids
    // count as still pending). Mutates b.status/b.detail; returns the actions.
    BatchActions BatchAdvance(BatchDef& b, const std::map<std::string, std::string>& statusById);
}
