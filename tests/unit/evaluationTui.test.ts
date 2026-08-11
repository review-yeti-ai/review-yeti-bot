import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { runEvaluationTui } from '../../src/tui/evaluationTui.mjs';

function streamOutput() {
  let value = '';
  return { stream: { isTTY: true, write: (text: string) => { value += text; } }, get value() { return value; } };
}

describe('evaluation tui', () => {
  it('renders receipt listings when output is not a tty', async () => {
    let output = '';
    const code = await runEvaluationTui({
      input: { isTTY: false },
      output: { isTTY: false, write: (text: string) => { output += text; } },
      listEvaluationReceipts: () => [{ completedAt: 'now', status: 'PASS', mode: 'offline', fixtureId: 'fixture' }],
      cwd: '/tmp',
    });
    expect(code).toBe(0);
    expect(output).toContain('PASS');
    expect(output).toContain('fixture');
  });

  it('runs offline and exits through q in the interactive view', async () => {
    const streams = streamOutput();
    const input = Readable.from(['r fixture.json\n', 'q\n']);
    Object.assign(input, { isTTY: true });
    const receipt = { status: 'PASS' };
    const code = await runEvaluationTui({
      input,
      output: streams.stream,
      cwd: '/tmp',
      sourceSha: 'a'.repeat(40),
      repository: 'review-yeti-ai/review-yeti-bot',
      loadFixture: () => ({ absolutePath: '/tmp/fixture.json', digest: 'b'.repeat(64), matrix: {} }),
      runEvaluation: async () => receipt,
      writeEvaluationReceipt: () => ({ jsonPath: '/tmp/run.json', markdownPath: '/tmp/run.md' }),
      renderEvaluationReport: () => 'PASS report',
      listEvaluationReceipts: () => [],
    });
    expect(code).toBe(0);
    expect(streams.value).toContain('Run configuration');
    expect(streams.value).toContain('PASS report');
  });
});
