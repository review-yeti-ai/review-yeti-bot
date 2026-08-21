import { describe, expect, it, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  createPiWorkspacePlugin,
  PiWorkspacePlugin,
  PiVfsSecurityError,
  DiffInputFile,
} from '../../src/sandbox/piWorkspacePlugin';

const TELECOM_WORKSPACE = path.resolve('tests/fixtures/workspaces/telecom-call-engine');

describe('PiWorkspacePlugin - Adversarial Stress & Empirical Challenge Suite', () => {
  let plugin: PiWorkspacePlugin;

  beforeEach(() => {
    plugin = createPiWorkspacePlugin({
      workspaceRoot: TELECOM_WORKSPACE,
      diffBudgetLimitChars: 24000,
      fileBudgetLimitChars: 8000,
      maxToolCallsPerTurn: 5,
      maxTurnsPerSession: 5,
      maxFileReadBytes: 32768,
      toolTimeoutMs: 5000,
      modelCostPer1kPrompt: 0.00015,
      modelCostPer1kCompletion: 0.0006,
    });
  });

  // =========================================================================
  // 1. AGGRESSIVE PATH TRAVERSAL & SECURITY BOUNDARY CHALLENGES
  // =========================================================================
  describe('1. Aggressive Path Traversal & Security Boundaries', () => {
    it('1.1 blocks single URL encoded traversal sequences (%2e%2e%2f)', async () => {
      const response = await plugin.executeTool('sec_persona', 1, {
        name: 'pi.fs.readFile',
        arguments: { path: '%2e%2e%2f%2e%2e%2fpackage.json' },
      });
      expect(response.status).toBe('error');
      expect(response.output).toContain('Security Error');
      expect(response.output).toContain('path traversal out of workspace root');
    });

    it('1.2 blocks mixed case URL encoded traversal sequences (%2E%2E%2F)', async () => {
      const response = await plugin.executeTool('sec_persona', 1, {
        name: 'pi.fs.readFile',
        arguments: { path: '%2E%2E%2F%2E%2E%2Fpackage.json' },
      });
      expect(response.status).toBe('error');
      expect(response.output).toContain('Security Error');
      expect(response.output).toContain('path traversal out of workspace root');
    });

    it('1.3 blocks nested subdirectory path traversal escape', async () => {
      const response = await plugin.executeTool('sec_persona', 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/../../../../package.json' },
      });
      expect(response.status).toBe('error');
      expect(response.output).toContain('Security Error');
      expect(response.output).toContain('path traversal out of workspace root');
    });

    it('1.4 blocks backslash traversal sequences on POSIX/Windows paths', async () => {
      const response = await plugin.executeTool('sec_persona', 1, {
        name: 'pi.fs.readFile',
        arguments: { path: '..\\..\\package.json' },
      });
      expect(response.status).toBe('error');
      expect(response.output).toContain('Security Error');
      expect(response.output).toContain('path traversal out of workspace root');
    });

    it('1.5 blocks encoded backslash traversal sequences (%5c)', async () => {
      const response = await plugin.executeTool('sec_persona', 1, {
        name: 'pi.fs.readFile',
        arguments: { path: '..%5c..%5cpackage.json' },
      });
      expect(response.status).toBe('error');
      expect(response.output).toContain('Security Error');
    });

    it('1.6 blocks null byte injection in raw string', async () => {
      const response = await plugin.executeTool('sec_persona', 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts\0.png' },
      });
      expect(response.status).toBe('error');
      expect(response.output).toContain('Path contains invalid null bytes');
    });

    it('1.7 blocks encoded null byte (%00)', async () => {
      const response = await plugin.executeTool('sec_persona', 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts%00.png' },
      });
      expect(response.status).toBe('error');
      expect(response.output).toContain('Path contains encoded control/null characters');
    });

    it('1.8 blocks encoded newline and carriage return (%0a, %0d)', async () => {
      const respLF = await plugin.executeTool('sec_persona', 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts%0a/etc/passwd' },
      });
      expect(respLF.status).toBe('error');
      expect(respLF.output).toContain('Path contains encoded control/null characters');

      const respCR = await plugin.executeTool('sec_persona', 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts%0d/etc/passwd' },
      });
      expect(respCR.status).toBe('error');
      expect(respCR.output).toContain('Path contains encoded control/null characters');
    });

    it('1.9 blocks absolute paths pointing to root files', async () => {
      const response = await plugin.executeTool('sec_persona', 1, {
        name: 'pi.fs.readFile',
        arguments: { path: '/etc/passwd' },
      });
      expect(response.status).toBe('error');
      expect(response.output).toContain('Security Error');
      expect(response.output).toContain('path traversal out of workspace root');
    });

    it('1.10 safely handles paths with internal redundant slashes and dots inside workspace', async () => {
      const response = await plugin.executeTool('sec_persona', 1, {
        name: 'pi.fs.readFile',
        arguments: {
          path: './sip_signaling_service/src/../src/callRouter.ts',
        },
      });
      expect(response.status).toBe('success');
      expect(response.output).toContain('CallRouter');
    });

    it('1.11 rejects empty, whitespace, and non-string paths with security error', async () => {
      const respEmpty = await plugin.executeTool('sec_persona', 1, {
        name: 'pi.fs.readFile',
        arguments: { path: '   ' },
      });
      expect(respEmpty.status).toBe('error');
      expect(respEmpty.output).toContain('Invalid path: path must be a non-empty string');
    });

    it('1.12 prevents symlink jailbreak pointing outside workspace', async () => {
      const tempSymlink = path.join(TELECOM_WORKSPACE, 'adversarial_symlink_test');
      const externalTarget = path.join(os.tmpdir(), 'adversarial_target_external.txt');

      try {
        fs.writeFileSync(externalTarget, 'TOP_SECRET_EXTERNAL_DATA');
        if (fs.existsSync(tempSymlink)) {
          fs.unlinkSync(tempSymlink);
        }
        fs.symlinkSync(externalTarget, tempSymlink);

        const response = await plugin.executeTool('sec_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'adversarial_symlink_test' },
        });

        expect(response.status).toBe('error');
        expect(response.output).toContain('symlink resolves outside workspace root');
      } finally {
        if (fs.existsSync(tempSymlink)) {
          fs.unlinkSync(tempSymlink);
        }
        if (fs.existsSync(externalTarget)) {
          fs.unlinkSync(externalTarget);
        }
      }
    });

    it('1.13 blocks directory search outside workspace via pi.code.search dir parameter', async () => {
      const response = await plugin.executeTool('sec_persona', 1, {
        name: 'pi.code.search',
        arguments: { query: 'test', dir: '../../' },
      });
      expect(response.status).toBe('error');
      expect(response.output).toContain('Security Error');
      expect(response.output).toContain('path traversal out of workspace root');
    });
  });

  // =========================================================================
  // 2. DIFF CHARACTER BUDGET BOUNDARY VALUES & CORNER CASES
  // =========================================================================
  describe('2. Diff Character Budget Boundary Values & Corner Cases', () => {
    it('2.1 handles exact 24,000 char global budget with multiple files fitting completely', () => {
      const patch1 = '--- a/sip_signaling_service/src/f1.ts\n+++ b/sip_signaling_service/src/f1.ts\n@@ -1,1 +1,100 @@\n' +
        '+'.repeat(7400);
      const patch2 = '--- a/rtp_media_gateway/src/f2.ts\n+++ b/rtp_media_gateway/src/f2.ts\n@@ -1,1 +1,100 @@\n' +
        '+'.repeat(7400);
      const patch3 = '--- a/cdr_pipeline/src/f3.ts\n+++ b/cdr_pipeline/src/f3.ts\n@@ -1,1 +1,100 @@\n' +
        '+'.repeat(7400);

      const files: DiffInputFile[] = [
        { path: 'sip_signaling_service/src/f1.ts', patch: patch1 },
        { path: 'rtp_media_gateway/src/f2.ts', patch: patch2 },
        { path: 'cdr_pipeline/src/f3.ts', patch: patch3 },
      ];

      const result = plugin.applyDiffBudget(files);

      expect(result.includedFilesCount).toBe(3);
      expect(result.truncatedFilesCount).toBe(0);
      expect(result.omittedFilesCount).toBe(0);
      expect(result.omissionNoticeHeader).toBeUndefined();
      expect(result.includedTotalChars).toBe(patch1.length + patch2.length + patch3.length);
      expect(result.includedTotalChars).toBeLessThanOrEqual(24000);
    });

    it('2.2 enforces truncation when total exceeds 24,000 characters by 1 character (24,001 chars)', () => {
      const customPlugin = createPiWorkspacePlugin({
        workspaceRoot: TELECOM_WORKSPACE,
        diffBudgetLimitChars: 24000,
        fileBudgetLimitChars: 24000,
      });

      // Construct patch of exactly 24,001 chars
      const header = '--- a/sip_signaling_service/src/large.ts\n+++ b/sip_signaling_service/src/large.ts\n@@ -1,1 +1,500 @@\n';
      const fillLength = 24001 - header.length;
      const patch = header + '+'.repeat(fillLength);

      expect(patch.length).toBe(24001);

      const files: DiffInputFile[] = [{ path: 'sip_signaling_service/src/large.ts', patch }];
      const result = customPlugin.applyDiffBudget(files);

      expect(result.includedTotalChars).toBeLessThanOrEqual(24000);
      expect(result.truncatedFilesCount).toBe(1);
      expect(result.omissionNoticeHeader).toBeDefined();
      expect(result.omissionNoticeHeader).toContain('[DIFF_BUDGET_NOTICE]');
      expect(result.formattedDiff).toContain('... [Diff truncated:');
    });

    it('2.3 enforces exact 8,000 char per-file limit boundary', () => {
      const header = '--- a/cdr_pipeline/src/rating.ts\n+++ b/cdr_pipeline/src/rating.ts\n@@ -1,1 +1,200 @@\n';
      
      // Exact 8,000 chars
      const exact8000Patch = header + '+'.repeat(8000 - header.length);
      expect(exact8000Patch.length).toBe(8000);

      const res8000 = plugin.applyDiffBudget([{ path: 'cdr_pipeline/src/rating.ts', patch: exact8000Patch }]);
      expect(res8000.includedTotalChars).toBe(8000);
      expect(res8000.truncatedFilesCount).toBe(0);
      expect(res8000.omissionNoticeHeader).toBeUndefined();

      // 8,001 chars
      const patch8001 = header + '+'.repeat(8001 - header.length);
      expect(patch8001.length).toBe(8001);

      const res8001 = plugin.applyDiffBudget([{ path: 'cdr_pipeline/src/rating.ts', patch: patch8001 }]);
      expect(res8001.includedTotalChars).toBeLessThanOrEqual(8000);
      expect(res8001.truncatedFilesCount).toBe(1);
      expect(res8001.omissionNoticeHeader).toBeDefined();
    });

    it('2.4 handles multi-hunk truncation with intermediate hunk preservation', () => {
      const hunk1 = '@@ -10,3 +10,10 @@\n' + Array.from({ length: 50 }, (_, i) => `+const h1_${i} = ${i};`).join('\n') + '\n';
      const hunk2 = '@@ -80,3 +80,10 @@\n' + Array.from({ length: 50 }, (_, i) => `+const h2_${i} = ${i};`).join('\n') + '\n';
      const hunk3 = '@@ -150,3 +150,10 @@\n' + Array.from({ length: 500 }, (_, i) => `+const h3_${i} = ${i};`).join('\n') + '\n';
      const hunk4 = '@@ -300,3 +300,10 @@\n' + Array.from({ length: 100 }, (_, i) => `+const h4_${i} = ${i};`).join('\n') + '\n';

      const multiHunkPatch = `--- a/pbx_device_manager/src/deviceRegistry.ts\n+++ b/pbx_device_manager/src/deviceRegistry.ts\n${hunk1}${hunk2}${hunk3}${hunk4}`;

      const files: DiffInputFile[] = [{ path: 'pbx_device_manager/src/deviceRegistry.ts', patch: multiHunkPatch }];
      const result = plugin.applyDiffBudget(files);

      expect(result.includedTotalChars).toBeLessThanOrEqual(8000);
      expect(result.truncatedFilesCount).toBe(1);
      // Hunk 1 and 2 should be included
      expect(result.formattedDiff).toContain('const h1_0 = 0;');
      expect(result.formattedDiff).toContain('const h2_0 = 0;');
      // Truncation notice should appear
      expect(result.formattedDiff).toContain('... [Diff truncated:');
      expect(result.truncatedFiles[0].omittedLines).toBeGreaterThan(0);
    });

    it('2.5 prioritizes security and core telecommunications modules under budget starvation', () => {
      const customPlugin = createPiWorkspacePlugin({
        workspaceRoot: TELECOM_WORKSPACE,
        diffBudgetLimitChars: 3000,
        fileBudgetLimitChars: 1500,
      });

      const files: DiffInputFile[] = [
        {
          path: 'tests/unit/logger.test.ts',
          patch: '--- a/tests/unit/logger.test.ts\n+++ b/tests/unit/logger.test.ts\n@@ -1,1 +1,50 @@\n' +
            Array.from({ length: 40 }, (_, i) => `+test('log ${i}', () => {});`).join('\n'),
        },
        {
          path: 'docs/readme.md',
          patch: '--- a/docs/readme.md\n+++ b/docs/readme.md\n@@ -1,1 +1,50 @@\n' +
            Array.from({ length: 40 }, (_, i) => `+# Header ${i}`).join('\n'),
        },
        {
          path: 'sip_signaling_service/src/sipAuthHandler.ts',
          patch: '--- a/sip_signaling_service/src/sipAuthHandler.ts\n+++ b/sip_signaling_service/src/sipAuthHandler.ts\n@@ -1,1 +1,30 @@\n' +
            Array.from({ length: 25 }, (_, i) => `+export function verifySipAuth${i}() { return true; }`).join('\n'),
        },
        {
          path: 'rtp_media_gateway/src/rtpTranscoder.ts',
          patch: '--- a/rtp_media_gateway/src/rtpTranscoder.ts\n+++ b/rtp_media_gateway/src/rtpTranscoder.ts\n@@ -1,1 +1,30 @@\n' +
            Array.from({ length: 25 }, (_, i) => `+export function transcodeG711${i}() { return Buffer.alloc(160); }`).join('\n'),
        },
      ];

      const result = customPlugin.applyDiffBudget(files);

      expect(result.includedTotalChars).toBeLessThanOrEqual(3000);
      // Priority 1 files (sipAuthHandler, rtpTranscoder) must be included before docs or tests
      expect(result.formattedDiff).toContain('sipAuthHandler.ts');
      expect(result.formattedDiff).toContain('rtpTranscoder.ts');
      expect(result.omittedFiles.some((o) => o.path === 'tests/unit/logger.test.ts' || o.path === 'docs/readme.md')).toBe(true);
    });

    it('2.6 automatically filters lockfiles and generated assets with explicit omission reasons', () => {
      const files: DiffInputFile[] = [
        { path: 'yarn.lock', patch: '--- a/yarn.lock\n+++ b/yarn.lock\n@@ -1,1 +1,1 @@\n+# yarn lockfile' },
        { path: 'pnpm-lock.yaml', patch: '--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@ -1,1 +1,1 @@\n+# pnpm' },
        { path: 'Cargo.lock', patch: '--- a/Cargo.lock\n+++ b/Cargo.lock\n@@ -1,1 +1,1 @@\n+# cargo' },
        { path: 'mix.lock', patch: '--- a/mix.lock\n+++ b/mix.lock\n@@ -1,1 +1,1 @@\n+# mix' },
        { path: 'dist/app.bundle.js', patch: '--- a/dist/app.bundle.js\n+++ b/dist/app.bundle.js\n@@ -1,1 +1,1 @@\n+var a=1;' },
        { path: 'coverage/lcov.info', patch: '--- a/coverage/lcov.info\n+++ b/coverage/lcov.info\n@@ -1,1 +1,1 @@\n+TN:' },
      ];

      const result = plugin.applyDiffBudget(files);

      expect(result.includedFilesCount).toBe(0);
      expect(result.omittedFilesCount).toBe(6);
      expect(result.omittedFiles.filter((f) => f.reason === 'lockfile').length).toBe(4);
      expect(result.omittedFiles.filter((f) => f.reason === 'generated').length).toBe(2);
    });

    it('2.7 handles zero-diff, empty input, and whitespace diff cleanly', () => {
      const emptyResult = plugin.applyDiffBudget([]);
      expect(emptyResult.includedTotalChars).toBe(0);
      expect(emptyResult.originalTotalChars).toBe(0);
      expect(emptyResult.formattedDiff).toBe('');
      expect(emptyResult.truncatedFilesCount).toBe(0);
      expect(emptyResult.omittedFilesCount).toBe(0);

      const singleEmptyFileResult = plugin.applyDiffBudget([{ path: 'empty.ts', patch: '' }]);
      expect(singleEmptyFileResult.includedTotalChars).toBe(0);
      expect(singleEmptyFileResult.formattedDiff).toBe('');
    });
  });

  // =========================================================================
  // 3. TOOL EXECUTION STRESS & ROBUSTNESS
  // =========================================================================
  describe('3. Tool Execution Stress & Robustness', () => {
    describe('pi.fs.readFile edge cases', () => {
      it('3.1 handles out-of-range and inverted line bounds gracefully', async () => {
        // Inverted lines: startLine > endLine
        const respInverted = await plugin.executeTool('test_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: {
            path: 'sip_signaling_service/src/callRouter.ts',
            startLine: 50,
            endLine: 10,
          },
        });
        expect(respInverted.status).toBe('success');
        expect(respInverted.output).toBe('');

        // startLine far past EOF
        const respPastEOF = await plugin.executeTool('test_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: {
            path: 'sip_signaling_service/src/callRouter.ts',
            startLine: 100000,
            endLine: 100050,
          },
        });
        expect(respPastEOF.status).toBe('success');
        expect(respPastEOF.output).toContain('empty (file has');

        // Negative startLine & endLine
        const respNeg = await plugin.executeTool('test_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: {
            path: 'sip_signaling_service/src/callRouter.ts',
            startLine: -5,
            endLine: 3,
          },
        });
        expect(respNeg.status).toBe('success');
        expect(respNeg.output).toContain('1:');
      });

      it('3.2 handles directory read error with descriptive output without crashing', async () => {
        const response = await plugin.executeTool('test_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'sip_signaling_service/src' },
        });
        expect(response.status).toBe('success');
        expect(response.output).toContain('Error: Path is a directory, not a file');
      });

      it('3.3 enforces byte truncation when maxBytes limit is reached', async () => {
        const response = await plugin.executeTool('test_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: {
            path: 'sip_signaling_service/src/dialogManager.ts',
            maxBytes: 150,
          },
        });
        expect(response.status).toBe('success');
        expect(response.output).toContain('... [Output truncated: exceeds maxBytes limit] ...');
        expect(Buffer.byteLength(response.output, 'utf8')).toBeLessThanOrEqual(500);
      });
    });

    describe('pi.code.search edge cases & ReDoS resistance', () => {
      it('3.4 handles complex regex, special characters, and ReDoS fallback cleanly', async () => {
        // Query with unclosed bracket
        const respUnclosed = await plugin.executeTool('test_persona', 1, {
          name: 'pi.code.search',
          arguments: { query: 'class [A-Z' },
        });
        expect(respUnclosed.status).toBe('success');

        // Query with complex special chars
        const respSpecial = await plugin.executeTool('test_persona', 1, {
          name: 'pi.code.search',
          arguments: { query: 'Promise<void>' },
        });
        expect(respSpecial.status).toBe('success');
        expect(respSpecial.output).toContain('Promise<void>');

        // Query with regex anchors
        const respRegex = await plugin.executeTool('test_persona', 1, {
          name: 'pi.code.search',
          arguments: { query: '^export interface', caseSensitive: true },
        });
        expect(respRegex.status).toBe('success');
        expect(respRegex.output).toContain('export interface');
      });

      it('3.5 clamps maxResults between 1 and 50', async () => {
        // Clamping upper bound
        const respHuge = await plugin.executeTool('test_persona', 1, {
          name: 'pi.code.search',
          arguments: { query: 'export', maxResults: 10000 },
        });
        expect(respHuge.status).toBe('success');
        const matchCount = respHuge.output.split('\n').length;
        expect(matchCount).toBeLessThanOrEqual(50);

        // Clamping lower bound
        const respZero = await plugin.executeTool('test_persona', 1, {
          name: 'pi.code.search',
          arguments: { query: 'export', maxResults: 0 },
        });
        expect(respZero.status).toBe('success');
        const matchCountZero = respZero.output.split('\n').length;
        expect(matchCountZero).toBeGreaterThanOrEqual(1);
      });

      it('3.6 scopes search to specified subdirectory and file glob', async () => {
        const response = await plugin.executeTool('test_persona', 1, {
          name: 'pi.code.search',
          arguments: {
            query: 'export',
            dir: 'rtp_media_gateway',
            fileGlob: '*.ts',
          },
        });
        expect(response.status).toBe('success');
        expect(response.output).toContain('rtp_media_gateway');
        expect(response.output).not.toContain('sip_signaling_service');
      });
    });

    describe('pi.symbol.lookup edge cases', () => {
      it('3.7 looks up functions, classes, types, enums, and methods', async () => {
        const respClass = await plugin.executeTool('test_persona', 1, {
          name: 'pi.symbol.lookup',
          arguments: { symbol: 'CdrIngestionService' },
        });
        expect(respClass.status).toBe('success');
        expect(respClass.output).toContain('[class]');

        const respType = await plugin.executeTool('test_persona', 1, {
          name: 'pi.symbol.lookup',
          arguments: { symbol: 'SipMessage', kind: 'interface' },
        });
        expect(respType.status).toBe('success');
        expect(respType.output).toContain('[interface]');

        const respFunc = await plugin.executeTool('test_persona', 1, {
          name: 'pi.symbol.lookup',
          arguments: { symbol: 'allocateTrunk' },
        });
        expect(respFunc.status).toBe('success');
        expect(respFunc.output).toContain('trunkAllocator.ts');
      });

      it('3.8 handles symbol with special regex characters safely without crashing', async () => {
        const response = await plugin.executeTool('test_persona', 1, {
          name: 'pi.symbol.lookup',
          arguments: { symbol: 'someSymbol(arg1, arg2)' },
        });
        expect(response.status).toBe('success');
        expect(response.output).toContain('No symbol definitions found');
      });

      it('3.9 handles empty and whitespace symbols safely', async () => {
        const response = await plugin.executeTool('test_persona', 1, {
          name: 'pi.symbol.lookup',
          arguments: { symbol: '   ' },
        });
        expect(response.status).toBe('success');
        expect(response.output).toContain('No symbol definitions found');
      });
    });

    describe('Error handling & unknown tools', () => {
      it('3.10 returns error response for missing required arguments', async () => {
        const respReadNoPath = await plugin.executeTool('test_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: {},
        });
        expect(respReadNoPath.status).toBe('error');
        expect(respReadNoPath.output).toContain('Missing "path" argument');

        const respSearchNoQuery = await plugin.executeTool('test_persona', 1, {
          name: 'pi.code.search',
          arguments: {},
        });
        expect(respSearchNoQuery.status).toBe('error');
        expect(respSearchNoQuery.output).toContain('Missing "query" argument');

        const respSymbolNoSymbol = await plugin.executeTool('test_persona', 1, {
          name: 'pi.symbol.lookup',
          arguments: {},
        });
        expect(respSymbolNoSymbol.status).toBe('error');
        expect(respSymbolNoSymbol.output).toContain('Missing "symbol" argument');
      });

      it('3.11 returns clear error for unknown tool names', async () => {
        const response = await plugin.executeTool('test_persona', 1, {
          name: 'unsupported_custom_tool',
          arguments: { data: 123 },
        });
        expect(response.status).toBe('error');
        expect(response.output).toContain('Unknown tool "unsupported_custom_tool"');
      });
    });
  });

  // =========================================================================
  // 4. RATE LIMITING, CONCURRENCY & PERSONA ISOLATION
  // =========================================================================
  describe('4. Rate Limiting, Concurrency & Persona Isolation', () => {
    it('4.1 enforces exactly 5 tool calls per turn and rejects subsequent calls in that turn', async () => {
      const persona = 'rate_test_persona';

      for (let i = 1; i <= 5; i++) {
        const res = await plugin.executeTool(persona, 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: i, endLine: i },
        });
        expect(res.status).toBe('success');
      }

      // 6th call in turn 1 must be rate limited
      const res6 = await plugin.executeTool(persona, 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: 6, endLine: 6 },
      });
      expect(res6.status).toBe('rate_limited');
      expect(res6.output).toContain('[RATE_LIMIT_EXCEEDED]: Maximum 5 tool calls per turn exceeded');

      // 7th call in turn 1 must also be rate limited
      const res7 = await plugin.executeTool(persona, 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: 7, endLine: 7 },
      });
      expect(res7.status).toBe('rate_limited');
    });

    it('4.2 allows 5 new calls when turn is incremented to turn 2, up to maxTurnsPerSession (5)', async () => {
      const persona = 'multi_turn_persona';

      for (let turn = 1; turn <= 5; turn++) {
        for (let call = 1; call <= 5; call++) {
          const res = await plugin.executeTool(persona, turn, {
            name: 'pi.fs.readFile',
            arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: 1, endLine: 1 },
          });
          expect(res.status).toBe('success');
        }

        // Call 6 in any turn is rate limited
        const res6 = await plugin.executeTool(persona, turn, {
          name: 'pi.fs.readFile',
          arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: 1, endLine: 1 },
        });
        expect(res6.status).toBe('rate_limited');
      }

      // Turn 6 exceeds max turns per session (5)
      const resTurn6 = await plugin.executeTool(persona, 6, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts' },
      });
      expect(resTurn6.status).toBe('rate_limited');
      expect(resTurn6.output).toContain('[RATE_LIMIT_EXCEEDED]: Maximum turns (5) reached');
    });

    it('4.3 maintains strict concurrent isolation between all 5 review personas', async () => {
      const personas = ['security', 'performance', 'architecture', 'testing', 'dependencies'];

      // Execute tool calls concurrently across all personas
      const promises = personas.map(async (p) => {
        const results = [];
        for (let i = 1; i <= 5; i++) {
          const res = await plugin.executeTool(p, 1, {
            name: 'pi.fs.readFile',
            arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: i, endLine: i },
          });
          results.push(res);
        }
        return { persona: p, results };
      });

      const allResults = await Promise.all(promises);

      for (const item of allResults) {
        expect(item.results.length).toBe(5);
        for (const res of item.results) {
          expect(res.status).toBe('success');
        }

        const metrics = plugin.getSessionMetrics(item.persona);
        expect(metrics.totalToolCalls).toBe(5);
        expect(metrics.successfulToolCalls).toBe(5);
        expect(metrics.rateLimitedCalls).toBe(0);
      }

      // Verify aggregate metrics across all personas
      const globalMetrics = plugin.getSessionMetrics();
      expect(globalMetrics.totalToolCalls).toBe(25);
      expect(globalMetrics.successfulToolCalls).toBe(25);
      expect(globalMetrics.rateLimitedCalls).toBe(0);
      expect(globalMetrics.totalBytesRead).toBeGreaterThan(0);
      expect(globalMetrics.totalCostUSD).toBeGreaterThan(0);
    });

    it('4.4 correctly computes token estimates and dollar cost ledger', async () => {
      const persona = 'cost_persona';

      await plugin.executeTool(persona, 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts' },
      });

      const metrics = plugin.getSessionMetrics(persona);

      expect(metrics.totalPromptTokens).toBeGreaterThan(0);
      expect(metrics.totalCompletionTokens).toBeGreaterThan(0);
      expect(metrics.totalCostUSD).toBeGreaterThan(0);
      // Verify formula: (prompt/1000)*0.00015 + (completion/1000)*0.0006
      const expectedCost = (metrics.totalPromptTokens / 1000) * 0.00015 + (metrics.totalCompletionTokens / 1000) * 0.0006;
      expect(metrics.totalCostUSD).toBeCloseTo(expectedCost, 6);
    });

    it('4.5 supports resetTurn and persona-specific resetSession', async () => {
      const p1 = 'persona_1';
      const p2 = 'persona_2';

      for (let i = 1; i <= 5; i++) {
        await plugin.executeTool(p1, 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'sip_signaling_service/src/callRouter.ts' },
        });
        await plugin.executeTool(p2, 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'sip_signaling_service/src/callRouter.ts' },
        });
      }

      // Reset p1 turn
      plugin.resetTurn?.(p1);

      // p1 can now execute another call in turn 1
      const resP1 = await plugin.executeTool(p1, 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts' },
      });
      expect(resP1.status).toBe('success');

      // p2 is still rate limited in turn 1
      const resP2 = await plugin.executeTool(p2, 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts' },
      });
      expect(resP2.status).toBe('rate_limited');

      // Reset session for p1 only
      plugin.resetSession(p1);
      const metricsP1 = plugin.getSessionMetrics(p1);
      const metricsP2 = plugin.getSessionMetrics(p2);

      expect(metricsP1.totalToolCalls).toBe(0);
      expect(metricsP2.totalToolCalls).toBe(6);

      // Global reset clears everything
      plugin.resetSession();
      const metricsGlobal = plugin.getSessionMetrics();
      expect(metricsGlobal.totalToolCalls).toBe(0);
      expect(metricsGlobal.receipts.length).toBe(0);
    });

    it('4.6 handles high concurrency burst (50 concurrent calls across 10 personas)', async () => {
      const personas = Array.from({ length: 10 }, (_, i) => `burst_persona_${i}`);
      const promises = personas.map(async (persona) => {
        const calls = Array.from({ length: 5 }, (_, c) => ({
          name: 'pi.fs.readFile',
          arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: c + 1, endLine: c + 1 },
        }));
        return plugin.executeTurnBatch(persona, 1, calls);
      });

      const batchResults = await Promise.all(promises);

      expect(batchResults.length).toBe(10);
      for (const resList of batchResults) {
        expect(resList.length).toBe(5);
        for (const res of resList) {
          expect(res.status).toBe('success');
        }
      }

      const globalMetrics = plugin.getSessionMetrics();
      expect(globalMetrics.totalToolCalls).toBe(50);
      expect(globalMetrics.successfulToolCalls).toBe(50);
      expect(globalMetrics.rateLimitedCalls).toBe(0);
    });
  });

  // =========================================================================
  // 5. EXTREME STARVATION & DATA INTEGRITY TESTS
  // =========================================================================
  describe('5. Extreme Starvation & Data Integrity', () => {
    it('5.1 handles 50 competing files under strict 5,000 char budget', () => {
      const files: DiffInputFile[] = Array.from({ length: 50 }, (_, i) => ({
        path: `cdr_pipeline/src/metric_${i}.ts`,
        patch: `--- a/cdr_pipeline/src/metric_${i}.ts\n+++ b/cdr_pipeline/src/metric_${i}.ts\n@@ -1,1 +1,10 @@\n` +
          `+export const metric_${i} = ${i};\n`.repeat(10),
      }));

      const tightPlugin = createPiWorkspacePlugin({
        workspaceRoot: TELECOM_WORKSPACE,
        diffBudgetLimitChars: 5000,
        fileBudgetLimitChars: 1000,
      });

      const result = tightPlugin.applyDiffBudget(files);

      expect(result.totalFiles).toBe(50);
      expect(result.includedTotalChars).toBeLessThanOrEqual(5000);
      expect(result.includedFilesCount).toBeGreaterThanOrEqual(1);
      expect(result.omittedFilesCount).toBeGreaterThan(0);
      expect(result.omittedFiles.length + result.includedFilesCount).toBe(50);
      expect(result.omissionNoticeHeader).toBeDefined();
      expect(result.omittedFiles.every((o) => o.reason === 'budget_exhausted')).toBe(true);
    });

    it('5.2 handles mixed batch containing valid, invalid, traversal, and rate-limited calls', async () => {
      const persona = 'mixed_batch_persona';
      const calls = [
        { name: 'pi.fs.readFile', arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: 1, endLine: 2 } }, // 1 (success)
        { name: 'pi.fs.readFile', arguments: { path: '../../package.json' } },                                                // 2 (security error)
        { name: 'pi.code.search', arguments: { query: 'CallRouter' } },                                                       // 3 (success)
        { name: 'unknown_tool', arguments: {} },                                                                              // 4 (error)
        { name: 'pi.symbol.lookup', arguments: { symbol: 'SipMessage' } },                                                    // 5 (success)
        { name: 'pi.fs.readFile', arguments: { path: 'sip_signaling_service/src/callRouter.ts' } },                            // 6 (rate limited)
        { name: 'pi.fs.readFile', arguments: { path: 'sip_signaling_service/src/callRouter.ts' } },                            // 7 (rate limited)
      ];

      const responses = await plugin.executeTurnBatch(persona, 1, calls);

      expect(responses.length).toBe(7);
      expect(responses[0].status).toBe('success');
      expect(responses[1].status).toBe('error');
      expect(responses[1].output).toContain('Security Error');
      expect(responses[2].status).toBe('success');
      expect(responses[3].status).toBe('error');
      expect(responses[3].output).toContain('Unknown tool');
      expect(responses[4].status).toBe('success');
      expect(responses[5].status).toBe('rate_limited');
      expect(responses[6].status).toBe('rate_limited');

      const metrics = plugin.getSessionMetrics(persona);
      expect(metrics.totalToolCalls).toBe(7);
      expect(metrics.successfulToolCalls).toBe(3);
      expect(metrics.errorCalls).toBe(2);
      expect(metrics.rateLimitedCalls).toBe(2);
      expect(metrics.receipts.length).toBe(7);
    });
  });
});
