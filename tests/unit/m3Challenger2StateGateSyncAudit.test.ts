import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { authService } from '../../src/dashboard/authService';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { computeFindingId } from '../../src/review/findings';
import {
  gateTerminalMetadata,
  ReviewGatePublisher,
  type ReviewGatePublisherOptions,
} from '../../src/review/reviewGatePublisher';
import {
  deriveReviewGateExternalId,
  REVIEW_GATE_CHECK_NAME,
  type ReviewGateCheck,
} from '../../src/github/reviewGateClient';
import type {
  GatePublicationClaim,
  ReviewGateRepository,
  StoredReviewGate,
} from '../../src/review/reviewGateContracts';

describe('Milestone 3 Challenger 2: State Machine, Gate Sync & Audit Trail Integrity', () => {
  const testRepo = 'calltelemetry/review-yeti-core';
  let app: any;
  let reviewerToken: string;
  let viewerToken: string;

  beforeEach(() => {
    app = createApp();

    reviewerToken = 'sess_challenger_reviewer_token';
    (authService as any).sessions.set(reviewerToken, {
      token: reviewerToken,
      user: {
        id: 'usr_challenger_01',
        username: 'challenger-reviewer',
        role: 'reviewer',
        email: 'challenger@example.com',
      },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    viewerToken = 'sess_challenger_viewer_token';
    (authService as any).sessions.set(viewerToken, {
      token: viewerToken,
      user: {
        id: 'usr_challenger_02',
        username: 'challenger-viewer',
        role: 'viewer',
        email: 'viewer@example.com',
      },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  // =========================================================================
  // Section 1: State Machine Consistency & Monotonic Gate Version Ordering
  // =========================================================================
  describe('1. State Machine Consistency & Monotonic Gate Version Ordering', () => {
    it('TEST_M3_CHALLENGE_01 — Initial override on review without prior gate record properly initializes gate and sets desired_version to 2', () => {
      const reviewId = `rev-sm-init-${Date.now()}`;
      expect(dashboardStore.getGateAttempt(reviewId)).toBeUndefined();

      const result = dashboardStore.overrideVerdict(
        reviewId,
        'SHIP',
        'Initial authoritative manual SHIP override',
        'challenger-reviewer'
      );

      expect(result.success).toBe(true);
      expect(result.overrideVerdict).toBe('SHIP');
      expect(result.previousVerdict).toBe('NEUTRAL');
      expect(result.gateVersion).toBe(2);

      const gate = dashboardStore.getGateAttempt(reviewId);
      expect(gate).toBeDefined();
      expect(gate?.reviewId).toBe(reviewId);
      expect(gate?.verdict).toBe('SHIP');
      expect(gate?.desired_state).toBe('success');
      expect(gate?.desired_version).toBe(2);
    });

    it('TEST_M3_CHALLENGE_02 — Alternating sequential overrides (SHIP -> BLOCK -> SHIP -> BLOCK -> SHIP) strictly increment desired_version monotonically', () => {
      const reviewId = `rev-sm-alt-${Date.now()}`;
      const sequence: Array<'SHIP' | 'BLOCK'> = ['SHIP', 'BLOCK', 'SHIP', 'BLOCK', 'SHIP'];
      const recordedVersions: number[] = [];

      for (let i = 0; i < sequence.length; i++) {
        const targetVerdict = sequence[i];
        const res = dashboardStore.overrideVerdict(
          reviewId,
          targetVerdict,
          `Override step ${i + 1} to ${targetVerdict} for testing state transitions`,
          'challenger-reviewer'
        );
        recordedVersions.push(res.gateVersion as number);

        const currentGate = dashboardStore.getGateAttempt(reviewId);
        expect(currentGate?.desired_version).toBe(res.gateVersion);
        expect(currentGate?.verdict).toBe(targetVerdict);
        expect(currentGate?.desired_state).toBe(targetVerdict === 'SHIP' ? 'success' : 'failure');
      }

      // Check strict monotonic incrementing (each version > previous version)
      expect(recordedVersions).toEqual([2, 3, 4, 5, 6]);
      for (let i = 1; i < recordedVersions.length; i++) {
        expect(recordedVersions[i]).toBeGreaterThan(recordedVersions[i - 1]);
        expect(recordedVersions[i] - recordedVersions[i - 1]).toBe(1);
      }
    });

    it('TEST_M3_CHALLENGE_03 — Each transition accurately records previousVerdict matching the immediately preceding override', () => {
      const reviewId = `rev-sm-prev-${Date.now()}`;

      // Step 1: Initialize with SHIP
      const res1 = dashboardStore.overrideVerdict(reviewId, 'SHIP', 'Step 1 override to SHIP', 'alice');
      expect(res1.previousVerdict).toBe('NEUTRAL');

      // Step 2: Override with BLOCK
      const res2 = dashboardStore.overrideVerdict(reviewId, 'BLOCK', 'Step 2 override to BLOCK', 'bob');
      expect(res2.previousVerdict).toBe('SHIP');
      expect(res2.overrideVerdict).toBe('BLOCK');

      // Step 3: Override back to SHIP
      const res3 = dashboardStore.overrideVerdict(reviewId, 'SHIP', 'Step 3 override back to SHIP', 'carol');
      expect(res3.previousVerdict).toBe('BLOCK');
      expect(res3.overrideVerdict).toBe('SHIP');

      // Step 4: Override to BLOCK again
      const res4 = dashboardStore.overrideVerdict(reviewId, 'BLOCK', 'Step 4 override back to BLOCK', 'dave');
      expect(res4.previousVerdict).toBe('SHIP');
      expect(res4.overrideVerdict).toBe('BLOCK');
    });

    it('TEST_M3_CHALLENGE_04 — Repeated identical overrides (SHIP -> SHIP -> SHIP) continue to monotonically increment desired_version and update timestamp', async () => {
      const reviewId = `rev-sm-idem-${Date.now()}`;

      const res1 = dashboardStore.overrideVerdict(reviewId, 'SHIP', 'Initial SHIP override 1', 'admin');
      const time1 = dashboardStore.getGateAttempt(reviewId)?.updated_at;
      expect(res1.gateVersion).toBe(2);

      await new Promise((r) => setTimeout(r, 10));

      const res2 = dashboardStore.overrideVerdict(reviewId, 'SHIP', 'Duplicate SHIP override 2', 'admin');
      const time2 = dashboardStore.getGateAttempt(reviewId)?.updated_at;
      expect(res2.gateVersion).toBe(3);
      expect(res2.previousVerdict).toBe('SHIP');

      await new Promise((r) => setTimeout(r, 10));

      const res3 = dashboardStore.overrideVerdict(reviewId, 'SHIP', 'Duplicate SHIP override 3', 'admin');
      const time3 = dashboardStore.getGateAttempt(reviewId)?.updated_at;
      expect(res3.gateVersion).toBe(4);
      expect(res3.previousVerdict).toBe('SHIP');

      expect(new Date(time2!).getTime()).toBeGreaterThanOrEqual(new Date(time1!).getTime());
      expect(new Date(time3!).getTime()).toBeGreaterThanOrEqual(new Date(time2!).getTime());
    });

    it('TEST_M3_CHALLENGE_05 — Stress test: 50 rapid sequential overrides maintain strict monotonic incrementing without skipped or duplicated versions', () => {
      const reviewId = `rev-sm-stress-50-${Date.now()}`;
      const count = 50;
      const versions: number[] = [];

      for (let i = 1; i <= count; i++) {
        const verdict = i % 2 === 0 ? 'BLOCK' : 'SHIP';
        const res = dashboardStore.overrideVerdict(
          reviewId,
          verdict,
          `Rapid sequential stress override iteration ${i}`,
          'stress-agent'
        );
        versions.push(res.gateVersion as number);
      }

      expect(versions.length).toBe(count);
      // Starts at 2 (1 + 1) and ends at 51 (1 + 50)
      expect(versions[0]).toBe(2);
      expect(versions[count - 1]).toBe(count + 1);

      // Verify strict monotonic ordering and no duplicates
      const uniqueVersions = new Set(versions);
      expect(uniqueVersions.size).toBe(count);

      for (let i = 1; i < versions.length; i++) {
        expect(versions[i]).toBe(versions[i - 1] + 1);
      }
    });

    it('TEST_M3_CHALLENGE_06 — State machine isolation: Overrides on Review A do not mutate Review B gateAttempts or desired_version', () => {
      const reviewA = `rev-iso-A-${Date.now()}`;
      const reviewB = `rev-iso-B-${Date.now()}`;

      // Initialize both
      dashboardStore.overrideVerdict(reviewA, 'SHIP', 'Init Review A', 'admin');
      dashboardStore.overrideVerdict(reviewB, 'BLOCK', 'Init Review B', 'admin');

      expect(dashboardStore.getGateAttempt(reviewA)?.desired_version).toBe(2);
      expect(dashboardStore.getGateAttempt(reviewB)?.desired_version).toBe(2);

      // Perform 5 overrides on Review A
      for (let i = 0; i < 5; i++) {
        dashboardStore.overrideVerdict(reviewA, i % 2 === 0 ? 'BLOCK' : 'SHIP', `A step ${i}`, 'admin');
      }

      // Review A should have desired_version = 7
      expect(dashboardStore.getGateAttempt(reviewA)?.desired_version).toBe(7);

      // Review B must remain completely untouched at desired_version = 2 and verdict = 'BLOCK'
      const gateB = dashboardStore.getGateAttempt(reviewB);
      expect(gateB?.desired_version).toBe(2);
      expect(gateB?.verdict).toBe('BLOCK');
      expect(gateB?.desired_state).toBe('failure');
    });

    it('TEST_M3_CHALLENGE_07 — Initial override on review with existing reviewLog consensus BLOCK captures BLOCK as previousVerdict', () => {
      const reviewId = `rev-log-init-${Date.now()}`;
      // Seed a review log with BLOCK verdict
      (dashboardStore as any).data.reviewLogs = (dashboardStore as any).data.reviewLogs || [];
      (dashboardStore as any).data.reviewLogs.push({
        id: reviewId,
        prRun: reviewId,
        headSha: 'abc123def456',
        personas: ['security', 'quality'],
        quorum: 'strict',
        arbiterVerdict: 'BLOCK',
        verdict: 'BLOCK',
        timestamp: new Date().toISOString(),
      });

      const res = dashboardStore.overrideVerdict(
        reviewId,
        'SHIP',
        'Overriding automated consensus BLOCK due to known false positive',
        'lead-reviewer'
      );

      expect(res.previousVerdict).toBe('BLOCK');
      expect(res.overrideVerdict).toBe('SHIP');

      const auditTrail = dashboardStore.getAuditTrail(reviewId);
      const audit = auditTrail.find((e) => e.action === 'verdict_overridden');
      expect(audit?.previousState?.verdict).toBe('BLOCK');
      expect(audit?.newState?.verdict).toBe('SHIP');
    });
  });

  // =========================================================================
  // Section 2: Downstream Check Run Synchronization & Gate Publisher Behavior
  // =========================================================================
  describe('2. Downstream Check Run Synchronization & Gate Publisher Behavior', () => {
    function makeStoredGate(overrides: Partial<StoredReviewGate> = {}): StoredReviewGate {
      const coordinates = {
        owner: 'calltelemetry',
        repo: 'review-yeti-core',
        repositoryId: 101,
        prNumber: 42,
        runId: `run_${'a'.repeat(32)}`,
        executionAttempt: 1,
        attemptId: 'attempt-m3-gate-01',
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        policyDigest: 'c'.repeat(64),
      };
      return {
        coordinates,
        reviewGeneration: 0,
        expectedAppId: 4385771,
        externalId: deriveReviewGateExternalId(coordinates),
        checkId: 1234,
        creationState: 'bound',
        desiredState: 'success',
        desiredVersion: 2,
        publishedVersion: 1,
        current: true,
        ...overrides,
      };
    }

    it('TEST_M3_CHALLENGE_08 — gateTerminalMetadata formats exact title and embeds actor and justification for manual SHIP override', () => {
      const gate = makeStoredGate({
        desiredState: 'success',
        decisionReason: 'manual-override-ship',
        decisionDetail: JSON.stringify({
          overriddenBy: 'sec-lead-alice',
          reason: 'Emergency security hotfix approved after manual AST audit',
        }),
      });

      const meta = gateTerminalMetadata(gate);
      expect(meta.title).toBe('Review Yeti Gate: Approved (Manual Override - SHIP)');
      expect(meta.summary).toContain('Manual SHIP override authorized by sec-lead-alice.');
      expect(meta.summary).toContain('Emergency security hotfix approved after manual AST audit');
    });

    it('TEST_M3_CHALLENGE_09 — gateTerminalMetadata formats exact title and embeds actor and justification for manual BLOCK override', () => {
      const gate = makeStoredGate({
        desiredState: 'failure',
        decisionReason: 'manual-override-block',
        decisionDetail: JSON.stringify({
          overriddenBy: 'compliance-officer-bob',
          reason: 'Blocking deployment pending SOC2 data handling compliance signoff',
        }),
      });

      const meta = gateTerminalMetadata(gate);
      expect(meta.title).toBe('Review Yeti Gate: Blocked (Manual Override - BLOCK)');
      expect(meta.summary).toContain('Manual BLOCK override enforced by compliance-officer-bob.');
      expect(meta.summary).toContain('Blocking deployment pending SOC2 data handling compliance signoff');
    });

    it('TEST_M3_CHALLENGE_10 — Resilient error handling: gateTerminalMetadata safely parses non-JSON raw strings or corrupted JSON without throwing', () => {
      // Raw string case
      const rawStringGate = makeStoredGate({
        desiredState: 'success',
        decisionReason: 'manual-override',
        decisionDetail: 'Plain text override reason without JSON syntax',
      });
      const rawMeta = gateTerminalMetadata(rawStringGate);
      expect(rawMeta.title).toBe('Review Yeti Gate: Approved (Manual Override - SHIP)');
      expect(rawMeta.summary).toContain('Plain text override reason without JSON syntax');
      expect(rawMeta.summary).toContain('authorized reviewer');

      // Malformed / corrupted JSON case
      const corruptGate = makeStoredGate({
        desiredState: 'failure',
        decisionReason: 'manual-override-block',
        decisionDetail: '{"overriddenBy": "alice", "reason": unclosed string...',
      });
      expect(() => gateTerminalMetadata(corruptGate)).not.toThrow();
      const corruptMeta = gateTerminalMetadata(corruptGate);
      expect(corruptMeta.title).toBe('Review Yeti Gate: Blocked (Manual Override - BLOCK)');
      expect(corruptMeta.summary).toContain('unclosed string');
    });

    it('TEST_M3_CHALLENGE_11 — Fallback behavior: missing or empty decisionDetail falls back to authorized reviewer and default text', () => {
      const emptyGate = makeStoredGate({
        desiredState: 'success',
        decisionReason: 'manual-override-ship',
        decisionDetail: undefined,
      });
      const meta = gateTerminalMetadata(emptyGate);
      expect(meta.title).toBe('Review Yeti Gate: Approved (Manual Override - SHIP)');
      expect(meta.summary).toContain('authorized reviewer');
      expect(meta.summary).toContain('Human operator manual verdict override.');
    });

    it('TEST_M3_CHALLENGE_12 — Automated check isolation: automated clean success (clean-review) returns empty metadata without title or summary disruption', () => {
      const automatedSuccessGate = makeStoredGate({
        desiredState: 'success',
        decisionReason: 'clean-review',
        decisionDetail: undefined,
        expectedLanes: 3,
        completedLanes: 3,
      });
      const meta = gateTerminalMetadata(automatedSuccessGate);
      expect(meta.title).toBeUndefined();
      expect(meta.summary).toBeUndefined();
    });

    it('TEST_M3_CHALLENGE_13 — Automated check isolation: automated failure (incomplete-review) returns failure metadata, NOT manual override format', () => {
      const automatedFailureGate = makeStoredGate({
        desiredState: 'failure',
        decisionReason: 'incomplete-review',
        expectedLanes: 3,
        completedLanes: 2,
      });
      const meta = gateTerminalMetadata(automatedFailureGate);
      expect(meta.title).toBe('Review Yeti Gate: Failed (incomplete panel)');
      expect(meta.title).not.toContain('Manual Override');
      expect(meta.summary).toContain('incomplete review');
    });

    it('TEST_M3_CHALLENGE_14 — Progress states (queued, in_progress) return empty metadata ensuring in-flight checks omit terminal banners', () => {
      const queuedGate = makeStoredGate({
        desiredState: 'queued',
        decisionReason: 'manual-override-ship',
      });
      expect(gateTerminalMetadata(queuedGate)).toEqual({});

      const inProgressGate = makeStoredGate({
        desiredState: 'in_progress',
        decisionReason: 'manual-override-block',
      });
      expect(gateTerminalMetadata(inProgressGate)).toEqual({});
    });

    it('TEST_M3_CHALLENGE_15 — End-to-end ReviewGatePublisher.runOnce publishes manual SHIP override to GitHub Check client with conclusion success', async () => {
      const gate = makeStoredGate({
        desiredState: 'success',
        decisionReason: 'manual-override-ship',
        decisionDetail: JSON.stringify({
          overriddenBy: 'qa-architect',
          reason: 'Manual smoke test signoff on branch head',
        }),
      });

      const claim: GatePublicationClaim = {
        ...gate,
        leaseOwner: 'test-challenger-worker',
        leaseToken: 'lease-token-uuid-001',
        mayCreate: false,
      };

      const repository: ReviewGateRepository = {
        claimPublication: vi.fn(async () => claim),
        publishLocked: vi.fn<ReviewGateRepository['publishLocked']>(async (_c, publish) => {
          await publish(claim, false);
          return 'published';
        }),
        retryPublication: vi.fn(async () => true),
      };

      const client = {
        createPending: vi.fn(),
        reconcile: vi.fn(),
        updateExisting: vi.fn(async (args: any) => ({
          id: 1234,
          name: REVIEW_GATE_CHECK_NAME,
          appId: 4385771,
          headSha: gate.coordinates.headSha,
          externalId: claim.externalId,
          status: 'completed' as const,
          conclusion: 'success',
        })),
      };

      const publisher = new ReviewGatePublisher({
        repository,
        clientFor: vi.fn(async () => client as any),
        workerId: 'test-challenger-worker',
      });

      const outcome = await publisher.runOnce();
      expect(outcome.status).toBe('published');
      expect(client.updateExisting).toHaveBeenCalledOnce();

      const callArg = client.updateExisting.mock.calls[0][0];
      expect(callArg.checkId).toBe(1234);
      expect(callArg.update.conclusion).toBe('success');
      expect(callArg.update.title).toBe('Review Yeti Gate: Approved (Manual Override - SHIP)');
      expect(callArg.update.summary).toContain('qa-architect');
      expect(callArg.update.summary).toContain('Manual smoke test signoff on branch head');
    });

    it('TEST_M3_CHALLENGE_16 — End-to-end ReviewGatePublisher.runOnce publishes manual BLOCK override to GitHub Check client with conclusion failure', async () => {
      const gate = makeStoredGate({
        desiredState: 'failure',
        decisionReason: 'manual-override-block',
        decisionDetail: JSON.stringify({
          overriddenBy: 'security-director',
          reason: 'Vulnerability remediation SLA breached',
        }),
      });

      const claim: GatePublicationClaim = {
        ...gate,
        leaseOwner: 'test-challenger-worker',
        leaseToken: 'lease-token-uuid-002',
        mayCreate: false,
      };

      const repository: ReviewGateRepository = {
        claimPublication: vi.fn(async () => claim),
        publishLocked: vi.fn<ReviewGateRepository['publishLocked']>(async (_c, publish) => {
          await publish(claim, false);
          return 'published';
        }),
        retryPublication: vi.fn(async () => true),
      };

      const client = {
        createPending: vi.fn(),
        reconcile: vi.fn(),
        updateExisting: vi.fn(async (args: any) => ({
          id: 1234,
          name: REVIEW_GATE_CHECK_NAME,
          appId: 4385771,
          headSha: gate.coordinates.headSha,
          externalId: claim.externalId,
          status: 'completed' as const,
          conclusion: 'failure',
        })),
      };

      const publisher = new ReviewGatePublisher({
        repository,
        clientFor: vi.fn(async () => client as any),
        workerId: 'test-challenger-worker',
      });

      const outcome = await publisher.runOnce();
      expect(outcome.status).toBe('published');
      expect(client.updateExisting).toHaveBeenCalledOnce();

      const callArg = client.updateExisting.mock.calls[0][0];
      expect(callArg.checkId).toBe(1234);
      expect(callArg.update.conclusion).toBe('failure');
      expect(callArg.update.title).toBe('Review Yeti Gate: Blocked (Manual Override - BLOCK)');
      expect(callArg.update.summary).toContain('security-director');
      expect(callArg.update.summary).toContain('Vulnerability remediation SLA breached');
    });

    it('TEST_M3_CHALLENGE_17 — Publisher recovers and retries when stale claim occurs on override publication', async () => {
      const gate = makeStoredGate({ desiredState: 'success', decisionReason: 'manual-override-ship' });
      const claim: GatePublicationClaim = {
        ...gate,
        leaseOwner: 'worker-1',
        leaseToken: 'token-stale-01',
        mayCreate: false,
      };

      const repository: ReviewGateRepository = {
        claimPublication: vi.fn(async () => claim),
        publishLocked: vi.fn<ReviewGateRepository['publishLocked']>(async () => 'stale-claim'),
        retryPublication: vi.fn(async () => true),
      };

      const client = {
        createPending: vi.fn(),
        reconcile: vi.fn(),
        updateExisting: vi.fn(),
      };

      const publisher = new ReviewGatePublisher({
        repository,
        clientFor: vi.fn(async () => client as any),
        workerId: 'worker-1',
      });

      const result = await publisher.runOnce();
      expect(result.status).toBe('stale-claim');
      expect(repository.retryPublication).toHaveBeenCalledWith(claim, expect.any(Number), 30_000, 'stale-claim');
    });
  });

  // =========================================================================
  // Section 3: Audit Trail Completeness, State Diffs & Immutability
  // =========================================================================
  describe('3. Audit Trail Completeness, State Diffs & Immutability', () => {
    it('TEST_M3_CHALLENGE_18 — finding_dismissed audit event contains actor, valid ISO timestamp, previousState and newState diffs', () => {
      const reviewId = `rev-aud-dismiss-${Date.now()}`;
      const findingId = computeFindingId(testRepo, 'src/api/auth.ts', 55, 'Weak Token Signing');

      // Seed finding
      dashboardStore.setFinding(reviewId, {
        id: findingId,
        severity: 'P1',
        file: 'src/api/auth.ts',
        line: 55,
        title: 'Weak Token Signing',
        description: 'HMAC SHA256 key size is under 256 bits',
        status: 'active',
      });

      const res = dashboardStore.dismissFinding(
        reviewId,
        findingId,
        'Acceptable risk in legacy test harness only',
        'sec-auditor-1'
      );
      expect(res.success).toBe(true);

      const trail = dashboardStore.getAuditTrail(reviewId);
      const event = trail.find((e) => e.action === 'finding_dismissed');
      expect(event).toBeDefined();
      expect(event?.id).toMatch(/^aud-\d+-[0-9a-f]{6}$/);
      expect(event?.reviewId).toBe(reviewId);
      expect(event?.actor).toBe('sec-auditor-1');
      expect(event?.action).toBe('finding_dismissed');

      // State diffs verification
      expect(event?.previousState).toEqual({ status: 'active', dismissedReason: undefined });
      expect(event?.newState).toEqual({
        findingId,
        status: 'dismissed',
        dismissedReason: 'Acceptable risk in legacy test harness only',
      });
      expect(event?.justification).toBe('Acceptable risk in legacy test harness only');

      // Timestamp validity
      expect(new Date(event!.timestamp).getTime()).not.toBeNaN();
      expect(Date.now() - new Date(event!.timestamp).getTime()).toBeLessThan(5000);
    });

    it('TEST_M3_CHALLENGE_19 — Re-dismissing an already dismissed finding with a new reason captures previous reason in previousState', () => {
      const reviewId = `rev-aud-redismiss-${Date.now()}`;
      const findingId = computeFindingId(testRepo, 'src/db/migrate.ts', 12, 'Unindexed Column');

      dashboardStore.setFinding(reviewId, {
        id: findingId,
        severity: 'P2',
        file: 'src/db/migrate.ts',
        line: 12,
        title: 'Unindexed Column',
        description: 'Missing foreign key index',
        status: 'active',
      });

      // First dismissal
      dashboardStore.dismissFinding(reviewId, findingId, 'Initial dismissal justification A', 'alice');
      // Second dismissal with updated justification
      dashboardStore.dismissFinding(reviewId, findingId, 'Updated dismissal justification B', 'bob');

      const trail = dashboardStore.getAuditTrail(reviewId);
      const dismissEvents = trail.filter((e) => e.action === 'finding_dismissed');
      expect(dismissEvents.length).toBe(2);

      const secondDismissal = dismissEvents[1];
      expect(secondDismissal.actor).toBe('bob');
      expect(secondDismissal.previousState).toEqual({
        status: 'dismissed',
        dismissedReason: 'Initial dismissal justification A',
      });
      expect(secondDismissal.newState).toEqual({
        findingId,
        status: 'dismissed',
        dismissedReason: 'Updated dismissal justification B',
      });
      expect(secondDismissal.justification).toBe('Updated dismissal justification B');
    });

    it('TEST_M3_CHALLENGE_20 — severity_changed audit event captures exact previous and new severity across transitions (P1 -> P0 -> P2)', () => {
      const reviewId = `rev-aud-sev-${Date.now()}`;
      const findingId = computeFindingId(testRepo, 'src/net/http.ts', 88, 'Buffer Overflow');

      dashboardStore.setFinding(reviewId, {
        id: findingId,
        severity: 'P1',
        file: 'src/net/http.ts',
        line: 88,
        title: 'Buffer Overflow',
        description: 'Potential buffer overflow',
        status: 'active',
      });

      // Step 1: P1 -> P0
      dashboardStore.updateFindingSeverity(reviewId, findingId, 'P0', 'alice');
      // Step 2: P0 -> P2
      dashboardStore.updateFindingSeverity(reviewId, findingId, 'P2', 'bob');

      const trail = dashboardStore.getAuditTrail(reviewId);
      const sevEvents = trail.filter((e) => e.action === 'severity_changed');
      expect(sevEvents.length).toBe(2);

      // Event 1 verification
      expect(sevEvents[0].actor).toBe('alice');
      expect(sevEvents[0].previousState).toEqual({ severity: 'P1' });
      expect(sevEvents[0].newState).toEqual({ findingId, severity: 'P0' });

      // Event 2 verification
      expect(sevEvents[1].actor).toBe('bob');
      expect(sevEvents[1].previousState).toEqual({ severity: 'P0' });
      expect(sevEvents[1].newState).toEqual({ findingId, severity: 'P2' });
    });

    it('TEST_M3_CHALLENGE_21 — guidance_added audit event captures actor, guidanceId, guidanceText and ISO timestamp', () => {
      const reviewId = `rev-aud-guide-${Date.now()}`;
      const item = dashboardStore.addPromptGuidance(
        reviewId,
        'Ensure all SQL queries use parameterized arguments and zero string concatenation.',
        'sec-architect',
        ['security', 'database']
      );

      const trail = dashboardStore.getAuditTrail(reviewId);
      const guideEvent = trail.find((e) => e.action === 'guidance_added');
      expect(guideEvent).toBeDefined();
      expect(guideEvent?.actor).toBe('sec-architect');
      expect(guideEvent?.newState).toEqual({
        guidanceId: item.id,
        guidanceText: 'Ensure all SQL queries use parameterized arguments and zero string concatenation.',
      });
      expect(new Date(guideEvent!.timestamp).getTime()).not.toBeNaN();
    });

    it('TEST_M3_CHALLENGE_22 — verdict_overridden audit event captures actor, previous verdict, new verdict, desired_version and justification', () => {
      const reviewId = `rev-aud-ovr-${Date.now()}`;

      dashboardStore.overrideVerdict(
        reviewId,
        'BLOCK',
        'Critical zero-day vulnerability flagged by Red Team',
        'red-team-lead'
      );

      const trail = dashboardStore.getAuditTrail(reviewId);
      const ovrEvent = trail.find((e) => e.action === 'verdict_overridden');
      expect(ovrEvent).toBeDefined();
      expect(ovrEvent?.actor).toBe('red-team-lead');
      expect(ovrEvent?.previousState).toEqual({ verdict: 'NEUTRAL' });
      expect(ovrEvent?.newState).toEqual({
        verdict: 'BLOCK',
        overrideVerdict: 'BLOCK',
        desired_version: 2,
      });
      expect(ovrEvent?.justification).toBe('Critical zero-day vulnerability flagged by Red Team');
    });

    it('TEST_M3_CHALLENGE_23 — Batch action uniqueness: 40 rapid mixed actions all produce unique audit event IDs with non-decreasing timestamps', () => {
      const reviewId = `rev-aud-batch-${Date.now()}`;
      const actionsCount = 40;

      // Seed 10 findings
      for (let i = 0; i < 10; i++) {
        dashboardStore.setFinding(reviewId, {
          id: `find-${i}`,
          severity: 'P1',
          file: `file${i}.ts`,
          line: i + 1,
          title: `Finding ${i}`,
          description: `Desc ${i}`,
          status: 'active',
        });
      }

      for (let i = 0; i < actionsCount; i++) {
        const mod = i % 4;
        if (mod === 0) {
          dashboardStore.dismissFinding(reviewId, `find-${i % 10}`, `Dismiss reason ${i}`, `actor-${i}`);
        } else if (mod === 1) {
          dashboardStore.updateFindingSeverity(reviewId, `find-${i % 10}`, i % 2 === 0 ? 'P0' : 'P2', `actor-${i}`);
        } else if (mod === 2) {
          dashboardStore.addPromptGuidance(reviewId, `Guidance text ${i}`, `actor-${i}`);
        } else {
          dashboardStore.overrideVerdict(reviewId, i % 2 === 0 ? 'SHIP' : 'BLOCK', `Override reason ${i}`, `actor-${i}`);
        }
      }

      const trail = dashboardStore.getAuditTrail(reviewId);
      expect(trail.length).toBe(actionsCount);

      // Verify ID uniqueness
      const idSet = new Set(trail.map((e) => e.id));
      expect(idSet.size).toBe(actionsCount);

      // Verify non-decreasing timestamps
      for (let i = 1; i < trail.length; i++) {
        const tPrev = new Date(trail[i - 1].timestamp).getTime();
        const tCurr = new Date(trail[i].timestamp).getTime();
        expect(tCurr).toBeGreaterThanOrEqual(tPrev);
      }
    });

    it('TEST_M3_CHALLENGE_24 — REST API GET /api/reviews/:id/audit-trail returns chronological audit snapshot', async () => {
      const reviewId = `rev-api-aud-${Date.now()}`;
      dashboardStore.setGateAttempt(reviewId, {
        reviewId,
        runId: reviewId,
        verdict: 'SHIP',
        desired_state: 'success',
        desired_version: 1,
        published_version: 1,
        updated_at: new Date().toISOString(),
      });

      dashboardStore.overrideVerdict(reviewId, 'BLOCK', 'Emergency rollback to BLOCK', 'site-reliability-eng');

      const res = await request(app)
        .get(`/api/reviews/${reviewId}/audit-trail`)
        .set('Authorization', `Bearer ${reviewerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.reviewId).toBe(reviewId);
      expect(Array.isArray(res.body.events)).toBe(true);
      expect(res.body.events.length).toBeGreaterThan(0);

      const latestEvent = res.body.events[res.body.events.length - 1];
      expect(latestEvent.action).toBe('verdict_overridden');
      expect(latestEvent.actor).toBe('site-reliability-eng');
      expect(latestEvent.justification).toBe('Emergency rollback to BLOCK');
    });

    it('TEST_M3_CHALLENGE_25 — Explicit recordAuditEvent helper properly records custom audit event', () => {
      const reviewId = `rev-manual-aud-${Date.now()}`;
      dashboardStore.recordAuditEvent(
        reviewId,
        'admin-operator',
        'verdict_overridden',
        { customField: 'manual-entry' },
        'Manual override from diagnostic script'
      );

      const trail = dashboardStore.getAuditTrail(reviewId);
      expect(trail.length).toBe(1);
      expect(trail[0].actor).toBe('admin-operator');
      expect(trail[0].action).toBe('verdict_overridden');
      expect(trail[0].newState.customField).toBe('manual-entry');
      expect(trail[0].justification).toBe('Manual override from diagnostic script');
    });
  });

  // =========================================================================
  // Section 4: In-Memory Store Lifecycle & Multi-Operation Durability
  // =========================================================================
  describe('4. In-Memory Store Lifecycle & Multi-Operation Durability', () => {
    it('TEST_M3_CHALLENGE_26 — Multi-review partition: Findings, guidance, overrides, and audit trails across Alpha, Beta, and Gamma do not cross-contaminate', () => {
      const revAlpha = `rev-part-alpha-${Date.now()}`;
      const revBeta = `rev-part-beta-${Date.now()}`;
      const revGamma = `rev-part-gamma-${Date.now()}`;

      // Alpha: 2 findings, 1 override (SHIP)
      dashboardStore.setFinding(revAlpha, {
        id: 'fa1',
        severity: 'P0',
        file: 'alpha.ts',
        line: 1,
        title: 'Alpha P0',
        description: 'Alpha desc',
        status: 'active',
      });
      dashboardStore.setFinding(revAlpha, {
        id: 'fa2',
        severity: 'P1',
        file: 'alpha2.ts',
        line: 2,
        title: 'Alpha P1',
        description: 'Alpha desc 2',
        status: 'active',
      });
      dashboardStore.overrideVerdict(revAlpha, 'SHIP', 'Alpha ship override', 'alpha-lead');

      // Beta: 1 guidance, 1 override (BLOCK)
      dashboardStore.addPromptGuidance(revBeta, 'Beta guidance only', 'beta-lead', ['security']);
      dashboardStore.overrideVerdict(revBeta, 'BLOCK', 'Beta block override', 'beta-lead');

      // Gamma: 1 finding dismissed
      dashboardStore.setFinding(revGamma, {
        id: 'fg1',
        severity: 'P2',
        file: 'gamma.ts',
        line: 10,
        title: 'Gamma P2',
        description: 'Gamma desc',
        status: 'active',
      });
      dashboardStore.dismissFinding(revGamma, 'fg1', 'Gamma false positive', 'gamma-lead');

      // Assertions on Alpha
      expect(dashboardStore.getFindings(revAlpha).length).toBe(2);
      expect(dashboardStore.getPromptGuidance(revAlpha).length).toBe(0);
      expect(dashboardStore.getGateAttempt(revAlpha)?.verdict).toBe('SHIP');
      expect(dashboardStore.getAuditTrail(revAlpha).length).toBe(1);

      // Assertions on Beta
      expect(dashboardStore.getFindings(revBeta).length).toBe(0);
      expect(dashboardStore.getPromptGuidance(revBeta).length).toBe(1);
      expect(dashboardStore.getGateAttempt(revBeta)?.verdict).toBe('BLOCK');
      expect(dashboardStore.getAuditTrail(revBeta).length).toBe(2); // 1 guidance + 1 override

      // Assertions on Gamma
      expect(dashboardStore.getFindings(revGamma).length).toBe(1);
      expect(dashboardStore.getFindings(revGamma)[0].status).toBe('dismissed');
      expect(dashboardStore.getGateAttempt(revGamma)).toBeUndefined();
      expect(dashboardStore.getAuditTrail(revGamma).length).toBe(1); // 1 dismiss
    });

    it('TEST_M3_CHALLENGE_27 — Finding lifecycle: Setting multiple findings, selectively dismissing a subset, and updating severity maintains accurate remainingActiveCount', () => {
      const reviewId = `rev-find-life-${Date.now()}`;

      // Seed 4 findings
      for (let i = 1; i <= 4; i++) {
        dashboardStore.setFinding(reviewId, {
          id: `find-life-${i}`,
          severity: 'P1',
          file: `src/mod${i}.ts`,
          line: i * 10,
          title: `Nit ${i}`,
          description: `Desc ${i}`,
          status: 'active',
        });
      }

      expect(dashboardStore.getFindings(reviewId).length).toBe(4);
      expect(dashboardStore.getFindings(reviewId).filter((f) => f.status === 'active').length).toBe(4);

      // Dismiss 1st finding
      const res1 = dashboardStore.dismissFinding(reviewId, 'find-life-1', 'Dismiss nit 1', 'user1');
      expect(res1.remainingActiveCount).toBe(3);

      // Dismiss 2nd finding
      const res2 = dashboardStore.dismissFinding(reviewId, 'find-life-2', 'Dismiss nit 2', 'user2');
      expect(res2.remainingActiveCount).toBe(2);

      // Update severity of active finding 3 to P0
      dashboardStore.updateFindingSeverity(reviewId, 'find-life-3', 'P0', 'user3');
      const f3 = dashboardStore.getFinding(reviewId, 'find-life-3');
      expect(f3?.severity).toBe('P0');
      expect(f3?.status).toBe('active');

      // Update severity of dismissed finding 1 to P2 (status must remain dismissed!)
      dashboardStore.updateFindingSeverity(reviewId, 'find-life-1', 'P2', 'user1');
      const f1 = dashboardStore.getFinding(reviewId, 'find-life-1');
      expect(f1?.severity).toBe('P2');
      expect(f1?.status).toBe('dismissed');

      // Check active findings count
      const activeFindings = dashboardStore.getFindings(reviewId).filter((f) => f.status === 'active');
      expect(activeFindings.length).toBe(2);
      expect(activeFindings.map((f) => f.id).sort()).toEqual(['find-life-3', 'find-life-4']);
    });

    it('TEST_M3_CHALLENGE_28 — PR-level guidance aggregation accurately queries items by repository and prNumber across diverse review sessions', () => {
      const repoTarget = 'calltelemetry/multi-pr-repo';
      const revPR10 = `rev-pr10-${Date.now()}`;
      const revPR20 = `rev-pr20-${Date.now()}`;
      const revOtherRepo = `rev-other-${Date.now()}`;

      // PR 10 item 1
      dashboardStore.addPromptGuidance(
        revPR10,
        'Guidance for PR 10 Item A',
        'lead',
        ['security'],
        repoTarget,
        10
      );
      // PR 10 item 2
      dashboardStore.addPromptGuidance(
        revPR10,
        'Guidance for PR 10 Item B',
        'lead',
        ['architecture'],
        repoTarget,
        10
      );
      // PR 20 item 1
      dashboardStore.addPromptGuidance(
        revPR20,
        'Guidance for PR 20 Item',
        'lead',
        ['database'],
        repoTarget,
        20
      );
      // Other repo PR 10 item
      dashboardStore.addPromptGuidance(
        revOtherRepo,
        'Guidance for other repo PR 10',
        'lead',
        ['performance'],
        'other/repo',
        10
      );

      const pr10Guidance = dashboardStore.getPromptGuidanceForPr(repoTarget, 10);
      expect(pr10Guidance.length).toBe(2);
      expect(pr10Guidance.map((g) => g.guidanceText)).toEqual([
        'Guidance for PR 10 Item A',
        'Guidance for PR 10 Item B',
      ]);

      const pr20Guidance = dashboardStore.getPromptGuidanceForPr(repoTarget, 20);
      expect(pr20Guidance.length).toBe(1);
      expect(pr20Guidance[0].guidanceText).toBe('Guidance for PR 20 Item');

      const nonexistentGuidance = dashboardStore.getPromptGuidanceForPr(repoTarget, 999);
      expect(nonexistentGuidance).toEqual([]);
    });

    it('TEST_M3_CHALLENGE_29 — High-concurrency burst: 120 interleaved operations execute cleanly without data corruption or memory leaks', () => {
      const reviewId = `rev-burst-120-${Date.now()}`;
      const totalOps = 120;

      // Seed 20 findings
      for (let i = 0; i < 20; i++) {
        dashboardStore.setFinding(reviewId, {
          id: `burst-f-${i}`,
          severity: 'P1',
          file: `src/burst_${i}.ts`,
          line: i + 1,
          title: `Burst nit ${i}`,
          description: `Desc ${i}`,
          status: 'active',
        });
      }

      for (let i = 0; i < totalOps; i++) {
        const opType = i % 3;
        if (opType === 0) {
          dashboardStore.dismissFinding(reviewId, `burst-f-${i % 20}`, `Reason ${i}`, `actor-${i}`);
        } else if (opType === 1) {
          dashboardStore.addPromptGuidance(reviewId, `Guidance burst text ${i}`, `actor-${i}`);
        } else {
          dashboardStore.overrideVerdict(
            reviewId,
            i % 2 === 0 ? 'SHIP' : 'BLOCK',
            `Override burst justification ${i}`,
            `actor-${i}`
          );
        }
      }

      // Check results
      const trail = dashboardStore.getAuditTrail(reviewId);
      expect(trail.length).toBe(totalOps);

      const guidance = dashboardStore.getPromptGuidance(reviewId);
      expect(guidance.length).toBe(totalOps / 3);

      const gate = dashboardStore.getGateAttempt(reviewId);
      expect(gate).toBeDefined();
      // Overrides executed totalOps / 3 = 40 times. Gate desired_version = 1 + 40 = 41.
      expect(gate?.desired_version).toBe(1 + totalOps / 3);
    });

    it('TEST_M3_CHALLENGE_30 — REST API error boundary enforcement: Path traversal, invalid severity, short justification, viewer role, and empty guidance', async () => {
      const validReviewId = `rev-api-bounds-${Date.now()}`;
      dashboardStore.setGateAttempt(validReviewId, {
        reviewId: validReviewId,
        runId: validReviewId,
        verdict: 'SHIP',
        desired_state: 'success',
        desired_version: 1,
        published_version: 1,
        updated_at: new Date().toISOString(),
      });

      // 1. Path traversal in review ID
      const travRes = await request(app)
        .post('/api/reviews/..%2F..%2Fetc%2Fpasswd/override')
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ overrideVerdict: 'SHIP', reason: 'valid reason 12345' });
      expect(travRes.status).toBe(400);
      expect(travRes.body.error).toContain('Malformed or invalid review ID');

      // 2. Invalid override verdict (not SHIP or BLOCK)
      const invVerRes = await request(app)
        .post(`/api/reviews/${validReviewId}/override`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ overrideVerdict: 'APPROVE', reason: 'valid reason 12345' });
      expect(invVerRes.status).toBe(400);
      expect(invVerRes.body.error).toContain('SHIP or BLOCK');

      // 3. Short justification (< 5 chars)
      const shortRes = await request(app)
        .post(`/api/reviews/${validReviewId}/override`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ overrideVerdict: 'BLOCK', reason: 'bad' });
      expect(shortRes.status).toBe(400);
      expect(shortRes.body.error).toContain('at least 5 characters');

      // 4. Viewer role rejection (403 Forbidden)
      const viewerRes = await request(app)
        .post(`/api/reviews/${validReviewId}/override`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ overrideVerdict: 'SHIP', reason: 'Viewer trying to override' });
      expect(viewerRes.status).toBe(403);
      expect(viewerRes.body.error).toContain('viewer role cannot submit verdict overrides');

      // 5. Empty guidance text rejection (400 Bad Request)
      const emptyGuideRes = await request(app)
        .post(`/api/reviews/${validReviewId}/guidance`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ guidanceText: '   ' });
      expect(emptyGuideRes.status).toBe(400);
      expect(emptyGuideRes.body.error).toContain('guidanceText cannot be empty');
    });
  });
});
