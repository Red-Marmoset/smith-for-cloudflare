// WireJson.h - JSON (de)serialization for the wire types.
//
// std::string-based API so consumers don't need to include nlohmann. Parsing is
// lenient: unknown fields are ignored and missing fields take default values
// (forward/backward compatibility); malformed JSON returns false.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include "WireTypes.h"
#include <string>

namespace Smith
{
    std::string ToJson(const NodeInfo&);
    std::string ToJson(const RegisterRequest&);
    std::string ToJson(const RegisterResponse&);
    std::string ToJson(const Heartbeat&);
    std::string ToJson(const JobSpec&);
    std::string ToJson(const JobAssignment&);
    std::string ToJson(const LogChunk&);
    std::string ToJson(const JobResult&);
    std::string ToJson(const TriggerRequest&);
    std::string ToJson(const ServiceSpec&);
    std::string ToJson(const HeartbeatResponse&);

    bool FromJson(const std::string&, NodeInfo&);
    bool FromJson(const std::string&, RegisterRequest&);
    bool FromJson(const std::string&, RegisterResponse&);
    bool FromJson(const std::string&, Heartbeat&);
    bool FromJson(const std::string&, JobSpec&);
    bool FromJson(const std::string&, JobAssignment&);
    bool FromJson(const std::string&, LogChunk&);
    bool FromJson(const std::string&, JobResult&);
    bool FromJson(const std::string&, TriggerRequest&);
    bool FromJson(const std::string&, ServiceSpec&);
    bool FromJson(const std::string&, HeartbeatResponse&);
}
