'use strict';

const { canonicalJson, sha256 } = require('./reviewCore');
const { reviewIdentityDigest } = require('./reviewContracts');

const DEFAULT_INVESTIGATION_LIMITS = Object.freeze({
  maxCalls: 12,
  maxReadLines: 400,
  maxSearchMatches: 50,
  maxResultBytes: 8_000,
  maxRepeatedCalls: 2,
  maxCandidateFindings: 5,
  maxVerifierCallsPerFinding: 3,
  // REL-272 (D6): bounded default dropped 4 -> 2. maxTurns is a direct multiplier on the whole
  // retry chain (turns * attempts HTTP calls per lane), so the un-wired default of 4 was silently
  // 2x the cost this action's own retry-flattening (REL-271) assumes.
  maxTurns: 2,
});
const HARD_INVESTIGATION_LIMITS = Object.freeze({
  maxCalls: 40,
  maxReadLines: 500,
  maxSearchMatches: 200,
  maxResultBytes: 16_000,
  maxRepeatedCalls: 2,
  maxCandidateFindings: 5,
  maxVerifierCallsPerFinding: 3,
  // Matches the 1-3 clamp resolveActionReviewPolicy already enforces for the same concept on
  // the legacy path.
  maxTurns: 3,
});
const EVIDENCE_TOOLS = new Set(['file_read', 'file_find', 'code_search', 'file_read_diff']);
const EVIDENCE_STATUSES = new Set(['ok', 'unavailable', 'invalid', 'cancelled']);
const TERMINATIONS = new Set([
  'completed', 'reused', 'budget_exhausted', 'provider_failure', 'timeout', 'cancelled',
  'repeated_call', 'malformed_response', 'unresolved_evidence', 'verification_incomplete',
  // REL-271: per-lane wall-clock backstop (lane-deadline-ms), distinct from an ordinary outer
  // job cancellation so the failure table shows which ceiling actually fired.
  'lane_deadline',
]);
const ID = /^[A-Za-z0-9_.:-]{1,100}$/u;

function boundedInteger(value, fallback, hardMax) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, hardMax) : fallback;
}

function normalizeInvestigationLimits(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return Object.freeze(Object.fromEntries(Object.entries(DEFAULT_INVESTIGATION_LIMITS).map(([key, fallback]) => [
    key,
    boundedInteger(source[key], fallback, HARD_INVESTIGATION_LIMITS[key]),
  ])));
}

function requiredId(value, label) {
  const id = String(value || '').trim();
  if (!ID.test(id)) throw new TypeError(`${label} must be a bounded identifier`);
  return id;
}

function boundedString(value, label, max) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw new TypeError(`${label} must be 1-${max} characters`);
  return text;
}

function createRiskPlan({ identity, personaId, items = [] } = {}) {
  const identityDigest = reviewIdentityDigest(identity);
  const persona = requiredId(personaId, 'personaId');
  if (!Array.isArray(items) || items.length > 12) throw new TypeError('risk plan items must contain at most 12 entries');
  const normalized = items.map((item, index) => {
    const row = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    const unitIds = Array.isArray(row.unitIds || row.unit_ids) ? [...new Set((row.unitIds || row.unit_ids).map((id) => requiredId(id, 'unitId')))].slice(0, 50) : [];
    const evidenceNeeded = Array.isArray(row.evidenceNeeded || row.evidence_needed)
      ? (row.evidenceNeeded || row.evidence_needed).map((value) => boundedString(value, 'evidenceNeeded', 240)).slice(0, 8)
      : [];
    const allowedTools = Array.isArray(row.allowedTools || row.allowed_tools)
      ? [...new Set((row.allowedTools || row.allowed_tools).map((tool) => String(tool).trim()))]
      : [];
    if (allowedTools.some((tool) => !EVIDENCE_TOOLS.has(tool))) throw new TypeError(`risk item ${index + 1} contains an unallowlisted tool`);
    return Object.freeze({
      id: requiredId(row.id || `risk-${index + 1}`, 'risk id'),
      unitIds,
      statement: boundedString(row.statement, 'risk statement', 400),
      evidenceNeeded,
      allowedTools,
    });
  });
  return Object.freeze({
    schemaVersion: 'review-risk-plan-v1',
    identityDigest,
    personaId: persona,
    items: Object.freeze(normalized),
    planDigest: sha256(canonicalJson(normalized)),
  });
}

function createEvidenceReceipt({ identity, request, result, latencyMs = 0 } = {}) {
  const row = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
  const output = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const tool = String(row.tool || '').trim();
  if (!EVIDENCE_TOOLS.has(tool)) throw new TypeError('evidence tool is not allowlisted');
  const status = String(output.status || 'unavailable');
  if (!EVIDENCE_STATUSES.has(status)) throw new TypeError('evidence status is not allowlisted');
  const payload = {
    schemaVersion: 'review-evidence-receipt-v1',
    identityDigest: reviewIdentityDigest(identity),
    personaId: requiredId(row.personaId || row.persona_id, 'personaId'),
    riskId: requiredId(row.riskId || row.risk_id, 'riskId'),
    tool,
    argumentDigest: sha256(canonicalJson(row.args || {})),
    resultDigest: sha256(canonicalJson(output)),
    status,
    truncated: output.truncated === true,
    byteCount: Math.max(0, Number(output.byteCount) || 0),
    latencyMs: Math.max(0, Number(latencyMs) || 0),
    ...(output.reason ? { reason: String(output.reason).slice(0, 120) } : {}),
  };
  return Object.freeze({ ...payload, id: `er_${sha256(canonicalJson(payload))}` });
}

function createLaneExecutionReceipt({ identity, personaId, plan, evidence = [], findings = [], termination, turns = 0, completedUnitIds = [] } = {}) {
  const normalizedTermination = String(termination || '');
  if (!TERMINATIONS.has(normalizedTermination)) throw new TypeError('lane termination is not allowlisted');
  const evidenceIds = (Array.isArray(evidence) ? evidence : []).map((row) => requiredId(row?.id, 'evidence receipt id'));
  const findingKeys = (Array.isArray(findings) ? findings : [])
    .map((row) => String(row?.findingKey || row?.finding_key || '').trim())
    .filter(Boolean)
    .slice(0, DEFAULT_INVESTIGATION_LIMITS.maxCandidateFindings);
  const payload = {
    schemaVersion: 'review-lane-execution-v1',
    identityDigest: reviewIdentityDigest(identity),
    personaId: requiredId(personaId, 'personaId'),
    planDigest: requiredId(plan?.planDigest, 'planDigest'),
    evidenceReceiptIds: [...new Set(evidenceIds)],
    findingKeys,
    completedUnitIds: [...new Set((Array.isArray(completedUnitIds) ? completedUnitIds : []).map((id) => requiredId(id, 'unitId')))].sort(),
    termination: normalizedTermination,
    turns: Math.max(0, Number(turns) || 0),
    evidenceCalls: evidenceIds.length,
    complete: normalizedTermination === 'completed' || normalizedTermination === 'reused',
  };
  return Object.freeze({ ...payload, receiptDigest: sha256(canonicalJson(payload)) });
}

function validateLaneExecutionReceipt(receipt) {
  if (!receipt || receipt.schemaVersion !== 'review-lane-execution-v1') return { valid: false, reason: 'invalid_schema' };
  const { receiptDigest, ...payload } = receipt;
  if (typeof receiptDigest !== 'string' || sha256(canonicalJson(payload)) !== receiptDigest) return { valid: false, reason: 'identity_mismatch' };
  if (!TERMINATIONS.has(receipt.termination)) return { valid: false, reason: 'invalid_termination' };
  if (!ID.test(String(receipt.personaId || '')) || !ID.test(String(receipt.planDigest || ''))) return { valid: false, reason: 'invalid_identity' };
  if (!Array.isArray(receipt.evidenceReceiptIds) || receipt.evidenceReceiptIds.some((id) => !ID.test(String(id)))) return { valid: false, reason: 'invalid_evidence_ids' };
  return { valid: true };
}

module.exports = {
  DEFAULT_INVESTIGATION_LIMITS,
  HARD_INVESTIGATION_LIMITS,
  EVIDENCE_TOOLS,
  normalizeInvestigationLimits,
  createRiskPlan,
  createEvidenceReceipt,
  createLaneExecutionReceipt,
  validateLaneExecutionReceipt,
};
