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
} from '@/types/dashboard';

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


