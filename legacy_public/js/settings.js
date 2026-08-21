(function () {
  'use strict';

  const DEFAULT_PERSONAS_META = {
    security: {
      id: 'security',
      displayName: '🛡️ Security & Tenancy Guardian',
      description: 'Secret scanning, Auth, OWASP Top 10, multi-tenant isolation.',
      enabled: true,
      model: 'claude-3-5-sonnet',
      effort: 'max',
      confidenceThreshold: 85,
    },
    architecture: {
      id: 'architecture',
      displayName: '🏛️ System Architecture & Design',
      description: 'Module boundaries, ADR compliance, design pattern enforcement.',
      enabled: true,
      model: 'claude-3-5-sonnet',
      effort: 'high',
      confidenceThreshold: 75,
    },
    performance: {
      id: 'performance',
      displayName: '⚡ Performance & Scalability',
      description: 'CPU/Memory hotspots, N+1 queries, unindexed lookups, memory leaks.',
      enabled: true,
      model: 'gpt-4o',
      effort: 'high',
      confidenceThreshold: 70,
    },
    quality: {
      id: 'quality',
      displayName: '✨ Code Quality & Style',
      description: 'Idiomatic syntax, type safety, readability, error handling context.',
      enabled: true,
      model: 'claude-3-5-sonnet',
      effort: 'medium',
      confidenceThreshold: 70,
    },
    database: {
      id: 'database',
      displayName: '🗄️ Database & Persistence',
      description: 'Migration hazards, raw SQL injection, transaction safety, composite index efficiency.',
      enabled: true,
      model: 'gpt-4o',
      effort: 'high',
      confidenceThreshold: 80,
    },
    api_contract: {
      id: 'api_contract',
      displayName: '🔌 API Contract & Integration Safety',
      description: 'Breaking API schema changes, OpenAPI/REST spec drift, input validation.',
      enabled: true,
      model: 'claude-3-5-sonnet',
      effort: 'medium',
      confidenceThreshold: 75,
    },
    reliability: {
      id: 'reliability',
      displayName: '💥 Reliability & Resilience (SRE)',
      description: 'Rate limiting, circuit breakers, timeout backoffs with jitter, telemetry context.',
      enabled: true,
      model: 'deepseek-v3',
      effort: 'high',
      confidenceThreshold: 80,
    },
    devops: {
      id: 'devops',
      displayName: '🐳 DevOps & Container Infra',
      description: 'K8s manifests, Dockerfile optimization, IAM boundaries, CI/CD actions.',
      enabled: true,
      model: 'glm-4',
      effort: 'medium',
      confidenceThreshold: 75,
    },
    docs_compliance: {
      id: 'docs_compliance',
      displayName: '📝 Documentation & License Compliance',
      description: 'Inline docstrings, README updates, open-source license audits.',
      enabled: true,
      model: 'claude-3-5-sonnet',
      effort: 'low',
      confidenceThreshold: 60,
    },
    finops: {
      id: 'finops',
      displayName: '💰 FinOps & Cost Optimization',
      description: 'Prompt token budget efficiency, model cost tiering, AST hunk filtering.',
      enabled: true,
      model: 'glm-4',
      effort: 'medium',
      confidenceThreshold: 70,
    },
    red_team: {
      id: 'red_team',
      displayName: '🚩 Red Team Adversarial Challenger',
      description: 'Adversarial exploit generation, prompt injection, payload fuzzing.',
      enabled: true,
      model: 'deepseek-v3',
      effort: 'max',
      confidenceThreshold: 85,
    },
  };

  const AVAILABLE_MODELS = [
    { value: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'deepseek-v3', label: 'DeepSeek V3' },
    { value: 'glm-4', label: 'GLM-4' },
  ];

  const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'];

  let currentSettings = null;
  let personaState = {};

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

  function updateActiveBadge() {
    const badge = document.getElementById('active-personas-badge');
    if (!badge) return;
    const keys = Object.keys(personaState);
    const activeCount = keys.filter((k) => personaState[k].enabled).length;
    badge.textContent = `${activeCount} / ${keys.length} Personas Active`;
    if (activeCount === keys.length) {
      badge.className = 'badge badge-success';
    } else if (activeCount > 0) {
      badge.className = 'badge badge-warning';
    } else {
      badge.className = 'badge badge-danger';
    }
  }

  async function loadSettings() {
    try {
      const data = await ApiClient.getSettings();
      currentSettings = data.settings || {};
      const loadedPersonas = currentSettings.personaSettings || {};

      // Merge defaults with loaded settings
      personaState = {};
      for (const id of Object.keys(DEFAULT_PERSONAS_META)) {
        personaState[id] = {
          ...DEFAULT_PERSONAS_META[id],
          ...(loadedPersonas[id] || {}),
        };
      }
      renderPersonaCards();
      populateExtraSettings(currentSettings);
    } catch (err) {
      console.error('Failed to load settings:', err);
      showToast(`Failed to load settings: ${err.message}`, 'error');
    }
  }

  function populateExtraSettings(settings) {
    const autoReview = settings.autoReviewSettings || {};
    const triggers = autoReview.triggers || ['pr_opened', 'pr_synchronize', '@ct-review'];

    const openedCb = document.getElementById('trigger-pr-opened');
    if (openedCb) openedCb.checked = triggers.includes('pr_opened') || triggers.includes('opened');

    const synchCb = document.getElementById('trigger-pr-synchronize');
    if (synchCb) synchCb.checked = triggers.includes('pr_synchronize') || triggers.includes('synchronize');

    const mentionCb = document.getElementById('trigger-ct-review');
    if (mentionCb) mentionCb.checked = triggers.includes('@ct-review');

    const reviewDraftsToggle = document.getElementById('toggle-review-drafts');
    if (reviewDraftsToggle) reviewDraftsToggle.checked = Boolean(autoReview.review_drafts);

    const labelsInput = document.getElementById('input-review-labels');
    if (labelsInput && Array.isArray(autoReview.labels)) labelsInput.value = autoReview.labels.join(', ');

    const ignoreTextarea = document.getElementById('input-ignore-patterns');
    if (ignoreTextarea && Array.isArray(autoReview.ignore_patterns)) ignoreTextarea.value = autoReview.ignore_patterns.join('\n');

    const policy = settings.enforcementPolicy || {};
    const reqReviewsToggle = document.getElementById('toggle-require-all-reviews');
    if (reqReviewsToggle) reqReviewsToggle.checked = policy.require_all_reviews !== false;

    const reqTicketToggle = document.getElementById('toggle-require-ticket-link');
    if (reqTicketToggle) reqTicketToggle.checked = Boolean(policy.require_ticket_link);

    const failActionSelect = document.getElementById('select-failure-action');
    if (failActionSelect && policy.failure_action) failActionSelect.value = policy.failure_action;

    const bases = settings.customApiBases || {};
    const baseOmni = document.getElementById('input-base-omniroute');
    if (baseOmni && bases.omniroute_base_url) baseOmni.value = bases.omniroute_base_url;

    const baseOpenAI = document.getElementById('input-base-openai');
    if (baseOpenAI && bases.openai_base_url) baseOpenAI.value = bases.openai_base_url;

    const baseAnthropic = document.getElementById('input-base-anthropic');
    if (baseAnthropic && bases.anthropic_base_url) baseAnthropic.value = bases.anthropic_base_url;

    const baseDeepseek = document.getElementById('input-base-deepseek');
    if (baseDeepseek && bases.deepseek_base_url) baseDeepseek.value = bases.deepseek_base_url;

    const baseOllama = document.getElementById('input-base-ollama');
    if (baseOllama && bases.ollama_base_url) baseOllama.value = bases.ollama_base_url;
  }

  function getExtraSettingsPayload() {
    const triggers = [];
    if (document.getElementById('trigger-pr-opened')?.checked) triggers.push('pr_opened');
    if (document.getElementById('trigger-pr-synchronize')?.checked) triggers.push('pr_synchronize');
    if (document.getElementById('trigger-ct-review')?.checked) triggers.push('@ct-review');

    const reviewDrafts = Boolean(document.getElementById('toggle-review-drafts')?.checked);
    const labelsRaw = document.getElementById('input-review-labels')?.value || '';
    const labels = labelsRaw.split(',').map((s) => s.trim()).filter(Boolean);

    const ignoreRaw = document.getElementById('input-ignore-patterns')?.value || '';
    const ignorePatterns = ignoreRaw.split('\n').map((s) => s.trim()).filter(Boolean);

    const requireAllReviews = Boolean(document.getElementById('toggle-require-all-reviews')?.checked);
    const requireTicketLink = Boolean(document.getElementById('toggle-require-ticket-link')?.checked);
    const failureAction = document.getElementById('select-failure-action')?.value || 'fail_closed';

    const omnirouteBaseUrl = document.getElementById('input-base-omniroute')?.value.trim();
    const openaiBaseUrl = document.getElementById('input-base-openai')?.value.trim();
    const anthropicBaseUrl = document.getElementById('input-base-anthropic')?.value.trim();
    const deepseekBaseUrl = document.getElementById('input-base-deepseek')?.value.trim();
    const ollamaBaseUrl = document.getElementById('input-base-ollama')?.value.trim();

    return {
      autoReviewSettings: {
        enabled: true,
        triggers,
        review_drafts: reviewDrafts,
        ignore_drafts: !reviewDrafts,
        labels,
        ignore_patterns: ignorePatterns,
      },
      enforcementPolicy: {
        require_all_reviews: requireAllReviews,
        failure_action: failureAction,
        require_ticket_link: requireTicketLink,
      },
      customApiBases: {
        omniroute_base_url: omnirouteBaseUrl,
        openai_base_url: openaiBaseUrl,
        anthropic_base_url: anthropicBaseUrl,
        deepseek_base_url: deepseekBaseUrl,
        ollama_base_url: ollamaBaseUrl,
      },
    };
  }

  async function saveAllSettings() {
    try {
      const extraPayload = getExtraSettingsPayload();
      const payload = {
        personaSettings: personaState,
        ...extraPayload,
      };
      await ApiClient.updateSettings(payload);
      showToast('All platform and persona settings saved successfully!', 'success');
    } catch (err) {
      showToast(`Failed to save settings: ${err.message}`, 'error');
    }
  }

  function renderPersonaCards() {
    const grid = document.getElementById('persona-settings-grid');
    if (!grid) return;

    grid.innerHTML = '';

    for (const [id, persona] of Object.entries(personaState)) {
      const card = document.createElement('div');
      card.className = `glass-panel persona-card ${persona.enabled ? '' : 'disabled'}`;
      card.id = `card-persona-${id}`;

      // Card Header
      const header = document.createElement('div');
      header.className = 'persona-card-header';

      const titleGroup = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'persona-card-title';
      title.textContent = persona.displayName || id;

      const desc = document.createElement('div');
      desc.className = 'persona-card-desc';
      desc.textContent = persona.description || '';

      titleGroup.appendChild(title);
      titleGroup.appendChild(desc);

      // Toggle Switch
      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'toggle-switch';

      const toggleInput = document.createElement('input');
      toggleInput.type = 'checkbox';
      toggleInput.checked = Boolean(persona.enabled);
      toggleInput.addEventListener('change', async (e) => {
        const isChecked = e.target.checked;
        persona.enabled = isChecked;
        card.classList.toggle('disabled', !isChecked);
        updateActiveBadge();
        try {
          await ApiClient.updatePersonaSetting(id, { enabled: isChecked });
          showToast(`${persona.displayName} ${isChecked ? 'enabled' : 'disabled'}`, 'success');
        } catch (err) {
          showToast(`Failed to update toggle: ${err.message}`, 'error');
        }
      });

      const toggleSlider = document.createElement('span');
      toggleSlider.className = 'toggle-slider';

      toggleLabel.appendChild(toggleInput);
      toggleLabel.appendChild(toggleSlider);

      header.appendChild(titleGroup);
      header.appendChild(toggleLabel);

      // Controls Container
      const controls = document.createElement('div');
      controls.style.display = 'flex';
      controls.style.flexDirection = 'column';
      controls.style.gap = '16px';

      // 1. Model Selector
      const modelGroup = document.createElement('div');
      modelGroup.className = 'form-group';
      modelGroup.style.marginBottom = '0';

      const modelLabel = document.createElement('label');
      modelLabel.textContent = 'LLM Model Selection';

      const modelSelect = document.createElement('select');
      modelSelect.className = 'select-control';

      AVAILABLE_MODELS.forEach((m) => {
        const option = document.createElement('option');
        option.value = m.value;
        option.textContent = m.label;
        if (m.value === persona.model) {
          option.selected = true;
        }
        modelSelect.appendChild(option);
      });

      modelSelect.addEventListener('change', async (e) => {
        const newModel = e.target.value;
        persona.model = newModel;
        try {
          await ApiClient.updatePersonaSetting(id, { model: newModel });
          showToast(`Updated model for ${persona.displayName} to ${newModel}`, 'success');
        } catch (err) {
          showToast(`Failed to update model: ${err.message}`, 'error');
        }
      });

      modelGroup.appendChild(modelLabel);
      modelGroup.appendChild(modelSelect);

      // 2. Effort Level Selector
      const effortGroup = document.createElement('div');
      effortGroup.className = 'form-group';
      effortGroup.style.marginBottom = '0';

      const effortLabel = document.createElement('label');
      effortLabel.textContent = 'Reasoning Effort Level';

      const effortPills = document.createElement('div');
      effortPills.className = 'effort-pills';

      EFFORT_LEVELS.forEach((eff) => {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = `effort-pill ${eff === persona.effort ? 'active' : ''}`;
        pill.textContent = eff.toUpperCase();

        pill.addEventListener('click', async () => {
          persona.effort = eff;
          Array.from(effortPills.children).forEach((child) => child.classList.remove('active'));
          pill.classList.add('active');
          try {
            await ApiClient.updatePersonaSetting(id, { effort: eff });
            showToast(`Updated effort level for ${persona.displayName} to ${eff}`, 'success');
          } catch (err) {
            showToast(`Failed to update effort level: ${err.message}`, 'error');
          }
        });

        effortPills.appendChild(pill);
      });

      effortGroup.appendChild(effortLabel);
      effortGroup.appendChild(effortPills);

      // 3. Confidence Threshold Slider
      const sliderGroup = document.createElement('div');
      sliderGroup.className = 'form-group';
      sliderGroup.style.marginBottom = '0';

      const sliderHeader = document.createElement('div');
      sliderHeader.className = 'slider-header';

      const sliderLabel = document.createElement('label');
      sliderLabel.textContent = 'Confidence Threshold';

      const sliderValueBadge = document.createElement('span');
      sliderValueBadge.className = 'slider-value-badge';
      sliderValueBadge.textContent = `${persona.confidenceThreshold || 70}%`;

      sliderHeader.appendChild(sliderLabel);
      sliderHeader.appendChild(sliderValueBadge);

      const sliderInput = document.createElement('input');
      sliderInput.type = 'range';
      sliderInput.className = 'slider-control';
      sliderInput.min = '0';
      sliderInput.max = '100';
      sliderInput.value = String(persona.confidenceThreshold || 70);

      sliderInput.addEventListener('input', (e) => {
        sliderValueBadge.textContent = `${e.target.value}%`;
      });

      sliderInput.addEventListener('change', async (e) => {
        const val = parseInt(e.target.value, 10);
        persona.confidenceThreshold = val;
        try {
          await ApiClient.updatePersonaSetting(id, { confidenceThreshold: val });
          showToast(`Updated confidence threshold for ${persona.displayName} to ${val}%`, 'success');
        } catch (err) {
          showToast(`Failed to update confidence threshold: ${err.message}`, 'error');
        }
      });

      sliderGroup.appendChild(sliderHeader);
      sliderGroup.appendChild(sliderInput);

      controls.appendChild(modelGroup);
      controls.appendChild(effortGroup);
      controls.appendChild(sliderGroup);

      card.appendChild(header);
      card.appendChild(controls);

      grid.appendChild(card);
    }

    updateActiveBadge();
  }

  async function saveAllSettings() {
    try {
      const payload = {
        personaSettings: personaState,
      };
      await ApiClient.updateSettings(payload);
      showToast('All per-persona settings saved successfully!', 'success');
    } catch (err) {
      showToast(`Failed to save settings: ${err.message}`, 'error');
    }
  }

  async function resetDefaults() {
    personaState = JSON.parse(JSON.stringify(DEFAULT_PERSONAS_META));
    renderPersonaCards();
    await saveAllSettings();
    showToast('Reset all persona settings to factory defaults.', 'info');
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadSettings();

    const saveBtn = document.getElementById('save-all-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', saveAllSettings);
    }

    const resetBtn = document.getElementById('reset-defaults-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', resetDefaults);
    }

    // Mobile toggle support
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
