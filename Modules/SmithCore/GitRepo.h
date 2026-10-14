// GitRepo.h - shared git checkout helpers.
//
// Used by the coordinator (its own per-project checkouts, for reading smith.json
// and detecting new commits) and by the agent (per-build workspaces). Shells out
// to `git` via Smith::Process so both sides share one implementation.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>
#include <functional>

namespace Smith
{
    using GitLog = std::function<void(bool isStderr, const std::string& line)>;

    class GitRepo
    {
    public:
        // Ensure `dir` is a checkout of `url` at `branch` (and optional exact
        // `commit`). Clones if `dir` has no .git, else fetches; then checks out the
        // branch/commit and hard-resets to origin/<branch> when no commit is pinned.
        // Output streams to `log` (may be null). Returns false on clone/checkout fail.
        // When `clean` is true, untracked + ignored files (build caches such as a
        // Unity Library/ or IL2CPP intermediates) are purged after the checkout, in
        // the superproject and every submodule. Cleanup failures are logged, not fatal.
        static bool Sync(const std::string& url, const std::string& dir,
                         const std::string& branch, const std::string& commit,
                         const GitLog& log, const std::string& authToken = "",
                         bool clean = false);

        // Repack + prune a checkout's git object store to reclaim history bloat
        // (does not touch the working tree). No-op/false if `dir` has no .git.
        static bool Gc(const std::string& dir, const GitLog& log);

        // Fetch, then return the sha of origin/<branch> (for poll detection), or "".
        static std::string FetchRemoteSha(const std::string& dir, const std::string& branch);

        // Contents of `path` as committed at `ref` (e.g. "origin/feature/x"), read straight
        // from the object store with `git show` - the work tree is never touched, so it is
        // safe on a local --project tree. Does not fetch. False if the ref or file is absent.
        static bool ReadFileAtRef(const std::string& dir, const std::string& ref,
                                  const std::string& path, std::string& out);

        // HEAD sha of an existing checkout, or "".
        static std::string HeadSha(const std::string& dir);

        // Author name + email of a commit in an existing checkout (for attributing a
        // build to the person whose change it built). False if the sha isn't present.
        static bool CommitAuthor(const std::string& dir, const std::string& commit,
                                 std::string& nameOut, std::string& emailOut);

        static bool HasCheckout(const std::string& dir);
    };
}
