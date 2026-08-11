import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('evaluation documentation examples', () => {
  it('keeps the documented manual commands and no-CI policy visible', () => {
    const docs = fs.readFileSync(path.join(process.cwd(), 'docs/EVALUATION_CLI.md'), 'utf8');
    expect(docs).toContain('npx review-yeti eval run');
    expect(docs).toContain('--mode live --repetitions 3 --concurrency 4 --yes');
    expect(docs).toContain('add a GitHub Actions trigger');
  });
});
