import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildTelemetryRecord,
  collectTelemetry,
  encodeLedgerLines,
  TELEMETRY_SCHEMA,
  writeLedger,
} from './transport-telemetry.mjs';

function transport(overrides = {}) {
  return {
    name: 'openrouter-primary',
    enabled: true,
    base_url: 'https://openrouter.test/api/v1',
    api_key_env: 'OPENROUTER_PR_REVIEW_API_KEY',
    model: 'deepseek/deepseek-v4-flash-0731',
    compat: 'openrouter',
    stream: true,
    ...overrides,
  };
}

function policyFixture() {
  return {
    schema: 'exampleorg.review-policy.v1',
    review_yeti: {
      transports: [
        transport(),
        transport({ name: 'gemini', enabled: false, api_key_env: 'GEMINI_API_KEY', model: 'gemini-3.7-flash', compat: 'openai' }),
      ],
    },
  };
}

test('buildTelemetryRecord marks a missing credential as skipped, never a failure', () => {
  const record = buildTelemetryRecord({
    transport: transport({ name: 'gemini', enabled: false }),
    probeResult: { name: 'gemini', status: 'missing' },
    runId: 'run-1',
    timestamp: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(record.schema, TELEMETRY_SCHEMA);
  assert.equal(record.outcome, 'skipped');
  assert.equal(record.skipped_reason, 'no_credential');
  assert.equal(record.enabled, false);
  assert.equal(record.ttft_ms, null);
  assert.equal(record.timed_out, false);
  assert.equal(record.rate_limited, false);
  assert.equal(record.publication, 'none');
  assert.equal(record.production_authority, 'unchanged');
});

test('buildTelemetryRecord classifies a timeout and a rate-limited unhealthy probe', () => {
  const timeoutRecord = buildTelemetryRecord({
    transport: transport(),
    probeResult: { name: 'openrouter-primary', status: 'unhealthy', code: 'ttft_timeout', failure_class: 'timeout_or_connect', elapsed_ms: 30000 },
    runId: 'run-1',
    timestamp: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(timeoutRecord.outcome, 'unhealthy');
  assert.equal(timeoutRecord.timed_out, true);
  assert.equal(timeoutRecord.rate_limited, false);
  assert.equal(timeoutRecord.error_code, 'ttft_timeout');
  assert.equal(timeoutRecord.total_ms, 30000);

  const rateLimitedRecord = buildTelemetryRecord({
    transport: transport(),
    probeResult: { name: 'openrouter-primary', status: 'unhealthy', code: 'http_429', failure_class: 'rate_limit', http: 429, elapsed_ms: 500, ttft_ms: 400 },
    runId: 'run-1',
    timestamp: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(rateLimitedRecord.timed_out, false);
  assert.equal(rateLimitedRecord.rate_limited, true);
  assert.equal(rateLimitedRecord.http_status, 429);
});

test('buildTelemetryRecord records a healthy probe with latency fields', () => {
  const record = buildTelemetryRecord({
    transport: transport(),
    probeResult: { name: 'openrouter-primary', status: 'healthy', http: 200, elapsed_ms: 850, ttft_ms: 300 },
    runId: 'run-1',
    timestamp: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(record.outcome, 'healthy');
  assert.equal(record.http_status, 200);
  assert.equal(record.ttft_ms, 300);
  assert.equal(record.total_ms, 850);
  assert.equal(record.failure_class, null);
});

test('collectTelemetry probes every declared transport, enabled or not, and never throws on an unhealthy or missing result', async () => {
  const logs = [];
  const records = await collectTelemetry({
    policy: policyFixture(),
    env: { OPENROUTER_PR_REVIEW_API_KEY: 'secret-value' }, // GEMINI_API_KEY intentionally absent
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content: '{"ok":true,"review":"SMOKE_OK"}' } }] }),
    }),
    runId: 'run-42',
    now: () => '2026-09-01T00:00:00.000Z',
    log: (line) => logs.push(line),
  });

  assert.equal(records.length, 2);
  const openrouter = records.find((record) => record.transport === 'openrouter-primary');
  const gemini = records.find((record) => record.transport === 'gemini');
  assert.equal(openrouter.outcome, 'healthy');
  assert.equal(openrouter.run_id, 'run-42');
  assert.equal(openrouter.enabled, true);
  assert.equal(gemini.outcome, 'skipped');
  assert.equal(gemini.skipped_reason, 'no_credential');
  assert.equal(gemini.enabled, false);
  // No credential value ever reaches the log stream.
  assert.equal(logs.join('\n').includes('secret-value'), false);
});

test('collectTelemetry records an unhealthy transport rather than throwing (unlike the admission-gating smoke)', async () => {
  const records = await collectTelemetry({
    policy: policyFixture(),
    env: { OPENROUTER_PR_REVIEW_API_KEY: 'secret', GEMINI_API_KEY: 'secret2' },
    fetchImpl: async () => ({ ok: false, status: 500, headers: { get: () => 'application/json' }, json: async () => ({}) }),
    runId: 'run-43',
    now: () => '2026-09-01T00:00:00.000Z',
    log: () => {},
  });
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.outcome === 'unhealthy'));
});

test('collectTelemetry rejects a policy with no declared transports', async () => {
  await assert.rejects(
    collectTelemetry({ policy: { review_yeti: { transports: [] } } }),
    /policy must declare at least one transport/,
  );
});

test('encodeLedgerLines emits one JSON line per record with a trailing newline, and an empty string for zero records', () => {
  const records = [
    buildTelemetryRecord({ transport: transport(), probeResult: { name: 'a', status: 'missing' }, runId: 'r', timestamp: 't' }),
    buildTelemetryRecord({ transport: transport({ name: 'b' }), probeResult: { name: 'b', status: 'missing' }, runId: 'r', timestamp: 't' }),
  ];
  const text = encodeLedgerLines(records);
  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]).transport, 'openrouter-primary');
  assert.equal(text.endsWith('\n'), true);
  assert.equal(encodeLedgerLines([]), '');
});

test('writeLedger appends to a fresh file and to an existing one without truncating it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transport-telemetry-'));
  const path = join(dir, 'nested', 'ledger.jsonl');
  const first = [buildTelemetryRecord({ transport: transport(), probeResult: { name: 'a', status: 'missing' }, runId: 'r1', timestamp: 't1' })];
  const second = [buildTelemetryRecord({ transport: transport(), probeResult: { name: 'a', status: 'missing' }, runId: 'r2', timestamp: 't2' })];

  writeLedger(first, path);
  writeLedger(second, path);

  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).run_id, 'r1');
  assert.equal(JSON.parse(lines[1]).run_id, 'r2');
});
