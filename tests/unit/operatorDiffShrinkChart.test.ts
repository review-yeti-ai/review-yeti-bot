import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { DIFF_SHRINK_FLAG } from '../../src/review/diffShrink';

/**
 * REL-1079: `REVIEW_YETI_DIFF_SHRINK` only reaches a worker if the operator Deployment carries it
 * (k8s-operator/main.go reads it, pkg/job/job.go forwards it to app-gate Jobs). The chart value is
 * empty by default, so an unconfigured install renders exactly what it rendered before.
 */
const root = path.resolve(__dirname, '../..');
const pilots = 'review-yeti-ai/review-yeti-bot,calltelemetry/ct-meta';

interface Manifest {
  kind: string;
  spec: { template: { spec: { containers: Array<{ name: string; env: Array<{ name: string; value: string }> }> } } };
}

function operatorEnv(documents: Manifest[]) {
  const deployment = documents.find((item) => item?.kind === 'Deployment'
    && item.spec.template.spec.containers.some((container) => container.name === 'operator'));
  expect(deployment).toBeDefined();
  return deployment!.spec.template.spec.containers.find((container) => container.name === 'operator')!.env;
}

function render(publishing: Record<string, unknown> = {}): Manifest[] {
  return yaml.loadAll(execFileSync('helm', [
    'template', 'diff-shrink-contract', path.join(root, 'charts/review-yeti'),
    '--namespace', 'ct-review-system', '--values', '-',
  ], { input: yaml.dump({ publishing }), encoding: 'utf8', timeout: 30_000 })) as Manifest[];
}

function helmAvailable(): boolean {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

describe('operator diff shrink source contract', () => {
  // The Go side is pinned behaviourally (TestPublishingConfigFromEnvReadsDiffShrink,
  // TestBuildWorkerJobForwardsDiffShrinkOnlyWhenSet); this pins the worker's name for the chart.
  it('renders the chart under the worker flag name', () => {
    expect(DIFF_SHRINK_FLAG).toBe('REVIEW_YETI_DIFF_SHRINK');
  });

  it('ships diff shrinking off in Helm values', () => {
    const values = yaml.load(readFileSync(path.join(root, 'charts/review-yeti/values.yaml'), 'utf8')) as {
      publishing: { diffShrink?: string };
    };
    expect(values.publishing.diffShrink).toBe('');
  });
});

describe.skipIf(!helmAvailable())('rendered operator diff shrink contract', () => {
  it.each([undefined, '', null])('omits the flag when the value is %s', (diffShrink) => {
    const env = operatorEnv(render(diffShrink === undefined ? {} : { diffShrink }));
    expect(env.some((entry) => entry.name === DIFF_SHRINK_FLAG)).toBe(false);
  });

  it('adds only the configured operator env entry, verbatim, preserving every other rendered resource', () => {
    const before = render();
    const after = render({ diffShrink: pilots });
    const env = operatorEnv(after);
    expect(env.filter((entry) => entry.name === DIFF_SHRINK_FLAG)).toEqual([{ name: DIFF_SHRINK_FLAG, value: pilots }]);
    env.splice(env.findIndex((entry) => entry.name === DIFF_SHRINK_FLAG), 1);
    expect(after).toEqual(before);
  });
}, 60_000);
