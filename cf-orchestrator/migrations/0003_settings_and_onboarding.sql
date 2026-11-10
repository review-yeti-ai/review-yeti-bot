-- Migration 0003: Dynamic Organization and Repository Settings
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  installation_id INTEGER,
  app_id INTEGER DEFAULT 4385771,
  enabled INTEGER NOT NULL DEFAULT 1,
  passthrough_enabled INTEGER NOT NULL DEFAULT 1,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Extend repositories with GitHub identities and enrollment flags
ALTER TABLE repositories ADD COLUMN repository_id INTEGER;
ALTER TABLE repositories ADD COLUMN installation_id INTEGER;
ALTER TABLE repositories ADD COLUMN passthrough_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repositories ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_repositories_owner ON repositories(owner);
CREATE INDEX IF NOT EXISTS idx_repositories_repository_id ON repositories(repository_id);
CREATE INDEX IF NOT EXISTS idx_organizations_installation_id ON organizations(installation_id);
