import type { McpToolHandler, McpExecutionContext, ToolResult } from '../types.js';
import { fetchOrganizationsFromDb, fetchRepositoriesFromDb } from '../../storage/d1Client.js';

export const getOnboardingStatusTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_get_onboarding_status',
    description:
      'Query the current Review Yeti onboarding status, including total organizations, total repositories, active repositories, and operator passthrough repositories from D1.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  async execute(_args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    const env = context.env || {};
    const [orgs, repos] = await Promise.all([
      fetchOrganizationsFromDb(env.DB),
      fetchRepositoriesFromDb(env.DB),
    ]);

    const activeRepos = repos.filter((r) => r.automationEnabled);
    const passthroughRepos = repos.filter((r) => r.passthroughEnabled);
    const backend = env.DB ? 'Cloudflare D1 (Production)' : 'In-Memory Store (Harness/Dev)';

    const summaryText =
      `### 📊 Review Yeti Onboarding Status\n\n` +
      `- **Storage Backend:** \`${backend}\`\n` +
      `- **Total Onboarded Organizations:** **${orgs.length}**\n` +
      `- **Total Enrolled Repositories:** **${repos.length}**\n` +
      `- **Active Review Repositories:** **${activeRepos.length}**\n` +
      `- **Operator Passthrough Repositories:** **${passthroughRepos.length}**\n\n` +
      `**Organizations:**\n` +
      (orgs.length > 0
        ? orgs.map((o) => `- \`${o.id}\` (${o.name}) - Installation: ${o.installationId ? `\`${o.installationId}\`` : '_None_'} - Passthrough: ${o.passthroughEnabled ? '✅' : '❌'}`).join('\n')
        : `_None registered._`);

    return {
      content: [
        { type: 'text', text: summaryText },
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              totalOrganizations: orgs.length,
              totalRepositories: repos.length,
              activeRepositories: activeRepos.length,
              passthroughRepositories: passthroughRepos.length,
              storageBackend: backend,
              organizations: orgs,
            },
            null,
            2
          ),
        },
      ],
    };
  },
};
