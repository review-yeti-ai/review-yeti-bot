import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

// A fresh CommonJS process exercises the same ts-node boundary as the token CLI,
// independently of Vitest's transformed-module cache. No constructor is mocked.
const probe = String.raw`
require('ts-node/register/transpile-only');
const target = require.resolve('./src/github/installationClient.ts');
globalThis.fetch = async () => { throw new Error('Unexpected fixture transport'); };
const auth = require('./src/github/appAuth.ts');
const loadedAfterImport = Object.hasOwn(require.cache, target);

async function main() {
  const mode = process.argv[1];
  if (mode === 'import') {
    return {
      loadedAfterImport,
      readTokenExport: typeof auth.getGitHubAppRepositoryReadToken,
      chatClientExport: typeof auth.createEphemeralChatClient,
    };
  }

  const { privateKey } = require('node:crypto').generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const baseUrl = 'https://fixture.invalid/api/v3';
  const token = 'ghs_syntheticChatFactoryToken';
  const failure = new Error('Synthetic token mint failure');
  let tokenRequests = 0;
  let clientRequests = 0;
  const tokenFetch = async (input, init) => {
    if (String(input) !== baseUrl + '/app/installations/42/access_tokens'
        || init?.method !== 'POST') throw new Error('Unexpected token fixture request');
    tokenRequests++;
    if (mode === 'failure') throw failure;
    return new Response(JSON.stringify({ token, expires_at: '2099-01-01T00:00:00Z' }), {
      status: 201, headers: { 'content-type': 'application/json' },
    });
  };
  globalThis.fetch = async (input, init) => {
    if (String(input) !== baseUrl + '/repos/fixture/repository/pulls/7'
        || new Headers(init?.headers).get('authorization') !== 'Bearer ' + token) {
      throw new Error('Unexpected client fixture request');
    }
    clientRequests++;
    return new Response(JSON.stringify({
      head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40), repo: { id: 123 } },
      title: 'fixture', body: 'synthetic body',
    }), { headers: { 'content-type': 'application/json' } });
  };

  if (mode === 'failure') {
    let sameFailure = false;
    try {
      await auth.createEphemeralChatClient('42', { appId: '123456', privateKey, baseUrl }, tokenFetch);
    } catch (error) { sameFailure = error === failure; }
    return {
      loadedAfterImport, loadedAfterFactory: Object.hasOwn(require.cache, target),
      sameFailure, tokenRequests, clientRequests,
    };
  }

  const client = await auth.createEphemeralChatClient(
    '42', { appId: '123456', privateKey, baseUrl }, tokenFetch,
  );
  const loadedAfterFactory = Object.hasOwn(require.cache, target);
  const isActualClient = client instanceof require(target).GitHubInstallationClient;
  const snapshot = await client.getPullRequest('fixture', 'repository', 7);
  return {
    loadedAfterImport, loadedAfterFactory, isActualClient, tokenRequests, clientRequests, snapshot,
  };
}

main().then((result) => process.stdout.write(JSON.stringify(result) + '\n')).catch(() => {
  process.stderr.write('Module-boundary fixture failed\n');
  process.exitCode = 1;
});
`;

async function probeBoundary(mode: 'import' | 'factory' | 'failure') {
  const result = await execFileAsync(process.execPath, ['-e', probe, mode], {
    cwd: process.cwd(),
    env: { ...process.env, LOG_LEVEL: 'error' },
    timeout: 5_000,
  });
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

describe('appAuth actual CommonJS module boundary', () => {
  it('imports read-token auth without loading the installation client', async () => {
    expect(await probeBoundary('import')).toEqual({
      loadedAfterImport: false, readTokenExport: 'function', chatClientExport: 'function',
    });
  });

  it('loads and constructs the actual client on successful chat token mint', async () => {
    expect(await probeBoundary('factory')).toEqual({
      loadedAfterImport: false,
      loadedAfterFactory: true,
      isActualClient: true,
      tokenRequests: 1,
      clientRequests: 1,
      snapshot: {
        headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), repositoryId: 123,
        title: 'fixture', body: 'synthetic body',
      },
    });
  });

  it('preserves token-mint failure without loading the unused client', async () => {
    expect(await probeBoundary('failure')).toEqual({
      loadedAfterImport: false, loadedAfterFactory: false,
      sameFailure: true, tokenRequests: 1, clientRequests: 0,
    });
  });
});
