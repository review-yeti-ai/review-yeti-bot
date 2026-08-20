import { describe, expect, it } from 'vitest';
import path from 'node:path';

const policy = require(path.resolve(__dirname, '../../.github/workflows/pipelines/openRouterPolicy.js'));
const { resolveOpenRouterPolicy } = policy;

describe('OpenRouter provider eligibility — account and request policy remain authoritative', () => {
  it('injects no permanent provider exclusions by default', () => {
    const p = resolveOpenRouterPolicy({}, {});
    expect(p.ignoredProviders).toEqual([]);
    expect(p.providerRouting.ignore).toEqual([]);
  });

  it('keeps the legacy allow input as a no-op for backward compatibility', () => {
    const p = resolveOpenRouterPolicy({}, { OPENROUTER_ALLOW_BANNED_PROVIDERS: 'together,parasail,inceptron' });
    expect(p.ignoredProviders).toEqual([]);
  });

  it('allows an explicit provider cohort without an action-level override', () => {
    expect(() => resolveOpenRouterPolicy({}, {
      OPENROUTER_PROVIDER_ROUTING: '{"only":["together"],"allow_fallbacks":false}',
    })).not.toThrow();
  });

  it('preserves an explicit ignore list without adding providers to it', () => {
    const p = resolveOpenRouterPolicy({ openrouter: { ignore_providers: ['operator-choice'] } }, {});
    expect(p.ignoredProviders).toEqual(['operator-choice']);
    expect(p.providerRouting.ignore).toEqual(['operator-choice']);
  });
});
