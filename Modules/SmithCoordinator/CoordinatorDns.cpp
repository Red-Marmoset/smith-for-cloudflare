// CoordinatorDns.cpp - optional dynamic-DNS updater.
//
// When the config's `dns` block names a record + apiToken, the coordinator keeps a
// Cloudflare A record pointed at its current public IP. Smith has no TLS, so the
// public-IP lookup and every Cloudflare API call are delegated to curl via
// SmithCore/Process (argv, no shell - nothing can inject); response parsing is the pure
// helpers in SmithCore/CloudflareDns. The API token is a secret and is NEVER logged.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Coordinator.h"
#include "CoordinatorUtil.h"

#include <SmithCore/Process.h>
#include <SmithCore/CloudflareDns.h>
#include <SmithCore/Config.h>
#include <Log/Log.h>

#include <json/single_include/nlohmann/json.hpp>

#include <chrono>
#include <filesystem>
#include <thread>
#include <vector>
#include <exception>

using nlohmann::json;

namespace Smith
{
    // Run `curl -s --max-time 15 <args>` and return its stdout (empty on failure).
    static std::string Curl(const std::vector<std::string>& args)
    {
        ProcessOptions o;
        o.argv = { "curl", "-s", "--max-time", "15" };
        for (const auto& a : args) o.argv.push_back(a);
        std::string body;
        Process p;
        p.Run(o, [&](bool isErr, const std::string& line) { if (!isErr) body += line + "\n"; });
        return body;
    }

    bool Coordinator::DnsConfigured() const
    {
        return m_cfg.dnsProvider == "cloudflare" && !m_cfg.dnsRecord.empty() && !m_cfg.dnsApiToken.empty();
    }

    // One update cycle. Returns true when the record is correct (already-correct or just
    // updated); false on any error (logged, token never printed). Caches the zone/record
    // ids + last IP so the steady state is a single public-IP GET.
    bool Coordinator::RunDnsUpdate()
    {
        // Snapshot config + cached state under the lock; the curl calls run unlocked, and
        // results are written back under the lock - so the Settings GET reader and a
        // config POST can't race with the updater (which only ever runs on the dns thread).
        std::string token, zone, record, zoneId, lastIp; bool proxied;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            token = m_cfg.dnsApiToken; zone = m_cfg.dnsZone; record = m_cfg.dnsRecord;
            proxied = m_cfg.dnsProxied; zoneId = m_dnsZoneId; lastIp = m_dnsLastIp;
        }
        if (token.empty() || record.empty()) return false;

        std::string ip = TrimWhitespace(Curl({ "https://api.ipify.org" }));
        if (!IsIpv4(ip)) { LOG_WARNING("Smith", "DNS: could not determine public IP"); return false; }
        if (ip == lastIp) return true;

        const std::string bearer = "Authorization: Bearer " + token;
        const std::string api = "https://api.cloudflare.com/client/v4";

        if (zoneId.empty())                                 // resolve the zone id once
        {
            std::string zoneName = zone;
            if (zoneName.empty())                           // derive the zone (last two labels of the record)
            {
                size_t dot = record.find_last_of('.');
                if (dot != std::string::npos) { size_t d2 = record.find_last_of('.', dot - 1); zoneName = (d2 == std::string::npos) ? record : record.substr(d2 + 1); }
            }
            std::string z = Curl({ "-H", bearer, api + "/zones?name=" + zoneName });
            if (!ParseCloudflareFirstId(z, zoneId)) { LOG_ERROR("Smith", "DNS: Cloudflare zone lookup failed for %s", zoneName.c_str()); return false; }
            { std::lock_guard<std::mutex> lock(m_mutex); m_dnsZoneId = zoneId; }
        }

        std::string recId, curIp;
        std::string r = Curl({ "-H", bearer, api + "/zones/" + zoneId + "/dns_records?type=A&name=" + record });
        if (!ParseCloudflareRecord(r, recId, curIp)) { LOG_ERROR("Smith", "DNS: Cloudflare record lookup failed for %s (does the A record exist?)", record.c_str()); return false; }

        if (curIp != ip)
        {
            std::string body = CloudflareUpdateBody(record, ip, proxied);
            std::string u = Curl({ "-X", "PUT", "-H", bearer, "-H", "Content-Type: application/json", "-d", body,
                                   api + "/zones/" + zoneId + "/dns_records/" + recId });
            if (!CloudflareSucceeded(u)) { LOG_ERROR("Smith", "DNS: Cloudflare update of %s -> %s failed", record.c_str(), ip.c_str()); return false; }
            LOG_INFO("Smith", "DNS: %s -> %s (was %s)", record.c_str(), ip.c_str(), curIp.empty() ? "unset" : curIp.c_str());
        }
        { std::lock_guard<std::mutex> lock(m_mutex); m_dnsLastIp = ip; }
        return true;
    }

    void Coordinator::DnsLoop()
    {
        int interval = m_cfg.dnsIntervalSec > 0 ? m_cfg.dnsIntervalSec : 300;
        LOG_INFO("Smith", "Dynamic DNS: keeping %s pointed at this box via Cloudflare (every %ds)", m_cfg.dnsRecord.c_str(), interval);
        for (int i = 0; i < 15 && !m_stopDns; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(200));   // let startup settle (~3s) before the first curl
        while (!m_stopDns)
        {
            try { RunDnsUpdate(); }
            catch (const std::exception& e) { LOG_ERROR("Smith", "DNS: update failed: %s", e.what()); }
            catch (...) { LOG_ERROR("Smith", "DNS: update failed (unknown exception)"); }
            for (int i = 0; i < interval * 5 && !m_stopDns; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }
    }

    static std::vector<std::string> StrArr(const json& v)
    {
        std::vector<std::string> out;
        if (v.is_array()) for (const auto& e : v) if (e.is_string()) out.push_back(e.get<std::string>());
        return out;
    }

    // Apply DNS config changes live: join the running updater, then (re)start it against
    // the new config - which also triggers an immediate update. Never holds m_mutex while
    // joining (the updater locks m_mutex).
    void Coordinator::RestartDnsThread()
    {
        m_stopDns = true;
        if (m_dnsThread.joinable()) m_dnsThread.join();
        m_stopDns = false;
        { std::lock_guard<std::mutex> lock(m_mutex); m_dnsZoneId.clear(); m_dnsLastIp.clear(); }
        if (DnsConfigured()) m_dnsThread = std::thread([this]() { DnsLoop(); });
    }

    // GET  /api/config -> the UI-editable config, secrets redacted to set/unset flags.
    // POST /api/config -> apply edits (a blank secret keeps the existing value), persist to
    //                     the config file, and live-apply (DNS restarts; auth/token are read live).
    void Coordinator::HandleConfig(const Http::Request& req, Http::Response& res)
    {
        if (req.method == "POST")
        {
            json j;
            if (!ParseBody(req, j)) { JsonError(res, 400, "expected an object"); return; }
            {
                // Never write settings over a config file that doesn't parse (it would lose
                // every hand-edited key), nor while running on the last-known-good fallback
                // (it would stamp the fallback's values into the file). Fix + restart first.
                std::string path, startupError;
                { std::lock_guard<std::mutex> lock(m_mutex); path = m_cfg.configPath; startupError = m_cfg.configError; }
                std::string fileError = path.empty() ? "" : CheckCoordinatorConfigFile(path);
                if (!fileError.empty())
                { JsonError(res, 409, path + " is invalid (" + fileError + "). Fix the file by hand before saving settings."); return; }
                if (!startupError.empty())
                { JsonError(res, 409, "Smith is running on a fallback config. Restart the coordinator before saving settings."); return; }
            }
            bool dnsChanged = false, discordChanged = false; std::string cfgPath;
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                auto str = [](const json& o, const char* k, std::string& dst) { if (o.contains(k) && o[k].is_string()) dst = o[k].get<std::string>(); };
                auto secret = [](const json& o, const char* k, std::string& dst) { if (o.contains(k) && o[k].is_string() && !o[k].get<std::string>().empty()) dst = o[k].get<std::string>(); };

                secret(j, "token", m_cfg.token);
                secret(j, "githubToken", m_cfg.githubToken);
                str(j, "notifyCommand", m_cfg.notifyCommand);
                str(j, "notifyOn", m_cfg.notifyOn);
                if (j.contains("pollIntervalSec") && j["pollIntervalSec"].is_number_integer()) m_cfg.pollIntervalSec = j["pollIntervalSec"].get<int>();
                if (j.contains("cancelRunningOnNewCommit") && j["cancelRunningOnNewCommit"].is_boolean())
                    m_cfg.cancelRunningOnNewCommit = j["cancelRunningOnNewCommit"].get<bool>();

                if (j.contains("auth") && j["auth"].is_object())
                {
                    const json& a = j["auth"];
                    str(a, "googleClientId", m_cfg.googleClientId);
                    if (a.contains("allowedDomains")) m_cfg.googleAllowedDomains = StrArr(a["allowedDomains"]);
                    if (a.contains("allowedEmails")) m_cfg.googleAllowedEmails = StrArr(a["allowedEmails"]);
                    if (a.contains("adminEmails")) m_cfg.adminEmails = StrArr(a["adminEmails"]);
                    if (a.contains("requireLogin") && a["requireLogin"].is_boolean()) m_cfg.requireLogin = a["requireLogin"].get<bool>();
                }
                if (j.contains("dns") && j["dns"].is_object())
                {
                    const json& d = j["dns"];
                    std::string oRec = m_cfg.dnsRecord, oZone = m_cfg.dnsZone, oTok = m_cfg.dnsApiToken, oProv = m_cfg.dnsProvider;
                    bool oProx = m_cfg.dnsProxied; int oInt = m_cfg.dnsIntervalSec;
                    str(d, "provider", m_cfg.dnsProvider);
                    secret(d, "apiToken", m_cfg.dnsApiToken);
                    str(d, "zone", m_cfg.dnsZone);
                    str(d, "record", m_cfg.dnsRecord);
                    if (d.contains("proxied") && d["proxied"].is_boolean()) m_cfg.dnsProxied = d["proxied"].get<bool>();
                    if (d.contains("intervalSeconds") && d["intervalSeconds"].is_number_integer()) m_cfg.dnsIntervalSec = d["intervalSeconds"].get<int>();
                    dnsChanged = (oRec != m_cfg.dnsRecord || oZone != m_cfg.dnsZone || oTok != m_cfg.dnsApiToken ||
                                  oProv != m_cfg.dnsProvider || oProx != m_cfg.dnsProxied || oInt != m_cfg.dnsIntervalSec);
                }
                if (j.contains("discord") && j["discord"].is_object())
                {
                    const json& d = j["discord"];
                    if (d.contains("enabled") && d["enabled"].is_boolean()) m_cfg.discordEnabled = d["enabled"].get<bool>();
                    secret(d, "token", m_cfg.discordToken);
                    str(d, "appId", m_cfg.discordAppId);
                    str(d, "guildId", m_cfg.discordGuildId);
                    str(d, "notifyChannelId", m_cfg.discordNotifyChannelId);
                    if (d.contains("commandChannels")) m_cfg.discordCommandChannels = StrArr(d["commandChannels"]);
                    if (d.contains("allowRoles")) m_cfg.discordAllowRoles = StrArr(d["allowRoles"]);
                    if (d.contains("allowUsers")) m_cfg.discordAllowUsers = StrArr(d["allowUsers"]);
                    str(d, "pinNode", m_cfg.discordPinNode);
                    str(d, "ollamaUrl", m_cfg.ollamaUrl);
                    str(d, "ollamaModel", m_cfg.ollamaModel);
                    auto bflag = [&](const char* k, bool& dst) { if (d.contains(k) && d[k].is_boolean()) dst = d[k].get<bool>(); };
                    bflag("notifyStart", m_cfg.discordNotifyStart);
                    bflag("notifyRunning", m_cfg.discordNotifyRunning);
                    bflag("notifySuccess", m_cfg.discordNotifySuccess);
                    bflag("notifyFail", m_cfg.discordNotifyFail);
                    bflag("confirmDeploy", m_cfg.discordConfirmDeploy);
                    // Any discord edit (re)starts the placement thread; agents then reconcile to the
                    // new spec hash (relaunch only if their bot's launch env actually changed).
                    discordChanged = true;
                }
                cfgPath = m_cfg.configPath;
                if (!cfgPath.empty() && SaveCoordinatorConfigFile(cfgPath, m_cfg)) StoreLastKnownGoodConfig(cfgPath);
            }
            if (dnsChanged) RestartDnsThread();
            if (discordChanged) RestartDiscordThread();
            res.Json(json{{"saved", true}}.dump());
            return;
        }

        std::lock_guard<std::mutex> lock(m_mutex);
        res.Json(json{
            {"host", m_cfg.host}, {"port", m_cfg.port}, {"configPath", m_cfg.configPath},
            {"tokenSet", !m_cfg.token.empty()}, {"githubTokenSet", !m_cfg.githubToken.empty()}, {"requireTokenAlways", m_cfg.requireTokenAlways},
            {"pollIntervalSec", m_cfg.pollIntervalSec}, {"notifyCommand", m_cfg.notifyCommand}, {"notifyOn", m_cfg.notifyOn},
            {"cancelRunningOnNewCommit", m_cfg.cancelRunningOnNewCommit},
            {"auth", json{{"googleClientId", m_cfg.googleClientId}, {"allowedDomains", m_cfg.googleAllowedDomains},
                          {"allowedEmails", m_cfg.googleAllowedEmails}, {"adminEmails", m_cfg.adminEmails}, {"requireLogin", m_cfg.requireLogin}}},
            {"dns", json{{"provider", m_cfg.dnsProvider}, {"apiTokenSet", !m_cfg.dnsApiToken.empty()}, {"zone", m_cfg.dnsZone},
                         {"record", m_cfg.dnsRecord}, {"proxied", m_cfg.dnsProxied}, {"intervalSeconds", m_cfg.dnsIntervalSec},
                         {"configured", DnsConfigured()}, {"lastIp", m_dnsLastIp}}},
            {"discord", json{{"enabled", m_cfg.discordEnabled}, {"tokenSet", !m_cfg.discordToken.empty()},
                         {"appId", m_cfg.discordAppId}, {"guildId", m_cfg.discordGuildId},
                         {"notifyChannelId", m_cfg.discordNotifyChannelId}, {"commandChannels", m_cfg.discordCommandChannels},
                         {"allowRoles", m_cfg.discordAllowRoles}, {"allowUsers", m_cfg.discordAllowUsers},
                         {"pinNode", m_cfg.discordPinNode}, {"ollamaUrl", m_cfg.ollamaUrl}, {"ollamaModel", m_cfg.ollamaModel},
                         {"notifyStart", m_cfg.discordNotifyStart}, {"notifyRunning", m_cfg.discordNotifyRunning},
                         {"notifySuccess", m_cfg.discordNotifySuccess}, {"notifyFail", m_cfg.discordNotifyFail},
                         {"confirmDeploy", m_cfg.discordConfirmDeploy},
                         {"configured", DiscordConfigured()}, {"hostNode", m_botHostNode}, {"status", m_discordStatus}}}
        }.dump());
    }

    // What the operator must hear about the config file. Startup (m_cfg.configError: the
    // file failed to load, and whether the last-known-good copy stood in) is combined with
    // the file as it is on disk NOW, so an edit that breaks it while Smith runs is flagged
    // before the restart that would trip over it - and a fix is acknowledged.
    void Coordinator::HandleConfigStatus(const Http::Request&, Http::Response& res)
    {
        std::string path, startupError; bool usingLkg = false;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            path = m_cfg.configPath; startupError = m_cfg.configError; usingLkg = m_cfg.configUsingLastKnownGood;
        }

        std::string fileError;
        if (!path.empty())
        {
            std::error_code ec;
            uint64_t size = (uint64_t)std::filesystem::file_size(path, ec);
            if (ec)
            {
                // Absent is fine unless it is exactly what failed at startup.
                if (!startupError.empty()) fileError = startupError;
            }
            else
            {
                int64_t mtime = (int64_t)std::filesystem::last_write_time(path, ec).time_since_epoch().count();
                std::lock_guard<std::mutex> lock(m_cfgCheckMutex);
                if (!m_cfgCheckDone || size != m_cfgCheckSize || mtime != m_cfgCheckMtime)
                {
                    m_cfgCheckError = CheckCoordinatorConfigFile(path);
                    m_cfgCheckSize = size; m_cfgCheckMtime = mtime; m_cfgCheckDone = true;
                }
                fileError = m_cfgCheckError;
            }
        }

        std::string state = "ok", severity = "ok", message;
        const std::string restart = " Fix the file, then restart the coordinator.";
        if (!fileError.empty() && !startupError.empty() && usingLkg)
        {
            state = "invalid-using-last-known-good"; severity = "error";
            message = path + " is invalid: " + fileError + ". Smith is running on the last-known-good copy (" +
                      LastKnownGoodConfigPath(path) + "), so edits made since that copy are not applied." + restart;
        }
        else if (!fileError.empty() && !startupError.empty())
        {
            state = "invalid-using-defaults"; severity = "error";
            message = path + " is invalid: " + fileError + ". There was no last-known-good copy, so Smith is running on "
                      "built-in defaults (no sign-in, no local agent, no Discord bot)." + restart;
        }
        else if (!fileError.empty())
        {
            state = "invalid-on-disk"; severity = "error";
            message = path + " was edited and no longer parses: " + fileError + ". The running config is unaffected, "
                      "but Settings can't save and the next restart will fall back to the last-known-good copy. Fix the file.";
        }
        else if (!startupError.empty())
        {
            state = "restart-needed"; severity = "warn";
            message = path + " is valid again, but Smith is still running on the " +
                      std::string(usingLkg ? "last-known-good copy" : "built-in defaults") +
                      " it fell back to at startup. Restart the coordinator to apply the file.";
        }

        res.Json(json{{"ok", state == "ok"}, {"state", state}, {"severity", severity}, {"message", message},
                      {"path", path}, {"fileError", fileError}, {"startupError", startupError},
                      {"usingLastKnownGood", usingLkg}}.dump());
    }
}
