# Claude Code, Codex and Gemini in the Smith dashboard (proposal)

Date: 2026-10-04

Status: **proposal for review**. Nothing here is implemented. It builds on the
[Cloudflare coordinator design](2026-10-04-cloudflare-coordinator-design.md).
Scope is the **Cloudflare-hosted coordinator only**; the LAN coordinator is
unchanged.

## Goal

From the hosted Smith website, pick a project and work on it with Claude Code,
Codex or Gemini, **using your personal subscriptions**, the way their vendors
intend. The first project is Smith itself: Smith should be able to develop
Smith.

In practice: type a task in the dashboard, watch the agent work live, answer
its questions and permission prompts, see the diff, run the project's own Smith
build on the result, and push a branch when you're happy with it.

## The principle that keeps this compliant

**Bring your own machine, bring your own login.**

The vendor's **official, unmodified CLI** runs on **your own enrolled Smith
agent machine**. You sign in to it **yourself, on that machine, through the
vendor's own sign-in flow**. The CLI's credentials stay in the vendor's own
storage on that machine.

Smith never sees, stores, forwards or proxies any Claude, ChatGPT or Google
credential. The Worker has no table or column for them. The Smith agent never
reads the vendors' credential files. Smith only starts the CLI, passes it a
prompt, and relays the CLI's own output to your browser.

Each vendor's rules map onto this as follows (checked 2026-10-04):

| | Claude Code | Codex | Gemini |
| --- | --- | --- | --- |
| Personal-plan CLI | `claude` with Pro/Max | `codex` with ChatGPT Plus/Pro | **Antigravity CLI (`agy`)**. Gemini CLI stopped serving free/AI Pro/Ultra on 2026-06-18 |
| Sign-in on the runner | `claude` → `/login`; `claude setup-token` for headless boxes (token kept in the runner's local config, never uploaded) | `codex login`, or `codex login --device-auth` on headless boxes | Interactive `agy` login once, or a Gemini API key (`modelProvider: "gemini"`) |
| Headless/streaming mode | `claude -p --output-format stream-json [--input-format stream-json]`; `--resume`, `--permission-mode`, `--allowedTools`, `--permission-prompt-tool`, `--max-turns`, `--max-budget-usd` | `codex exec --json` (JSONL events) and `codex exec resume`; `--sandbox workspace-write` | `agy -p --output-format stream-json [--input-format stream-json]`; the docs show driving it from a Python subprocess |
| What the vendor says | Third parties must not offer Claude login, or "collect, store, or intermediate" Claude credentials. The terms explicitly allow "an end user … signing in to the unmodified Claude Code binary with their own Claude subscription", including on a platform that hosts it. The Agent SDK must use API keys. Limits assume "ordinary, individual usage". | The docs recommend ChatGPT sign-in for plan use, and document device-code login and copying `auth.json` to your own remote machine. API keys are recommended for shared CI. | Clause 6: using "third party software … to access the Service (e.g. using OpenClaw with Antigravity OAuth)" is a breach. Google has banned accounts for this, and a second strike is permanent. The terms neither allow nor forbid scripting the official binary from your own UI. |
| Verdict for Smith | ✅ Personal use is OK: the unmodified CLI, your login, your machine | ✅ Personal use is OK | ⚠️ **API-key mode is OK.** Personal-login mode is a grey area with a severe downside (see "Gemini" below) |

What we deliberately do **not** do:

- No "Sign in with Claude/ChatGPT/Gemini" to Smith. Your existing Google
  sign-in to Smith only proves who you are; it does not and cannot grant
  Gemini plan access.
- No Claude Agent SDK, raw Anthropic API or OAuth-token reuse on a
  subscription. We drive the CLI binary only.
- No pooling. A subscription-backed runner serves **only its owner**.
- Smith does not bundle or patch vendor CLIs. You install them from the
  vendors' official channels.

## Several people on one Smith: everyone uses their own AI

Every Smith user's chat runs on **their own** computer, with **their own**
`claude` / `codex` login. A chat is never routed to someone else's machine
or account.

- **Machines belong to people.** When you add a computer to Smith, the
  enrollment code is issued to *you* while you're signed in, so the agent
  is recorded as yours. (Today, enrollment codes are bound only to the
  workspace; phase 1 adds the owner.)
- **Chats only go to your own machines.** When Alice opens a chat, the
  workspace DO looks only at agents Alice owns that have the chosen CLI
  installed. Bob's machine is never a candidate, even in a shared
  workspace, and even if both are online. This is checked server-side on
  every message, not just hidden in the UI.
- **No machine, no chat.** If Alice has no agent with Claude Code or Codex
  on it, the chat panel shows "Connect your computer", with the agent
  download, a one-click enrollment code, and the vendor's own install and
  sign-in instructions (`claude` → `/login`, `codex login`). It never falls
  back to anyone else's machine.
- **Shared build machines stay build-only for AI.** A team build box can
  keep running everyone's normal Smith builds. AI chats on it are allowed
  only for its owner, so a subscription logged in on that box is never
  used for someone else.
- **Privacy.** Chat transcripts and session diffs are visible only to the
  person who started them, unless they choose to share the resulting
  branch or build.

This is the same rule both vendors state: each end user authenticates with
their own subscription or API key, and nobody's plan is used on someone
else's behalf.

## Etiquette rules, enforced in code

These cover being a good citizen, not just the letter of the terms:

1. **One human, one login.** An AI session may only start on a runner whose
   enrolled owner is the requesting Smith user. The workspace Durable Object
   (DO) checks this server-side. Teammates can see build results, but can
   never start an AI session on your machine.
2. **Human-initiated only.** v1 has no cron, webhook or auto-retry triggers
   for AI sessions on subscriptions, which matches "ordinary, individual
   usage". Builds that verify AI output are ordinary Smith jobs.
3. **Small concurrency.** By default each owner gets 1 active session per
   vendor (configurable up to 2). Parallel candidate fan-out is for API-key
   mode only.
4. **Stop on limits; don't hammer.** A usage-limit or authentication error
   ends the session and is shown as-is. There is no automatic retry, model
   switching or fallback to another login.
5. **Visible attribution.** The UI shows which tool and auth mode a session
   uses. Commits made by a session carry the tool's co-author trailer.
   Transcripts are private to the owner.

## Architecture

```text
Browser ──HTTPS──> Worker ──> Workspace DO (sessions, events, authorization)
                                   ▲
                                   │ HTTPS (existing curl transport, protocol v2)
                          Smith agent on your machine
                                   │ spawns, reads stdout JSONL
                     claude -p / codex exec / agy -p   (unmodified, your login)
                                   │
                     isolated git worktree of the project at a pinned SHA
```

- **New job class `ai-session`**, beside builds, in the workspace DO. It holds
  the owner, runner, tool, auth mode, project, base SHA, worktree branch,
  state, and an append-only event log. The event log reuses the cursor-paged
  build-log machinery, with typed events in place of raw lines.
- **Agent side (C++).** The agent adds a `HostedAiSession` runner beside
  `HostedAgent`. Each vendor gets an adapter that turns the dashboard's
  request into argv. Each adapter also turns the CLI's JSONL into a small
  shared event set:
  - `message` (text deltas batched)
  - `tool` (name, args, result summary)
  - `permission-request`
  - `usage`
  - `result`

  The adapters are pure, testable code: they build argv and parse JSONL.
  Process spawning reuses the existing streaming `Process` code and
  process-tree kill.
- **Which machine runs it.** No new machine is needed. A session runs on one of
  the Smith agents you have already enrolled (today, your Windows PC) that has
  the chosen CLI installed and signed in. If you own exactly one such agent,
  it is picked automatically; otherwise the composer shows a dropdown. Agents
  owned by other people are never offered.
- **Capability labels.** Following the existing `wrangler` detection, the
  agent advertises `ai:claude-code`, `ai:codex` and `ai:agy` with versions
  when the binaries are on PATH. Sign-in status comes only from the CLI's own
  status output, or from the first run's error. Credential files are never
  read.
- **Transport.** v1 uses the existing HTTPS long-poll for user input, which
  covers prompts, follow-ups, permission answers and stop. Output events are
  batched up to every ~250 ms. Measure latency on the real Windows agent
  before adding DO WebSockets, which the design doc already defers to "when
  measured".
- **Permission modes (user-selectable, mirroring each tool's own UI).** The
  session's composer has a mode picker, with a remembered per-project
  default, that offers the same choices the vendor's CLI/app does:
  - *Claude Code*: **Ask** (default), **Accept edits**, **Plan**, **Auto**
    and **Bypass permissions** (with the same warning Claude Code shows).
    Prompts are relayed to the dashboard through `--permission-prompt-tool`,
    using a tiny local MCP tool served by the Smith agent. They offer
    Claude's own answers: *Yes*, *Yes, and don't ask again for …* (added to
    the session's allow-list) and *No, tell Claude what to do instead*.
    Changing mode applies from the next turn, which resumes the session
    with the new `--permission-mode`.
  - *Codex*: the sandbox choices **Read only**, **Workspace write** and
    **Full access**, passed as `codex exec --sandbox`. `codex exec` is
    non-interactive, so per-command approval prompts would need the
    app-server, which is experimental. That is a later step.
  - Per-project allow/deny lists (for example, always allow `git status`,
    `Build.bat`, `RunTests.ps1`) can be edited in the dashboard and are
    passed through as `--allowedTools` / `--disallowedTools`.
  - Whatever mode is chosen, the **hard guarantees come from the
    environment, not the mode**. The session has no deploy secrets or Smith
    node credentials, works in its own worktree, and has deny rules for
    deploys and force-pushes. "Bypass" therefore can't publish anything.
- **Isolation.** Every session gets its own git worktree under the agent's
  work directory, on branch `ai/<session-id>`, never in the agent's install
  directory. When Smith edits Smith, it doesn't overwrite the running agent.
  The CLI's environment is scrubbed of Smith node credentials and any
  deploy secrets (`CLOUDFLARE_API_TOKEN`, Steam, itch and so on). Per-tool
  deny rules block `wrangler deploy`, force pushes and pushes to `main`. This
  keeps the CLAUDE.md "no real deploys" rule true even with an agent at the
  keyboard.
- **Handoff.** A session ends with a local commit on `ai/<id>`. **Verify** in
  the dashboard enqueues a normal Smith build of the project's own
  `smith.json` rules, pinned to that commit. **Push branch** is a separate,
  human-only button that pushes with the runner's existing git credentials,
  after which you open the PR yourself. Nothing auto-merges or deploys.

## Local models with Ollama (shareable)

Agents can also run AI on models served by **Ollama** on the machine, as the
LAN agents already do for the Discord bot. Local models involve nobody's
subscription, so they are the one kind of AI a machine's owner can safely
share with the rest of the workspace. This softens "everyone needs their own
computer": a team box with a good GPU can serve everyone.

- **Inventory.** Hosted agents report their Ollama models with every
  heartbeat (refreshed about once a minute). Ollama's `:cloud` models run on
  the owner's ollama.com account, so they are marked remote.
- **Your machine.** You can use any of your models with either coding CLI:
  - Claude Code through Ollama's Anthropic-compatible API
    (`ANTHROPIC_BASE_URL=http://localhost:11434`,
    `ANTHROPIC_AUTH_TOKEN=ollama`, `--model <name>`);
  - Codex through its local-provider mode (`codex --oss`).
- **Sharing is the owner's choice, per machine.** On their machine's card,
  the owner ticks "Let workspace members use this machine's local Ollama
  models". Admins can't do it for them. Even then, other members are offered
  only **local** models, never `:cloud` models and never the owner's Claude or
  Codex login.
- **No fallback to the owner's login.** A session started by someone else
  runs the CLI with a fresh, empty per-session config directory
  (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) and the Ollama settings forced. The
  owner's credentials are not reachable from that session. If Ollama fails,
  the session fails.
- **Owner stays in charge.** The owner sees who is using the machine and can
  stop any session on it. By default a machine runs one Ollama session at a
  time, so the GPU isn't oversubscribed.
- **Hosting on request (later).** Ask a machine to pull and serve a model
  (`ollama pull`), with progress shown in the dashboard. After that, Smith
  can pick a machine automatically by free VRAM: the LAN agent already reads
  `nvidia-smi`. Automating this is deferred.

## Gemini

- The **Gemini API key** route (`agy` with `modelProvider: "gemini"`, key
  from Google AI Studio) is documented for headless use and creates no
  account session. Smith can support it safely. The key stays on the runner
  like any other CLI config, and billing goes to the key.
- The **AI Pro/Ultra personal login** route through `agy` works mechanically,
  and Google's docs show driving it from scripts. But clause 6 of the terms
  is broad ("using the Service in connection with products not provided by
  us"), and Google has run mass bans with a two-strike permanent policy.
  **Decision:** personal-login mode stays off for `agy` until Google
  clarifies this, or until its official SDK (`antigravity.google/docs/sdk`)
  offers a sanctioned route we can verify. Build the adapter so that
  switching it on later is configuration, not code.

## Phases (dogfooding on Smith from phase 2)

| Phase | Deliverable | Gate |
| --- | --- | --- |
| 1 ✅ | Per-user machine ownership (enrollment codes issued to the signed-in user); personal computers that never take builds ("Connect my computer"); agents report Claude Code/Codex versions and Ollama models; machine cards show AI tools and models, with the owner-only share toggle; `ai/options` lists exactly what each person may use where | 9 Workers tests: personal machines never claim builds, viewers cannot add build machines, five-per-person cap, owner-only sharing (admins cannot), shared machines expose only local models and never the owner login, offline machines offer nothing, malformed inventory rejected. Native parser tests for Ollama tags and version banners |
| 2 ✅ | "Work with AI" chat in the dashboard: pick a project and your computer, Claude Code runs headless with your own login in a private clone on `smith/ai-<id>`, the message goes in on stdin (no quoting hazards), stream-json events are relayed live, follow-ups resume the conversation, Stop kills the process tree, each reply's changes are committed to the session branch. Modes: plan, accept edits, bypass (ask mode waits for phase 3) | 8 Workers session tests (privacy from admins, machine ownership, replay-safe events, stop, lost leases, one active reply per person); C++ helper tests; end-to-end on Linux against `wrangler dev` with a stand-in CLI and in Chromium. **Not yet run on Windows with real Claude Code** |
| 2b ✅ | Chat history like the Claude and ChatGPT apps: chats are kept per person and listed by date with search (titles, your messages and the replies), rename, pin, archive (a new message brings a chat back), delete, export as Markdown, and `#chat=<id>` links | 3 Workers library tests (rename/pin/archive, search including replies and literal `%`, delete refused while a reply runs); Chromium end-to-end against `wrangler dev`, desktop and phone width |
| 4 ✅ | Codex adapter, brought forward: `codex exec --sandbox <mode> [resume <thread>] --json -` with the prompt on stdin, Codex's own JSONL relayed and rendered (messages, reasoning, commands, file changes, MCP calls, plans), its `thread_id` resumed on follow-ups. Modes are Codex's own sandbox choices: workspace write (default), read only, full access; approvals stay at exec's default, so refused actions are reported instead of waiting | Workers test (Codex modes only, events must match the session's CLI, thread resumed, replies searchable); C++ argv tests (an ID can never read as a flag); end-to-end on Linux against `wrangler dev` with a stand-in `codex` that checks its arguments, and in Chromium. **Not yet run with real Codex, nor on Windows**, where Codex's sandbox depends on its own Windows sandbox setup |
| 3a ✅ | Ask mode ("Ask before each action") for Claude Code. Claude Code runs with `--permission-prompt-tool mcp__smith_approval__approve` and an `--mcp-config` that starts `Smith.exe ai-approve <dir>`, a local stdio MCP helper. Each question becomes a file in the turn's private folder; the agent relays it over its existing lease as an `approval` event, and the answer rides back on the next report. The dashboard shows Allow / Always allow &lt;tool&gt; in this chat / No, tell Claude what to do instead. Allow returns the tool's original input unchanged; unanswered questions are declined after 15 minutes. No new credential: the helper only reads and writes that folder, and only the chat's owner can answer | 2 Workers tests (owner-only answers, retried clicks, always-allow answers later questions automatically, tool names never become permission rules, questions only in ask mode); C++ tests of the helper's MCP handshake (legacy and 2026-07-28), answered/refused/unanswered questions; end-to-end on Linux with a stand-in `claude` that drives the real helper, answered in Chromium. **Not yet run with real Claude Code on Windows**; hosted agents on Linux and macOS cannot use ask mode yet |
| 3b ✅ | **Push branch** and **Verify**. A push is a chat turn of kind `push` that the chat's own machine runs: `git push --no-verify <url> refs/heads/smith/ai-<id>:refs/heads/smith/ai-<id>`, never forced, with that machine's Git login (an Artifacts-hosted project gets a write token for that turn, operators and up). Verify pushes, then queues a normal Smith build of the project pinned to the pushed commit on the chat's branch and links it from the chat. Hardening found on the way: Smith's own git commands in a chat's copy run with hooks and fsmonitor off, and stop if the CLI changed `.git/config` (except in full-access modes). Agents report features (`ask`, `push`, `ollama`, `codex-ask`) so the dashboard asks owners of older agents to update | Workers tests (push only after changes, builders-only Verify, pinned job specs, Artifacts read/write tokens per turn, old agents asked to update); end-to-end on Linux pushing to a local stand-in for GitHub (Git `insteadOf`), planted hooks not run, tampered config refused |
| 3c ✅ | Ollama as the model: Claude Code via Ollama's Anthropic API (`ANTHROPIC_BASE_URL=http://127.0.0.1:11434`, `ANTHROPIC_AUTH_TOKEN=ollama`, `--model`), Codex via `codex exec --oss --local-provider ollama -m`. Every Ollama chat starts with the CLI's credential variables removed (`ANTHROPIC_*`, `CLAUDE_CODE_*`, token-file variables; found when the real Claude Code used one). Guests on a shared machine get only local models, only edit-own-copy or read-only modes, no Push/Verify, and a fresh `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in the chat's folder; the owner's machine card lists them with Stop | Workers tests (guest modes, guest push refused, owner sees and stops guests, unsharing stops claims); agent tests of the environment; real Claude Code 2.1.289 and Codex 0.160.0 against mock model servers, every request carrying the `ollama` placeholder |
| 4b ✅ | Codex ask mode ("Ask before each action"): `codex app-server` with approval policy `untrusted`; command and file-change approval requests become dashboard questions; "No, tell Codex …" declines and steers the turn | Real `codex app-server` 0.160.0 against a mock model: allow, decline with steer, resume, stop while a question waits |
| 4c ✅ | Notifications: a background tab keeps following running chats, shows "(n) Waiting for you" and notifies when a question arrives or a reply ends. On Windows, the dashboard warns when Codex's own sandbox is not set up (agents report it) | Chromium with the tab hidden |
| 5 | Antigravity adapter in Gemini API-key mode; personal-login mode stays **off** (decided 2026-10-04) | Same suite |
| later | Host models on request (`ollama pull` from the dashboard), auto-placement by free VRAM; Smith as a remote MCP server, so Claude.ai or ChatGPT can drive Smith builds; parallel candidates in API-key mode | — |

## Decisions (2026-10-04)

1. Gemini personal-login mode stays off; only API-key mode is planned.
2. Sessions run on the user's existing enrolled agents; no dedicated "AI
   machine" is needed.
3. Permission handling is user-selectable, mirroring each tool's own modes
   (see "Permission modes" above), and no single default is imposed.

## Sources

- Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- Claude Code headless mode: https://code.claude.com/docs/en/headless
- Claude Code authentication (`setup-token`): https://code.claude.com/docs/en/authentication
- Codex authentication: https://learn.chatgpt.com/docs/auth
- Codex non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode
- Codex app-server: https://learn.chatgpt.com/docs/app-server
- Sign in with ChatGPT (not needed for this design): https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- Gemini CLI → Antigravity CLI transition: https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli
- Gemini Code Assist consumer deprecation: https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals
- Antigravity terms: https://antigravity.google/terms
- Antigravity CLI headless mode: https://antigravity.google/docs/cli/headless/
- Antigravity CLI install/auth: https://antigravity.google/docs/cli/install/
- Gemini CLI terms: https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md
- Google on Antigravity bans: https://github.com/google-gemini/gemini-cli/discussions/20632
