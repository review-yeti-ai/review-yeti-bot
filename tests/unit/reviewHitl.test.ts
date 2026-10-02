import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { computeFindingId } from '../../src/review/findings';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { createApp } from '../../src/app';
import { authService } from '../../src/dashboard/authService';

describe('Human-in-the-Loop (HITL) Controls, Verdict Overrides & Audit Persistence', () => {
  const testRepo = 'calltelemetry/test-repo';
  const testFile = 'src/security/auth.ts';
  const testLine = 42;
  const testTitle = 'Insecure Token Generation';
  let app: any;
  let reviewerToken: string;
  let viewerToken: string;

  beforeEach(() => {
    app = createApp();

    // Create test sessions
    reviewerToken = 'sess_reviewer_token_123';
    (authService as any).sessions.set(reviewerToken, {
      token: reviewerToken,
      user: { id: 'usr_reviewer_01', username: 'reviewer-alice', role: 'reviewer', email: 'alice@example.com' },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    viewerToken = 'sess_viewer_test_token_123';
    (authService as any).sessions.set(viewerToken, {
      token: viewerToken,
      user: { id: 'usr_viewer_01', username: 'viewer-bob', role: 'viewer', email: 'bob@example.com' },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  describe('1. Deterministic Finding ID Generation', () => {
    it('computes 64-character sha256 hex string from repo, file, line, title', () => {
      const id = computeFindingId(testRepo, testFile, testLine, testTitle);
      expect(id).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is completely deterministic across repeated invocations', () => {
      const id1 = computeFindingId(testRepo, testFile, testLine, testTitle);
      const id2 = computeFindingId(testRepo, testFile, testLine, testTitle);
      expect(id1).toBe(id2);
    });

    it('produces distinct hash values when any single component changes', () => {
      const base = computeFindingId(testRepo, testFile, testLine, testTitle);
      const diffRepo = computeFindingId('other/repo', testFile, testLine, testTitle);
      const diffFile = computeFindingId(testRepo, 'src/other.ts', testLine, testTitle);
      const diffLine = computeFindingId(testRepo, testFile, 43, testTitle);
      const diffTitle = computeFindingId(testRepo, testFile, testLine, 'Different Title');

      expect(base).not.toBe(diffRepo);
      expect(base).not.toBe(diffFile);
      expect(base).not.toBe(diffLine);
      expect(base).not.toBe(diffTitle);
    });
  });

  describe('2. DashboardStore HITL State Mutations & Audit Trail', () => {
    const reviewId = 'rev-hitl-unit-01';

    it('dismisses finding and records audit event in store', async () => {
      const findingId = computeFindingId(testRepo, testFile, 10, 'Hardcoded Secret');
      const res = await dashboardStore.dismissFinding(
        reviewId,
        findingId,
        'False positive - test fixture credential',
        'reviewer-alice'
      );
      expect(res.success).toBe(true);
      expect(res.status).toBe('dismissed');

      const finding = await dashboardStore.getFinding(reviewId, findingId);
      expect(finding).toBeDefined();
      expect(finding?.status).toBe('dismissed');
      expect(finding?.dismissedReason).toBe('False positive - test fixture credential');
      expect((finding as any)?.dismissedBy).toBe('reviewer-alice');

      const auditTrail = await dashboardStore.getAuditTrail(reviewId);
      expect(auditTrail.length).toBeGreaterThan(0);
      const event = auditTrail.find((e) => (e.newState as any)?.findingId === findingId);
      expect(event).toBeDefined();
      expect(event?.action).toBe('finding_dismissed');
      expect(event?.actor).toBe('reviewer-alice');
    });

    it('adjusts finding severity and tracks previous severity', async () => {
      const findingId = computeFindingId(testRepo, testFile, 25, 'Weak Hash Algorithm');
      const res = await dashboardStore.updateFindingSeverity(reviewId, findingId, 'P0', 'reviewer-alice');
      expect(res.findingId).toBe(findingId);
      expect(res.severity).toBe('P0');

      const auditTrail = await dashboardStore.getAuditTrail(reviewId);
      const event = auditTrail.find((e) => e.action === 'severity_changed');
      expect(event).toBeDefined();
      expect(event?.action).toBe('severity_changed');
      expect((event?.newState as any)?.severity).toBe('P0');
    });

    it('adds and retrieves prompt steering guidance items', async () => {
      const item = await dashboardStore.addPromptGuidance(
        reviewId,
        'Focus strictly on SQL injection in repositories with postgres schemas',
        ['security', 'database'],
        'reviewer-alice',
        testRepo,
        101
      );

      expect(item.id).toBeDefined();
      expect(item.reviewId).toBe(reviewId);
      expect(item.guidanceText).toContain('SQL injection');
      expect(item.targetPersonas).toEqual(['security', 'database']);
      expect(item.createdBy).toBe('reviewer-alice');

      const guidanceList = await dashboardStore.getPromptGuidance(reviewId);
      expect(guidanceList.some((g) => g.id === item.id)).toBe(true);

      const prGuidance = await dashboardStore.getPromptGuidanceForPr(testRepo, 101);
      expect(prGuidance.some((g) => g.id === item.id)).toBe(true);
    });

    it('records authoritative verdict override and synchronizes gate attempt version', async () => {
      const overrideRes = await dashboardStore.overrideVerdict(
        reviewId,
        'SHIP',
        'Emergency hotfix deployment approved by security architect',
        'reviewer-alice'
      );

      expect(overrideRes.reviewId).toBe(reviewId);
      expect(overrideRes.overrideVerdict).toBe('SHIP');
      expect(overrideRes.gateVersion).toBeGreaterThanOrEqual(1);

      const gateAttempt = await dashboardStore.getGateAttempt(reviewId);
      expect(gateAttempt).toBeDefined();
      expect(gateAttempt?.verdict).toBe('SHIP');
      expect(gateAttempt?.desired_state).toBe('success');
      expect(gateAttempt?.desired_version).toBe(overrideRes.gateVersion);

      const auditTrail = await dashboardStore.getAuditTrail(reviewId);
      const event = auditTrail.find((e) => e.action === 'verdict_overridden');
      expect(event).toBeDefined();
      expect((event?.newState as any)?.overrideVerdict).toBe('SHIP');
      expect(event?.justification).toContain('Emergency hotfix');
    });
  });

  describe('3. REST API HITL Endpoints & Access Control', () => {
    const reviewId = 'rev-api-unit-test-42';

    beforeEach(() => {
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
        id: computeFindingId(testRepo, 'index.ts', 1, 'Unit Finding'),
        severity: 'P1',
        file: 'index.ts',
        line: 1,
        title: 'Unit Finding',
        description: 'Test finding description',
        status: 'active',
      });

      dashboardStore.setFinding(reviewId, {
        id: computeFindingId(testRepo, 'app.ts', 99, 'Severity Shift'),
        severity: 'P1',
        file: 'app.ts',
        line: 99,
        title: 'Severity Shift',
        description: 'Test finding description',
        status: 'active',
      });
    });

    it('POST /api/reviews/:reviewId/findings/:findingId/dismiss successfully dismisses finding', async () => {
      const findingId = computeFindingId(testRepo, 'index.ts', 1, 'Unit Finding');
      const res = await request(app)
        .post(`/api/reviews/${reviewId}/findings/${findingId}/dismiss`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          reason: 'Expected behavior in test suite',
          dismissedBy: 'reviewer-alice',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.findingId).toBe(findingId);
      expect(res.body.status).toBe('dismissed');
    });

    it('POST /api/reviews/:reviewId/findings/:findingId/dismiss returns 400 when reason is missing', async () => {
      const findingId = 'some-finding-id';
      const res = await request(app)
        .post(`/api/reviews/${reviewId}/findings/${findingId}/dismiss`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('reason');
    });

    it('POST /api/reviews/:reviewId/findings/:findingId/dismiss rejects whitespace-only dismissedBy with 400', async () => {
      const findingId = computeFindingId(testRepo, 'index.ts', 1, 'Unit Finding');
      const res = await request(app)
        .post(`/api/reviews/${reviewId}/findings/${findingId}/dismiss`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          reason: 'Valid reason',
          dismissedBy: '   \t  ',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('cannot be empty');
    });

    it('PATCH /api/reviews/:reviewId/findings/:findingId/severity updates severity to P0', async () => {
      const findingId = computeFindingId(testRepo, 'app.ts', 99, 'Severity Shift');
      const res = await request(app)
        .patch(`/api/reviews/${reviewId}/findings/${findingId}/severity`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          severity: 'P0',
          updatedBy: 'reviewer-alice',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.severity).toBe('P0');
    });

    it('PATCH /api/reviews/:reviewId/findings/:findingId/severity sanitizes updatedBy or falls back to req.user.username', async () => {
      const findingId = computeFindingId(testRepo, 'app.ts', 99, 'Severity Shift');
      const res = await request(app)
        .patch(`/api/reviews/${reviewId}/findings/${findingId}/severity`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          severity: 'P0',
          updatedBy: '   ', // whitespace only -> fallback to reviewer-alice
        });

      expect(res.status).toBe(200);
      const auditTrail = dashboardStore.getAuditTrail(reviewId);
      const event = auditTrail.find((e) => e.action === 'severity_changed');
      expect(event?.actor).toBe('reviewer-alice');
    });

    it('PATCH /api/reviews/:reviewId/findings/:findingId/severity returns 400 for invalid severity', async () => {
      const findingId = 'some-finding';
      const res = await request(app)
        .patch(`/api/reviews/${reviewId}/findings/${findingId}/severity`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          severity: 'CRITICAL',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/reviews/:reviewId/guidance creates prompt guidance item', async () => {
      const res = await request(app)
        .post(`/api/reviews/${reviewId}/guidance`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          guidanceText: 'Evaluate database query performance and N+1 patterns thoroughly.',
          targetPersonas: ['database', 'performance'],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.guidance.guidanceText).toContain('N+1 patterns');
      expect(res.body.guidance.targetPersonas).toEqual(['database', 'performance']);
    });

    it('POST /api/reviews/:reviewId/guidance rejects empty text or text > 4000 chars', async () => {
      const emptyRes = await request(app)
        .post(`/api/reviews/${reviewId}/guidance`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          guidanceText: '   ',
        });
      expect(emptyRes.status).toBe(400);

      const hugeText = 'a'.repeat(4001);
      const hugeRes = await request(app)
        .post(`/api/reviews/${reviewId}/guidance`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          guidanceText: hugeText,
        });
      expect(hugeRes.status).toBe(400);
      expect(hugeRes.body.error).toContain('4000');
    });

    it('POST /api/reviews/:reviewId/guidance rejects unknown personas', async () => {
      const res = await request(app)
        .post(`/api/reviews/${reviewId}/guidance`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          guidanceText: 'Valid text',
          targetPersonas: ['unknown_custom_persona_123'],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid target personas');
    });

    it('POST /api/reviews/:reviewId/override executes authoritative verdict override', async () => {
      const res = await request(app)
        .post(`/api/reviews/${reviewId}/override`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          overrideVerdict: 'BLOCK',
          reason: 'Manual block due to unreviewed schema migration vulnerability',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.overrideVerdict).toBe('BLOCK');
      expect(res.body.gateVersion).toBeGreaterThanOrEqual(1);
    });

    it('POST /api/reviews/:reviewId/override rejects short justification (< 5 chars)', async () => {
      const res = await request(app)
        .post(`/api/reviews/${reviewId}/override`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          overrideVerdict: 'SHIP',
          reason: 'no',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at least 5 characters');
    });

    it('POST /api/reviews/:reviewId/override forbids viewer role (403)', async () => {
      const res = await request(app)
        .post(`/api/reviews/${reviewId}/override`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({
          overrideVerdict: 'SHIP',
          reason: 'Attempted override by unauthorized viewer',
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('role');
    });

    it('GET /api/reviews/:reviewId/audit-trail returns recorded audit trail events', async () => {
      dashboardStore.recordAuditEvent(reviewId, 'reviewer-alice', 'guidance_added', { guidance: 'test guidance' });

      const res = await request(app)
        .get(`/api/reviews/${reviewId}/audit-trail`)
        .set('Authorization', `Bearer ${reviewerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.events)).toBe(true);
      expect(res.body.events.length).toBeGreaterThan(0);
    });
  });
});
