import { projectAutomation } from './crew-orchestration-model';
import { CrewEvents, repositoryKey, type StoredCheckIn } from './crew-events';
import { readCheckInMetadata, type CheckInMetadata } from './checkin-metadata';
import { verifyCheckInWebhook, normalizeGitHubCheckIn } from './checkin-webhook';
import { CHECKIN_SCHEMA } from './crew-events';
import { DurableObject } from 'cloudflare:workers';
import { fail, json, errorResponse, fields, string, object, hash, randomToken, HttpError } from './http';
import { smokeSpec, type Principal, type JobState, type JobResult, type HostedAssignment, type ResolvedJobSpec, type ScanReport, type ImportReport } from './contracts';
import { pushActions, validBranch, RepoAccess, REPO_ACCESS_SCHEMA, ACCESS_FILTER, ACCESS_TTL_MS, REPO_LABEL, SCAN_PRODUCT, applyReport, createRepoProject, isRepoProject, newProjectId, publicRepoProject, repoBuildSpecs, resolveBuildSpec, scanSpecs, validateScanReport, type RepoProject } from './repo-projects';
import { githubReader, githubRepo, GitHubReadError, githubLister, type LargeBlobs } from './github-reader';
import { githubHooks, hookUrl, parsePush, verifySignature, PUSH_EVENTS, type PushDelivery, type PushHook, type PushPending } from './push-builds';
import { PipelineError } from './pipeline';
import { validateProject, projectSpecs, mirrorSpecs, strings, type Project, type ProjectArtifacts } from './projects';
import { SYNC_LABEL, SYNC_PRODUCT, copyOf, smithCopy, syncFailure, syncRunning, syncSpecs, upstreamOf, validateUpstreamUrl, type CopyInfo, type SyncDirection, type UpstreamSync } from './upstream';
import { githubTokenFor, githubTokensFor } from './oauth';
import { createArtifacts, resolveArtifactsCredentials, isArtifactsRemote, repoNameFor, READ_TOKEN_TTL, WRITE_TOKEN_TTL, type ArtifactsClient, type ArtifactsCredentials } from './artifacts-repos';
import { aiMachines, validateAiInventory, visibleInventory, EMPTY_AI } from './ai';
import { Sessions, SESSION_SCHEMA, CLAIMABLE_TURN, type SessionHooks } from './sessions';
import { Tokens, TOKEN_SCHEMA, newToken, newRunToken } from './tokens';
import { Members, MEMBER_ACTIONS, MEMBER_MIGRATION } from './members';
import { Crew, CREW_SCHEMA, CrewProjects, CrewReview, crewCreated, crewScanDue, projectSlotsUsed, crewRelatedEntry, crewRelatedProjects, hasArtifactsCopy, type CrewCreatedPush, type CrewHooks, type CrewRelated } from './crew';
import { HostedGit, HOSTED_GIT_SCHEMA, GIT_HOST_LABEL, GIT_CLIENT_LABEL, GIT_INIT_LABEL, GIT_NEW_LABEL, hostEligible, hostingReason, validateHosting, validateHostReport, tipsDigest, newTicket, smithRemote, smithRemoteRepo, cloneUsername } from './git-host';
import { GitOps } from './git-workspace';
import { secretlessEnv, secretlessResolvedEnv } from './secretless';
import { Setups, SETUP_SCHEMA } from './setup';
import { DEFAULT_PROXY_MAX_BYTES, LFS_LABEL, LfsStore } from './lfs';
import { ArtifactsTokens, ARTIFACTS_TOKEN_SCHEMA, READ_CACHE_MS, WRITE_CACHE_MS } from './artifacts-tokens';
import { IMPORT_SCHEMA, IMPORT_LABEL, Imports, validateImportReport } from './imports';
import { LfsTasks, nodeFreeBytes } from './lfs-tasks';
import { lfsMode } from './r2-presign';
import { Pulls, PULL_SCHEMA, PULL_ACTIONS, PULL_READ_ACTIONS, PULL_JOB_KINDS, PULL_LABEL, validatePullResult } from './pulls';
import { DEFAULT_WORKSPACE_SETTINGS, WORKSPACE_SECRETS, parseWorkspaceSettings, validateWorkspaceSettings, workspaceJobEnv, type WorkspaceSecret, type WorkspaceSettings, integer, MAX_IMPORT_THRESHOLD_BYTES } from './settings';


// Labels a hosted agent advertises by itself: a machine without one runs an older Smith, and no person assigns them.
const AGENT_LABELS = new Set([REPO_LABEL, SYNC_LABEL, PULL_LABEL, GIT_HOST_LABEL, GIT_CLIENT_LABEL, GIT_INIT_LABEL, GIT_NEW_LABEL, IMPORT_LABEL]);
export type JobRow = { id: string; kind: string; request_id: string; specs: string; project_id: string; product: string; required_labels: string; serial: number; state: JobState; node_id: string | null; attempt_id: string | null; lease_token: string | null; lease_expires_at: number | null; result: string | null; created_at: number; updated_at: number; revision: number; secretless: number };
export type NodeRow = { id: string; token_hash: string; os: string; active: number; hostname: string; arch: string; labels: string; agent_version: string; last_seen_at: number; draining: number;
  owner_user_id: string | null; purpose: 'build' | 'personal'; ai: string; share_local_models: number; run_crew: number; crew_while_building: number; host_repos: number; hosting: string; host_lfs: number; assigned_labels: string; copy_budget_bytes: number | null };
export type LinkedNode = { id: string; tokenHash: string; os: string; hostname: string; arch: string; labels: string; agentVersion: string; ownerUserId: string; purpose: 'build' | 'personal'; ai: string };
type ArtifactRow = {job_id: string; attempt_id: string; name: string; sha256: string; size: number; object_key: string; ready: number};
const LEASE_MS = 90000;
// The branch a build checks out ('' for one without a repository), so a replaced queued build is only ever one of the same branch.
const jobBranch = (specs: Record<string, ResolvedJobSpec>): string => Object.values(specs)[0]?.repos?.[0]?.branch ?? '';
// Chat sessions are private to their owner, so any member may use them on their own machines.
const SESSION_ACTIONS = ['ai-sessions', 'ai-session', 'ai-session-create', 'ai-session-events', 'ai-session-message', 'ai-session-stop', 'ai-session-close', 'ai-session-update', 'ai-session-delete', 'ai-session-approve', 'ai-session-push'];
const NODE_SESSION_ACTIONS = ['ai-claim', 'ai-events', 'ai-finish'];
// Installing and signing in to a CLI on your own machine; the handlers check that it is yours.
const SETUP_ACTIONS = ['ai-setup-create', 'ai-setup-get', 'ai-setup-input', 'ai-setup-stop'];
// Managing your own agent tokens; any member may hold read-only ones.
const TOKEN_ACTIONS = ['tokens', 'token-create', 'token-revoke'];
// The crew acts for the whole workspace, so every member may watch it; managing it, running and stopping it need an operator.
const CREW_READ_ACTIONS = ['crew-checkins', 'crew-checkin-detail', 'crew-list', 'crew-runs', 'crew-prompt', 'crew-review', 'crew-messages', 'crew-run-session', 'crew-run-events'];
const CREW_ACTIONS = [...CREW_READ_ACTIONS, 'crew-checkin', 'crew-checkin-dry-run', 'crew-checkin-retry', 'crew-finding-decide', 'crew-finding-action', 'crew-put', 'crew-delete', 'crew-enable', 'crew-run', 'crew-run-stop', 'crew-decide', 'crew-verify', 'crew-message', 'crew-message-delete', 'crew-project-delete'];
// A crew run is a session: these watch and stop it as a workspace member rather than as its owner.
const CREW_SESSION_ACTIONS: Record<string, string> = { 'crew-run-session': 'ai-session', 'crew-run-events': 'ai-session-events', 'crew-run-stop': 'ai-session-stop' };
const CREW_SESSION_FIELDS: Record<string, string[]> = { 'crew-run-session': ['sessionId'], 'crew-run-events': ['sessionId', 'after'], 'crew-run-stop': ['sessionId'] };
// Repository tokens minted before a node's ai-claim/ai-finish transaction for the turn it will act on.
type AiRepoTokens = { turnId: string; token?: string; tokenId?: string; related?: CrewRelated[]; created?: CrewCreatedPush[] };

// What a job builds, for the dashboard: the branch, and the commit it checked out (a branch-tip
// build reports it on finishing) or was pinned to. Null commit = branch tip, not resolved yet.
function jobSource(job: JobRow): { branch: string; commit: string | null } | null {
  let repo: { branch?: unknown; commit?: unknown } | undefined;
  try { repo = (Object.values(JSON.parse(job.specs) as Record<string, { repos?: { branch?: unknown; commit?: unknown }[] }>)[0]?.repos ?? [])[0]; } catch { repo = undefined; }
  let reported: unknown;
  try { reported = job.result ? (JSON.parse(job.result) as JobResult).commit : undefined; } catch { reported = undefined; }
  const commit = typeof reported === 'string' && reported ? reported : typeof repo?.commit === 'string' && repo.commit ? repo.commit : null;
  if (!repo && !commit) return null;
  return { branch: typeof repo?.branch === 'string' ? repo.branch : '', commit };
}

export class WorkspaceCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, projection_due INTEGER);
      CREATE TABLE IF NOT EXISTS members (user_id TEXT PRIMARY KEY, role TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS enrollments (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, os TEXT NOT NULL, active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, specs TEXT NOT NULL, state TEXT NOT NULL,
        node_id TEXT, attempt_id TEXT, lease_token TEXT, lease_expires_at INTEGER, result TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS busy_node ON jobs(node_id) WHERE state IN ('leased', 'running');
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY, job_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, definition TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logs (job_id TEXT NOT NULL, attempt_id TEXT NOT NULL, seq INTEGER NOT NULL, stream TEXT NOT NULL, lines TEXT NOT NULL, byte_count INTEGER NOT NULL, PRIMARY KEY(job_id, attempt_id, seq));
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS artifacts (job_id TEXT NOT NULL, attempt_id TEXT NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, object_key TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(job_id, name));
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    this.ctx.storage.sql.exec(SESSION_SCHEMA);
    this.ctx.storage.sql.exec(TOKEN_SCHEMA);
    this.ctx.storage.sql.exec(SETUP_SCHEMA);
    this.ctx.storage.sql.exec(REPO_ACCESS_SCHEMA);
    this.ctx.storage.sql.exec(CREW_SCHEMA);
    this.ctx.storage.sql.exec(CHECKIN_SCHEMA);
    this.ctx.storage.sql.exec(HOSTED_GIT_SCHEMA);
    this.ctx.storage.sql.exec(PULL_SCHEMA);
    this.ctx.storage.sql.exec(ARTIFACTS_TOKEN_SCHEMA);
    this.ctx.storage.sql.exec(IMPORT_SCHEMA);
    // Additive migration from the deployed fixture schema; preserve all existing jobs and credentials.
    this.ctx.storage.transactionSync(() => {
      const version = this.sql.exec<{ version: number | null }>('SELECT MAX(version) AS version FROM schema_migrations').one().version ?? 0;
      if (version < 1) {
        this.sql.exec("ALTER TABLE jobs ADD COLUMN project_id TEXT NOT NULL DEFAULT 'smoke'");
        this.sql.exec("ALTER TABLE jobs ADD COLUMN product TEXT NOT NULL DEFAULT 'smoke'");
        this.sql.exec("ALTER TABLE jobs ADD COLUMN required_labels TEXT NOT NULL DEFAULT '[]'");
        this.sql.exec("ALTER TABLE nodes ADD COLUMN hostname TEXT NOT NULL DEFAULT ''");
        this.sql.exec("ALTER TABLE nodes ADD COLUMN arch TEXT NOT NULL DEFAULT ''");
        this.sql.exec("ALTER TABLE nodes ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'");
        this.sql.exec("ALTER TABLE nodes ADD COLUMN agent_version TEXT NOT NULL DEFAULT ''");
        this.sql.exec('ALTER TABLE nodes ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('INSERT INTO schema_migrations VALUES (1)');
      }
      if (version < 2) {
        this.sql.exec('ALTER TABLE nodes ADD COLUMN draining INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('INSERT INTO schema_migrations VALUES (2)');
      }
      if (version < 3) {
        // Machines belong to the person who enrolled them. Until now only the workspace owner
        // could enroll, so existing machines are theirs; outstanding codes stay unowned.
        this.sql.exec('ALTER TABLE nodes ADD COLUMN owner_user_id TEXT');
        this.sql.exec("ALTER TABLE nodes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'build'");
        this.sql.exec(`ALTER TABLE nodes ADD COLUMN ai TEXT NOT NULL DEFAULT '${JSON.stringify(EMPTY_AI)}'`);
        this.sql.exec('ALTER TABLE nodes ADD COLUMN share_local_models INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('ALTER TABLE enrollments ADD COLUMN user_id TEXT');
        this.sql.exec("ALTER TABLE enrollments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'build'");
        this.sql.exec("UPDATE nodes SET owner_user_id = (SELECT user_id FROM members WHERE role = 'owner' ORDER BY user_id LIMIT 1)");
        this.sql.exec('INSERT INTO schema_migrations VALUES (3)');
      }
      if (version < 4) {
        // Chats are kept like a chat app's history: renamed, pinned and archived. The earlier
        // "closed" state becomes "archived", which can be reopened by sending another message.
        this.sql.exec('ALTER TABLE ai_sessions ADD COLUMN archived_at INTEGER');
        this.sql.exec('ALTER TABLE ai_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('UPDATE ai_sessions SET archived_at = updated_at WHERE closed = 1');
        this.sql.exec('INSERT INTO schema_migrations VALUES (4)');
      }
      if (version < 5) {
        // Receipt time per log chunk so the dashboard can stamp output lines.
        this.sql.exec('ALTER TABLE logs ADD COLUMN received_at INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('INSERT INTO schema_migrations VALUES (5)');
      }
      if (version < 6) {
        // Job classes: 'build' (every job so far) and 'mirror' (copy a repo into Cloudflare Artifacts).
        this.sql.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'build'");
        this.sql.exec('INSERT INTO schema_migrations VALUES (6)');
      }
      if (version < 7) {
        // Tools you told Claude Code it may always use in a chat (ask mode's "don't ask again").
        this.sql.exec("ALTER TABLE ai_sessions ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT '[]'");
        this.sql.exec('INSERT INTO schema_migrations VALUES (7)');
      }
      if (version < 8) {
        // Chat turns that push the chat's branch (and maybe build it) rather than message the CLI.
        this.sql.exec("ALTER TABLE ai_turns ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'");
        this.sql.exec('ALTER TABLE ai_turns ADD COLUMN product TEXT');
        this.sql.exec('ALTER TABLE ai_turns ADD COLUMN job_id TEXT');
        this.sql.exec('INSERT INTO schema_migrations VALUES (8)');
      }
      if (version < 9) {
        // Whether a chat turn may use the API key set on its machine instead of the owner's CLI login.
        this.sql.exec('ALTER TABLE ai_turns ADD COLUMN use_api_key INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('INSERT INTO schema_migrations VALUES (9)');
      }
      if (version < 10) {
        // Autonomous crew: scheduled sessions (kind/crew_id/trigger/cost), jobs that never receive workspace
        // secrets, write tokens bound to one session, and per-machine crew opt-ins.
        this.sql.exec("ALTER TABLE ai_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
        this.sql.exec('ALTER TABLE ai_sessions ADD COLUMN crew_id TEXT');
        this.sql.exec('ALTER TABLE ai_sessions ADD COLUMN trigger TEXT');
        this.sql.exec('ALTER TABLE ai_sessions ADD COLUMN base_commit_actual TEXT');
        this.sql.exec('ALTER TABLE ai_sessions ADD COLUMN cost_usd REAL');
        this.sql.exec('ALTER TABLE jobs ADD COLUMN secretless INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('ALTER TABLE access_tokens ADD COLUMN session_id TEXT');
        this.sql.exec('ALTER TABLE nodes ADD COLUMN run_crew INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('ALTER TABLE nodes ADD COLUMN crew_while_building INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('INSERT INTO schema_migrations VALUES (10)');
      }
      if (version < 11) {
        // Crew scheduler: when a run started (runsPerDay) and what it cost (the daily spend), and the lifetime build count.
        this.sql.exec('ALTER TABLE crew_runs ADD COLUMN started_at INTEGER');
        this.sql.exec('ALTER TABLE crew_runs ADD COLUMN cost_usd REAL');
        this.sql.exec('CREATE TABLE crew_counters (id INTEGER PRIMARY KEY CHECK (id = 1), lifetime_builds INTEGER NOT NULL DEFAULT 0)');
        this.sql.exec('INSERT INTO crew_counters (id, lifetime_builds) VALUES (1, 0)');
        this.sql.exec('INSERT INTO schema_migrations VALUES (11)');
      }
      if (version < 12) {
        // Crew proposals: what Review shows of a run (kept past its session's retention), why one failed, when its branch
        // was pushed, and each Verify build a person started (buildsPerDay).
        for (const column of ['project_id TEXT', 'branch TEXT', 'head_commit TEXT', 'base_commit TEXT', 'cost_usd REAL', 'message TEXT', 'pushed_at INTEGER'])
          this.sql.exec(`ALTER TABLE crew_reports ADD COLUMN ${column}`);
        this.sql.exec('CREATE TABLE crew_verifies (job_id TEXT PRIMARY KEY, crew_id TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL)');
        this.sql.exec('CREATE INDEX crew_verifies_member ON crew_verifies(crew_id, created_at)');
        this.sql.exec('INSERT INTO schema_migrations VALUES (12)');
      }
      if (version < 13) {
        // Projects crew members create: the commit their push turn pushed and when, and the Artifacts account and repository
        // that hold them (kept on the row, so a failed project's token can still be revoked once its Smith project is gone).
        for (const column of ['head_commit TEXT', 'pushed_at INTEGER', 'account_id TEXT', 'repo TEXT']) this.sql.exec(`ALTER TABLE crew_projects ADD COLUMN ${column}`);
        this.sql.exec('INSERT INTO schema_migrations VALUES (13)');
      }
      if (version < 14) {
        // Crew: how many files a run changed and whether Smith had to cut their list (Verify refuses a cut one), and the
        // budget a run was promoted with (its claim holds it to that, whatever the member says since).
        this.sql.exec('ALTER TABLE crew_reports ADD COLUMN files_total INTEGER');
        this.sql.exec('ALTER TABLE crew_reports ADD COLUMN files_truncated INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('ALTER TABLE crew_runs ADD COLUMN budget TEXT');
        this.sql.exec('INSERT INTO schema_migrations VALUES (14)');
      }
      if (version < 15) {
        // Members: how each joined (Studio access or added) and when, and who was removed and must not rejoin (members.ts).
        for (const statement of MEMBER_MIGRATION) this.sql.exec(statement);
        this.sql.exec('INSERT INTO schema_migrations VALUES (15)');
      }
      if (version < 16) {
        // Smith-hosted repositories: the per-machine "Keep copies of repositories here" switch and the agent's report
        // of whether it can host (reason and free disk).
        this.sql.exec('ALTER TABLE nodes ADD COLUMN host_repos INTEGER NOT NULL DEFAULT 0');
        this.sql.exec("ALTER TABLE nodes ADD COLUMN hosting TEXT NOT NULL DEFAULT ''");
        this.sql.exec('INSERT INTO schema_migrations VALUES (16)');
      }
      if (version < 17) {
        // Check-in crew: a member's orchestration policy, and the event and snapshot a run was started for; one waiting run
        // per member for legacy wakes, and one per member and event for check-ins (crew-events.ts).
        this.sql.exec('ALTER TABLE crew_members ADD COLUMN orchestration TEXT');
        this.sql.exec('ALTER TABLE crew_runs ADD COLUMN event_id TEXT');
        this.sql.exec('ALTER TABLE crew_runs ADD COLUMN snapshot TEXT');
        this.sql.exec('DROP INDEX IF EXISTS crew_one_waiting');
        this.sql.exec("CREATE UNIQUE INDEX crew_one_waiting_legacy ON crew_runs(crew_id) WHERE state='waiting' AND event_id IS NULL");
        this.sql.exec("CREATE UNIQUE INDEX crew_one_waiting_event ON crew_runs(crew_id,event_id) WHERE state='waiting' AND event_id IS NOT NULL");
        this.sql.exec('INSERT INTO schema_migrations VALUES (17)');
      }
      if (version < 18) {
        // Chats push each reply by themselves; a chat its owner keeps on their computer only does not.
        this.sql.exec('ALTER TABLE ai_sessions ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('INSERT INTO schema_migrations VALUES (18)');
      }
      if (version < 19) {
        // A build of a product whose rule says serial (a deploy) is handed out only while no other build of that
        // product is leased or running, whatever the number of machines that could take it.
        this.sql.exec('ALTER TABLE jobs ADD COLUMN serial INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('INSERT INTO schema_migrations VALUES (19)');
      }
      if (version < 20) {
        // Labels an admin gives a machine from the dashboard (smith-deploy, say), kept beside what its agent advertises:
        // every heartbeat stores the union in labels, so claims and the waiting reasons match on both.
        this.sql.exec("ALTER TABLE nodes ADD COLUMN assigned_labels TEXT NOT NULL DEFAULT '[]'");
        this.sql.exec('INSERT INTO schema_migrations VALUES (20)');
      }
      if (version < 21) {
        // Large files: the per-machine "Keep large files here" switch (spec §8).
        this.sql.exec('ALTER TABLE nodes ADD COLUMN host_lfs INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('INSERT INTO schema_migrations VALUES (21)');
      }
      if (version < 22) {
        // Copies on machines share one budget per machine (copies.ts); NULL means the workspace default. The upgrade pass
        // that gives every existing project a home (home.ts) runs once, on the first alarm after deploy.
        this.sql.exec('ALTER TABLE nodes ADD COLUMN copy_budget_bytes INTEGER');
        this.sql.exec('ALTER TABLE meta ADD COLUMN homes_assigned INTEGER NOT NULL DEFAULT 0');
        // An Artifacts home whose tips are due a refresh before the daily one ('push' | 'copy' | '').
        this.sql.exec("ALTER TABLE git_repos ADD COLUMN tips_due TEXT NOT NULL DEFAULT ''");
        this.sql.exec('INSERT INTO schema_migrations VALUES (22)');
      }
    });
  }
  // Cloudflare Artifacts: the workspace's own account when Settings hold a token, else Smith's
  // backend account. `accountId` pins an existing copy to the account it was made in.
  private artifactsCredentials(accountId?: string): ArtifactsCredentials {
    return resolveArtifactsCredentials(this.env, { accountId: this.settings().cloudflareAccountId, apiToken: this.secrets().cloudflareApiToken ?? '' }, accountId);
  }
  private artifactsFor(accountId?: string): ArtifactsClient { return createArtifacts(this.env, this.artifactsCredentials(accountId)); }
  // Having credentials is not enough: the account behind them must have Artifacts. Asked of the API before
  // the dashboard reads settings and before a copy (in memory, so an evicted object simply asks again):
  // a yes is kept an hour, a no five minutes, and an unanswerable check retries after a minute.
  private artifactsCheck: { key: string; available: boolean; checkedAt: number; ttl: number } | null = null;
  private artifactsKey(credentials: ArtifactsCredentials): string {
    const updated = credentials.source === 'workspace' ? this.sql.exec<{ updated_at: number }>("SELECT updated_at FROM secrets WHERE name = 'cloudflareApiToken'").toArray()[0]?.updated_at ?? 0 : 0;
    return `${credentials.source}:${credentials.accountId}:${updated}`;
  }
  private async checkArtifacts(force = false): Promise<boolean> {
    const credentials = this.artifactsCredentials();
    if (credentials.source === 'none') return false;
    const key = this.artifactsKey(credentials); const cached = this.artifactsCheck?.key === key ? this.artifactsCheck : null; const now = Date.now();
    if (!force && cached && now - cached.checkedAt < cached.ttl) return cached.available;
    const answer = await createArtifacts(this.env, credentials).probe();
    const available = answer ?? cached?.available ?? false;
    this.artifactsCheck = { key, available, checkedAt: now, ttl: answer === null ? 60000 : answer ? 3600000 : 300000 };
    if (answer === false) console.warn(JSON.stringify({ event: 'artifacts_unavailable', source: credentials.source }));
    return available;
  }
  // The last answer, for synchronous callers; false until a check has said yes for the current credentials.
  private artifactsAvailable(): boolean {
    const credentials = this.artifactsCredentials();
    return credentials.source !== 'none' && this.artifactsCheck?.key === this.artifactsKey(credentials) && this.artifactsCheck.available;
  }
  private project(id: string): Project | undefined {
    const row = this.sql.exec<{ definition: string }>('SELECT definition FROM projects WHERE id = ?', id).toArray()[0];
    return row ? JSON.parse(row.definition) as Project : undefined;
  }
  private saveProject(project: Project | RepoProject): void { this.sql.exec('UPDATE projects SET definition = ? WHERE id = ?', JSON.stringify(project), project.id); }
  // Prepared projects and projects added from a Git URL share the table; `project()` keeps
  // returning the prepared shape for the Artifacts code, which never handles repo projects.
  private anyProject(id: string): Project | RepoProject | undefined {
    const row = this.sql.exec<{ definition: string }>('SELECT definition FROM projects WHERE id = ?', id).toArray()[0];
    return row ? JSON.parse(row.definition) as Project | RepoProject : undefined;
  }
  private get repoAccess() { return new RepoAccess(this.sql); }
  // Tests shorten the relay timeouts through the GIT_READY_TIMEOUT_MS / GIT_WAIT_MS bindings.
  private get hostedGit() { return new HostedGit(this.sql, this.workspaceId(), this.env.ORIGIN, Number((this.env as { GIT_READY_TIMEOUT_MS?: string }).GIT_READY_TIMEOUT_MS) || undefined); }
  private hostNodes(): NodeRow[] { return this.sql.exec<NodeRow>('SELECT * FROM nodes WHERE active = 1').toArray(); }
  private offlineMs(): number { return this.settings().nodeOfflineSeconds * 1000; }
  // Large files moving through the Worker are capped by the Workers request-body limit; LFS_PROXY_MAX_BYTES raises it on bigger plans.
  private proxyMaxBytes(): number { const raw = Number((this.env as { LFS_PROXY_MAX_BYTES?: string }).LFS_PROXY_MAX_BYTES); return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_PROXY_MAX_BYTES; }
  // Whether some switched-on machine can keep copies right now: the copy controls show (or explain) accordingly.
  private hostingAvailable(now: number): boolean { return this.hostNodes().some(n => hostEligible(n, now, this.offlineMs())); }
  private publicProject(project: Project | RepoProject, now: number) {
    const repo = project.hosted ? this.hostedGit.repo(project.hosted.repoId) : project.home === 'artifacts' ? this.hostedGit.repo(project.id) : undefined;
    // The copies row of the card (hosted) covers both homes: a storage home shows its record and the machines' copies too.
    const hosted = project.hosted ? { ...project.hosted, ...(repo ? this.gitOps.publicHosted(repo.id, now) : {}) }
      : project.home === 'artifacts' && repo && project.artifacts ? { repoId: repo.id, uuid: repo.uuid, status: 'ready' as const, sourceRepoUrl: project.artifacts.sourceRepoUrl, detachedFrom: project.artifacts.detachedFrom, sync: project.artifacts.sync, updatedAt: project.artifacts.updatedAt, ...this.gitOps.publicHosted(repo.id, now) } : undefined;
    // Large files the project keeps (Git LFS), for its card: usage, what is lost, and which machines hold copies.
    const store = new LfsStore(this.sql), readyCount = store.readyCount(project.id);
    const lfs = { ...store.usage(project.id), lost: store.lostCount(project.id), copies: store.copies(project.id).map(c => ({ hostname: this.sql.exec<{ hostname: string }>('SELECT hostname FROM nodes WHERE id = ?', c.node_id).toArray()[0]?.hostname ?? 'a machine', held: c.held, current: c.held === readyCount })) };
    // An import that rewrote history says so on the card (the original history is among hosted.backups.originals).
    const latestImport = new Imports(this.sql).rowsByProject(project.id)[0];
    const extra = { lfs, ...(latestImport?.state === 'done' && latestImport.rewritten ? { importNote: latestImport.message } : {}) };
    if (!isRepoProject(project)) return hosted ? { ...project, hosted, ...extra } : { ...project, ...extra };
    const job = project.scan.jobId ? this.sql.exec<JobRow>('SELECT * FROM jobs WHERE id = ?', project.scan.jobId).toArray()[0] : undefined;
    const host = job?.node_id ? this.sql.exec<{ hostname: string }>('SELECT hostname FROM nodes WHERE id = ?', job.node_id).toArray()[0]?.hostname ?? null : null;
    const shown = publicRepoProject(project, job ? { state: job.state, nodeHost: host, message: job.result ? (JSON.parse(job.result) as JobResult).message : '', waiting: this.waitingReason(job, now) } : null, this.repoAccess.denials(project.id, now));
    // replaceQueued: what applies (the project's own choice, else the workspace setting); replaceQueuedChosen: ticked here.
    const replace = { replaceQueued: project.replaceQueued ?? this.settings().supersedeQueued, replaceQueuedChosen: project.replaceQueued !== undefined };
    return hosted ? { ...shown, hosted, ...extra, ...replace } : { ...shown, ...extra, ...replace };
  }
  private get sql() { return this.ctx.storage.sql; }
  private workspaceId(): string { return this.sql.exec<{ id: string }>('SELECT id FROM meta').one().id; }
  private settings(): WorkspaceSettings {
    return parseWorkspaceSettings(this.sql.exec<{ value: string }>('SELECT value FROM settings WHERE id = 1').toArray()[0]?.value);
  }
  private secrets(): Partial<Record<WorkspaceSecret, string>> {
    const stored: Partial<Record<WorkspaceSecret, string>> = {};
    for (const row of this.sql.exec<{ name: string; value: string }>('SELECT name, value FROM secrets').toArray())
      if ((WORKSPACE_SECRETS as readonly string[]).includes(row.name)) stored[row.name as WorkspaceSecret] = row.value;
    return stored;
  }
  // What the dashboard sees: every setting, set/unset flags in place of secret values, and
  // the caller's own role so the form can lock itself for members who cannot edit.
  private publicSettings(userId: string) {
    const secrets = this.secrets();
    const flags = Object.fromEntries(WORKSPACE_SECRETS.map(name => [name + 'Set', Boolean(secrets[name])]));
    const updated = Object.fromEntries(this.sql.exec<{ name: string; updated_at: number }>('SELECT name, updated_at FROM secrets').toArray().map(row => [row.name + 'UpdatedAt', row.updated_at]));
    const role = this.sql.exec<{ role: string }>('SELECT role FROM members WHERE user_id = ?', userId).one().role;
    return { ...DEFAULT_WORKSPACE_SETTINGS, ...this.settings(), ...flags, ...updated, role, canEdit: ['owner', 'admin'].includes(role),
      studioDomain: (this.env.GOOGLE_ALLOWED_DOMAIN ?? '').trim().toLowerCase(), artifactsAvailable: this.artifactsAvailable(), artifactsSource: this.artifactsCredentials().source, copies: this.gitOps.underReplicated(Date.now()), lifetimeBuildsUsed: this.crew.lifetimeBuilds(),
      hostingAvailable: this.hostingAvailable(Date.now()), cloneUsername: cloneUsername(this.workspaceId()),
      lfs: { mode: lfsMode(this.env), proxyMaxBytes: this.proxyMaxBytes(), ...new LfsStore(this.sql).usage(), lost: new LfsStore(this.sql).lostCount(), checking: new LfsStore(this.sql).auditPending() } };
  }
  private requireHuman(userId: string, write = false, admin = false): void {
    const member = this.sql.exec<{ role: string }>('SELECT role FROM members WHERE user_id = ?', userId).toArray()[0];
    if (!member || (write && !['owner', 'admin', 'operator'].includes(member.role)) || (admin && !['owner', 'admin'].includes(member.role))) fail(403, 'forbidden', 'Workspace permission required');
  }
  async initialize(workspaceId: string, userId: string, name?: string): Promise<Response> {
    try {
      this.ctx.storage.transactionSync(() => {
        if (this.sql.exec('SELECT id FROM meta').toArray().length) { this.requireHuman(userId); return; }
        this.sql.exec('INSERT INTO meta (id) VALUES (?)', workspaceId);
        if (name) this.sql.exec('INSERT INTO settings (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', JSON.stringify({ ...this.settings(), name }));
        this.sql.exec("INSERT INTO members (user_id, role, via, joined_at) VALUES (?, 'owner', 'added', ?)", userId, Date.now());
      });
      return json({ workspaceId }, 201);
    } catch (error) { return errorResponse(error); }
  }
  // A machine belongs to the person who connected it, not to one workspace: it is enrolled in one
  // (its home) and the Worker mirrors it into every other workspace its owner is in (see linked-nodes.ts).
  // linkSource answers, in the home workspace, which active machine a credential is; linkNode adds that
  // machine here under the same ID and credential. A machine removed here stays removed: its row is kept
  // inactive, so a later heartbeat does not bring it back.
  async linkSource(credentialHash: string): Promise<LinkedNode | null> {
    const node = this.sql.exec<NodeRow>('SELECT * FROM nodes WHERE token_hash = ? AND active = 1', credentialHash).toArray()[0];
    return node?.owner_user_id ? { id: node.id, tokenHash: node.token_hash, os: node.os, hostname: node.hostname, arch: node.arch, labels: node.labels, agentVersion: node.agent_version, ownerUserId: node.owner_user_id, purpose: node.purpose, ai: node.ai } : null;
  }
  async linkNode(node: LinkedNode): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      if (!this.sql.exec('SELECT id FROM meta').toArray().length) return false;
      if (!this.sql.exec('SELECT user_id FROM members WHERE user_id = ?', node.ownerUserId).toArray().length) return false;
      if (this.sql.exec('SELECT id FROM nodes WHERE id = ? OR token_hash = ?', node.id, node.tokenHash).toArray().length) return true;
      if (this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM nodes').one().count >= 50) return false;
      this.sql.exec('INSERT INTO nodes (id, token_hash, os, active, hostname, arch, labels, agent_version, last_seen_at, owner_user_id, purpose, ai) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)',
        node.id, node.tokenHash, node.os, node.hostname, node.arch, node.labels, node.agentVersion, Date.now(), node.ownerUserId, node.purpose, node.ai);
      return true;
    });
  }
  private event(jobId: string): void {
    const job = this.job(jobId);
    const event = this.sql.exec<{ seq: number }>('INSERT INTO events (job_id, revision, state, at) VALUES (?, ?, ?, ?) RETURNING seq', job.id, job.revision, job.state, job.updated_at).one();
    this.sql.exec('INSERT INTO outbox VALUES (?, ?, ?, ?, ?)', event.seq, job.id, job.revision, job.state, job.updated_at);
    this.sql.exec('UPDATE meta SET projection_due = COALESCE(projection_due, ?)', Date.now() + 5000);
  }
  private job(id: string): JobRow {
    const row = this.sql.exec<JobRow>('SELECT * FROM jobs WHERE id = ?', id).toArray()[0];
    if (!row) fail(404, 'not_found', 'Job not found');
    return row;
  }
  // Why a queued job is still waiting, machine by machine, in the claim's own terms (action 'claim'), so the page names what
  // to fix instead of "waiting for a machine". `addLabels` is set where the only thing between a machine and the job is a
  // label a person gives it (Add label on the build page), not one its agent advertises by itself.
  private waitingMachines(job: JobRow, now: number): { nodeId: string; hostname: string; reason: string; addLabels?: string[] }[] {
    if (job.state !== 'queued') return [];
    const specs = JSON.parse(job.specs) as Record<string, unknown>, needed = JSON.parse(job.required_labels) as string[];
    return this.sql.exec<NodeRow>("SELECT * FROM nodes WHERE active = 1 AND purpose = 'build' ORDER BY hostname COLLATE NOCASE, id").toArray().map(n => {
      const name = n.hostname || 'A machine', entry = (reason: string, addLabels?: string[]) => ({ nodeId: n.id, hostname: name, reason, ...(addLabels ? { addLabels } : {}) });
      if (n.last_seen_at < now - this.offlineMs()) return entry(`${name} is offline`);
      if (n.draining) return entry(`${name} is updating`);
      const busy = this.sql.exec<{ product: string }>("SELECT product FROM jobs WHERE node_id = ? AND state IN ('leased', 'running') LIMIT 1", n.id).toArray()[0];
      if (busy) return entry(`${name} is busy (${busy.product})`);
      if (!specs[n.os]) return entry(`${name} runs ${n.os}, which this has no command for`);
      const labels = JSON.parse(n.labels) as string[], missing = needed.filter(l => !labels.includes(l));
      const outdated = missing.filter(l => AGENT_LABELS.has(l)), given = missing.filter(l => !AGENT_LABELS.has(l));
      if (job.kind === 'import' && (missing.includes('git-lfs') || missing.includes(IMPORT_LABEL))) return entry(`${name} needs git-lfs and an updated agent${missing.includes('git-lfs') ? ' (git-lfs is not installed there)' : ' (update it)'}`);
      if (outdated.length) return entry(`${name} runs an older Smith (no ${outdated.join(', ')}); it updates itself, or run SmithAgent.bat update on it`);
      if (given.length) return entry(`${name} lacks the label${given.length === 1 ? '' : 's'} ${given.join(', ')}`, given);
      if (job.kind === 'host' && !n.host_repos) return entry(`${name} does not keep copies of repositories`);
      if (job.serial && this.sql.exec("SELECT 1 FROM jobs WHERE project_id = ? AND product = ? AND state IN ('leased', 'running') LIMIT 1", job.project_id, job.product).toArray().length) return entry(`${name} waits: one ${job.product} build at a time`);
      const denied = this.sql.exec<{ message: string }>('SELECT message FROM repo_access WHERE project_id = ? AND node_id = ? AND at > ?', job.project_id, n.id, now - ACCESS_TTL_MS).toArray()[0];
      if (denied) return entry(`${name} could not read the repository (${denied.message}); Rescan lets it try again`);
      return entry(`${name} should take it on its next check`);
    });
  }
  private waitingReason(job: JobRow, now: number): string {
    if (job.state !== 'queued') return '';
    const machines = this.waitingMachines(job, now);
    return machines.length ? machines.map(m => m.reason).join(' · ') : 'No build machine is connected.';
  }
  private publicJob(job: JobRow) {
    return { id: job.id, kind: job.kind, ...(job.state === 'queued' ? { waiting: this.waitingReason(job, Date.now()), waitingMachines: this.waitingMachines(job, Date.now()) } : {}), projectId: job.project_id, product: job.product, state: job.state, nodeId: job.node_id, attemptId: job.attempt_id, secretless: Boolean(job.secretless),
      artifacts: job.state === 'success' ? this.sql.exec<ArtifactRow>('SELECT * FROM artifacts WHERE job_id = ? AND ready = 1 ORDER BY name', job.id).toArray().map(a => ({name:a.name, sha256:a.sha256, size:a.size})) : [],
      result: job.result ? JSON.parse(job.result) as JobResult : null, source: jobSource(job), createdAt: job.created_at, updatedAt: job.updated_at, revision: job.revision };
  }
  private expire(now: number): void {
    const expired = this.sql.exec<JobRow>("SELECT * FROM jobs WHERE state IN ('leased', 'running') AND lease_expires_at <= ?", now).toArray();
    for (const job of expired) {
      this.sql.exec("UPDATE jobs SET state = 'lost', revision = revision + 1, updated_at = ? WHERE id = ?", now, job.id);
      this.event(job.id);
      this.gitOps.settleJob(job, 'The machine stopped answering while copying', now);
    }
    for (const relay of this.hostedGit.expireRelays(now)) this.gitOps.wakeRelay(relay.id);
    this.hostedGit.pruneTickets(now);
    this.gitOps.reconcileGit(now);
    this.sql.exec('DELETE FROM enrollments WHERE expires_at <= ?', now);
    this.sessions.expire(now);
    this.setups.expire(now);
  }
  private get sessions() { return new Sessions(this.sql); }
  private get setups() { return new Setups(this.sql); }
  private get tokens() { return new Tokens(this.sql); }
  private get members() { return new Members(this.sql); }
  private get crew() { return new Crew(this.sql); }
  // Smith's pull requests (pulls.ts). Their diff, merge and publish jobs run on build machines whose agent runs them.
  private get pulls() {
    return new Pulls(this.sql, { origin: this.env.ORIGIN, project: id => this.anyProject(id), event: id => this.event(id),
      machineReady: () => this.sql.exec<{ labels: string }>("SELECT labels FROM nodes WHERE active = 1 AND purpose = 'build' AND draining = 0 AND last_seen_at > ?",
        Date.now() - this.settings().nodeOfflineSeconds * 1000).toArray().some(n => (JSON.parse(n.labels) as string[]).includes(PULL_LABEL)),
      jobQuotaLeft: () => this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM jobs').one().count < 1000 });
  }
  // Crew scheduling beside anything else (a build completion, a heartbeat, a finish, a settings save, the alarm's lease expiry)
  // runs in a nested transaction of its own: a crew failure is logged and rolled back alone, and never costs the rest its
  // commit. The crew's own paths throw.
  private crewQuietly(event: string, step: () => void): void {
    try { this.ctx.storage.transactionSync(step); }
    catch (error) { console.error(JSON.stringify({ event, message: error instanceof Error ? error.message : String(error) })); }
  }
  private promoteQuietly(now: number, finished?: JobRow): void {
    this.crewQuietly('crew_promote_failed', () => { if (finished) { this.crew.onJobFinished(finished, now, this.settings()); if (this.settings().orchestration.enabled) new CrewEvents(this.sql).failedBuild(finished, this.allProjects(), now); } this.crew.promote(now, this.crewHooks()); });
  }
  private crewHooks(): CrewHooks { return { settings: this.settings(), secrets: this.secrets(), sessions: this.sessions, projects: () => this.allProjects(), automation: projectId => projectAutomation(this.settings().orchestration, projectId), origin: this.env.ORIGIN }; }
  private allProjects(): (Project | RepoProject)[] { return this.sql.exec<{ definition: string }>('SELECT definition FROM projects ORDER BY id').toArray().map(p => JSON.parse(p.definition) as Project | RepoProject); }
  private role(userId: string): string { return this.sql.exec<{ role: string }>('SELECT role FROM members WHERE user_id = ?', userId).one().role; }
  private schedule(): Promise<void> {
    const lease = this.sql.exec<{ due: number | null }>("SELECT MIN(lease_expires_at) AS due FROM jobs WHERE state IN ('leased', 'running')").one().due;
    const projection = this.sql.exec<{ projection_due: number | null }>('SELECT projection_due FROM meta').toArray()[0]?.projection_due;
    const due = Math.min(lease ?? Infinity, projection ?? Infinity, this.sessions.nextLeaseExpiry() ?? Infinity, this.setups.nextLeaseExpiry() ?? Infinity, this.crew.nextDue(this.settings()) ?? Infinity, this.gitOps.nextDue(Date.now()) ?? Infinity, this.crew.orchestration.nextDue() ?? Infinity);
    return Number.isFinite(due) ? this.ctx.storage.setAlarm(Math.max(Date.now() + 1, due)) : this.ctx.storage.deleteAlarm();
  }
  // Tests drive the large-file sweep the alarm runs.
  saveProjectForTest(project: unknown): void { const p = project as Project; this.ctx.storage.transactionSync(() => this.sql.exec('INSERT INTO projects VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET definition = excluded.definition', p.id, JSON.stringify(p))); }
  async assignHomesForTest(): Promise<number> { return (await this.gitOps.assignHomes()).assigned; }
  async reconcileArtifactsHomesForTest(): Promise<void> { await this.gitOps.reconcileArtifactsHomes(true); }
  async reconcileImportsForTest(): Promise<void> { await this.gitOps.reconcileImports(); }
  advanceImportClockForTest(ms: number): void { this.sql.exec('UPDATE import_repos SET next_attempt_at = next_attempt_at - ?', ms); }
  async sweepLfsForTest(now: number): Promise<void> { await this.gitOps.sweepLfs(now); }
  async alarm(): Promise<void> {
    await this.prepareCheckIns();
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.expire(now);
      this.crewQuietly('crew_alarm_failed', () => { const hooks = this.crewHooks(); this.crew.enqueueDue(now, hooks.settings); this.crew.promote(now, hooks); this.crew.retention(now); });
    });
    await this.gitOps.sweepLfs(Date.now());
    await this.reconcileMirrors();
    await this.reconcileSyncs();
    const crewRetry = [await this.reconcileCrew(), await this.reconcilePulls(), await this.gitOps.reconcileArtifactsHomes(), await this.gitOps.reconcileImports()].some(Boolean);
    // One pass after deploy: every project gets a home (home.ts). After the crew's own settlement, which may be mid-flight.
    // It runs again while any project is still without one (Artifacts could not be reached for it): the flag is set only when none is left.
    if (!this.sql.exec<{ n: number }>('SELECT homes_assigned AS n FROM meta').one().n) { const pass = await this.gitOps.assignHomes(); if (pass.remaining === 0) this.sql.exec('UPDATE meta SET homes_assigned = 1'); }
    try {
      const events = this.sql.exec<{ seq: number; job_id: string; revision: number; state: string; at: number }>('SELECT * FROM outbox ORDER BY seq LIMIT 100').toArray();
      for (const event of events) {
        await this.env.DB.prepare(`INSERT INTO job_history VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, job_id) DO UPDATE SET revision = excluded.revision, state = excluded.state, updated_at = excluded.updated_at
          WHERE excluded.revision > job_history.revision`).bind(this.workspaceId(), event.job_id, event.revision, event.state, event.at).run();
        this.sql.exec('DELETE FROM outbox WHERE seq = ?', event.seq);
      }
    } catch { console.error(JSON.stringify({ event: 'projection_retry' })); }
    finally {
      const pending = this.sql.exec('SELECT seq FROM outbox LIMIT 1').toArray().length > 0;
      this.sql.exec('UPDATE meta SET projection_due = ?', pending ? Date.now() + 5000 : crewRetry ? Date.now() + 15000 : null);
      await this.schedule();
    }
  }
  // Signature verification is performed here as RPC methods are callable independently of HTTP routing.
  async checkInWebhook(projectId:string,eventName:string,deliveryId:string,signature:string,raw:string):Promise<Response> {
    try {
      if (new TextEncoder().encode(raw).length > 256*1024) fail(413,'too_large','Webhook exceeds 256 KiB');
      const secret=this.secrets().checkInWebhookSecret;
      if(!secret || !await verifyCheckInWebhook(raw,signature,secret)) fail(401,'signature','Invalid webhook signature');
      const project=this.anyProject(projectId) ?? fail(404,'not_found','Project not found');
      let payload:unknown;try{payload=JSON.parse(raw);}catch{fail(400,'invalid_json','Invalid webhook JSON');}
      const normalized=normalizeGitHubCheckIn(eventName,payload,deliveryId,project.repoUrl);
      if(!normalized)return json({ignored:true});
      const {source,...event}=normalized;
      const response=this.ctx.storage.transactionSync(()=>this.crew.events.accept({projectId,...event},this.allProjects(),Date.now(),source));
      await this.schedule();return response;
    }catch(error){return errorResponse(error);}
  }
  private async prepareCheckIns():Promise<void> {
    // A provider read may have been interrupted by eviction. Its persisted deadline makes that
    // attempt recoverable without trusting any response that arrives after a retry has started.
    this.sql.exec("UPDATE crew_checkins SET state='blocked',reason='Metadata read interrupted or timed out; retry',next_at=NULL WHERE state='loading' AND job_id IS NULL AND COALESCE(next_at,updated_at+60000)<=?", Date.now());
    const due=this.sql.exec<StoredCheckIn>("SELECT * FROM crew_checkins WHERE state='pending' AND next_at<=? ORDER BY created_at LIMIT 4",Date.now()).toArray();
    for(const event of due){
      // One event that cannot be prepared is blocked on its own; it must never abort the alarm that schedules the rest.
      try{
      const project=this.anyProject(event.project_id);
      if(!project || event.repo_key!==repositoryKey(project.repoUrl)){
        this.sql.exec("UPDATE crew_checkins SET state='blocked',reason='Project no longer exists',next_at=NULL WHERE id=?",event.id);continue;
      }
      // Mark in flight before awaiting: concurrent alarm/retry cannot schedule the same metadata job twice.
      const startedAt=Date.now(), attempt=event.attempts+1;
      this.sql.exec("UPDATE crew_checkins SET state='loading',attempts=attempts+1,job_id=NULL,next_at=?,updated_at=?,reason='Reading change metadata' WHERE id=? AND state='pending'",startedAt+60000,startedAt,event.id);
      await this.schedule();
      let metadata:CheckInMetadata|null=null;
      const token=this.secrets().githubToken;
      if(token){try{metadata=await readCheckInMetadata(project.repoUrl,event.base_commit,event.head_commit,token);}catch{/* native fallback */}}
      const currentAttempt=()=>{const current=this.crew.events.get(event.id);return current.state==='loading'&&current.attempts===attempt&&current.job_id===null;};
      if(!currentAttempt())continue;
      if(metadata?.complete&&metadata.ancestor){this.ctx.storage.transactionSync(()=>this.crew.events.ready(event.id,metadata!,Date.now()));continue;}
      let readToken='';
      if(hasArtifactsCopy(project)){try{readToken=(await this.repoToken(project,false))?.plaintext ?? ''; if(!readToken) throw new Error('No repository token');}catch{this.sql.exec("UPDATE crew_checkins SET state='blocked',reason='Cannot obtain a repository read token; retry after fixing access',next_at=NULL WHERE id=?",event.id);continue;}}
      this.ctx.storage.transactionSync(()=>{
        if(!currentAttempt())return;
        if(this.sql.exec<{n:number}>('SELECT COUNT(*) n FROM jobs').one().n>=1000){this.sql.exec("UPDATE crew_checkins SET state='blocked',reason='Smith job limit reached',next_at=NULL WHERE id=?",event.id);return;}
        const id=crypto.randomUUID(),now=Date.now();
        const specs:Record<string,ResolvedJobSpec>={};
        for(const os of ['windows','linux','mac'])specs[os]={...smokeSpec(id,os),kind:'checkin',projectId:project.id,
          repos:[{name:project.id,url:project.repoUrl,branch:event.branch,commit:event.head_commit,checkoutDir:'.',authToken:readToken}],
          command:{interpreter:'',script:'',args:[]},steps:[],timeoutSeconds:60,checkIn:{eventId:event.id,baseCommit:event.base_commit,headCommit:event.head_commit}};
        this.sql.exec("INSERT INTO jobs(id,kind,request_id,specs,project_id,product,required_labels,state,created_at,updated_at,revision,secretless) VALUES(?,'checkin',?,?,?,?,?,'queued',?,?,1,1)",id,`checkin-${event.id}-${attempt}`,JSON.stringify(specs),project.id,'checkin-metadata',JSON.stringify(['checkin-metadata-v1']),now,now);
        this.sql.exec("UPDATE crew_checkins SET job_id=?,next_at=NULL,reason='Waiting for a machine with checkin-metadata-v1' WHERE id=?",id,event.id);this.event(id);
      });
      }catch(error){
        this.sql.exec("UPDATE crew_checkins SET state='blocked',reason=?,next_at=NULL WHERE id=? AND state IN ('pending','loading')",`Could not prepare the check-in: ${error instanceof Error?error.message:String(error)}`.slice(0,300),event.id);
      }
    }
    // A lost metadata attempt remains visible; retry is explicit and never trusts a late completion.
    this.sql.exec("UPDATE crew_checkins SET state='blocked',reason='Metadata job failed or lost; retry after checking the machine',next_at=NULL WHERE state='loading' AND job_id IN (SELECT id FROM jobs WHERE state IN ('failed','error','cancelled','lost'))");
  }
  async execute(principal: Principal, action: string, body: Record<string, unknown>): Promise<Response> {
    try {
      // An agent's token acts as its owner for the actions its scopes allow; their role still applies below.
      // A run token also carries the session it belongs to, which `summary` reports back to the caller.
      let tokenContext: { scopes: string[]; sessionId: string | null } | undefined;
      if (principal.kind === 'token') {
        const tokenHash = await hash(principal.token);
        const resolved = this.ctx.storage.transactionSync(() => this.tokens.resolve(tokenHash, action, Date.now()));
        principal = { kind: 'human', userId: resolved.userId };
        tokenContext = { scopes: resolved.scopes, sessionId: resolved.sessionId };
      }
      const created = action === 'token-create' ? newToken(this.workspaceId()) : '';
      const createdHash = created ? await hash(created) : '';
      // Hash before entering the transaction; current membership/node state is checked inside it.
      const credentialHash = principal.kind === 'node' ? await hash(principal.token) : '';
      const code = action === 'enrollments' ? randomToken() : '';
      const enrollmentHash = action === 'enroll' ? await hash(string(body, 'code', 200)) : code ? await hash(code) : '';
      const nodeId = crypto.randomUUID();
      const token = action === 'enroll' ? `smn.${nodeId}.${randomToken()}` : '';
      const nodeHash = token ? await hash(token) : '';
      // External (Artifacts) calls happen before the transaction, never inside it.
      if (principal.kind === 'human' && action === 'crew-tool-create-project') return await this.crewCreateProject(principal.userId, tokenContext?.sessionId ?? null, body);
      if (principal.kind === 'human' && action === 'settings') await this.checkArtifacts();
      // Studio access: the Worker asks only for a person who signed in with a Google account of the allowed domain.
      if (principal.kind === 'human' && action === 'studio-join') { const userId = principal.userId; return json(this.ctx.storage.transactionSync(() => this.members.studioJoin(userId, this.settings().studioAccess, Date.now()))); }
      if (principal.kind === 'human' && action === 'mirror-project') return await this.mirrorProject(principal.userId, body);
      if (principal.kind === 'human' && action === 'sync-project') return await this.syncProject(principal.userId, body);
      if (principal.kind === 'human' && action === 'link-project') return this.linkProject(principal.userId, body);
      if (principal.kind === 'human' && action === 'add-repo-project' && body.source === 'new') { const created = this.gitOps.newProject(principal.userId, body, () => projectSlotsUsed(this.sql)); await this.schedule(); return created; }
      if (principal.kind === 'human' && action === 'add-repo-project') return await this.addRepoProject(principal.userId, body);
      if (principal.kind === 'human' && action === 'rescan-project') return await this.rescanProject(principal.userId, body);
      if (principal.kind === 'human' && action === 'push-builds') return await this.pushBuilds(principal.userId, body);
      if (principal.kind === 'human' && action === 'remove-project') return await this.removeProject(principal.userId, body);
      if (principal.kind === 'human' && action === 'edit-project') return await this.editProject(principal.userId, body);
      if (principal.kind === 'human' && action === 'push-choose') return this.pushChoose(principal.userId, body);
      if (principal.kind === 'human' && action === 'replace-queued') return this.replaceQueuedChoose(principal.userId, body);
      if (principal.kind === 'hook') return action === 'push-delivery' ? await this.pushDelivery(body) : fail(404, 'not_found', 'Route not found');
      if (principal.kind === 'human' && (action === 'github-repos' || action === 'github-branches' || action === 'import-orgs' || action === 'import-repos')) return await this.githubPicker(principal.userId, action, body);
      const readToken = principal.kind === 'human' && action === 'enqueue' ? await this.readTokenFor(body) : principal.kind === 'human' && action === 'crew-verify' ? await this.crewVerifyToken(principal.userId, body) : '';
      // Reading pull requests first opens those crew proposals are due and queues due diffs, so the page shows them at once.
      if (principal.kind === 'human' && (action === 'pulls' || action === 'pull')) await this.reconcilePulls();
      // A merge gets a write token of Smith's copy and a publish a read token, minted (after the checks) before the transaction.
      const pullToken = principal.kind === 'human' && (action === 'pull-merge' || action === 'pull-publish') ? await this.pullToken(principal.userId, action, body) : undefined;
      const aiRepoToken = principal.kind === 'node' && (action === 'ai-claim' || action === 'ai-finish') ? await this.aiRepoToken(credentialHash, action, body) : undefined;
      // A crew run's token is minted at its claim, so its clock starts with the CLI. Cheap, so every claim prepares one;
      // it is stored only if the turn handed out belongs to a crew run.
      const runPlain = principal.kind === 'node' && action === 'ai-claim' ? newRunToken(this.workspaceId()) : '';
      const runToken = runPlain ? { token: runPlain, hash: await hash(runPlain) } : undefined;
      // A claim may hand out a build of a Smith-hosted repository: its ticket is prepared here and stored only if used.
      const claimPlain = principal.kind === 'node' && action === 'claim' ? newTicket(this.workspaceId()) : '';
      const claimTicket = claimPlain ? { token: claimPlain, hash: await hash(claimPlain) } : undefined;
      // A host job's completion carries the refs the machine now holds; their digest is the record's.
      const hostReport = action === 'complete' && body.result && typeof body.result === 'object' ? (body.result as { host?: unknown }).host : undefined;
      const hostDigest = hostReport ? await tipsDigest(validateHostReport(hostReport).tips) : '';
      if (principal.kind === 'human' && action === 'host-project') return await this.gitOps.hostProject(principal.userId, body);
      // A project started in Smith (empty, or from a zip the Worker stored); the Worker asks first whether one may start.
      if (principal.kind === 'human' && action === 'add-smith-project') return await this.gitOps.addSmithProject(principal.userId, body);
      if (principal.kind === 'human' && action === 'move-to-storage') return await this.gitOps.moveToStorage(principal.userId, body);
      if (principal.kind === 'human' && action === 'backup-download') return this.gitOps.backupDownload(principal.userId, body);
      if (principal.kind === 'human' && action === 'import-start') return await this.gitOps.startImport(principal.userId, body);
      if (principal.kind === 'human' && action === 'import-retry') return await this.gitOps.retryImport(principal.userId, body);
      if (principal.kind === 'human' && action === 'import-cancel') return await this.gitOps.cancelImport(principal.userId, body);
      if (principal.kind === 'human' && (action === 'imports' || action === 'import-get')) { this.requireHuman(principal.userId); return action === 'imports' ? this.gitOps.listImports() : this.gitOps.getImport(body); }
      if (principal.kind === 'human' && action === 'restore-to-storage') return await this.gitOps.restoreToStorage(principal.userId, body);
      if (principal.kind === 'human' && action === 'smith-project-check') { this.requireHuman(principal.userId, true, true); return json(await this.gitOps.checkCanStart(Date.now())); }
      if (action.startsWith('git-') || action.startsWith('lfs-')) return await this.gitOps.gitAction(principal, action, body, credentialHash);
      let finishedMirror = false; let finishedImport = false;
      let left: string[] = [];   // people who stopped being members: dropped from D1's directory below
      let studioChanged = false; let renamed = false;
      const response = this.ctx.storage.transactionSync(() => {
        const now = Date.now();
        let node: NodeRow | undefined;
        // A crew run's own tools: only a run token (which carries its session) reaches them. They ask for the read level alone,
        // so a run whose owner was demoted can still file its report, while one whose owner left the workspace cannot.
        if (principal.kind === 'human' && action.startsWith('crew-tool-')) {
          this.requireHuman(principal.userId);
          return tokenContext?.sessionId ? this.crew.tool(tokenContext.sessionId, action, body, now, this.crewHooks()) : fail(403, 'forbidden', 'Only a crew run can use the crew tools');
        }
        // Enrollment, revocation, model sharing and crew opt-in are also open to a machine's own owner; their
        // handlers apply the narrower ownership checks.
        if (principal.kind === 'human') this.requireHuman(principal.userId, !['list', 'get', 'projects', 'nodes', 'read-logs', 'summary', 'settings', 'artifact-read', 'ai-options', 'ai-share', 'node-crew', 'ai-guest-stop', 'enrollments', 'revoke', 'git-clone-info', 'git-advertise', 'git-ls-refs', 'imports', 'import-get', ...MEMBER_ACTIONS, ...SESSION_ACTIONS, ...SETUP_ACTIONS, ...TOKEN_ACTIONS, ...CREW_READ_ACTIONS, ...PULL_READ_ACTIONS, 'pull-comment'].includes(action), ['put-project', 'put-settings', 'drain', 'node-labels', 'mirror-project', 'node-host', 'git-restore', 'git-accept-dataloss', 'git-recovered'].includes(action));
        else if (principal.kind === 'node') {
          node = this.sql.exec<NodeRow>('SELECT * FROM nodes WHERE token_hash = ? AND active = 1', credentialHash).toArray()[0];
          if (!node) fail(401, 'invalid_node', 'Node credential invalid or revoked');
          this.sql.exec('UPDATE nodes SET last_seen_at = ? WHERE id = ?', now, node.id);
        } else if (action !== 'enroll') fail(401, 'unauthenticated', 'Authentication required');
        // Member actions check the caller's role themselves: anyone may list members or leave.
        if (principal.kind === 'human' && MEMBER_ACTIONS.includes(action)) { const result = this.members.execute(principal.userId, action, body, now); left = result.left; return result.response; }
        if (principal.kind === 'human' && TOKEN_ACTIONS.includes(action)) {
          return this.tokens.execute(principal.userId, ['owner', 'admin', 'operator'].includes(this.role(principal.userId)), action, body, now, { token: created, hash: createdHash });
        }
        const hooks: SessionHooks = { repoToken: aiRepoToken, roleOf: userId => this.role(userId), enqueueVerify: (projectId, product, branch, commit, requestId, token) => this.enqueueBuild(projectId, product, requestId, Date.now(), token, { branch, commit }),
          // The tokens minted before the transaction belong to the turn they were minted for; any other turn goes without.
          crew: { refusal: (session, turn) => this.crew.claimRefusal(session, turn, now, this.settings(), this.secrets()),
            claim: (session, turn) => this.crew.claim(session, turn, now, { ...this.crewHooks(), runToken,
            ...(aiRepoToken?.turnId === turn.id ? { related: aiRepoToken.related, writeTokenId: aiRepoToken.tokenId, created: aiRepoToken.created } : {}) }),
          finish: (session, turn, result, at) => this.crew.finish(session, turn, result, at, this.sessions), pushed: (session, turn, result, at) => this.crew.pushed(session, turn, result, at, this.sessions),
          ended: at => this.promoteQuietly(at) } };
        if (principal.kind === 'human' && SESSION_ACTIONS.includes(action)) {
          return this.sessions.execute({ kind: 'human', userId: principal.userId }, action, body, now, { ...hooks, canBuild: ['owner', 'admin', 'operator'].includes(this.role(principal.userId)) });
        }
        if (principal.kind === 'human' && CREW_ACTIONS.includes(action)) {
          const sessionAction = CREW_SESSION_ACTIONS[action];
          if (sessionAction) { fields(body, CREW_SESSION_FIELDS[action]); return this.sessions.execute({ kind: 'member', userId: principal.userId }, sessionAction, body, now, hooks); }
          // Review's Verify queues a pinned (so secretless) build with the read token minted before the transaction.
          return this.crew.execute(principal.userId, this.role(principal.userId), action, body, now, { ...this.crewHooks(),
            enqueueVerify: (projectId, product, branch, commit, requestId, timeoutMinutes) => this.enqueueBuild(projectId, product, requestId, now, readToken, { branch, commit, timeoutMinutes }) });
        }
        if (principal.kind === 'human' && SETUP_ACTIONS.includes(action)) return this.setups.execute(principal.userId, action, body, now);
        if (principal.kind === 'human' && PULL_ACTIONS.includes(action)) {
          const { authorName, authorEmail, ...rest } = body;   // the merger's name and address come from the identity database (index.ts)
          return this.pulls.execute({ userId: principal.userId, role: this.role(principal.userId) }, action, rest, now,
            { token: pullToken?.plaintext, tokenId: pullToken?.id, jobId: pullToken?.jobId, author: { name: typeof authorName === 'string' ? authorName : '', email: typeof authorEmail === 'string' ? authorEmail : '' } });
        }
        if (node && action === 'ai-setup-events') return this.setups.events(node.id, body, now);
        if (node && NODE_SESSION_ACTIONS.includes(action)) {
          this.sessions.expire(now);
          const machine = node;
          return this.sessions.execute({ kind: 'node', node }, action, body, now, { ...hooks, claimSetup: () => this.setups.claim(machine.id, now) });
        }
        if (action === 'enroll') {
          fields(body, ['code', 'protocolVersion', 'os', 'hostname', 'arch', 'labels', 'agentVersion', 'ai']);
          if (body.protocolVersion !== 2) fail(426, 'unsupported_version', 'Hosted coordinator requires protocolVersion 2');
          const os = string(body, 'os');
          if (!['windows', 'linux', 'mac'].includes(os)) fail(400, 'invalid_os', 'Unsupported node OS');
          const enrollment = this.sql.exec<{ expires_at: number; user_id: string | null; purpose: string }>('SELECT expires_at, user_id, purpose FROM enrollments WHERE hash = ?', enrollmentHash).toArray()[0];
          if (!enrollment || enrollment.expires_at <= now) fail(401, 'invalid_enrollment', 'Enrollment code invalid or expired');
          if (this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM nodes').one().count >= 50) fail(429, 'quota', 'Experiment node quota reached');
          this.sql.exec('DELETE FROM enrollments WHERE hash = ?', enrollmentHash);
          const labels = strings(body.labels ?? [], 'labels');
          const hostname = body.hostname === undefined ? 'Smith agent' : string(body, 'hostname', 128);
          const arch = body.arch === undefined ? '' : string(body, 'arch', 32);
          const agentVersion = body.agentVersion === undefined ? '' : string(body, 'agentVersion', 32);
          const ai = body.ai === undefined ? EMPTY_AI : validateAiInventory(body.ai);
          this.sql.exec('INSERT INTO nodes (id, token_hash, os, active, hostname, arch, labels, agent_version, last_seen_at, owner_user_id, purpose, ai) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)', nodeId, nodeHash, os, hostname, arch, JSON.stringify(labels), agentVersion, now, enrollment.user_id, enrollment.purpose, JSON.stringify(ai));
          return json({ nodeId, token, protocolVersion: 2 }, 201);
        }
        if (principal.kind === 'human') {
          if (action === 'artifact-read') {
            const job = this.job(string(body, 'jobId'));
            if (job.state !== 'success') fail(409, 'candidate_unavailable', 'Artifacts are available only after successful completion');
            const artifact = this.sql.exec<ArtifactRow>('SELECT * FROM artifacts WHERE job_id = ? AND name = ? AND ready = 1', job.id, string(body, 'name')).toArray()[0];
            if (!artifact) fail(404, 'not_found', 'Artifact not found');
            return json(artifact);
          }
          if (action === 'summary') return json({ id: this.workspaceId(), name: this.settings().name, ...(tokenContext ? { tokenScopes: tokenContext.scopes, sessionId: tokenContext.sessionId } : {}) });
          if (action === 'settings') return json(this.publicSettings(principal.userId));
          if (action === 'put-settings') {
            // Secrets never round-trip: a blank token keeps the stored one, clear<Name> removes it.
            const update = validateWorkspaceSettings(body, this.settings());
            if (this.settings().crewStopped && !update.settings.crewStopped) this.crew.resumeSchedules(now);   // missed windows run once, not skipped
            studioChanged = update.settings.studioAccess !== this.settings().studioAccess;
            renamed = update.settings.name !== this.settings().name;
            this.sql.exec('INSERT INTO settings (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', JSON.stringify(update.settings));
            if (studioChanged) left = this.members.applyStudioAccess(update.settings.studioAccess);
            for (const [name, value] of Object.entries(update.secrets)) {
              if (value === null) this.sql.exec('DELETE FROM secrets WHERE name = ?', name);
              else if (value) this.sql.exec('INSERT INTO secrets VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', name, value, now);
            }
            // Stop all crew applies at once, whatever the scheduler does next; turning it off (or a new key) starts what waits.
            if (update.settings.crewStopped) this.crewQuietly('crew_stop_failed', () => { this.crew.stopAll(now, this.sessions); this.cancelAutomaticCrewVerifies(now); });
            this.promoteQuietly(now);
            return json(this.publicSettings(principal.userId));
          }
          if (action === 'projects') return json({ projects: this.allProjects().map(p => this.publicProject(p, now)) });
          if (action === 'put-project') {
            const project = validateProject(body, this.env.ORIGIN);
            const previous = this.project(project.id);
            if (!previous && projectSlotsUsed(this.sql) >= 20) fail(429, 'quota', 'Experiment project quota reached');
            if (previous?.artifacts && ['pushing', 'verifying'].includes(previous.artifacts.status)) fail(409, 'artifacts_pending', 'Smith is still copying this project; edit it once the copy finishes');
            if (previous?.hosted?.status === 'copying') fail(409, 'hosted_pending', 'Smith is still copying this project; edit it once the copy finishes');
            // The Artifacts and hosted records are server-owned and survive edits; an edit that points the
            // project elsewhere than its copy simply stops building from the copy.
            if (previous?.artifacts) project.artifacts = previous.artifacts;
            if (previous?.hosted) project.hosted = previous.hosted;
            if (previous?.home) project.home = previous.home;
            // Likewise a crew-created project stays one across human edits (its builds stay secretless);
            // whoever wants a trusted project deletes it and adds it again.
            if (previous && crewCreated(previous)) { project.createdBy = previous.createdBy; if (previous.purpose !== undefined) project.purpose = previous.purpose; }
            this.sql.exec('INSERT INTO projects VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET definition = excluded.definition', project.id, JSON.stringify(project));
            return json(project, 201);
          }
          if (action === 'nodes') {
            // By name, never by last_seen_at: every heartbeat would reshuffle the list under the person's mouse.
            const userId = principal.userId; const plan = this.gitOps.dryPlan(now);
            return json({ nodes: this.sql.exec<NodeRow>('SELECT * FROM nodes WHERE active = 1 ORDER BY hostname COLLATE NOCASE, id').toArray().map(n => ({ id: n.id, hostname: n.hostname, os: n.os, arch: n.arch, labels: JSON.parse(n.labels) as string[], assignedLabels: JSON.parse(n.assigned_labels) as string[], agentVersion: n.agent_version, active: Boolean(n.active), draining: Boolean(n.draining), activeJobId: this.sql.exec<{id:string}>("SELECT id FROM jobs WHERE node_id = ? AND state IN ('leased','running')",n.id).toArray()[0]?.id ?? null, lastSeenAt: n.last_seen_at,
              purpose: n.purpose, ownedByYou: n.owner_user_id === userId, shareLocalModels: Boolean(n.share_local_models), runCrew: Boolean(n.run_crew), crewWhileBuilding: Boolean(n.crew_while_building), ai: visibleInventory(userId, n),
              copyBudgetBytes: n.copy_budget_bytes, copyBudgetEffective: this.gitOps.nodeBudget(n), copyUsageBytes: this.gitOps.nodeUsage(n.id), copiesFull: plan.full[n.id] ?? '', freeBytes: nodeFreeBytes(n), lfs: new LfsStore(this.sql).heldBy(n.id),
              hostRepos: Boolean(n.host_repos), hostingReason: hostingReason(n, n.hosting ? JSON.parse(n.hosting) as { able: boolean; reason: string } : null), hostsOnline: hostEligible(n, now, this.offlineMs()),
              hosted: this.hostedGit.heldBy(n.id).map(h => ({ repoId: h.repo.id, primary: h.repo.primary_node_id === n.id, state: h.replica.state, bytes: h.replica.bytes })),
              ...(n.owner_user_id === userId ? { guestChats: this.sessions.guestChats(n.id, userId) } : {}) })) });
          }
          if (action === 'ai-options') {
            fields(body, []);
            this.setups.expire(now);
            return json({ machines: aiMachines(principal.userId, this.sql.exec<NodeRow>('SELECT * FROM nodes WHERE active = 1').toArray(), now, this.setups.latest(principal.userId, now)) });
          }
          if (action === 'ai-share') {
            fields(body, ['nodeId', 'share']);
            if (typeof body.share !== 'boolean') fail(400, 'invalid_field', 'share must be a boolean');
            const nodeId = string(body, 'nodeId');
            // Only the person whose machine it is may offer its models to others; admins cannot.
            if (!this.sql.exec('SELECT id FROM nodes WHERE id = ? AND active = 1 AND owner_user_id = ?', nodeId, principal.userId).toArray().length) fail(404, 'not_found', 'You have no active machine with that ID');
            this.sql.exec('UPDATE nodes SET share_local_models = ? WHERE id = ?', body.share ? 1 : 0, nodeId);
            return json({ nodeId, shareLocalModels: body.share });
          }
          if (action === 'node-crew') {
            fields(body, ['nodeId', 'run', 'whileBuilding']);
            if (typeof body.run !== 'boolean' || (body.whileBuilding !== undefined && typeof body.whileBuilding !== 'boolean')) fail(400, 'invalid_field', 'run and whileBuilding must be booleans');
            const nodeId = string(body, 'nodeId');
            // Unattended crew work uses the owner's machine, login and electricity, so only the owner opts it in; admins cannot.
            if (!this.sql.exec('SELECT id FROM nodes WHERE id = ? AND active = 1 AND owner_user_id = ?', nodeId, principal.userId).toArray().length) fail(404, 'not_found', 'You have no active machine with that ID');
            this.sql.exec('UPDATE nodes SET run_crew = ?, crew_while_building = ? WHERE id = ?', body.run ? 1 : 0, body.whileBuilding === true ? 1 : 0, nodeId);
            if (!body.run) this.crew.releaseNode(nodeId, now, this.sessions);   // its queued crew runs wait for another machine
            return json({ nodeId, runCrew: body.run, crewWhileBuilding: body.whileBuilding === true });
          }
          if (action === 'node-host') {
            // "Keep copies here": an owner or admin switches a build machine on (or off) for this workspace's repositories and
            // large files alike, and may set its budget (null: the workspace default).
            fields(body, ['nodeId', 'host', 'budgetBytes']);
            if (typeof body.host !== 'boolean') fail(400, 'invalid_field', 'host must be a boolean');
            const budget = body.budgetBytes;
            if (budget !== undefined && budget !== null && (!Number.isSafeInteger(budget) || Number(budget) < 1073741824 || Number(budget) > 10995116277760)) fail(400, 'invalid_field', 'budgetBytes must be 1 GB to 10 TB, or null for the workspace default');
            const nodeId = string(body, 'nodeId');
            const target = this.sql.exec<NodeRow>('SELECT * FROM nodes WHERE id = ? AND active = 1', nodeId).toArray()[0];
            if (!target) fail(404, 'not_found', 'Active node not found');
            if (body.host && target.purpose !== 'build') fail(409, 'personal_machine', 'Personal machines do not keep copies');
            this.sql.exec('UPDATE nodes SET host_repos = ?, host_lfs = ? WHERE id = ?', body.host ? 1 : 0, body.host ? 1 : 0, nodeId);
            if (budget !== undefined) this.sql.exec('UPDATE nodes SET copy_budget_bytes = ? WHERE id = ?', budget === null ? null : Number(budget), nodeId);
            if (!body.host) this.gitOps.hostSwitchedOff(target, now);
            else this.gitOps.reconcileGit(now);   // copies for the newly switched-on machine, or a changed budget
            const saved = this.sql.exec<NodeRow>('SELECT * FROM nodes WHERE id = ?', nodeId).one();
            return json({ nodeId, hostRepos: body.host, copyBudgetBytes: saved.copy_budget_bytes });
          }
          if (action === 'check-lfs') {
            // Check large files: owners and admins ask for every ready object to be checked against R2 (the sweep does it in batches).
            fields(body, []); this.requireHuman(principal.userId, true, true);
            return json({ queued: new LfsStore(this.sql).queueAudit() });
          }
          if (action === 'ai-guest-stop') {
            // A machine's owner stops another member's chat that is using its shared models.
            fields(body, ['nodeId', 'sessionId']);
            const nodeId = string(body, 'nodeId');
            if (!this.sql.exec('SELECT id FROM nodes WHERE id = ? AND owner_user_id = ?', nodeId, principal.userId).toArray().length) fail(404, 'not_found', 'You have no machine with that ID');
            return this.sessions.stopGuestChat(nodeId, string(body, 'sessionId', 64), now);
          }
          if (action === 'drain') {
            fields(body, ['nodeId', 'draining']);
            if (typeof body.draining !== 'boolean') fail(400, 'invalid_field', 'draining must be a boolean');
            const nodeId = string(body, 'nodeId');
            if (!this.sql.exec('SELECT id FROM nodes WHERE id = ? AND active = 1', nodeId).toArray().length) fail(404, 'not_found', 'Active node not found');
            this.sql.exec('UPDATE nodes SET draining = ? WHERE id = ?',body.draining ? 1 : 0,nodeId);
            return json({nodeId,draining:body.draining});
          }
          if (action === 'node-labels') {
            // An owner or admin gives a build machine labels its agent does not advertise (smith-deploy: this machine may
            // deploy), from the dashboard instead of restarting the agent with --labels. They take effect at once.
            fields(body, ['nodeId', 'labels']);
            const nodeId = string(body, 'nodeId'), assigned = [...new Set(strings(body.labels, 'labels', 32).map(l => l.trim()))];
            if (assigned.some(l => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(l))) fail(400, 'invalid_field', 'A label is letters, digits, dot, dash and underscore');
            const agentLabel = assigned.find(l => AGENT_LABELS.has(l));
            if (agentLabel) fail(400, 'invalid_field', `${agentLabel} is advertised by the agent itself; update the agent instead`);
            const target = this.sql.exec<NodeRow>("SELECT * FROM nodes WHERE id = ? AND active = 1", nodeId).toArray()[0];
            if (!target) fail(404, 'not_found', 'Active node not found');
            if (target.purpose !== 'build') fail(409, 'personal_machine', 'Personal machines do not take builds');
            // Drop the old assignments, keep what the agent advertised (its next heartbeat restores any it also advertises).
            const previous = new Set(JSON.parse(target.assigned_labels) as string[]);
            const labels = [...new Set([...(JSON.parse(target.labels) as string[]).filter(l => !previous.has(l)), ...assigned])];
            this.sql.exec('UPDATE nodes SET assigned_labels = ?, labels = ? WHERE id = ?', JSON.stringify(assigned), JSON.stringify(labels), nodeId);
            return json({ nodeId, labels, assignedLabels: assigned });
          }
          if (action === 'read-logs') {
            const job = this.job(string(body, 'jobId'));
            const after = body.after ?? -1;
            if (!Number.isSafeInteger(after) || Number(after) < -1) fail(400, 'invalid_cursor', 'Invalid log cursor');
            // `tail` returns the most recent chunks instead, which is where build errors usually are.
            if (body.tail !== undefined && body.tail !== true) fail(400, 'invalid_field', 'tail must be true when present');
            const chunks = body.tail
              ? this.sql.exec<{ seq: number; stream: string; lines: string; received_at: number }>('SELECT seq, stream, lines, received_at FROM logs WHERE job_id = ? ORDER BY seq DESC LIMIT 100', job.id).toArray().reverse()
              : this.sql.exec<{ seq: number; stream: string; lines: string; received_at: number }>('SELECT seq, stream, lines, received_at FROM logs WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT 100', job.id, Number(after)).toArray();
            return json({ chunks: chunks.map(c => ({ seq: c.seq, stream: c.stream, lines: JSON.parse(c.lines) as string[], at: c.received_at || null })), nextSeq: chunks.length ? chunks[chunks.length - 1].seq + 1 : Number(after) + 1 });
          }
          if (action === 'cancel') {
            const job = this.job(string(body, 'jobId'));
            if (['queued', 'leased', 'running'].includes(job.state)) {
              this.sql.exec("UPDATE jobs SET state = 'cancelled', updated_at = ?, revision = revision + 1 WHERE id = ?", now, job.id); this.event(job.id);
              if (job.kind === 'mirror') finishedMirror = true; if (job.kind === 'import') finishedImport = true;
              this.gitOps.settleJob(job, 'The copy was cancelled', now);
            }
            return json(this.publicJob(this.job(job.id)));
          }
          if (action === 'enrollments') {
            // A build machine runs workspace jobs, so only admins add one. Any member may connect a
            // personal machine: it never claims builds and is used only by its owner (and, if they
            // choose, for shared local models).
            fields(body, ['purpose']);
            const purpose = body.purpose ?? 'build';
            if (purpose !== 'build' && purpose !== 'personal') fail(400, 'invalid_field', 'purpose must be build or personal');
            if (purpose === 'build') this.requireHuman(principal.userId, true, true);
            if (this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM nodes').one().count >= 50) fail(429, 'quota', 'Experiment node quota reached');
            this.sql.exec('DELETE FROM enrollments WHERE expires_at <= ?', now);
            if (this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM enrollments').one().count >= 20) fail(429, 'quota', 'Experiment enrollment quota reached');
            if (purpose === 'personal' && this.sql.exec<{ count: number }>("SELECT (SELECT COUNT(*) FROM nodes WHERE owner_user_id = ? AND active = 1 AND purpose = 'personal') + (SELECT COUNT(*) FROM enrollments WHERE user_id = ? AND purpose = 'personal') AS count", principal.userId, principal.userId).one().count >= 5) fail(429, 'quota', 'You can connect at most five personal machines');
            this.sql.exec('INSERT INTO enrollments (hash, expires_at, user_id, purpose) VALUES (?, ?, ?, ?)', enrollmentHash, now + 600000, principal.userId, purpose);
            return json({ code, expiresAt: now + 600000, purpose }, 201);
          }
          if (action === 'enqueue') {
            fields(body, ['requestId', 'projectId', 'product']);
            const requestId = string(body, 'requestId');
            const projectId = string(body, 'projectId');
            const product = body.product === undefined && projectId === 'smoke' ? 'smoke' : string(body, 'product');
            const existing = this.sql.exec<JobRow>('SELECT * FROM jobs WHERE request_id = ?', requestId).toArray()[0];
            if (existing) {
              if (existing.project_id !== projectId || existing.product !== product) fail(409, 'conflicting_request', 'Request ID already identifies a different build');
              return json(this.publicJob(existing), 201);
            }
            const { id } = this.enqueueBuild(projectId, product, requestId, now, readToken);
            return json(this.publicJob(this.job(id)), 201);
          }
          if (action === 'list') return json({ jobs: this.sql.exec<JobRow>('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100').toArray().map(job => this.publicJob(job)) });
          if (action === 'get') return json(this.publicJob(this.job(string(body, 'jobId'))));
          if (action === 'revoke') {
            const id = string(body, 'nodeId');
            const target = this.sql.exec<{ owner_user_id: string | null }>('SELECT owner_user_id FROM nodes WHERE id = ?', id).toArray()[0];
            if (!target || target.owner_user_id !== principal.userId) this.requireHuman(principal.userId, true, true);
            this.sql.exec('UPDATE nodes SET active = 0 WHERE id = ?', id);
            for (const job of this.sql.exec<JobRow>("SELECT * FROM jobs WHERE node_id = ? AND state IN ('leased', 'running')", id).toArray()) {
              this.sql.exec("UPDATE jobs SET state = 'lost', revision = revision + 1, updated_at = ? WHERE id = ?", now, job.id); this.event(job.id);
              if (job.kind === 'mirror') finishedMirror = true; if (job.kind === 'import') finishedImport = true;
              this.gitOps.settleJob(job, 'The machine was removed while copying', now);
            }
            if (target) this.gitOps.hostSwitchedOff({ ...target, id } as NodeRow, now);
            return json({ revoked: true });
          }
        }
        if (node) {
          // A host job creating a project from a zip downloads it through the Worker, which asks here for the R2 key.
          if (action === 'host-import') {
            fields(body, ['jobId', 'attemptId', 'leaseToken']);
            return json(this.gitOps.importGrant(this.job(string(body, 'jobId')), node, { attemptId: string(body, 'attemptId'), leaseToken: string(body, 'leaseToken', 200) }, now));
          }
          if (action === 'artifact-start' || action === 'artifact-finish') {
            fields(body, ['jobId', 'attemptId', 'leaseToken', 'nodeId', 'leaseExpiresAt', 'name', 'sha256', 'size']);
            const job = this.job(string(body, 'jobId'));
            if (job.node_id !== node.id || job.attempt_id !== string(body, 'attemptId') || job.lease_token !== string(body, 'leaseToken', 200) || !['leased', 'running'].includes(job.state) || job.lease_expires_at! <= now) fail(409, 'stale_attempt', 'Attempt is not current');
            const name = string(body, 'name'); const sha256 = string(body, 'sha256', 64); const size = Number(body.size);
            if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(body.size) || size < 1 || size > 20 * 1024 * 1024) fail(400, 'invalid_artifact', 'Invalid artifact name, digest or size');
            const spec = (JSON.parse(job.specs) as Record<string, ResolvedJobSpec>)[node.os];
            if (!spec.artifacts.globs.some(path => path.split('/').at(-1) === name)) fail(400, 'undeclared_artifact', 'Output file was not declared by this build');
            let artifact = this.sql.exec<ArtifactRow>('SELECT * FROM artifacts WHERE job_id = ? AND name = ?', job.id, name).toArray()[0];
            if (artifact && (artifact.attempt_id !== job.attempt_id || artifact.sha256 !== sha256 || artifact.size !== size)) fail(409, 'conflicting_artifact', 'Artifact name already identifies different bytes');
            if (!artifact) {
              if (action === 'artifact-finish') fail(409, 'upload_missing', 'Upload must be reserved first');
              const total = this.sql.exec<{bytes:number | null}>('SELECT SUM(size) AS bytes FROM artifacts').one().bytes ?? 0;
              if (total + size > 256 * 1024 * 1024) fail(429, 'artifact_quota', 'Workspace artifact storage quota reached');
              this.sql.exec('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, 0)', job.id, job.attempt_id, name, sha256, size, `artifacts/${this.workspaceId()}/${job.id}/${crypto.randomUUID()}/${name}`);
              artifact = this.sql.exec<ArtifactRow>('SELECT * FROM artifacts WHERE job_id = ? AND name = ?', job.id, name).one();
            }
            if (action === 'artifact-finish') this.sql.exec('UPDATE artifacts SET ready = 1 WHERE job_id = ? AND name = ?', job.id, name);
            return json(artifact);
          }
          if (action === 'agent-package') { fields(body, []); return json({ os: node.os }); }
          if (action === 'heartbeat') {
            fields(body, ['hostname', 'os', 'arch', 'labels', 'agentVersion', 'ai', 'hosting']);
            if (body.os !== undefined && body.os !== node.os) fail(400, 'invalid_os', 'Node OS cannot change after enrollment');
            const labels = [...new Set([...strings(body.labels ?? JSON.parse(node.labels), 'labels'), ...JSON.parse(node.assigned_labels) as string[]])];
            const ai = body.ai === undefined ? node.ai : JSON.stringify(validateAiInventory(body.ai));
            const hosting = body.hosting === undefined ? node.hosting : JSON.stringify(validateHosting(body.hosting));
            this.sql.exec('UPDATE nodes SET hostname = ?, arch = ?, labels = ?, agent_version = ?, ai = ?, hosting = ?, last_seen_at = ? WHERE id = ?', body.hostname === undefined ? node.hostname : string(body, 'hostname'), body.arch === undefined ? node.arch : string(body, 'arch', 32), JSON.stringify(labels), body.agentVersion === undefined ? node.agent_version : string(body, 'agentVersion', 32), ai, hosting, now, node.id);
            if (node.run_crew) this.promoteQuietly(now);   // a crew machine back online (or updated) may take a waiting run
            // A machine that keeps copies polls for git work only while it is switched on for hosting.
            return json({ accepted: true, gitHost: this.gitOps.gitWanted(node, labels) });
          }
          if (action === 'claim') {
            fields(body, []); this.expire(now);
            let job = this.sql.exec<JobRow>("SELECT * FROM jobs WHERE node_id = ? AND state IN ('leased', 'running')", node.id).toArray()[0];
            if (!job) {
              if (node.draining || node.purpose === 'personal') return json({hasJob:false} satisfies HostedAssignment);
              // A host job (copy a repository here) also needs the machine switched on for hosting in this workspace.
              job = this.sql.exec<JobRow>(`SELECT * FROM jobs WHERE state = 'queued' AND json_type(specs, ?) IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM json_each(required_labels) needed WHERE NOT EXISTS (SELECT 1 FROM json_each(?) available WHERE available.value = needed.value))
                AND NOT (kind = 'host' AND ? = 0)
                AND NOT (serial = 1 AND EXISTS (SELECT 1 FROM jobs running WHERE running.project_id = jobs.project_id AND running.product = jobs.product AND running.state IN ('leased', 'running')))
                ${ACCESS_FILTER}
                ORDER BY created_at, id LIMIT 1`, '$.' + node.os, node.labels, node.host_repos, node.id, now - ACCESS_TTL_MS).toArray()[0];
              if (!job) return json({ hasJob: false } satisfies HostedAssignment);
              this.sql.exec("UPDATE jobs SET state = 'leased', node_id = ?, attempt_id = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", node.id, crypto.randomUUID(), randomToken(), now + LEASE_MS, now, job.id);
              this.event(job.id); job = this.job(job.id);
            }
            // Workspace credentials join the frozen spec only on the way out, so the stored
            // job never holds a secret and a rotated token reaches builds still queued.
            const spec = (JSON.parse(job.specs) as Record<string, ResolvedJobSpec>)[node.os];
            // A secretless job (Verify of a model-authored branch, crew-created project) gets blanks instead.
            spec.env = job.kind === 'checkin' ? {} : job.secretless ? secretlessEnv(this.settings().cloudflareAccountId) : { ...workspaceJobEnv(this.settings(), this.secrets()), ...spec.env };
            // A Smith-hosted source: this machine's own current copy when it has one, else a ticket bound to it and this job.
            if (spec.repos[0]) { this.gitOps.attachHostedSource(spec, job, node, claimTicket, now); this.gitOps.attachLfsSource(spec, job, node, claimTicket, now); }
            this.gitOps.attachImportTicket(spec, job, node, claimTicket, now);
            return json({ hasJob: true, envelope: { protocolVersion: 2, workspaceId: this.workspaceId(),
              lease: { jobId: job.id, attemptId: job.attempt_id!, leaseToken: job.lease_token!, leaseExpiresAt: job.lease_expires_at!, nodeId: node.id },
              spec } } satisfies HostedAssignment);
          }
          if (action === 'resolve') {
            // A branch-tip build is checked out: map smith.json at that commit to the command to run,
            // freeze it into the job (artifact checks read it), and refresh the project's actions.
            fields(body, ['jobId', 'attemptId', 'leaseToken', 'leaseExpiresAt', 'nodeId', 'report']);
            const job = this.job(string(body, 'jobId'));
            if (job.node_id !== node.id || job.attempt_id !== string(body, 'attemptId') || job.lease_token !== string(body, 'leaseToken', 200) || !['leased', 'running'].includes(job.state) || job.lease_expires_at! <= now) fail(409, 'stale_attempt', 'Attempt is not current');
            const specs = JSON.parse(job.specs) as Record<string, ResolvedJobSpec>;
            const project = this.anyProject(job.project_id);
            if (!specs[node.os]?.resolve || !isRepoProject(project)) fail(409, 'not_resolvable', 'This job has no build action to resolve');
            const scan = validateScanReport(body.report);
            // Rules always match the project's branch. A chat's Verify build pins another commit (its
            // chat branch) and is resolved "as if" on the project's branch, but never refreshes it.
            const branch = project.branch || scan.branch;
            const pinned = Boolean(specs[node.os].repos[0]?.commit);
            if (!pinned) this.saveProject(applyReport(project, scan, 'machine', node.hostname, now));
            let resolved: ResolvedJobSpec;
            try { resolved = resolveBuildSpec(specs[node.os], scan, branch, node.os); }
            catch (error) {
              if (!(error instanceof PipelineError)) throw error;
              // Answer rather than throw, so the project refresh above commits with this transaction.
              return json({ error: { code: 'action_missing', message: error.message + (pinned ? '' : '; the project was rescanned') } }, 422);
            }
            if (job.request_id.startsWith('crew-verify-') && JSON.parse(job.required_labels).includes('crew-verify-isolated'))
              resolved.timeoutSeconds = Math.min(resolved.timeoutSeconds, specs[node.os].timeoutSeconds);
            specs[node.os] = resolved;
            this.sql.exec('UPDATE jobs SET specs = ?, updated_at = ? WHERE id = ?', JSON.stringify(specs), now, job.id);
            // The agent replaces its spec with this one, so a secretless job (a Verify of a model-authored branch) gets its
            // claim's blanks again rather than the workspace credentials.
            return json({ spec: { ...resolved, env: job.secretless ? secretlessResolvedEnv(this.settings().cloudflareAccountId, resolved.env)
              : { ...workspaceJobEnv(this.settings(), this.secrets()), ...resolved.env } } });
          }
          if (action === 'renew' || action === 'complete' || action === 'logs') {
            // Lease envelopes may be echoed intact by a client; reject all other fields.
            fields(body, ['jobId', 'attemptId', 'leaseToken', 'leaseExpiresAt', 'nodeId', ...(action === 'complete' ? ['result'] : []), ...(action === 'logs' ? ['seq', 'stream', 'lines'] : [])]);
            const job = this.job(string(body, 'jobId'));
            if (job.node_id !== node.id || job.attempt_id !== string(body, 'attemptId') || job.lease_token !== string(body, 'leaseToken', 200)) fail(409, 'stale_attempt', 'Attempt is not current');
            let result: JobResult | undefined;
            let scanReport: ScanReport | undefined;
            let checkInReport: Record<string,unknown> | undefined;
            let scanProblem = '';
            if (action === 'complete') {
              const input = object(body.result); fields(input, ['status', 'exitCode', 'durationMs', 'message', 'commit', 'failure', 'scan', 'host', 'checkIn', 'pull', 'import']);
              if (!['success', 'failed', 'error'].includes(String(input.status)) || !Number.isSafeInteger(input.exitCode) || !Number.isSafeInteger(input.durationMs) || Number(input.durationMs) < 0 || typeof input.message !== 'string' || input.message.length > 4096) fail(400, 'invalid_result', 'Invalid job result');
              if (input.commit !== undefined && (typeof input.commit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.commit))) fail(400, 'invalid_result', 'Invalid job result');
              if (input.failure !== undefined && input.failure !== 'repo_access' && input.failure !== 'oversize') fail(400, 'invalid_result', 'Invalid job result');
              // An import's report: validated here so the job holds a usable one; a bad report is accepted with its reason (see scan).
              let importReport: ImportReport | undefined; let importProblem = '';
              if (input.import !== undefined && job.kind === 'import') { try { importReport = validateImportReport(input.import); } catch (error) { if (!(error instanceof HttpError)) throw error; importProblem = error.message; } }
              // A report Smith cannot use (an unsupported branch name, an over-long path) is the
              // repository's doing: accept the completion and say why on the project. A 400 here
              // would make the agent resend the same saved result forever.
              if (input.checkIn !== undefined) { if(job.kind!=='checkin') fail(400,'invalid_result','Unexpected check-in report'); checkInReport=object(input.checkIn); }
              if (input.scan !== undefined) {
                try { scanReport = validateScanReport(input.scan); }
                catch (error) { if (!(error instanceof HttpError)) throw error; scanProblem = error.message; }
              }
              result = { status: input.status as JobResult['status'], exitCode: Number(input.exitCode), durationMs: Number(input.durationMs), message: importProblem ? `Smith could not use what the machine reported: ${importProblem}` : input.message,
                ...(checkInReport ? {checkIn:checkInReport} : {}), ...(typeof input.commit === 'string' ? { commit: input.commit } : {}), ...(input.failure === 'repo_access' ? { failure: 'repo_access' as const } : input.failure === 'oversize' ? { failure: 'oversize' as const } : {}),
                ...(importReport ? { import: importReport } : {}),
                ...(input.host !== undefined ? { host: validateHostReport(input.host) } : {}),
                ...(input.pull !== undefined && (PULL_JOB_KINDS as readonly string[]).includes(job.kind) ? { pull: validatePullResult(input.pull) } : {}) };
              if (job.result) {
                if (job.result !== JSON.stringify(result)) fail(409, 'conflicting_result', 'Result differs from accepted completion');
                return json({ accepted: true, jobId: job.id });
              }
            }
            if (!['leased', 'running'].includes(job.state) || job.lease_expires_at! <= now) fail(409, 'stale_attempt', 'Lease is expired or no longer active');
            if (action === 'logs') {
              if (!Number.isSafeInteger(body.seq) || Number(body.seq) < 0 || !['stdout', 'stderr'].includes(String(body.stream)) || !Array.isArray(body.lines) || body.lines.length > 100 || body.lines.some(line => typeof line !== 'string')) fail(400, 'invalid_log', 'Invalid log chunk');
              const lines = JSON.stringify(body.lines); const bytes = new TextEncoder().encode(lines).byteLength;
              if (bytes > 16384) fail(413, 'log_chunk_too_large', 'Log chunks may contain at most 16 KiB');
              const previous = this.sql.exec<{ lines: string; stream: string }>('SELECT lines, stream FROM logs WHERE job_id = ? AND attempt_id = ? AND seq = ?', job.id, job.attempt_id, Number(body.seq)).toArray()[0];
              if (previous) {
                if (previous.lines !== lines || previous.stream !== body.stream) fail(409, 'conflicting_log', 'Log sequence was already accepted with different content');
                return json({ accepted: true, nextSeq: Number(body.seq) + 1 });
              }
              const totals = this.sql.exec<{ max_seq: number | null; bytes: number | null }>('SELECT MAX(seq) AS max_seq, SUM(byte_count) AS bytes FROM logs WHERE job_id = ? AND attempt_id = ?', job.id, job.attempt_id).one();
              if (Number(body.seq) !== (totals.max_seq ?? -1) + 1) fail(409, 'log_sequence', 'Log sequence must be contiguous');
              if ((totals.bytes ?? 0) + bytes > 4 * 1024 * 1024) fail(413, 'log_limit', 'Build log limit reached');
              this.sql.exec('INSERT INTO logs (job_id, attempt_id, seq, stream, lines, byte_count, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)', job.id, job.attempt_id, Number(body.seq), String(body.stream), lines, bytes, now);
              return json({ accepted: true, nextSeq: Number(body.seq) + 1 });
            }
            if (result) {
              // Only repository-project work (scans, branch-tip builds) waits for another machine;
              // a prepared or mirror job that cannot clone fails as before.
              const repoJob = job.kind === 'scan' || job.kind === 'checkin' || job.kind === 'host' || Boolean((JSON.parse(job.specs) as Record<string, ResolvedJobSpec>)[node.os]?.resolve);
              if (result.failure === 'repo_access' && repoJob) {
                // This machine's Git login cannot read the repository: remember that, and give the
                // job back to the queue for a machine that can (claims skip this node for an hour).
                // The failed attempt's output goes too, so the next machine's log is not mixed in.
                this.repoAccess.deny(job.project_id, node.id, result.message, now);
                this.sql.exec('DELETE FROM logs WHERE job_id = ? AND attempt_id = ?', job.id, job.attempt_id);
                this.sql.exec("UPDATE jobs SET state = 'queued', node_id = NULL, attempt_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?", now, job.id); this.event(job.id);
                return json({ accepted: true, jobId: job.id, requeued: true });
              }
              if (result.status === 'success') {
                const expected = (JSON.parse(job.specs) as Record<string, ResolvedJobSpec>)[node.os].artifacts.globs;
                for (const path of expected) if (!this.sql.exec('SELECT name FROM artifacts WHERE job_id = ? AND attempt_id = ? AND name = ? AND ready = 1', job.id, job.attempt_id, path.split('/').at(-1)!).toArray().length) fail(409, 'artifacts_missing', 'Declared outputs must upload before successful completion');
              }
              this.sql.exec('UPDATE jobs SET state = ?, result = ?, updated_at = ?, revision = revision + 1 WHERE id = ?', result.status, JSON.stringify(result), now, job.id); this.event(job.id);
              if (job.kind === 'mirror') finishedMirror = true; if (job.kind === 'import') finishedImport = true;
              if(job.kind==='checkin') {
                const event=this.sql.exec<StoredCheckIn>('SELECT * FROM crew_checkins WHERE job_id=?',job.id).toArray()[0];
                if(event && event.state==='loading') {
                  try {
                    if(result.status!=='success'||!checkInReport||checkInReport.eventId!==event.id||checkInReport.baseCommit!==event.base_commit||checkInReport.headCommit!==event.head_commit) fail(400,'invalid_metadata','Metadata job did not return the pinned range');
                    const changes=checkInReport.changes;
                    if(!Array.isArray(changes))fail(400,'invalid_metadata','Missing changes');
                    this.crew.events.ready(event.id,{...checkInReport,changes:changes.map(c=>({...object(c),oldPath:object(c).oldPath??null}))} as unknown as CheckInMetadata,now);
                  } catch(error) {this.sql.exec("UPDATE crew_checkins SET state='blocked',reason=?,next_at=NULL WHERE id=?",error instanceof Error?error.message:'Invalid metadata',event.id);}
                }
              }
              if (job.kind === 'scan') this.finishScan(job, result, scanReport, scanProblem, node, now);
              if (job.kind === 'host') this.gitOps.finishHost(job, result, hostDigest, node, now);
              this.hostedGit.revokeJobTickets(job.id, now);
              if ((PULL_JOB_KINDS as readonly string[]).includes(job.kind)) this.pulls.jobFinished(job, result, now);
              this.promoteQuietly(now, this.job(job.id));   // a build may wake a member, and frees its machine
              return json({ accepted: true, jobId: job.id });
            }
            this.sql.exec("UPDATE jobs SET state = 'running', lease_expires_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", now + LEASE_MS, now, job.id); this.event(job.id);
            return json({ leaseExpiresAt: now + LEASE_MS, cancelled: false });
          }
        }
        fail(403, 'forbidden', 'Command not permitted for this identity');
      });
      await this.schedule();
      if (finishedMirror) { await this.reconcileMirrors(); await this.reconcileSyncs(); }
      if (finishedImport) await this.gitOps.reconcileImports();
      // A crew push (or a run stopped, or Stop all crew) may leave a branch to confirm or a write token to end.
      if (['ai-finish', 'crew-run-stop', 'put-settings', 'crew-project-delete'].includes(action) && response.ok && await this.reconcileCrew()) {
        this.sql.exec('UPDATE meta SET projection_due = COALESCE(projection_due, ?)', Date.now() + 15000); await this.schedule();
      }
      if (response.ok && (left.length || studioChanged || renamed)) await this.syncDirectory(left, studioChanged, renamed);
      if (action === 'complete' && response.ok) await this.gitOps.dropFinishedUploads();   // a zip whose project now exists
      // A project living only on Artifacts gets a machine copy once one is online; a pushed one is mirrored back.
      // A pull request may be due its diff (opened, pushed again, its base merged into) or a finished merge its token's end.
      if (response.ok && ((action.startsWith('pull-')) || ['complete', 'ai-finish', 'crew-review', 'crew-decide'].includes(action)) && await this.reconcilePulls()) {
        this.sql.exec('UPDATE meta SET projection_due = COALESCE(projection_due, ?)', Date.now() + 15000); await this.schedule();
      }
      // New Cloudflare credentials may point at an account with or without Artifacts: ask again before answering.
      if (action === 'put-settings' && principal.kind === 'human' && response.ok) { await this.checkArtifacts(true); return json(this.publicSettings(principal.userId)); }
      return response;
    } catch (error) { return errorResponse(error); }
  }

  // D1 lists each person's workspaces and which workspaces admit the studio; the DO is the authority, so a failure
  // here only delays the index (a stale directory row lists nothing: the workspace refuses a non-member).
  private async syncDirectory(left: string[], studioChanged: boolean, renamed = false): Promise<void> {
    try {
      const { studioAccess: access, name } = this.settings(), id = this.workspaceId();
      await this.env.DB.batch([
        ...!renamed ? [] : [this.env.DB.prepare('UPDATE workspace_directory SET name = ? WHERE workspace_id = ?').bind(name, id)],
        ...!studioChanged ? [] : [access === 'off' ? this.env.DB.prepare('DELETE FROM studio_workspaces WHERE workspace_id = ?').bind(id)
          : this.env.DB.prepare('INSERT INTO studio_workspaces (workspace_id, role) VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET role = excluded.role').bind(id, access)],
        ...left.map(userId => this.env.DB.prepare('DELETE FROM workspace_directory WHERE workspace_id = ? AND user_id = ?').bind(id, userId)),
      ]);
    } catch (error) { console.error(JSON.stringify({ event: 'directory_sync_failed', error: String(error) })); }
  }

  // Queues a build of a project's product. `pin` builds another commit of the project instead of its
  // pinned one (an AI chat's Verify); such a build never supersedes the project's own queued builds. A pinned
  // build, and any build of a project a crew created, is secretless: it runs code a model wrote.
  private enqueueBuild(projectId: string, product: string, requestId: string, now: number, readToken: string, pin?: { branch: string; commit: string; timeoutMinutes?: number }): { id: string; number: number | null } {
    const existing = this.sql.exec<JobRow>('SELECT * FROM jobs WHERE request_id = ?', requestId).toArray()[0];
    if (existing) return { id: existing.id, number: null };
    if (this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM jobs').one().count >= 1000) fail(429, 'quota', 'Experiment job quota reached');
    const id = crypto.randomUUID();
    let specs: Record<string, ResolvedJobSpec>; let labels: string[] = []; let number: number | null = null; let secretless = Boolean(pin); let serial = false;
    if (projectId === 'smoke' && product === 'smoke' && !pin) specs = Object.fromEntries(['windows', 'linux', 'mac'].map(os => [os, smokeSpec(id, os)]));
    else {
      const stored = this.anyProject(projectId);
      if (!stored) fail(400, 'unsupported_project', 'Project not found');
      number = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE project_id = ? AND kind = 'build'", projectId).one().count + 1;
      secretless ||= crewCreated(stored);   // either shape: a crew-made project's code is a model's
      if (isRepoProject(stored)) {
        // A repository project builds its branch tip (a chat's Verify: the pinned commit) and gets
        // its command from smith.json at that commit through /resolve after checkout.
        if (stored.artifacts && ['pushing', 'verifying'].includes(stored.artifacts.status)) fail(409, 'artifacts_pending', 'Smith is still copying this project; build it once the copy finishes');
        if (stored.hosted?.status === 'copying') fail(409, 'hosted_pending', 'Smith is still copying this project; build it once the copy finishes');
        if (isArtifactsRemote(stored.repoUrl) && !readToken) fail(503, 'artifacts_unconfigured', 'This project builds from Smith’s copy, which is not available right now');
        ({ specs, labels, serial } = repoBuildSpecs(stored, product, id, number, readToken, this.env.ORIGIN));
        if (pin) for (const spec of Object.values(specs)) spec.repos = [{ ...spec.repos[0], branch: pin.branch, commit: pin.commit }];
      } else {
        if (stored.artifacts && ['pushing', 'verifying'].includes(stored.artifacts.status)) fail(409, 'artifacts_pending', 'Smith is still copying this project; build it once the copy finishes');
        if (stored.hosted?.status === 'copying') fail(409, 'hosted_pending', 'Smith is still copying this project; build it once the copy finishes');
        const definition: Project = pin ? { ...stored, branch: pin.branch, commit: pin.commit } : stored;
        if (isArtifactsRemote(definition.repoUrl) && !readToken) fail(503, 'artifacts_unconfigured', 'This project builds from Smith’s copy, which is not available right now; check the Cloudflare account ID and API token in workspace Settings');
        ({ specs, labels } = projectSpecs(definition, product, id, number, readToken, this.env.ORIGIN));
      }
      // A build from a Smith-hosted copy needs an agent that can clone one; older agents never see the job.
      if (smithRemoteRepo(stored.repoUrl, this.env.ORIGIN) && !labels.includes(GIT_CLIENT_LABEL)) labels = [...labels, GIT_CLIENT_LABEL];
      // A project that keeps large files (Git LFS) builds only where git-lfs is installed, or the checkout holds pointers.
      if (new LfsStore(this.sql).readyCount(stored.id) > 0 && !labels.includes(LFS_LABEL)) labels = [...labels, LFS_LABEL];
    }
    if (pin?.timeoutMinutes !== undefined) {
      labels = [...new Set([...labels, 'crew-verify-isolated'])];
      for (const spec of Object.values(specs)) spec.timeoutSeconds = Math.min(spec.timeoutSeconds || Infinity, pin.timeoutMinutes * 60);
    }
    const project = projectId === 'smoke' ? undefined : this.anyProject(projectId);
    if (!pin && ((isRepoProject(project) ? project.replaceQueued : undefined) ?? this.settings().supersedeQueued)) {
      // A newer request for the same target (project, action and branch) replaces the one still waiting for a machine.
      const branch = jobBranch(specs);
      for (const stale of this.sql.exec<JobRow>("SELECT * FROM jobs WHERE state = 'queued' AND kind = 'build' AND project_id = ? AND product = ?", projectId, product).toArray()) {
        // A pinned build (a Verify) names its commit; it is never replaced, and one of another branch is not this target.
        const staleSpecs = JSON.parse(stale.specs) as Record<string, ResolvedJobSpec>;
        if (Object.values(staleSpecs)[0]?.repos?.[0]?.commit || jobBranch(staleSpecs) !== branch) continue;
        this.sql.exec("UPDATE jobs SET state = 'cancelled', updated_at = ?, revision = revision + 1 WHERE id = ?", now, stale.id); this.event(stale.id);
      }
    }
    this.sql.exec("INSERT INTO jobs (id, kind, request_id, specs, project_id, product, required_labels, secretless, serial, state, created_at, updated_at, revision) VALUES (?, 'build', ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 1)", id, requestId, JSON.stringify(specs), projectId, product, JSON.stringify(labels), secretless ? 1 : 0, serial ? 1 : 0, now, now);
    this.event(id);
    return { id, number };
  }

  // A chat on a project hosted on Cloudflare Artifacts needs a repository token on its machine: read
  // to clone for a message, write to push the chat's branch, and read again for the Verify build that
  // follows a push. A crew message turn also gets read tokens for its related projects (GitHub ones use
  // the machine's own login). Minted before the transaction, for the turn that action will act on.
  private async aiRepoToken(credentialHash: string, action: string, body: Record<string, unknown>): Promise<AiRepoTokens | undefined> {
    try {
      const node = this.sql.exec<{ id: string; owner_user_id: string | null }>('SELECT id, owner_user_id FROM nodes WHERE token_hash = ? AND active = 1', credentialHash).toArray()[0];
      if (!node) return undefined;
      type Candidate = { id: string; session_id: string; kind: string; product: string | null; state: string; repo_url: string; project_id: string; session_kind: string; crew_id: string | null; branch: string };
      const select = 'SELECT t.id, t.session_id, t.kind, t.product, t.state, s.repo_url, s.project_id, s.kind AS session_kind, s.crew_id, s.branch FROM ai_turns t JOIN ai_sessions s ON s.id = t.session_id';
      const turn = action === 'ai-claim'
        ? this.sql.exec<Candidate>(`${select} WHERE s.node_id = ? AND t.state = 'running' ORDER BY t.created_at LIMIT 1`, node.id).toArray()[0]
          ?? this.sql.exec<Candidate>(`${select} ${CLAIMABLE_TURN}`, node.id, node.owner_user_id ?? '').toArray()[0]
        : this.sql.exec<Candidate>(`${select} WHERE t.id = ? AND s.node_id = ?`, typeof body.turnId === 'string' ? body.turnId : '', node.id).toArray()[0];
      if (!turn) return undefined;
      if (action === 'ai-finish' && !(turn.kind === 'push' && turn.product && turn.state === 'running')) return undefined;
      const minted: AiRepoTokens = { turnId: turn.id };
      const project = this.project(turn.project_id);
      // A crew push turn pushes the run's branch only when it left a proposal, and each project the run created with a write
      // token of that project's own (crew-projects.ts); a token that cannot be minted leaves its project unpushed, so it fails.
      const crewPush = action === 'ai-claim' && turn.session_kind === 'crew' && turn.kind === 'push';
      if (crewPush) minted.created = (await Promise.all(this.crew.projects.claimRows(turn.session_id).map(async p => {
        try { const issued = await this.artifactsFor(p.accountId).issueToken(p.repo, 'write', WRITE_TOKEN_TTL); return [{ ...p, authToken: issued.plaintext, tokenId: issued.id }]; }
        catch (error) {
          // The project fails now with the real reason (its member reads it), rather than later as "not pushed".
          const reason = error instanceof Error ? error.message : String(error);
          console.error(JSON.stringify({ event: 'crew_project_token_failed', projectId: p.id, message: reason }));
          this.ctx.storage.transactionSync(() => this.crew.projects.failCreated(p.id, turn.session_id, `Smith could not mint a push token: ${reason}`, Date.now()));
          return [];
        }
      }))).flat();
      if (crewPush && !this.crew.pushesBranch(turn.session_id)) return minted;
      if (project?.artifacts?.status === 'done' && isArtifactsRemote(turn.repo_url) && project.artifacts.remote === turn.repo_url) {
        const issued = await this.repoToken(project, action === 'ai-claim' && turn.kind === 'push');
        if (issued) { minted.token = issued.plaintext; minted.tokenId = issued.id; }
      }
      // A project behind Smith's own git URL (copies on machines, or storage proxied by Smith): a ticket bound to this
      // machine; write only for the push turn, and only to the chat's branch.
      const hostedId = smithRemoteRepo(turn.repo_url, this.env.ORIGIN);
      if (hostedId && this.ticketable(hostedId)) {
        const write = action === 'ai-claim' && turn.kind === 'push';
        minted.token = await this.gitOps.mintTicket(hostedId, write ? 'write' : 'read', node.id, write ? { allow: [`refs/heads/${turn.branch}`], protected: [], denyDelete: true } : undefined, turn.session_kind === 'crew' ? 'crew run' : 'chat');
      }
      const member = action === 'ai-claim' && turn.session_kind === 'crew' && turn.kind === 'message' ? this.crew.member(turn.crew_id ?? '') : undefined;
      if (member) minted.related = await Promise.all(crewRelatedProjects(member, this.allProjects()).map(async p => {
        const related = smithRemoteRepo(p.repoUrl, this.env.ORIGIN);
        if (related && this.ticketable(related)) return crewRelatedEntry(p, await this.gitOps.mintTicket(related, 'read', node.id, undefined, 'crew run'));
        return crewRelatedEntry(p, hasArtifactsCopy(p) ? (await this.repoToken(p, false).catch(() => null))?.plaintext ?? '' : '');
      }));
      return minted;
    } catch (error) { console.error(JSON.stringify({ event: 'ai_repo_token_failed', action, message: error instanceof Error ? error.message : String(error) })); return undefined; } // the machine's Git then reports the missing access in the chat
  }
  // Whether Smith's git URL for this repository can serve a ticket now: a copy on a machine, or a home in storage that
  // Smith proxies (the same states a build's clone accepts in git-workspace.ts).
  private ticketable(repoId: string): boolean {
    const repo = this.hostedGit.repo(repoId);
    return Boolean(repo && ['hosting', 'oversize', 'degraded', 'artifacts'].includes(repo.state));
  }
  private async repoToken(project: Project | RepoProject, write: boolean) {
    const client = this.artifactsFor(project.artifacts!.accountId);
    return client.configured ? await client.issueToken(project.artifacts!.repo, write ? 'write' : 'read', write ? WRITE_TOKEN_TTL : READ_TOKEN_TTL) : null;
  }

  // ---- Smith-hosted repositories: src/git-workspace.ts does the work; this object only lends it what it needs ----
  private gitOpsInstance?: GitOps;
  private get gitOps(): GitOps {
    const self = this;   // the context reads hostedGit lazily, so each call sees a helper over the current origin
    return this.gitOpsInstance ??= new GitOps({
      sql: this.sql, storage: this.ctx.storage, env: this.env, get hostedGit() { return self.hostedGit; },
      workspaceId: () => this.workspaceId(), hostNodes: () => this.hostNodes(), offlineMs: () => this.offlineMs(), hostingAvailable: now => this.hostingAvailable(now),
      settings: () => this.settings() as unknown as Record<string, unknown>, proxyMaxBytes: () => this.proxyMaxBytes(),
      anyProject: id => this.anyProject(id), saveProject: project => this.saveProject(project), publicProject: (project, now) => this.publicProject(project, now),
      job: id => this.job(id), publicJob: job => this.publicJob(job), event: id => this.event(id), requireHuman: (userId, write, admin) => this.requireHuman(userId, write, admin), schedule: () => this.schedule(),
      allProjects: () => this.allProjects(), projectIds: () => new Set(this.sql.exec<{ id: string }>('SELECT id FROM projects').toArray().map(row => row.id)),
      projectSlotsUsed: () => projectSlotsUsed(this.sql), insertProject: project => { this.sql.exec('INSERT INTO projects VALUES (?, ?)', project.id, JSON.stringify(project)); },
      artifactsReady: () => this.checkArtifacts(), artifacts: accountId => this.artifactsFor(accountId),
      artifactsAccount: () => { const c = this.artifactsCredentials(); return { accountId: c.accountId, source: c.source === 'workspace' ? 'workspace' : 'smith' }; },
      rescan: (projectId, note, now) => {
        const project = this.anyProject(projectId);
        if (!isRepoProject(project) || (project.scan.jobId && this.sql.exec("SELECT id FROM jobs WHERE id = ? AND state IN ('queued', 'leased', 'running')", project.scan.jobId).toArray().length)) return;
        let queued: RepoProject;
        try { queued = this.queueScan(project, now, note); } catch { return; }   // the job quota: Rescan on the card still works later
        this.repoAccess.clear(projectId); this.saveProject(queued);
      },
      copyPushed: (repoId, before, after, now) => this.copyPushed(repoId, before, after, now),
      artifactsToken: async (projectId, scope) => { const r = await this.artifactsToken(projectId, scope); if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? 'No storage token'); return (await r.json() as { token: string }).token; },
    });
  }
  // The Worker's own steps of a relay (never a client's or a machine's): reached only over this object's RPC.
  // A repo-scoped Artifacts token for the proxy (spec §2), cached until shortly before it lapses; `force` drops the cached
  // one first (Artifacts rejected it). Worker only, outside any transaction because minting is a network call.
  async artifactsToken(projectId: string, scope: 'read' | 'write', force = false): Promise<Response> {
    const now = Date.now();
    const project = this.anyProject(projectId);
    if (!project?.artifacts || project.artifacts.status !== 'done') return json({ error: { code: 'not_on_artifacts', message: 'This project has no copy in Smith’s storage' } }, 404);
    const cache = new ArtifactsTokens(this.sql); const client = this.artifactsFor(project.artifacts.accountId);
    const cached = force ? undefined : cache.get(projectId, scope, now + 60000);
    if (cached) return json({ token: cached.plaintext, expiresAt: cached.expiresAt });
    const ttl = scope === 'read' ? READ_CACHE_MS : WRITE_CACHE_MS;
    let issued: { id: string; plaintext: string };
    try { issued = await client.issueToken(project.artifacts.repo, scope, Math.ceil(ttl / 1000) + 300); }
    catch (error) { return errorResponse(error); }
    // The one it replaces lapses by itself (minutes for a write token, an hour for a read one): a request still carrying it finishes.
    this.ctx.storage.transactionSync(() => { cache.drop(projectId, scope); cache.store(projectId, scope, issued.id, issued.plaintext, now + ttl); });
    return json({ token: issued.plaintext, expiresAt: now + ttl });
  }
  // After a proxied push answered OK (spec §2): the advertisement becomes the record's tips; Build on push and copy
  // refreshes follow. A failed fetch changes nothing; the alarm's daily refresh catches up.
  async artifactsPushed(repoId: string): Promise<void> {
    try { await this.gitOps.refreshArtifactsTips(repoId, 'push'); }
    catch (error) {
      console.error(JSON.stringify({ event: 'artifacts_tips_failed', repoId, message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }));
      // The next alarm reads the advertisement with the push's reason, so Build on push still fires for this push.
      this.ctx.storage.transactionSync(() => this.hostedGit.markTipsDue(repoId, 'push'));
      await this.schedule();
    }
  }
  // Tests seed an Artifacts home without running an import.
  async seedArtifactsHomeForTest(projectId: string, remote: string, tips: [string, string][]): Promise<void> {
    const digest = await tipsDigest(tips);
    this.ctx.storage.transactionSync(() => {
      const project = this.anyProject(projectId)!; const now = Date.now();
      const name = repoNameFor(this.workspaceId(), projectId);
      this.hostedGit.startArtifactsHome(projectId, crypto.randomUUID(), remote, project.branch, now);
      this.hostedGit.artifactsReady(projectId, tips, digest, {}, project.branch, 0, now);
      this.saveProject({ ...project, home: 'artifacts', repoUrl: smithRemote(this.env.ORIGIN, projectId), artifacts: { repo: name, namespace: 'default', remote, status: 'done', accountId: this.artifactsCredentials().accountId, source: 'smith', sourceRepoUrl: project.repoUrl, updatedAt: now } } as Project);
    });
  }
  async gitRelay(step: 'ready' | 'abort' | 'wait' | 'delivered', body: Record<string, unknown>): Promise<Response> { return this.gitOps.gitRelay(step, body); }
  // The credential a pull request's merge (write) or publish (read) needs from Smith's copy, minted before the transaction
  // once the checks pass, so a refused merge makes no call: an Artifacts token, or for a Smith-hosted copy a ticket bound
  // to the merge job (its ID chosen here) that may write only the base branch. Undefined for a project not built from a
  // copy, when a check refuses (the transaction then answers with the refusal) or the copy cannot be reached (it says so).
  private async pullToken(userId: string, action: string, body: Record<string, unknown>): Promise<{ id?: string; plaintext: string; jobId?: string } | undefined> {
    let plan: { project: Project | RepoProject; base: string };
    try {
      plan = this.ctx.storage.transactionSync(() => {
        this.requireHuman(userId, true);
        const pulls = this.pulls;
        if (action === 'pull-merge') { const { pull, project } = pulls.mergePlan({ userId, role: this.role(userId) }, { ...body }); return { project, base: pull.base_branch }; }
        const pull = pulls.row(string(body, 'pullId', 64));
        return { project: this.anyProject(pull.project_id) ?? fail(404, 'not_found', 'Project not found'), base: pull.base_branch };
      });
    } catch { return undefined; }
    const { project, base } = plan;
    try {
      if (isArtifactsRemote(project.repoUrl)) return project.artifacts?.status === 'done' ? await this.repoToken(project, action === 'pull-merge') ?? undefined : undefined;
      if (action === 'pull-merge' && copyOf(project, this.env.ORIGIN)) {
        const jobId = crypto.randomUUID();
        return { jobId, plaintext: await this.gitOps.mintTicket(project.id, 'write', null, { allow: [`refs/heads/${base}`], protected: [], denyDelete: true }, 'merge', jobId) };
      }
    } catch { return undefined; }
    return undefined;
  }
  // Pull requests outside any transaction, as reconcileCrew: open one for each crew proposal waiting for review, queue the
  // diffs that are due with a read token of Smith's copy each, and revoke the write tokens of merges that are over.
  // Answers whether to try again (a token could not be revoked yet); a diff whose token cannot be minted says so on the
  // pull request instead of retrying, so an Artifacts outage never keeps the alarm busy.
  private async reconcilePulls(): Promise<boolean> {
    try {
      const pulls = this.pulls; let retry = false;
      this.ctx.storage.transactionSync(() => { pulls.openFromCrew(Date.now()); pulls.followChats(Date.now()); });
      for (const due of pulls.diffsDue()) {
        let token = '';
        try { token = await this.artifactsReadToken(this.anyProject(due.projectId)); } catch { console.error(JSON.stringify({ event: 'pull_diff_token_failed' })); }
        this.ctx.storage.transactionSync(() => pulls.queueDiff(due.pullId, token, Date.now()));
      }
      for (const item of pulls.tokensToRevoke(Date.now())) {
        const artifacts = this.anyProject(item.projectId)?.artifacts;
        try { if (artifacts) await this.artifactsFor(artifacts.accountId).revokeToken(artifacts.repo, item.tokenId); }
        catch { console.error(JSON.stringify({ event: 'pull_token_revoke_failed' })); if (!item.expired) { retry = true; continue; } }
        this.ctx.storage.transactionSync(() => pulls.tokenRevoked(item.pullId, item.tokenId));
      }
      return retry;
    } catch (error) { console.error(JSON.stringify({ event: 'pull_reconcile_failed', message: error instanceof Error ? error.message : String(error) })); return true; }
  }
  // A crew proposal's Verify of a project that builds from its Artifacts copy needs a read token for the build machine,
  // minted before the transaction like readTokenFor. Every check runs first, read-only (the caller's role, then the
  // Verify's own refusals and caps): a Verify that will be refused, or a replay, mints nothing and makes no Artifacts
  // call. The transaction that follows runs the same checks again and answers with the refusal.
  private async crewVerifyToken(userId: string, body: Record<string, unknown>): Promise<string> {
    let projectId: string;
    try {
      const plan = this.ctx.storage.transactionSync(() => { this.requireHuman(userId, true); return new CrewReview(this.sql).verifyPlan({ ...body }, Date.now(), this.crewHooks()); });
      if (plan.replay) return '';
      projectId = plan.project.id;
    } catch { return ''; }
    try { return await this.artifactsReadToken(this.anyProject(projectId)); } catch { return ''; }   // the enqueue then says Artifacts is unavailable
  }
  // Settle crew pushes against Cloudflare Artifacts, outside any transaction as reconcileMirrors does: confirm each pushed
  // branch head (crew-review.ts settle), then revoke the write tokens of push turns that are over. Answers whether
  // something must be tried again (Artifacts unreachable, or a branch not visible yet); the alarm retries it. Retries are
  // bounded: a proposal Artifacts cannot be asked about for 2 hours after its push fails (CrewReview.unreachable), and a
  // write token past its 2-hour TTL is recorded as ended even if revoking it keeps failing.
  private async reconcileCrew(): Promise<boolean> {
    try { return await this.reconcileCrewSteps(); }
    catch (error) { console.error(JSON.stringify({ event: 'crew_reconcile_failed', message: error instanceof Error ? error.message : String(error) })); return true; }
  }
  private cancelAutomaticCrewVerifies(now: number): void {
    for (const job of this.sql.exec<{ id: string }>("SELECT j.id FROM jobs j JOIN crew_verifies v ON v.job_id = j.id WHERE j.request_id = 'crew-verify-' || v.session_id || '-auto' AND j.state IN ('queued','leased','running')").toArray()) {
      this.sql.exec("UPDATE jobs SET state = 'cancelled', updated_at = ?, revision = revision + 1 WHERE id = ?", now, job.id);
      this.event(job.id);
    }
  }
  // Re-evaluate every authority and policy check on both sides of the asynchronous read-token mint.
  private automaticCrewVerifyAllowed(sessionId: string): boolean {
    if (this.settings().crewStopped || !this.settings().orchestration.enabled) return false;
    const action = this.sql.exec<{ actor: string; project_id: string; enabled: number }>(`SELECT a.actor, p.project_id, m.enabled FROM crew_actions a
      JOIN crew_runs r ON r.id = a.run_id JOIN crew_reports p ON p.session_id = r.session_id JOIN crew_members m ON m.id = p.crew_id
      WHERE p.session_id = ? AND p.status = 'pending' AND r.state = 'completed'
      AND NOT EXISTS (SELECT 1 FROM crew_verifies v WHERE v.session_id = p.session_id) LIMIT 1`, sessionId).toArray()[0];
    if (!action?.enabled) return false;
    const role = this.sql.exec<{ role: string }>('SELECT role FROM members WHERE user_id = ?', action.actor).toArray()[0]?.role;
    if (!role || !['owner', 'admin', 'operator'].includes(role)) return false;
    const automation = projectAutomation(this.settings().orchestration, action.project_id);
    return automation.mode === 'automatic_fix' && automation.verification.enabled;
  }
  private async automaticCrewVerifies(review: CrewReview): Promise<void> {
    const settings = this.settings();
    if (settings.crewStopped || !settings.orchestration.enabled) return;
    const projects = Object.keys(settings.orchestration.projectRules ?? {}).filter(id => {
      const automation = projectAutomation(settings.orchestration, id);
      return automation.mode === 'automatic_fix' && automation.verification.enabled;
    });
    if (!projects.length) return;
    // Filter authority and opt-in before applying the batch limit: inactive older proposals
    // must not hide a newer eligible proposal indefinitely.
    const candidates = this.sql.exec<{ session_id: string }>(`SELECT DISTINCT p.session_id FROM crew_reports p JOIN crew_runs r ON r.session_id = p.session_id
      JOIN crew_actions a ON a.run_id = r.id JOIN crew_members m ON m.id = p.crew_id JOIN members actor ON actor.user_id = a.actor
      WHERE p.status = 'pending' AND r.state = 'completed' AND m.enabled = 1 AND actor.role IN ('owner','admin','operator')
      AND p.project_id IN (SELECT value FROM json_each(?)) AND COALESCE(p.message, '') NOT LIKE 'Automatic Verify:%'
      AND NOT EXISTS (SELECT 1 FROM crew_verifies v WHERE v.session_id = p.session_id) ORDER BY p.created_at LIMIT 100`, JSON.stringify(projects)).toArray();
    for (const { session_id: sessionId } of candidates) {
      const body = { sessionId, requestId: 'auto' };
      try {
        const plan = this.ctx.storage.transactionSync(() => {
          if (!this.automaticCrewVerifyAllowed(sessionId) || this.sql.exec("SELECT 1 FROM crew_reports WHERE session_id = ? AND message LIKE 'Automatic Verify:%'", sessionId).toArray().length) return null;
          const plan = review.verifyPlan(body, Date.now(), this.crewHooks());
          // Reserve the single automatic attempt before external I/O. A refused or interrupted mint
          // stays visible for an operator to retry manually, rather than minting on every reconcile.
          if (!plan.replay) this.sql.exec("UPDATE crew_reports SET message = 'Automatic Verify: preparing build; use Verify manually if interrupted' WHERE session_id = ?", sessionId);
          return plan;
        });
        if (!plan || plan.replay) continue;
        const token = await this.artifactsReadToken(plan.project);
        this.ctx.storage.transactionSync(() => {
          if (!this.automaticCrewVerifyAllowed(sessionId)) {
            this.sql.exec("UPDATE crew_reports SET message = 'Automatic Verify: stopped because automation policy or authority changed; retry manually when allowed' WHERE session_id = ?", sessionId);
            return;
          }
          review.verify(body, Date.now(), { ...this.crewHooks(), enqueueVerify: (projectId, product, branch, commit, requestId, timeoutMinutes) =>
            this.enqueueBuild(projectId, product, requestId, Date.now(), token, { branch, commit, timeoutMinutes }) });
          this.sql.exec("UPDATE crew_reports SET message = NULL WHERE session_id = ? AND message LIKE 'Automatic Verify:%'", sessionId);
        });
      } catch (error) {
        const reason = error instanceof HttpError ? error.message : 'Build preparation failed; retry Verify manually';
        this.ctx.storage.transactionSync(() => this.sql.exec("UPDATE crew_reports SET message = ? WHERE session_id = ? AND status = 'pending'", `Automatic Verify: ${reason}`.slice(0, 2000), sessionId));
        if (!(error instanceof HttpError)) console.error(JSON.stringify({ event: 'crew_auto_verify_failed', sessionId, message: error instanceof Error ? error.message : String(error) }));
      }
    }
  }
  private async reconcileCrewSteps(): Promise<boolean> {
    const review = new CrewReview(this.sql);
    let retry = false;
    for (const item of review.verifying()) {
      const project = this.anyProject(item.projectId);
      const copy = hasArtifactsCopy(project);
      let head: string | null = null;
      try { if (copy) head = await this.artifactsFor(project!.artifacts!.accountId).branchHead(project!.artifacts!.repo, item.branch); }
      catch { if (this.ctx.storage.transactionSync(() => review.unreachable(item.sessionId, Date.now(), this.sessions))) retry = true; continue; }
      if (this.ctx.storage.transactionSync(() => review.settle(item.sessionId, head, copy, Date.now(), this.sessions))) retry = true;
    }
    await this.automaticCrewVerifies(review);
    for (const token of review.writeTokens(Date.now())) {
      // A project that no longer has an Artifacts copy (removed, or switched away) has no account to revoke in: the token
      // is recorded as ended without a call. It is a write token, so its own TTL (WRITE_TOKEN_TTL, 2 hours) ends it anyway.
      const artifacts = this.anyProject(token.projectId ?? '')?.artifacts;
      try { if (artifacts) await this.artifactsFor(artifacts.accountId).revokeToken(artifacts.repo, token.tokenId); }
      catch { console.error(JSON.stringify({ event: 'crew_token_revoke_failed' })); if (!token.expired) { retry = true; continue; } }
      this.ctx.storage.transactionSync(() => review.tokenRevoked(token.runId, token.tokenId));
    }
    // Projects crew members created: the main branch each push turn pushed, then the write tokens those turns held.
    const created = new CrewProjects(this.sql);
    for (const item of created.verifying()) {
      let head: string | null;
      try { head = await this.artifactsFor(item.accountId).branchHead(item.repo, 'main'); }
      catch { if (this.ctx.storage.transactionSync(() => created.unreachable(item.id, Date.now()))) retry = true; continue; }
      if (this.ctx.storage.transactionSync(() => created.settle(item.id, head, Date.now()))) retry = true;
    }
    // Each crew-made project confirmed since: Smith reads its smith.json (a failed read-token mint is tried again).
    for (const project of this.allProjects().filter(crewScanDue)) {
      try { await this.scanCrewProject(project.id); }
      catch (error) { console.error(JSON.stringify({ event: 'crew_project_scan_failed', projectId: project.id, message: error instanceof Error ? error.message : String(error) })); retry = true; }
    }
    for (const token of created.writeTokens(Date.now())) {
      try { await this.artifactsFor(token.accountId).revokeToken(token.repo, token.tokenId); }
      catch { console.error(JSON.stringify({ event: 'crew_token_revoke_failed' })); if (!token.expired) { retry = true; continue; } }
      this.ctx.storage.transactionSync(() => created.tokenRevoked(token.id, token.tokenId));
    }
    return retry;
  }

  // A crew-made project whose first push Artifacts confirmed: Smith reads its smith.json from the copy (upstream's scan, with
  // a read token minted outside the transaction), so its build actions appear. Once: a project already scanned is left.
  private async scanCrewProject(id: string): Promise<void> {
    const project = this.anyProject(id);
    if (!crewScanDue(project)) return;
    const readToken = await this.artifactsReadToken(project);
    this.ctx.storage.transactionSync(() => { const current = this.anyProject(id); if (crewScanDue(current)) this.saveProject(this.queueScan(current, Date.now(), '', readToken)); });
  }

  // crew_create_project (a run token's tool): reserve the ID, create the repository on the workspace's own Cloudflare
  // Artifacts account outside any transaction (as mirrorProject does), then record the project. The member's role is
  // checked again in each transaction; a repository Artifacts could not make leaves the reservation as an error.
  private async crewCreateProject(userId: string, sessionId: string | null, body: Record<string, unknown>): Promise<Response> {
    if (!sessionId) fail(403, 'forbidden', 'Only a crew run can use the crew tools');
    const credentials = this.artifactsCredentials(), workspaceId = this.workspaceId();
    const step = this.ctx.storage.transactionSync(() => {
      this.requireHuman(userId);
      return this.crew.reserveProject(sessionId, body, Date.now(), { settings: this.settings(), source: credentials.source, repoName: id => repoNameFor(workspaceId, id) });
    });
    if ('replay' in step) return step.replay;
    const { request } = step, client = createArtifacts(this.env, credentials);
    let remote: string;
    try {
      // A repository left from an earlier project of that ID (a delete keeps it) with commits would refuse the first push.
      const existing = await client.getRepo(request.repo);
      if (existing && await client.branchHead(request.repo, 'main') !== null)
        fail(409, 'project_exists', `a repository for ${request.id} already exists with history; choose another ID or delete it in Cloudflare`);
      const repo = existing ?? await client.createRepo(request.repo, 'main', request.description || `Smith project ${request.name} (${request.id}), made by a crew member`);
      if (!isArtifactsRemote(repo.remote)) fail(502, 'artifacts_failed', 'Artifacts returned an unexpected remote URL');
      remote = repo.remote;
    } catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(502, 'artifacts_unavailable', 'Cloudflare Artifacts could not be reached');
      this.ctx.storage.transactionSync(() => this.crew.projects.error(request.key, failure.message, Date.now()));
      return errorResponse(failure);
    }
    const response = this.ctx.storage.transactionSync(() => { this.requireHuman(userId); return this.crew.recordProject(request, remote, client.namespace, credentials.accountId, Date.now()); });
    await this.schedule();
    return response;
  }

  // ---- Cloudflare Artifacts: copy a project's repository, then build from the copy ----

  // A build of an Artifacts-backed project checks out with a repository-scoped read token
  // minted here (the only credential the hosted agent accepts). Minted before the enqueue
  // transaction; a replayed requestId or a non-Artifacts project mints nothing.
  private async readTokenFor(body: Record<string, unknown>): Promise<string> {
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    const requestId = typeof body.requestId === 'string' ? body.requestId : '';
    if (!projectId || projectId === 'smoke') return '';
    if (requestId && this.sql.exec('SELECT id FROM jobs WHERE request_id = ?', requestId).toArray().length) return '';
    return this.artifactsReadToken(this.anyProject(projectId));
  }
  // A read token for a project that builds from its Artifacts copy; '' for every other project.
  private async artifactsReadToken(project: Project | RepoProject | undefined): Promise<string> {
    if (!project || !isArtifactsRemote(project.repoUrl) || !project.artifacts || project.artifacts.status !== 'done') return '';
    const client = this.artifactsFor(project.artifacts.accountId);
    if (!client.configured) return '';
    return (await client.issueToken(project.artifacts.repo, 'read', READ_TOKEN_TTL)).plaintext;
  }
  private async mirrorProject(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['requestId', 'projectId']);
    const requestId = string(body, 'requestId'); const projectId = string(body, 'projectId', 64);
    this.requireHuman(userId, true, true);
    const project = this.anyProject(projectId);
    if (!project) fail(404, 'not_found', 'Project not found');
    // A Git-URL project is copied at the commit Smith last read (its branch tip at that time).
    if (isRepoProject(project) && !project.commit) fail(409, 'artifacts_not_ready', 'Smith has not read this repository yet; copy it once its smith.json has been read');
    const source = { id: project.id, name: project.name, repoUrl: project.repoUrl, branch: project.branch, commit: project.commit ?? '' };
    if (!source.branch) fail(409, 'artifacts_not_ready', 'The branch is not known yet; rescan the project first');
    const existing = this.sql.exec<JobRow>('SELECT * FROM jobs WHERE request_id = ?', requestId).toArray()[0];
    if (existing) {
      if (existing.kind !== 'mirror' || existing.project_id !== projectId) fail(409, 'conflicting_request', 'Request ID already identifies a different job');
      return json({ project, job: this.publicJob(existing) }, 201);
    }
    if (project.artifacts && ['pushing', 'verifying'].includes(project.artifacts.status)) fail(409, 'artifacts_pending', 'Smith is already copying this project');
    if (project.artifacts?.status === 'done' && isArtifactsRemote(project.repoUrl)) fail(409, 'artifacts_done', 'This project already builds from Smith’s copy');
    const credentials = this.artifactsCredentials(); const client = createArtifacts(this.env, credentials);
    if (!client.configured || credentials.source === 'none' || !await this.checkArtifacts()) fail(503, 'artifacts_unconfigured', 'Smith cannot keep its own copy of projects on this service; build straight from GitHub instead');
    const name = repoNameFor(this.workspaceId(), projectId);
    const repo = await client.getRepo(name) ?? await client.createRepo(name, source.branch, `Smith project ${source.name} (${source.id})`);
    if (!isArtifactsRemote(repo.remote)) fail(502, 'artifacts_failed', 'Smith’s copy returned an unexpected address');
    const now = Date.now();
    const record: ProjectArtifacts = { repo: name, namespace: client.namespace, remote: repo.remote, status: 'pushing', accountId: credentials.accountId, source: credentials.source, sourceRepoUrl: project.repoUrl, updatedAt: now };
    // Already there: the branch head is the pinned commit, so no push is needed - just switch.
    if (await client.branchHead(name, source.branch) === source.commit) {
      const switched = this.ctx.storage.transactionSync(() => {
        const current = this.anyProject(projectId); if (!current) fail(404, 'not_found', 'Project not found');
        const done = { ...current, repoUrl: repo.remote, artifacts: { ...record, status: 'done' as const, pushedCommit: source.commit } };
        this.saveProject(done as Project); return this.publicProject(done, now);
      });
      return json({ project: switched, job: null }, 201);
    }
    const writeToken = await client.issueToken(name, 'write', WRITE_TOKEN_TTL);
    const response = this.ctx.storage.transactionSync(() => {
      const current = this.anyProject(projectId); if (!current) fail(404, 'not_found', 'Project not found');
      if (current.artifacts && ['pushing', 'verifying'].includes(current.artifacts.status)) fail(409, 'artifacts_pending', 'Smith is already copying this project');
      if (this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM jobs').one().count >= 1000) fail(429, 'quota', 'Experiment job quota reached');
      const id = crypto.randomUUID();
      this.sql.exec("INSERT INTO jobs (id, kind, request_id, specs, project_id, product, required_labels, state, created_at, updated_at, revision) VALUES (?, 'mirror', ?, ?, ?, 'copy-to-artifacts', '[]', 'queued', ?, ?, 1)",
        id, requestId, JSON.stringify(mirrorSpecs(source, id, repo.remote, writeToken.plaintext)), projectId, now, now);
      this.event(id);
      const updated = { ...current, artifacts: { ...record, jobId: id, tokenId: writeToken.id } };
      this.saveProject(updated as Project);
      return json({ project: this.publicProject(updated, now), job: this.publicJob(this.job(id)) }, 201);
    });
    await this.schedule();
    return response;
  }
  // Settle every project whose copy is in flight: a finished mirror job is verified against the
  // Artifacts branch head (independently of what the agent reported) before the project is
  // switched to build from the copy; anything else ends as 'failed' with the project unchanged.
  // Idempotent; runs after a completion and from the alarm, so a transient API error is retried.
  private async reconcileMirrors(): Promise<void> {
    const pending = this.sql.exec<{ definition: string }>('SELECT definition FROM projects').toArray().map(p => JSON.parse(p.definition) as Project | RepoProject)
      .filter(p => p.artifacts && ['pushing', 'verifying'].includes(p.artifacts.status) && p.artifacts.jobId);
    for (const project of pending) {
      const artifacts = project.artifacts!;
      const job = this.sql.exec<JobRow>('SELECT * FROM jobs WHERE id = ?', artifacts.jobId).toArray()[0];
      if (!job || ['queued', 'leased', 'running'].includes(job.state)) continue;
      const result = job.result ? JSON.parse(job.result) as JobResult : null;
      let outcome: { status: 'done' | 'failed'; message: string };
      if (job.state === 'success') {
        let head: string | null;
        try { head = await this.artifactsFor(artifacts.accountId).branchHead(artifacts.repo, project.branch); }
        catch {
          // Artifacts unreachable: leave the project 'verifying' and let the alarm retry.
          this.ctx.storage.transactionSync(() => {
            const current = this.anyProject(project.id);
            if (current?.artifacts && current.artifacts.jobId === artifacts.jobId) this.saveProject({ ...current, artifacts: { ...current.artifacts, status: 'verifying', updatedAt: Date.now() } } as Project);
            this.sql.exec('UPDATE meta SET projection_due = COALESCE(projection_due, ?)', Date.now() + 15000);
          });
          continue;
        }
        outcome = head === project.commit ? { status: 'done', message: '' } : { status: 'failed', message: head ? `Artifacts branch head ${head.slice(0, 12)} is not the pinned commit` : 'The Artifacts branch was not created' };
      } else outcome = { status: 'failed', message: result?.message || `Copy job ended as ${job.state}` };
      if (artifacts.tokenId) { try { await this.artifactsFor(artifacts.accountId).revokeToken(artifacts.repo, artifacts.tokenId); } catch { console.error(JSON.stringify({ event: 'artifacts_token_revoke_failed' })); } }
      this.ctx.storage.transactionSync(() => {
        const current = this.anyProject(project.id);
        if (!current?.artifacts || current.artifacts.jobId !== artifacts.jobId || !['pushing', 'verifying'].includes(current.artifacts.status)) return;
        const record: ProjectArtifacts = { ...current.artifacts, status: outcome.status, message: outcome.message || undefined, tokenId: undefined, updatedAt: Date.now(), ...(outcome.status === 'done' ? { pushedCommit: current.commit ?? undefined } : {}) };
        this.saveProject({ ...current, repoUrl: outcome.status === 'done' ? artifacts.remote : current.repoUrl, artifacts: record } as Project);
      });
    }
  }

  // Pull from / Push to the repository a copied project is linked to (upstream.ts): a mirror job
  // any updated machine runs with its own Git login, plus a repo-scoped Artifacts token for the copy's side.
  private async syncProject(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['requestId', 'projectId', 'direction']);
    const requestId = string(body, 'requestId'); const projectId = string(body, 'projectId', 64);
    if (body.direction !== 'pull' && body.direction !== 'push') fail(400, 'invalid_field', 'direction must be pull or push');
    this.requireHuman(userId, true, true);
    return await this.startSync(projectId, body.direction, requestId);
  }
  // Start a Pull or Push of a project's copy: from the dashboard, or a Pull that brings a pushed commit into the copy.
  private async startSync(projectId: string, direction: SyncDirection, requestId: string): Promise<Response> {
    const existing = this.sql.exec<JobRow>('SELECT * FROM jobs WHERE request_id = ?', requestId).toArray()[0];
    if (existing) {
      if (existing.kind !== 'mirror' || existing.project_id !== projectId || existing.product !== SYNC_PRODUCT[direction]) fail(409, 'conflicting_request', 'Request ID already identifies a different job');
      return json({ project: this.publicProject(this.anyProject(projectId)!, Date.now()), job: this.publicJob(existing) }, 201);
    }
    const check = (project: Project | RepoProject | undefined): { project: RepoProject; copy: CopyInfo } => {
      const copy = smithCopy(project, this.env.ORIGIN);
      if (!upstreamOf(copy, this.env.ORIGIN)) fail(409, 'not_linked', 'This project is not linked to another repository; link one first');
      if (syncRunning(copy)) fail(409, 'sync_pending', `A ${copy.sync!.direction} is already under way for this project`);
      if (!(project as RepoProject).branch) fail(409, 'artifacts_not_ready', 'The branch is not known yet; rescan the project first');
      return { project: project as RepoProject, copy };
    };
    const { project: checked, copy } = check(this.anyProject(projectId));
    const id = crypto.randomUUID();
    // The credential for the copy: an Artifacts token, or for Smith's own copy a write ticket bound to this job (a push
    // reads the copy with the ticket or local fast path the claim hands out, as a build does).
    let token = '', tokenId: string | undefined;
    if (isArtifactsRemote(copy.remote)) {
      const client = this.artifactsFor(checked.artifacts!.accountId);
      if (!client.configured) fail(503, 'artifacts_unconfigured', 'Smith cannot reach its copy of this project; check the Cloudflare settings');
      const issued = direction === 'pull' ? await client.issueToken(checked.artifacts!.repo, 'write', WRITE_TOKEN_TTL) : await client.issueToken(checked.artifacts!.repo, 'read', READ_TOKEN_TTL);
      token = issued.plaintext; tokenId = issued.id;
    } else if (direction === 'pull') token = await this.gitOps.mintTicket(projectId, 'write', null, { allow: [`refs/heads/${checked.branch}`, 'refs/tags/*'], protected: [], denyDelete: true }, 'pull', id);
    const response = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const { project, copy: current } = check(this.anyProject(projectId));
      if (this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM jobs').one().count >= 1000) fail(429, 'quota', 'Experiment job quota reached');
      this.sql.exec("INSERT INTO jobs (id, kind, request_id, specs, project_id, product, required_labels, state, created_at, updated_at, revision) VALUES (?, 'mirror', ?, ?, ?, ?, ?, 'queued', ?, ?, 1)",
        id, requestId, JSON.stringify(syncSpecs(project, current, direction, id, token, this.env.ORIGIN)), projectId, SYNC_PRODUCT[direction], JSON.stringify(current.kind === 'hosted' ? [SYNC_LABEL, GIT_CLIENT_LABEL] : [SYNC_LABEL]), now, now);
      this.event(id);
      const sync: UpstreamSync = { direction, status: 'running', jobId: id, ...(tokenId ? { tokenId } : {}), at: now };
      const updated = this.withSync(project, current, sync, now);
      this.saveProject(updated);
      return json({ project: this.publicProject(updated, now), job: this.publicJob(this.job(id)) }, 201);
    });
    await this.schedule();
    return response;
  }
  // Link a copied project to a repository (url), or detach it (url ''): Smith keeps its copy either way.
  private linkProject(userId: string, body: Record<string, unknown>): Response {
    fields(body, ['projectId', 'url']);
    const projectId = string(body, 'projectId', 64);
    if (typeof body.url !== 'string') fail(400, 'invalid_field', 'Invalid field: url');
    const url = body.url.trim() ? validateUpstreamUrl(body.url, this.env.ORIGIN) : '';
    this.requireHuman(userId, true, true);
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const project = this.anyProject(projectId) as RepoProject | undefined;
      const copy = smithCopy(project, this.env.ORIGIN);
      if (syncRunning(copy)) fail(409, 'sync_pending', `Wait for the ${copy.sync!.direction} under way to finish`);
      const linked = upstreamOf(copy, this.env.ORIGIN);
      if (!url && !linked) fail(409, 'not_linked', 'This project is not linked to another repository');
      const link = url ? { sourceRepoUrl: url, detachedFrom: undefined } : { sourceRepoUrl: copy.remote, detachedFrom: linked };
      const updated: RepoProject = copy.kind === 'hosted'
        ? { ...project!, hosted: { ...project!.hosted!, ...link, sync: undefined, updatedAt: now } }
        : { ...project!, artifacts: { ...project!.artifacts!, ...link, sync: undefined, updatedAt: now } as ProjectArtifacts };
      this.saveProject(updated);
      return json(this.publicProject(updated, now));
    });
  }
  // The last Pull or Push, written on whichever copy the project builds from.
  private withSync(project: RepoProject, copy: CopyInfo, sync: UpstreamSync, now: number): RepoProject {
    return copy.kind === 'hosted' ? { ...project, hosted: { ...project.hosted!, sync, updatedAt: now } } : { ...project, artifacts: { ...project.artifacts!, sync, updatedAt: now } };
  }
  // Settle every Pull/Push whose job ended. A pull is confirmed against the copy's branch head (the
  // agent's word is not enough) and then rescanned, so the build actions follow the new smith.json.
  private async reconcileSyncs(): Promise<void> {
    const origin = this.env.ORIGIN;
    const pending = this.allProjects().filter((p): p is RepoProject => isRepoProject(p) && Boolean(copyOf(p, origin)?.sync && syncRunning(copyOf(p, origin)!)));
    for (const project of pending) {
      const copy = copyOf(project, origin)!; const sync = copy.sync!;
      const job = this.sql.exec<JobRow>('SELECT * FROM jobs WHERE id = ?', sync.jobId).toArray()[0];
      if (job && ['queued', 'leased', 'running'].includes(job.state)) continue;
      const result = job?.result ? JSON.parse(job.result) as JobResult : null;
      let outcome: { status: 'done' | 'failed'; message: string; commit?: string };
      if (job?.state === 'success' && sync.direction === 'pull') {
        // The agent's word is not enough: the copy's branch head is read back (Artifacts API, or Smith's own record,
        // which the relayed push updated before the job could complete).
        let head: string | null;
        if (copy.kind === 'hosted') head = (JSON.parse(this.hostedGit.repo(project.id)?.refs_json ?? '[]') as [string, string][]).find(([, ref]) => ref === `refs/heads/${project.branch}`)?.[0] ?? null;
        else {
          try { head = await this.artifactsFor(project.artifacts!.accountId).branchHead(project.artifacts!.repo, project.branch); }
          catch { this.sql.exec('UPDATE meta SET projection_due = COALESCE(projection_due, ?)', Date.now() + 15000); continue; }   // the alarm retries
        }
        outcome = head && (!result?.commit || head === result.commit) ? { status: 'done', message: '', commit: head }
          : { status: 'failed', message: head ? `Smith’s copy is at ${head.slice(0, 12)}, not the pulled commit` : 'The branch did not arrive in Smith’s copy' };
      } else if (job?.state === 'success') outcome = { status: 'done', message: '', commit: result?.commit };
      else outcome = { status: 'failed', message: syncFailure(sync.direction, upstreamOf(copy, origin), result?.message ?? '', job?.state ?? 'lost') };
      if (sync.tokenId && copy.kind === 'artifacts') { try { await this.artifactsFor(project.artifacts!.accountId).revokeToken(project.artifacts!.repo, sync.tokenId); } catch { console.error(JSON.stringify({ event: 'artifacts_token_revoke_failed' })); } }
      const rescan = outcome.status === 'done' && sync.direction === 'pull' && outcome.commit !== project.commit;
      // After the pull the copy is at the linked repository's head, so GitHub can usually read smith.json without a machine.
      const read = rescan && !project.push?.pending ? await this.readProject(project).catch(() => null) : null;
      const readToken = rescan && !read?.report && copy.kind === 'artifacts' ? await this.artifactsReadToken(project).catch(() => '') : '';   // a hosted scan gets its ticket at claim
      this.ctx.storage.transactionSync(() => {
        const now = Date.now();
        const current = this.anyProject(project.id);
        const live = copyOf(current, origin);
        if (!isRepoProject(current) || !live || live.sync?.jobId !== sync.jobId || live.sync.status !== 'running') return;
        const done: UpstreamSync = { direction: sync.direction, status: outcome.status, jobId: sync.jobId, at: now, ...(outcome.commit ? { commit: outcome.commit } : {}), ...(outcome.message ? { message: outcome.message } : {}) };
        let saved: RepoProject = this.withSync(current, live, done, now);
        const scanning = saved.scan.jobId && this.sql.exec("SELECT id FROM jobs WHERE id = ? AND state IN ('queued', 'leased', 'running')", saved.scan.jobId).toArray().length;
        if (rescan && !scanning && !saved.push?.pending) {
          this.repoAccess.clear(saved.id);
          saved = read?.report && read.report.commit === outcome.commit ? applyReport({ ...saved, scan: { ...saved.scan, jobId: null } }, read.report, 'github', null, now) : this.queueScan(saved, now, 'Reading smith.json after the pull.', readToken);
        }
        this.saveProject(saved);
      });
    }
    await this.advancePushes();   // a push waiting on a Pull builds once the commit is in the copy
    if (pending.length) await this.schedule();   // a pull's rescan, or a verification left for the alarm
  }

  private installUrl(): string | null { const slug = (this.env as { GITHUB_APP_SLUG?: string }).GITHUB_APP_SLUG; return slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : null; }
  // Tokens to read a repository with, in order: the project creator's GitHub link, every other
  // member's link, then the workspace Settings token. Each is tried until one can read the repo.
  private async githubTokens(preferUser?: string): Promise<string[]> {
    const members = this.sql.exec<{ user_id: string }>('SELECT user_id FROM members').toArray().map(m => m.user_id);
    const ordered = preferUser ? [preferUser, ...members.filter(m => m !== preferUser)] : members;
    const tokens = (await githubTokensFor(this.env, ordered)).map(t => t.token);
    const settings = this.secrets().githubToken; if (settings) tokens.push(settings);
    return tokens;
  }
  // ---- Projects added from a Git URL ----

  // The add-project dialog's repository picker: everything the workspace's GitHub token can
  // see, and a repository's branches. Admin-only, like adding a project. Without a token the
  // dialog falls back to a typed URL, so this answers {configured:false} rather than failing.
  private async githubPicker(userId: string, action: string, body: Record<string, unknown>): Promise<Response> {
    this.requireHuman(userId, true, true);
    // The person's own GitHub link first (what they can see); the Settings token only as a fallback.
    const own = await githubTokenFor(this.env, userId);
    const token = own ?? this.secrets().githubToken;
    if (!token) return json({ configured: false, reason: 'link', repos: [], branches: [], installUrl: this.installUrl() });
    const lister = githubLister(this.env);
    try {
      if (action === 'github-repos') { fields(body, []); const listing = await lister.repos(token); return json({ configured: true, via: own ? 'link' : 'settings', repos: listing.repos, installed: listing.installed, installUrl: this.installUrl() }); }
      // Import from GitHub (spec §5): the organisations the token sees, then one organisation's repositories with what is
      // already in Smith and the large-file preflight (batches of ten within a 25 s budget; a row past it says so).
      if (action === 'import-orgs') { fields(body, []); return json({ configured: true, via: own ? 'link' : 'settings', orgs: await lister.orgs(token), installUrl: this.installUrl() }); }
      if (action === 'import-repos') {
        fields(body, ['org', 'thresholdBytes']);
        const org = string(body, 'org', 39); const threshold = integer(body, 'thresholdBytes', 1048576, MAX_IMPORT_THRESHOLD_BYTES);
        const repos = await lister.orgRepos(org, token);
        const known = new Map<string, string>();   // owner/name (lower case) -> project id
        for (const p of this.allProjects()) for (const url of [p.repoUrl, p.artifacts?.sourceRepoUrl, p.hosted?.sourceRepoUrl, p.artifacts?.detachedFrom, p.hosted?.detachedFrom]) { const key = url ? githubRepo(url) : null; if (key) known.set(`${key.owner}/${key.repo}`.toLowerCase(), p.id); }
        const deadline = Date.now() + 25000; const large: (LargeBlobs | null)[] = [];
        for (let i = 0; i < repos.length; i += 10) {
          if (Date.now() > deadline) { large.push(...repos.slice(i).map(() => null)); break; }
          large.push(...await Promise.all(repos.slice(i, i + 10).map(r => lister.largeBlobs(r.fullName, r.defaultBranch, token, threshold))));
        }
        return json({ configured: true, via: own ? 'link' : 'settings', org, totalKb: repos.reduce((sum, r) => sum + r.sizeKb, 0), repos: repos.map((r, i) => ({ ...r, inSmith: known.get(r.fullName.toLowerCase()) ?? null, large: large[i] })) });
      }
      fields(body, ['repo']);
      const repo = string(body, 'repo', 200);
      if (!githubRepo('https://github.com/' + repo)) fail(400, 'invalid_field', 'repo must be owner/name');
      return json({ configured: true, branches: await lister.branches(repo, token) });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const reason = error instanceof GitHubReadError ? error.message : error instanceof Error && error.name === 'TimeoutError' ? 'GitHub did not answer in time' : 'GitHub could not be reached';
      fail(502, 'github_unavailable', reason);
    }
  }

  private async readViaGitHub(project: RepoProject, preferUser?: string): Promise<{ report: ScanReport | null; note: string }> {
    if (!githubRepo(project.repoUrl)) return { report: null, note: '' };
    const tokens = await this.githubTokens(preferUser ?? (typeof project.createdBy === 'string' ? project.createdBy : undefined));
    if (!tokens.length) return { report: null, note: '' };   // nobody linked GitHub: a machine reads it
    let reason = '';
    for (const token of tokens) {
      try { return { report: await githubReader(this.env)(project.repoUrl, project.branch, token), note: '' }; }
      catch (error) { reason = error instanceof GitHubReadError ? error.message : error instanceof Error && error.name === 'TimeoutError' ? 'GitHub did not answer within 5 seconds' : 'GitHub could not be reached'; }
    }
    return { report: null, note: `GitHub could not read this repository through any linked account (${reason}).` };
  }
  private queueScan(project: RepoProject, now: number, note: string, readToken = ''): RepoProject {
    if (this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM jobs').one().count >= 1000) fail(429, 'quota', 'Experiment job quota reached');
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO jobs (id, kind, request_id, specs, project_id, product, required_labels, state, created_at, updated_at, revision) VALUES (?, 'scan', ?, ?, ?, ?, ?, 'queued', ?, ?, 1)",
      id, `scan-${id}`, JSON.stringify(scanSpecs(project, id, readToken, this.env.ORIGIN)), project.id, SCAN_PRODUCT, JSON.stringify(smithRemoteRepo(project.repoUrl, this.env.ORIGIN) ? [REPO_LABEL, GIT_CLIENT_LABEL] : [REPO_LABEL]), now, now);
    this.event(id);
    return { ...project, scan: { state: 'waiting', message: note, via: null, host: null, jobId: id, at: now } };
  }
  private async addRepoProject(userId: string, body: Record<string, unknown>): Promise<Response> {
    this.requireHuman(userId, true, true);
    const now = Date.now();
    const draft = createRepoProject(body, new Set(this.sql.exec<{ id: string }>('SELECT id FROM projects').toArray().map(row => row.id)), now, userId);
    const read = await this.readViaGitHub(draft, userId);      // outside the transaction: an external call
    const response = this.ctx.storage.transactionSync(() => {
      const taken = new Set(this.sql.exec<{ id: string }>('SELECT id FROM projects').toArray().map(row => row.id));
      if (projectSlotsUsed(this.sql) >= 20) fail(429, 'quota', 'Experiment project quota reached');   // crew reservations count too
      const project = { ...draft, id: taken.has(draft.id) ? newProjectId(draft.repoUrl, taken) : draft.id };
      const saved = read.report ? applyReport(project, read.report, 'github', null, now) : this.queueScan(project, now, read.note);
      this.sql.exec('INSERT INTO projects VALUES (?, ?)', saved.id, JSON.stringify(saved));
      return json(this.publicProject(saved, now), 201);
    });
    await this.schedule();
    return response;
  }
  // Edit a project in place (owners and admins): its name, the branch it follows, and whether it builds from Smith's copy or
  // straight from its repository. A pinned (prepared) project becomes one that follows its branch, keeping its ID, crew
  // members, build history and copy. A changed branch or source is read again (GitHub first, else a machine).
  private async editProject(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['projectId', 'name', 'branch', 'buildFrom']);
    const projectId = string(body, 'projectId', 64);
    this.requireHuman(userId, true, true);
    if (body.branch !== undefined && (typeof body.branch !== 'string' || !body.branch.trim() || !validBranch(body.branch.trim()))) fail(400, 'invalid_branch', 'Invalid branch name');
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 128)) fail(400, 'invalid_field', 'Invalid field: name');
    if (body.buildFrom !== undefined && body.buildFrom !== 'copy' && body.buildFrom !== 'repository') fail(400, 'invalid_field', 'buildFrom must be copy or repository');
    const plan = (now: number) => {
      const current = this.anyProject(projectId) ?? fail(404, 'not_found', 'Project not found');
      if (crewCreated(current)) fail(409, 'unsupported_project', 'A project a crew member created builds from its copy; it cannot be edited');
      if (current.hosted?.status === 'copying' || (current.artifacts && ['pushing', 'verifying'].includes(current.artifacts.status))) fail(409, 'hosted_pending', 'Smith is still copying this project; edit it once the copy finishes');
      const copy = copyOf(current, this.env.ORIGIN);
      if (copy && syncRunning(copy)) fail(409, 'sync_running', 'A Pull or Push of this project is running; edit it once it finishes');
      // Where it builds from: Smith's copy (hosted on the machines, or an older Cloudflare Artifacts copy) or the repository it came from.
      const ownCopy = current.hosted?.status === 'ready' ? smithRemote(this.env.ORIGIN, current.id) : current.artifacts?.status === 'done' ? current.artifacts.remote : '';
      const source = copy ? upstreamOf(copy, this.env.ORIGIN) : current.repoUrl;
      let repoUrl = current.repoUrl;
      if (body.buildFrom === 'copy' && !copy) repoUrl = ownCopy || fail(409, 'not_in_smith', 'This project has no copy in Smith to build from; use Copy into Smith first');
      if (body.buildFrom === 'repository' && copy) repoUrl = source || fail(409, 'detached', 'This copy is no longer linked to a repository, so it can only build from the copy');
      const base: RepoProject = isRepoProject(current) ? current : {
        kind: 'repo', id: current.id, name: current.name, customName: true, repoUrl: current.repoUrl, source: 'git', branch: current.branch, commit: null,
        scan: { state: 'waiting', message: '', via: null, host: null, jobId: null, at: now }, actions: [], unusedRules: 0, disabledRules: 0, warnings: [], createdAt: now,
        createdBy: userId, ...(current.artifacts ? { artifacts: current.artifacts } : {}), ...(current.hosted ? { hosted: current.hosted } : {}) };
      const branch = typeof body.branch === 'string' ? body.branch.trim() : base.branch;
      const next: RepoProject = { ...base, repoUrl, branch, ...(typeof body.name === 'string' ? { name: body.name.trim(), customName: true } : {}) };
      return { next, reread: !isRepoProject(current) || branch !== base.branch || repoUrl !== base.repoUrl };
    };
    const first = plan(Date.now());
    const scanning = (id: string | null) => Boolean(id && this.sql.exec("SELECT id FROM jobs WHERE id = ? AND state IN ('queued', 'leased', 'running')", id).toArray().length);
    const read = first.reread ? await this.readProject(first.next, userId) : null;
    const readToken = first.reread && !read?.report ? await this.artifactsReadToken(first.next) : '';
    const response = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const { next, reread } = plan(now);
      let saved = next;
      if (reread) {
        // A scan of the old branch or source still queued is overtaken: cancel it so its report cannot land on the new one.
        if (scanning(next.scan.jobId)) { this.sql.exec("UPDATE jobs SET state = 'cancelled', updated_at = ?, revision = revision + 1 WHERE id = ? AND state = 'queued'", now, next.scan.jobId); this.event(next.scan.jobId!); }
        this.repoAccess.clear(projectId);
        const fresh = { ...next, scan: { ...next.scan, jobId: null }, commit: null };
        saved = read?.report && fresh.repoUrl === first.next.repoUrl && fresh.branch === first.next.branch ? applyReport(fresh, read.report, 'github', null, now) : this.queueScan(fresh, now, read?.note ?? '', readToken);
      }
      this.sql.exec('UPDATE projects SET definition = ? WHERE id = ?', JSON.stringify(saved), projectId);
      return json(this.publicProject(saved, now));
    });
    await this.schedule();
    return response;
  }
  private async rescanProject(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['projectId']);
    const projectId = string(body, 'projectId', 64);
    this.requireHuman(userId, true, true);
    const project = this.anyProject(projectId);
    if (!project) fail(404, 'not_found', 'Project not found');
    if (!isRepoProject(project)) fail(409, 'unsupported_project', 'Rescan is for projects added from a Git URL');
    if (project.hosted?.init && project.hosted.status !== 'ready') fail(409, 'hosted_pending', 'Smith has not created this project’s repository yet');
    const active = (id: string | null) => Boolean(id && this.sql.exec("SELECT id FROM jobs WHERE id = ? AND state IN ('queued', 'leased', 'running')", id).toArray().length);
    const read = active(project.scan.jobId) ? null : await this.readProject(project, userId);
    const readToken = active(project.scan.jobId) ? '' : await this.artifactsReadToken(project);   // a scan of the Artifacts copy needs it to clone
    const response = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const current = this.anyProject(projectId);
      if (!isRepoProject(current)) fail(404, 'not_found', 'Project not found');
      this.repoAccess.clear(projectId);                 // every machine gets another chance
      let saved: RepoProject = current;
      if (!active(current.scan.jobId)) saved = read?.report ? applyReport({ ...current, scan: { ...current.scan, jobId: null } }, read.report, 'github', null, now) : this.queueScan(current, now, read?.note ?? '', readToken);
      this.saveProject(saved);
      return json(this.publicProject(saved, now));
    });
    await this.schedule();
    return response;
  }
  // ---- Build on push (push-builds.ts) ----

  // Turn the GitHub push hook on or off. On: a fresh secret, registered on the repository through the first GitHub token that
  // can (the person's own link, then other members', then Settings); when none can, the hook is "manual" and the response
  // carries the URL and secret once, for the person to add on GitHub. Off: the registered hook is removed (best effort).
  private async pushBuilds(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['projectId', 'enabled']);
    const projectId = string(body, 'projectId', 64);
    if (typeof body.enabled !== 'boolean') fail(400, 'invalid_field', 'Invalid field: enabled');
    this.requireHuman(userId, true, true);
    const project = this.anyProject(projectId);
    if (!project) fail(404, 'not_found', 'Project not found');
    if (!isRepoProject(project)) fail(409, 'unsupported_project', 'Build on push is for projects added from a Git URL');
    const url = hookUrl(this.env.ORIGIN, this.workspaceId(), project.id);
    const hooks = githubHooks(this.env);
    // The repository people push to: the linked one when the project builds from Smith's copy (upstream.ts), else its own.
    const copy = copyOf(project, this.env.ORIGIN);
    const repoUrl = (copy && upstreamOf(copy, this.env.ORIGIN)) || project.repoUrl;
    const onGitHub = Boolean(githubRepo(repoUrl));
    let next: PushHook | undefined; let secret = '';
    if (body.enabled) {
      secret = randomToken();
      next = { enabled: true, secret, hookId: null, via: 'manual', message: '', lastDelivery: project.push?.lastDelivery ?? null, updatedAt: Date.now() };
      // Smith's copy with nothing linked: pushes arrive at the copy itself, so nothing needs registering anywhere.
      if (copy && !upstreamOf(copy, this.env.ORIGIN)) next.via = 'smith';
      else if (!onGitHub) next.message = 'Not a GitHub repository: add the webhook on your Git host by hand (JSON, push events).';
      else {
        const tokens = await this.githubTokens(userId);
        let reason = tokens.length ? '' : 'nobody in the workspace has linked GitHub';
        for (const token of tokens) {
          try { next.hookId = await hooks.create(repoUrl, token, url, secret); next.via = 'github'; break; }
          catch (error) { reason = error instanceof GitHubReadError ? error.message : error instanceof Error && error.name === 'TimeoutError' ? 'GitHub did not answer in time' : 'GitHub could not be reached'; }
        }
        if (next.via === 'manual') next.message = `Smith could not add the webhook to the repository (${reason}). Add it on GitHub by hand: Settings → Webhooks, JSON, push events.`;
      }
    } else if (project.push?.hookId !== null && project.push?.hookId !== undefined && onGitHub) {
      for (const token of await this.githubTokens(userId)) {
        try { await hooks.remove(repoUrl, token, project.push.hookId); break; } catch { /* the hook may stay on GitHub; its deliveries are refused once the secret is gone */ }
      }
    }
    const response = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const current = this.anyProject(projectId);
      if (!isRepoProject(current)) fail(404, 'not_found', 'Project not found');
      const { push: _old, ...rest } = current;
      const saved: RepoProject = next ? { ...rest, push: next } : rest;
      this.saveProject(saved);
      // The secret is shown once, only when the person has to add the hook themselves.
      return json({ project: this.publicProject(saved, now), url, ...(next && next.via === 'manual' ? { secret } : {}) });
    });
    return response;
  }

  // Removing a project (owners and admins): Smith stops listing and building it. Builds still queued for it are cancelled;
  // one already on a machine must finish or be cancelled first, and a crew member whose main project it is must be given
  // another. Its Build on push hook comes off GitHub, the machines throw away their copies of it and its backups go, and
  // other crew members stop reading it. Build history stays. A Cloudflare Artifacts copy stays in that account.
  private async removeProject(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['projectId']);
    const projectId = string(body, 'projectId', 64);
    this.requireHuman(userId, true, true);
    const project = this.anyProject(projectId) ?? fail(404, 'not_found', 'Project not found');
    // A project a crew member created has its own record (and write tokens): the crew's delete handles it.
    if (crewCreated(project)) return await this.execute({ kind: 'human', userId }, 'crew-project-delete', { projectId });
    const blocked = () => {
      const running = this.sql.exec<{ product: string }>("SELECT product FROM jobs WHERE project_id = ? AND state IN ('leased', 'running') LIMIT 1", projectId).toArray()[0];
      if (running) fail(409, 'build_running', `A ${running.product} build of this project is running; cancel it or let it finish, then remove the project`);
      const main = this.sql.exec<{ name: string }>("SELECT name FROM crew_members WHERE json_extract(project_ids, '$[0]') = ?", projectId).toArray().map(m => m.name);
      if (main.length) fail(409, 'project_in_use', `${main.join(', ')} ${main.length === 1 ? 'works' : 'work'} on this project as ${main.length === 1 ? 'its' : 'their'} main project; give ${main.length === 1 ? 'it' : 'them'} another project or delete ${main.length === 1 ? 'it' : 'them'} first`);
      if (project.hosted?.status === 'copying' || (project.artifacts && ['pushing', 'verifying'].includes(project.artifacts.status))) fail(409, 'hosted_pending', 'Smith is still copying this project; remove it once the copy finishes');
    };
    blocked();
    // The hook comes off GitHub before the record goes (it needs the hook ID); a failure leaves a hook whose deliveries are refused.
    const push = isRepoProject(project) ? project.push : undefined;
    if (push?.hookId !== null && push?.hookId !== undefined) {
      const copy = copyOf(project, this.env.ORIGIN);
      const repoUrl = (copy && upstreamOf(copy, this.env.ORIGIN)) || project.repoUrl;
      if (githubRepo(repoUrl)) for (const token of await this.githubTokens(userId)) { try { await githubHooks(this.env).remove(repoUrl, token, push.hookId); break; } catch { /* try the next link */ } }
    }
    let backupKeys: string[] = [];
    const artifacts = project.artifacts; const cached = artifacts ? new ArtifactsTokens(this.sql).forProject(projectId) : [];
    const response = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      if (!this.anyProject(projectId)) fail(404, 'not_found', 'Project not found');
      blocked();
      this.sql.exec('DELETE FROM artifacts_tokens WHERE project_id = ?', projectId);
      for (const job of this.sql.exec<JobRow>("SELECT * FROM jobs WHERE project_id = ? AND state = 'queued'", projectId).toArray()) {
        this.sql.exec("UPDATE jobs SET state = 'cancelled', updated_at = ?, revision = revision + 1 WHERE id = ?", now, job.id); this.event(job.id);
        this.gitOps.settleJob(job, 'The project was removed', now);
      }
      backupKeys = this.gitOps.removeRepo(projectId, now);
      this.repoAccess.clear(projectId);
      this.sql.exec('DELETE FROM projects WHERE id = ?', projectId);
      for (const m of this.sql.exec<{ id: string; project_ids: string }>('SELECT id, project_ids FROM crew_members').toArray()) {
        const ids = JSON.parse(m.project_ids) as string[];
        if (ids.includes(projectId)) this.sql.exec('UPDATE crew_members SET project_ids = ? WHERE id = ?', JSON.stringify(ids.filter(id => id !== projectId)), m.id);
      }
      return json({ removed: true });
    });
    await this.gitOps.deleteBackups(backupKeys);
    // The repository in storage goes with the project (spec §3); a failed delete is said, never hidden.
    if (artifacts) {
      const client = this.artifactsFor(artifacts.accountId);
      for (const t of cached) { try { await client.revokeToken(artifacts.repo, t.tokenId); } catch { /* lapses */ } }
      try { await client.deleteRepo(artifacts.repo); }
      catch (error) { console.error(JSON.stringify({ event: 'artifacts_delete_failed', projectId, message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' })); return json({ removed: true, message: `Smith no longer lists ${projectId}; its repository in Smith’s storage could not be deleted and may remain.` }); }
    }
    return response;
  }

  // Choose what a push builds (owners and admins): the action IDs to build, or null to go back to smith.json's webhook triggers.
  private pushChoose(userId: string, body: Record<string, unknown>): Response {
    fields(body, ['projectId', 'actions']);
    const projectId = string(body, 'projectId', 64);
    this.requireHuman(userId, true, true);
    if (body.actions !== null && (!Array.isArray(body.actions) || body.actions.length > 200 || body.actions.some(id => typeof id !== 'string' || id.length > 300))) fail(400, 'invalid_field', 'actions must be a list of action IDs, or null');
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const project = this.anyProject(projectId);
      if (!isRepoProject(project)) fail(404, 'not_found', 'Project not found');
      const { pushChoice: _old, ...rest } = project;
      let saved: RepoProject = rest;
      if (body.actions !== null) {
        const known = new Set(project.actions.map(a => a.id)), chosen = [...new Set(body.actions as string[])];
        const unknown = chosen.filter(id => !known.has(id));
        if (unknown.length) fail(400, 'unknown_action', `This project has no action ${unknown[0]}; rescan it if smith.json changed`);
        saved = { ...rest, pushChoice: project.actions.map(a => a.id).filter(id => chosen.includes(id)) };   // smith.json order
      }
      this.saveProject(saved);
      return json(this.publicProject(saved, now));
    });
  }

  // Whether a new build replaces the project's queued build of the same action on the same branch (owners and admins):
  // true or false for this project, or null to follow the workspace setting again.
  private replaceQueuedChoose(userId: string, body: Record<string, unknown>): Response {
    fields(body, ['projectId', 'enabled']);
    const projectId = string(body, 'projectId', 64);
    this.requireHuman(userId, true, true);
    if (body.enabled !== null && typeof body.enabled !== 'boolean') fail(400, 'invalid_field', 'enabled must be true, false or null');
    return this.ctx.storage.transactionSync(() => {
      const project = this.anyProject(projectId);
      if (!isRepoProject(project)) fail(404, 'not_found', 'Project not found');
      const { replaceQueued: _old, ...rest } = project;
      const saved: RepoProject = body.enabled === null ? rest : { ...rest, replaceQueued: body.enabled as boolean };
      this.saveProject(saved);
      return json(this.publicProject(saved, Date.now()));
    });
  }

  // A webhook delivery from GitHub. Nothing is trusted before the signature matches the project's secret. A push to the
  // project's branch re-reads smith.json at the pushed commit through GitHub when a link can (so the triggers and actions
  // follow the push), then queues the branch-tip build of every action the webhook triggers name; a burst of pushes
  // supersedes the still-queued build when the workspace setting says so, as a dashboard build would.
  private async pushDelivery(body: Record<string, unknown>): Promise<Response> {
    fields(body, ['projectId', 'event', 'deliveryId', 'signature', 'payload']);
    const projectId = string(body, 'projectId', 64);
    const event = typeof body.event === 'string' ? body.event.slice(0, 32) : '';
    const deliveryId = typeof body.deliveryId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(body.deliveryId) ? body.deliveryId : crypto.randomUUID();
    const signature = typeof body.signature === 'string' ? body.signature : '';
    const payload = typeof body.payload === 'string' ? body.payload : '';
    const project = this.anyProject(projectId);
    if (!isRepoProject(project) || !project.push?.enabled) fail(404, 'not_found', 'No push hook for this project');
    if (!await verifySignature(project.push.secret, payload, signature)) fail(401, 'bad_signature', 'The signature does not match this project’s webhook secret');
    if (!(PUSH_EVENTS as readonly string[]).includes(event)) return json({ accepted: false, reason: `ignored: ${event || 'unknown'} event` });
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { fail(400, 'invalid_json', 'Invalid JSON'); }
    if (event === 'ping') return json({ accepted: true, reason: 'pong' });
    const push = parsePush(parsed);
    const record = (outcome: string, jobIds: string[] = []): PushDelivery => ({ at: Date.now(), event, deliveryId, branch: push.branch ?? '', commit: push.commit, outcome, jobIds });
    const finish = (delivery: PushDelivery, fresh?: RepoProject, status = 200) => this.ctx.storage.transactionSync(() => {
      const current = this.anyProject(projectId);
      if (!isRepoProject(current) || !current.push) return json({ accepted: false, reason: 'the project changed' }, 409);
      const base = fresh ?? current;
      this.saveProject({ ...base, push: { ...current.push, lastDelivery: delivery } });
      return json({ accepted: delivery.jobIds.length > 0, reason: delivery.outcome, jobIds: delivery.jobIds }, status);
    });
    if (push.branch === null) return finish(record('ignored: not a branch push'));
    if (push.deleted) return finish(record('ignored: branch deleted'));
    if (project.branch && push.branch !== project.branch) return finish(record(`ignored: push to ${push.branch}, this project builds ${project.branch}`));
    // A project that builds from Smith's copy: the pushed commit comes into the copy with a Pull first, then it builds.
    const copy = copyOf(project, this.env.ORIGIN);
    if (copy) {
      // The same commit pushed into the copy first (then Pushed on to GitHub) is already building: answer, record nothing.
      const seen = project.push.pending?.delivery ?? project.push.lastDelivery;
      if (seen?.commit === push.commit && (project.push.pending || seen.jobIds.length)) return json({ accepted: false, reason: `already building ${push.commit.slice(0, 12)}`, jobIds: seen.jobIds });
      const delivery = record('');
      if (await this.copyHead(project) === push.commit) return await this.buildPushed(projectId, delivery);
      return await this.pullPushed(projectId, delivery);
    }
    // Follow the push: re-read smith.json at the pushed commit where a GitHub link allows (outside the transaction).
    const read = await this.readViaGitHub(project);
    const now = Date.now();
    const fresh = read.report ? applyReport({ ...project, scan: { ...project.scan, jobId: null } }, read.report, 'github', null, now) : project;
    if (fresh.scan.state !== 'ready') return finish(record(`nothing built: ${fresh.scan.message || 'smith.json could not be read'}`), fresh);
    if (!pushActions(fresh).length) return finish(record(fresh.pushChoice ? 'nothing built: none of the actions chosen to build on push exists on this branch' : 'nothing built: smith.json has no webhook trigger for this branch'), fresh);
    return this.ctx.storage.transactionSync(() => {
      const current = this.anyProject(projectId);
      if (!isRepoProject(current) || !current.push) return json({ accepted: false, reason: 'the project changed' }, 409);
      // Save the re-read project first so the queued builds see its actions.
      this.saveProject({ ...fresh, push: current.push });
      const delivery = this.queuePushBuilds(projectId, record(''), now);
      return json({ accepted: delivery.jobIds.length > 0, reason: delivery.outcome, jobIds: delivery.jobIds }, delivery.jobIds.length ? 202 : 200);
    });
  }
  // Queue the builds smith.json's webhook triggers name for a push (inside a transaction, the project already re-read), and
  // record the delivery with its outcome. The request IDs carry the delivery's, so a redelivery answers with the same builds.
  private queuePushBuilds(projectId: string, delivery: PushDelivery, now: number): PushDelivery {
    const project = this.anyProject(projectId);
    if (!isRepoProject(project) || !project.push) return delivery;
    const actions = pushActions(project);
    const jobIds: string[] = []; const queued: string[] = []; const problems: string[] = [];
    for (const action of actions) {
      try { jobIds.push(this.enqueueBuild(projectId, action, `push-${delivery.deliveryId}-${action}`, now, '').id); queued.push(action); }
      catch (error) { problems.push(`${action}: ${error instanceof HttpError ? error.message : 'could not be queued'}`); }
    }
    const outcome = !actions.length ? (project.pushChoice ? 'nothing built: none of the actions chosen to build on push exists on this branch' : 'nothing built: smith.json has no webhook trigger for this branch')
      : jobIds.length ? `queued ${jobIds.length} build${jobIds.length === 1 ? '' : 's'} (${queued.join(', ')})${problems.length ? '; ' + problems.join('; ') : ''}` : `nothing built: ${problems.join('; ')}`;
    const done = { ...delivery, outcome, jobIds };
    const { pending: _pending, ...push } = project.push;
    this.saveProject({ ...project, push: { ...push, lastDelivery: done } });
    return done;
  }
  // Where a push to a copy-built project stands, shown on the card until it builds (or cannot).
  // stage null: it is over (the outcome says why nothing was built). The delivery defaults to the one waiting.
  private pushWaiting(projectId: string, stage: PushPending['stage'] | null, outcome: string, delivery?: PushDelivery): void {
    const project = this.anyProject(projectId);
    if (!isRepoProject(project) || !project.push) return;
    const { pending, ...push } = project.push;
    const base = delivery ?? pending?.delivery;
    if (!base) return;
    const next = { ...base, outcome };
    this.saveProject({ ...project, push: stage ? { ...push, pending: { stage, delivery: next } } : { ...push, lastDelivery: next } });
  }
  // The head of the project's branch in Smith's copy: the record for a copy on Smith's machines, the API for Artifacts.
  private async copyHead(project: RepoProject): Promise<string | null> {
    const copy = copyOf(project, this.env.ORIGIN);
    if (!copy || !project.branch) return null;
    if (copy.kind === 'hosted') return (JSON.parse(this.hostedGit.repo(project.id)?.refs_json ?? '[]') as [string, string][]).find(([, ref]) => ref === `refs/heads/${project.branch}`)?.[0] ?? null;
    try { return await this.artifactsFor(project.artifacts!.accountId).branchHead(project.artifacts!.repo, project.branch); } catch { return null; }
  }
  // Read a project's smith.json without a machine when GitHub can: the repository itself, or for a project that builds from
  // Smith's copy the repository it is linked to, accepted only when GitHub's branch head is the copy's (same commit, same file).
  private async readProject(project: RepoProject, preferUser?: string): Promise<{ report: ScanReport | null; note: string }> {
    const copy = copyOf(project, this.env.ORIGIN);
    if (!copy) return await this.readViaGitHub(project, preferUser);
    const linked = upstreamOf(copy, this.env.ORIGIN);
    if (!linked || !githubRepo(linked)) return { report: null, note: '' };
    const [head, read] = await Promise.all([this.copyHead(project), this.readViaGitHub({ ...project, repoUrl: linked }, preferUser)]);
    return read.report && head && read.report.commit === head ? { report: read.report, note: '' } : { report: null, note: '' };
  }
  // The pushed commit is not in the copy yet: Pull it in (or wait for the Pull under way), then build (advancePushes).
  private async pullPushed(projectId: string, delivery: PushDelivery): Promise<Response> {
    const project = this.anyProject(projectId) as RepoProject; const copy = copyOf(project, this.env.ORIGIN)!;
    let outcome = `pulling ${delivery.commit.slice(0, 12)} into Smith’s copy, then building`;
    if (!syncRunning(copy)) {
      try { await this.startSync(projectId, 'pull', `push-${delivery.deliveryId}-pull`); }
      catch (error) {
        const reason = error instanceof HttpError ? error.message : 'the Pull could not start';
        this.ctx.storage.transactionSync(() => this.pushWaiting(projectId, null, `nothing built: ${reason}`, delivery));
        return json({ accepted: false, reason: `nothing built: ${reason}` });
      }
    } else outcome = `waiting for the ${copy.sync!.direction} under way, then pulling ${delivery.commit.slice(0, 12)} and building`;
    this.ctx.storage.transactionSync(() => this.pushWaiting(projectId, 'pull', outcome, delivery));
    return json({ accepted: true, reason: outcome, jobIds: [] }, 202);
  }
  // The pushed commit is in the copy: read smith.json at it (GitHub when it can, else a machine), then queue the builds.
  private async buildPushed(projectId: string, delivery: PushDelivery): Promise<Response> {
    const project = this.anyProject(projectId);
    if (!isRepoProject(project)) return json({ accepted: false, reason: 'the project changed' }, 409);
    const read = await this.readProject(project);
    const readToken = read.report ? '' : await this.artifactsReadToken(project);
    const response = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const current = this.anyProject(projectId);
      if (!isRepoProject(current) || !current.push) return json({ accepted: false, reason: 'the project changed' }, 409);
      if (read.report) {
        this.saveProject(applyReport({ ...current, scan: { ...current.scan, jobId: null } }, read.report, 'github', null, now));
        const fresh = this.anyProject(projectId) as RepoProject;
        if (fresh.scan.state !== 'ready') { this.pushWaiting(projectId, null, `nothing built: ${fresh.scan.message || 'smith.json could not be read'}`, delivery); return json({ accepted: false }); }
        const done = this.queuePushBuilds(projectId, delivery, now);
        return json({ accepted: done.jobIds.length > 0, reason: done.outcome, jobIds: done.jobIds }, done.jobIds.length ? 202 : 200);
      }
      // A machine reads smith.json at the new commit; finishScan queues the builds.
      this.repoAccess.clear(projectId);
      this.saveProject(this.queueScan({ ...current, scan: { ...current.scan, jobId: null } }, now, 'Reading smith.json at the pushed commit.', readToken));
      this.pushWaiting(projectId, 'scan', `reading smith.json at ${delivery.commit.slice(0, 12)}, then building`, delivery);
      return json({ accepted: true, reason: 'reading smith.json, then building', jobIds: [] }, 202);
    });
    await this.schedule();
    return response;
  }
  // Pushes waiting on a Pull: once it is over, build if the commit arrived, Pull again if the Pull started before the push
  // (it cannot have it), or say why nothing was built.
  private async advancePushes(): Promise<void> {
    for (const project of this.allProjects()) {
      if (!isRepoProject(project) || project.push?.pending?.stage !== 'pull') continue;
      const pending = project.push.pending, copy = copyOf(project, this.env.ORIGIN);
      if (!copy) { this.ctx.storage.transactionSync(() => this.pushWaiting(project.id, null, 'nothing built: the project no longer builds from Smith’s copy')); continue; }
      if (syncRunning(copy)) continue;
      const sync = copy.sync, startedAt = sync ? this.sql.exec<{ created_at: number }>('SELECT created_at FROM jobs WHERE id = ?', sync.jobId).toArray()[0]?.created_at ?? 0 : 0;
      const head = await this.copyHead(project);
      if (head === pending.delivery.commit || (sync?.status === 'done' && startedAt >= pending.delivery.at && head)) { await this.buildPushed(project.id, { ...pending.delivery, commit: head! }); continue; }
      if (sync && startedAt >= pending.delivery.at) { this.ctx.storage.transactionSync(() => this.pushWaiting(project.id, null, `nothing built: ${sync.status === 'failed' ? sync.message || 'the Pull failed' : `${project.branch} is not in Smith’s copy after the Pull`}`)); continue; }
      await this.pullPushed(project.id, pending.delivery);
    }
  }
  // A push straight into Smith's copy (git push to this site, or a merge in Smith) is the trigger itself: no webhook involved.
  // Called inside the relay's transaction when the copy's record moved; a Pull's own push is left to advancePushes.
  private copyPushed(repoId: string, before: string, after: string, now: number): void {
    const project = this.anyProject(repoId);
    if (!isRepoProject(project) || !project.branch) return;
    const copy = copyOf(project, this.env.ORIGIN);
    if (!copy || (syncRunning(copy) && copy.sync!.direction === 'pull')) return;
    const ref = `refs/heads/${project.branch}`, head = (refs: string) => (JSON.parse(refs) as [string, string][]).find(([, r]) => r === ref)?.[0] ?? '';
    const commit = head(after);
    if (!commit || commit === head(before)) return;
    // Without Build on push, only a project never read yet (a new repository's first push) is read, so its card fills in.
    if (!project.push?.enabled) {
      const scanning = project.scan.jobId && this.sql.exec("SELECT id FROM jobs WHERE id = ? AND state IN ('queued', 'leased', 'running')", project.scan.jobId).toArray().length;
      // A project started in Smith has no other place a smith.json could be read from: every push to it is read.
      if ((!project.commit || project.source === 'smith') && !scanning) this.saveProject(this.queueScan({ ...project, scan: { ...project.scan, jobId: null } }, now, project.commit ? 'Reading smith.json after a push.' : 'Reading smith.json from the first push.'));
      return;
    }
    const delivery: PushDelivery = { at: now, event: 'push', deliveryId: `smith-${crypto.randomUUID()}`, branch: project.branch, commit, outcome: '', jobIds: [] };
    this.repoAccess.clear(project.id);
    this.saveProject(this.queueScan({ ...project, scan: { ...project.scan, jobId: null } }, now, 'Reading smith.json at the pushed commit.'));
    this.pushWaiting(project.id, 'scan', `pushed to Smith’s copy: reading smith.json at ${commit.slice(0, 12)}, then building`, delivery);
  }

  private finishScan(job: JobRow, result: JobResult, report: ScanReport | undefined, problem: string, node: NodeRow, now: number): void {
    const project = this.anyProject(job.project_id);
    if (!isRepoProject(project) || project.scan.jobId !== job.id) return;     // superseded by a rescan
    const failure = problem ? `Smith could not use what ${node.hostname || 'the machine'} read: ${problem}`
      : result.status === 'success' ? 'The machine returned no scan report' : result.message || 'Reading smith.json failed';
    const saved = result.status === 'success' && report ? applyReport(project, report, 'machine', node.hostname, now)
      : { ...project, scan: { ...project.scan, state: 'error' as const, message: failure, at: now } };
    this.saveProject(saved);
    // A push waiting for this read builds now, or says why it cannot.
    const pending = saved.push?.pending;
    if (pending?.stage === 'scan') {
      if (saved.scan.state === 'ready') this.queuePushBuilds(saved.id, pending.delivery, now);
      else this.pushWaiting(saved.id, null, `nothing built: ${saved.scan.message || 'smith.json could not be read'}`);
    }
  }
}
