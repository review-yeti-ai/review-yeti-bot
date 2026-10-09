import type { McpToolHandler, McpExecutionContext, ToolResult } from '../types.js';

export interface DisputeFindingOutput {
  version: 'DisputeFindingRecheckReceipt.v1';
  finding_id: string;
  request_id: string;
  review_status: 'fresh_re_review_requested';
  remaining_blockers: number;
}

export const disputeFindingTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_dispute_finding',
    description:
      'Request a fresh exact-head review of a finding with a developer counter-argument. Emits canonical DisputeFindingRecheckReceipt.v1 receipt.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          default: 'exampleorg',
          description: 'GitHub repository owner or organization.',
        },
        repo: {
          type: 'string',
          description: 'GitHub repository name.',
        },
        pr_number: {
          type: 'number',
          description: 'Pull request number.',
        },
        finding_id: {
          type: 'string',
          description: 'Unique identifier of the finding to dispute.',
        },
        counter_argument: {
          type: 'string',
          description: 'Developer counter-argument and technical justification.',
        },
      },
      required: ['repo', 'pr_number', 'finding_id', 'counter_argument'],
    },
  },

  async execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    const owner = (args.owner || 'exampleorg').trim();
    const repo = (args.repo || '').trim();
    const prNumber = Number(args.pr_number ?? args.prNumber);
    const findingId = String(args.finding_id ?? args.findingId ?? '').trim();
    const counterArgument = String(args.counter_argument ?? args.counterArgument ?? '').trim();
    const env = context.env || {};

    if (!repo || isNaN(prNumber) || !findingId || !counterArgument) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Error: "repo", "pr_number", "finding_id", and "counter_argument" are required parameters.',
          },
        ],
      };
    }

    const requestId = crypto.randomUUID();
    const repoKey = `${owner}/${repo}`;
    let latestRunId: string | null = null;

    // 1. Query RepoGateDO for latest/active run for this PR
    if (env.REPO_GATE?.idFromName && env.REPO_GATE?.get) {
      try {
        const repoGateId = env.REPO_GATE.idFromName(repoKey);
        const repoGate = env.REPO_GATE.get(repoGateId);
        const res = await repoGate.fetch(`http://do/active-run/${prNumber}`);
        if (res.ok) {
          const data = (await res.json()) as any;
          latestRunId = data.latestRunId || data.activeRunId || null;
        }
      } catch (err: any) {
        console.error('Error querying RepoGateDO for active run:', err);
      }
    }

    // 2. Publish dispute event to ReviewRunDO if bound
    if (latestRunId && env.REVIEW_RUN?.idFromName && env.REVIEW_RUN?.get) {
      try {
        const runDOId = env.REVIEW_RUN.idFromName(latestRunId);
        const runDO = env.REVIEW_RUN.get(runDOId);
        await runDO.fetch('http://do/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'finding:dispute_requested',
            data: {
              findingId,
              counterArgument,
              requestId,
              prNumber,
              repo: repoKey,
            },
          }),
        });
      } catch (err: any) {
        console.error('Error logging dispute to ReviewRunDO:', err);
      }
    }

    // 3. Trigger on-demand re-evaluation workflow if bound
    if (env.REVIEW_JOB_WORKFLOW && typeof env.REVIEW_JOB_WORKFLOW.create === 'function') {
      try {
        const recheckRunId = `run_dispute_${requestId.replace(/-/g, '').slice(0, 16)}`;
        await env.REVIEW_JOB_WORKFLOW.create({
          id: recheckRunId,
          params: {
            runId: recheckRunId,
            owner,
            repo,
            prNumber,
            disputeFindingId: findingId,
            disputeArgument: counterArgument,
            requestId,
          },
        });
      } catch (err: any) {
        console.error('Error dispatching dispute workflow:', err);
      }
    }

    const output: DisputeFindingOutput = {
      version: 'DisputeFindingRecheckReceipt.v1',
      finding_id: findingId,
      request_id: requestId,
      review_status: 'fresh_re_review_requested',
      remaining_blockers: typeof args.remaining_blockers === 'number' ? args.remaining_blockers : 0,
    };

    const lines = [
      '### Review Yeti Finding Dispute Registered',
      `- **Repository:** ${owner}/${repo}`,
      `- **Pull Request:** #${prNumber}`,
      `- **Finding ID:** \`${findingId}\``,
      `- **Request ID:** \`${requestId}\``,
      `- **Receipt Version:** \`${output.version}\``,
      `- **Status:** \`${output.review_status}\``,
      `- **Developer Counter-Argument:**`,
      `  > ${counterArgument.replace(/\n/g, '\n  > ')}`,
    ];

    return {
      content: [
        {
          type: 'text',
          text: lines.join('\n'),
        },
        {
          type: 'text',
          text: JSON.stringify(output, null, 2),
        },
      ],
    };
  },
};
