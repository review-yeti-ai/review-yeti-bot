import { meetsMinimumSeverity, type MinimumSeverity } from '../config/schema';
import type { CheckRunAgentEvaluation, CheckRunFindingInput } from '../github/checkRunAgentExecutor';

export interface ApprovabilityEvaluationInput {
  findings: CheckRunFindingInput[];
  checkEvaluations?: CheckRunAgentEvaluation[];
  minBlockingSeverity?: MinimumSeverity;
  autoApproveCleanPRs?: boolean;
  requestChangesOnBlock?: boolean;
  priorOpenFindingsCount?: number;
}

export interface ApprovabilityDecision {
  approved: boolean;
  blockingFindings: CheckRunFindingInput[];
  advisoryFindings: CheckRunFindingInput[];
  blockingFindingsCount: number;
  advisoryFindingsCount: number;
  failedCheckAgentsCount: number;
  resolvedSincePriorHeadCount: number;
  githubReviewEvent: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  checkConclusion: 'success' | 'failure';
  title: string;
  summary: string;
}

/**
 * Evaluates pull request Approvability deterministically based on retained findings,
 * minimum blocking severity threshold, and `.reviewyeti/checks/*.md` Check Run Agent outcomes.
 */
export function evaluateApprovability(input: ApprovabilityEvaluationInput): ApprovabilityDecision {
  const minBlockingSeverity: MinimumSeverity = input.minBlockingSeverity || 'medium';
  const autoApprove = input.autoApproveCleanPRs !== false;
  const requestChangesOnBlock = input.requestChangesOnBlock === true;

  const blockingFindings: CheckRunFindingInput[] = [];
  const advisoryFindings: CheckRunFindingInput[] = [];

  for (const finding of input.findings) {
    if (meetsMinimumSeverity(finding.severity, minBlockingSeverity)) {
      blockingFindings.push(finding);
    } else {
      advisoryFindings.push(finding);
    }
  }

  const failedCheckAgents = (input.checkEvaluations || []).filter((c) => c.conclusion === 'failure');
  const failedCheckAgentsCount = failedCheckAgents.length;
  const approved = blockingFindings.length === 0 && failedCheckAgentsCount === 0;

  const priorOpen = Math.max(0, input.priorOpenFindingsCount || 0);
  const resolvedSincePriorHeadCount =
    priorOpen > blockingFindings.length ? priorOpen - blockingFindings.length : 0;

  let githubReviewEvent: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' = 'COMMENT';
  if (approved && autoApprove) {
    githubReviewEvent = 'APPROVE';
  } else if (!approved && requestChangesOnBlock) {
    githubReviewEvent = 'REQUEST_CHANGES';
  }

  const checkConclusion: 'success' | 'failure' = approved ? 'success' : 'failure';

  let title: string;
  if (approved) {
    title =
      resolvedSincePriorHeadCount > 0
        ? `Approved (${resolvedSincePriorHeadCount} prior issue(s) resolved)`
        : 'Approved — 0 blocking issues';
  } else {
    const parts: string[] = [];
    if (blockingFindings.length > 0) {
      parts.push(`${blockingFindings.length} blocking issue(s)`);
    }
    if (failedCheckAgentsCount > 0) {
      parts.push(`${failedCheckAgentsCount} check agent(s) failed`);
    }
    title = `Needs Human Approval — ${parts.join(', ')}`;
  }

  const summaryLines: string[] = [
    `### Approvability Status: ${approved ? 'Approved' : 'Needs Human Approval'}`,
    `- **Minimum Blocking Severity**: \`${String(minBlockingSeverity).toUpperCase()}\``,
    `- **Blocking Findings**: ${blockingFindings.length}`,
    `- **Advisory Findings (Withheld/Non-blocking)**: ${advisoryFindings.length}`,
    `- **Failed Check Run Agents**: ${failedCheckAgentsCount}`,
  ];

  if (resolvedSincePriorHeadCount > 0) {
    summaryLines.push(`- **Resolved Since Previous Commit**: ${resolvedSincePriorHeadCount}`);
  }

  return {
    approved,
    blockingFindings,
    advisoryFindings,
    blockingFindingsCount: blockingFindings.length,
    advisoryFindingsCount: advisoryFindings.length,
    failedCheckAgentsCount,
    resolvedSincePriorHeadCount,
    githubReviewEvent,
    checkConclusion,
    title: title.slice(0, 100),
    summary: summaryLines.join('\n'),
  };
}
