import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';
import * as zoektPreCheckService from '../../src/services/zoektPreCheckService';
import {
  preChecksSchema,
  zoektPreCheckSchema,
  analyzersPreCheckSchema,
  resolvePreChecksConfig,
} from '../../src/config/schema';
import { ConfigResolver } from '../../src/config/configResolver';
import { createDefaultV3Config, parseAndValidateConfig, ConfigValidationError } from '../../src/config/configLoader';

const REPO_ROOT = path.resolve(__dirname, '../..');

describe('Challenger M3-2 Empirical Challenge Test Suite', () => {

  // Helper to build a valid panel config
  const createTestPanelConfig = (overrides: any = {}) => ({
    version: 3 as const,
    profile: 'balanced' as const,
    quorum: 1,
    reviewers: {
      execution: 'personas' as const,
      fallback: 'ordered' as const,
      overall_timeout_s: 60,
      providers: [
        { id: 'mock-prov', enabled: true, model: 'mock-model', review_timeout_s: 30, arbiter_timeout_s: 30 },
      ],
      arbiter: {
        order: ['mock-prov'],
      },
    },
    personas: [
      {
        id: 'sec-lane',
        provider: 'mock-prov',
        providers: ['mock-prov'],
        model: 'mock-model',
        charter: 'builtin:security',
        enabled: true,
        required: true,
        paths: ['src/sec/**'],
      },
      {
        id: 'api-lane',
        provider: 'mock-prov',
        providers: ['mock-prov'],
        model: 'mock-model',
        charter: 'builtin:correctness',
        enabled: true,
        required: true,
        paths: ['src/api/**'],
      },
    ],
    moderator: { provider: 'mock-prov', providers: ['mock-prov'], model: 'mock-model', review_timeout_s: 30 },
    arbiter: { provider: 'mock-prov', providers: ['mock-prov'], model: 'mock-model', arbiter_timeout_s: 30 },
    reviews: {
      profile: 'chill' as const,
      request_changes_workflow: false,
      high_level_summary: true,
      poem: false,
      review_status: true,
      collapse_walkthrough: false,
      auto_review: {
        enabled: true,
        ignore_title_keywords: [],
        labels: [],
        drafts: false,
        base_branches: [],
      },
      tools: {},
    },
    chat: {
      auto_reply: true,
    },
    knowledge_base: {
      opt_out: false,
      learnings: [],
    },
    path_filters: {
      rules: [],
    },
    auto_review: {
      enabled: true,
      drafts: false,
      base_branches: [],
      ignore_title_keywords: [],
      labels: [],
    },
    dials: {},
    mcps: {},
    on_pr_close: {
      create_followup_prs: [],
      sync_productlane: false,
    },
    pre_checks: {
      enabled: true,
      zoekt: {
        enabled: true,
        max_symbols: 25,
        timeoutMs: 5000,
      },
      analyzers: {
        enabled: true,
        linters: true,
        security: true,
        secrets: true,
      },
    },
    ...overrides,
  });

  const createRecordingMockClient = (options: { requestedTool?: string; toolArgs?: any } = {}) => {
    const recordedPrompts: Array<{ role: string; content: string }> = [];
    const recordedCalls: any[] = [];

    const mockClient: OmniRouteClient = {
      complete: vi.fn().mockImplementation(async (payload: { messages: any[] }) => {
        recordedCalls.push(payload);
        for (const msg of payload.messages) {
          recordedPrompts.push(msg);
        }

        const sysMsg = payload.messages.find((m) => m.role === 'system')?.content || '';
        const userMsg = payload.messages[payload.messages.length - 1]?.content || '';
        const nonceMatch = payload.messages.find((m) => m.content?.includes('CT_REVIEW_NONCE:'))?.content.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
        const nonce = nonceMatch ? nonceMatch[1] : 'nonce-emp-123';

        // Check if a tool was requested
        if (options.requestedTool && !userMsg.includes('[PI_TOOL_RESULT]')) {
          return {
            id: 'msg_tool',
            providerId: 'mock-prov',
            model: 'mock-model',
            content: `Attempting tool call.\n\`\`\`json\n{\n  "tool": "${options.requestedTool}",\n  "args": ${JSON.stringify(options.toolArgs || {})}\n}\n\`\`\``,
            usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
            durationMs: 10,
          };
        }

        if (sysMsg.includes('security') || sysMsg.includes('correctness') || sysMsg.includes('sec-lane') || sysMsg.includes('api-lane') || sysMsg.includes('Persona')) {
          return {
            id: 'msg_persona',
            providerId: 'mock-prov',
            model: 'mock-model',
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ role: 'persona', decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, estimatedCostUSD: 0.001 },
            durationMs: 10,
          };
        } else if (sysMsg.includes('MODERATOR') || sysMsg.includes('moderator')) {
          return {
            id: 'msg_mod',
            providerId: 'mock-prov',
            model: 'mock-model',
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
            durationMs: 10,
          };
        } else {
          return {
            id: 'msg_arb',
            providerId: 'mock-prov',
            model: 'mock-model',
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Verified clean' })}\nCT_REVIEW_END:${nonce}`,
            usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
            durationMs: 10,
          };
        }
      }),
    } as unknown as OmniRouteClient;

    return { mockClient, recordedPrompts, recordedCalls };
  };

  // =========================================================================
  // 1. MILLER RETIREMENT VERIFICATION
  // =========================================================================
  describe('1. Miller Retirement Completeness', () => {
    it('1.1: src/services/millerTool.ts does not exist on disk', () => {
      const p = path.join(REPO_ROOT, 'src/services/millerTool.ts');
      expect(fs.existsSync(p)).toBe(false);
    });

    it('1.2: tests/unit/millerTool.test.ts does not exist on disk', () => {
      const p = path.join(REPO_ROOT, 'tests/unit/millerTool.test.ts');
      expect(fs.existsSync(p)).toBe(false);
    });

    it('1.3: dynamic import of millerTool fails with ERR_MODULE_NOT_FOUND', async () => {
      let threw = false;
      try {
        // @ts-ignore
        await import('../../src/services/millerTool');
      } catch (err: any) {
        threw = true;
        expect(err.code).toMatch(/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/);
      }
      expect(threw).toBe(true);
    });

    it('1.4: panelEngine strictly rejects miller tool invocations regardless of case or alias', async () => {
      const disguisedNames = ['miller', 'MILLER', 'mIlLeR', 'miller_tool', 'executeMillerTool'];

      for (const name of disguisedNames) {
        const { mockClient, recordedCalls } = createRecordingMockClient({
          requestedTool: name,
          toolArgs: { path: 'src/sec/auth.ts' },
        });

        const panelConfig = createTestPanelConfig();
        const result = await executePersonaPanel({
          config: panelConfig as any,
          client: mockClient,
          repository: 'ct/repo',
          headSha: 'head123',
          changedFiles: [
            { path: 'src/sec/auth.ts', patch: '@@ -1,1 +1,2 @@\n+const token = "x";\n' },
          ],
        });

        expect(result).toBeDefined();
        // Check that tool result message contains permission denied
        let foundDenial = false;
        for (const call of recordedCalls) {
          for (const msg of call.messages || []) {
            if (msg.content && msg.content.includes('[PI_TOOL_RESULT]')) {
              expect(msg.content).toContain(`Tool '${name}' execution rejected: Permission denied.`);
              foundDenial = true;
            }
          }
        }
        expect(foundDenial).toBe(true);
      }
    });

    it('1.5: persona prompts omit any instructions or references to miller', async () => {
      const { mockClient, recordedPrompts } = createRecordingMockClient();
      const panelConfig = createTestPanelConfig();

      await executePersonaPanel({
        config: panelConfig as any,
        client: mockClient,
        repository: 'ct/repo',
        headSha: 'head123',
        changedFiles: [
          { path: 'src/sec/auth.ts', patch: '@@ -1,1 +1,2 @@\n+const secret = "abc";\n' },
        ],
      });

      for (const p of recordedPrompts) {
        if (typeof p.content === 'string') {
          expect(p.content.toLowerCase()).not.toContain('miller');
        }
      }
    });
  });

  // =========================================================================
  // 2. PANEL ENGINE PRE-CHECK INJECTION UNDER ANOMALIES
  // =========================================================================
  describe('2. Panel Engine Pre-Check Injection Resilience', () => {

    it('2.1: pre-checks disabled -> review runs without error and prompt omits zoekt block', async () => {
      const { mockClient, recordedPrompts } = createRecordingMockClient();
      const panelConfig = createTestPanelConfig({
        pre_checks: {
          enabled: false,
          zoekt: { enabled: false },
          analyzers: { enabled: false },
        },
      });

      const result = await executePersonaPanel({
        config: panelConfig as any,
        client: mockClient,
        repository: 'ct/repo',
        headSha: 'head123',
        changedFiles: [
          { path: 'src/sec/auth.ts', patch: '@@ -1,1 +1,2 @@\n+const token = 123;\n' },
        ],
      });

      expect(result).toBeDefined();
      expect(result.arbiter.verdict).toBe('SHIP');

      // Prompts should NOT contain PRE-CHECK SYMBOL & REPOSITORY CONTEXT
      const zoektSection = recordedPrompts.find(
        (p) => p.content?.includes('PRE-CHECK SYMBOL & REPOSITORY CONTEXT (ZOEKT)')
      );
      expect(zoektSection).toBeUndefined();
    });

    it('2.2: pre-check execution throws unhandled error -> fails soft, review finishes cleanly', async () => {
      const spy = vi.spyOn(zoektPreCheckService, 'executeZoektPreCheck').mockRejectedValueOnce(
        new Error('Zoekt daemon crashed: memory corruption')
      );

      const { mockClient, recordedPrompts } = createRecordingMockClient();
      const panelConfig = createTestPanelConfig();

      const result = await executePersonaPanel({
        config: panelConfig as any,
        client: mockClient,
        repository: 'ct/repo',
        headSha: 'head123',
        changedFiles: [
          { path: 'src/sec/auth.ts', patch: '@@ -1,1 +1,2 @@\n+function verify() {}\n' },
        ],
      });

      expect(result).toBeDefined();
      expect(result.arbiter.verdict).toBe('SHIP');

      // Prompt should have received fail-soft notice
      const zoektPrompt = recordedPrompts.find(
        (p) => p.content?.includes('PRE-CHECK SYMBOL & REPOSITORY CONTEXT (ZOEKT)')
      );
      expect(zoektPrompt).toBeDefined();
      expect(zoektPrompt?.content).toContain('[Status: unavailable | Reason: Zoekt daemon crashed: memory corruption]');
      expect(zoektPrompt?.content).toContain('Use on-demand exploration tools');

      spy.mockRestore();
    });

    it('2.3: partial symbol sets -> scopes symbols to matching persona lanes; non-matching receives fallback', async () => {
      // Mock executeZoektPreCheck returning symbols for src/sec/auth.ts only
      const mockZoektResult: zoektPreCheckService.ZoektPreCheckResult = {
        status: 'ok',
        scannedSymbolsCount: 1,
        matchedSymbolsCount: 1,
        symbols: [
          {
            symbol: 'authenticateUser',
            kind: 'function',
            sourcePath: 'src/sec/auth.ts',
            isModifiedDefinition: true,
            definitions: [],
            callSites: [
              { path: 'src/server/router.ts', line: 42, text: 'authenticateUser(req)' },
            ],
          },
        ],
        receipt: { totalQueries: 1, durationMs: 15 },
      };

      const spy = vi.spyOn(zoektPreCheckService, 'executeZoektPreCheck').mockResolvedValueOnce(mockZoektResult);

      const { mockClient, recordedCalls } = createRecordingMockClient();
      const panelConfig = createTestPanelConfig();

      const result = await executePersonaPanel({
        config: panelConfig as any,
        client: mockClient,
        repository: 'ct/repo',
        headSha: 'head123',
        changedFiles: [
          { path: 'src/sec/auth.ts', patch: '@@ -1,1 +1,2 @@\n+export function authenticateUser() {}\n' },
          { path: 'src/api/routes.ts', patch: '@@ -1,1 +1,2 @@\n+export function getHealth() {}\n' },
        ],
      });

      expect(result).toBeDefined();
      expect(result.arbiter.verdict).toBe('SHIP');

      // Find prompt for sec-lane vs api-lane
      let secLanePrompt = '';
      let apiLanePrompt = '';

      for (const call of recordedCalls) {
        const sys = call.messages.find((m: any) => m.role === 'system')?.content || '';
        const user = call.messages.find((m: any) => m.role === 'user')?.content || '';
        if (sys.includes('security') || sys.includes('sec-lane')) {
          secLanePrompt = user;
        } else if (sys.includes('correctness') || sys.includes('api-lane')) {
          apiLanePrompt = user;
        }
      }

      // sec-lane covers src/sec/** -> should see authenticateUser
      expect(secLanePrompt).toContain('authenticateUser');
      expect(secLanePrompt).toContain('src/server/router.ts:42: authenticateUser(req)');

      // api-lane covers src/api/** -> should NOT see authenticateUser, receives clean "No external definitions" notice
      expect(apiLanePrompt).not.toContain('authenticateUser');
      expect(apiLanePrompt).toContain('No external definitions or call sites were found across the repository');

      spy.mockRestore();
    });

    it('2.4: empty symbol sets -> persona review cleanly receives no-symbols notice without failing', async () => {
      const mockEmptyResult: zoektPreCheckService.ZoektPreCheckResult = {
        status: 'ok',
        scannedSymbolsCount: 2,
        matchedSymbolsCount: 0,
        symbols: [],
        receipt: { totalQueries: 2, durationMs: 10 },
      };

      const spy = vi.spyOn(zoektPreCheckService, 'executeZoektPreCheck').mockResolvedValueOnce(mockEmptyResult);

      const { mockClient, recordedPrompts } = createRecordingMockClient();
      const panelConfig = createTestPanelConfig();

      const result = await executePersonaPanel({
        config: panelConfig as any,
        client: mockClient,
        repository: 'ct/repo',
        headSha: 'head123',
        changedFiles: [
          { path: 'src/sec/auth.ts', patch: '@@ -1,1 +1,2 @@\n+const x = 1;\n' },
        ],
      });

      expect(result).toBeDefined();
      expect(result.arbiter.verdict).toBe('SHIP');

      const zoektPrompt = recordedPrompts.find(
        (p) => p.content?.includes('PRE-CHECK SYMBOL & REPOSITORY CONTEXT (ZOEKT)')
      );
      expect(zoektPrompt?.content).toContain('No external definitions or call sites were found');

      spy.mockRestore();
    });

    it('2.5: malformed pre-check result (undefined symbols array) does not crash panelEngine', async () => {
      const malformedResult: any = {
        status: 'ok',
        scannedSymbolsCount: 1,
        matchedSymbolsCount: 1,
        symbols: null, // intentionally corrupt
        receipt: { totalQueries: 0, durationMs: 0 },
      };

      const spy = vi.spyOn(zoektPreCheckService, 'executeZoektPreCheck').mockResolvedValueOnce(malformedResult);

      const { mockClient } = createRecordingMockClient();
      const panelConfig = createTestPanelConfig();

      // panelEngine must not throw unhandled exception
      const result = await executePersonaPanel({
        config: panelConfig as any,
        client: mockClient,
        repository: 'ct/repo',
        headSha: 'head123',
        changedFiles: [
          { path: 'src/sec/auth.ts', patch: '@@ -1,1 +1,2 @@\n+const x = 1;\n' },
        ],
      });

      expect(result).toBeDefined();
      expect(result.arbiter.verdict).toBe('SHIP');

      spy.mockRestore();
    });
  });

  // =========================================================================
  // 3. SCHEMA VALIDATION & OVERRIDES STRESS
  // =========================================================================
  describe('3. Schema Validation & Overrides Stress', () => {

    it('3.1: rejects negative and zero max_symbols and timeoutMs', () => {
      expect(() => zoektPreCheckSchema.parse({ max_symbols: -1 })).toThrow();
      expect(() => zoektPreCheckSchema.parse({ max_symbols: 0 })).toThrow();
      expect(() => zoektPreCheckSchema.parse({ timeoutMs: -500 })).toThrow();
      expect(() => zoektPreCheckSchema.parse({ timeoutMs: 0 })).toThrow();
    });

    it('3.2: rejects non-integer floats for max_symbols and timeoutMs', () => {
      expect(() => zoektPreCheckSchema.parse({ max_symbols: 3.14 })).toThrow();
      expect(() => zoektPreCheckSchema.parse({ timeoutMs: 1234.56 })).toThrow();
    });

    it('3.3: rejects non-boolean types for analyzer toggles', () => {
      expect(() => analyzersPreCheckSchema.parse({ enabled: 'false' as any })).toThrow();
      expect(() => analyzersPreCheckSchema.parse({ linters: 0 as any })).toThrow();
      expect(() => analyzersPreCheckSchema.parse({ security: null as any })).toThrow();
      expect(() => analyzersPreCheckSchema.parse({ secrets: [true] as any })).toThrow();
    });

    it('3.4: resolvePreChecksConfig handles boolean literal pre_checks: false', () => {
      const resolved = resolvePreChecksConfig({ pre_checks: false });
      expect(resolved.enabled).toBe(false);
      expect(resolved.zoekt.enabled).toBe(false);
      expect(resolved.analyzers.enabled).toBe(false);
    });

    it('3.5: resolvePreChecksConfig handles boolean literal pre_checks: true', () => {
      const resolved = resolvePreChecksConfig({ pre_checks: true });
      expect(resolved.enabled).toBe(true);
      expect(resolved.zoekt.enabled).toBe(true);
      expect(resolved.zoekt.max_symbols).toBe(25);
      expect(resolved.analyzers.enabled).toBe(true);
    });

    it('3.6: 3-tier deep merge with selective disabling and override cascades', () => {
      const resolver = new ConfigResolver();

      const sys = {
        enabled: true,
        zoekt: { enabled: true, max_symbols: 25, timeoutMs: 5000 },
        analyzers: { enabled: true, linters: true, security: true, secrets: true },
      };
      const org = {
        zoekt: { max_symbols: 50 },
        analyzers: { secrets: false },
      };
      const repo = {
        zoekt: { enabled: false }, // disable zoekt only
      };

      const merged = (resolver as any).mergePreChecks(sys, org, repo);

      expect(merged.enabled).toBe(true);
      expect(merged.zoekt.enabled).toBe(false); // repo override
      expect(merged.zoekt.max_symbols).toBe(50); // org inherited
      expect(merged.analyzers.enabled).toBe(true); // sys inherited
      expect(merged.analyzers.secrets).toBe(false); // org override
      expect(merged.analyzers.linters).toBe(true); // sys inherited
    });

    it('3.7: 3-tier master switch repo false completely disables both subsystems', () => {
      const resolver = new ConfigResolver();

      const sys = { enabled: true, zoekt: { enabled: true }, analyzers: { enabled: true } };
      const org = { enabled: true, zoekt: { enabled: true, max_symbols: 100 } };
      const repo = { enabled: false };

      const merged = (resolver as any).mergePreChecks(sys, org, repo);

      expect(merged.enabled).toBe(false);
      expect(merged.zoekt.enabled).toBe(false);
      expect(merged.analyzers.enabled).toBe(false);
    });

    it('3.8: full resolveConfig with repo pre_checks.enabled: false against default-on org/system', () => {
      const resolver = new ConfigResolver();
      const sys = createDefaultV3Config();
      const org = {
        pre_checks: {
          enabled: true,
          zoekt: { enabled: true, max_symbols: 100 },
          analyzers: { enabled: true },
        },
      };
      const repo = {
        pre_checks: {
          enabled: false,
        },
      };

      const resolved = resolver.deepMergeConfigs(sys, org, repo);
      expect(resolved.pre_checks?.enabled).toBe(false);
      expect(resolved.pre_checks?.zoekt.enabled).toBe(false);
      expect(resolved.pre_checks?.analyzers.enabled).toBe(false);
    });
  });
});
