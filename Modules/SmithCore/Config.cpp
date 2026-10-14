// Config.cpp - argv parsing and platform detection for coordinator/agent config.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Config.h"

#include <sstream>
#include <fstream>
#include <algorithm>
#include <cstdlib>
#include <cstdio>
#include <filesystem>

#include <json/single_include/nlohmann/json.hpp>

#if defined(_WIN32)
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
#else
#  include <unistd.h>
#endif

namespace Smith
{
    static std::string OptValue(int argc, char** argv, int start, const std::string& flag, const std::string& def)
    {
        for (int i = start; i + 1 < argc; ++i)
            if (flag == argv[i]) return argv[i + 1];
        return def;
    }

    static int OptInt(int argc, char** argv, int start, const std::string& flag, int def)
    {
        std::string v = OptValue(argc, argv, start, flag, "");
        if (v.empty()) return def;
        try { return std::stoi(v); } catch (...) { return def; }
    }

    static bool HasFlag(int argc, char** argv, int start, const std::string& flag)
    {
        for (int i = start; i < argc; ++i) if (flag == argv[i]) return true;
        return false;
    }

    static std::vector<std::string> SplitCsv(const std::string& s)
    {
        std::vector<std::string> out;
        std::stringstream ss(s);
        std::string item;
        while (std::getline(ss, item, ','))
        {
            // trim spaces
            size_t a = item.find_first_not_of(" \t");
            size_t b = item.find_last_not_of(" \t");
            if (a != std::string::npos) out.push_back(item.substr(a, b - a + 1));
        }
        return out;
    }

    static std::map<std::string, std::string> ParseEnvFlags(int argc, char** argv, int start, const std::string& flag)
    {
        std::map<std::string, std::string> env;
        for (int i = start; i + 1 < argc; ++i)
        {
            if (flag == argv[i])
            {
                std::string kv = argv[i + 1];
                size_t eq = kv.find('=');
                if (eq != std::string::npos) env[kv.substr(0, eq)] = kv.substr(eq + 1);
            }
        }
        return env;
    }

    // Smith should know where the Una engine is, so builds that need it (e.g.
    // building Smith itself) find it. Capture UNA_ENGINE_PATH from this process's
    // environment unless the caller passed it explicitly via --env.
    static void CaptureEnginePath(std::map<std::string, std::string>& env)
    {
        if (env.find("UNA_ENGINE_PATH") == env.end())
        {
            const char* e = std::getenv("UNA_ENGINE_PATH");
            if (e && *e) env["UNA_ENGINE_PATH"] = e;
        }
    }

    std::string DetectOs()
    {
#if defined(_WIN32)
        return "windows";
#elif defined(__APPLE__)
        return "mac";
#else
        return "linux";
#endif
    }

    std::string DetectArch()
    {
#if defined(__aarch64__) || defined(_M_ARM64)
        return "arm64";
#elif defined(__arm__) || defined(_M_ARM)
        return "arm";
#elif defined(__x86_64__) || defined(_M_X64) || defined(_M_AMD64)
        return "x64";
#elif defined(__i386__) || defined(_M_IX86)
        return "x86";
#else
        return "unknown";
#endif
    }

    std::string DetectHostname()
    {
#if defined(_WIN32)
        char buf[256];
        DWORD n = (DWORD)sizeof(buf);
        if (GetComputerNameA(buf, &n)) return std::string(buf, n);
        return "unknown-host";
#else
        char buf[256];
        if (gethostname(buf, sizeof(buf)) == 0)
        {
            std::string host(buf);
            // macOS (and avahi-based Linux) report an mDNS "name.local"; drop the
            // suffix so node/discovery names are just "name".
            const std::string suffix = ".local";
            if (host.size() > suffix.size() &&
                host.compare(host.size() - suffix.size(), suffix.size(), suffix) == 0)
                host.erase(host.size() - suffix.size());
            return host;
        }
        return "unknown-host";
#endif
    }

    std::string DefaultDataDir()
    {
        // No engine home-dir helper exists, so resolve from the environment directly
        // (mirrors DetectHostname's hand-rolled platform split).
#if defined(_WIN32)
        if (const char* pd = std::getenv("ProgramData")) return std::string(pd) + "\\Smith";
        return "C:\\ProgramData\\Smith";
#else
        if (const char* home = std::getenv("HOME")) return std::string(home) + "/.smith";
        return "smith-data";
#endif
    }

    static bool ReadWholeFile(const std::string& path, std::string& out)
    {
        std::ifstream in(path, std::ios::binary);
        if (!in) return false;
        std::stringstream ss; ss << in.rdbuf();
        out = ss.str();
        return true;
    }

    // nlohmann's parse_error text is "[json.exception.parse_error.101] parse error at line
    // L, column C: syntax error while parsing X - <detail>; last read: '<token>'; expected Y".
    // Keep the position and the grammar, drop the id prefix and the "last read" token -
    // that token is file content and can be a slice of a secret.
    static std::string ReadableParseError(const std::string& what)
    {
        std::string s = what;
        if (!s.empty() && s[0] == '[')
        {
            size_t close = s.find("] ");
            if (close != std::string::npos) s.erase(0, close + 2);
        }
        size_t lastRead = s.find("; last read: '");
        if (lastRead != std::string::npos)
        {
            size_t expected = s.find("; expected ", lastRead);
            s.erase(lastRead, expected == std::string::npos ? std::string::npos : expected - lastRead);
        }
        return s;
    }

    static bool ParseConfigText(const std::string& text, nlohmann::json& out, std::string& error)
    {
        try { out = nlohmann::json::parse(text); }
        catch (const nlohmann::json::parse_error& e) { error = ReadableParseError(e.what()); return false; }
        if (!out.is_object()) { error = "the top level is not a JSON object"; return false; }
        return true;
    }

    std::string CheckCoordinatorConfigFile(const std::string& path)
    {
        std::string text, error;
        if (!ReadWholeFile(path, text)) return "";
        nlohmann::json j;
        return ParseConfigText(text, j, error) ? "" : error;
    }

    std::string LastKnownGoodConfigPath(const std::string& configPath)
    {
        const std::string ext = ".json";
        if (configPath.size() > ext.size() && configPath.compare(configPath.size() - ext.size(), ext.size(), ext) == 0)
            return configPath.substr(0, configPath.size() - ext.size()) + ".lkg.json";
        return configPath + ".lkg";
    }

    void StoreLastKnownGoodConfig(const std::string& configPath)
    {
        std::string text, error, existing;
        nlohmann::json j;
        if (!ReadWholeFile(configPath, text) || !ParseConfigText(text, j, error)) return;
        const std::string lkg = LastKnownGoodConfigPath(configPath);
        if (ReadWholeFile(lkg, existing) && existing == text) return;
        // Write beside it then rename, so a crash mid-write can't leave a torn LKG file.
        const std::string tmp = lkg + ".tmp";
        {
            std::ofstream o(tmp, std::ios::binary | std::ios::trunc);
            if (!o) return;
            o << text;
            if (!o) return;
        }
        std::error_code ec;
        std::filesystem::rename(tmp, lkg, ec);
        if (ec) std::filesystem::remove(tmp, ec);
    }

    void LoadCoordinatorConfigFile(const std::string& path, CoordinatorConfig& c)
    {
        LoadCoordinatorConfigFile(path, c, nullptr);
    }

    bool LoadCoordinatorConfigFile(const std::string& path, CoordinatorConfig& c, std::string* error)
    {
        std::string text, parseError;
        if (!ReadWholeFile(path, text)) { if (error) *error = "the file could not be opened"; return false; }
        nlohmann::json j;
        if (!ParseConfigText(text, j, parseError)) { if (error) *error = parseError; return false; }

        auto strArr = [](const nlohmann::json& a) {
            std::vector<std::string> v;
            if (a.is_array()) for (const auto& e : a) if (e.is_string()) v.push_back(e.get<std::string>());
            return v;
        };
        auto str  = [](const nlohmann::json& o, const char* k, std::string& dst) { if (o.contains(k) && o[k].is_string()) dst = o[k].get<std::string>(); };
        auto inum = [](const nlohmann::json& o, const char* k, int& dst)         { if (o.contains(k) && o[k].is_number_integer()) dst = o[k].get<int>(); };
        auto flag = [](const nlohmann::json& o, const char* k, bool& dst)        { if (o.contains(k) && o[k].is_boolean()) dst = o[k].get<bool>(); };

        str(j, "host", c.host);
        inum(j, "port", c.port);
        if (j.contains("dataDir") && j["dataDir"].is_string() && !j["dataDir"].get<std::string>().empty()) c.dataDir = j["dataDir"].get<std::string>();
        str(j, "webDir", c.webDir);
        str(j, "token", c.token);
        flag(j, "requireTokenAlways", c.requireTokenAlways);
        inum(j, "jobWaitMs", c.jobWaitMs);
        inum(j, "pollIntervalSec", c.pollIntervalSec);
        inum(j, "nodeOfflineAfterSec", c.nodeOfflineAfterSec);
        flag(j, "discovery", c.discoveryEnabled);
        inum(j, "discoveryPort", c.discoveryPort);
        flag(j, "withAgent", c.withAgent);
        if (j.contains("agentLabels")) c.agentLabels = strArr(j["agentLabels"]);
        if (j.contains("projects")) for (auto& p : strArr(j["projects"])) c.projectConfigPaths.push_back(p);
        if (j.contains("projectRepos")) for (auto& p : strArr(j["projectRepos"])) c.projectRepos.push_back(p);
        str(j, "notifyCommand", c.notifyCommand);
        str(j, "notifyOn", c.notifyOn);
        str(j, "githubToken", c.githubToken);
        flag(j, "cancelRunningOnNewCommit", c.cancelRunningOnNewCommit);
        if (j.contains("env") && j["env"].is_object())
            for (auto it = j["env"].begin(); it != j["env"].end(); ++it)
                if (it->is_string()) c.agentBuildEnv[it.key()] = it->get<std::string>();

        // Auth (Google sign-in) sub-object.
        if (j.contains("auth") && j["auth"].is_object())
        {
            const auto& a = j["auth"];
            str(a, "googleClientId", c.googleClientId);
            if (a.contains("allowedDomains")) c.googleAllowedDomains = strArr(a["allowedDomains"]);
            if (a.contains("allowedEmails")) c.googleAllowedEmails = strArr(a["allowedEmails"]);
            if (a.contains("adminEmails")) c.adminEmails = strArr(a["adminEmails"]);
            flag(a, "requireLogin", c.requireLogin);
            str(a, "tokenVerifyCommand", c.tokenVerifyCommand);
        }

        // Dynamic DNS (Cloudflare) sub-object. OFF unless record + apiToken are set.
        if (j.contains("dns") && j["dns"].is_object())
        {
            const auto& d = j["dns"];
            str(d, "provider", c.dnsProvider);
            str(d, "apiToken", c.dnsApiToken);
            str(d, "zone", c.dnsZone);
            str(d, "record", c.dnsRecord);
            flag(d, "proxied", c.dnsProxied);
            inum(d, "intervalSeconds", c.dnsIntervalSec);
        }

        // Discord bot sub-object. OFF unless enabled + token are set.
        if (j.contains("discord") && j["discord"].is_object())
        {
            const auto& d = j["discord"];
            flag(d, "enabled", c.discordEnabled);
            str(d, "token", c.discordToken);
            str(d, "appId", c.discordAppId);
            str(d, "guildId", c.discordGuildId);
            str(d, "notifyChannelId", c.discordNotifyChannelId);
            if (d.contains("commandChannels")) c.discordCommandChannels = strArr(d["commandChannels"]);
            if (d.contains("allowRoles")) c.discordAllowRoles = strArr(d["allowRoles"]);
            if (d.contains("allowUsers")) c.discordAllowUsers = strArr(d["allowUsers"]);
            str(d, "pinNode", c.discordPinNode);
            str(d, "ollamaUrl", c.ollamaUrl);
            str(d, "ollamaModel", c.ollamaModel);
            flag(d, "notifyStart", c.discordNotifyStart);
            flag(d, "notifyRunning", c.discordNotifyRunning);
            flag(d, "notifySuccess", c.discordNotifySuccess);
            flag(d, "notifyFail", c.discordNotifyFail);
            flag(d, "confirmDeploy", c.discordConfirmDeploy);
            inum(d, "migrateMarginMb", c.discordMigrateMarginMb);
            inum(d, "hostFailureCooldownSec", c.discordHostFailureCooldownSec);
        }

        // Batch defaults sub-object (smith.json chains / batch requests override per use).
        if (j.contains("batch") && j["batch"].is_object())
        {
            const auto& b = j["batch"];
            str(b, "onFailure", c.batchOnFailure);
            flag(b, "pinCommit", c.batchPinCommit);
            inum(b, "keep", c.batchKeep);
        }
        return true;
    }

    bool SaveCoordinatorConfigFile(const std::string& path, const CoordinatorConfig& c)
    {
        using nlohmann::json;
        // Preserve existing keys/comments; update only the UI-editable sections.
        json j = json::object();
        {
            std::string text, error;
            if (ReadWholeFile(path, text) && !ParseConfigText(text, j, error)) return false;
        }

        j["host"] = c.host;
        j["port"] = c.port;
        j["token"] = c.token;
        j["requireTokenAlways"] = c.requireTokenAlways;
        j["pollIntervalSec"] = c.pollIntervalSec;
        j["nodeOfflineAfterSec"] = c.nodeOfflineAfterSec;
        j["notifyCommand"] = c.notifyCommand;
        j["notifyOn"] = c.notifyOn;
        j["githubToken"] = c.githubToken;
        j["cancelRunningOnNewCommit"] = c.cancelRunningOnNewCommit;

        json a = (j.contains("auth") && j["auth"].is_object()) ? j["auth"] : json::object();
        a["googleClientId"] = c.googleClientId;
        a["allowedDomains"] = c.googleAllowedDomains;
        a["allowedEmails"] = c.googleAllowedEmails;
        a["adminEmails"] = c.adminEmails;
        a["requireLogin"] = c.requireLogin;
        a["tokenVerifyCommand"] = c.tokenVerifyCommand;
        j["auth"] = a;

        json d = (j.contains("dns") && j["dns"].is_object()) ? j["dns"] : json::object();
        d["provider"] = c.dnsProvider;
        d["apiToken"] = c.dnsApiToken;
        d["zone"] = c.dnsZone;
        d["record"] = c.dnsRecord;
        d["proxied"] = c.dnsProxied;
        d["intervalSeconds"] = c.dnsIntervalSec;
        j["dns"] = d;

        json dc = (j.contains("discord") && j["discord"].is_object()) ? j["discord"] : json::object();
        dc["enabled"] = c.discordEnabled;
        dc["token"] = c.discordToken;
        dc["appId"] = c.discordAppId;
        dc["guildId"] = c.discordGuildId;
        dc["notifyChannelId"] = c.discordNotifyChannelId;
        dc["commandChannels"] = c.discordCommandChannels;
        dc["allowRoles"] = c.discordAllowRoles;
        dc["allowUsers"] = c.discordAllowUsers;
        dc["pinNode"] = c.discordPinNode;
        dc["ollamaUrl"] = c.ollamaUrl;
        dc["ollamaModel"] = c.ollamaModel;
        dc["notifyStart"] = c.discordNotifyStart;
        dc["notifyRunning"] = c.discordNotifyRunning;
        dc["notifySuccess"] = c.discordNotifySuccess;
        dc["notifyFail"] = c.discordNotifyFail;
        dc["confirmDeploy"] = c.discordConfirmDeploy;
        dc["migrateMarginMb"] = c.discordMigrateMarginMb;
        dc["hostFailureCooldownSec"] = c.discordHostFailureCooldownSec;
        j["discord"] = dc;

        json bt = (j.contains("batch") && j["batch"].is_object()) ? j["batch"] : json::object();
        bt["onFailure"] = c.batchOnFailure;
        bt["pinCommit"] = c.batchPinCommit;
        bt["keep"] = c.batchKeep;
        j["batch"] = bt;

        std::ofstream o(path, std::ios::binary | std::ios::trunc);
        if (!o) return false;
        o << j.dump(2);
        return (bool)o;
    }

    CoordinatorConfig ParseCoordinatorArgs(int argc, char** argv, int startIndex)
    {
        CoordinatorConfig c;
        c.dataDir = DefaultDataDir();   // baseline (a config file or --data-dir may override)

        // A JSON config file supplies defaults; the CLI flags below override it.
        // Use --config <path>, or drop a smith-coordinator.json in the working dir.
        std::string cfgPath = OptValue(argc, argv, startIndex, "--config", "");
        if (cfgPath.empty()) { std::ifstream probe("smith-coordinator.json"); if (probe.good()) cfgPath = "smith-coordinator.json"; }
        if (!cfgPath.empty())
        {
            c.configPath = cfgPath;
            std::string error;
            if (LoadCoordinatorConfigFile(cfgPath, c, &error))
                StoreLastKnownGoodConfig(cfgPath);
            else
            {
                // Nothing from the broken file was applied. Fall back to the copy of the
                // last file that loaded, so one typo can't take login, the embedded agent
                // and the Discord bot down with it. The coordinator reports configError.
                c.configError = error;
                const std::string lkg = LastKnownGoodConfigPath(cfgPath);
                std::string lkgError;
                c.configUsingLastKnownGood = LoadCoordinatorConfigFile(lkg, c, &lkgError);
                if (c.configUsingLastKnownGood)
                    std::fprintf(stderr, "ERROR: Smith config file %s is invalid (%s). Running on the last-known-good copy %s.\n",
                                 cfgPath.c_str(), error.c_str(), lkg.c_str());
                else
                    std::fprintf(stderr, "ERROR: Smith config file %s is invalid (%s), and there is no usable last-known-good copy (%s: %s). Running on defaults.\n",
                                 cfgPath.c_str(), error.c_str(), lkg.c_str(), lkgError.c_str());
            }
        }
        else c.configPath = "smith-coordinator.json";   // default write-back target for the Settings UI

        // Scalars: the current value (file or default) is the fallback, so a flag
        // overrides only when it is actually present.
        c.host = OptValue(argc, argv, startIndex, "--host", c.host);
        c.port = OptInt(argc, argv, startIndex, "--port", c.port);
        c.dataDir = OptValue(argc, argv, startIndex, "--data-dir", c.dataDir);
        c.webDir = OptValue(argc, argv, startIndex, "--web-dir", c.webDir);
        c.token = OptValue(argc, argv, startIndex, "--token", c.token);
        c.jobWaitMs = OptInt(argc, argv, startIndex, "--job-wait-ms", c.jobWaitMs);
        if (HasFlag(argc, argv, startIndex, "--require-token")) c.requireTokenAlways = true;
        // --project / --repo-override / --project-repo append to whatever the file gave.
        for (int i = startIndex; i + 1 < argc; ++i)
            if (std::string(argv[i]) == "--project") c.projectConfigPaths.push_back(argv[i + 1]);
        for (int i = startIndex; i + 1 < argc; ++i)
        {
            if (std::string(argv[i]) == "--repo-override")
            {
                std::string kv = argv[i + 1];
                size_t eq = kv.find('=');
                if (eq != std::string::npos) c.repoOverrides[kv.substr(0, eq)] = kv.substr(eq + 1);
            }
        }
        if (HasFlag(argc, argv, startIndex, "--with-agent")) c.withAgent = true;
        if (HasFlag(argc, argv, startIndex, "--agent-labels"))
            c.agentLabels = SplitCsv(OptValue(argc, argv, startIndex, "--agent-labels", ""));
        c.pollIntervalSec = OptInt(argc, argv, startIndex, "--poll-interval-sec", c.pollIntervalSec);
        for (int i = startIndex; i + 1 < argc; ++i)
            if (std::string(argv[i]) == "--project-repo") c.projectRepos.push_back(argv[i + 1]);
        if (HasFlag(argc, argv, startIndex, "--no-discovery")) c.discoveryEnabled = false;
        c.discoveryPort = OptInt(argc, argv, startIndex, "--discovery-port", c.discoveryPort);
        c.notifyCommand = OptValue(argc, argv, startIndex, "--notify-command", c.notifyCommand);
        c.notifyOn = OptValue(argc, argv, startIndex, "--notify-on", c.notifyOn);
        // Abort the in-flight build when a newer commit arrives (queued builds are always
        // coalesced; this opts the RUNNING one in too).
        if (HasFlag(argc, argv, startIndex, "--cancel-running-on-new-commit")) c.cancelRunningOnNewCommit = true;
        // Google Workspace sign-in (optional). OFF unless a client id is set (file or flag).
        c.googleClientId = OptValue(argc, argv, startIndex, "--google-client-id", c.googleClientId);
        if (HasFlag(argc, argv, startIndex, "--google-allowed-domains"))
            c.googleAllowedDomains = SplitCsv(OptValue(argc, argv, startIndex, "--google-allowed-domains", ""));
        if (HasFlag(argc, argv, startIndex, "--google-allowed-emails"))
            c.googleAllowedEmails = SplitCsv(OptValue(argc, argv, startIndex, "--google-allowed-emails", ""));
        if (HasFlag(argc, argv, startIndex, "--admin-emails"))
            c.adminEmails = SplitCsv(OptValue(argc, argv, startIndex, "--admin-emails", ""));
        if (HasFlag(argc, argv, startIndex, "--require-login")) c.requireLogin = true;
        c.tokenVerifyCommand = OptValue(argc, argv, startIndex, "--token-verify-command", c.tokenVerifyCommand);
        // If sign-in is enabled but neither a domain nor an email allowlist was given,
        // default to the studio domain so a bare client id is not an accidental
        // allow-all. An explicit email-only allowlist is respected.
        if (!c.googleClientId.empty() && c.googleAllowedDomains.empty() && c.googleAllowedEmails.empty())
            c.googleAllowedDomains.push_back("redmarmosetstudios.com");
        // Env injected into the embedded agent's builds: file env, then --agent-env, then --env.
        { auto e = ParseEnvFlags(argc, argv, startIndex, "--agent-env"); for (auto& kv : e) c.agentBuildEnv[kv.first] = kv.second; }
        { auto e = ParseEnvFlags(argc, argv, startIndex, "--env"); for (auto& kv : e) c.agentBuildEnv[kv.first] = kv.second; }
        CaptureEnginePath(c.agentBuildEnv);
        if (c.agentBuildEnv.count("UNA_ENGINE_PATH") &&
            std::find(c.agentLabels.begin(), c.agentLabels.end(), "una-engine") == c.agentLabels.end())
            c.agentLabels.push_back("una-engine");
        return c;
    }

    AgentConfig ParseAgentArgs(int argc, char** argv, int startIndex)
    {
        AgentConfig a;
        a.coordinatorUrl = OptValue(argc, argv, startIndex, "--coordinator", a.coordinatorUrl);
        a.token = OptValue(argc, argv, startIndex, "--token", a.token);
        a.name = OptValue(argc, argv, startIndex, "--name", a.name);
        a.os = OptValue(argc, argv, startIndex, "--os", a.os);
        a.arch = OptValue(argc, argv, startIndex, "--arch", a.arch);
        a.workspace = OptValue(argc, argv, startIndex, "--workspace", a.workspace);
        a.pollIntervalMs = OptInt(argc, argv, startIndex, "--poll-ms", a.pollIntervalMs);
        a.minFreeDiskMb = OptInt(argc, argv, startIndex, "--min-free-mb", a.minFreeDiskMb);
        a.logKeepDays = OptInt(argc, argv, startIndex, "--log-keep-days", a.logKeepDays);
        a.logKeepMax = OptInt(argc, argv, startIndex, "--log-keep-max", a.logKeepMax);
        a.labels = SplitCsv(OptValue(argc, argv, startIndex, "--labels", ""));
        // Auto-discover the coordinator on the LAN unless the user pinned one with
        // --coordinator (today's behaviour) or opted out with --no-discover.
        a.discover = !HasFlag(argc, argv, startIndex, "--coordinator")
                  && !HasFlag(argc, argv, startIndex, "--no-discover");
        a.discoveryPort = OptInt(argc, argv, startIndex, "--discovery-port", a.discoveryPort);
        // Env injected into every build (e.g. UNA_ENGINE_PATH). Captured from this
        // process's env if not passed via --env; the node then auto-advertises a
        // 'una-engine' label so nodeSelector {labels:[una-engine]} matches.
        a.buildEnv = ParseEnvFlags(argc, argv, startIndex, "--env");
        CaptureEnginePath(a.buildEnv);
        if (a.buildEnv.count("UNA_ENGINE_PATH") &&
            std::find(a.labels.begin(), a.labels.end(), "una-engine") == a.labels.end())
            a.labels.push_back("una-engine");
        if (a.name.empty()) a.name = DetectHostname();
        if (a.os.empty()) a.os = DetectOs();
        if (a.arch.empty()) a.arch = DetectArch();
        return a;
    }
}
