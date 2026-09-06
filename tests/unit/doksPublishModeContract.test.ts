import { describe, expect, it } from 'vitest';
import { buildDispatchRequest } from '../../scripts/dispatch-doks-action.mjs';

/**
 * The set of publish modes this action accepts is a cross-repository contract.
 * `calltelemetry/ct-review-actions` re-encodes it in `emit-policy.mjs` as a local
 * literal, because the two repositories share no import path and this action is
 * `uses:`-resolved into $GITHUB_ACTION_PATH only at step runtime — too late for a
 * consumer to read at policy load, and a network fetch would put an external
 * dependency inside a required check.
 *
 * That drift already cost an outage (REL-601): the consumer gated on `enabled`, a
 * value this action rejects, so the recovery path its own error message documented
 * passed policy load and hard-failed at dispatch.
 *
 * Since the consumer cannot verify us, the contract is pinned here — and pinned
 * *behaviourally*. An earlier version of this file asserted only that the rejection
 * strings appeared in the source, which would still have passed if a third accepted
 * mode were added alongside them: precisely the drift it existed to catch.
 */
function environment(publishMode: string): Record<string, string> {
  return {
    REPOSITORY: 'calltelemetry/ct-meta',
    DOKS_PUBLISH_MODE: publishMode,
    GITHUB_EVENT_NAME: 'pull_request_target',
    REPOSITORY_ID: '1339040553',
    PR_NUMBER: '2795',
    GITHUB_RUN_ID: '34004307357',
    GITHUB_RUN_ATTEMPT: '1',
    HEAD_SHA: 'a'.repeat(40),
    BASE_SHA: 'b'.repeat(40),
    ACTION_SHA: 'c'.repeat(40),
  };
}

const ACCEPTED = ['disabled', 'app-gate'];

describe('DOKS publish-mode contract (cross-repository, behavioural)', () => {
  it.each(ACCEPTED)('accepts %s', (mode) => {
    expect(buildDispatchRequest(environment(mode)).publishMode).toBe(mode);
  });

  it('rejects "enabled", the value that caused REL-601', () => {
    expect(() => buildDispatchRequest(environment('enabled')))
      .toThrow(/publish mode must be disabled or app-gate/u);
  });

  it('rejects every mode outside the accepted set', () => {
    // Exhaustive over plausible drift rather than a spot check: a third admitted
    // mode fails here even if the two existing comparisons are left intact.
    const candidates = [
      'enabled', 'on', 'true', 'publish', 'app_gate', 'App-Gate', 'APP-GATE',
      'gate', 'appgate', 'neutral', 'app-gate;rm', 'null', 'undefined', '0', '1',
    ];
    for (const mode of candidates) {
      expect(() => buildDispatchRequest(environment(mode)),
        `publish mode "${mode}" must be rejected`).toThrow();
    }
  });

  it('normalises surrounding whitespace rather than rejecting it', () => {
    // The implementation trims before comparing. Asserting that explicitly keeps a
    // padded value from looking like an accidentally-admitted third mode.
    expect(buildDispatchRequest(environment(' app-gate ')).publishMode).toBe('app-gate');
    expect(buildDispatchRequest(environment('disabled ')).publishMode).toBe('disabled');
  });

  it('treats an unset mode as disabled, never as publishing', () => {
    // The documented default. A missing value must never fall open to publishing.
    // The variable is *deleted*, not set empty: a regression that defaulted a truly
    // absent variable to a publishing mode while still mapping '' to 'disabled'
    // would pass an empty-string test and leave this safety property unpinned.
    const absent = environment('');
    delete absent.DOKS_PUBLISH_MODE;
    expect(buildDispatchRequest(absent).publishMode).toBe('disabled');
    expect(buildDispatchRequest(environment('')).publishMode).toBe('disabled');
  });

  it('validates the mode before any other required field', () => {
    // Observable ordering rather than a restatement of the throw: corrupt the fields
    // validated *after* publishMode (repository id, pr number, shas) and assert the
    // publish-mode error still wins. If the check moved below them, the error would
    // name one of those fields instead.
    const alsoInvalid = {
      ...environment('enabled'),
      REPOSITORY_ID: 'not-a-number',
      PR_NUMBER: '-1',
      HEAD_SHA: 'nope',
      BASE_SHA: '',
    };
    expect(() => buildDispatchRequest(alsoInvalid))
      .toThrow(/publish mode must be disabled or app-gate/u);
  });
});
