// Base64.h - base64 / base64url encode + decode (pure, no I/O, no crypto).
// Used to read the (unverified) payload of a Google ID-token JWT for a cheap
// local pre-check before the authoritative curl->tokeninfo verification.
// Unit-tested in SmithCoreTest.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>

namespace Smith
{
    // Standard base64 (alphabet A-Za-z0-9+/, '=' padded).
    std::string Base64Encode(const std::string& data);

    // base64url (alphabet A-Za-z0-9-_), no '=' padding.
    std::string Base64UrlEncode(const std::string& data);

    // Decode base64 or base64url. Accepts both alphabets (+/ and -_), tolerates
    // missing '=' padding and embedded whitespace, and stops at any '='. Returns
    // false (and leaves `out` empty) on an invalid character.
    bool Base64UrlDecode(const std::string& in, std::string& out);
}
