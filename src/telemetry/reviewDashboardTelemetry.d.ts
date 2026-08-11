export type ReviewEventStatus = 'completed' | 'failed' | 'incomplete';
export type ReviewVerdict = 'SHIP' | 'FIX_FIRST' | 'BLOCK';
export type EnforcementMode = 'advisory' | 'block_on_block' | 'block_non_ship';

export interface ReviewDashboardEvent {
  schemaVersion: '1.0';
  eventId: string;
  eventType: 'review.completed' | 'review.failed';
  occurredAt: string;
  producer: { name: 'ct-review-bot'; version: string };
  repository: { fullName: string };
  pullRequest: { number: number; title: string; url: string; headSha: string; baseSha?: string };
  workflow: { runId: string; runAttempt: number; url: string; trigger: string };
  review: Record<string, unknown>;
}

export interface ReviewDashboardDeliveryResult {
  status: 'skipped' | 'accepted' | 'duplicate' | 'failed';
  attempts: number;
  reason?: string;
}

export function createReviewEventId(input: Record<string, unknown>): string;
export const createEventId: typeof createReviewEventId;
export function buildReviewEvent(options?: Record<string, unknown>, env?: NodeJS.ProcessEnv): ReviewDashboardEvent;
export function validateReviewEvent(event: unknown): string[];
export function markReviewEventFailed(event: ReviewDashboardEvent, completedAt?: string | number | Date): ReviewDashboardEvent;
export function deliverReviewEvent(options?: {
  event?: unknown;
  apiKey?: string;
  url?: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, 'info' | 'warn'>;
  wait?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  retryDelayMs?: number;
}): Promise<ReviewDashboardDeliveryResult>;
export function redactSensitiveText(value: unknown, maxLength?: number): string;
