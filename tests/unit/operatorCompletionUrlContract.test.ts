import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const completionEnv = 'REVIEW_YETI_COMPLETION_URL';
const completionUrl = 'https://dispatch.example.invalid/api/dispatch/completion';

interface Manifest {
  kind: string;
  spec: {
    replicas: number;
    template: { spec: { containers: Array<{ name: string; env: Array<{ name: string; value: string }> }> } };
  };
}

function operator(document: string): Manifest {
  const deployment = (yaml.loadAll(document) as Manifest[]).find((item) =>
    item?.kind === 'Deployment'
    && item.spec.template.spec.containers.some((container) => container.name === 'operator'));
  expect(deployment).toBeDefined();
  return deployment!;
}

function environment(deployment: Manifest) {
  return deployment.spec.template.spec.containers.find((container) => container.name === 'operator')!.env;
}

function render(publishing: Record<string, unknown> = {}): string {
  return execFileSync('helm', [
    'template', 'completion-contract', path.join(root, 'charts/review-yeti'),
    '--namespace', 'ct-review-system', '--values', '-',
  ], {
    input: yaml.dump({ publishing }),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function helmAvailable(): boolean {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

describe('operator completion URL source contract', () => {
  it('declares an empty native setting without activating the dormant operator', () => {
    const source = readFileSync(path.join(root, 'k8s/operator-deployment.yaml.tpl'), 'utf8');
    const deployment = operator(source);
    expect(environment(deployment).filter((entry) => entry.name === completionEnv))
      .toEqual([{ name: completionEnv, value: '' }]);
    expect(environment(deployment)).toContainEqual({ name: 'REVIEW_YETI_OPERATOR_ENABLED', value: 'false' });
    expect(deployment.spec.replicas).toBe(0);
    expect(source).not.toMatch(/\$\{[^}]*COMPLETION[^}]*\}/u);
  });

  it('keeps callback activation outside the installer interpolation and active-workload guards', () => {
    const installer = readFileSync(path.join(root, 'scripts/install-doks-review-runtime.sh'), 'utf8');
    const substitution = installer.match(/^envsubst '([^']+)'/mu);
    expect(substitution?.[1]).toBe('${CT_REVIEW_OPERATOR_IMAGE} ${KUBERNETES_SERVICE_IP} ${KUBERNETES_API_ENDPOINT_CIDR} ${KUBERNETES_API_CIDR}');
    expect(installer).toContain('refuse_active_deployment ct-review-yeti-operator');
    expect(installer).toContain('refuse_active_deployment ct-review-job-dispatcher');
    expect(installer).toContain('"$operator_replicas" != "0" || "$dispatcher_replicas" != "0"');
  });

  it('ships no default callback destination in Helm values', () => {
    const values = yaml.load(readFileSync(path.join(root, 'charts/review-yeti/values.yaml'), 'utf8')) as {
      publishing: { completionUrl?: string };
    };
    expect(values.publishing.completionUrl).toBe('');
  });
});

describe.skipIf(!helmAvailable())('rendered operator completion URL contract', () => {
  it.each([undefined, '', null])('omits the callback when the optional value is %s', (completionUrl) => {
    const deployment = operator(render(completionUrl === undefined ? {} : { completionUrl }));
    expect(environment(deployment).some((entry) => entry.name === completionEnv)).toBe(false);
  });

  it('adds only the configured operator environment entry, preserving every other rendered resource', () => {
    const before = yaml.loadAll(render());
    const rendered = render({ completionUrl });
    const after = yaml.loadAll(rendered) as Manifest[];
    const deployment = after.find((item) => item?.kind === 'Deployment'
      && item.spec.template.spec.containers.some((container) => container.name === 'operator'))!;
    const env = environment(deployment);
    expect(env.filter((entry) => entry.name === completionEnv)).toEqual([{ name: completionEnv, value: completionUrl }]);
    env.splice(env.findIndex((entry) => entry.name === completionEnv), 1);
    expect(after).toEqual(before);
  });
}, 60_000);
