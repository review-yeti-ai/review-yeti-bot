import type { McpToolHandler, McpExecutionContext, ToolResult } from '../types.js';

async function performRunCancellation(
  env: any,
  runId: string,
  reason: string
): Promise<{ cancelled: boolean; previousPhase?: string }> {
  try {
    if (!runId || !/^run_[a-zA-Z0-9_-]{1,128}$/.test(runId)) {
      return { cancelled: false };
    }
    if (!env?.REVIEW_RUN?.idFromName || !env?.REVIEW_RUN?.get) return { cancelled: false };
    const runDOId = env.REVIEW_RUN.idFromName(runId);
    const runDO = env.REVIEW_RUN.get(runDOId);
    const res = await runDO.fetch('http://do/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) return { cancelled: false };
    return (await res.json()) as { cancelled: boolean; previousPhase: string };
  } catch (err) {
    console.error(`Error cancelling run ${runId}:`, err);
    return { cancelled: false };
  }
}

async function performPrEviction(
  env: any,
  repoKey: string,
  prNumber: number
): Promise<{ evicted: boolean; count: number; evictedRunIds: string[] }> {
  try {
    if (!env?.REPO_GATE?.idFromName || !env?.REPO_GATE?.get) {
      return { evicted: false, count: 0, evictedRunIds: [] };
    }
    const repoGateId = env.REPO_GATE.idFromName(repoKey);
    const repoGate = env.REPO_GATE.get(repoGateId);
    const res = await repoGate.fetch('http://do/evict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prNumber, tombstone: true }),
    });
    if (!res.ok) return { evicted: false, count: 0, evictedRunIds: [] };
    const data = (await res.json()) as any;
    return {
      evicted: Boolean(data.evicted),
      count: typeof data.count === 'number' ? data.count : 0,
      evictedRunIds: Array.isArray(data.evictedRunIds) ? data.evictedRunIds : [],
    };
  } catch (err) {
    console.error(`Error evicting queued runs for PR #${prNumber}:`, err);
    return { evicted: false, count: 0, evictedRunIds: [] };
  }
}

async function fetchActiveRunId(env: any, repoKey: string, prNumber: number): Promise<string | null> {
  try {
    if (!env?.REPO_GATE?.idFromName || !env?.REPO_GATE?.get) return null;
    const repoGateId = env.REPO_GATE.idFromName(repoKey);
    const repoGate = env.REPO_GATE.get(repoGateId);
    const res = await repoGate.fetch(`http://do/active-run/${prNumber}`);
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return data.activeRunId || null;
  } catch {
    return null;
  }
}

export const cancelReviewTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_cancel_review',
    description:
      'Cancel an in-flight review run or evict queued PR runs using two-tier epoch fencing and Durable Object cancellation tombstones.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'Unique runId of the review job to cancel (e.g. "run_cf_12345")',
        },
        owner: {
          type: 'string',
          default: 'exampleorg',
          description: 'Repository owner (used if cancelling by PR number)',
        },
        repo: {
          type: 'string',
          description: 'Repository name (e.g. "example-api")',
        },
        prNumber: {
          type: 'number',
          description: 'PR number to cancel active/queued runs for',
        },
        reason: {
          type: 'string',
          default: 'User requested cancellation via MCP tool',
          description: 'Reason for cancellation recorded in audit logs',
        },
      },
    },
  },

  async execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    let targetRunId = (args.runId || '').trim();
    const owner = (args.owner || 'exampleorg').trim();
    const repo = (args.repo || 'example-api').trim();
    const prNumber = typeof args.prNumber === 'number' ? args.prNumber : undefined;
    const reason = args.reason || 'User requested cancellation via MCP tool';

    const env = context.env || {};
    const repoKey = `${owner}/${repo}`;

    if (!targetRunId && prNumber !== undefined) {
      targetRunId = (await fetchActiveRunId(env, repoKey, prNumber)) || '';
    }

    if (!targetRunId) {
      if (prNumber !== undefined) {
        const evictOutcome = await performPrEviction(env, repoKey, prNumber);
        return {
          isError: false,
          content: [
            {
              type: 'text',
              text:
                `### ℹ️ No Active Run In-Flight for PR #${prNumber}\n\n` +
                `- **Repository:** \`${repoKey}\`\n` +
                `- **Queued Runs Evicted:** ${evictOutcome.count}\n` +
                `- **Status:** No active review run required cancellation.`,
            },
            {
              type: 'text',
              text: JSON.stringify({
                repoKey,
                prNumber,
                activeRunFound: false,
                evictedQueuedCount: evictOutcome.count,
              }),
            },
          ],
        };
      }

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Error: Must provide either a specific "runId" or ("repo" and "prNumber") to cancel a review.',
          },
        ],
      };
    }

    // 1. Cancel RunDO
    const cancelOutcome = await performRunCancellation(env, targetRunId, reason);

    // 2. Evict queued PR runs if prNumber provided
    let evictOutcome = { evicted: false, count: 0, evictedRunIds: [] as string[] };
    if (prNumber !== undefined) {
      evictOutcome = await performPrEviction(env, repoKey, prNumber);
    }

    const summaryText =
      `### 🛑 Review Yeti Cancellation Executed\n\n` +
      `- **Target Run ID:** \`${targetRunId}\`\n` +
      `- **Cancellation Status:** ${
        cancelOutcome.cancelled ? '✅ **Cancelled Successfully**' : '⚠️ **Run Inactive or Cancellation Not Acknowledged**'
      }\n` +
      `- **Previous Phase:** \`${cancelOutcome.previousPhase || 'unknown'}\`\n` +
      `- **Reason:** "${reason}"\n` +
      (evictOutcome.count > 0
        ? `- **Queued Runs Evicted:** ${evictOutcome.count} runs removed from queue (\`${evictOutcome.evictedRunIds.join(', ')}\`)\n`
        : '') +
      `- **Fencing Epoch:** ${
        cancelOutcome.cancelled ? 'Bumped to prevent stale worker heartbeats' : 'Unchanged (run inactive)'
      }\n`;

    return {
      content: [
        {
          type: 'text',
          text: summaryText,
        },
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              runId: targetRunId,
              cancelled: cancelOutcome.cancelled,
              previousPhase: cancelOutcome.previousPhase,
              evictedCount: evictOutcome.count,
              reason,
            },
            null,
            2
          ),
        },
      ],
    };
  },
};
