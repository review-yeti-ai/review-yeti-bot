import { describe, it, expect, vi } from 'vitest';
import {
  evaluatePersonaGating,
  executePersonaPanel,
} from '../../src/panel/panelEngine';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';

describe('Milestone 4 (R4): Domain-Based Persona Gating & Budgeting', () => {
  describe('evaluatePersonaGating Function', () => {
    it('does not skip general or un-gated personas', () => {
      const generalPersona = { id: 'general', charter: 'Review general code quality', paths: ['**/*'] };
      const changedFiles = [{ path: 'README.md', patch: '@@ -1 +1 @@\n- old\n+ new' }];
      const domainLanes = { 'README.md': 'docs_assets' as const };

      const result = evaluatePersonaGating({
        persona: generalPersona,
        changedFiles,
        domainLanes,
      });

      expect(result.skipped).toBe(false);
    });

    it('skips sec-lane on pure documentation or asset changes', () => {
      const secPersona = { id: 'sec-lane', charter: 'Security review', paths: ['**/*'] };
      const changedFiles = [
        { path: 'docs/architecture.md', patch: '@@ -1 +1 @@\n- old\n+ new' },
        { path: 'assets/logo.png', patch: '' },
      ];
      const domainLanes = {
        'docs/architecture.md': 'docs_assets' as const,
        'assets/logo.png': 'docs_assets' as const,
      };

      const result = evaluatePersonaGating({
        persona: secPersona,
        changedFiles,
        domainLanes,
      });

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('pure documentation or asset');
    });

    it('skips perf-lane on pure documentation or asset changes', () => {
      const perfPersona = { id: 'perf-lane', charter: 'Performance and concurrency review', paths: ['**/*'] };
      const changedFiles = [
        { path: 'README.md', patch: '@@ -1 +1 @@\n- old\n+ new' },
      ];
      const domainLanes = { 'README.md': 'docs_assets' as const };

      const result = evaluatePersonaGating({
        persona: perfPersona,
        changedFiles,
        domainLanes,
      });

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('pure documentation or asset');
    });

    it('runs sec-lane when security_auth domain is touched', () => {
      const secPersona = { id: 'sec-lane', charter: 'Security review', paths: ['**/*'] };
      const changedFiles = [
        { path: 'src/auth/jwt.ts', patch: '@@ -1 +1 @@\n- verifyOld()\n+ verifyNew()' },
      ];
      const domainLanes = { 'src/auth/jwt.ts': 'security_auth' as const };

      const result = evaluatePersonaGating({
        persona: secPersona,
        changedFiles,
        domainLanes,
      });

      expect(result.skipped).toBe(false);
      expect(result.weakMatch).toBe(false);
    });

    it('runs sec-lane when sensitive files or manifests are modified', () => {
      const secPersona = { id: 'sec-lane', charter: 'Security review', paths: ['**/*'] };
      const changedFiles = [
        { path: 'package.json', patch: '@@ -1 +1 @@\n- "dep": "1.0"\n+ "dep": "2.0"' },
      ];
      const domainLanes = { 'package.json': 'system_runtime' as const };

      const result = evaluatePersonaGating({
        persona: secPersona,
        changedFiles,
        domainLanes,
      });

      expect(result.skipped).toBe(false);
    });

    it('runs sec-lane when security analyzer pre-checks emit hypotheses', () => {
      const secPersona = { id: 'sec-lane', charter: 'Security review', paths: ['**/*'] };
      const changedFiles = [
        { path: 'src/utils/helpers.ts', patch: '@@ -1 +1 @@\n- a\n+ b' },
      ];
      const domainLanes = { 'src/utils/helpers.ts': 'system_runtime' as const };
      const analyzersPreCheckResult = {
        hypotheses: [
          { analyzer: 'gitleaks', category: 'secrets', message: 'Potential secret found' },
        ],
      } as any;

      const result = evaluatePersonaGating({
        persona: secPersona,
        changedFiles,
        domainLanes,
        analyzersPreCheckResult,
      });

      expect(result.skipped).toBe(false);
    });

    it('runs sec-lane when high-risk patch patterns like eval or SQL are detected', () => {
      const secPersona = { id: 'sec-lane', charter: 'Security review', paths: ['**/*'] };
      const changedFiles = [
        { path: 'src/handler.ts', patch: '@@ -1 +1 @@\n+ const res = eval(payload);' },
      ];
      const domainLanes = { 'src/handler.ts': 'ui_frontend' as const };

      const result = evaluatePersonaGating({
        persona: secPersona,
        changedFiles,
        domainLanes,
      });

      expect(result.skipped).toBe(false);
      expect(result.weakMatch).toBe(false);
    });

    it('marks sec-lane as weak match or skipped on minor non-security code', () => {
      const secPersona = { id: 'sec-lane', charter: 'Security review', paths: ['**/*'] };
      const changedFiles = [
        { path: 'src/components/Button.tsx', patch: '@@ -1,2 +1,2 @@\n- return <button>Old</button>;\n+ return <button>New</button>;' },
      ];
      const domainLanes = { 'src/components/Button.tsx': 'ui_frontend' as const };

      const result = evaluatePersonaGating({
        persona: secPersona,
        changedFiles,
        domainLanes,
      });

      expect(result.skipped).toBe(true);
    });

    it('runs perf-lane when data_persistence lines exceed threshold (>20 lines)', () => {
      const perfPersona = { id: 'perf-lane', charter: 'Performance review', paths: ['**/*'] };
      const addedLines = Array.from({ length: 25 }, (_, i) => `+ line${i}`).join('\n');
      const changedFiles = [
        { path: 'src/repo/queries.ts', patch: `@@ -1,1 +1,26 @@\n${addedLines}` },
      ];
      const domainLanes = { 'src/repo/queries.ts': 'data_persistence' as const };

      const result = evaluatePersonaGating({
        persona: perfPersona,
        changedFiles,
        domainLanes,
      });

      expect(result.skipped).toBe(false);
    });

    it('runs perf-lane when query or loop patterns appear in patch', () => {
      const perfPersona = { id: 'perf-lane', charter: 'Performance review', paths: ['**/*'] };
      const changedFiles = [
        { path: 'src/service.ts', patch: '@@ -1 +1 @@\n+ for (let i = 0; i < items.length; i++) { doWork(); }' },
      ];
      const domainLanes = { 'src/service.ts': 'api_contracts' as const };

      const result = evaluatePersonaGating({
        persona: perfPersona,
        changedFiles,
        domainLanes,
      });

      expect(result.skipped).toBe(false);
      expect(result.weakMatch).toBe(false);
    });

    it('skips perf-lane when no persistence/runtime threshold, hypotheses, or loops exist', () => {
      const perfPersona = { id: 'perf-lane', charter: 'Performance review', paths: ['**/*'] };
      const changedFiles = [
        { path: 'src/constants/labels.ts', patch: '@@ -1 +1 @@\n+ export const TITLE = "My App";' },
      ];
      const domainLanes = { 'src/constants/labels.ts': 'ui_frontend' as const };

      const result = evaluatePersonaGating({
        persona: perfPersona,
        changedFiles,
        domainLanes,
      });

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('no persistence/runtime changes over threshold');
    });
  });

  describe('executePersonaPanel Integration with Gating', () => {
    it('returns notApplicable receipts and skips moderator/arbiter when all personas are gated out on pure docs', async () => {
      const capturedRequests: any[] = [];
      const mockClient = {
        complete: vi.fn(async (req: any) => {
          capturedRequests.push(req);
          const lastMsg = req.messages[req.messages.length - 1]?.content || '';
          const match = String(lastMsg).match(/exact top-level nonce "([^"]+)"/);
          const nonce = match ? match[1] : undefined;
          return {
            model: req.model,
            content: JSON.stringify({ ...(nonce ? { nonce } : {}), decision: 'APPROVE', findings: [] }),
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0,
            raw: {},
          };
        }),
      };

      const config = ctReviewConfigV3Schema.parse({
        ...createDefaultV3Config(),
        pre_checks: {
          classifier: { enabled: false },
          analyzers: { enabled: false },
          zoekt: { enabled: false },
        },
        quorum: 2,
        personas: [
          { id: 'sec-lane', enabled: true, required: true, charter: 'Security review for auth', paths: ['**/*'], providers: ['synthetic-1'] },
          { id: 'perf-lane', enabled: true, required: true, charter: 'Performance review for runtime', paths: ['**/*'], providers: ['synthetic-2'] },
        ],
        reviewers: {
          execution: 'personas',
          fallback: 'none',
          overall_timeout_s: 30,
          providers: [
            { id: 'synthetic-1', enabled: true, model: 'test-model-1', effort: 'medium', review_timeout_s: 30, arbiter_timeout_s: 30 },
            { id: 'synthetic-2', enabled: true, model: 'test-model-2', effort: 'medium', review_timeout_s: 30, arbiter_timeout_s: 30 },
          ],
          arbiter: { order: ['synthetic-1'] },
        },
      });

      const changedFiles = [
        { path: 'README.md', patch: '@@ -1 +1 @@\n- old documentation\n+ new documentation' },
        { path: 'docs/guide.md', patch: '@@ -1 +1 @@\n- step 1\n+ step 1 revised' },
      ];

      const panelResult = await executePersonaPanel({
        config,
        changedFiles,
        repository: 'calltelemetry/review-yeti-bot',
        headSha: 'docs-gating-sha',
        client: mockClient as any,
        requestPolicy: { responseFormat: { type: 'json_object' } },
      });

      // No persona/moderator/arbiter review model requests made
      const reviewRequests = capturedRequests.filter(
        (r) => r.metadata?.role === 'persona' || r.metadata?.role === 'moderator' || r.metadata?.role === 'arbiter'
      );
      expect(reviewRequests.length).toBe(0);

      // Both personas returned notApplicable receipts
      expect(panelResult.personas.length).toBe(2);
      expect(panelResult.personas[0].notApplicable).toBe(true);
      expect(panelResult.personas[0].decision).toBe('APPROVE');
      expect(panelResult.personas[1].notApplicable).toBe(true);
      expect(panelResult.personas[1].decision).toBe('APPROVE');

      // Quorum satisfied with verdict SHIP
      expect(panelResult.quorum.satisfied).toBe(true);
      expect(panelResult.arbiter.verdict).toBe('SHIP');
      expect(panelResult.summary).toContain('not applicable');
    });

    it('adapts quorum when sec-lane is gated out but general persona runs', async () => {
      const capturedRequests: any[] = [];
      const mockClient = {
        complete: vi.fn(async (req: any) => {
          capturedRequests.push(req);
          const role = req.metadata?.persona || req.metadata?.role;
          const lastMsg = req.messages[req.messages.length - 1]?.content || '';
          const match = String(lastMsg).match(/exact top-level nonce "([^"]+)"/);
          const nonce = match ? match[1] : undefined;

          if (role === 'arbiter') {
            return {
              model: req.model,
              content: JSON.stringify({ ...(nonce ? { nonce } : {}), verdict: 'SHIP', rationale: 'Approved' }),
              usage: { prompt: 10, completion: 10, total: 20 },
              costUSD: 0,
              raw: {},
            };
          }
          if (role === 'moderator') {
            return {
              model: req.model,
              content: JSON.stringify({ ...(nonce ? { nonce } : {}), decision: 'RECONCILED', findings: [] }),
              usage: { prompt: 10, completion: 10, total: 20 },
              costUSD: 0,
              raw: {},
            };
          }
          return {
            model: req.model,
            content: JSON.stringify({ ...(nonce ? { nonce } : {}), decision: 'APPROVE', findings: [] }),
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0,
            raw: {},
          };
        }),
      };

      const config = ctReviewConfigV3Schema.parse({
        ...createDefaultV3Config(),
        pre_checks: {
          classifier: { enabled: false },
          analyzers: { enabled: false },
          zoekt: { enabled: false },
        },
        quorum: 2, // Configured quorum is 2, but only 1 lane is applicable
        personas: [
          { id: 'general', enabled: true, required: true, charter: 'General review', paths: ['**/*'], providers: ['synthetic-1'] },
          { id: 'sec-lane', enabled: true, required: true, charter: 'Security review for auth', paths: ['**/*'], providers: ['synthetic-2'] },
        ],
        reviewers: {
          execution: 'personas',
          fallback: 'none',
          overall_timeout_s: 30,
          providers: [
            { id: 'synthetic-1', enabled: true, model: 'test-model-1', effort: 'medium', review_timeout_s: 30, arbiter_timeout_s: 30 },
            { id: 'synthetic-2', enabled: true, model: 'test-model-2', effort: 'medium', review_timeout_s: 30, arbiter_timeout_s: 30 },
          ],
          arbiter: { order: ['synthetic-1'] },
        },
      });

      const changedFiles = [
        { path: 'docs/guide.md', patch: '@@ -1 +1 @@\n- old doc\n+ new doc' },
      ];

      const panelResult = await executePersonaPanel({
        config,
        changedFiles,
        repository: 'calltelemetry/review-yeti-bot',
        headSha: 'mixed-gating-sha',
        client: mockClient as any,
        requestPolicy: { responseFormat: { type: 'json_object' } },
      });

      // sec-lane was skipped with notApplicable
      const secLane = panelResult.personas.find((p) => p.id === 'sec-lane');
      expect(secLane?.notApplicable).toBe(true);

      // general persona ran
      const generalLane = panelResult.personas.find((p) => p.id === 'general');
      expect(generalLane?.notApplicable).toBeUndefined();

      // Quorum was satisfied despite only 1 distinct provider running because effectiveQuorum was bounded to active lanes
      expect(panelResult.quorum.satisfied).toBe(true);
      expect(panelResult.arbiter.verdict).toBe('SHIP');
    });
  });
});
