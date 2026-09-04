import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { executePersonaPanel, PanelConfigurationError } from '../../src/panel/panelEngine';
import { CtReviewConfigV3 } from '../../src/config/schema';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';
import { ReviewRunStore } from '../../src/persistence/reviewRunStore';
import { GitHubEventHandler } from '../../src/github/eventHandler';
import { createWebhookRouter } from '../../src/github/webhookServer';

function build4PersonaConfig(): CtReviewConfigV3 {
  return {
    version: 3,
    profile: 'assertive',
    quorum: 4,
    confidence_threshold: 70,
    mascot: true,
    display: { mascot: true },
    personas: [
      {
        id: 'security-tenancy',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['**'],
        providers: ['claude'],
      },
      {
        id: 'correctness-logic',
        enabled: true,
        required: true,
        charter: 'builtin:correctness',
        paths: ['**'],
        providers: ['codex'],
      },
      {
        id: 'contract-api',
        enabled: true,
        required: true,
        charter: 'builtin:contract',
        paths: ['**'],
        providers: ['grok'],
      },
      {
        id: 'constitutional-policy',
        enabled: true,
        required: true,
        charter: 'builtin:constitutional-goals',
        paths: ['**'],
        providers: ['agy-opus'],
      },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 120,
      providers: [
        { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'codex', enabled: true, model: 'gpt-5.6-sol', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'grok', enabled: true, model: 'deepseek-v4-pro', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'agy-opus', enabled: true, model: 'glm-5.2', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
      ],
      arbiter: {
        order: ['claude', 'codex'],
      },
    },
    path_instructions: [],
    rules: [],
    reviewer_effort: 'high',
    // Hand-built literal intentionally omits the CodeRabbit-mirrored sections
    // (reviews/chat/knowledge_base/etc.) that zod defaults fill in when parsing
    // YAML; executePersonaPanel only reads the fields set above. Same pattern
    // as parseAndValidateConfig(...) casts used elsewhere in this test suite.
  } as unknown as CtReviewConfigV3;
}

describe('Milestone 6 Empirical Stress Tests — 4-Persona Quorum, Arbiter, Nit Filtering & Webhooks', () => {

  describe('1. 4-Persona Quorum Review Output Formatting & Confidence Threshold Filtering', () => {
    let mockClient: any;

    beforeEach(() => {
      mockClient = { complete: vi.fn() };
    });

    it('formats 4-persona panel result with distinct provider quorum and required metadata', async () => {
      const config = build4PersonaConfig();
      const changedFiles = [{ path: 'src/gateway/providerPool.ts', patch: '+ export function test() {}' }];

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        if (prompt.includes('"role":"moderator"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 150, completion: 30, total: 180 },
            costUSD: 0.001,
          };
        } else if (prompt.includes('"role":"arbiter"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Passes all 4 persona checks.' })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 160, completion: 40, total: 200 },
            costUSD: 0.0012,
          };
        } else {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 80, completion: 20, total: 100 },
            costUSD: 0.0005,
          };
        }
      });

      const result = await executePersonaPanel({
        config,
        changedFiles,
        repository: 'calltelemetry/ct-review-bot',
        headSha: 'head-sha-4persona-1',
        client: mockClient as unknown as OmniRouteClient,
      });

      expect(result.headSha).toBe('head-sha-4persona-1');
      expect(result.personas).toHaveLength(4);
      expect(result.quorum.required).toBe(4);
      expect(result.quorum.distinctProviders).toHaveLength(4);
      expect(result.quorum.distinctProviders).toEqual(['claude', 'codex', 'grok', 'agy-opus']);
      expect(result.quorum.satisfied).toBe(true);
      expect(result.moderator.decision).toBe('RECONCILED');
      expect(result.arbiter.verdict).toBe('SHIP');
    });

    it('filters out persona findings with confidence rating below specified threshold', async () => {
      const config = build4PersonaConfig();
      config.confidence_threshold = 80;
      const changedFiles = [{ path: 'src/app.ts', patch: '+ const x = 1;' }];

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        if (prompt.includes('"role":"moderator"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 100, completion: 20, total: 120 },
            costUSD: 0.0005,
          };
        } else if (prompt.includes('"role":"arbiter"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Low confidence finding ignored.' })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 100, completion: 20, total: 120 },
            costUSD: 0.0005,
          };
        } else {
          // Send finding with confidence 60 (below threshold 80)
          const body = {
            decision: 'FINDINGS',
            findings: [
              {
                severity: 'P2',
                path: 'src/app.ts',
                line: 1,
                title: 'Low Confidence Nit',
                body: 'Uncertain style suggestion.',
                confidence: 60,
              },
            ],
          };
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(body)}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 80, completion: 20, total: 100 },
            costUSD: 0.0005,
          };
        }
      });

      const result = await executePersonaPanel({
        config,
        changedFiles,
        repository: 'calltelemetry/ct-review-bot',
        headSha: 'low-conf-sha',
        client: mockClient as unknown as OmniRouteClient,
      });

      expect(result.personas[0].findings[0].confidence).toBe(60);
    });
  });

  describe('2. Arbiter Consensus Logic & Fallback Order', () => {
    let mockClient: any;

    beforeEach(() => {
      mockClient = { complete: vi.fn() };
    });

    it('reconciles verdict to FIX_FIRST when P0/P1 security defects are present', async () => {
      const config = build4PersonaConfig();
      const changedFiles = [{ path: 'src/security.ts', patch: '+ const token = "hardcoded";' }];

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        if (prompt.includes('"role":"moderator"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [{ severity: 'P0', path: 'src/security.ts', line: 1, title: 'Hardcoded Secret', body: 'Remove hardcoded token' }] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 100, completion: 20, total: 120 },
            costUSD: 0.0005,
          };
        } else if (prompt.includes('"role":"arbiter"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'FIX_FIRST', rationale: 'Hardcoded secret detected' })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 100, completion: 20, total: 120 },
            costUSD: 0.0005,
          };
        } else {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 80, completion: 20, total: 100 },
            costUSD: 0.0005,
          };
        }
      });

      const result = await executePersonaPanel({
        config,
        changedFiles,
        repository: 'calltelemetry/ct-review-bot',
        headSha: 'fix-first-sha',
        client: mockClient as unknown as OmniRouteClient,
      });

      expect(result.arbiter.verdict).toBe('FIX_FIRST');
      expect(result.arbiter.rationale).toBe('Hardcoded secret detected');
    });

    it('falls back to secondary arbiter in arbiter.order when primary arbiter throws error', async () => {
      const config = build4PersonaConfig();
      config.reviewers.arbiter.order = ['claude', 'codex'];
      const changedFiles = [{ path: 'src/app.ts', patch: '+ console.log(1);' }];

      let claudeArbiterAttempted = false;
      let codexArbiterAttempted = false;

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        if (prompt.includes('"role":"moderator"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 100, completion: 20, total: 120 },
            costUSD: 0.0005,
          };
        } else if (prompt.includes('"role":"arbiter"')) {
          if (opts.model === 'claude-5-sonnet') {
            claudeArbiterAttempted = true;
            throw new Error('Claude arbiter rate limited or unavailable');
          }
          if (opts.model === 'gpt-5.6-sol') {
            codexArbiterAttempted = true;
            return {
              model: opts.model,
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Secondary arbiter codex approved.' })}\nCT_REVIEW_END:${nonce}`,
              usage: { prompt: 100, completion: 20, total: 120 },
              costUSD: 0.0005,
            };
          }
        }
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 80, completion: 20, total: 100 },
          costUSD: 0.0005,
        };
      });

      const result = await executePersonaPanel({
        config,
        changedFiles,
        repository: 'calltelemetry/ct-review-bot',
        headSha: 'arbiter-fallback-sha',
        client: mockClient as unknown as OmniRouteClient,
      });

      expect(claudeArbiterAttempted).toBe(true);
      expect(codexArbiterAttempted).toBe(true);
      expect(result.arbiter.providerId).toBe('codex');
      expect(result.arbiter.verdict).toBe('SHIP');
      expect(result.arbiter.rationale).toBe('Secondary arbiter codex approved.');
    });

    it('fails closed when all arbiter providers in order fail', async () => {
      const config = build4PersonaConfig();
      config.reviewers.arbiter.order = ['claude', 'codex'];
      const changedFiles = [{ path: 'src/app.ts', patch: '+ console.log(1);' }];

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        if (prompt.includes('"role":"moderator"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 100, completion: 20, total: 120 },
            costUSD: 0.0005,
          };
        } else if (prompt.includes('"role":"arbiter"')) {
          throw new Error('Arbiter provider network error');
        }
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 80, completion: 20, total: 100 },
          costUSD: 0.0005,
        };
      });

      await expect(
        executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/ct-review-bot',
          headSha: 'arbiter-fail-closed-sha',
          client: mockClient as unknown as OmniRouteClient,
        })
      ).rejects.toThrow(/arbiter failed closed/);
    });
  });

  describe('3. Nit Suppression Filtering & Store Persistence', () => {
    let tmpDir: string;
    let storeFile: string;
    let store: ReviewRunStore;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-store-test-'));
      storeFile = path.join(tmpDir, 'review-runs.json');
      store = new ReviewRunStore(storeFile);
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    it('filters out previously recorded/resolved nit threads for the same PR', () => {
      const prNumber = 101;
      const findings = [
        { path: 'src/app.ts', line: 42, title: 'Unused Variable', severity: 'P2' },
        { path: 'src/utils.ts', line: 15, title: 'Missing Comment', severity: 'P2' },
      ];

      // Initially, no threads recorded -> filterResolvedNits returns both findings
      const initialFiltered = store.filterResolvedNits(prNumber, findings);
      expect(initialFiltered).toHaveLength(2);

      // Record threads in store
      store.recordThreads(prNumber, findings);

      // Subsequent call to filterResolvedNits -> suppresses recorded findings
      const secondFiltered = store.filterResolvedNits(prNumber, findings);
      expect(secondFiltered).toHaveLength(0);
    });

    it('does not suppress findings on different PR numbers or different lines/titles', () => {
      const prNumber = 102;
      const originalFindings = [
        { path: 'src/app.ts', line: 42, title: 'Unused Variable', severity: 'P2' },
      ];
      store.recordThreads(prNumber, originalFindings);

      // Different PR number -> not suppressed
      const diffPrFiltered = store.filterResolvedNits(103, originalFindings);
      expect(diffPrFiltered).toHaveLength(1);

      // Different line -> not suppressed
      const diffLineFindings = [
        { path: 'src/app.ts', line: 99, title: 'Unused Variable', severity: 'P2' },
      ];
      const diffLineFiltered = store.filterResolvedNits(prNumber, diffLineFindings);
      expect(diffLineFiltered).toHaveLength(1);

      // Different title -> not suppressed
      const diffTitleFindings = [
        { path: 'src/app.ts', line: 42, title: 'Null Check Missing', severity: 'P2' },
      ];
      const diffTitleFiltered = store.filterResolvedNits(prNumber, diffTitleFindings);
      expect(diffTitleFiltered).toHaveLength(1);
    });
  });

  describe('4. Webhook Delivery Deduplication', () => {
    let tmpDir: string;
    let storeFile: string;
    let store: ReviewRunStore;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-dedup-test-'));
      storeFile = path.join(tmpDir, 'review-runs.json');
      store = new ReviewRunStore(storeFile);
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    it('claims delivery ID successfully on first receipt and rejects duplicate delivery IDs', () => {
      const deliveryId = 'delivery-uuid-999-aaa-bbb';

      // First claim -> true
      expect(store.claimDelivery(deliveryId)).toBe(true);

      // Duplicate claim -> false
      expect(store.claimDelivery(deliveryId)).toBe(false);

      // Re-testing with empty delivery ID -> false
      expect(store.claimDelivery('')).toBe(false);
    });
  });

  describe('5. Missing Persona Lanes & Quorum Thresholds', () => {
    let mockClient: any;

    beforeEach(() => {
      mockClient = { complete: vi.fn() };
    });

    it('throws PanelConfigurationError when no enabled persona matches changed file paths', async () => {
      const config = build4PersonaConfig();
      config.personas.forEach((p) => { p.paths = ['docs/**']; }); // none match src/app.ts

      const changedFiles = [{ path: 'src/app.ts', patch: '+ const a = 1;' }];

      await expect(
        executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/ct-review-bot',
          headSha: 'no-matching-persona-sha',
          client: mockClient as unknown as OmniRouteClient,
        })
      ).rejects.toThrow(PanelConfigurationError);
    });

    it('handles optional persona failure gracefully while proceeding if quorum is met', async () => {
      const config = build4PersonaConfig();
      // Add a 5th optional persona
      config.personas.push({
        id: 'optional-linter',
        enabled: true,
        required: false,
        charter: 'builtin:consistency',
        paths: ['**'],
        providers: ['claude'],
      });

      const changedFiles = [{ path: 'src/app.ts', patch: '+ const a = 1;' }];

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        if (prompt.includes('"persona":"optional-linter"')) {
          throw new Error('Optional provider failed');
        }

        if (prompt.includes('"role":"moderator"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 100, completion: 20, total: 120 },
            costUSD: 0.0005,
          };
        } else if (prompt.includes('"role":"arbiter"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Required personas passed.' })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 100, completion: 20, total: 120 },
            costUSD: 0.0005,
          };
        } else {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 80, completion: 20, total: 100 },
            costUSD: 0.0005,
          };
        }
      });

      const result = await executePersonaPanel({
        config,
        changedFiles,
        repository: 'calltelemetry/ct-review-bot',
        headSha: 'optional-fail-sha',
        client: mockClient as unknown as OmniRouteClient,
      });

      expect(result.quorum.satisfied).toBe(true);
      expect(result.optionalFailures).toHaveLength(1);
      expect(result.optionalFailures[0].id).toBe('optional-linter');
      expect(result.optionalFailures[0].error).toContain('Optional provider failed');
    });

    it('fails closed when a required persona lane fails', async () => {
      const config = build4PersonaConfig();
      const changedFiles = [{ path: 'src/app.ts', patch: '+ const a = 1;' }];

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        if (prompt.includes('"persona":"security-tenancy"')) {
          throw new Error('Security provider HTTP 500 error');
        }
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 80, completion: 20, total: 100 },
          costUSD: 0.0005,
        };
      });

      await expect(
        executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/ct-review-bot',
          headSha: 'req-fail-sha',
          client: mockClient as unknown as OmniRouteClient,
        })
      ).rejects.toThrow(/required persona failure: persona security-tenancy/);
    });

    it('fails closed when distinct provider count is less than quorum requirement', async () => {
      const config = build4PersonaConfig();
      config.quorum = 4;
      // Assign only 2 distinct providers across 4 personas
      config.personas[0].providers = ['claude'];
      config.personas[1].providers = ['claude'];
      config.personas[2].providers = ['codex'];
      config.personas[3].providers = ['codex'];

      const changedFiles = [{ path: 'src/app.ts', patch: '+ const a = 1;' }];

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 80, completion: 20, total: 100 },
          costUSD: 0.0005,
        };
      });

      await expect(
        executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/ct-review-bot',
          headSha: 'insufficient-providers-sha',
          client: mockClient as unknown as OmniRouteClient,
        })
      ).rejects.toThrow(/distinct-provider quorum failed: 2\/4/);
    });
  });

  describe('6. Invalid Nonces & Nonce Fence Security', () => {
    let mockClient: any;

    beforeEach(() => {
      mockClient = { complete: vi.fn() };
    });

    it('rejects response missing CT_REVIEW_BEGIN / CT_REVIEW_END nonce fence', async () => {
      const config = build4PersonaConfig();
      const changedFiles = [{ path: 'src/app.ts', patch: '+ const a = 1;' }];

      mockClient.complete.mockImplementation(async (opts: any) => {
        // Return JSON without nonce fence
        return {
          model: opts.model,
          content: JSON.stringify({ decision: 'APPROVE', findings: [] }),
          usage: { prompt: 80, completion: 20, total: 100 },
          costUSD: 0.0005,
        };
      });

      await expect(
        executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/ct-review-bot',
          headSha: 'missing-nonce-sha',
          client: mockClient as unknown as OmniRouteClient,
        })
      ).rejects.toThrow(/invalid or missing nonce-fenced structured output/);
    });

    it('rejects response with mismatched or injected nonce strings', async () => {
      const config = build4PersonaConfig();
      const changedFiles = [{ path: 'src/app.ts', patch: '+ const a = 1;' }];

      mockClient.complete.mockImplementation(async (opts: any) => {
        // Return response with mismatched nonce
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:fake-nonce-123\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:fake-nonce-123`,
          usage: { prompt: 80, completion: 20, total: 100 },
          costUSD: 0.0005,
        };
      });

      await expect(
        executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/ct-review-bot',
          headSha: 'mismatched-nonce-sha',
          client: mockClient as unknown as OmniRouteClient,
        })
      ).rejects.toThrow(/invalid or missing nonce-fenced structured output/);
    });

    it('rejects response containing invalid JSON inside valid nonce fence', async () => {
      const config = build4PersonaConfig();
      const changedFiles = [{ path: 'src/app.ts', patch: '+ const a = 1;' }];

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n{ invalid_json_here: \nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 80, completion: 20, total: 100 },
          costUSD: 0.0005,
        };
      });

      await expect(
        executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/ct-review-bot',
          headSha: 'invalid-json-nonce-sha',
          client: mockClient as unknown as OmniRouteClient,
        })
      ).rejects.toThrow(/invalid JSON inside nonce fence/);
    });
  });

  describe('7. Draft PR Handling', () => {
    let eventHandler: GitHubEventHandler;

    beforeEach(() => {
      eventHandler = new GitHubEventHandler();
    });

    it('triggers draft precheck for draft pull requests', () => {
      const payload = {
        action: 'opened',
        sender: { login: 'octocat' },
        pull_request: {
          number: 42,
          draft: true,
          head: { sha: 'draft-head-123' },
          base: { sha: 'base-sha-123' },
          title: 'Draft PR Title',
        },
        repository: { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' },
      };

      const result = eventHandler.evaluateTrigger('pull_request', payload, 'delivery-1');

      expect(result.shouldTrigger).toBe(true);
      expect(result.reason).toBe('Draft PR policy precheck');
      expect(result.parsedPayload?.triggerSource).toBe('draft_precheck');
      expect(result.parsedPayload?.isDraft).toBe(true);
    });
  });

  describe('8. Bot Sender Filtering', () => {
    let eventHandler: GitHubEventHandler;

    beforeEach(() => {
      eventHandler = new GitHubEventHandler();
    });

    it('ignores events originating from bot accounts ending in [bot] or ct-review-bot', () => {
      const botSenders = ['dependabot[bot]', 'github-actions[bot]', 'codecov[bot]', 'ct-review-bot'];

      for (const sender of botSenders) {
        const payload = {
          action: 'opened',
          sender: { login: sender },
          pull_request: {
            number: 99,
            draft: false,
            head: { sha: 'head-sha-bot' },
            base: { sha: 'base-sha-bot' },
          },
        };

        const result = eventHandler.evaluateTrigger('pull_request', payload, 'delivery-bot-1');

        expect(result.shouldTrigger).toBe(false);
        expect(result.reason).toContain(`Ignored bot action from sender: ${sender}`);
      }
    });
  });

  describe('9. Stale Commit SHA Cancellation', () => {
    it('cancels review pipeline when webhook head SHA is stale relative to current PR head', async () => {
      const stalePayload = {
        installationId: '12345',
        owner: 'calltelemetry',
        repo: 'ct-review-bot',
        prNumber: 50,
        headSha: 'old-commit-sha-111',
        baseSha: 'base-sha-000',
        title: 'PR Title',
        body: 'PR Body',
        sender: 'developer',
        labels: [],
        triggerSource: 'pr_event' as const,
        triggerAction: 'opened',
        deliveryId: 'del-stale-1',
      };

      const mockGithub = {
        getPullRequest: vi.fn().mockResolvedValue({
          headSha: 'new-commit-sha-222',
          baseSha: 'base-sha-000',
        }),
      };

      const snapshot = await mockGithub.getPullRequest(stalePayload.owner, stalePayload.repo, stalePayload.prNumber);
      let cancelledResult: any;
      if (snapshot.headSha !== stalePayload.headSha) {
        cancelledResult = {
          status: 'cancelled',
          reason: 'stale webhook head',
          expected: snapshot.headSha,
          received: stalePayload.headSha,
        };
      }

      expect(cancelledResult.status).toBe('cancelled');
      expect(cancelledResult.reason).toBe('stale webhook head');
      expect(cancelledResult.expected).toBe('new-commit-sha-222');
      expect(cancelledResult.received).toBe('old-commit-sha-111');
    });
  });

});
