import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipelinePath = path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js');
const pipeline = require(pipelinePath);

const workflowPath = path.join(rootRepoDir, '.github/workflows/review-bot.yaml');

describe('Dispatch path: persona resolution defaults', () => {
  const { resolvePersonaRoster, DEFAULT_PERSONA_IDS } = pipeline;
  const defaultIds = DEFAULT_PERSONA_IDS;
  const ids = (payload: any, cfg: any, env: any) =>
    resolvePersonaRoster(payload, cfg, env).personas.map((p: any) => p.id);

  it('maps trusted Action OpenRouter inputs into the runtime policy without PR-head config', () => {
    const runtime = pipeline.resolveActionReviewRuntime({ parsed: {} }, {
      OPENROUTER_API_KEY: 'test-openrouter-key',
      OPENROUTER_MODEL: 'openrouter/auto',
      OPENROUTER_ALLOWED_MODELS: 'openai/gpt-5.6-luna,z-ai/glm-5.2',
      OPENROUTER_COST_QUALITY_TRADEOFF: '4',
      OPENROUTER_DATA_COLLECTION: 'deny',
    });

    expect(runtime.modelConfig).toMatchObject({
      enabled: true,
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openrouter/auto',
      openRouterPolicy: {
        model: 'openrouter/auto',
        allowed_models: ['openai/gpt-5.6-luna', 'z-ai/glm-5.2'],
        data_collection: 'deny',
        cost_quality_tradeoff: 4,
      },
    });
  });

  it('consumes trusted base-config github_action.openrouter policy before Action input overlays', () => {
    const runtime = pipeline.resolveActionReviewRuntime({
      file: '.ct-review.yaml',
      parsed: {
        github_action: {
          openrouter: {
            allowed_models: ['moonshotai/kimi-k2.6', 'z-ai/glm-5.2'],
            cost_quality_tradeoff: 3,
            data_collection: 'deny',
          },
        },
      },
    }, {
      OPENROUTER_API_KEY: 'test-openrouter-key',
    });

    expect(runtime.modelConfig.openRouterPolicy).toMatchObject({
      model: 'openrouter/auto',
      allowed_models: ['moonshotai/kimi-k2.6', 'z-ai/glm-5.2'],
      data_collection: 'deny',
      cost_quality_tradeoff: 3,
    });
  });

  it('rejects malformed trusted Action OpenRouter inputs before dispatch', () => {
    expect(() => pipeline.resolveActionReviewRuntime({ parsed: {} }, {
      OPENROUTER_API_KEY: 'test-openrouter-key',
      OPENROUTER_ALLOWED_MODELS: 'openai/not-approved',
      OPENROUTER_DATA_COLLECTION: 'deny',
    })).toThrow('canonical five-model fleet');
  });

  it('keeps OpenRouter policy canonical when a legacy caller supplies a provider transport handoff', () => {
    const runtime = pipeline.resolveActionReviewRuntime({ parsed: {} }, {
      OPENROUTER_API_KEY: 'selected-provider-key',
      OPENROUTER_BASE_URL: 'https://api.fireworks.ai/inference/v1',
      OPENROUTER_MODEL: 'accounts/fireworks/models/deepseek-v4-flash-0731',
      REVIEW_YETI_TRANSPORTS: JSON.stringify([
        {
          name: 'fireworks',
          base_url: 'https://api.fireworks.ai/inference/v1',
          model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
          api_key_env: 'OPENROUTER_API_KEY',
        },
      ]),
    });

    expect(runtime.modelConfig.openRouterPolicy).toMatchObject({
      base_url: 'https://openrouter.ai/api/v1',
      model: 'openrouter/auto',
    });
    expect(runtime.modelConfig.transports[0]).toMatchObject({
      name: 'fireworks',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
    });
  });

  it('defaults to the default reviewer set when nothing is configured', () => {
    expect(ids({}, null, {})).toEqual(['security', 'performance', 'architecture', 'testing', 'dependencies']);
  });

  it('defaults to the default reviewer set when ACTIVE_PERSONAS is the literal string "null"', () => {
    // GitHub Actions renders toJson(<missing>) as the string "null" on pull_request events.
    expect(ids({}, null, { ACTIVE_PERSONAS: 'null' })).toEqual(defaultIds);
  });

  it('defaults to the default reviewer set when ACTIVE_PERSONAS is empty or whitespace', () => {
    expect(ids({}, null, { ACTIVE_PERSONAS: '' })).toEqual(defaultIds);
    expect(ids({}, null, { ACTIVE_PERSONAS: '   ' })).toEqual(defaultIds);
  });

  it('honors an explicit activePersonas array from the dispatch client_payload', () => {
    expect(ids({ activePersonas: ['security', 'devops'] }, null, {})).toEqual(['security', 'devops']);
  });

  it('honors an explicit empty activePersonas array as a real opt-out', () => {
    expect(ids({ activePersonas: [] }, null, {})).toEqual([]);
  });

  it('honors personaSettings toggles from the dispatch client_payload', () => {
    const payload = {
      personaSettings: {
        security: { enabled: true },
        style: { enabled: false },
        testing: {},
      },
    };
    expect(ids(payload, null, {})).toEqual(['security', 'testing']);
  });

  it('honors a personas: array from local .ct-review.yaml', () => {
    const localConfig = {
      file: '.ct-review.yaml',
      parsed: { personas: [{ id: 'security' }, { id: 'style', enabled: false }, { id: 'database' }] },
    };
    expect(ids({}, localConfig, {})).toEqual(['security', 'database']);
  });

  it('accepts a comma-separated ACTIVE_PERSONAS string', () => {
    expect(ids({}, null, { ACTIVE_PERSONAS: 'security, devops' })).toEqual(['security', 'devops']);
  });

  it('rejects unknown persona ids rather than silently reviewing nothing', () => {
    const r = resolvePersonaRoster({ activePersonas: ['security', 'astrology'] }, null, {});
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toContain('astrology');
  });

  it('treats reviewers.providers without personas as local CLI config and keeps the explicit action OpenRouter policy', () => {
    const localConfig = {
      file: '.ct-review.yaml',
      parsed: {
        limits: {
          max_diff_bytes: 12000,
        },
        reviewers: {
          providers: [
            { id: 'codex', enabled: true, model: 'gpt-5.6-sol-high', effort: 'high' },
            { id: 'grok', enabled: true, model: 'grok-4.5', effort: 'high' },
          ],
        },
      },
    };

    expect(ids({}, localConfig, {})).toEqual(defaultIds);

    expect(pipeline.resolveActionReviewRuntime(localConfig, {
      OPENROUTER_API_KEY: 'test-openrouter-key',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENROUTER_MODEL: 'openrouter/auto',
      MAX_DIFF_CHARS: '18000',
    })).toMatchObject({
      rosterSource: 'action_personas',
      localReviewerProviderIds: ['codex', 'grok'],
      modelConfig: {
        enabled: true,
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openrouter/auto',
        maxDiffChars: 12000,
      },
    });
  });
});

describe('Dispatch path: diff resolution never fabricates a diff', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env.PR_DIFF;
    delete process.env.PR_DIFF_FILE;
  });

  it('returns an empty diff when no diff source is available instead of a hardcoded sample', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-review-nodiff-'));
    process.chdir(tmp);
    delete process.env.PR_DIFF;
    const ctx = pipeline.getPRDiffAndContext();
    expect(ctx.diffText).toBe('');
  });

  it('reads large action diffs from a file boundary instead of an environment variable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-review-diff-file-'));
    const diffPath = path.join(tmp, 'review.diff');
    fs.writeFileSync(diffPath, 'diff --git a/src/large.ts b/src/large.ts\n+const value = 1;\n');
    process.env.PR_DIFF_FILE = diffPath;
    delete process.env.PR_DIFF;
    const ctx = pipeline.getPRDiffAndContext();
    expect(ctx.diffText).toContain('src/large.ts');
  });

  it('does not carry a hardcoded express sample diff in the source', () => {
    const source = fs.readFileSync(pipelinePath, 'utf-8');
    expect(source).not.toContain("app.get('/api/v1/user'");
  });
});

describe('Dispatch path: arbitration reports the real persona count', () => {
  const { computeArbitrationQuorum } = pipeline;

  it('reports quorum satisfied against the number of personas that actually ran', () => {
    const results = [
      { personaId: 'security', findings: [] },
      { personaId: 'devops', findings: [] },
    ];
    const arbitration = computeArbitrationQuorum(results, 2);
    expect(arbitration.quorumSatisfied).toBe(true);
    expect(arbitration.completedPersonas).toBe(2);
    expect(arbitration.totalPersonas).toBe(2);
  });

  it('reports degraded quorum when fewer personas completed than expected', () => {
    const results = [{ personaId: 'security', findings: [] }];
    const arbitration = computeArbitrationQuorum(results, 12);
    expect(arbitration.quorumSatisfied).toBe(false);
  });

  it('does not hardcode "12" in the rationale when fewer personas ran', () => {
    const results = [
      { personaId: 'security', findings: [] },
      { personaId: 'devops', findings: [] },
    ];
    const arbitration = computeArbitrationQuorum(results, 2);
    expect(arbitration.rationale).not.toContain('12');
    expect(arbitration.rationale).toContain('2');
  });

  it('fails closed when a provider lane returns ERROR instead of producing SHIP', () => {
    const arbitration = computeArbitrationQuorum([
      { personaId: 'security', decision: 'ERROR', findings: [], error: 'provider unavailable' },
      { personaId: 'testing', decision: 'APPROVE', findings: [] },
    ], 2);

    expect(arbitration.verdict).toBe('BLOCK');
    expect(arbitration.quorumSatisfied).toBe(false);
    expect(arbitration.rationale).toContain('provider failures');
  });
});

describe('Dispatch path: OpenRouter is the only model boundary', () => {
  it('does not treat a legacy provider key or base URL as a review provider', () => {
    expect(pipeline.resolveModelConfig({ LLM_API_KEY: 'legacy-key', LLM_BASE_URL: 'https://legacy.example' })).toMatchObject({
      enabled: false,
      baseUrl: 'https://openrouter.ai/api/v1',
    });
  });
});

describe('Dispatch path: GitHub CLI side effects use explicit boundaries', () => {
  it('runs gh pr comment with an explicit --repo and injected filesystem/clock', () => {
    const writes = new Map<string, string>();
    const commands: Array<{ executable: string; args: string[]; options: any }> = [];
    const fileSystem = {
      writeFileSync(filePath: string, body: string) {
        writes.set(filePath, body);
      },
      unlinkSync(filePath: string) {
        writes.delete(filePath);
      },
    };
    const commandRunner = (executable: string, args: string[], options: any) => {
      commands.push({ executable, args, options });
      if (args[0] === 'api') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = pipeline.postOrOutputComment('replayed body', {
      prNumber: '42',
      repo: 'calltelemetry/ct-review-bot',
      headSha: 'exact-head',
      baseSha: 'exact-base',
    }, {
      now: () => 1_700_000_000_000,
      tempDirectory: '/tmp',
      fileSystem,
      commandRunner,
    });

    expect(result).toEqual({ success: true, postedViaGh: true });
    expect(commands[0]).toMatchObject({
      executable: 'gh',
      args: ['api', 'repos/calltelemetry/ct-review-bot/issues/42/comments?per_page=100', '--paginate', '--jq', '.[] | [.id, .body] | @tsv'],
    });
    expect(commands[1]).toMatchObject({
      executable: 'gh',
      args: ['pr', 'comment', '42', '--body-file', '/tmp/review-comment-1700000000000.md', '--repo', 'calltelemetry/ct-review-bot'],
    });
    expect(writes.size).toBe(0);
  });

  it('does not publish a duplicate exact-head action comment', () => {
    const commands: string[][] = [];
    const commandRunner = (_executable: string, args: string[]) => {
      commands.push(args);
      if (args[0] === 'api') {
        return {
          status: 0,
          stdout: '<!-- ct-review-bot:v1:calltelemetry/ct-review-bot#42:exact-head:action -->',
          stderr: '',
        };
      }
      throw new Error('publish command must not run for a duplicate');
    };

    const result = pipeline.postOrOutputComment('replayed body', {
      prNumber: '42',
      repo: 'calltelemetry/ct-review-bot',
      headSha: 'exact-head',
    }, { commandRunner });

    expect(result).toMatchObject({ success: true, postedViaGh: true, deduplicated: true });
    expect(commands).toHaveLength(1);
  });

  it('updates the existing exact-head action comment on a later terminal rerun', () => {
    const commands: string[][] = [];
    const commandRunner = (_executable: string, args: string[]) => {
      commands.push(args);
      if (args[0] === 'api' && args[1].includes('/comments?')) {
        return {
          status: 0,
          stdout: '123\told BLOCK body <!-- ct-review-bot:v1:calltelemetry/ct-review-bot#42:exact-head:action -->',
          stderr: '',
        };
      }
      if (args[0] === 'api' && args[1].endsWith('/comments/123')) {
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error('unexpected publish command');
    };

    const result = pipeline.postOrOutputComment('new SHIP body', {
      prNumber: '42',
      repo: 'calltelemetry/ct-review-bot',
      headSha: 'exact-head',
    }, { commandRunner });

    expect(result).toMatchObject({ success: true, postedViaGh: true, updated: true });
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual([
      'api',
      'repos/calltelemetry/ct-review-bot/issues/comments/123',
      '--method',
      'PATCH',
      '--field',
      expect.stringContaining('body=new SHIP body'),
    ]);
  });

  it('fails closed when gh cannot publish a PR comment', () => {
    const writes = new Map<string, string>();
    const fileSystem = {
      writeFileSync(filePath: string, body: string) {
        writes.set(filePath, body);
      },
      unlinkSync(filePath: string) {
        writes.delete(filePath);
      },
    };

    const result = pipeline.postOrOutputComment('unpublished body', {
      prNumber: '42',
      repo: 'calltelemetry/ct-review-bot',
    }, {
      now: () => 1_700_000_000_000,
      tempDirectory: '/tmp',
      fileSystem,
      commandRunner: () => ({ status: 1, stdout: '', stderr: 'permission denied' }),
    });

    expect(result).toMatchObject({ success: false, postedViaGh: false });
    expect(result.error).toContain('permission denied');
    expect(writes.size).toBe(0);
  });

  it('binds the action review to the authoritative GitHub head SHA', () => {
    const commandRunner = () => ({
      status: 0,
      stdout: JSON.stringify({ headRefOid: 'exact-head', baseRefOid: 'exact-base' }),
      stderr: '',
    });
    expect(pipeline.assertCurrentPullRequest({
      prNumber: '42',
      repo: 'calltelemetry/ct-review-bot',
      headSha: 'exact-head',
      baseSha: 'exact-base',
    }, { commandRunner })).toEqual({ headRefOid: 'exact-head', baseRefOid: 'exact-base' });

    expect(() => pipeline.assertCurrentPullRequest({
      prNumber: '42',
      repo: 'calltelemetry/ct-review-bot',
      headSha: 'stale-head',
      baseSha: 'exact-base',
    }, { commandRunner })).toThrow('PR head changed during review');
  });

  it('bounds persona work without dropping results or changing their order', async () => {
    let active = 0;
    let maxActive = 0;

    const results = await pipeline.mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (value: number) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxActive).toBe(3);
  });

  it('defaults persona concurrency to three and rejects unsafe overrides', () => {
    expect(pipeline.resolvePersonaConcurrency()).toBe(3);
    expect(pipeline.resolvePersonaConcurrency('2')).toBe(2);
    expect(() => pipeline.resolvePersonaConcurrency('0')).toThrow('between 1 and 25');
    expect(() => pipeline.resolvePersonaConcurrency('many')).toThrow('between 1 and 25');
  });
});

describe('capacity-aware transport dispatch', () => {
  const transports = [
    { name: 'openrouter-primary', dispatchWeight: 3 },
    { name: 'synthetic', dispatchWeight: 1 },
    { name: 'gemini', dispatchWeight: 1 },
    { name: 'ollama', dispatchWeight: 1 },
  ];

  it('preserves the shared transport order in ordered mode', () => {
    const plans = pipeline.buildTransportDispatchPlans(3, transports, 'ordered', 'head-a');
    expect(plans).toHaveLength(3);
    expect(plans.every((plan: any[]) => plan.map((transport) => transport.name).join(',') ===
      'openrouter-primary,synthetic,gemini,ollama')).toBe(true);
  });

  it('stripes six persona lanes according to 3:1:1:1 weights without multiplying calls', () => {
    const plans = pipeline.buildTransportDispatchPlans(6, transports, 'striped', 'head-a');
    const counts = plans.map((plan: any[]) => plan[0].name)
      .reduce((result: Record<string, number>, name: string) => {
        result[name] = (result[name] || 0) + 1;
        return result;
      }, {});

    expect(plans).toHaveLength(6);
    expect(counts).toEqual({
      'openrouter-primary': 3,
      synthetic: 1,
      gemini: 1,
      ollama: 1,
    });
    expect(plans.every((plan: any[]) => new Set(plan.map((transport) => transport.name)).size === 4)).toBe(true);
  });

  it('is deterministic for an exact head while rotating the primary sequence across heads', () => {
    const first = pipeline.buildTransportDispatchPlans(6, transports, 'striped', 'head-a');
    const repeated = pipeline.buildTransportDispatchPlans(6, transports, 'striped', 'head-a');
    const changed = pipeline.buildTransportDispatchPlans(6, transports, 'striped', 'head-b');

    expect(repeated.map((plan: any[]) => plan[0].name)).toEqual(first.map((plan: any[]) => plan[0].name));
    expect(changed.map((plan: any[]) => plan[0].name)).not.toEqual(first.map((plan: any[]) => plan[0].name));
  });

  it('rejects unknown dispatch modes instead of silently changing routing', () => {
    expect(() => pipeline.buildTransportDispatchPlans(1, transports, 'equal-ish', 'head-a'))
      .toThrow('REVIEW_YETI_DISPATCH_MODE must be ordered or striped');
  });
});

describe('Dispatch path: workflow is runnable on stock GitHub infrastructure', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf-8');
  const action = fs.readFileSync(path.join(rootRepoDir, 'action.yml'), 'utf-8');

  it('does not depend on Blacksmith runners or actions', () => {
    expect(workflow).not.toContain('blacksmith-');
    expect(workflow).not.toContain('useblacksmith/');
  });

  it('delegates the review to this repository\'s own action, so runs exercise the published path', () => {
    expect(workflow).toContain('uses: ./');
  });

  it('forwards the resolved target repo and PR number to the action', () => {
    expect(workflow).toContain('client_payload.target_repo');
    expect(workflow).toContain('client_payload.pr_number');
  });

  it('supplies the PR diff and number to the pipeline explicitly via the action', () => {
    expect(action).toContain('PR_DIFF');
    expect(action).toContain('PR_NUMBER');
  });

  it('exposes trusted OpenRouter policy inputs and forwards them to the pipeline env', () => {
    expect(action).toContain('openrouter-allowed-models');
    expect(action).toContain('openrouter-cost-quality-tradeoff');
    expect(action).toContain('openrouter-data-collection');
    expect(action).toContain('OPENROUTER_ALLOWED_MODELS: ${{ inputs.openrouter-allowed-models }}');
    expect(action).toContain('OPENROUTER_COST_QUALITY_TRADEOFF: ${{ inputs.openrouter-cost-quality-tradeoff }}');
    expect(action).toContain('OPENROUTER_DATA_COLLECTION: ${{ inputs.openrouter-data-collection }}');
  });

  it('does not configure OmniRoute transport for action reviews', () => {
    expect(action).not.toMatch(/OMNI[_-]?ROUTE/i);
  });

  it('does not push commits back to the checked-out repository', () => {
    expect(workflow).not.toContain('git push');
  });

  it('uses only the role-scoped review fleet secret for hosted OpenRouter calls', () => {
    const deploymentWorkflows = [
      workflow,
      fs.readFileSync(path.join(rootRepoDir, '.github/workflows/ci-cd.yaml'), 'utf-8'),
      fs.readFileSync(path.join(rootRepoDir, '.github/workflows/deploy-jbjmllc.yaml'), 'utf-8'),
    ];

    deploymentWorkflows.forEach((source) => {
      expect(source).toContain('CT_REVIEW_OPENROUTER_API_KEY');
      expect(source).not.toContain('secrets.OPENROUTER_API_KEY');
    });
  });

  it('retains the redacted provider telemetry receipt as a workflow artifact', () => {
    expect(workflow).toContain('${{ steps.review.outputs.provider-telemetry-path }}');
  });

  it('bounds the required CI test job to the fifteen-minute review contract', () => {
    const ciWorkflow = fs.readFileSync(path.join(rootRepoDir, '.github/workflows/ci-cd.yaml'), 'utf-8');
    expect(ciWorkflow).toMatch(/jobs:\n  test:[\s\S]*?timeout-minutes: 15/u);
  });
});
