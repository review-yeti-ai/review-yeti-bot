/**
 * Adversarial Challenge & Empirical Stress Test Suite for Agent Harness Contracts
 * Focuses on:
 * 1. Duplicate JSON key injection (DUPLICATE_JSON_KEY)
 * 2. Float and non-integer numbers (1.0, 1e5, etc.) where integers are required (INVALID_JSON)
 * 3. Payload size limit at 65,536 bytes boundary (PAYLOAD_TOO_LARGE)
 * 4. Boundary conditions on dates, timestamps, leap years, non-millisecond ISO formats
 * 5. Canonical JSON sorting parity against Python agent_harness_contract oracle
 * 6. Code-only error outputs ensuring zero payload text/secret reflection
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  canonicalJson,
  canonicalJsonBuffer,
  loadWireJson,
  loadPacket,
  validateWorkRequest,
  validateExecutionReceipt,
  requestDigest,
  checkReceiptBinding,
  checkEffectTransition,
  projectEffectState,
  ownerIntentDigest,
  checkOwnedReceiptBinding,
  createTaskObserverCheckpoint,
  ContractError,
  MAX_CONTRACT_BYTES,
  AgentWorkRequest,
  AgentExecutionReceipt,
  AdmissionSnapshot,
  TimestampSchema,
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
      repository: 'exampleorg/example-meta',
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

const ORACLE_SCRIPT = path.resolve(__dirname, 'adversarial_oracle_bridge.py');

function runPythonOracle(mode: 'canonical' | 'load_packet', input: string | Buffer): {
  ok: boolean;
  canonical?: string;
  digest?: string;
  error?: string;
  length?: number;
} {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  const stdout = execFileSync('python3', [ORACLE_SCRIPT, mode], {
    input: buf,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

function assertThrowsCode(code: string, fn: () => void): void {
  try {
    fn();
    expect.fail(`Expected ContractError with code '${code}', but no error was thrown`);
  } catch (err: any) {
    expect(err).toBeInstanceOf(ContractError);
    expect(err.code).toBe(code);
    expect(err.message).toBe(code);
  }
}

describe('Empirical Adversarial Challenges: agentHarnessContracts.ts', () => {

  // ==========================================================================
  // Section 1: DUPLICATE_JSON_KEY Adversarial Stress Tests
  // ==========================================================================
  describe('Adversarial Dimension 1: DUPLICATE_JSON_KEY', () => {
    it('rejects duplicate keys at root object level', () => {
      const inputs = [
        '{"schema":"ct-agent-work-request.v1","schema":"ct-agent-work-request.v1"}',
        '{"a":1,"b":2,"a":3}',
        '{"k":null,"k":null}',
        '{"x":true,"y":false,"x":true}',
        '{"idempotency_key":"1","idempotency_key":"2"}',
      ];
      for (const raw of inputs) {
        assertThrowsCode('DUPLICATE_JSON_KEY', () => loadWireJson(raw));
        const pyResult = runPythonOracle('load_packet', raw);
        expect(pyResult.ok).toBe(false);
        expect(pyResult.error).toBe('DUPLICATE_JSON_KEY');
      }
    });

    it('rejects duplicate keys in nested scope object', () => {
      const req = createRequest();
      const raw = JSON.stringify(req).replace(
        '"scope":{',
        '"scope":{"tenant_id":"ct-dup",'
      );
      assertThrowsCode('DUPLICATE_JSON_KEY', () => loadWireJson(raw));
      assertThrowsCode('DUPLICATE_JSON_KEY', () => loadPacket(raw));
      const pyResult = runPythonOracle('load_packet', raw);
      expect(pyResult.ok).toBe(false);
      expect(pyResult.error).toBe('DUPLICATE_JSON_KEY');
    });

    it('rejects duplicate keys inside array-embedded objects', () => {
      const inputs = [
        '[{"a":1,"a":2}]',
        '[1, 2, {"nested":{"x":10,"x":20}}]',
        '{"input_refs":[{"artifact_id":"a","digest":"sha256:' + 'a'.repeat(64) + '","artifact_id":"b"}]}',
      ];
      for (const raw of inputs) {
        assertThrowsCode('DUPLICATE_JSON_KEY', () => loadWireJson(raw));
        const pyResult = runPythonOracle('load_packet', raw);
        expect(pyResult.ok).toBe(false);
        expect(pyResult.error).toBe('DUPLICATE_JSON_KEY');
      }
    });

    it('rejects duplicate keys with Unicode escape normalization', () => {
      // "schema" vs "\u0073\u0063\u0068\u0065\u006d\u0061"
      const raw = '{"schema":"v1","\\u0073\\u0063\\u0068\\u0065\\u006d\\u0061":"v2"}';
      assertThrowsCode('DUPLICATE_JSON_KEY', () => loadWireJson(raw));
      const pyResult = runPythonOracle('load_packet', raw);
      expect(pyResult.ok).toBe(false);
      expect(pyResult.error).toBe('DUPLICATE_JSON_KEY');
    });

    it('rejects duplicate keys with empty string or whitespace in keys', () => {
      assertThrowsCode('DUPLICATE_JSON_KEY', () => loadWireJson('{"":1,"":2}'));
      assertThrowsCode('DUPLICATE_JSON_KEY', () => loadWireJson('{" key ":1," key ":2}'));
      assertThrowsCode('DUPLICATE_JSON_KEY', () => loadWireJson('{"\\n":1,"\\n":2}'));
    });

    it('rejects duplicate __proto__ keys without prototype pollution', () => {
      const raw = '{"__proto__":{"a":1},"__proto__":{"b":2}}';
      assertThrowsCode('DUPLICATE_JSON_KEY', () => loadWireJson(raw));
      const pyResult = runPythonOracle('load_packet', raw);
      expect(pyResult.ok).toBe(false);
      expect(pyResult.error).toBe('DUPLICATE_JSON_KEY');
    });
  });

  // ==========================================================================
  // Section 2: Float / Non-Integer Numbers (INVALID_JSON) Adversarial Stress Tests
  // ==========================================================================
  describe('Adversarial Dimension 2: Float & Non-Integer Numbers (INVALID_JSON)', () => {
    it('rejects float numbers with decimal points (1.0, 0.0, 0.5, etc.)', () => {
      const floats = [
        '{"x":1.0}',
        '{"x":0.0}',
        '{"x":-0.0}',
        '{"x":0.5}',
        '{"x":-1.0}',
        '{"x":.5}',
        '{"x":5.}',
        '{"x":100.0000}',
        '{"generation":1.0}',
        '{"fencing_epoch":7.0}',
      ];
      for (const raw of floats) {
        assertThrowsCode('INVALID_JSON', () => loadWireJson(raw));
        // Cross check with Python oracle where syntax is valid JSON
        if (!raw.includes('.5') && !raw.includes('5.')) {
          const pyResult = runPythonOracle('load_packet', raw);
          expect(pyResult.ok).toBe(false);
          expect(pyResult.error).toBe('INVALID_JSON');
        }
      }
    });

    it('rejects exponential formatting (1e5, 1E5, 1e+5, 1e-5, 1e0)', () => {
      const exponentials = [
        '{"x":1e5}',
        '{"x":1E5}',
        '{"x":1e+5}',
        '{"x":1e-5}',
        '{"x":1e0}',
        '{"x":-1e5}',
        '{"x":2.5e3}',
        '{"tokens":1e3}',
      ];
      for (const raw of exponentials) {
        assertThrowsCode('INVALID_JSON', () => loadWireJson(raw));
        const pyResult = runPythonOracle('load_packet', raw);
        expect(pyResult.ok).toBe(false);
        expect(pyResult.error).toBe('INVALID_JSON');
      }
    });

    it('rejects octal-like leading zeros (01, 00, -01)', () => {
      const leadingZeros = ['{"x":01}', '{"x":00}', '{"x":-01}', '{"x":007}'];
      for (const raw of leadingZeros) {
        assertThrowsCode('INVALID_JSON', () => loadWireJson(raw));
      }
    });

    it('rejects integers exceeding Number.MAX_SAFE_INTEGER in wire parser', () => {
      const unsafeInts = [
        '{"x":9007199254740992}',
        '{"x":9007199254740993}',
        '{"x":-9007199254740992}',
        '{"x":1000000000000000000000000}',
      ];
      for (const raw of unsafeInts) {
        assertThrowsCode('INVALID_JSON', () => loadWireJson(raw));
      }
    });

    it('rejects floats and non-integers in canonicalJson serializer directly', () => {
      const inMemoryNonInts = [
        1.5,
        -1.5,
        0.1,
        NaN,
        Infinity,
        -Infinity,
        9007199254740992,
        -9007199254740992,
      ];
      for (const val of inMemoryNonInts) {
        assertThrowsCode('INVALID_JSON', () => canonicalJson({ num: val }));
      }
    });

    it('accepts valid safe integers including boundary 0, -0, and 9007199254740991', () => {
      const validInts = [
        0,
        1,
        -1,
        42,
        1000000,
        9007199254740991,
        -9007199254740991,
      ];
      for (const num of validInts) {
        const raw = `{"val":${num}}`;
        const parsed = loadWireJson(raw) as any;
        expect(parsed.val).toBe(num);
        expect(canonicalJson({ val: num })).toBe(`{"val":${num}}`);
      }
      // Negative zero normalizes to '0'
      expect(canonicalJson({ val: -0 })).toBe('{"val":0}');
    });
  });

  // ==========================================================================
  // Section 3: Payload Size Limit (PAYLOAD_TOO_LARGE) Adversarial Stress Tests
  // ==========================================================================
  describe('Adversarial Dimension 3: PAYLOAD_TOO_LARGE (65,536 Bytes Boundary)', () => {
    it('accepts wire payload at exactly 65,536 bytes if structurally valid', () => {
      // Construct a valid wire string that is exactly 65,536 bytes
      const prefix = '{"schema":"ct-agent-work-request.v1","padding":"';
      const suffix = '"}';
      const padLen = MAX_CONTRACT_BYTES - prefix.length - suffix.length;
      const wire = prefix + 'a'.repeat(padLen) + suffix;
      expect(Buffer.byteLength(wire, 'utf8')).toBe(MAX_CONTRACT_BYTES);

      // loadWireJson parses it without PAYLOAD_TOO_LARGE (fails later at schema validation or succeeds in wire parse)
      const parsed = loadWireJson(wire);
      expect(parsed).toBeDefined();
    });

    it('rejects wire payload at 65,537 bytes with PAYLOAD_TOO_LARGE', () => {
      const prefix = '{"schema":"ct-agent-work-request.v1","padding":"';
      const suffix = '"}';
      const padLen = MAX_CONTRACT_BYTES - prefix.length - suffix.length + 1;
      const wire = prefix + 'a'.repeat(padLen) + suffix;
      expect(Buffer.byteLength(wire, 'utf8')).toBe(MAX_CONTRACT_BYTES + 1);

      assertThrowsCode('PAYLOAD_TOO_LARGE', () => loadWireJson(wire));
      assertThrowsCode('PAYLOAD_TOO_LARGE', () => loadPacket(wire));

      const pyResult = runPythonOracle('load_packet', wire);
      expect(pyResult.ok).toBe(false);
      expect(pyResult.error).toBe('PAYLOAD_TOO_LARGE');
    });

    it('rejects oversized Buffer inputs passed to loadWireJson', () => {
      const buf = Buffer.alloc(MAX_CONTRACT_BYTES + 100, 0x20);
      assertThrowsCode('PAYLOAD_TOO_LARGE', () => loadWireJson(buf));
    });

    it('rejects canonical serialization exceeding 65,536 bytes', () => {
      const bigObj = {
        padding: 'x'.repeat(MAX_CONTRACT_BYTES),
      };
      assertThrowsCode('PAYLOAD_TOO_LARGE', () => canonicalJson(bigObj));
      assertThrowsCode('PAYLOAD_TOO_LARGE', () => canonicalJsonBuffer(bigObj));
    });

    it('rejects objects with more than 65,536 AST nodes in canonicalJson', () => {
      // Array of 65,537 simple elements
      const arr = new Array(MAX_CONTRACT_BYTES + 1).fill(0);
      assertThrowsCode('PAYLOAD_TOO_LARGE', () => canonicalJson(arr));
    });
  });

  // ==========================================================================
  // Section 4: Boundary Conditions on Dates, Timestamps & Non-Millisecond ISO Formats
  // ==========================================================================
  describe('Adversarial Dimension 4: Dates, Timestamps, Leap Years & Precision', () => {
    it('accepts valid UTC timestamp with exact millisecond precision', () => {
      expect(TimestampSchema.safeParse('2026-09-27T18:00:00.000Z').success).toBe(true);
      expect(TimestampSchema.safeParse('2026-12-31T23:59:59.999Z').success).toBe(true);
      expect(TimestampSchema.safeParse('2026-01-01T00:00:00.000Z').success).toBe(true);
    });

    it('accepts leap day on leap years (2024, 2000)', () => {
      expect(TimestampSchema.safeParse('2024-02-29T12:00:00.000Z').success).toBe(true);
      expect(TimestampSchema.safeParse('2000-02-29T12:00:00.000Z').success).toBe(true);
    });

    it('rejects leap day on non-leap years (2026, 1900, 2100)', () => {
      expect(TimestampSchema.safeParse('2026-02-29T12:00:00.000Z').success).toBe(false);
      expect(TimestampSchema.safeParse('1900-02-29T12:00:00.000Z').success).toBe(false);
      expect(TimestampSchema.safeParse('2100-02-29T12:00:00.000Z').success).toBe(false);
    });

    it('rejects non-millisecond ISO formats (seconds-only, microseconds, arbitrary decimals)', () => {
      const nonMillisecond = [
        '2026-09-27T18:00:00Z',       // no fractional seconds
        '2026-09-27T18:00:00.0Z',     // 1 decimal place
        '2026-09-27T18:00:00.00Z',    // 2 decimal places
        '2026-09-27T18:00:00.0000Z',  // 4 decimal places
        '2026-09-27T18:00:00.000000Z',// 6 decimal places (microseconds)
        '2026-09-27T18:00:00.000000000Z', // nanoseconds
      ];
      for (const ts of nonMillisecond) {
        expect(TimestampSchema.safeParse(ts).success).toBe(false);
      }
    });

    it('rejects non-UTC timezone offsets (+00:00, -05:00, etc.)', () => {
      const offsets = [
        '2026-09-27T18:00:00.000+00:00',
        '2026-09-27T18:00:00.000-00:00',
        '2026-09-27T18:00:00.000+05:00',
        '2026-09-27T18:00:00.000-05:00',
        '2026-09-27T18:00:00.000+0000',
      ];
      for (const ts of offsets) {
        expect(TimestampSchema.safeParse(ts).success).toBe(false);
      }
    });

    it('rejects invalid calendar dates and out-of-range components', () => {
      const invalidDates = [
        '2026-00-15T12:00:00.000Z', // month 0
        '2026-13-15T12:00:00.000Z', // month 13
        '2026-05-00T12:00:00.000Z', // day 0
        '2026-04-31T12:00:00.000Z', // April 31
        '2026-06-31T12:00:00.000Z', // June 31
        '2026-09-31T12:00:00.000Z', // Sept 31
        '2026-11-31T12:00:00.000Z', // Nov 31
        '2026-01-32T12:00:00.000Z', // day 32
        '2026-01-01T24:00:00.000Z', // hour 24
        '2026-01-01T25:00:00.000Z', // hour 25
        '2026-01-01T12:60:00.000Z', // minute 60
        '2016-12-31T23:59:60.000Z', // leap second 60
        ' 2026-09-27T18:00:00.000Z',// leading space
        '2026-09-27T18:00:00.000Z ',// trailing space
        '2026-09-27t18:00:00.000Z', // lowercase t
        '2026-09-27T18:00:00.000z', // lowercase z
      ];
      for (const ts of invalidDates) {
        expect(TimestampSchema.safeParse(ts).success).toBe(false);
      }
    });

    it('rejects inverted chronology in work requests and receipts', () => {
      const req = createRequest();
      // created_at >= deadline
      const badReq1 = { ...req, deadline: req.created_at };
      assertThrowsCode('INVALID_DEADLINE', () => validateWorkRequest(badReq1));

      const badReq2 = { ...req, deadline: '2026-09-27T17:59:00.000Z' };
      assertThrowsCode('INVALID_DEADLINE', () => validateWorkRequest(badReq2));

      // started_at > observed_at
      const rec = createReceipt(req);
      const badRec = {
        ...rec,
        started_at: '2026-09-27T18:02:00.000Z',
        observed_at: '2026-09-27T18:01:00.000Z',
      };
      assertThrowsCode('INVALID_RECEIPT_TIME', () => validateExecutionReceipt(badRec));
    });
  });

  // ==========================================================================
  // Section 5: Canonical JSON Sorting Parity Against Python Oracle
  // ==========================================================================
  describe('Adversarial Dimension 5: Canonical JSON Parity Against Python Oracle', () => {
    it('produces 100% byte-identical canonical JSON for AgentWorkRequest', () => {
      const req = createRequest();
      const tsCanonical = canonicalJson(req);
      const tsDigest = requestDigest(req);

      const pyResult = runPythonOracle('canonical', JSON.stringify(req));
      expect(pyResult.ok).toBe(true);
      expect(pyResult.canonical).toBe(tsCanonical);
      expect(pyResult.digest).toBe(tsDigest);
    });

    it('produces 100% byte-identical canonical JSON for AgentExecutionReceipt', () => {
      const rec = createReceipt();
      const tsCanonical = canonicalJson(rec);
      const tsDigest = 'sha256:' + crypto.createHash('sha256').update(tsCanonical, 'utf8').digest('hex');

      const pyResult = runPythonOracle('canonical', JSON.stringify(rec));
      expect(pyResult.ok).toBe(true);
      expect(pyResult.canonical).toBe(tsCanonical);
      expect(pyResult.digest).toBe(tsDigest);
    });

    it('ensures key order invariance across deeply nested shuffled structures', () => {
      const complexObject = {
        z_root: {
          m_mid: {
            z_inner: 1,
            a_inner: 2,
            m_inner: [
              { z: 'end', a: 'start', b: null, flag: true },
              { x: 10, y: 20 },
            ],
          },
          a_mid: {
            sub: { c: 3, b: 2, a: 1 },
          },
        },
        a_root: [1, 2, { k2: 'v2', k1: 'v1' }],
        m_root: 'string_value',
        c_root: -0,
      };

      const tsCanonical = canonicalJson(complexObject);
      const pyResult = runPythonOracle('canonical', JSON.stringify(complexObject));
      expect(pyResult.ok).toBe(true);
      expect(tsCanonical).toBe(pyResult.canonical);
      expect('sha256:' + crypto.createHash('sha256').update(tsCanonical, 'utf8').digest('hex'))
        .toBe(pyResult.digest);
    });

    it('stress tests 50 randomly generated nested structures against Python oracle', () => {
      function generateRandomObject(depth = 0): any {
        if (depth > 3) return Math.floor(Math.random() * 1000);
        const keys = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
          .sort(() => Math.random() - 0.5)
          .slice(0, 3 + Math.floor(Math.random() * 4));

        const obj: Record<string, any> = {};
        for (const k of keys) {
          const typeChoice = Math.floor(Math.random() * 5);
          if (typeChoice === 0) obj[k] = Math.floor(Math.random() * 1000);
          else if (typeChoice === 1) obj[k] = `str_${Math.random().toString(36).substring(7)}`;
          else if (typeChoice === 2) obj[k] = Math.random() > 0.5;
          else if (typeChoice === 3) obj[k] = null;
          else obj[k] = generateRandomObject(depth + 1);
        }
        return obj;
      }

      for (let i = 0; i < 50; i++) {
        const randObj = generateRandomObject();
        const tsCanonical = canonicalJson(randObj);
        const pyResult = runPythonOracle('canonical', JSON.stringify(randObj));
        expect(pyResult.ok).toBe(true);
        expect(tsCanonical).toBe(pyResult.canonical);
      }
    });
  });

  // ==========================================================================
  // Section 6: Code-Only Error Outputs (Zero Untrusted Payload / Secret Leaks)
  // ==========================================================================
  describe('Adversarial Dimension 6: Code-Only Diagnostics & Zero Secret Leakage', () => {
    const SECRET_TOKENS = [
      'SUPER_SECRET_AWS_KEY_AKIAIOSFODNN7EXAMPLE',
      'ghp_A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8',
      'Bearer dGhpcyBpcyBhIHNlY3JldCB0b2tlbg==',
      'password12345!',
      'database://user:super_secret_pw@host/db',
    ];

    it('never reflects secret values injected into extra unexpected properties', () => {
      for (const secret of SECRET_TOKENS) {
        const badReq = { ...createRequest(), leak: secret };
        try {
          validateWorkRequest(badReq);
          expect.fail('Should fail validation');
        } catch (err: any) {
          expect(err).toBeInstanceOf(ContractError);
          expect(err.code).toBe('INVALID_SHAPE');
          expect(err.message).toBe('INVALID_SHAPE');
          expect(JSON.stringify(err)).not.toContain(secret);
          expect(err.stack).not.toContain(secret);
        }
      }
    });

    it('never reflects secret values injected into nested scope properties', () => {
      for (const secret of SECRET_TOKENS) {
        const req = createRequest();
        (req.scope as any).secret_fencing = secret;
        try {
          validateWorkRequest(req);
          expect.fail('Should fail validation');
        } catch (err: any) {
          expect(err).toBeInstanceOf(ContractError);
          expect(err.code).toBe('INVALID_SHAPE');
          expect(err.message).toBe('INVALID_SHAPE');
          expect(JSON.stringify(err)).not.toContain(secret);
          expect(err.stack).not.toContain(secret);
        }
      }
    });

    it('never reflects secret text when parsing duplicate JSON keys', () => {
      for (const secret of SECRET_TOKENS) {
        const wire = `{"${secret}":1,"${secret}":2}`;
        try {
          loadWireJson(wire);
          expect.fail('Should fail duplicate key check');
        } catch (err: any) {
          expect(err).toBeInstanceOf(ContractError);
          expect(err.code).toBe('DUPLICATE_JSON_KEY');
          expect(err.message).toBe('DUPLICATE_JSON_KEY');
          expect(JSON.stringify(err)).not.toContain(secret);
          expect(err.stack).not.toContain(secret);
        }
      }
    });

    it('never reflects secret text in malformed JSON syntax errors', () => {
      for (const secret of SECRET_TOKENS) {
        const malformed = `{"schema":"ct-agent-work-request.v1","secret":"${secret}" UNCLOSED`;
        try {
          loadWireJson(malformed);
          expect.fail('Should fail JSON parse');
        } catch (err: any) {
          expect(err).toBeInstanceOf(ContractError);
          expect(err.code).toBe('INVALID_JSON');
          expect(err.message).toBe('INVALID_JSON');
          expect(JSON.stringify(err)).not.toContain(secret);
          expect(err.stack).not.toContain(secret);
        }
      }
    });

    it('never reflects secrets in TaskObserverCheckpoint validation', () => {
      for (const secret of SECRET_TOKENS) {
        // Test invalid checkpoint_id containing secret
        try {
          createTaskObserverCheckpoint({
            checkpoint_id: secret + ' \n INVALID', // guaranteed invalid ID shape
            observed_at: NOW,
            proposals: [],
            permission_denied: false,
          });
          expect.fail('Should fail checkpoint validation');
        } catch (err: any) {
          expect(err).toBeInstanceOf(ContractError);
          expect(err.code).toBe('INVALID_SHAPE');
          expect(err.message).toBe('INVALID_SHAPE');
          expect(JSON.stringify(err)).not.toContain(secret);
          expect(err.stack).not.toContain(secret);
        }

        // Test invalid observed_at containing secret
        try {
          createTaskObserverCheckpoint({
            checkpoint_id: 'valid-checkpoint-id',
            observed_at: secret, // invalid timestamp
            proposals: [],
            permission_denied: false,
          });
          expect.fail('Should fail checkpoint validation');
        } catch (err: any) {
          expect(err).toBeInstanceOf(ContractError);
          expect(err.code).toBe('INVALID_SHAPE');
          expect(err.message).toBe('INVALID_SHAPE');
          expect(JSON.stringify(err)).not.toContain(secret);
          expect(err.stack).not.toContain(secret);
        }
      }
    });
  });
});
