# Smith Cloudflare experiment

Open **https://exp.redmarmosetstudios.com** with an experiment invitation. Select
Smith and click **Build** to run the prepared pinned revision on a connected
Windows machine. The coordinator, dashboard, sessions, queue and build logs run
on Cloudflare; native compilation runs on the enrolled machine.

## Connect a Windows machine

1. Download the Windows package from **Connect build machine** in the dashboard and
   extract it into its own folder, for example `C:\SmithAgent`.
2. Double-click **`Setup-Smith.bat`** in that folder.
3. Paste the **connect code** shown in the same dashboard dialog and press Enter (it
   shows as `*****`). It carries both the workspace and a one-use enrollment code.

That is all. The agent runs in the background with no window, starts by itself when
you log on to Windows (a per-user Run entry; no administrator rights needed),
restarts if it ever stops, and reconnects on its own after network or coordinator
outages. Its output goes to `agent.log` in the folder. Running `Setup-Smith.bat` again
is always safe.

| Command | What it does |
| --- | --- |
| `Setup-Smith.bat status` | Is it running? Shows the end of `agent.log`. |
| `Setup-Smith.bat stop` | Stops it; a running build finishes first. It starts again at next logon. |
| `Setup-Smith.bat remove` | Stops it and no longer starts it at logon. The connection is kept. |
| `Setup-Smith.bat reconnect` | Sets the connection up again with a new connect code. |

`Start-Smith.bat agent` runs the agent in the current window instead, for watching or
debugging. From a checkout of this repository, `SmithAgent.bat install` builds Smith,
installs it into `C:\SmithAgent` (or `SMITH_AGENT_HOME`) and then runs `Setup-Smith.bat`.

No token belongs in the command line. The agent targets
`https://exp.redmarmosetstudios.com` and keeps its credential and isolated builds in an
owner-only `hosted-workspace` directory. Only one agent may use that directory at a time.

## Crew members on a machine

The machine's card has two toggles, both off by default and changed only by the machine's
owner:

- **Run crew members on this machine** lets scheduled crew members run here with this
  machine's own Claude Code sign-in, or with a local Ollama model. Turning it on is consent to
  use that sign-in. A machine whose Claude Code is signed out is not chosen. Build machines
  can also run members that use the workspace's Anthropic API key; personal computers never do.
- **even while a build runs** lets a crew run share the machine with a build (it only matters
  on build machines). Off, a run waits until the build finishes.

The machine needs an agent that reports the `crew` feature, so update it after the Worker is
deployed (`SmithAgent.bat update`). See [AI chat](../../docs/cloudflare/ai-chat.md#crew).

Building Smith requires Git/SSH access to Red-Marmoset/smith, Visual Studio C++
build tools and a bootstrapped Una engine. Set `UNA_ENGINE_PATH` when the engine
is not at `C:\code\engine`. The agent advertises detected capabilities; the Smith
preset requires `una-engine`.

`Start-Smith.bat version` checks the packaged executable without connecting.
Use `Start-Smith.bat help` or `Start-Smith.bat agent --help` for enrollment,
workspace, capability and stop options without connecting. Full
[user help](https://exp.redmarmosetstudios.com/help.html) is available in the
dashboard. In a source checkout, see [the guide](../../docs/user-guide.md),
[smith.json reference](../../docs/smith-json.md) and [planned tasks](../../docs/task-stubs.md).

## Keeping copies of repositories

A build machine can keep Smith's copies of the workspace's repositories and serve them
through the coordinator (clones, fetches and pushes made at
`https://exp.redmarmosetstudios.com/git/<project>.git` are relayed to it; nothing on the
machine is reachable from the internet). An owner or admin switches it on per machine
with **Keep copies of repositories here** on the machine's card. The machine needs git
2.36 or newer on `PATH` (Ubuntu 22.04 ships 2.34: use the git PPA), 2 GB free, and the
agent from this package; the card says which of those is missing. Copies live in the
agent's `hosted-workspace/git/` directory, owned by the user the agent runs as, which is
also the user that runs that machine's builds, so do not switch hosting on for a machine
that builds untrusted projects. Switching it off makes the copies it kept unavailable
until another machine holds them (replication arrives in a later milestone).

## Updates are automatic

`DeployWorker.bat` deploys the Worker and publishes the Windows agent package built from
the same commit (the zip and its `smith-experiment-windows.json` manifest), so one run
updates the coordinator and every Windows agent. `DeployWorker.bat --worker-only` leaves
the agents alone; `PackageAgent.bat --upload` publishes a package on its own.

The agent keeps itself on the package the dashboard offers for download. When a newer
one is published, every connected agent of that OS picks it up
with its next heartbeat. It downloads and checks the package, waits until no build and
no chat is running, swaps the files into its folder (keeping the old ones in
`.update-previous`) and restarts into the new version. The dashboard shows each machine
as *up to date* or *updating to …*.

If the new version stops before the coordinator accepts it (or is not accepted within
five minutes), the launcher puts the previous files back and records the version in
`update-rejected.json`, so it is not tried again; publishing a newer package moves on
past it. Set `SMITH_AGENT_AUTO_UPDATE=0` to switch updates off for one machine.

Agents installed before self-update existed (the dashboard says *update it once by
hand*) need one last manual update: `SmithAgent.bat update` from a checkout, or
`Setup-Smith.bat stop`, extract the new package over the folder and run `Setup-Smith.bat`. The saved enrollment in
`hosted-workspace` is kept. Note that `PackageAgent.bat --install` without `--upload`
installs a local build that the agent then replaces with the published package.
Hosted execution runs on Windows, macOS and Linux. Builds die with the agent on
every OS (a kill-on-close job object on Windows; a process-group sentinel on
POSIX, so a build that re-parents out of its process group with `setsid` is the one
thing it cannot follow). On macOS/Linux extract the package and run
`sh start-smith.sh agent` and paste the connect code (macOS/Linux do not start at
logon yet; keep that terminal open). The dashboard lists a
package as *coming soon* until its zip is uploaded (`smith-experiment-mac.zip`,
`-linux.zip`); see the operations notes for packaging on those platforms. LAN modes retain
their existing behavior. Hosted artifacts support four exact files at most (20 MiB
each) with `package: "none"`; create archives in your script. Inputs, wildcard/zip
collection and built-in deployment handoffs are unsupported. See the repository's Cloudflare operations
instructions for provisioning and limits.
