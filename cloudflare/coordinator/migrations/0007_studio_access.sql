-- Studio access: the Google Workspace domain a person proved at their last Google sign-in (oauth.ts),
-- and which workspaces admit that domain, with the role its members join as (members.ts).
ALTER TABLE users ADD COLUMN google_domain TEXT;
CREATE TABLE IF NOT EXISTS studio_workspaces (workspace_id TEXT PRIMARY KEY, role TEXT NOT NULL);
