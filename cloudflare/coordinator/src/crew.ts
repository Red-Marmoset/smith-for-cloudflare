import { retainCheckIns } from './crew-coalescing';
import { CrewFindings } from './crew-findings';
import { CrewOrchestration } from './crew-orchestration';
import { CrewEvents, repositoryKey } from './crew-events';
import { CrewActions } from './crew-actions';
// Autonomous crew: named AI agents that work on projects unattended. This file holds the schema and the Crew class that
// stores members and starts their runs; the member and report model lives in crew-model.ts and the prompt composer in
// crew-prompt.ts, proposals in crew-review.ts, messages in crew-messages.ts and the projects members create in crew-projects.ts
// (all re-exported here, so callers import one module). A run is an AI session of kind 'crew' (sessions.ts),
// so claiming, leases, events and stopping are the chat machinery's.
import { fail, fields, json, string } from './http';
import { aiFeatures, type AiInventory, type AiNode } from './ai';
import { Tokens } from './tokens';
import { crewTurnEnv, type WorkspaceSecret, type WorkspaceSettings } from './settings';
import type { CrewCreator, Project } from './projects';
import { isRepoProject, offersProduct, pipelineBriefing, type RepoProject } from './repo-projects';
import type { FinishInput, Sessions, SessionRow, TurnRow } from './sessions';
import { CREW_REPORT_SCHEMA_INLINE, CREW_REPORT_SCHEMA_STRICT, chooseCrewAi, validateCrewMember, validateCrewReport, type CrewAiPick, type CrewClaimMaterial, type CrewMember, type CrewMode, type CrewPushClaimMaterial, type CrewRelated, type CrewRunBrain, type CrewRunTool, type CrewTool, type CrewTrigger } from './crew-model';
import { composeCrewPrompt } from './crew-prompt';
import { CrewReview, type VerifyHooks } from './crew-review';
import { CrewMessages } from './crew-messages';
import { CrewProjects, type CrewProjectPush, type CrewProjectRequest } from './crew-projects';
import type { ArtifactsSource } from './artifacts-repos';
export * from './crew-model';
export * from './crew-projects';
export * from './crew-messages';
export * from './crew-prompt';
export * from './crew-review';

export const CREW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS crew_members (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, template TEXT, charter TEXT NOT NULL,
    project_ids TEXT NOT NULL, attach_shared INTEGER NOT NULL DEFAULT 0, tool TEXT NOT NULL, brain TEXT NOT NULL, model TEXT, node_id TEXT,
    permission_mode TEXT NOT NULL, trigger TEXT NOT NULL, budget TEXT NOT NULL, verify_product TEXT, may_create_projects INTEGER NOT NULL DEFAULT 0,
    may_message INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, memory TEXT NOT NULL DEFAULT '', last_seen TEXT NOT NULL DEFAULT '{}',
    next_run_at INTEGER, charter_updated_at INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS crew_runs (id TEXT PRIMARY KEY, crew_id TEXT NOT NULL, due_at INTEGER NOT NULL, next_check_at INTEGER, state TEXT NOT NULL,
    trigger TEXT NOT NULL, wait_reason TEXT, session_id TEXT, reserved_usd REAL NOT NULL DEFAULT 0, write_token_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS crew_runs_session ON crew_runs(session_id);
  CREATE TABLE IF NOT EXISTS crew_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, from_crew_id TEXT, from_user_id TEXT, to_crew_id TEXT, session_id TEXT,
    body TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS crew_reports (session_id TEXT PRIMARY KEY, crew_id TEXT NOT NULL, summary TEXT NOT NULL, findings TEXT NOT NULL, proposal TEXT,
    files TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, decided_by TEXT, decided_at INTEGER, note TEXT, verify_job_id TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS crew_projects (project_id TEXT PRIMARY KEY, crew_id TEXT NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
    remote TEXT, status TEXT NOT NULL, message TEXT, token_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`;

// What the workspace supplies to crew actions: its settings and secrets, the sessions a run becomes, its projects, and
// the Worker's origin (the run's MCP endpoint).
export interface CrewHooks extends VerifyHooks { settings: WorkspaceSettings; secrets: Partial<Record<WorkspaceSecret, string>>; sessions: Sessions; origin: string }
// At a claim, also what was minted before the transaction for this turn: the run token, related-project read tokens
// and (for a push turn) the id of the write token handed out and the created projects it pushes, each with its own write token.
export type CrewCreatedPush = CrewProjectPush & { authToken: string; tokenId: string };
export interface CrewClaimContext extends CrewHooks { runToken?: { token: string; hash: string }; related?: CrewRelated[]; writeTokenId?: string; created?: CrewCreatedPush[] }
// Why a run was not started: the HTTP refusal for Run now, and the wait reason the dashboard shows.
export interface CrewRefusal { status: number; code: string; waitReason: string; message: string }
// A run's trigger as stored on the run and its session: the member's trigger kind plus what started it. A dry run
// (Run now's sibling) prepares the run on the machine but never starts the CLI.
type RunTrigger = (CrewTrigger | { kind: 'checkin'; eventId: string }) & { actionId?: string; requestId?: string; jobId?: string; jobState?: string; dryRun?: boolean; intervalMinutes?: number; skipIfUnchanged?: boolean };
// A crew_runs row as the scheduler reads it. States: waiting, queued, running, then completed | failed | stopped | skipped | lost;
// a run that committed is pushing until its push turn ends (completed, or failed). A branch look that found the watched
// branch where the member last saw it ends 'unchanged': not a run (uncounted, its session deleted by retention).
type RunRow = { id: string; crew_id: string; due_at: number; state: string; trigger: string; session_id: string | null; wait_reason: string | null; next_check_at: number | null };
const RUN_COLUMNS = 'id, crew_id, due_at, state, trigger, session_id, wait_reason, next_check_at';
// The build a buildFinished member may wake for (workspace.ts JobRow, the columns read here).
export type FinishedJob = { id: string; kind: string; request_id: string; project_id: string; state: string; secretless: number };
type CrewNode = AiNode & { os: string; purpose: string; run_crew: number; crew_while_building: number };
type MemberRow = { orchestration: string | null; id: string; slug: string; name: string; template: string | null; charter: string; project_ids: string; attach_shared: number; tool: string; brain: string;
  model: string | null; node_id: string | null; permission_mode: string; trigger: string; budget: string; verify_product: string | null; may_create_projects: number;
  may_message: number; enabled: number; memory: string; last_seen: string; next_run_at: number | null; charter_updated_at: number | null; created_by: string; created_at: number; updated_at: number };
const COLUMNS = ['orchestration', 'id', 'slug', 'name', 'template', 'charter', 'project_ids', 'attach_shared', 'tool', 'brain', 'model', 'node_id', 'permission_mode', 'trigger', 'budget', 'verify_product',
  'may_create_projects', 'may_message', 'enabled', 'memory', 'last_seen', 'next_run_at', 'charter_updated_at', 'created_by', 'created_at', 'updated_at'];
const FIXED = ['id', 'slug', 'created_at'];          // never change after creation (created_by is whoever saved it last: its runs are theirs)
const UPSERT = `INSERT INTO crew_members (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT(id) DO UPDATE SET ${COLUMNS.filter(c => !FIXED.includes(c)).map(c => `${c} = excluded.${c}`).join(', ')}`;
const DAY_MS = 86400000;
const MEMORY_BYTES = 32768;                                  // the most a member's memory holds
const RECHECK_MS = 60000;                                    // a waiting run is looked at again no sooner than this (no alarm storm)
const SKIP_AFTER_MS = 3600000;                               // a run still waiting this long after it was due is skipped
const UNCLAIMED_MS = 15 * 60000;                             // a queued crew turn no machine claimed in this long is stopped
const KEEP_SESSIONS = 30;                                    // crew sessions kept per member; older ones are deleted
// The key of a member's lastSeen for a run: the project's own branch under the project ID, a watched other branch beside it.
function seenKey(projectId: string, trigger: { kind: string; branch?: string }): string {
  return trigger.kind === 'branchChanged' && trigger.branch ? `${projectId}@${trigger.branch}` : projectId;
}
const STOPPED_NOTE = 'Smith stopped this run before it started: all crew work is stopped in workspace settings.';

function fromRow(r: MemberRow): CrewMember {
  return { orchestration: r.orchestration ? JSON.parse(r.orchestration) : null, id: r.id, slug: r.slug, name: r.name, template: r.template, charter: r.charter, projectIds: JSON.parse(r.project_ids) as string[], attachSharedProjects: Boolean(r.attach_shared),
    tool: r.tool as CrewTool, brain: r.brain as CrewMember['brain'], model: r.model, nodeId: r.node_id, permissionMode: r.permission_mode as CrewMode, trigger: JSON.parse(r.trigger) as CrewTrigger,
    budget: JSON.parse(r.budget) as CrewMember['budget'], verifyProduct: r.verify_product, mayCreateProjects: Boolean(r.may_create_projects), mayMessage: Boolean(r.may_message),
    enabled: Boolean(r.enabled), memory: r.memory, lastSeen: JSON.parse(r.last_seen) as Record<string, string>, nextRunAt: r.next_run_at, charterUpdatedAt: r.charter_updated_at,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at };
}
const toRow = (m: CrewMember) => [m.orchestration ? JSON.stringify(m.orchestration) : null, m.id, m.slug, m.name, m.template, m.charter, JSON.stringify(m.projectIds), m.attachSharedProjects ? 1 : 0, m.tool, m.brain, m.model, m.nodeId,
  m.permissionMode, JSON.stringify(m.trigger), JSON.stringify(m.budget), m.verifyProduct, m.mayCreateProjects ? 1 : 0, m.mayMessage ? 1 : 0, m.enabled ? 1 : 0, m.memory,
  JSON.stringify(m.lastSeen), m.nextRunAt, m.charterUpdatedAt, m.createdBy, m.createdAt, m.updatedAt];

// The project builds from a finished Cloudflare Artifacts copy (Smith's copy). Optional for crew: without one a run
// checks the project out with the machine's own Git login, as a chat does. Prepared projects and Git-URL projects alike.
export function hasArtifactsCopy(project: Project | RepoProject | undefined): boolean {
  return project?.artifacts?.status === 'done' && project.artifacts.remote === project.repoUrl;
}
// The project builds from a copy Smith keeps, on Cloudflare Artifacts or on Smith's own machines (src/git-host.ts).
export function hasSmithCopy(project: Project | RepoProject | undefined): boolean {
  return hasArtifactsCopy(project) || project?.hosted?.status === 'ready' || (project?.home === 'artifacts' && project.artifacts?.status === 'done');
}
// A project a crew member created: its createdBy names the crew run (crew-projects.ts records it as a repository project; one
// recorded before that is prepared-shaped). A project added from a Git URL is never one: its createdBy is the person's user ID.
export function crewCreated(project: Project | RepoProject | undefined): project is (Project | RepoProject) & { createdBy: CrewCreator } {
  const by = project?.createdBy;
  return typeof by === 'object' && by !== null && typeof by.crewId === 'string';
}
// A crew-made project whose first push Artifacts confirmed and whose smith.json Smith has not been asked to read yet
// (workspace.ts queues that scan from reconcileCrew).
export function crewScanDue(project: Project | RepoProject | undefined): project is RepoProject & { createdBy: CrewCreator } {
  return isRepoProject(project) && crewCreated(project) && hasSmithCopy(project) && !project.scan.jobId && project.scan.state === 'waiting';
}
// Crew-made projects a member attaches (an Extractor reads every shared tool), apart from its own projects; only once their
// first push is confirmed (an Artifacts copy), so no related clone targets an empty repository.
function sharedProjects(member: CrewMember, projects: (Project | RepoProject)[]): (Project | RepoProject)[] {
  return member.attachSharedProjects ? projects.filter(crewCreated).filter(hasSmithCopy).filter(p => !member.projectIds.includes(p.id)) : [];
}
// What a run clones read-only beside its checkout: the member's other projects, then the shared ones it attaches.
export function crewRelatedProjects(member: CrewMember, projects: (Project | RepoProject)[]): (Project | RepoProject)[] {
  return [...member.projectIds.slice(1).flatMap(id => projects.filter(p => p.id === id)), ...sharedProjects(member, projects)];
}
// One of those as the claim hands it to the agent, with its read token ('' for the machine's own Git login).
export function crewRelatedEntry(project: Project | RepoProject, authToken: string): CrewRelated {
  return { projectId: project.id, url: project.repoUrl, commit: project.commit ?? '', branch: project.branch, authToken };
}

// The last `maxBytes` (64 KiB) of a job's log as the dashboard reads it (workspace.ts read-logs: the logs table's chunks in
// seq order, one line each), from the newest chunk back. A log cut there starts at a whole line, after a note that says so.
export const BUILD_LOG_BYTES = 65536;
const LOG_CUT = '[earlier output cut by Smith]\n';
export function jobLogTail(sql: SqlStorage, jobId: string, maxBytes = BUILD_LOG_BYTES): string {
  const encoder = new TextEncoder(), chunks: string[] = [];
  let bytes = 0, cut = false;
  for (const chunk of sql.exec<{ lines: string }>('SELECT lines FROM logs WHERE job_id = ? ORDER BY seq DESC', jobId)) {
    const text = (JSON.parse(chunk.lines) as string[]).map(line => line + '\n').join('');
    chunks.unshift(text); bytes += encoder.encode(text).length;
    if (bytes > maxBytes) { cut = true; break; }
  }
  const all = encoder.encode(chunks.join(''));
  if (!cut) return new TextDecoder().decode(all);
  const window = all.slice(all.length - (maxBytes - encoder.encode(LOG_CUT).length));
  const start = window.indexOf(10) + 1;   // after the first line end: no partial line, nor a split character
  return LOG_CUT + new TextDecoder().decode(start > 0 ? window.slice(start) : window).replace(/^�+/, '');
}

// Explicit finding-action writers have one automatic entry point. Legacy schedules remain
// available to other members, while manual runs remain available to every operator.
function findingActionRequired(member: Pick<CrewMember, 'id' | 'permissionMode' | 'projectIds'>, settings: WorkspaceSettings): boolean {
  const automation = settings.orchestration.projectRules?.[member.projectIds[0]]?.automation;
  return Boolean(automation && member.permissionMode === 'acceptEdits' && (automation.mode !== 'automatic_fix'
    || automation.fixerCrewId === member.id || automation.testCrewId === member.id));
}

export class Crew {
  constructor(private sql: SqlStorage) {}
  get orchestration(): CrewOrchestration { return new CrewOrchestration(this.sql); }
  members(): CrewMember[] { return this.sql.exec<MemberRow>("SELECT * FROM crew_members ORDER BY created_at,id").toArray().map(fromRow); }
  get findings(): CrewFindings { return new CrewFindings(this.sql); }
  get events(): CrewEvents { return new CrewEvents(this.sql); }
  get actions(): CrewActions { return new CrewActions(this.sql); }
  get review(): CrewReview { return new CrewReview(this.sql); }
  get messages(): CrewMessages { return new CrewMessages(this.sql); }
  get projects(): CrewProjects { return new CrewProjects(this.sql); }

  member(id: string): CrewMember | undefined {
    const row = this.sql.exec<MemberRow>('SELECT * FROM crew_members WHERE id = ?', id).toArray()[0];
    return row ? fromRow(row) : undefined;
  }

  // Human actions. `role` is the caller's workspace role; the workspace has already required operator+ for writes.
  execute(userId: string, role: string, action: string, body: Record<string, unknown>, now: number, hooks: CrewHooks): Response {
    if (action === 'crew-finding-action') return this.actions.request(userId,body,this.members(),hooks.settings.orchestration,hooks.settings.crewStopped,now);
    if (action === 'crew-finding-decide') return this.findings.decide(userId,body,now);
    if (action === 'crew-checkin-dry-run') { fields(body,['eventId']); return json({decisions:this.orchestration.evaluate(this.events.get(string(body,'eventId')),this.members(),hooks.settings.orchestration,now,true)}); }
    if (action === 'crew-checkin-retry') { fields(body,['eventId']); const event=this.events.get(string(body,'eventId')); if (!['blocked','pending'].includes(event.state)) fail(409,'not_blocked','Only a blocked check-in can be retried'); this.sql.exec("UPDATE crew_checkins SET state='pending',next_at=?,reason=NULL WHERE id=?",now,event.id); return json({retried:true}); }
    if (action === 'crew-checkin') return this.events.accept(body, hooks.projects(), now);
    if (action === 'crew-checkins') return this.events.list(body);
    if (action === 'crew-checkin-detail') return this.events.detail(body);
    if (action === 'crew-list') {
      fields(body, []);
      return json({ members: this.sql.exec<MemberRow>('SELECT * FROM crew_members ORDER BY created_at, id').toArray().map(fromRow) });
    }
    // Review: proposals (crew-review.ts). Messages: the feed and a person's own (crew-messages.ts).
    if (action === 'crew-review') { fields(body, []); return this.review.list(); }
    if (action === 'crew-decide') return this.review.decide(userId, body, now);
    if (action === 'crew-verify') return this.review.verify(body, now, hooks);
    if (action === 'crew-messages') return this.messages.list(body);
    if (action === 'crew-message') return this.messages.post(userId, body, now);
    if (action === 'crew-message-delete') return this.messages.remove(body);
    if (action === 'crew-put') return this.put(userId, ['owner', 'admin'].includes(role), body, now, hooks);
    // A deleted member's runs stay readable as history, so this lists by ID without needing the member.
    if (action === 'crew-runs') { fields(body, ['crewId']); return json({ runs: this.runs(string(body, 'crewId', 64)) }); }
    if (action === 'crew-project-delete') return this.deleteProject(role, body, now, hooks);
    const member = this.member(string(body, 'crewId', 64)) ?? fail(404, 'not_found', 'Crew member not found');
    if (action === 'crew-prompt') {
      fields(body, ['crewId']);
      return json(this.compose(member, `smith/crew-${member.slug}-<run>`, { kind: 'manual' }, hooks));
    }
    if (action === 'crew-enable') {
      fields(body, ['crewId', 'enabled']);
      if (typeof body.enabled !== 'boolean') fail(400, 'invalid_field', 'enabled must be a boolean');
      this.sql.exec('UPDATE crew_members SET enabled = ?, updated_at = ? WHERE id = ?', body.enabled ? 1 : 0, now, member.id);
      // Resuming makes a schedule that went stale while paused due now, so the member runs once rather than idling an interval.
      if (body.enabled) this.resumeSchedules(now, member.id);
      // Pausing drops a run still waiting to start (so the member can be deleted); one already on a machine carries on.
      if (!body.enabled) this.sql.exec("UPDATE crew_runs SET state = 'skipped', wait_reason = 'disabled', updated_at = ? WHERE crew_id = ? AND state = 'waiting'", now, member.id);
      return json(this.member(member.id));
    }
    if (action === 'crew-delete') {
      fields(body, ['crewId']);
      if (this.active(member.id)) fail(409, 'run_active', `Stop ${member.name}'s run before deleting it`);
      // Its run tokens go with it; its sessions, reports and messages stay as the workspace's history.
      this.sql.exec('UPDATE access_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND session_id IN (SELECT id FROM ai_sessions WHERE crew_id = ?)', now, member.id);
      this.sql.exec('DELETE FROM crew_members WHERE id = ?', member.id);
      return json({ deleted: true });
    }
    if (action === 'crew-run') return this.runNow(member, body, now, hooks);
    fail(404, 'not_found', 'Route not found');
  }

  // A running crew run's own tools, called through its run token (the workspace has resolved the token to `sessionId` and
  // checked that its owner still belongs). A token whose session is no crew run, or whose turn has ended, finds the run
  // over. Bad input is a 400 the model sees through MCP and can retry. Every tool acts for the session's own member only.
  tool(sessionId: string, action: string, body: Record<string, unknown>, now: number, hooks: CrewHooks): Response {
    const crewId = this.liveRun(sessionId, now);
    this.orchestration.assertCurrent(sessionId,now);
    if (action === 'crew-tool-request-review') return this.orchestration.request(sessionId,body,this.members(),hooks.settings.orchestration,now);
    if (action === 'crew-tool-report') {
      fields(body, ['report']);
      const report = validateCrewReport(body.report);
      // A report filed mid-run is findings only, and one filed again replaces it. The report at the end of the run wins over
      // it (finish), and the memory of a report is the run's to give at its end, never the tool's.
      this.sql.exec(`INSERT INTO crew_reports (session_id, crew_id, summary, findings, proposal, status, created_at) VALUES (?, ?, ?, ?, ?, 'findings-only', ?)
        ON CONFLICT(session_id) DO UPDATE SET summary = excluded.summary, findings = excluded.findings, proposal = excluded.proposal, status = excluded.status`,
        sessionId, crewId, report.summary, JSON.stringify(report.findings), report.proposal ? JSON.stringify(report.proposal) : null, now);
      const snap=this.orchestration.forSession(sessionId);
      if(snap){const run=this.sql.exec<{id:string}>('SELECT id FROM crew_runs WHERE session_id=?',sessionId).one();this.findings.ingest(run.id,snap.event.id,snap.event.project_id,snap.event.head_commit,report,now);}
      return json({ filed: true });
    }
    if (action === 'crew-tool-remember') {
      fields(body, ['text']);
      const text = body.text, bytes = typeof text === 'string' ? new TextEncoder().encode(text).length : -1;
      if (typeof text !== 'string' || bytes > MEMORY_BYTES) fail(400, 'invalid_field', `text must be at most ${MEMORY_BYTES} bytes of text`);
      if (!this.member(crewId)) fail(409, 'crew_member_missing', 'This crew run’s member no longer exists');
      this.sql.exec('UPDATE crew_members SET memory = ? WHERE id = ?', text, crewId);
      return json({ bytes });
    }
    if (action === 'crew-tool-send') return this.messages.send(crewId, sessionId, body, now);
    if (action === 'crew-tool-inbox') { fields(body, []); return json({ messages: this.messages.inbox(crewId) }); }
    if (action === 'crew-tool-list') { fields(body, []); return this.messages.roster(hooks.projects().filter(crewCreated).filter(hasSmithCopy)); }
    fail(404, 'not_found', 'Route not found');
  }
  private liveRun(sessionId: string, now = Date.now()): string {
    const run = this.sql.exec<{ crew_id: string | null }>(`SELECT s.crew_id FROM ai_sessions s WHERE s.id = ? AND s.kind = 'crew'
      AND EXISTS (SELECT 1 FROM ai_turns t WHERE t.session_id = s.id AND t.state = 'running' AND t.stop_requested=0 AND t.lease_expires_at>?)`, sessionId, now).toArray()[0];
    if (!run) fail(409, 'run_over', 'This run has ended');
    return run.crew_id ?? '';
  }
  // crew_create_project, around the repository the workspace creates outside any transaction (workspace.ts
  // crewCreateProject): reserve the ID for the running run, then record the project once its repository exists.
  reserveProject(sessionId: string, body: Record<string, unknown>, now: number, ctx: { settings: WorkspaceSettings; source: ArtifactsSource; repoName: (id: string) => string }) {
    if (this.orchestration.forSession(sessionId)) fail(403,'forbidden','Check-in runs cannot create projects');
    return this.projects.reserve(this.liveRun(sessionId, now), sessionId, body, now, ctx);
  }
  recordProject(request: CrewProjectRequest, remote: string, namespace: string, accountId: string, now: number): Response {
    return this.projects.record(request, remote, { namespace, accountId }, now);
  }

  // Start a waiting run now if everything allows it: the session (kind 'crew') with its queued message turn on an eligible
  // machine, and the row queued with its spend reserved. Otherwise say why, without writing anything; the checks run in a
  // fixed order, so the reason given is predictable (workspace switch, member, its budget, the project, the workspace's
  // caps, then a machine).
  startRun(member: CrewMember, run: Pick<RunRow, 'id' | 'trigger'>, now: number, hooks: CrewHooks): { sessionId: string; runId: string } | CrewRefusal {
    const refuse = (status: number, code: string, waitReason: string, message: string): CrewRefusal => ({ status, code, waitReason, message });
    const snapshot=this.orchestration.snapshot(run.id);
    if (snapshot) member={...snapshot.member,enabled:member.enabled,createdBy:member.createdBy};
    const settings = hooks.settings, trigger = JSON.parse(run.trigger) as RunTrigger;
    const registered = hooks.projects().find(project => project.id === member.projectIds[0]);
    if (snapshot && (!registered || repositoryKey(registered.repoUrl) !== snapshot.event.repo_key)) return refuse(409, 'repository_changed', 'repository changed', 'The project repository changed; submit a new check-in');
    const orchestrationRefusal=this.orchestration.refusal(run.id,settings.orchestration,now);
    if(orchestrationRefusal) return refuse(409,'orchestration_wait',orchestrationRefusal,orchestrationRefusal);
    if (settings.crewStopped) return refuse(409, 'stopped', 'stopped: workspace', 'All crew work is stopped in workspace settings');
    const actionRefusal = this.actions.refusal(run.id, settings.orchestration);
    if (actionRefusal) return refuse(409, 'action_disabled', actionRefusal, actionRefusal);
    if (trigger.kind !== 'manual' && !trigger.actionId && findingActionRequired(member, settings))
      return refuse(409, 'project_report_only', 'project automation requires a finding action', 'This project requires a finding action for this automatic writer; an operator may still run it manually');
    if (!member.enabled) return refuse(409, 'disabled', 'disabled', `${member.name} is paused; resume it first`);
    // A run acts as the person who last saved the member (its session's owner, its token's user): someone who still belongs
    // to the workspace and may manage the crew. An operator's re-save takes the member over (crew-put).
    const creator = this.sql.exec<{ role: string }>('SELECT role FROM members WHERE user_id = ?', member.createdBy).toArray()[0];
    if (!creator) return refuse(409, 'creator_missing', 'creator not in workspace', `${member.name} was last saved by someone who has left the workspace; an operator must save it again to run it`);
    if (!['owner', 'admin', 'operator'].includes(creator.role)) return refuse(409, 'creator_demoted', 'creator demoted', `${member.name} was last saved by someone who may no longer manage the crew; an operator must save it again to run it`);
    // Runs that started count, dry runs too; one stopped before any machine took it does not.
    const today = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM crew_runs WHERE crew_id = ? AND started_at > ?', member.id, now - DAY_MS).one().n;
    if (today >= member.budget.runsPerDay) return refuse(429, 'budget', 'budget', `${member.name} has used its ${member.budget.runsPerDay} runs for today`);
    // One crew run per project at a time, so two members never race to change the same code (and one member, whose
    // runs share a clone on the machine, never has two at once).
    const busy = this.sql.exec<{ name: string | null }>(`SELECT m.name FROM ai_sessions s JOIN ai_turns t ON t.session_id = s.id LEFT JOIN crew_members m ON m.id = s.crew_id
      WHERE s.kind = 'crew' AND s.project_id = ? AND t.state IN ('queued', 'running') LIMIT 1`, member.projectIds[0]).toArray()[0];
    const legacyBusy = this.sql.exec("SELECT 1 FROM crew_runs r JOIN ai_sessions s ON s.id=r.session_id WHERE s.project_id=? AND r.snapshot IS NULL AND r.state IN ('queued','running','pushing') LIMIT 1",member.projectIds[0]).toArray().length > 0;
    if (busy && (!snapshot || legacyBusy)) return refuse(409, 'project_busy', `project busy: ${busy.name ?? 'a deleted member'}`, `${busy.name ?? 'Another crew member'} is already working on this project; one crew run per project at a time`);
    // Legacy sessions hold the entire canonical repository, including aliases registered as other projects.
    const aliasBusy = this.sql.exec<{ repo_url: string; snapshot: string | null }>("SELECT s.repo_url,r.snapshot FROM crew_runs r JOIN ai_sessions s ON s.id=r.session_id WHERE r.state IN ('queued','running','pushing')").toArray()
      .some(active => (!snapshot || active.snapshot === null) && registered && repositoryKey(active.repo_url) === repositoryKey(registered.repoUrl));
    if (aliasBusy) return refuse(409, 'project_busy', 'repository busy: legacy crew run', 'A legacy crew run holds this repository, including its project aliases');
    const working = this.sql.exec<{ n: number }>(`SELECT COUNT(DISTINCT s.id) AS n FROM ai_sessions s JOIN ai_turns t ON t.session_id = s.id
      WHERE s.kind = 'crew' AND t.state IN ('queued', 'running')`).one().n;
    if (working >= settings.crewMaxConcurrentRuns) return refuse(409, 'concurrency', 'concurrency', `The workspace already has ${working} crew run${working === 1 ? '' : 's'} working, its limit (Settings)`);
    // API spend: what runs of the last 24 hours reserved and are still running, plus what finished ones cost. Sign-ins and
    // local models spend nothing, and a dry run never starts the CLI. An automatic member only falls back to the key while
    // the limit leaves room for its run; one that named the key is refused here instead.
    const spent = Math.round((this.sql.exec<{ usd: number | null }>(`SELECT SUM(r.reserved_usd + COALESCE(r.cost_usd, 0)) AS usd FROM crew_runs r JOIN ai_sessions s ON s.id = r.session_id
      WHERE s.brain = 'api-key' AND r.started_at > ?`, now - DAY_MS).one().usd ?? 0) * 100) / 100;
    const withinLimit = trigger.dryRun || spent + member.budget.usdPerRun <= settings.crewDailyUsdLimit;
    if (member.brain === 'api-key' && !withinLimit) return refuse(429, 'spend_limit', 'budget', `The crew has used $${spent.toFixed(2)} of its $${settings.crewDailyUsdLimit} in the last 24 hours, which leaves too little for a run of up to $${member.budget.usdPerRun.toFixed(2)}`);
    const projects = hooks.projects();
    const primary = projects.find(p => p.id === member.projectIds[0]);
    if (!primary) return refuse(409, 'unsupported_project', 'project removed', `${member.projectIds[0]} is no longer in this workspace`);
    // A project added from a Git URL has no commit until Smith has read it; a copy normally implies one, but a rescan that failed afterwards can leave it null.
    if (!primary.commit) return refuse(409, 'project_not_read', 'project not read', `Smith has not read ${primary.name} yet; rescan it first`);
    if (member.brain === 'api-key' && !hooks.secrets.anthropicApiKey) return refuse(409, 'no_api_key', 'no API key', 'Set the workspace’s Anthropic API key in Settings first');
    const machines = this.eligibleMachines(member, now, hooks.settings, Boolean(hooks.secrets.anthropicApiKey) && withinLimit);
    // A check-in run's write scope rests on Claude Code's permission prompts, so it never runs in Codex.
    const machine = machines.find(m => m.pick && (!snapshot || (aiFeatures(m.node).includes('crew-orchestration-v1') && m.pick.tool === 'claude-code')));
    if (!machine?.pick) {
      const waitReason = snapshot && machines.some(m => m.pick?.tool === 'claude-code') ? 'agent update required: crew-orchestration-v1'
        : snapshot && machines.some(m => m.pick) ? 'check-in runs need Claude Code' : machines[0]?.reason ?? 'no machine online';
      return refuse(409, 'no_machine', waitReason, `No machine can run ${member.name} now: ${waitReason}`);
    }
    const pick = machine.pick, metered = pick.brain === 'api-key' && !trigger.dryRun;
    const branch = `smith/crew-${member.slug}-${crypto.randomUUID().slice(0, 8)}`;
    const title = trigger.kind === 'interval' ? 'scheduled run' : trigger.kind === 'buildFinished' ? 'after a build' : trigger.kind === 'branchChanged' ? `new commits on ${trigger.branch || primary.branch || 'its branch'}`
      : trigger.dryRun ? 'Dry run' : 'Run now';
    const sessionId = hooks.sessions.createCrewSession({ crewId: member.id, ownerUserId: member.createdBy, nodeId: machine.node.id, projectId: primary.id, tool: pick.tool, brain: pick.brain, model: pick.model,
      repoUrl: primary.repoUrl, baseCommit: snapshot?.event.head_commit ?? primary.commit, branch, title: `${member.name}: ${title}`, permissionMode: member.permissionMode,
      prompt: this.compose({ ...member, ...pick }, branch, trigger, hooks).prompt, trigger: run.trigger }, now);
    this.orchestration.reserve(run.id,now);
    // The budget it reserves for is the one its claim holds the run to (a raised usdPerRun since must not exceed the reservation).
    this.sql.exec("UPDATE crew_runs SET state = 'queued', session_id = ?, reserved_usd = ?, budget = ?, started_at = ?, wait_reason = NULL, next_check_at = NULL, updated_at = ? WHERE id = ?",
      sessionId, metered ? member.budget.usdPerRun : 0, JSON.stringify(member.budget), now, now, run.id);
    return { sessionId, runId: run.id };
  }

  // ---- Scheduler ---------------------------------------------------------------------------------------------------
  // Runs wait in crew_runs (one waiting row per member) until promote() starts them, first come first served. It runs
  // from the alarm, after every crew finish, build completion and settings change, and on heartbeats of crew machines.

  // When the alarm must next look at the crew: an interval member falling due, a waiting run's next check (at least a
  // minute after the last, so a run no machine can take never spins the alarm), or a queued turn's claim deadline.
  nextDue(settings: WorkspaceSettings): number | null {
    if (settings.crewStopped) return null;
    const due = this.sql.exec<{ due: number | null }>(`SELECT MIN(due) AS due FROM (
      SELECT MIN(next_run_at) AS due FROM crew_members WHERE enabled = 1
      UNION ALL SELECT MIN(next_check_at) FROM crew_runs WHERE state = 'waiting'
      UNION ALL SELECT MIN(t.created_at) + ? FROM ai_turns t JOIN ai_sessions s ON s.id = t.session_id WHERE s.kind = 'crew' AND t.kind IN ('message', 'push') AND t.state = 'queued')`, UNCLAIMED_MS).one().due;
    return due ?? null;
  }

  // Interval members that are due get a waiting run; missed windows collapse into it (the one-waiting-row index), and
  // the schedule moves on from now. A branch watcher that is due gets a look at its branch the same way, unless a run of
  // it is already under way (that run sees the branch as it is). Nothing falls due while all crew work is stopped.
  enqueueDue(now: number, settings: WorkspaceSettings): void {
    if (settings.crewStopped) return;
    const due = this.sql.exec<MemberRow>("SELECT * FROM crew_members WHERE enabled = 1 AND next_run_at <= ? AND json_extract(trigger, '$.kind') IN ('interval', 'branchChanged') ORDER BY next_run_at, id", now).toArray().map(fromRow);
    for (const member of due) {
      const watch = member.trigger.kind === 'branchChanged';
      // Due now, not at the stale next_run_at: a window missed for over an hour (paused, Stop all crew) must not be
      // skipped the moment it is inserted. Insertion order (rowid, by next_run_at) keeps first come, first served.
      if (!findingActionRequired(member, settings) && (!watch || !this.active(member.id))) this.wait(member.id, Math.max(member.nextRunAt!, now), member.trigger, now);
      this.sql.exec('UPDATE crew_members SET next_run_at = ? WHERE id = ?', now + (watch ? member.trigger.checkMinutes ?? 5 : member.trigger.intervalMinutes!) * 60000, member.id);
    }
  }

  // A build finished: wake each member that watches its project for that outcome, once per job. Only ordinary builds
  // count; a Verify of a crew branch (pinned, secretless, ai-verify-) or a crew-made project's build never wakes anyone,
  // so the crew cannot set itself off.
  onJobFinished(job: FinishedJob, now: number, settings?: WorkspaceSettings): void {
    if (job.kind !== 'build' || job.secretless || /^(ai-verify-|crew-)/.test(job.request_id) || !['success', 'failed', 'error'].includes(job.state)) return;
    const members = this.sql.exec<MemberRow>("SELECT * FROM crew_members WHERE enabled = 1 AND json_extract(trigger, '$.kind') = 'buildFinished' ORDER BY created_at, id").toArray().map(fromRow);
    for (const member of members) {
      if (settings && findingActionRequired(member, settings)) continue;
      if (!member.projectIds.includes(job.project_id) || (member.trigger.on !== 'any' && job.state === 'success')) continue;
      if (this.sql.exec("SELECT 1 FROM crew_runs WHERE crew_id = ? AND json_extract(trigger, '$.jobId') = ? LIMIT 1", member.id, job.id).toArray().length) continue;
      const trigger: RunTrigger = { kind: 'buildFinished', jobId: job.id, jobState: job.state };
      // A run still waiting for an earlier build is offered this one instead: the newest build is the one worth a look.
      this.sql.exec("UPDATE crew_runs SET trigger = ?, updated_at = ? WHERE crew_id = ? AND state = 'waiting' AND json_extract(trigger, '$.kind') = 'buildFinished'", JSON.stringify(trigger), now, member.id);
      this.wait(member.id, now, trigger, now);
    }
  }

  // Start what may start, oldest due first; each run that may not records why and is looked at again in a minute. A run
  // waiting over an hour past its due time is skipped (its reason stays), and one whose member is gone is dropped.
  // Returns the refusal of each waiting run it could not start, for Run now's answer.
  promote(now: number, hooks: CrewHooks): Map<string, CrewRefusal> {
    const refusals = new Map<string, CrewRefusal>();
    this.settleEnded(now); this.review.settleEnded(now, hooks.sessions); this.settleProjects(now);
    this.orchestration.settle(now);
    if(!hooks.settings.crewStopped) this.orchestration.enqueueReady(this.members(),hooks.settings.orchestration,now);
    this.actions.automatic(this.members(),hooks.settings.orchestration,hooks.settings.crewStopped,now);
    const waiting = this.orchestration.order(this.sql.exec<RunRow>(`SELECT ${RUN_COLUMNS} FROM crew_runs WHERE state = 'waiting' ORDER BY due_at, created_at, rowid`).toArray(),now);
    if (hooks.settings.crewStopped) {
      this.stopAll(now, hooks.sessions);
      for (const run of waiting) refusals.set(run.id, { status: 409, code: 'stopped', waitReason: 'stopped: workspace', message: 'All crew work is stopped in workspace settings' });
      return refusals;
    }
    for (const run of waiting) {
      if(run.due_at > now) continue;
      const member = this.member(run.crew_id);
      if (!member || (!this.orchestration.snapshot(run.id) && run.due_at + SKIP_AFTER_MS < now)) {
        this.sql.exec("UPDATE crew_runs SET state = 'skipped', wait_reason = COALESCE(?, wait_reason), updated_at = ? WHERE id = ?", member ? null : 'member deleted', now, run.id);
        continue;
      }
      const started = this.startRun(member, run, now, hooks);
      if ('sessionId' in started) continue;
      // Rewritten only when the reason changed or its recheck came due, so crew machines' heartbeats do not churn the row.
      if (started.waitReason !== run.wait_reason || run.next_check_at === null || run.next_check_at <= now)
        this.sql.exec('UPDATE crew_runs SET wait_reason = ?, next_check_at = ?, updated_at = ? WHERE id = ?', started.waitReason, now + RECHECK_MS, now, run.id);
      refusals.set(run.id, started);
    }
    // Last, so a run put back here gets its next chance at the next promotion rather than this one.
    this.requeueUnclaimed(now, hooks.sessions); this.settleProjects(now);
    return refusals;
  }

  // Stop all crew: no crew turn starts, the running ones are asked to stop (as ai-session-stop does), queued ones are
  // stopped and their runs wait again, and every active run's token ends now. Idempotent; promote() applies it while the
  // switch is on.
  stopAll(now: number, sessions: Sessions): void {
    const crewTurns = "SELECT t.id FROM ai_turns t JOIN ai_sessions s ON s.id = t.session_id WHERE s.kind = 'crew'";
    this.sql.exec(`UPDATE access_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND session_id IN (SELECT t.session_id FROM ai_turns t JOIN ai_sessions s ON s.id = t.session_id
      WHERE s.kind = 'crew' AND t.state IN ('queued', 'running'))`, now);
    this.sql.exec(`UPDATE ai_turns SET stop_requested = 1, updated_at = ? WHERE state = 'running' AND stop_requested = 0 AND id IN (${crewTurns})`, now);
    for (const turn of this.sql.exec<{ id: string; session_id: string }>(`SELECT id, session_id FROM ai_turns WHERE state = 'queued' AND id IN (${crewTurns})`).toArray()) {
      this.sql.exec("UPDATE ai_turns SET state = 'stopped', updated_at = ? WHERE id = ?", now, turn.id);
      sessions.note(turn.session_id, turn.id, STOPPED_NOTE, now);
      this.requeue(turn.session_id, 'stopped: workspace', now);
    }
  }

  // Keep each member's newest crew sessions; delete everything else of its older ones (events, approvals, turns, the
  // session and its run). A session still working is kept whatever its age; reports stay as review history. The message
  // feed keeps its newest 2,000. Preserve all runs in the rolling budget window, even beyond
  // the display-history cap: startRun uses those rows for both daily runs and API spending.
  retention(now: number): void {
    retainCheckIns(this.sql,now);
    this.messages.retention();
    // A branch look that found nothing new is not history: it goes at once, and never counts toward the 30 kept.
    const unchanged = "EXISTS (SELECT 1 FROM crew_runs r WHERE r.session_id = s.id AND r.state = 'unchanged')";
    const old = this.sql.exec<{ id: string }>(`SELECT id FROM (SELECT s.id, ${unchanged} AS quiet, ROW_NUMBER() OVER (PARTITION BY s.crew_id, ${unchanged} ORDER BY s.created_at DESC, s.id DESC) AS n
      FROM ai_sessions s WHERE s.kind = 'crew' AND NOT EXISTS(SELECT 1 FROM crew_runs r WHERE r.session_id=s.id AND r.event_id IS NOT NULL)) ranked
      WHERE (quiet OR n > ?) AND NOT EXISTS (SELECT 1 FROM ai_turns t WHERE t.session_id = ranked.id AND t.state IN ('queued', 'running'))
      AND NOT EXISTS (SELECT 1 FROM crew_runs r WHERE r.session_id = ranked.id AND r.started_at > ?)`, KEEP_SESSIONS, now - DAY_MS).toArray();
    if (!old.length) return;
    const ids = JSON.stringify(old.map(row => row.id)), inList = 'IN (SELECT value FROM json_each(?))';
    for (const table of ['ai_events', 'ai_approvals', 'ai_turns', 'crew_runs']) this.sql.exec(`DELETE FROM ${table} WHERE session_id ${inList}`, ids);
    this.sql.exec(`DELETE FROM ai_sessions WHERE id ${inList}`, ids);
  }

  // A schedule that went stale (a member paused, or all crew work stopped, past its next run) is due now: the next alarm
  // runs it once and moves it on from there. `crewId` limits it to one member.
  resumeSchedules(now: number, crewId?: string): void {
    this.sql.exec('UPDATE crew_members SET next_run_at = ? WHERE next_run_at < ? AND (? IS NULL OR id = ?)', now, now, crewId ?? null, crewId ?? null);
  }

  // The workspace's builds since it began, against the experiment's lifetime cap (Task 14 counts and enforces it).
  lifetimeBuilds(): number {
    return this.sql.exec<{ n: number }>('SELECT lifetime_builds AS n FROM crew_counters WHERE id = 1').toArray()[0]?.n ?? 0;
  }

  // Run now (and Dry run): a waiting run, promoted at once. It answers with the session it started, or with the reason it
  // could not start and leaves nothing behind, as before the scheduler existed. A member's legacy run already waiting becomes
  // this one (the member runs now either way), and is put back as it was if this one cannot start. A waiting check-in run
  // is left alone: it keeps its event, debounce and pinned commit.
  private runNow(member: CrewMember, body: Record<string, unknown>, now: number, hooks: CrewHooks): Response {
    fields(body, ['crewId', 'requestId', 'dryRun']);
    const requestId = string(body, 'requestId', 64);
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') fail(400, 'invalid_field', 'dryRun must be a boolean');
    // A replayed request returns the run it started, whatever has changed since.
    const existing = this.sql.exec<{ id: string; session_id: string }>("SELECT id, session_id FROM crew_runs WHERE crew_id = ? AND json_extract(trigger, '$.requestId') = ? AND session_id IS NOT NULL", member.id, requestId).toArray()[0];
    if (existing) return json({ sessionId: existing.session_id, runId: existing.id }, 201);
    const trigger = JSON.stringify({ kind: 'manual', requestId, ...(body.dryRun ? { dryRun: true } : {}) } satisfies RunTrigger);
    const pending = this.sql.exec<RunRow>(`SELECT ${RUN_COLUMNS} FROM crew_runs WHERE crew_id = ? AND state = 'waiting' AND event_id IS NULL`, member.id).toArray()[0];
    const runId = pending?.id ?? crypto.randomUUID();
    if (pending) this.sql.exec('UPDATE crew_runs SET trigger = ?, due_at = ?, updated_at = ? WHERE id = ?', trigger, now, now, runId);
    else this.sql.exec("INSERT INTO crew_runs (id, crew_id, due_at, next_check_at, state, trigger, created_at, updated_at) VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?)", runId, member.id, now, now, trigger, now, now);
    const refusal = this.promote(now, hooks).get(runId);
    const run = this.sql.exec<RunRow>(`SELECT ${RUN_COLUMNS} FROM crew_runs WHERE id = ?`, runId).one();
    if (run.state !== 'waiting' && run.session_id && !refusal) return json({ sessionId: run.session_id, runId }, 201);
    if (pending) this.sql.exec('UPDATE crew_runs SET trigger = ?, due_at = ? WHERE id = ?', pending.trigger, pending.due_at, runId);
    else this.sql.exec("DELETE FROM crew_runs WHERE id = ? AND state = 'waiting'", runId);
    const why = refusal ?? { status: 409, code: 'not_started', waitReason: run.wait_reason ?? 'not started', message: `${member.name}'s run could not start` };
    return json({ error: { code: why.code, message: why.message, waitReason: why.waitReason } }, why.status);
  }
  // A waiting run for a member: inserted unless one already waits (it then stands for both).
  private wait(crewId: string, dueAt: number, trigger: RunTrigger, now: number): void {
    this.sql.exec("INSERT OR IGNORE INTO crew_runs (id, crew_id, due_at, next_check_at, state, trigger, created_at, updated_at) VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?)",
      crypto.randomUUID(), crewId, dueAt, dueAt, JSON.stringify(trigger), now, now);
  }
  // Runs whose message turn ended outside finish (stopped while queued, refused at its claim, lost with its machine)
  // settle as that turn did. A lost run may have spent its whole budget, so its reservation stays counted as its cost.
  private settleEnded(now: number): void {
    const ended = this.sql.exec<{ id: string; state: string; turn_state: string }>(`SELECT r.id, r.state, t.state AS turn_state FROM crew_runs r JOIN ai_turns t ON t.session_id = r.session_id AND t.kind = 'message'
      WHERE r.state IN ('queued', 'running') AND t.state NOT IN ('queued', 'running')`).toArray();
    // One still 'queued' was never claimed (stopped while queued, refused at its claim): it never ran, so it does not count
    // toward runsPerDay either.
    for (const run of ended) this.sql.exec(`UPDATE crew_runs SET state = ?, cost_usd = CASE WHEN ? = 'lost' THEN reserved_usd ELSE cost_usd END, reserved_usd = 0,
      started_at = CASE WHEN ? = 'queued' THEN NULL ELSE started_at END, updated_at = ? WHERE id = ?`, run.turn_state, run.turn_state, run.state, now, run.id);
  }
  // Created projects whose run ended without pushing them fail (crew-projects.ts sweep), and a run whose push turn ended
  // without a finish and had no proposal to fail with it (it only pushed created projects) fails too.
  private settleProjects(now: number): void {
    this.projects.sweep(now);
    this.sql.exec(`UPDATE crew_runs SET state = 'failed', updated_at = ? WHERE state = 'pushing'
      AND NOT EXISTS (SELECT 1 FROM ai_turns t WHERE t.session_id = crew_runs.session_id AND t.state IN ('queued', 'running'))
      AND NOT EXISTS (SELECT 1 FROM crew_reports c WHERE c.session_id = crew_runs.session_id AND c.status = 'pushing')`, now);
  }
  // A crew turn queued for 15 minutes that no machine claimed is stopped: a message turn's run waits again, a push turn's
  // proposal fails (its clone is on that machine, so no other could push it), freeing the project's slot either way.
  private requeueUnclaimed(now: number, sessions: Sessions): void {
    const stale = this.sql.exec<{ id: string; session_id: string; kind: string }>(`SELECT t.id, t.session_id, t.kind FROM ai_turns t JOIN ai_sessions s ON s.id = t.session_id
      WHERE s.kind = 'crew' AND t.kind IN ('message', 'push') AND t.state = 'queued' AND t.created_at < ?`, now - UNCLAIMED_MS).toArray();
    for (const turn of stale) {
      if (turn.kind === 'push') { this.review.expirePush(turn.session_id, turn.id, now, sessions); continue; }
      this.sql.exec("UPDATE ai_turns SET state = 'stopped', updated_at = ? WHERE id = ?", now, turn.id);
      sessions.note(turn.session_id, turn.id, 'Smith stopped this run before it started: no machine took it within 15 minutes. It waits to be started again.', now);
      this.requeue(turn.session_id, 'no machine took the run', now);
    }
  }
  // A session's run goes back to waiting, its reservation released and its start uncounted; the stopped session keeps its
  // transcript, but the waiting run no longer names it (a replayed Run now must not answer with it), and gets a new one
  // when it starts again. If the member already has a run waiting, that one stands and this run ends stopped.
  private requeue(sessionId: string, reason: string, now: number): void {
    const run = this.sql.exec<RunRow>(`SELECT ${RUN_COLUMNS} FROM crew_runs WHERE session_id = ? AND state IN ('queued', 'running')`, sessionId).toArray()[0];
    if (!run) return;
    if (!this.orchestration.snapshot(run.id) && this.sql.exec("SELECT 1 FROM crew_runs WHERE crew_id = ? AND state = 'waiting' AND snapshot IS NULL", run.crew_id).toArray().length)
      this.sql.exec("UPDATE crew_runs SET state = 'stopped', reserved_usd = 0, started_at = NULL, wait_reason = ?, updated_at = ? WHERE id = ?", reason, now, run.id);
    else this.sql.exec("UPDATE crew_runs SET state = 'waiting', session_id = NULL, reserved_usd = 0, budget = NULL, started_at = NULL, wait_reason = ?, next_check_at = ?, updated_at = ? WHERE id = ?",
      reason, now + RECHECK_MS, now, run.id);
  }
  // A machine's owner turned crew work off there (node-crew): its crew runs not yet claimed stop, and wait for another machine.
  // A queued push turn stays: only this machine's clone holds its branch, and it runs no CLI.
  releaseNode(nodeId: string, now: number, sessions: Sessions): void {
    for (const turn of this.sql.exec<{ id: string; session_id: string }>(`SELECT t.id, t.session_id FROM ai_turns t JOIN ai_sessions s ON s.id = t.session_id
      WHERE s.node_id = ? AND s.kind = 'crew' AND t.kind = 'message' AND t.state = 'queued'`, nodeId).toArray()) {
      this.sql.exec("UPDATE ai_turns SET state = 'stopped', updated_at = ? WHERE id = ?", now, turn.id);
      sessions.note(turn.session_id, turn.id, 'Smith stopped this run before it started: its machine’s owner turned crew work off there. It waits to be started again.', now);
      this.requeue(turn.session_id, 'machine left crew work', now);
    }
  }

  // Every opted-in machine that could take this member's run (a pinned member considers only its machine), each with the AI
  // the run would use there (chooseCrewAi) or the first reason it cannot run it right now. Build machines are listed first,
  // so their reason is the one a person sees. `apiKeyUsable`: the workspace key is set and its daily limit leaves room.
  eligibleMachines(member: CrewMember, now: number, settings: WorkspaceSettings, apiKeyUsable = false): { node: CrewNode; pick?: CrewAiPick; reason?: string }[] {
    return this.sql.exec<CrewNode>("SELECT * FROM nodes WHERE active = 1 AND run_crew = 1 ORDER BY purpose = 'build' DESC, last_seen_at DESC, id").toArray()
      .filter(node => !member.nodeId || node.id === member.nodeId)
      .map(node => { const pick = this.available(member, node, now, settings, apiKeyUsable); return typeof pick === 'string' ? { node, reason: pick } : { node, pick }; });
  }
  private available(member: CrewMember, node: CrewNode, now: number, settings: WorkspaceSettings, apiKeyUsable: boolean): CrewAiPick | string {
    if (now - node.last_seen_at >= settings.nodeOfflineSeconds * 1000) return 'no machine online';
    // The workspace key only ever goes to machines an admin enrolled for builds, so no member can collect it by
    // enrolling a personal computer; those run on their own sign-ins and their own local models.
    if (member.brain === 'api-key' && node.purpose !== 'build') return 'personal machine';
    if (!aiFeatures(node).includes('crew')) return 'agent update needed';
    // A sign-in counts only when the machine reports it (checked with any API key removed, as the run will be); an unknown
    // state counts as signed out.
    const pick = chooseCrewAi(member, { ai: JSON.parse(node.ai) as AiInventory, buildMachine: node.purpose === 'build', apiKeyUsable }, settings.aiOrder);
    if (typeof pick === 'string') return pick;
    const turn = this.sql.exec<{ kind: string }>("SELECT s.kind FROM ai_turns t JOIN ai_sessions s ON s.id = t.session_id WHERE s.node_id = ? AND t.state IN ('queued', 'running') LIMIT 1", node.id).toArray()[0];
    if (turn) return turn.kind === 'crew' ? 'machine busy: crew run' : 'machine busy: chat';
    if (!node.crew_while_building) {
      const job = this.sql.exec<{ specs: string }>("SELECT specs FROM jobs WHERE node_id = ? AND state IN ('leased', 'running') LIMIT 1", node.id).toArray()[0];
      if (job) { const number = (JSON.parse(job.specs) as Record<string, { buildNumber?: number }>)[node.os]?.buildNumber; return number ? `machine busy: build #${number}` : 'machine busy: build'; }
    }
    return pick;
  }

  // Why a queued crew turn must not start after all, checked at its claim (sessions.ts then stops the turn and notes why):
  // Stop all crew went on; or, for a message turn, what made its machine eligible at promotion no longer holds (its owner
  // turned crew work off, its agent no longer reports the crew feature, a login run's Claude Code is signed out, an api-key
  // run's machine is no longer a build machine) or an api-key run's key was removed. Failing closed here means the CLI never
  // starts somewhere it was not promoted for, nor without its key (crewTurnEnv would silently give it none). A refused
  // message turn's run waits again, saying why, for the next promotion.
  claimRefusal(session: SessionRow, turn: TurnRow, now: number, settings: WorkspaceSettings, secrets: Partial<Record<WorkspaceSecret, string>>): string | null {
    if (settings.crewStopped) return STOPPED_NOTE;
    const actionRun = this.sql.exec<{id:string}>('SELECT id FROM crew_runs WHERE session_id=?',session.id).toArray()[0];
    const actionRefusal = actionRun ? this.actions.refusal(actionRun.id,settings.orchestration) : null;
    if (actionRefusal) { if (turn.kind === 'message') this.requeue(session.id,actionRefusal,now); return actionRefusal; }
    const trigger = JSON.parse(session.trigger ?? '{"kind":"manual"}') as RunTrigger;
    if (trigger.kind !== 'manual' && !trigger.actionId && findingActionRequired({ id: session.crew_id ?? '', permissionMode: turn.permission_mode as CrewMember['permissionMode'], projectIds: [session.project_id] }, settings)) {
      if (turn.kind === 'message') this.requeue(session.id,'project automation requires a finding action',now);
      return 'Project automation no longer permits automatic writes';
    }
    const snapshot = this.orchestration.forSession(session.id);
    if (snapshot) {
      const node = this.sql.exec<CrewNode>('SELECT * FROM nodes WHERE id=?', session.node_id).toArray()[0];
      const registered = this.sql.exec<{ definition: string }>('SELECT definition FROM projects WHERE id=?', snapshot.event.project_id).toArray()[0];
      const repo = registered ? (JSON.parse(registered.definition) as Project).repoUrl : '';
      const reason = !settings.orchestration.enabled ? 'check-in orchestration disabled'
        : !node || !aiFeatures(node).includes('crew-orchestration-v1') ? 'agent update required: crew-orchestration-v1'
        : !repo || repositoryKey(repo) !== snapshot.event.repo_key || repositoryKey(session.repo_url) !== snapshot.event.repo_key ? 'repository changed' : null;
      if (reason) { if (turn.kind === 'message') this.requeue(session.id, reason, now); return reason; }
    }
    if (turn.kind !== 'message') return null;
    // A queued session is not yet working on a machine. Both the Pause button and an editor save
    // must prevent it from starting; a turn already claimed is stopped explicitly by the operator.
    if (turn.state === 'queued' && !this.member(session.crew_id ?? '')?.enabled) {
      this.requeue(session.id, 'disabled', now);
      return 'Smith stopped this run before it started: its crew member is paused or was removed.';
    }
    const node = this.sql.exec<CrewNode>('SELECT * FROM nodes WHERE id = ?', session.node_id).toArray()[0];
    const signedIn = () => (JSON.parse(node!.ai) as AiInventory).tools.find(t => t.id === session.tool)?.signedIn === true;
    const toolName = session.tool === 'codex' ? 'Codex' : 'Claude Code';
    const why: [string, string] | null = !node || !node.run_crew ? ['machine left crew work', 'its machine no longer takes crew work']
      : !aiFeatures(node).includes('crew') ? ['agent update needed', 'its machine’s Smith agent no longer supports crew runs']
      : session.tool === 'codex' && !aiFeatures(node).includes('crew-codex') ? ['agent update needed for Codex', 'its machine’s Smith agent no longer runs crew members with Codex']
      : session.brain === 'login' && !signedIn() ? ['no signed-in machine', `${toolName} on its machine is no longer signed in`]
      : session.brain === 'api-key' && node.purpose !== 'build' ? ['personal machine', 'its machine is no longer a build machine, so it never gets the workspace’s key']
      : session.brain === 'api-key' && !secrets.anthropicApiKey ? ['no API key', 'the workspace no longer has an Anthropic API key (set one in Settings)'] : null;
    if (!why) return null;
    this.requeue(session.id, why[0], now);
    return `Smith stopped this run before it started: ${why[1]}. It waits to be started again.`;
  }

  // The material a crew turn's machine receives at claim, inside the claim's transaction. A message turn gets its system
  // prompt, the brain's environment, a run token stored here (its clock starts with the CLI), its memory and the related
  // clones; a push turn runs no CLI, so it records the write tokens it was handed, for revocation once pushed, names
  // the member whose clone holds the branch (even one deleted since: the clone stays on the machine), says whether there is a
  // branch to push, and lists the projects the run created with their write tokens (the only place those tokens go) and the
  // author their first commits carry.
  claim(session: SessionRow, turn: TurnRow, now: number, ctx: CrewClaimContext): Partial<CrewClaimMaterial> | CrewPushClaimMaterial {
    if (turn.kind === 'push') {
      if (ctx.writeTokenId) this.sql.exec('UPDATE crew_runs SET write_token_id = ?, updated_at = ? WHERE session_id = ?', ctx.writeTokenId, now, session.id);
      const created = ctx.created ?? [], member = this.member(session.crew_id ?? '');
      if (created.length) this.projects.handedOut(session.id, created.map(p => ({ id: p.id, tokenId: p.tokenId })), now);
      return { orchestration: this.orchestration.claim(session.id,now), ...(session.crew_id ? { member: { id: session.crew_id } } : {}), pushBranch: this.pushesBranch(session.id),
        ...(created.length ? { createdProjects: created.map(p => ({ id: p.id, remote: p.remote, authToken: p.authToken })), author: { name: member?.name ?? 'Smith crew', slug: member?.slug ?? 'crew' } } : {}) };
    }
    const current = this.orchestration.forSession(session.id)?.member ?? this.member(session.crew_id ?? '') ?? fail(409, 'crew_member_missing', 'This crew run’s member no longer exists');
    if (!ctx.runToken) fail(503, 'run_token_unavailable', 'Smith could not prepare this run’s token; the machine will retry');
    // The brain, model and mode the run was promoted with are what this machine was chosen for: an edit since then
    // must not, say, hand the workspace key to the personal machine an Ollama member was placed on.
    // So is the budget it reserved for: a usdPerRun or maxMinutes raised since must not carry the run past its reservation.
    const promoted = this.sql.exec<{ budget: string | null }>('SELECT budget FROM crew_runs WHERE session_id = ?', session.id).toArray()[0]?.budget;
    const member: CrewMember = { ...current, tool: session.tool as CrewRunTool, brain: session.brain as CrewRunBrain, model: session.model, permissionMode: turn.permission_mode as CrewMode,
      budget: promoted ? JSON.parse(promoted) as CrewMember['budget'] : current.budget };
    this.sql.exec("UPDATE crew_runs SET state = 'running', updated_at = ? WHERE session_id = ? AND state = 'queued'", now, session.id);
    // A replayed claim (its reply was lost) brings a fresh token; the one it replaces is revoked, so one is live per run.
    const tokens = new Tokens(this.sql);
    tokens.revokeSession(session.id, now);
    tokens.insertRunToken(session.id, session.owner_user_id, ctx.runToken.hash, now + (member.budget.maxMinutes + 15) * 60000, now);
    const trigger = JSON.parse(session.trigger ?? '{"kind":"manual"}') as RunTrigger;
    const changesSince = member.lastSeen[seenKey(session.project_id, trigger)] ?? null;
    const projects = ctx.projects();
    // Claude Code takes the schema inline on its command line; Codex reads it from a file and, as OpenAI's structured
    // output does, wants every property required (the optional ones nullable) and no others.
    return { orchestration: this.orchestration.claim(session.id,now), systemPrompt: this.compose(member, session.branch, trigger, ctx).system, schema: member.tool === 'codex' ? CREW_REPORT_SCHEMA_STRICT : CREW_REPORT_SCHEMA_INLINE,
      // Login and Ollama members get nothing here: the agent keeps the machine's sign-in, or builds the Ollama environment from the model.
      env: crewTurnEnv(member.brain, ctx.secrets), mcp: { url: ctx.origin + '/mcp', token: ctx.runToken.token }, memory: member.memory, inbox: this.messages.inbox(member.id),
      related: ctx.related ?? crewRelatedProjects(member, projects).map(p => crewRelatedEntry(p, '')),
      // A branch watcher's look ends there when the branch has not moved since the member last saw it.
      skipIfCommit: trigger.skipIfUnchanged || trigger.kind === 'branchChanged' ? changesSince : null, budget: member.budget, changesSince, ...(trigger.dryRun ? { dryRun: true as const } : {}),
      // The build that woke a buildFinished run: its log's tail, which the prompt names as input/build-<jobId>.log.
      ...(trigger.kind === 'buildFinished' && trigger.jobId ? { buildLog: { jobId: trigger.jobId, text: jobLogTail(this.sql, trigger.jobId) } } : {}),
      projectBranch: (trigger.kind === 'branchChanged' && trigger.branch) || (projects.find(p => p.id === session.project_id)?.branch ?? ''),
      member: { id: member.id, slug: member.slug, name: member.name, permissionMode: member.permissionMode, mayCreateProjects: member.mayCreateProjects && ctx.settings.crewMayCreateProjects } };
  }

  // A crew message turn finished, inside ai-finish's transaction: keep where it started and what it cost, file its
  // report for review, carry its memory and the commit it saw to the next run, and end its run token. A completed run
  // with a commit is a proposal: Smith queues the push turn of its branch at once (no person asks, and it carries no
  // product: Verify is a person's choice in Review). A run stopped after it committed is not one, so it pushes nothing. The
  // same push turn pushes the projects the run created and left in new-project/ (a run that did not complete pushes none).
  finish(session: SessionRow, _turn: TurnRow, result: FinishInput, now: number, sessions: Sessions): void {
    this.orchestration.assertCurrent(session.id,now);
    const orchestration=this.orchestration.forSession(session.id);
    if(orchestration && result.status==='completed' && result.baseCommit!==orchestration.event.head_commit) fail(409,'commit_mismatch','Run did not review the pinned commit');
    if(orchestration?.config.mode==='read_only' && (result.commit || result.files.length || result.createdProjects.length)) fail(409,'read_only','Reader changed files or created a project');
    this.sql.exec('UPDATE ai_sessions SET base_commit_actual = ?, cost_usd = ? WHERE id = ?', result.baseCommit, result.costUsd, session.id);
    const trigger = JSON.parse(session.trigger ?? '{"kind":"manual"}') as RunTrigger;
    // A branch watcher's look that found the branch where it last saw it: no report, no run counted, nothing kept (retention).
    if (trigger.kind === 'branchChanged' && result.status === 'completed' && result.report?.skipped && !result.commit) {
      this.sql.exec("UPDATE crew_runs SET state = 'unchanged', reserved_usd = 0, started_at = NULL, updated_at = ? WHERE session_id = ? AND state IN ('queued', 'running')", now, session.id);
      new Tokens(this.sql).revokeSession(session.id, now);
      return;
    }
    if(orchestration && result.report){const run=this.sql.exec<{id:string}>('SELECT id FROM crew_runs WHERE session_id=?',session.id).one();this.findings.ingest(run.id,orchestration.event.id,session.project_id,orchestration.event.head_commit,result.report,now);}
    const status = result.status === 'completed' && result.commit ? 'pushing' : result.status === 'stopped' && result.commit ? 'stopped' : 'findings-only';
    const crewId = session.crew_id ?? '', files = JSON.stringify(result.files);
    if (result.report) this.sql.exec(`INSERT INTO crew_reports (session_id, crew_id, summary, findings, proposal, files, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET summary = excluded.summary, findings = excluded.findings, proposal = excluded.proposal, files = excluded.files, status = excluded.status`,
      session.id, crewId, result.report.summary, JSON.stringify(result.report.findings), result.report.proposal ? JSON.stringify(result.report.proposal) : null, files, status, now);
    // No usable report: one filed during the run stands, and a changed branch still needs a row to be reviewed.
    else if (status === 'pushing' || this.sql.exec('SELECT 1 FROM crew_reports WHERE session_id = ?', session.id).toArray().length)
      this.sql.exec(`INSERT INTO crew_reports (session_id, crew_id, summary, findings, files, status, created_at) VALUES (?, ?, '', '[]', ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET files = excluded.files, status = excluded.status`, session.id, crewId, files, status, now);
    // What Review shows of the run, kept on the report so it outlives the session's retention.
    // With how many files it changed and whether their list was cut (crew-review.ts refuses to Verify a cut one).
    this.sql.exec('UPDATE crew_reports SET project_id = ?, branch = ?, head_commit = ?, base_commit = ?, cost_usd = ?, files_total = ?, files_truncated = ? WHERE session_id = ?',
      session.project_id, session.branch, result.commit, result.baseCommit, result.costUsd, result.filesTotal, result.filesTruncated ? 1 : 0, session.id);
    const member = this.member(crewId);
    if (member) {
      // Only a completed run looked at everything up to its base commit, so only it moves skipIfUnchanged's mark.
      const lastSeen = result.status === 'completed' && result.baseCommit ? { ...member.lastSeen, [seenKey(session.project_id, trigger)]: result.baseCommit } : member.lastSeen;
      this.sql.exec('UPDATE crew_members SET memory = ?, last_seen = ? WHERE id = ?', result.report?.memory ?? member.memory, JSON.stringify(lastSeen), member.id);
    }
    // The run settles as the turn ended (an unchanged branch as skipped; one to push stays pushing until its push turn
    // ends), its reservation replaced by what it cost. A metered run whose CLI ran but reported no cost (killed at its time
    // limit, crashed) may have spent all of it, so the reservation stands as its cost. The agent reports the file counts only
    // after the CLI ran (filesTotal), so a skip, a dry run or a failure while preparing is charged nothing; an unmetered run
    // reserved nothing.
    const created = this.projects.afterRun(session.id, result.status === 'completed', result.createdProjects.map(p => p.id), now);
    const settled = status === 'pushing' || created ? 'pushing' : result.status === 'completed' && result.report?.skipped ? 'skipped' : result.status;
    this.sql.exec(`UPDATE crew_runs SET state = ?, cost_usd = CASE WHEN ? IS NOT NULL THEN ? WHEN ? = 1 AND reserved_usd > 0 THEN reserved_usd END, reserved_usd = 0, updated_at = ?
      WHERE session_id = ? AND state IN ('queued', 'running')`, settled, result.costUsd, result.costUsd, result.filesTotal !== null ? 1 : 0, now, session.id);
    new Tokens(this.sql).revokeSession(session.id, now);
    if (status === 'pushing' || created) sessions.addPushTurn(session.id, now, null);
  }
  // Its push turn finished: the branch (crew-review.ts) and the created projects it reports (crew-projects.ts). A run that
  // pushed only created projects ends here as its push did.
  pushed(session: SessionRow, turn: TurnRow, result: Pick<FinishInput, 'status' | 'message' | 'commit'> & { createdProjects?: { id: string; commit?: string }[] }, now: number, sessions?: Sessions): void {
    this.orchestration.assertCurrent(session.id,now);
    this.review.pushed(session, turn, result, now, sessions);
    this.projects.pushed(session.id, result.createdProjects ?? [], now);
    this.sql.exec("UPDATE crew_runs SET state = ?, updated_at = ? WHERE session_id = ? AND state = 'pushing'", result.status === 'completed' ? 'completed' : 'failed', now, session.id);
  }
  // Whether a session's push turn has a branch to push: its run committed and left a proposal.
  pushesBranch(sessionId: string): boolean { return this.sql.exec("SELECT 1 FROM crew_reports WHERE session_id = ? AND status = 'pushing'", sessionId).toArray().length > 0; }

  private put(userId: string, admin: boolean, body: Record<string, unknown>, now: number, hooks: CrewHooks): Response {
    const current = 'id' in body ? this.member(string(body, 'id', 64)) ?? fail(404, 'not_found', 'Crew member not found') : undefined;
    const member = validateCrewMember(body, current, userId, now);
    // Creating projects is a workspace-level power: only owners and admins grant it, or edit a member that holds it.
    if (member.mayCreateProjects && !admin) fail(403, 'forbidden', 'Only workspace owners and admins may let a crew member create projects, or edit one that may');
    if (!current && this.sql.exec('SELECT 1 FROM crew_members WHERE slug = ?', member.slug).toArray().length) fail(409, 'slug_taken', `Another crew member already goes by "${member.slug}"; choose a different name`);
    if (!current && this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM crew_members').one().n >= 50) fail(429, 'quota', 'Experiment crew quota reached');
    const projects = hooks.projects();
    const missing = member.projectIds.find(id => !projects.some(p => p.id === id));
    if (missing) fail(400, 'unsupported_project', `Project not found: ${missing}`);
    const primary = projects.find(p => p.id === member.projectIds[0])!;
    // A project added from a Git URL offers smith.json build actions instead of products (as a chat's push checks them).
    if (member.verifyProduct && !offersProduct(primary, member.verifyProduct)) fail(400, 'invalid_product', `${primary.name} has no product called ${member.verifyProduct}`);
    // A cloud model runs off the machine on someone's Ollama account: never for unattended work.
    if ((member.brain === 'ollama' || member.brain === 'auto') && /[:-]cloud$/.test(member.model ?? '')) fail(400, 'invalid_field', 'Crew members only use models running on a machine, never cloud ones');
    if ('nodeId' in body && member.nodeId && !this.sql.exec('SELECT 1 FROM nodes WHERE id = ? AND active = 1', member.nodeId).toArray().length) fail(400, 'invalid_field', 'No active machine with that ID');
    // A new trigger starts its schedule from now; any other edit keeps the next run where it was.
    if (!current || JSON.stringify(member.trigger) !== JSON.stringify(current.trigger))
      // A branch watcher looks at once, so it knows where the branch is (and runs on what it has not seen yet).
      member.nextRunAt = member.trigger.kind === 'interval' ? now + member.trigger.intervalMinutes! * 60000 : member.trigger.kind === 'branchChanged' ? now : null;
    this.sql.exec(UPSERT, ...toRow(member));
    return json(member, current ? 200 : 201);
  }
  // Owners only: a project a crew member created leaves Smith (and every member's list). Its Artifacts repository stays in the
  // workspace's Cloudflare account. Not while its creator has a run in flight, nor while it is any member's main project.
  private deleteProject(role: string, body: Record<string, unknown>, now: number, hooks: CrewHooks): Response {
    fields(body, ['projectId']);
    if (role !== 'owner') fail(403, 'forbidden', 'Only workspace owners may delete a project a crew member created');
    const id = string(body, 'projectId', 64), project = hooks.projects().find(p => p.id === id);
    if (!crewCreated(project)) fail(404, 'not_found', 'No project a crew member created has that ID');
    const creator = project.createdBy.crewId;
    if (this.active(creator)) fail(409, 'run_active', `Stop ${this.member(creator)?.name ?? 'its crew member'}’s run before deleting ${id}`);
    const main = this.sql.exec<{ name: string }>("SELECT name FROM crew_members WHERE json_extract(project_ids, '$[0]') = ?", id).toArray()[0];
    if (main) fail(409, 'project_in_use', `${main.name} works on ${id} as its main project; give it another project first`);
    this.projects.remove(id, now);
    return json({ deleted: true, repositoryKept: true, message: `Smith no longer lists ${id}. Its Cloudflare Artifacts repository ${project.artifacts?.repo ?? id} remains in the workspace’s Cloudflare account; delete it there if nobody needs it.` });
  }
  // A run is in flight while it waits for promotion or its session has a queued or running turn.
  private active(crewId: string): boolean {
    return this.sql.exec(`SELECT 1 FROM crew_runs WHERE crew_id = ? AND state = 'waiting'
      UNION ALL SELECT 1 FROM ai_turns t JOIN ai_sessions s ON s.id = t.session_id WHERE s.crew_id = ? AND t.state IN ('queued', 'running') LIMIT 1`, crewId, crewId).toArray().length > 0;
  }
  private compose(member: CrewMember, branch: string, trigger: RunTrigger, hooks: Pick<CrewHooks, 'projects' | 'settings'>): { system: string; prompt: string } {
    const projects = hooks.projects();
    const previous = this.sql.exec<{ summary: string }>("SELECT summary FROM crew_reports WHERE crew_id = ? AND summary != '' ORDER BY created_at DESC LIMIT 1", member.id).toArray()[0];
    const checkIn = trigger.kind === 'checkin' ? this.events.get(trigger.eventId) : null;
    const action = trigger.actionId ? this.sql.exec<{kind:'fix'|'regression_test';evidence:string}>('SELECT kind,evidence FROM crew_actions WHERE id=?',trigger.actionId).toArray()[0] : undefined;
    return composeCrewPrompt({ member, branch, baseCommit: checkIn?.head_commit ?? null, trigger,
      ...(action ? { action } : {}),
      ...(checkIn ? { checkIn: { eventId: checkIn.id, baseCommit: checkIn.base_commit, headCommit: checkIn.head_commit, branch: checkIn.branch } } : {}),
      previousSummary: previous?.summary ?? null, inbox: this.messages.inbox(member.id),
      projects: member.projectIds.flatMap(id => projects.filter(p => p.id === id)).map(p => ({ id: p.id, name: p.name, repoUrl: p.repoUrl, branch: p.branch, pipeline: pipelineBriefing(p) })),
      sharedProjects: sharedProjects(member, projects).map(p => ({ id: p.id, purpose: p.purpose ?? '', remote: p.repoUrl })),
      mayCreateProjects: !checkIn && member.mayCreateProjects && hooks.settings.crewMayCreateProjects });
  }
  private runs(crewId: string) {
    type RunRow = { id: string; session_id: string | null; state: string; trigger: string; wait_reason: string | null; due_at: number; created_at: number; updated_at: number;
      node_id: string | null; branch: string | null; cost_usd: number | null; base_commit_actual: string | null; turn_state: string | null; turn_result: string | null;
      summary: string | null; findings: string | null; proposal: string | null; files: string | null; report_status: string | null };
    const rows = this.sql.exec<RunRow>(`SELECT r.id, r.session_id, r.state, r.trigger, r.wait_reason, r.due_at, r.created_at, r.updated_at, s.node_id, s.branch, s.cost_usd, s.base_commit_actual,
        t.state AS turn_state, t.result AS turn_result, c.summary, c.findings, c.proposal, c.files, c.status AS report_status
      FROM crew_runs r LEFT JOIN ai_sessions s ON s.id = r.session_id LEFT JOIN ai_turns t ON t.session_id = r.session_id AND t.kind = 'message'
        LEFT JOIN crew_reports c ON c.session_id = r.session_id WHERE r.crew_id = ? AND r.state != 'unchanged' ORDER BY r.created_at DESC, r.id LIMIT 50`, crewId).toArray();
    return rows.map(r => ({ id: r.id, sessionId: r.session_id,
      // While a run is queued or running, its turn is the truth: a stop or a lost machine shows at once.
      state: (r.state === 'queued' || r.state === 'running') && r.turn_state ? r.turn_state : r.state,
      trigger: JSON.parse(r.trigger) as RunTrigger, waitReason: r.wait_reason, dueAt: r.due_at, nodeId: r.node_id, branch: r.branch, costUsd: r.cost_usd, baseCommit: r.base_commit_actual,
      commit: r.turn_result ? (JSON.parse(r.turn_result) as { commit: string | null }).commit : null,
      report: r.report_status ? { summary: r.summary, findings: JSON.parse(r.findings ?? '[]') as unknown[], proposal: r.proposal ? JSON.parse(r.proposal) as unknown : null,
        files: JSON.parse(r.files ?? '[]') as string[], status: r.report_status } : null,
      createdAt: r.created_at, updatedAt: r.updated_at }));
  }
}
