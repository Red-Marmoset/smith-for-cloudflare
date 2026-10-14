// Uuid.h - random (v4) identifier generation for job and node ids.
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>

namespace Smith
{
    // Returns a random UUID-v4 string, e.g. "f47ac10b-58cc-4372-a567-0e02b2c3d479".
    std::string MakeUuid();

    // A shorter random id (first 8 hex chars) for human-facing slugs.
    std::string MakeShortId();

    // A high-entropy (256-bit) opaque token, hex-encoded, drawn from the OS
    // CSPRNG (std::random_device) rather than the mt19937 id path - for use as a
    // bearer/session secret. e.g. "9f3c...<64 hex chars>".
    std::string MakeSessionToken();
}
