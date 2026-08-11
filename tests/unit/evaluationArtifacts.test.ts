import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEvaluationReceipt } from '../../src/evaluation/evaluationContracts.js';
import { listEvaluationReceipts, readEvaluationReceipt, renderEvaluationReport, writeEvaluationReceipt } from '../../src/evaluation/evaluationArtifacts.js';

function receipt() {
  return createEvaluationReceipt({
    request: { repository: 'review-yeti-ai/review-yeti-bot', sourceSha: 'a'.repeat(40), fixtureId: 'fixture', fixtureDigest: 'b'.repeat(64), mode: 'offline' },
    status: 'PASS',
    scenarioResults: [{ id: 'scenario', status: 'PASS' }],
  });
}

describe('evaluation artifacts', () => {
  it('writes and reads atomic JSON and Markdown receipts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-eval-artifacts-'));
    const paths = writeEvaluationReceipt(receipt(), { directory });
    expect(fs.existsSync(paths.jsonPath)).toBe(true);
    expect(fs.existsSync(paths.markdownPath)).toBe(true);
    expect(readEvaluationReceipt(paths.jsonPath).status).toBe('PASS');
    expect(fs.readFileSync(paths.markdownPath, 'utf8')).toContain('Review Yeti Evaluation');
  });

  it('lists valid receipts and ignores corrupt files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-eval-list-'));
    writeEvaluationReceipt(receipt(), { directory });
    fs.writeFileSync(path.join(directory, 'broken.json'), '{not-json');
    expect(listEvaluationReceipts(directory)).toHaveLength(1);
  });

  it('renders comparison failures without credentials or prose leakage', () => {
    const report = renderEvaluationReport({ status: 'BLOCKED', failures: ['unsafe_ship'], metrics: { candidateUnsafeShipRate: 1 } });
    expect(report).toContain('BLOCKED');
    expect(report).toContain('unsafe_ship');
    expect(report).not.toMatch(/sk-|bearer\s+/iu);
  });
});
