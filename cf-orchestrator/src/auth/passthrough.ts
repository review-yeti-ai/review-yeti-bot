import type { Env } from '../types.js';

export const OPERATOR_PASSTHROUGH_REVIEW_TITLE = 'Review Yeti: SHIP (passthrough: no review performed)';
export const OPERATOR_PASSTHROUGH_GATE_TITLE = 'Review Yeti Gate: SHIP (operator passthrough SHIP)';
export const OPERATOR_PASSTHROUGH_MODE_MARKER = 'review-mode=passthrough';
export const OPERATOR_PASSTHROUGH_ZERO_LANES_MARKER = 'Zero review lanes ran.';

/**
 * Evaluates whether the environment is configured in operator passthrough mode.
 * Supports OPERATOR_GLOBAL_PASSTHROUGH, REVIEW_YETI_PASSTHROUGH, and PASSTHROUGH_MODE.
 */
export function isPassthroughMode(env?: Partial<Env> | Record<string, any>): boolean {
  if (!env) return false;
  return (
    env.OPERATOR_GLOBAL_PASSTHROUGH === 'true' ||
    env.REVIEW_YETI_PASSTHROUGH === 'true' ||
    env.PASSTHROUGH_MODE === 'true'
  );
}
