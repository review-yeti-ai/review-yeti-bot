import { describe, expect, it } from 'vitest';
import { TenantAccessError, TenantBoundary } from '../../src/policy/tenantBoundary';

describe('tenant isolation', () => {
  it('rejects cross-tenant and unregistered repository access', () => {
    const boundary = new TenantBoundary();
    expect(() => boundary.assertAccess({ tenantId: 't1', repositories: ['o/r'] }, { tenantId: 't2', owner: 'o', repo: 'r' })).toThrow(TenantAccessError);
    expect(() => boundary.assertAccess({ tenantId: 't1', repositories: [] }, { tenantId: 't1', owner: 'o', repo: 'r' })).toThrow(TenantAccessError);
    expect(() => boundary.assertAccess({ tenantId: 't1', repositories: ['o/r'] }, { tenantId: 't1', owner: 'o', repo: 'r' })).not.toThrow();
  });
});
