// CoordinatorDiscord.cpp - place + manage the optional Discord bot.
//
// Discord requires TLS (wss/https), which Smith's C++ core deliberately avoids, so the
// bot is a separate Python process (tools/smith-discord-bot.py, embedded in the agent).
// This file is the *placement brain*: while `discord.enabled` + a token are set, it picks
// the online agent with the most free GPU memory (for a local Ollama LLM) and asks that
// one agent to run the bot via the per-agent /service reconcile channel. Other agents are
// told to stop, so the singleton bot migrates if the best-GPU node changes or goes offline.
// The token is a secret and is NEVER logged.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Coordinator.h"

#include <SmithCore/Config.h>
#include <SmithCore/TimeUtil.h>
#include <SmithProtocol/WireJson.h>
#include <Log/Log.h>

#include <chrono>
#include <thread>
#include <functional>
#include <sstream>

namespace Smith
{
    bool Coordinator::DiscordConfigured() const
    {
        return m_cfg.discordEnabled && !m_cfg.discordToken.empty();
    }

    static std::string Join(const std::vector<std::string>& v)
    {
        std::string s; for (size_t i = 0; i < v.size(); ++i) { if (i) s += ","; s += v[i]; }
        return s;
    }

    static bool HasLabel(const NodeInfo& node, const char* label)
    {
        for (const std::string& candidate : node.labels)
            if (candidate == label) return true;
        return false;
    }

    // Config-derived environment for the bot process (minus per-agent bits like the
    // coordinator URL/token, which the agent injects from what it already knows). The
    // token is included so the bot can authenticate to Discord; it is never logged.
    static std::map<std::string, std::string> BotEnv(const CoordinatorConfig& c)
    {
        return {
            { "SMITH_DISCORD_TOKEN", c.discordToken },
            { "SMITH_DISCORD_APP_ID", c.discordAppId },
            { "SMITH_DISCORD_GUILD_ID", c.discordGuildId },
            { "SMITH_DISCORD_NOTIFY_CHANNEL", c.discordNotifyChannelId },
            { "SMITH_DISCORD_COMMAND_CHANNELS", Join(c.discordCommandChannels) },
            { "SMITH_DISCORD_ALLOW_ROLES", Join(c.discordAllowRoles) },
            { "SMITH_DISCORD_ALLOW_USERS", Join(c.discordAllowUsers) },
            { "SMITH_OLLAMA_URL", c.ollamaUrl },
            { "SMITH_OLLAMA_MODEL", c.ollamaModel },
            // Where humans browse builds: the TLS proxy hostname when dynamic DNS is
            // configured (the bot links builds in chat); else the bot falls back to
            // the LAN coordinator URL it already knows.
            { "SMITH_PUBLIC_URL", c.dnsRecord.empty() ? "" : ("https://" + c.dnsRecord) },
            { "SMITH_NOTIFY_START", c.discordNotifyStart ? "1" : "0" },
            { "SMITH_NOTIFY_RUNNING", c.discordNotifyRunning ? "1" : "0" },
            { "SMITH_NOTIFY_SUCCESS", c.discordNotifySuccess ? "1" : "0" },
            { "SMITH_NOTIFY_FAIL", c.discordNotifyFail ? "1" : "0" },
            { "SMITH_CONFIRM_DEPLOY", c.discordConfirmDeploy ? "1" : "0" },
        };
    }

    // Stable hash of the bot env so the agent relaunches only when something actually
    // changed. (Hex of a folded std::hash over the sorted key=value pairs.)
    std::string Coordinator::BotSpecHash() const
    {
        std::map<std::string, std::string> env = BotEnv(m_cfg);
        std::string joined;
        for (const auto& kv : env) { joined += kv.first; joined += '='; joined += kv.second; joined += '\n'; }
        size_t h = std::hash<std::string>{}(joined);
        std::ostringstream os; os << std::hex << h;
        return os.str();
    }

    // nodeId of the agent that should host the bot, or "" if none is suitable.
    // discord.pinNode (by hostname) overrides everything. Otherwise: prefer nodes
    // whose agent reports a LOCAL Ollama (the bot's LLM runs on its host), pick the
    // largest TOTAL VRAM among them (capacity is stable; free VRAM gyrates with
    // every build and made placement flappy), skip nodes that recently failed to
    // host, and only migrate away from a healthy host for a clear capacity win -
    // every move costs a cold model load and a Discord reconnect. Caller holds m_mutex.
    std::string Coordinator::PickBotHostNode()
    {
        // Both knobs are config: discord.hostFailureCooldownSec / discord.migrateMarginMb.
        const int64_t kFailureCooldownMs = (int64_t)m_cfg.discordHostFailureCooldownSec * 1000;
        const int kMigrateMarginMb = m_cfg.discordMigrateMarginMb;

        int64_t now = NowMillis();
        if (!m_cfg.discordPinNode.empty())
        {
            for (const auto& kv : m_nodes)
                if (NodeOnlineLocked(kv.second, now) && kv.second.info.hostname == m_cfg.discordPinNode)
                    return kv.first;
            return "";                                                   // pinned node not online
        }

        std::string best; int bestVram = -1; bool bestOllama = false;
        bool curViable = false, curOllama = false; int curVram = -1;
        for (const auto& kv : m_nodes)
        {
            const NodeRuntime& n = kv.second;
            if (!NodeOnlineLocked(n, now)) continue;                     // offline
            // A bare interpreter is not enough: the agent must be able to create
            // a private venv before it can install discord.py + requests.
            if (!HasLabel(n.info, "discord-host")) continue;
            auto fail = m_botFailures.find(n.info.hostname);             // benched by hostname (survives reconnects)
            if (fail != m_botFailures.end() && now - fail->second < kFailureCooldownMs) continue;
            if (kv.first == m_botHostNode) { curViable = true; curOllama = n.info.ollamaUp; curVram = n.info.gpuTotalMb; }
            // An Ollama-equipped node always outranks one without, regardless of VRAM.
            bool better = (n.info.ollamaUp != bestOllama) ? n.info.ollamaUp
                                                          : n.info.gpuTotalMb > bestVram;
            if (best.empty() || better) { best = kv.first; bestVram = n.info.gpuTotalMb; bestOllama = n.info.ollamaUp; }
        }

        // Hysteresis: keep a viable current host unless the best candidate is a
        // class upgrade (gains Ollama) or a clearly bigger card.
        if (curViable && best != m_botHostNode && bestOllama == curOllama && bestVram < curVram + kMigrateMarginMb)
            return m_botHostNode;
        return best;
    }

    // The spec an agent gets from GET /api/agents/:nodeId/service. Caller holds m_mutex.
    ServiceSpec Coordinator::BuildBotService(const std::string& forNodeId)
    {
        ServiceSpec s;
        s.name = "discord-bot";
        if (DiscordConfigured() && forNodeId == m_botHostNode && !m_botHostNode.empty())
        {
            s.action = "run";
            s.specHash = BotSpecHash();
            s.env = BotEnv(m_cfg);
        }
        else
        {
            s.action = "stop";   // not the host (or bot disabled) -> ensure it isn't running here
        }
        return s;
    }

    void Coordinator::HandleAgentService(const Http::Request& req, Http::Response& res)
    {
        std::string nodeId = req.Param("nodeId");
        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_nodes.find(nodeId);
        if (it == m_nodes.end()) { res.Set(404, "unknown node"); return; }
        res.Json(ToJson(BuildBotService(nodeId)));
    }

    void Coordinator::DiscordLoop()
    {
        for (int i = 0; i < 15 && !m_stopDiscord; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(200));
        while (!m_stopDiscord)
        {
            try
            {
                std::string desired, prev;
                {
                    std::lock_guard<std::mutex> lock(m_mutex);
                    prev = m_botHostNode;
                    // If the current host vanished (e.g. its agent crashed) it never sends a
                    // "failed" heartbeat, so bench it here by its (stable) hostname. Otherwise a
                    // crash-looping host keeps winning placement the instant it reconnects with a
                    // fresh nodeId, and the bot never fails over to an equally-capable peer.
                    if (!prev.empty() && !m_botHostName.empty())
                    {
                        auto pit = m_nodes.find(prev);
                        if (pit == m_nodes.end() || !NodeOnlineLocked(pit->second, NowMillis()))
                            m_botFailures[m_botHostName] = NowMillis();
                    }
                    bool anyOnline = false;
                    for (const auto& node : m_nodes)
                        if (NodeOnlineLocked(node.second, NowMillis())) { anyOnline = true; break; }
                    desired = DiscordConfigured() ? PickBotHostNode() : std::string();
                    m_botHostNode = desired;
                    { auto dit = m_nodes.find(desired);
                      m_botHostName = (dit != m_nodes.end()) ? dit->second.info.hostname : std::string(); }
                    // Status is for humans: the agent's hostname (not its uuid) plus the
                    // LIVENESS the agent reports in heartbeats - placement alone can look
                    // "running" while the bot is dead on the host.
                    std::string hostName = desired, health, why;
                    auto hit = m_nodes.find(desired);
                    if (hit != m_nodes.end())
                    {
                        if (!hit->second.info.hostname.empty()) hostName = hit->second.info.hostname;
                        health = hit->second.serviceStatus;
                        why = hit->second.serviceDetail;
                    }
                    if (!DiscordConfigured())     m_discordStatus = "off";
                    else if (desired.empty())     m_discordStatus = anyOnline ? "no agent with Python venv support" : "no online agent";
                    else if (health == "running") m_discordStatus = "running on " + hostName;
                    else if (health.empty())      m_discordStatus = "starting on " + hostName;
                    else                          m_discordStatus = health + " on " + hostName + (why.empty() ? "" : (": " + why));
                }
                if (desired != prev)
                {
                    if (!desired.empty())
                    {
                        std::lock_guard<std::mutex> lock(m_mutex);
                        auto it = m_nodes.find(desired);
                        LOG_INFO("Smith", "Discord bot -> agent %s%s",
                                 it != m_nodes.end() ? it->second.info.hostname.c_str() : desired.c_str(),
                                 it != m_nodes.end() && it->second.info.gpuTotalMb > 0
                                     ? (" (" + std::to_string(it->second.info.gpuTotalMb) + " MiB VRAM)").c_str() : "");
                    }
                    else if (DiscordConfigured())
                        LOG_WARNING("Smith", "Discord bot: no online agent to host it");
                }
            }
            catch (const std::exception& e) { LOG_ERROR("Smith", "Discord: placement failed: %s", e.what()); }
            catch (...) { LOG_ERROR("Smith", "Discord: placement failed (unknown)"); }
            for (int i = 0; i < 25 && !m_stopDiscord; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(200)); // ~5s
        }
    }

    void Coordinator::RestartDiscordThread()
    {
        m_stopDiscord = true;
        if (m_discordThread.joinable()) m_discordThread.join();
        m_stopDiscord = false;
        { std::lock_guard<std::mutex> lock(m_mutex); m_botHostNode.clear(); m_botHostName.clear(); }
        if (DiscordConfigured()) m_discordThread = std::thread([this]() { DiscordLoop(); });
    }
}
