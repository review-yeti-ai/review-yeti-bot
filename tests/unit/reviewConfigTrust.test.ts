import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const actionPath = path.join(rootRepoDir, 'action.yml');

const { resolveConfigRoot, loadLocalRepoConfig, loadPersonaFiles, resolvePersonaRoster, resolveTrustedReviewUnitsPolicy, buildReviewUnitManifest } = pipeline;

describe('review-unit manifests require exact trusted-base policy', () => {
  const prContext = { repo: 'owner/repo', prNumber: 7, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), diffText: 'diff --git a/a b/a' };

  it('stays disabled by default and cannot be enabled from an untrusted directory', () => {
    expect(resolveTrustedReviewUnitsPolicy({ localConfig: { parsed: {} }, prContext, env: {}, commandRunner: () => ({ status: 0, stdout: JSON.stringify({ baseRefOid: prContext.baseSha, headRefOid: prContext.headSha }) }) })).toMatchObject({ enabled: false, status: 'disabled_not_configured' });
    expect(resolveTrustedReviewUnitsPolicy({
      localConfig: { raw: 'review:\n  units:\n    enabled: true\n', parsed: { review: { units: { enabled: true } } } },
      prContext,
      env: {},
      commandRunner: () => ({ status: 0, stdout: JSON.stringify({ baseRefOid: prContext.baseSha, headRefOid: prContext.headSha }) }),
    })).toMatchObject({ enabled: false, status: 'disabled_untrusted_config' });
  });

  it('accepts only the trusted base configuration and hashes its exact policy', () => {
    const trusted = '/tmp/review-units-trusted';
    const commandRunner = () => ({ status: 0, stdout: JSON.stringify({ baseRefOid: prContext.baseSha, headRefOid: prContext.headSha }) });
    const policy = resolveTrustedReviewUnitsPolicy({
      localConfig: { raw: 'review:\n  units:\n    enabled: true\n', parsed: { exclude: ['generated/**'], review: { units: { enabled: true, allow_waived: true } }, limits: { max_file_diff_chars: 99 } } },
      prContext,
      env: { REVIEW_YETI_CONFIG_DIR: trusted, REVIEW_YETI_TRUSTED_CONFIG_DIR: trusted, REVIEW_YETI_TRUSTED_CONFIG_BASE_SHA: prContext.baseSha },
      commandRunner,
    });

    expect(policy).toMatchObject({ enabled: true, status: 'trusted', trustedBaseRef: prContext.baseSha, maxFileDiffChars: 99, allowWaived: true });
    expect(policy.policyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(policy.rules.exclude).toEqual(['generated/**']);
  });
});

describe('review-unit coverage integration', () => {
  const policy: any = {
    enabled: true,
    configDigest: 'c'.repeat(64),
    policyDigest: 'd'.repeat(64),
    rules: { maxFileDiffChars: 100 },
  };
  const prContext: any = { repo: 'owner/repo', prNumber: 9, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), diffText: 'exact diff' };

  it('uses deterministic units for coverage and fails closed on omitted eligible paths', () => {
    const manifest = buildReviewUnitManifest(policy, prContext, [
      { path: 'src/reviewed.js', patch: '+ok' },
      { path: 'src/omitted.js', patch: '+later' },
      { path: 'generated/schema.generated.json', patch: '+{}' },
    ], { reviewed: ['src/reviewed.js'], omitted: ['src/omitted.js'], truncated: [], providerFailures: [] });

    expect(manifest.units.map((unit: any) => [unit.path, unit.status])).toEqual([
      ['src/reviewed.js', 'completed'],
      ['src/omitted.js', 'failed'],
      ['generated/schema.generated.json', 'excluded'],
    ]);
    expect(manifest.coverage).toMatchObject({ complete: false, shipEligible: false, uncoveredPaths: ['src/omitted.js'] });
  });
});

describe('Configuration is read from an explicit trusted root', () => {
  const originalCwd = process.cwd();
  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env.REVIEW_YETI_CONFIG_DIR;
  });

  it('uses REVIEW_YETI_CONFIG_DIR when provided', () => {
    expect(resolveConfigRoot({ REVIEW_YETI_CONFIG_DIR: '/tmp/trusted' })).toBe('/tmp/trusted');
  });

  it('falls back to the working directory when unset, for local runs', () => {
    expect(resolveConfigRoot({})).toBe(process.cwd());
  });

  it('reads .review-yeti.yaml from the supplied root rather than the working directory', () => {
    const trusted = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-trusted-'));
    const untrusted = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-untrusted-'));
    fs.writeFileSync(path.join(trusted, '.review-yeti.yaml'), 'personas:\n  - id: security\n');
    fs.writeFileSync(path.join(untrusted, '.review-yeti.yaml'), 'personas:\n  - id: testing\n');

    process.chdir(untrusted);
    const cfg = loadLocalRepoConfig(trusted);
    expect(cfg.parsed.personas[0].id).toBe('security');
  });

  it('reads persona files from the supplied root rather than the working directory', () => {
    const trusted = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-trusted-'));
    const untrusted = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-untrusted-'));
    fs.mkdirSync(path.join(trusted, '.review-yeti', 'personas'), { recursive: true });
    fs.mkdirSync(path.join(untrusted, '.review-yeti', 'personas'), { recursive: true });
    fs.writeFileSync(path.join(trusted, '.review-yeti', 'personas', 'good.md'), 'Trusted charter.\n');
    fs.writeFileSync(path.join(untrusted, '.review-yeti', 'personas', 'evil.md'), 'Attacker charter.\n');

    process.chdir(untrusted);
    const loaded = loadPersonaFiles(trusted);
    expect(loaded.personas.map((p: any) => p.id)).toEqual(['good']);
  });
});

describe('Persona count is capped so configuration cannot fan out into unbounded spend', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      charter: `Charter ${i}.`,
      enabled: true,
      source: `.review-yeti/personas/p${i}.md`,
    }));

  it('accepts a roster within the cap', () => {
    const r = resolvePersonaRoster({}, null, { MAX_PERSONAS: '25' }, many(19));
    expect(r.errors).toEqual([]);
  });

  it('rejects a roster above the cap rather than issuing the requests', () => {
    const r = resolvePersonaRoster({}, null, { MAX_PERSONAS: '25' }, many(40));
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toMatch(/25/);
  });

  it('applies a default cap when none is configured', () => {
    const r = resolvePersonaRoster({}, null, {}, many(500));
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe('action.yml sources configuration from the base ref, not the pull request head', () => {
  const action = fs.readFileSync(actionPath, 'utf-8');
  const yaml = require('js-yaml');
  const manifest: any = yaml.load(action);

  it('resolves the base ref of the pull request', () => {
    expect(action).toMatch(/base/);
  });

  it('fetches repository configuration over the API rather than reading the workspace', () => {
    expect(action).toContain('.review-yeti/personas');
    expect(action).toContain('contents/');
  });

  it('points the pipeline at the fetched configuration directory', () => {
    expect(action).toContain('REVIEW_YETI_CONFIG_DIR');
  });

  it('exposes a persona cap input', () => {
    expect(Object.keys(manifest.inputs)).toContain('max-personas');
  });

  it('passes the fetched immutable base SHA to the review-panel environment', () => {
    const targetStep = manifest.runs.steps.find((step: any) => step.id === 'target');
    const fetchStep = manifest.runs.steps.find((step: any) => step.id === 'trusted_config');
    const reviewStep = manifest.runs.steps.find((step: any) => step.id === 'review');

    expect(targetStep?.run).toContain('head_sha=$HEAD_SHA');
    expect(targetStep?.run).toContain('base_sha=$BASE_SHA');
    expect(fetchStep?.env?.BASE_REF).toBe('${{ steps.target.outputs.base_sha }}');
    expect(fetchStep?.run).toContain('base_sha=$BASE_REF');
    expect(fetchStep?.run).toContain('rm -rf "$DEST"');
    expect(fetchStep?.run).not.toContain('.default_branch');
    expect(reviewStep?.env?.GITHUB_BASE_SHA).toBe('${{ steps.trusted_config.outputs.base_sha }}');
    expect(reviewStep?.env?.PR_HEAD_SHA).toBe('${{ steps.target.outputs.head_sha }}');
    expect(reviewStep?.env?.REVIEW_YETI_TRUSTED_CONFIG_DIR).toBe('${{ runner.temp }}/review-yeti-config');
    expect(reviewStep?.env?.REVIEW_YETI_TRUSTED_CONFIG_BASE_SHA).toBe('${{ steps.trusted_config.outputs.base_sha }}');
  });
});
