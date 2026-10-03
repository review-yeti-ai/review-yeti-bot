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

  it('the D1 migration seeds exactly these identities', () => {
    // The seed cannot import the constant; this is the only thing binding it.
    const sql = read('cf-orchestrator/migrations/0001_initial_schema.sql');
    // Whitespace-tolerant: a benign reformat of the INSERT (extra spacing, line
    // wrap between columns) must not fail a contract that still holds.
    expect(sql).toMatch(new RegExp(`'${SAMPLE_REPO_CDR}'\\s*,\\s*'example'\\s*,\\s*'sample-cdr'`));
    expect(sql).toMatch(new RegExp(`'${SAMPLE_REPO_META}'\\s*,\\s*'example'\\s*,\\s*'sample-meta'`));
  });

  it('the Durable Object query layer imports the constant instead of repeating it', () => {
    // A raw literal here is the silent-drift failure mode: the DO name would no
    // longer match the seeded repository and the dashboard would render zeroed
    // state rather than failing loudly.
    const routes = read('cf-orchestrator/src/api/dashboardRoutes.ts');
    expect(routes).toContain("from '../sampleRepositories.js'");
    expect(routes).not.toContain(SAMPLE_REPO_CDR);
    expect(routes).not.toContain(SAMPLE_REPO_META);
  });

  it('the in-memory store fallback imports the constant instead of repeating it', () => {
    const client = read('cf-orchestrator/src/storage/d1Client.ts');
    expect(client).toContain("from '../sampleRepositories.js'");
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
    expect(page).toContain("from '@/lib/sampleRepositories'");
    // Assert the slugs are used as the option VALUE, not merely imported: a bare
    // toMatch(/SAMPLE_REPO_CDR_SLUG/) is satisfied by the import line alone, so
    // reverting the option to value="sample-cdr" would pass while reintroducing
    // the drift.
    expect(page).toMatch(/<option value=\{SAMPLE_REPO_CDR_SLUG\}>/);
    expect(page).toMatch(/<option value=\{SAMPLE_REPO_META_SLUG\}>/);
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
    expect(ui).toContain("from '@/lib/sampleRepositories'");
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
