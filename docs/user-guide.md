# Smith user guide

Smith coordinates work; your repository scripts do the building and publishing.
A **coordinator** keeps projects, queues work and shows results. A **machine agent**
runs on a build computer, checks out code and executes those scripts. A **coding
assistant** is Claude Code or Codex: it is separate from the machine agent.

## Choose your setup

| Setup | Coordinator | Machine command | Project configuration |
| --- | --- | --- | --- |
| Cloudflare experiment | Hosted dashboard at `https://exp.redmarmosetstudios.com` | Packaged `Setup-Smith.bat` (Windows) or `sh start-smith.sh agent` (macOS/Linux) | Repository `smith.json` read by **Add project**, or operator-prepared presets pinned to full Git commits |
| Native / LAN | `Smith.exe coordinator` on your computer or server | `Smith.exe agent` | Repository-root `smith.json` |

These use different enrollment, authentication and APIs. A LAN agent does not
connect to the hosted coordinator. The hosted dashboard's **Add project** reads a
repository's `smith.json`, but not every native feature is available there. The
[configuration reference](smith-json.md) describes the native pipeline and the
hosted differences. [Planned user tasks](task-stubs.md) lists
workflows that have a stub but no implementation yet.

## First hosted build

1. Open the experiment dashboard. Studio staff choose **Continue with Google**
   with their `@redmarmosetstudios.com` account; the first sign-in creates their
   Smith account, with no invitation. Anyone else uses the operator's one-use
   invitation code, which lasts one hour, then links Google or GitHub with **Link
   Google / GitHub** on the dashboard to sign in that way later. After signing in,
   your browser session lasts seven days. Only configured providers appear.
2. Select a **Workspace**, or use **Create workspace** to make an empty one. A
   workspace contains its own members, machines, prepared projects, builds and
   settings. Switching workspaces changes what you see and where work is queued.
   Workspaces shared with the studio (**Settings → Workspace → Studio access**)
   appear on their own for studio Google accounts.
3. Use **Connect build machine** for shared build capacity. Use **Connect my
   computer** to enroll your own machine for personal coding chats. Personal
   enrollment associates the machine with your user and does not accept builds.
   Use a separate build enrollment when you need build capacity.
4. Download the package for the machine's OS and extract it to a dedicated folder
   such as `C:\SmithAgent`. Run the command shown in the enrollment dialog there (on
   Windows, double-click it) and paste the connect code when asked; it shows as `*****`.
   Machine enrollment codes last ten minutes and work once. A sign-in invitation,
   machine enrollment code, Smith access token and Cloudflare API token are
   different credentials and cannot substitute for each other.
5. On Windows the agent then runs in the background, starts at logon and reconnects
   by itself; on macOS/Linux keep its terminal open. Check that the machine appears online, with the correct
   OS and required labels. A label describes a capability; adding a label does not
   install a toolchain. Smith builds require Git access, Visual Studio C++ tools
   and a bootstrapped Una engine. Set `UNA_ENGINE_PATH` if its location differs
   from `C:\code\engine`.
6. Use **Add project** to pick a repository and optional branch; Smith reads its
   `smith.json` and offers a build action per product, each building the newest
   commit on the branch. On an operator-prepared project the source revision is
   pinned instead: a new push does not update that preset.
   No repository yet? Under **Start from**, choose **Nothing** for a new, empty
   project (one README commit) or **A .zip of the project's files** (up to 100 MB;
   a `.gitignore` in the zip is honoured and a `.git` folder is left out). With
   Smith's storage set up (Cloudflare Artifacts), Smith makes the first commit itself
   and keeps the project there, so no machine needs to be online; use **Clone** on the
   card to push to it. Build machines with **Keep copies here** take copies within
   their budgets, and builds run from those copies, served at
   `https://exp.redmarmosetstudios.com/git/<project>.git`; storage stays the home (see
   "Where projects live"). Without storage, or for a file over 32 MB or a project over
   1 GB, a machine that keeps copies creates the repository instead.
   Push a `smith.json` and the build actions appear (Smith reads it again after every
   push). Link it to GitHub later from the card if you like.
   Simple projects need no `smith.json`: with none, Smith runs a root `build.bat`,
   `build.ps1` or `build.sh`, builds a `package.json` project with npm, or packs a
   site with a root `index.html` into `site.tar.gz`. The card shows the default it
   uses. To have one written for you, add a **Pipeline setup** crew member.
7. Select the build row to read output, its result and any artifact downloads.
   **Refresh** fetches current state immediately; the page also refreshes
   automatically. Closing your browser does not cancel a build.

An empty workspace does not acquire projects automatically. Owners/admins add
them with **Add project**, or prepare pinned presets through the API described in
[operations](cloudflare/operations.md).

## Start, stop and update a hosted agent

From a source checkout, double-click `SmithAgent.bat` for **Install/update**,
**Start**, **Stop**, **Status**, **Find** and **Help**, or run those actions by name. The install folder
defaults to `C:\SmithAgent`; `SMITH_AGENT_HOME` selects another folder. Install
builds from that checkout and requires its build tools. The first start saves the
workspace ID and asks for enrollment. Subsequent starts reuse saved enrollment.

With an extracted Windows package, `Setup-Smith.bat` connects the machine and keeps
the agent running in the background from logon; `Setup-Smith.bat status`, `stop`,
`remove` and `reconnect` manage it. `Start-Smith.bat agent --workspace-id <id>` runs
the agent in the foreground instead; PowerShell users can use `Start-Smith.ps1`.
`Start-Smith.bat version` checks the executable without connecting.
`Start-Smith.bat help` and `Start-Smith.bat agent --help` explain its options.

`SmithAgent.bat stop` requests a graceful stop and waits for the current build to
finish. If it is still busy after ten minutes, the helper offers a forced stop;
the interrupted job can become `lost`. **Disconnect** in the dashboard revokes
credentials and fences active work; it is not a graceful pause. Re-enroll in a
fresh dedicated agent directory after revocation. Admins can drain a machine
through the API to prevent new builds while letting the current one finish.

For a manual graceful shutdown, launch with `--drain-file <absolute-path>` and
create that file when you want it to stop. Saved completion is reconciled before
exit. Remove the file before restarting. This waits for build work; stop any
active coding chat separately before shutting down its machine.

Hosted agents update themselves: when a newer package is published, each agent
installs it between builds and chats and restarts; if the new version is not
accepted it rolls back. Set `SMITH_AGENT_AUTO_UPDATE=0` to switch this off for one
machine. Agents older than self-update need one manual update (`SmithAgent.bat
update`). Enrollment is preserved. Keep running agents outside packaging output
directories. Do not share the credential/state folder or run two agents in the
same folder. Builds die with the agent on every OS (a job object on Windows, a
process-group sentinel on macOS/Linux).

## Understand build status

| Status | Meaning and next action |
| --- | --- |
| `queued` | Waiting for an active compatible machine with all required labels and a command for its OS. Check machine availability and project requirements. |
| `leased` | Assigned to a machine; checkout/startup is beginning. |
| `running` | The script is executing. Select the row to follow output. |
| `success` | Commands completed successfully and declared uploads were acknowledged. Download available artifacts. |
| `failed` / `error` | A command or setup step failed. Read the earliest useful error, including checkout/toolchain/output failures. |
| `cancelled` | Cancellation was accepted. Running work stops when the runner observes it; it may not stop instantly. |
| `lost` | The agent crashed, disconnected beyond its lease, or was revoked. Check the machine before explicitly queuing replacement work. Hosted builds have no automatic retry. |
| `superseded` (native) | A newer commit replaced an older queued automatic build. |

Hosted leases last 90 seconds and renew every 20 seconds. The agent watchdog
stops work before its lease expires. The machine's displayed **offline** threshold
is a workspace setting; it does not change these lease timers. Each agent runs
one build at a time. More enrolled compatible machines provide parallel builds.

**Cancel build** cancels the selected queued or active job. It cannot undo files
already written or publishing already performed by a repository script. A rerun
is explicit: choose the product action again. After a lost browser response, retry
the same action; Smith retains its request ID to avoid accidentally queuing twice.

## Logs and artifacts

Hosted build output is limited to 4 MiB per job. The browser retains the newest
500,000 characters; a truncation message means the displayed output is incomplete.
Settings control timestamps and whether new output scrolls the log to the bottom.
Elapsed timestamps start from the first output loaded in that view.

Hosted presets can declare up to **four exact output files**, each **1 byte to
20 MiB**, with `package: "none"`. Paths are relative to the build working
directory. Filenames must be portable, and their basenames must be unique even
when in different folders. No wildcard collection, input dependencies or built-in
handoff steps are supported. Create a zip in your script and declare that exact
zip if you need a folder. Downloads are available on successful builds to current
workspace members. Missing/oversized declared files fail the build.

The native coordinator also supports glob collection, built-in zip packaging,
artifact inputs and ordered handoffs; see [smith.json](smith-json.md).

## Large files (Git LFS)

Smith is a Git LFS server for every project in a workspace. Objects are kept in
Smith's storage (Cloudflare R2), not on the machines that serve git.

- **Smith-hosted repositories** need nothing: run `git lfs install` once on your
  computer, then `git lfs track "*.psd"` and push as usual. git-lfs finds the
  endpoint from the clone URL.
- **Repositories hosted elsewhere** (GitHub, …) opt in by committing `.lfsconfig`
  at the repository root; the project card's **Large files → Setup** shows it:

  ```ini
  [lfs]
  	url = https://<your coordinator>/git/<project>.git/info/lfs
  ```

Credentials are the ones git uses with Smith: a Smith token as the password,
read scope to fetch, build scope to push. Builds of a project that keeps large
files run only on machines that have git-lfs installed (label `git-lfs`) and
receive a short-lived ticket for the objects.

**Settings → Large files** shows what the workspace keeps and the mode. Out of
the box objects move through the coordinator, up to 100 MB each (a Cloudflare
limit). Giving the coordinator an R2 API token as two secrets (see Operations)
sends objects straight to R2 instead, up to 5 GB each. The workspace quota
(default 5 GB) refuses a push past it with the numbers.

**Copies on your machines.** Switch **Keep copies here** on a build machine's card and
it keeps copies of large files as well as repositories, within its budget (see "Copies
and budgets"); the card shows what it holds and whether it is full. If an object ever
goes missing from storage, a machine holding a copy sends it back on its own, and
**Check large files** in Settings verifies every object on request. Switching a machine
off drops its copies; storage still has the objects, and other machines take over where
they can.

Files over the import threshold (Settings → Large files) are moved to large files when
a repository is imported from GitHub; see "Import from GitHub".

## Where projects live

A project copied into Smith has a home: **Smith's storage** (Cloudflare Artifacts, reached only through this site's
git address) or **a build machine**. Storage is the home whenever Smith has it and the repository is under 1 GB; a
repository too large for storage lives on a machine that keeps copies, and its card says so. Whichever the home,
the clone address is the same, `https://<site>/git/<project>.git`, with a Smith token or git credential as the
password, and large files (Git LFS) work with no setup.

A project on a machine shows **Move to storage** (owners and admins): every branch and tag is pushed into storage,
and the machines' copies become copies. A project in storage whose repository went missing shows **Restore to
storage**, which pushes a machine's current copy back.

## Copies and budgets

Build machines switched on to **Keep copies here** hold copies of the workspace's repositories and large files, as
a second place beside the home. Each machine has a budget (the workspace default from Settings → Copies, or its
own, set on its card), and Smith places each item on as many machines as Settings → Copies asks for (two by
default), choosing the machines with the most unused budget. A machine over its budget hands one item at a time to
the others. The card says what a machine holds ("uses 12 GB of 50 GB: 8 repositories, 340 large files") and when
it is full; a project's card says which machines hold it, and Settings → Copies lists what has fewer copies than
asked, with the machines that are full.

## Import from GitHub

**Projects → Import from GitHub** (owners and admins) copies every repository of a GitHub organisation into Smith's
storage. Pick the organisation (from your GitHub link, or the workspace token in Settings, or type its name), tick
the repositories, and Import. Each becomes a project behind this site's git address, with its `smith.json` read
and its build actions ready.

Files over the threshold (Settings → Large files, 10 MB unless you change it; at most 32 MB, the largest file
storage takes) are moved to large files, whether or not the repository used Git LFS before. That rewrites the
repository's history, so such a repository is **detached from GitHub** (Pull and Push would never match again) and
its original history is kept as a bundle you can download from the card. Repositories with nothing over the
threshold are imported as they are and stay linked to GitHub unless you untick "Stay linked".

The dialog shows progress and lets you Retry a repository that failed or Cancel what has not finished. A repository
over 1 GB after the rewrite goes to a build machine instead. Import needs an online build machine whose agent is
current and has git-lfs installed; a queued import says which machine to update.

## Work with AI on your computer

Enroll using **Connect my computer**, install the coding CLI on that computer
(the chat page can install and sign in to it for you), and sign in there as the
account running the machine agent. The agent
reports detected CLI versions; a tool installed only in another user's profile
may not be visible. Detection refreshes periodically; restart the agent after a
new install if it is not offered yet.

Choose **Assistant**, **Project**, **Computer**, **Model** and **Permissions**, then
write a message and press **Start chat** (or Ctrl+Enter). Only your own enrolled
computers can use your Claude/Codex login. Work takes place in a separate session
checkout on that machine, on a Smith session branch. It does not edit your normal
checkout. Follow-up messages resume that session; **Stop** interrupts its turn.
Smith records resulting changes as commits on the chat's branch, reports the
commit, and pushes the branch from your computer with its own Git login after
each reply (**Keep this chat on my computer only** in the chat's menu stops
that; **Push branch** pushes once). **Verify** pushes and queues a build of the
commit. Open and review the pull request yourself. See [AI chat](cloudflare/ai-chat.md)
for details.

| Assistant mode | What it allows |
| --- | --- |
| Claude Code: Accept edits | File edits in the session checkout. Other actions requiring approval are refused and reported. |
| Claude Code / Codex: Ask before each action | A card asks before each edit or command: Allow, Always allow in this chat, or No with an instruction. Unanswered questions are declined after 15 minutes. |
| Claude Code: Plan only | Read and plan; no changes. |
| Claude Code: Bypass permissions | Commands on your computer without asking. Choose only for a project you trust. |
| Codex: Edit files (sandboxed) | File changes and commands within the CLI's workspace sandbox; extra access is refused. |
| Codex: Read only | Read and answer; no changes. |
| Codex: Full access (no sandbox) | Commands without the workspace sandbox. Choose only for a project you trust. |

If an action is refused in a restricted mode, explain the constraint in your next
message, switch the chat to **Ask before each action**, or perform that action
locally. Deployment environment
credentials are removed from coding turns, but full-access modes still run with
your OS user's access and can reach other credentials on disk.

Use **Search chats** to find server-stored chat titles/messages. The chat menu
supports rename, pin/unpin, archive/unarchive and export; **Archived** shows
archived conversations. Sending to an archived chat brings it back. Opening a
chat restores its conversation; it does not rerun a completed turn. Chats are
private to their owner. Smith stores conversation history and relays CLI events;
your provider login remains on your computer and provider usage is billed to you.

The **share local Ollama models** checkbox on your machine card lets other
workspace members chat on that machine with its local models. It never shares
your Claude/Codex login or `:cloud` models; their chats can only edit or read their
own copy and cannot Push or Verify. Your card lists who is chatting, with a Stop
for each. **Crew** members are named AI members that work on projects on a
schedule, after builds or on demand, and report proposals for a person to review;
see [Crew](cloudflare/ai-chat.md#crew).

## Let an external coding assistant use Smith

Under **Use Smith from Claude Code or Codex**, create a named token for each tool
or computer. Choose 7, 30 or 90 days. Uncheck **Allow starting and cancelling
builds** for read-only access. Copy the token immediately; only its fingerprint is
stored, so you cannot reveal it later. Follow the displayed plugin/direct MCP
setup instructions. Windows `setx` affects newly opened terminals.

Tokens can read projects, machines, build status, logs and artifacts; tokens with
build permission can start/cancel builds. They cannot administer membership,
deploy, or read chats. A build script can still have its own publishing behavior,
so granting build permission authorizes that project's script. **Revoke** stops
future token use immediately. Replace an expired/lost token with a new one.
See [agent access](cloudflare/agent-access.md) for full integration instructions.

## Hosted settings

**Settings → Your account** follows you across workspaces. Display name controls
how Smith identifies you. E-mail is saved for future notifications; saving it does
not change your linked sign-in identity or send notifications today. Time zone,
12/24-hour clock, timestamp style, follow-output and refresh interval (2–60
seconds) control display. Save the account to apply and persist them.

**Settings → Workspace** affects the selected workspace. Only owners/admins may
save it; members can inspect it. Workspace name is a display label. Machine
offline threshold accepts 15–3,600 seconds. **New build replaces a queued build
of the same product** supersedes matching waiting jobs; it does not cancel running
work. A project can override it under **Copy and push**: **New build replaces a
waiting build of the same action on <branch>** keeps only the newest waiting build
of each action on that branch, so ten quick pushes build once, on the latest commit.
Read the project's pinned source revision before starting another build.

**Studio access** shares the workspace with every studio Google account: pick
the role they join with (viewer, operator or admin), or *Not shared*. They join
the next time they load the dashboard; turning it off removes them again.
**Settings → People** lists everyone in the workspace. Owners and admins change
roles and remove people (a removed person stays out until **Let back in**), and
anyone can leave. A role set by hand is kept when Studio access changes. Only an
owner changes ownership, and the last owner cannot leave.

The optional workspace **GitHub** token is used only to read `smith.json` when
nobody in the workspace can link GitHub; it never reaches builds or assistants.
The **Crew** settings set concurrent runs, a daily spend limit, an optional
write-only Anthropic API key, whether crew may create projects, and **Stop all crew**.

The workspace Cloudflare Account ID and write-only API token are injected into
builds as `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` when a machine claims a
job. Every build in the workspace can read them. Leave the token field blank to
keep the current token; check **Remove the stored token** to delete it. Saving a
token does not deploy Smith, run a script or enable built-in hosted handoffs. Scope
the token to the resources the repository script needs. Removing it does not
recall credentials already delivered to an active build.

## Native coordinator and agent

For a single machine, run:

```powershell
.\Smith.exe coordinator --project C:\path\to\repo --with-agent --agent-labels unity6
```

Open `http://localhost:9876`. The **Dashboard** shows builds, **Projects** adds
repositories and selects products/branches/variants, **Agents** filters machine
status/labels, and **Settings** manages runtime options and users. A separate
machine runs `Smith.exe agent --coordinator http://BUILD-HOST:9876 --labels unity6`.
Use a configured shared `--token` for non-loopback requests. LAN auto-discovery
uses UDP 9877 unless you pin the coordinator URL or disable discovery. WAN access
needs a TLS proxy/tunnel around the native HTTP server.

The coordinator loads `smith-coordinator.json` from its working directory or the
file given by `--config`. CLI scalar flags override file values; project lists
append. This is separate from repository `smith.json`. A valid runtime config is
copied to `.lkg.json`; malformed edits show a banner and may use that last good
copy. Fix the source file and restart before saving settings.

**Trigger** queues a manual build. **Branch** defaults to the primary repository's
configured branch; **Platform** chooses the OS of the machine that runs the
command, not automatic cross-compilation. **Clean** deletes untracked and ignored
files in the agent checkout before building, including build caches. A variant
comes from the product's discovery matrix. Named chains and **Queue batch** run
selected builds and gate follow-up work on their success.

**Autobuilds** stores polling rules on the coordinator without changing the repo.
A new polling rule records a baseline first; it builds on the next commit change.
Trigger manually for the first build. New commit-driven builds replace still
queued matching work. Cancelling a running build on new commits is a separate,
off-by-default setting. The build page includes diagnostics, full-log download,
artifacts, cancellation and rerun controls. **Clear history** deletes retained
history/output; it is not a machine cleanup or a project reset.

Native settings also include these optional integrations. They are configured on
the native coordinator, independently of hosted workspace settings:

| Setting | What to supply / what happens |
| --- | --- |
| Private GitHub repositories | Save a GitHub token with repository read access; eligible agents receive it for HTTPS Git authentication. Empty uses each machine's own Git credentials. Keep it private. |
| Google sign-in | Set the runtime `auth.googleClientId`, allowed domains/emails, admin emails and `requireLogin`. Use a secure origin and `curl` for verification. See [Google setup](google-auth.md). |
| Dynamic DNS | Supply an existing Cloudflare A record, its zone and a scoped DNS-edit token. Proxied keeps Cloudflare proxying; interval is seconds between public-IP checks. Saving/applying can update that DNS record. Leave record/token unset to disable. |
| Discord bot | Enable with a private bot token, notification channel and optional application/guild IDs. Command channel and role/user lists restrict who can issue commands; empty allowlists broaden access. The host needs Python, discord.py and its Ollama model. |
| Bot host and model | Host node pins a hostname; empty lets Smith select a suitable GPU agent. Ollama URL is reached from that agent. Model names must already be pulled there. These are separate from hosted personal coding chats. |
| Bot notifications | Start/running/success/failure checkboxes select posted events. Running phase notices can be noisy. Confirm deploys requires the bot's confirmation step for publishing actions. |
| Users | Display name, Google e-mail for sign-in, comma-separated Git author e-mails for failure attribution, and own-failures-only notification preference. Removing an entry removes that stored user; inspect the runtime auth allowlists separately. |
| Completion hook | Runtime `notifyCommand` runs on completion with `SMITH_*` build details; `notifyOn` is `failed` (default) or `all`. Supply your own script/destination. |

Copy `smith-coordinator.example.json` for runtime configuration, including
non-UI options. Runtime `env` reaches every build agent; rule `env` overrides it.
Treat injected values as readable by every machine/script that receives a job.
Native agent workspace housekeeping has a 5,120 MiB free-space floor, a 14-day log
age cap and a 200-log count cap by default. `smith help agent` explains their
override flags; hosted agents use a separate state/lease model.

Run `Smith.exe help coordinator`, `Smith.exe help agent` or
`Smith.exe help hosted-agent` for options and examples. Run agents under a real
build account so Git credentials, toolchains, signing keys and network access
are available. [README](../README.md) covers building Smith and OS startup wrappers.

## Troubleshooting

| Problem | Check / recovery |
| --- | --- |
| Google/GitHub says not linked | Studio Google accounts never see this. For any other account: sign in with a new invitation, then link that provider from the dashboard. |
| Invitation/enrollment rejected | Use the correct type of code; obtain a fresh one if used or expired. Check workspace selection. |
| Machine absent/offline | Run `Setup-Smith.bat status` (Windows) or keep its macOS/Linux terminal running; check HTTPS access, correct workspace ID, agent errors and credential revocation. |
| Build stays queued | Check active machines, command OS, all required capability labels and whether another build occupies the agent. |
| Checkout fails | Authenticate Git as the same OS user running the agent; confirm repository access and that the full pinned commit was pushed. |
| Smith compiles on one machine only | Check `UNA_ENGINE_PATH`, engine revision and installed toolchain on the failing machine. Labels alone do not supply tools. |
| Declared artifact missing | Check working directory, exact filename, size and packaging mode. Hosted artifacts cannot contain wildcards. |
| Chat cannot start | Use personal enrollment, your own online machine and a detected supported CLI. Sign in to that CLI locally. |
| Chat action refused | Read the selected permission mode, or switch to **Ask before each action** to approve actions from the chat. |
| Agent workspace already locked | Stop the existing process or choose another dedicated folder; never copy active credential state to another agent. |
| Build becomes lost | Inspect the original machine and logs before rerunning; scripts may have completed some side effects before interruption. |
| Native config banner | Repair JSON in the indicated runtime config and restart; settings saves are blocked until repaired. |
| Dashboard cannot reach Smith | Check connectivity and retry Refresh. The existing build continues independently of the browser. |

For operator provisioning, API limits and release/rollback procedures, use
[operations](cloudflare/operations.md) and [self-release](cloudflare/self-release.md).
Building a release candidate does not activate it. Deploying the coordinator and
updating machine agents are separate actions.
