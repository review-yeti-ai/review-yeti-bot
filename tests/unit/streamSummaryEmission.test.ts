// STREAM_SUMMARY emission at the reviewWithModel call site (ct-meta
// docs/plans/2026-08-20-review-yeti-telemetry.md, design §4.1: "one line per attempt, ALWAYS --
// success and failure"). These tests drive the real `reviewWithModel`/`reviewWithTransports`
// entry points end to end with mocked fetch, exactly like tests/unit/reviewTelemetry.test.ts, and
// assert on captured console output -- the actual operator-visible artifact.
import { describe, expect, it, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import { sseBody } from '../support/streamableFetchStub';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const DEFAULT_INVESTIGATION_MESSAGES = [
  { role: 'system', content: 'You are a bounded code-review panel reviewer.' },
  { role: 'user', content: '<review_manifest></review_manifest><pull_request_diff></pull_request_diff>' },
];

function reviewWithModel(persona: any, options: any = {}) {
  return pipeline.reviewWithModel(
    persona,
    [{ path: 'src/app.js', patch: '+const safe = true;', addedLines: [{ text: 'const safe = true;' }] }],
    { repo: 'acme/widget', prNumber: '42', headSha: 'b'.repeat(40) },
    {},
    { rawTurn: true, investigationMessages: DEFAULT_INVESTIGATION_MESSAGES, ...options },
  );
}

function captureLogLines() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); });
  return { lines, restore: () => spy.mockRestore() };
}

function captureWarnLines() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); });
  return { lines, restore: () => spy.mockRestore() };
}

describe('STREAM_SUMMARY carries queue_wait_ms from the stream-gate acquire site (design §4.1 field list)', () => {
  it('reviewWithTransports threads the measured queue_wait_ms/queued_ahead_at_start into the STREAM_SUMMARY context', async () => {
    const { createStreamingLaneGate, PERSONA_CHARTERS } = pipeline;
    const securityPersona = PERSONA_CHARTERS.find((p: any) => p.id === 'security');
    const log = captureLogLines();
    let streamGate: any;
    try {
      streamGate = createStreamingLaneGate(1);
      const releaseFirst = await streamGate.acquire();
      const secondAcquire = pipeline.reviewWithTransports(
        securityPersona,
        [{ path: 'src/app.js', patch: '+x', addedLines: [{ text: 'x' }] }],
        { repo: 'acme/widget', prNumber: '1' },
        null,
        {
          rawTurn: true,
          investigationMessages: DEFAULT_INVESTIGATION_MESSAGES,
          apiKey: 'k',
          baseUrl: 'https://api.fireworks.ai/inference/v1',
          model: 'test/model',
          maxAttempts: 1,
          timeoutMs: 5_000,
          ttftMs: 5_000,
          transportName: 'fireworks',
          streamGate,
          transportPlan: [{ name: 'fireworks', apiKey: 'k', baseUrl: 'https://api.fireworks.ai/inference/v1', model: 'test/model', timeoutMs: 5_000 }],
          fetchImplementation: async () => {
            const payload = { model: 'test/model', provider: 'fireworks', id: 'gen_q', choices: [{ message: { content: '{"findings":[]}' } }] };
            return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload, body: sseBody(payload) };
          },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      releaseFirst();
      await secondAcquire;
    } finally {
      log.restore();
    }

    const summaryLines = log.lines.filter((line) => line.startsWith('STREAM_SUMMARY '));
    expect(summaryLines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(summaryLines[summaryLines.length - 1].slice('STREAM_SUMMARY '.length));
    expect(parsed.queue_wait_ms).toBeGreaterThanOrEqual(20);
    expect(typeof parsed.queued_ahead_at_start).toBe('number');
  });
});

describe('STREAM_SUMMARY emission (design §4.1)', () => {
  it('emits exactly one STREAM_SUMMARY line for a successful attempt, and it is schema-valid', async () => {
    const log = captureLogLines();
    try {
      await reviewWithModel(
        { id: 'security', name: 'Security', charter: 'Review safely.' },
        {
          model: 'model-a', apiKey: 'test-key', baseUrl: 'https://api.example.test', maxAttempts: 1,
          fetchImplementation: async () => {
            const payload = { model: 'model-a', provider: 'provider-a', id: 'gen_123', choices: [{ message: { content: '{"findings":[]}' } }] };
            return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload, body: sseBody(payload) };
          },
        },
      );
    } finally {
      log.restore();
    }

    const summaryLines = log.lines.filter((line) => line.startsWith('STREAM_SUMMARY '));
    expect(summaryLines).toHaveLength(1);
    const parsed = JSON.parse(summaryLines[0].slice('STREAM_SUMMARY '.length));
    expect(parsed).toMatchObject({ persona: 'security', stream_end_reason: 'done_marker', budget_exceeded: 'none' });
    expect(log.lines.some((line) => line.startsWith('STREAM_SUMMARY_INVALID'))).toBe(false);
  });

  it('emits STREAM_SUMMARY on a failed attempt too, and the TIMEOUT autopsy line carries the same trace', async () => {
    const log = captureLogLines();
    const warn = captureWarnLines();
    try {
      await reviewWithModel(
        { id: 'performance', name: 'Performance', charter: 'Review perf.' },
        {
          model: 'model-a', apiKey: 'test-key', baseUrl: 'https://api.example.test', maxAttempts: 1,
          ttftMs: 20,
          fetchImplementation: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
          }),
        },
      );
    } finally {
      log.restore();
      warn.restore();
    }

    const summaryLines = log.lines.filter((line) => line.startsWith('STREAM_SUMMARY '));
    expect(summaryLines).toHaveLength(1);
    const parsed = JSON.parse(summaryLines[0].slice('STREAM_SUMMARY '.length));
    expect(parsed.budget_exceeded).toBe('ttft');
    expect(parsed.persona).toBe('performance');

    const timeoutLines = warn.lines.filter((line) => line.includes('TIMEOUT phase='));
    expect(timeoutLines).toHaveLength(1);
    expect(timeoutLines[0]).toMatch(/trace=\{.*"budget_exceeded":"ttft".*\}/);
    // The contradiction tripwire must never fire for a genuinely aborted stream.
    expect(warn.lines.some((line) => line.includes('TELEMETRY_INVALID'))).toBe(false);
  });

  it('never renders a STREAM_SUMMARY_INVALID marker for a normal completed/failed attempt (no contradiction, no schema drift)', async () => {
    const log = captureLogLines();
    try {
      await reviewWithModel(
        { id: 'testing', name: 'Testing', charter: 'Review tests.' },
        {
          model: 'model-a', apiKey: 'test-key', baseUrl: 'https://api.example.test', maxAttempts: 1,
          fetchImplementation: async () => ({ ok: false, status: 500, text: async () => '{"error":"boom"}' }),
        },
      );
    } finally {
      log.restore();
    }
    expect(log.lines.some((line) => line.startsWith('STREAM_SUMMARY_INVALID'))).toBe(false);
    expect(log.lines.some((line) => line.startsWith('STREAM_SUMMARY '))).toBe(true);
  });
});
