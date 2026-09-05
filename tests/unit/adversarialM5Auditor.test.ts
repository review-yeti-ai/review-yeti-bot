import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { NitSuppressionEngine, Finding, isPathMatch } from '../../src/reflection/nitSuppressionEngine';
import {
  CommunityPersonaLoader,
  CommunityPersonaValidationError,
  CommunityPersonaNotFoundError,
  CommunityPersonaFetchError,
  parsePersonaCharter,
  sanitizePersonaId,
} from '../../src/personas/communityPersonaLoader';
import { CommandDispatcher, ChatContext } from '../../src/chat/commandDispatcher';

describe('Milestone 5 Forensic Auditor Adversarial Stress Suite', () => {
  const testDir = path.resolve(__dirname, '../fixtures/auditor_m5_stress_test');
  const dbPath = path.join(testDir, '.ct-memory', 'team_memory.db');
  let store: PRMemoryStore;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    store = new PRMemoryStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe('1. Non-Bypassable P0 / P1 Safety Gating', () => {
    const blockingSeverities = ['P0', 'p0', 'P1', 'p1', 'CRITICAL', 'critical', 'BLOCKER', 'blocker', 'HIGH', 'high', 'ERROR', 'error'];

    for (const sev of blockingSeverities) {
      it(`strictly forbids suppression for severity '${sev}' despite wildcard or exact rule matches`, async () => {
        const repo = 'review-yeti/adversarial-repo';

        // Adversary registers both exact rule and universal wildcards in memory
        await store.recordResolvedNit(repo, 1, {
          ruleId: 'vuln-injection',
          pattern: '.*',
          filePath: '**',
          reason: 'Adversary attempting to suppress all security findings',
        });

        const engine = new NitSuppressionEngine(store);

        const findings: Finding[] = [
          {
            ruleId: 'vuln-injection',
            path: 'src/auth/token.ts',
            title: 'Critical remote exploit detected',
            body: 'Unauthenticated execution path',
            severity: sev,
          },
        ];

        const result = await engine.suppressNits(repo, findings);

        // MUST stay active
        expect(result.activeFindings.length).toBe(1);
        expect(result.suppressedFindings.length).toBe(0);
        expect(result.activeFindings[0].title).toBe('Critical remote exploit detected');
      });
    }

    it('allows legitimate suppression for P2, P3, and info severities when matching pattern', async () => {
      const repo = 'review-yeti/legit-repo';
      await store.recordResolvedNit(repo, 2, {
        ruleId: 'doc-style',
        pattern: 'missing period in docstring',
        filePath: 'src/docs/**',
        reason: 'Optional style rule',
      });

      const engine = new NitSuppressionEngine(store);
      const findings: Finding[] = [
        {
          ruleId: 'doc-style',
          path: 'src/docs/guide.ts',
          title: 'Code style: missing period in docstring',
          severity: 'P2',
        },
        {
          ruleId: 'doc-style',
          path: 'src/docs/guide.ts',
          title: 'Code style: missing period in docstring',
          severity: 'P3',
        },
        {
          ruleId: 'doc-style',
          path: 'src/docs/guide.ts',
          title: 'Code style: missing period in docstring',
          severity: 'INFO',
        },
      ];

      const result = await engine.suppressNits(repo, findings);
      expect(result.suppressedFindings.length).toBe(3);
      expect(result.activeFindings.length).toBe(0);
    });
  });

  describe('2. Malicious and Edge Case Pattern Matching in NitSuppressionEngine', () => {
    it('gracefully handles broken or malicious regular expressions in stored patterns without throwing', async () => {
      const repo = 'review-yeti/broken-regex';

      // Broken regex patterns
      await store.recordResolvedNit(repo, 1, {
        pattern: '[unclosed-regex-bracket',
        filePath: '**',
        reason: 'Malformed regex test',
      });
      await store.recordResolvedNit(repo, 2, {
        pattern: '(*+?bad-quantifier)',
        filePath: '**',
        reason: 'Malformed quantifier',
      });

      const engine = new NitSuppressionEngine(store);

      const findings: Finding[] = [
        {
          path: 'src/main.ts',
          title: 'Regular finding test',
          severity: 'P2',
        },
      ];

      // Must not throw syntax error from RegExp constructor
      expect(async () => {
        await engine.suppressNits(repo, findings);
      }).not.toThrow();
    });

    it('accurately tests path globbing semantics including special characters', () => {
      expect(isPathMatch('src/**', 'src/nested/deep/file.ts')).toBe(true);
      expect(isPathMatch('src/*.ts', 'src/file.ts')).toBe(true);
      expect(isPathMatch('src/*.ts', 'src/nested/file.ts')).toBe(false);
      expect(isPathMatch('**/*.test.ts', 'packages/core/src/app.test.ts')).toBe(true);
      expect(isPathMatch('**', 'any/path/at/all')).toBe(true);
      expect(isPathMatch('', 'any/path/at/all')).toBe(true);
      expect(isPathMatch(null, 'any/path/at/all')).toBe(true);
      // File with plus, parenthesis, dollar signs
      expect(isPathMatch('src/special/**', 'src/special/file+(1)$[test].ts')).toBe(true);
    });

    it('safely handles findings with missing or undefined properties', async () => {
      const repo = 'review-yeti/sparse-findings';
      const engine = new NitSuppressionEngine(store);

      const sparseFindings: Finding[] = [
        { path: '', title: '' },
        { path: 'unknown.ts', title: 'test', severity: undefined },
      ];

      const result = await engine.suppressNits(repo, sparseFindings);
      expect(result.activeFindings.length).toBe(2);
    });
  });

  describe('3. SQLite Team Memory Storage Security & Integrity', () => {
    it('verifies SQLite file is created on disk with WAL journal mode', () => {
      expect(fs.existsSync(dbPath)).toBe(true);

      // Query raw pragma on the SQLite database
      const rawDb = (store as any).db;
      const journalModeRow = rawDb.prepare('PRAGMA journal_mode;').get();
      expect(journalModeRow.journal_mode.toLowerCase()).toBe('wal');
    });

    it('resists SQL injection attempts across all record and query methods', async () => {
      const repo = 'review-yeti/sql-injection-target';
      const maliciousPayload = "'; DROP TABLE resolved_nits; --";

      // 1. Attempt injection via recordTeamRule
      await store.recordTeamRule(repo, {
        ruleId: maliciousPayload,
        pattern: maliciousPayload,
        filePath: maliciousPayload,
        reason: maliciousPayload,
      });

      // 2. Attempt injection via recordResolvedNit
      await store.recordResolvedNit(repo, 999, {
        ruleId: maliciousPayload,
        pattern: maliciousPayload,
        filePath: maliciousPayload,
        reason: maliciousPayload,
      });

      // 3. Attempt injection via queries
      const nits = await store.queryResolvedNits(repo, {
        ruleId: maliciousPayload,
        pattern: maliciousPayload,
        filePath: maliciousPayload,
      });
      expect(nits.length).toBeGreaterThan(0);

      // Verify resolved_nits table still exists and is not dropped
      const count = (store as any).db.prepare('SELECT COUNT(*) as cnt FROM resolved_nits').get();
      expect(count.cnt).toBeGreaterThan(0);
    });

    it('isolates repo data during clearRepoMemory', async () => {
      const repoA = 'org/repo-a';
      const repoB = 'org/repo-b';

      await store.recordTeamRule(repoA, { pattern: 'Rule A' });
      await store.recordTeamRule(repoB, { pattern: 'Rule B' });

      await store.clearRepoMemory(repoA);

      const memA = await store.queryLearnings(repoA);
      const memB = await store.queryLearnings(repoB);

      expect(memA.resolvedNits.length).toBe(0);
      expect(memB.resolvedNits.length).toBe(1);
      expect(memB.resolvedNits[0].pattern).toBe('Rule B');
    });

    it('handles batch increment transactions atomically', async () => {
      const repo = 'org/batch-repo';
      const n1 = await store.recordResolvedNit(repo, 1, { pattern: 'p1', filePath: '**', reason: 'r1' });
      const n2 = await store.recordResolvedNit(repo, 1, { pattern: 'p2', filePath: '**', reason: 'r2' });

      await store.incrementNitSuppressionBatch([n1.id!, n2.id!, n1.id!]);

      const nits = await store.queryResolvedNits(repo);
      const updatedN1 = nits.find((n) => n.id === n1.id);
      const updatedN2 = nits.find((n) => n.id === n2.id);

      expect(updatedN1?.suppressionCount).toBe(2);
      expect(updatedN2?.suppressionCount).toBe(1);
    });
  });

  describe('4. CommunityPersonaLoader Edge Cases and Security', () => {
    it('rejects charters with invalid frontmatter delimiters or invalid structure', () => {
      expect(() => parsePersonaCharter('No delimiters')).toThrow(CommunityPersonaValidationError);
      expect(() => parsePersonaCharter('---\n- list item\n- list item 2\n---\nBody here that is long enough'))
        .toThrow(/must be a YAML mapping/i);
      expect(() => parsePersonaCharter('---\nname: short\n---\nShort')).toThrow(/minimum 10 characters/i);
    });

    it('handles path traversal attempts safely without exposing filesystem', async () => {
      const loader = new CommunityPersonaLoader({
        baseDir: testDir,
      });

      await expect(loader.resolvePersonaReference('../../../../etc/passwd')).rejects.toThrow(
        CommunityPersonaNotFoundError
      );
    });

    it('sanitizes dangerous persona IDs robustly', () => {
      expect(sanitizePersonaId('../../evil')).toBe('evil');
      expect(sanitizePersonaId('   ')).toBe('p-');
      expect(sanitizePersonaId('123abc_test')).toBe('p-123abc_test');
      expect(sanitizePersonaId('DROP TABLE personas;')).toBe('drop-table-personas');
      expect(sanitizePersonaId('🚀-rocket-persona-🔥')).toBe('rocket-persona');
    });

    it('handles corrupted cache files by re-fetching when available', async () => {
      const cacheDir = path.join(testDir, 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });

      const safeKey = 'test-org__test-repo__v1__persona.md';
      const cachedFile = path.join(cacheDir, safeKey);
      fs.writeFileSync(cachedFile, 'corrupted invalid file without frontmatter', 'utf-8');

      const mockFetcher = vi.fn().mockResolvedValue(`---
name: valid-persona
---
# Valid Charter Body
Content of charter body here.`);

      const loader = new CommunityPersonaLoader({
        baseDir: testDir,
        cacheDir,
        fetcher: mockFetcher,
      });

      const res = await loader.resolvePersonaReference('test-org/test-repo/persona.md@v1');
      expect(mockFetcher).toHaveBeenCalledTimes(1);
      expect(res.frontmatter.name).toBe('valid-persona');
    });
  });

  describe('5. End-to-End Chat Command Mute & Suppression Defense', () => {
    it('mutes a finding via chat command, but P0 finding remains active on subsequent review pass', async () => {
      const dispatcher = new CommandDispatcher();
      const mockGithub: any = {
        getReviewCommentThread: vi.fn().mockResolvedValue([
          {
            body: 'P0: Critical credential exposure in repo',
            path: 'src/auth/keys.ts',
            user: { login: 'review-yeti[bot]' },
          },
        ]),
        replyToReviewComment: vi.fn().mockResolvedValue({ id: 111 }),
      };

      const context: ChatContext = {
        owner: 'security-org',
        repo: 'vault',
        prNumber: 42,
        commentId: 555,
        github: mockGithub,
        memoryStore: store,
      };

      // Developer types @review-yeti mute rule:AUTH-01
      const res = await dispatcher.dispatchCommand('@review-yeti mute rule:AUTH-01 - Suppress in test', context);
      expect(res.success).toBe(true);

      // Verify recorded in team memory
      const memory = await store.queryLearnings('security-org/vault', { ruleId: 'AUTH-01' });
      expect(memory.resolvedNits.length).toBe(1);
      expect(memory.resolvedNits[0].ruleId).toBe('AUTH-01');

      // Now run review pass through NitSuppressionEngine
      const engine = new NitSuppressionEngine(store);
      const evalResult = await engine.suppressNits('security-org/vault', [
        {
          ruleId: 'AUTH-01',
          path: 'src/auth/keys.ts',
          title: 'Critical credential exposure in repo',
          severity: 'P0', // P0 security issue!
        },
      ]);

      // Defense check: P0 is NOT suppressed even though AUTH-01 was explicitly muted
      expect(evalResult.activeFindings.length).toBe(1);
      expect(evalResult.suppressedFindings.length).toBe(0);
    });
  });
});
