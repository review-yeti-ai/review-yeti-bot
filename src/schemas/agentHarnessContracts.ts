/**
 * Example org Agentic Harness Contracts (API-3330 & API-3333)
 * Provides 100% wire parity with example-meta/knowledge/contracts/agent-harness.v1.schema.json
 */

import * as crypto from 'crypto';
import { z } from 'zod';

export const MAX_CONTRACT_BYTES = 65_536;
export const MAX_CHECKPOINT_PROPOSALS = 5;

export type ContractErrorCode =
  | 'PAYLOAD_TOO_LARGE'
  | 'INVALID_JSON'
  | 'DUPLICATE_JSON_KEY'
  | 'UNSUPPORTED_SCHEMA'
  | 'INVALID_SHAPE'
  | 'INVALID_DEADLINE'
  | 'SELF_PARENT'
  | 'DUPLICATE_ID'
  | 'REQUEST_DRIFT'
  | 'INVALID_RECEIPT_TIME'
  | 'EFFECT_EVIDENCE_REQUIRED'
  | 'SUCCESS_EVIDENCE_REQUIRED'
  | 'UNRESOLVED_EFFECT'
  | 'INVALID_CLOCK'
  | 'AUTHORITY_DENIED'
  | 'SCOPE_MISMATCH'
  | 'PROVIDER_MISMATCH'
  | 'FENCING_MISMATCH'
  | 'AUTHORITY_EXPIRED'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_EFFECT_TRANSITION'
  | 'INVALID_EFFECT_STATE'
  | 'OWNER_EFFECT_STATE_MISMATCH'
  | 'OWNER_SCOPE_MISMATCH'
  | 'OWNER_FENCING_MISMATCH'
  | 'OWNER_EFFECT_SET_MISMATCH'
  | 'OWNER_INTENT_MISMATCH'
  | 'OWNER_EVIDENCE_MISMATCH'
  | 'OWNER_CHILD_NOT_RUNNING'
  | 'INVALID_OWNER_RECORD'
  | 'INVALID_OWNER_SNAPSHOT'
  | 'RECEIPT_MISSING'
  | 'FENCING_EPOCH_MISMATCH'
  | 'LEASE_EXPIRED';

export class ContractError extends Error {
  public readonly code: ContractErrorCode;
  constructor(code: ContractErrorCode) {
    super(code);
    this.code = code;
    this.name = 'ContractError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function requireCondition(condition: boolean, code: ContractErrorCode): asserts condition {
  if (!condition) {
    throw new ContractError(code);
  }
}

// ============================================================================
// Basic Field Schemas
// ============================================================================

export const IdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'INVALID_SHAPE')
  .max(128, 'INVALID_SHAPE');

export const DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'INVALID_SHAPE')
  .max(71, 'INVALID_SHAPE');

export const TimestampSchema = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/, 'INVALID_SHAPE')
  .max(24, 'INVALID_SHAPE')
  .refine((val) => {
    const d = new Date(val);
    return !isNaN(d.getTime()) && d.toISOString() === val;
  }, 'INVALID_SHAPE');

export const CounterSchema = z
  .number()
  .int('INVALID_SHAPE')
  .min(0, 'INVALID_SHAPE')
  .max(9007199254740991, 'INVALID_SHAPE');

export const PositiveCounterSchema = z
  .number()
  .int('INVALID_SHAPE')
  .min(1, 'INVALID_SHAPE')
  .max(9007199254740991, 'INVALID_SHAPE');

export const RepositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/, 'INVALID_SHAPE')
  .max(201, 'INVALID_SHAPE');

// ============================================================================
// Compound Schemas
// ============================================================================

export const ScopeSchema = z
  .object({
    tenant_id: IdSchema,
    environment_id: IdSchema,
    workspace_id: IdSchema,
    repository: RepositorySchema,
    mission_id: IdSchema,
    generation: PositiveCounterSchema,
    execution_id: IdSchema,
    logical_child_id: IdSchema,
    fencing_epoch: PositiveCounterSchema,
  })
  .strict('INVALID_SHAPE');

export type AgentHarnessScope = z.infer<typeof ScopeSchema>;

export const ArtifactClassificationSchema = z.enum(['synthetic', 'sanitized_internal']);
export type ArtifactClassification = z.infer<typeof ArtifactClassificationSchema>;

export const ArtifactSchema = z
  .object({
    artifact_id: IdSchema,
    digest: DigestSchema,
    classification: ArtifactClassificationSchema,
  })
  .strict('INVALID_SHAPE');

export type ArtifactRef = z.infer<typeof ArtifactSchema>;

export const CandidateEffectPhaseSchema = z.enum([
  'INTENT',
  'EXECUTING',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
  'RECONCILING',
  'MANUAL',
]);
export type CandidateEffectPhase = z.infer<typeof CandidateEffectPhaseSchema>;

export const EffectSchema = z
  .object({
    effect_id: IdSchema,
    intent_digest: DigestSchema,
    state: CandidateEffectPhaseSchema,
    evidence_ref: DigestSchema.nullable(),
  })
  .strict('INVALID_SHAPE');

export type EffectRecord = z.infer<typeof EffectSchema>;

export const LeaseSchema = z
  .object({
    lease_id: IdSchema,
    attempt: PositiveCounterSchema,
    fencing_token: PositiveCounterSchema,
  })
  .strict('INVALID_SHAPE');

export type LeaseInfo = z.infer<typeof LeaseSchema>;

export const BudgetSchema = z
  .object({
    max_cost_microusd: CounterSchema,
    max_tokens: CounterSchema,
    max_duration_ms: PositiveCounterSchema,
    concurrency_class: IdSchema,
  })
  .strict('INVALID_SHAPE');

export type BudgetConfig = z.infer<typeof BudgetSchema>;

export const MeteringSchema = z
  .object({
    cost_microusd: CounterSchema,
    tokens: CounterSchema,
  })
  .strict('INVALID_SHAPE');

export type MeteringInfo = z.infer<typeof MeteringSchema>;

export const WorkKindSchema = z.enum([
  'review',
  'investigate',
  'implement',
  'test',
  'qa',
  'research',
  'incident',
  'migration',
  'release',
  'custom',
]);
export type WorkKind = z.infer<typeof WorkKindSchema>;

// ============================================================================
// Root Wire Contract: ct-agent-work-request.v1 (18 Closed Properties)
// ============================================================================

export const WorkRequestSchema = z
  .object({
    schema: z.literal('ct-agent-work-request.v1'),
    scope: ScopeSchema,
    idempotency_key: IdSchema,
    work_kind: WorkKindSchema,
    profile_ref: DigestSchema,
    input_refs: z.array(ArtifactSchema).min(0).max(32),
    capabilities: z.array(IdSchema).min(0).max(32),
    tool_policy_ref: DigestSchema,
    model_policy_ref: DigestSchema,
    effect_policy_ref: DigestSchema,
    retention_policy_ref: DigestSchema,
    budget: BudgetSchema,
    created_at: TimestampSchema,
    deadline: TimestampSchema,
    parent_execution_id: IdSchema.nullable(),
    correlation_id: IdSchema,
    causation_id: IdSchema,
    provider_eligibility_refs: z.array(DigestSchema).min(1).max(8),
  })
  .strict('INVALID_SHAPE');

export type AgentWorkRequest = z.infer<typeof WorkRequestSchema>;

// ============================================================================
// Root Wire Contract: ct-agent-execution-receipt.v1 (12 Closed Properties)
// ============================================================================

export const ReceiptOutcomeSchema = z.enum([
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'unknown',
]);
export type ReceiptOutcome = z.infer<typeof ReceiptOutcomeSchema>;

export const ExecutionReceiptSchema = z
  .object({
    schema: z.literal('ct-agent-execution-receipt.v1'),
    scope: ScopeSchema,
    request_digest: DigestSchema,
    provider_binding_ref: DigestSchema,
    lease: LeaseSchema,
    outcome: ReceiptOutcomeSchema,
    started_at: TimestampSchema,
    observed_at: TimestampSchema,
    output_refs: z.array(ArtifactSchema).min(0).max(32),
    evidence_refs: z.array(DigestSchema).min(0).max(32),
    effects: z.array(EffectSchema).min(0).max(32),
    metering: MeteringSchema,
  })
  .strict('INVALID_SHAPE');

export type AgentExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;

// ============================================================================
// Admission Snapshot (Internal qualification schema)
// ============================================================================

export const AdmissionSnapshotSchema = z
  .object({
    scope: ScopeSchema,
    request_digest: DigestSchema,
    provider_binding_ref: DigestSchema,
    lease: LeaseSchema,
    admitted: z.boolean(),
    revoked: z.boolean(),
    lease_expires_at: TimestampSchema,
    authority_expires_at: TimestampSchema,
  })
  .strict('INVALID_SHAPE');

export type AdmissionSnapshot = z.infer<typeof AdmissionSnapshotSchema>;

// ============================================================================
// Phase Transitions & Owner Mapping
// ============================================================================

export type AuthoritativeOwnerState =
  | 'INTENDED'
  | 'IN_FLIGHT'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'UNKNOWN';

export const EFFECT_OWNER_STATES: Record<CandidateEffectPhase, AuthoritativeOwnerState> = {
  INTENT: 'INTENDED',
  EXECUTING: 'IN_FLIGHT',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
  RECONCILING: 'UNKNOWN',
  MANUAL: 'UNKNOWN',
};

export const EFFECT_EDGES: Record<CandidateEffectPhase, readonly CandidateEffectPhase[]> = {
  INTENT: ['EXECUTING'],
  EXECUTING: ['SUCCEEDED', 'FAILED', 'UNKNOWN'],
  UNKNOWN: ['RECONCILING'],
  RECONCILING: ['SUCCEEDED', 'FAILED', 'UNKNOWN', 'MANUAL'],
  SUCCEEDED: [],
  FAILED: [],
  MANUAL: [],
};

export function checkEffectTransition(
  previous: CandidateEffectPhase,
  following: CandidateEffectPhase,
  evidenceRef?: string | null
): void {
  requireCondition(typeof previous === 'string' && typeof following === 'string', 'INVALID_EFFECT_TRANSITION');
  const allowed = EFFECT_EDGES[previous];
  requireCondition(Boolean(allowed && allowed.includes(following)), 'INVALID_EFFECT_TRANSITION');
  if (following === 'SUCCEEDED' || following === 'FAILED') {
    requireCondition(
      typeof evidenceRef === 'string' && DigestSchema.safeParse(evidenceRef).success,
      'EFFECT_EVIDENCE_REQUIRED'
    );
  }
}

export function projectEffectState(state: CandidateEffectPhase): AuthoritativeOwnerState {
  requireCondition(typeof state === 'string' && state in EFFECT_OWNER_STATES, 'INVALID_EFFECT_STATE');
  return EFFECT_OWNER_STATES[state];
}

// ============================================================================
// Canonical JSON Serialization (RFC 8785) & Request Digest
// ============================================================================

export function canonicalJson(value: unknown): string {
  let nodes = 0;

  function serialize(item: unknown): string {
    nodes++;
    requireCondition(nodes <= MAX_CONTRACT_BYTES, 'PAYLOAD_TOO_LARGE');

    if (item === null) return 'null';
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'string') {
      // RFC 8785 §3.2.2.2: Strings must be valid UTF-8 and MUST NOT contain unescaped lone UTF-16 surrogates
      const wellFormed = typeof (item as any).isWellFormed === 'function'
        ? (item as any).isWellFormed()
        : !/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/.test(item);
      requireCondition(wellFormed, 'INVALID_JSON');
      return JSON.stringify(item);
    }

    if (typeof item === 'number') {
      requireCondition(Number.isSafeInteger(item), 'INVALID_JSON');
      return Object.is(item, -0) ? '0' : item.toString();
    }

    if (Array.isArray(item)) {
      // RFC 8785: Reject sparse arrays
      for (let i = 0; i < item.length; i++) {
        requireCondition(Object.prototype.hasOwnProperty.call(item, i), 'INVALID_JSON');
      }
      return '[' + item.map(serialize).join(',') + ']';
    }

    if (typeof item === 'object') {
      requireCondition(item !== null && (item.constructor === Object || Object.getPrototypeOf(item) === null), 'INVALID_JSON');
      const record = item as Record<string, unknown>;
      const keys = Object.keys(record);
      keys.sort(); // UTF-16 code unit ordering per RFC 8785
      const parts = keys.map((key) => {
        requireCondition(typeof key === 'string', 'INVALID_JSON');
        return JSON.stringify(key) + ':' + serialize(record[key]);
      });
      return '{' + parts.join(',') + '}';
    }

    throw new ContractError('INVALID_JSON');
  }

  const encoded = serialize(value);
  const buf = Buffer.from(encoded, 'utf8');
  requireCondition(buf.byteLength <= MAX_CONTRACT_BYTES, 'PAYLOAD_TOO_LARGE');
  return encoded;
}

export function canonicalJsonBuffer(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

// ============================================================================
// Wire Packet Parser with Duplicate Key and Float Guards
// ============================================================================

export function loadWireJson(raw: Buffer | Uint8Array | string): unknown {
  let buf: Buffer;
  if (typeof raw === 'string') {
    buf = Buffer.from(raw, 'utf8');
  } else if (Buffer.isBuffer(raw)) {
    buf = raw;
  } else {
    buf = Buffer.from(raw);
  }

  requireCondition(buf.byteLength <= MAX_CONTRACT_BYTES, 'PAYLOAD_TOO_LARGE');

  let str: string;
  try {
    str = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new ContractError('INVALID_JSON');
  }

  let idx = 0;

  function skipWhitespace() {
    while (idx < str.length && (str[idx] === ' ' || str[idx] === '\t' || str[idx] === '\n' || str[idx] === '\r')) {
      idx++;
    }
  }

  function parseValue(): unknown {
    skipWhitespace();
    requireCondition(idx < str.length, 'INVALID_JSON');
    const ch = str[idx];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"') return parseString();
    if (ch === 't' && str.startsWith('true', idx)) { idx += 4; return true; }
    if (ch === 'f' && str.startsWith('false', idx)) { idx += 5; return false; }
    if (ch === 'n' && str.startsWith('null', idx)) { idx += 4; return null; }
    if ((ch >= '0' && ch <= '9') || ch === '-') return parseNumber();
    throw new ContractError('INVALID_JSON');
  }

  function parseString(): string {
    const start = idx;
    idx++; // skip open quote
    while (idx < str.length) {
      if (str.charCodeAt(idx) < 0x20) {
        throw new ContractError('INVALID_JSON');
      }
      if (str[idx] === '\\') {
        idx += 2;
      } else if (str[idx] === '"') {
        idx++;
        try {
          return JSON.parse(str.slice(start, idx));
        } catch {
          throw new ContractError('INVALID_JSON');
        }
      } else {
        idx++;
      }
    }
    throw new ContractError('INVALID_JSON');
  }

  function parseObject(): Record<string, unknown> {
    idx++; // skip {
    const obj: Record<string, unknown> = Object.create(null);
    const seen = new Set<string>();
    skipWhitespace();
    if (idx < str.length && str[idx] === '}') {
      idx++;
      return obj;
    }
    while (idx < str.length) {
      skipWhitespace();
      requireCondition(idx < str.length && str[idx] === '"', 'INVALID_JSON');
      const key = parseString();
      requireCondition(!seen.has(key), 'DUPLICATE_JSON_KEY');
      seen.add(key);
      skipWhitespace();
      requireCondition(idx < str.length && str[idx] === ':', 'INVALID_JSON');
      idx++; // skip :
      const val = parseValue();
      Object.defineProperty(obj, key, {
        value: val,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      skipWhitespace();
      requireCondition(idx < str.length, 'INVALID_JSON');
      if (str[idx] === ',') {
        idx++;
      } else if (str[idx] === '}') {
        idx++;
        return obj;
      } else {
        throw new ContractError('INVALID_JSON');
      }
    }
    throw new ContractError('INVALID_JSON');
  }

  function parseArray(): unknown[] {
    idx++; // skip [
    const arr: unknown[] = [];
    skipWhitespace();
    if (idx < str.length && str[idx] === ']') {
      idx++;
      return arr;
    }
    while (idx < str.length) {
      const val = parseValue();
      arr.push(val);
      skipWhitespace();
      requireCondition(idx < str.length, 'INVALID_JSON');
      if (str[idx] === ',') {
        idx++;
      } else if (str[idx] === ']') {
        idx++;
        return arr;
      } else {
        throw new ContractError('INVALID_JSON');
      }
    }
    throw new ContractError('INVALID_JSON');
  }

  function parseNumber(): number {
    const start = idx;
    if (str[idx] === '-') idx++;
    requireCondition(idx < str.length && str[idx] >= '0' && str[idx] <= '9', 'INVALID_JSON');
    while (
      idx < str.length &&
      ((str[idx] >= '0' && str[idx] <= '9') ||
        str[idx] === '.' ||
        str[idx] === 'e' ||
        str[idx] === 'E' ||
        str[idx] === '+' ||
        str[idx] === '-')
    ) {
      idx++;
    }
    const numStr = str.slice(start, idx);
    // Reject floats or exponential formatting
    requireCondition(
      !numStr.includes('.') &&
      !numStr.includes('e') &&
      !numStr.includes('E') &&
      /^-?(0|[1-9][0-9]*)$/.test(numStr),
      'INVALID_JSON'
    );
    const num = Number(numStr);
    requireCondition(Number.isSafeInteger(num), 'INVALID_JSON');
    return num;
  }

  let packet: unknown;
  try {
    packet = parseValue();
    skipWhitespace();
    requireCondition(idx === str.length, 'INVALID_JSON');
  } catch (err) {
    if (err instanceof ContractError) throw err;
    throw new ContractError('INVALID_JSON');
  }

  canonicalJson(packet);
  return packet;
}

export function loadPacket(raw: Buffer | Uint8Array | string): AgentWorkRequest | AgentExecutionReceipt {
  const packet = loadWireJson(raw);
  requireCondition(typeof packet === 'object' && packet !== null && !Array.isArray(packet), 'INVALID_SHAPE');
  const record = packet as Record<string, unknown>;
  const schemaKind = record.schema;

  if (schemaKind === 'ct-agent-work-request.v1') {
    return validateWorkRequest(packet);
  } else if (schemaKind === 'ct-agent-execution-receipt.v1') {
    return validateExecutionReceipt(packet);
  } else {
    throw new ContractError('UNSUPPORTED_SCHEMA');
  }
}

// ============================================================================
// Semantic Validators
// ============================================================================

export function validateWorkRequest(candidate: unknown): AgentWorkRequest {
  let req: AgentWorkRequest;
  try {
    req = WorkRequestSchema.parse(candidate);
  } catch {
    throw new ContractError('INVALID_SHAPE');
  }

  // Primitive array unique checks
  requireCondition(new Set(req.capabilities).size === req.capabilities.length, 'INVALID_SHAPE');
  requireCondition(
    new Set(req.provider_eligibility_refs).size === req.provider_eligibility_refs.length,
    'INVALID_SHAPE'
  );

  // Structural uniqueItems on input_refs
  const inputSignatures = req.input_refs.map((r) => canonicalJson(r));
  requireCondition(new Set(inputSignatures).size === req.input_refs.length, 'INVALID_SHAPE');

  // Semantic guards
  requireCondition(Date.parse(req.created_at) < Date.parse(req.deadline), 'INVALID_DEADLINE');
  requireCondition(req.parent_execution_id !== req.scope.execution_id, 'SELF_PARENT');

  const artifactIds = req.input_refs.map((r) => r.artifact_id);
  requireCondition(new Set(artifactIds).size === artifactIds.length, 'DUPLICATE_ID');

  canonicalJson(req); // enforces node count and byte limits
  return req;
}

export function requestDigest(request: AgentWorkRequest): string {
  validateWorkRequest(request);
  const canon = canonicalJson(request);
  return 'sha256:' + crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

export function assertSameRequest(existing: AgentWorkRequest, candidate: AgentWorkRequest): void {
  requireCondition(requestDigest(existing) === requestDigest(candidate), 'REQUEST_DRIFT');
}

export function validateExecutionReceipt(candidate: unknown): AgentExecutionReceipt {
  let rec: AgentExecutionReceipt;
  try {
    rec = ExecutionReceiptSchema.parse(candidate);
  } catch {
    throw new ContractError('INVALID_SHAPE');
  }

  // Primitive array unique checks
  requireCondition(new Set(rec.evidence_refs).size === rec.evidence_refs.length, 'INVALID_SHAPE');

  // Structural uniqueItems on output_refs and effects
  const outputSignatures = rec.output_refs.map((r) => canonicalJson(r));
  requireCondition(new Set(outputSignatures).size === rec.output_refs.length, 'INVALID_SHAPE');
  const effectSignatures = rec.effects.map((e) => canonicalJson(e));
  requireCondition(new Set(effectSignatures).size === rec.effects.length, 'INVALID_SHAPE');

  // Semantic guards
  requireCondition(Date.parse(rec.started_at) <= Date.parse(rec.observed_at), 'INVALID_RECEIPT_TIME');

  const outputIds = rec.output_refs.map((r) => r.artifact_id);
  requireCondition(new Set(outputIds).size === outputIds.length, 'DUPLICATE_ID');

  const effectIds = rec.effects.map((e) => e.effect_id);
  requireCondition(new Set(effectIds).size === effectIds.length, 'DUPLICATE_ID');

  for (const eff of rec.effects) {
    if (eff.state === 'SUCCEEDED' || eff.state === 'FAILED') {
      requireCondition(eff.evidence_ref !== null && DigestSchema.safeParse(eff.evidence_ref).success, 'EFFECT_EVIDENCE_REQUIRED');
    }
  }

  if (rec.outcome === 'succeeded') {
    requireCondition(rec.evidence_refs.length > 0, 'SUCCESS_EVIDENCE_REQUIRED');
    requireCondition(
      rec.effects.every((eff) => eff.state === 'SUCCEEDED'),
      'UNRESOLVED_EFFECT'
    );
  }

  canonicalJson(rec);
  return rec;
}

export function checkReceiptBinding(
  request: AgentWorkRequest,
  receipt: AgentExecutionReceipt,
  current: AdmissionSnapshot,
  now: string
): void {
  validateWorkRequest(request);
  validateExecutionReceipt(receipt);

  try {
    AdmissionSnapshotSchema.parse(current);
  } catch {
    throw new ContractError('INVALID_SHAPE');
  }

  requireCondition(TimestampSchema.safeParse(now).success, 'INVALID_CLOCK');
  requireCondition(current.admitted && !current.revoked, 'AUTHORITY_DENIED');

  const reqScope = canonicalJson(request.scope);
  const recScope = canonicalJson(receipt.scope);
  const curScope = canonicalJson(current.scope);
  requireCondition(reqScope === recScope && recScope === curScope, 'SCOPE_MISMATCH');

  const digest = requestDigest(request);
  requireCondition(digest === receipt.request_digest && receipt.request_digest === current.request_digest, 'REQUEST_DRIFT');
  requireCondition(receipt.provider_binding_ref === current.provider_binding_ref, 'PROVIDER_MISMATCH');

  const recLease = canonicalJson(receipt.lease);
  const curLease = canonicalJson(current.lease);
  requireCondition(recLease === curLease, 'FENCING_MISMATCH');

  const tReqCreated = Date.parse(request.created_at);
  const tRecStarted = Date.parse(receipt.started_at);
  const tRecObserved = Date.parse(receipt.observed_at);
  const tNow = Date.parse(now);

  requireCondition(
    tReqCreated <= tRecStarted && tRecStarted <= tRecObserved && tRecObserved <= tNow,
    'INVALID_RECEIPT_TIME'
  );

  const tDeadline = Date.parse(request.deadline);
  const tLeaseExp = Date.parse(current.lease_expires_at);
  const tAuthExp = Date.parse(current.authority_expires_at);
  requireCondition(tNow < Math.min(tDeadline, tLeaseExp, tAuthExp), 'AUTHORITY_EXPIRED');

  requireCondition(
    receipt.metering.cost_microusd <= request.budget.max_cost_microusd &&
      receipt.metering.tokens <= request.budget.max_tokens,
    'BUDGET_EXCEEDED'
  );

  const elapsedMs = tRecObserved - tRecStarted;
  requireCondition(elapsedMs <= request.budget.max_duration_ms, 'BUDGET_EXCEEDED');
}

// ============================================================================
// Owner Binding Qualification
// ============================================================================

export const OWNER_SCOPE_FIELDS = ['mission_id', 'generation', 'logical_child_id', 'execution_id'] as const;

export const ChildExecutionSchema = z
  .object({
    schema: z.literal('ct-child-execution.v1'),
    mission_id: IdSchema,
    generation: PositiveCounterSchema,
    logical_child_id: IdSchema,
    execution_id: IdSchema,
    attempt: PositiveCounterSchema,
    state: z.enum([
      'REQUESTED',
      'STARTING',
      'RUNNING',
      'SUSPENDED',
      'SUCCEEDED',
      'FAILED',
      'CANCELED',
      'QUARANTINED',
    ]),
  })
  .strict('INVALID_OWNER_RECORD');

export const EffectIntentSchema = z
  .object({
    schema: z.literal('ct-effect-intent.v1'),
    effect_intent_id: IdSchema,
    mission_id: IdSchema,
    generation: PositiveCounterSchema,
    logical_child_id: IdSchema,
    execution_id: IdSchema,
    fencing_epoch: PositiveCounterSchema,
    effect_type: IdSchema,
    authority_envelope_digest: DigestSchema,
    state: z.enum(['INTENDED', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'UNKNOWN']),
    created_at: TimestampSchema.optional(),
    receipt_ref: DigestSchema.optional(),
    external_ref: z.string().optional(),
  })
  .strict('INVALID_OWNER_RECORD');

export function ownerIntentDigest(intent: Record<string, unknown>): string {
  try {
    EffectIntentSchema.parse(intent);
  } catch {
    throw new ContractError('INVALID_OWNER_RECORD');
  }
  const immutable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(intent)) {
    if (key !== 'state' && key !== 'external_ref' && key !== 'receipt_ref') {
      immutable[key] = value;
    }
  }
  return 'sha256:' + crypto.createHash('sha256').update(canonicalJson(immutable), 'utf8').digest('hex');
}

export function checkOwnedReceiptBinding(
  request: AgentWorkRequest,
  receipt: AgentExecutionReceipt,
  current: AdmissionSnapshot,
  now: string,
  owner: Record<string, unknown>
): void {
  checkReceiptBinding(request, receipt, current, now);

  requireCondition(
    typeof owner === 'object' && owner !== null && !Array.isArray(owner),
    'INVALID_OWNER_SNAPSHOT'
  );

  const ownerKeys = Object.keys(owner).sort();
  const expectedKeys = ['child_execution', 'effect_intents', 'fencing_epoch'].sort();
  requireCondition(
    ownerKeys.length === expectedKeys.length && ownerKeys.every((k, i) => k === expectedKeys[i]),
    'INVALID_OWNER_SNAPSHOT'
  );

  canonicalJson(owner);

  let child: z.infer<typeof ChildExecutionSchema>;
  try {
    child = ChildExecutionSchema.parse(owner.child_execution);
  } catch {
    throw new ContractError('INVALID_OWNER_RECORD');
  }

  requireCondition(child.state === 'RUNNING', 'OWNER_CHILD_NOT_RUNNING');
  const scope = current.scope;
  for (const field of OWNER_SCOPE_FIELDS) {
    requireCondition(child[field] === scope[field], 'OWNER_SCOPE_MISMATCH');
  }

  requireCondition(
    typeof owner.fencing_epoch === 'number' && Number.isSafeInteger(owner.fencing_epoch),
    'OWNER_FENCING_MISMATCH'
  );
  requireCondition(owner.fencing_epoch === scope.fencing_epoch, 'OWNER_FENCING_MISMATCH');

  const intents = owner.effect_intents;
  requireCondition(Array.isArray(intents), 'OWNER_EFFECT_SET_MISMATCH');
  requireCondition(intents.length <= receipt.effects.length, 'OWNER_EFFECT_SET_MISMATCH');

  const parsedIntents: Array<z.infer<typeof EffectIntentSchema>> = [];
  for (const rawIntent of intents) {
    let parsed: z.infer<typeof EffectIntentSchema>;
    try {
      parsed = EffectIntentSchema.parse(rawIntent);
    } catch {
      throw new ContractError('INVALID_OWNER_RECORD');
    }
    for (const field of OWNER_SCOPE_FIELDS) {
      requireCondition(parsed[field] === scope[field], 'OWNER_SCOPE_MISMATCH');
    }
    requireCondition(parsed.fencing_epoch === scope.fencing_epoch, 'OWNER_FENCING_MISMATCH');
    parsedIntents.push(parsed);
  }

  const intentIds = parsedIntents.map((i) => i.effect_intent_id);
  requireCondition(new Set(intentIds).size === intentIds.length, 'DUPLICATE_ID');

  const byId = new Map(parsedIntents.map((i) => [i.effect_intent_id, i]));
  const receiptEffectIds = receipt.effects.map((e) => e.effect_id);
  requireCondition(
    byId.size === receiptEffectIds.length && receiptEffectIds.every((id) => byId.has(id)),
    'OWNER_EFFECT_SET_MISMATCH'
  );

  for (const effect of receipt.effects) {
    const intent = byId.get(effect.effect_id)!;
    requireCondition(projectEffectState(effect.state) === intent.state, 'OWNER_EFFECT_STATE_MISMATCH');
    requireCondition(effect.intent_digest === ownerIntentDigest(intent), 'OWNER_INTENT_MISMATCH');
    if (effect.evidence_ref !== null) {
      requireCondition(effect.evidence_ref === intent.receipt_ref, 'OWNER_EVIDENCE_MISMATCH');
    }
  }
}

// ============================================================================
// Task Observer Checkpoints (API-3333)
// ============================================================================

export interface TaskObserverProposal {
  candidate_id: string;
  impact: 'low' | 'medium' | 'high';
  recurrence: number;
  phase: CandidateEffectPhase;
  evidence_ref?: string;
}

export interface TaskObserverCheckpoint {
  checkpoint_id: string;
  observed_at: string;
  proposals: TaskObserverProposal[];
  overflow_count: number;
  permission_denied: boolean;
}

export function createTaskObserverCheckpoint(options: {
  checkpoint_id: string;
  observed_at: string;
  proposals: TaskObserverProposal[];
  permission_denied: boolean;
}): TaskObserverCheckpoint {
  requireCondition(typeof options === 'object' && options !== null, 'INVALID_SHAPE');
  requireCondition(IdSchema.safeParse(options.checkpoint_id).success, 'INVALID_SHAPE');
  requireCondition(TimestampSchema.safeParse(options.observed_at).success, 'INVALID_SHAPE');
  requireCondition(typeof options.permission_denied === 'boolean', 'INVALID_SHAPE');
  requireCondition(Array.isArray(options.proposals), 'INVALID_SHAPE');

  for (const proposal of options.proposals) {
    requireCondition(typeof proposal === 'object' && proposal !== null, 'INVALID_SHAPE');
    requireCondition(IdSchema.safeParse(proposal.candidate_id).success, 'INVALID_SHAPE');
    requireCondition(proposal.impact === 'low' || proposal.impact === 'medium' || proposal.impact === 'high', 'INVALID_SHAPE');
    requireCondition(typeof proposal.recurrence === 'number' && Number.isInteger(proposal.recurrence) && proposal.recurrence >= 0, 'INVALID_SHAPE');
    requireCondition(
      proposal.phase === 'INTENT' ||
      proposal.phase === 'EXECUTING' ||
      proposal.phase === 'SUCCEEDED' ||
      proposal.phase === 'FAILED' ||
      proposal.phase === 'UNKNOWN' ||
      proposal.phase === 'RECONCILING' ||
      proposal.phase === 'MANUAL',
      'INVALID_SHAPE'
    );
  }

  const sorted = [...options.proposals].sort((a, b) => {
    const impactWeight = { high: 3, medium: 2, low: 1 };
    const diff = impactWeight[b.impact] - impactWeight[a.impact];
    if (diff !== 0) return diff;
    return b.recurrence - a.recurrence;
  });

  const capped = sorted.slice(0, MAX_CHECKPOINT_PROPOSALS);
  const overflow = Math.max(0, sorted.length - MAX_CHECKPOINT_PROPOSALS);

  return {
    checkpoint_id: options.checkpoint_id,
    observed_at: options.observed_at,
    proposals: capped,
    overflow_count: overflow,
    permission_denied: options.permission_denied,
  };
}
