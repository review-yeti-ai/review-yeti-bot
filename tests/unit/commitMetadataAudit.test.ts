import { describe, expect, it } from 'vitest';
import { findViolations } from '../../scripts/ci/audit-commit-metadata.mjs';

const ORG = ['call', 'telemetry'].join('');
const clean = { sha: 'a'.repeat(40), an: 'Review Yeti Maintainers', ae: 'maintainers@users.noreply.github.com',
  cn: 'GitHub', ce: 'noreply@github.com', body: 'fix: something neutral\n' };

describe('commit metadata audit', () => {
  it('accepts a neutral identity and message', () => {
    expect(findViolations([clean])).toEqual([]);
  });

  it.each([
    ['author name', { an: `${ORG} bot` }, 'author'],
    ['author email', { ae: `ops@${ORG}.com` }, 'author'],
    ['committer email', { ce: `x@users.noreply.github.com+${ORG}-jason` }, 'committer'],
    ['message', { body: `fix: touches ${['cisco', 'cdr'].join('-')}\n` }, 'message'],
    ['spaced name', { an: ['Call', 'Telemetry'].join(' ') }, 'author'],
  ])('rejects an organization reference in the %s', (_label, override, field) => {
    const findings = findViolations([{ ...clean, ...override }]);
    expect(findings).toHaveLength(1);
    expect(findings[0].fields).toContain(field);
  });
});
