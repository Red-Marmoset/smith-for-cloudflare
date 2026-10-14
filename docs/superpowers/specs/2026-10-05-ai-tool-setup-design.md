# AI tool setup from the dashboard (install, sign in, API-key choice)

Date: 2026-10-05. Branch: `feature/cloudflare-experiment`.

## Problem

Starting a chat assumed the owner had already installed Claude Code / Codex on the machine, put
them on the agent's PATH, signed in, and had no API key in the environment. Each gap was a silent
surprise:

- Codex installed in a place the agent does not search (npm global dir not on the logon task's
  PATH, Homebrew, native installer dir) never appeared as a choice.
- A missing CLI gave no hint how to get it; the owner had to go to a terminal.
- An `ANTHROPIC_API_KEY` in the agent's environment silently overrode the owner's claude.ai
  login (Claude Code: "claude.ai connectors are disabled because ANTHROPIC_API_KEY ... takes
  precedence"), billing the API account and losing connectors. Same for `OPENAI_API_KEY` /
  `CODEX_API_KEY` with Codex.

Goal: the dashboard is the only place the owner has to touch. Every state of a CLI on a machine is
shown where the chat is started, with the one button that fixes it.

## Agent: finding the CLIs

`HostedToolArgv(tool, args)` resolves the tool to an absolute path: the PATH first, then each
platform's standard install locations (`HostedToolSearchDirs`, pure and tested):

- Windows: `%USERPROFILE%\.local\bin` (Claude Code native), `%APPDATA%\npm`, `%ProgramFiles%\nodejs`,
  `%LOCALAPPDATA%\Microsoft\WinGet\Links`, `%USERPROFILE%\scoop\shims`, `%ProgramData%\chocolatey\bin`,
  `%LOCALAPPDATA%\Volta\bin`, `%LOCALAPPDATA%\pnpm`, `%USERPROFILE%\.bun\bin`.
- macOS/Linux: `~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`, `$NVM_BIN`, `~/.volta/bin`,
  `~/.bun/bin`, `~/Library/pnpm`, `~/.local/share/pnpm`, `/opt/homebrew/bin`, `/usr/local/bin`,
  `/usr/bin`, `/snap/bin`.

On Windows an `.exe` runs directly; a `.cmd`/`.bat` shim runs through `cmd.exe /d /c`. Unresolved
names fall back to the old PATH lookup, so nothing that worked before stops working.

## Agent: what it reports (heartbeat `ai` inventory)

Additive, all optional:

```jsonc
{
  "tools": [{ "id": "codex", "version": "codex-cli 0.160.1",
              "signedIn": false,     // status check with API-key variables removed; omitted when unknown
              "apiKey": true }],     // an API key for this tool is set in the agent's environment
  "installable": ["claude-code"],    // missing tools this agent can install by itself
  "features": [..., "setup", "api-key-choice"]
}
```

- `signedIn`: Claude Code `claude auth status --json` → `loggedIn`; Codex `codex login status`
  exit code 0. Both run with the API-key variables unset, so they report the subscription login.
- `apiKey`: Claude Code — `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`; Codex — `OPENAI_API_KEY`
  or `CODEX_API_KEY`. Only presence is reported, never a value.
- `installable`: Claude Code always (Anthropic's native installer); Codex when npm is available,
  or Homebrew on macOS.
- Tools are re-detected every 2 minutes (was 10) and straight after a setup task.

The Worker validates these fields strictly, so **deploy the Worker before shipping the agent**.

## API-key choice (default off)

Session create and message requests accept `useApiKey` (boolean, default false), stored per turn
and sent to the agent in the claimed turn. With the owner's own login (`brain: own-login`) and
`useApiKey` false, the agent removes the tool's API-key variables from the CLI's environment
(`HostedApiKeyEnvUnset`). The dashboard shows the checkbox only when the machine reports
`apiKey: true` for the chosen tool: "Use the API key set on <host> instead of your <tool> login
(billed to that API account)". Ollama brains already replace these variables.

## Setup tasks (install / sign in), driven from the page

A per-node task the owner starts from the chat composer. At most one unfinished task per node.

Table `ai_setup_tasks(id, node_id, owner_user_id, tool, action, state, lease_token,
lease_expires_at, stop_requested, input, output, message, created_at, updated_at, finished_at)`;
`action` ∈ `install`, `sign-in`; `state` ∈ `queued`, `running`, `succeeded`, `failed`, `stopped`.

Human routes (node owner only, node must report feature `setup`):

- `POST ai/setup {nodeId, tool, action}` → `{task}` (409 if the node has an unfinished task).
- `GET ai/setup/<id>` → `{task: {id, nodeId, tool, action, state, output, message, createdAt, finishedAt}}`.
- `POST ai/setup/<id>/input {text}` — one line (≤ 2048 chars) for the CLI's stdin (sign-in codes).
- `POST ai/setup/<id>/stop {}`.

`ai/options` machines carry `tools` (`{id, version, signedIn?, apiKey?}`), `installable`, and
`setup` (the node's unfinished or most recent task, `{id, tool, action, state}`).

Agent routes:

- `/ai/claims` reply gains `setup: {setupId, leaseToken, tool, action} | null`: a queued task for
  this node becomes `running` with a 90 s lease. A running task whose lease lapsed becomes
  `failed` ("the agent stopped responding").
- `POST /ai/setup/events {setupId, leaseToken, lines: string[], finish?: {status, message}}` →
  `{stop, input: string[]}` (pending input is drained when delivered). Each call renews the lease;
  the agent sends one at least every 2 s while the task runs. `output` keeps the last 64 KiB.

Agent behaviour (own thread, so chats keep running):

- install Claude Code: Windows `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm
  https://claude.ai/install.ps1 | iex"`; macOS/Linux `bash -c "curl -fsSL https://claude.ai/install.sh | bash"`.
- install Codex: `npm install --global @openai/codex@latest`; else macOS `brew install --cask codex`;
  else not installable (installing Node.js needs an administrator prompt, which Smith never raises),
  and the page says Node.js is what that computer needs.
- sign in Claude Code: `claude auth login --claudeai`; sign in Codex: `codex login --device-auth`.
  Both with API-key variables removed and stdin piped, so a code pasted in the page reaches the CLI.
  **Nothing Smith runs may ever open a browser or otherwise interrupt the owner unasked.** Every CLI
  process Smith starts (setup tasks and chat turns) gets `BROWSER` set to a no-op (`true` on
  macOS/Linux, `%SystemRoot%\System32\where.exe` on Windows; Claude Code runs `$BROWSER <url>`
  and only falls back to `rundll32` when it is unset). Sign-in only ever starts from the owner's
  click, and the link opens only when the owner clicks it on the page.
  **Before starting, the agent re-checks the status and does nothing if already signed in:
  starting `codex login` discards the existing login.** The page shows the link (and Codex's
  one-time code); Claude Code's page shows a code after sign-in that the owner pastes back.
- After the task, the agent re-detects tools and heartbeats at once.

Page flow: every blocking state is a red notice right where the chat is started, with its one
button; nothing happens until the owner clicks. Missing tool → "Codex isn't installed on HOST. [Install Codex]"; after a successful
install the sign-in notice appears (sign-in still waits for the owner's click); installed but signed out → "[Sign in to Codex]";
the task's output is shown live with links clickable, plus "Paste the code" and Stop. Start/Send
is disabled with the reason while the chosen tool cannot run.
