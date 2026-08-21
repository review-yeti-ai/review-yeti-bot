import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import yaml from 'js-yaml';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const actionPath = path.join(rootRepoDir, 'action.yml');

describe('action.yml — installable GitHub Action contract', () => {
  it('exists at the repository root so `uses: OWNER/REPO@ref` resolves', () => {
    expect(fs.existsSync(actionPath)).toBe(true);
  });

  const action: any = fs.existsSync(actionPath) ? yaml.load(fs.readFileSync(actionPath, 'utf-8')) : {};

  it('declares a name, description and branding for Marketplace listing', () => {
    expect(action.name).toBeTruthy();
    expect(action.description).toBeTruthy();
    expect(action.branding?.icon).toBeTruthy();
    expect(action.branding?.color).toBeTruthy();
  });

  it('runs as a composite action', () => {
    expect(action.runs?.using).toBe('composite');
    expect(Array.isArray(action.runs?.steps)).toBe(true);
  });

  it('accepts the inputs a consumer needs to configure a review', () => {
    const inputs = Object.keys(action.inputs || {});
    expect(inputs).toContain('api-key');
    expect(inputs).toContain('llm-api-key');
    expect(inputs).toContain('llm-base-url');
    expect(inputs).toContain('model');
    expect(inputs).toContain('personas');
    expect(inputs).toContain('max-diff-chars');
    expect(inputs).toContain('github-token');
  });

  it('defaults github-token to the caller workflow token so no PAT is required', () => {
    expect(action.inputs['github-token'].default).toContain('github.token');
  });

  it('does not require an API key, so the action installs before a key is provisioned', () => {
    expect(action.inputs['llm-api-key'].required).not.toBe(true);
    expect(action.inputs['api-key'].required).not.toBe(true);
  });

  it('exposes verdict and finding counts as outputs so callers can gate on them', () => {
    const outputs = Object.keys(action.outputs || {});
    expect(outputs).toContain('verdict');
    expect(outputs).toContain('findings-count');
  });

  it('resolves the pipeline through GITHUB_ACTION_PATH, not the consumer workspace', () => {
    const raw = fs.readFileSync(actionPath, 'utf-8');
    expect(raw).toContain('GITHUB_ACTION_PATH');
  });

  it('installs its own dependencies outside the consumer workspace', () => {
    const raw = fs.readFileSync(actionPath, 'utf-8');
    // --prefix keeps node_modules out of the checked-out repository being reviewed.
    expect(raw).toContain('--prefix');
  });
});

describe('writeStepOutputs', () => {
  const { writeStepOutputs } = pipeline;

  const arbitration = {
    verdict: 'FIX_FIRST',
    completedPersonas: 3,
    totalPersonas: 12,
    metrics: { p0Count: 1, p1Count: 2, p2Count: 4, totalFindings: 7 },
  };

  it('writes GitHub Actions key=value output pairs', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ct-out-')), 'out.txt');
    writeStepOutputs(arbitration, file);
    const content = fs.readFileSync(file, 'utf-8');

    expect(content).toContain('verdict=FIX_FIRST');
    expect(content).toContain('findings-count=7');
    expect(content).toContain('p0-count=1');
    expect(content).toContain('personas-completed=3');
  });

  it('appends rather than truncating, since GITHUB_OUTPUT is shared across steps', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ct-out-')), 'out.txt');
    fs.writeFileSync(file, 'existing=value\n');
    writeStepOutputs(arbitration, file);
    expect(fs.readFileSync(file, 'utf-8')).toContain('existing=value');
  });

  it('is a no-op when no output path is provided, so local runs do not throw', () => {
    expect(() => writeStepOutputs(arbitration, undefined)).not.toThrow();
  });
});

describe('writeStepSummary and emitWorkflowAnnotations', () => {
  const { writeStepSummary, emitWorkflowAnnotations } = pipeline;

  const arbitration = {
    verdict: 'SHIP',
    completedPersonas: 5,
    totalPersonas: 5,
    quorumSatisfied: true,
    rationale: 'Clean diff with zero defects.',
    metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
  };

  it('writes executive markdown summary table to GITHUB_STEP_SUMMARY', () => {
    const tempSummaryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ct-summary-')), 'summary.md');
    process.env.GITHUB_STEP_SUMMARY = tempSummaryFile;

    writeStepSummary(arbitration, [], { repo: 'calltelemetry/cisco-cdr' }, { reviewed: ['lib/auth.ex'] });
    const content = fs.readFileSync(tempSummaryFile, 'utf-8');

    expect(content).toContain('### 🏔️ Review Yeti Executive Summary');
    expect(content).toContain('🟢 SHIP');
    expect(content).toContain('100% (1 files audited)');
    expect(content).toContain('Satisfied');

    delete process.env.GITHUB_STEP_SUMMARY;
  });

  it('emits workflow command annotations for P0 and P1 findings', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    const mockLanes = [{
      personaId: 'security',
      displayName: '🛡️ Security',
      findings: [
        { severity: 'P0', path: 'lib/auth.ex', line: 42, title: 'SQL Injection', body: 'Unsafe SQL parameter' },
        { severity: 'P2', path: 'lib/style.ex', line: 10, title: 'Unused Variable', body: 'Variable x is not used' },
      ],
    }];

    emitWorkflowAnnotations(mockLanes);
    console.log = origLog;

    expect(logs.some((l) => l.includes('::error file=lib/auth.ex,line=42,title=SQL Injection::Unsafe SQL parameter'))).toBe(true);
    expect(logs.some((l) => l.includes('::warning file=lib/style.ex,line=10,title=Unused Variable::Variable x is not used'))).toBe(true);
  });
});
