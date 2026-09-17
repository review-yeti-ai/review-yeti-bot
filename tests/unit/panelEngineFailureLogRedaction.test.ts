import { describe, it, expect, vi, beforeEach } from 'vitest';

// REL-892: `src/panel/panelEngine.ts`'s `runPersona` logs a lane's raw provider error
// message directly at two more sites beyond the already-covered "Persona execution
// failed" line in `executePersonaPanel`:
//   1. The "Fast failover" warn (~line 2264), fired when `isExplicitUpstreamRejection`
//      recognizes an explicit capacity/rate-limit rejection and the lane fails over to
//      the next provider without retrying this one.
//   2. The "Retrying transient error" warn (~line 2308), fired when
//      `isRetryablePanelError` recognizes a transient network/5xx signature and the lane
//      retries the same provider.
// Both sites wrap `panelErrorMessage(error)` in `redactWorkerFailureLogTail` (REL-892,
// reconciled with #821's `panelErrorMessage` typing). A provider SDK can echo request
// headers -- including an outbound bearer token -- back into either error's message.
// These tests drive each site through the real `executePersonaPanel` call path (never
// the redaction helper directly) and assert on the captured `logger.warn` arguments.
const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({ logger: mocks }));

import { executePersonaPanel, extractMessageContentText } from '../../src/panel/panelEngine';
import { CtReviewConfigV3 } from '../../src/config/schema';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

const SECRET_TOKEN = 'sk-TESTSECRETKEY1234567890ABCDEF';

// Matches `isExplicitUpstreamRejection` (contains "429"/"rate limit") but is otherwise a
// generic `Error`, so it also carries a credential-shaped fragment a provider SDK might
// paste into its rejection text verbatim.
const FAST_FAILOVER_ERROR_MESSAGE =
  `OpenRouter provider capacity rejected with status 429 rate limited; token=Bearer ${SECRET_TOKEN}`;

// Matches `isRetryablePanelError`'s generic message pattern ("500") but does NOT match
// `isExplicitUpstreamRejection` (no 429/503/529/rate-limit/capacity wording), so it
// reaches the "Retrying transient error" branch instead of "Fast failover".
const TRANSIENT_RETRY_ERROR_MESSAGE =
  `Connection error: 500 Internal Server Error from upstream; token=Bearer ${SECRET_TOKEN}`;

function buildConfig(): CtReviewConfigV3 {
  // Mirrors panelEnginePersonaFailureLogRedaction.test.ts's buildConfig(): one required
  // lane that succeeds so the panel completes, one optional lane whose single provider
  // ('grok') is the only entry in `providersToTry`, so its every attempt/failover is
  // observable without a second provider's traffic interleaving in the log.
  return {
    ...createDefaultV3Config(),
    version: 3,
    profile: 'balanced',
    quorum: 1,
    personas: [
      {
        id: 'sec-lane',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['src/**'],
        providers: ['claude'],
      },
      {
        id: 'opt-lane',
        enabled: true,
        required: false,
        charter: 'builtin:consistency',
        paths: ['src/**'],
        providers: ['grok'],
      },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 60,
      providers: [
        { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'medium', review_timeout_s: 10, arbiter_timeout_s: 10 },
        { id: 'grok', enabled: true, model: 'deepseek-v4-pro', effort: 'medium', review_timeout_s: 10, arbiter_timeout_s: 10 },
      ],
      arbiter: { order: ['claude'] },
    },
    path_instructions: [],
    rules: [],
    reviewer_effort: 'medium',
    confidence_threshold: 70,
    mascot: true,
    display: { mascot: true },
  };
}

async function runPanelWithOptionalLaneError(errorMessage: string): Promise<void> {
  const mockClient: any = {
    complete: vi.fn(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      const allMsg = JSON.stringify(opts.messages);

      if (allMsg.includes('arbiter')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All good' })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      } else if (allMsg.includes('moderator')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      } else if (opts.model === 'deepseek-v4-pro') {
        // Optional lane (grok) always fails with the fixture error.
        throw new Error(errorMessage);
      } else {
        // Required lane (claude) succeeds.
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      }
    }),
  };

  const result = await executePersonaPanel({
    config: buildConfig(),
    changedFiles: [{ path: 'src/main.ts' }],
    repository: 'owner/repo',
    headSha: 'sha-redaction-test',
    client: mockClient as unknown as OmniRouteClient,
  });

  // Sanity: the panel completes and the optional lane's raw error is still available to
  // the caller for downstream classification/publication -- this only asserts on what
  // reaches the LOG SINK, not on `result` itself.
  expect(result.personas).toHaveLength(1);
  expect(result.optionalFailures).toHaveLength(1);
}

function findLogCall(fragment: string): unknown[] {
  const call = mocks.warn.mock.calls.find((args) => typeof args[0] === 'string' && args[0].includes(fragment));
  if (!call) throw new Error(`logger.warn was never called with a message containing "${fragment}"`);
  return call;
}

describe('REL-892: persona fast-failover log redaction', () => {
  beforeEach(() => {
    mocks.warn.mockClear();
    mocks.error.mockClear();
    mocks.info.mockClear();
    mocks.debug.mockClear();
  });

  it('never emits the raw secret-shaped provider error text to the log sink', async () => {
    await runPanelWithOptionalLaneError(FAST_FAILOVER_ERROR_MESSAGE);

    const [, meta] = findLogCall('Fast failover') as [string, Record<string, unknown>];
    const serializedMeta = JSON.stringify(meta);
    expect(serializedMeta).not.toContain(SECRET_TOKEN);
    expect(serializedMeta).not.toContain('Bearer');
  });

  it('preserves the persona id, provider id, and a useful failure classification', async () => {
    await runPanelWithOptionalLaneError(FAST_FAILOVER_ERROR_MESSAGE);

    const [, meta] = findLogCall('Fast failover') as [string, Record<string, unknown>];
    expect(meta.persona).toBe('opt-lane');
    expect(meta.provider).toBe('grok');
    expect(String(meta.error)).toContain('429');
    expect(String(meta.error)).toContain('rate limited');
    expect(String(meta.error)).toContain('[REDACTED]');
  });
});

describe('REL-892: persona transient-retry log redaction', () => {
  beforeEach(() => {
    mocks.warn.mockClear();
    mocks.error.mockClear();
    mocks.info.mockClear();
    mocks.debug.mockClear();
  });

  it('never emits the raw secret-shaped provider error text to the log sink', async () => {
    await runPanelWithOptionalLaneError(TRANSIENT_RETRY_ERROR_MESSAGE);

    const [, meta] = findLogCall('Retrying transient error') as [string, Record<string, unknown>];
    const serializedMeta = JSON.stringify(meta);
    expect(serializedMeta).not.toContain(SECRET_TOKEN);
    expect(serializedMeta).not.toContain('Bearer');
  });

  it('preserves the persona id, provider id, attempt counters, and a useful failure classification', async () => {
    await runPanelWithOptionalLaneError(TRANSIENT_RETRY_ERROR_MESSAGE);

    const [, meta] = findLogCall('Retrying transient error') as [string, Record<string, unknown>];
    expect(meta.persona).toBe('opt-lane');
    expect(meta.provider).toBe('grok');
    expect(meta.attempt).toBe(1);
    expect(meta.maxAttempts).toBe(2);
    expect(String(meta.error)).toContain('500');
    expect(String(meta.error)).toContain('Internal Server Error');
    expect(String(meta.error)).toContain('[REDACTED]');
  });
});
