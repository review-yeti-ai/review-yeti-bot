import type { WorkerFailureClass } from '../types/workerFailure';

export function classifyWorkerFailureMessage(error: unknown): WorkerFailureClass;
export function classifyProviderResponseStatus(status: unknown): 'auth' | 'rate_limit' | 'provider_error' | undefined;
export function classifyLaneFailure(lane?: { status?: unknown; error?: unknown }): WorkerFailureClass;

export const INFRASTRUCTURE_LANE_FAILURE_CLASSES: readonly ['transport', 'provider_error', 'rate_limit', 'timeout'];
export const INCOMPLETE_INFRASTRUCTURE_REASON: 'lane_infrastructure_incomplete';

/** Structural subset of `WorkerReviewResult` the shared decision reads. Kept
 * structural so this pure module imports nothing from the completion boundary. */
export interface InfrastructureIncompleteResultShape {
  personas: ReadonlyArray<{
    decision: string;
    status?: string;
    errorClass?: string;
    findings: readonly unknown[];
    evidenceSource?: string;
  }>;
  coverageComplete: boolean;
  quorumSatisfied: boolean;
  failureDiagnostics?: { reason?: string; recoverableIncompletePanel?: boolean };
}
export function isInfrastructureIncompleteResult(result: InfrastructureIncompleteResultShape | null | undefined): boolean;

/** One failed lane as a title/summary describes it: identity, coded class and,
 * when one was observed, the provider HTTP status. Never free text. */
export interface IncompleteLaneDescription {
  id: string;
  failureClass: string;
  providerStatus?: number;
}
export function laneProviderStatus(error: unknown): number | undefined;

export const MAX_CHECK_RUN_TITLE_CHARACTERS: number;
export const INCOMPLETE_INFRASTRUCTURE_TITLE_PREFIX: 'Review Yeti: INCOMPLETE — infrastructure (';
export const MAX_INCOMPLETE_INFRASTRUCTURE_DETAIL_CHARACTERS: number;
export function formatIncompleteInfrastructureTitle(
  detail: string,
  retry?: { nextAttempt: number; maxAttempts: number },
): string;
export function renderIncompleteInfrastructureTitle(
  lanes: readonly IncompleteLaneDescription[],
  retry?: { nextAttempt: number; maxAttempts: number },
): string;

export const TRANSPORT_MAX_RETRIES: number;
export const TRANSPORT_RETRY_BASE_DELAY_MS: number;
export const TRANSPORT_RETRY_FACTOR: number;
export const TRANSPORT_RETRY_MAX_DELAY_MS: number;
export const TRANSPORT_RETRY_WINDOW_MS: number;
export const TRANSPORT_RETRY_TERMINAL_MARGIN_MS: number;
export function transportRetryDelayMs(attempt: number, random?: () => number): number;
export const TRANSIENT_GATEWAY_STATUSES: ReadonlySet<number>;
export function isTransientGatewayMessage(message: unknown): boolean;
export function isNonRetryableClientStatus(statusOrMessage: unknown): boolean;
