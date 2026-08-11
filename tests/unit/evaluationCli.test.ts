import { describe, expect, it } from 'vitest';
import { runEvaluationCli } from '../../src/cli/evaluationCli.mjs';

function io() {
  let out = '';
  let err = '';
  return {
    stdout: { write: (value: string) => { out += value; } },
    stderr: { write: (value: string) => { err += value; } },
    get out() { return out; },
    get err() { return err; },
  };
}

describe('evaluation cli', () => {
  it('prints help and rejects unknown commands', async () => {
    const streams = io();
    expect(await runEvaluationCli(['--help'], streams)).toBe(0);
    expect(streams.out).toContain('review-yeti eval run');
    expect(await runEvaluationCli(['eval', 'unknown'], streams)).toBe(2);
  });

  it('requires explicit confirmation for live evaluation', async () => {
    const streams = io();
    expect(await runEvaluationCli(['eval', 'run', '--fixture', 'fixture.json', '--mode', 'live'], { ...streams, cwd: process.cwd() })).toBe(2);
    expect(streams.err).toContain('--yes');
  });

  it('runs offline evaluation and writes a receipt', async () => {
    const streams = io();
    const writes: unknown[] = [];
    const receipt = { status: 'PASS', schemaVersion: 'review-yeti-evaluation-v1', runId: 'run', identity: { fixtureId: 'fixture', sourceSha: 'a'.repeat(40) }, request: { mode: 'offline' } };
    const result = await runEvaluationCli(['eval', 'run', '--fixture', 'fixture.json', '--format', 'json'], {
      ...streams,
      cwd: '/tmp',
      sourceSha: 'a'.repeat(40),
      repository: 'review-yeti-ai/review-yeti-bot',
      loadFixture: () => ({ absolutePath: '/tmp/fixture.json', digest: 'b'.repeat(64), matrix: {} }),
      runEvaluation: async () => receipt,
      writeEvaluationReceipt: (value: unknown) => { writes.push(value); return { jsonPath: '/tmp/run.json', markdownPath: '/tmp/run.md' }; },
      renderEvaluationReport: () => 'report',
    });
    expect(result).toBe(0);
    expect(writes).toHaveLength(1);
    expect(streams.out).toContain('"status": "PASS"');
  });
});
