// CoordinatorBatches.cpp - build batches/chains: several builds queued in
// parallel plus a success-gated follow-up (typically a deploy whose rule's
// `inputs` consume the freshly collected artifacts).
//
// A batch comes from a named chain in the repo's smith.json or an ad-hoc
// request from the UI/bot. All of a batch's builds are pinned to one commit
// (batch.pinCommit, default on) so a mid-batch push can't make the platforms
// diverge. The transition logic itself is the pure SmithCore BatchAdvance;
// this file owns the records, the HTTP surface, persistence (batches.json)
// and the enqueue/cancel side effects.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Coordinator.h"
#include "CoordinatorUtil.h"

#include <SmithCore/GitRepo.h>
#include <SmithCore/TimeUtil.h>
#include <SmithCore/Uuid.h>
#include <SmithCore/JsonFile.h>
#include <Log/Log.h>

#include <json/single_include/nlohmann/json.hpp>

#include <algorithm>
#include <fstream>
#include <sstream>
#include <filesystem>

using nlohmann::json;
namespace fs = std::filesystem;

namespace Smith
{
    const ProductVariant* Coordinator::ResolveVariantRef(const BuildProductDef& prod, const std::string& ref) const
    {
        for (const auto& v : prod.variants) if (v.name == ref) return &v;
        for (const auto& v : prod.variants) if (v.slug == ref) return &v;
        return nullptr;
    }

    static json BatchJobJson(const BatchJobRef& j, const std::map<std::string, BuildRecord>& builds)
    {
        std::string status = j.jobId.empty() ? "pending" : "queued";
        int buildNumber = 0;
        auto it = builds.find(j.jobId);
        if (it != builds.end()) { status = it->second.status; buildNumber = it->second.buildNumber; }
        return json{{"jobId", j.jobId}, {"product", j.product}, {"variant", j.variant},
                    {"status", status}, {"buildNumber", buildNumber}};
    }

    static json BatchJson(const BatchDef& b, const std::map<std::string, BuildRecord>& builds)
    {
        json jb = json::array(), jt = json::array();
        for (const auto& j : b.builds) jb.push_back(BatchJobJson(j, builds));
        for (const auto& j : b.then) jt.push_back(BatchJobJson(j, builds));
        return json{{"id", b.id}, {"projectId", b.projectId}, {"name", b.name},
                    {"branch", b.branch}, {"commit", b.commit}, {"onFailure", b.onFailure},
                    {"clean", b.clean}, {"status", b.status}, {"detail", b.detail},
                    {"createdAt", b.createdAt}, {"finishedAt", b.finishedAt},
                    {"builds", jb}, {"then", jt}};
    }

    void Coordinator::EmitBatchEvent(const BatchDef& b)
    {
        json e = {
            {"type", "batch"}, {"batchId", b.id}, {"projectId", b.projectId},
            {"name", b.name}, {"branch", b.branch}, {"status", b.status},
            {"summary", b.detail}, {"ts", NowMillis()}
        };
        PushEvent(e.dump());
    }

    void Coordinator::SaveBatchesLocked()
    {
        json arr = json::array();
        for (const auto& kv : m_batches)
        {
            const BatchDef& b = kv.second;
            auto jobs = [](const std::vector<BatchJobRef>& v) {
                json a = json::array();
                for (const auto& j : v) a.push_back(json{{"jobId", j.jobId}, {"product", j.product}, {"variant", j.variant}});
                return a;
            };
            arr.push_back(json{{"id", b.id}, {"projectId", b.projectId}, {"name", b.name},
                               {"branch", b.branch}, {"commit", b.commit}, {"onFailure", b.onFailure},
                               {"clean", b.clean}, {"status", b.status}, {"detail", b.detail},
                               {"createdAt", b.createdAt}, {"finishedAt", b.finishedAt},
                               {"builds", jobs(b.builds)}, {"then", jobs(b.then)}});
        }
        SaveJsonFileAtomic((fs::path(m_cfg.dataDir) / "batches.json").string(), arr);
    }

    void Coordinator::LoadBatches()
    {
        json j;
        if (!LoadJsonFile((fs::path(m_cfg.dataDir) / "batches.json").string(), j) || !j.is_array()) return;
        auto jobs = [](const json& a) {
            std::vector<BatchJobRef> v;
            if (!a.is_array()) return v;
            for (const auto& e : a)
                if (e.is_object())
                    v.push_back(BatchJobRef{ e.value("jobId", std::string()),
                                             e.value("product", std::string()),
                                             e.value("variant", std::string()) });
            return v;
        };
        std::lock_guard<std::mutex> lock(m_mutex);
        for (const auto& e : j)
        {
            if (!e.is_object()) continue;
            BatchDef b;
            b.id = e.value("id", std::string());
            b.projectId = e.value("projectId", std::string());
            b.name = e.value("name", std::string());
            b.branch = e.value("branch", std::string());
            b.commit = e.value("commit", std::string());
            b.onFailure = e.value("onFailure", std::string("finish"));
            b.clean = e.value("clean", false);
            b.status = e.value("status", std::string("building"));
            b.detail = e.value("detail", std::string());
            b.createdAt = e.value("createdAt", (int64_t)0);
            b.finishedAt = e.value("finishedAt", (int64_t)0);
            b.builds = jobs(e.value("builds", json::array()));
            b.then = jobs(e.value("then", json::array()));
            if (!b.id.empty() && !b.projectId.empty()) m_batches[b.id] = b;
        }
    }

    // Advance every batch the job belongs to and apply the resulting actions
    // (cancel siblings / queue the follow-up jobs). Caller holds m_mutex.
    void Coordinator::OnJobTerminalLocked(const std::string& jobId)
    {
        for (auto& kv : m_batches)
        {
            BatchDef& b = kv.second;
            if (b.status != "building" && b.status != "deploying") continue;
            auto contains = [&](const std::vector<BatchJobRef>& v) {
                for (const auto& j : v) if (j.jobId == jobId) return true;
                return false;
            };
            if (!contains(b.builds) && !contains(b.then)) continue;

            std::map<std::string, std::string> statusById;
            auto collect = [&](const std::vector<BatchJobRef>& v) {
                for (const auto& j : v)
                {
                    auto it = m_builds.find(j.jobId);
                    if (it != m_builds.end()) statusById[j.jobId] = it->second.status;
                }
            };
            collect(b.builds);
            collect(b.then);

            BatchActions act = BatchAdvance(b, statusById);

            for (const auto& cid : act.cancelJobIds) CancelBuildLocked(cid);

            if (act.queueThen)
            {
                for (auto& t : b.then)
                {
                    t.jobId = EnqueueBuildLocked(b.projectId, t.product, b.branch, b.commit,
                                                 "batch:" + b.name, t.variant, "", b.clean);
                    if (t.jobId.empty())
                    {
                        b.status = "failed";
                        b.detail = "could not queue follow-up " + t.product + " (no matching rule for branch " + b.branch + ")";
                        break;
                    }
                    // Tie the deploy to this run so its inputs are drawn from the
                    // batch's own builds, not a global latest-success scan.
                    auto dit = m_builds.find(t.jobId);
                    if (dit != m_builds.end()) { dit->second.batchId = b.id; m_store.SaveRecord(dit->second); }
                }
            }

            if (b.status == "succeeded" || b.status == "failed") b.finishedAt = NowMillis();
            if (act.changed || act.queueThen)
            {
                SaveBatchesLocked();
                EmitBatchEvent(b);
                LOG_INFO("Smith", "Batch %s (%s/%s): %s - %s", b.id.c_str(), b.projectId.c_str(),
                         b.name.c_str(), b.status.c_str(), b.detail.c_str());
            }
        }
    }

    void Coordinator::AdvanceAllBatchesLocked()
    {
        // Startup settling: jobs may have been marked "lost" while we were down.
        std::vector<std::string> jobIds;
        for (const auto& kv : m_batches)
        {
            const BatchDef& b = kv.second;
            if (b.status != "building" && b.status != "deploying") continue;
            for (const auto& j : b.builds) if (!j.jobId.empty()) { jobIds.push_back(j.jobId); break; }
        }
        for (const auto& id : jobIds) OnJobTerminalLocked(id);
    }

    // POST /api/batch
    //   { projectId, chain, branch?, reason?, onFailure?, pinCommit? }            - run a smith.json chain
    //   { projectId, builds:[{product, profile?}...], then:[...]?, branch?, ... } - ad-hoc
    // A build step's empty profile on a product WITH variants expands to all of them.
    void Coordinator::HandleBatchCreate(const Http::Request& req, Http::Response& res)
    {
        json body;
        if (!ParseBody(req, body) || !body.contains("projectId"))
        { JsonError(res, 400, "expected {projectId, chain | builds[]}"); return; }

        std::string projectId = body.value("projectId", std::string());
        RefreshProjectSource(projectId);   // batch with the smith.json at the repo's tip

        // Read the project source dir for commit pinning (brief lock, git runs unlocked).
        std::string srcDir;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            auto it = m_sources.find(projectId);
            if (it != m_sources.end() && !it->second.local) srcDir = it->second.dir;
        }

        BatchDef b;
        b.id = MakeShortId();
        b.projectId = projectId;
        b.name = "ad-hoc";
        b.branch = body.value("branch", std::string());
        b.onFailure = m_cfg.batchOnFailure;
        b.clean = body.value("clean", false);   // force a clean checkout for every build in the batch
        bool pinCommit = m_cfg.batchPinCommit;
        std::string reason = body.value("reason", std::string());

        std::vector<std::string> jobIds;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            const ProjectDef* proj = FindProject(projectId);
            if (!proj) { JsonError(res, 404, "unknown project"); return; }
            if (b.branch.empty())
            {
                for (const auto& r : proj->repos) if (r.primary) { b.branch = r.defaultBranch; break; }
                if (b.branch.empty()) b.branch = "main";
            }

            // Expand a {product, variants[]} step into concrete BatchJobRefs.
            std::string expandError;
            auto expand = [&](const std::string& product, const std::vector<std::string>& refs,
                              std::vector<BatchJobRef>& out) {
                const BuildProductDef* prod = FindProduct(*proj, product);
                if (!prod) { expandError = "unknown product '" + product + "'"; return; }
                if (refs.empty())
                {
                    if (prod->variants.empty()) { out.push_back(BatchJobRef{ "", product, "" }); return; }
                    for (const auto& v : prod->variants) out.push_back(BatchJobRef{ "", product, v.name });
                    return;
                }
                for (const auto& ref : refs)
                {
                    if (prod->variants.empty() && ref.empty()) { out.push_back(BatchJobRef{ "", product, "" }); continue; }
                    const ProductVariant* v = ResolveVariantRef(*prod, ref);
                    if (!v) { expandError = "unknown profile '" + ref + "' for product '" + product + "'"; return; }
                    out.push_back(BatchJobRef{ "", product, v->name });
                }
            };

            if (body.contains("chain"))
            {
                std::string chainName = body.value("chain", std::string());
                const ChainDef* chain = nullptr;
                for (const auto& c : proj->chains) if (c.name == chainName) chain = &c;
                if (!chain) { JsonError(res, 404, "unknown chain '" + chainName + "'"); return; }
                b.name = chain->name;
                if (!chain->onFailure.empty()) b.onFailure = chain->onFailure;
                if (chain->pinCommit >= 0) pinCommit = chain->pinCommit == 1;
                for (const auto& s : chain->builds) { expand(s.product, s.variants, b.builds); if (!expandError.empty()) break; }
                if (expandError.empty())
                    for (const auto& s : chain->then) { expand(s.product, s.variants, b.then); if (!expandError.empty()) break; }
            }
            else if (body.contains("builds") && body["builds"].is_array())
            {
                for (const auto& s : body["builds"])
                {
                    if (!s.is_object()) continue;
                    std::string profile = s.value("profile", std::string());
                    expand(s.value("product", std::string()),
                           profile.empty() ? std::vector<std::string>{} : std::vector<std::string>{ profile }, b.builds);
                    if (!expandError.empty()) break;
                }
                if (expandError.empty() && body.contains("then") && body["then"].is_array())
                    for (const auto& s : body["then"])
                    {
                        if (!s.is_object()) continue;
                        std::string profile = s.value("profile", std::string());
                        if (profile.empty()) b.then.push_back(BatchJobRef{ "", s.value("product", std::string()), "" });
                        else { expand(s.value("product", std::string()), { profile }, b.then); }
                        if (!expandError.empty()) break;
                    }
            }
            else { JsonError(res, 400, "expected 'chain' or 'builds'"); return; }

            if (!expandError.empty()) { JsonError(res, 400, expandError); return; }
            if (b.builds.empty()) { JsonError(res, 400, "the batch has no builds"); return; }

            // Per-request overrides (explicit beats chain beats coordinator default).
            if (body.contains("onFailure") && body["onFailure"].is_string()) b.onFailure = body["onFailure"].get<std::string>();
            if (body.contains("pinCommit") && body["pinCommit"].is_boolean()) pinCommit = body["pinCommit"].get<bool>();
            if (b.onFailure != "cancel") b.onFailure = "finish";

            // Fail FAST when a follow-up step can never queue on this branch (e.g. a
            // deploy whose rule is limited to main) - a 400 now beats discovering it
            // after an hour of platform builds.
            for (const auto& t : b.then)
            {
                const BuildProductDef* tp = FindProduct(*proj, t.product);
                if (!tp || !FindRule(*tp, b.branch))
                {
                    res.Json(json{{"error", "the follow-up '" + t.product + "' has no rule for branch '" +
                                            b.branch + "' - this batch could build but never " +
                                            (t.product.find("deploy") != std::string::npos ? "deploy" : "complete")}}.dump(), 400);
                    return;
                }
            }
        }

        // Pin every job in the batch to the branch tip the source checkout is at.
        // (RefreshProjectSource synced it moments ago; "" = unpinned local source.)
        if (pinCommit && !srcDir.empty()) b.commit = GitRepo::HeadSha(srcDir);

        {
            std::lock_guard<std::mutex> lock(m_mutex);
            for (auto& jref : b.builds)
            {
                jref.jobId = EnqueueBuildLocked(projectId, jref.product, b.branch, b.commit,
                                                reason.empty() ? ("batch:" + b.name) : reason,
                                                jref.variant, "", b.clean);
                if (jref.jobId.empty())
                {
                    // Atomicity: a step with no matching rule voids the whole batch.
                    for (const auto& done : b.builds)
                        if (!done.jobId.empty()) CancelBuildLocked(done.jobId);
                    res.Json(json{{"error", "no matching rule for " + jref.product +
                                            (jref.variant.empty() ? "" : ("/" + jref.variant)) +
                                            " on branch " + b.branch}}.dump(), 400);
                    return;
                }
                jobIds.push_back(jref.jobId);
            }

            b.createdAt = NowMillis();
            b.detail = "0/" + std::to_string(b.builds.size()) + " built";
            m_batches[b.id] = b;

            // Retention: drop the oldest SETTLED batches beyond batch.keep.
            int keep = m_cfg.batchKeep > 0 ? m_cfg.batchKeep : 50;
            std::vector<const BatchDef*> settled;
            for (const auto& kv : m_batches)
                if (kv.second.status == "succeeded" || kv.second.status == "failed") settled.push_back(&kv.second);
            if ((int)m_batches.size() > keep && !settled.empty())
            {
                std::sort(settled.begin(), settled.end(),
                          [](const BatchDef* a, const BatchDef* c) { return a->createdAt < c->createdAt; });
                for (const auto* victim : settled)
                {
                    if ((int)m_batches.size() <= keep) break;
                    m_batches.erase(victim->id);
                }
            }
            SaveBatchesLocked();
            EmitBatchEvent(b);
        }

        LOG_INFO("Smith", "Batch %s queued: %s/%s on %s (%d builds, %d follow-ups, commit %s)",
                 b.id.c_str(), projectId.c_str(), b.name.c_str(), b.branch.c_str(),
                 (int)b.builds.size(), (int)b.then.size(), b.commit.empty() ? "tip" : b.commit.substr(0, 9).c_str());
        res.Json(json{{"batchId", b.id}, {"jobIds", jobIds}, {"commit", b.commit}, {"name", b.name}}.dump());
    }

    void Coordinator::HandleBatchGet(const Http::Request& req, Http::Response& res)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_batches.find(req.Param("id"));
        if (it == m_batches.end()) { res.Set(404, "unknown batch"); return; }
        res.Json(BatchJson(it->second, m_builds).dump());
    }

    void Coordinator::HandleProjectBatches(const Http::Request& req, Http::Response& res)
    {
        std::string projectId = req.Param("id");
        std::vector<const BatchDef*> list;
        json arr = json::array();
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            for (const auto& kv : m_batches)
                if (kv.second.projectId == projectId) list.push_back(&kv.second);
            std::sort(list.begin(), list.end(),
                      [](const BatchDef* a, const BatchDef* b) { return a->createdAt > b->createdAt; });
            if (list.size() > 20) list.resize(20);
            for (const auto* b : list) arr.push_back(BatchJson(*b, m_builds));
        }
        res.Json(arr.dump());
    }
}
