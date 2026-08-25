import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));

const EXACT_HEAD = {
  repo: 'calltelemetry/example',
  prNumber: '17',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
};

const SECRET_VALUES = [
  'sk-live-provider-secret',
  'Bearer gh-app-installation-secret',
  'private prompt text that must not be persisted',
  'model completion that must not be persisted',
];

function collectKeys(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => collectKeys(entry, `${prefix}[${index}]`));
  if (!value || typeof value !== 'object') return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, entry]) => collectKeys(entry, prefix ? `${prefix}.${key}` : key));
}

function withRunnerTemp<T>(directory: string, callback: () => T): T {
  const previous = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = directory;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previous;
  }
}

describe('Rank 3A provider receipt schema and redaction contract', () => {
  it('keeps the existing receipt identity exact-head bound and versioned', () => {
    const report = pipeline.buildReviewRunReport(
      { verdict: 'SHIP', completedPersonas: 1, totalPersonas: 1, quorumSatisfied: true },
      [{ personaId: 'security', decision: 'APPROVE', findings: [] }],
      EXACT_HEAD,
    );

    expect(report).toMatchObject({
      schemaVersion: 'review-run-report-v1',
      repository: EXACT_HEAD.repo,
      prNumber: 17,
      baseSha: EXACT_HEAD.baseSha,
      headSha: EXACT_HEAD.headSha,
      verdict: 'SHIP',
    });
    expect(report.lanes).toHaveLength(1);
  });

  it('persists only the current lane receipt allowlist', () => {
    const report = pipeline.buildReviewRunReport(
      { verdict: 'FIX_FIRST', completedPersonas: 1, totalPersonas: 1, quorumSatisfied: true },
      [{
        personaId: 'security',
        displayName: 'Security',
        decision: 'FINDINGS',
        provider: 'fireworks',
        model: 'accounts/fireworks/models/secret-model',
        apiKey: SECRET_VALUES[0],
        requestHeaders: { authorization: SECRET_VALUES[1] },
        prompt: SECRET_VALUES[2],
        completion: SECRET_VALUES[3],
        inputTokens: 123,
        outputTokens: 45,
        cost: 0.004,
        findings: [{ severity: 'P1', path: 'src/example.ts', line: 3, title: 'Finding' }],
      }],
      EXACT_HEAD,
    );

    expect(report.lanes[0]).toEqual({
      personaId: 'security',
      decision: 'FINDINGS',
      findings: [{ severity: 'P1', path: 'src/example.ts', line: 3, title: 'Finding' }],
      severity: { P0: 0, P1: 1, P2: 0 },
    });

    const serialized = JSON.stringify(report);
    for (const secret of SECRET_VALUES) expect(serialized).not.toContain(secret);
    expect(collectKeys(report.lanes[0])).toEqual(expect.arrayContaining([
      'personaId',
      'decision',
      'findings[0].severity',
      'findings[0].path',
      'findings[0].line',
      'findings[0].title',
      'severity.P0',
      'severity.P1',
      'severity.P2',
    ]));
    expect(collectKeys(report.lanes[0]).some((key) => /provider|model|token|cost|prompt|completion|header|secret/i.test(key))).toBe(false);
  });

  it('does not allow finding text to become a credential or request-payload channel', () => {
    const report = pipeline.buildReviewRunReport(
      { verdict: 'BLOCK', completedPersonas: 1, totalPersonas: 1, quorumSatisfied: false },
      [{
        personaId: 'security',
        decision: 'ERROR',
        error: SECRET_VALUES[0],
        findings: [{
          severity: 'P0',
          path: 'src/example.ts',
          line: 9,
          title: 'Safe title',
          body: SECRET_VALUES[2],
          suggestion: SECRET_VALUES[3],
        }],
      }],
      EXACT_HEAD,
    );

    expect(JSON.stringify(report)).not.toContain(SECRET_VALUES[0]);
    expect(JSON.stringify(report)).toContain(SECRET_VALUES[2]);
    expect(JSON.stringify(report)).toContain(SECRET_VALUES[3]);
    expect(report.lanes[0]).not.toHaveProperty('error');
  });
});

describe('Rank 3D provider telemetry receipt schema', () => {
  it('persists bounded provider metadata and reported usage without changing the gate report', () => {
    const receipt = pipeline.buildProviderTelemetryReceipt([
      {
        personaId: 'security',
        transport: 'openrouter',
        provider: 'openrouter',
        model: 'openai/gpt-5.6-luna',
        inputTokens: '101',
        outputTokens: 22,
        cost: '0.0081',
        apiKey: SECRET_VALUES[0],
        prompt: SECRET_VALUES[2],
      },
      {
        personaId: 'performance',
        transport: 'default',
        provider: 'sk-live-provider-secret',
        model: 'gpt-sk-proj-1234567890',
        inputTokens: 'not-a-number',
        outputTokens: null,
        cost: 'generic-secret-value',
      },
    ], EXACT_HEAD);

    expect(receipt).toMatchObject({
      schemaVersion: 'review-provider-telemetry-v1',
      repository: EXACT_HEAD.repo,
      prNumber: 17,
      baseSha: EXACT_HEAD.baseSha,
      headSha: EXACT_HEAD.headSha,
    });
    expect(receipt.lanes).toEqual([
      {
        personaId: 'security',
        configuredTransport: 'openrouter',
        resolvedProvider: 'openrouter',
        modelDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        inputTokens: 101,
        outputTokens: 22,
        reportedCost: 0.0081,
        reportedCostCurrency: null,
        costStatus: 'reported',
      },
      {
        personaId: 'performance',
        configuredTransport: 'default',
        resolvedProvider: null,
        modelDigest: null,
        inputTokens: null,
        outputTokens: null,
        reportedCost: null,
        reportedCostCurrency: null,
        costStatus: 'unavailable',
      },
    ]);

    const serialized = JSON.stringify(receipt);
    for (const secret of SECRET_VALUES) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('sk-live-provider-secret');
    expect(serialized).not.toContain('gpt-sk-proj-1234567890');
    expect(serialized).not.toContain('generic-secret-value');
    expect(serialized).not.toContain('openai/gpt-5.6-luna');
  });

  it('writes an exact-head telemetry receipt with a stable digest', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-provider-telemetry-'));
    const result = withRunnerTemp(directory, () => pipeline.writeProviderTelemetryReceipt([
      {
        personaId: 'security',
        transport: 'openrouter',
        provider: 'openrouter',
        model: 'openai/gpt-5.6-luna',
        inputTokens: 101,
        outputTokens: 22,
        cost: 0.0081,
      },
    ], EXACT_HEAD, directory));

    expect(result.path).toBe(path.join(directory, 'review-yeti-provider-telemetry-17-bbbbbbbbbbbb.json'));
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    const receiptJson = fs.readFileSync(result.path, 'utf-8');
    expect(result.digest).toBe(createHash('sha256').update(receiptJson, 'utf-8').digest('hex'));
    expect(JSON.parse(receiptJson)).toMatchObject({
      schemaVersion: 'review-provider-telemetry-v1',
      baseSha: EXACT_HEAD.baseSha,
      headSha: EXACT_HEAD.headSha,
    });
  });

  it('omits empty, overlong, and control-character identifiers', () => {
    const receipt = pipeline.buildProviderTelemetryReceipt([{
      personaId: ' ',
      transport: 'openrouter\nworkflow-injection',
      provider: 'p'.repeat(201),
      model: '',
      inputTokens: 1,
      outputTokens: 2,
      cost: 0,
    }], EXACT_HEAD);

    expect(receipt.lanes[0]).toMatchObject({
      personaId: '',
      configuredTransport: null,
      resolvedProvider: null,
      modelDigest: null,
      inputTokens: 1,
      outputTokens: 2,
      reportedCost: 0,
      costStatus: 'reported',
    });
    expect(JSON.stringify(receipt)).not.toContain('workflow-injection');
    expect(JSON.stringify(receipt)).not.toContain('p'.repeat(201));
  });

  it('does not allow exact-head metadata to escape the telemetry output directory', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-provider-telemetry-'));
    const result = withRunnerTemp(directory, () => pipeline.writeProviderTelemetryReceipt([], {
      ...EXACT_HEAD,
      prNumber: '../../outside',
      headSha: '../head',
    }, directory));

    expect(result.path).toBe(path.join(directory, 'review-yeti-provider-telemetry-unknown-unknown.json'));

    const valid = withRunnerTemp(directory, () => pipeline.writeProviderTelemetryReceipt([], {
      ...EXACT_HEAD,
      prNumber: '007',
      headSha: 'c'.repeat(40),
    }, directory));
    expect(valid.path).toBe(path.join(directory, 'review-yeti-provider-telemetry-007-cccccccccccc.json'));
  });

  it('contains telemetry write failures without failing the review contract', () => {
    const outputFile = path.join(os.tmpdir(), `ct-provider-telemetry-output-${Date.now()}`);
    fs.writeFileSync(outputFile, 'not a directory');

    expect(withRunnerTemp(path.dirname(outputFile), () =>
      pipeline.writeProviderTelemetryReceiptBestEffort([], EXACT_HEAD, outputFile))).toBeNull();
    fs.unlinkSync(outputFile);
  });

  it('refuses telemetry writes when no runner temp boundary is available', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-provider-telemetry-'));
    const previous = process.env.RUNNER_TEMP;
    delete process.env.RUNNER_TEMP;
    try {
      expect(pipeline.writeProviderTelemetryReceipt([], EXACT_HEAD, directory)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = previous;
    }
  });
});
