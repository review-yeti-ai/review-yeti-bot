import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { authService } from '../../src/dashboard/authService';
import {
  dashboardStore,
  calculatePercentile,
  generateDefaultReviewLogs,
} from '../../src/persistence/dashboardStore';
import { computeFindingId, sha256 } from '../../src/lib/findingUtils';
import { gateTerminalMetadata } from '../../src/review/reviewGatePublisher';
import type { StoredReviewGate } from '../../src/review/reviewGateContracts';

describe('M5 Tier 5 Adversarial Stress Suite: HITL Controls, Overrides, Audit & Analytics', () => {
  let app: any;
  let reviewerToken: string;
  let adminToken: string;
  let viewerToken: string;

  beforeEach(async () => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test_key';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';
    app = createApp();

    // Setup authenticated sessions
    reviewerToken = 'sess_adv_reviewer_token';
    (authService as any).sessions.set(reviewerToken, {
      token: reviewerToken,
      user: { id: 'usr_adv_01', username: 'adversarial-reviewer', role: 'reviewer', email: 'rev@test.com' },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    adminToken = 'sess_adv_admin_token';
    (authService as any).sessions.set(adminToken, {
      token: adminToken,
      user: { id: 'usr_adv_admin', username: 'adversarial-admin', role: 'admin', email: 'admin@test.com' },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    viewerToken = 'sess_adv_viewer_token';
    (authService as any).sessions.set(viewerToken, {
      token: viewerToken,
      user: { id: 'usr_adv_viewer', username: 'adversarial-viewer', role: 'viewer', email: 'viewer@test.com' },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  // ==========================================================================
  // SECTION 1: Finding ID Collision Resistance, Unicode & Cryptographic Conformance
  // ==========================================================================
  describe('1. Deterministic Finding ID Generation & Hash Robustness', () => {
    it('matches Node.js native crypto.createHash("sha256") bit-for-bit across FIPS and boundary vectors', () => {
      const testVectors = [
        '',
        'a',
        'abc',
        'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', // 56 bytes (padding boundary)
        'a'.repeat(55),
        'b'.repeat(63),
        'c'.repeat(64),
        'd'.repeat(65),
        'e'.repeat(127),
        'f'.repeat(128),
        'g'.repeat(10000), // multi-block
        '🔥 Review Yeti ❄️ 2026', // multi-byte emojis
        'Привет, мир! 🚀', // Cyrillic + emoji
        'こんにちは世界', // Japanese Hiragana/Kanji
        'مرحبا بالعالم', // Arabic right-to-left
        'line1\nline2\r\nline3\t\0nullbyte', // escape sequences
      ];

      for (const vector of testVectors) {
        const expected = crypto.createHash('sha256').update(vector, 'utf8').digest('hex');
        const actual = sha256(vector);
        expect(actual).toBe(expected);
      }
    });

    it('generates strictly unique finding IDs across 1,000 distinct variations', () => {
      const ids = new Set<string>();
      const repo = 'exampleorg/example-api';

      for (let i = 1; i <= 1000; i++) {
        const id = computeFindingId(repo, `src/module_${i % 10}.ts`, i, `Finding title variation #${i}`);
        expect(ids.has(id)).toBe(false);
        ids.add(id);
      }

      expect(ids.size).toBe(1000);
    });

    it('normalizes leading slashes and relative path indicators', () => {
      const idPlain = computeFindingId('owner/repo', 'src/auth.ts', 42, 'Title');
      const idLeadingSlash = computeFindingId('owner/repo', '/src/auth.ts', 42, 'Title');
      const idLeadingDotSlash = computeFindingId('owner/repo', './src/auth.ts', 42, 'Title');

      expect(idLeadingSlash).toBe(idPlain);
      expect(idLeadingDotSlash).toBe(idPlain);
    });

    it('sanitizes line numbers with non-integer, negative, zero, and NaN inputs to valid integers >= 1', () => {
      const idBase = computeFindingId('owner/repo', 'src/auth.ts', 1, 'Title');
      const idZero = computeFindingId('owner/repo', 'src/auth.ts', 0, 'Title');
      const idNegative = computeFindingId('owner/repo', 'src/auth.ts', -100, 'Title');
      const idNaN = computeFindingId('owner/repo', 'src/auth.ts', NaN, 'Title');

      // 0, negative, and NaN must all fall back to line 1
      expect(idZero).toBe(idBase);
      expect(idNegative).toBe(idBase);
      expect(idNaN).toBe(idBase);

      // Floats should be floored (42.9 -> 42)
      const idFloat = computeFindingId('owner/repo', 'src/auth.ts', 42.9, 'Title');
      const id42 = computeFindingId('owner/repo', 'src/auth.ts', 42, 'Title');
      expect(idFloat).toBe(id42);
    });

    it('prevents finding ID delimiter collision when colon is used in repo/file boundaries', () => {
      // White-box finding: formula is sha256(`${cleanRepo}:${cleanFile}:${cleanLine}:${cleanTitle}`)
      // Delimiter escaping prevents boundary ambiguity between repo and file
      const repoA = 'org';
      const fileA = 'repo:src/auth.ts';
      const repoB = 'org:repo';
      const fileB = 'src/auth.ts';

      const idA = computeFindingId(repoA, fileA, 10, 'SQL injection');
      const idB = computeFindingId(repoB, fileB, 10, 'SQL injection');

      // Delimiter escaping ensures distinct inputs produce distinct finding IDs
      expect(idA).not.toBe(idB);
    });

    it('guarantees identical finding IDs across Unicode normalization forms (NFC vs NFD)', () => {
      const titleNFC = 'Sanitize naïve café';
      const titleNFD = 'Sanitize naïve café'.normalize('NFD');

      const idNFC = computeFindingId('owner/repo', 'src/app.ts', 10, titleNFC);
      const idNFD = computeFindingId('owner/repo', 'src/app.ts', 10, titleNFD);

      // Unicode NFC normalization ensures visually identical strings produce identical hashes
      expect(idNFC).toBe(idNFD);
    });

  });

  // ==========================================================================
  // SECTION 2: Audit Trail Non-Repudiation, Actor Sanitization & Idempotency
  // ==========================================================================
  describe('2. Audit Trail Non-Repudiation & Whitespace Actor Rejection', () => {
    const reviewId = 'rev-adv-audit-001';

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
        id: computeFindingId('exampleorg/test', 'auth.ts', 10, 'Secret Leak'),
        severity: 'P0',
        file: 'auth.ts',
        line: 10,
        title: 'Secret Leak',
        description: 'Hardcoded credentials',
        status: 'active',
      });
    });

    it('rejects whitespace-only actors in finding dismissals with 400 Bad Request', async () => {
      const findingId = computeFindingId('exampleorg/test', 'auth.ts', 10, 'Secret Leak');
      const whitespaceActors = ['', '   ', '\t\t', '\n\r\n', ' \t '];

      for (const actor of whitespaceActors) {
        const res = await request(app)
          .post(`/api/reviews/${reviewId}/findings/${findingId}/dismiss`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({
            reason: 'Legitimate test fixture',
            dismissedBy: actor,
          });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('dismissedBy is required');
      }
    });

    it('rejects whitespace-only dismissal reason with 400 Bad Request', async () => {
      const findingId = computeFindingId('exampleorg/test', 'auth.ts', 10, 'Secret Leak');
      const whitespaceReasons = ['', '   ', '\t', '\n\n'];

      for (const reason of whitespaceReasons) {
        const res = await request(app)
          .post(`/api/reviews/${reviewId}/findings/${findingId}/dismiss`)
          .set('Authorization', `Bearer ${reviewerToken}`)
          .send({
            reason,
            dismissedBy: 'security-reviewer',
          });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('Dismissal reason is required');
      }
    });

    it('ensures recorded audit events have non-empty, trimmed actors and valid ISO timestamps', () => {
      dashboardStore.recordAuditEvent(reviewId, '   alice_dev   ', 'guidance_added', { test: true }, 'Valid reason');

      const events = dashboardStore.getAuditTrail(reviewId);
      const recorded = events[events.length - 1];

      expect(recorded.actor).toBe('alice_dev');
      expect(new Date(recorded.timestamp).getTime()).not.toBeNaN();
      expect(recorded.id).toMatch(/^aud-\d+-[0-9a-f]{6}$/);
    });

    it('guarantees collision-free audit event IDs under rapid sequential generation (500 events)', () => {
      const eventIds = new Set<string>();
      const runId = 'rev-adv-id-collision-test';

      for (let i = 0; i < 500; i++) {
        dashboardStore.recordAuditEvent(runId, 'actor-stress', 'guidance_added', { index: i });
      }

      const events = dashboardStore.getAuditTrail(runId);
      for (const e of events) {
        expect(eventIds.has(e.id)).toBe(false);
        eventIds.add(e.id);
      }
      expect(eventIds.size).toBe(500);
    });

    it('is idempotent on repeated finding dismissals and preserves active count', async () => {
      const findingId = computeFindingId('exampleorg/test', 'auth.ts', 10, 'Secret Leak');

      // First dismissal
      const res1 = await request(app)
        .post(`/api/reviews/${reviewId}/findings/${findingId}/dismiss`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ reason: 'Initial dismissal', dismissedBy: 'reviewer-alice' });
      expect(res1.status).toBe(200);
      expect(res1.body.remainingActiveCount).toBe(0);

      // Duplicate second dismissal
      const res2 = await request(app)
        .post(`/api/reviews/${reviewId}/findings/${findingId}/dismiss`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ reason: 'Second dismissal redundant', dismissedBy: 'reviewer-alice' });
      expect(res2.status).toBe(200);
      expect(res2.body.remainingActiveCount).toBe(0);
      expect(res2.body.status).toBe('dismissed');
    });
  });

  // ==========================================================================
  // SECTION 3: Concurrent SHIP vs. BLOCK Override Races & Monotonic Desired Version
  // ==========================================================================
  describe('3. Concurrent SHIP vs. BLOCK Override Races & Version Monotonicity', () => {
    const reviewId = 'rev-adv-race-override';

    beforeEach(() => {
      dashboardStore.setGateAttempt(reviewId, {
        reviewId,
        runId: reviewId,
        verdict: 'NEUTRAL',
        desired_state: 'queued',
        desired_version: 1,
        published_version: 1,
        updated_at: new Date().toISOString(),
      });
    });

    it('maintains strict monotonic desired_version increments under 20 alternating overrides', () => {
      const initialVersion = dashboardStore.getGateAttempt(reviewId)!.desired_version;
      const totalRounds = 20;

      for (let i = 1; i <= totalRounds; i++) {
        const verdict = i % 2 === 0 ? 'SHIP' : 'BLOCK';
        const res = dashboardStore.overrideVerdict(
          reviewId,
          verdict,
          `Alternating override cycle #${i} justification`,
          `admin-user-${i}`
        );

        expect(res.success).toBe(true);
        expect(res.gateVersion).toBe(initialVersion + i);

        const currentGate = dashboardStore.getGateAttempt(reviewId)!;
        expect(currentGate.desired_version).toBe(initialVersion + i);
        expect(currentGate.verdict).toBe(verdict);
        expect(currentGate.desired_state).toBe(verdict === 'SHIP' ? 'success' : 'failure');
      }

      const auditTrail = dashboardStore.getAuditTrail(reviewId);
      const overrideEvents = auditTrail.filter((e) => e.action === 'verdict_overridden');
      expect(overrideEvents.length).toBe(totalRounds);
    });

    it('concurrently executes asynchronous HTTP override requests without version loss', async () => {
      const concurrentReviewId = 'rev-adv-async-race';
      dashboardStore.setGateAttempt(concurrentReviewId, {
        reviewId: concurrentReviewId,
        runId: concurrentReviewId,
        verdict: 'BLOCK',
        desired_state: 'failure',
        desired_version: 1,
        published_version: 1,
        updated_at: new Date().toISOString(),
      });

      const promises = [
        request(app).post(`/api/reviews/${concurrentReviewId}/override`).set('Authorization', `Bearer ${adminToken}`).send({ overrideVerdict: 'SHIP', reason: 'Async override 1', overriddenBy: 'admin1' }),
        request(app).post(`/api/reviews/${concurrentReviewId}/override`).set('Authorization', `Bearer ${adminToken}`).send({ overrideVerdict: 'BLOCK', reason: 'Async override 2', overriddenBy: 'admin2' }),
        request(app).post(`/api/reviews/${concurrentReviewId}/override`).set('Authorization', `Bearer ${adminToken}`).send({ overrideVerdict: 'SHIP', reason: 'Async override 3', overriddenBy: 'admin3' }),
        request(app).post(`/api/reviews/${concurrentReviewId}/override`).set('Authorization', `Bearer ${adminToken}`).send({ overrideVerdict: 'BLOCK', reason: 'Async override 4', overriddenBy: 'admin4' }),
      ];

      const responses = await Promise.all(promises);
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      }

      const finalGate = dashboardStore.getGateAttempt(concurrentReviewId)!;
      // 1 initial + 4 overrides = 5
      expect(finalGate.desired_version).toBe(5);

      const auditEvents = dashboardStore.getAuditTrail(concurrentReviewId).filter((e) => e.action === 'verdict_overridden');
      expect(auditEvents.length).toBe(4);
    });

    it('enforces RBAC defense rejecting viewer role from issuing verdict overrides (403 Forbidden)', async () => {
      const res = await request(app)
        .post(`/api/reviews/${reviewId}/override`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({
          overrideVerdict: 'SHIP',
          reason: 'Viewer unauthorized attempt to ship review',
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Forbidden');
    });
  });

  // ==========================================================================
  // SECTION 4: Downstream Gate Publisher Check Run Metadata
  // ==========================================================================
  describe('4. ReviewGatePublisher Downstream Metadata Synchronization', () => {
    it('generates correct Approved title and summary for manual SHIP override', () => {
      const gate: StoredReviewGate = {
        coordinates: { repositoryId: 101, headSha: '1111222233334444555566667777888899990000', attemptId: 'att-1' } as any,
        reviewGeneration: 1,
        expectedAppId: 12345,
        externalId: 'ext-1',
        creationState: 'bound',
        current: true,
        desiredState: 'success',
        desiredVersion: 2,
        publishedVersion: 1,
        decisionReason: 'manual-override-ship',
        decisionDetail: JSON.stringify({ overriddenBy: 'lead-architect', reason: 'Urgent hotfix tested in staging' }),
        checkId: 98765,
        claimedAt: null,
        claimedBy: null,
      } as any;

      const meta = gateTerminalMetadata(gate);
      expect(meta.title).toBe('Review Yeti Gate: Approved (Manual Override - SHIP)');
      expect(meta.summary).toContain('lead-architect');
      expect(meta.summary).toContain('Urgent hotfix tested in staging');
    });

    it('generates correct Blocked title and summary for manual BLOCK override', () => {
      const gate: StoredReviewGate = {
        coordinates: { repositoryId: 101, headSha: '1111222233334444555566667777888899990000', attemptId: 'att-2' } as any,
        reviewGeneration: 1,
        expectedAppId: 12345,
        externalId: 'ext-2',
        creationState: 'bound',
        current: true,
        desiredState: 'failure',
        desiredVersion: 3,
        publishedVersion: 2,
        decisionReason: 'manual-override-block',
        decisionDetail: JSON.stringify({ overriddenBy: 'security-director', reason: 'Suspected token extraction vulnerability' }),
        checkId: 98765,
        claimedAt: null,
        claimedBy: null,
      } as any;

      const meta = gateTerminalMetadata(gate);
      expect(meta.title).toBe('Review Yeti Gate: Blocked (Manual Override - BLOCK)');
      expect(meta.summary).toContain('security-director');
      expect(meta.summary).toContain('Suspected token extraction vulnerability');
    });

    it('gracefully handles non-JSON decisionDetail strings without throwing', () => {
      const gate: StoredReviewGate = {
        coordinates: { repositoryId: 101, headSha: '1111222233334444555566667777888899990000', attemptId: 'att-3' } as any,
        reviewGeneration: 1,
        expectedAppId: 12345,
        externalId: 'ext-3',
        creationState: 'bound',
        current: true,
        desiredState: 'success',
        desiredVersion: 2,
        publishedVersion: 1,
        decisionReason: 'manual-override-ship',
        decisionDetail: 'Plain text unquoted justification',
        checkId: 98765,
        claimedAt: null,
        claimedBy: null,
      } as any;

      const meta = gateTerminalMetadata(gate);
      expect(meta.title).toBe('Review Yeti Gate: Approved (Manual Override - SHIP)');
      expect(meta.summary).toContain('Plain text unquoted justification');
    });

    it('returns empty metadata for non-terminal progress states', () => {
      const progressGate: StoredReviewGate = {
        coordinates: { repositoryId: 101, headSha: '1111222233334444555566667777888899990000', attemptId: 'att-4' } as any,
        reviewGeneration: 1,
        expectedAppId: 12345,
        externalId: 'ext-4',
        creationState: 'bound',
        current: true,
        desiredState: 'in_progress',
        desiredVersion: 1,
        publishedVersion: 0,
        decisionReason: 'manual-override-ship',
        checkId: 98765,
        claimedAt: null,
        claimedBy: null,
      } as any;

      const meta = gateTerminalMetadata(progressGate);
      expect(meta).toEqual({});
    });
  });

  // ==========================================================================
  // SECTION 5: NIST Nearest-Rank p95 Percentile Latency Engine Under Extreme Distributions
  // ==========================================================================
  describe('5. NIST Nearest-Rank Percentile Latency Engine (calculatePercentile)', () => {
    it('returns 0 for empty arrays, null, undefined, or all non-positive values', () => {
      expect(calculatePercentile([], 95)).toBe(0);
      expect(calculatePercentile(null as any, 95)).toBe(0);
      expect(calculatePercentile(undefined as any, 95)).toBe(0);
      expect(calculatePercentile([0, 0, 0], 95)).toBe(0);
      expect(calculatePercentile([-100, -200, 0, NaN], 95)).toBe(0);
    });

    it('correctly handles single-item distribution across any percentile (p0 to p100)', () => {
      const single = [3450];
      expect(calculatePercentile(single, 0)).toBe(3450);
      expect(calculatePercentile(single, 50)).toBe(3450);
      expect(calculatePercentile(single, 95)).toBe(3450);
      expect(calculatePercentile(single, 100)).toBe(3450);
    });

    it('correctly calculates percentiles for two-item distribution [1000, 5000]', () => {
      const two = [1000, 5000];
      // NIST nearest-rank: N=2
      // p50: ceil(0.50 * 2) - 1 = 1 - 1 = 0 -> 1000
      // p90: ceil(0.90 * 2) - 1 = 2 - 1 = 1 -> 5000
      // p95: ceil(0.95 * 2) - 1 = 2 - 1 = 1 -> 5000
      expect(calculatePercentile(two, 50)).toBe(1000);
      expect(calculatePercentile(two, 90)).toBe(5000);
      expect(calculatePercentile(two, 95)).toBe(5000);
    });

    it('correctly calculates percentiles for all-identical distributions (100 items of 750)', () => {
      const identical = Array(100).fill(750);
      expect(calculatePercentile(identical, 50)).toBe(750);
      expect(calculatePercentile(identical, 95)).toBe(750);
      expect(calculatePercentile(identical, 99)).toBe(750);
    });

    it('computes exact nearest-rank boundary on a bimodal distribution (90 fast, 10 slow)', () => {
      // 90 items at 100ms, 10 items at 10,000ms (N = 100)
      const bimodal = [...Array(90).fill(100), ...Array(10).fill(10000)];

      // p50: ceil(0.50 * 100) - 1 = 49 -> 100
      // p90: ceil(0.90 * 100) - 1 = 89 -> 100 (90th item is index 89, value 100)
      // p91: ceil(0.91 * 100) - 1 = 90 -> 10000
      // p95: ceil(0.95 * 100) - 1 = 94 -> 10000
      expect(calculatePercentile(bimodal, 50)).toBe(100);
      expect(calculatePercentile(bimodal, 90)).toBe(100);
      expect(calculatePercentile(bimodal, 91)).toBe(10000);
      expect(calculatePercentile(bimodal, 95)).toBe(10000);
    });

    it('exhibits numerical stability on a heavy-tailed Pareto power-law distribution (1,000 samples)', () => {
      // Pareto distribution: x = x_m / (U ^ (1 / alpha))
      // with x_m = 500, alpha = 1.15
      const N = 1000;
      const paretoSamples: number[] = [];
      for (let i = 1; i <= N; i++) {
        const u = i / (N + 1); // deterministic uniform spacing (0, 1)
        const x = Math.round(500 / Math.pow(u, 1 / 1.15));
        paretoSamples.push(x);
      }

      const p50 = calculatePercentile(paretoSamples, 50);
      const p90 = calculatePercentile(paretoSamples, 90);
      const p95 = calculatePercentile(paretoSamples, 95);
      const p99 = calculatePercentile(paretoSamples, 99);

      expect(p50).toBeGreaterThanOrEqual(500);
      expect(p90).toBeGreaterThan(p50);
      expect(p95).toBeGreaterThan(p90);
      expect(p99).toBeGreaterThan(p95);
      expect(p99).toBeLessThanOrEqual(Math.max(...paretoSamples));
    });

    it('filters out negative and zero latencies from poisoning percentiles', () => {
      const contaminated = [-9999, 0, 100, 200, 300, 400, 500, NaN, -1];
      // Filtered to [100, 200, 300, 400, 500] (N=5)
      // p50 -> 300, p95 -> 500
      expect(calculatePercentile(contaminated, 50)).toBe(300);
      expect(calculatePercentile(contaminated, 95)).toBe(500);
    });
  });

  // ==========================================================================
  // SECTION 6: Time Window Temporal Boundaries (24h, 7d, 30d Exact Millisecond Edges)
  // ==========================================================================
  describe('6. Temporal Boundaries & Window Filtering (24h, 7d, 30d)', () => {
    it('handles exact millisecond boundaries on getFilteredReviewLogs', () => {
      const originalClock = Date.now;
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const H24 = 24 * 3600 * 1000;

        // Reset logs with specific boundary timestamps
        (dashboardStore as any).data.reviewLogs = [
          {
            id: 'log-boundary-inside',
            timestamp: new Date(now - H24 + 1000).toISOString(), // 1s inside 24h window
            latencyMs: 1500,
            costUSD: 0.1,
            repo: 'exampleorg/test',
          },
          {
            id: 'log-boundary-exact',
            timestamp: new Date(now - H24).toISOString(), // Exact boundary
            latencyMs: 2000,
            costUSD: 0.2,
            repo: 'exampleorg/test',
          },
          {
            id: 'log-boundary-outside',
            timestamp: new Date(now - H24 - 1000).toISOString(), // 1s outside 24h window
            latencyMs: 2500,
            costUSD: 0.3,
            repo: 'exampleorg/test',
          },
        ];
        // Invalidate cache
        (dashboardStore as any).cache.analyticsSummary = {};

        const filtered24h = dashboardStore.getFilteredReviewLogs('24h');
        const ids24h = filtered24h.map((l) => l.id);

        expect(ids24h).toContain('log-boundary-inside');
        expect(ids24h).toContain('log-boundary-exact');
        expect(ids24h).not.toContain('log-boundary-outside');

        // However, 7d window must include all three!
        const filtered7d = dashboardStore.getFilteredReviewLogs('7d');
        expect(filtered7d.map((l) => l.id)).toEqual(
          expect.arrayContaining(['log-boundary-inside', 'log-boundary-exact', 'log-boundary-outside'])
        );
        expect(Date.now()).toBe(now);
      } finally {
        clock.mockRestore();
      }
      expect(Date.now).toBe(originalClock);
    });

    it('safely discards invalid, corrupted, or null timestamps', () => {
      (dashboardStore as any).data.reviewLogs = [
        { id: 'log-valid', timestamp: new Date().toISOString(), latencyMs: 1000, costUSD: 0.1 },
        { id: 'log-null-ts', timestamp: null as any, latencyMs: 1000, costUSD: 0.1 },
        { id: 'log-empty-ts', timestamp: '', latencyMs: 1000, costUSD: 0.1 },
        { id: 'log-corrupt-ts', timestamp: 'not-a-valid-date-format', latencyMs: 1000, costUSD: 0.1 },
      ];
      (dashboardStore as any).cache.analyticsSummary = {};

      const filtered = dashboardStore.getFilteredReviewLogs('24h');
      expect(filtered.length).toBe(1);
      expect(filtered[0].id).toBe('log-valid');
    });
  });

  // ==========================================================================
  // SECTION 7: Out-of-Order Review Logs & Monotonic Cumulative Token Burn Invariance
  // ==========================================================================
  describe('7. Out-of-Order Review Logs & Monotonic Cumulative Token Burn', () => {
    it('guarantees cumulative token burn curves are strictly monotonically non-decreasing under shuffled inputs', () => {
      const now = Date.now();
      const DAY = 24 * 3600 * 1000;

      // Create logs across 7 days in intentionally reverse/shuffled chronological order
      const daysOffset = [6, 2, 5, 0, 4, 1, 3];
      const shuffledLogs = daysOffset.map((offset, idx) => ({
        id: `log-shuffle-${idx}`,
        timestamp: new Date(now - offset * DAY).toISOString(),
        latencyMs: 1500,
        costUSD: 0.25,
        tokens: { prompt: 10000 * (offset + 1), completion: 2000 * (offset + 1), total: 12000 * (offset + 1) },
        repo: 'exampleorg/burn-test',
      }));

      (dashboardStore as any).data.reviewLogs = shuffledLogs;
      (dashboardStore as any).cache.tokenTimeSeries = {};

      const tokenSeries = dashboardStore.getTokenTimeSeries('7d', 'exampleorg/burn-test', 'day');
      const dataPoints = Array.isArray(tokenSeries.data) ? tokenSeries.data : [];

      expect(dataPoints.length).toBe(7);

      // Verify strict monotonicity: cumulativeTokens[i] <= cumulativeTokens[i+1]
      for (let i = 0; i < dataPoints.length - 1; i++) {
        expect(dataPoints[i + 1].cumulativeTokens).toBeGreaterThanOrEqual(dataPoints[i].cumulativeTokens);
      }

      // Final cumulative tokens must match sum of all daily totalTokens
      const sumOfDays = dataPoints.reduce((acc, p) => acc + p.totalTokens, 0);
      const lastPoint = dataPoints[dataPoints.length - 1];
      expect(lastPoint.cumulativeTokens).toBe(sumOfDays);
      expect(tokenSeries.totalTokens).toBe(sumOfDays);
    });
  });

  // ==========================================================================
  // SECTION 8: Floating-Point Spend Summation & IEEE 754 Drift Immunity
  // ==========================================================================
  describe('8. Floating-Point Financial Spend Summation & IEEE 754 Drift', () => {
    it('prevents IEEE 754 floating-point drift across 100 fractional penny reviews ($0.0001)', () => {
      const now = Date.now();
      const fractionalLogs = Array.from({ length: 100 }, (_, idx) => ({
        id: `log-float-${idx}`,
        timestamp: new Date(now - 1000 * idx).toISOString(),
        latencyMs: 1200,
        costUSD: 0.0001, // 100 * 0.0001 = 0.0100 exactly
        tokens: { prompt: 100, completion: 50, total: 150 },
        repo: 'exampleorg/micro-spend',
      }));

      (dashboardStore as any).data.reviewLogs = fractionalLogs;
      (dashboardStore as any).cache.analyticsSummary = {};
      (dashboardStore as any).cache.costBreakdown = {};

      const summary = dashboardStore.getAnalyticsSummary('24h', 'exampleorg/micro-spend');
      // 100 * 0.0001 in standard floating point can be 0.010000000000000009
      expect(summary.totalSpendUsd).toBe(0.01);
      expect(String(summary.totalSpendUsd).length).toBeLessThanOrEqual(6);

      const costs = dashboardStore.getCostBreakdown('24h', 'exampleorg/micro-spend');
      expect(costs.totalSpendUsd).toBe(0.01);

      const repoEntry = costs.byRepo?.find((r) => r.repo === 'exampleorg/micro-spend');
      expect(repoEntry).toBeDefined();
      expect(repoEntry?.spendUsd).toBe(0.01);
      expect(repoEntry?.avgSpendPerPR).toBe(0.0001);
    });

    it('correctly aggregates multi-repo spend without floating point drift or mismatch', () => {
      const now = Date.now();
      const logs = [
        { id: 'log-1', timestamp: new Date(now - 1000).toISOString(), latencyMs: 1000, costUSD: 0.1, repo: 'repo-A' },
        { id: 'log-2', timestamp: new Date(now - 2000).toISOString(), latencyMs: 1000, costUSD: 0.2, repo: 'repo-B' },
        { id: 'log-3', timestamp: new Date(now - 3000).toISOString(), latencyMs: 1000, costUSD: 0.3, repo: 'repo-C' },
      ];

      (dashboardStore as any).data.reviewLogs = logs;
      (dashboardStore as any).cache.analyticsSummary = {};
      (dashboardStore as any).cache.costBreakdown = {};

      // 0.1 + 0.2 + 0.3 in raw JS floats is 0.6000000000000001
      const summary = dashboardStore.getAnalyticsSummary('24h');
      expect(summary.totalSpendUsd).toBe(0.6);

      const costs = dashboardStore.getCostBreakdown('24h');
      expect(costs.totalSpendUsd).toBe(0.6);

      const repoSum = (costs.byRepo || []).reduce((acc, r) => acc + r.spendUsd, 0);
      expect(parseFloat(repoSum.toFixed(4))).toBe(0.6);
    });
  });
});
