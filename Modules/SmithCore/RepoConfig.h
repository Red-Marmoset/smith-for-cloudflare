// RepoConfig.h - parse a repo's smith.json into a ProjectDef.
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include "Domain.h"
#include <string>

namespace Smith
{
    // Parse smith.json text. Returns false on malformed JSON; 'error' gets a message.
    bool ParseProjectConfig(const std::string& jsonText, ProjectDef& out, std::string& error);

    // Load from a smith.json file, or from a directory containing smith.json.
    bool LoadProjectConfig(const std::string& pathOrDir, ProjectDef& out, std::string& error);
}
