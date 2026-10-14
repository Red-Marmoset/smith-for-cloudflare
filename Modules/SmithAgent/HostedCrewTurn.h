// HostedCrewTurn.h - the part of a crew push turn that pushes the projects its run created (crew_create_project):
// each new-project/<id> folder becomes the first commit on main of the Cloudflare Artifacts repository the coordinator
// made for it. Git runs through the turn's own runner (HostedCrewGitIo), so its output is relayed and redacted there;
// nothing here starts a process itself.
#pragma once
#include "HostedCrewRun.h"
#include <functional>
#include <map>
#include <string>
#include <vector>
namespace Smith {
    struct HostedCrewCreatedProject { std::string id, remote, authToken; };
    // The createdProjects of a push claim (the JSON text of its array) that Smith pushes: a valid project ID, a Cloudflare
    // Artifacts remote and a plain write token (1-512 bytes, no whitespace or quote). `dropped` counts every other entry.
    std::vector<HostedCrewCreatedProject> HostedCrewCreatedFromClaim(const std::string& entriesJson, size_t& dropped);
    // How the push runs git: `git` runs `git <args>` (the turn adds its no-hooks options) in `cwd` with `env` added and returns
    // its exit code; `capture` returns what such a command printed; `scan` runs `git <args>` in `cwd` and answers whether a line
    // it printed holds one of the turn's secrets (1), none (0) or git failed (-1); `status` says something in the transcript.
    struct HostedCrewGitIo {
        std::function<int(const std::vector<std::string>&, const std::string&, const std::map<std::string, std::string>&)> git;
        std::function<std::string(const std::vector<std::string>&, const std::string&, const std::map<std::string, std::string>&)> capture;
        std::function<int(const std::vector<std::string>&, const std::string&)> scan;
        std::function<void(const std::string&)> status;
        std::function<bool()> stopped;
    };
    struct HostedCrewPushed { std::string id, commit; };
    // The git environment of a created project's commands: HostedCrewGitEnv (the member's own empty gitconfig as the global
    // config; the Git installation's system config is kept), so nothing of the machine owner's git settings applies.
    std::map<std::string, std::string> HostedCrewNewProjectGitEnv(const HostedCrewDirs& d);
    // Pushes each project's new-project/<id> folder, refusing one HostedCrewNewProjectDirValid rejects (a planted .git, a
    // link) before any git runs for it: `git init`, `add -A`, the staged change searched for the turn's secrets (as CommitAll
    // does; a hit, or a search that failed, pushes nothing of it), and a commit as the member, with the git dir kept outside the
    // folder (in the run's control dir), then `push --no-verify <remote> HEAD:refs/heads/main` with the project's own token.
    // Returns the projects pushed, each with the commit it pushed.
    std::vector<HostedCrewPushed> HostedCrewPushCreated(const std::vector<HostedCrewCreatedProject>& projects, const HostedCrewDirs& d, const std::string& authorName,
                                                        const std::string& slug, const std::string& sessionId, const HostedCrewGitIo& io);
}
