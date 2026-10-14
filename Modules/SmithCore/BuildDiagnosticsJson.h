// BuildDiagnosticsJson.h - (de)serialize BuildDiagnostics to/from JSON. Shared by
// the flat-file Store (persist a parsed result) and the coordinator (serve the full
// tree + embed a compact summary in each build record). One serializer, no third
// hand-maintained copy.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include "BuildDiagnostics.h"
#include <json/single_include/nlohmann/json.hpp>

namespace Smith
{
    nlohmann::json DiagnosticsToJson(const BuildDiagnostics& d);          // full tree
    BuildDiagnostics DiagnosticsFromJson(const nlohmann::json& j);
    nlohmann::json DiagnosticsSummaryJson(const BuildDiagnostics& d);     // compact: counts only
}
