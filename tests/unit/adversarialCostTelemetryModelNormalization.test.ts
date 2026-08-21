import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  normalizeOpenRouterModel,
  OpenRouterClient,
} from '../../src/gateway/openRouterClient';
import {
  R4_ALLOWED_MODELS,
  personaSchema,
  providerSchema,
  ctReviewConfigV3Schema,
  ctReviewConfigV4Schema,
} from '../../src/config/schema';
import { sanitizeV3Config } from '../../src/config/configLoader';

// Load review-pipeline.js
const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipelinePath = path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js');
const pipeline = require(pipelinePath);
const {
  formatPRComment,
  isSubscriptionTransport,
  isSubscriptionLane,
  formatCost,
  countFindingsBySeverity,
} = pipeline;

describe('Adversarial Verification: Cost Telemetry & Model Normalization', () => {

  // =========================================================================
  // SCOPE 1: formatPRComment & Cost Telemetry Stress Testing
  // =========================================================================

  describe('1. formatPRComment — Mixed Panel (10 Metered + 5 Subscription Lanes)', () => {
    it('accurately calculates and formats mixed panel with 10 metered and 5 subscription lanes', () => {
      const meteredLanes = Array.from({ length: 10 }, (_, i) => ({
        personaId: `metered_persona_${i + 1}`,
        displayName: `Metered Reviewer ${i + 1}`,
        model: 'openai/gpt-5.6-luna',
        provider: 'openrouter',
        decision: 'APPROVE' as const,
        inputTokens: 1000 * (i + 1),
        outputTokens: 200 * (i + 1),
        cost: (i + 1) * 0.001, // 0.001 to 0.010 -> sum = 0.055
        findings: [],
      }));

      const subscriptionLanes = [
        {
          personaId: 'sub_fireworks',
          displayName: 'Fireworks Reviewer',
          model: 'accounts/fireworks/models/deepseek-v3',
          provider: 'fireworks',
          decision: 'APPROVE' as const,
          inputTokens: 5000,
          outputTokens: 1000,
          cost: null,
          findings: [],
        },
        {
          personaId: 'sub_ollama',
          displayName: 'Ollama Cloud Reviewer',
          model: 'ollama-cloud/qwen2.5-coder',
          provider: 'ollama-cloud',
          decision: 'APPROVE' as const,
          inputTokens: 4000,
          outputTokens: 800,
          cost: null,
          findings: [],
        },
        {
          personaId: 'sub_explicit_flag',
          displayName: 'Explicit Sub Reviewer',
          model: 'custom/model-1',
          provider: 'custom',
          decision: 'APPROVE' as const,
          inputTokens: 3000,
          outputTokens: 600,
          isSubscription: true,
          findings: [],
        },
        {
          personaId: 'sub_billing',
          displayName: 'Billing Sub Reviewer',
          model: 'custom/model-2',
          provider: 'custom',
          decision: 'APPROVE' as const,
          inputTokens: 2000,
          outputTokens: 400,
          billing: 'subscription',
          findings: [],
        },
        {
          personaId: 'sub_transport',
          displayName: 'Transport Sub Reviewer',
          model: 'custom/model-3',
          provider: 'custom',
          decision: 'APPROVE' as const,
          inputTokens: 1000,
          outputTokens: 200,
          transport: 'subscription',
          findings: [],
        },
      ];

      const allLanes = [...meteredLanes, ...subscriptionLanes];
      expect(allLanes).toHaveLength(15);

      const arbitration = {
        totalPersonas: 15,
        completedPersonas: 15,
        quorumSatisfied: true,
        verdict: 'SHIP',
        rationale: 'Clean mixed 15-persona review passed.',
        metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
      };

      const comment = formatPRComment(arbitration, allLanes, {
        prNumber: '999',
        repo: 'calltelemetry/ct-review-bot',
        headSha: 'abc123456789',
      });

      // Verify each metered lane has exact 3-decimal cost
      meteredLanes.forEach((lane, i) => {
        const expectedCost = `$${((i + 1) * 0.001).toFixed(3)}`;
        expect(comment).toContain(`| ${lane.displayName} | \`openrouter\` | \`openai/gpt-5.6-luna\` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | ${(lane.inputTokens).toLocaleString('en-US')} | ${(lane.outputTokens).toLocaleString('en-US')} | ${expectedCost} |`);
      });

      // Verify each subscription lane displays 'Subscription'
      subscriptionLanes.forEach((lane) => {
        expect(comment).toContain(`| ${lane.displayName} |`);
        expect(comment).toMatch(new RegExp(`\\| ${lane.displayName} \\| .* \\| Subscription \\|`));
      });

      // Input tokens: metered sum = 55,000, sub sum = 15,000 -> total = 70,000
      // Output tokens: metered sum = 11,000, sub sum = 3,000 -> total = 14,000
      // Metered cost sum = 0.055 -> $0.055 + Subscription
      expect(comment).toContain('| **Total** | — | — | — | 🔴 0 | 🟠 0 | 🟡 0 | **70,000** | **14,000** | **$0.055 + Subscription** |');

      // Verify markdown table formatting: every line in the table section has 10 columns (11 pipes)
      const tableLines = comment
        .split('\n')
        .filter((l: string) => l.startsWith('|') && l.endsWith('|'));
      expect(tableLines.length).toBe(18); // Header + separator + 15 rows + 1 total row
      tableLines.forEach((line: string) => {
        const pipeCount = (line.match(/\|/g) || []).length;
        expect(pipeCount).toBe(11); // 10 columns bounded by 11 pipes
      });
    });
  });

  describe('2. formatPRComment — All-Subscription Panel across Multiple Transports', () => {
    it('renders all-subscription panel across fireworks, ollama-cloud, ollama-local, direct-fireworks, subscription', () => {
      const transports = [
        { id: 'p1', name: 'Security', provider: 'fireworks', model: 'llama-3.3-70b' },
        { id: 'p2', name: 'Perf', provider: 'direct-fireworks', model: 'deepseek-v3' },
        { id: 'p3', name: 'Arch', provider: 'direct_fireworks', model: 'deepseek-r1' },
        { id: 'p4', name: 'Style', provider: 'ollama', model: 'codellama' },
        { id: 'p5', name: 'Test', provider: 'ollama-cloud', model: 'qwen-coder' },
        { id: 'p6', name: 'Docs', provider: 'ollama_cloud', model: 'mistral' },
        { id: 'p7', name: 'A11y', provider: 'ollama-local', model: 'llama3' },
        { id: 'p8', name: 'Db', provider: 'ollama_local', model: 'starcoder' },
        { id: 'p9', name: 'DevOps', provider: 'custom-sub', transport: 'subscription', model: 'custom-1' },
        { id: 'p10', name: 'I18n', provider: 'custom-billing', billing: 'subscription', model: 'custom-2' },
        { id: 'p11', name: 'Deps', provider: 'custom-flag', isSubscription: true, model: 'custom-3' },
        { id: 'p12', name: 'Licensing', provider: 'custom-cost', cost: 'Subscription', model: 'custom-4' },
      ];

      const lanes = transports.map((t, idx) => ({
        personaId: t.id,
        displayName: t.name,
        model: t.model,
        provider: t.provider,
        transport: t.transport,
        billing: t.billing,
        isSubscription: t.isSubscription,
        cost: t.cost ?? null,
        decision: 'APPROVE' as const,
        inputTokens: 1000 * (idx + 1),
        outputTokens: 100 * (idx + 1),
        findings: [],
      }));

      const arbitration = {
        totalPersonas: 12,
        completedPersonas: 12,
        quorumSatisfied: true,
        verdict: 'SHIP',
        rationale: 'Clean all-subscription review.',
        metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
      };

      const comment = formatPRComment(arbitration, lanes, {
        prNumber: '1000',
        repo: 'calltelemetry/ct-review-bot',
        headSha: 'suball123456',
      });

      // Verify each row has Subscription
      lanes.forEach((lane) => {
        expect(comment).toMatch(new RegExp(`\\| ${lane.displayName} \\| .* \\| Subscription \\|`));
      });

      // Total row must be **Subscription** (not $0.000, not —, not $X.XXX + Subscription)
      expect(comment).toContain('| **Total** | — | — | — | 🔴 0 | 🟠 0 | 🟡 0 | **78,000** | **7,800** | **Subscription** |');
      expect(comment).not.toContain('$');
    });
  });

  describe('3. formatPRComment — Safe Fail-Closed Total with Unknown Cost Lane', () => {
    it('fails closed to em dash total when 1 unknown cost lane exists amongst 10 valid metered lanes', () => {
      const lanes = Array.from({ length: 10 }, (_, i) => ({
        personaId: `lane_${i + 1}`,
        displayName: `Metered Lane ${i + 1}`,
        model: 'openai/gpt-5.6-luna',
        provider: 'openrouter',
        decision: 'APPROVE' as const,
        inputTokens: 500,
        outputTokens: 100,
        cost: 0.005,
        findings: [],
      }));

      // Add 1 lane with unknown cost (openrouter provider with cost = null / undefined)
      lanes.push({
        personaId: 'lane_unknown',
        displayName: 'Unknown Cost Lane',
        model: 'openrouter/auto',
        provider: 'openrouter',
        decision: 'APPROVE' as const,
        inputTokens: 500,
        outputTokens: 100,
        cost: null,
        findings: [],
      });

      const arbitration = {
        totalPersonas: 11,
        completedPersonas: 11,
        quorumSatisfied: true,
        verdict: 'SHIP',
        rationale: 'Clean review with 1 unknown cost lane.',
        metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
      };

      const comment = formatPRComment(arbitration, lanes, {
        prNumber: '1001',
        repo: 'calltelemetry/ct-review-bot',
        headSha: 'unk12345678',
      });

      // Known lanes have $0.005
      expect(comment).toContain('| Metered Lane 1 | `openrouter` | `openai/gpt-5.6-luna` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | 500 | 100 | $0.005 |');
      // Unknown lane has —
      expect(comment).toContain('| Unknown Cost Lane | `openrouter` | `openrouter/auto` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | 500 | 100 | — |');
      // Total cost MUST fail closed to — (NOT $0.050 partial sum)
      expect(comment).toContain('| **Total** | — | — | — | 🔴 0 | 🟠 0 | 🟡 0 | **5,500** | **1,100** | — |');
      expect(comment).not.toContain('**$0.050**');
    });

    it('fails closed to em dash total when 1 unknown cost lane exists amongst mixed metered and subscription lanes', () => {
      const lanes = [
        { personaId: 'm1', displayName: 'Metered 1', model: 'm', provider: 'openrouter', decision: 'APPROVE' as const, cost: 0.005, findings: [] },
        { personaId: 's1', displayName: 'Sub 1', model: 'm', provider: 'fireworks', decision: 'APPROVE' as const, cost: null, findings: [] },
        { personaId: 'u1', displayName: 'Unknown 1', model: 'm', provider: 'openrouter', decision: 'APPROVE' as const, cost: undefined, findings: [] },
      ];

      const arbitration = {
        totalPersonas: 3,
        completedPersonas: 3,
        quorumSatisfied: true,
        verdict: 'SHIP',
        rationale: 'Mixed with unknown.',
        metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
      };

      const comment = formatPRComment(arbitration, lanes, { prNumber: '1002', repo: 'calltelemetry/ct-review-bot', headSha: 'unkmixed1' });
      expect(comment).toContain('| Metered 1 | `openrouter` | `m` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | — | — | $0.005 |');
      expect(comment).toContain('| Sub 1 | `fireworks` | `m` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | — | — | Subscription |');
      expect(comment).toContain('| Unknown 1 | `openrouter` | `m` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | — | — | — |');
      expect(comment).toContain('| **Total** | — | — | — | 🔴 0 | 🟠 0 | 🟡 0 | — | — | — |');
    });
  });

  describe('4. formatCost — Extreme & Hostile Costs Stress Testing', () => {
    it('handles negative numbers as invalid costs returning em dash', () => {
      expect(formatCost(-0.001)).toBe('—');
      expect(formatCost(-100)).toBe('—');
      expect(formatCost('-5.50')).toBe('—');
      expect(formatCost(-0.000001)).toBe('—');
    });

    it('handles non-numeric strings safely as em dash', () => {
      expect(formatCost('free')).toBe('—');
      expect(formatCost('[object Object]')).toBe('—');
      expect(formatCost('NaN')).toBe('—');
      expect(formatCost('undefined')).toBe('—');
      expect(formatCost('null')).toBe('—');
      expect(formatCost('{}')).toBe('—');
      expect(formatCost('true')).toBe('—');
      expect(formatCost('false')).toBe('—');
    });

    it('handles NaN, Infinity, -Infinity without leaking or throwing', () => {
      expect(formatCost(NaN)).toBe('—');
      expect(formatCost(Infinity)).toBe('—');
      expect(formatCost(-Infinity)).toBe('—');
      expect(formatCost(Number.POSITIVE_INFINITY)).toBe('—');
      expect(formatCost(Number.NEGATIVE_INFINITY)).toBe('—');
    });

    it('handles massive numbers and prevents exponential notation leaks', () => {
      expect(formatCost(1e25)).toBe('—');
      expect(formatCost(1e21)).toBe('—');
      expect(formatCost(1e308)).toBe('—');
      expect(formatCost(Number.MAX_VALUE)).toBe('—');
    });

    it('formats boundary numbers with correct decimal precision', () => {
      expect(formatCost(0)).toBe('$0.000');
      expect(formatCost(0.0004)).toBe('$0.000');
      expect(formatCost(0.0006)).toBe('$0.001');
      expect(formatCost(0.0074)).toBe('$0.007');
      expect(formatCost(0.0076)).toBe('$0.008');
      expect(formatCost(999.999)).toBe('$999.999');
    });

    it('handles hostile cost values inside formatPRComment without crashing or corrupting output', () => {
      const hostileLanes = [
        { personaId: 'p1', displayName: 'Neg Lane', model: 'm1', provider: 'openrouter', decision: 'APPROVE' as const, cost: -50, findings: [] },
        { personaId: 'p2', displayName: 'NaN Lane', model: 'm2', provider: 'openrouter', decision: 'APPROVE' as const, cost: NaN, findings: [] },
        { personaId: 'p3', displayName: 'Inf Lane', model: 'm3', provider: 'openrouter', decision: 'APPROVE' as const, cost: Infinity, findings: [] },
        { personaId: 'p4', displayName: 'Huge Lane', model: 'm4', provider: 'openrouter', decision: 'APPROVE' as const, cost: 1e25, findings: [] },
        { personaId: 'p5', displayName: 'Garbage Lane', model: 'm5', provider: 'openrouter', decision: 'APPROVE' as const, cost: '<script>alert(1)</script>', findings: [] },
      ];

      const arbitration = {
        totalPersonas: 5,
        completedPersonas: 5,
        quorumSatisfied: true,
        verdict: 'SHIP',
        rationale: 'Hostile costs handled.',
        metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
      };

      const comment = formatPRComment(arbitration, hostileLanes, { prNumber: '1003', repo: 'calltelemetry/ct-review-bot', headSha: 'hostile1' });

      // Verify each row gets safe '—' in cost column
      hostileLanes.forEach((lane) => {
        expect(comment).toContain(`| ${lane.displayName} | \`openrouter\` | \`${lane.model}\` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | — | — | — |`);
      });

      // Total row is safe '—'
      expect(comment).toContain('| **Total** | — | — | — | 🔴 0 | 🟠 0 | 🟡 0 | — | — | — |');
      expect(comment).not.toContain('e+25');
      expect(comment).not.toContain('$-50');
    });
  });

  describe('5. Hostile Character Injection in Persona DisplayName, Provider, Model Names', () => {
    it('escapes pipes, backticks, HTML tags, and newlines in markdown table cells', () => {
      const injectionLanes = [
        {
          personaId: 'p_pipe',
          displayName: 'Specialist | Admin | Exploit',
          model: 'model|pipe|hazard',
          provider: 'provider|pipe',
          decision: 'APPROVE' as const,
          cost: 0.005,
          findings: [],
        },
        {
          personaId: 'p_backtick',
          displayName: 'Specialist `code` injection',
          model: 'model`code`injection',
          provider: 'provider`code`',
          decision: 'APPROVE' as const,
          cost: 0.005,
          findings: [],
        },
        {
          personaId: 'p_html',
          displayName: '<script>alert("xss")</script> <b>Persona</b>',
          model: '<img src=x onerror=alert(1)>',
          provider: '<details open><summary>spoof</summary>',
          decision: 'APPROVE' as const,
          cost: 0.005,
          findings: [],
        },
        {
          personaId: 'p_newlines',
          displayName: 'Multiline\n\rPersona\nName',
          model: 'model\nwith\nnewlines',
          provider: 'provider\r\nwith\r\nnewlines',
          decision: 'APPROVE' as const,
          cost: 0.005,
          findings: [],
        },
      ];

      const arbitration = {
        totalPersonas: 4,
        completedPersonas: 4,
        quorumSatisfied: true,
        verdict: 'SHIP',
        rationale: 'Injection testing.',
        metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
      };

      const comment = formatPRComment(arbitration, injectionLanes, { prNumber: '1004', repo: 'calltelemetry/ct-review-bot', headSha: 'inject1' });

      // Verify pipes are escaped in table cells
      expect(comment).toContain('Specialist \\| Admin \\| Exploit');
      expect(comment).toContain('provider\\|pipe');
      expect(comment).toContain('model\\|pipe\\|hazard');

      // Verify backticks are converted to single quotes
      expect(comment).toContain("Specialist 'code' injection");
      expect(comment).toContain("model'code'injection");
      expect(comment).toContain("provider'code'");

      // Verify multiline newlines are collapsed to spaces so table rows are not split
      expect(comment).toContain('Multiline Persona Name');

      // Verify that every line of the table has exactly 11 pipes (10 columns)
      const tableLines = comment
        .split('\n')
        .filter((l: string) => l.startsWith('|') && l.endsWith('|'));
      expect(tableLines.length).toBe(7); // Header + separator + 4 rows + 1 total row
      tableLines.forEach((line: string, idx: number) => {
        const pipeCount = (line.match(/(?<!\\)\|/g) || []).length; // unescaped pipes
        expect(pipeCount, `Line ${idx} unescaped pipe count must be 11: ${line}`).toBe(11);
      });
    });
  });

  // =========================================================================
  // SCOPE 2: OpenRouter Model Normalization & Schema Validation
  // =========================================================================

  describe('6. OpenRouter Model Normalization in openRouterClient.ts', () => {
    it('maps all variations of 5.6 Luna High to canonical openai/gpt-5.6-luna', () => {
      // Required variations in scope:
      expect(normalizeOpenRouterModel('openrouter/5.6-luna-high')).toBe('openai/gpt-5.6-luna');
      expect(normalizeOpenRouterModel('5.6-luna-high')).toBe('openai/gpt-5.6-luna');
      expect(normalizeOpenRouterModel('openrouter/openai/gpt-5.6-luna')).toBe('openai/gpt-5.6-luna');
      expect(normalizeOpenRouterModel('openai/gpt-5.6-luna')).toBe('openai/gpt-5.6-luna');

      // Leading/trailing whitespace tolerance
      expect(normalizeOpenRouterModel('  openrouter/5.6-luna-high  ')).toBe('openai/gpt-5.6-luna');
      expect(normalizeOpenRouterModel('  5.6-luna-high  ')).toBe('openai/gpt-5.6-luna');
      expect(normalizeOpenRouterModel('  openrouter/openai/gpt-5.6-luna  ')).toBe('openai/gpt-5.6-luna');
      expect(normalizeOpenRouterModel('  openai/gpt-5.6-luna  ')).toBe('openai/gpt-5.6-luna');
    });

    it('retains openrouter/auto and normalizes legacy router aliases correctly', () => {
      expect(normalizeOpenRouterModel('openrouter/auto')).toBe('openrouter/auto');
      expect(normalizeOpenRouterModel('codex/gpt-5.6-sol-high')).toBe('openai/gpt-5.6-sol');
      expect(normalizeOpenRouterModel('codex-gateway/gpt-5.6-sol-high')).toBe('openai/gpt-5.6-sol');
      expect(normalizeOpenRouterModel('grok-cli/grok-4.5')).toBe('x-ai/grok-4.5');
      expect(normalizeOpenRouterModel('claude-opus-4-8')).toBe('anthropic/claude-opus-4.8');
      expect(normalizeOpenRouterModel('claude/claude-opus-4-8')).toBe('anthropic/claude-opus-4.8');
      expect(normalizeOpenRouterModel('agy/claude-opus-4-6-thinking')).toBe('anthropic/claude-opus-4.8');
      expect(normalizeOpenRouterModel('opencode-go/glm-5.2')).toBe('z-ai/glm-5.2');
      expect(normalizeOpenRouterModel('synthetic/glm-5.2')).toBe('z-ai/glm-5.2');
      expect(normalizeOpenRouterModel('synthetic-new/glm-5.2-high')).toBe('z-ai/glm-5.2');
      expect(normalizeOpenRouterModel('glm-5.2')).toBe('z-ai/glm-5.2');
    });

    it('strips openrouter/ prefix for arbitrary valid openrouter model paths', () => {
      expect(normalizeOpenRouterModel('openrouter/anthropic/claude-3.7-sonnet')).toBe('anthropic/claude-3.7-sonnet');
      expect(normalizeOpenRouterModel('openrouter/deepseek/deepseek-r1')).toBe('deepseek/deepseek-r1');
      expect(normalizeOpenRouterModel('openrouter/google/gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
      expect(normalizeOpenRouterModel('openrouter/qwen/qwen-2.5-72b-instruct')).toBe('qwen/qwen-2.5-72b-instruct');
    });

    it('calculates luna token cost accurately inside OpenRouterClient.complete', async () => {
      const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        model: 'openai/gpt-5.6-luna',
        choices: [{ message: { role: 'assistant', content: 'APPROVE' } }],
        usage: { prompt_tokens: 10000, completion_tokens: 2000, total_tokens: 12000 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

      const client = new OpenRouterClient({
        baseUrl: 'https://openrouter.test/api/v1',
        apiKey: 'test-openrouter-key',
        fetchImplementation,
      });

      const res = await client.complete({
        model: 'openrouter/5.6-luna-high',
        messages: [{ role: 'user', content: 'review PR' }],
        timeoutMs: 5000,
      });

      expect(res.model).toBe('openai/gpt-5.6-luna');
      // Luna pricing: prompt = $0.002/1k, completion = $0.006/1k
      // 10,000 * 0.000002 = 0.02
      // 2,000 * 0.000006 = 0.012
      // total = 0.032 USD
      expect(res.costUSD).toBe(0.032);
    });
  });

  describe('7. Schema Validation & R4_ALLOWED_MODELS in schema.ts & configLoader.ts', () => {
    it('contains all canonical 5.6 Luna High model aliases in R4_ALLOWED_MODELS', () => {
      expect(R4_ALLOWED_MODELS).toContain('openrouter/5.6-luna-high');
      expect(R4_ALLOWED_MODELS).toContain('openai/gpt-5.6-luna');
      expect(R4_ALLOWED_MODELS).toContain('openrouter/openai/gpt-5.6-luna');
    });

    it('validates persona model override with 5.6 Luna High aliases in personaSchema', () => {
      const lunaModels = [
        'openrouter/5.6-luna-high',
        'openai/gpt-5.6-luna',
        'openrouter/openai/gpt-5.6-luna',
        '5.6-luna-high',
      ];

      lunaModels.forEach((model) => {
        const persona = {
          id: 'sec-lane',
          enabled: true,
          required: true,
          charter: 'builtin:security',
          paths: ['**'],
          providers: ['openrouter'],
          model,
        };
        const result = personaSchema.safeParse(persona);
        expect(result.success, `personaSchema should accept model '${model}'`).toBe(true);
      });
    });

    it('validates full V3 and V4 configuration with 5.6 Luna High personas and provider settings', () => {
      const v3Config = {
        version: 3,
        profile: 'balanced',
        quorum: 1,
        personas: [
          {
            id: 'sec-lane',
            enabled: true,
            required: true,
            charter: 'builtin:security',
            paths: ['**'],
            providers: ['openrouter'],
            model: 'openrouter/5.6-luna-high',
          },
          {
            id: 'arch-lane',
            enabled: true,
            required: false,
            charter: 'builtin:constitutional-goals',
            paths: ['**'],
            providers: ['openrouter'],
            model: 'openai/gpt-5.6-luna',
          },
        ],
        reviewers: {
          execution: 'personas',
          fallback: 'ordered',
          overall_timeout_s: 300,
          providers: [
            {
              id: 'openrouter',
              enabled: true,
              model: 'openrouter/5.6-luna-high',
              effort: 'high',
              review_timeout_s: 120,
              arbiter_timeout_s: 120,
            },
          ],
          arbiter: { order: ['openrouter'] },
        },
      };

      const sanitized = sanitizeV3Config(v3Config);
      const v3Result = ctReviewConfigV3Schema.safeParse(sanitized);
      expect(v3Result.success).toBe(true);

      const v4Result = ctReviewConfigV4Schema.safeParse({
        ...sanitized,
        version: 4,
        submodules: {},
        limits: {},
      });
      expect(v4Result.success).toBe(true);
    });
  });
});
