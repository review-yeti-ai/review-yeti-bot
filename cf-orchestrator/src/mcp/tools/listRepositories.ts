import type { McpToolHandler, McpExecutionContext, ToolResult } from '../types.js';
import { fetchRepositoriesFromDb } from '../../storage/d1Client.js';

export const listRepositoriesTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_list_repositories',
    description:
      'List all onboarded repositories in Review Yeti with their automation status, operator passthrough status, and strictness profiles.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'Optional filter by organization or repository owner (e.g. "calltelemetry")',
        },
        passthroughOnly: {
          type: 'boolean',
          description: 'Filter to only repositories with operator passthrough enabled',
        },
        enabledOnly: {
          type: 'boolean',
          description: 'Filter to only repositories with active automated review enabled',
        },
      },
    },
  },

  async execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    const env = context.env || {};
    const owner = args.owner ? String(args.owner).trim() : undefined;
    const passthroughOnly = args.passthroughOnly !== undefined ? Boolean(args.passthroughOnly) : undefined;
    const enabledOnly = args.enabledOnly !== undefined ? Boolean(args.enabledOnly) : undefined;

    const repos = await fetchRepositoriesFromDb(env.DB, {
      owner,
      passthroughOnly,
      enabledOnly,
    });

    const summaryText =
      `### 📂 Enrolled Repositories (${repos.length})\n\n` +
      (repos.length > 0
        ? `| Repository | Installation | Strictness | Automation | Passthrough |\n` +
          `|:---|:---|:---|:---|:---|\n` +
          repos
            .map(
              (r) =>
                `| \`${r.id}\` | ${r.installationId ? `\`${r.installationId}\`` : '_None_'} | \`${r.customProfile}\` | ${r.automationEnabled ? '✅ Active' : '⏸️ Paused'} | ${r.passthroughEnabled ? '✅ Enabled' : '❌ Disabled'} |`
            )
            .join('\n')
        : `_No repositories match the specified filter criteria._`);

    return {
      content: [
        { type: 'text', text: summaryText },
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              count: repos.length,
              repositories: repos,
            },
            null,
            2
          ),
        },
      ],
    };
  },
};
