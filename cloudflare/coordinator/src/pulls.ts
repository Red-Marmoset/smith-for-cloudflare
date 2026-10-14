// Smith's own pull requests: a branch of a project proposed for merging into the project's branch, reviewed and merged
// in Smith whatever hosts the repository (Smith's Cloudflare Artifacts copy has no pull requests of its own). A crew
// proposal opens one by itself once its push is confirmed; a person opens one from a chat's pushed branch.
//
// The Worker runs no git, so a build machine does the git work as a job (Modules/SmithAgent/HostedPull.h):
//   diff    - what the branch changes against its base and whether it merges cleanly (uploads pull.patch and pull-files.txt)
//   merge   - commits the merge on the base branch's tip and pushes it, never forced (Artifacts: a write token minted for it)
//   publish - pushes the head to the project's GitHub origin with the machine's own Git login, so a person can open a
//             GitHub pull request from the link Smith shows (it opens only when they click it)
// Only agents that advertise PULL_LABEL claim them. A diff is queued whenever the head (or, after a merge, the base) moved.
//
// pull_requests.state: open -> merged | closed (closed -> open again). The jobs' states are read live from `jobs`.
import { fail, fields, json, string } from './http';
import { smokeSpec, type JobResult, type PullResult, type ResolvedJobSpec } from './contracts';
import { isArtifactsRemote, WRITE_TOKEN_TTL } from './artifacts-repos';
import { githubRepo } from './github-reader';
import { GIT_CLIENT_LABEL, smithRemoteRepo } from './git-host';
import { copyOf, upstreamOf } from './upstream';
import { isRepoProject, validBranch, type RepoProject } from './repo-projects';
import { appendMemory } from './crew-review';
import type { Project } from './projects';

export const PULL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pull_requests (id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, project_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    head_branch TEXT NOT NULL, head_commit TEXT NOT NULL, base_branch TEXT NOT NULL, state TEXT NOT NULL, author_user_id TEXT, crew_id TEXT,
    crew_session_id TEXT UNIQUE, chat_session_id TEXT, diff_commit TEXT, diff_job_id TEXT, merge_job_id TEXT, merge_token_id TEXT, publish_job_id TEXT,
    base_commit TEXT, merge_base TEXT, mergeable INTEGER, conflicts TEXT NOT NULL DEFAULT '[]', diff_truncated INTEGER NOT NULL DEFAULT 0, merge_commit TEXT,
    merged_by TEXT, merged_at INTEGER, closed_by TEXT, closed_at INTEGER, github_url TEXT, message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS pull_requests_project ON pull_requests(project_id, state);
  CREATE TABLE IF NOT EXISTS pull_comments (id TEXT PRIMARY KEY, pull_id TEXT NOT NULL, user_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS pull_comments_pull ON pull_comments(pull_id, created_at);
`;
export const PULL_LABEL = 'smith-pull-requests';                 // agents that run diff, merge and publish jobs
export const PULL_READ_ACTIONS = ['pulls', 'pull'];
export const PULL_ACTIONS = [...PULL_READ_ACTIONS, 'pull-open', 'pull-comment', 'pull-merge', 'pull-close', 'pull-reopen', 'pull-publish', 'pull-refresh'];
export const PULL_JOB_KINDS = ['diff', 'merge', 'publish'] as const;
export type PullJobKind = typeof PULL_JOB_KINDS[number];
export const PATCH_FILE = 'pull.patch', FILES_FILE = 'pull-files.txt';
const SHA = /^[a-f0-9]{40}$/;
const ACTIVE = ['queued', 'leased', 'running'];
const MAX_COMMENTS = 500;

export type PullRow = { id: string; number: number; project_id: string; title: string; body: string; head_branch: string; head_commit: string; base_branch: string;
  state: 'open' | 'merged' | 'closed'; author_user_id: string | null; crew_id: string | null; crew_session_id: string | null; chat_session_id: string | null;
  diff_commit: string | null; diff_job_id: string | null; merge_job_id: string | null; merge_token_id: string | null; publish_job_id: string | null;
  base_commit: string | null; merge_base: string | null; mergeable: number | null; conflicts: string; diff_truncated: number; merge_commit: string | null;
  merged_by: string | null; merged_at: number | null; closed_by: string | null; closed_at: number | null; github_url: string | null; message: string | null;
  created_at: number; updated_at: number };
type JobBrief = { id: string; state: string; result: string | null; node_id: string | null };
// What a pull job's result says beyond a build's (the agent's "pull" object), checked by the workspace's /complete.
export function validatePullResult(value: unknown): PullResult {
  const invalid = (): never => fail(400, 'invalid_result', 'Invalid job result');
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const v = value as Record<string, unknown>;
  fields(v, ['baseCommit', 'mergeBase', 'mergeable', 'conflicts', 'truncated']);
  if (v.baseCommit !== undefined && (typeof v.baseCommit !== 'string' || !SHA.test(v.baseCommit))) invalid();
  if (v.mergeBase !== undefined && v.mergeBase !== null && (typeof v.mergeBase !== 'string' || !SHA.test(v.mergeBase))) invalid();
  if (v.mergeable !== undefined && v.mergeable !== null && typeof v.mergeable !== 'boolean') invalid();
  if (v.truncated !== undefined && typeof v.truncated !== 'boolean') invalid();
  if (v.conflicts !== undefined && (!Array.isArray(v.conflicts) || v.conflicts.length > 50 || v.conflicts.some(c => typeof c !== 'string' || c.length > 512))) invalid();
  return { ...(v.baseCommit !== undefined ? { baseCommit: v.baseCommit as string } : {}), ...(v.mergeBase !== undefined ? { mergeBase: v.mergeBase as string | null } : {}),
    ...(v.mergeable !== undefined ? { mergeable: v.mergeable as boolean | null } : {}), ...(v.conflicts !== undefined ? { conflicts: v.conflicts as string[] } : {}),
    ...(v.truncated !== undefined ? { truncated: v.truncated as boolean } : {}) };
}

// The GitHub repository a pull request can also be opened on: the project's own repository when it is on GitHub, or the
// GitHub repository Smith's copy (Artifacts or Smith-hosted) is linked to. `pushed`: the head is already there (the
// project builds from GitHub).
export function githubTarget(project: Project | RepoProject | undefined, origin: string): { url: string; owner: string; repo: string; pushed: boolean } | null {
  if (!project) return null;
  const own = githubRepo(project.repoUrl);
  if (own) return { url: project.repoUrl, ...own, pushed: true };
  const source = upstreamOf(copyOf(project, origin), origin);
  const linked = source ? githubRepo(source) : null;
  return linked ? { url: source, ...linked, pushed: false } : null;
}
// Whether the project builds from a copy Smith holds whose credential Smith mints: Cloudflare Artifacts, or Smith-hosted.
export function copyKind(project: Project | RepoProject, origin: string): 'artifacts' | 'hosted' | null {
  return isArtifactsRemote(project.repoUrl) ? 'artifacts' : smithRemoteRepo(project.repoUrl, origin) ? 'hosted' : null;
}
// GitHub's "open a pull request" page for a branch, prefilled. A person opens it; Smith never does.
export function githubCompareUrl(target: { owner: string; repo: string }, base: string, head: string, title: string, body: string): string {
  const query = new URLSearchParams({ expand: '1', title: title.slice(0, 256), body: body.slice(0, 4000) });
  return `https://github.com/${target.owner}/${target.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?${query}`;
}
// A pull job's spec for every OS: the project's repository at the head commit (Smith's copy with `token`), and what the job does.
export function pullSpecs(kind: PullJobKind, jobId: string, project: Project | RepoProject, pull: PullRow, token: string, extra: { message?: string; authorName?: string; authorEmail?: string; targetRemote?: string } = {}): Record<string, ResolvedJobSpec> {
  const specs: Record<string, ResolvedJobSpec> = {};
  for (const os of ['windows', 'linux', 'mac']) specs[os] = { ...smokeSpec(jobId, os), kind, projectId: project.id, buildNumber: 0, timeoutSeconds: 1800,
    repos: [{ name: 'main', url: project.repoUrl, branch: pull.head_branch, commit: pull.head_commit, checkoutDir: '.', authToken: token }],
    artifacts: { globs: kind === 'diff' ? [PATCH_FILE, FILES_FILE] : [], exclude: [], excludeDefaults: true, package: 'none', archiveName: '' },
    pull: kind === 'diff' ? { baseBranch: pull.base_branch } : kind === 'merge' ? { baseBranch: pull.base_branch, message: extra.message ?? '', authorName: extra.authorName ?? '', authorEmail: extra.authorEmail ?? '' }
      : { targetRemote: extra.targetRemote ?? '', targetBranch: pull.head_branch } };
  return specs;
}
// The merge commit's message: GitHub's shape, so the history reads the same wherever it is looked at.
export function mergeMessage(pull: Pick<PullRow, 'number' | 'title' | 'head_branch' | 'body'>, mergedBy: string): string {
  const body = pull.body.trim() ? `\n\n${pull.body.trim()}` : '';
  return `Merge pull request #${pull.number} from ${pull.head_branch}\n\n${pull.title}${body}\n\nMerged in Smith by ${mergedBy}.`.slice(0, 4000).replace(/\x00/g, '');
}
// Who the merge commit names: the person's own name and address, or (without one Git accepts) a stand-in address.
export function mergeAuthor(userId: string, name: string, email: string): { authorName: string; authorEmail: string } {
  const cleanName = name.replace(/[<>\x00-\x1f\x7f]/g, '').trim().slice(0, 128) || 'A Smith user';
  const valid = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}$/.test(email);
  return { authorName: cleanName, authorEmail: valid ? email : `${userId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'user'}@users.smith.invalid` };
}

export interface PullHooks {
  origin: string;                              // this coordinator's origin (Smith-hosted remotes live under it)
  project(id: string): Project | RepoProject | undefined;
  event(jobId: string): void;                  // a job was queued (the workspace's history and alarm)
  machineReady(): boolean;                     // a build machine that runs pull jobs is online
  jobQuotaLeft(): boolean;
}
type Person = { userId: string; role: string };
// What the workspace prepares outside the transaction: the copy's credential (an Artifacts token and its ID, or a Smith
// ticket bound to `jobId`, the ID the merge job then takes) and the merger's name and address.
export type PullPrepared = { token?: string; tokenId?: string; jobId?: string; author?: { name: string; email: string } };
const OPERATORS = ['owner', 'admin', 'operator'];

export class Pulls {
  constructor(private sql: SqlStorage, private hooks: PullHooks) {}

  execute(person: Person, action: string, body: Record<string, unknown>, now: number, prepared: PullPrepared = {}): Response {
    if (action === 'pulls') return this.list(body);
    if (action === 'pull') { fields(body, ['pullId']); return json(this.view(this.row(string(body, 'pullId', 64)), true)); }
    if (action === 'pull-comment') return this.comment(person, body, now);
    if (!OPERATORS.includes(person.role)) fail(403, 'forbidden', 'Only operators and above can change pull requests');
    if (action === 'pull-open') return this.open(person, body, now);
    if (action === 'pull-merge') return this.merge(person, body, now, prepared);
    if (action === 'pull-close' || action === 'pull-reopen') return this.setState(person, action === 'pull-close', body, now);
    if (action === 'pull-publish') return this.publish(body, now, prepared.token ?? '');
    if (action === 'pull-refresh') {
      fields(body, ['pullId']); const pull = this.row(string(body, 'pullId', 64));
      if (pull.state !== 'open') fail(409, 'not_open', `Pull request #${pull.number} is ${pull.state}`);
      if (this.active(pull.diff_job_id)) return json(this.view(pull, true));
      this.sql.exec('UPDATE pull_requests SET diff_commit = NULL, updated_at = ? WHERE id = ?', now, pull.id);   // reconcile queues the diff
      return json(this.view(this.row(pull.id), true));
    }
    fail(404, 'not_found', 'Route not found');
  }

  // ---- Reading ----------------------------------------------------------------------------------------------------
  private list(body: Record<string, unknown>): Response {
    fields(body, ['state']);
    const state = body.state === undefined ? 'all' : string(body, 'state', 8);
    if (!['open', 'merged', 'closed', 'all'].includes(state)) fail(400, 'invalid_field', 'state must be open, merged, closed or all');
    const rows = this.sql.exec<PullRow>(`SELECT * FROM pull_requests ${state === 'all' ? '' : 'WHERE state = ?'} ORDER BY state = 'open' DESC, number DESC LIMIT 200`, ...(state === 'all' ? [] : [state])).toArray();
    return json({ pulls: rows.map(row => this.view(row, false)), machineReady: this.hooks.machineReady() });
  }
  row(id: string): PullRow { return this.sql.exec<PullRow>('SELECT * FROM pull_requests WHERE id = ?', id).toArray()[0] ?? fail(404, 'not_found', 'Pull request not found'); }
  private job(id: string | null): JobBrief | undefined { return id ? this.sql.exec<JobBrief>('SELECT id, state, result, node_id FROM jobs WHERE id = ?', id).toArray()[0] : undefined; }
  private active(id: string | null): boolean { const job = this.job(id); return Boolean(job && ACTIVE.includes(job.state)); }
  private jobView(id: string | null) {
    const job = this.job(id);
    if (!job) return null;
    const result = job.result ? JSON.parse(job.result) as JobResult : null;
    return { jobId: job.id, state: job.state, message: result?.message ?? '' };
  }
  view(row: PullRow, detail: boolean) {
    const project = this.hooks.project(row.project_id);
    const member = row.crew_id ? this.sql.exec<{ name: string; slug: string }>('SELECT name, slug FROM crew_members WHERE id = ?', row.crew_id).toArray()[0] : undefined;
    const report = row.crew_session_id ? this.sql.exec<{ status: string; files: string; verify_job_id: string | null }>('SELECT status, files, verify_job_id FROM crew_reports WHERE session_id = ?', row.crew_session_id).toArray()[0] : undefined;
    const diffJob = this.jobView(row.diff_job_id);
    const target = githubTarget(project, this.hooks.origin);
    const comments = detail ? this.sql.exec<{ id: string; user_id: string; body: string; created_at: number }>('SELECT * FROM pull_comments WHERE pull_id = ? ORDER BY created_at, id', row.id).toArray()
      .map(c => ({ id: c.id, userId: c.user_id, body: c.body, createdAt: c.created_at })) : undefined;
    return {
      id: row.id, number: row.number, projectId: row.project_id, projectName: project?.name ?? null, title: row.title, body: row.body, state: row.state,
      headBranch: row.head_branch, headCommit: row.head_commit, baseBranch: row.base_branch,
      authorUserId: row.author_user_id, crew: row.crew_id ? { id: row.crew_id, name: member?.name ?? null, sessionId: row.crew_session_id, status: report?.status ?? null, verifyJobId: report?.verify_job_id ?? null } : null,
      chatSessionId: row.chat_session_id,
      diff: { current: row.diff_commit === row.head_commit && diffJob?.state === 'success', job: diffJob, patchFile: PATCH_FILE, filesFile: FILES_FILE, commit: row.diff_commit,
        baseCommit: row.base_commit, mergeBase: row.merge_base, mergeable: row.mergeable === null ? null : Boolean(row.mergeable), conflicts: JSON.parse(row.conflicts) as string[],
        truncated: Boolean(row.diff_truncated) },
      merge: this.jobView(row.merge_job_id), mergeCommit: row.merge_commit, mergedBy: row.merged_by, mergedAt: row.merged_at, closedBy: row.closed_by, closedAt: row.closed_at,
      github: target ? { repo: `${target.owner}/${target.repo}`, url: row.github_url ?? (target.pushed ? githubCompareUrl(target, row.base_branch, row.head_branch, row.title, row.body) : null),
        needsPublish: !target.pushed, publish: this.jobView(row.publish_job_id) } : null,
      message: row.message, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(detail ? { comments, files: report ? JSON.parse(report.files) as string[] : null } : { commentCount: this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM pull_comments WHERE pull_id = ?', row.id).one().n }),
    };
  }

  // ---- Opening --------------------------------------------------------------------------------------------------
  private insert(values: { projectId: string; title: string; body: string; headBranch: string; headCommit: string; baseBranch: string; authorUserId: string | null;
    crewId?: string | null; crewSessionId?: string | null; chatSessionId?: string | null }, now: number): PullRow {
    if (this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM pull_requests').one().n >= 5000) fail(429, 'quota', 'This workspace has reached its pull request limit');
    const id = crypto.randomUUID();
    const number = (this.sql.exec<{ n: number | null }>('SELECT MAX(number) AS n FROM pull_requests').one().n ?? 0) + 1;
    this.sql.exec(`INSERT INTO pull_requests (id, number, project_id, title, body, head_branch, head_commit, base_branch, state, author_user_id, crew_id, crew_session_id, chat_session_id,
      created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`, id, number, values.projectId, values.title.slice(0, 200), values.body.slice(0, 20000),
      values.headBranch, values.headCommit, values.baseBranch, values.authorUserId, values.crewId ?? null, values.crewSessionId ?? null, values.chatSessionId ?? null, now, now);
    return this.row(id);
  }
  private baseOf(project: Project | RepoProject): string {
    const base = project.branch || (isRepoProject(project) ? '' : 'main');
    if (!base || !validBranch(base)) fail(409, 'no_base_branch', `Smith does not know ${project.name}'s branch yet; rescan the project first`);
    return base;
  }
  // Every crew proposal waiting for review (or accepted, but not yet merged) gets its pull request. Proposals filed
  // before pull requests existed get one too. Runs in its own transaction; one that cannot be opened is skipped.
  openFromCrew(now: number): void {
    const due = this.sql.exec<{ session_id: string; crew_id: string; summary: string; findings: string; proposal: string | null; project_id: string; branch: string; head_commit: string; status: string }>(
      `SELECT c.session_id, c.crew_id, c.summary, c.findings, c.proposal, c.project_id, c.branch, c.head_commit, c.status FROM crew_reports c
       WHERE c.status IN ('pending', 'accepted') AND c.branch IS NOT NULL AND c.head_commit IS NOT NULL AND c.project_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pull_requests p WHERE p.crew_session_id = c.session_id) ORDER BY c.created_at LIMIT 20`).toArray();
    for (const report of due) {
      const project = this.hooks.project(report.project_id);
      if (!project || !SHA.test(report.head_commit) || !validBranch(report.branch)) continue;
      const base = project.branch;
      if (!base || !validBranch(base) || base === report.branch) continue;
      const proposal = report.proposal ? JSON.parse(report.proposal) as { title?: string; summary?: string } : {};
      const findings = JSON.parse(report.findings) as { title?: string; detail?: string; file?: string }[];
      const body = [proposal.summary || report.summary, findings.length ? `### Findings\n\n${findings.slice(0, 30).map(f => `- **${f.title ?? 'Finding'}**${f.file ? ` (\`${f.file}\`)` : ''}${f.detail ? `: ${f.detail}` : ''}`).join('\n')}` : '']
        .filter(Boolean).join('\n\n');
      this.insert({ projectId: report.project_id, title: proposal.title || report.summary.split('\n')[0].slice(0, 120) || 'Crew proposal', body, headBranch: report.branch,
        headCommit: report.head_commit, baseBranch: base, authorUserId: null, crewId: report.crew_id, crewSessionId: report.session_id }, now);
    }
  }
  // A chat pushes after each reply: its open pull request follows the branch to the newest commit pushed (and is compared
  // again). Runs in its own transaction, as openFromCrew.
  followChats(now: number): void {
    const open = this.sql.exec<{ id: string; chat_session_id: string; head_commit: string }>("SELECT id, chat_session_id, head_commit FROM pull_requests WHERE state = 'open' AND chat_session_id IS NOT NULL").toArray();
    for (const pull of open) {
      if (this.active(this.sql.exec<{ merge_job_id: string | null }>('SELECT merge_job_id FROM pull_requests WHERE id = ?', pull.id).one().merge_job_id)) continue;   // never move a pull request being merged
      const pushed = this.sql.exec<{ result: string }>("SELECT result FROM ai_turns WHERE session_id = ? AND kind = 'push' AND state = 'completed' ORDER BY seq DESC LIMIT 1", pull.chat_session_id).toArray()[0];
      const commit = pushed ? (JSON.parse(pushed.result) as { commit?: string | null }).commit : null;
      if (commit && SHA.test(commit) && commit !== pull.head_commit) this.sql.exec('UPDATE pull_requests SET head_commit = ?, updated_at = ? WHERE id = ?', commit, now, pull.id);
    }
  }
  // A person opens one from their chat's pushed branch (`chatSessionId`), or from any branch at a commit (`projectId`,
  // `branch`, `commit`). The same request ID answers with the pull request it opened.
  private open(person: Person, body: Record<string, unknown>, now: number): Response {
    fields(body, ['chatSessionId', 'projectId', 'branch', 'commit', 'title', 'body', 'baseBranch']);
    const title = string(body, 'title', 200).trim() || fail(400, 'invalid_field', 'A pull request needs a title');
    const text = body.body === undefined ? '' : string(body, 'body', 20000);
    let projectId: string, branch: string, commit: string, chatSessionId: string | null = null;
    if (body.chatSessionId !== undefined) {
      const session = this.sql.exec<{ id: string; owner_user_id: string; project_id: string; branch: string; kind: string }>('SELECT id, owner_user_id, project_id, branch, kind FROM ai_sessions WHERE id = ?', string(body, 'chatSessionId', 64)).toArray()[0];
      if (!session || session.kind !== 'chat' || session.owner_user_id !== person.userId) fail(404, 'not_found', 'Chat not found');
      const pushed = this.sql.exec<{ result: string }>("SELECT result FROM ai_turns WHERE session_id = ? AND kind = 'push' AND state = 'completed' ORDER BY seq DESC LIMIT 1", session.id).toArray()[0];
      const pushedCommit = pushed ? (JSON.parse(pushed.result) as { commit?: string | null }).commit : null;
      if (!pushedCommit) fail(409, 'not_pushed', 'Push the chat’s branch first; the pull request proposes what was pushed');
      ({ project_id: projectId, branch } = session); commit = pushedCommit; chatSessionId = session.id;
      const existing = this.sql.exec<PullRow>("SELECT * FROM pull_requests WHERE chat_session_id = ? AND state = 'open'", session.id).toArray()[0];
      if (existing) {
        // Pushing again moves the open pull request to the new head (its diff is queued again).
        if (existing.head_commit !== commit) this.sql.exec('UPDATE pull_requests SET head_commit = ?, title = ?, body = ?, updated_at = ? WHERE id = ?', commit, title, text, now, existing.id);
        return json(this.view(this.row(existing.id), true));
      }
    } else {
      projectId = string(body, 'projectId', 64); branch = string(body, 'branch', 256); commit = string(body, 'commit', 40);
      if (!validBranch(branch) || !branch) fail(400, 'invalid_branch', 'Invalid branch name');
      if (!SHA.test(commit)) fail(400, 'invalid_field', 'commit must be a full commit SHA');
    }
    const project = this.hooks.project(projectId) ?? fail(404, 'not_found', 'Project not found');
    const base = body.baseBranch === undefined ? this.baseOf(project) : string(body, 'baseBranch', 256);
    if (!validBranch(base) || !base) fail(400, 'invalid_branch', 'Invalid base branch');
    if (base === branch) fail(400, 'invalid_branch', 'A pull request merges one branch into another');
    const pull = this.insert({ projectId, title, body: text, headBranch: branch, headCommit: commit, baseBranch: base, authorUserId: person.userId, chatSessionId }, now);
    return json(this.view(pull, true), 201);
  }

  // ---- Conversation, state, merge and publish ------------------------------------------------------------------
  private comment(person: Person, body: Record<string, unknown>, now: number): Response {
    fields(body, ['pullId', 'body']);
    const pull = this.row(string(body, 'pullId', 64));
    const text = string(body, 'body', 8000).trim() || fail(400, 'invalid_field', 'A comment needs some text');
    if (this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM pull_comments WHERE pull_id = ?', pull.id).one().n >= MAX_COMMENTS) fail(429, 'quota', 'This pull request has reached its comment limit');
    this.sql.exec('INSERT INTO pull_comments (id, pull_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)', crypto.randomUUID(), pull.id, person.userId, text, now);
    this.sql.exec('UPDATE pull_requests SET updated_at = ? WHERE id = ?', now, pull.id);
    // A crew member reads review comments on its own pull requests in its memory, as it reads a dismissal's note.
    if (pull.crew_id) {
      const member = this.sql.exec<{ memory: string }>('SELECT memory FROM crew_members WHERE id = ?', pull.crew_id).toArray()[0];
      if (member) this.sql.exec('UPDATE crew_members SET memory = ? WHERE id = ?', appendMemory(member.memory, `\n\n[Review comment on pull request #${pull.number} "${pull.title}" from ${person.userId}]: ${text.slice(0, 2000)}`), pull.crew_id);
    }
    return json(this.view(this.row(pull.id), true), 201);
  }
  private setState(person: Person, close: boolean, body: Record<string, unknown>, now: number): Response {
    fields(body, ['pullId', 'note']);
    const pull = this.row(string(body, 'pullId', 64));
    const note = body.note === undefined || body.note === null || body.note === '' ? null : string(body, 'note', 2000);
    if (close && pull.state !== 'open') fail(409, 'not_open', `Pull request #${pull.number} is ${pull.state}`);
    if (!close && pull.state !== 'closed') fail(409, 'not_closed', `Pull request #${pull.number} is ${pull.state}`);
    if (close && this.active(pull.merge_job_id)) fail(409, 'merging', 'This pull request is being merged; wait for the merge to finish');
    this.sql.exec('UPDATE pull_requests SET state = ?, closed_by = ?, closed_at = ?, updated_at = ? WHERE id = ?', close ? 'closed' : 'open', close ? person.userId : null, close ? now : null, now, pull.id);
    // Closing a crew proposal's pull request dismisses the proposal (a note is the member's feedback); reopening does not undo that.
    if (close && pull.crew_session_id) {
      const report = this.sql.exec<{ status: string; crew_id: string }>('SELECT status, crew_id FROM crew_reports WHERE session_id = ?', pull.crew_session_id).toArray()[0];
      if (report && ['pending', 'stale', 'accepted'].includes(report.status)) {
        this.sql.exec("UPDATE crew_reports SET status = 'dismissed', decided_by = ?, decided_at = ?, note = ? WHERE session_id = ?", person.userId, now, note, pull.crew_session_id);
        const member = note ? this.sql.exec<{ memory: string }>('SELECT memory FROM crew_members WHERE id = ?', report.crew_id).toArray()[0] : undefined;
        if (member) this.sql.exec('UPDATE crew_members SET memory = ? WHERE id = ?', appendMemory(member.memory, `\n\n[Pull request #${pull.number} "${pull.title}" closed by ${person.userId}]: ${note}`), report.crew_id);
      }
    }
    if (note) this.sql.exec('INSERT INTO pull_comments (id, pull_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)', crypto.randomUUID(), pull.id, person.userId, note, now);
    return json(this.view(this.row(pull.id), true));
  }
  // The checks a merge must pass, read-only, so the workspace runs them before it mints the write token (a refused merge
  // makes no Artifacts call) and again inside the transaction that queues it. The project to mint for, or null when the
  // merge is a replay (already queued).
  mergePlan(person: Person, body: Record<string, unknown>): { pull: PullRow; project: Project | RepoProject } {
    fields(body, ['pullId', 'authorName', 'authorEmail']);   // the merger's name and address, from index.ts
    if (!OPERATORS.includes(person.role)) fail(403, 'forbidden', 'Only operators and above can merge');
    const pull = this.row(string(body, 'pullId', 64));
    if (pull.state !== 'open') fail(409, 'not_open', `Pull request #${pull.number} is ${pull.state}`);
    if (this.active(pull.merge_job_id)) fail(409, 'merging', 'This pull request is already being merged');
    if (pull.mergeable === 0 && pull.diff_commit === pull.head_commit) fail(409, 'conflicts', `The branch conflicts with ${pull.base_branch}; resolve the conflicts on the branch first`);
    const project = this.hooks.project(pull.project_id) ?? fail(409, 'project_missing', 'This pull request’s project no longer exists');
    if (project.artifacts && ['pushing', 'verifying'].includes(project.artifacts.status)) fail(409, 'artifacts_pending', 'Smith is still copying this project; merge once the copy finishes');
    if (!this.hooks.jobQuotaLeft()) fail(429, 'quota', 'Experiment job quota reached');
    return { pull, project };
  }
  private merge(person: Person, body: Record<string, unknown>, now: number, prepared: PullPrepared): Response {
    const { pull, project } = this.mergePlan(person, body);
    if (copyKind(project, this.hooks.origin) && !prepared.token) fail(503, 'copy_unavailable', 'Smith’s copy of this project cannot be written to right now; try again shortly');
    const author = mergeAuthor(person.userId, prepared.author?.name ?? '', prepared.author?.email ?? '');
    const id = this.queue('merge', pull, project, prepared.token ?? '', now, { message: mergeMessage(pull, author.authorName), ...author }, prepared.jobId);
    this.sql.exec('UPDATE pull_requests SET merge_job_id = ?, merge_token_id = ?, merged_by = ?, message = NULL, updated_at = ? WHERE id = ?', id, prepared.tokenId ?? null, person.userId, now, pull.id);
    return json(this.view(this.row(pull.id), true), 201);
  }
  private publish(body: Record<string, unknown>, now: number, token: string): Response {
    fields(body, ['pullId']);
    const pull = this.row(string(body, 'pullId', 64));
    if (pull.state !== 'open') fail(409, 'not_open', `Pull request #${pull.number} is ${pull.state}`);
    const project = this.hooks.project(pull.project_id) ?? fail(409, 'project_missing', 'This pull request’s project no longer exists');
    const target = githubTarget(project, this.hooks.origin) ?? fail(409, 'no_github', 'This project has no GitHub repository to open a pull request on');
    if (target.pushed) return json(this.view(pull, true));
    if (this.active(pull.publish_job_id)) return json(this.view(pull, true));
    if (!this.hooks.jobQuotaLeft()) fail(429, 'quota', 'Experiment job quota reached');
    // Reading the head from Smith's Artifacts copy needs a read token, minted by the workspace before the transaction (a
    // Smith-hosted copy is read with the ticket the claim hands out).
    if (copyKind(project, this.hooks.origin) === 'artifacts' && !token) fail(503, 'artifacts_unconfigured', 'Smith’s copy of this project cannot be read right now; try again shortly');
    const id = this.queue('publish', pull, project, token, now, { targetRemote: target.url });
    this.sql.exec('UPDATE pull_requests SET publish_job_id = ?, github_url = NULL, message = NULL, updated_at = ? WHERE id = ?', id, now, pull.id);
    return json(this.view(this.row(pull.id), true), 201);
  }

  // ---- Jobs -----------------------------------------------------------------------------------------------------
  private queue(kind: PullJobKind, pull: PullRow, project: Project | RepoProject, token: string, now: number, extra: Parameters<typeof pullSpecs>[5] = {}, presetId?: string): string {
    const id = presetId ?? crypto.randomUUID();
    // A Smith-hosted copy needs an agent that can clone one.
    const labels = copyKind(project, this.hooks.origin) === 'hosted' ? [PULL_LABEL, GIT_CLIENT_LABEL] : [PULL_LABEL];
    this.sql.exec(`INSERT INTO jobs (id, kind, request_id, specs, project_id, product, required_labels, secretless, state, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'queued', ?, ?, 1)`, id, kind, `pull-${kind}-${id}`, JSON.stringify(pullSpecs(kind, id, project, pull, token, extra)), project.id,
      `pull-request-${pull.number}`, JSON.stringify(labels), now, now);
    this.hooks.event(id);
    return id;
  }
  // Pull requests whose diff is due (opened, pushed again, base merged into, or Refresh pressed) and the project whose
  // read token the workspace mints for each, outside any transaction.
  diffsDue(): { pullId: string; projectId: string }[] {
    return this.sql.exec<{ id: string; project_id: string; diff_job_id: string | null }>("SELECT id, project_id, diff_job_id FROM pull_requests WHERE state = 'open' AND (diff_commit IS NULL OR diff_commit != head_commit) ORDER BY number LIMIT 20")
      .toArray().filter(p => !this.active(p.diff_job_id)).map(p => ({ pullId: p.id, projectId: p.project_id }));
  }
  queueDiff(pullId: string, token: string, now: number): void {
    const pull = this.sql.exec<PullRow>('SELECT * FROM pull_requests WHERE id = ?', pullId).toArray()[0];
    if (!pull || pull.state !== 'open' || pull.diff_commit === pull.head_commit || this.active(pull.diff_job_id)) return;
    const project = this.hooks.project(pull.project_id);
    if (!project || (copyKind(project, this.hooks.origin) === 'artifacts' && !token) || !this.hooks.jobQuotaLeft()) {
      this.sql.exec('UPDATE pull_requests SET diff_commit = head_commit, message = ?, updated_at = ? WHERE id = ?', !project ? 'This pull request’s project no longer exists.'
        : !this.hooks.jobQuotaLeft() ? 'Smith could not compare the branch: the workspace’s job quota is used up.' : 'Smith could not read its copy of this project to compare the branch; press Refresh to try again.', now, pull.id);
      return;
    }
    const id = this.queue('diff', pull, project, token, now);
    this.sql.exec('UPDATE pull_requests SET diff_job_id = ?, diff_commit = head_commit, message = NULL, updated_at = ? WHERE id = ?', id, now, pull.id);
  }
  // A pull job finished (inside /complete's transaction).
  jobFinished(job: { id: string; kind: string }, result: JobResult, now: number): void {
    const column = job.kind === 'diff' ? 'diff_job_id' : job.kind === 'merge' ? 'merge_job_id' : job.kind === 'publish' ? 'publish_job_id' : null;
    if (!column) return;
    const pull = this.sql.exec<PullRow>(`SELECT * FROM pull_requests WHERE ${column} = ?`, job.id).toArray()[0];
    if (!pull) return;
    const ok = result.status === 'success';
    if (job.kind === 'diff') {
      const p = result.pull ?? {};
      if (ok) this.sql.exec('UPDATE pull_requests SET base_commit = ?, merge_base = ?, mergeable = ?, conflicts = ?, diff_truncated = ?, message = NULL, updated_at = ? WHERE id = ?',
        p.baseCommit ?? null, p.mergeBase ?? null, p.mergeable === undefined || p.mergeable === null ? null : p.mergeable ? 1 : 0, JSON.stringify(p.conflicts ?? []), p.truncated ? 1 : 0, now, pull.id);
      else this.sql.exec('UPDATE pull_requests SET message = ?, updated_at = ? WHERE id = ?', `Smith could not compare the branch: ${result.message}`.slice(0, 1000), now, pull.id);
      return;
    }
    if (job.kind === 'publish') {
      const project = this.hooks.project(pull.project_id); const target = githubTarget(project, this.hooks.origin);
      if (ok && target) this.sql.exec('UPDATE pull_requests SET github_url = ?, message = NULL, updated_at = ? WHERE id = ?', githubCompareUrl(target, pull.base_branch, pull.head_branch, pull.title, pull.body), now, pull.id);
      else this.sql.exec('UPDATE pull_requests SET message = ?, updated_at = ? WHERE id = ?', `Publishing to GitHub failed: ${result.message}`.slice(0, 1000), now, pull.id);
      return;
    }
    if (!ok || !result.commit) { this.sql.exec('UPDATE pull_requests SET message = ?, updated_at = ? WHERE id = ?', `The merge failed: ${result.message}`.slice(0, 1000), now, pull.id); return; }
    // merged_by has held who pressed Merge since the merge was queued.
    this.sql.exec("UPDATE pull_requests SET state = 'merged', merge_commit = ?, merged_at = ?, message = NULL, updated_at = ? WHERE id = ?", result.commit, now, now, pull.id);
    // The base moved: every other open pull request of the project is compared again.
    this.sql.exec("UPDATE pull_requests SET diff_commit = NULL WHERE project_id = ? AND base_branch = ? AND state = 'open' AND id != ?", pull.project_id, pull.base_branch, pull.id);
    if (pull.crew_session_id) this.sql.exec("UPDATE crew_reports SET status = 'accepted', decided_by = COALESCE(decided_by, ?), decided_at = COALESCE(decided_at, ?) WHERE session_id = ? AND status IN ('pending', 'stale', 'accepted')",
      pull.merged_by, now, pull.crew_session_id);
  }
  // Write tokens handed to merges that are over, for the workspace to revoke. `expired`: the merge ended longer ago than
  // the token's TTL, so it no longer works and a revocation that keeps failing may stop being retried.
  tokensToRevoke(now: number): { pullId: string; projectId: string; tokenId: string; expired: boolean }[] {
    return this.sql.exec<{ id: string; project_id: string; merge_token_id: string; merge_job_id: string | null }>('SELECT id, project_id, merge_token_id, merge_job_id FROM pull_requests WHERE merge_token_id IS NOT NULL')
      .toArray().flatMap(p => {
        const job = this.sql.exec<{ state: string; updated_at: number }>('SELECT state, updated_at FROM jobs WHERE id = ?', p.merge_job_id ?? '').toArray()[0];
        if (job && ACTIVE.includes(job.state)) return [];
        return [{ pullId: p.id, projectId: p.project_id, tokenId: p.merge_token_id, expired: !job || now - job.updated_at > WRITE_TOKEN_TTL * 1000 }];
      });
  }
  tokenRevoked(pullId: string, tokenId: string): void { this.sql.exec('UPDATE pull_requests SET merge_token_id = NULL WHERE id = ? AND merge_token_id = ?', pullId, tokenId); }
}
