#include "HostedImport.h"
#include "HostedAgent.h"
#include <json/single_include/nlohmann/json.hpp>
#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <map>
namespace Smith {
    std::vector<HostedImportBlob> HostedImportLargeBlobs(const std::vector<std::string>& lines, int64_t threshold)
    {
        std::map<std::string, HostedImportBlob> byPath;
        for (const auto& line : lines) {
            const auto firstSpace = line.find(' '); if (firstSpace == std::string::npos) continue;
            const auto secondSpace = line.find(' ', firstSpace + 1); if (secondSpace == std::string::npos) continue;   // no path: a commit or tree
            char* end = nullptr; const long long size = std::strtoll(line.c_str(), &end, 10);
            if (end != line.c_str() + firstSpace || size <= threshold) continue;
            const std::string oid = line.substr(firstSpace + 1, secondSpace - firstSpace - 1), path = line.substr(secondSpace + 1);
            if (oid.size() != 40 || path.empty()) continue;
            auto& blob = byPath[path];
            if (size > blob.size) blob = HostedImportBlob{size, oid, path};
        }
        std::vector<HostedImportBlob> out; for (auto& [path, blob] : byPath) out.push_back(blob);
        return out;
    }
    std::vector<std::string> HostedImportMigrateArgv(int64_t thresholdBytes)
    {
        return {"git", "lfs", "migrate", "import", "--everything", "--yes", "--above=" + std::to_string(thresholdBytes) + "b"};
    }
    std::vector<std::string> HostedImportSlices(const std::vector<std::string>& revListReverse, size_t batch)
    {
        std::vector<std::string> out; if (batch == 0) batch = 1;
        for (size_t i = batch - 1; i < revListReverse.size(); i += batch) out.push_back(revListReverse[i]);
        if (!revListReverse.empty() && (out.empty() || out.back() != revListReverse.back())) out.push_back(revListReverse.back());
        return out;
    }
    int64_t HostedImportStoreBytes(const std::vector<std::string>& lines)
    {
        int64_t kib = 0;
        for (const auto& line : lines) {
            const auto colon = line.find(':'); if (colon == std::string::npos) continue;
            const auto key = line.substr(0, colon);
            if (key == "size" || key == "size-pack") kib += std::strtoll(line.c_str() + colon + 1, nullptr, 10);
        }
        return kib * 1024;
    }
    std::string HostedImportReportJson(const HostedImportOutcome& o)
    {
        nlohmann::json j{{"commit", o.commit}, {"branch", o.branch}, {"scan", nlohmann::json::parse(o.scanJson.empty() ? "{}" : o.scanJson)}, {"rewritten", o.rewritten},
                         {"movedFiles", o.movedFiles}, {"movedBytes", o.movedBytes}, {"lfsObjects", o.lfsObjects}, {"lfsBytes", o.lfsBytes}};
        if (o.bundleSize > 0 && !o.bundleSha256.empty()) j["originalBundle"] = {{"size", o.bundleSize}, {"sha256", o.bundleSha256}};
        return j.dump();
    }

    namespace {
        namespace fs = std::filesystem;
        // Every git the import runs after the clone: no prompt, no credential window, no system or user config (so none of
        // the person's credential helpers or hooks), no smudging of pointers.
        std::map<std::string, std::string> Isolated(std::map<std::string, std::string> env, const std::string& globalConfig)
        {
            env.emplace("GIT_TERMINAL_PROMPT", "0"); env.emplace("GCM_INTERACTIVE", "never"); env.emplace("GIT_CONFIG_NOSYSTEM", "1"); env.emplace("GIT_LFS_SKIP_SMUDGE", "1");
            env["GIT_CONFIG_GLOBAL"] = globalConfig;
            return env;
        }
        // The machine's own login for the source (the only steps that may use it): prompts and credential windows off.
        std::map<std::string, std::string> OwnLogin(const std::string& source)
        {
            auto env = HostedGitAuthEnv(source, ""); env["GCM_INTERACTIVE"] = "never"; env["GIT_LFS_SKIP_SMUDGE"] = "1"; return env;
        }
        int64_t FilesUnder(const fs::path& dir, int64_t& bytes)
        {
            int64_t files = 0; bytes = 0; std::error_code ec;
            fs::recursive_directory_iterator it(dir, ec);
            for (; !ec && it != fs::recursive_directory_iterator(); it.increment(ec)) if (it->is_regular_file(ec)) { ++files; bytes += (int64_t)it->file_size(ec); }
            return files;
        }
        std::string Because(const std::vector<std::string>& errors) { const auto reason = HostedGitFailureReason(errors); return reason.empty() ? std::string() : ": " + reason; }
        std::string Mib(int64_t bytes) { return std::to_string(bytes / (1024 * 1024)) + " MiB"; }
        void Chomp(std::string& line) { if (!line.empty() && line.back() == '\r') line.pop_back(); }
    }

    HostedImportResult RunHostedImport(const HostedImportRequest& request, const HostedImportRun& run, const HostedImportLog& log, const HostedImportUpload& upload, bool lfsAvailable)
    {
        HostedImportResult result;
        auto fail = [&](const std::string& message, const std::string& failure = std::string()) { result.ok = false; result.message = message; result.failure = failure; return result; };
        const fs::path scratch = request.scratch; const std::string mirror = (scratch / "repo.git").string();
        const std::string globalConfig = (scratch / "empty.gitconfig").string(); { std::ofstream(globalConfig) << ""; }
        const auto isolated = Isolated({}, globalConfig);
        auto git = [&](std::vector<std::string> args, std::vector<std::string>* out = nullptr, std::vector<std::string>* err = nullptr, std::map<std::string, std::string> env = {}, const std::string& stdoutFile = std::string()) {
            args.insert(args.begin(), {"git", "--git-dir=" + mirror}); return run(args, scratch.string(), Isolated(std::move(env), globalConfig), out, err, stdoutFile);
        };
        std::vector<std::string> lines, errors;
        // 1. A bare clone of the source (its branches and tags; not a mirror, which would carry a host's pull-request refs too).
        log("Copying " + request.source);
        if (run({"git", "clone", "--bare", "--", request.source, mirror}, scratch.string(), OwnLogin(request.source), nullptr, &errors, "") != 0)
            return fail("Repository copy failed" + Because(errors), HostedClassifyGitFailure(errors));
        // The default branch: the source's HEAD, else main when present, else the first branch.
        std::string branch; if (git({"symbolic-ref", "--short", "HEAD"}, &lines) == 0 && !lines.empty()) branch = lines[0];
        lines.clear(); if (git({"for-each-ref", "--format=%(refname:short)", "refs/heads/"}, &lines) != 0) return fail("Could not list the repository's branches");
        if (branch.empty() || std::find(lines.begin(), lines.end(), branch) == lines.end()) branch = std::find(lines.begin(), lines.end(), "main") != lines.end() ? "main" : lines.empty() ? std::string() : lines[0];
        if (branch.empty()) return fail("The repository has no branches");
        // 2. Measure. Over the limit with nothing to move to large files is oversize at once (the coordinator keeps it on a
        // machine instead); with files to move, the rewrite decides (a repository of large binaries shrinks to fit).
        auto storeBytes = [&](int64_t& bytes) { std::vector<std::string> counts; if (git({"count-objects", "-v"}, &counts) != 0) return false; bytes = HostedImportStoreBytes(counts); return true; };
        int64_t bytes = 0; if (!storeBytes(bytes)) return fail("Repository size check failed");
        // 3. Blobs over the threshold anywhere in history: every blob's size (one listing, to a file), then the paths of the
        // ones over the threshold from the reachable objects (another file); a repository can hold more objects than the
        // runner keeps lines.
        const std::string sizesFile = (scratch / "sizes.txt").string(), objectsFile = (scratch / "objects.txt").string();
        if (git({"cat-file", "--batch-all-objects", "--unordered", "--batch-check=%(objectsize) %(objectname) %(objecttype)"}, nullptr, nullptr, {}, sizesFile) != 0) return fail("Could not measure the repository's files");
        if (git({"rev-list", "--objects", "--all"}, nullptr, nullptr, {}, objectsFile) != 0) return fail("Could not list the repository's objects");
        std::map<std::string, int64_t> over;
        {
            std::ifstream in(sizesFile); std::string line;
            while (std::getline(in, line)) {
                Chomp(line);
                const auto s1 = line.find(' '); const auto s2 = s1 == std::string::npos ? std::string::npos : line.find(' ', s1 + 1);
                if (s2 == std::string::npos || line.compare(s2 + 1, std::string::npos, "blob") != 0) continue;
                const long long size = std::strtoll(line.c_str(), nullptr, 10);
                if (size > request.thresholdBytes) over[line.substr(s1 + 1, s2 - s1 - 1)] = size;
            }
        }
        std::vector<std::string> sized;
        if (!over.empty()) {
            std::ifstream in(objectsFile); std::string line;
            while (std::getline(in, line)) {
                Chomp(line);
                const auto space = line.find(' '); if (space == std::string::npos) continue;
                const auto it = over.find(line.substr(0, space)); if (it != over.end()) sized.push_back(std::to_string(it->second) + " " + line);
            }
        }
        const auto large = HostedImportLargeBlobs(sized, request.thresholdBytes);
        if (request.maxRepoBytes > 0 && bytes > request.maxRepoBytes && large.empty()) { result.oversize = true; return fail("Repository is " + Mib(bytes) + ", over the " + Mib(request.maxRepoBytes) + " limit for Smith's storage", "oversize"); }
        // 4. Large files the repository already keeps in LFS: every object ever referenced, so nothing stays behind at the source.
        lines.clear();
        if (lfsAvailable && git({"lfs", "ls-files", "--all", "--name-only"}, &lines) == 0 && !lines.empty()) {
            log("Fetching the repository's existing large files");
            errors.clear();
            if (run({"git", "--git-dir=" + mirror, "lfs", "fetch", "--all", "origin"}, scratch.string(), OwnLogin(request.source), nullptr, &errors, "") != 0)
                return fail("Could not fetch the repository's existing large files from its source" + Because(errors), HostedClassifyGitFailure(errors));
        }
        if (!large.empty()) {
            if (!lfsAvailable) return fail(std::to_string(large.size()) + " file(s) are over the threshold and git-lfs is not installed on this machine, so they cannot move to large files");
            // 5. The original history first (as a bundle git can restore from), then the rewrite.
            const fs::path bundle = scratch / "original.bundle";
            log("Keeping the original history: " + std::to_string(large.size()) + " file(s) over the threshold will move to large files");
            if (git({"bundle", "create", "--quiet", bundle.string(), "--all"}) != 0) return fail("Could not bundle the original history");
            std::string sha256; std::error_code ec; const int64_t size = (int64_t)fs::file_size(bundle, ec);
            if (ec || size <= 0 || !upload(bundle.string(), size, sha256)) return fail("Could not store the original history; nothing was rewritten");
            result.outcome.bundleSize = size; result.outcome.bundleSha256 = sha256;
            fs::remove(bundle, ec);
            log("Moving files over the threshold to large files (rewriting history)");
            errors.clear();
            auto migrate = HostedImportMigrateArgv(request.thresholdBytes); migrate.insert(migrate.begin() + 1, "--git-dir=" + mirror);
            if (run(migrate, scratch.string(), isolated, nullptr, &errors, "") != 0) {
                // A git-lfs that will not rewrite a bare repository: a working copy with every ref, rewritten there and pushed back.
                log("Rewriting in a working copy" + Because(errors));
                const std::string work = (scratch / "work").string(); errors.clear();
                if (run({"git", "clone", "--quiet", "--", mirror, work}, scratch.string(), isolated, nullptr, &errors, "") != 0) return fail("Could not prepare the rewrite" + Because(errors));
                if (run({"git", "fetch", "--quiet", "--update-head-ok", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"}, work, isolated, nullptr, &errors, "") != 0) return fail("Could not prepare the rewrite" + Because(errors));
                if (run(HostedImportMigrateArgv(request.thresholdBytes), work, isolated, nullptr, &errors, "") != 0) return fail("Rewriting history failed" + Because(errors));
                if (run({"git", "push", "--quiet", "--no-verify", "--", mirror, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"}, work, isolated, nullptr, &errors, "") != 0) return fail("Could not place the rewritten history" + Because(errors));
                fs::copy(fs::path(work) / ".git" / "lfs" / "objects", fs::path(mirror) / "lfs" / "objects", fs::copy_options::recursive | fs::copy_options::skip_existing, ec);
                fs::remove_all(work, ec);
            }
            // The rewrite leaves the old commits behind: drop them, so the measure and the push see the new history only.
            git({"reflog", "expire", "--expire=now", "--all"});
            if (git({"gc", "--quiet", "--prune=now"}) != 0) return fail("Could not compact the rewritten repository");
            result.outcome.rewritten = true; result.outcome.movedFiles = (int64_t)large.size();
            for (const auto& blob : large) result.outcome.movedBytes += blob.size;
            if (!storeBytes(bytes)) return fail("Repository size check failed");
            if (request.maxRepoBytes > 0 && bytes > request.maxRepoBytes) { result.oversize = true; return fail("Repository is still " + Mib(bytes) + " after moving large files, over the " + Mib(request.maxRepoBytes) + " limit for Smith's storage", "oversize"); }
        }
        // The default branch's tip and its scan, after any rewrite.
        lines.clear(); if (git({"rev-parse", "refs/heads/" + branch}, &lines) != 0 || lines.empty()) return fail("Could not read the default branch");
        result.outcome.commit = lines[0]; result.outcome.branch = branch;
        std::vector<std::string> paths; if (git({"-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", result.outcome.commit}, &paths) != 0) return fail("Could not list the repository's files");
        std::vector<std::string> smith; const bool hasSmithJson = git({"show", result.outcome.commit + ":smith.json"}, &smith) == 0;
        std::string smithText; for (const auto& line : smith) { smithText += line; smithText += '\n'; }
        try { result.outcome.scanJson = HostedScanReport(result.outcome.commit, branch, hasSmithJson, smithText, paths); } catch (const std::exception& e) { return fail(e.what()); }
        // What the repository keeps in large files now: fetched ones and the moved ones alike.
        result.outcome.lfsObjects = FilesUnder(fs::path(mirror) / "lfs" / "objects", result.outcome.lfsBytes);
        // 6. Large files to Smith: every object for every ref, through lfs.url and the ticket (empty: the remote as given).
        if (result.outcome.lfsObjects > 0) {
            log("Sending " + std::to_string(result.outcome.lfsObjects) + " large file(s) to Smith");
            git({"remote", "remove", "smith"});
            if (git({"remote", "add", "smith", request.smithRemote}) != 0) return fail("Could not name Smith's large-file store as a remote");
            std::map<std::string, std::string> lfsEnv;
            if (!request.lfsTicket.empty()) { JobSpec ticket; ticket.lfs.url = request.smithRemote; ticket.lfs.authToken = request.lfsTicket; lfsEnv = HostedLfsEnv(ticket, HostedGitAuthEnv(request.smithRemote, request.lfsTicket)); }
            errors.clear();
            if (git({"lfs", "push", "--all", "smith"}, nullptr, &errors, lfsEnv) != 0) return fail("Could not send the large files to Smith" + Because(errors));
        }
        // 7. Git to Smith's storage: branches and tags; in slices when one push is refused for size (forced: a halving starts
        // again from the first commit, behind what an earlier slice already landed on a repository that is otherwise empty).
        // --no-verify: the rewrite installs git-lfs's pre-push hook, which would try to send the large files to the storage.
        log("Sending the repository to Smith's storage");
        const auto pushEnv = HostedGitAuthEnv(request.artifactsRemote, request.artifactsToken);
        errors.clear();
        if (git({"push", "--no-verify", "--", request.artifactsRemote, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"}, nullptr, &errors, pushEnv) != 0) {
            const auto reason = HostedGitFailureReason(errors);
            if (HostedClassifyGitFailure(errors) == "repo_access") return fail("Smith's storage refused the push" + Because(errors) + " (the write token may have lapsed); try again");
            log("One push was refused" + Because(errors) + "; sending the history in slices");
            lines.clear(); if (git({"for-each-ref", "--format=%(refname)", "refs/heads/"}, &lines) != 0) return fail("Could not list the branches to push");
            for (const auto& ref : lines) {
                std::vector<std::string> revs; if (git({"rev-list", "--reverse", ref}, &revs) != 0) return fail("Could not walk " + ref);
                for (size_t batch = 200; ; batch = batch / 2) {
                    bool pushed = true;
                    for (const auto& sha : HostedImportSlices(revs, batch)) { errors.clear(); if (git({"push", "--no-verify", "--", request.artifactsRemote, "+" + sha + ":" + ref}, nullptr, &errors, pushEnv) != 0) { pushed = false; break; } }
                    if (pushed) break;
                    if (batch <= 1) return fail("Smith's storage refused " + ref + " even one commit at a time" + Because(errors));
                }
            }
            errors.clear(); if (git({"push", "--no-verify", "--", request.artifactsRemote, "refs/tags/*:refs/tags/*"}, nullptr, &errors, pushEnv) != 0) return fail("Tag push failed" + Because(errors));
        }
        result.ok = true;
        result.message = result.outcome.rewritten ? "Imported; " + std::to_string(result.outcome.movedFiles) + " file(s) moved to large files" : "Imported";
        return result;
    }
}
