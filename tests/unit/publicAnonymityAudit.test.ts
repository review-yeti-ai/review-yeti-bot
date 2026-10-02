import { describe, expect, it } from 'vitest';
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
  ORG, `call-${'telemetry'}`, `call_${'telemetry'}`,
  ...PRIVATE_REPOS.map((name) => `(?<![a-z0-9])${name}(?![a-z0-9])`),
].join('|'), 'giu');

const BINARY = /\.(png|db|ico|jpe?g|gif|woff2?|lock)$/iu;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8').split('\0').filter(Boolean)
    .filter((file) => !BINARY.test(file) && !file.endsWith('package-lock.json') && fs.existsSync(path.join(root, file)));
}

function countByFile(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of trackedFiles()) {
    let text: string;
    try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    const hits = text.match(FORBIDDEN)?.length ?? 0;
    // A tracked file NAME that carries a reference counts as one.
    const nameHits = file.match(FORBIDDEN)?.length ?? 0;
    if (hits + nameHits > 0) counts.set(file, hits + nameHits);
  }
  return counts;
}

// File names that carry the organization are stored with an <org> placeholder so the list stays clean.
const allowlist: Record<string, number> = Object.fromEntries(Object.entries(JSON.parse(
  fs.readFileSync(path.join(root, 'tests/fixtures/public-anonymity-allowlist.json'), 'utf8'),
) as Record<string, number>).map(([file, max]) => [file.replace('<org>', ORG), max]));

describe('public anonymity audit (whole tracked tree)', () => {
  const counts = countByFile();

  it('no tracked file outside the allowlist names the deploying organization or its private repositories', () => {
    const offenders = [...counts.entries()].filter(([file]) => !(file in allowlist)).map(([file, n]) => `${file} (${n})`);
    expect(offenders).toEqual([]);
  });

  it('allowlisted files never gain references', () => {
    const grown = Object.entries(allowlist)
      .filter(([file, max]) => (counts.get(file) ?? 0) > max)
      .map(([file, max]) => `${file}: ${counts.get(file)} > ${max}`);
    expect(grown).toEqual([]);
  });

  it('allowlist entries that no longer have references are removed (the list only shrinks)', () => {
    const stale = Object.entries(allowlist)
      .filter(([file, max]) => (counts.get(file) ?? 0) < max)
      .map(([file, max]) => `${file}: ${counts.get(file) ?? 0} < ${max} (lower the recorded count or delete the entry)`);
    expect(stale).toEqual([]);
  });

  it('the allowlist file itself and this audit contain no references', () => {
    expect(fs.readFileSync(path.join(root, 'tests/fixtures/public-anonymity-allowlist.json'), 'utf8').match(FORBIDDEN)).toBeNull();
    expect(fs.readFileSync(__filename, 'utf8').match(FORBIDDEN)).toBeNull();
  });
});
