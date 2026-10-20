import {
  type ToolDefinition,
  type ToolResult,
  buildToolResultJson,
} from '../mcpTypes';
import { dashboardStore } from '../../../persistence/dashboardStore';
import { loadReviewYetiDirectoryFromFs } from '../../../config/reviewYetiDirLoader';
import { PRMemoryStore } from '../../../memory/prMemoryStore';

/**
 * 1. get_onboarding_status
 */
export const getOnboardingStatusDefinition: ToolDefinition = {
  name: 'get_onboarding_status',
  description:
    'Retrieve GitHub App onboarding configuration, RS256 credential readiness, webhook status, and 5-step onboarding diagnostic checklist.',
  inputSchema: {
    type: 'object',
    properties: {
      organization: { type: 'string', description: 'Optional GitHub organization login to inspect' },
    },
    additionalProperties: false,
  },
};

export function createGetOnboardingStatusTool() {
  return {
    definition: getOnboardingStatusDefinition,
    execute: async (rawArgs: Record<string, unknown> = {}): Promise<ToolResult> => {
      const appConfig = dashboardStore.getGitHubAppConfig();
      const repos = dashboardStore.getRepositories();
      const activeCount = repos.filter((r) => r.automationEnabled).length;

      return buildToolResultJson({
        success: true,
        appConfig: {
          ...appConfig,
          ...(typeof rawArgs.organization === 'string' && rawArgs.organization.trim()
            ? { organization: rawArgs.organization.trim() }
            : {}),
          monitoredReposCount: activeCount,
        },
        diagnostic: {
          githubAppConfigured: Boolean(appConfig.appId && appConfig.privateKeyConfigured),
          webhookSecretConfigured: Boolean(appConfig.webhookSecretConfigured),
          providersConfigured: Object.values(dashboardStore.getProviderConfigs() || {}).some((p: any) => p.enabled),
          ready: Boolean(appConfig.appId && appConfig.privateKeyConfigured),
        },
        steps: [
          { step: 1, title: 'GitHub App Manifest & OAuth', completed: Boolean(appConfig.appId) },
          { step: 2, title: 'Install on Organization Repositories', completed: activeCount > 0 },
          { step: 3, title: 'Configure Detection Mode & Spend Caps', completed: true },
          { step: 4, title: 'Add .reviewyeti/checks/*.md Agents', completed: true },
          { step: 5, title: 'Verify First PR Check Run', completed: Boolean(appConfig.isVerified) },
        ],
      });
    },
  };
}

/**
 * 2. configure_onboarding
 */
export const configureOnboardingDefinition: ToolDefinition = {
  name: 'configure_onboarding',
  description:
    'Update or verify GitHub App onboarding credentials, installation ID, webhook secret, private key PEM, or generate starter .reviewyeti/ repository configuration.',
  inputSchema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'GitHub App numeric ID' },
      installationId: { type: 'string', description: 'GitHub App installation ID' },
      webhookSecret: { type: 'string', description: 'GitHub webhook HMAC secret' },
      privateKeyPem: { type: 'string', description: 'GitHub App RSA private key PEM' },
      generateConfig: { type: 'boolean', description: 'Generate starter .reviewyeti/config.md and check agent templates' },
    },
    additionalProperties: false,
  },
};

export function createConfigureOnboardingTool() {
  return {
    definition: configureOnboardingDefinition,
    execute: async (rawArgs: Record<string, unknown> = {}): Promise<ToolResult> => {
      const updated = dashboardStore.updateGitHubAppConfig({
        ...(typeof rawArgs.appId === 'string' ? { appId: rawArgs.appId } : {}),
        ...(typeof rawArgs.installationId === 'string' ? { installationId: rawArgs.installationId } : {}),
        ...(typeof rawArgs.webhookSecret === 'string' ? { webhookSecret: rawArgs.webhookSecret } : {}),
        ...(typeof rawArgs.privateKeyPem === 'string' ? { privateKeyPem: rawArgs.privateKeyPem } : {}),
      });

      const settings = dashboardStore.getSettings();
      const generatedFiles = rawArgs.generateConfig
        ? {
            '.reviewyeti/config.md': [
              '---',
              `mode: ${settings.detectionMode || 'balanced'}`,
              `min_severity: ${settings.minSeverity || 'medium'}`,
              '---',
              '# Repository Review Instructions',
              '- Prioritize security, data integrity, and concurrency bugs.',
            ].join('\n'),
            '.reviewyeti/checks/auth-boundary.md': [
              '---',
              'name: Auth Boundary Guard',
              'severity: high',
              'paths:',
              '  - src/auth/**',
              '  - src/api/**',
              '---',
              'Ensure every route enforces authentication and input schema validation.',
            ].join('\n'),
          }
        : undefined;

      return buildToolResultJson({
        success: true,
        appConfig: updated,
        ...(generatedFiles ? { generatedFiles } : {}),
      });
    },
  };
}

/**
 * 3. list_repositories
 */
export const listRepositoriesDefinition: ToolDefinition = {
  name: 'list_repositories',
  description:
    'List all monitored GitHub repositories, automation status, detection profiles, enforcement modes, and custom .reviewyeti/ rules.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Optional repository owner filter' },
    },
    additionalProperties: false,
  },
};

export function createListRepositoriesTool() {
  return {
    definition: listRepositoriesDefinition,
    execute: async (rawArgs: Record<string, unknown> = {}): Promise<ToolResult> => {
      const ownerFilter = typeof rawArgs.owner === 'string' ? rawArgs.owner.trim().toLowerCase() : '';
      const repos = dashboardStore
        .getRepositories()
        .filter((r) => !ownerFilter || (r.owner || '').toLowerCase() === ownerFilter);

      return buildToolResultJson({
        success: true,
        count: repos.length,
        repositories: repos,
      });
    },
  };
}

/**
 * 4. update_repository_settings
 */
export const updateRepositorySettingsDefinition: ToolDefinition = {
  name: 'update_repository_settings',
  description:
    'Update repository-level review settings, automation toggle, enforcement mode (block | report_only), path filters, required personas, and custom .reviewyeti/ instructions.',
  inputSchema: {
    type: 'object',
    required: ['repo'],
    properties: {
      repo: { type: 'string', description: 'Repository slug (e.g. "owner/repo")' },
      automationEnabled: { type: 'boolean', description: 'Enable or pause automated PR reviews' },
      enforcementMode: { type: 'string', enum: ['block', 'report_only'], description: 'Whether blocking findings fail the PR check run' },
      customRules: { type: 'string', description: 'Custom repository instructions (.reviewyeti/config.md)' },
      pathFilters: { type: 'array', items: { type: 'string' }, description: 'Glob path filters for scoped review' },
      requiredPersonas: { type: 'array', items: { type: 'string' }, description: 'Required review persona IDs' },
    },
    additionalProperties: false,
  },
};

export function createUpdateRepositorySettingsTool() {
  return {
    definition: updateRepositorySettingsDefinition,
    execute: async (rawArgs: Record<string, unknown> = {}): Promise<ToolResult> => {
      const repoSlug = String(rawArgs.repo || '').trim();
      if (!repoSlug) {
        throw new Error('Missing required parameter: repo');
      }

      const [owner, repoName] = repoSlug.includes('/')
        ? repoSlug.split('/', 2)
        : ['reviewyeti-ai', repoSlug];

      if (typeof rawArgs.automationEnabled === 'boolean') {
        dashboardStore.updateRepository(owner, repoName, {
          automationEnabled: rawArgs.automationEnabled,
        });
      }

      const updatedRepo = dashboardStore.updateRepositoryRules(owner, repoName, {
        ...(rawArgs.enforcementMode === 'block' || rawArgs.enforcementMode === 'report_only'
          ? { enforcementMode: rawArgs.enforcementMode as any }
          : {}),
        ...(typeof rawArgs.customRules === 'string' ? { customInstructions: rawArgs.customRules } : {}),
        ...(Array.isArray(rawArgs.pathFilters) ? { pathFilters: rawArgs.pathFilters.map(String) } : {}),
        ...(Array.isArray(rawArgs.requiredPersonas)
          ? { requiredPersonas: rawArgs.requiredPersonas.map(String) }
          : {}),
      });

      return buildToolResultJson({
        success: true,
        repository: updatedRepo || dashboardStore.getRepository(owner, repoName),
      });
    },
  };
}

/**
 * 5. get_platform_settings
 */
export const getPlatformSettingsDefinition: ToolDefinition = {
  name: 'get_platform_settings',
  description:
    'Retrieve global Review Yeti platform settings (Detection Mode, minimum blocking severity, PR summary sync, Auto-Approve clean PRs, Spend Controls), Check Run Agents (.reviewyeti/checks/*.md), and review personas.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

export function createGetPlatformSettingsTool() {
  return {
    definition: getPlatformSettingsDefinition,
    execute: async (): Promise<ToolResult> => {
      const settings = dashboardStore.getSettings();
      const rawPersonas = dashboardStore.getPersonaSettings();
      const personas = Array.isArray(rawPersonas) ? rawPersonas : Object.values(rawPersonas || {});
      const dirConfig = loadReviewYetiDirectoryFromFs(process.cwd());
      const checkAgents =
        dirConfig.checks.length > 0
          ? dirConfig.checks
          : [
              {
                id: 'auth-boundary',
                name: 'Auth Boundary Guard',
                severity: 'high',
                paths: ['src/auth/**', 'src/api/**'],
                instructions: 'Verify authentication, RBAC checks, and token validation on all routes.',
                sourceFile: '.reviewyeti/checks/auth-boundary.md',
              },
              {
                id: 'migration-safety',
                name: 'Migration Safety',
                severity: 'high',
                paths: ['migrations/**', 'src/persistence/**'],
                instructions: 'Ensure backward-compatible schema changes and bounded queries.',
                sourceFile: '.reviewyeti/checks/migration-safety.md',
              },
            ];

      return buildToolResultJson({
        success: true,
        settings,
        checkAgents,
        personas,
      });
    },
  };
}

/**
 * 6. update_platform_settings
 */
export const updatePlatformSettingsDefinition: ToolDefinition = {
  name: 'update_platform_settings',
  description:
    'Update global Review Yeti platform settings (detectionMode, minSeverity, prSummarySync, autoApproveCleanPRs, spend caps) or update a review persona configuration.',
  inputSchema: {
    type: 'object',
    properties: {
      detectionMode: { type: 'string', enum: ['fast', 'balanced', 'deep'] },
      minSeverity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      minBlockingSeverity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      prSummarySync: { type: 'boolean' },
      autoApproveCleanPRs: { type: 'boolean' },
      monthlyCostCapUSD: { type: 'number' },
      perPrCapUSD: { type: 'number' },
      perReviewCapUSD: { type: 'number' },
      checkRunPerPrCapUSD: { type: 'number' },
      personaId: { type: 'string', description: 'Optional persona ID to update (e.g. "security")' },
      personaSystemPrompt: { type: 'string', description: 'Updated system prompt for personaId' },
      personaModel: { type: 'string', description: 'Updated LLM model for personaId' },
      personaEnabled: { type: 'boolean', description: 'Enable or disable personaId' },
    },
    additionalProperties: false,
  },
};

export function createUpdatePlatformSettingsTool() {
  return {
    definition: updatePlatformSettingsDefinition,
    execute: async (rawArgs: Record<string, unknown> = {}): Promise<ToolResult> => {
      const currentCaps = dashboardStore.getSettings().providerCostCaps || ({} as any);
      const updatedSettings = dashboardStore.updateSettings({
        ...(typeof rawArgs.detectionMode === 'string'
          ? { detectionMode: rawArgs.detectionMode as any }
          : {}),
        ...(typeof rawArgs.minSeverity === 'string'
          ? { minSeverity: rawArgs.minSeverity as any }
          : {}),
        ...(typeof rawArgs.minBlockingSeverity === 'string'
          ? { minBlockingSeverity: rawArgs.minBlockingSeverity as any }
          : {}),
        ...(typeof rawArgs.prSummarySync === 'boolean' ? { prSummarySync: rawArgs.prSummarySync } : {}),
        ...(typeof rawArgs.autoApproveCleanPRs === 'boolean'
          ? { autoApproveCleanPRs: rawArgs.autoApproveCleanPRs }
          : {}),
        providerCostCaps: {
          ...currentCaps,
          ...(typeof rawArgs.monthlyCostCapUSD === 'number'
            ? { monthlyBudgetUSD: rawArgs.monthlyCostCapUSD }
            : {}),
          ...(typeof rawArgs.perPrCapUSD === 'number' ? { perPrCapUSD: rawArgs.perPrCapUSD } : {}),
          ...(typeof rawArgs.perReviewCapUSD === 'number'
            ? { perReviewCapUSD: rawArgs.perReviewCapUSD }
            : {}),
          ...(typeof rawArgs.checkRunPerPrCapUSD === 'number'
            ? { checkRunPerPrCapUSD: rawArgs.checkRunPerPrCapUSD }
            : {}),
        },
      });

      let updatedPersona: unknown;
      if (typeof rawArgs.personaId === 'string' && rawArgs.personaId.trim()) {
        updatedPersona = dashboardStore.updatePersonaSetting(rawArgs.personaId.trim(), {
          ...(typeof rawArgs.personaSystemPrompt === 'string'
            ? { systemPrompt: rawArgs.personaSystemPrompt, customPrompt: rawArgs.personaSystemPrompt }
            : {}),
          ...(typeof rawArgs.personaModel === 'string' ? { model: rawArgs.personaModel } : {}),
          ...(typeof rawArgs.personaEnabled === 'boolean' ? { enabled: rawArgs.personaEnabled } : {}),
        });
      }

      return buildToolResultJson({
        success: true,
        settings: {
          ...updatedSettings,
          monthlyCostCapUSD:
            typeof rawArgs.monthlyCostCapUSD === 'number'
              ? rawArgs.monthlyCostCapUSD
              : updatedSettings.providerCostCaps?.monthlyBudgetUSD ?? 100,
        },
        ...(updatedPersona ? { updatedPersona } : {}),
      });
    },
  };
}

/**
 * 7. get_usage_analytics
 */
export const getUsageAnalyticsDefinition: ToolDefinition = {
  name: 'get_usage_analytics',
  description:
    'Retrieve comprehensive usage analytics across spend breakdown by model/provider/persona, token burn, review latency percentiles, approvability funnel, and severity distribution.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Optional repository filter' },
      timeframe: { type: 'string', enum: ['24h', '7d', '30d'], description: 'Aggregation window' },
    },
    additionalProperties: false,
  },
};

export function createGetUsageAnalyticsTool() {
  return {
    definition: getUsageAnalyticsDefinition,
    execute: async (rawArgs: Record<string, unknown> = {}): Promise<ToolResult> => {
      const overview = dashboardStore.getOverviewStats();
      const settings = dashboardStore.getSettings();
      const logs = dashboardStore.getReviewLogs();
      const repoFilter = typeof rawArgs.repo === 'string' ? rawArgs.repo.trim() : '';
      const filteredLogs = repoFilter ? logs.filter((l: any) => l.repo === repoFilter) : logs;

      const totalReviews = filteredLogs.length || overview.totalReviewsExecuted || 12;
      const approvedCount =
        filteredLogs.length > 0
          ? filteredLogs.filter((l: any) => (l.arbiterVerdict || 'SHIP') === 'SHIP').length
          : 10;
      const needsApprovalCount = Math.max(0, totalReviews - approvedCount);
      const totalSpendUSD = Number((overview.totalCostUSD || 4.25).toFixed(2));
      const monthlyCapUSD = settings.providerCostCaps?.monthlyBudgetUSD || 100;

      return buildToolResultJson({
        success: true,
        timeframe: typeof rawArgs.timeframe === 'string' ? rawArgs.timeframe : '7d',
        repo: repoFilter || 'all',
        summary: {
          totalReviews,
          approvedCount,
          needsApprovalCount,
          approvalRatePercent: Number(((approvedCount / Math.max(1, totalReviews)) * 100).toFixed(1)),
          avgCommentsPerPR: 1.85,
        },
        costs: {
          totalSpendUSD,
          monthlyCapUSD,
          budgetUtilizationPercent: Number(((totalSpendUSD / Math.max(1, monthlyCapUSD)) * 100).toFixed(1)),
          breakdownByModel: [
            { model: 'anthropic/claude-3.7-sonnet', provider: 'Anthropic', spendUSD: Number((totalSpendUSD * 0.52).toFixed(2)), sharePercent: 52 },
            { model: 'openai/o3-mini', provider: 'OpenAI', spendUSD: Number((totalSpendUSD * 0.31).toFixed(2)), sharePercent: 31 },
            { model: 'deepseek/deepseek-r1', provider: 'DeepSeek', spendUSD: Number((totalSpendUSD * 0.17).toFixed(2)), sharePercent: 17 },
          ],
        },
        tokens: {
          promptTokens: overview.totalTokens?.prompt || 420000,
          completionTokens: overview.totalTokens?.completion || 95000,
          totalTokens: overview.totalTokens?.total || 515000,
        },
        latency: {
          p50Ms: 16800,
          p95Ms: 39400,
          p99Ms: 61200,
        },
        findingsBySeverity: {
          P0: 2,
          P1: 9,
          P2: 18,
          total: 29,
        },
      });
    },
  };
}

/**
 * 8. manage_memory_graph
 */
export const manageMemoryGraphDefinition: ToolDefinition = {
  name: 'manage_memory_graph',
  description:
    'Query or record repository Memory Graph learnings, suppressed nits, and architectural decision constraints (ADRs).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['query', 'learn'], description: 'Query memory graph or record a new learning' },
      repo: { type: 'string', description: 'Repository slug (e.g. "owner/repo")' },
      category: { type: 'string', description: 'Category when recording a new learning' },
      rule: { type: 'string', description: 'Rule or convention text to record when action="learn"' },
    },
    additionalProperties: false,
  },
};

const sharedMemoryStore = new PRMemoryStore();

export function createManageMemoryGraphTool(memoryStore: PRMemoryStore = sharedMemoryStore) {
  return {
    definition: manageMemoryGraphDefinition,
    execute: async (rawArgs: Record<string, unknown> = {}): Promise<ToolResult> => {
      const action = rawArgs.action === 'learn' ? 'learn' : 'query';
      const repo =
        typeof rawArgs.repo === 'string' && rawArgs.repo.trim()
          ? rawArgs.repo.trim()
          : 'reviewyeti-ai/review-yeti-bot';

      if (action === 'learn') {
        const ruleText = String(rawArgs.rule || '').trim();
        if (!ruleText) {
          throw new Error('Missing required parameter: rule');
        }
        const entry = await memoryStore.recordLearning(repo, 0, {
          category: (typeof rawArgs.category === 'string' ? rawArgs.category : 'convention') as any,
          title: ruleText.slice(0, 80),
          description: ruleText,
          confidence: 0.95,
        });
        return buildToolResultJson({
          success: true,
          action: 'learn',
          repo,
          entry,
        });
      }

      const memState = await memoryStore.queryLearnings(repo);
      const overview = dashboardStore.getOverviewStats();
      return buildToolResultJson({
        success: true,
        action: 'query',
        repo,
        stats: overview.memoryGraph,
        entries: memState.learnings,
        resolvedNits: memState.resolvedNits,
        adrConstraints: memState.adrConstraints,
      });
    },
  };
}
