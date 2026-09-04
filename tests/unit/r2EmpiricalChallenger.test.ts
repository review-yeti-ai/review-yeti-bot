import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { executeMillerTool } from '../../src/services/millerTool';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

const TMP_DIR = path.join(__dirname, '../../fixtures/tmp/r2_test');

describe('Requirement R2 Empirical Challenger Test Suite', () => {

  beforeAll(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    
    // Create TS test file
    fs.writeFileSync(
      path.join(TMP_DIR, 'sample.ts'),
      `export interface User {\n  id: string;\n  name: string;\n}\n\nexport class UserService {\n  public getUser(id: string): User {\n    console.log("Fetching user", id);\n    return { id, name: "Alice" };\n  }\n}\n`
    );

    // Create JS test file
    fs.writeFileSync(
      path.join(TMP_DIR, 'sample.js'),
      `function calculateTax(amount) {\n  const rate = 0.15;\n  return amount * rate;\n}\n\nmodule.exports = { calculateTax };\n`
    );

    // Create Py test file
    fs.writeFileSync(
      path.join(TMP_DIR, 'sample.py'),
      `class DataProcessor:\n    def process(self, data):\n        print("Processing items")\n        return [x * 2 for x in data]\n\ndef main():\n    processor = DataProcessor()\n    print(processor.process([1, 2, 3]))\n`
    );

    // Create MD test file
    fs.writeFileSync(
      path.join(TMP_DIR, 'sample.md'),
      `# Documentation\n\n## Architectural Overview\nThis document describes the CT Bot system architecture.\n`
    );

    // Create JSON test file
    fs.writeFileSync(
      path.join(TMP_DIR, 'sample.json'),
      `{\n  "name": "ct-review-bot",\n  "version": "1.6.0",\n  "private": true\n}\n`
    );

    // Create YAML test file
    fs.writeFileSync(
      path.join(TMP_DIR, 'sample.yaml'),
      `version: "3.0"\npersonas:\n  - id: security\n`
    );
  });

  afterAll(() => {
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    } catch (_) {}
  });

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
        const found = msgs.find((m: any) => m.content && m.content.includes('[PI_TOOL_RESULT]'));
        if (found) {
          toolResultMessage = found;
          break;
        }
      }
      
      expect(toolResultMessage).toBeDefined();
      expect(toolResultMessage.content).toContain(`Tool '${disallowedTool}' execution rejected: Permission denied.`);
      expect(toolResultMessage.content).toContain('Reviewer personas are restricted strictly to read-only code, Miller, search, and MCP tools.');
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

    it('executes view_file cleanly', async () => {
      await runAllowedToolTest('view_file', { path: 'src/calculator.ts' }, 'Calculator');
    });

    it('executes read_file cleanly', async () => {
      await runAllowedToolTest('read_file', { path: 'src/calculator.ts' }, 'Calculator');
    });

    it('executes miller cleanly', async () => {
      await runAllowedToolTest('miller', { path: 'src/calculator.ts' }, 'MILLER CONTEXT');
    });

    it('executes grep_search cleanly', async () => {
      await runAllowedToolTest('grep_search', { query: 'add' }, 'Matches found in: src/calculator.ts');
    });

    it('executes find_files cleanly', async () => {
      await runAllowedToolTest('find_files', { query: 'calculator' }, 'Files found: src/calculator.ts');
    });

    it('executes symbol_search cleanly', async () => {
      await runAllowedToolTest('symbol_search', { query: 'Calculator' }, 'src/calculator.ts: class Calculator');
    });

    it('executes mcp_* tools cleanly', async () => {
      await runAllowedToolTest('mcp_context7_query', { topic: 'security' }, 'Tool \'mcp_context7_query\' execution result:');
    });
  });

  describe('3. Miller Tool executeMillerTool AST vs Fallback Execution', () => {

    describe('Code Files (TS, JS, Py)', () => {
      it('processes TypeScript code file with AST bounded mode when overlapping patch lines', async () => {
        const tsPath = path.join(TMP_DIR, 'sample.ts');
        const patch = `@@ -6,4 +6,5 @@\n export class UserService {\n   public getUser(id: string): User {\n+    console.log("Fetching user", id);\n     return { id, name: "Alice" };\n   }\n`;

        const res = await executeMillerTool({
          filePath: tsPath,
          patch,
        });

        expect(res).toBeDefined();
        expect(res.language).toBe('typescript');
        expect(res.mode).toBe('ast_bounded');
        expect(res.nodes).toBeDefined();
        expect(res.nodes!.length).toBeGreaterThan(0);
        expect(res.miller).toContain('MILLER CONTEXT (Syntactically Bounded AST:');
        expect(res.miller).toContain('UserService');
      });

      it('processes JavaScript code file with AST bounded mode', async () => {
        const jsPath = path.join(TMP_DIR, 'sample.js');
        const patch = `@@ -1,4 +1,5 @@\n function calculateTax(amount) {\n+  if (amount < 0) return 0;\n   const rate = 0.15;\n   return amount * rate;\n }\n`;

        const res = await executeMillerTool({
          filePath: jsPath,
          patch,
        });

        expect(res).toBeDefined();
        expect(res.language).toBe('javascript');
        expect(res.mode).toBe('ast_bounded');
        expect(res.miller).toContain('MILLER CONTEXT (Syntactically Bounded AST:');
        expect(res.miller).toContain('calculateTax');
      });

      it('processes Python code file with AST bounded mode', async () => {
        const pyPath = path.join(TMP_DIR, 'sample.py');
        const patch = `@@ -2,3 +2,4 @@\n class DataProcessor:\n     def process(self, data):\n+        print("Processing items")\n         return [x * 2 for x in data]\n`;

        const res = await executeMillerTool({
          filePath: pyPath,
          patch,
        });

        expect(res).toBeDefined();
        expect(res.language).toBe('python');
        expect(res.mode).toBe('ast_bounded');
        expect(res.miller).toContain('MILLER CONTEXT (Syntactically Bounded AST:');
        expect(res.miller).toContain('DataProcessor');
      });
    });

    describe('Non-Code Files (MD, JSON, YAML, TXT)', () => {
      it('falls back to hunk context for Markdown (.md) files', async () => {
        const mdPath = path.join(TMP_DIR, 'sample.md');
        const patch = `@@ -1,3 +1,5 @@\n # Documentation\n+\n+## Architectural Overview\nThis document describes the CT Bot system architecture.\n`;

        const res = await executeMillerTool({
          filePath: mdPath,
          patch,
        });

        expect(res).toBeDefined();
        expect(res.mode).toBe('hunk_fallback');
        expect(res.miller).toContain('=== MILLER CONTEXT (Hunk Fallback:');
        expect(res.miller).toContain('Architectural Overview');
      });

      it('falls back to hunk context for JSON (.json) files', async () => {
        const jsonPath = path.join(TMP_DIR, 'sample.json');
        const patch = `@@ -1,5 +1,7 @@\n {\n   "name": "ct-review-bot",\n+  "version": "1.6.0",\n   "private": true\n }\n`;

        const res = await executeMillerTool({
          filePath: jsonPath,
          patch,
        });

        expect(res).toBeDefined();
        expect(res.mode).toBe('hunk_fallback');
        expect(res.miller).toContain('=== MILLER CONTEXT (Hunk Fallback:');
        expect(res.miller).toContain('"version": "1.6.0"');
      });

      it('falls back to hunk context for YAML (.yaml/.yml) files', async () => {
        const yamlPath = path.join(TMP_DIR, 'sample.yaml');
        const patch = `@@ -1,4 +1,5 @@\n version: "3.0"\n personas:\n+  - id: security\n`;

        const res = await executeMillerTool({
          filePath: yamlPath,
          patch,
        });

        expect(res).toBeDefined();
        expect(res.mode).toBe('hunk_fallback');
        expect(res.miller).toContain('=== MILLER CONTEXT (Hunk Fallback:');
      });

      it('falls back to hunk context for plain text (.txt) files', async () => {
        const patch = `@@ -1,1 +1,2 @@\n Initial text line.\n+Appended text line.\n`;

        const res = await executeMillerTool({
          filePath: 'notes.txt',
          patch,
        });

        expect(res).toBeDefined();
        expect(res.mode).toBe('hunk_fallback');
        expect(res.miller).toContain('=== MILLER CONTEXT (Hunk Fallback: notes.txt) ===');
      });
    });
  });
});
