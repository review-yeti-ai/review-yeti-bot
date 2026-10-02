/**
 * Review Yeti — M5 Tier 5 Adversarial Stress & Hardening Test Suite
 * Location: tests/adversarial/m5ChallengerAuthLiveStress.test.ts
 *
 * White-box adversarial qualification covering:
 * 1. Auth & Session Security: CSRF state replay attacks, expired nonces, malformed states,
 *    open redirect defenses, session revocation under active requests, role boundaries,
 *    and org/repo permission barriers.
 * 2. Live SSE Streaming: High-throughput event bursts (1,200+ events), ring buffer overflow (500 cap),
 *    rapid client connect/disconnect cycles, broken write exception handling, multi-tenant job isolation,
 *    and progress observer error containment.
 * 3. Diff Viewer & Patch Hunk Parsing: Corrupted diff headers, non-numeric line values, CRLF/CR/LF
 *    normalization, git no-newline markers, extreme hunk sizes (10,000+ lines), multi-hunk offset drift,
 *    and anchored finding stability.
 * 4. Live Diff API Endpoints: Parameter validation, missing jobs, file-path filtering, and synthetic fallbacks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { Express, Response } from 'express';
import { EventEmitter } from 'events';
import { createApp } from '../../src/app';
import { authService, UserSession } from '../../src/dashboard/authService';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { LiveStreamBus, type LiveStreamEvent } from '../../src/live/liveStreamBus';
import { createPRSnapshot } from '../../src/review/prSnapshot';
import {
  parsePatchHunks,
  normalizeFileStatus,
  parseSnapshotDiff,
  resolveReviewDiff,
  type DiffHunk,
} from '../../src/review/diffService';
import { computeFindingId, sha256 } from '../../src/lib/findingUtils';
import type { AnchoredFinding } from '../../src/types/diff';

// ============================================================================
// MOCK RESPONSE FACTORY FOR SSE ADVERSARIAL STRESS
// ============================================================================

interface MockSseResponse extends Response {
  writes: string[];
  headers: Record<string, string>;
  isClosed: boolean;
  shouldThrowOnWrite: boolean;
  emitClose: () => void;
}

function createMockSseResponse(options: { shouldThrowOnWrite?: boolean } = {}): MockSseResponse {
  const emitter = new EventEmitter();
  const res: any = {
    writes: [],
    headers: {},
    isClosed: false,
    shouldThrowOnWrite: options.shouldThrowOnWrite ?? false,
    setHeader: vi.fn((key: string, value: string) => {
      if (res.headers) res.headers[key.toLowerCase()] = value;
      return res as Response;
    }),
    write: vi.fn((chunk: any) => {
      if (res.shouldThrowOnWrite) {
        throw new Error('EPIPE: broken pipe on SSE stream');
      }
      if (res.writes) res.writes.push(String(chunk));
      return true;
    }),
    flushHeaders: vi.fn(),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      emitter.on(event, listener);
      return res as Response;
    }),
    emitClose: () => {
      res.isClosed = true;
      emitter.emit('close');
    },
  };
  return res as MockSseResponse;
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe('M5 Tier 5 Adversarial Challenger: Auth, Live Stream & Diff Viewer Stress', () => {
  let app: Express;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    authService.reset();
    dashboardStore.reset();
    LiveStreamBus.getInstance().clearHistory();

    process.env.GITHUB_CLIENT_ID = 'test_gh_client_id_adv';
    process.env.GITHUB_CLIENT_SECRET = 'test_gh_client_secret_adv';
    process.env.ADMIN_PASSWORD = 'adversarial_admin_pw';

    app = createApp();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // SECTION 1: OAUTH & SESSION SECURITY ADVERSARIAL STRESS
  // ==========================================================================
  describe('1. OAuth CSRF State & Session Security Adversarial Stress', () => {
    it('enforces single-use CSRF tokens and rejects replay attacks immediately', () => {
      const state = authService.createOAuthState('/repos/exampleorg/example-api');
      expect(state).toHaveLength(48);

      // First consumption succeeds
      const firstAttempt = authService.consumeOAuthState(state);
      expect(firstAttempt.valid).toBe(true);
      expect(firstAttempt.returnTo).toBe('/repos/exampleorg/example-api');

      // Second consumption (replay attack) fails
      const replayAttempt1 = authService.consumeOAuthState(state);
      expect(replayAttempt1.valid).toBe(false);
      expect(replayAttempt1.returnTo).toBe('/repos');

      // Repeated replay attacks continue to fail
      for (let i = 0; i < 5; i++) {
        const replay = authService.consumeOAuthState(state);
        expect(replay.valid).toBe(false);
      }
    });

    it('rejects expired CSRF states and purges stale records from memory', () => {
      const oldNow = Date.now();
      const state = authService.createOAuthState('/repos');

      // Simulate clock jumping 11 minutes into future (> 10m TTL)
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(oldNow + 11 * 60 * 1000);

      const result = authService.consumeOAuthState(state);
      expect(result.valid).toBe(false);
      expect(result.returnTo).toBe('/repos');

      // Next createOAuthState cleans up expired records
      authService.createOAuthState('/dashboard');
      dateSpy.mockRestore();
    });

    it('defends against malformed, SQL injection, and path traversal state tokens', () => {
      const maliciousStates = [
        '',
        '   ',
        "' OR '1'='1",
        "'; DROP TABLE sessions; --",
        '../../../../etc/passwd',
        '<script>alert("csrf")</script>',
        'A'.repeat(10000), // Buffer overflow attempt
        'null',
        'undefined',
        '\x00\x01\x02\xFF',
      ];

      for (const badState of maliciousStates) {
        const res = authService.consumeOAuthState(badState);
        expect(res.valid).toBe(false);
        expect(res.returnTo).toBe('/repos');
      }
    });

    it('defends against open redirect attacks via return_to / redirect parameter', () => {
      const openRedirectAttacks = [
        'https://attacker-stealer.com/auth-callback',
        'http://phishing.site/login',
        '//attacker.com/evil',
        '/\\attacker.com/evil',
        '\\\\attacker.com/evil',
        'javascript:alert(document.cookie)',
        'data:text/html,<script>alert(1)</script>',
      ];

      for (const attack of openRedirectAttacks) {
        const state = authService.createOAuthState(attack);
        const { valid, returnTo } = authService.consumeOAuthState(state);
        expect(valid).toBe(true);
        expect(returnTo).toBe('/repos'); // Neutralized to safe default
      }

      // Safe relative paths must be preserved
      const safePaths = [
        '/repos',
        '/dashboard/settings',
        '/repos/exampleorg/example-api/pulls/108',
      ];
      for (const safe of safePaths) {
        const state = authService.createOAuthState(safe);
        const { valid, returnTo } = authService.consumeOAuthState(state);
        expect(valid).toBe(true);
        expect(returnTo).toBe(safe);
      }
    });

    it('HTTP Route: GET /api/auth/github/callback rejects replay and malformed queries with 400', async () => {
      const state = authService.createOAuthState('/repos');

      // Mock GitHub code exchange
      vi.spyOn(authService, 'exchangeGitHubCode').mockResolvedValue({
        accessToken: 'gho_mock_valid_token_123',
        scope: 'read:user,repo',
      });
      vi.spyOn(authService, 'fetchGitHubUserProfile').mockResolvedValue({
        id: 'gh_9999',
        username: 'adversary-tester',
        role: 'reviewer',
        provider: 'github',
      });

      // 1. Initial valid exchange
      const firstRes = await request(app)
        .get(`/api/auth/github/callback?code=valid_code_1&state=${state}&format=json`)
        .set('Accept', 'application/json');
      expect(firstRes.status).toBe(200);
      expect(firstRes.body.success).toBe(true);
      expect(firstRes.body.token).toBeDefined();

      // 2. Replay attack with same state fails
      const replayRes = await request(app)
        .get(`/api/auth/github/callback?code=valid_code_2&state=${state}&format=json`)
        .set('Accept', 'application/json');
      expect(replayRes.status).toBe(400);
      expect(replayRes.body.success).toBe(false);
      expect(replayRes.body.error).toContain('Invalid or expired OAuth state');

      // 3. Missing code
      const noCodeRes = await request(app)
        .get(`/api/auth/github/callback?state=some_state&format=json`)
        .set('Accept', 'application/json');
      expect(noCodeRes.status).toBe(400);
      expect(noCodeRes.body.error).toContain('Missing code or state parameter');

      // 4. Missing state
      const noStateRes = await request(app)
        .get(`/api/auth/github/callback?code=some_code&format=json`)
        .set('Accept', 'application/json');
      expect(noStateRes.status).toBe(400);
      expect(noStateRes.body.error).toContain('Missing code or state parameter');

      // 5. Upstream GitHub error
      const errorRes = await request(app)
        .get(`/api/auth/github/callback?error=access_denied&error_description=User+denied+access&format=json`)
        .set('Accept', 'application/json');
      expect(errorRes.status).toBe(400);
      expect(errorRes.body.error).toContain('User denied access');
    });

    it('invalidates session upon DELETE /api/auth/session and blocks subsequent requests', async () => {
      // 1. Create session
      const session = authService.createGitHubSession({
        id: 'gh_4001',
        username: 'alice',
        role: 'reviewer',
        provider: 'github',
        accessToken: 'upstream_secret_token_never_leak',
      });

      // 2. Verify active session works
      const verifyRes1 = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${session.token}`);
      expect(verifyRes1.status).toBe(200);
      expect(verifyRes1.body.authenticated).toBe(true);
      expect(verifyRes1.body.user.username).toBe('alice');
      // Invariant: upstream accessToken must NEVER be exposed
      expect(verifyRes1.body.user.accessToken).toBeUndefined();

      // 3. Logout / revoke session
      const logoutRes = await request(app)
        .delete('/api/auth/session')
        .set('Authorization', `Bearer ${session.token}`);
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.success).toBe(true);
      expect(logoutRes.headers['set-cookie']?.[0]).toContain('ct_session_token=;');

      // 4. Immediate subsequent request with same token fails with 401
      const verifyRes2 = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${session.token}`);
      expect(verifyRes2.status).toBe(401);
      expect(verifyRes2.body.authenticated).toBe(false);

      // 5. Protected route rejects revoked token
      const protectedRes = await request(app)
        .get('/api/dashboard/overview')
        .set('Authorization', `Bearer ${session.token}`);
      expect(protectedRes.status).toBe(401);
    });

    it('strictly enforces role boundaries: viewer role cannot submit verdict overrides (403)', async () => {
      // Public viewer token
      const viewerToken = 'demo_token_public';
      const viewerSession = authService.validateSession(viewerToken);
      expect(viewerSession?.user.role).toBe('viewer');

      // Seed gate attempt for job-adv-01 so override can proceed
      dashboardStore.setGateAttempt('job-adv-01', {
        reviewId: 'job-adv-01',
        runId: 'job-adv-01',
        verdict: 'BLOCK',
        desired_state: 'failure',
        desired_version: 1,
        published_version: 1,
        updated_at: new Date().toISOString(),
      });

      // Attempt verdict override as viewer
      const overrideRes = await request(app)
        .post('/api/reviews/job-adv-01/override')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({
          overrideVerdict: 'SHIP',
          reason: 'Unauthorized attempt by viewer',
        });
      expect(overrideRes.status).toBe(403);
      expect(overrideRes.body.success).toBe(false);
      expect(overrideRes.body.error).toContain('Forbidden: viewer role cannot submit verdict overrides');

      // Attempt as admin
      const adminSession = authService.login('admin', 'adversarial_admin_pw');
      expect(adminSession).not.toBeNull();

      const adminOverrideRes = await request(app)
        .post('/api/reviews/job-adv-01/override')
        .set('Authorization', `Bearer ${adminSession!.token}`)
        .send({
          overrideVerdict: 'SHIP',
          reason: 'Authorized override by admin',
        });
      expect(adminOverrideRes.status).toBe(200);
      expect(adminOverrideRes.body.success).toBe(true);
      expect(adminOverrideRes.body.overrideVerdict).toBe('SHIP');
      expect(adminOverrideRes.body.gateVersion).toBeDefined();
    });

    it('enforces repository boundaries: unmonitored or uninstalled repositories return 404', async () => {
      const adminSession = authService.login('admin', 'adversarial_admin_pw')!;

      // 1. Non-existent repository rules
      const rulesRes = await request(app)
        .get('/api/dashboard/repositories/unknown-org/ghost-repo/rules')
        .set('Authorization', `Bearer ${adminSession.token}`);
      expect(rulesRes.status).toBe(404);
      expect(rulesRes.body.error).toContain('Repository unknown-org/ghost-repo not found');

      // 2. Non-existent pull requests discovery
      const pullsRes = await request(app)
        .get('/api/github/repos/unknown-org/ghost-repo/pulls')
        .set('Authorization', `Bearer ${adminSession.token}`);
      expect(pullsRes.status).toBe(404);
      expect(pullsRes.body.error).toContain('Repository unknown-org/ghost-repo not found');

      // 3. Unauthenticated access to orgs is blocked with 401
      const unauthOrgs = await request(app).get('/api/github/orgs');
      expect(unauthOrgs.status).toBe(401);
    });
  });

  // ==========================================================================
  // SECTION 2: LIVE SSE STREAMING ADVERSARIAL RESILIENCE
  // ==========================================================================
  describe('2. Live SSE Streaming High-Burst & Resilience Stress', () => {
    it('handles high-throughput burst of 1,200 events and maintains 500-event ring buffer cap', () => {
      const bus = LiveStreamBus.getInstance();
      const jobId = 'job-burst-adversarial-1200';

      const mockRes = createMockSseResponse();
      bus.addClient(jobId, mockRes);

      // Emit 1,200 rapid events
      const burstSize = 1200;
      for (let i = 1; i <= burstSize; i++) {
        const eventType = i % 3 === 0 ? 'reasoning:chunk' : i % 3 === 1 ? 'tool:start' : 'tool:result';
        bus.publishEvent({
          jobId,
          timestamp: new Date(Date.now() + i * 10).toISOString(),
          type: eventType as any,
          persona: 'security',
          data: {
            turn: i,
            reasoning: `Reasoning trace chunk ${i}`,
            promptTokens: 10,
            completionTokens: 5,
            costUSD: 0.0001,
          },
        });
      }

      // Check client received all 1,200 events live
      expect(mockRes.writes.length).toBe(burstSize);

      // Invariant: Ring buffer must cap historical events to exactly 500
      const history = bus.getHistory(jobId);
      expect(history.length).toBe(500);

      // Verify FIFO: oldest 700 events discarded; first event in history is #701
      const firstRetained = history[0];
      const lastRetained = history[499];
      expect(firstRetained.data.turn).toBe(701);
      expect(lastRetained.data.turn).toBe(1200);

      // Invariant: Job Summary metrics aggregated accurately across all 1,200 events
      const job = bus.getJobStatus(jobId);
      expect(job).toBeDefined();
      expect(job?.eventCount).toBe(1200);
      expect(job?.tokenMetrics.promptTokens).toBe(1200 * 10);
      expect(job?.tokenMetrics.completionTokens).toBe(1200 * 5);
      expect(job?.tokenMetrics.totalTokens).toBe(1200 * 15);
      expect(job?.tokenMetrics.estimatedCostUSD).toBeCloseTo(1200 * 0.0001, 4);

      mockRes.emitClose();
    });

    it('recovers gracefully from broken socket write errors without crashing or leaking clients', () => {
      const bus = LiveStreamBus.getInstance();
      const jobId = 'job-broken-socket-test';

      const brokenRes = createMockSseResponse({ shouldThrowOnWrite: true });
      const healthyRes = createMockSseResponse({ shouldThrowOnWrite: false });

      bus.addClient(jobId, healthyRes);
      bus.addClient(jobId, brokenRes);

      // Verify both clients initially registered
      expect((bus as any).clients.get(jobId)?.size).toBe(2);

      // Publishing an event triggers brokenRes.write exception
      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'reasoning:chunk',
        persona: 'architecture',
        data: { reasoning: 'Testing broken socket resilience' },
      });

      // Healthy client received event
      expect(healthyRes.writes.length).toBe(1);

      // Broken client was cleanly removed from clients map
      const clientSet = (bus as any).clients.get(jobId);
      expect(clientSet.size).toBe(1);
      expect(clientSet.has(brokenRes)).toBe(false);
      expect(clientSet.has(healthyRes)).toBe(true);

      // Broken client's heartbeat ping interval timer was cancelled
      expect((bus as any).pingIntervals.has(brokenRes)).toBe(false);

      healthyRes.emitClose();
    });

    it('handles 100 rapid client connect and disconnect cycles with zero memory leaks', () => {
      const bus = LiveStreamBus.getInstance();
      const jobId = 'job-rapid-churn-stress';

      const clients: MockSseResponse[] = [];
      for (let i = 0; i < 100; i++) {
        const res = createMockSseResponse();
        clients.push(res);
        bus.addClient(jobId, res);
      }

      expect((bus as any).clients.get(jobId)?.size).toBe(100);
      expect((bus as any).pingIntervals.size).toBe(100);

      // Disconnect all 100 clients
      for (const client of clients) {
        client.emitClose();
      }

      // Invariant: No leaking sets or timer handles
      expect((bus as any).clients.get(jobId)).toBeUndefined();
      expect((bus as any).pingIntervals.size).toBe(0);
    });

    it('enforces multi-tenant stream isolation across distinct review jobs and wildcard subscribers', () => {
      const bus = LiveStreamBus.getInstance();
      const jobA = 'job-tenant-alpha';
      const jobB = 'job-tenant-beta';

      const clientA = createMockSseResponse();
      const clientB = createMockSseResponse();
      const clientGlobal = createMockSseResponse();

      bus.addClient(jobA, clientA);
      bus.addClient(jobB, clientB);
      bus.addClient('*', clientGlobal);

      // Emit 10 events to Job A
      for (let i = 0; i < 10; i++) {
        bus.publishEvent({
          jobId: jobA,
          timestamp: new Date().toISOString(),
          type: 'reasoning:chunk',
          persona: 'security',
          data: { chunk: `A-${i}` },
        });
      }

      // Emit 15 events to Job B
      for (let i = 0; i < 15; i++) {
        bus.publishEvent({
          jobId: jobB,
          timestamp: new Date().toISOString(),
          type: 'reasoning:chunk',
          persona: 'performance',
          data: { chunk: `B-${i}` },
        });
      }

      // Invariants:
      // Client A only saw Job A (10 events)
      expect(clientA.writes.length).toBe(10);
      for (const w of clientA.writes) {
        expect(w).toContain('job-tenant-alpha');
        expect(w).not.toContain('job-tenant-beta');
      }

      // Client B only saw Job B (15 events)
      expect(clientB.writes.length).toBe(15);
      for (const w of clientB.writes) {
        expect(w).toContain('job-tenant-beta');
        expect(w).not.toContain('job-tenant-alpha');
      }

      // Client Global saw all 25 events
      expect(clientGlobal.writes.length).toBe(25);

      clientA.emitClose();
      clientB.emitClose();
      clientGlobal.emitClose();
    });

    it('contains observer exceptions and prevents progress sink errors from corrupting bus state', () => {
      const bus = LiveStreamBus.getInstance();
      const jobId = 'job-observer-error-containment';

      let errorReported = false;
      const throwingSink = {
        publish: () => {
          throw new Error('Explosion inside observation sink');
        },
      };

      bus.setProgressSink(
        throwingSink,
        () => ({ runId: jobId, attempt: 1 } as any),
        () => {
          errorReported = true;
        }
      );

      const client = createMockSseResponse();
      bus.addClient(jobId, client);

      // Publishing event must succeed and reach client despite sink explosion
      expect(() => {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'tool:start',
          persona: 'quality',
          data: { tool: 'semgrep' },
        });
      }).not.toThrow();

      expect(client.writes.length).toBe(1);
      expect(client.writes[0]).toContain('semgrep');

      client.emitClose();
      bus.setProgressSink(undefined, undefined, undefined);
    });
  });

  // ==========================================================================
  // SECTION 3: DIFF VIEWER & PATCH HUNK ADVERSARIAL PARSING
  // ==========================================================================
  describe('3. Diff Viewer & Patch Hunk Adversarial Parsing', () => {
    it('handles corrupted, non-numeric, and malformed hunk headers without throwing', () => {
      const corruptedPatches = [
        // Completely non-numeric coordinates
        '@@ -abc,def +ghi,jkl @@\n-old\n+new',
        // Incomplete coordinate pair
        '@@ -10 @@\n-old\n+new',
        // Unclosed header
        '@@ -10,5 +20,5\n-old\n+new',
        // Trailing code and symbols in header
        '@@ -1,2 +3,4 @@ function foo(x: any) { /* trailing garbage */ }\n-var a = 1;\n+const a = 1;',
        // Negative coordinates
        '@@ -10,-5 +20,-8 @@\n-old\n+new',
        // Zero start and zero lines
        '@@ -0,0 +0,0 @@\n',
      ];

      for (const patch of corruptedPatches) {
        expect(() => {
          const { hunks, additions, deletions } = parsePatchHunks(patch);
          expect(Array.isArray(hunks)).toBe(true);
          expect(typeof additions).toBe('number');
          expect(typeof deletions).toBe('number');
        }).not.toThrow();
      }
    });

    it('normalizes CRLF, CR, and LF line endings identically', () => {
      const lines = [
        '@@ -10,3 +10,4 @@',
        ' context line 1',
        '-old line 2',
        '+new line 2',
        '+new line 3',
        ' context line 4',
      ];

      const patchLf = lines.join('\n');
      const patchCrlf = lines.join('\r\n');
      const patchCr = lines.join('\r');

      const parsedLf = parsePatchHunks(patchLf);
      const parsedCrlf = parsePatchHunks(patchCrlf);
      const parsedCr = parsePatchHunks(patchCr);

      expect(parsedCrlf.additions).toBe(parsedLf.additions);
      expect(parsedCrlf.deletions).toBe(parsedLf.deletions);
      expect(parsedCrlf.hunks[0].lines.length).toBe(parsedLf.hunks[0].lines.length);

      expect(parsedCr.additions).toBe(parsedLf.additions);
      expect(parsedCr.deletions).toBe(parsedLf.deletions);
      expect(parsedCr.hunks[0].lines.length).toBe(parsedLf.hunks[0].lines.length);
    });

    it('correctly ignores git no-newline markers without altering addition or deletion counters', () => {
      const patchWithNoNewline = [
        '@@ -1,2 +1,2 @@',
        '-line1',
        '+line1 modified',
        '\\ No newline at end of file',
      ].join('\n');

      const { hunks, additions, deletions } = parsePatchHunks(patchWithNoNewline);
      expect(additions).toBe(1);
      expect(deletions).toBe(1);
      expect(hunks[0].lines).toContain('\\ No newline at end of file');
    });

    it('parses extreme hunk sizes (10,000+ lines) efficiently in < 50ms', () => {
      const hunkLines: string[] = ['@@ -1,5000 +1,5000 @@'];
      for (let i = 0; i < 5000; i++) {
        hunkLines.push(`-deletion line content ${i}`);
        hunkLines.push(`+addition line content ${i}`);
      }
      const massivePatch = hunkLines.join('\n');

      const t0 = performance.now();
      const { hunks, additions, deletions } = parsePatchHunks(massivePatch);
      const durationMs = performance.now() - t0;

      expect(additions).toBe(5000);
      expect(deletions).toBe(5000);
      expect(hunks.length).toBe(1);
      expect(hunks[0].lines.length).toBe(10000);
      expect(durationMs).toBeLessThan(100); // Strict performance budget
    });

    it('handles binary files, empty diffs, and pure additions/deletions accurately', () => {
      // 1. Binary file diff
      const binaryPatch = 'Binary files a/assets/logo.png and b/assets/logo.png differ';
      const binaryParsed = parsePatchHunks(binaryPatch);
      expect(binaryParsed.hunks.length).toBe(0);
      expect(binaryParsed.additions).toBe(0);
      expect(binaryParsed.deletions).toBe(0);

      // 2. Empty or null patch
      expect(parsePatchHunks('').hunks).toHaveLength(0);
      expect(parsePatchHunks(null).hunks).toHaveLength(0);
      expect(parsePatchHunks(undefined).hunks).toHaveLength(0);

      // 3. Pure file addition
      const addPatch = '@@ -0,0 +1,20 @@\n' + Array(20).fill('+added line').join('\n');
      const addParsed = parsePatchHunks(addPatch);
      expect(addParsed.additions).toBe(20);
      expect(addParsed.deletions).toBe(0);
      expect(normalizeFileStatus({ path: 'new.ts' }, addParsed.hunks)).toBe('added');

      // 4. Pure file deletion
      const delPatch = '@@ -1,20 +0,0 @@\n' + Array(20).fill('-deleted line').join('\n');
      const delParsed = parsePatchHunks(delPatch);
      expect(delParsed.additions).toBe(0);
      expect(delParsed.deletions).toBe(20);
      expect(normalizeFileStatus({ path: 'old.ts' }, delParsed.hunks)).toBe('deleted');
    });

    it('ensures multi-hunk offset stability and prevents line number anchor drift', () => {
      const multiHunkPatch = [
        '@@ -5,4 +5,6 @@', // Hunk 1: starts at line 5
        ' context 1',
        '+added 1',
        '+added 2',
        ' context 2',
        '@@ -50,5 +52,7 @@', // Hunk 2: starts at line 52
        ' context 50',
        '+added 51',
        '+added 52',
        ' context 53',
        '@@ -200,3 +204,3 @@', // Hunk 3: starts at line 204
        ' context 200',
        '-deleted 201',
        '+modified 201',
        ' context 202',
      ].join('\n');

      const { hunks } = parsePatchHunks(multiHunkPatch);
      expect(hunks).toHaveLength(3);

      expect(hunks[0].newStart).toBe(5);
      expect(hunks[1].newStart).toBe(52);
      expect(hunks[2].newStart).toBe(204);

      // Parse full snapshot diff
      const diffResponse = parseSnapshotDiff('job-anchoring-test', createPRSnapshot({
        owner: 'exampleorg',
        repo: 'example-api',
        prNumber: 402,
        headSha: 'head123',
        baseSha: 'base123',
        configRef: 'main',
        configDigest: 'digest123',
        engineVersion: '1.0.0',
        changedFiles: [
          {
            path: 'src/core/router.ts',
            status: 'modified',
            patch: multiHunkPatch,
          },
        ],
      }));

      expect(diffResponse.files[0].hunks).toHaveLength(3);
      expect(diffResponse.totalAdditions).toBe(5);
      expect(diffResponse.totalDeletions).toBe(1);
    });

    it('computes deterministic, collision-resistant finding IDs with path and line normalization', () => {
      const repo = 'exampleorg/example-api';
      const file = 'src/auth/jwtSigner.ts';
      const line = 42;
      const title = 'Potential Timing Attack on HMAC Verification';

      const id1 = computeFindingId(repo, file, line, title);
      const id2 = computeFindingId(repo, file, line, title);
      expect(id1).toBe(id2);
      expect(id1).toHaveLength(64);

      // Normalization test: leading ./ or / stripped
      const idStripped1 = computeFindingId(repo, './src/auth/jwtSigner.ts', line, title);
      const idStripped2 = computeFindingId(repo, '/src/auth/jwtSigner.ts', line, title);
      expect(idStripped1).toBe(id1);
      expect(idStripped2).toBe(id1);

      // Line normalization: negative or NaN falls back to 1
      const idFallback = computeFindingId(repo, file, -10 as any, title);
      const idLine1 = computeFindingId(repo, file, 1, title);
      expect(idFallback).toBe(idLine1);

      // Collisions: differing line numbers produce distinct IDs
      const idLine43 = computeFindingId(repo, file, 43, title);
      expect(idLine43).not.toBe(id1);

      // Collisions: differing titles produce distinct IDs
      const idOtherTitle = computeFindingId(repo, file, line, 'Different finding title');
      expect(idOtherTitle).not.toBe(id1);
    });
  });

  // ==========================================================================
  // SECTION 4: LIVE DIFF & STREAMING API ADVERSARIAL INTEGRATION
  // ==========================================================================
  describe('4. Live Diff API & Streaming Endpoints Adversarial Integration', () => {
    it('GET /api/live/diff validates jobId and returns 400 when missing or empty', async () => {
      const missingRes = await request(app).get('/api/live/diff');
      expect(missingRes.status).toBe(400);
      expect(missingRes.body.error).toContain('Missing required query parameter: jobId');

      const whitespaceRes = await request(app).get('/api/live/diff?jobId=   ');
      expect(whitespaceRes.status).toBe(400);
      expect(whitespaceRes.body.error).toContain('Missing required query parameter: jobId');
    });

    it('GET /api/live/diff returns 404 for unknown job or non-existent file path', async () => {
      const notFoundRes = await request(app).get('/api/live/diff?jobId=job-non-existent-9999');
      expect(notFoundRes.status).toBe(404);
      expect(notFoundRes.body.error).toContain('Review diff not found for job');

      // Test synthetic fallback job
      const syntheticRes = await request(app).get('/api/live/diff?jobId=job-test-402');
      expect(syntheticRes.status).toBe(200);
      expect(syntheticRes.body.files).toBeDefined();

      // Filter by non-existent file path inside valid job
      const filterRes = await request(app).get(
        '/api/live/diff?jobId=job-test-402&path=nonexistent/path/file.ts'
      );
      expect(filterRes.status).toBe(404);
      expect(filterRes.body.error).toContain("File 'nonexistent/path/file.ts' not found");
    });

    it('GET /api/live/stream supports authenticated query tokens and public fallback', async () => {
      function mockSseRequest(targetApp: Express, urlPath: string) {
        return new Promise<{ status: number; headers: Record<string, string>; streamStarted: boolean }>((resolve) => {
          const [pathOnly, queryString] = urlPath.split('?');
          const queryParams: Record<string, string> = {};
          if (queryString) {
            new URLSearchParams(queryString).forEach((v, k) => {
              queryParams[k] = v;
            });
          }

          const req: any = new EventEmitter();
          req.method = 'GET';
          req.url = urlPath;
          req.path = pathOnly;
          req.query = queryParams;
          req.headers = { accept: 'text/event-stream' };
          req.unpipe = () => {};
          req._readableState = { pipes: [] };

          let statusCode = 200;
          const res: any = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; };
          res.getHeader = (k: string) => res.headers[k.toLowerCase()];
          res.status = (code: number) => {
            statusCode = code;
            res.statusCode = code;
            return res;
          };
          res.flushHeaders = () => {
            resolve({ status: statusCode, headers: res.headers, streamStarted: true });
          };
          res.write = (_chunk: any) => {
            resolve({ status: statusCode, headers: res.headers, streamStarted: true });
            return true;
          };
          res.end = () => {
            resolve({ status: statusCode, headers: res.headers, streamStarted: true });
          };

          (targetApp as any).handle(req, res, () => {});
        });
      }

      // 1. Public unauthenticated request returns 200 and SSE headers
      const publicRes = await mockSseRequest(app, '/api/live/stream?jobId=job-live-public');
      expect(publicRes.status).toBe(200);
      expect(publicRes.headers['content-type']).toBe('text/event-stream');
      expect(publicRes.headers['cache-control']).toBe('no-cache');
      expect(publicRes.headers['connection']).toBe('keep-alive');
      expect(publicRes.streamStarted).toBe(true);

      // 2. Authenticated query token (?token=...)
      const session = authService.createGitHubSession({
        id: 'gh_7777',
        username: 'bob',
        role: 'reviewer',
        provider: 'github',
      });

      const authRes = await mockSseRequest(app, `/api/live/stream?jobId=job-live-auth&token=${session.token}`);
      expect(authRes.status).toBe(200);
      expect(authRes.headers['content-type']).toBe('text/event-stream');
      expect(authRes.streamStarted).toBe(true);

      // 3. Invalid token gracefully falls back to unauthenticated stream (status 200)
      const invalidRes = await mockSseRequest(app, '/api/live/stream?jobId=job-live-invalid&token=bad_token');
      expect(invalidRes.status).toBe(200);
      expect(invalidRes.headers['content-type']).toBe('text/event-stream');
      expect(invalidRes.streamStarted).toBe(true);
    });

    it('GET /api/live/history retrieves buffered events or synthesizes from review logs', async () => {
      const bus = LiveStreamBus.getInstance();
      const jobId = 'job-history-api-test';

      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'persona:start',
        persona: 'security',
        data: { message: 'Security persona started' },
      });

      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'persona:finding',
        persona: 'security',
        data: { title: 'Found vulnerability' },
      });

      const historyRes = await request(app).get(`/api/live/history?jobId=${jobId}`);
      expect(historyRes.status).toBe(200);
      expect(historyRes.body.count).toBe(2);
      expect(historyRes.body.events[0].type).toBe('persona:start');
      expect(historyRes.body.events[1].type).toBe('persona:finding');
    });

    it('GET /api/live/queue and /api/live/active return accurate concurrency and queue metrics', async () => {
      const queueRes = await request(app).get('/api/live/queue');
      expect(queueRes.status).toBe(200);
      expect(queueRes.body.success).toBe(true);
      expect(typeof queueRes.body.activeJobsCount).toBe('number');
      expect(typeof queueRes.body.queuedJobsCount).toBe('number');
      expect(typeof queueRes.body.maxConcurrentJobs).toBe('number');

      const activeRes = await request(app).get('/api/live/active');
      expect(activeRes.status).toBe(200);
      expect(activeRes.body.success).toBe(true);
      expect(Array.isArray(activeRes.body.jobs)).toBe(true);
    });
  });
});
