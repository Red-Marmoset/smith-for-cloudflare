// CloudflareDns.h - pure helpers for the coordinator's optional dynamic-DNS updater.
// Parsing/validation only (no network); the curl orchestration lives in
// SmithCoordinator/CoordinatorDns.cpp. Pure so it is unit-testable with canned JSON.
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>

namespace Smith
{
    std::string TrimWhitespace(const std::string& s);
    bool IsIpv4(const std::string& s);                         // exactly four dotted octets 0-255

    // First .result[].id from a Cloudflare list response (e.g. zones?name= ). False if
    // the response isn't a success object with a non-empty result array.
    bool ParseCloudflareFirstId(const std::string& body, std::string& idOut);

    // First record's {id, content(=current IP)} from a dns_records list response.
    bool ParseCloudflareRecord(const std::string& body, std::string& idOut, std::string& ipOut);

    // JSON body to PUT when pointing an A record at a new IP.
    std::string CloudflareUpdateBody(const std::string& record, const std::string& ip, bool proxied);

    bool CloudflareSucceeded(const std::string& body);         // .success == true
}
