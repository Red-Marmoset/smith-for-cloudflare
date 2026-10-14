// Repo-scoped Artifacts tokens the Worker uses to proxy git (spec §2): minted through ArtifactsClient outside any
// transaction, cached here, and handed out until shortly before they lapse. Machines and browsers never see one.
export const ARTIFACTS_TOKEN_SCHEMA = 'CREATE TABLE IF NOT EXISTS artifacts_tokens (project_id TEXT NOT NULL, scope TEXT NOT NULL, token_id TEXT NOT NULL, plaintext TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (project_id, scope))';
export const READ_CACHE_MS = 3600000;
export const WRITE_CACHE_MS = 600000;
export type TokenScope = 'read' | 'write';
type Row = { project_id: string; scope: TokenScope; token_id: string; plaintext: string; expires_at: number };

export class ArtifactsTokens {
  constructor(private readonly sql: SqlStorage) {}
  get(projectId: string, scope: TokenScope, now: number): { tokenId: string; plaintext: string; expiresAt: number } | undefined {
    const row = this.sql.exec<Row>('SELECT * FROM artifacts_tokens WHERE project_id = ? AND scope = ? AND expires_at > ?', projectId, scope, now).toArray()[0];
    return row ? { tokenId: row.token_id, plaintext: row.plaintext, expiresAt: row.expires_at } : undefined;
  }
  store(projectId: string, scope: TokenScope, tokenId: string, plaintext: string, expiresAt: number): void {
    this.sql.exec('INSERT INTO artifacts_tokens (project_id, scope, token_id, plaintext, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, scope) DO UPDATE SET token_id = excluded.token_id, plaintext = excluded.plaintext, expires_at = excluded.expires_at', projectId, scope, tokenId, plaintext, expiresAt);
  }
  drop(projectId: string, scope: TokenScope): { tokenId: string } | undefined {
    const row = this.sql.exec<Row>('SELECT * FROM artifacts_tokens WHERE project_id = ? AND scope = ?', projectId, scope).toArray()[0];
    if (row) this.sql.exec('DELETE FROM artifacts_tokens WHERE project_id = ? AND scope = ?', projectId, scope);
    return row ? { tokenId: row.token_id } : undefined;
  }
  forProject(projectId: string): { scope: TokenScope; tokenId: string }[] {
    return this.sql.exec<Row>('SELECT * FROM artifacts_tokens WHERE project_id = ?', projectId).toArray().map(r => ({ scope: r.scope, tokenId: r.token_id }));
  }
  expired(now: number): { projectId: string; scope: TokenScope; tokenId: string }[] {
    return this.sql.exec<Row>('SELECT * FROM artifacts_tokens WHERE expires_at <= ?', now).toArray().map(r => ({ projectId: r.project_id, scope: r.scope, tokenId: r.token_id }));
  }
}
