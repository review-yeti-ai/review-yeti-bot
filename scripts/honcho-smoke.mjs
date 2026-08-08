import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createHonchoMemoryProvider } = require('../src/memory/honchoMemory.js');

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

export async function runSmoke({ mode = 'fixture', manager, fetchImplementation, fixture } = {}) {
  let secretManager = manager;
  let fetchImpl = fetchImplementation;
  let fixtureData = fixture;
  if (!fixtureData) {
    const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'honcho-smoke.json');
    fixtureData = JSON.parse(await readFile(fixturePath, 'utf8'));
  }

  if (mode === 'live') {
    const { DopplerSecretManager } = await import('../dist/mcp/dopplerSecretManager.js');
    // Deliberately disable the CLI so this path proves Doppler REST API resolution.
    secretManager = secretManager || new DopplerSecretManager({ fallbackEnv: false, cliPath: '__review_yeti_doppler_cli_disabled__' });
  } else {
    secretManager = secretManager || fixtureSecretManager(fixtureData.secrets);
    fetchImpl = fetchImpl || (async (url) => {
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

  const provider = createHonchoMemoryProvider({
    config: {
      enabled: true,
      baseUrl: secrets.HONCHO_URL,
      apiKey: secrets.HONCHO_API_KEY,
      workspaceId: secrets.HONCHO_WORKSPACE_ID,
      timeoutMs: 3_000,
      maxContextChars: 4_000,
    },
    fetchImplementation: fetchImpl,
  });
  const identity = {
    repo: mode === 'live' ? (process.env.HONCHO_SMOKE_REPO || 'review-yeti-smoke') : 'fixture/review-yeti-smoke',
    prNumber: mode === 'live' ? Number(process.env.HONCHO_SMOKE_PR || 0) : 0,
    headSha: mode === 'live' ? `honcho-smoke-${Date.now()}` : 'fixture-head',
  };
  const health = await provider.healthCheck();
  const write = await provider.appendEvents({
    ...identity,
    events: [{ eventType: 'review_completed', claimId: 'smoke', severity: 'P2', state: 'accepted', verdict: 'SHIP' }],
  });
  const context = await provider.resolveContext({ ...identity, query: 'smoke review memory' });
  return {
    mode,
    dopplerApi: mode === 'live',
    configured: health.configured,
    healthAvailable: health.available,
    eventsAccepted: write.accepted,
    contextAvailable: context.available,
    contextChars: context.text.length,
    identity: { repo: identity.repo, prNumber: identity.prNumber },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--fixture') ? 'fixture' : 'live';
  try {
    console.log(JSON.stringify(await runSmoke({ mode }), null, 2));
  } catch (error) {
    console.error(`[Honcho smoke] ${error.message || error}`);
    process.exitCode = 1;
  }
}
