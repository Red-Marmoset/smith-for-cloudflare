# Automatic agent tool updates

LAN and hosted Smith agents check installed development tools when they start
and once every 24 hours thereafter. Checks run in the background while the agent
is idle. Builds and dashboard AI turns, including crew turns, may run together, but
none starts during tool maintenance; maintenance waits until all have finished. Hosted
heartbeats continue during downloads. OS file locks coordinate all Smith agents
running under the same user account, including agents with different workspaces.

The agent updates recognized global npm installations of Claude Code, Codex CLI,
and Wrangler. Native Claude Code uses `claude update`; Homebrew Claude Code and
Codex use their cask upgrade commands; WinGet Claude Code uses its package ID.
Other installation methods may require their administrator's package manager.
Tools absent from the machine are not installed by this updater. The LAN agent's
existing installation of missing Wrangler remains in place.

npm is updated with `--engine-strict`, as are the npm-installed tools, so a
release requiring a newer Node.js is rejected instead of replacing a compatible
installation. npx comes with npm and needs no separate installation. Node.js,
compilers, OS packages and project lockfiles remain managed by their existing
installation mechanisms. Global updates run from the maintenance directory, never
from a project's checkout. No interactive elevation or login is requested.

Set `SMITH_AUTO_UPDATE_TOOLS=0` in the environment of the agent process to
disable Smith's tool maintenance, then restart it. This does not override a
tool's own built-in updater or the existing LAN Wrangler provisioning.

The account's `~/.smith-tool-maintenance/attempt` file (`%USERPROFILE%` on Windows)
atomically records the last attempt, including failed attempts, to avoid
repeating downloads on each restart. Failed updates
are logged locally and retried on the next daily check. Permission or unsupported
installation failures require fixing the installation under the account running
the agent. Hosted AI tool version reports refresh after maintenance completes.
Accounts without a writable home keep running builds, but tool maintenance is
unavailable and a local warning explains why. Updates are coordinated between
Smith processes under the same account; external package managers and the CLI's
own auto-updater operate independently.
