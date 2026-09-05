import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import crypto from 'node:crypto';
import {
  generateAppManifest,
  validateManifestPermissions,
  getManifestCreationUrl,
  startCallbackServer,
  createCallbackRequestListener,
  openBrowser,
  exchangeManifestCode,
  formatEnvContent,
  ensureGitignoreSecrets,
  writeEnvFile,
  syncGhSecrets,
  runInitWizard,
  LEAST_PRIVILEGE_PERMISSIONS,
  FORBIDDEN_PERMISSIONS,
  DEFAULT_EVENTS,
} from '../../src/cli/initWizard';
import { runCli } from '../../src/cli/index';

function createMockReqRes(url: string, headers: Record<string, string> = {}) {
  const req: any = {
    url,
    method: 'GET',
    headers: { host: 'localhost:3333', ...headers },
  };

  let statusCode = 200;
  const responseHeaders: Record<string, string> = {};
  let body = '';

  const res: any = {
    writeHead: vi.fn((code: number, hdrs?: any) => {
      statusCode = code;
      if (hdrs) Object.assign(responseHeaders, hdrs);
      return res;
    }),
    end: vi.fn((chunk?: any) => {
      if (chunk) body += chunk.toString();
      return res;
    }),
    get statusCode() { return statusCode; },
    get headers() { return responseHeaders; },
    get body() { return body; },
  };

  return { req, res };
}

// Generate a test RSA private key PEM
const { privateKey: TEST_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('Milestone 4: 30-Second GitHub App Setup Wizard (R4)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeti-init-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Feature 14: GitHub App Manifest Generation
  // =========================================================================
  describe('Feature 14: GitHub App Manifest Generation', () => {
    it('generates valid GitHub App manifest matching exact least-privilege matrix', () => {
      const manifest = generateAppManifest({
        name: 'review-yeti-test-org',
        url: 'https://github.com/review-yeti-ai/review-yeti-bot',
        port: 3333,
      });

      expect(manifest.name).toBe('review-yeti-test-org');
      expect(manifest.url).toBe('https://github.com/review-yeti-ai/review-yeti-bot');
      expect(manifest.redirect_url).toBe('http://localhost:3333/callback');
      expect(manifest.callback_urls).toEqual(['http://localhost:3333/callback']);
      expect(manifest.public).toBe(false);

      // Exact least-privilege matrix
      expect(manifest.default_permissions.checks).toBe('write');
      expect(manifest.default_permissions.pull_requests).toBe('write');
      expect(manifest.default_permissions.contents).toBe('read');
      expect(manifest.default_permissions.issues).toBe('write');
      expect(manifest.default_permissions.metadata).toBe('read');

      // Default events
      expect(manifest.default_events).toEqual([
        'pull_request',
        'pull_request_review',
        'pull_request_review_comment',
        'issue_comment',
      ]);
    });

    it('strictly omits forbidden administrative and high-risk secret permissions', () => {
      const manifest = generateAppManifest({
        // Attempting to inject forbidden permissions should be cleanly stripped
        permissions: {
          administration: 'write',
          secrets: 'write',
          workflows: 'write',
          members: 'write',
          organization_administration: 'write',
        } as any,
      });

      for (const forbidden of FORBIDDEN_PERMISSIONS) {
        expect(manifest.default_permissions[forbidden], `Must omit ${forbidden}`).toBeUndefined();
      }
    });

    it('validateManifestPermissions verifies correct permissions and catches violations', () => {
      const validPermissions = { ...LEAST_PRIVILEGE_PERMISSIONS };
      const validRes = validateManifestPermissions(validPermissions);
      expect(validRes.valid).toBe(true);
      expect(validRes.violations.length).toBe(0);

      // Forbidden permission injected
      const invalidForbidden = { ...LEAST_PRIVILEGE_PERMISSIONS, secrets: 'read' };
      const resForbidden = validateManifestPermissions(invalidForbidden);
      expect(resForbidden.valid).toBe(false);
      expect(resForbidden.violations.some((v) => v.includes('secrets'))).toBe(true);

      // Missing required permission
      const missingRequired = { checks: 'write', contents: 'read' };
      const resMissing = validateManifestPermissions(missingRequired);
      expect(resMissing.valid).toBe(false);
      expect(resMissing.violations.some((v) => v.includes('pull_requests'))).toBe(true);
    });

    it('constructs manifest creation URL for personal accounts and organizations', () => {
      const manifest = generateAppManifest({ name: 'review-yeti' });

      // Personal account URL
      const userUrl = getManifestCreationUrl(manifest);
      expect(userUrl).toContain('https://github.com/settings/apps/new?manifest=');
      const parsedUser = new URL(userUrl);
      const parsedManifest = JSON.parse(parsedUser.searchParams.get('manifest')!);
      expect(parsedManifest.name).toBe('review-yeti');

      // Organization account URL
      const orgUrl = getManifestCreationUrl(manifest, { org: 'my-org', state: 'random_state_123' });
      expect(orgUrl).toContain('https://github.com/organizations/my-org/settings/apps/new?manifest=');
      const parsedOrg = new URL(orgUrl);
      expect(parsedOrg.searchParams.get('state')).toBe('random_state_123');
    });
  });

  // =========================================================================
  // Feature 15: App Manifest Browser Flow & Callback Listener
  // =========================================================================
  describe('Feature 15: App Manifest Browser Flow & Callback Listener', () => {
    it('starts callback server and captures redirect code parameter', async () => {
      const listener = await startCallbackServer({ port: 0 });
      expect(listener.port).toBeGreaterThan(0);
      expect(listener.redirectUrl).toBe(`http://localhost:${listener.port}/callback`);

      const codePromise = listener.waitForCode(5000);

      // Simulate incoming HTTP request using in-process event emission
      const { req, res } = createMockReqRes('/callback?code=test_auth_code_789');
      listener.server.emit('request', req, res);

      const capturedCode = await codePromise;
      expect(capturedCode).toBe('test_auth_code_789');
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('GitHub App Configured!');

      await listener.close();
    });

    it('rejects on OAuth error returned in callback', async () => {
      const listener = await startCallbackServer({ port: 0 });
      const codePromise = listener.waitForCode(5000);

      const { req, res } = createMockReqRes('/callback?error=access_denied&error_description=User+cancelled');
      listener.server.emit('request', req, res);

      await expect(codePromise).rejects.toThrow('User cancelled');
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Setup Error');

      await listener.close();
    });

    it('rejects on state mismatch when state verification is enabled', async () => {
      const listener = await startCallbackServer({ port: 0, state: 'expected_secret_state' });
      const codePromise = listener.waitForCode(5000);

      const { req, res } = createMockReqRes('/callback?code=abc&state=wrong_state');
      listener.server.emit('request', req, res);

      await expect(codePromise).rejects.toThrow('State mismatch');
      expect(res.statusCode).toBe(400);

      await listener.close();
    });

    it('createCallbackRequestListener handles 404 on unknown paths', () => {
      let resolvedCode = '';
      let rejectedErr: any = null;
      const handler = createCallbackRequestListener({
        resolveCode: (c) => { resolvedCode = c; },
        rejectCode: (err) => { rejectedErr = err; },
      });

      const { req, res } = createMockReqRes('/unknown');
      handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(resolvedCode).toBe('');
      expect(rejectedErr).toBeNull();
    });

    it('openBrowser handles --no-browser without launching child processes', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const launched = await openBrowser('https://github.com/settings/apps/new', { noBrowser: true });
      expect(launched).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('https://github.com/settings/apps/new'));
    });
  });

  // =========================================================================
  // Feature 16: Manifest Code Conversion
  // =========================================================================
  describe('Feature 16: Manifest Code Conversion', () => {
    it('exchanges manifest code for App ID, PEM private key, and secrets', async () => {
      const mockCode = 'temp_manifest_code_abc';
      const mockApiResponse = {
        id: 987654,
        slug: 'review-yeti-demo',
        client_id: 'Iv1.test_client_id',
        client_secret: 'mock_client_secret',
        webhook_secret: 'whsec_test_secret_123',
        pem: TEST_PEM,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockApiResponse,
      });

      const creds = await exchangeManifestCode(mockCode, { fetchFn: mockFetch as any });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/app-manifests/temp_manifest_code_abc/conversions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Accept: 'application/vnd.github+json',
            'User-Agent': 'review-yeti-init',
          }),
        })
      );

      expect(creds.id).toBe(987654);
      expect(creds.appId).toBe('987654');
      expect(creds.pem).toContain('-----BEGIN PRIVATE KEY-----');
      expect(creds.privateKey).toBe(creds.pem);
      expect(creds.clientId).toBe('Iv1.test_client_id');
      expect(creds.clientSecret).toBe('mock_client_secret');
      expect(creds.webhookSecret).toBe('whsec_test_secret_123');
      expect(creds.slug).toBe('review-yeti-demo');
    });

    it('throws informative error on conversion API failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Code expired or not found',
      });

      await expect(
        exchangeManifestCode('invalid_code', { fetchFn: mockFetch as any })
      ).rejects.toThrow('GitHub App manifest conversion failed HTTP 404: Code expired or not found');
    });
  });

  // =========================================================================
  // Feature 17: Environment & Secret Writing
  // =========================================================================
  describe('Feature 17: Environment & Secret Writing', () => {
    it('formatEnvContent formats variables matching exact Review Yeti contract', () => {
      const content = formatEnvContent({
        appId: '123456',
        pem: 'line1\nline2\nline3',
        webhookSecret: 'whsec_999',
      });

      expect(content).toContain('GITHUB_APP_ID=123456');
      expect(content).toContain('GITHUB_APP_PRIVATE_KEY="line1\\nline2\\nline3"');
      expect(content).toContain('GITHUB_WEBHOOK_SECRET=whsec_999');
    });

    it('writeEnvFile enforces 0o600 file permissions on .env', async () => {
      const envPath = path.join(tempDir, '.env');
      const result = await writeEnvFile(
        {
          appId: '987654',
          pem: TEST_PEM,
          webhookSecret: 'whsec_secret',
        },
        {
          targetPath: envPath,
          targetDir: tempDir,
        }
      );

      expect(result.envPath).toBe(envPath);
      expect(fs.existsSync(envPath)).toBe(true);

      const stat = fs.statSync(envPath);
      // In POSIX, 0o600 means only owner can read and write (0o600 === mode & 0o777)
      expect(stat.mode & 0o777).toBe(0o600);

      const written = fs.readFileSync(envPath, 'utf-8');
      expect(written).toContain('GITHUB_APP_ID=987654');
      expect(written).toContain('GITHUB_WEBHOOK_SECRET=whsec_secret');
    });

    it('writeEnvFile preserves existing unrelated environment variables on update', async () => {
      const envPath = path.join(tempDir, '.env');
      fs.writeFileSync(envPath, 'PORT=8080\nDATABASE_URL=postgres://localhost/db\nGITHUB_APP_ID=old_id\n', 'utf-8');

      await writeEnvFile(
        {
          appId: 'new_app_id_555',
          pem: TEST_PEM,
          webhookSecret: 'new_whsec',
        },
        {
          targetPath: envPath,
          targetDir: tempDir,
        }
      );

      const updated = fs.readFileSync(envPath, 'utf-8');
      expect(updated).toContain('PORT=8080');
      expect(updated).toContain('DATABASE_URL=postgres://localhost/db');
      expect(updated).toContain('GITHUB_APP_ID=new_app_id_555');
      expect(updated).not.toContain('old_id');
    });

    it('ensureGitignoreSecrets verifies and appends .env, *.pem, and .review-yeti/', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\ndist/\n', 'utf-8');

      const res1 = ensureGitignoreSecrets({ gitignorePath });
      expect(res1.updated).toBe(true);
      expect(res1.entriesAdded).toContain('*.pem');
      expect(res1.entriesAdded).toContain('.env');
      expect(res1.entriesAdded).toContain('.review-yeti/');

      const contentAfter = fs.readFileSync(gitignorePath, 'utf-8');
      expect(contentAfter).toMatch(/\*\.pem/);
      expect(contentAfter).toMatch(/\.env/);
      expect(contentAfter).toMatch(/\.review-yeti\//);

      // Second run is idempotent
      const res2 = ensureGitignoreSecrets({ gitignorePath });
      expect(res2.updated).toBe(false);
      expect(res2.entriesAdded.length).toBe(0);
    });

    it('writeEnvFile optionally writes separate PEM file with 0o600 mode', async () => {
      const pemPath = path.join(tempDir, 'custom.pem');
      const res = await writeEnvFile(
        {
          appId: '111',
          pem: TEST_PEM,
          webhookSecret: 'sec',
        },
        {
          targetDir: tempDir,
          pemPath,
          writePemFile: true,
        }
      );

      expect(res.pemPath).toBe(pemPath);
      expect(fs.existsSync(pemPath)).toBe(true);
      const stat = fs.statSync(pemPath);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(pemPath, 'utf-8')).toBe(TEST_PEM);
    });

    it('syncGhSecrets executes gh secret set for required credentials', async () => {
      const executedCommands: string[] = [];
      const mockExec = (cmd: string) => {
        executedCommands.push(cmd);
        return Buffer.from('');
      };

      const res = await syncGhSecrets(
        {
          appId: '12345',
          pem: 'dummy_pem',
          webhookSecret: 'dummy_secret',
        },
        {
          repo: 'review-yeti-ai/review-yeti-bot',
          execFn: mockExec as any,
        }
      );

      expect(res.success).toBe(true);
      expect(res.secretsSynced).toEqual(['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET']);
      expect(executedCommands.length).toBe(3);
      expect(executedCommands[0]).toContain('gh secret set GITHUB_APP_ID -R "review-yeti-ai/review-yeti-bot" -b "12345"');
      expect(executedCommands[1]).toContain('gh secret set GITHUB_APP_PRIVATE_KEY');
      expect(executedCommands[2]).toContain('gh secret set GITHUB_WEBHOOK_SECRET');
    });

    it('syncGhSecrets handles gh CLI failures gracefully', async () => {
      const failingExec = () => {
        throw new Error('gh: command not found');
      };

      const res = await syncGhSecrets(
        { appId: '1', pem: 'p', webhookSecret: 's' },
        { execFn: failingExec as any }
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('gh: command not found');
    });
  });

  // =========================================================================
  // Full Wizard & CLI Integration
  // =========================================================================
  describe('Full Setup Wizard & CLI Integration', () => {
    it('runInitWizard dry-run generates preview without starting browser or listener', async () => {
      const result = await runInitWizard({
        name: 'review-yeti-staging',
        org: 'test-org',
        dryRun: true,
        quiet: true,
      });

      expect(result.success).toBe(true);
      expect(result.manifest.name).toBe('review-yeti-staging');
      expect(result.manifestUrl).toContain('https://github.com/organizations/test-org/settings/apps/new?manifest=');
      expect(result.credentials).toBeUndefined();
    });

    it('executes full end-to-end wizard flow with mock callback and API conversion', async () => {
      const mockApiResponse = {
        id: 424242,
        slug: 'review-yeti-e2e',
        client_id: 'Iv1.e2e_id',
        client_secret: 'e2e_secret',
        webhook_secret: 'whsec_e2e_secret',
        pem: TEST_PEM,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockApiResponse,
      });

      const envFile = path.join(tempDir, '.env');

      const mockListener: any = {
        port: 3333,
        redirectUrl: 'http://localhost:3333/callback',
        server: {} as any,
        waitForCode: vi.fn(async () => 'oauth_code_xyz'),
        close: vi.fn(async () => {}),
      };

      const result = await runInitWizard({
        callbackServer: mockListener,
        name: 'review-yeti-e2e',
        noBrowser: true,
        quiet: true,
        envFile,
        fetchFn: mockFetch as any,
      });

      expect(result.success).toBe(true);
      expect(result.credentials?.appId).toBe('424242');
      expect(result.credentials?.slug).toBe('review-yeti-e2e');
      expect(mockListener.waitForCode).toHaveBeenCalled();
      expect(mockListener.close).toHaveBeenCalled();
      expect(fs.existsSync(envFile)).toBe(true);

      const written = fs.readFileSync(envFile, 'utf-8');
      expect(written).toContain('GITHUB_APP_ID=424242');
      expect(written).toContain('GITHUB_WEBHOOK_SECRET=whsec_e2e_secret');
      expect(written).toContain('GITHUB_APP_PRIVATE_KEY=');
    });

    it('CLI dispatcher routes "init --dry-run" successfully (exit code 0)', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exitCode = await runCli(['init', '--dry-run', '--quiet']);
      expect(exitCode).toBe(0);
    });

    it('CLI dispatcher routes "init --dry-run --json" and prints valid JSON', async () => {
      let loggedOutput = '';
      vi.spyOn(console, 'log').mockImplementation((msg) => {
        loggedOutput += msg;
      });

      const exitCode = await runCli(['init', '--dry-run', '--json', '--name', 'custom-yeti']);
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(loggedOutput);
      expect(parsed.manifest.name).toBe('custom-yeti');
      expect(parsed.dryRun).toBe(true);
    });
  });
});
