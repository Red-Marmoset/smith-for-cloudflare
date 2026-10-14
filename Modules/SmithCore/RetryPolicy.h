// RetryPolicy.h - decide whether a failed build is worth retrying on a DIFFERENT
// node. A node/environment failure (a missing tool or system library, an editor
// that won't launch, a crashed/vanished agent, a bad checkout) may succeed on
// another capable node; a code/content error (compiler/linker/test failures)
// would fail anywhere, so retrying just wastes a node. Pure + unit-testable,
// mirroring the NodeMatcher/Variants/Handoff style.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include "BuildDiagnostics.h"

#include <string>

namespace Smith
{
    // status: the terminal build status ("success" | "failed" | "error" | "lost" |
    //         "cancelled"). diag: parsed diagnostics of that build's console log.
    // Returns true when the failure looks node/environment-specific (worth one retry
    // on a different capable node); false for success, cancellation, or a code/content
    // error (real compiler/linker errors or failed tests) that would fail everywhere.
    bool IsRetryableFailure(const std::string& status, const BuildDiagnostics& diag);
}
