'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const trustedConfig = require('../../src/pi/trustedConfig.js');
const { loadTrustedBaseArtifactFromTrustedContext } = trustedConfig;
const { createPiMcpAdapter, summarizeUntrustedResult } = require('../../src/pi/piMcpAdapter.js');

const identity = { repository: 'acme/widgets', prNumber: '17', headSha: 'a'.repeat(40) };
const baseSha = 'b'.repeat(40);

function trustedBase(overrides = {}) {
  return {
    provenance: 'trusted_base',
    enabled: true,
    endpoint: 'https://api.github.com',
    credentialEnv: 'PI_GITHUB_TOKEN',
    authScopes: ['contents:read', 'pull_requests:read'],
    readOnlyTools: ['github_get_file', 'github_list_changed_files'],
    ...overrides,
  };
}

function loadTrustedConfig(overrides = {}, environment = {}) {
  const artifact = { ...trustedBase(overrides), baseSha };
  const contents = Buffer.from(JSON.stringify(artifact));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-pi-trusted-'));
  const artifactPath = path.join(directory, 'trusted-config.json');
  fs.writeFileSync(artifactPath, contents, { mode: 0o600 });
  const scoped = {
    REVIEW_YETI_TRUSTED_CONFIG_PATH: artifactPath,
    REVIEW_YETI_TRUSTED_CONFIG_SHA: crypto.createHash('sha256').update(contents).digest('hex'),
    REVIEW_YETI_TRUSTED_BASE_SHA: baseSha,
    REVIEW_YETI_TRUSTED_CONFIG_PROVENANCE: 'trusted_base',
    ...environment,
  };
  const before = Object.fromEntries(Object.keys(scoped).map((key) => [key, process.env[key]]));
  Object.assign(process.env, scoped);
  try { return loadTrustedBaseArtifactFromTrustedContext(); } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('requires trusted-base provenance and ignores PR-controlled configuration', () => {
  assert.equal(trustedConfig.resolveTrustedConfig, undefined);
  assert.equal(trustedConfig.loadTrustedBaseConfig, undefined);
  assert.throws(() => loadTrustedBaseArtifactFromTrustedContext({ path: '/tmp/forged.json' }), /trusted context/);
  assert.throws(() => loadTrustedBaseArtifactFromTrustedContext({ trustedBase: trustedBase() }), /trusted context/);
  assert.throws(() => loadTrustedConfig({}, { REVIEW_YETI_TRUSTED_CONFIG_SHA: 'c'.repeat(64) }), /SHA mismatch/);
  assert.throws(() => loadTrustedConfig({ provenance: 'pull_request' }), /provenance/);
  const config = loadTrustedConfig({ enabled: false }, { PI_GITHUB_TOKEN: 'never copied' });
  assert.equal(config.enabled, false);
  assert.equal(config.endpoint, 'https://api.github.com');
  assert.deepEqual(config.provenance, { config: 'trusted_base', endpoint: 'trusted_base', credential: 'environment_reference' });
  assert.equal(config.credentialRef, 'PI_GITHUB_TOKEN');
  assert.equal(Object.values(config).includes('never copied'), false);
});

test('rejects direct injected configuration even when it resembles a trusted profile', () => {
  assert.throws(() => createPiMcpAdapter({
    config: {
      enabled: true,
      endpoint: 'https://api.github.com',
      credentialRef: 'PI_GITHUB_TOKEN',
      authScopes: ['contents:read'],
      readOnlyTools: ['github_get_file'],
      provenance: { config: 'trusted_base' },
    },
    identity,
    connect: async () => ({ callReadOnly: async () => ({}) }),
  }), /resolver-produced trusted configuration/);
});

test('rejects insecure SSRF endpoints and write-capable authorization scopes', () => {
  assert.throws(() => loadTrustedConfig({ endpoint: 'http://api.github.com' }), /HTTPS/);
  assert.throws(() => loadTrustedConfig({ endpoint: 'https://127.0.0.1' }), /allowlisted/);
  assert.throws(() => loadTrustedConfig({ authScopes: ['contents:write'] }), /not read-only/);
});

test('is lazy and honors cancellation before connecting', async () => {
  const connect = async () => { throw new Error('must not connect'); };
  const adapter = createPiMcpAdapter({ config: loadTrustedConfig(), identity, connect });
  const controller = new AbortController();
  controller.abort();

  const result = await adapter.executeReadOnly({ tool: 'github_get_file', args: { path: 'src/app.js' }, signal: controller.signal });
  assert.deepEqual(result, { status: 'cancelled', reason: 'cancelled' });
});

test('executes only stable allowlisted read tools with an exact review identity', async () => {
  const calls = [];
  const adapter = createPiMcpAdapter({
    config: loadTrustedConfig(),
    identity,
    connect: async () => ({ callReadOnly: async (request) => { calls.push(request); return { text: 'immutable blob' }; } }),
  });

  const result = await adapter.executeReadOnly({ tool: 'github_get_file', args: { path: 'src/app.js' } });
  assert.deepEqual(result, { status: 'ok', tool: 'github_get_file', result: { trust: 'untrusted', type: 'object', byteLength: 25, truncated: false } });
  assert.deepEqual(calls[0], { tool: 'github_get_file', args: { path: 'src/app.js' }, identity, signal: undefined });
  await assert.rejects(adapter.executeReadOnly({ tool: 'github_delete_file', args: { path: 'src/app.js' } }), /not allowlisted/);
  await assert.rejects(adapter.executeReadOnly({ tool: 'github_get_file', args: { path: 'src/app.js' }, identity: { ...identity, headSha: 'b'.repeat(40) } }), /identity mismatch/);
});

test('capability refresh can only remove trusted tools and cannot widen the registry', async () => {
  const adapter = createPiMcpAdapter({
    config: loadTrustedConfig({ readOnlyTools: ['github_get_file'] }),
    identity,
    connect: async () => ({ callReadOnly: async () => ({}) }),
  });

  assert.deepEqual(adapter.listReadOnlyTools(), ['github_get_file']);
  assert.deepEqual(adapter.refreshCapabilities(['github_get_file', 'github_read_blob']), ['github_get_file']);
  assert.deepEqual(adapter.refreshCapabilities([]), []);
  await assert.rejects(adapter.executeReadOnly({ tool: 'github_get_file', args: { path: 'src/app.js' } }), /not allowlisted/);
});

test('reconnects one failed read-only call and passes TLS and credential references without copying credentials', async () => {
  const connections = [];
  const closed = [];
  let attempts = 0;
  const adapter = createPiMcpAdapter({
    config: loadTrustedConfig(),
    identity,
    connect: async (options) => {
      connections.push(options);
      return {
        callReadOnly: async () => {
          attempts += 1;
          if (attempts === 1) { const error = new Error('reset'); error.code = 'ECONNRESET'; throw error; }
          return { ok: true };
        },
        close: async () => { closed.push(attempts); },
        readiness: async () => ({ ready: true }),
      };
    },
  });

  assert.deepEqual(await adapter.readiness(), { status: 'ready' });
  assert.deepEqual(await adapter.executeReadOnly({ tool: 'github_get_file', args: { path: 'src/app.js' } }), { status: 'ok', tool: 'github_get_file', result: { trust: 'untrusted', type: 'object', byteLength: 11, truncated: false } });
  assert.equal(connections.length, 2);
  assert.deepEqual(connections[0], { endpoint: 'https://api.github.com', credentialRef: 'PI_GITHUB_TOKEN', authScopes: ['contents:read', 'pull_requests:read'], tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }, signal: undefined });
  assert.deepEqual(closed, [1]);
});

test('propagates cancellation through delayed connect and rechecks it before calling the provider', async () => {
  let resolveConnect;
  const calls = [];
  const controller = new AbortController();
  const adapter = createPiMcpAdapter({
    config: loadTrustedConfig(),
    identity,
    connect: (options) => new Promise((resolve) => { calls.push(options); resolveConnect = () => resolve({ callReadOnly: async () => { throw new Error('must not execute'); } }); }),
  });
  const pending = adapter.executeReadOnly({ tool: 'github_get_file', args: { path: 'src/app.js' }, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  resolveConnect();

  assert.deepEqual(await pending, { status: 'cancelled', reason: 'cancelled' });
  assert.equal(calls[0].signal, controller.signal);
});

test('returns bounded untrusted result metadata without provider prose, URLs, or credentials', async () => {
  const adapter = createPiMcpAdapter({
    config: loadTrustedConfig(),
    identity,
    connect: async () => ({ callReadOnly: async () => ({ text: 'Bearer top-secret at https://evil.invalid/raw', nested: { detail: 'raw provider prose' } }) }),
  });
  const result = await adapter.executeReadOnly({ tool: 'github_get_file', args: { path: 'src/app.js' } });

  assert.deepEqual(result, { status: 'ok', tool: 'github_get_file', result: { trust: 'untrusted', type: 'object', byteLength: 97, truncated: false } });
  assert.equal(JSON.stringify(result).includes('top-secret'), false);
  assert.equal(JSON.stringify(result).includes('evil.invalid'), false);
  assert.equal(JSON.stringify(result).includes('raw provider prose'), false);
});

test('caps successful result metadata for oversized provider payloads', async () => {
  const adapter = createPiMcpAdapter({
    config: loadTrustedConfig(),
    identity,
    connect: async () => ({ callReadOnly: async () => ({ text: 'x'.repeat(10000) }) }),
  });

  const result = await adapter.executeReadOnly({ tool: 'github_get_file', args: { path: 'src/app.js' } });
  assert.deepEqual(result, { status: 'ok', tool: 'github_get_file', result: { trust: 'untrusted', type: 'object', byteLength: 8192, truncated: true } });
  assert.equal(JSON.stringify(result).includes('xxxxx'), false);
});

test('never invokes provider toJSON or walks a pathological result beyond its structural cap', async () => {
  let toJsonCalled = false;
  const pathological = { items: new Array(10_000_000) };
  Object.defineProperty(pathological, 'toJSON', { value: () => { toJsonCalled = true; throw new Error('must not serialize'); } });
  const adapter = createPiMcpAdapter({
    config: loadTrustedConfig(),
    identity,
    connect: async () => ({ callReadOnly: async () => pathological }),
  });

  const result = await adapter.executeReadOnly({ tool: 'github_get_file', args: { path: 'src/app.js' } });
  assert.deepEqual(result, { status: 'ok', tool: 'github_get_file', result: { trust: 'untrusted', type: 'object', byteLength: 8192, truncated: true } });
  assert.equal(toJsonCalled, false);
});

test('rejects Proxy, exotic, and inherited-large provider values without traversing their contents', () => {
  let proxyKeysRead = false;
  const proxy = new Proxy({}, { ownKeys() { proxyKeysRead = true; throw new Error('no provider traversal'); } });
  const inheritedLarge = Object.create({ inherited: 'x'.repeat(10000) });
  inheritedLarge.local = 'safe-looking';

  for (const value of [proxy, new Date(), inheritedLarge]) {
    assert.deepEqual(summarizeUntrustedResult(value), { trust: 'untrusted', type: 'object', byteLength: 8192, truncated: true });
  }
  assert.equal(proxyKeysRead, true);
});

test('stops own-key traversal at the structural cap without constructing a full key list', () => {
  const huge = {};
  for (let index = 0; index < 100_000; index += 1) huge[`key_${index}`] = index;
  assert.deepEqual(summarizeUntrustedResult(huge), { trust: 'untrusted', type: 'object', byteLength: 8192, truncated: true });
});

test('rejects a trusted artifact that grows while its bounded descriptor read is in progress', () => {
  const artifact = { ...trustedBase(), baseSha };
  const contents = Buffer.from(JSON.stringify(artifact));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-pi-growth-'));
  const artifactPath = path.join(directory, 'trusted-config.json');
  fs.writeFileSync(artifactPath, contents, { mode: 0o600 });
  const scoped = {
    REVIEW_YETI_TRUSTED_CONFIG_PATH: artifactPath,
    REVIEW_YETI_TRUSTED_CONFIG_SHA: crypto.createHash('sha256').update(contents).digest('hex'),
    REVIEW_YETI_TRUSTED_BASE_SHA: baseSha,
    REVIEW_YETI_TRUSTED_CONFIG_PROVENANCE: 'trusted_base',
  };
  const before = Object.fromEntries(Object.keys(scoped).map((key) => [key, process.env[key]]));
  const originalReadSync = fs.readSync;
  let grew = false;
  Object.assign(process.env, scoped);
  fs.readSync = (...args) => {
    const bytes = originalReadSync(...args);
    if (!grew) { grew = true; fs.appendFileSync(artifactPath, ' '); }
    return bytes;
  };
  try {
    assert.throws(() => loadTrustedBaseArtifactFromTrustedContext(), /changed during read/);
  } finally {
    fs.readSync = originalReadSync;
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('validates read-only tool arguments without accepting URLs, shell, or traversal input', async () => {
  const adapter = createPiMcpAdapter({ config: loadTrustedConfig(), identity, connect: async () => ({ callReadOnly: async () => ({}) }) });
  await assert.rejects(adapter.executeReadOnly({ tool: 'github_get_file', args: { path: '../.git/config' } }), /invalid path/);
  await assert.rejects(adapter.executeReadOnly({ tool: 'github_get_file', args: { path: 'src/app.js', url: 'https://evil.invalid' } }), /unsupported argument/);
});
