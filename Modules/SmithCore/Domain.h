// Domain.h - parsed project model (from a repo's smith.json).
//
// Distinct from the wire JobSpec: this is the coordinator's view of a project's
// build products and rules, from which it resolves a concrete JobSpec to dispatch.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <SmithProtocol/WireTypes.h>

#include <string>
#include <vector>
#include <map>

namespace Smith
{
    struct NodeSelector
    {
        std::string os = "any";           // "windows" | "mac" | "linux" | "any"
        std::vector<std::string> labels;  // all must be present on the node
        std::string preferOs;             // soft affinity: this os gets first dibs (see scheduler)
    };

    struct CommandVariant
    {
        std::string interpreter;          // "ps1" | "bat" | "sh" | "python" | "exe"
        std::string script;
        std::vector<std::string> args;
    };

    // An artifact dependency (fan-in): the rule consumes the collected artifacts
    // of the latest successful build of `product` (+ optional `variant`) on the
    // same project and branch. Resolved to concrete ArtifactInputs at dispatch.
    struct InputDef
    {
        std::string product;
        std::string variant;              // empty matches builds with no variant
    };

    struct BuildRuleDef
    {
        std::string name;
        bool enabled = true;
        std::vector<std::string> branches;             // globs; empty = any branch
        NodeSelector nodeSelector;
        std::map<std::string, CommandVariant> commandByOs; // "windows" -> single command
        std::map<std::string, std::vector<CommandVariant>> stepsByOs; // "windows" -> ordered steps
        std::string workingDir = ".";
        std::map<std::string, std::string> env;
        int timeoutSeconds = 0;
        std::vector<int> successExitCodes;             // empty = {0}
        ArtifactSpec artifacts;
        std::vector<HandoffStep> handoff;
        std::vector<InputDef> inputs;                  // artifacts staged before the command
    };

    // A classify rule maps a discovered variant's name (by regex) to the node it
    // needs - e.g. a profile named "...(Mac)" routes to a mac agent. Generic:
    // Smith knows nothing about Unity; the project supplies the patterns.
    struct ClassifyRule
    {
        std::string match;                // ECMAScript regex, searched in the name
        std::string os;                   // "windows" | "mac" | "linux" | "any"
        std::vector<std::string> labels;  // extra required labels for this variant
        std::string preferOs;             // soft affinity for an os:"any" variant (e.g. "linux")
    };

    // Expands a product into selectable build variants (a build matrix). Either
    // "files" (one variant per matching file in the repo, named by its stem) or
    // "list" (one variant per declared value). Each variant is classified to the
    // node it needs, so e.g. ["win-debug","win-release","linux-release"] with
    // classify rules fans out across configs x OSes. Project-agnostic.
    struct DiscoverSpec
    {
        std::string type;                 // "files" | "list" (empty = no variants)
        std::string glob;                 // for "files": e.g. "Build Profiles/*.asset"
        std::vector<std::string> values;  // for "list": the variant names (matrix entries)
        std::string as = "VARIANT";       // var the chosen name fills (${as}, ${as_SLUG})
        std::vector<ClassifyRule> classify;
    };

    // A concrete discovered variant (filled at load time, not from smith.json).
    struct ProductVariant
    {
        std::string name;                 // filename stem, e.g. "Steam (Windows)"
        std::string slug;                 // SlugifyName(name), e.g. "steam-windows" - a friendly alias
        std::string os = "any";           // resolved via classify
        std::vector<std::string> labels;
        std::string preferOs;             // soft affinity, resolved via classify
    };

    struct BuildProductDef
    {
        std::string name;
        std::vector<BuildRuleDef> rules;
        DiscoverSpec discover;            // optional: expands into selectable variants
        std::string outputPath;          // optional template (e.g. "builds/${PROFILE_SLUG}") -> ${OUTPUT}
        std::vector<ProductVariant> variants;   // runtime: discovered from the repo
    };

    struct RepoDef
    {
        std::string name;
        bool primary = false;
        std::string url;
        std::string defaultBranch = "main";
        std::string checkoutDir = ".";
    };

    struct TriggerDef
    {
        std::string type;                 // manual | poll | schedule | webhook
        std::vector<std::string> branches;
        int intervalSeconds = 0;          // poll cadence
        std::string cron;                 // schedule (5-field)
        std::string product;              // product to build (empty = first product)
    };

    // One step of a chain: a product plus the variants to build of it. Variants
    // accept names or slugs; empty = every discovered variant of the product.
    struct ChainStep
    {
        std::string product;
        std::vector<std::string> variants;
    };

    // A named, repo-declared batch: queue `builds` in parallel (one job per
    // product x variant), and when ALL succeed, queue `then` (typically a deploy
    // whose rule consumes the fresh artifacts via its `inputs`).
    struct ChainDef
    {
        std::string name;                 // e.g. "steam-release"
        std::vector<ChainStep> builds;
        std::vector<ChainStep> then;
        std::string onFailure;            // "" = coordinator default | "finish" | "cancel"
        // pinCommit: -1 = coordinator default, 0/1 explicit per-chain override
        int pinCommit = -1;
    };

    struct ProjectDef
    {
        int schemaVersion = 1;
        std::string id;
        std::string name;
        std::string description;
        std::vector<RepoDef> repos;
        NodeSelector defaultNodeSelector;
        std::vector<BuildProductDef> products;
        std::vector<TriggerDef> triggers;
        std::vector<ChainDef> chains;     // named multi-build batches with a gated follow-up
        std::string localDir;             // runtime: where the repo is checked out (for discovery)
    };

    // ---- Variant discovery (Variants.cpp; generic, no project-type knowledge) --

    // Lowercase, non-alphanumeric -> '-', collapsed and trimmed. Mirrors the slug
    // a build script is expected to use for its per-variant output folder.
    std::string SlugifyName(const std::string& raw);

    // Apply a spec's classify rules to a variant name (first regex match wins).
    ProductVariant ClassifyVariant(const std::string& name, const DiscoverSpec& spec);

    // Glob baseDir for spec.glob; one variant per matching file (name = stem), each
    // classified. Sorted by name and de-duplicated. Empty if spec has no glob.
    std::vector<ProductVariant> DiscoverVariants(const std::string& baseDir, const DiscoverSpec& spec);
}
