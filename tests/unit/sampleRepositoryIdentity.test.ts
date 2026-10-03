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

import { SAMPLE_REPO_CDR, SAMPLE_REPO_META } from '../../src/lib/sampleRepositories';

const root = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('sample repository identity is one contract, asserted across layers', () => {
  it('the app and orchestrator constants agree', () => {
    const orchestrator = read('cf-orchestrator/src/sampleRepositories.ts');
    expect(orchestrator).toContain(`SAMPLE_REPO_CDR = '${SAMPLE_REPO_CDR}'`);
    expect(orchestrator).toContain(`SAMPLE_REPO_META = '${SAMPLE_REPO_META}'`);
  });

  it('the D1 migration seeds exactly these identities', () => {
    // The seed cannot import the constant; this is the only thing binding it.
    const sql = read('cf-orchestrator/migrations/0001_initial_schema.sql');
    expect(sql).toContain(`'${SAMPLE_REPO_CDR}', 'example', 'sample-cdr'`);
    expect(sql).toContain(`'${SAMPLE_REPO_META}', 'example', 'sample-meta'`);
  });

  it('the Durable Object query layer imports the constant instead of repeating it', () => {
    // A raw literal here is the silent-drift failure mode: the DO name would no
    // longer match the seeded repository and the dashboard would render zeroed
    // state rather than failing loudly.
    const routes = read('cf-orchestrator/src/api/dashboardRoutes.ts');
    expect(routes).toContain("from '../sampleRepositories.js'");
    expect(routes).not.toContain(`'${SAMPLE_REPO_CDR}'`);
    expect(routes).not.toContain(`'${SAMPLE_REPO_META}'`);
  });

  it('the in-memory store fallback imports the constant instead of repeating it', () => {
    const client = read('cf-orchestrator/src/storage/d1Client.ts');
    expect(client).toContain("from '../sampleRepositories.js'");
    expect(client).not.toContain(`'${SAMPLE_REPO_CDR}'`);
    expect(client).not.toContain(`'${SAMPLE_REPO_META}'`);
  });

  it('the public UI imports the app constant instead of repeating it', () => {
    const ui = read('src/components/analytics/RepoMemoryPivotPlatform.tsx');
    expect(ui).toContain("from '@/lib/sampleRepositories'");
    expect(ui).not.toContain(`'${SAMPLE_REPO_CDR}'`);
    expect(ui).not.toContain(`'${SAMPLE_REPO_META}'`);
  });
});
