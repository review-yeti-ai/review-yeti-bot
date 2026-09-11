#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DOKS_OIDC_AUDIENCE = 'review-yeti-doks-dispatch';
export const DOKS_DISPATCH_ENDPOINT = 'https://review-bot.calltelemetry.com/api/dispatch/action';
const GITHUB_ACTIONS_OIDC_REQUEST_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.actions\.githubusercontent\.com$/u;

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const RUN_ID_PATTERN = /^run_[a-f0-9]{16,64}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
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

function sha(environment, name) {
  const value = required(environment, name).toLowerCase();
  if (!SHA_PATTERN.test(value)) throw new Error(`${name.replaceAll('_', ' ').toLowerCase()} must be an exact 40-hex commit SHA`);
  return value;
}

export function validateDispatchEndpoint(raw) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    throw new Error('DOKS dispatch endpoint is not a valid URL');
  }
  const expected = new URL(DOKS_DISPATCH_ENDPOINT);
  const valid = url.protocol === 'https:'
    && url.origin === expected.origin
    && url.pathname === expected.pathname
    && url.username === ''
    && url.password === ''
    && url.search === ''
    && url.hash === '';
  if (!valid) throw new Error(`DOKS dispatch endpoint must be exactly ${DOKS_DISPATCH_ENDPOINT}`);
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
  if (publishMode !== 'disabled' && publishMode !== 'app-gate') {
    throw new Error('DOKS publish mode must be disabled or app-gate');
  }
  const refreshRequestedRaw = String(environment.REFRESH_REQUESTED ?? '').trim().toLowerCase();
  if (refreshRequestedRaw !== '' && refreshRequestedRaw !== 'false' && refreshRequestedRaw !== 'true') {
    throw new Error('REFRESH_REQUESTED must be true or false');
  }
  const refreshRequested = refreshRequestedRaw === 'true';
  const eventName = required(environment, 'GITHUB_EVENT_NAME');
  if (!SUPPORTED_EVENTS.has(eventName)) throw new Error(`GitHub event ${eventName} is not supported for DOKS dispatch`);

  const repositoryId = positiveInteger(environment, 'REPOSITORY_ID');
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

  const policy = (personas || maxInvestigationTurns || laneCallBudget) ? {
    ...(personas ? { personas } : {}),
    ...(maxInvestigationTurns && Number.isSafeInteger(maxInvestigationTurns) && maxInvestigationTurns > 0 ? { maxInvestigationTurns } : {}),
    ...(laneCallBudget && Number.isSafeInteger(laneCallBudget) && laneCallBudget > 0 ? { laneCallBudget } : {}),
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
    ...(refreshRequested ? { refreshRequested: true } : {}),
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

function validateReceipt(body) {
  const valid = body?.version === 'ActionDispatchAccepted.v1'
    && (body.status === 'accepted' || body.status === 'duplicate')
    && typeof body.runId === 'string'
    && RUN_ID_PATTERN.test(body.runId);
  if (!valid) throw new Error('DOKS dispatch returned an invalid acceptance receipt');
  return { version: body.version, status: body.status, runId: body.runId };
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
  const endpoint = validateDispatchEndpoint(required(environment, 'DOKS_DISPATCH_URL'));
  const request = buildDispatchRequest(environment);
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
  const valid = validateReceipt(receipt);
  appendFileSync(outputPath, [
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
  ].join('\n'), { encoding: 'utf8' });
}

async function main() {
  try {
    const receipt = await dispatchAction(process.env, fetch);
    writeDispatchOutputs(required(process.env, 'GITHUB_OUTPUT'), receipt);
    process.stdout.write(`DOKS dispatch ${receipt.status}: ${receipt.runId}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::${message.replaceAll('\n', ' ')}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
