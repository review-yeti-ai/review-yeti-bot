import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

/** Pull a shell snippet out of a real script so the test exercises shipped code. */
function extract(file: string, startsWith: string, endsWith: string): string {
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith(startsWith));
  if (start < 0) throw new Error(`${file}: no line starting with ${JSON.stringify(startsWith)}`);
  const end = lines.findIndex((l, i) => i >= start && l.trim().startsWith(endsWith));
  if (end < 0) throw new Error(`${file}: no terminator ${JSON.stringify(endsWith)} after line ${start + 1}`);
  return lines.slice(start, end + 1).join('\n');
}

function runBash(script: string): string {
  return execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8' });
}

describe('advance-review-worker.sh lower()', () => {
  const lower = extract('scripts/advance-review-worker.sh', 'lower()', '}');

  it('was actually extracted from the shipped script', () => {
    expect(lower).toContain('tr ');
  });

  it('lowercases a mixed-case SHA', () => {
    // is_full_sha accepts [0-9a-fA-F], so an uppercase SHA reaches lower(). GHCR
    // manifest lookups and the old-vs-new digest comparison are byte comparisons,
    // so a helper that upper-cased, or emitted nothing, would silently produce a
    // wrong or empty pin while every static check still passed.
    const sha = '0344E47EF2263F1CEC64E2FCFE6048EBFC766EA9';
    const out = runBash(`${lower}\nlower "${sha}"`);
    expect(out).toBe(sha.toLowerCase());
  });

  it('leaves an already-lowercase SHA byte-identical', () => {
    const sha = '0344e47ef2263f1cec64e2fcfe6048ebfc766ea9';
    expect(runBash(`${lower}\nlower "${sha}"`)).toBe(sha);
  });

  it('emits no trailing newline that would corrupt an interpolated digest', () => {
    expect(runBash(`${lower}\nlower "ABC"`)).toBe('abc');
  });
});

describe('fetch-pr-diff.sh scope_paths collection', () => {
  const loop = extract('scripts/fetch-pr-diff.sh', 'scope_paths=()', 'done <');

  function collect(fileBody: string): string[] {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-paths-'));
    const work = path.join(dir, 'touched-files.txt');
    fs.writeFileSync(work, fileBody);
    const body = loop.replace('"${work_dir}/touched-files.txt"', `"${work}"`);
    const out = runBash(`set -euo pipefail\nwork_dir="${dir}"\n${body}\nprintf '%s\\n' "\${#scope_paths[@]}"\nfor p in \${scope_paths[@]+"\${scope_paths[@]}"}; do printf '%s\\n' "$p"; done`);
    const lines = out.split('\n').filter((l) => l !== '');
    return lines.slice(1);
  }

  it('was actually extracted from the shipped script', () => {
    expect(loop).toContain('read -r scope_path');
  });

  it('collects every path when the file ends with a newline', () => {
    expect(collect('a.txt\nb.txt\nc.txt\n')).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('keeps the final path when the file has NO trailing newline', () => {
    // git and several writers omit the trailing newline. `mapfile` kept that last
    // entry; a bare `while read` drops it, which silently shrinks the review's
    // diff scope by one file rather than failing.
    expect(collect('a.txt\nb.txt\nc.txt')).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('yields an empty array for an empty file, so the caller takes the full-diff branch', () => {
    // bash 3.2 errors on "${arr[@]}" for an empty array under `set -u`, so the
    // caller must branch on the count rather than expand it.
    expect(collect('')).toEqual([]);
  });

  it('skips blank lines rather than emitting an empty pathspec', () => {
    expect(collect('a.txt\n\nb.txt\n')).toEqual(['a.txt', 'b.txt']);
  });
});
