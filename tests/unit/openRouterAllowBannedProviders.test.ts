import { describe, expect, it } from 'vitest';
import path from 'node:path';

const policy = require(path.resolve(__dirname, '../../.github/workflows/pipelines/openRouterPolicy.js'));
const { resolveOpenRouterPolicy } = policy;

/**
 * Regression coverage for the operator-allowlist vs hard-ban deadlock.
 *
 * HARD_BANNED_PROVIDER_SLUGS is a safety default for callers that pass no policy of their own.
 * It must not silently override an operator who has deliberately permitted a provider upstream
 * — e.g. an OpenRouter workspace guardrail in only-allow mode. On calltelemetry/cisco-cdr the
 * guardrail allowed exactly {DigitalOcean, Parasail, Inceptron, Together}; three of those four
 * are hard-banned here, leaving a single usable provider. When DigitalOcean degraded, the
 * intersection went to zero and every request failed with
 * `404 No endpoints available matching your guardrail restrictions and data policy`.
 */
describe('openrouter-allow-banned-providers — operator allow-list must win', () => {
  it('keeps hard-banning by default when the operator opts out of nothing', () => {
    const p = resolveOpenRouterPolicy({}, {});
    expect(p.ignoredProviders).toContain('together');
    expect(p.ignoredProviders).toContain('parasail');
    expect(p.ignoredProviders).toContain('inceptron');
  });

  it('ACCEPTANCE: a provider the operator re-permits is no longer ignored', () => {
    const p = resolveOpenRouterPolicy({}, { OPENROUTER_ALLOW_BANNED_PROVIDERS: 'together,parasail,inceptron' });
    for (const slug of ['together', 'parasail', 'inceptron']) {
      expect(p.ignoredProviders).not.toContain(slug);
    }
    // Everything else stays banned — this is an opt-out, not a disable.
    expect(p.ignoredProviders).toContain('deepinfra');
    expect(p.ignoredProviders).toContain('mancer');
  });

  it('ACCEPTANCE: routing may select a re-permitted provider without throwing', () => {
    expect(() => resolveOpenRouterPolicy({}, {
      OPENROUTER_ALLOW_BANNED_PROVIDERS: 'together',
      OPENROUTER_PROVIDER_ROUTING: '{"only":["together"],"allow_fallbacks":false}',
    })).not.toThrow();
  });

  it('DANGER GUARD: routing to a still-banned provider still throws', () => {
    expect(() => resolveOpenRouterPolicy({}, {
      OPENROUTER_ALLOW_BANNED_PROVIDERS: 'together',
      OPENROUTER_PROVIDER_ROUTING: '{"only":["deepinfra"],"allow_fallbacks":false}',
    })).toThrow(/hard-banned/i);
  });

  it('honours the same opt-out from trusted YAML config', () => {
    const p = resolveOpenRouterPolicy({ openrouter: { allow_banned_providers: ['together'] } }, {});
    expect(p.ignoredProviders).not.toContain('together');
    expect(p.ignoredProviders).toContain('parasail');
  });
});
