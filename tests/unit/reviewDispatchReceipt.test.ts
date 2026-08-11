import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { createReviewUnitManifest } = require('../../src/review/reviewUnitManifest.js');
const {
  buildReviewDispatchReceipt,
  validateReviewDispatchReceipt,
} = require('../../src/review/reviewDispatchReceipt.js');
const {
  buildPipelineReviewDispatchReceipt,
  writeReviewDispatchArtifacts,
} = require('../../.github/workflows/pipelines/review-pipeline.js');

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

  it('builds the pipeline receipt from final arbitration and bounded provider generation ids', () => {
    const receipt = buildPipelineReviewDispatchReceipt({
      arbitration: {
        verdict: 'SHIP',
        status: 'SHIP',
        coverageStatus: 'complete',
        gateDecision: 'PASS',
        mergeEligible: true,
        completedPersonas: 2,
        totalPersonas: 2,
        metrics: { totalFindings: 0, p0Count: 0, p1Count: 0, p2Count: 0 },
      },
      manifest: baseManifest(),
      personaResults: [
        { providerReceiptIds: ['gen_beta', 'gen_alpha'], generationId: 'gen_beta' },
        { routes: [{ generationId: 'gen_alpha' }, { provider: 'morph' }] },
      ],
      investigationSummary: {
        schemaVersion: 'review-investigation-summary-v1',
        laneCount: 2,
        evidenceReceipts: 3,
        complete: true,
      },
      usage: { promptTokens: 25, completionTokens: 5, totalTokens: 30 },
    });

    expect(receipt.providerReceipts).toMatchObject({ count: 2, ids: ['gen_alpha', 'gen_beta'] });
    expect(receipt.providerReceipts.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.manifest).toMatchObject({ unitsTotal: 2, unitsEmitted: 2, unitsOmitted: 0 });
    expect(validateReviewDispatchReceipt(receipt, identity)).toEqual({ valid: true, errors: [] });
  });

  it('writes complete receipt and manifest artifacts with digest-verifiable safe fields only', () => {
    const receipt = baseReceipt({ providerReceiptIds: [] });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'review-dispatch-artifacts-'));

    const artifacts = writeReviewDispatchArtifacts(receipt, { cwd });
    const storedReceipt = JSON.parse(fs.readFileSync(artifacts.receiptPath, 'utf8'));
    const storedManifest = JSON.parse(fs.readFileSync(artifacts.manifestPath, 'utf8'));

    expect(artifacts).toMatchObject({
      receiptDigest: receipt.receiptDigest,
      manifestDigest: receipt.manifest.digest,
    });
    expect(storedReceipt).toEqual(receipt);
    expect(storedManifest).toEqual(receipt.manifest);
    expect(storedManifest).toMatchObject({ unitsTotal: 2, unitsEmitted: 2, unitsOmitted: 0 });
    expect(JSON.stringify({ storedReceipt, storedManifest })).not.toMatch(/prompt|tool_output|raw_source|secret/i);
    expect(validateReviewDispatchReceipt(storedReceipt, identity)).toEqual({ valid: true, errors: [] });
  });

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
