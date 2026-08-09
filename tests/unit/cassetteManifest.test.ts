import { describe, expect, it } from 'vitest';
import { assertCassetteSafe } from '../support/cassetteManifest';

describe('cassette manifest contract', () => {
  const manifest = {
    version: 2 as const,
    fixtureId: 'fresh-clean',
    provider: 'honcho',
    allowedOrigins: ['https://honcho.test'],
    interactions: [],
  };

  it('accepts a path-safe, origin-scoped manifest', () => {
    expect(() => assertCassetteSafe(manifest)).not.toThrow();
  });

  it('rejects unsafe fixture identifiers, origins, and unredacted credentials', () => {
    expect(() => assertCassetteSafe({ ...manifest, fixtureId: '../escape' })).toThrow('path-safe');
    expect(() => assertCassetteSafe({ ...manifest, allowedOrigins: ['https://honcho.test/path'] })).toThrow('not an origin');
    expect(() => assertCassetteSafe({
      ...manifest,
      interactions: [{
        request: { method: 'GET', url: 'https://honcho.test/health', headers: { authorization: 'secret' }, body: null },
        response: { status: 200, headers: {}, body: null },
      }],
    })).toThrow('not redacted');
  });
});
