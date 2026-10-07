import { describe, it, expect } from 'vitest';
import {
  executeGetHunk,
  get_hunk,
  parseDiffHunks,
  runReadOnlyTool,
  GET_HUNK_TOOL_SCHEMA,
  type GetHunkArgs,
  type ToolRuntimeContext,
} from '../../src/panel/toolRuntime';
import {
  COMPOSED_READ_ONLY_TOOL_CONTRACT,
  executeComposedReadOnlyTool,
} from '../../src/panel/composedEngine';

describe('Empirical Challenger 1: get_hunk Adversarial & Stress Testing', () => {
  const samplePatches: Record<string, string> = {
    'src/auth/jwt.ts': [
      '@@ -10,6 +10,8 @@ export function verifyToken(token: string): boolean {',
      '   if (!token) return false;',
      '-  const secret = "legacy_secret";',
      '+  const secret = process.env.JWT_SECRET;',
      '+  if (!secret) throw new Error("JWT_SECRET missing");',
      '   return jwt.verify(token, secret);',
      ' }',
    ].join('\n'),
    'src/multi/service.ts': [
      '@@ -20,5 +20,7 @@ export class MultiService {',
      '   constructor() {',
      '-    this.initOld();',
      '+    this.initV2();',
      '+    this.registerMetrics();',
      '   }',
      ' }',
      '@@ -80,5 +82,7 @@ export function processJob() {',
      '   logStart();',
      '-  doLegacyWork();',
      '+  doAsyncWork();',
      '+  flushQueue();',
      '   return true;',
      ' }',
      '@@ -150,5 +154,7 @@ export function shutdown() {',
      '   stopWorkers();',
      '-  closeSync();',
      '+  await closeAsync();',
      '+  cleanupPool();',
      '   return 0;',
      ' }',
    ].join('\n'),
    'src/delete/only.ts': [
      '@@ -30,5 +30,0 @@ export function obsoleteFunction() {',
      '-  step1();',
      '-  step2();',
      '-  step3();',
      '-  step4();',
      '-  step5();',
      ' }',
    ].join('\n'),
    'src/empty/file.ts': '',
  };

  // =========================================================================
  // 1. PATH TRAVERSAL & MALFORMED PATH ATTACKS
  // =========================================================================
  describe('Dimension 1: Path Traversal & Fail-Closed Path Sanitization', () => {
    const traversalAttacks = [
      { name: 'relative path traversal with etc/passwd', path: '../../etc/passwd' },
      { name: 'deep traversal with etc/shadow', path: '../../../../etc/shadow' },
      { name: 'traversal to windows system32', path: '..\\..\\windows\\system32' },
      { name: 'traversal inside directory path', path: 'src/auth/../../etc/passwd' },
      { name: 'traversal to secret.env', path: '../secret.env' },
      { name: 'traversal with dot-dot and slashes', path: '../../../var/log/syslog' },
      { name: 'absolute unix path /etc/passwd', path: '/etc/passwd' },
      { name: 'absolute unix path /root/.ssh/id_rsa', path: '/root/.ssh/id_rsa' },
      { name: 'absolute unix path /Users/jasonbarbee/secret', path: '/Users/jasonbarbee/secret' },
      { name: 'UNC windows path \\\\server\\share\\file.ts', path: '\\\\server\\share\\file.ts' },
      { name: 'leading slash with admitted file', path: '/src/auth/jwt.ts' },
    ];

    for (const { name, path } of traversalAttacks) {
      it(`fails closed against ${name}: "${path}"`, () => {
        const res = executeGetHunk(
          { filePath: path, startLine: 1, endLine: 10 },
          samplePatches,
        );
        expect(res.status).toBe('rejected');
        if (res.status === 'rejected') {
          expect(res.error).toBe('invalid_arguments');
          expect(res.message).toContain('Path traversal or absolute path not allowed');
        }
      });
    }

    const unadmittedOrEncodedPaths = [
      { name: 'URL-encoded double dot ..%2f', path: '..%2f..%2fetc/passwd', expectedError: 'invalid_arguments' },
      { name: 'URL-encoded backslash ..%5c', path: '..%5c..%5cetc/passwd', expectedError: 'invalid_arguments' },
      { name: 'URL-encoded %2e%2e', path: '%2e%2e/%2e%2e/etc/passwd', expectedError: 'path_not_changed' },
      { name: 'Null byte injection in path', path: 'src/auth/jwt.ts\0.js', expectedError: 'path_not_changed' },
      { name: 'Windows drive path without slash', path: 'C:windows\\system32', expectedError: 'path_not_changed' },
      { name: 'Unadmitted foreign file', path: 'src/secret/keys.pem', expectedError: 'path_not_changed' },
    ];

    for (const { name, path, expectedError } of unadmittedOrEncodedPaths) {
      it(`fails closed against ${name}: "${path}" with ${expectedError}`, () => {
        const res = executeGetHunk(
          { filePath: path, startLine: 1, endLine: 10 },
          samplePatches,
        );
        expect(res.status).toBe('rejected');
        if (res.status === 'rejected') {
          expect(res.error).toBe(expectedError);
        }
      });
    }

    it('rejects empty or whitespace-only paths fail-closed with invalid_arguments', () => {
      const emptyRes = executeGetHunk({ filePath: '', startLine: 1, endLine: 10 }, samplePatches);
      expect(emptyRes.status).toBe('rejected');
      if (emptyRes.status === 'rejected') {
        expect(emptyRes.error).toBe('invalid_arguments');
      }

      const wsRes = executeGetHunk({ filePath: '   ', startLine: 1, endLine: 10 }, samplePatches);
      expect(wsRes.status).toBe('rejected');
      if (wsRes.status === 'rejected') {
        expect(wsRes.error).toBe('invalid_arguments');
      }

      const nullRes = executeGetHunk({ filePath: null as any, startLine: 1, endLine: 10 }, samplePatches);
      expect(nullRes.status).toBe('rejected');
      if (nullRes.status === 'rejected') {
        expect(nullRes.error).toBe('invalid_arguments');
      }
    });

    it('preserves precise file matching and rejects partial prefix collisions', () => {
      // Admitted: 'src/auth/jwt.ts'
      // Suffix matching allows 'jwt.ts' and 'auth/jwt.ts'
      expect(executeGetHunk({ filePath: 'jwt.ts', startLine: 10, endLine: 15 }, samplePatches).status).toBe('success');
      expect(executeGetHunk({ filePath: 'auth/jwt.ts', startLine: 10, endLine: 15 }, samplePatches).status).toBe('success');

      // But should reject unrelated prefixes ending with different filename
      expect(executeGetHunk({ filePath: 'fake_jwt.ts', startLine: 10, endLine: 15 }, samplePatches).status).toBe('rejected');
      expect(executeGetHunk({ filePath: 'not_auth/jwt.ts', startLine: 10, endLine: 15 }, samplePatches).status).toBe('rejected');
    });
  });

  // =========================================================================
  // 2. BOUNDARY LINE RANGES & ANOMALIES
  // =========================================================================
  describe('Dimension 2: Boundary Line Ranges & Malformed Inputs', () => {
    it('rejects inverted line ranges (startLine > endLine) with invalid_arguments', () => {
      const pairs = [
        [100, 50],
        [2, 1],
        [1000, 999],
        [50, 49],
      ];
      for (const [start, end] of pairs) {
        const res = executeGetHunk(
          { filePath: 'src/auth/jwt.ts', startLine: start, endLine: end },
          samplePatches,
        );
        expect(res.status).toBe('rejected');
        if (res.status === 'rejected') {
          expect(res.error).toBe('invalid_arguments');
          expect(res.message).toContain('startLine must be <= endLine');
        }
      }
    });

    it('rejects zero and negative line numbers fail-closed with invalid_arguments', () => {
      const invalidRanges: [number | undefined, number | undefined][] = [
        [0, 10],
        [-1, 10],
        [-500, 10],
        [10, 0],
        [10, -5],
        [0, 0],
        [-1, -1],
      ];
      for (const [start, end] of invalidRanges) {
        const res = executeGetHunk(
          { filePath: 'src/auth/jwt.ts', startLine: start, endLine: end },
          samplePatches,
        );
        expect(res.status).toBe('rejected');
        if (res.status === 'rejected') {
          expect(res.error).toBe('invalid_arguments');
        }
      }
    });

    it('rejects floating point numbers and non-integers fail-closed', () => {
      const floats: [any, any][] = [
        [1.5, 10],
        [10, 15.9],
        [0.001, 10],
        [1e-5, 10],
        [NaN, 10],
        [Infinity, 10],
        [1, Infinity],
        ['1' as any, 10],
        [1, '10' as any],
      ];
      for (const [start, end] of floats) {
        const res = executeGetHunk(
          { filePath: 'src/auth/jwt.ts', startLine: start, endLine: end },
          samplePatches,
        );
        expect(res.status).toBe('rejected');
        if (res.status === 'rejected') {
          expect(res.error).toBe('invalid_arguments');
        }
      }
    });

    it('rejects range strictly before hunk modifications with no_diff_in_range', () => {
      // Hunk modified lines: 11, 12 (newStart: 10, newCount: 8). Context lines default 3: window extends to [10 - 3, 17 + 3] = [7, 20]
      // Lines 1..5 are strictly before the hunk window
      const resBefore = executeGetHunk(
        { filePath: 'src/auth/jwt.ts', startLine: 1, endLine: 5 },
        samplePatches,
      );
      expect(resBefore.status).toBe('rejected');
      if (resBefore.status === 'rejected') {
        expect(resBefore.error).toBe('no_diff_in_range');
      }
    });

    it('rejects range strictly after hunk modifications with no_diff_in_range', () => {
      // Hunk ends around line 17 in head. Lines 50..60 are strictly after
      const resAfter = executeGetHunk(
        { filePath: 'src/auth/jwt.ts', startLine: 50, endLine: 60 },
        samplePatches,
      );
      expect(resAfter.status).toBe('rejected');
      if (resAfter.status === 'rejected') {
        expect(resAfter.error).toBe('no_diff_in_range');
      }
    });

    it('handles contextLines boundaries: clamping to [0, 10]', () => {
      // With contextLines = 0, lines must strictly touch the hunk lines
      const resExact = executeGetHunk(
        { filePath: 'src/auth/jwt.ts', startLine: 11, endLine: 12, contextLines: 0 },
        samplePatches,
      );
      expect(resExact.status).toBe('success');
      if (resExact.status === 'success') {
        // Only the modified lines should be returned with 0 context
        expect(resExact.modifiedLines.filter((m) => m.type === 'context').length).toBe(0);
        expect(resExact.modifiedLines.filter((m) => m.type === 'add').length).toBe(2);
      }

      // Negative contextLines clamped to 0
      const resNegativeContext = executeGetHunk(
        { filePath: 'src/auth/jwt.ts', startLine: 11, endLine: 12, contextLines: -5 },
        samplePatches,
      );
      expect(resNegativeContext.status).toBe('success');

      // Huge contextLines clamped to 10
      const resHugeContext = executeGetHunk(
        { filePath: 'src/auth/jwt.ts', startLine: 11, endLine: 12, contextLines: 1000 },
        samplePatches,
      );
      expect(resHugeContext.status).toBe('success');
    });

    it('supports deletion-only hunks where newCount = 0', () => {
      const res = executeGetHunk(
        { filePath: 'src/delete/only.ts', startLine: 29, endLine: 31 },
        samplePatches,
      );
      expect(res.status).toBe('success');
      if (res.status === 'success') {
        expect(res.modifiedLines.some((m) => m.type === 'delete')).toBe(true);
      }
    });

    it('returns no_diff_in_range when file patch is empty', () => {
      const res = executeGetHunk(
        { filePath: 'src/empty/file.ts', startLine: 1, endLine: 10 },
        samplePatches,
      );
      expect(res.status).toBe('rejected');
      if (res.status === 'rejected') {
        expect(res.error).toBe('no_diff_in_range');
      }
    });
  });

  // =========================================================================
  // 3. MULTI-HUNK FILES & OVERLAPPING RANGES
  // =========================================================================
  describe('Dimension 3: Multi-Hunk File Range Intersection', () => {
    // 'src/multi/service.ts' has:
    // Hunk 1: @@ -20,5 +20,7 @@ -> added lines 21, 22
    // Hunk 2: @@ -80,5 +82,7 @@ -> added lines 83, 84
    // Hunk 3: @@ -150,5 +154,7 @@ -> added lines 155, 156

    it('extracts only Hunk 1 when range covers [20, 25]', () => {
      const res = executeGetHunk(
        { filePath: 'src/multi/service.ts', startLine: 20, endLine: 25 },
        samplePatches,
      );
      expect(res.status).toBe('success');
      if (res.status === 'success') {
        const addedLines = res.modifiedLines.filter((m) => m.type === 'add');
        expect(addedLines.length).toBe(2);
        expect(addedLines.map((m) => m.line)).toEqual([21, 22]);
        expect(res.modifiedLines.some((m) => m.content.includes('initV2'))).toBe(true);
        expect(res.modifiedLines.some((m) => m.content.includes('doAsyncWork'))).toBe(false);
        expect(res.modifiedLines.some((m) => m.content.includes('closeAsync'))).toBe(false);
      }
    });

    it('extracts only Hunk 2 when range covers [80, 85]', () => {
      const res = executeGetHunk(
        { filePath: 'src/multi/service.ts', startLine: 80, endLine: 85 },
        samplePatches,
      );
      expect(res.status).toBe('success');
      if (res.status === 'success') {
        const addedLines = res.modifiedLines.filter((m) => m.type === 'add');
        expect(addedLines.length).toBe(2);
        expect(addedLines.map((m) => m.line)).toEqual([83, 84]);
        expect(res.modifiedLines.some((m) => m.content.includes('doAsyncWork'))).toBe(true);
        expect(res.modifiedLines.some((m) => m.content.includes('initV2'))).toBe(false);
        expect(res.modifiedLines.some((m) => m.content.includes('closeAsync'))).toBe(false);
      }
    });

    it('extracts only Hunk 3 when range covers [150, 160]', () => {
      const res = executeGetHunk(
        { filePath: 'src/multi/service.ts', startLine: 150, endLine: 160 },
        samplePatches,
      );
      expect(res.status).toBe('success');
      if (res.status === 'success') {
        const addedLines = res.modifiedLines.filter((m) => m.type === 'add');
        expect(addedLines.length).toBe(2);
        expect(addedLines.map((m) => m.line)).toEqual([155, 156]);
        expect(res.modifiedLines.some((m) => m.content.includes('closeAsync'))).toBe(true);
        expect(res.modifiedLines.some((m) => m.content.includes('initV2'))).toBe(false);
        expect(res.modifiedLines.some((m) => m.content.includes('doAsyncWork'))).toBe(false);
      }
    });

    it('extracts both Hunk 1 and Hunk 2 when range spans across both [20, 85]', () => {
      const res = executeGetHunk(
        { filePath: 'src/multi/service.ts', startLine: 20, endLine: 85 },
        samplePatches,
      );
      expect(res.status).toBe('success');
      if (res.status === 'success') {
        const addedLines = res.modifiedLines.filter((m) => m.type === 'add');
        expect(addedLines.length).toBe(4);
        expect(addedLines.map((m) => m.line)).toEqual([21, 22, 83, 84]);
        expect(res.modifiedLines.some((m) => m.content.includes('initV2'))).toBe(true);
        expect(res.modifiedLines.some((m) => m.content.includes('doAsyncWork'))).toBe(true);
        expect(res.modifiedLines.some((m) => m.content.includes('closeAsync'))).toBe(false);
      }
    });

    it('extracts all 3 hunks when range spans across the entire file [10, 170]', () => {
      const res = executeGetHunk(
        { filePath: 'src/multi/service.ts', startLine: 10, endLine: 170 },
        samplePatches,
      );
      expect(res.status).toBe('success');
      if (res.status === 'success') {
        const addedLines = res.modifiedLines.filter((m) => m.type === 'add');
        expect(addedLines.length).toBe(6);
        expect(addedLines.map((m) => m.line)).toEqual([21, 22, 83, 84, 155, 156]);
        expect(res.modifiedLines.some((m) => m.content.includes('initV2'))).toBe(true);
        expect(res.modifiedLines.some((m) => m.content.includes('doAsyncWork'))).toBe(true);
        expect(res.modifiedLines.some((m) => m.content.includes('closeAsync'))).toBe(true);
      }
    });

    it('rejects range located in the gap between Hunk 1 and Hunk 2 with no_diff_in_range', () => {
      // Hunk 1 ends around line 27. Hunk 2 starts around line 82.
      // Gap: lines 45..60 (with contextLines = 3, range [42, 63] does not touch 27 or 82)
      const res = executeGetHunk(
        { filePath: 'src/multi/service.ts', startLine: 45, endLine: 60 },
        samplePatches,
      );
      expect(res.status).toBe('rejected');
      if (res.status === 'rejected') {
        expect(res.error).toBe('no_diff_in_range');
      }
    });

    it('omitting startLine and endLine returns all hunks exhaustively', () => {
      const res = executeGetHunk(
        { filePath: 'src/multi/service.ts' },
        samplePatches,
      );
      expect(res.status).toBe('success');
      if (res.status === 'success') {
        const addedLines = res.modifiedLines.filter((m) => m.type === 'add');
        expect(addedLines.length).toBe(6);
        expect(res.isExhaustive).toBe(true);
        expect(res.scope).toBe('assigned-hunk');
      }
    });
  });

  // =========================================================================
  // 4. INTEGRATION & ENGINE DISPATCH CONTRACTS
  // =========================================================================
  describe('Dimension 4: Engine Integration & Whitelist Enforcement', () => {
    it('executes get_hunk through executeComposedReadOnlyTool with full context', async () => {
      const ctx: ToolRuntimeContext = {
        changedFiles: [
          { path: 'src/auth/jwt.ts', patch: samplePatches['src/auth/jwt.ts'] },
        ],
      };
      const res = await executeComposedReadOnlyTool(
        'get_hunk',
        { filePath: 'src/auth/jwt.ts', startLine: 11, endLine: 12 },
        ctx,
      );
      expect(res.toolScope).toBe('assigned-hunk');
      expect(res.isExhaustive).toBe(true);
      expect(res.toolOutput).toContain('JWT_SECRET');
      expect(res.toolOutput).toContain('verifyToken');
    });

    it('surfaces path traversal rejections cleanly through executeComposedReadOnlyTool', async () => {
      const ctx: ToolRuntimeContext = {
        changedFiles: [
          { path: 'src/auth/jwt.ts', patch: samplePatches['src/auth/jwt.ts'] },
        ],
      };
      const res = await executeComposedReadOnlyTool(
        'get_hunk',
        { filePath: '../../etc/shadow', startLine: 1, endLine: 5 },
        ctx,
      );
      expect(res.isExhaustive).toBe(false);
      expect(res.toolOutput).toContain("Tool 'get_hunk' execution rejected: [invalid_arguments]");
    });
  });
});
