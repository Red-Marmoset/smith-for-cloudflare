// Inputs.cpp - artifact input (fan-in) resolution. See Inputs.h.
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#include "Inputs.h"

namespace Smith
{
    // Latest (highest buildNumber) successful build of this project + branch +
    // product (+ variant) that collected artifacts, or null.
    static const BuildRecord* PickLatestSuccess(const std::vector<const BuildRecord*>& history,
                                                const std::string& projectId, const std::string& branch,
                                                const InputDef& in)
    {
        const BuildRecord* best = nullptr;
        for (const BuildRecord* b : history)
        {
            if (!b) continue;
            if (b->projectId != projectId || b->product != in.product) continue;
            if (b->variant != in.variant) continue;
            if (b->branch != branch) continue;
            if (b->status != "success" || b->artifacts.empty()) continue;
            if (!best || b->buildNumber > best->buildNumber) best = b;
        }
        return best;
    }

    // A successful build of this product (+ variant) WITH artifacts among a
    // specific run's builds, ignoring branch (the run's builds are the truth),
    // or null. Highest buildNumber wins on the off chance of duplicates.
    static const BuildRecord* PickFromRun(const std::vector<const BuildRecord*>& runBuilds,
                                          const InputDef& in)
    {
        const BuildRecord* best = nullptr;
        for (const BuildRecord* b : runBuilds)
        {
            if (!b) continue;
            if (b->product != in.product || b->variant != in.variant) continue;
            if (b->status != "success" || b->artifacts.empty()) continue;
            if (!best || b->buildNumber > best->buildNumber) best = b;
        }
        return best;
    }

    static std::string NoInputError(const InputDef& in, const std::string& branch)
    {
        return "no successful '" + in.product + "'" +
               (in.variant.empty() ? std::string() : " / '" + in.variant + "'") +
               " build with artifacts on branch '" + branch + "' to satisfy this rule's inputs";
    }

    static void EmitArtifacts(const BuildRecord* best, const InputDef& in,
                              std::vector<ArtifactInput>& out)
    {
        for (const auto& name : best->artifacts)
        {
            ArtifactInput ai;
            ai.jobId = best->jobId;
            ai.archiveName = name;
            ai.product = in.product;
            ai.variant = in.variant;
            ai.buildNumber = best->buildNumber;
            ai.commit = best->commit;
            out.push_back(ai);
        }
    }

    bool ResolveArtifactInputs(const std::vector<InputDef>& inputs,
                               const std::vector<const BuildRecord*>& history,
                               const std::string& projectId, const std::string& branch,
                               std::vector<ArtifactInput>& out, std::string& error)
    {
        for (const auto& in : inputs)
        {
            const BuildRecord* best = PickLatestSuccess(history, projectId, branch, in);
            if (!best) { error = NoInputError(in, branch); return false; }
            EmitArtifacts(best, in, out);
        }
        return true;
    }

    bool ResolveArtifactInputsFromBatch(const std::vector<InputDef>& inputs,
                                        const std::vector<const BuildRecord*>& batchBuilds,
                                        const std::vector<const BuildRecord*>& history,
                                        const std::string& projectId, const std::string& branch,
                                        std::vector<ArtifactInput>& out, std::string& error)
    {
        for (const auto& in : inputs)
        {
            // Prefer the artifact from THIS run; fall back to latest-success only
            // for an input variant the chain did not build.
            const BuildRecord* best = PickFromRun(batchBuilds, in);
            if (!best) best = PickLatestSuccess(history, projectId, branch, in);
            if (!best) { error = NoInputError(in, branch); return false; }
            EmitArtifacts(best, in, out);
        }
        return true;
    }
}
