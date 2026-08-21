import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ReflectionCommandParser,
  LearningStore,
  FeedbackListener,
  NitSuppressionEngine,
} from '../../src/reflection';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { PanelFinding } from '../../src/panel/panelEngine';

describe('Milestone 28: Reflection Engine', () => {
  let memoryStore: PRMemoryStore;
  let learningStore: LearningStore;
  let nitEngine: NitSuppressionEngine;

  beforeEach(() => {
    memoryStore = new PRMemoryStore(':memory:');
    learningStore = new LearningStore(memoryStore);
    nitEngine = new NitSuppressionEngine(memoryStore);
  });

  afterEach(() => {
    learningStore.close();
  });

  describe('ReflectionCommandParser', () => {
    const parser = new ReflectionCommandParser();

    it('should parse explicit categorized learning command', () => {
      const text = '@ct-review learn convention: Avoid raw console.log - Use winston logger everywhere';
      const result = parser.parse(text);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('learning');
      expect(result?.category).toBe('convention');
      expect(result?.title).toBe('Avoid raw console.log');
      expect(result?.description).toBe('Use winston logger everywhere');
    });

    it('should parse explicit nit suppression pattern', () => {
      const text = '@ct-review learn nit: unused import | Cleaned up in separate PR';
      const result = parser.parse(text, { filePath: 'src/utils/logger.ts' });
      expect(result).not.toBeNull();
      expect(result?.type).toBe('nit');
      expect(result?.category).toBe('nit');
      expect(result?.pattern).toBe('unused import');
      expect(result?.reason).toBe('Cleaned up in separate PR');
      expect(result?.filePath).toBe('src/utils/logger.ts');
    });

    it('should parse explicit ADR constraint', () => {
      const text = '@ct-review learn adr 42: Strict Tenant Isolation | Always filter DB queries by org_id | src/db/**/*';
      const result = parser.parse(text);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('adr');
      expect(result?.category).toBe('adr');
      expect(result?.adrNumber).toBe(42);
      expect(result?.title).toBe('Strict Tenant Isolation');
      expect(result?.description).toBe('Always filter DB queries by org_id');
      expect(result?.targetPaths).toEqual(['src/db/**/*']);
    });

    it('should fallback to generic learning for freeform text', () => {
      const text = '@ct-review learn Prefer async/await over raw Promises in express routes';
      const result = parser.parse(text);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('learning');
      expect(result?.category).toBe('convention');
      expect(result?.description).toContain('Prefer async/await');
    });

    it('should return null for non-learn command', () => {
      const result = parser.parse('@ct-review review');
      expect(result).toBeNull();
    });
  });

  describe('LearningStore & PRMemoryStore Integration', () => {
    it('should save and retrieve learned commands', async () => {
      const parser = new ReflectionCommandParser();
      const cmd = parser.parse('@ct-review learn security: Sanitize SQL Input - Use parameterized queries')!;

      await learningStore.saveCommandLearning('owner/repo', 10, cmd);

      const context = await learningStore.getLearnedContext('owner/repo');
      expect(context.learnings.length).toBe(1);
      expect(context.learnings[0].category).toBe('security');
      expect(context.learnings[0].title).toBe('Sanitize SQL Input');
    });

    it('should save resolved nit from feedback', async () => {
      await learningStore.recordFeedbackNit(
        'owner/repo',
        12,
        'Unnecessary semicolon',
        'src/index.ts',
        'User rejected nit'
      );

      const context = await learningStore.getLearnedContext('owner/repo');
      expect(context.resolvedNits.length).toBe(1);
      expect(context.resolvedNits[0].pattern).toBe('Unnecessary semicolon');
      expect(context.resolvedNits[0].reason).toContain('User rejected nit');
    });
  });

  describe('FeedbackListener', () => {
    it('should process negative reaction feedback into nit suppression', async () => {
      const listener = new FeedbackListener(learningStore);
      await listener.handleReaction({
        owner: 'owner',
        repo: 'repo',
        prNumber: 5,
        commentId: 101,
        reaction: 'thumbsdown',
        sender: 'alice',
      });

      const context = await learningStore.getLearnedContext('owner/repo');
      expect(context.resolvedNits.length).toBe(1);
    });

    it('should extract title from comment body when handling negative reactions', async () => {
      const listener = new FeedbackListener(learningStore);
      await listener.handleReaction({
        owner: 'owner',
        repo: 'repo',
        prNumber: 5,
        commentId: 105,
        reaction: '-1',
        comment: { body: '### Unnecessary console.log nit\nDetails here...' },
      });

      const context = await learningStore.getLearnedContext('owner/repo');
      expect(context.resolvedNits.length).toBe(1);
      expect(context.resolvedNits[0].pattern).toBe('Unnecessary console.log nit');
    });

    it('should process reply refusal text into nit suppression', async () => {
      const listener = new FeedbackListener(learningStore);
      await listener.handleReply({
        owner: 'owner',
        repo: 'repo',
        prNumber: 5,
        commentId: 102,
        inReplyToId: 101,
        body: 'This is a false positive, please ignore',
        sender: 'bob',
      });

      const context = await learningStore.getLearnedContext('owner/repo');
      expect(context.resolvedNits.length).toBe(1);
      expect(context.resolvedNits[0].reason).toContain('false positive');
    });
  });

  describe('NitSuppressionEngine', () => {
    it('should filter matching findings with 100% precision and track suppression count', async () => {
      // Record nit pattern
      await memoryStore.recordResolvedNit('owner/repo', 1, {
        pattern: 'Console log statement',
        filePath: 'src/app.ts',
        reason: 'Debugging allowed in local dev',
      });

      const findings: PanelFinding[] = [
        {
          severity: 'P2',
          path: 'src/app.ts',
          line: 15,
          title: 'Console log statement found',
          body: 'Avoid console.log in production',
        },
        {
          severity: 'P0',
          path: 'src/app.ts',
          line: 45,
          title: 'SQL Injection Vulnerability',
          body: 'Unsanitized query execution',
        },
      ];

      const result = await nitEngine.suppressNits('owner/repo', findings);

      expect(result.activeFindings.length).toBe(1);
      expect(result.activeFindings[0].title).toBe('SQL Injection Vulnerability');

      expect(result.suppressedFindings.length).toBe(1);
      expect(result.suppressedFindings[0].finding.title).toBe('Console log statement found');

      // Verify suppression count incremented
      const context = await memoryStore.queryLearnings('owner/repo');
      expect(context.resolvedNits[0].suppressionCount).toBe(1);
    });

    it('should match short 1-3 letter tech terms in nit patterns', async () => {
      await memoryStore.recordResolvedNit('owner/repo', 2, {
        pattern: 'use sql log',
        filePath: '**',
        reason: 'Short tech term nit',
      });

      const findings: PanelFinding[] = [
        {
          severity: 'P2',
          path: 'src/db.ts',
          title: 'Ensure you use sql log for queries',
          body: 'Short term test',
        },
      ];

      const result = await nitEngine.suppressNits('owner/repo', findings);
      expect(result.suppressedFindings.length).toBe(1);
    });

    it('should include global nits (filePath = **) when querying learnings with specific filePath context', async () => {
      await memoryStore.recordResolvedNit('owner/repo', 3, {
        pattern: 'global nit pattern',
        filePath: '**',
        reason: 'Global rule',
      });

      const result = await memoryStore.queryLearnings('owner/repo', { filePath: 'src/specific/path.ts' });
      expect(result.resolvedNits.length).toBe(1);
      expect(result.resolvedNits[0].pattern).toBe('global nit pattern');
    });
  });
});
