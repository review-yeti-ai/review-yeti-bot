import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectLaneFailovers,
  detectReceiptFailovers,
  formatEvent,
  formatSummaryTable,
  run,
  MALFORMED_OUTPUT_REASON,
} from './annotate-transport-failover.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function attempt(transport, outcome, overrides = {}) {
  return { attempt: 1, transport, outcome, failureClass: null, ...overrides };
}

function lane(personaId, responseAttempts) {
  return { personaId, responseAttempts };
}

function receipt(lanes) {
  return { schemaVersion: 'review-provider-telemetry-v4', repository: 'exampleorg/example-api', prNumber: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), lanes };
}

test('(a) malformed on primary, parseable on secondary: lane succeeds, receipt shows failover', () => {
  const l = lane('security', [
    attempt('ollama', MALFORMED_OUTPUT_REASON),
    attempt('openrouter-primary', 'parsed'),
  ]);
  const events = detectLaneFailovers(l);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: 'failover',
    personaId: 'security',
    reason: MALFORMED_OUTPUT_REASON,
    failover_from: 'ollama',
    failover_to: 'openrouter-primary',
  });
  assert.match(formatEvent(events[0]), /failed over from transport 'ollama' to transport 'openrouter-primary'.*reason=malformed_output/);
});

test('(b) malformed on all enabled transports: lane fails with the exhausted message', () => {
  // Same-transport reasoning-disabled retry (not a failover) followed by exhaustion: the final
  // recorded attempt is still malformed_output and no later attempt exists.
  const l = lane('security', [
    attempt('ollama', MALFORMED_OUTPUT_REASON),
    attempt('ollama', MALFORMED_OUTPUT_REASON),
  ]);
  const events = detectLaneFailovers(l);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'exhausted');
  assert.equal(events[0].transport, 'ollama');
  assert.match(formatEvent(events[0]), /no alternative transport configured for this lane; failed closed as designed/);
});

test('(c) an Ollama-only repository with a single transport: fails with the no-alternative message, never invents a disallowed provider', () => {
  const l = lane('security', [
    attempt('ollama', MALFORMED_OUTPUT_REASON),
  ]);
  const events = detectLaneFailovers(l);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'exhausted');
  assert.equal(events[0].transport, 'ollama');
  const message = formatEvent(events[0]);
  assert.match(message, /no alternative transport configured for this lane/);
  // The message must never name a transport this lane's plan did not actually carry.
  assert.doesNotMatch(message, /synthetic|glm|fireworks|gemini/);
});

test('(d) a timeout is NOT treated as malformed output: no failover event on a stall-classified transport change', () => {
  const l = lane('performance', [
    attempt('openrouter-primary', 'transport_error', { failureClass: 'timeout' }),
    attempt('synthetic', 'parsed'),
  ]);
  const events = detectLaneFailovers(l);
  assert.equal(events.length, 0, 'a timeout-driven transport change must not be reported as a malformed_output failover');
});

test('a malformed_output attempt followed by a same-transport retry is the existing bounded retry, not a failover', () => {
  const l = lane('architecture', [
    attempt('synthetic', MALFORMED_OUTPUT_REASON),
    attempt('synthetic', 'parsed'),
  ]);
  const events = detectLaneFailovers(l);
  assert.equal(events.length, 0);
});

test('detectReceiptFailovers walks every lane in a review-provider-telemetry-v4 receipt', () => {
  const r = receipt([
    lane('security', [attempt('ollama', MALFORMED_OUTPUT_REASON), attempt('openrouter-primary', 'parsed')]),
    lane('testing', [attempt('openrouter-primary', 'parsed')]),
  ]);
  const events = detectReceiptFailovers(r);
  assert.equal(events.length, 1);
  assert.equal(events[0].personaId, 'security');
});

test('formatSummaryTable returns null for zero events and a row per event otherwise', () => {
  assert.equal(formatSummaryTable([]), null);
  const events = detectLaneFailovers(lane('security', [
    attempt('ollama', MALFORMED_OUTPUT_REASON),
    attempt('openrouter-primary', 'parsed'),
  ]));
  const table = formatSummaryTable(events);
  assert.match(table, /\| security \| failover \| ollama \| openrouter-primary \| malformed_output \|/);
});

test('run() rejects a receipt with an unexpected schema version instead of silently annotating stale evidence', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ct-transport-failover-'));
  const path = join(tempDir, 'receipt.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 'review-provider-telemetry-v3', lanes: [] }));
  try {
    assert.throws(() => run(path), /unsupported provider telemetry schema/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('run() logs one warning per event and a machine-readable total, and writes a step summary', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ct-transport-failover-'));
  const path = join(tempDir, 'receipt.json');
  writeFileSync(path, JSON.stringify(receipt([
    lane('security', [attempt('ollama', MALFORMED_OUTPUT_REASON), attempt('openrouter-primary', 'parsed')]),
    lane('testing', [attempt('ollama', MALFORMED_OUTPUT_REASON)]),
  ])));
  const warnings = [];
  const logs = [];
  const summaries = [];
  try {
    const events = run(path, {
      log: (line) => logs.push(line),
      warn: (line) => warnings.push(line),
      summaryWriter: (text) => summaries.push(text),
    });
    assert.equal(events.length, 2);
    assert.equal(warnings.length, 2);
    assert.ok(warnings[0].startsWith('::warning::'));
    assert.ok(warnings[1].startsWith('::warning::'));
    assert.equal(logs.length, 1);
    assert.equal(logs[0], 'transport_failover_events=2');
    assert.equal(summaries.length, 1);
    assert.match(summaries[0], /malformed-output transport failover/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('run() is a no-op (zero events, no summary write) when the receipt has no malformed-output evidence', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ct-transport-failover-'));
  const path = join(tempDir, 'receipt.json');
  writeFileSync(path, JSON.stringify(receipt([
    lane('security', [attempt('openrouter-primary', 'parsed')]),
  ])));
  const summaries = [];
  try {
    const events = run(path, { log: () => {}, warn: () => {}, summaryWriter: (text) => summaries.push(text) });
    assert.equal(events.length, 0);
    assert.equal(summaries.length, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
