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
});

describe('Pi runtime packaging contract', () => {
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

  it('keeps legacy as the default and wires the Pi install branch to the Action path', () => {
    const action: any = yaml.load(fs.readFileSync(actionPath, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(rootRepoDir, 'package.json'), 'utf8'));
    expect(manifest.engines.node).toBe('>=20.0.0');
    expect(action.inputs['review-engine'].default).toBe('legacy');
    expect(action.inputs['review-engine'].description).toMatch(/Node 24/i);
    const raw = fs.readFileSync(actionPath, 'utf8');
    expect(raw).toContain('install-action-runtime.mjs');
    expect(raw).toContain('REVIEW_YETI_ACTION_SHA');
  });
  it('packs from a clean exact commit and an empty consumer resolves and attests the nested Pi closure', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-clean-pack-'));
    const releaseDir = path.join(tempDir, 'release');
    const packDir = path.join(tempDir, 'pack');
    const consumerDir = path.join(tempDir, 'consumer');
    fs.cpSync(rootRepoDir, releaseDir, {
      recursive: true,
      filter(source) {
        const relative = path.relative(rootRepoDir, source);
        const top = relative.split(path.sep)[0];
        return !['.git', 'node_modules', 'dist'].includes(top);
      },
    });
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(consumerDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: releaseDir });
    execFileSync('git', ['config', 'user.name', 'Review Yeti Test'], { cwd: releaseDir });
    execFileSync('git', ['config', 'user.email', 'review-yeti-test@example.invalid'], { cwd: releaseDir });
    execFileSync('git', ['add', '--all'], { cwd: releaseDir });
    execFileSync('git', ['commit', '-q', '-m', 'clean release fixture'], { cwd: releaseDir });

    const npmEnvironment = { ...process.env, NPM_CONFIG_USERCONFIG: os.devNull } as Record<string, string | undefined>;
    for (const key of Object.keys(npmEnvironment)) {
      if (/^npm_config_allow_scripts(?:_pin)?$/iu.test(key)) delete npmEnvironment[key];
    }
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: releaseDir,
      env: npmEnvironment,
      stdio: 'pipe',
      timeout: 120_000,
    });
    expect(execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: releaseDir, encoding: 'utf8' })).toBe('');
    fs.writeFileSync(path.join(releaseDir, 'dirty-release-marker'), 'must reject');
    expect(() => execFileSync(process.execPath, ['scripts/stage-publish-package.mjs', '--prepare-current'], {
      cwd: releaseDir,
      env: npmEnvironment,
      stdio: 'pipe',
    })).toThrow(/exact clean release commit/i);
    fs.rmSync(path.join(releaseDir, 'dirty-release-marker'));
    execFileSync('git', ['checkout', '--detach', '--quiet', 'HEAD'], { cwd: releaseDir });
    expect(() => execFileSync(process.execPath, ['scripts/stage-publish-package.mjs', '--prepare-current'], {
      cwd: releaseDir,
      env: npmEnvironment,
      stdio: 'pipe',
    })).toThrow(/attached release branch/i);
    execFileSync('git', ['switch', '--quiet', '-c', 'release-fixture'], { cwd: releaseDir });
    const packed = execFileSync('npm', ['pack', '--pack-destination', packDir], {
      cwd: releaseDir,
      env: npmEnvironment,
      encoding: 'utf8',
      timeout: 120_000,
    }).trim().split('\n').at(-1);
    expect(packed).toMatch(/\.tgz$/u);
    const tarball = path.join(packDir, String(packed));
    fs.writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({ name: 'ordinary-consumer', private: true }, null, 2));
    execFileSync('npm', ['install', '--prefix', '.', tarball, '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: consumerDir,
      env: npmEnvironment,
      stdio: 'pipe',
      timeout: 120_000,
    });

    const packageName = JSON.parse(fs.readFileSync(path.join(rootRepoDir, 'package.json'), 'utf8')).name;
    const installedRoot = path.join(consumerDir, 'node_modules', packageName);
    const nestedRuntime = path.join(installedRoot, 'node_modules', '@quintinshaw', 'pi-dynamic-workflows');
    expect(fs.existsSync(path.join(nestedRuntime, 'package.json'))).toBe(true);
    const provenanceApi = require(path.join(installedRoot, 'src/provenance/buildProvenance.js'));
    const provenancePath = path.join(installedRoot, 'src/provenance/generated-build-provenance.json');
    const provenance = provenanceApi.loadBuildProvenance(provenancePath);
    expect(provenanceApi.verifyBuildProvenance({ packageRoot: installedRoot, provenance, requireNested: true }))
      .toEqual(expect.objectContaining({ runtimeGraphDigest: provenance.runtimeGraphDigest }));

    const actionPrefix = path.join(tempDir, 'action-prefix');
    execFileSync(process.execPath, [path.join(releaseDir, 'scripts/install-action-runtime.mjs')], {
      cwd: releaseDir,
      env: {
        ...npmEnvironment,
        GITHUB_ACTION_PATH: releaseDir,
        NPM_PREFIX: actionPrefix,
        REVIEW_YETI_ACTION_SHA: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: releaseDir, encoding: 'utf8' }).trim(),
      },
      stdio: 'pipe',
      timeout: 180_000,
    });
    const hostedProvenance = provenanceApi.loadBuildProvenance(path.join(releaseDir, 'src/provenance/generated-build-provenance.json'));
    expect(hostedProvenance.runtimeGraphDigest).toBe(provenance.runtimeGraphDigest);

    const transitive = provenance.packages.find((entry: any) => !entry.path.endsWith('/@quintinshaw/pi-dynamic-workflows')
      && !entry.path.endsWith('/@earendil-works/pi-ai')
      && !entry.path.endsWith('/@earendil-works/pi-coding-agent')
      && !entry.path.endsWith('/@earendil-works/pi-tui')
      && !entry.path.endsWith('/typebox'));
    expect(transitive).toBeTruthy();
    const transitivePath = path.join(installedRoot, transitive.path);
    const transitiveBackup = path.join(tempDir, 'transitive-backup');
    fs.cpSync(transitivePath, transitiveBackup, { recursive: true });
    const transitiveManifestPath = path.join(transitivePath, 'package.json');
    const transitiveManifest = JSON.parse(fs.readFileSync(transitiveManifestPath, 'utf8'));
    transitiveManifest.__tampered = true;
    fs.writeFileSync(transitiveManifestPath, `${JSON.stringify(transitiveManifest)}\n`);
    expect(() => provenanceApi.verifyBuildProvenance({ packageRoot: installedRoot, provenance, requireNested: true }))
      .toThrow(/runtime graph/i);

    fs.rmSync(transitivePath, { recursive: true, force: true });
    expect(() => provenanceApi.verifyBuildProvenance({ packageRoot: installedRoot, provenance, requireNested: true }))
      .toThrow(/missing|nested bundle|runtime graph/i);
    fs.cpSync(transitiveBackup, transitivePath, { recursive: true });

    fs.rmSync(transitivePath, { recursive: true, force: true });
    fs.mkdirSync(transitivePath, { recursive: true });
    fs.writeFileSync(path.join(transitivePath, 'package.json'), JSON.stringify({ name: 'substituted-runtime', version: '0.0.0' }));
    expect(() => provenanceApi.verifyBuildProvenance({ packageRoot: installedRoot, provenance, requireNested: true }))
      .toThrow(/runtime graph|mismatch/i);
    fs.rmSync(transitivePath, { recursive: true, force: true });
    fs.cpSync(transitiveBackup, transitivePath, { recursive: true });

    fs.renameSync(transitivePath, path.join(tempDir, 'hoisted-transitive'));
    expect(() => provenanceApi.verifyBuildProvenance({ packageRoot: installedRoot, provenance, requireNested: true }))
      .toThrow(/missing|nested bundle|runtime graph/i);
  }, 360_000);
});

  it('installs the lock-backed Pi runtime from an empty bounded prefix', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-pi-action-install-'));
    const actionDir = path.join(tempDir, 'action');
    const prefixDir = path.join(tempDir, 'prefix');
    fs.mkdirSync(actionDir, { recursive: true });
    for (const directory of ['src/pi', 'src/provenance']) {
      fs.cpSync(path.join(rootRepoDir, directory), path.join(actionDir, directory), { recursive: true });
    }
    for (const relative of ['package.json', 'package-lock.json', 'scripts/install-action-runtime.mjs', 'scripts/generate-build-provenance.mjs']) {
      const destination = path.join(actionDir, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(rootRepoDir, relative), destination);
    }
    const output = execFileSync(process.execPath, [path.join(actionDir, 'scripts/install-action-runtime.mjs')], {
      cwd: tempDir,
      env: { ...process.env, GITHUB_ACTION_PATH: actionDir, NPM_PREFIX: prefixDir, REVIEW_YETI_ACTION_SHA: 'e'.repeat(40) },
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(output).toContain('Pi workflow runtime ok 3.7.0');
    expect(fs.existsSync(path.join(actionDir, 'src/provenance/generated-build-provenance.json'))).toBe(true);
  }, 130_000);
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
