import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

type Manifest = Record<string, any>;

function manifests(): Manifest[] {
  const source = fs.readFileSync(path.resolve(__dirname, '../../k8s/operator-deployment.yaml.tpl'), 'utf8');
  return source
    .split(/^---\s*$/mu)
    .map((document) => yaml.load(document) as Manifest)
    .filter(Boolean);
}

function byKind(kind: string): Manifest {
  const result = manifests().find((candidate) => candidate.kind === kind);
  if (!result) throw new Error(`missing ${kind} manifest`);
  return result;
}

describe('isolated DOKS operator manifest', () => {
  it('is disabled and non-publishing by default', () => {
    const deployment = byKind('Deployment');
    expect(deployment.metadata).toMatchObject({
      name: 'ct-review-yeti-operator',
      namespace: 'ct-review-system',
    });
    expect(deployment.spec.replicas).toBe(0);
    expect(deployment.spec.template.spec.serviceAccountName).toBe('ct-review-yeti-operator');
    const container = deployment.spec.template.spec.containers[0];
    expect(container.image).toBe('${CT_REVIEW_OPERATOR_IMAGE}');
    expect(container.imagePullPolicy).toBe('IfNotPresent');
    expect(container.env).toContainEqual({ name: 'REVIEW_YETI_OPERATOR_ENABLED', value: 'false' });
    expect(JSON.stringify(container.env)).not.toMatch(/OPENROUTER|GITHUB_APP|PROVIDER|SECRET/iu);
  });

  it('uses namespace-scoped least-privilege RBAC', () => {
    const role = byKind('Role');
    expect(role.metadata.namespace).toBe('ct-review-system');
    const resources = role.rules.flatMap((rule: Manifest) => rule.resources ?? []);
    expect(resources).toEqual(expect.arrayContaining([
      'prreviewjobs', 'prreviewjobs/status', 'jobs', 'pods', 'persistentvolumeclaims', 'leases',
    ]));
    expect(resources).not.toContain('secrets');
    expect(resources).not.toContain('nodes');
    expect(manifests().some((candidate) => candidate.kind === 'ClusterRole' || candidate.kind === 'ClusterRoleBinding')).toBe(false);
  });

  it('has a non-root runtime and only Kubernetes API egress', () => {
    const deployment = byKind('Deployment');
    const podSpec = deployment.spec.template.spec;
    expect(podSpec.automountServiceAccountToken).toBe(true);
    expect(podSpec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    const container = podSpec.containers[0];
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      capabilities: { drop: ['ALL'] },
    });

    const policies = manifests().filter((candidate) => candidate.kind === 'NetworkPolicy');
    expect(policies.length).toBe(2);
    const allowed = policies.find((candidate) => candidate.metadata.name === 'ct-review-yeti-operator-allowed');
    expect(allowed).toBeDefined();
    const ports = (allowed?.spec.egress ?? []).flatMap((entry: Manifest) => entry.ports ?? []).map((port: Manifest) => port.port);
    expect(ports.sort((left: number, right: number) => left - right)).toEqual([53, 53, 443]);
    const apiRule = (allowed?.spec.egress ?? []).find((entry: Manifest) => entry.ports?.some((port: Manifest) => port.port === 443));
    expect(apiRule?.to).toEqual([{ ipBlock: { cidr: '${KUBERNETES_API_CIDR}' } }]);
    expect(JSON.stringify(allowed)).not.toContain('0.0.0.0/0');
  });
});
