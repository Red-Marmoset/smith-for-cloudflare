// Uuid.cpp - random identifier generation.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Uuid.h"

#include <random>
#include <cstdint>
#include <cstdio>
#include <mutex>

namespace Smith
{
    static uint64_t NextRandom64()
    {
        static std::mutex mutex;
        static std::mt19937_64 engine([] {
            std::random_device rd;
            std::seed_seq seq{ rd(), rd(), rd(), rd(), rd(), rd(), rd(), rd() };
            return std::mt19937_64(seq);
        }());
        std::lock_guard<std::mutex> lock(mutex);
        return engine();
    }

    std::string MakeUuid()
    {
        uint64_t hi = NextRandom64();
        uint64_t lo = NextRandom64();

        // Set version (4) and variant (10xx) bits.
        hi = (hi & 0xFFFFFFFFFFFF0FFFull) | 0x0000000000004000ull;
        lo = (lo & 0x3FFFFFFFFFFFFFFFull) | 0x8000000000000000ull;

        char buf[37];
        std::snprintf(buf, sizeof(buf),
            "%08x-%04x-%04x-%04x-%012llx",
            (unsigned)(hi >> 32),
            (unsigned)((hi >> 16) & 0xFFFF),
            (unsigned)(hi & 0xFFFF),
            (unsigned)((lo >> 48) & 0xFFFF),
            (unsigned long long)(lo & 0xFFFFFFFFFFFFull));
        return std::string(buf);
    }

    std::string MakeShortId()
    {
        uint64_t v = NextRandom64();
        char buf[9];
        std::snprintf(buf, sizeof(buf), "%08x", (unsigned)(v & 0xFFFFFFFFull));
        return std::string(buf);
    }

    std::string MakeSessionToken()
    {
        // 256 bits straight from the OS CSPRNG (std::random_device) - this is a
        // bearer secret, so do NOT route it through the seeded mt19937 above.
        std::random_device rd;
        char buf[65];
        for (int i = 0; i < 8; ++i)
            std::snprintf(buf + i * 8, 9, "%08x", (unsigned)rd());
        return std::string(buf, 64);
    }
}
