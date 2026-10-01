import { afterEach, describe, expect, it, vi } from 'vitest';

const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const RECEIVED_AT = 1_790_060_000_000;

describe('trigger_review terminal deadline parity', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    { label: 'default', configuredMs: undefined, expectedMs: 900_000 },
    { label: 'explicit', configuredMs: '900000', expectedMs: 900_000 },
  ])('uses the shared $label admission window', async ({ configuredMs, expectedMs }) => {
    // The shared deadline constant is resolved once at module load. Import the
    // MCP tool after changing the env to prove it observes the same setting.
    vi.stubEnv('REVIEW_YETI_TERMINAL_DEADLINE_MS', configuredMs);
    vi.resetModules();
    const { TERMINAL_DEADLINE_MS } = await import('../../src/config/terminalDeadline');
    const { createTriggerReviewTool } = await import('../../src/mcp/server/tools/triggerReview');
    const admit = vi.fn(async (_input: any) => ({ run: { runId: `run_${'e'.repeat(32)}` } }));
    const identity = {
      owner: 'calltelemetry', repo: 'ct-meta', prNumber: 3587,
      headSha: HEAD_SHA, baseSha: BASE_SHA,
    };
    const tool = createTriggerReviewTool({
      admissionRepository: { admit },
      resolveGitHubPullRequest: async () => ({
        headSha: HEAD_SHA, baseSha: BASE_SHA,
        repositoryId: 190468701, installationId: 2222,
      }),
      authoritativePublishing: {
        expectedAppId: 4385771,
        repositoryIds: [190468701],
        resolver: {
          resolve: async () => ({
            identity,
            prepared: { policy: { effectivePolicyDigest: 'c'.repeat(64) } },
          }),
        },
      },
      now: () => RECEIVED_AT,
    } as any);

    await tool.execute({
      owner: 'calltelemetry', repo: 'ct-meta', pull_number: 3587,
      head_sha: HEAD_SHA,
    });

    expect(admit).toHaveBeenCalledOnce();
    const admitted = admit.mock.calls[0][0];
    expect(admitted.receivedAt).toBe(RECEIVED_AT);
    expect(TERMINAL_DEADLINE_MS).toBe(expectedMs);
    expect(admitted.terminalDeadline - admitted.receivedAt).toBe(TERMINAL_DEADLINE_MS);
  });

  it('rejects an out-of-contract configured window instead of ignoring the shared setting', async () => {
    vi.stubEnv('REVIEW_YETI_TERMINAL_DEADLINE_MS', '2400000');
    vi.resetModules();

    await expect(import('../../src/config/terminalDeadline'))
      .rejects.toThrow(/must equal the 900000 millisecond end-to-end review ceiling/i);
  });
});
