import { fail, fields, HttpError, json, string } from './http';
import { CrewEvents } from './crew-events';
import { CrewOrchestration } from './crew-orchestration';
import { projectAutomation, type OrchestrationPolicy } from './crew-orchestration-model';
import type { CrewMember } from './crew-model';

type ActionRow = { id: string; finding_id: string; event_id: string; kind: string; target_crew_id: string; run_id: string | null;
 state: string; reason: string; request_id: string; actor: string; head_commit: string; evidence: string; automatic: number };
export class CrewActions {
 constructor(private sql: SqlStorage) {}
 private response(row: ActionRow, status = 200): Response {
  return json({ actionId: row.id, runId: row.run_id, state: row.state, reason: row.reason }, status);
 }
 request(actor: string, body: Record<string, unknown>, members: CrewMember[], policy: OrchestrationPolicy, stopped: boolean, now: number, automatic = false): Response {
  fields(body, ['findingId', 'eventId', 'kind', 'requestId']);
  const findingId = string(body, 'findingId', 64), eventId = string(body, 'eventId', 64), kind = string(body, 'kind', 32), requestId = string(body, 'requestId', 128);
  if (!['fix', 'regression_test'].includes(kind)) fail(400, 'invalid_field', 'Choose fix or regression_test');
  const prior = this.sql.exec<ActionRow>('SELECT * FROM crew_actions WHERE request_id=?', requestId).toArray()[0];
  if (prior && (prior.finding_id !== findingId || prior.event_id !== eventId || prior.kind !== kind)) fail(409, 'request_conflict', 'This request ID already identifies a different action');
  const event = new CrewEvents(this.sql).get(eventId);
  const duplicate = prior ?? this.sql.exec<ActionRow>('SELECT * FROM crew_actions WHERE finding_id=? AND head_commit=? AND kind=?', findingId, event.head_commit, kind).toArray()[0];
  if (duplicate?.run_id) return this.response(duplicate);
  if (stopped) fail(409, 'stopped', 'Stop all crew is enabled');
  if (!policy.enabled) fail(409, 'orchestration_disabled', 'Enable check-in scheduling before requesting actions');
  const config = projectAutomation(policy, event.project_id);
  if (config.mode === 'report_only' || (automatic && config.mode !== 'automatic_fix')) fail(409, 'report_only', 'This project does not allow this action in its current automation mode');
  const target = kind === 'fix' ? config.fixerCrewId : config.testCrewId;
  const member = members.find(m => m.id === target);
  if (!member?.enabled) fail(409, 'target_disabled', 'Select an enabled target crew member in this project’s automation settings');
  if (member.projectIds[0] !== event.project_id || member.permissionMode !== 'acceptEdits' || member.orchestration?.mode !== 'write' || !member.orchestration.writeScopes.length)
   fail(409, 'invalid_target', 'The target must be a scoped writer whose primary project matches this finding');
  const role = this.sql.exec<{ role: string }>('SELECT role FROM members WHERE user_id=?', actor).toArray()[0]?.role;
  if (!role || !['owner', 'admin', 'operator'].includes(role)) fail(403, 'forbidden', 'An active workspace operator must own this action');
  const finding = this.sql.exec<{ project_id: string; disposition: string }>('SELECT project_id,disposition FROM crew_findings WHERE id=?', findingId).toArray()[0];
  if (!finding || finding.project_id !== event.project_id) fail(404, 'not_found', 'Finding not found in this project');
  if (['resolved', 'dismissed'].includes(finding.disposition)) fail(409, 'finding_closed', 'This finding is already resolved or dismissed');
  const occurrence = this.sql.exec<{ value: string; run_id: string }>('SELECT value,run_id FROM crew_finding_occurrences WHERE finding_id=? AND event_id=? AND head_commit=? ORDER BY created_at DESC,rowid DESC LIMIT 1', findingId, event.id, event.head_commit).toArray()[0];
  if (!occurrence?.value) fail(409, 'stale_finding', 'No finding evidence matches this event’s exact commit');
  if (!event.metadata || !JSON.parse(event.metadata).complete || !JSON.parse(event.metadata).ancestor || !['ready', 'evaluated', 'completed'].includes(event.state))
   fail(409, 'metadata_incomplete', 'The check-in needs complete, verified change metadata');
  const orchestration = new CrewOrchestration(this.sql);
  const eligibility = orchestration.actionEligibility(event, member, policy);
  if (eligibility.status !== 'eligible') fail(409, 'ineligible_target', `Target filters do not match: ${eligibility.reason}`);
  if (this.sql.exec('SELECT 1 FROM crew_runs WHERE event_id=? AND crew_id=?', event.id, member.id).toArray().length)
   fail(409, 'target_already_used', 'This target already has a run for this check-in; choose a different target or submit a new reviewed commit');
  const attempts = this.sql.exec<{ n: number }>('SELECT COUNT(*) n FROM crew_actions WHERE event_id=? AND run_id IS NOT NULL', event.id).one().n;
  if (attempts >= config.maxFixAttempts) fail(429, 'action_attempts', 'This check-in has reached its action attempt limit');
  const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM crew_runs WHERE event_id=? AND state NOT IN ('skipped','stopped')", event.id).one().n;
  if (count >= policy.maxRuns) fail(429, 'event_run_limit', 'This check-in has reached its total run limit');
  const depth = (orchestration.snapshot(occurrence.run_id)?.depth ?? 0) + 1;
  if (depth > policy.maxDepth) fail(429, 'depth_limit', 'This action would exceed the review depth limit');
  const runId = orchestration.enqueue(event, member, now, depth, occurrence.run_id);
  const id = duplicate?.id ?? crypto.randomUUID();
  const trigger = { kind: 'checkin', eventId, actionId: id };
  this.sql.exec('UPDATE crew_runs SET trigger=? WHERE id=?', JSON.stringify(trigger), runId);
  this.sql.exec(`INSERT INTO crew_actions(id,finding_id,event_id,kind,target_crew_id,run_id,state,reason,request_id,actor,head_commit,created_at,evidence,automatic)
   VALUES(?,?,?,?,?,?,'queued','Queued through crew admission',?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,state=excluded.state,
   reason=excluded.reason,request_id=excluded.request_id,actor=excluded.actor,evidence=excluded.evidence,automatic=excluded.automatic,
   target_crew_id=excluded.target_crew_id,event_id=excluded.event_id,head_commit=excluded.head_commit,kind=excluded.kind,created_at=excluded.created_at`,
   id, findingId, eventId, kind, member.id, runId, requestId, actor, event.head_commit, now, occurrence.value, automatic ? 1 : 0);
  this.sql.exec('UPDATE crew_findings SET disposition=?,updated_at=? WHERE id=?', 'fixer_requested', now, findingId);
  this.sql.exec('INSERT INTO crew_finding_history(finding_id,actor,disposition,created_at) VALUES(?,?,?,?)', findingId, actor, 'fixer_requested', now);
  return this.response(this.sql.exec<ActionRow>('SELECT * FROM crew_actions WHERE id=?', id).one(), 201);
 }
 refusal(runId: string, policy: OrchestrationPolicy): string | null {
  const row = this.sql.exec<ActionRow>('SELECT * FROM crew_actions WHERE run_id=?', runId).toArray()[0];
  if (!row) return null;
  const event = new CrewEvents(this.sql).get(row.event_id), config = projectAutomation(policy, event.project_id);
  if (config.mode === 'report_only' || (row.automatic && config.mode !== 'automatic_fix')) return 'project automation no longer allows this action';
  if ((row.kind === 'fix' ? config.fixerCrewId : config.testCrewId) !== row.target_crew_id) return 'project action target changed';
  // Already claimed work consumed its attempt; let its push finish. Reserve the remaining
  // slots for the earliest queued actions, even if settings lowered the cap since enqueue.
  const attempts = this.sql.exec<{ id: string; consumed: number }>(`SELECT a.id,
   EXISTS(SELECT 1 FROM crew_unit_ledger l WHERE l.run_id=a.run_id AND l.state='consumed') AS consumed
   FROM crew_actions a WHERE a.event_id=? AND a.run_id IS NOT NULL
   ORDER BY consumed DESC,a.created_at,a.rowid`, row.event_id).toArray();
  const index = attempts.findIndex(a => a.id === row.id);
  if (index >= config.maxFixAttempts && !attempts[index].consumed) return 'project action attempt limit lowered';
  const role = this.sql.exec<{ role: string }>('SELECT role FROM members WHERE user_id=?', row.actor).toArray()[0]?.role;
  if (!role || !['owner', 'admin', 'operator'].includes(role)) return 'action requester no longer manages crew';
  return null;
 }
 // One automatic attempt per finding/commit. A refused attempt is visible, and can be retried
 // deliberately through the human action after correcting its policy. Alarms cannot spin on it.
 automatic(members: CrewMember[], policy: OrchestrationPolicy, stopped: boolean, now: number): void {
  if (stopped || !policy.enabled) return;
  const projectIds = Object.entries(policy.projectRules ?? {}).filter(([, rule]) => rule.automation?.mode === 'automatic_fix').map(([id]) => id);
  if (!projectIds.length) return;
  const rows = this.sql.exec<{ finding_id: string; event_id: string; project_id: string; head_commit: string; value: string }>(`SELECT o.finding_id,o.event_id,f.project_id,o.head_commit,o.value
   FROM crew_finding_occurrences o JOIN crew_findings f ON f.id=o.finding_id JOIN crew_checkins e ON e.id=o.event_id
   WHERE f.disposition NOT IN ('resolved','dismissed','no_action') AND e.state IN ('ready','evaluated','completed') AND o.head_commit=e.head_commit
   AND f.project_id IN (${projectIds.map(() => '?').join(',')})
   AND NOT EXISTS(SELECT 1 FROM crew_actions a WHERE a.finding_id=o.finding_id AND a.head_commit=o.head_commit AND a.kind='fix')
   ORDER BY o.created_at DESC LIMIT 50`, ...projectIds).toArray();
  for (const row of rows) {
   const config = projectAutomation(policy, row.project_id);
   if (config.mode !== 'automatic_fix') continue;
   const target = members.find(m => m.id === config.fixerCrewId), actor = target?.createdBy ?? '';
   const requestId = `auto:${row.finding_id}:${row.head_commit}`;
   try { this.request(actor, { findingId: row.finding_id, eventId: row.event_id, kind: 'fix', requestId }, members, policy, stopped, now, true); }
   catch (error) {
    if (!(error instanceof HttpError)) throw error;
    this.sql.exec(`INSERT OR IGNORE INTO crew_actions(id,finding_id,event_id,kind,target_crew_id,run_id,state,reason,request_id,actor,head_commit,created_at,evidence,automatic)
     VALUES(?,?,?,'fix',?,NULL,'blocked',?,?,?,?,?,?,1)`, crypto.randomUUID(), row.finding_id, row.event_id, config.fixerCrewId ?? '', error.message, requestId, actor, row.head_commit, now, row.value);
   }
  }
 }
}
