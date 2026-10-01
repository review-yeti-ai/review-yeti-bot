/**
 * Dependency-neutral vocabulary for the durable dispatch outbox.
 *
 * Repository writers and read-only status projections import this module so
 * neither layer needs to depend on the other's implementation graph.
 */
export const REVIEW_DISPATCH_OUTBOX_STATUS = {
  pending: 'pending',
  claimed: 'claimed',
  projected: 'projected',
  terminal: 'terminal',
} as const;

export type ReviewDispatchOutboxStatus =
  typeof REVIEW_DISPATCH_OUTBOX_STATUS[keyof typeof REVIEW_DISPATCH_OUTBOX_STATUS];
