# Smith features & usage

Reference for the build/orchestration features beyond the basics. Everything here
is driven by a repo's `smith.json` plus the `smith` CLI or HTTP API.

## CLI

The single `smith` binary is also a client for a running coordinator. Every
client command auto-discovers the coordinator on the LAN (UDP) if you don't pass
`--coordinator URL`; all accept `--token T` when the coordinator enforces auth.

| Command | What it does |
|---------|--------------|
| `smith trigger <project> <product> [--profile P] [--branch B] [--wait]` | Queue a build. `--wait` blocks until it finishes and **exits 0 on success / non-zero on failure** — drop it straight into a CI script or git hook. |
| `smith status <project>` | Print the latest build's status (exit code reflects pass/fail). |
| `smith logs <jobId>` | Print a build's console log. |
| `smith cancel <jobId>` | Cancel a queued build immediately, or abort a running one. |
| `smith discover` | Scan the LAN for a coordinator. |

```sh
# CI one-liner: build and fail the pipeline if the build fails
smith trigger myapp release --branch "$CI_BRANCH" --wait
```

## Multi-step builds

A rule's per-OS command may be a single object (one step) **or an array of
objects run in sequence**. A non-zero exit from an intermediate step aborts the
rest; the last step's exit code is the build result.

```json
"command": {
  "windows": [
    { "interpreter": "bat", "script": "config.bat" },
    { "interpreter": "bat", "script": "build.bat", "args": ["-Release"] }
  ],
  "linux": { "interpreter": "sh", "script": "build.sh" }
}
```

Interpreters: `ps1` | `bat` | `sh` | `python` | `exe`.

## Build matrix

Expand one product into many variants — a build matrix. Either glob the repo
(`"type":"files"`) or declare the entries (`"type":"list"`). Each variant is
classified (by regex on its name) to the node it needs, so configs × OSes fan
out as independent jobs, with `${VAR}` / `${VAR_SLUG}` substituted into the
command args, env and artifact globs.

```json
"discover": {
  "type": "list", "as": "CONFIG",
  "values": ["win-debug", "win-release", "linux-release"],
  "classify": [
    { "match": "^win-",   "os": "windows" },
    { "match": "^linux-", "os": "linux" }
  ]
}
```

Trigger a single variant with `smith trigger <project> <product> --profile win-release`,
or all of them from the web UI's profile dropdown.

## Handoff (deploy) steps

A rule's optional `handoff` array runs **after** artifacts are collected, on the same agent,
in the build's working directory. Each step is `{ name, type, ...fields, continueOnError? }`,
and a step's string fields get `${VAR}` substitution (`PROJECT_ID`, `BUILD_NUMBER`,
`WORKSPACE`, `ARTIFACTS_DIR`, `BRANCH`, `COMMIT`, `COMMIT_SHORT`, `TARGET_ENV`). A failed step
aborts the rest of the handoff unless it sets `"continueOnError": true`. Deploy credentials are
**never** in `smith.json` and never reach the coordinator: a step names a `credentialRef`, and
the agent resolves it from its local `smith-agent-credentials.json`
(`{ "ref": { "key": "value" } }`), passing secrets as env vars that are never logged.

| Type | What it does |
|------|--------------|
| `collect` | No-op marker; artifacts are already uploaded to the coordinator. |
| `copyShare` | Copy `from` (default: the build output) to a `dest` path/share. |
| `script` | Run a `script` (`interpreter`: `ps1`/`bat`/`sh`/`python`/`exe`) with `args`. |
| `steam` | Upload to Steam via `steamcmd` and one or more app-build VDFs (below). |
| `itch` | Push to itch.io via `butler`. |
| `cloudflare` | Deploy to Cloudflare Workers/Pages via `wrangler`. |

### Steam

| Field | Meaning |
|-------|---------|
| `appBuildVdf` | A single SteamPipe app-build VDF (path under the workspace, or absolute). |
| `appBuildVdfs` | An **array** of app-build VDFs, uploaded in **one** `steamcmd` login session — one `+run_app_build` each, **in order**. Use it to publish the base game **plus each DLC**: each DLC is its own Steam **App ID** with its own app-build VDF. |
| `steamcmd` | Override the `steamcmd` executable (default `steamcmd`). |
| `credentialRef` | Names the `{ "username", "password" }` block in the agent's credentials file. |

At least one of `appBuildVdf` / `appBuildVdfs` is required (the final list is `appBuildVdf`
first, then the array entries). The step builds and runs, in a single session:

```
steamcmd +login <user> <pass> +run_app_build <abs vdf1> +run_app_build <abs vdf2> +quit
```

```json
"handoff": [
  { "name": "collect", "type": "collect" },
  {
    "name": "steam-upload",
    "type": "steam",
    "credentialRef": "steam-prod",
    "appBuildVdfs": ["SteamPipe/app_build.vdf", "SteamPipe/app_build_dlc.vdf"]
  }
]
```

Each app's depots are defined inside its own app-build VDF, so one login publishes the base
game and all DLC together. The VDF file contents (depots, ContentRoots, file mappings) are
authored in the repo, not by Smith.

steamcmd block-buffers its stdout when piped, so its console output only reaches the build
log when it exits. For live progress the agent tails `*.log` files appearing in each VDF's
`BuildOutput` directory while steamcmd runs, streaming depot scan/upload lines into the
build log as `[depot_build_<id>] ...`.

## Artifact inputs (fan-in)

A rule can declare `inputs`: collected artifacts of earlier builds that Smith stages into
its workspace **after checkout, before the command runs**. The canonical use is a deploy
job consuming per-platform builds that ran on other nodes:

```json
"inputs": [
  { "product": "unity", "variant": "Steam (Windows)" },
  { "product": "unity", "variant": "Steam (Mac)" },
  { "product": "unity", "variant": "Steam (Linux)" }
]
```

For each input the coordinator picks the **latest successful build** of that product (+
optional `variant`) on the **same project and branch**, and the agent downloads every
collected artifact of that build: `*.zip` archives extract into the job's working dir,
anything else is written under its filename. Zip entries are relative to the *producing*
job's working dir, so a producer with `outputPath: "builds/${PROFILE_SLUG}"` lands at
`builds/<slug>/...` in the consumer — both rules keeping the default `workingDir: "."`
is the contract.

If an input has no successful build with artifacts to draw from, the job **fails at
dispatch** with a message naming the input (rather than queueing forever). If the picked
builds span more than one commit, the job log gets a prominent `INPUTS: WARNING` and the
build proceeds (latest-success semantics — rebuild the stale platforms if you need one
version). Agents must be running a build that understands `inputs`; older agents silently
ignore the field.

## Submodules

Checkouts are recursive — `git submodule update --init --recursive` runs after
checkout, so repos that keep dependencies as (nested) submodules build correctly
with no extra config.

## Status badge

A public SVG badge of the latest build status, for a README:

```
![build](http://<coordinator>:9876/api/projects/<id>/badge)
![build](http://<coordinator>:9876/api/projects/<id>/badge?product=<product>)
```

States: `passing` (green) · `failing` (red) · `building` (yellow) · `no builds`/`lost` (grey).

## Notifications

The coordinator runs a command of your choice when a build finishes — and that
command does the actual delivery (Smith's HTTP is plaintext-only, so HTTPS to
Slack/Discord is delegated to `curl`):

```sh
smith coordinator --notify-command /path/to/tools/smith-notify-webhook.sh   # failures only
smith coordinator --notify-command "..." --notify-on all                    # successes too
```

`tools/smith-notify-webhook.sh` is a ready template for Slack / Discord / ntfy —
set `SMITH_SLACK_WEBHOOK` / `SMITH_DISCORD_WEBHOOK` / `SMITH_NTFY_TOPIC_URL`. Your
command receives the build in env: `SMITH_STATUS`, `SMITH_PROJECT`,
`SMITH_PRODUCT`, `SMITH_VARIANT`, `SMITH_BUILD_NUMBER`, `SMITH_BRANCH`,
`SMITH_COMMIT`, `SMITH_JOB_ID`, `SMITH_NODE`, `SMITH_EXIT_CODE`, `SMITH_FAILED`.

On a desktop without the wx tray (e.g. headless Linux / GNOME), `tools/smith-tray.py`
puts a native tray icon in the top bar and toasts on broken builds with zero
build/install, and `tools/smith-notify.sh` gives just the toasts.

## Discord bot (Ollama-powered)

Smith can run a Discord bot that drives builds/deploys from chat and explains build
failures using a **local Ollama model**. Because Discord needs TLS (which Smith's C++
core avoids), the bot is a small Python process (`tools/smith-discord-bot.py`,
`discord.py`) that the coordinator **places on the agent with the most free GPU memory**
and points at that box's local Ollama. It talks to Smith over the normal LAN HTTP API.

Enable it in **Settings → Discord bot** (or the `discord` block of the coordinator
config): set the bot token, an optional notify channel + command-channel/role/user
allowlist, and the Ollama URL/model (default `qwen3.5:9b` — `ollama pull` it on the host
agent). The chosen agent auto-creates a Python venv under `<workspace>/.smith-discord`
the first time it hosts the bot.

- **Commands** (slash + natural language via the LLM): `/build`, `/deploy` (asks for
  confirmation), `/status`, `/explain <jobId>`, `/projects`, `/add-project`, `/cancel`.
  Mentions/DMs are routed through the model's tool-calling; any build/deploy/add/cancel
  is confirmed before it runs.
- **Notifications**: the bot subscribes to the coordinator's `GET /api/events` SSE feed
  and posts to the notify channel on build start / success / failure (per-event toggles).
- **Placement**: agents report NVIDIA VRAM (`nvidia-smi`) and whether a local Ollama
  answers; the coordinator runs the bot on the Ollama-equipped online agent with the
  largest TOTAL VRAM (capacity, not free — free fluctuates with builds), benches a host
  that fails to run the bot (`discord.hostFailureCooldownSec`), only migrates for a
  `discord.migrateMarginMb` capacity win, and `discord.pinNode` overrides everything.

## Batches & chains

A **batch** queues several builds in parallel (one job per product × variant) and,
only when **all** of them succeed, queues its `then` step — typically a deploy
whose rule consumes the freshly collected artifacts via `inputs`. Every job in a
batch is pinned to one commit (the branch tip at creation), so a mid-batch push
can't make platforms diverge.

A repo can name its batches in **smith.json** (`chains`); variants accept full
names or their **slug aliases** (`"Steam (Windows)"` ⇄ `steam-windows` — slugs
work anywhere a profile does, `/api/trigger` included):

```json
"chains": [{
  "name": "steam-release",
  "builds": [{ "product": "unity",
               "variants": ["steam-windows", "steam-mac", "steam-linux"] }],
  "then":   [{ "product": "steam-deploy" }]
}]
```

Run from the web UI (a `Run steam-release` button + an ad-hoc checkbox composer +
a live Batches list per project), from Discord (`/chain`, `/batches`, or plain
language — "run steam-release on soccer-boy"), or the API:

| Method & path | Action |
|---------------|--------|
| `POST /api/batch` `{projectId, chain, branch?}` | Run a named chain |
| `POST /api/batch` `{projectId, builds:[{product, profile?}…], then:[…]?}` | Ad-hoc batch (empty profile on a discovering product = all its variants) |
| `GET  /api/batch/:id` | One batch with per-job statuses |
| `GET  /api/projects/:id/batches` | Recent batches |

Config defaults (coordinator `batch` block; a chain or request can override
`onFailure`/`pinCommit` per use — defaults → coordinator config → smith.json/request):

| Key | Default | Meaning |
|-----|---------|---------|
| `batch.onFailure` | `"finish"` | On a failed build, siblings keep running (`"cancel"` aborts them); the `then` step never runs either way |
| `batch.pinCommit` | `true` | Pin all batch jobs to the branch tip resolved at creation |
| `batch.keep` | `50` | Settled batches retained in `batches.json` |

Related explicit knobs: `discord.migrateMarginMb` (default 2048) and
`discord.hostFailureCooldownSec` (default 600) govern bot placement migration.

## Trigger coalescing (one build per burst of commits)

The three commit-driven triggers — `poll` (smith.json), **autobuild** rules and
git **webhooks** — all mean the same thing: *build the tip of this branch*. So a
second one **replaces** a still-queued build of the same product + branch +
platform instead of queueing behind it. Ten pushes in ten minutes leave **one**
queued build, on the newest commit; the displaced ones settle as **`superseded`**
(a terminal status, greyed in the UI) and never run.

Without this, a queue that is one long build deep hands the next agent an
hour-old commit while newer ones wait behind it.

- **Only the same target coalesces**: a different product, branch, variant or
  platform pin is a separate queue slot.
- **Manual, rerun, retry and batch builds are never collapsed** — they're
  deliberate one-offs — and queueing one never supersedes anything.
- **`cancelRunningOnNewCommit`** (coordinator config / `--cancel-running-on-new-commit`,
  **default off**) extends this to the build already **running**: it is aborted so
  the newest commit starts immediately, and settles as `superseded`. Leave it off
  if commits can land faster than a build takes, or nothing ever finishes.
  Toggle it under **Settings → Build triggers**.

## Build controls (HTTP API)

| Method & path | Action |
|---------------|--------|
| `POST /api/trigger` `{projectId, product, branch?, profile?}` | Queue a build (profile accepts variant names or slugs) |
| `POST /api/builds/:jobId/rerun` | Re-queue with the same params |
| `POST /api/builds/:jobId/cancel` | Cancel queued, or abort running |
| `GET  /api/projects/:id/badge` | SVG status badge (public) |

In the web UI every in-flight build carries a **Cancel** button — on its row in a
project's build list, and on the build page next to the log.
