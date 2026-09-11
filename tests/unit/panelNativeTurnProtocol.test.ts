import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executePersonaPanel,
  extractMessageContentText,
  getActivePersonaCallCount,
  MAX_INVESTIGATION_TURNS,
  PanelCancellationError,
} from '../../src/panel/panelEngine';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema, type CtReviewConfigV3 } from '../../src/config/schema';
import type { OmniRouteClient } from '../../src/gateway/omniRouteClient';

const PERSONA_ID = 'native-protocol-auditor';
const CHANGED_FILES = [{ path: 'src/app.ts', patch: '+ const answer = await inspect();' }];

function buildConfig(): CtReviewConfigV3 {
  return ctReviewConfigV3Schema.parse({
    ...createDefaultV3Config(),
    quorum: 1,
    personas: [{
      id: PERSONA_ID,
      enabled: true,
      required: true,
      charter: 'builtin:security',
      paths: ['src/**'],
      providers: ['synthetic'],
    }],
    reviewers: {
      execution: 'personas',
      fallback: 'none',
      overall_timeout_s: 30,
      providers: [{
        id: 'synthetic',
        enabled: true,
        model: 'native-protocol-test-model',
        effort: 'medium',
        review_timeout_s: 30,
        arbiter_timeout_s: 30,
      }],
      arbiter: { order: ['synthetic'] },
    },
  });
}

function requestText(request: any): string {
  return (request.messages || [])
    .map((message: any) => extractMessageContentText(message.content))
    .join('\n');
}

function requestNonce(request: any): string {
  const match = requestText(request).match(/CT_REVIEW_NONCE:([^\n]+)/u);
  if (!match) throw new Error('test provider could not find the request nonce');
  return match[1].trim();
}

function response(request: any, body: Record<string, unknown>, nonce = requestNonce(request)): any {
  return {
    model: request.model,
    content: JSON.stringify({ nonce, ...body }),
    usage: { prompt: 5, completion: 5, total: 10 },
    costUSD: 0,
    raw: {},
  };
}

function personaCalls(mockClient: any): any[] {
  return mockClient.complete.mock.calls
    .map(([request]: [any]) => request)
    .filter((request: any) => request.metadata?.role === 'persona');
}

function nonPersonaResponse(request: any): any {
  if (request.metadata?.role === 'moderator') {
    return response(request, { decision: 'RECONCILED', findings: [] });
  }
  return response(request, { verdict: 'SHIP', rationale: 'Native protocol test completed.' });
}

describe('native panel turn protocol', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = { complete: vi.fn() };
  });

  it('round-trips nested native tool args and removes legacy fence instructions after the tool result', async () => {
    const nestedArgs = {
      path: 'src/app.ts',
      range: { startLine: 1, endLine: 4 },
      options: { includeContext: true },
    };
    let personaTurn = 0;
    mockClient.complete.mockImplementation(async (request: any) => {
      if (request.metadata?.role !== 'persona') return nonPersonaResponse(request);

      personaTurn += 1;
      if (personaTurn === 1) {
        return {
          model: request.model,
          content: JSON.stringify({ tool: 'read_file', args: nestedArgs }),
          usage: { prompt: 5, completion: 5, total: 10 },
          costUSD: 0,
          raw: {},
        };
      }
      return response(request, { decision: 'APPROVE', findings: [] });
    });

    const result = await executePersonaPanel({
      config: buildConfig(),
      changedFiles: CHANGED_FILES,
      repository: 'calltelemetry/review-yeti-bot',
      headSha: 'native-tool-roundtrip',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_object' } },
    });

    expect(result.personas[0].decision).toBe('APPROVE');
    expect(result.personas[0].toolCalls).toEqual([
      expect.objectContaining({ tool: 'read_file', args: nestedArgs }),
    ]);

    const requests = personaCalls(mockClient);
    expect(requests).toHaveLength(2);
    expect(requests[0].responseFormat).toMatchObject({ type: 'json_object' });
    // Exploration remains in generic JSON-object mode until the reserved final turn.
    expect(requests[1].responseFormat).toMatchObject({ type: 'json_object' });
    const postToolMessage = requests[1].messages.at(-1);
    expect(postToolMessage?.content).toContain('[PI_TOOL_RESULT]');
    expect(String(postToolMessage?.content)).not.toMatch(/CT_REVIEW_BEGIN:|CT_REVIEW_END:/u);
  });

  it('reserves the fifth and final provider call for a native answer without making a sixth call', async () => {
    let personaTurn = 0;
    mockClient.complete.mockImplementation(async (request: any) => {
      if (request.metadata?.role !== 'persona') return nonPersonaResponse(request);

      personaTurn += 1;
      if (personaTurn < MAX_INVESTIGATION_TURNS) {
        return {
          model: request.model,
          content: JSON.stringify({
            tool: 'read_file',
            args: { path: 'src/app.ts', context: { explorationTurn: personaTurn } },
          }),
          usage: { prompt: 5, completion: 5, total: 10 },
          costUSD: 0,
          raw: {},
        };
      }
      return response(request, { decision: 'APPROVE', findings: [] });
    });

    const result = await executePersonaPanel({
      config: buildConfig(),
      changedFiles: CHANGED_FILES,
      repository: 'calltelemetry/review-yeti-bot',
      headSha: 'native-final-reservation',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    });

    expect(result.personas[0].decision).toBe('APPROVE');
    expect(personaTurn).toBe(MAX_INVESTIGATION_TURNS);
    expect(personaCalls(mockClient)).toHaveLength(MAX_INVESTIGATION_TURNS);
    expect(personaCalls(mockClient).map((request) => request.responseFormat?.type)).toEqual([
      'json_object',
      'json_object',
      'json_object',
      'json_object',
      'json_schema',
    ]);
  });

  it('uses application validation in json_object mode when the reserved final turn requests another tool', async () => {
    let personaTurn = 0;
    mockClient.complete.mockImplementation(async (request: any) => {
      if (request.metadata?.role !== 'persona') return nonPersonaResponse(request);

      personaTurn += 1;
      return {
        model: request.model,
        content: JSON.stringify({
          tool: 'read_file',
          args: { path: 'src/app.ts', context: { explorationTurn: personaTurn } },
        }),
        usage: { prompt: 5, completion: 5, total: 10 },
        costUSD: 0,
        raw: {},
      };
    });

    await expect(executePersonaPanel({
      config: buildConfig(),
      changedFiles: CHANGED_FILES,
      repository: 'calltelemetry/review-yeti-bot',
      headSha: 'native-final-tool-request',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_object' } },
    })).rejects.toThrow(/incomplete/iu);

    expect(personaTurn).toBe(MAX_INVESTIGATION_TURNS);
    expect(personaCalls(mockClient)).toHaveLength(MAX_INVESTIGATION_TURNS);
    expect(personaCalls(mockClient).at(-1).responseFormat).toMatchObject({ type: 'json_object' });
    expect(personaCalls(mockClient).map((request) => request.responseFormat?.type)).not.toContain('json_schema');
    expect(mockClient.complete.mock.calls.some(([request]: [any]) => request.metadata?.role === 'arbiter')).toBe(false);
  });

  it('rejects a hybrid native object instead of treating a nonce-bound result with tool fields as SHIP', async () => {
    const readFile = vi.fn(async () => 'should never be read');
    mockClient.complete.mockImplementation(async (request: any) => {
      if (request.metadata?.role !== 'persona') return nonPersonaResponse(request);

      return response(request, {
        decision: 'APPROVE',
        findings: [],
        tool: 'read_file',
        args: { path: 'src/unchanged.ts', nested: { line: 1 } },
      });
    });

    await expect(executePersonaPanel({
      config: buildConfig(),
      changedFiles: CHANGED_FILES,
      repository: 'calltelemetry/review-yeti-bot',
      headSha: 'native-hybrid-envelope',
      client: mockClient as unknown as OmniRouteClient,
      repoFileProvider: {
        findFiles: vi.fn(async () => []),
        readFile,
      },
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    })).rejects.toThrow();

    expect(readFile).not.toHaveBeenCalled();
    expect(mockClient.complete.mock.calls.some(([request]: [any]) => request.metadata?.role === 'arbiter')).toBe(false);
    const requests = personaCalls(mockClient);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.at(-1).responseFormat).toMatchObject({ type: 'json_schema' });
    expect(requests.at(-1).messages.at(-1)?.content).toContain('STRUCTURED_OUTPUT_CORRECTION');
    expect(String(requests.at(-1).messages.at(-1)?.content)).not.toContain('"tool"');
  });

  it.each([
    ['wrong native nonce', 'wrong-native-nonce'],
    ['malformed native final', 'malformed-json'],
  ])('%s never produces a SHIP result', async (_name, failure) => {
    mockClient.complete.mockImplementation(async (request: any) => {
      if (request.metadata?.role !== 'persona') return nonPersonaResponse(request);
      if (failure === 'malformed-json') {
        return {
          model: request.model,
          content: '{"nonce":"unterminated"',
          usage: { prompt: 5, completion: 5, total: 10 },
          costUSD: 0,
          raw: {},
        };
      }
      return response(request, { decision: 'APPROVE', findings: [] }, 'wrong-native-nonce');
    });

    await expect(executePersonaPanel({
      config: buildConfig(),
      changedFiles: CHANGED_FILES,
      repository: 'calltelemetry/review-yeti-bot',
      headSha: `native-invalid-final-${failure}`,
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_object' } },
    })).rejects.toThrow();

    expect(mockClient.complete.mock.calls.some(([request]: [any]) => request.metadata?.role === 'arbiter')).toBe(false);
  });

  it('propagates caller abort and releases the active persona slot after a pending native request', async () => {
    const controller = new AbortController();
    const baselineActiveCalls = getActivePersonaCallCount();
    let requestSignal: AbortSignal | undefined;
    let resolvePending!: (value: any) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });

    mockClient.complete.mockImplementation(async (request: any) => {
      requestSignal = request.signal;
      markStarted();
      return new Promise((resolve) => { resolvePending = resolve; });
    });

    const panel = executePersonaPanel({
      config: buildConfig(),
      changedFiles: CHANGED_FILES,
      repository: 'calltelemetry/review-yeti-bot',
      headSha: 'native-caller-abort',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_object' } },
      signal: controller.signal,
    });

    await started;
    controller.abort();
    await expect(panel).rejects.toBeInstanceOf(PanelCancellationError);
    expect(requestSignal?.aborted).toBe(true);

    resolvePending({
      model: 'late-native-model',
      content: JSON.stringify({ nonce: 'late', decision: 'APPROVE', findings: [] }),
      usage: null,
      costUSD: null,
      raw: {},
    });
    await Promise.resolve();
    expect(getActivePersonaCallCount()).toBe(baselineActiveCalls);
  });
});
