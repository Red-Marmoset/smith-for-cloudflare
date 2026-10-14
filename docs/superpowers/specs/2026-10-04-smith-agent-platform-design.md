# Smith as a platform for coding agents (proposal)

Date: 2026-10-04

Status: phases A and B are implemented (see [agent access](../../cloudflare/agent-access.md)); later phases are proposals. It builds on
the hosted coordinator and the
[AI chat design](2026-10-04-ai-assistant-integration-design.md).

## The idea

Coding agents are good at editing code. They are bad at proving the code
works on machines they don't have: a Windows MSVC build, a Unity player, the
other operating system. Smith already owns those machines, the build
scripts and the logs. So Smith should be the place agents go to answer "does
it build, does it pass, ship it?", in both directions:

| Direction | Example |
| --- | --- |
| **Agent → Smith** | Claude Code on a laptop runs the Windows build of its uncommitted change on your Windows PC, reads the compiler errors and fixes them, without pushing anything |
| **Smith → agent** | A Smith chat (phase 2, now built) runs Claude Code on your PC. That session can itself ask Smith for builds, so it can verify its own work |
| **Smith ↔ chat apps** | Claude.ai or ChatGPT can see build status and start builds through a connector |

All three use one surface: a **remote MCP server on the Worker**. Both Claude
Code and Codex speak MCP over HTTP, and so do Claude.ai and ChatGPT.

## 1. The Smith MCP server

The endpoint is `https://exp.redmarmosetstudios.com/mcp`: Streamable HTTP,
served by the same Worker. Every tool maps onto an existing workspace Durable
Object action, so the existing authorization applies unchanged.

| Tool | Does | Scope |
| --- | --- | --- |
| `list_projects`, `list_machines` | What can be built, and where (OS, labels, online) | read |
| `start_build` | Queue a project product (idempotent `requestId`) | build |
| `wait_for_build` | Long-poll up to ~50 s for a state change; agents call it again until it finishes | read |
| `read_build_log` | Cursor-paged log, capped per call | read |
| `get_artifact` | A short-lived download link for a finished build's output | read |
| `build_my_changes` (phase 3) | Upload a patch of the agent's working tree; build it on a chosen machine on top of the project commit | build |
| `start_ai_session`, `get_ai_session` (phase 4) | Delegate to a machine you own, for example "run Codex on my Windows PC" | ai |

Deliberately missing: promote, handoff, deploy, enroll, membership, secrets.
Shipping stays a human action in the dashboard, which keeps the CLAUDE.md
safety rule true when an agent holds the token.

**Untrusted output.** Build logs and repository text are untrusted input to
the model. Tool descriptions say so, output is capped (Claude Code warns at
10k tokens and truncates at 25k by default), and no tool's output can widen
a token's scope.

## 2. How agents authenticate

1. **Personal access tokens first.** "Connect Claude Code / Codex" in the
   dashboard creates a token scoped to one workspace and to chosen scopes
   (read / build / ai), with an expiry. It is shown once, with copy-paste
   setup for each CLI. Smith stores only a hash; the token can be revoked
   from the same panel.
   - Claude Code:
     `claude mcp add --transport http --scope user smith https://exp.redmarmosetstudios.com/mcp --header 'Authorization: Bearer ${SMITH_TOKEN}'`
     (single quotes: Claude Code expands the variable at start-up, so the token stays out of its settings)
   - Codex: `[mcp_servers.smith]` in `~/.codex/config.toml` with the URL and
     `bearer_token_env_var = "SMITH_TOKEN"`.
2. **OAuth 2.1 next.** Smith becomes the authorization server, using
   `@cloudflare/workers-oauth-provider`: PKCE, dynamic client registration,
   and a consent page reached through the existing Smith sign-in. Then
   `/mcp` in Claude Code, Claude.ai custom connectors and ChatGPT connectors
   all work without copying tokens.
3. **Session tokens inside Smith chats.** Each turn of a dashboard chat gets
   a token minted for that session's project, which can only build the
   session's own branch. It is passed to the CLI through `--mcp-config` in
   the session directory and revoked when the turn ends.

None of these involve anyone's Claude or ChatGPT login. Smith authenticates
the agent to Smith, nothing more.

## 3. A Claude Code plugin (and the Codex equivalent)

This repository can be its own plugin marketplace
(`.claude-plugin/marketplace.json`). Install it with
`/plugin marketplace add Red-Marmoset/smith`, then `/plugin install smith`.
The plugin bundles:

- **`.mcp.json`** pointing at the Smith MCP server. The coordinator URL and
  the token come from plugin `userConfig`, and the token is marked sensitive
  so Claude Code keeps it in secure storage.
- **A `smith-verify` skill:** "before you say a change is done, build it with
  Smith on the machines that matter, read the errors, and fix them". It
  covers which product to use, and how to read MSVC and Unity logs.
- **Commands:** `/smith:build`, `/smith:status`, `/smith:logs <build>`.
- **An optional `Stop` hook,** off by default: if files changed and no Smith
  build has passed since, remind the agent to run one. It is opt-in because
  forcing builds on every stop costs time and machine capacity.

Codex has no Claude-style plugin to reuse here. The same MCP server, plus an
`AGENTS.md` section or Codex skill carrying the `smith-verify` instructions,
gives it the same abilities. Reports of a Codex plugin marketplace come from
third-party write-ups; confirm against OpenAI's docs before building on it.

## 4. "Build my working tree" (the feature that makes it worth it)

An agent's change usually isn't pushed yet. `build_my_changes` works like
this:

1. The plugin's helper creates a `git diff --binary` (or a bundle for new
   commits) against the project's pinned commit.
2. It is uploaded to R2 through a scoped, expiring upload grant, at most
   20 MB.
3. The patch's digest is recorded in the job spec.
4. The agent machine fetches the pinned commit, applies the patch with
   `git apply --index`, and runs the normal build.

Logs and results flow back exactly as for any other build. Nothing is pushed
anywhere. The patch is visible to the workspace like any build input.

## 5. Ask-mode for dashboard chats

Phase 3 of the chat needs Claude Code's "Ask before each action". Claude
Code's `--permission-prompt-tool` takes an **MCP tool**, so the
session-scoped Smith MCP server can provide it:

1. Claude calls `smith.approve`.
2. The Worker records a pending prompt.
3. The dashboard shows Allow / Allow always / Deny.
4. The tool call returns the answer.

This reuses the same MCP endpoint rather than adding a local helper process.
Check the MCP tool timeout (`MCP_TOOL_TIMEOUT`) against how long a person
may take to answer.

## Phases

| Phase | Deliverable | Gate |
| --- | --- | --- |
| A ✅ | Personal access tokens + `/mcp` with read and build tools; setup instructions for Claude Code and Codex | 6 MCP/token Workers tests (scopes, role changes, removal, revocation, expiry, cross-workspace, both protocol eras, header checks, idempotent builds, log tail framing); verified with Claude Code 2.1.289 and the MCP Inspector CLI against `wrangler dev` |
| B ✅ | `smith` Claude Code plugin in this repo's marketplace (MCP config, `smith-verify` skill, `/smith:build`, `/smith:status`, `/smith:logs`); Codex `AGENTS.md` snippet | `claude plugin validate` passes; installed from the local marketplace, configured, and `claude mcp list` shows the plugin's server connected. **A real build through a live Claude Code session is yours to run** |
| C | `build_my_changes`: patch upload and apply-on-agent | Replay tests for digest mismatch, oversized and stale patches; the agent applies on a clean checkout only |
| D | Session tokens in dashboard chats, and Ask-mode through `smith.approve` | A chat on the Smith project builds its own branch on the Windows agent and fixes a seeded compile error |
| E | OAuth 2.1 so Claude.ai and ChatGPT connectors can attach | Consent, revocation and DCR tests |

## Sources

- Claude Code plugins: https://code.claude.com/docs/en/plugins/manifest-reference.md
- Claude Code MCP: https://code.claude.com/docs/en/mcp.md
- Claude Code hooks: https://code.claude.com/docs/en/hooks-guide.md
- Claude Code headless mode (`--permission-prompt-tool`): https://code.claude.com/docs/en/headless
- Cloudflare Agents SDK MCP: https://developers.cloudflare.com/agents/
