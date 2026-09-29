import { describe, expect, it, vi } from 'vitest';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { evaluateReviewGenerationRecoveryLedger, validateReviewGenerationRecoveryEvidence } from '../../src/review/reviewGenerationRecovery';

const headSha = 'a'.repeat(40);
const runId = `run_${'b'.repeat(32)}`;
const request = { owner: 'calltelemetry', repo: 'ct-uat', headSha, runId,
  expectedGeneration: 2, expectedAppId: 4_385_771 };
const app = { id: request.expectedAppId, slug: 'ct-review-bot' };
const panelCoverage = 'Coverage: mode=panel; expected lanes=4; completed lanes=3; failed lanes=0; roster valid=false; quorum satisfied=false; full panel complete=false.';
const composedCoverage = 'Coverage: engine=composed; planned tasks=4; expected tasks=4; completed tasks=3; failed tasks=0; roster valid=false; quorum satisfied=false; task coverage complete=false.';
const summary = (coverage = panelCoverage) => `Verdict \`BLOCK\` at \`${headSha}\`.\n\nFindings: 0 (blocking P0/P1: 0; 0 raw persona finding(s) before clustering).\n\n${coverage}`;
const worker = (overrides: Record<string, unknown> = {}) => ({ id: 1_001, name: 'Review Yeti',
  head_sha: headSha, external_id: `${runId}:a1`, status: 'completed', conclusion: 'failure', app,
  completed_at: '2026-09-29T21:00:00Z', output: { title: 'Review Yeti: BLOCK', summary: summary() }, ...overrides });
const gate = (overrides: Record<string, unknown> = {}) => ({ id: 2_001, name: 'Review Yeti Gate',
  head_sha: headSha, external_id: `review-yeti-gate:v1:${'c'.repeat(64)}`, status: 'completed', conclusion: 'failure', app,
  completed_at: '2026-09-29T21:00:01Z', output: { title: 'Review Yeti Gate: Failed (incomplete panel)',
    summary: 'Review Yeti Gate failed: the panel expected 4 review lane(s) but 3 completed. This is an incomplete review, not a findings verdict; re-dispatch the review for this head.' }, ...overrides });

describe('legacy incomplete-review generation recovery', () => {
  it.each([panelCoverage, composedCoverage])('requires paired trusted evidence for %s', (coverage) => {
    const evidence = evaluateReviewGenerationRecoveryLedger(request, [worker({ output: { title: 'Review Yeti: BLOCK', summary: summary(coverage) } })], [gate()]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].title).toBe('Review Yeti: BLOCK');
    expect(validateReviewGenerationRecoveryEvidence(request, evidence)).toEqual(evidence);
  });

  it.each([
    ['findings', summary().replace('Findings: 0', 'Findings: 1')],
    ['wrong summary head', summary().replace(headSha, 'd'.repeat(40))],
    ['duplicate coverage', `${summary()}\n${panelCoverage}`],
    ['duplicate findings', `${summary()}\nFindings: 0 (blocking P0/P1: 0; 0 raw persona finding(s) before clustering).`],
    ['complete roster', summary().replace('completed lanes=3', 'completed lanes=4')],
    ['failed reviewer', summary().replace('failed lanes=0', 'failed lanes=1')],
    ['inconsistent composed plan', summary(composedCoverage.replace('planned tasks=4', 'planned tasks=5'))],
  ])('rejects %s', (_label, badSummary) => {
    expect(() => evaluateReviewGenerationRecoveryLedger(request,
      [worker({ output: { title: 'Review Yeti: BLOCK', summary: badSummary } })], [gate()])).toThrow(/generation recovery ledger/u);
  });

  it.each([
    ['missing gate', []],
    ['foreign App', [gate({ app: { id: 1, slug: 'attacker' } })]],
    ['wrong head', [gate({ head_sha: 'd'.repeat(40) })]],
    ['invalid identity', [gate({ external_id: 'unbound' })]],
    ['stale gate', [gate({ completed_at: '2026-09-29T20:59:59Z' })]],
    ['count mismatch', [gate({ output: { title: 'Review Yeti Gate: Failed (incomplete panel)', summary: 'Review Yeti Gate failed: the panel expected 5 review lane(s) but 3 completed. This is an incomplete review, not a findings verdict; re-dispatch the review for this head.' } })]],
    ['duplicate id', [gate(), gate()]],
    ['newer success', [gate(), gate({ id: 2_002, completed_at: '2026-09-29T21:00:02Z', conclusion: 'success' })]],
    ['same-second newer success', [gate(), gate({ id: 2_002, conclusion: 'success' })]],
    ['same-second newer success in reverse API order', [gate({ id: 2_002, conclusion: 'success' }), gate()]],
    ['newer active gate', [gate(), gate({ id: 2_002, status: 'in_progress', conclusion: null, completed_at: null })]],
  ])('rejects %s', (_label, gates) => {
    expect(() => evaluateReviewGenerationRecoveryLedger(request, [worker()], gates)).toThrow(/generation recovery ledger/u);
  });

  it('does not trust a bare BLOCK title in reconstructed evidence', () => {
    expect(() => validateReviewGenerationRecoveryEvidence(request, [{ generation: 1, checkId: 1_001,
      externalId: `${runId}:a1`, conclusion: 'failure', title: 'Review Yeti: BLOCK' }])).toThrow(/generation recovery ledger/u);
  });

  it('selects the higher-id failed Gate when completion timestamps tie', () => {
    const older = gate({ id: 2_000, conclusion: 'success' });
    for (const gates of [[older, gate()], [gate(), older]]) {
      expect(evaluateReviewGenerationRecoveryLedger(request, [worker()], gates)).toHaveLength(1);
    }
  });

  it('reads both bounded App-owned inventories without writing or relabeling checks', async () => {
    const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      const checkName = new URL(String(url)).searchParams.get('check_name');
      expect(new URL(String(url)).searchParams.get('app_id')).toBe(String(app.id));
      const checks = checkName === 'Review Yeti Gate' ? [gate()] : [worker()];
      return new Response(JSON.stringify({ total_count: checks.length, check_runs: checks }), { status: 200 });
    });
    const client = new GitHubInstallationClient({ token: 'ghs_test', fetchImplementation });
    const evidence = await client.readReviewGenerationRecovery(request);
    expect(evidence[0].title).toBe('Review Yeti: BLOCK');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
