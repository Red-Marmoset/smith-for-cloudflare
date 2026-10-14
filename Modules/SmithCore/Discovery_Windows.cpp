// Discovery_Windows.cpp - Windows (winsock2) UDP implementation of LAN discovery.
// Mirrors Discovery_Posix.cpp exactly; only the socket idioms differ. The shared
// wire codec lives in Discovery.cpp. Links ws2_32 (declared in Module.manifest).
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Discovery.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>      // inet_pton, InetNtopA

#include <atomic>
#include <thread>
#include <mutex>
#include <cstring>

namespace Smith
{
    static const size_t kMaxDatagram = 1024;

    // Initialise winsock once per process. We deliberately never WSACleanup: a
    // one-shot prober must not tear winsock down while a responder thread is still
    // serving, and the OS reclaims it at process exit anyway.
    static void EnsureWinsock()
    {
        static std::once_flag once;
        std::call_once(once, []() {
            WSADATA wsa;
            WSAStartup(MAKEWORD(2, 2), &wsa);
        });
    }

    // winsock SO_RCVTIMEO takes a DWORD of milliseconds (not a struct timeval).
    static void SetRecvTimeout(SOCKET fd, int ms)
    {
        DWORD tv = (DWORD)ms;
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof(tv));
    }

    // ---- Coordinator side: responder ----------------------------------------

    struct DiscoveryResponder::Impl
    {
        SOCKET fd = INVALID_SOCKET;
        std::thread thread;
        std::atomic<bool> stop{ false };
        int httpPort = 0;
        std::string name;
    };

    DiscoveryResponder::DiscoveryResponder() : m_impl(new Impl()) {}
    DiscoveryResponder::~DiscoveryResponder() { Stop(); }

    bool DiscoveryResponder::Start(int discoveryPort, int advertisedHttpPort, const std::string& name)
    {
        EnsureWinsock();

        SOCKET fd = socket(AF_INET, SOCK_DGRAM, 0);
        if (fd == INVALID_SOCKET) return false;

        BOOL yes = TRUE;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, (const char*)&yes, sizeof(yes));

        sockaddr_in addr;
        std::memset(&addr, 0, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_ANY);
        addr.sin_port = htons((u_short)discoveryPort);
        if (bind(fd, (sockaddr*)&addr, sizeof(addr)) == SOCKET_ERROR)
        {
            closesocket(fd);
            return false;
        }

        // Wake the recv loop every 500ms so Stop() is observed promptly.
        SetRecvTimeout(fd, 500);

        m_impl->fd = fd;
        m_impl->httpPort = advertisedHttpPort;
        m_impl->name = name;
        m_impl->stop = false;

        Impl* impl = m_impl.get();
        m_impl->thread = std::thread([impl]() {
            std::string reply = EncodeDiscoveryReply(impl->httpPort, impl->name);
            char buf[kMaxDatagram];
            while (!impl->stop)
            {
                sockaddr_in src;
                int srcLen = (int)sizeof(src);
                int n = recvfrom(impl->fd, buf, (int)sizeof(buf) - 1, 0, (sockaddr*)&src, &srcLen);
                if (n == SOCKET_ERROR)
                {
                    int e = WSAGetLastError();
                    // Timeout (the common case) or interrupted: loop, re-check stop.
                    if (e == WSAETIMEDOUT || e == WSAEWOULDBLOCK || e == WSAEINTR) continue;
                    break;
                }
                buf[n] = '\0';
                if (!ParseDiscoveryProbe(std::string(buf, (size_t)n))) continue;
                // Unicast reply to the exact source. We only answer well-formed
                // probes with a small fixed reply, so this is not a UDP reflector.
                sendto(impl->fd, reply.data(), (int)reply.size(), 0, (sockaddr*)&src, srcLen);
            }
        });
        return true;
    }

    void DiscoveryResponder::Stop()
    {
        if (!m_impl) return;
        m_impl->stop = true;
        if (m_impl->thread.joinable()) m_impl->thread.join();
        if (m_impl->fd != INVALID_SOCKET) { closesocket(m_impl->fd); m_impl->fd = INVALID_SOCKET; }
    }

    // ---- Agent side: prober --------------------------------------------------

    DiscoveryResult DiscoverCoordinatorAt(const std::string& targetIp, int discoveryPort,
                                          int timeoutMs, int attempts)
    {
        DiscoveryResult result;
        EnsureWinsock();

        SOCKET fd = socket(AF_INET, SOCK_DGRAM, 0);
        if (fd == INVALID_SOCKET) return result;

        BOOL yes = TRUE;
        setsockopt(fd, SOL_SOCKET, SO_BROADCAST, (const char*)&yes, sizeof(yes));
        SetRecvTimeout(fd, timeoutMs);

        sockaddr_in dst;
        std::memset(&dst, 0, sizeof(dst));
        dst.sin_family = AF_INET;
        dst.sin_port = htons((u_short)discoveryPort);
        if (inet_pton(AF_INET, targetIp.c_str(), &dst.sin_addr) != 1)
        {
            closesocket(fd);
            return result;
        }

        std::string probe = EncodeDiscoveryProbe();
        char buf[kMaxDatagram];

        for (int attempt = 0; attempt < attempts && !result.found; ++attempt)
        {
            if (sendto(fd, probe.data(), (int)probe.size(), 0, (sockaddr*)&dst, sizeof(dst)) == SOCKET_ERROR)
                continue;

            sockaddr_in src;
            int srcLen = (int)sizeof(src);
            int n = recvfrom(fd, buf, (int)sizeof(buf) - 1, 0, (sockaddr*)&src, &srcLen);
            if (n == SOCKET_ERROR)
            {
                if (WSAGetLastError() == WSAEINTR) { --attempt; continue; }
                continue;   // timeout: try another round
            }
            buf[n] = '\0';

            int httpPort = 0;
            std::string name;
            if (!ParseDiscoveryReply(std::string(buf, (size_t)n), httpPort, name)) continue;

            char ipStr[INET_ADDRSTRLEN] = { 0 };
            InetNtopA(AF_INET, &src.sin_addr, ipStr, sizeof(ipStr));

            result.found = true;
            result.url = BuildCoordinatorUrl(ipStr, httpPort);
            result.name = name;
        }

        closesocket(fd);
        return result;
    }

    DiscoveryResult DiscoverCoordinator(int discoveryPort, int timeoutMs, int attempts)
    {
        // Limited broadcast: stays on the local link, no interface enumeration.
        return DiscoverCoordinatorAt("255.255.255.255", discoveryPort, timeoutMs, attempts);
    }
}
