import { describe, expect, it } from 'vitest';

const fixturePath = new URL('../fixtures/honcho-smoke.json', import.meta.url).pathname;

describe('Honcho smoke harness', () => {
  it('proves the fixture path without exposing secrets or requiring a network', async () => {
    const { runSmoke } = await import('../../scripts/honcho-smoke.mjs');
    const result = await runSmoke({ mode: 'fixture', fixturePath });
    expect(result).toMatchObject({
      mode: 'fixture',
      dopplerApi: false,
      configured: true,
      healthAvailable: true,
      eventsAccepted: 1,
      contextAvailable: true,
    });
    expect(result.host).toBe('honcho.fixture.test');
    expect(result.identity.prNumber).toBe(0);
    expect(result.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/health', status: 200 }),
      expect.objectContaining({ path: '/v3/workspaces', status: 200 }),
    ]));
    expect(result).not.toHaveProperty('apiKey');
  });

  it('fails a live-style smoke when any required endpoint is unavailable', async () => {
    const { runSmoke } = await import('../../scripts/honcho-smoke.mjs');
    const manager = { getSecret: async (name: string) => ({
      HONCHO_URL: 'https://honcho.fixture.test',
      HONCHO_API_KEY: 'fixture-api-key',
      HONCHO_WORKSPACE_ID: 'review-yeti-fixture',
    }[name] || null) };
    const fetchImplementation = async (url: string) => ({
      ok: !url.endsWith('/representation'),
      status: url.endsWith('/representation') ? 503 : 200,
      async text() { return JSON.stringify({}); },
    });
    await expect(runSmoke({ mode: 'live', manager, fetchImplementation })).rejects.toThrow('Honcho smoke failed');
  });
});
