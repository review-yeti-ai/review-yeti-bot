import { describe, expect, it } from 'vitest';
import {
  MAX_COMPLETION_BYTES,
  MAX_TURN_USAGES,
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

  describe('optional per-persona telemetry (Stage 0: turn-accumulated usage)', () => {
    // Additive-only: `personaSchema` is `.strict()`, so this whole block exists to prove the new
    // field is genuinely optional (no version bump / dispatcher change needed) rather than merely
    // undocumented-but-accepted.
    const turnUsage = (overrides: Record<string, unknown> = {}) => ({
      turn: 1, kind: 'final', promptTokens: 100, completionTokens: 20, totalTokens: 120,
      cachedTokens: 30, costUSD: 0.001, model: 'claude-5-sonnet', durationMs: 250,
      ...overrides,
    });

    it('parses a persona that carries full per-turn telemetry', () => {
      const parsed = parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [
            lane('security', {
              telemetry: {
                model: 'claude-5-sonnet',
                turnsCount: 3,
                toolTurns: 1,
                correctionTurns: 1,
                promptTokens: 450,
                completionTokens: 75,
                totalTokens: 525,
                cachedTokens: 80,
                costUSD: 0.0042,
                durationMs: 900,
                turnUsages: [
                  turnUsage({ turn: 1, kind: 'tool' }),
                  turnUsage({ turn: 2, kind: 'correction', cachedTokens: 0 }),
                  turnUsage({ turn: 3, kind: 'final' }),
                ],
              },
            }),
            lane('architecture'),
          ],
        },
      }));
      expect(parsed.result.personas[0]?.telemetry).toMatchObject({
        turnsCount: 3, toolTurns: 1, correctionTurns: 1, totalTokens: 525, cachedTokens: 80,
      });
      expect(parsed.result.personas[0]?.telemetry?.turnUsages).toHaveLength(3);
      expect(parsed.result.personas[0]?.telemetry?.turnUsages?.map((t) => t.kind)).toEqual(['tool', 'correction', 'final']);
    });

    it('parses telemetry.toolCalls -- the count crossing the completion boundary (#862 gap)', () => {
      // Before this change `toolCalls` was tracked inside the panel engine (the array declared
      // in `panelEngine.ts`) but had no field on `personaTelemetrySchema`, so it never reached the
      // completion payload -- nothing downstream could read it.
      const parsed = parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', { telemetry: { toolCalls: 7 } }), lane('architecture')],
        },
      }));
      expect(parsed.result.personas[0]?.telemetry).toEqual({ toolCalls: 7 });
    });

    it('rejects a negative toolCalls count', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', { telemetry: { toolCalls: -1 } }), lane('architecture')],
        },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });

    it('still parses a persona with no telemetry field at all -- backward compatible, no version bump', () => {
      // This is the pre-Stage-0 shape every existing caller (and every OTHER test in this file)
      // sends. `telemetry` must be optional, not merely tolerated when present.
      const parsed = parseWorkerReviewCompletion(completion());
      expect(parsed.result.personas[0]).not.toHaveProperty('telemetry');
      expect(parsed.version).toBe('WorkerReviewCompletion.v1');
    });

    it('parses telemetry with only a subset of its fields populated', () => {
      const parsed = parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', { telemetry: { model: 'claude-5-sonnet', turnsCount: 1 } }), lane('architecture')],
        },
      }));
      expect(parsed.result.personas[0]?.telemetry).toEqual({ model: 'claude-5-sonnet', turnsCount: 1 });
    });

    it('rejects an unrecognized key on the telemetry object (still .strict())', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', { telemetry: { turnsCount: 1, notARealField: true } }), lane('architecture')],
        },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });

    it('rejects an unrecognized key on a turnUsages entry', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', {
            telemetry: { turnUsages: [{ ...turnUsage(), providerRawResponse: 'do-not-leak-this' }] },
          }), lane('architecture')],
        },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });

    it('rejects a turnUsages entry with an invalid kind', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', {
            telemetry: { turnUsages: [turnUsage({ kind: 'not-a-real-kind' })] },
          }), lane('architecture')],
        },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });

    it('rejects a negative token count inside telemetry', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', { telemetry: { promptTokens: -1 } }), lane('architecture')],
        },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });

    it('accepts exactly MAX_TURN_USAGES entries and rejects one more (dead-guard check)', () => {
      // `MAX_TURN_USAGES`'s doc comment says it exists to reject an unbounded `turnUsages` array
      // across the worker boundary. Every other fixture in this file carries at most 3 entries, so
      // without this pair, dropping `.max(MAX_TURN_USAGES)` entirely (or raising it to `Infinity`)
      // would leave the whole suite green -- a guard no test can distinguish from its own absence.
      const atLimit = Array.from({ length: MAX_TURN_USAGES }, (_, index) => turnUsage({ turn: index + 1 }));
      const parsed = parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', { telemetry: { turnUsages: atLimit } }), lane('architecture')],
        },
      }));
      expect(parsed.result.personas[0]?.telemetry?.turnUsages).toHaveLength(MAX_TURN_USAGES);

      const overLimit = Array.from({ length: MAX_TURN_USAGES + 1 }, (_, index) => turnUsage({ turn: index + 1 }));
      expect(() => parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', { telemetry: { turnUsages: overLimit } }), lane('architecture')],
        },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });
  });

  describe('optional panel wall clock (Stage 0: closes the #862 measurement gap)', () => {
    // #862 added `panelWallClockMs` to `PanelResult`, but `resultSchema` had no field for it, so
    // it never reached the completion payload. This block proves the additive fix: the field
    // parses when present, is genuinely optional (no version bump), and stays bounded.
    it('parses a result that carries panelWallClockMs', () => {
      const parsed = parseWorkerReviewCompletion(completion({
        result: { ...completion().result, panelWallClockMs: 4_200 },
      }));
      expect(parsed.result.panelWallClockMs).toBe(4_200);
    });

    it('still parses a result with no panelWallClockMs -- backward compatible, no version bump', () => {
      const parsed = parseWorkerReviewCompletion(completion());
      expect(parsed.result).not.toHaveProperty('panelWallClockMs');
    });

    it('rejects a negative panelWallClockMs', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: { ...completion().result, panelWallClockMs: -1 },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });

    it('rejects a non-integer panelWallClockMs', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: { ...completion().result, panelWallClockMs: 4_200.5 },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });
  });

  describe('optional per-persona evidenceSource (shadow-mode review engine comparison)', () => {
    // Additive-only, same contract as the telemetry block above: `personaSchema` is `.strict()`,
    // so this proves `evidenceSource` is genuinely optional (no version bump / dispatcher change
    // needed) rather than merely undocumented-but-accepted.
    it('parses a persona tagged evidenceSource: panel', () => {
      const parsed = parseWorkerReviewCompletion(completion({
        result: { ...completion().result, personas: [lane('security', { evidenceSource: 'panel' }), lane('architecture')] },
      }));
      expect(parsed.result.personas[0]?.evidenceSource).toBe('panel');
    });

    it('parses a persona tagged evidenceSource: shadow', () => {
      const parsed = parseWorkerReviewCompletion(completion({
        result: { ...completion().result, personas: [lane('security', { evidenceSource: 'shadow' }), lane('architecture')] },
      }));
      expect(parsed.result.personas[0]?.evidenceSource).toBe('shadow');
    });

    it('still parses a persona with no evidenceSource field at all -- backward compatible, no version bump', () => {
      // This is the shape every pre-shadow-mode caller (and every OTHER test in this file) sends.
      // `evidenceSource` must be optional, not merely tolerated when present.
      const parsed = parseWorkerReviewCompletion(completion());
      expect(parsed.result.personas[0]).not.toHaveProperty('evidenceSource');
      expect(parsed.version).toBe('WorkerReviewCompletion.v1');
    });

    it('rejects an evidenceSource value outside the panel/shadow enum', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: { ...completion().result, personas: [lane('security', { evidenceSource: 'composed' }), lane('architecture')] },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });
  });
});
