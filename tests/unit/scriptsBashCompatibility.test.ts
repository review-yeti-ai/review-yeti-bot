import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const scriptsDirectory = path.join(root, 'scripts');

function shellScripts(): string[] {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.sh') ? [full] : [];
    });
  return walk(scriptsDirectory);
}

/**
 * macOS ships bash 3.2 as /bin/bash, and `#!/usr/bin/env bash` resolves to it
 * whenever /usr/bin precedes a newer bash on PATH -- the default. CI runs Ubuntu
 * with bash 5, so a bash 4+ construct passes every check and then fails only on
 * the workstation an operator actually runs the script from.
 *
 * That is not hypothetical: `${input,,}` made advance-review-worker.sh -- the
 * only sanctioned path to advance the production worker digest under ADR 0557 --
 * exit 1 during argument parsing on macOS, so the mandated deploy path had never
 * worked there. The repository already documented the rule ("bash 3.2-safe: NO
 * mapfile, NO declare -A" in publish-real-diff-review.ts); it just had no gate.
 */
const BASH4_CONSTRUCTS: Array<{ name: string; pattern: RegExp; why: string }> = [
  {
    name: 'case conversion ${var,,} / ${var^^}',
    pattern: /\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?(,,|\^\^|,|\^)\}/,
    why: 'use `tr "[:upper:]" "[:lower:]"`',
  },
  {
    name: 'mapfile / readarray',
    pattern: /(^|[^A-Za-z0-9_-])(mapfile|readarray)\s/,
    why: 'use `while IFS= read -r line; do ... done < file`',
  },
  {
    name: 'associative arrays',
    pattern: /(declare|local)\s+-[A-Za-z]*A[A-Za-z]*\s/,
    why: 'bash 3.2 has no associative arrays',
  },
  { name: '&>> redirect', pattern: /&>>/, why: 'use `>>file 2>&1`' },
  { name: ';;& case fallthrough', pattern: /;;&/, why: 'bash 4 only' },
  { name: 'coproc', pattern: /(^|[^A-Za-z0-9_-])coproc\s/, why: 'bash 4 only' },
  { name: 'negative string index ${v: -n}', pattern: /\$\{[A-Za-z_][A-Za-z0-9_]*:\s-[0-9]/, why: 'bash 4.2+' },
];

describe('scripts/ must run on bash 3.2 (macOS /bin/bash)', () => {
  const scripts = shellScripts();

  it('finds shell scripts to check', () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it('uses no bash 4+ constructs', () => {
    const violations: string[] = [];
    for (const file of scripts) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (line.trimStart().startsWith('#')) return; // comments may name the construct
        for (const { name, pattern, why } of BASH4_CONSTRUCTS) {
          if (pattern.test(line)) {
            violations.push(
              `${path.relative(root, file)}:${index + 1} uses ${name} -- ${why}\n    ${line.trim()}`,
            );
          }
        }
      });
    }
    expect(violations, `bash 4+ constructs found:\n  ${violations.join('\n  ')}`).toEqual([]);
  });

  const bashVersion = (() => {
    if (!fs.existsSync('/bin/bash')) return null;
    try {
      return execFileSync('/bin/bash', ['-c', 'echo $BASH_VERSION'], { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  })();
  const haveBash3 = Boolean(bashVersion && bashVersion.startsWith('3.'));

  // Reported as SKIPPED rather than silently returning: on Ubuntu CI /bin/bash is
  // bash 5, which accepts every bash 4 construct, so running `bash -n` there would
  // assert nothing while looking green. The regex scan above is the portable gate
  // that does run everywhere; this is the stronger check, and it only means
  // something on a host that actually has bash 3.x.
  it.skipIf(!haveBash3)(`parses cleanly under real bash 3.x (found: ${bashVersion ?? 'none'})`, () => {
    const failures: string[] = [];
    for (const file of scripts) {
      try {
        execFileSync('/bin/bash', ['-n', file], { stdio: 'pipe' });
      } catch (error) {
        failures.push(`${path.relative(root, file)}: ${(error as Error).message.split('\n')[0]}`);
      }
    }
    expect(failures, `scripts failed \`bash -n\` under bash ${bashVersion}:\n  ${failures.join('\n  ')}`).toEqual([]);
  });

  it('reports which bash the parse check used, so a skip is never invisible', () => {
    // Fails loudly if /bin/bash disappears entirely; a missing shell is a real
    // environment problem, not something to swallow.
    expect(bashVersion, '/bin/bash not found or not runnable').toBeTruthy();
  });
});
