import { describe, expect, it } from 'vitest';
import {
  resolveOpenRouterPolicy,
  HARD_BANNED_PROVIDER_SLUGS,
} from '../../.github/workflows/pipelines/openRouterPolicy.js';

const DEFAULTS = {
  ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
  timeoutMs: 30000,
  connectTimeoutMs: 8000,
  stream: false,
  model: undefined,
  fallbackModels: [],
  providerRouting: { ignore: HARD_BANNED_PROVIDER_SLUGS, preferred_max_latency: 8000 },
};

const ENV_ALL = {
  OPENROUTER_ALLOWED_MODELS: 'openai/gpt-5.6-luna,moonshotai/kimi-k2.6',
  OPENROUTER_COST_QUALITY_TRADEOFF: '7',
  OPENROUTER_DATA_COLLECTION: 'deny',
  OPENROUTER_IGNORE_PROVIDERS: 'siliconflow',
  OPENROUTER_TIMEOUT_MS: '5000',
  OPENROUTER_STREAM: 'true',
  OPENROUTER_FALLBACK_MODELS: 'deepseek/deepseek-v4-flash-0731, openai/gpt-5.6-luna',
};

const CFG_ALL = {
  parsed: {
    github_action: {
      openrouter: {
        allowed_models: ['a/b', 'c/d'],
        cost_quality_tradeoff: 4,
        data_collection: 'deny',
        ignore_providers: ['siliconflow'],
        timeout_ms: 8000,
        stream: true,
        fallback_models: ['deepseek/deepseek-v4-flash-0731'],
      },
    },
  },
};

describe('pipeline resolveOpenRouterPolicy (input > github_action.openrouter config > defaults)', () => {
  it('absent config and absent inputs yields empty defaults + 30s timeout / stream off', () => {
    expect(resolveOpenRouterPolicy({}, {})).toEqual({
      allowedModels: [],
      costQualityTradeoff: undefined,
      dataCollection: undefined,
      ...DEFAULTS,
    });
  });

  it('full config with empty inputs falls back to the github_action.openrouter block', () => {
    expect(resolveOpenRouterPolicy(CFG_ALL, {})).toEqual({
      allowedModels: ['a/b', 'c/d'],
      costQualityTradeoff: 4,
      dataCollection: 'deny',
      ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
      fallbackModels: ['deepseek/deepseek-v4-flash-0731'],
      providerRouting: { ignore: HARD_BANNED_PROVIDER_SLUGS, preferred_max_latency: 8000 },
      timeoutMs: 8000,
      connectTimeoutMs: 8000,
      stream: true,
      model: undefined,
    });
  });

  it('explicit inputs override the github_action.openrouter config', () => {
    expect(resolveOpenRouterPolicy(CFG_ALL, ENV_ALL)).toEqual({
      allowedModels: ['openai/gpt-5.6-luna', 'moonshotai/kimi-k2.6'],
      costQualityTradeoff: 7,
      dataCollection: 'deny',
      ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
      fallbackModels: ['deepseek/deepseek-v4-flash-0731', 'openai/gpt-5.6-luna'],
      providerRouting: { ignore: HARD_BANNED_PROVIDER_SLUGS, preferred_max_latency: 5000 },
      timeoutMs: 5000,
      connectTimeoutMs: 5000,
      stream: true,
      model: undefined,
    });
  });

  it('trims spaces and drops empties in the CSV allowlist (incl. trailing commas)', () => {
    expect(resolveOpenRouterPolicy({}, { OPENROUTER_ALLOWED_MODELS: 'x/y, ,  z/w  ,' }).allowedModels)
      .toEqual(['x/y', 'z/w']);
  });

  it('resolves ordered fallback models from trusted config or an explicit input', () => {
    expect(resolveOpenRouterPolicy(
      { github_action: { openrouter: { fallback_models: ['primary/fallback', 'deepseek/deepseek-v4-flash-0731'] } } },
      {},
    ).fallbackModels).toEqual(['primary/fallback', 'deepseek/deepseek-v4-flash-0731']);

    expect(resolveOpenRouterPolicy(
      { github_action: { openrouter: { fallback_models: ['primary/fallback'] } } },
      { OPENROUTER_FALLBACK_MODELS: 'deepseek/deepseek-v4-flash-0731, openai/gpt-5.6-luna' },
    ).fallbackModels).toEqual(['deepseek/deepseek-v4-flash-0731', 'openai/gpt-5.6-luna']);

    expect(resolveOpenRouterPolicy(
      { github_action: { openrouter: { fallback_models: 'deepseek/deepseek-v4-flash-0731, openai/gpt-5.6-luna' } } },
      {},
    ).fallbackModels).toEqual(['deepseek/deepseek-v4-flash-0731', 'openai/gpt-5.6-luna']);
  });

  it('coerces a text allowlist from config and ignores an invalid tradeoff number', () => {
    expect(resolveOpenRouterPolicy(
      { github_action: { openrouter: { allowed_models: 'a/b, c/d', cost_quality_tradeoff: 'not-a-number' } } },
      {},
    )).toEqual({
      allowedModels: ['a/b', 'c/d'],
      costQualityTradeoff: undefined,
      dataCollection: undefined,
      ...DEFAULTS,
    });
  });

  it('partially set env overrides only the fields it provides', () => {
    expect(resolveOpenRouterPolicy(CFG_ALL, { OPENROUTER_COST_QUALITY_TRADEOFF: '9' })).toEqual({
      allowedModels: ['a/b', 'c/d'],
      costQualityTradeoff: 9,
      dataCollection: 'deny',
      ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
      fallbackModels: ['deepseek/deepseek-v4-flash-0731'],
      model: undefined,
      providerRouting: { ignore: HARD_BANNED_PROVIDER_SLUGS, preferred_max_latency: 8000 },
      timeoutMs: 8000,
      connectTimeoutMs: 8000,
      stream: true,
    });
  });

  it('clamps tradeoff to 0-10 and rounds', () => {
    expect(resolveOpenRouterPolicy({}, { OPENROUTER_COST_QUALITY_TRADEOFF: '13' }).costQualityTradeoff).toBe(10);
    expect(resolveOpenRouterPolicy({}, { OPENROUTER_COST_QUALITY_TRADEOFF: '-4' }).costQualityTradeoff).toBe(0);
    expect(resolveOpenRouterPolicy({}, { OPENROUTER_COST_QUALITY_TRADEOFF: '5.6' }).costQualityTradeoff).toBe(6);
  });

  it('defaults data_collection when absent and rejects unknown values', () => {
    expect(resolveOpenRouterPolicy({}, { OPENROUTER_DATA_COLLECTION: 'allow' }).dataCollection).toBe('allow');
    expect(resolveOpenRouterPolicy({}, { OPENROUTER_DATA_COLLECTION: 'no' }).dataCollection).toBeUndefined();
    expect(resolveOpenRouterPolicy({}, {}).dataCollection).toBeUndefined();
  });

  it('accepts a config without the github_action wrapper via top-level openrouter', () => {
    expect(resolveOpenRouterPolicy(
      { parsed: { openrouter: { allowed_models: ['m/n'], cost_quality_tradeoff: 3, data_collection: 'deny', timeout_ms: 2500, stream: false } } },
      {},
    )).toEqual({
      allowedModels: ['m/n'],
      costQualityTradeoff: 3,
      dataCollection: 'deny',
      ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
      fallbackModels: [],
      providerRouting: { ignore: HARD_BANNED_PROVIDER_SLUGS, preferred_max_latency: 2500 },
      timeoutMs: 2500,
      connectTimeoutMs: 2500,
      stream: false,
      model: undefined,
    });
  });

  it('defaults timeout_ms to 30000 and clamps extreme values', () => {
    expect(resolveOpenRouterPolicy({}, {}).timeoutMs).toBe(30000);
    expect(resolveOpenRouterPolicy({}, { OPENROUTER_TIMEOUT_MS: '100' }).timeoutMs).toBe(500); // floor
    expect(resolveOpenRouterPolicy({}, { OPENROUTER_TIMEOUT_MS: '9999999' }).timeoutMs).toBe(600_000); // ceiling
    expect(resolveOpenRouterPolicy({}, {}).connectTimeoutMs).toBe(8000);
    expect(resolveOpenRouterPolicy({}, { OPENROUTER_CONNECT_TIMEOUT_MS: '100' }).connectTimeoutMs).toBe(500);
    // connect cannot exceed total budget
    expect(resolveOpenRouterPolicy({}, { OPENROUTER_TIMEOUT_MS: '2000', OPENROUTER_CONNECT_TIMEOUT_MS: '9000' }).connectTimeoutMs).toBe(2000);
  });

  it('permanently bans degraded and fallback routes while accepting additional configured bans', () => {
    expect(resolveOpenRouterPolicy({}, {}).ignoredProviders).toEqual(HARD_BANNED_PROVIDER_SLUGS);
    expect(resolveOpenRouterPolicy(
      { github_action: { openrouter: { ignore_providers: ['siliconflow', 'deepinfra'] } } },
      {},
    ).ignoredProviders).toEqual(HARD_BANNED_PROVIDER_SLUGS);
  });

  it('forwards documented provider routing fields and normalizes provider slugs', () => {
    const policy = resolveOpenRouterPolicy({}, {
      OPENROUTER_PROVIDER_ROUTING: JSON.stringify({
        order: ['Morph', 'akash'],
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: 'deny',
        zdr: true,
        enforce_distillable_text: true,
        only: ['morph'],
        quantizations: ['FP8'],
        sort: { by: 'throughput', partition: 'none' },
        preferred_min_throughput: { p90: 50 },
        preferred_max_latency: { p90: 3 },
        max_price: { prompt: 1, completion: 2 },
      }),
    });

    expect(policy.providerRouting).toEqual({
      order: ['morph', 'akash'],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: 'deny',
      zdr: true,
      enforce_distillable_text: true,
      only: ['morph'],
      quantizations: ['fp8'],
      sort: { by: 'throughput', partition: 'none' },
      preferred_min_throughput: { p90: 50 },
      preferred_max_latency: { p90: 3 },
      max_price: { prompt: 1, completion: 2 },
      ignore: HARD_BANNED_PROVIDER_SLUGS,
    });
  });

  it('fails closed when a provider routing selection tries to re-enable DeepInfra', () => {
    expect(() => resolveOpenRouterPolicy({}, {
      OPENROUTER_PROVIDER_ROUTING: JSON.stringify({ only: ['deepinfra/turbo'] }),
    })).toThrow(/hard-banned provider/);
  });

  it.each(['openrouter', 'wafer', 'novita', 'decart', 'sail-research', 'inceptron', 'fireworks', 'together', 'mancer', 'parasail'])(
    'fails closed when provider routing selects degraded provider %s',
    (provider) => {
      expect(() => resolveOpenRouterPolicy({}, {
        OPENROUTER_PROVIDER_ROUTING: JSON.stringify({ only: [provider] }),
      })).toThrow(/hard-banned provider/);
    },
  );

  it('always keeps the hard-banned providers when an action input supplies another ignore list', () => {
    const policy = resolveOpenRouterPolicy({}, { OPENROUTER_IGNORE_PROVIDERS: 'siliconflow' });
    expect(policy.ignoredProviders).toEqual(HARD_BANNED_PROVIDER_SLUGS);
    expect(policy.providerRouting.ignore).toEqual(HARD_BANNED_PROVIDER_SLUGS);
  });

  it('uses github_action.openrouter.provider_routing when the action input is empty', () => {
    expect(resolveOpenRouterPolicy({
      github_action: {
        openrouter: {
          provider_routing: {
            only: ['morph'],
            allow_fallbacks: false,
          },
        },
      },
    }, {}).providerRouting).toEqual({
      only: ['morph'],
      allow_fallbacks: false,
      ignore: HARD_BANNED_PROVIDER_SLUGS,
      preferred_max_latency: 8000,
    });
  });

  it('treats an explicit empty JSON routing object as unset instead of broadening provider selection', () => {
    expect(resolveOpenRouterPolicy({
      github_action: {
        openrouter: {
          provider_routing: {
            only: ['morph'],
            allow_fallbacks: false,
          },
        },
      },
    }, { OPENROUTER_PROVIDER_ROUTING: '{}' }).providerRouting).toEqual({
      only: ['morph'],
      allow_fallbacks: false,
      ignore: HARD_BANNED_PROVIDER_SLUGS,
      preferred_max_latency: 8000,
    });
  });

  it('fails before lane fan-out when Luna is restricted to the Morph-only cohort', () => {
    expect(() => resolveOpenRouterPolicy({}, {
      OPENROUTER_MODEL: 'openai/gpt-5.6-luna',
      OPENROUTER_PROVIDER_ROUTING: JSON.stringify({ only: ['morph'], allow_fallbacks: false }),
    })).toThrow(/fixed-model compatibility check failed.*openai\/gpt-5\.6-luna.*openai or azure.*only permits only \[morph\]/i);
  });

  it('accepts Luna only with an explicit compatible provider allowlist and preserves data policy', () => {
    const policy = resolveOpenRouterPolicy({}, {
      OPENROUTER_MODEL: 'openai/gpt-5.6-luna',
      OPENROUTER_PROVIDER_ROUTING: JSON.stringify({
        only: ['openai', 'azure'],
        allow_fallbacks: false,
        data_collection: 'deny',
      }),
    });

    expect(policy.providerRouting).toEqual({
      only: ['openai', 'azure'],
      allow_fallbacks: false,
      data_collection: 'deny',
      ignore: HARD_BANNED_PROVIDER_SLUGS,
      preferred_max_latency: 8000,
    });
  });

  it('fails when a compatible provider is separately excluded instead of removing the exclusion', () => {
    expect(() => resolveOpenRouterPolicy({}, {
      OPENROUTER_MODEL: 'openai/gpt-5.6-luna',
      OPENROUTER_IGNORE_PROVIDERS: 'openai,azure',
      OPENROUTER_PROVIDER_ROUTING: JSON.stringify({ only: ['openai', 'azure'], allow_fallbacks: false }),
    })).toThrow(/effective ignore policy also excludes openai, azure/i);
  });

  it('parses stream truthy/falsey from env and yaml', () => {
    expect(resolveOpenRouterPolicy({}, { OPENROUTER_STREAM: 'true' }).stream).toBe(true);
    expect(resolveOpenRouterPolicy({}, { OPENROUTER_STREAM: '1' }).stream).toBe(true);
    expect(resolveOpenRouterPolicy({}, { OPENROUTER_STREAM: 'false' }).stream).toBe(false);
    expect(resolveOpenRouterPolicy({ github_action: { openrouter: { stream: true } } }, {}).stream).toBe(true);
    expect(resolveOpenRouterPolicy({ github_action: { openrouter: { stream: 'off' } } }, {}).stream).toBe(false);
  });

  it('env OPENROUTER_MODEL beats yaml model', () => {
    expect(resolveOpenRouterPolicy(
      { github_action: { openrouter: { model: 'deepseek/deepseek-v4-flash-0731' } } },
      { OPENROUTER_MODEL: 'openai/gpt-4o-mini' },
    ).model).toBe('openai/gpt-4o-mini');
    expect(resolveOpenRouterPolicy(
      { github_action: { openrouter: { model: 'deepseek/deepseek-v4-flash-0731' } } },
      {},
    ).model).toBe('deepseek/deepseek-v4-flash-0731');
  });

  it('env stream/timeout beat yaml', () => {
    expect(resolveOpenRouterPolicy(
      { github_action: { openrouter: { timeout_ms: 9000, stream: true } } },
      { OPENROUTER_TIMEOUT_MS: '1200', OPENROUTER_STREAM: 'false' },
    )).toEqual(expect.objectContaining({ timeoutMs: 1200, stream: false }));
  });
});
