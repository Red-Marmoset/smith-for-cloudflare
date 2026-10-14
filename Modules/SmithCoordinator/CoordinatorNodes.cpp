// CoordinatorNodes.cpp - agent registry: register, heartbeat (incl. Steam Guard
// task delivery), node listing, and the Steam Guard relay endpoints.
// Split from Coordinator.cpp (800-line standard); pure moves, no behavior change.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Coordinator.h"
#include "CoordinatorUtil.h"

#include <SmithCore/TimeUtil.h>
#include <SmithCore/Uuid.h>
#include <SmithProtocol/WireJson.h>
#include <Log/Log.h>

#include <json/single_include/nlohmann/json.hpp>

#include <algorithm>
#include <set>
#include <iterator>

using nlohmann::json;

namespace Smith
{
    void Coordinator::HandleRegister(const Http::Request& req, Http::Response& res)
    {
        RegisterRequest rr;
        if (!FromJson(req.body, rr)) { res.Set(400, "bad request"); return; }

        RegisterResponse resp;
        resp.protocolVersion = kProtocolVersion;
        resp.heartbeatIntervalSec = 10;
        if (rr.protocolVersion != kProtocolVersion)
        {
            resp.accepted = false;
            resp.message = "protocol mismatch (coordinator " + std::to_string(kProtocolVersion) + ")";
            res.Json(ToJson(resp), 409);
            return;
        }

        NodeInfo info;
        info.nodeId = MakeUuid();
        info.hostname = rr.hostname;
        info.os = rr.os;
        info.arch = rr.arch;
        info.labels = rr.labels;
        info.agentVersion = rr.agentVersion;
        info.ollamaUp = rr.ollamaUp;
        info.gpuTotalMb = rr.gpuTotalMb;
        info.gpuFreeMb = rr.gpuFreeMb;

        {
            std::lock_guard<std::mutex> lock(m_mutex);
            // Drop any prior registration from the same agent (same hostname+os) so a
            // restarted agent replaces its old entry instead of leaving a dead node.
            for (auto it = m_nodes.begin(); it != m_nodes.end(); )
            {
                if (it->first != info.nodeId && it->second.info.hostname == info.hostname &&
                    it->second.info.os == info.os)
                {
                    // The agent only registers from its poll loop, which is blocked while a
                    // job runs - so the old process's in-flight build died with it.
                    MarkNodeBuildsLostLocked(it->first, "agent restarted");
                    it = m_nodes.erase(it);
                }
                else
                    ++it;
            }
            NodeRuntime rt;
            rt.info = info;
            rt.lastSeenMs = NowMillis();
            rt.status = "idle";
            m_nodes[info.nodeId] = rt;
        }
        LOG_INFO("Smith", "Agent registered: %s (%s, %s)", info.hostname.c_str(), info.os.c_str(), info.nodeId.c_str());

        resp.accepted = true;
        resp.nodeId = info.nodeId;
        res.Json(ToJson(resp));
    }

    void Coordinator::MarkNodeBuildsLostLocked(const std::string& nodeId, const std::string& why)
    {
        std::vector<std::string> lost;
        for (auto& kv : m_builds)
        {
            BuildRecord& rec = kv.second;
            if (rec.nodeId != nodeId || rec.status == "queued" || IsTerminal(rec.status)) continue;
            rec.status = "lost";
            rec.phase = "done";
            rec.finishedAt = NowMillis();
            if (rec.startedAt > 0) rec.durationMs = rec.finishedAt - rec.startedAt;
            m_store.AppendLog(rec, "SMITH: build lost - " + why + " on " + rec.nodeName + " while it was running\n");
            m_store.SaveRecord(rec);
            m_cancelRequested.erase(rec.jobId);
            m_supersededRunning.erase(rec.jobId);
            LOG_WARNING("Smith", "Build %s #%d lost: %s (%s)", rec.jobId.c_str(), rec.buildNumber,
                        why.c_str(), rec.nodeName.c_str());
            EmitBuildEvent("lost", rec);
            lost.push_back(rec.jobId);
        }
        // Settle batches after every record is updated, so a batch holding two of these
        // jobs sees both as terminal.
        for (const auto& jobId : lost) OnJobTerminalLocked(jobId);
    }

    void Coordinator::HandleHeartbeat(const Http::Request& req, Http::Response& res)
    {
        std::string nodeId = req.Param("nodeId");
        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_nodes.find(nodeId);
        if (it == m_nodes.end()) { res.Set(404, "unknown node"); return; }
        it->second.lastSeenMs = NowMillis();
        Heartbeat hb;
        if (FromJson(req.body, hb))
        {
            if (hb.gpuFreeMb > 0) it->second.info.gpuFreeMb = hb.gpuFreeMb;
            it->second.serviceStatus = hb.serviceStatus;
            it->second.serviceDetail = hb.serviceDetail;
            it->second.info.ollamaUp = hb.ollamaUp;
            // A host that cannot provision the bot is benched for a while, so
            // placement falls back to the next-best node instead of flapping.
            // Keyed by hostname (not nodeId) so the bench survives the agent
            // reconnecting with a fresh nodeId.
            if (nodeId == m_botHostNode && hb.serviceStatus == "failed")
            {
                const std::string& host = it->second.info.hostname;
                int64_t now = NowMillis();
                // Say WHY, once per bench episode. The agent knows the reason
                // (e.g. "no usable Python 3 with discord.py + requests") and sends
                // it as serviceDetail, but this used to drop it on the floor: the
                // best node won placement, silently failed, got benched, and the
                // bot reverted to the runner-up every cooldown - forever, with
                // nothing in the log to explain why the better box never sticks.
                auto prev = m_botFailures.find(host);
                bool newEpisode = prev == m_botFailures.end() ||
                                  now - prev->second >= (int64_t)m_cfg.discordHostFailureCooldownSec * 1000;
                if (newEpisode)
                    LOG_WARNING("Smith", "Discord bot: benching %s for %ds - %s", host.c_str(),
                                m_cfg.discordHostFailureCooldownSec,
                                hb.serviceDetail.empty() ? "agent reported failure (no detail)"
                                                         : hb.serviceDetail.c_str());
                m_botFailures[host] = now;
            }
        }
        // Deliver at most one pending Steam Guard task in the response. Old agents
        // ignore the body entirely.
        HeartbeatResponse hr;
        for (auto& kv : m_steamGuard)
        {
            if (kv.second.nodeId != nodeId || kv.second.status != "pending") continue;
            kv.second.status = "sent";
            hr.steamGuard.requestId = kv.second.id;
            hr.steamGuard.credentialRef = kv.second.credentialRef;
            hr.steamGuard.code = kv.second.code;
            break;
        }
        res.Json(ToJson(hr));
    }

    // ------------------------------------------------------- steam guard relay
    void Coordinator::HandleSteamGuard(const Http::Request& req, Http::Response& res)
    {
        json body;
        try { body = json::parse(req.body); } catch (...) { res.Set(400, "bad request"); return; }
        std::string code = body.value("code", std::string());
        std::string ref = body.value("credentialRef", std::string());
        if (code.empty()) { JsonError(res, 400, "a Steam Guard code is required"); return; }

        std::lock_guard<std::mutex> lock(m_mutex);

        // Default the credential ref when the loaded projects use exactly one steam
        // credential (the single-game case) - chat shouldn't need to know ref names.
        if (ref.empty())
        {
            std::set<std::string> refs;
            for (const auto& pkv : m_projects)
                for (const auto& prod : pkv.second.products)
                    for (const auto& rule : prod.rules)
                        for (const auto& h : rule.handoff)
                        {
                            if (h.type != "steam") continue;
                            auto f = h.fields.find("credentialRef");
                            if (f != h.fields.end() && !f->second.empty()) refs.insert(f->second);
                        }
            if (refs.size() == 1) ref = *refs.begin();
            else
            {
                res.Json(json{{"error", refs.empty() ? "no steam handoff with a credentialRef is configured"
                                                     : "multiple steam credentials configured - specify credentialRef"}}.dump(), 400);
                return;
            }
        }

        // The code goes to an online agent that can actually run steamcmd.
        int64_t now = NowMillis();
        std::string nodeId, nodeName;
        for (const auto& kv : m_nodes)
        {
            const NodeRuntime& n = kv.second;
            if (!NodeOnlineLocked(n, now)) continue;
            if (std::find(n.info.labels.begin(), n.info.labels.end(), "steamcmd") == n.info.labels.end()) continue;
            nodeId = kv.first;
            nodeName = n.info.hostname;
            break;
        }
        if (nodeId.empty()) { JsonError(res, 503, "no online agent with the 'steamcmd' label"); return; }

        // Drop stale requests so the map can't grow unbounded.
        for (auto it2 = m_steamGuard.begin(); it2 != m_steamGuard.end(); )
            it2 = (now - it2->second.createdMs > 3600000) ? m_steamGuard.erase(it2) : std::next(it2);

        SteamGuardRequest r;
        r.id = MakeShortId();
        r.credentialRef = ref;
        r.code = code;
        r.nodeId = nodeId;
        r.nodeName = nodeName;
        r.createdMs = now;
        m_steamGuard[r.id] = r;
        LOG_INFO("Smith", "Steam Guard code queued for %s (credential '%s', request %s)",
                 nodeName.c_str(), ref.c_str(), r.id.c_str());   // never the code itself
        res.Json(json{{"requestId", r.id}, {"node", nodeName}, {"credentialRef", ref}}.dump());
    }

    void Coordinator::HandleSteamGuardStatus(const Http::Request& req, Http::Response& res)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_steamGuard.find(req.Param("id"));
        if (it == m_steamGuard.end()) { res.Set(404, "unknown request"); return; }
        SteamGuardRequest& r = it->second;
        if ((r.status == "pending" || r.status == "sent") && NowMillis() - r.createdMs > 240000)
        {
            r.status = "failed";
            r.detail = "timed out waiting for the agent";
        }
        res.Json(json{{"status", r.status}, {"detail", r.detail}, {"node", r.nodeName}}.dump());
    }

    void Coordinator::HandleSteamGuardResult(const Http::Request& req, Http::Response& res)
    {
        json body;
        try { body = json::parse(req.body); } catch (...) { res.Set(400, "bad request"); return; }
        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_steamGuard.find(req.Param("id"));
        if (it == m_steamGuard.end()) { res.Set(404, "unknown request"); return; }
        it->second.status = body.value("ok", false) ? "done" : "failed";
        it->second.detail = body.value("detail", std::string());
        it->second.code.clear();   // the short-lived code is spent either way
        LOG_INFO("Smith", "Steam Guard request %s: %s", it->first.c_str(), it->second.status.c_str());
        res.Set(204, "");
    }

    void Coordinator::HandleNodes(const Http::Request&, Http::Response& res)
    {
        int64_t now = NowMillis();
        json arr = json::array();
        std::lock_guard<std::mutex> lock(m_mutex);
        for (const auto& kv : m_nodes)
        {
            const NodeRuntime& n = kv.second;
            bool online = NodeOnlineLocked(n, now);
            json o = {
                {"nodeId", n.info.nodeId}, {"hostname", n.info.hostname}, {"os", n.info.os},
                {"arch", n.info.arch}, {"labels", n.info.labels}, {"ollama", n.info.ollamaUp},
                {"status", online ? n.status : "offline"}, {"currentJobId", n.currentJobId},
                {"lastSeenMs", n.lastSeenMs}, {"online", online},
                {"gpuTotalMb", n.info.gpuTotalMb}, {"gpuFreeMb", n.info.gpuFreeMb},
                {"agentVersion", n.info.agentVersion}};
            // What this node is currently building (for the Agents page). We already
            // hold m_mutex, so read m_builds inline - GetBuildCopy would re-lock.
            if (!n.currentJobId.empty())
            {
                auto bit = m_builds.find(n.currentJobId);
                if (bit != m_builds.end())
                {
                    o["currentProduct"] = bit->second.product;
                    o["currentVariant"] = bit->second.variant;
                    o["currentBuildNumber"] = bit->second.buildNumber;
                    o["currentProjectId"] = bit->second.projectId;
                }
            }
            arr.push_back(std::move(o));
        }
        res.Json(arr.dump());
    }

}
