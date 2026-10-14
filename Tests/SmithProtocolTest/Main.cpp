// Main.cpp - SmithProtocol wire JSON round-trip tests.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include <Test/Test.h>
#include <SmithProtocol/WireTypes.h>
#include <SmithProtocol/WireJson.h>

#include <cstdio>
#include <string>

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

    printf("SmithProtocol - wire JSON round-trip tests\n\n");

    // 1. Full JobSpec round-trip (the richest type).
    {
        Smith::JobSpec a;
        a.jobId = "job-123";
        a.projectId = "soccer-boy";
        a.buildNumber = 42;
        Smith::RepoCheckout repo;
        repo.name = "main";
        repo.url = "git@github.com:Red-Marmoset/soccer-boy.git";
        repo.branch = "main";
        repo.commit = "";
        repo.checkoutDir = ".";
        a.repos.push_back(repo);
        a.command.interpreter = "ps1";
        a.command.script = "tools/smith-build.ps1";
        a.command.args = { "-Target", "StandaloneWindows64" };
        a.workingDir = ".";
        a.env["SMITH_BUILD"] = "1";
        a.env["TARGET_ENV"] = "steam";
        a.timeoutSeconds = 3600;
        a.successExitCodes = { 0 };
        a.artifacts.globs = { "builds/standalonewindows64/**" };
        a.artifacts.package = "zip";
        a.artifacts.archiveName = "soccer-boy-windows-42.zip";
        Smith::HandoffStep step;
        step.name = "collect-on-coordinator";
        step.type = "collect";
        step.fields["note"] = "baseline";
        step.continueOnError = false;
        a.handoff.push_back(step);
        Smith::ArtifactInput in;
        in.jobId = "job-100";
        in.archiveName = "steam-mac.zip";
        in.product = "unity";
        in.variant = "Steam (Mac)";
        in.buildNumber = 20;
        in.commit = "7b6e9086";
        a.inputs.push_back(in);
        a.clean = true;

        std::string js = Smith::ToJson(a);
        Smith::JobSpec b;
        bool ok = Smith::FromJson(js, b);
        ASSERT_TRUE(ok);
        ASSERT_EQ_STR(b.jobId, "job-123");
        ASSERT_EQ_STR(b.projectId, "soccer-boy");
        ASSERT_EQ_INT(b.buildNumber, 42);
        ASSERT_EQ_INT((int)b.repos.size(), 1);
        ASSERT_EQ_STR(b.repos[0].url, "git@github.com:Red-Marmoset/soccer-boy.git");
        ASSERT_EQ_STR(b.repos[0].branch, "main");
        ASSERT_EQ_STR(b.command.interpreter, "ps1");
        ASSERT_EQ_STR(b.command.script, "tools/smith-build.ps1");
        ASSERT_EQ_INT((int)b.command.args.size(), 2);
        ASSERT_EQ_STR(b.command.args[1], "StandaloneWindows64");
        ASSERT_EQ_STR(b.workingDir, ".");
        ASSERT_EQ_STR(b.env["SMITH_BUILD"], "1");
        ASSERT_EQ_STR(b.env["TARGET_ENV"], "steam");
        ASSERT_EQ_INT(b.timeoutSeconds, 3600);
        ASSERT_EQ_INT((int)b.successExitCodes.size(), 1);
        ASSERT_EQ_INT(b.successExitCodes[0], 0);
        ASSERT_EQ_STR(b.artifacts.package, "zip");
        ASSERT_EQ_STR(b.artifacts.archiveName, "soccer-boy-windows-42.zip");
        ASSERT_EQ_INT((int)b.handoff.size(), 1);
        ASSERT_EQ_STR(b.handoff[0].type, "collect");
        ASSERT_EQ_STR(b.handoff[0].fields["note"], "baseline");
        ASSERT_EQ_INT((int)b.inputs.size(), 1);
        ASSERT_EQ_STR(b.inputs[0].jobId, "job-100");
        ASSERT_EQ_STR(b.inputs[0].archiveName, "steam-mac.zip");
        ASSERT_EQ_STR(b.inputs[0].product, "unity");
        ASSERT_EQ_STR(b.inputs[0].variant, "Steam (Mac)");
        ASSERT_EQ_INT(b.inputs[0].buildNumber, 20);
        ASSERT_EQ_STR(b.inputs[0].commit, "7b6e9086");
        ASSERT_TRUE(b.clean);

        // A spec without inputs must deserialize to an empty list (old coordinators),
        // and an absent "clean" key defaults off (old coordinators never sent it).
        Smith::JobSpec c;
        ASSERT_TRUE(Smith::FromJson("{\"jobId\":\"j2\"}", c));
        ASSERT_EQ_INT((int)c.inputs.size(), 0);
        ASSERT_TRUE(c.clean == false);
        // v1 JSON carries no job kind: it is a build with no mirror target.
        ASSERT_EQ_STR(c.kind, "build");
        ASSERT_TRUE(c.mirror.remote.empty() && c.mirror.authToken.empty());
        ASSERT_EQ_STR(b.kind, "build");

        // A hosted mirror job round-trips its kind + Artifacts push target.
        Smith::JobSpec m;
        m.jobId = "job-mirror";
        m.kind = "mirror";
        m.mirror.remote = "https://bab833826312fe2b0c81bd7608a6dbf7.artifacts.cloudflare.net/git/default/x.git";
        m.mirror.authToken = "art_v1_abc?expires=1";
        m.mirror.branch = "main";
        m.mirror.pushTags = false;
        Smith::JobSpec n;
        ASSERT_TRUE(Smith::FromJson(Smith::ToJson(m), n));
        ASSERT_EQ_STR(n.kind, "mirror");
        ASSERT_EQ_STR(n.mirror.remote, m.mirror.remote);
        ASSERT_EQ_STR(n.mirror.authToken, "art_v1_abc?expires=1");
        ASSERT_EQ_STR(n.mirror.branch, "main");
        ASSERT_TRUE(n.mirror.pushTags == false);
        Smith::JobSpec e;
        ASSERT_TRUE(Smith::FromJson("{\"jobId\":\"j3\",\"kind\":\"\"}", e));
        ASSERT_EQ_STR(e.kind, "build");

        // A branch-tip build carries the build action the coordinator resolves after checkout.
        Smith::JobSpec r; r.jobId = "r1"; r.kind = "build"; r.resolve.action = "unity/steam-windows";
        Smith::JobSpec rBack; ASSERT_TRUE(Smith::FromJson(Smith::ToJson(r), rBack));
        ASSERT_EQ_STR(rBack.resolve.action, "unity/steam-windows");
        ASSERT_EQ_STR(c.resolve.action, "");
        Smith::JobSpec scan; ASSERT_TRUE(Smith::FromJson("{\"jobId\":\"j4\",\"kind\":\"scan\"}", scan));
        ASSERT_EQ_STR(scan.kind, "scan");

        // A host job (copy a repository into Smith) round-trips its target; builds from Smith's copy carry the
        // local copy's id and expected tip, which older coordinators never send (absent -> empty).
        Smith::JobSpec h; h.jobId = "job-host"; h.kind = "host";
        h.host.repoUuid = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"; h.host.defaultBranch = "main"; h.host.maxBytes = 1073741824LL;
        Smith::RepoCheckout hosted; hosted.name = "main"; hosted.url = "https://exp.example.test/git/soccer-boy.git"; hosted.commit = std::string(40, 'a');
        hosted.hostedUuid = h.host.repoUuid; hosted.tip = std::string(40, 'a'); h.repos.push_back(hosted);
        Smith::JobSpec hBack; ASSERT_TRUE(Smith::FromJson(Smith::ToJson(h), hBack));
        ASSERT_EQ_STR(hBack.kind, "host");
        ASSERT_EQ_STR(hBack.host.repoUuid, "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
        ASSERT_EQ_STR(hBack.host.defaultBranch, "main");
        ASSERT_TRUE(hBack.host.maxBytes == 1073741824LL);
        ASSERT_EQ_STR(hBack.repos[0].hostedUuid, h.host.repoUuid);
        ASSERT_EQ_STR(hBack.repos[0].tip, std::string(40, 'a'));
        ASSERT_TRUE(c.host.repoUuid.empty() && c.host.defaultBranch.empty() && c.host.maxBytes == 0);
        ASSERT_TRUE(b.repos[0].hostedUuid.empty() && b.repos[0].tip.empty());
        // Plain checkouts do not grow new keys, so the LAN coordinator's JSON stays byte-compatible.
        ASSERT_TRUE(Smith::ToJson(c).find("hostedUuid") == std::string::npos);
        // Large files (Git LFS): a build of a project that keeps any carries the Smith remote and a read ticket in
        // `lfs`; a spec without one adds no key, and an older coordinator's JSON leaves it empty.
        Smith::JobSpec l; l.jobId = "job-lfs"; l.lfs.url = "https://exp.example.test/git/senet.git"; l.lfs.authToken = "smith_git_t";
        Smith::JobSpec lBack; ASSERT_TRUE(Smith::FromJson(Smith::ToJson(l), lBack));
        ASSERT_EQ_STR(lBack.lfs.url, "https://exp.example.test/git/senet.git");
        ASSERT_EQ_STR(lBack.lfs.authToken, "smith_git_t");
        ASSERT_TRUE(Smith::ToJson(c).find("\"lfs\"") == std::string::npos);
        ASSERT_TRUE(hBack.lfs.url.empty() && hBack.lfs.authToken.empty());
        // Import jobs carry the spec under "import"; absent in older JSON leaves it empty. A mirror's allRefs defaults off.
        {
            Smith::JobSpec i; i.jobId = "job-import"; i.kind = "import"; i.import.source = "git@github.com:Red-Marmoset/senet.git";
            i.import.artifactsRemote = "https://" + std::string(32, 'a') + ".artifacts.cloudflare.net/git/default/ws-senet.git"; i.import.artifactsToken = "art_v1_x";
            i.import.smithRemote = "https://exp.example.test/git/senet.git"; i.import.thresholdBytes = 10485760; i.import.maxRepoBytes = 1073741824; i.import.originalBlob = "original.bundle";
            Smith::JobSpec back; ASSERT_TRUE(Smith::FromJson(Smith::ToJson(i), back));
            ASSERT_EQ_STR(back.kind, "import"); ASSERT_EQ_STR(back.import.source, i.import.source); ASSERT_EQ_STR(back.import.artifactsToken, "art_v1_x");
            ASSERT_TRUE(back.import.thresholdBytes == 10485760 && back.import.maxRepoBytes == 1073741824 && back.import.originalBlob == "original.bundle");
            ASSERT_TRUE(Smith::ToJson(c).find("\"import\"") == std::string::npos);
            Smith::JobSpec m; m.kind = "mirror"; m.mirror.allRefs = true; Smith::JobSpec mBack; ASSERT_TRUE(Smith::FromJson(Smith::ToJson(m), mBack));
            ASSERT_TRUE(mBack.mirror.allRefs); ASSERT_TRUE(!hBack.mirror.allRefs);
        }
    }

    // 1b. TriggerRequest round-trip carries the clean flag; absent -> off.
    {
        Smith::TriggerRequest a;
        a.projectId = "soccer-boy";
        a.product = "win";
        a.branch = "main";
        a.profile = "steam-windows";
        a.targetOs = "windows";
        a.reason = "manual";
        a.clean = true;
        Smith::TriggerRequest b;
        ASSERT_TRUE(Smith::FromJson(Smith::ToJson(a), b));
        ASSERT_EQ_STR(b.projectId, "soccer-boy");
        ASSERT_EQ_STR(b.profile, "steam-windows");
        ASSERT_EQ_STR(b.targetOs, "windows");
        ASSERT_TRUE(b.clean);

        Smith::TriggerRequest c;
        ASSERT_TRUE(Smith::FromJson("{\"projectId\":\"p\"}", c));
        ASSERT_TRUE(c.clean == false);
    }

    // 2. RegisterRequest round-trip.
    {
        Smith::RegisterRequest a;
        a.hostname = "build-win-01";
        a.os = "windows";
        a.arch = "x64";
        a.labels = { "unity6", "steamcmd" };
        a.agentVersion = "0.1.0";
        a.protocolVersion = Smith::kProtocolVersion;
        a.gpuTotalMb = 24576;
        a.gpuFreeMb = 23000;

        Smith::RegisterRequest b;
        ASSERT_TRUE(Smith::FromJson(Smith::ToJson(a), b));
        ASSERT_EQ_STR(b.hostname, "build-win-01");
        ASSERT_EQ_STR(b.os, "windows");
        ASSERT_EQ_INT((int)b.labels.size(), 2);
        ASSERT_EQ_STR(b.labels[0], "unity6");
        ASSERT_EQ_INT(b.protocolVersion, Smith::kProtocolVersion);
        ASSERT_EQ_INT(b.gpuTotalMb, 24576);
        ASSERT_EQ_INT(b.gpuFreeMb, 23000);

        // Heartbeat carries refreshed free VRAM and hosted-service health.
        Smith::Heartbeat h; h.status = "idle"; h.gpuFreeMb = 12345; h.ollamaUp = true;
        h.serviceStatus = "exited"; h.serviceDetail = "discord.errors.PrivilegedIntentsRequired";
        Smith::Heartbeat h2;
        ASSERT_TRUE(Smith::FromJson(Smith::ToJson(h), h2));
        ASSERT_EQ_INT(h2.gpuFreeMb, 12345);
        ASSERT_EQ_STR(h2.status, "idle");
        ASSERT_EQ_STR(h2.serviceStatus, "exited");
        ASSERT_EQ_STR(h2.serviceDetail, "discord.errors.PrivilegedIntentsRequired");
        ASSERT_TRUE(h2.ollamaUp);

        // An old agent's heartbeat (no service fields) parses with empty health.
        Smith::Heartbeat h3;
        ASSERT_TRUE(Smith::FromJson("{\"status\":\"busy\",\"gpuFreeMb\":1}", h3));
        ASSERT_EQ_STR(h3.serviceStatus, "");

        // Heartbeat RESPONSE can carry a one-shot Steam Guard task; an empty
        // response (or an old coordinator's body) parses to no task.
        Smith::HeartbeatResponse hr;
        hr.steamGuard.requestId = "r1"; hr.steamGuard.credentialRef = "steam-soccer-boy"; hr.steamGuard.code = "ABC12";
        Smith::HeartbeatResponse hr2;
        ASSERT_TRUE(Smith::FromJson(Smith::ToJson(hr), hr2));
        ASSERT_EQ_STR(hr2.steamGuard.requestId, "r1");
        ASSERT_EQ_STR(hr2.steamGuard.code, "ABC12");
        Smith::HeartbeatResponse hr3;
        ASSERT_TRUE(Smith::FromJson("{}", hr3));
        ASSERT_EQ_STR(hr3.steamGuard.requestId, "");

        // NodeInfo carries both (coordinator -> /api/nodes), plus Ollama presence.
        Smith::NodeInfo n; n.nodeId = "n1"; n.gpuTotalMb = 8192; n.gpuFreeMb = 4096; n.ollamaUp = true;
        Smith::NodeInfo n2;
        ASSERT_TRUE(Smith::FromJson(Smith::ToJson(n), n2));
        ASSERT_EQ_INT(n2.gpuTotalMb, 8192);
        ASSERT_EQ_INT(n2.gpuFreeMb, 4096);
        ASSERT_TRUE(n2.ollamaUp);

        // An old agent's register request parses with ollamaUp = false.
        Smith::RegisterRequest rr2;
        ASSERT_TRUE(Smith::FromJson("{\"hostname\":\"old-box\"}", rr2));
        ASSERT_TRUE(!rr2.ollamaUp);
    }

    // 2b. ServiceSpec round-trip (the Discord-bot launch instruction).
    {
        Smith::ServiceSpec a;
        a.action = "run";
        a.name = "discord-bot";
        a.specHash = "deadbeef";
        a.env = { {"SMITH_OLLAMA_MODEL", "qwen3.5:9b"}, {"SMITH_DISCORD_NOTIFY_CHANNEL", "123"} };
        Smith::ServiceSpec b;
        ASSERT_TRUE(Smith::FromJson(Smith::ToJson(a), b));
        ASSERT_EQ_STR(b.action, "run");
        ASSERT_EQ_STR(b.name, "discord-bot");
        ASSERT_EQ_STR(b.specHash, "deadbeef");
        ASSERT_EQ_STR(b.env["SMITH_OLLAMA_MODEL"], "qwen3.5:9b");
        ASSERT_EQ_INT((int)b.env.size(), 2);
    }

    // 3. LogChunk round-trip.
    {
        Smith::LogChunk a;
        a.seq = 137;
        a.stream = "stderr";
        a.lines = { "error: boom", "stack frame 1" };

        Smith::LogChunk b;
        ASSERT_TRUE(Smith::FromJson(Smith::ToJson(a), b));
        ASSERT_EQ_INT((int)b.seq, 137);
        ASSERT_EQ_STR(b.stream, "stderr");
        ASSERT_EQ_INT((int)b.lines.size(), 2);
        ASSERT_EQ_STR(b.lines[1], "stack frame 1");
    }

    // 4. JobResult round-trip.
    {
        Smith::JobResult a;
        a.status = "failed";
        a.exitCode = 3;
        a.durationMs = 12345;
        a.message = "build script returned 3";

        Smith::JobResult b;
        ASSERT_TRUE(Smith::FromJson(Smith::ToJson(a), b));
        ASSERT_EQ_STR(b.status, "failed");
        ASSERT_EQ_INT(b.exitCode, 3);
        ASSERT_EQ_INT((int)b.durationMs, 12345);
    }

    // 5. Malformed JSON is rejected.
    {
        Smith::RegisterRequest b;
        ASSERT_TRUE(Smith::FromJson("{ this is not json", b) == false);
    }

    // 6. Missing fields take defaults (lenient parse of an empty object).
    {
        Smith::RegisterRequest b;
        b.protocolVersion = 999; // should be overwritten with default 0
        ASSERT_TRUE(Smith::FromJson("{}", b));
        ASSERT_EQ_INT(b.protocolVersion, 0);
        ASSERT_EQ_STR(b.hostname, "");
    }

    // 7. Unknown fields are ignored.
    {
        Smith::Heartbeat b;
        ASSERT_TRUE(Smith::FromJson("{\"status\":\"idle\",\"unknownField\":123}", b));
        ASSERT_EQ_STR(b.status, "idle");
    }

    printf("\nTest Results: %d Passed, %d Failed\n", passed, failed);
    return failed > 0 ? 1 : 0;
}

} // namespace Test
