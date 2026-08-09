import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createHonchoMemoryProvider,
  stablePeerId,
  stableSessionId,
  stableWorkspaceId,
} = require('../src/memory/honchoMemory.js');

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); },
  };
}

function fixtureSecretManager(secrets) {
  return { async getSecret(name) { return secrets[name] || null; } };
}

function defaultFixturePath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'honcho-smoke.json');
}

export function parseSmokeArgs(args = []) {
  if (args[0] === '--live' && args.length === 1) return { mode: 'live' };
  if (args[0] === '--fixture' && args.length <= 2) {
    return { mode: 'fixture', fixturePath: args[1] || defaultFixturePath() };
  }
  throw new Error('Usage: node scripts/honcho-smoke.mjs --fixture [fixture.json] | --live');
}

async function loadFixture(fixture, fixturePath) {
  if (fixture) return fixture;
  return JSON.parse(await readFile(fixturePath || defaultFixturePath(), 'utf8'));
}

function endpointReceipt(url, status, latencyMs, error) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { parsed = null; }
  return {
    host: parsed?.host || 'unknown',
    path: parsed?.pathname || 'unknown',
    status: Number.isInteger(status) ? status : null,
    latencyMs,
    ...(error ? { error } : {}),
  };
}

export async function runSmoke({ mode = 'fixture', manager, fetchImplementation, fixture, fixturePath } = {}) {
  if (!['fixture', 'live'].includes(mode)) throw new Error(`Unsupported smoke mode: ${mode}`);
  let secretManager = manager;
  let baseFetch = fetchImplementation;
  const fixtureData = mode === 'fixture' ? await loadFixture(fixture, fixturePath) : null;
  if (mode === 'live') {
    if (!secretManager) {
      const { DopplerSecretManager } = await import('../dist/mcp/dopplerSecretManager.js');
      // Deliberately disable the CLI so this path proves Doppler REST API resolution.
      secretManager = new DopplerSecretManager({ fallbackEnv: false, cliPath: '__review_yeti_doppler_cli_disabled__' });
    }
  } else {
    secretManager = secretManager || fixtureSecretManager(fixtureData.secrets);
    baseFetch = baseFetch || (async (url) => {
      if (url.endsWith('/health')) return response(200, { status: 'ok' });
      if (url.includes('/representation')) return response(200, { representation: fixtureData.representation });
      return response(200, {});
    });
  }

  const secrets = {};
  for (const name of ['HONCHO_URL', 'HONCHO_API_KEY', 'HONCHO_WORKSPACE_ID']) {
    secrets[name] = await secretManager.getSecret(name);
  }
  const missing = Object.entries(secrets).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) throw new Error(`Missing smoke secret(s): ${missing.join(', ')}`);

  const requests = [];
  const observedFetch = async (url, init) => {
    const startedAt = Date.now();
    try {
      const result = await (baseFetch || globalThis.fetch)(url, init);
      requests.push(endpointReceipt(url, result.status, Date.now() - startedAt));
      return result;
    } catch (error) {
      requests.push(endpointReceipt(url, null, Date.now() - startedAt, 'request failed'));
      throw error;
    }
  };
  const baseUrl = String(secrets.HONCHO_URL).replace(/\/+$/, '');
  const workspaceId = stableWorkspaceId(secrets.HONCHO_WORKSPACE_ID);
  const repo = mode === 'live' ? (process.env.HONCHO_SMOKE_REPO || 'review-yeti-smoke') : 'fixture/review-yeti-smoke';
  const configuredPr = Number(process.env.HONCHO_SMOKE_PR);
  const prNumber = mode === 'live' && Number.isInteger(configuredPr) && configuredPr > 0
    ? configuredPr
    : mode === 'live' ? 900000 + (Date.now() % 100000) : 0;
  const identity = {
    repo,
    prNumber,
    headSha: mode === 'live' ? `honcho-smoke-${Date.now()}` : 'fixture-head',
  };
  const peerId = stablePeerId(identity.repo);
  const sessionId = stableSessionId(identity.repo, identity.prNumber);
  const provider = createHonchoMemoryProvider({
    config: {
      enabled: true,
      baseUrl,
      apiKey: secrets.HONCHO_API_KEY,
      workspaceId,
      timeoutMs: 3_000,
      maxContextChars: 4_000,
    },
    fetchImplementation: observedFetch,
  });
  const health = await provider.healthCheck();
  const write = await provider.appendEvents({
    ...identity,
    events: [{ eventType: 'review_completed', claimId: 'smoke', severity: 'P2', state: 'accepted', verdict: 'SHIP' }],
  });
  const context = await provider.resolveContext({ ...identity, query: 'smoke review memory' });
  const receipt = {
    mode,
    dopplerApi: mode === 'live',
    host: new URL(baseUrl).host,
    workspaceId,
    peerId,
    sessionId,
    configured: health.configured,
    healthAvailable: health.available,
    eventsAccepted: write.accepted,
    contextAvailable: context.available,
    contextChars: context.text.length,
    identity: { repo: identity.repo, prNumber: identity.prNumber },
    requests,
  };
  const failures = [];
  if (!health.available) failures.push(`health unavailable (${health.status || 'no status'})`);
  if (!write.available || write.accepted < 1) failures.push('event write unavailable');
  if (!context.available) failures.push('representation unavailable');
  if (failures.length > 0) {
    const error = new Error(`Honcho smoke failed: ${failures.join('; ')}`);
    error.receipt = receipt;
    throw error;
  }
  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseSmokeArgs(process.argv.slice(2));
    console.log(JSON.stringify(await runSmoke(options), null, 2));
  } catch (error) {
    if (error?.receipt) console.error(JSON.stringify(error.receipt, null, 2));
    console.error(`[Honcho smoke] ${error.message || error}`);
    process.exitCode = 1;
  }
}
