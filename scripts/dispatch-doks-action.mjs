#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DOKS_OIDC_AUDIENCE = 'review-yeti-doks-dispatch';
export const DOKS_DISPATCH_ENDPOINT = 'https://review-bot.calltelemetry.com/api/dispatch/action';

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const RUN_ID_PATTERN = /^run_[a-f0-9]{16,64}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SUPPORTED_EVENTS = new Set(['pull_request', 'pull_request_target', 'workflow_dispatch']);

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
  if (url.protocol !== 'https:' || url.hostname !== 'token.actions.githubusercontent.com' || url.username || url.password || url.hash) {
    throw new Error('GitHub Actions OIDC request URL is invalid; grant permissions: id-token: write');
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
    requestedAt: new Date().toISOString(),
    caller: {
      runId,
      runAttempt,
      eventName,
      ...(environment.GITHUB_WORKFLOW_REF ? { workflowRef: String(environment.GITHUB_WORKFLOW_REF) } : {}),
      ...(workflowSha ? { workflowSha } : {}),
    },
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

async function requestOidcToken(environment, fetchImpl) {
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
  const response = await fetchImpl(requestUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${requestToken}` },
    signal: AbortSignal.timeout(10_000),
  });
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

export async function dispatchAction(environment = process.env, fetchImpl = fetch) {
  const endpoint = validateDispatchEndpoint(required(environment, 'DOKS_DISPATCH_URL'));
  const request = buildDispatchRequest(environment);
  const oidcToken = await requestOidcToken(environment, fetchImpl);
  const response = await fetchImpl(endpoint.href, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oidcToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 202) throw new Error(`DOKS dispatch failed with HTTP ${response.status}`);
  return validateReceipt(await json(response, 'DOKS dispatch'));
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
