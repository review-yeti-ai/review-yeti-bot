import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Every `npm run <script>` named by a package script, a Dockerfile or a workflow must exist in
// package.json. A merge that drops a script a Dockerfile or `build` still calls breaks image builds
// and release publishing without failing any unit test.
const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

function npmRunTargets(text: string): string[] {
  return [...text.matchAll(/npm run(?: -s| --silent)? ([A-Za-z0-9:_-]+)/gu)].map((match) => match[1]);
}

describe('package.json script contract', () => {
  it('every npm run target used inside package scripts exists', () => {
    const missing = Object.entries(pkg.scripts).flatMap(([name, command]) =>
      npmRunTargets(command).filter((target) => !(target in pkg.scripts)).map((target) => `${name} -> ${target}`));
    expect(missing).toEqual([]);
  });

  it('every root npm run target used by a Dockerfile or workflow exists', () => {
    const files = fs.readdirSync(root).filter((name) => name.startsWith('Dockerfile'))
      .map((name) => path.join(root, name));
    const workflows = path.join(root, '.github/workflows');
    for (const name of fs.readdirSync(workflows)) {
      if (/\.ya?ml$/u.test(name)) files.push(path.join(workflows, name));
    }
    const missing: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      // A target run inside another package (cd cf-orchestrator && npm run ...) is not a root script.
      for (const line of text.split('\n')) {
        if (/cd [^&;|]*(cf-orchestrator|dashboard|pi-runtime)/u.test(line) || /working-directory:/u.test(line)) continue;
        for (const target of npmRunTargets(line)) {
          if (!(target in pkg.scripts)) missing.push(`${path.relative(root, file)}: ${target}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps build:backend, which Dockerfile.worker and the build script depend on', () => {
    // The script must be one plain tsc run against the server tsconfig: -p/--project spelling and extra
    // flags are fine, but a chained or failure-swallowing command (`|| true`, `;`, `&&`) is not.
    expect(pkg.scripts['build:backend']).toMatch(/^tsc (?:-p|--project) tsconfig\.server\.json(?: --[a-zA-Z-]+(?: [^\s&|;]+)?)*$/u);
  });
});
