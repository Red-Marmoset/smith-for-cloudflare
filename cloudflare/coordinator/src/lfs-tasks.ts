// Work machines do for large files (spec §8): fetch a copy of an object, restore a lost object to R2, drop a copy.
// Planned by the alarm through the copies planner (copies.ts: a budget per machine, a target number of copies per object; a
// lost object goes back from any online holder), handed out on the machine's git/poll, four at a time, under a lease.
import { fail } from './http';
import type { NodeRow } from './workspace';
import type { LfsStore } from './lfs';

export type LfsTaskKind = 'fetch' | 'restore' | 'drop';
export type LfsTaskRow = { id: string; repo_id: string; oid: string; node_id: string; kind: LfsTaskKind; state: 'queued' | 'leased' | 'done'; lease_token: string | null; lease_expires_at: number | null; attempts: number; next_attempt_at: number; message: string; created_at: number; updated_at: number };
export const LFS_TASK_LEASE_MS = 120000;
export const LFS_TASKS_PER_POLL = 4;
export const LFS_PLAN_LIMIT = 50;
const RETRY_MS = (attempts: number) => Math.min(3600000, 60000 * 2 ** Math.min(attempts, 6));
// A lease lasts as long as the object takes to move at a slow link (a second per 256 KiB) plus the base; a 5 GiB
// object gets about six hours. Every step the machine takes renews it.
export const leaseMs = (size: number) => LFS_TASK_LEASE_MS + Math.ceil(Math.max(0, size) / 262144) * 1000;

export function nodeFreeBytes(node: NodeRow): number {
  if (!node.hosting) return 0;
  try { return Number((JSON.parse(node.hosting) as { free?: number }).free ?? 0) || 0; } catch { return 0; }
}
// Keeps large files here: active, a build machine, switched on, not draining, online.
export function lfsEligible(node: NodeRow, now: number, offlineMs: number): boolean {
  return Boolean(node.active) && node.purpose === 'build' && Boolean(node.host_lfs) && !node.draining && node.last_seen_at > now - offlineMs;
}
const online = (node: NodeRow, now: number, offlineMs: number) => Boolean(node.active) && node.last_seen_at > now - offlineMs;

export class LfsTasks {
  constructor(private readonly sql: SqlStorage) {}
  task(id: string): LfsTaskRow { const row = this.sql.exec<LfsTaskRow>('SELECT * FROM lfs_tasks WHERE id = ?', id).toArray()[0]; if (!row) fail(404, 'not_found', 'Task not found'); return row; }
  pendingFor(nodeId: string): boolean { return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM lfs_tasks WHERE node_id = ? AND state IN ('queued', 'leased')", nodeId).one().n > 0; }
  private pending(kind: LfsTaskKind, repoId: string, oid: string, nodeId: string | null): boolean {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM lfs_tasks WHERE kind = ? AND repo_id = ? AND oid = ? AND state IN ('queued', 'leased')${nodeId ? ' AND node_id = ?' : ''}`, ...(nodeId ? [kind, repoId, oid, nodeId] : [kind, repoId, oid])).one().n > 0;
  }
  queue(kind: LfsTaskKind, repoId: string, oid: string, nodeId: string, now: number, delayMs = 0): LfsTaskRow | null {
    if (this.pending(kind, repoId, oid, nodeId)) return null;
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO lfs_tasks (id, repo_id, oid, node_id, kind, state, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)", id, repoId, oid, nodeId, kind, now + delayMs, now, now);
    return this.task(id);
  }
  // A machine's poll: up to LFS_TASKS_PER_POLL leased at once; `leaseTokens` were minted before the transaction.
  poll(node: NodeRow, leaseTokens: string[], now: number): LfsTaskRow[] {
    const leased = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM lfs_tasks WHERE node_id = ? AND state = 'leased'", node.id).one().n;
    const room = Math.min(leaseTokens.length, LFS_TASKS_PER_POLL - leased);
    if (room <= 0) return [];
    const next = this.sql.exec<LfsTaskRow>("SELECT * FROM lfs_tasks WHERE node_id = ? AND state = 'queued' AND next_attempt_at <= ? ORDER BY created_at LIMIT ?", node.id, now, room).toArray();
    return next.map((row, i) => {
      this.sql.exec("UPDATE lfs_tasks SET state = 'leased', lease_token = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?", leaseTokens[i], now + leaseMs(this.objectSize(row)), now, row.id);
      return this.task(row.id);
    });
  }
  private objectSize(row: LfsTaskRow): number { return this.sql.exec<{ size: number }>('SELECT size FROM lfs_objects WHERE repo_id = ? AND oid = ?', row.repo_id, row.oid).toArray()[0]?.size ?? 0; }
  // The machine's task under its lease; each step renews the lease for another transfer's worth of time.
  held(id: string, node: NodeRow, leaseToken: string, now: number): LfsTaskRow {
    const row = this.task(id);
    if (row.node_id !== node.id || row.lease_token !== leaseToken) fail(409, 'stale_task', 'This task is not yours');
    if (row.state !== 'leased' || (row.lease_expires_at ?? 0) <= now) fail(409, 'stale_task', 'This task’s lease has ended');
    this.sql.exec('UPDATE lfs_tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ?', now + leaseMs(this.objectSize(row)), now, id);
    return this.task(id);
  }
  // When the alarm must next look at tasks: a queued task's retry time or a lease running out.
  nextDue(now: number): number | null {
    const row = this.sql.exec<{ at: number | null }>("SELECT MIN(CASE WHEN state = 'queued' THEN next_attempt_at ELSE lease_expires_at END) AS at FROM lfs_tasks WHERE state IN ('queued', 'leased')").one();
    return row.at === null ? null : Math.max(row.at, now);
  }
  settle(id: string, ok: boolean, message: string, now: number): LfsTaskRow {
    const row = this.task(id);
    if (ok) this.sql.exec("UPDATE lfs_tasks SET state = 'done', message = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?", message.slice(0, 300), now, id);
    else this.sql.exec("UPDATE lfs_tasks SET state = 'queued', message = ?, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?", message.slice(0, 300), now + RETRY_MS(row.attempts), now, id);
    return this.task(id);
  }
  cancel(id: string): void { this.sql.exec('DELETE FROM lfs_tasks WHERE id = ?', id); }
  // A machine switched off: its waiting copies and restores are cancelled (the planner finds another holder); drops stay.
  cancelFor(nodeId: string, kinds: LfsTaskKind[]): void { for (const kind of kinds) this.sql.exec("DELETE FROM lfs_tasks WHERE node_id = ? AND kind = ? AND state IN ('queued', 'leased')", nodeId, kind); }
  // Leases that ran out go back to the queue; fetches for machines no longer switched on (or gone) are dropped, and
  // every task of a machine that was removed; drops survive a switch-off (that is how the machine clears its store).
  expire(now: number, nodes: NodeRow[]): void {
    this.sql.exec("UPDATE lfs_tasks SET state = 'queued', lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, updated_at = ? WHERE state = 'leased' AND lease_expires_at <= ?", now, now, now);
    for (const row of this.sql.exec<LfsTaskRow>("SELECT * FROM lfs_tasks WHERE state IN ('queued', 'leased')").toArray()) {
      const node = nodes.find(n => n.id === row.node_id);
      if (!node || !node.active || (row.kind === 'fetch' && !node.host_lfs)) this.sql.exec('DELETE FROM lfs_tasks WHERE id = ?', row.id);
    }
    // Tasks their object no longer needs: a fetch of an object that is not ready, a restore of one that is not lost.
    this.sql.exec(`DELETE FROM lfs_tasks WHERE state IN ('queued', 'leased') AND (
      (kind = 'fetch' AND NOT EXISTS (SELECT 1 FROM lfs_objects o WHERE o.repo_id = lfs_tasks.repo_id AND o.oid = lfs_tasks.oid AND o.state = 'ready'))
      OR (kind = 'restore' AND NOT EXISTS (SELECT 1 FROM lfs_objects o WHERE o.repo_id = lfs_tasks.repo_id AND o.oid = lfs_tasks.oid AND o.state = 'lost')))`);
    this.sql.exec("DELETE FROM lfs_tasks WHERE state = 'done' AND updated_at <= ?", now - 86400000);
  }
  pendingRestore(repoId: string, oid: string): boolean { return this.pending('restore', repoId, oid, null); }
}
