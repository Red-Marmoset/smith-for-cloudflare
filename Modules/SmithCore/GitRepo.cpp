// GitRepo.cpp
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "GitRepo.h"
#include "Process.h"
#include "GitUrl.h"
#include "Strings.h"

#include <filesystem>
#include <vector>

namespace fs = std::filesystem;

namespace Smith
{
    static int RunGit(const std::vector<std::string>& args, const std::string& cwd,
                      const GitLog& log, std::string* captureOut = nullptr,
                      const std::string& authToken = "")
    {
        std::vector<std::string> argv;
        argv.reserve(args.size() + 3);
        argv.push_back("git");
        if (!authToken.empty())
        {
            // Token auth via a per-command header scoped to github.com - keeps the token
            // out of the URL, .git/config and the streamed [git] log lines.
            argv.push_back("-c");
            argv.push_back("http.https://github.com/.extraheader=" + GitHubExtraHeader(authToken));
        }
        for (const auto& a : args) argv.push_back(a);

        ProcessOptions o;
        o.argv = argv;
        o.workingDir = cwd;
        o.timeoutSeconds = 1800;

        Process p;
        return p.Run(o, [&](bool isErr, const std::string& line) {
            if (captureOut && !isErr)
            {
                if (!captureOut->empty()) *captureOut += "\n";
                *captureOut += line;
            }
            if (log) log(isErr, "[git] " + line);
        });
    }

    bool GitRepo::HasCheckout(const std::string& dir)
    {
        std::error_code ec;
        return fs::exists(fs::path(dir) / ".git", ec);
    }

    // Remove a checkout directory wholesale so the next Sync re-clones from
    // scratch. Used to recover from a corrupt/partial object store - the kind
    // that makes `git checkout <sha>` die with "unable to read tree".
    static bool WipeCheckout(const std::string& dir, const GitLog& log)
    {
        std::error_code ec;
        fs::remove_all(dir, ec);
        if (ec)
        {
            if (log) log(true, "could not remove " + dir + ": " + ec.message());
            return false;
        }
        return true;
    }

    static bool Clone(const std::string& url, const std::string& dir,
                      const GitLog& log, const std::string& authToken)
    {
        std::error_code ec;
        fs::create_directories(fs::path(dir).parent_path(), ec);
        if (log) log(false, "Cloning " + url + " -> " + dir);
        if (RunGit({ "clone", url, dir }, ".", log, nullptr, authToken) != 0)
        {
            if (log) log(true, "git clone failed for " + url);
            return false;
        }
        return true;
    }

    bool GitRepo::Sync(const std::string& url, const std::string& dir,
                       const std::string& branch, const std::string& commit, const GitLog& log,
                       const std::string& authToken, bool clean)
    {
        if (!HasCheckout(dir))
        {
            if (!Clone(url, dir, log, authToken)) return false;
        }
        else
        {
            if (log) log(false, "Fetching " + dir);
            // A failed fetch is not fatal on its own - the wanted commit may
            // already be local - but it is the usual cause of a later
            // "unable to read tree", so surface it instead of swallowing it.
            if (RunGit({ "fetch", "--all", "--prune" }, dir, log, nullptr, authToken) != 0)
                if (log) log(true, "fetch failed for " + dir + " (continuing; checkout may still succeed or trigger a re-fetch)");
        }

        if (!commit.empty())
        {
            // The pinned commit can be missing for two reasons: a `fetch --all`
            // only pulls ref tips, so a commit that is not at a branch head is
            // absent; or an interrupted fetch left a partial object store. Try
            // an explicit fetch-by-sha (GitHub allows it), then as a last resort
            // re-clone, before giving up.
            if (RunGit({ "checkout", commit }, dir, log) != 0)
            {
                if (log) log(false, "checkout " + commit.substr(0, 12) + " failed; fetching the commit explicitly...");
                RunGit({ "fetch", "origin", commit }, dir, log, nullptr, authToken);
                if (RunGit({ "checkout", commit }, dir, log) != 0)
                {
                    if (log) log(true, "commit " + commit.substr(0, 12) + " still not checkoutable; re-cloning " + dir);
                    if (!WipeCheckout(dir, log) || !Clone(url, dir, log, authToken))
                        return false;
                    RunGit({ "fetch", "origin", commit }, dir, log, nullptr, authToken);
                    if (RunGit({ "checkout", commit }, dir, log) != 0)
                    {
                        if (log) log(true, "git checkout " + commit + " failed (commit not on the remote?)");
                        return false;
                    }
                }
            }
            // Force the working tree to match the commit. A plain checkout does
            // NOT restore tracked files deleted out-of-band (e.g. macOS purging a
            // /tmp workspace) because the index still believes they're present -
            // leaving a checkout that's missing the build script and fails at
            // "no such file". reset --hard rewrites the worktree unconditionally,
            // so a reused-but-emptied workspace self-heals. (The branch path below
            // already does this; the pinned-commit path must too.)
            RunGit({ "reset", "--hard", commit }, dir, log);
        }
        else if (!branch.empty())
        {
            if (RunGit({ "checkout", branch }, dir, log) != 0 ||
                RunGit({ "reset", "--hard", "origin/" + branch }, dir, log) != 0)
            {
                // A broken object store fails both; recover by re-cloning.
                if (log) log(true, "checkout of " + branch + " failed; re-cloning " + dir);
                if (!WipeCheckout(dir, log) || !Clone(url, dir, log, authToken)) return false;
                RunGit({ "checkout", branch }, dir, log);
                RunGit({ "reset", "--hard", "origin/" + branch }, dir, log);
            }
        }

        // Bring submodules up to the checked-out commit. Many repos keep their
        // dependencies as submodules and expect a recursive checkout; a plain
        // clone leaves those dirs empty and the build fails. --init pulls in
        // newly-added submodules, --recursive handles nested ones. No-op (and
        // harmless) for repos without submodules.
        RunGit({ "submodule", "update", "--init", "--recursive" }, dir, log, nullptr, authToken);

        // Clean build: purge untracked AND ignored files (the build caches a normal
        // reset leaves behind - e.g. a Unity Library/ or IL2CPP intermediates that
        // poison a Mono->IL2CPP switch). -ffdx removes them while leaving the .git
        // clone and registered submodules (tracked entries) intact; the foreach line
        // scrubs the same junk inside each submodule's working tree. Best-effort:
        // a locked file shouldn't fail the build - the reset above already made the
        // tracked tree correct.
        if (clean)
        {
            if (log) log(false, "Clean build: purging untracked + ignored files");
            if (RunGit({ "clean", "-ffdx" }, dir, log) != 0 && log)
                log(true, "git clean -ffdx reported errors (continuing)");
            RunGit({ "submodule", "foreach", "--recursive", "git clean -ffdx" }, dir, log);
        }
        return true;
    }

    bool GitRepo::Gc(const std::string& dir, const GitLog& log)
    {
        if (!HasCheckout(dir)) return false;
        // Repack loose objects and drop now-unreachable ones (old branch tips
        // pruned by fetch). Reclaims git history bloat; does not touch the
        // working tree (build outputs are reclaimed by evicting the workspace).
        return RunGit({ "gc", "--prune=now", "--quiet" }, dir, log) == 0;
    }

    std::string GitRepo::FetchRemoteSha(const std::string& dir, const std::string& branch)
    {
        RunGit({ "fetch", "--all", "--prune" }, dir, nullptr);
        std::string out;
        if (RunGit({ "rev-parse", "origin/" + branch }, dir, nullptr, &out) != 0) return "";
        return Trim(out);
    }

    bool GitRepo::ReadFileAtRef(const std::string& dir, const std::string& ref,
                                const std::string& path, std::string& out)
    {
        out.clear();
        if (dir.empty() || ref.empty() || path.empty()) return false;
        return RunGit({ "show", ref + ":" + path }, dir, nullptr, &out) == 0;
    }

    std::string GitRepo::HeadSha(const std::string& dir)
    {
        std::string out;
        if (RunGit({ "rev-parse", "HEAD" }, dir, nullptr, &out) != 0) return "";
        return Trim(out);
    }

    bool GitRepo::CommitAuthor(const std::string& dir, const std::string& commit,
                               std::string& nameOut, std::string& emailOut)
    {
        nameOut.clear(); emailOut.clear();
        if (dir.empty() || commit.empty()) return false;
        std::string out;
        if (RunGit({ "log", "-1", "--format=%an%x09%ae", commit }, dir, nullptr, &out) != 0) return false;
        std::string line = Trim(out);
        size_t tab = line.find('\t');
        if (tab == std::string::npos) { nameOut = line; return !line.empty(); }
        nameOut = Trim(line.substr(0, tab));
        emailOut = Trim(line.substr(tab + 1));
        return !nameOut.empty() || !emailOut.empty();
    }
}
