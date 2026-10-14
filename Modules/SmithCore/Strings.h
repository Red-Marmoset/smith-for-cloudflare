// Strings.h - tiny shared string/text helpers.
//
// These existed as per-file static copies in half a dozen translation units;
// one definition lives here. Keep this header dependency-light (std only).
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>
#include <regex>
#include <vector>

namespace Smith
{
    // Strip leading/trailing whitespace (space, tab, CR, LF).
    std::string Trim(const std::string& s);

    // ASCII lowercase copy.
    std::string Lower(std::string s);

    // Escape a string for embedding inside a JSON string literal (quotes,
    // backslashes, control characters). For the rare hand-built JSON body;
    // anything structured should use nlohmann instead.
    std::string JsonEscape(const std::string& s);

    // FILE-PATH glob ('*' stays within a path segment, '**' crosses segments,
    // '?' is one non-separator char) over a forward-slash relative path,
    // anchored. NOTE: branch globs (Coordinator's GlobMatch) are deliberately
    // different - there '*' may cross '/' so "feature/*" style patterns and
    // bare "*" behave the way git users expect.
    std::regex GlobToRegex(const std::string& glob);

    // Build outputs that should never be shipped, as file-path globs (for
    // GlobToRegex) matched against working-dir-relative artifact paths. These are
    // Unity's sibling debug folders, whose names literally say "do not ship" - the
    // '**' prefix matches them at any depth (root or nested under a build dir).
    std::vector<std::string> DefaultArtifactExcludes();

    // The exclude globs actually applied when collecting artifacts: the project's
    // own excludes from smith.json, plus DefaultArtifactExcludes() unless the
    // project opted out (excludeDefaults:false). Deduped.
    std::vector<std::string> EffectiveArtifactExcludes(const std::vector<std::string>& projectExcludes,
                                                       bool includeDefaults);
}
