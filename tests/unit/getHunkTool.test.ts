import { describe, it, expect } from 'vitest';
import {
  get_hunk,
  executeGetHunk,
  runReadOnlyTool,
  parseDiffHunks,
  GET_HUNK_TOOL_SCHEMA,
  type GetHunkArgs,
  type ToolRuntimeContext,
} from '../../src/panel/toolRuntime';
import {
  COMPOSED_READ_ONLY_TOOL_CONTRACT,
  executeComposedReadOnlyTool,
} from '../../src/panel/composedEngine';

describe('get_hunk Tool & Registration', () => {
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
    'src/db/migrate.ts': [
      '@@ -50,4 +50,5 @@ export async function runMigrations() {',
      '   await checkLock();',
      '+  await applyDdlChanges();',
      '   return true;',
      ' }',
      '@@ -120,5 +121,6 @@ export async function rollback() {',
      '   await acquireLock();',
      '+  await revertDdlChanges();',
      '   return false;',
      ' }',
    ].join('\n'),
    'src/empty/diff.ts': '',
  };

  describe('Contract and Schema Registration', () => {
    it('registers GET_HUNK_TOOL_SCHEMA with correct properties and constraints', () => {
      expect(GET_HUNK_TOOL_SCHEMA.name).toBe('get_hunk');
      expect(GET_HUNK_TOOL_SCHEMA.parameters.type).toBe('object');
      expect(GET_HUNK_TOOL_SCHEMA.parameters.required).toContain('filePath');
      expect(GET_HUNK_TOOL_SCHEMA.parameters.properties.filePath).toBeDefined();
      expect(GET_HUNK_TOOL_SCHEMA.parameters.properties.startLine.minimum).toBe(1);
      expect(GET_HUNK_TOOL_SCHEMA.parameters.properties.endLine.minimum).toBe(1);
      expect(GET_HUNK_TOOL_SCHEMA.parameters.properties.contextLines.maximum).toBe(10);
      expect(GET_HUNK_TOOL_SCHEMA.parameters.properties.contextLines.default).toBe(3);
    });

    it('registers get_hunk in COMPOSED_READ_ONLY_TOOL_CONTRACT', () => {
      const codeReadingLine = COMPOSED_READ_ONLY_TOOL_CONTRACT.find((line) =>
        line.startsWith('- Code Reading:'),
      );
      expect(codeReadingLine).toBeDefined();
      expect(codeReadingLine).toContain('get_hunk');

      const guideLine = COMPOSED_READ_ONLY_TOOL_CONTRACT.find((line) =>
        line.startsWith('get_hunk args:'),
      );
      expect(guideLine).toBeDefined();
      expect(guideLine).toContain('filePath');
    });
  });

  describe('Diff Slicing and Line Annotations', () => {
    it('slices hunk intersecting [startLine, endLine] and returns verbatim patch', () => {
      const res = executeGetHunk(
        { filePath: 'src/auth/jwt.ts', startLine: 11, endLine: 13 },
        samplePatches,
      );
      expect(res.status).toBe('success');
      if (res.status === 'success') {
        expect(res.filePath).toBe('src/auth/jwt.ts');
        expect(res.startLine).toBe(11);
        expect(res.endLine).toBe(13);
        expect(res.patch).toContain('+  const secret = process.env.JWT_SECRET;');
        expect(res.patch).toContain('+  if (!secret) throw new Error("JWT_SECRET missing");');
        expect(res.scope).toBe('assigned-hunk');
        expect(res.isExhaustive).toBe(true);
      }
    });

    it('annotates modifiedLines with exact line numbers and types (add and delete)', () => {
      const res = executeGetHunk(
        { filePath: 'src/auth/jwt.ts', startLine: 10, endLine: 14 },
        samplePatches,
      );
      expect(res.status).toBe('success');
      if (res.status === 'success') {
        const addedLines = res.modifiedLines.filter((l) => l.type === 'add');
        const deletedLines = res.modifiedLines.filter((l) => l.type === 'delete');

        expect(addedLines.length).toBe(2);
        expect(deletedLines.length).toBe(1);

        expect(addedLines[0].line).toBe(11);
        expect(addedLines[0].content).toContain('const secret = process.env.JWT_SECRET;');
        expect(addedLines[1].line).toBe(12);
        expect(addedLines[1].content).toContain('if (!secret) throw new Error');

        expect(deletedLines[0].content).toContain('const secret = "legacy_secret";');
      }
    });

    it('extracts all hunks when startLine and endLine are omitted', () => {
      const res = executeGetHunk(
        { filePath: 'src/db/migrate.ts' },
        samplePatches,
      );
      expect(res.status).toBe('success');
      if (res.status === 'success') {
        expect(res.patch).toContain('applyDdlChanges');
        expect(res.patch).toContain('revertDdlChanges');
        expect(res.modifiedLines.some((l) => l.content.includes('applyDdlChanges'))).toBe(true);
        expect(res.modifiedLines.some((l) => l.content.includes('revertDdlChanges'))).toBe(true);
      }
    });

    it('clamps contextLines within [0, 10] and defaults to 3', () => {
      const resWithLargeContext = executeGetHunk(
        { filePath: 'src/auth/jwt.ts', startLine: 12, endLine: 13, contextLines: 99 },
        samplePatches,
      );
      expect(resWithLargeContext.status).toBe('success');

      const resWithZeroContext = executeGetHunk(
        { filePath: 'src/auth/jwt.ts', startLine: 12, endLine: 13, contextLines: 0 },
        samplePatches,
      );
      expect(resWithZeroContext.status).toBe('success');
    });

    it('handles positional get_hunk invocation signature', () => {
      const res = get_hunk('src/auth/jwt.ts', 11, 13, 3, samplePatches);
      expect(res.status).toBe('success');
      if (res.status === 'success') {
        expect(res.filePath).toBe('src/auth/jwt.ts');
        expect(res.patch).toContain('JWT_SECRET');
      }
    });

    it('handles array-based changedFiles input seamlessly', () => {
      const filesArray = [
        { path: 'src/auth/jwt.ts', patch: samplePatches['src/auth/jwt.ts'] },
      ];
      const res = executeGetHunk(
        { filePath: 'src/auth/jwt.ts', startLine: 12, endLine: 13 },
        filesArray,
      );
      expect(res.status).toBe('success');
    });
  });

  describe('Edge Cases and Error Rejection Codes', () => {
    it('rejects unadmitted paths with path_not_changed', () => {
      const res = executeGetHunk(
        { filePath: 'src/unmodified/file.ts', startLine: 1, endLine: 10 },
        samplePatches,
      );
      expect(res.status).toBe('rejected');
      if (res.status === 'rejected') {
        expect(res.error).toBe('path_not_changed');
        expect(res.message).toContain('File is not in admitted changed files');
      }
    });

    it('rejects inverted range (startLine > endLine) with invalid_arguments', () => {
      const res = executeGetHunk(
        { filePath: 'src/auth/jwt.ts', startLine: 50, endLine: 20 },
        samplePatches,
      );
      expect(res.status).toBe('rejected');
      if (res.status === 'rejected') {
        expect(res.error).toBe('invalid_arguments');
        expect(res.message).toContain('startLine must be <= endLine');
      }
    });

    it('rejects non-positive startLine with invalid_arguments', () => {
      const resZero = executeGetHunk(
        { filePath: 'src/auth/jwt.ts', startLine: 0, endLine: 10 },
        samplePatches,
      );
      expect(resZero.status).toBe('rejected');
      if (resZero.status === 'rejected') {
        expect(resZero.error).toBe('invalid_arguments');
      }

      const resNeg = executeGetHunk(
        { filePath: 'src/auth/jwt.ts', startLine: -5, endLine: 10 },
        samplePatches,
      );
      expect(resNeg.status).toBe('rejected');
      if (resNeg.status === 'rejected') {
        expect(resNeg.error).toBe('invalid_arguments');
      }
    });

    it('rejects floating point line numbers with invalid_arguments', () => {
      const resFloat = executeGetHunk(
        { filePath: 'src/auth/jwt.ts', startLine: 2.5, endLine: 5 },
        samplePatches,
      );
      expect(resFloat.status).toBe('rejected');
      if (resFloat.status === 'rejected') {
        expect(resFloat.error).toBe('invalid_arguments');
      }
    });

    it('rejects line range outside modified hunks with no_diff_in_range', () => {
      const res = executeGetHunk(
        { filePath: 'src/auth/jwt.ts', startLine: 500, endLine: 550 },
        samplePatches,
      );
      expect(res.status).toBe('rejected');
      if (res.status === 'rejected') {
        expect(res.error).toBe('no_diff_in_range');
        expect(res.message).toContain('No diff modifications in requested line range');
      }
    });

    it('rejects path traversal attempts fail-closed with invalid_arguments', () => {
      const resTraversal = executeGetHunk(
        { filePath: '../../etc/passwd', startLine: 1, endLine: 5 },
        samplePatches,
      );
      expect(resTraversal.status).toBe('rejected');
      if (resTraversal.status === 'rejected') {
        expect(resTraversal.error).toBe('invalid_arguments');
        expect(resTraversal.message).toContain('Path traversal or absolute path not allowed');
      }

      const resAbsolute = executeGetHunk(
        { filePath: '/root/secret.pem', startLine: 1, endLine: 5 },
        samplePatches,
      );
      expect(resAbsolute.status).toBe('rejected');
      if (resAbsolute.status === 'rejected') {
        expect(resAbsolute.error).toBe('invalid_arguments');
      }
    });

    it('returns no_diff_in_range when patch is empty', () => {
      const res = executeGetHunk(
        { filePath: 'src/empty/diff.ts', startLine: 1, endLine: 10 },
        samplePatches,
      );
      expect(res.status).toBe('rejected');
      if (res.status === 'rejected') {
        expect(res.error).toBe('no_diff_in_range');
      }
    });
  });

  describe('Integration with runReadOnlyTool & executeComposedReadOnlyTool', () => {
    const baseContext: ToolRuntimeContext = {
      changedFiles: [
        { path: 'src/auth/jwt.ts', patch: samplePatches['src/auth/jwt.ts'] },
      ],
    };

    it('executes get_hunk through runReadOnlyTool and returns assigned-hunk scope', async () => {
      const res = await runReadOnlyTool(
        'get_hunk',
        { filePath: 'src/auth/jwt.ts', startLine: 11, endLine: 13 },
        baseContext,
      );
      expect(res.toolScope).toBe('assigned-hunk');
      expect(res.isExhaustive).toBe(true);
      expect(res.toolOutput).toContain("Tool 'get_hunk' execution result:");
      expect(res.toolOutput).toContain('JWT_SECRET');
    });

    it('surfaces get_hunk rejection through runReadOnlyTool with exhaustive=false', async () => {
      const res = await runReadOnlyTool(
        'get_hunk',
        { filePath: 'src/unknown.ts', startLine: 1, endLine: 5 },
        baseContext,
      );
      expect(res.toolScope).toBe('assigned-hunk');
      expect(res.isExhaustive).toBe(false);
      expect(res.toolOutput).toContain("Tool 'get_hunk' execution rejected: [path_not_changed]");
    });

    it('executes get_hunk through executeComposedReadOnlyTool', async () => {
      const res = await executeComposedReadOnlyTool(
        'get_hunk',
        { filePath: 'src/auth/jwt.ts', startLine: 11, endLine: 13 },
        baseContext,
      );
      expect(res.toolScope).toBe('assigned-hunk');
      expect(res.isExhaustive).toBe(true);
      expect(res.toolOutput).toContain('JWT_SECRET');
    });
  });
});
