import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(__dirname, '../..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));

describe('Context7 per-repo policy', () => {
  it('exposes resolveContext7Policy and buildContext7Augmentation', () => {
    expect(typeof pipeline.resolveContext7Policy).toBe('function');
    expect(typeof pipeline.inferLibrariesFromDiff).toBe('function');
    expect(typeof pipeline.buildContext7Augmentation).toBe('function');
  });

  it('defaults on when API key is present and YAML does not disable', () => {
    const policy = pipeline.resolveContext7Policy(
      { parsed: {} },
      { CONTEXT7_API_KEY: 'ctx7-test-key' },
    );
    expect(policy.enabled).toBe(true);
    expect(policy.hasKey).toBe(true);
  });

  it('honors mcp.context7.enabled=false even when key is present', () => {
    const policy = pipeline.resolveContext7Policy(
      { parsed: { mcp: { context7: { enabled: false } } } },
      { CONTEXT7_API_KEY: 'ctx7-test-key' },
    );
    expect(policy.enabled).toBe(false);
    expect(policy.reason).toMatch(/enabled=false/);
  });

  it('stays off when key is missing', () => {
    const policy = pipeline.resolveContext7Policy(
      { parsed: { mcp: { context7: { enabled: true } } } },
      { CONTEXT7_API_KEY: '' },
    );
    expect(policy.enabled).toBe(false);
    expect(policy.hasKey).toBe(false);
  });

  it('CONTEXT7_ENABLED=off forces disable', () => {
    const policy = pipeline.resolveContext7Policy(
      { parsed: { mcp: { context7: { enabled: true } } } },
      { CONTEXT7_API_KEY: 'ctx7-test-key', CONTEXT7_ENABLED: 'off' },
    );
    expect(policy.enabled).toBe(false);
  });

  it('infers libraries from common paths', () => {
    const libs = pipeline.inferLibrariesFromDiff([
      { path: 'action.yml' },
      { path: 'src/foo.ts' },
      { path: 'package.json' },
    ]);
    expect(libs).toEqual(expect.arrayContaining(['typescript', 'node.js', 'github-actions']));
  });

  it('review-yeti-ai repo .review-yeti.yaml enables context7 by default', () => {
    const yamlPath = path.join(root, '.review-yeti.yaml');
    expect(fs.existsSync(yamlPath)).toBe(true);
    const raw = fs.readFileSync(yamlPath, 'utf8');
    expect(raw).toMatch(/context7:/);
    expect(raw).toMatch(/enabled:\s*true/);
  });

  it('buildContext7Augmentation is no-op without key', async () => {
    const prev = process.env.CONTEXT7_API_KEY;
    delete process.env.CONTEXT7_API_KEY;
    try {
      const aug = await pipeline.buildContext7Augmentation(
        [{ path: 'src/a.ts' }],
        { enabled: true, hasKey: false, libraries: [], maxSnippets: 5, reason: 'test' },
      );
      expect(aug.enabled).toBe(false);
    } finally {
      if (prev !== undefined) process.env.CONTEXT7_API_KEY = prev;
    }
  });
});
