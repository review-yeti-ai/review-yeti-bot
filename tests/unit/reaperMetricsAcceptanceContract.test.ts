import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

interface WorkflowStep {
  run?: unknown;
}

interface WorkflowJob {
  env?: Record<string, unknown>;
  services?: Record<string, { image?: unknown }>;
  steps?: WorkflowStep[];
}

interface WorkflowDocument {
  jobs?: Record<string, WorkflowJob>;
}

function commandLines(value: unknown): string[][] {
  if (typeof value !== 'string') return [];
  return value.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split(/\s+/u));
}

function invokesNpmScript(value: unknown, script: string): boolean {
  return commandLines(value).some((tokens) => (
    tokens[0] === 'npm'
    && ((tokens[1] === 'run' && tokens[2] === script)
      || (script === 'test' && tokens[1] === 'test'))
  ));
}

function optionValue(tokens: string[], name: string): string | undefined {
  const inline = tokens.find((token) => token.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = tokens.indexOf(name);
  return index >= 0 ? tokens[index + 1] : undefined;
}

describe('REL-817 reaper acceptance entry point', () => {
  it('runs the isolated PostgreSQL harness serially and makes it a protected CI gate', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const script = packageJson.scripts?.['test:acceptance:reaper'];
    expect(script).toBeTypeOf('string');
    const tokens = script!.trim().split(/\s+/u);
    const vitest = tokens.indexOf('vitest');
    expect(vitest).toBeGreaterThan(0);
    expect(tokens.slice(0, vitest)).toContain('REVIEW_YETI_REAPER_ACCEPTANCE=1');
    expect(tokens[vitest + 1]).toBe('run');
    expect(tokens.filter((token) => token.endsWith('.test.ts'))).toEqual([
      'tests/integration/reaperMetricsAcceptance.postgres.test.ts',
    ]);
    expect(optionValue(tokens, '--maxWorkers')).toBe('1');
    expect(tokens).toContain('--no-file-parallelism');

    const workflow = yaml.load(
      fs.readFileSync(path.join(root, '.github/workflows/ci-cd.yaml'), 'utf8'),
    ) as WorkflowDocument;
    const testJob = workflow.jobs?.test;
    expect(testJob).toBeDefined();
    expect(String(testJob?.services?.postgres?.image)).toMatch(/^postgres:/u);
    expect(testJob?.env?.REVIEW_YETI_TEST_DATABASE_URL).toBe(
      'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
    );

    const steps = testJob?.steps ?? [];
    const fullSuite = steps.findIndex(({ run }) => invokesNpmScript(run, 'test'));
    const acceptanceSteps = steps
      .map(({ run }, index) => ({ index, invokes: invokesNpmScript(run, 'test:acceptance:reaper') }))
      .filter(({ invokes }) => invokes);
    expect(fullSuite).toBeGreaterThan(-1);
    expect(acceptanceSteps).toHaveLength(1);
    const acceptance = acceptanceSteps[0].index;
    expect(acceptance).toBeGreaterThan(fullSuite);
  });
});
