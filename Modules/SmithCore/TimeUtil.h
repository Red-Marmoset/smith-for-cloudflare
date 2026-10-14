// TimeUtil.h - timestamps for build records and logs.
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <cstdint>
#include <string>

namespace Smith
{
    int64_t NowMillis();
    std::string IsoFromMillis(int64_t millis);   // "2026-06-02T21:58:00Z"
    std::string NowIso();
}
