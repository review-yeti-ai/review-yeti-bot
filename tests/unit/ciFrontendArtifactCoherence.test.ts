import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = process.cwd();
const workflow = yaml.load(
  fs.readFileSync(path.join(root, '.github/workflows/ci-cd.yaml'), 'utf8'),
) as any;

describe('CI frontend artifact coherence', () => {
  it('passes one content-addressed frontend artifact bundle from build to every Vitest shard', () => {
    const build = workflow.jobs.build;
    const vitest = workflow.jobs.vitest;
    const producer = build.steps.find((step: any) => step.id === 'frontend-artifacts-cache');
    const consumer = vitest.steps.find((step: any) => step.id === 'frontend-artifacts-cache');
    const key = build.steps.find((step: any) => step.id === 'frontend-artifact-key');

    expect(build.outputs?.['frontend-artifact-key']).toBe(
      '${{ steps.frontend-artifact-key.outputs.key }}',
    );
    expect(vitest.needs).toContain('build');
    expect(producer.uses).toBe('actions/cache@caa296126883cff596d87d8935842f9db880ef25');
    expect(consumer.uses).toBe('actions/cache/restore@caa296126883cff596d87d8935842f9db880ef25');
    expect(producer.with.path).toBe(consumer.with.path);
    expect(String(producer.with.path)).toContain('public/*.html');
    expect(String(producer.with.path)).toContain('public/**/*.html');
    expect(producer.with.key).toBe('${{ steps.frontend-artifact-key.outputs.key }}');
    expect(key.env.FRONTEND_SOURCE_HASH).toBe(
      "${{ hashFiles('src/app/**', 'src/components/**', 'src/dashboard/**', 'package-lock.json', 'next.config.js') }}",
    );
    expect(key.env.FRONTEND_OUTPUT_HASH).toBe(
      "${{ hashFiles('public/_next/**', 'dist/public/**', 'public/*.html', 'public/**/*.html') }}",
    );
    expect(key.run).toContain('test -n "$FRONTEND_SOURCE_HASH"');
    expect(key.run).toContain('test -n "$FRONTEND_OUTPUT_HASH"');
    expect(consumer.with.key).toBe('${{ needs.build.outputs.frontend-artifact-key }}');
  });

  it('verifies the producer bundle and validates restored assets before and after any shard rebuild', () => {
    const build = workflow.jobs.build;
    const vitest = workflow.jobs.vitest;
    const producerVerify = build.steps.find((step: any) => step.name === 'Verify frontend artifacts before caching');
    const shardSetup = vitest.steps.find((step: any) => step.name === 'Build the artifacts the suite reads (npm pretest)');

    expect(producerVerify.run).toContain('node scripts/verify-frontend-artifacts.js');
    expect(shardSetup.run).toContain('npm run test:artifacts');
    expect(shardSetup.run).toContain('node scripts/verify-frontend-artifacts.js --ensure');
  });
});
