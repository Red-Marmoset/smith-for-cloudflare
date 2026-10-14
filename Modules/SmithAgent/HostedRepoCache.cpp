// HostedRepoCache.cpp
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "HostedRepoCache.h"
#include "HostedPlatform.h"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <mutex>

namespace fs = std::filesystem;

namespace Smith
{
    namespace
    {
        std::string LowerText(std::string text)
        {
            std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return (char)std::tolower(c); });
            return text;
        }

        std::string TrimText(const std::string& text)
        {
            const auto first = text.find_first_not_of(" \t\r\n");
            if (first == std::string::npos) return "";
            const auto last = text.find_last_not_of(" \t\r\n");
            return text.substr(first, last - first + 1);
        }

        bool HasScheme(const std::string& url)
        {
            const auto colon = url.find("://");
            if (colon == std::string::npos || colon == 0) return false;
            return std::all_of(url.begin(), url.begin() + colon, [](unsigned char c) { return std::isalnum(c) || c == '+' || c == '-' || c == '.'; });
        }

        std::mutex& RegistryMutex() { static std::mutex m; return m; }
        std::map<std::string, std::shared_ptr<std::mutex>>& Registry() { static std::map<std::string, std::shared_ptr<std::mutex>> r; return r; }

        struct CacheLock : HostedRepoCacheLock
        {
            std::shared_ptr<std::mutex> mutex;
            explicit CacheLock(std::shared_ptr<std::mutex> m) : mutex(std::move(m)) { mutex->lock(); }
            ~CacheLock() override { mutex->unlock(); }
        };

        bool Usable(const fs::path& cache)
        {
            std::error_code ec;
            return fs::is_regular_file(cache / "HEAD", ec) && fs::is_directory(cache / "objects", ec) && fs::is_regular_file(cache / "config", ec);
        }

        bool Create(const fs::path& cache, const std::string& url, const HostedGitRunFn& run, std::vector<std::string>* gitErrors)
        {
            std::error_code ec;
            fs::remove_all(cache, ec);
            // The agent's root exists in production; a fresh root (as in the tests) is made here too, private like the rest.
            HostedSecureDirectory(cache.parent_path().parent_path().string());
            HostedSecureDirectory(cache.parent_path().string());
            HostedSecureDirectory(cache.string());
            const std::map<std::string, std::string> noEnv;
            // A bare mirror: every remote ref lands under the same name, so a local
            // clone sees the remote's branches and tags as its own. Automatic gc is off
            // because a repack while another clone hard-links the packs is the one
            // thing that could make a shared store unsafe; the store only grows by
            // what the remote adds.
            if (run({"git", "init", "--bare", "--quiet", "--", cache.string()}, cache.parent_path(), noEnv, nullptr, gitErrors) != 0) return false;
            if (run({"git", "remote", "add", "origin", "--", url}, cache, noEnv, nullptr, gitErrors) != 0) return false;
            // Branches and tags only (not GitHub's refs/pull/*): what a checkout can name.
            if (run({"git", "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"}, cache, noEnv, nullptr, gitErrors) != 0) return false;
            if (run({"git", "config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"}, cache, noEnv, nullptr, gitErrors) != 0) return false;
            if (run({"git", "config", "gc.auto", "0"}, cache, noEnv, nullptr, gitErrors) != 0) return false;
            std::ofstream(cache / "source", std::ios::binary) << url << '\n';   // for a person looking at the directory
            return Usable(cache);
        }

        bool HasCommit(const fs::path& cache, const std::string& commit, const HostedGitRunFn& run)
        {
            return run({"git", "cat-file", "-e", commit + "^{commit}"}, cache, {}, nullptr, nullptr) == 0;
        }

        // Point the mirror's HEAD at the remote's default branch, so a clone made
        // without `--branch` starts where a clone of the remote would.
        void SyncHead(const fs::path& cache, const std::map<std::string, std::string>& gitEnv, const HostedGitRunFn& run)
        {
            std::vector<std::string> lines;
            if (run({"git", "ls-remote", "--symref", "origin", "HEAD"}, cache, gitEnv, &lines, nullptr) != 0) return;
            for (const auto& line : lines)
            {
                // "ref: refs/heads/main\tHEAD"
                if (line.rfind("ref: ", 0) != 0) continue;
                const auto tab = line.find('\t');
                const auto ref = TrimText(line.substr(5, tab == std::string::npos ? std::string::npos : tab - 5));
                if (ref.rfind("refs/heads/", 0) == 0 && ref.find("..") == std::string::npos)
                    run({"git", "symbolic-ref", "HEAD", ref}, cache, {}, nullptr, nullptr);
                return;
            }
        }

        bool Fetch(const fs::path& cache, const std::string& commit, const std::map<std::string, std::string>& gitEnv,
                   const HostedGitRunFn& run, std::vector<std::string>* gitErrors)
        {
            if (run({"git", "fetch", "--prune", "--quiet", "origin"}, cache, gitEnv, nullptr, gitErrors) != 0) return false;
            if (!commit.empty() && !HasCommit(cache, commit, run) &&
                run({"git", "fetch", "--quiet", "origin", commit}, cache, gitEnv, nullptr, gitErrors) != 0) return false;
            SyncHead(cache, gitEnv, run);
            return true;
        }
    }

    std::string HostedCanonicalRepoUrl(const std::string& raw)
    {
        std::string url = TrimText(raw);
        if (url.empty()) return url;
        // scp-style "user@host:path" (no scheme, a ':' before any '/') -> ssh://user@host/path
        if (!HasScheme(url))
        {
            const auto colon = url.find(':'), slash = url.find('/');
            const auto at = url.find('@');
            if (colon != std::string::npos && colon > 0 && (slash == std::string::npos || colon < slash) &&
                !(colon == 1 && std::isalpha((unsigned char)url[0])) &&   // not a Windows drive
                at != std::string::npos && at < colon)
                url = "ssh://" + url.substr(0, colon) + "/" + url.substr(colon + 1);
            else
            {   // a local path: compared as written, bar a trailing separator
                while (url.size() > 1 && (url.back() == '/' || url.back() == '\\')) url.pop_back();
                return url;
            }
        }
        const auto schemeEnd = url.find("://");
        std::string scheme = LowerText(url.substr(0, schemeEnd));
        std::string rest = url.substr(schemeEnd + 3);
        const auto pathStart = rest.find('/');
        std::string authority = pathStart == std::string::npos ? rest : rest.substr(0, pathStart);
        std::string path = pathStart == std::string::npos ? "" : rest.substr(pathStart);
        const auto at = authority.rfind('@');
        if (at != std::string::npos) authority = authority.substr(at + 1);   // userinfo never identifies a repository
        authority = LowerText(authority);
        while (!path.empty() && path.back() == '/') path.pop_back();
        if (path.size() > 4 && path.compare(path.size() - 4, 4, ".git") == 0) path.resize(path.size() - 4);
        while (!path.empty() && path.back() == '/') path.pop_back();
        const bool github = authority == "github.com" || authority == "www.github.com";
        if (github) path = LowerText(path);
        return scheme + "://" + authority + path;
    }

    fs::path HostedRepoCachePath(const fs::path& root, const std::string& url)
    {
        return root / "repos" / (HostedSha256(HostedCanonicalRepoUrl(url)) + ".git");
    }

    bool HostedRepoCacheExists(const fs::path& root, const std::string& url)
    {
        return Usable(HostedRepoCachePath(root, url));
    }

    std::unique_ptr<HostedRepoCacheLock> HostedLockRepoCache(const fs::path& cache)
    {
        std::shared_ptr<std::mutex> mutex;
        {
            std::lock_guard<std::mutex> guard(RegistryMutex());
            auto& slot = Registry()[cache.lexically_normal().string()];
            if (!slot) slot = std::make_shared<std::mutex>();
            mutex = slot;
        }
        return std::make_unique<CacheLock>(std::move(mutex));
    }

    bool HostedUpdateRepoCache(const fs::path& cache, const std::string& url, const std::string& commit,
                               const std::map<std::string, std::string>& gitEnv, const HostedGitRunFn& run,
                               std::vector<std::string>* gitErrors)
    {
        const bool fresh = !Usable(cache);
        if (fresh && !Create(cache, url, run, gitErrors)) return false;
        if (Fetch(cache, commit, gitEnv, run, gitErrors)) return true;
        // A store that never held the repository is not kept: a later scan of it would take the
        // store for a filled one instead of its cheap shallow look.
        if (fresh) { std::error_code ec; fs::remove_all(cache, ec); return false; }
        // A refused remote (no access, no such repository, no network) reads the
        // same from a fresh mirror, so only a mirror Git itself rejects is rebuilt:
        // the second attempt's errors are the ones reported either way.
        bool broken = false;
        for (const auto& line : gitErrors ? *gitErrors : std::vector<std::string>())
            broken = broken || line.find("not a git repository") != std::string::npos || line.find("fatal: bad object") != std::string::npos ||
                     line.find("is corrupt") != std::string::npos || line.find("could not parse object") != std::string::npos ||
                     line.find("does not have a valid HEAD") != std::string::npos || line.find("'origin' does not appear") != std::string::npos;
        if (!broken) return false;
        if (gitErrors) gitErrors->clear();
        if (!Create(cache, url, run, gitErrors)) return false;
        if (Fetch(cache, commit, gitEnv, run, gitErrors)) return true;
        std::error_code ec; fs::remove_all(cache, ec); return false;
    }

    bool HostedCloneFromRepoCache(const fs::path& cache, const std::string& url, const std::string& branch,
                                  const fs::path& checkout, const HostedGitRunFn& run, std::vector<std::string>* gitErrors)
    {
        std::error_code ec;
        fs::create_directories(checkout.parent_path(), ec);
        std::vector<std::string> clone = {"git", "clone", "--no-checkout", "--quiet"};
        if (!branch.empty()) { clone.push_back("--branch"); clone.push_back(branch); }
        clone.insert(clone.end(), {"--", cache.string(), checkout.string()});
        if (run(clone, checkout.parent_path(), {}, nullptr, gitErrors) != 0) return false;
        // The clone's remote is the mirror; the real remote takes its place so the
        // checkout never depends on the cache again and credentials target the
        // right origin.
        return run({"git", "remote", "set-url", "origin", "--", url}, checkout, {}, nullptr, gitErrors) == 0;
    }
}
