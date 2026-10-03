#!/usr/bin/env node
// Fails when a commit in the given range names the deploying organization or its private repositories in the
// author or committer identity, or in the commit message. The terms are assembled from parts so this file does
// not itself contain them. Merge commits are ignored (they are created by the hosting service).
//
// usage: node scripts/ci/audit-commit-metadata.mjs <base>..<head>
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ORG = ['call', 'telemetry'].join('');
const PRIVATE_REPOS = ['cisco-' + 'cdr', 'ct-' + 'meta', 'ct-' + 'release', 'ct-' + 'infrastructure', 'ct-' + 'quasar',
  'ct-' + 'uat', 'ct-' + 'dashboard', 'ct-' + 'lab', 'ai-' + 'workspace', 'pr-manager-' + 'mcp', 'ct-review-' + 'actions'];

/** Single source of the forbidden-term policy; the whole-tree audit test builds its regex from this too. */
export const FORBIDDEN_PATTERN = [
  ORG, `call-${'telemetry'}`, `call_${'telemetry'}`, `call[ \\t]+${'telemetry'}`,
  ...PRIVATE_REPOS.map((name) => `(?<![a-z0-9])${name.split('-').join('[-_ ]')}(?![a-z0-9])`),
].join('|');
export const FORBIDDEN = new RegExp(FORBIDDEN_PATTERN, 'iu');

/** Returns one finding per offending commit. `records` are {sha, an, ae, cn, ce, body}. */
export function findViolations(records) {
  const findings = [];
  for (const record of records) {
    const fields = { author: `${record.an} <${record.ae}>`, committer: `${record.cn} <${record.ce}>`, message: record.body };
    const bad = Object.entries(fields).filter(([, value]) => FORBIDDEN.test(value)).map(([key]) => key);
    if (bad.length > 0) findings.push({ sha: record.sha, fields: bad });
  }
  return findings;
}

export function readRange(range, cwd = process.cwd()) {
  const sep = '\u001e';
  const raw = execFileSync('git', ['log', '--no-merges', `--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B${sep}`, range],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return raw.split(sep).map((chunk) => chunk.replace(/^\n/u, '')).filter((chunk) => chunk.trim() !== '').map((chunk) => {
    const [sha, an, ae, cn, ce, body] = chunk.split('\u001f');
    return { sha, an, ae, cn, ce, body: body ?? '' };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const range = process.argv[2];
  if (!range) {
    console.error('usage: audit-commit-metadata.mjs <base>..<head>');
    process.exit(2);
  }
  const findings = findViolations(readRange(range));
  if (findings.length > 0) {
    for (const f of findings) console.error(`::error::commit ${f.sha.slice(0, 12)} names the deploying organization in its ${f.fields.join(', ')}`);
    console.error('Set a neutral identity before committing: scripts/use-neutral-git-identity.sh');
    process.exit(1);
  }
  console.log(`commit metadata clean for ${range}`);
}
