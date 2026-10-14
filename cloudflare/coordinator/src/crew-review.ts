// Proposals: what a crew run that changed files leaves for people. Its message turn commits (crew.ts finish queues the
// push turn), the push turn pushes the run's branch (`pushed`): to Smith's copy, whose pushed head the workspace confirms
// through the Artifacts API outside any transaction (workspace.ts reconcileCrew, then `settle`), or, for a project with no
// copy, with the machine's own Git login, which leaves the proposal pending with no head to confirm. Then the
// proposal waits in Review, where a person may Verify it (a secretless build pinned to its commit), accept or dismiss it.
// Split from crew.ts, which holds members and the scheduler.
//
// crew_reports.status: findings-only | stopped | pushing -> verifying -> pending -> accepted | dismissed | stale, or failed
// from pushing / verifying. Only Review's statuses (REVIEW_STATUSES) are listed.
import { DEFAULT_PROJECT_AUTOMATION, type ProjectAutomation } from './crew-orchestration-model';
import { fail, fields, json, string } from './http';
import { Tokens } from './tokens';
import { isRepoProject, offersProduct, type RepoProject } from './repo-projects';
import type { Project } from './projects';
import { isArtifactsRemote, WRITE_TOKEN_TTL } from './artifacts-repos';
import type { FinishInput, Sessions, SessionRow, TurnRow } from './sessions';

export const REVIEW_STATUSES = ['pending', 'verifying', 'accepted', 'dismissed', 'stale', 'findings-only', 'failed'] as const;
const DAY_MS = 86400000;
const MEMORY_BYTES = 32768;              // a member's memory, as crew.ts holds it
export const LIFETIME_BUILDS = 1000;     // crew Verify builds a workspace may ever run (the experiment's cap)
const UNSEEN_MS = 10 * 60000;            // a pushed branch Artifacts still does not show after this long has failed
const REACH_MS = 2 * 3600000;            // Artifacts unreachable this long after a push: the proposal fails, retries stop

// What the workspace hands Review's Verify: its projects, and a way to queue a pinned build with the read token it minted
// before the transaction.
export interface VerifyHooks { projects: () => (Project | RepoProject)[]; automation?: (projectId: string) => ProjectAutomation; enqueueVerify?: (projectId: string, product: string, branch: string, commit: string, requestId: string, timeoutMinutes?: number) => { id: string } }
type ReportRow = { session_id: string; crew_id: string; summary: string; findings: string; proposal: string | null; files: string; status: string; decided_by: string | null;
  decided_at: number | null; note: string | null; verify_job_id: string | null; created_at: number; project_id: string | null; branch: string | null; head_commit: string | null;
  base_commit: string | null; cost_usd: number | null; message: string | null; pushed_at: number | null; files_total: number | null; files_truncated: number };
type ListedRow = ReportRow & { member_name: string | null; member_slug: string | null; job_state: string | null };
const LIST = `SELECT c.*, m.name AS member_name, m.slug AS member_slug, j.state AS job_state FROM crew_reports c LEFT JOIN crew_members m ON m.id = c.crew_id
  LEFT JOIN jobs j ON j.id = c.verify_job_id`;

const normalPath = (path: string) => path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').toLowerCase();
// Why Review must not Verify a change: it touches smith.json or a script the product's build runs, so the build would run
// code the run wrote as the build itself (a speed bump, not a boundary). A prepared project names its scripts in its
// commands; a Git-URL project's action carries the scripts its last scan recorded, and one scanned before Smith recorded
// them is checked against smith.json alone. Paths compare as Git lists them, ignoring case and a leading "./".
export function verifyRefusal(project: Project | RepoProject, product: string, files: readonly string[]): string | null {
  const guarded = ['smith.json'];
  if (isRepoProject(project)) guarded.push(...(project.actions.find(item => item.id === product)?.scripts ?? []));
  else {
    const definition = project.products.find(p => p.name === product);
    for (const steps of Object.values(definition?.commands ?? {})) for (const step of Array.isArray(steps) ? steps : [steps]) {
      guarded.push(step.script);
      if (definition?.workingDir && definition.workingDir !== '.') guarded.push(`${definition.workingDir.replace(/\/+$/, '')}/${step.script}`);
    }
  }
  const blocked = new Set(guarded.map(normalPath));
  const hits = files.filter(file => blocked.has(normalPath(file)));
  if (!hits.length) return null;
  return `This change touches ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ` and ${hits.length - 5} more` : ''}, which the ${product} build runs, so Verify would run code the crew wrote as the build itself. Review the change and build it yourself if you trust it.`;
}
// A memory with `text` appended, its oldest text dropped so it stays within MEMORY_BYTES (whole characters only).
export function appendMemory(memory: string, text: string): string {
  const bytes = new TextEncoder().encode(memory + text);
  if (bytes.length <= MEMORY_BYTES) return memory + text;
  return new TextDecoder().decode(bytes.slice(bytes.length - MEMORY_BYTES)).replace(/^�+/, '');
}

export class CrewReview {
  constructor(private sql: SqlStorage) {}

  // ---- Review: the workspace's proposals, newest first ------------------------------------------------------------
  list(): Response {
    const rows = this.sql.exec<ListedRow>(`${LIST} WHERE c.status IN (SELECT value FROM json_each(?)) ORDER BY c.created_at DESC, c.rowid DESC LIMIT 100`, JSON.stringify(REVIEW_STATUSES)).toArray();
    const pending = this.sql.exec<{ session_id: string; project_id: string | null; files: string }>("SELECT session_id, project_id, files FROM crew_reports WHERE status = 'pending'").toArray()
      .map(p => ({ id: p.session_id, projectId: p.project_id, files: new Set((JSON.parse(p.files) as string[]).map(normalPath)) }));
    return json({ proposals: rows.map(row => this.entry(row, pending)) });
  }
  private entry(row: ListedRow, pending?: { id: string; projectId: string | null; files: Set<string> }[]) {
    const proposal = row.proposal ? JSON.parse(row.proposal) as { title: string; summary: string } : null;
    const files = JSON.parse(row.files) as string[];
    // Other pending proposals of the same project that change one of the same files: merging both means a conflict.
    const overlaps = row.status !== 'pending' || !pending ? [] : pending.filter(p => p.id !== row.session_id && p.projectId === row.project_id && files.some(file => p.files.has(normalPath(file)))).map(p => p.id);
    return { sessionId: row.session_id, crewId: row.crew_id, member: row.member_name ? { name: row.member_name, slug: row.member_slug } : null, projectId: row.project_id,
      title: proposal?.title ?? '', summary: proposal?.summary ?? row.summary, findings: JSON.parse(row.findings) as unknown[], files, filesTotal: row.files_total, filesTruncated: Boolean(row.files_truncated),
      status: row.status, message: row.message,
      branch: row.branch, commit: row.head_commit, baseCommit: row.base_commit, costUsd: row.cost_usd, verifyJobId: row.verify_job_id, verifyJobState: row.job_state,
      overlaps, createdAt: row.created_at, decidedBy: row.decided_by, decidedAt: row.decided_at, note: row.note };
  }
  private one(sessionId: string): ListedRow {
    return this.sql.exec<ListedRow>(`${LIST} WHERE c.session_id = ?`, sessionId).toArray()[0] ?? fail(404, 'not_found', 'Proposal not found');
  }
  private listed(sessionId: string) {
    const pending = this.sql.exec<{ session_id: string; project_id: string | null; files: string }>("SELECT session_id, project_id, files FROM crew_reports WHERE status = 'pending'").toArray()
      .map(p => ({ id: p.session_id, projectId: p.project_id, files: new Set((JSON.parse(p.files) as string[]).map(normalPath)) }));
    return this.entry(this.one(sessionId), pending);
  }

  // Accept or dismiss (operators; the workspace re-checked the caller's membership). A dismissal's note is feedback the
  // member reads in its memory from its next run. A stale proposal may still be decided, a findings-only report (no
  // branch to accept) only dismissed; a decided one may not change.
  decide(userId: string, body: Record<string, unknown>, now: number): Response {
    fields(body, ['sessionId', 'status', 'note']);
    const sessionId = string(body, 'sessionId', 64);
    if (body.status !== 'accepted' && body.status !== 'dismissed') fail(400, 'invalid_field', 'status must be accepted or dismissed');
    const note = body.note === undefined || body.note === null || body.note === '' ? null : string(body, 'note', 2000);
    const row = this.one(sessionId);
    if (row.status === 'findings-only' && body.status === 'accepted') fail(409, 'not_pending', 'A report of findings has no branch to accept; dismiss it once read');
    if (!['pending', 'stale', 'findings-only'].includes(row.status)) fail(409, 'not_pending', `This proposal is ${row.status}, so it can no longer be accepted or dismissed`);
    this.sql.exec('UPDATE crew_reports SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE session_id = ?', body.status, userId, now, note, sessionId);
    if (body.status === 'dismissed' && note) {
      const member = this.sql.exec<{ memory: string }>('SELECT memory FROM crew_members WHERE id = ?', row.crew_id).toArray()[0];
      const title = (row.proposal ? (JSON.parse(row.proposal) as { title: string }).title : '') || row.summary.slice(0, 80);
      if (member) this.sql.exec('UPDATE crew_members SET memory = ? WHERE id = ?', appendMemory(member.memory, `\n\n[Feedback on proposal "${title}" from ${userId}]: ${note}`), row.crew_id);
    }
    return json(this.listed(sessionId));
  }

  // Verify (operators or opted-in finding actions): A build of the member's verifyProduct at the proposal's commit,
  // pinned and so secretless, counted against the member's buildsPerDay and the workspace's lifetime builds. Refusals:
  // 404 not_found, 409 not_pending, 409 crew_member_missing, 400 no_verify_product, 409 invalid_product (the project no
  // longer offers the member's product), 409 verify_refused (the file-touch guard, or a file list the agent had to cut), 429 builds_per_day, 429
  // lifetime_builds, and enqueueBuild's own (429 quota, 503 artifacts_unconfigured).
  verify(body: Record<string, unknown>, now: number, hooks: VerifyHooks): Response {
    const plan = this.verifyPlan(body, now, hooks);
    if (plan.replay) return json(this.listed(plan.sessionId), 201);
    const { row, sessionId, requestId, product, project } = plan;
    if (!hooks.enqueueVerify || !row.branch || !row.head_commit) fail(503, 'builds_unavailable', 'Builds are not available here');
    const job = hooks.enqueueVerify(project.id, product, row.branch, row.head_commit, requestId, plan.timeoutMinutes);
    this.sql.exec('INSERT INTO crew_verifies (job_id, crew_id, session_id, created_at) VALUES (?, ?, ?, ?)', job.id, row.crew_id, sessionId, now);
    this.sql.exec('UPDATE crew_counters SET lifetime_builds = lifetime_builds + 1 WHERE id = 1');
    this.sql.exec("UPDATE crew_reports SET verify_job_id = ?, message = CASE WHEN message LIKE 'Automatic Verify:%' THEN NULL ELSE message END WHERE session_id = ?", job.id, sessionId);
    return json(this.listed(sessionId), 201);
  }
  // Every check of a Verify, read-only, so the workspace can run them before it mints the build's read token (a refused
  // Verify makes no Artifacts call) and again inside the transaction that queues it. Throws the refusal; `replay` when
  // the request already queued its build.
  verifyPlan(body: Record<string, unknown>, now: number, hooks: Pick<VerifyHooks, 'projects' | 'automation'>):
    { replay: true; sessionId: string } | { replay: false; sessionId: string; requestId: string; row: ReportRow; product: string; project: Project | RepoProject; timeoutMinutes?: number } {
    fields(body, ['sessionId', 'requestId']);
    const sessionId = string(body, 'sessionId', 64), requestId = `crew-verify-${sessionId}-${string(body, 'requestId', 64)}`;
    const row = this.one(sessionId);
    // A replayed request answers with the build it queued, counted once.
    if (this.sql.exec('SELECT 1 FROM jobs WHERE request_id = ?', requestId).toArray().length) return { replay: true, sessionId };
    if (row.status !== 'pending') fail(409, 'not_pending', `Only a pending proposal can be verified; this one is ${row.status}`);
    const member = this.sql.exec<{ name: string; verify_product: string | null; budget: string }>('SELECT name, verify_product, budget FROM crew_members WHERE id = ?', row.crew_id).toArray()[0]
      ?? fail(409, 'crew_member_missing', 'This proposal’s crew member no longer exists, so it has no Verify product');
    const product = member.verify_product ?? fail(400, 'no_verify_product', `${member.name} has no Verify product; choose one in its settings to verify its proposals`);
    const project = hooks.projects().find(p => p.id === row.project_id);
    if (!project || !offersProduct(project, product)) fail(409, 'invalid_product', `${project?.name ?? row.project_id} no longer offers ${product}`);
    // A cut list could hide a guarded file among those it left out (the agent lists guarded paths first, but cannot list
    // what it cannot fit), so only a complete list is checked.
    if (row.files_truncated) fail(409, 'verify_refused', `Verify is off for this proposal: the change lists more files than Smith could record${row.files_total === null ? '' : ` (${row.files_total})`}, so Smith cannot tell whether it touches smith.json or a build script. Review the change and build it yourself if you trust it.`);
    const refusal = verifyRefusal(project, product, JSON.parse(row.files) as string[]);
    if (refusal) fail(409, 'verify_refused', refusal);
    const automation = hooks.automation?.(project.id) ?? DEFAULT_PROJECT_AUTOMATION;
    const actionLinked = this.sql.exec('SELECT 1 FROM crew_actions a JOIN crew_runs r ON r.id = a.run_id WHERE r.session_id = ? LIMIT 1', sessionId).toArray().length > 0;
    const bounded = automation.verification.enabled || actionLinked;
    if (bounded && this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM crew_verifies WHERE session_id = ?', sessionId).one().n >= automation.verification.maxAttempts)
      fail(429, 'verify_attempts', 'This proposal has used its allowed Verify attempts');
    const perDay = (JSON.parse(member.budget) as { buildsPerDay: number }).buildsPerDay;
    const today = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM crew_verifies WHERE crew_id = ? AND created_at > ?', row.crew_id, now - DAY_MS).one().n;
    if (today >= perDay) fail(429, 'builds_per_day', `${member.name} has used its ${perDay} Verify build${perDay === 1 ? '' : 's'} for today`);
    if (this.sql.exec("SELECT 1 FROM crew_verifies v JOIN jobs j ON j.id = v.job_id WHERE v.session_id = ? AND j.state IN ('queued','leased','running') LIMIT 1", sessionId).toArray().length)
      fail(409, 'verify_in_progress', 'This proposal already has an active Verify build');
    if (this.lifetime() >= LIFETIME_BUILDS) fail(429, 'lifetime_builds', `This workspace has used all ${LIFETIME_BUILDS.toLocaleString('en-US')} of its lifetime crew builds`);
    return { replay: false, sessionId, requestId, row, product, project, timeoutMinutes: bounded ? automation.verification.timeoutMinutes : undefined };
  }
  lifetime(): number { return this.sql.exec<{ n: number }>('SELECT lifetime_builds AS n FROM crew_counters WHERE id = 1').toArray()[0]?.n ?? 0; }

  // ---- The push and its confirmation ---------------------------------------------------------------------------
  // A crew run's push turn finished (inside ai-finish's transaction). A completed push to Smith's copy waits for Artifacts
  // to confirm the head. A project without a copy was pushed with the machine's own Git login (as a chat's Push branch is),
  // and Smith has nothing to check that head against: the proposal is pending at once, at the commit the run recorded
  // (which Verify pins), and says so. Anything else fails the proposal and the run. The member's next run is free to start
  // either way.
  pushed(session: SessionRow, turn: TurnRow, result: Pick<FinishInput, 'status' | 'message' | 'commit'>, now: number, sessions?: Sessions): void {
    const row = this.sql.exec<ReportRow>("SELECT * FROM crew_reports WHERE session_id = ? AND status = 'pushing'", session.id).toArray()[0];
    if (!row) { new Tokens(this.sql).revokeSession(session.id, now); return; }
    if (result.status === 'completed' && (!result.commit || result.commit === row.head_commit)) {
      if (isArtifactsRemote(session.repo_url)) this.sql.exec("UPDATE crew_reports SET status = 'verifying', pushed_at = ?, message = NULL WHERE session_id = ?", now, session.id);
      else {
        this.sql.exec("UPDATE crew_reports SET status = 'pending', pushed_at = ?, message = NULL WHERE session_id = ?", now, session.id);
        this.staleOlder(row);
        sessions?.note(session.id, turn.id, `Pushed ${row.branch} with this computer's Git login; Smith cannot confirm the head.`, now);
      }
      this.sql.exec("UPDATE crew_runs SET state = 'completed', updated_at = ? WHERE session_id = ? AND state = 'pushing'", now, session.id);
    } else this.failPush(session.id, result.status === 'completed' ? `The push reported ${result.commit!.slice(0, 12)}, not the run’s commit ${row.head_commit?.slice(0, 12) ?? ''}`
      : result.message || `The push ${result.status}`, now);
    new Tokens(this.sql).revokeSession(session.id, now);
  }
  // Push turns that ended without a finish (stopped while queued, refused at their claim, lost with their machine) fail
  // their proposals; nothing is retried. Runs from promote(), so the alarm and every crew finish settle them.
  settleEnded(now: number, sessions: Sessions): void {
    const ended = this.sql.exec<{ session_id: string; turn_id: string; state: string }>(`SELECT c.session_id, t.id AS turn_id, t.state FROM crew_reports c
      JOIN ai_turns t ON t.session_id = c.session_id AND t.kind = 'push' WHERE c.status = 'pushing' AND t.state NOT IN ('queued', 'running') AND t.result IS NULL`).toArray();
    for (const push of ended) {
      const message = push.state === 'lost' ? 'The push was lost with its machine; the branch was not confirmed.' : 'The push was stopped before it ran; the branch was not pushed.';
      this.failPush(push.session_id, message, now);
      sessions.note(push.session_id, push.turn_id, message, now);
    }
  }
  // A push turn no machine claimed in time (Crew.requeueUnclaimed): stopped, and its proposal failed rather than queued
  // again, so the run's project slot is free for the next run.
  expirePush(sessionId: string, turnId: string, now: number, sessions: Sessions): void {
    this.sql.exec("UPDATE ai_turns SET state = 'stopped', updated_at = ? WHERE id = ? AND state = 'queued'", now, turnId);
    // A push turn with no proposal carried only the projects the run created (crew-projects.ts fails those).
    const branch = this.sql.exec("SELECT 1 FROM crew_reports WHERE session_id = ? AND status = 'pushing'", sessionId).toArray().length > 0;
    this.failPush(sessionId, 'no machine pushed the branch', now);
    sessions.note(sessionId, turnId, branch ? 'Smith stopped this push: no machine pushed the branch within 15 minutes, so the proposal failed.'
      : 'Smith stopped this push: no machine pushed the new project(s) within 15 minutes, so they were not created.', now);
  }
  // Artifacts could not be asked about a pushed branch. Answers whether to ask again: yes until REACH_MS after the push,
  // then the proposal fails, so a persistent outage never keeps the alarm re-arming.
  unreachable(sessionId: string, now: number, sessions: Sessions): boolean {
    const row = this.sql.exec<{ pushed_at: number | null }>("SELECT pushed_at FROM crew_reports WHERE session_id = ? AND status = 'verifying'", sessionId).toArray()[0];
    if (!row) return false;
    if (now - (row.pushed_at ?? 0) < REACH_MS) return true;
    const message = 'Artifacts could not be reached to confirm the push';
    this.sql.exec("UPDATE crew_reports SET status = 'failed', message = ? WHERE session_id = ?", message, sessionId);
    const turn = this.sql.exec<{ id: string }>("SELECT id FROM ai_turns WHERE session_id = ? AND kind = 'push' ORDER BY seq DESC LIMIT 1", sessionId).toArray()[0];
    if (turn) sessions.note(sessionId, turn.id, `${message}.`, now);
    new Tokens(this.sql).revokeSession(sessionId, now);
    return false;
  }
  private failPush(sessionId: string, message: string, now: number): void {
    this.sql.exec("UPDATE crew_reports SET status = 'failed', message = ? WHERE session_id = ? AND status IN ('pushing', 'verifying')", message.slice(0, 1000), sessionId);
    this.sql.exec("UPDATE crew_runs SET state = 'failed', updated_at = ? WHERE session_id = ? AND state = 'pushing'", now, sessionId);
    new Tokens(this.sql).revokeSession(sessionId, now);
  }

  // What reconcileCrew asks Artifacts about: each pushed branch still to be confirmed.
  verifying(): { sessionId: string; projectId: string; branch: string }[] {
    return this.sql.exec<{ session_id: string; project_id: string; branch: string }>("SELECT session_id, project_id, branch FROM crew_reports WHERE status = 'verifying' ORDER BY created_at")
      .toArray().map(r => ({ sessionId: r.session_id, projectId: r.project_id, branch: r.branch }));
  }
  // The Artifacts branch head of a pushed proposal (null: the branch is not there, or the project has no copy any more):
  // the run's commit makes it pending, and older pending proposals of the member with its title stale. Answers whether
  // to ask again later (a branch not visible yet, within UNSEEN_MS of its push).
  settle(sessionId: string, head: string | null, copy: boolean, now: number, sessions: Sessions): boolean {
    const row = this.sql.exec<ReportRow>("SELECT * FROM crew_reports WHERE session_id = ? AND status = 'verifying'", sessionId).toArray()[0];
    if (!row) return false;
    const turn = this.sql.exec<{ id: string }>("SELECT id FROM ai_turns WHERE session_id = ? AND kind = 'push' ORDER BY seq DESC LIMIT 1", sessionId).toArray()[0];
    const say = (text: string) => { if (turn) sessions.note(sessionId, turn.id, text, now); };
    new Tokens(this.sql).revokeSession(sessionId, now);
    const short = row.head_commit?.slice(0, 12) ?? '';
    if (head !== null && head === row.head_commit) {
      this.sql.exec("UPDATE crew_reports SET status = 'pending', message = NULL WHERE session_id = ?", sessionId);
      this.staleOlder(row);
      say(`Pushed ${row.branch} at ${short}; awaiting review.`);
      return false;
    }
    if (head === null && copy && now - (row.pushed_at ?? 0) < UNSEEN_MS) return true;
    const message = !copy ? 'The project no longer builds from an Artifacts copy, so the pushed branch could not be confirmed'
      : head === null ? `The Artifacts branch ${row.branch} was not found after the push` : `Artifacts branch head ${head.slice(0, 12)} is not the pushed commit ${short}`;
    this.sql.exec("UPDATE crew_reports SET status = 'failed', message = ? WHERE session_id = ?", message, sessionId);
    say(`${message}.`);
    return false;
  }
  // A proposal just became pending: the member's older pending proposals with its title are stale.
  private staleOlder(row: ReportRow): void {
    const title = row.proposal ? (JSON.parse(row.proposal) as { title: string }).title : '';
    if (title) this.sql.exec(`UPDATE crew_reports SET status = 'stale' WHERE crew_id = ? AND status = 'pending' AND session_id != ? AND json_extract(proposal, '$.title') = ?
      AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM crew_reports WHERE session_id = ?)))`, row.crew_id, row.session_id, title, row.created_at, row.created_at, row.session_id);
  }
  // Write tokens handed to push turns that are over, for reconcileCrew to revoke, and the record that it did. `expired`:
  // the token was handed out longer ago than its TTL (WRITE_TOKEN_TTL, 2 hours), so it no longer works and a revocation
  // that keeps failing may stop being retried. (Artifacts answering not-found counts as revoked: revokeToken ignores 404.)
  writeTokens(now: number): { runId: string; tokenId: string; projectId: string | null; expired: boolean }[] {
    return this.sql.exec<{ id: string; write_token_id: string; project_id: string | null; updated_at: number }>(`SELECT r.id, r.write_token_id, r.updated_at,
      COALESCE(s.project_id, c.project_id) AS project_id FROM crew_runs r LEFT JOIN ai_sessions s ON s.id = r.session_id LEFT JOIN crew_reports c ON c.session_id = r.session_id
      WHERE r.write_token_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ai_turns t WHERE t.session_id = r.session_id AND t.state IN ('queued', 'running'))`).toArray()
      // updated_at is at or after the claim that handed the token out, so this errs towards retrying.
      .map(r => ({ runId: r.id, tokenId: r.write_token_id, projectId: r.project_id, expired: now - r.updated_at > WRITE_TOKEN_TTL * 1000 }));
  }
  tokenRevoked(runId: string, tokenId: string): void { this.sql.exec('UPDATE crew_runs SET write_token_id = NULL WHERE id = ? AND write_token_id = ?', runId, tokenId); }
}
