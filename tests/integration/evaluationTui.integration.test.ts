import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { runEvaluationTui } from '../../src/tui/evaluationTui.mjs';

describe('evaluation tui integration', () => {
  it('falls back to a receipt table for redirected output', async () => {
    let output = '';
    const code = await runEvaluationTui({
      input: { isTTY: false },
      output: { isTTY: false, write: (text: string) => { output += text; } },
      cwd: process.cwd(),
      listEvaluationReceipts: () => [{ completedAt: 'now', status: 'PASS', mode: 'offline', fixtureId: 'offline-promotion-matrix' }],
    });
    expect(code).toBe(0);
    expect(output).toContain('offline-promotion-matrix');
  });
});
