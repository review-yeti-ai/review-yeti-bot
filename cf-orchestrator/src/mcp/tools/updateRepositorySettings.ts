import type { McpToolHandler, McpExecutionContext, ToolResult } from '../types.js';
import { updateRepositoryInDb, fetchRepositoryFromDb } from '../../storage/d1Client.js';

export const updateRepositorySettingsTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_update_repository_settings',
    description:
      'Update existing repository configuration, automation status, or passthrough policy in Review Yeti orchestrator storage (D1).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'Repository owner or organization name',
        },
        repo: {
          type: 'string',
          description: 'Repository name',
        },
        repositoryId: {
          type: 'number',
          description: 'Update numeric GitHub repository ID',
        },
        installationId: {
          type: 'number',
          description: 'Update GitHub App installation ID',
        },
        defaultBranch: {
          type: 'string',
          description: 'Default git branch',
        },
        automationEnabled: {
          type: 'boolean',
          description: 'Enable or disable automated review processing',
        },
        passthroughEnabled: {
          type: 'boolean',
          description: 'Enable or disable operator passthrough SHIP checks',
        },
        customProfile: {
          type: 'string',
          enum: ['chill', 'balanced', 'assertive'],
          description: 'Update Review Yeti persona profile',
        },
        generateFlowchart: {
          type: 'boolean',
          description: 'Enable or disable Mermaid flowchart generation',
        },
        settings: {
          type: 'object',
          description: 'Update repository settings dictionary',
        },
      },
      required: ['owner', 'repo'],
    },
  },

  async execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    const owner = (args.owner || '').trim();
    const repo = (args.repo || '').trim();

    if (!owner || !repo) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error: Both "owner" and "repo" parameters are required.' }],
      };
    }

    const env = context.env || {};
    const existing = await fetchRepositoryFromDb(env.DB, owner, repo);
    if (!existing) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Repository "${owner}/${repo}" is not enrolled. Use review_yeti_onboard_repository first.` }],
      };
    }

    const updates: Record<string, any> = {};
    if (typeof args.repositoryId === 'number') updates.repositoryId = args.repositoryId;
    if (typeof args.installationId === 'number') updates.installationId = args.installationId;
    if (args.defaultBranch) updates.defaultBranch = String(args.defaultBranch).trim();
    if (typeof args.automationEnabled === 'boolean') updates.automationEnabled = args.automationEnabled;
    if (typeof args.passthroughEnabled === 'boolean') updates.passthroughEnabled = args.passthroughEnabled;
    if (['chill', 'balanced', 'assertive'].includes(args.customProfile)) updates.customProfile = args.customProfile;
    if (typeof args.generateFlowchart === 'boolean') updates.generateFlowchart = args.generateFlowchart;
    if (typeof args.settings === 'object' && args.settings !== null) {
      updates.settingsJson = { ...(existing.settingsJson || {}), ...args.settings };
    }

    try {
      const updated = await updateRepositoryInDb(env.DB, owner, repo, updates);
      const summaryText =
        `### ⚙️ Repository Settings Updated\n\n` +
        `- **Repository:** \`${owner}/${repo}\`\n` +
        `- **Numeric Repo ID:** ${updated.repositoryId ? `\`${updated.repositoryId}\`` : '_Unset_'}\n` +
        `- **Automation Enabled:** ${updated.automationEnabled ? '✅ **Active**' : '⏸️ **Disabled**'}\n` +
        `- **Passthrough Enabled:** ${updated.passthroughEnabled ? '✅ **Active**' : '❌ **Disabled**'}\n` +
        `- **Review Profile:** \`${updated.customProfile}\`\n` +
        `- **Status:** ✅ **Updated in D1 Storage**\n`;

      return {
        content: [
          { type: 'text', text: summaryText },
          { type: 'text', text: JSON.stringify({ ok: true, repository: updated }, null, 2) },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to update repository settings for "${owner}/${repo}": ${err?.message || err}` }],
      };
    }
  },
};
