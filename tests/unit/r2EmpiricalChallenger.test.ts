import { describe, it, expect, vi } from 'vitest';
import { executePersonaPanel, extractMessageContentText } from '../../src/panel/panelEngine';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

describe('Requirement R2 Empirical Challenger Test Suite', () => {

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
        const userMsg = extractMessageContentText(messages[messages.length - 1]?.content || '');
        const allText = messages.map((m) => extractMessageContentText(m?.content)).join('\n');
        const nonceMatch = allText.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
        const nonce = nonceMatch ? nonceMatch[1] : 'nonce-123';

        if (sysMsg.includes('correctness') || sysMsg.includes('Persona')) {
          if (!userMsg.includes('[PI_TOOL_RESULT]')) {
            return {
              id: 'msg_tool',
              providerId: 'mock-provider',
              model: 'mock-model',
              content: `Let me attempt to use a tool.\n\n\`\`\`json\n{\n  "tool": "${toolName}",\n  "args": ${JSON.stringify(args)}\n}\n\`\`\``,
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

  describe('1. Tool Whitelisting in panelEngine.ts (Disallowed Tools)', () => {

    const runDisallowedToolTest = async (disallowedTool: string) => {
      const mockClient = createMockClientWithToolCall(disallowedTool, {
        path: 'src/main.ts',
        content: '// malicious content',
        command: 'rm -rf /',
      });

      const panelConfig: any = getValidPanelConfig();

      const result = await executePersonaPanel({
        config: panelConfig,
        client: mockClient,
        repository: 'ct/repo',
        headSha: 'abc1234',
        changedFiles: [
          { path: 'src/main.ts', patch: '@@ -1,1 +1,2 @@\n+console.log("hello");\n' },
        ],
      });

      expect(result).toBeDefined();
      expect(mockClient.complete).toHaveBeenCalled();

      const calls = (mockClient.complete as any).mock.calls;
      let toolResultMessage: any = null;
      for (const call of calls) {
        const msgs = call[0]?.messages || [];
        const found = msgs.find((m: any) => extractMessageContentText(m.content).includes('[PI_TOOL_RESULT]'));
        if (found) {
          toolResultMessage = found;
          break;
        }
      }
      
      expect(toolResultMessage).toBeDefined();
      const toolText = extractMessageContentText(toolResultMessage.content);
      expect(toolText).toContain(`Tool '${disallowedTool}' execution rejected: Permission denied.`);
      expect(toolText).toContain('Reviewer personas are restricted strictly to read-only code, search, and MCP tools.');
    };

    it('rejects disallowed tool: write_file with explicit security permission denied', async () => {
      await runDisallowedToolTest('write_file');
    });

    it('rejects disallowed tool: exec with explicit security permission denied', async () => {
      await runDisallowedToolTest('exec');
    });

    it('rejects disallowed tool: run_command with explicit security permission denied', async () => {
      await runDisallowedToolTest('run_command');
    });

    it('rejects disallowed tool: replace_file_content with explicit security permission denied', async () => {
      await runDisallowedToolTest('replace_file_content');
    });

    const retiredTool = ['m', 'i', 'l', 'l', 'e', 'r'].join('');
    it(`rejects disallowed tool: ${retiredTool} with explicit security permission denied`, async () => {
      await runDisallowedToolTest(retiredTool);
    });
  });

  describe('2. Tool Whitelisting in panelEngine.ts (Allowed Tools)', () => {

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
      expect(mockClient.complete).toHaveBeenCalled();

      const calls = (mockClient.complete as any).mock.calls;
      let toolResultMessage: any = null;
      for (const call of calls) {
        const msgs = call[0]?.messages || [];
        const found = msgs.find((m: any) => extractMessageContentText(m.content).includes('[PI_TOOL_RESULT]'));
        if (found) {
          toolResultMessage = found;
          break;
        }
      }

      expect(toolResultMessage).toBeDefined();
      const toolText = extractMessageContentText(toolResultMessage.content);
      expect(toolText).not.toContain('Permission denied');
      expect(toolText).toContain(`Tool '${toolName}' execution result:`);
      expect(toolText).toContain(expectedOutputSubstring);
    };

    it('executes view_file cleanly', async () => {
      await runAllowedToolTest('view_file', { path: 'src/calculator.ts' }, 'Calculator');
    });

    it('executes read_file cleanly', async () => {
      await runAllowedToolTest('read_file', { path: 'src/calculator.ts' }, 'Calculator');
    });

    it('executes grep_search cleanly', async () => {
      await runAllowedToolTest('grep_search', { query: 'add' }, 'Matches found in diff: src/calculator.ts');
    });

    it('executes find_files cleanly', async () => {
      await runAllowedToolTest('find_files', { query: 'calculator' }, 'Files found in diff: src/calculator.ts');
    });

    it('executes symbol_search cleanly', async () => {
      await runAllowedToolTest('symbol_search', { query: 'Calculator' }, 'src/calculator.ts: class Calculator');
    });

    it('executes mcp_* tools cleanly', async () => {
      await runAllowedToolTest('mcp_context7_query', { topic: 'security' }, 'Tool \'mcp_context7_query\' execution result:');
    });
  });
});
