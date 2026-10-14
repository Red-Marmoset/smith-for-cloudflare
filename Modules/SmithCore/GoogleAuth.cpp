// GoogleAuth.cpp - parse + validate Google ID-token claims (see GoogleAuth.h).
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "GoogleAuth.h"
#include "Base64.h"
#include "Strings.h"

#include <json/single_include/nlohmann/json.hpp>

#include <algorithm>
#include <cctype>

namespace Smith
{
    // Read a JSON field as a string regardless of its underlying type. Google's
    // /tokeninfo returns email_verified and exp as STRINGS, while a raw JWT
    // payload encodes them as a bool and a number - so be tolerant of both.
    static std::string JStr(const nlohmann::json& j, const char* key)
    {
        auto it = j.find(key);
        if (it == j.end() || it->is_null()) return "";
        if (it->is_string())           return it->get<std::string>();
        if (it->is_boolean())          return it->get<bool>() ? "true" : "false";
        if (it->is_number_integer())   return std::to_string(it->get<long long>());
        if (it->is_number_unsigned())  return std::to_string(it->get<unsigned long long>());
        if (it->is_number_float())     return std::to_string((long long)it->get<double>());
        return "";
    }

    static void FillClaims(const nlohmann::json& j, GoogleClaims& o)
    {
        o.aud   = JStr(j, "aud");
        o.sub   = JStr(j, "sub");
        o.email = JStr(j, "email");
        o.name  = JStr(j, "name");
        o.hd    = JStr(j, "hd");

        std::string ev = Lower(JStr(j, "email_verified"));
        o.emailVerified = (ev == "true" || ev == "1");

        std::string exp = JStr(j, "exp");
        if (!exp.empty())
        {
            try { o.expMs = (int64_t)std::stoll(exp) * 1000; }
            catch (...) { o.expMs = 0; }
        }
    }

    bool DecodeJwtPayloadUnverified(const std::string& jwt, GoogleClaims& out, std::string& err)
    {
        size_t p1 = jwt.find('.');
        if (p1 == std::string::npos) { err = "not a JWT (no '.')"; return false; }
        size_t p2 = jwt.find('.', p1 + 1);
        std::string payload = (p2 == std::string::npos) ? jwt.substr(p1 + 1)
                                                        : jwt.substr(p1 + 1, p2 - p1 - 1);
        std::string json;
        if (!Base64UrlDecode(payload, json)) { err = "JWT payload is not base64url"; return false; }

        nlohmann::json j;
        try { j = nlohmann::json::parse(json); }
        catch (...) { err = "JWT payload is not JSON"; return false; }
        if (!j.is_object()) { err = "JWT payload is not a JSON object"; return false; }

        FillClaims(j, out);
        return true;
    }

    bool ParseTokenInfoJson(const std::string& jsonText, GoogleClaims& out, std::string& err)
    {
        nlohmann::json j;
        try { j = nlohmann::json::parse(jsonText); }
        catch (...) { err = "tokeninfo response was not valid JSON"; return false; }
        if (!j.is_object()) { err = "unexpected tokeninfo response"; return false; }

        if (j.contains("error") || j.contains("error_description"))
        {
            err = JStr(j, "error_description");
            if (err.empty()) err = JStr(j, "error");
            if (err.empty()) err = "token rejected by Google";
            return false;
        }

        FillClaims(j, out);
        if (out.aud.empty() && out.email.empty()) { err = "tokeninfo response missing claims"; return false; }
        return true;
    }

    bool IsAllowedIdentity(const std::string& email, const std::string& hd,
                           const std::vector<std::string>& domains,
                           const std::set<std::string>& allowedEmails)
    {
        std::string e = Lower(email);
        if (!e.empty() && allowedEmails.find(e) != allowedEmails.end()) return true;

        std::string emailDomain;
        size_t at = e.find('@');
        if (at != std::string::npos) emailDomain = e.substr(at + 1);
        std::string hdLower = Lower(hd);

        for (const auto& d : domains)
        {
            std::string dl = Lower(d);
            if (dl.empty()) continue;
            if (!emailDomain.empty() && emailDomain == dl) return true;
            if (!hdLower.empty() && hdLower == dl) return true;
        }
        return false;
    }

    std::string ValidateGoogleClaims(const GoogleClaims& c,
                                     const std::string& expectedAud,
                                     const std::vector<std::string>& allowedDomains,
                                     const std::set<std::string>& allowedEmails,
                                     int64_t nowMs)
    {
        if (expectedAud.empty())            return "Google sign-in is not configured";
        if (c.aud != expectedAud)           return "token was issued for a different application";
        if (c.email.empty())                return "token has no email";
        if (!c.emailVerified)               return "email address is not verified";
        if (c.expMs != 0 && c.expMs <= nowMs) return "token has expired";
        if (!IsAllowedIdentity(c.email, c.hd, allowedDomains, allowedEmails))
            return "account '" + c.email + "' is not in an allowed domain or the user allowlist";
        return "";
    }
}
