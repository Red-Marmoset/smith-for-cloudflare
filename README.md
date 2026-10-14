# Smith

**System for Managed Integration, Testing & Handoff** — a small, dependency-light
build & deploy orchestrator for a LAN of build machines. Think Jenkins/Travis, but
the pipeline lives *inside each repo* and the whole thing ships as a single
self-contained binary per OS with nothing extra to install.

> Status: **working.** The coordinator, agents, vanilla web UI, the four triggers
> (manual / git-poll / cron / webhook), multi-project checkout-by-URL with a
> co-located agent, the desktop tray, single-binary asset embedding, and the
> handoff built-ins (script / copyShare / steam / itch / cloudflare) are all in
> place and covered by tests. On top of that: parsed **build diagnostics**
> (errors / warnings / tests) in a hierarchical, collapsible dashboard; **non-blocking
> multi-project add** with git-URL validation and a persisted request list; a
> **settings** area with clear-build-history and flat-file **user accounts**; and
> **failure attribution** (toast the person whose commit broke the build). The wx-free
> console binary builds for Windows, macOS and Linux from one source set; validating
> live macOS/Linux agents needs that hardware. See the plan referenced in `CLAUDE.md`.

## What it does

User documentation: [coordinator/agent setup, help and troubleshooting](docs/user-guide.md),
[complete smith.json reference](docs/smith-json.md), and [planned user-task stubs](docs/task-stubs.md).
Both dashboards include **Help** with the same locally served guides. CLI:
`Smith.exe help coordinator`, `Smith.exe help agent`, `Smith.exe help hosted-agent`
(or `<command> --help`). Help exits without starting services or enrolling a machine.

After editing these guides, run `npm run build:help` in `cloudflare/coordinator`,
then `python tools/gen-web-assets.py` to refresh the native embedded assets.
Generated help is committed so native builds require no Node.js documentation step.

- You run a **coordinator** on one machine (web UI + build queue + history + git
  webhooks) and an **agent** on each build machine (Windows / macOS / Linux).
- A **project** is one or more git repos plus a `smith.json` at the repo root that
  declares **build products** and **build rules**: which branch, which kind of
  node (OS + capability labels), which **script in the repo** to run, what
  artifacts to collect, and an optional ordered list of **handoff** (deploy)
  steps.
- The agent checks out the right branch/commit, runs the repo's build script with
  live log streaming, collects artifacts, runs handoff steps, and reports back.
- The guiding idea: **the repo's own script owns the work; Smith just orchestrates
  it** (node selection, checkout, invocation, logs, history, triggers, status). A
  project whose script already builds and deploys needs nothing more than "run
  this script on a Windows node."

## Design constraints

- **Least dependencies; nothing extra to install.** Deploy = copy one binary and
  run it. Built in C++ on the [Una engine](../engine); persistence is flat files
  (no database); the web UI is vanilla HTML/JS (no framework); transport is plain
  HTTP on the LAN. Build toolchains (Unity, Xcode, Android SDK, git, steamcmd,
  butler, wrangler) are inherent prerequisites of building, assumed present on the
  nodes that need them — they are not Smith's own dependencies.
- **Headless agents.** The engine core and Smith's build path link **no**
  wxWidgets, so Linux/server agents are GUI-free. Only the optional desktop tray
  (`SmithTray`) links wxWidgets.

## Building (Windows)

Agents maintain supported global CLI tools automatically while idle. See
[automatic agent tool updates](docs/agent-tool-updates.md) for supported
installations and the opt-out setting.

The `feature/cloudflare-experiment` branch also has a **build-experiment** Smith
product. It builds the native console binary and packages agent launchers
targeting **https://exp.redmarmosetstudios.com**, collecting
`smith-experiment.zip`. See [experiment setup and current transport limitations](config/experiment/README.md).
To produce the package locally, run the normal Smith Release build below, then
`python tools/package-experiment.py` (`python3` on Linux/macOS). Output is
`Build/SmithExperiment/Release/`. Packaging requires Python 3; extracted packages
use PowerShell or POSIX shell launchers. The coordinator's target platform is
Cloudflare Workers; no local coordinator or tunnel is included. No deployment is
performed by this product. The hosted coordinator can keep its own copy of a project's
repository on the workspace's build machines and serve it at
`https://exp.redmarmosetstudios.com/git/<project>.git` (clones, fetches and pushes all
go through the coordinator; nothing on a machine is exposed), or copy it into
Cloudflare Artifacts where an account has that; see
[Smith-hosted repositories](docs/cloudflare/operations.md#smith-hosted-repositories) and
[Cloudflare Artifacts](docs/cloudflare/operations.md#cloudflare-artifacts-copy-a-projects-repository).

The hosted coordinator also serves an MCP server so Claude Code and Codex can list
projects and machines, start builds and read logs with a Smith token; this repo is a
Claude Code plugin marketplace for it (`/plugin marketplace add Red-Marmoset/smith`).
See [using Smith from Claude Code, Codex and git](docs/cloudflare/agent-access.md).

Windows batch helpers for the experiment, run from the repository root:
`SmithAgent.bat` (double-click for a menu: install/update this computer's agent into
`C:\SmithAgent` and set it up to run in the background from logon, stop it cleanly, show
its status, or find agents already on this computer),
`RunTests.bat` (all test projects), `PackageAgent.bat [--install <agent folder>] [--upload]`
(build + agent package), `DeployWorker.bat` (checks, then deploys the hosted
coordinator after asking), `NewInvite.bat` (a one-use sign-in code) and
`SetupSignIn.bat google|github` (turn on Google/GitHub sign-in; see
[signing in](docs/cloudflare/sign-in.md)).

The Una engine must be bootstrapped first (see `../engine`). Then:

```powershell
.\Build.bat                 # Release build -> Build\Smith\Release\Smith.exe
.\Build.bat -Config Debug
.\Build.bat -Clean          # nuke caches then rebuild
.\Build.bat -Project SmithTray   # optional tray -> Build\SmithTray\Release\SmithTray.exe
.\RunTests.ps1              # build + run the test projects under Tests\
```

Linux / macOS: `./Build.sh`.

Quick check:

```powershell
.\Build.bat
.\Build\Smith\Release\Smith.exe version
```

## Running it

```powershell
# One machine = a complete Smith: coordinator (web UI + API on :9876) plus a
# co-located build agent in the same process.
.\Build\Smith\Release\Smith.exe coordinator --with-agent --agent-labels windows,unity6

# A standalone agent on another build machine, advertising capability labels:
.\Smith.exe agent --coordinator http://BUILD-HOST:9876 --labels unity6,steamcmd

# Add a project by git URL — Smith clones its own copy and reads its smith.json
# (or use the web UI's "Add project" form):
.\Smith.exe coordinator --project-repo https://github.com/org/repo.git --with-agent
```

Open `http://localhost:9876` for the dashboard, or run **`SmithTray.exe`** — it
bundles a coordinator + co-located agent and puts Smith in the system tray
(double-click the icon to open the UI). Triggers are declared in each repo's
`smith.json` (`manual` / `poll` / `schedule` / `webhook`); point a GitHub webhook
at `POST /api/webhook/git/<projectId>`.

## Autobuilds (poll & build from the web UI)

Besides the repo-declared `smith.json` triggers, you can set up **autobuild rules**
from the web UI — no repo change needed. Expand a project on the dashboard and use
the **Autobuilds** panel to add a rule: a **branch**, a **poll interval** (e.g. every
5 min), a **build product**, and an optional **target platform**. Smith then polls
that branch and, when its commit changes, queues a build of that product. Rules are
per project, and you can have several (different branches, products, or platforms).

- **Target platform** (`windows` / `mac` / `linux`, or *any*) pins the build to a
  node of that OS, where the product's matching per-OS command runs natively — so one
  product can be built for all three from the dropdown (manual triggers have the same
  platform selector). Building "for mac" needs a mac agent connected; until then the
  build simply waits in the queue.
- Rules live **server-side** in `autobuilds.json` (in the data dir, gitignored), so
  they work for any project — including ones whose `smith.json` only has a `manual`
  trigger, and a coordinator's own repo run via `--project` (a local git tree is
  polled **fetch-only** — Smith never touches your working copy).
- **A branch builds with its own `smith.json`.** Type a branch and the product list
  (Autobuilds and **Trigger ▶** alike) becomes the products *that branch's*
  `smith.json` declares with a rule for it — so a feature branch can autobuild a
  product it hasn't merged yet. Smith reads it with `git show origin/<branch>:smith.json`;
  the project's own definition and checkout stay on the tracked branch. Poll,
  autobuild, webhook, manual and rerun builds on that branch all use its rules.
- A new rule **baselines first** (records the current commit without building); it
  builds on the *next* change. Use **Trigger ▶** for an immediate one-off build.
- A burst of pushes builds **once, on the newest commit**: a fresh poll / autobuild /
  webhook build **replaces** a still-queued build of the same product, branch and
  platform rather than joining the queue behind it (the displaced ones are marked
  `superseded`). Manual builds and reruns are never collapsed. If you also want the
  build already *running* abandoned for the newer commit, turn on
  **Settings → Build triggers → Cancel the running build on a newer commit**
  (`--cancel-running-on-new-commit`) — off by default, since commits arriving faster
  than a build takes would mean no build ever finishes.
- Any in-flight build can be stopped with **Cancel** — on its row in the build list
  or on the build page.

## Artifacts (collecting build output)

A build rule's `artifacts` says what to keep. Files are matched **relative to the
workspace** by glob (`*` = one path segment, `**` = any depth), then either bundled
into one archive (`"package": "zip"`) or uploaded individually (`"package": "none"`,
which is capped — use `zip` for many files).

The robust pattern for a whole output folder (e.g. a Unity player + its `_Data/`):

- Set **`outputPath`** on the product, e.g. `"builds/${PROFILE_SLUG}"`. Smith exposes it
  to the build as **`${OUTPUT}`** (plus `${PROFILE}` / `${PROFILE_SLUG}` for the chosen
  variant), so your script writes the build there.
- That's all you need: a product with `outputPath` and **no explicit globs** auto-collects
  the **entire `${OUTPUT}` folder** as one zip (named after the profile). Or be explicit:
  `"artifacts": { "globs": ["${OUTPUT}/**"], "package": "zip", "archiveName": "${PROFILE_SLUG}.zip" }`.

The agent logs what it collected (`ARTIFACTS: collecting N files, X MB`), retries each
upload 3×, and never silently drops a file from the zip; a build that produced nothing
warns with the globs it tried. Large archives are fine (a 200 MB artifact round-trips
intact). Download from the build page or `GET /api/builds/<jobId>/artifacts/<name>`.
A later job can consume collected artifacts by declaring `inputs` on its rule — Smith
stages them into its workspace before the command runs (see "Artifact inputs (fan-in)"
in `docs/FEATURES.md`); that's how a deploy job gathers per-platform builds.

## Remote / WAN coordinators

Agents normally find the coordinator by **LAN auto-discovery** (a UDP broadcast) when
no `--coordinator` is given. Pass an explicit URL and discovery is off — the agent
never broadcasts and never self-heals by rescanning, which is what you want off the
LAN:

```powershell
.\Smith.exe agent --coordinator https://smith.example.org --token <shared-token>
```

- **Auth is required off-LAN.** The bearer token is bypassed only for a *direct*
  loopback request, so any non-loopback agent must send `--token`. Behind a reverse
  proxy on localhost the bypass is also withheld (Smith treats an `X-Forwarded-For`
  request as remote), so the proxy can't lend its loopback bypass to a remote client.
  Start the coordinator with `--token <secret>` (add `--require-token` to demand it
  even locally).
- **TLS is out of scope by design** (Smith speaks plain HTTP — no OpenSSL). To reach a
  coordinator over the internet, put it behind a **secure tunnel or TLS reverse proxy**
  instead of binding a public IP: Tailscale / WireGuard, a Cloudflare Tunnel, an SSH
  tunnel, or nginx/Caddy terminating TLS in front of `127.0.0.1:9876`. Smith stays
  plain-HTTP + bearer-token; the transport is secured outside it.

## Configuration file

Instead of passing flags on every launch, the coordinator can read a JSON config file.
It loads `--config <path>`, or a `smith-coordinator.json` in the working directory if no
`--config` is given. **Any CLI flag overrides** the matching value in the file, so you can
keep a base config and tweak per-run.

Every time the file loads cleanly, the coordinator copies it to a **last-known-good** file beside it
(`smith-coordinator.lkg.json`). If a hand edit breaks the JSON, the coordinator starts on that copy
instead of silently dropping the whole file (which used to take sign-in, the embedded agent and the
Discord bot down with it). The parse error, with line and column, is shown as a banner on every page,
posted by the Discord bot to its notify channel, and printed to stderr. Settings saves are refused
until the file is fixed and the coordinator restarted. `GET /api/config/status` reports the same state.
The file is re-checked while Smith runs, so an edit that breaks it is flagged before the next restart.

Copy [`smith-coordinator.example.json`](smith-coordinator.example.json):

```json
{
  "port": 9876,
  "withAgent": true,
  "agentLabels": ["unity6"],
  "env": { "UNA_ENGINE_PATH": "C:\\code\\engine" },
  "auth": {
    "googleClientId": "<id>.apps.googleusercontent.com",
    "allowedDomains": ["redmarmosetstudios.com"],
    "allowedEmails": [],
    "adminEmails": [],
    "requireLogin": true
  }
}
```

```powershell
.\Smith.exe coordinator                               # uses ./smith-coordinator.json if present
.\Smith.exe coordinator --config C:\smith\prod.json
.\Smith.exe coordinator --config base.json --port 9999  # the flag wins over the file
```

Keys mirror the flags: `host`, `port`, `dataDir`, `webDir`, `token`, `requireTokenAlways`,
`pollIntervalSec`, `discovery`, `discoveryPort`, `withAgent`, `agentLabels`, `projects`,
`projectRepos`, `notifyCommand`, `notifyOn`, `env`, the `auth` block (Google sign-in), and
the `dns` block (dynamic DNS, below). `projects` / `projectRepos` from the file and the CLI are combined.

## Dynamic DNS (Cloudflare)

Behind a dynamic home IP the public DNS record drifts and Cloudflare returns **522**
(can't reach the origin). The coordinator can keep its own record current — add a `dns`
block to `smith-coordinator.json`:

```jsonc
"dns": {
  "provider": "cloudflare",
  "apiToken": "<Cloudflare API token, DNS:Edit on the zone>",   // secret, never logged
  "zone": "redmarmosetstudios.com",
  "record": "smith.redmarmosetstudios.com",
  "proxied": true,            // keep the orange cloud
  "intervalSeconds": 300
}
```

It is **off** unless `record` + `apiToken` are set. Every `intervalSeconds` the coordinator
checks its public IP (via `curl`) and, only when it changes, updates the Cloudflare A record
through their API (also `curl` — Smith has no TLS). Create the token in the Cloudflare
dashboard (My Profile → API Tokens → *Edit zone DNS*, scoped to the zone); the A record must
already exist. The token lives only in the operator's config file, never the repo.

## Authentication (Google Workspace sign-in)

By default the human UI/API is open on the LAN (and gated only by `--token` off-LAN, as
above). You can optionally require **Google sign-in**, restricted to one or more Google
Workspace domains and/or an explicit per-person email allowlist:

```powershell
.\Smith.exe coordinator --google-client-id <id>.apps.googleusercontent.com `
  --google-allowed-domains redmarmosetstudios.com --require-login
```

(Or put these under the `auth` block of the [config file](#configuration-file) so you don't
repeat them each launch.)

- **Off unless `--google-client-id` is set** — nothing changes for existing setups.
- **Build agents are unaffected** — they keep using `--token`; only the browser UI/data
  routes require a session. Add a specific outside-domain person with
  `--google-allowed-emails a@x.com` or by adding them (with their Google email) under
  **Settings → Add user**.
- Smith stays plain-HTTP with no crypto: the Google ID token is verified by shelling out
  to **`curl`** (Google's `tokeninfo` endpoint) and sessions are opaque tokens in
  `sessions.json`. So `curl` must exist on the coordinator host (built into Windows
  10+/macOS/Linux), and for any non-localhost origin you must serve the UI over **HTTPS**
  (via the tunnel / reverse proxy above) — Google sign-in requires a secure origin.

Full setup — creating the OAuth client, every flag, and the access model — is in
**[docs/google-auth.md](docs/google-auth.md)**.

## Run an agent on startup

Smith has no service-install subcommand — it stays a plain binary and leans on
each OS's native startup mechanism. The agent simply re-registers and resumes
long-polling whenever it (re)starts, so any "run at boot / keep alive" wrapper
works. In every example below, point `--coordinator` at your build host and pass
the capability `--labels` this machine advertises. (On a single LAN you can drop
`--coordinator` entirely and let the agent auto-discover the coordinator by UDP
broadcast — but pinning the URL is more predictable for an unattended service.)

Tip: run the agent under a **real build user**, not a bare system account, so it
inherits the toolchain on `PATH`, git credentials, signing keys, and any
network/mapped drives the builds need.

### Windows — Task Scheduler

Runs without anyone logged in; `schtasks` ships with Windows (no extra install).
Run this once from an elevated PowerShell:

```powershell
schtasks /Create /TN "Smith Agent" /SC ONSTART /RU "DOMAIN\builduser" /RP * `
  /TR 'C:\code\smith\Build\Smith\Release\Smith.exe agent --coordinator http://BUILD-HOST:9876 --labels windows,unity6' `
  /RL HIGHEST /F
```

`/RP *` prompts for that user's password (stored so the task runs whether or not
they're logged on). Use `/RU SYSTEM` (drop `/RP`) only if the builds need nothing
from a user profile. Manage it later with `schtasks /Run|/End|/Delete /TN "Smith Agent"`.

### macOS — launchd

A per-user **LaunchAgent** runs when that user logs in; a **LaunchDaemon** in
`/Library/LaunchDaemons` runs at boot before login. Save as
`~/Library/LaunchAgents/com.smith.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.smith.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/smith/Smith</string>
    <string>agent</string>
    <string>--coordinator</string><string>http://BUILD-HOST:9876</string>
    <string>--labels</string><string>mac,steamcmd</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/smith-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/smith-agent.log</string>
</dict></plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/com.smith.agent.plist   # enable + start
launchctl unload ~/Library/LaunchAgents/com.smith.agent.plist    # stop + disable
```

### Linux — systemd

A user unit (`systemctl --user`, needs `loginctl enable-linger <user>` to run
without an active session) or a system unit in `/etc/systemd/system/smith-agent.service`:

```ini
[Unit]
Description=Smith build agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/opt/smith/Smith agent --coordinator http://BUILD-HOST:9876 --labels linux,docker
User=builduser
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now smith-agent     # start now + on every boot
journalctl -u smith-agent -f                # follow its logs
```

(Prefer the system tray instead? `SmithTray` started via the OS's normal
login-item mechanism gives you a coordinator + co-located agent on a workstation.)

## Layout

```
Modules/
  SmithProtocol/   # shared coordinator<->agent wire types + JSON (de)serialization
  SmithCore/       # domain model, flat-file store, smith.json parsing, streaming
                   # subprocess, handoff builders (no HTTP, no wx)
  SmithCoordinator/# HTTP API + web UI + build queue + triggers + embedded web assets
  SmithAgent/      # register, long-poll, checkout, build, collect artifacts, handoff
  SmithApp/        # entry point + subcommand dispatch (coordinator | agent)
  SmithTray/       # optional wxWidgets desktop tray (the only module linking wx)
Workspaces/Projects/Smith/Project.json        # wx-free console binary
Workspaces/Projects/SmithTray/Project.json    # desktop tray binary
Build.ps1 / Build.bat / Build.sh / RunTests.ps1
```

The engine gained a reusable `Http` module (a thin wrapper over the bundled
`cpp-httplib`) as part of this work — see `../engine/Modules/Http`.

## Safety

During development Smith is exercised with all real deploy/publish side-effects
**skipped**. The first real deploy (Cloudflare, Steam, itch, a production push) is
run by a human, with explicit authorization, once the tool is trusted.

---

Authored with Claude (`--author="Claude <noreply@anthropic.com>"`).
