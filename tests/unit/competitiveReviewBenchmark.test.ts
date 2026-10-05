import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as benchmark from '../../scripts/competitive-review-benchmark.mjs';

const manifest = {
  schemaVersion: 'review-yeti-competitive-benchmark-manifest-v1',
  datasetSha256: benchmark.AACR_BENCHMARK.sha256,
  cases: [{ id: 'aacr-js-7', repository: 'example/repo', prNumber: 7, language: 'JavaScript' }],
};

function referenceRows() {
  const rows = [];
  for (const label of [1, 0]) {
    for (const context of ['Diff Level', 'File Level', 'Repo Level']) {
      rows.push({
        label,
        note: label ? 'A concrete claim about a changed path.' : 'This claim does not describe a defect.',
        path: 'src/app.js',
        side: 'RIGHT',
        from_line: 12,
        to_line: 13,
        context,
        category: 'logic',
        pr_url: 'https://github.com/example/repo/pull/7',
        pr_source_commit: 'a'.repeat(40),
        pr_target_commit: 'b'.repeat(40),
      });
    }
  }
  return rows;
}

describe('competitive review benchmark input boundaries', () => {
  it('hashes the exact prepared input bytes consumed by a run', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-prepared-input-'));
    try {
      const inputPath = path.join(directory, 'cases.json');
      const bytes = Buffer.from('{"datasetSha256":"pinned"}\n');
      fs.writeFileSync(inputPath, bytes);

      const prepared = benchmark.readPreparedInput(inputPath);
      expect(prepared.value).toEqual({ datasetSha256: 'pinned' });
      expect(prepared.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
      expect(prepared.sha256).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates an opaque, context-stratified verification panel without labels in reviewer input', () => {
    const cases = benchmark.buildVerificationCases(referenceRows(), manifest);
    expect(cases).toHaveLength(6);
    expect(cases.map((entry: any) => entry.context).sort()).toEqual([
      'Diff Level', 'Diff Level', 'File Level', 'File Level', 'Repo Level', 'Repo Level',
    ]);
    for (const testCase of cases) {
      const input = benchmark.toVerifierInput(testCase);
      expect(input.caseId).toMatch(/^aacr-v1-[a-f0-9]{20}$/u);
      expect(input.caseId).not.toMatch(/correct|incorrect|positive|negative/iu);
      expect(JSON.stringify(input)).not.toMatch(/expectedLabel|aacr-comment-/u);
      expect(input.finding.body).toBe(testCase.reference.note);
    }
  });

  it('separates verification from discovery and leaves unmatched discovery findings unjudged', () => {
    const rows = referenceRows();
    const result = benchmark.scoreDiscoveryCases([{
      ...rows[0],
      findings: [{ id: 'finding-1', path: 'src/app.js', line: 12 }],
    }], manifest);
    expect(result.referenceAnchorRecall).toBe(1);
    expect(result.precision).toBeNull();
    expect(result.adjudicatedSubsetPrecision).toBeNull();
    expect(result.unjudgedGeneratedFindingCount).toBe(1);
    expect(result.qualified).toBe(false);

    const partiallyAdjudicated = benchmark.scoreDiscoveryCases([{
      ...rows[0],
      findings: [
        { id: 'finding-1', path: 'src/app.js', line: 12 },
        { id: 'finding-2', path: 'src/other.js', line: 8 },
      ],
    }], manifest, {
      judge: { kind: 'independent_human', protocolId: 'double-blind-v1' },
      judgments: [{ findingId: 'finding-1', verdict: 'valid' }],
    } as any);
    expect(partiallyAdjudicated.precision).toBeNull();
    expect(partiallyAdjudicated.precision95).toBeNull();
    expect(partiallyAdjudicated.adjudicatedSubsetPrecision).toBe(1);
    expect(partiallyAdjudicated.adjudicatedSubsetPrecisionDenominator).toBe(1);
    expect(partiallyAdjudicated.unjudgedGeneratedFindingCount).toBe(1);
    expect(partiallyAdjudicated.qualified).toBe(false);

    const ambiguousJudgments = benchmark.scoreDiscoveryCases([{
      ...rows[0],
      findings: [
        { id: 'finding-1', path: 'src/app.js', line: 12 },
        { id: 'finding-2', path: 'src/other.js', line: 8 },
      ],
    }], manifest, {
      judge: { kind: 'independent_human', protocolId: 'double-blind-v1' },
      judgments: [
        { findingId: 'finding-1', verdict: 'valid' },
        { findingId: 'finding-1', verdict: 'invalid' },
        { findingId: 'not-generated', verdict: 'valid' },
      ],
    } as any);
    expect(ambiguousJudgments.precision).toBeNull();
    expect(ambiguousJudgments.adjudicatedSubsetPrecision).toBeNull();
    expect(ambiguousJudgments.adjudicatedSubsetPrecisionDenominator).toBe(0);
    expect(ambiguousJudgments.unjudgedGeneratedFindingCount).toBe(2);

    const duplicateGeneratedIds = benchmark.scoreDiscoveryCases([{
      ...rows[0],
      findings: [
        { id: 'finding-1', path: 'src/app.js', line: 12 },
        { id: 'finding-1', path: 'src/other.js', line: 8 },
      ],
    }], manifest, {
      judge: { kind: 'independent_human', protocolId: 'double-blind-v1' },
      judgments: [
        { findingId: 'finding-1', verdict: 'valid' },
        { findingId: 'foreign-finding', verdict: 'valid' },
      ],
    } as any);
    expect(duplicateGeneratedIds.precision).toBeNull();
    expect(duplicateGeneratedIds.qualified).toBe(false);

    const adjudicated = benchmark.scoreDiscoveryCases([{
      ...rows[0],
      findings: [{ id: 'finding-1', path: 'src/app.js', line: 12 }],
    }], manifest, {
      judge: { kind: 'independent_human', protocolId: 'double-blind-v1' },
      judgments: [{ findingId: 'finding-1', verdict: 'valid' }],
    } as any);
    expect(adjudicated.precision).toBe(1);
    expect(adjudicated.adjudicatedSubsetPrecision).toBe(1);
    expect(adjudicated.qualified).toBe(true);
  });

  it('does not score a verifier result when its pinned source snapshot has omissions', async () => {
    const matchingTestCase = benchmark.buildVerificationCases(referenceRows(), manifest)
      .find((entry: any) => entry.context === 'Diff Level');
    if (!matchingTestCase) throw new Error('diff-level fixture case missing');
    const testCase = matchingTestCase;
    let verifierCalls = 0;
    const result = await benchmark.runActualVerificationCase(testCase, {
      changedFiles: [{ path: testCase.reference.path, patch: 'diff --git a/src/app.js b/src/app.js\n+changed' }],
      omissions: ['head_blob_fetch_failed'],
    }, {
      resolveModelConfig: () => ({ enabled: true, transports: [
        { name: 'route', apiKey: 'secret', model: 'vendor/model' },
      ] }),
    }, {
      falsification: {
        runFindingFalsification: async () => {
          verifierCalls += 1;
          return { outcomes: [{ verdict: 'CONFIRM', reason: 'confirmed' }], receipt: { usage: {} } };
        },
      },
    } as any);

    expect(result.status).toBe('incomplete');
    expect(result.verdict).toBe('ABSTAIN');
    expect(result.sourceOmissions).toEqual(['head_blob_fetch_failed']);
    expect(verifierCalls).toBe(0);

    const score = benchmark.scoreVerificationCases([testCase], [result]);
    expect(score.completed).toBe(0);
    expect(score.byContext['Diff Level'].scoredCompleted).toBe(0);
  });

  it('requires a single credentialed real transport and refuses synthetic scoring', () => {
    expect(() => benchmark.assertActualModelConfig({
      resolveModelConfig: () => ({ enabled: false, transports: [] }),
    })).toThrow('actual_model_credentials_unavailable');
    expect(() => benchmark.assertActualModelConfig({
      resolveModelConfig: () => ({ enabled: true, transports: [
        { name: 'route-a', apiKey: 'secret', model: 'm1' },
        { name: 'route-b', apiKey: 'secret', model: 'm2' },
      ] }),
    })).toThrow('select_one_actual_transport_to_prevent_fallback');
    expect(() => benchmark.assertActualModelConfig({
      resolveModelConfig: () => ({ enabled: true, transports: [{ name: 'synthetic', apiKey: 'secret', model: 'm' }] }),
    })).toThrow('synthetic_provider_forbidden_for_qualification');
    const config = benchmark.assertActualModelConfig({
      resolveModelConfig: () => ({ enabled: true, transports: [{ name: 'route', apiKey: 'secret', model: 'vendor/model' }] }),
    });
    expect(config.selectedTransport).toEqual({ name: 'route', requestedModel: 'vendor/model' });
    expect(config.apiKey).toBe('');
  });

  it('scores only exact opaque panel IDs and reports task/context counts separately', () => {
    const testCases = benchmark.buildVerificationCases(referenceRows(), manifest);
    const results = testCases.map((entry: any) => ({
      caseId: entry.id,
      status: 'completed',
      verdict: entry.reference.expectedLabel === 1 ? 'CONFIRM' : 'REFUTE',
      contextQualification: entry.context === 'Diff Level' ? 'aligned_diff_only' : 'not_comparable_context_not_provided',
    }));
    const score = benchmark.scoreVerificationCases(testCases, results);
    expect(score.completed).toBe(2);
    expect(score.modelCompleted).toBe(6);
    expect(score.positiveReference.correctDecisions).toBe(1);
    expect(score.negativeReference.correctDecisions).toBe(1);
    expect(score.byContext['Diff Level'].scoredCompleted).toBe(2);
    expect(score.byContext['File Level'].correctDecisions).toBeNull();
    expect(score.byContext['Repo Level'].contextQualification).toBe('not_comparable_context_not_provided');
    expect(score.servingIdentity).toBe('unverified');
    expect(() => benchmark.scoreVerificationCases(testCases, [...results, results[0]])).toThrow('verification result IDs');
  });

  it('records sanitized completion route metadata without request identifiers or endpoint URLs', async () => {
    const identity = {
      requestedModels: new Set(), responseModels: new Set(), responseProviders: new Set(),
      responseRouteHints: new Set(), requestIdDigests: new Set(), fetchFailureClasses: new Set(),
      fetchToHeadersMs: [], httpStatuses: [], requestProfiles: new Map(), pendingResponseMetadataReads: [],
    };
    const wrappedFetch = benchmark.trackCompletion(async () => new Response(
      JSON.stringify({ model: 'deepseek-v4.1-flash', provider: 'NeuralWatt' }),
      { status: 200, headers: { 'x-bifrost-provider': 'neuralwatt', 'x-request-id': 'raw-private-request-id' } },
    ), identity);
    await wrappedFetch('https://private.gateway.example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'pr-reviewer', reasoning_effort: 'medium', max_tokens: 4096 }),
    });
    await Promise.all(identity.pendingResponseMetadataReads);
    const summary = benchmark.identitySummary(identity);
    expect(summary.requestedModels).toEqual(['pr-reviewer']);
    expect(summary.responseReportedModels).toEqual(['deepseek-v4.1-flash']);
    expect(summary.responseReportedProviders).toEqual(['NeuralWatt']);
    expect(summary.responseRouteHints).toEqual(['neuralwatt']);
    expect(summary.httpStatuses).toEqual([200]);
    expect(summary.fetchToHeadersMs).toHaveLength(1);
    expect(summary.requestIdDigests).toHaveLength(1);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('raw-private-request-id');
    expect(serialized).not.toContain('private.gateway.example');
  });

  it('does not read or clone a streamed completion body for telemetry', async () => {
    let cloneCount = 0;
    const identity = {
      requestedModels: new Set(), responseModels: new Set(), responseProviders: new Set(),
      responseRouteHints: new Set(), requestIdDigests: new Set(), fetchFailureClasses: new Set(),
      fetchToHeadersMs: [], httpStatuses: [], requestProfiles: new Map(), pendingResponseMetadataReads: [],
    };
    const response = {
      status: 200,
      headers: new Headers({ 'x-bifrost-provider': 'neuralwatt' }),
      clone() { cloneCount += 1; throw new Error('stream body must stay untouched'); },
    };
    const wrappedFetch = benchmark.trackCompletion(async () => response, identity);
    await wrappedFetch('https://private.gateway.example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'pr-reviewer', stream: true, reasoning_effort: 'medium' }),
    });
    expect(cloneCount).toBe(0);
    expect(identity.httpStatuses).toEqual([200]);
    expect(identity.requestProfiles.get(JSON.stringify({
      model: 'pr-reviewer', reasoningEffort: 'medium', maxOutputTokens: null, stream: true, providerPreferencePresent: false,
    }))).toMatchObject({ count: 1 });
  });

  it('drops free-form decision and verifier text from public runtime receipts', () => {
    const summary = benchmark.sanitizePanelResult({
      reviewDecision: {
        schemaVersion: 'review-yeti-severity.v2',
        classification: 'APPROVE',
        reason: 'raw completion text must not be serialized',
      },
      groundedReview: {
        verifierOutcomes: [{ verdict: 'ABSTAIN', reason: 'raw verifier response must not be serialized' }],
      },
      gracefulExit: { reason: 'model supplied arbitrary private text', completedTaskIds: [], pendingTaskIds: [] },
    });
    if (!summary) throw new Error('panel summary fixture was not sanitized');
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('raw completion text');
    expect(serialized).not.toContain('raw verifier response');
    expect(serialized).not.toContain('arbitrary private text');
    expect(summary.reviewDecision).toEqual({ schemaVersion: 'review-yeti-severity.v2', classification: 'APPROVE' });
    expect(summary.verifierOutcomes).toEqual([{ verdict: 'ABSTAIN' }]);
  });

  it('refuses to score a production-entrypoint smoke as a discovery evaluation', () => {
    expect(() => benchmark.assertDiscoveryRunEligible({
      executionPurpose: 'production_entrypoint_runtime_smoke_only',
      qualification: 'not_established_by_runtime_smoke_or_AACR_reference_match_alone',
      panelSize: 10,
      completion: { completed: 1, total: 1, allRuntimeReceiptsComplete: true },
      cases: [{ status: 'completed' }],
    })).toThrow('discovery_runtime_run_not_quality_eligible');
    expect(() => benchmark.assertDiscoveryRunEligible({
      executionPurpose: 'paired_heldout_evaluation',
      qualification: 'not_established_by_runtime_smoke_or_AACR_reference_match_alone',
      panelSize: 1,
      completion: { completed: 1, total: 1, allRuntimeReceiptsComplete: true },
      cases: [{ status: 'completed' }],
    })).toThrow('discovery_runtime_evaluation_incomplete');
    expect(() => benchmark.assertDiscoveryRunEligible({
      executionPurpose: 'paired_heldout_evaluation',
      qualification: 'eligible_for_independent_adjudication',
      panelSize: 1,
      completion: { completed: 1, total: 1, allRuntimeReceiptsComplete: true },
      cases: [{ status: 'completed' }],
    })).toThrow('run_missing_prepared_input_digest');
    expect(() => benchmark.assertDiscoveryRunEligible({
      executionPurpose: 'paired_heldout_evaluation',
      qualification: 'eligible_for_independent_adjudication',
      panelSize: 1,
      completion: { completed: 1, total: 1, allRuntimeReceiptsComplete: true },
      cases: [{ status: 'completed' }],
      preparedInputSha256: 'a'.repeat(64),
    })).toThrow('run_source_verification_boundary_missing');
  });
});
