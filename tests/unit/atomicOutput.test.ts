import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { writeAtomicOutput, exitCodeForReview } = require('../../src/cli/atomicOutput.js');

describe('atomic CLI output', () => {
  it('writes a same-directory receipt and replaces the target only after close', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-output-'));
    const target = path.join(directory, 'review.json');
    await writeAtomicOutput(target, '{"ok":true}\n', { fs: fs.promises, randomUUID: () => 'run-1' });
    expect(fs.readFileSync(target, 'utf8')).toBe('{"ok":true}\n');
    expect(fs.readdirSync(directory)).toEqual(['review.json']);
  });

  it('cleans up a cancelled temporary output', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-output-'));
    const target = path.join(directory, 'review.json');
    const controller = new AbortController();
    controller.abort();
    await expect(writeAtomicOutput(target, 'x', { fs: fs.promises, randomUUID: () => 'run-2', signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('maps terminal review states to stable nonzero exit codes', () => {
    expect(exitCodeForReview({ verdict: 'SHIP', coverage: { status: 'complete', mergeEligible: true } })).toBe(0);
    expect(exitCodeForReview({ verdict: 'FIX_FIRST', coverage: { status: 'complete', mergeEligible: false } })).toBe(3);
    expect(exitCodeForReview({ coverage: { status: 'INCOMPLETE_REVIEW', mergeEligible: false } })).toBe(2);
  });
});
