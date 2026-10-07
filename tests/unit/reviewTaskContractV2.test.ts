import { describe, it, expect } from 'vitest';
import {
  validateReviewTaskResultV2,
  validateFindingDigest,
  computeFindingFingerprint,
  isDeterministicFingerprint,
  hydrateLeanFinding,
  type LeanFindingSummary,
  type ReviewTaskResultV2,
} from '../../src/reviewTaskContract';
import { buildTaskResultV2ResponseFormat } from '../../src/panel/composedEngine';

describe('ReviewTaskContract v2 — Lean Finding Schema & Validation', () => {
  const CHANGED_FILES = ['src/auth/jwt.ts', 'src/api/routes.ts', 'src/db/user.ts'];

  describe('5-tuple Lean Finding Summary validation', () => {
    it('accepts a fully conforming 5-tuple digest', () => {
      const raw = {
        severity: 'P0',
        file: 'src/auth/jwt.ts',
        line: 42,
        fingerprint: '1234567890abcdef',
        summary: 'Missing token signature check.',
      };
      const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.digest).toEqual({
          severity: 'P0',
          file: 'src/auth/jwt.ts',
          line: 42,
          fingerprint: '1234567890abcdef',
          summary: 'Missing token signature check.',
        });
      }
    });

    it('rejects severity levels outside P0, P1, P2', () => {
      const severities = ['HIGH', 'CRITICAL', 'P3', 'NIT', 'INFO', 'LOW', '', null, undefined];
      for (const sev of severities) {
        const raw = {
          severity: sev,
          file: 'src/auth/jwt.ts',
          line: 42,
          fingerprint: '1234567890abcdef',
          summary: 'Missing token signature check.',
        };
        const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('severity_invalid');
        }
      }
    });

    it('rejects findings with empty or whitespace-only summaries', () => {
      const emptySummaries = ['', '   ', '\t\n'];
      for (const summary of emptySummaries) {
        const raw = {
          severity: 'P1',
          file: 'src/auth/jwt.ts',
          line: 10,
          fingerprint: '1234567890abcdef',
          summary,
        };
        const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('summary_empty');
        }
      }
    });

    it('rejects summaries exceeding the 400 character cap', () => {
      const longSummary = 'A'.repeat(401);
      const raw = {
        severity: 'P1',
        file: 'src/auth/jwt.ts',
        line: 10,
        fingerprint: '1234567890abcdef',
        summary: longSummary,
      };
      const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.reason).toBe('summary_too_long');
      }
    });

    it('accepts summaries up to exactly 400 characters', () => {
      const boundarySummary = 'B'.repeat(400);
      const raw = {
        severity: 'P2',
        file: 'src/api/routes.ts',
        line: 15,
        fingerprint: '1234567890abcdef',
        summary: boundarySummary,
      };
      const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.digest.summary).toBe(boundarySummary);
      }
    });

    it('rejects non-integer, zero, or negative line numbers', () => {
      const badLines = [0, -1, -99, 1.5, NaN, Infinity, '10', null, undefined];
      for (const line of badLines) {
        const raw = {
          severity: 'P1',
          file: 'src/auth/jwt.ts',
          line,
          fingerprint: '1234567890abcdef',
          summary: 'Invalid line hazard.',
        };
        const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('line_invalid');
        }
      }
    });

    it('rejects files not present in changed files list', () => {
      const raw = {
        severity: 'P0',
        file: 'src/secret/config.env',
        line: 1,
        fingerprint: '1234567890abcdef',
        summary: 'Secret exposed.',
      };
      const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.reason).toBe('path_not_changed');
      }
    });

    it('normalizes windows backslash file paths before checking changed files', () => {
      const raw = {
        severity: 'P1',
        file: 'src\\auth\\jwt.ts',
        line: 10,
        fingerprint: '1234567890abcdef',
        summary: 'Path with backslashes.',
      };
      const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.digest.file).toBe('src/auth/jwt.ts');
      }
    });

    it('rejects line numbers not in added lines when addedLinesByFile is provided', () => {
      const raw = {
        severity: 'P1',
        file: 'src/auth/jwt.ts',
        line: 99,
        fingerprint: '1234567890abcdef',
        summary: 'Deleted or unchanged line.',
      };
      const res = validateFindingDigest(raw, {
        changedFiles: CHANGED_FILES,
        addedLinesByFile: { 'src/auth/jwt.ts': [10, 11, 12] },
      });
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.reason).toBe('line_not_added');
      }
    });

    it('sanitizes overly verbose payloads with legacy body/replacementCode into lean 5-tuples', () => {
      const verboseRaw = {
        severity: 'P0',
        file: 'src/auth/jwt.ts',
        line: 5,
        summary: 'SQL injection vulnerability.',
        title: 'SQL injection vulnerability.',
        body: 'Huge verbose body text explaining vulnerability details at length.',
        suggestion: 'Use parameterized queries instead.',
        replacementCode: 'db.query("SELECT * FROM users WHERE id = $1", [id]);',
        extraField: 'should be stripped',
      };
      const res = validateFindingDigest(verboseRaw, { changedFiles: CHANGED_FILES });
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.digest).toEqual({
          severity: 'P0',
          file: 'src/auth/jwt.ts',
          line: 5,
          fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/i),
          summary: 'SQL injection vulnerability.',
        });
        expect((res.digest as any).body).toBeUndefined();
        expect((res.digest as any).replacementCode).toBeUndefined();
        expect((res.digest as any).extraField).toBeUndefined();
      }
    });
  });

  describe('Fingerprint Generation & Deduplication', () => {
    it('preserves valid 16-hex and fp1_ deterministic fingerprints', () => {
      const hex16 = '0123456789abcdef';
      const fp1 = 'fp1_0123456789abcdef01234567';
      expect(isDeterministicFingerprint(hex16)).toBe(true);
      expect(isDeterministicFingerprint(fp1)).toBe(true);

      const resHex = validateFindingDigest(
        { severity: 'P0', file: 'src/auth/jwt.ts', line: 10, fingerprint: hex16, summary: 'Issue A' },
        { changedFiles: CHANGED_FILES },
      );
      expect(resHex.valid).toBe(true);
      if (resHex.valid) expect(resHex.digest.fingerprint).toBe(hex16);

      const resFp1 = validateFindingDigest(
        { severity: 'P0', file: 'src/auth/jwt.ts', line: 10, fingerprint: fp1, summary: 'Issue B' },
        { changedFiles: CHANGED_FILES },
      );
      expect(resFp1.valid).toBe(true);
      if (resFp1.valid) expect(resFp1.digest.fingerprint).toBe(fp1);
    });

    it('generates deterministic 16-hex SHA-256 fingerprint when omitted or non-conforming', () => {
      const raw = {
        severity: 'P1',
        file: 'src/auth/jwt.ts',
        line: 12,
        summary: 'Insecure direct object reference.',
      };
      const res1 = validateFindingDigest(raw, { changedFiles: CHANGED_FILES, runId: 'run-1', persona: 'sec-lane' });
      const res2 = validateFindingDigest(raw, { changedFiles: CHANGED_FILES, runId: 'run-1', persona: 'sec-lane' });
      expect(res1.valid).toBe(true);
      expect(res2.valid).toBe(true);
      if (res1.valid && res2.valid) {
        expect(res1.digest.fingerprint).toBe(res2.digest.fingerprint);
        expect(res1.digest.fingerprint).toMatch(/^[a-f0-9]{16}$/i);
      }
    });

    it('demonstrates collision resistance across different files with identical summaries', () => {
      const fpA = computeFindingFingerprint('run-1', 'sec', 'src/auth/jwt.ts', 10, 'Common null dereference');
      const fpB = computeFindingFingerprint('run-1', 'sec', 'src/api/routes.ts', 10, 'Common null dereference');
      expect(fpA).not.toBe(fpB);
    });
  });

  describe('ReviewTaskResultV2 Envelope Validation', () => {
    it('validates a complete conforming ReviewTaskResultV2 payload', () => {
      const raw: ReviewTaskResultV2 = {
        nonce: 'nonce-abc-123',
        task: 'task-auth-audit',
        status: 'COMPLETE',
        blockedReason: null,
        findings: [
          {
            severity: 'P0',
            file: 'src/auth/jwt.ts',
            line: 42,
            fingerprint: '1234567890abcdef',
            summary: 'Missing signature verification.',
          },
          {
            severity: 'P2',
            file: 'src/api/routes.ts',
            line: 18,
            fingerprint: 'abcdef1234567890',
            summary: 'Missing route description.',
          },
        ],
      };

      const res = validateReviewTaskResultV2(raw, {
        changedFiles: CHANGED_FILES,
        expectedNonce: 'nonce-abc-123',
        expectedTaskId: 'task-auth-audit',
      });
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.result.findings.length).toBe(2);
        expect(res.result.status).toBe('COMPLETE');
        expect(res.result.nonce).toBe('nonce-abc-123');
        expect(res.result.task).toBe('task-auth-audit');
      }
    });

    it('validates a BLOCKED ReviewTaskResultV2 payload with blockedReason', () => {
      const raw = {
        nonce: 'nonce-xyz',
        task: 'task-auth-audit',
        status: 'BLOCKED',
        blockedReason: 'tool_evidence_unavailable',
        findings: [],
      };
      const res = validateReviewTaskResultV2(raw, {
        changedFiles: CHANGED_FILES,
        expectedNonce: 'nonce-xyz',
      });
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.result.status).toBe('BLOCKED');
        expect(res.result.blockedReason).toBe('tool_evidence_unavailable');
      }
    });

    it('rejects nonce mismatch fail-closed', () => {
      const raw = {
        nonce: 'wrong-nonce',
        task: 'task-1',
        status: 'COMPLETE',
        findings: [],
      };
      const res = validateReviewTaskResultV2(raw, {
        changedFiles: CHANGED_FILES,
        expectedNonce: 'expected-nonce',
      });
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.reason).toBe('nonce_mismatch');
      }
    });

    it('rejects task mismatch fail-closed', () => {
      const raw = {
        nonce: 'nonce-1',
        task: 'wrong-task',
        status: 'COMPLETE',
        findings: [],
      };
      const res = validateReviewTaskResultV2(raw, {
        changedFiles: CHANGED_FILES,
        expectedTaskId: 'expected-task',
      });
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.reason).toBe('task_mismatch');
      }
    });

    it('rejects invalid status enum values', () => {
      const raw = {
        nonce: 'nonce-1',
        task: 'task-1',
        status: 'APPROVE',
        findings: [],
      };
      const res = validateReviewTaskResultV2(raw, { changedFiles: CHANGED_FILES });
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.reason).toBe('status_enum');
      }
    });

    it('rejects when findings is not an array', () => {
      const raw = {
        nonce: 'nonce-1',
        task: 'task-1',
        status: 'COMPLETE',
        findings: 'none',
      };
      const res = validateReviewTaskResultV2(raw, { changedFiles: CHANGED_FILES });
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.reason).toBe('findings_not_array');
      }
    });

    it('reports the exact invalid finding index when an item in findings fails validation', () => {
      const raw = {
        nonce: 'nonce-1',
        task: 'task-1',
        status: 'COMPLETE',
        findings: [
          { severity: 'P0', file: 'src/auth/jwt.ts', line: 10, summary: 'Good' },
          { severity: 'INVALID', file: 'src/auth/jwt.ts', line: 20, summary: 'Bad' },
        ],
      };
      const res = validateReviewTaskResultV2(raw, { changedFiles: CHANGED_FILES });
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.index).toBe(1);
        expect(res.reason).toBe('severity_invalid');
      }
    });
  });

  describe('Downstream Hydration & Response Format', () => {
    it('hydrateLeanFinding converts LeanFindingSummary to PanelFinding format', () => {
      const summary: LeanFindingSummary = {
        severity: 'P1',
        file: 'src/auth/jwt.ts',
        line: 25,
        fingerprint: '1234567890abcdef',
        summary: 'Hardcoded JWT secret.',
      };
      const panelFinding = hydrateLeanFinding(summary);
      expect(panelFinding).toEqual({
        severity: 'P1',
        path: 'src/auth/jwt.ts',
        line: 25,
        startLine: 25,
        title: 'Hardcoded JWT secret.',
        body: 'Hardcoded JWT secret.',
        fingerprint: '1234567890abcdef',
      });
    });

    it('buildTaskResultV2ResponseFormat emits ct_review_task_result_v2 schema', () => {
      const format = buildTaskResultV2ResponseFormat();
      expect(format.type).toBe('json_schema');
      expect(format.json_schema.name).toBe('ct_review_task_result_v2');
      expect(format.json_schema.strict).toBe(true);
      expect(format.json_schema.schema.required).toEqual([
        'nonce',
        'task',
        'status',
        'blockedReason',
        'findings',
      ]);
      const findingProps = format.json_schema.schema.properties.findings.items.properties;
      expect(findingProps.severity.enum).toEqual(['P0', 'P1', 'P2']);
      expect(findingProps.summary.maxLength).toBe(400);
      expect(format.json_schema.schema.properties.findings.items.required).toEqual([
        'severity',
        'file',
        'line',
        'fingerprint',
        'summary',
      ]);
    });
  });
});
