import { describe, it, expect, vi, beforeEach } from 'vitest';

// REL-892: `src/panel/panelEngine.ts`'s `executePersonaPanel` used to log a rejected
// persona lane's raw error message directly (`logger.warn('Persona execution failed',
// { persona: persona.id, error: errorMsg })`), and `errorMsg` can be an unredacted
// provider error message that echoes back prompt/response content, including
// credential-shaped fragments a provider SDK sometimes includes verbatim in its error
// text. This test proves the log line now redacts that free-form text through the
// existing `redactWorkerFailureLogTail` helper while still telling an operator which
// persona failed and roughly why (a bounded, non-secret classification survives).
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

// A realistic provider failure message: it carries both an operator-useful
// classification signal (HTTP 429 / rate limited) AND a credential-shaped fragment a
// provider SDK might paste into its error text verbatim. Only the latter must be
// scrubbed from the log line.
const SECRET_TOKEN = 'sk-TESTSECRETKEY1234567890ABCDEF';
const PROVIDER_ERROR_MESSAGE =
  `OpenRouter provider capacity rejected with status 429 rate limited; token=Bearer ${SECRET_TOKEN}`;

function buildConfig(): CtReviewConfigV3 {
  // Mirrors tests/unit/panelEngineExpansion.test.ts's buildMinimalConfig(): one
  // required lane that succeeds so the panel completes, one optional lane whose
  // provider rejects with PROVIDER_ERROR_MESSAGE and exercises the log line under test.
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

async function runPanelWithFailingOptionalLane(): Promise<void> {
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
        // Optional lane (grok) fails with a provider error carrying secret-shaped text.
        throw new Error(PROVIDER_ERROR_MESSAGE);
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

  // Sanity: the panel itself still completes and the optional lane's raw error is
  // still available to the caller for downstream classification/publication --
  // this test only asserts on what reaches the LOG SINK, not on `result` itself.
  expect(result.personas).toHaveLength(1);
  expect(result.optionalFailures).toHaveLength(1);
  expect(result.optionalFailures[0].error).toContain(SECRET_TOKEN);
}

function findPersonaExecutionFailedCall(): unknown[] {
  const call = mocks.warn.mock.calls.find((args) => args[0] === 'Persona execution failed');
  if (!call) throw new Error('logger.warn was never called with "Persona execution failed"');
  return call;
}

describe('REL-892: persona execution failure log redaction', () => {
  beforeEach(() => {
    mocks.warn.mockClear();
    mocks.error.mockClear();
    mocks.info.mockClear();
    mocks.debug.mockClear();
  });

  it('never emits the raw secret-shaped provider error text to the log sink', async () => {
    await runPanelWithFailingOptionalLane();

    const [, meta] = findPersonaExecutionFailedCall() as [string, Record<string, unknown>];

    // The secret must not appear anywhere in the logged metadata object, in any field.
    const serializedMeta = JSON.stringify(meta);
    expect(serializedMeta).not.toContain(SECRET_TOKEN);
    expect(serializedMeta).not.toContain('Bearer');
    expect(String(meta.error)).not.toContain(SECRET_TOKEN);
  });

  it('preserves the persona id and a useful failure classification in the redacted log line', async () => {
    await runPanelWithFailingOptionalLane();

    const [, meta] = findPersonaExecutionFailedCall() as [string, Record<string, unknown>];

    // Persona identity: an operator must still be able to tell which lane failed.
    expect(meta.persona).toBe('opt-lane');
    // Bounded, non-secret classification: the constructor name of the rejection.
    // `runPersona` fails the lane closed once every provider/attempt for this persona is
    // exhausted, so that -- not the plain `Error` that triggered it -- is what
    // `executePersonaPanel` observes here. REL-1124: this lane failed on a 429 (the path to the
    // model), so it is tagged `PanelInfrastructureError` (a `PanelConfigurationError` subclass),
    // never reported as a configuration error.
    expect(meta.errorType).toBe('PanelInfrastructureError');
    // The redacted free-form remainder still carries the operationally useful part
    // of the message (what failed and why), just not the credential.
    expect(String(meta.error)).toContain('429');
    expect(String(meta.error)).toContain('rate limited');
    expect(String(meta.error)).toContain('[REDACTED]');
  });
});
