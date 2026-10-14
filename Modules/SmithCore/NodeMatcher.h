// NodeMatcher.h - decide whether a node satisfies a rule's node selector.
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include "Domain.h"
#include <SmithProtocol/WireTypes.h>

namespace Smith
{
    // True if node.os matches sel.os (or sel.os == "any") and the node carries
    // every label the selector requires.
    bool NodeMatches(const NodeSelector& sel, const NodeInfo& node);

    // Soft affinity gate. A job carrying `preferOs` should let an agent of that
    // OS claim it first: a non-preferred (already label-matched) node defers
    // while the job is still young AND a preferred-OS agent is online. Returns
    // true => the polling node should skip this job for now. No preferOs, or the
    // node IS the preferred OS, or the grace window elapsed, or no preferred
    // agent online => false (the node may take it).
    bool ShouldDeferForAffinity(const std::string& preferOs, const std::string& nodeOs,
                                int64_t queuedMs, int64_t graceMs, bool preferredAgentOnline);
}
