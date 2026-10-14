// Main.cpp - SmithCore LAN discovery tests: the pure wire encode/parse layer
// plus a best-effort loopback round-trip over real UDP sockets. Follows the
// engine JsonTest / SmithCoreTest pattern.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include <Test/Test.h>
#include <SmithCore/Discovery.h>

#include <cstdio>
#include <string>
#include <thread>
#include <chrono>

namespace Test
{

#define ASSERT_TRUE(cond) \
    do { if (!(cond)) { printf("FAIL: Line %d: '%s' is false\n", __LINE__, #cond); failed++; } else { passed++; } } while (0)

#define ASSERT_EQ_INT(actual, expected) \
    do { long _a = (long)(actual); long _e = (long)(expected); \
         if (_a != _e) { printf("FAIL: Line %d: expected %ld, got %ld\n", __LINE__, _e, _a); failed++; } \
         else { passed++; } } while (0)

#define ASSERT_EQ_STR(actual, expected) \
    do { std::string _a = (actual); std::string _e = (expected); \
         if (_a != _e) { printf("FAIL: Line %d: expected '%s', got '%s'\n", __LINE__, _e.c_str(), _a.c_str()); failed++; } \
         else { passed++; } } while (0)

int TestMain(const CommandLine::Parser& parser)
{
    (void)parser;
    int passed = 0;
    int failed = 0;

    printf("SmithCore discovery tests\n\n");

    // ---- Tier 1: pure wire encode/parse (no sockets) ----
    {
        // Probe round-trip + rejection of garbage / wrong version.
        ASSERT_TRUE(Smith::ParseDiscoveryProbe(Smith::EncodeDiscoveryProbe()));
        ASSERT_TRUE(Smith::ParseDiscoveryProbe("GARBAGE") == false);
        ASSERT_TRUE(Smith::ParseDiscoveryProbe("SMITH-DISCOVERY/2 PROBE") == false);

        // Reply round-trip: port + name survive.
        int port = 0;
        std::string name;
        ASSERT_TRUE(Smith::ParseDiscoveryReply(Smith::EncodeDiscoveryReply(9876, "build-box"), port, name));
        ASSERT_EQ_INT(port, 9876);
        ASSERT_EQ_STR(name, "build-box");

        // A name with whitespace is sanitized so tokenizing still works.
        ASSERT_TRUE(Smith::ParseDiscoveryReply(Smith::EncodeDiscoveryReply(9876, "my box"), port, name));
        ASSERT_EQ_STR(name, "my_box");

        // A reply with no name is still valid; port is parsed.
        port = 0; name = "leftover";
        ASSERT_TRUE(Smith::ParseDiscoveryReply(Smith::EncodeDiscoveryReply(8000, ""), port, name));
        ASSERT_EQ_INT(port, 8000);
        ASSERT_EQ_STR(name, "");

        // Rejections: missing port, out-of-range port, a probe parsed as a reply.
        ASSERT_TRUE(Smith::ParseDiscoveryReply("SMITH-DISCOVERY/1 OFFER name=z", port, name) == false);
        ASSERT_TRUE(Smith::ParseDiscoveryReply("SMITH-DISCOVERY/1 OFFER port=70000", port, name) == false);
        ASSERT_TRUE(Smith::ParseDiscoveryReply("SMITH-DISCOVERY/1 OFFER port=0", port, name) == false);
        ASSERT_TRUE(Smith::ParseDiscoveryReply(Smith::EncodeDiscoveryProbe(), port, name) == false);

        // URL is built from the (trusted) sender IP + advertised port.
        ASSERT_EQ_STR(Smith::BuildCoordinatorUrl("192.168.1.20", 9876), "http://192.168.1.20:9876");
    }

    // ---- Tier 2: loopback round-trip over real sockets (best-effort) ----
    {
        const int testPort = 19877;
        Smith::DiscoveryResponder resp;
        if (resp.Start(testPort, 9876, "loop-coord"))
        {
            // Give the responder thread a moment to enter its recv loop.
            std::this_thread::sleep_for(std::chrono::milliseconds(100));

            Smith::DiscoveryResult r = Smith::DiscoverCoordinatorAt("127.0.0.1", testPort, 800, 5);
            ASSERT_TRUE(r.found);
            ASSERT_EQ_STR(r.url, "http://127.0.0.1:9876");
            ASSERT_EQ_STR(r.name, "loop-coord");

            resp.Stop();

            // After Stop() nobody answers; the prober should time out cleanly.
            Smith::DiscoveryResult r2 = Smith::DiscoverCoordinatorAt("127.0.0.1", testPort, 300, 2);
            ASSERT_TRUE(r2.found == false);
        }
        else
        {
            printf("SKIP: discovery responder could not bind udp/%d "
                   "(restricted environment or Windows stub)\n", testPort);
        }
    }

    printf("\nTest Results: %d Passed, %d Failed\n", passed, failed);
    return failed > 0 ? 1 : 0;
}

} // namespace Test
