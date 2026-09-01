import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const operatorImage = `registry.digitalocean.com/calltelemetry/review-yeti-operator@sha256:${'a'.repeat(64)}`;
const dispatcherImage = `registry.digitalocean.com/calltelemetry/ct-review-bot@sha256:${'b'.repeat(64)}`;
const workerImage = `registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:${'c'.repeat(64)}`;

function runInstaller(overrides: Record<string, string> = {}) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doks-review-runtime-test-'));
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
if [[ "$joined" == *"get secret calltelemetry"* ]]; then exit 0; fi
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
  .replaceAll('\${CT_REVIEW_WORKER_IMAGE}', process.env.CT_REVIEW_WORKER_IMAGE || '')));
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
      KUBERNETES_API_ENDPOINT_CIDR: '100.65.15.150/32',
      KUBERNETES_API_CIDR: '104.248.111.134/32',
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

describe('guarded DOKS review runtime installer', () => {
  it('installs the CRD and both workloads while leaving qualification at zero replicas', () => {
    const result = runInstaller();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('installed at zero replicas');
    expect(result.calls).toContain('apply --server-side -f k8s-operator/config/crd/bases/review-yeti.ai_prreviewjobs.yaml');
    expect(result.calls).toContain('apply --server-side -f');
    expect(result.calls).not.toMatch(/\bscale\b|\bdelete\b/u);
    expect(result.renderedOperator).toContain(`image: ${operatorImage}`);
    expect(result.renderedOperator).toContain('replicas: 0');
    expect(result.renderedOperator).toContain('cidr: "100.65.15.150/32"');
    expect(result.renderedOperator).toContain('cidr: "104.248.111.134/32"');
    expect(result.renderedOperator).not.toContain('${');
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

  it('rejects an incomplete runtime secret before any Kubernetes apply', () => {
    const result = runInstaller({ FAKE_SECRET_KEYS: 'DATABASE_URL' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('runtime secret must contain exactly');
    expect(result.calls).not.toContain('apply');
  });
});
