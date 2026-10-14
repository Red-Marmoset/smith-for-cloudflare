import { fail, fields, json, object, randomToken, string, HttpError } from './http';
import { aiFeatures, aiMachines, type AiFeature, type AiNode } from './ai';
import { validateCrewReport, type CrewRunBrain, type CrewRunTool, type CrewClaimMaterial, type CrewMode, type CrewPushClaimMaterial, type CrewReport } from './crew-model';
import type { Project } from './projects';
import { isRepoProject, offersProduct, pipelineBriefing, type RepoProject } from './repo-projects';
import type { SetupClaim } from './setup';
import { SMITH_JSON_PRIMER } from './smith-json-primer';

// AI chat sessions. A person's message becomes a "turn" that their own machine claims, runs with
// its own unmodified coding CLI, and streams back as events. Everything here is private to the
// session's owner: admins cannot read another member's sessions. A crew run is a session too (kind
// 'crew'): the Crew creates it, any workspace member may watch it, and it never appears among chats.
export const SESSION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_sessions (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, owner_user_id TEXT NOT NULL, node_id TEXT NOT NULL,
    project_id TEXT NOT NULL, tool TEXT NOT NULL, brain TEXT NOT NULL, model TEXT, repo_url TEXT NOT NULL, base_commit TEXT NOT NULL,
    branch TEXT NOT NULL, cli_session_id TEXT, title TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS ai_sessions_owner ON ai_sessions(owner_user_id, updated_at);
  CREATE TABLE IF NOT EXISTS ai_turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, request_id TEXT NOT NULL, prompt TEXT NOT NULL,
    permission_mode TEXT NOT NULL, state TEXT NOT NULL, lease_token TEXT, lease_expires_at INTEGER, stop_requested INTEGER NOT NULL DEFAULT 0,
    result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(session_id, seq), UNIQUE(session_id, request_id));
  CREATE UNIQUE INDEX IF NOT EXISTS ai_one_active_turn ON ai_turns(session_id) WHERE state IN ('queued', 'running');
  CREATE TABLE IF NOT EXISTS ai_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, turn_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
    bytes INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(session_id, seq));
  CREATE TABLE IF NOT EXISTS ai_approvals (session_id TEXT NOT NULL, turn_id TEXT NOT NULL, id TEXT NOT NULL, tool TEXT NOT NULL, behavior TEXT, message TEXT,
    automatic INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, answered_at INTEGER, PRIMARY KEY(turn_id, id));
  CREATE INDEX IF NOT EXISTS ai_approvals_session ON ai_approvals(session_id, created_at);
`;

const LEASE_MS = 90000;
// Each CLI's own permission choices, in its own words; the first is the default. In Claude Code's
// 'default' mode it asks before acting, and those questions are answered in the dashboard.
const TOOL_MODES: Record<string, readonly string[]> = {
  'claude-code': ['acceptEdits', 'default', 'plan', 'bypassPermissions'],
  // `codex exec --sandbox <mode>`, or 'untrusted': Codex's app server asks before acting (approvals in the dashboard).
  codex: ['workspace-write', 'untrusted', 'read-only', 'danger-full-access'],
};
const TOOL_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
// A chat on another member's machine (with its shared Ollama models) may only edit files in its own
// copy of the project, or only read it: no commands outside Codex's sandbox, no questions answered by
// the guest, no full access to someone else's computer.
const GUEST_MODES: Record<string, readonly string[]> = { 'claude-code': ['acceptEdits', 'plan'], codex: ['workspace-write', 'read-only'] };
// The next turn a machine may run: its owner's chats, guests' Ollama chats while the owner shares models, and
// crew runs promoted onto it (whoever added the member). Chats go first, so a person never waits behind
// unattended work. Both ai-claim and the pre-transaction token mint run this one query (params: node id,
// node owner) after `SELECT ... FROM ai_turns t JOIN ai_sessions s ON s.id = t.session_id`, so they agree.
export const CLAIMABLE_TURN = `WHERE s.node_id = ? AND t.state = 'queued' AND (s.kind = 'crew' OR s.owner_user_id = ?
  OR (s.brain = 'ollama' AND EXISTS (SELECT 1 FROM nodes n WHERE n.id = s.node_id AND n.share_local_models = 1))) ORDER BY s.kind = 'crew', t.created_at, t.id LIMIT 1`;
const SHA = /^[a-f0-9]{40}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// What workspace members (not owners) may do with a crew run's session: watch it, and (operators) stop it.
const MEMBER_ACTIONS = ['ai-session', 'ai-session-events', 'ai-session-stop'];
// Each session's machine reports its CLI's own events under that CLI's kind, plus Smith's status and stderr lines.
const TOOL_EVENT_KIND: Record<string, string> = { 'claude-code': 'claude', codex: 'codex' };
const EVENT_KINDS = ['claude', 'codex', 'status', 'stderr', 'approval'] as const;
const APPROVAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/; // Claude Code tool names, including mcp__server__tool
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
type TurnState = 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'lost';
export type SessionRow = { id: string; request_id: string; owner_user_id: string; node_id: string; project_id: string; tool: string; brain: string; model: string | null;
  repo_url: string; base_commit: string; branch: string; cli_session_id: string | null; title: string; closed: number; created_at: number; updated_at: number;
  archived_at: number | null; pinned: number; allowed_tools: string; local_only: number;
  kind: 'chat' | 'crew'; crew_id: string | null; trigger: string | null; base_commit_actual: string | null; cost_usd: number | null };
type ApprovalRow = { session_id: string; turn_id: string; id: string; tool: string; behavior: 'allow' | 'deny' | null; message: string | null; automatic: number;
  created_at: number; answered_at: number | null };
// A turn is a message to the CLI, or (kind 'push') pushing the chat's branch, optionally then building it.
export type TurnRow = { id: string; session_id: string; seq: number; request_id: string; prompt: string; permission_mode: string; state: TurnState; lease_token: string | null;
  lease_expires_at: number | null; stop_requested: number; result: string | null; created_at: number; updated_at: number; kind: 'message' | 'push'; product: string | null; job_id: string | null;
  use_api_key: number };
type NodeRow = AiNode & { purpose: string };
// A workspace member (kind 'member') reaches only crew runs' sessions, through the crew's own actions.
export type SessionPrincipal = { kind: 'human'; userId: string } | { kind: 'member'; userId: string } | { kind: 'node'; node: NodeRow };
type Person = Exclude<SessionPrincipal, { kind: 'node' }>;
// A finished turn as its machine reported it. Crew message turns add where the run started, what it cost, the
// files it changed (with how many there were: an agent reports that only after the CLI ran, null otherwise, and whether it had
// to cut the list), its report (null when absent or unusable) and the projects it created (the new-project/<id> directories it
// left; their push turn reports each with the commit it pushed); chats leave them empty.
export interface FinishInput {
  status: 'completed' | 'failed' | 'stopped'; message: string; commit: string | null;
  baseCommit: string | null; costUsd: number | null; files: string[]; filesTotal: number | null; filesTruncated: boolean; report: CrewReport | null; createdProjects: CreatedProject[];
}
export type CreatedProject = { id: string; commit?: string };
// A finish's createdProjects: at most 5, each a project ID with (required in a push turn's finish) the commit it pushed.
function createdProjects(value: unknown, needCommit: boolean): CreatedProject[] {
  const invalid = (what: string): never => fail(400, 'invalid_result', `Invalid crew result: ${what}`);
  if (!Array.isArray(value) || value.length > 5) invalid('createdProjects must list at most 5 projects');
  return (value as unknown[]).map(raw => {
    const p = object(raw); fields(p, ['id', 'commit']);
    if (typeof p.id !== 'string' || !PROJECT_ID.test(p.id) || (p.commit !== undefined || needCommit) && (typeof p.commit !== 'string' || !SHA.test(p.commit)))
      invalid(needCommit ? 'createdProjects entries need a project ID and the commit pushed' : 'createdProjects entries need a project ID');
    return typeof p.commit === 'string' ? { id: p.id as string, commit: p.commit } : { id: p.id as string };
  });
}
export interface CrewSessionInput {
  crewId: string; ownerUserId: string; nodeId: string; projectId: string; tool: CrewRunTool; brain: CrewRunBrain; model: string | null; repoUrl: string; baseCommit: string;
  branch: string; title: string; permissionMode: CrewMode; prompt: string; trigger: string /* JSON */;
}
// What the workspace supplies around a session action: a Cloudflare Artifacts token minted before the
// transaction for the turn a claim hands out (read for messages, write for pushes) or for a Verify
// build, the caller's permission to start builds, a way to queue a build pinned to a commit, and the
// Crew's part in a crew run's turns: why a queued turn must not start after all, the material its machine
// gets at claim (with the run token and related-project tokens minted before the transaction) and the
// bookkeeping when it finishes. All run inside the claim/finish transaction.
export interface SessionHooks {
  repoToken?: { turnId: string; token?: string };
  canBuild?: boolean;
  // A member's role, for what a chat's own machine may do on the owner's behalf once a reply is over (pushing).
  roleOf?: (userId: string) => string;
  enqueueVerify?: (projectId: string, product: string, branch: string, commit: string, requestId: string, readToken: string) => { id: string; number: number | null };
  crew?: { refusal(session: SessionRow, turn: TurnRow): string | null; claim(session: SessionRow, turn: TurnRow): Partial<CrewClaimMaterial> | CrewPushClaimMaterial;
    finish(session: SessionRow, turn: TurnRow, result: FinishInput, now: number): void;
    // A crew run's push turn finished (the chat shape: status, message, commit; plus the created projects it pushed).
    pushed?(session: SessionRow, turn: TurnRow, result: Pick<FinishInput, 'status' | 'message' | 'commit'> & { createdProjects?: CreatedProject[] }, now: number): void;
    // A crew turn (message or push) ended or was stopped while queued: its slot may go to a waiting run.
    ended?(now: number): void };
  // A machine's chat claim also hands it its next install / sign-in task (see setup.ts).
  claimSetup?: () => SetupClaim | null;
}
function crewHooks(hooks: SessionHooks): NonNullable<SessionHooks['crew']> {
  return hooks.crew ?? fail(503, 'crew_unavailable', 'Crew runs are not available here');
}
// A finish is one JSON mutation, so it must fit the 64 KiB body cap (readBody) with its message (4 KiB) and created projects
// besides: the agent keeps its finish near 48 KiB, and these two limits are what it may send at most (32 + 24 + 4 KiB, plus
// about 1 KiB of the rest). A finish over either would only meet a 413 and lose the run, so it is refused here, clearly.
const MAX_FINISH_REPORT_BYTES = 32 * 1024, MAX_FINISH_FILES_BYTES = 24 * 1024;
const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
// The fields a crew message turn reports beyond a chat's, checked and in a fixed order so a replayed finish compares
// equal. The report is model output: one the server cannot use becomes no report (the reason goes in the transcript),
// because the run's work and cost still count and refusing the finish would lose them. Size is the exception: the agent
// keeps its finish within the limits above itself, so one over them is refused.
function crewResult(input: Record<string, unknown>): { fields: Omit<FinishInput, 'status' | 'message' | 'commit'>; reportError: string | null } {
  const invalid = (what: string): never => fail(400, 'invalid_result', `Invalid crew result: ${what}`);
  const baseCommit = input.baseCommit ?? null, costUsd = input.costUsd ?? null, files = input.files ?? [], filesTotal = input.filesTotal ?? null;
  if (baseCommit !== null && (typeof baseCommit !== 'string' || !SHA.test(baseCommit))) invalid('baseCommit must be a full commit SHA');
  if (costUsd !== null && (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0)) invalid('costUsd must be a non-negative number');
  if (!Array.isArray(files) || files.length > 500 || files.some(f => typeof f !== 'string' || !f || f.length > 512 || /[\x00-\x1f]/.test(f)) || jsonBytes(files) > MAX_FINISH_FILES_BYTES) invalid('files must list at most 500 paths, in at most 24 KiB');
  // The agent lists the files it could (guarded paths first) and says how many there were: a total beyond the list is a cut list.
  if (filesTotal !== null && (!Number.isSafeInteger(filesTotal) || (filesTotal as number) < (files as string[]).length)) invalid('filesTotal must be a whole number, at least the files listed');
  if (input.filesTruncated !== undefined && typeof input.filesTruncated !== 'boolean') invalid('filesTruncated must be true or false');
  const filesTruncated = input.filesTruncated === true || (filesTotal !== null && (filesTotal as number) > (files as string[]).length);
  const created = createdProjects(input.createdProjects ?? [], false);
  let report: CrewReport | null = null, reportError: string | null = null;
  if (input.report != null) {
    if (jsonBytes(input.report) > MAX_FINISH_REPORT_BYTES) invalid('report must be at most 32 KiB');
    try { report = validateCrewReport(input.report); }
    catch (error) { if (!(error instanceof HttpError)) throw error; reportError = error.message; }
  }
  return { fields: { baseCommit: baseCommit as string | null, costUsd: costUsd as number | null, files: [...files as string[]], filesTotal: filesTotal as number | null, filesTruncated, report, createdProjects: created }, reportError };
}
const FEATURE_NAMES: Record<AiFeature, string> = { ask: 'Ask before each action', push: 'Push branch and Verify', ollama: 'Ollama models', 'codex-ask': 'Ask before each command for Codex', crew: 'Autonomous crew work',
  'crew-orchestration-v1': 'Pinned check-in reviews and scoped writers', setup: 'Installing and signing in from here', 'api-key-choice': 'Choosing between your login and the API key',
  'named-branches': 'Branch names from the chat title', 'crew-codex': 'Crew work with Codex', 'login-models': 'Choosing the Claude model' };
const BUILDERS = ['owner', 'admin', 'operator'];
// Pushing to Smith's copy of a project (Artifacts or Smith-hosted) needs the operator role; a GitHub push is the machine's own login.
function pushNeedsBuilder(repoUrl: string): boolean { return repoUrl.includes('.artifacts.cloudflare.net/') || repoUrl.includes('/git/'); }
// The chat's branch: smith/ai-<slug>-<8 hex>, the slug from the chat's title, when its machine understands such names
// (older agents accept smith/ai-<8 hex> only). The agent's HostedAiBranchValid and the hosted-git push ticket use the same shape.
export function chatBranch(id: string, title: string, named: boolean): string {
  const slug = named ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '') : '';
  return `smith/ai-${slug ? slug + '-' : ''}${id.slice(0, 8)}`;
}
// What the CLI is told about where it is, once per message turn (Claude Code: --append-system-prompt; Codex: ahead of the
// first message of its thread). Text only: it adds no permission, it just stops the CLI from pushing, deploying or asking
// where to hand its work in. It ends with how smith.json works (SMITH_JSON_PRIMER), so the CLI can work on the project's
// pipeline. Starts with a letter, so an agent can never read it as a flag; at most BRIEFING_MAX_BYTES, which the agent enforces.
export const BRIEFING_MAX_BYTES = 8192;
export function chatBriefing(session: Pick<SessionRow, 'project_id' | 'branch' | 'base_commit'>, project: Project | RepoProject | undefined): string {
  const name = project?.name ? `"${project.name}" (${session.project_id})` : session.project_id;
  const builds = project ? (isRepoProject(project) ? project.actions.map(a => a.id) : project.products.map(p => p.name)) : [];
  const from = project?.branch ? ` of its ${project.branch} branch` : '';
  const where = whereBriefing(name, session, from, builds, pipelineBriefing(project));
  const full = `${where}\n\n${SMITH_JSON_PRIMER}`;
  // The agent drops a briefing over its limit entirely; losing the primer is better than losing where the CLI is.
  return new TextEncoder().encode(full).length <= BRIEFING_MAX_BYTES ? full : where;
}
function whereBriefing(name: string, session: Pick<SessionRow, 'branch' | 'base_commit'>, from: string, builds: string[], pipeline: string): string {
  return [`You are working in a Smith chat on the project ${name}. The current directory is a private copy of its repository on the branch ${session.branch}, started from commit ${session.base_commit.slice(0, 12)}${from}.`,
    'Smith commits the files you change after each reply and pushes this branch itself. Do not commit, push, rebase, create branches or tags, or deploy or publish anything; a person reviews and merges the branch in Smith.',
    builds.length ? `The person can have Smith build this branch on a build machine (${builds.slice(0, 8).join(', ')}) and link the build from the chat; you do not need to build or release for them.` : '',
    pipeline,
    'End each reply with a short note of what you changed and anything the reviewer should check.'].filter(Boolean).join(' ');
}
function requireFeature(node: NodeRow, feature: AiFeature): void {
  if (!aiFeatures(node).includes(feature)) fail(409, 'agent_update_needed', `${FEATURE_NAMES[feature]} needs a newer Smith agent on ${node.hostname || 'that computer'}. Update it there (SmithAgent.bat update), then try again.`);
}

function prompt(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > 16000 || value.includes('\0')) fail(400, 'invalid_prompt', 'Write a message of up to 16,000 characters');
  return value;
}
// Whether this turn may use the API key set on the machine instead of the owner's own CLI login (the
// agent otherwise removes the key, so the subscription login and its connectors apply). Only with your
// own login on your own machine: an Ollama brain replaces those variables anyway.
function useApiKey(body: Record<string, unknown>, brain: string, guest: boolean): boolean {
  if (body.useApiKey === undefined || body.useApiKey === false) return false;
  if (body.useApiKey !== true) fail(400, 'invalid_field', 'useApiKey must be a boolean');
  if (guest) fail(403, 'guest_api_key', 'Only the computer’s owner can use the API key set on it');
  if (brain !== 'own-login') fail(400, 'invalid_field', 'A model on a machine does not use an API key');
  return true;
}
function permissionMode(body: Record<string, unknown>, tool: string, guest = false): string {
  const modes = TOOL_MODES[tool];
  const mode = body.permissionMode ?? modes[0];
  if (typeof mode !== 'string' || !modes.includes(mode)) fail(400, 'invalid_field', `Unknown permission mode for ${TOOL_NAMES[tool]}`);
  if (guest && !GUEST_MODES[tool].includes(mode)) fail(403, 'guest_mode', 'On someone else’s computer a chat may only edit files in its own copy of the project, or only read it');
  return mode;
}

export class Sessions {
  constructor(private sql: SqlStorage) {}

  expire(now: number): void {
    this.sql.exec("UPDATE ai_turns SET state = 'lost', updated_at = ? WHERE state = 'running' AND lease_expires_at <= ?", now, now);
    // A crew run lost with its machine takes its run token with it (the turns just marked carry this updated_at).
    this.sql.exec("UPDATE access_tokens SET revoked_at = ? WHERE session_id IN (SELECT session_id FROM ai_turns WHERE state = 'lost' AND updated_at = ?)", now, now);
  }
  nextLeaseExpiry(): number | null {
    return this.sql.exec<{ due: number | null }>("SELECT MIN(lease_expires_at) AS due FROM ai_turns WHERE state = 'running'").one().due;
  }

  execute(principal: SessionPrincipal, action: string, body: Record<string, unknown>, now: number, hooks: SessionHooks = {}): Response {
    if (principal.kind === 'node') return this.node(principal.node, action, body, now, hooks);
    if (principal.kind === 'member' && !MEMBER_ACTIONS.includes(action)) fail(404, 'not_found', 'Route not found');
    const userId = principal.userId;
    if (action === 'ai-session-create') return this.create(userId, body, now);
    if (action === 'ai-sessions') {
      // Your chats, pinned first then most recent; or your archived chats. A search matches titles,
      // your messages and the assistant's replies.
      fields(body, ['archived', 'q', 'limit']);
      if (body.archived !== undefined && typeof body.archived !== 'boolean') fail(400, 'invalid_field', 'archived must be a boolean');
      const q = body.q === undefined || body.q === '' ? null : string(body, 'q', 100);
      const limit = body.limit === undefined ? 100 : Number(body.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail(400, 'invalid_field', 'limit must be 1-200');
      const like = q === null ? null : `%${q.replace(/[\\%_]/g, c => '\\' + c)}%`;
      const sessions = this.sql.exec<SessionRow>(`SELECT * FROM ai_sessions s WHERE owner_user_id = ? AND kind = 'chat' AND (archived_at IS NOT NULL) = ?
        AND (? IS NULL OR title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM ai_turns t WHERE t.session_id = s.id AND t.prompt LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM ai_events e WHERE e.session_id = s.id AND e.kind IN ('claude', 'codex') AND e.data LIKE ? ESCAPE '\\'))
        ORDER BY pinned DESC, updated_at DESC LIMIT ?`, userId, body.archived === true ? 1 : 0, like, like, like, like, limit).toArray();
      return json({ sessions: sessions.map(s => this.publicSession(s)) });
    }
    const session = this.owned(principal, string(body, 'sessionId', 64));
    if (action === 'ai-session') return json({ ...this.publicSession(session), turns: this.turns(session.id), approvals: this.approvals(session.id) });
    if (action === 'ai-session-events') {
      const after = body.after ?? -1;
      if (!Number.isSafeInteger(after) || Number(after) < -1) fail(400, 'invalid_cursor', 'Invalid event cursor');
      const events = this.sql.exec<{ seq: number; turn_id: string; kind: string; data: string; at: number }>('SELECT seq, turn_id, kind, data, at FROM ai_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 200', session.id, Number(after)).toArray();
      return json({ events: events.map(e => ({ seq: e.seq, turnId: e.turn_id, kind: e.kind, data: JSON.parse(e.data) as unknown, at: e.at })), nextSeq: events.length ? events[events.length - 1].seq : Number(after) });
    }
    if (action === 'ai-session-message') {
      fields(body, ['sessionId', 'requestId', 'text', 'permissionMode', 'useApiKey']);
      const requestId = string(body, 'requestId', 64);
      const existing = this.sql.exec<TurnRow>('SELECT * FROM ai_turns WHERE session_id = ? AND request_id = ?', session.id, requestId).toArray()[0];
      if (existing) return json(this.publicTurn(existing), 201);
      if (this.active(session.id)) fail(409, 'turn_active', 'Wait for the current reply, or stop it, before sending another message');
      const machine = this.checkMachine(userId, session, now);
      const mode = permissionMode(body, session.tool, machine.owner_user_id !== userId);
      if (mode === 'default') requireFeature(machine, 'ask');
      if (mode === 'untrusted') requireFeature(machine, 'codex-ask');
      const apiKey = useApiKey(body, session.brain, machine.owner_user_id !== userId);
      const turn = this.addTurn(session.id, requestId, prompt(body, 'text'), mode, now, 'message', null, apiKey);
      // Continuing an archived chat brings it back into your chat list.
      this.sql.exec('UPDATE ai_sessions SET archived_at = NULL WHERE id = ?', session.id);
      return json(this.publicTurn(turn), 201);
    }
    if (action === 'ai-session-push') {
      // Push the chat's own branch from its machine with that machine's Git login (or, for a project
      // hosted on Cloudflare Artifacts, a short-lived token), never forced and never to another
      // branch. With a product, a normal Smith build of the pushed commit follows ("Verify").
      fields(body, ['sessionId', 'requestId', 'product']);
      const requestId = string(body, 'requestId', 64);
      const existing = this.sql.exec<TurnRow>('SELECT * FROM ai_turns WHERE session_id = ? AND request_id = ?', session.id, requestId).toArray()[0];
      if (existing) return json(this.publicTurn(existing), 201);
      if (this.active(session.id)) fail(409, 'turn_active', 'Wait for the current reply, or stop it, before pushing');
      const host = this.sql.exec<{ owner_user_id: string | null }>('SELECT owner_user_id FROM nodes WHERE id = ?', session.node_id).toArray()[0];
      if (host?.owner_user_id !== userId) fail(403, 'guest_push', 'Pushing uses the computer’s own Git login, so it is only available for chats on your own computer');
      const product = body.product === undefined || body.product === null ? null : string(body, 'product', 64);
      if (product !== null || pushNeedsBuilder(session.repo_url)) {
        if (!hooks.canBuild) fail(403, 'forbidden', product !== null ? 'Starting builds needs the operator role in this workspace' : 'Pushing to this project needs the operator role in this workspace');
      }
      if (product !== null) {
        const projectRow = this.sql.exec<{ definition: string }>('SELECT definition FROM projects WHERE id = ?', session.project_id).toArray()[0];
        const definition = projectRow ? JSON.parse(projectRow.definition) as Project | RepoProject : undefined;
        // A project added from a Git URL offers smith.json build actions instead of products.
        if (!offersProduct(definition, product)) fail(400, 'invalid_product', 'This project has no such product');
      }
      if (!this.sql.exec("SELECT 1 FROM ai_turns WHERE session_id = ? AND json_extract(result, '$.commit') IS NOT NULL LIMIT 1", session.id).toArray().length)
        fail(409, 'nothing_to_push', 'Nothing to push yet: this chat has not changed any files');
      requireFeature(this.checkMachine(userId, session, now), 'push');
      const text = `Push branch ${session.branch}${product ? ` and build ${product}` : ''}`;
      const turn = this.addTurn(session.id, requestId, text, '', now, 'push', product);
      return json(this.publicTurn(turn), 201);
    }
    if (action === 'ai-session-approve') {
      // Your answer to a question Claude Code asked while running in ask mode. "always" also answers
      // that tool's later questions in this chat, as Claude Code's "don't ask again" does.
      fields(body, ['sessionId', 'approvalId', 'behavior', 'message', 'always']);
      const approvalId = string(body, 'approvalId', 64);
      const approval = this.sql.exec<ApprovalRow>('SELECT a.* FROM ai_approvals a JOIN ai_turns t ON t.id = a.turn_id WHERE a.session_id = ? AND a.id = ? AND t.state = ? ORDER BY a.created_at DESC LIMIT 1',
        session.id, approvalId, 'running').toArray()[0];
      if (!approval) fail(409, 'not_waiting', 'Claude Code is no longer waiting for this answer');
      if (body.behavior !== 'allow' && body.behavior !== 'deny') fail(400, 'invalid_field', 'Answer allow or deny');
      const message = body.message === undefined || body.message === '' ? null : string(body, 'message', 2000);
      if (body.always !== undefined && typeof body.always !== 'boolean') fail(400, 'invalid_field', 'always must be a boolean');
      if (approval.behavior !== null) {
        if (approval.behavior !== body.behavior) fail(409, 'already_answered', 'This question was already answered');
        return json({ approvals: this.approvals(session.id) });
      }
      this.sql.exec('UPDATE ai_approvals SET behavior = ?, message = ?, answered_at = ? WHERE turn_id = ? AND id = ?', body.behavior, message, now, approval.turn_id, approval.id);
      if (body.always === true && body.behavior === 'allow') {
        const allowed = new Set(JSON.parse(session.allowed_tools) as string[]); allowed.add(approval.tool);
        this.sql.exec('UPDATE ai_sessions SET allowed_tools = ? WHERE id = ?', JSON.stringify([...allowed].slice(0, 100)), session.id);
      }
      return json({ approvals: this.approvals(session.id) });
    }
    if (action === 'ai-session-stop') {
      const turn = this.active(session.id);
      if (turn?.state === 'queued') this.sql.exec("UPDATE ai_turns SET state = 'stopped', updated_at = ? WHERE id = ?", now, turn.id);
      else if (turn) this.sql.exec('UPDATE ai_turns SET stop_requested = 1, updated_at = ? WHERE id = ?', now, turn.id);
      if (turn?.state === 'queued' && session.kind === 'crew') hooks.crew?.ended?.(now);
      return json({ ...this.publicSession(this.owned(principal, session.id)), turns: this.turns(session.id) });
    }
    if (action === 'ai-session-close' || action === 'ai-session-update') {
      // Rename, pin or archive. ("close" is the older name for archive.) None of these reorder the list.
      if (action === 'ai-session-close') body = { sessionId: session.id, archived: true };
      fields(body, ['sessionId', 'title', 'archived', 'pinned', 'allowedTools', 'localOnly']);
      if (body.title !== undefined) {
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title || title.length > 120 || /[\x00-\x1f]/.test(title)) fail(400, 'invalid_field', 'Give the chat a name of up to 120 characters');
        this.sql.exec('UPDATE ai_sessions SET title = ? WHERE id = ?', title, session.id);
      }
      if (body.archived !== undefined) {
        if (typeof body.archived !== 'boolean') fail(400, 'invalid_field', 'archived must be a boolean');
        this.sql.exec('UPDATE ai_sessions SET archived_at = ? WHERE id = ?', body.archived ? (session.archived_at ?? now) : null, session.id);
      }
      if (body.allowedTools !== undefined) {
        // Forget (some of) the tools Claude Code was told it may always use in this chat.
        if (!Array.isArray(body.allowedTools) || body.allowedTools.length > 100 || body.allowedTools.some(t => typeof t !== 'string' || !TOOL_NAME.test(t))) fail(400, 'invalid_field', 'allowedTools must be a list of tool names');
        this.sql.exec('UPDATE ai_sessions SET allowed_tools = ? WHERE id = ?', JSON.stringify([...new Set(body.allowedTools as string[])]), session.id);
      }
      if (body.pinned !== undefined) {
        if (typeof body.pinned !== 'boolean') fail(400, 'invalid_field', 'pinned must be a boolean');
        this.sql.exec('UPDATE ai_sessions SET pinned = ? WHERE id = ?', body.pinned ? 1 : 0, session.id);
      }
      if (body.localOnly !== undefined) {
        // Keep this chat's branch on its computer: Smith stops pushing replies until the owner says otherwise (or pushes by hand).
        if (typeof body.localOnly !== 'boolean') fail(400, 'invalid_field', 'localOnly must be a boolean');
        this.sql.exec('UPDATE ai_sessions SET local_only = ? WHERE id = ?', body.localOnly ? 1 : 0, session.id);
      }
      return json(this.publicSession(this.owned(principal, session.id)));
    }
    if (action === 'ai-session-delete') {
      fields(body, ['sessionId']);
      if (this.active(session.id)) fail(409, 'turn_active', 'Stop the current reply before deleting the chat');
      this.sql.exec('DELETE FROM ai_approvals WHERE session_id = ?', session.id);
      this.sql.exec('DELETE FROM ai_events WHERE session_id = ?', session.id);
      this.sql.exec('DELETE FROM ai_turns WHERE session_id = ?', session.id);
      this.sql.exec('DELETE FROM ai_sessions WHERE id = ?', session.id);
      return json({ deleted: true });
    }
    fail(404, 'not_found', 'Route not found');
  }

  // The owner of a machine that shares its models sees who is chatting on it, and can stop them.
  guestChats(nodeId: string, ownerUserId: string): { sessionId: string; userId: string; tool: string; model: string | null; working: boolean; updatedAt: number }[] {
    return this.sql.exec<SessionRow>("SELECT s.* FROM ai_sessions s WHERE s.node_id = ? AND s.owner_user_id != ? AND s.kind = 'chat' AND EXISTS (SELECT 1 FROM ai_turns t WHERE t.session_id = s.id AND t.state IN ('queued', 'running')) ORDER BY s.updated_at DESC LIMIT 20", nodeId, ownerUserId).toArray()
      .map(s => ({ sessionId: s.id, userId: s.owner_user_id, tool: s.tool, model: s.model, working: true, updatedAt: s.updated_at }));
  }
  stopGuestChat(nodeId: string, sessionId: string, now: number): Response {
    const turn = this.sql.exec<TurnRow>("SELECT t.* FROM ai_turns t JOIN ai_sessions s ON s.id = t.session_id WHERE s.id = ? AND s.node_id = ? AND s.kind = 'chat' AND t.state IN ('queued', 'running')", sessionId, nodeId).toArray()[0];
    if (turn?.state === 'queued') this.sql.exec("UPDATE ai_turns SET state = 'stopped', updated_at = ? WHERE id = ?", now, turn.id);
    else if (turn) this.sql.exec('UPDATE ai_turns SET stop_requested = 1, updated_at = ? WHERE id = ?', now, turn.id);
    return json({ stopped: Boolean(turn) });
  }

  private create(userId: string, body: Record<string, unknown>, now: number): Response {
    fields(body, ['requestId', 'nodeId', 'projectId', 'tool', 'brain', 'model', 'permissionMode', 'prompt', 'useApiKey']);
    const requestId = string(body, 'requestId', 64);
    const existing = this.sql.exec<SessionRow>('SELECT * FROM ai_sessions WHERE request_id = ?', requestId).toArray()[0];
    if (existing) {
      // Only your own chat replays; a crew run's request ID ('crew-<id>') never hands the run back as a chat.
      if (existing.owner_user_id !== userId || existing.kind !== 'chat') fail(409, 'conflicting_request', 'Request ID already used');
      return json({ ...this.publicSession(existing), turns: this.turns(existing.id) }, 201);
    }
    const tool = string(body, 'tool', 32), brain = string(body, 'brain', 32);
    const model = body.model === undefined || body.model === null ? null : string(body, 'model', 128);
    // Claude Code and Codex run with your own login on your own machine, or with an Ollama model on
    // your machine or on one whose owner shares its local models.
    if (!(tool in TOOL_MODES)) fail(400, 'invalid_field', 'Unknown tool');
    if (brain !== 'own-login' && !(brain === 'ollama' && model !== null)) fail(400, 'invalid_field', 'Choose your own login, or a model on a machine');
    const text = prompt(body, 'prompt');
    const projectRow = this.sql.exec<{ definition: string }>('SELECT definition FROM projects WHERE id = ?', string(body, 'projectId', 64)).toArray()[0];
    if (!projectRow) fail(400, 'unsupported_project', 'Project not found');
    const project = JSON.parse(projectRow.definition) as Project | RepoProject;
    // A chat starts from the commit Smith last saw; a Git URL project has none until it is read.
    if (!project.commit) fail(409, 'not_ready', "Smith has not read this project's smith.json yet; wait for its scan or use Rescan");
    const nodeId = string(body, 'nodeId', 64);
    const node = this.sql.exec<NodeRow>('SELECT * FROM nodes WHERE id = ? AND active = 1', nodeId).toArray()[0];
    const machine = node && aiMachines(userId, [node], now)[0];
    if (!machine?.options.some(o => o.tool === tool && o.brain === brain && o.model === model)) fail(403, 'machine_unavailable', 'That machine is not online with that tool for you');
    const mode = permissionMode(body, tool, !machine.ownedByYou);
    if (mode === 'default') requireFeature(node, 'ask');
    if (mode === 'untrusted') requireFeature(node, 'codex-ask');
    if (brain === 'ollama') requireFeature(node, 'ollama');
    const apiKey = useApiKey(body, brain, !machine.ownedByYou);
    // Etiquette: one working reply per person and tool at a time. Crew runs are not replies of yours (they
    // act for the workspace), and they have their own retention rather than the chat quota.
    const busy = this.sql.exec("SELECT t.id FROM ai_turns t JOIN ai_sessions s ON s.id = t.session_id WHERE s.owner_user_id = ? AND s.tool = ? AND s.kind = 'chat' AND t.state IN ('queued', 'running') LIMIT 1", userId, tool).toArray().length;
    if (busy) fail(429, 'session_busy', `Finish or stop your other ${TOOL_NAMES[tool]} reply first`);
    if (this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM ai_sessions WHERE kind = 'chat'").one().count >= 500) fail(429, 'quota', 'Experiment session quota reached');
    const id = crypto.randomUUID();
    const title = text.trim().split('\n')[0].slice(0, 80);
    this.sql.exec('INSERT INTO ai_sessions (id, request_id, owner_user_id, node_id, project_id, tool, brain, model, repo_url, base_commit, branch, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, requestId, userId, nodeId, project.id, tool, brain, model, project.repoUrl, project.commit, chatBranch(id, title, aiFeatures(node).includes('named-branches')), title, now, now);
    this.addTurn(id, requestId, text, mode, now, 'message', null, apiKey);
    return json({ ...this.publicSession(this.owned({ kind: 'human', userId }, id)), turns: this.turns(id) }, 201);
  }

  // A crew run that committed pushes its branch with a turn of its own: queued by Smith, so no person asks for it, and
  // with no product, since Verify is a person's choice in Review. Request IDs 'crew-push-<seq>' keep it replay-safe.
  addPushTurn(sessionId: string, now: number, product: null = null): void {
    const session = this.session(sessionId);
    const seq = (this.sql.exec<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM ai_turns WHERE session_id = ?', sessionId).one().seq ?? 0) + 1;
    this.addTurn(sessionId, `crew-push-${seq}`, `Push branch ${session.branch}`, '', now, 'push', product);
  }

  // A crew run: a session of kind 'crew' bound to the machine the Crew chose, with its one queued message turn. Its
  // owner is the person who added the member, for bookkeeping only. The tool and brain are what the run was resolved to (crew-model chooseCrewAi).
  createCrewSession(input: CrewSessionInput, now: number): string {
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO ai_sessions (id, request_id, owner_user_id, node_id, project_id, tool, brain, model, repo_url, base_commit, branch, title, kind, crew_id, trigger, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'crew', ?, ?, ?, ?)",
      id, 'crew-' + id, input.ownerUserId, input.nodeId, input.projectId, input.tool, input.brain, input.model, input.repoUrl, input.baseCommit, input.branch, input.title, input.crewId, input.trigger, now, now);
    this.addTurn(id, 'crew-' + id, input.prompt, input.permissionMode, now);
    return id;
  }

  private node(node: NodeRow, action: string, body: Record<string, unknown>, now: number, hooks: SessionHooks): Response {
    if (action === 'ai-claim') {
      fields(body, []);
      const setup = hooks.claimSetup?.() ?? null;
      // A machine runs one turn at a time; a lost response replays the same lease.
      let turn = this.sql.exec<TurnRow>("SELECT t.* FROM ai_turns t JOIN ai_sessions s ON s.id = t.session_id WHERE s.node_id = ? AND t.state = 'running' ORDER BY t.created_at LIMIT 1", node.id).toArray()[0];
      if (!turn) {
        turn = this.sql.exec<TurnRow>(`SELECT t.* FROM ai_turns t JOIN ai_sessions s ON s.id = t.session_id ${CLAIMABLE_TURN}`, node.id, node.owner_user_id ?? '').toArray()[0];
        if (!turn) return json({ turn: null, setup });
        // A crew turn that may no longer start (say, Stop all crew went on since it was queued) is stopped, not handed out.
        const queued = this.session(turn.session_id);
        const refusal = queued.kind === 'crew' ? crewHooks(hooks).refusal(queued, turn) : null;
        if (refusal) {
          this.sql.exec("UPDATE ai_turns SET state = 'stopped', updated_at = ? WHERE id = ?", now, turn.id);
          this.note(queued.id, turn.id, refusal, now);
          return json({ turn: null, setup });
        }
        this.sql.exec("UPDATE ai_turns SET state = 'running', lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?", randomToken(), now + LEASE_MS, now, turn.id);
        turn = this.turn(turn.id);
      }
      const session = this.session(turn.session_id);
      // A crew turn carries its run's material from the Crew; `kind` stays the turn's own (message or push).
      const crew = session.kind === 'crew' ? crewHooks(hooks).claim(session, turn) : null;
      const nextSeq = (this.sql.exec<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM ai_events WHERE session_id = ?', session.id).one().seq ?? -1) + 1;
      // A chat's message turn tells the CLI where it is (chatBriefing); push turns and crew runs (which have their own prompt) carry none.
      const briefing = !crew && turn.kind === 'message' ? { briefing: chatBriefing(session, this.project(session.project_id)) } : {};
      return json({ turn: { sessionId: session.id, turnId: turn.id, seq: turn.seq, leaseToken: turn.lease_token, leaseExpiresAt: turn.lease_expires_at, nextEventSeq: nextSeq,
        prompt: turn.prompt, tool: session.tool, brain: session.brain, model: session.model, permissionMode: turn.permission_mode, resume: session.cli_session_id, kind: turn.kind, ...briefing,
        // A guest's chat: the machine runs the CLI with an empty config of its own, never its owner's. A crew
        // run is not a guest: its isolation comes from the crew turn path itself. useApiKey is a chat's own
        // choice; a crew turn never sets it (its brain alone decides, on the agent's crew path).
        shared: !crew && session.owner_user_id !== node.owner_user_id, useApiKey: Boolean(turn.use_api_key),
        repo: { url: session.repo_url, commit: session.base_commit, branch: session.branch, ...(hooks.repoToken?.turnId === turn.id && hooks.repoToken.token ? { authToken: hooks.repoToken.token } : {}) },
        ...(crew ? { ...crew, sessionKind: 'crew' } : {}) }, setup });
    }
    if (action !== 'ai-events' && action !== 'ai-finish') fail(403, 'forbidden', 'Command not permitted for this identity');
    fields(body, action === 'ai-events' ? ['turnId', 'leaseToken', 'seq', 'events'] : ['turnId', 'leaseToken', 'result']);
    const turn = this.turn(string(body, 'turnId', 64));
    const session = this.session(turn.session_id);
    if (session.node_id !== node.id || turn.lease_token !== string(body, 'leaseToken', 200)) fail(409, 'stale_turn', 'Turn is not current');
    if (action === 'ai-finish') {
      const crewRun = session.kind === 'crew' && turn.kind === 'message', crewPush = session.kind === 'crew' && turn.kind === 'push';
      const input = object(body.result); fields(input, ['status', 'message', 'commit', ...(crewRun ? ['baseCommit', 'costUsd', 'files', 'filesTotal', 'filesTruncated', 'report', 'createdProjects'] : crewPush ? ['createdProjects'] : [])]);
      if (!['completed', 'failed', 'stopped'].includes(String(input.status)) || typeof input.message !== 'string' || input.message.length > 4096 ||
        !(input.commit === undefined || input.commit === null || (typeof input.commit === 'string' && SHA.test(input.commit)))) fail(400, 'invalid_result', 'Invalid turn result');
      const extra = crewRun ? crewResult(input) : null;
      const finished = { status: input.status as FinishInput['status'], message: input.message, commit: (input.commit ?? null) as string | null };
      // A crew push turn also reports the created projects it pushed, each with its commit (never a token).
      const pushedProjects = crewPush && input.createdProjects !== undefined ? { createdProjects: createdProjects(input.createdProjects, true) } : {};
      const result = JSON.stringify({ ...finished, ...extra?.fields, ...pushedProjects });
      if (turn.result) {
        if (turn.result !== result) fail(409, 'conflicting_result', 'Result differs from accepted completion');
        return json({ accepted: true });
      }
      if (turn.state !== 'running' || turn.lease_expires_at! <= now) fail(409, 'stale_turn', 'Lease is expired or no longer active');
      this.sql.exec('UPDATE ai_turns SET state = ?, result = ?, updated_at = ? WHERE id = ?', finished.status, result, now, turn.id);
      this.sql.exec('UPDATE ai_sessions SET updated_at = ? WHERE id = ?', now, session.id);
      if (extra) {
        if (extra.reportError) this.note(session.id, turn.id, `Smith could not use this run's report, so it is kept without one: ${extra.reportError}`, now);
        crewHooks(hooks).finish(session, turn, { ...finished, ...extra.fields }, now);
      }
      if (crewPush) crewHooks(hooks).pushed?.(session, turn, { ...finished, ...pushedProjects }, now);
      if (turn.kind === 'push' && turn.product && input.status === 'completed' && typeof input.commit === 'string') this.verify(session, turn, input.commit, now, hooks);
      if (session.kind === 'chat' && turn.kind === 'message' && finished.commit) this.autoPush(session, turn, node, now, hooks);
      if (session.kind === 'crew') crewHooks(hooks).ended?.(now);
      return json({ accepted: true });
    }
    if (turn.state !== 'running' || turn.lease_expires_at! <= now) fail(409, 'stale_turn', 'Lease is expired or no longer active');
    if (!Number.isSafeInteger(body.seq) || Number(body.seq) < 0 || !Array.isArray(body.events) || body.events.length > 64) fail(400, 'invalid_events', 'Invalid event batch');
    const events = body.events.map(raw => {
      const event = object(raw); fields(event, ['kind', 'data']);
      if (!EVENT_KINDS.includes(event.kind as typeof EVENT_KINDS[number])) fail(400, 'invalid_events', 'Unknown event kind');
      if ((event.kind === 'claude' || event.kind === 'codex') && event.kind !== TOOL_EVENT_KIND[session.tool]) fail(400, 'invalid_events', 'Event kind does not match this session’s tool');
      if (event.kind === 'approval') {
        // A CLI asks before acting only in ask mode (Claude Code 'default', Codex 'untrusted'): {"id", "tool", "input"}.
        const data = object(event.data); fields(data, ['id', 'tool', 'input']);
        const asking = (session.tool === 'claude-code' && turn.permission_mode === 'default') || (session.tool === 'codex' && turn.permission_mode === 'untrusted');
        if (!asking || typeof data.id !== 'string' || !APPROVAL_ID.test(data.id) ||
          typeof data.tool !== 'string' || !TOOL_NAME.test(data.tool)) fail(400, 'invalid_events', 'Invalid approval request');
      }
      const data = JSON.stringify(event.data ?? null);
      if (data.length > 32768) fail(413, 'event_too_large', 'Events may contain at most 32 KiB');
      return { kind: event.kind as string, data };
    });
    const seq = Number(body.seq);
    const last = this.sql.exec<{ seq: number | null; bytes: number | null }>('SELECT MAX(seq) AS seq, SUM(bytes) AS bytes FROM ai_events WHERE session_id = ?', session.id).one();
    const expected = (last.seq ?? -1) + 1;
    // Replayed batches (a lost acknowledgement) are accepted only if they line up with what is stored.
    if (seq < expected) {
      const stored = this.sql.exec<{ kind: string; data: string }>('SELECT kind, data FROM ai_events WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq', session.id, seq, seq + events.length).toArray();
      if (stored.length !== events.length || stored.some((e, i) => e.kind !== events[i].kind || e.data !== events[i].data)) fail(409, 'conflicting_events', 'Event sequence was already accepted with different content');
    } else {
      if (seq !== expected) fail(409, 'event_sequence', 'Event sequence must be contiguous');
      const bytes = events.reduce((total, e) => total + e.data.length, 0);
      if ((last.bytes ?? 0) + bytes > MAX_SESSION_BYTES) fail(413, 'session_log_limit', 'This session has reached its transcript limit; start a new one');
      events.forEach((e, i) => {
        this.sql.exec('INSERT INTO ai_events VALUES (?, ?, ?, ?, ?, ?, ?)', session.id, seq + i, turn.id, e.kind, e.data, e.data.length, now);
        // Each CLI announces its own conversation ID; follow-up messages resume that conversation.
        const cliSession = this.cliSessionId(e.kind, e.data);
        if (cliSession) this.sql.exec('UPDATE ai_sessions SET cli_session_id = ? WHERE id = ?', cliSession, session.id);
        if (e.kind === 'approval') {
          const { id, tool } = JSON.parse(e.data) as { id: string; tool: string };
          const always = (JSON.parse(this.session(session.id).allowed_tools) as string[]).includes(tool);
          this.sql.exec('INSERT OR IGNORE INTO ai_approvals (session_id, turn_id, id, tool, behavior, automatic, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            session.id, turn.id, id, tool, always ? 'allow' : null, always ? 1 : 0, now, always ? now : null);
        }
      });
    }
    this.sql.exec('UPDATE ai_turns SET lease_expires_at = ?, updated_at = ? WHERE id = ?', now + LEASE_MS, now, turn.id);
    this.sql.exec('UPDATE ai_sessions SET updated_at = ? WHERE id = ?', now, session.id);
    // Answers to Claude Code's questions ride back on the report the machine sends every few seconds.
    const answers = this.sql.exec<ApprovalRow>('SELECT * FROM ai_approvals WHERE turn_id = ? AND behavior IS NOT NULL ORDER BY answered_at DESC LIMIT 100', turn.id).toArray()
      .map(a => ({ id: a.id, behavior: a.behavior, ...(a.message ? { message: a.message } : {}) }));
    return json({ accepted: true, nextSeq: Math.max(expected, seq + events.length), leaseExpiresAt: now + LEASE_MS, stop: Boolean(this.turn(turn.id).stop_requested), answers });
  }

  // Claude Code: {"type":"system","subtype":"init","session_id":...}. Codex: {"type":"thread.started","thread_id":...}.
  private cliSessionId(kind: string, data: string): string | null {
    if (kind !== 'claude' && kind !== 'codex') return null;
    const parsed = JSON.parse(data) as { type?: string; subtype?: string; session_id?: unknown; thread_id?: unknown } | null;
    const id = kind === 'claude' ? (parsed?.type === 'system' && parsed.subtype === 'init' ? parsed.session_id : null)
      : (parsed?.type === 'thread.started' ? parsed.thread_id : null);
    return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(id) ? id : null;
  }
  private checkMachine(userId: string, session: SessionRow, now: number): NodeRow {
    const node = this.sql.exec<NodeRow>('SELECT * FROM nodes WHERE id = ? AND active = 1', session.node_id).toArray()[0];
    const machine = node && aiMachines(userId, [node], now)[0];
    if (!machine?.options.some(o => o.tool === session.tool && o.brain === session.brain && o.model === session.model)) fail(409, 'machine_unavailable', 'This session’s machine is offline or no longer offers this tool');
    return node;
  }
  private project(id: string): Project | RepoProject | undefined {
    const row = this.sql.exec<{ definition: string }>('SELECT definition FROM projects WHERE id = ?', id).toArray()[0];
    return row ? JSON.parse(row.definition) as Project | RepoProject : undefined;
  }
  // A reply that committed is pushed by itself, as the chat's own push turn on the same machine (request IDs
  // 'auto-push-<seq>'), unless the owner keeps the chat on their computer. What the Push button refuses (a guest's
  // chat, a copy of the project without the operator role, an older agent) is noted in the chat instead, with its fix.
  private autoPush(session: SessionRow, turn: TurnRow, node: NodeRow, now: number, hooks: SessionHooks): void {
    if (session.local_only) return;
    const why = node.owner_user_id !== session.owner_user_id ? 'this chat runs on another member’s computer, so its branch stays there'
      : pushNeedsBuilder(session.repo_url) && !BUILDERS.includes(hooks.roleOf?.(session.owner_user_id) ?? '') ? 'pushing to this project needs the operator role in this workspace'
      : !aiFeatures(node).includes('push') ? `pushing from chats needs a newer Smith agent on ${node.hostname || 'this computer'} (SmithAgent.bat update)` : '';
    if (why) { this.note(session.id, turn.id, `Not pushed: ${why}. The changes are committed on ${session.branch} in the chat’s copy.`, now); return; }
    this.addTurn(session.id, `auto-push-${turn.seq}`, `Push branch ${session.branch}`, '', now, 'push', null);
  }
  // Verify: a normal Smith build of the project, pinned to the commit the push just published. Its
  // outcome is noted in the chat (the turn is over, so Smith may append to the transcript).
  private verify(session: SessionRow, turn: TurnRow, commit: string, now: number, hooks: SessionHooks): void {
    let note: string;
    try {
      if (!hooks.enqueueVerify) throw new Error('Builds are not available here');
      const readToken = hooks.repoToken?.turnId === turn.id ? hooks.repoToken.token ?? '' : '';
      const job = hooks.enqueueVerify(session.project_id, turn.product!, session.branch, commit, `ai-verify-${turn.id}`, readToken);
      this.sql.exec('UPDATE ai_turns SET job_id = ? WHERE id = ?', job.id, turn.id);
      note = `Verify: queued a ${turn.product} build of ${commit.slice(0, 12)} on a build machine.`;
    } catch (error) {
      note = `Verify could not start a build: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
    this.note(session.id, turn.id, note, now);
  }
  // Smith's own line in a transcript, written once the turn is over so it never interleaves with the machine's events.
  note(sessionId: string, turnId: string, text: string, now: number): void {
    const seq = (this.sql.exec<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM ai_events WHERE session_id = ?', sessionId).one().seq ?? -1) + 1;
    const data = JSON.stringify(text);
    this.sql.exec('INSERT INTO ai_events VALUES (?, ?, ?, ?, ?, ?, ?)', sessionId, seq, turnId, 'status', data, data.length, now);
  }
  private addTurn(sessionId: string, requestId: string, text: string, mode: string, now: number, kind: 'message' | 'push' = 'message', product: string | null = null, apiKey = false): TurnRow {
    const seq = (this.sql.exec<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM ai_turns WHERE session_id = ?', sessionId).one().seq ?? 0) + 1;
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO ai_turns (id, session_id, seq, request_id, prompt, permission_mode, state, created_at, updated_at, kind, product, use_api_key) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)", id, sessionId, seq, requestId, text, mode, now, now, kind, product, apiKey ? 1 : 0);
    this.sql.exec('UPDATE ai_sessions SET updated_at = ? WHERE id = ?', now, sessionId);
    return this.turn(id);
  }
  // A person's own chat, or (for a workspace member) any crew run: crew runs act for the workspace, chats for one person.
  private owned(principal: Person, id: string): SessionRow {
    const session = principal.kind === 'member'
      ? this.sql.exec<SessionRow>("SELECT * FROM ai_sessions WHERE id = ? AND kind = 'crew'", id).toArray()[0]
      : this.sql.exec<SessionRow>("SELECT * FROM ai_sessions WHERE id = ? AND owner_user_id = ? AND kind = 'chat'", id, principal.userId).toArray()[0];
    if (!session) fail(404, 'not_found', 'Session not found');
    return session;
  }
  private session(id: string): SessionRow { return this.sql.exec<SessionRow>('SELECT * FROM ai_sessions WHERE id = ?', id).one(); }
  private turn(id: string): TurnRow {
    const turn = this.sql.exec<TurnRow>('SELECT * FROM ai_turns WHERE id = ?', id).toArray()[0];
    if (!turn) fail(404, 'not_found', 'Turn not found');
    return turn;
  }
  private active(sessionId: string): TurnRow | undefined {
    return this.sql.exec<TurnRow>("SELECT * FROM ai_turns WHERE session_id = ? AND state IN ('queued', 'running')", sessionId).toArray()[0];
  }
  private approvals(sessionId: string) {
    return this.sql.exec<ApprovalRow>('SELECT * FROM (SELECT *, rowid AS position FROM ai_approvals WHERE session_id = ? ORDER BY rowid DESC LIMIT 500) ORDER BY position', sessionId).toArray()
      .map(a => ({ id: a.id, turnId: a.turn_id, tool: a.tool, behavior: a.behavior, message: a.message, automatic: Boolean(a.automatic), createdAt: a.created_at, answeredAt: a.answered_at }));
  }
  private turns(sessionId: string) { return this.sql.exec<TurnRow>('SELECT * FROM ai_turns WHERE session_id = ? ORDER BY seq', sessionId).toArray().map(t => this.publicTurn(t)); }
  private publicTurn(t: TurnRow) {
    return { id: t.id, seq: t.seq, kind: t.kind, prompt: t.prompt, permissionMode: t.permission_mode, useApiKey: Boolean(t.use_api_key), product: t.product, jobId: t.job_id, state: t.state, stopRequested: Boolean(t.stop_requested),
      result: t.result ? JSON.parse(t.result) as { status: string; message: string; commit: string | null } : null, createdAt: t.created_at, updatedAt: t.updated_at };
  }
  private publicSession(s: SessionRow) {
    const active = this.active(s.id);
    return { id: s.id, title: s.title, nodeId: s.node_id, projectId: s.project_id, tool: s.tool, brain: s.brain, model: s.model, branch: s.branch,
      baseCommit: s.base_commit, archived: s.archived_at !== null, archivedAt: s.archived_at, pinned: Boolean(s.pinned), localOnly: Boolean(s.local_only), working: Boolean(active),
      // When the CLI started waiting for the owner to answer a question in this chat (null: not waiting).
      waitingSince: active?.state === 'running' ? this.sql.exec<{ at: number | null }>('SELECT MIN(created_at) AS at FROM ai_approvals WHERE turn_id = ? AND behavior IS NULL', active.id).one().at : null,
      allowedTools: JSON.parse(s.allowed_tools) as string[],
      ...(s.kind === 'crew' ? { kind: s.kind, crewId: s.crew_id, trigger: s.trigger ? JSON.parse(s.trigger) as unknown : null, baseCommitActual: s.base_commit_actual, costUsd: s.cost_usd } : {}),
      createdAt: s.created_at, updatedAt: s.updated_at };
  }
}
