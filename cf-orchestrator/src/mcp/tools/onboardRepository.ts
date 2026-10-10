import type { McpToolHandler, McpExecutionContext, ToolResult } from '../types.js';
import { updateRepositoryInDb, fetchOrganizationFromDb, type RepositoryRecord } from '../../storage/d1Client.js';
import { getInstallationToken } from '../../github/githubAppAuth.js';

export const onboardRepositoryTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_onboard_repository',
    description:
      'Onboard or configure a repository in Review Yeti orchestrator storage (D1), enabling automation and operator passthrough.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'Repository owner or organization name (e.g. "calltelemetry")',
        },
        repo: {
          type: 'string',
          description: 'Repository name (e.g. "ct-uat")',
        },
        repositoryId: {
          type: 'number',
          description: 'Numeric GitHub repository ID (auto-resolved from GitHub API if omitted)',
        },
        installationId: {
          type: 'number',
          description: 'GitHub App Installation ID (auto-resolved from org if omitted)',
        },
        defaultBranch: {
          type: 'string',
          default: 'main',
          description: 'Default git branch for reviews',
        },
        automationEnabled: {
          type: 'boolean',
          default: true,
          description: 'Whether automated review processing is enabled',
        },
        passthroughEnabled: {
          type: 'boolean',
          default: true,
          description: 'Whether operator passthrough SHIP checks are enabled for this repository',
        },
        customProfile: {
          type: 'string',
          enum: ['chill', 'balanced', 'assertive'],
          default: 'assertive',
          description: 'Review Yeti persona profile for this repository',
        },
        generateFlowchart: {
          type: 'boolean',
          default: true,
          description: 'Whether to generate Mermaid architecture flowcharts for PR reviews',
        },
        settings: {
          type: 'object',
          description: 'Optional repository settings dictionary',
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
    let repositoryId = typeof args.repositoryId === 'number' && args.repositoryId > 0 ? args.repositoryId : undefined;
    let installationId = typeof args.installationId === 'number' && args.installationId > 0 ? args.installationId : undefined;

    // Auto-resolve installationId from organization if omitted
    if (!installationId) {
      try {
        const org = await fetchOrganizationFromDb(env.DB, owner);
        if (org?.installationId) {
          installationId = org.installationId;
        }
      } catch {
        // Non-fatal
      }
    }

    // Auto-resolve repositoryId and installationId from GitHub API if omitted and credentials exist
    if (!repositoryId && env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
      try {
        const token = await getInstallationToken(env, owner, repo, installationId);
        if (token && !token.startsWith('ghs_dummy_') && !token.startsWith('ghs_ephemeral_')) {
          const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
            headers: {
              Authorization: `Bearer ${token}`,
              'User-Agent': 'review-yeti-cf-orchestrator',
              Accept: 'application/vnd.github.v3+json',
            },
          });
          if (res.ok) {
            const data = (await res.json()) as any;
            if (typeof data?.id === 'number') {
              repositoryId = data.id;
            }
          }
        }
      } catch {
        // Non-fatal, repositoryId remains undefined/0 and will resolve dynamically upon webhook
      }
    }

    const defaultBranch = (args.defaultBranch || 'main').trim();
    const automationEnabled = args.automationEnabled !== undefined ? Boolean(args.automationEnabled) : true;
    const passthroughEnabled = args.passthroughEnabled !== undefined ? Boolean(args.passthroughEnabled) : true;
    const customProfile = ['chill', 'balanced', 'assertive'].includes(args.customProfile)
      ? args.customProfile
      : 'assertive';
    const generateFlowchart = args.generateFlowchart !== undefined ? Boolean(args.generateFlowchart) : true;
    const settingsJson = typeof args.settings === 'object' && args.settings !== null ? args.settings : {};

    const repoRecord: RepositoryRecord = {
      id: `${owner}/${repo}`,
      owner,
      repo,
      repositoryId,
      installationId,
      defaultBranch,
      automationEnabled,
      passthroughEnabled,
      generateFlowchart,
      customProfile,
      settingsJson,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    try {
      await updateRepositoryInDb(env.DB, owner, repo, repoRecord);
      const summaryText =
        `### 📦 Repository Onboarded\n\n` +
        `- **Repository:** \`${owner}/${repo}\`\n` +
        `- **Numeric Repo ID:** ${repositoryId ? `\`${repositoryId}\`` : '_Pending Auto-Resolution_'}\n` +
        `- **Installation ID:** ${installationId ? `\`${installationId}\`` : '_Inherited / Default_'}\n` +
        `- **Automation Enabled:** ${automationEnabled ? '✅ **Active**' : '⏸️ **Disabled**'}\n` +
        `- **Passthrough Enabled:** ${passthroughEnabled ? '✅ **Active**' : '❌ **Disabled**'}\n` +
        `- **Review Profile:** \`${customProfile}\`\n` +
        `- **Flowchart Generation:** ${generateFlowchart ? '✅ Enabled' : 'Disabled'}\n` +
        `- **Status:** ✅ **Saved to D1 Storage**\n`;

      return {
        content: [
          { type: 'text', text: summaryText },
          { type: 'text', text: JSON.stringify({ ok: true, repository: repoRecord }, null, 2) },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to onboard repository "${owner}/${repo}": ${err?.message || err}` }],
      };
    }
  },
};
