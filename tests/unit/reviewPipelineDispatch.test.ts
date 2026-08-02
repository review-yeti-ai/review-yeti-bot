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

  it('defaults to the default reviewer set when nothing is configured', () => {
    expect(ids({}, null, {})).toEqual(defaultIds);
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
        quality: { enabled: false },
        reliability: {},
      },
    };
    expect(ids(payload, null, {})).toEqual(['security', 'reliability']);
  });

  it('honors a personas: array from local .ct-review.yaml', () => {
    const localConfig = {
      file: '.ct-review.yaml',
      parsed: { personas: [{ id: 'security' }, { id: 'quality', enabled: false }, { id: 'database' }] },
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
});

describe('Dispatch path: diff resolution never fabricates a diff', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env.PR_DIFF;
  });

  it('returns an empty diff when no diff source is available instead of a hardcoded sample', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-review-nodiff-'));
    process.chdir(tmp);
    delete process.env.PR_DIFF;
    const ctx = pipeline.getPRDiffAndContext();
    expect(ctx.diffText).toBe('');
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
    }, {
      now: () => 1_700_000_000_000,
      tempDirectory: '/tmp',
      fileSystem,
      commandRunner,
    });

    expect(result).toEqual({ success: true, postedViaGh: true });
    expect(commands[0]).toMatchObject({
      executable: 'gh',
      args: ['api', 'repos/calltelemetry/ct-review-bot/issues/42/comments?per_page=100', '--paginate', '--jq', '.[].body'],
    });
    expect(commands[1]).toMatchObject({
      executable: 'gh',
      args: ['pr', 'comment', '42', '--body-file', '/tmp/review-comment-1700000000000.md', '--repo', 'calltelemetry/ct-review-bot'],
    });
    expect(writes).toHaveLength(0);
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
    expect(writes).toHaveLength(0);
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
    }, { commandRunner })).toEqual({ headRefOid: 'exact-head', baseRefOid: 'exact-base' });

    expect(() => pipeline.assertCurrentPullRequest({
      prNumber: '42',
      repo: 'calltelemetry/ct-review-bot',
      headSha: 'stale-head',
    }, { commandRunner })).toThrow('PR head changed during review');
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

  it('does not push commits back to the checked-out repository', () => {
    expect(workflow).not.toContain('git push');
  });
});
