// CoordinatorUtil.h - tiny shared helpers for the coordinator's HTTP handlers.
// Internal to SmithCoordinator (not exported); keeps the one error shape and the
// parse-or-400 prelude in a single place instead of ~40 hand-rolled copies.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <Http/Http.h>
#include <json/single_include/nlohmann/json.hpp>

#include <string>

namespace Smith
{
    // The uniform JSON error reply: {"error": msg} with the given status.
    inline void JsonError(Http::Response& res, int code, const std::string& msg)
    {
        res.Json(nlohmann::json{{"error", msg}}.dump(), code);
    }

    // Parse req.body as a JSON object. Pure predicate - the caller owns the
    // error reply, because every handler advertises its own expected shape.
    inline bool ParseBody(const Http::Request& req, nlohmann::json& out)
    {
        out = nlohmann::json::parse(req.body, nullptr, false);
        return !out.is_discarded() && out.is_object();
    }
}
