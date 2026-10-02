import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// REL-1282: this repository is public and independent of the organization that deploys it. No tracked
// file may name that organization or its private repositories, except the files in the allowlist, which
// are coupled to functional identifiers (module path, CRD group, default URLs, digest-pinned fixtures)
// that need a migration, not a search-and-replace. The allowlist is a ratchet:
//   - a file outside it must have zero references,
//   - a file inside it may never gain references,
//   - an entry whose references reach zero must be deleted from the allowlist.
// The terms are assembled from parts so this file does not itself contain them.
const ORG = ['call', 'telemetry'].join('');
const PRIVATE_REPOS = ['cisco-' + 'cdr', 'ct-' + 'meta', 'ct-' + 'release', 'ct-' + 'infrastructure', 'ct-' + 'quasar',
  'ct-' + 'uat', 'ct-' + 'dashboard', 'ct-' + 'lab', 'ai-' + 'workspace', 'pr-manager-' + 'mcp', 'ct-review-' + 'actions'];
const root = path.resolve(__dirname, '../..');

const FORBIDDEN = new RegExp([
  ORG, `call-${'telemetry'}`, `call_${'telemetry'}`, `call[ \\t]+${'telemetry'}`,
  ...PRIVATE_REPOS.map((name) => `(?<![a-z0-9])${name}(?![a-z0-9])`),
].join('|'), 'giu');

// Binary assets only: lockfiles are text and are scanned like everything else.
const BINARY = /\.(png|db|ico|jpe?g|gif|woff2?)$/iu;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8').split('\0').filter(Boolean)
    .filter((file) => !BINARY.test(file) && fs.existsSync(path.join(root, file)));
}

interface Finding { count: number; digest: string }

// The digest is over the sorted, lower-cased matches, so replacing one reference with another (same count)
// is still detected, without the allowlist having to contain any of the names.
function digestOf(matches: string[]): string {
  return createHash('sha256').update(matches.map((m) => m.toLowerCase()).sort().join('\n')).digest('hex').slice(0, 16);
}

function findingsByFile(): Map<string, Finding> {
  const findings = new Map<string, Finding>();
  for (const file of trackedFiles()) {
    let text: string;
    try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    // A tracked file NAME that carries a reference counts too.
    const matches = [...(text.match(FORBIDDEN) ?? []), ...(file.match(FORBIDDEN) ?? [])];
    if (matches.length > 0) findings.set(file, { count: matches.length, digest: digestOf(matches) });
  }
  return findings;
}

// File names that carry the organization are stored with an <org> placeholder so the list stays clean.
const allowlist: Record<string, Finding> = Object.fromEntries(Object.entries(JSON.parse(
  fs.readFileSync(path.join(root, 'tests/fixtures/public-anonymity-allowlist.json'), 'utf8'),
) as Record<string, Finding>).map(([file, entry]) => [file.replace('<org>', ORG), entry]));

describe('public anonymity audit (whole tracked tree)', () => {
  const found = findingsByFile();

  it('no tracked file outside the allowlist names the deploying organization or its private repositories', () => {
    const offenders = [...found.entries()].filter(([file]) => !Object.hasOwn(allowlist, file)).map(([file, f]) => `${file} (${f.count})`);
    expect(offenders).toEqual([]);
  });

  it('allowlisted files never gain references, and a swapped reference is not a pass', () => {
    const changed = Object.entries(allowlist)
      .filter(([file, entry]) => {
        const now = found.get(file);
        return now !== undefined && (now.count > entry.count || (now.count === entry.count && now.digest !== entry.digest));
      })
      .map(([file]) => file);
    expect(changed).toEqual([]);
  });

  it('allowlist entries whose references shrank or vanished are updated (the list only shrinks)', () => {
    const stale = Object.entries(allowlist)
      .filter(([file, entry]) => (found.get(file)?.count ?? 0) < entry.count)
      .map(([file, entry]) => `${file}: ${found.get(file)?.count ?? 0} < ${entry.count} (update the entry, or delete it at zero)`);
    expect(stale).toEqual([]);
  });

  it('the allowlist file itself and this audit contain no references', () => {
    expect(fs.readFileSync(path.join(root, 'tests/fixtures/public-anonymity-allowlist.json'), 'utf8').match(FORBIDDEN)).toBeNull();
    expect(fs.readFileSync(__filename, 'utf8').match(FORBIDDEN)).toBeNull();
  });
});
