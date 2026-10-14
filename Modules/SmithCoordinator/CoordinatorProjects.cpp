// CoordinatorProjects.cpp - projects added by git repo (the coordinator clones
// its own copy to read smith.json and watch for changes) + the co-located agent.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Coordinator.h"
#include "CoordinatorUtil.h"

#include <SmithCore/GitRepo.h>
#include <SmithCore/RepoConfig.h>
#include <SmithCore/Config.h>
#include <SmithCore/GitUrl.h>
#include <SmithCore/Uuid.h>
#include <SmithCore/TimeUtil.h>
#include <SmithCore/Strings.h>
#include <SmithCore/JsonFile.h>
#include <SmithAgent/Agent.h>
#include <Log/Log.h>

#include <json/single_include/nlohmann/json.hpp>

#include <filesystem>
#include <fstream>
#include <sstream>
#include <cctype>
#include <algorithm>

using nlohmann::json;
namespace fs = std::filesystem;

namespace Smith
{
    static std::string Slug(const std::string& url)
    {
        std::string s;
        for (char c : url) s += (std::isalnum((unsigned char)c) || c == '-' || c == '_') ? c : '_';
        if (s.size() > 90) s = s.substr(0, 90);
        return s;
    }

    void Coordinator::RegisterProject(const ProjectDef& def)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_projects[def.id] = def;
    }

    std::string Coordinator::AddProjectByUrl(const std::string& url, const std::string& branch, std::string& error)
    {
        std::string u = url;
        std::string b = branch;
        size_t hash = u.find('#');       // allow "url#branch"
        if (hash != std::string::npos) { if (b.empty()) b = u.substr(hash + 1); u = u.substr(0, hash); }

        // A UI "refresh" POST carries only a url (no branch). Recover the branch
        // from the source we already track for this url, else GitRepo::Sync would
        // only fetch and leave an existing checkout on its old commit - so an
        // updated smith.json (e.g. new build variants) would never get re-read.
        // First-time clones have no source yet; they land on the remote's default
        // branch and the defaultBranch fallback below records it.
        if (b.empty())
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            for (const auto& kv : m_sources)
                if (kv.second.url == u) { b = kv.second.branch; break; }
        }

        fs::path dir = fs::path(m_cfg.dataDir) / "repos" / Slug(u);
        GitLog log = [](bool, const std::string& l) { LOG_INFO("Smith", "%s", l.c_str()); };
        if (!GitRepo::Sync(u, dir.string(), b, "", log))
        {
            error = "git clone/fetch failed for " + u;
            return "";
        }

        ProjectDef def;
        std::string err;
        if (!LoadProjectConfig(dir.string(), def, err))
        {
            error = "smith.json: " + err;
            return "";
        }

        if (b.empty())
        {
            for (const auto& r : def.repos) if (r.primary) { b = r.defaultBranch; break; }
            if (b.empty()) b = "main";
        }

        def.localDir = dir.string();
        DiscoverProjectVariants(def);
        RegisterProject(def);
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            ProjectSource src;
            src.url = u; src.branch = b; src.dir = dir.string(); src.projectId = def.id;
            m_sources[def.id] = src;
        }
        SaveSources();
        LOG_INFO("Smith", "Added project '%s' from repo %s (branch %s)", def.id.c_str(), u.c_str(), b.c_str());
        return def.id;
    }

    // Serve the project's smith.json verbatim from its source checkout, so API
    // consumers (the Discord bot's pipeline tool, scripts) can see how a project
    // builds - products, rules, node requirements, handoff, triggers.
    void Coordinator::HandlePipeline(const Http::Request& req, Http::Response& res)
    {
        std::string id = req.Param("id");
        std::string dir;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            auto it = m_projects.find(id);
            if (it == m_projects.end()) { res.Set(404, "unknown project"); return; }
            dir = it->second.localDir;
        }
        std::ifstream f(fs::path(dir) / "smith.json", std::ios::binary);
        if (!f) { res.Set(404, "no smith.json for this project"); return; }
        std::stringstream ss;
        ss << f.rdbuf();
        res.Set(200, ss.str(), "application/json");
    }

    void Coordinator::RefreshProjectSource(const std::string& projectId)
    {
        // Re-sync a cloned project source and re-read its smith.json so a manual
        // trigger / rerun dispatches the rule definitions at the repo's tip - the
        // poll and autobuild paths already refresh; without this a manual trigger
        // keeps building with the smith.json loaded at startup. No-op for a local
        // --project tree (never synced). On failure the last-known config stands.
        ProjectSource src;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            auto it = m_sources.find(projectId);
            if (it == m_sources.end()) return;
            src = it->second;
        }
        if (src.local) return;
        std::string err;
        if (AddProjectByUrl(src.url, src.branch, err).empty())
            LOG_WARNING("Smith", "project refresh failed for %s: %s (building with the last-known smith.json)",
                        projectId.c_str(), err.c_str());
    }

    bool Coordinator::LoadProjectRepos()
    {
        bool ok = true;
        LoadSources();   // persisted sources from a previous run

        std::vector<ProjectSource> persisted;
        { std::lock_guard<std::mutex> lock(m_mutex); for (auto& kv : m_sources) persisted.push_back(kv.second); }
        for (const auto& src : persisted)
        {
            std::string err;
            if (AddProjectByUrl(src.url, src.branch, err).empty())
            { LOG_WARNING("Smith", "could not refresh project repo %s: %s", src.url.c_str(), err.c_str()); ok = false; }
        }

        for (const auto& spec : m_cfg.projectRepos)   // newly specified --project-repo
        {
            std::string err;
            if (AddProjectByUrl(spec, "", err).empty())
            { LOG_ERROR("Smith", "failed to add --project-repo %s: %s", spec.c_str(), err.c_str()); ok = false; }
        }
        return ok;
    }

    void Coordinator::SaveSources()
    {
        json arr = json::array();
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            for (auto& kv : m_sources)
                if (!kv.second.local)   // local --project sources are re-derived each startup, not persisted
                    arr.push_back(json{{"url", kv.second.url}, {"branch", kv.second.branch},
                                       {"dir", kv.second.dir}, {"projectId", kv.second.projectId}});
        }
        SaveJsonFileAtomic((fs::path(m_cfg.dataDir) / "project-sources.json").string(), arr);
    }

    void Coordinator::LoadSources()
    {
        json j;
        if (!LoadJsonFile((fs::path(m_cfg.dataDir) / "project-sources.json").string(), j) || !j.is_array()) return;
        std::lock_guard<std::mutex> lock(m_mutex);
        for (const auto& e : j)
        {
            if (!e.is_object()) continue;
            ProjectSource src;
            src.url = e.value("url", std::string());
            src.branch = e.value("branch", std::string());
            src.dir = e.value("dir", std::string());
            src.projectId = e.value("projectId", std::string());
            if (!src.projectId.empty()) m_sources[src.projectId] = src;
        }
    }

    // Validate + enqueue; returns immediately so the UI never blocks and several
    // repos can be added in quick succession. Accepts {url,branch} or {urls:[...],branch}.
    void Coordinator::HandleAddProject(const Http::Request& req, Http::Response& res)
    {
        json j;
        if (!ParseBody(req, j))
        { JsonError(res, 400, "expected {\"url\":...} or {\"urls\":[...]}"); return; }

        std::string branch = j.value("branch", std::string());
        std::vector<std::string> urls;
        if (j.contains("urls") && j["urls"].is_array())
        { for (const auto& u : j["urls"]) if (u.is_string()) urls.push_back(u.get<std::string>()); }
        else if (j.contains("url") && j["url"].is_string())
            urls.push_back(j["url"].get<std::string>());

        if (urls.empty()) { JsonError(res, 400, "expected a url or urls[]"); return; }

        // Reject an obvious typo before anything is queued (server is authoritative).
        for (const auto& u : urls)
        {
            std::string e = ValidateGitUrl(u);
            if (!e.empty()) { res.Json(json{{"error", e}, {"url", u}}.dump(), 400); return; }   // two-field error: keep as-is
        }

        json created = json::array();
        for (const auto& u : urls)
        {
            std::string id = EnqueueProjectRequest(u, branch);
            created.push_back(json{{"requestId", id}, {"url", u}, {"status", "pending"}});
        }
        res.Json(json{{"requests", created}}.dump(), 201);
    }

    std::string Coordinator::EnqueueProjectRequest(const std::string& url, const std::string& branch)
    {
        ProjectRequest r;
        r.id = MakeShortId();
        r.url = url;
        r.branch = branch;
        r.status = "pending";
        r.createdAt = NowMillis();
        {
            std::lock_guard<std::mutex> lk(m_addMutex);
            m_requests[r.id] = r;
            m_addQueue.push_back(r.id);
        }
        SaveRequests();
        m_addCv.notify_one();
        LOG_INFO("Smith", "Queued add-project request %s for %s", r.id.c_str(), url.c_str());
        return r.id;
    }

    void Coordinator::AddWorkerLoop()
    {
        while (!m_stopAdd)
        {
            std::string reqId;
            {
                std::unique_lock<std::mutex> lk(m_addMutex);
                m_addCv.wait(lk, [&] { return m_stopAdd || !m_addQueue.empty(); });
                if (m_stopAdd) break;
                reqId = m_addQueue.front();
                m_addQueue.erase(m_addQueue.begin());
            }

            std::string url, branch;
            {
                std::lock_guard<std::mutex> lk(m_addMutex);
                auto it = m_requests.find(reqId);
                if (it == m_requests.end()) continue;
                it->second.status = "cloning";
                url = it->second.url;
                branch = it->second.branch;
            }
            SaveRequests();

            std::string error;
            std::string projectId = AddProjectByUrl(url, branch, error);   // clone (slow); no lock held

            {
                std::lock_guard<std::mutex> lk(m_addMutex);
                auto it = m_requests.find(reqId);
                if (it != m_requests.end())
                {
                    if (!projectId.empty()) { it->second.status = "done"; it->second.projectId = projectId; }
                    else { it->second.status = "failed"; it->second.error = error; }
                    it->second.finishedAt = NowMillis();
                }
            }
            SaveRequests();
        }
    }

    void Coordinator::HandleProjectRequests(const Http::Request&, Http::Response& res)
    {
        std::vector<ProjectRequest> reqs;
        { std::lock_guard<std::mutex> lk(m_addMutex); for (const auto& kv : m_requests) reqs.push_back(kv.second); }
        std::sort(reqs.begin(), reqs.end(),
                  [](const ProjectRequest& a, const ProjectRequest& b) { return a.createdAt > b.createdAt; });
        json arr = json::array();
        for (const auto& r : reqs)
            arr.push_back(json{{"id", r.id}, {"url", r.url}, {"branch", r.branch}, {"status", r.status},
                               {"projectId", r.projectId}, {"error", r.error},
                               {"createdAt", r.createdAt}, {"finishedAt", r.finishedAt}});
        res.Json(arr.dump());
    }

    void Coordinator::SaveRequests()
    {
        json arr = json::array();
        {
            std::lock_guard<std::mutex> lk(m_addMutex);
            for (const auto& kv : m_requests)
                arr.push_back(json{{"id", kv.second.id}, {"url", kv.second.url}, {"branch", kv.second.branch},
                                   {"status", kv.second.status}, {"projectId", kv.second.projectId},
                                   {"error", kv.second.error}, {"createdAt", kv.second.createdAt},
                                   {"finishedAt", kv.second.finishedAt}});
        }
        SaveJsonFileAtomic((fs::path(m_cfg.dataDir) / "project-requests.json").string(), arr);
    }

    void Coordinator::LoadRequests()
    {
        json j;
        if (!LoadJsonFile((fs::path(m_cfg.dataDir) / "project-requests.json").string(), j) || !j.is_array()) return;
        std::lock_guard<std::mutex> lk(m_addMutex);
        for (const auto& e : j)
        {
            if (!e.is_object()) continue;
            ProjectRequest r;
            r.id = e.value("id", std::string());
            r.url = e.value("url", std::string());
            r.branch = e.value("branch", std::string());
            r.status = e.value("status", std::string());
            r.projectId = e.value("projectId", std::string());
            r.error = e.value("error", std::string());
            r.createdAt = e.value("createdAt", (int64_t)0);
            r.finishedAt = e.value("finishedAt", (int64_t)0);
            if (r.id.empty()) continue;
            if (r.status == "pending" || r.status == "cloning")   // interrupted by a restart -> retry
            { r.status = "pending"; m_addQueue.push_back(r.id); }
            m_requests[r.id] = r;
        }
    }

    // -------------------------------------------------------------- settings + users

    static std::string NormEmail(const std::string& s)
    {
        return Lower(Trim(s));
    }

    // Clear a project's build history: delete every terminal build's files + record
    // (an in-flight build is left alone so it isn't orphaned mid-run).
    void Coordinator::HandleClearBuilds(const Http::Request& req, Http::Response& res)
    {
        std::string id = req.Param("id");
        std::vector<BuildRecord> dead;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            for (const auto& kv : m_builds)
                if (kv.second.projectId == id && IsTerminal(kv.second.status)) dead.push_back(kv.second);
        }
        for (const auto& r : dead) m_store.DeleteBuild(r);
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            for (const auto& r : dead) m_builds.erase(r.jobId);
        }
        LOG_INFO("Smith", "Cleared %d build(s) for project %s", (int)dead.size(), id.c_str());
        res.Json(json{{"cleared", (int)dead.size()}}.dump());
    }

    // GET -> list users; POST -> create or update one (keyed by id, or a new id).
    void Coordinator::HandleUsers(const Http::Request& req, Http::Response& res)
    {
        if (req.method == "POST")
        {
            json j;
            if (!ParseBody(req, j) || !j.contains("displayName"))
            { JsonError(res, 400, "expected {displayName, gitEmails[], notifyOwnFailuresOnly?, role?, id?}"); return; }

            User u;
            u.id = j.value("id", std::string());
            if (u.id.empty()) u.id = MakeShortId();
            u.displayName = j.value("displayName", std::string());
            u.role = j.value("role", std::string("member"));
            u.notifyOwnFailuresOnly = j.value("notifyOwnFailuresOnly", true);
            u.email = NormEmail(j.value("email", std::string()));   // Google identity + explicit-allow grant
            if (j.contains("gitEmails") && j["gitEmails"].is_array())
                for (const auto& e : j["gitEmails"])
                    if (e.is_string()) { std::string em = NormEmail(e.get<std::string>()); if (!em.empty()) u.gitEmails.push_back(em); }

            {
                std::lock_guard<std::mutex> lock(m_mutex);
                auto ex = m_users.find(u.id);   // editing an existing user: keep its identity binding
                if (ex != m_users.end()) { u.googleSub = ex->second.googleSub; if (u.email.empty()) u.email = ex->second.email; }
                m_users[u.id] = u;
            }
            SaveUsers();
            res.Json(json{{"id", u.id}}.dump());
            return;
        }

        std::vector<User> users;
        { std::lock_guard<std::mutex> lock(m_mutex); for (const auto& kv : m_users) users.push_back(kv.second); }
        std::sort(users.begin(), users.end(), [](const User& a, const User& b) { return a.displayName < b.displayName; });
        json arr = json::array();
        for (const auto& u : users)
            arr.push_back(json{{"id", u.id}, {"displayName", u.displayName}, {"role", u.role}, {"email", u.email},
                               {"gitEmails", u.gitEmails}, {"notifyOwnFailuresOnly", u.notifyOwnFailuresOnly}});
        res.Json(arr.dump());
    }

    void Coordinator::HandleDeleteUser(const Http::Request& req, Http::Response& res)
    {
        std::string id = req.Param("id");
        bool removed = false;
        { std::lock_guard<std::mutex> lock(m_mutex); removed = m_users.erase(id) > 0; }
        if (removed) SaveUsers();
        res.Json(json{{"deleted", removed}}.dump());
    }

    void Coordinator::SaveUsers()
    {
        json arr = json::array();
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            for (const auto& kv : m_users)
                arr.push_back(json{{"id", kv.second.id}, {"displayName", kv.second.displayName}, {"role", kv.second.role},
                                   {"email", kv.second.email}, {"googleSub", kv.second.googleSub},
                                   {"gitEmails", kv.second.gitEmails}, {"notifyOwnFailuresOnly", kv.second.notifyOwnFailuresOnly}});
        }
        SaveJsonFileAtomic((fs::path(m_cfg.dataDir) / "users.json").string(), arr);
    }

    void Coordinator::LoadUsers()
    {
        json j;
        if (!LoadJsonFile((fs::path(m_cfg.dataDir) / "users.json").string(), j) || !j.is_array()) return;
        std::lock_guard<std::mutex> lock(m_mutex);
        for (const auto& e : j)
        {
            if (!e.is_object()) continue;
            User u;
            u.id = e.value("id", std::string());
            u.displayName = e.value("displayName", std::string());
            u.role = e.value("role", std::string("member"));
            u.notifyOwnFailuresOnly = e.value("notifyOwnFailuresOnly", true);
            u.email = e.value("email", std::string());
            u.googleSub = e.value("googleSub", std::string());
            if (e.contains("gitEmails") && e["gitEmails"].is_array())
                for (const auto& g : e["gitEmails"]) if (g.is_string()) u.gitEmails.push_back(g.get<std::string>());
            if (!u.id.empty()) m_users[u.id] = u;
        }
    }

    // Git poll state: projectId -> branch -> last-seen SHA, persisted so a restart
    // resumes from the last baseline instead of re-baselining (which would skip any
    // commit pushed during downtime). Stored as a nested JSON object under dataDir.
    void Coordinator::SavePollState()
    {
        json obj = json::object();
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            for (const auto& proj : m_pollState)
            {
                json branches = json::object();
                for (const auto& br : proj.second) branches[br.first] = br.second;
                obj[proj.first] = branches;
            }
        }
        SaveJsonFileAtomic((fs::path(m_cfg.dataDir) / "poll-state.json").string(), obj);
    }

    void Coordinator::LoadPollState()
    {
        json j;
        if (!LoadJsonFile((fs::path(m_cfg.dataDir) / "poll-state.json").string(), j) || !j.is_object()) return;
        std::lock_guard<std::mutex> lock(m_mutex);
        for (auto it = j.begin(); it != j.end(); ++it)
        {
            if (!it->is_object()) continue;
            for (auto bit = it->begin(); bit != it->end(); ++bit)
                if (bit->is_string()) m_pollState[it.key()][bit.key()] = bit->get<std::string>();
        }
    }

    std::string Coordinator::FindUserByEmail(const std::string& email) const
    {
        std::string needle = NormEmail(email);
        if (needle.empty()) return "";
        std::lock_guard<std::mutex> lock(m_mutex);
        for (const auto& kv : m_users)
            for (const auto& e : kv.second.gitEmails)
                if (e == needle) return kv.first;
        return "";
    }

    // Resolve a build's commit author from the coordinator's own project checkout
    // (lazy, off the request path) so a failure can be attributed to the person at
    // fault. No-op for builds with no pinned sha (e.g. a manual trigger).
    void Coordinator::EnsureAuthor(const std::string& jobId)
    {
        std::string commit, repoDir;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            auto it = m_builds.find(jobId);
            if (it == m_builds.end()) return;
            if (!it->second.authorEmail.empty() || !it->second.authorName.empty()) return;   // already attributed
            if (it->second.commit.empty()) return;
            commit = it->second.commit;
            const std::string& pid = it->second.projectId;
            auto sit = m_sources.find(pid);
            if (sit != m_sources.end()) repoDir = sit->second.dir;
            else { auto pit = m_projects.find(pid); if (pit != m_projects.end()) repoDir = pit->second.localDir; }
        }
        if (repoDir.empty()) return;

        std::string name, email;
        if (!GitRepo::CommitAuthor(repoDir, commit, name, email)) return;

        BuildRecord toSave;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            auto it = m_builds.find(jobId);
            if (it == m_builds.end()) return;
            it->second.authorName = name;
            it->second.authorEmail = email;
            toSave = it->second;
        }
        m_store.SaveRecord(toSave);
    }

    void Coordinator::StartEmbeddedAgent()
    {
        AgentConfig acfg;
        acfg.coordinatorUrl = "http://127.0.0.1:" + std::to_string(m_cfg.port);
        acfg.discover = false;   // co-located: we already know the coordinator URL
        acfg.token = m_cfg.token;
        acfg.name = DetectHostname() + "-local";
        acfg.os = DetectOs();
        acfg.arch = DetectArch();
        acfg.labels = m_cfg.agentLabels;
        acfg.buildEnv = m_cfg.agentBuildEnv;
        acfg.workspace = (fs::path(m_cfg.dataDir) / "local-agent-workspace").string();
        m_embeddedAgent = std::make_unique<Agent>(acfg);
        m_agentThread = std::thread([this]() { m_embeddedAgent->Run(); });
        LOG_INFO("Smith", "Co-located agent '%s' starting (os %s)", acfg.name.c_str(), acfg.os.c_str());
        auto envIt = acfg.buildEnv.find("UNA_ENGINE_PATH");
        if (envIt != acfg.buildEnv.end())
            LOG_INFO("Smith", "Co-located agent builds use UNA_ENGINE_PATH=%s", envIt->second.c_str());
    }

    void Coordinator::StopEmbeddedAgent()
    {
        if (m_embeddedAgent) m_embeddedAgent->Stop();
        if (m_agentThread.joinable()) m_agentThread.join();
    }
}
