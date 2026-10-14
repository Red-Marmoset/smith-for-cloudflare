// AgentUtil.h - tiny shared helpers for the agent's translation units.
// Internal to SmithAgent (not exported).
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <SmithCore/Config.h>
#include <Http/Http.h>

#include <filesystem>
#include <string>
#include <vector>

namespace Smith
{
    inline Http::Result DoGet(const AgentConfig& cfg, const std::string& path)
    {
        Http::Client c(cfg.coordinatorUrl);
        if (!cfg.token.empty()) c.SetBearerToken(cfg.token);
        c.SetTimeoutSeconds(60);
        return c.Get(path);
    }

    inline Http::Result DoPost(const AgentConfig& cfg, const std::string& path,
                               const std::string& body, const std::string& ctype = "application/json")
    {
        Http::Client c(cfg.coordinatorUrl);
        if (!cfg.token.empty()) c.SetBearerToken(cfg.token);
        c.SetTimeoutSeconds(120);
        return c.Post(path, body, ctype);
    }

    inline std::string ResolveDir(const std::string& base, const std::string& rel)
    {
        if (rel.empty() || rel == ".") return base;
        return (std::filesystem::path(base) / rel).string();
    }

    // Interpreter argv prefixes to try, most specific first. On Windows "python"
    // may be absent from PATH (or the Microsoft Store stub, which exits non-zero)
    // while the "py" launcher ships with every python.org install; on POSIX
    // "python" may still be Python 2 on old boxes, so it is probed last.
    inline const std::vector<std::vector<std::string>>& PythonCandidates()
    {
#ifdef _WIN32
        static const std::vector<std::vector<std::string>> c = { { "python" }, { "py", "-3" } };
#else
        static const std::vector<std::vector<std::string>> c = { { "python3" }, { "python" } };
#endif
        return c;
    }
}
