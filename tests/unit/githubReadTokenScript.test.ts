import crypto from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

describe('mint-github-read-token CLI', () => {
  it('writes only the restricted installation token to stdout', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const requests: Array<{ method?: string; url?: string; body: string }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        requests.push({ method: request.method, url: request.url, body });
        response.setHeader('content-type', 'application/json');
        if (request.method === 'GET') {
          response.end(JSON.stringify({ id: 42 }));
        } else {
          response.statusCode = 201;
          response.end(JSON.stringify({
            token: 'ghs_cliReadToken123456789',
            expires_at: '2099-09-02T02:00:00Z',
            permissions: { contents: 'read', pull_requests: 'read' },
          }));
        }
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const result = await execFileAsync(process.execPath, [
      'scripts/mint-github-read-token.mjs',
      'calltelemetry/ct-pr-operator-sandbox',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GITHUB_APP_ID: '123456',
        GITHUB_APP_PRIVATE_KEY: privateKey,
        GITHUB_API_BASE_URL: `http://127.0.0.1:${address.port}`,
      },
    });

    expect(result.stdout).toBe('ghs_cliReadToken123456789\n');
    expect(result.stderr).toBe('');
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET /repos/calltelemetry/ct-pr-operator-sandbox/installation',
      'POST /app/installations/42/access_tokens',
    ]);
    expect(JSON.parse(requests[1].body)).toEqual({
      repositories: ['ct-pr-operator-sandbox'],
      permissions: { contents: 'read', pull_requests: 'read' },
    });
  });
});
