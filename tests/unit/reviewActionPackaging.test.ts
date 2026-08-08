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
const configurationReference = fs.readFileSync(path.join(rootRepoDir, 'docs/CONFIGURATION_REFERENCE.md'), 'utf-8');
const publicationPolicy = fs.readFileSync(path.join(rootRepoDir, 'docs/PUBLICATION_POLICY.md'), 'utf-8');
const readme = fs.readFileSync(path.join(rootRepoDir, 'README.md'), 'utf-8');
const centralReviewWorkflow: any = yaml.load(fs.readFileSync(path.join(rootRepoDir, '.github/workflows/review-bot.yaml'), 'utf-8'));
const reviewConfig: any = yaml.load(fs.readFileSync(path.join(rootRepoDir, '.review-yeti.yaml'), 'utf-8'));

const documentationContracts = [
  ['CONFIGURATION_REFERENCE.md', configurationReference],
  ['README.md', readme],
] as const;

const outputContractRows = [
  ['verdict', 'SHIP, FIX_FIRST, BLOCK, or NO_VERDICT when the review cannot complete safely. Legacy NO_REVIEWABLE_FILES is no longer emitted for policy exclusions; migrate consumers to SHIP plus coverage outputs.'],
  ['review-status', 'Terminal review status: SHIP, FIX_FIRST, BLOCK, PARTIAL_REVIEW, or INCOMPLETE_REVIEW. Expected policy exclusions do not create a coverage gap; partial and incomplete review statuses are never merge-eligible.'],
  ['coverage-status', 'Coverage state: complete, partial, or incomplete. Partial and incomplete are never merge-eligible.'],
  ['gate-decision', 'Derived gate decision: PASS only for a complete clean review; otherwise BLOCKED.'],
  ['merge-eligible', 'Derived merge eligibility. True only for complete SHIP with a passing gate and no P0/P1 findings.'],
  ['files-skipped-generated', 'Changed files skipped by the built-in generated-file catalog or configured repository path-policy/exclude globs. Intentional, and not a coverage gap.'],
  ['files-oversized', 'Changed files whose complete per-file diff exceeded the configured limit. Excluded before model input and noted in the review comment; non-blocking by itself, while other coverage gaps can still produce INCOMPLETE_REVIEW.'],
] as const;

describe('action.yml — installable GitHub Action contract', () => {
  it('exists at the repository root so `uses: OWNER/REPO@ref` resolves', () => {
    expect(fs.existsSync(actionPath)).toBe(true);
  });

  const action: any = fs.existsSync(actionPath) ? yaml.load(fs.readFileSync(actionPath, 'utf-8')) : {};

  it('declares a name, description and branding for Marketplace listing', () => {
    expect(action.name).toBeTruthy();
    expect(action.description).toBeTruthy();
    expect(action.description).toContain('resolvable inline P0/P1 conversations');
    expect(action.description).not.toContain('consolidated comment');
    expect(action.branding?.icon).toBeTruthy();
    expect(action.branding?.color).toBeTruthy();
  });

  it('runs as a composite action', () => {
    expect(action.runs?.using).toBe('composite');
    expect(Array.isArray(action.runs?.steps)).toBe(true);
  });

  it('accepts the inputs a consumer needs to configure a review', () => {
    const inputs = Object.keys(action.inputs || {});
    expect(inputs).toContain('llm-api-key');
    expect(inputs).toContain('context7-api-key');
    expect(inputs).toContain('llm-base-url');
    expect(inputs).toContain('model');
    expect(inputs).toContain('openrouter-fallback-models');
    expect(inputs).toContain('openrouter-timeout-ms');
    expect(inputs).toContain('openrouter-stream');
    expect(inputs).toContain('personas');
    expect(inputs).toContain('max-diff-chars');
    expect(inputs).toContain('max-file-diff-chars');
    expect(inputs).toContain('github-token');
  });

  it('leaves the per-file input empty by default and distinguishes it from the whole-request budget', () => {
    expect(action.inputs['max-file-diff-chars'].default).toBe('');
    expect(action.inputs['max-file-diff-chars'].description).toMatch(/per-file/i);
    expect(action.inputs['max-file-diff-chars'].description).not.toBe(action.inputs['max-diff-chars'].description);
  });

  it('keeps the trusted primary model distinct from its configured fallback', () => {
    const openrouter = reviewConfig.github_action.openrouter;
    expect(openrouter.model).not.toBe(openrouter.fallback_models[0]);
    expect(action.inputs.model.default).toBe('openrouter/auto-beta');
    const executeStep = (centralReviewWorkflow.jobs.review.steps || [])
      .find((step: any) => step.name === 'Execute AI Review Panel');
    expect(executeStep.with.model).toContain('openrouter/auto-beta');
    expect(executeStep.with['openrouter-fallback-models'])
      .toContain('deepseek/deepseek-v4-flash-0731');
  });


  it('defaults github-token to the caller workflow token so no PAT is required', () => {
    expect(action.inputs['github-token'].default).toContain('github.token');
  });

  it('does not require an API key, so the action installs before a key is provisioned', () => {
    expect(action.inputs['llm-api-key'].required).not.toBe(true);
  });

  it('exposes verdict and finding counts as outputs so callers can gate on them', () => {
    const outputs = Object.keys(action.outputs || {});
    expect(outputs).toContain('verdict');
    expect(outputs).toContain('findings-count');
    expect(outputs).toContain('files-oversized');
    expect(action.outputs['files-oversized'].description).toMatch(/per-file/i);
  });

  it('publishes exact terminal and coverage output names and descriptions', () => {
    for (const [name, description] of outputContractRows) {
      expect(Object.keys(action.outputs || {})).toContain(name);
      expect(action.outputs[name].description).toBe(description);
    }
  });

  it('exports the distinct per-file input into the review pipeline environment', () => {
    const reviewStep = (action.runs.steps || []).find((step: any) => step.id === 'review');
    expect(reviewStep?.env?.MAX_FILE_DIFF_CHARS).toBe('${{ inputs.max-file-diff-chars }}');
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

  it('verifies js-yaml from the action path instead of the consumer workspace', () => {
    const installStep = action.runs.steps.find((step: any) => step.name === 'Install pipeline dependencies');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-action-install-'));
    const consumerDir = path.join(tempDir, 'consumer');
    const actionDir = path.join(tempDir, 'action');
    const prefixDir = path.join(tempDir, 'prefix');
    const moduleDir = path.join(prefixDir, 'node_modules', 'js-yaml');
    fs.mkdirSync(consumerDir, { recursive: true });
    fs.mkdirSync(actionDir, { recursive: true });
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'index.js'), 'module.exports = { load() {} };\n');
    fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name: 'js-yaml', version: '4.1.0', main: 'index.js' }));

    const output = execFileSync('bash', ['-c', installStep.run], {
      cwd: consumerDir,
      env: { ...process.env, GITHUB_ACTION_PATH: actionDir, NPM_PREFIX: prefixDir },
      encoding: 'utf8',
    });

    expect(output).toContain('js-yaml ok 4.1.0');
    expect(fs.existsSync(path.join(actionDir, 'node_modules', 'js-yaml', 'index.js'))).toBe(true);
  });
});

describe('review ignore policy documentation contract', () => {
  it('ships and documents authenticated same-PR decision memory', () => {
    expect(fs.existsSync(path.join(rootRepoDir, 'src/review/decisionLedger.js'))).toBe(true);
    for (const document of [readme, configurationReference, publicationPolicy]) {
      expect(document).toContain('/review-yeti ignore');
      expect(document).toContain('/review-yeti unignore');
      expect(document).toMatch(/same-PR|same pull request/i);
      expect(document).toMatch(/`write`/i);
      expect(document).toMatch(/`maintain`/i);
      expect(document).toMatch(/`admin`/i);
      expect(document).toMatch(/resolution (?:has|with) unknown intent|unknown intent.*resolution/i);
    }
  });

  it.each([
    ['README.md', readme],
  ] as const)('%s uses an explicit no-synchronize default workflow example', (_name, document) => {
    const example = document.match(/```yaml\s+# \.github\/workflows\/review\.yml[\s\S]*?```/)?.[0] || '';
    expect(example).toContain('types: [opened, reopened]');
    expect(example).not.toMatch(/types:.*synchronize/i);
    expect(document).toMatch(/Add\s+`synchronize`\s+only as an\s+explicit opt-in/i);
  });

  it('keeps the central repository self-review workflow on the same no-synchronize default', () => {
    expect(centralReviewWorkflow.on.pull_request.types).toEqual(['opened', 'reopened']);
  });

  it.each(documentationContracts)('%s documents the per-file limit and override precedence', (_name, document) => {
    expect(document).toContain('limits.max_file_diff_chars');
    expect(document).toContain('max-file-diff-chars');
    expect(document).toContain('5,000');

    const precedenceMarkers = [
      '1. `max-file-diff-chars` Action input',
      '2. `limits.max_file_diff_chars` repository value',
      '3. built-in default of **5,000**',
    ];
    const markerPositions = precedenceMarkers.map((marker) => document.indexOf(marker));
    expect(markerPositions.every((position) => position >= 0)).toBe(true);
    expect(markerPositions[0]).toBeLessThan(markerPositions[1]);
    expect(markerPositions[1]).toBeLessThan(markerPositions[2]);
  });

  it.each(documentationContracts)('%s documents the curated catalog and glob restoration rules', (_name, document) => {
    for (const category of [
      /lockfiles?/i,
      /snapshots?/i,
      /generated files?/i,
      /build output/i,
      /dependency caches?/i,
      /minified assets?/i,
      /source maps?/i,
      /binary files?/i,
    ]) {
      expect(document).toMatch(category);
    }
    expect(document).toMatch(/filename-only.*any depth|any depth.*filename-only/i);
    expect(document).toMatch(/`!`.*restores|!.*restores/i);
    expect(document).toContain('`openapi.generated.json`');
    expect(document).toContain('`schema.generated.yaml`');
    expect(document).toContain('`openapi.yaml`');
    expect(document).toMatch(/ordinary source[\s\S]*not excluded|not excluded[\s\S]*ordinary source/i);
  });

  it('documents the complete shared lockfile catalog in CONFIGURATION_REFERENCE.md', () => {
    for (const lockfile of [
      'Cargo.lock',
      'go.sum',
      'poetry.lock',
      'Pipfile.lock',
      'composer.lock',
      'npm-shrinkwrap.json',
      'bun.lockb',
      'packages.lock.json',
    ]) {
      expect(configurationReference).toContain(`\`${lockfile}\``);
    }
  });

  it.each(documentationContracts)('%s distinguishes expected policy exclusions from real incomplete coverage', (_name, document) => {
    expect(document).toMatch(/(?:deliberate|intentional)/i);
    expect(document).toMatch(/skip|skipped/i);
    expect(document).toMatch(/oversized/i);
    expect(document).toMatch(/incomplete[\s\S]*coverage|coverage[\s\S]*incomplete|coverage gap|unreviewed/i);
    expect(document).toMatch(/non-blocking|does not block|expected policy/i);
    expect(document).toMatch(/restored[\s\S]*per-file[\s\S]*(?:limit|cap)|(?:limit|cap)[\s\S]*restored/i);
  });

  it.each(documentationContracts)('%s documents exact terminal and coverage output contracts', (_name, document) => {
    expect(document).toMatch(/NO_REVIEWABLE_FILES[\s\S]*(?:no longer emitted|migrat)/i);
    expect(document).toContain('`INCOMPLETE_REVIEW`');
    for (const [name, description] of outputContractRows) {
      expect(document).toContain(`| \`${name}\` | ${description} |`);
    }
  });

  it('publishes the default durable coverage policy in trusted-base configuration', () => {
    expect(reviewConfig.coverage_policy).toEqual({
      quorum: 'two_thirds',
      min_personas: 3,
      mandatory_personas: ['security'],
      provider_diversity_min: 2,
    });
  });

  it.each([
    ['.review-yeti.yaml', fs.readFileSync(path.join(rootRepoDir, '.review-yeti.yaml'), 'utf-8')],
    ['README.md', readme],
    ['CONFIGURATION_REFERENCE.md', configurationReference],
    ['PUBLICATION_POLICY.md', publicationPolicy],
  ] as const)('%s documents the complete, partial, and incomplete gate mapping', (_name, document) => {
    expect(document).toContain('coverage_policy');
    expect(document).toContain('two_thirds');
    expect(document).toContain('mandatory_personas');
    expect(document).toContain('provider_diversity_min');
    expect(document).toContain('PARTIAL_REVIEW');
    expect(document).toContain('BLOCKED');
    expect(document).toMatch(/complete[\s\S]*partial[\s\S]*incomplete/i);
  });

  it('documents that durable publication and review success are separate outcomes', () => {
    expect(publicationPolicy).toMatch(/publication success.*review outcome success|review outcome success.*publication success/i);
    expect(publicationPolicy).toMatch(/failed|partial/i);
    expect(publicationPolicy).toMatch(/findings[\s\S]*evidence|evidence[\s\S]*findings/i);
    expect(publicationPolicy).toMatch(/never.*merge|non-mergeable/i);
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

  it('writes derived coverage and gate outputs without treating partial review as mergeable', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-out-')), 'out.txt');
    writeStepOutputs({
      ...arbitration,
      status: 'PARTIAL_REVIEW',
      coverageStatus: 'partial',
      gateDecision: 'BLOCKED',
      mergeEligible: false,
    }, file);
    const content = fs.readFileSync(file, 'utf-8');

    expect(content).toContain('review-status=PARTIAL_REVIEW');
    expect(content).toContain('coverage-status=partial');
    expect(content).toContain('gate-decision=BLOCKED');
    expect(content).toContain('merge-eligible=false');
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
