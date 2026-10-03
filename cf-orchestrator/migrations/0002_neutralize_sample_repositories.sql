-- Neutralize the sample repository rows seeded by 0001.
--
-- WHY THIS IS A NEW MIGRATION INSTEAD OF AN EDIT TO 0001 (REL-1299 / REL-1303 review)
--
-- 0001_initial_schema.sql has shipped. A D1 database that has already applied it
-- holds the original `reviewyeti-ai/example-api` / `reviewyeti-ai/example-meta`
-- rows, and D1 does not re-run an applied migration. Renaming the rows in place
-- inside 0001 therefore changes nothing for any live environment while the code
-- (dashboardRoutes.ts, d1Client.ts) starts querying the new names — the overview
-- then looks up a Durable Object that no longer matches the seeded repository and
-- renders zeroed state (`{ activeCount: 0, queueLength: 0 }`) rather than failing
-- loudly. Editing a shipped migration also makes migration history mutable, so a
-- future reader cannot trust that 0001 reflects what any environment ran.
--
-- 0001 is restored to its shipped content; this migration performs the rename.
-- Idempotent: keyed on the OLD ids, so re-running is a no-op.

-- Rename the seeded sample rows in place, preserving their ids' referents.
UPDATE repositories
SET id = 'example/sample-cdr', owner = 'example', repo = 'sample-cdr'
WHERE id = 'reviewyeti-ai/example-api';

UPDATE repositories
SET id = 'example/sample-meta', owner = 'example', repo = 'sample-meta'
WHERE id = 'reviewyeti-ai/example-meta';

-- A database that has never seen the old ids (a fresh one applying 0001 then
-- 0002) has nothing to update above, so insert the neutral rows if absent.
INSERT OR IGNORE INTO repositories (id, owner, repo, default_branch, automation_enabled, generate_flowchart, custom_profile, created_at, updated_at)
VALUES
  ('example/sample-cdr', 'example', 'sample-cdr', 'main', 1, 1, 'assertive', 1700000000000, 1700000000000),
  ('example/sample-meta', 'example', 'sample-meta', 'main', 1, 1, 'balanced', 1700000000000, 1700000000000);
