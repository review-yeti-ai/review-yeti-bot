import { describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const { PERSONA_CHARTERS, reviewWithModel, RunTransportCircuitBreaker } = pipeline;
const securityPersona = PERSONA_CHARTERS.find((persona: any) => persona.id === 'security');
const diffFiles = [{
  path: 'src/example.ts',
  patch: 'diff --git a/src/example.ts b/src/example.ts\n+const value = 1;\n',
  addedLines: [{ text: 'const value = 1;' }],
  deletedLines: [],
}];

function responseFor(payload: any, options: { ok?: boolean; status?: number } = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    text: async () => JSON.stringify(payload),
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
      ...payload,
    }),
  };
}

async function reviewPayload(payload: any, responseOptions: { ok?: boolean; status?: number } = {}) {
  return reviewWithModel(
    securityPersona,
    diffFiles,
    { repo: 'o/r', prNumber: 1 },
    null,
    {
      fetchImplementation: async () => responseFor(payload, responseOptions),
      circuitBreaker: new RunTransportCircuitBreaker(),
      transports: [{
        name: 'fireworks',
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        apiKey: 'fw-key',
        model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
      }],
    },
  );
}

describe('provider identity receipt characterization', () => {
  it('uses the configured direct transport when the provider omits provider metadata', async () => {
    const result = await reviewPayload({ model: 'accounts/fireworks/models/deepseek-v4-flash-0731' });

    expect(result.decision).toBe('APPROVE');
    expect(result.transport).toBe('fireworks');
    expect(result.provider).toBe('fireworks');
  });

  it('uses usage.provider when the upstream response reports its serving provider', async () => {
    const result = await reviewPayload({
      model: 'openrouter/auto',
      usage: { provider: 'Google Vertex AI' },
    });

    expect(result.decision).toBe('APPROVE');
    expect(result.transport).toBe('fireworks');
    expect(result.provider).toBe('Google Vertex AI');
  });

  it('keeps the configured direct transport on an HTTP failure receipt', async () => {
    const result = await reviewPayload({ error: { message: 'upstream unavailable' } }, { ok: false, status: 503 });

    expect(result.decision).toBe('ERROR');
    expect(result.transport).toBe('fireworks');
    expect(result.provider).toBe('fireworks');
  });

  it('retains endpoint-derived OpenRouter identity for the default OpenRouter transport', async () => {
    const result = await reviewWithModel(
      securityPersona,
      diffFiles,
      { repo: 'o/r', prNumber: 1 },
      null,
      {
        apiKey: 'or-key',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openrouter/auto',
        fetchImplementation: async () => responseFor({ model: 'openrouter/auto' }),
        circuitBreaker: new RunTransportCircuitBreaker(),
      },
    );

    expect(result.decision).toBe('APPROVE');
    expect(result.transport).toBe('default');
    expect(result.provider).toBe('openrouter');
  });
});
