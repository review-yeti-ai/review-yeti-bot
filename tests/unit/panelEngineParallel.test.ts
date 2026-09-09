import { timeBudgetMs } from '../support/timeBudget';
import { describe, it, expect, vi } from 'vitest';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import { CtReviewConfigV3 } from '../../src/config/schema';
import { ReviewModelClient, OpenRouterResponse } from '../../src/gateway/openRouterClient';

// Built via the real parser (as src/panel/__tests__/panelEngine.test.ts does) rather than a
// hand-authored literal, so the config satisfies every required/defaulted field of the v3
// schema without duplicating its defaults by hand here.
const mockYaml = `
version: 3
quorum: 1
reviewer_effort: medium
reviewers:
  execution: personas
  overall_timeout_s: 60
  fallback: ordered
  arbiter:
    order: [test-prov]
  providers:
    - id: test-prov
      model: google/gemini-3.7-flash:medium
      effort: medium
      enabled: true
      review_timeout_s: 30
      arbiter_timeout_s: 30
personas:
  - id: security
    enabled: true
    required: true
    paths: ["**/*"]
    providers: [test-prov]
    charter: Security checks
  - id: performance
    enabled: true
    required: true
    paths: ["**/*"]
    providers: [test-prov]
    charter: Performance checks
  - id: architecture
    enabled: true
    required: true
    paths: ["**/*"]
    providers: [test-prov]
    charter: Architecture checks
`;

describe('Panel Engine Parallel Execution', () => {
  const mockConfig = parseAndValidateConfig(mockYaml) as unknown as CtReviewConfigV3;

  it('executes multiple personas in parallel concurrently rather than sequentially', async () => {
    let activeConcurrentCalls = 0;
    let maxObservedConcurrency = 0;

    const mockClient: ReviewModelClient = {
      complete: vi.fn(async (request): Promise<OpenRouterResponse> => {
        activeConcurrentCalls++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, activeConcurrentCalls);

        // Simulate streaming: onFirstToken fires during generation while persona 1 is still active
        if (typeof (request as any).onFirstToken === 'function') {
          setTimeout(() => {
            (request as any).onFirstToken();
          }, 5);
        }

        // Simulate 50ms async network delay
        await new Promise((r) => setTimeout(r, 50));

        activeConcurrentCalls--;
        const match = request.messages[0].content.match(/CT_REVIEW_BEGIN:([^\s\n]+)/);
        const nonce = match ? match[1] : 'nonce123';
        const isArbiter = request.messages[0].content.includes('Role: ARBITER') || request.messages[1]?.content?.includes('Role: ARBITER');
        const jsonBody = isArbiter
          ? '{"verdict":"SHIP","rationale":"clean"}'
          : '{"decision":"APPROVE","findings":[],"rationale":"clean"}';

        return {
          model: request.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${jsonBody}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 100, completion: 50, total: 150 },
          costUSD: 0.0001,
          raw: null,
        };
      }),
    };

    const startTime = Date.now();
    const result = await executePersonaPanel({
      config: mockConfig,
      changedFiles: [{ path: 'src/service.ts', patch: '+ const x = 1;' }],
      repository: 'calltelemetry/ct-meta',
      headSha: 'abc1234',
      client: mockClient,
    });
    const duration = Date.now() - startTime;

    expect(result.arbiter.verdict).toBe('SHIP');
    expect(result.personas).toHaveLength(3);
    // Verified concurrent execution: all 3 personas were active simultaneously
    expect(maxObservedConcurrency).toBe(3);
    // Verified parallel duration: ran in ~50-100ms, not 150ms+ serialized
    expect(duration).toBeLessThan(timeBudgetMs(350));
  });

  it('verifies warm-then-fan-out: Persona 1 warms cache first, remaining personas wait for first token', async () => {
    const callLog: Array<{ persona: string; timestamp: number; event: string }> = [];
    let releaseFirstToken: () => void;
    const holdFirstToken = new Promise<void>((resolve) => {
      releaseFirstToken = resolve;
    });

    const mockClient: ReviewModelClient = {
      complete: vi.fn(async (request): Promise<OpenRouterResponse> => {
        const persona = (request as any).persona || 'unknown';
        callLog.push({ persona, timestamp: Date.now(), event: 'start' });

        if (persona === 'security') {
          // Persona 1 waits until explicitly released before emitting first token
          await holdFirstToken;
          if (typeof (request as any).onFirstToken === 'function') {
            (request as any).onFirstToken();
          }
        }

        // Small generation delay
        await new Promise((r) => setTimeout(r, 20));
        callLog.push({ persona, timestamp: Date.now(), event: 'finish' });

        const match = request.messages[0].content.match(/CT_REVIEW_BEGIN:([^\s\n]+)/);
        const nonce = match ? match[1] : 'nonce123';
        const isArbiter = persona === 'arbiter' || request.messages[0].content.includes('Role: ARBITER');
        const jsonBody = isArbiter
          ? '{"verdict":"SHIP","rationale":"clean"}'
          : '{"decision":"APPROVE","findings":[],"rationale":"clean"}';

        return {
          model: request.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${jsonBody}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 100, completion: 50, total: 150, cached: 50 },
          costUSD: 0.0001,
          raw: null,
        };
      }),
    };

    const executionPromise = executePersonaPanel({
      config: mockConfig,
      changedFiles: [{ path: 'src/service.ts', patch: '+ const x = 1;' }],
      repository: 'calltelemetry/ct-meta',
      headSha: 'abc1234',
      client: mockClient,
    });

    // Check after 30ms before release: ONLY Persona 1 (security) should have started!
    await new Promise((r) => setTimeout(r, 30));
    const startedBeforeRelease = callLog.filter((e) => e.event === 'start').map((e) => e.persona);
    expect(startedBeforeRelease).toEqual(['security']);

    // Now release first token from Persona 1
    releaseFirstToken!();

    const result = await executionPromise;
    expect(result.personas).toHaveLength(3);

    // After release, remaining personas (performance, architecture) started
    const allStarts = callLog.filter((e) => e.event === 'start').map((e) => e.persona);
    expect(allStarts).toContain('security');
    expect(allStarts).toContain('performance');
    expect(allStarts).toContain('architecture');

    // Security was strictly the first persona dispatched
    expect(allStarts[0]).toBe('security');
  });

  it('handles non-streaming client gracefully by fanning out after Persona 1 completes', async () => {
    const startedPersonas: string[] = [];

    const mockClient: ReviewModelClient = {
      complete: vi.fn(async (request): Promise<OpenRouterResponse> => {
        const persona = (request as any).persona || 'unknown';
        startedPersonas.push(persona);
        // Non-streaming mock does NOT call onFirstToken

        await new Promise((r) => setTimeout(r, 20));

        const match = request.messages[0].content.match(/CT_REVIEW_BEGIN:([^\s\n]+)/);
        const nonce = match ? match[1] : 'nonce123';
        const isArbiter = persona === 'arbiter' || request.messages[0].content.includes('Role: ARBITER');
        const jsonBody = isArbiter
          ? '{"verdict":"SHIP","rationale":"clean"}'
          : '{"decision":"APPROVE","findings":[],"rationale":"clean"}';

        return {
          model: request.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${jsonBody}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 100, completion: 50, total: 150 },
          costUSD: 0.0001,
          raw: null,
        };
      }),
    };

    const result = await executePersonaPanel({
      config: mockConfig,
      changedFiles: [{ path: 'src/service.ts', patch: '+ const x = 1;' }],
      repository: 'calltelemetry/ct-meta',
      headSha: 'abc1234',
      client: mockClient,
    });

    expect(result.personas).toHaveLength(3);
    expect(startedPersonas[0]).toBe('security');
    expect(startedPersonas).toContain('performance');
    expect(startedPersonas).toContain('architecture');
  });
});
