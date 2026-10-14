// JsonFile.h - load/save a JSON document to a flat file.
//
// One home for the file plumbing every persisted collection used to hand-roll
// (read-whole-file + parse, and atomic write-temp-then-rename so a crash never
// leaves a truncated state file). Callers keep their own to/from-json code.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <json/single_include/nlohmann/json.hpp>

#include <string>

namespace Smith
{
    // False if the file is missing or not valid JSON; `out` untouched then.
    bool LoadJsonFile(const std::string& path, nlohmann::json& out);

    // Atomic: writes <path>.tmp then renames over the target; creates parent
    // directories. False only on I/O failure.
    bool SaveJsonFileAtomic(const std::string& path, const nlohmann::json& j, int indent = 2);

    // The underlying primitive (also used by Store for records/logs metadata).
    bool WriteFileAtomic(const std::string& path, const std::string& content);
}
