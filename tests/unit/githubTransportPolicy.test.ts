import { describe, expect, it } from 'vitest';
import {
  GITHUB_INSTALLATION_TOKEN_MAX_LENGTH,
  isGitHubInstallationToken,
} from '../../src/github/githubTransportPolicy';

describe('GitHub installation token policy', () => {
  it('accepts legacy and current installation-token formats', () => {
    expect(isGitHubInstallationToken('ghs_legacy_token')).toBe(true);
    expect(isGitHubInstallationToken('ghs_modern-header.payload_segment.signature-with-dash')).toBe(true);
  });

  it('pins the maximum accepted token length', () => {
    const exact = `ghs_${'a'.repeat(GITHUB_INSTALLATION_TOKEN_MAX_LENGTH - 8)}.b.c`;
    const over = `ghs_${'a'.repeat(GITHUB_INSTALLATION_TOKEN_MAX_LENGTH - 7)}.b.c`;
    expect(exact).toHaveLength(GITHUB_INSTALLATION_TOKEN_MAX_LENGTH);
    expect(over).toHaveLength(GITHUB_INSTALLATION_TOKEN_MAX_LENGTH + 1);
    expect(isGitHubInstallationToken(exact)).toBe(true);
    expect(isGitHubInstallationToken(over)).toBe(false);
  });

  it.each([
    '', 'ghs_', 'ghp_personal', 'ghs_bad token', 'ghs_one.two',
    'ghs_one.two.three.four', 'ghs_one.two.bad/slash', 'ghs_tést',
  ])('rejects malformed or non-installation credential %j', (token) => {
    expect(isGitHubInstallationToken(token)).toBe(false);
  });
});
