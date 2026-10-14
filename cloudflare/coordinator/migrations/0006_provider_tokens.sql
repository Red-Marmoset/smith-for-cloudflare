-- The access token a person's GitHub sign-in/link produced, kept so Smith can list and read
-- the repositories they can see (GitHub App installations) without anyone pasting a token.
-- refresh_token/expires_at are set when the GitHub App issues expiring user tokens.
CREATE TABLE IF NOT EXISTS provider_tokens (user_id TEXT NOT NULL REFERENCES users(id), provider TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT, expires_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, provider));
