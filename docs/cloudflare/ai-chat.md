# Working with AI in the Smith dashboard

**Work with AI** runs Claude Code or Codex on your own computer, signed in
with your own account, in a private copy of a Smith project. The dashboard
only relays the conversation. Your Claude or ChatGPT login never leaves
your computer.

## Getting it

1. Deploy the Worker first: `DeployWorker.bat`. It applies the migrations.
   An agent that is newer than the Worker stops reporting its AI tools until
   it restarts.
2. Update the agent on every computer you chat on: `SmithAgent.bat update`.
   If a feature needs a newer agent, the dashboard says so instead of
   failing.
3. On that computer, sign in to the CLIs yourself: `claude`, then `/login`;
   `codex login`. For local models, install [Ollama](https://ollama.com).
   Claude Code needs Ollama 0.14 or newer.

## Chats

Chats are kept like in the Claude and ChatGPT apps:

- Search covers titles, your messages and the replies.
- Each chat's ⋯ menu has Rename, Pin, Archive, Export as Markdown and
  Delete. Sending a message to an archived chat brings it back.
- A `#chat=<id>` link reopens a chat.
- While a reply is running in a background tab, the tab title shows
  *(n) Waiting for you* when the CLI asks something. With browser
  notifications allowed, you are notified when a question arrives or a
  reply ends.

## Assistant, computer, model

- **Assistant**: Claude Code or Codex.
- **Computer**: your computers, plus members' computers that share their
  local models (marked *shared models*).
- **Model**: with Claude Code, *Fable 5.1*, *Opus 5.5*, *Sonnet 5.5* or
  *Haiku 5.5* (run with your own login, `claude --model …`); *Claude Code
  default model* / *Codex default model* leaves the choice to the CLI's own
  setting; *Model on machine · &lt;model&gt;* uses a local Ollama model on that
  computer. Named Claude models need an up-to-date Smith agent on that computer.

## Permissions

| Claude Code | Codex | What happens |
| --- | --- | --- |
| Accept edits | Edit files (sandboxed) | Edits files in the chat's copy. Anything else is refused and reported. |
| Ask before each action | Ask before each action | A card asks you before each edit or command: **Allow**, **Always allow … in this chat**, or **No, tell … what to do instead**. Unanswered questions are declined after 15 minutes. |
| Plan only | Read only | Reads and answers; changes nothing. |
| Bypass permissions | Full access | Runs anything on your computer. Deployment credentials are removed from its environment. |

A chat keeps the mode its last message used until you pick another.
**Ask again before …** in the chat's menu forgets the tools you told it to
always allow.

### Codex on Windows

Codex's sandboxed modes need Codex's own Windows sandbox set up on that
computer. Without it, Codex refuses to run commands or change files. The
dashboard warns you when the agent sees it is missing. Set it up once on
that computer, either way:

- Run `codex` in a terminal and accept its sandbox setup. This needs an
  administrator.
- Add this to `%USERPROFILE%\.codex\config.toml`:

  ```toml
  [windows]
  sandbox = "unelevated"
  ```

## Branches, pushing and Verify

Every reply's changes are committed on the chat's branch in its copy on
your computer. The branch is named after the chat, `smith/ai-<title>-<id>`
(`smith/ai-<id>` on an older agent), from the commit Smith last saw of the
project.

- **Pushed after each reply.** Smith pushes the branch from your computer
  by itself once a reply has committed, with your computer's Git login. It
  is never forced and never goes to another branch. The push shows in the
  chat as its own step, and the next message waits for it. When Smith
  cannot push (a chat on someone else's computer, a copy of the project
  without the operator role, an older agent), the chat says why, next to
  the reply, with the fix.
- **Keep this chat on my computer only** (in the chat's ⋯ menu) stops the
  pushing for a chat that is not ready to be seen; **Push each reply
  again** turns it back on. **Push branch** pushes once, either way.
- **Open pull request** proposes what was pushed for merging, as a Smith
  pull request (see [Pull requests](#pull-requests)). Pushing again moves it
  to the new commit.
- **Verify ▸ Push and build &lt;product&gt;** pushes, then queues a normal
  Smith build of that commit on a build machine. The chat links to the
  build. You need the operator role.
- For a project in Smith's copy (Cloudflare Artifacts or Smith-hosted),
  Smith gives your computer a short-lived token for that one push. This
  also needs the operator role.

The CLI is told where it is at the start of every reply (the project, the
branch, that Smith commits and pushes for it, and what you can build), so
it does not push, deploy or ask where to hand its work in. The note also
explains how `smith.json` works, and what this hosted Smith does and does not
run from it, so the CLI can read and change a project's pipeline without
guessing (`cloudflare/coordinator/src/smith-json-primer.ts`; keep it in step
with the [smith.json reference](../smith-json.md)). The note adds no
permission: the permission mode you chose still decides what it may do.

Smith runs its own git commands with repository hooks switched off. It
stops using git in a chat's copy whose `.git/config` the CLI changed, unless
the chat ran with full access.

## Sharing local models

On your machine's card, tick *Let workspace members chat on this machine
with its local Ollama models*. Other members can then run chats there with
your **local** models: never `:cloud` models, and never your Claude or Codex
login (chats only; crew members use your sign-in when you turn on *Run crew
members on this machine*, see [Crew](#crew)). Their chats are limited:

- They can only edit their own copy of the project, or only read it. No ask
  mode, bypass or full access.
- They cannot use Push or Verify.
- The CLI runs with an empty config folder of its own, and without the
  CLIs' credential variables.

Your machine's card lists who is chatting on it, with a **Stop** for each.
Unticking the box stops new messages from being handed to your machine.

## Crew

The **Crew** section runs named AI members on a schedule, unattended, on your workspace's
machines. A member looks after one or more projects: it reads them, reports findings and
proposes changes on a branch for a person to review. It never merges, builds or deploys.
Run it from the Members tab; operators and above manage members, and everyone in the
workspace can read them.

### Members

A member has a name, a charter in plain English (what to look at, what counts as done, what
not to touch), the project it works on, other projects it may read, a trigger, a per-run
budget and a permission mode: *Edit its own branch* or *Read and report only*. Templates
(Standards, Bug hunter, Test proposer, Extractor, Feature planner, Implementer, Bug fixer,
Pipeline setup, the reviewers, Custom) start the charter; all are editable. Feature planner, Implementer and
Bug fixer form a development crew: the planner sends its top plan to the Implementer, the
Bug fixer runs on failed builds and takes reports from the Bug hunter. Pipeline setup makes
sure the project builds in Smith: it writes or fixes `smith.json` and the scripts it calls,
never adding deploy steps or secrets unasked. Every run's prompt (and every chat's briefing) says
when the project has no smith.json, builds from a detected default, or has one Smith cannot read.
The project it works on needs a copy on Cloudflare Artifacts, which is where its branch goes.

### Triggers

- **Only when someone presses Run now.**
- **On a schedule**: every N minutes (at least 15), optionally skipped when the project has no
  new commits.
- **After a build finishes**: after failed builds, or every build, of its projects.
- **When a branch gets new commits**: Smith looks at a branch (the project's own when left
  blank, or any other, such as `develop`) every few minutes (default 5, at least 2). The machine
  that looks runs `git ls-remote` with its own Git login. The member runs only when the branch
  has commits it has not seen, starting from that branch's tip, and reads the new commits in
  `input/changes.md`. The first look runs on the branch's recent commits. A look that finds
  nothing new is not a run: it does not count toward *runs per day*, leaves no report, and
  disappears from the run list. Smith's own `smith/…` branches cannot be watched, so the
  crew's pushes never wake it. A project that builds from Smith's Artifacts copy is watched
  in that copy.

### AI

| AI | Runs with | Where |
| --- | --- | --- |
| **Best available** (default) | The first AI ready on the machine that takes the run, in the workspace's **AI order** (Settings). The default order is Claude, then GPT, then a local model | Any machine whose owner turned on **Run crew members on this machine** and that has one of them ready |
| This machine's Claude Code sign-in | The Claude Code login on the machine the run is on | Machines with the toggle on whose Claude Code is signed in |
| This machine's Codex sign-in (GPT) | The Codex login on the machine the run is on | Machines with the toggle on whose Codex is signed in, whose agent supports Codex crew runs and, on Windows, whose Codex sandbox is set up |
| Workspace Anthropic API key | The key an owner stored in Settings | Build machines only |
| Model on a machine | A local Ollama model, never a `:cloud` one: the one chosen, or the machine's largest. It runs in Claude Code, or in Codex when the machine has only Codex | Machines with the toggle on and a local model |

The kinds in the AI order work like this:

- **Claude**: the machine's Claude Code sign-in. On a build machine, the workspace key is the
  fallback when the key is set and the daily spend limit leaves room for the run.
- **GPT**: the machine's Codex sign-in.
- **Local model**: as *Model on a machine*. A best-available member can name the local model
  it prefers.

Owners and admins can reorder the list or leave a kind out. A machine with no Claude Code or
Codex sign-in still runs a best-available member on a local model. Each run records the AI it
actually used.

The toggle on a machine's card is the consent for crew runs to use that machine's sign-ins. A
signed-out machine is never chosen for a sign-in. Sign-in and local-model runs reserve no spend.
The workspace's daily spend limit meters only runs on the workspace API key.

### What a run can and cannot do

Claude Code starts with `--restricted --strict-mcp-config --permission-prompts none` and an
allow list: Read, Edit, Write, Glob, Grep and the `crew_*` tools. There is no Bash, no WebFetch
and no WebSearch. Deny rules cover the run's input folder and the checkout's `.git`, and the
environment the CLI inherits is scrubbed. The run's token works only while its turn runs.

Codex runs as `codex exec` and never asks for approval. A *Read and report only* run uses
Codex's read-only sandbox. An *Edit its own branch* run uses `workspace-write`: no network, no
temp folders, and writes only in the checkout and `new-project/`. Smith's MCP server is the
only one it gets, and the machine's own configured servers are dropped. Codex has no budget
flag, so only the run's minutes limit it. **Codex differs from Claude Code in two ways.** It
can run commands inside its sandbox. Its sandbox also confines writes but not reads, so a run
can read files outside its checkout. Smith refuses to commit a change that adds a private key,
as well as any of the run's own secrets. If that is not enough for a machine, leave GPT out of
the AI order or keep Codex signed out there.

The CLI does not push. After it exits, Smith commits the change, scans it for the run's secrets
and for nested repositories, and pushes only `smith/crew-<slug>-<id>` to the project's Artifacts
copy. A checkout's own settings, hooks and `.mcp.json` never load, and instruction files in
read-only related clones are removed.

A run can read the other projects it was given, read builds and logs, message other members,
file a report, keep a memory (at most 32 KB) for its next run and, if allowed, create a shared
project. It cannot start a build, deploy, or reach the network. Verify is a person's action
from Review, never automatic.

### Review

Review lists proposals from every member, newest first, with the files each touched.

- **Verify** builds the member's Verify product at that commit on a build machine, without the
  workspace's secrets. It is refused when the proposal touches `smith.json` or a script the
  build runs. The build runs the branch's own script, so look at the files first.
- **Pull request #N** opens the proposal's pull request, where you read the change, discuss it
  and merge it. Every pending or accepted proposal gets one by itself.
- **Accept** marks the proposal and shows the branch to merge from. Merging the pull request
  accepts it too.
- **Dismiss** takes an optional note, which becomes feedback in the member's memory.

A proposal is *stale* when the member filed a newer one with the same title. A report with no
branch is *findings only* and can only be dismissed.

Verify is also refused when a run changed more files than Smith could list (500 paths, 24 KB),
because a file it left out could be `smith.json` or a build script. The card says so.
A run started by a finished build gets that build's log (its last 64 KB) as
`input/build-<job>.log`.

### Pull requests

Smith has its own pull requests, so a project on Smith's Artifacts copy (which has none) gets
the same review as one on GitHub. The **Pull requests** section lists them; one opens into:

- the description, and who opened it (a crew member, or a person from a chat);
- whether it merges cleanly into the project's branch, with the conflicting files if not;
- the change, file by file, from a diff a build machine computes;
- the conversation. A crew member reads comments on its pull requests as feedback in its memory;
- for operators: **Merge**, **Refresh** (compare again), **Close** (with an optional note; on a
  crew proposal it dismisses the proposal) and **Reopen**.

**Merge** has a build machine merge the branch into the project's branch (`--no-ff`, named after
the person who merged) and push that branch, never forced: if the branch moved meanwhile, the
merge stops and says so. For a project in Smith's copy the machine gets a credential for that
one merge (an Artifacts write token, or a ticket that may write only the base branch), ended once
the merge ends. A merge compares every other open pull request of the project again. A chat's
pull request follows the chat's branch as Smith pushes each reply.

For a project whose copy is linked to a GitHub repository, **Publish the branch to GitHub** pushes
the head there with the build machine's own Git login; then **Open a pull request on GitHub** links to GitHub's prefilled
page. For a project that builds from GitHub the link is there from the start. Smith never opens
it for you.

Only build machines whose agent runs pull requests (it advertises `smith-pull-requests`) take this
work. Until one is online, the pull request says so.

### Messages

People and members write to everyone or to one member, on the Messages tab or with `crew_send`.
A member reads what arrived since its previous run started, as information to weigh and never as
orders. A message is at most 8,192 bytes, a run sends at most 20, and the newest 2,000 are kept.

### Creating projects

A member can create a shared project (its own Artifacts repository, pushed as `main` when the
run ends) only when an owner allows it in Settings, the member's own flag is on, the workspace
has its own Cloudflare account ID and token, and the 20-project limit has room.

Smith reads its smith.json after the first push, as it does for a project added from a Git URL,
so its build actions appear once that scan is done. Its builds never get the workspace's secrets.

### Hands-on checks

Not yet done. These need a real signed-in machine, so run them yourself before trusting the
crew with a project.

1. On a signed-in Windows machine with the crew toggle on, plant a canary hook and a user-level
   `CLAUDE.md`, then run a `login` Standards member on a copied project. The hook never fires,
   the init event's tool list has no Bash, and the canary text never appears in the transcript.
2. Repeat with an invalid API key on an `api-key` member. The run fails without consulting the
   sign-in.
3. `Read ../../hosted-state.json` and WebFetch are denied. A `CLAUDE.md` planted in the run's
   input folder never reaches the system prompt.
4. Make the first real run in *Read and report only* mode with a capped key, then a proposal,
   Verify and Accept round trip.
