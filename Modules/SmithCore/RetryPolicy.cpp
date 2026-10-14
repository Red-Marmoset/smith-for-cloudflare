// RetryPolicy.cpp - see RetryPolicy.h.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "RetryPolicy.h"

namespace Smith
{
    bool IsRetryableFailure(const std::string& status, const BuildDiagnostics& diag)
    {
        // Agent-level failures: the build never really ran as intended - a failed
        // checkout, an unhealthy workspace, an agent that crashed or vanished
        // mid-build (status "lost"). Another node may be perfectly healthy.
        if (status == "error" || status == "lost") return true;

        // The build ran and reported failure. If the log carries real compiler/linker
        // errors or failed tests, that's a code/content problem - it fails on ANY node,
        // so a retry is wasted. Otherwise the failure is environmental (a missing tool
        // or system library, an editor that wouldn't launch, no artifacts produced, a
        // non-zero exit with nothing diagnosable) and a different node may succeed.
        if (status == "failed")
            return diag.errorCount == 0 && diag.testsFailed == 0;

        // success / cancelled: nothing to retry.
        return false;
    }
}
