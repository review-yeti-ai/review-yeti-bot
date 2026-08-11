import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const { evaluateBoundedReviewMatrix } = await import('../../scripts/evaluate-bounded-review-engine.mjs');

describe('bounded review evaluation matrix', () => {
  it('contains the required offline safety corpus', () => {
    const matrix = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/bounded-review-engine/evaluation-matrix.json'), 'utf8'));
    expect(evaluateBoundedReviewMatrix(matrix)).toMatchObject({ status: 'pass', deterministic: true, failures: [] });
  });

  it('rejects unsafe or malformed receipts', () => {
    const matrix = { schemaVersion: 'bounded-review-eval-v1', cases: [] };
    expect(evaluateBoundedReviewMatrix(matrix, { schemaVersion: 'review-investigation-summary-v1', complete: true, unsafeShips: 1 })).toMatchObject({ status: 'fail' });
  });
});
