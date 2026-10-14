import { fail, fields, json, string } from './http';

// Personal access tokens let a person's own coding agent (Claude Code, Codex, ...) act in one
// workspace as that person, limited to the scopes they chose. They never carry anyone's AI-provider
// login. Only a hash is stored; the token is shown once. Workspace membership and role are
// re-checked on every use, so removing a member disables their tokens immediately.
//
// A run token is the other kind: minted by the coordinator when a crew run starts, bound to that run's
// session, never listed or counted among a person's tokens, and refused as soon as the session has no
// running turn, so an unattended Claude Code process can only act as its run for as long as the run lasts.
export const TOKEN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS access_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
  CREATE INDEX IF NOT EXISTS access_tokens_user ON access_tokens(user_id);
`;
export const TOKEN_SCOPES = ['read', 'build', 'crew'] as const;
export type TokenScope = typeof TOKEN_SCOPES[number];
// What each scope may do. Nothing here enrolls machines, changes members, edits projects, reads chats,
// or ships anything: promotion and handoff stay human actions in the dashboard. `crew` is held only by
// run tokens: it reads like `read` and adds the crew's own tools, never enqueue or cancel.
// git-read is a clone or fetch of a Smith-hosted repository, git-write a push to one (the token is the git
// password). The build scope carries push, by the owner's decision; a crew run token never does git at all.
// lfs-read downloads large files (Git LFS) of any project, lfs-write uploads them; like git, upload rides on the build scope.
const SCOPE_ACTIONS: Record<TokenScope, string[]> = {
  read: ['summary', 'projects', 'nodes', 'list', 'get', 'read-logs', 'git-read', 'git-advertise', 'git-ls-refs', 'git-clone-info', 'lfs-read'],
  build: ['enqueue', 'cancel', 'git-write', 'lfs-write'],
  crew: ['summary', 'projects', 'nodes', 'list', 'get', 'read-logs', 'crew-tool-report', 'crew-tool-remember', 'crew-tool-inbox', 'crew-tool-send', 'crew-tool-list', 'crew-tool-create-project', 'crew-tool-request-review'],
};
// The scopes a person may put on a token they create; `crew` is minted only for runs.
const HUMAN_SCOPES: readonly TokenScope[] = ['read', 'build'];
const TOKEN_PATTERN = /^smith_(pat|run)_([a-f0-9]{64})_([A-Za-z0-9-]{32,128})$/;
const DAY_MS = 86400000;
// "Until revoked": a git credential lives as long as the clone that uses it. Far enough away to never expire in practice.
export const NEVER_EXPIRES = 4102444800000;   // 2100-01-01
type TokenRow = { id: string; user_id: string; name: string; token_hash: string; scopes: string; created_at: number; expires_at: number; last_used_at: number | null; revoked_at: number | null; session_id: string | null };

export function tokenWorkspace(token: string): string | null { return TOKEN_PATTERN.exec(token)?.[2] ?? null; }
export function isRunToken(token: string): boolean { return TOKEN_PATTERN.exec(token)?.[1] === 'run'; }
export function newToken(workspaceId: string): string { return `smith_pat_${workspaceId}_${crypto.randomUUID()}${crypto.randomUUID()}`; }
export function newRunToken(workspaceId: string): string { return `smith_run_${workspaceId}_${crypto.randomUUID()}${crypto.randomUUID()}`; }

export class Tokens {
  constructor(private sql: SqlStorage) {}

  // Resolves a token for one action, returning the person it acts for. Callers still apply that
  // person's workspace role, so a token can never do more than its owner could. A run token also needs
  // its session to have a running turn: the moment the run ends, so does the token.
  resolve(tokenHash: string, action: string, now: number): { userId: string; needsWrite: boolean; scopes: TokenScope[]; sessionId: string | null } {
    const row = this.sql.exec<TokenRow>('SELECT * FROM access_tokens WHERE token_hash = ?', tokenHash).toArray()[0];
    if (!row || row.revoked_at !== null || row.expires_at <= now) fail(401, 'invalid_token', 'Smith token invalid, expired or revoked; create a new one in the dashboard');
    if (row.session_id && !this.sql.exec("SELECT 1 FROM ai_turns WHERE session_id = ? AND state = 'running' AND stop_requested=0 AND lease_expires_at>?", row.session_id, now).toArray().length) fail(401, 'run_over', 'This run has ended or its lease expired; its token no longer works');
    const scopes = JSON.parse(row.scopes) as TokenScope[];
    if (!scopes.some(scope => SCOPE_ACTIONS[scope].includes(action))) fail(403, 'scope', 'This Smith token does not allow that; create one with the build scope to start or cancel builds');
    if (row.last_used_at === null || now - row.last_used_at > 60000) this.sql.exec('UPDATE access_tokens SET last_used_at = ? WHERE id = ?', now, row.id);
    return { userId: row.user_id, needsWrite: SCOPE_ACTIONS.build.includes(action), scopes, sessionId: row.session_id ?? null };
  }

  // The coordinator mints a run's token at claim; `userId` is the person the run acts as. Never listed or
  // counted as one of that person's own tokens.
  insertRunToken(sessionId: string, userId: string, hash: string, expiresAt: number, now: number): string {
    const id = crypto.randomUUID();
    this.sql.exec('INSERT INTO access_tokens (id, user_id, name, token_hash, scopes, created_at, expires_at, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, userId, 'crew run', hash, JSON.stringify(['crew']), now, expiresAt, sessionId);
    return id;
  }

  // A finished, stopped or lost run takes its tokens with it, whatever their expiry says.
  revokeSession(sessionId: string, now: number): void {
    this.sql.exec('UPDATE access_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL', now, sessionId);
  }

  // Human actions on the caller's own tokens. `canBuild` is whether their role may start builds.
  execute(userId: string, canBuild: boolean, action: string, body: Record<string, unknown>, now: number, created: { token: string; hash: string }): Response {
    if (action === 'tokens') {
      fields(body, []);
      const rows = this.sql.exec<TokenRow>('SELECT * FROM access_tokens WHERE user_id = ? AND session_id IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC', userId, now).toArray();
      return json({ tokens: rows.map(row => this.publicToken(row)) });
    }
    if (action === 'token-create') {
      fields(body, ['name', 'scopes', 'expiresInDays']);
      const name = string(body, 'name', 64).trim();
      if (!name || /[\x00-\x1f]/.test(name)) fail(400, 'invalid_field', 'Give the token a short name, such as the computer or tool it is for');
      const scopes = body.scopes;
      if (!Array.isArray(scopes) || !scopes.includes('read') || scopes.some(s => !HUMAN_SCOPES.includes(s as TokenScope)) || new Set(scopes).size !== scopes.length) fail(400, 'invalid_field', 'Scopes must include read, and may add build');
      if (scopes.includes('build') && !canBuild) fail(403, 'forbidden', 'Your workspace role cannot start builds, so it cannot grant the build scope');
      // null: a git credential that lasts until revoked (a clone remote lives for years).
      const days = body.expiresInDays === undefined ? 30 : body.expiresInDays;
      if (days !== null && ![7, 30, 90].includes(days as number)) fail(400, 'invalid_field', 'Tokens expire after 7, 30 or 90 days, or never (null)');
      if (this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM access_tokens WHERE user_id = ? AND session_id IS NULL AND revoked_at IS NULL AND expires_at > ?', userId, now).one().count >= 10) fail(429, 'quota', 'You can have at most ten active tokens; revoke one first');
      const id = crypto.randomUUID();
      this.sql.exec('INSERT INTO access_tokens (id, user_id, name, token_hash, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, userId, name, created.hash, JSON.stringify(scopes), now, days === null ? NEVER_EXPIRES : now + (days as number) * DAY_MS);
      return json({ ...this.publicToken(this.sql.exec<TokenRow>('SELECT * FROM access_tokens WHERE id = ?', id).one()), token: created.token }, 201);
    }
    if (action === 'token-revoke') {
      fields(body, ['tokenId']);
      const id = string(body, 'tokenId', 64);
      // Only the token's owner may revoke it here; it reports the same result whether or not it existed.
      this.sql.exec('UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', now, id, userId);
      return json({ revoked: true });
    }
    fail(404, 'not_found', 'Route not found');
  }

  private publicToken(row: TokenRow) {
    return { id: row.id, name: row.name, scopes: JSON.parse(row.scopes) as TokenScope[], createdAt: row.created_at, expiresAt: row.expires_at, neverExpires: row.expires_at >= NEVER_EXPIRES, lastUsedAt: row.last_used_at };
  }
}
