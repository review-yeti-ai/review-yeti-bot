import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = new URL('..', import.meta.url).pathname;
const validatorPath = join(repoRoot, 'scripts', 'validate-transport-handoff.mjs');

function transport(name, overrides = {}) {
  return {
    name,
    enabled: true,
    base_url: `https://${name}.test/v1`,
    api_key_env: `${name.toUpperCase()}_API_KEY`,
    model: `${name}-model`,
    compat: 'openai',
    timeout_ms: 30_000,
    connect_timeout_ms: 10_000,
    ttft_ms: 20_000,
    stall_ms: 10_000,
    stream: true,
    ...overrides,
  };
}

function runValidator(
  policyTransports,
  handoffTransports = policyTransports,
  encodedPlan,
  allowPolicySubset = false,
  repository = '',
  repositoryOverrides = {},
) {
  const tempDir = mkdtempSync(join(tmpdir(), 'ct-transport-handoff-'));
  const policyPath = join(tempDir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify({
    review_yeti: { transports: policyTransports },
    repository_overrides: repositoryOverrides,
  }));

  const result = spawnSync(process.execPath, [validatorPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      REVIEW_YETI_POLICY_PATH: policyPath,
      REVIEW_REPOSITORY: repository,
      TRANSPORT_PLAN_B64: encodedPlan
        ?? Buffer.from(JSON.stringify(handoffTransports), 'utf8').toString('base64'),
      ALLOW_POLICY_SUBSET: String(allowPolicySubset),
    },
  });
  rmSync(tempDir, { recursive: true, force: true });
  return result;
}

test('accepts the exact policy handoff without pinning a transport count', () => {
  for (const count of [2, 3, 4]) {
    const transports = Array.from({ length: count }, (_, index) => transport(`provider-${index + 1}`));
    const result = runValidator(transports);
    assert.equal(result.status, 0, `count=${count}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stdout, new RegExp(`transport_plan_entries=${count} stream=true`));
  }
});

test('rejects a handoff whose order or content differs from policy', () => {
  const transports = [transport('primary'), transport('fallback')];
  const result = runValidator(transports, [...transports].reverse());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /transport handoff does not exactly match policy/);
});

test('accepts only an exact ordered policy subset for post-smoke admission', () => {
  const transports = [transport('primary'), transport('secondary'), transport('fallback')];
  const admitted = [transports[0], transports[2]];
  const accepted = runValidator(transports, admitted, undefined, true);
  assert.equal(accepted.status, 0, `stdout=${accepted.stdout}\nstderr=${accepted.stderr}`);

  for (const rejected of [
    [...admitted].reverse(),
    [{ ...transports[0], timeout_ms: 1 }],
    [transport('unknown')],
  ]) {
    const result = runValidator(transports, rejected, undefined, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /admitted transport handoff is not an exact ordered subset of policy/);
  }
});

test('accepts only a downward Synthetic quota-capacity clamp after smoke admission', () => {
  const primary = transport('primary');
  const synthetic = transport('synthetic', {
    max_in_flight: 5,
    quota_probe: 'synthetic-v2',
  });
  const clamped = [primary, { ...synthetic, max_in_flight: 2 }];
  const accepted = runValidator([primary, synthetic], clamped, undefined, true);
  assert.equal(accepted.status, 0, `stdout=${accepted.stdout}\nstderr=${accepted.stderr}`);

  for (const rejected of [
    [primary, { ...synthetic, max_in_flight: 6 }],
    [primary, { ...synthetic, timeout_ms: 1, max_in_flight: 2 }],
  ]) {
    const result = runValidator([primary, synthetic], rejected, undefined, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /admitted transport handoff is not an exact ordered subset of policy/);
  }
});

test('rejects a noncanonical base64 handoff instead of silently normalizing it', () => {
  const transports = [transport('primary'), transport('fallback')];
  const canonical = Buffer.from(JSON.stringify(transports), 'utf8').toString('base64');
  const result = runValidator(transports, transports, `${canonical}!`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /transport handoff must be canonical base64/);
});

test('rejects duplicate transport names even when the policy contains them', () => {
  const transports = [transport('duplicate'), transport('duplicate')];
  const result = runValidator(transports);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /transport names must be unique/);
});

test('rejects a non-streaming transport even when the policy contains it', () => {
  const transports = [transport('primary'), transport('fallback', { stream: false })];
  const result = runValidator(transports);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /all transports must stream/);
});

test('rejects a handoff that loses an explicit timing deadline', () => {
  for (const key of ['ttft_ms', 'stall_ms']) {
    const configured = transport('primary');
    const admitted = { ...configured };
    delete admitted[key];
    const result = runValidator([configured], [admitted], undefined, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`every transport must carry ${key}`));
  }
});

test('fails closed when a policy transport omits the enabled boolean', () => {
  const missingEnabled = transport('primary');
  delete missingEnabled.enabled;
  const result = runValidator([missingEnabled]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /every policy transport must declare enabled as a boolean/);
});

test('excludes disabled transports from the production handoff contract', () => {
  const enabled = transport('primary');
  const disabled = transport('diagnostic-only', { enabled: false });
  const result = runValidator([enabled, disabled], [enabled]);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
});

test('validates a repository-resolved transport handoff against the same override used by policy emission', () => {
  const openrouter = transport('openrouter-primary');
  const ollama = transport('ollama', { enabled: false });
  const repository = 'exampleorg/example-api';
  const overrides = {
    [repository]: {
      dispatch_mode: 'ordered',
      enabled_transports: ['ollama'],
    },
  };
  const resolvedOllama = { ...ollama, enabled: true };

  const result = runValidator(
    [openrouter, ollama],
    [resolvedOllama],
    undefined,
    false,
    repository,
    overrides,
  );

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /transport_plan_entries=1 stream=true/);

  const unresolved = runValidator(
    [openrouter, ollama],
    [resolvedOllama],
    undefined,
    false,
    '',
    overrides,
  );
  assert.notEqual(unresolved.status, 0);
  assert.match(unresolved.stderr, /transport handoff does not exactly match policy/);
});
