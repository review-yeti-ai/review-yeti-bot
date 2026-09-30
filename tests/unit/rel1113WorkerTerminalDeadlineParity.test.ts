import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WORKER_TERMINAL_DEADLINE_ENV,
  WORKER_TERMINAL_DEADLINE_RESERVE_MS,
  WORKER_RECEIPT_RESERVE_MS,
  WORKER_PANEL_RESERVE_MS,
  workerPanelTimeoutMs,
  workerTerminalDeadlineAtMs,
} from '../../src/config/workerTerminalDeadline';
import { TERMINAL_DEADLINE_ENV } from '../../src/review/mapReduceReview';
import { remainingTerminalDeadlineMs, TRANSPORT_RETRY_TERMINAL_MARGIN_MS } from '../../src/panel/panelEngine';

// REL-1113: the worker terminal-deadline env is a contract between the Go operator (producer) and
// the TypeScript worker (consumer). Pin both halves so a rename or reserve change on either side
// fails here instead of silently removing the transport-backoff deadline bound.
describe('REL-1113 worker terminal-deadline contract', () => {
  const jobGo = readFileSync(join(__dirname, '../../k8s-operator/pkg/job/job.go'), 'utf8');

  it('matches the operator env name and Job reserve', () => {
    expect(jobGo).toContain(`const TerminalDeadlineEnv = "${WORKER_TERMINAL_DEADLINE_ENV}"`);
    expect(jobGo).toMatch(new RegExp(`DeadlineReserveSeconds\\s*=\\s*int64\\(${WORKER_TERMINAL_DEADLINE_RESERVE_MS / 1000}\\)`, 'u'));
    expect(TERMINAL_DEADLINE_ENV).toBe(WORKER_TERMINAL_DEADLINE_ENV);
    expect(jobGo).toMatch(new RegExp(`WorkerReceiptReserveSeconds\\s*=\\s*int64\\(${WORKER_RECEIPT_RESERVE_MS / 1000}\\)`, 'u'));
    expect(WORKER_PANEL_RESERVE_MS).toBe(WORKER_TERMINAL_DEADLINE_RESERVE_MS + WORKER_RECEIPT_RESERVE_MS);
  });

  it('parses the RFC 3339 instant the operator projects, and bounds the transport backoff by it', () => {
    const at = Date.parse('2026-09-24T18:40:00.000Z');
    expect(workerTerminalDeadlineAtMs({ [WORKER_TERMINAL_DEADLINE_ENV]: '2026-09-24T18:40:00Z' })).toBe(at);
    expect(workerTerminalDeadlineAtMs({})).toBeUndefined();
    expect(workerTerminalDeadlineAtMs({ [WORKER_TERMINAL_DEADLINE_ENV]: 'not a date' })).toBeUndefined();
    expect(remainingTerminalDeadlineMs({ [WORKER_TERMINAL_DEADLINE_ENV]: '2026-09-24T18:40:00Z' }, at - 90_000))
      .toBe(90_000 - TRANSPORT_RETRY_TERMINAL_MARGIN_MS);
    // Absent: no ADDITIONAL bound; the panel deadline still bounds every backoff.
    expect(remainingTerminalDeadlineMs({}, at)).toBe(Infinity);
  });

  it('subtracts queue/setup and both existing reserves without widening the policy ceiling', () => {
    const deadline = Date.parse('2026-09-30T14:58:56.285Z');
    const env = { [WORKER_TERMINAL_DEADLINE_ENV]: new Date(deadline).toISOString() };
    expect(workerPanelTimeoutMs(1800, env, Date.parse('2026-09-30T14:35:51Z'))).toBe(1_265_285);
    expect(workerPanelTimeoutMs(900, env, deadline - 3_600_000)).toBe(900_000);
    expect(workerPanelTimeoutMs(1800, env, deadline - 120_001)).toBe(1);
    expect(workerPanelTimeoutMs(1800, env, deadline - 120_000)).toBe(0);
    expect(workerPanelTimeoutMs(1800, env, deadline + 1)).toBe(0);
  });

  it('retains legacy absence and policy fallback, but refuses an explicit malformed bound', () => {
    expect(workerPanelTimeoutMs(1800, {}, 0)).toBe(1_800_000);
    expect(workerPanelTimeoutMs(0, {}, 0)).toBe(900_000);
    expect(() => workerPanelTimeoutMs(1800, { [WORKER_TERMINAL_DEADLINE_ENV]: 'bad' }, 0))
      .toThrow('Worker lifecycle deadline is invalid');
  });
});
