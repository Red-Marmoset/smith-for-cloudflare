// Discovery_Posix.cpp - POSIX (Linux/macOS) UDP implementation of LAN discovery.
// Not compiled on Windows (see Discovery_Windows.cpp for the winsock variant).
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Discovery.h"

#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>
#include <cstring>
#include <cerrno>
#include <atomic>
#include <thread>

namespace Smith
{
    static const size_t kMaxDatagram = 1024;

    // Set a receive timeout so a blocking recvfrom wakes periodically (responder
    // shutdown) or bounds an agent's wait (prober).
    static void SetRecvTimeout(int fd, int ms)
    {
        struct timeval tv;
        tv.tv_sec = ms / 1000;
        tv.tv_usec = (ms % 1000) * 1000;
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    }

    // ---- Coordinator side: responder ----------------------------------------

    struct DiscoveryResponder::Impl
    {
        int fd = -1;
        std::thread thread;
        std::atomic<bool> stop{ false };
        int httpPort = 0;
        std::string name;
    };

    DiscoveryResponder::DiscoveryResponder() : m_impl(new Impl()) {}
    DiscoveryResponder::~DiscoveryResponder() { Stop(); }

    bool DiscoveryResponder::Start(int discoveryPort, int advertisedHttpPort, const std::string& name)
    {
        int fd = socket(AF_INET, SOCK_DGRAM, 0);
        if (fd < 0) return false;

        int yes = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

        sockaddr_in addr;
        std::memset(&addr, 0, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_ANY);
        addr.sin_port = htons((uint16_t)discoveryPort);
        if (bind(fd, (sockaddr*)&addr, sizeof(addr)) < 0)
        {
            close(fd);
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
                socklen_t srcLen = sizeof(src);
                ssize_t n = recvfrom(impl->fd, buf, sizeof(buf) - 1, 0, (sockaddr*)&src, &srcLen);
                if (n < 0)
                {
                    // Timeout (the common case) or interrupted: loop and re-check stop.
                    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) continue;
                    break;
                }
                buf[n] = '\0';
                if (!ParseDiscoveryProbe(std::string(buf, (size_t)n))) continue;
                // Reply (unicast) to the exact source. The reply is small and
                // fixed, and we only answer well-formed probes, so this can't be
                // turned into a UDP reflector.
                sendto(impl->fd, reply.data(), reply.size(), 0, (sockaddr*)&src, srcLen);
            }
        });
        return true;
    }

    void DiscoveryResponder::Stop()
    {
        if (!m_impl) return;
        m_impl->stop = true;
        if (m_impl->thread.joinable()) m_impl->thread.join();
        if (m_impl->fd >= 0) { close(m_impl->fd); m_impl->fd = -1; }
    }

    // ---- Agent side: prober --------------------------------------------------

    DiscoveryResult DiscoverCoordinatorAt(const std::string& targetIp, int discoveryPort,
                                          int timeoutMs, int attempts)
    {
        DiscoveryResult result;

        int fd = socket(AF_INET, SOCK_DGRAM, 0);
        if (fd < 0) return result;

        int yes = 1;
        setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &yes, sizeof(yes));
        SetRecvTimeout(fd, timeoutMs);

        sockaddr_in dst;
        std::memset(&dst, 0, sizeof(dst));
        dst.sin_family = AF_INET;
        dst.sin_port = htons((uint16_t)discoveryPort);
        if (inet_pton(AF_INET, targetIp.c_str(), &dst.sin_addr) != 1)
        {
            close(fd);
            return result;
        }

        std::string probe = EncodeDiscoveryProbe();
        char buf[kMaxDatagram];

        for (int attempt = 0; attempt < attempts && !result.found; ++attempt)
        {
            if (sendto(fd, probe.data(), probe.size(), 0, (sockaddr*)&dst, sizeof(dst)) < 0)
                continue;

            sockaddr_in src;
            socklen_t srcLen = sizeof(src);
            ssize_t n = recvfrom(fd, buf, sizeof(buf) - 1, 0, (sockaddr*)&src, &srcLen);
            if (n < 0)
            {
                if (errno == EINTR) { --attempt; continue; }
                continue; // timeout: try another round
            }
            buf[n] = '\0';

            int httpPort = 0;
            std::string name;
            if (!ParseDiscoveryReply(std::string(buf, (size_t)n), httpPort, name)) continue;

            char ipStr[INET_ADDRSTRLEN] = { 0 };
            inet_ntop(AF_INET, &src.sin_addr, ipStr, sizeof(ipStr));

            result.found = true;
            result.url = BuildCoordinatorUrl(ipStr, httpPort);
            result.name = name;
        }

        close(fd);
        return result;
    }

    DiscoveryResult DiscoverCoordinator(int discoveryPort, int timeoutMs, int attempts)
    {
        // Limited broadcast: stays on the local link, no interface enumeration.
        return DiscoverCoordinatorAt("255.255.255.255", discoveryPort, timeoutMs, attempts);
    }
}
