import { describe, expect, it } from 'vitest';
import { groundedVerifierRouteV1Schema } from '../../src/review/groundedVerifierRoute';

const primaryRoute = {
  version: 'GroundedVerifierRoute.v1' as const, purpose: 'primary' as const,
  requestedRole: 'primary' as const, appliedRole: 'primary' as const,
  configuredAlternateModel: null, selectedModel: 'review-alias', responseReportedModel: 'review-alias',
  responseModelUnavailableReason: null,
  upstreamIdentity: { providerId: null, model: null, unavailableReason: 'No upstream attestation is available.' },
};

describe('GroundedVerifierRoute.v1', () => {
  it('separates primary selection from response model and unknown upstream identity', () => {
    expect(groundedVerifierRouteV1Schema.parse(primaryRoute)).toEqual(primaryRoute);
  });

  it('records unconfigured disputed fallback without claiming the adjudicator was applied', () => {
    const route = { ...primaryRoute, purpose: 'disputed-blocker-recheck' as const,
      requestedRole: 'disputed-blocker-adjudicator' as const };
    expect(groundedVerifierRouteV1Schema.parse(route)).toMatchObject({
      purpose: 'disputed-blocker-recheck', requestedRole: 'disputed-blocker-adjudicator', appliedRole: 'primary',
      configuredAlternateModel: null, selectedModel: 'review-alias',
    });
  });

  it('rejects forged alternate selection and unsubstantiated serving identity', () => {
    expect(groundedVerifierRouteV1Schema.safeParse({ ...primaryRoute,
      purpose: 'disputed-blocker-recheck', requestedRole: 'disputed-blocker-adjudicator',
      appliedRole: 'disputed-blocker-adjudicator', configuredAlternateModel: null }).success).toBe(false);
    expect(groundedVerifierRouteV1Schema.safeParse({ ...primaryRoute,
      upstreamIdentity: { providerId: 'provider-x', model: 'model-y', unavailableReason: 'unknown' } }).success).toBe(false);
  });
});
