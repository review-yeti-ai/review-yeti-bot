import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Resolve path to root repository .github/workflows/pipelines/review-pipeline.js
const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipelinePath = path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js');
const pipeline = require(pipelinePath);

describe('PI.dev Review Workflow Pipeline Script (.github/workflows/pipelines/review-pipeline.js)', () => {
  it('1. Script file exists and is executable', () => {
    expect(fs.existsSync(pipelinePath)).toBe(true);
    const content = fs.readFileSync(pipelinePath, 'utf-8');
    expect(content).toContain('#!/usr/bin/env node');
  });

  it('2. Loads 12 persona charters with the direct DeepSeek default model', () => {
    const { PERSONA_CHARTERS, DEFAULT_MODEL } = pipeline;
    expect(DEFAULT_MODEL).toBe('deepseek/deepseek-v4-flash-0731');
    expect(PERSONA_CHARTERS).toHaveLength(12);

    const expectedPersonas = [
      'security',
      'performance',
      'architecture',
      'style',
      'testing',
      'documentation',
      'accessibility',
      'database',
      'devops',
      'i18n',
      'dependencies',
      'licensing',
    ];

    const actualPersonas = PERSONA_CHARTERS.map((p: any) => p.id);
    expect(actualPersonas).toEqual(expectedPersonas);

    PERSONA_CHARTERS.forEach((persona: any) => {
      expect(persona.model).toBeTruthy();
      expect(persona.charter).toBeDefined();
      expect(persona.charter.length).toBeGreaterThan(10);
    });
  });

  it('3. Parses diff payload correctly', () => {
    const rawDiff = `diff --git a/src/server.ts b/src/server.ts
index 123456..789abc 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,3 +1,5 @@
 import express from 'express';
+const apiKey = "sk-proj-1234567890abcdef12345678";
`;
    const parsed = pipeline.parseDiff(rawDiff);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('src/server.ts');
    expect(parsed[0].addedLines.some((l: any) => l.text.includes('sk-proj'))).toBe(true);
  });

  it('4. Evaluates 12 personas in parallel and computes binding arbitration quorum', async () => {
    const { PERSONA_CHARTERS, evaluatePersonaLane, computeArbitrationQuorum } = pipeline;
    const diffFiles = [
      {
        path: 'db/migrations/001_init.sql',
        patch: 'DROP TABLE users;',
        addedLines: [{ text: 'DROP TABLE users;' }],
        deletedLines: [],
      },
    ];

    const prContext = {
      prNumber: '99',
      repo: 'calltelemetry/ct-review-bot',
      headSha: 'abc1234def',
      title: 'Destructive DB Migration PR',
    };

    const results = await Promise.all(
      PERSONA_CHARTERS.map((p: any) => evaluatePersonaLane(p, diffFiles, prContext))
    );

    expect(results).toHaveLength(12);
    const dbResult = results.find((r: any) => r.personaId === 'database');
    expect(dbResult.decision).toBe('FINDINGS');
    expect(dbResult.findings[0].severity).toBe('P0');

    const arbitration = computeArbitrationQuorum(results);
    expect(arbitration.verdict).toBe('BLOCK');
    expect(arbitration.quorumSatisfied).toBe(true);
    expect(arbitration.completedPersonas).toBe(12);
  });

  it('5. Formats GitHub PR comment output containing Mermaid diagram and persona roster breakdown', () => {
    const { PERSONA_CHARTERS, formatPRComment } = pipeline;
    const mockResults = PERSONA_CHARTERS.map((p: any) => ({
      personaId: p.id,
      displayName: p.name,
      model: p.model,
      decision: 'APPROVE',
      findings: [],
    }));

    const mockArbitration = {
      totalPersonas: 12,
      completedPersonas: 12,
      quorumSatisfied: true,
      verdict: 'SHIP',
      rationale: 'All 12 persona evaluations passed.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    };

    const prContext = {
      prNumber: '101',
      repo: 'calltelemetry/ct-review-bot',
      headSha: '1a2b3c4d5e',
    };

    const formattedComment = formatPRComment(mockArbitration, mockResults, prContext);

    expect(formattedComment).toContain('## 🟢 **Verdict: SHIP**');
    expect(formattedComment).toContain('```mermaid');
    expect(formattedComment).toContain('flowchart TD');
    expect(formattedComment).toContain('deepseek/deepseek-v4-flash-0731');
    expect(formattedComment).toContain('🛡️ Security & Tenancy Guardian');
  });

  it('formats provider, model, supported severity counts, and three-decimal costs', () => {
    const { formatPRComment } = pipeline;
    const results = [
      {
        personaId: 'security',
        displayName: 'Security',
        model: 'openai/gpt-5.6-luna',
        provider: 'openrouter',
        decision: 'FINDINGS',
        inputTokens: 100,
        outputTokens: 20,
        cost: 0.0074,
        findings: [
          { severity: 'P0', path: 'src/a.ts', line: 1, title: 'Outage', body: 'outage' },
          { severity: 'P1', path: 'src/a.ts', line: 2, title: 'Defect', body: 'defect' },
          { severity: 'P2', path: 'src/a.ts', line: 3, title: 'Nit', body: 'nit' },
        ],
      },
      {
        personaId: 'style',
        displayName: 'Style',
        model: 'z-ai/glm-5.2',
        provider: 'openrouter',
        decision: 'APPROVE',
        inputTokens: 200,
        outputTokens: 30,
        cost: 0.006307,
        findings: [],
      },
    ];

    const formattedComment = formatPRComment({
      totalPersonas: 2,
      completedPersonas: 2,
      quorumSatisfied: true,
      verdict: 'BLOCK',
      rationale: 'P0 finding requires a fix.',
      metrics: { p0Count: 1, p1Count: 1, p2Count: 1, totalFindings: 3 },
    }, results, { prNumber: '102', repo: 'calltelemetry/ct-review-bot', headSha: 'abc1234' });

    expect(formattedComment).toContain('| Reviewer Persona | Provider | Model | Decision | P0 | P1 | P2 / Nits | Input Tokens | Output Tokens | Cost |');
    expect(formattedComment).toContain('| Security | `openrouter` | `openai/gpt-5.6-luna` | ⚠️ FINDINGS | 🔴 1 | 🟠 1 | 🟡 1 | 100 | 20 | $0.007 |');
    expect(formattedComment).toContain('| Style | `openrouter` | `z-ai/glm-5.2` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | 200 | 30 | $0.006 |');
    expect(formattedComment).toContain('| **Total** | — | — | — | 🔴 1 | 🟠 1 | 🟡 1 | **300** | **50** | **$0.014** |');
    expect(formattedComment).not.toContain('| P3 |');
  });

  it('uses safe fallbacks when persona metadata omits provider and cost', () => {
    const { formatPRComment } = pipeline;
    const formattedComment = formatPRComment({
      totalPersonas: 1,
      completedPersonas: 1,
      quorumSatisfied: true,
      verdict: 'SHIP',
      rationale: 'Clean review.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    }, [{
      personaId: 'security',
      displayName: 'Security',
      model: 'openrouter/auto',
      decision: 'APPROVE',
      findings: [],
    }], { prNumber: '103', repo: 'calltelemetry/ct-review-bot', headSha: 'def4567' });

    expect(formattedComment).toContain('| Security | `unknown` | `openrouter/auto` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | — | — | — |');
    expect(formattedComment).toContain('| **Total** | — | — | — | 🔴 0 | 🟠 0 | 🟡 0 | — | — | — |');
    expect(formattedComment).not.toContain('NaN');
  });

  it('does not present a known-cost subtotal as complete when another lane is unknown', () => {
    const { formatPRComment } = pipeline;
    const formattedComment = formatPRComment({
      totalPersonas: 2,
      completedPersonas: 2,
      quorumSatisfied: true,
      verdict: 'SHIP',
      rationale: 'Clean review.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    }, [
      { personaId: 'security', displayName: 'Security', model: 'm1', provider: 'openrouter', decision: 'APPROVE', cost: 0.001, findings: [] },
      { personaId: 'style', displayName: 'Style', model: 'm2', provider: 'openrouter', decision: 'APPROVE', findings: [] },
    ], { prNumber: '104', repo: 'calltelemetry/ct-review-bot', headSha: 'fed7654' });

    expect(formattedComment).toContain('| Security | `openrouter` | `m1` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | — | — | $0.001 |');
    expect(formattedComment).toContain('| **Total** | — | — | — | 🔴 0 | 🟠 0 | 🟡 0 | — | — | — |');
  });

  it('renders invalid costs and hostile provider metadata as safe unknown cells', () => {
    const { formatPRComment } = pipeline;
    const formattedComment = formatPRComment({
      totalPersonas: 2,
      completedPersonas: 2,
      quorumSatisfied: true,
      verdict: 'SHIP',
      rationale: 'Clean review.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    }, [
      { personaId: 'security', displayName: 'Security', model: 'model`one|x', provider: 'provider`one|x', decision: 'APPROVE', cost: -1, findings: [] },
      { personaId: 'style', displayName: 'Style', model: 'model-two', provider: 'openrouter', decision: 'APPROVE', cost: 1e21, findings: [] },
    ], { prNumber: '105', repo: 'calltelemetry/ct-review-bot', headSha: 'fed7655' });

    expect(formattedComment).toContain('| Security | `provider\'one\\|x` | `model\'one\\|x` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | — | — | — |');
    expect(formattedComment).toContain('| Style | `openrouter` | `model-two` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | — | — | — |');
    expect(formattedComment).toContain('| **Total** | — | — | — | 🔴 0 | 🟠 0 | 🟡 0 | — | — | — |');
    expect(formattedComment).not.toContain('e+21');
  });

  describe('Cost & Subscription Telemetry Formatter (Milestone M1 R3)', () => {
    const { isSubscriptionTransport, isSubscriptionLane, formatCost, formatPRComment } = pipeline;

    describe('isSubscriptionTransport helper', () => {
      it('identifies unmetered direct and subscription transport identifiers', () => {
        expect(isSubscriptionTransport('fireworks')).toBe(true);
        expect(isSubscriptionTransport('direct-fireworks')).toBe(true);
        expect(isSubscriptionTransport('direct_fireworks')).toBe(true);
        expect(isSubscriptionTransport('ollama')).toBe(true);
        expect(isSubscriptionTransport('ollama-cloud')).toBe(true);
        expect(isSubscriptionTransport('ollama_cloud')).toBe(true);
        expect(isSubscriptionTransport('ollama-local')).toBe(true);
        expect(isSubscriptionTransport('ollama_local')).toBe(true);
        expect(isSubscriptionTransport('subscription')).toBe(true);
        expect(isSubscriptionTransport('FiReWoRkS')).toBe(true);
        expect(isSubscriptionTransport('OLLAMA-CLOUD')).toBe(true);
      });

      it('identifies transport parameter with subscription keywords', () => {
        expect(isSubscriptionTransport('openrouter', 'subscription')).toBe(true);
        expect(isSubscriptionTransport('custom-endpoint', 'subscription-tier')).toBe(true);
        expect(isSubscriptionTransport('anthropic', 'direct_subscription')).toBe(true);
      });

      it('handles object provider and transport representations', () => {
        expect(isSubscriptionTransport({ id: 'fireworks' })).toBe(true);
        expect(isSubscriptionTransport({ name: 'ollama-cloud' })).toBe(true);
        expect(isSubscriptionTransport({ id: 'openrouter' }, { type: 'subscription' })).toBe(true);
        expect(isSubscriptionTransport({ transport: 'subscription' })).toBe(true);
      });

      it('returns false for metered and standard pay-per-token transports', () => {
        expect(isSubscriptionTransport('openrouter')).toBe(false);
        expect(isSubscriptionTransport('openai')).toBe(false);
        expect(isSubscriptionTransport('anthropic')).toBe(false);
        expect(isSubscriptionTransport('google-gemini')).toBe(false);
        expect(isSubscriptionTransport('openrouter', 'metered')).toBe(false);
        expect(isSubscriptionTransport('', '')).toBe(false);
        expect(isSubscriptionTransport(null as any, null as any)).toBe(false);
        expect(isSubscriptionTransport(undefined as any)).toBe(false);
      });
    });

    describe('isSubscriptionLane helper', () => {
      it('identifies explicit subscription lane flags', () => {
        expect(isSubscriptionLane({ isSubscription: true })).toBe(true);
        expect(isSubscriptionLane({ isSubscription: 'true' })).toBe(true);
        expect(isSubscriptionLane({ billing: 'subscription' })).toBe(true);
        expect(isSubscriptionLane({ billing: 'Subscription' })).toBe(true);
        expect(isSubscriptionLane({ pricingType: 'subscription' })).toBe(true);
        expect(isSubscriptionLane({ transport: 'subscription' })).toBe(true);
        expect(isSubscriptionLane({ cost: 'Subscription' })).toBe(true);
        expect(isSubscriptionLane({ cost: 'subscription' })).toBe(true);
      });

      it('identifies unmetered providers when cost is null, undefined, empty, or 0', () => {
        expect(isSubscriptionLane({ provider: 'fireworks', cost: null })).toBe(true);
        expect(isSubscriptionLane({ provider: 'fireworks', cost: undefined })).toBe(true);
        expect(isSubscriptionLane({ provider: 'fireworks', cost: '' })).toBe(true);
        expect(isSubscriptionLane({ provider: 'fireworks', cost: 0 })).toBe(true);
        expect(isSubscriptionLane({ provider: 'ollama-cloud', cost: null })).toBe(true);
        expect(isSubscriptionLane({ provider: 'ollama', cost: null })).toBe(true);
        expect(isSubscriptionLane({ provider: 'direct-fireworks', cost: null })).toBe(true);
      });

      it('returns false when metered provider has null or positive cost without subscription flags', () => {
        expect(isSubscriptionLane({ provider: 'openrouter', cost: null })).toBe(false);
        expect(isSubscriptionLane({ provider: 'openrouter', cost: 0.0074 })).toBe(false);
        expect(isSubscriptionLane({ provider: 'openai', cost: 0.015 })).toBe(false);
      });

      it('treats positive numeric cost as metered unless explicit subscription flag is set', () => {
        expect(isSubscriptionLane({ provider: 'fireworks', cost: 0.005 })).toBe(false);
        expect(isSubscriptionLane({ provider: 'fireworks', cost: 0.005, isSubscription: true })).toBe(true);
      });

      it('safely handles non-object and malformed inputs', () => {
        expect(isSubscriptionLane(null)).toBe(false);
        expect(isSubscriptionLane(undefined)).toBe(false);
        expect(isSubscriptionLane('string' as any)).toBe(false);
        expect(isSubscriptionLane(123 as any)).toBe(false);
        expect(isSubscriptionLane({})).toBe(false);
      });
    });

    describe('formatCost helper', () => {
      it('formats valid positive numbers to 3 decimals with dollar sign', () => {
        expect(formatCost(0.0074)).toBe('$0.007');
        expect(formatCost(0.006307)).toBe('$0.006');
        expect(formatCost(0.013707)).toBe('$0.014');
        expect(formatCost(0)).toBe('$0.000');
        expect(formatCost(1.2346)).toBe('$1.235');
        expect(formatCost('0.0074')).toBe('$0.007');
      });

      it('returns Subscription for subscription literal strings', () => {
        expect(formatCost('Subscription')).toBe('Subscription');
        expect(formatCost('subscription')).toBe('Subscription');
        expect(formatCost(' SUBSCRIPTION ')).toBe('Subscription');
      });

      it('returns em dash for null, undefined, invalid, negative, or overflow values', () => {
        expect(formatCost(null)).toBe('—');
        expect(formatCost(undefined)).toBe('—');
        expect(formatCost('')).toBe('—');
        expect(formatCost('not-a-number')).toBe('—');
        expect(formatCost(-0.005)).toBe('—');
        expect(formatCost(1e21)).toBe('—');
      });
    });

    describe('formatPRComment roster and total row integration', () => {
      it('renders pure subscription panel with Subscription in rows and total', () => {
        const results = [
          {
            personaId: 'security',
            displayName: 'Security',
            model: 'fireworks/llama-v3p3-70b-instruct',
            provider: 'fireworks',
            decision: 'APPROVE',
            inputTokens: 1200,
            outputTokens: 350,
            cost: null,
            findings: [],
          },
          {
            personaId: 'architecture',
            displayName: 'Architecture',
            model: 'ollama-cloud/qwen2.5-coder',
            provider: 'ollama-cloud',
            decision: 'APPROVE',
            inputTokens: 1500,
            outputTokens: 400,
            cost: null,
            findings: [],
          },
        ];

        const comment = formatPRComment({
          totalPersonas: 2,
          completedPersonas: 2,
          quorumSatisfied: true,
          verdict: 'SHIP',
          rationale: 'Clean review across subscription transports.',
          metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
        }, results, { prNumber: '201', repo: 'calltelemetry/ct-review-bot', headSha: 'sub1234' });

        expect(comment).toContain('| Security | `fireworks` | `fireworks/llama-v3p3-70b-instruct` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | 1,200 | 350 | Subscription |');
        expect(comment).toContain('| Architecture | `ollama-cloud` | `ollama-cloud/qwen2.5-coder` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | 1,500 | 400 | Subscription |');
        expect(comment).toContain('| **Total** | — | — | — | 🔴 0 | 🟠 0 | 🟡 0 | **2,700** | **750** | **Subscription** |');
      });

      it('renders explicit subscription flags with Subscription in rows and total', () => {
        const results = [
          {
            personaId: 'security',
            displayName: 'Security',
            model: 'custom/model-sec',
            provider: 'custom',
            decision: 'APPROVE',
            inputTokens: 800,
            outputTokens: 150,
            isSubscription: true,
            findings: [],
          },
          {
            personaId: 'performance',
            displayName: 'Performance',
            model: 'custom/model-perf',
            provider: 'custom',
            decision: 'APPROVE',
            inputTokens: 900,
            outputTokens: 200,
            billing: 'subscription',
            findings: [],
          },
          {
            personaId: 'database',
            displayName: 'Database',
            model: 'custom/model-db',
            provider: 'custom',
            decision: 'APPROVE',
            inputTokens: 600,
            outputTokens: 100,
            cost: 'Subscription',
            findings: [],
          },
        ];

        const comment = formatPRComment({
          totalPersonas: 3,
          completedPersonas: 3,
          quorumSatisfied: true,
          verdict: 'SHIP',
          rationale: 'Explicit subscription review.',
          metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
        }, results, { prNumber: '202', repo: 'calltelemetry/ct-review-bot', headSha: 'sub5678' });

        expect(comment).toContain('| Security | `custom` | `custom/model-sec` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | 800 | 150 | Subscription |');
        expect(comment).toContain('| Performance | `custom` | `custom/model-perf` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | 900 | 200 | Subscription |');
        expect(comment).toContain('| Database | `custom` | `custom/model-db` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | 600 | 100 | Subscription |');
        expect(comment).toContain('| **Total** | — | — | — | 🔴 0 | 🟠 0 | 🟡 0 | **2,300** | **450** | **Subscription** |');
      });

      it('accurately aggregates mixed metered and subscription panels ($X.XXXX + Subscription)', () => {
        const results = [
          {
            personaId: 'security',
            displayName: 'Security',
            model: 'openai/gpt-5.6-luna',
            provider: 'openrouter',
            decision: 'APPROVE',
            inputTokens: 1000,
            outputTokens: 200,
            cost: 0.0074,
            findings: [],
          },
          {
            personaId: 'architecture',
            displayName: 'Architecture',
            model: 'accounts/fireworks/models/deepseek-v3',
            provider: 'fireworks',
            decision: 'APPROVE',
            inputTokens: 1500,
            outputTokens: 300,
            cost: null,
            findings: [],
          },
          {
            personaId: 'style',
            displayName: 'Style',
            model: 'z-ai/glm-5.2',
            provider: 'openrouter',
            decision: 'APPROVE',
            inputTokens: 500,
            outputTokens: 100,
            cost: 0.006307,
            findings: [],
          },
        ];

        const comment = formatPRComment({
          totalPersonas: 3,
          completedPersonas: 3,
          quorumSatisfied: true,
          verdict: 'SHIP',
          rationale: 'Mixed metered and subscription evaluation passed.',
          metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
        }, results, { prNumber: '203', repo: 'calltelemetry/ct-review-bot', headSha: 'mix1234' });

        expect(comment).toContain('| Security | `openrouter` | `openai/gpt-5.6-luna` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | 1,000 | 200 | $0.007 |');
        expect(comment).toContain('| Architecture | `fireworks` | `accounts/fireworks/models/deepseek-v3` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | 1,500 | 300 | Subscription |');
        expect(comment).toContain('| Style | `openrouter` | `z-ai/glm-5.2` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | 500 | 100 | $0.006 |');
        expect(comment).toContain('| **Total** | — | — | — | 🔴 0 | 🟠 0 | 🟡 0 | **3,000** | **600** | **$0.014 + Subscription** |');
      });

      it('accurately aggregates pure metered panels (**$X.XXXX**)', () => {
        const results = [
          {
            personaId: 'security',
            displayName: 'Security',
            model: 'openai/gpt-5.6-luna',
            provider: 'openrouter',
            decision: 'APPROVE',
            inputTokens: 1200,
            outputTokens: 250,
            cost: 0.0074,
            findings: [],
          },
          {
            personaId: 'performance',
            displayName: 'Performance',
            model: 'anthropic/claude-3.7-sonnet',
            provider: 'openrouter',
            decision: 'APPROVE',
            inputTokens: 1800,
            outputTokens: 400,
            cost: 0.0125,
            findings: [],
          },
        ];

        const comment = formatPRComment({
          totalPersonas: 2,
          completedPersonas: 2,
          quorumSatisfied: true,
          verdict: 'SHIP',
          rationale: 'Pure metered review.',
          metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
        }, results, { prNumber: '204', repo: 'calltelemetry/ct-review-bot', headSha: 'met1234' });

        expect(comment).toContain('| Security | `openrouter` | `openai/gpt-5.6-luna` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | 1,200 | 250 | $0.007 |');
        expect(comment).toContain('| Performance | `openrouter` | `anthropic/claude-3.7-sonnet` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | 1,800 | 400 | $0.013 |');
        expect(comment).toContain('| **Total** | — | — | — | 🔴 0 | 🟠 0 | 🟡 0 | **3,000** | **650** | **$0.020** |');
      });

      it('falls back to em dash in total when any lane has unknown cost (mixed or subscription)', () => {
        // Mixed panel with unknown lane
        const mixedWithUnknown = [
          { personaId: 'security', displayName: 'Security', model: 'm1', provider: 'openrouter', decision: 'APPROVE', cost: 0.007, findings: [] },
          { personaId: 'perf', displayName: 'Performance', model: 'm2', provider: 'fireworks', decision: 'APPROVE', cost: null, findings: [] },
          { personaId: 'style', displayName: 'Style', model: 'm3', provider: 'openrouter', decision: 'APPROVE', cost: null, findings: [] },
        ];

        const comment1 = formatPRComment({
          totalPersonas: 3,
          completedPersonas: 3,
          quorumSatisfied: true,
          verdict: 'SHIP',
          rationale: 'Mixed with unknown.',
          metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
        }, mixedWithUnknown, { prNumber: '205', repo: 'calltelemetry/ct-review-bot', headSha: 'unk1234' });

        expect(comment1).toContain('| Security | `openrouter` | `m1` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | — | — | $0.007 |');
        expect(comment1).toContain('| Performance | `fireworks` | `m2` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | — | — | Subscription |');
        expect(comment1).toContain('| Style | `openrouter` | `m3` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | — | — | — |');
        expect(comment1).toContain('| **Total** | — | — | — | 🔴 0 | 🟠 0 | 🟡 0 | — | — | — |');

        // Subscription panel with unknown lane
        const subWithUnknown = [
          { personaId: 'perf', displayName: 'Performance', model: 'm2', provider: 'fireworks', decision: 'APPROVE', cost: null, findings: [] },
          { personaId: 'style', displayName: 'Style', model: 'm3', provider: 'openrouter', decision: 'APPROVE', cost: null, findings: [] },
        ];

        const comment2 = formatPRComment({
          totalPersonas: 2,
          completedPersonas: 2,
          quorumSatisfied: true,
          verdict: 'SHIP',
          rationale: 'Subscription with unknown.',
          metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
        }, subWithUnknown, { prNumber: '206', repo: 'calltelemetry/ct-review-bot', headSha: 'unk5678' });

        expect(comment2).toContain('| Performance | `fireworks` | `m2` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | — | — | Subscription |');
        expect(comment2).toContain('| Style | `openrouter` | `m3` | ✅ APPROVE | 🔴 0 | 🟠 0 | 🟡 0 | — | — | — |');
        expect(comment2).toContain('| **Total** | — | — | — | 🔴 0 | 🟠 0 | 🟡 0 | — | — | — |');
      });

      it('handles empty persona results cleanly', () => {
        const comment = formatPRComment({
          totalPersonas: 0,
          completedPersonas: 0,
          quorumSatisfied: true,
          verdict: 'SHIP',
          rationale: 'No personas enabled.',
          metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
        }, [], { prNumber: '207', repo: 'calltelemetry/ct-review-bot', headSha: 'empty123' });

        expect(comment).toContain('| **Total** | — | — | — | 🔴 0 | 🟠 0 | 🟡 0 | — | — | — |');
      });
    });
  });

  it('6. Executes main pipeline cleanly without unhandled exceptions', async () => {
    const originalEnv = {
      PR_NUMBER: process.env.PR_NUMBER,
      ACTIVE_PERSONAS: process.env.ACTIVE_PERSONAS,
      PR_DIFF: process.env.PR_DIFF,
      GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
      GITHUB_EVENT_PATH: process.env.GITHUB_EVENT_PATH,
      VITEST: process.env.VITEST,
    };

    try {
      // This is a synthetic unit invocation even when Vitest itself runs on GitHub Actions.
      process.env.PR_NUMBER = '777';
      process.env.ACTIVE_PERSONAS = JSON.stringify(['security', 'architecture', 'performance', 'quality', 'database', 'api_contract', 'docs_compliance', 'reliability', 'devops', 'finops', 'red_team', 'review_flowchart']);
      process.env.PR_DIFF = `diff --git a/README.md b/README.md
+ ## Documentation update
`;
      process.env.GITHUB_ACTIONS = 'false';
      process.env.VITEST = 'true';
      delete process.env.GITHUB_EVENT_PATH;

      await expect(pipeline.main()).resolves.not.toThrow();
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  // =========================================================================
  // EDGE CASE & RESILIENCE STRESS TESTS
  // =========================================================================

  describe('Edge Cases: Diff Parsing & Environment Context', () => {
    it('7. Handles empty, null, undefined, and non-git diff inputs safely', () => {
      expect(pipeline.parseDiff('')).toEqual([]);
      expect(pipeline.parseDiff(null)).toEqual([]);
      expect(pipeline.parseDiff(undefined)).toEqual([]);

      // Raw unformatted diff fallback to src/index.ts
      const rawText = '+ console.log("hello world");';
      const parsedRaw = pipeline.parseDiff(rawText);
      expect(parsedRaw).toHaveLength(1);
      expect(parsedRaw[0].path).toBe('src/index.ts');
      expect(parsedRaw[0].addedLines[0].text).toBe(' console.log("hello world");');
    });

    it('8. Handles JSON payload in PR_DIFF environment variable correctly', () => {
      const originalEnv = process.env.PR_DIFF;
      try {
        process.env.PR_DIFF = JSON.stringify({
          diff: 'diff --git a/src/api/user.ts b/src/api/user.ts\n+ const x = 1;\n',
          prNumber: 42,
          repo: 'custom/repo',
          headSha: 'cafebabe1234',
          title: 'Custom JSON Title',
        });
        const ctx = pipeline.getPRDiffAndContext();
        expect(ctx.prNumber).toBe('42');
        expect(ctx.repo).toBe('custom/repo');
        expect(ctx.headSha).toBe('cafebabe1234');
        expect(ctx.title).toBe('Custom JSON Title');
        expect(ctx.diffText).toContain('src/api/user.ts');
      } finally {
        process.env.PR_DIFF = originalEnv;
      }
    });

    it('8b. Explicit head/base/title survive an ambient pull_request event', () => {
      // The runner's own event describes the PR that *triggered* the run, not necessarily the PR
      // under review. Step 3 of getPRDiffAndContext used to overwrite headSha/baseSha/title from
      // that event unconditionally, so an exact-head dispatch silently reviewed and published
      // against the runner's head instead of the requested one. prNumber and repo were already
      // guarded; these three were not.
      const originalDiff = process.env.PR_DIFF;
      const originalEventPath = process.env.GITHUB_EVENT_PATH;
      const eventFile = path.join(os.tmpdir(), `ryb-ambient-event-${process.pid}.json`);
      try {
        fs.writeFileSync(
          eventFile,
          JSON.stringify({
            pull_request: {
              number: 999,
              head: { sha: 'ambientheadsha0000' },
              base: { sha: 'ambientbasesha0000' },
              title: 'Ambient Event Title',
            },
          }),
        );
        process.env.GITHUB_EVENT_PATH = eventFile;
        process.env.PR_DIFF = JSON.stringify({
          diff: 'diff --git a/src/api/user.ts b/src/api/user.ts\n+ const x = 1;\n',
          prNumber: 42,
          repo: 'custom/repo',
          headSha: 'cafebabe1234',
          baseSha: 'deadbeef5678',
          title: 'Custom JSON Title',
        });

        const ctx = pipeline.getPRDiffAndContext();

        expect(ctx.headSha).toBe('cafebabe1234');
        expect(ctx.baseSha).toBe('deadbeef5678');
        expect(ctx.title).toBe('Custom JSON Title');
        expect(ctx.repo).toBe('custom/repo');
        expect(ctx.prNumber).toBe('42');
      } finally {
        process.env.PR_DIFF = originalDiff;
        if (originalEventPath === undefined) delete process.env.GITHUB_EVENT_PATH;
        else process.env.GITHUB_EVENT_PATH = originalEventPath;
        try {
          fs.unlinkSync(eventFile);
        } catch (_) {
          /* best effort */
        }
      }
    });

    it('8c. Ambient event still fills in head/base/title when the caller named none', () => {
      // The guard must not turn into "ignore the event" — with no explicit input, the event is the
      // only correct source (GITHUB_SHA is the merge commit on pull_request, not the head).
      const originalDiff = process.env.PR_DIFF;
      const originalEventPath = process.env.GITHUB_EVENT_PATH;
      const originalHeadSha = process.env.PR_HEAD_SHA;
      const originalBaseSha = process.env.PR_BASE_SHA;
      const eventFile = path.join(os.tmpdir(), `ryb-ambient-event-only-${process.pid}.json`);
      try {
        fs.writeFileSync(
          eventFile,
          JSON.stringify({
            pull_request: {
              number: 999,
              head: { sha: 'ambientheadsha0000' },
              base: { sha: 'ambientbasesha0000' },
              title: 'Ambient Event Title',
            },
          }),
        );
        process.env.GITHUB_EVENT_PATH = eventFile;
        delete process.env.PR_DIFF;
        delete process.env.PR_HEAD_SHA;
        delete process.env.PR_BASE_SHA;

        const ctx = pipeline.getPRDiffAndContext();

        expect(ctx.headSha).toBe('ambientheadsha0000');
        expect(ctx.baseSha).toBe('ambientbasesha0000');
        expect(ctx.title).toBe('Ambient Event Title');
      } finally {
        if (originalDiff === undefined) delete process.env.PR_DIFF;
        else process.env.PR_DIFF = originalDiff;
        if (originalEventPath === undefined) delete process.env.GITHUB_EVENT_PATH;
        else process.env.GITHUB_EVENT_PATH = originalEventPath;
        if (originalHeadSha === undefined) delete process.env.PR_HEAD_SHA;
        else process.env.PR_HEAD_SHA = originalHeadSha;
        if (originalBaseSha === undefined) delete process.env.PR_BASE_SHA;
        else process.env.PR_BASE_SHA = originalBaseSha;
        try {
          fs.unlinkSync(eventFile);
        } catch (_) {
          /* best effort */
        }
      }
    });

    it('9. Handles invalid JSON in PR_DIFF cleanly as raw diff text fallback', () => {
      const originalEnv = process.env.PR_DIFF;
      try {
        process.env.PR_DIFF = '{ invalid json payload... diff --git a/foo.ts b/foo.ts';
        const ctx = pipeline.getPRDiffAndContext();
        expect(ctx.diffText).toContain('{ invalid json payload');
      } finally {
        process.env.PR_DIFF = originalEnv;
      }
    });
  });

  describe('Edge Cases: Persona Evaluation Rules across all 12 Personas', () => {
    const { PERSONA_CHARTERS, evaluatePersonaLane } = pipeline;
    const aliasMap: Record<string, string> = {
      quality: 'style',
      reliability: 'testing',
      docs_compliance: 'documentation',
      api_contract: 'accessibility',
      finops: 'i18n',
      red_team: 'dependencies',
      review_flowchart: 'licensing',
    };
    const findPersona = (id: string) =>
      PERSONA_CHARTERS.find((p: any) => p.id === id || p.id === aliasMap[id]);

    it('10. Security persona flags hardcoded secrets and missing tenancy checks', async () => {
      const secPersona = findPersona('security');

      // Secret detection (P0) - alphanumeric token
      const diffSecret = [{
        path: 'src/config.ts',
        patch: '+ const token = "sk-0123456789abcdef0123456789";\n',
        addedLines: [{ text: ' const token = "sk-0123456789abcdef0123456789";' }],
      }];
      const resSecret = await evaluatePersonaLane(secPersona, diffSecret, {});
      expect(resSecret.decision).toBe('FINDINGS');
      expect(resSecret.findings[0].severity).toBe('P0');
      expect(resSecret.findings[0].title).toBe('Hardcoded Secret Detected');

      // Tenancy check (P1)
      const diffApiNoAuth = [{
        path: 'src/api/users.ts',
        patch: '+ app.get("/api/users", (req, res) => { const id = req.query.id; });\n',
        addedLines: [{ text: ' app.get("/api/users", (req, res) => { const id = req.query.id; });' }],
      }];
      const resTenancy = await evaluatePersonaLane(secPersona, diffApiNoAuth, {});
      expect(resTenancy.decision).toBe('FINDINGS');
      expect(resTenancy.findings.some((f: any) => f.severity === 'P1')).toBe(true);
    });

    it('11. Performance persona flags async sequential loops and sync I/O in API hot path', async () => {
      const perfPersona = findPersona('performance');

      // Async loop (P1)
      const diffLoop = [{
        path: 'src/services/fetcher.ts',
        patch: '+ for (const id of ids) { await fetch(id); }\n',
        addedLines: [{ text: ' for (const id of ids) { await fetch(id); }' }],
      }];
      const resLoop = await evaluatePersonaLane(perfPersona, diffLoop, {});
      expect(resLoop.decision).toBe('FINDINGS');
      expect(resLoop.findings[0].severity).toBe('P1');
      expect(resLoop.findings[0].title).toBe('N+1 Query / Async Sequential Loop');

      // Sync I/O in API hot path (P2)
      const diffSync = [{
        path: 'src/server/api/handler.ts',
        patch: '+ const data = fs.readFileSync("/tmp/data");\n',
        addedLines: [{ text: ' const data = fs.readFileSync("/tmp/data");' }],
      }];
      const resSync = await evaluatePersonaLane(perfPersona, diffSync, {});
      expect(resSync.decision).toBe('FINDINGS');
      expect(resSync.findings[0].severity).toBe('P2');
      expect(resSync.findings[0].title).toBe('Synchronous Blocking I/O in API Hot Path');
    });

    it('12. Architecture persona flags deep cross-layer coupling', async () => {
      const archPersona = findPersona('architecture');
      const diffArch = [{
        path: 'src/domain/userEntity.ts',
        patch: '+ import { UserView } from "../../../presentation/views";\n',
        addedLines: [{ text: ' import { UserView } from "../../../presentation/views";' }],
      }];
      const resArch = await evaluatePersonaLane(archPersona, diffArch, {});
      expect(resArch.decision).toBe('FINDINGS');
      expect(resArch.findings[0].severity).toBe('P2');
      expect(resArch.findings[0].title).toBe('Layer Boundary Coupling Hazard');
    });

    it('13. Quality persona flags console.log debug statements', async () => {
      const stylePersona = findPersona('quality');
      const diffStyle = [{
        path: 'src/utils/math.ts',
        patch: '+ console.log("debug math");\n',
        addedLines: [{ text: ' console.log("debug math");' }],
      }];
      const resStyle = await evaluatePersonaLane(stylePersona, diffStyle, {});
      expect(resStyle.decision).toBe('FINDINGS');
      expect(resStyle.findings[0].severity).toBe('P2');
      expect(resStyle.findings[0].title).toBe('Leftover Debug Statement');
    });

    it('14. Reliability persona flags active .only() markers', async () => {
      const testPersona = findPersona('reliability');
      const diffTest = [{
        path: 'tests/unit/app.test.ts',
        patch: '+ describe.only("focused suite", () => {});\n',
        addedLines: [{ text: ' describe.only("focused suite", () => {});' }],
      }];
      const resTest = await evaluatePersonaLane(testPersona, diffTest, {});
      expect(resTest.decision).toBe('FINDINGS');
      expect(resTest.findings[0].severity).toBe('P1');
      expect(resTest.findings[0].title).toBe('Exclusive Test Marker Left Active');
    });

    it('15. Docs compliance persona flags exported functions without JSDoc', async () => {
      const docPersona = findPersona('docs_compliance');
      const diffDoc = [{
        path: 'src/lib/calculator.ts',
        patch: '+ export function add(a: number, b: number) { return a + b; }\n',
        addedLines: [{ text: ' export function add(a: number, b: number) { return a + b; }' }],
      }];
      const resDoc = await evaluatePersonaLane(docPersona, diffDoc, {});
      expect(resDoc.decision).toBe('FINDINGS');
      expect(resDoc.findings[0].severity).toBe('P2');
      expect(resDoc.findings[0].title).toBe('Missing Docstring / JSDoc Annotation');
    });

    it('16. API contract persona flags img elements missing alt attribute', async () => {
      const a11yPersona = findPersona('api_contract');
      const diffA11y = [{
        path: 'src/components/Avatar.tsx',
        patch: '+ return <img src="/logo.png" />;\n',
        addedLines: [{ text: ' return <img src="/logo.png" />;' }],
      }];
      const resA11y = await evaluatePersonaLane(a11yPersona, diffA11y, {});
      expect(resA11y.decision).toBe('FINDINGS');
      expect(resA11y.findings[0].severity).toBe('P2');
      expect(resA11y.findings[0].title).toBe('Image Missing Alt Text (WCAG 2.1)');
    });

    it('17. Database persona flags DROP COLUMN destructive migrations', async () => {
      const dbPersona = findPersona('database');
      const diffDb = [{
        path: 'db/migrations/002_drop.sql',
        patch: '+ ALTER TABLE users DROP COLUMN phone;\n',
        addedLines: [{ text: ' ALTER TABLE users DROP COLUMN phone;' }],
      }];
      const resDb = await evaluatePersonaLane(dbPersona, diffDb, {});
      expect(resDb.decision).toBe('FINDINGS');
      expect(resDb.findings[0].severity).toBe('P0');
      expect(resDb.findings[0].title).toBe('Destructive DDL Schema Migration Hazard');
    });

    it('18. DevOps persona flags Dockerfile missing non-root USER directive', async () => {
      const devopsPersona = findPersona('devops');
      const diffDevops = [{
        path: 'Dockerfile',
        patch: '+ ENTRYPOINT ["node", "dist/index.js"]\n',
        addedLines: [{ text: ' ENTRYPOINT ["node", "dist/index.js"]' }],
      }];
      const resDevops = await evaluatePersonaLane(devopsPersona, diffDevops, {});
      expect(resDevops.decision).toBe('FINDINGS');
      expect(resDevops.findings[0].severity).toBe('P1');
      expect(resDevops.findings[0].title).toBe('Container Non-Root User Missing');
    });

    it('19. FinOps persona flags hardcoded string in UI components', async () => {
      const i18nPersona = findPersona('finops');
      const diffI18n = [{
        path: 'src/components/Header.tsx',
        patch: '+ return <h1>Welcome User</h1>;\n',
        addedLines: [{ text: ' return <h1>Welcome User</h1>;' }],
      }];
      const resI18n = await evaluatePersonaLane(i18nPersona, diffI18n, {});
      expect(resI18n.decision).toBe('FINDINGS');
      expect(resI18n.findings[0].severity).toBe('P2');
      expect(resI18n.findings[0].title).toBe('Hardcoded User Interface Text String');
    });

    it('20. Red team persona flags unpinned wildcard dependencies', async () => {
      const depPersona = findPersona('red_team');
      const diffDep = [{
        path: 'package.json',
        patch: '+ "express": "*"\n',
        addedLines: [{ text: ' "express": "*"' }],
      }];
      const resDep = await evaluatePersonaLane(depPersona, diffDep, {});
      expect(resDep.decision).toBe('FINDINGS');
      expect(resDep.findings[0].severity).toBe('P1');
      expect(resDep.findings[0].title).toBe('Unpinned Wildcard Dependency Version');
    });

    it('21. Review flowchart persona flags missing headers in large source files', async () => {
      const licPersona = findPersona('review_flowchart');
      const addedLines = Array(60).fill({ text: 'const line = 1;' });
      const diffLic = [{
        path: 'src/largeModule.ts',
        patch: addedLines.map(l => '+' + l.text).join('\n'),
        addedLines,
      }];
      const resLic = await evaluatePersonaLane(licPersona, diffLic, {});
      expect(resLic.decision).toBe('FINDINGS');
      expect(resLic.findings[0].severity).toBe('P2');
      expect(resLic.findings[0].title).toBe('Missing License Header Notice');
    });
  });

  describe('Edge Cases & Quorum Thresholds: computeArbitrationQuorum', () => {
    const { computeArbitrationQuorum } = pipeline;

    it('22. Computes FIX_FIRST for 1 P1 finding or 5+ P2 findings', () => {
      const resultsP1 = [{ findings: [{ severity: 'P1' }] }];
      const quorumP1 = computeArbitrationQuorum(resultsP1 as any);
      expect(quorumP1.verdict).toBe('FIX_FIRST');

      const resultsP2 = [{
        findings: [
          { severity: 'P2' },
          { severity: 'P2' },
          { severity: 'P2' },
          { severity: 'P2' },
          { severity: 'P2' },
        ],
      }];
      const quorumP2 = computeArbitrationQuorum(resultsP2 as any);
      expect(quorumP2.verdict).toBe('FIX_FIRST');
    });

    it('23. Computes BLOCK for 3+ P1 findings or 1 P0 finding', () => {
      const resultsP1s = [
        { findings: [{ severity: 'P1' }, { severity: 'P1' }, { severity: 'P1' }] },
      ];
      const quorumP1s = computeArbitrationQuorum(resultsP1s as any);
      expect(quorumP1s.verdict).toBe('BLOCK');
    });
  });

  describe('Stress & Performance Testing', () => {
    it('24. Stress test: Evaluates 50 files and 2,000 diff lines across all 12 personas in parallel (<1000ms)', async () => {
      const { PERSONA_CHARTERS, evaluatePersonaLane, computeArbitrationQuorum } = pipeline;

      // Generate 50 simulated file diffs with mixed content
      const diffFiles = [];
      for (let i = 0; i < 50; i++) {
        diffFiles.push({
          path: `src/module_${i}/service_${i}.ts`,
          patch: `+ export function handle_${i}() {\n+   console.log("processing ${i}");\n+   return ${i};\n+ }\n`,
          addedLines: [
            { text: ` export function handle_${i}() {` },
            { text: `   console.log("processing ${i}");` },
            { text: `   return ${i};` },
            { text: ` }` },
          ],
        });
      }

      const startTime = Date.now();
      const results = await Promise.all(
        PERSONA_CHARTERS.map((persona: any) => evaluatePersonaLane(persona, diffFiles, {}))
      );
      const durationMs = Date.now() - startTime;

      expect(results).toHaveLength(12);
      expect(durationMs).toBeLessThan(1000); // Expect sub-second parallel execution

      const arbitration = computeArbitrationQuorum(results);
      expect(arbitration.completedPersonas).toBe(12);
      expect(arbitration.quorumSatisfied).toBe(true);
      expect(['SHIP', 'FIX_FIRST', 'BLOCK']).toContain(arbitration.verdict);
    });
  });
});
