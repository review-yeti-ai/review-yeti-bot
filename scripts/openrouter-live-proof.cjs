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
const DEFAULT_FIXTURE = 'harmless-documentation-diff';

const FIXTURES = Object.freeze({
  'harmless-documentation-diff': Object.freeze({
    path: 'README.md',
    patch: 'diff --git a/README.md b/README.md\n@@ -1,1 +1,2 @@\n Documentation\n+This line documents the review harness.\n',
    addedLines: [{ text: 'This line documents the review harness.' }],
    deletedLines: [],
  }),
  'security-header-validation': Object.freeze({
    path: 'src/http/headers.js',
    patch: 'diff --git a/src/http/headers.js b/src/http/headers.js\n@@ -10,2 +10,7 @@\n export function readHeaders(request) {\n+  const authorization = request.headers.authorization || \'\';\n+  if (authorization.startsWith(\'Bearer \')) {\n+    return authorization.slice(7);\n+  }\n+  return null;\n }\n',
    addedLines: [
      { text: "  const authorization = request.headers.authorization || '';" },
      { text: "  if (authorization.startsWith('Bearer ')) {" },
      { text: '    return authorization.slice(7);' },
      { text: '  }' },
      { text: '  return null;' },
    ],
    deletedLines: [],
  }),
  'error-path-logging': Object.freeze({
    path: 'src/review/transport.js',
    patch: 'diff --git a/src/review/transport.js b/src/review/transport.js\n@@ -40,2 +40,6 @@\n export async function sendReview(request) {\n+  try {\n+    return await request.send();\n+  } catch (error) {\n+    logger.warn(\'review request failed\', error);\n+  }\n }\n',
    addedLines: [
      { text: '  try {' },
      { text: '    return await request.send();' },
      { text: '  } catch (error) {' },
      { text: "    logger.warn('review request failed', error);" },
      { text: '  }' },
    ],
    deletedLines: [],
  }),
});

function argument(name, fallback) {
  const args = process.argv.slice(2);
  const prefix = `--${name}=`;
  const inline = args.find((entry) => entry.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const position = args.indexOf(`--${name}`);
  return position >= 0 && args[position + 1] !== undefined ? args[position + 1] : fallback;
}

function fixtureIdsFromArguments() {
  const requested = argument('fixtures', argument('fixture', DEFAULT_FIXTURE));
  const ids = String(requested || DEFAULT_FIXTURE)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (ids.length === 0) ids.push(DEFAULT_FIXTURE);
  const unknown = ids.filter((id) => !Object.prototype.hasOwnProperty.call(FIXTURES, id));
  if (unknown.length > 0) {
    throw new Error(`Unknown fixture(s): ${unknown.join(', ')}. Allowed: ${Object.keys(FIXTURES).join(', ')}`);
  }
  return [...new Set(ids)];
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

function buildBatchReceipt(receipts, config, startedAt) {
  const terminal = receipts.length > 0 && receipts.every((receipt) => receipt.terminal === true);
  return {
    schemaVersion: 'openrouter-live-proof-batch-v1',
    terminal,
    terminalStatus: terminal ? 'completed' : 'failed',
    publication: 'none',
    failover: 'disabled',
    schedule: 'manual-only',
    provider: 'openrouter',
    transport: 'openrouter-live-proof',
    fixtureCount: receipts.length,
    fixtureIds: receipts.map((receipt) => receipt.fixtureId),
    completedFixtures: receipts.filter((receipt) => receipt.terminal).length,
    totalLatencyMs: Date.now() - startedAt,
    policyFingerprint: buildOpenRouterRequestOptions(openRouterPolicy).policyFingerprint,
    receipts,
    contract: {
      serial: true,
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

function writeReceipt(outputPath, receipt) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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
  const fixtureIds = fixtureIdsFromArguments();
  const persona = pipeline.PERSONA_CHARTERS.find((candidate) => candidate.id === 'security');
  if (!persona) throw new Error('security persona is not available in the action pipeline');

  const config = {
    baseUrl,
    model,
    timeoutMs,
    ttftTimeoutMs,
    maxOutputTokens: 24_576,
  };
  const startedAt = Date.now();
  const receipts = [];
  for (const fixtureId of fixtureIds) {
    const diffFiles = [FIXTURES[fixtureId]];
    const fixtureStartedAt = Date.now();
    const result = await pipeline.reviewWithModel(
      persona,
      diffFiles,
      {
        repo: 'review-yeti-ai/review-yeti-bot',
        prNumber: 0,
        title: `Manual OpenRouter live proof: ${fixtureId}`,
      },
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
    receipts.push(buildReceipt(result, config, fixtureStartedAt, fixtureId));
  }
  const receipt = receipts.length === 1 ? receipts[0] : buildBatchReceipt(receipts, config, startedAt);
  writeReceipt(outputPath, receipt);
  console.log(JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    terminal: receipt.terminal,
    terminalStatus: receipt.terminalStatus,
    provider: receipt.provider,
    transport: receipt.transport,
    fixtureCount: receipt.fixtureCount || 1,
    fixtureIds: receipt.fixtureIds || [receipt.fixtureId],
    completedFixtures: receipt.completedFixtures ?? (receipt.terminal ? 1 : 0),
    resolvedModels: receipt.receipts?.map((entry) => entry.resolvedModel) || [receipt.resolvedModel],
    latencyMs: receipt.totalLatencyMs ?? receipt.latencyMs,
    output: outputPath,
  }));
  if (!receipt.terminal) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[openrouter-live-proof] ${redact(error?.message || error)}`);
  process.exitCode = 1;
});
