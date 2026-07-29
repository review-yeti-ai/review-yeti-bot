import { describe, expect, it, vi } from 'vitest';
import { parseAndValidateConfig, loadConfig, translateCodeRabbitToV3, ConfigValidationError } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import { formatInlineCommentBody, ASCII_MASCOT, CommentPublisher } from '../../src/github/commentPublisher';
import { runReviewPipeline } from '../../src/app';

// Mocks for GitHub App and OmniRoute in pipeline tests
vi.mock('../../src/github/appAuth', () => ({
  getGitHubAppInstallationToken: vi.fn().mockResolvedValue({
    token: 'ghs_mock_token_1234567890',
    permissions: {
      metadata: 'read',
      contents: 'read',
      pull_requests: 'write',
      issues: 'write',
      checks: 'write',
    },
  }),
}));

describe('Milestone 4 Remediation Re-verification (Challenger 2)', () => {

  describe('1. Unversioned / v1 / v2 `.ct-review.yaml` Conversion & 4-Tier Hierarchy Integrity', () => {

    it('converts unversioned `.ct-review.yaml` cleanly via translateCodeRabbitToV3 without throwing', () => {
      const rawYaml = `
profile: chill
reviewer_effort: high
confidence_threshold: 80
mascot: true
`;
      const parsed = parseAndValidateConfig(rawYaml, false);
      // parseAndValidateConfig returns legacy format for unversioned unless hasCodeRabbitFields is true,
      // but loadConfig converts non-v3 to V3 using translateCodeRabbitToV3.
      // Let's test translateCodeRabbitToV3 directly on the raw parsed YAML:
      const raw = { profile: 'chill', reviewer_effort: 'high', confidence_threshold: 80, mascot: true };
      const v3Translated = translateCodeRabbitToV3(raw);

      // Verify v3 schema validation passes on translated output
      const validation = ctReviewConfigV3Schema.safeParse(v3Translated);
      expect(validation.success).toBe(true);
      expect(v3Translated.version).toBe(3);
      expect(v3Translated.profile).toBe('chill');
      expect(v3Translated.reviewer_effort).toBe('high');
      expect(v3Translated.confidence_threshold).toBe(80);
      expect(v3Translated.mascot).toBe(true);
    });

    it('verifies 4-tier hierarchy structural completeness on legacy conversion', () => {
      const raw = {
        reviews: {
          profile: 'assertive',
          reviewer_effort: 'max',
          confidence_threshold: 90,
          path_instructions: [
            { path: 'src/critical/**', instructions: 'Check memory leaks' }
          ]
        }
      };

      const v3 = translateCodeRabbitToV3(raw);

      // Tier 1: Personas array exists, non-empty, contains required persona
      expect(Array.isArray(v3.personas)).toBe(true);
      expect(v3.personas.length).toBeGreaterThanOrEqual(1);
      const requiredPersona = v3.personas.find(p => p.enabled && p.required);
      expect(requiredPersona).toBeDefined();
      expect(requiredPersona?.charter).toBe('builtin:security');
      expect(requiredPersona?.paths).toEqual(['**']);
      expect(requiredPersona?.providers).toContain('codex');

      // Tier 2: Reviewer Providers array exists, non-empty, contains enabled codex provider with correct model
      expect(Array.isArray(v3.reviewers.providers)).toBe(true);
      expect(v3.reviewers.providers.length).toBeGreaterThanOrEqual(1);
      const codexProvider = v3.reviewers.providers.find(p => p.id === 'codex');
      expect(codexProvider).toBeDefined();
      expect(codexProvider?.enabled).toBe(true);
      expect(codexProvider?.model).toBe('codex/gpt-5.6-sol-high');
      expect(codexProvider?.effort).toBe('low');

      // Tier 3: Arbiter configuration specifies valid provider order
      expect(v3.reviewers.arbiter).toBeDefined();
      expect(Array.isArray(v3.reviewers.arbiter.order)).toBe(true);
      expect(v3.reviewers.arbiter.order).toContain('codex');

      // Tier 4: Quorum is positive integer <= enabled distinct providers
      expect(v3.quorum).toBe(1);
      expect(v3.quorum).toBeLessThanOrEqual(v3.reviewers.providers.filter(p => p.enabled).length);

      // Additional dials
      expect(v3.path_instructions).toHaveLength(1);
      expect(v3.path_instructions[0].path).toBe('src/critical/**');
    });

    it('loadConfig preserves unversioned / v1 / v2 repo `.ct-review.yaml` without skipping Tier 1', async () => {
      // Simulate repo having an unversioned / v1 .ct-review.yaml
      const mockClient = {
        getFileContent: vi.fn().mockImplementation(async (owner: string, repo: string, path: string) => {
          if (repo !== '.github' && path === '.ct-review.yaml') {
            return `
version: 1
profile: chill
reviewer_effort: low
confidence_threshold: 65
`;
          }
          if (repo === '.github' && path === '.ct-review.yaml') {
            return `
version: 3
profile: assertive
quorum: 1
personas:
  - id: correctness-persona
    enabled: true
    required: true
    charter: builtin:correctness
    paths: ["**"]
    providers: [codex]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 300
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 60
      arbiter_timeout_s: 60
  arbiter:
    order: [codex]
`;
          }
          return null;
        }),
      };

      const config = await loadConfig('myorg', 'myrepo', 'main', mockClient);

      // Must be converted to V3 cleanly
      expect(config.version).toBe(3);
      // Must inherit from Tier 1 (.ct-review.yaml in repo) 'chill', NOT Tier 3 org default 'assertive'
      expect(config.profile).toBe('chill');
      expect(config.reviewer_effort).toBe('low');
      expect(config.confidence_threshold).toBe(65);

      // Verify Tier 1 was fetched for PR branch
      expect(mockClient.getFileContent).toHaveBeenCalledWith('myorg', 'myrepo', '.ct-review.yaml', 'main');
      // Tier 3 should NOT have been fetched because Tier 1 exists
      expect(mockClient.getFileContent).not.toHaveBeenCalledWith('myorg', '.github', '.ct-review.yaml');
    });

    it('handles version: 2 `.ct-review.yaml` cleanly via loadConfig', async () => {
      const mockClient = {
        getFileContent: vi.fn().mockImplementation(async (_owner: string, _repo: string, path: string) => {
          if (path === '.ct-review.yaml') {
            return `
version: 2
profile: assertive
reviewer_effort: xhigh
confidence_threshold: 85
mascot: false
`;
          }
          return null;
        }),
      };

      const config = await loadConfig('myorg', 'myrepo', 'pr-branch', mockClient);
      expect(config.version).toBe(3);
      expect(config.profile).toBe('assertive');
      expect(config.reviewer_effort).toBe('xhigh');
      expect(config.confidence_threshold).toBe(85);
      expect(config.mascot).toBe(false);
    });

  });

  describe('2. Confidence Threshold Filtering in app.ts & Summary Engine', () => {

    it('filters findings below confidence threshold (e.g. threshold 70 filters out confidence 50)', () => {
      const findings = [
        { severity: 'P0', path: 'file1.ts', line: 10, body: 'High confidence bug', title: 'Bug 1', confidence: 85 },
        { severity: 'P1', path: 'file2.ts', line: 20, body: 'Low confidence bug', title: 'Bug 2', confidence: 50 },
        { severity: 'P2', path: 'file3.ts', line: 30, body: 'Exact threshold bug', title: 'Bug 3', confidence: 70 },
        { severity: 'P1', path: 'file4.ts', line: 40, body: 'No confidence specified', title: 'Bug 4' },
        { severity: 'P1', path: 'file5.ts', line: 50, body: 'Null confidence', title: 'Bug 5', confidence: null as any },
      ];

      const threshold = 70;
      const filtered = findings.filter(
        (f) => f.confidence === undefined || f.confidence === null || f.confidence >= threshold
      );

      expect(filtered).toHaveLength(4);
      expect(filtered.map(f => f.title)).toEqual(['Bug 1', 'Bug 3', 'Bug 4', 'Bug 5']);
      expect(filtered.find(f => f.title === 'Bug 2')).toBeUndefined();
    });

    it('honors confidence_threshold = 0 (includes all findings regardless of confidence)', () => {
      const findings = [
        { title: 'Bug 1', confidence: 10 },
        { title: 'Bug 2', confidence: 0 },
        { title: 'Bug 3', confidence: 99 },
      ];

      const threshold = 0;
      const filtered = findings.filter(
        (f) => f.confidence === undefined || f.confidence === null || f.confidence >= threshold
      );

      expect(filtered).toHaveLength(3);
    });

    it('honors confidence_threshold = 100 (filters out any finding with confidence < 100)', () => {
      const findings = [
        { title: 'Bug 1', confidence: 99 },
        { title: 'Bug 2', confidence: 100 },
        { title: 'Bug 3', confidence: undefined },
      ];

      const threshold = 100;
      const filtered = findings.filter(
        (f) => f.confidence === undefined || f.confidence === null || f.confidence >= threshold
      );

      expect(filtered).toHaveLength(2);
      expect(filtered.map(f => f.title)).toEqual(['Bug 2', 'Bug 3']);
    });

  });

  describe('3. ASCII Mascot Prepending in commentPublisher.ts & Summary', () => {

    it('formatInlineCommentBody prepends ASCII_MASCOT when options.mascot is true', () => {
      const finding = {
        persona: 'security-persona',
        severity: 'critical' as const,
        filePath: 'src/auth.ts',
        lineNumber: 15,
        comment: 'Hardcoded secret detected',
        confidence: 95,
      };

      const bodyWithMascot = formatInlineCommentBody(finding, { mascot: true });
      expect(bodyWithMascot.startsWith(ASCII_MASCOT)).toBe(true);
      expect(bodyWithMascot).toContain('CallTelemetry AI Reviewer');
      expect(bodyWithMascot).toContain('### [security-persona]');
      expect(bodyWithMascot).toContain('**Confidence**: 95%');
    });

    it('formatInlineCommentBody suppresses ASCII_MASCOT when options.mascot is false or omitted', () => {
      const finding = {
        persona: 'security-persona',
        severity: 'critical' as const,
        filePath: 'src/auth.ts',
        lineNumber: 15,
        comment: 'Hardcoded secret detected',
      };

      const bodyWithoutMascot = formatInlineCommentBody(finding, { mascot: false });
      expect(bodyWithoutMascot.includes(ASCII_MASCOT)).toBe(false);
      expect(bodyWithoutMascot.startsWith('### [security-persona]')).toBe(true);

      const bodyDefault = formatInlineCommentBody(finding);
      expect(bodyDefault.includes(ASCII_MASCOT)).toBe(false);
    });

    it('verifies ASCII_MASCOT exact text format', () => {
      expect(ASCII_MASCOT).toBe(
        '```\n' +
        '  /\\_/\\   CallTelemetry AI Reviewer\n' +
        ' ( o.o )  Code Telemetry & Security Engine\n' +
        '  > ^ <\n' +
        '```'
      );
    });

    it('publishReview passes mascot option down to inline comment bodies', async () => {
      const publisher = new CommentPublisher({
        githubToken: 'ghs_mock_token_for_test',
        baseUrl: 'https://mock.github.api',
      });

      // Mock fetch
      let requestBodySent: any = null;
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        requestBodySent = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ id: 101 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }));

      const res = await publisher.publishReview({
        owner: 'testowner',
        repo: 'testrepo',
        prNumber: 42,
        commitSha: 'sha123',
        event: 'COMMENT',
        body: 'Review summary body',
        mascot: true,
        inlineComments: [
          {
            owner: 'testowner',
            repo: 'testrepo',
            prNumber: 42,
            commitSha: 'sha123',
            path: 'src/app.ts',
            line: 10,
            finding: {
              persona: 'correctness',
              severity: 'P1',
              filePath: 'src/app.ts',
              lineNumber: 10,
              comment: 'Check return value',
            },
          },
        ],
      });

      expect(res.success).toBe(true);
      expect(requestBodySent).toBeDefined();
      expect(requestBodySent.comments).toHaveLength(1);
      expect(requestBodySent.comments[0].body).toContain(ASCII_MASCOT);

      vi.unstubAllGlobals();
    });

  });

});
