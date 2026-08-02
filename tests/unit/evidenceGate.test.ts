import { describe, expect, it } from 'vitest';
import { EvidenceGate, createEvidenceReceipt, receiptId } from '../../src/review/evidence';
import { runEvidence } from '../../src/review/evidenceRunner';
import { TokenBudgetManager } from '../../src/pipeline/tokenBudgetManager';

const sha = 'a'.repeat(40);
const receipt = createEvidenceReceipt({ tool: 'typecheck', version: '1', operation: 'npm test', snapshotSha: sha, exitStatus: 0, durationMs: 2, interpretation: 'passed', output: 'ok' });

describe('evidence gate', () => {
  it('does not allow an unvalidated high-severity finding to ship', () => {
    const result = new EvidenceGate().evaluate({ snapshotSha: sha, receipts: [receipt], requiredLaneIds: ['security'], completedLaneIds: ['security'], findings: [{ severity: 'P1', path: 'src/a.ts', line: 2, title: 'bug', commitSha: sha }] });
    expect(result.status).toBe('INCOMPLETE');
    expect(result.reasons.join(' ')).toMatch(/evidence reference|validated/i);
  });

  it('fails on a deterministic tool failure and passes with bound evidence', () => {
    const failed = new EvidenceGate().evaluate({ snapshotSha: sha, receipts: [{ ...receipt, exitStatus: 1 }], findings: [] });
    expect(failed.status).toBe('FAIL');
    const passed = new EvidenceGate().evaluate({ snapshotSha: sha, receipts: [receipt], findings: [{ severity: 'P1', path: 'src/a.ts', line: 2, title: 'bug', commitSha: sha, evidenceRefs: [receiptId(receipt)], validationStatus: 'validated' }] });
    expect(passed.status).toBe('PASS');
  });

  it('uses an injectable command runner and records a stable output digest', async () => {
    const result = await runEvidence({ tool: 'lint', version: '1', operation: 'lint', snapshotSha: sha, command: 'lint', runCommand: async () => ({ exitStatus: 0, stdout: 'ok' }) });
    expect(result.exitStatus).toBe(0);
    expect(result.outputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reserves tokens atomically and fails closed on exhaustion', () => {
    const budgets = new TokenBudgetManager();
    expect(budgets.reserve('run', 8, 10)).toBe(true);
    expect(budgets.reserve('run', 3, 10)).toBe(false);
    budgets.release('run', 2);
    expect(budgets.reserved('run')).toBe(6);
  });
});
