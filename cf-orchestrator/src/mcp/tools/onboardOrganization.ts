import type { McpToolHandler, McpExecutionContext, ToolResult } from '../types.js';
import { saveOrganizationToDb, type OrganizationRecord } from '../../storage/d1Client.js';

export const onboardOrganizationTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_onboard_organization',
    description:
      'Onboard or update an organization configuration in Review Yeti orchestrator storage (D1), setting default review profile and passthrough policy.',
    inputSchema: {
      type: 'object',
      properties: {
        org: {
          type: 'string',
          description: 'GitHub organization login or account name (e.g. "calltelemetry")',
        },
        displayName: {
          type: 'string',
          description: 'Human-readable display name for the organization',
        },
        installationId: {
          type: 'number',
          description: 'GitHub App Installation ID for this organization',
        },
        defaultProfile: {
          type: 'string',
          enum: ['chill', 'balanced', 'assertive'],
          default: 'assertive',
          description: 'Default Review Yeti persona profile for enrolled repositories',
        },
        passthroughDefault: {
          type: 'boolean',
          default: true,
          description: 'Whether global operator passthrough is enabled by default for repositories in this org',
        },
        settings: {
          type: 'object',
          description: 'Optional organization-wide settings dictionary',
        },
      },
      required: ['org'],
    },
  },

  async execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    const org = (args.org || '').trim();
    if (!org) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error: Missing required parameter "org"' }],
      };
    }

    const defaultProfile = ['chill', 'balanced', 'assertive'].includes(args.defaultProfile)
      ? args.defaultProfile
      : 'assertive';
    const passthroughDefault = args.passthroughDefault !== undefined ? Boolean(args.passthroughDefault) : true;
    const displayName = args.displayName ? String(args.displayName).trim() : org;
    const installationId = typeof args.installationId === 'number' ? args.installationId : undefined;
    const settingsJson = typeof args.settings === 'object' && args.settings !== null ? args.settings : {};

    const env = context.env || {};
    const orgRecord: OrganizationRecord = {
      id: org.toLowerCase(),
      name: displayName,
      installationId,
      enabled: true,
      passthroughEnabled: passthroughDefault,
      settingsJson: {
        defaultProfile,
        ...settingsJson,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    try {
      await saveOrganizationToDb(env.DB, orgRecord);
      const summaryText =
        `### 🏢 Organization Onboarded\n\n` +
        `- **Organization:** \`${org}\`\n` +
        `- **Display Name:** ${displayName}\n` +
        `- **Installation ID:** ${installationId ? `\`${installationId}\`` : '_None_'}\n` +
        `- **Default Profile:** \`${defaultProfile}\`\n` +
        `- **Passthrough Default:** ${passthroughDefault ? '✅ **Enabled**' : '❌ **Disabled**'}\n` +
        `- **Status:** ✅ **Saved to D1 Storage**\n`;

      return {
        content: [
          { type: 'text', text: summaryText },
          { type: 'text', text: JSON.stringify({ ok: true, organization: orgRecord }, null, 2) },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to onboard organization "${org}": ${err?.message || err}` }],
      };
    }
  },
};
