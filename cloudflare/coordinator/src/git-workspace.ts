// The workspace Durable Object's side of Smith-hosted repositories (src/git-host.ts): the host job that makes the
// first copy, tickets for machines and AI turns, the relay a git client waits on, and every git-* action a person,
// a ticket or a machine sends. Kept out of workspace.ts, which only dispatches here; `c` is what it needs from the object.
import { fail, json, errorResponse, fields, string, hash, randomToken, HttpError, object } from './http';
import { LfsStore, DEFAULT_LFS_QUOTA_BYTES, DEFAULT_LFS_RESERVE_BYTES, LFS_AUDIT_BATCH, LFS_PENDING_TTL_MS, OID, lfsKey, type LfsObjectRequest, LFS_LABEL } from './lfs';
import { LfsTasks, LFS_TASKS_PER_POLL, LFS_PLAN_LIMIT, nodeFreeBytes } from './lfs-tasks';
import { planCopies, type CopyItem, type CopyNode, type CopyPlan, type CopyPlanInput } from './copies';
import { DEFAULT_COPY_BUDGET_BYTES, DEFAULT_COPIES_PER_ITEM, MAX_IMPORT_THRESHOLD_BYTES, integer } from './settings';
import type { Principal, JobResult, ResolvedJobSpec } from './contracts';
import type { Project } from './projects';
import type { RepoProject } from './repo-projects';
import { isRepoProject, validBranch, createSmithProject, applyReport, createRepoProject, newProjectId, validateRepoUrl } from './repo-projects';
import { slugifyName } from './pipeline';
import { mirrorSpecs, type ProjectArtifacts } from './projects';
import { isArtifactsRemote, WRITE_TOKEN_TTL, type ArtifactsClient, repoNameFor } from './artifacts-repos';
import { startOnArtifacts, windowedR2, firstCommitReport, machineCanTakeOver, startFailure, type ArtifactsStart } from './smith-projects';
import { assignHome, fitsArtifacts } from './home';
import { type ImportReport } from './contracts';
import { IMPORT_TOKEN_TTL_SECONDS, Imports, IMPORT_LABEL, IMPORT_PRODUCT, IMPORT_RETRY_MS, ORIGINAL_BLOB, OVERSIZE_MESSAGE, importSpecs, rewrittenMessage, validateImportReport, type ImportRepoRow } from './imports';
import { formatBytes } from './lfs';
import { HostedGit, GIT_HOST_LABEL, GIT_INIT_LABEL, GIT_NEW_LABEL, GIT_CLIENT_LABEL, HOST_PRODUCT, NEW_PRODUCT, MAX_IMPORT_BYTES, hostInitSpecs, hostEligible, RELAY_WAIT_MS, hostSpecs, validateTips, validatePeeled, validateRelayCompletion, validateHostReport, lsRefsLines, tipsDigest, newTicket, smithRemoteRepo, smithRemote, defaultRefPolicy, parseRefPolicy, cloneUsername, type Tips, type RefPolicy, type ProjectHosted, type RelayRow, type RepoRow, type LsRefsRequest, MOVE_PRODUCT, RESTORE_PRODUCT, MAX_REPO_BYTES, type ReplicaRow } from './git-host';
import { fetchTips, STORAGE_UNREACHABLE } from './git-proxy';
import type { JobRow, NodeRow } from './workspace';
import { GitTasks, type TaskRow, backupKey } from './git-tasks';

export interface GitContext {
  readonly sql: SqlStorage; readonly storage: DurableObjectStorage; readonly env: Env; readonly hostedGit: HostedGit;
  workspaceId(): string; hostNodes(): NodeRow[]; offlineMs(): number; hostingAvailable(now: number): boolean;
  settings(): Record<string, unknown>; proxyMaxBytes(): number;
  anyProject(id: string): Project | RepoProject | undefined; saveProject(project: Project | RepoProject): void; publicProject(project: Project | RepoProject, now: number): unknown;
  allProjects(): (Project | RepoProject)[]; projectIds(): ReadonlySet<string>; projectSlotsUsed(): number; insertProject(project: RepoProject): void;
  rescan(projectId: string, note: string, now: number): void;   // queue a scan of a repository project unless one is under way
  artifactsReady(): Promise<boolean>; artifacts(accountId?: string): ArtifactsClient; artifactsAccount(): { accountId: string; source: 'workspace' | 'smith' };
  job(id: string): JobRow; publicJob(job: JobRow): unknown; event(jobId: string): void; requireHuman(userId: string, write?: boolean, admin?: boolean): void; schedule(): Promise<void>;
  copyPushed(repoId: string, beforeRefs: string, afterRefs: string, now: number): void;
  artifactsToken(projectId: string, scope: 'read' | 'write'): Promise<string>;   // the proxy's cached repo-scoped token (workspace.ts artifactsToken)   // a push into Smith's copy moved its record (Build on push)
}

const TIPS_RETRY_MS = 60000;
const ARTIFACTS_REFRESH_MS = 24 * 3600000;   // tips of an Artifacts home re-read from the advertisement this often

export class GitOps {
  constructor(private readonly c: GitContext) {}
  private get tasks(): GitTasks { return new GitTasks(this.c.sql, this.c.hostedGit, this.c.workspaceId(), this.c.env.ORIGIN); }
  private get lfsTasks(): LfsTasks { return new LfsTasks(this.c.sql); }
  private reserveBytes(): number { const v = this.c.settings().lfsMachineReserveBytes; return typeof v === 'number' && v > 0 ? v : DEFAULT_LFS_RESERVE_BYTES; }
  // Whether a machine's git thread should poll: it is switched on and able to host somewhere, or it still owes a task.
  gitWanted(node: NodeRow, labels: string[]): boolean { return (Boolean(node.host_repos) && labels.includes(GIT_HOST_LABEL)) || this.tasks.pendingFor(node.id) || Boolean(node.host_lfs) || this.lfsTasks.pendingFor(node.id); }
  // Housekeeping run from the alarm (inside its transaction) and after the events that make work due: expired task
  // leases, a primary that is gone, copies to make, bundles to take, lost repositories to restore.
  reconcileGit(now: number): void {
    const nodes = this.c.hostNodes(), offlineMs = this.c.offlineMs(), tasks = this.tasks;
    tasks.expire(now, nodes, offlineMs);
    this.lfsTasks.expire(now, nodes);
    for (let repo of this.c.hostedGit.repos()) {
      if (!['hosting', 'oversize', 'degraded', 'lost'].includes(repo.state)) continue;
      repo = tasks.promote(repo, nodes, now, offlineMs);
      tasks.planBackup(repo, nodes, now, offlineMs);
      tasks.planRestore(repo, nodes, now, offlineMs);
    }
    this.planCopies(now);
  }
  // ---- copies on machines (spec §4): one budget per machine, a target number of copies per repository and large file ----
  nodeBudget(node: NodeRow): number { const v = this.c.settings().copyBudgetBytes; return node.copy_budget_bytes ?? (typeof v === 'number' && v > 0 ? v : DEFAULT_COPY_BUDGET_BYTES); }
  // What a machine holds: its repository and large-file copies that are not lost, plus what is queued or leased to it.
  nodeUsage(nodeId: string): number {
    const repos = this.c.sql.exec<{ b: number | null }>("SELECT SUM(bytes) AS b FROM git_replicas WHERE node_id = ? AND state != 'lost'", nodeId).one().b ?? 0;
    const lfs = this.c.sql.exec<{ b: number | null }>('SELECT SUM(o.size) AS b FROM lfs_replicas r JOIN lfs_objects o ON o.repo_id = r.repo_id AND o.oid = r.oid WHERE r.node_id = ?', nodeId).one().b ?? 0;
    const queuedLfs = this.c.sql.exec<{ b: number | null }>("SELECT SUM(o.size) AS b FROM lfs_tasks t JOIN lfs_objects o ON o.repo_id = t.repo_id AND o.oid = t.oid WHERE t.node_id = ? AND t.kind = 'fetch' AND t.state IN ('queued', 'leased')", nodeId).one().b ?? 0;
    const queuedRepos = this.c.sql.exec<{ b: number | null }>("SELECT SUM(json_extract(payload, '$.bytes')) AS b FROM git_tasks WHERE node_id = ? AND kind = 'replicate' AND state IN ('queued', 'leased')", nodeId).one().b ?? 0;
    return repos + lfs + queuedLfs + queuedRepos;
  }
  private copyPlanInput(now: number): CopyPlanInput {
    const nodes = this.c.hostNodes(), offlineMs = this.c.offlineMs(), settings = this.c.settings(), lfs = new LfsStore(this.c.sql);
    const online = (n: NodeRow) => Boolean(n.active) && n.purpose === 'build' && Boolean(n.host_repos) && !n.draining && n.last_seen_at > now - offlineMs;
    const switchedOn = (n: NodeRow) => Boolean(n.active) && n.purpose === 'build' && Boolean(n.host_repos) && !n.draining;
    const labelled = (n: NodeRow) => (JSON.parse(n.labels) as string[]).includes(GIT_HOST_LABEL);
    const copyNodes: CopyNode[] = nodes.map(n => ({ id: n.id, hostname: n.hostname, eligible: online(n), gitEligible: hostEligible(n, now, offlineMs), switchedOn: switchedOn(n), gitLabelled: labelled(n), freeBytes: nodeFreeBytes(n), budgetBytes: this.nodeBudget(n), usageBytes: this.nodeUsage(n.id) }));
    // Every holder and every pending task in one query each: a workspace holds thousands of large files, and the plan
    // runs on every nodes listing as well as every alarm.
    const group = (rows: { k: string; node_id: string }[]) => { const m = new Map<string, string[]>(); for (const r of rows) { const list = m.get(r.k) ?? []; list.push(r.node_id); m.set(r.k, list); } return m; };
    const repoReplicas = new Map<string, ReplicaRow[]>();
    for (const r of this.c.sql.exec<ReplicaRow>("SELECT * FROM git_replicas WHERE state != 'lost'").toArray()) { const list = repoReplicas.get(r.repo_id) ?? []; list.push(r); repoReplicas.set(r.repo_id, list); }
    const repoPending = group(this.c.sql.exec<{ k: string; node_id: string }>("SELECT repo_id AS k, node_id FROM git_tasks WHERE kind = 'replicate' AND state IN ('queued', 'leased')").toArray());
    const lfsHolders = group(this.c.sql.exec<{ k: string; node_id: string }>("SELECT repo_id || '/' || oid AS k, node_id FROM lfs_replicas ORDER BY held_at").toArray());
    const lfsPending = group(this.c.sql.exec<{ k: string; node_id: string }>("SELECT repo_id || '/' || oid AS k, node_id FROM lfs_tasks WHERE kind = 'fetch' AND state IN ('queued', 'leased')").toArray());
    const items: CopyItem[] = [];
    for (const repo of this.c.hostedGit.repos().filter(r => ['hosting', 'degraded', 'artifacts'].includes(r.state))) {
      const replicas = repoReplicas.get(repo.id) ?? [];
      items.push({ kind: 'repo', key: repo.id, repoId: repo.id, bytes: repo.bytes, createdAt: repo.created_at, copyable: repo.bytes <= MAX_REPO_BYTES,
        holders: replicas.map(r => ({ nodeId: r.node_id, current: r.state === 'current' && r.generation === repo.generation, primary: r.node_id === repo.primary_node_id, heldAt: r.last_sync_at ?? 0 })),
        pending: repoPending.get(repo.id) ?? [] });
    }
    for (const row of lfs.ready()) {
      const key = `${row.repo_id}/${row.oid}`;
      items.push({ kind: 'lfs', key, repoId: row.repo_id, oid: row.oid, bytes: row.size, createdAt: row.created_at, copyable: true,
        holders: (lfsHolders.get(key) ?? []).map(id => ({ nodeId: id, current: true, primary: false, heldAt: 0 })), pending: lfsPending.get(key) ?? [] });
    }
    return { nodes: copyNodes, items, copiesPerItem: typeof settings.copiesPerItem === 'number' ? settings.copiesPerItem : DEFAULT_COPIES_PER_ITEM, reserveBytes: this.reserveBytes(), lfsPlanLimit: LFS_PLAN_LIMIT };
  }
  dryPlan(now: number): CopyPlan { return planCopies(this.copyPlanInput(now)); }
  // The plan, applied: replicate and fetch tasks for copies to make or refresh, discard and drop tasks for shedding, and
  // restores of lost large files from any online holder (unchanged from the LFS design).
  planCopies(now: number): CopyPlan {
    const plan = this.dryPlan(now), tasks = this.tasks, lfs = new LfsStore(this.c.sql), nodes = this.c.hostNodes(), offlineMs = this.c.offlineMs();
    const replicate = (nodeId: string, repoId: string) => { const repo = this.c.hostedGit.repo(repoId)!; tasks.queue('replicate', repo, nodeId, { remote: smithRemote(this.c.env.ORIGIN, repo.id), defaultBranch: repo.default_branch, bytes: repo.bytes, recordTips: JSON.parse(repo.refs_json) as Tips }, now); };
    for (const f of [...plan.refreshes, ...plan.fetches]) { if (f.item.kind === 'repo') replicate(f.nodeId, f.item.repoId); else this.lfsTasks.queue('fetch', f.item.repoId, f.item.oid!, f.nodeId, now); }
    for (const d of plan.drops) {
      if (d.item.kind === 'repo') { const repo = this.c.hostedGit.repo(d.item.repoId)!; tasks.queue('discard', repo, d.nodeId, {}, now); this.c.sql.exec("UPDATE git_replicas SET state = 'lost' WHERE repo_id = ? AND node_id = ?", repo.id, d.nodeId); }
      else { this.lfsTasks.queue('drop', d.item.repoId, d.item.oid!, d.nodeId, now); lfs.forgetHeld(d.item.repoId, d.item.oid!, d.nodeId); }
    }
    for (const row of lfs.lostRows()) {
      if (this.lfsTasks.pendingRestore(row.repo_id, row.oid)) continue;
      const holder = lfs.holders(row.repo_id, row.oid).map(id => nodes.find(n => n.id === id)).find(n => n && n.active && n.last_seen_at > now - offlineMs);
      if (holder) this.lfsTasks.queue('restore', row.repo_id, row.oid, holder.id, now);
    }
    return plan;
  }
  // For Settings: what has fewer copies than asked, and which machines are full.
  underReplicated(now: number): { repos: number; lfs: number; fullHosts: string[] } {
    const plan = this.dryPlan(now);
    return { repos: plan.under.filter(i => i.kind === 'repo').length, lfs: plan.under.filter(i => i.kind === 'lfs').length, fullHosts: Object.entries(plan.full).filter(([, why]) => why).map(([id]) => this.c.hostNodes().find(n => n.id === id)?.hostname ?? id) };
  }
  // Large files: pending rows nobody finished within a day, and rows of projects that no longer exist, go with their
  // objects. Runs from the alarm outside its transaction because the R2 deletes are awaited.
  async sweepLfs(now: number): Promise<void> {
    const ws = this.c.workspaceId();
    const rows = this.c.storage.transactionSync(() => {
      const lfs = new LfsStore(this.c.sql);
      const gone = [...lfs.sweepPending(now - LFS_PENDING_TTL_MS), ...lfs.sweepRepos(id => Boolean(this.c.anyProject(id)))];
      for (const row of gone) { for (const holder of lfs.holders(row.repo_id, row.oid)) this.lfsTasks.queue('drop', row.repo_id, row.oid, holder, now); lfs.forgetHeld(row.repo_id, row.oid); }
      return gone;
    });
    const bucket = (this.c.env as { GIT?: R2Bucket }).GIT;
    for (const row of rows) { try { await bucket?.delete(lfsKey(ws, row.repo_id, row.oid)); } catch { /* best effort */ } }
    // The audit an owner asked for: a batch of ready objects checked against R2; a definite miss turns lost (an R2
    // error leaves the object for the next sweep), and restores are planned at once.
    const audit = this.c.storage.transactionSync(() => new LfsStore(this.c.sql).auditBatch(LFS_AUDIT_BATCH));
    if (!audit.length) return;
    const missing: typeof audit = []; const checked: typeof audit = [];
    for (const item of audit) {
      try { if (!await bucket?.head(lfsKey(ws, item.repo_id, item.oid))) missing.push(item); checked.push(item); } catch { /* next sweep */ }
    }
    this.c.storage.transactionSync(() => {
      const lfs = new LfsStore(this.c.sql);
      for (const m of missing) lfs.markLost(m.repo_id, m.oid);
      lfs.deleteAudit(checked);
      if (missing.length) this.planCopies(now);
    });
  }
  nextDue(now: number): number | null {
    const dues = [this.c.hostedGit.nextDue(now), this.tasks.nextDue(now), this.lfsTasks.nextDue(now), new LfsStore(this.c.sql).nextDue(now, LFS_PENDING_TTL_MS), this.importsDue(), this.tipsDue(now)].filter((d): d is number => typeof d === 'number');
    return dues.length ? Math.min(...dues) : null;
  }
  // An import row waiting for its automatic retry, and an Artifacts home whose tips are due a refresh (a post-push fetch
  // that failed, a copy reporting refs the record lacks): a quiet workspace has nothing else to wake the alarm for them.
  private importsDue(): number | null { return this.c.sql.exec<{ due: number | null }>("SELECT MIN(next_attempt_at) AS due FROM import_repos WHERE state = 'queued' AND job_id IS NULL AND next_attempt_at > 0").one().due; }
  private tipsDue(now: number): number | null { return this.c.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM git_repos WHERE tips_due != ''").one().n ? now + TIPS_RETRY_MS : null; }
  // The Hosted-on-Smith row of a project card: the record, its copies, backups, work in flight and recovered refs.
  publicHosted(repoId: string, now: number) {
    const repo = this.c.hostedGit.repo(repoId); if (!repo) return {};
    const nodes = this.c.hostNodes(), tasks = this.tasks;
    return { ...this.c.hostedGit.publicRepo(repo, nodes, now, this.c.offlineMs()), tasks: tasks.publicTasks(repo.id, nodes), backups: tasks.publicBackups(repo.id), recovered: tasks.publicRecovered(repo.id, nodes), requests: this.publicRequests(repo.id, now) };
  }
  // The copy's git requests as the card shows them: each one in flight (which machine was asked, how long ago, how far it
  // got), then the last few that ended and how. A Pull's or a clone's request otherwise waits with nothing to show.
  private publicRequests(repoId: string, now: number) {
    const hostname = (id: string) => this.c.sql.exec<{ hostname: string }>('SELECT hostname FROM nodes WHERE id = ?', id).toArray()[0]?.hostname || 'a machine';
    const shown = (r: RelayRow) => ({ host: hostname(r.node_id), what: r.writer ? 'push' : 'fetch', who: r.user_label || 'someone', state: r.state, status: r.status, message: r.message, ageMs: now - r.created_at, updatedAt: r.updated_at });
    const open = this.c.sql.exec<RelayRow>("SELECT * FROM git_relays WHERE repo_id = ? AND state IN ('open', 'ready', 'leased') ORDER BY created_at", repoId).toArray();
    const ended = this.c.sql.exec<RelayRow>("SELECT * FROM git_relays WHERE repo_id = ? AND state NOT IN ('open', 'ready', 'leased') AND op = 'rpc' ORDER BY updated_at DESC LIMIT 3", repoId).toArray();
    return { open: open.map(shown), recent: ended.map(shown) };
  }

  // A ticket: a short-lived credential for one repository, bound to the machine that will present it. Minted in its
  // own transaction before the one that hands out the work (hashing is async), harmless if that work never goes out.
  // The advertisement of an Artifacts home as the record's tips (spec §3): after a proxied push, daily from the alarm,
  // after Move to storage, and when a copy reports a digest the record lacks.
  async refreshArtifactsTips(repoId: string, reason: 'push' | 'alarm' | 'move' | 'copy'): Promise<boolean> {
    const repo = this.c.hostedGit.repo(repoId);
    const project = this.c.anyProject(repoId);
    if (!repo || repo.state !== 'artifacts' || !project?.artifacts) return false;
    const token = await this.c.artifactsToken(repoId, 'read');
    const fetched = await fetchTips(project.artifacts.remote, token);
    let changed = false;
    this.c.storage.transactionSync(() => {
      const now = Date.now(); const current = this.c.hostedGit.repo(repoId); if (!current || current.state !== 'artifacts') return;
      this.c.sql.exec("UPDATE git_repos SET tips_due = '' WHERE id = ?", repoId);
      const adopted = this.c.hostedGit.adoptArtifactsTips(current, fetched.tips, fetched.digest, fetched.peeled, now);
      changed = adopted.changed;
      if (!adopted.changed) return;
      this.c.hostedGit.audit(now, reason, repoId, 'tips', '', 0, 'adopted from Artifacts');
      if (reason === 'push') this.c.copyPushed(repoId, adopted.before, adopted.after, now);
      this.reconcileGit(now);   // copies of the new generation
    });
    if (changed) await this.c.schedule();
    return changed;
  }
  async mintTicket(repoId: string, scope: 'read' | 'write', nodeId: string | null, policy: RefPolicy | undefined, label: string, jobId: string | null = null): Promise<string> {
    const plain = newTicket(this.c.workspaceId()); const digest = await hash(plain);
    this.c.storage.transactionSync(() => this.c.hostedGit.issueTicket(digest, repoId, scope, { nodeId, jobId, policy, label }, Date.now()));
    return plain;
  }
  // At claim: a job whose source is a Smith-hosted repository either clones this machine's own current copy (verifying
  // the tip the record expects) or carries a ticket bound to this machine and this job.
  attachHostedSource(spec: ResolvedJobSpec, job: JobRow, node: NodeRow, ticket: { token: string; hash: string } | undefined, now: number): void {
    const source = spec.repos[0];
    const repoId = smithRemoteRepo(source.url, this.c.env.ORIGIN); if (!repoId) return;
    const repo = this.c.hostedGit.repo(repoId);
    if (!repo || !['hosting', 'oversize', 'degraded', 'artifacts'].includes(repo.state)) return;   // the agent's clone then fails with git's own message
    const held = this.c.hostedGit.replicas(repo.id).find(r => r.node_id === node.id && r.state === 'current' && r.generation === repo.generation);
    if (held) {
      const tips = JSON.parse(repo.refs_json) as Tips;
      source.hostedUuid = repo.uuid;
      source.tip = source.commit || tips.find(([, ref]) => ref === `refs/heads/${source.branch || repo.default_branch}`)?.[0] || '';
      return;
    }
    // A job queued with its own ticket (a pull request's merge, which may write the base branch) keeps it.
    if (!ticket || source.authToken) return;
    this.c.hostedGit.issueTicket(ticket.hash, repo.id, 'read', { nodeId: node.id, jobId: job.id, ttlMs: ((spec.timeoutSeconds || 3600) + 600) * 1000, label: 'build' }, now);
    source.authToken = ticket.token;
  }
  // "Keep large files here" switched off: the machine drops every copy it holds; the record forgets them now.
  lfsSwitchedOff(node: NodeRow, now: number): void {
    const lfs = new LfsStore(this.c.sql);
    this.lfsTasks.cancelFor(node.id, ['fetch', 'restore']);
    for (const row of lfs.heldRows(node.id)) { this.lfsTasks.queue('drop', row.repo_id, row.oid, node.id, now); lfs.forgetHeld(row.repo_id, row.oid, node.id); }
  }
  // A build of a project that keeps large files: a read ticket for its LFS endpoint, in the spec's `lfs` field. The
  // claim's ticket is reused when attachHostedSource already issued it for the same project (one ticket, one job).
  attachLfsSource(spec: ResolvedJobSpec, job: JobRow, node: NodeRow, ticket: { token: string; hash: string } | undefined, now: number): void {
    if (!ticket || spec.kind !== 'build' || !new LfsStore(this.c.sql).readyCount(spec.projectId)) return;
    if (spec.repos[0]?.authToken !== ticket.token) this.c.hostedGit.issueTicket(ticket.hash, spec.projectId, 'read', { nodeId: node.id, jobId: job.id, ttlMs: ((spec.timeoutSeconds || 3600) + 600) * 1000, label: 'build' }, now);
    spec.lfs = { url: smithRemote(this.c.env.ORIGIN, spec.projectId), authToken: ticket.token };
  }
  // A host job that ended without success (failed, lost, cancelled, machine removed): the project stays where it was.
  settleJob(job: JobRow, message: string, now: number): void {
    this.c.hostedGit.revokeJobTickets(job.id, now);
    if (job.kind !== 'host') return;
    const result = job.result ? JSON.parse(job.result) as JobResult : null;
    this.c.hostedGit.failHost(job.project_id, result?.message || message, now);
    const project = this.c.anyProject(job.project_id);
    if (project?.hosted?.jobId === job.id && project.hosted.status === 'copying') this.c.saveProject({ ...project, hosted: { ...project.hosted, status: 'failed', message: result?.message || message, updatedAt: now } } as Project);
  }
  // The host job succeeded: the machine that ran it holds the first copy and is the primary; the project now builds from it.
  finishHost(job: JobRow, result: JobResult, digest: string, node: NodeRow, now: number): void {
    if (result.status !== 'success' || !result.host) { this.settleJob({ ...job, result: JSON.stringify(result) }, result.status === 'success' ? 'The machine returned no report of the copy' : result.message || 'Copying failed', now); return; }
    const report = validateHostReport(result.host);
    const repo = this.c.hostedGit.finishHost(job.project_id, node.id, { tips: report.tips, digest, defaultBranch: report.defaultBranch, bytes: report.bytes, peeled: report.peeled }, now);
    if (repo.state === 'hosting') this.planCopies(now);
    const project = this.c.anyProject(job.project_id);
    if (!project?.hosted || project.hosted.jobId !== job.id) return;
    const ready = { ...project, home: 'machines', repoUrl: smithRemote(this.c.env.ORIGIN, repo.id), hosted: { ...project.hosted, status: 'ready', message: undefined, updatedAt: now } } as Project;
    this.c.saveProject(ready);
    // A project started in Smith has nothing read yet: its smith.json (if the zip had one) is read now.
    if (isRepoProject(ready) && (project.hosted.init || ready.source === 'smith')) this.c.rescan(ready.id, 'Reading smith.json.', now);
    this.c.hostedGit.audit(now, 'host job', repo.id, 'host', node.id, repo.bytes, project.hosted.init ? 'created' : 'copied');
  }
  // A machine switched off (or removed): its copies are gone from the record; a primary without a copy leaves the repository
  // unreadable until another copy is current (replication and promotion arrive in a later milestone).
  hostSwitchedOff(node: NodeRow, now: number): void {
    this.lfsSwitchedOff(node, now);
    this.c.hostedGit.revokeNodeTickets(node.id, now);
    this.tasks.dropNode(node, this.c.hostNodes(), now, this.c.offlineMs());
    for (const relay of this.c.sql.exec<RelayRow>("SELECT * FROM git_relays WHERE node_id = ? AND state IN ('open', 'ready', 'leased')", node.id).toArray()) {
      this.c.hostedGit.failRelay(relay.id, 'The machine serving this request was switched off', now); this.wakeRelay(relay.id);
    }
  }
  // A project started in Smith, without a repository elsewhere: empty (one README commit) or from a zip the Worker already
  // put in the GIT bucket (`upload`, never caller-supplied: index.ts refuses it on the JSON route). On Cloudflare Artifacts
  // when the workspace has it: the coordinator makes the first commit itself, so no machine is needed, and a machine
  // that keeps copies takes a copy as soon as one is online. Otherwise, or for a project too big for Artifacts, a
  // machine that keeps copies creates the repository and becomes its primary copy.
  async addSmithProject(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['source', 'name', 'branch', 'upload']);
    this.c.requireHuman(userId, true, true);
    const kind = body.source === 'empty' ? 'empty' : body.source === 'zip' ? 'zip' : fail(400, 'invalid_source', 'Unsupported project source');
    let upload: { key: string; size: number; fileName: string } | undefined;
    if (kind === 'zip') {
      const raw = body.upload && typeof body.upload === 'object' ? body.upload as Record<string, unknown> : fail(400, 'invalid_field', 'Upload the zip first');
      const key = string(raw, 'key', 256), size = Number(raw.size), fileName = string(raw, 'fileName', 200);
      if (!key.startsWith(`imports/${this.c.workspaceId()}/`) || !Number.isSafeInteger(size) || size < 1 || size > MAX_IMPORT_BYTES) fail(400, 'invalid_field', 'Invalid upload');
      upload = { key, size, fileName };
    }
    const where = await this.checkCanStart(Date.now());
    if (where.artifacts) {
      const now = Date.now();
      const draft = createSmithProject(body, this.c.projectIds(), now, id => smithRemote(this.c.env.ORIGIN, id), userId);
      let started: ArtifactsStart | null = null;
      try {
        started = await startOnArtifacts(this.c.artifacts(), this.c.artifactsAccount(), this.c.workspaceId(), draft, kind,
          upload ? { read: windowedR2(this.c.env.GIT, upload.key, upload.size), size: upload.size, fileName: upload.fileName } : undefined, now);
      } catch (error) {
        if (!(where.machine && machineCanTakeOver(error))) startFailure(error);
        console.warn(JSON.stringify({ event: 'start_on_machine_instead', reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }));
      }
      if (started) {
        const record = started.record, first = started.first;
        // The home is storage from the first commit (spec §1): the record carries that commit as the branch's tip.
        const tips: Tips = [[first.commit, `refs/heads/${draft.branch}`]]; const digest = await tipsDigest(tips);
        const response = this.c.storage.transactionSync(() => {
          const at = Date.now();
          if (this.c.projectIds().has(draft.id)) fail(409, 'project_exists', 'A project with this name was just added; try again');
          const project: RepoProject = applyReport({ ...draft, home: 'artifacts', repoUrl: smithRemote(this.c.env.ORIGIN, draft.id), artifacts: record }, firstCommitReport(first, draft.branch), 'smith', null, at);
          this.c.insertProject(project);
          this.c.hostedGit.startArtifactsHome(project.id, crypto.randomUUID(), record.remote, draft.branch, at);
          this.c.hostedGit.artifactsReady(project.id, tips, digest, {}, draft.branch, 0, at);
          return json(this.c.publicProject(this.c.anyProject(project.id)!, at), 201);
        });
        if (upload) await this.c.env.GIT.delete(upload.key).catch(() => {});   // the repository holds the files now
        await this.c.schedule();
        return response;
      }
    }
    const response = this.c.storage.transactionSync(() => {
      const now = Date.now();
      this.requireInitHost(now);
      const draft = createSmithProject(body, this.c.projectIds(), now, id => smithRemote(this.c.env.ORIGIN, id), userId);
      const init: ProjectHosted['init'] = { kind, name: draft.name, ...(upload ? { archiveName: upload.fileName, archiveSize: upload.size, uploadKey: upload.key } : {}) };
      const jobId = crypto.randomUUID(), uuid = crypto.randomUUID();
      this.queueInit(draft.id, draft.branch, init, jobId, uuid, now);
      const project: RepoProject = { ...draft, hosted: { repoId: draft.id, uuid, status: 'copying', sourceRepoUrl: '', jobId, init, updatedAt: now } };
      this.c.insertProject(project);
      return json(this.c.publicProject(project, now), 201);
    });
    await this.c.schedule();
    return response;
  }
  // Where a new Smith-started project can go (Artifacts, a machine that keeps copies, or both), refusing when nowhere can;
  // also asked by the Worker before it accepts a zip upload.
  async checkCanStart(now: number): Promise<{ artifacts: boolean; machine: boolean }> {
    if (this.c.projectSlotsUsed() >= 20) fail(429, 'quota', 'Experiment project quota reached');
    if (this.c.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM jobs').one().count >= 1000) fail(429, 'quota', 'Experiment job quota reached');
    const machine = this.initHostReady(now);
    const artifacts = await this.c.artifactsReady();
    if (artifacts || machine) return { artifacts, machine };
    if (this.c.hostingAvailable(now)) this.requireInitHost(now);   // names the machines whose agent is too old
    fail(503, 'no_place', 'Smith has nowhere to keep a new project yet. Set up Cloudflare Artifacts in workspace Settings, or turn on “Keep copies of repositories here” on a build machine that is online');
  }
  // Some machine that keeps copies runs an agent able to create a repository (older agents never take the job).
  private initHostReady(now: number): boolean {
    return this.c.hostNodes().some(node => hostEligible(node, now, this.c.offlineMs()) && (JSON.parse(node.labels) as string[]).includes(GIT_INIT_LABEL));
  }
  private requireInitHost(now: number): void {
    if (this.initHostReady(now)) return;
    const hosts = this.c.hostNodes().filter(node => hostEligible(node, now, this.c.offlineMs()));
    if (!hosts.length) fail(503, 'no_host', 'No machine keeps copies yet. Turn on "Keep copies of repositories here" on a build machine that is online');
    fail(503, 'agent_outdated', `The machines that keep copies (${hosts.map(node => node.hostname || node.id.slice(0, 8)).join(', ')}) run a Smith agent too old to create projects. Update one of them from its machine card, then try again`);
  }
  // One pass after deploy (spec §1): every project without a home gets one. An Artifacts copy addressed directly becomes an
  // Artifacts home behind Smith's URL once its advertisement is read; a failure leaves that project for the next pass.
  async assignHomes(): Promise<{ assigned: number; remaining: number }> {
    let assigned = 0;
    for (const project of this.c.allProjects()) {
      const next = assignHome(project, this.c.env.ORIGIN);
      if (!next) continue;
      try {
        if (next.home === 'artifacts') {
          const token = await this.c.artifactsToken(project.id, 'read');
          const fetched = await fetchTips(project.artifacts!.remote, token);
          this.c.storage.transactionSync(() => {
            const current = this.c.anyProject(project.id); if (!current || current.home) return;
            const now = Date.now();
            this.c.hostedGit.startArtifactsHome(current.id, crypto.randomUUID(), current.artifacts!.remote, current.branch, now);
            this.c.hostedGit.artifactsReady(current.id, fetched.tips, fetched.digest, fetched.peeled, current.branch, 0, now);
            this.c.saveProject({ ...current, home: 'artifacts', repoUrl: next.repoUrl } as Project);
            assigned++;
          });
        } else {
          this.c.storage.transactionSync(() => { const current = this.c.anyProject(project.id); if (current && !current.home) { this.c.saveProject({ ...current, home: 'machines' } as Project); assigned++; } });
        }
      } catch (error) { console.error(JSON.stringify({ event: 'assign_home_failed', projectId: project.id, message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' })); }
    }
    return { assigned, remaining: this.c.allProjects().filter(p => assignHome(p, this.c.env.ORIGIN)).length };
  }
  // Artifacts homes, from the alarm: once a day each (`force` for the tests), a repository gone from Artifacts is marked lost
  // with the fix, and the tips are refreshed; then moves and restores are settled. Answers whether to retry soon.
  async reconcileArtifactsHomes(force = false): Promise<boolean> {
    let retry = false;
    for (const repo of this.c.hostedGit.repos().filter(r => r.state === 'artifacts' || r.state === 'lost')) {
      const project = this.c.anyProject(repo.id); if (!project?.artifacts || project.home !== 'artifacts') continue;
      const now = Date.now();
      if (!force && !repo.tips_due && now - repo.updated_at < ARTIFACTS_REFRESH_MS) continue;
      try {
        const exists = await this.c.artifacts(project.artifacts.accountId).getRepo(project.artifacts.repo);
        if (!exists) { this.c.storage.transactionSync(() => this.c.hostedGit.markLost(repo.id, 'Smith’s storage no longer has this repository; a machine holding a copy can restore it', Date.now())); continue; }
        if (repo.state === 'lost') continue;   // Restore to storage brings it back
        await this.refreshArtifactsTips(repo.id, repo.tips_due === 'push' ? 'push' : 'alarm');
        this.c.storage.transactionSync(() => this.c.sql.exec('UPDATE git_repos SET updated_at = ? WHERE id = ?', Date.now(), repo.id));
      } catch (error) { console.error(JSON.stringify({ event: 'artifacts_home_reconcile_failed', repoId: repo.id, message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' })); retry = true; }
    }
    return await this.settleMoves() || retry;
  }
  // Move to storage (spec §1): a mirror job pushes every branch and tag of a machines home into a fresh Artifacts repository
  // with a write token; the Worker verifies the head, then the home flips and the machine copies become copies.
  async moveToStorage(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['projectId', 'requestId']);
    const projectId = string(body, 'projectId', 64), requestId = string(body, 'requestId');
    this.c.requireHuman(userId, true, true);
    const project = this.c.anyProject(projectId); const repo = this.c.hostedGit.repo(projectId);
    if (!project || project.home !== 'machines' || !repo || repo.state !== 'hosting') fail(409, 'not_on_machines', 'Move to storage is for a project whose copies are on machines and current');
    if (!fitsArtifacts(repo.bytes)) fail(409, 'oversize', `This repository is ${formatBytes(repo.bytes)}, over the 1 GB Smith’s storage holds`);
    return await this.moveFromCopy(project, repo, requestId, MOVE_PRODUCT);
  }
  // Restore to storage: a machine holding a current copy pushes it into a fresh Artifacts repository (the same job as a move).
  async restoreToStorage(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['projectId', 'requestId']);
    const projectId = string(body, 'projectId', 64);
    this.c.requireHuman(userId, true, true);
    const repo = this.c.hostedGit.repo(projectId); const project = this.c.anyProject(projectId);
    if (!project || project.home !== 'artifacts' || !repo || repo.state !== 'lost') fail(409, 'not_lost', 'Restore to storage is for a repository Smith’s storage lost');
    const now = Date.now();
    const holder = this.c.hostedGit.replicas(projectId).find(r => r.state === 'current' && r.generation === repo.generation && this.c.hostNodes().some(n => n.id === r.node_id && hostEligible(n, now, this.c.offlineMs())));
    if (!holder) fail(409, 'no_copy', 'No online machine holds a current copy of this repository');
    return await this.moveFromCopy(project, repo, string(body, 'requestId'), RESTORE_PRODUCT);
  }
  private async moveFromCopy(project: Project | RepoProject, repo: RepoRow, requestId: string, product: typeof MOVE_PRODUCT | typeof RESTORE_PRODUCT): Promise<Response> {
    if (!await this.c.artifactsReady()) fail(503, 'artifacts_unconfigured', 'Smith’s storage is not set up; see Settings');
    if (project.artifacts?.move?.jobId) fail(409, 'move_pending', 'A move is already under way');
    const existing = this.c.sql.exec<JobRow>('SELECT * FROM jobs WHERE request_id = ?', requestId).toArray()[0];
    if (existing) return json({ project: this.c.publicProject(project, Date.now()), job: this.c.publicJob(existing) }, 201);
    const client = this.c.artifacts(); const name = repoNameFor(this.c.workspaceId(), project.id);
    // A legacy copy in storage (both copies, from before homes) is pushed into; only a repository the move makes is the move's to delete.
    const present = await client.getRepo(name);
    const created = present ?? await client.createRepo(name, repo.default_branch || project.branch, `Smith: ${project.name}`);
    const token = await client.issueToken(name, 'write', WRITE_TOKEN_TTL);
    const tip = (JSON.parse(repo.refs_json) as Tips).find(([, ref]) => ref === `refs/heads/${project.branch}`)?.[0] ?? '';
    let response: Response;
    try { response = this.c.storage.transactionSync(() => {
      const now = Date.now(); const current = this.c.anyProject(project.id); if (!current) fail(404, 'not_found', 'Project not found');
      const id = crypto.randomUUID();
      const specs = mirrorSpecs({ id: current.id, repoUrl: current.repoUrl, branch: current.branch, commit: tip }, id, created.remote, token.plaintext);
      for (const spec of Object.values(specs)) spec.mirror!.allRefs = true;
      this.c.sql.exec("INSERT INTO jobs (id, kind, request_id, specs, project_id, product, required_labels, state, created_at, updated_at, revision) VALUES (?, 'mirror', ?, ?, ?, ?, ?, 'queued', ?, ?, 1)", id, requestId, JSON.stringify(specs), current.id, product, JSON.stringify([GIT_CLIENT_LABEL]), now, now);
      this.c.event(id);
      const account = this.c.artifactsAccount();
      const sourceRepoUrl = current.artifacts?.sourceRepoUrl ?? current.hosted?.sourceRepoUrl ?? '';
      this.c.saveProject({ ...current, artifacts: { repo: name, namespace: client.namespace, remote: created.remote, status: 'pushing', accountId: account.accountId, source: account.source, sourceRepoUrl, detachedFrom: current.artifacts?.detachedFrom ?? current.hosted?.detachedFrom, updatedAt: now, move: { jobId: id, tokenId: token.id, commit: tip, at: now, product, createdRepo: !present } } } as Project);
      return json({ project: this.c.publicProject(this.c.anyProject(project.id)!, now), job: this.c.publicJob(this.c.job(id)) }, 201);
    }); } catch (error) { if (!present) { try { await client.deleteRepo(name); } catch { /* best effort */ } } throw error; }
    await this.c.schedule();
    return response;
  }
  // Every move or restore whose job ended: the head in Artifacts must be the commit the job carried; then the row becomes an
  // Artifacts home in place and the copies stay copies. A failure leaves the home where it was, with the reason on the card.
  private async settleMoves(): Promise<boolean> {
    let retry = false;
    for (const project of this.c.allProjects().filter(p => p.artifacts?.move?.jobId)) {
      const move = project.artifacts!.move!; const artifacts = project.artifacts!;
      const job = this.c.sql.exec<JobRow>('SELECT * FROM jobs WHERE id = ?', move.jobId).toArray()[0];
      if (job && ['queued', 'leased', 'running'].includes(job.state)) continue;
      const client = this.c.artifacts(artifacts.accountId);
      let outcome: { ok: boolean; message: string }; let fetched: Awaited<ReturnType<typeof fetchTips>> | null = null;
      if (job?.state === 'success') {
        try {
          const head = await client.branchHead(artifacts.repo, project.branch);
          outcome = head === move.commit ? { ok: true, message: '' } : { ok: false, message: head ? `Smith’s storage shows ${head.slice(0, 12)}, not the moved commit` : 'The branch did not arrive in Smith’s storage' };
          if (outcome.ok) fetched = await fetchTips(artifacts.remote, (await client.issueToken(artifacts.repo, 'read', 600)).plaintext);
        } catch (error) { if (error instanceof HttpError && error.status === 409) { retry = true; continue; } console.error(JSON.stringify({ event: 'move_verify_failed', projectId: project.id })); retry = true; continue; }
      } else outcome = { ok: false, message: (job?.result ? (JSON.parse(job.result) as JobResult).message : '') || `The move ended as ${job?.state ?? 'lost'}` };
      if (move.tokenId) { try { await client.revokeToken(artifacts.repo, move.tokenId); } catch { /* lapses */ } }
      if (!outcome.ok && move.createdRepo) { try { await client.deleteRepo(artifacts.repo); } catch { /* best effort */ } }
      this.c.storage.transactionSync(() => {
        const now = Date.now(); const current = this.c.anyProject(project.id); if (!current?.artifacts?.move || current.artifacts.move.jobId !== move.jobId) return;
        if (!outcome.ok) {
          // The reason stays on the card. A restore, or a move into a copy that already existed, keeps its record as it was.
          const kept = move.product === RESTORE_PRODUCT || !move.createdRepo;
          this.c.saveProject({ ...current, artifacts: { ...current.artifacts, status: kept ? 'done' as const : 'failed' as const, tokenId: undefined, message: outcome.message, move: undefined, updatedAt: now } } as Project);
          this.c.hostedGit.audit(now, 'move', current.id, move.product, '', 0, 'failed: ' + outcome.message.slice(0, 100));
          return;
        }
        this.c.hostedGit.becomeArtifactsHome(current.id, current.artifacts.remote, fetched!.tips, fetched!.digest, fetched!.peeled, now);
        this.c.saveProject({ ...current, home: 'artifacts', hosted: undefined, artifacts: { ...current.artifacts, status: 'done', pushedCommit: move.commit, tokenId: undefined, message: undefined, move: undefined, updatedAt: now } } as Project);
        this.c.hostedGit.audit(now, 'move', current.id, move.product, '', 0, 'in storage');
        this.reconcileGit(now);
      });
    }
    return retry;
  }
  // ---- Import from GitHub (spec §5) ----
  private get imports(): Imports { return new Imports(this.c.sql); }
  private jobState(jobId: string): string | undefined { return this.c.sql.exec<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId).toArray()[0]?.state; }
  // Per ticked repository a project, an Artifacts repository with a write token (minted before the transaction; deleted again
  // if the transaction refuses), a record row and one import job.
  async startImport(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['org', 'repos', 'thresholdBytes', 'link']);
    this.c.requireHuman(userId, true, true);
    const org = string(body, 'org', 39); const link = body.link !== false;
    const threshold = integer(body, 'thresholdBytes', 1048576, MAX_IMPORT_THRESHOLD_BYTES);
    if (!Array.isArray(body.repos) || !body.repos.length || body.repos.length > 1000) fail(400, 'invalid_field', 'Tick 1 to 1,000 repositories');
    const wanted = body.repos.map(raw => { const r = object(raw); fields(r, ['fullName', 'url', 'defaultBranch']); return { fullName: string(r, 'fullName', 200), url: validateRepoUrl(string(r, 'url', 256)), defaultBranch: r.defaultBranch === undefined ? '' : string(r, 'defaultBranch', 256) }; });
    if (!await this.c.artifactsReady()) fail(503, 'artifacts_unconfigured', 'Smith’s storage is not set up; see Settings');
    const known = new Set(this.c.allProjects().flatMap(p => [p.repoUrl, p.artifacts?.sourceRepoUrl, p.hosted?.sourceRepoUrl, p.artifacts?.detachedFrom, p.hosted?.detachedFrom].filter((u): u is string => Boolean(u)).map(u => u.toLowerCase())));
    const fresh = wanted.filter(w => !known.has(w.url.toLowerCase()));
    if (!fresh.length) fail(409, 'already_in_smith', 'Every ticked repository is already in Smith');
    const free = 20 - this.c.projectSlotsUsed();
    if (fresh.length > free) fail(429, 'quota', `Only ${free} project ${free === 1 ? 'slot is' : 'slots are'} free; untick ${fresh.length - free}`);
    if (this.c.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM jobs').one().n + fresh.length > 1000) fail(429, 'quota', 'Experiment job quota reached');
    const client = this.c.artifacts(); const account = this.c.artifactsAccount(); const taken = new Set(this.c.projectIds());
    const prepared: { fullName: string; url: string; defaultBranch: string; projectId: string; repo: string; remote: string; token: { id: string; plaintext: string } }[] = [];
    try {
      for (const w of fresh) {
        const projectId = newProjectId(w.url, taken); taken.add(projectId);
        const repo = repoNameFor(this.c.workspaceId(), projectId);
        const created = await client.createRepo(repo, w.defaultBranch || 'main', `Smith import of ${w.fullName}`);
        const token = await client.issueToken(repo, 'write', IMPORT_TOKEN_TTL_SECONDS);
        prepared.push({ ...w, projectId, repo, remote: created.remote, token });
      }
    } catch (error) { for (const p of prepared) { try { await client.deleteRepo(p.repo); } catch { /* best effort */ } } throw error; }
    let response: Response;
    try {
      response = this.c.storage.transactionSync(() => {
        const now = Date.now(); const importId = crypto.randomUUID();
        this.imports.create({ id: importId, source: 'github', org, created_by: userId, threshold_bytes: threshold, link: link ? 1 : 0, state: 'running', created_at: now });
        for (const p of prepared) {
          if (this.c.projectIds().has(p.projectId)) fail(409, 'project_exists', `A project ${p.projectId} was just added; try again`);
          const project = createRepoProject({ source: 'git', url: p.url, branch: p.defaultBranch }, this.c.projectIds(), now, userId);
          this.c.insertProject({ ...project, id: p.projectId, artifacts: { repo: p.repo, namespace: client.namespace, remote: p.remote, status: 'pushing', accountId: account.accountId, source: account.source, sourceRepoUrl: p.url, tokenId: p.token.id, updatedAt: now } });
          this.c.hostedGit.startArtifactsHome(p.projectId, crypto.randomUUID(), p.remote, p.defaultBranch, now);
          this.queueImportJob(importId, p, crypto.randomUUID(), now, 1);
        }
        return json({ import: this.imports.publicImport(importId, id => this.jobState(id)) }, 201);
      });
    } catch (error) { for (const p of prepared) { try { await client.deleteRepo(p.repo); } catch { /* best effort */ } } throw error; }
    await this.c.schedule();
    return response;
  }
  private queueImportJob(importId: string, p: { fullName: string; url: string; projectId: string; remote: string; token: { plaintext: string } }, jobId: string, now: number, attempts: number): void {
    const spec = { source: p.url, artifactsRemote: p.remote, artifactsToken: p.token.plaintext, smithRemote: smithRemote(this.c.env.ORIGIN, p.projectId), thresholdBytes: this.imports.get(importId).threshold_bytes, maxRepoBytes: MAX_REPO_BYTES, originalBlob: ORIGINAL_BLOB };
    this.c.sql.exec("INSERT INTO jobs (id, kind, request_id, specs, project_id, product, required_labels, state, created_at, updated_at, revision) VALUES (?, 'import', ?, ?, ?, ?, ?, 'queued', ?, ?, 1)", jobId, `import-${jobId}`, JSON.stringify(importSpecs(p.projectId, jobId, spec)), p.projectId, IMPORT_PRODUCT, JSON.stringify([IMPORT_LABEL, LFS_LABEL]), now, now);
    this.c.event(jobId);
    const existing = this.c.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM import_repos WHERE import_id = ? AND full_name = ?', importId, p.fullName).one().n;
    if (existing) this.imports.setRow(importId, p.fullName, { state: 'queued', job_id: jobId, message: '', attempts, next_attempt_at: 0 }, now); else this.imports.addRepo(importId, p.fullName, p.url, p.projectId, jobId, now);
  }
  // At claim: the job-bound write ticket the agent pushes the large files with (spec.lfs, as builds receive theirs).
  attachImportTicket(spec: ResolvedJobSpec, job: JobRow, node: NodeRow, ticket: { token: string; hash: string } | undefined, now: number): void {
    if (!ticket || spec.kind !== 'import' || !spec.import) return;
    this.c.hostedGit.issueTicket(ticket.hash, spec.projectId, 'write', { nodeId: node.id, jobId: job.id, ttlMs: ((spec.timeoutSeconds || 3600) + 600) * 1000, label: 'import' }, now);
    spec.lfs = { url: spec.import.smithRemote, authToken: ticket.token };
  }
  // Settle every import row whose job ended (spec §5), and queue the ones whose retry is due. Success is confirmed against
  // Artifacts (the default branch's head equals the report's commit; a repository still importing there answers 409 and
  // is retried later). Answers whether something should be tried again soon.
  async reconcileImports(): Promise<boolean> {
    let retry = false;
    for (const row of this.imports.unsettled()) {
      if (!row.job_id) { if (row.next_attempt_at <= Date.now()) await this.requeueImportRow(row); continue; }
      const job = this.c.sql.exec<JobRow>('SELECT * FROM jobs WHERE id = ?', row.job_id).toArray()[0];
      if (!job) { this.c.storage.transactionSync(() => this.imports.setRow(row.import_id, row.full_name, { state: 'failed', message: 'The import job is gone' }, Date.now())); continue; }
      if (job.state === 'leased' || job.state === 'running') { if (row.state !== 'running') this.c.storage.transactionSync(() => this.imports.setRow(row.import_id, row.full_name, { state: 'running' }, Date.now())); continue; }
      if (job.state === 'queued') continue;
      const result = job.result ? JSON.parse(job.result) as JobResult : null;
      const project = this.c.anyProject(row.project_id);
      if (!isRepoProject(project) || !project.artifacts) { this.c.storage.transactionSync(() => this.imports.setRow(row.import_id, row.full_name, { state: 'failed', message: 'The project was removed' }, Date.now())); continue; }
      const client = this.c.artifacts(project.artifacts.accountId);
      if (job.state === 'success' && !result?.import) { await this.revokeImportToken(project); this.failImportRow(row, result?.message || 'The machine returned no import report', false); continue; }
      if (job.state === 'success' && result?.import) {
        let report: ImportReport;
        try { report = validateImportReport(result.import); } catch (error) { await this.revokeImportToken(project); this.failImportRow(row, `The machine's report could not be used: ${error instanceof Error ? error.message : 'bad report'}`, false); continue; }
        let head: string | null; let tips: Awaited<ReturnType<typeof fetchTips>>;
        try { head = await client.branchHead(project.artifacts.repo, report.branch); tips = await fetchTips(project.artifacts.remote, (await client.issueToken(project.artifacts.repo, 'read', 600)).plaintext); }
        catch (error) { if (error instanceof HttpError && error.status === 409) { retry = true; continue; } console.error(JSON.stringify({ event: 'import_verify_failed', projectId: project.id, message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' })); retry = true; continue; }
        if (head !== report.commit) { await this.revokeImportToken(project); this.failImportRow(row, head ? `Smith’s storage shows ${head.slice(0, 12)}, not the imported commit` : 'The branch did not arrive in Smith’s storage', false); continue; }
        if (project.artifacts.tokenId) { try { await client.revokeToken(project.artifacts.repo, project.artifacts.tokenId); } catch { /* lapses */ } }
        this.c.storage.transactionSync(() => {
          const now = Date.now(); const current = this.c.anyProject(row.project_id); const imported = this.imports.get(row.import_id);
          if (!isRepoProject(current) || !current.artifacts) return;
          const detach = report.rewritten || !imported.link;
          const artifacts = { ...current.artifacts, status: 'done' as const, tokenId: undefined, pushedCommit: report.commit, updatedAt: now, sourceRepoUrl: detach ? smithRemote(this.c.env.ORIGIN, current.id) : current.artifacts.sourceRepoUrl, ...(detach ? { detachedFrom: current.artifacts.sourceRepoUrl } : {}) };
          const saved = applyReport({ ...current, branch: report.branch, repoUrl: smithRemote(this.c.env.ORIGIN, current.id), home: 'artifacts', artifacts, scan: { ...current.scan, jobId: null } }, report.scan, 'machine', null, now);
          this.c.saveProject(saved);
          this.c.hostedGit.artifactsReady(current.id, tips.tips, tips.digest, tips.peeled, report.branch, 0, now);
          this.imports.setRow(row.import_id, row.full_name, { state: 'done', message: report.rewritten ? rewrittenMessage(report.movedFiles, report.movedBytes) : '', rewritten: report.rewritten ? 1 : 0, moved_files: report.movedFiles, moved_bytes: report.movedBytes }, now);
          this.c.hostedGit.audit(now, 'import', current.id, 'import', job.node_id ?? '', 0, report.rewritten ? 'imported, rewritten' : 'imported');
          this.planCopies(now);
        });
        continue;
      }
      if (result?.failure === 'oversize') {
        try { await client.deleteRepo(project.artifacts.repo); } catch { /* best effort */ }
        let swept: { repo_id: string; oid: string }[] = [];
        this.c.storage.transactionSync(() => {
          const now = Date.now(); const current = this.c.anyProject(row.project_id); if (!isRepoProject(current)) return;
          const uuid = crypto.randomUUID(), hostJobId = crypto.randomUUID();
          this.c.sql.exec('DELETE FROM git_repos WHERE id = ?', current.id);
          this.c.hostedGit.startHosting({ id: current.id, repoUrl: row.url, branch: current.branch, commit: '' }, hostJobId, uuid, now);
          this.c.sql.exec("INSERT INTO jobs (id, kind, request_id, specs, project_id, product, required_labels, state, created_at, updated_at, revision) VALUES (?, 'host', ?, ?, ?, ?, ?, 'queued', ?, ?, 1)", hostJobId, `host-${hostJobId}`, JSON.stringify(hostSpecs({ id: current.id, repoUrl: row.url, branch: current.branch, commit: '' }, hostJobId, uuid, current.branch)), current.id, HOST_PRODUCT, JSON.stringify([GIT_HOST_LABEL]), now, now);
          this.c.event(hostJobId);
          this.c.saveProject({ ...current, artifacts: undefined, hosted: { repoId: current.id, uuid, status: 'copying', sourceRepoUrl: row.url, jobId: hostJobId, updatedAt: now } });
          swept = new LfsStore(this.c.sql).sweepRepos(id => id !== current.id);
          this.imports.setRow(row.import_id, row.full_name, { state: 'machine', message: OVERSIZE_MESSAGE }, now);
        });
        for (const s of swept) { try { await (this.c.env as { GIT?: R2Bucket }).GIT?.delete(lfsKey(this.c.workspaceId(), s.repo_id, s.oid)); } catch { /* sweep */ } }
        continue;
      }
      const message = result?.message || `The import ended as ${job.state}`;
      const transient = (job.state === 'lost' || /could not resolve|timed out|connection|try again|busy|still being prepared/i.test(message)) && result?.failure !== 'repo_access';
      if (!(transient && row.attempts <= IMPORT_RETRY_MS.length)) await this.revokeImportToken(project);
      this.failImportRow(row, message, transient);
    }
    return retry;
  }
  // A token that will not be used again (the row failed for good) ends now rather than lapsing in a day.
  private async revokeImportToken(project: RepoProject): Promise<void> {
    if (!project.artifacts?.tokenId) return;
    try { await this.c.artifacts(project.artifacts.accountId).revokeToken(project.artifacts.repo, project.artifacts.tokenId); } catch { /* it lapses */ }
    this.c.storage.transactionSync(() => { const current = this.c.anyProject(project.id); if (isRepoProject(current) && current.artifacts) this.c.saveProject({ ...current, artifacts: { ...current.artifacts, tokenId: undefined } }); });
  }
  private failImportRow(row: ImportRepoRow, message: string, transient: boolean): void {
    this.c.storage.transactionSync(() => {
      const now = Date.now();
      if (transient && row.attempts <= IMPORT_RETRY_MS.length) { this.imports.setRow(row.import_id, row.full_name, { state: 'queued', job_id: null, message, next_attempt_at: now + IMPORT_RETRY_MS[row.attempts - 1] }, now); return; }
      this.imports.setRow(row.import_id, row.full_name, { state: 'failed', message }, now);
    });
  }
  // A row whose retry is due gets a fresh job with a fresh write token (the old one may have lapsed); the project is reused.
  private async requeueImportRow(row: ImportRepoRow): Promise<void> {
    const project = this.c.anyProject(row.project_id);
    if (!isRepoProject(project) || !project.artifacts) { this.c.storage.transactionSync(() => this.imports.setRow(row.import_id, row.full_name, { state: 'failed', message: 'The project was removed' }, Date.now())); return; }
    const client = this.c.artifacts(project.artifacts.accountId);
    const token = await client.issueToken(project.artifacts.repo, 'write', IMPORT_TOKEN_TTL_SECONDS);
    this.c.storage.transactionSync(() => {
      const current = this.c.anyProject(row.project_id); if (!isRepoProject(current) || !current.artifacts) return;
      const now = Date.now();
      this.c.saveProject({ ...current, artifacts: { ...current.artifacts, tokenId: token.id, updatedAt: now } });
      this.queueImportJob(row.import_id, { fullName: row.full_name, url: row.url, projectId: current.id, remote: current.artifacts.remote, token: { plaintext: token.plaintext } }, crypto.randomUUID(), now, row.attempts + 1);
    });
    await this.c.schedule();
  }
  // Retry (owner/admin): the named failed row, or every failed row, starts a fresh cycle of attempts on the same project.
  async retryImport(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['importId', 'fullName']);
    this.c.requireHuman(userId, true, true);
    const importId = string(body, 'importId', 64); const fullName = body.fullName === undefined ? '' : string(body, 'fullName', 200);
    const rows = this.c.storage.transactionSync(() => {
      const chosen = this.imports.rows(importId).filter(r => r.state === 'failed' && (!fullName || r.full_name === fullName));
      if (!chosen.length) fail(409, 'nothing_to_retry', fullName ? 'That repository is not waiting for a retry' : 'No repository of this import is waiting for a retry');
      const now = Date.now();
      for (const r of chosen) this.imports.setRow(importId, r.full_name, { state: 'queued', attempts: 0, next_attempt_at: 0 }, now);
      this.imports.finish(importId, 'running', now);
      return chosen.map(r => ({ ...r, attempts: 0 }));
    });
    for (const r of rows) await this.requeueImportRow(r);
    return json({ import: this.imports.publicImport(importId, id => this.jobState(id)) });
  }
  // Cancel (owner/admin): queued jobs of unfinished rows are cancelled and their projects and repositories removed; finished
  // rows stay. A job already running finishes on its own and is then ignored (its row is cancelled).
  async cancelImport(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['importId']);
    this.c.requireHuman(userId, true, true);
    const importId = string(body, 'importId', 64);
    const removed = this.c.storage.transactionSync(() => {
      const now = Date.now(); const gone: { repo: string; accountId: string }[] = [];
      for (const r of this.imports.rows(importId).filter(r => r.state === 'queued' || r.state === 'running')) {
        if (r.job_id) { const job = this.c.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ? AND state = 'queued'", r.job_id).toArray()[0]; if (job) { this.c.sql.exec("UPDATE jobs SET state = 'cancelled', updated_at = ?, revision = revision + 1 WHERE id = ?", now, job.id); this.c.event(job.id); this.c.hostedGit.revokeJobTickets(job.id, now); } }
        const project = this.c.anyProject(r.project_id);
        if (project?.artifacts) gone.push({ repo: project.artifacts.repo, accountId: project.artifacts.accountId });
        this.removeRepo(r.project_id, now);
        this.c.sql.exec('DELETE FROM projects WHERE id = ?', r.project_id);
        this.imports.setRow(importId, r.full_name, { state: 'cancelled', job_id: null, message: 'Cancelled' }, now);
      }
      this.imports.finish(importId, 'cancelled', now);
      return gone;
    });
    for (const g of removed) { try { await this.c.artifacts(g.accountId).deleteRepo(g.repo); } catch { /* best effort */ } }
    return json({ import: this.imports.publicImport(importId, id => this.jobState(id)) });
  }
  listImports(): Response { return json({ imports: this.imports.list().map(i => this.imports.publicImport(i.id, id => this.jobState(id))) }); }
  getImport(body: Record<string, unknown>): Response { fields(body, ['importId']); return json({ import: this.imports.publicImport(string(body, 'importId', 64), id => this.jobState(id)) }); }
  // A job's named blob (job-blob-route.ts): an import's original-history bundle, under the job's lease. The key is the
  // repository's backup prefix; completion records an 'original' backup that lives as long as the project.
  private blobAction(action: string, node: NodeRow, body: Record<string, unknown>, now: number): Record<string, unknown> {
    fields(body, ['jobId', 'name', 'leaseToken', 'part', 'uploadId', 'etag', 'size', 'sha256']);
    const job = this.c.job(string(body, 'jobId', 64)); const name = string(body, 'name', 64);
    if (job.node_id !== node.id || job.lease_token !== string(body, 'leaseToken', 300) || !['leased', 'running'].includes(job.state)) fail(409, 'stale_lease', 'This job is not yours any more');
    const spec = Object.values(JSON.parse(job.specs) as Record<string, ResolvedJobSpec>)[0];
    if (job.kind !== 'import' || !spec?.import || spec.import.originalBlob !== name) fail(409, 'not_this_blob', 'This job stores no blob by that name');
    const repo = this.c.hostedGit.repo(job.project_id); if (!repo) fail(409, 'no_repository', 'The project has no repository record');
    const key = backupKey(this.c.workspaceId(), repo.uuid, `original-${job.id}`);
    type Blob = { job_id: string; name: string; key: string; upload_id: string | null; parts: string; size: number; sha256: string; done: number };
    const row = () => this.c.sql.exec<Blob>('SELECT * FROM job_blobs WHERE job_id = ? AND name = ?', job.id, name).toArray()[0];
    if (action === 'git-blob-part') {
      if (!Number.isSafeInteger(body.part) || Number(body.part) < 1 || Number(body.part) > 10000) fail(400, 'invalid_field', 'part must be 1..10000');
      let current = row();
      if (!current) { this.c.sql.exec('INSERT INTO job_blobs (job_id, name, key, created_at) VALUES (?, ?, ?, ?)', job.id, name, key, now); current = row()!; }
      if (current.done) fail(409, 'blob_done', 'This blob is complete');
      return { key: current.key, uploadId: current.upload_id };
    }
    const current = row() ?? fail(409, 'no_blob', 'Upload a part first');
    if (action === 'git-blob-upload') { this.c.sql.exec('UPDATE job_blobs SET upload_id = ? WHERE job_id = ? AND name = ?', string(body, 'uploadId', 512), job.id, name); return { ok: true }; }
    if (action === 'git-blob-part-done') {
      const part = Number(body.part), etag = string(body, 'etag', 256), size = Number(body.size);
      if (!Number.isSafeInteger(part) || part < 1 || !Number.isSafeInteger(size) || size < 0) fail(400, 'invalid_field', 'Invalid part');
      const parts = (JSON.parse(current.parts) as { part: number; etag: string; size: number }[]).filter(p => p.part !== part); parts.push({ part, etag, size }); parts.sort((a, b) => a.part - b.part);
      this.c.sql.exec('UPDATE job_blobs SET parts = ? WHERE job_id = ? AND name = ?', JSON.stringify(parts), job.id, name); return { ok: true };
    }
    if (action === 'git-blob-finish') return { key: current.key, uploadId: current.upload_id, parts: JSON.parse(current.parts) as unknown[], done: Boolean(current.done), size: current.size };
    if (action === 'git-blob-reset') { this.c.sql.exec("UPDATE job_blobs SET upload_id = NULL, parts = '[]' WHERE job_id = ? AND name = ? AND done = 0", job.id, name); return { ok: true }; }
    if (action === 'git-blob-complete') {
      if (current.done) return { ok: true, key: current.key, size: current.size };
      const size = Number(body.size), sha256 = string(body, 'sha256', 64);
      if (!Number.isSafeInteger(size) || size < 1 || !/^[a-f0-9]{64}$/.test(sha256)) fail(400, 'invalid_field', 'size and sha256 are required');
      this.c.sql.exec('UPDATE job_blobs SET done = 1, size = ?, sha256 = ? WHERE job_id = ? AND name = ?', size, sha256, job.id, name);
      this.c.sql.exec("INSERT INTO git_backups (id, repo_id, kind, key, size, sha256, tips_json, base_id, ready, created_at) VALUES (?, ?, 'original', ?, ?, ?, '[]', NULL, 1, ?)", crypto.randomUUID(), repo.id, current.key, size, sha256, now);
      this.c.hostedGit.audit(now, 'import', repo.id, 'original-bundle', node.id, size, 'kept');
      return { ok: true, key: current.key, size };
    }
    return fail(404, 'unknown_action', 'Unknown blob step');
  }
  // Owners and admins download a project's original-history bundle (the dashboard's link streams it from R2).
  backupDownload(userId: string, body: Record<string, unknown>): Response {
    fields(body, ['projectId', 'backupId']);
    this.c.requireHuman(userId, true, true);
    const projectId = string(body, 'projectId', 64), backupId = string(body, 'backupId', 64);
    const backup = this.tasks.backup(backupId);
    if (!backup || backup.repo_id !== projectId || !backup.ready) fail(404, 'not_found', 'No such backup of this project');
    return json({ key: backup.key, size: backup.size, name: `${projectId}-${backup.kind === 'original' ? 'original-history' : backup.kind}.bundle` });
  }
  private queueInit(projectId: string, branch: string, init: NonNullable<ProjectHosted['init']>, jobId: string, uuid: string, now: number): void {
    this.c.hostedGit.startHosting({ id: projectId, repoUrl: '', branch, commit: '' }, jobId, uuid, now);
    const { uploadKey: _key, ...shown } = init;
    this.c.sql.exec("INSERT INTO jobs (id, kind, request_id, specs, project_id, product, required_labels, state, created_at, updated_at, revision) VALUES (?, 'host', ?, ?, ?, ?, ?, 'queued', ?, ?, 1)",
      jobId, `init-${jobId}`, JSON.stringify(hostInitSpecs(projectId, jobId, uuid, branch, shown)), projectId, NEW_PRODUCT, JSON.stringify([GIT_HOST_LABEL, GIT_INIT_LABEL]), now, now);
    this.c.event(jobId);
  }
  // A machine running a zip project's host job asks for the zip: only the job's current attempt, on the machine that holds it.
  importGrant(job: JobRow, node: NodeRow, attempt: { attemptId: string; leaseToken: string }, now: number): { key: string; size: number } {
    if (job.kind !== 'host' || job.node_id !== node.id || job.attempt_id !== attempt.attemptId || job.lease_token !== attempt.leaseToken || !['leased', 'running'].includes(job.state) || (job.lease_expires_at ?? 0) <= now) fail(409, 'stale_attempt', 'Attempt is not current');
    const init = this.c.anyProject(job.project_id)?.hosted?.init;
    if (init?.kind !== 'zip' || !init.uploadKey || !init.archiveSize) fail(404, 'no_upload', 'This job has no uploaded zip');
    return { key: init.uploadKey, size: init.archiveSize };
  }
  // Uploaded zips whose repository now exists: deleted from R2 (after the transaction that finished the host job).
  async dropFinishedUploads(): Promise<void> {
    for (const project of this.c.allProjects()) {
      const init = project.hosted?.init;
      if (project.hosted?.status !== 'ready' || !init?.uploadKey) continue;
      try { await this.c.env.GIT.delete(init.uploadKey); } catch { continue; }   // the next completion or alarm tries again
      this.c.storage.transactionSync(() => {
        const current = this.c.anyProject(project.id);
        if (!current?.hosted?.init || current.hosted.init.uploadKey !== init.uploadKey) return;
        const { uploadKey: _key, ...rest } = current.hosted.init;
        this.c.saveProject({ ...current, hosted: { ...current.hosted, init: rest } } as Project);
      });
    }
  }
  // The project was removed: no request reaches its repository any more, and the machines throw their copies away.
  // Answers the R2 keys of its backups, deleted by the caller once the transaction is over.
  removeRepo(repoId: string, now: number): string[] {
    const repo = this.c.hostedGit.repo(repoId);
    if (!repo || repo.state === 'deleted') return [];
    for (const relay of this.c.sql.exec<RelayRow>("SELECT * FROM git_relays WHERE repo_id = ? AND state IN ('open', 'ready', 'leased')", repoId).toArray()) {
      this.c.hostedGit.failRelay(relay.id, 'This project was removed from Smith', now); this.wakeRelay(relay.id);
    }
    return this.tasks.deleteRepo(repo, this.c.hostNodes(), now);
  }
  async deleteBackups(keys: string[]): Promise<void> {
    for (const key of keys) { try { await (this.c.env as { GIT?: R2Bucket }).GIT?.delete(key); } catch { /* lifecycle */ } }
  }
  // "New repository in Smith": a project whose only repository is Smith's own, so nothing outside (GitHub or any other host)
  // is needed. A machine that keeps copies creates it empty; the first push to it is read like any other (copyPushed).
  newProject(userId: string, body: Record<string, unknown>, quotaUsed: () => number): Response {
    fields(body, ['source', 'name', 'branch']);
    this.c.requireHuman(userId, true, true);
    const name = string(body, 'name', 128).trim();
    if (!name) fail(400, 'invalid_field', 'Give the new repository a name');
    const branch = body.branch === undefined || body.branch === '' ? 'main' : typeof body.branch === 'string' && validBranch(body.branch.trim()) ? body.branch.trim() : fail(400, 'invalid_branch', 'Invalid branch name');
    const uuid = crypto.randomUUID();
    const response = this.c.storage.transactionSync(() => {
      const now = Date.now();
      if (quotaUsed() >= 20) fail(429, 'quota', 'Experiment project quota reached');
      const able = this.c.hostNodes().filter(n => hostEligible(n, now, this.c.offlineMs()));
      if (!able.length) fail(503, 'no_host', 'No machine keeps copies yet. Turn on "Keep copies of repositories here" on a build machine that is online');
      if (!able.some(n => (JSON.parse(n.labels) as string[]).includes(GIT_NEW_LABEL))) fail(503, 'agent_outdated', 'The machines that keep copies run an older Smith that cannot start a new repository; they update themselves shortly');
      if (this.c.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM jobs').one().count >= 1000) fail(429, 'quota', 'Experiment job quota reached');
      const taken = new Set(this.c.sql.exec<{ id: string }>('SELECT id FROM projects').toArray().map(r => r.id));
      const slug = (slugifyName(name).slice(0, 56) || 'project').replace(/^-+|-+$/g, '') || 'project';
      const free = (candidate: string) => { const held = this.c.hostedGit.repo(candidate); return !taken.has(candidate) && (!held || held.state === 'failed'); };
      const base = slug === 'smoke' ? 'smoke-repo' : slug;
      let id = base;
      for (let n = 2; !free(id); n++) id = `${base}-${n}`;
      const remote = smithRemote(this.c.env.ORIGIN, id), jobId = crypto.randomUUID();
      const repo = this.c.hostedGit.startHosting({ id, repoUrl: remote, branch, commit: '' }, jobId, uuid, now);
      this.c.sql.exec("INSERT INTO jobs (id, kind, request_id, specs, project_id, product, required_labels, state, created_at, updated_at, revision) VALUES (?, 'host', ?, ?, ?, ?, ?, 'queued', ?, ?, 1)",
        jobId, `new-${jobId}`, JSON.stringify(hostSpecs({ id, repoUrl: remote, branch, commit: '' }, jobId, repo.uuid, branch)), id, HOST_PRODUCT, JSON.stringify([GIT_HOST_LABEL, GIT_NEW_LABEL]), now, now);
      this.c.event(jobId);
      const project: RepoProject = { kind: 'repo', id, name, customName: true, repoUrl: remote, source: 'git', branch, commit: null,
        scan: { state: 'waiting', message: 'A new, empty repository: push your code to it to start.', via: null, host: null, jobId: null, at: now },
        actions: [], unusedRules: 0, disabledRules: 0, warnings: [], createdAt: now, createdBy: userId,
        hosted: { repoId: id, uuid: repo.uuid, status: 'copying', sourceRepoUrl: remote, jobId, updatedAt: now } };
      this.c.sql.exec('INSERT INTO projects VALUES (?, ?)', id, JSON.stringify(project));
      return json(this.c.publicProject(project, now), 201);
    });
    return response;
  }
  // "Copy into Smith": start keeping copies of a project on the machines switched on for it.
  async hostProject(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['requestId', 'projectId']);
    const requestId = string(body, 'requestId'); const projectId = string(body, 'projectId', 64);
    this.c.requireHuman(userId, true, true);
    const uuid = crypto.randomUUID();
    const response = this.c.storage.transactionSync(() => {
      const now = Date.now();
      const project = this.c.anyProject(projectId);
      if (!project) fail(404, 'not_found', 'Project not found');
      const existing = this.c.sql.exec<JobRow>('SELECT * FROM jobs WHERE request_id = ?', requestId).toArray()[0];
      if (existing) {
        if (existing.kind !== 'host' || existing.project_id !== projectId) fail(409, 'conflicting_request', 'Request ID already identifies a different job');
        return json({ project: this.c.publicProject(project, now), job: this.c.publicJob(existing) }, 201);
      }
      if (project.hosted?.status === 'copying') fail(409, 'hosted_pending', 'Smith is already copying this project');
      if (project.hosted?.status === 'ready' && smithRemoteRepo(project.repoUrl, this.c.env.ORIGIN)) fail(409, 'hosted_done', 'Smith already keeps copies of this project');
      if (project.artifacts && ['pushing', 'verifying'].includes(project.artifacts.status)) fail(409, 'artifacts_pending', 'Smith is already copying this project');
      if (!this.c.hostingAvailable(now)) fail(503, 'no_host', 'No machine keeps copies yet. Turn on "Keep copies of repositories here" on a build machine that is online');
      if (this.c.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM jobs').one().count >= 1000) fail(429, 'quota', 'Experiment job quota reached');
      if (project.home === 'artifacts') fail(409, 'in_storage', 'This project lives in Smith’s storage; it is not copied onto a machine');
      // A project started in Smith whose first attempt failed: create it again (the uploaded zip is still kept).
      const init = project.hosted?.init;
      if (init) {
        this.requireInitHost(now);
        const id = crypto.randomUUID();
        this.queueInit(project.id, project.branch, init, id, uuid, now);
        this.c.sql.exec('UPDATE jobs SET request_id = ? WHERE id = ?', requestId, id);
        const updated = { ...project, hosted: { ...project.hosted!, uuid, status: 'copying', jobId: id, message: undefined, updatedAt: now } } as Project;
        this.c.saveProject(updated);
        return json({ project: this.c.publicProject(updated, now), job: this.c.publicJob(this.c.job(id)) }, 201);
      }
      const source = { id: project.id, repoUrl: project.hosted?.sourceRepoUrl ?? project.repoUrl, branch: project.branch, commit: isRepoProject(project) ? '' : project.commit };
      const id = crypto.randomUUID();
      const repo = this.c.hostedGit.startHosting(source, id, uuid, now);
      this.c.sql.exec("INSERT INTO jobs (id, kind, request_id, specs, project_id, product, required_labels, state, created_at, updated_at, revision) VALUES (?, 'host', ?, ?, ?, ?, ?, 'queued', ?, ?, 1)",
        id, requestId, JSON.stringify(hostSpecs(source, id, repo.uuid, source.branch)), projectId, HOST_PRODUCT, JSON.stringify([GIT_HOST_LABEL]), now, now);
      this.c.event(id);
      const hosted: ProjectHosted = { repoId: project.id, uuid: repo.uuid, status: 'copying', sourceRepoUrl: source.repoUrl, jobId: id, updatedAt: now };
      const updated = { ...project, hosted } as Project;
      this.c.saveProject(updated);
      return json({ project: this.c.publicProject(updated, now), job: this.c.publicJob(this.c.job(id)) }, 201);
    });
    await this.c.schedule();
    return response;
  }

  private relayWaitMs(writer: boolean): number { return Number((this.c.env as { GIT_WAIT_MS?: string }).GIT_WAIT_MS) || (writer ? RELAY_WAIT_MS.write : RELAY_WAIT_MS.read); }
  // Relays: a git request parked until the machine answers. The Worker waits here (the state is in SQLite, so an
  // evicted object simply reloads it); completions and failures wake the waiters.
  private relayWaiters = new Map<string, Set<() => void>>();
  wakeRelay(id: string): void { for (const wake of this.relayWaiters.get(id) ?? []) wake(); this.relayWaiters.delete(id); }
  private waitRelay(id: string, ms: number): Promise<void> {
    return new Promise(resolve => {
      const waiters = this.relayWaiters.get(id) ?? new Set<() => void>(); waiters.add(resolve); this.relayWaiters.set(id, waiters);
      setTimeout(() => { waiters.delete(resolve); resolve(); }, ms);
    });
  }
  private publicRelay(relay: RelayRow) {
    return { id: relay.id, state: relay.state, status: relay.status, resKey: relay.res_key, size: relay.res_size, message: relay.message, writer: Boolean(relay.writer), service: relay.service, op: relay.op, reqKey: relay.req_key, uploadId: relay.upload_id, parts: JSON.parse(relay.parts) as { part: number; etag: string; size: number }[] };
  }
  // The Worker's own steps of a relay (never a client's or a machine's): reached only over the Durable Object's RPC.
  async gitRelay(step: 'ready' | 'abort' | 'wait' | 'delivered', body: Record<string, unknown>): Promise<Response> {
    try {
      const id = string(body, 'relayId', 64); const now = Date.now();
      if (step === 'ready') { this.c.storage.transactionSync(() => this.c.hostedGit.readyRelay(id, typeof body.reqKey === 'string' ? body.reqKey : null, Number(body.size ?? 0), now)); await this.c.schedule(); return json({ ok: true }); }
      if (step === 'abort') { this.c.storage.transactionSync(() => this.c.hostedGit.failRelay(id, string(body, 'message', 300), now)); this.wakeRelay(id); return json({ ok: true }); }
      if (step === 'delivered') { this.c.storage.transactionSync(() => this.c.hostedGit.deliverRelay(id, now)); return json({ ok: true }); }
      const deadline = Math.min(Date.now() + 25000, Number(body.until ?? Date.now() + 25000));
      for (;;) {
        // Expire here too: a relay nobody took, or whose machine went quiet, fails without waiting for the alarm.
        for (const expired of this.c.storage.transactionSync(() => this.c.hostedGit.expireRelays(Date.now()))) this.wakeRelay(expired.id);
        const relay = this.c.hostedGit.relay(id);
        if (relay.state === 'completed' || relay.state === 'failed' || relay.state === 'delivered') return json(this.publicRelay(relay));
        if (Date.now() >= deadline) return json(this.publicRelay(relay));
        const due = this.c.hostedGit.nextDue(Date.now());
        await this.waitRelay(id, Math.max(50, Math.min(deadline, due ?? deadline) - Date.now()));
      }
    } catch (error) { return errorResponse(error); }
  }
  // Every git-* action: people and tickets opening relays (git-read, git-write) and asking about clones (git-clone-info);
  // machines polling, reporting tips and driving their relay (git-poll, git-tips, git-relay-*).
  async gitAction(principal: Principal, action: string, body: Record<string, unknown>, credentialHash: string): Promise<Response> {
    const now = Date.now();
    const ticketHash = principal.kind === 'ticket' ? await hash(principal.token) : '';
    const ticketNodeHash = principal.kind === 'ticket' && principal.nodeToken ? await hash(principal.nodeToken) : null;
    const leaseToken = action === 'git-poll' ? randomToken() : '';
    const taskLease = action === 'git-poll' ? randomToken() : '';
    // A task a poll may hand out needs a ticket of its own (hashing is async): minted here, issued only with the task.
    const taskTicket = action === 'git-poll' ? newTicket(this.c.workspaceId()) : '';
    const taskTicketHash = taskTicket ? await hash(taskTicket) : '';
    const lfsLeases = action === 'git-poll' ? Array.from({ length: LFS_TASKS_PER_POLL }, () => randomToken()) : [];
    const digest = (action === 'git-tips' || action === 'git-relay-complete' || action === 'git-task-complete') && Array.isArray(body.tips) ? await tipsDigest(validateTips(body.tips)) : '';
    const recoveredDigest = action === 'git-accept-dataloss' ? await this.restoredDigest(body) : '';
    let wake: string | null = null; let deleteKeys: string[] = [];
    const response = this.c.storage.transactionSync(() => {
      const git = this.c.hostedGit, tasks = this.tasks;
      if (action === 'lfs-read' || action === 'lfs-write') {
        // Large files (Git LFS) of any project: batch verdicts, per-object authorisation, verify and the ready mark.
        // Read needs the read scope or a read ticket; write (upload) the build scope or a write ticket, like git.
        fields(body, ['repo', 'step', 'username', 'objects', 'oid', 'size', 'presign']);
        const repoId = string(body, 'repo', 64); const writer = action === 'lfs-write';
        const step = body.step === 'batch' || body.step === 'authorize' || body.step === 'verify' || body.step === 'stored' || body.step === 'lost' ? body.step : fail(400, 'invalid_field', 'step must be batch, authorize, verify, stored or lost');
        if (!writer && step !== 'batch' && step !== 'authorize' && step !== 'lost') fail(403, 'forbidden', 'This step needs upload permission');
        const username = body.username === undefined || body.username === '' ? '' : string(body, 'username', 128);
        if (/^[a-f0-9]{12}$/.test(username) && username !== cloneUsername(this.c.workspaceId())) fail(401, 'wrong_workspace', 'This token belongs to another workspace');
        let who = '';
        if (principal.kind === 'human') {
          try { this.c.requireHuman(principal.userId, writer); }
          catch (error) { if (writer && error instanceof HttpError && error.status === 403) fail(403, 'scope', 'This Smith token cannot upload large files. In the dashboard, create a token that can start builds and use it as the password'); throw error; }
          who = 'member';
        } else if (principal.kind === 'ticket') {
          const ticket = git.resolveTicket(ticketHash, repoId, writer ? 'write' : 'read', ticketNodeHash, h => this.c.sql.exec<{ id: string }>('SELECT id FROM nodes WHERE token_hash = ? AND active = 1', h).toArray()[0]?.id ?? null, now);
          who = ticket.label || 'ticket';
        } else fail(401, 'unauthenticated', 'A Smith token is required');
        if (!this.c.anyProject(repoId)) fail(404, 'not_found', 'Repository not found');
        const lfs = new LfsStore(this.c.sql);
        if (step === 'batch') {
          if (!Array.isArray(body.objects)) fail(400, 'invalid_field', 'objects must be an array');
          const objects = (body.objects as LfsObjectRequest[]).map(o => ({ oid: String(o.oid), size: Number(o.size) }));
          if (objects.some(o => !OID.test(o.oid) || !Number.isSafeInteger(o.size) || o.size < 0)) fail(400, 'invalid_field', 'Invalid object');
          const quota = this.c.settings().lfsQuotaBytes;
          const quotaBytes = typeof quota === 'number' && Number.isSafeInteger(quota) && quota >= 0 ? quota : DEFAULT_LFS_QUOTA_BYTES;
          const proxyMaxBytes = body.presign === true ? null : this.c.proxyMaxBytes();
          return json({ verdicts: lfs.verdicts(repoId, writer ? 'upload' : 'download', objects, { quotaBytes, proxyMaxBytes, who, now }), who });
        }
        const oid = string(body, 'oid', 64); if (!OID.test(oid)) fail(400, 'invalid_field', 'Invalid object id');
        const row = lfs.get(repoId, oid);
        // The Worker found R2 without a ready object (spec §8): the record marks it lost so a holder restores it.
        if (step === 'lost') { if (row?.state === 'ready') lfs.markLost(repoId, oid); return json({ row: lfs.get(repoId, oid) ?? null }); }
        if (step === 'authorize') {
          if (!row || (!writer && row.state !== 'ready')) fail(404, 'not_found', 'Object not found');
          return json({ row });
        }
        if (step === 'verify') { if (!row) fail(404, 'not_found', 'Object not found'); return json({ row }); }
        if (!Number.isSafeInteger(body.size) || Number(body.size) < 0) fail(400, 'invalid_field', 'size must be a byte count');
        return json({ row: lfs.markReady(repoId, oid, Number(body.size), now) });
      }
      if (action === 'git-restore' || action === 'git-accept-dataloss' || action === 'git-recovered') {
        if (principal.kind !== 'human') fail(403, 'forbidden', 'Command not permitted for this identity');
        this.c.requireHuman(principal.userId, true, true);
        fields(body, ['repoId', 'nodeId', 'ref', 'action']);
        const repo = git.repo(string(body, 'repoId', 64));
        if (!repo || repo.state === 'deleted') fail(404, 'not_found', 'Repository not found');
        const nodes = this.c.hostNodes(), offlineMs = this.c.offlineMs();
        if (action === 'git-restore') { const task = tasks.planRestore(repo, nodes, now, offlineMs, true); return json({ queued: Boolean(task), host: nodes.find(n => n.id === task?.node_id)?.hostname ?? null }); }
        if (action === 'git-accept-dataloss') { tasks.acceptDataloss(repo, nodes, now, offlineMs, () => recoveredDigest); this.planCopies(now); return json({ accepted: true, hosted: this.publicHosted(repo.id, now) }); }
        const decision = body.action === 'promote' ? 'promote' : body.action === 'discard' ? 'discard' : fail(400, 'invalid_field', 'action must be promote or discard');
        const task = tasks.decideRecovered(repo, string(body, 'nodeId'), string(body, 'ref', 512), decision, now);
        return json({ queued: Boolean(task), hosted: this.publicHosted(repo.id, now) });
      }
      if (action === 'git-read' || action === 'git-write' || action === 'git-advertise' || action === 'git-ls-refs') {
        fields(body, ['repo', 'service', 'op', 'username', 'gitProtocol', 'label', 'lsRefs', 'backend']);
        const repoId = string(body, 'repo', 64); const writer = action === 'git-write';
        const service = body.service === 'receive-pack' ? 'receive-pack' : 'upload-pack';
        const op = body.op === 'info-refs' ? 'info-refs' : 'rpc';
        const optional = (key: string, max: number) => body[key] === undefined || body[key] === '' ? '' : string(body, key, max);
        const gitProtocol = optional('gitProtocol', 64);
        const username = optional('username', 128);
        if (/^[a-f0-9]{12}$/.test(username) && username !== cloneUsername(this.c.workspaceId())) fail(401, 'wrong_workspace', 'This token belongs to another workspace');
        let who = ''; let policy: RefPolicy; let excludeNodeId: string | null = null;
        if (principal.kind === 'human') {
          this.c.requireHuman(principal.userId, writer);
          who = 'member'; policy = defaultRefPolicy(git.repo(repoId)?.default_branch ?? '');
        } else if (principal.kind === 'ticket') {
          const ticket = git.resolveTicket(ticketHash, repoId, writer ? 'write' : 'read', ticketNodeHash, h => this.c.sql.exec<{ id: string }>('SELECT id FROM nodes WHERE token_hash = ? AND active = 1', h).toArray()[0]?.id ?? null, now);
          who = ticket.label || 'ticket'; policy = parseRefPolicy(JSON.parse(ticket.ref_policy)); excludeNodeId = ticket.node_id;   // a machine fetching a copy is never asked to serve itself
        } else fail(401, 'unauthenticated', 'A Smith token is required');
        let repo = git.repo(repoId);
        if (!repo || repo.state === 'deleted' || repo.state === 'failed') fail(404, 'not_found', 'Repository not found');
        if (repo.state === 'bootstrapping') fail(503, 'copying', 'Smith is still making its first copy of this repository; try again in a minute');
        if (repo.state === 'importing') fail(503, 'copying', 'Smith is still importing this repository; try again in a few minutes');
        // An Artifacts home (spec §2): the Worker proxies; a reader asks for the relay only when storage did not answer.
        if (repo.state === 'artifacts' && body.backend !== 'relay') {
          const project = this.c.anyProject(repoId);
          if (!project?.artifacts) fail(404, 'not_found', 'Repository not found');
          git.audit(now, who, repo.id, service, '', 0, 'proxied to storage');
          return json({ backend: 'artifacts', repoId: repo.id, remote: project.artifacts.remote, scope: writer ? 'write' : 'read', writer });
        }
        if (repo.state === 'artifacts' && writer) fail(503, 'storage_unreachable', STORAGE_UNREACHABLE);
        if (writer && (repo.state === 'degraded' || repo.state === 'lost')) fail(409, 'refusing_pushes', repo.state === 'lost' ? 'No machine holding this repository is online, so it cannot take pushes' : 'This repository is restored from a backup and refuses pushes until an owner accepts the restore');
        let servers = git.servers(repo, this.c.hostNodes(), now, this.c.offlineMs(), writer, excludeNodeId);
        // The primary is gone: a current copy takes over now rather than at the next alarm.
        if (!servers.length && writer) {
          const before = repo.primary_node_id;
          repo = tasks.promote(repo, this.c.hostNodes(), now, this.c.offlineMs());
          if (repo.primary_node_id !== before) this.planCopies(now);   // the old primary syncs when it returns
          servers = git.servers(repo, this.c.hostNodes(), now, this.c.offlineMs(), writer, excludeNodeId);
        }
        if (!servers.length && repo.state === 'artifacts') { git.audit(now, who, repo.id, service, '', 0, 'no copy online'); fail(503, 'no_host', 'No machine holding a copy of this repository is online, and Smith’s storage did not answer; try again in a few minutes'); }
        if (!servers.length) {
          const primary = repo.primary_node_id ? this.c.sql.exec<{ hostname: string }>('SELECT hostname FROM nodes WHERE id = ?', repo.primary_node_id).toArray()[0]?.hostname : '';
          git.audit(now, who, repo.id, service, '', 0, 'no host online');
          fail(503, 'no_host', `No machine holding this repository is online. ${primary ? primary + ' is offline; start it to restore service' : 'Start a machine that keeps copies'}`);
        }
        // The record answers a clone's first two requests itself (the v2 advertisement and ls-refs) when it can; the
        // machine that would have served them is online, so the fetch that follows finds the same refs there.
        if (action === 'git-advertise') { git.audit(now, who, repo.id, service, '', 0, 'advertisement from record'); return json({ ok: true }); }
        if (action === 'git-ls-refs') {
          const lines = lsRefsLines(repo as RepoRow, body.lsRefs as LsRefsRequest);
          if (lines) git.audit(now, who, repo.id, service, '', 0, 'ls-refs from record');
          return json({ lines });
        }
        git.expireRelays(now);
        const relay = git.openRelay(crypto.randomUUID(), repo, servers[0], service, op, writer, gitProtocol, who, policy, now);
        return json({ relayId: relay.id, repoId: repo.id, writer, nodeId: servers[0].id, waitMs: this.relayWaitMs(writer), bodyCap: writer ? 100 * 1024 * 1024 : 16 * 1024 * 1024 });
      }
      if (principal.kind === 'human' && action === 'git-clone-info') {
        fields(body, ['repo']);
        const repo = git.repo(string(body, 'repo', 64));
        if (!repo || repo.state === 'deleted') fail(404, 'not_found', 'Repository not found');
        return json(git.cloneInfo(repo));
      }
      if (principal.kind !== 'node') fail(403, 'forbidden', 'Command not permitted for this identity');
      const node = this.c.sql.exec<NodeRow>('SELECT * FROM nodes WHERE token_hash = ? AND active = 1', credentialHash).toArray()[0];
      if (!node) fail(401, 'invalid_node', 'Node credential invalid or revoked');
      if (action === 'lfs-task-view' || action === 'lfs-task-complete') {
        // A machine's large-file task under its lease: what it is (key, size, oid), and its outcome. A fetch that
        // succeeded records the copy; a restore becomes ready only once the Worker hashed the stored object.
        fields(body, ['taskId', 'leaseToken', 'ok', 'message', 'verified', 'held', 'size']);
        const lfs = new LfsStore(this.c.sql), ltasks = this.lfsTasks;
        const task = ltasks.held(string(body, 'taskId', 64), node, string(body, 'leaseToken', 300), now);
        const row = lfs.get(task.repo_id, task.oid);
        const key = lfsKey(this.c.workspaceId(), task.repo_id, task.oid);
        if (action === 'lfs-task-view') {
          // A task its object no longer needs (lost meanwhile, restored by a fresh upload, swept) is cancelled, so the
          // machine's slots never wedge on it.
          if ((task.kind === 'fetch' && row?.state !== 'ready') || (task.kind === 'restore' && row?.state !== 'lost')) { ltasks.cancel(task.id); return json({ error: { code: 'gone', message: 'This task is no longer needed' } }, 410); }   // not fail(): the cancel must commit
          return json({ kind: task.kind, key, size: row?.size ?? 0, oid: task.oid, repoId: task.repo_id });
        }
        if (typeof body.ok !== 'boolean') fail(400, 'invalid_field', 'ok must be a boolean');
        const message = typeof body.message === 'string' && body.message ? string(body, 'message', 300) : '';
        if (body.ok) {
          if (task.kind === 'fetch') lfs.recordHeld(task.repo_id, task.oid, node.id, now);
          if (task.kind === 'drop') lfs.forgetHeld(task.repo_id, task.oid, node.id);
          if (task.kind === 'restore') { if (body.verified !== true) fail(409, 'unverified', 'The restored object was not verified'); if (row) lfs.markReady(task.repo_id, task.oid, row.size, now); }
        } else if (task.kind === 'restore' && body.held === false) {
          // This machine has no intact copy any more: it is no longer a holder, and the planner asks another holder,
          // if any, rather than retrying here. Any other failure (a refused or dropped upload) keeps the copy on record
          // and retries with backoff.
          lfs.forgetHeld(task.repo_id, task.oid, node.id); ltasks.cancel(task.id);
          return json({ ok: false });
        }
        ltasks.settle(task.id, body.ok, message, now);
        return json({ ok: body.ok });
      }
      if (action === 'git-poll') {
        fields(body, []);
        for (const relay of git.expireRelays(now)) this.wakeRelay(relay.id);
        const { relay } = git.poll(node, leaseToken, now);
        const held = git.heldBy(node.id).map(h => ({ repoId: h.repo.id, uuid: h.repo.uuid, primary: h.repo.primary_node_id === node.id, state: h.replica.state }));
        // Relays come first; a task rides along only while the machine holds no other, so a busy copy still serves.
        const task = tasks.poll(node, taskLease, now);
        let publicTask: Record<string, unknown> | null = null;
        if (task) {
          const taskRepo = git.repo(task.repo_id)!; const payload = JSON.parse(task.payload) as Record<string, unknown>;
          if (task.kind === 'replicate') { git.issueTicket(taskTicketHash, taskRepo.id, 'read', { nodeId: node.id, label: 'replicate', ttlMs: 2 * 3600000 }, now); payload.ticket = taskTicket; }
          if (task.kind === 'promote') { git.issueTicket(taskTicketHash, taskRepo.id, 'write', { nodeId: node.id, label: 'promote', policy: { allow: [String(payload.ref)], protected: [], denyDelete: true }, ttlMs: 3600000 }, now); payload.ticket = taskTicket; }
          publicTask = { id: task.id, leaseToken: task.lease_token, leaseExpiresAt: task.lease_expires_at, kind: task.kind, repoId: taskRepo.id, repoUuid: taskRepo.uuid, defaultBranch: taskRepo.default_branch, payload };
        }
        // Large-file work for this machine (copies, restores, drops), up to four at a time, beside the git task.
        const lfsStore = new LfsStore(this.c.sql);
        const lfsTasks = this.lfsTasks.poll(node, lfsLeases, now).map(t => ({ id: t.id, leaseToken: t.lease_token, leaseExpiresAt: t.lease_expires_at, kind: t.kind, repoId: t.repo_id, oid: t.oid, size: lfsStore.get(t.repo_id, t.oid)?.size ?? 0 }));
        if (!relay) return json({ relay: null, task: publicTask, held, lfs: lfsTasks });
        const repo = git.repo(relay.repo_id)!;
        return json({ relay: { id: relay.id, leaseToken: relay.lease_token, leaseExpiresAt: relay.lease_expires_at, repoUuid: repo.uuid, service: relay.service, op: relay.op, writer: Boolean(relay.writer), gitProtocol: relay.git_protocol,
          hasBody: Boolean(relay.req_key), bodySize: relay.req_size, refPolicy: JSON.parse(relay.ref_policy) as RefPolicy, userLabel: relay.user_label, defaultBranch: repo.default_branch }, task: publicTask, held, lfs: lfsTasks });
      }
      if (action.startsWith('git-task-')) { const response = this.taskAction(action, node, body, digest, now); deleteKeys = response.deleteKeys; return json(response.body); }
      if (action.startsWith('git-blob-')) return json(this.blobAction(action, node, body, now));
      if (action === 'git-tips') {
        fields(body, ['repoUuid', 'tips', 'bytes', 'peeled']);
        const repo = git.repoByUuid(string(body, 'repoUuid', 64));
        if (!repo || repo.state === 'deleted') fail(404, 'not_found', 'Repository not found');
        const tips = validateTips(body.tips); const bytes = body.bytes === undefined ? null : Number.isSafeInteger(body.bytes) && Number(body.bytes) >= 0 ? Number(body.bytes) : fail(400, 'invalid_field', 'bytes must be a byte count');
        const peeled = validatePeeled(body.peeled, tips);
        if (repo.primary_node_id === node.id) {
          const changed = git.adoptTips(repo, node.id, tips, digest, bytes, now, 'report', peeled);
          // A primary that was switched off and on again still holds the copy: the repository is back.
          if (repo.state === 'lost' && hostEligible(node, now, this.c.offlineMs())) { this.c.sql.exec("UPDATE git_repos SET state = 'hosting', message = '', updated_at = ? WHERE id = ? AND state = 'lost'", now, repo.id); git.audit(now, 'machine', repo.id, 'report', node.id, bytes ?? 0, 'the primary is back'); }
          if (changed.generation !== repo.generation || repo.state === 'lost') this.planCopies(now);
        } else { const replica = git.reportReplica(repo, node.id, digest, bytes, now); if (repo.state === 'artifacts' && replica.state === 'stale') git.markTipsDue(repo.id, 'copy'); }
        return json({ accepted: true, generation: git.repo(repo.id)!.generation });
      }
      if (action === 'git-relay-body') {
        fields(body, ['relayId', 'leaseToken']);
        const relay = git.heldRelay(string(body, 'relayId', 64), node, string(body, 'leaseToken', 300), now);
        if (!relay.req_key) fail(404, 'no_body', 'This request has no body');
        return json({ reqKey: relay.req_key, size: relay.req_size });
      }
      if (action === 'git-relay-response') {
        fields(body, ['relayId', 'leaseToken', 'part']);
        const relay = git.heldRelay(string(body, 'relayId', 64), node, string(body, 'leaseToken', 300), now);
        if (!Number.isSafeInteger(body.part) || Number(body.part) < 1 || Number(body.part) > 10000) fail(400, 'invalid_field', 'part must be 1..10000');
        const resKey = relay.res_key ?? `relay/${this.c.workspaceId()}/${relay.id}/res-${relay.lease_token!.slice(0, 12)}`;
        return json({ resKey, uploadId: relay.upload_id, parts: JSON.parse(relay.parts) as unknown[] });
      }
      if (action === 'git-relay-upload') {
        fields(body, ['relayId', 'leaseToken', 'uploadId', 'resKey']);
        const relay = git.heldRelay(string(body, 'relayId', 64), node, string(body, 'leaseToken', 300), now);
        if (relay.upload_id) fail(409, 'upload_exists', 'This relay already has an upload');
        git.setUpload(relay.id, string(body, 'uploadId', 512), string(body, 'resKey', 256), now);
        return json({ ok: true });
      }
      if (action === 'git-relay-part') {
        fields(body, ['relayId', 'leaseToken', 'part', 'etag', 'size']);
        const relay = git.heldRelay(string(body, 'relayId', 64), node, string(body, 'leaseToken', 300), now);
        if (!Number.isSafeInteger(body.part) || Number(body.part) < 1 || !Number.isSafeInteger(body.size) || Number(body.size) < 0) fail(400, 'invalid_field', 'Invalid part');
        git.addPart(relay.id, Number(body.part), string(body, 'etag', 256), Number(body.size), now);
        return json({ ok: true });
      }
      if (action === 'git-relay-finish') {
        fields(body, ['relayId', 'leaseToken']);
        const relay = git.heldRelay(string(body, 'relayId', 64), node, string(body, 'leaseToken', 300), now);
        return json(this.publicRelay(relay));
      }
      if (action === 'git-relay-complete') {
        const done = validateRelayCompletion(body);
        const relay = git.relay(done.relayId);
        if (relay.node_id !== node.id || relay.lease_token !== done.leaseToken) fail(409, 'stale_relay', 'This relay is not yours');
        const repo = git.repo(relay.repo_id)!;
        // A push that landed is recorded whether or not the client is still waiting; a stale node's report cannot move the record.
        if (relay.writer && done.tips && done.status < 400 && repo.primary_node_id === node.id) {
          const changed = git.adoptTips(repo, node.id, done.tips, digest, done.bytes, now, 'push', done.peeled);
          if (changed.generation !== repo.generation) { this.planCopies(now); this.c.copyPushed(repo.id, repo.refs_json, changed.refs_json, now); }
        }
        const { relay: completed, late } = git.completeRelay(relay.id, node, done.leaseToken, done.status, done.size, done.message, now);
        git.audit(now, relay.user_label, repo.id, relay.service, node.id, done.size, late ? 'late completion' : `status ${done.status}`);
        wake = completed.id;
        return json({ accepted: true, late });
      }
      fail(404, 'not_found', 'Unknown git action');
    });
    if (wake) this.wakeRelay(wake);
    // Backups retention named bundles to delete: done after the transaction, best effort (the lifecycle rule is the net).
    for (const key of deleteKeys) { try { await (this.c.env as { GIT?: R2Bucket }).GIT?.delete(key); } catch { /* lifecycle */ } }
    await this.c.schedule();
    return response;
  }
  // The restored copy's tips, hashed before the accept transaction (its digest becomes the record's).
  private async restoredDigest(body: Record<string, unknown>): Promise<string> {
    const repo = typeof body.repoId === 'string' ? this.c.hostedGit.repo(body.repoId) : undefined;
    const restored = repo?.primary_node_id ? this.c.hostedGit.replicas(repo.id).find(r => r.node_id === repo.primary_node_id) : undefined;
    return restored ? await tipsDigest(JSON.parse(restored.tips_json) as Tips) : '';
  }
  // The machine's side of a task: fetching a bundle, uploading one in parts, and the outcome. Inside the poll transaction.
  private taskAction(action: string, node: NodeRow, body: Record<string, unknown>, digest: string, now: number): { body: Record<string, unknown>; deleteKeys: string[] } {
    const git = this.c.hostedGit, tasks = this.tasks;
    const taskOf = () => tasks.held(string(body, 'taskId', 64), node, string(body, 'leaseToken', 300), now);
    if (action === 'git-task-body') {
      fields(body, ['taskId', 'leaseToken', 'backupId']);
      const task = taskOf(); const backup = tasks.backup(string(body, 'backupId', 64));
      if (!backup || backup.repo_id !== task.repo_id || !backup.ready) fail(404, 'not_found', 'No such backup of this repository');
      return { body: { key: backup.key, size: backup.size }, deleteKeys: [] };
    }
    if (action === 'git-task-part') {
      fields(body, ['taskId', 'leaseToken', 'part']);
      const task = taskOf(); if (task.kind !== 'backup') fail(409, 'not_backup', 'Only a backup uploads parts');
      if (!Number.isSafeInteger(body.part) || Number(body.part) < 1 || Number(body.part) > 10000) fail(400, 'invalid_field', 'part must be 1..10000');
      return { body: { key: (JSON.parse(task.payload) as { key: string }).key, uploadId: task.upload_id }, deleteKeys: [] };
    }
    if (action === 'git-task-upload') { fields(body, ['taskId', 'leaseToken', 'uploadId']); const task = taskOf(); if (task.upload_id) fail(409, 'upload_exists', 'This task already has an upload'); tasks.setUpload(task.id, string(body, 'uploadId', 512), now); return { body: { ok: true }, deleteKeys: [] }; }
    if (action === 'git-task-part-done') {
      fields(body, ['taskId', 'leaseToken', 'part', 'etag', 'size']);
      const task = taskOf(); if (!Number.isSafeInteger(body.part) || Number(body.part) < 1 || !Number.isSafeInteger(body.size) || Number(body.size) < 0) fail(400, 'invalid_field', 'Invalid part');
      tasks.addPart(task.id, { part: Number(body.part), etag: string(body, 'etag', 256), size: Number(body.size) }, now); return { body: { ok: true }, deleteKeys: [] };
    }
    if (action === 'git-task-finish') { fields(body, ['taskId', 'leaseToken']); const task = taskOf(); return { body: { kind: task.kind, key: task.kind === 'backup' ? (JSON.parse(task.payload) as { key: string }).key : null, uploadId: task.upload_id, parts: JSON.parse(task.parts) as unknown[] }, deleteKeys: [] }; }
    if (action !== 'git-task-complete') fail(404, 'not_found', 'Unknown git action');
    fields(body, ['taskId', 'leaseToken', 'ok', 'message', 'tips', 'bytes', 'recovered', 'size', 'sha256', 'kind', 'peeled']);
    const task = taskOf(); const repo = git.repo(task.repo_id)!;
    if (typeof body.ok !== 'boolean') fail(400, 'invalid_field', 'ok must be a boolean');
    const message = typeof body.message === 'string' ? body.message.slice(0, 1000) : '';
    const tips = body.tips === undefined || body.tips === null ? null : validateTips(body.tips);
    const bytes = body.bytes === undefined || body.bytes === null ? null : Number.isSafeInteger(body.bytes) && Number(body.bytes) >= 0 ? Number(body.bytes) : fail(400, 'invalid_field', 'bytes must be a byte count');
    const recovered = body.recovered === undefined || body.recovered === null ? [] : validateTips(body.recovered, true);
    const peeled = tips ? validatePeeled(body.peeled, tips) : {};
    let deleteKeys: string[] = [];
    if (!body.ok) {
      if (task.kind === 'backup') tasks.failBackup(task);
      tasks.settle(task.id, false, message || 'failed', now);
      git.audit(now, 'machine', repo.id, task.kind, node.id, 0, `failed: ${message || 'no reason given'}`);
      return { body: { accepted: true, retry: true }, deleteKeys };
    }
    if (task.kind === 'replicate') {
      if (!tips) fail(400, 'invalid_field', 'A replicate task reports the copy’s refs');
      if (repo.primary_node_id === node.id) git.adoptTips(repo, node.id, tips, digest, bytes, now, 'report', peeled);
      else { const replica = git.reportReplica(repo, node.id, digest, bytes, now, tips); if (repo.state === 'artifacts' && replica.state === 'stale') git.markTipsDue(repo.id, 'copy'); }
      if (recovered.length) tasks.recordRecovered(repo.id, node.id, recovered, now);
    } else if (task.kind === 'backup') {
      if (!tips || !Number.isSafeInteger(body.size)) fail(400, 'invalid_field', 'A backup reports its size and the refs it holds');
      deleteKeys = tasks.completeBackup(task, { size: Number(body.size), sha256: typeof body.sha256 === 'string' ? body.sha256.slice(0, 64) : '', tips, kind: body.kind === 'full' ? 'full' : (JSON.parse(task.payload) as { kind: 'full' | 'incremental' }).kind }, now);
    } else if (task.kind === 'restore') {
      if (!tips || bytes === null) fail(400, 'invalid_field', 'A restore reports the copy’s refs and size');
      tasks.completeRestore(task, node, { tips, digest, bytes }, now);
      this.planCopies(now);
    } else if (task.kind === 'discard') {
      this.c.sql.exec('DELETE FROM git_replicas WHERE repo_id = ? AND node_id = ?', repo.id, node.id);
    } else if (task.kind === 'promote') tasks.promoted(repo, node.id, task);
    tasks.settle(task.id, true, message, now);
    git.audit(now, 'machine', repo.id, task.kind, node.id, bytes ?? Number(body.size ?? 0), 'done');
    return { body: { accepted: true, hosted: this.publicHosted(repo.id, now) }, deleteKeys };
  }

}
