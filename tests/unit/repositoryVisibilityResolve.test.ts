import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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

describe('runReviewPipeline wiring', () => {
  // runReviewPipeline has no unit harness (it boots the installation client,
  // durable store and config), so the wiring is pinned at the source level: the
  // resolved value, not the raw payload field, must be what the panel receives.
  it('passes the resolved visibility into executePersonaPanel', () => {
    const app = readFileSync(new URL('../../src/app.ts', import.meta.url), 'utf8');
    const call = app.slice(app.indexOf('executePersonaPanel({'), app.indexOf('}), config.reviewers.overall_timeout_s)'));
    // Structural, not token-level: the call must name the field, and it must not be
    // fed the raw payload value. Identifier spelling and formatting are free to change.
    expect(call).toMatch(/repositoryVisibility\b/u);
    expect(call).not.toMatch(/payload\.repositoryVisibility/u);
    expect(app).toMatch(/resolveRepositoryVisibility\(\s*payload\.repositoryVisibility/u);
  });
});
