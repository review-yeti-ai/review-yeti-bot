import { describe, expect, it } from 'vitest';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const profileModule = require(path.join(root, '.github/workflows/pipelines/execution-profile.js'));

const {
  EXECUTION_PROFILES,
  PROFILE_SCHEMA_VERSION,
  normalizeProfile,
  resolveExecutionProfile,
} = profileModule;

describe('canonical execution-profile contract', () => {
  it('loads exactly the three pre-approved profiles with stable digests', () => {
    expect(PROFILE_SCHEMA_VERSION).toBe(1);
    expect([...EXECUTION_PROFILES.keys()].sort()).toEqual([
      'fireworks-breakglass',
      'ollama-evaluation',
      'openrouter-primary',
    ]);

    const openrouter = resolveExecutionProfile();
    expect(openrouter).toMatchObject({
      id: 'openrouter-primary',
      transport: 'openrouter',
      base_url_class: 'openrouter-gateway',
      model: 'openrouter/auto',
      compatibility_mode: 'openrouter',
      streaming: true,
      structured_output: 'strict',
      reasoning: { effort: 'high', wire_shape: 'reasoning.effort' },
      routing: { mode: 'gateway-delegated' },
      timeouts: { connect_ms: 30000, request_ms: 90000, stall_ms: 20000, ttft_ms: 30000 },
      active: true,
    });
    expect(openrouter.profile_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(resolveExecutionProfile('openrouter-primary')).toEqual(openrouter);
  });

  it('keeps break-glass and evaluation profiles inactive and bounded', () => {
    expect(resolveExecutionProfile('fireworks-breakglass')).toMatchObject({
      transport: 'fireworks',
      base_url_class: 'direct-fireworks-openai-compatible',
      active: false,
    });
    expect(resolveExecutionProfile('ollama-evaluation')).toMatchObject({
      transport: 'ollama',
      base_url_class: 'direct-ollama-cloud-openai-compatible',
      active: false,
    });
  });

  it('rejects arbitrary JSON and unknown profile identifiers', () => {
    expect(() => resolveExecutionProfile('{"id":"fireworks-breakglass"}')).toThrow(/allowlisted|JSON/i);
    expect(() => resolveExecutionProfile('unknown-profile')).toThrow(/one of|defined/i);
  });

  it('rejects unknown fields and unsafe profile values instead of ignoring them', () => {
    const base = { ...resolveExecutionProfile('openrouter-primary') };
    delete base.profile_digest;
    expect(() => normalizeProfile({ ...base, ignored: true })).toThrow(/unknown/i);
    expect(() => normalizeProfile({ ...base, model: 'Bearer secret-value' })).toThrow(/credential-free/i);
    expect(() => normalizeProfile({ ...base, streaming: false })).toThrow(/streaming/i);
    expect(() => normalizeProfile({ ...base, timeouts: { ...base.timeouts, request_ms: 1 } })).toThrow(/request_ms/i);
  });

  it('is validation-only in this slice: profile selection does not mutate the current transport plan', () => {
    const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));
    const baseline = pipeline.resolveModelConfig({
      OPENROUTER_API_KEY: 'or-key',
      REVIEW_YETI_TRANSPORTS: JSON.stringify([{
        name: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: 'OPENROUTER_API_KEY',
        model: 'openrouter/auto',
        stream: true,
      }]),
    });
    const candidate = resolveExecutionProfile('fireworks-breakglass');

    expect(candidate.id).toBe('fireworks-breakglass');
    expect(baseline.transports).toHaveLength(1);
    expect(baseline.transports[0]).toMatchObject({
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openrouter/auto',
      stream: true,
    });
  });
});
