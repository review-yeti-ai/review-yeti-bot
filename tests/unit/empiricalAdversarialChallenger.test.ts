import { describe, it, expect, vi } from 'vitest';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

describe('Milestone 1 Empirical Adversarial Challenger Suite', () => {

  const getValidPanelConfig = () => ({
    version: '3.0',
    quorum: 1,
    reviewers: {
      providers: [
        { id: 'mock-provider', enabled: true, model: 'mock-model', review_timeout_s: 30, arbiter_timeout_s: 30 },
      ],
      arbiter: {
        order: ['mock-provider'],
      },
    },
    personas: [
      {
        id: 'correctness',
        provider: 'mock-provider',
        providers: ['mock-provider'],
        model: 'mock-model',
        charter: 'builtin:correctness',
        enabled: true,
        required: true,
        paths: ['**/*'],
      },
    ],
    moderator: { provider: 'mock-provider', providers: ['mock-provider'], model: 'mock-model', review_timeout_s: 30 },
    arbiter: { provider: 'mock-provider', providers: ['mock-provider'], model: 'mock-model', arbiter_timeout_s: 30 },
  });

  const createMockClientWithToolCall = (toolName: string, args: any = {}) => {
    const mockClient: OmniRouteClient = {
      complete: vi.fn().mockImplementation(async ({ messages }: { messages: any[] }) => {
        const sysMsg = messages.find((m) => m.role === 'system')?.content || '';
        const userMsg = messages[messages.length - 1]?.content || '';
        const nonceMatch = messages.find((m) => m.content?.includes('CT_REVIEW_NONCE:'))?.content.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
        const nonce = nonceMatch ? nonceMatch[1] : 'nonce-123';

        if (sysMsg.includes('correctness') || sysMsg.includes('Persona')) {
          if (!userMsg.includes('[PI_TOOL_RESULT]')) {
            return {
              id: 'msg_tool',
              providerId: 'mock-provider',
              model: 'mock-model',
              content: `Let me attempt tool execution.\n\n\`\`\`json\n{\n  "tool": ${JSON.stringify(toolName)},\n  "args": ${JSON.stringify(args)}\n}\n\`\`\``,
              usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
              durationMs: 10,
            };
          } else {
            return {
              id: 'msg_persona',
              providerId: 'mock-provider',
              model: 'mock-model',
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ role: 'correctness', decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
              usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, estimatedCostUSD: 0.001 },
              durationMs: 10,
            };
          }
        } else if (sysMsg.includes('MODERATOR') || sysMsg.includes('moderator')) {
          return {
            id: 'msg_mod',
            providerId: 'mock-provider',
            model: 'mock-model',
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
            durationMs: 10,
          };
        } else {
          return {
            id: 'msg_arb',
            providerId: 'mock-provider',
            model: 'mock-model',
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All clean' })}\nCT_REVIEW_END:${nonce}`,
            usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
            durationMs: 10,
          };
        }
      }),
    } as unknown as OmniRouteClient;

    return mockClient;
  };

  describe('1. Adversarial Rejection of Miller and Disallowed Tools', () => {
    const runDisallowedToolTest = async (disallowedTool: string, args: any = {}) => {
      const mockClient = createMockClientWithToolCall(disallowedTool, args);
      const panelConfig: any = getValidPanelConfig();

      const result = await executePersonaPanel({
        config: panelConfig,
        client: mockClient,
        repository: 'ct/repo',
        headSha: 'abc1234',
        changedFiles: [
          { path: 'src/main.ts', patch: '@@ -1,1 +1,2 @@\n+console.log("hello");\n', content: 'console.log("hello");\n' },
        ],
      });

      expect(result).toBeDefined();
      expect(result.arbiter?.verdict).toBe('SHIP');
      expect(mockClient.complete).toHaveBeenCalled();

      const calls = (mockClient.complete as any).mock.calls;
      let toolResultMessage: any = null;
      for (const call of calls) {
        const msgs = call[0]?.messages || [];
        const found = msgs.find((m: any) => m.content && m.content.includes('[PI_TOOL_RESULT]'));
        if (found) {
          toolResultMessage = found;
          break;
        }
      }

      expect(toolResultMessage).toBeDefined();
      expect(toolResultMessage.content).toContain(`Tool '${disallowedTool}' execution rejected: Permission denied.`);
      expect(toolResultMessage.content).toContain('Reviewer personas are restricted strictly to read-only code, search, and MCP tools.');
      expect(toolResultMessage.content).not.toContain('MILLER CONTEXT');
    };

    it('rejects exact tool "miller" with permission denied', async () => {
      await runDisallowedToolTest('miller', { filePath: 'src/main.ts' });
    });

    it('rejects uppercase "MILLER" with permission denied', async () => {
      await runDisallowedToolTest('MILLER', { path: 'src/main.ts' });
    });

    it('rejects PascalCase "Miller" with permission denied', async () => {
      await runDisallowedToolTest('Miller', { path: 'src/main.ts' });
    });

    it('rejects mixed-case "mIlLeR" with permission denied', async () => {
      await runDisallowedToolTest('mIlLeR', { path: 'src/main.ts' });
    });

    it('rejects "executeMillerTool" with permission denied', async () => {
      await runDisallowedToolTest('executeMillerTool', { filePath: 'src/main.ts' });
    });

    it('rejects path traversal disguised tool "../../miller" with permission denied', async () => {
      await runDisallowedToolTest('../../miller', { path: 'src/main.ts' });
    });

    it('rejects absolute path disguised tool "/usr/bin/miller" with permission denied', async () => {
      await runDisallowedToolTest('/usr/bin/miller', { path: 'src/main.ts' });
    });

    it('rejects directory prefixed tool "services/millerTool" with permission denied', async () => {
      await runDisallowedToolTest('services/millerTool', { path: 'src/main.ts' });
    });

    it('rejects alias variants "miller_tool" and "ast_miller" with permission denied', async () => {
      await runDisallowedToolTest('miller_tool', { path: 'src/main.ts' });
      await runDisallowedToolTest('ast_miller', { path: 'src/main.ts' });
    });

    it('rejects command injection payload inside args with permission denied', async () => {
      await runDisallowedToolTest('miller', {
        filePath: 'src/main.ts; rm -rf /',
        command: 'exec("rm -rf /")',
        patch: '@@ -1,1 +1,2 @@\n+malicious\n',
      });
    });

    it('rejects write and modification tools', async () => {
      await runDisallowedToolTest('write_file', { path: 'src/main.ts', content: 'hack' });
      await runDisallowedToolTest('replace_file_content', { path: 'src/main.ts' });
      await runDisallowedToolTest('run_command', { command: 'echo pwned' });
    });
  });

  describe('2. Comprehensive Allowed Tools Functionality (All 9 Allowed Tools + MCP)', () => {
    const runAllowedToolTest = async (toolName: string, args: any, expectedOutputSubstring: string) => {
      const mockClient = createMockClientWithToolCall(toolName, args);
      const panelConfig: any = getValidPanelConfig();

      const result = await executePersonaPanel({
        config: panelConfig,
        client: mockClient,
        repository: 'ct/repo',
        headSha: 'abc1234',
        changedFiles: [
          {
            path: 'src/calculator.ts',
            patch: '@@ -1,5 +1,7 @@\n export class Calculator {\n+  public add(a: number, b: number): number { return a + b; }\n }\n',
            content: 'export class Calculator {\n  public add(a: number, b: number): number { return a + b; }\n}\n',
          },
        ],
      });

      expect(result).toBeDefined();
      expect(result.arbiter?.verdict).toBe('SHIP');
      expect(mockClient.complete).toHaveBeenCalled();

      const calls = (mockClient.complete as any).mock.calls;
      let toolResultMessage: any = null;
      for (const call of calls) {
        const msgs = call[0]?.messages || [];
        const found = msgs.find((m: any) => m.content && m.content.includes('[PI_TOOL_RESULT]'));
        if (found) {
          toolResultMessage = found;
          break;
        }
      }

      expect(toolResultMessage).toBeDefined();
      expect(toolResultMessage.content).not.toContain('Permission denied');
      expect(toolResultMessage.content).toContain(`Tool '${toolName}' execution result:`);
      expect(toolResultMessage.content).toContain(expectedOutputSubstring);
    };

    it('1. view_file executes cleanly without regression', async () => {
      await runAllowedToolTest('view_file', { path: 'src/calculator.ts' }, 'Calculator');
    });

    it('2. read_file executes cleanly without regression', async () => {
      await runAllowedToolTest('read_file', { path: 'src/calculator.ts' }, 'Calculator');
    });

    it('3. get_diff executes cleanly without regression', async () => {
      await runAllowedToolTest('get_diff', { path: 'src/calculator.ts' }, 'Calculator');
    });

    it('4. grep_search executes cleanly without regression', async () => {
      await runAllowedToolTest('grep_search', { query: 'add' }, 'Matches found in diff: src/calculator.ts');
    });

    it('5. find_files executes cleanly without regression', async () => {
      await runAllowedToolTest('find_files', { query: 'calculator' }, 'Files found in diff: src/calculator.ts');
    });

    it('6. symbol_search executes cleanly without regression', async () => {
      await runAllowedToolTest('symbol_search', { query: 'Calculator' }, 'src/calculator.ts: class Calculator');
    });

    it('7. search_code executes cleanly without regression', async () => {
      await runAllowedToolTest('search_code', { query: 'add' }, 'Matches found in diff: src/calculator.ts');
    });

    it('8. code_search_zoekt executes cleanly without regression (fail-soft fallback)', async () => {
      await runAllowedToolTest('code_search_zoekt', { query: 'Calculator' }, '[SCOPE: full-repository-zoekt');
    });

    it('9. zoekt_search executes cleanly without regression (fail-soft fallback)', async () => {
      await runAllowedToolTest('zoekt_search', { query: 'Calculator' }, '[SCOPE: full-repository-zoekt');
    });

    it('10. MCP tool execution executes cleanly', async () => {
      await runAllowedToolTest('mcp_context7_query', { topic: 'security' }, 'Tool \'mcp_context7_query\' execution result:');
    });
  });

  describe('3. Reviewer Persona Execution Loop Integrity & Resilience', () => {
    it('cleanly records rejection in [PI_TOOL_RESULT] and allows persona recovery without crashing', async () => {
      let turn = 0;
      const recordedUserMessages: string[] = [];

      const mockClient: OmniRouteClient = {
        complete: vi.fn().mockImplementation(async ({ messages }: { messages: any[] }) => {
          const sysMsg = messages.find((m) => m.role === 'system')?.content || '';
          const lastMsg = messages[messages.length - 1]?.content || '';
          const nonceMatch = messages.find((m) => m.content?.includes('CT_REVIEW_NONCE:'))?.content.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
          const nonce = nonceMatch ? nonceMatch[1] : 'nonce-rec';

          if (sysMsg.includes('correctness') || sysMsg.includes('Persona')) {
            turn++;
            if (turn === 1) {
              return {
                id: 'msg_t1',
                providerId: 'mock-provider',
                model: 'mock-model',
                content: '```json\n{\n  "tool": "miller",\n  "args": { "filePath": "src/index.ts" }\n}\n```',
                usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
                durationMs: 10,
              };
            } else {
              recordedUserMessages.push(lastMsg);
              return {
                id: 'msg_t2',
                providerId: 'mock-provider',
                model: 'mock-model',
                content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({
                  role: 'correctness',
                  decision: 'APPROVE',
                  findings: [],
                  summary: 'Miller rejection handled gracefully; review completed.',
                })}\nCT_REVIEW_END:${nonce}`,
                usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, estimatedCostUSD: 0.001 },
                durationMs: 10,
              };
            }
          } else if (sysMsg.includes('MODERATOR') || sysMsg.includes('moderator')) {
            return {
              id: 'msg_mod',
              providerId: 'mock-provider',
              model: 'mock-model',
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
              usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
              durationMs: 10,
            };
          } else {
            return {
              id: 'msg_arb',
              providerId: 'mock-provider',
              model: 'mock-model',
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All clean after miller rejection' })}\nCT_REVIEW_END:${nonce}`,
              usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
              durationMs: 10,
            };
          }
        }),
      } as unknown as OmniRouteClient;

      const result = await executePersonaPanel({
        config: getValidPanelConfig() as any,
        client: mockClient,
        repository: 'ct/repo',
        headSha: 'cdef123',
        changedFiles: [{ path: 'src/index.ts', patch: '@@ -1,2 +1,2 @@\n' }],
      });

      expect(result).toBeDefined();
      expect(result.arbiter?.verdict).toBe('SHIP');
      expect(recordedUserMessages.length).toBeGreaterThan(0);
      const toolResultMsg = recordedUserMessages[0];
      expect(toolResultMsg).toContain('[PI_TOOL_RESULT]');
      expect(toolResultMsg).toContain("Tool 'miller' execution rejected: Permission denied.");
      expect(toolResultMsg).toContain('Reviewer personas are restricted strictly to read-only code, search, and MCP tools.');
    });

    it('handles multiple consecutive disallowed tool calls without crashing', async () => {
      let turn = 0;
      const mockClient: OmniRouteClient = {
        complete: vi.fn().mockImplementation(async ({ messages }: { messages: any[] }) => {
          const sysMsg = messages.find((m) => m.role === 'system')?.content || '';
          const nonceMatch = messages.find((m) => m.content?.includes('CT_REVIEW_NONCE:'))?.content.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
          const nonce = nonceMatch ? nonceMatch[1] : 'nonce-multi';

          if (sysMsg.includes('correctness') || sysMsg.includes('Persona')) {
            turn++;
            if (turn === 1) {
              return {
                id: 'msg_t1',
                providerId: 'mock-provider',
                model: 'mock-model',
                content: '```json\n{\n  "tool": "miller",\n  "args": {}\n}\n```',
                usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
                durationMs: 10,
              };
            } else if (turn === 2) {
              return {
                id: 'msg_t2',
                providerId: 'mock-provider',
                model: 'mock-model',
                content: '```json\n{\n  "tool": "Miller",\n  "args": {}\n}\n```',
                usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
                durationMs: 10,
              };
            } else {
              return {
                id: 'msg_t3',
                providerId: 'mock-provider',
                model: 'mock-model',
                content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ role: 'correctness', decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
                usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, estimatedCostUSD: 0.001 },
                durationMs: 10,
              };
            }
          } else if (sysMsg.includes('MODERATOR') || sysMsg.includes('moderator')) {
            return {
              id: 'msg_mod',
              providerId: 'mock-provider',
              model: 'mock-model',
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
              usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
              durationMs: 10,
            };
          } else {
            return {
              id: 'msg_arb',
              providerId: 'mock-provider',
              model: 'mock-model',
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Pass' })}\nCT_REVIEW_END:${nonce}`,
              usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
              durationMs: 10,
            };
          }
        }),
      } as unknown as OmniRouteClient;

      const result = await executePersonaPanel({
        config: getValidPanelConfig() as any,
        client: mockClient,
        repository: 'ct/repo',
        headSha: 'cdef123',
        changedFiles: [{ path: 'src/index.ts', patch: '@@ -1,2 +1,2 @@\n' }],
      });

      expect(result).toBeDefined();
      expect(result.arbiter?.verdict).toBe('SHIP');
      expect(turn).toBe(3);
    });

    it('handles empty args ({}) with miller safely without exception', async () => {
      const mockClient = createMockClientWithToolCall('miller', {});
      const result = await executePersonaPanel({
        config: getValidPanelConfig() as any,
        client: mockClient,
        repository: 'ct/repo',
        headSha: 'cdef123',
        changedFiles: [{ path: 'src/index.ts', patch: '@@ -1,2 +1,2 @@\n' }],
      });

      expect(result).toBeDefined();
      expect(result.arbiter?.verdict).toBe('SHIP');
    });

    it('rejects miller in nativeJsonMode and returns [PI_TOOL_RESULT] cleanly', async () => {
      let capturedToolResult = '';
      const mockClient: OmniRouteClient = {
        complete: vi.fn().mockImplementation(async ({ messages, responseFormat }: { messages: any[]; responseFormat?: any }) => {
          const sysMsg = messages.find((m) => m.role === 'system')?.content || '';
          const lastMsg = messages[messages.length - 1]?.content || '';
          const nonceMatch = sysMsg.match(/exact top-level nonce "([a-f0-9-]+)"/)
            || lastMsg.match(/exact top-level nonce "([a-f0-9-]+)"/)
            || lastMsg.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
          const nonce = nonceMatch ? nonceMatch[1] : 'nonce-native';

          if (sysMsg.includes('review arbiter')) {
            return {
              id: 'msg_arb',
              providerId: 'mock-provider',
              model: 'mock-model',
              content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'Pass' }),
              usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
              durationMs: 10,
            };
          } else if (sysMsg.includes('review moderator')) {
            return {
              id: 'msg_mod',
              providerId: 'mock-provider',
              model: 'mock-model',
              content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }),
              usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
              durationMs: 10,
            };
          } else {
            if (lastMsg.includes('[PI_TOOL_RESULT]')) {
              capturedToolResult = lastMsg;
              return {
                id: 'msg_native_final',
                providerId: 'mock-provider',
                model: 'mock-model',
                content: JSON.stringify({
                  nonce,
                  role: 'correctness',
                  decision: 'APPROVE',
                  findings: [],
                  summary: 'Clean native completion after miller rejection',
                }),
                usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, estimatedCostUSD: 0.001 },
                durationMs: 10,
              };
            } else {
              return {
                id: 'msg_native_tool',
                providerId: 'mock-provider',
                model: 'mock-model',
                content: JSON.stringify({
                  tool: 'miller',
                  args: { filePath: 'src/config.ts' },
                }),
                usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
                durationMs: 10,
              };
            }
          }
        }),
      } as unknown as OmniRouteClient;

      const result = await executePersonaPanel({
        config: getValidPanelConfig() as any,
        client: mockClient,
        repository: 'ct/repo',
        headSha: 'cdef123',
        changedFiles: [{ path: 'src/config.ts', patch: '@@ -1,2 +1,2 @@\n' }],
        requestPolicy: {
          responseFormat: { type: 'json_object' },
        },
      });

      expect(result).toBeDefined();
      expect(result.arbiter?.verdict).toBe('SHIP');
      expect(capturedToolResult).toContain('[PI_TOOL_RESULT]');
      expect(capturedToolResult).toContain("Tool 'miller' execution rejected: Permission denied.");
      expect(capturedToolResult).toContain('Reviewer personas are restricted strictly to read-only code, search, and MCP tools.');
    });

    it('rejects additional traversal patterns and path variations for miller', async () => {
      const traversalTools = [
        '../services/millerTool.js',
        '../../src/services/millerTool.ts',
        '..\\..\\miller',
        './miller',
        'bin/miller',
        'tools/miller',
        'node_modules/miller',
        'eval("miller")',
        'miller()',
      ];

      for (const disguised of traversalTools) {
        const mockClient = createMockClientWithToolCall(disguised, { path: 'src/main.ts' });
        const result = await executePersonaPanel({
          config: getValidPanelConfig() as any,
          client: mockClient,
          repository: 'ct/repo',
          headSha: 'abc1234',
          changedFiles: [{ path: 'src/main.ts', patch: '@@ -1,1 +1,2 @@\n' }],
        });

        expect(result).toBeDefined();
        const calls = (mockClient.complete as any).mock.calls;
        let toolResultMessage: any = null;
        for (const call of calls) {
          const msgs = call[0]?.messages || [];
          const found = msgs.find((m: any) => m.content && m.content.includes('[PI_TOOL_RESULT]'));
          if (found) {
            toolResultMessage = found;
            break;
          }
        }
        expect(toolResultMessage).toBeDefined();
        expect(toolResultMessage.content).toContain(`Tool '${disguised}' execution rejected: Permission denied.`);
      }
    });
  });
});
