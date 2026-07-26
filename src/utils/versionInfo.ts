import { execSync } from 'node:child_process';
import pkg from '../../package.json';

export interface VersionInfo {
  name: string;
  version: string;
  commitHash: string;
  fullCommitHash: string;
  buildTimestamp: string;
  environment: string;
  cluster: string;
  runner: string;
  memoryEngine: string;
}

export function getSystemVersionInfo(): VersionInfo {
  let commitHash = process.env.GIT_COMMIT_SHA || process.env.GITHUB_SHA || '';
  if (!commitHash) {
    try {
      commitHash = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    } catch {
      commitHash = '92905d4a1b2c3d';
    }
  }

  const shortHash = commitHash.slice(0, 7);

  return {
    name: pkg.name || 'ct-review-bot',
    version: `v${pkg.version || '1.5.0'}`,
    commitHash: shortHash,
    fullCommitHash: commitHash,
    buildTimestamp: process.env.BUILD_TIMESTAMP || '2026-07-26T08:51:00Z',
    environment: process.env.NODE_ENV || 'production',
    cluster: 'DigitalOcean Kubernetes (DOKS ny1)',
    runner: 'Blacksmith GHA Runners',
    memoryEngine: 'Tree-sitter SQLite AST Graph v2',
  };
}
