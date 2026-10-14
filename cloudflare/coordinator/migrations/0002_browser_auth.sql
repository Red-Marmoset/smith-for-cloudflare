ALTER TABLE sessions ADD COLUMN csrf_token TEXT;
CREATE TABLE IF NOT EXISTS invites (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS invites_expiry ON invites(expires_at);
