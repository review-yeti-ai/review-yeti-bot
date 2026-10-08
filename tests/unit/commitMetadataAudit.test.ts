import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findViolations, readRange, ORG } from '../../scripts/ci/audit-commit-metadata.mjs';

const clean = { sha: 'a'.repeat(40), an: 'Review Yeti Maintainers', ae: 'maintainers@users.noreply.github.com',
  cn: 'GitHub', ce: 'noreply@github.com', body: 'fix: something neutral\n' };

describe('commit metadata audit', () => {
  it('accepts a neutral identity and message', () => {
    expect(findViolations([clean])).toEqual([]);
  });

  it.each([
    ['author name', { an: `${ORG} bot` }],
    ['author email', { ae: `ops@${ORG}.com` }],
    ['committer email', { ce: `x@users.noreply.github.com+${ORG}-jason` }],
    ['spaced name', { an: ['Call', 'Telemetry'].join(' ') }],
  ])('accepts contributor identity in the %s', (_label, override) => {
    expect(findViolations([{ ...clean, ...override }])).toEqual([]);
  });

  it('still rejects a private repository reference in the message', () => {
    const findings = findViolations([{ ...clean, body: `fix: touches ${['cisco', 'cdr'].join('-')}\n` }]);
    expect(findings).toHaveLength(1);
    expect(findings[0].fields).toEqual(['message']);
  });

  it('accepts contributor identity in a trailing co-author credit', () => {
    expect(findViolations([{ ...clean, body: `fix: public behavior\n\nCo-authored-by: ${ORG} Bot <bot@${ORG}.example>\n` }])).toEqual([]);
  });

  it('does not exempt a co-author-shaped line inside the message body', () => {
    expect(findViolations([{ ...clean, body: `Co-authored-by: ${ORG} Bot <bot@${ORG}.example>\n\nAdditional body text\n` }])).toHaveLength(1);
  });
});

describe('commit metadata audit against a real git range', () => {
  function git(cwd: string, args: string[], env: Record<string, string> = {}) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', ...env } }).trim();
  }

  it('parses multi-line messages and identities from git log and flags only the offending commits', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-audit-'));
    try {
      git(dir, ['init', '-q', '-b', 'main']);
      const commit = (message: string, name: string, email: string) => {
        fs.writeFileSync(path.join(dir, 'f.txt'), `${Math.random()}`);
        git(dir, ['add', '-A']);
        git(dir, ['commit', '-q', '-m', message],
          { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
        return git(dir, ['rev-parse', 'HEAD']);
      };
      const base = commit('chore: base', 'Review Yeti Maintainers', 'maintainers@users.noreply.github.com');
      const good = commit('fix: one\n\nbody line two\nCo-authored-by: Someone <someone@example.com>', 'Review Yeti Maintainers', 'maintainers@users.noreply.github.com');
      const bad = commit(`feat: two\n\nmentions ${['cisco', 'cdr'].join('-')} in the body`, 'Review Yeti Maintainers', 'maintainers@users.noreply.github.com');
      const affiliatedAuthor = commit('docs: three', `${ORG} Bot`, `bot@${ORG}.example`);

      const records = readRange(`${base}..HEAD`, dir);
      expect(records.map((r: { sha: string }) => r.sha)).toEqual([affiliatedAuthor, bad, good]);
      expect(records[2].body).toContain('body line two');
      const findings = findViolations(records);
      expect(findings.map((f: { sha: string }) => f.sha)).toEqual([bad]);
      expect(findings[0].fields).toEqual(['message']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
