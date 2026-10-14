# Clean build option — design

**Date:** 2026-06-16
**Status:** approved

## Problem

The agent reuses each project's workspace between builds: `GitRepo::Sync` does
`git fetch` + `git checkout` + `git reset --hard origin/<branch>`, which only
touches **tracked** files. Untracked and git-ignored build artifacts survive
across builds. Switching a Unity project from Mono to IL2CPP left stale
`Library/` cache and IL2CPP intermediates in the reused workspace, which poisoned
subsequent builds. There is currently no way to force a fresh build short of
manually deleting the agent's workspace.

## Goal

A per-build **clean** flag. When set, the agent purges untracked + ignored files
before building — without paying for a full re-clone of a large game repo.
Surfaced as a checkbox on the coordinator web UI and a `clean` boolean parameter
on the Discord bot's `/build` and `/chain` commands.

## Non-goals (YAGNI)

- No second "full re-clone / nuke workspace" level.
- No per-project default-clean config in `smith.json`.
- No automatic clean-on-toolchain-change detection.

## The clean operation

In `GitRepo::Sync`, gated on a new `bool clean` parameter (default `false`).
After the existing fetch / checkout / `reset --hard` / submodule update, when
`clean` is set:

```
git clean -ffdx
git submodule foreach --recursive git clean -ffdx
```

- `-ffdx` removes untracked **and** ignored files/dirs (the build caches) while
  leaving the `.git` clone and registered submodules intact — registered
  submodules are tracked entries, so `git clean` does not remove them. The double
  `-ff` only concerns *untracked* nested repos.
- The `submodule foreach` line cleans untracked artifacts **inside** each
  submodule's working tree.
- Runs after `submodule update --init --recursive` so submodule dirs exist.

**Error handling:** a `git clean` non-zero exit is logged but **non-fatal**
(matches the existing fetch/submodule tolerance). The preceding `reset --hard`
already guarantees tracked-file correctness; a build should not hard-fail because
cleanup hit one locked file.

## The flag's journey

One `bool clean`, default `false` everywhere → fully backward-compatible. Old
agents/coordinators that don't know the key simply read the default.

| Layer | File(s) | Change |
|---|---|---|
| Wire: trigger in | `SmithProtocol/WireTypes.h`, `WireJson.cpp` | `TriggerRequest.clean`, (de)serialized |
| Wire: job out | `SmithProtocol/WireTypes.h`, `WireJson.cpp` | `JobSpec.clean`, (de)serialized |
| Persist | `SmithCore/BuildRecord.h`, `Store.cpp` | `BuildRecord.clean`, in record JSON |
| Clean op | `SmithCore/GitRepo.h/.cpp` | `Sync(..., bool clean = false)` runs the `git clean` |
| Single trigger | `SmithCoordinator/Coordinator.cpp`, `CoordinatorJobs.cpp`, `Coordinator.h` | `HandleTrigger` reads `tr.clean`; `EnqueueBuild(Locked)` gains trailing `bool clean = false` → `rec.clean`; `ResolveJobSpec` copies `rec.clean` → `spec.clean`; rerun preserves `rec.clean` |
| Chains/batches | `SmithCoordinator/CoordinatorBatches.cpp` | `BatchDef.clean` (persisted), read from request body, passed to **both** `EnqueueBuildLocked` calls (parallel builds + follow-up `then`) so clean applies to the whole chain |
| Agent | `SmithAgent/Agent.cpp` | `Checkout` passes `spec.clean` into `Sync` |
| Coordinator UI | `web/app.js` (`triggerRow`), regen embedded assets | "Clean build" checkbox → `clean` in `/api/trigger` POST |
| Discord | `tools/smith-discord-bot.py`, regen `DiscordBotAsset.h` via `tools/gen-discord-asset.py` | `clean: bool=False` on `/build` and `/chain`; `SmithClient.trigger(clean=)`; `/api/batch` body carries `clean` |

## Generated files

`DiscordBotAsset.h` and the embedded web assets are **generated**. Edit the
sources under `tools/` and `web/` and rerun the generators
(`tools/gen-discord-asset.py`, `tools/gen-web-assets.*`); never hand-edit the
generated headers.

## Testing

1. JSON round-trip asserts for `clean` on `TriggerRequest` / `JobSpec` /
   `BuildRecord` in `SmithCoreTest`.
2. A `GitRepo::Sync(clean=true)` test against a temp repo: drop an
   untracked/ignored file, assert it is gone after a clean sync and present after
   a normal one.
3. Extend `tools/test_discord_bot.py` to assert `/build` and `/chain` forward
   `clean`.

## Safety

Per `CLAUDE.md`, no real external deploy is run during this work; handoff stays
untouched. The change only affects checkout/cleanup.
