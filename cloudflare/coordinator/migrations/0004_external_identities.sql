-- External sign-in identities (Google, GitHub) linked to Smith users, keyed by provider and the
-- provider's stable subject ID. Email is for display only and never used to match accounts.
CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), email TEXT, login TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (provider, subject));
CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id);
-- One-use OAuth attempts: the state's hash, PKCE verifier, OIDC nonce and, when linking, the signed-in user.
CREATE TABLE IF NOT EXISTS oauth_states (state_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL, link_user_id TEXT, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS oauth_states_expiry ON oauth_states(expires_at);
