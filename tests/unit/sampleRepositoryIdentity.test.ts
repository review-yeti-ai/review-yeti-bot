/**
 * Pins the sample repository identity across every layer that must agree.
 *
 * REL-1299 / REL-1303 review (P2: "repository identity is a magic string
 * duplicated across four layers that must stay in sync"). Defining the constant
 * once in each build removes the copy-paste, but the two builds cannot import
 * each other, and the D1 seed is SQL and cannot import TypeScript at all. So the
 * agreement has to be asserted somewhere, or it is a comment.
 *
 * This is that assertion. It reads the SOURCE FILES rather than importing them,
 * so it also covers the SQL migration, which no import could reach.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { SAMPLE_REPO_CDR, SAMPLE_REPO_CDR_SLUG, SAMPLE_REPO_META, SAMPLE_REPO_META_SLUG } from '../../src/lib/sampleRepositories';

const root = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('sample repository identity is one contract, asserted across layers', () => {
  it('the app and orchestrator constants agree', async () => {
    // Compare VALUES by importing the orchestrator module, not by matching its
    // declaration text. Text matching failed on benign refactors (a type
    // annotation, double quotes, reformatting) while the contract still held.
    const orchestrator = await import('../../cf-orchestrator/src/sampleRepositories.js');
    expect(orchestrator.SAMPLE_REPO_CDR).toBe(SAMPLE_REPO_CDR);
    expect(orchestrator.SAMPLE_REPO_META).toBe(SAMPLE_REPO_META);
  });

  it('0001 is left as shipped: it must not carry the neutralized identities', () => {
    // 0001 has shipped and D1 does not re-run an applied migration, so renaming
    // rows inside it changes nothing for a live database while the code starts
    // querying the new names -- the overview then looks up a Durable Object that
    // no longer matches the seed and renders zeroed state. Editing it also makes
    // migration history mutable. The rename belongs in a forward migration.
    const shipped = read('cf-orchestrator/migrations/0001_initial_schema.sql');
    expect(shipped).not.toContain(SAMPLE_REPO_CDR);
    expect(shipped).not.toContain(SAMPLE_REPO_META);
    // It should still carry the ORIGINAL sample ids it was shipped with.
    expect(shipped).toContain('reviewyeti-ai/example-api');
    expect(shipped).toContain('reviewyeti-ai/example-meta');
  });

  it('the migrations actually rename the shipped sample rows when executed', () => {
    // Review Yeti: the forward migration is the SOLE place a live database picks
    // up the rename, and text-matching cannot tell whether it executes. A typo'd
    // table name (`UPDATE repositorie ...`) or a commented-out statement still
    // satisfies a regex over the file. So execute the SQL for real.
    //
    // `node:sqlite` ships with Node 24 (the CI toolchain), and D1 is SQLite, so
    // this runs the actual migration text against an in-memory database.
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const applyMigration = (db: any, file: string) => {
      const sql = read(`cf-orchestrator/migrations/${file}`);
      // Split on statement boundaries; node:sqlite's exec handles multi-statement
      // input, so pass it through rather than hand-splitting (a naive ';' split
      // would break on the inline comments the migration carries).
      db.exec(sql);
    };
    const createTable = `
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
      );`;

    // Path 1: a database that already applied the SHIPPED 0001, then gets 0002.
    const upgraded = new DatabaseSync(':memory:');
    upgraded.exec(createTable);
    upgraded.exec(`INSERT OR IGNORE INTO repositories (id, owner, repo, default_branch, automation_enabled, generate_flowchart, custom_profile, created_at, updated_at)
      VALUES ('reviewyeti-ai/example-api','reviewyeti-ai','example-api','main',1,1,'assertive',1,1),
             ('reviewyeti-ai/example-meta','reviewyeti-ai','example-meta','main',1,1,'balanced',1,1);`);
    applyMigration(upgraded, '0002_neutralize_sample_repositories.sql');
    const upgradedIds = (upgraded.prepare('SELECT id FROM repositories ORDER BY id').all() as any[]).map((r) => r.id);
    expect(upgradedIds).toContain(SAMPLE_REPO_CDR);
    expect(upgradedIds).toContain(SAMPLE_REPO_META);
    // The old rows must be gone, not merely joined by new ones -- a leftover old
    // row is exactly what makes the overview query a DO that does not match.
    expect(upgradedIds).not.toContain('reviewyeti-ai/example-api');
    expect(upgradedIds).not.toContain('reviewyeti-ai/example-meta');

    // Path 2: idempotence -- re-applying must not duplicate or fail.
    applyMigration(upgraded, '0002_neutralize_sample_repositories.sql');
    expect((upgraded.prepare('SELECT count(*) c FROM repositories').get() as any).c).toBe(2);

    // Path 3: a database with NEITHER the old nor the new rows -- the only state
    // that actually exercises the migration's `INSERT OR IGNORE`. Every earlier
    // path pre-seeds the OLD ids, so the UPDATEs satisfy the rename and the
    // INSERT is a no-op there. This path is what proves the create-from-scratch
    // branch works; without it that statement was never executed.
    const empty = new DatabaseSync(':memory:');
    empty.exec(createTable);
    applyMigration(empty, '0002_neutralize_sample_repositories.sql');
    const emptyIds = (empty.prepare('SELECT id FROM repositories ORDER BY id').all() as any[]).map((r) => r.id);
    expect(emptyIds).toEqual([SAMPLE_REPO_CDR, SAMPLE_REPO_META].sort());

    // Path 4: a fresh database applying the shipped 0001 seed then 0002 converges
    // to the same state as Path 1 (the upgrade path a live environment takes).
    const fresh = new DatabaseSync(':memory:');
    fresh.exec(createTable);
    fresh.exec(`INSERT OR IGNORE INTO repositories (id, owner, repo, default_branch, automation_enabled, generate_flowchart, custom_profile, created_at, updated_at)
      VALUES ('reviewyeti-ai/example-api','reviewyeti-ai','example-api','main',1,1,'assertive',1,1),
             ('reviewyeti-ai/example-meta','reviewyeti-ai','example-meta','main',1,1,'balanced',1,1);`);
    applyMigration(fresh, '0002_neutralize_sample_repositories.sql');
    expect((fresh.prepare('SELECT id FROM repositories ORDER BY id').all() as any[]).map((r) => r.id))
      .toEqual(emptyIds);

    empty.close();
    fresh.close();
    upgraded.close();
  });

  it('the Durable Object query layer imports the constant instead of repeating it', () => {
    // A raw literal here is the silent-drift failure mode: the DO name would no
    // longer match the seeded repository and the dashboard would render zeroed
    // state rather than failing loudly.
    const routes = read('cf-orchestrator/src/api/dashboardRoutes.ts');
    expect(routes).not.toContain(SAMPLE_REPO_CDR);
    expect(routes).not.toContain(SAMPLE_REPO_META);
  });

  it('the in-memory store fallback imports the constant instead of repeating it', () => {
    const client = read('cf-orchestrator/src/storage/d1Client.ts');
    expect(client).not.toContain(SAMPLE_REPO_CDR);
    expect(client).not.toContain(SAMPLE_REPO_META);
  });

  it('the memory page imports the app constant for both label and option value', () => {
    // Review Yeti caught the first cut of this PR leaving this file unguarded: it
    // spelled the label AND the dropdown's option value as raw literals. The
    // option value is load-bearing -- the page filters with
    // `repository.toLowerCase().includes(selectedRepo)` -- so a rename that
    // updated the constant but not this file would leave the dropdown filtering
    // to nothing, silently.
    const page = read('src/app/memory/page.tsx');
    // Assert the slugs are used as the option VALUE, not merely imported: a bare
    // toMatch(/SAMPLE_REPO_CDR_SLUG/) is satisfied by the import line alone, so
    // reverting the option to value="sample-cdr" would pass while reintroducing
    // the drift.
    // The load-bearing property is that the option value is DERIVED from the
    // identity constant, not the spelling of the JSX. Dropped the
    // `value={SLUG}` literal assertions: they forbade a SAMPLE_REPOS.map()
    // render even though that keeps the contract intact, which is the exact
    // refactor the previous comment claimed was safe. The guards below carry the
    // real coverage -- a raw slug literal fails them, and a hardcoded value not
    // derived from the constant cannot pass the identity check in the same file.
    expect(page).toMatch(/SAMPLE_REPO_(CDR|META)_SLUG/);
    expect(page).not.toMatch(new RegExp(`['"\`]${SAMPLE_REPO_CDR_SLUG}['"\`]`));
    expect(page).not.toMatch(new RegExp(`['"\`]${SAMPLE_REPO_META_SLUG}['"\`]`));
    // Plain `toContain`, not a quote-wrapped regex: the first cut of this guard
    // required a surrounding quote character and therefore MISSED a raw literal
    // sitting in JSX text (`>example/sample-cdr<`), which is exactly the drift it
    // exists to catch. The identity must not appear in the file in ANY form.
    expect(page).not.toContain(SAMPLE_REPO_CDR);
    expect(page).not.toContain(SAMPLE_REPO_META);
    // The slugs themselves must still match the identities they are derived from.
    expect(SAMPLE_REPO_CDR.endsWith(SAMPLE_REPO_CDR_SLUG)).toBe(true);
    expect(SAMPLE_REPO_META.endsWith(SAMPLE_REPO_META_SLUG)).toBe(true);
  });

  it('the public UI imports the app constant instead of repeating it', () => {
    const ui = read('src/components/analytics/RepoMemoryPivotPlatform.tsx');
    expect(ui).not.toContain(SAMPLE_REPO_CDR);
    expect(ui).not.toContain(SAMPLE_REPO_META);
    // The component KEYS ON THE SLUG, not the full identity, and the memory page
    // submits the slug as its option value -- so the two layers must agree on the
    // slug. Guarding only the full identity let a raw 'sample-cdr' literal in the
    // chart conditions survive a rename of the identity, silently rendering an
    // empty matrix because the page submitted the new slug.
    expect(ui).not.toMatch(new RegExp(`['"\`]${SAMPLE_REPO_CDR_SLUG}['"\`]`));
    expect(ui).not.toMatch(new RegExp(`['"\`]${SAMPLE_REPO_META_SLUG}['"\`]`));
  });
});
