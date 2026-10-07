import { z } from 'zod';

export const GROUNDED_VERIFIER_ROUTE_VERSION = 'GroundedVerifierRoute.v1' as const;

const boundedModel = z.string().min(1).max(200);

/** Content-free route receipt; it distinguishes configuration, selected route and untrusted response claims. */
export const groundedVerifierRouteV1Schema = z.object({
  version: z.literal(GROUNDED_VERIFIER_ROUTE_VERSION),
  purpose: z.enum(['primary', 'disputed-blocker-recheck']),
  requestedRole: z.enum(['primary', 'disputed-blocker-adjudicator']),
  appliedRole: z.enum(['primary', 'disputed-blocker-adjudicator']),
  configuredAlternateModel: boundedModel.nullable(),
  selectedModel: boundedModel,
  responseReportedModel: boundedModel.nullable(),
  responseModelUnavailableReason: z.string().min(1).max(500).nullable(),
  upstreamIdentity: z.object({ providerId: z.null(), model: z.null(), unavailableReason: z.string().min(1).max(500) }).strict(),
}).strict().superRefine((route, context) => {
  if ((route.responseReportedModel === null) !== (route.responseModelUnavailableReason !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['responseModelUnavailableReason'],
      message: 'unavailable response-model claims require a reason' });
  }
  if (route.purpose === 'primary' && (route.requestedRole !== 'primary' || route.appliedRole !== 'primary')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['purpose'], message: 'primary purpose must use the primary role' });
  }
  if (route.purpose === 'disputed-blocker-recheck' && route.requestedRole !== 'disputed-blocker-adjudicator') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['requestedRole'], message: 'disputed rechecks request adjudicator role' });
  }
  if (route.appliedRole === 'disputed-blocker-adjudicator'
    && (!route.configuredAlternateModel || route.selectedModel !== route.configuredAlternateModel
      || route.purpose !== 'disputed-blocker-recheck')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['appliedRole'],
      message: 'adjudicator route must select the configured model for a disputed recheck' });
  }
  if (route.purpose === 'disputed-blocker-recheck' && route.configuredAlternateModel === null
    && (route.appliedRole !== 'primary' || route.requestedRole !== 'disputed-blocker-adjudicator')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['configuredAlternateModel'],
      message: 'unconfigured adjudicator fallback must remain on primary role' });
  }
});

export type GroundedVerifierRouteV1 = z.infer<typeof groundedVerifierRouteV1Schema>;
