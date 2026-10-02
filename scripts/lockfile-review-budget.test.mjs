import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildExecutionPlanFixture } from './emit-execution-plan.mjs';
import { validateLockfileReviewBudget } from './lockfile-review-budget.mjs';
import { validatePolicy } from './review-yeti-smoke.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const committedPolicy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
const policyWith = (value) => {
  const policy = structuredClone(committedPolicy);
  if (value === undefined) delete policy.review_yeti.budget.max_reviewed_lockfile_patch_chars;
  else policy.review_yeti.budget.max_reviewed_lockfile_patch_chars = value;
  return policy;
};

test('the shared validator rejects malformed budget containers itself', () => {
  for (const budget of [undefined, null, false, true, 65_536, 'budget', []]) {
    assert.throws(() => validateLockfileReviewBudget(budget), /review_yeti.budget must be an object/);
    const policy = policyWith(undefined);
    policy.review_yeti.budget = budget;
    assert.throws(() => validatePolicy(policy), /review_yeti.budget must be an object/);
    assert.throws(() => buildExecutionPlanFixture(policy), /budget must be an object/);
  }
  assert.doesNotThrow(() => validateLockfileReviewBudget({}));
});

test('accepts only the optional bounded numeric worker setting at both policy entrypoints', () => {
  for (const value of [undefined, 20_000, 56_544, 65_536]) {
    const policy = policyWith(value);
    assert.doesNotThrow(() => validateLockfileReviewBudget(policy.review_yeti.budget));
    assert.doesNotThrow(() => validatePolicy(policy));
    assert.doesNotThrow(() => buildExecutionPlanFixture(policy));
  }
  for (const value of [null, false, true, '65536', 19_999, 65_537, 56_544.5, {}, [], Number.MAX_SAFE_INTEGER, NaN, Infinity]) {
    const policy = policyWith(value);
    for (const validate of [
      () => validateLockfileReviewBudget(policy.review_yeti.budget),
      () => validatePolicy(policy),
      () => buildExecutionPlanFixture(policy),
    ]) {
      assert.throws(validate, /max_reviewed_lockfile_patch_chars must be a numeric integer between 20000 and 65536/);
    }
  }
});

test('does not expose the worker setting in credential-free transport plans or alter legacy plan digests', () => {
  const legacy = buildExecutionPlanFixture(policyWith(undefined));
  for (const value of [20_000, 65_536]) {
    const configured = buildExecutionPlanFixture(policyWith(value));
    assert.deepEqual(configured, legacy);
    assert.equal(JSON.stringify(configured).includes('max_reviewed_lockfile_patch_chars'), false);
  }
  const policy = policyWith(65_536);
  policy.review_yeti.budget.unexpected = true;
  assert.throws(() => buildExecutionPlanFixture(policy), /budget contains unknown keys: unexpected/);
});

test('the checked-in policy admits the 65,536 cap without forwarding it to the action caller', (t) => {
  const budget = committedPolicy.review_yeti.budget;
  assert.equal(budget.max_reviewed_lockfile_patch_chars, 65_536);
  assert.doesNotThrow(() => validateLockfileReviewBudget(budget));
  assert.doesNotThrow(() => validatePolicy(committedPolicy));

  const executionPlan = buildExecutionPlanFixture(committedPolicy);
  assert.equal(JSON.stringify(executionPlan).includes('max_reviewed_lockfile_patch_chars'), false);

  const root = mkdtempSync(join(tmpdir(), 'review-lockfile-budget-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'outputs');
  writeFileSync(output, '');
  const result = spawnSync(process.execPath, [join(scripts, 'emit-policy.mjs')], {
    env: { PATH: dirname(process.execPath), GITHUB_OUTPUT: output },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const emitted = readFileSync(output, 'utf8');
  assert.match(emitted, /^action_ref<</m);
  assert.equal(emitted.includes('max_reviewed_lockfile_patch_chars'), false);
});

test('the actual policy emitter validates the setting before emitting any outputs and never forwards it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'review-lockfile-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(scripts, join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'policy'));
  const output = join(root, 'outputs');
  for (const value of [undefined, 20_000, 65_536, null, '65536', 19_999, 65_537, 25_000.5]) {
    writeFileSync(join(root, 'policy', 'review-yeti.json'), JSON.stringify(policyWith(value)));
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'emit-policy.mjs')], {
      env: { PATH: dirname(process.execPath), GITHUB_OUTPUT: output },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    const emitted = readFileSync(output, 'utf8');
    if (value === undefined || value === 20_000 || value === 65_536) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(emitted, /^action_ref<</m);
      assert.equal(emitted.includes('max_reviewed_lockfile_patch_chars'), false);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /max_reviewed_lockfile_patch_chars must be a numeric integer between 20000 and 65536/);
      assert.equal(emitted, '');
    }
  }
});
