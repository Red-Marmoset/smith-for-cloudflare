// HostedCrewRun.h - pure helpers for an unattended "crew" turn: the restricted Claude Code
// command line, the environment it runs in, the run's directory layout, the settings and MCP
// files it is given, and reading its result. Nothing here starts a process or touches a
// network, so every rule is unit-tested without a CLI.
//
// See docs/superpowers/specs/2026-10-05-autonomous-crew-design.md ("Brains and CLI isolation",
// "Runtime: what one run does").
#pragma once
#include <map>
#include <string>
#include <vector>
namespace Smith {
    bool HostedCrewScopeAllows(const std::vector<std::string>& scopes, const std::string& path);
    bool HostedCrewTreePlain(const std::string& root);
    std::string HostedCrewScopedSettings(const std::string& settings, const std::string& repo, const std::vector<std::string>& scopes, bool reader);
    struct HostedCrewArgs { std::string mode, schemaInline, runControlDir, inputDir, newProjectDir, resume, model; double usdPerRun = 1.0; };
    // Pure: headless, restricted Claude Code arguments for one crew run (the prompt arrives on stdin).
    // Empty when the mode is not plan/acceptEdits, the schema is not cmd.exe-safe, the resume ID or
    // model is not one Smith accepts, or the budget, rounded to cents, is under $0.01 or over $1000.
    std::vector<std::string> HostedCrewClaudeArgs(const HostedCrewArgs& in);
    // Pure: `codex exec` arguments for one crew run, the prompt (system text first) on stdin. plan runs in Codex's read-only
    // sandbox, acceptEdits in workspace-write with no network and no temp folders, writable only in the checkout and
    // newProjectDir. Approvals never ask; the only MCP server is Smith's (any the machine configured are dropped), reached with
    // the run token from SMITH_RUN_TOKEN. The report schema is a file; the last message (the report) is written to
    // lastMessageFile. A model means a local Ollama model (--oss). Every value is cmd.exe-safe, so the npm shim runs it on
    // Windows. Empty for another mode, a model Smith does not accept, or an MCP URL that is not plain https.
    std::vector<std::string> HostedCrewCodexArgs(const HostedCrewArgs& in, const std::string& schemaFile, const std::string& lastMessageFile, const std::string& mcpUrl);
    // Names and "PREFIX_*" patterns removed from the CLI's inherited environment (ProcessOptions::envUnset). The `login` brain
    // runs with the machine's own Claude Code sign-in, as a chat does: ANTHROPIC_* and CLAUDE_* stay, except the API-key
    // variables a chat also removes (HostedApiKeyVars); every other brain loses both families.
    // Codex (`tool` "codex"): its `login` brain keeps the machine's CODEX_*/OPENAI_* settings (CODEX_HOME holds the sign-in)
    // but loses the API-key variables a chat on the owner's login removes; its local-model brain loses both families.
    std::vector<std::string> HostedCrewEnvUnset(const std::string& brain, const std::string& tool = "claude-code");
    // Variables added after the unset: the brain's own (api-key/ollama only; any other brain contributes none), then the fixed ones
    // (git prompts off, the run token and, for every brain but `login`, the CLI's private config dir), which a brain's variables
    // cannot override. A `login` run keeps the machine's CLAUDE_CONFIG_DIR, where its sign-in lives.
    // Codex: the private dir becomes CODEX_HOME instead (empty, so no sign-in or configuration of the machine's is reachable),
    // for every brain but `login`.
    std::map<std::string, std::string> HostedCrewEnv(const std::string& brain, const std::map<std::string, std::string>& brainEnv, const std::string& claudeConfigDir, const std::string& runToken,
                                                     const std::string& tool = "claude-code", const std::string& codexHome = "");
    // settings.json: only the Smith MCP tools (plus project creation when allowed), no Bash, no Edit, Write or NotebookEdit in the
    // input dir or the checkout's .git. Each path rule comes native, //-prefixed with forward slashes (Claude Code's absolute form) and,
    // for a Windows path, as //c/... (drive letter lower-cased, no colon), the form Claude Code normalises paths to before matching.
    std::string HostedCrewSettingsJson(bool allowCreateProject, const std::string& inputDir, const std::string& repoDir);
    // The schema travels inline in argv, and Windows re-parses that through cmd.exe: only {}[]":,_ and letters/digits pass.
    bool HostedCrewSchemaCmdSafe(const std::string& schema);
    // True when the repo is unchanged since the last report, so the run can be skipped.
    bool HostedCrewSkip(const std::string& remoteSha, const std::string& skipIfCommit);
    struct HostedCrewDirs { std::string memberRoot, repo, memberControl, gitconfig, run, input, related, newProject, runControl, claudeConfig, codexHome; };
    HostedCrewDirs HostedCrewDirsFor(const std::string& workspaceRoot, const std::string& memberId, const std::string& sessionId);
    // No --add-dir is, holds or sits inside the gitconfig, the run's control dir or the member's repo. Paths are compared
    // after normalising separators, "."/"..", trailing separators and case, and equal paths overlap; empty paths fail.
    bool HostedCrewPathsIsolated(const HostedCrewDirs& d);
    // The trailer credits the CLI that made the change: Claude Code, or Codex (`tool` "codex").
    std::vector<std::string> HostedCrewCommitArgv(const std::string& memberName, const std::string& slug, const std::string& subject, const std::string& sessionId, const std::string& tool = "claude-code");
    // The structured_output of a stream-json result event as JSON text, or "" for any other line.
    std::string HostedCrewExtractReport(const std::string& resultEventJson);
    // Codex's last message (--output-last-message) as JSON text when it is a JSON object (the report), or "".
    std::string HostedCrewExtractCodexReport(const std::string& lastMessage);
    // The report schema the coordinator sent for a Codex run: a JSON object of at most 16 KB.
    bool HostedCrewSchemaValid(const std::string& schema);
    // One line of a staged diff that adds a private key ("+-----BEGIN ... PRIVATE KEY-----"): a crew run never commits one,
    // whatever it could read on the machine.
    bool HostedCrewPrivateKeyLine(const std::string& diffLine);
    // A crew-created project's directory: exists, is not a link or junction, and holds no .git and no links inside.
    bool HostedCrewNewProjectDirValid(const std::string& dir);
    // A project ID a crew member may create (the coordinator's rule): 2-40 of [a-z0-9-], not starting with a hyphen.
    bool HostedCrewProjectIdValid(const std::string& id);
    // The projects a run created: the folders directly in new-project/ whose name is a valid ID, that pass
    // HostedCrewNewProjectDirValid and whose files hold none of `secrets` (the run's own; empty ones match nothing), sorted, at
    // most five (what ai-finish takes). `refused` names every other entry there.
    std::vector<std::string> HostedCrewNewProjectIds(const std::string& newProjectDir, std::vector<std::string>& refused, const std::vector<std::string>& secrets = {});
    // Instruction files removed from a read-only related clone right after cloning, so another repository's
    // text cannot become instructions: {"CLAUDE.md","CLAUDE.local.md","AGENTS.md",".claude",".mcp.json"}.
    std::vector<std::string> HostedCrewStripFiles();
    // Removes those files wherever they sit under `dir` (a related clone), never looking inside its .git (filesystem only).
    void HostedCrewStripInstructionFiles(const std::string& dir);
    // mcp.json that reaches the coordinator with ${SMITH_RUN_TOKEN}, so the token never lands on disk.
    std::string HostedCrewMcpConfigJson(const std::string& url);
    // An input file's text cut to at most `maxBytes` (changes.diff: 400 KB) at the last line end within it, or, with none,
    // before the character the limit would split, followed by a note that Smith cut it. Unchanged when it fits.
    std::string HostedCrewCapText(const std::string& text, size_t maxBytes);
    // The 40-hex SHA `git ls-remote` lists for exactly `ref` ("refs/heads/main", "HEAD"), or "" when it lists none.
    std::string HostedCrewRemoteSha(const std::string& lsRemoteOutput, const std::string& ref);
    // `text` with every byte any occurrence of a (non-empty) secret covers replaced: each run of such bytes becomes one
    // "[redacted]", so overlapping or nested secrets leave no part of either behind.
    std::string HostedRedact(const std::string& text, const std::vector<std::string>& secrets);
    // The changed paths of `git diff --name-only -z` output as ai-finish takes them: in git's order, at most 500, each 1-512
    // bytes without control characters, and at most 24 KiB as a JSON array (the coordinator's limits). `total` is how many it
    // named. Paths Verify's guard reads (HostedCrewGuardedPath) are chosen first, so a run cannot hide one behind 500 others;
    // the finish says when the list is short of `total` (filesTruncated), and the coordinator then refuses Verify.
    std::vector<std::string> HostedCrewFinishFiles(const std::string& nameOnlyZ, size_t& total);
    // smith.json, or a build script (.ps1 .sh .bat .cmd .py), anywhere and in any case.
    bool HostedCrewGuardedPath(const std::string& path);
    // The input file a build-finished run's log goes to: "build-<jobId>.log", or "" for a job ID that is not 1-64 of
    // [A-Za-z0-9_-] (the coordinator's prompt names the file from the same ID).
    std::string HostedCrewBuildLogName(const std::string& jobId);
    // One line of `git diff --cached --raw`: true when it stages a gitlink (new mode 160000), a nested repository the run left
    // in the checkout, which Smith does not commit.
    bool HostedCrewGitlinkLine(const std::string& rawLine);
    // The environment every git command Smith runs in a crew turn gets: the member's own (empty) gitconfig as the global
    // config, so the machine owner's ~/.gitconfig (aliases, hooks paths, credential helpers) never applies to crew clones.
    // The system config is kept: it belongs to the Git installation (Git for Windows keeps http.sslcainfo there), and without
    // it HTTPS clones and pushes to Cloudflare Artifacts fail on Windows.
    std::map<std::string, std::string> HostedCrewGitEnv(const HostedCrewDirs& d);
    // The run directories (names under <member>/runs) a turn of `sessionId` removes: every one but its own. A failed or
    // stopped run keeps its files for a look until the member's next turn. None without a current session.
    std::vector<std::string> HostedCrewStaleRuns(const std::vector<std::string>& runIds, const std::string& sessionId);
    // Removes those directories under d.memberRoot/runs (filesystem only; a missing runs folder is fine).
    void HostedCrewRemoveStaleRuns(const HostedCrewDirs& d, const std::string& sessionId);
    // Why a crew branch must not be pushed to `url` with `token`, or "" when it may. Smith's copy (an Artifacts remote) is
    // pushed only with the token minted for the turn; any other project URL is pushed with this machine's own Git login,
    // as a chat's Push branch is, and never with a Smith token.
    std::string HostedCrewPushRefusal(const std::string& url, const std::string& token);
}
