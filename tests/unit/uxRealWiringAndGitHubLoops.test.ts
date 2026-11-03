import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDashboardRouter } from '../../src/api/dashboardApi';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { evaluateCheckRunAgents, publishCheckRunAgents } from '../../src/github/checkRunAgentExecutor';
import { evaluateApprovability } from '../../src/review/approvabilityEngine';
import { classifyImplicitPRFeedback, recordImplicitPRFeedback } from '../../src/memory/implicitFeedbackLearner';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import type { CustomCheckDefinition } from '../../src/config/reviewYetiDirLoader';

describe('Real UX Backend Wiring & GitHub PR Loops', () => {
  describe('1. Dashboard Settings & Check Run Agents API Persistence', () => {
    let app: express.Express;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use('/api/dashboard', createDashboardRouter());
    });

    it('persists detectionMode, minSeverity, prSummarySync, autoApproveCleanPRs, and spend caps via PUT /api/dashboard/settings', async () => {
      const putRes = await request(app)
        .put('/api/dashboard/settings')
        .send({
          detectionMode: 'deep',
          minSeverity: 'high',
          prSummarySync: false,
          autoApproveCleanPRs: true,
          providerCostCaps: {
            monthlyBudgetUSD: 250,
            perReviewCapUSD: 15,
            perPrCapUSD: 60,
            checkRunPerPrCapUSD: 120,
          },
        });

      expect(putRes.status).toBe(200);
      expect(putRes.body.success).toBe(true);
      expect(putRes.body.settings.detectionMode).toBe('deep');
      expect(putRes.body.settings.minSeverity).toBe('high');
      expect(putRes.body.settings.prSummarySync).toBe(false);
      expect(putRes.body.settings.autoApproveCleanPRs).toBe(true);
      expect(putRes.body.settings.providerCostCaps.monthlyBudgetUSD).toBe(250);
      expect(putRes.body.settings.providerCostCaps.perReviewCapUSD).toBe(15);
      expect(putRes.body.settings.providerCostCaps.perPrCapUSD).toBe(60);
      expect(putRes.body.settings.providerCostCaps.checkRunPerPrCapUSD).toBe(120);

      const getRes = await request(app).get('/api/dashboard/settings');
      expect(getRes.status).toBe(200);
      expect(getRes.body.settings.detectionMode).toBe('deep');
      expect(getRes.body.settings.minSeverity).toBe('high');
      expect(getRes.body.settings.providerCostCaps.perPrCapUSD).toBe(60);

      // Restore defaults
      dashboardStore.updateSettings({
        detectionMode: 'balanced',
        minSeverity: 'medium',
        prSummarySync: true,
        providerCostCaps: {
          monthlyBudgetUSD: 100,
          dailyBudgetUSD: 10,
          alertThresholdPercent: 80,
          actionOnCapBreach: 'fail_closed',
        },
      });
    });

    it('returns configured Check Run Agents via GET /api/dashboard/check-agents', async () => {
      const res = await request(app).get('/api/dashboard/check-agents');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.agents)).toBe(true);
      expect(res.body.agents.length).toBeGreaterThanOrEqual(3);
      expect(res.body.agents[0]).toHaveProperty('id');
      expect(res.body.agents[0]).toHaveProperty('name');
      expect(res.body.agents[0]).toHaveProperty('scope');
    });
  });

  describe('2. Per-File Check Run Agents (.reviewyeti/checks/*.md)', () => {
    const sampleAgents: CustomCheckDefinition[] = [
      {
        id: 'auth-invariants',
        name: 'Auth Boundary Invariants',
        rule: 'Require tenant isolation on all auth endpoints.',
        scope: ['src/auth/**'],
        severity: 'P0',
        action: 'request_changes',
        sourceFile: '.reviewyeti/checks/auth-invariants.md',
      },
      {
        id: 'sql-migrations',
        name: 'SQL Migration Safety',
        rule: 'Disallow locking DDL operations.',
        scope: ['migrations/**'],
        severity: 'P1',
        action: 'request_changes',
        sourceFile: '.reviewyeti/checks/sql-migrations.md',
      },
    ];

    it('evaluates and publishes dedicated GitHub Check Runs only for matching scoped files', async () => {
      const publishNamedCheck = vi.fn().mockResolvedValue(9001);
      const changedFiles = ['src/auth/tokenRefresh.ts', 'src/utils/logger.ts'];
      const findings = [
        {
          path: 'src/auth/tokenRefresh.ts',
          line: 84,
          severity: 'P0',
          title: 'Missing tenantId binding on refresh token rotation',
        },
      ];

      const results = await publishCheckRunAgents({
        publisher: { publishNamedCheck },
        owner: 'reviewyeti-ai',
        repo: 'review-yeti-bot',
        headSha: 'abc12345',
        agents: sampleAgents,
        changedFilePaths: changedFiles,
        findings,
      });

      expect(results).toHaveLength(2);
      const authCheck = results.find((r) => r.agent.id === 'auth-invariants')!;
      const sqlCheck = results.find((r) => r.agent.id === 'sql-migrations')!;

      expect(authCheck.conclusion).toBe('failure');
      expect(authCheck.checkName).toBe('Review Yeti / Auth Boundary Invariants');
      expect(authCheck.violatingFindings).toHaveLength(1);
      expect(authCheck.checkId).toBe(9001);

      // SQL migration check had 0 matching files so it is neutral and skipped from publishing
      expect(sqlCheck.conclusion).toBe('neutral');
      expect(sqlCheck.matchedFiles).toHaveLength(0);
      expect(sqlCheck.checkId).toBeUndefined();
      expect(publishNamedCheck).toHaveBeenCalledTimes(1);
    });
  });

  describe('3. Deterministic Approvability State Machine', () => {
    it('auto-approves when 0 blocking findings and 0 failed check agents exist', () => {
      const decision = evaluateApprovability({
        findings: [
          {
            path: 'src/ui/button.tsx',
            line: 12,
            severity: 'P2',
            title: 'Minor naming preference',
          },
        ],
        minBlockingSeverity: 'medium',
        autoApproveCleanPRs: true,
        priorOpenFindingsCount: 2,
      });

      expect(decision.approved).toBe(true);
      expect(decision.blockingFindingsCount).toBe(0);
      expect(decision.advisoryFindingsCount).toBe(1);
      expect(decision.resolvedSincePriorHeadCount).toBe(2);
      expect(decision.githubReviewEvent).toBe('APPROVE');
      expect(decision.checkConclusion).toBe('success');
      expect(decision.title).toContain('Approved (2 prior issue(s) resolved)');
    });

    it('holds approval when blocking findings at or above minBlockingSeverity remain open', () => {
      const decision = evaluateApprovability({
        findings: [
          {
            path: 'src/auth/token.ts',
            line: 44,
            severity: 'P1',
            title: 'Unchecked signature expiration',
          },
        ],
        minBlockingSeverity: 'medium',
        autoApproveCleanPRs: true,
      });

      expect(decision.approved).toBe(false);
      expect(decision.blockingFindingsCount).toBe(1);
      expect(decision.githubReviewEvent).toBe('COMMENT');
      expect(decision.checkConclusion).toBe('failure');
      expect(decision.title).toContain('Needs Human Approval — 1 blocking issue(s)');
    });
  });

  describe('4. Implicit PR Comment & Reaction Feedback -> Persistent Memory', () => {
    it('records a suppressed nit when a developer reacts with thumbs-down (-1) on a review comment', async () => {
      const store = new PRMemoryStore(':memory:');
      try {
        const res = await recordImplicitPRFeedback({
          repo: 'reviewyeti-ai/review-yeti-bot',
          prNumber: 512,
          reaction: '👎',
          rootCommentBody: '### [P2] Prefer const over let in loop counter',
          filePath: 'src/index.ts',
          memoryStore: store,
        });

        expect(res.recorded).toBe(true);
        expect(res.kind).toBe('suppress_nit');
        expect(res.pattern).toBe('Prefer const over let in loop counter');

        const state = await store.queryLearnings('reviewyeti-ai/review-yeti-bot');
        expect(state.resolvedNits.length).toBe(1);
        expect(state.resolvedNits[0].pattern).toBe('Prefer const over let in loop counter');
      } finally {
        store.close();
      }
    });

    it('records both a learned convention and nit suppression when a developer explains a pattern is intentional', async () => {
      const store = new PRMemoryStore(':memory:');
      try {
        const classification = classifyImplicitPRFeedback(
          'This is intentional by design because worker heartbeats run outside the request transaction.'
        );
        expect(classification.kind).toBe('learn_convention');

        const res = await recordImplicitPRFeedback({
          repo: 'reviewyeti-ai/review-yeti-bot',
          prNumber: 519,
          commentBody: 'This is intentional by design because worker heartbeats run outside the request transaction.',
          rootCommentBody: 'Unawaited heartbeat promise outside transaction scope',
          filePath: 'src/worker/heartbeat.ts',
          memoryStore: store,
        });

        expect(res.recorded).toBe(true);
        expect(res.kind).toBe('learn_convention');
        expect(res.learning?.title).toContain('Unawaited heartbeat promise outside transaction scope');

        const state = await store.queryLearnings('reviewyeti-ai/review-yeti-bot');
        expect(state.learnings.length).toBe(1);
        expect(state.resolvedNits.length).toBe(1);
      } finally {
        store.close();
      }
    });
  });
});
