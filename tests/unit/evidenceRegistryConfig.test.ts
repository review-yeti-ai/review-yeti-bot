import { describe, expect, it } from 'vitest';

const {
  resolveEvidenceRegistryConfig,
  PERSONA_CHARTERS,
} = require('../../.github/workflows/pipelines/review-pipeline.js');
const { HARD_INVESTIGATION_LIMITS } = require('../../src/review/evidenceContracts.js');
const { createReviewNavigationToolRegistry } = require('../../src/mcp/reviewNavigationTools.js');

const config = (evidence: Record<string, unknown>) => ({ parsed: { review: { investigation: { evidence } } } });

describe('bounded evidence registry budget', () => {
  it('defaults to the contract hard ceiling instead of the retired hardcoded 12', () => {
    const resolved = resolveEvidenceRegistryConfig({}, {});

    expect(resolved.maxCalls).toBe(HARD_INVESTIGATION_LIMITS.maxCalls);
    expect(resolved.maxCalls).toBeGreaterThan(12);
    // 8,000 bytes truncated a single moderately sized helper, which is the file a lane most
    // often needs to read in full to resolve what an assertion pins.
    expect(resolved.maxResultBytes).toBeGreaterThan(8_000);
    expect(resolved.maxScanFiles).toBeGreaterThan(20);
    // Exact value, not just "> 20": #101 raised code_search's own default ceiling from
    // 20 to 60, but the registry construction site here used to pin a literal 20 that
    // silently overrode it in production (see the comment above
    // resolveEvidenceRegistryConfig). This is the regression guard for that gap.
    expect(resolved.maxScanFiles).toBe(60);
  });

  it('reads the trusted base-ref config so the budget is tunable without a bot release', () => {
    const resolved = resolveEvidenceRegistryConfig(config({ max_calls: 40, max_scan_files: 25, max_result_bytes: 16_000 }), {});

    expect(resolved).toMatchObject({ maxCalls: 40, maxScanFiles: 25, maxResultBytes: 16_000 });
  });

  it('accepts camelCase config keys as well as the documented snake_case form', () => {
    expect(resolveEvidenceRegistryConfig(config({ maxCalls: 33 }), {})).toMatchObject({ maxCalls: 33 });
  });

  it('lets the action input win over the repository config, matching every other limit', () => {
    const resolved = resolveEvidenceRegistryConfig(config({ max_calls: 40 }), { EVIDENCE_MAX_CALLS: '70' });

    expect(resolved.maxCalls).toBe(70);
  });

  it('ignores unusable values rather than resolving to zero or a negative budget', () => {
    for (const bad of ['', '0', '-5', 'lots', undefined]) {
      expect(resolveEvidenceRegistryConfig({}, { EVIDENCE_MAX_CALLS: bad }).maxCalls).toBe(HARD_INVESTIGATION_LIMITS.maxCalls);
    }
  });

  it('is clamped by the registry, so a hostile config cannot buy an unbounded budget', async () => {
    const resolved = resolveEvidenceRegistryConfig(config({ max_calls: 10_000, max_scan_files: 10_000 }), {});
    const identity = { repository: 'acme/widgets', prNumber: '1', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
    const registry = createReviewNavigationToolRegistry({
      identity,
      snapshot: { repository: identity.repository, headSha: identity.headSha, baseSha: identity.baseSha, files: [{ path: 'src/app.js', blobSha: '1'.repeat(40), patch: '' }] },
      blobClient: { getBlob: async () => ({ sha: '1'.repeat(40), content: 'x\n' }) },
      config: resolved,
    });

    // The registry does not surface its resolved numbers, so the clamp is proven by exhausting
    // it: a budget of 10,000 that really took effect would not run out inside 200 calls.
    let exhausted = 0;
    for (let call = 0; call < 200; call += 1) {
      const result = await registry.call('file_read', { path: 'src/app.js' });
      if (result.status === 'unavailable' && result.reason === 'call_budget_exhausted') { exhausted = call; break; }
    }
    expect(exhausted).toBeGreaterThan(0);
    expect(exhausted).toBeLessThanOrEqual(HARD_INVESTIGATION_LIMITS.maxCalls);
  });
});

describe('zoekt review-time search pilot toggle (ADR 0329)', () => {
  it('defaults to enabled, independent of the rest of the evidence budget', () => {
    expect(resolveEvidenceRegistryConfig({}, {}).zoekt).toEqual({ enabled: true });
  });

  it('can be disabled from the trusted base-ref config without touching maxCalls/maxScanFiles', () => {
    const resolved = resolveEvidenceRegistryConfig(config({ zoekt: { enabled: false } }), {});
    expect(resolved.zoekt).toEqual({ enabled: false });
    expect(resolved.maxScanFiles).toBe(60);
  });

  it('accepts the snake_case zoekt_enabled alias', () => {
    expect(resolveEvidenceRegistryConfig(config({ zoekt_enabled: false }), {}).zoekt).toEqual({ enabled: false });
  });

  it('lets the action input win over the repository config, matching every other limit', () => {
    expect(resolveEvidenceRegistryConfig(config({ zoekt: { enabled: true } }), { EVIDENCE_ZOEKT_ENABLED: 'false' }).zoekt).toEqual({ enabled: false });
    expect(resolveEvidenceRegistryConfig(config({ zoekt: { enabled: false } }), { EVIDENCE_ZOEKT_ENABLED: 'true' }).zoekt).toEqual({ enabled: true });
  });
});

describe('reviewer charter output discipline', () => {
  it('states every output limit self-contained, with no cross-persona or telemetry framing', () => {
    // A persona told it is "30x more verbose than other reviewers" is given a target it cannot
    // verify and cannot act on precisely, and internal telemetry is leaked into a prompt that
    // runs on the caller's API key. The limit itself is unchanged; only the framing is.
    const comparative = /\b\d+x\b|other reviewers|than (?:the )?(?:other|your) (?:reviewer|persona|peer)|measured across this repo|compared (?:to|with) (?:the )?other/iu;
    for (const persona of PERSONA_CHARTERS) {
      expect(persona.charter, `${persona.id} charter carries comparative or telemetry framing`).not.toMatch(comparative);
    }
  });

  it('keeps the testing lane at three findings while separating depth from output', () => {
    const testing = PERSONA_CHARTERS.find((persona: { id: string }) => persona.id === 'testing');

    expect(testing.charter).toMatch(/at most the THREE\s+highest-impact test gaps/u);
    expect(testing.charter).toMatch(/one or two sentences/u);
    // The regression this guards: an output limit read as an investigation limit. The lane took
    // the free diff-visible findings rather than spend an evidence call to resolve a fixture.
    expect(testing.charter).toMatch(/bounds what you report, never how far you investigate/u);
  });

  it('carries both semantic-defect probes the lane previously had no reason to run', () => {
    const testing = PERSONA_CHARTERS.find((persona: { id: string }) => persona.id === 'testing');

    expect(testing.charter).toMatch(/Resolve what each new or changed assertion actually pins/u);
    expect(testing.charter).toMatch(/negative or absence assertion/u);
    // Probes that invite the model to narrate its working overran the completion-token ceiling
    // and produced unparseable JSON — measured at 8/40 candidate runs before this line existed.
    expect(testing.charter).toMatch(/silently/u);
    expect(testing.charter).toMatch(/JSON object and nothing else/u);
  });
});
