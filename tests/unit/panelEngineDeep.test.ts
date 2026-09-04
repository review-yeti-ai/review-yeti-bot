import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePersonaPanel, PanelConfigurationError } from '../../src/panel/panelEngine';
import { CtReviewConfigV3, ctReviewConfigV3Schema } from '../../src/config/schema';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

// Parsed through the real schema (rather than hand-typed as CtReviewConfigV3) so
// all the `.default(...)`-backed top-level sections (reviews, chat, etc.) are
// populated the same way production config loading populates them.
function buildDeepConfig(): CtReviewConfigV3 {
  return ctReviewConfigV3Schema.parse({
    version: 3,
    profile: 'assertive',
    quorum: 2,
    personas: [
      {
        id: 'sec-lane',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['src/security/**'],
        providers: ['claude', 'grok'],
      },
      {
        id: 'correct-lane',
        enabled: true,
        required: true,
        charter: 'builtin:correctness',
        paths: ['src/security/**'],
        providers: ['codex'],
      },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 120,
      providers: [
        { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'grok', enabled: true, model: 'deepseek-v4-pro', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'codex', enabled: true, model: 'gpt-5.6-sol', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
      ],
      arbiter: { order: ['claude', 'codex'] },
    },
    path_instructions: [],
    rules: [],
    reviewer_effort: 'high',
    confidence_threshold: 70,
    mascot: true,
    display: { mascot: true },
  });
}

describe('panelEngine.ts — Deep Edge Case & Nonce-Fence Unit Tests', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      complete: vi.fn(),
    };
  });

  it('matches glob paths correctly (src/security/**)', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      if (prompt.includes('Role: ARBITER')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Passes cleanly' })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 15, completion: 15, total: 30 },
          costUSD: 0.0002,
        };
      } else if (prompt.includes('Role: MODERATOR')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 10, completion: 10, total: 20 },
          costUSD: 0.0001,
        };
      } else {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 5, completion: 5, total: 10 },
          costUSD: 0.00005,
        };
      }
    });

    const panelResult = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-123',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(panelResult.personas).toHaveLength(2);
    expect(panelResult.arbiter.verdict).toBe('SHIP');
  });

  it('applies one OpenRouter request contract and trace identity to every panel role', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      const body = prompt.includes('Role: ARBITER')
        ? { verdict: 'SHIP', rationale: 'The parity fixture is safe.' }
        : prompt.includes('Role: MODERATOR')
          ? { decision: 'RECONCILED', findings: [] }
          : { decision: 'APPROVE', findings: [] };
      return {
        model: opts.model,
        content: JSON.stringify({ nonce, ...body }),
        usage: { prompt: 5, completion: 5, total: 10 },
        costUSD: 0.00005,
        raw: {},
      };
    });

    await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-request-parity',
      client: mockClient as unknown as OmniRouteClient,
      jobId: 'run_11111111111111111111111111111111',
      requestPolicy: {
        stream: true,
        ttftTimeoutMs: 30_000,
        maxTokens: 24_576,
        models: ['z-ai/glm-5.3-flash'],
        responseFormat: { type: 'json_object' },
        provider: {
          allow_fallbacks: true,
          require_parameters: true,
          ignore: ['morph', 'fireworks'],
          data_collection: 'deny',
        },
        metadata: { qualificationMode: 'full-panel' },
      },
    } as any);

    expect(mockClient.complete).toHaveBeenCalledTimes(4);
    const requests = mockClient.complete.mock.calls.map(([request]: any[]) => request);
    expect(requests.every((request: any) => request.messages[1].content.includes(`"nonce"`))).toBe(true);
    expect(requests.map((request: any) => request.persona).sort()).toEqual([
      'arbiter', 'correct-lane', 'moderator', 'sec-lane',
    ]);
    for (const request of requests) {
      const role = request.metadata.role;
      expect(request).toMatchObject({
        jobId: 'run_11111111111111111111111111111111',
        stream: true,
        ttftTimeoutMs: 30_000,
        maxTokens: 24_576,
        models: ['z-ai/glm-5.3-flash'],
        provider: {
          allow_fallbacks: true,
          require_parameters: true,
          ignore: ['morph', 'fireworks'],
          data_collection: 'deny',
        },
        metadata: {
          qualificationMode: 'full-panel',
          role: expect.any(String),
          persona: expect.any(String),
        },
      });
      expect(request.responseFormat).toMatchObject({
        type: 'json_schema',
        json_schema: {
          strict: true,
          name: `ct_review_${role}_v1`,
          schema: {
            type: 'object',
            additionalProperties: false,
          },
        },
      });
      const schema = request.responseFormat.json_schema.schema;
      expect(schema.required).toContain('nonce');
      if (role === 'persona' || role === 'moderator') {
        expect(schema.required).toContain('findings');
        expect(schema.properties.findings.items.properties.severity.enum).toEqual(['P0', 'P1', 'P2']);
      }
      if (role === 'arbiter') {
        expect(schema.required).toEqual(['nonce', 'verdict', 'rationale']);
        expect(schema.properties.verdict.enum).toEqual(['SHIP', 'FIX_FIRST', 'BLOCK']);
      }
    }
  });

  it('fails closed when native JSON returns the wrong request nonce', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const body = prompt.includes('Role: ARBITER')
        ? { verdict: 'SHIP', rationale: 'Wrong nonce must still fail.' }
        : prompt.includes('Role: MODERATOR')
          ? { decision: 'RECONCILED', findings: [] }
          : { decision: 'APPROVE', findings: [] };
      return {
        model: 'deepseek/deepseek-v4-flash-0731',
        content: JSON.stringify({ nonce: 'wrong-request', ...body }),
        usage: null,
        costUSD: null,
        raw: {},
      };
    });

    await expect(executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-wrong-native-nonce',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: {
        responseFormat: { type: 'json_object' },
      },
    })).rejects.toThrow('required persona failure');
  });

  it('retries an invalid severity without coercing it and includes the complete schema in correction', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    const calls: any[] = [];
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      const role = opts.metadata.role;
      const correcting = opts.messages.some((message: any) => String(message.content).includes('STRUCTURED_OUTPUT_CORRECTION'));
      calls.push({ role, correcting, request: opts });
      if (role === 'arbiter') {
        return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'Passes.' }), usage: null, costUSD: null, raw: {} };
      }
      if (role === 'moderator') {
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      if (opts.persona === 'sec-lane' && !correcting) {
        return {
          model: opts.model,
          content: JSON.stringify({ nonce, decision: 'FINDINGS', findings: [{
            severity: 'HIGH', path: 'src/security/auth.ts', line: 1, title: 'Bad severity', body: 'The provider used a non-contract severity.', suggestion: null,
          }] }),
          usage: null,
          costUSD: null,
          raw: {},
        };
      }
      if (opts.persona === 'sec-lane') {
        return {
          model: opts.model,
          content: JSON.stringify({ nonce, decision: 'FINDINGS', findings: [{
            severity: 'P1', path: 'src/security/auth.ts', line: 1, title: 'Corrected severity', body: 'The provider returned a contract-compliant finding.', suggestion: null,
          }] }),
          usage: null,
          costUSD: null,
          raw: {},
        };
      }
      return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: null, costUSD: null, raw: {} };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-invalid-severity',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_object' } },
    });

    expect(result.personas.find((persona) => persona.id === 'sec-lane')?.findings[0].severity).toBe('P1');
    const correction = calls.find((call) => call.role === 'persona' && call.correcting);
    expect(correction).toBeDefined();
    expect(correction.request.messages.at(-1).content).toContain('P0');
    expect(correction.request.messages.at(-1).content).toContain('P1');
    expect(correction.request.messages.at(-1).content).toContain('severity');
  });

  it('uses fallback provider when primary provider fails in persona lane', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      if (prompt.includes('Role: ARBITER')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Passes' })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      } else if (prompt.includes('Role: MODERATOR')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      } else {
        // Persona lane
        if (opts.model.includes('claude')) {
          // Primary provider fails!
          throw new Error('Claude API Timeout');
        } else {
          // Fallback provider (grok/deepseek-v4-pro or codex/gpt-5.6-sol) succeeds
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: null,
            costUSD: null,
          };
        }
      }
    });

    const panelResult = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-fallback',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(panelResult.personas).toHaveLength(2);
    const secLane = panelResult.personas.find((p) => p.id === 'sec-lane');
    expect(secLane?.providerId).toBe('grok');
    expect(secLane?.model).toBe('deepseek-v4-pro');
  });

  it('throws PanelConfigurationError when missing nonce fence in model output', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts' }];

    mockClient.complete.mockResolvedValue({
      model: 'claude-5-sonnet',
      content: 'Here is my review without any CT_REVIEW_BEGIN nonce fences: {"decision":"APPROVE","findings":[]}',
      usage: null,
      costUSD: null,
    });

    await expect(
      executePersonaPanel({
        config,
        changedFiles,
        repository: 'calltelemetry/repo',
        headSha: 'head-sha-bad-fence',
        client: mockClient as unknown as OmniRouteClient,
      })
    ).rejects.toThrow('required persona failure');
  });

  it('allows one bounded nonce-fence correction before failing closed', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts' }];
    let arbiterAttempts = 0;

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const requestNonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      if (prompt.includes('Role: ARBITER')) {
        arbiterAttempts += 1;
        if (arbiterAttempts === 1) {
          return { model: opts.model, content: '{"verdict":"SHIP","rationale":"Needs the required fence."}', usage: null, costUSD: null };
        }
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${requestNonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Corrected response.' })}\nCT_REVIEW_END:${requestNonce}`,
          usage: null,
          costUSD: null,
        };
      }
      if (prompt.includes('Role: MODERATOR')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${requestNonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${requestNonce}`,
          usage: null,
          costUSD: null,
        };
      }
      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${requestNonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${requestNonce}`,
        usage: null,
        costUSD: null,
      };
    });

    const panelResult = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-fence-recovery',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(panelResult.arbiter.verdict).toBe('SHIP');
    expect(arbiterAttempts).toBe(2);
    expect(mockClient.complete.mock.calls.some(([request]: any[]) =>
      request.messages.some((message: any) => message.content.includes('STRUCTURED_OUTPUT_CORRECTION')),
    )).toBe(true);
  });

  it('throws PanelConfigurationError when JSON inside nonce fence is invalid syntax', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';

      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n{ invalid json syntax ... }\nCT_REVIEW_END:${nonce}`,
        usage: null,
        costUSD: null,
      };
    });

    await expect(
      executePersonaPanel({
        config,
        changedFiles,
        repository: 'calltelemetry/repo',
        headSha: 'head-sha-bad-json',
        client: mockClient as unknown as OmniRouteClient,
      })
    ).rejects.toThrow('required persona failure');
  });

  it('sends one structured correction when a fenced finding has an invalid severity', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts' }];
    const personaAttempts = new Map<string, number>();

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const requestNonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      if (prompt.includes('Role: ARBITER')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${requestNonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Passes after validation.' })}\nCT_REVIEW_END:${requestNonce}`,
          usage: null,
          costUSD: null,
        };
      }
      if (prompt.includes('Role: MODERATOR')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${requestNonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${requestNonce}`,
          usage: null,
          costUSD: null,
        };
      }

      const personaMatch = prompt.match(/\[Persona: ([^\]]+)\]/);
      const persona = personaMatch ? personaMatch[1] : 'unknown';
      const attempt = (personaAttempts.get(persona) || 0) + 1;
      personaAttempts.set(persona, attempt);
      const body = persona === 'sec-lane' && attempt === 1
        ? { decision: 'FINDINGS', findings: [{ severity: 'P3', path: 'src/security/auth.ts', line: 1, title: 'Invalid severity', body: 'This must be corrected.' }] }
        : { decision: 'APPROVE', findings: [] };
      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${requestNonce}\n${JSON.stringify(body)}\nCT_REVIEW_END:${requestNonce}`,
        usage: null,
        costUSD: null,
      };
    });

    const panelResult = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-invalid-finding-recovery',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(panelResult.personas).toHaveLength(2);
    expect(personaAttempts.get('sec-lane')).toBe(2);
    expect(mockClient.complete.mock.calls.some(([request]: any[]) =>
      request.messages.some((message: any) => message.content.includes('STRUCTURED_OUTPUT_CORRECTION')),
    )).toBe(true);
  });

  it('supports BLOCK arbiter verdict with rationale', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      if (prompt.includes('Role: ARBITER')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'BLOCK', rationale: 'Critical security violation blocks merge.' })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      } else if (prompt.includes('Role: MODERATOR')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      } else {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      }
    });

    const panelResult = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-block',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(panelResult.arbiter.verdict).toBe('BLOCK');
    expect(panelResult.arbiter.rationale).toContain('Critical security violation');
  });
});
