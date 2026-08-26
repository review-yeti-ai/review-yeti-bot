import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildModelOptions,
  captureLaneTelemetry,
  findingMatchesFixture,
  gradeFindings,
  verifyCandidateRows,
  wilson,
} from '../../scripts/evaluate-verified-publication.mjs';

const fixture = {
  id: 'defect-1',
  category: 'defect',
  title: 'seeded defect',
  expectedPaths: ['tests/app.test.js'],
  mustMatch: [['vacuous', 'always passes'], ['default']],
  files: [{ path: 'tests/app.test.js', patch: '@@ -1,2 +1,2 @@\n-a\n+b' }],
};

const cleanFixture = {
  id: 'clean-1',
  category: 'clean',
  title: 'benign refactor',
  expectedPaths: ['src/app.js'],
  mustMatch: [],
  files: [{ path: 'src/app.js', patch: '@@ -1,2 +1,2 @@\n-a\n+b' }],
};

const evaluationMatrix = JSON.parse(fs.readFileSync(
  path.resolve(process.cwd(), 'eval-baselines/verified-publication-fixtures/evaluation-matrix.json'),
  'utf8',
));
const excludedDiagnostics = JSON.parse(fs.readFileSync(
  path.resolve(process.cwd(), 'eval-baselines/verified-publication-fixtures/excluded-diagnostics.json'),
  'utf8',
));

function matchingFinding() {
  return {
    severity: 'P1',
    path: 'tests/app.test.js',
    line: 2,
    side: 'RIGHT',
    title: 'Vacuous assertion',
    body: 'The test always passes because it compares the default against itself.',
  };
}

function laneRow(overrides: Record<string, unknown> = {}) {
  return {
    arm: 'candidate',
    fixtureId: 'defect-1',
    category: 'defect',
    repetition: 1,
    latencyMs: 1000,
    usage: { promptTokens: 100, completionTokens: 50, costUSD: 0.002 },
    errored: false,
    detected: true,
    falsePositive: false,
    anchored: true,
    findings: 1,
    findingsDetail: [matchingFinding()],
    findingTitles: ['tests/app.test.js:2 Vacuous assertion'],
    ...overrides,
  };
}

function verdictClient(verdict: string, extra: Record<string, unknown> = {}) {
  return async () => ({
    verdict: undefined,
    ok: true,
    content: JSON.stringify({ complete: true, verdict, ...extra }),
    usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50, costUSD: 0.0005 },
  });
}

const confirmFields = {
  violated_invariant: 'the assertion compares the default to itself',
  failure_path: 'any regression in the default keeps the test green',
  benign_explanation_check: 'no other assertion covers the value',
};

describe('grading mirror', () => {
  it('keeps active qualification fixtures unique, gradeable, and separate from excluded diagnostics', () => {
    const ids = evaluationMatrix.fixtures.map((entry: { id: string }) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(excludedDiagnostics.excludedFromQualification).toBe(true);
    for (const fixtureEntry of evaluationMatrix.fixtures) {
      expect(['defect', 'clean']).toContain(fixtureEntry.category);
      if (fixtureEntry.category === 'defect') {
        expect(fixtureEntry.expectedPaths.length).toBeGreaterThan(0);
        expect(fixtureEntry.mustMatch.length).toBeGreaterThan(0);
      } else {
        expect(fixtureEntry.expectedPaths).toEqual([]);
        expect(fixtureEntry.mustMatch).toEqual([]);
      }
    }
    for (const excluded of excludedDiagnostics.fixtures) {
      expect(ids).not.toContain(excluded.id);
    }
  });

  it('pairs every metamorphic group with one defect and one clean control', () => {
    const groups = new Map<string, string[]>();
    for (const fixtureEntry of evaluationMatrix.fixtures) {
      if (!fixtureEntry.metamorphicGroup) continue;
      const categories = groups.get(fixtureEntry.metamorphicGroup) || [];
      categories.push(fixtureEntry.category);
      groups.set(fixtureEntry.metamorphicGroup, categories);
    }
    expect(groups.size).toBeGreaterThanOrEqual(3);
    for (const categories of groups.values()) {
      expect(categories.sort()).toEqual(['clean', 'defect']);
    }
  });

  it('makes the clean rate-limiter cases prove their own call counts', () => {
    const fixtureEntry = evaluationMatrix.fixtures.find(
      (entry: { id: string }) => entry.id === 'function-scoped-fixture-avoids-shared-state',
    );
    const patchText = fixtureEntry.files[0].patch;
    expect(patchText).toContain("it('allows the second call for the same key'");
    expect(patchText).toContain("expect(limiter.allow('key')).toBe(true);\n+    expect(limiter.allow('key')).toBe(true);");
    expect(patchText).toContain("expect(limiter.allow('key')).toBe(false);");
  });

  it('keeps holdouts cross-language and out of the excluded diagnostic set', () => {
    const holdouts = evaluationMatrix.fixtures.filter(
      (entry: { evaluationRole?: string }) => entry.evaluationRole === 'holdout',
    );
    expect(holdouts.map((entry: { id: string }) => entry.id)).toEqual([
      'elixir-second-error-cause-untested',
      'elixir-both-error-causes-covered',
      'java-fixed-sleep-for-asynchronous-state',
      'java-condition-wait-for-asynchronous-state',
    ]);
    expect(holdouts.some((entry: { files: Array<{ path: string }> }) => entry.files.some((file) => file.path.endsWith('.exs')))).toBe(true);
    expect(holdouts.some((entry: { files: Array<{ path: string }> }) => entry.files.some((file) => file.path.endsWith('.java')))).toBe(true);
  });

  it('preserves the env-resolved transport handoff for live qualification calls', () => {
    const previousTransports = process.env.REVIEW_YETI_TRANSPORTS;
    const previousOllamaKey = process.env.OLLAMA_PR_REVIEW_API_KEY;
    process.env.REVIEW_YETI_TRANSPORTS = JSON.stringify([{
      name: 'ollama',
      base_url: 'https://ollama.test/v1',
      api_key_env: 'OLLAMA_PR_REVIEW_API_KEY',
      model: 'deepseek-v4-flash:cloud',
      stream: true,
      timeout_ms: 90000,
    }]);
    process.env.OLLAMA_PR_REVIEW_API_KEY = 'qualification-secret';
    try {
      const options = buildModelOptions(['node', 'evaluate-verified-publication.mjs']);
      expect(options.transports).toHaveLength(1);
      expect(options.transports[0]).toMatchObject({
        name: 'ollama',
        baseUrl: 'https://ollama.test/v1',
        model: 'deepseek-v4-flash:cloud',
        apiKey: 'qualification-secret',
        stream: true,
      });
    } finally {
      if (previousTransports === undefined) delete process.env.REVIEW_YETI_TRANSPORTS;
      else process.env.REVIEW_YETI_TRANSPORTS = previousTransports;
      if (previousOllamaKey === undefined) delete process.env.OLLAMA_PR_REVIEW_API_KEY;
      else process.env.OLLAMA_PR_REVIEW_API_KEY = previousOllamaKey;
    }
  });

  it('retains only bounded lane telemetry and rejects prototype labels', () => {
    expect(captureLaneTelemetry({
      provider: 'Ollama',
      transport: 'ollama',
      failureClass: 'provider_error',
      responseStatus: 503,
      errorCode: 'upstream_error',
      attemptCount: 2,
      retryReasons: ['http_5xx', 'not a label', '__proto__'],
      outputShape: 'direct_json_object',
      finishReason: 'length',
      responseMode: 'stream',
      findingsSource: 'reasoning',
      contentPresent: false,
      reasoningPresent: true,
      contentSizeBucket: 'empty',
      reasoningSizeBucket: 'tiny',
      outputContract: {
        policyDeclared: 'json_object',
        requestObserved: 'json_object',
        providerSupported: 'unreported',
        terminalParsed: true,
      },
      responseAttempts: [{
        attempt: 1,
        outcome: 'malformed_output',
        provider: 'ollama',
        transport: 'ollama',
        latencyMs: 90000,
        responseStatus: 200,
        failureClass: 'malformed_output',
        reasoningEffort: 'high',
        maxOutputTokens: 24576,
        outputTokens: 24576,
        outputShape: 'no_json',
        finishReason: 'length',
        responseMode: 'stream',
        findingsSource: 'none',
        contentPresent: false,
        reasoningPresent: true,
        contentSizeBucket: 'empty',
        reasoningSizeBucket: 'small',
        outputContract: {
          policyDeclared: 'json_object',
          requestObserved: 'json_object',
          providerSupported: 'unreported',
          terminalParsed: false,
        },
        rawResponse: 'must not survive',
      }, {
        attempt: 2,
        outcome: 'secret-outcome',
        provider: 'secret-provider',
      }],
      error: 'raw provider response must not be copied',
    })).toEqual({
      provider: 'ollama',
      transport: 'ollama',
      failureClass: 'provider_error',
      responseStatus: 503,
      errorCode: 'upstream_error',
      attemptCount: 2,
      retryReasons: ['http_5xx'],
      outputShape: 'direct_json_object',
      finishReason: 'length',
      responseMode: 'stream',
      findingsSource: 'reasoning',
      contentPresent: false,
      reasoningPresent: true,
      contentSizeBucket: 'empty',
      reasoningSizeBucket: 'tiny',
      outputContract: {
        policyDeclared: 'json_object',
        requestObserved: 'json_object',
        providerSupported: 'unreported',
        terminalParsed: true,
      },
      responseAttempts: [{
        attempt: 1,
        outcome: 'malformed_output',
        provider: 'ollama',
        transport: 'ollama',
        latencyMs: 90000,
        responseStatus: 200,
        failureClass: 'malformed_output',
        reasoningEffort: 'high',
        maxOutputTokens: 24576,
        outputTokens: 24576,
        outputShape: 'no_json',
        finishReason: 'length',
        responseMode: 'stream',
        findingsSource: 'none',
        contentPresent: false,
        reasoningPresent: true,
        contentSizeBucket: 'empty',
        reasoningSizeBucket: 'small',
        outputContract: {
          policyDeclared: 'json_object',
          requestObserved: 'json_object',
          providerSupported: 'unreported',
          terminalParsed: false,
        },
      }],
    });
  });

  it('drops arbitrary values at the output telemetry boundary', () => {
    expect(captureLaneTelemetry({
      outputShape: 'secret-response-shape',
      finishReason: 'secret-finish-detail',
      responseMode: 'unbounded-mode',
      findingsSource: '__proto__',
      contentPresent: 'true',
      reasoningPresent: 1,
      contentSizeBucket: '12345',
      reasoningSizeBucket: 'raw-length-98765',
      outputContract: {
        policyDeclared: 'secret',
        requestObserved: 'canary',
        providerSupported: 'raw',
        terminalParsed: 1,
      },
    })).toEqual({
      outputContract: {
        policyDeclared: 'unknown',
        requestObserved: 'unknown',
        providerSupported: 'unreported',
        terminalParsed: false,
      },
    });
  });

  it('matches the harness contract: anchored path AND every concept group', () => {
    expect(findingMatchesFixture(matchingFinding(), fixture)).toBe(true);
    expect(findingMatchesFixture({ ...matchingFinding(), path: 'src/other.js' }, fixture)).toBe(false);
    expect(findingMatchesFixture({ ...matchingFinding(), body: 'always passes but never names the other idea' }, fixture)).toBe(false);
  });

  it('grades clean fixtures on any surviving finding', () => {
    expect(gradeFindings(cleanFixture, [matchingFinding()], false).falsePositive).toBe(true);
    expect(gradeFindings(cleanFixture, [], false).falsePositive).toBe(false);
  });

  it('computes a Wilson interval', () => {
    const interval = wilson(1, 32);
    expect(interval?.[0]).toBeGreaterThanOrEqual(0);
    expect(interval?.[1]).toBeLessThan(0.2);
  });
});

describe('verifyCandidateRows', () => {
  it('keeps a detected row detected when the verifier confirms', async () => {
    const { rows, verifierStats } = await verifyCandidateRows({
      rows: [laneRow()],
      matrix: { fixtures: [fixture, cleanFixture] },
      falsifyTurnFactory: () => verdictClient('CONFIRM', confirmFields),
    });
    expect(rows[0].arm).toBe('verified');
    expect(rows[0].detected).toBe(true);
    expect(verifierStats.confirmed).toBe(1);
    // Added cost and latency are accounted, not hidden.
    expect(rows[0].usage.promptTokens).toBe(140);
    expect(rows[0].latencyMs).toBeGreaterThanOrEqual(1000);
  });

  it('clears a clean-fixture false positive when the verifier refutes', async () => {
    const row = laneRow({ fixtureId: 'clean-1', category: 'clean', detected: false, falsePositive: true, noise: 1, findingsDetail: [{ ...matchingFinding(), path: 'src/app.js' }] });
    const { rows } = await verifyCandidateRows({
      rows: [row],
      matrix: { fixtures: [fixture, cleanFixture] },
      falsifyTurnFactory: () => verdictClient('REFUTE', { benign_explanation: 'behavior-preserving refactor' }),
    });
    expect(rows[0].falsePositive).toBe(false);
    expect(rows[0].findings).toBe(0);
    // SNR inputs are recomputed on the confirmed subset, never inherited from the candidate row.
    expect(rows[0].noise).toBe(0);
  });

  it('withholds on abstention: a detected row loses its finding but never gains one', async () => {
    const { rows, verifierStats } = await verifyCandidateRows({
      rows: [laneRow()],
      matrix: { fixtures: [fixture, cleanFixture] },
      falsifyTurnFactory: () => verdictClient('ABSTAIN'),
    });
    expect(rows[0].detected).toBe(false);
    expect(verifierStats.abstained).toBe(1);
  });

  it('passes errored lane rows through unchanged without calling the verifier', async () => {
    let called = 0;
    const { rows } = await verifyCandidateRows({
      rows: [laneRow({ errored: true, error: 'provider_failure', detected: false, findingsDetail: [matchingFinding()] })],
      matrix: { fixtures: [fixture, cleanFixture] },
      falsifyTurnFactory: () => async () => { called += 1; return { ok: false, error: 'should not run' }; },
    });
    expect(called).toBe(0);
    expect(rows[0].errored).toBe(true);
    expect(rows[0].detected).toBe(false);
  });
});
