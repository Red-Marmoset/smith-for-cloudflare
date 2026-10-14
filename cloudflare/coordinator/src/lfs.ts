// Git LFS on Smith: the record of large objects a workspace keeps in R2 (one row per project + oid) and the pure
// pieces of the batch API. Objects live at lfs/<workspace>/<project>/<oid> in the GIT bucket; a row is `pending`
// from the batch answer that allowed an upload until the bytes are verified, then `ready`.
import { fail } from './http';

export const OID = /^[a-f0-9]{64}$/;
export const LFS_MEDIA = 'application/vnd.git-lfs+json';
export const LFS_MAX_OBJECTS = 1000;
export const LFS_MAX_OBJECT_BYTES = 5 * 1024 * 1024 * 1024;      // R2's single-PUT ceiling
export const DEFAULT_PROXY_MAX_BYTES = 100 * 1024 * 1024;       // the Workers request-body limit on Free and Pro plans
export const LFS_EXPIRES_SECONDS = 3600;
export const LFS_PENDING_TTL_MS = 24 * 3600000;
export const DEFAULT_LFS_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
export const LFS_LABEL = 'git-lfs';                              // advertised by agents that have git-lfs installed
export const DEFAULT_LFS_RESERVE_BYTES = 10 * 1024 * 1024 * 1024;  // free disk a machine keeps while holding copies (spec §8)
export const LFS_AUDIT_BATCH = 200;                              // objects checked against R2 per sweep after "Check large files"

// lfs_replicas: which machines hold a copy of an object. lfs_tasks: the fetch / restore / drop work handed to them on
// git/poll. lfs_audit: the ready objects still to check against R2 after an owner asked for it.
export const LFS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS lfs_objects (repo_id TEXT NOT NULL, oid TEXT NOT NULL, size INTEGER NOT NULL, state TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, ready_at INTEGER, PRIMARY KEY (repo_id, oid));
  CREATE TABLE IF NOT EXISTS lfs_replicas (repo_id TEXT NOT NULL, oid TEXT NOT NULL, node_id TEXT NOT NULL, held_at INTEGER NOT NULL, PRIMARY KEY (repo_id, oid, node_id));
  CREATE INDEX IF NOT EXISTS lfs_replicas_node ON lfs_replicas(node_id);
  CREATE TABLE IF NOT EXISTS lfs_tasks (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, oid TEXT NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
    lease_token TEXT, lease_expires_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, message TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS lfs_tasks_node ON lfs_tasks(node_id, state, next_attempt_at);
  CREATE TABLE IF NOT EXISTS lfs_audit (repo_id TEXT NOT NULL, oid TEXT NOT NULL, PRIMARY KEY (repo_id, oid));
`;

export type LfsState = 'pending' | 'ready' | 'lost';
export type LfsRow = { repo_id: string; oid: string; size: number; state: LfsState; created_by: string; created_at: number; ready_at: number | null };
export interface LfsObjectRequest { oid: string; size: number }
export type LfsVerdict = { oid: string; size: number; have: true } | { oid: string; size: number; upload: true } | { oid: string; size: number; error: { code: number; message: string } };

export function lfsKey(workspaceId: string, repoId: string, oid: string): string { return `lfs/${workspaceId}/${repoId}/${oid}`; }
export function lfsUrl(origin: string, repoId: string): string { return `${origin}/git/${repoId}.git/info/lfs`; }
export function lfsConfigSnippet(origin: string, repoId: string): string { return `[lfs]\n\turl = ${lfsUrl(origin, repoId)}\n`; }

// "340 MB", "5.4 GB": one decimal only when it is not zero, binary units named the way people say them.
export function formatBytes(n: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = n, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[unit]}`;
}

// The batch request body (docs/api/batch.md). `transfers` and `ref` are accepted and ignored: the answer is always the
// basic transfer. Anything but sha256 is a 422 for the whole request.
export function parseBatchRequest(body: unknown): { operation: 'download' | 'upload'; objects: LfsObjectRequest[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(422, 'invalid_body', 'The batch request must be a JSON object');
  const b = body as Record<string, unknown>;
  if (b.operation !== 'download' && b.operation !== 'upload') fail(422, 'invalid_field', 'operation must be download or upload');
  if (b.hash_algo !== undefined && b.hash_algo !== 'sha256') fail(422, 'invalid_field', 'Only sha256 object ids are supported');
  if (!Array.isArray(b.objects)) fail(422, 'invalid_field', 'objects must be an array');
  if (b.objects.length > LFS_MAX_OBJECTS) fail(413, 'too_many', `A batch names at most ${LFS_MAX_OBJECTS} objects`);
  const objects = b.objects.map(entry => {
    const o = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    if (typeof o.oid !== 'string' || !OID.test(o.oid)) fail(422, 'invalid_field', 'Each object needs a 64-hex sha256 oid');
    if (typeof o.size !== 'number' || !Number.isSafeInteger(o.size) || o.size < 0) fail(422, 'invalid_field', 'Each object needs a non-negative integer size');
    return { oid: o.oid, size: o.size };
  });
  return { operation: b.operation, objects };
}

export interface VerdictOptions { quotaBytes: number; proxyMaxBytes: number | null; who: string; now: number }

export class LfsStore {
  constructor(private readonly sql: SqlStorage) {}
  get(repoId: string, oid: string): LfsRow | undefined { return this.sql.exec<LfsRow>('SELECT * FROM lfs_objects WHERE repo_id = ? AND oid = ?', repoId, oid).toArray()[0]; }
  usage(repoId?: string): { objects: number; bytes: number } {
    const row = repoId === undefined
      ? this.sql.exec<{ objects: number; bytes: number | null }>('SELECT COUNT(*) AS objects, SUM(size) AS bytes FROM lfs_objects').one()
      : this.sql.exec<{ objects: number; bytes: number | null }>('SELECT COUNT(*) AS objects, SUM(size) AS bytes FROM lfs_objects WHERE repo_id = ?', repoId).one();
    return { objects: row.objects, bytes: row.bytes ?? 0 };
  }
  readyCount(repoId: string): number { return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM lfs_objects WHERE repo_id = ? AND state = 'ready'", repoId).one().n; }
  // One verdict per requested object, in order. Download: have it or 404. Upload: have it (same size), 422 on a size
  // clash, 413 past a cap, else a pending row and permission to upload. The quota is checked once for the whole batch
  // (507), counting ready and pending bytes plus the new ones; a repeated oid is charged once. A lost object may be
  // uploaded again but stays `lost` until the bytes arrive: the copies machines hold are never swept on its account.
  verdicts(repoId: string, operation: 'download' | 'upload', objects: LfsObjectRequest[], o: VerdictOptions): LfsVerdict[] {
    if (operation === 'download') {
      return objects.map(({ oid, size }) => {
        const row = this.get(repoId, oid);
        if (row?.state === 'ready') return { oid, size: row.size, have: true };
        if (row?.state === 'lost') return { oid, size: row.size, error: { code: 404, message: this.holders(repoId, oid).length ? 'Object lost from storage; a machine holding a copy restores it' : 'Object lost from storage; no machine holds a copy' } };
        return { oid, size, error: { code: 404, message: 'Object not found' } };
      });
    }
    const charged = new Set<string>(); let needed = 0;
    const decided: LfsVerdict[] = objects.map(({ oid, size }) => {
      const row = this.get(repoId, oid);
      if (row?.state === 'ready') return row.size === size ? { oid, size, have: true } : { oid, size, error: { code: 422, message: `Object exists with a different size (${row.size} bytes)` } };
      if (size > LFS_MAX_OBJECT_BYTES) return { oid, size, error: { code: 413, message: 'Objects over 5 GB cannot be stored' } };
      if (o.proxyMaxBytes !== null && size > o.proxyMaxBytes) return { oid, size, error: { code: 413, message: `Objects over ${formatBytes(o.proxyMaxBytes)} need direct uploads to R2; see Settings → Large files` } };
      if (!row && !charged.has(oid)) { charged.add(oid); needed += size; }
      return { oid, size, upload: true };
    });
    const used = this.usage().bytes;
    if (needed && used + needed > o.quotaBytes) fail(507, 'quota', `Smith keeps ${formatBytes(o.quotaBytes)} of large files for this workspace; this push needs ${formatBytes(used + needed)}`);
    for (const v of decided) {
      if (!('upload' in v)) continue;
      this.sql.exec(`INSERT INTO lfs_objects (repo_id, oid, size, state, created_by, created_at) VALUES (?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(repo_id, oid) DO UPDATE SET size = excluded.size, created_by = excluded.created_by, created_at = excluded.created_at WHERE lfs_objects.state = 'pending'`,
        repoId, v.oid, v.size, o.who, o.now);
    }
    return decided;
  }
  markReady(repoId: string, oid: string, size: number, now: number): LfsRow {
    this.sql.exec(`INSERT INTO lfs_objects (repo_id, oid, size, state, created_by, created_at, ready_at) VALUES (?, ?, ?, 'ready', '', ?, ?)
      ON CONFLICT(repo_id, oid) DO UPDATE SET size = excluded.size, state = 'ready', ready_at = excluded.ready_at`, repoId, oid, size, now, now);
    return this.get(repoId, oid)!;
  }
  forget(repoId: string, oid: string): void { this.sql.exec('DELETE FROM lfs_objects WHERE repo_id = ? AND oid = ?', repoId, oid); }
  ready(): LfsRow[] { return this.sql.exec<LfsRow>("SELECT * FROM lfs_objects WHERE state = 'ready' ORDER BY ready_at, oid").toArray(); }
  lostRows(): LfsRow[] { return this.sql.exec<LfsRow>("SELECT * FROM lfs_objects WHERE state = 'lost' ORDER BY created_at, oid").toArray(); }
  lostCount(repoId?: string): number {
    return repoId === undefined ? this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM lfs_objects WHERE state = 'lost'").one().n
      : this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM lfs_objects WHERE state = 'lost' AND repo_id = ?", repoId).one().n;
  }
  // R2 no longer has a ready object: lost until a machine holding a copy restores it (or a client uploads it again).
  markLost(repoId: string, oid: string): void { this.sql.exec("UPDATE lfs_objects SET state = 'lost', ready_at = NULL WHERE repo_id = ? AND oid = ? AND state = 'ready'", repoId, oid); }
  // ---- copies on machines (spec §8) ----
  holders(repoId: string, oid: string): string[] { return this.sql.exec<{ node_id: string }>('SELECT node_id FROM lfs_replicas WHERE repo_id = ? AND oid = ? ORDER BY held_at', repoId, oid).toArray().map(r => r.node_id); }
  recordHeld(repoId: string, oid: string, nodeId: string, now: number): void { this.sql.exec('INSERT INTO lfs_replicas (repo_id, oid, node_id, held_at) VALUES (?, ?, ?, ?) ON CONFLICT(repo_id, oid, node_id) DO UPDATE SET held_at = excluded.held_at', repoId, oid, nodeId, now); }
  forgetHeld(repoId: string, oid: string, nodeId?: string): void {
    if (nodeId === undefined) this.sql.exec('DELETE FROM lfs_replicas WHERE repo_id = ? AND oid = ?', repoId, oid);
    else this.sql.exec('DELETE FROM lfs_replicas WHERE repo_id = ? AND oid = ? AND node_id = ?', repoId, oid, nodeId);
  }
  heldRows(nodeId: string): { repo_id: string; oid: string }[] { return this.sql.exec<{ repo_id: string; oid: string }>('SELECT repo_id, oid FROM lfs_replicas WHERE node_id = ?', nodeId).toArray(); }
  heldBy(nodeId: string): { objects: number; bytes: number } {
    const row = this.sql.exec<{ objects: number; bytes: number | null }>('SELECT COUNT(*) AS objects, SUM(o.size) AS bytes FROM lfs_replicas r JOIN lfs_objects o ON o.repo_id = r.repo_id AND o.oid = r.oid WHERE r.node_id = ?', nodeId).one();
    return { objects: row.objects, bytes: row.bytes ?? 0 };
  }
  copies(repoId: string): { node_id: string; held: number }[] { return this.sql.exec<{ node_id: string; held: number }>('SELECT node_id, COUNT(*) AS held FROM lfs_replicas WHERE repo_id = ? GROUP BY node_id ORDER BY node_id', repoId).toArray(); }
  // When the alarm must next run for large files: an audit still pending (a batch a minute), or the oldest pending
  // row reaching its sweep age.
  nextDue(now: number, pendingTtlMs: number): number | null {
    if (this.auditPending()) return now + 60000;
    const oldest = this.sql.exec<{ at: number | null }>("SELECT MIN(created_at) AS at FROM lfs_objects WHERE state = 'pending'").one().at;
    return oldest === null ? null : oldest + pendingTtlMs;
  }
  // ---- the audit an owner asks for: every ready object is checked against R2 in batches by the sweep ----
  queueAudit(): number { this.sql.exec("INSERT OR IGNORE INTO lfs_audit (repo_id, oid) SELECT repo_id, oid FROM lfs_objects WHERE state = 'ready'"); return this.auditPending(); }
  auditPending(): number { return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM lfs_audit').one().n; }
  auditBatch(limit: number): { repo_id: string; oid: string }[] { return this.sql.exec<{ repo_id: string; oid: string }>('SELECT repo_id, oid FROM lfs_audit ORDER BY repo_id, oid LIMIT ?', limit).toArray(); }
  deleteAudit(rows: { repo_id: string; oid: string }[]): void { for (const r of rows) this.sql.exec('DELETE FROM lfs_audit WHERE repo_id = ? AND oid = ?', r.repo_id, r.oid); }
  // Pending rows older than `before`, removed; the caller deletes any object left in R2 under their keys.
  sweepPending(before: number): LfsRow[] {
    const rows = this.sql.exec<LfsRow>("SELECT * FROM lfs_objects WHERE state = 'pending' AND created_at < ?", before).toArray();
    this.sql.exec("DELETE FROM lfs_objects WHERE state = 'pending' AND created_at < ?", before);
    return rows;
  }
  // Rows of projects that no longer exist (`keep` says which ids still do), removed; the caller deletes their objects.
  sweepRepos(keep: (repoId: string) => boolean): LfsRow[] {
    const gone = this.sql.exec<{ repo_id: string }>('SELECT DISTINCT repo_id FROM lfs_objects').toArray().map(r => r.repo_id).filter(id => !keep(id));
    const rows: LfsRow[] = [];
    for (const id of gone) { rows.push(...this.sql.exec<LfsRow>('SELECT * FROM lfs_objects WHERE repo_id = ?', id).toArray()); this.sql.exec('DELETE FROM lfs_objects WHERE repo_id = ?', id); }
    return rows;
  }
}
