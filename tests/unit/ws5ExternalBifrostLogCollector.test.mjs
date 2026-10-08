import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExternalNormalV2ExactLogCollector } from '../../scripts/ws5-external-bifrost-log-collector.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');

test('joins each actual outbound CID to one exact metadata-only Bifrost row', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ws5-v2-exact-logs-'));
  const runId = `nq_${'a'.repeat(32)}`;
  const caseId = 'ws5-current-1dd-v2-p2';
  const cid = randomUUID();
  const cidSha = sha(cid.toLowerCase());
  const relative = `normal-engine-qualification-store/${runId}/single/${caseId}/provider-identifiers.record/provider-identifiers.json`;
  const file = path.join(root, relative);
  const bytes = `${JSON.stringify([{ callerRequestId: cid, bifrostLogRequestId: cid, upstreamResponseRequestId: null }], null, 2)}\n`;
  const fileSha = sha(bytes);
  const urlAndHeaders = [];
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { mode: 0o600 });
    await writeFile(path.join(path.dirname(file), 'provider-identifiers.sha256'), `${fileSha}\n`, { mode: 0o600 });
    const collector = createExternalNormalV2ExactLogCollector({
      managementBaseUrl: 'https://gateway.example.invalid',
      storeRoot: root,
      readManagementAuthInMemory: async () => ({ username: 'private-user', password: 'private-password' }),
      fetchImpl: async (url, init) => {
        urlAndHeaders.push({ url: String(url), init });
        return new Response(JSON.stringify({ data: [{
          id: cid, provider: 'provider-a', alias: 'pr-reviewer', model: 'model-a', status: 'success',
          service_tier: 'default', fallback_index: 0, upstream_latency_ms: 123,
          token_usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }, cost: 0.0123,
          prompt: 'private prompt must be skipped', response_body: 'private completion must be skipped',
        }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const receipt = await collector({ phaseId: 'ws5-current-source-external-v2', planSha256: 'b'.repeat(64), artifactStoreRoot: root,
      calls: [{ clientRequestIdSha256: cidSha, bifrostLogRequestIdSha256: cidSha }],
      stepReceipts: [{ stepId: 'v2-p2-first', runId, artifactReferences: [{ path: relative, sha256: fileSha }] }],
      deadlineAt: Date.now() + 10_000 });
    assert.equal(receipt.status, 'captured');
    assert.equal(receipt.artifactCount, 1);
    assert.deepEqual(receipt.queriedCidSha256, [cidSha]);
    assert.deepEqual(receipt.unqueriedCidSha256, []);
    assert.match(receipt.artifactSetSha256, /^[a-f0-9]{64}$/u);
    assert.match(receipt.rows[0].exactLogRowSha256, /^[a-f0-9]{64}$/u);
    assert.match(receipt.rows[0].exactLogResponseSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(receipt.rows[0], {
      clientRequestIdSha256: cidSha, bifrostLogRequestIdSha256: cidSha, exactRowCount: 1,
      exactLogRowSha256: receipt.rows[0].exactLogRowSha256,
      exactLogResponseSha256: receipt.rows[0].exactLogResponseSha256,
      bifrostLogStatus: 'success', bifrostLogRowIdSha256: cidSha, upstreamResponseRequestIdSha256: null,
      bifrostParentRequestIdSha256: null, provider: 'provider-a', bifrostAlias: 'pr-reviewer',
      resolvedModel: 'model-a', servedModel: null, serviceTier: 'default', speed: null, inferenceGeo: null,
      gatewayTokenUsage: { prompt: 11, completion: 5, total: 16 }, bifrostCalculatedCostUsd: 0.0123,
    });
    assert.equal(urlAndHeaders.length, 1);
    const queryUrl = new URL(urlAndHeaders[0].url);
    assert.equal(queryUrl.origin, 'https://gateway.example.invalid');
    assert.equal(queryUrl.pathname, '/api/logs');
    assert.equal(queryUrl.searchParams.get('request_id'), cid);
    assert.equal(queryUrl.searchParams.get('limit'), '1');
    assert.equal(urlAndHeaders[0].init.redirect, 'manual');
    assert.equal(new Headers(urlAndHeaders[0].init.headers).get('authorization'),
      `Basic ${Buffer.from('private-user:private-password').toString('base64')}`);
    const returned = JSON.stringify(receipt);
    assert.equal(returned.includes(cid), false);
    assert.equal(returned.includes('private-user'), false);
    assert.equal(returned.includes('private-password'), false);
    assert.equal(returned.includes('private prompt'), false);
    assert.equal(returned.includes('private completion'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects missing, duplicate and mismatched exact rows without returning raw gateway data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ws5-v2-exact-logs-fail-'));
  const runId = `nq_${'c'.repeat(32)}`;
  const caseId = 'ws5-current-1dd-v2-p2';
  const cid = randomUUID();
  const cidSha = sha(cid.toLowerCase());
  const relative = `normal-engine-qualification-store/${runId}/single/${caseId}/provider-identifiers.record/provider-identifiers.json`;
  const directory = path.join(root, 'normal-engine-qualification-store', runId, 'single', caseId, 'provider-identifiers.record');
  const file = path.join(directory, 'provider-identifiers.json');
  const body = `${JSON.stringify([{ callerRequestId: cid, bifrostLogRequestId: cid, upstreamResponseRequestId: null }])}\n`;
  const bodySha = sha(body);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file, body, { mode: 0o600 });
    await writeFile(path.join(directory, 'provider-identifiers.sha256'), `${bodySha}\n`, { mode: 0o600 });
    const request = { phaseId: 'ws5-current-source-external-v2', planSha256: 'd'.repeat(64), artifactStoreRoot: root,
      calls: [{ clientRequestIdSha256: cidSha, bifrostLogRequestIdSha256: cidSha }],
      stepReceipts: [{ runId, artifactReferences: [{ path: relative, sha256: bodySha }] }], deadlineAt: Date.now() + 10_000 };
    const collectorFor = (rows, status = 200) => createExternalNormalV2ExactLogCollector({
      managementBaseUrl: 'https://gateway.example.invalid', storeRoot: root,
      readManagementAuthInMemory: () => ({ username: 'u', password: 'p' }),
      fetchImpl: async () => new Response(JSON.stringify({ data: rows }), { status, headers: { 'content-type': 'application/json' } }) });
    const missing = await collectorFor([])(request);
    assert.equal(missing.status, 'unavailable');
    assert.equal(missing.queriedCallCount, 1);
    assert.equal(missing.matchedRows, 0);
    assert.equal(missing.unqueriedCallCount, 0);
    assert.deepEqual(missing.queriedCidSha256, [cidSha]);
    assert.deepEqual(missing.unqueriedCidSha256, []);
    assert.equal(missing.failureCode, 'external_normal_v2_exact_log_row_missing_or_mismatch');
    const duplicate = await collectorFor([{ id: cid }, { id: cid }])(request);
    assert.equal(duplicate.status, 'unavailable');
    assert.equal(duplicate.failureCode, 'external_normal_v2_exact_log_row_missing_or_mismatch');
    const mismatched = await collectorFor([{ id: randomUUID() }])(request);
    assert.equal(mismatched.status, 'unavailable');
    assert.equal(mismatched.failureCode, 'external_normal_v2_exact_log_row_missing_or_mismatch');
    const redirect = await collectorFor([], 302)(request);
    assert.equal(redirect.status, 'unavailable');
    assert.equal(redirect.failureCode, 'external_normal_v2_exact_log_http_rejected');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stops scheduling metadata reads after the first unmatched CID and hashes unqueried IDs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ws5-v2-exact-logs-stop-'));
  const runId = `nq_${'e'.repeat(32)}`;
  const caseId = 'ws5-current-1dd-v2-p2';
  const relative = `normal-engine-qualification-store/${runId}/single/${caseId}/provider-identifiers.record/provider-identifiers.json`;
  const directory = path.join(root, 'normal-engine-qualification-store', runId, 'single', caseId, 'provider-identifiers.record');
  const file = path.join(directory, 'provider-identifiers.json');
  const rows = Array.from({ length: 10 }, () => {
    const id = randomUUID(); return { callerRequestId: id, bifrostLogRequestId: id, upstreamResponseRequestId: null };
  });
  const body = `${JSON.stringify(rows, null, 2)}\n`;
  const bodySha = sha(body);
  let fetchStarts = 0;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file, body, { mode: 0o600 });
    await writeFile(path.join(directory, 'provider-identifiers.sha256'), `${bodySha}\n`, { mode: 0o600 });
    const calls = rows.map((row) => ({ clientRequestIdSha256: sha(row.callerRequestId.toLowerCase()),
      bifrostLogRequestIdSha256: sha(row.bifrostLogRequestId.toLowerCase()) }));
    const collector = createExternalNormalV2ExactLogCollector({
      managementBaseUrl: 'https://gateway.example.invalid', storeRoot: root,
      readManagementAuthInMemory: () => ({ username: 'u', password: 'p' }),
      fetchImpl: async (url, init) => {
        const index = fetchStarts++;
        if (index === 0) return new Response(JSON.stringify({ data: [{ id: randomUUID() }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
        return new Promise((_, reject) => {
          if (init.signal.aborted) reject(new Error('aborted'));
          else init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });
    const result = await collector({ phaseId: 'ws5-current-source-external-v2', planSha256: 'f'.repeat(64), artifactStoreRoot: root, calls,
      stepReceipts: [{ runId, artifactReferences: [{ path: relative, sha256: bodySha }] }], deadlineAt: Date.now() + 10_000 });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.queriedCallCount, 8, 'bounded concurrency is canceled after the first mismatch');
    assert.equal(result.matchedRows, 0);
    assert.equal(result.unqueriedCallCount, 2);
    assert.equal(result.queriedCidSha256.length, 8);
    assert.equal(result.unqueriedCidSha256.length, 2);
    assert.equal(result.unqueriedCidSetSha256, sha(JSON.stringify(result.unqueriedCidSha256)));
    assert.match(result.unqueriedCidSetSha256, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(result).includes(rows[0].callerRequestId), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('requires a credential-free HTTPS management origin from the private caller', () => {
  const bindings = { readManagementAuthInMemory: () => ({ username: 'u', password: 'p' }), fetchImpl: async () => new Response('{}') };
  for (const managementBaseUrl of [undefined, '', 'http://gateway.example.invalid',
    'https://user:pass@gateway.example.invalid', 'https://gateway.example.invalid/path',
    'https://gateway.example.invalid/?query=1', 'https://gateway.example.invalid/#fragment']) {
    assert.throws(() => createExternalNormalV2ExactLogCollector({ ...bindings, managementBaseUrl }),
      /external_normal_v2_management_origin_invalid/u);
  }
});
