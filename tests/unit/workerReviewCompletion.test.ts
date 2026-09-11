import { describe, expect, it } from 'vitest';
import {
  MAX_COMPLETION_BYTES,
  deriveCanonicalWorkerReviewEvidence,
  parseWorkerReviewCompletion,
  type TrustedReviewCoverageContract,
  type WorkerReviewCompletion,
} from '../../src/review/workerReviewCompletion';

const changedFiles = [{
  path: 'src/example.ts',
  patch: '@@ -1,0 +1,2 @@\n+const first = 1;\n+const second = 2;\n',
}];

const expectedCoordinates = {
  runId: `run_${'a'.repeat(32)}`,
  repositoryId: 3210,
  owner: 'calltelemetry',
  repo: 'review-yeti-bot',
  prNumber: 42,
  headSha: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
  policyDigest: 'd'.repeat(64),
  configDigest: 'e'.repeat(64),
  executionAttempt: 2,
} as const;

const contract: TrustedReviewCoverageContract = {
  expectedCoordinates,
  expectedPersonaIds: ['security', 'architecture'],
  changedFiles,
  coverageComplete: true,
  quorumSatisfied: true,
};

const lane = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  decision: 'APPROVE',
  findings: [],
  ...overrides,
});

function completion(overrides: Record<string, unknown> = {}): WorkerReviewCompletion {
  return {
    version: 'WorkerReviewCompletion.v1',
    ...expectedCoordinates,
    result: {
      version: 'WorkerReviewResult.v1',
      completedAt: '2026-09-09T12:00:00.000Z',
      personas: [lane('security'), lane('architecture')],
      coverageComplete: true,
      quorumSatisfied: true,
      verdict: 'SHIP',
      findingCount: 0,
      blockingFindingCount: 0,
    },
    ...overrides,
  } as WorkerReviewCompletion;
}

function derive(input: WorkerReviewCompletion = completion(), trusted = contract) {
  return deriveCanonicalWorkerReviewEvidence(input, trusted);
}

function expectInvalid(result: ReturnType<typeof derive>, message: RegExp): void {
  expect(result.valid).toBe(false);
  if (result.valid) throw new Error('expected invalid worker review evidence');
  expect(result.reason).toBe('invalid-evidence');
  expect(result.message).toMatch(message);
}

describe('WorkerReviewCompletion.v1', () => {
  it('derives clean evidence from complete persona findings without trusting the worker verdict', () => {
    const result = derive();

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.canonical.verdict).toBe('SHIP');
    expect(result.canonical.quorumSatisfied).toBe(true);
    expect(result.evidence).toMatchObject({
      verdict: 'SHIP',
      coverageComplete: true,
      quorumSatisfied: true,
      infrastructureFailure: false,
      expectedLanes: 2,
      completedLanes: 2,
      p0Count: 0,
      p1Count: 0,
    });
  });

  it('derives canonical blocking evidence for findings', () => {
    const result = derive(completion({
      result: {
        ...completion().result,
        personas: [
          lane('security', {
            decision: 'FINDINGS',
            findings: [{ severity: 'P1', path: 'src/example.ts', line: 1, title: 'Unsafe change', body: 'This needs review.' }],
          }),
          lane('architecture'),
        ],
        verdict: 'FIX_FIRST',
        findingCount: 1,
        blockingFindingCount: 1,
      },
    }));

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.canonical.verdict).toBe('FIX_FIRST');
    expect(result.evidence.p1Count).toBe(1);
    expect(result.evidence.quorumSatisfied).toBe(true);
  });

  it('does not let a worker SHIP or count override canonical findings', () => {
    const result = derive(completion({
      result: {
        ...completion().result,
        personas: [
          lane('security', {
            decision: 'FINDINGS',
            findings: [{ severity: 'P1', path: 'src/example.ts', line: 1, title: 'Unsafe change', body: 'This needs review.' }],
          }),
          lane('architecture'),
        ],
        verdict: 'SHIP',
        findingCount: 0,
        blockingFindingCount: 0,
      },
    }));

    expectInvalid(result, /disagrees with canonical/u);
  });

  it('rejects missing, duplicate, and unknown persona lanes safely', () => {
    const missing = derive(completion({ result: { ...completion().result, personas: [lane('security')], verdict: 'BLOCK' } }));
    expect(missing.valid).toBe(true);
    if (missing.valid) {
      expect(missing.canonical.status).toBe('INCOMPLETE_REVIEW');
      expect(missing.evidence.quorumSatisfied).toBe(false);
      expect(missing.evidence.completedLanes).toBe(1);
    }

    const duplicate = derive(completion({ result: { ...completion().result, personas: [lane('security'), lane('security')] } }));
    expectInvalid(duplicate, /duplicate/u);

    const unknown = derive(completion({ result: { ...completion().result, personas: [lane('security'), lane('testing')] } }));
    expectInvalid(unknown, /unknown/u);
  });

  it('marks lane errors as infrastructure failure and never as success', () => {
    const result = derive(completion({
      result: {
        ...completion().result,
        personas: [lane('security', { decision: 'ERROR', status: 'ERROR', errorClass: 'timeout' }), lane('architecture')],
        verdict: 'BLOCK',
        findingCount: 0,
        blockingFindingCount: 0,
      },
    }));

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.canonical.verdict).toBe('BLOCK');
    expect(result.evidence.infrastructureFailure).toBe(true);
    expect(result.evidence.quorumSatisfied).toBe(false);
  });

  it('rejects raw error transcripts and retains only the bounded error class', () => {
    const transcript = 'provider response included secret=do-not-retain';
    const rawError = completion({
      result: {
        ...completion().result,
        personas: [lane('security', { decision: 'ERROR', status: 'ERROR', error: transcript }), lane('architecture')],
      },
    });

    let thrown: unknown;
    try {
      parseWorkerReviewCompletion(rawError);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(transcript);
    expect(() => parseWorkerReviewCompletion(rawError)).toThrow(/invalid WorkerReviewCompletion.*'error'/u);

    const safe = parseWorkerReviewCompletion(completion({
      result: {
        ...completion().result,
        personas: [lane('security', { decision: 'ERROR', status: 'ERROR', errorClass: 'timeout' }), lane('architecture')],
        verdict: 'BLOCK',
      },
    }));
    expect(safe.result.personas[0]).toMatchObject({ errorClass: 'timeout' });
    expect(safe.result.personas[0]).not.toHaveProperty('error');
  });

  it('accepts only bounded failure diagnostics on the typed completion envelope', () => {
    const diagnostic = { reason: 'provider_rate_limited', providerStatus: 429, logTail: 'HTTP 429 [REDACTED]' };
    const parsed = parseWorkerReviewCompletion(completion({
      result: {
        ...completion().result,
        personas: [lane('security', { decision: 'ERROR', status: 'ERROR', errorClass: 'rate_limit' }), lane('architecture')],
        coverageComplete: false, quorumSatisfied: false, failureDiagnostics: diagnostic,
      },
    }));
    expect(parsed.result.failureDiagnostics).toEqual(diagnostic);
    expect(() => parseWorkerReviewCompletion(completion({
      result: { ...completion().result, failureDiagnostics: { ...diagnostic, providerStatus: 99 } },
    }))).toThrow(/providerStatus/u);
  });

  it('preserves incomplete coverage and quorum failure as non-success evidence', () => {
    const coverage = derive(completion({ result: { ...completion().result, coverageComplete: false, verdict: 'BLOCK' } }));
    expect(coverage.valid).toBe(true);
    if (coverage.valid) {
      expect(coverage.evidence.coverageComplete).toBe(false);
      expect(coverage.canonical.status).toBe('INCOMPLETE_REVIEW');
    }

    const quorum = derive(completion({ result: { ...completion().result, quorumSatisfied: false, verdict: 'SHIP' } }));
    expect(quorum.valid).toBe(true);
    if (quorum.valid) expect(quorum.evidence.quorumSatisfied).toBe(false);

    const trustedFailure = derive(completion(), { ...contract, coverageComplete: false });
    expect(trustedFailure.valid).toBe(false);
    expect(trustedFailure.evidence?.coverageComplete).toBe(false);
  });

  it('rejects invalid or unanchored finding evidence', () => {
    const invalid = derive(completion({
      result: {
        ...completion().result,
        personas: [
          lane('security', {
            decision: 'FINDINGS',
            findings: [{ severity: 'P1', path: '../secret.ts', line: 1, title: 'Bad path', body: 'Not in the review.' }],
          }),
          lane('architecture'),
        ],
      },
    }));

    expectInvalid(invalid, /invalid findings/u);
  });

  it('rejects schema, coordinate, and authoritative-field violations', () => {
    expect(() => parseWorkerReviewCompletion({ ...completion(), headSha: 'not-a-sha' })).toThrow(/invalid WorkerReviewCompletion/u);
    expect(() => parseWorkerReviewCompletion({ ...completion(), repositoryId: 0 })).toThrow(/invalid WorkerReviewCompletion/u);
    expect(() => parseWorkerReviewCompletion({ ...completion(), checkId: 123 })).toThrow(/invalid WorkerReviewCompletion/u);
    expect(() => parseWorkerReviewCompletion({ ...completion(), result: { ...completion().result, conclusion: 'success' } })).toThrow(/invalid WorkerReviewCompletion/u);
    expect(() => parseWorkerReviewCompletion({ ...completion(), result: { ...completion().result, url: 'https://example.test' } })).toThrow(/invalid WorkerReviewCompletion/u);
    expect(() => parseWorkerReviewCompletion({ ...completion(), override: { verdict: 'SHIP' } })).toThrow(/invalid WorkerReviewCompletion/u);
    expect(() => parseWorkerReviewCompletion({
      ...completion(),
      result: { ...completion().result, version: 'ReviewYetiPublishingReview.v1' },
    })).toThrow(/invalid WorkerReviewCompletion/u);
    for (const [field, value] of [['required', false], ['providerId', 'provider'], ['model', 'model']] as const) {
      expect(() => parseWorkerReviewCompletion({
        ...completion(),
        result: { ...completion().result, personas: [lane('security', { [field]: value }), lane('architecture')] },
      })).toThrow(/invalid WorkerReviewCompletion/u);
    }

    const mismatchedCoordinates = derive(completion({ headSha: 'f'.repeat(40) }));
    expectInvalid(mismatchedCoordinates, /coordinates do not match/u);
  });

  it.each([
    ['runId', `run_${'f'.repeat(32)}`],
    ['repositoryId', 3211],
    ['owner', 'other-owner'],
    ['repo', 'other-repo'],
    ['prNumber', 43],
    ['headSha', 'f'.repeat(40)],
    ['baseSha', 'f'.repeat(40)],
    ['policyDigest', 'f'.repeat(64)],
    ['configDigest', 'f'.repeat(64)],
    ['executionAttempt', 3],
  ] as const)('rejects a trusted coordinate mismatch for %s', (field, value) => {
    expectInvalid(derive(completion({ [field]: value })), /coordinates do not match/u);
  });

  it('does not accept the current metrics-only publishing receipt as review evidence', () => {
    const metricsOnly = completion({
      result: {
        ...completion().result,
        personas: [{ id: 'security', decision: 'APPROVE', findingsCount: 0 }],
      },
    });
    expect(() => parseWorkerReviewCompletion(metricsOnly)).toThrow(/findings/u);
  });

  it('rejects oversized payloads before schema processing', () => {
    const oversized = { ...completion(), extra: 'x'.repeat(MAX_COMPLETION_BYTES) };
    expect(() => parseWorkerReviewCompletion(oversized)).toThrow(/exceeds/u);
  });

  it('enforces per-field text bounds independently from the total UTF-8 byte bound', () => {
    const tooLong = completion({
      result: {
        ...completion().result,
        personas: [lane('security', {
          decision: 'FINDINGS',
          findings: [{ severity: 'P2', path: 'src/example.ts', line: 1, title: 'Bounded', body: 'x'.repeat(16_001) }],
        }), lane('architecture')],
      },
    });
    expect(() => parseWorkerReviewCompletion(tooLong)).toThrow(/invalid WorkerReviewCompletion/u);

    const boundedMultibyte = 'é'.repeat(16_000);
    const parsed = parseWorkerReviewCompletion(completion({
      result: {
        ...completion().result,
        personas: [lane('security', {
          decision: 'FINDINGS',
          findings: [{ severity: 'P2', path: 'src/example.ts', line: 1, title: 'Bounded', body: boundedMultibyte }],
        }), lane('architecture')],
      },
    }));
    expect(parsed.result.personas[0]?.findings[0]?.body).toHaveLength(16_000);
  });

  it('rejects an under-specified trusted contract rather than assuming review coverage', () => {
    expect(() => derive(completion(), { ...contract, expectedPersonaIds: [] })).toThrow(/expected persona IDs/u);
    expect(() => derive(completion(), { ...contract, expectedPersonaIds: ['security', 'security'] })).toThrow(/unique/u);
    expect(() => derive(completion(), { ...contract, changedFiles: [] })).toThrow(/one or more/u);
    expectInvalid(
      derive(completion(), { ...contract, expectedCoordinates: { ...expectedCoordinates, configDigest: 'f'.repeat(64) } }),
      /coordinates do not match/u,
    );
  });
});
