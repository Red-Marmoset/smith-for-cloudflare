# smith.json reference

Place `smith.json` at the repository root and commit it alongside the scripts it
invokes. It describes a project's native Smith pipeline. It is **not** the
coordinator runtime config (`smith-coordinator.json`) or hosted agent credentials.
Use strict JSON: double quotes, no comments and no trailing commas. Escape Windows
backslashes as `\\`, or use forward slashes in repository-relative paths.

## A first pipeline

Save a build script as `tools/build.ps1` (and `tools/build.sh` for Unix machines).
For example, the PowerShell script should create `out`, run your toolchain and
write `out/app.zip`; exit nonzero on failure. Change the URLs and labels below to
match your repository and installed build tools.

```json
{
  "schemaVersion": 1,
  "project": { "id": "example", "name": "Example", "description": "Build Example" },
  "repos": [{
    "name": "main", "primary": true,
    "url": "https://github.com/your-org/example.git",
    "defaultBranch": "main", "checkoutDir": "."
  }],
  "buildProducts": [{
    "name": "build",
    "rules": [{
      "name": "build-example", "enabled": true, "branches": ["*"],
      "nodeSelector": { "os": "any", "labels": ["example-toolchain"] },
      "command": {
        "windows": { "interpreter": "ps1", "script": "tools/build.ps1", "args": [] },
        "linux": { "interpreter": "sh", "script": "tools/build.sh", "args": [] },
        "mac": { "interpreter": "sh", "script": "tools/build.sh", "args": [] }
      },
      "workingDir": ".", "timeoutSeconds": 1800, "successExitCodes": [0],
      "artifacts": { "globs": ["out/app.zip"], "package": "none" },
      "handoff": []
    }]
  }],
  "triggers": [{ "type": "manual" }]
}
```

Register it with `Smith.exe coordinator --project <repo-directory> --with-agent
--agent-labels example-toolchain`, or add its Git URL in **Projects**. Keep secrets
out of repository configuration: use the agent OS user's Git credential helper or
SSH keys and operator-controlled environment/credential files.

## Top-level fields

| Field | Type / default | Meaning |
| --- | --- | --- |
| `schemaVersion` | integer, `1` | Current pipeline version. Use `1`; the parser does not validate future versions. |
| `project.id` | string, required | Stable identifier used in project routes, history and notifications. Choose a unique short ID. |
| `project.name` | string, empty | Human-readable project name. |
| `project.description` | string, empty | What the project builds. |
| `repos` | array, empty | Repositories checked out for each job. |
| `defaultNodeSelector` | object, `os: "any"`, no labels | Parsed but currently not applied by the scheduler. Put actual requirements on each rule's `nodeSelector`. |
| `buildProducts` | array, empty | Named actions such as build, test, tray or deploy. |
| `triggers` | array, empty | Manual/poll/schedule/webhook declarations. |
| `chains` | array, empty | Named parallel builds followed by success-gated work. |

Unknown fields are generally ignored by the native parser, so a misspelled key
may silently take its default. Successful JSON parsing does not validate scripts,
toolchains, every field type or whether a compatible machine exists. Load the
project and run a harmless test product before adding publishing commands.

## Repositories

Each `repos` entry accepts these fields:

| Field | Type / default | Meaning |
| --- | --- | --- |
| `name` | string, `"main"` | Logical name; used by `--repo-override projectId/repoName=url`. Give repositories distinct names. |
| `primary` | boolean, `false` | Receives the requested build branch/commit. If none is primary, the first entry becomes primary. Declare exactly one. |
| `url` | string, empty | Git clone URL accessible from each eligible agent. Local paths work only where accessible. |
| `defaultBranch` | string, `"main"` | Branch used when no build branch is supplied; secondary repositories use their own default. |
| `checkoutDir` | string, `"."` | Directory relative to the job workspace. Use distinct subdirectories for secondary repositories. |

The branch selector controls the **primary** repository. Secondary repositories
are not automatically pinned to the primary commit. A config loaded using
`--project` refers to your local config; builds execute in agent-managed copies,
not your editing checkout. The native coordinator's URL-managed projects use its
own clone to read config/discover variants and watch branches.

## Build products and rule selection

A product has `name` (string), `rules` (array), optional `discover` (object) and
optional `outputPath` (string template). Product names are the actions displayed
in the UI and used by triggers, chains and artifact inputs.

Rules are tried in declaration order: the first **enabled** rule whose branch
patterns match is selected. An empty `branches` list matches any branch. Put
specific release rules before catch-all rules. Branch patterns are wildcard
patterns, not regular expressions: for example `main`, `release/*` or `*`.
Once selected, a rule waits for a compatible machine; Smith does not pick a later
rule merely because the first one currently lacks a machine.

| Rule field | Type / default | Meaning |
| --- | --- | --- |
| `name` | string, empty | Stable rule name saved with builds. Give each rule a distinct name. |
| `enabled` | boolean, `true` | Disable a rule without deleting it. |
| `branches` | string array, empty | Eligible primary branches. |
| `nodeSelector` | object, any OS/no labels | Additional machine requirements. |
| `command` | object keyed by `windows`, `mac`, `linux` | Command or ordered command array for each supported agent OS. Missing OS entries cannot run on that OS. |
| `workingDir` | string, `"."` | Build working directory relative to the primary repository checkout. |
| `env` | string-valued object, empty | Environment supplied to this job. Overrides coordinator-wide values of the same name. |
| `timeoutSeconds` | integer, `0` | Command timeout; `0` means no configured command timeout. Set a bound for unattended work. |
| `successExitCodes` | integer array, empty → `[0]` | Exit codes accepted as success for command steps. |
| `artifacts` | object | Outputs to collect after successful commands. |
| `inputs` | array, empty | Artifacts from earlier successful products to stage before building. |
| `handoff` | array, empty | Ordered post-build operations after artifact collection. |

### Machine selectors

`os` is `"any"`, `"windows"`, `"mac"` or `"linux"`. **All** labels must be
present, with exact case-sensitive names. Rule and variant label requirements
combine; a variant OS overrides the rule OS. A selected target platform overrides
that OS selection; it does
not install a cross-compilation toolchain. Avoid conflicting OS requirements.
`preferOs` is soft affinity: a compatible preferred OS gets a short grace period
when online, then another compatible OS may run the job. It is not a hard pin.

### Commands

Each command has `interpreter`, `script` and optional string-array `args`.
Supported interpreters are `ps1` (PowerShell), `bat` (cmd), `sh` (`/bin/sh`),
`python` (`python` on PATH), and `exe` (executable). Tools must be available to the
OS user running the agent. Shell operators such as `&&` in `args` are ordinary
arguments; put shell logic in your script.

**Blender.** Agents look for Blender where it installs (its Windows and macOS
installers leave PATH alone): PATH, `Program Files\Blender Foundation\Blender
<version>`, `/Applications/Blender.app`, unpacked `blender-<version>-linux-x64`
folders in `/opt` and the home directory, and Steam libraries. The newest version wins. A
machine that has Blender advertises the label `blender`, gives scripts its path as
`SMITH_BLENDER`, and runs an `exe` step whose `script` is `blender` with it, so one
command works on every OS:

```json
"nodeSelector": { "os": "any", "labels": ["blender"] },
"command": {
  "windows": { "interpreter": "exe", "script": "blender", "args": ["-b", "--factory-startup", "--python-exit-code", "1", "-P", "scene.py"] },
  "linux":   { "interpreter": "exe", "script": "blender", "args": ["-b", "--factory-startup", "--python-exit-code", "1", "-P", "scene.py"] },
  "mac":     { "interpreter": "exe", "script": "blender", "args": ["-b", "--factory-startup", "--python-exit-code", "1", "-P", "scene.py"] }
},
"artifacts": { "globs": ["render.png"], "package": "none" }
```

`-b` renders without opening a window. Save the image from the script
(`scene.render.filepath` plus `bpy.ops.render.render(write_still=True)`) so it
lands at the exact path: `-o`/`-f` append frame numbers. The agent detects Blender
when it starts, so restart it after installing Blender.

An array runs commands in order on the same machine, stopping when a step returns
an unacceptable exit code. Each step is a new process: changes to its shell's
environment do not survive to the next step. Use rule `env`, generated files or
a single wrapper script for shared setup.

```json
{
  "windows": [
    { "interpreter": "ps1", "script": "tools/configure.ps1", "args": [] },
    { "interpreter": "ps1", "script": "tools/build.ps1", "args": ["-Config", "Release"] }
  ]
}
```

### Templates and environment

The native coordinator substitutes `${NAME}` in **command arguments**, environment
values, product `outputPath`, artifact globs and `archiveName`. Command `script`,
`workingDir`, selectors and repository URLs are not templated. Unknown variables
remain literal; a misspelling can therefore create the wrong path.

| Template | Value |
| --- | --- |
| `${PROJECT_ID}` | Project identifier |
| `${BUILD_NUMBER}` | Build number |
| `${BRANCH}` | Primary build branch |
| `${COMMIT}` / `${COMMIT_SHORT}` | Primary revision / first seven characters, when resolved |
| `${VARIANT}` / `${VARIANT_SLUG}` | Selected variant and its filesystem-friendly slug by default |
| `${PROFILE}` / `${PROFILE_SLUG}` | Same pair when `discover.as` is `"PROFILE"` |
| `${OUTPUT}` | Resolved product `outputPath`, or empty if omitted |

Variant names are lowercase-slugged with non-alphanumeric runs replaced by `-`.
Use the chosen `discover.as` name and its `_SLUG` suffix, not both VARIANT and
PROFILE interchangeably. Templates are configuration substitutions, not
automatically exported environment variables. Add, for example,
`"env": {"OUTPUT_DIR": "${OUTPUT}"}` for your script to read an output path.
Build processes also receive `SMITH_BUILD_NUMBER`, `SMITH_BRANCH`, `SMITH_COMMIT`
and `SMITH_PROJECT`. A revision resolved only during agent checkout can be absent
from earlier coordinator substitutions; prefer `SMITH_COMMIT` inside the script.

## Variants and output folders

`discover.type: "list"` expands `values` into a matrix. `"files"` scans the
repository using `glob` and names each variant from a matching filename without
its extension. Duplicate names are removed; results are sorted. `as` defaults to
`"VARIANT"`. `classify` is an ordered array of `{match, os, labels, preferOs}`;
`match` is an ECMAScript regular expression searched in the variant name. The
first matching classifier wins; an empty match is a catch-all. Invalid regexes do
not match. This is different from branch and artifact wildcard syntax.

```json
{
  "type": "list", "values": ["windows-release", "linux-release"], "as": "PROFILE",
  "classify": [
    { "match": "^windows-", "os": "windows" },
    { "match": "^linux-", "os": "linux" }
  ]
}
```

Set product `outputPath` to `"out/${PROFILE_SLUG}"`, pass `${OUTPUT}` as a script
argument, and write output there. With `outputPath` and **no explicit artifact
globs**, native Smith collects that entire output folder into a zip named after
the variant slug (or product if there is no variant). To collect nothing, omit
`outputPath` as well as globs. `artifacts.exclude` still applies.

## Artifacts and inputs

`artifacts.globs` is a string array relative to the build working directory.
`*` matches inside one path segment; `**` spans directories. Use `"out/**"` for a
whole tree. `exclude` subtracts wildcard patterns. `excludeDefaults` defaults to
`true` and applies Smith's built-in never-ship filters for source/tool caches and
credentials; leave it on unless you have inspected the output.

`package: "zip"` bundles matches into an archive; `archiveName` supplies its name.
`"none"` uploads files individually with a count cap. Use a zip for many files
and folder structure. Native collection warns when no files match; do not assume
an empty artifact list means the build script produced the expected output.

An input is `{ "product": "build", "variant": "windows-release" }`. Smith looks
for the latest successful build of that product/variant on the same project and
branch with collected artifacts. Omit `variant` to require an unvaried build.
Inputs are staged into the consuming build's working directory before its command
runs. Zip inputs are extracted there; other files keep their artifact filename.
Use compatible producing/consuming directory layouts and avoid filename collisions.
Missing eligible input artifacts fail dispatch with an `INPUTS` error. Chain follow-up jobs prefer the
matching builds from their own batch. See [features](FEATURES.md) for fan-in examples.

## Handoffs

Handoffs execute in order **after** commands and artifact collection. Each has
`name`, `type`, optional `continueOnError` (default `false`) and fields for its
type. A failed step normally fails the build and stops later steps.

| Type | Fields / behavior |
| --- | --- |
| `collect` | No extra work; records that normal artifact collection already happened. |
| `script` | `script` required; `interpreter` defaults to `exe`; optional `workingDir` and space-separated `args` string. Unlike build-command args, this is not an argument array or a shell-aware quoting parser. Use a wrapper for complex arguments. |
| `copyShare` | `dest` required; optional `from` relative to working directory. Recursively copies and overwrites files on a share accessible to the agent OS user. |
| `steam` | `appBuildVdf` and/or ordered `appBuildVdfs`; optional `steamcmd`, `desc`, `credentialRef`. Uploads through steamcmd; username/password come from local credentials. |
| `itch` | `target` or `user` + `game` + optional `channel`; `path` or `contentRoot`; optional `butler`, `credentialRef`. Publishes through butler. |
| `cloudflare` | `command` (`deploy` default or `pages`), optional `dir`/`contentRoot`, `project`, `env`, `wrangler`, `credentialRef`. Runs Wrangler and can publish externally. |

Credentials referenced by `credentialRef` are read from
`smith-agent-credentials.json` in the agent process's current directory. The
matching JSON object holds `username`/`password` for Steam, `apiKey` for itch,
or `apiToken`/`accountId` for Cloudflare. Keep this private file outside the repo.
Handoff fields substitute `PROJECT_ID`, `BUILD_NUMBER`, `BRANCH`, `COMMIT`,
`COMMIT_SHORT`, `WORKSPACE`, `ARTIFACTS_DIR`, and `TARGET_ENV` when the environment
defines it. `WORKSPACE`/`ARTIFACTS_DIR` refer to the build working directory.

A `deploy` product name has no special meaning. Deploying happens only when its
script or handoff does so. Keep publishing out of a first test pipeline.

## Triggers and chains

| Trigger | Fields / behavior |
| --- | --- |
| `manual` | Records manual intent; use a dashboard action or `smith trigger`. |
| `poll` | `branches`, `intervalSeconds`, `product`; watches for changed revisions. An initial poll baselines without building. |
| `schedule` | `cron` (five fields: minute, hour, day-of-month, month, weekday), `branches`, `product`. Runs in the native coordinator's local time. |
| `webhook` | `branches`, `product`; deliver Git webhook requests to `/api/webhook/git/<projectId>`. Configure reachability/authentication for your deployment. |

An omitted trigger product selects the first build product. Poll intervals of
`0` use the coordinator default. Repo triggers and UI autobuilds are independent;
avoid declaring the same automation twice. Manual work is not collapsed with
automatic pushes; queued matching commit-driven work is superseded by newer work.

Chains contain `name`, `builds`, `then`, optional `onFailure` (`finish` or `cancel`)
and `pinCommit` (boolean). Each step is `{product, variants}`; variants accept
names/slugs, and an empty list selects all discovered variants. `builds` fan out;
`then` is queued only after **every** initial build succeeds. Default pinning
resolves the primary commit once for the batch. This does not pin secondary
repositories. `onFailure` controls whether sibling builds finish or are cancelled.

```json
{
  "name": "release-candidate",
  "builds": [{ "product": "build", "variants": [] }],
  "then": [{ "product": "package", "variants": [] }],
  "onFailure": "finish", "pinCommit": true
}
```

## This repository's smith.json

| Product | What it does / requirements |
| --- | --- |
| `self-release` | Windows release candidate via `tools/self-release/build.ps1`; `una-engine` label; collects the release zip without activating it. |
| `build-experiment` | Builds/packages experiment agents; only `feature/cloudflare-experiment`; `una-engine` label; zips the package directory. |
| `build` | Native Release console binary on Windows/Linux/macOS; `una-engine` label; collects `smith.zip`. |
| `test` | Runs OS-specific test scripts; `una-engine` label; no artifact collection. |
| `tray` | Optional Windows/macOS desktop tray; `una-engine` and `wxwidgets` labels; collects `smith-tray.zip`. |

Two poll triggers watch `feature/cloudflare-experiment` for `build-experiment`
and `main` for `test`, every 120 seconds; manual triggering is also declared.
These are native pipeline definitions. A hosted preset is a separate object and
does not gain the repository's zip collector or trigger behavior automatically.

## Hosted experiment compatibility

**Add project** on the hosted dashboard reads a repository's `smith.json` at the
branch tip and offers one action per product (per discovered variant for
`discover`), using the first enabled rule whose `branches` match. Handoff steps,
`inputs` (those actions show as unavailable), artifact globs and zip packaging,
`triggers` and `chains` are not supported there yet; exact files with
`package: "none"` are collected. A repository with no `smith.json` builds from a
default Smith detects (a root build script, a `package.json` or an `index.html`);
the card shows it, and committing it as `smith.json` is the way to change it. See
[operations](cloudflare/operations.md).

The hosted API also accepts operator-prepared project presets with `id`, `name`, `repoUrl`,
`branch`, full 40-character lowercase `commit`, and `products`. Product entries
use `name`, `description`, `labels`, `commands` (**plural**), `workingDir`,
`timeoutSeconds`, `env`, and `artifacts`. This is not the `smith.json` shape.
Unknown preset fields are rejected. The current project API accepts GitHub HTTPS
or SSH URLs without embedded credentials, 1–20 unique products, 1–10 repository
script commands per OS and timeouts of 1–7,200 seconds (default 1,800).

Hosted presets support exact-file `package: "none"` artifacts (four files maximum,
20 MiB each), but not native glob/zip collection, `discover`, `inputs`, `handoff`,
`triggers` or `chains`. Package outputs in the repository script.
Commands can run publishing tools if explicitly configured; workspace Cloudflare
credentials are available to builds when set. Hosted coding chat turns remove
deployment environment credentials and use separate session checkouts.
See [user guide](user-guide.md) and [operations](cloudflare/operations.md).
