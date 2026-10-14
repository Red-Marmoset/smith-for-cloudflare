// HostedGitHost.h - this machine as a git host for Smith's copies of repositories: whether it can
// host, where a copy lives, how a relayed git request is served (argv, environment, the ref-policy
// hook), and how the copy's refs are reported. Everything but the store operations at the bottom
// is pure, so the rules are unit-tested without git.
//
// See docs/superpowers/specs/2026-10-06-smith-hosted-git-design.md.
#pragma once
#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <utility>
#include <vector>
namespace Smith {
    constexpr const char* kHostedGitHostLabel = "smith-git-host";       // this machine can keep copies
    constexpr const char* kHostedGitClientLabel = "smith-git-client";   // this machine can build from a copy
    constexpr int64_t kHostedGitMinFreeBytes = 2LL * 1024 * 1024 * 1024;
    constexpr int64_t kHostedGitPartBytes = 5 * 1024 * 1024;            // one relay response part

    struct HostedHostingAbility { bool able = false; std::string reason; };
    // Pure: "2.39.5" from "git version 2.39.5 (Apple Git-154)" (or "2.47.1.windows.1" -> "2.47.1"); "" when it is not a git version line.
    std::string HostedGitVersion(const std::string& versionLine);
    bool HostedGitVersionAtLeast(const std::string& version, int major, int minor);
    // Pure: whether this machine may advertise smith-git-host, with the one reason it cannot
    // (git missing or older than 2.36, no exec path, under 2 GB free, store root not private).
    HostedHostingAbility HostedGitHostAbility(const std::string& gitVersionLine, bool execPathOk, int64_t freeBytes, bool storeOk);

    struct HostedRefPolicy { std::vector<std::string> allow, protectedRefs; bool denyDelete = false; };
    // Pure: the coordinator's refPolicy object (JSON text). Patterns are limited to [A-Za-z0-9/_.*-], 32 each, 256 characters.
    HostedRefPolicy HostedParseRefPolicy(const std::string& json);
    // Pure: shell-style glob match for ref names (`*` spans path separators, as git's refspec globs do).
    bool HostedRefGlob(const std::string& pattern, const std::string& ref);

    // Pure: the git front end serving one relayed request: `git upload-pack --stateless-rpc <dir>`,
    // `git receive-pack --stateless-rpc <dir>` or `git <service> --http-backend-info-refs <dir>`. Empty for anything else.
    std::vector<std::string> HostedGitServeArgv(const std::string& service, const std::string& op, const std::string& bareDir);
    // Pure: environment for a served request: the client's GIT_PROTOCOL, no system or user git config, no prompts, the ref policy for the hook.
    std::map<std::string, std::string> HostedGitServeEnv(const std::string& gitProtocol, const HostedRefPolicy& policy, const std::string& emptyGlobalConfig);
    // Pure: inherited variables removed before serving or syncing (all GIT_*, credential and deploy variables).
    std::vector<std::string> HostedGitServeEnvUnset();
    // Pure: the smart-HTTP preamble a client expects before an info/refs advertisement: "001e# service=git-upload-pack\n0000".
    std::string HostedGitInfoRefsPreamble(const std::string& service);
    // Pure: one pkt-line "ERR <message>", which git shows as "fatal: remote error: <message>".
    std::string HostedPktErr(const std::string& message);
    // Pure: "" when the head of a receive-pack body is a plain command list this host serves; otherwise the refusal
    // (push certificates, shallow pushes, push options and unparseable lines are refused before git runs).
    std::string HostedGitRefuseReceive(const std::string& bodyHead);
    // Pure: the `update` hook (POSIX sh; Git for Windows runs it through its bundled sh) enforcing SMITH_ALLOWED_REFS,
    // SMITH_PROTECTED_REFS (no force-push, no delete) and SMITH_DENY_DELETE, and reserving refs/smith/*.
    std::string HostedGitUpdateHook();
    // Pure: `git for-each-ref --format=%(objectname) %(refname) %(*objectname)` output as the coordinator's tips: [sha, ref]
    // pairs sorted by ref, refs/smith/* left out; `peeled` (optional) receives what each annotated tag points to, so the
    // coordinator can answer a clone's ref list itself. Throws when more than 10000 refs remain or a line is malformed.
    std::vector<std::pair<std::string, std::string>> HostedGitParseTips(const std::string& forEachRefOutput, std::map<std::string, std::string>* peeled = nullptr);
    std::string HostedGitTipsJson(const std::vector<std::pair<std::string, std::string>>& tips);
    // Pure: the peeled map as a JSON object ({} when empty).
    std::string HostedGitPeeledJson(const std::map<std::string, std::string>& peeled);
    constexpr const char* kHostedGitTipsFormat = "--format=%(objectname) %(refname) %(*objectname)";
    // Pure: the size `git count-objects -v` reports (size + size-pack, in bytes).
    int64_t HostedGitCountedBytes(const std::vector<std::string>& countObjectsLines);
    // Pure: the config every store gets (receive/transfer/fetch fsck, 100 MB input cap, atomic pushes, filters, the hooks dir).
    std::vector<std::pair<std::string, std::string>> HostedGitStoreConfig(const std::string& hooksDir);
    // Pure: <root>/git/<first 12 of workspace id>/<repoUuid>.git; throws for an unsafe uuid.
    std::string HostedGitStorePath(const std::string& root, const std::string& workspaceId, const std::string& repoUuid);
    bool HostedGitUuidValid(const std::string& uuid);

    // Pure: the fetch that makes this machine's copy match the primary: heads and tags forced and pruned, atomically,
    // leaving refs/smith/* (recovered refs) alone.
    std::vector<std::string> HostedGitReplicateArgv(const std::string& bareDir, const std::string& remote);
    // Pure: refs a copy held that the record does not: a ref whose old tip is not an ancestor of its new tip (or that
    // vanished) and whose old tip no other ref still contains. `isAncestor(old, new)` and `contained(old)` ask git.
    std::vector<std::pair<std::string, std::string>> HostedGitRecoverable(const std::vector<std::pair<std::string, std::string>>& before, const std::vector<std::pair<std::string, std::string>>& after,
        const std::function<bool(const std::string&, const std::string&)>& isAncestor, const std::function<bool(const std::string&)>& contained);
    // Pure: where a recovered ref is kept: refs/smith/recovered/<unix seconds>/<ref without "refs/">.
    std::string HostedGitRecoveredRef(int64_t unixSeconds, const std::string& ref);
    // Pure: `git bundle create <file> --all [^base...]`: every ref, minus what the base bundle already holds.
    std::vector<std::string> HostedGitBundleArgv(const std::string& bareDir, const std::string& file, const std::vector<std::string>& baseShas);
    // Pure: the refs of the newest manifest a restore keeps; everything else the bundles brought back is deleted (bundles
    // cannot express deletions). Returns the refs to delete.
    std::vector<std::string> HostedGitRestoreDeletions(const std::vector<std::pair<std::string, std::string>>& restored, const std::vector<std::pair<std::string, std::string>>& manifest);

    // Store operations (run git / touch the disk).
    // git against one bare store with no system or user config and credential variables removed; `extraEnv` (a ticket's
    // GIT_CONFIG_* variables) is applied on top. stdout lines are collected, stderr joined into `error`. Returns the exit code.
    int HostedGitRunStore(const std::string& bareDir, const std::vector<std::string>& args, std::vector<std::string>* lines, std::string& error, int timeoutSeconds, const std::map<std::string, std::string>& extraEnv = {});
    // A new empty bare store with Smith's config, hook and snapshot ("" on success, else the reason).
    std::string HostedGitInitBare(const std::string& bareDir, const std::string& hooksDir);
    // An empty file git can take as GIT_CONFIG_GLOBAL (<dir>/.empty-gitconfig, created owner-only when missing).
    std::string HostedGitEmptyConfig(const std::string& dir);
    // Writes the update hook (owner-only, executable) into <hooksDir>; idempotent.
    void HostedGitProvisionHooks(const std::string& hooksDir);
    // Applies HostedGitStoreConfig to a bare repository and snapshots its config file beside it (<bareDir>.config).
    // Returns git's error text, "" on success.
    std::string HostedGitInitStore(const std::string& bareDir, const std::string& hooksDir);
    // True when the bare repository's config still matches the snapshot taken at creation (a store whose config
    // changed is never served, synced or reported).
    bool HostedGitStoreTrusted(const std::string& bareDir);
    // The store's refs as tips and its size; `error` receives git's message on failure (tips are then empty); `peeled`
    // (optional) receives the annotated tags' targets.
    std::vector<std::pair<std::string, std::string>> HostedGitStoreTips(const std::string& bareDir, int64_t& bytes, std::string& error, std::map<std::string, std::string>* peeled = nullptr);
}
