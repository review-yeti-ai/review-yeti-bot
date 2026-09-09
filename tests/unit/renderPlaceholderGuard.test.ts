import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const guardLibrary = path.join(root, 'scripts/lib/assert-rendered.sh');

/**
 * Runs assert_no_unsubstituted_placeholders against a file containing `body`.
 *
 * The guard is the sole enforcement for the defect this suite exists to prevent:
 * envsubst copies `${VAR:-default}` through verbatim, the literal lands in a live
 * ConfigMap, server-side apply accepts it, the rollout goes green, and the flag
 * reads false. Its whole value is the failure path, so that path is asserted
 * directly rather than inferred from the call sites.
 */
function runGuard(body: string): { status: number; stdout: string; stderr: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'render-guard-'));
  const target = path.join(directory, 'rendered.yaml');
  fs.writeFileSync(target, body);
  const result = spawnSync(
    'bash',
    ['-c', `set -euo pipefail; source "${guardLibrary}"; assert_no_unsubstituted_placeholders "${target}" render-guard-test`],
    { encoding: 'utf8' },
  );
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('assert_no_unsubstituted_placeholders', () => {
  it('rejects the shell-default form envsubst silently ignores', () => {
    const result = runGuard('data:\n  FLAG: "${ACTION_DISPATCH_ALLOW_APP_GATE:-false}"\n');
    expect(result.status).toBe(2);
    // The operator must be told which line, or the guard is a bare "no" with no lead.
    expect(result.stderr).toContain('ACTION_DISPATCH_ALLOW_APP_GATE:-false');
    expect(result.stderr).toContain('2:');
    // Diagnostics on stderr only: stdout is reserved for the renderer's own output,
    // and a guard that pollutes it corrupts any caller that pipes a rendered manifest.
    expect(result.stdout).toBe('');
  });

  it('explains why the form fails, not merely that it did', () => {
    const result = runGuard('a: "${VAR:-x}"\n');
    expect(result.stderr).toContain('envsubst expands bare ${VAR} only');
  });

  it('passes a fully substituted file silently', () => {
    const result = runGuard('data:\n  FLAG: "true"\n  IMAGE: ghcr.io/example@sha256:abc\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('reports every leftover, not just the first', () => {
    const result = runGuard('a: "${ONE}"\nb: ok\nc: "${TWO:-d}"\ne: "${THREE}"\n');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('${ONE}');
    expect(result.stderr).toContain('${TWO:-d}');
    expect(result.stderr).toContain('${THREE}');
  });

  it('does not false-positive on a bare dollar or brace', () => {
    const result = runGuard('cmd: "echo $HOME and { json: 1 } and 100% $"\n');
    expect(result.status).toBe(0);
  });

  it('accepts an empty rendered file', () => {
    const result = runGuard('');
    expect(result.status).toBe(0);
  });
});

describe('deploy-action-dispatch.sh render guard', () => {
  /**
   * Integration cover for the call site. Without this, a refactor that drops the
   * guard or ignores its status keeps every unit test above green while
   * re-enabling the original defect.
   */
  function runDeployWithTemplate(templateBody: string) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-guard-'));
    const binaries = path.join(workspace, 'bin');
    const kubectlLog = path.join(workspace, 'kubectl.log');
    fs.mkdirSync(binaries);
    fs.mkdirSync(path.join(workspace, 'k8s'));
    fs.cpSync(path.join(root, 'scripts'), path.join(workspace, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'k8s/action-dispatch.yaml.tpl'), templateBody);
    fs.writeFileSync(path.join(workspace, 'k8s/namespace.yaml'), 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ct-review-system\n');
    fs.writeFileSync(
      path.join(binaries, 'kubectl'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${kubectlLog}"\nexit 0\n`,
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
      },
    });
    const applied = fs.existsSync(kubectlLog) ? fs.readFileSync(kubectlLog, 'utf8') : '';
    return { result, applied };
  }

  it('aborts before touching the cluster when a placeholder survives the render', () => {
    const { result, applied } = runDeployWithTemplate(
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\ndata:\n  ACTION_DISPATCH_ALLOW_APP_GATE: "${ACTION_DISPATCH_ALLOW_APP_GATE:-false}"\n',
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unsubstituted placeholder');
    // The point of the guard: nothing reached the cluster, not even the namespace.
    expect(applied).toBe('');
  });

  it('proceeds to apply when the template uses the bare form', () => {
    const { result, applied } = runDeployWithTemplate(
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\ndata:\n  ACTION_DISPATCH_ALLOW_APP_GATE: "${ACTION_DISPATCH_ALLOW_APP_GATE}"\n',
    );
    expect(result.status).toBe(0);
    expect(applied).toContain('apply --server-side -f');
  });
});
