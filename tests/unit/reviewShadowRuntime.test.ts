import { afterEach, describe, expect, it } from 'vitest';

const {
  runIsolatedReviewArms,
} = require('../../src/runtime/reviewPipelineRuntime.js');

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const source = {
  kind: 'diff-file',
  repository: 'calltelemetry/example',
  prNumber: 42,
  baseSha,
  headSha,
  diffText: 'diff --git a/src/example.js b/src/example.js\n',
};

afterEach(() => {
  process.exitCode = undefined;
});

describe('isolated review arms', () => {
  it('runs a frozen baseline and candidate with separate identity, state, and publication modes', async () => {
    const calls: any[] = [];
    const result = await runIsolatedReviewArms({
      source,
      cwd: '/tmp/review-yeti-task6',
      publicationMode: 'github',
      env: { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '7' },
      pipelineRunner: async (options: any) => {
        calls.push(options);
        return { verdict: options.env.REVIEW_YETI_RUN_ARM === 'baseline' ? 'SHIP' : 'BLOCK' };
      },
    });

    expect(result.authoritativeArm).toBe('baseline');
    expect(result.baseline).toMatchObject({ status: 'completed', result: { verdict: 'SHIP' } });
    expect(result.candidate).toMatchObject({ status: 'completed', result: { verdict: 'BLOCK' } });
    expect(calls).toHaveLength(2);
    expect(calls[0].env.REVIEW_YETI_RUN_ARM).toBe('baseline');
    expect(calls[1].env.REVIEW_YETI_RUN_ARM).toBe('candidate');
    expect(calls[0].env.GITHUB_RUN_ID).not.toBe(calls[1].env.GITHUB_RUN_ID);
    expect(calls[0].cwd).not.toBe(calls[1].cwd);
    expect(calls[0].publicationMode).toBe('github');
    expect(calls[1].publicationMode).toBe('none');
    expect(calls[0].prContext).toEqual(calls[1].prContext);
    expect(Object.isFrozen(result.input)).toBe(true);
  });

  it('keeps baseline publication and gate state authoritative when the candidate fails', async () => {
    const result = await runIsolatedReviewArms({
      source,
      cwd: '/tmp/review-yeti-task6',
      publicationMode: 'github',
      pipelineRunner: async (options: any) => {
        if (options.env.REVIEW_YETI_RUN_ARM === 'candidate') {
          process.exitCode = 1;
          throw new Error('candidate provider timeout');
        }
        return { verdict: 'SHIP', coverage: { mergeEligible: true }, publication: { success: true } };
      },
    });

    expect(result.authoritative).toMatchObject({ verdict: 'SHIP', coverage: { mergeEligible: true } });
    expect(result.baseline).toMatchObject({ status: 'completed' });
    expect(result.candidate).toMatchObject({ status: 'failed', error: 'candidate provider timeout' });
    expect(result.shadowStatus).toBe('incomplete');
    expect(result.baselinePublication).toMatchObject({ success: true });
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects a shadow run without immutable review identity', async () => {
    await expect(runIsolatedReviewArms({
      source: { ...source, headSha: 'mutable' },
      pipelineRunner: async () => ({ verdict: 'SHIP' }),
    })).rejects.toThrow(/immutable/);
  });
});
