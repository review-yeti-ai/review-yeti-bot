import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('REL-817 reaper acceptance entry point', () => {
  it('runs the isolated PostgreSQL harness serially and makes it a protected CI gate', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['test:acceptance:reaper']).toBe(
      'REVIEW_YETI_REAPER_ACCEPTANCE=1 vitest run '
        + 'tests/integration/reaperMetricsAcceptance.postgres.test.ts '
        + '--maxWorkers=1 --no-file-parallelism',
    );

    const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci-cd.yaml'), 'utf8');
    const fullSuite = workflow.indexOf('- name: Run Full Test Suite');
    const acceptance = workflow.indexOf('- name: Run REL-817 reaper acceptance harness');
    expect(fullSuite).toBeGreaterThan(-1);
    expect(acceptance).toBeGreaterThan(fullSuite);
    expect(workflow.slice(acceptance)).toContain('run: npm run test:acceptance:reaper');
  });
});
