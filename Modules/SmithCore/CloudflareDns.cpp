// CloudflareDns.cpp - see CloudflareDns.h.
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#include "CloudflareDns.h"

#include <json/single_include/nlohmann/json.hpp>

#include <cctype>

using nlohmann::json;

namespace Smith
{
    std::string TrimWhitespace(const std::string& s)
    {
        size_t b = 0, e = s.size();
        while (b < e && std::isspace((unsigned char)s[b])) ++b;
        while (e > b && std::isspace((unsigned char)s[e - 1])) --e;
        return s.substr(b, e - b);
    }

    bool IsIpv4(const std::string& s)
    {
        int octets = 0; size_t i = 0;
        while (i < s.size())
        {
            int val = 0, digits = 0;
            while (i < s.size() && std::isdigit((unsigned char)s[i])) { val = val * 10 + (s[i] - '0'); ++digits; ++i; if (val > 255) return false; }
            if (digits == 0 || digits > 3) return false;
            ++octets;
            if (i < s.size()) { if (s[i] != '.') return false; ++i; if (i == s.size()) return false; }   // reject trailing dot
        }
        return octets == 4;
    }

    static bool ParseOk(const std::string& body, json& j)
    {
        j = json::parse(body, nullptr, false);
        return !j.is_discarded() && j.is_object() && j.value("success", false) && j.contains("result");
    }

    bool ParseCloudflareFirstId(const std::string& body, std::string& idOut)
    {
        json j; if (!ParseOk(body, j)) return false;
        const auto& r = j["result"];
        if (!r.is_array() || r.empty() || !r[0].is_object() || !r[0].contains("id") || !r[0]["id"].is_string()) return false;
        idOut = r[0]["id"].get<std::string>();
        return !idOut.empty();
    }

    bool ParseCloudflareRecord(const std::string& body, std::string& idOut, std::string& ipOut)
    {
        json j; if (!ParseOk(body, j)) return false;
        const auto& r = j["result"];
        if (!r.is_array() || r.empty() || !r[0].is_object() || !r[0].contains("id") || !r[0]["id"].is_string()) return false;
        idOut = r[0]["id"].get<std::string>();
        ipOut = r[0].value("content", std::string());
        return !idOut.empty();
    }

    std::string CloudflareUpdateBody(const std::string& record, const std::string& ip, bool proxied)
    {
        return json{{"type", "A"}, {"name", record}, {"content", ip}, {"ttl", 1}, {"proxied", proxied}}.dump();
    }

    bool CloudflareSucceeded(const std::string& body)
    {
        json j = json::parse(body, nullptr, false);
        return !j.is_discarded() && j.is_object() && j.value("success", false);
    }
}
