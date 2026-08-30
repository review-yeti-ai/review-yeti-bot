import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

const root = path.resolve(__dirname, '../..');

function documents(): Array<Record<string, any>> {
  const source = fs.readFileSync(path.join(root, 'k8s/action-dispatch.yaml.tpl'), 'utf8')
    .replaceAll('${CT_REVIEW_DISPATCH_IMAGE}', `registry.example/review@sha256:${'a'.repeat(64)}`);
  return yaml.loadAll(source).filter(Boolean) as Array<Record<string, any>>;
}

describe('admission-only Action dispatch deployment', () => {
  it('uses a digest placeholder and cannot mount review execution capabilities', () => {
    const docs = documents();
    expect(docs.some((document) => document.kind === 'PersistentVolumeClaim')).toBe(false);

    const deployment = docs.find((document) => document.kind === 'Deployment');
    const pod = deployment?.spec.template.spec;
    const container = pod.containers[0];
    expect(container.image).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(container.command).toEqual(['node', 'dist/dispatchIndex.js']);
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(container.envFrom).toEqual([
      { configMapRef: { name: 'ct-review-action-dispatch' } },
      { secretRef: { name: 'ct-review-action-dispatch-runtime' } },
    ]);

    const serialized = JSON.stringify(deployment);
    for (const forbidden of ['WEBHOOK_SECRET', 'OPENROUTER', 'FIREWORKS', 'OMNIROUTE', 'SYNTHETIC_API', 'PersistentVolumeClaim']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('exposes only the exact dispatch path and permits only required network flows', () => {
    const docs = documents();
    const ingress = docs.find((document) => document.kind === 'Ingress');
    expect(ingress.spec.rules[0].http.paths).toEqual([expect.objectContaining({
      path: '/api/dispatch/action',
      pathType: 'Exact',
    })]);

    const policies = docs.filter((document) => document.kind === 'NetworkPolicy');
    expect(policies.some((policy) => policy.metadata.name === 'ct-review-action-dispatch-default-deny')).toBe(true);
    const allowed = policies.find((policy) => policy.metadata.name === 'ct-review-action-dispatch-allowed');
    expect(allowed.spec.egress).toEqual(expect.arrayContaining([
      expect.objectContaining({ ports: expect.arrayContaining([{ protocol: 'TCP', port: 443 }]) }),
      expect.objectContaining({ ports: expect.arrayContaining([{ protocol: 'TCP', port: 25060 }]) }),
    ]));
  });

  it('deploys only the isolated manifest and rejects mutable image tags', () => {
    const script = fs.readFileSync(path.join(root, 'scripts/deploy-action-dispatch.sh'), 'utf8');
    expect(script).toMatch(/CT_REVIEW_DISPATCH_IMAGE.*@sha256/);
    expect(script).toContain('k8s/action-dispatch.yaml.tpl');
    for (const forbidden of ['k8s/config.yaml', 'workspace-pvc', 'omniroute', 'worker-rbac', 'bot-deployment']) {
      expect(script).not.toContain(forbidden);
    }
  });
});
