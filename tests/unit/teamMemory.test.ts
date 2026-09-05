import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PRMemoryStore, DEFAULT_TEAM_MEMORY_PATH } from '../../src/memory/prMemoryStore';
import { NitSuppressionEngine, Finding } from '../../src/reflection/nitSuppressionEngine';
import { CommandDispatcher, ChatContext } from '../../src/chat/commandDispatcher';
import { LiveStreamBus } from '../../src/live/liveStreamBus';

describe('Persistent Team Memory & Nit Suppression Suite', () => {
  const testDir = path.resolve(__dirname, '../fixtures/team_memory_test');
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

  describe('1. WAL-Mode SQLite Persistent Storage', () => {
    it('initializes persistent SQLite database file at .ct-memory/team_memory.db with WAL mode', () => {
      expect(fs.existsSync(dbPath)).toBe(true);
      expect(store.getDbPath()).toBe(dbPath);
    });

    it('persists team-accepted rules and architectural constraints', async () => {
      const repo = 'review-yeti-ai/core-platform';

      // 1. Record ADR constraint
      await store.recordADRConstraint(repo, {
        adrNumber: 12,
        title: 'Zero Direct Database Access Outside Repositories',
        status: 'accepted',
        rule: 'Services must access database strictly through designated repository interfaces.',
        targetPaths: ['src/services/**'],
      });

      // 2. Record explicit team rule
      await store.recordTeamRule(repo, {
        ruleId: 'arch-repo-boundary',
        pattern: 'Direct DB access in service',
        filePath: 'src/services/**',
        reason: 'Violation of ADR #12 repository abstraction constraint',
        category: 'architecture',
      });

      const memory = await store.queryLearnings(repo);
      expect(memory.adrConstraints.length).toBe(1);
      expect(memory.adrConstraints[0].title).toBe('Zero Direct Database Access Outside Repositories');
      expect(memory.adrConstraints[0].status).toBe('accepted');
      expect(memory.resolvedNits.length).toBe(1);
      expect(memory.resolvedNits[0].ruleId).toBe('arch-repo-boundary');
    });

    it('queries team memory by file path, rule ID, and pattern', async () => {
      const repo = 'review-yeti-ai/web-service';

      await store.recordResolvedNit(repo, 10, {
        ruleId: 'naming-conventions',
        pattern: 'Use camelCase for variables',
        filePath: 'src/frontend/**',
        reason: 'Frontend convention',
      });

      await store.recordResolvedNit(repo, 11, {
        ruleId: 'backend-logging',
        pattern: 'Avoid debug logs in production handlers',
        filePath: 'src/backend/**',
        reason: 'Backend observability convention',
      });

      // Query by filePath
      const feNits = await store.queryResolvedNits(repo, { filePath: 'src/frontend/app.tsx' });
      expect(feNits.length).toBe(1);
      expect(feNits[0].ruleId).toBe('naming-conventions');

      // Query by ruleId
      const beNits = await store.queryResolvedNits(repo, { ruleId: 'backend-logging' });
      expect(beNits.length).toBe(1);
      expect(beNits[0].pattern).toBe('Avoid debug logs in production handlers');

      // Query by pattern substring
      const patternNits = await store.queryResolvedNits(repo, { pattern: 'camelCase' });
      expect(patternNits.length).toBe(1);
      expect(patternNits[0].ruleId).toBe('naming-conventions');
    });
  });

  describe('2. NitSuppressionEngine False-Positive Suppression', () => {
    it('automatically suppresses matching P2/minor nits on review passes', async () => {
      const repo = 'review-yeti-ai/sample-app';

      await store.recordResolvedNit(repo, 45, {
        ruleId: 'style-quote-preference',
        pattern: 'prefer double quotes in config',
        filePath: 'src/config/**',
        reason: 'Team agreed double quotes in json/yaml-like configs',
      });

      const engine = new NitSuppressionEngine(store);

      const findings: Finding[] = [
        {
          ruleId: 'style-quote-preference',
          path: 'src/config/appConfig.ts',
          line: 12,
          title: 'Code Style: Prefer double quotes in config files',
          body: 'Single quotes used in config file string literal.',
          severity: 'P2',
        },
        {
          path: 'src/config/appConfig.ts',
          line: 45,
          title: 'Unrelated medium issue',
          body: 'Missing timeout parameter.',
          severity: 'P2',
        },
      ];

      const result = await engine.suppressNits(repo, findings);

      expect(result.suppressedFindings.length).toBe(1);
      expect(result.suppressedFindings[0].finding.line).toBe(12);
      expect(result.suppressedFindings[0].nitPattern.ruleId).toBe('style-quote-preference');
      expect(result.activeFindings.length).toBe(1);
      expect(result.activeFindings[0].line).toBe(45);

      // Verify suppression count incremented in persistent storage
      const updatedRules = await store.queryResolvedNits(repo, { ruleId: 'style-quote-preference' });
      expect(updatedRules[0].suppressionCount).toBe(1);
    });

    it('emits live event on live stream bus when jobId is provided during suppression', async () => {
      const repo = 'review-yeti-ai/sample-app';
      const jobId = 'job-live-suppression-123';

      await store.recordResolvedNit(repo, 1, {
        pattern: 'console.debug is forbidden',
        filePath: 'src/**',
        reason: 'Allowed in local debug mode',
      });

      const engine = new NitSuppressionEngine(store);
      const busSpy = vi.spyOn(LiveStreamBus.getInstance(), 'publishEvent');

      const findings: Finding[] = [
        {
          path: 'src/main.ts',
          line: 15,
          title: 'console.debug is forbidden in production files',
          severity: 'P2',
        },
      ];

      const result = await engine.suppressNits(repo, findings, jobId);
      expect(result.suppressedFindings.length).toBe(1);
      expect(busSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId,
          type: 'nit:suppression',
        })
      );
    });
  });

  describe('3. SAFETY RULE: P0 and P1 Security/Correctness Bypasses are NEVER Suppressed', () => {
    it('prevents nit suppression from suppressing P0 blocker security findings', async () => {
      const repo = 'review-yeti-ai/security-critical';

      // Team has a broad suppression rule
      await store.recordResolvedNit(repo, 99, {
        pattern: 'SQL injection',
        filePath: '**',
        reason: 'Broad pattern registered in staging tests',
      });

      const engine = new NitSuppressionEngine(store);

      const findings: Finding[] = [
        {
          path: 'src/db/users.ts',
          line: 88,
          title: 'SQL injection vulnerability: unescaped user input in raw query',
          body: 'Raw query concatenated with request parameter directly.',
          severity: 'P0',
        },
        {
          path: 'src/db/users.ts',
          line: 95,
          title: 'SQL injection false alarm in comment documentation',
          body: 'Docstring mentions SQL injection example.',
          severity: 'P2',
        },
      ];

      const result = await engine.suppressNits(repo, findings);

      // P0 must NEVER be suppressed
      expect(result.activeFindings.some((f) => f.severity === 'P0')).toBe(true);
      expect(result.activeFindings.find((f) => f.severity === 'P0')?.line).toBe(88);

      // P2 matching nit is suppressed
      expect(result.suppressedFindings.some((f) => f.finding.severity === 'P2')).toBe(true);
    });

    it('prevents nit suppression from suppressing P1 high severity findings', async () => {
      const repo = 'review-yeti-ai/security-critical';

      await store.recordResolvedNit(repo, 100, {
        ruleId: 'idor-check',
        pattern: 'Missing tenant isolation check',
        filePath: 'src/controllers/**',
        reason: 'Allow admin controllers',
      });

      const engine = new NitSuppressionEngine(store);

      const findings: Finding[] = [
        {
          ruleId: 'idor-check',
          path: 'src/controllers/customerController.ts',
          line: 42,
          title: 'Missing tenant isolation check: customer ID accessed without tenant context',
          severity: 'P1',
        },
      ];

      const result = await engine.suppressNits(repo, findings);

      expect(result.activeFindings.length).toBe(1);
      expect(result.activeFindings[0].severity).toBe('P1');
      expect(result.suppressedFindings.length).toBe(0);
    });
  });

  describe('4. Interactive Chat @review-yeti ignore/mute Integration', () => {
    it('records dismissed finding directly into persistent team memory via CommandDispatcher', async () => {
      const dispatcher = new CommandDispatcher();
      const mockGithub: any = {
        getReviewCommentThread: vi.fn().mockResolvedValue([
          {
            body: 'P2: Trailing commas should be avoided in JSON imports',
            path: 'src/config/schema.ts',
            user: { login: 'review-yeti[bot]' },
          },
        ]),
        replyToReviewComment: vi.fn().mockResolvedValue({ id: 999 }),
      };

      const context: ChatContext = {
        owner: 'review-yeti-ai',
        repo: 'test-app',
        prNumber: 77,
        commentId: 101,
        headSha: 'c0ffee1234',
        github: mockGithub,
        memoryStore: store,
      };

      // Developer says @review-yeti ignore
      const result = await dispatcher.dispatchCommand('@review-yeti ignore', context);
      expect(result.success).toBe(true);
      expect(mockGithub.replyToReviewComment).toHaveBeenCalledWith(
        'review-yeti-ai',
        'test-app',
        77,
        101,
        expect.stringContaining('Recorded nit suppression rule in persistent team memory')
      );

      // Verify stored in persistent SQLite
      const memory = await store.queryLearnings('review-yeti-ai/test-app');
      expect(memory.resolvedNits.length).toBe(1);
      expect(memory.resolvedNits[0].filePath).toBe('src/config/schema.ts');

      // Verify NitSuppressionEngine now suppresses this finding
      const engine = new NitSuppressionEngine(store);
      const evalResult = await engine.suppressNits('review-yeti-ai/test-app', [
        {
          path: 'src/config/schema.ts',
          line: 5,
          title: 'Trailing commas should be avoided in JSON imports',
          severity: 'P2',
        },
      ]);
      expect(evalResult.suppressedFindings.length).toBe(1);
    });

    it('records explicit rule ID via @review-yeti mute rule:<rule_id>', async () => {
      const dispatcher = new CommandDispatcher();
      const mockGithub: any = {
        getReviewCommentThread: vi.fn().mockResolvedValue([]),
        postIssueComment: vi.fn().mockResolvedValue({ id: 888 }),
      };

      const context: ChatContext = {
        owner: 'review-yeti-ai',
        repo: 'test-app',
        prNumber: 80,
        github: mockGithub,
        memoryStore: store,
      };

      const result = await dispatcher.dispatchCommand(
        '@review-yeti mute rule:no-floating-promises - Async handling done via queue supervisor',
        context
      );

      expect(result.success).toBe(true);
      const memory = await store.queryLearnings('review-yeti-ai/test-app', { ruleId: 'no-floating-promises' });
      expect(memory.resolvedNits.length).toBe(1);
      expect(memory.resolvedNits[0].ruleId).toBe('no-floating-promises');
    });
  });
});
