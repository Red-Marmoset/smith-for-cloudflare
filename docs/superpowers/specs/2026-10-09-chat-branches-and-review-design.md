# Chats that push as they go, and Smith's own Review (proposal)

Status: **proposal for review**. Nothing here is implemented. It builds on the
AI chat harness (`docs/superpowers/specs/2026-10-04-ai-assistant-integration-design.md`,
phases 2 to 4) and the crew's Review page
(`docs/superpowers/specs/2026-10-05-autonomous-crew-design.md`).

## Where we are

A chat already works the way a careful contributor would:

- Each chat gets a **private copy** of the project on the chat's machine
  (`<agent work dir>/ai/<session>/repo`), cloned at the project's pinned commit.
- Each chat has its **own branch**, `smith/ai-<8 hex>`, created from that commit.
- Smith **commits every reply** that changed files (`Smith AI session: <subject>`),
  with hooks off and `.git/config` tamper detection.
- **Push branch** and **Verify ▸ Push and build** exist, but only as buttons a
  person clicks after the fact.

The crew already has a **Review** page: proposals with status, files touched,
overlap warnings, Verify (a secretless build pinned to the commit), Accept and
Dismiss. It has no diff, no comments, and it only lists crew runs.

So the gaps are:

1. Chat branches stay on the chat's machine until someone remembers to push.
2. The CLI runs with no idea it is inside Smith (no instructions about the
   branch, Verify, or what not to do), so it sometimes tries to push or deploy
   itself, or asks the person how to "submit" its work.
3. Review is crew-only, shows no diff, and has nowhere to leave feedback.
4. A chat never catches up with the project branch; a long chat drifts.

## Part 1: harness enhancements

### 1a. Push as you go

After a message turn ends with a commit, Smith queues a `push` turn by itself,
exactly as a crew run does today (`Sessions.addPushTurn`). The push runs on the
same machine, with the same rules as the manual button: only
`refs/heads/smith/ai-<id>`, never forced, the machine's own Git login (or a
one-push Artifacts token for Smith's copy).

- **Who**: owner chats on the owner's own machine. Guests on a shared machine
  cannot push today and still cannot.
- **Role**: pushing to a project needs the operator role today
  (`ai-session-push`). Auto-push follows the same check at queue time; a chat
  by a viewer simply keeps its branch local and the card says so.
- **Default on.** Every chat pushes each reply and updates its change in
  Review; the person does not have to ask. A per-chat toggle in the chat's
  menu (*Keep this chat on my computer only*) turns it off for a chat that is
  not ready to be seen, and the Push button stays for pushing it by hand.
- **Coalescing**: one push turn per reply. If a push is still queued when the
  next reply finishes, Smith does not add another (the queued one pushes the
  newer head anyway).
- **Failure**: a push that fails (login refused, machine offline) shows the
  red notice and its one fix in the chat, as every blocking state must, and
  the next reply tries again.

Nothing here can reach another branch: the refspec is explicit and the
coordinator never accepts a different one.

### 1b. Tell the CLI where it is

Chats send the person's text as the whole prompt. Crew runs get a system
prompt (`crew-prompt.ts`). Chats should get a short one too, as
`--append-system-prompt` for Claude Code and a leading instructions block for
Codex (`codex exec` has no system flag):

> You are working in a Smith chat on project *P*, in a private copy on branch
> `smith/ai-…` from commit *C*. Smith commits and pushes your changes after
> each reply; do not commit, push, tag, deploy, or publish yourself. The person
> verifies builds from the chat. The project's build actions are: …

This is the single biggest "harness" improvement for the cost: it stops the
CLI from running `git push`, from asking where to submit, and from inventing
its own branch names. It is text only; it adds no permission. Bypass-mode
chats keep bypass.

Env the CLI already gets stays as is; add `SMITH_CHAT=1`, `SMITH_BRANCH`,
`SMITH_BASE_COMMIT` so a repo's own `CLAUDE.md` can react if it wants.

### 1c. Catch up with the project branch

A new turn kind, `sync`: on the chat's machine, `git fetch origin <project
branch>` then `git merge --no-edit` into the chat branch (merge, not rebase,
because the branch may already be pushed and is never force-pushed).

- A clean merge is committed and reported like any other turn.
- A conflicted merge is aborted, and the conflicting files are reported into
  the chat with a one-click *Ask Claude Code to resolve this* that sends the
  list as the next message with the merge left in progress. That is the
  honest version: the CLI resolves conflicts, a person watches.
- Review shows *behind `main` by N commits* from the push turn's
  `git rev-list --count` after the fetch, so people can see when a sync is due.

### 1d. One clone per project per machine

Each chat is a full `git clone`. Keep one bare mirror per project per machine
and clone chats with `--reference <mirror> --dissociate`: chats start in
seconds on big repos and disk stops growing per chat. The chat copy stays its
own repository, so nothing about isolation or the `.git/config` check changes.
Delete/Archive gets a *Remove the copy on <machine>* checkbox; today copies
are kept forever.

### 1e. Readable branch names

`smith/ai-<8 hex>` is what people see in Review and on GitHub. Use
`smith/ai-<slug>-<8 hex>` where the slug is from the chat's title (first
message), `[a-z0-9-]{1,32}`. `HostedAiBranchValid` and the coordinator's
refspec check widen to match. Existing chats keep their names.

## Part 2: Review for everyone

Generalise the crew's Review into a workspace **Review** page that lists every
pushed branch Smith knows about: chat branches and crew proposals alike.

### Data model

One **change** per session branch, in the workspace Durable Object:

| field | from |
| --- | --- |
| project, branch, base commit, head commit | the session |
| author | the person (chat) or member (crew) |
| title, summary | chat title / crew proposal |
| files, stats | the push turn (below) |
| status | `open` → `verified` (at a commit) / `accepted` / `merged` / `dismissed`; `stale` when a newer push supersedes a verify |
| verify job | existing Verify |
| comments | new |

Crew reports keep their table; the Review list reads both.

### The diff

The coordinator has no git. Three ways to get a diff:

1. **The push turn uploads it.** After pushing, the chat's machine runs
   `git diff --stat` and `git diff <base>..<head>` and posts both, bounded
   (stat always; the patch up to 512 KB, per-file clamped; a bigger change
   says so and lists files only). Stored in the DO (small) or R2 (large).
   Works the same for GitHub, Artifacts and Smith-hosted projects, needs no
   extra token, and the machine already has the checkout.
2. **A `diff` git task on the hosting machine** (`git-tasks.ts`, beside
   `replicate` / `backup`), for Smith-hosted projects: the primary runs the
   same two commands on its bare store, on demand, so Review can show a diff
   between any two refs the record knows (`refs_json`), even when the chat's
   machine is off, and can refresh it after a merge of the project branch.
3. The Worker fetches a compare from the GitHub API or the Artifacts API.

Take 1 for every change at push time, and 2 as the refresh path for hosted
projects (which is where most projects will end up). Use 3 only for head
confirmation, which `reconcileCrew` already does for Smith's copy.

Rendering: a unified-diff view in vanilla JS (per-file collapsible, added /
removed lines, no third-party viewer), beside the files list the crew card
already has.

### Comments that go back to the chat

A reviewer can leave a comment on the change or on a file/line. For a chat
branch, **Send to chat** turns the open comments into the next message of
that chat (resuming the same CLI conversation), prefixed with the file and
line. The reply is committed and pushed as usual, and the comments are marked
addressed at that commit. That round trip, review → the same assistant that
wrote the code → new push, is what GitHub cannot do and is the reason to have
our own page. For crew proposals, comments go into the member's memory, as a
Dismiss note does today.

### Builds on the change: link one, or start one

A change's card shows the builds Smith has run of that branch at its current
head, found by project + branch + commit in the jobs table: a Verify build, a
build a person started, or one a trigger queued. Each links to the build and
its artifacts, so a reviewer who wants the binaries clicks through instead of
building again. When no build exists at the head, the card offers **Build
<product>**, which queues a normal, secretless build pinned to that commit
(today's Verify) and keeps its artifacts like any other build. The
`smith.json` / build-script refusal stays. A build at an older commit is
listed as *at <commit>, before the latest push* and never counts as the
check for the current head.

### Merge

Today Accept only marks a crew proposal and shows the branch to merge from.
For a PR interface people will want the button. Proposal, in two steps:

1. **Accept** stays as is (marks, shows the branch). Ship Review with this
   first.
2. **Merge**, as a git task on the project's hosting machine for a
   Smith-hosted project (the common case), or as a `merge` turn on an agent
   that can reach the remote for a GitHub / Artifacts project. The task runs
   `git merge --no-ff` (or `--ff-only` when the workspace setting says so) of
   the change branch into the project branch in a temporary worktree of the
   bare store, and updates the ref through the store's own `update` hook, so
   the default-branch protection (fast-forward only, no deletion) applies to
   Smith's merge exactly as to a person's push. It needs the operator role, a
   confirm dialog naming the target branch, a green Verify at the head when
   the project has a Verify product, and no conflict (a conflicted merge is
   refused and the card says *sync the chat first*). This is the one place
   Smith writes to a branch other than its own, so it is a separate task kind
   with its own explicit ref, never reachable from a chat's own push. Verify
   builds stay secretless; a non-hosted merge push uses the machine's Git
   login or a write token for Smith's copy, as pushes do today. The merged
   ref tips come back as every host task reports them, so Review flips to
   *merged* and the backup debounce picks the merge up.

For a GitHub project, also offer **Open as a GitHub pull request** using the
workspace's GitHub token, for teams whose review lives there. The Smith
change then links the PR and shows its state.

### Who sees what

Chats are private to their owner today (admins cannot read them). A pushed
branch is not private: the push already made it visible on the remote. So a
chat's change appears in Review once pushed, with the diff and the title, but
its transcript stays private. The owner can mark a chat *not for review*,
which hides it from the list without touching the branch.

## Phases

| phase | scope | tests |
| --- | --- | --- |
| A | 1b system prompt, 1e branch names, 1a auto-push with the per-chat toggle and workspace default | Workers: push queued after a commit, not for guests/viewers, one queued at a time; C++: argv with the prompt, branch validity; end-to-end against `wrangler dev` with the stand-in CLI and the local Git remote |
| B | Review page listing chat and crew changes, push-turn stat + diff upload, diff view, builds at the head (link or Build), comments with Send to chat | Workers: size bounds, privacy (transcript hidden, diff shown), comment → message round trip; dashboard test |
| C | 1c sync turn, behind-by count, Accept for chats | Workers + end-to-end merge/conflict against the local remote |
| D | Merge task / turn, GitHub PR link, 1d reference clones and copy cleanup | end-to-end on a local remote only; **no real merge to a real project until the owner runs the first one** (safety rule) |

## Decisions (owner, 2026-10-09)

- Chats push each reply and update their change by default; a per-chat
  switch keeps a chat local.
- From Review, the person chooses: **Merge** the change in, **Build** it to
  get artifacts, or follow the link to a build already done at that commit.
- Merge is built in Smith (phase D), operator-only, with a confirm; a green
  build at the head is shown and recommended but a merge without one is
  allowed with a second confirm, since building is the person's choice.
- Diff limit: 512 KB patch in the DO, larger to R2, stat always.
