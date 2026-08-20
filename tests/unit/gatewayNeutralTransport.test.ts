import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { sseBody } from '../support/streamableFetchStub';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const policy = require(path.join(rootRepoDir, '.github/workflows/pipelines/openRouterPolicy.js'));

const { reviewWithModel: reviewWithModelRaw, PERSONA_CHARTERS } = pipeline;
const { resolveGatewayIdentity } = policy;
const persona = PERSONA_CHARTERS.find((p: any) => p.id === 'security');
const diffFiles = [{ path: 'src/a.ts', patch: '+x', addedLines: [], deletedLines: [] }];

// reviewWithModel now requires a caller-supplied options.investigationMessages (the legacy
// single-shot prompt-building/parsing path it used to fall back to is gone). These tests are
// about gateway/transport routing, not message content, so every call gets the same bounded
// stand-in messages unless it supplies its own.
const DEFAULT_INVESTIGATION_MESSAGES = [
  { role: 'system', content: 'You are a bounded code-review panel reviewer.' },
  { role: 'user', content: '<review_manifest></review_manifest><pull_request_diff></pull_request_diff>' },
];
function reviewWithModel(persona: any, diffFiles: any, prContext: any, sessionContext: any, options: any = {}) {
  return reviewWithModelRaw(persona, diffFiles, prContext, sessionContext, {
    rawTurn: true,
    investigationMessages: DEFAULT_INVESTIGATION_MESSAGES,
    ...options,
  });
}

/**
 * Fetch stub that records every request and answers the (unconditional, per operator directive)
 * streaming request directly with a clean completion -- no `.body.getReader` would otherwise
 * cause a transport failure and lose the route evidence needed by the assertions.
 */
function capturingFetch(record: any[], extra: Record<string, unknown> = {}) {
  return async (url: string, init: any) => {
    record.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: '{"findings":[]}' } }], ...extra }),
      body: sseBody({ choices: [{ message: { content: '{"findings":[]}' } }], ...extra }),
    };
  };
}

describe('resolveGatewayIdentity', () => {
  it('treats an empty/unset base URL as OpenRouter', () => {
    expect(resolveGatewayIdentity(undefined)).toEqual({ id: 'openrouter', isOpenRouter: true });
    expect(resolveGatewayIdentity('')).toEqual({ id: 'openrouter', isOpenRouter: true });
  });

  it('treats openrouter.ai and its subdomains as OpenRouter', () => {
    expect(resolveGatewayIdentity('https://openrouter.ai/api/v1').isOpenRouter).toBe(true);
    expect(resolveGatewayIdentity('https://gateway.openrouter.ai/api/v1').isOpenRouter).toBe(true);
  });

  it('namespaces known direct gateways so they cannot collide with OpenRouter provider slugs', () => {
    expect(resolveGatewayIdentity('https://api.fireworks.ai/inference/v1')).toEqual({ id: 'fireworks-direct', isOpenRouter: false });
    expect(resolveGatewayIdentity('https://ollama.com/v1')).toEqual({ id: 'ollama-cloud', isOpenRouter: false });
    expect(resolveGatewayIdentity('https://opencode.ai/zen/v1')).toEqual({ id: 'opencode-zen', isOpenRouter: false });
  });

  it('keeps OpenRouter semantics for unknown hosts (OpenRouter proxies) and unparseable URLs', () => {
    expect(resolveGatewayIdentity('https://llm.internal.example:8443/v1')).toEqual({ id: 'openrouter', isOpenRouter: true });
    expect(resolveGatewayIdentity('not a url').isOpenRouter).toBe(true);
  });
});

describe('gateway-neutral request body', () => {
  it('omits OpenRouter-only fields (provider, session_id, plugins) on a direct gateway', async () => {
    const requests: any[] = [];
    const res = await reviewWithModel(persona, diffFiles, { repo: 'o/r', prNumber: 1 }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
      sessionSticky: true,
      fetchImpl: capturingFetch(requests),
      openRouterPolicy: {
        allowedModels: ['openai/gpt-5.6-luna'],
        costQualityTradeoff: 7,
        dataCollection: undefined,
        ignoredProviders: ['deepinfra', 'fireworks'],
        fallbackModels: [],
        providerRouting: { ignore: ['deepinfra', 'fireworks'] },
        timeoutMs: 30_000,
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.fireworks.ai/inference/v1/chat/completions');
    expect(requests[0].body).not.toHaveProperty('provider');
    expect(requests[0].body).not.toHaveProperty('session_id');
    expect(requests[0].body).not.toHaveProperty('plugins');
    expect(res.ok).toBe(true);
  });

  it('still attaches provider routing and session_id on OpenRouter', async () => {
    const requests: any[] = [];
    await reviewWithModel(persona, diffFiles, { repo: 'o/r', prNumber: 1 }, null, {
      apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api/v1',
      sessionSticky: true,
      fetchImpl: capturingFetch(requests),
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toHaveProperty('provider');
    expect(Array.isArray(requests[0].body.provider.ignore)).toBe(true);
    expect(requests[0].body).toHaveProperty('session_id');
  });

  it('labels the route with the gateway id when the response names no provider, enabling lane retries', async () => {
    const res = await reviewWithModel(persona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      fetchImpl: capturingFetch([]),
    });
    // `openrouter` is the unknown-route sentinel that reviewInvestigation.retryableProvider
    // refuses to retry; a direct gateway must not inherit it.
    expect(res.provider).toBe('fireworks-direct');
  });

  it('does not judge a direct-gateway route label against an OpenRouter closed cohort', async () => {
    const res = await reviewWithModel(persona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      fetchImpl: capturingFetch([]),
      openRouterPolicy: {
        allowedModels: [],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: [],
        fallbackModels: [],
        // A closed OpenRouter cohort left over in config must not fail Fireworks responses.
        providerRouting: { only: ['examplecloud'], allow_fallbacks: false },
        timeoutMs: 30_000,
      },
    });
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });
});
