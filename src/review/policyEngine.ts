export interface TicketCheckOptions {
  title: string;
  body?: string;
  pattern?: string | RegExp;
}

export function checkTicketLink(
  titleOrOptions: string | TicketCheckOptions,
  bodyParam?: string,
  customPatternParam?: string
): boolean {
  let title = '';
  let body = '';
  let pattern: RegExp = /[A-Z]+-\d+|#\d+/i;

  if (typeof titleOrOptions === 'object' && titleOrOptions !== null) {
    title = titleOrOptions.title || '';
    body = titleOrOptions.body || '';
    if (titleOrOptions.pattern) {
      pattern = typeof titleOrOptions.pattern === 'string'
        ? new RegExp(titleOrOptions.pattern, 'i')
        : titleOrOptions.pattern;
    }
  } else {
    title = titleOrOptions || '';
    body = bodyParam || '';
    if (customPatternParam) {
      pattern = new RegExp(customPatternParam, 'i');
    }
  }

  const combinedText = `${title}\n${body}`;
  return pattern.test(combinedText);
}

export interface EnforcementPolicyEvaluation {
  passed: boolean;
  ticketLinkValid: boolean;
  quorumSatisfied: boolean;
  failureAction: 'fail_closed' | 'fail_open' | 'quarantine';
  violations: string[];
}

export function evaluateEnforcementPolicy(params: {
  title: string;
  body?: string;
  requireTicketLink: boolean;
  requireAllReviews: boolean;
  activePersonasApprovedCount: number;
  totalActivePersonasCount: number;
  failureAction: 'fail_closed' | 'fail_open' | 'quarantine';
  ticketPattern?: string;
}): EnforcementPolicyEvaluation {
  const {
    title,
    body,
    requireTicketLink,
    requireAllReviews,
    activePersonasApprovedCount,
    totalActivePersonasCount,
    failureAction,
    ticketPattern,
  } = params;

  const violations: string[] = [];
  let ticketLinkValid = true;

  if (requireTicketLink) {
    ticketLinkValid = checkTicketLink(title, body, ticketPattern);
    if (!ticketLinkValid) {
      violations.push('PR title or description missing required issue/ticket key reference (e.g. JIRA key ABC-123 or GitHub issue #42).');
    }
  }

  let quorumSatisfied = true;
  if (requireAllReviews) {
    quorumSatisfied = activePersonasApprovedCount >= totalActivePersonasCount && totalActivePersonasCount > 0;
    if (!quorumSatisfied) {
      violations.push(`All ${totalActivePersonasCount} active persona reviews must approve prior to merge (${activePersonasApprovedCount}/${totalActivePersonasCount} approved).`);
    }
  }

  const passed = violations.length === 0;

  return {
    passed,
    ticketLinkValid,
    quorumSatisfied,
    failureAction,
    violations,
  };
}
