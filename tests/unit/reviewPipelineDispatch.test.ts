import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipelinePath = path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js');
const pipeline = require(pipelinePath);

const workflowPath = path.join(rootRepoDir, '.github/workflows/review-bot-blacksmith.yaml');

describe('Dispatch path: persona resolution defaults', () => {
  const { resolveActivePersonas, PERSONA_CHARTERS } = pipeline;
  const allIds = PERSONA_CHARTERS.map((p: any) => p.id);

  it('defaults to all 12 personas when nothing is configured', () => {
    expect(resolveActivePersonas({}, null, {})).toEqual(allIds);
  });

  it('defaults to all 12 personas when ACTIVE_PERSONAS is the literal string "null"', () => {
    // GitHub Actions renders toJson(<missing>) as the string "null" on pull_request events.
    expect(resolveActivePersonas({}, null, { ACTIVE_PERSONAS: 'null' })).toEqual(allIds);
  });

  it('defaults to all 12 personas when ACTIVE_PERSONAS is empty or whitespace', () => {
    expect(resolveActivePersonas({}, null, { ACTIVE_PERSONAS: '' })).toEqual(allIds);
    expect(resolveActivePersonas({}, null, { ACTIVE_PERSONAS: '   ' })).toEqual(allIds);
  });

  it('honors an explicit activePersonas array from the dispatch client_payload', () => {
    const payload = { activePersonas: ['security', 'devops'] };
    expect(resolveActivePersonas(payload, null, {})).toEqual(['security', 'devops']);
  });

  it('honors an explicit empty activePersonas array as a real opt-out', () => {
    expect(resolveActivePersonas({ activePersonas: [] }, null, {})).toEqual([]);
  });

  it('honors personaSettings toggles from the dispatch client_payload', () => {
    const payload = {
      personaSettings: {
        security: { enabled: true },
        style: { enabled: false },
        testing: {},
      },
    };
    expect(resolveActivePersonas(payload, null, {})).toEqual(['security', 'testing']);
  });

  it('honors a personas: array from local .ct-review.yaml', () => {
    const localConfig = {
      file: '.ct-review.yaml',
      parsed: { personas: [{ id: 'security' }, { id: 'style', enabled: false }, { id: 'database' }] },
    };
    expect(resolveActivePersonas({}, localConfig, {})).toEqual(['security', 'database']);
  });

  it('accepts a comma-separated ACTIVE_PERSONAS string', () => {
    expect(resolveActivePersonas({}, null, { ACTIVE_PERSONAS: 'security, devops' })).toEqual(['security', 'devops']);
  });

  it('ignores unknown persona ids rather than silently reviewing nothing', () => {
    expect(resolveActivePersonas({ activePersonas: ['security', 'astrology'] }, null, {})).toEqual(['security']);
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
});

describe('Dispatch path: workflow is runnable on stock GitHub infrastructure', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf-8');

  it('does not depend on Blacksmith runners or actions', () => {
    expect(workflow).not.toContain('blacksmith-');
    expect(workflow).not.toContain('useblacksmith/');
  });

  it('supplies the PR diff to the pipeline explicitly', () => {
    expect(workflow).toContain('PR_DIFF');
  });

  it('supplies the PR number to the pipeline explicitly', () => {
    expect(workflow).toContain('PR_NUMBER');
  });

  it('does not push commits back to the checked-out repository', () => {
    expect(workflow).not.toContain('git push');
  });
});
