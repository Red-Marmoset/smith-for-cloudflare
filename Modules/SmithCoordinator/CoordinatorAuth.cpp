// CoordinatorAuth.cpp - optional Google Workspace sign-in for the human UI/API.
//
// Smith has no TLS or crypto, so token AUTHENTICITY is established out-of-process
// by curl -> Google's tokeninfo endpoint; the helpers in SmithCore/GoogleAuth.h
// only parse the resulting claims and apply the domain / explicit-email policy.
// A successful sign-in mints an opaque random session token stored in
// sessions.json (no JWT/HMAC). Agents are unaffected - they keep using --token.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Coordinator.h"
#include "CoordinatorUtil.h"

#include <SmithCore/Process.h>
#include <SmithCore/TimeUtil.h>
#include <SmithCore/Uuid.h>
#include <SmithCore/Config.h>
#include <SmithCore/Strings.h>
#include <SmithCore/JsonFile.h>
#include <Log/Log.h>

#include <json/single_include/nlohmann/json.hpp>

#include <algorithm>
#include <fstream>
#include <sstream>
#include <filesystem>

using nlohmann::json;
namespace fs = std::filesystem;

namespace Smith
{
    static std::string BearerToken(const Http::Request& req)
    {
        std::string a = req.HeaderValue("Authorization");
        const std::string p = "Bearer ";
        if (a.size() > p.size() && a.compare(0, p.size(), p) == 0) return a.substr(p.size());
        return "";
    }

    // A Google ID token is three base64url segments joined by '.', i.e. only
    // [A-Za-z0-9_-] and '.'. Rejecting anything else up front means the raw
    // credential can never carry shell metacharacters into the verify command.
    static bool LooksLikeJwt(const std::string& s)
    {
        if (s.empty() || s.size() > 8192) return false;
        bool dot = false;
        for (char c : s)
        {
            if (c == '.') { dot = true; continue; }
            bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                      (c >= '0' && c <= '9') || c == '_' || c == '-';
            if (!ok) return false;
        }
        return dot;
    }

    bool Coordinator::AuthFeatureOn() const
    {
        return !m_cfg.googleClientId.empty();
    }

    bool Coordinator::CurrentSession(const Http::Request& req, Session& out) const
    {
        std::string tok = BearerToken(req);
        if (tok.empty()) return false;
        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_sessions.find(tok);
        if (it == m_sessions.end()) return false;
        if (it->second.expiresAt != 0 && it->second.expiresAt <= NowMillis()) return false;
        out = it->second;
        return true;
    }

    bool Coordinator::RequestHasSession(const Http::Request& req) const
    {
        Session s;
        return CurrentSession(req, s);
    }

    bool Coordinator::SessionTokenLive(const std::string& token) const
    {
        if (token.empty()) return false;
        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_sessions.find(token);
        if (it == m_sessions.end()) return false;
        if (it->second.expiresAt != 0 && it->second.expiresAt <= NowMillis()) return false;
        return true;
    }

    bool Coordinator::AuthorizedHuman(const Http::Request& req) const
    {
        // Not enforcing login -> same rule as agents (session/token/loopback).
        if (!(AuthFeatureOn() && m_cfg.requireLogin)) return Authorized(req);
        // Enforcing: a signed-in human, or the operator token for automation.
        // Deliberately NO loopback bypass, so a local browser must still sign in.
        if (RequestHasSession(req)) return true;
        if (!m_cfg.token.empty() && req.HeaderValue("Authorization") == ("Bearer " + m_cfg.token)) return true;
        return false;
    }

    std::set<std::string> Coordinator::AllowedEmailSet() const
    {
        std::set<std::string> s;
        for (const auto& e : m_cfg.googleAllowedEmails) { std::string l = Lower(e); if (!l.empty()) s.insert(l); }
        std::lock_guard<std::mutex> lock(m_mutex);
        for (const auto& kv : m_users) if (!kv.second.email.empty()) s.insert(Lower(kv.second.email));
        return s;
    }

    bool Coordinator::VerifyGoogleIdToken(const std::string& idToken, GoogleClaims& out, std::string& err)
    {
        ProcessOptions o;
        if (!m_cfg.tokenVerifyCommand.empty())
        {
            std::string cmd = m_cfg.tokenVerifyCommand;
            const std::string ph = "{token}";
            size_t pos = 0;
            while ((pos = cmd.find(ph, pos)) != std::string::npos) { cmd.replace(pos, ph.size(), idToken); pos += idToken.size(); }
            o.argv = (DetectOs() == "windows") ? std::vector<std::string>{ "cmd", "/c", cmd }
                                               : std::vector<std::string>{ "/bin/sh", "-c", cmd };
        }
        else
        {
            // Direct argv (no shell): the token is a single argument, so even if the
            // up-front LooksLikeJwt guard were bypassed there is no shell to inject.
            o.argv = { "curl", "-s", "--max-time", "10",
                       "https://oauth2.googleapis.com/tokeninfo?id_token=" + idToken };
        }
        o.timeoutSeconds = 15;

        std::string body;
        Process p;
        int rc = p.Run(o, [&](bool isErr, const std::string& line) { if (!isErr) body += line + "\n"; });
        if (body.empty())
        {
            err = (rc != 0) ? "token verification command failed (is curl installed?)"
                            : "empty response from token verification";
            return false;
        }
        return ParseTokenInfoJson(body, out, err);
    }

    Coordinator::User Coordinator::UpsertGoogleUser(const GoogleClaims& c)
    {
        std::string email = Lower(c.email);
        bool isAdmin = false;
        for (const auto& a : m_cfg.adminEmails) if (Lower(a) == email) { isAdmin = true; break; }

        std::lock_guard<std::mutex> lock(m_mutex);
        for (auto& kv : m_users)
        {
            User& u = kv.second;
            bool match = (!c.sub.empty() && u.googleSub == c.sub) ||
                         (!u.email.empty() && Lower(u.email) == email);
            if (match)
            {
                u.email = email;
                if (!c.sub.empty()) u.googleSub = c.sub;
                if (u.displayName.empty()) u.displayName = c.name.empty() ? email : c.name;
                if (isAdmin) u.role = "admin";
                return u;
            }
        }
        User u;
        u.id = MakeShortId();
        u.email = email;
        u.googleSub = c.sub;
        u.displayName = c.name.empty() ? email : c.name;
        u.role = isAdmin ? "admin" : "member";
        m_users[u.id] = u;
        return u;
    }

    std::string Coordinator::IssueSession(const User& u)
    {
        Session s;
        s.token = MakeSessionToken();
        s.userId = u.id;
        s.email = u.email;
        s.createdAt = NowMillis();
        s.expiresAt = s.createdAt + 30LL * 24 * 3600 * 1000;   // 30-day TTL
        { std::lock_guard<std::mutex> lock(m_mutex); m_sessions[s.token] = s; }
        SaveSessions();
        return s.token;
    }

    void Coordinator::SaveSessions()
    {
        json arr = json::array();
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            for (const auto& kv : m_sessions)
                arr.push_back(json{{"token", kv.second.token}, {"userId", kv.second.userId}, {"email", kv.second.email},
                                   {"createdAt", kv.second.createdAt}, {"expiresAt", kv.second.expiresAt}});
        }
        SaveJsonFileAtomic((fs::path(m_cfg.dataDir) / "sessions.json").string(), arr);
    }

    void Coordinator::LoadSessions()
    {
        json j;
        if (!LoadJsonFile((fs::path(m_cfg.dataDir) / "sessions.json").string(), j) || !j.is_array()) return;
        int64_t now = NowMillis();
        std::lock_guard<std::mutex> lock(m_mutex);
        for (const auto& e : j)
        {
            if (!e.is_object()) continue;
            Session s;
            s.token = e.value("token", std::string());
            s.userId = e.value("userId", std::string());
            s.email = e.value("email", std::string());
            s.createdAt = e.value("createdAt", (int64_t)0);
            s.expiresAt = e.value("expiresAt", (int64_t)0);
            if (s.token.empty()) continue;
            if (s.expiresAt != 0 && s.expiresAt <= now) continue;   // drop expired on load
            m_sessions[s.token] = s;
        }
    }

    // ------------------------------------------------------------------- handlers

    void Coordinator::HandleAuthConfig(const Http::Request&, Http::Response& res)
    {
        json j{{"enabled", AuthFeatureOn()}, {"clientId", m_cfg.googleClientId}, {"requireLogin", m_cfg.requireLogin}};
        j["domains"] = m_cfg.googleAllowedDomains;   // never expose the email allowlist
        res.Json(j.dump());
    }

    void Coordinator::HandleAuthGoogle(const Http::Request& req, Http::Response& res)
    {
        if (!AuthFeatureOn()) { JsonError(res, 404, "Google sign-in is not enabled"); return; }

        json j;
        std::string cred = ParseBody(req, j) ? j.value("credential", std::string()) : "";
        if (cred.empty())        { JsonError(res, 400, "missing credential"); return; }
        if (!LooksLikeJwt(cred)) { JsonError(res, 400, "malformed credential"); return; }

        std::set<std::string> emails = AllowedEmailSet();
        int64_t now = NowMillis();

        // 1) Cheap local pre-check of the UNVERIFIED payload: reject obvious
        //    failures (wrong app, wrong domain, expired) before a network call.
        //    This is a REJECT-only fast path - authenticity is proven in step 2.
        GoogleClaims pre; std::string perr;
        if (DecodeJwtPayloadUnverified(cred, pre, perr))
        {
            std::string why = ValidateGoogleClaims(pre, m_cfg.googleClientId, m_cfg.googleAllowedDomains, emails, now);
            if (!why.empty()) { JsonError(res, 403, why); return; }
        }

        // 2) Authoritative verification: curl -> Google tokeninfo (signature + exp).
        GoogleClaims claims; std::string verr;
        if (!VerifyGoogleIdToken(cred, claims, verr))
        {
            LOG_WARNING("Smith", "Google sign-in rejected: %s", verr.c_str());
            JsonError(res, 401, "could not verify Google sign-in");
            return;
        }

        // 3) Authoritative policy check against the verified claims.
        std::string why = ValidateGoogleClaims(claims, m_cfg.googleClientId, m_cfg.googleAllowedDomains, emails, now);
        if (!why.empty()) { JsonError(res, 403, why); return; }

        // 4) Find-or-create the user (binds googleSub), then issue a session.
        User u = UpsertGoogleUser(claims);
        SaveUsers();
        std::string token = IssueSession(u);
        LOG_INFO("Smith", "Google sign-in: %s (%s)", u.email.c_str(), u.role.c_str());
        res.Json(json{{"token", token},
                      {"user", json{{"id", u.id}, {"displayName", u.displayName}, {"email", u.email}, {"role", u.role}}}}.dump());
    }

    void Coordinator::HandleAuthMe(const Http::Request& req, Http::Response& res)
    {
        Session s;
        if (!CurrentSession(req, s)) { JsonError(res, 401, "not signed in"); return; }
        User u; bool found = false;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            auto it = m_users.find(s.userId);
            if (it != m_users.end()) { u = it->second; found = true; }
        }
        if (!found) { JsonError(res, 401, "unknown user"); return; }
        res.Json(json{{"id", u.id}, {"displayName", u.displayName}, {"email", u.email}, {"role", u.role}}.dump());
    }

    void Coordinator::HandleAuthLogout(const Http::Request& req, Http::Response& res)
    {
        std::string tok = BearerToken(req);
        bool removed = false;
        if (!tok.empty()) { std::lock_guard<std::mutex> lock(m_mutex); removed = m_sessions.erase(tok) > 0; }
        if (removed) SaveSessions();
        res.Json(json{{"ok", true}}.dump());
    }
}
