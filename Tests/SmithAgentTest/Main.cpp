// Main.cpp - SmithAgent integration tests.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include <Test/Test.h>
#include <SmithAgent/Agent.h>
#include <SmithCore/Config.h>
#include <Http/Http.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <thread>

namespace fs = std::filesystem;

namespace Test
{
#define ASSERT_TRUE(cond) \
    do { if (!(cond)) { printf("FAIL: Line %d: '%s' is false\n", __LINE__, #cond); failed++; } else { passed++; } } while (0)

int TestMain(const CommandLine::Parser& parser)
{
    (void)parser;
    int passed = 0;
    int failed = 0;
    printf("SmithAgent integration tests\n\n");

    const int port = 19901;
    const std::string base = "http://127.0.0.1:" + std::to_string(port);
    std::atomic<int> heartbeatCount{ 0 };
    std::atomic<bool> serviceEntered{ false };

    Http::Server server;
    server.Post("/api/agents/register", [&](const Http::Request&, Http::Response& res) {
        res.Json("{\"accepted\":true,\"nodeId\":\"agent-test\",\"heartbeatIntervalSec\":1,\"protocolVersion\":1,\"message\":\"\"}");
    });
    server.Post("/api/agents/:nodeId/heartbeat", [&](const Http::Request&, Http::Response& res) {
        ++heartbeatCount;
        res.Json("{\"steamGuard\":{\"requestId\":\"\",\"credentialRef\":\"\",\"code\":\"\"}}");
    });
    server.Get("/api/agents/:nodeId/service", [&](const Http::Request&, Http::Response& res) {
        serviceEntered = true;
        std::this_thread::sleep_for(std::chrono::seconds(8));
        res.Json("{\"action\":\"stop\",\"name\":\"discord-bot\",\"specHash\":\"\",\"env\":{}}");
    });
    server.Get("/api/jobs/next", [&](const Http::Request&, Http::Response& res) {
        res.Json("{\"hasJob\":false,\"jobId\":\"\",\"spec\":{}}");
    });

    std::thread serverThread([&]() { server.Listen("127.0.0.1", port); });
    for (int i = 0; i < 100 && !server.IsRunning(); ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    ASSERT_TRUE(server.IsRunning());

    std::error_code ec;
    fs::path workspace = fs::temp_directory_path(ec) / "smith-agent-heartbeat-test";
    fs::remove_all(workspace, ec);
    Smith::AgentConfig cfg;
    cfg.coordinatorUrl = base;
    cfg.name = "agent-heartbeat-test";
    cfg.os = "windows";
    cfg.arch = "x64";
    cfg.workspace = workspace.string();
    cfg.pollIntervalMs = 100;
    cfg.heartbeatSec = 1;
    cfg.discover = false;

    Smith::Agent agent(cfg);
    std::thread agentThread([&]() { agent.Run(); });

    for (int i = 0; i < 400 && !serviceEntered; ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    ASSERT_TRUE(serviceEntered);
    std::this_thread::sleep_for(std::chrono::seconds(5));

    // A slow service response must not prevent the agent's regular liveness beats.
    // Before service polling was separated, this was still 1 because the sole
    // heartbeat thread was blocked in the eight-second /service request.
    ASSERT_TRUE(heartbeatCount >= 2);

    agent.Stop();
    agentThread.join();
    server.Stop();
    serverThread.join();
    fs::remove_all(workspace, ec);

    printf("\nTest Results: %d Passed, %d Failed\n", passed, failed);
    return failed;
}

} // namespace Test
