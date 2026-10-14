#pragma once
#include <SmithProtocol/WireTypes.h>
#include <map>
#include <string>
#include <vector>
namespace Smith {
    bool HostedOriginValid(const std::string& origin);
    bool HostedRelativePathValid(const std::string& path);
    // A Cloudflare Artifacts git remote: https://<32 hex account>.artifacts.cloudflare.net/git/<ns>/<repo>.git
    // with no userinfo, query, whitespace or control characters.
    bool HostedArtifactsRemote(const std::string& url);
    // The coordinator this agent talks to, set once at start-up (HostedSmithRemote and HostedGitAuthEnv read it),
    // and the node credential that accompanies a repository ticket so the coordinator can tell it is this machine.
    void HostedSetCoordinator(const std::string& origin, const std::string& nodeCredential);
    std::string HostedCoordinatorOrigin();
    // Smith's own copy of a project: <coordinator origin>/git/<project id>.git, nothing else in the URL.
    bool HostedSmithRemote(const std::string& url);
    // The remotes for which a hosted job, chat or crew run may carry a coordinator-minted token:
    // an Artifacts remote or a Smith-hosted repository on this agent's coordinator.
    bool HostedCredentialRemote(const std::string& url);
    // Environment that makes git send `Authorization: Bearer <token>` to <url> (GIT_CONFIG_COUNT/KEY_n/VALUE_n ->
    // http.<url>.extraheader), plus GIT_TERMINAL_PROMPT=0. For an Artifacts remote the header is scoped to the origin;
    // for a Smith remote it is scoped to that repository's path, the node credential rides along as X-Smith-Node, and
    // the machine's credential helpers are switched off so a refused ticket can never fall through to a person's login.
    // The token never appears in argv or .git/config. An empty token yields the prompt-only map.
    std::map<std::string, std::string> HostedGitAuthEnv(const std::string& url, const std::string& token);
    // Pure: `env` plus the git config a build of a project with large files needs (lfs.url and the ticket header for
    // the Smith remote, renumbered after what `env` already carries). Unchanged when the spec names no LFS source.
    std::map<std::string, std::string> HostedLfsEnv(const JobSpec& spec, std::map<std::string, std::string> env);
    std::string ValidateHostedSpec(const JobSpec& spec);
    std::vector<std::string> HostedCommandArgv(const CommandSpec& command, const std::string& cwd);
    // Pure: "repo_access" when git's error output says this machine's Git login cannot read the
    // repository (another machine should try), "" for anything else (network, disk, bad ref).
    std::string HostedClassifyGitFailure(const std::vector<std::string>& errorLines);
    // Pure: the git error line worth showing a person (the refusal itself, else git's last
    // "fatal:" line, else its last line), at most 200 characters; "" when there is none.
    std::string HostedGitFailureReason(const std::vector<std::string>& errorLines);
    // Pure: why a mirror push failed, for a person. A refused non-fast-forward push says
    // "not a fast-forward" (the coordinator turns that into the one next step); else the git reason.
    std::string HostedPushFailure(const std::string& remote, const std::vector<std::string>& errorLines);
    // Pure: the scan report sent to /complete (scan jobs) and /resolve (branch-tip builds), as JSON
    // text. Keeps at most 20000 paths and 512 KiB of path text (then "truncated" is true); throws
    // for a smith.json over 256 KiB.
    std::string HostedScanReport(const std::string& commit, const std::string& branch, bool hasSmithJson, const std::string& smithJson, const std::vector<std::string>& paths);
    // A model served by the machine's local Ollama. Remote (":cloud") models run on, and bill,
    // the machine owner's Ollama account, so the coordinator never shares them.
    struct HostedOllamaModel { std::string name; long long sizeBytes = 0; bool remote = false; };
    // Pure: models listed by Ollama's GET /api/tags. Entries with unsafe names are dropped; at most 50.
    std::vector<HostedOllamaModel> HostedParseOllamaTags(const std::string& body);
    // Pure: the first non-empty line of a CLI's --version output, limited to 64 printable characters.
    std::string HostedToolVersion(const std::string& output);
    int RunHostedAgent(int argc, char** argv);
}
