// GitUrl.cpp - lenient git URL/path validation (see GitUrl.h).
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "GitUrl.h"
#include "Base64.h"
#include "Strings.h"

#include <cctype>

namespace Smith
{
    std::string ValidateGitUrl(const std::string& raw)
    {
        std::string url = Trim(raw);
        if (url.empty()) return "enter a repository URL or path";

        // scheme://...  -> the scheme must be one we can actually clone.
        size_t sep = url.find("://");
        if (sep != std::string::npos)
        {
            std::string scheme = url.substr(0, sep);
            std::transform(scheme.begin(), scheme.end(), scheme.begin(),
                           [](unsigned char c) { return (char)std::tolower(c); });
            if (scheme != "http" && scheme != "https" && scheme != "ssh" && scheme != "git" && scheme != "file")
                return "unsupported scheme '" + scheme + "'";
            return "";
        }

        char c0 = url[0];

        // Local Windows paths: "C:\..." / "C:/..." and UNC "\\server\share".
        if (url.size() >= 3 && std::isalpha((unsigned char)c0) && url[1] == ':' && (url[2] == '\\' || url[2] == '/'))
            return "";
        if (url.size() >= 2 && url[0] == '\\' && url[1] == '\\')
            return "";

        // The exact mistake we want to catch: a stray leading slash before an
        // scp-style URL, e.g. "/git@github.com:org/repo". A real absolute local
        // path ("/home/user/repo") has no '@' + ':' pair, so it is not flagged.
        if ((c0 == '/' || c0 == '\\') && url.find('@') != std::string::npos && url.find(':') != std::string::npos)
            return "looks like a git URL with a stray leading '/' - remove it";

        // scp-style user@host:path (no scheme) is fine; so is any other bareword
        // or relative local path (a real clone failure still surfaces later).
        return "";
    }

    // For a "scheme://..." URL, return the part after "://" with any "user@" userinfo
    // removed (so "https://u@github.com/o/r" -> "github.com/o/r"). "" if there's no scheme.
    static std::string AfterSchemeAndUserinfo(const std::string& url)
    {
        size_t sep = url.find("://");
        if (sep == std::string::npos) return "";
        std::string rest = url.substr(sep + 3);
        size_t at = rest.find('@');
        size_t slash = rest.find('/');
        if (at != std::string::npos && (slash == std::string::npos || at < slash)) rest = rest.substr(at + 1);
        return rest;   // host[:port]/path...
    }

    bool IsGitHubUrl(const std::string& raw)
    {
        std::string url = Lower(Trim(raw));
        if (url.rfind("git@github.com:", 0) == 0) return true;   // scp-style
        std::string rest = AfterSchemeAndUserinfo(url);          // host[:port]/path (lowercased)
        return rest.rfind("github.com/", 0) == 0 || rest.rfind("github.com:", 0) == 0 || rest == "github.com";
    }

    std::string ToHttpsGitHubUrl(const std::string& raw)
    {
        std::string url = Trim(raw);
        if (!IsGitHubUrl(url)) return raw;                       // leave non-GitHub URLs untouched
        const std::string base = "https://github.com/";
        const std::string scp = "git@github.com:";              // scp-style: git@github.com:owner/repo(.git)
        if (Lower(url).rfind(scp, 0) == 0) return base + url.substr(scp.size());
        std::string rest = AfterSchemeAndUserinfo(url);         // github.com[:port]/PATH (original case preserved)
        size_t slash = rest.find('/');
        return base + (slash == std::string::npos ? std::string() : rest.substr(slash + 1));
    }

    std::string GitHubExtraHeader(const std::string& token)
    {
        if (token.empty()) return "";
        return "Authorization: Basic " + Base64Encode("x-access-token:" + token);
    }
}
