# Planned user tasks

These are **workflow stubs**, not working controls or promises of a release date.
They describe missing tasks, the current workaround and what completion should
look like. They appear in shipped Help so users can discover the gap. No stub
queues a job, changes permissions, rotates a credential or publishes anything.
A stub marked **Available** has shipped; it stays listed so existing links keep working.

## TASK-01 · Add a hosted project from smith.json

**Status:** Available. **Add project** on the dashboard picks a repository your
GitHub link can see (or takes a Git URL) and an optional branch, reads its
`smith.json` and offers one build action per product; each build runs the branch
tip and records the commit. Actions that need `inputs` show as unavailable, and
handoff steps, artifact globs/zip packaging and `smith.json` triggers are not
imported yet. Operator-prepared pinned presets still work through the API. See
[operations](cloudflare/operations.md).

## TASK-02 · Validate configuration before running

**Status:** Planned. **User goal:** Catch unknown/misspelled keys, wrong types,
missing scripts, conflicting selectors and impossible output paths before a build.
**Inputs:** `smith.json` and repository root, plus intended coordinator mode.
**Current workaround:** Check strict JSON, compare the reference and load/run a
non-publishing test product. **Completion:** A `smith validate` command with useful
field-path errors, exit status and hosted compatibility report; editor schema
support could use the same rules. It must not execute build or deploy commands.

## TASK-03 · Retry a build or update its pinned revision

**Status:** Planned for the hosted dashboard. **User goal:** Re-run the exact failed
revision, or deliberately move a prepared project to a newer commit.
**Inputs:** Previous job ID or new full Git commit. **Current workaround:** Queue
the product again for the same preset; ask an owner/admin to update its commit.
**Completion:** Separate same-revision rerun from new-revision update; show source
and command changes before queueing; preserve request idempotency and history.
Lost attempts require checking for partial side effects before replacement.

## TASK-04 · Pause, resume and rotate a machine credential

**Status:** Planned dashboard workflow. **User goal:** Maintain an agent without
losing an active build, then replace its credential without creating confusing
duplicate machines. **Inputs:** Machine identity, desired pause/rotation and fresh
enrollment. **Current workaround:** Admin drain API or local drain file for a
graceful build stop; Disconnect + fresh dedicated directory for revocation.
**Completion:** Show active work, drain progress and permissions; resume explicitly;
rotate after owner verification and invalidate the old credential. Keep forced
revocation distinct from a pause. Stop personal chats before shutdown.

## TASK-05 · Manage workspace members and invitations

**Status:** Partly available. Studio Google accounts sign in without an invitation
and join workspaces shared through **Settings → Workspace → Studio access**.
**Settings → People** reviews and changes roles, removes people (they stay out
until let back in) and lets anyone leave; the last owner is protected. **Still
planned:** Inviting someone outside the studio into a specific workspace (today the
operator's `NewInvite.bat` creates a separate account with its own workspaces),
seeing which machines/tokens a person retains, and an audit trail.

## TASK-06 · Approve an assistant action from the dashboard

**Status:** Available. Choose **Ask before each action** as the chat's permission
mode (Claude Code or Codex). A card in the chat asks before each edit or command:
**Allow**, **Always allow … in this chat**, or **No, tell … what to do instead**.
Unanswered questions are declined after 15 minutes. **Ask again before …** in the
chat menu forgets the tools you always allowed. See [AI chat](cloudflare/ai-chat.md).

## TASK-07 · Review and publish an AI session's changes

**Status:** Partly available. Smith pushes the chat's own branch
(`smith/ai-<title>-<id>`) from your computer with its Git login after each reply
(**Push branch** does it once more), and **Verify ▸ Push and build** also queues a
build of that commit. Diff review and opening the pull request are still yours. **User goal:** Inspect what an assistant changed and turn
it into a reviewed branch/PR. **Current workaround:** Push the branch, then review
and open the pull request in your Git host. **Completion:** Show diff and validation results, choose the destination explicitly,
publish only after approval and link the result to the chat. Never auto-merge or
publish solely because an assistant turn completed.

## TASK-08 · Notifications, retention and export

**Status:** Planned hosted build workflow. **User goal:** Receive actionable build
results and manage stored output before reaching experiment limits.
**Inputs:** Notification destination/preferences, retention period, selected jobs.
**Current workaround:** Follow the dashboard; account e-mail is saved but delivery
is not implemented. Chat export already works and is separate from build export.
**Completion:** Opt-in result notifications, authenticated full-log/build metadata
export, storage usage display and deliberate cleanup that preserves active work.
Current hosted limits include 1,000 lifetime jobs/workspace and 4 MiB output/job.

## TASK-09 · Run a chat with a shared local model

**Status:** Available. When a machine's owner ticks *Let workspace members chat on
this machine with its local Ollama models*, other members can pick that computer
(marked *shared models*) and an *Ollama · <model>* **Model** in a new chat. Those
chats only edit or read their own copy of the project, cannot Push or Verify, and
never use the owner's Claude/Codex login or `:cloud` models. The owner sees who is
chatting and can stop each one. See [AI chat](cloudflare/ai-chat.md).

## TASK-10 · Hosted pipelines and other operating systems

**Status:** Partly available. Hosted agents run on Windows, macOS and Linux, and
builds die with the agent on every OS. macOS/Linux agents do not start at logon
yet, and their packages show as *coming soon* until they are published.
**User goal:** Build matrices/chains, consume artifacts, poll branches and trigger
on commits as native agents do. **Inputs:** Validated pipeline and platform
capabilities. **Current workaround:** Use native Smith for those pipeline features
and exact script-packaged artifacts for the experiment. **Completion:** Explicit
trigger, packaging/input and handoff semantics; guarded publishing and retention.
Native feature availability must not imply hosted support before these are implemented.
