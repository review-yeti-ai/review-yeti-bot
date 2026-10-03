import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { authService } from '../../src/dashboard/authService';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { computeFindingId } from '../../src/review/findings';
import type { ReviewAuditEvent } from '../../src/types/hitl';

describe('Milestone 3 Iteration 2 Challenger 1: Attribution Fuzzing & Boundary Security Verification', () => {
  let app: any;
  const adminToken = 'sess_fuzz_admin_token_01';
  const reviewerToken = 'sess_fuzz_reviewer_token_01';
  const testRepo = 'exampleorg/example-api';
  const reviewId = 'rev-fuzz-boundary-01';
  const findingId = computeFindingId(testRepo, 'src/api/auth.ts', 42, 'Hardcoded Token Secret');

  const WHITESPACE_SAMPLES = [
    '',
    ' ',
    '   ',
    '\t',
    '\n',
    '\r\n',
    ' \t \r\n ',
    '\u00A0', // Non-breaking space
    '\u2000', // En quad
    '\u2001', // Em quad
    '\u2002', // En space
    '\u2003', // Em space
    '\u2009', // Thin space
    '\u3000', // Ideographic fullwidth space
    ' \u00A0 \t\n \u3000 ', // Mixed Unicode whitespace
  ];

  const NON_STRING_SAMPLES = [
    null,
    undefined,
    0,
    12345,
    -99.9,
    true,
    false,
    [],
    ['alice'],
    {},
    { username: 'alice' },
  ];

  const INJECTION_AND_SPECIAL_SAMPLES = [
    "' OR '1'='1",
    "admin'; DROP TABLE review_audit_events; --",
    '<script>alert("xss")</script>',
    '"><svg onload=alert(1)>',
    '../../../../etc/passwd',
    '$(whoami)',
    'admin\r\nSet-Cookie: evil=true',
    'reviewer_🚀_äöü_Иван_张三_العربية',
    'x'.repeat(255),
    'y'.repeat(1000),
    '__proto__',
    'constructor',
    'toString',
  ];

  beforeEach(() => {
    app = createApp();

    // Register active test sessions
    (authService as any).sessions.set(adminToken, {
      token: adminToken,
      user: { id: 'usr_fuzz_admin', username: 'admin-fuzzer', role: 'admin', email: 'admin@example.com' },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    (authService as any).sessions.set(reviewerToken, {
      token: reviewerToken,
      user: { id: 'usr_fuzz_reviewer', username: 'reviewer-fuzzer', role: 'reviewer', email: 'reviewer@example.com' },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    // Seed test review, gate attempt, and test finding
    dashboardStore.setGateAttempt(reviewId, {
      reviewId,
      runId: reviewId,
      verdict: 'BLOCK',
      desired_state: 'failure',
      desired_version: 1,
      published_version: 1,
      updated_at: new Date().toISOString(),
    });

    dashboardStore.setFinding(reviewId, {
      id: findingId,
      severity: 'P1',
      file: 'src/api/auth.ts',
      line: 42,
      title: 'Hardcoded Token Secret',
      description: 'Potential credential leak in codebase',
      status: 'active',
    });
  });

  afterEach(() => {
    (authService as any).sessions.delete(adminToken);
    (authService as any).sessions.delete(reviewerToken);
  });

  // =========================================================================
  // 1. VULN-M3-01 Remediation: dismissedBy Fuzzing & Rejection
  // =========================================================================
  describe('1. VULN-M3-01 Remediation & dismissedBy Fuzzing', () => {
    it('CHALLENGE_01: Rejects all whitespace-only strings for dismissedBy with HTTP 400', async () => {
      for (const ws of WHITESPACE_SAMPLES) {
        const res = await request(app)
          .post(`/api/reviews/${reviewId}/findings/${findingId}/dismiss`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({
            reason: 'Valid false positive justification',
            dismissedBy: ws,
          });

        expect(
          res.status,
          `Expected HTTP 400 for whitespace dismissedBy ${JSON.stringify(ws)}, got ${res.status}`
        ).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/dismissedBy is required and cannot be empty/i);
      }
    });

    it('CHALLENGE_02: Rejects all non-string and nullish payloads for dismissedBy with HTTP 400', async () => {
      for (const nonStr of NON_STRING_SAMPLES) {
        const res = await request(app)
          .post(`/api/reviews/${reviewId}/findings/${findingId}/dismiss`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({
            reason: 'Valid false positive justification',
            dismissedBy: nonStr,
          });

        expect(
          res.status,
          `Expected HTTP 400 for non-string dismissedBy ${JSON.stringify(nonStr)}, got ${res.status}`
        ).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/dismissedBy is required and cannot be empty/i);
      }
    });

    it('CHALLENGE_03: Aliased /api/dashboard/reviews/... route also rejects invalid dismissedBy with HTTP 400', async () => {
      const res = await request(app)
        .post(`/api/dashboard/reviews/${reviewId}/findings/${findingId}/dismiss`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          reason: 'Valid false positive justification',
          dismissedBy: '   \t  ',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/dismissedBy is required and cannot be empty/i);
    });

    it('CHALLENGE_04: Trims whitespace around valid dismissedBy and stores trimmed non-empty actor', async () => {
      const res = await request(app)
        .post(`/api/reviews/${reviewId}/findings/${findingId}/dismiss`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          reason: 'Valid false positive justification',
          dismissedBy: '   security-auditor-42   ',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const finding = dashboardStore.getFinding(reviewId, findingId);
      expect(finding?.status).toBe('dismissed');
      expect((finding as any)?.dismissedBy).toBe('security-auditor-42');

      const auditTrail = dashboardStore.getAuditTrail(reviewId);
      const dismissEvent = auditTrail.find((e) => e.action === 'finding_dismissed');
      expect(dismissEvent).toBeDefined();
      expect(dismissEvent?.actor).toBe('security-auditor-42');
    });

    it('CHALLENGE_05: Handles injection patterns, long strings, and Unicode characters safely without crash or empty actor', async () => {
      let count = 0;
      for (const pattern of INJECTION_AND_SPECIAL_SAMPLES) {
        count++;
        const customFindingId = computeFindingId(testRepo, 'src/api/auth.ts', 100 + count, `Pattern Test ${count}`);
        dashboardStore.setFinding(reviewId, {
          id: customFindingId,
          severity: 'P2',
          file: 'src/api/auth.ts',
          line: 100 + count,
          title: `Pattern Test ${count}`,
          description: 'Special character testing',
          status: 'active',
        });

        const res = await request(app)
          .post(`/api/reviews/${reviewId}/findings/${customFindingId}/dismiss`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({
            reason: 'Testing special characters and injection payloads',
            dismissedBy: pattern,
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const auditTrail = dashboardStore.getAuditTrail(reviewId);
        const event = auditTrail.find((e) => (e.newState as any)?.findingId === customFindingId);
        expect(event).toBeDefined();
        expect(event?.actor).toBe(pattern.trim());
        expect(event?.actor.length).toBeGreaterThan(0);
      }
    });
  });

  // =========================================================================
  // 2. Attribution Fuzzing: updatedBy in Severity Adjustments
  // =========================================================================
  describe('2. updatedBy Fuzzing & Attribution Integrity (Severity Adjustment)', () => {
    it('CHALLENGE_06: When updatedBy is whitespace-only, safely falls back to req.user.username', async () => {
      for (const ws of WHITESPACE_SAMPLES) {
        const res = await request(app)
          .patch(`/api/reviews/${reviewId}/findings/${findingId}/severity`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({
            severity: 'P0',
            updatedBy: ws,
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const auditTrail = dashboardStore.getAuditTrail(reviewId);
        const latestEvent = auditTrail[auditTrail.length - 1];
        expect(latestEvent.action).toBe('severity_changed');
        expect(latestEvent.actor).toBe('reviewer-fuzzer');
        expect(latestEvent.actor).not.toBe('');
      }
    });

    it('CHALLENGE_07: When updatedBy is non-string or nullish, safely falls back to req.user.username', async () => {
      for (const nonStr of NON_STRING_SAMPLES) {
        const res = await request(app)
          .patch(`/api/reviews/${reviewId}/findings/${findingId}/severity`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({
            severity: 'P2',
            updatedBy: nonStr,
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const auditTrail = dashboardStore.getAuditTrail(reviewId);
        const latestEvent = auditTrail[auditTrail.length - 1];
        expect(latestEvent.action).toBe('severity_changed');
        expect(latestEvent.actor).toBe('reviewer-fuzzer');
      }
    });

    it('CHALLENGE_08: When valid updatedBy is provided, trims and records explicit actor', async () => {
      const res = await request(app)
        .patch(`/api/reviews/${reviewId}/findings/${findingId}/severity`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          severity: 'P0',
          updatedBy: '   custom-triage-lead   ',
        });

      expect(res.status).toBe(200);
      const auditTrail = dashboardStore.getAuditTrail(reviewId);
      const latestEvent = auditTrail[auditTrail.length - 1];
      expect(latestEvent.actor).toBe('custom-triage-lead');
    });
  });

  // =========================================================================
  // 3. Attribution Fuzzing: createdBy in Prompt Steering Guidance
  // =========================================================================
  describe('3. createdBy Fuzzing & Attribution Integrity (Prompt Guidance)', () => {
    it('CHALLENGE_09: When createdBy is whitespace-only, falls back to req.user.username', async () => {
      for (const ws of WHITESPACE_SAMPLES) {
        const res = await request(app)
          .post(`/api/reviews/${reviewId}/guidance`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({
            guidanceText: `Check authentication boundary thoroughly (${Date.now()})`,
            createdBy: ws,
          });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.guidance.createdBy).toBe('reviewer-fuzzer');

        const auditTrail = dashboardStore.getAuditTrail(reviewId);
        const latestEvent = auditTrail[auditTrail.length - 1];
        expect(latestEvent.action).toBe('guidance_added');
        expect(latestEvent.actor).toBe('reviewer-fuzzer');
      }
    });

    it('CHALLENGE_10: When createdBy is non-string or nullish, falls back to req.user.username', async () => {
      for (const nonStr of NON_STRING_SAMPLES) {
        const res = await request(app)
          .post(`/api/reviews/${reviewId}/guidance`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({
            guidanceText: `Verify role escalation controls (${Date.now()})`,
            createdBy: nonStr,
          });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.guidance.createdBy).toBe('reviewer-fuzzer');

        const auditTrail = dashboardStore.getAuditTrail(reviewId);
        const latestEvent = auditTrail[auditTrail.length - 1];
        expect(latestEvent.action).toBe('guidance_added');
        expect(latestEvent.actor).toBe('reviewer-fuzzer');
      }
    });

    it('CHALLENGE_11: When explicit createdBy is provided, trims and records custom author', async () => {
      const res = await request(app)
        .post(`/api/reviews/${reviewId}/guidance`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          guidanceText: 'Enforce principle of least privilege across all controllers',
          createdBy: '   security-architecture-council   ',
        });

      expect(res.status).toBe(201);
      expect(res.body.guidance.createdBy).toBe('security-architecture-council');

      const auditTrail = dashboardStore.getAuditTrail(reviewId);
      const latestEvent = auditTrail[auditTrail.length - 1];
      expect(latestEvent.actor).toBe('security-architecture-council');
    });
  });

  // =========================================================================
  // 4. Attribution Fuzzing: overriddenBy in Verdict Overrides
  // =========================================================================
  describe('4. overriddenBy Fuzzing & Attribution Integrity (Verdict Override)', () => {
    it('CHALLENGE_12: When overriddenBy is whitespace-only, falls back to req.user.username', async () => {
      for (const ws of WHITESPACE_SAMPLES) {
        const res = await request(app)
          .post(`/api/reviews/${reviewId}/override`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            overrideVerdict: 'SHIP',
            reason: 'Authoritative deployment sign-off verified',
            overriddenBy: ws,
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const auditTrail = dashboardStore.getAuditTrail(reviewId);
        const latestEvent = auditTrail[auditTrail.length - 1];
        expect(latestEvent.action).toBe('verdict_overridden');
        expect(latestEvent.actor).toBe('admin-fuzzer');
      }
    });

    it('CHALLENGE_13: When overriddenBy is non-string or nullish, falls back to req.user.username', async () => {
      for (const nonStr of NON_STRING_SAMPLES) {
        const res = await request(app)
          .post(`/api/reviews/${reviewId}/override`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            overrideVerdict: 'BLOCK',
            reason: 'Manual blocking due to unreviewed security concerns',
            overriddenBy: nonStr,
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const auditTrail = dashboardStore.getAuditTrail(reviewId);
        const latestEvent = auditTrail[auditTrail.length - 1];
        expect(latestEvent.action).toBe('verdict_overridden');
        expect(latestEvent.actor).toBe('admin-fuzzer');
      }
    });

    it('CHALLENGE_14: When explicit overriddenBy is provided, trims and records custom override actor', async () => {
      const res = await request(app)
        .post(`/api/reviews/${reviewId}/override`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          overrideVerdict: 'SHIP',
          reason: 'CISO emergency sign-off for critical production incident',
          overriddenBy: '   ciso-oncall   ',
        });

      expect(res.status).toBe(200);
      const auditTrail = dashboardStore.getAuditTrail(reviewId);
      const latestEvent = auditTrail[auditTrail.length - 1];
      expect(latestEvent.actor).toBe('ciso-oncall');
    });
  });

  // =========================================================================
  // 5. Store-Level Defense-in-Depth & Direct Invocation Guardrails
  // =========================================================================
  describe('5. Store-Level Defense-in-Depth (Direct Method Invocations)', () => {
    const directReviewId = 'rev-store-direct-defense-01';
    const directFindingId = computeFindingId(testRepo, 'main.ts', 1, 'Direct Test');

    it('CHALLENGE_15: dashboardStore.dismissFinding sanitizes empty or whitespace dismissedBy to "reviewer"', () => {
      const badActors = ['', '   ', '\t\n', null as any, undefined as any, 12345 as any, {} as any];
      for (const bad of badActors) {
        dashboardStore.dismissFinding(directReviewId, directFindingId, 'Dismiss reason', bad);
        const auditTrail = dashboardStore.getAuditTrail(directReviewId);
        const latest = auditTrail[auditTrail.length - 1];
        expect(latest.actor).toBe('reviewer');
      }
    });

    it('CHALLENGE_16: dashboardStore.updateFindingSeverity sanitizes empty or whitespace updatedBy to "user"', () => {
      const badActors = ['', '   ', '\t\n', null as any, undefined as any, 12345 as any, {} as any];
      for (const bad of badActors) {
        dashboardStore.updateFindingSeverity(directReviewId, directFindingId, 'P0', bad);
        const auditTrail = dashboardStore.getAuditTrail(directReviewId);
        const latest = auditTrail[auditTrail.length - 1];
        expect(latest.actor).toBe('user');
      }
    });

    it('CHALLENGE_17: dashboardStore.addPromptGuidance sanitizes empty or whitespace createdBy to "reviewer"', () => {
      const badActors = ['', '   ', '\t\n', null as any, undefined as any, 12345 as any, {} as any];
      for (const bad of badActors) {
        const item = dashboardStore.addPromptGuidance(directReviewId, 'Direct guidance test', bad);
        expect(item.createdBy).toBe('reviewer');

        const auditTrail = dashboardStore.getAuditTrail(directReviewId);
        const latest = auditTrail[auditTrail.length - 1];
        expect(latest.actor).toBe('reviewer');
      }
    });

    it('CHALLENGE_18: dashboardStore.overrideVerdict sanitizes empty or whitespace overriddenBy to "admin"', () => {
      const badActors = ['', '   ', '\t\n', null as any, undefined as any, 12345 as any, {} as any];
      for (const bad of badActors) {
        const res = dashboardStore.overrideVerdict(directReviewId, 'SHIP', 'Direct reason 12345', bad);
        expect(res.overriddenBy).toBe('admin');

        const auditTrail = dashboardStore.getAuditTrail(directReviewId);
        const latest = auditTrail[auditTrail.length - 1];
        expect(latest.actor).toBe('admin');
      }
    });

    it('CHALLENGE_19: dashboardStore.recordAuditEvent sanitizes string and object signatures against empty actors', () => {
      // 1. String signature with whitespace actor
      dashboardStore.recordAuditEvent(directReviewId, '   \t  ', 'guidance_added', {});
      let auditTrail = dashboardStore.getAuditTrail(directReviewId);
      let latest = auditTrail[auditTrail.length - 1];
      expect(latest.actor).toBe('system');

      // 2. Object signature with whitespace actor
      const rawEvent: ReviewAuditEvent = {
        id: `aud-manual-${Date.now()}`,
        reviewId: directReviewId,
        actor: '   ',
        action: 'verdict_overridden',
        newState: { verdict: 'BLOCK' },
        timestamp: new Date().toISOString(),
      };
      dashboardStore.recordAuditEvent(rawEvent);
      auditTrail = dashboardStore.getAuditTrail(directReviewId);
      latest = auditTrail[auditTrail.length - 1];
      expect(latest.actor).toBe('system');
    });
  });

  // =========================================================================
  // 6. Comprehensive Audit Trail Invariant
  // =========================================================================
  describe('6. Comprehensive Global Audit Trail Invariant', () => {
    it('CHALLENGE_20: ZERO audit events across all reviews possess empty, null, or whitespace-only actor', async () => {
      // Execute a comprehensive series of mutations with various inputs to populate audit trail
      for (let i = 1; i <= 15; i++) {
        const id = computeFindingId(testRepo, 'src/api/auth.ts', 200 + i, `Finding ${i}`);
        dashboardStore.setFinding(reviewId, {
          id,
          severity: 'P1',
          file: 'src/api/auth.ts',
          line: 200 + i,
          title: `Finding ${i}`,
          description: 'Invariant test finding',
          status: 'active',
        });

        // 1. Dismiss finding with trimmed actor
        await request(app)
          .post(`/api/reviews/${reviewId}/findings/${id}/dismiss`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({ reason: `Valid justification ${i}`, dismissedBy: `  auditor-${i}  ` });

        // 2. Severity update with whitespace (should fall back to reviewer-fuzzer)
        await request(app)
          .patch(`/api/reviews/${reviewId}/findings/${id}/severity`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({ severity: 'P0', updatedBy: '   ' });

        // 3. Guidance addition with non-string (should fall back to reviewer-fuzzer)
        await request(app)
          .post(`/api/reviews/${reviewId}/guidance`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({ guidanceText: `Guidance item text ${i} for invariant verification`, createdBy: 12345 });

        // 4. Override with whitespace (should fall back to admin-fuzzer)
        await request(app)
          .post(`/api/reviews/${reviewId}/override`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ overrideVerdict: i % 2 === 0 ? 'SHIP' : 'BLOCK', reason: `Authoritative reason ${i} for invariant`, overriddenBy: '\t  \n' });

        // 5. Direct store recordAuditEvent
        dashboardStore.recordAuditEvent(reviewId, '   \t  ', 'guidance_added', { loop: i });
      }

      const allEventsByReview = (dashboardStore as any).data?.auditEvents || {};
      let totalEventsChecked = 0;

      for (const [rId, events] of Object.entries<ReviewAuditEvent[]>(allEventsByReview)) {
        for (const event of events) {
          totalEventsChecked++;
          expect(typeof event.actor, `Review ${rId} has non-string actor: ${JSON.stringify(event)}`).toBe('string');
          expect(event.actor.trim().length, `Review ${rId} has empty/whitespace actor: ${JSON.stringify(event)}`).toBeGreaterThan(0);
          expect(event.actor, `Review ${rId} actor is literal empty string`).not.toBe('');
          expect(event.id).toMatch(/^aud-/);
          expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
        }
      }

      expect(totalEventsChecked, 'Should have verified multiple recorded audit events').toBeGreaterThan(50);
    });
  });
});
