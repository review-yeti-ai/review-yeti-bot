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

describe('PiWorkspacePlugin', () => {
  let plugin: PiWorkspacePlugin;

  beforeEach(() => {
    plugin = createPiWorkspacePlugin({
      workspaceRoot: TELECOM_WORKSPACE,
      diffBudgetLimitChars: 24000,
      fileBudgetLimitChars: 8000,
      maxToolCallsPerTurn: 5,
      maxTurnsPerSession: 5,
      maxFileReadBytes: 32768,
    });
  });

  // =========================================================================
  // 1. DIFF CHARACTER BUDGET ENGINE TESTS
  // =========================================================================
  describe('Diff Character Budget Engine', () => {
    it('handles small diff within budget with no truncation or omission notice', () => {
      const files: DiffInputFile[] = [
        {
          path: 'sip_signaling_service/src/callRouter.ts',
          patch: '--- a/sip_signaling_service/src/callRouter.ts\n+++ b/sip_signaling_service/src/callRouter.ts\n@@ -10,3 +10,4 @@\n+const routeTimeoutMs = 5000;\n',
        },
      ];

      const result = plugin.applyDiffBudget(files);

      expect(result.budgetLimitChars).toBe(24000);
      expect(result.originalTotalChars).toBe(files[0].patch!.length);
      expect(result.includedTotalChars).toBe(files[0].patch!.length);
      expect(result.omittedTotalChars).toBe(0);
      expect(result.includedFilesCount).toBe(1);
      expect(result.truncatedFilesCount).toBe(0);
      expect(result.omittedFilesCount).toBe(0);
      expect(result.omissionNoticeHeader).toBeUndefined();
      expect(result.formattedDiff).toContain('+const routeTimeoutMs = 5000;');
    });

    it('enforces 8,000 char per-file limit and performs hunk-aware boundary truncation', () => {
      const hunk1Lines = Array.from({ length: 150 }, (_, i) => `+  const intermediateVar${i} = computeValue(${i});`).join('\n');
      const hunk2Lines = Array.from({ length: 250 }, (_, i) => `+  const secondaryVar${i} = handleSecondaryValue(${i});`).join('\n');
      const largePatch = `--- a/cdr_pipeline/src/tariffRatingEngine.ts\n+++ b/cdr_pipeline/src/tariffRatingEngine.ts\n@@ -1,5 +1,155 @@\n${hunk1Lines}\n@@ -200,5 +350,255 @@\n${hunk2Lines}\n`;

      expect(largePatch.length).toBeGreaterThan(8000);

      const files: DiffInputFile[] = [
        {
          path: 'cdr_pipeline/src/tariffRatingEngine.ts',
          patch: largePatch,
        },
      ];

      const result = plugin.applyDiffBudget(files);

      expect(result.includedTotalChars).toBeLessThanOrEqual(8000);
      expect(result.truncatedFilesCount).toBe(1);
      expect(result.truncatedFiles[0].path).toBe('cdr_pipeline/src/tariffRatingEngine.ts');
      expect(result.truncatedFiles[0].omittedLines).toBeGreaterThan(0);
      expect(result.formattedDiff).toContain('... [Diff truncated:');
      expect(result.formattedDiff).toContain('lines omitted. Use pi.fs.readFile(');
      expect(result.omissionNoticeHeader).toBeDefined();
      expect(result.omissionNoticeHeader).toContain('[DIFF_BUDGET_NOTICE]');
      expect(result.omissionNoticeHeader).toContain('tariffRatingEngine.ts');
    });

    it('enforces 24,000 global char budget and prioritizes security/core files over test/config', () => {
      const testPatch = `--- a/tests/unit/sipTest.test.ts\n+++ b/tests/unit/sipTest.test.ts\n@@ -1,1 +1,300 @@\n` +
        Array.from({ length: 250 }, (_, i) => `+test('case ${i}', () => { expect(${i}).toBe(${i}); });`).join('\n');

      const authPatch = `--- a/pbx_device_manager/src/digestAuth.ts\n+++ b/pbx_device_manager/src/digestAuth.ts\n@@ -1,1 +1,200 @@\n` +
        Array.from({ length: 180 }, (_, i) => `+function verifyDigestNonce${i}() { return true; }`).join('\n');

      const signalingPatch = `--- a/sip_signaling_service/src/sipStateMachine.ts\n+++ b/sip_signaling_service/src/sipStateMachine.ts\n@@ -1,1 +1,250 @@\n` +
        Array.from({ length: 220 }, (_, i) => `+function handleSipTransition${i}() { return 'ACK'; }`).join('\n');

      const configPatch = `--- a/pbx_device_manager/package.json\n+++ b/pbx_device_manager/package.json\n@@ -1,1 +1,200 @@\n` +
        Array.from({ length: 180 }, (_, i) => `+  "dependency_${i}": "1.0.${i}",`).join('\n');

      const files: DiffInputFile[] = [
        { path: 'tests/unit/sipTest.test.ts', patch: testPatch },
        { path: 'pbx_device_manager/src/digestAuth.ts', patch: authPatch },
        { path: 'sip_signaling_service/src/sipStateMachine.ts', patch: signalingPatch },
        { path: 'pbx_device_manager/package.json', patch: configPatch },
      ];

      const customPlugin = createPiWorkspacePlugin({
        workspaceRoot: TELECOM_WORKSPACE,
        diffBudgetLimitChars: 12000,
        fileBudgetLimitChars: 6000,
      });

      const result = customPlugin.applyDiffBudget(files);

      expect(result.includedTotalChars).toBeLessThanOrEqual(12000);
      expect(result.omittedTotalChars).toBeGreaterThan(0);
      expect(result.omissionNoticeHeader).toBeDefined();
      expect(result.formattedDiff).toContain('digestAuth.ts');
      expect(result.formattedDiff).toContain('sipStateMachine.ts');
    });

    it('exhausts budget across multiple files and records omitted files metadata', () => {
      const smallBudgetPlugin = createPiWorkspacePlugin({
        workspaceRoot: TELECOM_WORKSPACE,
        diffBudgetLimitChars: 2000,
        fileBudgetLimitChars: 1000,
      });

      const files: DiffInputFile[] = [
        {
          path: 'sip_signaling_service/src/callRouter.ts',
          patch: '--- a/sip_signaling_service/src/callRouter.ts\n+++ b/sip_signaling_service/src/callRouter.ts\n@@ -1,1 +1,50 @@\n' +
            Array.from({ length: 30 }, (_, i) => `+const routeLine${i} = 'call-route-${i}';`).join('\n'),
        },
        {
          path: 'rtp_media_gateway/src/portAllocator.ts',
          patch: '--- a/rtp_media_gateway/src/portAllocator.ts\n+++ b/rtp_media_gateway/src/portAllocator.ts\n@@ -1,1 +1,50 @@\n' +
            Array.from({ length: 30 }, (_, i) => `+const portLine${i} = 'port-${i}';`).join('\n'),
        },
        {
          path: 'cdr_pipeline/src/batchSqlLogger.ts',
          patch: '--- a/cdr_pipeline/src/batchSqlLogger.ts\n+++ b/cdr_pipeline/src/batchSqlLogger.ts\n@@ -1,1 +1,50 @@\n' +
            Array.from({ length: 30 }, (_, i) => `+const sqlLine${i} = 'sql-${i}';`).join('\n'),
        },
      ];

      const result = smallBudgetPlugin.applyDiffBudget(files);

      expect(result.includedTotalChars).toBeLessThanOrEqual(2000);
      expect(result.omittedFiles.length).toBeGreaterThanOrEqual(1);
      expect(result.omittedFiles.some((f) => f.reason === 'budget_exhausted')).toBe(true);
    });

    it('automatically omits lockfiles and generated files with proper reasons', () => {
      const files: DiffInputFile[] = [
        {
          path: 'package-lock.json',
          patch: '--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,10 +1,10 @@\n+  "lockfileVersion": 3,\n',
        },
        {
          path: 'dist/bundle.min.js',
          patch: '--- a/dist/bundle.min.js\n+++ b/dist/bundle.min.js\n@@ -1,1 +1,1 @@\n+var x=1;/*minified*/\n',
        },
        {
          path: 'sip_signaling_service/src/callRouter.ts',
          patch: '--- a/sip_signaling_service/src/callRouter.ts\n+++ b/sip_signaling_service/src/callRouter.ts\n@@ -1,3 +1,4 @@\n+export const ROUTE_OK = 200;\n',
        },
      ];

      const result = plugin.applyDiffBudget(files);

      expect(result.omittedFilesCount).toBe(2);
      expect(result.omittedFiles.find((f) => f.path === 'package-lock.json')?.reason).toBe('lockfile');
      expect(result.omittedFiles.find((f) => f.path === 'dist/bundle.min.js')?.reason).toBe('generated');
      expect(result.includedFilesCount).toBe(1);
      expect(result.formattedDiff).toContain('ROUTE_OK = 200');
    });

    it('synthesizes unified diff when raw content is provided instead of patch', () => {
      const files: DiffInputFile[] = [
        {
          path: 'sip_signaling_service/src/types.ts',
          content: 'export interface CallSession {\n  id: string;\n  active: boolean;\n}',
        },
      ];

      const result = plugin.applyDiffBudget(files);

      expect(result.includedFilesCount).toBe(1);
      expect(result.formattedDiff).toContain('--- a/sip_signaling_service/src/types.ts');
      expect(result.formattedDiff).toContain('+++ b/sip_signaling_service/src/types.ts');
      expect(result.formattedDiff).toContain('+export interface CallSession {');
    });

    it('handles empty diff input gracefully', () => {
      const result = plugin.applyDiffBudget([]);
      expect(result.originalTotalChars).toBe(0);
      expect(result.includedTotalChars).toBe(0);
      expect(result.omittedTotalChars).toBe(0);
      expect(result.totalFiles).toBe(0);
      expect(result.formattedDiff).toBe('');
    });
  });

  // =========================================================================
  // 2. VFS SECURITY LAYER TESTS
  // =========================================================================
  describe('VFS Security Layer', () => {
    it('blocks directory traversal attacks (../, ..\\, etc.)', async () => {
      await expect(
        plugin.executeTool('security_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: { path: '../../package.json' },
        })
      ).resolves.toMatchObject({
        status: 'error',
        output: expect.stringContaining('Security Error: PiVfsSecurityError: Access denied: path traversal out of workspace root'),
      });

      await expect(
        plugin.executeTool('security_persona', 1, {
          name: 'file_read',
          arguments: { path: 'sip_signaling_service/../../../../etc/passwd' },
        })
      ).resolves.toMatchObject({
        status: 'error',
        output: expect.stringContaining('Security Error: PiVfsSecurityError: Access denied: path traversal out of workspace root'),
      });
    });

    it('blocks encoded directory traversal sequences (%2e%2e)', async () => {
      await expect(
        plugin.executeTool('security_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: { path: '%2e%2e/%2e%2e/package.json' },
        })
      ).resolves.toMatchObject({
        status: 'error',
        output: expect.stringContaining('Security Error: PiVfsSecurityError: Access denied: path traversal out of workspace root'),
      });
    });

    it('blocks null byte poison attacks', async () => {
      await expect(
        plugin.executeTool('security_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'package.json\0.png' },
        })
      ).resolves.toMatchObject({
        status: 'error',
        output: expect.stringContaining('Path contains invalid null bytes'),
      });

      await expect(
        plugin.executeTool('security_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'package.json%00.png' },
        })
      ).resolves.toMatchObject({
        status: 'error',
        output: expect.stringContaining('Path contains encoded control/null characters'),
      });
    });

    it('blocks absolute paths outside workspace root', async () => {
      await expect(
        plugin.executeTool('security_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: { path: '/etc/shadow' },
        })
      ).resolves.toMatchObject({
        status: 'error',
        output: expect.stringContaining('Security Error: PiVfsSecurityError: Access denied: path traversal out of workspace root'),
      });
    });

    it('blocks non-existent files outside root before disk read', async () => {
      await expect(
        plugin.executeTool('security_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: { path: '../../../unlikely_file_9999.xyz' },
        })
      ).resolves.toMatchObject({
        status: 'error',
        output: expect.stringContaining('Access denied: path traversal out of workspace root'),
      });
    });

    it('blocks symlink jailbreak attempts outside workspace root', async () => {
      const symlinkPath = path.join(TELECOM_WORKSPACE, 'test_jailbreak_symlink');
      const tempTarget = path.join(os.tmpdir(), 'ct_secret_target.txt');

      try {
        fs.writeFileSync(tempTarget, 'SECRET_KEY_OUTSIDE_WORKSPACE');
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        fs.symlinkSync(tempTarget, symlinkPath);

        const response = await plugin.executeTool('security_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'test_jailbreak_symlink' },
        });

        expect(response.status).toBe('error');
        expect(response.output).toContain('symlink resolves outside workspace root');
      } finally {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        if (fs.existsSync(tempTarget)) {
          fs.unlinkSync(tempTarget);
        }
      }
    });
  });

  // =========================================================================
  // 3. SANDBOXED TOOL OPERATIONS TESTS
  // =========================================================================
  describe('Sandboxed Tool Operations', () => {
    describe('pi.fs.readFile', () => {
      it('reads real workspace file with line numbers', async () => {
        const response = await plugin.executeTool('security_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'sip_signaling_service/src/callRouter.ts' },
        });

        expect(response.status).toBe('success');
        expect(response.output).toContain('1:');
        expect(response.output).toContain('CallRouter');
        expect(response.bytesRead).toBeGreaterThan(0);
      });

      it('reads specified line slice (startLine to endLine)', async () => {
        const response = await plugin.executeTool('security_persona', 1, {
          name: 'file_read',
          arguments: {
            path: 'sip_signaling_service/src/callRouter.ts',
            startLine: 1,
            endLine: 5,
          },
        });

        expect(response.status).toBe('success');
        const lines = response.output.split('\n');
        expect(lines.length).toBeLessThanOrEqual(5);
        expect(lines[0]).toMatch(/^1:\s*/);
      });

      it('returns informative message when startLine exceeds total lines', async () => {
        const response = await plugin.executeTool('security_persona', 1, {
          name: 'read_file',
          arguments: {
            path: 'sip_signaling_service/src/callRouter.ts',
            startLine: 99999,
            endLine: 100005,
          },
        });

        expect(response.status).toBe('success');
        expect(response.output).toContain('empty (file has');
      });

      it('returns error when file does not exist', async () => {
        const response = await plugin.executeTool('security_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'sip_signaling_service/src/nonExistentFile.ts' },
        });

        expect(response.status).toBe('success');
        expect(response.output).toContain('Error: File not found in workspace');
      });

      it('returns error when path is a directory', async () => {
        const response = await plugin.executeTool('security_persona', 1, {
          name: 'view_file',
          arguments: { path: 'sip_signaling_service/src' },
        });

        expect(response.status).toBe('success');
        expect(response.output).toContain('Error: Path is a directory, not a file');
      });

      it('respects maxBytes bounding and indicates output truncation', async () => {
        const response = await plugin.executeTool('security_persona', 1, {
          name: 'pi.fs.readFile',
          arguments: {
            path: 'sip_signaling_service/src/sipStateMachine.ts',
            maxBytes: 200,
          },
        });

        expect(response.status).toBe('success');
        expect(response.output).toContain('... [Output truncated: exceeds maxBytes limit] ...');
      });
    });

    describe('pi.code.search', () => {
      it('executes literal search across workspace files', async () => {
        const response = await plugin.executeTool('arch_persona', 1, {
          name: 'pi.code.search',
          arguments: { query: 'DialogManager' },
        });

        expect(response.status).toBe('success');
        expect(response.output).toContain('sip_signaling_service/src/dialogManager.ts:');
        expect(response.bytesRead).toBeGreaterThan(0);
      });

      it('executes regex search with case sensitivity option', async () => {
        const response = await plugin.executeTool('arch_persona', 1, {
          name: 'code_search',
          arguments: {
            query: 'export\\s+class\\s+PortAllocator',
            caseSensitive: true,
          },
        });

        expect(response.status).toBe('success');
        expect(response.output).toContain('rtp_media_gateway/src/portAllocator.ts:');
        expect(response.output).toContain('export class PortAllocator');
      });

      it('filters files using fileGlob and subdirectory', async () => {
        const response = await plugin.executeTool('arch_persona', 1, {
          name: 'grep_search',
          arguments: {
            query: 'export',
            dir: 'cdr_pipeline',
            fileGlob: '*tariff*',
          },
        });

        expect(response.status).toBe('success');
        expect(response.output).toContain('tariffRatingEngine.ts');
        expect(response.output).not.toContain('sipStateMachine.ts');
      });

      it('handles ReDoS/malformed regex gracefully by falling back to safe literal search', async () => {
        const response = await plugin.executeTool('arch_persona', 1, {
          name: 'search_code',
          arguments: { query: '[unclosed-regex-bracket' },
        });

        expect(response.status).toBe('success');
        expect(response.output).toBeDefined();
      });

      it('returns helpful notice when no matches are found', async () => {
        const response = await plugin.executeTool('arch_persona', 1, {
          name: 'pi.code.search',
          arguments: { query: 'NonExistentZebraIdentifier999' },
        });

        expect(response.status).toBe('success');
        expect(response.output).toContain('No matches found for query "NonExistentZebraIdentifier999"');
      });
    });

    describe('pi.symbol.lookup', () => {
      it('looks up class symbols across the workspace', async () => {
        const response = await plugin.executeTool('perf_persona', 1, {
          name: 'pi.symbol.lookup',
          arguments: { symbol: 'JitterBuffer' },
        });

        expect(response.status).toBe('success');
        expect(response.output).toContain('rtp_media_gateway/src/jitterBuffer.ts:');
        expect(response.output).toContain('[class]');
      });

      it('looks up interface symbols with kind filter', async () => {
        const response = await plugin.executeTool('perf_persona', 1, {
          name: 'symbol_lookup',
          arguments: { symbol: 'SipMessage', kind: 'interface' },
        });

        expect(response.status).toBe('success');
        expect(response.output).toContain('[interface]');
      });

      it('looks up method and function declarations', async () => {
        const response = await plugin.executeTool('perf_persona', 1, {
          name: 'ast_lookup',
          arguments: { symbol: 'allocateTrunk' },
        });

        expect(response.status).toBe('success');
        expect(response.output).toContain('pbx_device_manager/src/trunkAllocator.ts:');
      });

      it('returns helpful notice when symbol is not found', async () => {
        const response = await plugin.executeTool('perf_persona', 1, {
          name: 'pi.symbol.lookup',
          arguments: { symbol: 'GhostSymbolX' },
        });

        expect(response.status).toBe('success');
        expect(response.output).toContain('No symbol definitions found for "GhostSymbolX"');
      });
    });

    it('returns informative error for unknown tools', async () => {
      const response = await plugin.executeTool('persona_1', 1, {
        name: 'unknown_dangerous_tool',
        arguments: {},
      });

      expect(response.status).toBe('error');
      expect(response.output).toContain('Unknown tool "unknown_dangerous_tool"');
    });
  });

  // =========================================================================
  // 4. RATE LIMITING & OVERHEAD ACCOUNTING TESTS
  // =========================================================================
  describe('Rate Limiting & Overhead Accounting', () => {
    it('allows up to 5 tool calls per turn and enforces rate limit on 6th+ call', async () => {
      const persona = 'tester_persona';

      for (let i = 1; i <= 5; i++) {
        const resp = await plugin.executeTool(persona, 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: i, endLine: i },
        });
        expect(resp.status).toBe('success');
      }

      const resp6 = await plugin.executeTool(persona, 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: 6, endLine: 6 },
      });

      expect(resp6.status).toBe('rate_limited');
      expect(resp6.output).toContain('[RATE_LIMIT_EXCEEDED]: Maximum 5 tool calls per turn exceeded. Call 6');

      const respTurn2Call1 = await plugin.executeTool(persona, 2, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: 1, endLine: 1 },
      });
      expect(respTurn2Call1.status).toBe('success');
    });

    it('maintains strict isolation between different personas', async () => {
      const personaA = 'persona_security';
      const personaB = 'persona_perf';

      // Persona A uses all 5 turn calls
      for (let i = 1; i <= 5; i++) {
        const resp = await plugin.executeTool(personaA, 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: i, endLine: i },
        });
        expect(resp.status).toBe('success');
      }

      // Persona A call 6 is rate limited
      const respA6 = await plugin.executeTool(personaA, 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts' },
      });
      expect(respA6.status).toBe('rate_limited');

      // Persona B is still fresh on turn 1 and can make calls
      const respB1 = await plugin.executeTool(personaB, 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts' },
      });
      expect(respB1.status).toBe('success');

      // Persona metrics are isolated
      const metricsA = plugin.getSessionMetrics(personaA);
      const metricsB = plugin.getSessionMetrics(personaB);

      expect(metricsA.totalToolCalls).toBe(6);
      expect(metricsA.rateLimitedCalls).toBe(1);
      expect(metricsB.totalToolCalls).toBe(1);
      expect(metricsB.rateLimitedCalls).toBe(0);
    });

    it('enforces max turns per session limit', async () => {
      const persona = 'turn_limit_persona';

      const resp = await plugin.executeTool(persona, 6, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts' },
      });

      expect(resp.status).toBe('rate_limited');
      expect(resp.output).toContain('[RATE_LIMIT_EXCEEDED]: Maximum turns (5) reached for persona session.');
    });

    it('executes batch calls and partitions success from rate-limited calls', async () => {
      const persona = 'batch_persona';
      const calls = Array.from({ length: 7 }, (_, i) => ({
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: i + 1, endLine: i + 1 },
      }));

      const responses = await plugin.executeTurnBatch(persona, 1, calls);

      expect(responses.length).toBe(7);
      expect(responses[0].status).toBe('success');
      expect(responses[4].status).toBe('success');
      expect(responses[5].status).toBe('rate_limited');
      expect(responses[6].status).toBe('rate_limited');
    });

    it('tracks detailed receipts, I/O metrics, and token cost ledger', async () => {
      const persona = 'metrics_persona';

      await plugin.executeTool(persona, 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts' },
      });

      await plugin.executeTool(persona, 1, {
        name: 'pi.code.search',
        arguments: { query: 'CallRouter' },
      });

      const metrics = plugin.getSessionMetrics(persona);

      expect(metrics.totalToolCalls).toBe(2);
      expect(metrics.successfulToolCalls).toBe(2);
      expect(metrics.rateLimitedCalls).toBe(0);
      expect(metrics.errorCalls).toBe(0);
      expect(metrics.totalBytesRead).toBeGreaterThan(0);
      expect(metrics.totalFilesScanned).toBeGreaterThan(0);
      expect(metrics.totalToolDurationMs).toBeGreaterThan(0);
      expect(metrics.totalPromptTokens).toBeGreaterThan(0);
      expect(metrics.totalCompletionTokens).toBeGreaterThan(0);
      expect(metrics.totalCostUSD).toBeGreaterThan(0);
      expect(metrics.receipts.length).toBe(2);

      const receipt = metrics.receipts[0];
      expect(receipt.callId).toMatch(/^call_\d+_/);
      expect(receipt.personaId).toBe(persona);
      expect(receipt.turn).toBe(1);
      expect(receipt.toolName).toBe('pi.fs.readFile');
      expect(receipt.status).toBe('success');
    });

    it('supports resetSession and resetTurn', async () => {
      const persona = 'reset_persona';

      for (let i = 1; i <= 5; i++) {
        await plugin.executeTool(persona, 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'sip_signaling_service/src/callRouter.ts' },
        });
      }

      plugin.resetTurn?.(persona);

      const respAfterReset = await plugin.executeTool(persona, 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts' },
      });
      expect(respAfterReset.status).toBe('success');

      plugin.resetSession(persona);
      const metrics = plugin.getSessionMetrics(persona);
      expect(metrics.totalToolCalls).toBe(0);
      expect(metrics.receipts.length).toBe(0);
    });
  });
});
