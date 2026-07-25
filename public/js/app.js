document.addEventListener('DOMContentLoaded', () => {
  // App State
  let repositories = [];
  let settings = {};

  // UI Element References
  const authModal = document.getElementById('auth-modal');
  const loginForm = document.getElementById('login-form');
  const logoutBtn = document.getElementById('logout-btn');
  const sessionBadge = document.getElementById('session-badge');
  const pageTitle = document.getElementById('current-view-title');
  const navItems = document.querySelectorAll('.nav-item');
  const viewPanels = document.querySelectorAll('.view-panel');

  // Helper: Show Toast
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    if (type === 'error') {
      toast.style.borderColor = 'var(--color-danger)';
      toast.style.color = 'var(--color-danger)';
    } else if (type === 'success') {
      toast.style.borderColor = 'var(--color-success)';
      toast.style.color = 'var(--color-success)';
    }
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3000);
  }

  // Auth Initialization
  async function checkAuth() {
    try {
      const res = await ApiClient.getSession();
      if (res && res.authenticated) {
        authModal.classList.remove('active');
        sessionBadge.style.display = 'inline-flex';
        loadDashboardData();
      } else {
        showLoginModal();
      }
    } catch {
      showLoginModal();
    }
  }

  function showLoginModal() {
    authModal.classList.add('active');
    sessionBadge.style.display = 'none';
  }

  // Handle Login Form
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value.trim();

    try {
      const res = await ApiClient.login(username, password);
      if (res.success) {
        authModal.classList.remove('active');
        sessionBadge.style.display = 'inline-flex';
        showToast('Signed in successfully', 'success');
        loadDashboardData();
      }
    } catch (err) {
      showToast(err.message || 'Login failed', 'error');
    }
  });

  // Handle Logout
  logoutBtn.addEventListener('click', async () => {
    await ApiClient.logout();
    showLoginModal();
    showToast('Signed out');
  });

  // Mobile Navigation Drawer Controls
  const mobileToggle = document.getElementById('mobile-toggle');
  const sidebar = document.querySelector('.sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');

  if (mobileToggle && sidebar) {
    mobileToggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      if (sidebarBackdrop) sidebarBackdrop.classList.toggle('active');
    });
  }

  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener('click', () => {
      sidebar?.classList.remove('open');
      sidebarBackdrop.classList.remove('active');
    });
  }

  // Tab Navigation
  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      const targetView = item.getAttribute('data-view');

      navItems.forEach((n) => n.classList.remove('active'));
      viewPanels.forEach((p) => p.classList.remove('active'));

      item.classList.add('active');
      const targetPanel = document.getElementById(`view-${targetView}`);
      if (targetPanel) {
        targetPanel.classList.add('active');
      }

      pageTitle.textContent = item.textContent.trim().replace(/^.+?\s/, '');

      if (window.innerWidth <= 768) {
        sidebar?.classList.remove('open');
        sidebarBackdrop?.classList.remove('active');
      }

      if (targetView === 'repositories') renderRepositoriesView();
      if (targetView === 'apikeys') renderApiKeysView();
      if (targetView === 'dials') renderDialsView();
      if (targetView === 'integrations') renderIntegrationsView();
    });
  });

  // Load All Dashboard Data
  async function loadDashboardData() {
    try {
      const [overviewData, repoData, settingsData, providersData, logsData] = await Promise.all([
        ApiClient.getOverview().catch(() => null),
        ApiClient.getRepositories().catch(() => null),
        ApiClient.getSettings().catch(() => null),
        ApiClient.getProviders().catch(() => null),
        ApiClient.getReviewLogs().catch(() => null),
      ]);

      if (overviewData && overviewData.overview) {
        renderOverview(
          overviewData.overview,
          providersData ? providersData.providers : null,
          logsData ? logsData.logs : null
        );
      }

      if (repoData && repoData.repositories) {
        repositories = repoData.repositories;
        renderRepositoriesView();
      }

      if (settingsData && settingsData.settings) {
        settings = settingsData.settings;
        renderDialsView();
      }
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    }
  }

  // Render Overview KPIs
  function renderOverview(overview, liveProviders, reviewLogs) {
    document.getElementById('kpi-total-repos').textContent = overview.totalRepositories;
    document.getElementById('kpi-active-repos').textContent = `${overview.activeAutomations} active automations`;
    document.getElementById('kpi-total-reviews').textContent = overview.totalReviewsExecuted;
    document.getElementById('kpi-total-cost').textContent = `$${(overview.totalCostUSD || 0).toFixed(2)}`;
    const spendTotalEl = document.getElementById('spend-total-cost');
    if (spendTotalEl) spendTotalEl.textContent = `$${(overview.totalCostUSD || 0).toFixed(2)}`;
    document.getElementById('kpi-cost-budget').textContent = `Budget Cap: $${(overview.monthlyCostCapUSD || 100).toFixed(2)}`;
    
    // Memory Engine KPI binding
    if (overview.memoryGraph) {
      document.getElementById('kpi-memory-rules').textContent = overview.memoryGraph.learningsCount;
      const lEl = document.getElementById('memory-kpi-learnings');
      if (lEl) lEl.textContent = overview.memoryGraph.learningsCount;
      const nEl = document.getElementById('memory-kpi-nits');
      if (nEl) nEl.textContent = overview.memoryGraph.suppressedNitsCount;
      const aEl = document.getElementById('memory-kpi-adrs');
      if (aEl) aEl.textContent = overview.memoryGraph.adrConstraintsCount;
      const sEl = document.getElementById('memory-kpi-symbols');
      if (sEl) sEl.textContent = overview.memoryGraph.symbolNodesCount || overview.memoryGraph.nodes || 0;
    }

    // Token Spend KPI binding
    if (overview.totalTokens) {
      const promptEl = document.getElementById('spend-prompt-tokens');
      if (promptEl) promptEl.textContent = `${((overview.totalTokens.prompt || 0) / 1_000_000).toFixed(2)} M`;
      const compEl = document.getElementById('spend-completion-tokens');
      if (compEl) compEl.textContent = `${((overview.totalTokens.completion || 0) / 1_000_000).toFixed(2)} M`;
    }

    renderProviderTable(overview.providerHealth, liveProviders);
    renderReviewLogs(reviewLogs);
    renderSpendBreakdown(overview);
  }

  function renderProviderTable(providerHealth, liveProviders) {
    const tbody = document.getElementById('overview-provider-table');
    if (!tbody) return;

    let items = [];
    if (liveProviders && liveProviders.length > 0) {
      items = liveProviders.map((p) => ({
        id: p.id,
        status: 'Healthy',
        model: p.models ? p.models.join(', ') : (p.type || 'dynamic'),
      }));
    } else if (providerHealth && providerHealth.length > 0) {
      items = providerHealth.map((p) => ({
        id: p.id,
        status: p.status || 'Healthy',
        model: p.model || 'default',
      }));
    }

    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-secondary);">No providers configured</td></tr>`;
      return;
    }

    tbody.innerHTML = items.map((item) => `
      <tr>
        <td><code>${item.id}</code></td>
        <td><span class="badge badge-success">${item.status}</span></td>
        <td><code>${item.model}</code></td>
      </tr>
    `).join('');
  }

  function renderReviewLogs(logs) {
    const tbody = document.getElementById('logs-list-body');
    if (!tbody) return;

    if (!logs || logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-secondary);">No PR review logs recorded</td></tr>`;
      return;
    }

    tbody.innerHTML = logs.map((log) => `
      <tr>
        <td><strong>${log.prRun}</strong></td>
        <td><code>${(log.headSha || '').slice(0, 7)}</code></td>
        <td>${log.personas}</td>
        <td><span class="badge badge-info">${log.quorum}</span></td>
        <td><span class="badge badge-${log.arbiterVerdict === 'SHIP' || log.arbiterVerdict === 'APPROVE' ? 'success' : 'danger'}">${log.arbiterVerdict}</span></td>
      </tr>
    `).join('');
  }

  function renderSpendBreakdown(overview) {
    const container = document.getElementById('spend-breakdown-list');
    if (!container) return;

    const totalCost = overview.totalCostUSD || 0;
    const providers = overview.providerHealth || [];

    if (providers.length === 0 || totalCost === 0) {
      container.innerHTML = `<div style="text-align: center; color: var(--text-secondary); padding: 12px;">No provider spend recorded</div>`;
      return;
    }

    const perProviderCost = totalCost / providers.length;
    const percent = Math.floor(100 / providers.length);
    const colors = ['var(--accent-primary)', 'var(--accent-violet)', 'var(--color-info)', 'var(--color-success)'];

    const items = providers.map((p, idx) => ({
      name: `OmniRoute / ${p.id} (${p.model})`,
      percent: percent,
      cost: perProviderCost.toFixed(2),
      color: colors[idx % colors.length],
    }));

    container.innerHTML = items.map((item) => `
      <div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
          <span>${item.name}</span>
          <span>$${item.cost} (${item.percent}%)</span>
        </div>
        <div style="height: 8px; background: var(--bg-surface-elevated); border-radius: 4px; overflow: hidden;">
          <div style="width: ${item.percent}%; height: 100%; background: ${item.color};"></div>
        </div>
      </div>
    `).join('');
  }

  // Render Repositories View
  function renderRepositoriesView() {
    const tbody = document.getElementById('repo-list-body');
    if (!tbody) return;

    const searchTerm = (document.getElementById('repo-search')?.value || '').toLowerCase();
    const filtered = repositories.filter((r) =>
      `${r.owner}/${r.repo}`.toLowerCase().includes(searchTerm)
    );

    tbody.innerHTML = filtered.map((r) => `
      <tr>
        <td><strong>${r.owner}/${r.repo}</strong></td>
        <td>
          <div class="toggle-switch ${r.automationEnabled ? 'active' : ''}" data-owner="${r.owner}" data-repo="${r.repo}">
            <div class="toggle-knob"></div>
          </div>
        </td>
        <td><span class="badge badge-info">${r.customProfile || 'balanced'}</span></td>
        <td>${new Date(r.updatedAt || Date.now()).toLocaleDateString()}</td>
      </tr>
    `).join('');

    // Attach Toggle Click Listeners
    tbody.querySelectorAll('.toggle-switch').forEach((sw) => {
      sw.addEventListener('click', async () => {
        const owner = sw.getAttribute('data-owner');
        const repo = sw.getAttribute('data-repo');
        const currentState = sw.classList.contains('active');
        const newState = !currentState;

        sw.classList.toggle('active');
        try {
          await ApiClient.updateRepository(owner, repo, { automationEnabled: newState });
          showToast(`Automation ${newState ? 'enabled' : 'disabled'} for ${owner}/${repo}`, 'success');
          const item = repositories.find((r) => r.owner === owner && r.repo === repo);
          if (item) item.automationEnabled = newState;
        } catch {
          sw.classList.toggle('active');
          showToast('Failed to update repository settings', 'error');
        }
      });
    });
  }

  document.getElementById('repo-search')?.addEventListener('input', renderRepositoriesView);

  // Render Dials View
  function renderDialsView() {
    const confidenceSlider = document.getElementById('confidence-slider');
    const confidenceVal = document.getElementById('confidence-val');
    if (confidenceSlider && confidenceVal) {
      confidenceSlider.addEventListener('input', (e) => {
        confidenceVal.textContent = e.target.value;
      });
    }

    const toggles = ['toggle-memory-engine', 'toggle-mascot', 'toggle-ticket-enforcement'];
    toggles.forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.onclick = () => el.classList.toggle('active');
      }
    });
  }

  document.getElementById('dials-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const memoryEngine = document.getElementById('toggle-memory-engine').classList.contains('active');
    const mascot = document.getElementById('toggle-mascot').classList.contains('active');
    const ticketEnforcement = document.getElementById('toggle-ticket-enforcement').classList.contains('active');
    const confidence = parseInt(document.getElementById('confidence-slider').value, 10);
    const model = document.getElementById('persona-model-select').value;

    try {
      await ApiClient.updateSettings({
        memoryEngineSettings: { autoSuppressNits: memoryEngine },
        defaultModelOverrides: { codex: model },
      });
      showToast('Dial settings saved successfully', 'success');
    } catch {
      showToast('Failed to save dial settings', 'error');
    }
  });

  // Memory Sandbox Query
  document.getElementById('memory-query-btn')?.addEventListener('click', async () => {
    const query = document.getElementById('memory-query-input').value.trim();
    const output = document.getElementById('memory-query-output');
    if (!query) return;

    output.textContent = `// Querying vector memory for "${query}"...\n`;

    try {
      const res = await ApiClient.queryMemory('calltelemetry/cisco-cdr', { query });
      output.textContent = JSON.stringify(res, null, 2);
    } catch (err) {
      output.textContent = JSON.stringify({ success: false, error: err.message || 'Query failed' }, null, 2);
    }
  });

  // Render API Keys View
  async function renderApiKeysView() {
    const tbody = document.getElementById('apikeys-table-body');
    if (!tbody) return;

    try {
      const res = await ApiClient.getApiKeys();
      if (res && res.apiKeys) {
        tbody.innerHTML = res.apiKeys.map((k) => `
          <tr>
            <td><strong>${k.name}</strong></td>
            <td><code>${k.maskedKey}</code></td>
            <td>${new Date(k.createdAt).toLocaleDateString()}</td>
            <td>
              <button class="btn-danger revoke-key-btn" data-id="${k.id}" style="padding: 4px 10px; font-size: 12px;">Revoke</button>
            </td>
          </tr>
        `).join('');

        tbody.querySelectorAll('.revoke-key-btn').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            try {
              await ApiClient.deleteApiKey(id);
              showToast('API Key revoked', 'success');
              renderApiKeysView();
            } catch {
              showToast('Failed to revoke API key', 'error');
            }
          });
        });
      }
    } catch (err) {
      console.error('Failed to load API keys:', err);
    }
  }

  // API Key Modal Controls
  const apiKeyModal = document.getElementById('apikey-modal');
  const createKeyBtn = document.getElementById('create-key-btn');
  const closeApiKeyModal = document.getElementById('close-apikey-modal');
  const apiKeyForm = document.getElementById('apikey-form');
  const keyRevealBox = document.getElementById('key-reveal-box');
  const rawKeyText = document.getElementById('raw-key-text');

  createKeyBtn?.addEventListener('click', () => {
    apiKeyModal.classList.add('active');
    keyRevealBox.style.display = 'none';
    document.getElementById('save-apikey-btn').style.display = 'inline-flex';
  });

  closeApiKeyModal?.addEventListener('click', () => {
    apiKeyModal.classList.remove('active');
  });

  apiKeyForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('key-name-input').value.trim();
    if (!name) return;

    try {
      const res = await ApiClient.createApiKey(name);
      if (res && res.apiKey) {
        rawKeyText.textContent = res.apiKey.rawKey;
        keyRevealBox.style.display = 'block';
        document.getElementById('save-apikey-btn').style.display = 'none';
        showToast('API Key generated', 'success');
        renderApiKeysView();
      }
    } catch {
      showToast('Failed to create API key', 'error');
    }
  });

  // Integrations & MCP Fleet View Renderers
  async function renderIntegrationsView() {
    try {
      const [intData, mcpData] = await Promise.all([
        ApiClient.getIntegrations().catch(() => null),
        ApiClient.getMcpServers().catch(() => null),
      ]);

      if (intData && intData.integrations) {
        renderIntegrationCards(intData.integrations);
      }
      if (mcpData && mcpData.servers) {
        renderMcpServersTable(mcpData.servers);
      }
    } catch (err) {
      showToast('Failed to load integrations data', 'error');
    }
  }

  function renderIntegrationCards(integrations) {
    const container = document.getElementById('integrations-cards-grid');
    if (!container) return;

    container.innerHTML = integrations.map((item) => `
      <div class="integration-card glass-panel">
        <div class="integration-card-header">
          <div class="integration-card-title">
            <span>${getPlatformIcon(item.id)}</span>
            <span>${item.name}</span>
          </div>
          <span class="badge badge-${item.status === 'connected' ? 'success' : 'danger'}">${item.status}</span>
        </div>
        <div class="integration-card-body">
          <div>Key: <code>${item.apiKeyMasked || 'Not configured'}</code></div>
          <div class="kpi-subtext" style="margin-top: 4px;">Last sync: ${item.lastSyncAt ? new Date(item.lastSyncAt).toLocaleString() : 'Never'}</div>
        </div>
        <div class="integration-card-footer">
          <button class="btn-secondary configure-integration-btn" data-id="${item.id}" data-name="${item.name}" style="padding: 4px 12px; font-size: 12px;">Configure</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.configure-integration-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const platformId = btn.getAttribute('data-id');
        const platformName = btn.getAttribute('data-name');
        openIntegrationModal(platformId, platformName);
      });
    });
  }

  function getPlatformIcon(id) {
    const icons = {
      linear: '📐',
      github: '🐙',
      context7: '📚',
      productlane: '🚀',
      posthog: '🦔',
    };
    return icons[id] || '🔌';
  }

  function renderMcpServersTable(servers) {
    const tbody = document.getElementById('mcp-servers-table-body');
    if (!tbody) return;

    if (!servers || servers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-secondary);">No MCP servers configured</td></tr>`;
      return;
    }

    tbody.innerHTML = servers.map((s) => `
      <tr>
        <td><strong>${s.name}</strong></td>
        <td><span class="badge badge-info">${s.transport}</span></td>
        <td><code>${s.url || s.command || 'Built-in Adapter'}</code></td>
        <td><span class="badge badge-${s.status === 'online' ? 'success' : 'danger'}">${s.status}</span></td>
        <td>${s.toolsCount || 0} tools</td>
        <td style="display: flex; gap: 8px; align-items: center;">
          <button class="btn-secondary test-mcp-row-btn" data-id="${s.id}" style="padding: 4px 8px; font-size: 11px;">Test</button>
          <div class="toggle-switch ${s.enabled ? 'active' : ''} toggle-mcp-btn" data-id="${s.id}">
            <div class="toggle-knob"></div>
          </div>
          ${s.transport !== 'adapter' ? `<button class="btn-danger delete-mcp-btn" data-id="${s.id}" style="padding: 4px 8px; font-size: 11px;">Delete</button>` : ''}
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.test-mcp-row-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        try {
          const res = await ApiClient.testMcpServer({ serverId: id });
          showToast(
            res.success
              ? `Connected! Latency: ${res.latencyMs}ms (${res.toolsDiscovered.length} tools)`
              : `Test failed: ${res.error}`,
            res.success ? 'success' : 'error'
          );
          renderIntegrationsView();
        } catch {
          showToast('Failed to test MCP server', 'error');
        }
      });
    });

    tbody.querySelectorAll('.toggle-mcp-btn').forEach((toggle) => {
      toggle.addEventListener('click', async () => {
        const id = toggle.getAttribute('data-id');
        const isCurrentlyActive = toggle.classList.contains('active');
        try {
          await ApiClient.updateMcpServer(id, { enabled: !isCurrentlyActive });
          showToast(`Server ${!isCurrentlyActive ? 'enabled' : 'disabled'}`, 'success');
          renderIntegrationsView();
        } catch {
          showToast('Failed to update server toggle', 'error');
        }
      });
    });

    tbody.querySelectorAll('.delete-mcp-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        try {
          await ApiClient.deleteMcpServer(id);
          showToast('MCP server deleted', 'success');
          renderIntegrationsView();
        } catch {
          showToast('Failed to delete MCP server', 'error');
        }
      });
    });
  }

  // Modals & Controls for Integrations and MCP
  const integrationModal = document.getElementById('integration-modal');
  const integrationForm = document.getElementById('integration-form');
  const closeIntegrationModal = document.getElementById('close-integration-modal');

  function openIntegrationModal(platformId, platformName) {
    document.getElementById('integration-platform-id').value = platformId;
    document.getElementById('integration-modal-title').textContent = `Configure ${platformName || platformId}`;
    document.getElementById('integration-api-key').value = '';
    document.getElementById('integration-oauth-id').value = '';
    document.getElementById('integration-oauth-secret').value = '';
    integrationModal.classList.add('active');
  }

  closeIntegrationModal?.addEventListener('click', () => {
    integrationModal.classList.remove('active');
  });

  integrationForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const platform = document.getElementById('integration-platform-id').value;
    const apiKey = document.getElementById('integration-api-key').value.trim();
    const oauthClientId = document.getElementById('integration-oauth-id').value.trim();
    const oauthClientSecret = document.getElementById('integration-oauth-secret').value.trim();

    try {
      await ApiClient.updateIntegration({
        platform,
        apiKey: apiKey || undefined,
        oauthClientId: oauthClientId || undefined,
        oauthClientSecret: oauthClientSecret || undefined,
      });
      showToast(`${platform} integration saved`, 'success');
      integrationModal.classList.remove('active');
      renderIntegrationsView();
    } catch (err) {
      showToast(err.message || 'Failed to update integration', 'error');
    }
  });

  const mcpModal = document.getElementById('mcp-modal');
  const mcpForm = document.getElementById('mcp-form');
  const addMcpBtn = document.getElementById('add-mcp-btn');
  const closeMcpModal = document.getElementById('close-mcp-modal');
  const testMcpBtn = document.getElementById('test-mcp-btn');
  const mcpTransportSelect = document.getElementById('mcp-transport-select');
  const mcpUrlGroup = document.getElementById('mcp-url-group');
  const mcpCommandGroup = document.getElementById('mcp-command-group');

  addMcpBtn?.addEventListener('click', () => {
    mcpForm.reset();
    mcpTransportSelect.value = 'http';
    mcpUrlGroup.style.display = 'block';
    mcpCommandGroup.style.display = 'none';
    mcpModal.classList.add('active');
  });

  closeMcpModal?.addEventListener('click', () => {
    mcpModal.classList.remove('active');
  });

  mcpTransportSelect?.addEventListener('change', () => {
    const transport = mcpTransportSelect.value;
    if (transport === 'http') {
      mcpUrlGroup.style.display = 'block';
      mcpCommandGroup.style.display = 'none';
    } else {
      mcpUrlGroup.style.display = 'none';
      mcpCommandGroup.style.display = 'block';
    }
  });

  testMcpBtn?.addEventListener('click', async () => {
    const transport = mcpTransportSelect.value;
    const url = document.getElementById('mcp-url-input').value.trim();
    const command = document.getElementById('mcp-command-input').value.trim();

    try {
      const res = await ApiClient.testMcpServer({ transport, url, command });
      showToast(
        res.success
          ? `Connected! Latency: ${res.latencyMs}ms (${res.toolsDiscovered.length} tools)`
          : `Connection test failed: ${res.error}`,
        res.success ? 'success' : 'error'
      );
    } catch {
      showToast('Connection test failed', 'error');
    }
  });

  mcpForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('mcp-name-input').value.trim();
    const transport = mcpTransportSelect.value;
    const url = document.getElementById('mcp-url-input').value.trim();
    const command = document.getElementById('mcp-command-input').value.trim();

    try {
      await ApiClient.addMcpServer({
        name,
        transport,
        url: transport === 'http' ? url : undefined,
        command: transport === 'stdio' ? command : undefined,
        enabled: true,
      });
      showToast('Custom MCP server added', 'success');
      mcpModal.classList.remove('active');
      renderIntegrationsView();
    } catch (err) {
      showToast(err.message || 'Failed to add MCP server', 'error');
    }
  });

  // Start Auth Check
  checkAuth();
});
