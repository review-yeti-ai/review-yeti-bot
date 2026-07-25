import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DopplerSecretManager } from '../../src/mcp/dopplerSecretManager';

vi.mock('node:child_process', () => {
  return {
    execFile: vi.fn((file: string, args: string[], options: any, callback: any) => {
      const cb = typeof options === 'function' ? options : callback;
      if (args && args.includes('--version')) {
        return cb(null, { stdout: 'doppler v3.60.0\n', stderr: '' });
      }
      if (args && args.includes('CLI_TEST_SECRET')) {
        return cb(null, { stdout: 'cli_resolved_secret_val\n', stderr: '' });
      }
      return cb(new Error('Command failed'), { stdout: '', stderr: 'Secret not found' });
    }),
  };
});

describe('DopplerSecretManager', () => {
  let doppler: DopplerSecretManager;
  const originalEnv = process.env.CONTEXT7_API_KEY;

  beforeEach(() => {
    delete process.env.CONTEXT7_API_KEY;
    delete process.env.CLI_TEST_SECRET;
    delete process.env.API_TEST_SECRET;
    vi.restoreAllMocks();
    doppler = new DopplerSecretManager({
      project: 'test-project',
      config: 'dev',
      cacheTtlMs: 1000,
    });
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.CONTEXT7_API_KEY = originalEnv;
    } else {
      delete process.env.CONTEXT7_API_KEY;
    }
    delete process.env.CLI_TEST_SECRET;
    delete process.env.API_TEST_SECRET;
    vi.unstubAllGlobals();
  });

  it('Tier 1: resolves secret from process.env if present', async () => {
    process.env.CONTEXT7_API_KEY = 'env_secret_12345';

    const secret = await doppler.getSecret('CONTEXT7_API_KEY');
    expect(secret).toBe('env_secret_12345');
  });

  it('Tier 2: returns cached secret when available', async () => {
    process.env.CONTEXT7_API_KEY = 'cached_val_888';
    await doppler.getSecret('CONTEXT7_API_KEY');

    delete process.env.CONTEXT7_API_KEY;

    const cachedSecret = doppler.getCachedSecret('CONTEXT7_API_KEY');
    expect(cachedSecret).toBe('cached_val_888');
  });

  it('Tier 3: resolves secret via Doppler CLI execution', async () => {
    const mgr = new DopplerSecretManager({
      fallbackEnv: false,
      cliPath: 'doppler',
    });

    const secret = await mgr.getSecret('CLI_TEST_SECRET');
    expect(secret).toBe('cli_resolved_secret_val');
  });

  it('Tier 4: resolves secret via Doppler REST API when CLI fails and dopplerToken is provided', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('API_TEST_SECRET')) {
        return {
          ok: true,
          json: async () => ({ value: { computed: 'api_resolved_secret_val' } }),
        };
      }
      return { ok: false };
    });
    vi.stubGlobal('fetch', fetchMock);

    const mgr = new DopplerSecretManager({
      fallbackEnv: false,
      dopplerToken: 'dp.pt.mocktoken12345',
    });

    const secret = await mgr.getSecret('API_TEST_SECRET');
    expect(secret).toBe('api_resolved_secret_val');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('checks isDopplerAvailable correctly', async () => {
    const mgr = new DopplerSecretManager({ cliPath: 'doppler' });
    const available = await mgr.isDopplerAvailable();
    expect(available).toBe(true);
  });

  it('clears in-memory secret cache', async () => {
    process.env.CONTEXT7_API_KEY = 'cached_val_888';
    await doppler.getSecret('CONTEXT7_API_KEY');
    expect(doppler.getCachedSecret('CONTEXT7_API_KEY')).toBe('cached_val_888');

    doppler.clearCache();
    expect(doppler.getCachedSecret('CONTEXT7_API_KEY')).toBeUndefined();
  });

  it('returns null gracefully when secret is completely unresolvable', async () => {
    const secret = await doppler.getSecret('NON_EXISTENT_SECRET_KEY_XYZ');
    expect(secret).toBeNull();
  });

  it('resolves multiple secrets in parallel', async () => {
    process.env.SECRET_A = 'val_a';
    process.env.SECRET_B = 'val_b';

    const res = await doppler.getSecrets(['SECRET_A', 'SECRET_B', 'SECRET_C']);
    expect(res.SECRET_A).toBe('val_a');
    expect(res.SECRET_B).toBe('val_b');
    expect(res.SECRET_C).toBeNull();

    delete process.env.SECRET_A;
    delete process.env.SECRET_B;
  });
});
