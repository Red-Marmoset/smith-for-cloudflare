// BuildDiagnostics.cpp - single-pass build-log parser. No I/O.
//
// The order of checks matters: MSVC /showIncludes noise is dropped first (it must
// never count), then the test-runner framing, then the structured compiler errors
// and warnings, then a few generic markers. Each line yields at most one finding.
// Counts are exact even past the list caps.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "BuildDiagnostics.h"
#include "Strings.h"

#include <regex>
#include <map>
#include <sstream>

namespace Smith
{
    static const int kMaxList = 200;             // errors / warnings kept
    static const int kMaxSuites = 100;
    static const int kMaxFailuresPerSuite = 50;

    static bool Contains(const std::string& hay, const char* needle)
    {
        return hay.find(needle) != std::string::npos;
    }

    // A \d+ capture can be arbitrarily long in a hostile log; never let std::stoi throw.
    static int SafeInt(const std::string& s)
    {
        try { return std::stoi(s); } catch (...) { return 0; }
    }

    BuildDiagnostics ParseBuildDiagnostics(const std::string& log)
    {
        using std::regex;
        // Compiler diagnostics.
        static const regex reMsvc(R"(^\s*(.+?)\((\d+)\)\s*:\s*(error|warning|fatal error)\s+(C\d+)\s*:\s*(.*)$)");
        static const regex reLnk(R"(^\s*(.+?)\s*:\s*(?:fatal error|error)\s+(LNK\d+)\s*:\s*(.*)$)");
        static const regex reClang(R"(^\s*(.+?):(\d+):(\d+):\s*(error|warning):\s*(.*)$)");
        static const regex reClangSummary(R"(\b\d+\s+(?:warning|error)s?\s+generated\b)");
        // Test-runner framing (engine RunTests + each test exe).
        static const regex reSuite(R"(^=+\s+(.+?)\s+=+$)");
        static const regex reResults(R"(Test Results:\s*(\d+)\s+Passed,\s*(\d+)\s+Failed)");
        static const regex reFail(R"(^FAIL:\s+Line\s+(\d+):\s*(.*)$)");
        static const regex reSuitePassed(R"(^(.+?)\s+passed$)");
        static const regex reSuiteFailed(R"(^(.+?)\s+FAILED\s*\(exit\s+\d+\)$)");
        static const regex reProjAllPass(R"(ALL\s+(\d+)\s+TEST PROJECT\(S\) PASSED)");
        static const regex reProjFailed(R"((\d+)\s+TEST PROJECT\(S\) FAILED,\s*(\d+)\s+PASSED)");

        BuildDiagnostics d;
        d.parsed = true;

        std::map<std::string, size_t> suiteIndex;   // name -> index in d.suites (stored only)
        int curSuite = -1;                           // current stored suite, or -1
        bool sawResults = false;
        int fbProjPassed = -1, fbProjFailed = -1;    // project-level totals (fallback only)

        auto addDiag = [&](const std::string& sev, const char* tool, const std::string& code,
                           const std::string& loc, const std::string& text, int lineNo)
        {
            std::vector<Diagnostic>& list = (sev == "error") ? d.errors : d.warnings;
            int& count = (sev == "error") ? d.errorCount : d.warningCount;
            ++count;
            if ((int)list.size() < kMaxList)
            {
                Diagnostic dg;
                dg.severity = sev; dg.tool = tool; dg.code = code;
                dg.location = loc; dg.text = text; dg.line = lineNo;
                list.push_back(std::move(dg));
            }
            else d.truncated = true;
        };

        std::istringstream in(log);
        std::string raw;
        int lineNo = 0;
        std::smatch m;
        while (std::getline(in, raw))
        {
            ++lineNo;
            if (!raw.empty() && raw.back() == '\r') raw.pop_back();
            std::string line = Trim(raw);
            if (line.empty()) continue;

            // 1) Noise that must never count.
            if (Contains(line, "Note: including file:")) continue;
            if (std::regex_search(line, reClangSummary)) continue;

            // 2) Test-runner framing.
            if (std::regex_match(line, m, reSuite))
            {
                ++d.suiteCount;
                std::string name = m[1].str();
                if ((int)d.suites.size() < kMaxSuites)
                {
                    TestSuite s; s.name = name;
                    d.suites.push_back(std::move(s));
                    curSuite = (int)d.suites.size() - 1;
                    suiteIndex[name] = (size_t)curSuite;
                }
                else { curSuite = -1; d.truncated = true; }
                continue;
            }
            if (std::regex_search(line, m, reResults))
            {
                int p = SafeInt(m[1].str());
                int f = SafeInt(m[2].str());
                d.testsPassed += p; d.testsFailed += f; sawResults = true;
                if (curSuite >= 0) { d.suites[curSuite].passed = p; d.suites[curSuite].failed = f; }
                continue;
            }
            if (std::regex_match(line, m, reFail))
            {
                if (curSuite >= 0)
                {
                    TestSuite& s = d.suites[curSuite];
                    if ((int)s.failures.size() < kMaxFailuresPerSuite)
                        s.failures.push_back(TestFailure{ "Line " + m[1].str() + ": " + m[2].str(), lineNo });
                    else d.truncated = true;
                }
                continue;
            }
            if (std::regex_match(line, m, reSuitePassed))
            {
                auto it = suiteIndex.find(m[1].str());
                if (it != suiteIndex.end()) { d.suites[it->second].status = "passed"; continue; }
            }
            if (std::regex_match(line, m, reSuiteFailed))
            {
                auto it = suiteIndex.find(m[1].str());
                if (it != suiteIndex.end()) { d.suites[it->second].status = "failed"; continue; }
            }
            if (std::regex_search(line, m, reProjAllPass)) { fbProjPassed = SafeInt(m[1].str()); fbProjFailed = 0; continue; }
            if (std::regex_search(line, m, reProjFailed)) { fbProjFailed = SafeInt(m[1].str()); fbProjPassed = SafeInt(m[2].str()); continue; }

            // 3) Structured compiler diagnostics.
            if (std::regex_match(line, m, reMsvc))
            {
                bool err = m[3].str().find("error") != std::string::npos;
                addDiag(err ? "error" : "warning", "msvc", m[4].str(),
                        m[1].str() + "(" + m[2].str() + ")", m[5].str(), lineNo);
                continue;
            }
            if (std::regex_match(line, m, reLnk))
            {
                addDiag("error", "linker", m[2].str(), m[1].str(), m[3].str(), lineNo);
                continue;
            }
            if (std::regex_match(line, m, reClang))
            {
                addDiag(m[4].str(), "clang", "", m[1].str() + ":" + m[2].str() + ":" + m[3].str(), m[5].str(), lineNo);
                continue;
            }

            // 4) Generic markers (no code). Conservative: only unambiguous strings.
            // BuildFailedException carries the actual CAUSE of a Unity batchmode
            // failure (e.g. "Build path contains a project previously built with
            // the Mono2x scripting backend...") - the result lines alone don't.
            if (Contains(line, "Aborting batchmode due to failure") ||
                Contains(line, "Player build result: Failed") ||
                Contains(line, "Scripts have compiler errors") ||
                Contains(line, "BuildFailedException") ||
                Contains(line, "Error building Player"))
            { addDiag("error", "unity", "", "", line, lineNo); continue; }

            if (line.rfind("ERROR:", 0) == 0 || Contains(line, "[ERROR]"))
            { addDiag("error", "generic", "", "", line, lineNo); continue; }

            if (Contains(line, "[WARN"))
            { addDiag("warning", "generic", "", "", line, lineNo); continue; }
        }

        // Per-suite assertion counts are authoritative; only when no test exe emitted
        // a "Test Results:" line do we fall back to the runner's project-level totals.
        if (!sawResults && (fbProjPassed >= 0 || fbProjFailed >= 0))
        {
            d.testsPassed = fbProjPassed > 0 ? fbProjPassed : 0;
            d.testsFailed = fbProjFailed > 0 ? fbProjFailed : 0;
        }
        return d;
    }
}
