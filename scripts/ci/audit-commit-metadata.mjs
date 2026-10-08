#!/usr/bin/env node
// Fails when a commit message in the given range names private deployment details. Contributor identities
// and trailing co-author credits are permitted. Terms are assembled so this file does not contain them.
// Merge commits are ignored (they are created by the hosting service).
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
    const lines = (record.body ?? '').trimEnd().split(/\r?\n/u);
    // GitHub squash merges may append contributor attribution. Exempt only
    // well-formed credits at the end, never a matching line inside prose.
    while (/^Co-authored-by:\s+[^<>\r\n]+\s+<[^<>\s]+@[^<>\s]+>$/iu.test(lines.at(-1) ?? '')) lines.pop();
    if (FORBIDDEN.test(lines.join('\n'))) findings.push({ sha: record.sha, fields: ['message'] });
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
    for (const f of findings) console.error(`::error::commit ${f.sha.slice(0, 12)} names private deployment details in its ${f.fields.join(', ')}`);
    console.error('Remove private deployment details from the commit subject or narrative body. Contributor identities are allowed.');
    process.exit(1);
  }
  console.log(`commit metadata clean for ${range}`);
}
