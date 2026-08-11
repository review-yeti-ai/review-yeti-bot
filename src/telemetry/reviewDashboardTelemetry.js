'use strict';

const crypto = require('node:crypto');

const SCHEMA_VERSION = '1.0';
const PRODUCER_NAME = 'ct-review-bot';
const EVENT_ID_PREFIX = 'ctre_';
const DEFAULT_API_URL = 'https://api.reviewyeti.ai/api/v1/review-events';
const DEFAULT_SITE_URL = 'https://reviewyeti.ai';
const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 10_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429]);
const VALID_EVENT_TYPES = new Set(['review.completed', 'review.failed']);
const VALID_STATUSES = new Set(['completed', 'failed', 'incomplete']);
const VALID_VERDICTS = new Set(['SHIP', 'FIX_FIRST', 'BLOCK']);
const VALID_ENFORCEMENT_MODES = new Set(['advisory', 'block_on_block', 'block_non_ship']);
const VALID_DECISIONS = new Set(['APPROVE', 'FINDINGS', 'ERROR']);
const VALID_SEVERITIES = new Set(['P0', 'P1', 'P2']);
const VALID_SIDES = new Set(['LEFT', 'RIGHT']);
const VALID_GATE_DECISIONS = new Set(['PASS', 'BLOCKED']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function clampString(value, maxLength = 2_000) {
  return asString(value).slice(0, maxLength);
}

function redactSensitiveText(value, maxLength = 2_000) {
  return clampString(value, maxLength)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}\b/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|sk_live|sk_test|gh[pousr]|lin_api|ctd_live|xox[baprs])[_-]?[A-Za-z0-9._-]{8,}\b/giu, '[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[REDACTED_EMAIL]');
}

function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function positiveInteger(value, fallback = 0) {
  const parsed = nonNegativeInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function nullableCost(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizedRepository(value) {
  return asString(value).toLowerCase();
}

function normalizedHeadSha(value) {
  return asString(value).toLowerCase();
}

/**
 * Creates the idempotency identity for one workflow attempt. Presentation changes such as
 * repository casing or surrounding whitespace do not create a second event identity.
 */
function createReviewEventId({ repository, prNumber, headSha, runId, runAttempt } = {}) {
  const identity = [
    normalizedRepository(repository),
    positiveInteger(prNumber),
    normalizedHeadSha(headSha),
    asString(runId),
    Math.max(1, positiveInteger(runAttempt, 1)),
  ].join(':');
  return `${EVENT_ID_PREFIX}${sha256(identity).slice(0, 40)}`;
}

const createEventId = createReviewEventId;

function toIso(value, fallbackMs) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return new Date(fallbackMs).toISOString();
}

function timestampMs(value, fallbackMs) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return Date.parse(value);
  return fallbackMs;
}

function normalizeUrl(value) {
  return redactSensitiveText(value, 1_000);
}

function workflowFrom(options, env, repository, prNumber) {
  const input = isObject(options.workflow) ? options.workflow : {};
  const runId = asString(input.runId || options.runId || env.GITHUB_RUN_ID, 'local');
  const runAttempt = Math.max(1, positiveInteger(input.runAttempt || options.runAttempt || env.GITHUB_RUN_ATTEMPT, 1));
  const server = asString(env.GITHUB_SERVER_URL, 'https://github.com').replace(/\/$/u, '');
  return {
    runId,
    runAttempt,
    url: normalizeUrl(input.url || options.workflowUrl || (runId === 'local'
      ? ''
      : `${server}/${repository}/actions/runs/${encodeURIComponent(runId)}`)),
    trigger: redactSensitiveText(input.trigger || options.trigger || env.GITHUB_EVENT_NAME, 100) || 'local',
  };
}

function extractPullRequest(options, env) {
  const context = isObject(options.prContext) ? options.prContext : {};
  const eventPr = isObject(context.eventData?.pull_request) ? context.eventData.pull_request : {};
  const repository = asString(
    options.repository || options.fullName || context.repository || context.repo || env.PR_REPO || env.GITHUB_REPOSITORY,
    'unknown/unknown',
  );
  const number = positiveInteger(options.prNumber || context.prNumber || env.PR_NUMBER || eventPr.number, 1);
  const headSha = asString(options.headSha || context.headSha || eventPr.head?.sha || env.CT_REVIEW_HEAD_SHA || env.GITHUB_SHA, 'unknown');
  const baseSha = asString(options.baseSha || eventPr.base?.sha || env.CT_REVIEW_BASE_SHA || env.GITHUB_BASE_SHA);
  const title = redactSensitiveText(
    options.title || context.title || eventPr.title || env.CT_REVIEW_PR_TITLE || 'Automated PR Review',
    500,
  );
  const url = normalizeUrl(options.url || context.url || eventPr.html_url || env.CT_REVIEW_PR_URL
    || (number ? `${asString(env.GITHUB_SERVER_URL, 'https://github.com').replace(/\/$/u, '')}/${repository}/pull/${number}` : ''));
  return { repository, number, headSha, baseSha, title, url };
}

function normalizeCounts(value = {}) {
  return {
    p0: nonNegativeInteger(value.p0 ?? value.p0Count),
    p1: nonNegativeInteger(value.p1 ?? value.p1Count),
    p2: nonNegativeInteger(value.p2 ?? value.p2Count),
  };
}

function normalizeCoverage(value = {}) {
  return {
    filesReviewed: nonNegativeInteger(value.filesReviewed ?? (Array.isArray(value.reviewed) ? value.reviewed.length : 0)),
    filesOmitted: nonNegativeInteger(value.filesOmitted ?? ((Array.isArray(value.omitted) ? value.omitted.length : 0) + (Array.isArray(value.truncated) ? value.truncated.length : 0))),
    filesSkippedGenerated: nonNegativeInteger(value.filesSkippedGenerated ?? (Array.isArray(value.skipped) ? value.skipped.length : 0)),
    passes: nonNegativeInteger(value.passes),
  };
}

function normalizeUsage(value = {}) {
  const promptTokens = nonNegativeInteger(value.promptTokens ?? value.prompt_tokens);
  const completionTokens = nonNegativeInteger(value.completionTokens ?? value.completion_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: nonNegativeInteger(value.totalTokens ?? value.total_tokens, promptTokens + completionTokens),
    costUSD: nullableCost(value.costUSD ?? value.cost_usd),
  };
}

function classifyFailure(value) {
  const text = String(value || '');
  if (/timeout|aborted|AbortError/iu.test(text)) return 'timeout';
  if (/parseable|JSON|schema|invalid/iu.test(text)) return 'invalid_response';
  if (/HTTP\s*429|rate.?limit/iu.test(text)) return 'rate_limited';
  if (/HTTP\s*5\d\d/iu.test(text)) return 'provider_unavailable';
  if (/HTTP\s*4\d\d|auth|key/iu.test(text)) return 'provider_rejected';
  return text ? 'provider_error' : undefined;
}

function normalizePersona(persona = {}) {
  const usage = normalizeUsage(persona.usage || persona);
  const decision = String(persona.decision || '').toUpperCase();
  const failureCategory = classifyFailure(persona.error || persona.failure);
  return {
    persona: redactSensitiveText(persona.persona || persona.personaId || persona.id || 'unknown', 100),
    provider: redactSensitiveText(persona.provider || 'unknown', 100),
    model: redactSensitiveText(persona.model || 'unknown', 300),
    decision: VALID_DECISIONS.has(decision) ? decision : 'ERROR',
    durationMs: nonNegativeInteger(persona.durationMs),
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    costUSD: usage.costUSD,
    ...(failureCategory ? { failureCategory } : {}),
  };
}

function findingFingerprint(repository, finding) {
  return sha256([
    normalizedRepository(repository),
    clampString(finding.path || finding.filePath, 500),
    String(finding.side || 'RIGHT').toUpperCase(),
    nonNegativeInteger(finding.line),
    String(finding.severity || '').toUpperCase(),
    clampString(finding.title, 300).toLowerCase(),
  ].join('\n'));
}

function normalizeFinding(repository, finding = {}, persona) {
  const severity = String(finding.severity || '').toUpperCase();
  const path = redactSensitiveText(finding.path || finding.filePath, 500);
  const title = redactSensitiveText(finding.title, 300);
  if (!VALID_SEVERITIES.has(severity) || !path || !title) return null;
  const side = String(finding.side || 'RIGHT').toUpperCase();
  return {
    severity,
    fingerprint: /^[a-f0-9]{64}$/u.test(finding.fingerprint || '')
      ? finding.fingerprint
      : findingFingerprint(repository, { ...finding, severity, path, title, side }),
    persona: redactSensitiveText(finding.persona || finding.personaId || persona || 'unknown', 100),
    path,
    side: VALID_SIDES.has(side) ? side : 'RIGHT',
    line: nonNegativeInteger(finding.line),
    title,
    body: redactSensitiveText(finding.body, 4_000),
    suggestion: redactSensitiveText(finding.suggestion, 4_000),
    ...(finding.githubUrl ? { githubUrl: normalizeUrl(finding.githubUrl) } : {}),
  };
}

function normalizeArbitration(value = {}, personas = []) {
  const thresholds = isObject(value.thresholds) ? value.thresholds : {};
  const publication = value.publication || value.publicationCounts;
  const mergeEligible = Boolean(value.mergeEligible);
  const gateDecision = String(value.gateDecision || (mergeEligible ? 'PASS' : 'BLOCKED')).toUpperCase();
  const lanes = Array.isArray(personas) ? personas : [];
  const output = {
    algorithmVersion: redactSensitiveText(value.algorithmVersion || 'review-arbitration-v1', 100),
    expectedPersonas: (Array.isArray(value.expectedPersonas) ? value.expectedPersonas : lanes.map((persona) => persona.persona || persona.personaId)).filter(Boolean).map((item) => redactSensitiveText(item, 100)),
    completedPersonas: (Array.isArray(value.completedPersonas)
      ? value.completedPersonas
      : lanes.filter((persona) => persona.decision !== 'ERROR').map((persona) => persona.persona || persona.personaId)).filter(Boolean).map((item) => redactSensitiveText(item, 100)),
    quorumSatisfied: Boolean(value.quorumSatisfied),
    coverageQuorumSatisfied: Boolean(value.coverageQuorumSatisfied),
    gateDecision: VALID_GATE_DECISIONS.has(gateDecision) ? gateDecision : 'BLOCKED',
    mergeEligible,
    thresholds: {
      blockP1: nonNegativeInteger(thresholds.blockP1 ?? value.blockP1),
      fixP2: nonNegativeInteger(thresholds.fixP2 ?? value.fixP2),
    },
  };
  if (isObject(publication)) {
    output.publication = {
      publishedFindings: nonNegativeInteger(publication.publishedFindings),
      rejectedFindings: nonNegativeInteger(publication.rejectedFindings),
    };
  }
  return output;
}

function buildReviewEvent(options = {}, env = process.env) {
  const now = Date.now();
  const pr = extractPullRequest(options, env);
  // The pipeline also constructs a final event for local/synthetic runs that intentionally have
  // no GitHub PR number. Keep that existing path non-throwing; real Action runs provide the
  // immutable coordinates above, while the fallback still satisfies the transport schema.
  const workflow = workflowFrom(options, env, pr.repository, pr.number);
  const reviewInput = isObject(options.review) ? options.review : {};
  const arbitrationInput = options.arbitration || reviewInput.arbitration;
  const statusValue = options.status || reviewInput.status || (arbitrationInput ? 'completed' : 'failed');
  const status = VALID_STATUSES.has(statusValue) ? statusValue : 'failed';
  const startedAtMs = timestampMs(options.startedAt || reviewInput.startedAt || options.startedAtMs, now);
  const completedAtMs = timestampMs(options.completedAt || reviewInput.completedAt || options.completedAtMs, now);
  const startedAt = toIso(startedAtMs, now);
  const completedAt = toIso(completedAtMs, now);
  const sourcePersonas = options.personas || reviewInput.personas || options.personaResults || [];
  const personas = Array.isArray(sourcePersonas) ? sourcePersonas.map(normalizePersona) : [];
  const sourceFindings = options.findings || reviewInput.findings
    || [
      ...(Array.isArray(options.personaResults) ? options.personaResults.flatMap((lane) => (lane.findings || []).map((finding) => ({ ...finding, persona: finding.persona || lane.personaId }))) : []),
      ...(Array.isArray(arbitrationInput?.findings) ? arbitrationInput.findings.map((finding) => ({ ...finding, persona: finding.persona || 'carried' })) : []),
    ];
  const includeFindings = options.detail !== 'metrics';
  const findings = includeFindings && Array.isArray(sourceFindings)
    ? [...new Map(sourceFindings.map((finding) => normalizeFinding(pr.repository, finding, finding.persona)).filter(Boolean).map((finding) => [finding.fingerprint, finding])).values()]
    : undefined;
  const enforcementMode = reviewInput.enforcement?.mode || options.enforcement?.mode || options.enforcementMode || env.CT_REVIEW_ENFORCEMENT_MODE;
  const usage = normalizeUsage(options.usage || reviewInput.usage || {});
  const severityCounts = normalizeCounts(options.severityCounts || reviewInput.severityCounts || arbitrationInput?.metrics || {});
  const coverage = normalizeCoverage(options.coverage || reviewInput.coverage || {});
  const event = {
    schemaVersion: SCHEMA_VERSION,
    eventId: createReviewEventId({
      repository: pr.repository,
      prNumber: pr.number,
      headSha: pr.headSha,
      runId: workflow.runId,
      runAttempt: workflow.runAttempt,
    }),
    eventType: status === 'failed' ? 'review.failed' : 'review.completed',
    occurredAt: completedAt,
    producer: {
      name: PRODUCER_NAME,
      version: redactSensitiveText(options.producerVersion || env.CT_REVIEW_VERSION || env.GITHUB_ACTION_REF || 'development', 100),
    },
    repository: {
      fullName: pr.repository,
      ...(env.GITHUB_REPOSITORY_ID ? { githubRepositoryId: redactSensitiveText(env.GITHUB_REPOSITORY_ID, 100) } : {}),
    },
    pullRequest: {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headSha: pr.headSha,
      ...(pr.baseSha ? { baseSha: pr.baseSha } : {}),
    },
    workflow,
    review: {
      status,
      ...(VALID_VERDICTS.has(reviewInput.verdict || options.verdict || arbitrationInput?.verdict)
        ? { verdict: reviewInput.verdict || options.verdict || arbitrationInput.verdict } : {}),
      ...((reviewInput.rationale || options.rationale || arbitrationInput?.rationale)
        ? { rationale: redactSensitiveText(reviewInput.rationale || options.rationale || arbitrationInput.rationale, 2_000) } : {}),
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      enforcement: { mode: VALID_ENFORCEMENT_MODES.has(enforcementMode) ? enforcementMode : 'advisory' },
      severityCounts,
      coverage,
      usage,
      ...(arbitrationInput ? {
        arbitration: normalizeArbitration({
          ...arbitrationInput,
          ...(options.publicationPlan ? {
            publication: {
              publishedFindings: nonNegativeInteger((options.publicationPlan.lineComments || []).length + (options.publicationPlan.fileComments || []).length + (options.publicationPlan.advisories || []).length),
              rejectedFindings: nonNegativeInteger((options.publicationPlan.rejected || []).length),
            },
          } : {}),
        }, personas),
      } : {}),
      personas,
      ...(findings ? { findings } : {}),
    },
  };
  return event;
}

function checkInteger(value, name, errors, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) errors.push(`${name} must be an integer >= ${minimum}`);
}

function validateReviewEvent(event) {
  const errors = [];
  if (!isObject(event)) return ['event must be an object'];
  if (event.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion must be 1.0');
  if (!new RegExp(`^${EVENT_ID_PREFIX}[a-f0-9]{40}$`, 'u').test(event.eventId || '')) errors.push('eventId is invalid');
  if (!VALID_EVENT_TYPES.has(event.eventType)) errors.push('eventType is invalid');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(event.occurredAt || '')) errors.push('occurredAt is invalid');
  if (event.producer?.name !== PRODUCER_NAME || typeof event.producer?.version !== 'string') errors.push('producer is invalid');
  if (!/^[^/]+\/[^/]+$/u.test(event.repository?.fullName || '')) errors.push('repository.fullName is invalid');
  checkInteger(event.pullRequest?.number, 'pullRequest.number', errors, 1);
  for (const field of ['title', 'url', 'headSha']) if (typeof event.pullRequest?.[field] !== 'string') errors.push(`pullRequest.${field} is required`);
  if (event.pullRequest?.baseSha !== undefined && typeof event.pullRequest.baseSha !== 'string') errors.push('pullRequest.baseSha is invalid');
  for (const field of ['runId', 'url', 'trigger']) if (typeof event.workflow?.[field] !== 'string') errors.push(`workflow.${field} is required`);
  checkInteger(event.workflow?.runAttempt, 'workflow.runAttempt', errors, 1);
  if (!VALID_STATUSES.has(event.review?.status)) errors.push('review.status is invalid');
  if (event.review?.verdict !== undefined && !VALID_VERDICTS.has(event.review.verdict)) errors.push('review.verdict is invalid');
  for (const field of ['startedAt', 'completedAt']) if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(event.review?.[field] || '')) errors.push(`review.${field} is invalid`);
  checkInteger(event.review?.durationMs, 'review.durationMs', errors);
  if (!VALID_ENFORCEMENT_MODES.has(event.review?.enforcement?.mode)) errors.push('review.enforcement.mode is invalid');
  for (const field of ['p0', 'p1', 'p2']) checkInteger(event.review?.severityCounts?.[field], `review.severityCounts.${field}`, errors);
  for (const field of ['filesReviewed', 'filesOmitted', 'filesSkippedGenerated', 'passes']) checkInteger(event.review?.coverage?.[field], `review.coverage.${field}`, errors);
  for (const field of ['promptTokens', 'completionTokens', 'totalTokens']) checkInteger(event.review?.usage?.[field], `review.usage.${field}`, errors);
  if (!(event.review?.usage?.costUSD === null || (typeof event.review?.usage?.costUSD === 'number' && event.review.usage.costUSD >= 0))) errors.push('review.usage.costUSD is invalid');
  if (!Array.isArray(event.review?.personas)) errors.push('review.personas must be an array');
  if (event.review?.arbitration) {
    const arbitration = event.review.arbitration;
    for (const field of ['algorithmVersion']) if (typeof arbitration[field] !== 'string') errors.push(`review.arbitration.${field} is required`);
    for (const field of ['expectedPersonas', 'completedPersonas']) if (!Array.isArray(arbitration[field])) errors.push(`review.arbitration.${field} is required`);
    for (const field of ['quorumSatisfied', 'coverageQuorumSatisfied', 'mergeEligible']) if (typeof arbitration[field] !== 'boolean') errors.push(`review.arbitration.${field} is required`);
    if (!VALID_GATE_DECISIONS.has(arbitration.gateDecision)) errors.push('review.arbitration.gateDecision is invalid');
    checkInteger(arbitration.thresholds?.blockP1, 'review.arbitration.thresholds.blockP1', errors);
    checkInteger(arbitration.thresholds?.fixP2, 'review.arbitration.thresholds.fixP2', errors);
  }
  return errors;
}

function markReviewEventFailed(event, completedAt = Date.now()) {
  const completedAtMs = timestampMs(completedAt, Date.now());
  const startedAtMs = Date.parse(event?.review?.startedAt || '');
  const completedAtIso = new Date(completedAtMs).toISOString();
  return {
    ...event,
    eventType: 'review.failed',
    occurredAt: completedAtIso,
    review: {
      ...event.review,
      status: 'failed',
      completedAt: completedAtIso,
      durationMs: Number.isFinite(startedAtMs) ? Math.max(0, completedAtMs - startedAtMs) : event.review.durationMs,
    },
  };
}

function log(logger, level, message) {
  const target = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : console[level].bind(console);
  target(message);
}

function timeoutValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(parsed)));
}

function retryDelay(attempt, value) {
  const configured = Number(value);
  const base = Number.isFinite(configured) && configured >= 0 ? Math.min(1_000, configured) : 100;
  return Math.min(1_000, base * (2 ** (attempt - 1)));
}

function successStatus(status) {
  if (status === 200) return 'duplicate';
  return 'accepted';
}

function reviewUrlForRun(siteUrl, reviewRunId) {
  if (!asString(reviewRunId)) return undefined;
  try {
    const parsed = new URL(asString(siteUrl) || DEFAULT_SITE_URL);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    parsed.pathname = `${parsed.pathname.replace(/\/$/u, '')}/dashboard/reviews/${encodeURIComponent(asString(reviewRunId))}`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return undefined;
  }
}

/**
 * Delivers one already-built event. Every failure is converted to a result and a safe log line;
 * this function never throws and never exposes the credential or response body.
 */
async function deliverReviewEvent({ event, apiKey, url, apiUrl, siteUrl, fetchImpl, fetchImplementation, logger = console, wait, timeoutMs, retryDelayMs } = {}) {
  const credential = asString(apiKey);
  const configuredUrl = asString(url || apiUrl);
  if (!credential || !configuredUrl) {
    log(logger, 'warn', '[Review Yeti dashboard] Telemetry skipped: dashboard URL and API key are required.');
    return { status: 'disabled', attempts: 0 };
  }
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(configuredUrl);
    if (!['http:', 'https:'].includes(parsedEndpoint.protocol) || parsedEndpoint.username || parsedEndpoint.password) {
      throw new Error('unsupported endpoint');
    }
    // Preserve the pre-v1.1 base-URL compatibility surface only for the legacy apiUrl alias.
    // The new dashboard-api-url input is a full endpoint and is posted to exactly as configured.
    if (!url && apiUrl && !parsedEndpoint.pathname.endsWith('/api/v1/review-events')) {
      parsedEndpoint.pathname = `${parsedEndpoint.pathname.replace(/\/$/u, '')}/api/v1/review-events`;
      parsedEndpoint.search = '';
      parsedEndpoint.hash = '';
    }
  } catch (_) {
    log(logger, 'warn', '[Review Yeti dashboard] Telemetry skipped: dashboard URL is invalid.');
    return { status: 'skipped', attempts: 0 };
  }
  const requestFetch = fetchImpl || fetchImplementation || globalThis.fetch;
  if (typeof requestFetch !== 'function') {
    log(logger, 'warn', '[Review Yeti dashboard] Telemetry delivery unavailable; review outcome is unchanged.');
    return { status: 'failed', attempts: 0, reason: 'fetch unavailable' };
  }
  let payload;
  try {
    payload = JSON.stringify(event);
  } catch (_) {
    log(logger, 'warn', '[Review Yeti dashboard] Telemetry delivery skipped: event could not be serialized.');
    return { status: 'failed', attempts: 0, reason: 'serialization failed' };
  }
  const boundedTimeoutMs = timeoutValue(timeoutMs);
  const pause = wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const eventId = asString(event?.eventId);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    let timer;
    try {
      timer = setTimeout(() => controller.abort(), boundedTimeoutMs);
      const response = await requestFetch(parsedEndpoint.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
          ...(eventId ? { 'Idempotency-Key': eventId } : {}),
        },
        body: payload,
        signal: controller.signal,
      });
      const status = Number(response?.status || 0);
      if (status >= 200 && status < 300) {
        let body = {};
        if (typeof response?.json === 'function') {
          try { body = await response.json(); } catch (_) { body = {}; }
        }
        const reviewRunId = asString(body?.reviewRunId);
        const result = {
          status: successStatus(status),
          attempts: attempt,
          ...(reviewRunId ? {
            reviewRunId,
            reviewUrl: reviewUrlForRun(siteUrl, reviewRunId),
          } : {}),
        };
        if (!result.reviewUrl) delete result.reviewUrl;
        log(logger, 'info', `[Review Yeti dashboard] Telemetry ${result.status} (HTTP ${status}) after ${attempt} attempt(s).`);
        return result;
      }
      const transient = RETRYABLE_STATUSES.has(status) || status >= 500;
      if (!transient || attempt === MAX_ATTEMPTS) {
        log(logger, 'warn', `[Review Yeti dashboard] Telemetry delivery failed with HTTP ${status || 'unknown'} after ${attempt} attempt(s); review outcome is unchanged.`);
        return { status: 'failed', attempts: attempt, reason: status ? `HTTP ${status}` : 'network error' };
      }
    } catch (error) {
      const timedOut = controller.signal.aborted;
      if (attempt === MAX_ATTEMPTS) {
        log(logger, 'warn', `[Review Yeti dashboard] Telemetry delivery failed after ${attempt} attempt(s) (${timedOut ? 'timeout' : 'network error'}); review outcome is unchanged.`);
        return { status: 'failed', attempts: attempt, reason: timedOut ? 'timeout' : 'network error' };
      }
    } finally {
      clearTimeout(timer);
    }
    await pause(retryDelay(attempt, retryDelayMs));
  }
  return { status: 'failed', attempts: MAX_ATTEMPTS, reason: 'delivery exhausted' };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_API_URL,
  DEFAULT_SITE_URL,
  EVENT_ID_PREFIX,
  MAX_ATTEMPTS,
  PRODUCER_NAME,
  SCHEMA_VERSION,
  buildReviewEvent,
  classifyFailure,
  createEventId,
  createReviewEventId,
  deliverReviewEvent,
  findingFingerprint,
  markReviewEventFailed,
  normalizeArbitration,
  normalizeUsage,
  redactSensitiveText,
  reviewUrlForRun,
  validateReviewEvent,
};
