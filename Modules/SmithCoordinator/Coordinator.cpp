// Coordinator.cpp - HTTP API, build queue, node registry, persistence, live logs.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Coordinator.h"
#include "CoordinatorUtil.h"
#include "WebAssets.h"

#include <SmithCore/NodeMatcher.h>
#include <SmithCore/Process.h>
#include <SmithCore/TimeUtil.h>
#include <SmithCore/Uuid.h>
#include <SmithCore/RepoConfig.h>
#include <SmithCore/GitUrl.h>
#include <SmithCore/Inputs.h>
#include <SmithCore/BuildDiagnosticsJson.h>
#include <SmithProtocol/WireJson.h>
#include <SmithAgent/Agent.h>
#include <Log/Log.h>

#include <json/single_include/nlohmann/json.hpp>

#include <algorithm>
#include <thread>
#include <chrono>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <set>
#include <iterator>
#include <cstdlib>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>

using nlohmann::json;
namespace fs = std::filesystem;

namespace Smith
{
    // Live-log stream tuning. The viewer keeps a bounded tail, so replaying more
    // than this on connect is work nobody sees; packing many lines per SSE frame
    // turns a 20k-line backlog into ~40 messages instead of 20k.
    static const int kStreamBackfillLines = 5000;
    static const int kStreamLinesPerFrame = 500;

    bool Coordinator::IsTerminal(const std::string& status)
    {
        return IsTerminalStatus(status);   // single definition: SmithCore/Batches.h
    }

    // Quoted FNV-1a of an asset's bytes, used as its ETag. Not a security hash -
    // it only has to change when the asset does.
    static std::string ContentTag(const std::string& bytes)
    {
        uint64_t h = 1469598103934665603ull;
        for (unsigned char c : bytes) { h ^= c; h *= 1099511628211ull; }
        char buf[24];
        std::snprintf(buf, sizeof(buf), "\"%016llx\"", (unsigned long long)h);
        return buf;
    }

    // Content type for a file served out of web/, matching what the embedded-asset
    // generator assigns. (The static mount does its own mapping internally, but we
    // serve these through a handler now so we can attach validators.)
    static std::string ContentTypeFor(const std::string& name)
    {
        auto ends = [&](const char* s) {
            size_t n = std::strlen(s);
            return name.size() >= n && name.compare(name.size() - n, n, s) == 0;
        };
        if (ends(".html")) return "text/html; charset=utf-8";
        if (ends(".js"))   return "text/javascript; charset=utf-8";
        if (ends(".css"))  return "text/css; charset=utf-8";
        if (ends(".json")) return "application/json";
        if (ends(".svg"))  return "image/svg+xml";
        if (ends(".png"))  return "image/png";
        if (ends(".ico"))  return "image/x-icon";
        return "application/octet-stream";
    }

    // One file under web/, cached in memory and re-read when it changes on disk.
    struct StaticFile
    {
        std::mutex mutex;
        std::string bytes;
        std::string etag;
        int64_t size = -1;
        int64_t mtime = 0;
    };

    static bool ReadFileText(const std::string& path, std::string& out)
    {
        std::ifstream in(path, std::ios::binary);
        if (!in) return false;
        std::ostringstream ss;
        ss << in.rdbuf();
        out = ss.str();
        return true;
    }

    // A node is online while its heartbeats are fresh; the window is explicit
    // config (nodeOfflineAfterSec) per the no-hidden-knobs rule.
    bool Coordinator::NodeOnlineLocked(const NodeRuntime& n, int64_t now) const
    {
        return (now - n.lastSeenMs) < (int64_t)m_cfg.nodeOfflineAfterSec * 1000;
    }

    // Minimal glob: '*' matches any run of characters. Used for branch matching.
    static bool GlobMatch(const std::string& pat, const std::string& s)
    {
        size_t p = 0, q = 0, star = std::string::npos, mark = 0;
        while (q < s.size())
        {
            if (p < pat.size() && (pat[p] == s[q]))
            {
                ++p; ++q;
            }
            else if (p < pat.size() && pat[p] == '*')
            {
                star = p++; mark = q;
            }
            else if (star != std::string::npos)
            {
                p = star + 1; q = ++mark;
            }
            else
            {
                return false;
            }
        }
        while (p < pat.size() && pat[p] == '*') ++p;
        return p == pat.size();
    }

    static bool BranchMatches(const std::vector<std::string>& pats, const std::string& branch)
    {
        if (pats.empty()) return true;
        for (const auto& p : pats) if (GlobMatch(p, branch)) return true;
        return false;
    }

    static json RecordJson(const BuildRecord& r)
    {
        return json{
            {"jobId", r.jobId}, {"projectId", r.projectId}, {"product", r.product},
            {"variant", r.variant}, {"targetOs", r.targetOs}, {"rule", r.rule},
            {"buildNumber", r.buildNumber}, {"branch", r.branch}, {"commit", r.commit},
            {"reason", r.reason}, {"status", r.status}, {"phase", r.phase}, {"nodeId", r.nodeId},
            {"nodeName", r.nodeName},
            {"authorName", r.authorName}, {"authorEmail", r.authorEmail},
            {"createdAt", r.createdAt}, {"startedAt", r.startedAt}, {"finishedAt", r.finishedAt},
            {"exitCode", r.exitCode}, {"durationMs", r.durationMs}, {"artifacts", r.artifacts},
            {"diag", DiagnosticsSummaryJson(r.diagnostics)}};
    }

    Coordinator::Coordinator(CoordinatorConfig cfg)
        : m_cfg(std::move(cfg)), m_store(m_cfg.dataDir)
    {
    }

    Coordinator::~Coordinator()
    {
        m_stopTriggers = true;
        m_stopAdd = true;
        m_stopDns = true;
        m_stopDiscord = true;
        m_addCv.notify_all();
        if (m_addThread.joinable()) m_addThread.join();
        if (m_triggerThread.joinable()) m_triggerThread.join();
        if (m_dnsThread.joinable()) m_dnsThread.join();
        if (m_discordThread.joinable()) m_discordThread.join();
        StopEmbeddedAgent();
    }

    bool Coordinator::LoadProjects()
    {
        bool allOk = true;
        for (const auto& path : m_cfg.projectConfigPaths)
        {
            ProjectDef proj;
            std::string err;
            if (LoadProjectConfig(path, proj, err))
            {
                std::error_code lec;
                fs::path p(path);
                proj.localDir = (fs::is_directory(p, lec) ? p : p.parent_path()).string();
                DiscoverProjectVariants(proj);
                LOG_INFO("Smith", "Loaded project '%s' from %s", proj.id.c_str(), path.c_str());
                m_projects[proj.id] = proj;
                // A --project local git work tree is itself pollable: register it as a
                // fetch-only source so poll/autobuild triggers can watch its remote. A local
                // source is NEVER synced/reset (see PollProjectBranches), so the operator's
                // working tree is untouched - the build agent checks the commit out elsewhere.
                std::error_code gec;
                if (fs::exists(fs::path(proj.localDir) / ".git", gec) && !m_sources.count(proj.id))
                {
                    ProjectSource src;
                    src.dir = proj.localDir; src.local = true; src.projectId = proj.id;
                    for (const auto& r : proj.repos) if (r.primary) { src.url = r.url; src.branch = r.defaultBranch; break; }
                    if (src.branch.empty()) src.branch = "main";
                    m_sources[proj.id] = src;
                    LOG_INFO("Smith", "Project '%s' is a local git tree - pollable (fetch-only) on %s",
                             proj.id.c_str(), src.branch.c_str());
                }
            }
            else
            {
                LOG_ERROR("Smith", "Failed to load project config %s: %s", path.c_str(), err.c_str());
                allOk = false;
            }
        }
        return allOk;
    }

    void Coordinator::DiscoverProjectVariants(ProjectDef& def) const
    {
        if (def.localDir.empty()) return;
        for (auto& prod : def.products)
        {
            if (prod.discover.type.empty()) continue;
            prod.variants = DiscoverVariants(def.localDir, prod.discover);
            LOG_INFO("Smith", "Discovered %d build variant(s) for %s/%s",
                     (int)prod.variants.size(), def.id.c_str(), prod.name.c_str());
        }
    }

    const ProjectDef* Coordinator::FindProject(const std::string& id) const
    {
        auto it = m_projects.find(id);
        return it == m_projects.end() ? nullptr : &it->second;
    }

    const BuildProductDef* Coordinator::FindProduct(const ProjectDef& proj, const std::string& name) const
    {
        for (const auto& p : proj.products) if (p.name == name) return &p;
        return nullptr;
    }

    const BuildRuleDef* Coordinator::FindRule(const BuildProductDef& product, const std::string& branch) const
    {
        for (const auto& r : product.rules)
            if (r.enabled && BranchMatches(r.branches, branch)) return &r;
        return nullptr;
    }

    bool Coordinator::GetBuildCopy(const std::string& jobId, BuildRecord& out)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_builds.find(jobId);
        if (it == m_builds.end()) return false;
        out = it->second;
        return true;
    }

    bool Coordinator::Authorized(const Http::Request& req) const
    {
        // A signed-in human (valid session bearer) is always accepted.
        if (RequestHasSession(req)) return true;
        if (m_cfg.token.empty()) return true;
        // Loopback bypass is for a DIRECT local request only. If the request arrived
        // through a proxy (X-Forwarded-For present) - e.g. a TLS reverse proxy used to
        // expose Smith over a WAN - the peer is the proxy on localhost, so we must NOT
        // grant the bypass; the remote client still has to present the token.
        bool viaProxy = !req.HeaderValue("X-Forwarded-For").empty();
        if (!m_cfg.requireTokenAlways && !viaProxy &&
            (req.remoteAddr == "127.0.0.1" || req.remoteAddr == "::1")) return true;
        return req.HeaderValue("Authorization") == ("Bearer " + m_cfg.token);
    }

    // ----------------------------------------------------------------- handlers

    void Coordinator::PushEvent(std::string payload)
    {
        constexpr size_t kEventRingCap = 500;
        std::lock_guard<std::mutex> lock(m_eventsMutex);
        m_events.emplace_back(++m_eventSeq, std::move(payload));
        if (m_events.size() > kEventRingCap)
            m_events.erase(m_events.begin(), m_events.begin() + (m_events.size() - kEventRingCap));
    }

    void Coordinator::EmitBuildEvent(const std::string& type, const BuildRecord& rec)
    {
        json e = {
            {"type", type}, {"jobId", rec.jobId}, {"projectId", rec.projectId}, {"product", rec.product},
            {"variant", rec.variant}, {"branch", rec.branch}, {"buildNumber", rec.buildNumber},
            {"status", rec.status}, {"phase", rec.phase}, {"exitCode", rec.exitCode},
            {"node", rec.nodeName}, {"errorCount", rec.diagnostics.errorCount},
            {"warningCount", rec.diagnostics.warningCount}, {"ts", NowMillis()}
        };
        PushEvent(e.dump());
    }

    void Coordinator::HandleTrigger(const Http::Request& req, Http::Response& res)
    {
        TriggerRequest tr;
        if (!FromJson(req.body, tr)) { res.Set(400, "bad request"); return; }
        RefreshProjectSource(tr.projectId);   // build with the smith.json at the repo's tip
        std::string branchErr;                // ...and a non-tracked branch with its own smith.json
        if (!LoadBranchProject(tr.projectId, tr.branch, true, branchErr))
            LOG_WARNING("Smith", "trigger %s@%s: %s (using the project's smith.json)",
                        tr.projectId.c_str(), tr.branch.c_str(), branchErr.c_str());
        // Profiles accept the variant's name OR its slug alias ("steam-windows").
        if (!tr.profile.empty())
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            const ProjectDef* proj = FindProject(tr.projectId);
            const BuildProductDef* prod = proj ? FindProductForBranch(*proj, tr.product, tr.branch) : nullptr;
            if (prod && !prod->variants.empty())
            {
                const ProductVariant* v = ResolveVariantRef(*prod, tr.profile);
                if (!v) { JsonError(res, 400, "unknown profile '" + tr.profile + "'"); return; }
                tr.profile = v->name;
            }
        }
        std::string jobId = EnqueueBuild(tr.projectId, tr.product, tr.branch, tr.commit,
                                         tr.reason.empty() ? "manual" : tr.reason, tr.profile, tr.targetOs, tr.clean);
        if (jobId.empty()) { JsonError(res, 404, "no matching project/product/rule"); return; }
        res.Json(json{{"jobId", jobId}}.dump());
    }

    void Coordinator::HandleProjects(const Http::Request&, Http::Response& res)
    {
        json arr = json::array();
        std::lock_guard<std::mutex> lock(m_mutex);
        for (const auto& kv : m_projects)
        {
            const ProjectDef& p = kv.second;
            json products = json::array();
            for (const auto& prod : p.products)
            {
                json variants = json::array();
                for (const auto& v : prod.variants)
                    variants.push_back(json{{"name", v.name}, {"slug", v.slug}, {"os", v.os}, {"labels", v.labels}});
                bool hasInputs = false;
                for (const auto& r : prod.rules) if (!r.inputs.empty()) hasInputs = true;
                products.push_back(json{{"name", prod.name}, {"param", prod.discover.as},
                                        {"variants", variants}, {"hasInputs", hasInputs}});
            }
            json chains = json::array();
            for (const auto& c : p.chains)
            {
                json steps = json::array(), then = json::array();
                for (const auto& s : c.builds) steps.push_back(json{{"product", s.product}, {"variants", s.variants}});
                for (const auto& s : c.then) then.push_back(json{{"product", s.product}, {"variants", s.variants}});
                chains.push_back(json{{"name", c.name}, {"builds", steps}, {"then", then}});
            }
            // The repo's own smith.json triggers (poll / schedule / webhook), one entry per
            // branch, so the UI can show them next to the UI-managed autobuild rules. Defaults
            // resolved as the poller resolves them: no branches = the source branch, no
            // product = the first product, no interval = the coordinator's poll interval.
            json repoTriggers = json::array();
            auto src = m_sources.find(p.id);
            auto polled = m_pollState.find(p.id);
            for (const auto& t : p.triggers)
            {
                if (t.type == "manual") continue;
                std::string product = !t.product.empty() ? t.product : (p.products.empty() ? "" : p.products[0].name);
                std::vector<std::string> branches = t.branches;
                if (branches.empty()) branches.push_back(src != m_sources.end() ? src->second.branch : "");
                for (const auto& b : branches)
                {
                    std::string lastSha;
                    if (t.type == "poll" && polled != m_pollState.end())
                    {
                        auto s = polled->second.find(b);
                        if (s != polled->second.end()) lastSha = s->second;
                    }
                    repoTriggers.push_back(json{{"type", t.type}, {"branch", b}, {"product", product},
                                                {"intervalSeconds", t.intervalSeconds > 0 ? t.intervalSeconds : m_cfg.pollIntervalSec},
                                                {"cron", t.cron}, {"lastSha", lastSha}});
                }
            }
            arr.push_back(json{{"id", p.id}, {"name", p.name}, {"description", p.description},
                               {"products", products}, {"chains", chains}, {"repoTriggers", repoTriggers}});
        }
        res.Json(arr.dump());
    }

    // Newest first. `?limit=N` caps the response: every caller shows a bounded
    // slice (12 per project in the UI), but this used to serialize the project's
    // entire history - and copy every record, diagnostics vectors included, while
    // holding the lock. Now only the N that survive the sort are copied. No limit
    // still means everything: `smith status` and the tray read this too.
    void Coordinator::HandleProjectBuilds(const Http::Request& req, Http::Response& res)
    {
        std::string id = req.Param("id");
        int limit = std::atoi(req.Param("limit", "0").c_str());
        std::vector<BuildRecord> builds;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            std::vector<const BuildRecord*> hits;
            for (const auto& kv : m_builds) if (kv.second.projectId == id) hits.push_back(&kv.second);
            auto newest = [](const BuildRecord* a, const BuildRecord* b) { return a->buildNumber > b->buildNumber; };
            if (limit > 0 && (int)hits.size() > limit)
            {
                std::partial_sort(hits.begin(), hits.begin() + limit, hits.end(), newest);
                hits.resize(limit);
            }
            else std::sort(hits.begin(), hits.end(), newest);
            builds.reserve(hits.size());
            for (const auto* r : hits) builds.push_back(*r);
        }
        json arr = json::array();
        for (const auto& r : builds) arr.push_back(RecordJson(r));
        res.Json(arr.dump());
    }

    // The dashboard shows three counters and ten recent builds. It used to derive
    // them client-side from every project's complete build history: 2 + one request
    // per project, ~1.2MB for 1948 builds, to display ~4KB. One request now.
    // `?since=` is the viewer's local midnight, so "builds today" stays in the
    // browser's timezone rather than the coordinator's.
    void Coordinator::HandleOverview(const Http::Request& req, Http::Response& res)
    {
        const size_t kRecent = 10;
        int64_t since = std::atoll(req.Param("since", "0").c_str());
        int nodeCount = 0, idleCount = 0, projectCount = 0, buildsSince = 0;
        std::vector<BuildRecord> recent;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            int64_t now = NowMillis();
            for (const auto& kv : m_nodes)
            {
                ++nodeCount;
                if (NodeOnlineLocked(kv.second, now) && kv.second.status == "idle") ++idleCount;
            }
            projectCount = (int)m_projects.size();

            std::vector<const BuildRecord*> all;
            all.reserve(m_builds.size());
            for (const auto& kv : m_builds)
            {
                if (since > 0 && kv.second.createdAt >= since) ++buildsSince;
                all.push_back(&kv.second);
            }
            auto newest = [](const BuildRecord* a, const BuildRecord* b) { return a->createdAt > b->createdAt; };
            if (all.size() > kRecent)
            {
                std::partial_sort(all.begin(), all.begin() + kRecent, all.end(), newest);
                all.resize(kRecent);
            }
            else std::sort(all.begin(), all.end(), newest);
            recent.reserve(all.size());
            for (const auto* r : all) recent.push_back(*r);
        }
        json arr = json::array();
        for (const auto& r : recent) arr.push_back(RecordJson(r));
        res.Json(json{{"nodes", nodeCount}, {"idleNodes", idleCount}, {"projects", projectCount},
                      {"buildsSince", buildsSince}, {"recent", arr}}.dump());
    }

    // Shields-style flat SVG build badge for the latest build of a project (or a
    // specific ?product=). Public so it can be embedded in a README.
    void Coordinator::HandleBadge(const Http::Request& req, Http::Response& res)
    {
        std::string id = req.Param("id");
        std::string product = req.Param("product");   // optional query param

        bool found = false;
        BuildRecord latest;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            for (const auto& kv : m_builds)
            {
                const BuildRecord& r = kv.second;
                if (r.projectId != id) continue;
                if (!product.empty() && r.product != product) continue;
                if (!found || r.buildNumber > latest.buildNumber) { latest = r; found = true; }
            }
        }

        std::string label = product.empty() ? id : (id + "/" + product);
        std::string status, color;
        if (!found)                                              { status = "no builds"; color = "#9f9f9f"; }
        else if (latest.status == "success")                     { status = "passing";   color = "#4c1"; }
        else if (latest.status == "failed" || latest.status == "error") { status = "failing"; color = "#e05d44"; }
        else if (latest.status == "lost")                        { status = "lost";      color = "#9f9f9f"; }
        else                                                     { status = "building";  color = "#dfb317"; }

        auto esc = [](const std::string& s) {
            std::string o;
            for (char c : s) { if (c == '&') o += "&amp;"; else if (c == '<') o += "&lt;"; else if (c == '>') o += "&gt;"; else o += c; }
            return o;
        };
        // Approximate text widths (Verdana 11px ~ 6.5px/char) + padding.
        int lw = (int)(label.size() * 65) / 10 + 10;
        int rw = (int)(status.size() * 65) / 10 + 10;
        int w = lw + rw;
        std::string L = esc(label), S = esc(status);
        std::string svg =
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + std::to_string(w) + "\" height=\"20\" "
            "role=\"img\" aria-label=\"" + L + ": " + S + "\">"
            "<linearGradient id=\"s\" x2=\"0\" y2=\"100%\"><stop offset=\"0\" stop-color=\"#bbb\" stop-opacity=\".1\"/>"
            "<stop offset=\"1\" stop-opacity=\".1\"/></linearGradient>"
            "<clipPath id=\"r\"><rect width=\"" + std::to_string(w) + "\" height=\"20\" rx=\"3\" fill=\"#fff\"/></clipPath>"
            "<g clip-path=\"url(#r)\">"
            "<rect width=\"" + std::to_string(lw) + "\" height=\"20\" fill=\"#555\"/>"
            "<rect x=\"" + std::to_string(lw) + "\" width=\"" + std::to_string(rw) + "\" height=\"20\" fill=\"" + color + "\"/>"
            "<rect width=\"" + std::to_string(w) + "\" height=\"20\" fill=\"url(#s)\"/>"
            "</g>"
            "<g fill=\"#fff\" text-anchor=\"middle\" font-family=\"Verdana,DejaVu Sans,Geneva,sans-serif\" font-size=\"11\">"
            "<text x=\"" + std::to_string(lw / 2) + "\" y=\"14\">" + L + "</text>"
            "<text x=\"" + std::to_string(lw + rw / 2) + "\" y=\"14\">" + S + "</text>"
            "</g></svg>";

        res.headers["Cache-Control"] = "no-cache";
        res.Set(200, svg, "image/svg+xml");
    }

    void Coordinator::HandleBuild(const Http::Request& req, Http::Response& res)
    {
        BuildRecord rec;
        if (!GetBuildCopy(req.Param("jobId"), rec)) { res.Set(404, "unknown build"); return; }
        res.Json(RecordJson(rec).dump());
    }

    // Index of the first character of the last `lines` lines of `text`, plus how
    // many lines were skipped to get there. Used to serve only the tail a viewer
    // can actually display without shipping (and re-splitting) the whole log.
    static size_t TailOffset(const std::string& text, int lines, int& skippedOut)
    {
        skippedOut = 0;
        if (lines <= 0 || text.empty()) return 0;
        size_t pos = text.size();
        int seen = 0;
        // A trailing newline terminates the last line rather than starting a new one.
        if (pos > 0 && text[pos - 1] == '\n') --pos;
        while (pos > 0)
        {
            size_t nl = text.rfind('\n', pos - 1);
            if (nl == std::string::npos) return 0;   // fewer than `lines` lines in total
            ++seen;
            if (seen >= lines) { skippedOut = (int)std::count(text.begin(), text.begin() + nl + 1, '\n'); return nl + 1; }
            pos = nl;
        }
        return 0;
    }

    // GET /api/builds/:jobId/log[?tail=N] - the whole log by default (the CLI and
    // "Download full log" rely on that); ?tail=N serves only the last N lines and
    // reports how many it skipped in X-Log-Skipped-Lines.
    void Coordinator::HandleBuildLog(const Http::Request& req, Http::Response& res)
    {
        BuildRecord rec;
        if (!GetBuildCopy(req.Param("jobId"), rec)) { res.Set(404, "unknown build"); return; }
        std::string log;
        m_store.ReadLog(rec, log);
        int tail = std::atoi(req.Param("tail", "0").c_str());
        if (tail > 0)
        {
            int skipped = 0;
            size_t off = TailOffset(log, tail, skipped);
            if (off > 0) log.erase(0, off);
            res.headers["X-Log-Skipped-Lines"] = std::to_string(skipped);
        }
        res.Set(200, log, "text/plain; charset=utf-8");
    }

    // -------------------------------------------------------------------- wiring

    void Coordinator::RegisterRoutes()
    {
        auto guard = [this](void (Coordinator::*fn)(const Http::Request&, Http::Response&))
        {
            return [this, fn](const Http::Request& req, Http::Response& res)
            {
                if (!Authorized(req)) { res.Set(401, "unauthorized"); return; }
                (this->*fn)(req, res);
            };
        };
        // Human (UI/data/admin) endpoints. When Google sign-in is enabled with
        // --require-login this demands a valid session (or the operator token) even
        // on loopback, so a local browser can't skip login; otherwise it is the same
        // rule as `guard`. Agent endpoints keep using `guard` (token/loopback).
        auto guardHuman = [this](void (Coordinator::*fn)(const Http::Request&, Http::Response&))
        {
            return [this, fn](const Http::Request& req, Http::Response& res)
            {
                if (!AuthorizedHuman(req)) { res.Set(401, "unauthorized"); return; }
                (this->*fn)(req, res);
            };
        };
        // Like guardHuman, but also accepts the session as ?access_token= - for plain
        // <a href> downloads (artifacts, raw log) where the browser can't send a bearer
        // header. Mirrors the SSE stream's auth; only matters under --require-login.
        auto guardHumanDl = [this](void (Coordinator::*fn)(const Http::Request&, Http::Response&))
        {
            return [this, fn](const Http::Request& req, Http::Response& res)
            {
                if (!AuthorizedHuman(req) && !SessionTokenLive(req.Param("access_token")))
                { res.Set(401, "unauthorized"); return; }
                (this->*fn)(req, res);
            };
        };

        // Auth: public config + the Google sign-in exchange; me/logout check inside.
        m_server.Get("/api/auth/config", [this](const Http::Request& q, Http::Response& s) { HandleAuthConfig(q, s); });
        m_server.Post("/api/auth/google", [this](const Http::Request& q, Http::Response& s) { HandleAuthGoogle(q, s); });
        m_server.Get("/api/auth/me", [this](const Http::Request& q, Http::Response& s) { HandleAuthMe(q, s); });
        m_server.Post("/api/auth/logout", [this](const Http::Request& q, Http::Response& s) { HandleAuthLogout(q, s); });

        m_server.Post("/api/agents/register", guard(&Coordinator::HandleRegister));
        m_server.Post("/api/agents/:nodeId/heartbeat", guard(&Coordinator::HandleHeartbeat));
        m_server.Get("/api/agents/:nodeId/service", guard(&Coordinator::HandleAgentService));
        m_server.Get("/api/jobs/next", guard(&Coordinator::HandleJobsNext));
        m_server.Post("/api/jobs/:jobId/log", guard(&Coordinator::HandleLog));
        m_server.Post("/api/jobs/:jobId/status", guard(&Coordinator::HandleStatus));
        m_server.Post("/api/jobs/:jobId/result", guard(&Coordinator::HandleResult));
        m_server.Post("/api/jobs/:jobId/artifacts/:name", guard(&Coordinator::HandleArtifactUpload));
        // Agent-facing artifact download (staging a job's declared inputs); same
        // payload as the human /api/builds/... route but token/loopback guarded.
        m_server.Get("/api/jobs/:jobId/artifacts/:name", guard(&Coordinator::HandleArtifactDownload));
        m_server.Post("/api/trigger", guardHuman(&Coordinator::HandleTrigger));
        m_server.Post("/api/builds/:jobId/rerun", guardHuman(&Coordinator::HandleRerun));
        m_server.Post("/api/builds/:jobId/cancel", guardHuman(&Coordinator::HandleCancel));
        m_server.Post("/api/projects", guardHuman(&Coordinator::HandleAddProject));
        m_server.Get("/api/project-requests", guardHuman(&Coordinator::HandleProjectRequests));
        m_server.Post("/api/projects/:id/clear-builds", guardHuman(&Coordinator::HandleClearBuilds));
        m_server.Get("/api/users", guardHuman(&Coordinator::HandleUsers));
        m_server.Post("/api/users", guardHuman(&Coordinator::HandleUsers));
        m_server.Post("/api/users/:id/delete", guardHuman(&Coordinator::HandleDeleteUser));
        m_server.Get("/api/projects/:id/autobuilds", guardHuman(&Coordinator::HandleAutobuilds));
        m_server.Post("/api/projects/:id/autobuilds", guardHuman(&Coordinator::HandleAutobuilds));
        m_server.Post("/api/autobuilds/:ruleId/delete", guardHuman(&Coordinator::HandleDeleteAutobuild));
        m_server.Get("/api/projects/:id/branch-products", guardHuman(&Coordinator::HandleBranchProducts));
        m_server.Get("/api/config", guardHuman(&Coordinator::HandleConfig));
        m_server.Post("/api/config", guardHuman(&Coordinator::HandleConfig));
        m_server.Get("/api/config/status", guardHuman(&Coordinator::HandleConfigStatus));
        m_server.Post("/api/webhook/git/:projectId",
            [this](const Http::Request& req, Http::Response& res) { HandleWebhook(req, res); });
        m_server.Get("/api/nodes", guardHuman(&Coordinator::HandleNodes));
        m_server.Get("/api/projects", guardHuman(&Coordinator::HandleProjects));
        m_server.Get("/api/projects/:id/builds", guardHuman(&Coordinator::HandleProjectBuilds));
        m_server.Get("/api/overview", guardHuman(&Coordinator::HandleOverview));
        m_server.Get("/api/projects/:id/pipeline", guardHuman(&Coordinator::HandlePipeline));
        m_server.Post("/api/batch", guardHuman(&Coordinator::HandleBatchCreate));
        m_server.Get("/api/batch/:id", guardHuman(&Coordinator::HandleBatchGet));
        m_server.Get("/api/projects/:id/batches", guardHuman(&Coordinator::HandleProjectBatches));
        m_server.Post("/api/steam-guard", guardHuman(&Coordinator::HandleSteamGuard));
        m_server.Get("/api/steam-guard/:id", guardHuman(&Coordinator::HandleSteamGuardStatus));
        m_server.Post("/api/steam-guard/:id/result", guard(&Coordinator::HandleSteamGuardResult));
        // Status badge is intentionally public (no auth guard) so it can be embedded in a README.
        m_server.Get("/api/projects/:id/badge", [this](const Http::Request& q, Http::Response& s) { HandleBadge(q, s); });
        m_server.Get("/api/builds/:jobId", guardHuman(&Coordinator::HandleBuild));
        m_server.Get("/api/builds/:jobId/diagnostics", guardHuman(&Coordinator::HandleBuildDiagnostics));
        m_server.Get("/api/builds/:jobId/log", guardHumanDl(&Coordinator::HandleBuildLog));
        m_server.Get("/api/builds/:jobId/artifacts/:name", guardHumanDl(&Coordinator::HandleArtifactDownload));

        // Build-lifecycle events (SSE): queued/running/success/failed/error/cancelled. The
        // Discord bot subscribes for notifications. Streams only events that arrive after the
        // connection opens (no history replay), with a periodic ping to drop dead peers.
        m_server.Stream("/api/events",
            [this](const Http::Request& req, const Http::SseSend& send)
            {
                if (!AuthorizedHuman(req) && !SessionTokenLive(req.Param("access_token")))
                { send("event: error\ndata: {\"error\":\"unauthorized\"}\n\n"); return; }
                int64_t last;
                { std::lock_guard<std::mutex> lock(m_eventsMutex); last = m_eventSeq; }
                if (!send(": connected\n\n")) return;
                int idle = 0;
                for (;;)
                {
                    std::vector<std::string> out;
                    {
                        std::lock_guard<std::mutex> lock(m_eventsMutex);
                        for (const auto& e : m_events) if (e.first > last) { out.push_back(e.second); last = e.first; }
                    }
                    for (const auto& s : out) if (!send("data: " + s + "\n\n")) return;
                    if (out.empty()) { if (++idle >= 20) { idle = 0; if (!send(": ping\n\n")) return; } }
                    else idle = 0;
                    std::this_thread::sleep_for(std::chrono::milliseconds(500));
                }
            });

        // Live log stream (SSE). Auth is enforced inside since loopback is allowed.
        m_server.Stream("/api/builds/:jobId/stream",
            [this](const Http::Request& req, const Http::SseSend& send)
            {
                // EventSource can't set an Authorization header, so the browser may
                // pass its session as ?access_token= instead (only needed when login
                // is enforced; otherwise AuthorizedHuman already allows loopback/token).
                if (!AuthorizedHuman(req) && !SessionTokenLive(req.Param("access_token")))
                { send("event: error\ndata: {\"error\":\"unauthorized\"}\n\n"); return; }
                std::string jobId = req.Param("jobId");
                BuildRecord rec;
                if (!GetBuildCopy(jobId, rec)) { send("event: error\ndata: {\"error\":\"unknown build\"}\n\n"); return; }
                std::string logPath = m_store.LogPath(rec);

                // Start near the tail. The viewer only keeps the last few thousand
                // lines anyway, so replaying a build that is already 100k lines deep
                // just to throw it away costs the server a flood of frames and the
                // browser a multi-second stall. Tell the client what it missed.
                size_t offset = 0;
                {
                    std::string existing;
                    if (ReadFileText(logPath, existing))
                    {
                        int skipped = 0;
                        offset = TailOffset(existing, kStreamBackfillLines, skipped);
                        if (skipped > 0)
                            send("event: skipped\ndata: {\"lines\":" + std::to_string(skipped) + "}\n\n");
                    }
                }

                std::string pending;
                auto pump = [&]() -> bool {
                    std::ifstream in(logPath, std::ios::binary);
                    if (in)
                    {
                        in.seekg(0, std::ios::end);
                        size_t sz = (size_t)in.tellg();
                        if (sz > offset)
                        {
                            in.seekg((std::streamoff)offset);
                            std::string chunk;
                            chunk.resize(sz - offset);
                            in.read(&chunk[0], (std::streamsize)(sz - offset));
                            offset = sz;
                            pending += chunk;
                        }
                    }
                    // Pack whole lines into as few SSE frames as possible: EventSource
                    // joins consecutive `data:` fields with "\n", so one frame carrying
                    // 500 lines arrives as one onmessage instead of 500. Bare '\r' is a
                    // line terminator to an SSE parser, so it separates lines here too -
                    // otherwise a CR-updating progress line silently truncates the rest.
                    // A trailing '\r' may be the first half of a CRLF split across two
                    // reads, so leave it for the next pass rather than emitting an
                    // empty line for the '\n' that follows.
                    size_t limit = pending.size();
                    if (limit > 0 && pending[limit - 1] == '\r') --limit;
                    std::string frame;
                    int packed = 0;
                    size_t start = 0;
                    for (;;)
                    {
                        size_t brk = pending.find_first_of("\r\n", start);
                        if (brk == std::string::npos || brk >= limit) break;
                        frame += "data: ";
                        frame.append(pending, start, brk - start);
                        frame += "\n";
                        start = brk + 1;
                        if (pending[brk] == '\r' && start < pending.size() && pending[start] == '\n') ++start;
                        if (++packed >= kStreamLinesPerFrame)
                        {
                            frame += "\n";
                            if (!send(frame)) return false;
                            frame.clear();
                            packed = 0;
                        }
                    }
                    pending.erase(0, start);
                    if (packed > 0)
                    {
                        frame += "\n";
                        if (!send(frame)) return false;
                    }
                    return true;
                };

                for (;;)
                {
                    if (!pump()) return;
                    BuildRecord cur;
                    bool ok = GetBuildCopy(jobId, cur);
                    if (ok && IsTerminal(cur.status))
                    {
                        if (!pump()) return;
                        if (!pending.empty()) send("data: " + pending + "\n\n");
                        send(std::string("event: done\ndata: {\"status\":\"") + cur.status +
                             "\",\"exitCode\":" + std::to_string(cur.exitCode) + "}\n\n");
                        return;
                    }
                    std::this_thread::sleep_for(std::chrono::milliseconds(250));
                }
            });
    }

    bool Coordinator::Start()
    {
        m_store.Init();

        // Restore persisted state.
        for (const auto& r : m_store.LoadAllRecords())
        {
            m_builds[r.jobId] = r;
            // Builds left "running" from a previous run are marked lost.
            if (!IsTerminal(r.status) && r.status != "queued")
            {
                m_builds[r.jobId].status = "lost";
                m_store.SaveRecord(m_builds[r.jobId]);
            }
        }
        // Queued builds SURVIVE a restart - but the dispatch queue is in-memory, so
        // rebuild it (oldest first) or they sit "queued" forever, invisible to
        // HandleJobsNext. (Found when a coordinator restart orphaned a batch's
        // gated follow-up job.)
        {
            std::vector<const BuildRecord*> queued;
            for (const auto& kv : m_builds)
                if (kv.second.status == "queued") queued.push_back(&kv.second);
            std::sort(queued.begin(), queued.end(),
                      [](const BuildRecord* a, const BuildRecord* b) { return a->createdAt < b->createdAt; });
            for (const auto* r : queued) m_queue.push_back(r->jobId);
            if (!queued.empty())
                LOG_INFO("Smith", "Restored %d queued build(s) to the dispatch queue", (int)queued.size());
        }
        // Node registrations are ephemeral: agents re-register (via discovery /
        // heartbeat) within seconds of the coordinator coming up, so we deliberately
        // do NOT restore them from disk - doing so just resurrected dead nodes (one
        // stale entry per past run) on every restart.

        // Clone/refresh projects added by git repo (reads each repo's smith.json).
        LoadProjectRepos();

        RegisterRoutes();

        // Static web UI: prefer a web/ dir on disk (dev hot-reload), otherwise serve
        // the assets embedded at build time so Smith runs as a single self-contained
        // binary with no sibling files. (WebAssets.cpp is generated from web/.)
        std::string webDir = m_cfg.webDir;
        if (webDir.empty() && fs::is_directory("web")) webDir = "web";
        if (!webDir.empty() && fs::is_directory(webDir))
        {
            // Serve each file through a handler instead of the static mount, which
            // sends no validators at all - so every page load re-downloaded the whole
            // UI. Each file re-reads itself when its size or mtime moves, so editing
            // web/ is still live with no restart, but an unchanged one answers
            // If-None-Match with a 304.
            //
            // Deliberately NOT also mounting the directory: cpp-httplib tries mount
            // points before the route table, so a mount would shadow every one of
            // these handlers and put us straight back to no caching. The cost is that
            // a file ADDED to web/ while the coordinator runs needs a restart to be
            // picked up; editing existing ones is unaffected.
            std::error_code ec;
            int count = 0;
            for (const auto& entry : fs::directory_iterator(webDir, ec))
            {
                if (!entry.is_regular_file(ec)) continue;
                std::string full = entry.path().string();
                std::string name = entry.path().filename().string();
                std::string ct = ContentTypeFor(name);
                auto file = std::make_shared<StaticFile>();
                auto handler = [full, ct, file](const Http::Request& req, Http::Response& res)
                {
                    std::error_code fec;
                    int64_t size = (int64_t)fs::file_size(full, fec);
                    int64_t mtime = fec ? 0 : (int64_t)fs::last_write_time(full, fec).time_since_epoch().count();
                    std::lock_guard<std::mutex> lock(file->mutex);
                    if (file->etag.empty() || size != file->size || mtime != file->mtime)
                    {
                        if (!ReadFileText(full, file->bytes)) { res.Set(404, "not found"); return; }
                        file->size = size;
                        file->mtime = mtime;
                        file->etag = ContentTag(file->bytes);
                    }
                    res.headers["ETag"] = file->etag;
                    res.headers["Cache-Control"] = "no-cache";
                    if (req.HeaderValue("If-None-Match") == file->etag) { res.Set(304, "", ct); return; }
                    res.Set(200, file->bytes, ct);
                };
                m_server.Get("/" + name, handler);
                if (name == "index.html") m_server.Get("/", handler);
                ++count;
            }
            LOG_INFO("Smith", "Serving web UI from %s (%d file(s); restart to pick up new ones)",
                     webDir.c_str(), count);
        }
        else if (WebAssetCount() > 0)
        {
            const WebAsset* assets = WebAssets();
            for (int i = 0; assets[i].path != nullptr; ++i)
            {
                std::string body(reinterpret_cast<const char*>(assets[i].data), assets[i].size);
                std::string ct = assets[i].contentType;
                // Embedded assets are fixed for the life of the binary, so tag each with
                // its content hash. Without any cache headers the browser re-fetched the
                // whole UI - ~125KB of JS, CSS and icon - on every page load and every
                // refresh; now that costs a 304. Still "no-cache" (revalidate, don't
                // reuse blind) so a redeployed coordinator's UI is picked up at once.
                std::string etag = ContentTag(body);
                auto handler = [body, ct, etag](const Http::Request& req, Http::Response& res)
                {
                    res.headers["ETag"] = etag;
                    res.headers["Cache-Control"] = "no-cache";
                    if (req.HeaderValue("If-None-Match") == etag) { res.Set(304, "", ct); return; }
                    res.Set(200, body, ct);
                };
                m_server.Get(std::string("/") + assets[i].path, handler);
                if (std::string(assets[i].path) == "index.html") m_server.Get("/", handler);
            }
            LOG_INFO("Smith", "Serving embedded web UI (%d assets)", WebAssetCount());
        }
        else
        {
            LOG_WARNING("Smith", "No web UI directory found; API only (set --web-dir)");
        }

        // Restore poll baselines BEFORE the poller starts; otherwise its first pass
        // sees an empty state, re-baselines to current HEAD, and silently swallows any
        // commit pushed while the coordinator was down.
        LoadPollState();
        LoadAutobuilds();
        LoadBatches();
        // Builds may have been marked "lost" above; settle any batch they belonged to.
        { std::lock_guard<std::mutex> lock(m_mutex); AdvanceAllBatchesLocked(); }
        m_triggerThread = std::thread([this]() { TriggerLoop(); });
        if (DnsConfigured()) m_dnsThread = std::thread([this]() { DnsLoop(); });
        if (DiscordConfigured()) m_discordThread = std::thread([this]() { DiscordLoop(); });

        // Background add-project worker (clones repos off the request thread). Restore
        // request history first; any interrupted pending/cloning request is re-queued.
        LoadRequests();
        LoadUsers();
        LoadSessions();
        m_addThread = std::thread([this]() { AddWorkerLoop(); });

        if (m_cfg.withAgent) StartEmbeddedAgent();

        // LAN discovery: let agents find us without a --coordinator URL. Advertise
        // the HTTP port; agents reach us via the reply's source IP, so this works
        // even though the HTTP server binds 0.0.0.0. Bind failure is non-fatal.
        if (m_cfg.discoveryEnabled)
        {
            if (m_discovery.Start(m_cfg.discoveryPort, m_cfg.port, DetectHostname()))
                LOG_INFO("Smith", "LAN discovery responder on udp/%d (advertising http port %d)",
                         m_cfg.discoveryPort, m_cfg.port);
            else
                LOG_WARNING("Smith", "LAN discovery responder could not bind udp/%d (continuing)",
                            m_cfg.discoveryPort);
        }

        LOG_INFO("Smith", "Coordinator listening on http://%s:%d (data: %s)",
                 m_cfg.host.c_str(), m_cfg.port, m_cfg.dataDir.c_str());
        return m_server.Listen(m_cfg.host, m_cfg.port);
    }

    void Coordinator::Stop()
    {
        m_stopTriggers = true;
        m_stopAdd = true;
        m_stopDns = true;
        m_addCv.notify_all();
        m_discovery.Stop();
        StopEmbeddedAgent();
        if (m_addThread.joinable()) m_addThread.join();
        if (m_triggerThread.joinable()) m_triggerThread.join();
        if (m_dnsThread.joinable()) m_dnsThread.join();
        m_server.Stop();
    }
}
