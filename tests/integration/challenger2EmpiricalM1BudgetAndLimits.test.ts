import { describe, it, expect } from 'vitest';
import path from 'path';
import { reviewLimitsSchema, ctReviewConfigV4Schema } from '../../src/config/schema';
import { parseAndValidateConfig, ConfigValidationError } from '../../src/config/configLoader';
import {
  createPiWorkspacePlugin,
  DiffInputFile,
} from '../../src/sandbox/piWorkspacePlugin';
import {
  calculateSafeDiffCapacity,
  getStaticModelMetadata,
  resolveModelMetadata,
  clearModelMetadataCache,
} from '../../src/gateway/openRouterClient';

const TELECOM_WORKSPACE = path.resolve('tests/fixtures/workspaces/telecom-call-engine');

describe('Challenger 2 Empirical Verification: Config Schema & Sandboxed Plugin Dynamic Budget Integration', () => {

  describe('1. reviewLimitsSchema Empirical Boundary & Ceiling Stress Tests', () => {
    it('1.1 parses and validates default limit values', () => {
      const parsed = reviewLimitsSchema.parse({});
      expect(parsed.max_files).toBe(1000);
      expect(parsed.max_diff_bytes).toBe(2_000_000);
      expect(parsed.max_prompt_tokens).toBe(128_000);
      expect(parsed.max_completion_tokens).toBe(8_000);
      expect(parsed.max_cost_usd).toBe(5);
      expect(parsed.max_turns).toBe(20);
      expect(parsed.max_concurrency).toBe(12);
    });

    it('1.2 accepts max_prompt_tokens at exactly 4,000,000 (4M) tokens', () => {
      const parsed = reviewLimitsSchema.parse({
        max_prompt_tokens: 4_000_000,
      });
      expect(parsed.max_prompt_tokens).toBe(4_000_000);
    });

    it('1.3 accepts max_diff_bytes at exactly 10,000,000 (10MB) bytes', () => {
      const parsed = reviewLimitsSchema.parse({
        max_diff_bytes: 10_000_000,
      });
      expect(parsed.max_diff_bytes).toBe(10_000_000);
    });

    it('1.4 accepts combined 4M prompt tokens, 10MB diff bytes, and 128k completion tokens simultaneously', () => {
      const parsed = reviewLimitsSchema.parse({
        max_files: 5000,
        max_diff_bytes: 10_000_000,
        max_prompt_tokens: 4_000_000,
        max_completion_tokens: 128_000,
        max_cost_usd: 100,
        max_turns: 20,
        max_concurrency: 32,
      });
      expect(parsed.max_files).toBe(5000);
      expect(parsed.max_diff_bytes).toBe(10_000_000);
      expect(parsed.max_prompt_tokens).toBe(4_000_000);
      expect(parsed.max_completion_tokens).toBe(128_000);
      expect(parsed.max_cost_usd).toBe(100);
      expect(parsed.max_turns).toBe(20);
      expect(parsed.max_concurrency).toBe(32);
    });

    it('1.5 rejects max_prompt_tokens exceeding 4,000,000 (e.g. 4,000,001)', () => {
      const result = reviewLimitsSchema.safeParse({
        max_prompt_tokens: 4_000_001,
      });
      expect(result.success).toBe(false);
    });

    it('1.6 rejects max_diff_bytes exceeding 10,000,000 (e.g. 10,000,001)', () => {
      const result = reviewLimitsSchema.safeParse({
        max_diff_bytes: 10_000_001,
      });
      expect(result.success).toBe(false);
    });

    it('1.7 rejects non-positive, negative, and float values for tokens and bytes', () => {
      expect(reviewLimitsSchema.safeParse({ max_prompt_tokens: 0 }).success).toBe(false);
      expect(reviewLimitsSchema.safeParse({ max_prompt_tokens: -100 }).success).toBe(false);
      expect(reviewLimitsSchema.safeParse({ max_prompt_tokens: 128000.5 }).success).toBe(false);

      expect(reviewLimitsSchema.safeParse({ max_diff_bytes: 0 }).success).toBe(false);
      expect(reviewLimitsSchema.safeParse({ max_diff_bytes: -500 }).success).toBe(false);
      expect(reviewLimitsSchema.safeParse({ max_diff_bytes: 1000000.75 }).success).toBe(false);
    });

    it('1.8 validates 4M prompt tokens and 10MB diff bytes via ctReviewConfigV4Schema and parseAndValidateConfig', () => {
      const validV4Yaml = `
version: 4
quorum: 1
personas:
  - id: sec
    enabled: true
    required: true
    charter: builtin:security
    paths: ["*"]
    providers: [synthetic]
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 300
  providers:
    - id: synthetic
      enabled: true
      model: google/gemini-3.7-flash:high
      effort: high
      review_timeout_s: 60
      arbiter_timeout_s: 60
  arbiter:
    order: [synthetic]
limits:
  max_prompt_tokens: 4000000
  max_diff_bytes: 10000000
  max_completion_tokens: 128000
  max_cost_usd: 50
`;
      const config = parseAndValidateConfig(validV4Yaml);
      expect(config.version).toBe(4);
      expect((config as any).limits.max_prompt_tokens).toBe(4_000_000);
      expect((config as any).limits.max_diff_bytes).toBe(10_000_000);
      expect((config as any).limits.max_completion_tokens).toBe(128_000);
      expect((config as any).limits.max_cost_usd).toBe(50);
    });
  });

  describe('2. piWorkspacePlugin Dynamic Model Capacity Initialization (128k to 1M+ Tokens)', () => {
    it('2.1 initializes default plugin with 410,400 diff budget chars (128k token safe baseline)', () => {
      const plugin = createPiWorkspacePlugin({
        workspaceRoot: TELECOM_WORKSPACE,
      });

      // Submit a 30,000 char diff (larger than legacy 24k cap)
      const patch30k = '--- a/sip_signaling_service/src/callRouter.ts\n+++ b/sip_signaling_service/src/callRouter.ts\n@@ -1,1 +1,500 @@\n' +
        '+'.repeat(30000);
      const result = plugin.applyDiffBudget([{ path: 'sip_signaling_service/src/callRouter.ts', patch: patch30k }]);

      expect(result.budgetLimitChars).toBe(410_400);
      expect(result.includedTotalChars).toBe(patch30k.length);
      expect(result.truncatedFilesCount).toBe(0);
      expect(result.omittedFilesCount).toBe(0);
      expect(result.omissionNoticeHeader).toBeUndefined();
    });

    it('2.2 dynamically calculates safe diff budget for 128k models (DeepSeek V4 Flash, Luna, Qwen, GPT-4o)', () => {
      const models128k = [
        'deepseek/deepseek-v4-flash-0731:low',
        'deepseek/deepseek-v4-flash-0731:high',
        'openrouter/5.6-luna-high',
        'openai/gpt-5.6-luna',
        'qwen/qwen-3.8-27b:high',
        'openai/gpt-4o',
      ];

      for (const modelId of models128k) {
        const plugin = createPiWorkspacePlugin({
          workspaceRoot: TELECOM_WORKSPACE,
          model: modelId,
        });

        // (128,000 - 4,000 - 16,000) * 3.8 = 410,400 chars
        const result = plugin.applyDiffBudget([]);
        expect(result.budgetLimitChars, `Model ${modelId} diff budget`).toBe(410_400);
      }
    });

    it('2.3 dynamically calculates safe diff budget for 200k models (Claude 3.7 Sonnet, Claude Opus 4.8, Kimi K2.6/K3)', () => {
      const models200k = [
        'anthropic/claude-3.7-sonnet',
        'anthropic/claude-opus-4.8',
        'claude-opus-4-8',
        'moonshot/kimi-k3',
      ];

      for (const modelId of models200k) {
        const plugin = createPiWorkspacePlugin({
          workspaceRoot: TELECOM_WORKSPACE,
          model: modelId,
        });

        // (200,000 - 4,000 - 16,000) * 3.8 = 180,000 * 3.8 = 684,000 chars
        const result = plugin.applyDiffBudget([]);
        expect(result.budgetLimitChars, `Model ${modelId} diff budget`).toBe(684_000);
      }
    });

    it('2.4 dynamically calculates safe diff budget for 1M models (Google Gemini 3.7 Flash, 2.5 Flash)', () => {
      const models1M = [
        'google/gemini-3.7-flash:high',
        'google/gemini-3.7-flash',
        'google/gemini-2.5-flash',
      ];

      for (const modelId of models1M) {
        const plugin = createPiWorkspacePlugin({
          workspaceRoot: TELECOM_WORKSPACE,
          model: modelId,
        });

        // (1,048,576 - 4,000 - 16,000) * 3.8 = 1,028,576 * 3.8 = 3,908,588 chars
        const result = plugin.applyDiffBudget([]);
        expect(result.budgetLimitChars, `Model ${modelId} diff budget`).toBe(3_908_588);
      }
    });

    it('2.5 dynamically calculates safe diff budget for 2M models (Google Gemini 2.5 Pro, 1.5 Pro)', () => {
      const models2M = [
        'google/gemini-2.5-pro',
        'google/gemini-1.5-pro',
      ];

      for (const modelId of models2M) {
        const plugin = createPiWorkspacePlugin({
          workspaceRoot: TELECOM_WORKSPACE,
          model: modelId,
        });

        // (2,097,152 - 4,000 - 16,000) * 3.8 = 2,077,152 * 3.8 = 7,893,177 chars
        const result = plugin.applyDiffBudget([]);
        expect(result.budgetLimitChars, `Model ${modelId} diff budget`).toBe(7_893_177);
      }
    });

    it('2.6 allows explicit diffBudgetLimitChars override when specified', () => {
      const plugin = createPiWorkspacePlugin({
        workspaceRoot: TELECOM_WORKSPACE,
        model: 'google/gemini-3.7-flash:high',
        diffBudgetLimitChars: 500_000,
        fileBudgetLimitChars: 100_000,
      });

      const result = plugin.applyDiffBudget([]);
      expect(result.budgetLimitChars).toBe(500_000);
    });
  });

  describe('3. Empirical Elimination of Artificial 24k Character Diff Slicing', () => {
    it('3.1 ingests 30,000 character single file diff without artificial 24k truncation', () => {
      const plugin = createPiWorkspacePlugin({
        workspaceRoot: TELECOM_WORKSPACE,
        model: 'deepseek/deepseek-v4-flash-0731:low',
      });

      const patch30k = '--- a/sip_signaling_service/src/callRouter.ts\n+++ b/sip_signaling_service/src/callRouter.ts\n@@ -1,1 +1,750 @@\n' +
        Array.from({ length: 750 }, (_, i) => `+const routeLineRule_${i} = 'call-route-rule-extended-string-identifier-${i}';\n`).join('');

      expect(patch30k.length).toBeGreaterThan(30_000);
      expect(patch30k.length).toBeLessThan(128_000);

      const result = plugin.applyDiffBudget([{ path: 'sip_signaling_service/src/callRouter.ts', patch: patch30k }]);

      expect(result.includedTotalChars).toBe(patch30k.length);
      expect(result.truncatedFilesCount).toBe(0);
      expect(result.omittedFilesCount).toBe(0);
      expect(result.omissionNoticeHeader).toBeUndefined();
      expect(result.formattedDiff).not.toContain('... [Diff truncated:');
      expect(result.formattedDiff).toContain(patch30k);
    });

    it('3.2 ingests 100,000 character multi-file standard PR diff without truncation', () => {
      const plugin = createPiWorkspacePlugin({
        workspaceRoot: TELECOM_WORKSPACE,
        model: 'deepseek/deepseek-v4-flash-0731:low', // 410,400 char capacity
      });

      // 4 files with ~25k chars each = ~100k total
      const files: DiffInputFile[] = [
        {
          path: 'sip_signaling_service/src/sipStateMachine.ts',
          patch: '--- a/sip_signaling_service/src/sipStateMachine.ts\n+++ b/sip_signaling_service/src/sipStateMachine.ts\n@@ -1,1 +1,400 @@\n' +
            Array.from({ length: 400 }, (_, i) => `+function transitionState_${i}() { return 'STATE_EXTENDED_TRANSITION_${i}'; }\n`).join(''),
        },
        {
          path: 'rtp_media_gateway/src/portAllocator.ts',
          patch: '--- a/rtp_media_gateway/src/portAllocator.ts\n+++ b/rtp_media_gateway/src/portAllocator.ts\n@@ -1,1 +1,400 @@\n' +
            Array.from({ length: 400 }, (_, i) => `+function allocateMediaPort_${i}() { return 10000 + ${i} * 2; }\n`).join(''),
        },
        {
          path: 'cdr_pipeline/src/tariffRatingEngine.ts',
          patch: '--- a/cdr_pipeline/src/tariffRatingEngine.ts\n+++ b/cdr_pipeline/src/tariffRatingEngine.ts\n@@ -1,1 +1,400 @@\n' +
            Array.from({ length: 400 }, (_, i) => `+function rateCallEvent_${i}() { return 0.05 * ${i} + 1.25; }\n`).join(''),
        },
        {
          path: 'pbx_device_manager/src/trunkAllocator.ts',
          patch: '--- a/pbx_device_manager/src/trunkAllocator.ts\n+++ b/pbx_device_manager/src/trunkAllocator.ts\n@@ -1,1 +1,400 @@\n' +
            Array.from({ length: 400 }, (_, i) => `+function assignTrunkChannel_${i}() { return 'TRUNK_GROUP_${i}'; }\n`).join(''),
        },
      ];

      const totalChars = files.reduce((acc, f) => acc + (f.patch?.length || 0), 0);
      expect(totalChars).toBeGreaterThan(80_000);
      expect(totalChars).toBeLessThan(410_400);

      const result = plugin.applyDiffBudget(files);

      expect(result.includedFilesCount).toBe(4);
      expect(result.truncatedFilesCount).toBe(0);
      expect(result.omittedFilesCount).toBe(0);
      expect(result.includedTotalChars).toBe(totalChars);
      expect(result.omissionNoticeHeader).toBeUndefined();
      expect(result.formattedDiff).not.toContain('... [Diff truncated:');
    });

    it('3.3 ingests 500,000 character PR diff under 1M token model (Gemini 3.7 Flash) with 100% fidelity', () => {
      const plugin = createPiWorkspacePlugin({
        workspaceRoot: TELECOM_WORKSPACE,
        model: 'google/gemini-3.7-flash:high', // 3,908,588 char capacity
        fileBudgetLimitChars: 128_000,
      });

      // 6 files with ~85k chars each = ~510k total
      const files: DiffInputFile[] = Array.from({ length: 6 }, (_, fIdx) => ({
        path: `cdr_pipeline/src/module_${fIdx}.ts`,
        patch: `--- a/cdr_pipeline/src/module_${fIdx}.ts\n+++ b/cdr_pipeline/src/module_${fIdx}.ts\n@@ -1,1 +1,1200 @@\n` +
          Array.from({ length: 1200 }, (_, lIdx) => `+export const record_${fIdx}_${lIdx} = 'data_value_extended_payload_constant_${lIdx}';\n`).join(''),
      }));

      const totalChars = files.reduce((acc, f) => acc + (f.patch?.length || 0), 0);
      expect(totalChars).toBeGreaterThan(450_000);
      expect(totalChars).toBeLessThan(3_908_588);

      const result = plugin.applyDiffBudget(files);

      expect(result.includedFilesCount).toBe(6);
      expect(result.truncatedFilesCount).toBe(0);
      expect(result.omittedFilesCount).toBe(0);
      expect(result.includedTotalChars).toBe(totalChars);
      expect(result.omissionNoticeHeader).toBeUndefined();
    });

    it('3.4 truncates only when genuinely exceeding the model dynamic budget', () => {
      const plugin = createPiWorkspacePlugin({
        workspaceRoot: TELECOM_WORKSPACE,
        model: 'deepseek/deepseek-v4-flash-0731:low', // 410,400 budget limit
        fileBudgetLimitChars: 128_000,
      });

      // Create 5 files with ~100k chars each = ~500k total (exceeds 410,400)
      const files: DiffInputFile[] = Array.from({ length: 5 }, (_, fIdx) => ({
        path: `sip_signaling_service/src/overflow_${fIdx}.ts`,
        patch: `--- a/sip_signaling_service/src/overflow_${fIdx}.ts\n+++ b/sip_signaling_service/src/overflow_${fIdx}.ts\n@@ -1,1 +1,1500 @@\n` +
          Array.from({ length: 1500 }, (_, lIdx) => `+const overflowLine_${fIdx}_${lIdx} = 'value_extended_long_payload_string_${lIdx}';\n`).join(''),
      }));

      const totalChars = files.reduce((acc, f) => acc + (f.patch?.length || 0), 0);
      expect(totalChars).toBeGreaterThan(410_400);

      const result = plugin.applyDiffBudget(files);

      expect(result.includedTotalChars).toBeLessThanOrEqual(410_400);
      expect(result.truncatedFilesCount + result.omittedFilesCount).toBeGreaterThan(0);
      expect(result.omissionNoticeHeader).toBeDefined();
      expect(result.omissionNoticeHeader).toContain('[DIFF_BUDGET_NOTICE]');
      expect(result.omissionNoticeHeader).toContain('410,400');
    });
  });

  describe('4. Sandboxed Tool Execution with Dynamic Model Settings', () => {
    it('4.1 executes sandboxed tools with dynamic model configuration', async () => {
      const plugin = createPiWorkspacePlugin({
        workspaceRoot: TELECOM_WORKSPACE,
        model: 'deepseek/deepseek-v4-flash-0731:low',
        modelCostPer1kPrompt: 0.00014,
        modelCostPer1kCompletion: 0.00028,
      });

      const readResp = await plugin.executeTool('security', 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: 1, endLine: 30 },
      });
      expect(readResp.status).toBe('success');
      expect(readResp.output).toContain('DialPlanRule');

      const searchResp = await plugin.executeTool('security', 1, {
        name: 'pi.code.search',
        arguments: { query: 'DialPlanRule' },
      });
      expect(searchResp.status).toBe('success');
      expect(searchResp.output).toContain('callRouter.ts');

      const metrics = plugin.getSessionMetrics('security');
      expect(metrics.totalToolCalls).toBe(2);
      expect(metrics.successfulToolCalls).toBe(2);
      expect(metrics.totalCostUSD).toBeGreaterThan(0);
    });
  });
});
