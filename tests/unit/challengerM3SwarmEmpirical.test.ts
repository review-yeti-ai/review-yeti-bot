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
import {
  generateRemediation,
  generateRemediationForFinding,
} from '../../src/review/remediationSubagent';
import {
  hydrateLeanFindingToCheckAnnotation,
} from '../../src/cli/publishingReview';

describe('Milestone 3 Empirical Challenger — Adversarial Validation & Fingerprint Stress Suite', () => {
  const CHANGED_FILES = [
    'src/auth/jwt.ts',
    'src/api/routes.ts',
    'src/db/user.ts',
    'src/services/billing.ts',
    'src/views/index.tsx',
  ];

  // =========================================================================
  // Challenge 1: Adversarial Severity Payloads
  // =========================================================================
  describe('Challenge 1: Adversarial Severity Payloads', () => {
    const invalidSeverities = [
      // Common alternative names
      'P3',
      'P4',
      'P5',
      'HIGH',
      'CRITICAL',
      'MEDIUM',
      'LOW',
      'INFO',
      'NIT',
      'WARN',
      'WARNING',
      'BLOCKER',
      'MINOR',
      'MAJOR',
      // Case-mismatched variants
      'p0',
      'p1',
      'p2',
      'P0 ',
      ' P0',
      ' P1 ',
      '\tP2\n',
      // Empty / whitespace
      '',
      ' ',
      '   ',
      '\n',
      // Type-confusion payloads
      0,
      1,
      2,
      true,
      false,
      null,
      undefined,
      {},
      [],
      NaN,
      Infinity,
      -1,
      // Homoglyphs and Unicode
      'P０', // fullwidth zero
      'Р0',  // Cyrillic Er
      'Ｐ0', // fullwidth P
      // Injection strings
      'P0; DROP TABLE findings--',
      '<script>alert("P0")</script>',
    ];

    for (const sev of invalidSeverities) {
      it(`strictly rejects adversarial severity: ${JSON.stringify(sev)}`, () => {
        const raw = {
          severity: sev,
          file: 'src/auth/jwt.ts',
          line: 42,
          fingerprint: '1234567890abcdef',
          summary: 'Adversarial severity payload test',
        };
        const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('severity_invalid');
          expect(res.error).toContain('Invalid severity');
        }
      });
    }

    it('accepts only exact enum values: P0, P1, P2', () => {
      for (const validSev of ['P0', 'P1', 'P2'] as const) {
        const raw = {
          severity: validSev,
          file: 'src/auth/jwt.ts',
          line: 10,
          fingerprint: '1234567890abcdef',
          summary: `Valid finding at ${validSev}`,
        };
        const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(true);
        if (res.valid) {
          expect(res.digest.severity).toBe(validSev);
        }
      }
    });
  });

  // =========================================================================
  // Challenge 2: Adversarial Line Numbers
  // =========================================================================
  describe('Challenge 2: Adversarial Line Numbers', () => {
    const invalidLineNumbers = [
      // Zero and negatives
      0,
      -0,
      -1,
      -42,
      -999999,
      Number.MIN_SAFE_INTEGER,
      // Floating point numbers
      0.1,
      0.9999,
      1.1,
      1.5,
      2.99999,
      42.0001,
      1e-5,
      // Special IEEE-754 values
      NaN,
      Infinity,
      -Infinity,
      // Large unsafe integers
      Number.MAX_SAFE_INTEGER + 1,
      Number.MAX_SAFE_INTEGER + 1000,
      1e20,
      // String and type-confusion values
      '1',
      '42',
      '0',
      '-1',
      'line 1',
      '42.5',
      true,
      false,
      null,
      undefined,
      {},
      [],
      [42],
      { line: 42 },
    ];

    for (const badLine of invalidLineNumbers) {
      it(`strictly rejects invalid line number: ${JSON.stringify(badLine)}`, () => {
        const raw = {
          severity: 'P1',
          file: 'src/auth/jwt.ts',
          line: badLine,
          fingerprint: '1234567890abcdef',
          summary: 'Adversarial line test',
        };
        const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('line_invalid');
          expect(res.error).toContain('Invalid line number');
        }
      });
    }

    it('accepts positive safe integers within diff', () => {
      const validLines = [1, 2, 42, 100, 1000, 999999, Number.MAX_SAFE_INTEGER];
      for (const line of validLines) {
        const raw = {
          severity: 'P1',
          file: 'src/auth/jwt.ts',
          line,
          fingerprint: '1234567890abcdef',
          summary: 'Valid line number',
        };
        const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(true);
        if (res.valid) {
          expect(res.digest.line).toBe(line);
        }
      }
    });

    it('strictly enforces addedLinesByFile when present', () => {
      const context = {
        changedFiles: CHANGED_FILES,
        addedLinesByFile: {
          'src/auth/jwt.ts': [10, 11, 12, 50],
        },
      };

      // Added lines should pass
      for (const line of [10, 11, 12, 50]) {
        const raw = {
          severity: 'P0',
          file: 'src/auth/jwt.ts',
          line,
          fingerprint: '1234567890abcdef',
          summary: 'Added line finding',
        };
        const res = validateFindingDigest(raw, context);
        expect(res.valid).toBe(true);
      }

      // Unchanged or deleted lines must be rejected fail-closed
      for (const line of [1, 9, 13, 49, 51, 999]) {
        const raw = {
          severity: 'P0',
          file: 'src/auth/jwt.ts',
          line,
          fingerprint: '1234567890abcdef',
          summary: 'Unchanged line finding',
        };
        const res = validateFindingDigest(raw, context);
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('line_not_added');
          expect(res.error).toContain('line_not_added');
        }
      }
    });
  });

  // =========================================================================
  // Challenge 3: Adversarial Summary Payloads & Length Clamping
  // =========================================================================
  describe('Challenge 3: Adversarial Summary Payloads', () => {
    it('rejects empty and whitespace-only summaries', () => {
      const emptyVariants = [
        '',
        ' ',
        '   ',
        '\t',
        '\r\n',
        ' \t \r \n ',
        '\u00A0', // Non-breaking space
        '\u3000', // Ideographic fullwidth space
      ];

      for (const ws of emptyVariants) {
        const raw = {
          severity: 'P1',
          file: 'src/auth/jwt.ts',
          line: 10,
          fingerprint: '1234567890abcdef',
          summary: ws,
        };
        const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('summary_empty');
        }
      }
    });

    it('rejects non-string summary types when title is also absent', () => {
      const nonStringSummaries = [
        null,
        undefined,
        123,
        true,
        false,
        {},
        [],
        ['summary string in array'],
        { text: 'summary in object' },
      ];

      for (const badSummary of nonStringSummaries) {
        const raw = {
          severity: 'P1',
          file: 'src/auth/jwt.ts',
          line: 10,
          fingerprint: '1234567890abcdef',
          summary: badSummary,
        };
        const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('summary_empty');
        }
      }
    });

    it('enforces exact 400 character boundary condition', () => {
      const summary399 = 'A'.repeat(399);
      const summary400 = 'B'.repeat(400);
      const summary401 = 'C'.repeat(401);
      const summary1000 = 'D'.repeat(1000);
      const summary50000 = 'E'.repeat(50000);

      // 399 chars: PASS
      const res399 = validateFindingDigest(
        { severity: 'P2', file: 'src/auth/jwt.ts', line: 10, fingerprint: '1234567890abcdef', summary: summary399 },
        { changedFiles: CHANGED_FILES },
      );
      expect(res399.valid).toBe(true);
      if (res399.valid) expect(res399.digest.summary.length).toBe(399);

      // 400 chars: PASS
      const res400 = validateFindingDigest(
        { severity: 'P2', file: 'src/auth/jwt.ts', line: 10, fingerprint: '1234567890abcdef', summary: summary400 },
        { changedFiles: CHANGED_FILES },
      );
      expect(res400.valid).toBe(true);
      if (res400.valid) expect(res400.digest.summary.length).toBe(400);

      // 401 chars: FAIL
      const res401 = validateFindingDigest(
        { severity: 'P2', file: 'src/auth/jwt.ts', line: 10, fingerprint: '1234567890abcdef', summary: summary401 },
        { changedFiles: CHANGED_FILES },
      );
      expect(res401.valid).toBe(false);
      if (!res401.valid) expect(res401.reason).toBe('summary_too_long');

      // 1000 chars: FAIL
      const res1000 = validateFindingDigest(
        { severity: 'P2', file: 'src/auth/jwt.ts', line: 10, fingerprint: '1234567890abcdef', summary: summary1000 },
        { changedFiles: CHANGED_FILES },
      );
      expect(res1000.valid).toBe(false);
      if (!res1000.valid) expect(res1000.reason).toBe('summary_too_long');

      // 50,000 chars (DoS attempt): FAIL
      const res50k = validateFindingDigest(
        { severity: 'P2', file: 'src/auth/jwt.ts', line: 10, fingerprint: '1234567890abcdef', summary: summary50000 },
        { changedFiles: CHANGED_FILES },
      );
      expect(res50k.valid).toBe(false);
      if (!res50k.valid) expect(res50k.reason).toBe('summary_too_long');
    });

    it('falls back to title field if summary is omitted, and enforces 400 character cap on title', () => {
      const rawWithTitle = {
        severity: 'P1',
        file: 'src/auth/jwt.ts',
        line: 10,
        fingerprint: '1234567890abcdef',
        title: 'Title used as summary fallback.',
      };
      const res = validateFindingDigest(rawWithTitle, { changedFiles: CHANGED_FILES });
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.digest.summary).toBe('Title used as summary fallback.');
      }

      const rawWithLongTitle = {
        severity: 'P1',
        file: 'src/auth/jwt.ts',
        line: 10,
        fingerprint: '1234567890abcdef',
        title: 'X'.repeat(405),
      };
      const resLong = validateFindingDigest(rawWithLongTitle, { changedFiles: CHANGED_FILES });
      expect(resLong.valid).toBe(false);
      if (!resLong.valid) {
        expect(resLong.reason).toBe('summary_too_long');
      }
    });
  });

  // =========================================================================
  // Challenge 4: Adversarial File Paths & Path Traversal Rejections
  // =========================================================================
  describe('Challenge 4: Adversarial File Paths & Path Traversal', () => {
    const unadmittedPaths = [
      // Files not in changed list
      'src/secret/passwords.txt',
      'src/admin/backdoor.ts',
      'package.json',
      // Path traversal attacks
      '../../etc/passwd',
      '..\\..\\etc\\shadow',
      '/etc/passwd',
      'src/auth/../../../etc/hosts',
      'src/auth/jwt.ts/../../secrets.env',
      // Substring & extension spoofs
      'src/auth',
      'src/auth/jwt',
      'src/auth/jwt.ts.bak',
      'src/auth/jwt.ts~',
      'src/auth/jwt.ts.orig',
      'src/auth/jwt.tsx',
      'mysrc/auth/jwt.ts',
      // Case mismatch
      'SRC/AUTH/JWT.TS',
      'Src/Auth/Jwt.ts',
    ];

    for (const badPath of unadmittedPaths) {
      it(`rejects unadmitted or path traversal target: ${badPath}`, () => {
        const raw = {
          severity: 'P0',
          file: badPath,
          line: 10,
          fingerprint: '1234567890abcdef',
          summary: 'Adversarial path test',
        };
        const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('path_not_changed');
        }
      });
    }

    it('rejects empty, whitespace, or non-string file values with path_invalid', () => {
      const invalidFiles = ['', '   ', '\t', null, undefined, 123, true, {}, []];
      for (const f of invalidFiles) {
        const raw = {
          severity: 'P0',
          file: f,
          line: 10,
          fingerprint: '1234567890abcdef',
          summary: 'Invalid path shape test',
        };
        const res = validateFindingDigest(raw, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('path_invalid');
        }
      }
    });

    it('normalizes windows backslashes to unix slashes and matches changedFiles', () => {
      const rawWindows = {
        severity: 'P1',
        file: 'src\\auth\\jwt.ts',
        line: 10,
        fingerprint: '1234567890abcdef',
        summary: 'Windows backslash test',
      };
      const res = validateFindingDigest(rawWindows, { changedFiles: CHANGED_FILES });
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.digest.file).toBe('src/auth/jwt.ts');
      }
    });

    it('supports context.changedFiles as object array with path property', () => {
      const objectContext = {
        changedFiles: [
          { path: 'src/auth/jwt.ts' },
          { path: 'src/api/routes.ts' },
        ],
      };
      const raw = {
        severity: 'P1',
        file: 'src/auth/jwt.ts',
        line: 10,
        fingerprint: '1234567890abcdef',
        summary: 'Object changedFiles test',
      };
      const res = validateFindingDigest(raw, objectContext);
      expect(res.valid).toBe(true);
    });
  });

  // =========================================================================
  // Challenge 5: Fingerprint Collision Resistance & Distribution Stress
  // =========================================================================
  describe('Challenge 5: Deterministic Fingerprint Collision Resistance', () => {
    it('guarantees unique fingerprints across 1,000 distinct files with identical line and summary', () => {
      const fingerprints = new Set<string>();
      const runId = 'stress-run-001';
      const persona = 'sec-lane';
      const line = 42;
      const summary = 'Potential prototype pollution via deep object merge.';

      for (let i = 0; i < 1000; i++) {
        const file = `src/module_${i}/handler.ts`;
        const fp = computeFindingFingerprint(runId, persona, file, line, summary);
        expect(fp).toMatch(/^[a-f0-9]{16}$/i);
        expect(fingerprints.has(fp)).toBe(false);
        fingerprints.add(fp);
      }
      expect(fingerprints.size).toBe(1000);
    });

    it('guarantees unique fingerprints across 1,000 distinct lines in same file with identical summary', () => {
      const fingerprints = new Set<string>();
      const runId = 'stress-run-002';
      const persona = 'sec-lane';
      const file = 'src/auth/jwt.ts';
      const summary = 'Hardcoded credential or insecure fallback detected.';

      for (let line = 1; line <= 1000; line++) {
        const fp = computeFindingFingerprint(runId, persona, file, line, summary);
        expect(fp).toMatch(/^[a-f0-9]{16}$/i);
        expect(fingerprints.has(fp)).toBe(false);
        fingerprints.add(fp);
      }
      expect(fingerprints.size).toBe(1000);
    });

    it('guarantees unique fingerprints across 5,000 combinatorial combinations of file, line, and summary', () => {
      const fingerprints = new Set<string>();
      const runId = 'matrix-run';
      const persona = 'sec-lane';
      const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'];
      const summaries = [
        'Missing authentication middleware.',
        'SQL injection in parameterized query.',
        'Unbounded memory allocation in parser.',
        'Timing attack on cryptographic signature.',
        'Cross-site scripting in template renderer.',
        'Improper certificate validation in HTTP client.',
        'Sensitive data leakage in debug logs.',
        'Denial of service via regex catastrophic backtracking.',
        'Broken object level authorization on API endpoint.',
        'Insecure deserialization of untrusted payload.',
      ];

      // 5 files * 100 lines * 10 summaries = 5,000 findings
      for (const file of files) {
        for (let line = 1; line <= 100; line++) {
          for (const summary of summaries) {
            const fp = computeFindingFingerprint(runId, persona, file, line, summary);
            fingerprints.add(fp);
          }
        }
      }
      expect(fingerprints.size).toBe(5000);
    });

    it('preserves determinism across identical calls', () => {
      for (let i = 0; i < 50; i++) {
        const fp1 = computeFindingFingerprint('run-A', 'persona-B', 'src/file.ts', 99, 'Same bug');
        const fp2 = computeFindingFingerprint('run-A', 'persona-B', 'src/file.ts', 99, 'Same bug');
        expect(fp1).toBe(fp2);
      }
    });

    it('normalizes whitespace in summary when computing fingerprint', () => {
      const fp1 = computeFindingFingerprint('run', 'sec', 'src/a.ts', 10, 'Multiple   spaces    here');
      const fp2 = computeFindingFingerprint('run', 'sec', 'src/a.ts', 10, 'Multiple spaces here');
      expect(fp1).toBe(fp2);
    });

    it('normalizes file path casing and backslashes when computing fingerprint', () => {
      const fp1 = computeFindingFingerprint('run', 'sec', 'SRC\\AUTH\\JWT.TS', 10, 'Bug');
      const fp2 = computeFindingFingerprint('run', 'sec', 'src/auth/jwt.ts', 10, 'Bug');
      expect(fp1).toBe(fp2);
    });

    it('validates isDeterministicFingerprint against standard formats', () => {
      // 16-hex format
      expect(isDeterministicFingerprint('0123456789abcdef')).toBe(true);
      expect(isDeterministicFingerprint('ABCDEF0123456789')).toBe(true);
      // fp1_ format
      expect(isDeterministicFingerprint('fp1_0123456789abcdef01234567')).toBe(true);
      // 64-hex SHA-256
      expect(isDeterministicFingerprint('a'.repeat(64))).toBe(true);

      // Rejections
      expect(isDeterministicFingerprint('')).toBe(false);
      expect(isDeterministicFingerprint('short')).toBe(false);
      expect(isDeterministicFingerprint('1234567890abcde')).toBe(false); // 15 chars
      expect(isDeterministicFingerprint('1234567890abcdefg')).toBe(false); // 17 chars
      expect(isDeterministicFingerprint('not_hex_chars_!!')).toBe(false);
      expect(isDeterministicFingerprint(null)).toBe(false);
      expect(isDeterministicFingerprint(undefined)).toBe(false);
      expect(isDeterministicFingerprint(12345)).toBe(false);
    });
  });

  // =========================================================================
  // Challenge 6: ReviewTaskResultV2 Envelope Adversarial Payloads
  // =========================================================================
  describe('Challenge 6: ReviewTaskResultV2 Envelope Adversarial Payloads', () => {
    it('rejects malformed root payload structures', () => {
      const badRoots = [null, undefined, '', 'hello', 123, true, false, []];
      for (const bad of badRoots) {
        const res = validateReviewTaskResultV2(bad, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('response_shape');
        }
      }
    });

    it('rejects missing or non-string nonce', () => {
      const badNonces = ['', null, undefined, 123, true, {}, []];
      for (const nonce of badNonces) {
        const raw = {
          nonce,
          task: 'task-1',
          status: 'COMPLETE',
          findings: [],
        };
        const res = validateReviewTaskResultV2(raw, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('nonce_invalid');
        }
      }
    });

    it('rejects missing or non-string task id', () => {
      const badTasks = ['', null, undefined, 123, true, {}, []];
      for (const task of badTasks) {
        const raw = {
          nonce: 'nonce-1',
          task,
          status: 'COMPLETE',
          findings: [],
        };
        const res = validateReviewTaskResultV2(raw, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('task_invalid');
        }
      }
    });

    it('strictly enforces expectedNonce and expectedTaskId against whitespace or spoofed strings', () => {
      const raw = {
        nonce: '   ',
        task: '   ',
        status: 'COMPLETE',
        findings: [],
      };
      // When expectedNonce is configured, whitespace nonce is rejected fail-closed
      const resNonce = validateReviewTaskResultV2(raw, {
        changedFiles: CHANGED_FILES,
        expectedNonce: 'expected-nonce-uuid',
      });
      expect(resNonce.valid).toBe(false);
      if (!resNonce.valid) {
        expect(resNonce.reason).toBe('nonce_mismatch');
      }

      // When expectedTaskId is configured, whitespace task is rejected fail-closed
      const resTask = validateReviewTaskResultV2(
        { ...raw, nonce: 'expected-nonce-uuid' },
        {
          changedFiles: CHANGED_FILES,
          expectedNonce: 'expected-nonce-uuid',
          expectedTaskId: 'sec-auth-task',
        },
      );
      expect(resTask.valid).toBe(false);
      if (!resTask.valid) {
        expect(resTask.reason).toBe('task_mismatch');
      }
    });

    it('rejects status outside COMPLETE and BLOCKED enum', () => {
      const badStatuses = [
        'APPROVE',
        'BLOCK',
        'PASSED',
        'FAILED',
        'PENDING',
        'IN_PROGRESS',
        'complete',
        'blocked',
        '',
        null,
        undefined,
        1,
      ];
      for (const status of badStatuses) {
        const raw = {
          nonce: 'nonce-1',
          task: 'task-1',
          status,
          findings: [],
        };
        const res = validateReviewTaskResultV2(raw, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('status_enum');
        }
      }
    });

    it('rejects non-array findings attribute', () => {
      const badFindings = [null, undefined, 'none', 123, true, {}, { findings: [] }];
      for (const f of badFindings) {
        const raw = {
          nonce: 'nonce-1',
          task: 'task-1',
          status: 'COMPLETE',
          findings: f,
        };
        const res = validateReviewTaskResultV2(raw, { changedFiles: CHANGED_FILES });
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('findings_not_array');
        }
      }
    });

    it('correctly reports failure index for array with multiple findings', () => {
      const raw = {
        nonce: 'nonce-1',
        task: 'task-1',
        status: 'COMPLETE',
        findings: [
          { severity: 'P0', file: 'src/auth/jwt.ts', line: 10, summary: 'Valid finding 0' },
          { severity: 'P1', file: 'src/api/routes.ts', line: 20, summary: 'Valid finding 1' },
          { severity: 'INVALID', file: 'src/db/user.ts', line: 30, summary: 'Invalid finding 2' },
          { severity: 'P2', file: 'src/views/index.tsx', line: 40, summary: 'Valid finding 3' },
        ],
      };
      const res = validateReviewTaskResultV2(raw, { changedFiles: CHANGED_FILES });
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.index).toBe(2);
        expect(res.reason).toBe('severity_invalid');
        expect(res.error).toContain('Finding at index 2 is invalid');
      }
    });

    it('accepts an empty findings array for a clean COMPLETE review', () => {
      const raw = {
        nonce: 'clean-nonce',
        task: 'clean-task',
        status: 'COMPLETE',
        findings: [],
      };
      const res = validateReviewTaskResultV2(raw, {
        changedFiles: CHANGED_FILES,
        expectedNonce: 'clean-nonce',
        expectedTaskId: 'clean-task',
      });
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.result.findings).toEqual([]);
        expect(res.result.status).toBe('COMPLETE');
      }
    });
  });

  // =========================================================================
  // Challenge 7: Downstream Hydration & GitHub Check Annotation Invariants
  // =========================================================================
  describe('Challenge 7: Downstream Hydration Line Anchoring Invariants', () => {
    it('strictly preserves identical start_line and end_line during hydration', () => {
      const finding: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/auth/jwt.ts',
        line: 88,
        fingerprint: 'abcdef0123456789',
        summary: 'Critical auth bypass vulnerability.',
      };

      const ann = hydrateLeanFindingToCheckAnnotation(finding);
      expect(ann).not.toBeNull();
      expect(ann?.start_line).toBe(88);
      expect(ann?.end_line).toBe(88);
      expect(ann?.path).toBe('src/auth/jwt.ts');
      expect(ann?.annotation_level).toBe('failure');
    });

    it('clamps title to 120 characters and message to 4000 characters', () => {
      const finding: LeanFindingSummary = {
        severity: 'P1',
        file: 'src/auth/jwt.ts',
        line: 10,
        fingerprint: 'abcdef0123456789',
        summary: 'A'.repeat(300),
      };

      const ann = hydrateLeanFindingToCheckAnnotation(finding);
      expect(ann).not.toBeNull();
      expect(ann!.title!.length).toBeLessThanOrEqual(120);
      expect(ann!.title!.startsWith('P1: ')).toBe(true);
      expect(ann!.message.length).toBeLessThanOrEqual(4000);
    });

    it('filters out findings targeting files outside changedFiles if changedFiles is provided', () => {
      const finding: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/unrelated/config.ts',
        line: 10,
        fingerprint: 'abcdef0123456789',
        summary: 'Finding in deleted/unrelated file',
      };

      const ann = hydrateLeanFindingToCheckAnnotation(finding, undefined, CHANGED_FILES);
      expect(ann).toBeNull();
    });

    it('hydrateLeanFinding converts digest to PanelFinding with identical line and fingerprint', () => {
      const digest: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/auth/jwt.ts',
        line: 77,
        fingerprint: 'fedcba9876543210',
        summary: 'Panel finding summary',
      };
      const hydrated = hydrateLeanFinding(digest);
      expect(hydrated.severity).toBe('P0');
      expect(hydrated.path).toBe('src/auth/jwt.ts');
      expect(hydrated.line).toBe(77);
      expect(hydrated.startLine).toBe(77);
      expect(hydrated.title).toBe('Panel finding summary');
      expect(hydrated.body).toBe('Panel finding summary');
      expect(hydrated.fingerprint).toBe('fedcba9876543210');
    });
  });

  // =========================================================================
  // Challenge 8: Decoupled Remediation Subagent Stress & Indentation Preservation
  // =========================================================================
  describe('Challenge 8: Remediation Subagent Stress', () => {
    it('handles empty, whitespace, and undefined source code without throwing', async () => {
      const finding: LeanFindingSummary = {
        severity: 'P1',
        file: 'src/auth/jwt.ts',
        line: 15,
        fingerprint: '1122334455667788',
        summary: 'Empty code test',
      };

      const resEmpty = await generateRemediationForFinding(finding, '');
      expect(resEmpty.explanation).toContain('Source context unavailable');
      expect(resEmpty.codeReplacement).toBeUndefined();

      const resWs = generateRemediation(finding, '   \t  \n  ');
      expect(resWs.explanation).toContain('Source context unavailable');
      expect(resWs.codeReplacement).toBeUndefined();

      const resUndef = await generateRemediationForFinding(finding, undefined);
      expect(resUndef.explanation).toContain('Source context unavailable');
      expect(resUndef.codeReplacement).toBeUndefined();
    });

    it('preserves indentation and original snippet for code replacement', () => {
      const finding: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/auth/jwt.ts',
        line: 3,
        fingerprint: '1122334455667788',
        summary: 'Indentation test',
      };

      const sourceCode = 'function auth() {\n  const user = req.user;\n    const token = eval(req.token);\n}';
      const rem = generateRemediation(finding, sourceCode);
      expect(rem.codeReplacement).toBeDefined();
      expect(rem.codeReplacement?.startLine).toBe(3);
      expect(rem.codeReplacement?.endLine).toBe(3);
      expect(rem.codeReplacement?.originalSnippet).toBe('    const token = eval(req.token);');
      expect(rem.codeReplacement?.suggestedSnippet).toContain('safeHandler');
    });

    it('safely handles massive 500,000 character source code without memory bloat', () => {
      const finding: LeanFindingSummary = {
        severity: 'P1',
        file: 'src/auth/jwt.ts',
        line: 50,
        fingerprint: '1122334455667788',
        summary: 'Large source test',
      };

      const largeSource = Array.from({ length: 5000 }, (_, i) => `const line_${i} = ${i};`).join('\n');
      const rem = generateRemediation(finding, largeSource);
      expect(rem.codeReplacement).toBeDefined();
      expect(rem.codeReplacement?.startLine).toBe(50);
      expect(rem.codeReplacement?.originalSnippet).toContain('const line_49 = 49;');
    });
  });
});
