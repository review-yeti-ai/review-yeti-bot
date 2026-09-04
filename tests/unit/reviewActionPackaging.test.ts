import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import yaml from 'js-yaml';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const actionPath = path.join(rootRepoDir, 'action.yml');
const nodeVersionGuard = require(path.join(rootRepoDir, 'scripts/nodeVersionGuard.js'));
const { isBoundedDirectory } = require(path.join(rootRepoDir, 'scripts/boundedDirectoryGuard.js'));

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
    expect(inputs).toContain('review-engine');
    expect(inputs).toContain('action-sha');
    expect(inputs).toContain('execution-backend');
    expect(inputs).toContain('doks-dispatch-url');
    expect(inputs).toContain('doks-publish-mode');
    expect(inputs).toContain('ollama-api-key');
    expect(inputs).toContain('synthetic-api-key');
  });

  it('does not impose a fixed per-reviewer diff cap by default', () => {
    expect(action.inputs['max-diff-chars'].default).toBe('');
  });

  // REL-553: central (repository_dispatch) execution reads prior run reports from the executing
  // repository's own artifact store, not the reviewed repository's, and its parent runs trigger
  // on repository_dispatch rather than pull_request(_target). Both overrides default to the
  // narrower same-repo behavior so an existing consumer's behavior is unchanged.
  it('accepts central-execution overrides for the incremental-scope artifact repo and trusted parent events', () => {
    const inputs = Object.keys(action.inputs || {});
    expect(inputs).toContain('incremental-artifact-repo');
    expect(inputs).toContain('incremental-trusted-events');
    expect(action.inputs['incremental-artifact-repo'].default).toBe('');
    expect(action.inputs['incremental-trusted-events'].default).toBe('pull_request,pull_request_target');

    const raw = fs.readFileSync(actionPath, 'utf8');
    expect(raw).toContain('REVIEW_YETI_INCREMENTAL_ARTIFACT_REPO: ${{ inputs.incremental-artifact-repo }}');
    expect(raw).toContain('REVIEW_YETI_INCREMENTAL_TRUSTED_EVENTS: ${{ inputs.incremental-trusted-events }}');
  });

  it('keeps local execution as the default and makes DOKS an explicit OIDC dispatch', () => {
    expect(action.inputs['execution-backend'].default).toBe('local');
    expect(action.inputs['doks-publish-mode'].default).toBe('disabled');
    expect(action.inputs['doks-dispatch-url'].default).toBe('https://review-bot.calltelemetry.com/api/dispatch/action');

    const raw = fs.readFileSync(actionPath, 'utf8');
    const dispatcher = fs.readFileSync(path.join(rootRepoDir, 'scripts/dispatch-doks-action.mjs'), 'utf8');
    expect(raw).toContain('dispatch-doks-action.mjs');
    expect(dispatcher).toContain('ACTIONS_ID_TOKEN_REQUEST_URL');
    expect(dispatcher).toContain('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
    expect(raw).toContain("inputs.execution-backend == 'doks'");
    expect(raw).toContain("inputs.execution-backend != 'doks'");
  });

  it('does not expose provider credentials to the DOKS dispatch step', () => {
    const step = action.runs.steps.find((candidate: any) => candidate.name === 'Dispatch review to DOKS');
    expect(step).toBeTruthy();
    expect(JSON.stringify(step.env)).not.toMatch(/OPENROUTER|FIREWORKS|OLLAMA|ANTHROPIC|GEMINI|OPENAI_API_KEY/u);
    expect(step.env).not.toHaveProperty('GH_TOKEN');
    expect(step.env.DOKS_OIDC_AUDIENCE).toBe('review-yeti-doks-dispatch');
  });

  it('reports remote admission as pending rather than a green review', () => {
    expect(action.outputs['review-status'].value).toContain('steps.doks-dispatch.outputs.review-status');
    expect(action.outputs['gate-decision'].value).toContain('steps.doks-dispatch.outputs.gate-decision');
    expect(action.outputs['merge-eligible'].value).toContain('steps.doks-dispatch.outputs.merge-eligible');
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
    expect(outputs).toContain('gate-decision');
    expect(outputs).toContain('merge-eligible');
    expect(outputs).toContain('run-report-path');
    expect(outputs).toContain('provider-telemetry-digest');
    expect(outputs).toContain('provider-telemetry-path');
    expect(outputs).toContain('review-dispatch-reflection-status');
    expect(outputs).toContain('review-dispatch-provider-receipt-digest');
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

  it('installs the lock-backed legacy-runtime graph instead of the Action root', () => {
    const raw = fs.readFileSync(actionPath, 'utf-8');
    expect(raw).toContain('legacy-runtime');
    expect(raw).toContain('npm ci --prefix .');
    expect(raw).toContain('cd "$RUNTIME"');
    expect(raw).toContain('NODE_PATH=$RUNTIME/node_modules');
    expect(raw).not.toContain('--no-package-lock');
    expect(raw).not.toMatch(/npm install --prefix "\$GITHUB_ACTION_PATH" js-yaml/u);
  });
});

describe('Pi runtime packaging contract', () => {
  it('rejects unsafe installer directory boundaries and accepts a disposable nested path', () => {
    const root = path.parse(path.resolve(path.sep)).root;
    expect(isBoundedDirectory(root)).toBe(false);
    expect(isBoundedDirectory(os.homedir())).toBe(false);
    expect(isBoundedDirectory('')).toBe(false);
    expect(isBoundedDirectory('/a')).toBe(false);
    expect(isBoundedDirectory(path.join(root, '1234567'))).toBe(false);
    expect(isBoundedDirectory(path.join(root, '12345678'))).toBe(true);
    expect(isBoundedDirectory(null as any)).toBe(false);
    expect(isBoundedDirectory(42 as any)).toBe(false);
    expect(isBoundedDirectory({} as any)).toBe(false);
    expect(isBoundedDirectory(path.join(os.tmpdir(), 'review-yeti-pi-runtime-123'))).toBe(true);
  });

  it('tests the Pi Node boundary, including prerelease rejection', () => {
    expect(nodeVersionGuard.isSupportedNodeVersion('22.18.9')).toBe(false);
    expect(nodeVersionGuard.isSupportedNodeVersion('22.19.0')).toBe(true);
    expect(nodeVersionGuard.isSupportedNodeVersion('24.0.0')).toBe(true);
    expect(nodeVersionGuard.isSupportedNodeVersion('22.19.0-nightly.1')).toBe(false);
  });

  it('declares the pinned runtime roots as bundled dependencies', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(rootRepoDir, 'package.json'), 'utf8'));
    expect(manifest.bundledDependencies).toEqual([
      '@quintinshaw/pi-dynamic-workflows',
      '@earendil-works/pi-ai',
      '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-tui',
      'typebox',
    ]);
  });

  it('includes the pinned OpenRouter SDK in the lock-backed Pi runtime', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(rootRepoDir, 'pi-runtime/package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(rootRepoDir, 'pi-runtime/package-lock.json'), 'utf8'));
    expect(manifest.dependencies['@openrouter/sdk']).toBe('1.2.80');
    expect(lock.packages['node_modules/@openrouter/sdk'].version).toBe('1.2.80');
  });

  it('keeps legacy as the default and wires the Pi install branch to the Action path', () => {
    const action: any = yaml.load(fs.readFileSync(actionPath, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(rootRepoDir, 'package.json'), 'utf8'));
    expect(manifest.engines.node).toBe('>=24.0.0');
    expect(action.inputs['review-engine'].default).toBe('legacy');
    expect(action.inputs['review-engine'].description).toMatch(/Node 24/i);
    const raw = fs.readFileSync(actionPath, 'utf8');
    expect(raw).toContain('install-action-runtime.mjs');
    expect(raw).toContain('REVIEW_YETI_ACTION_SHA');
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
    expect(content).toContain('review-status=FIX_FIRST');
    expect(content).toContain('gate-decision=BLOCK');
    expect(content).toContain('merge-eligible=false');
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

  it('emits telemetry receipt outputs without changing the central gate outputs', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ct-out-')), 'out.txt');
    writeStepOutputs(arbitration, file, null, {
      digest: 'a'.repeat(64),
      path: '/tmp/review-yeti-run-report.json',
    }, {
      digest: 'b'.repeat(64),
      path: '/tmp/review-yeti-provider-telemetry.json',
    });
    const content = fs.readFileSync(file, 'utf-8');

    expect(content).toContain('provider-receipt-digest=' + 'a'.repeat(64));
    expect(content).toContain('run-report-path=/tmp/review-yeti-run-report.json');
    expect(content).toContain('provider-telemetry-digest=' + 'b'.repeat(64));
    expect(content).toContain('provider-telemetry-path=/tmp/review-yeti-provider-telemetry.json');
    expect(content).toContain('gate-decision=BLOCK');
    expect(content).toContain('merge-eligible=false');
  });

  it('writes an exact-head run report and receipt digest for the central gate', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-report-'));
    const report = pipeline.writeRunReport({
      verdict: 'SHIP',
      completedPersonas: 1,
      totalPersonas: 1,
      quorumSatisfied: true,
      metrics: { p0Count: 0, p1Count: 0, p2Count: 1, totalFindings: 1 },
    }, [{
      personaId: 'security',
      decision: 'FINDINGS',
      findings: [{ severity: 'P2', path: 'lib/a.ex', line: 1, title: 'Nit' }],
    }], {
      repo: 'calltelemetry/example',
      prNumber: '7',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    }, directory);

    expect(report.path).toContain(directory);
    expect(report.digest).toMatch(/^[0-9a-f]{64}$/);
    const payload = JSON.parse(fs.readFileSync(report.path, 'utf-8'));
    expect(payload).toMatchObject({
      schemaVersion: 'review-run-report-v1',
      repository: 'calltelemetry/example',
      prNumber: 7,
      verdict: 'SHIP',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    });
    expect(payload.lanes[0].severity).toEqual({ P0: 0, P1: 0, P2: 1 });
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
