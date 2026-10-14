// RepoConfig.cpp - smith.json -> ProjectDef.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "RepoConfig.h"

#include <json/single_include/nlohmann/json.hpp>

#include <fstream>
#include <sstream>
#include <filesystem>
#include <algorithm>

using nlohmann::json;
namespace fs = std::filesystem;

namespace Smith
{
    static std::vector<std::string> StrArray(const json& j, const char* key)
    {
        std::vector<std::string> out;
        if (j.contains(key) && j[key].is_array())
            for (const auto& e : j[key])
                if (e.is_string()) out.push_back(e.get<std::string>());
        return out;
    }

    static std::vector<int> IntArray(const json& j, const char* key)
    {
        std::vector<int> out;
        if (j.contains(key) && j[key].is_array())
            for (const auto& e : j[key])
                if (e.is_number_integer()) out.push_back(e.get<int>());
        return out;
    }

    static std::map<std::string, std::string> StrMap(const json& j, const char* key)
    {
        std::map<std::string, std::string> out;
        if (j.contains(key) && j[key].is_object())
            for (auto it = j[key].begin(); it != j[key].end(); ++it)
                if (it.value().is_string()) out[it.key()] = it.value().get<std::string>();
        return out;
    }

    static NodeSelector ParseSelector(const json& j)
    {
        NodeSelector s;
        if (j.is_object())
        {
            s.os = j.value("os", std::string("any"));
            s.labels = StrArray(j, "labels");
            s.preferOs = j.value("preferOs", std::string());
        }
        return s;
    }

    static CommandVariant ParseCommandVariant(const json& j)
    {
        CommandVariant c;
        c.interpreter = j.value("interpreter", std::string());
        c.script = j.value("script", std::string());
        c.args = StrArray(j, "args");
        return c;
    }

    static ArtifactSpec ParseArtifacts(const json& j)
    {
        ArtifactSpec a;
        if (j.is_object())
        {
            a.globs = StrArray(j, "globs");
            a.exclude = StrArray(j, "exclude");
            a.excludeDefaults = j.value("excludeDefaults", true);
            a.package = j.value("package", std::string("none"));
            a.archiveName = j.value("archiveName", std::string());
        }
        return a;
    }

    static std::vector<HandoffStep> ParseHandoff(const json& j)
    {
        std::vector<HandoffStep> steps;
        if (j.is_array())
        {
            for (const auto& s : j)
            {
                if (!s.is_object()) continue;
                HandoffStep step;
                step.name = s.value("name", std::string());
                step.type = s.value("type", std::string());
                step.continueOnError = s.value("continueOnError", false);
                // Any remaining scalar keys become handoff fields.
                for (auto it = s.begin(); it != s.end(); ++it)
                {
                    const std::string& k = it.key();
                    if (k == "name" || k == "type" || k == "continueOnError") continue;
                    if (it.value().is_string()) step.fields[k] = it.value().get<std::string>();
                    else step.fields[k] = it.value().dump();
                }
                steps.push_back(step);
            }
        }
        return steps;
    }

    static BuildRuleDef ParseRule(const json& j)
    {
        BuildRuleDef r;
        r.name = j.value("name", std::string());
        r.enabled = j.value("enabled", true);
        r.branches = StrArray(j, "branches");
        r.nodeSelector = ParseSelector(j.value("nodeSelector", json::object()));
        // A per-OS command may be a single object (one step) or an array of
        // objects (ordered steps run in sequence, e.g. config.bat then build.bat).
        if (j.contains("command") && j["command"].is_object())
            for (auto it = j["command"].begin(); it != j["command"].end(); ++it)
            {
                if (it.value().is_array())
                    for (const auto& step : it.value()) r.stepsByOs[it.key()].push_back(ParseCommandVariant(step));
                else
                    r.commandByOs[it.key()] = ParseCommandVariant(it.value());
            }
        r.workingDir = j.value("workingDir", std::string("."));
        r.env = StrMap(j, "env");
        r.timeoutSeconds = j.value("timeoutSeconds", 0);
        r.successExitCodes = IntArray(j, "successExitCodes");
        r.artifacts = ParseArtifacts(j.value("artifacts", json::object()));
        r.handoff = ParseHandoff(j.value("handoff", json::array()));
        if (j.contains("inputs") && j["inputs"].is_array())
            for (const auto& in : j["inputs"])
            {
                if (!in.is_object()) continue;
                InputDef d;
                d.product = in.value("product", std::string());
                d.variant = in.value("variant", std::string());
                if (!d.product.empty()) r.inputs.push_back(d);
            }
        return r;
    }

    static DiscoverSpec ParseDiscover(const json& j)
    {
        DiscoverSpec d;
        d.type = j.value("type", std::string());
        d.glob = j.value("glob", std::string());
        d.values = StrArray(j, "values");   // for type "list": the matrix entries
        d.as = j.value("as", std::string("VARIANT"));
        if (j.contains("classify") && j["classify"].is_array())
            for (const auto& c : j["classify"])
            {
                if (!c.is_object()) continue;
                ClassifyRule r;
                r.match = c.value("match", std::string());
                r.os = c.value("os", std::string());
                r.labels = StrArray(c, "labels");
                r.preferOs = c.value("preferOs", std::string());
                d.classify.push_back(r);
            }
        return d;
    }

    bool ParseProjectConfig(const std::string& jsonText, ProjectDef& out, std::string& error)
    {
        json j = json::parse(jsonText, nullptr, false);
        if (j.is_discarded() || !j.is_object())
        {
            error = "smith.json is not a valid JSON object";
            return false;
        }

        out = ProjectDef();
        out.schemaVersion = j.value("schemaVersion", 1);

        if (j.contains("project") && j["project"].is_object())
        {
            const auto& p = j["project"];
            out.id = p.value("id", std::string());
            out.name = p.value("name", std::string());
            out.description = p.value("description", std::string());
        }
        if (out.id.empty())
        {
            error = "smith.json: project.id is required";
            return false;
        }

        if (j.contains("repos") && j["repos"].is_array())
        {
            for (const auto& r : j["repos"])
            {
                if (!r.is_object()) continue;
                RepoDef repo;
                repo.name = r.value("name", std::string("main"));
                repo.primary = r.value("primary", false);
                repo.url = r.value("url", std::string());
                repo.defaultBranch = r.value("defaultBranch", std::string("main"));
                repo.checkoutDir = r.value("checkoutDir", std::string("."));
                out.repos.push_back(repo);
            }
        }
        if (!out.repos.empty() && std::none_of(out.repos.begin(), out.repos.end(),
                                               [](const RepoDef& r) { return r.primary; }))
        {
            out.repos[0].primary = true;
        }

        out.defaultNodeSelector = ParseSelector(j.value("defaultNodeSelector", json::object()));

        if (j.contains("buildProducts") && j["buildProducts"].is_array())
        {
            for (const auto& bp : j["buildProducts"])
            {
                if (!bp.is_object()) continue;
                BuildProductDef product;
                product.name = bp.value("name", std::string());
                product.outputPath = bp.value("outputPath", std::string());
                if (bp.contains("discover") && bp["discover"].is_object())
                    product.discover = ParseDiscover(bp["discover"]);
                if (bp.contains("rules") && bp["rules"].is_array())
                    for (const auto& rule : bp["rules"])
                        if (rule.is_object()) product.rules.push_back(ParseRule(rule));
                out.products.push_back(product);
            }
        }

        if (j.contains("triggers") && j["triggers"].is_array())
        {
            for (const auto& t : j["triggers"])
            {
                if (!t.is_object()) continue;
                TriggerDef td;
                td.type = t.value("type", std::string());
                td.branches = StrArray(t, "branches");
                td.intervalSeconds = t.value("intervalSeconds", 0);
                td.cron = t.value("cron", std::string());
                td.product = t.value("product", std::string());
                out.triggers.push_back(td);
            }
        }

        // Named chains: queue `builds` in parallel, then (only if ALL succeed)
        // queue `then`. Steps are {product, variants[]} - variants accept names
        // or slugs; an empty list on a discovering product means every variant.
        auto parseChainSteps = [](const json& arr) {
            std::vector<ChainStep> steps;
            if (!arr.is_array()) return steps;
            for (const auto& s : arr)
            {
                if (!s.is_object()) continue;
                ChainStep step;
                step.product = s.value("product", std::string());
                step.variants = StrArray(s, "variants");
                if (!step.product.empty()) steps.push_back(step);
            }
            return steps;
        };
        if (j.contains("chains") && j["chains"].is_array())
        {
            for (const auto& c : j["chains"])
            {
                if (!c.is_object()) continue;
                ChainDef chain;
                chain.name = c.value("name", std::string());
                chain.builds = parseChainSteps(c.value("builds", json::array()));
                chain.then = parseChainSteps(c.value("then", json::array()));
                chain.onFailure = c.value("onFailure", std::string());   // "" = coordinator default
                if (c.contains("pinCommit") && c["pinCommit"].is_boolean())
                    chain.pinCommit = c["pinCommit"].get<bool>() ? 1 : 0;
                if (!chain.name.empty() && !chain.builds.empty()) out.chains.push_back(chain);
            }
        }

        return true;
    }

    bool LoadProjectConfig(const std::string& pathOrDir, ProjectDef& out, std::string& error)
    {
        fs::path path(pathOrDir);
        std::error_code ec;
        if (fs::is_directory(path, ec)) path = path / "smith.json";

        std::ifstream in(path, std::ios::binary);
        if (!in)
        {
            error = "could not open " + path.string();
            return false;
        }
        std::stringstream ss;
        ss << in.rdbuf();
        return ParseProjectConfig(ss.str(), out, error);
    }
}
