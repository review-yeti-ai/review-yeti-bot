import { describe, it, expect, vi } from 'vitest';
import { repositoryVisibilityFrom } from '../../src/review/repositoryVisibility';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { checkSummary } from '../../src/app';

describe('repositoryVisibilityFrom — string/boolean boundary', () => {
  it('an unrecognised visibility string does not short-circuit a definite private boolean', () => {
    // { private: true, visibility: '<new value>' } is PRIVATE, not UNKNOWN. The
    // distinction changes how a persona is told to rate internal material.
    expect(repositoryVisibilityFrom({ private: true, visibility: 'some-new-github-value' })).toBe('PRIVATE');
    expect(repositoryVisibilityFrom({ private: false, visibility: 'some-new-github-value' })).toBe('PUBLIC');
  });
  it('prefers a recognised string, then the boolean, then UNKNOWN', () => {
    expect(repositoryVisibilityFrom({ visibility: 'internal', private: false })).toBe('PRIVATE');
    expect(repositoryVisibilityFrom({ private: true })).toBe('PRIVATE');
    expect(repositoryVisibilityFrom({})).toBe('UNKNOWN');
    expect(repositoryVisibilityFrom(null)).toBe('UNKNOWN');
  });
});

describe('GitHubInstallationClient.getRepositoryVisibility — path encoding', () => {
  it('encodes owner and repo so payload-influenced names cannot redirect the request', async () => {
    const client = Object.create(GitHubInstallationClient.prototype) as any;
    client.repositoryVisibilityCache = new Map();
    client.request = vi.fn(async () => ({ private: true }));
    await client.getRepositoryVisibility('own/er', 'repo?x=1#f');
    expect(client.request).toHaveBeenCalledWith('/repos/own%2Fer/repo%3Fx%3D1%23f');
  });
});

describe('checkSummary — visibility line', () => {
  const base = (): any => ({
    headSha: 'deadbeef',
    personas: [],
    optionalFailures: [],
    moderator: { providerId: 'p', model: 'm', decision: 'RECONCILED', findings: [], usage: null, costUSD: null },
    arbiter: { providerId: 'p', model: 'm', verdict: 'SHIP', rationale: '', usage: null, costUSD: null },
    quorum: { required: 1, distinctProviders: ['p'], satisfied: true },
    totalUsage: { prompt: 0, completion: 0, total: 0 },
    totalCostUSD: null,
  });
  it('renders the visibility it was given', () => {
    expect(checkSummary({ ...base(), repositoryVisibility: 'PRIVATE' })).toContain('Repository visibility: PRIVATE');
  });
  it('renders UNKNOWN, never "undefined", when the result lacks the field', () => {
    const out = checkSummary(base());
    expect(out).toContain('Repository visibility: UNKNOWN');
    expect(out).not.toContain('undefined');
  });
});
