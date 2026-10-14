// HostedRepoCache.h - one Git object store per repository on a hosted node.
//
// A connected machine serves every workspace its owner is in, and the same
// project is often present in several of them (and in several chats). Without a
// cache every job and every chat cloned the repository from the remote again,
// so one repository was fetched and stored once per use. The cache keys a bare
// mirror by the repository URL alone - never by workspace, project or job - so
// all of them share one copy of the history: a job or chat checkout is a local
// clone of the mirror (Git hard-links the objects, so the working copy costs
// only its tree), with `origin` pointed back at the real remote.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace Smith
{
    // Runs `git <argv>` in `cwd` with `env` added to the environment; stdout and
    // stderr lines are appended to the optional vectors. Returns the exit code
    // (nonzero on failure, -1 when the command could not start).
    using HostedGitRunFn = std::function<int(std::vector<std::string> argv, const std::filesystem::path& cwd,
                                             const std::map<std::string, std::string>& env,
                                             std::vector<std::string>* stdoutLines, std::vector<std::string>* stderrLines)>;

    // The URL that identifies a repository for sharing: scheme and host lowercased,
    // scp-style `git@host:path` written as `ssh://git@host/path`, userinfo dropped,
    // a trailing `/` or `.git` removed (GitHub paths are case-insensitive, so they
    // are lowercased too). Two spellings of one repository map to one cache.
    std::string HostedCanonicalRepoUrl(const std::string& url);

    // Where the mirror of `url` lives under `root` (`<root>/repos/<sha256 of the
    // canonical URL>.git`). Pure: nothing is created.
    std::filesystem::path HostedRepoCachePath(const std::filesystem::path& root, const std::string& url);

    // True once a usable mirror of `url` exists under `root`.
    bool HostedRepoCacheExists(const std::filesystem::path& root, const std::string& url);

    // Serialises use of one repository's cache inside this process (a job and a
    // chat may need the same repository at the same time). Held by the caller
    // across the update and the local clone that reads the mirror.
    struct HostedRepoCacheLock { virtual ~HostedRepoCacheLock() = default; };
    std::unique_ptr<HostedRepoCacheLock> HostedLockRepoCache(const std::filesystem::path& cache);

    // Creates the mirror if needed and brings it up to date from the remote
    // (`gitEnv` carries the remote's credentials, which never reach the cache's
    // config). When `commit` is set and the fetch did not bring it, it is fetched
    // by name. A mirror that cannot be fetched into (corrupt, or left half-made)
    // is recreated once. Returns false when the remote could not be fetched;
    // `gitErrors` then holds Git's stderr for classification.
    bool HostedUpdateRepoCache(const std::filesystem::path& cache, const std::string& url, const std::string& commit,
                               const std::map<std::string, std::string>& gitEnv, const HostedGitRunFn& run,
                               std::vector<std::string>* gitErrors);

    // A new checkout of `url` at `checkout`, cloned from the mirror without a
    // working tree (`--no-checkout`; `branch`, when set, selects the clone's HEAD)
    // and with `origin` set back to `url` so later fetches, pushes and submodule
    // reads use the real remote. False when the clone failed.
    bool HostedCloneFromRepoCache(const std::filesystem::path& cache, const std::string& url, const std::string& branch,
                                  const std::filesystem::path& checkout, const HostedGitRunFn& run,
                                  std::vector<std::string>* gitErrors);
}
