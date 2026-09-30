import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export const RELEASE_FIXTURE_EXCLUDED_ROOTS = Object.freeze([
  '.agents', '.artifacts', '.claude', '.codex', '.ct-memory', '.ct-meta', '.ct-mcp-runtimes',
  '.gemini', '.herdr', '.next', '.opencode', '.pi', '.review-yeti', '.tmp', '.cache',
  'artifacts', 'coverage', 'dist', 'node_modules', 'out', 'runs', 'screenshots', 'test-results',
]);

/** Extracts only immutable Git-object contents, with workstation runtime paths excluded. */
export function copyReleaseCommitFixture(sourceRoot: string, destinationRoot: string, commit: string): string {
  const commitSha = execFileSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], {
    cwd: sourceRoot,
    encoding: 'utf8',
  }).trim();
  if (!/^[a-f0-9]{40,64}$/u.test(commitSha)) {
    throw new Error(`Release fixture source did not resolve to a full commit SHA: ${commit}`);
  }

  fs.mkdirSync(destinationRoot, { recursive: true });
  if (fs.readdirSync(destinationRoot).length > 0) {
    throw new Error(`Release fixture destination must be empty: ${destinationRoot}`);
  }

  const pathspecs = [
    '.',
    ...RELEASE_FIXTURE_EXCLUDED_ROOTS.map((root) => `:(exclude,top)${root}`),
    ':(exclude,top)fixtures/tmp',
  ];
  const archive = execFileSync('git', ['archive', '--format=tar', commitSha, '--', ...pathspecs], {
    cwd: sourceRoot,
    maxBuffer: 256 * 1024 * 1024,
  });
  execFileSync('tar', ['-xf', '-', '-C', destinationRoot], {
    input: archive,
    maxBuffer: 256 * 1024 * 1024,
  });
  return commitSha;
}
