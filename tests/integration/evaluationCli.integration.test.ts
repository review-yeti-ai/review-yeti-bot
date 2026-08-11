import { describe, expect, it } from 'vitest';
import { runEvaluationCli } from '../../src/cli/evaluationCli.mjs';

describe('evaluation cli integration', () => {
  it('runs the checked-in offline fixture with machine-readable output', async () => {
    let output = '';
    let errors = '';
    const code = await runEvaluationCli([
      'eval', 'run', '--fixture', 'tests/fixtures/review-intelligence/offline-promotion-matrix.json', '--format', 'json',
    ], {
      cwd: process.cwd(),
      sourceSha: 'a'.repeat(40),
      repository: 'review-yeti-ai/review-yeti-bot',
      stdout: { write: (value: string) => { output += value; } },
      stderr: { write: (value: string) => { errors += value; } },
    });
    expect(code).toBe(0);
    expect(JSON.parse(output).receipt.status).toBe('PASS');
    expect(errors).toContain('Evaluation completed');
  });
});
