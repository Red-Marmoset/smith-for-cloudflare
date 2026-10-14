# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

**Smith** (System for Managed Integration, Testing & Handoff) is a LAN build &
deploy orchestrator — Jenkins/Travis-like, but the pipeline lives inside each
repo (`smith.json` + a build script) and Smith ships as a single self-contained
binary per OS. It is an **out-of-tree Una-engine project**: source lives at
`C:\code\smith`, consuming engine modules from `C:\code\engine` via the
`UNA_ENGINE_PATH` environment variable (mirrors `C:\code\brag` and
`C:\code\p4-grep-ui`).

The full design + milestone plan is at
`C:\Users\Sem\.claude\plans\id-like-you-to-witty-rain.md`.

## Essential commands

```powershell
.\Build.bat                       # Release build -> Build\Output\Smith\Release\Smith.exe
.\Build.bat -Config Debug
.\Build.bat -Clean                # nuke .una\ + Build\Intermediate, then rebuild
.\Build.bat -Project SmithTray    # build the optional wx tray binary (added in M5)
.\RunTests.ps1                    # build + run Tests\<Name>\ projects
```
`./Build.sh [ProjectName]` on Linux/macOS. The engine must be bootstrapped first.

## Architecture (target)

- **Coordinator** (`SmithCoordinator`): HTTP server (web UI + JSON API + git
  webhooks), build queue, scheduler, the four triggers, job→node matching,
  flat-file persistence. Default port **9876**, data dir `C:\ProgramData\Smith` /
  `~/.smith`.
- **Agent** (`SmithAgent`): registers with the coordinator, advertises OS +
  capability labels, long-polls for jobs, checks out the repo, runs the build-rule
  script via a streaming subprocess, forwards logs (SSE), collects artifacts, runs
  handoff steps, reports results.
- **Single multi-mode binary**: `smith coordinator` | `smith agent`. The optional
  `SmithTray` is a separate binary bundling a tray + embedded agent/coordinator.
- Transport is **HTTP + JSON**; agents long-poll; live logs stream via
  **Server-Sent Events**.

## Module layout (built up over milestones)

```
Modules/
  SmithProtocol/   # shared wire types + JSON (de)serialization (deps: Json)
  SmithCore/       # domain model, flat-file Store, smith.json parsing, NodeMatcher,
                   # cron, Uuid, handoff builders (steam/itch/cloudflare/script/copyShare),
                   # and the streaming Process (Process_Windows.cpp / Process_Posix.cpp).
                   # No HTTP, no wx.
  SmithCoordinator/# server logic (deps: SmithCore, SmithProtocol, Http)
  SmithAgent/      # agent runtime + handoff dispatch (deps: SmithCore, SmithProtocol, Http)
  SmithApp/        # main(): subcommand dispatch (coordinator | agent)
  SmithTray/       # optional wxTaskBarIcon desktop app — ONLY module that links wxwidgets
  SmithTray/       # optional wxTaskBarIcon desktop app — ONLY module that links wxwidgets
```
Two project files enforce the wx split: `Workspaces/Projects/Smith` (console, no
wx — builds on Linux servers) and `Workspaces/Projects/SmithTray` (editor type,
links wx).

## Product principles (must follow — the owner's standing rules)

1. **Never interrupt the user unasked.** Nothing Smith runs may open a browser tab,
   pop a window, show a UAC/admin prompt, or grab focus unless the user just clicked
   the button that does exactly that. CLIs Smith launches get `BROWSER` set to a no-op
   so their "helpful" auto-open can't fire; the link is shown on the page and opens
   only when clicked. A button is mildly annoying; a hijacked browsing session is
   unforgivable. This also applies to development: don't probe login/OAuth flows in a
   way that pops UI on the user's machine.
2. **Frictionless above all.** Logins, tokens, keys and setup steps are minimised
   to the bare unavoidable. Detect instead of asking; install instead of instructing;
   reuse a login the machine already has instead of requesting a new one. Asking the
   user to copy/paste something or type a value is a last resort, used only when no
   cleaner approach exists, or as a fallback behind one.
3. **Every blocking state is visible where the user is, with its one fix.** A missing
   tool, a signed-out CLI, an outdated agent: a red notice on the page, next to the
   thing it blocks, with the button that resolves it. Never a silent failure, never
   "go run this in a terminal" when the agent could do it.
4. **Don't take cues from GitHub Actions, Jenkins, Travis, TeamCity, GitLab CI or
   their kin.** Their setup-heavy, token-pasting, YAML-and-secrets conventions are
   what Smith exists to escape. Design from what would be smoothest for the user.
5. **Never do anything destructive to the user's existing state to find something
   out** (e.g. starting `codex login` discards the current Codex login — check
   `codex login status` first, and probe in a throwaway `CODEX_HOME`/`CLAUDE_CONFIG_DIR`).

## Design constraints (must follow)

1. **Least dependencies; nothing extra for the user to install.** No database
   (flat JSON files + plain-text logs + an artifacts dir). No web framework
   (vanilla HTML/CSS/ES modules, served over HTTP). Plain HTTP only — no TLS /
   OpenSSL. Reuse engine modules rather than adding third-party libs.
2. **Core/UI split is hard.** Everything except `SmithTray` must compile with **no
   wxWidgets**. Linux/server agents link zero wx. If you need GUI behavior it goes
   in `SmithTray`.
3. **The repo's script owns the work.** Smith orchestrates (checkout, invoke,
   capture, record, trigger). Don't bake project-specific build/deploy logic into
   Smith; it belongs in the repo's `smith.json` build script + handoff steps.
4. **Build logs come from the Process stream, never from `Log::SetCallback`** (the
   engine Log callback is a single global slot and can't multiplex per-build).
5. **Platform code is isolated** to `*_Windows.cpp` / `*_Linux.cpp` / `*_Mac.cpp`
   declared in the module's `Module.manifest` `sources` map. No scattered
   `#ifdef _WIN32` in common source.
6. **Engine coding standards**: PascalCase types/functions, camelCase variables,
   `m_` member prefix, 4-space indent, 800-line soft limit per source file.

## Safety rule (important)

**Never run a real external deploy/publish during development** — no senet
Cloudflare/itch/git-push, no real Steam/itch/wrangler uploads. Verify the senet
path with `build.bat --target-env staging --skip-worker --skip-migrations
--skip-itch --skip-push`; unit-test handoff built-ins at the argv level. The first
real deploy of anything is run by the user, with explicit authorization, only once
Smith is trusted. (Memory: `smith-no-real-deploys-until-trusted`.)

The one sanctioned automatic deploy is Smith's own: `smith.json`'s `deploy-experiment`
product (`RunTests.ps1`, then `DeployWorker.bat --unattended`) runs on a push to
`feature/cloudflare-experiment` through the hosted coordinator's Build on push
(`docs/cloudflare/operations.md#build-on-push`), on a Windows agent labelled
`smith-deploy`; the rule is `serial`, so deploys never overlap however many agents carry
the label. It is turned on by the owner in the dashboard, never from a dev session.

## Foot-guns (inherited from the engine / brag)

- **MSVC toolset pinning.** `Build.ps1` pins `-vcvars_ver=14.44`. The default
  (14.38) lacks newer STL ABI helpers the prebuilt wxWidgets `.lib`s reference;
  the `SmithTray` link fails with unresolved externals otherwise. Harmless for the
  wx-free console build.
- **Build cache invalidation.** BuildTool's shared cache is keyed per module, so a
  header **layout** change (a new member in a struct another module includes — i.e.
  most branch switches) can hand back a module compiled against the *old* layout.
  It links cleanly and then corrupts memory at runtime: garbage container sizes,
  `std::length_error: cannot create std::vector larger than max_size()`, or a hang.
  `Build.ps1`/`Build.sh` now guard against this automatically — they hash every
  `Modules/**/*.h`, `Module.manifest` and `Project.json` into `Build/.header-state`
  and clear `.una/` + `Build/Intermediate` whenever it moves. If you invoke
  BuildTool directly (bypassing the wrappers), clean it yourself: `.\Build.bat -Clean`.
  `RunTests.ps1`/`RunTests.sh` both `--clean` **every** test project. Cleaning only
  the first is *not* enough: modules cached by project 1 and reused by projects 2..N
  hit the same ABI mismatch. `RunTests.sh` cleaned only the first until 2026-08-08,
  which is why Linux agents failed `SmithFeaturesTest` (`expected 1, got 2078209983`)
  and `SmithProtocolTest` (`std::length_error`) while Windows passed every time.
  Keep the two runners in step — a fix applied to one must be applied to the other.
- **Windows builds need an MSVC environment.** `Build.ps1` auto-detects vcvarsall;
  otherwise run from a VS Developer PowerShell.
- **The engine is a separate checkout — agents can be stale.** Smith consumes
  `C:\code\engine` (`UNA_ENGINE_PATH`) out-of-tree, and **nothing pins or checks its
  revision**. A Smith commit that uses a brand-new engine API builds on the box where
  both were written and fails on every agent whose engine predates it. It surfaces as
  a bare `ERROR: Compilation failed: <file>` with **no compiler diagnostic**, which
  reads like a Smith bug. This cost ~2 months of red Linux builds: `Agent.cpp` started
  calling `Http::Client::GetToFile` 24s after that method was committed to the engine
  (both on 2026-06-17), and the Linux agents never pulled. `Build.sh`/`RunTests.sh`
  now print the engine path + revision at the top of every log — check it first when
  a build fails on one node and passes on another. **When you add an engine API that
  Smith needs, push the engine and update every agent's checkout.**
- **Google sign-in (optional) needs `curl` + a secure origin.** Token verification
  shells out to `curl` (Google `tokeninfo`), so `curl` must be on the coordinator host
  (built into Win10+/macOS/Linux; override with `--token-verify-command`). Google
  Identity Services only runs on a **secure origin** — `https://…` or `http://localhost`
  — and the page origin must be an **Authorized JavaScript origin** on the OAuth client,
  so over a LAN IP / WAN you must serve the UI via the TLS tunnel/reverse proxy. The
  whole feature is off unless `--google-client-id` is set. See `docs/google-auth.md`.
- **Test runners: cap the compiles, run the coordinator test alone.** `RunTests.ps1 -Jobs N`
  (`JOBS=N` for `RunTests.sh`) passes `-j` to BuildTool; the default of 4 is deliberate,
  because more parallel compiles fail with `C1060: out of heap space`. `SmithCoordinatorTest`
  binds port 19900 and crashes with `0xC0000409` if a second instance, or the hosted runtime
  test fixture, runs at the same time. Run it on its own.

## Reused engine modules

`Platform`, `System`, `Log`, `Json` (nlohmann), `File` (incl. Zip for artifact
packaging), and the new `Http` module (thin cpp-httplib wrapper — server + client
+ SSE). `SmithTray` additionally uses the `wxwidgets` external.

## Patterns to mirror

- Build wrapper / vcvars detection: `C:\code\brag\Build.ps1`.
- Out-of-tree manifest + project shape: `C:\code\p4-grep-ui\Modules\P4Grep\Module.manifest`,
  `C:\code\brag\Workspaces\Projects\Brag\Project.json`.
- Test pattern (local ASSERT_* macros, `Test::TestMain`): `C:\code\engine\Tests\JsonTest\Main.cpp`.
- wxApp / tray (for M5): `C:\code\p4-grep-ui\Modules\P4GrepUI\P4GrepApp.{h,cpp}`.
- Streaming subprocess starting point/contrast: `C:\code\engine\Modules\BuildTool\BuildEngine.cpp` (blocking `ExecuteAndCaptureOutput`).
