import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePersonaPanel, PanelConfigurationError } from '../../src/panel/panelEngine';
import { ConfigResolver, RepositoryContentClient } from '../../src/config/configResolver';
import { createDefaultV3Config, ConfigValidationError } from '../../src/config/configLoader';
import { CtReviewConfigV3, R4_ALLOWED_MODELS, V3_PROVIDER_MODELS } from '../../src/config/schema';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

function build10PersonaConfig(quorum: number = 4): CtReviewConfigV3 {
  return {
    version: 3,
    profile: 'assertive',
    quorum,
    personas: [
      { id: 'sec-lane', enabled: true, required: true, charter: 'builtin:security', paths: ['**'], providers: ['codex'] },
      { id: 'arch-lane', enabled: true, required: false, charter: 'builtin:constitutional-goals', paths: ['**'], providers: ['claude'] },
      { id: 'perf-lane', enabled: true, required: false, charter: 'builtin:performance', paths: ['**'], providers: ['grok'] },
      { id: 'qual-lane', enabled: true, required: false, charter: 'builtin:consistency', paths: ['**'], providers: ['agy-opus'] },
      { id: 'db-lane', enabled: true, required: false, charter: 'builtin:database', paths: ['**'], providers: ['codex'] },
      { id: 'api-lane', enabled: true, required: false, charter: 'builtin:contract', paths: ['**'], providers: ['claude'] },
      { id: 'sre-lane', enabled: true, required: false, charter: 'builtin:policy-compliance', paths: ['**'], providers: ['grok'] },
      { id: 'devops-lane', enabled: true, required: false, charter: 'builtin:devops', paths: ['**'], providers: ['agy-opus'] },
      { id: 'docs-lane', enabled: true, required: false, charter: 'builtin:consistency', paths: ['**'], providers: ['codex'] },
      { id: 'finops-lane', enabled: true, required: false, charter: 'builtin:finops', paths: ['**'], providers: ['claude'] },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 120,
      providers: [
        { id: 'codex', enabled: true, model: 'codex/gpt-5.6-sol-high', effort: 'max', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'grok', enabled: true, model: 'grok-cli/grok-4.5', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'agy-opus', enabled: true, model: 'agy/claude-opus-4-6-thinking', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
      ],
      arbiter: {
        order: ['codex', 'claude'],
      },
    },
    path_instructions: [],
    rules: [],
    reviewer_effort: 'high',
    confidence_threshold: 70,
    mascot: true,
  };
}

describe('Milestone 37 & Milestone 39 Empirical Challenger Verification Suite', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      complete: vi.fn(),
    };
  });

  describe('1. Milestone 37: 10-Persona Fan-Out Concurrent Execution & Distinct Provider Quorum Harness', () => {
    it('empirically stress-tests 15 parallel 10-persona panel executions under simulated high load', async () => {
      const config = build10PersonaConfig(4);
      const changedFiles = [{ path: 'src/core/heavy_module.ts', patch: '+ export function computeHeavy() {}' }];

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        // Simulate random LLM processing delay (5ms to 25ms)
        const delay = Math.floor(Math.random() * 20) + 5;
        await new Promise((r) => setTimeout(r, delay));

        if (prompt.includes('"role":"moderator"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 250, completion: 40, total: 290 },
            costUSD: 0.002,
          };
        } else if (prompt.includes('"role":"arbiter"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All concurrent persona checks passed.' })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 350, completion: 50, total: 400 },
            costUSD: 0.003,
          };
        } else {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 120, completion: 25, total: 145 },
            costUSD: 0.001,
          };
        }
      });

      // Launch 15 concurrent panel executions
      const startTime = Date.now();
      const promises = Array.from({ length: 15 }, (_, i) =>
        executePersonaPanel({
          config,
          changedFiles,
          repository: `calltelemetry/repo-${i}`,
          headSha: `headsha-concurrent-${i}`,
          client: mockClient as unknown as OmniRouteClient,
        })
      );

      const results = await Promise.all(promises);
      const totalDuration = Date.now() - startTime;

      expect(results).toHaveLength(15);
      for (const res of results) {
        expect(res.personas).toHaveLength(10);
        expect(res.quorum.distinctProviders).toHaveLength(4);
        expect(res.quorum.satisfied).toBe(true);
        expect(res.arbiter.verdict).toBe('SHIP');
      }

      // 15 panels * 12 calls (10 personas + moderator + arbiter) = 180 LLM completions
      expect(mockClient.complete).toHaveBeenCalledTimes(180);
      console.log(`Empirical Stress: Executed 15 parallel 10-persona panels (180 total LLM calls) in ${totalDuration} ms`);
    });

    it('fails closed when distinct provider count is lower than quorum requirement (single provider mapped across all 10 personas)', async () => {
      const config = build10PersonaConfig(4);
      // Reassign all 10 personas to single provider 'codex'
      for (const p of config.personas) {
        p.providers = ['codex'];
      }

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 100, completion: 20, total: 120 },
          costUSD: 0.001,
        };
      });

      await expect(
        executePersonaPanel({
          config,
          changedFiles: [{ path: 'src/app.ts', patch: '+ const x = 1;' }],
          repository: 'calltelemetry/single-provider-test',
          headSha: 'sha-single-provider',
          client: mockClient as unknown as OmniRouteClient,
        })
      ).rejects.toThrow(/distinct-provider quorum failed: 1\/4/);
    });

    it('fails closed when distinct provider count is 3 but quorum required is 4', async () => {
      const config = build10PersonaConfig(4);
      // Map personas to only 3 providers: codex, claude, grok
      config.personas.forEach((p, idx) => {
        if (idx % 3 === 0) p.providers = ['codex'];
        else if (idx % 3 === 1) p.providers = ['claude'];
        else p.providers = ['grok'];
      });

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 100, completion: 20, total: 120 },
          costUSD: 0.001,
        };
      });

      await expect(
        executePersonaPanel({
          config,
          changedFiles: [{ path: 'src/app.ts', patch: '+ const x = 1;' }],
          repository: 'calltelemetry/three-provider-test',
          headSha: 'sha-three-provider',
          client: mockClient as unknown as OmniRouteClient,
        })
      ).rejects.toThrow(/distinct-provider quorum failed: 3\/4/);
    });

    it('fails closed when optional persona failures drop remaining distinct provider count below quorum', async () => {
      const config = build10PersonaConfig(4);
      // sec-lane and db-lane use codex
      // arch-lane and api-lane use claude
      // perf-lane and sre-lane use grok
      // qual-lane and devops-lane use agy-opus
      // Fail perf-lane, sre-lane, qual-lane, devops-lane (which drops grok and agy-opus)

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        if (prompt.includes('"perf-lane"') || prompt.includes('"sre-lane"') || prompt.includes('"qual-lane"') || prompt.includes('"devops-lane"')) {
          throw new Error('Provider outage for grok and agy-opus');
        }

        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 100, completion: 20, total: 120 },
          costUSD: 0.001,
        };
      });

      await expect(
        executePersonaPanel({
          config,
          changedFiles: [{ path: 'src/app.ts', patch: '+ const x = 1;' }],
          repository: 'calltelemetry/quorum-drop-test',
          headSha: 'sha-quorum-drop',
          client: mockClient as unknown as OmniRouteClient,
        })
      ).rejects.toThrow(/distinct-provider quorum failed: 2\/4/);
    });
  });

  describe('2. Milestone 39: 3-Tier Config Precedence & Deep Merging Edge Cases', () => {
    let resolver: ConfigResolver;

    beforeEach(() => {
      resolver = new ConfigResolver();
    });

    it('correctly applies 3-tier precedence (Target Repo -> Org .github -> System Defaults) for partial persona dials and top-level scalars', async () => {
      const mockClient: RepositoryContentClient = {
        getFileContent: async (owner: string, repo: string, path: string) => {
          if (repo === 'my-target-repo' && path === '.ct-review.yaml') {
            return `
version: 3
profile: assertive
quorum: 3
dials:
  persona_model: claude-5-sonnet
personas:
  - id: sec-lane
    effort: max
`;
          }
          if (repo === '.github' && path === '.ct-review.yaml') {
            return `
version: 3
profile: chill
quorum: 2
confidence_threshold: 85
reviewers:
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: max
      review_timeout_s: 30
      arbiter_timeout_s: 30
    - id: claude
      enabled: true
      model: claude-5-sonnet
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
    - id: grok
      enabled: true
      model: grok-cli/grok-4.5
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
    - id: agy-opus
      enabled: true
      model: agy/claude-opus-4-6-thinking
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
personas:
  - id: sec-lane
    effort: low
  - id: docs-lane
    enabled: false
`;
          }
          return null;
        },
      };

      const resolved = await resolver.resolveConfig({
        owner: 'my-org',
        repo: 'my-target-repo',
        client: mockClient,
      });

      // Top-level scalars precedence
      expect(resolved.profile).toBe('assertive'); // Repo overrides Org & System
      expect(resolved.quorum).toBe(3); // Repo overrides Org
      expect(resolved.confidence_threshold).toBe(85); // Org overrides System

      // Personas length should still be 10 (System default 10 personas)
      expect(resolved.personas.length).toBeGreaterThanOrEqual(10);

      // Partial persona dial override: sec-lane effort was set to max by Repo (overriding Org 'low')
      const secLane = resolved.personas.find((p) => p.id === 'sec-lane');
      expect(secLane).toBeDefined();
      expect(secLane?.effort).toBe('max');
      expect(secLane?.required).toBe(true); // Retains system default required flag

      // docs-lane was disabled by Org, retained in Repo
      const docsLane = resolved.personas.find((p) => p.id === 'docs-lane');
      expect(docsLane).toBeDefined();
      expect(docsLane?.enabled).toBe(false);

      // Global persona_model dial override applied to personas without explicit model
      expect(resolved.dials.persona_model).toBe('claude-5-sonnet');
      const perfLane = resolved.personas.find((p) => p.id === 'perf-lane');
      expect(perfLane?.model).toBe('claude-5-sonnet');
    });

    it('throws ConfigValidationError when an invalid model string is specified in Repo or Org config', async () => {
      const mockClient: RepositoryContentClient = {
        getFileContent: async (owner: string, repo: string, path: string) => {
          if (repo === 'bad-repo' && path === '.ct-review.yaml') {
            return `
version: 3
quorum: 2
dials:
  persona_model: untrusted-hacked-model-v99
`;
          }
          return null;
        },
      };

      await expect(
        resolver.resolveConfig({
          owner: 'my-org',
          repo: 'bad-repo',
          client: mockClient,
        })
      ).rejects.toThrow(ConfigValidationError);
    });

    it('throws ConfigValidationError when an invalid provider model is specified in Org config', async () => {
      const mockClient: RepositoryContentClient = {
        getFileContent: async (owner: string, repo: string, path: string) => {
          if (repo === '.github' && path === '.ct-review.yaml') {
            return `
version: 3
quorum: 2
reviewers:
  providers:
    - id: codex
      enabled: true
      model: invalid-codex-variant
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
`;
          }
          return null;
        },
      };

      await expect(
        resolver.resolveConfig({
          owner: 'my-org',
          repo: 'some-repo',
          client: mockClient,
        })
      ).rejects.toThrow(ConfigValidationError);
    });

    it('correctly handles conflicting arrays across 3 tiers (path_instructions, rules, path_filters, mcps)', async () => {
      const mockClient: RepositoryContentClient = {
        getFileContent: async (owner: string, repo: string, path: string) => {
          if (repo === 'array-repo' && path === '.ct-review.yaml') {
            return `
version: 3
quorum: 2
path_instructions:
  - path: "src/**/*.ts"
    instructions: "Repo level path instruction"
rules:
  - id: rule-repo
    rule: "Repo level rule"
path_filters:
  - "!dist/**"
mcps:
  - name: context7
    enabled: true
`;
          }
          if (repo === '.github' && path === '.ct-review.yaml') {
            return `
version: 3
quorum: 2
path_instructions:
  - path: "org/**/*.ts"
    instructions: "Org level path instruction"
rules:
  - id: rule-org
    rule: "Org level rule"
path_filters:
  - "!vendor/**"
`;
          }
          return null;
        },
      };

      const resolved = await resolver.resolveConfig({
        owner: 'my-org',
        repo: 'array-repo',
        client: mockClient,
      });

      // Target Repo arrays override Org & System arrays per ConfigResolver rules
      expect(resolved.path_instructions).toEqual([
        { path: 'src/**/*.ts', instructions: 'Repo level path instruction' },
      ]);
      expect(resolved.rules).toEqual([
        { id: 'rule-repo', rule: 'Repo level rule', scope: ['**'], severity: 'P1' },
      ]);
      expect(resolved.path_filters).toEqual(['!dist/**']);
      expect(resolved.mcps).toEqual([{ name: 'context7', enabled: true }]);
    });

    it('handles object map format vs array format for personas in Org/Repo configs', async () => {
      const sysDefault = createDefaultV3Config();
      const orgConfigWithObjMap = {
        reviews: {
          personas: {
            'sec-lane': { effort: 'max' },
            'custom-lane': {
              enabled: true,
              required: false,
              charter: 'builtin:performance',
              paths: ['src/**'],
              providers: ['claude'],
            },
          },
        },
      };
      const repoConfigWithArray = {
        personas: [
          { id: 'custom-lane', effort: 'high' },
          { id: 'docs-lane', enabled: false },
        ],
      };

      const merged = resolver.deepMergeConfigs(sysDefault, orgConfigWithObjMap, repoConfigWithArray);
      const validated = resolver.validateResolvedConfig(merged);

      const secLane = validated.personas.find((p) => p.id === 'sec-lane');
      expect(secLane?.effort).toBe('max');

      const customLane = validated.personas.find((p) => p.id === 'custom-lane');
      expect(customLane?.effort).toBe('high');
      expect(customLane?.charter).toBe('builtin:performance');

      const docsLane = validated.personas.find((p) => p.id === 'docs-lane');
      expect(docsLane?.enabled).toBe(false);
    });
  });

  describe('3. Required vs Optional Persona Failure Handling', () => {
    it('fails closed when required persona (sec-lane) throws network exception or times out', async () => {
      const config = build10PersonaConfig(4);

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        if (prompt.includes('"sec-lane"')) {
          throw new Error('ETIMEDOUT connecting to LLM endpoint for sec-lane');
        }

        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 100, completion: 20, total: 120 },
          costUSD: 0.001,
        };
      });

      await expect(
        executePersonaPanel({
          config,
          changedFiles: [{ path: 'src/security/auth.ts', patch: '+ token = "insecure";' }],
          repository: 'calltelemetry/sec-fail-test',
          headSha: 'sha-sec-fail',
          client: mockClient as unknown as OmniRouteClient,
        })
      ).rejects.toThrow(/required persona failure: persona sec-lane failed closed: codex: ETIMEDOUT/);
    });

    it('fails closed when multiple required personas fail simultaneously', async () => {
      const config = build10PersonaConfig(4);
      // Make arch-lane also required
      const archLane = config.personas.find((p) => p.id === 'arch-lane');
      if (archLane) archLane.required = true;

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;

        if (prompt.includes('"sec-lane"') || prompt.includes('"arch-lane"')) {
          throw new Error('Simulated critical failure');
        }

        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 100, completion: 20, total: 120 },
          costUSD: 0.001,
        };
      });

      await expect(
        executePersonaPanel({
          config,
          changedFiles: [{ path: 'src/app.ts', patch: '+ const a = 1;' }],
          repository: 'calltelemetry/multi-required-fail',
          headSha: 'sha-multi-req',
          client: mockClient as unknown as OmniRouteClient,
        })
      ).rejects.toThrow(/required persona failure:.*sec-lane.*arch-lane/);
    });

    it('gracefully logs and recovers when optional personas (docs-lane & finops-lane) fail', async () => {
      const config = build10PersonaConfig(4);

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        if (prompt.includes('"docs-lane"')) {
          throw new Error('503 Service Unavailable for docs-lane');
        }
        if (prompt.includes('"finops-lane"')) {
          throw new Error('500 Internal Error for finops-lane');
        }

        if (prompt.includes('"role":"moderator"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 200, completion: 40, total: 240 },
            costUSD: 0.002,
          };
        } else if (prompt.includes('"role":"arbiter"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: '8 persona lanes passed.' })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 300, completion: 50, total: 350 },
            costUSD: 0.003,
          };
        } else {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 100, completion: 20, total: 120 },
            costUSD: 0.001,
          };
        }
      });

      const result = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/app.ts', patch: '+ const x = 1;' }],
        repository: 'calltelemetry/optional-fail-test',
        headSha: 'sha-optional-fail',
        client: mockClient as unknown as OmniRouteClient,
      });

      expect(result.personas).toHaveLength(8); // 10 total minus 2 failed optional personas
      expect(result.optionalFailures).toHaveLength(2);
      expect(result.optionalFailures.map((f) => f.id)).toEqual(['docs-lane', 'finops-lane']);
      expect(result.quorum.satisfied).toBe(true);
      expect(result.arbiter.verdict).toBe('SHIP');
    });
  });
});
