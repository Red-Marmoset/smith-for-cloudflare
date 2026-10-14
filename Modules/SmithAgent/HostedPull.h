#pragma once
// Smith's own pull requests on a hosted agent: the pure parts of the "diff", "merge" and "publish"
// jobs (HostedAgent.cpp runs the git commands). A diff reports what a branch changes against the
// branch it merges into and whether it merges cleanly; a merge commits it into that branch and pushes
// it (never forced); a publish pushes the head to another remote (a GitHub origin, for a pull request
// there) with this machine's own Git login.
#include <SmithProtocol/WireTypes.h>
#include <string>
#include <vector>
namespace Smith {
    bool HostedPullKind(const std::string& kind);
    // Pure: why a pull job's spec is refused ("" when it is acceptable). Every other kind must leave `pull` empty.
    std::string ValidateHostedPull(const JobSpec& spec);
    // What `git merge-tree --write-tree --name-only --no-messages <base> <head>` said: exit 0 merges cleanly, 1 has
    // conflicts (the first line is the tree, then one conflicted path per line), anything else (an older git without
    // --write-tree) is unknown.
    struct HostedMergeCheck { int mergeable = -1; std::vector<std::string> conflicts; };   // 1 yes, 0 no, -1 unknown
    HostedMergeCheck HostedParseMergeTree(int exitCode, const std::vector<std::string>& lines);
    // The diff a pull request shows, as the files Smith uploads. The patch is cut at `maxBytes` on a line boundary.
    inline constexpr const char* kHostedPullPatch = "pull.patch";
    inline constexpr const char* kHostedPullFiles = "pull-files.txt";
    struct HostedPullPatch { std::string text; bool truncated = false; };
    HostedPullPatch HostedPullPatchText(const std::string& mergeBase, const std::string& head, const std::string& diff, size_t maxBytes);
    std::string HostedPullFilesText(const std::string& mergeBase, const std::string& head, const std::vector<std::string>& numstat);
    // git's arguments for the merge commit: author and committer are who pressed Merge, never the machine's own identity.
    std::vector<std::string> HostedPullMergeArgs(const PullSpec& pull, const std::string& head);
}
