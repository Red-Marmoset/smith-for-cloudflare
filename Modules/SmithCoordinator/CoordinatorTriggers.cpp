// CoordinatorTriggers.cpp - git poller, cron scheduler and webhook endpoint.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Coordinator.h"
#include "CoordinatorUtil.h"

#include <SmithCore/GitRepo.h>
#include <SmithCore/RepoConfig.h>
#include <SmithCore/TimeUtil.h>
#include <Log/Log.h>

#include <json/single_include/nlohmann/json.hpp>

#include <chrono>
#include <thread>
#include <ctime>
#include <sstream>
#include <cstdlib>

using nlohmann::json;

namespace Smith
{
    // Minimal 5-field cron field match: '*', N, a-b, '*/N', and comma lists.
    static bool CronFieldMatch(const std::string& field, int value)
    {
        if (field.empty() || field == "*") return true;
        std::stringstream ss(field);
        std::string part;
        while (std::getline(ss, part, ','))
        {
            if (part == "*") return true;
            size_t slash = part.find('/');
            if (slash != std::string::npos && part.substr(0, slash) == "*")
            {
                int step = std::atoi(part.substr(slash + 1).c_str());
                if (step > 0 && (value % step) == 0) return true;
                continue;
            }
            size_t dash = part.find('-');
            if (dash != std::string::npos)
            {
                int lo = std::atoi(part.substr(0, dash).c_str());
                int hi = std::atoi(part.substr(dash + 1).c_str());
                if (value >= lo && value <= hi) return true;
                continue;
            }
            if (std::atoi(part.c_str()) == value) return true;
        }
        return false;
    }

    static bool CronMatch(const std::string& cron, const std::tm& t)
    {
        std::stringstream ss(cron);
        std::string mi, ho, dom, mo, dow;
        if (!(ss >> mi >> ho >> dom >> mo >> dow)) return false;
        return CronFieldMatch(mi, t.tm_min) && CronFieldMatch(ho, t.tm_hour) &&
               CronFieldMatch(dom, t.tm_mday) && CronFieldMatch(mo, t.tm_mon + 1) &&
               CronFieldMatch(dow, t.tm_wday);
    }

    // A new commit landed on a branch other than the one the source tracks: refresh that
    // branch's overlay with `git show`, leaving the project def and the checkout on the
    // tracked branch (previously the checkout was switched to <branch> and its smith.json
    // became the whole project's until the next refresh). False for the tracked branch -
    // the caller refreshes the def itself.
    bool Coordinator::RefreshBranchOverlay(const ProjectSource& src, const std::string& projectId,
                                           const std::string& branch)
    {
        if (branch == src.branch) return false;
        std::string err;
        if (!LoadBranchProject(projectId, branch, false, err))   // the poll just fetched
            LOG_WARNING("Smith", "branch smith.json %s@%s: %s (using the project's)",
                        projectId.c_str(), branch.c_str(), err.c_str());
        return true;
    }

    void Coordinator::PollProjectBranches(const std::string& projectId)
    {
        ProjectSource src;
        std::vector<TriggerDef> pollTriggers;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            auto sit = m_sources.find(projectId);
            if (sit == m_sources.end()) return;
            src = sit->second;
            auto pit = m_projects.find(projectId);
            if (pit == m_projects.end()) return;
            for (const auto& t : pit->second.triggers) if (t.type == "poll") pollTriggers.push_back(t);
        }
        if (pollTriggers.empty()) return;

        std::vector<std::pair<std::string, std::string>> branchProduct;   // branch -> product
        for (const auto& t : pollTriggers)
        {
            std::vector<std::string> branches = t.branches.empty() ? std::vector<std::string>{ src.branch } : t.branches;
            for (const auto& b : branches) branchProduct.push_back({ b, t.product });
        }

        for (const auto& bp : branchProduct)
        {
            const std::string& branch = bp.first;
            std::string sha = GitRepo::FetchRemoteSha(src.dir, branch);
            if (sha.empty()) continue;

            std::string last;
            { std::lock_guard<std::mutex> lock(m_mutex); last = m_pollState[projectId][branch]; }
            if (sha == last) continue;
            { std::lock_guard<std::mutex> lock(m_mutex); m_pollState[projectId][branch] = sha; }
            SavePollState();   // persist immediately so a restart resumes from here, not a re-baseline

            if (last.empty())   // first observation: record baseline, don't build on startup
            {
                LOG_INFO("Smith", "poll baseline %s@%s = %s", projectId.c_str(), branch.c_str(), sha.substr(0, 7).c_str());
                continue;
            }

            LOG_INFO("Smith", "poll: new commit %s on %s@%s", sha.substr(0, 7).c_str(), projectId.c_str(), branch.c_str());
            if (!RefreshBranchOverlay(src, projectId, branch))
            {
                if (!src.local) GitRepo::Sync(src.url, src.dir, branch, "", nullptr);   // refresh smith.json (clones only; never a local --project tree)
                ProjectDef def; std::string err;
                if (LoadProjectConfig(src.dir, def, err)) RegisterProject(def);
            }

            std::string product = bp.second;
            if (product.empty())
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                auto pit = m_projects.find(projectId);
                if (pit != m_projects.end() && !pit->second.products.empty()) product = pit->second.products[0].name;
            }
            // The new SHA is already recorded, so a commit that can't be queued is a
            // commit silently skipped - say so rather than leaving a quiet gap.
            if (EnqueueBuild(projectId, product, branch, sha, "poll").empty())
                LOG_WARNING("Smith", "poll: no build queued for %s on %s@%s (product '%s' has no rule for this branch?)",
                            sha.substr(0, 7).c_str(), projectId.c_str(), branch.c_str(), product.c_str());
        }
    }

    // One pass over UI-managed autobuild rules: for each enabled rule whose interval has
    // elapsed, fetch its branch's remote SHA and, when it changes, enqueue a build of the
    // rule's product pinned to its target OS. Baseline-first (an empty lastSha just records
    // the current SHA, no build) so creating a rule never triggers a surprise build storm.
    void Coordinator::PollAutobuildRules()
    {
        struct Due { std::string id, projectId, branch, product, targetOs, lastSha; ProjectSource src; };
        std::vector<Due> due;
        int64_t now = NowMillis();
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            for (auto& kv : m_autobuilds)
            {
                AutobuildRule& r = kv.second;
                if (!r.enabled) continue;
                if (r.lastPolledAt != 0 && now - r.lastPolledAt < (int64_t)r.intervalSeconds * 1000) continue;
                auto sit = m_sources.find(r.projectId);
                if (sit == m_sources.end()) continue;   // project has no pollable source yet
                r.lastPolledAt = now;
                due.push_back({ r.id, r.projectId, r.branch, r.product, r.targetOs, r.lastSha, sit->second });
            }
        }

        for (const auto& d : due)
        {
            std::string sha = GitRepo::FetchRemoteSha(d.src.dir, d.branch);   // fetch-only; never mutates a work tree
            if (sha.empty() || sha == d.lastSha) continue;

            bool baseline = d.lastSha.empty();
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                auto it = m_autobuilds.find(d.id);
                if (it == m_autobuilds.end()) continue;   // rule deleted mid-poll
                it->second.lastSha = sha;
            }
            SaveAutobuilds();

            if (baseline)
            {
                LOG_INFO("Smith", "autobuild baseline %s %s@%s = %s",
                         d.projectId.c_str(), d.product.c_str(), d.branch.c_str(), sha.substr(0, 7).c_str());
                continue;
            }

            // Refresh the project config from the new commit so the build uses the current
            // smith.json - but only for cloned sources; a local --project tree is never synced.
            if (!RefreshBranchOverlay(d.src, d.projectId, d.branch) && !d.src.local)
            {
                GitRepo::Sync(d.src.url, d.src.dir, d.branch, "", nullptr);
                ProjectDef def; std::string err;
                if (LoadProjectConfig(d.src.dir, def, err)) RegisterProject(def);
            }

            LOG_INFO("Smith", "autobuild: new commit %s on %s@%s -> %s%s",
                     sha.substr(0, 7).c_str(), d.projectId.c_str(), d.branch.c_str(), d.product.c_str(),
                     d.targetOs.empty() ? "" : (" [" + d.targetOs + "]").c_str());
            // lastSha has already moved on, so a commit that can't be queued is a commit
            // silently skipped - say so rather than leaving a quiet gap.
            if (EnqueueBuild(d.projectId, d.product, d.branch, sha, "autobuild", "", d.targetOs).empty())
                LOG_WARNING("Smith", "autobuild: no build queued for %s on %s@%s (product '%s' has no rule for this branch?)",
                            sha.substr(0, 7).c_str(), d.projectId.c_str(), d.branch.c_str(), d.product.c_str());
        }
    }

    void Coordinator::TriggerLoop()
    {
        WarmBranchProjects();   // overlays are in-memory: restore what queued builds + autobuilds need
        int64_t lastCronMinute = -1;
        std::map<std::string, int64_t> lastPoll;
        while (!m_stopTriggers)
        {
            int64_t now = NowMillis();

            // Reap nodes offline for a while so dead agents (and any superseded
            // registration that didn't get replaced) don't linger in the list.
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                for (auto it = m_nodes.begin(); it != m_nodes.end(); )
                {
                    if (now - it->second.lastSeenMs > 300000)   // 5 min with no heartbeat
                    {
                        // Heartbeats come from their own thread, so a busy agent still beats;
                        // 5 min of silence means it died mid-build.
                        MarkNodeBuildsLostLocked(it->first, "agent stopped responding");
                        it = m_nodes.erase(it);
                    }
                    else
                        ++it;
                }
            }

            // Pre-parse diagnostics for freshly-finished builds so the dashboard badge,
            // project health rollup and tray toast have counts ready without anyone first
            // opening the build. Bounded per tick; EnsureDiagnostics caches + persists each.
            {
                std::vector<std::string> toParse;
                {
                    std::lock_guard<std::mutex> lock(m_mutex);
                    for (const auto& kv : m_builds)
                        if (!kv.second.diagnostics.parsed && IsTerminal(kv.second.status))
                        {
                            toParse.push_back(kv.first);
                            if (toParse.size() >= 8) break;
                        }
                }
                BuildDiagnostics tmp;
                for (const auto& jid : toParse) { EnsureAuthor(jid); EnsureDiagnostics(jid, tmp); }
            }

            std::vector<std::string> pollProjects;
            std::map<std::string, int> pollInterval;
            std::vector<std::pair<std::string, TriggerDef>> schedules;
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                for (auto& kv : m_projects)
                {
                    bool hasPoll = false;
                    int interval = m_cfg.pollIntervalSec;
                    for (const auto& t : kv.second.triggers)
                    {
                        if (t.type == "poll") { hasPoll = true; if (t.intervalSeconds > 0) interval = t.intervalSeconds; }
                        if (t.type == "schedule") schedules.push_back({ kv.first, t });
                    }
                    if (hasPoll && m_sources.count(kv.first)) { pollProjects.push_back(kv.first); pollInterval[kv.first] = interval; }
                }
            }

            for (const auto& pid : pollProjects)
            {
                if (now - lastPoll[pid] >= (int64_t)pollInterval[pid] * 1000)
                {
                    lastPoll[pid] = now;
                    PollProjectBranches(pid);
                }
            }

            // UI-managed autobuild rules; each polls on its own per-rule interval.
            PollAutobuildRules();

            int64_t minute = now / 60000;
            if (minute != lastCronMinute)
            {
                lastCronMinute = minute;
                std::time_t tt = (std::time_t)(now / 1000);
                std::tm lt{};
#ifdef _WIN32
                localtime_s(&lt, &tt);
#else
                localtime_r(&tt, &lt);
#endif
                for (const auto& sc : schedules)
                {
                    if (!CronMatch(sc.second.cron, lt)) continue;
                    std::string product = sc.second.product;
                    std::string branch = sc.second.branches.empty() ? "" : sc.second.branches[0];
                    if (product.empty())
                    {
                        std::lock_guard<std::mutex> lock(m_mutex);
                        auto pit = m_projects.find(sc.first);
                        if (pit != m_projects.end() && !pit->second.products.empty()) product = pit->second.products[0].name;
                    }
                    LOG_INFO("Smith", "schedule fired for %s (cron '%s')", sc.first.c_str(), sc.second.cron.c_str());
                    EnqueueBuild(sc.first, product, branch, "", "schedule");
                }
            }

            for (int i = 0; i < 50 && !m_stopTriggers; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }

    void Coordinator::HandleWebhook(const Http::Request& req, Http::Response& res)
    {
        std::string projectId = req.Param("projectId");
        std::string branch, sha, product;

        json j;
        if (ParseBody(req, j))
        {
            if (j.contains("ref") && j["ref"].is_string())
            {
                std::string ref = j["ref"].get<std::string>();
                const std::string prefix = "refs/heads/";
                branch = (ref.rfind(prefix, 0) == 0) ? ref.substr(prefix.size()) : ref;
            }
            branch = j.value("branch", branch);
            sha = j.value("after", std::string());
            sha = j.value("sha", sha);
            product = j.value("product", std::string());
        }
        if (branch.empty()) branch = req.Param("branch");

        std::string branchErr;   // a pushed branch builds with its own smith.json
        if (!LoadBranchProject(projectId, branch, true, branchErr))
            LOG_WARNING("Smith", "webhook %s@%s: %s", projectId.c_str(), branch.c_str(), branchErr.c_str());

        {
            std::lock_guard<std::mutex> lock(m_mutex);
            auto pit = m_projects.find(projectId);
            if (pit == m_projects.end()) { res.Json(json{{"enqueued", false}, {"error", "unknown project"}}.dump(), 404); return; }
            if (product.empty())
            {
                // The branch's own smith.json says what a push to it builds: its first
                // webhook trigger whose product has a rule for the branch.
                auto bp = m_branchProjects.find(projectId);
                if (bp != m_branchProjects.end())
                {
                    auto bit = bp->second.find(branch);
                    if (bit != bp->second.end())
                        for (const auto& t : bit->second.triggers)
                        {
                            if (t.type != "webhook" || t.product.empty()) continue;
                            const BuildProductDef* p = FindProduct(bit->second, t.product);
                            if (p && FindRule(*p, branch)) { product = t.product; break; }
                        }
                }
            }
            if (product.empty())
            {
                for (const auto& t : pit->second.triggers) if (t.type == "webhook" && !t.product.empty()) { product = t.product; break; }
                if (product.empty() && !pit->second.products.empty()) product = pit->second.products[0].name;
            }
        }

        std::string jobId = EnqueueBuild(projectId, product, branch, sha, "webhook");
        res.Json(json{{"enqueued", !jobId.empty()}, {"jobId", jobId}, {"branch", branch}}.dump(), jobId.empty() ? 404 : 200);
    }
}
