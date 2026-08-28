#!/usr/bin/env node

/**
 * Manual, non-publishing OpenRouter live proof.
 *
 * This intentionally exercises the same action-side reviewWithModel boundary as a hosted review,
 * but uses one explicit OpenRouter transport and writes only a sanitized receipt. It is not a
 * canary, scheduled monitor, or production routing change.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

try {
  require('ts-node/register/transpile-only');
} catch (_) {
  // The packaged Action already runs compiled JavaScript. Local verification may have ts-node.
}

const pipeline = require('../.github/workflows/pipelines/review-pipeline.js');
const { buildOpenRouterRequestOptions } = require('../.github/workflows/pipelines/openrouter-policy');
const openRouterPolicy = require('../src/config/openrouter-review-policy.json');

const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 120 * 1000;
const DEFAULT_TTFT_TIMEOUT_MS = 30 * 1000;

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function redact(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_SECRET]')
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/gi, '[REDACTED_SECRET]')
    .slice(0, 500);
}

function sanitizedAttempt(attempt) {
  return {
    attempt: attempt.attempt,
    outcome: attempt.outcome,
    transport: attempt.transport,
    provider: attempt.provider,
    latencyMs: attempt.latencyMs,
    ttftMs: attempt.ttftMs,
    responseStatus: attempt.responseStatus,
    failureClass: attempt.failureClass,
    timeoutKind: attempt.timeoutKind,
    reasoningEffort: attempt.reasoningEffort,
    maxOutputTokens: attempt.maxOutputTokens,
    outputTokens: attempt.outputTokens,
    outputShape: attempt.outputShape,
    finishReason: attempt.finishReason,
    responseMode: attempt.responseMode,
    contentPresent: attempt.contentPresent,
    reasoningPresent: attempt.reasoningPresent,
    requestFingerprint: attempt.requestFingerprint,
    generationIdDigest: attempt.generationIdDigest,
    routerMetadata: attempt.routerMetadata,
  };
}

function buildReceipt(result, config, startedAt, fixtureId) {
  const terminal = result && (result.decision === 'APPROVE' || result.decision === 'FINDINGS')
    && Array.isArray(result.responseAttempts)
    && result.responseAttempts.length > 0
    && result.responseAttempts.at(-1)?.outcome === 'parsed';
  return {
    schemaVersion: 'openrouter-live-proof-v1',
    fixtureId,
    terminal,
    terminalStatus: terminal ? 'completed' : 'failed',
    publication: 'none',
    failover: 'disabled',
    schedule: 'manual-only',
    provider: 'openrouter',
    transport: 'openrouter-live-proof',
    baseUrl: config.baseUrl,
    requestedModel: config.model,
    resolvedModel: result?.model || null,
    policyFingerprint: buildOpenRouterRequestOptions(openRouterPolicy).policyFingerprint,
    decision: result?.decision || null,
    findingsCount: Array.isArray(result?.findings) ? result.findings.length : null,
    latencyMs: result?.latencyMs ?? Date.now() - startedAt,
    ttftMs: result?.ttftMs ?? null,
    responseStatus: result?.responseStatus ?? null,
    failureClass: result?.failureClass ?? null,
    retryReasons: result?.retryReasons || [],
    recoveryAction: result?.recoveryAction ?? null,
    outputShape: result?.outputShape ?? null,
    finishReason: result?.finishReason ?? null,
    responseMode: result?.responseMode ?? 'stream',
    contentPresent: result?.contentPresent === true,
    reasoningPresent: result?.reasoningPresent === true,
    requestFingerprint: result?.requestFingerprint || null,
    generationIdDigest: result?.generationIdDigest || null,
    routerAttempt: result?.routerAttempt ?? null,
    routerMetadata: result?.routerMetadata || null,
    responseAttempts: Array.isArray(result?.responseAttempts)
      ? result.responseAttempts.map(sanitizedAttempt)
      : [],
    error: result?.error ? redact(result.error) : null,
    contract: {
      stream: true,
      ttftTimeoutMs: config.ttftTimeoutMs,
      inactivityTimeoutMs: Math.min(45_000, config.timeoutMs),
      totalTimeoutMs: config.timeoutMs,
      maxOutputTokens: config.maxOutputTokens,
      policyModel: openRouterPolicy.model,
      dataCollection: openRouterPolicy.data_collection,
      allowedModels: openRouterPolicy.allowed_models,
    },
  };
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.CT_REVIEW_OPENROUTER_API_KEY || '';
  if (!apiKey.trim()) {
    throw new Error('OPENROUTER_API_KEY is required; refusing an unauthenticated proof');
  }

  const outputPath = path.resolve(process.cwd(), argument('out', 'artifacts/openrouter-live-proof.json'));
  const model = argument('model', process.env.OPENROUTER_MODEL || 'openrouter/auto');
  const baseUrl = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const timeoutMs = positiveInteger(argument('timeout-ms', DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const ttftTimeoutMs = positiveInteger(argument('ttft-timeout-ms', DEFAULT_TTFT_TIMEOUT_MS), DEFAULT_TTFT_TIMEOUT_MS, timeoutMs);
  const fixtureId = argument('fixture', 'harmless-documentation-diff');
  const persona = pipeline.PERSONA_CHARTERS.find((candidate) => candidate.id === 'security');
  if (!persona) throw new Error('security persona is not available in the action pipeline');

  const diffFiles = [{
    path: 'README.md',
    patch: 'diff --git a/README.md b/README.md\n@@ -1,1 +1,2 @@\n Documentation\n+This line documents the review harness.\n',
    addedLines: [{ text: 'This line documents the review harness.' }],
    deletedLines: [],
  }];
  const startedAt = Date.now();
  const result = await pipeline.reviewWithModel(
    persona,
    diffFiles,
    { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 0, title: 'Manual OpenRouter live proof' },
    null,
    {
      openRouterPolicy,
      transports: [{
        name: 'openrouter-live-proof',
        provider: 'openrouter',
        compat: 'openrouter',
        baseUrl,
        apiKey,
        model,
        stream: true,
        reasoning_effort: 'high',
        timeoutMs,
        ttftTimeoutMs,
        connectTimeoutMs: Math.min(30_000, timeoutMs),
      }],
      timeoutMs,
      maxOutputTokens: 24_576,
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
    },
  );

  const receipt = buildReceipt(result, {
    baseUrl,
    model,
    timeoutMs,
    ttftTimeoutMs,
    maxOutputTokens: 24_576,
  }, startedAt, fixtureId);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    terminal: receipt.terminal,
    terminalStatus: receipt.terminalStatus,
    provider: receipt.provider,
    transport: receipt.transport,
    resolvedModel: receipt.resolvedModel,
    latencyMs: receipt.latencyMs,
    ttftMs: receipt.ttftMs,
    attempts: receipt.responseAttempts.length,
    failureClass: receipt.failureClass,
    output: outputPath,
  }));
  if (!receipt.terminal) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[openrouter-live-proof] ${redact(error?.message || error)}`);
  process.exitCode = 1;
});
