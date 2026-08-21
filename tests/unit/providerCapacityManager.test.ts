import { describe, it, expect } from 'vitest';
import {
  isExplicitUpstreamRejection,
  UpstreamCapacityRejectionError,
} from '../../src/gateway/providerCapacityManager';

describe('Explicit Upstream Rejection & Failover Detection', () => {
  it('correctly detects HTTP status codes representing capacity/rate limit rejections', () => {
    expect(isExplicitUpstreamRejection(429)).toBe(true);
    expect(isExplicitUpstreamRejection(503)).toBe(true);
    expect(isExplicitUpstreamRejection(529)).toBe(true);
    expect(isExplicitUpstreamRejection(200)).toBe(false);
    expect(isExplicitUpstreamRejection(400)).toBe(false);
  });

  it('correctly detects explicit upstream capacity rejection error strings and payloads', () => {
    expect(isExplicitUpstreamRejection('HTTP 429: Rate limit exceeded')).toBe(true);
    expect(isExplicitUpstreamRejection('HTTP 503: Service Unavailable')).toBe(true);
    expect(isExplicitUpstreamRejection('Error: cancelled')).toBe(true);
    expect(isExplicitUpstreamRejection('Provider capacity full: queue_full')).toBe(true);
    expect(isExplicitUpstreamRejection('RESOURCE_EXHAUSTED')).toBe(true);
    expect(isExplicitUpstreamRejection('Server overloaded')).toBe(true);

    expect(isExplicitUpstreamRejection('Invalid json payload')).toBe(false);
    expect(isExplicitUpstreamRejection('Syntax error at line 42')).toBe(false);
  });

  it('correctly handles Error instances with rejection messages', () => {
    const err = new UpstreamCapacityRejectionError('fireworks', 'Provider capacity reached: 429 Too Many Requests');
    expect(isExplicitUpstreamRejection(err)).toBe(true);
    expect(err.name).toBe('UpstreamCapacityRejectionError');
    expect(err.providerId).toBe('fireworks');
    expect(err.isRetryableFailover).toBe(true);
  });
});
