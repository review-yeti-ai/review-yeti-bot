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

function responseFor(payload: any) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
      ...payload,
    }),
  };
}

async function reviewPayload(payload: any) {
  return reviewWithModel(
    securityPersona,
    diffFiles,
    { repo: 'o/r', prNumber: 1 },
    null,
    {
      fetchImplementation: async () => responseFor(payload),
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
  it('preserves the current openrouter fallback when a direct provider omits provider metadata', async () => {
    // This test records the existing behavior only. It intentionally does not
    // change transport selection or repair the known receipt attribution gap.
    const result = await reviewPayload({ model: 'accounts/fireworks/models/deepseek-v4-flash-0731' });

    expect(result.decision).toBe('APPROVE');
    expect(result.transport).toBe('fireworks');
    expect(result.provider).toBe('openrouter');
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
});
