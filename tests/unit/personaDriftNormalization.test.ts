import { describe, expect, it, vi } from 'vitest';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import type { CtReviewConfigV3 } from '../../src/config/schema';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';
import { executePersonaPanel, extractMessageContentText, PanelConfigurationError } from '../../src/panel/panelEngine';

const policy = `
version: 3
profile: chill
quorum: 1
personas:
  - id: security
    enabled: true
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: [codex]
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 900
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 240
      arbiter_timeout_s: 240
  arbiter:
    order: [codex]
`;

function fenced(nonce: string, body: object): string {
  return `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(body)}\nCT_REVIEW_END:${nonce}`;
}

function personaNonceFrom(messages: Array<{ content: unknown }>): string {
  const prompt = messages.map((message) => extractMessageContentText(message.content)).join('\n');
  return prompt.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/)?.[1] ?? 'test-nonce';
}

function callRole(arg: { metadata?: { role?: string } }): string {
  return arg.metadata?.role ?? '';
}

const infraResponses = (model: string, nonce: string) => ({
  arbiter: {
    model,
    content: fenced(nonce, { verdict: 'SHIP', rationale: 'All lanes completed.' }),
    usage: null,
    costUSD: null,
  },
  moderator: {
    model,
    content: fenced(nonce, { decision: 'RECONCILED', findings: [] }),
    usage: null,
    costUSD: null,
  },
});

describe('persona decision contract (REL-888)', () => {
  it('normalizes case-drifted APPROVE with an empty findings array on the first request', async () => {
    const config = parseAndValidateConfig(policy) as unknown as CtReviewConfigV3;
    const personaResponses: any[] = [
      { decision: 'approve', findings: [] },
    ];
    const complete = vi.fn(async ({ model, messages, metadata }: any) => {
      const nonce = personaNonceFrom(messages);
      const role = callRole({ metadata });
      if (role === 'arbiter') return infraResponses(model, nonce).arbiter;
      if (role === 'moderator') return infraResponses(model, nonce).moderator;
      return { model, content: fenced(nonce, personaResponses.shift() ?? { decision: 'APPROVE', findings: [] }), usage: null, costUSD: null };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/auth.ts', patch: '+const safe = true;' }],
      repository: 'calltelemetry/ct-meta',
      headSha: 'abc123',
      client: { complete } as unknown as OmniRouteClient,
    });

    expect(result.quorum.satisfied).toBe(true);
    expect(result.personas[0].decision).toBe('APPROVE');
    expect(complete.mock.calls.filter(([arg]: any[]) => callRole(arg) === 'persona').length).toBe(1);
  });

  it('normalizes case-drifted FINDINGS scalars on the first request', async () => {
    const config = parseAndValidateConfig(policy) as unknown as CtReviewConfigV3;
    const personaResponses: any[] = [
      {
        decision: 'findings',
        findings: [{ severity: 'p2', path: 'src/a.ts', line: '7', startLine: null, title: 't', body: 'b' }],
      },
    ];
    const complete = vi.fn(async ({ model, messages, metadata }: any) => {
      const nonce = personaNonceFrom(messages);
      const role = callRole({ metadata });
      if (role === 'arbiter') return infraResponses(model, nonce).arbiter;
      if (role === 'moderator') return infraResponses(model, nonce).moderator;
      return { model, content: fenced(nonce, personaResponses.shift() ?? { decision: 'APPROVE', findings: [] }), usage: null, costUSD: null };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/auth.ts', patch: '+const unsafe = true;' }],
      repository: 'calltelemetry/ct-meta',
      headSha: 'abc123',
      client: { complete } as unknown as OmniRouteClient,
    });

    expect(result.quorum.satisfied).toBe(true);
    expect(result.personas[0].decision).toBe('FINDINGS');
    expect(result.personas[0].findings[0].severity).toBe('P2');
    expect(result.personas[0].findings[0].line).toBe(7);
    expect(complete.mock.calls.filter(([arg]: any[]) => callRole(arg) === 'persona').length).toBe(1);
  });

  it('still spends the corrective turn on semantic synonyms the normalizer must not reinterpret', async () => {
    const config = parseAndValidateConfig(policy) as unknown as CtReviewConfigV3;
    const personaResponses: any[] = [
      { decision: 'pass', findings: [] },
      { decision: 'APPROVE', findings: [] },
    ];
    const complete = vi.fn(async ({ model, messages, metadata }: any) => {
      const nonce = personaNonceFrom(messages);
      const role = callRole({ metadata });
      if (role === 'arbiter') return infraResponses(model, nonce).arbiter;
      if (role === 'moderator') return infraResponses(model, nonce).moderator;
      return { model, content: fenced(nonce, personaResponses.shift() ?? { decision: 'APPROVE', findings: [] }), usage: null, costUSD: null };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/auth.ts', patch: '+const safe = true;' }],
      repository: 'calltelemetry/ct-meta',
      headSha: 'abc123',
      client: { complete } as unknown as OmniRouteClient,
    });

    expect(result.personas[0].decision).toBe('APPROVE');
    expect(complete.mock.calls.filter(([arg]: any[]) => callRole(arg) === 'persona').length).toBe(2);
  });

  it('rejects APPROVE carrying findings as contradictory: one corrective turn, then resolved', async () => {
    const config = parseAndValidateConfig(policy) as unknown as CtReviewConfigV3;
    const personaResponses: any[] = [
      // Contradictory: approval + defect. Must be rejected, never downgraded to FINDINGS.
      { decision: 'APPROVE', findings: [{ severity: 'P1', path: 'src/a.ts', line: 3, startLine: null, title: 't', body: 'b' }] },
      // Corrective turn resolves the contradiction: findings carry the decision.
      { decision: 'FINDINGS', findings: [{ severity: 'P1', path: 'src/a.ts', line: 3, startLine: null, title: 't', body: 'b' }] },
    ];
    const complete = vi.fn(async ({ model, messages, metadata }: any) => {
      const nonce = personaNonceFrom(messages);
      const role = callRole({ metadata });
      if (role === 'arbiter') return infraResponses(model, nonce).arbiter;
      if (role === 'moderator') return infraResponses(model, nonce).moderator;
      return { model, content: fenced(nonce, personaResponses.shift() ?? { decision: 'APPROVE', findings: [] }), usage: null, costUSD: null };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/auth.ts', patch: '+const unsafe = true;' }],
      repository: 'calltelemetry/ct-meta',
      headSha: 'abc123',
      client: { complete } as unknown as OmniRouteClient,
    });

    expect(result.personas[0].decision).toBe('FINDINGS');
    expect(result.personas[0].findings[0].severity).toBe('P1');
    expect(complete.mock.calls.filter(([arg]: any[]) => callRole(arg) === 'persona').length).toBe(2);
  });

  it('fails closed when the contradiction survives the corrective turn', async () => {
    const config = parseAndValidateConfig(policy) as unknown as CtReviewConfigV3;
    const contradictory = {
      decision: 'APPROVE',
      findings: [{ severity: 'P1', path: 'src/a.ts', line: 3, startLine: null, title: 't', body: 'b' }],
    };
    const complete = vi.fn(async ({ model, messages, metadata }: any) => {
      const nonce = personaNonceFrom(messages);
      const role = callRole({ metadata });
      if (role === 'arbiter') return infraResponses(model, nonce).arbiter;
      if (role === 'moderator') return infraResponses(model, nonce).moderator;
      return { model, content: fenced(nonce, contradictory), usage: null, costUSD: null };
    });

    await expect(executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/auth.ts', patch: '+const unsafe = true;' }],
      repository: 'calltelemetry/ct-meta',
      headSha: 'abc123',
      client: { complete } as unknown as OmniRouteClient,
    })).rejects.toThrow(/contradictory with findings/);
  });

  it('normalizes a case-drifted moderator decision through the real panel flow', async () => {
    const config = parseAndValidateConfig(policy) as unknown as CtReviewConfigV3;
    const complete = vi.fn(async ({ model, messages, metadata }: any) => {
      const nonce = personaNonceFrom(messages);
      const role = callRole({ metadata });
      if (role === 'arbiter') {
        return { model, content: fenced(nonce, { verdict: 'ship', rationale: 'ok' }), usage: null, costUSD: null };
      }
      if (role === 'moderator') {
        return { model, content: fenced(nonce, { decision: 'reconciled', findings: [] }), usage: null, costUSD: null };
      }
      return { model, content: fenced(nonce, { decision: 'APPROVE', findings: [] }), usage: null, costUSD: null };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/auth.ts', patch: '+const safe = true;' }],
      repository: 'calltelemetry/ct-meta',
      headSha: 'abc123',
      client: { complete } as unknown as OmniRouteClient,
    });

    // Moderator and arbiter ride the same call-site normalizer: case-drifted
    // role enums are repaired before their contracts are checked.
    expect(result.moderator.decision).toBe('RECONCILED');
    expect(result.arbiter.verdict).toBe('SHIP');
  });

  it('case-drifted approve with findings materializes the contradiction and spends the corrective turn', async () => {
    const config = parseAndValidateConfig(policy) as unknown as CtReviewConfigV3;
    const personaResponses: any[] = [
      // Case drift turns 'approve' into APPROVE — which then contradicts the
      // attached finding. The normalizer must NOT hide that: the contract check
      // rejects the materialized contradiction and the corrective turn resolves it.
      { decision: 'approve', findings: [{ severity: 'P1', path: 'src/a.ts', line: 3, startLine: null, title: 't', body: 'b' }] },
      { decision: 'FINDINGS', findings: [{ severity: 'P1', path: 'src/a.ts', line: 3, startLine: null, title: 't', body: 'b' }] },
    ];
    const complete = vi.fn(async ({ model, messages, metadata }: any) => {
      const nonce = personaNonceFrom(messages);
      const role = callRole({ metadata });
      if (role === 'arbiter') return infraResponses(model, nonce).arbiter;
      if (role === 'moderator') return infraResponses(model, nonce).moderator;
      return { model, content: fenced(nonce, personaResponses.shift() ?? { decision: 'APPROVE', findings: [] }), usage: null, costUSD: null };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/auth.ts', patch: '+const unsafe = true;' }],
      repository: 'calltelemetry/ct-meta',
      headSha: 'abc123',
      client: { complete } as unknown as OmniRouteClient,
    });

    expect(result.personas[0].decision).toBe('FINDINGS');
    expect(result.personas[0].findings[0].severity).toBe('P1');
    expect(complete.mock.calls.filter(([arg]: any[]) => callRole(arg) === 'persona').length).toBe(2);
  });
});
