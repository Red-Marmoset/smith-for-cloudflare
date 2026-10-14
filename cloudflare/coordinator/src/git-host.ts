import { LFS_SCHEMA } from './lfs';
// Smith-hosted repositories: a project's git repository lives on build machines that keep copies
// ("Keep copies of repositories here"), and people reach it only through the coordinator at
// <origin>/git/<project>.git. The workspace Durable Object is the source of truth for ref tips, picks the
// one primary that takes writes, and relays every git request to a machine through an R2 mailbox,
// because machines only ever poll. Pure helpers plus the HostedGit SQL helper (the RepoAccess pattern).
import { fail, json, string, fields, object } from './http';
import { smokeSpec, type ResolvedJobSpec } from './contracts';

export const GIT_HOST_LABEL = 'smith-git-host';       // advertised by machines able to keep and serve copies
export const GIT_CLIENT_LABEL = 'smith-git-client';   // advertised by agents that can clone a Smith-hosted remote
export const GIT_INIT_LABEL = 'smith-git-init';       // advertised by hosts that can also start a repository (empty or from a zip)
export const GIT_NEW_LABEL = 'smith-git-new';         // advertised by agents that can start a new, empty repository (a host job from Smith's own address)
export const HOST_PRODUCT = 'copy-into-smith';
export const NEW_PRODUCT = 'start-in-smith';
export const MOVE_PRODUCT = 'move-to-storage';           // every branch and tag of a machines home pushed into Artifacts
export const RESTORE_PRODUCT = 'restore-to-storage';     // a machine's current copy pushed back into Artifacts after a loss
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;    // a zip goes up in one request, which Cloudflare caps at 100 MB
export const TICKET_PATTERN = /^smith_git_([a-f0-9]{64})_([A-Za-z0-9-]{32,128})$/;
export const REPO_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const RELAY_LEASE_MS = 120000;                // renewed by every poll of the machine that holds it
export const RELAY_WAIT_MS = { read: 180000, write: 600000 };   // how long a git client's request may wait in all
export const READY_TIMEOUT_MS = 60000;              // a relay nobody picked up within this fails ("no machine answered")
export const TICKET_TTL_MS = { read: 2 * 3600000, write: 2 * 3600000 };
export const MAX_REFS = 10000;
export const MAX_REPO_BYTES = 1024 * 1024 * 1024;
export const MIN_HOST_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export const HOSTED_GIT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS git_repos (id TEXT PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, default_branch TEXT NOT NULL DEFAULT '', primary_node_id TEXT,
    generation INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, source_url TEXT NOT NULL, refs_json TEXT NOT NULL DEFAULT '[]', refs_digest TEXT NOT NULL DEFAULT '', peeled_json TEXT NOT NULL DEFAULT '{}',
    bytes INTEGER NOT NULL DEFAULT 0, job_id TEXT, message TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_push_at INTEGER, last_backup_at INTEGER);
  CREATE TABLE IF NOT EXISTS git_replicas (repo_id TEXT NOT NULL, node_id TEXT NOT NULL, state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, tips_digest TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0, last_sync_at INTEGER, next_attempt_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, tips_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (repo_id, node_id));
  CREATE TABLE IF NOT EXISTS git_relays (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, node_id TEXT NOT NULL, service TEXT NOT NULL, op TEXT NOT NULL, writer INTEGER NOT NULL, state TEXT NOT NULL,
    lease_token TEXT, lease_expires_at INTEGER, req_key TEXT, req_size INTEGER NOT NULL DEFAULT 0, res_key TEXT, upload_id TEXT, parts TEXT NOT NULL DEFAULT '[]', res_size INTEGER, status INTEGER,
    git_protocol TEXT NOT NULL DEFAULT '', user_label TEXT NOT NULL DEFAULT '', ref_policy TEXT NOT NULL DEFAULT '{}', message TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS git_relays_node ON git_relays(node_id, state, created_at);
  CREATE TABLE IF NOT EXISTS git_tasks (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, lease_token TEXT, lease_expires_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, payload TEXT NOT NULL DEFAULT '{}', message TEXT NOT NULL DEFAULT '', upload_id TEXT, parts TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS git_tasks_node ON git_tasks(node_id, state, next_attempt_at);
  CREATE TABLE IF NOT EXISTS git_tickets (hash TEXT PRIMARY KEY, repo_id TEXT NOT NULL, scope TEXT NOT NULL, node_id TEXT, job_id TEXT, ref_policy TEXT NOT NULL DEFAULT '{}',
    label TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS git_backups (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '',
    tips_json TEXT NOT NULL DEFAULT '[]', base_id TEXT, ready INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS git_recovered (repo_id TEXT NOT NULL, node_id TEXT NOT NULL, ref TEXT NOT NULL, sha TEXT NOT NULL, recorded_at INTEGER NOT NULL, PRIMARY KEY (repo_id, node_id, ref));
  CREATE TABLE IF NOT EXISTS git_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, who TEXT NOT NULL, repo_id TEXT NOT NULL, service TEXT NOT NULL, node_id TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL);
` + LFS_SCHEMA;

export type TicketScope = 'read' | 'write';
export type GitService = 'upload-pack' | 'receive-pack';
export type RelayOp = 'info-refs' | 'rpc';
export type RepoState = 'bootstrapping' | 'hosting' | 'degraded' | 'lost' | 'oversize' | 'failed' | 'deleted' | 'importing' | 'artifacts';
export type RelayState = 'open' | 'ready' | 'leased' | 'completed' | 'delivered' | 'failed';
// What the machine's update hook enforces for one push: refs it may touch (glob patterns), refs it may neither
// force-update nor delete, and whether deletions are refused everywhere.
export interface RefPolicy { allow: string[]; protected: string[]; denyDelete: boolean }
export type Tips = [string, string][];   // [sha, ref], sorted by ref

export type RepoRow = { id: string; tips_due: string; uuid: string; default_branch: string; primary_node_id: string | null; generation: number; state: RepoState; source_url: string; refs_json: string; refs_digest: string; peeled_json: string;
  bytes: number; job_id: string | null; message: string; created_at: number; updated_at: number; last_push_at: number | null; last_backup_at: number | null };
export type ReplicaRow = { repo_id: string; node_id: string; state: 'bootstrapping' | 'current' | 'stale' | 'diverged' | 'lost'; generation: number; tips_digest: string; bytes: number; last_sync_at: number | null; next_attempt_at: number | null; attempts: number; tips_json: string };
export type RelayRow = { id: string; repo_id: string; node_id: string; service: GitService; op: RelayOp; writer: number; state: RelayState; lease_token: string | null; lease_expires_at: number | null;
  req_key: string | null; req_size: number; res_key: string | null; upload_id: string | null; parts: string; res_size: number | null; status: number | null; git_protocol: string; user_label: string; ref_policy: string; message: string; created_at: number; updated_at: number };
export type TicketRow = { hash: string; repo_id: string; scope: TicketScope; node_id: string | null; job_id: string | null; ref_policy: string; label: string; expires_at: number; revoked_at: number | null; created_at: number };
// The machine rows HostedGit needs; the workspace passes its own NodeRow shape, which has at least these.
export interface HostNode { id: string; hostname: string; active: number; purpose: string; labels: string; last_seen_at: number; host_repos: number; draining: number }

export function newTicket(workspaceId: string): string { return `smith_git_${workspaceId}_${crypto.randomUUID()}${crypto.randomUUID()}`; }
export function ticketWorkspace(token: string): string | null { return TICKET_PATTERN.exec(token)?.[1] ?? null; }
export function smithRemote(origin: string, repoId: string): string { return `${origin}/git/${repoId}.git`; }
// The project ID of a Smith-hosted remote on this coordinator, else null. Exactly <origin>/git/<id>.git, nothing else.
export function smithRemoteRepo(url: string, origin: string): string | null {
  if (!url.startsWith(origin + '/git/') || url.length > 512) return null;
  const rest = url.slice(origin.length + 5);
  const id = rest.endsWith('.git') ? rest.slice(0, -4) : null;
  return id && REPO_ID.test(id) ? id : null;
}
export function isSmithRemote(url: string, origin: string): boolean { return smithRemoteRepo(url, origin) !== null; }
// The username in a clone URL: the first 12 hex digits of the workspace ID, so credential helpers keep one
// stored password per workspace instead of fighting over the host.
export function cloneUsername(workspaceId: string): string { return workspaceId.slice(0, 12); }
export function cloneUrl(origin: string, workspaceId: string, repoId: string): string {
  const url = new URL(smithRemote(origin, repoId)); url.username = cloneUsername(workspaceId); return url.toString();
}
export function defaultRefPolicy(defaultBranch: string): RefPolicy { return { allow: ['refs/heads/*', 'refs/tags/*'], protected: defaultBranch ? [`refs/heads/${defaultBranch}`] : [], denyDelete: false }; }
export function crewRefPolicy(slug: string): RefPolicy { return { allow: [`refs/heads/smith/crew-${slug}-*`], protected: [], denyDelete: true }; }

// pkt-line framing: a 4-hex-digit length including itself, then the payload. git shows "ERR <text>" in an
// advertisement as `fatal: remote error: <text>`, the one way to put a sentence in front of a person.
export function pktLine(payload: string): string { return (payload.length + 4).toString(16).padStart(4, '0') + payload; }
export function pktErr(message: string): string { return pktLine('ERR ' + message.replace(/[\r\n\x00]/g, ' ').slice(0, 900) + '\n'); }

// A machine's tips as it reports them: [sha, ref] pairs, validated, sorted by ref, de-duplicated.
export function validateTips(value: unknown, allowRecovered = false): Tips {
  if (!Array.isArray(value) || value.length > MAX_REFS) fail(400, 'invalid_tips', `Tips must list at most ${MAX_REFS} refs`);
  const seen = new Set<string>(); const tips: Tips = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string') fail(400, 'invalid_tips', 'Each tip is [sha, ref]');
    const [sha, ref] = item as [string, string];
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha) || !validRef(ref, allowRecovered)) fail(400, 'invalid_tips', `Invalid ref or object name: ${ref.slice(0, 80)}`);
    if (seen.has(ref)) continue; seen.add(ref); tips.push([sha, ref]);
  }
  return tips.sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
}
// Refs a machine may report: never Smith's own namespace, except the recovered refs a copy kept aside (allowRecovered).
export function validRef(ref: string, allowRecovered = false): boolean {
  return ref.length <= 512 && ref.startsWith('refs/') && (!ref.startsWith('refs/smith/') || (allowRecovered && /^refs\/smith\/recovered\/\d{1,16}\/[^/]/.test(ref))) && !/[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|\/\/|@\{|\/\.|\.lock(?:\/|$)|\/$|\.$/.test(ref);
}
// What annotated tags point to ({ref: sha}), reported beside the tips so a clone's ref list can be answered here.
export type Peeled = Record<string, string>;
export function validatePeeled(value: unknown, tips: Tips): Peeled {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_peeled', 'peeled must be an object of ref to object name');
  const refs = new Set(tips.map(([, ref]) => ref)); const peeled: Peeled = {};
  for (const [ref, sha] of Object.entries(value as Record<string, unknown>)) {
    if (!refs.has(ref) || typeof sha !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha)) fail(400, 'invalid_peeled', `Invalid peeled value for ${ref.slice(0, 80)}`);
    peeled[ref] = sha;
  }
  return peeled;
}
// The protocol v2 capability advertisement a hosting machine's git would send, so a clone's first request needs no
// machine. `filter` matches uploadpack.allowFilter in Smith's store config; fetch itself is still relayed.
export function v2Advertisement(): string {
  return pktLine('version 2\n') + pktLine('agent=smith\n') + pktLine('ls-refs=unborn\n') + pktLine('fetch=shallow wait-for-done filter\n') + pktLine('server-option\n') + pktLine('object-format=sha1\n') + '0000';
}
export interface LsRefsRequest { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }
// A protocol v2 request body that is exactly one `ls-refs` command (what a clone or fetch sends first), or null for
// anything else (a fetch, several commands, or a body this parser does not trust itself to read).
export function parseLsRefs(body: Uint8Array): LsRefsRequest | null {
  if (body.byteLength > 65536) return null;
  const text = new TextDecoder('latin1').decode(body);
  const request: LsRefsRequest = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let at = 0, phase: 'command' | 'capabilities' | 'arguments' = 'command', seenFlush = false;
  while (at < text.length) {
    if (seenFlush) return null;   // anything after the flush would be a second command
    if (text.length - at < 4) return null;
    const length = parseInt(text.slice(at, at + 4), 16);
    if (!Number.isInteger(length) || !/^[0-9a-f]{4}$/.test(text.slice(at, at + 4))) return null;
    if (length === 0) { if (phase === 'command') return null; seenFlush = true; at += 4; continue; }
    if (length === 1) { if (phase !== 'capabilities') return null; phase = 'arguments'; at += 4; continue; }
    if (length < 5 || at + length > text.length) return null;
    const line = text.slice(at + 4, at + length).replace(/\n$/, ''); at += length;
    if (phase === 'command') { if (line !== 'command=ls-refs') return null; phase = 'capabilities'; continue; }
    if (phase === 'capabilities') { if (!/^[a-z-]+(?:=[^\x00-\x1f]*)?$/.test(line)) return null; if (line.startsWith('object-format=') && line !== 'object-format=sha1') return null; continue; }
    if (line === 'peel') request.peel = true;
    else if (line === 'symrefs') request.symrefs = true;
    else if (line === 'unborn') request.unborn = true;
    else if (line.startsWith('ref-prefix ')) { const prefix = line.slice(11); if (!prefix || /[\x00-\x1f ~^:?*[\\]/.test(prefix) || request.prefixes.length >= 64) return null; request.prefixes.push(prefix); }
    else return null;
  }
  return seenFlush ? request : null;
}
// The ls-refs answer from the record: HEAD (as a symref to the default branch) and every ref the prefixes admit, with
// peeled values when asked. Null when the record cannot answer (peel asked and a tag's target unknown: an older agent).
export function lsRefsLines(repo: RepoRow, request: LsRefsRequest): string[] | null {
  const tips = JSON.parse(repo.refs_json) as Tips; const peeled = JSON.parse(repo.peeled_json || '{}') as Peeled;
  const admits = (ref: string) => !request.prefixes.length || request.prefixes.some(prefix => ref.startsWith(prefix));
  const lines: string[] = [];
  const head = tips.find(([, ref]) => ref === `refs/heads/${repo.default_branch}`);
  if (admits('HEAD')) {
    if (head) lines.push(`${head[0]} HEAD${request.symrefs ? ` symref-target:${head[1]}` : ''}`);
    else if (request.unborn && repo.default_branch) lines.push(`unborn HEAD symref-target:refs/heads/${repo.default_branch}`);
  }
  for (const [sha, ref] of tips) {
    if (!admits(ref)) continue;
    if (request.peel && ref.startsWith('refs/tags/') && peeled[ref] === undefined && repo.peeled_json === '{}') return null;
    lines.push(`${sha} ${ref}${request.peel && peeled[ref] ? ` peeled:${peeled[ref]}` : ''}`);
  }
  return lines;
}
export function canonicalTips(tips: Tips): string { return tips.map(([sha, ref]) => `${sha} ${ref}\n`).join(''); }
export async function tipsDigest(tips: Tips): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalTips(tips)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function parseRefPolicy(value: unknown): RefPolicy {
  const policy = value && typeof value === 'object' ? value as Partial<RefPolicy> : {};
  const list = (v: unknown) => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length <= 256).slice(0, 32) : [];
  return { allow: list(policy.allow), protected: list(policy.protected), denyDelete: policy.denyDelete === true };
}
// What a machine must be to hold copies here: active, a build machine, switched on, advertising the label and online.
export function hostEligible(node: HostNode, now: number, offlineMs: number): boolean {
  return Boolean(node.active) && node.purpose === 'build' && Boolean(node.host_repos) && !node.draining && (JSON.parse(node.labels) as string[]).includes(GIT_HOST_LABEL) && node.last_seen_at > now - offlineMs;
}
// Why a machine cannot host, for the machine card; '' when it can (switched on or not).
export function hostingReason(node: HostNode, hosting: { able?: boolean; reason?: string } | null): string {
  if (node.purpose !== 'build') return 'Personal machines do not keep copies';
  if (!(JSON.parse(node.labels) as string[]).includes(GIT_HOST_LABEL)) return hosting?.reason || 'This machine’s agent cannot keep copies yet (update it)';
  return '';
}
// The host job: whichever eligible machine claims it clones the source with its own Git login into a bare mirror,
// configures it, and reports the tips. Its kind is 'host' and it needs the host label.
export function hostSpecs(project: { id: string; repoUrl: string; branch: string; commit: string }, jobId: string, repoUuid: string, defaultBranch: string): Record<string, ResolvedJobSpec> {
  const specs: Record<string, ResolvedJobSpec> = {};
  for (const os of ['windows', 'linux', 'mac']) {
    specs[os] = { ...smokeSpec(jobId, os), kind: 'host', projectId: project.id, buildNumber: 0, timeoutSeconds: 3600,
      repos: [{ name: 'main', url: project.repoUrl, branch: project.branch, commit: project.commit, checkoutDir: '.', authToken: '' }],
      host: { repoUuid, defaultBranch, maxBytes: MAX_REPO_BYTES } };
  }
  return specs;
}
// A project started in Smith (no repository to copy): the host job instead creates the repository with one first
// commit, either a README (empty) or the contents of an uploaded zip, which the machine downloads with its lease.
export interface HostInit { kind: 'empty' | 'zip'; name: string; archiveName?: string; archiveSize?: number }
export function hostInitSpecs(projectId: string, jobId: string, repoUuid: string, branch: string, init: HostInit): Record<string, ResolvedJobSpec> {
  const specs: Record<string, ResolvedJobSpec> = {};
  for (const os of ['windows', 'linux', 'mac']) {
    specs[os] = { ...smokeSpec(jobId, os), kind: 'host', projectId, buildNumber: 0, timeoutSeconds: 3600, repos: [],
      host: { repoUuid, defaultBranch: branch, maxBytes: MAX_REPO_BYTES, init: { kind: init.kind, name: init.name, archiveName: init.archiveName ?? '', archiveSize: init.archiveSize ?? 0 } } };
  }
  return specs;
}
// What the heartbeat says about a machine's ability to host: able, or the one reason it cannot, and free disk.
export function validateHosting(value: unknown): { able: boolean; reason: string; free: number } {
  const h = value && typeof value === 'object' ? value as Record<string, unknown> : fail(400, 'invalid_field', 'hosting must be an object');
  if (typeof h.able !== 'boolean') fail(400, 'invalid_field', 'hosting.able must be a boolean');
  const reason = h.reason === undefined ? '' : typeof h.reason === 'string' && h.reason.length <= 200 && !/[\x00-\x1f]/.test(h.reason) ? h.reason : fail(400, 'invalid_field', 'hosting.reason is too long');
  const free = h.free === undefined ? 0 : Number.isSafeInteger(h.free) && (h.free as number) >= 0 ? h.free as number : fail(400, 'invalid_field', 'hosting.free must be a byte count');
  return { able: h.able, reason, free };
}
// The project's server-owned record of its copy on Smith's machines (never caller-supplied).
export interface ProjectHosted { repoId: string; uuid: string; status: 'copying' | 'ready' | 'failed'; sourceRepoUrl: string; jobId?: string; message?: string; updatedAt: number;
  detachedFrom?: string; sync?: import('./upstream').UpstreamSync;
  // A project started in Smith rather than copied: what the host job creates, and the uploaded zip's R2 key in the GIT
  // bucket (deleted once the repository exists; kept after a failure so "Try again" needs no second upload).
  init?: HostInit & { uploadKey?: string } }

export class HostedGit {
  constructor(private readonly sql: SqlStorage, private readonly workspaceId: string, private readonly origin: string, private readonly readyTimeoutMs = READY_TIMEOUT_MS) {}

  repo(id: string): RepoRow | undefined { return this.sql.exec<RepoRow>('SELECT * FROM git_repos WHERE id = ?', id).toArray()[0]; }
  repoByUuid(uuid: string): RepoRow | undefined { return this.sql.exec<RepoRow>('SELECT * FROM git_repos WHERE uuid = ?', uuid).toArray()[0]; }
  repos(): RepoRow[] { return this.sql.exec<RepoRow>("SELECT * FROM git_repos WHERE state != 'deleted' ORDER BY id").toArray(); }
  replicas(repoId: string): ReplicaRow[] { return this.sql.exec<ReplicaRow>('SELECT * FROM git_replicas WHERE repo_id = ? ORDER BY node_id', repoId).toArray(); }
  // The repos a machine holds (for its poll reply and the machine card).
  heldBy(nodeId: string): { repo: RepoRow; replica: ReplicaRow }[] {
    return this.sql.exec<ReplicaRow>('SELECT * FROM git_replicas WHERE node_id = ? ORDER BY repo_id', nodeId).toArray()
      .map(replica => ({ replica, repo: this.repo(replica.repo_id)! })).filter(x => x.repo && x.repo.state !== 'deleted');
  }

  // ---- hosting a project ----

  // Start keeping copies of a project: a git_repos row plus the host job any eligible machine may claim.
  startHosting(project: { id: string; repoUrl: string; branch: string; commit: string }, jobId: string, uuid: string, now: number): RepoRow {
    const existing = this.repo(project.id);
    if (existing && existing.state !== 'failed' && existing.state !== 'deleted') fail(409, 'hosted_already', 'Smith already keeps copies of this project');
    // A removed project's machines may still be throwing their copies away (discard tasks address the repository by ID).
    if (existing?.state === 'deleted' && this.sql.exec("SELECT 1 FROM git_tasks WHERE repo_id = ? AND state IN ('queued', 'leased') LIMIT 1", project.id).toArray().length)
      fail(409, 'hosted_removing', 'The machines are still throwing away the copies of the project this one replaces; try again in a minute');
    if (existing) for (const table of ['git_repos WHERE id', 'git_replicas WHERE repo_id', 'git_backups WHERE repo_id', 'git_recovered WHERE repo_id']) this.sql.exec(`DELETE FROM ${table} = ?`, project.id);
    this.sql.exec("INSERT INTO git_repos (id, uuid, default_branch, state, source_url, job_id, created_at, updated_at) VALUES (?, ?, ?, 'bootstrapping', ?, ?, ?, ?)",
      project.id, uuid, project.branch, project.repoUrl, jobId, now, now);
    return this.repo(project.id)!;
  }
  // The host job finished: the machine that ran it holds the first copy and becomes primary.
  finishHost(repoId: string, nodeId: string, report: { tips: Tips; digest: string; defaultBranch: string; bytes: number; peeled?: Peeled }, now: number): RepoRow {
    const repo = this.repo(repoId); if (!repo || repo.state !== 'bootstrapping') return repo!;
    const state: RepoState = report.bytes > MAX_REPO_BYTES ? 'oversize' : 'hosting';
    this.sql.exec('UPDATE git_repos SET state = ?, primary_node_id = ?, generation = 1, default_branch = ?, refs_json = ?, refs_digest = ?, peeled_json = ?, bytes = ?, job_id = NULL, message = ?, updated_at = ? WHERE id = ?',
      state, nodeId, report.defaultBranch || repo.default_branch, JSON.stringify(report.tips), report.digest, JSON.stringify(report.peeled ?? {}), report.bytes, state === 'oversize' ? 'This repository is larger than 1 GiB, so Smith keeps only this one copy of it' : '', now, repoId);
    this.sql.exec("INSERT INTO git_replicas (repo_id, node_id, state, generation, tips_digest, bytes, last_sync_at) VALUES (?, ?, 'current', 1, ?, ?, ?) ON CONFLICT(repo_id, node_id) DO UPDATE SET state = 'current', generation = 1, tips_digest = excluded.tips_digest, bytes = excluded.bytes, last_sync_at = excluded.last_sync_at",
      repoId, nodeId, report.digest, report.bytes, now);
    return this.repo(repoId)!;
  }
  // A host job that did not succeed leaves the project where it was; the card says why.
  failHost(repoId: string, message: string, now: number): void {
    this.sql.exec("UPDATE git_repos SET state = 'failed', job_id = NULL, message = ?, updated_at = ? WHERE id = ? AND state = 'bootstrapping'", message.slice(0, 300), now, repoId);
  }

  // ---- machines ----

  // Machines able to serve a repository now: its primary first, then current replicas, all eligible and online.
  // An Artifacts home (spec §3): the row exists from the moment an import or a Move to storage starts (`importing`), and
  // becomes `artifacts` once the repository is there with its tips. No primary: Artifacts serves; machines hold copies.
  startArtifactsHome(repoId: string, uuid: string, sourceUrl: string, defaultBranch: string, now: number): RepoRow {
    const existing = this.repo(repoId);
    if (existing && existing.state !== 'deleted' && existing.state !== 'failed') fail(409, 'already_hosted', 'This project already has a copy in Smith');
    this.sql.exec('DELETE FROM git_repos WHERE id = ?', repoId);
    this.sql.exec("INSERT INTO git_repos (id, uuid, default_branch, primary_node_id, generation, state, source_url, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, 'importing', ?, ?, ?)", repoId, uuid, defaultBranch, sourceUrl, now, now);
    return this.repo(repoId)!;
  }
  // Move or Restore to storage settled (spec §1, §3): the existing row becomes an Artifacts home in place, so copies keep
  // their rows (stale, refreshed by the planner) and backups their keys; the former primary is a copy like any other.
  becomeArtifactsHome(repoId: string, sourceUrl: string, tips: Tips, digest: string, peeled: Peeled, now: number): RepoRow {
    this.sql.exec("UPDATE git_repos SET state = 'artifacts', primary_node_id = NULL, source_url = ?, refs_json = ?, refs_digest = ?, peeled_json = ?, generation = generation + 1, message = '', updated_at = ? WHERE id = ?", sourceUrl, JSON.stringify(tips), digest, JSON.stringify(peeled), now, repoId);
    this.sql.exec("UPDATE git_replicas SET state = 'stale' WHERE repo_id = ? AND state = 'current'", repoId);
    return this.repo(repoId)!;
  }
  markLost(repoId: string, message: string, now: number): void {
    this.sql.exec("UPDATE git_repos SET state = 'lost', message = ?, updated_at = ? WHERE id = ? AND state != 'deleted'", message, now, repoId);
  }
  artifactsReady(repoId: string, tips: Tips, digest: string, peeled: Peeled, defaultBranch: string, bytes: number, now: number): RepoRow {
    this.sql.exec("UPDATE git_repos SET state = 'artifacts', refs_json = ?, refs_digest = ?, peeled_json = ?, default_branch = ?, bytes = ?, generation = generation + 1, message = '', updated_at = ? WHERE id = ?", JSON.stringify(tips), digest, JSON.stringify(peeled), defaultBranch, bytes, now, repoId);
    this.sql.exec("UPDATE git_replicas SET state = 'stale' WHERE repo_id = ? AND state = 'current'", repoId);
    return this.repo(repoId)!;
  }
  // The advertisement says what Artifacts holds now. A changed digest bumps the generation and marks every copy stale.
  adoptArtifactsTips(repo: RepoRow, tips: Tips, digest: string, peeled: Peeled, now: number): { changed: boolean; before: string; after: string } {
    if (repo.refs_digest === digest) return { changed: false, before: repo.refs_json, after: repo.refs_json };
    const after = JSON.stringify(tips); const generation = repo.generation + 1;
    this.sql.exec("UPDATE git_repos SET refs_json = ?, refs_digest = ?, peeled_json = ?, generation = ?, last_push_at = ?, updated_at = ? WHERE id = ?", after, digest, JSON.stringify(peeled), generation, now, now, repo.id);
    // A copy that already reported these refs holds them: it is current at the new generation; the others refresh.
    this.sql.exec("UPDATE git_replicas SET state = 'stale' WHERE repo_id = ? AND state IN ('current', 'stale') AND tips_digest != ?", repo.id, digest);
    this.sql.exec("UPDATE git_replicas SET state = 'current', generation = ? WHERE repo_id = ? AND state IN ('current', 'stale') AND tips_digest = ?", generation, repo.id, digest);
    return { changed: true, before: repo.refs_json, after };
  }
  // The record's tips are due a refresh before the daily one: a push whose advertisement could not be read ('push', which
  // then fires Build on push), or a copy reporting refs the record lacks ('copy'). A pending push reason is never downgraded.
  markTipsDue(repoId: string, reason: 'push' | 'copy'): void {
    this.sql.exec("UPDATE git_repos SET tips_due = CASE WHEN tips_due = 'push' THEN 'push' ELSE ? END WHERE id = ? AND state = 'artifacts'", reason, repoId);
  }
  servers(repo: RepoRow, nodes: HostNode[], now: number, offlineMs: number, writer: boolean, excludeNodeId: string | null = null): HostNode[] {
    if (repo.state === 'artifacts') return writer ? [] : this.replicas(repo.id).filter(r => r.state === 'current' && r.generation === repo.generation).map(r => nodes.find(n => n.id === r.node_id)).filter((n): n is HostNode => Boolean(n) && hostEligible(n!, now, offlineMs) && n!.id !== excludeNodeId);
    const eligible = new Map(nodes.filter(n => hostEligible(n, now, offlineMs) && n.id !== excludeNodeId).map(n => [n.id, n]));
    const primary = repo.primary_node_id ? eligible.get(repo.primary_node_id) : undefined;
    if (writer) return primary ? [primary] : [];
    const current = this.replicas(repo.id).filter(r => r.state === 'current' && r.generation === repo.generation && r.node_id !== repo.primary_node_id).map(r => eligible.get(r.node_id)).filter((n): n is HostNode => Boolean(n));
    return primary ? [primary, ...current] : current;
  }

  // ---- tickets: short-lived credentials the coordinator mints for machines and AI turns ----

  issueTicket(hash: string, repoId: string, scope: TicketScope, bind: { nodeId?: string | null; jobId?: string | null; policy?: RefPolicy; label?: string; ttlMs?: number }, now: number): void {
    this.sql.exec('INSERT INTO git_tickets (hash, repo_id, scope, node_id, job_id, ref_policy, label, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      hash, repoId, scope, bind.nodeId ?? null, bind.jobId ?? null, JSON.stringify(bind.policy ?? defaultRefPolicy(this.repo(repoId)?.default_branch ?? '')), (bind.label ?? '').slice(0, 64), now + (bind.ttlMs ?? TICKET_TTL_MS[scope]), now);
  }
  // A presented ticket: valid, unexpired, for this repo, with the right scope, and (when bound) presented by its machine.
  resolveTicket(hash: string, repoId: string, scope: TicketScope, nodeHash: string | null, nodeId: (tokenHash: string) => string | null, now: number): TicketRow {
    const row = this.sql.exec<TicketRow>('SELECT * FROM git_tickets WHERE hash = ?', hash).toArray()[0];
    if (!row || row.revoked_at !== null || row.expires_at <= now) fail(401, 'invalid_ticket', 'This Smith credential has expired');
    if (row.repo_id !== repoId) fail(404, 'not_found', 'Repository not found');
    if (scope === 'write' && row.scope !== 'write') fail(403, 'scope', 'This Smith credential cannot push');
    if (row.node_id && (!nodeHash || nodeId(nodeHash) !== row.node_id)) fail(401, 'invalid_ticket', 'This Smith credential belongs to another machine');
    return row;
  }
  revokeJobTickets(jobId: string, now: number): void { this.sql.exec('UPDATE git_tickets SET revoked_at = ? WHERE job_id = ? AND revoked_at IS NULL', now, jobId); }
  revokeNodeTickets(nodeId: string, now: number): void { this.sql.exec('UPDATE git_tickets SET revoked_at = ? WHERE node_id = ? AND revoked_at IS NULL', now, nodeId); }
  pruneTickets(now: number): void { this.sql.exec('DELETE FROM git_tickets WHERE expires_at <= ? OR revoked_at < ?', now - 86400000, now - 86400000); }

  // ---- relays: one git request parked for one machine ----

  openRelay(id: string, repo: RepoRow, node: HostNode, service: GitService, op: RelayOp, writer: boolean, gitProtocol: string, userLabel: string, policy: RefPolicy, now: number): RelayRow {
    this.sql.exec("INSERT INTO git_relays (id, repo_id, node_id, service, op, writer, state, git_protocol, user_label, ref_policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)",
      id, repo.id, node.id, service, op, writer ? 1 : 0, gitProtocol.slice(0, 64), userLabel.slice(0, 64), JSON.stringify(policy), now, now);
    return this.relay(id);
  }
  relay(id: string): RelayRow { const row = this.sql.exec<RelayRow>('SELECT * FROM git_relays WHERE id = ?', id).toArray()[0]; if (!row) fail(404, 'not_found', 'Relay not found'); return row; }
  readyRelay(id: string, reqKey: string | null, reqSize: number, now: number): void {
    this.sql.exec("UPDATE git_relays SET state = 'ready', req_key = ?, req_size = ?, updated_at = ? WHERE id = ? AND state = 'open'", reqKey, reqSize, now, id);
  }
  failRelay(id: string, message: string, now: number): RelayRow | undefined {
    const row = this.sql.exec<RelayRow>('SELECT * FROM git_relays WHERE id = ?', id).toArray()[0];
    if (!row || ['completed', 'delivered', 'failed'].includes(row.state)) return row;
    this.sql.exec("UPDATE git_relays SET state = 'failed', message = ?, updated_at = ? WHERE id = ?", message.slice(0, 300), now, id);
    return this.relay(id);
  }
  // A machine's poll: renew what it holds, then hand it the oldest ready relay addressed to it.
  poll(node: HostNode, leaseToken: string, now: number): { relay: RelayRow | null; renewed: number } {
    const renewed = this.sql.exec("UPDATE git_relays SET lease_expires_at = ?, updated_at = ? WHERE node_id = ? AND state = 'leased' AND lease_expires_at > ?", now + RELAY_LEASE_MS, now, node.id, now).rowsWritten;
    this.sql.exec("UPDATE git_tasks SET lease_expires_at = ?, updated_at = ? WHERE node_id = ? AND state = 'leased' AND lease_expires_at > ?", now + RELAY_LEASE_MS, now, node.id, now);
    const next = this.sql.exec<RelayRow>("SELECT * FROM git_relays WHERE node_id = ? AND state = 'ready' ORDER BY created_at, id LIMIT 1", node.id).toArray()[0];
    if (!next) return { relay: null, renewed };
    this.sql.exec("UPDATE git_relays SET state = 'leased', lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?", leaseToken, now + RELAY_LEASE_MS, now, next.id);
    return { relay: this.relay(next.id), renewed };
  }
  // The relay a machine is working on, checked: leased to it, with its lease token, unexpired.
  heldRelay(id: string, node: HostNode, leaseToken: string, now: number): RelayRow {
    const row = this.relay(id);
    if (row.node_id !== node.id || row.lease_token !== leaseToken) fail(409, 'stale_relay', 'This relay is not yours');
    if (row.state !== 'leased' || (row.lease_expires_at ?? 0) <= now) fail(409, 'stale_relay', 'This relay’s lease has ended');
    return row;
  }
  setUpload(id: string, uploadId: string, resKey: string, now: number): void { this.sql.exec('UPDATE git_relays SET upload_id = ?, res_key = ?, updated_at = ? WHERE id = ?', uploadId, resKey, now, id); }
  addPart(id: string, part: number, etag: string, size: number, now: number): void {
    const row = this.relay(id); const parts = (JSON.parse(row.parts) as { part: number; etag: string; size: number }[]).filter(p => p.part !== part);
    parts.push({ part, etag, size }); parts.sort((a, b) => a.part - b.part);
    this.sql.exec('UPDATE git_relays SET parts = ?, updated_at = ? WHERE id = ?', JSON.stringify(parts), now, id);
  }
  // The machine's completion: the response object exists with the declared size; refs it reported are recorded
  // before anyone reads the response. Idempotent for the same lease; a late completion of a push whose lease
  // expired still records its tips (the push landed), but its response is gone.
  completeRelay(id: string, node: HostNode, leaseToken: string, status: number, size: number, message: string, now: number): { relay: RelayRow; late: boolean } {
    const row = this.relay(id);
    if (row.node_id !== node.id || row.lease_token !== leaseToken) fail(409, 'stale_relay', 'This relay is not yours');
    if (row.state === 'completed' || row.state === 'delivered') return { relay: row, late: false };
    const late = row.state !== 'leased' || (row.lease_expires_at ?? 0) <= now;
    if (late) return { relay: row, late: true };
    this.sql.exec("UPDATE git_relays SET state = 'completed', status = ?, res_size = ?, message = ?, updated_at = ? WHERE id = ?", status, size, message.slice(0, 300), now, id);
    return { relay: this.relay(id), late: false };
  }
  deliverRelay(id: string, now: number): void { this.sql.exec("UPDATE git_relays SET state = 'delivered', updated_at = ? WHERE id = ? AND state = 'completed'", now, id); }
  // Expiry on the alarm and before every hand-out: a ready relay nobody took, a leased relay whose machine went quiet.
  // Writer relays are never re-leased (receive-pack is not idempotent); reader relays go back to ready once.
  expireRelays(now: number): RelayRow[] {
    const failed: RelayRow[] = [];
    for (const row of this.sql.exec<RelayRow>("SELECT * FROM git_relays WHERE state = 'ready' AND updated_at <= ?", now - this.readyTimeoutMs).toArray()) {
      this.sql.exec("UPDATE git_relays SET state = 'failed', message = 'No machine answered in time', updated_at = ? WHERE id = ?", now, row.id); failed.push(this.relay(row.id));
    }
    for (const row of this.sql.exec<RelayRow>("SELECT * FROM git_relays WHERE state = 'leased' AND lease_expires_at <= ?", now).toArray()) {
      if (row.writer || row.lease_token?.includes('.retry')) {
        this.sql.exec("UPDATE git_relays SET state = 'failed', message = ?, updated_at = ? WHERE id = ?", row.writer ? 'push outcome unknown; run git fetch and push again' : 'The machine serving this request stopped answering', now, row.id);
        failed.push(this.relay(row.id));
      } else this.sql.exec("UPDATE git_relays SET state = 'ready', lease_token = ?, lease_expires_at = NULL, upload_id = NULL, res_key = NULL, parts = '[]', updated_at = ? WHERE id = ?", (row.lease_token ?? '') + '.retry', now, row.id);
    }
    this.sql.exec("DELETE FROM git_relays WHERE state IN ('delivered', 'failed') AND updated_at <= ?", now - 3600000);
    return failed;
  }
  // Relays the alarm or the client may still be waiting on.
  pendingRelays(): RelayRow[] { return this.sql.exec<RelayRow>("SELECT * FROM git_relays WHERE state IN ('open', 'ready', 'leased')").toArray(); }

  // ---- tips: the record of every ref, and what each copy holds ----

  // A push completed on the primary, or the primary reported tips that differ from the record: the record adopts them.
  adoptTips(repo: RepoRow, nodeId: string, tips: Tips, digest: string, bytes: number | null, now: number, reason: 'push' | 'report', peeled: Peeled = {}): RepoRow {
    const changed = digest !== repo.refs_digest;
    if (changed) {
      this.sql.exec("UPDATE git_repos SET refs_json = ?, refs_digest = ?, peeled_json = ?, generation = generation + 1, updated_at = ?, last_push_at = CASE WHEN ? = 'push' THEN ? ELSE last_push_at END WHERE id = ?", JSON.stringify(tips), digest, JSON.stringify(peeled), now, reason, now, repo.id);
      this.sql.exec("UPDATE git_replicas SET state = 'stale' WHERE repo_id = ? AND node_id != ? AND state = 'current'", repo.id, nodeId);
    } else if (Object.keys(peeled).length && repo.peeled_json === '{}') this.sql.exec('UPDATE git_repos SET peeled_json = ? WHERE id = ?', JSON.stringify(peeled), repo.id);   // an updated agent fills in what an older one left out
    const current = this.repo(repo.id)!;
    this.sql.exec("INSERT INTO git_replicas (repo_id, node_id, state, generation, tips_digest, bytes, last_sync_at) VALUES (?, ?, 'current', ?, ?, ?, ?) ON CONFLICT(repo_id, node_id) DO UPDATE SET state = 'current', generation = excluded.generation, tips_digest = excluded.tips_digest, bytes = COALESCE(excluded.bytes, git_replicas.bytes), last_sync_at = excluded.last_sync_at",
      repo.id, nodeId, current.generation, digest, bytes ?? 0, now);
    if (bytes !== null) {
      const state: RepoState = bytes > MAX_REPO_BYTES ? 'oversize' : current.state === 'oversize' ? 'hosting' : current.state;
      this.sql.exec('UPDATE git_repos SET bytes = ?, state = ?, message = ? WHERE id = ?', bytes, state, state === 'oversize' ? 'This repository is larger than 1 GiB, so Smith keeps only this one copy of it' : current.state === 'oversize' ? '' : current.message, repo.id);
    }
    return this.repo(repo.id)!;
  }
  // A replica reported what it holds: current when it matches the record, stale otherwise.
  reportReplica(repo: RepoRow, nodeId: string, digest: string, bytes: number | null, now: number, tips: Tips | null = null): ReplicaRow {
    const state = digest === repo.refs_digest ? 'current' : 'stale';
    this.sql.exec("INSERT INTO git_replicas (repo_id, node_id, state, generation, tips_digest, bytes, last_sync_at, tips_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repo_id, node_id) DO UPDATE SET state = excluded.state, generation = excluded.generation, tips_digest = excluded.tips_digest, bytes = COALESCE(excluded.bytes, git_replicas.bytes), last_sync_at = excluded.last_sync_at, tips_json = excluded.tips_json",
      repo.id, nodeId, state, state === 'current' ? repo.generation : 0, digest, bytes ?? 0, now, state === 'current' || !tips ? '[]' : JSON.stringify(tips));
    return this.sql.exec<ReplicaRow>('SELECT * FROM git_replicas WHERE repo_id = ? AND node_id = ?', repo.id, nodeId).one();
  }

  // ---- what people see ----

  // The Hosted-on-Smith row of a project card.
  publicRepo(repo: RepoRow, nodes: HostNode[], now: number, offlineMs: number) {
    const names = new Map(nodes.map(n => [n.id, n]));
    const copies = this.replicas(repo.id).map(r => { const n = names.get(r.node_id); return { nodeId: r.node_id, host: n?.hostname || r.node_id.slice(0, 8), primary: r.node_id === repo.primary_node_id, state: r.state, online: n ? hostEligible(n, now, offlineMs) : false, lastSyncAt: r.last_sync_at }; });
    const online = this.servers(repo, nodes, now, offlineMs, false);
    return { repoId: repo.id, state: repo.state, home: repo.state === 'artifacts' || repo.state === 'importing' ? 'artifacts' : 'machines', defaultBranch: repo.default_branch, generation: repo.generation, bytes: repo.bytes, refs: (JSON.parse(repo.refs_json) as Tips).length, message: repo.message,
      primaryHost: repo.primary_node_id ? names.get(repo.primary_node_id)?.hostname ?? null : null, primaryOnline: online.some(n => n.id === repo.primary_node_id), copies, serving: online.length,
      lastPushAt: repo.last_push_at, lastBackupAt: repo.last_backup_at, cloneUrl: cloneUrl(this.origin, this.workspaceId, repo.id), remote: smithRemote(this.origin, repo.id) };
  }
  // The Clone dialog: URL, username and what to use as the password.
  cloneInfo(repo: RepoRow) {
    return { repoId: repo.id, cloneUrl: cloneUrl(this.origin, this.workspaceId, repo.id), username: cloneUsername(this.workspaceId), remote: smithRemote(this.origin, repo.id), defaultBranch: repo.default_branch, workspaceId: this.workspaceId };
  }
  audit(now: number, who: string, repoId: string, service: string, nodeId: string, bytes: number, result: string): void {
    const clean = (s: string) => s.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 120);
    this.sql.exec('INSERT INTO git_audit (at, who, repo_id, service, node_id, bytes, result) VALUES (?, ?, ?, ?, ?, ?, ?)', now, clean(who), repoId, service, nodeId, bytes, clean(result));
    this.sql.exec('DELETE FROM git_audit WHERE at < ?', now - 30 * 86400000);
  }
  nextDue(now: number): number | null {
    const relay = this.sql.exec<{ due: number | null }>("SELECT MIN(CASE WHEN state = 'ready' THEN updated_at + ? WHEN state = 'leased' THEN lease_expires_at END) AS due FROM git_relays WHERE state IN ('ready', 'leased')", this.readyTimeoutMs).one().due;
    const task = this.sql.exec<{ due: number | null }>("SELECT MIN(CASE WHEN state = 'leased' THEN lease_expires_at ELSE next_attempt_at END) AS due FROM git_tasks WHERE state IN ('queued', 'leased')").one().due;
    const dues = [relay, task].filter((d): d is number => typeof d === 'number');
    return dues.length ? Math.max(now + 1, Math.min(...dues)) : null;
  }
}

// Validates the body of a machine's relay completion.
export function validateRelayCompletion(body: Record<string, unknown>): { relayId: string; leaseToken: string; status: number; size: number; message: string; tips: Tips | null; bytes: number | null; peeled: Peeled } {
  fields(body, ['relayId', 'leaseToken', 'status', 'size', 'message', 'tips', 'bytes', 'peeled']);
  const relayId = string(body, 'relayId', 64); const leaseToken = string(body, 'leaseToken', 300);
  if (!Number.isSafeInteger(body.status) || (body.status as number) < 200 || (body.status as number) > 599) fail(400, 'invalid_field', 'status must be an HTTP status');
  if (!Number.isSafeInteger(body.size) || (body.size as number) < 0) fail(400, 'invalid_field', 'size must be a byte count');
  const message = body.message === undefined ? '' : typeof body.message === 'string' && body.message.length <= 1000 ? body.message : fail(400, 'invalid_field', 'message is too long');
  const tips = body.tips === undefined || body.tips === null ? null : validateTips(body.tips);
  const bytes = body.bytes === undefined || body.bytes === null ? null : Number.isSafeInteger(body.bytes) && (body.bytes as number) >= 0 ? body.bytes as number : fail(400, 'invalid_field', 'bytes must be a byte count');
  return { relayId, leaseToken, status: body.status as number, size: body.size as number, message, tips, bytes, peeled: tips ? validatePeeled(body.peeled, tips) : {} };
}
// The host job's report of what the machine now holds: refs as [sha, ref] pairs, the HEAD branch and the store size.
export function validateHostReport(value: unknown): { tips: [string, string][]; defaultBranch: string; bytes: number; peeled: Peeled } {
  const report = object(value); fields(report, ['tips', 'defaultBranch', 'bytes', 'peeled']);
  const tips = validateTips(report.tips); const peeled = validatePeeled(report.peeled, tips);
  const defaultBranch = report.defaultBranch === undefined ? '' : typeof report.defaultBranch === 'string' && report.defaultBranch.length <= 256 ? report.defaultBranch : fail(400, 'invalid_result', 'Invalid default branch');
  if (!Number.isSafeInteger(report.bytes) || Number(report.bytes) < 0) fail(400, 'invalid_result', 'Invalid repository size');
  return { tips, defaultBranch, bytes: Number(report.bytes), peeled };
}
export function emptyJson(): Response { return json({}); }
