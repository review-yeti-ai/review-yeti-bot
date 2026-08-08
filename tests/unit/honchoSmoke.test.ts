import { describe, expect, it } from 'vitest';

describe('Honcho smoke harness', () => {
  it('proves the fixture path without exposing secrets or requiring a network', async () => {
    const { runSmoke } = await import('../../scripts/honcho-smoke.mjs');
    const result = await runSmoke({ mode: 'fixture' });
    expect(result).toMatchObject({
      mode: 'fixture',
      dopplerApi: false,
      configured: true,
      healthAvailable: true,
      eventsAccepted: 1,
      contextAvailable: true,
    });
    expect(result).not.toHaveProperty('apiKey');
  });
});
