import { describe, it, expect, vi } from 'vitest';
import {
  K8sJobRunner,
  generateSimulationReceipt,
  ContractError,
  canonicalJson,
  RECEIPT_LOG_MARKER_START,
  RECEIPT_LOG_MARKER_END,
} from '../../src/infrastructure/k8sJobRunner';
import { AgentExecutionReceipt, AgentWorkRequest } from '../../src/schemas/agentHarnessContracts';

describe('Empirical Challenger M2 R2.1: Pod Log Receipt Extraction Stress Test', () => {
  const baseSpec = {
    persona: 'security',
    repoUrl: 'exampleorg/example-api',
    prNumber: 101,
    commitSha: 'beefcafe1234567890abcdef1234567890abcdef',
    logicalChildId: 'sec-pod-stress-101',
    fencingEpoch: 3,
    missionId: 'mission-pr101-beefcafe',
    generation: 1,
    executionId: 'exec-sec-pr101-g1',
    tenantId: 'ct-prod',
    environmentId: 'staging-k8s',
    workspaceId: 'ws-pod-stress',
  };

  const runner = new K8sJobRunner({ forceSimulation: true });
  const workRequest: AgentWorkRequest = runner.buildWorkRequest(baseSpec);

  function createRunnerWithPodLogs(logOutput: string): K8sJobRunner {
    const mockCoreApi: any = {
      readNamespacedPodLog: vi.fn().mockResolvedValue(logOutput),
    };
    return new K8sJobRunner({
      forceSimulation: false,
      coreV1Api: mockCoreApi,
    });
  }

  // ==========================================================================
  // Positive Baseline
  // ==========================================================================
  describe('Positive Baseline: Valid receipt between log markers', () => {
    it('successfully extracts and returns valid AgentExecutionReceipt from pod logs', async () => {
      const validReceipt = generateSimulationReceipt(workRequest);
      const logOutput = [
        '2026-09-27T23:00:00Z [INFO] Worker started execution',
        '2026-09-27T23:00:05Z [INFO] Emitting execution receipt to stdout',
        RECEIPT_LOG_MARKER_START,
        canonicalJson(validReceipt),
        RECEIPT_LOG_MARKER_END,
        '2026-09-27T23:00:06Z [INFO] Container finished with exit code 0',
      ].join('\n');

      const runnerWithMock = createRunnerWithPodLogs(logOutput);
      const extracted = await runnerWithMock.retrieveExecutionReceipt('test-job-ok', workRequest, {
        podName: 'pod-valid',
      });

      expect(extracted).toBeDefined();
      expect(extracted.schema).toBe('ct-agent-execution-receipt.v1');
      expect(extracted.provider_binding_ref).toBe(validReceipt.provider_binding_ref);
      expect(extracted.request_digest).toBe(validReceipt.request_digest);
      expect(extracted.outcome).toBe('succeeded');
    });
  });

  // ==========================================================================
  // 1. Unparseable Garbage JSON -> RECEIPT_MISSING (never INVALID_JSON)
  // ==========================================================================
  describe('1. Unparseable garbage JSON inside log markers -> RECEIPT_MISSING', () => {
    const garbagePayloads = [
      { name: 'random gibberish symbols', payload: '%%%^&*()!@#$_NOT_A_VALID_JSON_{{{' },
      { name: 'truncated JSON object', payload: '{"schema": "ct-agent-execution-receipt.v1", "receipt_id": "rec-1' },
      { name: 'malformed array with unclosed bracket', payload: '{"schema": "ct-agent-execution-receipt.v1", "effects": [' },
      { name: 'unquoted keys and values', payload: '{schema: ct-agent-execution-receipt.v1, outcome: succeeded}' },
      { name: 'trailing comma in object', payload: '{"schema": "ct-agent-execution-receipt.v1", "outcome": "failed",}' },
      { name: 'single-quoted string', payload: "{'schema': 'ct-agent-execution-receipt.v1', 'outcome': 'failed'}" },
      { name: 'invalid floating number format', payload: '{"schema": "ct-agent-execution-receipt.v1", "fencing_epoch": 12.34}' },
      { name: 'invalid exponential number format', payload: '{"schema": "ct-agent-execution-receipt.v1", "fencing_epoch": 1e5}' },
      { name: 'unclosed string literal', payload: '{"schema": "ct-agent-execution-receipt.v1' },
      { name: 'bare non-json word', payload: 'UNDEFINED_NAN_NULL_TOKEN' },
      { name: 'leading zeros in integer', payload: '{"schema": "ct-agent-execution-receipt.v1", "fencing_epoch": 007}' },
    ];

    for (const { name, payload } of garbagePayloads) {
      it(`throws RECEIPT_MISSING for ${name}`, async () => {
        const logOutput = [
          'Pre-marker log line',
          RECEIPT_LOG_MARKER_START,
          payload,
          RECEIPT_LOG_MARKER_END,
          'Post-marker log line',
        ].join('\n');

        const runnerWithMock = createRunnerWithPodLogs(logOutput);

        let caughtError: any;
        try {
          await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-bad-json' });
        } catch (err: any) {
          caughtError = err;
        }

        expect(caughtError).toBeInstanceOf(ContractError);
        expect(caughtError.code).toBe('RECEIPT_MISSING');
        expect(caughtError.code).not.toBe('INVALID_JSON');
        expect(caughtError.code).not.toBe('INVALID_SHAPE');
      });
    }
  });

  // ==========================================================================
  // 2. Invalid Schema Dictionary -> RECEIPT_MISSING (never INVALID_SHAPE)
  // ==========================================================================
  describe('2. Invalid schema dictionary inside log markers -> RECEIPT_MISSING', () => {
    const invalidSchemaDictionaries = [
      { name: 'empty JSON dictionary', dict: {} },
      { name: 'only schema property present', dict: { schema: 'ct-agent-execution-receipt.v1' } },
      {
        name: 'missing observed_at and outcome',
        dict: {
          schema: 'ct-agent-execution-receipt.v1',
          receipt_id: 'rec-12345',
          request_digest: 'sha256:' + '0'.repeat(64),
        },
      },
      {
        name: 'invalid outcome enum value',
        dict: {
          schema: 'ct-agent-execution-receipt.v1',
          receipt_id: 'rec-12345',
          request_digest: 'sha256:' + '0'.repeat(64),
          observed_at: new Date().toISOString(),
          outcome: 'non-existent-outcome',
        },
      },
      {
        name: 'non-array evidence_refs type',
        dict: {
          schema: 'ct-agent-execution-receipt.v1',
          receipt_id: 'rec-12345',
          request_digest: 'sha256:' + '0'.repeat(64),
          observed_at: new Date().toISOString(),
          outcome: 'succeeded',
          evidence_refs: 'not-an-array',
        },
      },
      {
        name: 'invalid numeric types for string ids',
        dict: {
          schema: 'ct-agent-execution-receipt.v1',
          receipt_id: 12345,
          request_digest: 67890,
          observed_at: 99999,
          outcome: 'failed',
        },
      },
      {
        name: 'valid receipt with corrupted non-object scope',
        dict: (() => {
          const r: any = generateSimulationReceipt(workRequest);
          r.scope = 'corrupted-string-scope';
          return r;
        })(),
      },
      {
        name: 'valid receipt with negative attempt number in lease',
        dict: (() => {
          const r: any = generateSimulationReceipt(workRequest);
          r.lease = { attempt: -99, worker_lease_token: 'lease-bad' };
          return r;
        })(),
      },
    ];

    for (const { name, dict } of invalidSchemaDictionaries) {
      it(`throws RECEIPT_MISSING for ${name}`, async () => {
        const logOutput = [
          'Pre-marker log line',
          RECEIPT_LOG_MARKER_START,
          JSON.stringify(dict),
          RECEIPT_LOG_MARKER_END,
          'Post-marker log line',
        ].join('\n');

        const runnerWithMock = createRunnerWithPodLogs(logOutput);

        let caughtError: any;
        try {
          await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-bad-shape' });
        } catch (err: any) {
          caughtError = err;
        }

        expect(caughtError).toBeInstanceOf(ContractError);
        expect(caughtError.code).toBe('RECEIPT_MISSING');
        expect(caughtError.code).not.toBe('INVALID_SHAPE');
        expect(caughtError.code).not.toBe('INVALID_JSON');
      });
    }
  });

  // ==========================================================================
  // 3. Unsupported Schema Name -> RECEIPT_MISSING (never UNSUPPORTED_SCHEMA)
  // ==========================================================================
  describe('3. Unsupported schema name inside log markers -> RECEIPT_MISSING', () => {
    const unsupportedSchemas = [
      { name: 'work-request schema inside receipt log markers', schema: 'ct-agent-work-request.v1' },
      { name: 'future major version receipt schema', schema: 'ct-agent-execution-receipt.v2' },
      { name: 'third-party unknown schema', schema: 'com.vendor.agent.receipt.v1' },
      { name: 'typo in receipt schema name', schema: 'ct-agent-execution-receipt.v1.0' },
      { name: 'empty string schema', schema: '' },
    ];

    for (const { name, schema } of unsupportedSchemas) {
      it(`throws RECEIPT_MISSING for ${name}`, async () => {
        const dict: any = generateSimulationReceipt(workRequest);
        dict.schema = schema;

        const logOutput = [
          'Pre-marker log line',
          RECEIPT_LOG_MARKER_START,
          JSON.stringify(dict),
          RECEIPT_LOG_MARKER_END,
          'Post-marker log line',
        ].join('\n');

        const runnerWithMock = createRunnerWithPodLogs(logOutput);

        let caughtError: any;
        try {
          await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-unsupported-schema' });
        } catch (err: any) {
          caughtError = err;
        }

        expect(caughtError).toBeInstanceOf(ContractError);
        expect(caughtError.code).toBe('RECEIPT_MISSING');
        expect(caughtError.code).not.toBe('UNSUPPORTED_SCHEMA');
        expect(caughtError.code).not.toBe('INVALID_SHAPE');
        expect(caughtError.code).not.toBe('INVALID_JSON');
      });
    }
  });

  // ==========================================================================
  // 4. Duplicate JSON Keys -> RECEIPT_MISSING (never DUPLICATE_JSON_KEY)
  // ==========================================================================
  describe('4. Duplicate JSON keys inside log markers -> RECEIPT_MISSING', () => {
    it('throws RECEIPT_MISSING when top-level duplicate key exists', async () => {
      const validReceipt = generateSimulationReceipt(workRequest);
      const json = canonicalJson(validReceipt);
      // Inject duplicate schema key at the start
      const duplicateKeyJson = '{"schema":"ct-agent-execution-receipt.v1",' + json.slice(1);

      const logOutput = [
        'Pre-marker log line',
        RECEIPT_LOG_MARKER_START,
        duplicateKeyJson,
        RECEIPT_LOG_MARKER_END,
        'Post-marker log line',
      ].join('\n');

      const runnerWithMock = createRunnerWithPodLogs(logOutput);

      let caughtError: any;
      try {
        await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-duplicate-key' });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(ContractError);
      expect(caughtError.code).toBe('RECEIPT_MISSING');
      expect(caughtError.code).not.toBe('DUPLICATE_JSON_KEY');
      expect(caughtError.code).not.toBe('INVALID_JSON');
      expect(caughtError.code).not.toBe('INVALID_SHAPE');
    });

    it('throws RECEIPT_MISSING when conflicting duplicate outcome key exists', async () => {
      const validReceipt = generateSimulationReceipt(workRequest);
      const json = canonicalJson(validReceipt);
      // Inject duplicate conflicting outcome key
      const duplicateOutcomeJson = json.slice(0, -1) + ',"outcome":"failed"}';

      const logOutput = [
        'Pre-marker log line',
        RECEIPT_LOG_MARKER_START,
        duplicateOutcomeJson,
        RECEIPT_LOG_MARKER_END,
        'Post-marker log line',
      ].join('\n');

      const runnerWithMock = createRunnerWithPodLogs(logOutput);

      let caughtError: any;
      try {
        await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-duplicate-outcome' });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(ContractError);
      expect(caughtError.code).toBe('RECEIPT_MISSING');
      expect(caughtError.code).not.toBe('DUPLICATE_JSON_KEY');
      expect(caughtError.code).not.toBe('INVALID_JSON');
    });

    it('throws RECEIPT_MISSING when duplicate key exists in nested scope', async () => {
      const duplicateNestedJson = JSON.stringify({
        schema: 'ct-agent-execution-receipt.v1',
        receipt_id: 'rec-dup-nest',
        observed_at: new Date().toISOString(),
        request_digest: 'sha256:' + 'a'.repeat(64),
        outcome: 'succeeded',
      }).replace(
        '"schema":"ct-agent-execution-receipt.v1"',
        '"schema":"ct-agent-execution-receipt.v1","scope":{"tenant_id":"t1","tenant_id":"t2"}'
      );

      const logOutput = [
        RECEIPT_LOG_MARKER_START,
        duplicateNestedJson,
        RECEIPT_LOG_MARKER_END,
      ].join('\n');

      const runnerWithMock = createRunnerWithPodLogs(logOutput);

      let caughtError: any;
      try {
        await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-duplicate-nested' });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(ContractError);
      expect(caughtError.code).toBe('RECEIPT_MISSING');
      expect(caughtError.code).not.toBe('DUPLICATE_JSON_KEY');
      expect(caughtError.code).not.toBe('INVALID_JSON');
    });
  });

  // ==========================================================================
  // 5. Oversized Payload (>65,536 bytes) -> PAYLOAD_TOO_LARGE
  // ==========================================================================
  describe('5. Oversized payload (>65,536 bytes) inside log markers -> PAYLOAD_TOO_LARGE', () => {
    it('throws PAYLOAD_TOO_LARGE when payload is exactly 65,537 bytes (boundary + 1)', async () => {
      const oversizedRaw = 'a'.repeat(65537);
      const logOutput = [
        'Pre-log',
        RECEIPT_LOG_MARKER_START,
        oversizedRaw,
        RECEIPT_LOG_MARKER_END,
        'Post-log',
      ].join('\n');

      const runnerWithMock = createRunnerWithPodLogs(logOutput);

      let caughtError: any;
      try {
        await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-oversized-65537' });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(ContractError);
      expect(caughtError.code).toBe('PAYLOAD_TOO_LARGE');
      // Crucial: Must NOT be swallowed into RECEIPT_MISSING
      expect(caughtError.code).not.toBe('RECEIPT_MISSING');
    });

    it('throws PAYLOAD_TOO_LARGE when valid JSON receipt is padded beyond 65,536 bytes', async () => {
      const validReceipt = generateSimulationReceipt(workRequest);
      const padding = 'x'.repeat(66000);
      const validReceiptWithPadding = JSON.stringify({
        ...validReceipt,
        __padding_comment: padding,
      });

      expect(Buffer.byteLength(validReceiptWithPadding, 'utf8')).toBeGreaterThan(65536);

      const logOutput = [
        RECEIPT_LOG_MARKER_START,
        validReceiptWithPadding,
        RECEIPT_LOG_MARKER_END,
      ].join('\n');

      const runnerWithMock = createRunnerWithPodLogs(logOutput);

      let caughtError: any;
      try {
        await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-oversized-padded' });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(ContractError);
      expect(caughtError.code).toBe('PAYLOAD_TOO_LARGE');
      expect(caughtError.code).not.toBe('RECEIPT_MISSING');
    });

    it('throws PAYLOAD_TOO_LARGE when UTF-8 multi-byte characters exceed 65,536 bytes', async () => {
      // 32,769 3-byte unicode characters = 98,307 bytes (>65,536 bytes), even though string length is ~32k
      const multiByteString = '⚡'.repeat(32769);
      const buf = Buffer.from(multiByteString, 'utf8');
      expect(buf.byteLength).toBeGreaterThan(65536);

      const logOutput = [
        RECEIPT_LOG_MARKER_START,
        multiByteString,
        RECEIPT_LOG_MARKER_END,
      ].join('\n');

      const runnerWithMock = createRunnerWithPodLogs(logOutput);

      let caughtError: any;
      try {
        await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-oversized-utf8' });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(ContractError);
      expect(caughtError.code).toBe('PAYLOAD_TOO_LARGE');
      expect(caughtError.code).not.toBe('RECEIPT_MISSING');
    });

    it('throws PAYLOAD_TOO_LARGE for huge 1MB payload', async () => {
      const hugePayload = 'B'.repeat(1024 * 1024);
      const logOutput = [
        RECEIPT_LOG_MARKER_START,
        hugePayload,
        RECEIPT_LOG_MARKER_END,
      ].join('\n');

      const runnerWithMock = createRunnerWithPodLogs(logOutput);

      let caughtError: any;
      try {
        await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-oversized-1mb' });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(ContractError);
      expect(caughtError.code).toBe('PAYLOAD_TOO_LARGE');
      expect(caughtError.code).not.toBe('RECEIPT_MISSING');
    });
  });

  // ==========================================================================
  // 6. Systematic Verification: INVALID_JSON and INVALID_SHAPE are NEVER re-thrown
  // ==========================================================================
  describe('6. Exhaustive verification: INVALID_JSON and INVALID_SHAPE are NEVER re-thrown', () => {
    const adversarialProbes = [
      { name: 'incomplete JSON literal true', text: 'tru' },
      { name: 'incomplete JSON literal null', text: 'nul' },
      { name: 'unquoted object key without value', text: '{"key"' },
      { name: 'double colon in object', text: '{"key":: "val"}' },
      { name: 'nested unclosed objects and arrays', text: '[[[[{{{{' },
      { name: 'NaN value token', text: '{"schema": "ct-agent-execution-receipt.v1", "generation": NaN}' },
      { name: 'Infinity value token', text: '{"schema": "ct-agent-execution-receipt.v1", "generation": Infinity}' },
      { name: 'Receipt as array instead of object', text: '[{"schema":"ct-agent-execution-receipt.v1"}]' },
      { name: 'Receipt as string literal', text: '"ct-agent-execution-receipt.v1"' },
      { name: 'Receipt as number literal', text: '12345678' },
      { name: 'Receipt as boolean literal', text: 'true' },
      { name: 'Receipt as null', text: 'null' },
      { name: 'Object with trailing garbage token', text: '{"schema":"ct-agent-execution-receipt.v1"} EXTRA_GARBAGE' },
      { name: 'Invalid escape sequence', text: '{"schema":"ct-agent-execution-receipt.v1", "desc": "\\xZZ"}' },
    ];

    for (const { name, text } of adversarialProbes) {
      it(`guarantees never re-throwing INVALID_JSON or INVALID_SHAPE for: ${name}`, async () => {
        const logOutput = [
          RECEIPT_LOG_MARKER_START,
          text,
          RECEIPT_LOG_MARKER_END,
        ].join('\n');

        const runnerWithMock = createRunnerWithPodLogs(logOutput);

        let caughtError: any;
        try {
          await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-exhaustive' });
        } catch (err: any) {
          caughtError = err;
        }

        expect(caughtError).toBeInstanceOf(ContractError);
        expect(caughtError.code).toBe('RECEIPT_MISSING');
        expect(caughtError.code).not.toBe('INVALID_JSON');
        expect(caughtError.code).not.toBe('INVALID_SHAPE');
        expect(caughtError.code).not.toBe('UNSUPPORTED_SCHEMA');
        expect(caughtError.code).not.toBe('DUPLICATE_JSON_KEY');
      });
    }
  });
});
