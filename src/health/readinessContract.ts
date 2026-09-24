/**
 * The three `/ready` contracts in this image, named once.
 *
 * WHY THIS EXISTS (REL-1069 follow-up)
 *
 * `/ready` is served by THREE different implementations on the SAME path, chosen
 * by which entrypoint the process runs:
 *
 *   entrypoint                       | deployment                     | /ready means
 *   ---------------------------------|--------------------------------|----------------------
 *   dist/index.js                    | ct-review-live                 | app configuration
 *   dist/dispatchIndex.js            | ct-review-action-dispatch, mcp | database reachable
 *   dist/reviewJobDispatcherIndex.js | ct-review-job-dispatcher       | dispatch loop progress
 *
 * Those are LEGITIMATELY different questions -- a streaming viewer and a dispatch
 * loop cannot share one definition of "ready" -- but nothing said so, and only
 * one of the three named its own service in the body. An operator reading a 503
 * on `ct-review-live` could not tell whether configuration, the database, or the
 * loop was at fault, and could not tell which implementation had answered.
 *
 * This module does NOT unify the three checks: unifying them would force a
 * read-only viewer to satisfy a database probe it does not use, which is exactly
 * the mistake REL-1069 already made once by widening a pod's secret surface to
 * make a probe pass. It makes the distinction EXPLICIT and MACHINE-CHECKABLE, so
 * a consumer can tell the contracts apart and a fourth implementation cannot
 * appear unnoticed.
 */

/** Which question a given `/ready` implementation answers. */
export const READINESS_CONTRACTS = {
  /** Full app: can this process serve configured review work? */
  configuration: 'configuration',
  /** Dispatch: can this process reach its database? */
  database: 'database',
  /** Job dispatcher: is the dispatch loop making progress? */
  loop: 'loop',
} as const;

export type ReadinessContract = (typeof READINESS_CONTRACTS)[keyof typeof READINESS_CONTRACTS];

export interface ReadinessBody {
  readonly status: 'ready' | 'not_ready';
  /** Stable service identity, so a 503 names the implementation that produced it. */
  readonly service: string;
  /** Which of the three questions this response answers. */
  readonly readinessContract: ReadinessContract;
  readonly timestamp: string;
  readonly [key: string]: unknown;
}

/**
 * Build a readiness body that is self-identifying.
 *
 * Every `/ready` implementation MUST go through this, so `service` and
 * `readinessContract` are present and a consumer can branch on the contract
 * rather than guessing from whichever field happens to be set.
 */
/** Fields this module owns; `details` may not override them. */
const CANONICAL_KEYS = ['status', 'service', 'readinessContract', 'timestamp'] as const;

export function readinessBody(
  service: string,
  contract: ReadinessContract,
  ready: boolean,
  details: Record<string, unknown> = {},
): ReadinessBody {
  // Reject a collision rather than silently letting `details` win. Spreading
  // `details` last made the canonical fields overridable, and the index
  // signature on ReadinessBody means TypeScript cannot flag it at a call site --
  // so the invariant this module exists to enforce would hold only by
  // convention, at the one choke point created to make it structural
  // (REL-1069 review).
  for (const key of CANONICAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(details, key)) {
      throw new Error(
        `readiness details may not override the canonical field "${key}"; `
        + 'it is owned by readinessBody so every /ready body stays machine-checkable',
      );
    }
  }
  return {
    status: ready ? 'ready' : 'not_ready',
    service,
    readinessContract: contract,
    timestamp: new Date().toISOString(),
    ...details,
  };
}

/** HTTP status for a readiness verdict. Single mapping, so all three agree. */
export function readinessStatus(ready: boolean): number {
  return ready ? 200 : 503;
}
