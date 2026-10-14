// CoordinatorBranches.cpp - per-branch smith.json overlays.
//
// A project's def comes from the smith.json on the branch its source tracks
// (usually the default branch). A feature branch can carry products or rules that
// branch doesn't have yet - so without this, a branch couldn't build (or autobuild)
// what its own smith.json declares until it was merged. Each overlay is that
// branch's smith.json read with `git show origin/<branch>:smith.json`: no checkout,
// no work-tree change, nothing committed. Builds on that branch resolve their
// product from the overlay first (FindProductForBranch), so they run the rules on
// their branch; everything else keeps using the tracked branch's def.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Coordinator.h"
#include "CoordinatorUtil.h"

#include <SmithCore/GitRepo.h>
#include <SmithCore/RepoConfig.h>
#include <Log/Log.h>

#include <json/single_include/nlohmann/json.hpp>

#include <set>
#include <utility>

using nlohmann::json;

namespace Smith
{
    // A branch name we're willing to hand git as part of "origin/<branch>:smith.json".
    // Refuses the characters git itself forbids in ref names plus ':' (which would
    // change what `git show` reads).
    static bool PlausibleBranchName(const std::string& b)
    {
        if (b.empty() || b.size() > 255 || b[0] == '-' || b.find("..") != std::string::npos) return false;
        for (char c : b)
            if ((unsigned char)c <= ' ' || c == ':' || c == '~' || c == '^' || c == '?' || c == '*' ||
                c == '[' || c == '\\' || c == 0x7f) return false;
        return true;
    }

    const BuildProductDef* Coordinator::FindProductForBranch(const ProjectDef& proj, const std::string& name,
                                                             const std::string& branch) const
    {
        if (!branch.empty())
        {
            auto pit = m_branchProjects.find(proj.id);
            if (pit != m_branchProjects.end())
            {
                auto bit = pit->second.find(branch);
                if (bit != pit->second.end())
                    if (const BuildProductDef* p = FindProduct(bit->second, name)) return p;
            }
        }
        return FindProduct(proj, name);
    }

    bool Coordinator::LoadBranchProject(const std::string& projectId, const std::string& branch,
                                        bool fetch, std::string& error)
    {
        ProjectSource src;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            auto it = m_sources.find(projectId);
            if (it == m_sources.end()) { error = "project has no git source to read branches from"; return false; }
            src = it->second;
        }
        if (branch.empty() || branch == src.branch) return true;   // the project def already is this branch
        if (!PlausibleBranchName(branch)) { error = "invalid branch name"; return false; }

        if (fetch && GitRepo::FetchRemoteSha(src.dir, branch).empty())
        { error = "branch '" + branch + "' not found on the remote"; return false; }

        std::string text;
        if (!GitRepo::ReadFileAtRef(src.dir, "origin/" + branch, "smith.json", text))
        { error = "no smith.json on branch '" + branch + "'"; return false; }

        ProjectDef def;
        std::string err;
        if (!ParseProjectConfig(text, def, err)) { error = "smith.json on '" + branch + "': " + err; return false; }
        def.id = projectId;   // the overlay belongs to this project whatever its file says

        std::lock_guard<std::mutex> lock(m_mutex);
        if (const ProjectDef* base = FindProject(projectId)) def.localDir = base->localDir;
        m_branchProjects[projectId][branch] = std::move(def);
        return true;
    }

    void Coordinator::WarmBranchProjects()
    {
        std::set<std::pair<std::string, std::string>> wanted;   // (projectId, branch)
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            for (const auto& jobId : m_queue)
            {
                auto it = m_builds.find(jobId);
                if (it != m_builds.end()) wanted.insert({ it->second.projectId, it->second.branch });
            }
            for (const auto& kv : m_autobuilds)
                if (kv.second.enabled) wanted.insert({ kv.second.projectId, kv.second.branch });
        }
        for (const auto& pb : wanted)
        {
            std::string err;
            if (!LoadBranchProject(pb.first, pb.second, false, err))
                LOG_WARNING("Smith", "branch smith.json %s@%s: %s", pb.first.c_str(), pb.second.c_str(), err.c_str());
        }
    }

    void Coordinator::HandleBranchProducts(const Http::Request& req, Http::Response& res)
    {
        std::string projectId = req.Param("id");
        std::string branch = req.Param("branch");

        std::string error;
        bool loaded = LoadBranchProject(projectId, branch, true, error);

        std::lock_guard<std::mutex> lock(m_mutex);
        const ProjectDef* proj = FindProject(projectId);
        if (!proj) { JsonError(res, 404, "unknown project"); return; }

        std::string useBranch = branch;
        if (useBranch.empty())
            for (const auto& r : proj->repos) if (r.primary) { useBranch = r.defaultBranch; break; }

        // The branch's own smith.json when we have it, else the project def (the
        // tracked branch, or a branch we couldn't read - reported in "error").
        const ProjectDef* def = proj;
        bool fromBranch = false;
        auto pit = m_branchProjects.find(projectId);
        if (loaded && pit != m_branchProjects.end())
        {
            auto bit = pit->second.find(branch);
            if (bit != pit->second.end()) { def = &bit->second; fromBranch = true; }
        }

        // Only products with an enabled rule for this branch: anything else would be
        // refused at enqueue ("no rule for this branch").
        json products = json::array();
        for (const auto& prod : def->products)
        {
            if (!FindRule(prod, useBranch)) continue;
            json variants = json::array();
            for (const auto& v : prod.variants) variants.push_back(json{{"name", v.name}, {"slug", v.slug}, {"os", v.os}, {"labels", v.labels}});
            products.push_back(json{{"name", prod.name}, {"variants", variants}});
        }
        json out{{"branch", useBranch}, {"source", fromBranch ? "branch" : "project"}, {"products", products}};
        if (!loaded) out["error"] = error;
        res.Json(out.dump());
    }
}
