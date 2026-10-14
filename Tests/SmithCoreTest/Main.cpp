// Main.cpp - SmithCore tests: streaming Process, Uuid, NodeMatcher, RepoConfig,
// and the flat-file Store. Follows the engine JsonTest pattern.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include <Test/Test.h>
#include <SmithCore/Process.h>
#include <SmithCore/Uuid.h>
#include <SmithCore/NodeMatcher.h>
#include <SmithCore/RepoConfig.h>
#include <SmithCore/Store.h>
#include <SmithCore/BuildRecord.h>
#include <SmithCore/BuildDiagnostics.h>
#include <SmithCore/RetryPolicy.h>
#include <SmithCore/GitUrl.h>
#include <SmithCore/GitRepo.h>
#include <SmithCore/Base64.h>
#include <SmithCore/GoogleAuth.h>
#include <SmithCore/Capabilities.h>
#include <SmithCore/CloudflareDns.h>
#include <SmithCore/Config.h>
#include <SmithCore/Handoff.h>
#include <SmithCore/Domain.h>
#include <SmithCore/Inputs.h>
#include <SmithCore/Batches.h>
#include <SmithCore/Housekeeping.h>
#include <SmithCore/Strings.h>
#include <SmithProtocol/WireTypes.h>

#include <cstdio>
#include <string>
#include <regex>
#include <vector>
#include <mutex>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <map>
#include <set>

// Last, and lean: the handle-inheritance regression test below needs the Win32 pipe
// calls, but windows.h must not shadow std::min/std::max for the headers above.
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

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

struct Captured
{
    std::mutex mu;
    std::vector<std::string> out;
    std::vector<std::string> err;
    void Add(bool isErr, const std::string& line) { std::lock_guard<std::mutex> lk(mu); (isErr ? err : out).push_back(line); }
    bool OutHas(const std::string& s) { std::lock_guard<std::mutex> lk(mu); for (auto& l : out) if (l == s) return true; return false; }
    bool ErrHas(const std::string& s) { std::lock_guard<std::mutex> lk(mu); for (auto& l : err) if (l == s) return true; return false; }
    bool OutContains(const std::string& s) { std::lock_guard<std::mutex> lk(mu); for (auto& l : out) if (l.find(s) != std::string::npos) return true; return false; }
};

static std::vector<std::string> Sh(const std::string& inner)
{
#ifdef _WIN32
    return { "cmd", "/c", inner };
#else
    return { "/bin/sh", "-c", inner };
#endif
}

int TestMain(const CommandLine::Parser& parser)
{
    (void)parser;
    int passed = 0;
    int failed = 0;

    printf("SmithCore tests\n\n");

    // ---- Process ----
    {
        Smith::Process p; Captured c;
        Smith::ProcessOptions o; o.argv = Sh("echo hello-smith");
        int rc = p.Run(o, [&](bool e, const std::string& l) { c.Add(e, l); });
        ASSERT_EQ_INT(rc, 0);
        ASSERT_TRUE(c.OutHas("hello-smith"));
    }

    // ---- RetryPolicy: node/environment failure (retry) vs code error (no retry) ----
    {
        using Smith::IsRetryableFailure;
        Smith::BuildDiagnostics clean;                            // no errors, no failed tests
        Smith::BuildDiagnostics codeErr; codeErr.errorCount = 3;  // compiler/linker errors
        Smith::BuildDiagnostics testErr; testErr.testsFailed = 1; // failed tests

        // Agent-level failures (bad checkout, crashed/vanished agent) retry regardless.
        ASSERT_TRUE(IsRetryableFailure("error", clean));
        ASSERT_TRUE(IsRetryableFailure("error", codeErr));
        ASSERT_TRUE(IsRetryableFailure("lost", clean));

        // "failed" with nothing diagnosable = environmental (editor wouldn't launch,
        // missing tool/library, no artifacts) -> retry on another node.
        ASSERT_TRUE(IsRetryableFailure("failed", clean));
        // "failed" WITH compiler/linker errors or failed tests = code error -> no retry.
        ASSERT_TRUE(!IsRetryableFailure("failed", codeErr));
        ASSERT_TRUE(!IsRetryableFailure("failed", testErr));

        // Terminal non-failures never retry.
        ASSERT_TRUE(!IsRetryableFailure("success", clean));
        ASSERT_TRUE(!IsRetryableFailure("cancelled", clean));
    }
    {
        Smith::Process p; Smith::ProcessOptions o; o.argv = Sh("exit 7");
        ASSERT_EQ_INT(p.Run(o, nullptr), 7);
    }
    // stdinFile hands text to the child verbatim, with no shell or argv quoting in between.
    {
        const auto input = std::filesystem::temp_directory_path() / ("smith-stdin-" + Smith::MakeUuid() + ".txt");
        { std::ofstream f(input, std::ios::binary); f << "fix the \"bug\" & ship | it\n"; }
        Smith::Process p; Captured c; Smith::ProcessOptions o; o.stdinFile = input.string();
#ifdef _WIN32
        o.argv = { "findstr", "^" };
#else
        o.argv = { "cat" };
#endif
        ASSERT_EQ_INT(p.Run(o, [&](bool e, const std::string& l) { c.Add(e, l); }), 0);
        ASSERT_TRUE(c.OutHas("fix the \"bug\" & ship | it"));
        std::filesystem::remove(input);
        Smith::Process missing; Smith::ProcessOptions m; m.argv = Sh("exit 0"); m.stdinFile = input.string();
        ASSERT_TRUE(!missing.Start(m, nullptr));
    }
    // stdoutFile sends the child's stdout to a file as raw bytes (no line splitting); the callback still sees stderr.
    {
        const auto out = std::filesystem::temp_directory_path() / ("smith-stdout-" + Smith::MakeUuid() + ".bin");
        Smith::Process p; Captured c; Smith::ProcessOptions o; o.stdoutFile = out.string();
#ifdef _WIN32
        // Redirect first: cmd keeps the space before a trailing "1>&2", so the line would be "to stderr ".
        o.argv = { "cmd.exe", "/d", "/c", "echo raw bytes& 1>&2 echo to stderr" };
#else
        o.argv = { "/bin/sh", "-c", "printf 'raw bytes\\000no newline'; echo to stderr 1>&2" };
#endif
        ASSERT_EQ_INT(p.Run(o, [&](bool e, const std::string& l) { c.Add(e, l); }), 0);
        std::ifstream in(out, std::ios::binary); std::string bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        ASSERT_TRUE(bytes.rfind("raw bytes", 0) == 0);
        ASSERT_TRUE(!c.OutHas("raw bytes"));
        ASSERT_TRUE(c.ErrHas("to stderr"));
        in.close(); std::filesystem::remove(out);
    }
    // envUnset removes inherited variables, by name or by prefix, before envOverride applies.
    {
        Smith::Process p; Captured c; Smith::ProcessOptions o;
#ifdef _WIN32
        _putenv_s("SMITHTEST_SECRET_A", "a"); _putenv_s("SMITHTEST_KEEP", "k");
        o.argv = { "cmd.exe", "/d", "/c", "set SMITHTEST" };
#else
        setenv("SMITHTEST_SECRET_A", "a", 1); setenv("SMITHTEST_KEEP", "k", 1);
        o.argv = Sh("env | grep SMITHTEST | sort");
#endif
        o.envUnset = { "SMITHTEST_SECRET_*" }; o.envOverride = { { "SMITHTEST_ADDED", "1" } };
        p.Run(o, [&](bool e, const std::string& l) { c.Add(e, l); });
        ASSERT_TRUE(c.OutHas("SMITHTEST_KEEP=k"));
        ASSERT_TRUE(c.OutHas("SMITHTEST_ADDED=1"));
        ASSERT_TRUE(!c.OutHas("SMITHTEST_SECRET_A=a"));
    }
    // stdinPipe keeps a conversation with the child; closing it is the child's end of input.
    {
        Smith::Process p; Captured c; Smith::ProcessOptions o; o.stdinPipe = true;
#ifdef _WIN32
        o.argv = { "findstr", "^" };
#else
        o.argv = { "cat" };
#endif
        ASSERT_TRUE(p.Start(o, [&](bool e, const std::string& l) { c.Add(e, l); }));
        ASSERT_TRUE(p.WriteStdin("{\"id\":1}\n"));
        ASSERT_TRUE(p.WriteStdin("second line\n"));
        p.CloseStdin();
        ASSERT_TRUE(!p.WriteStdin("after close"));
        ASSERT_EQ_INT(p.Wait(), 0);
        ASSERT_TRUE(c.OutHas("{\"id\":1}"));
        ASSERT_TRUE(c.OutHas("second line"));
    }
    {
        Smith::Process p; Captured c; Smith::ProcessOptions o;
#ifdef _WIN32
        o.argv = { "powershell", "-NoProfile", "-Command", "[Console]::Error.WriteLine('err-line')" };
#else
        o.argv = Sh("echo err-line 1>&2");
#endif
        p.Run(o, [&](bool e, const std::string& l) { c.Add(e, l); });
        ASSERT_TRUE(c.ErrHas("err-line"));
    }
    {
        Smith::Process p; Captured c; Smith::ProcessOptions o;
#ifdef _WIN32
        o.argv = Sh("echo %SMITH_TEST_VAR%");
#else
        o.argv = Sh("echo $SMITH_TEST_VAR");
#endif
        o.envOverride["SMITH_TEST_VAR"] = "xyzzy";
        p.Run(o, [&](bool e, const std::string& l) { c.Add(e, l); });
        ASSERT_TRUE(c.OutHas("xyzzy"));
    }
    {
        Smith::Process p; Captured c; Smith::ProcessOptions o;
#ifdef _WIN32
        o.argv = Sh("cd"); o.workingDir = "C:\\Windows";
        p.Run(o, [&](bool e, const std::string& l) { c.Add(e, l); });
        ASSERT_TRUE(c.OutContains("Windows"));
#else
        o.argv = Sh("pwd"); o.workingDir = "/tmp";
        p.Run(o, [&](bool e, const std::string& l) { c.Add(e, l); });
        ASSERT_TRUE(c.OutContains("tmp"));
#endif
    }
    {
        Smith::Process p; Smith::ProcessOptions o;
#ifdef _WIN32
        o.argv = Sh("ping -n 30 127.0.0.1 >nul");
#else
        o.argv = Sh("sleep 30");
#endif
        o.timeoutSeconds = 1;
        auto t0 = std::chrono::steady_clock::now();
        int rc = p.Run(o, nullptr);
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
        ASSERT_TRUE(p.TimedOut());
        ASSERT_TRUE(rc < 0);
        ASSERT_TRUE(ms < 8000);
    }
#ifdef _WIN32
    // A child must inherit ONLY its own std handles. When it inherits an unrelated
    // pipe's write end it holds that pipe open for its whole life, so the owner's
    // reader never reaches EOF and whichever thread joins that reader parks for good.
    // That is precisely how a long-lived service (the Discord bot) launched next to a
    // git fetch silently froze the coordinator's poller for 18 hours.
    {
        SECURITY_ATTRIBUTES sa{}; sa.nLength = sizeof(sa); sa.bInheritHandle = TRUE;
        HANDLE rd = nullptr, wr = nullptr;
        ASSERT_TRUE(CreatePipe(&rd, &wr, &sa, 0) != 0);
        SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);   // keep the read end to ourselves

        Smith::Process longLived; Smith::ProcessOptions lo;
        lo.argv = Sh("ping -n 10 127.0.0.1 >nul");
        ASSERT_TRUE(longLived.Start(lo, nullptr));

        CloseHandle(wr);   // our own write end is gone; only a leak into the child could remain

        // Peek rather than read: a leaked handle must fail the assert, not block it.
        // Every write end closed => ERROR_BROKEN_PIPE. Anything else means the child
        // still holds one, which is the bug.
        DWORD avail = 0;
        BOOL peek = PeekNamedPipe(rd, nullptr, 0, nullptr, &avail, nullptr);
        ASSERT_TRUE(!peek && GetLastError() == ERROR_BROKEN_PIPE);

        CloseHandle(rd);
        longLived.Kill();
        longLived.Wait();
    }
#endif

    // ---- Uuid ----
    {
        std::string a = Smith::MakeUuid();
        std::string b = Smith::MakeUuid();
        ASSERT_EQ_INT((int)a.size(), 36);
        ASSERT_TRUE(a[8] == '-' && a[13] == '-' && a[18] == '-' && a[23] == '-');
        ASSERT_TRUE(a != b);
    }

    // ---- NodeMatcher ----
    {
        Smith::NodeInfo node;
        node.os = "windows";
        node.labels = { "unity6", "steamcmd" };

        Smith::NodeSelector s1; s1.os = "windows"; s1.labels = { "unity6" };
        ASSERT_TRUE(Smith::NodeMatches(s1, node));

        Smith::NodeSelector s2; s2.os = "any";
        ASSERT_TRUE(Smith::NodeMatches(s2, node));

        Smith::NodeSelector s3; s3.os = "mac";
        ASSERT_TRUE(Smith::NodeMatches(s3, node) == false);

        Smith::NodeSelector s4; s4.os = "windows"; s4.labels = { "android" };
        ASSERT_TRUE(Smith::NodeMatches(s4, node) == false);
    }

    // ---- RepoConfig ----
    {
        const char* sample = R"JSON({
          "schemaVersion": 1,
          "project": { "id": "demo", "name": "Demo Project" },
          "repos": [ { "name": "main", "primary": true, "url": "git@github.com:x/demo.git", "defaultBranch": "main" } ],
          "buildProducts": [
            { "name": "win", "rules": [
              { "name": "build-win", "branches": ["main"],
                "nodeSelector": { "os": "windows", "labels": ["unity6"] },
                "command": { "windows": { "interpreter": "ps1", "script": "tools/build.ps1", "args": ["-Target", "X"] } },
                "artifacts": { "globs": ["builds/**"], "package": "zip" },
                "handoff": [ { "name": "collect", "type": "collect" } ],
                "inputs": [ { "product": "unity", "variant": "Steam (Mac)" },
                            { "product": "unity" },
                            { "variant": "missing-product-is-skipped" } ] }
            ] }
          ]
        })JSON";

        Smith::ProjectDef proj; std::string err;
        bool ok = Smith::ParseProjectConfig(sample, proj, err);
        ASSERT_TRUE(ok);
        ASSERT_EQ_STR(proj.id, "demo");
        ASSERT_EQ_INT((int)proj.repos.size(), 1);
        ASSERT_EQ_STR(proj.repos[0].url, "git@github.com:x/demo.git");
        ASSERT_TRUE(proj.repos[0].primary);
        ASSERT_EQ_INT((int)proj.products.size(), 1);
        ASSERT_EQ_INT((int)proj.products[0].rules.size(), 1);
        const Smith::BuildRuleDef& rule = proj.products[0].rules[0];
        ASSERT_EQ_STR(rule.nodeSelector.os, "windows");
        ASSERT_EQ_INT((int)rule.nodeSelector.labels.size(), 1);
        ASSERT_TRUE(rule.commandByOs.count("windows") == 1);
        ASSERT_EQ_STR(rule.commandByOs.at("windows").script, "tools/build.ps1");
        ASSERT_EQ_INT((int)rule.commandByOs.at("windows").args.size(), 2);
        ASSERT_EQ_STR(rule.artifacts.package, "zip");
        ASSERT_EQ_INT((int)rule.handoff.size(), 1);
        ASSERT_EQ_STR(rule.handoff[0].type, "collect");
        // inputs: parsed in order; an entry without a product is dropped.
        ASSERT_EQ_INT((int)rule.inputs.size(), 2);
        ASSERT_EQ_STR(rule.inputs[0].product, "unity");
        ASSERT_EQ_STR(rule.inputs[0].variant, "Steam (Mac)");
        ASSERT_EQ_STR(rule.inputs[1].product, "unity");
        ASSERT_EQ_STR(rule.inputs[1].variant, "");

        // Malformed config is rejected.
        Smith::ProjectDef bad; std::string e2;
        ASSERT_TRUE(Smith::ParseProjectConfig("{ not json", bad, e2) == false);
    }

    // ---- Artifact input resolution (fan-in) ----
    {
        auto rec = [](const char* jobId, const char* product, const char* variant,
                      const char* branch, const char* status, int n, const char* commit,
                      std::vector<std::string> artifacts) {
            Smith::BuildRecord r;
            r.jobId = jobId; r.projectId = "demo"; r.product = product; r.variant = variant;
            r.branch = branch; r.status = status; r.buildNumber = n; r.commit = commit;
            r.artifacts = std::move(artifacts);
            return r;
        };
        std::vector<Smith::BuildRecord> recs = {
            rec("j1", "unity", "Steam (Mac)", "main", "success", 10, "aaa1111", { "steam-mac.zip" }),
            rec("j2", "unity", "Steam (Mac)", "main", "success", 20, "bbb2222", { "steam-mac.zip" }),   // newer: wins
            rec("j3", "unity", "Steam (Mac)", "main", "failed",  30, "ccc3333", { "steam-mac.zip" }),   // failed: skipped
            rec("j4", "unity", "Steam (Mac)", "dev",  "success", 40, "ddd4444", { "steam-mac.zip" }),   // other branch
            rec("j5", "unity", "Steam (Win)", "main", "success", 21, "bbb2222", { "a.zip", "b.zip" }),  // 2 artifacts
            rec("j6", "unity", "Steam (Lin)", "main", "success", 22, "bbb2222", {}),                    // no artifacts
        };
        std::vector<const Smith::BuildRecord*> hist;
        for (const auto& r : recs) hist.push_back(&r);

        {   // picks the latest success on the right branch; expands every artifact
            std::vector<Smith::InputDef> ins = { { "unity", "Steam (Mac)" }, { "unity", "Steam (Win)" } };
            std::vector<Smith::ArtifactInput> out; std::string err;
            ASSERT_TRUE(Smith::ResolveArtifactInputs(ins, hist, "demo", "main", out, err));
            ASSERT_EQ_INT((int)out.size(), 3);
            ASSERT_EQ_STR(out[0].jobId, "j2");
            ASSERT_EQ_STR(out[0].archiveName, "steam-mac.zip");
            ASSERT_EQ_INT(out[0].buildNumber, 20);
            ASSERT_EQ_STR(out[0].commit, "bbb2222");
            ASSERT_EQ_STR(out[1].jobId, "j5");
            ASSERT_EQ_STR(out[1].archiveName, "a.zip");
            ASSERT_EQ_STR(out[2].archiveName, "b.zip");
        }
        {   // a build with no collected artifacts can't satisfy an input
            std::vector<Smith::InputDef> ins = { { "unity", "Steam (Lin)" } };
            std::vector<Smith::ArtifactInput> out; std::string err;
            ASSERT_TRUE(Smith::ResolveArtifactInputs(ins, hist, "demo", "main", out, err) == false);
            ASSERT_TRUE(err.find("Steam (Lin)") != std::string::npos);
        }
        {   // unknown product fails with the product named in the error
            std::vector<Smith::InputDef> ins = { { "nope", "" } };
            std::vector<Smith::ArtifactInput> out; std::string err;
            ASSERT_TRUE(Smith::ResolveArtifactInputs(ins, hist, "demo", "main", out, err) == false);
            ASSERT_TRUE(err.find("nope") != std::string::npos);
        }

        // ---- C: a chain deploy draws from its OWN run, not latest-success ----
        {
            // This run's Mac build is OLDER (#5) than the latest main success (#20),
            // but the deploy must use THIS run's build, not the newest one.
            Smith::BuildRecord runMac = rec("run-mac", "unity", "Steam (Mac)", "main", "success", 5, "fe9001f", { "steam-mac.zip" });
            std::vector<const Smith::BuildRecord*> runBuilds = { &runMac };

            std::vector<Smith::InputDef> ins = { { "unity", "Steam (Mac)" } };
            std::vector<Smith::ArtifactInput> out; std::string err;
            ASSERT_TRUE(Smith::ResolveArtifactInputsFromBatch(ins, runBuilds, hist, "demo", "main", out, err));
            ASSERT_EQ_INT((int)out.size(), 1);
            ASSERT_EQ_STR(out[0].jobId, "run-mac");      // this run's build, NOT j2 (#20)
            ASSERT_EQ_STR(out[0].commit, "fe9001f");
        }
        {
            // A variant the chain did NOT build falls back to latest-success-on-branch.
            Smith::BuildRecord runMac = rec("run-mac", "unity", "Steam (Mac)", "main", "success", 5, "fe9001f", { "steam-mac.zip" });
            std::vector<const Smith::BuildRecord*> runBuilds = { &runMac };

            std::vector<Smith::InputDef> ins = { { "unity", "Steam (Mac)" }, { "unity", "Steam (Win)" } };
            std::vector<Smith::ArtifactInput> out; std::string err;
            ASSERT_TRUE(Smith::ResolveArtifactInputsFromBatch(ins, runBuilds, hist, "demo", "main", out, err));
            ASSERT_EQ_INT((int)out.size(), 3);
            ASSERT_EQ_STR(out[0].jobId, "run-mac");      // from the run
            ASSERT_EQ_STR(out[1].jobId, "j5");           // fallback: latest-success Win
        }
    }

    // ---- B: preferOs soft affinity gate ----
    {
        const int64_t grace = 25000;
        // A non-preferred node defers a young job while the preferred agent is online.
        ASSERT_TRUE(Smith::ShouldDeferForAffinity("linux", "windows", 1000, grace, true));
        // ...but takes it once the grace window has elapsed.
        ASSERT_TRUE(Smith::ShouldDeferForAffinity("linux", "windows", 30000, grace, true) == false);
        // ...and immediately if no preferred agent is online (don't stall the build).
        ASSERT_TRUE(Smith::ShouldDeferForAffinity("linux", "windows", 1000, grace, false) == false);
        // The preferred node itself never defers.
        ASSERT_TRUE(Smith::ShouldDeferForAffinity("linux", "linux", 1000, grace, true) == false);
        // No affinity set -> never defers (case-insensitive, "any" ignored).
        ASSERT_TRUE(Smith::ShouldDeferForAffinity("", "windows", 1000, grace, true) == false);
        ASSERT_TRUE(Smith::ShouldDeferForAffinity("any", "windows", 1000, grace, true) == false);
        ASSERT_TRUE(Smith::ShouldDeferForAffinity("Linux", "LINUX", 1000, grace, true) == false);
    }

    // ---- Store ----
    {
        std::error_code ec;
        std::filesystem::path dir = std::filesystem::temp_directory_path(ec) / ("smith-test-" + Smith::MakeShortId());
        Smith::Store store(dir.string());
        ASSERT_TRUE(store.Init());

        ASSERT_EQ_INT(store.NextBuildNumber("p"), 1);
        ASSERT_EQ_INT(store.NextBuildNumber("p"), 2);

        Smith::BuildRecord r;
        r.jobId = "job-aaa";
        r.projectId = "p";
        r.buildNumber = 1;
        r.status = "running";
        r.branch = "main";
        r.clean = true;             // clean flag must survive a save/reload round-trip
        ASSERT_TRUE(store.SaveRecord(r));

        store.AppendLog(r, "line one\n");
        store.AppendLog(r, "line two\n");
        std::string logText;
        ASSERT_TRUE(store.ReadLog(r, logText));
        ASSERT_TRUE(logText.find("line one") != std::string::npos);
        ASSERT_TRUE(logText.find("line two") != std::string::npos);

        ASSERT_TRUE(store.SaveArtifact(r, "out.txt", "hello-artifact"));
        std::string bytes;
        ASSERT_TRUE(store.LoadArtifact(r, "out.txt", bytes));
        ASSERT_EQ_STR(bytes, "hello-artifact");

        std::vector<Smith::BuildRecord> all = store.LoadAllRecords();
        bool foundJob = false;
        for (auto& rec : all) if (rec.jobId == "job-aaa" && rec.status == "running" && rec.clean) foundJob = true;
        ASSERT_TRUE(foundJob);

        Smith::NodeInfo n;
        n.nodeId = "node-1";
        n.hostname = "build-win";
        n.os = "windows";
        n.labels = { "unity6" };
        store.SaveNode(n);
        std::vector<Smith::NodeInfo> nodes = store.LoadNodes();
        bool foundNode = false;
        for (auto& nn : nodes) if (nn.nodeId == "node-1" && nn.os == "windows") foundNode = true;
        ASSERT_TRUE(foundNode);

        std::filesystem::remove_all(dir, ec);
    }

    // ---- GitRepo clean: a clean Sync purges untracked AND ignored files ----
    // (the build-cache class - e.g. a Unity Library/ - that a normal reset leaves
    // behind; this is the Mono->IL2CPP foot-gun the clean flag exists to fix).
    {
        namespace fs = std::filesystem;
        std::error_code ec2;
        fs::path root = fs::temp_directory_path(ec2) / ("smith-git-" + Smith::MakeShortId());
        fs::path src = root / "src";
        fs::path work = root / "work";
        fs::create_directories(src, ec2);

        auto git = [](const fs::path& cwd, const std::vector<std::string>& a) {
            Smith::Process p; Smith::ProcessOptions o;
            o.argv.push_back("git");
            for (const auto& s : a) o.argv.push_back(s);
            o.workingDir = cwd.string();
            return p.Run(o, nullptr);
        };
        auto writeFile = [](const fs::path& p, const std::string& s) {
            std::ofstream f(p, std::ios::binary); f << s;
        };

        // A tiny upstream repo on branch "main": one tracked file + a .gitignore.
        int initRc = git(src, { "init" });
        git(src, { "checkout", "-b", "main" });   // name the (unborn) branch deterministically
        git(src, { "config", "user.email", "t@example.com" });
        git(src, { "config", "user.name", "Test" });
        writeFile(src / "a.txt", "tracked\n");
        writeFile(src / ".gitignore", "ignored.txt\n");
        git(src, { "add", "." });
        int commitRc = git(src, { "commit", "-m", "init" });

        bool gitWorks = (initRc == 0 && commitRc == 0);
        ASSERT_TRUE(gitWorks);   // surfaces a missing/broken git rather than silently passing
        if (gitWorks)
        {
            // First sync clones the repo into a fresh workspace.
            ASSERT_TRUE(Smith::GitRepo::Sync(src.string(), work.string(), "main", "", nullptr));
            ASSERT_TRUE(fs::exists(work / "a.txt", ec2));

            // Simulate stale build caches: an untracked file and a git-ignored one.
            writeFile(work / "junk.txt", "untracked\n");
            writeFile(work / "ignored.txt", "build cache\n");

            // A normal (non-clean) sync must leave them in place.
            ASSERT_TRUE(Smith::GitRepo::Sync(src.string(), work.string(), "main", "", nullptr, "", false));
            ASSERT_TRUE(fs::exists(work / "junk.txt", ec2));
            ASSERT_TRUE(fs::exists(work / "ignored.txt", ec2));

            // A clean sync purges both, while the tracked file survives.
            ASSERT_TRUE(Smith::GitRepo::Sync(src.string(), work.string(), "main", "", nullptr, "", true));
            ASSERT_TRUE(fs::exists(work / "junk.txt", ec2) == false);
            ASSERT_TRUE(fs::exists(work / "ignored.txt", ec2) == false);
            ASSERT_TRUE(fs::exists(work / "a.txt", ec2));

            // A PINNED-COMMIT sync repairs a workspace whose tracked files were
            // deleted out-of-band (e.g. macOS purging /tmp): a plain checkout
            // wouldn't restore them (the index still thinks they're present), but
            // Sync force-resets the worktree. Regression test for the Mac
            // "tools/smith-build.sh: No such file" (exit 127) failure.
            std::string head = Smith::GitRepo::HeadSha(work.string());
            ASSERT_TRUE(!head.empty());
            fs::remove(work / "a.txt", ec2);
            ASSERT_TRUE(fs::exists(work / "a.txt", ec2) == false);
            ASSERT_TRUE(Smith::GitRepo::Sync(src.string(), work.string(), "", head, nullptr));
            ASSERT_TRUE(fs::exists(work / "a.txt", ec2));   // restored by reset --hard
        }

        fs::remove_all(root, ec2);
    }

    // ---- Handoff builders (pure; never invokes steamcmd/butler/wrangler) ----
    {
        namespace fs = std::filesystem;
        using SMap = std::map<std::string, std::string>;

        SMap vars = { { "BRANCH", "main" }, { "BUILD_NUMBER", "42" } };
        ASSERT_EQ_STR(Smith::SubstituteVars("env-${BRANCH}-${BUILD_NUMBER}", vars), "env-main-42");
        ASSERT_EQ_STR(Smith::SubstituteVars("${UNKNOWN}", vars), "${UNKNOWN}");

        Smith::HandoffCommand sc = Smith::BuildScriptCommand(
            { { "interpreter", "ps1" }, { "script", "deploy.ps1" }, { "args", "--env staging" } }, "/work");
        ASSERT_TRUE(sc.error.empty());
        ASSERT_TRUE(sc.argv.size() >= 6);
        ASSERT_EQ_STR(sc.argv[0], "powershell");
        ASSERT_EQ_STR(sc.argv.back(), "staging");
        ASSERT_TRUE(!Smith::BuildScriptCommand({ { "interpreter", "ps1" } }, "/work").error.empty());

        SMap steamCreds = { { "username", "builder" }, { "password", "s3cret" } };
        Smith::HandoffCommand st = Smith::BuildSteamCommand({ { "appBuildVdf", "SteamPipe/app.vdf" } }, steamCreds, "/work");
        ASSERT_TRUE(st.error.empty());
        ASSERT_EQ_STR(st.argv[0], "steamcmd");
        {
            bool login = false, user = false, build = false, quit = false;
            for (const auto& a : st.argv)
            {
                if (a == "+login") login = true;
                if (a == "builder") user = true;
                if (a == "+run_app_build") build = true;
                if (a == "+quit") quit = true;
            }
            ASSERT_TRUE(login && user && build && quit);
        }
        ASSERT_TRUE(!Smith::BuildSteamCommand({}, steamCreds, "/work").error.empty());

        // Multiple app-build VDFs: one +run_app_build each, in order, single session.
        {
            Smith::HandoffCommand m = Smith::BuildSteamCommand(
                { { "appBuildVdfs", R"(["SteamPipe/a.vdf","SteamPipe/b.vdf"])" } }, steamCreds, "/work");
            ASSERT_TRUE(m.error.empty());
            ASSERT_EQ_STR(m.argv[0], "steamcmd");
            int builds = 0, logins = 0, quits = 0;
            for (const auto& a : m.argv) { if (a == "+run_app_build") builds++; if (a == "+login") logins++; if (a == "+quit") quits++; }
            ASSERT_EQ_INT(builds, 2); ASSERT_EQ_INT(logins, 1); ASSERT_EQ_INT(quits, 1);
            std::vector<std::string> order;
            for (size_t i = 0; i + 1 < m.argv.size(); ++i) if (m.argv[i] == "+run_app_build") order.push_back(m.argv[i + 1]);
            ASSERT_EQ_INT((int)order.size(), 2);
            ASSERT_TRUE(order[0].find("a.vdf") != std::string::npos);
            ASSERT_TRUE(order[1].find("b.vdf") != std::string::npos);
            ASSERT_EQ_STR(m.argv.back(), "+quit");
        }
        // Backward compat: single appBuildVdf is unchanged (exactly one build).
        {
            Smith::HandoffCommand s1 = Smith::BuildSteamCommand({ { "appBuildVdf", "SteamPipe/app.vdf" } }, steamCreds, "/work");
            ASSERT_TRUE(s1.error.empty());
            int builds = 0; for (const auto& a : s1.argv) if (a == "+run_app_build") builds++;
            ASSERT_EQ_INT(builds, 1); ASSERT_EQ_STR(s1.argv.back(), "+quit");
        }
        // Both fields set: single first, then array entries, in order.
        {
            Smith::HandoffCommand b = Smith::BuildSteamCommand(
                { { "appBuildVdf", "SteamPipe/main.vdf" }, { "appBuildVdfs", R"(["SteamPipe/dlc1.vdf"])" } }, steamCreds, "/work");
            ASSERT_TRUE(b.error.empty());
            std::vector<std::string> order;
            for (size_t i = 0; i + 1 < b.argv.size(); ++i) if (b.argv[i] == "+run_app_build") order.push_back(b.argv[i + 1]);
            ASSERT_EQ_INT((int)order.size(), 2);
            ASSERT_TRUE(order[0].find("main.vdf") != std::string::npos);
            ASSERT_TRUE(order[1].find("dlc1.vdf") != std::string::npos);
        }
        // A raw (non-JSON) path in appBuildVdfs is treated as one literal path.
        {
            Smith::HandoffCommand r = Smith::BuildSteamCommand({ { "appBuildVdfs", "SteamPipe/raw.vdf" } }, steamCreds, "/work");
            ASSERT_TRUE(r.error.empty());
            int builds = 0; for (const auto& a : r.argv) if (a == "+run_app_build") builds++;
            ASSERT_EQ_INT(builds, 1);
        }
        // Empty array + no appBuildVdf -> error naming both fields.
        {
            Smith::HandoffCommand e = Smith::BuildSteamCommand({ { "appBuildVdfs", "[]" } }, steamCreds, "/work");
            ASSERT_TRUE(!e.error.empty());
            ASSERT_TRUE(e.error.find("appBuildVdf") != std::string::npos);
            ASSERT_TRUE(e.error.find("appBuildVdfs") != std::string::npos);
        }

        // BuildOutput extraction from app-build VDF text (for live log tailing).
        ASSERT_EQ_STR(Smith::ParseVdfBuildOutput("\"AppBuild\"{\"BuildOutput\" \"./out/\"}"), "./out/");
        ASSERT_EQ_STR(Smith::ParseVdfBuildOutput("\t\"buildoutput\"\t\"steam_logs\""), "steam_logs");
        ASSERT_EQ_STR(Smith::ParseVdfBuildOutput("\"AppBuild\"{\"ContentRoot\" \".\"}"), "");
        ASSERT_EQ_STR(Smith::ParseVdfBuildOutput(""), "");

        // VDF Desc patching: replace an existing value, insert when absent, and
        // sanitize quotes (VDF values are quote-delimited).
        ASSERT_EQ_STR(Smith::PatchVdfDesc("\"AppBuild\"{\"Desc\" \"old text\"}", "new"),
                      "\"AppBuild\"{\"Desc\" \"new\"}");
        ASSERT_TRUE(Smith::PatchVdfDesc("\"AppBuild\"\n{\n\t\"AppID\" \"1\"\n}", "Smith build #7 (main)")
                        .find("\"Desc\" \"Smith build #7 (main)\"") != std::string::npos);
        ASSERT_TRUE(Smith::PatchVdfDesc("\"AppBuild\"{\"desc\" \"x\"}", "say \"hi\"")
                        .find("say 'hi'") != std::string::npos);                       // case-insensitive key, quotes stripped
        ASSERT_EQ_STR(Smith::PatchVdfDesc("no braces here", "d"), "no braces here");   // not a VDF -> untouched

        // A real VDF on disk feeds the steam command's tailDirs (resolved against
        // the VDF's own folder); a missing VDF just yields no tail dir, no error.
        {
            namespace tfs = std::filesystem;
            std::error_code tec;
            tfs::path tdir = tfs::temp_directory_path(tec) / ("smith-vdf-" + Smith::MakeShortId());
            tfs::create_directories(tdir / "SteamPipe", tec);
            std::ofstream v(tdir / "SteamPipe" / "app.vdf", std::ios::binary);
            v << "\"AppBuild\"\n{\n\t\"AppID\" \"123\"\n\t\"Desc\" \"dev\"\n\t\"BuildOutput\" \"./logs_out/\"\n}\n";
            v.close();

            Smith::HandoffCommand t = Smith::BuildSteamCommand(
                { { "appBuildVdf", "SteamPipe/app.vdf" } }, steamCreds, tdir.string());
            ASSERT_TRUE(t.error.empty());
            ASSERT_EQ_INT((int)t.tailDirs.size(), 1);
            ASSERT_TRUE(t.tailDirs[0].find("logs_out") != std::string::npos);
            // Resolved against the VDF's folder, not the working dir.
            ASSERT_TRUE(t.tailDirs[0].find("SteamPipe") != std::string::npos);
            // No desc field -> builds from the repo's own VDF, no copy written.
            ASSERT_TRUE(t.argv[t.argv.size() - 2].find("app.vdf") != std::string::npos);
            ASSERT_TRUE(!tfs::exists(tdir / "SteamPipe" / "app.smith.vdf", tec));

            // With a desc the command targets a patched sibling copy carrying the
            // description; the original VDF is untouched and tailDirs still resolve.
            Smith::HandoffCommand d = Smith::BuildSteamCommand(
                { { "appBuildVdf", "SteamPipe/app.vdf" }, { "desc", "Smith build #9 (main @ abc1234)" } },
                steamCreds, tdir.string());
            ASSERT_TRUE(d.error.empty());
            ASSERT_TRUE(d.argv[d.argv.size() - 2].find("app.smith.vdf") != std::string::npos);
            ASSERT_EQ_INT((int)d.tailDirs.size(), 1);
            {
                std::ifstream pc(tdir / "SteamPipe" / "app.smith.vdf", std::ios::binary);
                std::stringstream pss; pss << pc.rdbuf();
                ASSERT_TRUE(pss.str().find("\"Desc\" \"Smith build #9 (main @ abc1234)\"") != std::string::npos);
                ASSERT_TRUE(pss.str().find("dev") == std::string::npos);               // old desc replaced
            }
            {
                std::ifstream oc(tdir / "SteamPipe" / "app.vdf", std::ios::binary);
                std::stringstream oss; oss << oc.rdbuf();
                ASSERT_TRUE(oss.str().find("\"Desc\" \"dev\"") != std::string::npos);  // original untouched
            }

            Smith::HandoffCommand miss = Smith::BuildSteamCommand(
                { { "appBuildVdf", "SteamPipe/nope.vdf" } }, steamCreds, tdir.string());
            ASSERT_TRUE(miss.error.empty());
            ASSERT_EQ_INT((int)miss.tailDirs.size(), 0);

            tfs::remove_all(tdir, tec);
        }

        Smith::HandoffCommand it = Smith::BuildItchCommand(
            { { "user", "me" }, { "game", "g" }, { "channel", "win" }, { "path", "dist" } },
            { { "apiKey", "KEY123" } }, "/work");
        ASSERT_TRUE(it.error.empty());
        ASSERT_EQ_STR(it.argv[0], "butler");
        ASSERT_EQ_STR(it.argv[1], "push");
        ASSERT_EQ_STR(it.argv.back(), "me/g:win");
        ASSERT_EQ_STR(it.env["BUTLER_API_KEY"], "KEY123");

        Smith::HandoffCommand cf = Smith::BuildCloudflareCommand(
            { { "env", "staging" } }, { { "apiToken", "TKN" } }, "/work");
        ASSERT_TRUE(cf.error.empty());
        ASSERT_EQ_STR(cf.argv[0], "wrangler");
        ASSERT_EQ_STR(cf.argv[1], "deploy");
        ASSERT_EQ_STR(cf.env["CLOUDFLARE_API_TOKEN"], "TKN");
        {
            bool envFlag = false;
            for (size_t i = 0; i + 1 < cf.argv.size(); ++i)
                if (cf.argv[i] == "--env" && cf.argv[i + 1] == "staging") envFlag = true;
            ASSERT_TRUE(envFlag);
        }

        std::error_code cec;
        fs::path cdir = fs::temp_directory_path() / "smith-cred-test";
        fs::remove_all(cdir, cec);
        fs::create_directories(cdir, cec);
        fs::path cfile = cdir / "creds.json";
        { std::ofstream o(cfile); o << R"({"steam-x":{"username":"u","password":"p"}})"; }
        SMap got = Smith::ResolveCredentials(cfile.string(), "steam-x");
        ASSERT_EQ_STR(got["username"], "u");
        ASSERT_EQ_STR(got["password"], "p");
        ASSERT_TRUE(Smith::ResolveCredentials(cfile.string(), "missing").empty());
        fs::remove_all(cdir, cec);
    }

    // ---- Variant discovery (generic; no Unity/project-type knowledge) ----
    {
        namespace fs = std::filesystem;
        std::error_code ec2;

        // The slug mirrors the per-variant output folder a build script uses.
        ASSERT_EQ_STR(Smith::SlugifyName("Steam (Windows)"), "steam-windows");
        ASSERT_EQ_STR(Smith::SlugifyName("No Steam (Mac)"), "no-steam-mac");
        ASSERT_EQ_STR(Smith::SlugifyName("   "), "build");

        Smith::DiscoverSpec spec;
        spec.type = "files";
        spec.glob = "profiles/*.asset";
        spec.as = "PROFILE";
        spec.classify = { { "\\(Mac\\)", "mac", {} }, { "\\(Linux\\)", "linux", {} }, { ".*", "windows", {} } };

        // First matching classify rule wins.
        ASSERT_EQ_STR(Smith::ClassifyVariant("Steam (Mac)", spec).os, "mac");
        ASSERT_EQ_STR(Smith::ClassifyVariant("Steam (Linux)", spec).os, "linux");
        ASSERT_EQ_STR(Smith::ClassifyVariant("Steam (Windows)", spec).os, "windows");

        fs::path vbase = fs::temp_directory_path() / "smith-variants-test";
        fs::remove_all(vbase, ec2);
        fs::create_directories(vbase / "profiles", ec2);
        for (const char* n : { "Steam (Windows).asset", "Steam (Mac).asset", "No Steam (Linux).asset" })
            { std::ofstream o(vbase / "profiles" / n); o << "x"; }
        { std::ofstream o(vbase / "profiles" / "notes.txt"); o << "x"; }                 // wrong extension
        { std::ofstream o(vbase / "profiles" / "Steam (Windows).asset.meta"); o << "x"; } // .meta excluded

        std::vector<Smith::ProductVariant> vs = Smith::DiscoverVariants(vbase.string(), spec);
        ASSERT_EQ_INT((int)vs.size(), 3);          // only the three *.asset files
        ASSERT_EQ_STR(vs[0].name, "No Steam (Linux)");   // sorted by name
        ASSERT_EQ_STR(vs[0].os, "linux");
        ASSERT_EQ_STR(vs[2].name, "Steam (Windows)");
        ASSERT_EQ_STR(vs[2].os, "windows");

        // A spec with no glob yields nothing.
        Smith::DiscoverSpec empty;
        ASSERT_EQ_INT((int)Smith::DiscoverVariants(vbase.string(), empty).size(), 0);
        fs::remove_all(vbase, ec2);
    }

    // ---- smith.json parity with the hosted coordinator (cloudflare/coordinator/src/pipeline.ts) ----
    // The TypeScript reader is tested against these same fixtures; both must agree.
    {
        namespace fs = std::filesystem;
        std::error_code ec3;
        const fs::path fixtures = fs::path("cloudflare") / "coordinator" / "test" / "fixtures" / "smith-json";
        auto slurp = [](const fs::path& p) { std::ifstream in(p, std::ios::binary); std::stringstream s; s << in.rdbuf(); return s.str(); };
        const std::pair<const char*, int> productCounts[] = { { "soccer-boy", 5 }, { "senet", 6 }, { "smith", 6 } };
        for (const auto& [name, count] : productCounts) {
            Smith::ProjectDef def; std::string error;
            ASSERT_TRUE(Smith::ParseProjectConfig(slurp(fixtures / (std::string(name) + ".json")), def, error));
            ASSERT_EQ_INT((int)def.products.size(), count);
        }
        // soccer-boy's Unity build profiles, discovered from its fixture file list.
        Smith::ProjectDef soccer; std::string error;
        ASSERT_TRUE(Smith::ParseProjectConfig(slurp(fixtures / "soccer-boy.json"), soccer, error));
        const fs::path tree = fs::temp_directory_path() / "smith-parity-soccer-boy";
        fs::remove_all(tree, ec3);
        std::istringstream paths(slurp(fixtures / "soccer-boy.paths.txt"));
        for (std::string line; std::getline(paths, line);) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (line.empty()) continue;
            fs::create_directories((tree / line).parent_path(), ec3);
            std::ofstream(tree / line) << "x";
        }
        std::vector<std::string> expected, actual;
        std::istringstream wanted(slurp(fixtures / "soccer-boy.variants.txt"));
        for (std::string line; std::getline(wanted, line);) { if (!line.empty() && line.back() == '\r') line.pop_back(); if (!line.empty()) expected.push_back(line); }
        for (const auto& product : soccer.products)
            for (const auto& v : Smith::DiscoverVariants(tree.string(), product.discover)) {
                std::string labels; for (const auto& l : v.labels) labels += (labels.empty() ? "" : ",") + l;
                actual.push_back(product.name + "|" + v.name + "|" + v.slug + "|" + v.os + "|" + labels);
            }
        ASSERT_EQ_INT((int)actual.size(), (int)expected.size());
        for (size_t i = 0; i < actual.size() && i < expected.size(); ++i) ASSERT_EQ_STR(actual[i], expected[i]);
        fs::remove_all(tree, ec3);
    }

    // ---- Agent capability label detection ----
    {
        std::error_code cec;
        ASSERT_EQ_INT((int)Smith::DetectCapabilityLabels("").size(), 0);                       // no path -> none
        ASSERT_EQ_INT((int)Smith::DetectCapabilityLabels("Q:/no/such/engine").size(), 0);      // missing -> none

        std::filesystem::path eng = std::filesystem::temp_directory_path(cec) / ("smith-cap-test-" + Smith::MakeShortId());
        std::filesystem::remove_all(eng, cec);
        std::filesystem::create_directories(eng / "Build" / "BuildTool" / "Release", cec);
        { std::ofstream o(eng / "Build" / "BuildTool" / "Release" / "BuildTool.exe"); o << "x"; }
        std::vector<std::string> caps = Smith::DetectCapabilityLabels(eng.string());
        ASSERT_EQ_INT((int)caps.size(), 1);                                                    // bootstrapped engine...
        if (!caps.empty()) ASSERT_EQ_STR(caps[0], "una-engine");                               // ...implies una-engine
        std::filesystem::remove_all(eng, cec);
    }

    // ---- Unity Linux build-support detection (cross-build capability labels) ----
    {
        std::error_code uec;
        ASSERT_EQ_INT((int)Smith::DetectUnityLinuxLabels({}).size(), 0);                       // no roots -> none
        ASSERT_EQ_INT((int)Smith::DetectUnityLinuxLabels({ "Q:/no/such/hub" }).size(), 0);     // missing -> none

        std::filesystem::path hub = std::filesystem::temp_directory_path(uec) / ("smith-unity-test-" + Smith::MakeShortId());
        std::filesystem::remove_all(hub, uec);

        // Module installed but Mono-only variations -> unity-linux, no il2cpp label.
        std::filesystem::path vars = hub / "6000.3.11f1" / "Editor" / "Data" / "PlaybackEngines" / "LinuxStandaloneSupport" / "Variations";
        std::filesystem::create_directories(vars / "linux64_player_nondevelopment_mono", uec);
        std::vector<std::string> mono = Smith::DetectUnityLinuxLabels({ hub.string() });
        ASSERT_EQ_INT((int)mono.size(), 1);
        if (!mono.empty()) ASSERT_EQ_STR(mono[0], "unity-linux");

        // IL2CPP variations appear (what the Hub's Linux IL2CPP module installs) -> both labels.
        std::filesystem::create_directories(vars / "linux64_player_nondevelopment_il2cpp", uec);
        std::vector<std::string> il2 = Smith::DetectUnityLinuxLabels({ hub.string() });
        ASSERT_EQ_INT((int)il2.size(), 2);
        if (il2.size() == 2) { ASSERT_EQ_STR(il2[0], "unity-linux"); ASSERT_EQ_STR(il2[1], "unity-linux-il2cpp"); }

        // macOS layout (<version>/PlaybackEngines, no Editor/Data) is detected too.
        std::filesystem::path mac = hub / "mac" / "6000.3.11f1" / "PlaybackEngines" / "LinuxStandaloneSupport";
        std::filesystem::create_directories(mac / "Variations" / "il2cpp", uec);
        std::vector<std::string> macL = Smith::DetectUnityLinuxLabels({ (hub / "mac").string() });
        ASSERT_EQ_INT((int)macL.size(), 2);

        std::filesystem::remove_all(hub, uec);
    }

    // ---- Unity mobile build-support detection (unity-ios / unity-android) ----
    {
        std::error_code uec;
        ASSERT_EQ_INT((int)Smith::DetectUnityMobileLabels({}).size(), 0);                      // no roots -> none
        ASSERT_EQ_INT((int)Smith::DetectUnityMobileLabels({ "Q:/no/such/hub" }).size(), 0);    // missing -> none

        std::filesystem::path hub = std::filesystem::temp_directory_path(uec) / ("smith-unitymobile-test-" + Smith::MakeShortId());
        std::filesystem::remove_all(hub, uec);

        // macOS layout with only iOS support -> unity-ios.
        std::filesystem::create_directories(hub / "6000.3.11f1" / "PlaybackEngines" / "iOSSupport", uec);
        std::vector<std::string> ios = Smith::DetectUnityMobileLabels({ hub.string() });
        ASSERT_EQ_INT((int)ios.size(), 1);
        if (!ios.empty()) ASSERT_EQ_STR(ios[0], "unity-ios");

        // Windows layout with Android added -> both labels.
        std::filesystem::create_directories(hub / "6000.0.47f1" / "Editor" / "Data" / "PlaybackEngines" / "AndroidPlayer", uec);
        std::vector<std::string> both = Smith::DetectUnityMobileLabels({ hub.string() });
        ASSERT_EQ_INT((int)both.size(), 2);
        if (both.size() == 2) { ASSERT_EQ_STR(both[0], "unity-ios"); ASSERT_EQ_STR(both[1], "unity-android"); }

        std::filesystem::remove_all(hub, uec);
    }

    // ---- Unity editor version detection (unity6 / unity<year> capability labels) ----
    {
        std::error_code uec;
        ASSERT_EQ_INT((int)Smith::DetectUnityVersionLabels({}).size(), 0);                    // no roots -> none
        ASSERT_EQ_INT((int)Smith::DetectUnityVersionLabels({ "Q:/no/such/hub" }).size(), 0);  // missing -> none

        std::filesystem::path hub = std::filesystem::temp_directory_path(uec) / ("smith-unityver-test-" + Smith::MakeShortId());
        std::filesystem::remove_all(hub, uec);

        // A version dir with no editor binary yet (Hub still downloading) -> not labeled.
        std::filesystem::create_directories(hub / "6000.0.47f1" / "Editor", uec);
        ASSERT_EQ_INT((int)Smith::DetectUnityVersionLabels({ hub.string() }).size(), 0);

        // Once Editor/Unity.exe lands, the major version becomes "unity6".
        { std::ofstream o(hub / "6000.0.47f1" / "Editor" / "Unity.exe", std::ios::binary); o << "x"; }
        std::vector<std::string> u6 = Smith::DetectUnityVersionLabels({ hub.string() });
        ASSERT_EQ_INT((int)u6.size(), 1);
        if (!u6.empty()) ASSERT_EQ_STR(u6[0], "unity6");

        // A year-scheme editor (Linux layout: Editor/Unity) -> "unity2022", alongside unity6.
        std::filesystem::create_directories(hub / "2022.3.10f1" / "Editor", uec);
        { std::ofstream o(hub / "2022.3.10f1" / "Editor" / "Unity", std::ios::binary); o << "x"; }
        std::vector<std::string> both = Smith::DetectUnityVersionLabels({ hub.string() });
        ASSERT_EQ_INT((int)both.size(), 2);

        std::filesystem::remove_all(hub, uec);
    }

    // ---- Shell capability labels (pure mapping from probed binaries) ----
    {
        auto Has = [](const std::vector<std::string>& v, const std::string& s) {
            return std::find(v.begin(), v.end(), s) != v.end();
        };
        // Linux/Mac with bash, no cmd: just "bash".
        std::vector<std::string> lin = Smith::ShellLabelsFor(false, true, false, false, false);
        ASSERT_EQ_INT((int)lin.size(), 1);
        ASSERT_EQ_STR(lin[0], "bash");

        // POSIX with pwsh (PowerShell Core) -> bash + powershell, never "pwsh".
        std::vector<std::string> pc = Smith::ShellLabelsFor(false, true, true, false, false);
        ASSERT_TRUE(Has(pc, "bash"));
        ASSERT_TRUE(Has(pc, "powershell"));
        ASSERT_TRUE(!Has(pc, "pwsh"));

        // Windows: cmd always; powershell.exe -> "powershell"; git-bash -> "bash".
        std::vector<std::string> win = Smith::ShellLabelsFor(true, true, false, true, true);
        ASSERT_EQ_INT((int)win.size(), 3);
        ASSERT_EQ_STR(win[0], "cmd");          // stable order: cmd, bash, powershell
        ASSERT_TRUE(Has(win, "bash"));
        ASSERT_TRUE(Has(win, "powershell"));

        // Both powershell flavours present -> a single "powershell" label (deduped).
        std::vector<std::string> both = Smith::ShellLabelsFor(true, false, true, true, true);
        ASSERT_EQ_INT((int)both.size(), 2);    // cmd + powershell (no bash)
        ASSERT_EQ_STR(both[1], "powershell");

        // cmd is suppressed off-Windows even if a "cmd" binary somehow resolves.
        std::vector<std::string> nocmd = Smith::ShellLabelsFor(true, false, false, false, false);
        ASSERT_EQ_INT((int)nocmd.size(), 0);

        // Nothing found -> empty.
        ASSERT_EQ_INT((int)Smith::ShellLabelsFor(false, false, false, false, true).size(), 0);
    }

    // ---- Artifact exclude globs (project excludes + built-in never-ship dirs) ----
    {
        // Defaults are appended unless opted out, and never duplicated.
        int nd = (int)Smith::DefaultArtifactExcludes().size();
        ASSERT_TRUE(nd >= 2);
        ASSERT_EQ_INT((int)Smith::EffectiveArtifactExcludes({ "**/Logs/**" }, true).size(), 1 + nd);
        ASSERT_EQ_INT((int)Smith::EffectiveArtifactExcludes({ "**/Logs/**" }, false).size(), 1);
        ASSERT_EQ_INT((int)Smith::EffectiveArtifactExcludes(Smith::DefaultArtifactExcludes(), true).size(), nd); // no dupes

        // The defaults catch Unity's sibling debug folders at any depth while leaving
        // the real build output alone.
        auto excluded = [](const std::string& p) {
            for (const auto& g : Smith::EffectiveArtifactExcludes({}, true))
                if (std::regex_match(p, Smith::GlobToRegex(g))) return true;
            return false;
        };
        ASSERT_TRUE(excluded("Builds/Win/Game_BurstDebugInformation_DoNotShip/lib_burst_generated.txt"));
        ASSERT_TRUE(excluded("Game_BackUpThisFolder_ButDontShipItWithYourGame/Game.pdb")); // root level
        ASSERT_TRUE(!excluded("Builds/Win/Game.exe"));
        ASSERT_TRUE(!excluded("Builds/Win/Game_Data/resources.assets"));
    }

    // ---- Unreal install detection (launcher manifest + directory scan) ----
    {
        // Epic's LauncherInstalled.dat: UE_* entries earn unreal + unreal<major>;
        // the launcher's own entry and garbage are ignored.
        std::vector<std::string> ue = Smith::ParseEpicLauncherInstalled(
            R"({"InstallationList":[
                {"InstallLocation":"C:\\Epic\\UE_5.4","AppName":"UE_5.4","AppVersion":"5.4.4"},
                {"InstallLocation":"C:\\Epic\\UE_4.27","AppName":"UE_4.27","AppVersion":"4.27.2"},
                {"InstallLocation":"C:\\Epic\\Launcher","AppName":"EpicGamesLauncher","AppVersion":"1.0"}]})");
        ASSERT_EQ_INT((int)ue.size(), 3);
        if (ue.size() == 3) { ASSERT_EQ_STR(ue[0], "unreal"); ASSERT_EQ_STR(ue[1], "unreal5"); ASSERT_EQ_STR(ue[2], "unreal4"); }
        ASSERT_EQ_INT((int)Smith::ParseEpicLauncherInstalled("not json").size(), 0);
        ASSERT_EQ_INT((int)Smith::ParseEpicLauncherInstalled(R"({"InstallationList":[]})").size(), 0);

        // Directory scan: UE_* dirs count only with an Engine/ inside (a stray
        // empty UE_ folder is not an install).
        std::error_code rec;
        std::filesystem::path epic = std::filesystem::temp_directory_path(rec) / ("smith-ue-test-" + Smith::MakeShortId());
        std::filesystem::create_directories(epic / "UE_5.6" / "Engine", rec);
        std::filesystem::create_directories(epic / "UE_9.9", rec);            // no Engine -> ignored
        std::filesystem::create_directories(epic / "NotUnreal" / "Engine", rec);
        std::vector<std::string> scanned = Smith::ScanUnrealInstallDirs({ epic.string() });
        ASSERT_EQ_INT((int)scanned.size(), 2);
        if (scanned.size() == 2) { ASSERT_EQ_STR(scanned[0], "unreal"); ASSERT_EQ_STR(scanned[1], "unreal5"); }
        ASSERT_EQ_INT((int)Smith::ScanUnrealInstallDirs({ "Q:/no/such/epic" }).size(), 0);
        std::filesystem::remove_all(epic, rec);
    }

    // ---- Blender detection (installers leave PATH alone, so install dirs are scanned) ----
    {
        std::vector<std::string> libs = Smith::ParseSteamLibraryFolders(
            "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t}\n"
            "\t\"1\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\t\t\"apps\"\n\t\t{\n\t\t\t\"365670\"\t\t\"1\"\n\t\t}\n\t}\n}\n");
        ASSERT_EQ_INT((int)libs.size(), 2);
        if (libs.size() == 2) { ASSERT_EQ_STR(libs[0], "C:\\Program Files (x86)\\Steam"); ASSERT_EQ_STR(libs[1], "D:\\SteamLibrary"); }
        ASSERT_EQ_INT((int)Smith::ParseSteamLibraryFolders("not a vdf").size(), 0);

        namespace bfs = std::filesystem;
        std::error_code bec;
        bfs::path root = bfs::temp_directory_path(bec) / ("smith-blender-test-" + Smith::MakeShortId());
        auto touch = [&](const bfs::path& p) { bfs::create_directories(p.parent_path(), bec); std::ofstream(p, std::ios::binary) << "x"; };
        ASSERT_EQ_STR(Smith::FindBlenderIn({}, {}), "");
        ASSERT_EQ_STR(Smith::FindBlenderIn({ "Q:/no/such/root" }, { "Q:/no/such/blender.exe" }), "");

        // Newest version wins; "x64" in a tarball name is not a version; a dir without the binary
        // (an install in progress) and a non-Blender dir are ignored.
        touch(root / "inst" / "Blender 3.6" / "blender.exe");
        touch(root / "inst" / "blender-4.10.0-linux-x64" / "blender");
        touch(root / "inst" / "Blender 4.2" / "blender.exe");
        bfs::create_directories(root / "inst" / "Blender 9.9", bec);
        touch(root / "inst" / "NotBlender 99" / "blender.exe");
        ASSERT_EQ_STR(Smith::FindBlenderIn({ (root / "inst").string() }, {}),
                      (root / "inst" / "blender-4.10.0-linux-x64" / "blender").string());

        // macOS bundle layout inside a versioned dir.
        touch(root / "mac" / "Blender 4.2" / "Blender.app" / "Contents" / "MacOS" / "Blender");
        ASSERT_EQ_STR(Smith::FindBlenderIn({ (root / "mac").string() }, {}),
                      (root / "mac" / "Blender 4.2" / "Blender.app" / "Contents" / "MacOS" / "Blender").string());

        // No versioned install: the first exact path that exists (e.g. Steam's).
        touch(root / "steam" / "blender.exe");
        ASSERT_EQ_STR(Smith::FindBlenderIn({ (root / "empty").string() },
                                           { (root / "missing.exe").string(), (root / "steam" / "blender.exe").string() }),
                      (root / "steam" / "blender.exe").string());
        bfs::remove_all(root, bec);
    }

    // ---- nvidia-smi VRAM parsing (GPU placement for the Discord bot) ----
    {
        Smith::GpuInfo g = Smith::ParseNvidiaSmiMemory("24576, 23000\n");                       // single GPU
        ASSERT_TRUE(g.present);
        ASSERT_EQ_INT(g.totalMb, 24576);
        ASSERT_EQ_INT(g.freeMb, 23000);

        Smith::GpuInfo two = Smith::ParseNvidiaSmiMemory("24576, 23000\n8192, 8000\n");         // multi-GPU -> summed
        ASSERT_EQ_INT(two.totalMb, 32768);
        ASSERT_EQ_INT(two.freeMb, 31000);

        Smith::GpuInfo sp = Smith::ParseNvidiaSmiMemory(" 16384 ,  100 ");                       // tolerate spaces
        ASSERT_TRUE(sp.present);
        ASSERT_EQ_INT(sp.totalMb, 16384);
        ASSERT_EQ_INT(sp.freeMb, 100);

        Smith::GpuInfo none = Smith::ParseNvidiaSmiMemory("");                                   // no GPU
        ASSERT_TRUE(!none.present);
        ASSERT_EQ_INT(none.totalMb, 0);
        Smith::GpuInfo junk = Smith::ParseNvidiaSmiMemory("No devices were found\n");            // garbage -> none
        ASSERT_TRUE(!junk.present);
    }

    // ---- Cloudflare dynamic-DNS helpers ----
    {
        ASSERT_TRUE(Smith::IsIpv4("86.156.132.32"));
        ASSERT_TRUE(Smith::IsIpv4("0.0.0.0"));
        ASSERT_TRUE(!Smith::IsIpv4("1.2.3"));
        ASSERT_TRUE(!Smith::IsIpv4("1.2.3.4.5"));
        ASSERT_TRUE(!Smith::IsIpv4("256.1.1.1"));
        ASSERT_TRUE(!Smith::IsIpv4("1.2.3."));
        ASSERT_TRUE(!Smith::IsIpv4(""));
        ASSERT_EQ_STR(Smith::TrimWhitespace("  86.1.2.3\n"), "86.1.2.3");

        std::string id, ip;
        ASSERT_TRUE(Smith::ParseCloudflareFirstId("{\"success\":true,\"result\":[{\"id\":\"zone123\"}]}", id));
        ASSERT_EQ_STR(id, "zone123");
        ASSERT_TRUE(!Smith::ParseCloudflareFirstId("{\"success\":true,\"result\":[]}", id));     // empty result
        ASSERT_TRUE(!Smith::ParseCloudflareFirstId("{\"success\":false}", id));                  // not success

        ASSERT_TRUE(Smith::ParseCloudflareRecord("{\"success\":true,\"result\":[{\"id\":\"rec9\",\"content\":\"1.2.3.4\"}]}", id, ip));
        ASSERT_EQ_STR(id, "rec9");
        ASSERT_EQ_STR(ip, "1.2.3.4");

        std::string body = Smith::CloudflareUpdateBody("smith.example.com", "9.9.9.9", true);
        ASSERT_TRUE(body.find("9.9.9.9") != std::string::npos);
        ASSERT_TRUE(body.find("\"proxied\":true") != std::string::npos);
        ASSERT_TRUE(body.find("smith.example.com") != std::string::npos);

        ASSERT_TRUE(Smith::CloudflareSucceeded("{\"success\":true,\"result\":{}}"));
        ASSERT_TRUE(!Smith::CloudflareSucceeded("{\"success\":false}"));
        ASSERT_TRUE(!Smith::CloudflareSucceeded("not json"));
    }

    // ---- GitHub token URL helpers (managed-PAT agent checkout) ----
    {
        using Smith::IsGitHubUrl;
        using Smith::ToHttpsGitHubUrl;
        using Smith::GitHubExtraHeader;

        ASSERT_TRUE(IsGitHubUrl("git@github.com:Red-Marmoset/soccer-boy.git"));
        ASSERT_TRUE(IsGitHubUrl("https://github.com/Red-Marmoset/soccer-boy.git"));
        ASSERT_TRUE(IsGitHubUrl("ssh://git@github.com/owner/repo.git"));
        ASSERT_TRUE(!IsGitHubUrl("git@gitlab.com:owner/repo.git"));
        ASSERT_TRUE(!IsGitHubUrl("C:/local/repo"));
        ASSERT_TRUE(!IsGitHubUrl(""));

        // scp + ssh forms convert to https; the owner/repo path is preserved.
        ASSERT_EQ_STR(ToHttpsGitHubUrl("git@github.com:Red-Marmoset/soccer-boy.git"),
                      "https://github.com/Red-Marmoset/soccer-boy.git");
        ASSERT_EQ_STR(ToHttpsGitHubUrl("ssh://git@github.com/owner/repo.git"),
                      "https://github.com/owner/repo.git");
        // already-https passes through; any embedded userinfo is dropped.
        ASSERT_EQ_STR(ToHttpsGitHubUrl("https://github.com/owner/repo.git"),
                      "https://github.com/owner/repo.git");
        ASSERT_EQ_STR(ToHttpsGitHubUrl("https://x-access-token@github.com/owner/repo.git"),
                      "https://github.com/owner/repo.git");
        // non-GitHub URLs are returned unchanged - never rewritten to github.
        ASSERT_EQ_STR(ToHttpsGitHubUrl("git@gitlab.com:owner/repo.git"),
                      "git@gitlab.com:owner/repo.git");

        // Auth header is HTTP Basic of "x-access-token:<token>"; empty token -> "".
        ASSERT_EQ_STR(GitHubExtraHeader(""), "");
        ASSERT_EQ_STR(GitHubExtraHeader("tok"), "Authorization: Basic eC1hY2Nlc3MtdG9rZW46dG9r");
        // the raw token must never appear in the header value.
        ASSERT_TRUE(GitHubExtraHeader("supersecret").find("supersecret") == std::string::npos);
    }

    // ---- Build diagnostics parser ----
    {
        using Smith::ParseBuildDiagnostics;
        using Smith::BuildDiagnostics;

        // MSVC: errors + warning + linker, with /showIncludes noise that must not count.
        {
            std::string log =
                "Note: including file:  C:\\foo\\bar.h\n"
                "C:\\code\\smith\\Foo.cpp(142): error C2065: 'foo': undeclared identifier\n"
                "C:\\code\\smith\\Foo.cpp(88): warning C4244: '=': conversion, possible loss of data\n"
                "Bar.obj : error LNK2019: unresolved external symbol WebPFree\n"
                "Note: including file:   C:\\foo\\baz.h\n";
            BuildDiagnostics d = ParseBuildDiagnostics(log);
            ASSERT_TRUE(d.parsed);
            ASSERT_EQ_INT(d.errorCount, 2);
            ASSERT_EQ_INT(d.warningCount, 1);
            ASSERT_EQ_INT((int)d.errors.size(), 2);
            ASSERT_EQ_STR(d.errors[0].code, "C2065");
            ASSERT_EQ_STR(d.errors[0].location, "C:\\code\\smith\\Foo.cpp(142)");
            ASSERT_EQ_STR(d.errors[1].code, "LNK2019");
            ASSERT_EQ_STR(d.errors[1].tool, "linker");
            ASSERT_EQ_STR(d.warnings[0].code, "C4244");
        }

        // clang: the "N warnings generated." summary must not double-count.
        {
            std::string log =
                "/home/x/Foo.cpp:10:5: warning: unused variable 'y' [-Wunused-variable]\n"
                "/home/x/Foo.cpp:20:1: error: use of undeclared identifier 'z'\n"
                "2 warnings generated.\n"
                "1 error generated.\n";
            BuildDiagnostics d = ParseBuildDiagnostics(log);
            ASSERT_EQ_INT(d.errorCount, 1);
            ASSERT_EQ_INT(d.warningCount, 1);
            ASSERT_EQ_STR(d.warnings[0].tool, "clang");
            ASSERT_EQ_STR(d.warnings[0].location, "/home/x/Foo.cpp:10:5");
        }

        // Engine test-runner framing: suites, per-suite counts, a failing assertion,
        // and the 40-'=' separator which must NOT be read as a suite.
        {
            std::string log =
                "======== SmithCoreTest ========\n"
                "SmithCore tests\n\n"
                "Test Results: 80 Passed, 0 Failed\n"
                "SmithCoreTest passed\n"
                "======== SmithCoordinatorTest ========\n"
                "FAIL: Line 142: expected 200, got 404\n"
                "Test Results: 24 Passed, 1 Failed\n"
                "SmithCoordinatorTest FAILED (exit 1)\n"
                "========================================\n"
                "1 TEST PROJECT(S) FAILED, 1 PASSED\n";
            BuildDiagnostics d = ParseBuildDiagnostics(log);
            ASSERT_EQ_INT(d.suiteCount, 2);
            ASSERT_EQ_INT((int)d.suites.size(), 2);
            ASSERT_EQ_INT(d.testsPassed, 104);
            ASSERT_EQ_INT(d.testsFailed, 1);
            ASSERT_EQ_INT(d.errorCount, 0);
            ASSERT_EQ_STR(d.suites[0].name, "SmithCoreTest");
            ASSERT_EQ_STR(d.suites[0].status, "passed");
            ASSERT_EQ_INT(d.suites[0].passed, 80);
            ASSERT_EQ_STR(d.suites[1].name, "SmithCoordinatorTest");
            ASSERT_EQ_STR(d.suites[1].status, "failed");
            ASSERT_EQ_INT(d.suites[1].failed, 1);
            ASSERT_EQ_INT((int)d.suites[1].failures.size(), 1);
            ASSERT_EQ_STR(d.suites[1].failures[0].text, "Line 142: expected 200, got 404");
        }

        // Project-level totals are used only when no per-suite "Test Results:" appears.
        {
            std::string log =
                "======== Foo ========\n"
                "Foo passed\n"
                "======== Bar ========\n"
                "Bar passed\n"
                "========================================\n"
                "ALL 2 TEST PROJECT(S) PASSED\n";
            BuildDiagnostics d = ParseBuildDiagnostics(log);
            ASSERT_EQ_INT(d.suiteCount, 2);
            ASSERT_EQ_INT(d.testsPassed, 2);
            ASSERT_EQ_INT(d.testsFailed, 0);
        }

        // Unity batchmode failure (the exit-0 false-green): markers count as errors.
        {
            std::string log =
                "Aborting batchmode due to failure\n"
                "Player build result: Failed\n";
            BuildDiagnostics d = ParseBuildDiagnostics(log);
            ASSERT_EQ_INT(d.errorCount, 2);
            ASSERT_EQ_STR(d.errors[0].tool, "unity");
        }

        // BuildFailedException carries the CAUSE (e.g. a scripting-backend
        // mismatch in the output dir) - it must surface as an error with its text.
        {
            std::string log =
                "BuildFailedException: Build path contains a project previously built with "
                "the Mono2x scripting backend, the current setting is for IL2CPP\n"
                "Error building Player\n";
            BuildDiagnostics d = ParseBuildDiagnostics(log);
            ASSERT_EQ_INT(d.errorCount, 2);
            ASSERT_EQ_STR(d.errors[0].tool, "unity");
            ASSERT_TRUE(d.errors[0].text.find("Mono2x scripting backend") != std::string::npos);
        }

        // Lists cap at 200 but counts stay true past the cap.
        {
            std::string log;
            for (int i = 0; i < 250; ++i)
                log += "Foo.cpp(" + std::to_string(i + 1) + "): warning C4100: unreferenced parameter\n";
            BuildDiagnostics d = ParseBuildDiagnostics(log);
            ASSERT_EQ_INT(d.warningCount, 250);
            ASSERT_EQ_INT((int)d.warnings.size(), 200);
            ASSERT_TRUE(d.truncated);
        }

        // A clean log yields nothing.
        {
            BuildDiagnostics d = ParseBuildDiagnostics("Build succeeded.\nAll good.\n");
            ASSERT_EQ_INT(d.errorCount, 0);
            ASSERT_EQ_INT(d.warningCount, 0);
            ASSERT_EQ_INT(d.suiteCount, 0);
            ASSERT_TRUE(d.parsed);
            ASSERT_TRUE(!d.truncated);
        }
    }

    // ---- Git URL validation ----
    {
        using Smith::ValidateGitUrl;
        // Valid forms return "".
        ASSERT_EQ_STR(ValidateGitUrl("git@github.com:org/repo.git"), "");
        ASSERT_EQ_STR(ValidateGitUrl("https://github.com/org/repo.git"), "");
        ASSERT_EQ_STR(ValidateGitUrl("ssh://git@host/path/repo.git"), "");
        ASSERT_EQ_STR(ValidateGitUrl("file:///srv/repos/x.git"), "");
        ASSERT_EQ_STR(ValidateGitUrl("C:\\code\\smith"), "");
        ASSERT_EQ_STR(ValidateGitUrl("/home/user/repo"), "");   // absolute local path (no @ + :)
        ASSERT_EQ_STR(ValidateGitUrl("org/repo"), "");          // bareword/relative, accepted leniently
        ASSERT_EQ_STR(ValidateGitUrl("  git@github.com:org/repo.git  "), "");   // trimmed
        // Invalid forms return a message.
        ASSERT_TRUE(!ValidateGitUrl("").empty());
        ASSERT_TRUE(!ValidateGitUrl("   ").empty());
        ASSERT_TRUE(!ValidateGitUrl("/git@github.com:org/repo").empty());   // the stray-leading-slash case
        ASSERT_TRUE(!ValidateGitUrl("ftp://host/x").empty());               // unsupported scheme
    }

    // ---- Base64 / base64url ----
    {
        using Smith::Base64Encode; using Smith::Base64UrlEncode; using Smith::Base64UrlDecode;
        ASSERT_EQ_STR(Base64Encode("foobar"), "Zm9vYmFy");
        ASSERT_EQ_STR(Base64Encode("fo"), "Zm8=");          // standard padding
        ASSERT_EQ_STR(Base64UrlEncode("fo"), "Zm8");        // url: no padding

        std::string out;
        ASSERT_TRUE(Base64UrlDecode("Zm9vYmFy", out) && out == "foobar");
        ASSERT_TRUE(Base64UrlDecode("Zm8", out) && out == "fo");      // missing padding tolerated
        ASSERT_TRUE(Base64UrlDecode("Zm8=", out) && out == "fo");     // padding accepted
        // url-safe and standard alphabets decode identically.
        std::string a, b;
        ASSERT_TRUE(Base64UrlDecode("a-b_", a) && Base64UrlDecode("a+b/", b) && a == b);
        // round-trip arbitrary bytes through the url encoder.
        std::string blob; for (int i = 0; i < 256; ++i) blob.push_back((char)i);
        ASSERT_TRUE(Base64UrlDecode(Base64UrlEncode(blob), out) && out == blob);
        // invalid character -> false.
        ASSERT_TRUE(!Base64UrlDecode("@@@@", out));
    }

    // ---- Google ID-token claim parsing + validation ----
    {
        using namespace Smith;
        const std::vector<std::string> domains = { "redmarmosetstudios.com" };
        const std::set<std::string> noEmails;
        const std::set<std::string> withEmail = { "contractor@gmail.com" };

        // DecodeJwtPayloadUnverified: build a JWT payload with our own url encoder.
        {
            std::string payload = R"({"aud":"client123","sub":"42","email":"alice@redmarmosetstudios.com","email_verified":true,"name":"Alice","hd":"redmarmosetstudios.com","exp":2000000000})";
            std::string jwt = "eyJhbGciOiJSUzI1NiJ9." + Base64UrlEncode(payload) + ".sig";
            GoogleClaims c; std::string err;
            ASSERT_TRUE(DecodeJwtPayloadUnverified(jwt, c, err));
            ASSERT_EQ_STR(c.aud, "client123");
            ASSERT_EQ_STR(c.email, "alice@redmarmosetstudios.com");
            ASSERT_EQ_STR(c.hd, "redmarmosetstudios.com");
            ASSERT_TRUE(c.emailVerified);
            ASSERT_TRUE(c.expMs == 2000000000000LL);
            GoogleClaims c2; std::string e2;
            ASSERT_TRUE(!DecodeJwtPayloadUnverified("not-a-jwt", c2, e2));   // no '.'
        }

        // ParseTokenInfoJson: Google returns email_verified + exp as STRINGS.
        {
            GoogleClaims c; std::string err;
            std::string ti = R"({"aud":"client123","sub":"42","email":"bob@redmarmosetstudios.com","email_verified":"true","exp":"2000000000","hd":"redmarmosetstudios.com"})";
            ASSERT_TRUE(ParseTokenInfoJson(ti, c, err));
            ASSERT_TRUE(c.emailVerified);
            ASSERT_TRUE(c.expMs == 2000000000000LL);
            // an {error:...} response is rejected.
            GoogleClaims c2; std::string e2;
            ASSERT_TRUE(!ParseTokenInfoJson(R"({"error":"invalid_token","error_description":"Invalid Value"})", c2, e2));
            ASSERT_TRUE(!e2.empty());
        }

        // IsAllowedIdentity: domain OR explicit email; case-insensitive; no subdomain slip.
        ASSERT_TRUE(IsAllowedIdentity("alice@redmarmosetstudios.com", "", domains, noEmails));
        ASSERT_TRUE(IsAllowedIdentity("Alice@RedMarmosetStudios.COM", "", domains, noEmails));
        ASSERT_TRUE(!IsAllowedIdentity("x@sub.redmarmosetstudios.com", "", domains, noEmails));
        ASSERT_TRUE(IsAllowedIdentity("contractor@gmail.com", "", domains, withEmail));   // explicit email
        ASSERT_TRUE(!IsAllowedIdentity("rando@gmail.com", "", domains, noEmails));
        ASSERT_TRUE(IsAllowedIdentity("weird@alias.example", "redmarmosetstudios.com", domains, noEmails)); // hd grant
        ASSERT_TRUE(!IsAllowedIdentity("x@gmail.com", "", {}, noEmails));                 // empty domains, no grant

        // ValidateGoogleClaims: full policy.
        const int64_t now = 1700000000000LL;   // ~2023, before exp 2033
        GoogleClaims good; good.aud = "client123"; good.email = "alice@redmarmosetstudios.com";
        good.emailVerified = true; good.expMs = 2000000000000LL; good.hd = "redmarmosetstudios.com";
        ASSERT_EQ_STR(ValidateGoogleClaims(good, "client123", domains, noEmails, now), "");
        { GoogleClaims c = good; c.aud = "other";          ASSERT_TRUE(!ValidateGoogleClaims(c, "client123", domains, noEmails, now).empty()); }
        { GoogleClaims c = good; c.emailVerified = false;  ASSERT_TRUE(!ValidateGoogleClaims(c, "client123", domains, noEmails, now).empty()); }
        { GoogleClaims c = good; c.expMs = 1000;           ASSERT_TRUE(!ValidateGoogleClaims(c, "client123", domains, noEmails, now).empty()); }
        { GoogleClaims c = good; c.email = "x@gmail.com"; c.hd = ""; ASSERT_TRUE(!ValidateGoogleClaims(c, "client123", domains, noEmails, now).empty()); }
        // out-of-domain email accepted when on the explicit allowlist.
        { GoogleClaims c = good; c.email = "contractor@gmail.com"; c.hd = "";
          ASSERT_EQ_STR(ValidateGoogleClaims(c, "client123", domains, withEmail, now), ""); }
    }

    // ---- Session token entropy ----
    {
        std::string t1 = Smith::MakeSessionToken(), t2 = Smith::MakeSessionToken();
        ASSERT_EQ_INT((int)t1.size(), 64);
        ASSERT_TRUE(t1 != t2);
    }

    // ---- Coordinator config file (JSON) + CLI override ----
    {
        std::filesystem::path cfg = std::filesystem::temp_directory_path() / "smith-cfg-test.json";
        {
            std::ofstream o(cfg, std::ios::binary);
            o << R"({"port":9999,"withAgent":true,"discovery":false,
                  "auth":{"googleClientId":"cid.apps.googleusercontent.com",
                  "allowedDomains":["example.com"],"allowedEmails":["x@gmail.com"],"requireLogin":true}})";
        }
        std::string cs = cfg.string();
        auto parse = [](std::vector<std::string> a) {
            std::vector<char*> v; for (auto& s : a) v.push_back(const_cast<char*>(s.c_str()));
            return Smith::ParseCoordinatorArgs((int)v.size(), v.data(), 2);
        };
        {   // values come from the file
            Smith::CoordinatorConfig c = parse({ "smith", "coordinator", "--config", cs });
            ASSERT_EQ_INT(c.port, 9999);
            ASSERT_TRUE(c.withAgent);
            ASSERT_TRUE(!c.discoveryEnabled);
            ASSERT_EQ_STR(c.googleClientId, "cid.apps.googleusercontent.com");
            ASSERT_TRUE(c.requireLogin);
            ASSERT_TRUE(c.googleAllowedDomains.size() == 1 && c.googleAllowedDomains[0] == "example.com");
            ASSERT_TRUE(c.googleAllowedEmails.size() == 1 && c.googleAllowedEmails[0] == "x@gmail.com");
        }
        {   // a CLI flag overrides the file; other file values remain
            Smith::CoordinatorConfig c = parse({ "smith", "coordinator", "--config", cs, "--port", "12345" });
            ASSERT_EQ_INT(c.port, 12345);
            ASSERT_EQ_STR(c.googleClientId, "cid.apps.googleusercontent.com");
            ASSERT_TRUE(c.requireLogin);
        }
        std::error_code ec; std::filesystem::remove(cfg, ec);
    }

    // ---- Discord config: load + save round-trip (Settings UI write-back) ----
    {
        std::filesystem::path p = std::filesystem::temp_directory_path() / ("smith-discord-cfg-" + Smith::MakeShortId() + ".json");
        {
            std::ofstream o(p, std::ios::binary);
            o << R"({"discord":{"enabled":true,"token":"botsecret","notifyChannelId":"123",
                  "commandChannels":["c1","c2"],"allowRoles":["r1"],"ollamaModel":"qwen3.5:9b",
                  "pinNode":"gpu-box","notifyStart":false,"confirmDeploy":false}})";
        }
        Smith::CoordinatorConfig c;
        Smith::LoadCoordinatorConfigFile(p.string(), c);
        ASSERT_TRUE(c.discordEnabled);
        ASSERT_EQ_STR(c.discordToken, "botsecret");
        ASSERT_EQ_STR(c.discordNotifyChannelId, "123");
        ASSERT_EQ_INT((int)c.discordCommandChannels.size(), 2);
        ASSERT_EQ_STR(c.discordCommandChannels[1], "c2");
        ASSERT_EQ_INT((int)c.discordAllowRoles.size(), 1);
        ASSERT_EQ_STR(c.ollamaModel, "qwen3.5:9b");
        ASSERT_EQ_STR(c.discordPinNode, "gpu-box");
        ASSERT_TRUE(!c.discordNotifyStart);
        ASSERT_TRUE(!c.discordConfirmDeploy);
        ASSERT_TRUE(c.discordNotifySuccess);            // default kept (not in file)

        // Save to a fresh file and reload: values survive the round-trip.
        std::filesystem::path p2 = std::filesystem::temp_directory_path() / ("smith-discord-cfg2-" + Smith::MakeShortId() + ".json");
        Smith::SaveCoordinatorConfigFile(p2.string(), c);
        Smith::CoordinatorConfig c2;
        Smith::LoadCoordinatorConfigFile(p2.string(), c2);
        ASSERT_TRUE(c2.discordEnabled);
        ASSERT_EQ_STR(c2.discordToken, "botsecret");
        ASSERT_EQ_INT((int)c2.discordCommandChannels.size(), 2);
        ASSERT_EQ_STR(c2.ollamaModel, "qwen3.5:9b");
        ASSERT_TRUE(!c2.discordConfirmDeploy);
        std::error_code ec; std::filesystem::remove(p, ec); std::filesystem::remove(p2, ec);
    }

    // ---- Config last-known-good fallback: a broken hand edit must not drop the whole file ----
    {
        std::filesystem::path dir = std::filesystem::temp_directory_path() / ("smith-lkg-" + Smith::MakeShortId());
        std::filesystem::create_directories(dir);
        std::string cfgPath = (dir / "smith-coordinator.json").string();
        std::string lkgPath = Smith::LastKnownGoodConfigPath(cfgPath);
        ASSERT_EQ_STR(lkgPath, (dir / "smith-coordinator.lkg.json").string());
        auto write = [](const std::string& path, const std::string& text) { std::ofstream o(path, std::ios::binary | std::ios::trunc); o << text; };
        auto parse = [](std::vector<std::string> a) {
            std::vector<char*> v; for (auto& s : a) v.push_back(const_cast<char*>(s.c_str()));
            return Smith::ParseCoordinatorArgs((int)v.size(), v.data(), 2);
        };

        // A good load (UTF-8 BOM and all, as PowerShell writes it) is copied to the LKG file.
        write(cfgPath, "\xEF\xBB\xBF{\"withAgent\":true,\"port\":9990,\"discord\":{\"enabled\":true,\"token\":\"tok\"},"
                       "\"env\":{\"UNA_ENGINE_PATH\":\"C:\\\\code\\\\engine\"}}");
        {
            Smith::CoordinatorConfig c = parse({ "smith", "coordinator", "--config", cfgPath });
            ASSERT_EQ_STR(c.configError, "");
            ASSERT_TRUE(!c.configUsingLastKnownGood);
            ASSERT_TRUE(c.withAgent);
            ASSERT_TRUE(std::filesystem::exists(lkgPath));
            ASSERT_EQ_STR(Smith::CheckCoordinatorConfigFile(cfgPath), "");
        }

        // Today's outage: a missing comma in "env". The LKG copy stands in; the error has a
        // position but none of the file's text (it holds secrets and is posted to Discord).
        write(cfgPath, "{\"withAgent\":false,\"port\":1,\"env\":{\"UNA_ENGINE_PATH\":\"x\"\n\"ASC_KEY_ID\":\"SECRETKEY\"}}");
        {
            std::string err = Smith::CheckCoordinatorConfigFile(cfgPath);
            ASSERT_TRUE(err.find("line 2") != std::string::npos);
            ASSERT_TRUE(err.find("SECRETKEY") == std::string::npos && err.find("ASC_KEY_ID") == std::string::npos);
            ASSERT_TRUE(err.find("json.exception") == std::string::npos);

            Smith::CoordinatorConfig c = parse({ "smith", "coordinator", "--config", cfgPath });
            ASSERT_EQ_STR(c.configError, err);
            ASSERT_TRUE(c.configUsingLastKnownGood);
            ASSERT_TRUE(c.withAgent);                       // from the LKG copy, not the broken file
            ASSERT_EQ_INT(c.port, 9990);
            ASSERT_TRUE(c.discordEnabled);
            ASSERT_EQ_STR(c.configPath, cfgPath);           // still the file to fix

            // A failed load leaves the LKG copy alone (it must not be replaced by the broken file).
            std::ifstream in(lkgPath, std::ios::binary); std::stringstream ss; ss << in.rdbuf();
            ASSERT_TRUE(ss.str().find("9990") != std::string::npos);

            // Settings write-back refuses to flatten the broken file into UI-only keys.
            ASSERT_TRUE(!Smith::SaveCoordinatorConfigFile(cfgPath, c));
            std::ifstream in2(cfgPath, std::ios::binary); std::stringstream ss2; ss2 << in2.rdbuf();
            ASSERT_TRUE(ss2.str().find("SECRETKEY") != std::string::npos);
        }

        // Broken file and no LKG: defaults, and the error is still reported.
        {
            std::error_code ec; std::filesystem::remove(lkgPath, ec);
            Smith::CoordinatorConfig c = parse({ "smith", "coordinator", "--config", cfgPath });
            ASSERT_TRUE(!c.configError.empty());
            ASSERT_TRUE(!c.configUsingLastKnownGood);
            ASSERT_TRUE(!c.withAgent);
        }

        std::error_code ec; std::filesystem::remove_all(dir, ec);
    }

    // ---- Chains: smith.json parsing + variant slugs ----
    {
        Smith::ProjectDef p;
        std::string err;
        ASSERT_TRUE(Smith::ParseProjectConfig(R"JSON({
            "project": { "id": "demo" },
            "buildProducts": [{
                "name": "unity",
                "discover": { "type": "list", "values": ["Steam (Windows)", "Steam (Mac)"], "as": "PROFILE" },
                "rules": [{ "name": "r", "branches": ["*"], "command": { "windows": { "interpreter": "ps1", "script": "b.ps1" } } }]
            }],
            "chains": [{
                "name": "steam-release",
                "builds": [{ "product": "unity", "variants": ["steam-windows", "steam-mac"] }],
                "then":   [{ "product": "steam-deploy" }],
                "onFailure": "cancel",
                "pinCommit": false
            }]
        })JSON", p, err));
        ASSERT_EQ_INT((int)p.chains.size(), 1);
        ASSERT_EQ_STR(p.chains[0].name, "steam-release");
        ASSERT_EQ_INT((int)p.chains[0].builds.size(), 1);
        ASSERT_EQ_INT((int)p.chains[0].builds[0].variants.size(), 2);
        ASSERT_EQ_STR(p.chains[0].then[0].product, "steam-deploy");
        ASSERT_EQ_STR(p.chains[0].onFailure, "cancel");
        ASSERT_EQ_INT(p.chains[0].pinCommit, 0);

        // Discovered variants carry their slug alias.
        Smith::DiscoverSpec spec; spec.type = "list"; spec.values = { "Steam (Windows)" };
        std::vector<Smith::ProductVariant> vars = Smith::DiscoverVariants("", spec);
        ASSERT_EQ_INT((int)vars.size(), 1);
        ASSERT_EQ_STR(vars[0].slug, "steam-windows");
    }

    // ---- Batch state machine ----
    {
        auto mkBatch = [](const std::string& onFailure) {
            Smith::BatchDef b;
            b.id = "B1"; b.projectId = "demo"; b.name = "steam-release"; b.onFailure = onFailure;
            b.builds = { { "j1", "unity", "Steam (Windows)" }, { "j2", "unity", "Steam (Mac)" } };
            b.then = { { "", "steam-deploy", "" } };
            return b;
        };

        {   // happy path: builds succeed -> deploying (queue then) -> succeeded
            Smith::BatchDef b = mkBatch("finish");
            std::map<std::string, std::string> st = { { "j1", std::string("success") } };
            Smith::BatchActions a = Smith::BatchAdvance(b, st);
            ASSERT_TRUE(!a.queueThen);
            ASSERT_EQ_STR(b.status, "building");
            st["j2"] = "success";
            a = Smith::BatchAdvance(b, st);
            ASSERT_TRUE(a.changed && a.queueThen);
            ASSERT_EQ_STR(b.status, "deploying");
            b.then[0].jobId = "j3";
            st["j3"] = "success";
            a = Smith::BatchAdvance(b, st);
            ASSERT_TRUE(a.changed);
            ASSERT_EQ_STR(b.status, "succeeded");
        }
        {   // a build fails under "finish": batch fails, nothing cancelled, then never queued
            Smith::BatchDef b = mkBatch("finish");
            std::map<std::string, std::string> st = { { "j1", "failed" } };
            Smith::BatchActions a = Smith::BatchAdvance(b, st);
            ASSERT_TRUE(a.changed && !a.queueThen);
            ASSERT_EQ_STR(b.status, "failed");
            ASSERT_EQ_INT((int)a.cancelJobIds.size(), 0);
            ASSERT_TRUE(b.detail.find("follow-up step will not run") != std::string::npos);
        }
        {   // a build fails under "cancel": surviving sibling is cancelled
            Smith::BatchDef b = mkBatch("cancel");
            std::map<std::string, std::string> st = { { "j1", "failed" }, { "j2", "running" } };
            Smith::BatchActions a = Smith::BatchAdvance(b, st);
            ASSERT_EQ_STR(b.status, "failed");
            ASSERT_EQ_INT((int)a.cancelJobIds.size(), 1);
            ASSERT_EQ_STR(a.cancelJobIds[0], "j2");
        }
        {   // the then job fails -> batch failed
            Smith::BatchDef b = mkBatch("finish");
            std::map<std::string, std::string> st = { { "j1", "success" }, { "j2", "success" } };
            Smith::BatchAdvance(b, st);
            b.then[0].jobId = "j3";
            st["j3"] = "error";
            Smith::BatchActions a = Smith::BatchAdvance(b, st);
            ASSERT_TRUE(a.changed);
            ASSERT_EQ_STR(b.status, "failed");
        }
        {   // no then steps at all: building -> succeeded directly
            Smith::BatchDef b = mkBatch("finish");
            b.then.clear();
            std::map<std::string, std::string> st = { { "j1", "success" }, { "j2", "success" } };
            Smith::BatchActions a = Smith::BatchAdvance(b, st);
            ASSERT_TRUE(a.changed && !a.queueThen);
            ASSERT_EQ_STR(b.status, "succeeded");
        }
    }

    // ---- Batch + placement config keys: load + save round-trip ----
    {
        std::filesystem::path p = std::filesystem::temp_directory_path() / ("smith-batch-cfg-" + Smith::MakeShortId() + ".json");
        {
            std::ofstream o(p, std::ios::binary);
            o << R"({"batch":{"onFailure":"cancel","pinCommit":false,"keep":7},
                     "discord":{"migrateMarginMb":1024,"hostFailureCooldownSec":120}})";
        }
        Smith::CoordinatorConfig c;
        Smith::LoadCoordinatorConfigFile(p.string(), c);
        ASSERT_EQ_STR(c.batchOnFailure, "cancel");
        ASSERT_TRUE(!c.batchPinCommit);
        ASSERT_EQ_INT(c.batchKeep, 7);
        ASSERT_EQ_INT(c.discordMigrateMarginMb, 1024);
        ASSERT_EQ_INT(c.discordHostFailureCooldownSec, 120);

        std::filesystem::path p2 = std::filesystem::temp_directory_path() / ("smith-batch-cfg2-" + Smith::MakeShortId() + ".json");
        Smith::SaveCoordinatorConfigFile(p2.string(), c);
        Smith::CoordinatorConfig c2;
        Smith::LoadCoordinatorConfigFile(p2.string(), c2);
        ASSERT_EQ_STR(c2.batchOnFailure, "cancel");
        ASSERT_EQ_INT(c2.batchKeep, 7);
        ASSERT_EQ_INT(c2.discordMigrateMarginMb, 1024);
        std::error_code ec; std::filesystem::remove(p, ec); std::filesystem::remove(p2, ec);
    }

    // ---- Housekeeping: log pruning + disk query ----
    {
        namespace fs = std::filesystem;
        auto noLog = [](bool, const std::string&) {};

        fs::path logDir = fs::temp_directory_path() / ("smith-logs-" + Smith::MakeShortId());
        fs::create_directories(logDir);
        for (int i = 0; i < 6; ++i)
        {
            std::ofstream o(logDir / ("build-" + std::to_string(i) + ".log"), std::ios::binary);
            o << "log " << i << "\n";
        }

        // keepMax: with 6 logs and a cap of 4, two oldest go. Make the indices the
        // age order so the cap is deterministic (lower index = older).
        auto base = fs::file_time_type::clock::now();
        for (int i = 0; i < 6; ++i)
            fs::last_write_time(logDir / ("build-" + std::to_string(i) + ".log"), base + std::chrono::minutes(i));

        int removed = Smith::PruneLogs(logDir.string(), 0 /*no age cap*/, 4, noLog);
        ASSERT_EQ_INT(removed, 2);
        ASSERT_TRUE(!fs::exists(logDir / "build-0.log"));   // oldest two removed
        ASSERT_TRUE(!fs::exists(logDir / "build-1.log"));
        ASSERT_TRUE(fs::exists(logDir / "build-5.log"));    // newest kept

        // Age cap: backdate one remaining log well past the keepDays window.
        fs::last_write_time(logDir / "build-2.log", base - std::chrono::hours(24 * 30));
        int removedOld = Smith::PruneLogs(logDir.string(), 7 /*days*/, 0 /*no count cap*/, noLog);
        ASSERT_EQ_INT(removedOld, 1);
        ASSERT_TRUE(!fs::exists(logDir / "build-2.log"));

        // FreeDiskBytes resolves a non-existent path up to its volume and is > 0.
        ASSERT_TRUE(Smith::FreeDiskBytes((logDir / "does" / "not" / "exist").string()) > 0);

        std::error_code ec; fs::remove_all(logDir, ec);
    }

    printf("\nTest Results: %d Passed, %d Failed\n", passed, failed);
    return failed > 0 ? 1 : 0;
}

} // namespace Test
