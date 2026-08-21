(function () {
  'use strict';

  let currentJobId = 'default-job';
  let activeFilter = 'all';
  let searchQuery = '';
  let autoScroll = true;

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let totalAstLookups = 0;
  let totalSuppressedNits = 0;

  const personaCounts = {
    all: 0,
    security: 0,
    architecture: 0,
    performance: 0,
    quality: 0,
    database: 0,
    api_contract: 0,
    reliability: 0,
    devops: 0,
    docs_compliance: 0,
    finops: 0,
    red_team: 0,
    quorum: 0,
  };

  const allEvents = [];
  let evtSource = null;

  function getJobIdFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('jobId') || urlParams.get('job_id') || 'default-job';
  }

  function setJobIdDisplay(id) {
    currentJobId = id;
    const el = document.getElementById('job-id-display');
    if (el) el.textContent = 'Job: ' + id;
  }

  async function loadActiveJobs() {
    const container = document.getElementById('active-jobs-list');
    if (!container) return;

    try {
      const res = await fetch('/api/live/active');
      const data = await res.json();
      const jobs = data.jobs || [];

      container.innerHTML = '';
      if (jobs.length === 0) {
        container.innerHTML = '<div style="font-size:12px; color: var(--text-muted); padding: 8px;">No active jobs found</div>';
        return;
      }

      jobs.forEach((job) => {
        const item = document.createElement('div');
        item.className = `active-job-item ${job.jobId === currentJobId ? 'active' : ''}`;
        
        const header = document.createElement('div');
        header.className = 'active-job-header';
        
        const nameSpan = document.createElement('span');
        nameSpan.textContent = job.repository ? `${job.repository} #${job.prNumber}` : job.jobId;

        const badge = document.createElement('span');
        const isRunning = job.status === 'running' || !job.arbiterVerdict;
        badge.className = `badge ${isRunning ? 'badge-info' : job.arbiterVerdict === 'SHIP' ? 'badge-success' : 'badge-danger'}`;
        badge.textContent = isRunning ? 'RUNNING' : (job.arbiterVerdict || 'COMPLETED');

        header.appendChild(nameSpan);
        header.appendChild(badge);

        const subtext = document.createElement('div');
        subtext.className = 'active-job-subtext';
        subtext.textContent = `ID: ${job.jobId} ${job.headSha ? '• ' + job.headSha.slice(0, 7) : ''}`;

        item.appendChild(header);
        item.appendChild(subtext);

        item.addEventListener('click', () => {
          connectToJob(job.jobId);
        });

        container.appendChild(item);
      });
    } catch (err) {
      console.error('Failed loading active jobs:', err);
    }
  }

  function connectToJob(jobId) {
    if (evtSource) {
      evtSource.close();
    }

    currentJobId = jobId;
    setJobIdDisplay(jobId);

    // Update query string in URL without full reload
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('jobId', jobId);
    window.history.pushState({ path: newUrl.href }, '', newUrl.href);

    // Reset logs and metrics for new job stream
    clearFeed();

    const statusEl = document.getElementById('connection-status');
    if (statusEl) {
      statusEl.textContent = 'Connecting to SSE Stream...';
      statusEl.style.color = 'var(--color-warning)';
    }

    evtSource = new EventSource('/api/live/stream?jobId=' + encodeURIComponent(jobId));

    evtSource.onopen = () => {
      if (statusEl) {
        statusEl.textContent = '● SSE STREAM CONNECTED';
        statusEl.style.color = 'var(--color-success)';
      }
    };

    evtSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleIncomingEvent(data);
      } catch (err) {
        console.error('Failed parsing SSE payload', err);
      }
    };

    evtSource.onerror = () => {
      if (statusEl) {
        statusEl.textContent = '○ DISCONNECTED (RETRYING)';
        statusEl.style.color = 'var(--color-warning)';
      }
    };

    loadActiveJobs();
  }

  function handleIncomingEvent(data) {
    allEvents.push(data);

    // Update Persona counts & progress
    const persona = data.persona || 'quality';
    if (personaCounts[persona] !== undefined) {
      personaCounts[persona]++;
      const badge = document.getElementById('badge-' + persona);
      if (badge) badge.textContent = personaCounts[persona];

      const progressBar = document.getElementById('progress-' + persona);
      if (progressBar) {
        const progressVal = Math.min(100, personaCounts[persona] * 20);
        progressBar.style.width = `${progressVal}%`;
      }
    }
    personaCounts.all++;
    const allBadge = document.getElementById('badge-all');
    if (allBadge) allBadge.textContent = personaCounts.all;

    // Streaming LLM token usage metrics counter
    if (data.data) {
      const pTokens = data.data.promptTokens || (data.data.tokensUsed ? Math.floor(data.data.tokensUsed * 0.8) : 0);
      const cTokens = data.data.completionTokens || (data.data.tokensUsed ? Math.floor(data.data.tokensUsed * 0.2) : 0);
      const tTokens = data.data.tokensUsed || (pTokens + cTokens);
      const cost = data.data.costUSD || (tTokens * 0.000003);

      if (tTokens > 0) {
        totalPromptTokens += pTokens;
        totalCompletionTokens += cTokens;
        totalTokens += tTokens;
        totalCostUsd += cost;

        const statPrompt = document.getElementById('stat-prompt-tokens');
        if (statPrompt) statPrompt.textContent = totalPromptTokens.toLocaleString();

        const statComp = document.getElementById('stat-completion-tokens');
        if (statComp) statComp.textContent = totalCompletionTokens.toLocaleString();

        const statTokens = document.getElementById('stat-tokens');
        if (statTokens) statTokens.textContent = totalTokens.toLocaleString();

        const statCost = document.getElementById('stat-cost');
        if (statCost) statCost.textContent = '$' + totalCostUsd.toFixed(4) + ' USD';
      }

      if (data.data.verdict) {
        const verdictEl = document.getElementById('stat-verdict');
        if (verdictEl) {
          verdictEl.textContent = data.data.verdict;
          if (data.data.verdict === 'SHIP' || data.data.verdict === 'APPROVE') {
            verdictEl.style.color = 'var(--color-success)';
          } else if (data.data.verdict === 'REJECT' || data.data.verdict === 'REQUEST_CHANGES') {
            verdictEl.style.color = 'var(--color-danger)';
          }
        }
      }
    }

    updateInspectors(data);
    renderLogs();
  }

  function updateInspectors(evt) {
    if (!evt.data) return;

    if (evt.data.promptSnippet) {
      const promptEl = document.getElementById('inspector-prompt');
      if (promptEl) promptEl.textContent = evt.data.promptSnippet;
    }
    if (evt.data.path) {
      const diffEl = document.getElementById('inspector-diff');
      if (diffEl) diffEl.textContent = 'Evaluating file: ' + evt.data.path + (evt.data.line ? `:${evt.data.line}` : '');
    }
    if (evt.type === 'indexer_lookup') {
      totalAstLookups++;
      const astStat = document.getElementById('stat-ast');
      if (astStat) astStat.textContent = totalAstLookups;
      const astInsp = document.getElementById('inspector-ast');
      if (astInsp) astInsp.textContent = 'Lookup: ' + (evt.data.message || JSON.stringify(evt.data));
    }
    if (evt.type === 'nit_suppression') {
      totalSuppressedNits++;
      const nitStat = document.getElementById('stat-nits');
      if (nitStat) nitStat.textContent = totalSuppressedNits;
      const nitInsp = document.getElementById('inspector-nits');
      if (nitInsp) nitInsp.textContent = 'Suppressed: ' + (evt.data.message || JSON.stringify(evt.data));
    }
  }

  function filterPersona(persona, buttonEl) {
    activeFilter = persona;
    document.querySelectorAll('.tab-button').forEach((btn) => btn.classList.remove('active'));
    if (buttonEl) {
      buttonEl.classList.add('active');
    }
    renderLogs();
  }

  function toggleAutoScroll() {
    autoScroll = !autoScroll;
    const toggle = document.getElementById('autoscroll-toggle');
    if (toggle) {
      toggle.classList.toggle('active', autoScroll);
    }
  }

  function clearFeed() {
    allEvents.length = 0;
    Object.keys(personaCounts).forEach((k) => (personaCounts[k] = 0));
    totalPromptTokens = 0;
    totalCompletionTokens = 0;
    totalTokens = 0;
    totalCostUsd = 0;
    totalAstLookups = 0;
    totalSuppressedNits = 0;

    document.querySelectorAll('.tab-badge').forEach((b) => (b.textContent = '0'));
    document.querySelectorAll('.progress-bar-fill').forEach((p) => (p.style.width = '0%'));

    const statPrompt = document.getElementById('stat-prompt-tokens');
    if (statPrompt) statPrompt.textContent = '0';

    const statComp = document.getElementById('stat-completion-tokens');
    if (statComp) statComp.textContent = '0';

    const statTokens = document.getElementById('stat-tokens');
    if (statTokens) statTokens.textContent = '0';

    const statCost = document.getElementById('stat-cost');
    if (statCost) statCost.textContent = '$0.0000 USD';

    const statAst = document.getElementById('stat-ast');
    if (statAst) statAst.textContent = '0';

    const statNits = document.getElementById('stat-nits');
    if (statNits) statNits.textContent = '0';

    renderLogs();
  }

  function handleSearchInput() {
    const input = document.getElementById('terminal-search');
    if (input) {
      searchQuery = input.value.toLowerCase().trim();
      renderLogs();
    }
  }

  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderLogs() {
    const feed = document.getElementById('terminal-feed');
    if (!feed) return;
    feed.innerHTML = '';

    const filtered = allEvents.filter((evt) => {
      const matchesPersona = activeFilter === 'all' || evt.persona === activeFilter;
      if (!matchesPersona) return false;
      if (!searchQuery) return true;
      const textContent = JSON.stringify(evt).toLowerCase();
      return textContent.includes(searchQuery);
    });

    filtered.forEach((evt) => {
      const line = document.createElement('div');
      line.className = 'log-line';
      const personaName = evt.persona || 'quality';
      const tagClass = 'tag-' + personaName;
      const timestamp = evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
      const timeSpan = `<span class="log-time">[${timestamp}]</span>`;
      const tagSpan = `<span class="${tagClass}">[${personaName.toUpperCase()}]</span>`;

      if (evt.type === 'llm_chunk') {
        line.innerHTML = `${timeSpan} ${tagSpan} <div class="llm-chunk">${escapeHtml(evt.data.chunk || '')}</div>`;
      } else {
        const detail = evt.data.message || JSON.stringify(evt.data);
        line.innerHTML = `${timeSpan} ${tagSpan} <span><strong>${evt.type}</strong>: ${escapeHtml(detail)}</span>`;
      }
      feed.appendChild(line);
    });

    if (autoScroll) {
      feed.scrollTop = feed.scrollHeight;
    }
  }

  // Export functions to global scope for button onclicks
  window.filterPersona = filterPersona;
  window.toggleAutoScroll = toggleAutoScroll;
  window.clearFeed = clearFeed;
  window.handleSearchInput = handleSearchInput;
  window.connectToJob = connectToJob;

  document.addEventListener('DOMContentLoaded', () => {
    const initialJobId = getJobIdFromUrl();
    setJobIdDisplay(initialJobId);
    connectToJob(initialJobId);

    // Refresh active jobs list every 10 seconds
    setInterval(loadActiveJobs, 10000);
  });
})();
