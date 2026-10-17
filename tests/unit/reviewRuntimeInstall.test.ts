import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const operatorImage = `ghcr.io/review-yeti-ai/review-yeti-operator@sha256:${'a'.repeat(64)}`;
const dispatcherImage = `ghcr.io/review-yeti-ai/review-yeti-bot@sha256:${'b'.repeat(64)}`;
const workerImage = `ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${'c'.repeat(64)}`;

function runInstaller(overrides: Record<string, string> = {}) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-install-test-'));
  const binaryDirectory = path.join(temporaryDirectory, 'bin');
  const logPath = path.join(temporaryDirectory, 'kubectl.log');
  const statePath = path.join(temporaryDirectory, 'state');
  const renderedOperatorPath = path.join(temporaryDirectory, 'operator.yaml');
  fs.mkdirSync(binaryDirectory);
  fs.writeFileSync(path.join(binaryDirectory, 'kubectl'), `#!/usr/bin/env bash
set -euo pipefail
joined="$*"
printf '%s\\n' "$joined" >> "$FAKE_KUBECTL_LOG"
if [[ "$joined" == *"get deployment ct-review-yeti-operator"* ]]; then
  if [[ "\${FAKE_ACTIVE_OPERATOR:-0}" == 1 ]]; then printf '1'; exit 0; fi
  [[ -f "$FAKE_OPERATOR_STATE" ]] && printf '0' || exit 1
fi
if [[ "$joined" == *"get deployment ct-review-job-dispatcher"* ]]; then
  [[ -f "$FAKE_DISPATCHER_STATE" ]] && printf '0' || exit 1
fi
if [[ "$joined" == *"get secret ct-review-job-dispatcher-runtime"* ]]; then
  if [[ -n "\${FAKE_SECRET_KEYS:-}" ]]; then
    printf '%s\\n' "$FAKE_SECRET_KEYS"
  else
    printf 'DATABASE_CA_CERT\\nDATABASE_URL\\n'
  fi
  exit 0
fi
if [[ "$joined" == *"get secret exampleorg"* ]]; then exit 0; fi
if [[ "$joined" == *"apply --server-side -f"* ]]; then
  if [[ "$joined" == *"/operator-deployment.yaml" ]]; then
    touch "$FAKE_OPERATOR_STATE"
    cp "\${@: -1}" "$FAKE_RENDERED_OPERATOR"
  fi
  if [[ "$joined" == *"/review-job-dispatcher.yaml" ]]; then touch "$FAKE_DISPATCHER_STATE"; fi
  exit 0
fi
exit 0
`);
  fs.writeFileSync(path.join(binaryDirectory, 'envsubst'), `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => process.stdout.write(input
  .replaceAll('\${CT_REVIEW_OPERATOR_IMAGE}', process.env.CT_REVIEW_OPERATOR_IMAGE || '')
  .replaceAll('\${KUBERNETES_SERVICE_IP}', process.env.KUBERNETES_SERVICE_IP || '')
  .replaceAll('\${KUBERNETES_API_ENDPOINT_CIDR}', process.env.KUBERNETES_API_ENDPOINT_CIDR || '')
  .replaceAll('\${KUBERNETES_API_CIDR}', process.env.KUBERNETES_API_CIDR || '')
  .replaceAll('\${CT_REVIEW_JOB_DISPATCHER_IMAGE}', process.env.CT_REVIEW_JOB_DISPATCHER_IMAGE || '')
  .replaceAll('\${CT_REVIEW_WORKER_IMAGE}', process.env.CT_REVIEW_WORKER_IMAGE || '')
  .replaceAll('\${CT_REVIEW_RUNNER_MODE}', process.env.CT_REVIEW_RUNNER_MODE || 'prebaked')));
`);
  fs.chmodSync(path.join(binaryDirectory, 'kubectl'), 0o755);
  fs.chmodSync(path.join(binaryDirectory, 'envsubst'), 0o755);

  const result = spawnSync('bash', ['scripts/install-doks-review-runtime.sh'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binaryDirectory}:${process.env.PATH || ''}`,
      FAKE_KUBECTL_LOG: logPath,
      FAKE_OPERATOR_STATE: statePath,
      FAKE_DISPATCHER_STATE: `${statePath}.dispatcher`,
      FAKE_RENDERED_OPERATOR: renderedOperatorPath,
      CT_REVIEW_OPERATOR_IMAGE: operatorImage,
      CT_REVIEW_JOB_DISPATCHER_IMAGE: dispatcherImage,
      CT_REVIEW_WORKER_IMAGE: workerImage,
      KUBERNETES_SERVICE_IP: '10.245.0.1',
      KUBERNETES_API_ENDPOINT_CIDR: '192.0.2.10/32',
      KUBERNETES_API_CIDR: '198.51.100.20/32',
      ...overrides,
    },
  });
  const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const renderedOperator = fs.existsSync(renderedOperatorPath)
    ? fs.readFileSync(renderedOperatorPath, 'utf8')
    : '';
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  return { ...result, calls, renderedOperator };
}

describe('guarded review runtime installer', () => {
  it('installs the CRD and both workloads while leaving qualification at zero replicas', () => {
    const result = runInstaller();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('installed at zero replicas');
    expect(result.calls).toContain('apply --server-side -f k8s-operator/config/crd/bases/review-yeti.ai_prreviewjobs.yaml');
    expect(result.calls).toContain('apply --server-side -f');
    expect(result.calls).not.toMatch(/\bscale\b|\bdelete\b/u);
    expect(result.renderedOperator).toContain(`image: ${operatorImage}`);
    expect(result.renderedOperator).toContain('replicas: 0');
    expect(result.renderedOperator).toContain('cidr: "192.0.2.10/32"');
    expect(result.renderedOperator).toContain('cidr: "198.51.100.20/32"');
    expect(result.renderedOperator).not.toContain('${');
  });

  it('installs with generic runner mode and accepts node:24-bookworm-slim', () => {
    const result = runInstaller({
      CT_REVIEW_RUNNER_MODE: 'generic',
      CT_REVIEW_WORKER_IMAGE: 'node:24-bookworm-slim',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain('apply --server-side -f');
  });

  it('rejects an active operator before any Kubernetes apply', () => {
    const result = runInstaller({ FAKE_ACTIVE_OPERATOR: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already has replicas=1');
    expect(result.calls).not.toContain('apply');
  });

  it('rejects mutable or untrusted images before any Kubernetes apply', () => {
    const result = runInstaller({ CT_REVIEW_WORKER_IMAGE: 'registry.example/review-yeti-worker:latest' });
    expect(result.status).toBe(2);
    expect(result.calls).not.toContain('apply');
  });

  it.each([
    ['operator', 'CT_REVIEW_OPERATOR_IMAGE', 'review-yeti-operator'],
    ['dispatcher', 'CT_REVIEW_JOB_DISPATCHER_IMAGE', 'review-yeti-bot'],
    ['worker', 'CT_REVIEW_WORKER_IMAGE', 'review-yeti-worker'],
  ])('rejects a DigitalOcean registry %s image before any Kubernetes apply', (_name, variable, repository) => {
    const result = runInstaller({ [variable]: `registry.digitalocean.com/example/${repository}@sha256:${'a'.repeat(64)}` });
    expect(result.status).toBe(2);
    expect(result.calls).not.toContain('apply');
  });

  it('rejects an incomplete runtime secret before any Kubernetes apply', () => {
    const result = runInstaller({ FAKE_SECRET_KEYS: 'DATABASE_URL' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('runtime secret must contain exactly');
    expect(result.calls).not.toContain('apply');
  });
});
