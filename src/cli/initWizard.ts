import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { URL } from 'node:url';

/**
 * Exact least-privilege permissions required by Review Yeti.
 * Any permission outside this set is either unnecessary or violates least-privilege security.
 */
export const LEAST_PRIVILEGE_PERMISSIONS = {
  checks: 'write',
  pull_requests: 'write',
  contents: 'read',
  issues: 'write',
  metadata: 'read',
} as const;

/**
 * Forbidden administrative and high-risk secret permissions.
 * These permissions must NEVER be requested in the GitHub App manifest.
 */
export const FORBIDDEN_PERMISSIONS = [
  'administration',
  'secrets',
  'workflows',
  'members',
  'organization_administration',
] as const;

/**
 * Default webhook events required for automated reviews and interactive mentoring.
 */
export const DEFAULT_EVENTS = [
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
] as const;

export interface GitHubAppManifest {
  name: string;
  url: string;
  hook_attributes: {
    url: string;
    active: boolean;
    secret?: string;
  };
  redirect_url: string;
  callback_urls: string[];
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
  description?: string;
}

export interface AppManifestOptions {
  name?: string;
  url?: string;
  hookUrl?: string;
  hookActive?: boolean;
  webhookSecret?: string;
  redirectUrl?: string;
  callbackUrls?: string[];
  public?: boolean;
  description?: string;
  port?: number;
  permissions?: Record<string, string>;
  events?: string[];
}

export interface GitHubAppCredentials {
  id: number;
  appId: string;
  pem: string;
  privateKey: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret: string;
  installationId?: number;
  slug?: string;
  name?: string;
  raw?: Record<string, any>;
}

export interface ExchangeOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface WriteEnvOptions {
  targetPath?: string;
  targetDir?: string;
  pemPath?: string;
  writePemFile?: boolean;
  skipGitignore?: boolean;
  gitignorePath?: string;
  overwrite?: boolean;
}

export interface WriteEnvResult {
  envPath: string;
  pemPath?: string;
  gitignoreUpdated: boolean;
  entriesAdded: string[];
}

export interface CallbackServerOptions {
  port?: number;
  host?: string;
  timeoutMs?: number;
  state?: string;
}

export interface CallbackServerHandle {
  port: number;
  redirectUrl: string;
  server: http.Server;
  waitForCode: (timeoutMs?: number) => Promise<string>;
  close: () => Promise<void>;
}

export interface GhSecretSyncResult {
  success: boolean;
  secretsSynced: string[];
  error?: string;
}

export interface InitWizardOptions {
  port?: number;
  org?: string;
  name?: string;
  url?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  noBrowser?: boolean;
  envFile?: string;
  writePem?: boolean;
  pemPath?: string;
  syncSecrets?: boolean;
  repo?: string;
  dryRun?: boolean;
  json?: boolean;
  fetchFn?: typeof fetch;
  quiet?: boolean;
  callbackServer?: CallbackServerHandle;
}

export interface InitWizardResult {
  success: boolean;
  manifest: GitHubAppManifest;
  manifestUrl: string;
  credentials?: GitHubAppCredentials;
  envResult?: WriteEnvResult;
  secretsSynced?: string[];
  message?: string;
}

/**
 * Validates that permissions strictly adhere to least-privilege rules
 * and omit all forbidden administrative permissions.
 */
export function validateManifestPermissions(permissions: Record<string, string>): {
  valid: boolean;
  violations: string[];
} {
  const violations: string[] = [];

  for (const forbidden of FORBIDDEN_PERMISSIONS) {
    if (permissions[forbidden] !== undefined) {
      violations.push(`Forbidden permission requested: ${forbidden}`);
    }
  }

  // Ensure all required permissions are present with correct access level
  for (const [key, value] of Object.entries(LEAST_PRIVILEGE_PERMISSIONS)) {
    if (!permissions[key]) {
      violations.push(`Missing required permission: ${key}`);
    } else if (permissions[key] !== value) {
      violations.push(`Permission level mismatch for ${key}: expected ${value}, got ${permissions[key]}`);
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Feature 14: Generates a GitHub App manifest JSON matching the exact least-privilege matrix.
 */
export function generateAppManifest(options: AppManifestOptions = {}): GitHubAppManifest {
  const port = options.port ?? 3333;
  const redirectUrl = options.redirectUrl ?? `http://localhost:${port}/callback`;
  const callbackUrls = options.callbackUrls ?? [redirectUrl];

  const permissions: Record<string, string> = {
    ...LEAST_PRIVILEGE_PERMISSIONS,
    ...(options.permissions ?? {}),
  };

  // Strip any accidental forbidden permissions
  for (const forbidden of FORBIDDEN_PERMISSIONS) {
    delete permissions[forbidden];
  }

  const events = options.events ? [...options.events] : [...DEFAULT_EVENTS];

  const manifest: GitHubAppManifest = {
    name: options.name || 'review-yeti',
    url: options.url || 'https://github.com/review-yeti-ai/review-yeti-bot',
    hook_attributes: {
      url: options.hookUrl || 'https://example.com/webhook',
      active: options.hookActive ?? (options.hookUrl !== undefined && options.hookUrl !== ''),
      ...(options.webhookSecret ? { secret: options.webhookSecret } : {}),
    },
    redirect_url: redirectUrl,
    callback_urls: callbackUrls,
    public: options.public ?? false,
    default_permissions: permissions,
    default_events: events,
  };

  if (options.description) {
    manifest.description = options.description;
  }

  return manifest;
}

/**
 * Constructs the GitHub App creation URL with encoded manifest payload.
 */
export function getManifestCreationUrl(
  manifest: GitHubAppManifest,
  options: { org?: string; state?: string } = {}
): string {
  const baseUrl = options.org
    ? `https://github.com/organizations/${encodeURIComponent(options.org)}/settings/apps/new`
    : `https://github.com/settings/apps/new`;

  const url = new URL(baseUrl);
  url.searchParams.set('manifest', JSON.stringify(manifest));

  if (options.state) {
    url.searchParams.set('state', options.state);
  }

  return url.toString();
}

/**
 * Creates the HTTP request listener that handles GitHub App manifest redirection.
 */
export function createCallbackRequestListener(options: {
  host?: string;
  port?: number;
  expectedState?: string;
  resolveCode: (code: string) => void;
  rejectCode: (err: any) => void;
}): http.RequestListener {
  const host = options.host ?? 'localhost';
  const port = options.port ?? 3333;
  const expectedState = options.expectedState;
  const { resolveCode, rejectCode } = options;

  return (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

      if (parsedUrl.pathname === '/callback' || parsedUrl.pathname === '/') {
        const code = parsedUrl.searchParams.get('code');
        const error = parsedUrl.searchParams.get('error');
        const errorDescription = parsedUrl.searchParams.get('error_description');
        const state = parsedUrl.searchParams.get('state');

        if (error) {
          const errMsg = errorDescription || error;
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><title>Review Yeti - Setup Error</title></head>
            <body style="font-family: sans-serif; background: #0d1117; color: #ff7b72; padding: 40px; text-align: center;">
              <h1>Setup Error</h1>
              <p>${escapeHtml(errMsg)}</p>
            </body>
            </html>
          `);
          rejectCode(new Error(`GitHub App creation failed: ${errMsg}`));
          return;
        }

        if (code) {
          if (expectedState && state && state !== expectedState) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Error: State parameter mismatch.');
            rejectCode(new Error('State mismatch in GitHub App manifest redirect callback'));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Review Yeti - Setup Complete</title>
              <style>
                body {
                  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                  display: flex; align-items: center; justify-content: center;
                  height: 100vh; margin: 0; background: #0d1117; color: #c9d1d9;
                }
                .card {
                  background: #161b22; border: 1px solid #30363d; border-radius: 8px;
                  padding: 36px; max-width: 460px; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
                }
                .badge {
                  display: inline-block; background: #238636; color: #fff;
                  padding: 4px 14px; border-radius: 20px; font-weight: 600; font-size: 13px; margin-bottom: 16px;
                }
                h1 { color: #58a6ff; font-size: 22px; margin: 0 0 12px; }
                p { font-size: 14px; line-height: 1.6; color: #8b949e; margin: 0 0 8px; }
              </style>
            </head>
            <body>
              <div class="card">
                <div class="badge">Success</div>
                <h1>GitHub App Configured!</h1>
                <p>Review Yeti captured your GitHub App credentials successfully.</p>
                <p>You can close this window and return to your terminal.</p>
              </div>
            </body>
            </html>
          `);

          resolveCode(code);
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err) {
      rejectCode(err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Error');
    }
  };
}

/**
 * Feature 15: Starts a local HTTP callback listener to capture GitHub's redirect `code` parameter.
 */
export async function startCallbackServer(
  options: CallbackServerOptions = {}
): Promise<CallbackServerHandle> {
  const initialPort = options.port ?? 3333;
  const host = options.host ?? 'localhost';
  const expectedState = options.state;

  let resolveCode: (code: string) => void;
  let rejectCode: (reason: any) => void;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const requestListener = createCallbackRequestListener({
    host,
    port: initialPort,
    expectedState,
    resolveCode: (c) => resolveCode(c),
    rejectCode: (r) => rejectCode(r),
  });

  const server = http.createServer(requestListener);

  // Listen with fallback to ephemeral port if preferred port is in use
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE' && initialPort !== 0) {
        // Retry with ephemeral port 0
        const fallbackServer = server.listen(0, host, () => {
          const addr = fallbackServer.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          resolve(port);
        });
      } else {
        reject(err);
      }
    });

    server.listen(initialPort, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : initialPort;
      resolve(port);
    });
  });

  const redirectUrl = `http://${host}:${boundPort}/callback`;

  return {
    port: boundPort,
    redirectUrl,
    server,
    waitForCode: async (timeoutMs: number = options.timeoutMs ?? 120_000) => {
      if (timeoutMs <= 0) {
        return codePromise;
      }
      let timer: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for GitHub App callback after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      try {
        return await Promise.race([codePromise, timeoutPromise]);
      } finally {
        clearTimeout(timer!);
      }
    },
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/**
 * Opens a URL in the user's default browser or outputs the link.
 */
export async function openBrowser(
  url: string,
  options: { noBrowser?: boolean; openCommand?: string } = {}
): Promise<boolean> {
  if (options.noBrowser) {
    console.log(`\nOpen the following URL in your browser to complete GitHub App setup:\n\n  ${url}\n`);
    return false;
  }

  let command = options.openCommand;
  const args: string[] = [];

  if (!command) {
    switch (process.platform) {
      case 'darwin':
        command = 'open';
        args.push(url);
        break;
      case 'win32':
        command = 'cmd.exe';
        args.push('/c', 'start', '""', url);
        break;
      default:
        command = 'xdg-open';
        args.push(url);
        break;
    }
  } else {
    args.push(url);
  }

  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command!, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {
        console.log(`\nOpen the following URL in your browser to complete GitHub App setup:\n\n  ${url}\n`);
        resolve(false);
      });
      child.unref();
      resolve(true);
    } catch {
      console.log(`\nOpen the following URL in your browser to complete GitHub App setup:\n\n  ${url}\n`);
      resolve(false);
    }
  });
}

/**
 * Feature 16: Exchanges temporary callback code for App ID, PEM private key, and webhook secret.
 * Calls `POST https://api.github.com/app-manifests/{code}/conversions`.
 */
export async function exchangeManifestCode(
  code: string,
  options: ExchangeOptions = {}
): Promise<GitHubAppCredentials> {
  const baseUrl = options.baseUrl || 'https://api.github.com';
  const fetchFn = options.fetchFn || globalThis.fetch;

  const url = `${baseUrl.replace(/\/+$/, '')}/app-manifests/${encodeURIComponent(code)}/conversions`;

  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'review-yeti-init',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`GitHub App manifest conversion failed HTTP ${response.status}: ${errorText}`);
  }

  const data: any = await response.json();

  if (!data || (!data.id && !data.app_id)) {
    throw new Error('Invalid response from GitHub App manifest conversion: missing app id');
  }

  const id = Number(data.id || data.app_id);
  const pem = data.pem || data.private_key || '';
  const webhookSecret = data.webhook_secret || '';

  return {
    id,
    appId: String(id),
    pem,
    privateKey: pem,
    clientId: data.client_id,
    clientSecret: data.client_secret,
    webhookSecret,
    installationId: data.installation_id ? Number(data.installation_id) : undefined,
    slug: data.slug,
    name: data.name,
    raw: data,
  };
}

/**
 * Formats environment variables string for Review Yeti `.env` file.
 */
export function formatEnvContent(config: {
  appId: string | number;
  pem: string;
  webhookSecret: string;
  extra?: Record<string, string>;
}): string {
  const pemSingleLine = config.pem.includes('\\n')
    ? config.pem
    : config.pem.replace(/\r?\n/g, '\\n');

  const lines = [
    `GITHUB_APP_ID=${config.appId}`,
    `GITHUB_APP_PRIVATE_KEY="${pemSingleLine}"`,
    `GITHUB_WEBHOOK_SECRET=${config.webhookSecret}`,
  ];

  if (config.extra) {
    for (const [k, v] of Object.entries(config.extra)) {
      lines.push(`${k}=${v}`);
    }
  }

  return lines.join('\n');
}

/**
 * Ensures `.gitignore` contains critical secret protection patterns (`.env`, `*.pem`, `.review-yeti/`).
 */
export function ensureGitignoreSecrets(options: {
  repoRoot?: string;
  gitignorePath?: string;
} = {}): { updated: boolean; entriesAdded: string[] } {
  const gitignorePath = options.gitignorePath || path.resolve(options.repoRoot || process.cwd(), '.gitignore');
  const requiredEntries = ['*.pem', '.env', '.review-yeti/'];
  const entriesAdded: string[] = [];

  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  }

  const lines = content.split(/\r?\n/).map((l) => l.trim());

  for (const entry of requiredEntries) {
    // Check if entry or glob matches
    const exists = lines.some((line) => {
      if (line === entry) return true;
      if (entry === '*.pem' && (line === '*.pem' || line.includes('.pem'))) return true;
      if (entry === '.env' && (line === '.env' || line === '.env*' || line.startsWith('.env.'))) return true;
      if (entry === '.review-yeti/' && (line === '.review-yeti/' || line === '.review-yeti')) return true;
      return false;
    });

    if (!exists) {
      entriesAdded.push(entry);
    }
  }

  if (entriesAdded.length > 0) {
    const trailingNewline = content.endsWith('\n') || content === '' ? '' : '\n';
    const appendBlock = `${trailingNewline}# Review Yeti secrets\n${entriesAdded.join('\n')}\n`;
    fs.writeFileSync(gitignorePath, content + appendBlock, { encoding: 'utf-8' });
    return { updated: true, entriesAdded };
  }

  return { updated: false, entriesAdded: [] };
}

/**
 * Feature 17: Writes credentials to `.env` with strict `0o600` permissions and updates `.gitignore`.
 */
export async function writeEnvFile(
  config: {
    appId: string | number;
    pem: string;
    webhookSecret: string;
    extra?: Record<string, string>;
  },
  options: WriteEnvOptions = {}
): Promise<WriteEnvResult> {
  const targetDir = options.targetDir || process.cwd();
  const envPath = options.targetPath || path.resolve(targetDir, '.env');

  let mergedContent = '';
  if (fs.existsSync(envPath) && !options.overwrite) {
    const existing = fs.readFileSync(envPath, 'utf-8');
    const parsedLines = existing.split(/\r?\n/);
    const updatedKeys = new Set(['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET']);

    const filtered = parsedLines.filter((line) => {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
      return !match || !updatedKeys.has(match[1]);
    });

    const newBlock = formatEnvContent(config);
    mergedContent = [...filtered.filter((l) => l.trim().length > 0), newBlock].join('\n') + '\n';
  } else {
    mergedContent = formatEnvContent(config) + '\n';
  }

  // Write .env with 0o600 permissions
  fs.writeFileSync(envPath, mergedContent, { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {
    // Ignore chmod errors on systems that do not support POSIX modes
  }

  let pemPath: string | undefined;
  if (options.writePemFile || options.pemPath) {
    pemPath = options.pemPath || path.resolve(targetDir, 'review-yeti.private-key.pem');
    const parentDir = path.dirname(pemPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(pemPath, config.pem, { encoding: 'utf-8', mode: 0o600 });
    try {
      fs.chmodSync(pemPath, 0o600);
    } catch {
      // Ignore
    }
  }

  let gitignoreUpdated = false;
  let entriesAdded: string[] = [];

  if (!options.skipGitignore) {
    const giResult = ensureGitignoreSecrets({
      repoRoot: targetDir,
      gitignorePath: options.gitignorePath,
    });
    gitignoreUpdated = giResult.updated;
    entriesAdded = giResult.entriesAdded;
  }

  return {
    envPath,
    pemPath,
    gitignoreUpdated,
    entriesAdded,
  };
}

/**
 * Sets repository secrets using GitHub CLI (`gh secret set`).
 */
export async function syncGhSecrets(
  credentials: { appId: string | number; pem: string; webhookSecret: string },
  options: {
    repo?: string;
    execFn?: (cmd: string) => string | Buffer;
  } = {}
): Promise<GhSecretSyncResult> {
  const runner = options.execFn || execSync;
  const repoFlag = options.repo ? ` -R "${options.repo}"` : '';
  const secretsSynced: string[] = [];

  try {
    // Sync App ID
    runner(`gh secret set GITHUB_APP_ID${repoFlag} -b "${credentials.appId}"`);
    secretsSynced.push('GITHUB_APP_ID');

    // Sync Private Key PEM
    runner(`gh secret set GITHUB_APP_PRIVATE_KEY${repoFlag} -b "${credentials.pem}"`);
    secretsSynced.push('GITHUB_APP_PRIVATE_KEY');

    // Sync Webhook Secret
    runner(`gh secret set GITHUB_WEBHOOK_SECRET${repoFlag} -b "${credentials.webhookSecret}"`);
    secretsSynced.push('GITHUB_WEBHOOK_SECRET');

    return {
      success: true,
      secretsSynced,
    };
  } catch (err: any) {
    return {
      success: false,
      secretsSynced,
      error: err?.message || String(err),
    };
  }
}

/**
 * Orchestrates the full 30-Second GitHub App Setup Wizard.
 */
export async function runInitWizard(options: InitWizardOptions = {}): Promise<InitWizardResult> {
  const port = options.port ?? 3333;
  const webhookSecret = options.webhookSecret || `whsec_${crypto.randomBytes(16).toString('hex')}`;
  const log = (options.quiet || options.json) ? () => {} : console.log;

  log('\n🦺 Review Yeti — 30-Second GitHub App Setup Wizard');
  log('==================================================');
  log('Configuring least-privilege GitHub App credentials...\n');

  // Step 1: Start local callback server
  let callbackServer: CallbackServerHandle | undefined = options.callbackServer;
  if (!callbackServer) {
    try {
      callbackServer = await startCallbackServer({ port });
    } catch (err: any) {
      if (!options.dryRun) {
        throw new Error(`Failed to start local callback listener: ${err.message}`);
      }
    }
  }

  const redirectUrl = callbackServer ? callbackServer.redirectUrl : `http://localhost:${port}/callback`;

  // Step 2: Generate least-privilege App manifest
  const manifest = generateAppManifest({
    name: options.name || (options.org ? `review-yeti-${options.org}` : 'review-yeti'),
    url: options.url,
    hookUrl: options.webhookUrl,
    webhookSecret,
    redirectUrl,
    port: callbackServer ? callbackServer.port : port,
  });

  const manifestUrl = getManifestCreationUrl(manifest, { org: options.org });

  if (options.dryRun) {
    if (callbackServer) {
      await callbackServer.close();
    }
    if (options.json) {
      console.log(JSON.stringify({ manifest, manifestUrl, dryRun: true }, null, 2));
    } else {
      log('Manifest preview (dry run):');
      log(JSON.stringify(manifest, null, 2));
      log(`\nCreation URL: ${manifestUrl}\n`);
    }
    return {
      success: true,
      manifest,
      manifestUrl,
      message: 'Dry run completed successfully',
    };
  }

  log(`1. Callback listener active on port ${callbackServer!.port}`);
  log('2. Opening GitHub App creation page in your browser...');
  log('   (Review Yeti will automatically request ONLY least-privilege review permissions)');

  // Step 3: Open browser
  await openBrowser(manifestUrl, { noBrowser: options.noBrowser });

  log('\nWaiting for GitHub callback confirmation...');

  // Step 4: Await callback code
  const code = await callbackServer!.waitForCode();
  log(`✅ Received authorization code: ${code.slice(0, 8)}...`);

  // Step 5: Convert manifest code to credentials
  log('3. Exchanging authorization code with GitHub API...');
  const credentials = await exchangeManifestCode(code, { fetchFn: options.fetchFn });
  log(`✅ GitHub App created! ID: ${credentials.appId}`);

  // Step 6: Write .env file and enforce 0o600 permissions
  log('4. Writing credentials to .env file with 0o600 permissions...');
  const envResult = await writeEnvFile(
    {
      appId: credentials.appId,
      pem: credentials.pem,
      webhookSecret: credentials.webhookSecret || webhookSecret,
    },
    {
      targetPath: options.envFile,
      writePemFile: options.writePem,
      pemPath: options.pemPath,
    }
  );
  log(`✅ Saved secrets to ${envResult.envPath} (mode 0o600)`);
  if (envResult.gitignoreUpdated) {
    log(`✅ Added ${envResult.entriesAdded.join(', ')} to .gitignore`);
  }

  // Step 7: Optional GitHub Secrets Sync
  let secretsSynced: string[] | undefined;
  if (options.syncSecrets) {
    log('5. Syncing credentials to GitHub repository secrets via `gh secret set`...');
    const syncRes = await syncGhSecrets(
      {
        appId: credentials.appId,
        pem: credentials.pem,
        webhookSecret: credentials.webhookSecret || webhookSecret,
      },
      { repo: options.repo }
    );
    if (syncRes.success) {
      secretsSynced = syncRes.secretsSynced;
      log(`✅ Successfully synced repository secrets: ${secretsSynced.join(', ')}`);
    } else {
      log(`⚠️ Could not sync via GitHub CLI: ${syncRes.error}`);
    }
  }

  // Clean shutdown
  await callbackServer!.close();

  log('\n🎉 Setup Complete!');
  log('================');
  log(`GitHub App ID:        ${credentials.appId}`);
  log(`App Slug:             ${credentials.slug || manifest.name}`);
  log(`Environment File:     ${envResult.envPath}`);
  log('\nNext steps:');
  log('1. Install the App on your repository: https://github.com/apps/' + (credentials.slug || manifest.name) + '/installations/new');
  log('2. Test pre-commit guardian locally:   npx review-yeti pre-commit');
  log('3. Run Review Yeti worker or webhook:  npx review-yeti\n');

  return {
    success: true,
    manifest,
    manifestUrl,
    credentials,
    envResult,
    secretsSynced,
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
