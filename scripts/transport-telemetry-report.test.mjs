import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReport,
  filterByWindow,
  formatReport,
  parseArgs,
  parseLedger,
  summarizeTransport,
} from './transport-telemetry-report.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-08T12:00:00.000Z');

function record({
  transport = 'openrouter-primary',
  outcome = 'healthy',
  ttft_ms = 1000,
  total_ms = 2000,
  timed_out = false,
  rate_limited = false,
  daysAgo = 0,
}) {
  return {
    schema: 'exampleorg.review-yeti.transport-telemetry.v1',
    run_id: 'r1',
    timestamp: new Date(NOW - daysAgo * DAY_MS).toISOString(),
    transport,
    model: 'deepseek/deepseek-v4-flash-0731',
    enabled: true,
    outcome,
    skipped_reason: outcome === 'skipped' ? 'no_credential' : null,
    http_status: outcome === 'healthy' ? 200 : outcome === 'unhealthy' ? 500 : null,
    failure_class: rate_limited ? 'rate_limit' : null,
    error_code: null,
    ttft_ms: outcome === 'skipped' ? null : ttft_ms,
    total_ms: outcome === 'skipped' ? null : total_ms,
    timed_out,
    rate_limited,
    publication: 'none',
    production_authority: 'unchanged',
  };
}

function fixtureLedgerText() {
  const lines = [
    // openrouter-primary: 10 healthy probes with a clean, easy-to-check percentile ladder plus
    // one rate-limited and one timed-out sample, all inside the 7-day window.
    ...Array.from({ length: 10 }, (_, i) => record({ ttft_ms: (i + 1) * 100, total_ms: (i + 1) * 200, daysAgo: 1 })),
    record({ outcome: 'unhealthy', ttft_ms: 5000, total_ms: 9000, rate_limited: true, daysAgo: 1 }),
    record({ outcome: 'unhealthy', ttft_ms: null, total_ms: 30000, timed_out: true, daysAgo: 1 }),
    // synthetic: one healthy sample inside the window.
    record({ transport: 'synthetic', ttft_ms: 300, total_ms: 900, daysAgo: 2 }),
    // gemini: disabled transport, always skipped (no credential) inside the window.
    record({ transport: 'gemini', outcome: 'skipped', daysAgo: 1 }),
    // A stale openrouter-primary record from 30 days ago must be excluded by the 7-day window.
    record({ ttft_ms: 999999, total_ms: 999999, daysAgo: 30 }),
  ];
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

test('parseLedger skips blank lines and a single corrupted line without losing the rest', () => {
  const text = [
    JSON.stringify(record({})),
    '',
    '   ',
    '{not-json',
    JSON.stringify(record({ transport: 'synthetic' })),
    '',
  ].join('\n');

  const records = parseLedger(text);
  assert.equal(records.length, 2);
  assert.equal(records[0].transport, 'openrouter-primary');
  assert.equal(records[1].transport, 'synthetic');
});

test('filterByWindow keeps records inside N days and drops older ones', () => {
  const records = [
    record({ daysAgo: 1 }),
    record({ daysAgo: 6.9 }),
    record({ daysAgo: 7.1 }),
    record({ daysAgo: 30 }),
  ];
  const kept = filterByWindow(records, 7, NOW);
  assert.equal(kept.length, 2);
});

test('summarizeTransport computes nearest-rank p50/p90 and excludes skipped samples from rates', () => {
  // Ten healthy samples with ttft_ms = 100..1000 in steps of 100. Nearest-rank p50 of 10 sorted
  // values is index ceil(0.5*10)-1 = 4 -> the 5th value (500). p90 is index ceil(0.9*10)-1 = 8 ->
  // the 9th value (900).
  const healthy = Array.from({ length: 10 }, (_, i) => record({ ttft_ms: (i + 1) * 100, total_ms: (i + 1) * 100 }));
  const skipped = [record({ outcome: 'skipped' })];
  const summary = summarizeTransport([...healthy, ...skipped]);

  assert.equal(summary.sample_count, 10);
  assert.equal(summary.skipped_count, 1);
  assert.equal(summary.healthy_count, 10);
  assert.equal(summary.unhealthy_count, 0);
  assert.equal(summary.ttft_p50_ms, 500);
  assert.equal(summary.ttft_p90_ms, 900);
  assert.equal(summary.total_p50_ms, 500);
  assert.equal(summary.total_p90_ms, 900);
  assert.equal(summary.timeout_rate, 0);
  assert.equal(summary.rate_limit_rate, 0);
});

test('summarizeTransport reports null percentiles/rates when nothing was ever probed', () => {
  const summary = summarizeTransport([record({ outcome: 'skipped' }), record({ outcome: 'skipped' })]);
  assert.equal(summary.sample_count, 0);
  assert.equal(summary.skipped_count, 2);
  assert.equal(summary.ttft_p50_ms, null);
  assert.equal(summary.timeout_rate, null);
  assert.equal(summary.rate_limit_rate, null);
});

test('summarizeTransport counts timeout and rate-limit rate over probed samples only', () => {
  const records = [
    record({ outcome: 'healthy' }),
    record({ outcome: 'healthy' }),
    record({ outcome: 'unhealthy', rate_limited: true }),
    record({ outcome: 'unhealthy', timed_out: true }),
    record({ outcome: 'skipped' }),
  ];
  const summary = summarizeTransport(records);
  assert.equal(summary.sample_count, 4);
  assert.equal(summary.rate_limit_rate, 0.25);
  assert.equal(summary.timeout_rate, 0.25);
});

test('buildReport groups the fixture ledger by transport, applies the window, and sorts by name', () => {
  const records = parseLedger(fixtureLedgerText());
  const report = buildReport(records, { days: 7, now: NOW });

  assert.equal(report.days, 7);
  assert.deepEqual(report.transports.map((transport) => transport.name), ['gemini', 'openrouter-primary', 'synthetic']);

  const openrouter = report.transports.find((transport) => transport.name === 'openrouter-primary');
  // 10 healthy (in-window) + 1 rate-limited + 1 timed-out = 12 probed samples; the 30-day-old
  // record is excluded by the window.
  assert.equal(openrouter.sample_count, 12);
  assert.equal(openrouter.healthy_count, 10);
  assert.equal(openrouter.unhealthy_count, 2);
  assert.ok(openrouter.rate_limit_rate > 0 && openrouter.rate_limit_rate < 1);
  assert.ok(openrouter.timeout_rate > 0 && openrouter.timeout_rate < 1);

  const gemini = report.transports.find((transport) => transport.name === 'gemini');
  assert.equal(gemini.sample_count, 0);
  assert.equal(gemini.skipped_count, 1);

  const synthetic = report.transports.find((transport) => transport.name === 'synthetic');
  assert.equal(synthetic.sample_count, 1);
  assert.equal(synthetic.ttft_p50_ms, 300);
});

test('formatReport renders a stable table with an explicit no-data message when empty', () => {
  const empty = formatReport(buildReport([], { days: 7, now: NOW }));
  assert.match(empty, /No telemetry records in this window\./);

  const records = parseLedger(fixtureLedgerText());
  const report = buildReport(records, { days: 7, now: NOW });
  const text = formatReport(report);
  assert.match(text, /transport\s+samples\s+skipped\s+healthy/);
  assert.match(text, /openrouter-primary/);
  assert.match(text, /synthetic/);
  assert.match(text, /gemini/);
});

test('parseArgs applies defaults and parses each flag', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.days, 7);
  assert.equal(defaults.branch, 'telemetry');
  assert.equal(defaults.file, 'transport-ledger.jsonl');
  assert.equal(defaults.ledgerPath, null);

  const custom = parseArgs(['--days', '30', '--branch', 'custom-branch', '--file', 'custom.jsonl', '--ledger', '/tmp/x.jsonl']);
  assert.equal(custom.days, 30);
  assert.equal(custom.branch, 'custom-branch');
  assert.equal(custom.file, 'custom.jsonl');
  assert.equal(custom.ledgerPath, '/tmp/x.jsonl');
});

test('parseArgs rejects a non-positive --days and an unrecognized flag', () => {
  assert.throws(() => parseArgs(['--days', '0']), /--days must be a positive number/);
  assert.throws(() => parseArgs(['--bogus']), /unrecognized argument/);
});
