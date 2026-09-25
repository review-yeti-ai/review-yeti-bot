import {
  classifyProviderResponseStatus,
  classifyWorkerFailureMessage,
  INFRASTRUCTURE_LANE_FAILURE_CLASSES,
  laneProviderStatus,
  type IncompleteLaneDescription,
} from './laneInfrastructure';
import type { WorkerFailureClass } from '../types/workerFailure';

/**
 * REL-1124: a panel that THROWS on infrastructure is the same outcome as a panel that RETURNS with
 * infrastructure-failed lanes (REL-1113), and must reach the same shared decision
 * (`isInfrastructureIncompleteResult`): a bounded re-attempt, then
 * "Review Yeti: INCOMPLETE — infrastructure (...)", never a verdict.
 *
 * Three shapes throw instead of returning, and before this module every one of them ended as
 * "Failed live ct-review-bot review dispatch" with no re-attempt (21 such failures on 2026-09-24):
 * - a REQUIRED lane (sec-lane) that failed on transport: `executePersonaPanel` throws
 *   "required persona failure: …";
 * - the moderator or the arbiter failing on transport ("arbiter failed closed: …");
 * - a raw gateway error (`fetch failed`, `terminated`, a 5xx) escaping the panel.
 *
 * The panel attaches structured, text-free evidence to what it throws (`attachPanelFailureEvidence`):
 * which lanes/stages failed, with which coded class, and whether any completed lane had reported a
 * finding. The publishing worker marks everything its panel runner rejects with
 * (`markThrownByPanel`), so a failure BEFORE the panel -- a GitHub diff read that says
 * "fetch failed" -- is never mistaken for a reviewer lane lost to the gateway.
 *
 * `thrownPanelInfrastructureFailure` is the one decision over those two marks. It is deliberately
 * narrower than the returned-panel path: an unmarked error, a cancellation, a finding anywhere, or
 * any non-infrastructure class keeps the pre-existing terminal failure unchanged.
 */

/** Where in the panel the throw happened. */
export type ThrownPanelStage = 'lanes' | 'moderator' | 'arbiter';

/** One failed lane or panel stage: identity, coded class, provider HTTP status when observed. */
export interface ThrownPanelLane {
  id: string;
  failureClass: WorkerFailureClass;
  providerStatus?: number;
}

/** Structured evidence the panel attaches to what it throws. Never carries free-form text. */
export interface PanelFailureEvidence {
  stage: ThrownPanelStage;
  lanes: ThrownPanelLane[];
  /** True when any lane that DID complete reported a finding (or the moderator did). A finding is
   * evidence about the code: such a run is never re-rolled as infrastructure. */
  findingsObserved: boolean;
}

/** The thrown failure, as the INCOMPLETE title/summary and the shared decision consume it. */
export interface ThrownPanelInfrastructureFailure {
  stage: ThrownPanelStage | 'panel';
  /** Coded class published for every lane of the result (the first failed lane's). */
  failureClass: WorkerFailureClass;
  incompleteLanes: IncompleteLaneDescription[];
  providerStatus?: number;
}

const EVIDENCE = Symbol.for('review-yeti.rel1124.panel-failure-evidence');
const THROWN_BY_PANEL = Symbol.for('review-yeti.rel1124.thrown-by-panel');

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function define(target: object, key: symbol, value: unknown): void {
  try {
    Object.defineProperty(target, key, { value, enumerable: false, configurable: true, writable: false });
  } catch {
    // A frozen or exotic rejection value keeps its original behaviour: no mark, no evidence.
  }
}

/** Attach panel failure evidence to a thrown error (non-enumerable: never serialized). */
export function attachPanelFailureEvidence<T>(error: T, evidence: PanelFailureEvidence): T {
  if (isObject(error)) define(error, EVIDENCE, Object.freeze({ ...evidence, lanes: evidence.lanes.map((lane) => ({ ...lane })) }));
  return error;
}

/** The evidence a panel attached, if any. */
export function panelFailureEvidenceOf(error: unknown): PanelFailureEvidence | undefined {
  return isObject(error) ? (error as Record<symbol, PanelFailureEvidence | undefined>)[EVIDENCE] : undefined;
}

/** Mark a rejection as coming from the review panel runner (and not from setup, source reads, or
 * publication). Returns the same value so it can be rethrown unchanged. */
export function markThrownByPanel<T>(error: T): T {
  if (isObject(error)) define(error, THROWN_BY_PANEL, true);
  return error;
}

export function isThrownByPanel(error: unknown): boolean {
  return isObject(error) && (error as Record<symbol, unknown>)[THROWN_BY_PANEL] === true;
}

/**
 * The ONE predicate for "this coded lane failure class is the path to the model". The panel uses
 * it to decide whether to throw `PanelInfrastructureError`, and the decision below uses it to route
 * that same throw to INCOMPLETE, so the two can never disagree.
 */
export function isInfrastructureFailureClass(value: unknown): value is WorkerFailureClass {
  return (INFRASTRUCTURE_LANE_FAILURE_CLASSES as readonly string[]).includes(String(value));
}

/** Cancellations and panel deadlines are not gateway failures, whatever their message says. */
function isCancellation(error: unknown): boolean {
  const name = isObject(error) ? String((error as { name?: unknown }).name ?? '') : '';
  return name === 'PanelCancellationError' || name === 'PanelDeadlineExceededError' || name === 'AbortError'
    || name === 'ReviewSupersededError';
}

/**
 * The class of an UNMARKED-by-evidence error the panel runner rejected with, when -- and only
 * when -- it is unambiguously the path to the model: a typed gateway HTTP status of 429 or 5xx,
 * the `provider_5xx` reason, or the shared transport message ladder (refused/reset connection,
 * `fetch failed`, `terminated`). A bare "timed out" or a message that merely mentions a provider
 * is NOT accepted here: without lane evidence it cannot be told from a panel-level deadline or a
 * configuration error.
 */
function rawGatewayClass(error: unknown): { failureClass: WorkerFailureClass; providerStatus?: number } | undefined {
  const status = isObject(error) ? Number((error as { status?: unknown }).status) : Number.NaN;
  if (Number.isInteger(status) && (status === 429 || (status >= 500 && status <= 599))) {
    return { failureClass: classifyProviderResponseStatus(status) ?? 'provider_error', providerStatus: status };
  }
  // Any other HTTP error status (a 413, a 401) fails the same way on a fresh attempt, whatever
  // transport words its message also carries.
  if (Number.isInteger(status) && status >= 400 && status <= 599) return undefined;
  if (isObject(error) && (error as { failureReason?: unknown }).failureReason === 'provider_5xx') {
    const providerStatus = laneProviderStatus(error);
    return { failureClass: 'provider_error', ...(providerStatus === undefined ? {} : { providerStatus }) };
  }
  if (classifyWorkerFailureMessage(error) === 'transport') return { failureClass: 'transport' };
  return undefined;
}

function dedupe(lanes: readonly ThrownPanelLane[]): IncompleteLaneDescription[] {
  const seen = new Set<string>();
  const out: IncompleteLaneDescription[] = [];
  for (const lane of lanes) {
    const key = `${lane.id}\u0000${lane.failureClass}\u0000${lane.providerStatus ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: lane.id, failureClass: lane.failureClass,
      ...(lane.providerStatus === undefined ? {} : { providerStatus: lane.providerStatus }) });
  }
  return out;
}

/**
 * REL-1124: the one decision that a THROWN panel failure is infrastructure-incomplete.
 * `undefined` keeps the pre-existing terminal failure (never a verdict either way).
 */
export function thrownPanelInfrastructureFailure(
  error: unknown,
  context: { aborted?: boolean } = {},
): ThrownPanelInfrastructureFailure | undefined {
  if (!isThrownByPanel(error) || context.aborted === true || isCancellation(error)) return undefined;
  const evidence = panelFailureEvidenceOf(error);
  if (evidence) {
    if (evidence.findingsObserved) return undefined;
    if (evidence.lanes.length === 0 || !evidence.lanes.every((lane) => isInfrastructureFailureClass(lane.failureClass))) return undefined;
    const incompleteLanes = dedupe(evidence.lanes);
    // One lane describes the run: the first that carries a provider status (the most specific
    // evidence), else the first. Its class and its status are published together, never mixed.
    const primary = incompleteLanes.find((lane) => lane.providerStatus !== undefined) ?? incompleteLanes[0];
    return {
      stage: evidence.stage,
      failureClass: primary.failureClass as WorkerFailureClass,
      incompleteLanes,
      ...(primary.providerStatus === undefined ? {} : { providerStatus: primary.providerStatus }),
    };
  }
  const raw = rawGatewayClass(error);
  if (!raw) return undefined;
  return {
    stage: 'panel',
    failureClass: raw.failureClass,
    incompleteLanes: [{ id: 'panel', failureClass: raw.failureClass,
      ...(raw.providerStatus === undefined ? {} : { providerStatus: raw.providerStatus }) }],
    ...(raw.providerStatus === undefined ? {} : { providerStatus: raw.providerStatus }),
  };
}

/** Build one lane's evidence from what the panel observed: its coded class when the lane assigned
 * one, otherwise the shared message ladder; the provider status from the lane error text. */
export function thrownPanelLane(id: string, failureClass: WorkerFailureClass | undefined, error: unknown): ThrownPanelLane {
  const providerStatus = (isObject(error) && Number.isInteger(Number((error as { status?: unknown }).status))
    && Number((error as { status?: unknown }).status) >= 400 && Number((error as { status?: unknown }).status) <= 599)
    ? Number((error as { status?: unknown }).status)
    : laneProviderStatus(error);
  return {
    id,
    failureClass: failureClass ?? classifyWorkerFailureMessage(error),
    ...(providerStatus === undefined ? {} : { providerStatus }),
  };
}

/**
 * REL-1124: the bounded diagnostics a thrown infrastructure failure reports -- the same shape the
 * returned-panel path (REL-1113) reports: the shared reason, the provider status when observed,
 * and a coded lane list, never the thrown error's free-form text.
 */
export function thrownInfrastructureDiagnostics(
  failure: ThrownPanelInfrastructureFailure,
  reason: string,
  redact: (text: string) => string,
): { reason: string; providerStatus?: number; logTail: string; recoverableIncompletePanel: true } {
  return {
    reason,
    ...(failure.providerStatus === undefined ? {} : { providerStatus: failure.providerStatus }),
    logTail: redact(`${failure.stage === 'lanes' ? 'lanes' : failure.stage} did not complete: ${failure.incompleteLanes
      .map((lane) => `${lane.id}=${lane.failureClass}${lane.providerStatus === undefined ? '' : `/${lane.providerStatus}`}`)
      .join(', ')}`),
    recoverableIncompletePanel: true,
  };
}

/**
 * REL-1124: the lane coverage a thrown infrastructure failure honestly supports, for the worker's
 * receipt. Only a lane-stage throw names reviewer lanes that failed; a moderator or arbiter throw
 * happened after every reviewer lane had completed; a raw panel throw carries no lane count at all.
 */
export function thrownInfrastructureLaneCoverage(
  failure: ThrownPanelInfrastructureFailure,
  expectedLaneCount: number | null,
): { completedLaneCount: number; failedLaneCount: number } {
  if (failure.stage === 'lanes') {
    const failedLaneCount = failure.incompleteLanes.length;
    return { failedLaneCount, completedLaneCount: expectedLaneCount === null ? 0 : Math.max(0, expectedLaneCount - failedLaneCount) };
  }
  if (failure.stage === 'moderator' || failure.stage === 'arbiter') {
    return { failedLaneCount: 0, completedLaneCount: expectedLaneCount ?? 0 };
  }
  return { failedLaneCount: 0, completedLaneCount: 0 };
}
