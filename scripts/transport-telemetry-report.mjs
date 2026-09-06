#!/usr/bin/env node

/**
 * Reads the transport telemetry ledger (JSONL, one record per transport per scheduled run;
 * schema `exampleorg.review-yeti.transport-telemetry.v1`, written by transport-telemetry.mjs)
 * and prints per-transport latency and reliability percentiles over a bounded lookback window.
 *
 * This is pure aggregation over already-recorded, already-non-publishing evidence: it never
 * dispatches a network probe, never publishes anything, and never changes provider policy. It is
 * the read path for ADR 0481 / ADR 0467's revisit bar ("per-provider latency, queue, rate-limit...
 * receipts"). "Queue" and "review-quality" evidence are out of this ledger's scope -- this report
 * covers only what a bounded chat-completion smoke can observe: TTFT, total latency, timeout, and
 * rate-limit rate. A future revisit that needs queue-depth or review-quality evidence needs a
 * separate instrument; this report does not fabricate those columns.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { resolve } from 'node:path';

import { isEntrypoint } from './entrypoint-guard.mjs';
export const DEFAULT_LOOKBACK_DAYS = 7;
export const DEFAULT_LEDGER_BRANCH = 'telemetry';
export const DEFAULT_LEDGER_FILE = 'transport-ledger.jsonl';

export function parseLedger(text) {
  const records = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Skip a corrupted/truncated line rather than fail the whole report; the ledger is
      // append-only telemetry, not a transactional log, and a single bad line must not hide
      // every other run's evidence.
    }
  }
  return records;
}

export function filterByWindow(records, days, now = Date.now()) {
  const cutoff = now - Number(days) * 24 * 60 * 60 * 1000;
  return records.filter((record) => {
    const ts = Date.parse(record?.timestamp ?? '');
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const rank = Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.min(rank, sortedValues.length - 1)];
}

function numericValues(records, key) {
  return records
    .map((record) => record?.[key])
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);
}

export function summarizeTransport(records) {
  // Only a real probe (healthy or unhealthy) contributes to latency/rate math. A skipped
  // (no-credential) run measured nothing and must not silently zero out a rate or percentile.
  const probed = records.filter((record) => record.outcome === 'healthy' || record.outcome === 'unhealthy');
  const skipped = records.filter((record) => record.outcome === 'skipped');
  const ttft = numericValues(probed, 'ttft_ms');
  const total = numericValues(probed, 'total_ms');
  const timedOutCount = probed.filter((record) => record.timed_out === true).length;
  const rateLimitedCount = probed.filter((record) => record.rate_limited === true).length;
  const healthyCount = probed.filter((record) => record.outcome === 'healthy').length;
  return {
    sample_count: probed.length,
    skipped_count: skipped.length,
    healthy_count: healthyCount,
    unhealthy_count: probed.length - healthyCount,
    ttft_p50_ms: percentile(ttft, 50),
    ttft_p90_ms: percentile(ttft, 90),
    total_p50_ms: percentile(total, 50),
    total_p90_ms: percentile(total, 90),
    timeout_rate: probed.length > 0 ? timedOutCount / probed.length : null,
    rate_limit_rate: probed.length > 0 ? rateLimitedCount / probed.length : null,
  };
}

export function buildReport(records, { days = DEFAULT_LOOKBACK_DAYS, now = Date.now() } = {}) {
  const windowed = filterByWindow(records, days, now);
  const byTransport = new Map();
  for (const record of windowed) {
    const name = record?.transport;
    if (!name) continue;
    if (!byTransport.has(name)) byTransport.set(name, []);
    byTransport.get(name).push(record);
  }
  const transports = [...byTransport.keys()].sort();
  return {
    days,
    generated_at: new Date(now).toISOString(),
    total_records: windowed.length,
    transports: transports.map((name) => ({ name, ...summarizeTransport(byTransport.get(name)) })),
  };
}

function fmtMs(value) {
  return value == null ? 'n/a' : `${Math.round(value)}ms`;
}

function fmtRate(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function formatReport(report) {
  const lines = [
    `Transport telemetry report (last ${report.days}d, ${report.total_records} record(s), generated ${report.generated_at})`,
    '',
  ];
  if (report.transports.length === 0) {
    lines.push('No telemetry records in this window.');
    return lines.join('\n');
  }
  const header = ['transport', 'samples', 'skipped', 'healthy', 'ttft_p50', 'ttft_p90', 'total_p50', 'total_p90', 'timeout%', 'ratelimit%'];
  const rows = report.transports.map((transport) => [
    transport.name,
    String(transport.sample_count),
    String(transport.skipped_count),
    String(transport.healthy_count),
    fmtMs(transport.ttft_p50_ms),
    fmtMs(transport.ttft_p90_ms),
    fmtMs(transport.total_p50_ms),
    fmtMs(transport.total_p90_ms),
    fmtRate(transport.timeout_rate),
    fmtRate(transport.rate_limit_rate),
  ]);
  const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map((row) => row[i].length)));
  const renderRow = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  lines.push(renderRow(header));
  lines.push(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) lines.push(renderRow(row));
  return lines.join('\n');
}

export function readLedgerFromGit(branch, file, execImpl = execFileSync) {
  return execImpl('git', ['show', `${branch}:${file}`], { encoding: 'utf8' });
}

export function parseArgs(argv) {
  const args = { days: DEFAULT_LOOKBACK_DAYS, branch: DEFAULT_LEDGER_BRANCH, file: DEFAULT_LEDGER_FILE, ledgerPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--days') args.days = Number(argv[i += 1]);
    else if (arg === '--branch') args.branch = argv[i += 1];
    else if (arg === '--file') args.file = argv[i += 1];
    else if (arg === '--ledger') args.ledgerPath = argv[i += 1];
    else throw new Error(`unrecognized argument: ${arg}`);
  }
  if (!Number.isFinite(args.days) || args.days <= 0) {
    throw new Error('--days must be a positive number');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const text = args.ledgerPath
    ? readFileSync(args.ledgerPath, 'utf8')
    : readLedgerFromGit(args.branch, args.file);
  const records = parseLedger(text);
  const report = buildReport(records, { days: args.days });
  console.log(formatReport(report));
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::Transport telemetry report failed: ${error.message}`);
    process.exitCode = 1;
  });
}
