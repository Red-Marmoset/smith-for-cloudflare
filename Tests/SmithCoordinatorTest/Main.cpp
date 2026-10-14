// Main.cpp - SmithCoordinator integration tests. Spins the real coordinator on
// a loopback port and drives it through Http::Client.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include <Test/Test.h>
#include <SmithCoordinator/Coordinator.h>
#include <SmithCore/Config.h>
#include <SmithCore/Uuid.h>
#include <SmithProtocol/WireTypes.h>
#include <SmithProtocol/WireJson.h>
#include <Http/Http.h>

#include <json/single_include/nlohmann/json.hpp>

#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <chrono>
#include <fstream>
#include <filesystem>
#include <set>

using nlohmann::json;
namespace fs = std::filesystem;

namespace Test
{
#define ASSERT_TRUE(cond) \
    do { if (!(cond)) { printf("FAIL: Line %d: '%s' is false\n", __LINE__, #cond); failed++; } else { passed++; } } while (0)
#define ASSERT_EQ_INT(actual, expected) \
    do { long _a = (long)(actual); long _e = (long)(expected); \
         if (_a != _e) { printf("FAIL: Line %d: expected %ld, got %ld\n", __LINE__, _e, _a); failed++; } else { passed++; } } while (0)
#define ASSERT_EQ_STR(actual, expected) \
    do { std::string _a = (actual); std::string _e = (expected); \
         if (_a != _e) { printf("FAIL: Line %d: expected '%s', got '%s'\n", __LINE__, _e.c_str(), _a.c_str()); failed++; } else { passed++; } } while (0)

static std::string TriggerJobId(Http::Client& c)
{
    Http::Result r = c.Post("/api/trigger", "{\"projectId\":\"demo\",\"product\":\"win\",\"branch\":\"main\"}");
    json j = json::parse(r.body, nullptr, false);
    return (!j.is_discarded() && j.is_object()) ? j.value("jobId", std::string()) : std::string();
}

// Run git in `dir`, quietly. Identity + no signing passed inline so the test never
// depends on (or touches) the machine's git config.
static int Git(const fs::path& dir, const std::string& args)
{
    std::string cmd = "git -C \"" + dir.generic_string() + "\" -c user.name=smith-test -c user.email=test@smith.invalid "
                      "-c commit.gpgsign=false -c push.negotiate=false " + args;
    return std::system(cmd.c_str());
}

int TestMain(const CommandLine::Parser& parser)
{
    (void)parser;
    int passed = 0;
    int failed = 0;
    printf("SmithCoordinator integration tests\n\n");

    std::error_code ec;
    fs::path tmp = fs::temp_directory_path(ec) / ("smith-coordtest-" + Smith::MakeShortId());
    fs::create_directories(tmp, ec);
    {
        std::ofstream cfgFile(tmp / "smith.json", std::ios::binary);
        cfgFile << R"JSON({
          "schemaVersion": 1,
          "project": { "id": "demo", "name": "Demo" },
          "repos": [ { "name": "main", "primary": true, "url": "local", "defaultBranch": "main" } ],
          "buildProducts": [ { "name": "win", "rules": [
            { "name": "build", "branches": ["main"], "nodeSelector": { "os": "windows", "labels": ["unity6"] },
              "command": { "windows": { "interpreter": "ps1", "script": "build.ps1", "args": [] } },
              "artifacts": { "globs": ["out.txt"], "package": "none" },
              "handoff": [ { "name": "collect", "type": "collect" } ] } ] },
          { "name": "multi", "rules": [
            { "name": "build", "branches": ["main"], "nodeSelector": { "labels": ["unity6"] },
              "command": { "windows": { "interpreter": "ps1", "script": "b.ps1" }, "mac": { "interpreter": "sh", "script": "b.sh" } },
              "artifacts": { "globs": [], "package": "none" }, "handoff": [] } ] } ]
        })JSON";
    }

    // Make the project dir a git work tree with an origin: main carries the smith.json
    // above, feature/x adds an "exp" product that main doesn't have (yet). The
    // coordinator registers the tree as a local, fetch-only source tracking main.
    bool gitOk = false;
    {
        fs::path origin = tmp / "origin.git";
        fs::create_directories(origin, ec);
        gitOk = Git(origin, "init -q --bare") == 0 &&
                Git(tmp, "init -q -b main") == 0 &&
                Git(tmp, "add smith.json") == 0 &&
                Git(tmp, "commit -q -m base") == 0 &&
                Git(tmp, "remote add origin \"" + origin.generic_string() + "\"") == 0 &&
                Git(tmp, "push -q origin main") == 0 &&
                Git(tmp, "checkout -q -b feature/x") == 0;
        if (gitOk)
        {
            std::ifstream in(tmp / "smith.json", std::ios::binary);
            json j = json::parse(in, nullptr, false);
            in.close();
            j["buildProducts"].push_back(json::parse(R"JSON({ "name": "exp", "rules": [
              { "name": "build-exp", "branches": ["feature/x"], "nodeSelector": { "os": "linux", "labels": ["expnode"] },
                "command": { "linux": { "interpreter": "sh", "script": "exp.sh" } },
                "artifacts": { "globs": [], "package": "none" }, "handoff": [] } ] })JSON"));
            j["triggers"] = json::parse(R"JSON([ { "type": "webhook", "branches": ["feature/x"], "product": "exp" } ])JSON");
            std::ofstream out(tmp / "smith.json", std::ios::binary);
            out << j.dump(2);
        }
        gitOk = gitOk &&
                Git(tmp, "commit -q -am exp") == 0 &&
                Git(tmp, "push -q origin feature/x") == 0 &&
                Git(tmp, "checkout -q main") == 0;   // the work tree is back on main's smith.json
    }
    ASSERT_TRUE(gitOk);

    const int port = 19900;
    Smith::CoordinatorConfig cfg;
    cfg.host = "127.0.0.1";
    cfg.port = port;
    cfg.dataDir = (tmp / "data").string();
    cfg.token = "test-secret";
    cfg.requireTokenAlways = true;   // enforce auth even on loopback for this test
    cfg.jobWaitMs = 400;             // short long-poll so non-matching polls return fast
    cfg.cancelRunningOnNewCommit = true;   // opt-in path exercised below (off in production defaults)
    cfg.projectConfigPaths = { (tmp / "smith.json").string() };
    cfg.discordEnabled = true;
    cfg.discordToken = "discord-test";

    Smith::Coordinator coord(cfg);
    coord.LoadProjects();
    std::thread server([&]() { coord.Start(); });

    std::string base = "http://127.0.0.1:" + std::to_string(port);
    Http::Client authed(base);
    authed.SetBearerToken("test-secret");
    authed.SetTimeoutSeconds(10);

    bool ready = false;
    for (int i = 0; i < 60; ++i)
    {
        Http::Result r = authed.Get("/api/nodes");
        if (r.ok && r.status == 200) { ready = true; break; }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    ASSERT_TRUE(ready);

    if (ready)
    {
        // Auth: missing / wrong token rejected (loopback bypass disabled).
        { Http::Client n(base); ASSERT_EQ_INT(n.Get("/api/nodes").status, 401); }
        { Http::Client w(base); w.SetBearerToken("nope"); ASSERT_EQ_INT(w.Get("/api/nodes").status, 401); }

        // Register a Windows/unity6 node.
        Smith::RegisterRequest rr;
        rr.hostname = "t-win"; rr.os = "windows"; rr.arch = "x64";
        rr.labels = { "unity6" }; rr.agentVersion = "t"; rr.protocolVersion = Smith::kProtocolVersion;
        Http::Result reg = authed.Post("/api/agents/register", Smith::ToJson(rr));
        ASSERT_EQ_INT(reg.status, 200);
        Smith::RegisterResponse rresp;
        ASSERT_TRUE(Smith::FromJson(reg.body, rresp));
        ASSERT_TRUE(rresp.accepted);
        std::string winNode = rresp.nodeId;
        ASSERT_TRUE(!winNode.empty());

        // A normal Python interpreter alone cannot host the Discord bot: the agent
        // also needs Python's venv support so Smith can install its private deps.
        std::string discordStatus;
        for (int i = 0; i < 60; ++i)
        {
            json c = json::parse(authed.Get("/api/config").body, nullptr, false);
            if (c.is_object()) discordStatus = c["discord"].value("status", std::string());
            if (discordStatus == "no agent with Python venv support") break;
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        ASSERT_EQ_STR(discordStatus, "no agent with Python venv support");

        // Placement must prefer a bot-capable agent over a larger GPU that can run
        // Python but cannot create a venv for discord.py + requests.
        Smith::RegisterRequest noVenv;
        noVenv.hostname = "t-no-venv"; noVenv.os = "linux"; noVenv.arch = "x64";
        noVenv.labels = { "ollama", "python3" }; noVenv.agentVersion = "t";
        noVenv.protocolVersion = Smith::kProtocolVersion;
        noVenv.gpuTotalMb = 12000; noVenv.ollamaUp = true;
        Smith::RegisterResponse noVenvResp;
        ASSERT_TRUE(Smith::FromJson(authed.Post("/api/agents/register", Smith::ToJson(noVenv)).body, noVenvResp));
        ASSERT_TRUE(!noVenvResp.nodeId.empty());

        Smith::RegisterRequest botReady = noVenv;
        botReady.hostname = "t-bot-ready";
        botReady.labels.push_back("discord-host");
        botReady.gpuTotalMb = 8000;
        Smith::RegisterResponse botReadyResp;
        ASSERT_TRUE(Smith::FromJson(authed.Post("/api/agents/register", Smith::ToJson(botReady)).body, botReadyResp));
        ASSERT_TRUE(!botReadyResp.nodeId.empty());

        Smith::ServiceSpec botReadyService, noVenvService;
        bool botPlaced = false;
        for (int i = 0; i < 80; ++i)
        {
            Smith::FromJson(authed.Get("/api/agents/" + botReadyResp.nodeId + "/service").body, botReadyService);
            Smith::FromJson(authed.Get("/api/agents/" + noVenvResp.nodeId + "/service").body, noVenvService);
            if (botReadyService.action == "run" && noVenvService.action == "stop") { botPlaced = true; break; }
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        ASSERT_TRUE(botPlaced);

        // /api/nodes lists it.
        ASSERT_TRUE(authed.Get("/api/nodes").body.find("t-win") != std::string::npos);

        // Protocol mismatch is rejected.
        { Smith::RegisterRequest bad = rr; bad.protocolVersion = 999;
          ASSERT_EQ_INT(authed.Post("/api/agents/register", Smith::ToJson(bad)).status, 409); }

        // Trigger -> a matching node receives it; spec is fully resolved.
        std::string jobId = TriggerJobId(authed);
        ASSERT_TRUE(!jobId.empty());
        {
            Http::Result r = authed.Get("/api/jobs/next?nodeId=" + winNode);
            ASSERT_EQ_INT(r.status, 200);
            Smith::JobAssignment asn;
            ASSERT_TRUE(Smith::FromJson(r.body, asn));
            ASSERT_TRUE(asn.hasJob);
            ASSERT_EQ_STR(asn.spec.projectId, "demo");
            ASSERT_EQ_STR(asn.spec.command.script, "build.ps1");
        }

        // Selector matching: a Linux node does NOT receive a Windows job.
        Smith::RegisterRequest lr;
        lr.hostname = "t-linux"; lr.os = "linux"; lr.arch = "x64";
        lr.agentVersion = "t"; lr.protocolVersion = Smith::kProtocolVersion;
        Smith::RegisterResponse lresp;
        Smith::FromJson(authed.Post("/api/agents/register", Smith::ToJson(lr)).body, lresp);
        std::string linNode = lresp.nodeId;
        std::string job2 = TriggerJobId(authed);
        ASSERT_TRUE(!job2.empty());
        {
            Smith::JobAssignment asn;
            Smith::FromJson(authed.Get("/api/jobs/next?nodeId=" + linNode).body, asn);
            ASSERT_TRUE(asn.hasJob == false);     // waited jobWaitMs, no match
        }
        {
            Smith::JobAssignment asn;
            Smith::FromJson(authed.Get("/api/jobs/next?nodeId=" + winNode).body, asn);
            ASSERT_TRUE(asn.hasJob);              // Windows node gets it
        }

        // Log append + read back.
        { Smith::LogChunk ch; ch.seq = 0; ch.stream = "stdout"; ch.lines = { "hello-from-build" };
          ASSERT_EQ_INT(authed.Post("/api/jobs/" + jobId + "/log", Smith::ToJson(ch)).status, 204); }
        ASSERT_TRUE(authed.Get("/api/builds/" + jobId + "/log").body.find("hello-from-build") != std::string::npos);

        // --- ?tail=N serves only the last N lines. The UI keeps a bounded window,
        //     so shipping a multi-MB log to render 5000 lines of it is pure waste.
        //     The full log stays the default: `smith logs` and "Download full log"
        //     depend on it. ---
        {
            Smith::LogChunk bulk; bulk.seq = 1; bulk.stream = "stdout";
            for (int i = 2; i <= 200; ++i) bulk.lines.push_back("line-" + std::to_string(i));
            ASSERT_EQ_INT(authed.Post("/api/jobs/" + jobId + "/log", Smith::ToJson(bulk)).status, 204);

            Http::Result full = authed.Get("/api/builds/" + jobId + "/log");
            ASSERT_TRUE(full.body.find("hello-from-build") != std::string::npos);   // no tail -> everything
            ASSERT_TRUE(full.body.find("line-200") != std::string::npos);

            // 200 lines total: tail=10 keeps 191..200 and nothing before them.
            // (The matching X-Log-Skipped-Lines header is what the browser reads to
            // re-base diagnostics line numbers; Http::Result carries no headers, so
            // that half is covered by the UI rather than here.)
            Http::Result tail = authed.Get("/api/builds/" + jobId + "/log?tail=10");
            ASSERT_TRUE(tail.body.find("line-200") != std::string::npos);           // newest kept
            ASSERT_TRUE(tail.body.find("line-191") != std::string::npos);           // exactly 10 back
            ASSERT_TRUE(tail.body.find("line-190") == std::string::npos);           // older dropped
            ASSERT_TRUE(tail.body.find("hello-from-build") == std::string::npos);

            // A tail larger than the log is simply the whole log.
            Http::Result all = authed.Get("/api/builds/" + jobId + "/log?tail=100000");
            ASSERT_TRUE(all.body.find("hello-from-build") != std::string::npos);
            ASSERT_TRUE(all.body.find("line-200") != std::string::npos);
        }

        // Result finalizes the record.
        { Smith::JobResult jr; jr.status = "success"; jr.exitCode = 0; jr.durationMs = 10;
          ASSERT_EQ_INT(authed.Post("/api/jobs/" + jobId + "/result", Smith::ToJson(jr)).status, 204); }
        {
            json b = json::parse(authed.Get("/api/builds/" + jobId).body, nullptr, false);
            ASSERT_TRUE(b.is_object());
            ASSERT_EQ_STR(b.value("status", std::string()), "success");
        }

        // --- An agent that restarts mid-build re-registers under a new node id. Its
        //     in-flight build can never report back, so it must settle as "lost"
        //     rather than sit "running" forever. ---
        {
            Smith::RegisterRequest rq;
            rq.hostname = "t-win-restart"; rq.os = "windows"; rq.arch = "x64";
            rq.labels = { "unity6" }; rq.agentVersion = "t"; rq.protocolVersion = Smith::kProtocolVersion;
            Smith::RegisterResponse first;
            ASSERT_TRUE(Smith::FromJson(authed.Post("/api/agents/register", Smith::ToJson(rq)).body, first));
            std::string orphan = TriggerJobId(authed);
            ASSERT_TRUE(!orphan.empty());
            Smith::JobAssignment asn;
            Smith::FromJson(authed.Get("/api/jobs/next?nodeId=" + first.nodeId).body, asn);
            ASSERT_TRUE(asn.hasJob);
            ASSERT_EQ_STR(asn.spec.jobId, orphan);

            Smith::RegisterResponse second;   // same host + os: the restarted agent
            ASSERT_TRUE(Smith::FromJson(authed.Post("/api/agents/register", Smith::ToJson(rq)).body, second));
            ASSERT_TRUE(second.nodeId != first.nodeId);

            json b = json::parse(authed.Get("/api/builds/" + orphan).body, nullptr, false);
            ASSERT_TRUE(b.is_object());
            ASSERT_EQ_STR(b.value("status", std::string()), "lost");
            ASSERT_TRUE(authed.Get("/api/builds/" + orphan + "/log").body.find("agent restarted") != std::string::npos);
        }

        // SSE replay of a finished build returns the log + a done event.
        {
            Http::Result r = authed.Get("/api/builds/" + jobId + "/stream");
            ASSERT_TRUE(r.body.find("hello-from-build") != std::string::npos);
            ASSERT_TRUE(r.body.find("event: done") != std::string::npos);
        }

        // --- ?limit=N on a project's builds, and /api/overview: the dashboard and the
        //     projects page render a bounded slice, so they must be able to ask for
        //     one instead of pulling every record. Unlimited stays the default. ---
        {
            json all = json::parse(authed.Get("/api/projects/demo/builds").body, nullptr, false);
            ASSERT_TRUE(all.is_array());
            size_t total = all.size();
            ASSERT_TRUE(total >= 2);   // at least the two builds triggered above

            json capped = json::parse(authed.Get("/api/projects/demo/builds?limit=1").body, nullptr, false);
            ASSERT_TRUE(capped.is_array() && capped.size() == 1);
            // Newest-first ordering survives the cap: limit=1 is the same record as all[0].
            ASSERT_EQ_STR(capped[0].value("jobId", std::string()), all[0].value("jobId", std::string()));

            json over = json::parse(authed.Get("/api/projects/demo/builds?limit=10000").body, nullptr, false);
            ASSERT_TRUE(over.is_array() && over.size() == total);

            json ov = json::parse(authed.Get("/api/overview?since=0").body, nullptr, false);
            ASSERT_TRUE(ov.is_object());
            ASSERT_TRUE(ov.value("nodes", -1) >= 1);              // the registered node(s)
            ASSERT_EQ_INT(ov.value("projects", -1), 1);           // the one demo project
            ASSERT_TRUE(ov["recent"].is_array() && ov["recent"].size() <= 10);
            // since=0 counts nothing (a build's createdAt is never 0); a past
            // timestamp counts every build there is.
            ASSERT_EQ_INT(ov.value("buildsSince", -1), 0);
            json ov2 = json::parse(authed.Get("/api/overview?since=1").body, nullptr, false);
            ASSERT_EQ_INT(ov2.value("buildsSince", -1), (int)total);
        }

        // --- Build target routing (#34): a build pinned to targetOs=mac must reach a mac
        //     node and never the windows node, even though both carry the unity6 label. ---
        Smith::RegisterRequest mr;
        mr.hostname = "t-mac"; mr.os = "mac"; mr.arch = "arm64";
        mr.labels = { "unity6" }; mr.agentVersion = "t"; mr.protocolVersion = Smith::kProtocolVersion;
        Smith::RegisterResponse mresp;
        Smith::FromJson(authed.Post("/api/agents/register", Smith::ToJson(mr)).body, mresp);
        std::string macNode = mresp.nodeId;
        ASSERT_TRUE(!macNode.empty());

        Smith::TriggerRequest tr;
        tr.projectId = "demo"; tr.product = "multi"; tr.branch = "main"; tr.targetOs = "mac";
        std::string macJob = json::parse(authed.Post("/api/trigger", Smith::ToJson(tr)).body, nullptr, false).value("jobId", std::string());
        ASSERT_TRUE(!macJob.empty());
        { Smith::JobAssignment asn; Smith::FromJson(authed.Get("/api/jobs/next?nodeId=" + winNode).body, asn);
          ASSERT_TRUE(asn.hasJob == false); }                 // windows node must NOT get the mac-pinned build
        { Smith::JobAssignment asn; Smith::FromJson(authed.Get("/api/jobs/next?nodeId=" + macNode).body, asn);
          ASSERT_TRUE(asn.hasJob);                            // mac node gets it...
          ASSERT_EQ_STR(asn.spec.command.script, "b.sh"); }   // ...and runs the mac command

        // --- Autobuild rule CRUD (#36): create -> list -> delete via the HTTP API. ---
        {
            Http::Result cr = authed.Post("/api/projects/demo/autobuilds",
                                          "{\"branch\":\"main\",\"product\":\"multi\",\"intervalSeconds\":30,\"targetOs\":\"mac\"}");
            ASSERT_EQ_INT(cr.status, 200);
            json rule = json::parse(cr.body, nullptr, false);
            std::string ruleId = rule.value("id", std::string());
            ASSERT_TRUE(!ruleId.empty());
            ASSERT_EQ_STR(rule.value("targetOs", std::string()), "mac");
            ASSERT_EQ_INT(rule.value("intervalSeconds", 0), 30);

            json list = json::parse(authed.Get("/api/projects/demo/autobuilds").body, nullptr, false);
            ASSERT_TRUE(list.is_array() && list.size() == 1);

            ASSERT_EQ_INT(authed.Post("/api/autobuilds/" + ruleId + "/delete", "").status, 200);
            json empty = json::parse(authed.Get("/api/projects/demo/autobuilds").body, nullptr, false);
            ASSERT_TRUE(empty.is_array() && empty.size() == 0);
        }

        // --- Commit-driven coalescing: a burst of autobuild commits leaves only the
        //     newest build queued; the earlier ones are superseded, not run. ---
        auto statusOf = [&](const std::string& id) {
            json b = json::parse(authed.Get("/api/builds/" + id).body, nullptr, false);
            return b.is_object() ? b.value("status", std::string()) : std::string();
        };
        {
            std::string a1 = coord.EnqueueBuild("demo", "win", "main", "c1", "autobuild");
            std::string a2 = coord.EnqueueBuild("demo", "win", "main", "c2", "autobuild");
            std::string a3 = coord.EnqueueBuild("demo", "win", "main", "c3", "autobuild");
            ASSERT_TRUE(!a1.empty() && !a2.empty() && !a3.empty());
            ASSERT_EQ_STR(statusOf(a1), "superseded");
            ASSERT_EQ_STR(statusOf(a2), "superseded");
            ASSERT_EQ_STR(statusOf(a3), "queued");

            // A manual build is never collapsed by an autobuild, and a manual enqueue
            // never supersedes queued autobuilds - coalescing is autobuild-only.
            std::string man = coord.EnqueueBuild("demo", "win", "main", "cm", "manual");
            std::string a4 = coord.EnqueueBuild("demo", "win", "main", "c4", "autobuild");
            ASSERT_EQ_STR(statusOf(man), "queued");        // manual survives the a4 autobuild
            ASSERT_EQ_STR(statusOf(a3), "superseded");     // a3 (autobuild) yields to a4
            ASSERT_EQ_STR(statusOf(a4), "queued");

            // The superseded builds are gone from the queue: the node claims the two
            // survivors (order-independent) and nothing else.
            std::set<std::string> claimed;
            for (int i = 0; i < 2; ++i)
            {
                Smith::JobAssignment asn;
                Smith::FromJson(authed.Get("/api/jobs/next?nodeId=" + winNode).body, asn);
                ASSERT_TRUE(asn.hasJob);
                claimed.insert(asn.spec.jobId);
                Smith::JobResult jr; jr.status = "success"; jr.exitCode = 0; jr.durationMs = 1;
                authed.Post("/api/jobs/" + asn.spec.jobId + "/result", Smith::ToJson(jr));
            }
            ASSERT_TRUE(claimed.count(man) == 1 && claimed.count(a4) == 1);
            { Smith::JobAssignment asn; Smith::FromJson(authed.Get("/api/jobs/next?nodeId=" + winNode).body, asn);
              ASSERT_TRUE(asn.hasJob == false); }          // queue drained: only the 2 survivors ran
        }

        // --- Coalescing spans the commit-driven triggers: poll, autobuild and webhook
        //     all mean "build this branch's tip", so the newest one wins whichever
        //     fired it. A different target (here: platform pin) is untouched. ---
        {
            std::string p1 = coord.EnqueueBuild("demo", "win", "main", "d1", "poll");
            std::string w1 = coord.EnqueueBuild("demo", "win", "main", "d2", "webhook");
            std::string other = coord.EnqueueBuild("demo", "win", "main", "d2", "poll", "", "windows");
            std::string a1 = coord.EnqueueBuild("demo", "win", "main", "d3", "autobuild");
            ASSERT_EQ_STR(statusOf(p1), "superseded");   // poll build yields to the webhook
            ASSERT_EQ_STR(statusOf(w1), "superseded");   // webhook build yields to the autobuild
            ASSERT_EQ_STR(statusOf(a1), "queued");
            ASSERT_EQ_STR(statusOf(other), "queued");    // targetOs pin = a different target

            // Drain: only the two survivors are dispatched.
            for (int i = 0; i < 2; ++i)
            {
                Smith::JobAssignment asn;
                Smith::FromJson(authed.Get("/api/jobs/next?nodeId=" + winNode).body, asn);
                ASSERT_TRUE(asn.hasJob);
                Smith::JobResult jr; jr.status = "success"; jr.exitCode = 0; jr.durationMs = 1;
                authed.Post("/api/jobs/" + asn.spec.jobId + "/result", Smith::ToJson(jr));
            }
            { Smith::JobAssignment asn; Smith::FromJson(authed.Get("/api/jobs/next?nodeId=" + winNode).body, asn);
              ASSERT_TRUE(asn.hasJob == false); }
        }

        // --- cancelRunningOnNewCommit: the build already on an agent is abandoned for
        //     the newer commit. The agent learns of it from its next log post and the
        //     record settles as "superseded", not "cancelled". ---
        {
            std::string running = coord.EnqueueBuild("demo", "win", "main", "e1", "autobuild");
            Smith::JobAssignment asn;
            Smith::FromJson(authed.Get("/api/jobs/next?nodeId=" + winNode).body, asn);
            ASSERT_TRUE(asn.hasJob);
            ASSERT_EQ_STR(asn.spec.jobId, running);
            ASSERT_EQ_STR(statusOf(running), "running");

            std::string newer = coord.EnqueueBuild("demo", "win", "main", "e2", "autobuild");
            ASSERT_EQ_STR(statusOf(newer), "queued");
            ASSERT_EQ_STR(statusOf(running), "running");   // still running until the agent reports back

            // The agent's next log post carries the cancel signal.
            Smith::LogChunk ch; ch.seq = 0; ch.stream = "stdout"; ch.lines = { "working…" };
            Http::Result lr = authed.Post("/api/jobs/" + running + "/log", Smith::ToJson(ch));
            ASSERT_TRUE(lr.body.find("\"cancel\":true") != std::string::npos);

            // The agent kills the build and reports "cancelled"; Smith records the reason.
            Smith::JobResult jr; jr.status = "cancelled"; jr.exitCode = 1; jr.durationMs = 5;
            ASSERT_EQ_INT(authed.Post("/api/jobs/" + running + "/result", Smith::ToJson(jr)).status, 204);
            ASSERT_EQ_STR(statusOf(running), "superseded");

            // A hand-cancelled build still reads as "cancelled" - only Smith's own
            // supersede rewrites the status.
            Smith::JobAssignment n2;
            Smith::FromJson(authed.Get("/api/jobs/next?nodeId=" + winNode).body, n2);
            ASSERT_TRUE(n2.hasJob);
            ASSERT_EQ_STR(n2.spec.jobId, newer);
            ASSERT_EQ_INT(authed.Post("/api/builds/" + newer + "/cancel", "").status, 200);
            Smith::JobResult jr2; jr2.status = "cancelled"; jr2.exitCode = 1; jr2.durationMs = 5;
            authed.Post("/api/jobs/" + newer + "/result", Smith::ToJson(jr2));
            ASSERT_EQ_STR(statusOf(newer), "cancelled");
        }

        // --- Branch smith.json overlays: feature/x builds a product only its own smith.json
        //     declares, without merging it and without moving the project def off main. ---
        if (gitOk)
        {
            auto productNames = [](const json& arr) {
                std::set<std::string> s;
                if (arr.is_array()) for (const auto& p : arr) s.insert(p.value("name", std::string()));
                return s;
            };
            json fx = json::parse(authed.Get("/api/projects/demo/branch-products?branch=feature/x").body, nullptr, false);
            ASSERT_EQ_STR(fx.value("source", std::string()), "branch");
            ASSERT_TRUE(!fx.contains("error"));
            std::set<std::string> fxNames = productNames(fx["products"]);
            ASSERT_TRUE(fxNames.count("exp") == 1);
            ASSERT_TRUE(fxNames.count("win") == 0);   // win's rule is main-only: not offered for feature/x

            json mainP = json::parse(authed.Get("/api/projects/demo/branch-products?branch=main").body, nullptr, false);
            std::set<std::string> mainNames = productNames(mainP["products"]);
            ASSERT_TRUE(mainNames.count("win") == 1 && mainNames.count("exp") == 0);

            json missing = json::parse(authed.Get("/api/projects/demo/branch-products?branch=no-such-branch").body, nullptr, false);
            ASSERT_TRUE(missing.contains("error"));
            ASSERT_EQ_STR(missing.value("source", std::string()), "project");

            // An autobuild for the branch-only product validates against the branch...
            Http::Result ab = authed.Post("/api/projects/demo/autobuilds", "{\"branch\":\"feature/x\",\"product\":\"exp\"}");
            ASSERT_EQ_INT(ab.status, 200);
            std::string abId = json::parse(ab.body, nullptr, false).value("id", std::string());
            ASSERT_EQ_INT(authed.Post("/api/autobuilds/" + abId + "/delete", "").status, 200);
            // ...and is refused where no rule builds it.
            ASSERT_EQ_INT(authed.Post("/api/projects/demo/autobuilds", "{\"branch\":\"main\",\"product\":\"exp\"}").status, 400);

            // A build of it dispatches with the branch's rule.
            Smith::RegisterRequest lr;
            lr.hostname = "t-linux"; lr.os = "linux"; lr.arch = "x64";
            lr.labels = { "expnode" }; lr.agentVersion = "t"; lr.protocolVersion = Smith::kProtocolVersion;
            Smith::RegisterResponse lresp;
            Smith::FromJson(authed.Post("/api/agents/register", Smith::ToJson(lr)).body, lresp);
            ASSERT_TRUE(!lresp.nodeId.empty());
            Smith::TriggerRequest et;
            et.projectId = "demo"; et.product = "exp"; et.branch = "feature/x";
            std::string expJob = json::parse(authed.Post("/api/trigger", Smith::ToJson(et)).body, nullptr, false).value("jobId", std::string());
            ASSERT_TRUE(!expJob.empty());
            Smith::JobAssignment ea;
            Smith::FromJson(authed.Get("/api/jobs/next?nodeId=" + lresp.nodeId).body, ea);
            ASSERT_TRUE(ea.hasJob);
            ASSERT_EQ_STR(ea.spec.jobId, expJob);
            ASSERT_EQ_STR(ea.spec.command.script, "exp.sh");

            // A push webhook naming no product builds what the branch's own webhook trigger says.
            Http::Client anon(base);
            json wh = json::parse(anon.Post("/api/webhook/git/demo", "{\"ref\":\"refs/heads/feature/x\"}").body, nullptr, false);
            ASSERT_TRUE(wh.value("enqueued", false));
            json whBuild = json::parse(authed.Get("/api/builds/" + wh.value("jobId", std::string())).body, nullptr, false);
            ASSERT_EQ_STR(whBuild.value("product", std::string()), "exp");

            // The project def (main's smith.json) is untouched: no "exp" in /api/projects.
            json projects = json::parse(authed.Get("/api/projects").body, nullptr, false);
            bool expListed = false;
            if (projects.is_array())
                for (const auto& p : projects)
                    if (p.value("id", std::string()) == "demo") expListed = productNames(p["products"]).count("exp") > 0;
            ASSERT_TRUE(!expListed);
        }
    }

    coord.Stop();
    if (server.joinable()) server.join();
    fs::remove_all(tmp, ec);

    printf("\nTest Results: %d Passed, %d Failed\n", passed, failed);
    return failed > 0 ? 1 : 0;
}

} // namespace Test
