import { describe, it, expect, vi } from 'vitest';
import {
  meetsMinimumSeverity,
  resolveDetectionModeSettings,
} from '../../src/config/schema';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import {
  parseMarkdownWithFrontMatter,
  parseIgnorePatterns,
  loadReviewYetiDirectoryFromFiles,
  applyReviewYetiDirectoryToConfig,
} from '../../src/config/reviewYetiDirLoader';
import { ConfigResolver } from '../../src/config/configResolver';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import {
  generateConcisePRSummary,
  upsertPRDescriptionSummary,
  PR_SUMMARY_START_MARKER,
  PR_SUMMARY_END_MARKER,
} from '../../src/review/summaryEngine';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { dedupeActionableFindings, buildFinalInlineComments } from '../../src/github/panelPublication';
import { parseCommand, CommandDispatcher } from '../../src/chat/commandDispatcher';
import { runLocalReview, runCli } from '../../src/cli/index';

describe('UX Simplification & High-Signal Enhancements', () => {
  describe('Detection Mode & Minimum Severity', () => {
    it('maps fast, balanced, and deep detection modes to strictness profiles and effort', () => {
      expect(resolveDetectionModeSettings('fast')).toMatchObject({
        mode: 'fast',
        profile: 'chill',
        reviewerEffort: 'low',
        maxInvestigationTurns: 5,
        personas: ['security', 'correctness'],
      });
      expect(resolveDetectionModeSettings('balanced')).toMatchObject({
        mode: 'balanced',
        profile: 'balanced',
        reviewerEffort: 'medium',
        maxInvestigationTurns: 10,
      });
      expect(resolveDetectionModeSettings('deep')).toMatchObject({
        mode: 'deep',
        profile: 'assertive',
        reviewerEffort: 'high',
        maxInvestigationTurns: 15,
      });
    });

    it('evaluates meetsMinimumSeverity across P0/P1/P2 and critical/high/medium/low', () => {
      expect(meetsMinimumSeverity('P0', 'critical')).toBe(true);
      expect(meetsMinimumSeverity('P1', 'critical')).toBe(false);
      expect(meetsMinimumSeverity('P1', 'high')).toBe(true);
      expect(meetsMinimumSeverity('P2', 'high')).toBe(false);
      expect(meetsMinimumSeverity('medium', 'medium')).toBe(true);
      expect(meetsMinimumSeverity('low', 'medium')).toBe(false);
      expect(meetsMinimumSeverity('low', 'low')).toBe(true);
    });

    it('parses mode and min_severity in schema and ConfigResolver', async () => {
      const cfg = parseAndValidateConfig(`
version: 3
mode: fast
min_severity: high
`);
      expect(cfg.mode).toBe('fast');
      expect(cfg.min_severity).toBe('high');

      const resolver = new ConfigResolver();
      const merged = await resolver.resolveConfig({
        owner: 'acme',
        repo: 'service',
        client: {
          async getFileContent(_owner, _repo, filePath) {
            if (filePath === '.reviewyeti.yml') {
              return `
version: 3
mode: deep
min_severity: medium
`;
            }
            return null;
          },
        },
      });
      expect(merged.mode).toBe('deep');
      expect(merged.reviews?.mode).toBe('deep');
      expect(merged.profile).toBe('assertive');
      expect(merged.reviews?.reviewer_effort).toBe('high');
      expect(merged.min_severity).toBe('medium');
    });

    it('resolves worker config with mode and correctness lane mapping', () => {
      const transport = {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-test',
        model: 'deepseek/deepseek-v4.1-flash',
      };
      const fastCfg = resolveWorkerConfig({ REVIEW_MODE: 'fast' } as any, transport);
      expect(fastCfg.profile).toBe('chill');
      expect(fastCfg.default_max_turns).toBe(5);
      expect(fastCfg.personas.map((p) => p.id)).toContain('correctness-lane');

      const deepCfg = resolveWorkerConfig(
        {
          REVIEW_YETI_POLICY_JSON: JSON.stringify({
            mode: 'deep',
            personas: ['correctness', 'security'],
          }),
        } as any,
        transport
      );
      expect(deepCfg.profile).toBe('assertive');
      expect(deepCfg.default_max_turns).toBe(15);
      expect(deepCfg.personas.map((p) => p.id)).toContain('correctness-lane');
    });

    it('filters inline findings by minSeverity in dedupeActionableFindings and buildFinalInlineComments', () => {
      const findings = [
        {
          persona: 'security',
          severity: 'P0' as const,
          confidence: 0.95,
          path: 'src/auth.ts',
          line: 12,
          title: 'SQL injection risk',
          body: 'Unparameterized query.',
        },
        {
          persona: 'quality',
          severity: 'P2' as const,
          confidence: 0.9,
          path: 'src/auth.ts',
          line: 30,
          title: 'Minor naming style',
          body: 'Prefer camelCase.',
        },
      ];

      const highOnly = dedupeActionableFindings(findings as any, { minSeverity: 'high' });
      expect(highOnly).toHaveLength(1);
      expect(highOnly[0].title).toBe('SQL injection risk');

      const comments = buildFinalInlineComments({
        findings: findings as any,
        changedFiles: [{ path: 'src/auth.ts', patch: '@@ -1,35 +1,35 @@\n' }],
        max: 5,
        minSeverity: 'high',
      });
      expect(comments).toHaveLength(1);
      expect(comments[0].line).toBe(12);
    });
  });

  describe('.reviewyeti/ Repository-Native Configuration Loader', () => {
    it('parses markdown YAML front-matter and body', () => {
      const parsed = parseMarkdownWithFrontMatter(`---
name: Enforce Tenant Guard
severity: high
include:
  - src/api/**
  - src/db/**
---
Every database query must scope by tenant_id.`);

      expect(parsed.attributes.name).toBe('Enforce Tenant Guard');
      expect(parsed.attributes.severity).toBe('high');
      expect(parsed.attributes.include).toEqual(['src/api/**', 'src/db/**']);
      expect(parsed.body).toBe('Every database query must scope by tenant_id.');
    });

    it('parses ignore patterns and expands ignoreTests: true front-matter', () => {
      const result = parseIgnorePatterns(`---
ignoreTests: true
---
# Ignore generated artifacts
dist/**
*.snap
`);
      expect(result.ignoreTests).toBe(true);
      expect(result.patterns).toContain('dist/**');
      expect(result.patterns).toContain('*.snap');
      expect(result.patterns).toContain('**/*.test.*');
      expect(result.patterns).toContain('**/*.spec.*');
    });

    it('loads .reviewyeti/ directory files and applies them to config', () => {
      const dirCfg = loadReviewYetiDirectoryFromFiles({
        '.reviewyeti/ignore': 'vendor/**\n*.generated.ts',
        '.reviewyeti/instructions.md': `---
mode: fast
min_severity: high
include:
  - src/payments/**
---
Ensure all payment mutations are idempotent.`,
        '.reviewyeti/checks/no-raw-sql.md': `---
id: no-raw-sql
name: No Raw SQL
severity: critical
include: src/db/**
action: block
---
Never use raw string concatenation in SQL queries.`,
      });

      expect(dirCfg.mode).toBe('fast');
      expect(dirCfg.minSeverity).toBe('high');
      expect(dirCfg.ignorePatterns).toEqual(['vendor/**', '*.generated.ts']);
      expect(dirCfg.scopedInstructions).toHaveLength(1);
      expect(dirCfg.scopedInstructions[0].path).toBe('src/payments/**');
      expect(dirCfg.checks).toHaveLength(1);
      expect(dirCfg.checks[0].id).toBe('no-raw-sql');
      expect(dirCfg.checks[0].severity).toBe('P0');

      const baseConfig = parseAndValidateConfig('version: 3\nmin_severity: low\n');
      const updated: any = applyReviewYetiDirectoryToConfig(baseConfig, dirCfg);
      expect(updated.mode).toBe('fast');
      expect(updated.min_severity).toBe('low');
      expect(updated.auto_review?.ignore_patterns).toContain('vendor/**');
      expect(updated.path_instructions?.some((p: { path: string }) => p.path === 'src/payments/**')).toBe(true);
      expect(updated.rules?.some((r: { id: string }) => r.id === 'no-raw-sql')).toBe(true);
    });
  });

  describe('In-Place PR Description Summary Sync', () => {
    it('generates concise PR summary and upserts between HTML markers idempotently', () => {
      const summary = generateConcisePRSummary(
        'diff --git a/src/auth.ts b/src/auth.ts\n+export function verifyToken() {}',
        [
          {
            persona: 'security',
            severity: 'P1',
            title: 'Missing token expiration check',
            comment: 'Verify exp claim before trusting payload.',
            filePath: 'src/auth.ts',
            lineNumber: 14,
          },
        ]
      );
      expect(summary).toContain('### Summary by Review Yeti');
      expect(summary).toContain('auth.ts');
      expect(summary).toContain('Flagged 1 actionable issue(s) inline.');

      const initialBody = '## Motivation\nAdds JWT verification helper.';
      const firstPass = upsertPRDescriptionSummary(initialBody, summary);
      expect(firstPass).toContain(PR_SUMMARY_START_MARKER);
      expect(firstPass).toContain(PR_SUMMARY_END_MARKER);
      expect(firstPass).toContain('## Motivation');

      const updatedSummary = generateConcisePRSummary(
        'diff --git a/src/auth.ts b/src/auth.ts\n+export function verifyToken() {}',
        []
      );
      const secondPass = upsertPRDescriptionSummary(firstPass, updatedSummary);
      expect(secondPass.split(PR_SUMMARY_START_MARKER)).toHaveLength(2);
      expect(secondPass).not.toContain('Flagged 1 actionable issue(s) inline.');
    });

    it('syncs PR description via GitHubInstallationClient.syncPullRequestSummaryBlock', async () => {
      const patchBodies: string[] = [];
      const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          const parsed = JSON.parse(String(init.body));
          patchBodies.push(parsed.body);
          return new Response(JSON.stringify({ number: 42, body: parsed.body }), { status: 200 });
        }
        return new Response(JSON.stringify({ number: 42, body: 'Initial PR body' }), { status: 200 });
      });

      const client = new GitHubInstallationClient({
        token: 'ghs_test_token',
        fetchImpl: mockFetch as any,
      });

      const updated = await client.syncPullRequestSummaryBlock(
        'acme',
        'service',
        42,
        '### Review Yeti Summary\n- Updated auth middleware.'
      );
      expect(updated).toContain(PR_SUMMARY_START_MARKER);
      expect(patchBodies).toHaveLength(1);
    });
  });

  describe('Conversational Commands (@review-yeti review <mode> & fix it for me)', () => {
    it('parses natural fix-it-for-me replies and mode arguments', () => {
      expect(parseCommand('@review-yeti fix it for me')).toEqual({
        command: 'fix',
        args: '',
        rawText: '@review-yeti fix it for me',
      });
      expect(parseCommand('fix this for me using prepared statements')).toEqual({
        command: 'fix',
        args: 'using prepared statements',
        rawText: 'fix this for me using prepared statements',
      });
      expect(parseCommand('@review-yeti review deep')).toEqual({
        command: 'review',
        args: 'deep',
        rawText: '@review-yeti review deep',
      });
    });

    it('passes detection mode to onRunReviewPipeline when dispatching @review-yeti review fast|deep', async () => {
      const dispatcher = new CommandDispatcher();
      const onRunReviewPipeline = vi.fn(async () => {});
      const result = await dispatcher.dispatchCommand('@review-yeti review fast', {
        owner: 'acme',
        repo: 'api',
        prNumber: 10,
        github: {} as any,
        payload: { prNumber: 10 },
        onRunReviewPipeline,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('fast mode');
      expect(onRunReviewPipeline).toHaveBeenCalledWith({ prNumber: 10, mode: 'fast' });
    });
  });

  describe('Local CLI Review (review-yeti review)', () => {
    it('runs local review in fast/deep mode and emits JSONL in --raw mode', async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((msg: any) => {
        logs.push(String(msg));
      });

      try {
        const cleanDiff = [
          'diff --git a/src/index.ts b/src/index.ts',
          '--- a/src/index.ts',
          '+++ b/src/index.ts',
          '@@ -1,1 +1,2 @@',
          ' export const a = 1;',
          '+export const b = 2;',
        ].join('\n');

        const res = await runLocalReview({
          mode: 'fast',
          raw: true,
          diff: cleanDiff,
        });

        expect(res.clean).toBe(true);
        expect(res.mode).toBe('fast');
        expect(logs.length).toBeGreaterThanOrEqual(1);
        const summaryLine = JSON.parse(logs[logs.length - 1]);
        expect(summaryLine.type).toBe('summary');
        expect(summaryLine.mode).toBe('fast');
        expect(summaryLine.clean).toBe(true);

        const cliExitCode = await runCli(['review', '--mode', 'fast', '--quiet']);
        expect(cliExitCode).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
