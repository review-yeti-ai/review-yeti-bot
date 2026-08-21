import { describe, expect, it } from 'vitest';
import { runOpenRouterReplay } from '../support/openRouterReplayScenario';

describe('OpenRouter fleet cassette replay', () => {
  it('runs the same multi-persona auto-router scenario twice deterministically', async () => {
    const first = await runOpenRouterReplay('complete-multi-persona.json');
    const second = await runOpenRouterReplay('complete-multi-persona.json');

    expect(second.arbitration.verdict).toBe(first.arbitration.verdict);
    expect(second.arbitration.findings).toEqual(first.arbitration.findings);
    expect(second.policyFingerprint).toBe(first.policyFingerprint);
    expect(second.requestFingerprints).toEqual(first.requestFingerprints);
    expect(second.comment).toBe(first.comment);
    expect(first.policyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.requestFingerprints).toHaveLength(3);
    expect(new Set(first.requestFingerprints).size).toBe(3);
    expect(first.comment).toContain('Model-backed (`openrouter/auto`)');
    expect(first.comment).not.toContain('src/not-in-diff.ts');
  });
});
