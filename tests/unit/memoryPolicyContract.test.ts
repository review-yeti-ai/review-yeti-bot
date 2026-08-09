import { describe, expect, it } from 'vitest';

const { resolveActionReviewPolicy } = require('../../.github/workflows/pipelines/review-pipeline.js');

describe('single-provider memory policy contract', () => {
  it('rejects fan-out, unknown providers, invalid transports, and invalid secret references', () => {
    expect(() => resolveActionReviewPolicy({ parsed: { memory: { mode: 'fanout' } } }, {})).toThrow('memory.mode must be single');
    expect(() => resolveActionReviewPolicy({ parsed: { memory: { provider: 'arbitrary' } } }, {})).toThrow('memory.provider must be one of');
    expect(() => resolveActionReviewPolicy({ parsed: { memory: { transport: 'graphql' } } }, {})).toThrow('memory.transport must be one of');
    expect(() => resolveActionReviewPolicy({ parsed: { memory: { providers: { mem0: { endpoint_env: 'not-safe' } } } } }, {})).toThrow('environment variable name');
  });

  it('preserves legacy Honcho toggles while mapping them into typed domains', () => {
    const policy = resolveActionReviewPolicy({ parsed: { memory: { honcho: { enabled: true, context: true, write: true } } } }, {});
    expect(policy.memory).toMatchObject({ provider: 'honcho', mode: 'single', transport: 'rest', enabled: true, context: true, write: true });
    expect(policy.memory.recall).toMatchObject({ decision_feedback: true, session_recap: true });
    expect(policy.memory.persist).toMatchObject({ processing: true, decision_feedback: true, session_recap: true });
  });

  it('lets trusted base YAML select one native provider and prevents disabled-profile selection', () => {
    const policy = resolveActionReviewPolicy({ parsed: { memory: {
      enabled: true,
      provider: 'mem0',
      transport: 'rest',
      context: true,
      providers: { mem0: { enabled: true, credential_env: 'MEM0_API_KEY' }, honcho: { enabled: false } },
    } } }, {});
    expect(policy.memory).toMatchObject({ provider: 'mem0', mode: 'single', transport: 'rest', selectedProfile: { id: 'mem0', enabled: true, credentialEnv: 'MEM0_API_KEY' } });
    expect(() => resolveActionReviewPolicy({ parsed: { memory: { enabled: true, provider: 'mem0', providers: { mem0: { enabled: false } } } } }, {})).toThrow('memory provider mem0 is disabled');
  });

  it('suppresses all remote session recall/persist when the top-level recap switch is false', () => {
    const policy = resolveActionReviewPolicy({ parsed: { memory: {
      enabled: true,
      provider: 'mem0',
      session_recap: false,
      recall: { session_recap: true },
      persist: { session_recap: true },
    } } }, {});
    expect(policy.memory.sessionRecap).toBe(false);
    expect(policy.memory.recall.session_recap).toBe(false);
    expect(policy.memory.persist.session_recap).toBe(false);
  });
});
