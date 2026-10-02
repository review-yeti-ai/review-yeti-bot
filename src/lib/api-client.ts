import {
  PersonaSetting,
  OverviewStats,
  ReviewJob,
  RepositorySetting,
  IntegrationItem,
  McpServerConfig,
  GitHubAppConfig,
  EnforcementPolicy,
  OnboardingScanResult,
  ProviderConfigRecord,
  ModelRegistryItem,
  GitHubOrganizationSummary,
  ActivePullRequestSummary,
  RepositoryReviewRules,
} from '@/types/dashboard';
import type {
  PromptGuidanceItem,
  VerdictOverrideRecord,
  ReviewAuditEvent,
  VerdictOverrideResponse,
} from '@/types/hitl';
import type { AnchoredFinding } from '@/types/diff';
import type {
  AnalyticsTimeRange,
  AnalyticsSummaryData,
  LatencyMetricsResponse,
  CostBreakdownResponse,
  TokenBurnResponse,
  FindingsQualityResponse,
} from '@/types/analytics';

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  if (!headers.has('Authorization')) {
    const sessionToken = typeof window !== 'undefined'
      ? (localStorage.getItem('ct_session_token') || 'demo_token_public')
      : 'demo_token_public';
    headers.set('Authorization', `Bearer ${sessionToken}`);
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const contentType = res.headers.get('content-type');
  let data: any = {};
  if (contentType && contentType.includes('application/json')) {
    data = await res.json();
  } else {
    const text = await res.text();
    data = { success: res.ok, rawText: text };
  }

  if (!res.ok || (data.success === false && data.error)) {
    throw new Error(data.error || `HTTP error ${res.status}`);
  }

  return data;
}

// Personas API
export async function fetchPersonas(): Promise<Record<string, PersonaSetting>> {
  const res = await request<{ success: boolean; personas: Record<string, PersonaSetting> }>('/api/dashboard/personas');
  return res.personas || {};
}

export async function updatePersona(personaId: string, patch: Partial<PersonaSetting>): Promise<PersonaSetting> {
  const res = await request<{ success: boolean; persona: PersonaSetting }>(
    `/api/dashboard/personas/${encodeURIComponent(personaId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(patch),
    }
  );
  return res.persona;
}

// Overview & Logs API
export async function fetchOverviewStats(): Promise<OverviewStats> {
  const res = await request<{ success: boolean; overview: OverviewStats }>('/api/dashboard/overview');
  return res.overview;
}

export async function fetchReviewLogs(): Promise<ReviewJob[]> {
  const res = await request<{ success: boolean; logs: ReviewJob[] }>('/api/dashboard/logs');
  return res.logs || [];
}

// Repositories API
export async function fetchRepositories(): Promise<RepositorySetting[]> {
  const res = await request<{ success: boolean; repositories: RepositorySetting[] }>('/api/dashboard/repositories');
  return res.repositories || [];
}

export async function updateRepository(
  owner: string,
  repo: string,
  patch: Partial<RepositorySetting>
): Promise<RepositorySetting> {
  const res = await request<{ success: boolean; repository: RepositorySetting }>(
    `/api/dashboard/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }
  );
  return res.repository;
}
export async function createRepository(payload: {
  owner: string;
  repo: string;
  automationEnabled?: boolean;
  generateArchitecturalFlowchart?: boolean;
  customProfile?: 'chill' | 'balanced' | 'assertive';
}): Promise<RepositorySetting> {
  const res = await request<{ success: boolean; repository: RepositorySetting }>('/api/dashboard/repositories', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return res.repository;
}

// GitHub Discovery API
export async function fetchGitHubOrgs(): Promise<GitHubOrganizationSummary[]> {
  const res = await request<{ success: boolean; organizations: GitHubOrganizationSummary[] }>('/api/github/orgs');
  return res.organizations || [];
}

export async function fetchGitHubRepos(
  org?: string,
  monitored?: boolean
): Promise<{ repositories: RepositorySetting[]; totalCount: number; activeCount: number }> {
  const params = new URLSearchParams();
  if (org) params.set('org', org);
  if (monitored !== undefined) params.set('monitored', String(monitored));
  const res = await request<{ success: boolean; repositories: RepositorySetting[]; totalCount: number; activeCount: number }>(
    `/api/github/repos?${params.toString()}`
  );
  return {
    repositories: res.repositories || [],
    totalCount: res.totalCount || 0,
    activeCount: res.activeCount || 0,
  };
}

export async function fetchRepoPullRequests(
  owner: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'open'
): Promise<ActivePullRequestSummary[]> {
  const res = await request<{ success: boolean; pullRequests: ActivePullRequestSummary[] }>(
    `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}`
  );
  return res.pullRequests || [];
}

export const fetchRepositoryPullRequests = fetchRepoPullRequests;

export async function triggerPullRequestReview(
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ success: boolean; message: string; jobId?: string }> {
  return request<{ success: boolean; message: string; jobId?: string }>(
    `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/review`,
    {
      method: 'POST',
    }
  );
}

export async function fetchRepositoryReviewRules(
  owner: string,
  repo: string
): Promise<RepositoryReviewRules> {
  const res = await request<{
    success: boolean;
    owner: string;
    repo: string;
    rules: RepositoryReviewRules;
  }>(`/api/dashboard/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/rules`);
  return res.rules;
}

export async function updateRepositoryReviewRules(
  owner: string,
  repo: string,
  rules: Partial<RepositoryReviewRules>
): Promise<RepositoryReviewRules> {
  const res = await request<{
    success: boolean;
    owner: string;
    repo: string;
    rules: RepositoryReviewRules;
  }>(`/api/dashboard/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/rules`, {
    method: 'PUT',
    body: JSON.stringify(rules),
  });
  return res.rules;
}
// Integrations API
export async function fetchIntegrations(): Promise<IntegrationItem[]> {
  const res = await request<{ success: boolean; integrations: IntegrationItem[] }>('/api/dashboard/integrations');
  return res.integrations || [];
}

export async function updateIntegration(platform: string, payload: any): Promise<IntegrationItem> {
  const res = await request<{ success: boolean; integration: IntegrationItem }>('/api/dashboard/integrations', {
    method: 'PUT',
    body: JSON.stringify({ platform, ...payload }),
  });
  return res.integration;
}

export async function testIntegration(platform: string, credentials: Record<string, any>): Promise<{
  success: boolean;
  status: string;
  latencyMs: number;
  message: string;
}> {
  return request(`/api/dashboard/integrations/${encodeURIComponent(platform)}/test`, {
    method: 'POST',
    body: JSON.stringify(credentials),
  });
}

// Config & AST Memory Graph API
export async function updateDashboardConfig(payload: {
  monthlyCostCapUSD?: number;
  monthlyBudgetUSD?: number;
  providerCostCaps?: any;
  autoReviewSettings?: any;
  enforcementPolicy?: any;
}): Promise<{ success: boolean; config: any; overview: OverviewStats }> {
  return request('/api/dashboard/config', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function fetchSymbolGraph(symbolName: string): Promise<any> {
  return request('/api/code/symbol-graph', {
    method: 'POST',
    body: JSON.stringify({ symbolName, includeCallers: true, includeCallees: true, includeReferences: true }),
  });
}

export async function fetchMemoryGraph(symbolName?: string): Promise<any> {
  const queryParam = symbolName ? `?symbolName=${encodeURIComponent(symbolName)}` : '';
  return request(`/api/memory/graph${queryParam}`);
}

export async function searchCodeSymbols(query: string, limit = 10): Promise<any> {
  return request('/api/code/search', {
    method: 'POST',
    body: JSON.stringify({ query, limit }),
  });
}

export async function searchMemoryCode(query = 'security', limit = 10): Promise<any> {
  return request(`/api/memory/search?q=${encodeURIComponent(query)}&limit=${limit}`);
}

export async function fetchMemoryLearnings(repo?: string): Promise<any> {
  const queryParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
  return request(`/api/memory/learnings${queryParam}`);
}

// MCP Fleet API
export async function fetchMcpServers(): Promise<McpServerConfig[]> {
  const res = await request<{ success: boolean; servers: McpServerConfig[] }>('/api/dashboard/mcp/servers');
  return res.servers || [];
}

export async function addMcpServer(server: Partial<McpServerConfig>): Promise<McpServerConfig> {
  const res = await request<{ success: boolean; server: McpServerConfig }>('/api/dashboard/mcp/servers', {
    method: 'POST',
    body: JSON.stringify(server),
  });
  return res.server;
}

export async function updateMcpServer(id: string, patch: Partial<McpServerConfig>): Promise<McpServerConfig> {
  const res = await request<{ success: boolean; server: McpServerConfig }>(`/api/dashboard/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return res.server;
}

export async function deleteMcpServer(id: string): Promise<boolean> {
  const res = await request<{ success: boolean }>(`/api/dashboard/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return res.success;
}

export async function testMcpServer(payload: { url?: string; command?: string; args?: string[] }): Promise<{
  success: boolean;
  status: string;
  latencyMs: number;
  toolsCount: number;
  error?: string;
}> {
  return request('/api/dashboard/mcp/test', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// GitHub App API
export async function fetchGitHubAppConfig(): Promise<GitHubAppConfig> {
  const res = await request<{ success: boolean; config: GitHubAppConfig }>('/api/github/app-config');
  return res.config;
}

export async function updateGitHubAppConfig(config: Partial<GitHubAppConfig>): Promise<GitHubAppConfig> {
  const res = await request<{ success: boolean; config: GitHubAppConfig }>('/api/github/app-config', {
    method: 'POST',
    body: JSON.stringify(config),
  });
  return res.config;
}

export async function verifyGitHubApp(credentials: any): Promise<{ success: boolean; verified: boolean; error?: string }> {
  return request('/api/github/app-config/verify', {
    method: 'POST',
    body: JSON.stringify(credentials),
  });
}

export async function fetchEnforcementPolicy(): Promise<EnforcementPolicy> {
  const res = await request<{ success: boolean; policy: EnforcementPolicy }>('/api/github/enforcement-policy');
  return res.policy;
}

export async function updateEnforcementPolicy(policy: Partial<EnforcementPolicy>): Promise<EnforcementPolicy> {
  const res = await request<{ success: boolean; policy: EnforcementPolicy }>('/api/github/enforcement-policy', {
    method: 'POST',
    body: JSON.stringify(policy),
  });
  return res.policy;
}

// Onboarding Scan API
export async function runOnboardingScan(repoPath: string): Promise<OnboardingScanResult> {
  const res = await request<{ success: boolean; scanResult?: OnboardingScanResult; result?: OnboardingScanResult }>('/api/onboarding/wizard', {
    method: 'POST',
    body: JSON.stringify({ repoPath }),
  });
  return res.scanResult || res.result!;
}

// AI Providers API
export interface ProvidersApiResponse {
  success: boolean;
  providers: Record<string, ProviderConfigRecord>;
  models: string[];
  modelRegistry: Record<string, ModelRegistryItem>;
}

export async function fetchProviders(): Promise<ProvidersApiResponse> {
  return request<ProvidersApiResponse>('/api/dashboard/providers');
}

export async function updateProvider(id: string, patch: Partial<ProviderConfigRecord>): Promise<ProviderConfigRecord> {
  const res = await request<{ success: boolean; provider: ProviderConfigRecord }>(
    `/api/dashboard/providers/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      body: JSON.stringify(patch),
    }
  );
  return res.provider;
}

export async function testProvider(id: string, payload?: any): Promise<{
  success: boolean;
  status: string;
  latencyMs: number;
  message: string;
}> {
  return request(`/api/dashboard/providers/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    body: payload ? JSON.stringify(payload) : undefined,
  });
}

export async function runDiagnosticScan(payload?: {
  appId?: string;
  providerIds?: string[];
  repoId?: string;
}): Promise<any> {
  return request('/api/onboarding/diagnostic', {
    method: 'POST',
    body: payload ? JSON.stringify(payload) : undefined,
  });
}

export async function remapPersonasAndDisableProvider(
  remappedPersonas: Record<string, string>,
  providerId: string,
  providerPatch: Partial<ProviderConfigRecord> = { enabled: false }
): Promise<{ personas: PersonaSetting[]; provider: ProviderConfigRecord }> {
  const updatedPersonas: PersonaSetting[] = [];
  for (const [personaId, newModel] of Object.entries(remappedPersonas)) {
    const updated = await updatePersona(personaId, { model: newModel });
    updatedPersonas.push(updated);
  }
  const provider = await updateProvider(providerId, providerPatch);
  return { personas: updatedPersonas, provider };
}

// =========================================================================
// Human-in-the-Loop (HITL) Controls API (M3)
// =========================================================================

// Finding Dismissal
export async function dismissFinding(
  reviewId: string,
  findingId: string,
  reason: string,
  dismissedBy = 'reviewer'
): Promise<{ success: boolean; reviewId: string; findingId: string; status: 'dismissed'; remainingActiveCount: number }> {
  return request(`/api/reviews/${encodeURIComponent(reviewId)}/findings/${encodeURIComponent(findingId)}/dismiss`, {
    method: 'POST',
    body: JSON.stringify({ reason, dismissedBy }),
  });
}

// Severity Adjustment
export async function adjustFindingSeverity(
  reviewId: string,
  findingId: string,
  severity: 'P0' | 'P1' | 'P2',
  updatedBy = 'reviewer'
): Promise<{ success: boolean; reviewId: string; findingId: string; severity: 'P0' | 'P1' | 'P2'; previousSeverity: string }> {
  return request(`/api/reviews/${encodeURIComponent(reviewId)}/findings/${encodeURIComponent(findingId)}/severity`, {
    method: 'PATCH',
    body: JSON.stringify({ severity, updatedBy }),
  });
}

// Review Prompt Guidance
export async function submitPromptGuidance(
  reviewId: string,
  guidanceText: string,
  targetPersonas?: string[],
  createdBy = 'reviewer'
): Promise<{ success: boolean; guidance: PromptGuidanceItem }> {
  return request(`/api/reviews/${encodeURIComponent(reviewId)}/guidance`, {
    method: 'POST',
    body: JSON.stringify({ guidanceText, targetPersonas, createdBy }),
  });
}

export async function fetchPromptGuidance(
  reviewId: string
): Promise<PromptGuidanceItem[]> {
  const res = await request<{ success: boolean; guidance: PromptGuidanceItem[] }>(
    `/api/reviews/${encodeURIComponent(reviewId)}/guidance`
  );
  return res.guidance || [];
}

// Manual Verdict Override
export async function submitVerdictOverride(
  reviewId: string,
  overrideVerdict: 'SHIP' | 'BLOCK',
  reason: string,
  overriddenBy = 'reviewer'
): Promise<VerdictOverrideResponse> {
  return request(`/api/reviews/${encodeURIComponent(reviewId)}/override`, {
    method: 'POST',
    body: JSON.stringify({ overrideVerdict, reason, overriddenBy }),
  });
}

// Review Audit Trail
export async function fetchAuditTrail(
  reviewId: string
): Promise<ReviewAuditEvent[]> {
  const res = await request<{ success: boolean; events: ReviewAuditEvent[] }>(
    `/api/reviews/${encodeURIComponent(reviewId)}/audit-trail`
  );
  return res.events || [];
}

// Review Findings
export async function fetchReviewFindings(
  reviewId: string
): Promise<AnchoredFinding[]> {
  const res = await request<{ success: boolean; findings: AnchoredFinding[] }>(
    `/api/reviews/${encodeURIComponent(reviewId)}/findings`
  );
  return res.findings || [];
}

// ============================================================================
// Analytics Dashboard Endpoints (M4 / R3)
// ============================================================================

export async function fetchAnalyticsSummary(params?: {
  range?: AnalyticsTimeRange;
  window?: AnalyticsTimeRange;
  repo?: string;
}): Promise<AnalyticsSummaryData> {
  const query = new URLSearchParams();
  const rangeVal = params?.range || params?.window;
  if (rangeVal) query.set('range', rangeVal);
  if (params?.repo) query.set('repo', params.repo);
  const qStr = query.toString() ? `?${query.toString()}` : '';
  const res = await request<{ success: boolean; summary: AnalyticsSummaryData }>(
    `/api/analytics/summary${qStr}`
  );
  return res.summary;
}

export async function fetchLatencyMetrics(params?: {
  range?: AnalyticsTimeRange;
  window?: AnalyticsTimeRange;
  repo?: string;
}): Promise<LatencyMetricsResponse> {
  const query = new URLSearchParams();
  const rangeVal = params?.range || params?.window;
  if (rangeVal) query.set('range', rangeVal);
  if (params?.repo) query.set('repo', params.repo);
  const qStr = query.toString() ? `?${query.toString()}` : '';
  return request<LatencyMetricsResponse>(`/api/analytics/latency${qStr}`);
}

export async function fetchCostBreakdown(params?: {
  range?: AnalyticsTimeRange;
  window?: AnalyticsTimeRange;
  repo?: string;
}): Promise<CostBreakdownResponse> {
  const query = new URLSearchParams();
  const rangeVal = params?.range || params?.window;
  if (rangeVal) query.set('range', rangeVal);
  if (params?.repo) query.set('repo', params.repo);
  const qStr = query.toString() ? `?${query.toString()}` : '';
  return request<CostBreakdownResponse>(`/api/analytics/costs${qStr}`);
}

export async function fetchTokenBurn(params?: {
  range?: AnalyticsTimeRange;
  window?: AnalyticsTimeRange;
  repo?: string;
  interval?: string;
}): Promise<TokenBurnResponse> {
  const query = new URLSearchParams();
  const rangeVal = params?.range || params?.window;
  if (rangeVal) query.set('range', rangeVal);
  if (params?.repo) query.set('repo', params.repo);
  if (params?.interval) query.set('interval', params.interval);
  const qStr = query.toString() ? `?${query.toString()}` : '';
  return request<TokenBurnResponse>(`/api/analytics/tokens${qStr}`);
}

export async function fetchFindingsQuality(params?: {
  range?: AnalyticsTimeRange;
  window?: AnalyticsTimeRange;
  repo?: string;
}): Promise<FindingsQualityResponse> {
  const query = new URLSearchParams();
  const rangeVal = params?.range || params?.window;
  if (rangeVal) query.set('range', rangeVal);
  if (params?.repo) query.set('repo', params.repo);
  const qStr = query.toString() ? `?${query.toString()}` : '';
  return request<FindingsQualityResponse>(`/api/analytics/findings${qStr}`);
}



