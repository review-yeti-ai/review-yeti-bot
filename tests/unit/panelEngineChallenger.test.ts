import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { CtReviewConfigV3, personaSchema } from '../../src/config/schema';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';
import { DashboardStore } from '../../src/persistence/dashboardStore';

function createMockConfig(overrides?: Partial<CtReviewConfigV3['personas'][number]>): CtReviewConfigV3 {
  return {
    ...createDefaultV3Config(),
    version: 3,
    profile: 'balanced',
    quorum: 1,
    personas: [
      {
        id: 'sec-auditor',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['src/**'],
        providers: ['claude'],
        model: 'claude-5-sonnet',
        ...overrides,
      },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 60,
      providers: [
        { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'medium', review_timeout_s: 30, arbiter_timeout_s: 30 },
      ],
      arbiter: { order: ['claude'] },
    },
    path_instructions: [],
    rules: [],
    reviews: {
      ...createDefaultV3Config().reviews,
      reviewer_effort: 'medium',
      confidence_threshold: 70,
      mascot: true,
    },
    mascot: true,
  };
}

describe('Engine Multi-Turn & Reasoning Effort Empirical Challenger Suite', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      complete: vi.fn(),
    };
  });

  describe('1. Multi-turn Tool Calling Iteration Bounds (maxTurns = 1, 5, 15, 20)', () => {
    it('executes exactly 1 turn when maxTurns = 1 and model outputs tool call without fence', async () => {
      const config = createMockConfig({ maxTurns: 1 });
      const changedFiles = [{ path: 'src/app.ts', patch: '+ console.log("test");' }];

      mockClient.complete.mockImplementation(async (opts: any) => {
        return {
          model: opts.model,
          content: '```json\n{"tool": "read_file", "args": {"path": "src/app.ts"}}\n```',
          usage: { prompt: 10, completion: 10, total: 20 },
        };
      });

      // Since maxTurns = 1 and turn 1 did not produce a fenced output, it stops after 1 turn and throws PanelConfigurationError
      await expect(
        executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/cisco-cdr',
          headSha: 'abc1234',
          client: mockClient as unknown as OmniRouteClient,
        })
      ).rejects.toThrow();

      const personaCalls = mockClient.complete.mock.calls.filter(([opts]: [any]) =>
        opts.messages?.some((m: any) => m.content?.includes("persona 'sec-auditor'"))
      );
      expect(personaCalls).toHaveLength(1);
    });

    it('returns verdict on turn 1 when maxTurns = 1 and model outputs fenced response', async () => {
      const config = createMockConfig({ maxTurns: 1 });
      const changedFiles = [{ path: 'src/app.ts', patch: '+ console.log("test");' }];

      mockClient.complete.mockImplementation(async (opts: any) => {
        const allMsg = JSON.stringify(opts.messages);
        const prompt = opts.messages[1]?.content as string || '';
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/) || allMsg.match(/CT_REVIEW_NONCE:(.*?)"/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : 'nonce';

        if (allMsg.includes('arbiter')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Approved' })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 10, completion: 10, total: 20 },
          };
        } else if (allMsg.includes('moderator')) {
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
        config,
        changedFiles,
        repository: 'calltelemetry/cisco-cdr',
        headSha: 'abc1234',
        client: mockClient as unknown as OmniRouteClient,
      });

      expect(result.personas).toHaveLength(1);
      expect(result.personas[0].decision).toBe('APPROVE');

      const personaCalls = mockClient.complete.mock.calls.filter(([opts]: [any]) =>
        opts.messages?.some((m: any) => m.content?.includes("persona 'sec-auditor'"))
      );
      expect(personaCalls).toHaveLength(1);
    });

    it('loops up to maxTurns = 5 when model makes 4 tool calls and returns fenced output on 5th turn', async () => {
      const config = createMockConfig({ maxTurns: 5 });
      const changedFiles = [{ path: 'src/app.ts', patch: '+ console.log("test");' }];
      let turnCounter = 0;

      mockClient.complete.mockImplementation(async (opts: any) => {
        const isPersonaCall = opts.messages?.some((m: any) => m.content?.includes("persona 'sec-auditor'"));
        const allMsg = JSON.stringify(opts.messages);
        const prompt = opts.messages[1]?.content as string || '';
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/) || allMsg.match(/CT_REVIEW_NONCE:(.*?)"/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : 'nonce';

        if (allMsg.includes('arbiter')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Approved' })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 10, completion: 10, total: 20 },
          };
        } else if (allMsg.includes('moderator')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 10, completion: 10, total: 20 },
          };
        }

        if (!isPersonaCall) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 10, completion: 10, total: 20 },
          };
        }

        turnCounter++;
        if (turnCounter < 5) {
          return {
            model: opts.model,
            content: `Turn ${turnCounter}: Need to inspect code\n\`\`\`json\n{"tool": "read_file", "args": {"path": "src/app.ts"}}\n\`\`\``,
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
        config,
        changedFiles,
        repository: 'calltelemetry/cisco-cdr',
        headSha: 'abc1234',
        client: mockClient as unknown as OmniRouteClient,
      });

      expect(turnCounter).toBe(5);
      expect(result.personas[0].decision).toBe('APPROVE');
    });

    it('loops up to maxTurns = 15 when model makes 14 tool calls and finishes on 15th turn', async () => {
      const config = createMockConfig({ maxTurns: 15 });
      const changedFiles = [{ path: 'src/app.ts', patch: '+ console.log("test");' }];
      let turnCounter = 0;

      mockClient.complete.mockImplementation(async (opts: any) => {
        const isPersonaCall = opts.messages?.some((m: any) => m.content?.includes("persona 'sec-auditor'"));
        const allMsg = JSON.stringify(opts.messages);
        const prompt = opts.messages[1]?.content as string || '';
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/) || allMsg.match(/CT_REVIEW_NONCE:(.*?)"/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : 'nonce';

        if (allMsg.includes('arbiter')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Approved' })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 10, completion: 10, total: 20 },
          };
        } else if (allMsg.includes('moderator')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 10, completion: 10, total: 20 },
          };
        }

        if (!isPersonaCall) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 10, completion: 10, total: 20 },
          };
        }

        turnCounter++;
        if (turnCounter < 15) {
          return {
            model: opts.model,
            content: `Turn ${turnCounter}: Need to search symbol\n\`\`\`json\n{"tool": "search_code", "args": {"query": "test"}}\n\`\`\``,
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
        config,
        changedFiles,
        repository: 'calltelemetry/cisco-cdr',
        headSha: 'abc1234',
        client: mockClient as unknown as OmniRouteClient,
      });

      expect(turnCounter).toBe(15);
      expect(result.personas[0].decision).toBe('APPROVE');
    });

    it('loops up to maxTurns = 20 when model makes 19 tool calls and finishes on 20th turn', async () => {
      const config = createMockConfig({ maxTurns: 20 });
      const changedFiles = [{ path: 'src/app.ts', patch: '+ console.log("test");' }];
      let turnCounter = 0;

      mockClient.complete.mockImplementation(async (opts: any) => {
        const isPersonaCall = opts.messages?.some((m: any) => m.content?.includes("persona 'sec-auditor'"));
        const allMsg = JSON.stringify(opts.messages);
        const prompt = opts.messages[1]?.content as string || '';
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/) || allMsg.match(/CT_REVIEW_NONCE:(.*?)"/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : 'nonce';

        if (allMsg.includes('arbiter')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Approved' })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 10, completion: 10, total: 20 },
          };
        } else if (allMsg.includes('moderator')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 10, completion: 10, total: 20 },
          };
        }

        if (!isPersonaCall) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 10, completion: 10, total: 20 },
          };
        }

        turnCounter++;
        if (turnCounter < 20) {
          return {
            model: opts.model,
            content: `Turn ${turnCounter}: Need tool execution\n\`\`\`json\n{"tool": "read_file", "args": {"path": "src/app.ts"}}\n\`\`\``,
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
        config,
        changedFiles,
        repository: 'calltelemetry/cisco-cdr',
        headSha: 'abc1234',
        client: mockClient as unknown as OmniRouteClient,
      });

      expect(turnCounter).toBe(20);
      expect(result.personas[0].decision).toBe('APPROVE');
    });

    it('enforces turn limit cutoff when model attempts to loop continuously beyond maxTurns', async () => {
      const config = createMockConfig({ maxTurns: 5 });
      const changedFiles = [{ path: 'src/app.ts', patch: '+ console.log("test");' }];
      let turnCounter = 0;

      mockClient.complete.mockImplementation(async (opts: any) => {
        turnCounter++;
        return {
          model: opts.model,
          content: `Turn ${turnCounter}: Always call tool\n\`\`\`json\n{"tool": "read_file", "args": {"path": "src/app.ts"}}\n\`\`\``,
          usage: { prompt: 10, completion: 10, total: 20 },
        };
      });

      await expect(
        executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/cisco-cdr',
          headSha: 'abc1234',
          client: mockClient as unknown as OmniRouteClient,
        })
      ).rejects.toThrow();

      // Persona execution stopped after 5 turns
      expect(turnCounter).toBe(5);
    });
  });

  describe('2. Validation & Clamping of maxTurns (0, -1, 25, 3.14, "invalid")', () => {
    it('validates personaSchema rejects invalid maxTurns values (0, -1, 25, 3.14, "invalid")', () => {
      const basePersona = {
        id: 'sec-auditor',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['src/**'],
        providers: ['claude'],
      };

      expect(personaSchema.safeParse({ ...basePersona, maxTurns: 0 }).success).toBe(false);
      expect(personaSchema.safeParse({ ...basePersona, maxTurns: -1 }).success).toBe(false);
      expect(personaSchema.safeParse({ ...basePersona, maxTurns: 25 }).success).toBe(false);
      expect(personaSchema.safeParse({ ...basePersona, maxTurns: 3.14 }).success).toBe(false);
      expect(personaSchema.safeParse({ ...basePersona, maxTurns: 'invalid' }).success).toBe(false);

      // Valid bounds pass
      expect(personaSchema.safeParse({ ...basePersona, maxTurns: 1 }).success).toBe(true);
      expect(personaSchema.safeParse({ ...basePersona, maxTurns: 20 }).success).toBe(true);
    });

    it('validates DashboardStore rejects invalid maxTurns values (0, -1, 25, 3.14, "invalid")', () => {
      const store = new DashboardStore();

      // Valid setting update succeeds
      expect(() => store.updatePersonaSetting('security', { maxTurns: 10 })).not.toThrow();

      // Invalid settings throw Error
      expect(() => store.updatePersonaSetting('security', { maxTurns: 0 })).toThrow(/maxTurns for 'security' must be an integer between 1 and 20/);
      expect(() => store.updatePersonaSetting('security', { maxTurns: -1 })).toThrow(/maxTurns for 'security' must be an integer between 1 and 20/);
      expect(() => store.updatePersonaSetting('security', { maxTurns: 25 })).toThrow(/maxTurns for 'security' must be an integer between 1 and 20/);
      expect(() => store.updatePersonaSetting('security', { maxTurns: 3.14 })).toThrow(/maxTurns for 'security' must be an integer between 1 and 20/);
      expect(() => store.updatePersonaSetting('security', { maxTurns: 'invalid' as any })).toThrow(/maxTurns for 'security' must be an integer between 1 and 20/);
    });

    it('clamps out-of-bound maxTurns in panel engine execution (0 -> 1, -1 -> 1, 25 -> 20, 100 -> 20)', async () => {
      const changedFiles = [{ path: 'src/app.ts', patch: '+ console.log("test");' }];

      // Test maxTurns = 0 clamped to 1
      {
        let turns = 0;
        mockClient.complete.mockImplementation(async (opts: any) => {
          turns++;
          return {
            model: opts.model,
            content: `\`\`\`json\n{"tool": "read_file", "args": {"path": "src/app.ts"}}\n\`\`\``,
          };
        });

        const config = createMockConfig({ maxTurns: 0 });
        await expect(executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/cisco-cdr',
          headSha: 'abc1234',
          client: mockClient as unknown as OmniRouteClient,
        })).rejects.toThrow();

        expect(turns).toBe(1); // Clamped 0 -> 1
      }

      // Test maxTurns = -1 clamped to 1
      {
        let turns = 0;
        mockClient.complete.mockImplementation(async (opts: any) => {
          turns++;
          return {
            model: opts.model,
            content: `\`\`\`json\n{"tool": "read_file", "args": {"path": "src/app.ts"}}\n\`\`\``,
          };
        });

        const config = createMockConfig({ maxTurns: -1 });
        await expect(executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/cisco-cdr',
          headSha: 'abc1234',
          client: mockClient as unknown as OmniRouteClient,
        })).rejects.toThrow();

        expect(turns).toBe(1); // Clamped -1 -> 1
      }

      // Test maxTurns = 25 clamped to 20
      {
        let turns = 0;
        mockClient.complete.mockImplementation(async (opts: any) => {
          turns++;
          return {
            model: opts.model,
            content: `\`\`\`json\n{"tool": "read_file", "args": {"path": "src/app.ts"}}\n\`\`\``,
          };
        });

        const config = createMockConfig({ maxTurns: 25 });
        await expect(executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/cisco-cdr',
          headSha: 'abc1234',
          client: mockClient as unknown as OmniRouteClient,
        })).rejects.toThrow();

        expect(turns).toBe(20); // Clamped 25 -> 20
      }
    });
  });

  describe('3. Reasoning Effort Forwarding (low, medium, high, xhigh, max)', () => {
    const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

    effortLevels.forEach((effort) => {
      it(`forwards reasoningEffort: '${effort}' from persona config to client.complete`, async () => {
        const config = createMockConfig({ effort });
        const changedFiles = [{ path: 'src/app.ts', patch: '+ console.log("test");' }];

        mockClient.complete.mockImplementation(async (opts: any) => {
          const allMsg = JSON.stringify(opts.messages);
          const prompt = opts.messages[1]?.content as string || '';
          const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/) || allMsg.match(/CT_REVIEW_NONCE:(.*?)"/);
          const nonce = nonceMatch ? nonceMatch[1].trim() : 'nonce';

          if (allMsg.includes('arbiter')) {
            return {
              model: opts.model,
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Approved' })}\nCT_REVIEW_END:${nonce}`,
              usage: { prompt: 10, completion: 10, total: 20 },
            };
          } else if (allMsg.includes('moderator')) {
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

        await executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/cisco-cdr',
          headSha: 'abc1234',
          client: mockClient as unknown as OmniRouteClient,
        });

        // First call is persona execution
        const personaCallOpts = mockClient.complete.mock.calls[0][0];
        expect(personaCallOpts.reasoningEffort).toBe(effort);
      });
    });

    it('verifies OmniRouteClient.complete serializes reasoningEffort as reasoning_effort in POST body', async () => {
      const globalFetchMock = vi.fn().mockImplementation(async () => {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      });

      const originalFetch = global.fetch;
      global.fetch = globalFetchMock as any;

      try {
        const omniClient = new OmniRouteClient({ baseUrl: 'http://localhost:8000', accessToken: 'test-token' });
        await omniClient.complete({
          model: 'glm-5.2',
          messages: [{ role: 'user', content: 'test prompt' }],
          timeoutMs: 30000,
          reasoningEffort: 'xhigh',
        });

        expect(globalFetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = globalFetchMock.mock.calls[0];
        expect(url).toBe('http://localhost:8000/v1/chat/completions');

        const bodyObj = JSON.parse(init.body);
        expect(bodyObj.reasoning_effort).toBe('xhigh');
        expect(bodyObj.model).toBe('glm-5.2');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('4. System Prompt Turn Bounds and Active Exploration Guidelines Inclusion', () => {
    it('includes turn bounds in system prompt for maxTurns = 1, 5, 15, 20', async () => {
      const turnsToTest = [1, 5, 15, 20];

      for (const turns of turnsToTest) {
        mockClient.complete.mockReset();
        const config = createMockConfig({ maxTurns: turns });
        const changedFiles = [{ path: 'src/app.ts', patch: '+ console.log("test");' }];

        mockClient.complete.mockImplementation(async (opts: any) => {
          const allMsg = JSON.stringify(opts.messages);
          const prompt = opts.messages[1]?.content as string || '';
          const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/) || allMsg.match(/CT_REVIEW_NONCE:(.*?)"/);
          const nonce = nonceMatch ? nonceMatch[1].trim() : 'nonce';

          if (allMsg.includes('arbiter')) {
            return {
              model: opts.model,
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Approved' })}\nCT_REVIEW_END:${nonce}`,
              usage: { prompt: 10, completion: 10, total: 20 },
            };
          } else if (allMsg.includes('moderator')) {
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

        await executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/cisco-cdr',
          headSha: 'abc1234',
          client: mockClient as unknown as OmniRouteClient,
        });

        const systemMsg = mockClient.complete.mock.calls[0][0].messages.find((m: any) => m.role === 'system');
        expect(systemMsg.content).toContain(`- You are granted up to ${turns} execution turns for active codebase exploration.`);
      }
    });

    it('includes appropriate exploration guidelines for low vs deep effort (medium, high, xhigh, max)', async () => {
      // Test low effort guideline
      {
        mockClient.complete.mockReset();
        const config = createMockConfig({ effort: 'low' });
        const changedFiles = [{ path: 'src/app.ts', patch: '+ console.log("test");' }];

        mockClient.complete.mockImplementation(async (opts: any) => {
          const allMsg = JSON.stringify(opts.messages);
          const prompt = opts.messages[1]?.content as string || '';
          const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/) || allMsg.match(/CT_REVIEW_NONCE:(.*?)"/);
          const nonce = nonceMatch ? nonceMatch[1].trim() : 'nonce';

          if (allMsg.includes('arbiter')) {
            return {
              model: opts.model,
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Approved' })}\nCT_REVIEW_END:${nonce}`,
              usage: { prompt: 10, completion: 10, total: 20 },
            };
          } else if (allMsg.includes('moderator')) {
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

        await executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/cisco-cdr',
          headSha: 'abc1234',
          client: mockClient as unknown as OmniRouteClient,
        });

        const systemMsg = mockClient.complete.mock.calls[0][0].messages.find((m: any) => m.role === 'system');
        expect(systemMsg.content).toContain('Reasoning Effort Level: LOW.');
        expect(systemMsg.content).toContain('- Perform tool calls as needed to inspect file contents and verify code context.');
        expect(systemMsg.content).not.toContain('ACTIVE DEEP EXPLORATION REQUIRED');
      }

      // Test deep effort guidelines (medium, high, xhigh, max)
      const deepEfforts = ['medium', 'high', 'xhigh', 'max'] as const;
      for (const effort of deepEfforts) {
        mockClient.complete.mockReset();
        const config = createMockConfig({ effort });
        const changedFiles = [{ path: 'src/app.ts', patch: '+ console.log("test");' }];

        mockClient.complete.mockImplementation(async (opts: any) => {
          const allMsg = JSON.stringify(opts.messages);
          const prompt = opts.messages[1]?.content as string || '';
          const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/) || allMsg.match(/CT_REVIEW_NONCE:(.*?)"/);
          const nonce = nonceMatch ? nonceMatch[1].trim() : 'nonce';

          if (allMsg.includes('arbiter')) {
            return {
              model: opts.model,
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Approved' })}\nCT_REVIEW_END:${nonce}`,
              usage: { prompt: 10, completion: 10, total: 20 },
            };
          } else if (allMsg.includes('moderator')) {
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

        await executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/cisco-cdr',
          headSha: 'abc1234',
          client: mockClient as unknown as OmniRouteClient,
        });

        const systemMsg = mockClient.complete.mock.calls[0][0].messages.find((m: any) => m.role === 'system');
        expect(systemMsg.content).toContain(`Reasoning Effort Level: ${effort.toUpperCase()}.`);
        expect(systemMsg.content).toContain('- ACTIVE DEEP EXPLORATION REQUIRED: Perform multi-turn tool calls to search symbol dependencies, inspect related imported files, verify caller/callee context, and audit cross-file contracts before rendering your final decision.');
      }
    });
  });
});
