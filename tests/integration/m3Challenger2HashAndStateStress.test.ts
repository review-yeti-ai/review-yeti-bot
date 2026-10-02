import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { authService } from '../../src/dashboard/authService';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { sha256, computeFindingId } from '../../src/lib/findingUtils';
import {
  gateTerminalMetadata,
  ReviewGatePublisher,
} from '../../src/review/reviewGatePublisher';
import {
  deriveReviewGateExternalId,
  REVIEW_GATE_CHECK_NAME,
} from '../../src/github/reviewGateClient';
import type {
  GatePublicationClaim,
  ReviewGateRepository,
  StoredReviewGate,
} from '../../src/review/reviewGateContracts';

describe('Milestone 3 Iteration 2 Challenger 2: Hash Parity & Concurrent State Gate Sync Stress', () => {
  let app: any;
  let reviewerToken: string;

  beforeEach(() => {
    app = createApp();

    reviewerToken = 'sess_challenger2_stress_token';
    (authService as any).sessions.set(reviewerToken, {
      token: reviewerToken,
      user: {
        id: 'usr_challenger2_runner',
        username: 'challenger2-worker',
        role: 'reviewer',
        email: 'challenger2@example.com',
      },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  // =========================================================================
  // Section 1: Pure TS SHA-256 and computeFindingId Bit-for-Bit Hash Parity
  // =========================================================================
  describe('1. Bit-for-Bit SHA-256 Parity Oracle vs Node.js crypto', () => {
    function nodeSha256(input: string): string {
      return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
    }

    it('HASH_01 — Standard NIST Cavium / FIPS 180-4 Vectors match bit-for-bit', () => {
      // 1. Empty string
      const empty = '';
      expect(sha256(empty)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      expect(sha256(empty)).toBe(nodeSha256(empty));

      // 2. Short standard vector "abc"
      const abc = 'abc';
      expect(sha256(abc)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      expect(sha256(abc)).toBe(nodeSha256(abc));

      // 3. Multi-block standard vector
      const multi = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
      expect(sha256(multi)).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
      expect(sha256(multi)).toBe(nodeSha256(multi));

      // 4. Repeated characters: 1,000 'a's, 10,000 'a's, 65,536 'a's
      const rep1k = 'a'.repeat(1000);
      expect(sha256(rep1k)).toBe(nodeSha256(rep1k));

      const rep10k = 'a'.repeat(10000);
      expect(sha256(rep10k)).toBe(nodeSha256(rep10k));

      const rep65k = 'a'.repeat(65536);
      expect(sha256(rep65k)).toBe(nodeSha256(rep65k));
    });

    it('HASH_02 — Padding and Block Boundary Sweeps: Every single byte length from 0 to 256 matches node crypto', () => {
      for (let len = 0; len <= 256; len++) {
        const str = 'X'.repeat(len);
        const actual = sha256(str);
        const expected = nodeSha256(str);
        if (actual !== expected) {
          throw new Error(`SHA-256 parity mismatch at length ${len}: expected ${expected}, got ${actual}`);
        }
      }
    });

    it('HASH_03 — Multi-byte UTF-8 Unicode Strings (Latin, Cyrillic, CJK, Arabic, Emoji, ZWJ)', () => {
      const testCases = [
        'Café au lait avec crème brûlée',
        'Привет, мир! Тестирование хэш-функции SHA-256 на русском языке.',
        '你好世界！这是一个针对纯TypeScript实现的SHA256哈希校验测试。',
        'こんにちは世界！東京都渋谷区道玄坂２丁目',
        '안녕하세요 세계! 리뷰 예티 대시보드 보안 검증',
        'مرحبا بالعالم! التحقق من تجزئة SHA-256 باللغة العربية',
        'שלום עולם! בדיקת גיבוב SHA-256',
        '🚀✨🎉🔥👻🤖👾💻🛡️🔒📦',
        '👨‍👩‍👧‍👦 👩‍💻 🏃🏽‍♂️ 🏳️‍🌈 🇺🇸 🇬🇧 🇯🇵',
        'Mathematical symbols: ∀x ∈ ℝ, ∃y: y > x ∧ ∑(1/n²) = π²/6',
        'Zero-width joiners and non-joiners: \u200D\u200C\uFEFF\u00A0',
        'Surrogate pair stress: \uD83D\uDE00\uD83D\uDE03\uD83D\uDE04\uD83D\uDE01',
      ];

      for (const str of testCases) {
        expect(sha256(str)).toBe(nodeSha256(str));
      }
    });

    it('HASH_04 — Special Characters, Escapes, Control Codes, Whitespace and Punctuation', () => {
      const specialStrings = [
        '\0\0\0',
        '\r\n\t\v\f\b',
        'Line 1\nLine 2\r\nLine 3\tTabbed',
        'Backslashes: \\\\ and slashes: /// and quotes: "\'`',
        '<script>alert("xss")</script>&amp;quot;',
        'JSON: {"key": "value", "arr": [1, 2, 3], "nested": {"a": true}}',
        'SQL: SELECT * FROM reviews WHERE id = \'1\' OR \'1\'=\'1\'; --',
        'ANSI: \u001b[31mRed Text\u001b[0m and \u001b[1mBold\u001b[0m',
        'Base64: aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q=',
      ];

      for (const str of specialStrings) {
        expect(sha256(str)).toBe(nodeSha256(str));
      }
    });

    it('HASH_05 — Pseudo-random Fuzzing: 500 generated randomized strings match node crypto', () => {
      for (let i = 0; i < 500; i++) {
        const len = (i * 7 + 13) % 512;
        const chars: string[] = [];
        for (let j = 0; j < len; j++) {
          const code = (i * 31 + j * 17) % 0x10ffff;
          if (code >= 0xd800 && code <= 0xdfff) {
            chars.push('A');
          } else {
            chars.push(String.fromCodePoint(code));
          }
        }
        const candidate = chars.join('');
        expect(sha256(candidate)).toBe(nodeSha256(candidate));
      }
    });

    it('HASH_06 — computeFindingId Normalization and Parity with Canonical Formula', () => {
      const testCases = [
        {
          repo: 'calltelemetry/review-yeti-core',
          file: 'src/api/auth.ts',
          line: 55,
          title: 'Weak Token Signing',
        },
        {
          repo: '  calltelemetry/review-yeti-core  ',
          file: './src/api/auth.ts',
          line: 55,
          title: '  Weak Token Signing  ',
        },
        {
          repo: 'calltelemetry/review-yeti-core',
          file: '/src/api/auth.ts',
          line: 55,
          title: 'Weak Token Signing',
        },
        {
          repo: 'calltelemetry/review-yeti-core',
          file: 'src/components/live/diff-viewer.tsx',
          line: 1,
          title: 'Unescaped HTML attribute in diff card',
        },
        {
          repo: 'org/repo-with-unicode-🚀',
          file: 'src/папка/файл.ts',
          line: 999,
          title: 'Обнаружена потенциальная уязвимость инъекции кода',
        },
        {
          repo: 'my-org/huge-path-repo',
          file: 'a/'.repeat(50) + 'very_deep_component.tsx',
          line: 42,
          title: 'Finding with markdown **bold** and `code` symbols: <div class="test">',
        },
      ];

      for (const tc of testCases) {
        const findingId = computeFindingId(tc.repo, tc.file, tc.line, tc.title);
        expect(findingId).toMatch(/^[0-9a-f]{64}$/);

        // Compute expected via node crypto using the exact normalization rules
        const cleanRepo = (tc.repo || '').trim();
        const cleanFile = (tc.file || '').trim().replace(/^\.?\//, '');
        const cleanLine = Math.max(1, typeof tc.line === 'number' && !isNaN(tc.line) ? Math.floor(tc.line) : 1);
        const cleanTitle = (tc.title || '').trim();
        const expectedFormula = `${cleanRepo}:${cleanFile}:${cleanLine}:${cleanTitle}`;
        const expectedHash = nodeSha256(expectedFormula);

        expect(findingId).toBe(expectedHash);
      }
    });

    it('HASH_07 — computeFindingId Invariance across path formats (./file vs /file vs file)', () => {
      const id1 = computeFindingId('owner/repo', 'src/file.ts', 10, 'Issue title');
      const id2 = computeFindingId('owner/repo', './src/file.ts', 10, 'Issue title');
      const id3 = computeFindingId('owner/repo', '/src/file.ts', 10, 'Issue title');
      const id4 = computeFindingId(' owner/repo ', '  ./src/file.ts  ', 10, '  Issue title  ');

      expect(id1).toBe(id2);
      expect(id1).toBe(id3);
      expect(id1).toBe(id4);
    });

    it('HASH_08 — computeFindingId Line number edge cases (NaN, 0, negative, float, Infinity)', () => {
      const idZero = computeFindingId('owner/repo', 'file.ts', 0, 'Title');
      const idOne = computeFindingId('owner/repo', 'file.ts', 1, 'Title');
      const idNeg = computeFindingId('owner/repo', 'file.ts', -50, 'Title');
      expect(idZero).toBe(idOne);
      expect(idNeg).toBe(idOne);

      const idFloat = computeFindingId('owner/repo', 'file.ts', 42.9, 'Title');
      const idFloor = computeFindingId('owner/repo', 'file.ts', 42, 'Title');
      expect(idFloat).toBe(idFloor);

      const idNaN = computeFindingId('owner/repo', 'file.ts', NaN, 'Title');
      expect(idNaN).toBe(idOne);
    });
  });

  // =========================================================================
  // Section 2: Concurrent State Gate Sync & Monotonic desired_version Ordering
  // =========================================================================
  describe('2. Concurrent State Gate Sync & Monotonic desired_version Ordering', () => {
    it('CONC_01 — Rapid concurrent overrides via HTTP REST API maintain monotonic desired_version', async () => {
      const reviewId = `rev-conc-http-${Date.now()}`;
      dashboardStore.setGateAttempt(reviewId, {
        reviewId,
        runId: reviewId,
        verdict: 'SHIP',
        desired_state: 'success',
        desired_version: 1,
        published_version: 1,
        updated_at: new Date().toISOString(),
      });

      const concurrentCount = 15;
      const promises = [];

      for (let i = 0; i < concurrentCount; i++) {
        const verdict = i % 2 === 0 ? 'BLOCK' : 'SHIP';
        promises.push(
          request(app)
            .post(`/api/reviews/${reviewId}/override`)
            .set('Authorization', `Bearer ${reviewerToken}`)
            .send({
              overrideVerdict: verdict,
              reason: `Concurrent override execution step ${i + 1} with enough length`,
              overriddenBy: `worker-thread-${i}`,
            })
        );
      }

      const responses = await Promise.all(promises);

      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(typeof res.body.gateVersion).toBe('number');
      }

      const gate = dashboardStore.getGateAttempt(reviewId);
      expect(gate).toBeDefined();
      expect(gate?.desired_version).toBe(1 + concurrentCount);

      const trail = dashboardStore.getAuditTrail(reviewId);
      const overrideEvents = trail.filter((e) => e.action === 'verdict_overridden');
      expect(overrideEvents.length).toBe(concurrentCount);

      const recordedVersions = overrideEvents.map((e) => (e.newState as any).desired_version);
      expect(recordedVersions.length).toBe(concurrentCount);
      expect(Math.min(...recordedVersions)).toBe(2);
      expect(Math.max(...recordedVersions)).toBe(16);
      expect(new Set(recordedVersions).size).toBe(concurrentCount);
    });

    it('CONC_02 — High-stress burst: 50 concurrent direct store overrides strictly increment desired_version without collision', async () => {
      const reviewId = `rev-conc-store-50-${Date.now()}`;
      const count = 50;

      const overrideTasks = Array.from({ length: count }, (_, i) => {
        return new Promise<{ gateVersion: number; overrideVerdict: string }>((resolve) => {
          setTimeout(() => {
            const verdict = i % 2 === 0 ? 'SHIP' : 'BLOCK';
            const res = dashboardStore.overrideVerdict(
              reviewId,
              verdict,
              `Direct store concurrent override burst iteration ${i + 1}`,
              `burst-actor-${i}`
            );
            resolve({ gateVersion: res.gateVersion as number, overrideVerdict: res.overrideVerdict });
          }, Math.floor(Math.random() * 20));
        });
      });

      const results = await Promise.all(overrideTasks);
      expect(results.length).toBe(count);

      const gate = dashboardStore.getGateAttempt(reviewId);
      expect(gate).toBeDefined();
      expect(gate?.desired_version).toBe(count + 1);

      const versions = results.map((r) => r.gateVersion);
      expect(new Set(versions).size).toBe(count);
      expect(Math.min(...versions)).toBe(2);
      expect(Math.max(...versions)).toBe(count + 1);
    });

    it('CONC_03 — Multi-tenant concurrency: Overrides on 5 reviews concurrently do not interfere with each other', async () => {
      const reviewIds = Array.from({ length: 5 }, (_, idx) => `rev-tenant-${idx}-${Date.now()}`);
      const overridesPerReview = 10;

      const tasks = [];
      for (const rId of reviewIds) {
        for (let i = 0; i < overridesPerReview; i++) {
          tasks.push(
            new Promise<void>((resolve) => {
              setTimeout(() => {
                dashboardStore.overrideVerdict(
                  rId,
                  i % 2 === 0 ? 'SHIP' : 'BLOCK',
                  `Tenant override step ${i}`,
                  `tenant-actor-${i}`
                );
                resolve();
              }, Math.floor(Math.random() * 15));
            })
          );
        }
      }

      await Promise.all(tasks);

      for (const rId of reviewIds) {
        const gate = dashboardStore.getGateAttempt(rId);
        expect(gate).toBeDefined();
        expect(gate?.desired_version).toBe(1 + overridesPerReview);

        const trail = dashboardStore.getAuditTrail(rId);
        expect(trail.length).toBe(overridesPerReview);
      }
    });
  });

  // =========================================================================
  // Section 3: Check Run Title & Summary Updates and Publisher Synchronization
  // =========================================================================
  describe('3. Check Run Title and Summary Synchronization with Gate Publisher', () => {
    function makeStoredGate(overrides: Partial<StoredReviewGate> = {}): StoredReviewGate {
      const coordinates = {
        owner: 'calltelemetry',
        repo: 'review-yeti-core',
        repositoryId: 201,
        prNumber: 99,
        runId: `run_${'e'.repeat(32)}`,
        executionAttempt: 1,
        attemptId: 'attempt-m3-gate-sync-01',
        headSha: 'c'.repeat(40),
        baseSha: 'd'.repeat(40),
        policyDigest: 'f'.repeat(64),
      };
      return {
        coordinates,
        reviewGeneration: 0,
        expectedAppId: 4385771,
        externalId: deriveReviewGateExternalId(coordinates),
        checkId: 5566,
        creationState: 'bound',
        desiredState: 'success',
        desiredVersion: 3,
        publishedVersion: 2,
        current: true,
        ...overrides,
      };
    }

    it('SYNC_01 — Manual SHIP override generates exact title and includes actor and detailed justification', () => {
      const gate = makeStoredGate({
        desiredState: 'success',
        decisionReason: 'manual-override-ship',
        decisionDetail: JSON.stringify({
          overriddenBy: 'lead-devops-carol',
          reason: 'Production incident resolution PR approved outside regular window',
        }),
      });

      const meta = gateTerminalMetadata(gate);
      expect(meta.title).toBe('Review Yeti Gate: Approved (Manual Override - SHIP)');
      expect(meta.summary).toContain('Manual SHIP override authorized by lead-devops-carol.');
      expect(meta.summary).toContain('Production incident resolution PR approved outside regular window');
    });

    it('SYNC_02 — Manual BLOCK override generates exact title and includes actor and detailed justification', () => {
      const gate = makeStoredGate({
        desiredState: 'failure',
        decisionReason: 'manual-override-block',
        decisionDetail: JSON.stringify({
          overriddenBy: 'sec-auditor-dan',
          reason: 'Hardcoded credentials found in migration script',
        }),
      });

      const meta = gateTerminalMetadata(gate);
      expect(meta.title).toBe('Review Yeti Gate: Blocked (Manual Override - BLOCK)');
      expect(meta.summary).toContain('Manual BLOCK override enforced by sec-auditor-dan.');
      expect(meta.summary).toContain('Hardcoded credentials found in migration script');
    });

    it('SYNC_03 — ReviewGatePublisher updates GitHub Check run with matching title and summary on manual override', async () => {
      const gate = makeStoredGate({
        desiredState: 'success',
        decisionReason: 'manual-override-ship',
        decisionDetail: JSON.stringify({
          overriddenBy: 'release-manager',
          reason: 'Hotfix cherry-picked directly to release train',
        }),
      });

      const claim: GatePublicationClaim = {
        ...gate,
        leaseOwner: 'worker-challenger-2',
        leaseToken: 'lease-challenger-2-token',
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
          id: 5566,
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
        workerId: 'worker-challenger-2',
      });

      const res = await publisher.runOnce();
      expect(res.status).toBe('published');
      expect(client.updateExisting).toHaveBeenCalledOnce();

      const payload = client.updateExisting.mock.calls[0][0];
      expect(payload.checkId).toBe(5566);
      expect(payload.update.conclusion).toBe('success');
      expect(payload.update.title).toBe('Review Yeti Gate: Approved (Manual Override - SHIP)');
      expect(payload.update.summary).toContain('release-manager');
      expect(payload.update.summary).toContain('Hotfix cherry-picked directly to release train');
    });
  });

  // =========================================================================
  // Section 4: Audit Trail Ordering and Chronological Integrity
  // =========================================================================
  describe('4. Audit Trail Ordering and Chronological Integrity', () => {
    it('AUDIT_01 — Interleaved actions (dismissal, severity, guidance, override) are ordered chronologically', () => {
      const reviewId = `rev-audit-interleave-${Date.now()}`;
      const findingId = computeFindingId('owner/repo', 'src/core.ts', 10, 'Core Bug');

      dashboardStore.setFinding(reviewId, {
        id: findingId,
        severity: 'P1',
        file: 'src/core.ts',
        line: 10,
        title: 'Core Bug',
        description: 'Bug description',
        status: 'active',
      });

      dashboardStore.addPromptGuidance(reviewId, 'Focus on thread safety', 'architect');
      dashboardStore.updateFindingSeverity(reviewId, findingId, 'P0', 'lead');
      dashboardStore.overrideVerdict(reviewId, 'BLOCK', 'Blocking until P0 resolved', 'lead');
      dashboardStore.dismissFinding(reviewId, findingId, 'Found to be non-exploitable', 'sec-eng');
      dashboardStore.overrideVerdict(reviewId, 'SHIP', 'Unblocking after dismissal', 'lead');

      const trail = dashboardStore.getAuditTrail(reviewId);
      expect(trail.length).toBe(5);

      const actions = trail.map((e) => e.action);
      expect(actions).toEqual([
        'guidance_added',
        'severity_changed',
        'verdict_overridden',
        'finding_dismissed',
        'verdict_overridden',
      ]);

      for (let i = 1; i < trail.length; i++) {
        const tPrev = new Date(trail[i - 1].timestamp).getTime();
        const tCurr = new Date(trail[i].timestamp).getTime();
        expect(tCurr).toBeGreaterThanOrEqual(tPrev);
      }
    });

    it('AUDIT_02 — Audit trail events have immutable diff snapshots', () => {
      const reviewId = `rev-audit-diff-${Date.now()}`;

      dashboardStore.overrideVerdict(reviewId, 'BLOCK', 'First override BLOCK', 'alice');
      dashboardStore.overrideVerdict(reviewId, 'SHIP', 'Second override SHIP', 'bob');

      const trail = dashboardStore.getAuditTrail(reviewId);
      expect(trail.length).toBe(2);

      expect(trail[0].actor).toBe('alice');
      expect(trail[0].previousState).toEqual({ verdict: 'NEUTRAL' });
      expect(trail[0].newState).toEqual({
        verdict: 'BLOCK',
        overrideVerdict: 'BLOCK',
        desired_version: 2,
      });

      expect(trail[1].actor).toBe('bob');
      expect(trail[1].previousState).toEqual({ verdict: 'BLOCK' });
      expect(trail[1].newState).toEqual({
        verdict: 'SHIP',
        overrideVerdict: 'SHIP',
        desired_version: 3,
      });
    });
  });
});
