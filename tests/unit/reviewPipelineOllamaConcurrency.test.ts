import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const persona = pipeline.PERSONA_CHARTERS.find((entry: any) => entry.id === 'testing');
const diffFiles = [{
  path: 'src/example.ts',
  patch: '@@ -0,0 +1 @@\n+export const value = 1;\n',
  addedLines: [{ text: 'export const value = 1;' }],
  deletedLines: [],
}];

function response() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '{"findings":[]}' } }] }),
  };
}

function delayedFetch(delayMs: number) {
  let active = 0;
  let peak = 0;
  const impl = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    active -= 1;
    return response();
  };
  return { impl, peak: () => peak };
}

async function runReviews(count: number, transport: any, fetchImpl: any) {
  return Promise.all(Array.from({ length: count }, (_unused, index) => pipeline.reviewWithModel(
    persona,
    diffFiles,
    { repo: 'fixture/repository', prNumber: String(index + 1) },
    null,
    {
      transports: [transport],
      fetchImpl,
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
    },
  )));
}

describe('Ollama request concurrency', () => {
  it('bounds capacity wait time and remains usable after a timed-out waiter', async () => {
    const semaphore = new pipeline.AsyncSemaphore(1);
    const release = await semaphore.acquire(100);
    await expect(semaphore.acquire(5)).rejects.toThrow('ollama_capacity_wait_timeout');
    release();
    const releaseAfterTimeout = await semaphore.acquire(100);
    releaseAfterTimeout();
  });

  it('caps direct Ollama requests below the measured cloud burst boundary', async () => {
    const fetch = delayedFetch(15);
    const results = await runReviews(20, {
      name: 'ollama',
      baseUrl: 'https://ollama.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash:cloud',
      stream: false,
    }, fetch.impl);

    expect(results.every((result: any) => result.decision === 'APPROVE')).toBe(true);
    expect(fetch.peak()).toBe(pipeline.OLLAMA_MAX_IN_FLIGHT_REQUESTS);
    expect(fetch.peak()).toBe(16);
  });

  it('does not apply the Ollama ceiling to unrelated transports', async () => {
    const fetch = delayedFetch(15);
    const results = await runReviews(20, {
      name: 'synthetic',
      baseUrl: 'https://model.example/v1',
      apiKey: 'test-key',
      model: 'synthetic-reviewer',
      stream: false,
    }, fetch.impl);

    expect(results.every((result: any) => result.decision === 'APPROVE')).toBe(true);
    expect(fetch.peak()).toBe(20);
  });

  it('releases Ollama capacity after request failures', async () => {
    const transport = {
      name: 'ollama',
      baseUrl: 'https://ollama.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash:cloud',
      stream: false,
    };
    const failed = await runReviews(20, transport, async () => {
      throw new Error('terminal provider failure');
    });
    expect(failed.every((result: any) => result.decision === 'ERROR')).toBe(true);

    const recovered = await runReviews(1, transport, async () => response());
    expect(recovered[0].decision).toBe('APPROVE');
  });
});
