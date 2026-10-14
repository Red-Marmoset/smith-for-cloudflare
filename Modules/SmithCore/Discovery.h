// Discovery.h - LAN auto-discovery of the coordinator over UDP broadcast.
//
// Zero-config agents need to find the coordinator without being handed a
// --coordinator URL. The coordinator runs a DiscoveryResponder bound to a UDP
// port; agents call DiscoverCoordinator(), which broadcasts a probe and derives
// the coordinator's HTTP URL from the reply's *source IP* plus an advertised
// HTTP port carried in the reply payload. The IP is never taken from the
// payload (only the port and a cosmetic name), so a stray/forged datagram can't
// redirect an agent to an arbitrary host.
//
// All socket code lives in the platform splits Discovery_Posix.cpp /
// Discovery_Windows.cpp (mirrors Process). The wire encode/parse helpers below
// are pure and socket-free, so they unit-test without a network.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>
#include <memory>

namespace Smith
{
    // Default UDP port for discovery probes (HTTP default 9876 + 1).
    static const int kDefaultDiscoveryPort = 9877;

    // ---- Wire encode/parse (pure, no sockets; unit-testable) ----------------

    // The single-line ASCII probe an agent broadcasts. Carries the protocol
    // magic + version so the responder rejects unrelated UDP traffic.
    std::string EncodeDiscoveryProbe();

    // True if 'datagram' is a valid probe for this protocol version.
    bool ParseDiscoveryProbe(const std::string& datagram);

    // The reply a coordinator sends (unicast) advertising its HTTP port and a
    // display name. 'name' is sanitized (whitespace -> '_') so tokenizing the
    // reply stays trivial.
    std::string EncodeDiscoveryReply(int httpPort, const std::string& name);

    // Parse a reply: extract the advertised httpPort and name. Returns false on
    // a malformed line, wrong magic/version, or a missing/out-of-range port.
    // 'nameOut' may be empty even on success.
    bool ParseDiscoveryReply(const std::string& datagram, int& httpPortOut, std::string& nameOut);

    // Build the URL an agent should use, from the reply's source IP + port.
    std::string BuildCoordinatorUrl(const std::string& senderIp, int httpPort);

    // ---- Coordinator side: responder thread ---------------------------------

    class DiscoveryResponder
    {
    public:
        DiscoveryResponder();
        ~DiscoveryResponder();
        DiscoveryResponder(const DiscoveryResponder&) = delete;
        DiscoveryResponder& operator=(const DiscoveryResponder&) = delete;

        // Bind UDP on 0.0.0.0:discoveryPort and serve replies advertising
        // 'advertisedHttpPort' and 'name' on a background thread. Returns false
        // if the socket/bind fails (the caller treats that as non-fatal). Call
        // once; Stop() before destruction.
        bool Start(int discoveryPort, int advertisedHttpPort, const std::string& name);

        // Stop the thread and close the socket. Safe if Start() was never called.
        void Stop();

    private:
        struct Impl;
        std::unique_ptr<Impl> m_impl;
    };

    // ---- Agent side: one-shot prober ----------------------------------------

    struct DiscoveryResult
    {
        bool found = false;
        std::string url;     // e.g. "http://192.168.1.20:9876"
        std::string name;    // advertised coordinator name (may be empty)
    };

    // Broadcast a probe on UDP 'discoveryPort' and wait up to 'timeoutMs' per
    // attempt for a reply, retrying up to 'attempts' rounds. Returns the first
    // valid reply (url derived from the reply's source IP).
    DiscoveryResult DiscoverCoordinator(int discoveryPort, int timeoutMs, int attempts);

    // As DiscoverCoordinator but sends to a specific target IP instead of the
    // limited-broadcast address. Used by tests to exercise the socket path over
    // loopback (127.0.0.1) without requiring broadcast permission.
    DiscoveryResult DiscoverCoordinatorAt(const std::string& targetIp, int discoveryPort,
                                          int timeoutMs, int attempts);
}
