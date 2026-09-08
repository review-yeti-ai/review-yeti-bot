import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyReviewScope,
  containsExecutableOrSensitiveCode,
} from '../../src/panel/classifierEngine';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { CtReviewConfigV3, ctReviewConfigV3Schema } from '../../src/config/schema';
import { ReviewModelClient } from '../../src/gateway/openRouterClient';

function buildTestConfig(): CtReviewConfigV3 {
  return ctReviewConfigV3Schema.parse({
    version: 3,
    profile: 'balanced',
    quorum: 1,
    personas: [
      {
        id: 'sec-lane',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['**/*'],
        providers: ['claude'],
      },
      {
        id: 'perf-lane',
        enabled: true,
        required: false,
        charter: 'builtin:performance',
        paths: ['**/*'],
        providers: ['claude'],
      },
      {
        id: 'db-lane',
        enabled: true,
        required: false,
        charter: 'builtin:database',
        paths: ['**/*'],
        providers: ['claude'],
      },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'none',
      overall_timeout_s: 30,
      providers: [
        {
          id: 'claude',
          enabled: true,
          model: 'claude-5-sonnet',
          effort: 'medium',
          review_timeout_s: 15,
          arbiter_timeout_s: 15,
        },
      ],
      arbiter: { order: ['claude'] },
    },
    path_instructions: [],
    rules: [],
    reviewer_effort: 'medium',
    confidence_threshold: 70,
    mascot: true,
    display: { mascot: true },
  });
}

describe('classifierEngine.ts — Pre-Flight Triage & Fast-Ship Safety', () => {
  describe('containsExecutableOrSensitiveCode', () => {
    it('returns false for pure documentation and non-executable assets', () => {
      expect(
        containsExecutableOrSensitiveCode([
          { path: 'README.md' },
          { path: 'docs/architecture.md' },
          { path: '.gitignore' },
          { path: 'assets/logo.png' },
          { path: 'LICENSE' },
        ])
      ).toBe(false);
    });

    it('returns true for executable code files', () => {
      expect(containsExecutableOrSensitiveCode([{ path: 'src/main.ts' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'lib/app.ex' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'scripts/deploy.sh' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'db/schema.sql' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'ui/Button.vue' }])).toBe(true);
    });

    it('returns true for sensitive security and workflow paths even without executable extension', () => {
      expect(containsExecutableOrSensitiveCode([{ path: '.github/workflows/review.yml' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'config/auth/secret.json' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'migrations/001.txt' }])).toBe(true);
    });

    it('returns true for sensitive non-executable dotfiles and credentials', () => {
      expect(containsExecutableOrSensitiveCode([{ path: '.env' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'config/.env' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: '.env.production' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'id_rsa' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: '.npmrc' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'secrets.txt' }])).toBe(true);
    });

    it('returns true for extension-less executables, build scripts, and alternative CI systems', () => {
      expect(containsExecutableOrSensitiveCode([{ path: 'Makefile' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'bin/deploy' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'scripts/run' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: '.gitlab-ci.yml' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: '.circleci/config.yml' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'Jenkinsfile' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'cloudbuild.yaml' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'Dockerfile' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'docker-compose.yml' }])).toBe(true);
    });
  });

  describe('classifyReviewScope', () => {
    let mockClient: ReviewModelClient;

    beforeEach(() => {
      mockClient = {
        complete: vi.fn(),
      };
    });

    it('returns fastShip: true for documentation PR when model approves', async () => {
      const config = buildTestConfig();
      (mockClient.complete as any).mockResolvedValueOnce({
        model: 'claude-5-sonnet',
        content: JSON.stringify({
          fastShip: true,
          selectedPersonas: [],
          effortTier: 'low',
          rationale: 'Docs only change, zero functional risk.',
        }),
        usage: { prompt: 120, completion: 40, total: 160 },
        costUSD: 0.0001,
      });

      const result = await classifyReviewScope({
        config,
        changedFiles: [{ path: 'docs/guide.md', patch: '+ updated instructions' }],
        candidatePersonas: config.personas,
        repository: 'calltelemetry/ai-workspace',
        headSha: 'abc1234',
        client: mockClient,
      });

      expect(result).not.toBeNull();
      expect(result?.fastShip).toBe(true);
      expect(result?.rationale).toContain('Docs only');
      expect(result?.effortTier).toBe('low');
    });

    it('guardrail overrides fastShip to false if diff contains executable files', async () => {
      const config = buildTestConfig();
      (mockClient.complete as any).mockResolvedValueOnce({
        model: 'claude-5-sonnet',
        content: JSON.stringify({
          fastShip: true,
          selectedPersonas: [],
          effortTier: 'low',
          rationale: 'Model erroneously marked this as fast ship',
        }),
      });

      const result = await classifyReviewScope({
        config,
        changedFiles: [{ path: 'src/auth/token.ts', patch: '+ const token = "abc";' }],
        candidatePersonas: config.personas,
        repository: 'calltelemetry/ai-workspace',
        headSha: 'abc1234',
        client: mockClient,
      });

      expect(result).not.toBeNull();
      expect(result?.fastShip).toBe(false);
    });

    it('narrows candidate personas when model selects specific personas', async () => {
      const config = buildTestConfig();
      (mockClient.complete as any).mockResolvedValueOnce({
        model: 'claude-5-sonnet',
        content: JSON.stringify({
          fastShip: false,
          selectedPersonas: ['perf-lane'],
          effortTier: 'medium',
          rationale: 'Performance optimization diff touching caching loop.',
        }),
      });

      const result = await classifyReviewScope({
        config,
        changedFiles: [{ path: 'src/cache.ts', patch: '+ cache.set(k, v);' }],
        candidatePersonas: config.personas,
        repository: 'calltelemetry/ai-workspace',
        headSha: 'abc1234',
        client: mockClient,
      });

      expect(result).not.toBeNull();
      expect(result?.fastShip).toBe(false);
      expect(result?.selectedPersonas).toEqual(['perf-lane']);
      expect(result?.effortTier).toBe('medium');
    });

    it('fails open (returns null) if model client throws network/provider error', async () => {
      const config = buildTestConfig();
      (mockClient.complete as any).mockRejectedValueOnce(new Error('OmniRoute HTTP 503 Service Unavailable'));

      const result = await classifyReviewScope({
        config,
        changedFiles: [{ path: 'docs/readme.md', patch: '+ hello' }],
        candidatePersonas: config.personas,
        repository: 'calltelemetry/ai-workspace',
        headSha: 'abc1234',
        client: mockClient,
      });

      expect(result).toBeNull();
    });

    it('fails open (returns null) if model returns unparseable content', async () => {
      const config = buildTestConfig();
      (mockClient.complete as any).mockResolvedValueOnce({
        model: 'claude-5-sonnet',
        content: 'I am not returning valid JSON today.',
      });

      const result = await classifyReviewScope({
        config,
        changedFiles: [{ path: 'docs/readme.md', patch: '+ hello' }],
        candidatePersonas: config.personas,
        repository: 'calltelemetry/ai-workspace',
        headSha: 'abc1234',
        client: mockClient,
      });

      expect(result).toBeNull();
    });

    it('bypasses classification in qualification runs', async () => {
      const config = buildTestConfig();

      const result = await classifyReviewScope({
        config,
        changedFiles: [{ path: 'docs/readme.md', patch: '+ hello' }],
        candidatePersonas: config.personas,
        repository: 'calltelemetry/ai-workspace',
        headSha: 'abc1234',
        client: mockClient,
        requestPolicy: {
          metadata: { qualificationMode: 'full-panel' },
        } as any,
      });

      expect(result).toBeNull();
      expect(mockClient.complete).not.toHaveBeenCalled();
    });
  });

  describe('Integration with executePersonaPanel', () => {
    let mockClient: ReviewModelClient;

    beforeEach(() => {
      mockClient = {
        complete: vi.fn(),
      };
    });

    it('fast-ships docs PR immediately with consensus approval and zero persona execution', async () => {
      const config = buildTestConfig();

      // First call is classifier
      (mockClient.complete as any).mockImplementationOnce(async (opts: any) => {
        expect(opts.persona).toBe('classifier');
        return {
          model: opts.model,
          content: JSON.stringify({
            fastShip: true,
            selectedPersonas: [],
            effortTier: 'low',
            rationale: 'Documentation markdown update only.',
          }),
          usage: { prompt: 50, completion: 20, total: 70 },
          costUSD: 0.00005,
        };
      });

      const panelResult = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'docs/README.md', patch: '+ # Welcome' }],
        repository: 'calltelemetry/ai-workspace',
        headSha: 'sha-fast-1',
        client: mockClient,
      });

      // Verification:
      // 1. Verdict is SHIP
      expect(panelResult.arbiter.verdict).toBe('SHIP');
      expect(panelResult.arbiter.rationale).toContain('Fast-ship auto-approved: Documentation markdown update only.');
      // 2. Only 1 call was made to client (the classifier)
      expect(mockClient.complete).toHaveBeenCalledTimes(1);
      // 3. Personas lane contains the synthetic fast-ship lane
      expect(panelResult.personas).toHaveLength(1);
      expect(panelResult.personas[0].id).toBe('fast-ship');
      expect(panelResult.personas[0].decision).toBe('APPROVE');
      expect(panelResult.quorum.satisfied).toBe(true);
    });

    it('prunes unselected optional personas while retaining required personas', async () => {
      const config = buildTestConfig();

      (mockClient.complete as any).mockImplementation(async (opts: any) => {
        if (opts.persona === 'classifier') {
          return {
            model: opts.model,
            content: JSON.stringify({
              fastShip: false,
              selectedPersonas: ['perf-lane'], // selects perf-lane, leaves db-lane unselected
              effortTier: 'medium',
              rationale: 'Performance critical code path changed.',
            }),
            usage: { prompt: 100, completion: 30, total: 130 },
          };
        }

        const prompt = (opts.messages[1]?.content as string) || '';
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';

        if (opts.persona === 'arbiter') {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Approved by arbiter' })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 10, completion: 10, total: 20 },
          };
        } else if (opts.persona === 'moderator') {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 10, completion: 10, total: 20 },
          };
        } else {
          // Persona lane
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 10, completion: 10, total: 20 },
          };
        }
      });

      const panelResult = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/compute.ts', patch: '+ function compute() {}' }],
        repository: 'calltelemetry/ai-workspace',
        headSha: 'sha-prune-1',
        client: mockClient,
      });

      // Personas executed should be sec-lane (required) + perf-lane (selected)
      // db-lane (optional and not selected) should be PRUNED!
      const personaIds = panelResult.personas.map((p) => p.id);
      expect(personaIds).toContain('sec-lane');
      expect(personaIds).toContain('perf-lane');
      expect(personaIds).not.toContain('db-lane');
      expect(panelResult.arbiter.verdict).toBe('SHIP');
    });

    it('aborts fast-ship and throws PanelConfigurationError when run is stale or superseded', async () => {
      const config = buildTestConfig();

      (mockClient.complete as any).mockResolvedValueOnce({
        model: 'claude-5-sonnet',
        content: JSON.stringify({
          fastShip: true,
          selectedPersonas: [],
          effortTier: 'low',
          rationale: 'Docs only change.',
        }),
      });

      await expect(
        executePersonaPanel({
          config,
          changedFiles: [{ path: 'docs/README.md', patch: '+ # Welcome' }],
          repository: 'calltelemetry/ai-workspace',
          headSha: 'sha-stale-head',
          client: mockClient,
          isCurrentHead: () => false,
        })
      ).rejects.toThrow(/stale run aborted/);
    });
  });
});
