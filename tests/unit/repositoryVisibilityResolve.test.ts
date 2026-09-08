import { describe, it, expect, vi } from 'vitest';
import { resolveRepositoryVisibility } from '../../src/github/repositoryVisibility';

describe('resolveRepositoryVisibility — the pipeline fallback', () => {
  it('trusts a definite payload value and does not look up', async () => {
    const lookup = vi.fn(async () => 'PUBLIC' as const);
    expect(await resolveRepositoryVisibility('PRIVATE', { lookup })).toBe('PRIVATE');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('looks up when the payload is absent or UNKNOWN', async () => {
    const lookup = vi.fn(async () => 'PRIVATE' as const);
    expect(await resolveRepositoryVisibility(undefined, { lookup })).toBe('PRIVATE');
    expect(await resolveRepositoryVisibility('UNKNOWN', { lookup })).toBe('PRIVATE');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('settles to UNKNOWN and warns when the lookup throws — it must never block the review', async () => {
    const warn = vi.fn();
    const out = await resolveRepositoryVisibility(undefined, { lookup: async () => { throw new Error('repos 502'); }, warn });
    expect(out).toBe('UNKNOWN');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1].error)).toContain('repos 502');
  });

  it('normalises whatever the lookup returns', async () => {
    expect(await resolveRepositoryVisibility(undefined, { lookup: async () => 'garbage' as any })).toBe('UNKNOWN');
  });
});
