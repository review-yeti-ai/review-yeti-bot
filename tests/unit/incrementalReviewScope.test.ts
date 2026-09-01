import { describe, expect, it } from 'vitest';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const scope = require(path.join(root, '.github/workflows/pipelines/incremental-review-scope.js'));
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));

const BASE = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const PERSONAS = ['security', 'performance', 'architecture', 'testing', 'dependencies', 'licensing'];

function parentReport(planDigest: string) {
  return {
    schemaVersion: 'review-run-report-v1',
    repository: 'calltelemetry/example',
    prNumber: 17,
    baseSha: BASE,
    headSha: PARENT,
    verdict: 'FIX_FIRST',
    scope: { schemaVersion: 'review-scope-v1', planDigest },
    lanes: PERSONAS.map((personaId) => ({
      personaId,
      decision: personaId === 'dependencies' ? 'FINDINGS' : 'APPROVE',
      findings: personaId === 'dependencies'
        ? [{ severity: 'P1', path: 'scripts/quota.mjs', line: 12, title: 'Untrusted quota endpoint' }]
        : [],
      severity: personaId === 'dependencies' ? { P0: 0, P1: 1, P2: 0 } : { P0: 0, P1: 0, P2: 0 },
    })),
  };
}

describe('trusted incremental review scope', () => {
  it('binds evidence reuse to the action, base policy, persona order, and diff budget', () => {
    const common = { actionSha: 'd'.repeat(40), baseSha: BASE, personaIds: PERSONAS, maxDiffChars: 24000, maxIncrementalDiffChars: 60000, trustedWorkflow: 'calltelemetry/ct-review-actions/.github/workflows/review-yeti.yml@refs/tags/v1', trustedWorkflowSha: 'e'.repeat(40) };
    const digest = scope.buildReviewScopePlanDigest(common);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(scope.buildReviewScopePlanDigest(common)).toBe(digest);
    expect(scope.buildReviewScopePlanDigest({ ...common, personaIds: [...PERSONAS].reverse() })).not.toBe(digest);
    expect(scope.buildReviewScopePlanDigest({ ...common, actionSha: 'e'.repeat(40) })).not.toBe(digest);
    expect(scope.buildReviewScopePlanDigest({ ...common, baseSha: 'e'.repeat(40) })).not.toBe(digest);
    expect(scope.buildReviewScopePlanDigest({ ...common, maxDiffChars: 24001 })).not.toBe(digest);
    expect(scope.buildReviewScopePlanDigest({ ...common, maxIncrementalDiffChars: 60001 })).not.toBe(digest);
    expect(scope.buildReviewScopePlanDigest({ ...common, trustedWorkflow: 'calltelemetry/ct-review-actions/.github/workflows/review-yeti.yml@refs/heads/main' })).not.toBe(digest);
    expect(scope.buildReviewScopePlanDigest({ ...common, trustedWorkflowSha: 'f'.repeat(40) })).not.toBe(digest);
  });

  it('requires the trusted workflow path and its resolved immutable SHA', () => {
    const trustedPath = 'calltelemetry/ct-review-actions/.github/workflows/review-yeti.yml@refs/tags/v1';
    const trustedSha = 'd'.repeat(40);
    expect(scope.isTrustedWorkflowReference({ path: trustedPath, sha: trustedSha }, [trustedPath], trustedSha)).toBe(true);
    expect(scope.isTrustedWorkflowReference({
      path: 'calltelemetry/ct-review-actions/.github/workflows/review-yeti.yml@v1',
      ref: 'refs/tags/v1',
      sha: trustedSha,
    }, [trustedPath], trustedSha)).toBe(true);
    expect(scope.isTrustedWorkflowReference({
      path: 'calltelemetry/ct-review-actions/.github/workflows/review-yeti.yml@v1',
      ref: 'refs/heads/v1',
      sha: trustedSha,
    }, [trustedPath], trustedSha)).toBe(false);
    expect(scope.isTrustedWorkflowReference({ path: trustedPath, sha: 'e'.repeat(40) }, [trustedPath], trustedSha)).toBe(false);
    expect(scope.isTrustedWorkflowReference({ path: `${trustedPath}-other`, sha: trustedSha }, [trustedPath], trustedSha)).toBe(false);
    expect(scope.isTrustedWorkflowReference({ path: trustedPath, sha: 'not-a-sha' }, [trustedPath], trustedSha)).toBe(false);
  });

  it('fails closed to a full review when immutable workflow provenance is absent', async () => {
    const common = {
      enabled: true,
      token: 'token',
      repo: 'calltelemetry/example',
      prNumber: 17,
      baseSha: BASE,
      headSha: HEAD,
      personaIds: PERSONAS,
      trustedWorkflow: 'calltelemetry/ct-review-actions/.github/workflows/review-yeti.yml@refs/tags/v1',
      fullDiffText: 'full diff',
      planDigest: 'f'.repeat(64),
    };
    for (const trustedWorkflowSha of ['', 'not-a-sha']) {
      const result = await scope.resolveIncrementalReviewScope({ ...common, trustedWorkflowSha });
      expect(result.scope).toMatchObject({ mode: 'full', fallbackReason: 'missing_identity' });
      expect(result.reviewedDiffText).toBe('full diff');
    }
  });

  it('reruns the prior blocking owner, a broad reviewer, and delta-relevant specialists', () => {
    const planDigest = 'f'.repeat(64);
    const delta = pipeline.parseDiff([
      'diff --git a/scripts/quota.mjs b/scripts/quota.mjs',
      '--- a/scripts/quota.mjs',
      '+++ b/scripts/quota.mjs',
      '@@ -10,2 +10,3 @@',
      '-const endpoint = input.url;',
      '+const endpoint = new URL("/quota", trustedBaseUrl);',
      '+headers.Authorization = `Bearer ${apiKey}`;',
    ].join('\n'));

    expect(scope.selectIncrementalPersonaIds(parentReport(planDigest), delta, PERSONAS)).toEqual([
      'security',
      'architecture',
      'testing',
      'dependencies',
    ]);
  });

  it('rejects incomplete or plan-drifted parent reports', () => {
    const digest = 'f'.repeat(64);
    const expected = {
      repo: 'calltelemetry/example', prNumber: 17, baseSha: BASE, headSha: HEAD,
      planDigest: digest, personaIds: PERSONAS,
    };
    expect(scope.isCompleteTrustedReport(parentReport(digest), expected)).toBe(true);
    expect(scope.isCompleteTrustedReport(parentReport('0'.repeat(64)), expected)).toBe(false);
    expect(scope.isCompleteTrustedReport({ ...parentReport(digest), repository: 'other/example' }, expected)).toBe(false);
    expect(scope.isCompleteTrustedReport({ ...parentReport(digest), baseSha: 'e'.repeat(40) }, expected)).toBe(false);
    expect(scope.isCompleteTrustedReport({ ...parentReport(digest), headSha: HEAD }, expected)).toBe(false);
    expect(scope.isCompleteTrustedReport({ ...parentReport(digest), headSha: 'not-a-sha' }, expected)).toBe(false);
    const incomplete = parentReport(digest);
    incomplete.lanes[0].decision = 'ERROR';
    expect(scope.isCompleteTrustedReport(incomplete, expected)).toBe(false);
  });

  it('resolves a bounded ancestor delta and carries untouched lane evidence without model calls', async () => {
    const planDigest = 'f'.repeat(64);
    const report = parentReport(planDigest);
    const fullDiffText = `diff --git a/scripts/quota.mjs b/scripts/quota.mjs\n${' context\n'.repeat(1000)}`;
    const responses = [
      new Response(JSON.stringify({ artifacts: [{
        name: 'review-yeti-run-report-1-1', expired: false, created_at: '2026-08-31T00:00:00Z',
        archive_download_url: 'https://api.github.test/artifact.zip', workflow_run: { id: 1, head_sha: PARENT },
      }] }), { status: 200 }),
      new Response(JSON.stringify({
        status: 'completed', event: 'pull_request_target', head_sha: PARENT, run_attempt: 1,
        referenced_workflows: [{
          path: 'calltelemetry/ct-review-actions/.github/workflows/review-yeti.yml@v1',
          ref: 'refs/tags/v1',
          sha: 'd'.repeat(40),
        }],
      }), { status: 200 }),
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      new Response(JSON.stringify({
        status: 'ahead', ahead_by: 1, merge_base_commit: { sha: PARENT },
        files: [{
          filename: 'scripts/quota.mjs',
          patch: '@@ -10,2 +10,3 @@\n-const endpoint = input.url;\n+const endpoint = new URL("/quota", trustedBaseUrl);\n+headers.Authorization = `Bearer ${apiKey}`;',
        }],
      }), { status: 200 }),
      new Response([
        'diff --git a/scripts/quota.mjs b/scripts/quota.mjs',
        '--- a/scripts/quota.mjs',
        '+++ b/scripts/quota.mjs',
        '@@ -10,2 +10,3 @@',
        '-const endpoint = input.url;',
        '+const endpoint = new URL("/quota", trustedBaseUrl);',
        '+headers.Authorization = `Bearer ${apiKey}`;',
      ].join('\n'), { status: 200 }),
    ];

    const result = await scope.resolveIncrementalReviewScope({
      enabled: true,
      token: 'token',
      repo: 'calltelemetry/example',
      prNumber: 17,
      baseSha: BASE,
      headSha: HEAD,
      personaIds: PERSONAS,
      maxDiffChars: 24000,
      maxIncrementalDiffChars: 60000,
      trustedWorkflow: 'calltelemetry/ct-review-actions/.github/workflows/review-yeti.yml@refs/tags/v1',
      trustedWorkflowSha: 'd'.repeat(40),
      fullDiffText,
      planDigest,
      parseDiff: pipeline.parseDiff,
      apiBase: 'https://api.github.test',
      fetchImplementation: async () => responses.shift()!,
      extractReport: () => ({ report, raw: `${JSON.stringify(report)}\n` }),
    });

    expect(result.scope).toMatchObject({
      mode: 'delta',
      parentHeadSha: PARENT,
      reviewedPersonaIds: ['security', 'architecture', 'testing', 'dependencies'],
      reusedPersonaIds: ['performance', 'licensing'],
    });
    expect(result.reviewedDiffText.length).toBeLessThan(fullDiffText.length);

    const merged = scope.mergeIncrementalPersonaResults(
      PERSONAS.map((id) => ({ id, name: id })),
      result.scope.reviewedPersonaIds.map((personaId: string) => ({ personaId, decision: 'APPROVE', findings: [] })),
      report,
      result.scope.reviewedPersonaIds,
    );
    expect(merged).toHaveLength(PERSONAS.length);
    expect(merged.find((lane: any) => lane.personaId === 'performance')).toMatchObject({ reuseSource: 'parent', attemptCount: 0 });
    expect(merged.find((lane: any) => lane.personaId === 'dependencies')).toMatchObject({ reuseSource: 'live', findings: [] });
  });

  it('falls back to a full review when artifact access is unavailable', async () => {
    const result = await scope.resolveIncrementalReviewScope({
      enabled: false,
      fullDiffText: 'full diff',
      planDigest: 'f'.repeat(64),
    });
    expect(result.scope).toMatchObject({ mode: 'full', fallbackReason: 'disabled' });
    expect(result.reviewedDiffText).toBe('full diff');
  });

  it('rejects the 96-assignment fanout shape before dispatch', () => {
    expect(scope.assessReviewAssignmentBudget(16, 6, 24)).toEqual({
      planned: 96,
      maximum: 24,
      admitted: false,
    });
    expect(scope.assessReviewAssignmentBudget(1, 4, 24)).toMatchObject({ planned: 4, admitted: true });
  });
});
