// TimeUtil.cpp
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "TimeUtil.h"

#include <chrono>
#include <ctime>
#include <cstdio>

namespace Smith
{
    int64_t NowMillis()
    {
        using namespace std::chrono;
        return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
    }

    std::string IsoFromMillis(int64_t millis)
    {
        std::time_t secs = (std::time_t)(millis / 1000);
        std::tm tmv{};
#ifdef _WIN32
        gmtime_s(&tmv, &secs);
#else
        gmtime_r(&secs, &tmv);
#endif
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ",
            tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
            tmv.tm_hour, tmv.tm_min, tmv.tm_sec);
        return std::string(buf);
    }

    std::string NowIso()
    {
        return IsoFromMillis(NowMillis());
    }
}
