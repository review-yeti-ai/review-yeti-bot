import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CONCURRENCY_ENV,
  PROVIDER_LEASE_KEY_ENV,
  PROVIDER_LEASE_TTL_ENV,
  PROVIDER_LEASES_ENV,
  PROVIDER_LOCAL_CONCURRENCY_ENV,
} from '../../src/config/providerConcurrency';

/**
 * Cross-review provider concurrency reaches a worker only through the operator Deployment
 * (k8s-operator/main.go reads it, pkg/job/job.go forwards it to app-gate Jobs, pinned by
 * TestBuildWorkerJobForwardsProviderConcurrencyOnlyWhenSet) and reaches the dispatch service
 * through its ConfigMap. Every value is empty by default, so an unconfigured install renders
 * exactly what it rendered before.
 */
const root = path.resolve(__dirname, '../..');

type Manifest = { kind: string; metadata?: { name?: string }; data?: Record<string, string>;
  spec?: { template: { spec: { containers: Array<{ name: string; env?: Array<{ name: string; value: string }> }> } } } };

function render(values: Record<string, unknown> = {}): Manifest[] {
  return yaml.loadAll(execFileSync('helm', [
    'template', 'provider-concurrency-contract', path.join(root, 'charts/review-yeti'),
    '--namespace', 'ct-review-system', '--values', '-',
  ], { input: yaml.dump(values), encoding: 'utf8', timeout: 30_000 })) as Manifest[];
}

function operatorEnv(documents: Manifest[]) {
  const deployment = documents.find((item) => item?.kind === 'Deployment'
    && item.spec!.template.spec.containers.some((container) => container.name === 'operator'));
  return deployment!.spec!.template.spec.containers.find((container) => container.name === 'operator')!.env ?? [];
}

function dispatcherConfig(documents: Manifest[]): Record<string, string> {
  return documents.find((item) => item?.kind === 'ConfigMap' && 'ACTION_DISPATCH_ENABLED' in (item.data ?? {}))?.data ?? {};
}

function helmAvailable(): boolean {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

describe('provider concurrency chart source contract', () => {
  it('uses the names the worker and the service read', () => {
    expect([PROVIDER_LEASES_ENV, PROVIDER_LEASE_KEY_ENV, PROVIDER_LOCAL_CONCURRENCY_ENV, PROVIDER_CONCURRENCY_ENV, PROVIDER_LEASE_TTL_ENV]).toEqual([
      'REVIEW_YETI_PROVIDER_LEASES', 'REVIEW_YETI_PROVIDER_LEASE_KEY', 'REVIEW_YETI_PROVIDER_LOCAL_CONCURRENCY',
      'REVIEW_YETI_PROVIDER_CONCURRENCY', 'REVIEW_YETI_PROVIDER_LEASE_TTL_MS',
    ]);
  });

  it('ships every provider concurrency value off in Helm values', () => {
    const values = yaml.load(readFileSync(path.join(root, 'charts/review-yeti/values.yaml'), 'utf8')) as {
      publishing: Record<string, string>; dispatcher: { config: Record<string, string> };
    };
    expect([values.publishing.providerLeases, values.publishing.providerLeaseKey, values.publishing.providerLocalConcurrency]).toEqual(['', '', '']);
    expect([values.dispatcher.config.providerConcurrency, values.dispatcher.config.providerLeaseTtlMs]).toEqual(['', '']);
  });
});

describe.skipIf(!helmAvailable())('rendered provider concurrency contract', () => {
  it('renders nothing new when unset', () => {
    const documents = render();
    const names = operatorEnv(documents).map((entry) => entry.name);
    expect(names.filter((name) => name.startsWith('REVIEW_YETI_PROVIDER_'))).toEqual([]);
    expect(Object.keys(dispatcherConfig(documents)).filter((name) => name.startsWith('REVIEW_YETI_PROVIDER_'))).toEqual([]);
  });

  it('forwards the worker settings to the operator and the capacity to the dispatch service, verbatim', () => {
    const documents = render({
      publishing: { providerLeases: 'true', providerLeaseKey: 'pr-reviewer', providerLocalConcurrency: '6' },
      dispatcher: { config: { providerConcurrency: 'pr-reviewer=12', providerLeaseTtlMs: '60000' } },
    });
    // Container env order carries no meaning: pin the exact set, not its order.
    const providerEnv = operatorEnv(documents).filter((entry) => entry.name.startsWith('REVIEW_YETI_PROVIDER_'));
    expect(providerEnv).toHaveLength(3);
    expect(providerEnv).toEqual(expect.arrayContaining([
      { name: 'REVIEW_YETI_PROVIDER_LEASES', value: 'true' },
      { name: 'REVIEW_YETI_PROVIDER_LEASE_KEY', value: 'pr-reviewer' },
      { name: 'REVIEW_YETI_PROVIDER_LOCAL_CONCURRENCY', value: '6' },
    ]));
    expect(dispatcherConfig(documents)).toMatchObject({
      REVIEW_YETI_PROVIDER_CONCURRENCY: 'pr-reviewer=12', REVIEW_YETI_PROVIDER_LEASE_TTL_MS: '60000',
    });
  });
}, 60_000);
