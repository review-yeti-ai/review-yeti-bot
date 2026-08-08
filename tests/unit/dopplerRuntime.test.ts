import { describe, expect, it, vi } from 'vitest';

const { DopplerSecretManager } = require('../../src/mcp/dopplerSecretManager.js');

describe('runtime Doppler secret manager', () => {
  it('resolves secrets through the Doppler REST API without exposing the token', async () => {
    const fetchImplementation = vi.fn(async () => ({
      ok: true,
      json: async () => ({ value: { raw: 'honcho-secret' } }),
    }));
    const manager = new DopplerSecretManager({
      project: 'review-yeti-bot',
      config: 'dev',
      dopplerToken: 'doppler-secret',
      fallbackEnv: false,
      fetchImplementation,
    });
    await expect(manager.getSecret('HONCHO_API_KEY')).resolves.toBe('honcho-secret');
    expect(fetchImplementation).toHaveBeenCalledWith(
      expect.stringContaining('project=review-yeti-bot&config=dev&name=HONCHO_API_KEY'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer doppler-secret' }) }),
    );
  });
});
