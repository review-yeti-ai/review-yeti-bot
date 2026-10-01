import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WORKER_TERMINAL_DEADLINE_ENV,
  WORKER_TERMINAL_DEADLINE_RESERVE_MS,
  WORKER_RECEIPT_RESERVE_MS,
  WORKER_PANEL_RESERVE_MS,
  WORKER_SYNTHESIS_AND_PUBLICATION_RESERVE_MS,
  workerPanelTimeoutMs,
  workerTerminalDeadlineAtMs,
  workerPanelDeadlineBudget,
  WORKER_DEADLINE_FLOOR_MARGIN_MS,
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
    expect(WORKER_PANEL_RESERVE_MS).toBe(WORKER_SYNTHESIS_AND_PUBLICATION_RESERVE_MS);
    expect(WORKER_PANEL_RESERVE_MS).toBe(300_000);
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

  it('subtracts queue/setup and the protected closeout reserve without widening the policy ceiling', () => {
    const deadline = Date.parse('2026-09-30T14:58:56.285Z');
    const env = { [WORKER_TERMINAL_DEADLINE_ENV]: new Date(deadline).toISOString() };
    expect(workerPanelTimeoutMs(1800, env, Date.parse('2026-09-30T14:35:51Z'))).toBe(1_085_285);
    expect(workerPanelTimeoutMs(900, env, deadline - 3_600_000)).toBe(900_000);
    expect(workerPanelTimeoutMs(1800, env, deadline - 300_001)).toBe(1);
    expect(workerPanelTimeoutMs(1800, env, deadline - 300_000)).toBe(0);
    expect(workerPanelTimeoutMs(1800, env, deadline + 1)).toBe(0);
  });

  it('retains legacy absence and policy fallback, but refuses an explicit malformed bound', () => {
    expect(workerPanelTimeoutMs(1800, {}, 0)).toBe(1_800_000);
    expect(workerPanelTimeoutMs(0, {}, 0)).toBe(1_200_000);
    expect(() => workerPanelTimeoutMs(1800, { [WORKER_TERMINAL_DEADLINE_ENV]: 'bad' }, 0))
      .toThrow('Worker lifecycle deadline is invalid');
  });
});

describe('REL-1211 fixed model-work budget', () => {
  const now = Date.parse('2026-09-30T16:00:50Z');
  const terminalEnv = (at: number) => ({ [WORKER_TERMINAL_DEADLINE_ENV]: new Date(at).toISOString() });
  it('pins the five-minute closeout cutoff ahead of the Job hard stop', () => {
    const go = readFileSync(join(__dirname, '../../k8s-operator/pkg/job/job.go'), 'utf8');
    expect(go).toMatch(new RegExp(`WorkerReceiptReserveSeconds\\s*=\\s*int64\\(${WORKER_RECEIPT_RESERVE_MS / 1000}\\)`, 'u'));
    expect(WORKER_DEADLINE_FLOOR_MARGIN_MS).toBe(0);
    const terminal = Date.parse('2026-09-30T16:29:47.875Z');
    const hardStop = now + (Math.floor((terminal - now) / 1_000) - 60) * 1_000;
    const budget = workerPanelDeadlineBudget(1_800, terminalEnv(terminal), now);
    expect(budget.deadlineAtMs).toBe(terminal - 300_000);
    expect(hardStop - budget.deadlineAtMs).toBeGreaterThanOrEqual(239_000);
    expect(budget.terminalBound).toBe(true);
  });
  it.each([undefined, '', '   '])('preserves absent/empty local bounds: %s', (raw) => {
    expect(workerPanelDeadlineBudget(5, { [WORKER_TERMINAL_DEADLINE_ENV]: raw }, now))
      .toEqual({ deadlineAtMs: now + 5_000, timeoutMs: 5_000, terminalBound: false });
  });
  it('retains upstream refusal of an explicit malformed lifecycle deadline', () => {
    expect(() => workerPanelDeadlineBudget(5, { [WORKER_TERMINAL_DEADLINE_ENV]: 'not a date' }, now))
      .toThrow('Worker lifecycle deadline is invalid');
  });
  it.each([NaN, Infinity, -Infinity])('refuses a nonfinite admitted clock: %s', (clock) => {
    expect(() => workerPanelDeadlineBudget(5, terminalEnv(now + 200_000), clock))
      .toThrow('Worker lifecycle deadline is invalid');
    expect(() => workerPanelDeadlineBudget(5, {}, clock))
      .toThrow('Worker lifecycle deadline is invalid');
  });
  it.each([0, -1, NaN, Infinity])('preserves the configured fallback: %s', (seconds) => {
    expect(workerPanelDeadlineBudget(seconds, {}, now).timeoutMs).toBe(1_200_000);
  });
  it('takes the earlier relative bound without consuming a later admission window', () => {
    expect(workerPanelDeadlineBudget(5, terminalEnv(now + 400_000), now))
      .toEqual({ deadlineAtMs: now + 5_000, timeoutMs: 5_000, terminalBound: false });
    expect(workerPanelDeadlineBudget(0.0001, {}, now).timeoutMs).toBe(1);
  });
  it.each([0, -1, -100_000])('represents exhausted budget as zero, not a minimum provider call: %s', (remaining) => {
    expect(workerPanelDeadlineBudget(1_800, terminalEnv(now + 300_000 + remaining), now))
      .toEqual({ deadlineAtMs: now + remaining, timeoutMs: 0, terminalBound: true });
  });
});
