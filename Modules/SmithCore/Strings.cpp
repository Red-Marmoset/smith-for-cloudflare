// Strings.cpp - see Strings.h.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Strings.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>

namespace Smith
{
    std::string Trim(const std::string& s)
    {
        size_t a = s.find_first_not_of(" \t\r\n");
        if (a == std::string::npos) return "";
        size_t b = s.find_last_not_of(" \t\r\n");
        return s.substr(a, b - a + 1);
    }

    std::string Lower(std::string s)
    {
        std::transform(s.begin(), s.end(), s.begin(),
                       [](unsigned char c) { return (char)std::tolower(c); });
        return s;
    }

    std::string JsonEscape(const std::string& s)
    {
        std::string out;
        out.reserve(s.size() + 8);
        for (char c : s)
        {
            switch (c)
            {
                case '"':  out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\n': out += "\\n"; break;
                case '\r': out += "\\r"; break;
                case '\t': out += "\\t"; break;
                default:
                    if ((unsigned char)c < 0x20) { char b[8]; std::snprintf(b, sizeof(b), "\\u%04x", c); out += b; }
                    else out += c;
            }
        }
        return out;
    }

    std::regex GlobToRegex(const std::string& glob)
    {
        std::string re = "^";
        for (size_t i = 0; i < glob.size(); ++i)
        {
            char c = glob[i];
            if (c == '*')
            {
                if (i + 1 < glob.size() && glob[i + 1] == '*') { re += ".*"; ++i; }
                else re += "[^/]*";
            }
            else if (c == '?') re += "[^/]";
            else if (std::strchr(".()[]{}+^$|\\", c)) { re += '\\'; re += c; }
            else re += c;
        }
        re += "$";
        return std::regex(re, std::regex::ECMAScript);
    }

    std::vector<std::string> DefaultArtifactExcludes()
    {
        // Unity emits these next to a player build; the '**' prefix (which crosses
        // '/' in GlobToRegex) matches the folder whether it sits at the repo root
        // or nested under a build dir, and the trailing '/**' drops its contents.
        return {
            "**_BurstDebugInformation_DoNotShip/**",
            "**_BackUpThisFolder_ButDontShipItWithYourGame/**",
        };
    }

    std::vector<std::string> EffectiveArtifactExcludes(const std::vector<std::string>& projectExcludes,
                                                       bool includeDefaults)
    {
        std::vector<std::string> out = projectExcludes;
        if (includeDefaults)
            for (const auto& d : DefaultArtifactExcludes())
                if (std::find(out.begin(), out.end(), d) == out.end()) out.push_back(d);
        return out;
    }
}
