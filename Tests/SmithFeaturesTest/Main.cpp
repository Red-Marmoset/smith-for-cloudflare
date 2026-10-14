// Main.cpp - tests for multi-step builds (a per-OS command that is an array of
// ordered steps) and the build matrix ("type":"list" declared variants).
// Follows the engine JsonTest / SmithCoreTest pattern.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include <Test/Test.h>
#include <SmithCore/RepoConfig.h>
#include <SmithCore/Domain.h>

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

    printf("Smith features tests (multi-step + matrix)\n\n");

    // ---- Multi-step builds: a per-OS command may be an array (steps) or object ----
    {
        const char* cfg = R"JSON({
          "schemaVersion": 1,
          "project": { "id": "p", "name": "P" },
          "repos": [ { "name": "main", "primary": true, "url": "u", "defaultBranch": "main" } ],
          "buildProducts": [ { "name": "build", "rules": [
            { "name": "r", "branches": ["*"], "nodeSelector": { "os": "any" },
              "command": {
                "windows": [
                  { "interpreter": "bat", "script": "config.bat" },
                  { "interpreter": "bat", "script": "build.bat", "args": ["-Release"] }
                ],
                "linux": { "interpreter": "sh", "script": "build.sh" }
              } }
          ] } ]
        })JSON";

        Smith::ProjectDef proj;
        std::string err;
        ASSERT_TRUE(Smith::ParseProjectConfig(cfg, proj, err));
        ASSERT_EQ_INT((int)proj.products.size(), 1);
        ASSERT_EQ_INT((int)proj.products[0].rules.size(), 1);
        const Smith::BuildRuleDef& rule = proj.products[0].rules[0];

        // windows is an array -> two ordered steps in stepsByOs.
        ASSERT_EQ_INT((int)rule.stepsByOs.count("windows"), 1);
        ASSERT_EQ_INT((int)rule.stepsByOs.at("windows").size(), 2);
        ASSERT_EQ_STR(rule.stepsByOs.at("windows")[0].script, "config.bat");
        ASSERT_EQ_STR(rule.stepsByOs.at("windows")[1].script, "build.bat");
        ASSERT_EQ_INT((int)rule.stepsByOs.at("windows")[1].args.size(), 1);
        ASSERT_EQ_STR(rule.stepsByOs.at("windows")[1].args[0], "-Release");
        ASSERT_EQ_INT((int)rule.commandByOs.count("windows"), 0);   // not the single-command map

        // linux is a single object -> commandByOs (back-compat), not stepsByOs.
        ASSERT_EQ_INT((int)rule.commandByOs.count("linux"), 1);
        ASSERT_EQ_STR(rule.commandByOs.at("linux").script, "build.sh");
        ASSERT_EQ_INT((int)rule.stepsByOs.count("linux"), 0);
    }

    // ---- Matrix: "type":"list" declared variants, classified to nodes ----
    {
        Smith::DiscoverSpec spec;
        spec.type = "list";
        spec.as = "CONFIG";
        spec.values = { "win-debug", "win-release", "linux-release" };
        Smith::ClassifyRule w; w.match = "^win-";   w.os = "windows"; spec.classify.push_back(w);
        Smith::ClassifyRule l; l.match = "^linux-"; l.os = "linux";   spec.classify.push_back(l);

        std::vector<Smith::ProductVariant> vars = Smith::DiscoverVariants("", spec);
        ASSERT_EQ_INT((int)vars.size(), 3);
        // Sorted by name: linux-release, win-debug, win-release.
        ASSERT_EQ_STR(vars[0].name, "linux-release");
        ASSERT_EQ_STR(vars[0].os, "linux");
        ASSERT_EQ_STR(vars[1].name, "win-debug");
        ASSERT_EQ_STR(vars[1].os, "windows");
        ASSERT_EQ_STR(vars[2].name, "win-release");
        ASSERT_EQ_STR(vars[2].os, "windows");

        // Dedup + skip empties.
        Smith::DiscoverSpec dup; dup.type = "list"; dup.values = { "A", "A", "" };
        ASSERT_EQ_INT((int)Smith::DiscoverVariants("", dup).size(), 1);

        // A "files" discover with no glob yields nothing (no crash).
        Smith::DiscoverSpec files; files.type = "files";
        ASSERT_EQ_INT((int)Smith::DiscoverVariants("", files).size(), 0);

        // An unclassified value defaults to os "any".
        Smith::DiscoverSpec plain; plain.type = "list"; plain.values = { "x" };
        std::vector<Smith::ProductVariant> pv = Smith::DiscoverVariants("", plain);
        ASSERT_EQ_INT((int)pv.size(), 1);
        ASSERT_EQ_STR(pv[0].os, "any");
    }

    printf("\nTest Results: %d Passed, %d Failed\n", passed, failed);
    return failed > 0 ? 1 : 0;
}

} // namespace Test
