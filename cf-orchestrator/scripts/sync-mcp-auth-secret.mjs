import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MCP_AUTH_SECRET_NAME = 'REVIEW_YETI_MCP_AUTH_TOKEN';
export const MAX_RESPONSE_BYTES = 16 * 1024;
export const MAX_REQUEST_TIMEOUT_MS = 10_000;

const DOPPLER_SECRET_URL = 'https://api.doppler.com/v3/configs/config/secret';
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

class SafeSyncError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SafeSyncError';
    this.code = code;
  }
}

function requiredEnv(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SafeSyncError(`missing_${name}`);
  }
  return value.trim();
}

export async function readWorkerName(configPath = fileURLToPath(new URL('../wrangler.toml', import.meta.url))) {
  let config;
  try {
    config = await readFile(configPath, 'utf8');
  } catch {
    throw new SafeSyncError('wrangler_config_unavailable');
  }

  const topLevelConfig = config.split(/^\[/mu, 1)[0];
  const match = /^\s*name\s*=\s*"([^"\r\n]+)"\s*$/mu.exec(topLevelConfig);
  const workerName = match?.[1];
  if (!workerName || !/^[A-Za-z0-9_-]{1,128}$/u.test(workerName)) {
    throw new SafeSyncError('worker_name_missing_or_invalid');
  }
  return workerName;
}

async function readBoundedBody(response, provider) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    try { await response.body?.cancel(); } catch { /* best-effort cancellation */ }
    throw new SafeSyncError(`${provider}_response_too_large`);
  }

  if (!response.body) throw new SafeSyncError(`${provider}_response_empty`);

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* best-effort cancellation */ }
        throw new SafeSyncError(`${provider}_response_too_large`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SafeSyncError) throw error;
    throw new SafeSyncError(`${provider}_response_read_failed`);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function requestJson(fetchImpl, provider, url, init, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new SafeSyncError(`${provider}_request_failed`);
  }

  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* best-effort cancellation */ }
    throw new SafeSyncError(`${provider}_http_${response.status}`);
  }

  let body;
  try {
    body = JSON.parse(await readBoundedBody(response, provider));
  } catch (error) {
    if (error instanceof SafeSyncError) throw error;
    throw new SafeSyncError(`${provider}_response_invalid_json`);
  }
  return body;
}

/**
 * Fetch exactly the canonical MCP auth token from Doppler and project it into
 * the current Worker by using Cloudflare's single-secret API. The secret stays
 * in process memory and is never included in output, argv, or a file.
 */
export async function syncMcpAuthSecret({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = MAX_REQUEST_TIMEOUT_MS,
  workerName,
} = {}) {
  const dopplerToken = requiredEnv(env, 'REVIEW_YETI_DOPPLER_TOKEN');
  const project = requiredEnv(env, 'REVIEW_YETI_DOPPLER_PROJECT');
  const config = requiredEnv(env, 'REVIEW_YETI_DOPPLER_CONFIG');
  const cloudflareToken = requiredEnv(env, 'CLOUDFLARE_API_TOKEN');
  const accountId = requiredEnv(env, 'CLOUDFLARE_ACCOUNT_ID');
  const targetWorker = workerName ?? await readWorkerName();
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(targetWorker)) {
    throw new SafeSyncError('worker_name_missing_or_invalid');
  }

  const boundedTimeout = Math.max(1, Math.min(Number(timeoutMs) || MAX_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS));
  const dopplerUrl = new URL(DOPPLER_SECRET_URL);
  dopplerUrl.searchParams.set('project', project);
  dopplerUrl.searchParams.set('config', config);
  dopplerUrl.searchParams.set('name', MCP_AUTH_SECRET_NAME);

  const dopplerResponse = await requestJson(fetchImpl, 'doppler', dopplerUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${dopplerToken}`,
    },
  }, boundedTimeout);

  const secret = dopplerResponse?.value?.computed;
  if (dopplerResponse?.name !== MCP_AUTH_SECRET_NAME || typeof secret !== 'string' || secret.trim() === '') {
    throw new SafeSyncError('doppler_secret_missing_or_invalid');
  }

  const cloudflareUrl = new URL(
    `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(targetWorker)}/secrets`
  );
  const cloudflareResponse = await requestJson(fetchImpl, 'cloudflare', cloudflareUrl, {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${cloudflareToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: MCP_AUTH_SECRET_NAME, text: secret, type: 'secret_text' }),
  }, boundedTimeout);

  if (cloudflareResponse?.success !== true
    || cloudflareResponse?.result?.name !== MCP_AUTH_SECRET_NAME
    || cloudflareResponse?.result?.type !== 'secret_text') {
    throw new SafeSyncError('cloudflare_response_invalid');
  }
}

async function main() {
  try {
    await syncMcpAuthSecret();
    console.log(`Projected ${MCP_AUTH_SECRET_NAME} to the configured Worker.`);
  } catch (error) {
    const code = error instanceof SafeSyncError ? error.code : 'unexpected_failure';
    console.error(`MCP credential sync failed: ${code}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) void main();
