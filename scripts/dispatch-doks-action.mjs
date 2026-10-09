#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DOKS_OIDC_AUDIENCE = 'review-yeti-doks-dispatch';
export const DOKS_DISPATCH_PATH = '/api/dispatch/action';
export const QUALIFICATION_DOKS_DISPATCH_PATH = '/api/qualification/dispatch/action';
const GITHUB_ACTIONS_OIDC_REQUEST_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.actions\.githubusercontent\.com$/u;

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const RUN_ID_PATTERN = /^run_[a-f0-9]{16,64}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const QUALIFICATION_REPOSITORY = 'review-yeti-ai/review-yeti-qualification';
const QUALIFICATION_REPOSITORY_ID = 1_409_547_157;
const QUALIFICATION_RUNTIME_IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const QUALIFICATION_DISPATCH_ORIGIN_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SUPPORTED_EVENTS = new Set(['pull_request', 'pull_request_target', 'workflow_dispatch', 'repository_dispatch']);
const DISPATCH_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000]);
const RETRYABLE_DISPATCH_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function required(environment, name, hint = '') {
  const value = String(environment[name] || '').trim();
  if (!value) throw new Error(`${name} is required${hint ? `; ${hint}` : ''}`);
  return value;
}

function positiveInteger(environment, name) {
  const raw = required(environment, name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseExpectedGeneration(environment) {
  const raw = String(environment.EXPECTED_GENERATION || '').trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Expected generation must be a positive integer');
  }
  return value;
}

function sha(environment, name) {
  const value = required(environment, name).toLowerCase();
  if (!SHA_PATTERN.test(value)) throw new Error(`${name.replaceAll('_', ' ').toLowerCase()} must be an exact 40-hex commit SHA`);
  return value;
}

/**
 * The admission endpoint is supplied by a trusted base-owned workflow. Both routes
 * are validated structurally: HTTPS, a DNS hostname (no IP literal, single-label
 * name, or localhost), an exact path, and no credentials, query, or fragment. The
 * qualification route additionally matches an origin digest emitted by the trusted
 * central validator, the exact target repository, app-gate mode, and image digest.
 * The service independently checks the same digest and OIDC identity.
 */
export function validateDispatchEndpoint(raw, requestContext) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    throw new Error('DOKS dispatch endpoint is not a valid URL');
  }
  const host = url.hostname.toLowerCase();
  const isIpLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.startsWith('[');
  const qualificationIdentity = requestContext?.repositoryId === QUALIFICATION_REPOSITORY_ID
    && requestContext.owner === 'review-yeti-ai'
    && requestContext.repo === 'review-yeti-qualification'
    && requestContext.publishMode === 'app-gate'
    && QUALIFICATION_RUNTIME_IMAGE_DIGEST_PATTERN.test(requestContext.qualificationRuntimeImageDigest || '');
  const qualificationNameClaimed = requestContext?.owner === 'review-yeti-ai'
    && requestContext.repo === 'review-yeti-qualification';
  const qualificationIdClaimed = requestContext?.repositoryId === QUALIFICATION_REPOSITORY_ID;
  const qualificationClaimed = qualificationNameClaimed || qualificationIdClaimed;
  if (qualificationClaimed
    && !QUALIFICATION_RUNTIME_IMAGE_DIGEST_PATTERN.test(requestContext?.qualificationRuntimeImageDigest || '')) {
    throw new Error('Qualification runtime image digest is required for the isolated endpoint');
  }
  if (qualificationClaimed
    && !QUALIFICATION_DISPATCH_ORIGIN_SHA256_PATTERN.test(requestContext?.qualificationDispatchOriginSha256 || '')) {
    throw new Error('Qualification dispatch origin digest is required for the isolated endpoint');
  }
  const qualificationPath = url.pathname === QUALIFICATION_DOKS_DISPATCH_PATH;
  if (qualificationClaimed && !qualificationIdentity) {
    throw new Error('Qualification endpoint requires the exact qualification target and image digest');
  }
  if (qualificationIdentity && !qualificationPath) {
    throw new Error(`Qualification target must use ${QUALIFICATION_DOKS_DISPATCH_PATH}`);
  }
  if (qualificationPath && !qualificationIdentity) {
    throw new Error('Qualification endpoint requires the exact qualification target and image digest');
  }
  const valid = url.protocol === 'https:'
    && url.port === ''
    && host.includes('.')
    && !isIpLiteral
    && host !== 'localhost'
    && !host.endsWith('.localhost')
    && (qualificationPath || url.pathname === DOKS_DISPATCH_PATH)
    && url.username === ''
    && url.password === ''
    && url.search === ''
    && url.hash === '';
  if (!valid) throw new Error(`DOKS dispatch endpoint must be an https URL with a DNS hostname and the exact path ${DOKS_DISPATCH_PATH}`);
  if (qualificationPath) {
    const originSha256 = createHash('sha256').update(url.origin).digest('hex');
    if (originSha256 !== requestContext.qualificationDispatchOriginSha256) {
      throw new Error('Qualification endpoint origin digest does not match the trusted central origin');
    }
  }
  return url;
}

function validateOidcRequestUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    throw new Error('GitHub Actions OIDC request URL is invalid; grant permissions: id-token: write');
  }
  if (url.protocol !== 'https:' || !GITHUB_ACTIONS_OIDC_REQUEST_HOST_PATTERN.test(url.hostname) || url.username || url.password || url.hash) {
    throw new Error(`GitHub Actions OIDC request URL is invalid for host ${url.hostname || '<empty>'}; grant permissions: id-token: write`);
  }
  return url;
}

export function buildDispatchRequest(environment) {
  const repository = required(environment, 'REPOSITORY');
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error('REPOSITORY must be owner/name');
  const [owner, repo] = repository.split('/');
  const publishMode = String(environment.DOKS_PUBLISH_MODE || 'disabled').trim();
  const qualificationRuntimeImageDigestRaw = String(environment.QUALIFICATION_RUNTIME_IMAGE_DIGEST ?? '');
  const qualificationRuntimeImageDigest = qualificationRuntimeImageDigestRaw.trim();
  if (qualificationRuntimeImageDigestRaw !== qualificationRuntimeImageDigest
    || (qualificationRuntimeImageDigest && !QUALIFICATION_RUNTIME_IMAGE_DIGEST_PATTERN.test(qualificationRuntimeImageDigest))) {
    throw new Error('Qualification runtime image digest must be exactly sha256:<64 lowercase hex>');
  }
  if (qualificationRuntimeImageDigest && (repository !== QUALIFICATION_REPOSITORY
    || publishMode !== 'app-gate')) {
    throw new Error('Qualification runtime image digest is allowed only for the exact qualification target in app-gate mode');
  }
  if (publishMode !== 'disabled' && publishMode !== 'app-gate') {
    throw new Error('DOKS publish mode must be disabled or app-gate');
  }
  const qualificationDispatchOriginSha256Raw = String(environment.QUALIFICATION_DISPATCH_ORIGIN_SHA256 ?? '');
  const qualificationDispatchOriginSha256 = qualificationDispatchOriginSha256Raw.trim();
  if (qualificationDispatchOriginSha256Raw !== qualificationDispatchOriginSha256
    || (qualificationDispatchOriginSha256 && !QUALIFICATION_DISPATCH_ORIGIN_SHA256_PATTERN.test(qualificationDispatchOriginSha256))) {
    throw new Error('Qualification dispatch origin digest must be exactly 64 lowercase hex');
  }
  if (qualificationDispatchOriginSha256 && (repository !== QUALIFICATION_REPOSITORY || publishMode !== 'app-gate')) {
    throw new Error('Qualification dispatch origin digest is allowed only for the exact qualification target in app-gate mode');
  }
  const refreshRequestedRaw = String(environment.REFRESH_REQUESTED ?? '').trim().toLowerCase();
  if (refreshRequestedRaw !== '' && refreshRequestedRaw !== 'false' && refreshRequestedRaw !== 'true') {
    throw new Error('REFRESH_REQUESTED must be true or false');
  }
  const refreshRequested = refreshRequestedRaw === 'true';
  const eventName = required(environment, 'GITHUB_EVENT_NAME');
  if (!SUPPORTED_EVENTS.has(eventName)) throw new Error(`GitHub event ${eventName} is not supported for DOKS dispatch`);
  const refreshExecutionAttemptRaw = String(environment.REFRESH_EXECUTION_ATTEMPT ?? '').trim();
  const refreshExecutionAttempt = refreshExecutionAttemptRaw ? Number(refreshExecutionAttemptRaw) : undefined;
  if (refreshExecutionAttemptRaw && (!Number.isSafeInteger(refreshExecutionAttempt) || refreshExecutionAttempt <= 0)) {
    throw new Error('REFRESH_EXECUTION_ATTEMPT must be a positive integer');
  }
  if (refreshRequested && eventName === 'repository_dispatch' && refreshExecutionAttempt === undefined) {
    throw new Error('REFRESH_EXECUTION_ATTEMPT is required for a central refresh dispatch');
  }
  const expectedGeneration = parseExpectedGeneration(environment);
  const incompleteP2Raw = String(environment.INCOMPLETE_P2_RECOVERY ?? '').trim();
  if (!['', 'false', 'true'].includes(incompleteP2Raw)) throw new Error('INCOMPLETE_P2_RECOVERY must be true or false');
  const incompleteP2Recovery = incompleteP2Raw === 'true';
  // Standalone Action script: keep this 2..3 window aligned with
  // src/review/incompleteP2RecoveryLimits.ts; actionDoksDispatch tests verify parity.
  if (incompleteP2Recovery && (!refreshRequested || publishMode !== 'app-gate'
    || !['repository_dispatch', 'workflow_dispatch'].includes(eventName)
    || expectedGeneration === undefined || expectedGeneration < 2 || expectedGeneration > 3
    || refreshExecutionAttempt !== expectedGeneration - 1)) {
    throw new Error('Incomplete P2 recovery requires a bounded exact-generation refresh');
  }

  const repositoryId = positiveInteger(environment, 'REPOSITORY_ID');
  const isQualificationRepository = repository === QUALIFICATION_REPOSITORY;
  if ((isQualificationRepository && (!qualificationRuntimeImageDigest || repositoryId !== QUALIFICATION_REPOSITORY_ID))
    || (qualificationRuntimeImageDigest && repositoryId !== QUALIFICATION_REPOSITORY_ID)) {
    throw new Error('The exact qualification target requires a qualification runtime image digest and repository ID 1409547157');
  }
  if ((isQualificationRepository && !qualificationDispatchOriginSha256)
    || (qualificationDispatchOriginSha256 && repositoryId !== QUALIFICATION_REPOSITORY_ID)) {
    throw new Error('The exact qualification target requires a central dispatch origin digest and repository ID 1409547157');
  }
  const prNumber = positiveInteger(environment, 'PR_NUMBER');
  const runId = required(environment, 'GITHUB_RUN_ID');
  const runAttempt = positiveInteger(environment, 'GITHUB_RUN_ATTEMPT');
  const headSha = sha(environment, 'HEAD_SHA');
  const baseSha = sha(environment, 'BASE_SHA');
  const actionSha = sha(environment, 'ACTION_SHA');
  const workflowSha = String(environment.GITHUB_WORKFLOW_SHA || '').trim().toLowerCase();
  if (workflowSha && !SHA_PATTERN.test(workflowSha)) throw new Error('GitHub workflow SHA must be an exact 40-hex commit SHA');

  const personas = String(environment.PERSONAS || '').trim();
  const maxInvestigationTurnsRaw = String(environment.MAX_INVESTIGATION_TURNS || '').trim();
  const laneCallBudgetRaw = String(environment.LANE_CALL_BUDGET || '').trim();
  const maxInvestigationTurns = maxInvestigationTurnsRaw ? Number(maxInvestigationTurnsRaw) : undefined;
  const laneCallBudget = laneCallBudgetRaw ? Number(laneCallBudgetRaw) : undefined;

  let extraPolicy = {};
  if (environment.POLICY_JSON && String(environment.POLICY_JSON).trim()) {
    try {
      const parsed = JSON.parse(String(environment.POLICY_JSON).trim());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('policy-json must be a valid JSON object');
      }
      extraPolicy = parsed;
      const ALLOWED_POLICY_KEYS = new Set([
        'personas',
        'maxInvestigationTurns',
        'laneCallBudget',
        'skills',
        'knowledge',
        'metrics',
        'telemetry',
        'retryAnalysis',
        'retroAnalysis',
      ]);
      for (const key of Object.keys(extraPolicy)) {
        if (!ALLOWED_POLICY_KEYS.has(key)) {
          throw new Error(`policy-json contains unauthorized key '${key}'. Allowed keys: ${Array.from(ALLOWED_POLICY_KEYS).join(', ')}`);
        }
      }
    } catch (err) {
      throw new Error(`Invalid policy-json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const parseJsonOrString = (val, fieldName, allowArray = true) => {
    if (!val) return undefined;
    const trimmed = String(val).trim();
    if (!trimmed) return undefined;
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(`Invalid JSON in ${fieldName}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!allowArray && Array.isArray(parsed)) {
        throw new Error(`${fieldName} cannot be a JSON array`);
      }
      return parsed;
    }
    return trimmed;
  };

  const skills = parseJsonOrString(environment.SKILLS || environment.POLICY_SKILLS, 'skills', true);
  const knowledge = parseJsonOrString(environment.KNOWLEDGE || environment.POLICY_KNOWLEDGE, 'knowledge', true);
  const metrics = parseJsonOrString(environment.METRICS || environment.POLICY_METRICS, 'metrics', false);
  const retryAnalysis = parseJsonOrString(environment.RETRY_ANALYSIS || environment.POLICY_RETRY_ANALYSIS, 'retryAnalysis', false);

  const policy = (personas || maxInvestigationTurns || laneCallBudget || skills || knowledge || metrics || retryAnalysis || Object.keys(extraPolicy).length > 0) ? {
    ...extraPolicy,
    ...(personas ? { personas } : {}),
    ...(maxInvestigationTurns && Number.isSafeInteger(maxInvestigationTurns) && maxInvestigationTurns > 0 ? { maxInvestigationTurns } : {}),
    ...(laneCallBudget && Number.isSafeInteger(laneCallBudget) && laneCallBudget > 0 ? { laneCallBudget } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(knowledge !== undefined ? { knowledge } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(retryAnalysis !== undefined ? { retryAnalysis } : {}),
  } : undefined;

  return {
    version: 'ActionDispatch.v1',
    deliveryId: `actions:${runId}:${runAttempt}:${repositoryId}:${prNumber}:${headSha}`,
    repositoryId,
    owner,
    repo,
    prNumber,
    headSha,
    baseSha,
    actionSha,
    publishMode,
    ...(refreshRequested ? {
      refreshRequested: true,
      ...(refreshExecutionAttempt === undefined ? {} : { refreshExecutionAttempt }),
    } : {}),
    ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
    ...(incompleteP2Recovery ? { incompleteP2Recovery: true } : {}),
    ...(qualificationRuntimeImageDigest ? { qualificationRuntimeImageDigest } : {}),
    ...(qualificationDispatchOriginSha256 ? { qualificationDispatchOriginSha256 } : {}),
    requestedAt: new Date().toISOString(),
    caller: {
      runId,
      runAttempt,
      eventName,
      ...(environment.GITHUB_WORKFLOW_REF ? { workflowRef: String(environment.GITHUB_WORKFLOW_REF) } : {}),
      ...(workflowSha ? { workflowSha } : {}),
    },
    ...(policy && Object.keys(policy).length > 0 ? { policy } : {}),
  };
}

async function json(response, description) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 65_536) throw new Error(`${description} response exceeded 65536 bytes`);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${description} returned malformed JSON`);
  }
}

/**
 * A bounded, single-line slice of a failed response body.
 *
 * The operator's 4xx says WHICH field it rejected. Discarding it turned every dispatch failure
 * into a bare status code: on 2026-09-09 a run of `HTTP 400`s blocked review across the org, and
 * the message carried nothing to act on. Worse, the text is three layers down --
 * `gh run view --log-failed` shows only post-job cleanup, and `gh api .../logs` returns 0 bytes --
 * so the one line that could have explained it was the one line thrown away.
 *
 * Never throws: this runs on a path that is already failing, and a diagnostic must not replace
 * the error it is describing.
 */
async function failureDetail(response) {
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder().decode(bytes.subarray(0, 512)).replace(/\s+/gu, ' ').trim();
    return text ? `: ${text}` : '';
  } catch {
    return '';
  }
}

async function requestOidcToken(environment, fetchImpl, sleepImpl) {
  const audience = required(environment, 'DOKS_OIDC_AUDIENCE');
  if (audience !== DOKS_OIDC_AUDIENCE) throw new Error(`DOKS OIDC audience must be ${DOKS_OIDC_AUDIENCE}`);
  const requestToken = required(
    environment,
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'grant the caller workflow permissions: id-token: write',
  );
  const requestUrl = validateOidcRequestUrl(required(
    environment,
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'grant the caller workflow permissions: id-token: write',
  ));
  requestUrl.searchParams.set('audience', DOKS_OIDC_AUDIENCE);
  const attempts = DISPATCH_RETRY_DELAYS_MS.length + 1;
  let response;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await fetchImpl(requestUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${requestToken}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const reason = compactError(error);
      if (attempt === attempts) {
        throw new Error(`GitHub Actions OIDC token request transport failed after ${attempts} attempts: ${reason}`, { cause: error });
      }
      const delayMs = DISPATCH_RETRY_DELAYS_MS[attempt - 1];
      retryWarning('GitHub Actions OIDC token request', attempt, delayMs, reason);
      await sleepImpl(delayMs);
      continue;
    }

    if (response.ok || attempt === attempts || !RETRYABLE_DISPATCH_STATUSES.has(response.status)) break;
    const delayMs = DISPATCH_RETRY_DELAYS_MS[attempt - 1];
    retryWarning('GitHub Actions OIDC token request', attempt, delayMs, `HTTP ${response.status}`);
    await sleepImpl(delayMs);
  }
  if (!response.ok) throw new Error(`GitHub Actions OIDC token request failed with HTTP ${response.status}; verify permissions: id-token: write`);
  const body = await json(response, 'GitHub Actions OIDC token request');
  if (typeof body?.value !== 'string' || body.value.length < 32) throw new Error('GitHub Actions OIDC token response did not contain a signed token');
  return body.value;
}

export function validateReceipt(body) {
  const valid = body?.version === 'ActionDispatchAccepted.v1'
    && (body.status === 'accepted' || body.status === 'duplicate')
    && typeof body.runId === 'string'
    && RUN_ID_PATTERN.test(body.runId);
  if (!valid) throw new Error('DOKS dispatch returned an invalid acceptance receipt');
  return { version: body.version, status: body.status, runId: body.runId };
}

export function parsePassthroughReceipt(body) {
  const candidateUnavailable = body?.candidateState === 'unavailable';
  const candidateStateValid = candidateUnavailable || body?.candidateState === undefined || body?.candidateState === 'current';
  const candidateCoordinatesValid = candidateUnavailable
    ? body?.headSha === null && body?.baseSha === null
    : typeof body?.headSha === 'string' && SHA_PATTERN.test(body.headSha)
      && typeof body?.baseSha === 'string' && SHA_PATTERN.test(body.baseSha);
  const publicationIdValid = typeof body?.publicationId === 'string'
    && /^[a-f0-9]{64}$/u.test(body.publicationId);
  const auditDigestValid = typeof body?.auditDigest === 'string'
    && /^[a-f0-9]{64}$/u.test(body.auditDigest);
  const receiptIdentityValid = publicationIdValid && auditDigestValid;
  const hasExplicitReceiptAvailability = body?.publicationReceiptAvailable === true
    || body?.publicationReceiptAvailable === false || body?.publicationReceiptAvailable === null;
  const legacyKnownReceipt = body?.publicationReceiptAvailable === undefined
    && ['pending', 'published', 'retiring', 'retired'].includes(body?.publicationState)
    && receiptIdentityValid;
  const publicationReceiptAvailable = hasExplicitReceiptAvailability
    ? body.publicationReceiptAvailable : legacyKnownReceipt ? true : undefined;
  const hasReceiptAvailability = hasExplicitReceiptAvailability || legacyKnownReceipt;
  const noReceiptIdentity = body?.publicationId === null && body?.auditDigest === null;
  const reviewCheckIdValid = body?.reviewCheckId === null
    || (Number.isSafeInteger(body?.reviewCheckId) && body.reviewCheckId > 0);
  const gateCheckIdValid = body?.gateCheckId === null
    || (Number.isSafeInteger(body?.gateCheckId) && body.gateCheckId > 0);
  const checkIdsAbsent = body?.reviewCheckId === null && body?.gateCheckId === null;
  const publicationStateValid = body?.publicationState === 'published'
    ? publicationReceiptAvailable === true && receiptIdentityValid && body.mergeEligible === true
      && Number.isSafeInteger(body.reviewCheckId) && body.reviewCheckId > 0
      && Number.isSafeInteger(body.gateCheckId) && body.gateCheckId > 0
    : body?.publicationState === 'unavailable'
      ? body.mergeEligible === false && checkIdsAbsent
        && (publicationReceiptAvailable === true ? receiptIdentityValid : noReceiptIdentity)
      : body?.publicationState === 'pending'
        ? publicationReceiptAvailable === true && receiptIdentityValid
          && body.mergeEligible === false && body.gateCheckId === null
        : ['retiring', 'retired'].includes(body?.publicationState)
        && publicationReceiptAvailable === true && receiptIdentityValid && body.mergeEligible === false;
  const valid = body?.version === 'ActionDispatchPassthrough.v1'
    && candidateStateValid
    && body.status === 'passthrough'
    && body.reason === 'operator_global_passthrough'
    && body.reviewStarted === false
    && typeof body.deliveryId === 'string'
    && typeof body.repositoryId === 'number'
    && Number.isSafeInteger(body.repositoryId)
    && body.repositoryId > 0
    && typeof body.owner === 'string'
    && typeof body.repo === 'string'
    && typeof body.prNumber === 'number'
    && Number.isSafeInteger(body.prNumber)
    && body.prNumber > 0
    && candidateCoordinatesValid
    && typeof body.eventName === 'string'
    && typeof body.callerKind === 'string'
    && (body.callerKind === 'direct' || body.callerKind === 'central')
    && body.verdict === 'SHIP'
    && body.expectedLanes === 0
    && body.completedLanes === 0
    && hasReceiptAvailability
    && publicationStateValid
    && reviewCheckIdValid
    && gateCheckIdValid
    && typeof body.mergeEligible === 'boolean'
    && (!candidateUnavailable || (body.publicationState === 'unavailable'
      && body.publicationReceiptAvailable === null && noReceiptIdentity && checkIdsAbsent
      && body.mergeEligible === false))
    && (publicationReceiptAvailable === true || checkIdsAbsent);
  if (!valid) throw new Error('DOKS dispatch returned an invalid passthrough receipt');
  return {
    version: body.version,
    status: body.status,
    reason: body.reason,
    reviewStarted: body.reviewStarted,
    candidateState: candidateUnavailable ? 'unavailable' : 'current',
    deliveryId: body.deliveryId,
    repositoryId: body.repositoryId,
    owner: body.owner,
    repo: body.repo,
    prNumber: body.prNumber,
    headSha: body.headSha,
    baseSha: body.baseSha,
    eventName: body.eventName,
    callerKind: body.callerKind,
    verdict: body.verdict,
    expectedLanes: body.expectedLanes,
    completedLanes: body.completedLanes,
    publicationReceiptAvailable,
    publicationId: body.publicationId,
    auditDigest: body.auditDigest,
    publicationState: body.publicationState,
    reviewCheckId: body.reviewCheckId,
    gateCheckId: body.gateCheckId,
    mergeEligible: body.mergeEligible,
  };
}

export function validatePassthroughReceipt(body, request) {
  const receipt = parsePassthroughReceipt(body);
  // The delivery identifier binds the caller run id/attempt to repository, PR and head.
  // The remaining receipt coordinates must match the exact request; eventName is the
  // caller metadata the service can return without reflecting OIDC claims to the client.
  const candidateMatches = receipt.candidateState === 'unavailable'
    || (receipt.headSha === request.headSha && receipt.baseSha === request.baseSha);
  const matchesRequest = receipt.deliveryId === request.deliveryId
    && receipt.repositoryId === request.repositoryId
    && receipt.owner === request.owner
    && receipt.repo === request.repo
    && receipt.prNumber === request.prNumber
    && candidateMatches
    && receipt.eventName === request.caller.eventName;
  if (!matchesRequest) throw new Error('DOKS dispatch returned a passthrough receipt for a different Action request');
  return receipt;
}

export function validateDispatchOutputReceipt(body) {
  if (body?.version === 'ActionDispatchAccepted.v1') return validateReceipt(body);
  if (body?.version === 'ActionDispatchPassthrough.v1') return parsePassthroughReceipt(body);
  throw new Error('DOKS dispatch returned an invalid dispatch receipt');
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function compactError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, ' ').trim().slice(0, 256) || 'unknown transport error';
}

function retryWarning(operation, attempt, delayMs, reason) {
  process.stderr.write(`::warning::${operation} attempt ${attempt} failed (${reason}); retrying in ${delayMs}ms\n`);
}

export async function dispatchAction(environment = process.env, fetchImpl = fetch, options = {}) {
  const request = buildDispatchRequest(environment);
  const endpoint = validateDispatchEndpoint(required(environment, 'DOKS_DISPATCH_URL'), request);
  const sleepImpl = options.sleep || sleep;
  const oidcToken = await requestOidcToken(environment, fetchImpl, sleepImpl);
  const requestBody = JSON.stringify(request);
  const attempts = DISPATCH_RETRY_DELAYS_MS.length + 1;

  // Every retry reuses the exact deliveryId and body. The admission API treats a repeated
  // delivery as a duplicate, so a lost response cannot create a second review run.
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(endpoint.href, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${oidcToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: requestBody,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const reason = compactError(error);
      if (attempt === attempts) {
        throw new Error(`DOKS dispatch transport failed after ${attempts} attempts: ${reason}`, { cause: error });
      }
      const delayMs = DISPATCH_RETRY_DELAYS_MS[attempt - 1];
      retryWarning('DOKS dispatch', attempt, delayMs, reason);
      await sleepImpl(delayMs);
      continue;
    }

    if (response.status === 202) return validateReceipt(await json(response, 'DOKS dispatch'));
    if (response.status === 200) return validatePassthroughReceipt(await json(response, 'DOKS passthrough'), request);
    if (attempt === attempts || !RETRYABLE_DISPATCH_STATUSES.has(response.status)) {
      throw new Error(`DOKS dispatch failed with HTTP ${response.status}${await failureDetail(response)}`);
    }
    const delayMs = DISPATCH_RETRY_DELAYS_MS[attempt - 1];
    retryWarning('DOKS dispatch', attempt, delayMs, `HTTP ${response.status}`);
    await sleepImpl(delayMs);
  }

  throw new Error('DOKS dispatch retry loop exhausted without a terminal result');
}

export function writeDispatchOutputs(outputPath, receipt) {
  const valid = validateDispatchOutputReceipt(receipt);
  const unavailableRationale = valid.publicationReceiptAvailable === true
    ? 'a durable publication receipt is known, but its official check status could not be confirmed'
    : valid.publicationReceiptAvailable === false
      ? 'no durable publication receipt is available'
      : 'durable publication receipt availability could not be confirmed';
  const lines = valid.version === 'ActionDispatchPassthrough.v1'
    ? [
      'verdict=SHIP',
      'findings-count=0',
      `review-status=${valid.candidateState === 'unavailable' ? 'OPERATOR_AUTHORITY_UNAVAILABLE'
        : valid.publicationState === 'unavailable' ? 'OPERATOR_EXEMPTION_UNAVAILABLE'
        : valid.publicationState === 'published' ? 'OPERATOR_EXEMPTION_PUBLISHED' : 'OPERATOR_EXEMPTION_PENDING'}`,
      'gate-decision=SHIP_OPERATOR_EXEMPTION',
      `merge-eligible=${valid.mergeEligible}`,
      'total-findings=0',
      'p0-count=0',
      'p1-count=0',
      'p2-count=0',
      valid.candidateState === 'unavailable'
        ? 'rationale=Operator pause yields logical SHIP with zero review lanes; current candidate and policy authority are unavailable; durable publication receipt is unknown; protected merge eligibility is false.'
        : valid.publicationState === 'unavailable'
        ? `rationale=Operator pause authorizes SHIP with zero review lanes; official check publication is unavailable; ${unavailableRationale}; protected merge eligibility is false.`
        : `rationale=Operator pause authorized a SHIP exemption for ${valid.owner}/${valid.repo}#${valid.prNumber} at ${valid.headSha}; 0 review lanes ran; publication ${valid.publicationState}; audit ${valid.auditDigest}.`,
      '',
    ]
    : [
      'verdict=NO_VERDICT',
      'findings-count=0',
      'review-status=DISPATCHED',
      'gate-decision=PENDING',
      'merge-eligible=false',
      'total-findings=0',
      'p0-count=0',
      'p1-count=0',
      'p2-count=0',
      `rationale=Durably admitted as ${valid.runId} (${valid.status}); awaiting the Review Yeti App gate.`,
      '',
    ];
  appendFileSync(outputPath, lines.join('\n'), { encoding: 'utf8' });
}

async function main() {
  try {
    const receipt = await dispatchAction(process.env, fetch);
    writeDispatchOutputs(required(process.env, 'GITHUB_OUTPUT'), receipt);
    process.stdout.write(receipt.version === 'ActionDispatchPassthrough.v1'
      ? `DOKS dispatch ${receipt.status}: no review started (${receipt.reason}).\n`
      : `DOKS dispatch ${receipt.status}: ${receipt.runId}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::${message.replaceAll('\n', ' ')}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
