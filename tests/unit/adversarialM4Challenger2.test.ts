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
import { runCli, printHelp, printVersion } from '../../src/cli/index';

function createMockReqRes(url: string, headers: Record<string, string> = {}, method: string = 'GET') {
  const req: any = {
    url,
    method,
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

const { privateKey: TEST_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('Milestone 4 Adversarial Challenger 2 Review Suite', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeti-adv-m4-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Section 1: Integrity Verification & Constant Security Auditing
  // =========================================================================
  describe('Section 1: Integrity & Security Constants', () => {
    it('1.1: Verifies LEAST_PRIVILEGE_PERMISSIONS matches exact minimum requirements', () => {
      expect(LEAST_PRIVILEGE_PERMISSIONS).toEqual({
        checks: 'write',
        pull_requests: 'write',
        contents: 'read',
        issues: 'write',
        metadata: 'read',
      });
      // Ensure no extra permissions are present in the constant
      expect(Object.keys(LEAST_PRIVILEGE_PERMISSIONS).sort()).toEqual([
        'checks',
        'contents',
        'issues',
        'metadata',
        'pull_requests',
      ]);
    });

    it('1.2: Verifies FORBIDDEN_PERMISSIONS strictly enumerates high-risk scopes', () => {
      const forbidden = [...FORBIDDEN_PERMISSIONS];
      expect(forbidden).toContain('administration');
      expect(forbidden).toContain('secrets');
      expect(forbidden).toContain('workflows');
      expect(forbidden).toContain('members');
      expect(forbidden).toContain('organization_administration');
    });

    it('1.3: Verifies DEFAULT_EVENTS covers all needed PR events without excess', () => {
      expect([...DEFAULT_EVENTS]).toEqual([
        'pull_request',
        'pull_request_review',
        'pull_request_review_comment',
        'issue_comment',
      ]);
    });
  });

  // =========================================================================
  // Section 2: Adversarial Permission Injection & Manifest Boundaries
  // =========================================================================
  describe('Section 2: Manifest Generation & Permission Injection', () => {
    it('2.1: Strips all forbidden permissions even under aggressive injection attempts', () => {
      const hostilePermissions: Record<string, string> = {
        administration: 'write',
        secrets: 'read',
        workflows: 'write',
        members: 'read',
        organization_administration: 'write',
        // Valid override attempt
        pull_requests: 'write',
      };

      const manifest = generateAppManifest({
        permissions: hostilePermissions,
      });

      for (const forbidden of FORBIDDEN_PERMISSIONS) {
        expect(manifest.default_permissions[forbidden]).toBeUndefined();
      }

      // Legitimate permissions must remain intact
      expect(manifest.default_permissions.checks).toBe('write');
      expect(manifest.default_permissions.pull_requests).toBe('write');
      expect(manifest.default_permissions.contents).toBe('read');
      expect(manifest.default_permissions.issues).toBe('write');
      expect(manifest.default_permissions.metadata).toBe('read');
    });

    it('2.2: Validates permission downgrade attempts with validateManifestPermissions', () => {
      // Downgrading pull_requests to read should fail validation
      const downgraded = {
        ...LEAST_PRIVILEGE_PERMISSIONS,
        pull_requests: 'read',
      };
      const res = validateManifestPermissions(downgraded);
      expect(res.valid).toBe(false);
      expect(res.violations.some(v => v.includes('pull_requests') && v.includes('expected write, got read'))).toBe(true);
    });

    it('2.3: Handles empty string hookUrl correctly by deactivating hook', () => {
      const manifestEmptyHook = generateAppManifest({ hookUrl: '' });
      expect(manifestEmptyHook.hook_attributes.active).toBe(false);

      const manifestValidHook = generateAppManifest({ hookUrl: 'https://webhook.example.com/events' });
      expect(manifestValidHook.hook_attributes.active).toBe(true);
      expect(manifestValidHook.hook_attributes.url).toBe('https://webhook.example.com/events');
    });

    it('2.4: Encodes manifest URL with complex parameters and organization correctly', () => {
      const manifest = generateAppManifest({
        name: 'review-yeti-special & chars',
        description: 'AI code reviewer with special "quotes" & <tags>',
      });
      const url = getManifestCreationUrl(manifest, { org: 'my-org-team', state: 'state_123!@#' });
      expect(url.startsWith('https://github.com/organizations/my-org-team/settings/apps/new')).toBe(true);

      const parsedUrl = new URL(url);
      const manifestParam = parsedUrl.searchParams.get('manifest');
      expect(manifestParam).not.toBeNull();
      const decodedManifest = JSON.parse(manifestParam!);
      expect(decodedManifest.name).toBe('review-yeti-special & chars');
      expect(decodedManifest.description).toBe('AI code reviewer with special "quotes" & <tags>');
      expect(parsedUrl.searchParams.get('state')).toBe('state_123!@#');
    });
  });

  // =========================================================================
  // Section 3: HTTP Callback Listener & Adversarial Requests
  // =========================================================================
  describe('Section 3: HTTP Callback Server & Security Challenges', () => {
    it('3.1: Escapes XSS injection payloads in OAuth error callback page', () => {
      let resolvedCode = '';
      let rejectedErr: any = null;
      const handler = createCallbackRequestListener({
        resolveCode: (c) => { resolvedCode = c; },
        rejectCode: (err) => { rejectedErr = err; },
      });

      const maliciousPayload = '<script>alert("xss")</script>';
      const { req, res } = createMockReqRes(`/callback?error=custom_error&error_description=${encodeURIComponent(maliciousPayload)}`);
      handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('<script>');
      expect(res.body).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
      expect(rejectedErr.message).toContain('GitHub App creation failed:');
      expect(rejectedErr.message).toContain('<script>alert("xss")</script>');
    });

    it('3.2: Rejects callbacks when expectedState does not match supplied state', () => {
      let resolvedCode = '';
      let rejectedErr: any = null;
      const handler = createCallbackRequestListener({
        expectedState: 'cryptographic_csrf_token',
        resolveCode: (c) => { resolvedCode = c; },
        rejectCode: (err) => { rejectedErr = err; },
      });

      const { req, res } = createMockReqRes('/callback?code=valid_code&state=forged_state');
      handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('State parameter mismatch');
      expect(resolvedCode).toBe('');
      expect(rejectedErr).not.toBeNull();
      expect(rejectedErr.message).toContain('State mismatch');
    });

    it('3.3: Accepts root path / with code query param as valid redirect callback', () => {
      let resolvedCode = '';
      let rejectedErr: any = null;
      const handler = createCallbackRequestListener({
        resolveCode: (c) => { resolvedCode = c; },
        rejectCode: (err) => { rejectedErr = err; },
      });

      const { req, res } = createMockReqRes('/?code=root_path_auth_code');
      handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(resolvedCode).toBe('root_path_auth_code');
      expect(rejectedErr).toBeNull();
    });

    it('3.4: Times out waitForCode when callback is not received within timeoutMs', async () => {
      const listener = await startCallbackServer({ port: 0 });
      // Short timeout (50ms) to trigger rejection quickly
      await expect(listener.waitForCode(50)).rejects.toThrow('Timed out waiting for GitHub App callback');
      await listener.close();
    });

    it('3.5: openBrowser handles --no-browser and fallback URL printing', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await openBrowser('https://example.com/setup', { noBrowser: true });
      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('https://example.com/setup'));
    });
  });

  // =========================================================================
  // Section 4: Manifest Code Exchange & HTTP Resilience
  // =========================================================================
  describe('Section 4: Manifest Code Exchange & API Robustness', () => {
    it('4.1: Normalizes baseUrl with multiple trailing slashes', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: 101, pem: TEST_PEM, webhook_secret: 'sec' }),
      });

      await exchangeManifestCode('code123', {
        baseUrl: 'https://api.github.com///',
        fetchFn: mockFetch as any,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/app-manifests/code123/conversions',
        expect.anything()
      );
    });

    it('4.2: Handles GitHub API returning app_id and private_key keys', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          app_id: '887766',
          private_key: 'custom_private_key_content',
          webhook_secret: 'whsec_secret',
        }),
      });

      const creds = await exchangeManifestCode('code_alt_keys', { fetchFn: mockFetch as any });
      expect(creds.id).toBe(887766);
      expect(creds.appId).toBe('887766');
      expect(creds.pem).toBe('custom_private_key_content');
      expect(creds.privateKey).toBe('custom_private_key_content');
    });

    it('4.3: Throws descriptive error when GitHub response contains neither id nor app_id', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'success_without_id' }),
      });

      await expect(
        exchangeManifestCode('code_no_id', { fetchFn: mockFetch as any })
      ).rejects.toThrow('missing app id');
    });

    it('4.4: Properly URL-encodes special characters in authorization code', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: 55, pem: TEST_PEM }),
      });

      const trickyCode = 'code/with+special=chars?&';
      await exchangeManifestCode(trickyCode, { fetchFn: mockFetch as any });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent(trickyCode)),
        expect.anything()
      );
    });
  });

  // =========================================================================
  // Section 5: Secret Management, Mode 0o600 & Gitignore Protection
  // =========================================================================
  describe('Section 5: File Permissions & Gitignore Security', () => {
    it('5.1: Writes .env file with POSIX 0o600 mode and preserves extra variables', async () => {
      const envPath = path.join(tempDir, '.env');
      fs.writeFileSync(envPath, '# Preexisting Config\nEXISTING_TOKEN=secret_token_123\nFEATURE_FLAG=true\n');

      const res = await writeEnvFile(
        {
          appId: '12345',
          pem: TEST_PEM,
          webhookSecret: 'whsec_999',
          extra: { REVIEW_YETI_MODEL: 'deepseek-v3' },
        },
        { targetPath: envPath, targetDir: tempDir }
      );

      expect(res.envPath).toBe(envPath);
      const stat = fs.statSync(envPath);
      expect(stat.mode & 0o777).toBe(0o600);

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('EXISTING_TOKEN=secret_token_123');
      expect(content).toContain('FEATURE_FLAG=true');
      expect(content).toContain('GITHUB_APP_ID=12345');
      expect(content).toContain('REVIEW_YETI_MODEL=deepseek-v3');
    });

    it('5.2: Safely creates nested parent directories when writing dedicated PEM file', async () => {
      const deeplyNestedPem = path.join(tempDir, 'sub1', 'sub2', 'certs', 'app.pem');
      const res = await writeEnvFile(
        {
          appId: '12345',
          pem: TEST_PEM,
          webhookSecret: 'whsec_999',
        },
        {
          targetDir: tempDir,
          pemPath: deeplyNestedPem,
          writePemFile: true,
        }
      );

      expect(fs.existsSync(deeplyNestedPem)).toBe(true);
      const stat = fs.statSync(deeplyNestedPem);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(deeplyNestedPem, 'utf-8')).toBe(TEST_PEM);
    });

    it('5.3: ensureGitignoreSecrets correctly appends to empty or missing .gitignore', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(false);

      const res = ensureGitignoreSecrets({ gitignorePath });
      expect(res.updated).toBe(true);
      expect(fs.existsSync(gitignorePath)).toBe(true);
      expect(res.entriesAdded).toEqual(['*.pem', '.env', '.review-yeti/']);

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('*.pem');
      expect(content).toContain('.env');
      expect(content).toContain('.review-yeti/');
    });

    it('5.4: formatEnvContent prevents double-escaping when PEM already has literal \\n', () => {
      const literalPem = '-----BEGIN PRIVATE KEY-----\\nMIIEvgIBADANBgk...\\n-----END PRIVATE KEY-----';
      const formatted = formatEnvContent({
        appId: '999',
        pem: literalPem,
        webhookSecret: 'sec',
      });

      expect(formatted).not.toContain('\\\\n');
      expect(formatted).toContain(`GITHUB_APP_PRIVATE_KEY="${literalPem}"`);
    });

    it('5.5: syncGhSecrets handles empty repo correctly without repo flag', async () => {
      const executed: string[] = [];
      const mockExec = (cmd: string) => {
        executed.push(cmd);
        return Buffer.from('');
      };

      const result = await syncGhSecrets(
        { appId: '777', pem: 'pem_data', webhookSecret: 'wh_data' },
        { execFn: mockExec as any }
      );

      expect(result.success).toBe(true);
      expect(executed[0]).toBe('gh secret set GITHUB_APP_ID -b "777"');
      expect(executed[0]).not.toContain('-R');
    });
  });

  // =========================================================================
  // Section 6: CLI Interface & Top-Level Integration
  // =========================================================================
  describe('Section 6: CLI Dispatcher & Top-Level Commands', () => {
    it('6.1: Prints help cleanly with printHelp() and runCli([])', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      printHelp();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Review Yeti CLI'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('init'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('pre-commit'));

      const code = await runCli([]);
      expect(code).toBe(0);
    });

    it('6.2: Prints version with printVersion() and --version flag', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      printVersion();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('review-yeti v'));

      const code = await runCli(['--version']);
      expect(code).toBe(0);
    });

    it('6.3: Returns code 1 on unknown command with helpful message', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = await runCli(['unknown-command-xyz']);
      expect(code).toBe(1);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown command: unknown-command-xyz'));
    });

    it('6.4: CLI init --dry-run handles --port, --name, and --org flags', async () => {
      let output = '';
      vi.spyOn(console, 'log').mockImplementation((msg) => { output += msg; });

      const code = await runCli([
        'init',
        '--dry-run',
        '--json',
        '--name', 'my-custom-yeti',
        '--org', 'my-enterprise',
        '--port', '4567',
      ]);

      expect(code).toBe(0);
      const parsed = JSON.parse(output);
      expect(parsed.manifest.name).toBe('my-custom-yeti');
      expect(parsed.manifest.redirect_url).toBe('http://localhost:4567/callback');
      expect(parsed.manifestUrl).toContain('https://github.com/organizations/my-enterprise/settings/apps/new');
    });
  });
});
