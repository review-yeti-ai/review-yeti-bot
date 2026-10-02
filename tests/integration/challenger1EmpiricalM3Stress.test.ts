import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import * as crypto from 'crypto';
import { createApp } from '../../src/app';
import { authService } from '../../src/dashboard/authService';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { computeFindingId } from '../../src/review/findings';
import { gateTerminalMetadata } from '../../src/review/reviewGatePublisher';
import type { StoredReviewGate } from '../../src/review/reviewGateContracts';

describe('Milestone 3 Empirical Adversarial Challenge: HITL Controls, Security Boundaries & Stress Invariants', () => {
  let app: any;
  const adminToken = 'sess_challenger_admin_token_01';
  const reviewerToken = 'sess_challenger_reviewer_token_01';
  const viewerToken = 'sess_challenger_viewer_token_01';
  const expiredToken = 'sess_challenger_expired_token_01';
  const testRepo = 'exampleorg/example-api';

  beforeEach(() => {
    app = createApp();

    // 1. Admin session
    (authService as any).sessions.set(adminToken, {
      token: adminToken,
      user: { id: 'usr_admin_01', username: 'admin-charlie', role: 'admin', email: 'charlie@example.com' },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    // 2. Reviewer session
    (authService as any).sessions.set(reviewerToken, {
      token: reviewerToken,
      user: { id: 'usr_reviewer_01', username: 'reviewer-alice', role: 'reviewer', email: 'alice@example.com' },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    // 3. Viewer session (read-only observer)
    (authService as any).sessions.set(viewerToken, {
      token: viewerToken,
      user: { id: 'usr_viewer_01', username: 'viewer-bob', role: 'viewer', email: 'bob@example.com' },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    // 4. Expired session
    (authService as any).sessions.set(expiredToken, {
      token: expiredToken,
      user: { id: 'usr_expired_01', username: 'expired-user', role: 'reviewer', email: 'expired@example.com' },
      expiresAt: new Date(Date.now() - 1000 * 60).toISOString(), // 1 minute in the past
    });
  });

  afterEach(() => {
    (authService as any).sessions.delete(adminToken);
    (authService as any).sessions.delete(reviewerToken);
    (authService as any).sessions.delete(viewerToken);
    (authService as any).sessions.delete(expiredToken);
  });

  /* ============================================================================
   * 1. Security Boundaries & Authorization Hardening
   * ============================================================================ */
  describe('1. Security Boundaries & Role-Based Access Control (RBAC)', () => {
    const reviewId = 'rev-sec-test-01';

    beforeEach(() => {
      // Seed gate attempt and findings for reviewId
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
        id: computeFindingId(testRepo, 'src/auth/jwt.ts', 10, 'Hardcoded Key'),
        severity: 'P0',
        file: 'src/auth/jwt.ts',
        line: 10,
        title: 'Hardcoded Key',
        description: 'Private key committed to repo',
        status: 'active',
      });
    });

    it('SEC_01: Unauthenticated requests to all HITL routes fail with 401 Unauthorized', async () => {
      const findingId = computeFindingId(testRepo, 'src/auth/jwt.ts', 10, 'Hardcoded Key');

      const hitlEndpoints: Array<{ method: 'get' | 'post' | 'patch'; path: string; body?: any }> = [
        { method: 'post', path: `/api/reviews/${reviewId}/findings/${findingId}/dismiss`, body: { reason: 'Test reason', dismissedBy: 'bob' } },
        { method: 'patch', path: `/api/reviews/${reviewId}/findings/${findingId}/severity`, body: { severity: 'P1' } },
        { method: 'post', path: `/api/reviews/${reviewId}/findings/${findingId}/severity`, body: { severity: 'P1' } },
        { method: 'post', path: `/api/reviews/${reviewId}/guidance`, body: { guidanceText: 'Check security rules' } },
        { method: 'get', path: `/api/reviews/${reviewId}/guidance` },
        { method: 'post', path: `/api/reviews/${reviewId}/override`, body: { overrideVerdict: 'SHIP', reason: 'Emergency fix approved' } },
        { method: 'get', path: `/api/reviews/${reviewId}/audit-trail` },
        { method: 'get', path: `/api/reviews/${reviewId}/findings` },
        // Also check /api/dashboard/reviews/ aliases
        { method: 'post', path: `/api/dashboard/reviews/${reviewId}/override`, body: { overrideVerdict: 'SHIP', reason: 'Emergency fix approved' } },
        { method: 'get', path: `/api/dashboard/reviews/${reviewId}/audit-trail` },
      ];

      for (const endpoint of hitlEndpoints) {
        const req = (request(app) as any)[endpoint.method](endpoint.path);
        if (endpoint.body) req.send(endpoint.body);
        const res = await req;
        expect(res.status, `Endpoint ${endpoint.method.toUpperCase()} ${endpoint.path} did not reject unauthenticated request with 401`).toBe(401);
        expect(res.body.success).toBe(false);
      }
    });

    it('SEC_02: Expired tokens and forged tokens fail with 401 across HITL routes', async () => {
      // 1. Expired token
      const expiredRes = await request(app)
        .post(`/api/reviews/${reviewId}/override`)
        .set('Authorization', `Bearer ${expiredToken}`)
        .send({ overrideVerdict: 'SHIP', reason: 'Expired attempt' });
      expect(expiredRes.status).toBe(401);

      // 2. Forged/non-existent token
      const forgedRes = await request(app)
        .post(`/api/reviews/${reviewId}/override`)
        .set('Authorization', 'Bearer sess_forged_random_nonce_99999')
        .send({ overrideVerdict: 'SHIP', reason: 'Forged attempt' });
      expect(forgedRes.status).toBe(401);

      // 3. Garbage Authorization headers
      const garbageRes = await request(app)
        .get(`/api/reviews/${reviewId}/audit-trail`)
        .set('Authorization', 'InvalidSchemeAndGarbageToken');
      expect(garbageRes.status).toBe(401);
    });

    it('SEC_03: Viewer role is strictly FORBIDDEN (403) from executing manual verdict overrides', async () => {
      // Direct /api/reviews route
      const res = await request(app)
        .post(`/api/reviews/${reviewId}/override`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({
          overrideVerdict: 'SHIP',
          reason: 'Attempting to ship without authorization',
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/viewer role cannot submit verdict overrides/i);

      // Aliased /api/dashboard/reviews route
      const dashRes = await request(app)
        .post(`/api/dashboard/reviews/${reviewId}/override`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({
          overrideVerdict: 'BLOCK',
          reason: 'Attempting to block as viewer',
        });

      expect(dashRes.status).toBe(403);
      expect(dashRes.body.success).toBe(false);
    });

    it('SEC_04: Viewer role cannot spoof elevated privileges via payload body or headers', async () => {
      // Viewer passes role: admin, overriddenBy: admin in body
      const spoofBodyRes = await request(app)
        .post(`/api/reviews/${reviewId}/override`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({
          overrideVerdict: 'SHIP',
          reason: 'Spoofed admin payload',
          role: 'admin',
          overriddenBy: 'admin-charlie',
          user: { role: 'admin' },
        });

      expect(spoofBodyRes.status).toBe(403);

      // Verify gate attempt verdict was NOT altered in store
      const gate = dashboardStore.getGateAttempt(reviewId);
      expect(gate?.verdict).toBe('BLOCK');
      expect(gate?.desired_version).toBe(1);
    });

    it('SEC_05: Reviewer and Admin roles can successfully execute manual verdict overrides', async () => {
      // 1. Reviewer override
      const reviewerRes = await request(app)
        .post(`/api/reviews/${reviewId}/override`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          overrideVerdict: 'SHIP',
          reason: 'Verified by senior security architect offline',
        });

      expect(reviewerRes.status).toBe(200);
      expect(reviewerRes.body.success).toBe(true);
      expect(reviewerRes.body.overrideVerdict).toBe('SHIP');

      // 2. Admin override back to BLOCK
      const adminRes = await request(app)
        .post(`/api/reviews/${reviewId}/override`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          overrideVerdict: 'BLOCK',
          reason: 'Admin blocking pending legal compliance review',
        });

      expect(adminRes.status).toBe(200);
      expect(adminRes.body.success).toBe(true);
      expect(adminRes.body.overrideVerdict).toBe('BLOCK');
    });
  });

  /* ============================================================================
   * 2. Input Fuzzing & Parameter Validation
   * ============================================================================ */
  describe('2. Input Fuzzing & Boundary Guardrails', () => {
    const validReviewId = 'rev-fuzz-01';

    beforeEach(() => {
      dashboardStore.setGateAttempt(validReviewId, {
        reviewId: validReviewId,
        runId: validReviewId,
        verdict: 'BLOCK',
        desired_state: 'failure',
        desired_version: 1,
        published_version: 1,
        updated_at: new Date().toISOString(),
      });

      dashboardStore.setFinding(validReviewId, {
        id: computeFindingId(testRepo, 'app.ts', 1, 'Bug'),
        severity: 'P1',
        file: 'app.ts',
        line: 1,
        title: 'Bug',
        description: 'Test bug',
        status: 'active',
      });
    });

    it('FUZZ_01: Path traversal payloads in review IDs are strictly rejected with 400 (or 404 for URL-collapsed roots)', async () => {
      const explicitTraversalIds = [
        '../../etc/passwd',
        '..%2F..%2Fetc%2Fpasswd',
        '../review-1',
        'review/subpath',
        'review\\subpath',
        '..\\..\\windows\\win.ini',
        '....//',
      ];

      for (const badId of explicitTraversalIds) {
        // Test guidance endpoint
        const gRes = await request(app)
          .post(`/api/reviews/${encodeURIComponent(badId)}/guidance`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({ guidanceText: 'Valid guidance text' });
        expect(gRes.status, `Traversal ID "${badId}" was not rejected with 400 on /guidance`).toBe(400);
        expect(gRes.body.error).toMatch(/Malformed or invalid review ID/i);

        // Test override endpoint
        const oRes = await request(app)
          .post(`/api/reviews/${encodeURIComponent(badId)}/override`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({ overrideVerdict: 'SHIP', reason: 'Valid override reason' });
        expect(oRes.status, `Traversal ID "${badId}" was not rejected with 400 on /override`).toBe(400);

        // Test audit-trail endpoint
        const aRes = await request(app)
          .get(`/api/reviews/${encodeURIComponent(badId)}/audit-trail`)
          .set('Authorization', `Bearer ${reviewerToken}`);
        expect(aRes.status, `Traversal ID "${badId}" was not rejected with 400 on /audit-trail`).toBe(400);
      }

      // Raw ".." without filename collapses in URL parser, blocking traversal with 404
      const rootDotRes = await request(app)
        .get('/api/reviews/../guidance')
        .set('Authorization', `Bearer ${reviewerToken}`);
      expect(rootDotRes.status).toBe(404);
    });

    it('FUZZ_02: Guidance text length boundaries (exactly 4000 vs 4001 chars vs huge text)', async () => {
      // 1. Boundary: Exactly 4,000 characters (MUST succeed)
      const exact4000 = 'x'.repeat(4000);
      const res4000 = await request(app)
        .post(`/api/reviews/${validReviewId}/guidance`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ guidanceText: exact4000 });
      expect(res4000.status).toBe(201);
      expect(res4000.body.success).toBe(true);
      expect(res4000.body.guidance.guidanceText.length).toBe(4000);

      // 2. Boundary: Exactly 4,001 characters (MUST fail with 400)
      const exact4001 = 'x'.repeat(4001);
      const res4001 = await request(app)
        .post(`/api/reviews/${validReviewId}/guidance`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ guidanceText: exact4001 });
      expect(res4001.status).toBe(400);
      expect(res4001.body.error).toMatch(/exceeds maximum allowed length of 4000 characters/i);

      // 3. Stress: 50,000 characters payload
      const hugeText = 'y'.repeat(50_000);
      const resHuge = await request(app)
        .post(`/api/reviews/${validReviewId}/guidance`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ guidanceText: hugeText });
      expect(resHuge.status).toBe(400);
      expect(resHuge.body.error).toMatch(/exceeds maximum allowed length of 4000 characters/i);
    });

    it('FUZZ_03: Whitespace-only, empty, and non-string texts are rejected with 400', async () => {
      const badTexts = ['', '   ', '\t\n\r  ', null, undefined, 12345, true, {}];

      // Guidance text
      for (const bad of badTexts) {
        const res = await request(app)
          .post(`/api/reviews/${validReviewId}/guidance`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({ guidanceText: bad });
        expect(res.status, `Guidance text ${JSON.stringify(bad)} was not rejected`).toBe(400);
      }

      // Override reason
      for (const bad of badTexts) {
        const res = await request(app)
          .post(`/api/reviews/${validReviewId}/override`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({ overrideVerdict: 'SHIP', reason: bad });
        expect(res.status, `Override reason ${JSON.stringify(bad)} was not rejected`).toBe(400);
      }

      // Finding dismissal reason
      const findingId = computeFindingId(testRepo, 'app.ts', 1, 'Bug');
      for (const bad of badTexts) {
        const res = await request(app)
          .post(`/api/reviews/${validReviewId}/findings/${findingId}/dismiss`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({ reason: bad, dismissedBy: 'alice' });
        expect(res.status, `Dismissal reason ${JSON.stringify(bad)} was not rejected`).toBe(400);
      }

      // Finding dismissal dismissedBy: empty and falsy rejected with 400
      for (const bad of ['', null, undefined, 12345, true, {}]) {
        const res = await request(app)
          .post(`/api/reviews/${validReviewId}/findings/${findingId}/dismiss`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({ reason: 'Valid dismissal reason', dismissedBy: bad });
        expect(res.status, `dismissedBy ${JSON.stringify(bad)} was not rejected`).toBe(400);
      }
    });

    it('FUZZ_03b: EMPIRICAL VULNERABILITY REMEDIATED: dismissedBy with whitespace-only is rejected with 400', async () => {
      const findingId = computeFindingId(testRepo, 'app.ts', 1, 'Bug');

      // Attempting dismissal with whitespace-only dismissedBy
      const res = await request(app)
        .post(`/api/reviews/${validReviewId}/findings/${findingId}/dismiss`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ reason: 'Legitimate false positive reason', dismissedBy: '   \t  ' });

      // Remediated: whitespace-only dismissedBy is rejected with HTTP 400
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/dismissedBy is required and cannot be empty/i);

      // Verify no dismissal event with empty actor was recorded in the audit trail
      const auditTrail = dashboardStore.getAuditTrail(validReviewId);
      const emptyActorEvent = auditTrail.find((e) => e.actor === '');
      expect(emptyActorEvent).toBeUndefined();
    });

    it('FUZZ_04: Short override reason boundaries (<5 chars vs >=5 chars)', async () => {
      // 0 chars
      const r0 = await request(app)
        .post(`/api/reviews/${validReviewId}/override`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ overrideVerdict: 'SHIP', reason: '' });
      expect(r0.status).toBe(400);

      // 1 char
      const r1 = await request(app)
        .post(`/api/reviews/${validReviewId}/override`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ overrideVerdict: 'SHIP', reason: 'a' });
      expect(r1.status).toBe(400);

      // 4 chars
      const r4 = await request(app)
        .post(`/api/reviews/${validReviewId}/override`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ overrideVerdict: 'SHIP', reason: 'ship' });
      expect(r4.status).toBe(400);
      expect(r4.body.error).toMatch(/at least 5 characters/i);

      // 4 chars padded with whitespace (trimmed is 4 chars)
      const r4Pad = await request(app)
        .post(`/api/reviews/${validReviewId}/override`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ overrideVerdict: 'SHIP', reason: '  ship  ' });
      expect(r4Pad.status).toBe(400);

      // 5 chars (MUST succeed)
      const r5 = await request(app)
        .post(`/api/reviews/${validReviewId}/override`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ overrideVerdict: 'SHIP', reason: '12345' });
      expect(r5.status).toBe(200);

      // 5 chars padded with whitespace (trimmed is 5 chars -> MUST succeed)
      const r5Pad = await request(app)
        .post(`/api/reviews/${validReviewId}/override`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ overrideVerdict: 'BLOCK', reason: '   12345   ' });
      expect(r5Pad.status).toBe(200);
    });

    it('FUZZ_05: Invalid target personas are rejected; all 11 valid personas succeed', async () => {
      const invalidPersonaLists = [
        ['invalid_persona_xyz'],
        ['SECURITY'], // uppercase not recognized in strict enum
        ['security', 'unknown_persona'],
        ['__proto__'],
        ['<script>alert(1)</script>'],
        ['P0', 'CRITICAL'],
        [''],
      ];

      for (const badList of invalidPersonaLists) {
        const res = await request(app)
          .post(`/api/reviews/${validReviewId}/guidance`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({
            guidanceText: 'Ensure thorough verification',
            targetPersonas: badList,
          });
        expect(res.status, `Persona list ${JSON.stringify(badList)} was not rejected`).toBe(400);
        expect(res.body.error).toMatch(/Invalid target personas/i);
      }

      // Valid personas
      const all11Personas = [
        'security',
        'architecture',
        'performance',
        'quality',
        'database',
        'api_contract',
        'reliability',
        'devops',
        'docs_compliance',
        'finops',
        'red_team',
      ];

      const validRes = await request(app)
        .post(`/api/reviews/${validReviewId}/guidance`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          guidanceText: 'Comprehensive guidance across all specialized reviewers',
          targetPersonas: all11Personas,
        });

      expect(validRes.status).toBe(201);
      expect(validRes.body.guidance.targetPersonas).toEqual(all11Personas);
    });

    it('FUZZ_06: Invalid severity values are rejected; P0, P1, P2 succeed', async () => {
      const findingId = computeFindingId(testRepo, 'app.ts', 1, 'Bug');
      const invalidSeverities = [
        'P3',
        'CRITICAL',
        'HIGH',
        'MEDIUM',
        'LOW',
        'INFO',
        'p0', // lowercase
        'p1',
        'p2',
        '-1',
        '',
        null,
        123,
      ];

      for (const badSev of invalidSeverities) {
        const patchRes = await request(app)
          .patch(`/api/reviews/${validReviewId}/findings/${findingId}/severity`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({ severity: badSev });
        expect(patchRes.status, `Severity ${JSON.stringify(badSev)} was not rejected`).toBe(400);
        expect(patchRes.body.error).toMatch(/Severity must be P0, P1, or P2/i);
      }

      // Valid severities
      for (const validSev of ['P0', 'P1', 'P2'] as const) {
        const okRes = await request(app)
          .patch(`/api/reviews/${validReviewId}/findings/${findingId}/severity`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({ severity: validSev });
        expect(okRes.status).toBe(200);
        expect(okRes.body.severity).toBe(validSev);
      }
    });

    it('FUZZ_07: Invalid override verdicts are rejected; SHIP and BLOCK succeed', async () => {
      const invalidVerdicts = ['NEUTRAL', 'COMMENT', 'NACK', 'APPROVE', 'REJECT', 'ship', 'block', 'P0', '', null];

      for (const badVerdict of invalidVerdicts) {
        const res = await request(app)
          .post(`/api/reviews/${validReviewId}/override`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({ overrideVerdict: badVerdict, reason: 'Valid justification string' });
        expect(res.status, `Verdict ${JSON.stringify(badVerdict)} was not rejected`).toBe(400);
        expect(res.body.error).toMatch(/overrideVerdict must be SHIP or BLOCK/i);
      }
    });

    it('FUZZ_08: Non-existent reviews and findings return 404 cleanly', async () => {
      const fakeReviewId = 'rev-does-not-exist-at-all-9999';

      // Non-existent review on guidance
      const gRes = await request(app)
        .post(`/api/reviews/${fakeReviewId}/guidance`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ guidanceText: 'Valid text' });
      expect(gRes.status).toBe(404);

      // Non-existent review on override
      const oRes = await request(app)
        .post(`/api/reviews/${fakeReviewId}/override`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ overrideVerdict: 'SHIP', reason: 'Valid reason' });
      expect(oRes.status).toBe(404);

      // Non-existent finding on existing review
      const fakeFindingId = 'finding-that-does-not-exist';
      const dRes = await request(app)
        .post(`/api/reviews/${validReviewId}/findings/${fakeFindingId}/dismiss`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ reason: 'Valid reason', dismissedBy: 'alice' });
      expect(dRes.status).toBe(404);

      const sRes = await request(app)
        .patch(`/api/reviews/${validReviewId}/findings/${fakeFindingId}/severity`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ severity: 'P0' });
      expect(sRes.status).toBe(404);
    });
  });

  /* ============================================================================
   * 3. Deterministic Finding ID Collision Resistance & Hash Stability
   * ============================================================================ */
  describe('3. Deterministic Finding ID Collision Resistance & Hash Stability', () => {
    it('FID_01: Cryptographic format invariants (exact 64-char sha256 hex string)', () => {
      const id = computeFindingId(testRepo, 'src/api/auth.ts', 42, 'JWT Validation Failure');
      expect(id).toMatch(/^[0-9a-f]{64}$/);
      expect(id.length).toBe(64);
    });

    it('FID_02: 1,000 evaluations of identical inputs produce 100% deterministic hash output', () => {
      const baseline = computeFindingId(testRepo, 'src/services/billing.ts', 120, 'Precision Loss');
      for (let i = 0; i < 1000; i++) {
        const id = computeFindingId(testRepo, 'src/services/billing.ts', 120, 'Precision Loss');
        expect(id).toBe(baseline);
      }
    });

    it('FID_03: Normalization invariants across whitespace and relative path prefixes', () => {
      // Relative path variations should resolve to the exact same finding ID
      const idPlain = computeFindingId(testRepo, 'src/util/helper.ts', 15, 'Unused Import');
      const idDotSlash = computeFindingId(testRepo, './src/util/helper.ts', 15, 'Unused Import');
      const idLeadingSlash = computeFindingId(testRepo, '/src/util/helper.ts', 15, 'Unused Import');

      expect(idDotSlash).toBe(idPlain);
      expect(idLeadingSlash).toBe(idPlain);

      // Whitespace in repo, file, and title is trimmed consistently
      const idPadded = computeFindingId(`  ${testRepo}  `, '  src/util/helper.ts  ', 15, '  Unused Import  ');
      expect(idPadded).toBe(idPlain);
    });

    it('FID_04: Hash stability across line number boundaries', () => {
      // Line numbers are 1-indexed; 0 and negatives floor-clamp to 1
      const idLine1 = computeFindingId(testRepo, 'index.ts', 1, 'Bug');
      const idLine0 = computeFindingId(testRepo, 'index.ts', 0, 'Bug');
      const idLineNeg = computeFindingId(testRepo, 'index.ts', -42, 'Bug');
      const idLineNaN = computeFindingId(testRepo, 'index.ts', NaN, 'Bug');

      expect(idLine0).toBe(idLine1);
      expect(idLineNeg).toBe(idLine1);
      expect(idLineNaN).toBe(idLine1);

      // Line 1 vs Line 2 must be strictly distinct
      const idLine2 = computeFindingId(testRepo, 'index.ts', 2, 'Bug');
      expect(idLine2).not.toBe(idLine1);

      // High line numbers remain stable and distinct
      const idLine10k = computeFindingId(testRepo, 'index.ts', 10000, 'Bug');
      const idLine10k1 = computeFindingId(testRepo, 'index.ts', 10001, 'Bug');
      expect(idLine10k).not.toBe(idLine10k1);

      // Floating point line numbers floor properly
      const idFloat = computeFindingId(testRepo, 'index.ts', 1.9, 'Bug');
      expect(idFloat).toBe(idLine1);
    });

    it('FID_05: Large-scale collision resistance across 10,000 distinct pseudo-random tuples (0 collisions)', () => {
      const generatedIds = new Set<string>();
      const totalSamples = 10_000;

      const repos = ['exampleorg/example-api', 'exampleorg/yeti-bot', 'exampleorg/auth-svc', 'exampleorg/k8s-mesh'];
      const filePaths = [
        'src/auth/jwt.ts',
        'src/services/billing.ts',
        'src/routes/api.ts',
        'src/db/postgres.ts',
        'lib/utils/crypto.ts',
        'config/env.ts',
        'k8s/deployment.yaml',
        'web/app/page.tsx',
      ];
      const titles = [
        'SQL Injection Vulnerability',
        'Memory Leak in Stream Handler',
        'Missing Rate Limit Header',
        'Insecure Random Generator',
        'Hardcoded AWS Secret',
        'Unhandled Promise Rejection',
        'Prototype Pollution Risk',
        'Off-by-One Loop Index',
      ];

      for (let i = 0; i < totalSamples; i++) {
        const repo = repos[i % repos.length];
        const file = `${filePaths[i % filePaths.length]}_${Math.floor(i / 100)}`;
        const line = (i % 2500) + 1;
        const title = `${titles[i % titles.length]} (sample ${i})`;

        const fid = computeFindingId(repo, file, line, title);
        generatedIds.add(fid);
      }

      // Assert zero collisions across all 10,000 generated findings
      expect(generatedIds.size).toBe(totalSamples);
    });

    it('FID_06: Delimiter injection scenario analysis — collision immunity', () => {
      // Colon delimiter behavior:
      // Tuple A: repo="org", file="repo:file.ts", line=1, title="title"
      // Tuple B: repo="org:repo", file="file.ts", line=1, title="title"
      const idA = computeFindingId('org', 'repo:file.ts', 1, 'title');
      const idB = computeFindingId('org:repo', 'file.ts', 1, 'title');

      expect(typeof idA).toBe('string');
      expect(typeof idB).toBe('string');
      // Colon delimiter escaping eliminates synthetic delimiter collision
      expect(idA).not.toBe(idB);
    });
  });

  /* ============================================================================
   * 4. High Concurrency, Race Conditions & Audit Trail Integrity
   * ============================================================================ */
  describe('4. Concurrency, Race Conditions & Audit Trail Integrity', () => {
    const concurrentReviewId = 'rev-concurrent-stress-01';

    beforeEach(() => {
      dashboardStore.setGateAttempt(concurrentReviewId, {
        reviewId: concurrentReviewId,
        runId: concurrentReviewId,
        verdict: 'BLOCK',
        desired_state: 'failure',
        desired_version: 1,
        published_version: 1,
        updated_at: new Date().toISOString(),
      });
    });

    it('RACE_01: Concurrent burst of 50 simultaneous finding dismissals with zero loss or data corruption', async () => {
      const findingCount = 50;
      const findingIds: string[] = [];

      // Seed 50 active findings
      for (let i = 0; i < findingCount; i++) {
        const fid = computeFindingId(testRepo, `src/worker/task_${i}.ts`, 10 + i, `Finding ${i}`);
        findingIds.push(fid);
        dashboardStore.setFinding(concurrentReviewId, {
          id: fid,
          severity: 'P1',
          file: `src/worker/task_${i}.ts`,
          line: 10 + i,
          title: `Finding ${i}`,
          description: `Description ${i}`,
          status: 'active',
        });
      }

      // Fire 50 concurrent dismissal requests
      const promises = findingIds.map((fid, idx) =>
        request(app)
          .post(`/api/reviews/${concurrentReviewId}/findings/${fid}/dismiss`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({
            reason: `Dismissal justification for finding ${idx}`,
            dismissedBy: `reviewer-${idx}`,
          })
      );

      const responses = await Promise.all(promises);

      // Assert all 50 succeeded
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe('dismissed');
      }

      // Verify final store state
      const findings = dashboardStore.getFindings(concurrentReviewId);
      expect(findings.length).toBe(findingCount);
      for (const f of findings) {
        expect(f.status).toBe('dismissed');
        expect(f.dismissedReason).toContain('Dismissal justification for finding');
      }

      // Verify audit trail contains all 50 events without dropped records
      const auditTrail = dashboardStore.getAuditTrail(concurrentReviewId);
      const dismissalEvents = auditTrail.filter((e) => e.action === 'finding_dismissed');
      expect(dismissalEvents.length).toBeGreaterThanOrEqual(findingCount);
    });

    it('RACE_02: Concurrent burst of 50 simultaneous severity adjustments with zero loss', async () => {
      const findingCount = 50;
      const findingIds: string[] = [];

      // Seed 50 active findings at P2
      for (let i = 0; i < findingCount; i++) {
        const fid = computeFindingId(testRepo, `src/perf/query_${i}.ts`, 50 + i, `Slow Query ${i}`);
        findingIds.push(fid);
        dashboardStore.setFinding(concurrentReviewId, {
          id: fid,
          severity: 'P2',
          file: `src/perf/query_${i}.ts`,
          line: 50 + i,
          title: `Slow Query ${i}`,
          description: `Query latency ${i}`,
          status: 'active',
        });
      }

      // Fire 50 concurrent PATCH requests escalating to P0
      const promises = findingIds.map((fid, idx) =>
        request(app)
          .patch(`/api/reviews/${concurrentReviewId}/findings/${fid}/severity`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({
            severity: 'P0',
            updatedBy: `sec-lead-${idx}`,
          })
      );

      const responses = await Promise.all(promises);

      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.severity).toBe('P0');
      }

      // Verify all findings escalated to P0
      const findings = dashboardStore.getFindings(concurrentReviewId);
      for (const fid of findingIds) {
        const f = findings.find((x) => x.id === fid);
        expect(f?.severity).toBe('P0');
      }

      // Verify audit trail contains 50 severity_changed events
      const auditTrail = dashboardStore.getAuditTrail(concurrentReviewId);
      const sevEvents = auditTrail.filter((e) => e.action === 'severity_changed');
      expect(sevEvents.length).toBeGreaterThanOrEqual(findingCount);
    });

    it('RACE_03: Rapid concurrent operations on the SAME finding preserve atomic integrity', async () => {
      const sharedFindingId = computeFindingId(testRepo, 'src/hotspot.ts', 99, 'High Contention Hotspot');
      dashboardStore.setFinding(concurrentReviewId, {
        id: sharedFindingId,
        severity: 'P1',
        file: 'src/hotspot.ts',
        line: 99,
        title: 'High Contention Hotspot',
        description: 'Contended finding',
        status: 'active',
      });

      // 20 concurrent severity updates alternating P0 and P2
      const updates = Array.from({ length: 20 }, (_, i) => {
        const sev = i % 2 === 0 ? 'P0' : 'P2';
        return request(app)
          .patch(`/api/reviews/${concurrentReviewId}/findings/${sharedFindingId}/severity`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({ severity: sev, updatedBy: `worker-${i}` });
      });

      const responses = await Promise.all(updates);
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      }

      const finding = dashboardStore.getFinding(concurrentReviewId, sharedFindingId);
      expect(['P0', 'P2']).toContain(finding?.severity);

      const auditTrail = dashboardStore.getAuditTrail(concurrentReviewId);
      const hotspotAudit = auditTrail.filter(
        (e) => e.action === 'severity_changed' && (e.newState as any)?.findingId === sharedFindingId
      );
      expect(hotspotAudit.length).toBe(20);
    });

    it('RACE_04: Concurrent burst of 25 prompt guidance additions without record collision', async () => {
      const guidancePromises = Array.from({ length: 25 }, (_, i) =>
        request(app)
          .post(`/api/reviews/${concurrentReviewId}/guidance`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({
            guidanceText: `Concurrent steering instruction #${i} for review personas`,
            targetPersonas: ['security', 'performance'],
            createdBy: `reviewer-${i}`,
          })
      );

      const responses = await Promise.all(guidancePromises);
      for (const res of responses) {
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.guidance.id).toBeDefined();
      }

      const guidanceList = dashboardStore.getPromptGuidance(concurrentReviewId);
      expect(guidanceList.length).toBeGreaterThanOrEqual(25);

      const auditTrail = dashboardStore.getAuditTrail(concurrentReviewId);
      const gEvents = auditTrail.filter((e) => e.action === 'guidance_added');
      expect(gEvents.length).toBeGreaterThanOrEqual(25);
    });

    it('RACE_05: Monotonic gate version increments under rapid consecutive verdict overrides', async () => {
      const overrides = [
        { verdict: 'SHIP', reason: 'Initial release approval by lead' },
        { verdict: 'BLOCK', reason: 'Reopened issue blocking ship' },
        { verdict: 'SHIP', reason: 'Follow-up patch verified' },
        { verdict: 'BLOCK', reason: 'Performance regression detected in staging' },
        { verdict: 'SHIP', reason: 'Final executive override to ship hotfix' },
      ];

      let lastVersion = 1;
      for (const ovr of overrides) {
        const res = await request(app)
          .post(`/api/reviews/${concurrentReviewId}/override`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({ overrideVerdict: ovr.verdict, reason: ovr.reason });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.overrideVerdict).toBe(ovr.verdict);
        expect(res.body.gateVersion).toBeGreaterThan(lastVersion);
        lastVersion = res.body.gateVersion;
      }

      const gate = dashboardStore.getGateAttempt(concurrentReviewId);
      expect(gate?.verdict).toBe('SHIP');
      expect(gate?.desired_version).toBe(lastVersion);
      expect(gate?.desired_state).toBe('success');

      // Verify audit trail contains all 5 verdict_overridden events
      const auditTrail = dashboardStore.getAuditTrail(concurrentReviewId);
      const ovrEvents = auditTrail.filter((e) => e.action === 'verdict_overridden');
      expect(ovrEvents.length).toBe(5);
    });
  });

  /* ============================================================================
   * 5. Downstream Gate Synchronization & Terminal Metadata Verification
   * ============================================================================ */
  describe('5. Downstream Gate Synchronization & Terminal Metadata Verification', () => {
    const baseCoords = {
      owner: 'exampleorg',
      repo: 'example-api',
      repositoryId: 123,
      prNumber: 42,
      runId: 'run_gate_test_01',
      executionAttempt: 1,
      attemptId: 'attempt_01',
      headSha: 'headsha01',
      baseSha: 'basesha01',
      policyDigest: 'digest01',
    };

    it('GATE_01: gateTerminalMetadata generates correct title and summary for manual SHIP override', () => {
      const gate: StoredReviewGate = {
        coordinates: baseCoords,
        reviewGeneration: 0,
        expectedAppId: 1,
        externalId: 'ext_01',
        checkId: 100,
        creationState: 'bound',
        desiredState: 'success',
        desiredVersion: 3,
        publishedVersion: 2,
        current: true,
        decisionReason: 'manual-override-ship',
        decisionDetail: JSON.stringify({
          overriddenBy: 'security-architect-alice',
          reason: 'Offline audit completed and approved.',
        }),
      };

      const meta = gateTerminalMetadata(gate);
      expect(meta.title).toBe('Review Yeti Gate: Approved (Manual Override - SHIP)');
      expect(meta.summary).toContain('Manual SHIP override authorized by security-architect-alice');
      expect(meta.summary).toContain('Offline audit completed and approved.');
    });

    it('GATE_02: gateTerminalMetadata generates correct title and summary for manual BLOCK override', () => {
      const gate: StoredReviewGate = {
        coordinates: { ...baseCoords, prNumber: 43 },
        reviewGeneration: 0,
        expectedAppId: 1,
        externalId: 'ext_02',
        checkId: 101,
        creationState: 'bound',
        desiredState: 'failure',
        desiredVersion: 4,
        publishedVersion: 3,
        current: true,
        decisionReason: 'manual-override-block',
        decisionDetail: JSON.stringify({
          overriddenBy: 'compliance-officer-dan',
          reason: 'Regulatory compliance failure in data retention policy.',
        }),
      };

      const meta = gateTerminalMetadata(gate);
      expect(meta.title).toBe('Review Yeti Gate: Blocked (Manual Override - BLOCK)');
      expect(meta.summary).toContain('Manual BLOCK override enforced by compliance-officer-dan');
      expect(meta.summary).toContain('Regulatory compliance failure in data retention policy.');
    });

    it('GATE_03: gateTerminalMetadata safely handles non-JSON decisionDetail string', () => {
      const gate: StoredReviewGate = {
        coordinates: { ...baseCoords, prNumber: 44 },
        reviewGeneration: 0,
        expectedAppId: 1,
        externalId: 'ext_03',
        checkId: 102,
        creationState: 'bound',
        desiredState: 'success',
        desiredVersion: 2,
        publishedVersion: 1,
        current: true,
        decisionReason: 'manual-override-ship',
        decisionDetail: 'Plain text override reason without JSON structure',
      };

      const meta = gateTerminalMetadata(gate);
      expect(meta.title).toBe('Review Yeti Gate: Approved (Manual Override - SHIP)');
      expect(meta.summary).toContain('Plain text override reason without JSON structure');
    });
  });
});
