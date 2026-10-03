-- Migration 0001: Initial Cloudflare D1 SQL Schema for Review Yeti
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  automation_enabled INTEGER NOT NULL DEFAULT 1,
  generate_flowchart INTEGER NOT NULL DEFAULT 1,
  custom_profile TEXT NOT NULL DEFAULT 'assertive',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  verdict TEXT NOT NULL DEFAULT 'PENDING',
  arbiter_verdict TEXT NOT NULL DEFAULT 'PENDING',
  status TEXT NOT NULL DEFAULT 'pending',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  spend_usd REAL NOT NULL DEFAULT 0.0,
  model TEXT NOT NULL DEFAULT 'reviewyeti-ai/yeti-pr-reviewer',
  quorum TEXT NOT NULL DEFAULT 'Swarm Consensus (100%)',
  raw_diff_tokens INTEGER DEFAULT 0,
  compacted_tokens INTEGER DEFAULT 0,
  compaction_ratio REAL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_reviews_repo_pr ON reviews(repo, pr_number);
CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews(created_at DESC);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  severity TEXT NOT NULL DEFAULT 'P1',
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  dismissed_reason TEXT,
  dismissed_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_findings_review ON findings(review_id);

CREATE TABLE IF NOT EXISTS review_tasks (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  paths_json TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PENDING',
  progress INTEGER NOT NULL DEFAULT 0,
  findings_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  last_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_review ON review_tasks(review_id);

CREATE TABLE IF NOT EXISTS hitl_overrides (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  original_verdict TEXT NOT NULL,
  override_verdict TEXT NOT NULL,
  reason TEXT NOT NULL,
  overridden_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_guidance (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  guidance_text TEXT NOT NULL,
  target_personas_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unconfigured',
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

-- Seed Initial Monitored Repositories
INSERT OR IGNORE INTO repositories (id, owner, repo, default_branch, automation_enabled, generate_flowchart, custom_profile, created_at, updated_at)
VALUES
  ('reviewyeti-ai/review-yeti-bot', 'reviewyeti-ai', 'review-yeti-bot', 'main', 1, 1, 'assertive', 1700000000000, 1700000000000),
  ('reviewyeti-ai/example-api', 'reviewyeti-ai', 'example-api', 'main', 1, 1, 'assertive', 1700000000000, 1700000000000),
  ('reviewyeti-ai/example-meta', 'reviewyeti-ai', 'example-meta', 'main', 1, 1, 'balanced', 1700000000000, 1700000000000);
