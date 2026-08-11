import { describe, expect, it } from 'vitest';
import {
  EVALUATION_SCHEMA_VERSION,
  createEvaluationReceipt,
  createEvaluationRequest,
  normalizeEvaluationStatus,
  normalizeUsage,
} from '../../src/evaluation/evaluationContracts.js';

const identity = {
  repository: 'review-yeti-ai/review-yeti-bot',
  sourceSha: 'a'.repeat(40),
  fixtureId: 'offline-review-intelligence',
  fixtureDigest: 'b'.repeat(64),
};

describe('evaluation contracts', () => {
  it('creates a bounded offline request by default', () => {
    const request = createEvaluationRequest({ ...identity, repetitions: 99, concurrency: 0 });
    expect(request.schemaVersion).toBe(EVALUATION_SCHEMA_VERSION);
    expect(request.mode).toBe('offline');
    expect(request.repetitions).toBe(10);
    expect(request.concurrency).toBe(1);
  });

  it('requires immutable fixture identity and source sha', () => {
    expect(() => createEvaluationRequest({ ...identity, sourceSha: '' })).toThrow('sourceSha is required');
    expect(() => createEvaluationRequest({ ...identity, fixtureDigest: 'not-a-digest' })).toThrow('fixtureDigest is required');
  });

  it('normalizes statuses without treating unknown values as pass', () => {
    expect(normalizeEvaluationStatus('SHIP')).toBe('PASS');
    expect(normalizeEvaluationStatus('BLOCK')).toBe('BLOCKED');
    expect(normalizeEvaluationStatus('provider outage')).toBe('INCONCLUSIVE');
  });

  it('normalizes usage and preserves missing cost as null', () => {
    expect(normalizeUsage({ promptTokens: 4, completionTokens: 3 })).toEqual({
      promptTokens: 4,
      completionTokens: 3,
      totalTokens: 7,
      costUSD: null,
    });
  });

  it('creates a receipt with redacted-safe provider metadata and scenario status', () => {
    const receipt = createEvaluationReceipt({
      request: { ...identity, mode: 'offline' },
      status: 'PASS',
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash-0731',
      scenarioResults: [{ id: 'one', status: 'pass', usage: { promptTokens: 1, completionTokens: 2 } }],
    });
    expect(receipt.schemaVersion).toBe(EVALUATION_SCHEMA_VERSION);
    expect(receipt.status).toBe('PASS');
    expect(receipt.provider).toBe('openrouter');
    expect(receipt.scenarioResults[0].status).toBe('PASS');
    expect(JSON.stringify(receipt)).not.toMatch(/(?:sk-|bearer\s+|api[_-]?key\s*[:=])/iu);
  });
});
