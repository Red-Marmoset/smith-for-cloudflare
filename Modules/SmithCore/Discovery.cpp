// Discovery.cpp - socket-free wire encode/parse for LAN discovery.
//
// Shared by both platform splits (Discovery_Posix.cpp / Discovery_Windows.cpp);
// kept apart from the socket code so it unit-tests without a network.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Discovery.h"

#include <sstream>
#include <vector>

namespace Smith
{
    // Magic + protocol version. Bump the version on any wire-format change so old
    // and new peers ignore each other rather than mis-parsing.
    static const char* kDiscoveryMagic = "SMITH-DISCOVERY/1";

    static std::vector<std::string> SplitWhitespace(const std::string& s)
    {
        std::vector<std::string> out;
        std::istringstream ss(s);
        std::string tok;
        while (ss >> tok) out.push_back(tok);
        return out;
    }

    // Replace any whitespace with '_' so a name never breaks reply tokenizing.
    static std::string SanitizeName(const std::string& name)
    {
        std::string out = name;
        for (char& c : out)
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n') c = '_';
        return out;
    }

    std::string EncodeDiscoveryProbe()
    {
        return std::string(kDiscoveryMagic) + " PROBE";
    }

    bool ParseDiscoveryProbe(const std::string& datagram)
    {
        std::vector<std::string> t = SplitWhitespace(datagram);
        return t.size() >= 2 && t[0] == kDiscoveryMagic && t[1] == "PROBE";
    }

    std::string EncodeDiscoveryReply(int httpPort, const std::string& name)
    {
        std::ostringstream ss;
        ss << kDiscoveryMagic << " OFFER port=" << httpPort;
        if (!name.empty()) ss << " name=" << SanitizeName(name);
        return ss.str();
    }

    bool ParseDiscoveryReply(const std::string& datagram, int& httpPortOut, std::string& nameOut)
    {
        std::vector<std::string> t = SplitWhitespace(datagram);
        if (t.size() < 2 || t[0] != kDiscoveryMagic || t[1] != "OFFER") return false;

        bool havePort = false;
        int port = 0;
        std::string name;
        for (size_t i = 2; i < t.size(); ++i)
        {
            size_t eq = t[i].find('=');
            if (eq == std::string::npos) continue;
            std::string key = t[i].substr(0, eq);
            std::string val = t[i].substr(eq + 1);
            if (key == "port")
            {
                try { port = std::stoi(val); havePort = true; }
                catch (...) { return false; }
            }
            else if (key == "name")
            {
                name = val;
            }
        }
        if (!havePort || port < 1 || port > 65535) return false;
        httpPortOut = port;
        nameOut = name;
        return true;
    }

    std::string BuildCoordinatorUrl(const std::string& senderIp, int httpPort)
    {
        return "http://" + senderIp + ":" + std::to_string(httpPort);
    }
}
