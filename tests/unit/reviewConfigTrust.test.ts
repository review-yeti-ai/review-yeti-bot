import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const actionPath = path.join(rootRepoDir, 'action.yml');

const { resolveConfigRoot, loadLocalRepoConfig, loadPersonaFiles, resolvePersonaRoster } = pipeline;

describe('Configuration is read from an explicit trusted root', () => {
  const originalCwd = process.cwd();
  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env.CT_REVIEW_CONFIG_DIR;
  });

  it('uses CT_REVIEW_CONFIG_DIR when provided', () => {
    expect(resolveConfigRoot({ CT_REVIEW_CONFIG_DIR: '/tmp/trusted' })).toBe('/tmp/trusted');
  });

  it('falls back to the working directory when unset, for local runs', () => {
    expect(resolveConfigRoot({})).toBe(process.cwd());
  });

  it('reads .ct-review.yaml from the supplied root rather than the working directory', () => {
    const trusted = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-trusted-'));
    const untrusted = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-untrusted-'));
    fs.writeFileSync(path.join(trusted, '.ct-review.yaml'), 'personas:\n  - id: security\n');
    fs.writeFileSync(path.join(untrusted, '.ct-review.yaml'), 'personas:\n  - id: testing\n');

    process.chdir(untrusted);
    const cfg = loadLocalRepoConfig(trusted);
    expect(cfg.parsed.personas[0].id).toBe('security');
  });

  it('reads persona files from the supplied root rather than the working directory', () => {
    const trusted = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-trusted-'));
    const untrusted = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-untrusted-'));
    fs.mkdirSync(path.join(trusted, '.ct-review', 'personas'), { recursive: true });
    fs.mkdirSync(path.join(untrusted, '.ct-review', 'personas'), { recursive: true });
    fs.writeFileSync(path.join(trusted, '.ct-review', 'personas', 'good.md'), 'Trusted charter.\n');
    fs.writeFileSync(path.join(untrusted, '.ct-review', 'personas', 'evil.md'), 'Attacker charter.\n');

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
      source: `.ct-review/personas/p${i}.md`,
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

  it('resolves the base ref of the pull request', () => {
    expect(action).toMatch(/base/);
  });

  it('fetches repository configuration over the API rather than reading the workspace', () => {
    expect(action).toContain('.ct-review/personas');
    expect(action).toContain('contents/');
  });

  it('points the pipeline at the fetched configuration directory', () => {
    expect(action).toContain('CT_REVIEW_CONFIG_DIR');
  });

  it('exposes a persona cap input', () => {
    const yaml = require('js-yaml');
    const parsed: any = yaml.load(action);
    expect(Object.keys(parsed.inputs)).toContain('max-personas');
  });
});
