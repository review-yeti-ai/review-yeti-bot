import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createHonchoMemoryProvider,
  resolveHonchoConfig,
  stablePeerId,
  stableSessionId,
  stableWorkspaceId,
} = require('../src/memory/honchoMemory.js');
const { createMemoryProviderRouter } = require('../src/mcp/memoryProviderRouter.js');
const { createHonchoMemoryMcpAdapter } = require('../src/mcp/honchoMemoryMcpAdapter.js');

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
  let mode;
  let fixturePath;
  let transport;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--live') mode = 'live';
    else if (arg === '--fixture') { mode = 'fixture'; if (args[index + 1] && !args[index + 1].startsWith('--')) fixturePath = args[++index]; }
    else if (arg === '--transport') transport = args[++index];
    else throw new Error('Usage: node scripts/honcho-smoke.mjs --fixture [fixture.json] [--transport mcp|rest] | --live [--transport mcp|rest]');
  }
  if (!mode || (transport && !['mcp', 'rest'].includes(transport))) throw new Error('Usage: node scripts/honcho-smoke.mjs --fixture [fixture.json] [--transport mcp|rest] | --live [--transport mcp|rest]');
  return { mode, fixturePath: fixturePath || (mode === 'fixture' ? defaultFixturePath() : undefined), transport: transport || (mode === 'live' ? 'mcp' : 'rest') };
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

export async function runSmoke({ mode = 'fixture', manager, fetchImplementation, fixture, fixturePath, transport = mode === 'live' ? 'mcp' : 'rest' } = {}) {
  if (!['fixture', 'live'].includes(mode)) throw new Error(`Unsupported smoke mode: ${mode}`);
  if (!['mcp', 'rest'].includes(transport)) throw new Error(`Unsupported smoke transport: ${transport}`);
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

  const runtimeConfig = await resolveHonchoConfig({ config: { enabled: true }, secretManager });
  if (!runtimeConfig.enabled) throw new Error(`Missing smoke secret(s): ${runtimeConfig.reason || 'Honcho configuration unavailable'}`);

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
  const baseUrl = runtimeConfig.baseUrl;
  const workspaceId = stableWorkspaceId(runtimeConfig.workspaceId);
  const repo = mode === 'live' ? (process.env.HONCHO_SMOKE_REPO || 'review-yeti/review-yeti-smoke') : 'fixture/review-yeti-smoke';
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
      apiKey: runtimeConfig.apiKey,
      workspaceId,
      timeoutMs: 3_000,
      maxContextChars: 4_000,
    },
    fetchImplementation: observedFetch,
  });
  const health = await provider.healthCheck();
  const memoryProvider = transport === 'mcp'
    ? createHonchoMemoryMcpAdapter({ honchoProvider: provider, transport: 'mcp', protocol: 'mcp-compatible-local' })
    : null;
  const router = memoryProvider ? createMemoryProviderRouter({ providers: [memoryProvider], defaultProviderId: 'honcho', transport: 'mcp' }) : null;
  const write = router
    ? await router.appendEvents({ identity: { repository: identity.repo, prNumber: identity.prNumber, headSha: identity.headSha }, events: [{ eventType: 'review_completed', domain: 'processing', claimId: 'smoke', severity: 'P2', state: 'accepted', verdict: 'SHIP' }] })
    : await provider.appendEvents({
    ...identity,
    events: [{ eventType: 'review_completed', claimId: 'smoke', severity: 'P2', state: 'accepted', verdict: 'SHIP' }],
  });
  let context;
  let contextAttempts = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    contextAttempts += 1;
    context = router
      ? await router.queryContext({ identity: { repository: identity.repo, prNumber: identity.prNumber, headSha: identity.headSha }, purpose: 'smoke review memory' })
      : await provider.resolveContext({ ...identity, query: 'smoke review memory' });
    if (context.available ?? context.status === 'available') break;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const receipt = {
    mode,
    transport,
    protocol: router ? 'mcp-compatible-local' : 'rest',
    dopplerApi: mode === 'live',
    host: new URL(baseUrl).host,
    workspaceId,
    peerId,
    sessionId,
    configured: health.configured,
    healthAvailable: health.available,
    eventsAccepted: write.accepted,
    writeAccepted: Boolean((write.available ?? write.status === 'accepted') && write.accepted >= 1),
    derivedPending: Boolean((write.available ?? write.status === 'accepted') && write.accepted >= 1 && !(context.available ?? context.status === 'available')),
    representationReady: Boolean(context.available ?? context.status === 'available'),
    providerSource: context.source || write.source || (router ? 'mcp' : 'rest'),
    omittedDomains: [...new Set([...(context.omittedDomains || []), ...(write.omittedDomains || [])])],
    contextAvailable: context.available ?? context.status === 'available',
    contextChars: context.text.length,
    contextAttempts,
    identity: { repo: identity.repo, prNumber: identity.prNumber },
    requests,
  };
  const failures = [];
  if (!health.available) failures.push(`health unavailable (${health.status || 'no status'})`);
  if (!(write.available ?? write.status === 'accepted') || write.accepted < 1) failures.push('event write unavailable');
  if (!(context.available ?? context.status === 'available')) failures.push('representation unavailable');
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
