// Batches.cpp - see Batches.h.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Batches.h"

namespace Smith
{
    bool IsTerminalStatus(const std::string& s)
    {
        return s == "success" || s == "failed" || s == "error" || s == "lost" ||
               s == "cancelled" || s == "superseded";
    }

    static std::string StatusOf(const std::map<std::string, std::string>& m, const std::string& jobId)
    {
        auto it = m.find(jobId);
        return it == m.end() ? std::string("queued") : it->second;
    }

    // Summarize one phase: counts + the first non-success name, e.g. "2/3 built".
    static void Tally(const std::vector<BatchJobRef>& jobs, const std::map<std::string, std::string>& statusById,
                      int& succeeded, int& terminal, std::string& firstBad)
    {
        succeeded = 0; terminal = 0;
        for (const auto& j : jobs)
        {
            std::string s = StatusOf(statusById, j.jobId);
            if (!IsTerminalStatus(s)) continue;
            ++terminal;
            if (s == "success") ++succeeded;
            else if (firstBad.empty()) firstBad = (j.variant.empty() ? j.product : j.variant) + " " + s;
        }
    }

    BatchActions BatchAdvance(BatchDef& b, const std::map<std::string, std::string>& statusById)
    {
        BatchActions act;
        if (b.status != "building" && b.status != "deploying") return act;   // already settled

        const std::vector<BatchJobRef>& phase = (b.status == "building") ? b.builds : b.then;
        int succeeded = 0, terminal = 0;
        std::string firstBad;
        Tally(phase, statusById, succeeded, terminal, firstBad);
        int total = (int)phase.size();

        // Progress detail is refreshed on every call; only transitions set changed.
        std::string verb = (b.status == "building") ? "built" : "deployed";
        std::string progress = std::to_string(succeeded) + "/" + std::to_string(total) + " " + verb;

        if (!firstBad.empty())
        {
            // A job went bad: the batch fails now. In the building phase `then`
            // never runs, and the onFailure policy decides whether surviving
            // siblings keep running.
            bool building = (b.status == "building");
            b.status = "failed";
            b.detail = progress + " - " + firstBad + (building ? "; the follow-up step will not run" : "");
            act.changed = true;
            if (building && b.onFailure == "cancel")
                for (const auto& j : b.builds)
                    if (!IsTerminalStatus(StatusOf(statusById, j.jobId)))
                        act.cancelJobIds.push_back(j.jobId);
            return act;
        }

        if (terminal < total)
        {
            if (b.detail != progress) { b.detail = progress; act.changed = true; }
            return act;
        }

        // Every job in this phase is terminal and none was bad -> all succeeded.
        if (b.status == "building")
        {
            if (b.then.empty())
            {
                b.status = "succeeded";
                b.detail = progress;
            }
            else
            {
                b.status = "deploying";
                b.detail = progress + " - follow-up queued";
                act.queueThen = true;
            }
        }
        else   // deploying
        {
            b.status = "succeeded";
            b.detail = progress;
        }
        act.changed = true;
        return act;
    }
}
