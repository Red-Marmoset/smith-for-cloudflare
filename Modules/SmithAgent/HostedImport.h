#pragma once
// Import from GitHub (hosted coordinator): one repository into Smith's storage with its large files in Git LFS. The pure
// pieces are tested without git; RunHostedImport runs the job's steps (spec §5) through a runner the agent (or a test)
// supplies: mirror-clone the source, measure, keep the original history as the job's blob, rewrite to LFS, push the
// objects to Smith and the git to Smith's storage, and report.
#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>

namespace Smith {
    // One "size oid path" line of `git cat-file --batch-check='%(objectsize) %(objectname) %(rest)'` over `git rev-list --objects --all`.
    struct HostedImportBlob { int64_t size = 0; std::string oid, path; };
    // Pure: blobs over `threshold`, one per path (the largest version), paths sorted. Lines without a path (commits, trees) are skipped.
    std::vector<HostedImportBlob> HostedImportLargeBlobs(const std::vector<std::string>& batchCheckLines, int64_t threshold);
    // Pure: the argv for `git lfs migrate import --everything --above=<threshold>`; `--yes` so no prompt waits.
    std::vector<std::string> HostedImportMigrateArgv(int64_t thresholdBytes);
    // Pure: oldest-first commits grouped into pushes of at most `batch` commits: the last SHA of each group.
    std::vector<std::string> HostedImportSlices(const std::vector<std::string>& revListReverse, size_t batch);
    // Pure: `git count-objects -v` lines summed (size + size-pack, KiB) into bytes.
    int64_t HostedImportStoreBytes(const std::vector<std::string>& countObjectsLines);
    // Pure: the `import` object of the completion.
    struct HostedImportOutcome { bool rewritten = false; std::string commit, branch, scanJson; int64_t movedFiles = 0, movedBytes = 0, lfsObjects = 0, lfsBytes = 0, bundleSize = 0; std::string bundleSha256; };
    std::string HostedImportReportJson(const HostedImportOutcome& outcome);

    // The job: `source` is cloned with this machine's own login; `artifactsRemote` takes the git with `artifactsToken`;
    // `smithRemote` (with `lfsTicket`, empty: none) takes the large files; `scratch` is the job's own directory.
    struct HostedImportRequest { std::string source, artifactsRemote, artifactsToken, smithRemote, lfsTicket, scratch; int64_t thresholdBytes = 0, maxRepoBytes = 0; };
    // argv, cwd, env, captured stdout lines (may be null), captured stderr lines (may be null), and a file stdout is
    // written to instead of being captured (empty: none; a repository holds more objects than a runner keeps lines);
    // the process exit code (-1: could not run).
    using HostedImportRun = std::function<int(const std::vector<std::string>&, const std::string&, const std::map<std::string, std::string>&, std::vector<std::string>*, std::vector<std::string>*, const std::string&)>;
    using HostedImportLog = std::function<void(const std::string&)>;
    // Stores the bundle at `path` (`size` bytes) and fills `sha256`; false when it could not be stored.
    using HostedImportUpload = std::function<bool(const std::string& path, int64_t size, std::string& sha256)>;
    struct HostedImportResult { bool ok = false, oversize = false; std::string failure, message; HostedImportOutcome outcome; };
    // The steps of spec §5 against a bare clone under `request.scratch`. `lfsAvailable` false skips the LFS steps and the
    // rewrite, failing instead when a blob over the threshold exists (the smith-import label normally prevents this).
    HostedImportResult RunHostedImport(const HostedImportRequest& request, const HostedImportRun& run, const HostedImportLog& log, const HostedImportUpload& upload, bool lfsAvailable);
}
