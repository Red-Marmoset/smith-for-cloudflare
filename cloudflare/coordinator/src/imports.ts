// Import from GitHub (spec §5): an import's record and the jobs it runs. The organisation listing is github-reader.ts; the
// workspace object starts, settles, retries and cancels (git-workspace.ts); the agent does the work (HostedImport.cpp).
import { fail, fields, object, string } from './http';
import { smokeSpec, type ImportReport, type ImportSpec, type ResolvedJobSpec } from './contracts';
import { validateScanReport } from './repo-projects';
import { formatBytes } from './lfs';

export const IMPORT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, source TEXT NOT NULL, org TEXT NOT NULL, created_by TEXT NOT NULL, threshold_bytes INTEGER NOT NULL, link INTEGER NOT NULL,
    state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS import_repos (import_id TEXT NOT NULL, full_name TEXT NOT NULL, url TEXT NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL, job_id TEXT,
    message TEXT NOT NULL DEFAULT '', rewritten INTEGER NOT NULL DEFAULT 0, moved_files INTEGER NOT NULL DEFAULT 0, moved_bytes INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (import_id, full_name));
  CREATE INDEX IF NOT EXISTS import_repos_job ON import_repos(job_id);
  CREATE TABLE IF NOT EXISTS job_blobs (job_id TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL, upload_id TEXT, parts TEXT NOT NULL DEFAULT '[]', size INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (job_id, name));
`;
export const IMPORT_LABEL = 'smith-import';
export const IMPORT_PRODUCT = 'import-from-github';
export const IMPORT_RETRY_MS = [60000, 300000, 900000];
// The storage write token is minted when Import is clicked and used when the job reaches the push: a batch of fifty
// repositories waits hours on one machine, so the token lives a day (repo-scoped, on a repository that is empty until it
// lands) and ends at settlement; a push it no longer opens is retried with a fresh one.
export const IMPORT_TOKEN_TTL_SECONDS = 86400;
export const IMPORT_TIMEOUT_SECONDS = 4 * 3600;
export const ORIGINAL_BLOB = 'original.bundle';
export type ImportState = 'running' | 'done' | 'cancelled';
export type ImportRepoState = 'queued' | 'running' | 'done' | 'machine' | 'failed' | 'cancelled';
export type ImportRow = { id: string; source: 'github'; org: string; created_by: string; threshold_bytes: number; link: number; state: ImportState; created_at: number; updated_at: number };
export type ImportRepoRow = { import_id: string; full_name: string; url: string; project_id: string; state: ImportRepoState; job_id: string | null; message: string; rewritten: number; moved_files: number; moved_bytes: number; attempts: number; next_attempt_at: number; updated_at: number };

export function rewrittenMessage(files: number, bytes: number): string { return `History rewritten on import: ${files} ${files === 1 ? 'file' : 'files'} (${formatBytes(bytes)}) moved to large files; original history kept`; }
export const OVERSIZE_MESSAGE = 'On a build machine: over 1 GB, too large for Smith’s storage';

export function importSpecs(projectId: string, jobId: string, spec: ImportSpec): Record<string, ResolvedJobSpec> {
  const specs: Record<string, ResolvedJobSpec> = {};
  for (const os of ['windows', 'linux', 'mac']) specs[os] = { ...smokeSpec(jobId, os), kind: 'import', projectId, buildNumber: 0, timeoutSeconds: IMPORT_TIMEOUT_SECONDS, repos: [], import: spec };
  return specs;
}
export function validateImportReport(value: unknown): ImportReport {
  const r = object(value); fields(r, ['commit', 'branch', 'scan', 'rewritten', 'movedFiles', 'movedBytes', 'lfsObjects', 'lfsBytes', 'originalBundle']);
  const commit = string(r, 'commit', 40); if (!/^[a-f0-9]{40}$/.test(commit)) fail(400, 'invalid_field', 'commit must be a full SHA');
  const branch = string(r, 'branch', 256);
  const count = (key: string) => { const v = r[key]; if (!Number.isSafeInteger(v) || Number(v) < 0) fail(400, 'invalid_field', `${key} must be a count`); return Number(v); };
  let originalBundle: ImportReport['originalBundle'];
  if (r.originalBundle !== undefined) {
    const b = object(r.originalBundle); fields(b, ['size', 'sha256']);
    const sha256 = string(b, 'sha256', 64); if (!/^[a-f0-9]{64}$/.test(sha256)) fail(400, 'invalid_field', 'bad bundle digest');
    if (!Number.isSafeInteger(b.size) || Number(b.size) < 1) fail(400, 'invalid_field', 'bad bundle size');
    originalBundle = { size: Number(b.size), sha256 };
  }
  return { commit, branch, scan: validateScanReport(r.scan), rewritten: r.rewritten === true, movedFiles: count('movedFiles'), movedBytes: count('movedBytes'), lfsObjects: count('lfsObjects'), lfsBytes: count('lfsBytes'), ...(originalBundle ? { originalBundle } : {}) };
}

export class Imports {
  constructor(private readonly sql: SqlStorage) {}
  create(row: Omit<ImportRow, 'updated_at'>): void { this.sql.exec('INSERT INTO imports (id, source, org, created_by, threshold_bytes, link, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', row.id, row.source, row.org, row.created_by, row.threshold_bytes, row.link, row.state, row.created_at, row.created_at); }
  addRepo(importId: string, fullName: string, url: string, projectId: string, jobId: string, now: number): void { this.sql.exec("INSERT INTO import_repos (import_id, full_name, url, project_id, state, job_id, attempts, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, 1, ?)", importId, fullName, url, projectId, jobId, now); }
  get(id: string): ImportRow { return this.sql.exec<ImportRow>('SELECT * FROM imports WHERE id = ?', id).toArray()[0] ?? fail(404, 'not_found', 'Import not found'); }
  list(): ImportRow[] { return this.sql.exec<ImportRow>('SELECT * FROM imports ORDER BY created_at DESC LIMIT 20').toArray(); }
  rows(importId: string): ImportRepoRow[] { return this.sql.exec<ImportRepoRow>('SELECT * FROM import_repos WHERE import_id = ? ORDER BY full_name', importId).toArray(); }
  row(importId: string, fullName: string): ImportRepoRow { return this.sql.exec<ImportRepoRow>('SELECT * FROM import_repos WHERE import_id = ? AND full_name = ?', importId, fullName).toArray()[0] ?? fail(404, 'not_found', 'That repository is not part of this import'); }
  rowByJob(jobId: string): ImportRepoRow | undefined { return this.sql.exec<ImportRepoRow>('SELECT * FROM import_repos WHERE job_id = ?', jobId).toArray()[0]; }
  rowsByProject(projectId: string): ImportRepoRow[] { return this.sql.exec<ImportRepoRow>('SELECT * FROM import_repos WHERE project_id = ? ORDER BY updated_at DESC', projectId).toArray(); }
  unsettled(): ImportRepoRow[] { return this.sql.exec<ImportRepoRow>("SELECT * FROM import_repos WHERE state IN ('queued', 'running') ORDER BY updated_at").toArray(); }
  setRow(importId: string, fullName: string, patch: Partial<Pick<ImportRepoRow, 'state' | 'job_id' | 'message' | 'rewritten' | 'moved_files' | 'moved_bytes' | 'attempts' | 'next_attempt_at'>>, now: number): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    this.sql.exec(`UPDATE import_repos SET ${keys.map(k => `${k} = ?`).join(', ')}${keys.length ? ', ' : ''}updated_at = ? WHERE import_id = ? AND full_name = ?`, ...keys.map(k => patch[k] as string | number | null), now, importId, fullName);
    const open = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM import_repos WHERE import_id = ? AND state IN ('queued', 'running')", importId).one().n;
    this.sql.exec("UPDATE imports SET state = CASE WHEN ? = 0 AND state = 'running' THEN 'done' ELSE state END, updated_at = ? WHERE id = ?", open, now, importId);
  }
  finish(importId: string, state: ImportState, now: number): void { this.sql.exec('UPDATE imports SET state = ?, updated_at = ? WHERE id = ?', state, now, importId); }
  publicImport(importId: string, jobState: (jobId: string) => string | undefined) {
    const row = this.get(importId); const repos = this.rows(importId);
    const count = (state: ImportRepoState) => repos.filter(r => r.state === state).length;
    return { id: row.id, org: row.org, state: row.state, thresholdBytes: row.threshold_bytes, link: Boolean(row.link), createdAt: row.created_at, updatedAt: row.updated_at,
      summary: { total: repos.length, done: count('done'), machine: count('machine'), failed: count('failed'), running: repos.filter(r => r.state === 'running' || (r.state === 'queued' && r.job_id && jobState(r.job_id) === 'running')).length, queued: count('queued') },
      repos: repos.map(r => ({ fullName: r.full_name, url: r.url, projectId: r.project_id, state: r.state, jobId: r.job_id, jobState: r.job_id ? jobState(r.job_id) ?? null : null, message: r.message, rewritten: Boolean(r.rewritten), movedFiles: r.moved_files, movedBytes: r.moved_bytes, attempts: r.attempts })) };
  }
}
