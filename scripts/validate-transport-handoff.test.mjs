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
    base_url: `https://${name}.test/v1`,
    api_key_env: `${name.toUpperCase()}_API_KEY`,
    model: `${name}-model`,
    compat: 'openai',
    timeout_ms: 30_000,
    connect_timeout_ms: 10_000,
    stream: true,
    ...overrides,
  };
}

function runValidator(policyTransports, handoffTransports = policyTransports, encodedPlan) {
  const tempDir = mkdtempSync(join(tmpdir(), 'ct-transport-handoff-'));
  const policyPath = join(tempDir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify({ review_yeti: { transports: policyTransports } }));

  const result = spawnSync(process.execPath, [validatorPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      REVIEW_YETI_POLICY_PATH: policyPath,
      TRANSPORT_PLAN_B64: encodedPlan
        ?? Buffer.from(JSON.stringify(handoffTransports), 'utf8').toString('base64'),
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
