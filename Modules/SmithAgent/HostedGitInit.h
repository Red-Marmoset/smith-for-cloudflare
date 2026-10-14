// HostedGitInit.h - a project started in Smith rather than copied: the host job makes its first commit from
// nothing (a README) or from the files of an uploaded zip, then keeps the repository like any copy (HostedGitHost.h).
// The zip comes from a person's browser, so every entry name is checked before anything is written: no absolute
// paths, no "..", no names Windows cannot hold, no .git directories; one folder wrapping everything is unwrapped.
#pragma once
#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>
namespace Smith {
    constexpr const char* kHostedGitInitLabel = "smith-git-init";        // this host can also start a repository
    constexpr int64_t kHostedImportMaxEntries = 100000;
    constexpr int64_t kHostedImportMaxBytes = 4LL * 1024 * 1024 * 1024;  // unpacked; the repository's own cap applies after the commit

    // Pure: the folder every entry sits in ("game/" for game/a.txt, game/src/b.c), "" when entries differ or a file sits at the top.
    std::string HostedZipCommonRoot(const std::vector<std::string>& names);
    // Pure: where an entry goes, relative and '/'-separated, with `root` removed. "" (and `problem` empty) means skip it:
    // a directory entry, macOS metadata, anything inside a .git directory. A hostile or unportable name sets `problem`.
    std::string HostedZipEntryPath(const std::string& name, const std::string& root, std::string& problem);
    // Pure: the README of an empty project.
    std::string HostedGitInitReadme(const std::string& projectName);
    // Pure: the first commit's message.
    std::string HostedGitInitMessage(const std::string& kind, const std::string& projectName, const std::string& archiveName);
    // Unpacks `zipPath` into the existing empty directory `dir`. Returns "" on success or the reason it refused.
    std::string HostedExtractProjectZip(const std::string& zipPath, const std::string& dir, int64_t& files);

    // Everything the first commit needs. `zipPath` only for kind "zip"; `scratch` is a private directory for the
    // work tree, an empty git config and an empty hooks directory (the user's own git config and hooks never apply).
    struct HostedGitInitRequest { std::string kind, name, archiveName, branch, zipPath, scratch; };
    // Runs `git` with its full argv in a directory with extra environment; stderr lines into `errors`. Returns the exit code.
    using HostedGitInitRun = std::function<int(const std::vector<std::string>& argv, const std::string& cwd, const std::map<std::string, std::string>& env, std::vector<std::string>* errors)>;
    // Makes a repository with one commit on `branch` in <scratch>/work: a README, or the zip's files (its .gitignore
    // honoured). Returns "" and the work tree's path in `workTree`, or the reason it failed.
    std::string HostedGitInitWorkTree(const HostedGitInitRequest& request, const HostedGitInitRun& git, std::string& workTree);
}
