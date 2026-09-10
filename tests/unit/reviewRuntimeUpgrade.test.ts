import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('guarded runtime upgrade shell contract', () => {
  it('proves worker-key CAS, guarded restart and recovery with fake external binaries', () => {
    const output = execFileSync('bash', ['scripts/advance-review-worker.test.sh'], {
      cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 120_000,
    });
    expect(output).toMatch(/advance-review-worker focused tests: [1-9]\d* passed/);
  }, 125_000);

  it('proves image-only updates, provenance and receipt-bound recovery without cluster access', () => {
    const root = path.resolve(__dirname, '../..');
    const output = execFileSync('bash', ['scripts/advance-review-runtime.test.sh'], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
    });
    expect(output).toContain('advance-review-runtime focused tests: PASS');
    const provenance = execFileSync('bash', ['scripts/review-runtime-image-provenance.test.sh'], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
    });
    expect(provenance).toMatch(/^PASS: [1-9]\d* provenance checks \(fake crane only\)$/m);
  }, 65_000);
});
