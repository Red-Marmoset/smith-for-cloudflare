#include "HostedCrewTurn.h"
#include "HostedAgent.h"
#include <json/single_include/nlohmann/json.hpp>
#include <algorithm>
#include <filesystem>
#include <regex>
namespace Smith {
std::vector<HostedCrewCreatedProject> HostedCrewCreatedFromClaim(const std::string& entriesJson, size_t& dropped) {
    std::vector<HostedCrewCreatedProject> projects; dropped = 0;
    const auto entries = nlohmann::json::parse(entriesJson, nullptr, false);
    if (!entries.is_array()) return projects;
    const auto text = [](const nlohmann::json& entry, const char* key) { return entry.contains(key) && entry[key].is_string() ? entry[key].get<std::string>() : std::string(); };
    for (const auto& entry : entries) {
        HostedCrewCreatedProject p;
        if (entry.is_object()) p = {text(entry, "id"), text(entry, "remote"), text(entry, "authToken")};
        const bool tokenPlain = !p.authToken.empty() && p.authToken.size() <= 512 && p.authToken.find_first_of("\r\n\t \"") == std::string::npos;
        if (HostedCrewProjectIdValid(p.id) && HostedArtifactsRemote(p.remote) && tokenPlain) projects.push_back(p);
        else ++dropped;
    }
    return projects;
}
std::map<std::string, std::string> HostedCrewNewProjectGitEnv(const HostedCrewDirs& d) { return HostedCrewGitEnv(d); }
std::vector<HostedCrewPushed> HostedCrewPushCreated(const std::vector<HostedCrewCreatedProject>& projects, const HostedCrewDirs& d, const std::string& authorName,
                                                    const std::string& slug, const std::string& sessionId, const HostedCrewGitIo& io) {
    namespace fs = std::filesystem;
    // The author lands in --author: a name with a control character, DEL or angle bracket (or none) is Smith's own label.
    const bool nameValid = !authorName.empty() && authorName.size() <= 100 &&
        std::none_of(authorName.begin(), authorName.end(), [](char c) { return static_cast<unsigned char>(c) < 0x20 || c == 0x7f || c == '<' || c == '>'; });
    const auto name = nameValid ? authorName : std::string("Smith crew");
    const auto who = std::regex_match(slug, std::regex("[a-z0-9][a-z0-9-]{0,31}")) ? slug : std::string("crew");
    std::vector<HostedCrewPushed> pushed;
    for (const auto& p : projects) {
        if (io.stopped()) break;
        const auto dir = (fs::path(d.newProject) / p.id).string(), gitDir = (fs::path(d.runControl) / ("new-project-" + p.id + ".git")).string();
        if (!HostedCrewNewProjectDirValid(dir)) {
            io.status("Smith did not push new-project/" + p.id + ": it must be a folder of plain files and folders, without .git or links.");
            continue;
        }
        std::error_code ignored; fs::remove_all(gitDir, ignored);   // a replayed push starts its commit afresh
        auto env = HostedGitAuthEnv(p.remote, p.authToken);
        for (const auto& [key, value] : HostedCrewNewProjectGitEnv(d)) env[key] = value;
        const auto git = [&](std::vector<std::string> args) { args.insert(args.begin(), {"--git-dir=" + gitDir, "--work-tree=" + dir}); return args; };
        auto commit = HostedCrewCommitArgv(name, who, "Create " + p.id, sessionId);
        commit.insert(commit.begin(), {"-c", "user.name=Smith crew", "-c", "user.email=smith-crew@localhost"});
        io.status("Pushing the new project " + p.id + " to its Cloudflare Artifacts repository ...");
        if (io.git(git({"init", "-q"}), dir, env) != 0 || io.git(git({"add", "-A"}), dir, env) != 0) {
            io.status("Smith could not stage new-project/" + p.id + ", so it was not pushed.");
            continue;
        }
        // As CommitAll does for a run's own change: the staged change, with no external diff or textconv program, holds none of
        // the turn's secrets. A search that cannot run is no answer, so nothing of that project is committed either way.
        if (const int scan = io.scan ? io.scan(git({"diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--text"}), dir) : -1; scan != 0) {
            io.status(scan > 0 ? "new-project/" + p.id + " contained a secret, so Smith did not commit or push it."
                               : "Smith could not check new-project/" + p.id + " for secrets, so it did not commit or push it.");
            continue;
        }
        if (io.git(git(commit), dir, env) != 0) {
            io.status("Smith could not commit new-project/" + p.id + " (an empty folder has nothing to commit), so it was not pushed.");
            continue;
        }
        auto head = io.capture(git({"rev-parse", "--verify", "-q", "HEAD"}), dir, env);
        while (!head.empty() && (head.back() == '\n' || head.back() == '\r')) head.pop_back();
        if (!std::regex_match(head, std::regex("[a-f0-9]{40}"))) { io.status("Smith could not read the commit of new-project/" + p.id + ", so it was not pushed."); continue; }
        if (io.git(git({"push", "--no-verify", p.remote, "HEAD:refs/heads/main"}), dir, env) != 0) {
            io.status("git push of the new project " + p.id + " failed; the output above says why.");
            continue;
        }
        io.status("Pushed the new project " + p.id + " at " + head.substr(0, 12) + ".");
        pushed.push_back({p.id, head});
    }
    return pushed;
}
}
