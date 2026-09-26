import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// REL-1138: the panel-side log lines for a lane, moderator or arbiter transport failure
// carry the sanitized cause the gateway client attached (`causeChain`). Driven through
// the real executePersonaPanel with a mocked model client and a captured logger.
const mocks = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/utils/logger', () => ({ logger: mocks }));

import { executePersonaPanel, extractMessageContentText } from '../../src/panel/panelEngine';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import { OpenRouterConnectionError } from '../../src/gateway/openRouterClient';
import type { OmniRouteClient } from '../../src/gateway/omniRouteClient';

function config() {
  return ctReviewConfigV3Schema.parse({
    version: 3,
    profile: 'assertive',
    quorum: 1,
    personas: [{ id: 'arch-lane', enabled: true, required: true, charter: 'builtin:correctness', paths: ['**'], providers: ['claude'] }],
    reviewers: {
      execution: 'personas',
      fallback: 'none',
      overall_timeout_s: 600,
      providers: [{ id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'low', review_timeout_s: 30, arbiter_timeout_s: 30 }],
      arbiter: { order: ['claude'] },
    },
    path_instructions: [],
    rules: [],
  });
}

function socketCut(): OpenRouterConnectionError {
  return new OpenRouterConnectionError('OpenRouter SDK connection failure for model claude-5-sonnet: terminated', {
    causeChain: [
      { depth: 0, name: 'TypeError', message: 'terminated' },
      { depth: 1, name: 'SocketError', code: 'UND_ERR_SOCKET', message: 'other side closed' },
    ],
  });
}

type Role = 'lane' | 'moderator' | 'arbiter';

function client(failRole: Role, failTimes: number) {
  let failures = 0;
  return {
    complete: vi.fn(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() ?? 'test-nonce';
      const role: Role = prompt.includes('Role: ARBITER') ? 'arbiter' : prompt.includes('Role: MODERATOR') ? 'moderator' : 'lane';
      if (role === failRole && failures < failTimes) {
        failures += 1;
        throw socketCut();
      }
      const payload = role === 'arbiter'
        ? { verdict: 'SHIP', rationale: 'ok' }
        : role === 'moderator'
          ? { decision: 'RECONCILED', findings: [] }
          : { decision: 'APPROVE', findings: [] };
      return { model: opts.model, content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(payload)}\nCT_REVIEW_END:${nonce}`, usage: null, costUSD: null };
    }),
  };
}

function run(mockClient: ReturnType<typeof client>) {
  return executePersonaPanel({
    config: config(),
    changedFiles: [{ path: 'src/index.ts', patch: '+ const a = 1;' }],
    repository: 'calltelemetry/repo',
    headSha: 'head-sha-rel-1138',
    client: mockClient as unknown as OmniRouteClient,
  });
}

function warnsMatching(pattern: RegExp): Array<Record<string, unknown>> {
  return mocks.warn.mock.calls.filter((args) => pattern.test(String(args[0]))).map((args) => args[1] as Record<string, unknown>);
}

describe('REL-1138 panel transport-failure cause', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a lane transport retry logs the cause code', async () => {
    vi.useFakeTimers();
    const mockClient = client('lane', 1);
    let settled = false;
    const panel = run(mockClient).finally(() => { settled = true; });
    for (let step = 0; step < 200 && !settled; step += 1) await vi.advanceTimersByTimeAsync(1_000);
    const result = await panel;
    expect(result.arbiter.verdict).toBe('SHIP');

    const [retry] = warnsMatching(/^Transport failure reaching provider 'claude' for persona arch-lane/);
    expect(retry).toBeDefined();
    expect(retry.errorCauseCode).toBe('UND_ERR_SOCKET');
    expect(JSON.stringify(retry.errorCause)).toContain('other side closed');
  });

  it('an arbiter transport failure logs the cause code before the panel fails closed', async () => {
    await expect(run(client('arbiter', 99))).rejects.toThrow(/arbiter failed closed/);
    const [line] = warnsMatching(/^Panel arbiter call failed for provider 'claude'/);
    expect(line).toMatchObject({ role: 'arbiter', provider: 'claude', errorType: 'OpenRouterConnectionError', errorCauseCode: 'UND_ERR_SOCKET' });
  });

  it('a moderator transport failure logs the cause code before it is rethrown', async () => {
    await expect(run(client('moderator', 99))).rejects.toThrow(/terminated/);
    const [line] = warnsMatching(/^Panel moderator call failed for provider 'claude'/);
    expect(line).toMatchObject({ role: 'moderator', provider: 'claude', errorCauseCode: 'UND_ERR_SOCKET' });
  });

  it('a successful panel emits no role-failure line', async () => {
    await run(client('lane', 0));
    expect(warnsMatching(/^Panel (arbiter|moderator) call failed/)).toEqual([]);
  });
});
