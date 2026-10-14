// NodeMatcher.cpp
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "NodeMatcher.h"
#include "Strings.h"

#include <algorithm>

namespace Smith
{
    bool NodeMatches(const NodeSelector& sel, const NodeInfo& node)
    {
        if (!sel.os.empty() && Lower(sel.os) != "any")
        {
            if (Lower(sel.os) != Lower(node.os)) return false;
        }
        for (const std::string& required : sel.labels)
        {
            if (std::find(node.labels.begin(), node.labels.end(), required) == node.labels.end())
                return false;
        }
        return true;
    }

    bool ShouldDeferForAffinity(const std::string& preferOs, const std::string& nodeOs,
                                int64_t queuedMs, int64_t graceMs, bool preferredAgentOnline)
    {
        if (preferOs.empty() || Lower(preferOs) == "any") return false;  // no affinity
        if (Lower(nodeOs) == Lower(preferOs)) return false;              // this IS the preferred agent
        if (!preferredAgentOnline) return false;                        // nobody better is around - don't stall
        return queuedMs < graceMs;                                      // young job: hold for the preferred agent
    }
}
