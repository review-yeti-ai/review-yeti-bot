#!/usr/bin/env node

/**
 * Scheduled, read-only, per-transport smoke telemetry ledger for ADR 0481 / ADR 0467's revisit
 * bar: "Revisit provider weights and capacities only with account-tier evidence plus per-provider
 * latency, queue, rate-limit, and review-quality receipts" (ADR 0467), and ADR 0481's own "When
 * to revisit": "OpenRouter-primary lane timeouts/BLOCKs recur after this tuning lands" (this
 * ledger records exactly that: TTFT, total latency, timeout, and rate-limit evidence, per run).
 *
 * This script is never part of the review panel, never gates admission, and never publishes a
 * comment, check, review verdict, merge decision, or provider mutation. It reuses the exact
 * bounded probe from review-yeti-smoke.mjs (same TTFT/timeout handling, same HTTP failure
 * classification, same streamed-vs-buffered response parsing) against every transport declared in
 * policy/review-yeti.json -- enabled or disabled -- because the revisit bar needs evidence for the
 * currently-disabled transports (Gemini, Ollama, Fireworks) as much as it needs the active pair.
 * A missing credential is recorded as `skipped: no_credential`, never treated as a failure.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { loadPolicy, probeTransport } from './review-yeti-smoke.mjs';

import { isEntrypoint } from './entrypoint-guard.mjs';
export const TELEMETRY_SCHEMA = 'exampleorg.review-yeti.transport-telemetry.v1';
export const DEFAULT_TELEMETRY_TIMEOUT_MS = 30_000;

// Build one ledger record from a probeTransport() result. probeTransport() already returns
// `{ name, status: 'missing' }` when no credential was supplied, so a skip is detected here
// rather than re-implemented -- there is exactly one place that decides "no credential".
export function buildTelemetryRecord({ transport, probeResult, runId, timestamp }) {
  const skipped = probeResult.status === 'missing';
  const timedOut = probeResult.code === 'ttft_timeout' || probeResult.code === 'timeout';
  const rateLimited = probeResult.failure_class === 'rate_limit';
  return {
    schema: TELEMETRY_SCHEMA,
    run_id: runId,
    timestamp,
    transport: transport.name,
    model: transport.model,
    enabled: transport.enabled === true,
    outcome: skipped ? 'skipped' : probeResult.status,
    skipped_reason: skipped ? 'no_credential' : null,
    http_status: probeResult.http ?? null,
    failure_class: probeResult.failure_class ?? null,
    error_code: probeResult.error_code ?? probeResult.code ?? null,
    ttft_ms: probeResult.ttft_ms ?? null,
    total_ms: probeResult.elapsed_ms ?? null,
    timed_out: timedOut,
    rate_limited: rateLimited,
    // Immutable markers, not runtime-computed state: this run cannot publish anything and cannot
    // change which transport production selects, no matter what it measures.
    publication: 'none',
    production_authority: 'unchanged',
  };
}

export async function collectTelemetry({
  policy,
  policyPath,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TELEMETRY_TIMEOUT_MS,
  runId = 'local',
  now = () => new Date().toISOString(),
  log = console.log,
} = {}) {
  const loadedPolicy = policy || loadPolicy(policyPath);
  const transports = loadedPolicy.review_yeti?.transports;
  if (!Array.isArray(transports) || transports.length === 0) {
    throw new Error('policy must declare at least one transport for telemetry');
  }

  const timestamp = now();
  const records = [];
  for (const transport of transports) {
    const apiKey = env[transport.api_key_env];
    const probeResult = await probeTransport(transport, apiKey, fetchImpl, timeoutMs);
    const record = buildTelemetryRecord({ transport, probeResult, runId, timestamp });
    records.push(record);
    const timing = record.ttft_ms != null ? ` ttft_ms=${record.ttft_ms} total_ms=${record.total_ms}` : '';
    log(`[transport-telemetry] ${record.transport} enabled=${record.enabled} outcome=${record.outcome}${timing}`);
  }
  return records;
}

export function encodeLedgerLines(records) {
  if (records.length === 0) return '';
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

export function writeLedger(records, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  appendFileSync(outputPath, encodeLedgerLines(records));
  return outputPath;
}

async function main() {
  const runId = process.env.GITHUB_RUN_ID || 'manual';
  const timeoutMs = Number(process.env.TRANSPORT_TELEMETRY_TIMEOUT_MS || DEFAULT_TELEMETRY_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('TRANSPORT_TELEMETRY_TIMEOUT_MS must be a positive number');
  }

  const records = await collectTelemetry({ timeoutMs, runId });

  const outputPath = process.env.TRANSPORT_TELEMETRY_OUTPUT
    || resolve(process.env.RUNNER_TEMP || '.', 'transport-telemetry', `${runId}.jsonl`);
  writeLedger(records, outputPath);
  console.log(`[transport-telemetry] wrote ${records.length} record(s) to ${outputPath}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `ledger-path=${outputPath}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const healthy = records.filter((record) => record.outcome === 'healthy').length;
    const unhealthy = records.filter((record) => record.outcome === 'unhealthy').length;
    const skipped = records.filter((record) => record.outcome === 'skipped').length;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      '## Transport telemetry',
      '',
      `- Probed ${records.length} declared transport(s): ${healthy} healthy, ${unhealthy} unhealthy, ${skipped} skipped (no credential).`,
      '- Read-only. No comment, check, review verdict, merge decision, or provider mutation.',
      '- Secret values are intentionally omitted.',
      '',
    ].join('\n'));
  }
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::Transport telemetry failed: ${error.message}`);
    process.exitCode = 1;
  });
}
