import type { McpToolHandler, McpExecutionContext, ToolResult } from '../types.js';
import { purgeExpiredR2WorkspaceCaches, buildCanonicalCacheKey } from '../../runners/r2WorkspaceCache.js';

export const purgeCacheTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_purge_cache',
    description:
      'Purge expired (>1 hour old) or specific Pull Request git/Zoekt archives from the Cloudflare R2 workspace cache.',
    inputSchema: {
      type: 'object',
      properties: {
        maxAgeSeconds: {
          type: 'number',
          default: 3600,
          description: 'Maximum allowable cache age in seconds (default: 3600 = 1 hour)',
        },
        prNumber: {
          type: 'number',
          description: 'Specific PR number to purge cache for immediately',
        },
        owner: {
          type: 'string',
          default: 'calltelemetry',
          description: 'Repository owner',
        },
        repo: {
          type: 'string',
          default: 'cisco-cdr',
          description: 'Repository name',
        },
      },
    },
  },

  async execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    const maxAgeSeconds = typeof args.maxAgeSeconds === 'number' ? args.maxAgeSeconds : 3600;
    const prNumber = typeof args.prNumber === 'number' ? args.prNumber : undefined;
    const owner = (args.owner || 'calltelemetry').trim();
    const repo = (args.repo || 'cisco-cdr').trim();

    const env = context.env || {};
    const bucket = env.WORKSPACE_CACHE_BUCKET;

    if (!bucket) {
      // Clean reporting when bucket is not bound in local/simulated test
      return {
        content: [
          {
            type: 'text',
            text: `### 🧹 Review Yeti Cache Purge (Dry Run / Local)\n\n- Scanned: **0 archives**\n- Purged: **0 archives**\n- Reclaimed Space: **0 MB**\n- Status: ℹ️ **Skipped (WORKSPACE_CACHE_BUCKET not bound in environment)**\n`,
          },
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                dryRun: true,
                simulated: true,
                scannedCount: 0,
                deletedCount: 0,
                deletedKeys: [],
                reclaimedSpaceBytes: 0,
                note: 'WORKSPACE_CACHE_BUCKET not bound; no R2 objects modified.',
                dataSource: 'baseline_sample_telemetry',
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (prNumber !== undefined) {
      // Specific PR purge with validated canonical key builder
      let targetKey: string;
      try {
        targetKey = buildCanonicalCacheKey(owner, repo, prNumber);
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Invalid cache key arguments: ${err?.message || err}` }],
        };
      }
      try {
        await bucket.delete(targetKey);
        return {
          content: [
            {
              type: 'text',
              text: `### 🧹 Specific PR Cache Purged\n\n- **Target Key:** \`${targetKey}\`\n- **Status:** ✅ **Deleted from R2**\n`,
            },
            {
              type: 'text',
              text: JSON.stringify({ ok: true, deletedKey: targetKey }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to purge cache for PR #${prNumber}: ${err.message}` }],
        };
      }
    }

    // General expiration sweep
    const result = await purgeExpiredR2WorkspaceCaches(bucket, maxAgeSeconds);

    const summaryText =
      `### 🧹 Review Yeti R2 Workspace Cache Expiration Purge\n\n` +
      `- **Max Age Policy:** ${maxAgeSeconds}s (1 Hour)\n` +
      `- **Total Objects Scanned:** **${result.scannedCount}**\n` +
      `- **Expired Archives Purged:** **${result.deletedCount}**\n` +
      `- **Purged Keys:** ${
        result.deletedKeys.length > 0 ? result.deletedKeys.map((k) => `\`${k}\``).join(', ') : '_None expired_'
      }\n` +
      `- **Status:** ✅ **Completed**\n`;

    return {
      content: [
        {
          type: 'text',
          text: summaryText,
        },
        {
          type: 'text',
          text: JSON.stringify({ ok: true, ...result }, null, 2),
        },
      ],
    };
  },
};
