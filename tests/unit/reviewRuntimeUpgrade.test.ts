import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('guarded runtime upgrade shell contract', () => {
  it('proves image-only updates, provenance and receipt-bound recovery without cluster access', () => {
    const root = path.resolve(__dirname, '../..');
    const output = execFileSync('bash', ['scripts/advance-review-runtime.test.sh'], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
    });
    expect(output).toContain('advance-review-runtime focused tests: PASS');
    const provenance = execFileSync('bash', ['scripts/review-runtime-image-provenance.test.sh'], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
    });
    expect(provenance).toContain('PASS: 41 provenance checks (fake crane only)');
  }, 65_000);
});
