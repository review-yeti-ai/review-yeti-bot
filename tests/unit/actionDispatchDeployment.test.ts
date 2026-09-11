import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

const root = path.resolve(__dirname, '../..');

function documents(): Array<Record<string, any>> {
  const source = fs.readFileSync(path.join(root, 'k8s/action-dispatch.yaml.tpl'), 'utf8')
    .replaceAll('${CT_REVIEW_DISPATCH_IMAGE}', `registry.example/review@sha256:${'a'.repeat(64)}`);
  return yaml.loadAll(source).filter(Boolean) as Array<Record<string, any>>;
}

function renderStandaloneDeployment(
  requireExpectedGeneration: boolean,
  privateKey: string,
): { configDocument: string; deployment: Record<string, any> } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'action-dispatch-render-'));
  const binaries = path.join(workspace, 'bin');
  const capturedManifest = path.join(workspace, 'action-dispatch.yaml');
  fs.mkdirSync(binaries);
  fs.mkdirSync(path.join(workspace, 'k8s'));
  fs.cpSync(path.join(root, 'scripts'), path.join(workspace, 'scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(root, 'k8s/action-dispatch.yaml.tpl'),
    path.join(workspace, 'k8s/action-dispatch.yaml.tpl'),
  );
  fs.copyFileSync(path.join(root, 'k8s/namespace.yaml'), path.join(workspace, 'k8s/namespace.yaml'));
  fs.writeFileSync(
    path.join(binaries, 'kubectl'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "apply" ]]; then
  target=""
  for argument in "$@"; do target="$argument"; done
  if grep -q '^kind: Deployment$' "$target"; then cp "$target" "${capturedManifest}"; fi
fi
exit 0
`,
  );
  fs.chmodSync(path.join(binaries, 'kubectl'), 0o755);

  const result = spawnSync('bash', [path.join(workspace, 'scripts/deploy-action-dispatch.sh')], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binaries}:${process.env.PATH ?? ''}`,
      CT_REVIEW_DISPATCH_IMAGE: `ghcr.io/review-yeti-ai/review-yeti-bot@sha256:${'a'.repeat(64)}`,
      ACTION_DISPATCH_REPOSITORY_IDS: '1234',
      ACTION_DISPATCH_OWNER_IDS: '5678',
      ACTION_DISPATCH_WORKFLOW_REFS: '*',
      ACTION_DISPATCH_WORKFLOW_SHAS: '*',
      ACTION_DISPATCH_ALLOW_APP_GATE: 'true',
      ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION: String(requireExpectedGeneration),
      GITHUB_APP_PRIVATE_KEY: privateKey,
    },
  });
  expect(result.status, result.stderr).toBe(0);

  const rendered = fs.readFileSync(capturedManifest, 'utf8');
  const deployment = (yaml.loadAll(rendered).filter(Boolean) as Array<Record<string, any>>)
    .find((document) => document.kind === 'Deployment');
  expect(deployment).toBeDefined();
  fs.rmSync(workspace, { recursive: true, force: true });
  return { configDocument: `${rendered.split('\n---\n')[0]}\n`, deployment: deployment! };
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

  it('exposes only exact admission/completion paths and permits only required network flows', () => {
    const docs = documents();
    const ingress = docs.find((document) => document.kind === 'Ingress');
    expect(ingress).toBeDefined();
    expect(ingress!.spec.rules[0].http.paths).toEqual([expect.objectContaining({
      path: '/api/dispatch/action',
      pathType: 'Exact',
    }), expect.objectContaining({
      path: '/api/dispatch/completion',
      pathType: 'Exact',
      backend: { service: { name: 'ct-review-action-dispatch', port: { name: 'http' } } },
    })]);

    const policies = docs.filter((document) => document.kind === 'NetworkPolicy');
    expect(policies.some((policy) => policy.metadata.name === 'ct-review-action-dispatch-default-deny')).toBe(true);
    const allowed = policies.find((policy) => policy.metadata.name === 'ct-review-action-dispatch-allowed');
    expect(allowed).toBeDefined();
    expect(allowed!.spec.egress).toEqual(expect.arrayContaining([
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

  it('projects default-off expected-generation enforcement through manifest and chart config', () => {
    const configMap = documents().find((document) => document.kind === 'ConfigMap');
    expect(configMap?.data.ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION)
      .toBe('${ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION}');

    const values = yaml.load(fs.readFileSync(path.join(root, 'charts/review-yeti/values.yaml'), 'utf8')) as any;
    expect(values.dispatcher.config.requireExpectedGeneration).toBe(false);
    const template = fs.readFileSync(path.join(root, 'charts/review-yeti/templates/configmap.yaml'), 'utf8');
    expect(template).toContain('ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION: {{ .Values.dispatcher.config.requireExpectedGeneration | quote }}');

    const script = fs.readFileSync(path.join(root, 'scripts/deploy-action-dispatch.sh'), 'utf8');
    expect(script).toContain('ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION="${ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION:-false}"');
    expect(script).toContain('${ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION}');
  });

  it('changes the standalone pod template when generation enforcement toggles without hashing secrets', () => {
    const disabled = renderStandaloneDeployment(false, 'private-key-alpha');
    const enabled = renderStandaloneDeployment(true, 'private-key-alpha');
    const changedSecret = renderStandaloneDeployment(false, 'private-key-bravo');

    const disabledTemplate = disabled.deployment.spec.template;
    const enabledTemplate = enabled.deployment.spec.template;
    const disabledChecksum = disabledTemplate.metadata.annotations['checksum/config'];
    const enabledChecksum = enabledTemplate.metadata.annotations['checksum/config'];
    const changedSecretChecksum = changedSecret.deployment.spec.template.metadata.annotations['checksum/config'];

    expect(disabledTemplate.spec.containers[0].image).toBe(enabledTemplate.spec.containers[0].image);
    expect(disabledChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(enabledChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(disabledChecksum).toBe(createHash('sha256').update(disabled.configDocument).digest('hex'));
    expect(enabledChecksum).toBe(createHash('sha256').update(enabled.configDocument).digest('hex'));
    expect(enabledChecksum).not.toBe(disabledChecksum);
    expect(changedSecretChecksum).toBe(disabledChecksum);
    expect(JSON.stringify(disabledTemplate.metadata.annotations)).not.toContain('private-key-alpha');
    expect(JSON.stringify(changedSecret.deployment.spec.template.metadata.annotations)).not.toContain('private-key-bravo');
  });

  it('documents the safe reverse sequence after producer promotion', () => {
    const guide = fs.readFileSync(path.join(root, 'docs/service-owned-review-gates.md'), 'utf8');
    const rollback = guide.slice(guide.indexOf('### Exact-generation rollback'));
    const disable = rollback.indexOf('Disable expected-generation enforcement and roll the service pods');
    const producer = rollback.indexOf('Roll back the central producer');
    const service = rollback.indexOf('Roll back the service image');

    expect(disable).toBeGreaterThanOrEqual(0);
    expect(producer).toBeGreaterThan(disable);
    expect(service).toBeGreaterThan(producer);
    expect(rollback).toContain('Rolling back the service image alone is unsafe');
  });
});
