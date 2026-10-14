#include "HostedPull.h"
#include "HostedAgent.h"
#include <algorithm>
#include <regex>
namespace Smith {
    namespace {
        bool BranchValid(const std::string& branch)
        {
            return !branch.empty() && branch.size() <= 256 && branch.find("..") == std::string::npos && branch.back() != '/' && branch.back() != '.' &&
                std::regex_match(branch, std::regex("[A-Za-z0-9][A-Za-z0-9/_.-]*")) && branch.find(".lock") == std::string::npos;
        }
        bool Printable(const std::string& text, bool newlines)
        {
            return std::none_of(text.begin(), text.end(), [&](char c) { const auto u = static_cast<unsigned char>(c); return u == 0 || u == 0x7f || (u < 0x20 && !(newlines && (c == '\n' || c == '\t'))); });
        }
        // An https:// or ssh:// URL, or scp-style user@host:path, without credentials or whitespace.
        bool RemoteValid(const std::string& url)
        {
            if (url.empty() || url.size() > 512 || url.find_first_of(" \t\r\n\\") != std::string::npos || !Printable(url, false)) return false;
            if (url.rfind("https://", 0) == 0) return url.substr(8, url.find('/', 8) - 8).find('@') == std::string::npos && url.find('/', 8) != std::string::npos;
            if (url.rfind("ssh://", 0) == 0) return url.find('/', 6) != std::string::npos;
            return std::regex_match(url, std::regex("[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/@][^@]*"));
        }
    }
    bool HostedPullKind(const std::string& kind) { return kind == "diff" || kind == "merge" || kind == "publish"; }

    std::string ValidateHostedPull(const JobSpec& spec)
    {
        const auto& p = spec.pull;
        if (!HostedPullKind(spec.kind)) {
            const bool empty = p.baseBranch.empty() && p.message.empty() && p.authorName.empty() && p.authorEmail.empty() && p.targetRemote.empty() && p.targetBranch.empty();
            return empty ? "" : "Only pull request jobs may carry a pull request";
        }
        if (spec.repos.size() != 1) return "A pull request job works on exactly one repository";
        if (!std::regex_match(spec.repos[0].commit, std::regex("[a-f0-9]{40}"))) return "A pull request job needs the head's full commit";
        if (!spec.steps.empty() || !spec.resolve.action.empty() || !spec.mirror.remote.empty()) return "A pull request job runs no build";
        if (spec.kind != "publish" && !BranchValid(p.baseBranch)) return "Invalid pull request base branch";
        if (spec.kind == "merge") {
            if (p.message.empty() || p.message.size() > 4000 || !Printable(p.message, true)) return "Invalid merge message";
            if (p.authorName.empty() || p.authorName.size() > 128 || !Printable(p.authorName, false) || p.authorName.find_first_of("<>") != std::string::npos) return "Invalid merge author";
            if (!std::regex_match(p.authorEmail, std::regex("[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}"))) return "Invalid merge author email";
        } else if (!p.message.empty() || !p.authorName.empty() || !p.authorEmail.empty()) return "Only a merge carries a merge message";
        if (spec.kind == "publish") {
            // The head goes out with this machine's own Git login: never with a Smith token, never to Smith's own copy.
            if (!RemoteValid(p.targetRemote) || HostedArtifactsRemote(p.targetRemote) || HostedSmithRemote(p.targetRemote)) return "A publish needs a Git remote other than Smith's copy";
            if (p.targetRemote == spec.repos[0].url) return "A publish must go to another remote";
            if (!BranchValid(p.targetBranch)) return "Invalid publish branch";
        } else if (!p.targetRemote.empty() || !p.targetBranch.empty()) return "Only a publish carries a target remote";
        const auto& globs = spec.artifacts.globs;
        const bool diffFiles = globs.size() == 2 && globs[0] == kHostedPullPatch && globs[1] == kHostedPullFiles;
        if (spec.kind == "diff" ? !diffFiles : !globs.empty()) return "A pull request job uploads only its diff";
        return "";
    }

    HostedMergeCheck HostedParseMergeTree(int exitCode, const std::vector<std::string>& lines)
    {
        HostedMergeCheck check;
        if (exitCode == 0) { check.mergeable = 1; return check; }
        if (exitCode != 1 || lines.empty() || !std::regex_match(lines[0], std::regex("[a-f0-9]{40}([a-f0-9]{24})?"))) return check;
        check.mergeable = 0;
        for (size_t i = 1; i < lines.size() && check.conflicts.size() < 50; ++i)
            if (!lines[i].empty() && lines[i].size() <= 512 && Printable(lines[i], false) && std::find(check.conflicts.begin(), check.conflicts.end(), lines[i]) == check.conflicts.end())
                check.conflicts.push_back(lines[i]);
        return check;
    }

    HostedPullPatch HostedPullPatchText(const std::string& mergeBase, const std::string& head, const std::string& diff, size_t maxBytes)
    {
        // The header keeps the file non-empty (an upload needs at least a byte) and says what was compared.
        HostedPullPatch patch{"# smith pull diff " + (mergeBase.empty() ? std::string("(no common history)") : mergeBase) + ".." + head + "\n", false};
        if (patch.text.size() + diff.size() <= maxBytes) { patch.text += diff; return patch; }
        const size_t room = maxBytes > patch.text.size() ? maxBytes - patch.text.size() : 0;
        const size_t cut = diff.rfind('\n', room);
        patch.text += diff.substr(0, cut == std::string::npos ? 0 : cut + 1);
        patch.truncated = true;
        return patch;
    }

    std::string HostedPullFilesText(const std::string& mergeBase, const std::string& head, const std::vector<std::string>& numstat)
    {
        std::string text = "# smith pull files " + (mergeBase.empty() ? std::string("(no common history)") : mergeBase) + ".." + head + "\n";
        size_t kept = 0;
        for (const auto& line : numstat) {
            if (kept >= 20000 || text.size() + line.size() > 2 * 1024 * 1024) break;
            if (!line.empty()) { text += line; text += '\n'; ++kept; }
        }
        if (kept < numstat.size()) text += "# truncated\n";
        return text;
    }

    std::vector<std::string> HostedPullMergeArgs(const PullSpec& pull, const std::string& head)
    {
        return {"git", "-c", "user.name=" + pull.authorName, "-c", "user.email=" + pull.authorEmail, "-c", "commit.gpgsign=false",
                "merge", "--no-ff", "--no-edit", "-m", pull.message, head};
    }
}
