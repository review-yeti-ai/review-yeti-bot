import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Every `npm run <script>` named by a package script or a root Dockerfile must exist in
// package.json. A merge that drops a script a Dockerfile or `build` still calls breaks image builds
// and release publishing without failing any unit test.
const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

function npmRunTargets(text: string): string[] {
  // Dots are legal in npm script names; a trailing dot is sentence punctuation, not part of the name.
  return [...text.matchAll(/npm run(?: -s| --silent)? ([A-Za-z0-9:_.-]+)/gu)].map((match) => match[1].replace(/\.+$/u, ''));
}

describe('package.json script contract', () => {
  it('every npm run target used inside package scripts exists', () => {
    const missing = Object.entries(pkg.scripts).flatMap(([name, command]) =>
      npmRunTargets(command).filter((target) => !(target in pkg.scripts)).map((target) => `${name} -> ${target}`));
    expect(missing).toEqual([]);
  });

  it('every npm run target used by a root Dockerfile exists', () => {
    // Dockerfiles run at the repository root, so their npm run targets are root scripts. Workflow steps
    // are not scanned: their working-directory/cd context is multi-line and cannot be judged per line.
    const missing: string[] = [];
    for (const name of fs.readdirSync(root).filter((entry) => entry.startsWith('Dockerfile'))) {
      for (const target of npmRunTargets(fs.readFileSync(path.join(root, name), 'utf8'))) {
        if (!(target in pkg.scripts)) missing.push(`${name}: ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('extracts dotted script names whole and ignores trailing sentence punctuation', () => {
    expect(npmRunTargets('npm run build.backend && npm run lint.fix.')).toEqual(['build.backend', 'lint.fix']);
  });

  it('keeps build:backend, which Dockerfile.worker and the build script depend on', () => {
    // The script must be one plain tsc run against the server tsconfig: -p/--project spelling and extra
    // flags are fine, optionally followed by `&& node scripts/<file>` (static-asset staging); `|| true` and `;` are not allowed.
    expect(pkg.scripts['build:backend']).toMatch(/^tsc (?:-p|--project)[ =]tsconfig\.server\.json(?: --[a-zA-Z-]+(?: [^\s&|;]+)?)*(?: && node scripts\/[A-Za-z0-9._-]+\.m?js)?$/u);
  });
});
