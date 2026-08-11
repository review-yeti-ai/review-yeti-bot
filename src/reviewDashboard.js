'use strict';

const crypto = require('crypto');

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_API_URL = 'https://api.reviewyeti.ai/api/v1/review-events';
const DEFAULT_SITE_URL = 'https://reviewyeti.ai';
const VALID_VERDICTS = new Set(['SHIP', 'FIX_FIRST', 'BLOCK']);
const VALID_STATUSES = new Set(['completed', 'failed', 'incomplete']);
const VALID_ENFORCEMENT = new Set(['advisory', 'block_on_block', 'block_non_ship']);
const VALID_GATE_DECISIONS = new Set(['PASS', 'BLOCKED']);

function clampString(value, maxLength = 2000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function sanitizeDashboardText(value, maxLength = 2000) {
  return clampString(value, maxLength)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(?:sk|gh[pousr]|lin_api|ctd_live)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}\b/gi, 'Bearer [REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]');
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function finiteCost(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function findingFingerprint(repository, finding) {
  return sha256([
    String(repository || '').toLowerCase(),
    clampString(finding.path, 500),
    String(finding.side || 'RIGHT').toUpperCase(),
    nonNegativeInteger(finding.line),
    String(finding.severity || '').toUpperCase(),
    clampString(finding.title, 300).toLowerCase(),
  ].join('\n'));
}

function sanitizeFinding(repository, personaId, finding) {
  const path = clampString(finding.path || finding.filePath, 500);
  const title = clampString(finding.title, 300);
  if (!path || !title || !['P0', 'P1', 'P2'].includes(finding.severity)) return null;
  const side = String(finding.side || 'RIGHT').toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
  return {
    severity: finding.severity,
    fingerprint: findingFingerprint(repository, { ...finding, path, title, side }),
    persona: clampString(personaId, 100),
    path,
    side,
    line: nonNegativeInteger(finding.line),
    title: sanitizeDashboardText(title, 300),
    body: sanitizeDashboardText(finding.body, 4000),
    suggestion: sanitizeDashboardText(finding.suggestion, 4000),
    ...(finding.githubUrl ? { githubUrl: clampString(finding.githubUrl, 1000) } : {}),
  };
}

function normalizeArbitration(arbitration = {}, personaResults = [], publicationPlan) {
  const thresholds = arbitration.thresholds || {};
  const lanes = Array.isArray(personaResults) ? personaResults : [];
  const expectedPersonas = Array.isArray(arbitration.expectedPersonas)
    ? arbitration.expectedPersonas
    : lanes.map((lane) => lane.personaId || lane.id).filter(Boolean);
  const completedPersonas = Array.isArray(arbitration.completedPersonas)
    ? arbitration.completedPersonas
    : lanes.filter((lane) => lane.decision !== 'ERROR' && !lane.error).map((lane) => lane.personaId || lane.id).filter(Boolean);
  const gateDecision = String(arbitration.gateDecision || '').toUpperCase();
  const publication = publicationPlan ? {
    publishedFindings: (publicationPlan.lineComments || []).length
      + (publicationPlan.fileComments || []).length
      + (publicationPlan.advisories || []).length,
    rejectedFindings: (publicationPlan.rejected || []).length,
  } : undefined;

  return {
    algorithmVersion: clampString(arbitration.algorithmVersion || 'review-arbitration-v1', 100),
    expectedPersonas: expectedPersonas.map((persona) => clampString(persona, 100)),
    completedPersonas: completedPersonas.map((persona) => clampString(persona, 100)),
    quorumSatisfied: Boolean(arbitration.quorumSatisfied),
    coverageQuorumSatisfied: Boolean(arbitration.coverageQuorumSatisfied),
    gateDecision: VALID_GATE_DECISIONS.has(gateDecision) ? gateDecision : 'BLOCKED',
    mergeEligible: Boolean(arbitration.mergeEligible),
    thresholds: {
      blockP1: nonNegativeInteger(thresholds.blockP1),
      fixP2: nonNegativeInteger(thresholds.fixP2),
    },
    ...(publication ? { publication } : {}),
  };
}

function workflowIdentity(env = process.env) {
  const server = String(env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '');
  const repository = clampString(env.PR_REPO || env.GITHUB_REPOSITORY || 'unknown/unknown', 300);
  const runId = clampString(env.GITHUB_RUN_ID || 'local', 100);
  return {
    runId,
    runAttempt: Math.max(1, nonNegativeInteger(env.GITHUB_RUN_ATTEMPT) || 1),
    url: runId === 'local' ? '' : `${server}/${repository}/actions/runs/${encodeURIComponent(runId)}`,
    trigger: clampString(env.GITHUB_EVENT_NAME || 'local', 100),
  };
}

function buildReviewEvent(options = {}, env = process.env) {
  const context = options.prContext || {};
  const eventPr = context.eventData?.pull_request || {};
  const repository = clampString(context.repo || env.PR_REPO || env.GITHUB_REPOSITORY || 'unknown/unknown', 300);
  const workflow = workflowIdentity({ ...env, PR_REPO: repository });
  const prNumber = Math.max(1, nonNegativeInteger(context.prNumber || env.PR_NUMBER));
  const headSha = clampString(context.headSha || eventPr.head?.sha || env.PR_HEAD_SHA || env.GITHUB_SHA || 'unknown', 100);
  const baseSha = clampString(context.baseSha || eventPr.base?.sha || env.GITHUB_BASE_SHA || '', 100);
  const eventKey = [repository.toLowerCase(), prNumber, headSha, workflow.runId, workflow.runAttempt].join(':');
  const personaResults = Array.isArray(options.personaResults) ? options.personaResults : [];
  const metrics = options.arbitration?.metrics || {};
  const usage = options.usage || {};
  const coverage = options.coverage || {};
  const startedAtMs = Number(options.startedAtMs) || Date.now();
  const completedAtMs = Number(options.completedAtMs) || Date.now();
  const requestedStatus = options.status || 'completed';
  const status = VALID_STATUSES.has(requestedStatus) ? requestedStatus : 'failed';
  const verdict = VALID_VERDICTS.has(options.arbitration?.verdict) ? options.arbitration.verdict : undefined;
  const enforcementMode = VALID_ENFORCEMENT.has(env.REVIEW_ENFORCEMENT_MODE)
    ? env.REVIEW_ENFORCEMENT_MODE
    : 'advisory';
  const githubUrl = eventPr.html_url
    || (prNumber ? `${String(env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '')}/${repository}/pull/${prNumber}` : '');
  const sourceFindings = Array.isArray(options.findings)
    ? options.findings
    : Array.isArray(options.arbitration?.findings)
      ? options.arbitration.findings
      : personaResults.flatMap((lane) => (lane.findings || [])
        .map((finding) => ({ ...finding, persona: finding.persona || lane.personaId || lane.id })));
  const findings = sourceFindings
    .map((finding) => sanitizeFinding(repository, finding.persona || finding.personaId || 'unknown', {
      ...finding,
      githubUrl: finding.githubUrl || (githubUrl && finding.path
        ? `${githubUrl}/files#diff-${sha256(finding.path)}${finding.line ? `R${nonNegativeInteger(finding.line)}` : ''}`
        : ''),
    }))
    .filter(Boolean);
  const uniqueFindings = [...new Map(findings.map((finding) => [finding.fingerprint, finding])).values()];

  return {
    schemaVersion: '1.0',
    eventId: `ctre_${sha256(eventKey).slice(0, 40)}`,
    eventType: status === 'failed' ? 'review.failed' : 'review.completed',
    occurredAt: new Date(completedAtMs).toISOString(),
    producer: {
      name: 'ct-review-bot',
      version: clampString(env.REVIEW_YETI_ACTION_REF || env.GITHUB_ACTION_REF || 'review-yeti-bot', 100),
    },
    repository: {
      fullName: repository,
      ...(env.GITHUB_REPOSITORY_ID ? { githubRepositoryId: clampString(env.GITHUB_REPOSITORY_ID, 100) } : {}),
    },
    pullRequest: {
      number: prNumber,
      title: sanitizeDashboardText(context.title || eventPr.title || env.PR_TITLE || 'Automated PR Review', 500),
      url: clampString(env.PR_URL || eventPr.html_url || githubUrl, 1000),
      headSha,
      ...(baseSha ? { baseSha } : {}),
    },
    workflow,
    review: {
      status,
      ...(verdict ? { verdict } : {}),
      ...(options.arbitration?.rationale ? { rationale: sanitizeDashboardText(options.arbitration.rationale, 2000) } : {}),
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      enforcement: { mode: enforcementMode },
      severityCounts: {
        p0: nonNegativeInteger(metrics.p0Count),
        p1: nonNegativeInteger(metrics.p1Count),
        p2: nonNegativeInteger(metrics.p2Count),
      },
      coverage: {
        filesReviewed: Array.isArray(coverage.reviewed) ? coverage.reviewed.length : 0,
        filesOmitted: Array.isArray(coverage.omitted) ? coverage.omitted.length : 0,
        filesSkippedGenerated: Array.isArray(coverage.skipped) ? coverage.skipped.length : 0,
        passes: nonNegativeInteger(coverage.passes),
      },
      usage: {
        promptTokens: nonNegativeInteger(usage.promptTokens),
        completionTokens: nonNegativeInteger(usage.completionTokens),
        totalTokens: nonNegativeInteger(usage.totalTokens),
        costUSD: finiteCost(usage.costUSD),
      },
      ...(options.arbitration ? {
        arbitration: normalizeArbitration({
          ...options.arbitration,
          ...(Array.isArray(options.expectedPersonas) ? { expectedPersonas: options.expectedPersonas } : {}),
        }, personaResults, options.publicationPlan),
      } : {}),
      personas: personaResults.map((lane) => ({
        persona: clampString(lane.personaId || lane.id, 100),
        provider: clampString(lane.provider || 'unknown', 100),
        model: clampString(lane.model || 'unknown', 300),
        decision: ['APPROVE', 'FINDINGS', 'ERROR'].includes(lane.decision) ? lane.decision : 'ERROR',
        durationMs: nonNegativeInteger(lane.durationMs),
        promptTokens: nonNegativeInteger(lane.usage?.promptTokens),
        completionTokens: nonNegativeInteger(lane.usage?.completionTokens),
        totalTokens: nonNegativeInteger(lane.usage?.totalTokens)
          || nonNegativeInteger(lane.usage?.promptTokens) + nonNegativeInteger(lane.usage?.completionTokens),
        costUSD: finiteCost(lane.usage?.costUSD),
      })),
      ...(options.detail === 'metrics' ? {} : { findings: uniqueFindings }),
    },
  };
}

function validateUrl(value, fallback) {
  let url;
  try { url = new URL(String(value || fallback)); } catch (_) { throw new Error('dashboard URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('dashboard URL must be an HTTP(S) URL without credentials');
  }
  return url;
}

function resolveApiUrl(value) {
  const url = validateUrl(value, DEFAULT_API_URL);
  if (!url.pathname.endsWith('/api/v1/review-events')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/v1/review-events`;
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

function reviewUrlForRun(siteUrl, reviewRunId) {
  if (!reviewRunId) return undefined;
  const url = validateUrl(siteUrl, DEFAULT_SITE_URL);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/dashboard/reviews/${encodeURIComponent(String(reviewRunId))}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function parseResponseBody(response) {
  if (!response || typeof response.json !== 'function') return Promise.resolve({});
  return response.json().catch(() => ({}));
}

async function deliverReviewEvent(options = {}) {
  const apiKey = String(options.apiKey || '');
  const configuredUrl = String(options.apiUrl || options.url || '');
  if (!apiKey || !configuredUrl) return { status: 'disabled', attempts: 0 };
  if (!/^ctd_live_[A-Za-z0-9_-]+$/.test(apiKey)) return { status: 'failed', attempts: 0, reason: 'invalid dashboard key format' };

  const event = typeof options.event === 'string' ? JSON.parse(options.event) : options.event;
  const payload = JSON.stringify(event);
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) return { status: 'failed', attempts: 0, reason: 'payload exceeds 1 MB' };
  const endpoint = resolveApiUrl(configuredUrl);
  const timeoutMs = Math.max(1, Math.min(10_000, nonNegativeInteger(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const fetchImpl = options.fetchImpl || fetch;
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const signal = options.signal;
  if (signal?.aborted) return { status: 'cancelled', attempts: 0 };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': event.eventId,
          'User-Agent': 'review-yeti-bot/dashboard-delivery',
        },
        body: payload,
        signal: controller.signal,
      });
      if (response.status >= 200 && response.status < 300) {
        const body = await parseResponseBody(response);
        const status = response.status === 200 ? 'duplicate' : 'accepted';
        const reviewRunId = typeof body?.reviewRunId === 'string' ? body.reviewRunId : undefined;
        return {
          status,
          attempts: attempt,
          ...(reviewRunId ? { reviewRunId, reviewUrl: reviewUrlForRun(options.siteUrl, reviewRunId) } : {}),
        };
      }
      if (![408, 425, 429].includes(response.status) && response.status < 500) {
        return { status: 'failed', attempts: attempt, reason: `HTTP ${response.status}` };
      }
      if (attempt === 3) return { status: 'failed', attempts: attempt, reason: `HTTP ${response.status}` };
    } catch (error) {
      if (signal?.aborted) return { status: 'cancelled', attempts: attempt };
      if (attempt === 3) return { status: 'failed', attempts: attempt, reason: error?.name === 'AbortError' ? 'timeout' : 'network error' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
    await wait((150 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 100));
  }
  return { status: 'failed', attempts: 3, reason: 'delivery exhausted' };
}

module.exports = {
  DEFAULT_API_URL,
  DEFAULT_SITE_URL,
  MAX_PAYLOAD_BYTES,
  buildReviewEvent,
  deliverReviewEvent,
  findingFingerprint,
  reviewUrlForRun,
  sanitizeDashboardText,
  validateUrl,
};
