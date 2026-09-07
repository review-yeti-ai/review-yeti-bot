import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

const root = path.resolve(__dirname, '../..');
const dispatcherImage = `registry.digitalocean.com/calltelemetry/ct-review-bot@sha256:${'a'.repeat(64)}`;
const workerImage = `registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:${'b'.repeat(64)}`;

function documents(): Array<Record<string, any>> {
  const source = fs.readFileSync(path.join(root, 'k8s/review-job-dispatcher.yaml.tpl'), 'utf8')
    .replaceAll('${CT_REVIEW_JOB_DISPATCHER_IMAGE}', dispatcherImage)
    .replaceAll('${CT_REVIEW_WORKER_IMAGE}', workerImage)
    .replaceAll('${CT_REVIEW_RUNNER_MODE}', 'prebaked');
  return yaml.loadAll(source).filter(Boolean) as Array<Record<string, any>>;
}

function runDeployScript(overrides: Record<string, string> = {}) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-job-dispatcher-test-'));
  const binaryDirectory = path.join(temporaryDirectory, 'bin');
  const kubectlLog = path.join(temporaryDirectory, 'kubectl.log');
  const renderedManifest = path.join(temporaryDirectory, 'rendered.yaml');
  fs.mkdirSync(binaryDirectory);
  fs.writeFileSync(path.join(binaryDirectory, 'kubectl'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_KUBECTL_LOG"
case "$*" in
  *"get secret ct-review-job-dispatcher-runtime"*) printf 'DATABASE_URL\\nDATABASE_CA_CERT\\n' ;;
  *"get deployment ct-review-job-dispatcher"*) printf '0' ;;
esac
if [[ "$*" == *"apply --server-side -f "*"/review-job-dispatcher.yaml" ]]; then
  cp "\${@: -1}" "$FAKE_RENDERED_MANIFEST"
fi
`);
  fs.writeFileSync(path.join(binaryDirectory, 'envsubst'), [
    '#!/usr/bin/env node',
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => process.stdout.write(input",
    "  .replaceAll('${CT_REVIEW_JOB_DISPATCHER_IMAGE}', process.env.CT_REVIEW_JOB_DISPATCHER_IMAGE || '')",
    "  .replaceAll('${CT_REVIEW_WORKER_IMAGE}', process.env.CT_REVIEW_WORKER_IMAGE || '')",
    "  .replaceAll('${CT_REVIEW_RUNNER_MODE}', process.env.CT_REVIEW_RUNNER_MODE || 'prebaked')));",
    '',
  ].join('\n'));
  fs.chmodSync(path.join(binaryDirectory, 'kubectl'), 0o755);
  fs.chmodSync(path.join(binaryDirectory, 'envsubst'), 0o755);
  const result = spawnSync('bash', ['scripts/deploy-review-job-dispatcher.sh'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binaryDirectory}:${process.env.PATH || ''}`,
      FAKE_KUBECTL_LOG: kubectlLog,
      FAKE_RENDERED_MANIFEST: renderedManifest,
      CT_REVIEW_JOB_DISPATCHER_IMAGE: dispatcherImage,
      CT_REVIEW_WORKER_IMAGE: workerImage,
      ...overrides,
    },
  });
  const calls = fs.existsSync(kubectlLog) ? fs.readFileSync(kubectlLog, 'utf8') : '';
  const rendered = fs.existsSync(renderedManifest) ? fs.readFileSync(renderedManifest, 'utf8') : '';
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  return { ...result, calls, rendered };
}

describe('zero-replica review job dispatcher deployment', () => {
  it('is inert by default and carries no review execution credentials', () => {
    const docs = documents();
    expect(docs.some((document) => ['Service', 'Ingress', 'PersistentVolumeClaim'].includes(document.kind))).toBe(false);
    const deployment = docs.find((document) => document.kind === 'Deployment');
    expect(deployment).toBeDefined();
    const pod = deployment!.spec.template.spec;
    const container = pod.containers[0];

    expect(deployment!.spec.replicas).toBe(0);
    expect(pod.serviceAccountName).toBe('ct-review-job-dispatcher');
    expect(pod.automountServiceAccountToken).toBe(true);
    expect(container.image).toBe(dispatcherImage);
    expect(container.command).toEqual(['node', 'dist/reviewJobDispatcherIndex.js']);
    expect(container.envFrom).toEqual([
      { configMapRef: { name: 'ct-review-job-dispatcher' } },
    ]);
    // Exact, not a superset: this pod's entire credential surface should be
    // reviewable at a glance. REL-586 added the two App keys so it can mint per-run
    // publish and read tokens; they come from a dedicated Secret (ADR 0539).
    expect(container.env).toEqual([
      {
        name: 'DATABASE_URL',
        valueFrom: { secretKeyRef: { name: 'ct-review-job-dispatcher-runtime', key: 'DATABASE_URL' } },
      },
      {
        name: 'DATABASE_CA_CERT',
        valueFrom: { secretKeyRef: { name: 'ct-review-job-dispatcher-runtime', key: 'DATABASE_CA_CERT' } },
      },
      {
        name: 'GITHUB_APP_ID',
        valueFrom: { secretKeyRef: { name: 'ct-review-job-dispatcher-github-app', key: 'GITHUB_APP_ID' } },
      },
      {
        name: 'GITHUB_APP_PRIVATE_KEY',
        valueFrom: { secretKeyRef: { name: 'ct-review-job-dispatcher-github-app', key: 'GITHUB_APP_PRIVATE_KEY' } },
      },
    ]);
    expect(container.securityContext).toEqual(expect.objectContaining({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    }));

    const serialized = JSON.stringify(deployment!);
    // REL-586 / ADR 0539: GITHUB_APP is no longer forbidden here. This component
    // mints the per-run publish and read tokens, so it must hold the App key --
    // see the dedicated assertions below for the shape that replaces the blanket
    // ban. Every other credential class stays forbidden: it still performs no
    // review execution and talks to no model provider.
    for (const forbidden of [
      'GITHUB_TOKEN', 'OPENROUTER', 'FIREWORKS', 'OLLAMA', 'OMNIROUTE',
      'SYNTHETIC_API', 'WEBHOOK_SECRET', 'workspace-pvc', 'provider',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('grants only namespaced get/create access to the v1alpha2 projection resource', () => {
    const docs = documents();
    const role = docs.find((document) => document.kind === 'Role');
    expect(role).toBeDefined();
    expect(role!.metadata.namespace).toBe('ct-review-system');
    // Exact. The secrets rule is create-only by design: Kubernetes cannot scope a
    // verb to one Secret name, so delete or patch would reach the App private key
    // this pod holds, the gateway credential, and the ingress TLS key.
    expect(role!.rules).toEqual([
      {
        apiGroups: ['review-yeti.ai'],
        resources: ['prreviewjobs'],
        verbs: ['get', 'create'],
      },
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['create'],
      },
    ]);
    const binding = docs.find((document) => document.kind === 'RoleBinding');
    expect(binding).toBeDefined();
    expect(binding!.subjects).toEqual([{
      kind: 'ServiceAccount',
      name: 'ct-review-job-dispatcher',
      namespace: 'ct-review-system',
    }]);
  });

  it('projects only immutable images and retains default-deny networking', () => {
    const docs = documents();
    const config = docs.find((document) => document.kind === 'ConfigMap');
    expect(config).toBeDefined();
    expect(config!.data).toEqual(expect.objectContaining({
      REVIEW_JOB_DISPATCH_ENABLED: 'true',
      REVIEW_JOB_NAMESPACE: 'ct-review-system',
      REVIEW_JOB_WORKER_IMAGE: workerImage,
    }));
    const policies = docs.filter((document) => document.kind === 'NetworkPolicy');
    expect(policies.some((policy) => policy.metadata.name === 'ct-review-job-dispatcher-default-deny')).toBe(true);
    const allowed = policies.find((policy) => policy.metadata.name === 'ct-review-job-dispatcher-allowed');
    expect(allowed).toBeDefined();
    expect(allowed!.spec.policyTypes).toEqual(['Egress']);
    expect(allowed!.spec.egress).toEqual(expect.arrayContaining([
      expect.objectContaining({ ports: expect.arrayContaining([{ protocol: 'TCP', port: 443 }]) }),
      expect.objectContaining({ ports: expect.arrayContaining([{ protocol: 'TCP', port: 25060 }]) }),
    ]));
  });

  it('renders only the isolated zero-replica manifest and rejects mutable images', () => {
    const script = fs.readFileSync(path.join(root, 'scripts/deploy-review-job-dispatcher.sh'), 'utf8');
    expect(script).toContain('k8s/review-job-dispatcher.yaml.tpl');
    expect(script).toMatch(/CT_REVIEW_JOB_DISPATCHER_IMAGE.*@sha256/);
    expect(script).toMatch(/CT_REVIEW_WORKER_IMAGE.*@sha256/);
    expect(script).toContain('jsonpath');
    expect(script).toContain('expected zero replicas');
    for (const forbidden of ['rollout restart', 'kubectl scale', 'workspace-pvc', 'worker-rbac', 'bot-deployment']) {
      expect(script).not.toContain(forbidden);
    }
  });

  it('executes the guarded zero-replica render for trusted immutable images', () => {
    const result = runDeployScript();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain('apply --server-side -f k8s/namespace.yaml');
    expect(result.calls).toContain('apply --server-side -f');
    expect(result.calls).toContain("get deployment ct-review-job-dispatcher -o jsonpath={.spec.replicas}");
    expect(result.stdout).toContain('zero replicas');
    expect(result.rendered).toContain(`image: ${dispatcherImage}`);
    expect(result.rendered).toContain(`REVIEW_JOB_WORKER_IMAGE: "${workerImage}"`);
    expect(result.rendered).not.toContain('${');
  });

  it('executes the guarded zero-replica render for trusted ghcr.io immutable images', () => {
    const ghcrDispatcherImage = `ghcr.io/review-yeti-ai/review-yeti-bot@sha256:${'c'.repeat(64)}`;
    const ghcrWorkerImage = `ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${'d'.repeat(64)}`;
    const result = runDeployScript({
      CT_REVIEW_JOB_DISPATCHER_IMAGE: ghcrDispatcherImage,
      CT_REVIEW_WORKER_IMAGE: ghcrWorkerImage,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.rendered).toContain(`image: ${ghcrDispatcherImage}`);
    expect(result.rendered).toContain(`REVIEW_JOB_WORKER_IMAGE: "${ghcrWorkerImage}"`);
  });

  it.each([
    ['mutable dispatcher tag', { CT_REVIEW_JOB_DISPATCHER_IMAGE: 'registry.digitalocean.com/calltelemetry/ct-review-bot:latest' }],
    ['untrusted dispatcher repository', { CT_REVIEW_JOB_DISPATCHER_IMAGE: `attacker.example/ct-review-bot@sha256:${'a'.repeat(64)}` }],
    ['uppercase dispatcher digest', { CT_REVIEW_JOB_DISPATCHER_IMAGE: `registry.digitalocean.com/calltelemetry/ct-review-bot@sha256:${'A'.repeat(64)}` }],
    ['short dispatcher digest', { CT_REVIEW_JOB_DISPATCHER_IMAGE: `registry.digitalocean.com/calltelemetry/ct-review-bot@sha256:${'a'.repeat(63)}` }],
    ['mutable worker tag', { CT_REVIEW_WORKER_IMAGE: 'registry.digitalocean.com/calltelemetry/review-yeti-worker:latest' }],
    ['untrusted worker repository', { CT_REVIEW_WORKER_IMAGE: `attacker.example/review-yeti-worker@sha256:${'b'.repeat(64)}` }],
  ])('refuses %s before any Kubernetes apply', (_name, overrides) => {
    const result = runDeployScript(overrides);
    expect(result.status).toBe(2);
    expect(result.calls).not.toContain('apply');
  });

  it('uses only in-cluster Kubernetes identity and excludes GitHub/provider clients', () => {
    const source = fs.readFileSync(path.join(root, 'src/reviewJobDispatcherIndex.ts'), 'utf8');
    expect(source).toContain('loadFromCluster()');
    expect(source).not.toContain('loadFromDefault');
    for (const forbidden of ['github/appAuth', 'openRouter', 'fireworks', 'omniRoute', 'synthetic']) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe('publishing credential posture (REL-586, ADR 0539)', () => {
  it('holds the App key in a dedicated secret, not the runtime one', () => {
    // deploy-review-job-dispatcher.sh asserts the runtime Secret holds exactly the
    // two database keys. Adding App credentials there would either break that
    // assertion or silently weaken it.
    const deployment = documents().find((doc) => doc.kind === 'Deployment');
    const env: any[] = deployment?.spec.template.spec.containers[0].env || [];
    const resolved = Object.fromEntries(env.map((entry) => [
      entry.name,
      { secret: entry.valueFrom?.secretKeyRef?.name, key: entry.valueFrom?.secretKeyRef?.key },
    ]));
    expect(resolved.GITHUB_APP_ID)
      .toEqual({ secret: 'ct-review-job-dispatcher-github-app', key: 'GITHUB_APP_ID' });
    expect(resolved.GITHUB_APP_PRIVATE_KEY)
      .toEqual({ secret: 'ct-review-job-dispatcher-github-app', key: 'GITHUB_APP_PRIVATE_KEY' });
    expect(resolved.DATABASE_URL.secret).toBe('ct-review-job-dispatcher-runtime');
    // Never inline.
    for (const entry of env) expect(entry.value).toBeUndefined();
  });

  it('can create secrets but never delete, patch, get or list them', () => {
    // Kubernetes cannot scope a verb to one Secret name. `delete` or `patch` here
    // would reach the App private key this pod is given, the gateway credential and
    // the ingress TLS key. A 409 is treated as success instead, which is only sound
    // because a run-secret name is written inside a single fifteen-minute window.
    const role = documents().find((doc) => doc.kind === 'Role');
    const secretRule = (role?.rules || []).find((rule: any) => (rule.resources || []).includes('secrets'));
    expect(secretRule?.verbs).toEqual(['create']);
  });

  it('still grants no cluster-scoped access', () => {
    for (const doc of documents()) {
      expect(doc.kind).not.toBe('ClusterRole');
      expect(doc.kind).not.toBe('ClusterRoleBinding');
    }
  });
});
