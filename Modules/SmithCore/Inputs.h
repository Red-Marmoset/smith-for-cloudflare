// Inputs.h - resolve a rule's artifact inputs (fan-in) against build history.
//
// A deploy rule can declare `inputs` in smith.json: the collected artifacts of
// earlier builds (e.g. three per-platform builds) that must be staged into its
// workspace before its command runs. Resolution picks concrete builds here, on
// the coordinator, so the dispatched JobSpec stays a no-further-lookups unit.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include "BuildRecord.h"
#include "Domain.h"

#include <SmithProtocol/WireTypes.h>

#include <string>
#include <vector>

namespace Smith
{
    // For each InputDef pick the latest (highest buildNumber) successful build
    // of the same project + branch that collected artifacts, and expand every
    // stored artifact into one ArtifactInput. Returns false (and fills `error`)
    // when an input has no build to draw from - the caller should fail the job
    // with that message rather than dispatch one that cannot succeed.
    bool ResolveArtifactInputs(const std::vector<InputDef>& inputs,
                               const std::vector<const BuildRecord*>& history,
                               const std::string& projectId, const std::string& branch,
                               std::vector<ArtifactInput>& out, std::string& error);

    // As ResolveArtifactInputs, but a chain/batch deploy first draws each input
    // from the builds of its OWN run (`batchBuilds`) - guaranteeing same-run,
    // same-commit artifacts - and only falls back to the latest-success scan
    // over `history` for an input variant the chain did not build. This keeps a
    // partial rebuild from silently shipping a mixed-commit set.
    bool ResolveArtifactInputsFromBatch(const std::vector<InputDef>& inputs,
                                        const std::vector<const BuildRecord*>& batchBuilds,
                                        const std::vector<const BuildRecord*>& history,
                                        const std::string& projectId, const std::string& branch,
                                        std::vector<ArtifactInput>& out, std::string& error);
}
