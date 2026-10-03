import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareRuns,
  computeFingerprint,
  formatComparisonReport,
  formatMarkdownLedger,
  type ReviewRunReceipt,
  type Finding,
} from '../src/compareOrchestratorRuns.js';

describe('compareRuns Parity Assertion', () => {
  const baseDoksReceipt: ReviewRunReceipt = {
    orchestrator: 'doks',
    runId: 'doks_run_1',
    repo: 'review-yeti-ai/review-yeti-bot',
    prNumber: 99,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    verdict: 'success',
    findingFingerprints: ['fp_a', 'fp_b', 'fp_c'],
    durationMs: 42_000,
    tokensUsed: { promptTokens: 10000, completionTokens: 1000, totalTokens: 11000 },
    completedAt: new Date().toISOString(),
  };

  it('reports match=true when verdicts and finding fingerprints are identical', () => {
    const cfReceipt: ReviewRunReceipt = {
      ...baseDoksReceipt,
      orchestrator: 'cloudflare',
      runId: 'cf_run_1',
      durationMs: 35_000,
    };

    const result = compareRuns(baseDoksReceipt, cfReceipt);
    assert.equal(result.match, true);
    assert.equal(result.verdictMatch, true);
    assert.equal(result.findingFingerprintsMatch, true);
    assert.equal(result.findingCountDiff, 0);
    assert.deepEqual(result.doksOnly, []);
    assert.deepEqual(result.cfOnly, []);
  });

  it('reports match=false when verdicts diverge', () => {
    const cfReceipt: ReviewRunReceipt = {
      ...baseDoksReceipt,
      orchestrator: 'cloudflare',
      runId: 'cf_run_1',
      verdict: 'action_required',
    };

    const result = compareRuns(baseDoksReceipt, cfReceipt);
    assert.equal(result.match, false);
    assert.equal(result.verdictMatch, false);
    assert.ok(result.notes.some((n) => n.includes('Verdict mismatch')));
  });

  it('reports match=false when finding fingerprints diverge', () => {
    const cfReceipt: ReviewRunReceipt = {
      ...baseDoksReceipt,
      orchestrator: 'cloudflare',
      runId: 'cf_run_1',
      findingFingerprints: ['fp_a', 'fp_b', 'fp_different'],
    };

    const result = compareRuns(baseDoksReceipt, cfReceipt);
    assert.equal(result.match, false);
    assert.equal(result.findingFingerprintsMatch, false);
    assert.ok(result.notes.some((n) => n.includes('Finding fingerprint divergence')));
  });
});

describe('computeFingerprint', () => {
  it('returns trimmed string when input is a string', () => {
    assert.equal(computeFingerprint('  fp_trimmed_123  '), 'fp_trimmed_123');
    assert.equal(computeFingerprint('existing_hash'), 'existing_hash');
  });

  it('normalizes file path, line number, ruleId, and lowercases severity', () => {
    const finding: Finding = {
      ruleId: 'no-hardcoded-secret',
      file: './src\\auth\\jwt.ts',
      line: 42,
      severity: 'ERROR',
    };
    assert.equal(computeFingerprint(finding), 'src/auth/jwt.ts:42:no-hardcoded-secret:error');
  });

  it('defaults line to 1 and severity to warning when omitted', () => {
    const finding: Finding = {
      ruleId: 'missing-docstring',
      file: 'lib/util.ts',
    };
    assert.equal(computeFingerprint(finding), 'lib/util.ts:1:missing-docstring:warning');
  });

  it('handles empty file string without throwing', () => {
    const finding: Finding = {
      ruleId: 'global-scope-rule',
      file: '',
    };
    assert.equal(computeFingerprint(finding), ':1:global-scope-rule:warning');
  });
});

describe('Finding Fingerprint Symmetric Difference & Tracking', () => {
  const baseReceipt: ReviewRunReceipt = {
    orchestrator: 'doks',
    runId: 'run_1',
    repo: 'review-yeti-ai/review-yeti-bot',
    prNumber: 42,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    verdict: 'success',
    findingFingerprints: ['fp_1', 'fp_2', 'fp_3'],
    durationMs: 40000,
    completedAt: new Date().toISOString(),
  };

  it('populates doksOnly when DOKS has findings not found in CF', () => {
    const cfReceipt: ReviewRunReceipt = {
      ...baseReceipt,
      orchestrator: 'cloudflare',
      runId: 'run_2',
      findingFingerprints: ['fp_1', 'fp_2'],
    };

    const res = compareRuns(baseReceipt, cfReceipt);
    assert.equal(res.findingFingerprintsMatch, false);
    assert.deepEqual(res.doksOnly, ['fp_3']);
    assert.deepEqual(res.cfOnly, []);
    assert.equal(res.findingCountDiff, -1);
  });

  it('populates cfOnly when CF has findings not found in DOKS', () => {
    const cfReceipt: ReviewRunReceipt = {
      ...baseReceipt,
      orchestrator: 'cloudflare',
      runId: 'run_2',
      findingFingerprints: ['fp_1', 'fp_2', 'fp_3', 'fp_4'],
    };

    const res = compareRuns(baseReceipt, cfReceipt);
    assert.equal(res.findingFingerprintsMatch, false);
    assert.deepEqual(res.doksOnly, []);
    assert.deepEqual(res.cfOnly, ['fp_4']);
    assert.equal(res.findingCountDiff, 1);
  });

  it('populates both doksOnly and cfOnly on asymmetric divergent findings', () => {
    const doksReceipt: ReviewRunReceipt = {
      ...baseReceipt,
      findingFingerprints: ['fp_a', 'fp_b'],
    };
    const cfReceipt: ReviewRunReceipt = {
      ...baseReceipt,
      orchestrator: 'cloudflare',
      runId: 'run_2',
      findingFingerprints: ['fp_b', 'fp_c'],
    };

    const res = compareRuns(doksReceipt, cfReceipt);
    assert.equal(res.findingFingerprintsMatch, false);
    assert.deepEqual(res.doksOnly, ['fp_a']);
    assert.deepEqual(res.cfOnly, ['fp_c']);
    assert.equal(res.findingCountDiff, 0);
  });

  it('handles null/undefined findingFingerprints defensively', () => {
    const doksReceipt: ReviewRunReceipt = {
      ...baseReceipt,
      findingFingerprints: undefined as unknown as string[],
    };
    const cfReceipt: ReviewRunReceipt = {
      ...baseReceipt,
      orchestrator: 'cloudflare',
      runId: 'run_2',
      findingFingerprints: undefined as unknown as string[],
    };

    const res = compareRuns(doksReceipt, cfReceipt);
    assert.equal(res.findingFingerprintsMatch, true);
    assert.deepEqual(res.doksOnly, []);
    assert.deepEqual(res.cfOnly, []);
  });
});

describe('Token Usage Metrics & Warning Thresholds', () => {
  const baseReceipt: ReviewRunReceipt = {
    orchestrator: 'doks',
    runId: 'run_1',
    repo: 'review-yeti-ai/review-yeti-bot',
    prNumber: 42,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    verdict: 'success',
    findingFingerprints: [],
    durationMs: 40000,
    completedAt: new Date().toISOString(),
  };

  it('evaluates tokenWarning: false when delta is exactly 500', () => {
    const doks = {
      ...baseReceipt,
      tokensUsed: { promptTokens: 5000, completionTokens: 1000, totalTokens: 6000 },
    };
    const cf = {
      ...baseReceipt,
      orchestrator: 'cloudflare' as const,
      tokensUsed: { promptTokens: 5000, completionTokens: 1500, totalTokens: 6500 },
    };

    const res = compareRuns(doks, cf);
    assert.equal(res.tokenDelta, 500);
    assert.equal(res.tokenWarning, false);
    assert.equal(res.notes.some((n) => n.includes('Noticeable token difference')), false);
  });

  it('evaluates tokenWarning: true when delta is 501', () => {
    const doks = {
      ...baseReceipt,
      tokensUsed: { promptTokens: 5000, completionTokens: 1000, totalTokens: 6000 },
    };
    const cf = {
      ...baseReceipt,
      orchestrator: 'cloudflare' as const,
      tokensUsed: { promptTokens: 5000, completionTokens: 1501, totalTokens: 6501 },
    };

    const res = compareRuns(doks, cf);
    assert.equal(res.tokenDelta, 501);
    assert.equal(res.tokenWarning, true);
    assert.ok(res.notes.some((n) => n.includes('Noticeable token difference: DOKS=6000 vs CF=6501')));
  });

  it('evaluates tokenWarning: true when delta is negative and absolute delta > 500', () => {
    const doks = {
      ...baseReceipt,
      tokensUsed: { promptTokens: 5000, completionTokens: 1000, totalTokens: 6000 },
    };
    const cf = {
      ...baseReceipt,
      orchestrator: 'cloudflare' as const,
      tokensUsed: { promptTokens: 4000, completionTokens: 1000, totalTokens: 5000 },
    };

    const res = compareRuns(doks, cf);
    assert.equal(res.tokenDelta, -1000);
    assert.equal(res.tokenWarning, true);
  });

  it('evaluates tokenWarning: false when tokens are omitted', () => {
    const doks = { ...baseReceipt };
    const cf = { ...baseReceipt, orchestrator: 'cloudflare' as const };

    const res = compareRuns(doks, cf);
    assert.equal(res.tokenDelta, undefined);
    assert.equal(res.tokenWarning, false);
  });
});

describe('formatMarkdownLedger', () => {
  const doksReceipt: ReviewRunReceipt = {
    orchestrator: 'doks',
    runId: 'doks_run_100',
    repo: 'review-yeti-ai/review-yeti-bot',
    prNumber: 42,
    headSha: 'a1b2c3d4e5f60123456789abcdef0123456789ab',
    verdict: 'success',
    findingFingerprints: ['src/auth.ts:42:no-secrets:error', 'src/db.ts:10:index-needed:warning'],
    durationMs: 45000,
    tokensUsed: { promptTokens: 10000, completionTokens: 2000, totalTokens: 12000 },
    completedAt: '2026-09-30T14:00:00.000Z',
  };

  it('renders MATCH badge and 100% parity section when receipts match', () => {
    const cfReceipt: ReviewRunReceipt = {
      ...doksReceipt,
      orchestrator: 'cloudflare',
      runId: 'cf_run_100',
      durationMs: 38000,
      tokensUsed: { promptTokens: 10000, completionTokens: 1980, totalTokens: 11980 },
    };

    const result = compareRuns(doksReceipt, cfReceipt);
    const md = formatMarkdownLedger(result, doksReceipt, cfReceipt);

    assert.ok(md.includes('### Status: ✅ MATCH'));
    assert.ok(md.includes('review-yeti-ai/review-yeti-bot'));
    assert.ok(md.includes('#42'));
    assert.ok(md.includes('✅ **100% Finding Parity**'));
    assert.ok(md.includes('| **Wall Latency** |'));
    assert.ok(md.includes('| **Total Tokens** |'));
  });

  it('renders MISMATCH badge and discrepancy table when findings differ', () => {
    const cfReceipt: ReviewRunReceipt = {
      ...doksReceipt,
      orchestrator: 'cloudflare',
      runId: 'cf_run_100',
      verdict: 'action_required',
      findingFingerprints: ['src/db.ts:10:index-needed:warning', 'src/extra.ts:5:unexpected:info'],
    };

    const result = compareRuns(doksReceipt, cfReceipt);
    const md = formatMarkdownLedger(result, doksReceipt, cfReceipt);

    assert.ok(md.includes('### Status: ❌ MISMATCH'));
    assert.ok(md.includes('Finding Discrepancies Detected'));
    assert.ok(md.includes('DOKS Only'));
    assert.ok(md.includes('src/auth.ts:42:no-secrets:error'));
    assert.ok(md.includes('CF Only'));
    assert.ok(md.includes('src/extra.ts:5:unexpected:info'));
    assert.ok(md.includes('### 4. Diagnostic Notes & Warnings'));
  });

  it('handles optional doks and cf receipts gracefully', () => {
    const result = compareRuns(doksReceipt, {
      ...doksReceipt,
      orchestrator: 'cloudflare',
    });

    const md = formatMarkdownLedger(result);
    assert.ok(md.includes('### Status: ✅ MATCH'));
    assert.ok(md.includes('N/A'));
  });
});
