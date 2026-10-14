// BuildDiagnostics.h - parse a build log into structured errors, warnings and
// test results. Pure (no I/O): a single pass over the log text with a data-driven
// pattern set covering the toolchains Smith drives (MSVC, clang, the engine test
// runner, Unity). Mirrors the Handoff/Variants "pure, unit-testable" style so the
// coordinator can parse a finished build's console.log and the UI can drill into it.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>
#include <vector>

namespace Smith
{
    struct Diagnostic
    {
        std::string severity;   // "error" | "warning"
        std::string tool;       // "msvc" | "clang" | "linker" | "unity" | "generic"
        std::string code;       // e.g. "C2065", "LNK2019" (empty when the tool has none)
        std::string location;   // e.g. "Foo.cpp(142)" or "Foo.cpp:142:7" (best effort)
        std::string text;       // the message
        int line = 0;           // 1-based line in the log
    };

    struct TestFailure
    {
        std::string text;       // e.g. "Line 142: expected 200, got 404"
        int line = 0;           // 1-based line in the log
    };

    struct TestSuite
    {
        std::string name;
        std::string status;     // "passed" | "failed" | "" (unknown)
        int passed = -1;        // assertion counts (-1 = unknown)
        int failed = -1;
        std::vector<TestFailure> failures;   // capped at 50
    };

    // Counts are always the true totals; the lists are capped (truncated=true when a
    // cap is hit) so a pathological log can't blow up memory or the UI.
    struct BuildDiagnostics
    {
        bool parsed = false;
        bool truncated = false;
        int errorCount = 0;
        int warningCount = 0;
        int testsPassed = 0;
        int testsFailed = 0;
        int suiteCount = 0;
        std::vector<Diagnostic> errors;     // capped at 200
        std::vector<Diagnostic> warnings;   // capped at 200
        std::vector<TestSuite>  suites;     // capped at 100
    };

    // One pass over `log`. Always returns parsed=true.
    BuildDiagnostics ParseBuildDiagnostics(const std::string& log);
}
