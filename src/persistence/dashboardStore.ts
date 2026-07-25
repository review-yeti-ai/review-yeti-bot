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
  latencyMs?: number;
  costUSD?: number;
  tokens?: { prompt?: number; completion?: number; total?: number };
  status?: string;
  modelCosts?: Record<string, number>;
  personaLogs?: Array<{
    persona: string;
    displayName?: string;
    decision?: string;
    latencyMs?: number;
    confidence?: number;
    model?: string;
  }>;
}

export interface IndexerMetrics {
  astParseLatencyMsSum: number;
  astParseCount: number;
  vectorEmbedLatencyMsSum: number;
  vectorEmbedCount: number;
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
  indexerMetrics?: IndexerMetrics;
}

export class DashboardStore {
  private filePath: string;
  private data: DashboardData;
  private cache: {
    analyticsSummary?: any;
    tokenTimeSeries: Record<string, any>;
    costBreakdown?: any;
    personaAnalytics?: any;
    indexerAnalytics?: any;
    overviewStats?: any;
  } = { tokenTimeSeries: {} };

  private invalidateCache(): void {
    this.cache = { tokenTimeSeries: {} };
  }

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
      reviewCounter: 0,
      totalCostUSD: 0,
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
    this.invalidateCache();
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

  public recordReviewRun(run: any): void {
    this.data.reviewCounter = (this.data.reviewCounter || 0) + 1;
    const cost = run.costUSD ?? run.costUsd ?? 0;
    if (cost) {
      this.data.totalCostUSD = (this.data.totalCostUSD || 0) + cost;
    }
    const promptTokens = run.promptTokens ?? (run.tokens && run.tokens.prompt) ?? 0;
    if (promptTokens) {
      this.data.totalPromptTokens = (this.data.totalPromptTokens || 0) + promptTokens;
    }
    const completionTokens = run.completionTokens ?? (run.tokens && run.tokens.completion) ?? 0;
    if (completionTokens) {
      this.data.totalCompletionTokens = (this.data.totalCompletionTokens || 0) + completionTokens;
    }

    if (!this.data.reviewLogs) this.data.reviewLogs = [];
    const prRunName = run.prRun || (run.repository ? `${run.repository}#${run.prNumber || 1}` : `Run-${Date.now()}`);
    const verdict = run.arbiterVerdict || run.verdict || 'SHIP';
    const latencyMs = run.latencyMs ?? run.durationMs ?? 0;

    const logEntry: ReviewLogEntry = {
      id: run.id || `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      prRun: prRunName,
      headSha: run.headSha || 'head-sha',
      personas: typeof run.personas === 'string' ? run.personas : Array.isArray(run.personas) ? run.personas.map((p: any) => typeof p === 'string' ? p : p.id || p.persona).join(', ') : '4 Personas',
      quorum: run.quorum ? (typeof run.quorum === 'string' ? run.quorum : `${run.quorum.distinctProviders?.length || 4}/${run.quorum.required || 4}`) : '4/4',
      arbiterVerdict: verdict,
      timestamp: run.timestamp || new Date().toISOString(),
      latencyMs,
      costUSD: cost,
      tokens: run.tokens || (promptTokens || completionTokens ? { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens } : undefined),
      status: run.status || (verdict === 'SHIP' ? 'success' : 'processed'),
      modelCosts: run.modelCosts,
      personaLogs: run.personaLogs || (Array.isArray(run.personas) && typeof run.personas[0] === 'object' ? run.personas : undefined),
    };

    this.data.reviewLogs.unshift(logEntry);
    if (this.data.reviewLogs.length > 100) this.data.reviewLogs.pop();

    this.saveData(this.data);
  }

  public recordIndexerRun(astParseDurationMs: number, vectorEmbedDurationMs?: number): void {
    if (!this.data.indexerMetrics) {
      this.data.indexerMetrics = {
        astParseLatencyMsSum: 0,
        astParseCount: 0,
        vectorEmbedLatencyMsSum: 0,
        vectorEmbedCount: 0,
      };
    }
    if (astParseDurationMs > 0) {
      this.data.indexerMetrics.astParseLatencyMsSum += astParseDurationMs;
      this.data.indexerMetrics.astParseCount += 1;
    }
    if (vectorEmbedDurationMs && vectorEmbedDurationMs > 0) {
      this.data.indexerMetrics.vectorEmbedLatencyMsSum += vectorEmbedDurationMs;
      this.data.indexerMetrics.vectorEmbedCount += 1;
    }
    this.saveData(this.data);
  }

  public getAnalyticsSummary() {
    if (this.cache.analyticsSummary) return this.cache.analyticsSummary;

    const overview = this.getOverviewStats();
    const totalReviews = overview.totalReviewsExecuted;

    const logs = this.data.reviewLogs || [];
    const logsWithLatency = logs.filter((l) => typeof l.latencyMs === 'number' && l.latencyMs > 0);
    const avgLatencyMs = logsWithLatency.length > 0
      ? Math.round(logsWithLatency.reduce((acc, l) => acc + (l.latencyMs || 0), 0) / logsWithLatency.length)
      : 0;

    const successfulLogs = logs.filter((l) => l.arbiterVerdict === 'SHIP' || l.status === 'success' || l.status === 'processed');
    const successRate = logs.length > 0
      ? parseFloat(((successfulLogs.length / logs.length) * 100).toFixed(1))
      : 100;

    const summary = {
      totalReviews,
      totalSpendUsd: overview.totalCostUSD,
      totalTokens: overview.totalTokens.total,
      avgLatencyMs,
      successRate,
      activeRepositories: overview.activeAutomations,
      memoryRulesCount: overview.memoryGraph.learningsCount,
      timestamp: new Date().toISOString(),
    };

    this.cache.analyticsSummary = summary;
    return summary;
  }

  public getTokenTimeSeries(range = '7d', _interval = 'day') {
    const cacheKey = `${range}_${_interval}`;
    if (this.cache.tokenTimeSeries[cacheKey]) return this.cache.tokenTimeSeries[cacheKey];

    const days = range === '24h' ? 1 : range === '30d' ? 30 : 7;
    const now = new Date();
    const logs = this.data.reviewLogs || [];

    const tokensByDate: Record<string, { prompt: number; completion: number }> = {};
    for (const log of logs) {
      if (!log.timestamp) continue;
      const dateStr = log.timestamp.split('T')[0];
      if (!tokensByDate[dateStr]) {
        tokensByDate[dateStr] = { prompt: 0, completion: 0 };
      }
      const prompt = log.tokens?.prompt || 0;
      const completion = log.tokens?.completion || 0;
      tokensByDate[dateStr].prompt += prompt;
      tokensByDate[dateStr].completion += completion;
    }

    const points: Array<{ timestamp: string; promptTokens: number; completionTokens: number; totalTokens: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];

      const dayData = tokensByDate[dateStr];
      const promptTokens = dayData ? dayData.prompt : 0;
      const completionTokens = dayData ? dayData.completion : 0;

      points.push({
        timestamp: dateStr,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      });
    }

    this.cache.tokenTimeSeries[cacheKey] = points;
    return points;
  }

  public getCostBreakdown() {
    if (this.cache.costBreakdown) return this.cache.costBreakdown;

    const totalSpendUsd = this.data.totalCostUSD || 0;
    const monthlyBudgetUsd = this.data.settings.providerCostCaps.monthlyBudgetUSD;
    const budgetPercentUsed = monthlyBudgetUsd > 0 ? Math.min(100, (totalSpendUsd / monthlyBudgetUsd) * 100) : 0;

    const knownModels = [
      { model: 'claude-5-sonnet', displayName: 'Claude 5 Sonnet', providerId: 'claude' },
      { model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', providerId: 'codex' },
      { model: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', providerId: 'deepseek' },
      { model: 'glm-5.2', displayName: 'GLM 5.2 Arbiter', providerId: 'glm' },
    ];

    const logs = this.data.reviewLogs || [];
    const modelStats: Record<string, { spendUsd: number; promptTokens: number; completionTokens: number; callCount: number }> = {};

    for (const m of knownModels) {
      modelStats[m.model] = { spendUsd: 0, promptTokens: 0, completionTokens: 0, callCount: 0 };
    }

    let loggedSpendSum = 0;
    for (const log of logs) {
      if (log.modelCosts) {
        for (const [mod, cst] of Object.entries(log.modelCosts)) {
          if (!modelStats[mod]) {
            modelStats[mod] = { spendUsd: 0, promptTokens: 0, completionTokens: 0, callCount: 0 };
          }
          modelStats[mod].spendUsd += cst;
          modelStats[mod].callCount += 1;
          loggedSpendSum += cst;
        }
      }
    }

    const totalPrompt = this.data.totalPromptTokens || 0;
    const totalCompletion = this.data.totalCompletionTokens || 0;
    const totalCalls = this.data.reviewCounter || 0;

    const modelKeys = Object.keys(modelStats);
    const breakdown = modelKeys.map((key) => {
      const known = knownModels.find((km) => km.model === key);
      const displayName = known ? known.displayName : key;
      const providerId = known ? known.providerId : key.split('-')[0];

      const stats = modelStats[key];
      let spendUsd = parseFloat(stats.spendUsd.toFixed(4));
      if (loggedSpendSum === 0 && totalSpendUsd > 0) {
        spendUsd = parseFloat((totalSpendUsd / modelKeys.length).toFixed(4));
      }

      const percentage = totalSpendUsd > 0 ? Math.round((spendUsd / totalSpendUsd) * 100) : 0;
      const modelRatio = totalSpendUsd > 0 ? spendUsd / totalSpendUsd : (1 / modelKeys.length);
      const prompt = stats.promptTokens || Math.round(totalPrompt * modelRatio);
      const completion = stats.completionTokens || Math.round(totalCompletion * modelRatio);
      const callCount = stats.callCount || Math.round(totalCalls * modelRatio);

      return {
        model: key,
        displayName,
        providerId,
        spendUsd,
        percentage,
        tokens: {
          prompt,
          completion,
        },
        callCount,
      };
    });

    const result = {
      totalSpendUsd,
      monthlyBudgetUsd,
      budgetPercentUsed: parseFloat(budgetPercentUsed.toFixed(1)),
      breakdown,
    };

    this.cache.costBreakdown = result;
    return result;
  }

  public getPersonaAnalytics() {
    if (this.cache.personaAnalytics) return this.cache.personaAnalytics;

    const standardPersonas = [
      { persona: 'securityArbiter', displayName: 'Security & Auth Arbiter' },
      { persona: 'docsPersona', displayName: 'Documentation & API Spec' },
      { persona: 'linearSyncPersona', displayName: 'Linear Issue & Traceability' },
      { persona: 'marketingPersona', displayName: 'UX & Feature Release' },
    ];

    const logs = this.data.reviewLogs || [];

    const personaStats: Record<string, {
      totalReviews: number;
      verdicts: { SHIP: number; NACK: number; COMMENT: number };
      latencySum: number;
      latencyCount: number;
      confidenceSum: number;
      confidenceCount: number;
    }> = {};

    for (const sp of standardPersonas) {
      personaStats[sp.persona] = {
        totalReviews: 0,
        verdicts: { SHIP: 0, NACK: 0, COMMENT: 0 },
        latencySum: 0,
        latencyCount: 0,
        confidenceSum: 0,
        confidenceCount: 0,
      };
    }

    for (const log of logs) {
      const personasInLog = (log.personas || '').toLowerCase();
      const arbiterVerdict = log.arbiterVerdict || 'SHIP';

      for (const sp of standardPersonas) {
        const pKey = sp.persona;
        const stats = personaStats[pKey];

        const isIncluded = personasInLog.includes(pKey.toLowerCase()) ||
          personasInLog.includes(sp.displayName.toLowerCase()) ||
          personasInLog.includes('persona') ||
          log.personaLogs?.some((pl) => pl.persona === pKey);

        if (isIncluded) {
          stats.totalReviews += 1;
          if (arbiterVerdict === 'SHIP') stats.verdicts.SHIP += 1;
          else if (arbiterVerdict === 'NACK') stats.verdicts.NACK += 1;
          else stats.verdicts.COMMENT += 1;

          if (log.latencyMs) {
            stats.latencySum += log.latencyMs;
            stats.latencyCount += 1;
          }
        }
      }

      if (log.personaLogs) {
        for (const pl of log.personaLogs) {
          if (personaStats[pl.persona]) {
            const stats = personaStats[pl.persona];
            if (pl.decision === 'SHIP') stats.verdicts.SHIP += 1;
            else if (pl.decision === 'NACK') stats.verdicts.NACK += 1;
            else if (pl.decision === 'COMMENT') stats.verdicts.COMMENT += 1;

            if (pl.latencyMs) {
              stats.latencySum += pl.latencyMs;
              stats.latencyCount += 1;
            }
            if (pl.confidence) {
              stats.confidenceSum += pl.confidence;
              stats.confidenceCount += 1;
            }
          }
        }
      }
    }

    const result = standardPersonas.map((sp) => {
      const stats = personaStats[sp.persona];
      const totalReviews = stats.totalReviews > 0 ? stats.totalReviews : logs.length;
      const shipCount = stats.verdicts.SHIP;
      const approvalRate = totalReviews > 0 ? parseFloat((shipCount / totalReviews).toFixed(2)) : 0;

      const avgConfidence = stats.confidenceCount > 0
        ? Math.round(stats.confidenceSum / stats.confidenceCount)
        : 0;

      const avgLatencyMs = stats.latencyCount > 0
        ? Math.round(stats.latencySum / stats.latencyCount)
        : 0;

      return {
        persona: sp.persona,
        displayName: sp.displayName,
        totalReviews,
        approvalRate,
        avgConfidence,
        verdicts: stats.verdicts,
        avgLatencyMs,
      };
    });

    this.cache.personaAnalytics = result;
    return result;
  }

  public getIndexerAnalytics() {
    if (this.cache.indexerAnalytics) return this.cache.indexerAnalytics;

    const overview = this.getOverviewStats();
    const metrics = this.data.indexerMetrics;

    const astParseLatencyMs = metrics && metrics.astParseCount > 0
      ? Math.round(metrics.astParseLatencyMsSum / metrics.astParseCount)
      : 0;

    const vectorEmbedLatencyMs = metrics && metrics.vectorEmbedCount > 0
      ? Math.round(metrics.vectorEmbedLatencyMsSum / metrics.vectorEmbedCount)
      : 0;

    const result = {
      symbolNodesCount: overview.memoryGraph.symbolNodesCount,
      symbolEdgesCount: overview.memoryGraph.symbolEdgesCount,
      astParseLatencyMs,
      vectorEmbedLatencyMs,
      memoryLearningsCount: overview.memoryGraph.learningsCount,
      suppressedNitsCount: overview.memoryGraph.suppressedNitsCount,
    };

    this.cache.indexerAnalytics = result;
    return result;
  }

  public getReviewLogs(): ReviewLogEntry[] {
    return [...(this.data.reviewLogs || [])];
  }

  public getOverviewStats() {
    if (this.cache.overviewStats) return this.cache.overviewStats;

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

    const promptTokens = this.data.totalPromptTokens ?? 0;
    const completionTokens = this.data.totalCompletionTokens ?? 0;

    const overview = {
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

    this.cache.overviewStats = overview;
    return overview;
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
