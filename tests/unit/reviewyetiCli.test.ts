import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { main } = require('../../src/cli/reviewyetiCli.js');

function stream() { let text = ''; return { write(value: string) { text += value; }, get text() { return text; } }; }

describe('reviewyeti review command', () => {
  it('keeps JSON stdout pure and never publishes in local mode', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-cli-'));
    const diffFile = path.join(directory, 'change.diff');
    fs.writeFileSync(diffFile, 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-old\n+new\n');
    const stdout = stream();
    const stderr = stream();
    let received;
    const code = await main(['review', '--diff-file', diffFile, '--json'], {
      cwd: directory,
      env: { OPENROUTER_API_KEY: 'fixture-key' },
      stdout,
      stderr,
      runReviewPipeline: async (options: any) => { received = options; return { verdict: 'SHIP', coverage: { status: 'complete', mergeEligible: true }, publication: { mode: options.publicationMode, postedViaGh: false } }; },
    });
    expect(code).toBe(0);
    expect(() => JSON.parse(stdout.text.trim())).not.toThrow();
    expect(stderr.text).toContain('Reviewing immutable source');
    expect(received.publicationMode).toBe('none');
  });

  it('rejects mixed source modes', async () => {
    const stderr = stream();
    const code = await main(['review', '--base', 'a'.repeat(40), '--head', 'b'.repeat(40), '--diff-file', 'x'], { stderr, stdout: stream() });
    expect(code).toBe(2);
    expect(stderr.text).toMatch(/exactly one source mode/);
  });
});
