// BuildDiagnosticsJson.cpp - JSON mapping for BuildDiagnostics.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "BuildDiagnosticsJson.h"

using nlohmann::json;

namespace Smith
{
    static json DiagToJson(const Diagnostic& g)
    {
        return json{ {"severity", g.severity}, {"tool", g.tool}, {"code", g.code},
                     {"location", g.location}, {"text", g.text}, {"line", g.line} };
    }

    static Diagnostic DiagFromJson(const json& j)
    {
        Diagnostic g;
        g.severity = j.value("severity", std::string());
        g.tool = j.value("tool", std::string());
        g.code = j.value("code", std::string());
        g.location = j.value("location", std::string());
        g.text = j.value("text", std::string());
        g.line = j.value("line", 0);
        return g;
    }

    nlohmann::json DiagnosticsToJson(const BuildDiagnostics& d)
    {
        json errors = json::array();
        for (const auto& e : d.errors) errors.push_back(DiagToJson(e));
        json warnings = json::array();
        for (const auto& w : d.warnings) warnings.push_back(DiagToJson(w));

        json suites = json::array();
        for (const auto& s : d.suites)
        {
            json failures = json::array();
            for (const auto& f : s.failures) failures.push_back(json{ {"text", f.text}, {"line", f.line} });
            suites.push_back(json{ {"name", s.name}, {"status", s.status},
                                   {"passed", s.passed}, {"failed", s.failed}, {"failures", failures} });
        }

        return json{
            {"parsed", d.parsed}, {"truncated", d.truncated},
            {"errorCount", d.errorCount}, {"warningCount", d.warningCount},
            {"testsPassed", d.testsPassed}, {"testsFailed", d.testsFailed},
            {"suiteCount", d.suiteCount},
            {"errors", errors}, {"warnings", warnings}, {"suites", suites} };
    }

    BuildDiagnostics DiagnosticsFromJson(const nlohmann::json& j)
    {
        BuildDiagnostics d;
        if (!j.is_object()) return d;
        d.parsed = j.value("parsed", false);
        d.truncated = j.value("truncated", false);
        d.errorCount = j.value("errorCount", 0);
        d.warningCount = j.value("warningCount", 0);
        d.testsPassed = j.value("testsPassed", 0);
        d.testsFailed = j.value("testsFailed", 0);
        d.suiteCount = j.value("suiteCount", 0);
        if (j.contains("errors") && j["errors"].is_array())
            for (const auto& e : j["errors"]) d.errors.push_back(DiagFromJson(e));
        if (j.contains("warnings") && j["warnings"].is_array())
            for (const auto& w : j["warnings"]) d.warnings.push_back(DiagFromJson(w));
        if (j.contains("suites") && j["suites"].is_array())
            for (const auto& sj : j["suites"])
            {
                TestSuite s;
                s.name = sj.value("name", std::string());
                s.status = sj.value("status", std::string());
                s.passed = sj.value("passed", -1);
                s.failed = sj.value("failed", -1);
                if (sj.contains("failures") && sj["failures"].is_array())
                    for (const auto& fj : sj["failures"])
                        s.failures.push_back(TestFailure{ fj.value("text", std::string()), fj.value("line", 0) });
                d.suites.push_back(std::move(s));
            }
        return d;
    }

    nlohmann::json DiagnosticsSummaryJson(const BuildDiagnostics& d)
    {
        return json{ {"parsed", d.parsed}, {"errors", d.errorCount}, {"warnings", d.warningCount},
                     {"testsPassed", d.testsPassed}, {"testsFailed", d.testsFailed},
                     {"suiteCount", d.suiteCount}, {"truncated", d.truncated} };
    }
}
