// Shared projects a crew member creates (crew_create_project), when the workspace setting and the member's own flag allow
// it, on the workspace's own Cloudflare Artifacts account. The tool reserves the ID (`reserve`), the workspace creates the
// repository outside any transaction and records the project (`record`); the run writes its files to new-project/<id>, the
// run's push turn pushes them (`claimRows`, `pushed`), and reconcileCrew confirms the head through the Artifacts API
// (`settle`) before the crew is told; the workspace then queues a scan so Smith reads its smith.json. SQL only; the Artifacts
// calls and the scan are workspace.ts's. Re-exported from crew.ts.
//
// crew_projects.status: reserved -> pushing -> ready; error (the repository could not be made), expired (a reservation that
// never got its repository, after an hour), failed (nothing was pushed, or Artifacts shows another head). A pushing row with
// head_commit is pushed and waits for Artifacts to confirm it. Leaving `pushing` for failed removes the Smith project; an
// owner's delete removes the row, or marks it deleted until its write token is revoked.
import { fail, fields, json, string } from './http';
import type { Project, ProjectArtifacts } from './projects';
import type { RepoProject } from './repo-projects';
import { CrewMessages } from './crew-messages';
import { WRITE_TOKEN_TTL } from './artifacts-repos';
import type { WorkspaceSettings } from './settings';
import type { ArtifactsSource } from './artifacts-repos';

export const CREW_PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const RESERVE_MS = 3600000;              // a reservation without its repository after this long no longer holds the ID
const UNSEEN_MS = 10 * 60000;            // a pushed head Artifacts still does not show after this long has failed
const REACH_MS = 2 * 3600000;            // Artifacts unreachable this long after the push: the project fails, retries stop
const PROJECT_CAP = 20;                  // shared with the projects people add (workspace.ts)
const MAX_PER_RUN = 5;                   // what one finish may list (sessions.ts)
const OPEN = "status IN ('reserved', 'pushing')";
const TURN_ACTIVE = "EXISTS (SELECT 1 FROM ai_turns t WHERE t.session_id = crew_projects.session_id AND t.state IN ('queued', 'running'))";
type Row = { project_id: string; crew_id: string; session_id: string; request_id: string; remote: string | null; status: string; message: string | null; token_id: string | null;
  created_at: number; updated_at: number; head_commit: string | null; pushed_at: number | null; account_id: string | null; repo: string | null };
// What the tool answers: the project, its remote, and where the run puts its files.
export interface CrewProjectAnswer { projectId: string; remote: string; dir: string }
// A reservation the workspace turns into a repository: `key` is the request as stored (scoped to the run).
export interface CrewProjectRequest { key: string; id: string; name: string; description: string; purpose: string; repo: string; crewId: string; sessionId: string }
// A created project the push turn pushes, with what its write token is minted for.
export interface CrewProjectPush { id: string; remote: string; repo: string; accountId: string }

// The workspace's project slots in use: its projects plus the reservations still waiting for their repository (a pushing
// reservation already has its project row). Every add path (people's and the crew's) checks this against PROJECT_CAP.
export function projectSlotsUsed(sql: SqlStorage): number {
  return sql.exec<{ n: number }>("SELECT (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM crew_projects WHERE status = 'reserved') AS n").one().n;
}
const answer = (r: Row): CrewProjectAnswer => ({ projectId: r.project_id, remote: r.remote ?? '', dir: `new-project/${r.project_id}` });

export class CrewProjects {
  constructor(private sql: SqlStorage) {}
  private get messages(): CrewMessages { return new CrewMessages(this.sql); }
  private one(where: string, ...args: unknown[]): Row | undefined { return this.sql.exec<Row>(`SELECT * FROM crew_projects WHERE ${where}`, ...args).toArray()[0]; }

  // ---- Creation: reserve, then (after the repository exists) record -------------------------------------------------
  // The tool's checks, in a fixed order, then the reservation. A replayed request answers as the first one did, whatever
  // has changed since. `repoName` names the Artifacts repository for an ID.
  reserve(crewId: string, sessionId: string, body: Record<string, unknown>, now: number, ctx: { settings: WorkspaceSettings; source: ArtifactsSource; repoName: (id: string) => string }):
    { replay: Response } | { request: CrewProjectRequest } {
    fields(body, ['requestId', 'id', 'name', 'description', 'purpose']);
    const key = `${sessionId}/${string(body, 'requestId', 64)}`;
    const id = string(body, 'id', 64), name = string(body, 'name', 128).trim(), purpose = string(body, 'purpose', 1000).trim();
    const description = body.description === undefined ? '' : typeof body.description === 'string' && body.description.length <= 256 ? body.description : fail(400, 'invalid_field', 'description must be at most 256 characters');
    const replayed = this.one('request_id = ?', key);
    if (replayed) return { replay: this.replay(replayed) };
    const member = this.sql.exec<{ slug: string; may_create_projects: number }>('SELECT slug, may_create_projects FROM crew_members WHERE id = ?', crewId).toArray()[0];
    if (!member) fail(409, 'crew_member_missing', 'This crew run’s member no longer exists');
    if (!ctx.settings.crewMayCreateProjects) fail(403, 'forbidden', 'Creating projects is off in this workspace: an owner must allow crew members to create projects in Settings first. Describe the project in your report instead.');
    if (!member.may_create_projects) fail(403, 'forbidden', 'This crew member may not create projects: an owner or admin must allow it in the member’s settings. Describe the project in your report instead.');
    if (ctx.source !== 'workspace') fail(503, 'artifacts_unconfigured', 'Crew members create projects only on the workspace’s own Cloudflare account: an owner must set its Cloudflare account ID and API token in Settings first.');
    if (!name || !purpose) fail(400, 'invalid_field', 'name and purpose must not be empty');
    if (!CREW_PROJECT_ID.test(id)) fail(400, 'invalid_field', 'The project ID must be 2–40 lower-case letters, digits and hyphens, starting with a letter or digit');
    if (id === 'smoke') fail(400, 'invalid_field', 'smoke is a reserved project ID');
    this.expireReservations(now);
    if (this.sql.exec('SELECT 1 FROM projects WHERE id = ?', id).toArray().length || this.one(`project_id = ? AND ${OPEN}`, id)) fail(409, 'project_exists', `A project with the ID ${id} already exists; choose another ID`);
    if (this.sql.exec('SELECT 1 FROM crew_members WHERE slug = ?', id).toArray().length) fail(409, 'project_exists', `${id} is a crew member’s name; choose another ID`);
    if (projectSlotsUsed(this.sql) >= PROJECT_CAP) fail(429, 'quota', 'Experiment project quota reached: the workspace has its 20 projects');
    if (this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM crew_projects WHERE session_id = ? AND ${OPEN}`, sessionId).one().n >= MAX_PER_RUN) fail(429, 'quota', `A run may create at most ${MAX_PER_RUN} projects`);
    // A project that failed, or whose reservation lapsed, no longer holds its ID.
    this.sql.exec(`DELETE FROM crew_projects WHERE project_id = ? AND NOT ${OPEN}`, id);
    this.sql.exec("INSERT INTO crew_projects (project_id, crew_id, session_id, request_id, status, repo, created_at, updated_at) VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?)", id, crewId, sessionId, key, ctx.repoName(id), now, now);
    return { request: { key, id, name, description, purpose, repo: ctx.repoName(id), crewId, sessionId } };
  }
  private replay(r: Row): Response {
    if (r.status === 'pushing' || r.status === 'ready') return json(answer(r), 201);
    if (r.status === 'reserved') fail(409, 'project_pending', `Project ${r.project_id} is still being created; try again in a moment`);
    fail(r.status === 'error' ? 502 : 409, r.status === 'error' ? 'artifacts_failed' : 'project_failed', `Project ${r.project_id} could not be created: ${r.message ?? r.status}`);
  }
  // The repository exists: the project joins the workspace as a repository project of the Artifacts copy (as one added from a
  // Git URL: Smith reads its smith.json once its first push is confirmed, so its build actions appear), marked as the crew
  // run's, and waits for that push. Answers rather than throws when the reservation is gone, so its row stays as it is.
  record(request: CrewProjectRequest, remote: string, artifacts: Pick<ProjectArtifacts, 'namespace' | 'accountId'>, now: number): Response {
    const r = this.one('request_id = ?', request.key);
    if (!r || r.status !== 'reserved') return r ? this.replay(r) : json({ error: { code: 'project_failed', message: `Project ${request.id} could not be created: its reservation ended` } }, 409);
    if (this.sql.exec('SELECT 1 FROM projects WHERE id = ?', request.id).toArray().length) {
      this.error(request.key, 'a project with this ID was added meanwhile', now);
      return json({ error: { code: 'project_exists', message: `A project with the ID ${request.id} already exists; choose another ID` } }, 409);
    }
    // A person may have added a project while the repository was being made: the cap holds at the insert too.
    if (this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM projects').one().n >= PROJECT_CAP) {
      this.error(request.key, 'the workspace reached its 20 projects while the repository was being made', now);
      return json({ error: { code: 'quota', message: `Experiment project quota reached: the workspace reached its 20 projects while ${request.id} was being made` } }, 429);
    }
    const project: RepoProject = { kind: 'repo', id: request.id, name: request.name, customName: true, repoUrl: remote, source: 'git', branch: 'main', commit: null,
      scan: { state: 'waiting', message: 'Waiting for the crew run’s first push.', via: null, host: null, jobId: null, at: now }, actions: [], unusedRules: 0, disabledRules: 0, warnings: [], createdAt: now,
      artifacts: { repo: request.repo, namespace: artifacts.namespace, remote, status: 'pushing', accountId: artifacts.accountId, source: 'workspace', sourceRepoUrl: remote, updatedAt: now },
      createdBy: { crewId: request.crewId, sessionId: request.sessionId }, purpose: request.purpose };
    this.sql.exec('INSERT INTO projects VALUES (?, ?)', project.id, JSON.stringify(project));
    this.sql.exec("UPDATE crew_projects SET status = 'pushing', remote = ?, account_id = ?, updated_at = ? WHERE request_id = ?", remote, artifacts.accountId, now, request.key);
    return json(answer({ ...r, remote }), 201);
  }
  error(key: string, message: string, now: number): void {
    this.sql.exec("UPDATE crew_projects SET status = 'error', message = ?, updated_at = ? WHERE request_id = ? AND status = 'reserved'", message.slice(0, 1000), now, key);
  }

  // ---- The run's end and its push turn ------------------------------------------------------------------------------
  // The message turn finished: a project whose directory the run did not leave (or of a run that did not complete) fails.
  // Answers whether any is left for the push turn.
  afterRun(sessionId: string, completed: boolean, listed: string[], now: number): boolean {
    for (const r of this.waiting(sessionId)) {
      if (!completed) this.fail(r, 'the run did not complete', now);
      else if (!listed.includes(r.project_id)) this.fail(r, `the run left no usable new-project/${r.project_id} directory (it must hold only plain files and folders, without .git)`, now);
    }
    return this.waiting(sessionId).length > 0;
  }
  // What the push turn pushes: the run's created projects still waiting for their push.
  claimRows(sessionId: string): CrewProjectPush[] {
    return this.waiting(sessionId).filter(r => r.remote && r.repo && r.account_id).map(r => ({ id: r.project_id, remote: r.remote!, repo: r.repo!, accountId: r.account_id! }));
  }
  handedOut(sessionId: string, tokens: { id: string; tokenId: string }[], now: number): void {
    for (const t of tokens) this.sql.exec(`UPDATE crew_projects SET token_id = ?, updated_at = ? WHERE project_id = ? AND session_id = ? AND ${OPEN}`, t.tokenId, now, t.id, sessionId);
  }
  // The push turn finished: each project it reports waits for Artifacts to confirm the head; any other has failed.
  pushed(sessionId: string, reported: { id: string; commit?: string }[], now: number): void {
    for (const r of this.waiting(sessionId)) {
      const commit = reported.find(p => p.id === r.project_id)?.commit;
      if (commit) this.sql.exec('UPDATE crew_projects SET head_commit = ?, pushed_at = ?, updated_at = ? WHERE project_id = ?', commit, now, now, r.project_id);
      else this.fail(r, 'the push turn did not push it', now);
    }
  }
  // From the scheduler: a reservation an hour old expires, and a project whose run ended without pushing it fails (its
  // push turn was stopped, lost or never claimed).
  sweep(now: number): void {
    this.expireReservations(now);
    for (const r of this.sql.exec<Row>(`SELECT * FROM crew_projects WHERE status = 'pushing' AND head_commit IS NULL AND NOT ${TURN_ACTIVE}`).toArray())
      this.fail(r, 'the run ended before Smith pushed it', now);
  }
  private expireReservations(now: number): void {
    this.sql.exec("UPDATE crew_projects SET status = 'expired', message = 'the reservation lapsed before its repository was made', updated_at = ? WHERE status = 'reserved' AND created_at < ?", now, now - RESERVE_MS);
  }
  private waiting(sessionId: string): Row[] {
    return this.sql.exec<Row>("SELECT * FROM crew_projects WHERE session_id = ? AND status = 'pushing' AND head_commit IS NULL ORDER BY created_at, project_id", sessionId).toArray();
  }
  // A project that will not be: its Smith project goes (nothing usable was pushed), and its member hears why in its next inbox.
  private fail(r: Row, reason: string, now: number): void {
    this.sql.exec("UPDATE crew_projects SET status = 'failed', message = ?, updated_at = ? WHERE project_id = ?", reason.slice(0, 1000), now, r.project_id);
    const stored = this.sql.exec<{ definition: string }>('SELECT definition FROM projects WHERE id = ?', r.project_id).toArray()[0];
    const by = stored ? (JSON.parse(stored.definition) as Project | RepoProject).createdBy : undefined;
    if (typeof by === 'object' && by.sessionId === r.session_id) this.forget(r.project_id);
    this.messages.system(r.crew_id, `Project ${r.project_id} could not be created: ${reason}.`, now);
  }

  // ---- Confirmation (reconcileCrew) ---------------------------------------------------------------------------------
  // Pushed projects whose head Artifacts is still to confirm.
  verifying(): { id: string; repo: string; accountId: string }[] {
    return this.sql.exec<Row>("SELECT * FROM crew_projects WHERE status = 'pushing' AND head_commit IS NOT NULL ORDER BY created_at").toArray()
      .map(r => ({ id: r.project_id, repo: r.repo ?? '', accountId: r.account_id ?? '' }));
  }
  // The Artifacts head of a pushed project's main branch (null: not there yet). The pushed commit makes it ready: the
  // project builds from it (once the workspace's scan has read its smith.json), the creator works on it from its next run,
  // and everyone is told. Answers whether to ask again.
  settle(id: string, head: string | null, now: number): boolean {
    const r = this.one("project_id = ? AND status = 'pushing' AND head_commit IS NOT NULL", id);
    if (!r) return false;
    if (head === null && now - (r.pushed_at ?? 0) < UNSEEN_MS) return true;
    if (head !== r.head_commit) { this.fail(r, head === null ? 'Artifacts never showed the pushed main branch' : `Artifacts branch head ${head.slice(0, 12)} is not the pushed commit ${r.head_commit!.slice(0, 12)}`, now); return false; }
    const stored = this.sql.exec<{ definition: string }>('SELECT definition FROM projects WHERE id = ?', id).toArray()[0];
    if (!stored) { this.fail(r, 'its Smith project was removed', now); return false; }
    const project = JSON.parse(stored.definition) as Project | RepoProject;
    const pushed = r.head_commit!;
    const ready = { ...project, commit: pushed, artifacts: project.artifacts && { ...project.artifacts, status: 'done' as const, pushedCommit: pushed, updatedAt: now } };
    this.sql.exec('UPDATE projects SET definition = ? WHERE id = ?', JSON.stringify(ready), id);
    this.sql.exec("UPDATE crew_projects SET status = 'ready', message = NULL, updated_at = ? WHERE project_id = ?", now, id);
    const member = this.sql.exec<{ name: string; project_ids: string }>('SELECT name, project_ids FROM crew_members WHERE id = ?', r.crew_id).toArray()[0];
    const ids = member ? JSON.parse(member.project_ids) as string[] : [];
    if (member && !ids.includes(id) && ids.length < 10) this.sql.exec('UPDATE crew_members SET project_ids = ? WHERE id = ?', JSON.stringify([...ids, id]), r.crew_id);
    // The purpose is the member's own words, so it is quoted and attributed, never Smith's voice.
    const by = member?.name ?? 'a deleted crew member';
    this.messages.system(null, `New shared project \`${id}\` by ${by}. Purpose (written by ${by}, untrusted): ${JSON.stringify(project.purpose ?? '')}`, now);
    return false;
  }
  // Artifacts could not be asked: again until REACH_MS after the push, then the project fails.
  unreachable(id: string, now: number): boolean {
    const r = this.one("project_id = ? AND status = 'pushing' AND head_commit IS NOT NULL", id);
    if (!r) return false;
    if (now - (r.pushed_at ?? 0) < REACH_MS) return true;
    this.fail(r, 'Artifacts could not be reached to confirm the push', now);
    return false;
  }
  // Write tokens handed to push turns that are over, for reconcileCrew to revoke (`expired`: past their TTL, so a
  // revocation that keeps failing may stop being retried), and the record that it did.
  writeTokens(now: number): { id: string; tokenId: string; accountId: string; repo: string; expired: boolean }[] {
    return this.sql.exec<Row>(`SELECT * FROM crew_projects WHERE token_id IS NOT NULL AND NOT ${TURN_ACTIVE}`).toArray()
      .map(r => ({ id: r.project_id, tokenId: r.token_id!, accountId: r.account_id ?? '', repo: r.repo ?? '', expired: now - r.updated_at > WRITE_TOKEN_TTL * 1000 }));
  }
  tokenRevoked(id: string, tokenId: string): void {
    this.sql.exec('UPDATE crew_projects SET token_id = NULL WHERE project_id = ? AND token_id = ?', id, tokenId);
    this.sql.exec("DELETE FROM crew_projects WHERE project_id = ? AND status = 'deleted' AND token_id IS NULL", id);   // a deleted project's record goes with its token
  }

  // ---- Deletion (owners) ------------------------------------------------------------------------------------------
  // The Smith project and its record go; every member stops listing it. The Artifacts repository stays. A record still
  // holding a write token stays as 'deleted' until reconcileCrew has revoked it (writeTokens), then goes with the next
  // reservation of its ID.
  remove(id: string, now: number): void {
    this.forget(id);
    this.sql.exec("UPDATE crew_projects SET status = 'deleted', updated_at = ? WHERE project_id = ? AND token_id IS NOT NULL", now, id);
    this.sql.exec('DELETE FROM crew_projects WHERE project_id = ? AND token_id IS NULL', id);
  }
  // A created project the push turn cannot push after all (its write token could not be minted): failed with the real reason.
  failCreated(id: string, sessionId: string, reason: string, now: number): void {
    const r = this.one("project_id = ? AND session_id = ? AND status = 'pushing'", id, sessionId);
    if (r) this.fail(r, reason, now);
  }
  private forget(id: string): void {
    this.sql.exec('DELETE FROM projects WHERE id = ?', id);
    for (const m of this.sql.exec<{ id: string; project_ids: string }>('SELECT id, project_ids FROM crew_members').toArray()) {
      const ids = JSON.parse(m.project_ids) as string[];
      if (ids.includes(id)) this.sql.exec('UPDATE crew_members SET project_ids = ? WHERE id = ?', JSON.stringify(ids.filter(p => p !== id)), m.id);
    }
  }
}
