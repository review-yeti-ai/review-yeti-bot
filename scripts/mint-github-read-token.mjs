#!/usr/bin/env node

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { getGitHubAppRepositoryReadToken } = require('../src/github/appAuth.ts');

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const repository = process.argv[2] || '';
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(repository);
  if (!match) throw new Error('one owner/repo argument is required');
  const result = await getGitHubAppRepositoryReadToken({
    appId: requiredEnv('GITHUB_APP_ID'),
    privateKey: requiredEnv('GITHUB_APP_PRIVATE_KEY').replace(/\\n/gu, '\n'),
    owner: match[1],
    repo: match[2],
    baseUrl: process.env.GITHUB_API_BASE_URL?.trim() || undefined,
  });
  process.stdout.write(`${result.token}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'unknown failure';
  process.stderr.write(`mint-github-read-token: ${message}\n`);
  process.exitCode = 1;
});
