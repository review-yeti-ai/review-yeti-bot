import { describe, it, expect } from 'vitest';
import { checkTicketLink, evaluateEnforcementPolicy } from '../../src/review/policyEngine';

describe('Milestone 42: Enforcement Policy & Ticket Compliance Engine Suite', () => {
  it('checkTicketLink verifies presence of JIRA keys or GitHub issue references in PR title or body', () => {
    expect(checkTicketLink('feat(auth): add OAuth2 PKCE login [PROJ-123]', '')).toBe(true);
    expect(checkTicketLink('fix: resolve deadlock in connection pool', 'Closes #42 and fixes memory leak.')).toBe(true);
    expect(checkTicketLink({ title: 'feat: new dashboard layout', body: 'Refers to JIRA issue CT-991' })).toBe(true);
    expect(checkTicketLink('chore: update dependencies', 'No ticket reference here')).toBe(false);
  });

  it('checkTicketLink supports custom ticket key regex pattern', () => {
    expect(checkTicketLink('feat: add user profile', 'Task ID: TASK-5544', 'TASK-\\d+')).toBe(true);
    expect(checkTicketLink('feat: add user profile', 'Task ID: ISSUE-5544', 'TASK-\\d+')).toBe(false);
  });

  it('evaluateEnforcementPolicy passes when all requirements are met', () => {
    const result = evaluateEnforcementPolicy({
      title: 'feat: add metrics exporter [PROJ-88]',
      body: 'Implements Prometheus metrics endpoint',
      requireTicketLink: true,
      requireAllReviews: true,
      activePersonasApprovedCount: 4,
      totalActivePersonasCount: 4,
      failureAction: 'fail_closed',
    });

    expect(result.passed).toBe(true);
    expect(result.ticketLinkValid).toBe(true);
    expect(result.quorumSatisfied).toBe(true);
    expect(result.violations.length).toBe(0);
  });

  it('evaluateEnforcementPolicy flags missing ticket link when required', () => {
    const result = evaluateEnforcementPolicy({
      title: 'refactor: clean up logging statements',
      body: 'No ticket mentioned',
      requireTicketLink: true,
      requireAllReviews: false,
      activePersonasApprovedCount: 2,
      totalActivePersonasCount: 2,
      failureAction: 'quarantine',
    });

    expect(result.passed).toBe(false);
    expect(result.ticketLinkValid).toBe(false);
    expect(result.failureAction).toBe('quarantine');
    expect(result.violations[0]).toContain('ticket key reference');
  });

  it('evaluateEnforcementPolicy flags unfulfilled quorum reviews', () => {
    const result = evaluateEnforcementPolicy({
      title: 'feat(sec): update auth tokens [SEC-404]',
      body: 'Resolves security vulnerability',
      requireTicketLink: true,
      requireAllReviews: true,
      activePersonasApprovedCount: 3,
      totalActivePersonasCount: 4,
      failureAction: 'fail_closed',
    });

    expect(result.passed).toBe(false);
    expect(result.quorumSatisfied).toBe(false);
    expect(result.violations[0]).toContain('active persona reviews must approve');
  });
});
