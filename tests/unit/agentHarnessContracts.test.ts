import { describe, it, expect } from 'vitest';
import {
  AgentWorkRequest,
  AgentExecutionReceipt,
  AdmissionSnapshot,
  CandidateEffectPhase,
  canonicalJson,
  requestDigest,
  assertSameRequest,
  validateWorkRequest,
  validateExecutionReceipt,
  checkReceiptBinding,
  checkEffectTransition,
  projectEffectState,
  ownerIntentDigest,
  checkOwnedReceiptBinding,
  loadPacket,
  loadWireJson,
  createTaskObserverCheckpoint,
  ContractError,
  EFFECT_OWNER_STATES,
  EFFECT_EDGES,
  MAX_CONTRACT_BYTES,
} from '../../src/schemas/agentHarnessContracts';

const D = 'sha256:' + 'a'.repeat(64);
const OTHER = 'sha256:' + 'b'.repeat(64);
const NOW = '2026-09-27T18:01:00.000Z';

function createRequest(): AgentWorkRequest {
  return {
    schema: 'ct-agent-work-request.v1',
    scope: {
      tenant_id: 'ct',
      environment_id: 'qualification',
      workspace_id: 'factory',
      repository: 'calltelemetry/ct-meta',
      mission_id: 'mission-1',
      generation: 1,
      execution_id: 'child-1',
      logical_child_id: 'logical-1',
      fencing_epoch: 7,
    },
    idempotency_key: 'work-1',
    work_kind: 'test',
    profile_ref: D,
    input_refs: [{ artifact_id: 'input-1', digest: D, classification: 'synthetic' }],
    capabilities: ['artifact.read'],
    tool_policy_ref: D,
    model_policy_ref: D,
    effect_policy_ref: D,
    retention_policy_ref: D,
    budget: {
      max_cost_microusd: 1000,
      max_tokens: 1000,
      max_duration_ms: 120000,
      concurrency_class: 'qualification',
    },
    created_at: '2026-09-27T18:00:00.000Z',
    deadline: '2026-09-27T18:05:00.000Z',
    parent_execution_id: null,
    correlation_id: 'correlation-1',
    causation_id: 'cause-1',
    provider_eligibility_refs: [D],
  };
}

function createReceipt(req?: AgentWorkRequest): AgentExecutionReceipt {
  const r = req || createRequest();
  return {
    schema: 'ct-agent-execution-receipt.v1',
    scope: JSON.parse(JSON.stringify(r.scope)),
    request_digest: requestDigest(r),
    provider_binding_ref: OTHER,
    lease: { lease_id: 'lease-1', attempt: 1, fencing_token: 1 },
    outcome: 'succeeded',
    started_at: r.created_at,
    observed_at: NOW,
    output_refs: [],
    evidence_refs: [D],
    effects: [],
    metering: { cost_microusd: 10, tokens: 20 },
  };
}

function createSnapshot(req?: AgentWorkRequest, rec?: AgentExecutionReceipt): AdmissionSnapshot {
  const r = req || createRequest();
  const rc = rec || createReceipt(r);
  return {
    scope: JSON.parse(JSON.stringify(r.scope)),
    request_digest: rc.request_digest,
    provider_binding_ref: rc.provider_binding_ref,
    lease: JSON.parse(JSON.stringify(rc.lease)),
    admitted: true,
    revoked: false,
    lease_expires_at: r.deadline,
    authority_expires_at: r.deadline,
  };
}

function change<T>(value: T, path: (string | number)[], replacement: any): T {
  const result = JSON.parse(JSON.stringify(value));
  let target: any = result;
  for (let i = 0; i < path.length - 1; i++) {
    target = target[path[i]];
  }
  target[path[path.length - 1]] = replacement;
  return result;
}

function ownedFixture(state: CandidateEffectPhase = 'SUCCEEDED'): [
  AgentWorkRequest,
  AgentExecutionReceipt,
  AdmissionSnapshot,
  string,
  Record<string, unknown>
] {
  const req = createRequest();
  const rec = createReceipt(req);
  const scope = req.scope;
  const child = {
    schema: 'ct-child-execution.v1',
    mission_id: scope.mission_id,
    generation: scope.generation,
    logical_child_id: scope.logical_child_id,
    execution_id: scope.execution_id,
    attempt: 9,
    state: 'RUNNING',
  };
  const intent: Record<string, unknown> = {
    schema: 'ct-effect-intent.v1',
    effect_intent_id: 'effect-1',
    mission_id: scope.mission_id,
    generation: scope.generation,
    logical_child_id: scope.logical_child_id,
    execution_id: scope.execution_id,
    fencing_epoch: scope.fencing_epoch,
    effect_type: 'synthetic.write',
    authority_envelope_digest: D,
    state: projectEffectState(state),
  };
  const evidence = state === 'SUCCEEDED' || state === 'FAILED' ? D : null;
  if (evidence) {
    intent.receipt_ref = evidence;
  }
  rec.effects = [
    {
      effect_id: 'effect-1',
      intent_digest: ownerIntentDigest(intent),
      state,
      evidence_ref: evidence,
    },
  ];
  if (state !== 'SUCCEEDED') {
    rec.outcome = 'unknown';
  }
  const owner = {
    child_execution: child,
    fencing_epoch: scope.fencing_epoch,
    effect_intents: [intent],
  };
  return [req, rec, createSnapshot(req, rec), NOW, owner];
}

function rejects(code: string, fn: () => void): void {
  try {
    fn();
    expect.fail(`Expected error with code '${code}', but no error was thrown`);
  } catch (err: any) {
    expect(err).toBeInstanceOf(ContractError);
    expect(err.code || err.message).toBe(code);
  }
}

describe('Agent Harness Contracts Suite (API-3330 & API-3333)', () => {
  // Test 1: Baseline valid request, receipt, and admission binding
  it('test_request_and_receipt_validate_against_bundle', () => {
    const req = createRequest();
    const rec = createReceipt(req);
    const snap = createSnapshot(req, rec);

    expect(validateWorkRequest(req)).toBeDefined();
    expect(validateExecutionReceipt(rec)).toBeDefined();
    expect(() => checkReceiptBinding(req, rec, snap, NOW)).not.toThrow();
  });

  // Test 2: Structural schema alone is not complete qualification (keyed identity uniqueness)
  it('test_structural_schema_alone_is_not_complete_qualification', () => {
    // Duplicate artifact_id in input_refs with differing digest
    const req = createRequest();
    req.input_refs.push({ ...req.input_refs[0], digest: OTHER });
    rejects('DUPLICATE_ID', () => validateWorkRequest(req));

    // Duplicate artifact_id in output_refs
    const recOut = createReceipt();
    recOut.output_refs = [
      { artifact_id: 'output-1', digest: D, classification: 'synthetic' },
      { artifact_id: 'output-1', digest: OTHER, classification: 'synthetic' },
    ];
    rejects('DUPLICATE_ID', () => validateExecutionReceipt(recOut));

    // Duplicate effect_id in effects
    const recEff = createReceipt();
    recEff.effects = [
      { effect_id: 'effect-1', intent_digest: D, state: 'SUCCEEDED', evidence_ref: D },
      { effect_id: 'effect-1', intent_digest: OTHER, state: 'SUCCEEDED', evidence_ref: D },
    ];
    rejects('DUPLICATE_ID', () => validateExecutionReceipt(recEff));
  });

  // Test 3: Internal admission snapshot is not a public wire packet
  it('test_internal_admission_snapshot_is_not_a_public_wire_packet', () => {
    const snap = createSnapshot();
    const serialized = JSON.stringify(snap);
    rejects('UNSUPPORTED_SCHEMA', () => loadPacket(serialized));
  });

  // Test 4: Request identity does not depend on object key order
  it('test_request_identity_does_not_depend_on_object_key_order', () => {
    const req = createRequest();
    const reordered: any = {};
    for (const k of Object.keys(req).reverse()) {
      reordered[k] = (req as any)[k];
    }
    const reorderedScope: any = {};
    for (const k of Object.keys(req.scope).reverse()) {
      reorderedScope[k] = (req.scope as any)[k];
    }
    reordered.scope = reorderedScope;

    expect(() => assertSameRequest(req, reordered)).not.toThrow();
    expect(requestDigest(req)).toBe(requestDigest(reordered));
  });

  // Test 5: Each immutable request field is digest-bound
  it('test_each_immutable_request_field_is_digest_bound', () => {
    const req = createRequest();
    const cases: Array<[(string | number)[], any]> = [
      [['scope', 'generation'], 2],
      [['scope', 'execution_id'], 'child-2'],
      [['scope', 'logical_child_id'], 'logical-2'],
      [['scope', 'fencing_epoch'], 8],
      [['scope', 'tenant_id'], 'other'],
      [['idempotency_key'], 'work-2'],
      [['work_kind'], 'investigate'],
      [['profile_ref'], OTHER],
      [['input_refs', 0, 'digest'], OTHER],
      [['capabilities'], ['artifact.write']],
      [['tool_policy_ref'], OTHER],
      [['model_policy_ref'], OTHER],
      [['effect_policy_ref'], OTHER],
      [['retention_policy_ref'], OTHER],
      [['budget', 'max_tokens'], 999],
      [['deadline'], '2026-09-27T18:06:00.000Z'],
      [['parent_execution_id'], 'parent-1'],
      [['correlation_id'], 'correlation-2'],
      [['causation_id'], 'cause-2'],
      [['provider_eligibility_refs'], [OTHER]],
    ];

    for (const [path, val] of cases) {
      const changed = change(req, path, val);
      rejects('REQUEST_DRIFT', () => assertSameRequest(req, changed));
    }
  });

  // Test 6: Unknown fields fail closed at every nested boundary
  it('test_unknown_fields_fail_closed_at_every_nested_boundary', () => {
    const reqCases: string[][] = [[], ['scope'], ['budget'], ['input_refs', '0']];
    for (const path of reqCases) {
      const bad = change(createRequest(), [...path, 'provider_url'], 'DO_NOT_ECHO_SECRET');
      rejects('INVALID_SHAPE', () => validateWorkRequest(bad));
    }

    const recCases: string[][] = [[], ['scope'], ['lease'], ['metering']];
    for (const path of recCases) {
      const bad = change(createReceipt(), [...path, 'provider_url'], 'DO_NOT_ECHO_SECRET');
      rejects('INVALID_SHAPE', () => validateExecutionReceipt(bad));
    }
  });

  // Test 7: Request rejects unbounded or forged values
  it('test_request_rejects_unbounded_or_forged_values', () => {
    const badCases: Array<[string[], any]> = [
      [['schema'], 'ct-agent-work-request.v0'],
      [['scope', 'generation'], 0],
      [['scope', 'generation'], true],
      [['scope', 'generation'], 9007199254740992],
      [['scope', 'tenant_id'], 'ct\n'],
      [['scope', 'repository'], 'https://attacker.invalid'],
      [['budget', 'max_tokens'], -1],
      [['capabilities'], ['artifact.read', 'artifact.read']],
      [['provider_eligibility_refs'], []],
      [['provider_eligibility_refs'], ['provider-url']],
      [['input_refs'], Array(33).fill(createRequest().input_refs[0])],
      [['input_refs', '0', 'classification'], 'raw_transcript'],
      [['deadline'], '2026-02-30T18:05:00.000Z'],
      [['deadline'], '2026-09-27T18:05:00Z'],
    ];

    for (const [path, val] of badCases) {
      const bad = change(createRequest(), path, val);
      rejects('INVALID_SHAPE', () => validateWorkRequest(bad));
    }
  });

  // Test 8: Request semantic negatives (chronology, anti-loop, duplicate id)
  it('test_request_semantic_negatives', () => {
    const req = createRequest();
    rejects('INVALID_DEADLINE', () =>
      validateWorkRequest(change(req, ['deadline'], req.created_at))
    );
    rejects('SELF_PARENT', () =>
      validateWorkRequest(change(req, ['parent_execution_id'], req.scope.execution_id))
    );
    const dup = createRequest();
    dup.input_refs.push({ ...dup.input_refs[0], digest: OTHER });
    rejects('DUPLICATE_ID', () => validateWorkRequest(dup));
  });

  // Test 9: All scope fields are bound to current authority
  it('test_all_scope_fields_are_bound_to_current_authority', () => {
    const req = createRequest();
    const rec = createReceipt(req);
    const snap = createSnapshot(req, rec);

    for (const key of Object.keys(req.scope)) {
      const val = key === 'generation' || key === 'fencing_epoch' ? 2 : key === 'repository' ? 'other/repo' : 'other';
      rejects('SCOPE_MISMATCH', () =>
        checkReceiptBinding(req, rec, change(snap, ['scope', key], val), NOW)
      );
      rejects('SCOPE_MISMATCH', () =>
        checkReceiptBinding(req, change(rec, ['scope', key], val), snap, NOW)
      );
    }
  });

  // Test 10: Each lease fence is bound
  it('test_each_lease_fence_is_bound', () => {
    const req = createRequest();
    const rec = createReceipt(req);
    const snap = createSnapshot(req, rec);

    for (const [key, val] of [
      ['lease_id', 'lease-2'],
      ['attempt', 2],
      ['fencing_token', 2],
    ]) {
      rejects('FENCING_MISMATCH', () =>
        checkReceiptBinding(req, rec, change(snap, ['lease', key], val), NOW)
      );
    }
  });

  // Test 11: Revocation and unadmitted requests cannot complete
  it('test_revocation_and_unadmitted_requests_cannot_complete', () => {
    const req = createRequest();
    const rec = createReceipt(req);
    const snap = createSnapshot(req, rec);

    rejects('AUTHORITY_DENIED', () =>
      checkReceiptBinding(req, rec, change(snap, ['admitted'], false), NOW)
    );
    rejects('AUTHORITY_DENIED', () =>
      checkReceiptBinding(req, rec, change(snap, ['revoked'], true), NOW)
    );
  });

  // Test 12: Expiration is exclusive and not a neutral success
  it('test_expiration_is_exclusive_and_not_a_neutral_success', () => {
    const req = createRequest();
    const rec = createReceipt(req);
    const snap = createSnapshot(req, rec);

    for (const key of ['authority_expires_at', 'lease_expires_at']) {
      rejects('AUTHORITY_EXPIRED', () =>
        checkReceiptBinding(req, rec, change(snap, [key], NOW), NOW)
      );
    }
    rejects('AUTHORITY_EXPIRED', () =>
      checkReceiptBinding(req, rec, snap, req.deadline)
    );
  });

  // Test 13: Mismatched request and provider receipts fail
  it('test_mismatched_request_and_provider_receipts_fail', () => {
    const req = createRequest();
    const rec = createReceipt(req);
    const snap = createSnapshot(req, rec);

    rejects('REQUEST_DRIFT', () =>
      checkReceiptBinding(req, change(rec, ['request_digest'], OTHER), snap, NOW)
    );
    rejects('PROVIDER_MISMATCH', () =>
      checkReceiptBinding(req, change(rec, ['provider_binding_ref'], D), snap, NOW)
    );
    rejects('REQUEST_DRIFT', () =>
      checkReceiptBinding(req, rec, change(snap, ['request_digest'], OTHER), NOW)
    );
  });

  // Test 14: Future and reversed receipt times fail
  it('test_future_and_reversed_receipt_times_fail', () => {
    const req = createRequest();
    const rec = createReceipt(req);
    const snap = createSnapshot(req, rec);

    rejects('INVALID_RECEIPT_TIME', () =>
      checkReceiptBinding(req, change(rec, ['observed_at'], '2026-09-27T18:02:00.000Z'), snap, NOW)
    );
    rejects('INVALID_RECEIPT_TIME', () =>
      validateExecutionReceipt(change(rec, ['started_at'], '2026-09-27T18:02:00.000Z'))
    );
    rejects('INVALID_CLOCK', () =>
      checkReceiptBinding(req, rec, snap, 'not-a-clock')
    );
  });

  // Test 15: Budget overrun is explicit
  it('test_budget_overrun_is_explicit', () => {
    const req = createRequest();
    const rec = createReceipt(req);
    const snap = createSnapshot(req, rec);

    for (const key of ['cost_microusd', 'tokens']) {
      rejects('BUDGET_EXCEEDED', () =>
        checkReceiptBinding(req, change(rec, ['metering', key], 1001), snap, NOW)
      );
    }

    const shortBudgetReq = change(req, ['budget', 'max_duration_ms'], 1000);
    const shortBudgetRec = createReceipt(shortBudgetReq);
    rejects('BUDGET_EXCEEDED', () =>
      checkReceiptBinding(shortBudgetReq, shortBudgetRec, createSnapshot(shortBudgetReq, shortBudgetRec), NOW)
    );
  });

  // Test 16: Success requires evidence and no unresolved effects
  it('test_success_requires_evidence_and_no_unresolved_effects', () => {
    const rec = createReceipt();
    rejects('SUCCESS_EVIDENCE_REQUIRED', () =>
      validateExecutionReceipt(change(rec, ['evidence_refs'], []))
    );

    for (const state of ['INTENT', 'EXECUTING', 'UNKNOWN', 'RECONCILING', 'MANUAL', 'FAILED'] as CandidateEffectPhase[]) {
      const recWithEffect = createReceipt();
      recWithEffect.effects = [
        {
          effect_id: 'effect-1',
          intent_digest: D,
          state,
          evidence_ref: state === 'FAILED' ? D : null,
        },
      ];
      rejects('UNRESOLVED_EFFECT', () => validateExecutionReceipt(recWithEffect));

      // With outcome unknown, unresolved effect is permitted
      recWithEffect.outcome = 'unknown';
      expect(() => validateExecutionReceipt(recWithEffect)).not.toThrow();
    }
  });

  // Test 17: Terminal effects require evidence receipts and duplicate effect ids fail
  it('test_terminal_effects_require_receipts_and_duplicate_effect_ids_fail', () => {
    const rec = createReceipt();
    rec.effects = [{ effect_id: 'effect-1', intent_digest: D, state: 'SUCCEEDED', evidence_ref: null }];
    rejects('EFFECT_EVIDENCE_REQUIRED', () => validateExecutionReceipt(rec));

    rec.effects[0].evidence_ref = D;
    expect(() => validateExecutionReceipt(rec)).not.toThrow();

    rec.effects.push({ ...rec.effects[0], intent_digest: OTHER });
    rejects('DUPLICATE_ID', () => validateExecutionReceipt(rec));
  });

  // Test 18: Unknown external effect cannot be blindly retried
  it('test_unknown_external_effect_cannot_be_blindly_retried', () => {
    const forbidden: Array<[CandidateEffectPhase, CandidateEffectPhase]> = [
      ['UNKNOWN', 'EXECUTING'],
      ['UNKNOWN', 'SUCCEEDED'],
      ['RECONCILING', 'EXECUTING'],
      ['SUCCEEDED', 'EXECUTING'],
      ['FAILED', 'EXECUTING'],
      ['MANUAL', 'EXECUTING'],
    ];

    for (const [source, target] of forbidden) {
      rejects('INVALID_EFFECT_TRANSITION', () => checkEffectTransition(source, target, D));
    }

    const permitted: Array<[CandidateEffectPhase, CandidateEffectPhase]> = [
      ['INTENT', 'EXECUTING'],
      ['EXECUTING', 'UNKNOWN'],
      ['UNKNOWN', 'RECONCILING'],
      ['RECONCILING', 'UNKNOWN'],
      ['RECONCILING', 'MANUAL'],
    ];

    for (const [source, target] of permitted) {
      expect(() => checkEffectTransition(source, target)).not.toThrow();
    }

    for (const target of ['SUCCEEDED', 'FAILED'] as CandidateEffectPhase[]) {
      rejects('EFFECT_EVIDENCE_REQUIRED', () => checkEffectTransition('RECONCILING', target));
      expect(() => checkEffectTransition('RECONCILING', target, D)).not.toThrow();
    }
  });

  // Test 19: Wire boundaries and JSON ambiguity
  it('test_wire_boundaries_and_json_ambiguity', () => {
    rejects('DUPLICATE_JSON_KEY', () => loadPacket(Buffer.from('{"schema":1,"schema":2}')));
    rejects('INVALID_JSON', () => loadPacket(Buffer.from('{"x":NaN}')));
    rejects('INVALID_JSON', () => loadPacket(Buffer.from('{"x":1.0}')));
    rejects('INVALID_JSON', () => loadPacket(Buffer.from([0xff])));
    const padded = Buffer.concat([Buffer.from('{'), Buffer.alloc(MAX_CONTRACT_BYTES, 0x20)]);
    rejects('PAYLOAD_TOO_LARGE', () => loadPacket(padded));

    const validReq = createRequest();
    const parsed = loadPacket(Buffer.from(JSON.stringify(validReq)));
    expect(parsed).toEqual(validReq);
  });

  // Test 20: Code-only diagnostics never echo untrusted payload or secrets
  it('test_cli_never_echoes_payload_or_claims_authority', () => {
    const secret = 'SUPER_SECRET_PAYLOAD_TOKEN';
    const bad = { ...createRequest(), secret };
    try {
      validateWorkRequest(bad);
      expect.fail('Should have failed validation');
    } catch (err: any) {
      expect(err).toBeInstanceOf(ContractError);
      expect(err.code).toBe('INVALID_SHAPE');
      expect(err.message).toBe('INVALID_SHAPE');
      expect(err.stack).not.toContain(secret);
    }
  });

  // Test 21: Projection semantics are independently specified
  it('test_projection_semantics_are_independently_specified', () => {
    const expected = {
      INTENT: 'INTENDED',
      EXECUTING: 'IN_FLIGHT',
      SUCCEEDED: 'SUCCEEDED',
      FAILED: 'FAILED',
      UNKNOWN: 'UNKNOWN',
      RECONCILING: 'UNKNOWN',
      MANUAL: 'UNKNOWN',
    };

    expect(EFFECT_OWNER_STATES).toEqual(expected);

    for (const [phase, state] of Object.entries(expected)) {
      expect(projectEffectState(phase as CandidateEffectPhase)).toBe(state);
      expect(() => checkOwnedReceiptBinding(...ownedFixture(phase as CandidateEffectPhase))).not.toThrow();
    }

    for (const invalid of ['NEW_STATE', null as any, ['UNKNOWN'] as any]) {
      rejects('INVALID_EFFECT_STATE', () => projectEffectState(invalid));
    }
  });

  // Test 22: Effect transition graph completeness
  it('test_source_vocabulary_drift_fails_even_without_effects', () => {
    expect(Object.keys(EFFECT_OWNER_STATES).sort()).toEqual(Object.keys(EFFECT_EDGES).sort());
  });

  // Test 23: Candidate vocabulary and mapping consistency
  it('test_candidate_vocabulary_and_mapping_drift_fail', () => {
    for (const phase of Object.keys(EFFECT_EDGES) as CandidateEffectPhase[]) {
      expect(EFFECT_OWNER_STATES[phase]).toBeDefined();
    }
  });

  // Test 24: Missing or malformed owner record fails closed
  it('test_missing_or_malformed_owner_schema_cannot_fall_back', () => {
    const args = ownedFixture();
    args[4].child_execution = { invalid: true };
    rejects('INVALID_OWNER_RECORD', () => checkOwnedReceiptBinding(...args));
  });

  // Test 25: Owner scope field detection
  it('test_removed_owner_scope_field_is_detected', () => {
    const args = ownedFixture();
    delete (args[4].child_execution as any).logical_child_id;
    rejects('INVALID_OWNER_RECORD', () => checkOwnedReceiptBinding(...args));
  });

  // Test 26: Child scope cannot be forged by matching worker and current
  it('test_child_scope_cannot_be_forged_by_matching_worker_and_current', () => {
    for (const field of ['mission_id', 'generation', 'logical_child_id', 'execution_id']) {
      const args = ownedFixture();
      (args[4].child_execution as any)[field] = field === 'generation' ? 2 : 'other';
      rejects('OWNER_SCOPE_MISMATCH', () => checkOwnedReceiptBinding(...args));
    }
  });

  // Test 27: Effect scope and fencing bind independently
  it('test_effect_scope_and_fencing_bind_independently', () => {
    for (const field of ['mission_id', 'generation', 'logical_child_id', 'execution_id', 'fencing_epoch']) {
      const args = ownedFixture();
      (args[4].effect_intents as any[])[0][field] = field === 'generation' || field === 'fencing_epoch' ? 2 : 'other';
      rejects(
        field === 'fencing_epoch' ? 'OWNER_FENCING_MISMATCH' : 'OWNER_SCOPE_MISMATCH',
        () => checkOwnedReceiptBinding(...args)
      );
    }

    for (const epoch of [8, 1]) {
      const args = ownedFixture();
      args[4].fencing_epoch = epoch;
      rejects('OWNER_FENCING_MISMATCH', () => checkOwnedReceiptBinding(...args));
    }
  });

  // Test 28: New owner bindings are required in all wire scopes
  it('test_new_owner_bindings_are_required_in_all_wire_scopes', () => {
    for (const field of ['logical_child_id', 'fencing_epoch'] as const) {
      const req = createRequest();
      delete (req.scope as any)[field];
      rejects('INVALID_SHAPE', () => validateWorkRequest(req));

      const rec = createReceipt();
      delete (rec.scope as any)[field];
      rejects('INVALID_SHAPE', () => validateExecutionReceipt(rec));
    }

    for (const value of [0, -1, 9007199254740992]) {
      rejects('INVALID_SHAPE', () =>
        validateWorkRequest(change(createRequest(), ['scope', 'fencing_epoch'], value))
      );
    }
  });

  // Test 29: Worker lease, child attempt, and mission epoch are not aliases
  it('test_worker_lease_child_attempt_and_mission_epoch_are_not_aliases', () => {
    const args = ownedFixture();
    expect(args[1].lease.attempt).toBe(1);
    expect((args[4].child_execution as any).attempt).toBe(9);
    expect(args[1].lease.fencing_token).toBe(1);
    expect(args[4].fencing_epoch).toBe(7);

    expect(() => checkOwnedReceiptBinding(...args)).not.toThrow();
  });

  // Test 30: Terminal suspended or revoked child cannot complete as current worker
  it('test_terminal_suspended_or_revoked_child_cannot_complete_as_current_worker', () => {
    for (const state of [
      'REQUESTED',
      'STARTING',
      'SUSPENDED',
      'SUCCEEDED',
      'FAILED',
      'CANCELED',
      'QUARANTINED',
    ]) {
      const args = ownedFixture();
      (args[4].child_execution as any).state = state;
      rejects('OWNER_CHILD_NOT_RUNNING', () => checkOwnedReceiptBinding(...args));
    }

    const argsRevoked = ownedFixture();
    argsRevoked[2].revoked = true;
    rejects('AUTHORITY_DENIED', () => checkOwnedReceiptBinding(...argsRevoked));

    const argsExpired = ownedFixture();
    argsExpired[2].lease_expires_at = NOW;
    rejects('AUTHORITY_EXPIRED', () => checkOwnedReceiptBinding(...argsExpired));
  });

  // Test 31: Complete owned effect set cannot be omitted or extended
  it('test_complete_owned_effect_set_cannot_be_omitted_or_extended', () => {
    // omit-report
    const argsOmitReport = ownedFixture();
    argsOmitReport[1].effects = [];
    rejects('OWNER_EFFECT_SET_MISMATCH', () => checkOwnedReceiptBinding(...argsOmitReport));

    // omit-owner
    const argsOmitOwner = ownedFixture();
    argsOmitOwner[4].effect_intents = [];
    rejects('OWNER_EFFECT_SET_MISMATCH', () => checkOwnedReceiptBinding(...argsOmitOwner));

    // duplicate-owner (len(intents) > len(receipt.effects))
    const argsDupOwner = ownedFixture();
    (argsDupOwner[4].effect_intents as any[]).push(
      JSON.parse(JSON.stringify((argsDupOwner[4].effect_intents as any[])[0]))
    );
    rejects('OWNER_EFFECT_SET_MISMATCH', () => checkOwnedReceiptBinding(...argsDupOwner));

    // wrong-id
    const argsWrongId = ownedFixture();
    (argsWrongId[4].effect_intents as any[])[0].effect_intent_id = 'different';
    rejects('OWNER_EFFECT_SET_MISMATCH', () => checkOwnedReceiptBinding(...argsWrongId));

    // not-list
    const argsNotList = ownedFixture();
    argsNotList[4].effect_intents = {};
    rejects('OWNER_EFFECT_SET_MISMATCH', () => checkOwnedReceiptBinding(...argsNotList));

    // Duplicate intent ID when array lengths match
    const argsDupId = ownedFixture();
    argsDupId[1].effects.push({ ...argsDupId[1].effects[0], effect_id: 'effect-2' });
    (argsDupId[4].effect_intents as any[]).push(
      JSON.parse(JSON.stringify((argsDupId[4].effect_intents as any[])[0]))
    );
    rejects('DUPLICATE_ID', () => checkOwnedReceiptBinding(...argsDupId));

    // Empty sets match
    const argsEmpty = ownedFixture();
    argsEmpty[1].effects = [];
    argsEmpty[4].effect_intents = [];
    expect(() => checkOwnedReceiptBinding(...argsEmpty)).not.toThrow();
  });

  // Test 32: Owner records and internal snapshot are closed
  it('test_owner_records_and_internal_snapshot_are_closed', () => {
    const argsChild = ownedFixture();
    (argsChild[4].child_execution as any).secret = 'DO_NOT_ECHO';
    rejects('INVALID_OWNER_RECORD', () => checkOwnedReceiptBinding(...argsChild));

    const argsIntent = ownedFixture();
    (argsIntent[4].effect_intents as any[])[0].secret = 'DO_NOT_ECHO';
    rejects('INVALID_OWNER_RECORD', () => checkOwnedReceiptBinding(...argsIntent));

    const argsSnap = ownedFixture();
    argsSnap[4].untrusted = 'DO_NOT_ECHO';
    rejects('INVALID_OWNER_SNAPSHOT', () => checkOwnedReceiptBinding(...argsSnap));
  });

  // Test 33: Unknown effect cannot become success from worker receipt
  it('test_unknown_effect_cannot_become_success_from_worker_receipt', () => {
    const args = ownedFixture();
    (args[4].effect_intents as any[])[0].state = 'UNKNOWN';
    rejects('OWNER_EFFECT_STATE_MISMATCH', () => checkOwnedReceiptBinding(...args));

    for (const phase of ['RECONCILING', 'MANUAL'] as CandidateEffectPhase[]) {
      const argsPhase = ownedFixture(phase);
      (argsPhase[4].effect_intents as any[])[0].state = 'SUCCEEDED';
      rejects('OWNER_EFFECT_STATE_MISMATCH', () => checkOwnedReceiptBinding(...argsPhase));
    }
  });

  // Test 34: Intent digest binds identity, authority, and effect type
  it('test_intent_digest_binds_identity_authority_and_effect_type', () => {
    for (const [field, val] of [
      ['effect_type', 'other.write'],
      ['authority_envelope_digest', OTHER],
    ]) {
      const args = ownedFixture();
      (args[4].effect_intents as any[])[0][field] = val;
      rejects('OWNER_INTENT_MISMATCH', () => checkOwnedReceiptBinding(...args));
    }

    const intent = (ownedFixture()[4].effect_intents as any[])[0];
    const digest = ownerIntentDigest(intent);
    const changed = { ...intent, state: 'UNKNOWN', external_ref: 'opaque', receipt_ref: OTHER };
    expect(ownerIntentDigest(changed)).toBe(digest);
  });

  // Test 35: Terminal evidence must match owner not just have digest shape
  it('test_terminal_evidence_must_match_owner_not_just_have_digest_shape', () => {
    for (const phase of ['SUCCEEDED', 'FAILED'] as CandidateEffectPhase[]) {
      const args = ownedFixture(phase);
      delete (args[4].effect_intents as any[])[0].receipt_ref;
      rejects('OWNER_EVIDENCE_MISMATCH', () => checkOwnedReceiptBinding(...args));

      const argsMismatch = ownedFixture(phase);
      (argsMismatch[4].effect_intents as any[])[0].receipt_ref = OTHER;
      rejects('OWNER_EVIDENCE_MISMATCH', () => checkOwnedReceiptBinding(...argsMismatch));
    }
  });

  // Test 36: Task observer checkpoint validation and capping
  it('test_task_observer_checkpoint_validation_and_capping', () => {
    const validProposals = [
      { candidate_id: 'c1', impact: 'low' as const, recurrence: 1, phase: 'INTENT' as CandidateEffectPhase },
      { candidate_id: 'c2', impact: 'high' as const, recurrence: 2, phase: 'EXECUTING' as CandidateEffectPhase },
      { candidate_id: 'c3', impact: 'medium' as const, recurrence: 5, phase: 'SUCCEEDED' as CandidateEffectPhase },
      { candidate_id: 'c4', impact: 'high' as const, recurrence: 10, phase: 'INTENT' as CandidateEffectPhase },
      { candidate_id: 'c5', impact: 'low' as const, recurrence: 3, phase: 'INTENT' as CandidateEffectPhase },
      { candidate_id: 'c6', impact: 'medium' as const, recurrence: 1, phase: 'INTENT' as CandidateEffectPhase },
    ];

    const cp = createTaskObserverCheckpoint({
      checkpoint_id: 'cp-valid-1',
      observed_at: NOW,
      proposals: validProposals,
      permission_denied: false,
    });

    expect(cp.checkpoint_id).toBe('cp-valid-1');
    expect(cp.observed_at).toBe(NOW);
    expect(cp.permission_denied).toBe(false);
    expect(cp.proposals.length).toBe(5);
    expect(cp.overflow_count).toBe(1);
    // Highest priority should be high impact with highest recurrence (c4, then c2)
    expect(cp.proposals[0].candidate_id).toBe('c4');
    expect(cp.proposals[1].candidate_id).toBe('c2');

    // Runtime type assertions
    rejects('INVALID_SHAPE', () =>
      createTaskObserverCheckpoint({
        checkpoint_id: 'cp-1',
        observed_at: NOW,
        proposals: [],
        permission_denied: undefined as any,
      })
    );
    rejects('INVALID_SHAPE', () =>
      createTaskObserverCheckpoint({
        checkpoint_id: 'cp-1',
        observed_at: NOW,
        proposals: [],
        permission_denied: null as any,
      })
    );
    rejects('INVALID_SHAPE', () =>
      createTaskObserverCheckpoint({
        checkpoint_id: 'cp-1',
        observed_at: NOW,
        proposals: [],
        permission_denied: 'false' as any,
      })
    );
    rejects('INVALID_SHAPE', () =>
      createTaskObserverCheckpoint({
        checkpoint_id: 'cp-1',
        observed_at: NOW,
        proposals: null as any,
        permission_denied: false,
      })
    );
    rejects('INVALID_SHAPE', () =>
      createTaskObserverCheckpoint({
        checkpoint_id: 'cp-1',
        observed_at: NOW,
        proposals: [{ candidate_id: '', impact: 'low', recurrence: 1, phase: 'INTENT' }],
        permission_denied: false,
      })
    );
    rejects('INVALID_SHAPE', () =>
      createTaskObserverCheckpoint({
        checkpoint_id: 'cp-1',
        observed_at: NOW,
        proposals: [{ candidate_id: 'c1', impact: 'extreme' as any, recurrence: 1, phase: 'INTENT' }],
        permission_denied: false,
      })
    );
    rejects('INVALID_SHAPE', () =>
      createTaskObserverCheckpoint({
        checkpoint_id: 'cp-1',
        observed_at: NOW,
        proposals: [{ candidate_id: 'c1', impact: 'low', recurrence: -1, phase: 'INTENT' }],
        permission_denied: false,
      })
    );
  });

  it('test_rfc8785_canonical_json_and_prototype_poisoning_protections', () => {
    // Lone surrogates rejection (RFC 8785 §3.2.2.2)
    expect(() => canonicalJson('\uD800')).toThrow('INVALID_JSON');
    expect(() => canonicalJson('abc\uD83Ddef')).toThrow('INVALID_JSON');
    expect(() => canonicalJson('\uDC00')).toThrow('INVALID_JSON');
    // Valid surrogate pairs must pass
    expect(canonicalJson('\uD83D\uDE00')).toBe('"😀"');

    // Sparse array rejection
    const sparse = new Array(3);
    sparse[0] = 1;
    sparse[2] = 3;
    expect(() => canonicalJson(sparse)).toThrow('INVALID_JSON');

    // Non-plain objects rejection
    class CustomObj { a = 1; }
    expect(() => canonicalJson(new CustomObj())).toThrow('INVALID_JSON');

    // Prototype poisoning rejection in wire parser
    const protoPayload = '{"schema":"ct-agent-work-request.v1","__proto__":{"polluted":true}}';
    const parsed = loadWireJson(protoPayload) as any;
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
    rejects('INVALID_SHAPE', () => validateWorkRequest(parsed));
  });
});
