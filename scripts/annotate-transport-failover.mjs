#!/usr/bin/env node

/**
 * REL-525: surface malformed-output lane failover as visible evidence.
 *
 * The Review Yeti engine (review-yeti-ai/review-yeti-bot) already retries a persona lane once
 * with reasoning disabled on unparseable findings JSON, then -- when the resolved transport plan
 * for that repository admits more than one enabled transport -- advances to the next transport
 * before marking the lane failed (`prepareDirectFormatRecovery` / `prepareOpenRouterFormatRecovery`
 * plus the per-lane `candidateTransports` walk in `reviewWithModel`, review-pipeline.js). That
 * runtime retry-and-failover behavior lives in the engine repository, not here: this repository
 * owns only the transport plan (policy/review-yeti.json) the engine consumes and the reusable
 * caller workflow (.github/workflows/review-yeti.yml) that invokes it.
 *
 * What this repository is missing is evidence: the engine's per-attempt telemetry (which
 * transport produced the accepted output, and whether a malformed-output retry preceded it) is
 * uploaded as the `review-yeti-provider-telemetry-*` artifact (schema
 * `review-provider-telemetry-v4`) but never summarized where an operator or a later audit can see
 * it without downloading and reading raw JSON. This script reads that already-produced receipt and
 * turns each malformed-output recovery into one visible log line (and, when every enabled
 * transport for a lane was exhausted, a distinct "no alternative transport" line) -- honest
 * evidence surfaced from data the engine already recorded, not a second implementation of the
 * engine's retry/failover decision.
 *
 * Deliberately out of scope: `timeout` / `transient_socket` / `provider_capacity` failure classes
 * keep their existing ADR 0337 (stall-based timeout) handling and are never reported here as
 * `reason=malformed_output`, even when they also happen to cross a transport boundary.
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const MALFORMED_OUTPUT_REASON = 'malformed_output';

/**
 * Walks one lane's `responseAttempts` (already-ordered, oldest first) and reports:
 *   - one entry per attempt sequence where a `malformed_output` outcome is immediately followed
 *     by an attempt on a *different* transport (a real failover), and
 *   - one entry when a lane's *last* recorded attempt was `malformed_output` and the transport
 *     never changed (every enabled transport for that lane was exhausted; there was no
 *     alternative to fail over to).
 * A `malformed_output` attempt followed by another attempt on the *same* transport is the
 * existing bounded same-transport reasoning-disabled retry, not a failover, and is not reported.
 */
export function detectLaneFailovers(lane) {
  const personaId = lane?.personaId || lane?.id || '<unknown>';
  const attempts = Array.isArray(lane?.responseAttempts) ? lane.responseAttempts : [];
  const events = [];
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    if (attempt?.outcome !== 'malformed_output') continue;
    const next = attempts[i + 1];
    if (next && next.transport && next.transport !== attempt.transport) {
      events.push({
        type: 'failover',
        personaId,
        reason: MALFORMED_OUTPUT_REASON,
        failover_from: attempt.transport,
        failover_to: next.transport,
      });
    } else if (i === attempts.length - 1) {
      events.push({
        type: 'exhausted',
        personaId,
        reason: MALFORMED_OUTPUT_REASON,
        transport: attempt.transport,
      });
    }
  }
  return events;
}

/**
 * Applies detectLaneFailovers across every lane in a `review-provider-telemetry-v4` receipt.
 */
export function detectReceiptFailovers(receipt) {
  const lanes = Array.isArray(receipt?.lanes) ? receipt.lanes : [];
  return lanes.flatMap((lane) => detectLaneFailovers(lane));
}

export function formatEvent(event) {
  if (event.type === 'failover') {
    return `[Persona: ${event.personaId}] failed over from transport '${event.failover_from}' `
      + `to transport '${event.failover_to}' after malformed_output (reason=${event.reason}).`;
  }
  return `[Persona: ${event.personaId}] transport '${event.transport}' returned malformed_output `
    + 'with no alternative transport configured for this lane; failed closed as designed '
    + `(reason=${event.reason}).`;
}

export function formatSummaryTable(events) {
  if (events.length === 0) return null;
  const header = '| Persona | Event | From | To | Reason |';
  const divider = '| --- | --- | --- | --- | --- |';
  const rows = events.map((event) => (event.type === 'failover'
    ? `| ${event.personaId} | failover | ${event.failover_from} | ${event.failover_to} | ${event.reason} |`
    : `| ${event.personaId} | exhausted | ${event.transport} | (none) | ${event.reason} |`));
  return [header, divider, ...rows].join('\n');
}

export function readReceipt(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function run(path, { log = console.log, warn = console.warn, summaryWriter = null } = {}) {
  const receipt = readReceipt(path);
  if (receipt?.schemaVersion !== 'review-provider-telemetry-v4') {
    throw new Error(`unsupported provider telemetry schema: ${receipt?.schemaVersion}`);
  }
  const events = detectReceiptFailovers(receipt);
  for (const event of events) {
    warn(`::warning::${formatEvent(event)}`);
  }
  const table = formatSummaryTable(events);
  if (table && summaryWriter) {
    summaryWriter(`### Review Yeti malformed-output transport failover\n\n${table}\n`);
  }
  log(`transport_failover_events=${events.length}`);
  return events;
}

async function main() {
  const path = process.argv[2] || process.env.PROVIDER_TELEMETRY_PATH;
  if (!path) {
    console.log('transport_failover_events=0 (no provider-telemetry-path supplied; nothing to annotate)');
    return;
  }
  let summaryWriter = null;
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    summaryWriter = (text) => {
      appendFileSync(summaryPath, `${text}\n`);
    };
  }
  run(path, { summaryWriter });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::annotate-transport-failover failed: ${error.message}`);
    process.exitCode = 1;
  });
}
