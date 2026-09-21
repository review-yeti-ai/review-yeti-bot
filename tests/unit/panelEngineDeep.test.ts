import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePersonaPanel, PanelCancellationError, PanelConfigurationError, PanelDeadlineExceededError, extractMessageContentText, getActivePersonaCallCount, mapConcurrentSettled, MAX_CONCURRENT_PERSONAS, EMPTY_COMPLETION_MAX_ATTEMPTS, INCOMPLETE_REVIEW_MAX_ATTEMPTS, TRANSPORT_MAX_RETRIES, TRANSPORT_RETRY_BASE_DELAY_MS, TRANSPORT_RETRY_MAX_DELAY_MS, transportRetryDelayMs } from '../../src/panel/panelEngine';
import { CtReviewConfigV3, ctReviewConfigV3Schema } from '../../src/config/schema';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';
import { OpenRouterResponseError } from '../../src/gateway/openRouterClient';

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

// REL-886: `bifrost/pr-reviewer` is a single Bifrost surge-router alias, not a
// second provider identity -- the fix here retries that one alias with its own
// budget instead of adding a second `reviewers.providers` entry. This config
// intentionally gives sec-lane exactly one provider so a test against it can
// only pass by retrying that same alias, never by failing over to a different
// configured identity.
function buildSingleAliasDeepConfig(): CtReviewConfigV3 {
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
        providers: ['bifrost'],
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
        { id: 'bifrost', enabled: true, model: 'bifrost/pr-reviewer', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'codex', enabled: true, model: 'gpt-5.6-sol', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
      ],
      arbiter: { order: ['bifrost', 'codex'] },
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
      const prompt = extractMessageContentText(opts.messages[1].content);
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
      const prompt = extractMessageContentText(opts.messages[1].content);
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
        responseFormat: { type: 'json_schema' },
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
    expect(requests.every((request: any) => extractMessageContentText(request.messages[1].content).includes(`"nonce"`))).toBe(true);
    expect(requests.map((request: any) => request.persona).sort()).toEqual([
      'arbiter', 'correct-lane', 'moderator', 'sec-lane',
    ]);
    // A response that is already a valid final object may terminate on the first native
    // exploration turn. In that case the generic JSON-object contract is sufficient; the strict
    // role schema is reserved for a later terminal turn (covered below).
    expect(requests.every((request: any) => request.responseFormat)).toBe(true);
    expect(requests.every((request: any) => request.responseFormat.type === 'json_object')).toBe(true);
    for (const request of requests) {
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
    }
  });

  it.each(['direct', 'wrapped'])('uses generic native JSON for %s exploration and reserves strict schema for the terminal turn', async (envelope) => {
    const config = buildDeepConfig();
    config.personas = config.personas.map((persona) => persona.id === 'sec-lane'
      ? { ...persona, id: 'native-lane', maxTurns: 2 }
      : persona);
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    const attempts = new Map<string, number>();

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      const role = opts.metadata.role;
      const key = `${role}:${opts.persona}`;
      const attempt = (attempts.get(key) || 0) + 1;
      attempts.set(key, attempt);

      if (role === 'persona' && opts.persona === 'native-lane' && attempt === 1) {
        const toolObject = JSON.stringify({
          tool: 'read_file',
          args: { path: 'src/security/auth.ts', range: { startLine: 1, endLine: 3 } },
        });
        return {
          model: opts.model,
          content: envelope === 'wrapped' ? `\`\`\`json\n${toolObject}\n\`\`\`` : toolObject,
          usage: null,
          costUSD: null,
          raw: {},
        };
      }

      const body = role === 'arbiter'
        ? { verdict: 'SHIP', rationale: 'The native turn protocol is valid.' }
        : role === 'moderator'
          ? { decision: 'RECONCILED', findings: [] }
          : { decision: 'APPROVE', findings: [] };
      return {
        model: opts.model,
        content: JSON.stringify({ nonce, ...body }),
        usage: null,
        costUSD: null,
        raw: {},
      };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-native-turns',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    });

    const secRequests = mockClient.complete.mock.calls
      .map(([request]: any[]) => request)
      .filter((request: any) => request.metadata.role === 'persona' && request.persona === 'native-lane');
    expect(secRequests).toHaveLength(2);
    expect(secRequests[0].responseFormat).toEqual({ type: 'json_object' });
    expect(secRequests[1].responseFormat).toMatchObject({
      type: 'json_schema',
      json_schema: {
        strict: true,
        name: 'review_yeti_persona_v1',
        schema: { type: 'object', additionalProperties: false },
      },
    });
    expect(secRequests[1].messages.at(-1).content).toContain('NATIVE TURN 2 OF 2; REMAINING TURNS: 0');
    expect(secRequests[1].messages.at(-1).content).toContain('terminal finalization turn');
    expect(secRequests[1].messages.at(-1).content).not.toContain('CT_REVIEW_BEGIN:');
    expect(result.personas.find((persona) => persona.id === 'native-lane')?.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'read_file',
        args: { path: 'src/security/auth.ts', range: { startLine: 1, endLine: 3 } },
      }),
    ]);
  });

  it('makes native format correction terminal and does not reopen tool exploration', async () => {
    const config = buildDeepConfig();
    config.personas = config.personas.map((persona) => persona.id === 'sec-lane'
      ? { ...persona, id: 'correction-lane', maxTurns: 3 }
      : persona);
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    const attempts = new Map<string, number>();

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      const role = opts.metadata.role;
      const key = `${role}:${opts.persona}`;
      const attempt = (attempts.get(key) || 0) + 1;
      attempts.set(key, attempt);
      if (role === 'persona' && opts.persona === 'correction-lane' && attempt === 1) {
        return { model: opts.model, content: 'not JSON', usage: null, costUSD: null, raw: {} };
      }
      const body = role === 'arbiter'
        ? { verdict: 'SHIP', rationale: 'The corrected native response is valid.' }
        : role === 'moderator'
          ? { decision: 'RECONCILED', findings: [] }
          : { decision: 'APPROVE', findings: [] };
      return { model: opts.model, content: JSON.stringify({ nonce, ...body }), usage: null, costUSD: null, raw: {} };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-native-correction',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    });

    const correctionRequests = mockClient.complete.mock.calls
      .map(([request]: any[]) => request)
      .filter((request: any) => request.metadata.role === 'persona' && request.persona === 'correction-lane');
    expect(correctionRequests).toHaveLength(2);
    expect(correctionRequests.map((request: any) => request.responseFormat.type)).toEqual(['json_object', 'json_schema']);
    expect(correctionRequests[1].messages.at(-1).content).toContain('NATIVE TURN 2 OF 3; REMAINING TURNS: 1');
    expect(correctionRequests[1].messages.at(-1).content).toContain('terminal finalization turn');
    expect(correctionRequests[1].messages.at(-1).content).not.toContain('request another read-only tool');
    expect(result.personas.find((persona) => persona.id === 'correction-lane')?.decision).toBe('APPROVE');
  });

  it('fails closed instead of executing a native final object that mixes tool fields with approval', async () => {
    const baseConfig = buildDeepConfig();
    const config = {
      ...baseConfig,
      quorum: 1,
      personas: [{ ...baseConfig.personas[0], id: 'hybrid-lane', providers: ['claude'], maxTurns: 1 }],
      reviewers: { ...baseConfig.reviewers, fallback: 'none' as const },
    };
    const readFile = vi.fn().mockResolvedValue('should not be read');
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      if (opts.metadata.role !== 'persona') {
        return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'not reached' }), usage: null, costUSD: null, raw: {} };
      }
      return {
        model: opts.model,
        content: JSON.stringify({
          nonce,
          decision: 'APPROVE',
          findings: [],
          tool: 'read_file',
          args: { path: 'src/other.ts' },
        }),
        usage: null,
        costUSD: null,
        raw: {},
      };
    });

    await expect(executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-native-hybrid',
      client: mockClient as unknown as OmniRouteClient,
      repoFileProvider: {
        readFile,
        findFiles: vi.fn().mockResolvedValue([]),
        treeTruncated: vi.fn().mockResolvedValue(false),
      },
      requestPolicy: { responseFormat: { type: 'json_object' } },
    })).rejects.toThrow('required persona failure');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('fails closed when persona INCOMPLETE has empty findings', async () => {
    const baseConfig = buildDeepConfig();
    const config = {
      ...baseConfig,
      quorum: 1,
      personas: [{ ...baseConfig.personas[0], id: 'incomplete-lane', providers: ['claude'], maxTurns: 1 }],
      reviewers: { ...baseConfig.reviewers, fallback: 'none' as const },
    };

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      const role = opts.metadata?.role || (prompt.includes('Role: ARBITER') ? 'arbiter' : prompt.includes('Role: MODERATOR') ? 'moderator' : 'persona');
      if (role === 'moderator') {
        return {
          model: opts.model,
          content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }),
          usage: null,
          costUSD: null,
          raw: {},
        };
      }
      if (role === 'arbiter') {
        return {
          model: opts.model,
          content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'All clear' }),
          usage: null,
          costUSD: null,
          raw: {},
        };
      }
      return {
        model: opts.model,
        content: JSON.stringify({ nonce, decision: 'INCOMPLETE', findings: [] }),
        usage: null,
        costUSD: null,
        raw: {},
      };
    });

    await expect(executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }],
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-native-incomplete',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    })).rejects.toThrow(/required persona failure.*INCOMPLETE/iu);

    const personaRequest = mockClient.complete.mock.calls
      .map(([request]: any[]) => request)
      .find((request: any) => request.metadata?.role === 'persona');
    expect(personaRequest.responseFormat.json_schema.schema.properties.decision.enum).toContain('INCOMPLETE');
  });

  it('retains an optional INCOMPLETE lane as a failure rather than an empty approval', async () => {
    const baseConfig = buildDeepConfig();
    const config = {
      ...baseConfig,
      quorum: 1,
      personas: [
        { ...baseConfig.personas[0], id: 'completed-lane', providers: ['claude'], maxTurns: 1 },
        { ...baseConfig.personas[0], id: 'incomplete-lane', required: false, providers: ['claude'], maxTurns: 1 },
      ],
      reviewers: { ...baseConfig.reviewers, fallback: 'none' as const },
    };
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      const body = opts.metadata?.role === 'arbiter'
        ? { verdict: 'SHIP', rationale: 'Completed lane has no findings' }
        : opts.metadata?.role === 'moderator'
          ? { decision: 'RECONCILED', findings: [] }
          : { decision: opts.persona === 'incomplete-lane' ? 'INCOMPLETE' : 'APPROVE', findings: [] };
      return { model: opts.model, content: JSON.stringify({ nonce, ...body }), usage: null, costUSD: null, raw: {} };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }],
      repository: 'calltelemetry/repo', headSha: 'head-sha-optional-incomplete',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    });

    expect(result.personas.map((persona) => persona.id)).toEqual(['completed-lane']);
    // The lane received a real (if contract-violating) response on every attempt, so the failure
    // carries the resolved model it was served even though it never produced usable findings.
    // `failureClass` is the coded reason `runPersona` assigns at the exact point it observed this
    // terminal `PanelStructuredOutputError` (REL-892 finding 2) -- authoritative over any later
    // re-derivation of the class from `error`'s free-form text at the publishing layer.
    expect(result.optionalFailures).toEqual([{
      id: 'incomplete-lane',
      error: expect.stringContaining('INCOMPLETE'),
      lastKnownModel: expect.any(String),
      failureClass: 'malformed_output',
    }]);
    expect(result.applicablePersonaIds).toEqual(['completed-lane', 'incomplete-lane']);
  });

  it('retries once then fails over to the fallback provider when a persona reports INCOMPLETE', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      const role = opts.metadata?.role || (prompt.includes('Role: ARBITER') ? 'arbiter' : prompt.includes('Role: MODERATOR') ? 'moderator' : 'persona');
      if (role === 'arbiter') {
        return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'Fallback lane completed' }), usage: null, costUSD: null, raw: {} };
      }
      if (role === 'moderator') {
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      if (opts.model.includes('claude')) {
        // Primary provider never completes: each attempt reports INCOMPLETE.
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'INCOMPLETE', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: null, costUSD: null, raw: {} };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-incomplete-failover',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    });

    const secLane = result.personas.find((persona) => persona.id === 'sec-lane');
    expect(secLane?.providerId).toBe('grok');
    const claudeLaneCalls = mockClient.complete.mock.calls.filter(([request]: any[]) =>
      request.metadata?.role === 'persona'
      && request.metadata?.persona === 'sec-lane'
      && request.model.includes('claude'));
    // INCOMPLETE consumes the bounded fresh-request retry before failover.
    expect(claudeLaneCalls).toHaveLength(2);
  });

  // REL-886 (redesigned): `bifrost/pr-reviewer` stays the single configured
  // model identity -- no second provider entry. A real gateway call can return
  // HTTP 200 with no usable completion content (openRouterClient.ts throws
  // OpenRouterResponseError('...empty completion content', 502)). Rather than
  // exhausting a 2-attempt generic retry and falling off the end of a
  // one-element providersToTry, the persona loop now retries the *same* alias
  // with its own larger budget (EMPTY_COMPLETION_MAX_ATTEMPTS) -- re-entering
  // Bifrost's own routing is the failover for this failure mode, at the layer
  // that already owns it. This proves the required sec-lane survives repeated
  // empty completions and completes on the same 'bifrost' identity throughout,
  // never switching provider identity.
  it('retries the same alias across its own larger budget and completes without a second provider', async () => {
    const config = buildSingleAliasDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    let bifrostAttempts = 0;
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      const role = opts.metadata?.role || (prompt.includes('Role: ARBITER') ? 'arbiter' : prompt.includes('Role: MODERATOR') ? 'moderator' : 'persona');
      if (role === 'arbiter') {
        return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'Both lanes completed' }), usage: null, costUSD: null, raw: {} };
      }
      if (role === 'moderator') {
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      if (opts.model === 'bifrost/pr-reviewer') {
        bifrostAttempts++;
        // Every attempt but the last returns HTTP-200-empty-completion; the
        // final attempt (still within EMPTY_COMPLETION_MAX_ATTEMPTS) succeeds.
        if (bifrostAttempts < EMPTY_COMPLETION_MAX_ATTEMPTS) {
          throw new OpenRouterResponseError('OpenRouter returned empty completion content', 502);
        }
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: null, costUSD: null, raw: {} };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-empty-completion-same-alias',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    });

    const secLane = result.personas.find((persona) => persona.id === 'sec-lane');
    expect(secLane?.providerId).toBe('bifrost');
    expect(secLane?.model).toBe('bifrost/pr-reviewer');
    expect(secLane?.decision).toBe('APPROVE');
    expect(bifrostAttempts).toBe(EMPTY_COMPLETION_MAX_ATTEMPTS);
    // Every attempt must have targeted the exact same alias -- no second
    // provider/model identity was ever configured or reached for.
    const secLaneCalls = mockClient.complete.mock.calls.filter(([request]: any[]) =>
      request.metadata?.role === 'persona' && request.metadata?.persona === 'sec-lane');
    expect(secLaneCalls.every(([request]: any[]) => request.model === 'bifrost/pr-reviewer')).toBe(true);
  });

  // The larger budget must still fail closed once genuinely exhausted -- this
  // is not a loosening of `required: true`, quorum, or the fail-closed
  // contract; it only widens how many times the same alias gets re-entered
  // first.
  it('fails the required lane closed once the empty-completion budget is exhausted on the same alias', async () => {
    const config = buildSingleAliasDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const role = opts.metadata?.role || (prompt.includes('Role: ARBITER') ? 'arbiter' : prompt.includes('Role: MODERATOR') ? 'moderator' : 'persona');
      if (opts.model === 'bifrost/pr-reviewer') {
        // Every attempt, without exception, returns an empty completion.
        throw new OpenRouterResponseError('OpenRouter returned empty completion content', 502);
      }
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      if (role === 'arbiter') {
        return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'n/a' }), usage: null, costUSD: null, raw: {} };
      }
      if (role === 'moderator') {
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: null, costUSD: null, raw: {} };
    });

    await expect(executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-empty-completion-exhausted',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    })).rejects.toThrow(/persona sec-lane failed closed/iu);

    const bifrostCalls = mockClient.complete.mock.calls.filter(([request]: any[]) =>
      request.metadata?.role === 'persona'
      && request.metadata?.persona === 'sec-lane'
      && request.model === 'bifrost/pr-reviewer');
    expect(bifrostCalls).toHaveLength(EMPTY_COMPLETION_MAX_ATTEMPTS);
  });

  // An INCOMPLETE decision is a WELL-FORMED answer -- the persona contract
  // explicitly asks for it when evidence is insufficient, rather than inventing
  // a finding or approving to burn the last turn. It used to be thrown as a
  // structured-output failure, which sent it down the provider-identity
  // failover path; with one configured alias there is no second identity, so a
  // required lane failed closed on the very answer the contract requested.
  // It now re-enters the same alias, exactly like the empty-completion
  // signature, so the router can land on a different backend.
  it('retries the same alias on INCOMPLETE and completes without a second provider', async () => {
    const config = buildSingleAliasDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    let bifrostAttempts = 0;
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      const role = opts.metadata?.role || (prompt.includes('Role: ARBITER') ? 'arbiter' : prompt.includes('Role: MODERATOR') ? 'moderator' : 'persona');
      if (role === 'arbiter') {
        return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'Both lanes completed' }), usage: null, costUSD: null, raw: {} };
      }
      if (role === 'moderator') {
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      if (opts.model === 'bifrost/pr-reviewer') {
        bifrostAttempts++;
        // Well-formed, schema-valid, and undecided -- not malformed output.
        if (bifrostAttempts < INCOMPLETE_REVIEW_MAX_ATTEMPTS) {
          return { model: opts.model, content: JSON.stringify({ nonce, decision: 'INCOMPLETE', findings: [] }), usage: null, costUSD: null, raw: {} };
        }
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: null, costUSD: null, raw: {} };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-incomplete-same-alias',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    });

    const secLane = result.personas.find((persona) => persona.id === 'sec-lane');
    expect(secLane?.providerId).toBe('bifrost');
    expect(secLane?.decision).toBe('APPROVE');
    expect(bifrostAttempts).toBe(INCOMPLETE_REVIEW_MAX_ATTEMPTS);
    // Same alias throughout -- no second provider identity was reached for.
    const secLaneCalls = mockClient.complete.mock.calls.filter(([request]: any[]) =>
      request.metadata?.role === 'persona' && request.metadata?.persona === 'sec-lane');
    expect(secLaneCalls.every(([request]: any[]) => request.model === 'bifrost/pr-reviewer')).toBe(true);
  });

  // Widening the retry budget must not loosen `required: true` or the
  // fail-closed contract: a lane that is INCOMPLETE on every attempt still
  // fails closed, it just gets re-entered a bounded number of times first.
  it('fails the required lane closed once the INCOMPLETE budget is exhausted on the same alias', async () => {
    const config = buildSingleAliasDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      const role = opts.metadata?.role || (prompt.includes('Role: ARBITER') ? 'arbiter' : prompt.includes('Role: MODERATOR') ? 'moderator' : 'persona');
      if (opts.model === 'bifrost/pr-reviewer') {
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'INCOMPLETE', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      if (role === 'arbiter') {
        return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'n/a' }), usage: null, costUSD: null, raw: {} };
      }
      if (role === 'moderator') {
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: null, costUSD: null, raw: {} };
    });

    await expect(executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-incomplete-exhausted',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    })).rejects.toThrow(/persona sec-lane failed closed/iu);
  });

  // isEmptyCompletionError's message guard must discriminate the specific
  // "empty completion content" signature from any other OpenRouterResponseError
  // (e.g. a 502 for malformed/unparseable payload content). A non-matching
  // message must stay on the generic 2-attempt transient budget and never
  // borrow the larger empty-completion budget -- pinning that the two retry
  // paths cannot be silently merged by loosening the predicate.
  it('keeps a non-empty-completion OpenRouterResponseError on the generic 2-attempt budget', async () => {
    const config = buildSingleAliasDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const role = opts.metadata?.role || (prompt.includes('Role: ARBITER') ? 'arbiter' : prompt.includes('Role: MODERATOR') ? 'moderator' : 'persona');
      if (opts.model === 'bifrost/pr-reviewer') {
        // Same status (502) as the empty-completion signature, but a
        // non-matching message -- must not engage EMPTY_COMPLETION_MAX_ATTEMPTS.
        throw new OpenRouterResponseError('OpenRouter returned malformed payload', 502);
      }
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      if (role === 'arbiter') {
        return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'n/a' }), usage: null, costUSD: null, raw: {} };
      }
      if (role === 'moderator') {
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: null, costUSD: null, raw: {} };
    });

    await expect(executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-malformed-payload-not-empty-completion',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    })).rejects.toThrow(/persona sec-lane failed closed/iu);

    const bifrostCalls = mockClient.complete.mock.calls.filter(([request]: any[]) =>
      request.metadata?.role === 'persona'
      && request.metadata?.persona === 'sec-lane'
      && request.model === 'bifrost/pr-reviewer');
    // Exactly the generic maxAttempts (2), not EMPTY_COMPLETION_MAX_ATTEMPTS (4) --
    // proves the malformed-payload message never borrows the larger budget.
    expect(bifrostCalls).toHaveLength(2);
  });

  it('retries once then fails over to fallback provider when persona output is unparseable or empty', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      const role = opts.metadata?.role || (prompt.includes('Role: ARBITER') ? 'arbiter' : prompt.includes('Role: MODERATOR') ? 'moderator' : 'persona');
      if (role === 'arbiter') {
        return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'Fallback lane completed' }), usage: null, costUSD: null, raw: {} };
      }
      if (role === 'moderator') {
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      if (opts.model.includes('claude')) {
        // Primary provider returns unparseable empty reasoning content on each attempt
        return { model: opts.model, content: '', usage: null, costUSD: null, raw: {} };
      }
      return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: null, costUSD: null, raw: {} };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-unparseable-failover',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    });

    const secLane = result.personas.find((persona) => persona.id === 'sec-lane');
    expect(secLane?.providerId).toBe('grok');
    const claudeLaneCalls = mockClient.complete.mock.calls.filter(([request]: any[]) =>
      request.metadata?.role === 'persona'
      && request.metadata?.persona === 'sec-lane'
      && request.model.includes('claude'));
    // Each attempt performs the initial prompt plus 1 bounded format correction before failing over.
    expect(claudeLaneCalls).toHaveLength(4);
  });

  it('retries once then fails over to fallback provider when persona output violates contract', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      const role = opts.metadata?.role || (prompt.includes('Role: ARBITER') ? 'arbiter' : prompt.includes('Role: MODERATOR') ? 'moderator' : 'persona');
      if (role === 'arbiter') {
        return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'Fallback lane completed' }), usage: null, costUSD: null, raw: {} };
      }
      if (role === 'moderator') {
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      if (opts.model.includes('claude')) {
        // Primary provider returns parseable JSON with invalid decision contract ('UNKNOWN')
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'UNKNOWN', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: null, costUSD: null, raw: {} };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-invalid-contract-failover',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    });

    const secLane = result.personas.find((persona) => persona.id === 'sec-lane');
    expect(secLane?.providerId).toBe('grok');
    const claudeLaneCalls = mockClient.complete.mock.calls.filter(([request]: any[]) =>
      request.metadata?.role === 'persona'
      && request.metadata?.persona === 'sec-lane'
      && request.model.includes('claude'));
    // Each attempt performs the initial prompt plus 1 bounded format correction before failing over.
    expect(claudeLaneCalls).toHaveLength(4);
  });

  it('clamps persona maxTurns to MAX_INVESTIGATION_TURNS and reports exhausted budget on limit', async () => {
    const baseConfig = buildDeepConfig();
    const config = {
      ...baseConfig,
      quorum: 1,
      // Configure maxTurns to 99, well beyond MAX_INVESTIGATION_TURNS (12)
      personas: [{ ...baseConfig.personas[0], id: 'budget-lane', providers: ['claude'], maxTurns: 99 }],
      reviewers: { ...baseConfig.reviewers, fallback: 'none' as const },
    };

    let turnsCount = 0;
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      const role = opts.metadata?.role || (prompt.includes('Role: ARBITER') ? 'arbiter' : 'persona');
      if (role === 'arbiter') {
        return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'ok' }), usage: null, costUSD: null, raw: {} };
      }
      turnsCount++;
      return {
        model: opts.model,
        content: `\`\`\`json\n{"tool": "read_file", "args": {"path": "src/security/auth.ts"}}\n\`\`\``,
        usage: null,
        costUSD: null,
        raw: {},
      };
    });

    await expect(executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }],
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-clamp-budget-test',
      client: mockClient as unknown as OmniRouteClient,
    })).rejects.toThrow(/turn budget exhausted.*used 15\/15 investigation turns/u);

    expect(turnsCount).toBe(15);
  });

  it('fails closed when persona INCOMPLETE includes unvalidated findings', async () => {
    const baseConfig = buildDeepConfig();
    const config = {
      ...baseConfig,
      quorum: 1,
      personas: [{ ...baseConfig.personas[0], id: 'incomplete-findings-lane', providers: ['claude'], maxTurns: 1 }],
      reviewers: { ...baseConfig.reviewers, fallback: 'none' as const },
    };

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      return {
        model: opts.model,
        content: JSON.stringify({
          nonce,
          decision: 'INCOMPLETE',
          findings: [{ severity: 'P1', path: 'src/security/auth.ts', line: 1, title: 'Ambiguous issue', body: 'details', suggestion: null, startLine: null, replacementCode: null }],
        }),
        usage: null,
        costUSD: null,
        raw: {},
      };
    });

    await expect(executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }],
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-native-incomplete-findings',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    })).rejects.toThrow(/required persona failure.*INCOMPLETE/iu);
  });

  it('fails closed when native JSON returns the wrong request nonce', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
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

  it('accepts one whole-response Markdown JSON fence in native JSON mode', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      const body = prompt.includes('Role: ARBITER')
        ? { verdict: 'SHIP', rationale: 'The fenced response is valid.' }
        : prompt.includes('Role: MODERATOR')
          ? { decision: 'RECONCILED', findings: [] }
          : { decision: 'APPROVE', findings: [] };
      return {
        model: opts.model,
        content: `\`\`\`json\n${JSON.stringify({ nonce, ...body })}\n\`\`\``,
        usage: null,
        costUSD: null,
        raw: {},
      };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-native-json-fence',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_object' } },
    });

    expect(result.personas).toHaveLength(2);
    expect(result.moderator.decision).toBe('RECONCILED');
    expect(result.arbiter.verdict).toBe('SHIP');
    expect(mockClient.complete).toHaveBeenCalledTimes(4);
    expect(mockClient.complete.mock.calls.every(([request]: any[]) => (
      JSON.stringify(request.responseFormat) === JSON.stringify({ type: 'json_object' })
    ))).toBe(true);
  });

  it('rejects native JSON fenced alongside prose', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      return {
        model: opts.model,
        content: `Result follows.\n\`\`\`json\n${JSON.stringify({ nonce, decision: 'APPROVE', findings: [] })}\n\`\`\``,
        usage: null,
        costUSD: null,
        raw: {},
      };
    });

    await expect(executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-native-json-fence-with-prose',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_object' } },
    })).rejects.toThrow('required persona failure');
  });

  it('retries an invalid severity without coercing it and includes the complete schema in correction', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    const calls: any[] = [];
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
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
      const prompt = extractMessageContentText(opts.messages[1].content);
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
      const prompt = extractMessageContentText(opts.messages[1].content);
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
      const prompt = extractMessageContentText(opts.messages[1].content);
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
      const prompt = extractMessageContentText(opts.messages[1].content);
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
      const prompt = extractMessageContentText(opts.messages[1].content);
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

  it('bounds active persona concurrency to MAX_CONCURRENT_PERSONAS (<= 4)', async () => {
    let activeCalls = 0;
    let maxConcurrentObserved = 0;

    const config = ctReviewConfigV3Schema.parse({
      version: 3,
      profile: 'assertive',
      quorum: 1,
      personas: [
        { id: 'p1', enabled: true, required: true, charter: 'builtin:security', paths: ['**'], providers: ['claude'] },
        { id: 'p2', enabled: true, required: true, charter: 'builtin:correctness', paths: ['**'], providers: ['claude'] },
        { id: 'p3', enabled: true, required: true, charter: 'builtin:performance', paths: ['**'], providers: ['claude'] },
        { id: 'p4', enabled: true, required: true, charter: 'builtin:contract', paths: ['**'], providers: ['claude'] },
        { id: 'p5', enabled: true, required: true, charter: 'builtin:consistency', paths: ['**'], providers: ['claude'] },
        { id: 'p6', enabled: true, required: true, charter: 'builtin:database', paths: ['**'], providers: ['claude'] },
      ],
      reviewers: {
        execution: 'personas',
        fallback: 'none',
        overall_timeout_s: 120,
        providers: [
          { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'low', review_timeout_s: 30, arbiter_timeout_s: 30 },
        ],
        arbiter: { order: ['claude'] },
      },
      path_instructions: [],
      rules: [],
    });

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';

      if (prompt.includes('Role: ARBITER')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All good' })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      }
      if (prompt.includes('Role: MODERATOR')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      }

      // Persona lane
      activeCalls++;
      if (activeCalls > maxConcurrentObserved) {
        maxConcurrentObserved = activeCalls;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeCalls--;

      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
        usage: null,
        costUSD: null,
      };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/index.ts', patch: '+ const a = 1;' }],
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-concurrency-test',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(result.personas).toHaveLength(6);
    expect(maxConcurrentObserved).toBeLessThanOrEqual(4);
    expect(maxConcurrentObserved).toBeGreaterThan(1);
  });

  it('handles 6-persona panel with transient 503 errors and retries under concurrency bounds without starving lanes', async () => {
    let activeCalls = 0;
    let maxConcurrentObserved = 0;
    const personaAttempts: Record<string, number> = {};

    const config = ctReviewConfigV3Schema.parse({
      version: 3,
      profile: 'assertive',
      quorum: 1,
      personas: [
        { id: 'p1', enabled: true, required: true, charter: 'builtin:security', paths: ['**'], providers: ['claude'] },
        { id: 'p2', enabled: true, required: true, charter: 'builtin:correctness', paths: ['**'], providers: ['claude'] },
        { id: 'p3', enabled: true, required: true, charter: 'builtin:performance', paths: ['**'], providers: ['claude'] },
        { id: 'p4', enabled: true, required: true, charter: 'builtin:contract', paths: ['**'], providers: ['claude'] },
        { id: 'p5', enabled: true, required: true, charter: 'builtin:consistency', paths: ['**'], providers: ['claude'] },
        { id: 'p6', enabled: true, required: true, charter: 'builtin:database', paths: ['**'], providers: ['claude'] },
      ],
      reviewers: {
        execution: 'personas',
        fallback: 'none',
        overall_timeout_s: 120,
        providers: [
          { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'low', review_timeout_s: 30, arbiter_timeout_s: 30 },
        ],
        arbiter: { order: ['claude'] },
      },
      path_instructions: [],
      rules: [],
    });

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';

      if (prompt.includes('Role: ARBITER')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All good' })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      }
      if (prompt.includes('Role: MODERATOR')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      }

      // Persona lane
      const personaId = opts.persona || 'unknown';
      personaAttempts[personaId] = (personaAttempts[personaId] || 0) + 1;

      activeCalls++;
      if (activeCalls > maxConcurrentObserved) {
        maxConcurrentObserved = activeCalls;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeCalls--;

      // Simulate transient network error on first attempt for p1 and p2
      if ((personaId === 'p1' || personaId === 'p2') && personaAttempts[personaId] === 1) {
        throw new Error('fetch failed: ECONNRESET');
      }

      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
        usage: null,
        costUSD: null,
      };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/index.ts', patch: '+ const a = 1;' }],
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-concurrency-retry-test',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(result.personas).toHaveLength(6);
    expect(personaAttempts['p1']).toBe(2);
    expect(personaAttempts['p2']).toBe(2);
    expect(maxConcurrentObserved).toBeLessThanOrEqual(4);
    expect(result.arbiter.verdict).toBe('SHIP');
  });

  it('aborts a hanging model call at overall_timeout_s and does not accept a late response', async () => {
    vi.useFakeTimers();
    try {
      const baseConfig = buildDeepConfig();
      const config = {
        ...baseConfig,
        quorum: 1,
        personas: [baseConfig.personas[0]],
        reviewers: { ...baseConfig.reviewers, overall_timeout_s: 1 },
      };
      let resolveLate!: (value: any) => void;
      mockClient.complete.mockImplementation(() => new Promise((resolve) => {
        resolveLate = resolve;
      }));

      const panel = executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }],
        repository: 'calltelemetry/repo',
        headSha: 'head-sha-overall-deadline',
        client: mockClient as unknown as OmniRouteClient,
        requestPolicy: { metadata: { qualificationMode: 'deadline-test' } },
      });
      const rejection = expect(panel).rejects.toBeInstanceOf(PanelDeadlineExceededError);

      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(mockClient.complete).toHaveBeenCalledTimes(1);
      expect(mockClient.complete.mock.calls[0][0].signal).toMatchObject({ aborted: true });
      expect(getActivePersonaCallCount()).toBe(0);

      resolveLate({
        model: 'late-model',
        content: 'late response must not become a panel result',
        usage: null,
        costUSD: null,
      });
      await Promise.resolve();
      expect(mockClient.complete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an already-aborted panel before starting any model request', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(executePersonaPanel({
      config: buildDeepConfig(),
      changedFiles: [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }],
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-already-aborted',
      client: mockClient as unknown as OmniRouteClient,
      signal: controller.signal,
    })).rejects.toBeInstanceOf(PanelCancellationError);
    expect(mockClient.complete).not.toHaveBeenCalled();
    expect(getActivePersonaCallCount()).toBe(0);
  });

  it('cleans the overall deadline timer after a healthy panel completes', async () => {
    vi.useFakeTimers();
    try {
      const config = buildDeepConfig();
      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = extractMessageContentText(opts.messages[1].content);
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
        const body = opts.persona === 'arbiter'
          ? { verdict: 'SHIP', rationale: 'Healthy completion.' }
          : opts.persona === 'moderator'
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
        changedFiles: [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }],
        repository: 'calltelemetry/repo',
        headSha: 'head-sha-deadline-cleanup',
        client: mockClient as unknown as OmniRouteClient,
      });

      expect(result.arbiter.verdict).toBe('SHIP');
      expect(getActivePersonaCallCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces MAX_PERSONA_BUDGET_MS (15 turns × 3 min) cumulative cap per persona lane', async () => {
    const config = ctReviewConfigV3Schema.parse({
      version: 3,
      profile: 'assertive',
      quorum: 1,
      personas: [
        { id: 'sec-lane', enabled: true, required: true, charter: 'builtin:security', paths: ['**'], providers: ['claude'] },
      ],
      reviewers: {
        execution: 'personas',
        fallback: 'none',
        overall_timeout_s: 120,
        providers: [
          { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'low', review_timeout_s: 30, arbiter_timeout_s: 30 },
        ],
        arbiter: { order: ['claude'] },
      },
      path_instructions: [],
      rules: [],
    });

    let callCount = 0;
    const realNow = Date.now;
    const baseTime = realNow();
    vi.spyOn(Date, 'now').mockImplementation(() => {
      if (callCount > 0) {
        return baseTime + 2_701_000;
      }
      return baseTime;
    });

    mockClient.complete.mockImplementation(async () => {
      callCount++;
      throw new Error('fetch failed: ECONNRESET');
    });

    try {
      await expect(executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/index.ts', patch: '+ const a = 1;' }],
        repository: 'calltelemetry/repo',
        headSha: 'head-sha-timeout-cap-test',
        client: mockClient as unknown as OmniRouteClient,
      })).rejects.toThrow(/exceeded total retry\/execution budget of 2700s/);
    } finally {
      vi.spyOn(Date, 'now').mockRestore();
    }
  });

  it('surfaces budget_exhausted as the optional lane\'s coded failureClass (REL-892 finding 2)', async () => {
    // Counterfactual for this test: delete the `lastFailureClass = 'budget_exhausted';`
    // assignment at the budget-exhaustion branch inside `runPersona`'s catch block (leaving the
    // `break` in place) and this test fails -- `optionalFailures[0].failureClass` falls through to
    // `classifyFailure(error)`'s generic message-based guess instead of the coded reason the
    // engine itself observed, which is exactly the distinction (budget exhaustion vs. malformed
    // output vs. a generic provider failure) REL-892 exists to make reliable.
    //
    // `budget-lane` must be optional so its terminal failure reaches `optionalFailures` instead of
    // aborting the whole panel as a required-persona failure (which discards `failureClass` -- see
    // the sibling test above). `completed-lane` is required and satisfies quorum=1 on its own so
    // the panel still returns normally instead of throwing on a distinct-provider shortfall.
    const config = ctReviewConfigV3Schema.parse({
      version: 3,
      profile: 'assertive',
      quorum: 1,
      personas: [
        { id: 'completed-lane', enabled: true, required: true, charter: 'builtin:security', paths: ['**'], providers: ['claude'] },
        { id: 'budget-lane', enabled: true, required: false, charter: 'builtin:correctness', paths: ['**'], providers: ['grok'] },
      ],
      reviewers: {
        execution: 'personas',
        fallback: 'none',
        overall_timeout_s: 120,
        providers: [
          { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'low', review_timeout_s: 30, arbiter_timeout_s: 30 },
          { id: 'grok', enabled: true, model: 'deepseek-v4-pro', effort: 'low', review_timeout_s: 30, arbiter_timeout_s: 30 },
        ],
        arbiter: { order: ['claude'] },
      },
      path_instructions: [],
      rules: [],
    });

    // Only `budget-lane`'s own provider call jumps the clock, and only once its own request has
    // actually been dispatched -- `completed-lane`'s lane captures its start time and completes
    // entirely before this flips, so its own success path never observes the jump.
    let budgetLaneDispatched = false;
    const realNow = Date.now;
    const baseTime = realNow();
    vi.spyOn(Date, 'now').mockImplementation(() => (budgetLaneDispatched ? baseTime + 2_701_000 : baseTime));

    mockClient.complete.mockImplementation(async (opts: any) => {
      if (opts.persona === 'budget-lane') {
        budgetLaneDispatched = true;
        throw new Error('fetch failed: ECONNRESET');
      }
      const prompt = extractMessageContentText(opts.messages?.[1]?.content || opts.messages?.[0]?.content);
      const nonce = (typeof prompt === 'string' ? prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/) : null)?.[1].trim() || 'test-nonce';
      const body = opts.persona === 'arbiter'
        ? { verdict: 'SHIP', rationale: 'Completed lane has no findings' }
        : opts.persona === 'moderator'
          ? { decision: 'RECONCILED', findings: [] }
          : { decision: 'APPROVE', findings: [] };
      return { model: opts.model, content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(body)}\nCT_REVIEW_END:${nonce}`, usage: null, costUSD: null, raw: {} };
    });

    try {
      const result = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/index.ts', patch: '+ const a = 1;' }],
        repository: 'calltelemetry/repo',
        headSha: 'head-sha-budget-exhausted-optional',
        client: mockClient as unknown as OmniRouteClient,
      });

      expect(result.personas.map((persona) => persona.id)).toEqual(['completed-lane']);
      expect(result.optionalFailures).toEqual([{
        id: 'budget-lane',
        error: expect.stringContaining('exceeded total retry/execution budget'),
        failureClass: 'budget_exhausted',
      }]);
    } finally {
      vi.spyOn(Date, 'now').mockRestore();
    }
  });

  it('uses the configured idle timeout separately from the remaining panel total timeout', async () => {
    const recordedRequests: Array<{ timeoutMs: number; inactivityTimeoutMs?: number }> = [];
    const baseConfig = buildDeepConfig();
    const configWithoutTimeouts: CtReviewConfigV3 = {
      ...baseConfig,
      reviewers: {
        ...baseConfig.reviewers,
        providers: baseConfig.reviewers.providers.map((p) => {
          const { review_timeout_s, arbiter_timeout_s, ...rest } = p as any;
          return rest;
        }),
      },
    };

    mockClient.complete.mockImplementation(async (opts: any) => {
      recordedRequests.push({ timeoutMs: opts.timeoutMs, inactivityTimeoutMs: opts.inactivityTimeoutMs });
      const prompt = extractMessageContentText(opts.messages?.[1]?.content || opts.messages?.[0]?.content);
      const nonceMatch = typeof prompt === 'string' ? prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/) : null;
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';

      if (opts.persona === 'arbiter') {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Approved' })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 10, completion: 10, total: 20 },
        };
      }
      if (opts.persona === 'moderator') {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 10, completion: 10, total: 20 },
        };
      }
      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
        usage: { prompt: 10, completion: 10, total: 20 },
      };
    });

    const result = await executePersonaPanel({
      config: configWithoutTimeouts,
      changedFiles: [{ path: 'src/security/auth.ts', patch: '+ const safe = true;' }],
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-nan-timeout-test',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(result.arbiter.verdict).toBe('SHIP');
    expect(recordedRequests.length).toBeGreaterThanOrEqual(3);
    for (const request of recordedRequests) {
      expect(Number.isFinite(request.timeoutMs)).toBe(true);
      expect(request.timeoutMs).toBeGreaterThan(0);
      expect(request.timeoutMs).toBeLessThanOrEqual(baseConfig.reviewers.overall_timeout_s * 1_000);
      expect(Number.isNaN(request.timeoutMs)).toBe(false);
      expect(request.inactivityTimeoutMs).toBe(180_000);
    }
  });

  describe('mapConcurrentSettled', () => {
    it('strictly bounds concurrent execution to limit and preserves item ordering', async () => {
      let active = 0;
      let maxActive = 0;
      const items = [1, 2, 3, 4, 5, 6];

      const results = await mapConcurrentSettled(items, 2, async (item) => {
        active++;
        if (active > maxActive) maxActive = active;
        await new Promise((resolve) => setTimeout(resolve, 15));
        active--;
        if (item === 3) throw new Error('item 3 failure');
        return item * 10;
      });

      expect(maxActive).toBeLessThanOrEqual(2);
      expect(results).toHaveLength(6);
      expect(results[0]).toEqual({ status: 'fulfilled', value: 10 });
      expect(results[1]).toEqual({ status: 'fulfilled', value: 20 });
      expect(results[2]).toEqual({ status: 'rejected', reason: expect.any(Error) });
      expect(results[3]).toEqual({ status: 'fulfilled', value: 40 });
      expect(results[4]).toEqual({ status: 'fulfilled', value: 50 });
      expect(results[5]).toEqual({ status: 'fulfilled', value: 60 });
    });

    it('handles empty items array and non-positive limit safely', async () => {
      const emptyResults = await mapConcurrentSettled([], 4, async (x) => x);
      expect(emptyResults).toEqual([]);

      const singleResult = await mapConcurrentSettled(['a'], 0, async (x) => x.toUpperCase());
      expect(singleResult).toEqual([{ status: 'fulfilled', value: 'A' }]);
    });
  });

  it('aborts queued personas immediately without invoking LLM model when head becomes stale while queued', async () => {
    let headIsCurrent = true;
    const invokedPersonas: string[] = [];

    const config = ctReviewConfigV3Schema.parse({
      version: 3,
      profile: 'assertive',
      quorum: 1,
      personas: [
        { id: 'p1', enabled: true, required: true, charter: 'builtin:security', paths: ['**'], providers: ['claude'] },
        { id: 'p2', enabled: true, required: false, charter: 'builtin:correctness', paths: ['**'], providers: ['claude'] },
        { id: 'p3', enabled: true, required: false, charter: 'builtin:performance', paths: ['**'], providers: ['claude'] },
        { id: 'p4', enabled: true, required: false, charter: 'builtin:contract', paths: ['**'], providers: ['claude'] },
        { id: 'p5', enabled: true, required: false, charter: 'builtin:consistency', paths: ['**'], providers: ['claude'] },
        { id: 'p6', enabled: true, required: false, charter: 'builtin:database', paths: ['**'], providers: ['claude'] },
      ],
      reviewers: {
        execution: 'personas',
        fallback: 'none',
        overall_timeout_s: 120,
        providers: [
          { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'low', review_timeout_s: 30, arbiter_timeout_s: 30 },
        ],
        arbiter: { order: ['claude'] },
      },
      path_instructions: [],
      rules: [],
    });

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';

      if (opts.persona === 'classifier') {
        return {
          model: opts.model,
          content: JSON.stringify({
            fastShip: false,
            selectedPersonas: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
            effortTier: 'low',
            rationale: 'Full panel required',
          }),
          usage: null,
          costUSD: null,
        };
      }

      if (prompt.includes('Role: ARBITER') || opts.persona === 'arbiter') {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All good' })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      }
      if (prompt.includes('Role: MODERATOR') || opts.persona === 'moderator') {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      }

      // Record which persona was actually invoked
      invokedPersonas.push(opts.persona);

      // Personas 1-4 take 30ms, during which head becomes stale
      await new Promise((resolve) => setTimeout(resolve, 30));
      headIsCurrent = false;

      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
        usage: null,
        costUSD: null,
      };
    });

    const panelPromise = executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/index.ts', patch: '+ const a = 1;' }],
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-queue-stale-test',
      client: mockClient as unknown as OmniRouteClient,
      isCurrentHead: () => headIsCurrent,
    });

    const result = await panelPromise;
    // The first 4 personas (p1..p4) ran concurrently and completed
    // While p5 and p6 were queued, headIsCurrent became false
    // When p5 and p6 acquired the semaphore slot, the post-acquire check detected stale head and aborted
    // Therefore, p5 and p6 were NEVER invoked against the model client
    expect(invokedPersonas).not.toContain('p5');
    expect(invokedPersonas).not.toContain('p6');
    expect(result.optionalFailures.some((f) => f.error?.includes('stale run aborted'))).toBe(true);
  });
  // REL-940: a transport failure (gateway unreachable — `fetch failed`) is not
  // an answer about the diff. It previously got ONE retry after a flat 1s
  // pause, so a required lane failed closed ~6s after the first failure and
  // took the whole panel with it, discarding lanes that had already completed.
  // Real blips last minutes: an immediate manual retry reproduced the failure
  // while a retry minutes later returned a clean verdict. This proves the lane
  // now survives across its own larger, backed-off budget.
  it('retries a transport failure past the generic 2-attempt cap instead of failing closed', async () => {
    const config = buildSingleAliasDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    // Two transport failures then success: attempt 3 is already strictly beyond
    // the generic `maxAttempts` of 2 that used to retire the lane. The full
    // TRANSPORT_MAX_RETRIES budget and the backoff schedule are covered by the
    // pure-function test below, so this one only has to wait out two real
    // backoffs (~1s + ~4s) rather than the whole schedule.
    const failuresBeforeSuccess = 2;
    let bifrostAttempts = 0;
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      const role = opts.metadata?.role || (prompt.includes('Role: ARBITER') ? 'arbiter' : prompt.includes('Role: MODERATOR') ? 'moderator' : 'persona');
      if (role === 'arbiter') {
        return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'Lane recovered' }), usage: null, costUSD: null, raw: {} };
      }
      if (role === 'moderator') {
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      if (opts.model === 'bifrost/pr-reviewer') {
        bifrostAttempts++;
        // The exact deployed signature: the gateway could not be reached.
        if (bifrostAttempts <= failuresBeforeSuccess) {
          throw new Error('fetch failed');
        }
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: null, costUSD: null, raw: {} };
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-transport-backoff',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    });

    const secLane = result.personas.find((persona) => persona.id === 'sec-lane');
    // The lane completed rather than failing closed and taking the panel with it.
    expect(secLane?.decision).toBe('APPROVE');
    expect(bifrostAttempts).toBe(failuresBeforeSuccess + 1);
    // The whole point: strictly more than the generic maxAttempts of 2.
    expect(bifrostAttempts).toBeGreaterThan(2);
  }, 120_000);

  it('bounds the transport backoff: exponential, jittered, and capped', () => {
    // Deterministic bounds rather than exact values, because the jitter is the
    // point: concurrent lanes must not retry a recovering gateway in lockstep.
    for (const [attempt, base] of [[1, 1_000], [2, 4_000], [3, 16_000]] as const) {
      const low = transportRetryDelayMs(attempt, () => 0);
      const high = transportRetryDelayMs(attempt, () => 0.999);
      expect(low).toBe(Math.round(base * 0.8));
      expect(high).toBeLessThanOrEqual(Math.round(base * 1.2));
      expect(high).toBeGreaterThan(low);
    }
    // Capped: a high attempt number never exceeds the ceiling plus jitter.
    expect(transportRetryDelayMs(9, () => 0.999)).toBeLessThanOrEqual(Math.round(TRANSPORT_RETRY_MAX_DELAY_MS * 1.2));
    // The FIRST retry stays as fast as the generic branch it replaces, so a
    // momentary blip does not cost every lane the worst-case latency.
    expect(transportRetryDelayMs(1, () => 0.5)).toBe(1_000);
    // Worst-case total stays far inside the 30-minute terminal deadline.
    const worstCaseTotalMs = [1, 2, 3].reduce((sum, n) => sum + transportRetryDelayMs(n, () => 0.999), 0);
    expect(worstCaseTotalMs).toBeLessThan(40_000);
  });

  // Review feedback (P2): the budget-exhaustion boundary was untested. After
  // TRANSPORT_MAX_RETRIES the lane must fail closed -- the retry must not be
  // able to loop a required lane indefinitely against a dead gateway.
  it('fails closed once the transport budget is exhausted, never approving', async () => {
    const config = buildSingleAliasDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    let bifrostAttempts = 0;
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      const role = opts.metadata?.role || (prompt.includes('Role: ARBITER') ? 'arbiter' : prompt.includes('Role: MODERATOR') ? 'moderator' : 'persona');
      if (role === 'arbiter') {
        return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'should never be reached' }), usage: null, costUSD: null, raw: {} };
      }
      if (role === 'moderator') {
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null, raw: {} };
      }
      if (opts.model === 'bifrost/pr-reviewer') {
        bifrostAttempts++;
        // The gateway never comes back.
        throw new Error('fetch failed');
      }
      return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: null, costUSD: null, raw: {} };
    });

    // sec-lane is required, so an exhausted budget must fail the panel closed
    // rather than yield a verdict built without it.
    await expect(executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-transport-exhausted',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    })).rejects.toBeInstanceOf(PanelConfigurationError);

    // Bounded: the retry stops at the cap instead of looping forever.
    expect(bifrostAttempts).toBe(TRANSPORT_MAX_RETRIES + 1);
  }, 120_000);

  // Review feedback (P2): the budget-fit guard was untested. When the proposed
  // backoff does not fit in what is left of the panel budget, the transport
  // branch must fall through immediately rather than sleep past the deadline
  // and convert a precise transport failure into a generic timeout.
  it('skips the transport backoff when it does not fit the remaining panel budget', async () => {
    const base = buildSingleAliasDeepConfig();
    // A panel deadline far shorter than even the first 1s backoff.
    const config = ctReviewConfigV3Schema.parse({
      ...base,
      reviewers: { ...base.reviewers, overall_timeout_s: 1 },
    }) as unknown as CtReviewConfigV3;
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];
    let bifrostAttempts = 0;
    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1]?.content || '');
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
      const role = opts.metadata?.role || (prompt.includes('Role: ARBITER') ? 'arbiter' : prompt.includes('Role: MODERATOR') ? 'moderator' : 'persona');
      if (role === 'arbiter' || role === 'moderator') {
        return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', decision: 'RECONCILED', findings: [], rationale: 'x' }), usage: null, costUSD: null, raw: {} };
      }
      if (opts.model === 'bifrost/pr-reviewer') {
        bifrostAttempts++;
        throw new Error('fetch failed');
      }
      return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: null, costUSD: null, raw: {} };
    });

    await expect(executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-transport-no-budget',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    })).rejects.toBeInstanceOf(Error);

    // The transport budget was NOT spent: with no room to back off, the lane
    // must give up at or below the generic cap rather than burn all 4 attempts.
    expect(bifrostAttempts).toBeLessThan(TRANSPORT_MAX_RETRIES + 1);
  }, 60_000);
});
