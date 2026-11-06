/**
 * Operator passthrough exemption: when global pause is on, listed repositories
 * skip the passthrough short-circuit and run the normal semantic review path.
 *
 * Fail-closed: empty or unset OPERATOR_PASSTHROUGH_EXEMPT_REPOSITORIES means no
 * repo is exempt (everyone stays on passthrough when OPERATOR_GLOBAL_PASSTHROUGH is true).
 */
import type { Env } from './types.js';
import { isPassthroughMode } from './types.js';

export function isPassthroughExemptRepository(repoFullName: string, exemptList?: string): boolean {
  if (!repoFullName || typeof repoFullName !== 'string') return false;
  if (!exemptList || exemptList.trim() === '') return false;
  const key = repoFullName.trim().toLowerCase();
  const entries = exemptList
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  return entries.includes(key);
}

/**
 * True when the Action dispatch / webhook path should short-circuit to operator
 * passthrough receipt (no semantic review). Uses OPERATOR_GLOBAL_PASSTHROUGH only,
 * matching handleActionDispatch and related ingress.
 */
export function shouldShortCircuitActionPassthrough(env: Env, repoFullName: string): boolean {
  if (env.OPERATOR_GLOBAL_PASSTHROUGH !== 'true') return false;
  if (isPassthroughExemptRepository(repoFullName, env.OPERATOR_PASSTHROUGH_EXEMPT_REPOSITORIES)) return false;
  return true;
}

/**
 * Workflow pause step: same as historical ReviewJobWorkflow logic, then exempt repos
 * force the semantic path (pauseMode 'false').
 */
export function reviewWorkflowPauseMode(env: Env, owner: string, repo: string): string | undefined {
  const basePause = env.OPERATOR_GLOBAL_PASSTHROUGH !== undefined
    ? env.OPERATOR_GLOBAL_PASSTHROUGH
    : (isPassthroughMode(env) ? 'true' : undefined);
  const repoFull = `${owner}/${repo}`;
  if (basePause !== 'false' && isPassthroughExemptRepository(repoFull, env.OPERATOR_PASSTHROUGH_EXEMPT_REPOSITORIES)) {
    return 'false';
  }
  return basePause;
}

/**
 * Merge-queue / check verification: allow passthrough external_id only when the repo
 * is not exempt (exempt repos must show a real semantic review check shape).
 */
export function mergeGroupOperatorPassthroughMode(env: Env, repoFullName: string): boolean {
  if (env.OPERATOR_GLOBAL_PASSTHROUGH !== 'true') return false;
  if (isPassthroughExemptRepository(repoFullName, env.OPERATOR_PASSTHROUGH_EXEMPT_REPOSITORIES)) return false;
  return true;
}
