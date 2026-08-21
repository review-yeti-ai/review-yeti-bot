(function () {
  'use strict';

  let currentAppConfig = null;
  let monitoredRepos = [];

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    if (type === 'error') {
      toast.style.borderColor = 'var(--color-danger)';
      toast.style.color = 'var(--color-danger)';
    } else if (type === 'success') {
      toast.style.borderColor = 'var(--color-success)';
      toast.style.color = 'var(--color-success)';
    }
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 4000);
  }

  async function loadAppConfig() {
    try {
      const data = await ApiClient.getGitHubAppConfig();
      currentAppConfig = data.appConfig || {};
      updateStatusBadges(currentAppConfig);
      populateForm(currentAppConfig);
    } catch (err) {
      console.error('Failed to load GitHub App config:', err);
      showToast(`Failed to load GitHub App config: ${err.message}`, 'error');
    }
  }

  function updateStatusBadges(cfg) {
    // App Onboarding Status
    const statusAppText = document.getElementById('status-app-text');
    if (statusAppText) {
      const isConfigured = cfg.status === 'configured' && cfg.appId;
      statusAppText.textContent = isConfigured ? `Configured (App ID: ${cfg.appId})` : 'Unconfigured';
      statusAppText.style.color = isConfigured ? 'var(--color-success)' : 'var(--color-danger)';
    }

    // PEM Key Status
    const statusPemText = document.getElementById('status-pem-text');
    if (statusPemText) {
      const hasPem = Boolean(cfg.privateKeyConfigured);
      statusPemText.textContent = hasPem ? '✓ Key Loaded (RS256)' : '✕ Missing Key';
      statusPemText.style.color = hasPem ? 'var(--color-success)' : 'var(--color-warning)';
    }

    // Webhook Secret Status
    const statusWebhookText = document.getElementById('status-webhook-text');
    if (statusWebhookText) {
      const hasWebhook = Boolean(cfg.webhookSecretConfigured);
      statusWebhookText.textContent = hasWebhook ? '✓ Configured' : '✕ Missing';
      statusWebhookText.style.color = hasWebhook ? 'var(--color-success)' : 'var(--color-warning)';
    }
  }

  function populateForm(cfg) {
    const appIdInput = document.getElementById('input-app-id');
    if (appIdInput && cfg.appId) appIdInput.value = cfg.appId;

    const instIdInput = document.getElementById('input-installation-id');
    if (instIdInput && cfg.installationId) instIdInput.value = cfg.installationId;

    const clientIdInput = document.getElementById('input-client-id');
    if (clientIdInput && cfg.oauthClientId) clientIdInput.value = cfg.oauthClientId;

    const pemKeyInput = document.getElementById('input-pem-key');
    if (pemKeyInput && cfg.privateKeyPemRaw) {
      pemKeyInput.value = cfg.privateKeyPemRaw;
    }
  }

  async function saveCredentials() {
    const appId = document.getElementById('input-app-id')?.value.trim();
    const installationId = document.getElementById('input-installation-id')?.value.trim();
    const oauthClientId = document.getElementById('input-client-id')?.value.trim();
    const oauthClientSecret = document.getElementById('input-client-secret')?.value;
    const webhookSecret = document.getElementById('input-webhook-secret')?.value;
    const privateKeyPem = document.getElementById('input-pem-key')?.value.trim();

    try {
      const res = await ApiClient.updateGitHubAppConfig({
        appId,
        installationId,
        oauthClientId,
        ...(oauthClientSecret ? { oauthClientSecret } : {}),
        ...(webhookSecret ? { webhookSecret } : {}),
        ...(privateKeyPem ? { privateKeyPem } : {}),
      });

      showToast('GitHub App credentials saved successfully!', 'success');
      currentAppConfig = res.appConfig || {};
      updateStatusBadges(currentAppConfig);
    } catch (err) {
      console.error('Failed to save GitHub App credentials:', err);
      showToast(`Failed to save credentials: ${err.message}`, 'error');
    }
  }

  async function verifyInstallationToken() {
    const appId = document.getElementById('input-app-id')?.value.trim();
    const installationId = document.getElementById('input-installation-id')?.value.trim();
    const privateKeyPem = document.getElementById('input-pem-key')?.value.trim();

    const statusTokenText = document.getElementById('status-token-text');
    if (statusTokenText) {
      statusTokenText.textContent = 'Verifying...';
      statusTokenText.style.color = 'var(--text-muted)';
    }

    try {
      const res = await ApiClient.verifyGitHubAppInstallation({
        appId,
        installationId,
        privateKeyPem,
      });

      if (res.verified) {
        if (statusTokenText) {
          statusTokenText.textContent = `✓ Valid (${res.tokenPrefix || 'ghs_...'})`;
          statusTokenText.style.color = 'var(--color-success)';
        }
        showToast('Successfully verified RSA JWT signature and installation token!', 'success');
      } else {
        throw new Error(res.error || 'Verification failed');
      }
    } catch (err) {
      if (statusTokenText) {
        statusTokenText.textContent = '✕ Verification Failed';
        statusTokenText.style.color = 'var(--color-danger)';
      }
      showToast(`Verification failed: ${err.message}`, 'error');
    }
  }

  async function resetConfig() {
    if (!confirm('Are you sure you want to reset all GitHub App onboarding credentials? This will clear stored secrets.')) {
      return;
    }

    try {
      const res = await ApiClient.deleteGitHubAppConfig();
      showToast(res.message || 'Reset GitHub App configuration', 'info');

      document.getElementById('input-app-id').value = '';
      document.getElementById('input-installation-id').value = '';
      document.getElementById('input-client-id').value = '';
      document.getElementById('input-client-secret').value = '';
      document.getElementById('input-webhook-secret').value = '';
      document.getElementById('input-pem-key').value = '';

      loadAppConfig();
    } catch (err) {
      showToast(`Failed to reset config: ${err.message}`, 'error');
    }
  }

  function setupDropzone() {
    const dropzone = document.getElementById('pem-dropzone');
    const fileInput = document.getElementById('pem-file-input');
    const browseBtn = document.getElementById('browse-pem-btn');
    const pemTextarea = document.getElementById('input-pem-key');

    if (!dropzone || !fileInput || !browseBtn || !pemTextarea) return;

    browseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });

    dropzone.addEventListener('click', () => {
      fileInput.click();
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const files = dt.files;
      if (files && files.length > 0) {
        handlePemFile(files[0]);
      }
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handlePemFile(e.target.files[0]);
      }
    });

    function handlePemFile(file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target.result;
        pemTextarea.value = text;
        showToast(`Loaded PEM file: ${file.name}`, 'success');
      };
      reader.onerror = () => {
        showToast(`Failed to read file: ${file.name}`, 'error');
      };
      reader.readAsText(file);
    }
  }

  async function loadMonitoredRepos() {
    try {
      const data = await ApiClient.getMonitoredRepos();
      monitoredRepos = data.repositories || [];
      renderMonitoredRepos(monitoredRepos);
    } catch (err) {
      console.error('Failed to load monitored repos:', err);
      showToast(`Failed to load monitored repositories: ${err.message}`, 'error');
    }
  }

  function renderMonitoredRepos(repos) {
    const tbody = document.getElementById('monitored-repos-tbody');
    const totalEl = document.getElementById('kpi-repo-total');
    const activeEl = document.getElementById('kpi-repo-active');

    if (totalEl) totalEl.textContent = String(repos.length);
    const activeCount = repos.filter((r) => r.automationEnabled).length;
    if (activeEl) activeEl.textContent = String(activeCount);

    if (!tbody) return;

    const searchTerm = (document.getElementById('input-repo-search')?.value || '').toLowerCase().trim();
    const filtered = repos.filter((r) => `${r.owner}/${r.repo}`.toLowerCase().includes(searchTerm));

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 24px;">No repositories match query.</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = '';
    filtered.forEach((r) => {
      const tr = document.createElement('tr');

      // Repository Name
      const tdRepo = document.createElement('td');
      tdRepo.innerHTML = `<strong>${r.owner}/${r.repo}</strong>`;

      // Profile Preset Badge
      const tdProfile = document.createElement('td');
      const profile = r.customProfile || 'balanced';
      const badgeClass = profile === 'assertive' ? 'badge-danger' : profile === 'chill' ? 'badge-warning' : 'badge-primary';
      tdProfile.innerHTML = `<span class="badge ${badgeClass}">${profile.toUpperCase()}</span>`;

      // Automation Status Badge
      const tdStatus = document.createElement('td');
      tdStatus.innerHTML = r.automationEnabled
        ? `<span class="badge badge-success">✓ Active</span>`
        : `<span class="badge badge-secondary">Disabled</span>`;

      // 1-Click Review Toggle
      const tdToggle = document.createElement('td');
      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'toggle-switch';

      const toggleInput = document.createElement('input');
      toggleInput.type = 'checkbox';
      toggleInput.checked = Boolean(r.automationEnabled);
      toggleInput.addEventListener('change', async (e) => {
        const isChecked = e.target.checked;
        r.automationEnabled = isChecked;
        tdStatus.innerHTML = isChecked
          ? `<span class="badge badge-success">✓ Active</span>`
          : `<span class="badge badge-secondary">Disabled</span>`;

        try {
          await ApiClient.toggleMonitoredRepo(r.owner, r.repo, isChecked);
          showToast(`${r.owner}/${r.repo} automated review ${isChecked ? 'enabled' : 'disabled'}`, 'success');
          const newActive = monitoredRepos.filter((x) => x.automationEnabled).length;
          if (activeEl) activeEl.textContent = String(newActive);
        } catch (err) {
          showToast(`Failed to toggle ${r.owner}/${r.repo}: ${err.message}`, 'error');
          e.target.checked = !isChecked; // revert
        }
      });

      const toggleSlider = document.createElement('span');
      toggleSlider.className = 'toggle-slider';

      toggleLabel.appendChild(toggleInput);
      toggleLabel.appendChild(toggleSlider);
      tdToggle.appendChild(toggleLabel);

      // Last Updated
      const tdDate = document.createElement('td');
      tdDate.style.fontSize = '12px';
      tdDate.style.color = 'var(--text-muted)';
      tdDate.textContent = r.updatedAt ? new Date(r.updatedAt).toLocaleString() : 'N/A';

      tr.appendChild(tdRepo);
      tr.appendChild(tdProfile);
      tr.appendChild(tdStatus);
      tr.appendChild(tdToggle);
      tr.appendChild(tdDate);

      tbody.appendChild(tr);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadAppConfig();
    setupDropzone();
    loadMonitoredRepos();

    document.getElementById('save-credentials-btn')?.addEventListener('click', saveCredentials);
    document.getElementById('verify-token-btn')?.addEventListener('click', verifyInstallationToken);
    document.getElementById('reset-config-btn')?.addEventListener('click', resetConfig);

    document.getElementById('input-repo-search')?.addEventListener('input', () => {
      renderMonitoredRepos(monitoredRepos);
    });

    // Mobile navigation toggle
    const mobileToggle = document.getElementById('mobile-toggle');
    const sidebar = document.querySelector('.sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');

    if (mobileToggle && sidebar && backdrop) {
      mobileToggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        backdrop.classList.toggle('active');
      });

      backdrop.addEventListener('click', () => {
        sidebar.classList.remove('open');
        backdrop.classList.remove('active');
      });
    }
  });
})();
