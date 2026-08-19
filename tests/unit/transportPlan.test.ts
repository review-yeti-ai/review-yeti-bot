import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const policy = require(path.join(rootRepoDir, '.github/workflows/pipelines/openRouterPolicy.js'));

const { resolveTransportPlan } = policy;
const { reviewWithTransports, PERSONA_CHARTERS } = pipeline;
const persona = PERSONA_CHARTERS.find((p: any) => p.id === 'security');
const diffFiles = [{ path: 'src/a.ts', patch: '+x', addedLines: [], deletedLines: [] }];

const fireworksEntry = {
  name: 'fireworks',
  base_url: 'https://api.fireworks.ai/inference/v1',
  api_key_env: 'FIREWORKS_PR_REVIEW_API_KEY',
  model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
  stream: true,
  reasoning_effort: 'max',
  perf_metrics_in_response: true,
};
const openrouterEntry = {
  name: 'openrouter-fallback',
  base_url: 'https://openrouter.ai/api/v1',
  api_key_env: 'OPENROUTER_PR_REVIEW_API_KEY',
  model: 'deepseek/deepseek-v4-flash-0731',
  stream: true,
  reasoning_effort: 'max',
  quarantine_on_timeout: false,
  provider_routing: { order: ['coreweave', 'phala'], allow_fallbacks: false, data_collection: 'deny' },
};
const bothKeys = { FIREWORKS_PR_REVIEW_API_KEY: 'fw-key', OPENROUTER_PR_REVIEW_API_KEY: 'or-key' };

describe('resolveTransportPlan', () => {
  it('returns null when no transports are configured', () => {
    expect(resolveTransportPlan(null, {})).toBeNull();
    expect(resolveTransportPlan({ parsed: { github_action: {} } }, {})).toBeNull();
  });

  it('resolves an ordered plan from trusted-base YAML with compat detected per base_url', () => {
    const plan = resolveTransportPlan(
      { parsed: { github_action: { transports: [fireworksEntry, openrouterEntry] } } },
      bothKeys,
    );
    expect(plan!.transports.map((t: any) => t.name)).toEqual(['fireworks', 'openrouter-fallback']);
    expect(plan!.transports[0]).toMatchObject({ compat: 'openai', apiKey: 'fw-key', baseUrl: 'https://api.fireworks.ai/inference/v1' });
    expect(plan!.transports[0]).toMatchObject({ stream: true, reasoningEffort: 'max', perfMetricsInResponse: true });
    expect(plan!.transports[1]).toMatchObject({ compat: 'openrouter', apiKey: 'or-key', stream: true, reasoningEffort: 'max', quarantineOnTimeout: false });
    // OpenRouter entries get the full normalized policy: hard bans + declared routing.
    expect(plan!.transports[1].openRouterPolicy.providerRouting).toMatchObject({ order: ['coreweave', 'phala'], allow_fallbacks: false });
    expect(plan!.transports[1].openRouterPolicy.ignoredProviders).toContain('deepinfra');
  });

  it('lets env REVIEW_YETI_TRANSPORTS win over the YAML block', () => {
    const plan = resolveTransportPlan(
      { parsed: { github_action: { transports: [openrouterEntry] } } },
      { ...bothKeys, REVIEW_YETI_TRANSPORTS: JSON.stringify([fireworksEntry]) },
    );
    expect(plan!.transports.map((t: any) => t.name)).toEqual(['fireworks']);
  });

  it('inherits global timeout/stream inputs when an entry does not override them', () => {
    const plan = resolveTransportPlan(
      { parsed: { github_action: { transports: [fireworksEntry, { ...fireworksEntry, name: 'fireworks-slow', timeout_ms: 45000 }] } } },
      { ...bothKeys, OPENROUTER_TIMEOUT_MS: '60000', OPENROUTER_STREAM: 'true' },
    );
    expect(plan!.transports[0].timeoutMs).toBe(60000);
    expect(plan!.transports[0].stream).toBe(true);
    expect(plan!.transports[1].timeoutMs).toBe(45000);
  });

  it('drops an entry whose api_key_env is empty and fails closed when none remain', () => {
    const plan = resolveTransportPlan(
      { parsed: { github_action: { transports: [fireworksEntry, openrouterEntry] } } },
      { OPENROUTER_PR_REVIEW_API_KEY: 'or-key' },
    );
    expect(plan!.transports.map((t: any) => t.name)).toEqual(['openrouter-fallback']);
    expect(plan!.warnings[0]).toContain('FIREWORKS_PR_REVIEW_API_KEY');

    expect(() => resolveTransportPlan(
      { parsed: { github_action: { transports: [fireworksEntry] } } },
      {},
    )).toThrow(/zero usable/);
  });

  it('rejects CI-credential env names and non-key suffixes', () => {
    for (const bad of ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'RUNNER_TEMP_KEY', 'INPUT_LLM_API_KEY']) {
      expect(() => resolveTransportPlan(
        { parsed: { github_action: { transports: [{ ...fireworksEntry, api_key_env: bad }] } } },
        { [bad]: 'x' },
      )).toThrow(/CI credential|must match/);
    }
    expect(() => resolveTransportPlan(
      { parsed: { github_action: { transports: [{ ...fireworksEntry, api_key_env: 'FIREWORKS_SECRET' }] } } },
      { FIREWORKS_SECRET: 'x' },
    )).toThrow(/_API_KEY or _KEY/);
  });

  it('rejects OpenRouter-only keys on an openai-compat transport', () => {
    expect(() => resolveTransportPlan(
      { parsed: { github_action: { transports: [{ ...fireworksEntry, provider_routing: { only: ['morph'] } }] } } },
      bothKeys,
    )).toThrow(/OpenRouter-only/);
  });

  it('rejects malformed structure: bad name, duplicate name, non-https URL, missing model', () => {
    const base = { ...fireworksEntry };
    expect(() => resolveTransportPlan({ parsed: { github_action: { transports: [{ ...base, name: 'Bad Name' }] } } }, bothKeys)).toThrow(/name/);
    expect(() => resolveTransportPlan({ parsed: { github_action: { transports: [base, { ...openrouterEntry, name: 'fireworks' }] } } }, bothKeys)).toThrow(/duplicated/);
    expect(() => resolveTransportPlan({ parsed: { github_action: { transports: [{ ...base, base_url: 'http://api.fireworks.ai/v1' }] } } }, bothKeys)).toThrow(/https/);
    expect(() => resolveTransportPlan({ parsed: { github_action: { transports: [{ ...base, model: '' }] } } }, bothKeys)).toThrow(/model/);
  });

  it('rejects unsupported reasoning effort and non-boolean performance metrics controls', () => {
    expect(() => resolveTransportPlan(
      { parsed: { github_action: { transports: [{ ...fireworksEntry, reasoning_effort: 'ultra' }] } } },
      bothKeys,
    )).toThrow(/reasoning_effort/);
    expect(() => resolveTransportPlan(
      { parsed: { github_action: { transports: [{ ...fireworksEntry, perf_metrics_in_response: 'yes' }] } } },
      bothKeys,
    )).toThrow(/perf_metrics_in_response/);
    expect(() => resolveTransportPlan(
      { parsed: { github_action: { transports: [{ ...openrouterEntry, quarantine_on_timeout: 'no' }] } } },
      bothKeys,
    )).toThrow(/quarantine_on_timeout/);
  });
});

describe('reviewWithTransports', () => {
  const realImpl = reviewWithTransports.reviewWithModelImpl;
  afterEach(() => {
    reviewWithTransports.reviewWithModelImpl = realImpl;
    vi.restoreAllMocks();
  });

  function plannedTransports(env = bothKeys) {
    return resolveTransportPlan(
      { parsed: { github_action: { transports: [fireworksEntry, openrouterEntry] } } },
      env,
    )!.transports;
  }

  it('passes through to reviewWithModel when no plan is configured', async () => {
    const calls: any[] = [];
    reviewWithTransports.reviewWithModelImpl = async (...args: any[]) => { calls.push(args); return { ok: true, content: '{}' }; };
    const result = await reviewWithTransports(persona, diffFiles, { repo: 'o/r' }, null, { apiKey: 'k' });
    // Passthrough path calls the real reviewWithModel directly (not the seam).
    expect(calls).toHaveLength(0);
    expect(result).toBeDefined();
  });

  it('fails over in declared order and carries per-transport identity into each attempt', async () => {
    const attempts: any[] = [];
    reviewWithTransports.reviewWithModelImpl = async (_p: any, _d: any, _pr: any, _s: any, options: any) => {
      attempts.push(options);
      if (options.transportName === 'fireworks') return { decision: 'ERROR', error: 'timeout' };
      return { ok: true, content: '{"findings":[]}', provider: 'coreweave' };
    };
    const result = await reviewWithTransports(persona, diffFiles, { repo: 'o/r' }, null, {
      transportPlan: plannedTransports(),
    });
    expect(attempts.map((a) => a.transportName)).toEqual(['fireworks', 'openrouter-fallback']);
    expect(attempts[0]).toMatchObject({ apiKey: 'fw-key', baseUrl: 'https://api.fireworks.ai/inference/v1', gatewayCompat: 'openai' });
    expect(attempts[0]).toMatchObject({ preferStream: true, reasoningEffort: 'max', perfMetricsInResponse: true });
    expect(attempts[1]).toMatchObject({ apiKey: 'or-key', baseUrl: 'https://openrouter.ai/api/v1', gatewayCompat: 'openrouter', preferStream: true, reasoningEffort: 'max', providerTimeoutQuarantine: false });
    expect(attempts[1].transportPlan).toBeUndefined();
    expect(result).toMatchObject({ ok: true, provider: 'coreweave' });
  });

  it('disables concurrent streaming for a persona fan-out unless explicitly opted in', async () => {
    const attempts: any[] = [];
    reviewWithTransports.reviewWithModelImpl = async (_p: any, _d: any, _pr: any, _s: any, options: any) => {
      attempts.push(options);
      return { ok: true, content: '{"findings":[]}' };
    };

    await reviewWithTransports(persona, diffFiles, { repo: 'o/r' }, null, {
      transportPlan: plannedTransports(),
      parallelLaneCount: 5,
    });

    expect(attempts[0]).toMatchObject({
      parallelLaneCount: 5,
      preferStream: false,
      disableStream: true,
    });
  });

  it('returns the last failure when every transport fails', async () => {
    reviewWithTransports.reviewWithModelImpl = async (_p: any, _d: any, _pr: any, _s: any, options: any) => (
      { decision: 'ERROR', error: `boom-${options.transportName}` }
    );
    const result = await reviewWithTransports(persona, diffFiles, { repo: 'o/r' }, null, {
      transportPlan: plannedTransports(),
    });
    expect(result).toMatchObject({ decision: 'ERROR', error: 'boom-openrouter-fallback' });
  });

  it('does not fail over past a cancellation', async () => {
    const attempts: string[] = [];
    reviewWithTransports.reviewWithModelImpl = async (_p: any, _d: any, _pr: any, _s: any, options: any) => {
      attempts.push(options.transportName);
      return { decision: 'ERROR', error: 'cancelled' };
    };
    await reviewWithTransports(persona, diffFiles, { repo: 'o/r' }, null, { transportPlan: plannedTransports() });
    expect(attempts).toEqual(['fireworks']);
  });

  it('fails over when a raw-turn response is not JSON, using the lane parser\'s own leniency', async () => {
    const attempts: string[] = [];
    reviewWithTransports.reviewWithModelImpl = async (_p: any, _d: any, _pr: any, _s: any, options: any) => {
      attempts.push(options.transportName);
      if (options.transportName === 'fireworks') {
        return { ok: true, content: 'Sure! Here is my review in prose, not JSON.' };
      }
      return { ok: true, content: '{"review_status":"COMPLETE","risk_plan":[],"evidence_requests":[],"risk_dispositions":[],"findings":[]}' };
    };
    const result = await reviewWithTransports(persona, diffFiles, { repo: 'o/r' }, null, {
      rawTurn: true,
      transportPlan: plannedTransports(),
    });
    expect(attempts).toEqual(['fireworks', 'openrouter-fallback']);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('review_status');
  });

  it('does not fail over on fenced JSON the lane parser accepts', async () => {
    const attempts: string[] = [];
    reviewWithTransports.reviewWithModelImpl = async (_p: any, _d: any, _pr: any, _s: any, options: any) => {
      attempts.push(options.transportName);
      return { ok: true, content: '```json\n{"review_status":"COMPLETE","risk_plan":[],"evidence_requests":[],"risk_dispositions":[],"findings":[]}\n```' };
    };
    await reviewWithTransports(persona, diffFiles, { repo: 'o/r' }, null, {
      rawTurn: true,
      transportPlan: plannedTransports(),
    });
    expect(attempts).toEqual(['fireworks']);
  });

  it('returns the last transport\'s non-JSON content unchanged so upstream classifies the lane failure', async () => {
    const attempts: string[] = [];
    reviewWithTransports.reviewWithModelImpl = async (_p: any, _d: any, _pr: any, _s: any, options: any) => {
      attempts.push(options.transportName);
      return { ok: true, content: 'still not JSON' };
    };
    const result = await reviewWithTransports(persona, diffFiles, { repo: 'o/r' }, null, {
      rawTurn: true,
      transportPlan: plannedTransports(),
    });
    expect(attempts).toEqual(['fireworks', 'openrouter-fallback']);
    expect(result).toMatchObject({ ok: true, content: 'still not JSON' });
  });

  it('fails over on a caller-supplied contract validator, not just JSON validity', async () => {
    const attempts: string[] = [];
    reviewWithTransports.reviewWithModelImpl = async (_p: any, _d: any, _pr: any, _s: any, options: any) => {
      attempts.push(options.transportName);
      // Valid JSON on every transport; only the second passes the full contract.
      return { ok: true, content: options.transportName === 'fireworks' ? '{"unexpected":"shape"}' : '{"review_status":"COMPLETE"}' };
    };
    const seen: string[] = [];
    const result = await reviewWithTransports(persona, diffFiles, { repo: 'o/r' }, null, {
      rawTurn: true,
      transportPlan: plannedTransports(),
      turnValidator: (content: string) => {
        seen.push(content);
        const parsed = JSON.parse(content);
        if (parsed.review_status !== 'COMPLETE') throw new Error('contract violation');
        return parsed;
      },
    });
    expect(attempts).toEqual(['fireworks', 'openrouter-fallback']);
    // The final transport's content is deliberately NOT validated in the wrapper —
    // upstream owns classification there — so the validator ran exactly once.
    expect(seen).toEqual(['{"unexpected":"shape"}']);
    expect(result.content).toContain('COMPLETE');
  });

  it('does not fail over when the contract validator accepts the first transport', async () => {
    const attempts: string[] = [];
    reviewWithTransports.reviewWithModelImpl = async (_p: any, _d: any, _pr: any, _s: any, options: any) => {
      attempts.push(options.transportName);
      return { ok: true, content: '{"review_status":"COMPLETE"}' };
    };
    await reviewWithTransports(persona, diffFiles, { repo: 'o/r' }, null, {
      rawTurn: true,
      transportPlan: plannedTransports(),
      turnValidator: (content: string) => JSON.parse(content),
    });
    expect(attempts).toEqual(['fireworks']);
  });

  it('end-to-end: an openai-compat transport produces a gateway-neutral request through the real client', async () => {
    const requests: any[] = [];
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: any[]) => logs.push(args.join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...args: any[]) => logs.push(args.join(' ')));
    const result = await reviewWithTransports(persona, diffFiles, { repo: 'o/r' }, null, {
      transportPlan: plannedTransports(),
      sessionSticky: true,
      fetchImpl: async (url: string, init: any) => {
        requests.push({ url, body: JSON.parse(init.body) });
        const encoder = new TextEncoder();
        const chunk = {
          model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
          choices: [{ delta: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
          perf_metrics: { 'server-time-to-first-token': 0.123 },
        };
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`));
              controller.close();
            },
          }),
          text: async () => '',
        };
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.fireworks.ai/inference/v1/chat/completions');
    expect(requests[0].body).not.toHaveProperty('provider');
    expect(requests[0].body).not.toHaveProperty('session_id');
    expect(requests[0].body.model).toBe('accounts/fireworks/models/deepseek-v4-flash-0731');
    expect(requests[0].body.reasoning_effort).toBe('max');
    expect(requests[0].body.perf_metrics_in_response).toBe(true);
    expect(result.provider).toBe('fireworks');
    expect(result.providerTtftMs).toBe(123);
    expect(logs.some((line) => line.includes('[ModelTransport] transport=fireworks'))).toBe(true);
    expect(logs.some((line) => line.includes('[OpenRouter]'))).toBe(false);
  });

  it('maps OpenRouter reasoning effort to its reasoning object instead of a direct-gateway field', async () => {
    const requests: any[] = [];
    const plan = plannedTransports({ OPENROUTER_PR_REVIEW_API_KEY: 'or-key' });
    await reviewWithTransports(persona, diffFiles, { repo: 'o/r' }, null, {
      transportPlan: plan,
      fetchImpl: async (_url: string, init: any) => {
        requests.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: null,
          json: async () => ({ choices: [{ message: { content: '{"findings":[]}' } }] }),
        };
      },
    });
    expect(requests[0].reasoning).toEqual({ effort: 'max' });
    expect(requests[0]).not.toHaveProperty('reasoning_effort');
  });

  it('REL-288: stops trying further transports once the flat lane call budget is exhausted mid-failover', async () => {
    const { createLaneCallBudget } = pipeline;
    const attempts: string[] = [];
    const laneCallBudget = createLaneCallBudget(1);
    reviewWithTransports.reviewWithModelImpl = async (_p: any, _d: any, _pr: any, _s: any, options: any) => {
      attempts.push(options.transportName);
      // Mirrors reviewWithModel's own guard: spend before dispatching, refuse once exhausted.
      if (options.laneCallBudget && !options.laneCallBudget.spend()) {
        return { decision: 'ERROR', error: 'lane_budget_exhausted', failureClass: 'lane_budget_exhausted' };
      }
      return { decision: 'ERROR', error: 'timeout' };
    };
    const result = await reviewWithTransports(persona, diffFiles, { repo: 'o/r' }, null, {
      transportPlan: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      laneCallBudget,
    });
    // Transport 'a' spends the only budget unit and fails with an ordinary timeout -- normal
    // failover would try 'b' next regardless. Transport 'b' discovers the shared budget is
    // exhausted; the short-circuit must stop there and never reach transport 'c'.
    expect(attempts).toEqual(['a', 'b']);
    expect(result.error).toBe('lane_budget_exhausted');
    expect(laneCallBudget.remaining).toBe(0);
  });
});
