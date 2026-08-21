const ApiClient = {
  getToken() {
    return localStorage.getItem('ct_token') || '';
  },

  setToken(token) {
    if (token) {
      localStorage.setItem('ct_token', token);
    } else {
      localStorage.removeItem('ct_token');
    }
  },

  async request(endpoint, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const config = {
      method: options.method || 'GET',
      headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    };

    try {
      const response = await fetch(endpoint, config);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `HTTP error ${response.status}`);
      }
      return data;
    } catch (err) {
      console.error(`API Request Error [${endpoint}]:`, err);
      throw err;
    }
  },

  // Auth Methods
  async login(username, password) {
    const data = await this.request('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    if (data.token) {
      this.setToken(data.token);
    }
    return data;
  },

  async getSession() {
    return this.request('/api/auth/session');
  },

  async logout() {
    try {
      await this.request('/api/auth/session', { method: 'DELETE' });
    } catch {
      // Ignore errors on logout
    }
    this.setToken(null);
  },

  async getApiKeys() {
    return this.request('/api/auth/apikeys');
  },

  async createApiKey(name) {
    return this.request('/api/auth/apikeys', {
      method: 'POST',
      body: { name },
    });
  },

  async deleteApiKey(id) {
    return this.request(`/api/auth/apikeys/${id}`, {
      method: 'DELETE',
    });
  },

  // Dashboard Methods
  async getOverview() {
    return this.request('/api/dashboard/overview');
  },

  async getReviewLogs() {
    return this.request('/api/dashboard/logs');
  },

  async getRepositories() {
    return this.request('/api/dashboard/repositories');
  },

  async updateRepository(owner, repo, patch) {
    return this.request(`/api/dashboard/repositories/${owner}/${repo}`, {
      method: 'PATCH',
      body: patch,
    });
  },

  async getSettings() {
    return this.request('/api/dashboard/settings');
  },

  async updateSettings(settingsPatch) {
    return this.request('/api/dashboard/settings', {
      method: 'PUT',
      body: settingsPatch,
    });
  },

  async updatePersonaSetting(personaId, patch) {
    return this.request(`/api/dashboard/settings/personas/${personaId}`, {
      method: 'PATCH',
      body: patch,
    });
  },

  // Router Pool & Memory Methods
  async getProviders() {
    return this.request('/api/router/providers');
  },

  async queryMemory(repo, queryParams = {}) {
    return this.request('/api/memory/query', {
      method: 'POST',
      body: { repo, ...queryParams },
    });
  },

  // Integrations & MCP Fleet Methods
  async getIntegrations() {
    return this.request('/api/dashboard/integrations');
  },

  async updateIntegration(payload) {
    return this.request('/api/dashboard/integrations', {
      method: 'POST',
      body: payload,
    });
  },

  async getMcpServers() {
    return this.request('/api/dashboard/mcp/servers');
  },

  async addMcpServer(serverData) {
    return this.request('/api/dashboard/mcp/servers', {
      method: 'POST',
      body: serverData,
    });
  },

  async updateMcpServer(id, patch) {
    return this.request(`/api/dashboard/mcp/servers/${id}`, {
      method: 'PATCH',
      body: patch,
    });
  },

  async deleteMcpServer(id) {
    return this.request(`/api/dashboard/mcp/servers/${id}`, {
      method: 'DELETE',
    });
  },

  async testMcpServer(payload) {
    return this.request('/api/dashboard/mcp/test', {
      method: 'POST',
      body: payload,
    });
  },

  // Analytics API Methods
  async getAnalyticsSummary() {
    return this.request('/api/analytics/summary');
  },

  async getAnalyticsTokens(range = '7d', interval = 'day') {
    return this.request(`/api/analytics/tokens?range=${range}&interval=${interval}`);
  },

  async getAnalyticsCosts() {
    return this.request('/api/analytics/costs');
  },

  async getAnalyticsPersonas() {
    return this.request('/api/analytics/personas');
  },

  async getAnalyticsIndexer() {
    return this.request('/api/analytics/indexer');
  },

  // Onboarding Wizard API Methods
  async scanOnboarding(repoPath) {
    return this.request('/api/onboarding/wizard/scan', {
      method: 'POST',
      body: { repoPath },
    });
  },

  async generateOnboardingConfig(payload) {
    return this.request('/api/onboarding/wizard/generate', {
      method: 'POST',
      body: payload,
    });
  },

  // GitHub App Onboarding & Monitored Repos API Methods
  async getGitHubAppConfig() {
    return this.request('/api/github/app-config');
  },

  async updateGitHubAppConfig(data) {
    return this.request('/api/github/app-config', {
      method: 'POST',
      body: data,
    });
  },

  async deleteGitHubAppConfig() {
    return this.request('/api/github/app-config', {
      method: 'DELETE',
    });
  },

  async verifyGitHubAppInstallation(data = {}) {
    return this.request('/api/github/app-config/verify', {
      method: 'POST',
      body: data,
    });
  },

  async getMonitoredRepos() {
    return this.request('/api/github/app-config/monitored-repos');
  },

  async toggleMonitoredRepo(owner, repo, automationEnabled) {
    return this.request(`/api/github/app-config/monitored-repos/${owner}/${repo}`, {
      method: 'PATCH',
      body: { automationEnabled },
    });
  },
};
