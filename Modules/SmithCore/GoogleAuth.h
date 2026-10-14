// GoogleAuth.h - pure helpers for Google ID-token (OpenID Connect) sign-in:
// parse claims (from a /tokeninfo response or an unverified JWT payload),
// validate them, and apply the workspace-domain / explicit-email allowlist.
//
// No I/O and no crypto live here. Token AUTHENTICITY is proven out-of-process by
// curl -> Google's tokeninfo endpoint (Smith has no TLS/crypto by design); these
// helpers only parse the resulting claims and apply policy. Unit-tested in
// SmithCoreTest.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>
#include <vector>
#include <set>
#include <cstdint>

namespace Smith
{
    struct GoogleClaims
    {
        std::string aud;            // OAuth client id the token was minted for
        std::string sub;            // stable Google user id
        std::string email;
        std::string name;           // display name (may be empty)
        std::string hd;             // hosted domain (present for Workspace accounts)
        bool emailVerified = false;
        int64_t expMs = 0;          // expiry in epoch milliseconds (Google reports seconds)
    };

    // Decode the UNVERIFIED payload of a JWT ("header.payload.signature") for a
    // cheap local pre-check. Authenticity is NOT established here - never trust
    // these claims as the sole gate. Returns false on a malformed token.
    bool DecodeJwtPayloadUnverified(const std::string& jwt, GoogleClaims& out, std::string& err);

    // Parse a Google /tokeninfo JSON response (curl stdout). Authoritative, since
    // tokeninfo only returns claims for a validly-signed, unexpired token.
    // Returns false (with err set) on a parse failure or an {error:...} response.
    bool ParseTokenInfoJson(const std::string& jsonText, GoogleClaims& out, std::string& err);

    // "" when the claims are acceptable for sign-in, else a human-readable reason.
    // Checks aud == expectedAud, email_verified, a present non-expired exp, and an
    // allowed identity (domain or explicit email).
    std::string ValidateGoogleClaims(const GoogleClaims& c,
                                     const std::string& expectedAud,
                                     const std::vector<std::string>& allowedDomains,
                                     const std::set<std::string>& allowedEmails,
                                     int64_t nowMs);

    // true if the email's domain (or hd) is an exact, case-insensitive match for
    // one of `domains`, OR the exact email is in `allowedEmails`. No subdomain
    // slip. `allowedEmails` is expected lowercased by the caller.
    bool IsAllowedIdentity(const std::string& email, const std::string& hd,
                           const std::vector<std::string>& domains,
                           const std::set<std::string>& allowedEmails);
}
