import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePersonaPanel, PanelConfigurationError, extractMessageContentText } from '../../src/panel/panelEngine';
import { CtReviewConfigV3 } from '../../src/config/schema';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';
import { logger } from '../../src/utils/logger';

function buildMinimalConfig(): CtReviewConfigV3 {
  // Based on the real createDefaultV3Config() defaults (see src/config/configLoader.ts) so
  // every schema-required top-level section (reviews, chat, knowledge_base, ...) is present
  // without hand-duplicating the zod defaults here.
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

describe('panelEngine.ts — Comprehensive Unit Expansion Tests', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      complete: vi.fn(),
    };
  });

  it('PanelConfigurationError has name PanelConfigurationError', () => {
    const err = new PanelConfigurationError('test msg');
    expect(err.name).toBe('PanelConfigurationError');
    expect(err.message).toBe('test msg');
  });

  it('returns clean non-evidence receipt when no enabled personas apply to changed paths', async () => {
    const config = buildMinimalConfig();
    const changedFiles = [{ path: 'docs/README.md' }]; // does not match src/**

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'owner/repo',
      headSha: 'sha-1',
      client: mockClient as unknown as OmniRouteClient,
    });
    expect(result.zeroLaneNonEvidence).toBe(true);
    expect(result.arbiter.verdict).toBe('SHIP');
    expect(result.personas).toHaveLength(0);
  });

  it('throws PanelConfigurationError when required persona fails closed', async () => {
    const config = buildMinimalConfig();
    const changedFiles = [{ path: 'src/main.ts' }];

    mockClient.complete.mockRejectedValue(new Error('OmniRoute HTTP 503 Service Unavailable'));

    await expect(
      executePersonaPanel({
        config,
        changedFiles,
        repository: 'owner/repo',
        headSha: 'sha-2',
        client: mockClient as unknown as OmniRouteClient,
      })
    ).rejects.toThrow('required persona failure');
  });

  it('records optionalLane failure into optionalFailures array without aborting panel', async () => {
    const config = buildMinimalConfig();
    const changedFiles = [{ path: 'src/main.ts' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
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
        // Optional lane (grok) fails
        throw new Error('Grok provider timeout');
      } else {
        // Required lane (claude) succeeds
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      }
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'owner/repo',
      headSha: 'sha-3',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(result.personas).toHaveLength(1);
    expect(result.personas[0].id).toBe('sec-lane');
    expect(result.optionalFailures).toHaveLength(1);
    expect(result.optionalFailures[0].id).toBe('opt-lane');
    expect(result.optionalFailures[0].error).toContain('Grok provider timeout');
    expect(result.applicablePersonaIds).toEqual(['sec-lane', 'opt-lane']);
    // A transport-level throw (this one) never reaches a provider response, so there is nothing
    // to report: the failed lane must not carry usage/model fields it never observed.
    expect(result.optionalFailures[0]).not.toHaveProperty('lastKnownUsage');
    expect(result.optionalFailures[0]).not.toHaveProperty('lastKnownModel');
  });

  it('carries bounded token usage and the resolved model for a lane that failed closed after a real provider response', async () => {
    // Counterfactual for this test: comment out the `lastKnownUsage`/`lastKnownModel` capture
    // added to `runPersona` in src/panel/panelEngine.ts (the block right after `const result =
    // await invoke(...)` in the persona attempt loop, and the corresponding fields on the final
    // `PanelConfigurationError` throw) and this assertion fails -- `optionalFailures[0]` reverts
    // to `{ id, error }` with no usage/model, which is exactly the "malformed_output tells you
    // nothing" gap this change closes.
    const config = buildMinimalConfig();
    const changedFiles = [{ path: 'src/main.ts' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
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
        // Optional lane (grok) receives a real, resolved-model response on every attempt but
        // never renders a completed verdict -- a budget-exhaustion shape, not a transport outage.
        return {
          model: 'deepseek-v4-pro-2026-08-01',
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'INCOMPLETE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 48_000, completion: 200, total: 48_200 },
          costUSD: 0.12,
        };
      } else {
        // Required lane (claude) succeeds
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      }
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'owner/repo',
      headSha: 'sha-3b',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(result.optionalFailures).toHaveLength(1);
    expect(result.optionalFailures[0]).toMatchObject({
      id: 'opt-lane',
      lastKnownUsage: { promptTokens: 48_000, completionTokens: 200, totalTokens: 48_200 },
      lastKnownModel: 'deepseek-v4-pro-2026-08-01',
    });
    // The lane's free-form failure detail is preserved for internal callers (this repo's existing
    // contract), but the point of this test is the bounded numeric/model fields above.
    expect(result.optionalFailures[0].error).toContain('INCOMPLETE');
  });

  it('logs a bounded, redacted excerpt of the contract-violating completion locally and never in PanelResult', async () => {
    // Item 5 (REL-892): the actual completion text a failed lane received is a local operator
    // diagnostic only. Prove both halves: (a) it reaches the log, redacted, and (b) it never
    // reaches `PanelResult` -- the object that ultimately feeds a published check.
    const warnSpy = vi.spyOn(logger, 'warn');
    const config = buildMinimalConfig();
    const changedFiles = [{ path: 'src/main.ts' }];
    const secretToken = 'sk-abcdefghijklmnopqrstuvwxyz012345';

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      const allMsg = JSON.stringify(opts.messages);
      if (allMsg.includes('arbiter')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All good' })}\nCT_REVIEW_END:${nonce}`,
          usage: null, costUSD: null,
        };
      }
      if (allMsg.includes('moderator')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null, costUSD: null,
        };
      }
      if (opts.model === 'deepseek-v4-pro') {
        // Never a valid nonce-fenced object: the optional lane fails closed on unparseable
        // structured output, carrying a plausible leaked-secret shape in its completion text.
        return { model: opts.model, content: `Here is my analysis, Bearer ${secretToken}, not fenced at all.`, usage: null, costUSD: null };
      }
      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
        usage: null, costUSD: null,
      };
    });

    const result = await executePersonaPanel({
      config, changedFiles, repository: 'owner/repo', headSha: 'sha-3c',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(result.optionalFailures).toHaveLength(1);
    expect(result.optionalFailures[0].id).toBe('opt-lane');
    // (b) Never in PanelResult, redacted or not.
    expect(JSON.stringify(result)).not.toContain(secretToken);
    expect(JSON.stringify(result)).not.toContain('not fenced at all');
    expect(result.optionalFailures[0]).not.toHaveProperty('rawCompletionExcerpt');

    // (a) Reaches the log, bounded and redacted -- the secret is gone, the rest of the shape
    // survives so an operator can still tell "malformed" from "truncated".
    const diagnosticCall = warnSpy.mock.calls.find(([message]) =>
      String(message).includes('Lane failed closed; last completion excerpt'));
    expect(diagnosticCall).toBeDefined();
    const meta = diagnosticCall?.[1] as { completionExcerpt?: string } | undefined;
    expect(meta?.completionExcerpt).toBeDefined();
    expect(meta?.completionExcerpt).not.toContain(secretToken);
    expect(meta?.completionExcerpt).toContain('not fenced at all');
  });

  it('propagates fenceErr-attached usage and model through to optionalFailures (REL-892)', async () => {
    // Item 3 (REL-892) has two distinct capture sites: `runPersona`'s per-attempt block, and the
    // `fenceErr` block that fires when the response arrives but cannot be parsed. Only the first
    // was covered -- the excerpt test above drives this path with `usage: null`, so it proves the
    // log behaviour while saying nothing about whether the fields attached at the fenceErr site
    // survive `runPersona`'s catch into the final PanelConfigurationError.
    //
    // That propagation is the whole point of the item: it is what distinguishes a lane that
    // exhausted its token budget from one that died having produced almost nothing. Attaching the
    // fields to a copy of fenceErr, or reading the wrong property name in the catch, would leave
    // failures reporting `usage=unavailable` while the usage was in fact observed -- silently, and
    // in exactly the case an operator is trying to diagnose.
    const config = buildMinimalConfig();
    const changedFiles = [{ path: 'src/main.ts' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      const allMsg = JSON.stringify(opts.messages);
      if (allMsg.includes('arbiter')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All good' })}\nCT_REVIEW_END:${nonce}`,
          usage: null, costUSD: null,
        };
      }
      if (allMsg.includes('moderator')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null, costUSD: null,
        };
      }
      if (opts.model === 'deepseek-v4-pro') {
        // Unparseable, but with REAL usage and a resolved model name that differs from the
        // requested one -- the shape of a lane that spent its budget and then violated the
        // structured-output contract.
        return {
          model: 'deepseek-v4-pro-2026-09-01',
          content: 'reasoning ran long and never emitted a fenced object',
          usage: { prompt: 4096, completion: 65536, total: 69632 },
          costUSD: null,
        };
      }
      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
        usage: null, costUSD: null,
      };
    });

    const result = await executePersonaPanel({
      config, changedFiles, repository: 'owner/repo', headSha: 'sha-3d',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(result.optionalFailures).toHaveLength(1);
    const failed = result.optionalFailures[0] as {
      id: string;
      lastKnownUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
      lastKnownModel?: string;
    };
    expect(failed.id).toBe('opt-lane');
    // The decisive assertion: the numbers observed at the fenceErr site reached the caller.
    expect(failed.lastKnownUsage).toEqual({ promptTokens: 4096, completionTokens: 65536, totalTokens: 69632 });
    // And the RESOLVED model the provider reported, not the requested alias.
    expect(failed.lastKnownModel).toBe('deepseek-v4-pro-2026-09-01');
    // The completion text itself still must not ride along.
    expect(JSON.stringify(result)).not.toContain('reasoning ran long');
    expect(failed).not.toHaveProperty('rawCompletionExcerpt');
  });

  it('rejects contradictory APPROVE-with-findings via the corrective turn; evidence is preserved', async () => {
    const config = buildMinimalConfig();
    config.personas = [config.personas[0]]; // required sec-lane only
    const changedFiles = [{ path: 'src/main.ts' }];
    const finding = { severity: 'P0', path: 'src/main.ts', line: 1, title: 'Err', body: 'Err' };
    let personaAttempts = 0;

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : '';

      if (prompt.includes('Role: ARBITER')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'FIX_FIRST', rationale: 'Validated findings require remediation.' })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      }
      if (prompt.includes('Role: MODERATOR')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({
            decision: 'RECONCILED',
            findings: [finding],
          })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      }

      personaAttempts += 1;
      if (personaAttempts === 1) {
        // Contradictory and invalid (REL-888): approval + defect. The persona contract
        // must reject this and spend its bounded corrective turn resolving it — the
        // previous silent downgrade to FINDINGS let a contradictory approval pass.
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [finding] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      }
      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({
          decision: 'FINDINGS',
          findings: [finding],
        })}\nCT_REVIEW_END:${nonce}`,
        usage: null,
        costUSD: null,
      };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'owner/repo',
      headSha: 'sha-4',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(personaAttempts).toBe(2);
    expect(result.personas).toHaveLength(1);
    expect(result.personas[0]).toMatchObject({
      decision: 'FINDINGS',
      findings: [{ severity: 'P0', path: 'src/main.ts', line: 1, title: 'Err', body: 'Err' }],
    });
    expect(result.arbiter.verdict).toBe('FIX_FIRST');
  });

  it('preserves APPROVE when the persona returns no findings', async () => {
    const config = buildMinimalConfig();
    config.personas = [config.personas[0]];
    const changedFiles = [{ path: 'src/main.ts' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : '';
      const body = prompt.includes('Role: ARBITER')
        ? { verdict: 'SHIP', rationale: 'No findings require remediation.' }
        : prompt.includes('Role: MODERATOR')
          ? { decision: 'RECONCILED', findings: [] }
          : { decision: 'APPROVE', findings: [] };

      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(body)}\nCT_REVIEW_END:${nonce}`,
        usage: null,
        costUSD: null,
      };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'owner/repo',
      headSha: 'sha-clean-approval',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(result.personas).toHaveLength(1);
    expect(result.personas[0]).toMatchObject({ decision: 'APPROVE', findings: [] });
    expect(result.arbiter.verdict).toBe('SHIP');
  });

  it('throws PanelConfigurationError when persona returns FINDINGS with empty findings array', async () => {
    const config = buildMinimalConfig();
    config.personas = [config.personas[0]];
    const changedFiles = [{ path: 'src/main.ts' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : '';

      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({
          decision: 'FINDINGS',
          findings: [],
        })}\nCT_REVIEW_END:${nonce}`,
        usage: null,
        costUSD: null,
      };
    });

    await expect(
      executePersonaPanel({
        config,
        changedFiles,
        repository: 'owner/repo',
        headSha: 'sha-5',
        client: mockClient as unknown as OmniRouteClient,
      })
    ).rejects.toThrow('FINDINGS requires at least one finding');
  });
});
