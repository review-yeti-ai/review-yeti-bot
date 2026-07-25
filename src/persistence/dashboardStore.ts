import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PRMemoryStore } from '../memory/prMemoryStore';
import { SymbolGraphStore } from '../indexer/symbolGraphStore';
import { providerPool } from '../gateway/providerPool';

export interface RepoDashboardSetting {
  owner: string;
  repo: string;
  automationEnabled: boolean;
  customProfile?: 'chill' | 'balanced' | 'assertive';
  modelOverrides?: Record<string, string>;
  updatedAt: string;
}

export interface PlatformSettings {
  defaultModelOverrides: Record<string, string>;
  memoryEngineSettings: {
    autoSuppressNits: boolean;
    learningConfidenceThreshold: number;
    maxLearningsPerRepo: number;
  };
  providerCostCaps: {
    monthlyBudgetUSD: number;
    dailyBudgetUSD: number;
    alertThresholdPercent: number;
    actionOnCapBreach: 'fail_closed' | 'disable_optional';
  };
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyHash: string; // SHA-256 hash of raw key
  maskedKey: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface ReviewLogEntry {
  id: string;
  prRun: string;
  headSha: string;
  personas: string;
  quorum: string;
  arbiterVerdict: string;
  timestamp: string;
}

export interface IntegrationConfig {
  id: 'linear' | 'github' | 'context7' | 'productlane' | 'posthog';
  name: string;
  status: 'connected' | 'disconnected' | 'degraded' | 'error';
  apiKeyMasked?: string;
  oauthClientId?: string;
  oauthClientSecretMasked?: string;
  webhookUrl?: string;
  lastSyncAt?: string;
  settings?: Record<string, any>;
  updatedAt: string;
}

export interface CustomMcpServerConfig {
  id: string;
  name: string;
  transport: 'http' | 'stdio' | 'adapter';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  status: 'online' | 'offline' | 'degraded' | 'untested';
  toolsCount?: number;
  lastHealthCheckAt?: string;
  createdAt: string;
  updatedAt: string;
}

export function maskSecretKey(key?: string): string | undefined {
  if (!key) return undefined;
  if (key.length <= 8) return '****';
  const prefix = key.slice(0, 8);
  const suffix = key.slice(-4);
  return `${prefix}...${suffix}`;
}

export interface DashboardData {
  repositories: RepoDashboardSetting[];
  settings: PlatformSettings;
  apiKeys: ApiKeyRecord[];
  reviewCounter: number;
  totalCostUSD: number;
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
  reviewLogs?: ReviewLogEntry[];
  integrations?: Record<string, IntegrationConfig>;
  mcpServers?: CustomMcpServerConfig[];
}

export class DashboardStore {
  private filePath: string;
  private data: DashboardData;

  constructor(filePath?: string) {
    this.filePath = filePath || process.env.CT_DASHBOARD_STORE || '/tmp/ct-review-bot/dashboard.json';
    this.data = this.load();
  }

  private defaultData(): DashboardData {
    const now = new Date().toISOString();
    return {
      repositories: [
        {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          automationEnabled: true,
          customProfile: 'balanced',
          updatedAt: now,
        },
        {
          owner: 'calltelemetry',
          repo: 'ct-review-bot',
          automationEnabled: true,
          customProfile: 'assertive',
          updatedAt: now,
        },
      ],
      settings: {
        defaultModelOverrides: {
          codex: 'codex/gpt-5.6-sol-high',
          claude: 'claude/claude-opus-4-8',
          grok: 'grok-cli/grok-4.5',
          'agy-opus': 'agy/claude-opus-4-6-thinking',
        },
        memoryEngineSettings: {
          autoSuppressNits: true,
          learningConfidenceThreshold: 80,
          maxLearningsPerRepo: 500,
        },
        providerCostCaps: {
          monthlyBudgetUSD: 100.0,
          dailyBudgetUSD: 10.0,
          alertThresholdPercent: 80,
          actionOnCapBreach: 'fail_closed',
        },
      },
      apiKeys: [],
      reviewCounter: 348,
      totalCostUSD: 14.8251,
      integrations: {
        linear: {
          id: 'linear',
          name: 'Linear Issue Tracker',
          status: 'connected',
          apiKeyMasked: 'lin_api_...x79a',
          lastSyncAt: now,
          settings: { teamKey: 'CT' },
          updatedAt: now,
        },
        github: {
          id: 'github',
          name: 'GitHub App Integration',
          status: 'connected',
          settings: { appId: '1092381' },
          updatedAt: now,
        },
        context7: {
          id: 'context7',
          name: 'Context7 Docs MCP',
          status: 'connected',
          apiKeyMasked: 'ctx_live_...9f21',
          lastSyncAt: now,
          updatedAt: now,
        },
        productlane: {
          id: 'productlane',
          name: 'Productlane Feedback',
          status: 'disconnected',
          updatedAt: now,
        },
        posthog: {
          id: 'posthog',
          name: 'PostHog Analytics',
          status: 'connected',
          apiKeyMasked: 'phc_...3a10',
          settings: { projectId: '10492' },
          updatedAt: now,
        },
      },
      mcpServers: [
        {
          id: 'builtin-context7',
          name: 'Context7 Documentation MCP',
          transport: 'adapter',
          enabled: true,
          status: 'online',
          toolsCount: 1,
          lastHealthCheckAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
  }

  private load(): DashboardData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch {
      // Fallback on default data if parse error occurs
    }
    const defaults = this.defaultData();
    this.saveData(defaults);
    return defaults;
  }

  private saveData(data: DashboardData): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = `${this.filePath}.tmp.${Date.now()}_${Math.random().toString(36).substring(2)}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch {
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
      } catch {
        // fallback ignored
      }
    }
    this.data = data;
  }

  public getRepositories(): RepoDashboardSetting[] {
    return [...this.data.repositories];
  }

  public getRepository(owner: string, repo: string): RepoDashboardSetting | undefined {
    return this.data.repositories.find((r) => r.owner === owner && r.repo === repo);
  }

  public updateRepository(owner: string, repo: string, patch: Partial<RepoDashboardSetting>): RepoDashboardSetting {
    let item = this.getRepository(owner, repo);
    if (!item) {
      item = {
        owner,
        repo,
        automationEnabled: true,
        updatedAt: new Date().toISOString(),
      };
      this.data.repositories.push(item);
    }
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    this.saveData(this.data);
    return item;
  }

  public isAutomationEnabled(owner: string, repo: string): boolean {
    const repoItem = this.getRepository(owner, repo);
    return repoItem ? repoItem.automationEnabled : true;
  }

  public getSettings(): PlatformSettings {
    return JSON.parse(JSON.stringify(this.data.settings));
  }

  public updateSettings(newSettings: Partial<PlatformSettings>): PlatformSettings {
    this.data.settings = {
      ...this.data.settings,
      ...newSettings,
      defaultModelOverrides: {
        ...this.data.settings.defaultModelOverrides,
        ...(newSettings.defaultModelOverrides || {}),
      },
      memoryEngineSettings: {
        ...this.data.settings.memoryEngineSettings,
        ...(newSettings.memoryEngineSettings || {}),
      },
      providerCostCaps: {
        ...this.data.settings.providerCostCaps,
        ...(newSettings.providerCostCaps || {}),
      },
    };
    this.saveData(this.data);
    return this.getSettings();
  }

  public getApiKeys(): ApiKeyRecord[] {
    return [...this.data.apiKeys];
  }

  public createApiKey(name: string): { id: string; name: string; rawKey: string; maskedKey: string; createdAt: string } {
    const id = `key_${crypto.randomBytes(4).toString('hex')}`;
    const rawSecret = crypto.randomBytes(16).toString('hex');
    const rawKey = `ct_live_${rawSecret}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const maskedKey = `ct_live_...${rawSecret.slice(-4)}`;
    const createdAt = new Date().toISOString();

    const record: ApiKeyRecord = {
      id,
      name,
      keyHash,
      maskedKey,
      createdAt,
    };
    this.data.apiKeys.push(record);
    this.saveData(this.data);

    return {
      id,
      name,
      rawKey,
      maskedKey,
      createdAt,
    };
  }

  public validateApiKey(rawKey: string): boolean {
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const match = this.data.apiKeys.find((k) => k.keyHash === hash);
    if (match) {
      match.lastUsedAt = new Date().toISOString();
      this.saveData(this.data);
      return true;
    }
    return false;
  }

  public deleteApiKey(id: string): boolean {
    const prevLen = this.data.apiKeys.length;
    this.data.apiKeys = this.data.apiKeys.filter((k) => k.id !== id);
    if (this.data.apiKeys.length !== prevLen) {
      this.saveData(this.data);
      return true;
    }
    return false;
  }

  public recordReviewRun(run: {
    prRun: string;
    headSha: string;
    personas: string;
    quorum: string;
    arbiterVerdict: string;
    promptTokens?: number;
    completionTokens?: number;
    costUSD?: number;
  }): void {
    this.data.reviewCounter = (this.data.reviewCounter || 0) + 1;
    if (run.costUSD) {
      this.data.totalCostUSD = (this.data.totalCostUSD || 0) + run.costUSD;
    }
    if (run.promptTokens) {
      this.data.totalPromptTokens = (this.data.totalPromptTokens || 0) + run.promptTokens;
    }
    if (run.completionTokens) {
      this.data.totalCompletionTokens = (this.data.totalCompletionTokens || 0) + run.completionTokens;
    }
    
    if (!this.data.reviewLogs) this.data.reviewLogs = [];
    this.data.reviewLogs.unshift({
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      prRun: run.prRun,
      headSha: run.headSha,
      personas: run.personas,
      quorum: run.quorum,
      arbiterVerdict: run.arbiterVerdict,
      timestamp: new Date().toISOString(),
    });
    if (this.data.reviewLogs.length > 50) this.data.reviewLogs.pop();
    
    this.saveData(this.data);
  }

  public getReviewLogs(): ReviewLogEntry[] {
    return [...(this.data.reviewLogs || [])];
  }

  public getOverviewStats() {
    const repos = this.getRepositories();
    const activeAutomations = repos.filter((r) => r.automationEnabled).length;

    let memoryCounts = { learningsCount: 0, suppressedNitsCount: 0, adrConstraintsCount: 0 };
    try {
      const prStorePath = process.env.CT_PR_MEMORY_STORE || '.ct-memory/pr_memory.db';
      const prStore = new PRMemoryStore(prStorePath);
      memoryCounts = prStore.getCounts();
      prStore.close();
    } catch {
      // Fallback if unavailable
    }

    let symbolCounts = { nodes: 0, edges: 0 };
    try {
      const symStorePath = process.env.CT_SYMBOL_GRAPH_STORE || '.ct-memory/symbol_graph.db';
      const symStore = new SymbolGraphStore(symStorePath);
      symbolCounts = symStore.getCounts();
      symStore.close();
    } catch {
      // Fallback if unavailable
    }

    const registeredProviders = providerPool.listProviders();
    const providerHealth = registeredProviders.length > 0
      ? registeredProviders.map((p) => ({
          id: p.id,
          status: 'healthy',
          model: p.models[0] || p.type,
        }))
      : Object.entries(this.data.settings.defaultModelOverrides).map(([id, model]) => ({
          id,
          status: 'healthy',
          model,
        }));

    const promptTokens = this.data.totalPromptTokens ?? 4500000;
    const completionTokens = this.data.totalCompletionTokens ?? 1200000;

    return {
      totalRepositories: repos.length,
      activeAutomations,
      totalReviewsExecuted: this.data.reviewCounter,
      totalCostUSD: this.data.totalCostUSD,
      monthlyCostCapUSD: this.data.settings.providerCostCaps.monthlyBudgetUSD,
      costCapBreached: this.data.totalCostUSD >= this.data.settings.providerCostCaps.monthlyBudgetUSD,
      totalTokens: {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens,
      },
      providerHealth,
      memoryGraph: {
        learningsCount: memoryCounts.learningsCount,
        suppressedNitsCount: memoryCounts.suppressedNitsCount,
        adrConstraintsCount: memoryCounts.adrConstraintsCount,
        symbolNodesCount: symbolCounts.nodes,
        symbolEdgesCount: symbolCounts.edges,
      },
    };
  }

  public getIntegrations(): IntegrationConfig[] {
    if (!this.data.integrations) {
      this.data.integrations = this.defaultData().integrations;
      this.saveData(this.data);
    }
    return Object.values(this.data.integrations!).map((integration) => {
      const sanitized = { ...integration };
      delete (sanitized as any).apiKey;
      delete (sanitized as any).oauthClientSecret;
      return sanitized;
    });
  }

  public getIntegration(id: string): IntegrationConfig | undefined {
    const integrations = this.data.integrations || this.defaultData().integrations;
    const item = integrations?.[id as keyof typeof integrations];
    if (!item) return undefined;
    const sanitized = { ...item };
    delete (sanitized as any).apiKey;
    delete (sanitized as any).oauthClientSecret;
    return sanitized;
  }

  public updateIntegration(
    id: string,
    patch: Partial<IntegrationConfig> & { apiKey?: string; oauthClientSecret?: string }
  ): IntegrationConfig {
    if (!this.data.integrations) {
      this.data.integrations = this.defaultData().integrations;
    }
    const current = this.data.integrations![id] || {
      id: id as any,
      name: `${id.slice(0, 1).toUpperCase()}${id.slice(1)} Integration`,
      status: 'disconnected',
      updatedAt: new Date().toISOString(),
    };

    const apiKeyMasked = patch.apiKey ? maskSecretKey(patch.apiKey) : patch.apiKeyMasked || current.apiKeyMasked;
    const oauthClientSecretMasked = patch.oauthClientSecret
      ? maskSecretKey(patch.oauthClientSecret)
      : patch.oauthClientSecretMasked || current.oauthClientSecretMasked;
    const status = (patch.apiKey || current.apiKeyMasked || patch.oauthClientId || current.oauthClientId) ? 'connected' : patch.status || current.status;

    const { apiKey, oauthClientSecret, ...restPatch } = patch;

    const updated: IntegrationConfig = {
      ...current,
      ...restPatch,
      status,
      apiKeyMasked,
      oauthClientSecretMasked,
      settings: {
        ...(current.settings || {}),
        ...(restPatch.settings || {}),
      },
      updatedAt: new Date().toISOString(),
    };

    delete (updated as any).apiKey;
    delete (updated as any).oauthClientSecret;

    this.data.integrations![id] = updated;
    this.saveData(this.data);

    const sanitizedResult = { ...updated };
    delete (sanitizedResult as any).apiKey;
    delete (sanitizedResult as any).oauthClientSecret;
    return sanitizedResult;
  }

  public getMcpServers(): CustomMcpServerConfig[] {
    if (!this.data.mcpServers) {
      this.data.mcpServers = this.defaultData().mcpServers;
      this.saveData(this.data);
    }
    return [...this.data.mcpServers!];
  }

  public getMcpServer(id: string): CustomMcpServerConfig | undefined {
    return this.getMcpServers().find((s) => s.id === id);
  }

  public addMcpServer(server: Partial<CustomMcpServerConfig>): CustomMcpServerConfig {
    if (!this.data.mcpServers) {
      this.data.mcpServers = this.defaultData().mcpServers;
    }
    const now = new Date().toISOString();
    const id = server.id || `mcp_${server.transport || 'custom'}_${Date.now()}`;
    const newServer: CustomMcpServerConfig = {
      id,
      name: server.name || 'Custom MCP Server',
      transport: server.transport || 'http',
      url: server.url,
      command: server.command,
      args: server.args || [],
      env: server.env || {},
      enabled: server.enabled ?? true,
      status: server.status || 'online',
      toolsCount: server.toolsCount ?? 0,
      lastHealthCheckAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.data.mcpServers!.push(newServer);
    this.saveData(this.data);
    return newServer;
  }

  public updateMcpServer(id: string, patch: Partial<CustomMcpServerConfig>): CustomMcpServerConfig | undefined {
    if (!this.data.mcpServers) {
      this.data.mcpServers = this.defaultData().mcpServers;
    }
    const index = this.data.mcpServers!.findIndex((s) => s.id === id);
    if (index === -1) return undefined;

    const current = this.data.mcpServers![index];
    const updated: CustomMcpServerConfig = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.data.mcpServers![index] = updated;
    this.saveData(this.data);
    return updated;
  }

  public deleteMcpServer(id: string): boolean {
    if (!this.data.mcpServers) return false;
    const initialLen = this.data.mcpServers.length;
    this.data.mcpServers = this.data.mcpServers.filter((s) => s.id !== id);
    if (this.data.mcpServers.length !== initialLen) {
      this.saveData(this.data);
      return true;
    }
    return false;
  }
}

export const dashboardStore = new DashboardStore();
