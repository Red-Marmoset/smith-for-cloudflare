// Smith-hosted repositories, beyond the first copy: the work the workspace object hands hosting machines
// between relays (git_tasks), and the state it keeps for it. A machine fetches copies from the primary
// (replicate), bundles the primary into R2 (backup), rebuilds a lost repository from those bundles (restore),
// throws away a copy it should no longer keep (discard), and pushes or drops refs a copy held that the record
// never had (promote, discard-recovered). The coordinator picks a new primary when the old one is gone.
// Pure decisions plus one SQL helper (the HostedGit pattern); the Worker moves the bytes (git-task-route.ts).
import { fail } from './http';
import { HostedGit, MAX_REPO_BYTES, RELAY_LEASE_MS, hostEligible, smithRemote, type HostNode, type RepoRow, type ReplicaRow, type Tips } from './git-host';

export type TaskKind = 'replicate' | 'backup' | 'restore' | 'discard' | 'promote' | 'discard-recovered';
export type TaskState = 'queued' | 'leased' | 'done' | 'failed';
export type TaskRow = { id: string; repo_id: string; node_id: string; kind: TaskKind; state: TaskState; lease_token: string | null; lease_expires_at: number | null; attempts: number; next_attempt_at: number;
  payload: string; message: string; upload_id: string | null; parts: string; created_at: number; updated_at: number };
export type BackupRow = { id: string; repo_id: string; kind: 'full' | 'incremental' | 'original'; key: string; size: number; sha256: string; tips_json: string; base_id: string | null; ready: number; created_at: number };
export type RecoveredRow = { repo_id: string; node_id: string; ref: string; sha: string; recorded_at: number };
export type Part = { part: number; etag: string; size: number };

export const MAX_REPLICAS = 5;                            // copies of one repository, the primary included
export const BACKUP_DEBOUNCE_MS = 5 * 60000;              // a push is backed up once the repository has been quiet this long
export const BACKUP_FULL_EVERY_MS = 7 * 86400000;         // a fresh full bundle at least weekly
export const BACKUP_BUDGET_BYTES = 8 * 1024 * 1024 * 1024; // of R2's 10 GB free tier; the rest is packages and relay traffic
export const RESTORE_AFTER_OFFLINE_MS = 24 * 3600000;     // an offline primary is restored elsewhere only after a day
export const TASK_RETRY_MS = (attempts: number) => Math.min(3600000, 60000 * 2 ** Math.min(attempts, 6));
export const REPLICA_FREE_MARGIN = (repoBytes: number) => 2 * repoBytes + 1024 * 1024 * 1024;

export function backupKey(workspaceId: string, repoUuid: string, backupId: string): string { return `backups/${workspaceId}/${repoUuid}/${backupId}.bundle`; }
// Pure: the backups a restore replays, oldest first: the newest ready full and every ready incremental chained on it.
export function restoreChain(backups: BackupRow[]): BackupRow[] {
  const ready = backups.filter(b => b.ready && b.kind !== 'original');
  const full = ready.filter(b => b.kind === 'full').sort((a, b) => b.created_at - a.created_at)[0];
  if (!full) return [];
  const chain = [full]; const byBase = new Map(ready.filter(b => b.kind === 'incremental').map(b => [b.base_id, b]));
  for (let last = full; ;) { const next = byBase.get(last.id); if (!next) break; chain.push(next); last = next; }
  return chain;
}
// Pure: what retention keeps: the two newest ready fulls and the incrementals chained on them, within the budget
// (the oldest full and its chain go first when the budget is exceeded, but never the newest full).
// Originals (an import's history before its rewrite) are kept until the project goes; they count in the budget's bytes.
export function retainBackups(backups: BackupRow[], budget = BACKUP_BUDGET_BYTES): { keep: BackupRow[]; drop: BackupRow[] } {
  const originals = backups.filter(b => b.kind === 'original'); backups = backups.filter(b => b.kind !== 'original');
  const ready = backups.filter(b => b.ready);
  const fulls = ready.filter(b => b.kind === 'full').sort((a, b) => b.created_at - a.created_at);
  const chains = fulls.map(full => { const chain = [full]; const byBase = new Map(ready.filter(b => b.kind === 'incremental').map(b => [b.base_id, b])); for (let last = full; ;) { const next = byBase.get(last.id); if (!next) break; chain.push(next); last = next; } return chain; });
  let kept = chains.slice(0, 2);
  while (kept.length > 1 && kept.flat().reduce((sum, b) => sum + b.size, 0) > budget) kept = kept.slice(0, -1);
  const keepIds = new Set(kept.flat().map(b => b.id));
  return { keep: [...ready.filter(b => keepIds.has(b.id)), ...originals], drop: backups.filter(b => !keepIds.has(b.id) && (b.ready || b.created_at < Date.now() - 86400000)) };
}

export class GitTasks {
  constructor(private readonly sql: SqlStorage, private readonly git: HostedGit, private readonly workspaceId: string, private readonly origin: string) {}

  task(id: string): TaskRow { const row = this.sql.exec<TaskRow>('SELECT * FROM git_tasks WHERE id = ?', id).toArray()[0]; if (!row) fail(404, 'not_found', 'Task not found'); return row; }
  tasks(repoId: string): TaskRow[] { return this.sql.exec<TaskRow>("SELECT * FROM git_tasks WHERE repo_id = ? AND state IN ('queued', 'leased') ORDER BY created_at", repoId).toArray(); }
  pending(repoId: string, kind: TaskKind, nodeId: string | null = null): boolean {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM git_tasks WHERE repo_id = ? AND kind = ? AND state IN ('queued', 'leased')${nodeId ? ' AND node_id = ?' : ''}`, ...(nodeId ? [repoId, kind, nodeId] : [repoId, kind])).one().n > 0;
  }
  pendingFor(nodeId: string): boolean { return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM git_tasks WHERE node_id = ? AND state IN ('queued', 'leased')", nodeId).one().n > 0; }
  // One task of a kind per repository and machine at a time; the caller decides whether the work is due.
  queue(kind: TaskKind, repo: RepoRow, nodeId: string, payload: Record<string, unknown>, now: number, delayMs = 0): TaskRow | null {
    if (this.pending(repo.id, kind, nodeId)) return null;
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO git_tasks (id, repo_id, node_id, kind, state, next_attempt_at, payload, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)", id, repo.id, nodeId, kind, now + delayMs, JSON.stringify(payload), now, now);
    return this.task(id);
  }
  // A machine's poll, after relays: the oldest due task addressed to it, when it holds none.
  poll(node: HostNode, leaseToken: string, now: number): TaskRow | null {
    if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM git_tasks WHERE node_id = ? AND state = 'leased'", node.id).one().n) return null;
    const next = this.sql.exec<TaskRow>("SELECT * FROM git_tasks WHERE node_id = ? AND state = 'queued' AND next_attempt_at <= ? ORDER BY created_at LIMIT 1", node.id, now).toArray()[0];
    if (!next) return null;
    this.sql.exec("UPDATE git_tasks SET state = 'leased', lease_token = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?", leaseToken, now + RELAY_LEASE_MS, now, next.id);
    return this.task(next.id);
  }
  held(id: string, node: HostNode, leaseToken: string, now: number): TaskRow {
    const row = this.task(id);
    if (row.node_id !== node.id || row.lease_token !== leaseToken) fail(409, 'stale_task', 'This task is not yours');
    if (row.state !== 'leased' || (row.lease_expires_at ?? 0) <= now) fail(409, 'stale_task', 'This task’s lease has ended');
    return row;
  }
  setUpload(id: string, uploadId: string, now: number): void { this.sql.exec('UPDATE git_tasks SET upload_id = ?, updated_at = ? WHERE id = ?', uploadId, now, id); }
  addPart(id: string, part: Part, now: number): void {
    const parts = (JSON.parse(this.task(id).parts) as Part[]).filter(p => p.part !== part.part); parts.push(part); parts.sort((a, b) => a.part - b.part);
    this.sql.exec('UPDATE git_tasks SET parts = ?, updated_at = ? WHERE id = ?', JSON.stringify(parts), now, id);
  }
  // The outcome: done, or failed with a later retry (capped backoff). Replication keeps trying for as long as the
  // machine is switched on; the card shows the last message meanwhile.
  settle(id: string, ok: boolean, message: string, now: number): TaskRow {
    const row = this.task(id);
    if (ok) this.sql.exec("UPDATE git_tasks SET state = 'done', message = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?", message.slice(0, 300), now, id);
    else this.sql.exec("UPDATE git_tasks SET state = 'queued', message = ?, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, upload_id = NULL, parts = '[]', updated_at = ? WHERE id = ?", message.slice(0, 300), now + TASK_RETRY_MS(row.attempts), now, id);
    return this.task(id);
  }
  // Leases that ran out go back to the queue (the machine lost them); tasks for machines no longer able to host are dropped
  // (a switched-off machine still runs its discard tasks, which is why gitHost stays true while it has some).
  expire(now: number, nodes: HostNode[], offlineMs: number): void {
    this.sql.exec("UPDATE git_tasks SET state = 'queued', lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, upload_id = NULL, parts = '[]', updated_at = ? WHERE state = 'leased' AND lease_expires_at <= ?", now, now, now);
    const active = new Set(nodes.filter(n => n.active).map(n => n.id));
    for (const row of this.sql.exec<TaskRow>("SELECT * FROM git_tasks WHERE state IN ('queued', 'leased')").toArray()) {
      const node = nodes.find(n => n.id === row.node_id);
      if (!active.has(row.node_id) || (row.kind !== 'discard' && row.kind !== 'discard-recovered' && node && !node.host_repos)) this.sql.exec('DELETE FROM git_tasks WHERE id = ?', row.id);
    }
    this.sql.exec("DELETE FROM git_tasks WHERE state IN ('done', 'failed') AND updated_at <= ?", now - 86400000);
    void offlineMs;
  }

  // ---- replication is planned by copies.ts (one budget per machine, a target number of copies per item) ----

  // The primary is gone (offline past the threshold, switched off, revoked, drained, or its agent lost the label): the newest
  // current copy takes over. Without one, nothing changes; writes are refused with the machine's name until it returns.
  promote(repo: RepoRow, nodes: HostNode[], now: number, offlineMs: number): RepoRow {
    if (!['hosting', 'oversize', 'degraded', 'lost'].includes(repo.state)) return repo;
    const primary = nodes.find(n => n.id === repo.primary_node_id);
    if (primary && hostEligible(primary, now, offlineMs) && repo.state !== 'lost') return repo;
    const candidate = this.git.replicas(repo.id).filter(r => r.state === 'current' && r.generation === repo.generation && r.node_id !== repo.primary_node_id)
      .map(r => ({ r, node: nodes.find(n => n.id === r.node_id) })).filter(x => x.node && hostEligible(x.node, now, offlineMs)).sort((a, b) => (b.r.last_sync_at ?? 0) - (a.r.last_sync_at ?? 0))[0];
    if (!candidate) return repo;
    const state = repo.state === 'lost' ? 'hosting' : repo.state;
    this.sql.exec("UPDATE git_repos SET primary_node_id = ?, state = ?, message = '', updated_at = ? WHERE id = ?", candidate.node!.id, state, now, repo.id);
    // Bundles are taken on the primary: whatever the old one still owed is dropped and planned afresh.
    for (const task of this.sql.exec<TaskRow>("SELECT * FROM git_tasks WHERE repo_id = ? AND kind = 'backup' AND state IN ('queued', 'leased')", repo.id).toArray()) { this.failBackup(task); this.sql.exec('DELETE FROM git_tasks WHERE id = ?', task.id); }
    if (repo.primary_node_id) this.sql.exec("UPDATE git_replicas SET state = 'stale' WHERE repo_id = ? AND node_id = ? AND state = 'current'", repo.id, repo.primary_node_id);
    this.git.audit(now, 'coordinator', repo.id, 'promote', candidate.node!.id, 0, `${candidate.node!.hostname || 'a machine'} took over from ${primary?.hostname || 'the missing primary'}`);
    return this.git.repo(repo.id)!;
  }
  // A machine switched off or removed: its copies are gone from the record; a primary hands over first when it can.
  dropNode(node: HostNode, nodes: HostNode[], now: number, offlineMs: number): void {
    for (const held of this.git.heldBy(node.id)) {
      let repo = held.repo;
      if (repo.primary_node_id === node.id) {
        repo = this.promote(repo, nodes.filter(n => n.id !== node.id), now, offlineMs);
        if (repo.primary_node_id === node.id) this.sql.exec("UPDATE git_repos SET state = 'lost', message = ?, updated_at = ? WHERE id = ? AND state IN ('hosting', 'oversize', 'degraded')", `${node.hostname || 'The machine'} that kept this repository was switched off or removed; restore it from a backup or switch the machine back on`, now, repo.id);
      }
      this.sql.exec("UPDATE git_replicas SET state = 'lost' WHERE repo_id = ? AND node_id = ?", repo.id, node.id);
      // The store is thrown away only while another copy exists; the only copy stays on disk, so switching the machine
      // back on (its agent then reports the refs it holds) brings the repository back without a restore.
      const others = this.git.replicas(repo.id).some(r => r.node_id !== node.id && r.state !== 'lost');
      if (node.active && others) this.queue('discard', repo, node.id, {}, now);
    }
    this.sql.exec("DELETE FROM git_tasks WHERE node_id = ? AND state IN ('queued', 'leased') AND kind NOT IN ('discard', 'discard-recovered')", node.id);
  }

  // The project was removed: the record goes to 'deleted' (nothing serves, replicates or backs it up any more), every
  // switched-on machine that holds a copy throws it away, and its backups go. Answers the R2 keys to delete afterwards.
  deleteRepo(repo: RepoRow, nodes: HostNode[], now: number): string[] {
    for (const task of this.sql.exec<TaskRow>("SELECT * FROM git_tasks WHERE repo_id = ? AND kind = 'backup' AND state IN ('queued', 'leased')", repo.id).toArray()) this.failBackup(task);
    this.sql.exec("DELETE FROM git_tasks WHERE repo_id = ? AND state IN ('queued', 'leased')", repo.id);
    this.sql.exec("UPDATE git_repos SET state = 'deleted', primary_node_id = NULL, job_id = NULL, message = '', updated_at = ? WHERE id = ?", now, repo.id);
    const active = new Set(nodes.filter(n => n.active).map(n => n.id));
    for (const replica of this.git.replicas(repo.id)) {
      if (active.has(replica.node_id) && replica.state !== 'lost') this.queue('discard', repo, replica.node_id, {}, now);
      else this.sql.exec('DELETE FROM git_replicas WHERE repo_id = ? AND node_id = ?', repo.id, replica.node_id);
    }
    const keys = this.backups(repo.id).map(b => b.key);
    this.sql.exec('DELETE FROM git_backups WHERE repo_id = ?', repo.id);
    this.sql.exec('DELETE FROM git_recovered WHERE repo_id = ?', repo.id);
    return keys;
  }

  // ---- backups: bundles of the primary in R2, a full one weekly and an incremental one after pushes ----

  backups(repoId: string): BackupRow[] { return this.sql.exec<BackupRow>('SELECT * FROM git_backups WHERE repo_id = ? ORDER BY created_at', repoId).toArray(); }
  planBackup(repo: RepoRow, nodes: HostNode[], now: number, offlineMs: number): TaskRow | null {
    if (repo.state !== 'hosting' || !repo.primary_node_id || this.pending(repo.id, 'backup')) return null;
    const primary = nodes.find(n => n.id === repo.primary_node_id);
    if (!primary || !hostEligible(primary, now, offlineMs)) return null;
    const ready = this.backups(repo.id).filter(b => b.ready).sort((a, b) => b.created_at - a.created_at);
    const newestFull = ready.find(b => b.kind === 'full'), newest = ready[0];
    const refs = (JSON.parse(repo.refs_json) as Tips).length;
    let kind: 'full' | 'incremental';
    if (!newestFull || newestFull.created_at <= now - BACKUP_FULL_EVERY_MS) kind = 'full';
    else if (newest && (repo.last_push_at ?? repo.updated_at) > newest.created_at && (repo.last_push_at ?? repo.updated_at) <= now - BACKUP_DEBOUNCE_MS) kind = 'incremental';
    else return null;
    if (kind === 'incremental' && newest && JSON.stringify(JSON.parse(newest.tips_json)) === repo.refs_json) return null;   // nothing new since the newest bundle
    if (refs === 0) return null;
    const id = crypto.randomUUID(), key = backupKey(this.workspaceId, repo.uuid, id);
    this.sql.exec('INSERT INTO git_backups (id, repo_id, kind, key, base_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, repo.id, kind, key, kind === 'incremental' ? newest!.id : null, now);
    return this.queue('backup', repo, repo.primary_node_id, { backupId: id, kind, key, baseTips: kind === 'incremental' ? JSON.parse(newest!.tips_json) as Tips : null }, now);
  }
  backup(id: string): BackupRow | undefined { return this.sql.exec<BackupRow>('SELECT * FROM git_backups WHERE id = ?', id).toArray()[0]; }
  // The bundle is in R2 with the declared size: the manifest becomes ready and retention names what to delete.
  completeBackup(task: TaskRow, report: { size: number; sha256: string; tips: Tips; kind: 'full' | 'incremental' }, now: number): string[] {
    const { backupId } = JSON.parse(task.payload) as { backupId: string };
    const row = this.backup(backupId); if (!row) return [];
    // A machine that could not build the incremental made a full instead (its base was gone): the manifest follows.
    this.sql.exec('UPDATE git_backups SET ready = 1, size = ?, sha256 = ?, tips_json = ?, kind = ?, base_id = CASE WHEN ? = ? THEN base_id ELSE NULL END, created_at = ? WHERE id = ?', report.size, report.sha256, JSON.stringify(report.tips), report.kind, report.kind, row.kind, now, backupId);
    this.sql.exec('UPDATE git_repos SET last_backup_at = ? WHERE id = ?', now, task.repo_id);
    const { drop } = retainBackups(this.backups(task.repo_id));
    for (const b of drop) this.sql.exec('DELETE FROM git_backups WHERE id = ?', b.id);
    return drop.map(b => b.key);
  }
  failBackup(task: TaskRow): void { const { backupId } = JSON.parse(task.payload) as { backupId: string }; this.sql.exec('DELETE FROM git_backups WHERE id = ? AND ready = 0', backupId); }

  // ---- restore: a lost repository comes back from its bundles onto a machine that can host ----

  restorable(repo: RepoRow): boolean { return restoreChain(this.backups(repo.id)).length > 0; }
  // Automatically for a lost repository, or when its primary has been gone a day with no current copy; on request at any time.
  planRestore(repo: RepoRow, nodes: HostNode[], now: number, offlineMs: number, forced = false): TaskRow | null {
    if (!['hosting', 'degraded', 'lost', 'oversize'].includes(repo.state) || this.pending(repo.id, 'restore')) return null;
    const primary = nodes.find(n => n.id === repo.primary_node_id);
    const primaryUp = Boolean(primary && hostEligible(primary, now, offlineMs));
    if (primaryUp && !forced) return null;
    if (!forced && repo.state !== 'lost' && (primary?.last_seen_at ?? 0) > now - RESTORE_AFTER_OFFLINE_MS) return null;
    if (this.git.servers(repo, nodes, now, offlineMs, false).length && !forced) return null;   // a current copy serves reads; promotion handles writes
    const chain = restoreChain(this.backups(repo.id));
    if (!chain.length) { if (forced) fail(409, 'no_backup', 'There is no backup of this repository to restore from'); return null; }
    const holders = new Set(this.git.replicas(repo.id).filter(r => r.state !== 'lost').map(r => r.node_id));
    const target = nodes.filter(n => hostEligible(n, now, offlineMs) && !holders.has(n.id) && (freeBytes(n) === 0 || freeBytes(n) >= REPLICA_FREE_MARGIN(repo.bytes))).sort((a, b) => freeBytes(b) - freeBytes(a))[0];
    if (!target) { if (forced) fail(503, 'no_host', 'No online machine that keeps copies is free to take the restore'); return null; }
    const newest = chain[chain.length - 1];
    return this.queue('restore', repo, target.id, { defaultBranch: repo.default_branch, recordTips: JSON.parse(repo.refs_json) as Tips, newestTips: JSON.parse(newest.tips_json) as Tips, backedUpAt: newest.created_at,
      backups: chain.map(b => ({ id: b.id, key: b.key, size: b.size, sha256: b.sha256, kind: b.kind })) }, now);
  }
  // The restored copy becomes the primary: hosting when it matches the record, degraded (pushes refused) when the record
  // is newer than the backup, until an owner accepts the loss or a copy with the newer refs comes back and is promoted.
  completeRestore(task: TaskRow, node: HostNode, report: { tips: Tips; digest: string; bytes: number }, now: number): RepoRow {
    const repo = this.git.repo(task.repo_id)!;
    const payload = JSON.parse(task.payload) as { backedUpAt: number };
    const equal = report.digest === repo.refs_digest;
    const missing = (JSON.parse(repo.refs_json) as Tips).filter(([sha, ref]) => !report.tips.some(([s, r]) => r === ref && s === sha)).length;
    this.sql.exec("INSERT INTO git_replicas (repo_id, node_id, state, generation, tips_digest, bytes, last_sync_at, tips_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repo_id, node_id) DO UPDATE SET state = excluded.state, generation = excluded.generation, tips_digest = excluded.tips_digest, bytes = excluded.bytes, last_sync_at = excluded.last_sync_at, tips_json = excluded.tips_json",
      repo.id, node.id, equal ? 'current' : 'stale', equal ? repo.generation : 0, report.digest, report.bytes, now, equal ? '[]' : JSON.stringify(report.tips));
    if (repo.primary_node_id && repo.primary_node_id !== node.id) this.sql.exec("UPDATE git_replicas SET state = CASE WHEN state = 'lost' THEN 'lost' ELSE 'stale' END WHERE repo_id = ? AND node_id = ?", repo.id, repo.primary_node_id);
    const message = equal ? '' : `Restored from the backup of ${new Date(payload.backedUpAt).toISOString().replace('T', ' ').slice(0, 16)} UTC; ${missing} ref${missing === 1 ? '' : 's'} newer in Smith’s record may be lost. Pushes are refused until an owner accepts the restore or a machine holding the newer refs comes back`;
    this.sql.exec('UPDATE git_repos SET primary_node_id = ?, state = ?, message = ?, bytes = ?, updated_at = ? WHERE id = ?', node.id, equal ? 'hosting' : 'degraded', message, report.bytes, now, repo.id);
    this.git.audit(now, 'coordinator', repo.id, 'restore', node.id, report.bytes, equal ? 'restored, matches the record' : `restored, ${missing} refs behind the record`);
    return this.git.repo(repo.id)!;
  }
  // An owner accepts that the restored copy is the repository now: the record takes its refs and every other copy syncs
  // to it (quarantining what they held beyond it). Refused while an online copy still holds the newer record.
  acceptDataloss(repo: RepoRow, nodes: HostNode[], now: number, offlineMs: number, digestOf: (tips: Tips) => string): RepoRow {
    if (repo.state !== 'degraded' || !repo.primary_node_id) fail(409, 'not_degraded', 'This repository is not waiting for a restore to be accepted');
    const newer = this.git.replicas(repo.id).filter(r => r.state === 'current' && r.node_id !== repo.primary_node_id).map(r => nodes.find(n => n.id === r.node_id)).filter((n): n is HostNode => Boolean(n) && hostEligible(n!, now, offlineMs));
    if (newer.length) fail(409, 'newer_copy_online', `${newer[0].hostname} is online and holds the newer refs; Smith promotes it instead of losing them`);
    const restored = this.git.replicas(repo.id).find(r => r.node_id === repo.primary_node_id);
    if (!restored) fail(409, 'no_copy', 'The restored copy is gone');
    const tips = JSON.parse(restored.tips_json) as Tips; const digest = digestOf(tips);
    this.sql.exec("UPDATE git_repos SET refs_json = ?, refs_digest = ?, generation = generation + 1, state = 'hosting', message = '', updated_at = ? WHERE id = ?", JSON.stringify(tips), digest, now, repo.id);
    const current = this.git.repo(repo.id)!;
    this.sql.exec("UPDATE git_replicas SET state = 'current', generation = ?, tips_json = '[]' WHERE repo_id = ? AND node_id = ?", current.generation, repo.id, repo.primary_node_id);
    this.sql.exec("UPDATE git_replicas SET state = 'stale' WHERE repo_id = ? AND node_id != ? AND state = 'current'", repo.id, repo.primary_node_id);
    this.git.audit(now, 'owner', repo.id, 'accept-dataloss', repo.primary_node_id, 0, 'the restored copy is the record now');
    return current;
  }

  // ---- recovered refs: what a copy held beyond the record, kept under refs/smith/recovered/* until a person decides ----

  recovered(repoId: string): RecoveredRow[] { return this.sql.exec<RecoveredRow>('SELECT * FROM git_recovered WHERE repo_id = ? ORDER BY recorded_at, ref', repoId).toArray(); }
  recordRecovered(repoId: string, nodeId: string, refs: Tips, now: number): void {
    for (const [sha, ref] of refs) this.sql.exec('INSERT INTO git_recovered (repo_id, node_id, ref, sha, recorded_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(repo_id, node_id, ref) DO UPDATE SET sha = excluded.sha, recorded_at = excluded.recorded_at', repoId, nodeId, ref, sha, now);
  }
  // Promote: the machine holding it pushes the recovered ref to the primary through the relay (the hook still protects
  // the default branch, so a non-fast-forward is refused there). Discard: the row goes now, the ref on the machine after.
  decideRecovered(repo: RepoRow, nodeId: string, ref: string, action: 'promote' | 'discard', now: number): TaskRow | null {
    const row = this.sql.exec<RecoveredRow>('SELECT * FROM git_recovered WHERE repo_id = ? AND node_id = ? AND ref = ?', repo.id, nodeId, ref).toArray()[0];
    if (!row) fail(404, 'not_found', 'No such recovered ref');
    const recoveredRef = row.ref.startsWith('refs/smith/recovered/') ? row.ref : `refs/smith/recovered/${row.ref.replace(/^refs\//, '')}`;
    const target = row.ref.startsWith('refs/smith/recovered/') ? row.ref.replace(/^refs\/smith\/recovered\/\d+\//, 'refs/') : row.ref;
    if (action === 'discard') { this.sql.exec('DELETE FROM git_recovered WHERE repo_id = ? AND node_id = ? AND ref = ?', repo.id, nodeId, ref); return this.queue('discard-recovered', repo, nodeId, { recoveredRef }, now); }
    return this.queue('promote', repo, nodeId, { remote: smithRemote(this.origin, repo.id), sha: row.sha, ref: target, recoveredRef }, now);
  }
  promoted(repo: RepoRow, nodeId: string, task: TaskRow): void {
    const { recoveredRef } = JSON.parse(task.payload) as { recoveredRef: string };
    this.sql.exec('DELETE FROM git_recovered WHERE repo_id = ? AND node_id = ? AND (ref = ? OR ref = ?)', repo.id, nodeId, recoveredRef, recoveredRef.replace(/^refs\/smith\/recovered\/\d+\//, 'refs/'));
  }

  // ---- what people see ----
  publicTasks(repoId: string, nodes: HostNode[]) {
    return this.tasks(repoId).map(t => ({ kind: t.kind, host: nodes.find(n => n.id === t.node_id)?.hostname ?? t.node_id.slice(0, 8), state: t.state, attempts: t.attempts, message: t.message, nextAttemptAt: t.next_attempt_at }));
  }
  publicBackups(repoId: string) {
    const all = this.backups(repoId).filter(b => b.ready), ready = all.filter(b => b.kind !== 'original');
    return { count: ready.length, bytes: all.reduce((sum, b) => sum + b.size, 0), newestAt: ready.length ? Math.max(...ready.map(b => b.created_at)) : null, restorable: restoreChain(ready).length > 0,
      originals: all.filter(b => b.kind === 'original').map(b => ({ id: b.id, size: b.size, createdAt: b.created_at })) };
  }
  publicRecovered(repoId: string, nodes: HostNode[]) {
    return this.recovered(repoId).map(r => ({ nodeId: r.node_id, host: nodes.find(n => n.id === r.node_id)?.hostname ?? r.node_id.slice(0, 8), ref: r.ref, sha: r.sha, recordedAt: r.recorded_at }));
  }
  nextDue(now: number): number | null {
    const due = this.sql.exec<{ due: number | null }>("SELECT MIN(CASE WHEN state = 'leased' THEN lease_expires_at ELSE next_attempt_at END) AS due FROM git_tasks WHERE state IN ('queued', 'leased')").one().due;
    const quiet = this.sql.exec<{ due: number | null }>("SELECT MIN(last_push_at) AS due FROM git_repos WHERE state = 'hosting' AND last_push_at > COALESCE(last_backup_at, 0)").one().due;
    const dues = [due, quiet === null ? null : quiet + BACKUP_DEBOUNCE_MS + 1000].filter((d): d is number => typeof d === 'number');
    return dues.length ? Math.max(now + 1, Math.min(...dues)) : null;
  }
}
function freeBytes(node: HostNode): number {
  const hosting = (node as HostNode & { hosting?: string }).hosting;
  if (!hosting) return 0;
  try { return Number((JSON.parse(hosting) as { free?: number }).free ?? 0) || 0; } catch { return 0; }
}
export { MAX_REPO_BYTES };
