import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { createReviewUnitManifest } = require('../../src/review/reviewUnitManifest.js');
const pipeline = require('../../.github/workflows/pipelines/review-pipeline.js');
const {
  buildReviewDispatchReceipt,
  validateReviewDispatchReceipt,
} = require('../../src/review/reviewDispatchReceipt.js');
const {
  buildReviewDispatchManifestArtifact,
  buildPipelineReviewDispatchReceipt,
  collectProviderReceiptIds,
  writeReviewDispatchArtifacts,
} = pipeline;
const { runPersonaInvestigation: runBoundedPersonaInvestigation } = require('../../src/review/reviewInvestigation.js');
// This is intentionally a repository-local test contract, not a runtime consumer import.
// @ts-ignore JavaScript contract fixture has no production declaration file.
import { reviewYetiRunReceiptDigest, validateReviewYetiRunReceipt } from '../support/reviewYetiReceiptAdapterContract.mjs';

const identity = {
  repository: 'owner/repository',
  prNumber: 42,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  configDigest: 'c'.repeat(64),
  policyDigest: 'd'.repeat(64),
  diffDigest: 'e'.repeat(64),
};

function baseManifest() {
  return createReviewUnitManifest({
    identity,
    trustedRules: { maxFileDiffChars: 5000, generatedPatterns: [], vendorPatterns: [] },
    policy: { maxFileDiffChars: 5000 },
    files: [
      { path: 'src/app.js', patch: '+const app = true;\n', unitStatus: 'completed' },
      { path: 'generated/schema.generated.json', patch: '+{}\n' },
    ],
  });
}

function baseReceipt(overrides: Record<string, unknown> = {}) {
  return buildReviewDispatchReceipt({
    identity,
    manifest: baseManifest(),
    verdict: 'SHIP',
    reviewStatus: 'SHIP',
    coverageStatus: 'complete',
    gateDecision: 'PASS',
    mergeEligible: true,
    metrics: { totalFindings: 0, p0Count: 0, p1Count: 0, p2Count: 0 },
    personasCompleted: 2,
    personasTotal: 2,
    investigationSummary: {
      schemaVersion: 'review-investigation-summary-v1',
      laneCount: 1,
      evidenceReceipts: 3,
      complete: true,
    },
    providerReceiptIds: ['gen_alpha', 'gen_beta'],
    ...overrides,
  });
}

function pipelineReceiptInput(overrides: Record<string, unknown> = {}) {
  const manifest = baseManifest();
  const manifestArtifact = buildReviewDispatchManifestArtifact(manifest);
  return {
    manifest,
    manifestArtifact,
    personaResults: [{
      decision: 'APPROVE',
      providerReceiptIds: ['gen_success'],
      providerUsage: { promptTokens: 25, completionTokens: 5, costUSD: 0.0125 },
    }],
    laneExecutionReceipts: [{ personaId: 'security', planDigest: '1'.repeat(64) }],
    findingVerification: { summary: { accepted: 0, rejected: 0, needsReview: 0 } },
    model: 'openrouter/auto',
    runtime: {
      runId: '987654321',
      runAttempt: 2,
      arm: 'candidate',
      actionSha: 'f'.repeat(40),
    },
    providerRoute: { model: 'openrouter/auto', only: ['examplecloud'], allowFallbacks: false },
    promptTemplateDigest: '2'.repeat(64),
    toolPolicy: { tools: ['file_read', 'diff_search'], maxCalls: 12 },
    latencyMs: 4821,
    ...overrides,
  };
}

function runActualProviderPipeline(cwd: string, fileSystem: typeof fs = fs) {
  const outputPath = path.join(cwd, 'github-output.txt');
  const postedReviews: any[] = [];
  return pipeline.main({
    cwd,
    fileSystem,
    env: {
      VITEST: 'true', GITHUB_ACTIONS: 'false', GITHUB_OUTPUT: outputPath,
      PR_DIFF: 'synthetic-test-input',
      GITHUB_RUN_ID: '987654321', GITHUB_RUN_ATTEMPT: '2', REVIEW_YETI_ACTION_SHA: 'f'.repeat(40),
      ACTIVE_PERSONAS: JSON.stringify(['security']), OPENROUTER_API_KEY: 'test-key', OPENROUTER_MODEL: 'model-a',
    },
    commandRunner: vi.fn((_command: string, args: string[], commandOptions: any) => {
      if (args?.[0] === 'pr' && args?.[1] === 'view') return { status: 0, stdout: JSON.stringify({ baseRefOid: 'a'.repeat(40), headRefOid: 'b'.repeat(40) }), stderr: '' };
      if (args?.[0] === 'api' && args?.[1] === 'graphql') return { status: 0, stdout: JSON.stringify([{ data: { viewer: { login: 'workflow-viewer' }, repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }]), stderr: '' };
      if (args?.[0] === 'api' && args?.[1] === 'user') return { status: 0, stdout: 'github-actions[bot]\n', stderr: '' };
      if (args?.[0] === 'api' && args?.[1]?.includes('/issues/42/comments') && !args.includes('--method')) return { status: 0, stdout: '', stderr: '' };
      if (args?.[0] === 'api' && args.includes('--method')) {
        const payload = JSON.parse(commandOptions.input);
        if (args[3]?.endsWith('/reviews')) postedReviews.push({ id: 101, body: payload.body, commit_id: payload.commit_id, user: { login: 'github-actions[bot]' } });
        return { status: 0, stdout: JSON.stringify({ id: 101, user: { login: 'github-actions[bot]' } }), stderr: '' };
      }
      if (args?.[0] === 'api' && args?.[1]?.includes('/pulls/42/reviews')) return { status: 0, stdout: JSON.stringify([postedReviews]), stderr: '' };
      return { status: 1, stdout: '', stderr: `unexpected command: ${args?.join(' ')}` };
    }),
    prContext: {
      repo: 'owner/repository', prNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
      diffText: 'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -0,0 +1 @@\n+const safe = true;\n',
    },
    evidenceRegistryFactory: () => ({ capabilities: { enabled: false, readOnly: true, tools: [] }, call: async () => ({ status: 'unavailable' }) }),
    modelClient: ({ options }: any) => {
      const unitIds = options.investigationUnitIds || [];
      const riskPlan = unitIds.map((unitId: string, index: number) => ({
        id: `risk-${index + 1}`, unit_ids: [unitId], statement: 'bounded test risk', evidence_needed: [], allowed_tools: [],
      }));
      return {
        ok: true, model: 'model-a', provider: 'examplecloud', generationId: 'gen_success',
        providerUsageReported: true, providerCostReported: false,
        usage: { promptTokens: 4, completionTokens: 2 },
        content: JSON.stringify({
          review_status: 'COMPLETE', risk_plan: riskPlan, evidence_requests: [],
          risk_dispositions: riskPlan.map((risk: any) => ({ risk_id: risk.id, status: 'rejected', reason: 'not defective' })),
          findings: [],
        }),
      };
    },
  });
}

describe('review dispatch receipt', () => {
  it('builds a bounded factual receipt with manifest and provider receipt digests', () => {
    const receipt = baseReceipt();

    expect(receipt).toMatchObject({
      schemaVersion: 'review-dispatch-run.v1',
      identity,
      verdict: 'SHIP',
      reviewStatus: 'SHIP',
      coverageStatus: 'complete',
      gateDecision: 'PASS',
      mergeEligible: true,
      findings: { total: 0, p0: 0, p1: 0, p2: 0 },
      personas: { completed: 2, total: 2 },
      investigation: { laneCount: 1, evidenceReceipts: 3, complete: true },
      manifest: {
        schemaVersion: 'review-unit-manifest-v1',
        unitsTotal: 2,
        unitsEmitted: 2,
        unitsOmitted: 0,
        coverage: { complete: true, shipEligible: true, uncovered: 0 },
      },
      providerReceipts: { count: 2 },
    });
    expect(receipt.manifest.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.providerReceipts.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(validateReviewDispatchReceipt(receipt, identity)).toEqual({ valid: true, errors: [] });
  });

  it('preserves bounded stage, usage, and latency facts without exposing provider payloads', () => {
    const receipt = baseReceipt({
      stages: {
        dispatch: 'completed',
        investigation: 'completed',
        arbitration: 'completed',
      },
      usage: {
        promptTokens: 1250,
        completionTokens: 220,
        costUSD: 0.031245,
      },
      latencyMs: 4821,
    });

    expect(receipt.stages).toEqual({
      dispatch: 'completed',
      investigation: 'completed',
      arbitration: 'completed',
    });
    expect(receipt.usage).toEqual({
      promptTokens: 1250,
      completionTokens: 220,
      totalTokens: 1470,
      costUSD: 0.031245,
    });
    expect(receipt.latencyMs).toBe(4821);
    expect(validateReviewDispatchReceipt(receipt, identity)).toEqual({ valid: true, errors: [] });
  });

  it('omits the provider receipt digest when the provider returned no generation ids', () => {
    const receipt = baseReceipt({ providerReceiptIds: [] });

    expect(receipt.providerReceipts).toEqual({ count: 0, ids: [] });
    expect(receipt.providerReceipts).not.toHaveProperty('digest');
    expect(receipt.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(validateReviewDispatchReceipt(receipt, identity)).toEqual({ valid: true, errors: [] });
  });

  it('builds the exact flat ct-meta provider receipt from factual pipeline inputs', () => {
    const receipt = buildPipelineReviewDispatchReceipt(pipelineReceiptInput());

    expect(Object.keys(receipt).sort()).toEqual([
      'action_sha', 'arm', 'base_sha', 'coverage_gaps', 'diff_digest', 'files_baseline_covered',
      'files_changed', 'head_sha', 'latency_ms', 'manifest_artifact_digest', 'manifest_digest',
      'model', 'plan_digest', 'policy_digest', 'pr_number', 'prompt_template_digest',
      'provider_receipt_digest', 'provider_route_digest', 'reflection', 'repository', 'rule_ids', 'run_attempt', 'run_id',
      'schema', 'stage_durations_ms', 'tool_policy_digest', 'units_emitted', 'units_omitted',
      'units_total', 'usage',
    ].sort());
    expect(receipt).toMatchObject({
      schema: 'review-dispatch-run.v1',
      run_id: '987654321',
      run_attempt: 2,
      arm: 'candidate',
      repository: 'owner/repository',
      pr_number: 42,
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      action_sha: 'f'.repeat(40),
      model: 'openrouter/auto',
      units_total: 2,
      units_emitted: 1,
      units_omitted: 1,
      files_changed: 2,
      files_baseline_covered: 2,
      coverage_gaps: 0,
      rule_ids: [],
      stage_durations_ms: { planning: 0, investigation: 0, reflection: 0, publication: 0 },
      reflection: { candidates: 0, kept: 0, downgraded: 0, dropped: 0, needs_review: 0 },
      usage: { prompt_tokens: 25, completion_tokens: 5, cost_usd: 0.0125 },
      latency_ms: 4821,
    });
    expect(receipt.provider_receipt_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toMatch(/providerReceipts|receiptDigest|raw_prompt|tool_output|source/i);
  });

  it('writes exact {schema, units} manifest bytes and validates the actual receipt with the local ct-meta adapter contract', () => {
    const input = pipelineReceiptInput();
    const receipt = buildPipelineReviewDispatchReceipt(input);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'review-dispatch-artifacts-'));

    const artifacts = writeReviewDispatchArtifacts(receipt, { cwd, manifestArtifact: input.manifestArtifact });
    const storedReceipt = JSON.parse(fs.readFileSync(artifacts.receiptPath, 'utf8'));
    const manifestArtifactText = fs.readFileSync(artifacts.manifestPath, 'utf8');
    const storedManifest = JSON.parse(manifestArtifactText);

    expect(artifacts).toMatchObject({
      receiptDigest: reviewYetiRunReceiptDigest(receipt),
      manifestDigest: receipt.manifest_digest,
      manifestArtifactDigest: receipt.manifest_artifact_digest,
    });
    expect(storedReceipt).toEqual(receipt);
    expect(Object.keys(storedManifest)).toEqual(['schema', 'units']);
    expect(storedManifest.units.map((unit: any) => unit.status)).toEqual(['emitted', 'omitted']);
    expect(receipt.manifest_digest).not.toBe(receipt.manifest_artifact_digest);
    expect(JSON.stringify({ storedReceipt, storedManifest })).not.toMatch(/raw_prompt|tool_output|raw_source|secret/i);
    expect(validateReviewYetiRunReceipt(storedReceipt, {
      repository: receipt.repository,
      pr_number: receipt.pr_number,
      base_sha: receipt.base_sha,
      head_sha: receipt.head_sha,
      action_sha: receipt.action_sha,
      diff_digest: receipt.diff_digest,
      policy_digest: receipt.policy_digest,
      plan_digest: receipt.plan_digest,
      manifest_digest: receipt.manifest_digest,
      manifest_artifact_digest: receipt.manifest_artifact_digest,
      manifestArtifactText,
    })).toEqual({ valid: true, errors: [] });

    expect(validateReviewYetiRunReceipt({ ...storedReceipt, raw_prompt: 'forbidden' })).toMatchObject({ valid: false });
    expect(validateReviewYetiRunReceipt({ ...storedReceipt, extra: true })).toMatchObject({ valid: false });
  });

  it('rejects mutable or missing action identity before a provider receipt can be published', () => {
    expect(() => buildPipelineReviewDispatchReceipt(pipelineReceiptInput({
      runtime: { ...pipelineReceiptInput().runtime, actionSha: 'v1' },
    }))).toThrow(/action_sha must be a full 40-hex SHA/);
    expect(() => buildPipelineReviewDispatchReceipt(pipelineReceiptInput({
      runtime: { ...pipelineReceiptInput().runtime, actionSha: '' },
    }))).toThrow(/action_sha must be a full 40-hex SHA/);
  });

  it('uses null usage facts when no successful provider response supplied receipt-backed usage', () => {
    const receipt = buildPipelineReviewDispatchReceipt(pipelineReceiptInput({
      personaResults: [{ decision: 'ERROR', generationId: 'gen_failed', usage: { promptTokens: 9, completionTokens: 3 } }],
    }));

    expect(receipt.usage).toEqual({ prompt_tokens: null, completion_tokens: null, cost_usd: null });
  });

  it('never collects provider ids from failed/error responses or unbacked usage', () => {
    expect(collectProviderReceiptIds([
      { decision: 'ERROR', providerReceiptIds: ['gen_failed'], providerUsage: { promptTokens: 9, completionTokens: 3 } },
      { decision: 'APPROVE', providerReceiptIds: ['gen_unbacked'] },
      { decision: 'APPROVE', generationId: 'gen_raw', routes: [{ generationId: 'gen_route' }] },
      { decision: 'APPROVE', providerReceiptIds: ['gen_success'], providerUsage: { promptTokens: 25, completionTokens: 5 } },
    ])).toEqual(['gen_success']);
  });

  it('captures the successful usage-backed provider id and usage from a completed bounded investigation lane', async () => {
    const run = await runBoundedPersonaInvestigation({
      identity: { repository: 'owner/repository', prNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
      persona: { id: 'security', name: 'Security', charter: 'Review security.' },
      manifest: '<review_units>[]</review_units>',
      diffText: '+const safe = true;',
      evidenceRegistry: { capabilities: { enabled: false, readOnly: true, tools: [] }, call: async () => ({ status: 'unavailable' }) },
      modelTurn: async () => ({
        ok: true, provider: 'openai', model: 'model-b', generationId: 'gen_success',
        providerUsageReported: true, providerCostReported: false,
        usage: { promptTokens: 25, completionTokens: 5 },
        content: JSON.stringify({ review_status: 'COMPLETE', risk_plan: [], evidence_requests: [], risk_dispositions: [], findings: [] }),
      }),
    });

    expect(run.personaResult.providerReceiptIds).toEqual(['gen_success']);
    expect(run.personaResult.providerUsage).toEqual({ promptTokens: 25, completionTokens: 5 });
    expect(collectProviderReceiptIds([run.personaResult])).toEqual(['gen_success']);
  });

  // REL-271 (D5): MAX_LANE_PROVIDER_RETRIES=0 means a failed modelTurn call terminates the lane
  // immediately -- there is no retry that could let a failed attempt's usage "sneak in" beside a
  // later successful one within the same lane. This replaces the old fail-then-succeed-via-retry
  // regression test (retries no longer exist) with the equivalent no-retry-era guarantee: a
  // failed lane never reports provider usage/receipt ids at all.
  it('never surfaces provider usage/receipt ids when the lane fails outright', async () => {
    const run = await runBoundedPersonaInvestigation({
      identity: { repository: 'owner/repository', prNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
      persona: { id: 'security', name: 'Security', charter: 'Review security.' },
      manifest: '<review_units>[]</review_units>',
      diffText: '+const safe = true;',
      evidenceRegistry: { capabilities: { enabled: false, readOnly: true, tools: [] }, call: async () => ({ status: 'unavailable' }) },
      modelTurn: async () => ({
        ok: false, error: 'provider_failure', provider: 'examplecloud', model: 'model-a',
        generationId: 'gen_failed', providerUsageReported: true,
        usage: { promptTokens: 9, completionTokens: 3 },
      }),
    });

    expect(run.personaResult.decision).toBe('ERROR');
    expect(run.personaResult.providerReceiptIds).toBeUndefined();
    expect(run.personaResult.providerUsage).toBeUndefined();
    expect(collectProviderReceiptIds([run.personaResult])).toEqual([]);
  });

  it('throws and withholds ordinary verdict outputs when provider artifact writing fails', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'review-dispatch-fail-closed-'));
    const outputPath = path.join(cwd, 'github-output.txt');
    const originalExitCode = process.exitCode;
    const fileSystem = {
      ...fs,
      writeFileSync() { throw new Error('injected artifact write failure'); },
    };
    try {
      process.exitCode = undefined;
      await expect(runActualProviderPipeline(cwd, fileSystem as typeof fs)).rejects.toThrow('injected artifact write failure');
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '').not.toContain('verdict=');
    } finally {
      process.exitCode = originalExitCode;
    }

  }, 15_000);

  it('emits an adapter-valid receipt and exact digest outputs from the actual provider pipeline', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'review-dispatch-actual-pipeline-'));
    const result = await runActualProviderPipeline(cwd);
    const receipt = result.reviewDispatch.receipt;
    const storedReceipt = JSON.parse(fs.readFileSync(result.reviewDispatch.artifacts.receiptPath, 'utf8'));
    const manifestArtifactText = fs.readFileSync(result.reviewDispatch.artifacts.manifestPath, 'utf8');
    const output = fs.readFileSync(path.join(cwd, 'github-output.txt'), 'utf8');

    expect(receipt.arm).toBe('baseline');
    expect(validateReviewYetiRunReceipt(receipt, {
      repository: receipt.repository,
      pr_number: receipt.pr_number,
      base_sha: receipt.base_sha,
      head_sha: receipt.head_sha,
      action_sha: receipt.action_sha,
      diff_digest: receipt.diff_digest,
      policy_digest: receipt.policy_digest,
      plan_digest: receipt.plan_digest,
      manifest_digest: receipt.manifest_digest,
      manifest_artifact_digest: receipt.manifest_artifact_digest,
      manifestArtifactText,
    })).toEqual({ valid: true, errors: [] });
    expect(storedReceipt.provider_receipt_digest).toBe(receipt.provider_receipt_digest);
    expect(output).toContain(`review-dispatch-digest=${result.reviewDispatch.artifacts.receiptDigest}`);
    expect(output).toContain(`review-dispatch-manifest-digest=${receipt.manifest_digest}`);
    expect(output).toContain(`review-dispatch-manifest-artifact-digest=${receipt.manifest_artifact_digest}`);
    expect(output).toContain(`review-dispatch-provider-receipt-digest=${receipt.provider_receipt_digest}`);
    expect(output).toContain(`review-dispatch-receipt-path=${result.reviewDispatch.artifacts.receiptPath}`);
    expect(output).toContain(`review-dispatch-manifest-path=${result.reviewDispatch.artifacts.manifestPath}`);
    expect(output).toContain('cost-usd=\n');
    expect(output).not.toContain('cost-usd=0\n');
  }, 15_000);

  it('rejects a receipt with missing immutable identity', () => {
    const receipt = baseReceipt();
    delete receipt.identity;

    const validation = validateReviewDispatchReceipt(receipt, identity);

    expect(validation.valid).toBe(false);
    expect(validation.errors.join('\n')).toContain('identity is required');
  });

  it('rejects mismatched diff digests between the receipt and manifest artifact', () => {
    const receipt = baseReceipt();
    receipt.manifest.identity = { ...receipt.manifest.identity, diffDigest: 'f'.repeat(64) };

    const validation = validateReviewDispatchReceipt(receipt, identity);

    expect(validation.valid).toBe(false);
    expect(validation.errors.join('\n')).toContain('manifest.identity.diffDigest');
  });

  it('rejects incomplete manifest artifacts and mismatched emitted counts', () => {
    const receipt = baseReceipt();
    receipt.manifest.units = receipt.manifest.units.slice(0, 1);
    receipt.manifest.unitsEmitted = 2;
    delete receipt.manifest.digest;

    const validation = validateReviewDispatchReceipt(receipt, identity);

    expect(validation.valid).toBe(false);
    expect(validation.errors.join('\n')).toContain('manifest.digest');
    expect(validation.errors.join('\n')).toContain('manifest.unitsEmitted');
  });

  it('rejects raw-secret, raw-prompt, source, tool-output, and provider error payload fields anywhere in the receipt', () => {
    const receipt = baseReceipt();
    receipt.raw_secret = 'sk-live-123';
    receipt.providerReceipts.source = 'https://provider.example/internal';
    receipt.providerReceipts.provider_error_payload = { message: 'quota exceeded', requestId: 'req_123' };
    receipt.manifest.units[0].tool_output = 'full diff text';
    receipt.investigation.raw_prompt = 'show me the secret prompt';

    const validation = validateReviewDispatchReceipt(receipt, identity);

    expect(validation.valid).toBe(false);
    expect(validation.errors.join('\n')).toContain('raw_secret');
    expect(validation.errors.join('\n')).toContain('providerReceipts.source');
    expect(validation.errors.join('\n')).toContain('providerReceipts.provider_error_payload');
    expect(validation.errors.join('\n')).toContain('manifest.units[0].tool_output');
    expect(validation.errors.join('\n')).toContain('investigation.raw_prompt');
  });

  it('rejects unknown nested fields instead of silently accepting adapter drift', () => {
    const receipt = baseReceipt();
    receipt.findings.extra = 1;

    const validation = validateReviewDispatchReceipt(receipt, identity);

    expect(validation.valid).toBe(false);
    expect(validation.errors.join('\n')).toContain('findings.extra');
  });
});
