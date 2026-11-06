import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPassthroughExemptRepository,
  mergeGroupOperatorPassthroughMode,
  reviewWorkflowPauseMode,
  shouldShortCircuitActionPassthrough,
} from '../src/passthroughAdmission.js';
import type { Env } from '../src/types.js';

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    PARALLEL_CHECK_NAME: 'Review Yeti',
    PILOT_REPOSITORIES: 'all',
    DEFAULT_WORKER_IMAGE: 'ghcr.io/example/worker:latest',
    ...overrides,
  } as Env;
}

describe('passthroughAdmission', () => {
  it('isPassthroughExemptRepository is case-insensitive and comma-separated', () => {
    assert.strictEqual(isPassthroughExemptRepository('Org/Repo', 'other,org/repo'), true);
    assert.strictEqual(isPassthroughExemptRepository('org/repo', ''), false);
    assert.strictEqual(isPassthroughExemptRepository('org/repo', '   '), false);
  });

  it('shouldShortCircuitActionPassthrough is fail-closed: empty exempt list with global true', () => {
    const env = baseEnv({ OPERATOR_GLOBAL_PASSTHROUGH: 'true' });
    assert.strictEqual(shouldShortCircuitActionPassthrough(env, 'any/org'), true);
  });

  it('shouldShortCircuitActionPassthrough skips short-circuit for listed repo', () => {
    const env = baseEnv({
      OPERATOR_GLOBAL_PASSTHROUGH: 'true',
      OPERATOR_PASSTHROUGH_EXEMPT_REPOSITORIES: 'review-yeti-ai/review-yeti-canary',
    });
    assert.strictEqual(
      shouldShortCircuitActionPassthrough(env, 'review-yeti-ai/review-yeti-canary'),
      false,
    );
    assert.strictEqual(shouldShortCircuitActionPassthrough(env, 'other/org'), true);
  });

  it('reviewWorkflowPauseMode runs semantic path for exempt repo even when global passthrough is true', () => {
    const env = baseEnv({
      OPERATOR_GLOBAL_PASSTHROUGH: 'true',
      OPERATOR_PASSTHROUGH_EXEMPT_REPOSITORIES: 'review-yeti-ai/review-yeti-canary',
    });
    assert.strictEqual(reviewWorkflowPauseMode(env, 'review-yeti-ai', 'review-yeti-canary'), 'false');
    assert.strictEqual(reviewWorkflowPauseMode(env, 'other', 'repo'), 'true');
  });

  it('mergeGroupOperatorPassthroughMode matches exempt repo behavior', () => {
    const env = baseEnv({
      OPERATOR_GLOBAL_PASSTHROUGH: 'true',
      OPERATOR_PASSTHROUGH_EXEMPT_REPOSITORIES: 'review-yeti-ai/review-yeti-canary',
    });
    assert.strictEqual(
      mergeGroupOperatorPassthroughMode(env, 'review-yeti-ai/review-yeti-canary'),
      false,
    );
    assert.strictEqual(mergeGroupOperatorPassthroughMode(env, 'other/org'), true);
  });
});
