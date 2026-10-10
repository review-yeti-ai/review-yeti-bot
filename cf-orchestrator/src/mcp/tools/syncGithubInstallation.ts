import type { McpToolHandler, McpExecutionContext, ToolResult } from '../types.js';
import {
  saveOrganizationToDb,
  updateRepositoryInDb,
  type OrganizationRecord,
  type RepositoryRecord,
} from '../../storage/d1Client.js';
import { getInstallationToken, signGitHubAppJwt } from '../../github/githubAppAuth.js';

export const syncGithubInstallationTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_sync_github_installation',
    description:
      'Sync an authorized GitHub App installation by installation ID, discovering and enrolling the organization and repositories in D1 with operator passthrough enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        installationId: {
          type: 'number',
          description: 'GitHub App Installation ID (e.g. 5829104)',
        },
        organization: {
          type: 'string',
          description: 'Optional organization login fallback if GitHub API is unreachable (e.g. "calltelemetry")',
        },
        organizationName: {
          type: 'string',
          description: 'Optional human-readable organization name',
        },
        repositories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of repository full names (e.g. ["calltelemetry/ct-uat"]) to sync if GitHub API is unreachable',
        },
        passthroughEnabled: {
          type: 'boolean',
          default: true,
          description: 'Whether operator passthrough is enabled for synced repositories',
        },
        customProfile: {
          type: 'string',
          enum: ['chill', 'balanced', 'assertive'],
          default: 'assertive',
          description: 'Review Yeti strictness profile for synced repositories',
        },
      },
      required: ['installationId'],
    },
  },

  async execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    const installationId = typeof args.installationId === 'number' ? args.installationId : parseInt(args.installationId, 10);
    if (isNaN(installationId) || installationId <= 0) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error: A valid positive numeric "installationId" is required.' }],
      };
    }

    const env = context.env || {};
    const passthroughEnabled = args.passthroughEnabled !== undefined ? Boolean(args.passthroughEnabled) : true;
    const customProfile = ['chill', 'balanced', 'assertive'].includes(args.customProfile)
      ? args.customProfile
      : 'assertive';

    let orgLogin = args.organization ? String(args.organization).toLowerCase().trim() : '';
    let orgName = args.organizationName ? String(args.organizationName).trim() : orgLogin;
    let repoItems: Array<{ id?: number; name: string; full_name: string; default_branch?: string }> = [];

    // 1. Query GitHub API via App JWT if credentials are bound
    if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
      try {
        const jwt = await signGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
        const instRes = await fetch(`https://api.github.com/app/installations/${installationId}`, {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'review-yeti-cf-orchestrator',
          },
        });

        if (instRes.ok) {
          const instData = (await instRes.json()) as any;
          if (instData?.account?.login) {
            orgLogin = String(instData.account.login).toLowerCase();
            orgName = instData.account.name || instData.account.login;
          }
        }

        const token = await getInstallationToken(env, '', '', installationId);
        if (token && !token.startsWith('ghs_dummy_') && !token.startsWith('ghs_ephemeral_')) {
          const reposRes = await fetch(`https://api.github.com/installation/repositories?per_page=100`, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github.v3+json',
              'User-Agent': 'review-yeti-cf-orchestrator',
            },
          });
          if (reposRes.ok) {
            const reposData = (await reposRes.json()) as any;
            if (Array.isArray(reposData.repositories)) {
              repoItems = reposData.repositories.map((r: any) => ({
                id: r.id,
                name: r.name,
                full_name: r.full_name,
                default_branch: r.default_branch || 'main',
              }));
            }
          }
        }
      } catch {
        // Fall back to provided parameters
      }
    }

    // 2. Fall back to manual parameters if GitHub API did not supply repositories
    if (repoItems.length === 0 && Array.isArray(args.repositories)) {
      repoItems = args.repositories.map((r: any) => {
        const full = String(r);
        const parts = full.split('/');
        return {
          name: parts.length > 1 ? parts[1] : full,
          full_name: parts.length > 1 ? full : (orgLogin ? `${orgLogin}/${full}` : full),
          default_branch: 'main',
        };
      });
    }

    if (!orgLogin) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: Could not resolve organization for installation ID ${installationId}. Specify "organization" parameter if syncing offline.`,
          },
        ],
      };
    }

    // 3. Upsert Organization in D1
    const orgRecord: OrganizationRecord = {
      id: orgLogin,
      name: orgName || orgLogin,
      installationId,
      appId: env.GITHUB_APP_ID ? parseInt(env.GITHUB_APP_ID, 10) : 4385771,
      enabled: true,
      passthroughEnabled,
      settingsJson: { customProfile },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveOrganizationToDb(env.DB, orgRecord);

    // 4. Upsert Discovered Repositories in D1
    const savedRepos: RepositoryRecord[] = [];
    for (const item of repoItems) {
      const parts = item.full_name.split('/');
      const owner = (parts[0] || orgLogin).toLowerCase();
      const repoName = parts[1] || item.name;

      const saved = await updateRepositoryInDb(env.DB, owner, repoName, {
        repositoryId: item.id,
        installationId,
        defaultBranch: item.default_branch || 'main',
        automationEnabled: true,
        passthroughEnabled,
        customProfile: customProfile as any,
      });
      savedRepos.push(saved);
    }

    const summaryText =
      `### 🔄 GitHub Installation Synced\n\n` +
      `- **Organization:** \`${orgLogin}\` (${orgName})\n` +
      `- **Installation ID:** \`${installationId}\`\n` +
      `- **Repositories Discovered & Enrolled:** ${savedRepos.length}\n` +
      `- **Passthrough Policy:** ${passthroughEnabled ? '✅ **Enabled**' : '❌ **Disabled**'}\n` +
      `- **Default Strictness Profile:** \`${customProfile}\`\n` +
      `- **Storage Status:** ✅ **Persisted to D1 Storage**\n\n` +
      (savedRepos.length > 0
        ? `**Enrolled Repositories:**\n` + savedRepos.map((r) => `- \`${r.id}\` (Passthrough: ${r.passthroughEnabled ? '✅' : '❌'})`).join('\n')
        : `_No repositories discovered; authorize repositories in GitHub Settings._`);

    return {
      content: [
        { type: 'text', text: summaryText },
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              organization: orgRecord,
              repositoriesCount: savedRepos.length,
              repositories: savedRepos,
            },
            null,
            2
          ),
        },
      ],
    };
  },
};
