// CoordinatorAutobuilds.cpp - UI-managed autobuild rules.
//
// An autobuild rule says "poll <branch> of <project> every N seconds and build
// <product> (optionally pinned to a target OS) when the commit changes". Rules are
// managed from the web UI and persisted server-side in autobuilds.json - NOT in the
// repo's smith.json - so polling can be configured for any project, including ones
// whose smith.json only has manual triggers. The poller itself lives in
// CoordinatorTriggers.cpp (PollAutobuildRules); this file is the model + CRUD + store.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Coordinator.h"
#include "CoordinatorUtil.h"

#include <SmithCore/TimeUtil.h>
#include <SmithCore/Uuid.h>
#include <SmithCore/JsonFile.h>
#include <Log/Log.h>

#include <json/single_include/nlohmann/json.hpp>

#include <algorithm>
#include <filesystem>

using nlohmann::json;
namespace fs = std::filesystem;

namespace Smith
{
    // Only these platforms are meaningful as a build target; anything else becomes
    // "any" (no OS pin). Mirrors the OS strings agents register with.
    static std::string SanitizeTargetOs(const std::string& os)
    {
        if (os == "windows" || os == "mac" || os == "linux") return os;
        return "";
    }

    // GET  /api/projects/:id/autobuilds        -> [rule, ...] for that project
    // POST /api/projects/:id/autobuilds {rule} -> create or update (new id if absent)
    void Coordinator::HandleAutobuilds(const Http::Request& req, Http::Response& res)
    {
        std::string projectId = req.Param("id");

        // Rule -> JSON (a local lambda so it can see the private nested AutobuildRule).
        auto ruleJson = [](const AutobuildRule& r) {
            return json{{"id", r.id}, {"projectId", r.projectId}, {"branch", r.branch},
                        {"intervalSeconds", r.intervalSeconds}, {"product", r.product},
                        {"targetOs", r.targetOs}, {"enabled", r.enabled},
                        {"createdAt", r.createdAt}, {"lastSha", r.lastSha}};
        };

        if (req.method == "POST")
        {
            json j;
            if (!ParseBody(req, j) || !j.contains("product"))
            { JsonError(res, 400, "expected {product, branch?, intervalSeconds?, targetOs?, enabled?, id?}"); return; }

            AutobuildRule rule;
            rule.id = j.value("id", std::string());
            rule.projectId = projectId;
            rule.product = j.value("product", std::string());
            rule.branch = j.value("branch", std::string());
            rule.targetOs = SanitizeTargetOs(j.value("targetOs", std::string()));
            rule.enabled = j.value("enabled", true);
            rule.intervalSeconds = j.value("intervalSeconds", 300);
            if (rule.intervalSeconds < 10) rule.intervalSeconds = 10;   // floor: don't hammer the remote

            // The product may exist only in the branch's own smith.json (not merged yet):
            // read that first so it validates - and builds - with the branch's rules.
            std::string branchErr;
            bool branchOk = LoadBranchProject(projectId, rule.branch, true, branchErr);
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                const ProjectDef* proj = FindProject(projectId);
                if (!proj) { JsonError(res, 404, "unknown project"); return; }
                if (rule.branch.empty())
                    for (const auto& rp : proj->repos) if (rp.primary) { rule.branch = rp.defaultBranch; break; }
                if (rule.branch.empty()) rule.branch = "main";
                const BuildProductDef* prod = FindProductForBranch(*proj, rule.product, rule.branch);
                if (!prod)
                {
                    JsonError(res, 400, branchOk ? "unknown product '" + rule.product + "' on " + rule.branch
                                                 : "unknown product '" + rule.product + "' (" + branchErr + ")");
                    return;
                }
                if (!FindRule(*prod, rule.branch))
                { JsonError(res, 400, "product '" + rule.product + "' has no enabled rule for branch " + rule.branch); return; }

                if (rule.id.empty()) { rule.id = MakeShortId(); rule.createdAt = NowMillis(); }
                else
                {
                    auto ex = m_autobuilds.find(rule.id);   // editing: keep the baseline + created time
                    if (ex != m_autobuilds.end()) { rule.lastSha = ex->second.lastSha; rule.createdAt = ex->second.createdAt; }
                    if (rule.createdAt == 0) rule.createdAt = NowMillis();
                }
                m_autobuilds[rule.id] = rule;
            }
            SaveAutobuilds();
            LOG_INFO("Smith", "Autobuild rule %s: %s/%s@%s every %ds%s",
                     rule.id.c_str(), projectId.c_str(), rule.product.c_str(), rule.branch.c_str(),
                     rule.intervalSeconds, rule.targetOs.empty() ? "" : (" -> " + rule.targetOs).c_str());
            res.Json(ruleJson(rule).dump());
            return;
        }

        std::vector<AutobuildRule> rules;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            for (const auto& kv : m_autobuilds) if (kv.second.projectId == projectId) rules.push_back(kv.second);
        }
        std::sort(rules.begin(), rules.end(),
                  [](const AutobuildRule& a, const AutobuildRule& b) { return a.createdAt < b.createdAt; });
        json arr = json::array();
        for (const auto& r : rules) arr.push_back(ruleJson(r));
        res.Json(arr.dump());
    }

    void Coordinator::HandleDeleteAutobuild(const Http::Request& req, Http::Response& res)
    {
        std::string ruleId = req.Param("ruleId");
        bool removed = false;
        { std::lock_guard<std::mutex> lock(m_mutex); removed = m_autobuilds.erase(ruleId) > 0; }
        if (removed) SaveAutobuilds();
        res.Json(json{{"deleted", removed}}.dump());
    }

    void Coordinator::SaveAutobuilds()
    {
        json arr = json::array();
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            for (const auto& kv : m_autobuilds)
            {
                const AutobuildRule& r = kv.second;
                arr.push_back(json{{"id", r.id}, {"projectId", r.projectId}, {"branch", r.branch},
                                   {"intervalSeconds", r.intervalSeconds}, {"product", r.product},
                                   {"targetOs", r.targetOs}, {"enabled", r.enabled},
                                   {"createdAt", r.createdAt}, {"lastSha", r.lastSha}});
            }
        }
        SaveJsonFileAtomic((fs::path(m_cfg.dataDir) / "autobuilds.json").string(), arr);
    }

    void Coordinator::LoadAutobuilds()
    {
        json j;
        if (!LoadJsonFile((fs::path(m_cfg.dataDir) / "autobuilds.json").string(), j) || !j.is_array()) return;
        std::lock_guard<std::mutex> lock(m_mutex);
        for (const auto& e : j)
        {
            if (!e.is_object()) continue;
            AutobuildRule r;
            r.id = e.value("id", std::string());
            r.projectId = e.value("projectId", std::string());
            r.branch = e.value("branch", std::string());
            r.intervalSeconds = e.value("intervalSeconds", 300);
            r.product = e.value("product", std::string());
            r.targetOs = SanitizeTargetOs(e.value("targetOs", std::string()));
            r.enabled = e.value("enabled", true);
            r.createdAt = e.value("createdAt", (int64_t)0);
            r.lastSha = e.value("lastSha", std::string());
            if (!r.id.empty() && !r.projectId.empty()) m_autobuilds[r.id] = r;
        }
    }
}
