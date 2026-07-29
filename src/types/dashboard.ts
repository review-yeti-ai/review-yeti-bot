export interface ProviderConfigRecord {
  id: string;
  displayName: string;
  enabled: boolean;
  active?: boolean;
  apiKeyMasked?: string;
  apiKeyRaw?: string;
  baseUrl?: string;
  subscriptionTier?: 'free' | 'pro' | 'team' | 'enterprise' | 'pay-as-you-go';
  activeModels: string[];
  customModels?: string[];
  updatedAt: string;
}

export interface ModelRegistryItem {
  id: string;
  providerId: string;
  displayName: string;
  enabled: boolean;
  contextWindowTokens?: number;
  costPer1kPromptUSD?: number;
  costPer1kCompletionUSD?: number;
  isCustom?: boolean;
}

export interface PersonaSetting {
  id: string;
  displayName: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  confidenceThreshold: number;
  enabled: boolean;
  required?: boolean;
  charter?: string;
  customPrompt?: string;
  paths?: string[];
  providers?: string[];
  systemPrompt?: string;
}

export interface OverviewStats {
  totalRepositories: number;
  activeAutomations: number;
  totalReviewsExecuted: number;
  todaysReviewsExecuted?: number;
  todaysReviewsCount?: number;
  todayDateBadge?: string;
  totalCostUSD: number;
  monthlyCostCapUSD: number;
  costCapBreached: boolean;
  totalTokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  providerHealth: Array<{
    id: string;
    status: 'healthy' | 'degraded' | 'offline';
    model: string;
  }>;
  memoryGraph: {
    symbolNodesCount: number;
    symbolEdgesCount: number;
    learningsCount: number;
    suppressedNitsCount: number;
    adrConstraintsCount: number;
  };
}

export interface AnalyticsSummary {
  totalReviews: number;
  totalSpendUsd: number;
  totalTokens: number;
  avgLatencyMs: number;
  successRate: number;
  activeRepositories: number;
  memoryRulesCount: number;
  timestamp: string;
}

export interface CodeNit {
  filePath: string;
  lineNumber: number;
  severity: 'P0' | 'P1' | 'P2';
  title: string;
  description?: string;
  suggestion?: string;
}

export interface PersonaLogEntry {
  persona: string;
  displayName?: string;
  decision: 'SHIP' | 'NACK' | 'COMMENT';
  confidence?: number;
  latencyMs?: number;
  model?: string;
  findingsCount?: number;
  summary?: string;
  reasoningChain?: string[];
  outputLog?: string;
  nits?: CodeNit[];
}

export interface ReviewJob {
  id: string;
  repo: string;
  prNumber: number;
  title: string;
  status: 'completed' | 'running' | 'failed' | 'pending';
  personas: string[];
  verdict: 'SHIP' | 'NACK' | 'COMMENT';
  tokens: number;
  tokenDetails?: {
    prompt: number;
    completion: number;
    total: number;
  };
  cost: number;
  latencyMs: number;
  timestamp: string;
  headSha?: string;
  quorum?: string;
  personaLogs?: PersonaLogEntry[];
  mermaidDiagram?: string;
}

export interface RepositorySetting {
  owner: string;
  repo: string;
  automationEnabled: boolean;
  generateArchitecturalFlowchart?: boolean;
  customProfile?: 'chill' | 'balanced' | 'assertive';
  modelOverrides?: Record<string, string>;
  updatedAt: string;
}

export interface IntegrationItem {
  id: 'linear' | 'github' | 'context7' | 'productlane' | 'posthog' | 'doppler' | 'sentry' | 'jira' | 'slack' | string;
  name: string;
  status: 'connected' | 'disconnected' | 'degraded' | 'error' | 'verifying' | 'configuring';
  apiKeyMasked?: string;
  oauthClientId?: string;
  oauthClientSecretMasked?: string;
  webhookUrl?: string;
  lastSyncAt?: string;
  settings?: Record<string, any>;
  updatedAt: string;
}

export interface McpServerConfig {
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

export interface GitHubAppConfig {
  appId: string;
  installationId?: string;
  webhookSecretConfigured: boolean;
  webhookSecretRaw?: string;
  privateKeyConfigured: boolean;
  privateKeyPemRaw?: string;
  oauthClientId?: string;
  oauthClientSecretMasked?: string;
  oauthClientSecretRaw?: string;
  status: 'configured' | 'unconfigured' | 'error';
  updatedAt: string;
  monitoredReposCount?: number;
}

export interface EnforcementPolicy {
  require_all_reviews: boolean;
  failure_action: 'fail_closed' | 'fail_open' | 'quarantine';
  require_ticket_link: boolean;
  updatedAt?: string;
}

export interface OnboardingScanResult {
  repoPath: string;
  detectedStack: string[];
  suggestedPersonas: string[];
  estimatedLatencyMs: number;
  generatedYaml: string;
}
