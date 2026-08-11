'use strict';

const { canonicalJson, sha256 } = require('./reviewCore');
const {
  createEvidenceReceipt,
  normalizeInvestigationLimits,
  EVIDENCE_TOOLS,
} = require('./evidenceContracts');

const REASON_CODES = new Set([
  'disabled', 'call_budget_exhausted', 'file_not_in_snapshot', 'invalid file path',
  'invalid ref', 'paths_required', 'cancelled', 'blob_fetch_failed', 'blob_sha_mismatch',
  'blob_response_too_large', 'request_timeout', 'tool_not_registered', 'result_too_large',
  'invalid line range', 'invalid path query', 'invalid code query', 'navigation_snapshot_unavailable',
]);

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function copyBounded(value, depth = 0) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 4_000);
  if (depth > 4) return '[bounded]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => copyBounded(item, depth + 1));
  return Object.fromEntries(Object.keys(value).sort().slice(0, 80).map((key) => [key, copyBounded(value[key], depth + 1)]));
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function boundUntrustedResult(result, maxBytes) {
  const source = safeObject(result);
  let bounded = copyBounded(source);
  let bytes = serializedBytes(bounded);
  if (bytes <= maxBytes) return bounded;

  // Keep the response useful to the next model turn while progressively removing only
  // untrusted text. Receipts never receive this object, only its digest and metadata.
  const textKeys = ['content', 'patch', 'text', 'body', 'reason'];
  for (let pass = 0; pass < 12 && bytes > maxBytes; pass += 1) {
    let changed = false;
    for (const key of textKeys) {
      if (typeof bounded[key] === 'string' && bounded[key].length > 16) {
        bounded[key] = bounded[key].slice(0, Math.max(16, Math.floor(bounded[key].length / 2)));
        changed = true;
        bytes = serializedBytes(bounded);
        if (bytes <= maxBytes) break;
      }
    }
    if (!changed) break;
  }
  if (bytes > maxBytes) {
    bounded = {
      status: String(source.status || 'unavailable'),
      truncated: true,
      byteCount: Math.min(maxBytes, Number(source.byteCount) || maxBytes),
      reason: 'result_too_large',
    };
  } else if (bytes < serializedBytes(source)) {
    bounded.truncated = true;
  }
  return bounded;
}

function normalizedCallKey(request) {
  return sha256(canonicalJson({ tool: request.tool, args: request.args || {} }));
}

function normalizeRequest(request) {
  const row = safeObject(request);
  const tool = String(row.tool || '').trim();
  const riskId = String(row.riskId || row.risk_id || '').trim();
  const personaId = String(row.personaId || row.persona_id || '').trim();
  if (!EVIDENCE_TOOLS.has(tool)) throw new TypeError(`evidence tool is not allowlisted: ${tool}`);
  if (!riskId || !personaId) throw new TypeError('evidence request requires personaId and riskId');
  return { ...row, tool, riskId, personaId, args: safeObject(row.args) };
}

function createEvidenceRuntime({ identity, registry, limits = {}, clock = () => Date.now() } = {}) {
  if (!registry || typeof registry.call !== 'function') throw new TypeError('evidence runtime requires a tool registry');
  const effectiveLimits = normalizeInvestigationLimits(limits);
  const callCounts = new Map();
  const receiptRows = [];

  async function execute(requests, { signal } = {}) {
    const outputs = [];
    for (const rawRequest of Array.isArray(requests) ? requests : []) {
      if (signal?.aborted) return { complete: false, termination: 'cancelled', outputs };
      const request = normalizeRequest(rawRequest);
      if (request.tool === 'file_read') {
        const startLine = Number(request.args.startLine);
        const endLine = Number(request.args.endLine);
        if (Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine) && endLine >= startLine) {
          request.args = { ...request.args, endLine: Math.min(endLine, startLine + effectiveLimits.maxReadLines - 1) };
        }
      }
      const key = normalizedCallKey(request);
      const repeated = (callCounts.get(key) || 0) + 1;
      if (repeated > effectiveLimits.maxRepeatedCalls) return { complete: false, termination: 'repeated_call', outputs };
      if (receiptRows.length >= effectiveLimits.maxCalls) return { complete: false, termination: 'budget_exhausted', outputs };
      callCounts.set(key, repeated);
      const startedAt = Number(clock());
      let result;
      try {
        result = await registry.call(request.tool, request.args, { signal });
      } catch (error) {
        result = { status: 'unavailable', reason: 'tool_not_registered' };
      }
      const bounded = boundUntrustedResult(result, effectiveLimits.maxResultBytes);
      const receiptResult = { ...bounded };
      if (receiptResult.reason && !REASON_CODES.has(String(receiptResult.reason))) delete receiptResult.reason;
      const receipt = createEvidenceReceipt({
        identity,
        request,
        result: receiptResult,
        latencyMs: Math.max(0, Number(clock()) - startedAt),
      });
      receiptRows.push(receipt);
      outputs.push({ receiptId: receipt.id, riskId: request.riskId, tool: request.tool, result: bounded });
      if (bounded.status === 'cancelled') return { complete: false, termination: 'cancelled', outputs };
      // Soft-fail: monorepos often cannot serve every requested path (snapshot is
      // intentionally capped). Returning unresolved_evidence here aborted the whole
      // persona lane (ERROR → BLOCK) even when the model only needed a related file.
      // Deliver the unavailable/invalid receipt and let the model disposition risks.
    }
    return { complete: true, termination: 'continue', outputs };
  }

  return Object.freeze({
    execute,
    remaining: () => Object.freeze({ calls: Math.max(0, effectiveLimits.maxCalls - receiptRows.length), maxCalls: effectiveLimits.maxCalls }),
    receipts: () => Object.freeze(receiptRows.slice()),
  });
}

module.exports = { createEvidenceRuntime, boundUntrustedResult, normalizedCallKey };
