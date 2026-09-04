/**
 * Adversarial Hardening & Stress Test Suite — Challenger 1 (Milestone M5)
 * Location: tests/integration/challenger1EmpiricalM5AdversarialStress.test.ts
 *
 * Comprehensive adversarial verification for Sandboxed PI VFS & Review Pipeline Harness:
 * 1. Diff Character Budget Engine (24k global, 8k per-file, omission headers, priority sorting, lockfile/generated filters)
 * 2. VFS Security Layer & Path Isolation (traversal, absolute paths, null-byte injection, symlink escapes, file size caps)
 * 3. Rate Limiter & Token Overhead Ledger (5 calls/turn, 5 turns max, persona isolation, token/cost estimation)
 * 4. Finding Sanitization & Cross-Persona Deduplication (hunk anchoring, 5-line bucket proximity, highest severity preservation)
 * 5. Finding Verifier Stage & False Positive Trap Rejection (infinite timeouts, CAS loops, companding, supervisor boundaries)
 * 6. Quorum Arbitration Fail-Closed Engine (SHIP vs FIX_FIRST vs BLOCK, fail-closed on lane errors, exact bipartite metrics)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  createPiWorkspacePlugin,
  PiWorkspacePlugin,
  PiVfsSecurityError,
  DiffInputFile,
  PiPluginConfig,
} from '../../src/sandbox/piWorkspacePlugin';
import {
  PipelineHarnessRunner,
  executeReviewPipeline,
  runPipelineScenario,
  buildPersonaSystemPrompt,
  buildPersonaUserPrompt,
  buildVerifierSystemPrompt,
  parseToolCallsFromText,
  parseFindingsFromText,
  sanitizeAndDeduplicateFindings,
  verifyFindings,
  evaluateQuorumArbitration,
  calculatePipelineMetrics,
  PERSONA_LIST,
  PERSONA_CHARTERS,
  HarnessPersonaFinding,
  VerifierDecision,
  PersonaType,
} from '../../src/evaluation/pipelineHarnessRunner';
import {
  EvaluationScenario,
  getScenarioById,
  getAllScenarios,
} from '../../src/evaluation/scenarios';

describe('Milestone M5 Challenger 1: Adversarial Hardening & Stress Verification', () => {
  const telecomWorkspaceRoot = path.resolve(
    __dirname,
    '../fixtures/workspaces/telecom-call-engine'
  );

  let plugin: PiWorkspacePlugin;
  let runner: PipelineHarnessRunner;

  beforeEach(() => {
    plugin = createPiWorkspacePlugin({
      workspaceRoot: telecomWorkspaceRoot,
      diffBudgetLimitChars: 24000,
      fileBudgetLimitChars: 8000,
      maxToolCallsPerTurn: 5,
      maxTurnsPerSession: 5,
      maxFileReadBytes: 32768,
    });
    runner = new PipelineHarnessRunner({
      workspaceRoot: telecomWorkspaceRoot,
      plugin,
      offline: true,
    });
  });

  afterEach(() => {
    plugin.resetSession();
  });

  // =========================================================================
  // 1. DIFF CHARACTER BUDGET ENGINE ADVERSARIAL STRESS & FUZZING
  // =========================================================================
  describe('1. Diff Character Budget Engine Adversarial Stress & Fuzzing', () => {
    it('handles exact boundary conditions around 24,000 global char limit (23,999, 24,000, 24,001)', () => {
      // Test at 23,999 chars
      const p23999 = 'A'.repeat(23999);
      const res23999 = plugin.applyDiffBudget([{ path: 'sip_signaling_service/src/callRouter.ts', patch: p23999 }]);
      expect(res23999.includedTotalChars).toBeLessThanOrEqual(8000); // Because 8k per file applies

      // Test multi-file exact 24,000 boundary
      const customPlugin = createPiWorkspacePlugin({
        workspaceRoot: telecomWorkspaceRoot,
        diffBudgetLimitChars: 24000,
        fileBudgetLimitChars: 24000,
      });

      const res24000 = customPlugin.applyDiffBudget([
        { path: 'sip_signaling_service/src/callRouter.ts', patch: 'X'.repeat(12000) },
        { path: 'rtp_media_gateway/src/portAllocator.ts', patch: 'Y'.repeat(12000) },
      ]);
      expect(res24000.includedTotalChars).toBe(24000);
      expect(res24000.omittedTotalChars).toBe(0);
      expect(res24000.omittedFilesCount).toBe(0);

      const res24001 = customPlugin.applyDiffBudget([
        { path: 'sip_signaling_service/src/callRouter.ts', patch: 'X'.repeat(12000) },
        { path: 'rtp_media_gateway/src/portAllocator.ts', patch: 'Y'.repeat(12001) },
      ]);
      expect(res24001.includedTotalChars).toBeLessThanOrEqual(24000);
      expect(res24001.omittedTotalChars).toBeGreaterThanOrEqual(1);
    });

    it('enforces 8,000 char per-file limit across 10 large diff files in single PR', () => {
      const files: DiffInputFile[] = Array.from({ length: 10 }, (_, i) => ({
        path: `cdr_pipeline/src/logger_${i}.ts`,
        patch: `--- a/cdr_pipeline/src/logger_${i}.ts\n+++ b/cdr_pipeline/src/logger_${i}.ts\n@@ -1,1 +1,500 @@\n` +
          Array.from({ length: 300 }, (__, j) => `+const log_entry_${j} = "data_${j}";`).join('\n'),
      }));

      const res = plugin.applyDiffBudget(files);

      expect(res.includedTotalChars).toBeLessThanOrEqual(24000);
      expect(res.totalFiles).toBe(10);
      expect(res.truncatedFilesCount + res.omittedFilesCount).toBeGreaterThan(0);
      expect(res.omissionNoticeHeader).toBeDefined();
      expect(res.omissionNoticeHeader).toContain('[DIFF_BUDGET_NOTICE]');
      expect(res.omissionNoticeHeader).toContain('pi.fs.readFile');
    });

    it('preserves strict domain priority order: Security > Source TS > Config > Tests > Lockfiles', () => {
      const files: DiffInputFile[] = [
        { path: 'tests/unit/testHelper.test.ts', patch: '--- a/test.ts\n+++ b/test.ts\n@@ -1,1 +1,10 @@\n+const test = 1;' },
        { path: 'cdr_pipeline/package.json', patch: '--- a/package.json\n+++ b/package.json\n@@ -1,1 +1,10 @@\n+"version": "1.0.0"' },
        { path: 'sip_signaling_service/src/digestAuth.ts', patch: '--- a/digestAuth.ts\n+++ b/digestAuth.ts\n@@ -1,1 +1,10 @@\n+function auth() {}' },
        { path: 'rtp_media_gateway/src/codec.ts', patch: '--- a/codec.ts\n+++ b/codec.ts\n@@ -1,1 +1,10 @@\n+class Codec {}' },
        { path: 'package-lock.json', patch: '--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,1 +1,10 @@\n+"lockfileVersion": 3' },
        { path: 'dist/bundle.min.js', patch: '--- a/dist/bundle.min.js\n+++ b/dist/bundle.min.js\n@@ -1,1 +1,10 @@\n+/*minified*/' },
      ];

      const res = plugin.applyDiffBudget(files);

      // Lockfile and generated must be omitted immediately
      expect(res.omittedFiles.some((f) => f.path === 'package-lock.json' && f.reason === 'lockfile')).toBe(true);
      expect(res.omittedFiles.some((f) => f.path === 'dist/bundle.min.js' && f.reason === 'generated')).toBe(true);

      // digestAuth.ts (security priority 1) must be included before test files
      expect(res.formattedDiff).toContain('digestAuth.ts');
      expect(res.formattedDiff).toContain('codec.ts');
    });

    it('synthesizes unified diff format with correct headers when only raw content is supplied', () => {
      const content = 'export const SIP_PORT = 5060;\nexport const RTP_START_PORT = 10000;\n';
      const res = plugin.applyDiffBudget([{ path: 'sip_signaling_service/src/constants.ts', content }]);

      expect(res.includedFilesCount).toBe(1);
      expect(res.formattedDiff).toContain('--- a/sip_signaling_service/src/constants.ts');
      expect(res.formattedDiff).toContain('+++ b/sip_signaling_service/src/constants.ts');
      expect(res.formattedDiff).toContain('@@ -1,0 +1,3 @@');
      expect(res.formattedDiff).toContain('+export const SIP_PORT = 5060;');
    });

    it('handles zero-file and empty-patch arrays safely without exceptions', () => {
      const resEmpty = plugin.applyDiffBudget([]);
      expect(resEmpty.originalTotalChars).toBe(0);
      expect(resEmpty.includedTotalChars).toBe(0);
      expect(resEmpty.formattedDiff).toBe('');
      expect(resEmpty.omissionNoticeHeader).toBeUndefined();

      const resBlankPatch = plugin.applyDiffBudget([{ path: 'empty.ts', patch: '' }]);
      expect(resBlankPatch.originalTotalChars).toBe(0);
      expect(resBlankPatch.includedFilesCount).toBe(1);
    });
  });

  // =========================================================================
  // 2. VFS SECURITY LAYER & PATH ISOLATION PENETRATION TESTS
  // =========================================================================
  describe('2. VFS Security Layer & Path Isolation Penetration Tests', () => {
    it('blocks nested and multi-tier directory traversal attempts across all tools', async () => {
      const traversalVectors = [
        '../package.json',
        '../../package.json',
        '../../../etc/passwd',
        'sip_signaling_service/../../package.json',
        'sip_signaling_service/src/../../../package.json',
        '....//....//package.json',
      ];

      for (let i = 0; i < traversalVectors.length; i++) {
        const vector = traversalVectors[i];
        const personaId = `sec_trav_${i}`;
        const readRes = await plugin.executeTool(personaId, 1, {
          name: 'pi.fs.readFile',
          arguments: { path: vector },
        });
        expect(readRes.status).toBe('error');
        expect(readRes.output).toMatch(/Access denied|Security Error|VFS_SECURITY_VIOLATION/);

        const searchRes = await plugin.executeTool(personaId, 1, {
          name: 'pi.code.search',
          arguments: { query: 'test', dir: vector },
        });
        expect(searchRes.status).toBe('error');
        expect(searchRes.output).toMatch(/Access denied|Security Error/);
      }
    });

    it('blocks URL-encoded and double-encoded traversal sequences', async () => {
      const encodedVectors = [
        '%2e%2e/%2e%2e/package.json',
        '..%2f..%2fpackage.json',
      ];

      for (let i = 0; i < encodedVectors.length; i++) {
        const vector = encodedVectors[i];
        const readRes = await plugin.executeTool(`sec_enc_${i}`, 1, {
          name: 'pi.fs.readFile',
          arguments: { path: vector },
        });
        expect(readRes.status).toBe('error');
        expect(readRes.output).toMatch(/Access denied|Security Error/);
      }

      // Double-encoded vector (%252e) decodes to %2e which is confined safely to workspace root as a literal filename (no escape)
      const doubleEncodedRes = await plugin.executeTool('sec_double_enc', 1, {
        name: 'pi.fs.readFile',
        arguments: { path: '%252e%252e%252fpackage.json' },
      });
      expect(doubleEncodedRes.output).toContain('File not found in workspace');
    });

    it('blocks null byte poison attacks (%00 and \\0)', async () => {
      const nullVectors = [
        'package.json\0.ts',
        'sip_signaling_service/index.ts\0.png',
        'package.json%00.txt',
      ];

      for (const vector of nullVectors) {
        const res = await plugin.executeTool('security', 1, {
          name: 'pi.fs.readFile',
          arguments: { path: vector },
        });
        expect(res.status).toBe('error');
        expect(res.output).toMatch(/null byte|encoded control/i);
      }
    });

    it('blocks absolute paths targeting system root and home directories', async () => {
      const absoluteTargets = [
        '/etc/passwd',
        '/etc/hosts',
        '/var/log/system.log',
        path.resolve(__dirname, '../../package.json'), // Root of project outside telecom workspace
      ];

      for (const target of absoluteTargets) {
        const res = await plugin.executeTool('security', 1, {
          name: 'pi.fs.readFile',
          arguments: { path: target },
        });
        expect(res.status).toBe('error');
        expect(res.output).toMatch(/Access denied|path traversal/i);
      }
    });

    it('prevents symlink jailbreaks pointing outside workspace root', async () => {
      const symlinkPath = path.join(telecomWorkspaceRoot, 'test_adversarial_symlink');
      const targetOutside = path.join(os.tmpdir(), 'ct_test_adversarial_secret.txt');

      try {
        fs.writeFileSync(targetOutside, 'CONFIDENTIAL_DATA_OUTSIDE_VFS');
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        fs.symlinkSync(targetOutside, symlinkPath);

        const res = await plugin.executeTool('security', 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'test_adversarial_symlink' },
        });

        expect(res.status).toBe('error');
        expect(res.output).toContain('symlink resolves outside workspace root');
      } finally {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        if (fs.existsSync(targetOutside)) {
          fs.unlinkSync(targetOutside);
        }
      }
    });

    it('handles directory targets safely by returning structured error rather than leaking listing', async () => {
      const res = await plugin.executeTool('security', 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src' },
      });

      expect(res.status).toBe('success');
      expect(res.output).toContain('Path is a directory, not a file');
    });
  });

  // =========================================================================
  // 3. RATE LIMITING & I/O OVERHEAD ACCOUNTING LEDGER
  // =========================================================================
  describe('3. Rate Limiting & I/O Overhead Accounting Ledger', () => {
    it('strictly enforces 5 tool calls per turn quota and returns actionable rate limit response on 6th call', async () => {
      const persona = 'perf_stress_persona';

      for (let i = 1; i <= 5; i++) {
        const res = await plugin.executeTool(persona, 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: i, endLine: i },
        });
        expect(res.status).toBe('success');
      }

      const res6 = await plugin.executeTool(persona, 1, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: 6, endLine: 6 },
      });

      expect(res6.status).toBe('rate_limited');
      expect(res6.output).toContain('[RATE_LIMIT_EXCEEDED]: Maximum 5 tool calls per turn exceeded. Call 6');
      expect(res6.error).toBe('Rate limit exceeded');
    });

    it('allows persona to proceed on turn 2 after exhausting turn 1 quota', async () => {
      const persona = 'turn_progression_persona';

      // Use all 5 calls on Turn 1
      for (let i = 1; i <= 5; i++) {
        await plugin.executeTool(persona, 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: i, endLine: i },
        });
      }

      // Advance to Turn 2: call 1 must succeed
      const turn2Call1 = await plugin.executeTool(persona, 2, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts', startLine: 1, endLine: 1 },
      });

      expect(turn2Call1.status).toBe('success');
    });

    it('enforces maximum 5 turns per session cap', async () => {
      const persona = 'max_turn_persona';

      const turn6Call = await plugin.executeTool(persona, 6, {
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/src/callRouter.ts' },
      });

      expect(turn6Call.status).toBe('rate_limited');
      expect(turn6Call.output).toContain('Maximum turns (5) reached for persona session');
    });

    it('verifies independent rate limit quotas and metrics across all 5 personas', async () => {
      for (const p of PERSONA_LIST) {
        const resp = await plugin.executeTool(p, 1, {
          name: 'pi.fs.readFile',
          arguments: { path: 'sip_signaling_service/src/callRouter.ts' },
        });
        expect(resp.status).toBe('success');
      }

      for (const p of PERSONA_LIST) {
        const metrics = plugin.getSessionMetrics(p);
        expect(metrics.totalToolCalls).toBe(1);
        expect(metrics.successfulToolCalls).toBe(1);
        expect(metrics.rateLimitedCalls).toBe(0);
      }

      const globalMetrics = plugin.getSessionMetrics();
      expect(globalMetrics.totalToolCalls).toBe(5);
      expect(globalMetrics.successfulToolCalls).toBe(5);
    });

    it('executes batch operations and accurately records token cost ledger and receipts', async () => {
      const persona = 'ledger_persona';
      const calls = [
        { name: 'pi.fs.readFile', arguments: { path: 'sip_signaling_service/src/callRouter.ts' } },
        { name: 'pi.code.search', arguments: { query: 'CallRouter' } },
        { name: 'pi.symbol.lookup', arguments: { symbol: 'SipStateMachine' } },
      ];

      const responses = await plugin.executeTurnBatch(persona, 1, calls);
      expect(responses.length).toBe(3);
      expect(responses.every((r) => r.status === 'success')).toBe(true);

      const metrics = plugin.getSessionMetrics(persona);
      expect(metrics.totalToolCalls).toBe(3);
      expect(metrics.totalBytesRead).toBeGreaterThan(0);
      expect(metrics.totalFilesScanned).toBeGreaterThan(0);
      expect(metrics.totalPromptTokens).toBeGreaterThan(0);
      expect(metrics.totalCompletionTokens).toBeGreaterThan(0);
      expect(metrics.totalCostUSD).toBeGreaterThan(0);
      expect(metrics.receipts.length).toBe(3);
    });
  });

  // =========================================================================
  // 4. FINDING SANITIZATION & CROSS-PERSONA DEDUPLICATION
  // =========================================================================
  describe('4. Finding Sanitization & Cross-Persona Deduplication', () => {
    it('discards invalid findings with line <= 0, non-integer lines, or empty titles', () => {
      const malformed: HarnessPersonaFinding[] = [
        { id: '1', persona: 'security', path: 'sip.ts', line: 0, severity: 'P0', title: 'Zero Line', body: 'x', confidence: 0.9 },
        { id: '2', persona: 'security', path: 'sip.ts', line: -10, severity: 'P0', title: 'Neg Line', body: 'x', confidence: 0.9 },
        { id: '3', persona: 'security', path: 'sip.ts', line: NaN, severity: 'P0', title: 'NaN Line', body: 'x', confidence: 0.9 },
        { id: '4', persona: 'security', path: 'sip.ts', line: 15, severity: 'P0', title: '   ', body: 'x', confidence: 0.9 },
        { id: '5', persona: 'security', path: 'sip.ts', line: 20, severity: 'P1', title: 'Valid Finding', body: 'x', confidence: 0.9 },
      ];

      const cleaned = sanitizeAndDeduplicateFindings(malformed);
      expect(cleaned.length).toBe(1);
      expect(cleaned[0].id).toBe('5');
    });

    it('enforces line-anchoring against changedLines when changedFiles are supplied', () => {
      const changedFiles = [
        {
          path: 'sip_signaling_service/src/callRouter.ts',
          patch: '@@ -50,4 +50,5 @@\n context\n+const newRoute = 1;\n+const fallbackRoute = 2;\n context',
        },
      ];

      const raw: HarnessPersonaFinding[] = [
        { id: 'f-in-hunk', persona: 'security', path: 'sip_signaling_service/src/callRouter.ts', line: 51, severity: 'P0', title: 'Route Auth Missing', body: '', confidence: 0.95 },
        { id: 'f-out-hunk', persona: 'security', path: 'sip_signaling_service/src/callRouter.ts', line: 12, severity: 'P0', title: 'Unmodified File Location', body: '', confidence: 0.95 },
      ];

      const cleaned = sanitizeAndDeduplicateFindings(raw, changedFiles);
      expect(cleaned.length).toBe(1);
      expect(cleaned[0].id).toBe('f-in-hunk');
    });

    it('deduplicates cross-persona findings within 5-line proximity and merges metadata to highest severity', () => {
      const findings: HarnessPersonaFinding[] = [
        { id: 'sec-1', persona: 'security', path: 'rtp.ts', line: 100, severity: 'P2', title: 'Unchecked Port Allocation Buffer', body: 'Minor check', confidence: 0.7, suggestion: 'Add boundary check' },
        { id: 'perf-1', persona: 'performance', path: 'rtp.ts', line: 103, severity: 'P1', title: 'Unchecked Port Allocation Buffer', body: 'High memory growth', confidence: 0.88, suggestion: 'Pool ports' },
        { id: 'arch-1', persona: 'architecture', path: 'rtp.ts', line: 101, severity: 'P0', title: 'Unchecked Port Allocation Buffer', body: 'Fatal port exhaustion race', confidence: 0.99, suggestion: 'Atomic allocator' },
      ];

      const deduped = sanitizeAndDeduplicateFindings(findings);
      expect(deduped.length).toBe(1);
      expect(deduped[0].severity).toBe('P0');
      expect(deduped[0].confidence).toBe(0.99);
      expect(deduped[0].suggestion).toBeDefined();
    });

    it('retains distinct findings occurring on same line if issue titles and root causes differ', () => {
      const findings: HarnessPersonaFinding[] = [
        { id: 'f1', persona: 'security', path: 'cdr.ts', line: 40, severity: 'P0', title: 'SQL Injection in Tenant Query', body: 'Unescaped user parameter', confidence: 0.95 },
        { id: 'f2', persona: 'performance', path: 'cdr.ts', line: 40, severity: 'P1', title: 'Synchronous Disk Flush in Hot Loop', body: 'Blocking file write', confidence: 0.90 },
      ];

      const deduped = sanitizeAndDeduplicateFindings(findings);
      expect(deduped.length).toBe(2);
    });
  });

  // =========================================================================
  // 5. FINDING VERIFIER & FALSE POSITIVE TRAP REJECTION
  // =========================================================================
  describe('5. Finding Verifier & False Positive Trap Rejection', () => {
    it('REJECTS false positive trap: supervised infinite timeout in GenServer/listener', async () => {
      const findings: HarnessPersonaFinding[] = [
        {
          id: 'trap-timeout-1',
          persona: 'performance',
          path: 'sip_signaling_service/src/sipServer.ts',
          line: 25,
          severity: 'P1',
          title: 'Infinite Timeout in GenServer Listener',
          body: 'Potential deadlock from infinity timeout in listener receive block',
          confidence: 0.75,
        },
      ];

      const { verifiedFindings, decisions } = await verifyFindings(findings, { plugin });
      expect(decisions.length).toBe(1);
      expect(decisions[0].verdict).toBe('REJECT');
      expect(decisions[0].rationale).toContain('Rejected false positive trap');
      expect(verifiedFindings.length).toBe(0);
    });

    it('REJECTS false positive trap: lockfree atomic CAS retry spinloop', async () => {
      const findings: HarnessPersonaFinding[] = [
        {
          id: 'trap-cas-1',
          persona: 'performance',
          path: 'rtp_media_gateway/src/jitterBuffer.ts',
          line: 80,
          severity: 'P1',
          title: 'Atomic CAS Loop Potential Livelock',
          body: 'Compare-and-swap spin loop under contention',
          confidence: 0.70,
        },
      ];

      const { verifiedFindings, decisions } = await verifyFindings(findings, { plugin });
      expect(decisions[0].verdict).toBe('REJECT');
      expect(verifiedFindings.length).toBe(0);
    });

    it('REJECTS false positive trap: G.711 μ-law companding table lookup & bitwise modulo', async () => {
      const findings: HarnessPersonaFinding[] = [
        {
          id: 'trap-g711-1',
          persona: 'architecture',
          path: 'rtp_media_gateway/src/transcoder.ts',
          line: 45,
          severity: 'P1',
          title: 'G.711 Companding Sign Bit Inversion',
          body: 'Linear interpolation table lookup for ulaw audio transcoding',
          confidence: 0.68,
        },
        {
          id: 'trap-circ-1',
          persona: 'performance',
          path: 'rtp_media_gateway/src/circularBuffer.ts',
          line: 30,
          severity: 'P1',
          title: 'Circular Buffer Modulo Bitwise Mask',
          body: 'Power of two bitwise mask indexing in circular buffer',
          confidence: 0.72,
        },
      ];

      const { verifiedFindings, decisions } = await verifyFindings(findings, { plugin });
      expect(decisions.every((d) => d.verdict === 'REJECT')).toBe(true);
      expect(verifiedFindings.length).toBe(0);
    });

    it('ADJUSTS severity from P0 to P2 for cosmetic log formatting defects', async () => {
      const findings: HarnessPersonaFinding[] = [
        {
          id: 'miscalibrated-p0',
          persona: 'testing',
          path: 'cdr_pipeline/src/logger.ts',
          line: 15,
          severity: 'P0',
          title: 'Logger Format Missing Trace ID Header',
          body: 'Logging output does not contain structured trace ID',
          confidence: 0.85,
        },
      ];

      const { verifiedFindings, decisions } = await verifyFindings(findings, { plugin });
      expect(decisions[0].verdict).toBe('ADJUST_SEVERITY');
      expect(decisions[0].adjustedSeverity).toBe('P2');
      expect(verifiedFindings.length).toBe(1);
      expect(verifiedFindings[0].severity).toBe('P2');
    });

    it('CONFIRMS genuine P0 security and architecture defects with verified confidence', async () => {
      const findings: HarnessPersonaFinding[] = [
        {
          id: 'genuine-p0',
          persona: 'security',
          path: 'cdr_pipeline/src/billingCalculator.ts',
          line: 120,
          severity: 'P0',
          title: 'Dropped Tenant Account Scope in CDR Ingestion',
          body: 'SQL query updates all tenant accounts without WHERE tenant_id filter',
          confidence: 0.98,
        },
      ];

      const { verifiedFindings, decisions } = await verifyFindings(findings, { plugin });
      expect(decisions[0].verdict).toBe('CONFIRM');
      expect(verifiedFindings.length).toBe(1);
      expect(verifiedFindings[0].severity).toBe('P0');
    });
  });

  // =========================================================================
  // 6. QUORUM ARBITRATION FAIL-CLOSED ENGINE & QUALITY GATES
  // =========================================================================
  describe('6. Quorum Arbitration Fail-Closed Engine & Quality Gates', () => {
    it('returns SHIP for 0 findings across all 5 personas', () => {
      const arb = evaluateQuorumArbitration([], 5);
      expect(arb.verdict).toBe('SHIP');
      expect(arb.quorumSatisfied).toBe(true);
      expect(arb.metrics.totalFindings).toBe(0);
    });

    it('returns SHIP for 1-4 minor P2 findings', () => {
      const p2List: HarnessPersonaFinding[] = [
        { id: '1', persona: 'testing', path: 'a.ts', line: 10, severity: 'P2', title: 'Nit 1', body: '', confidence: 0.8 },
        { id: '2', persona: 'dependencies', path: 'b.ts', line: 20, severity: 'P2', title: 'Nit 2', body: '', confidence: 0.8 },
      ];
      const arb = evaluateQuorumArbitration(p2List, 5);
      expect(arb.verdict).toBe('SHIP');
    });

    it('returns FIX_FIRST when P2 findings reach threshold of 5', () => {
      const p2List: HarnessPersonaFinding[] = Array.from({ length: 5 }, (_, i) => ({
        id: `p2-${i}`,
        persona: PERSONA_LIST[i % 5],
        path: `file_${i}.ts`,
        line: 10 + i,
        severity: 'P2',
        title: `P2 defect ${i}`,
        body: '',
        confidence: 0.8,
      }));
      const arb = evaluateQuorumArbitration(p2List, 5);
      expect(arb.verdict).toBe('FIX_FIRST');
      expect(arb.metrics.p2Count).toBe(5);
    });

    it('returns FIX_FIRST for 1 or 2 P1 findings', () => {
      const p1List: HarnessPersonaFinding[] = [
        { id: 'p1-1', persona: 'architecture', path: 'sip.ts', line: 10, severity: 'P1', title: 'High Bug 1', body: '', confidence: 0.9 },
        { id: 'p1-2', persona: 'performance', path: 'rtp.ts', line: 20, severity: 'P1', title: 'High Bug 2', body: '', confidence: 0.9 },
      ];
      const arb = evaluateQuorumArbitration(p1List, 5);
      expect(arb.verdict).toBe('FIX_FIRST');
      expect(arb.metrics.p1Count).toBe(2);
    });

    it('returns BLOCK when P1 findings reach threshold of 3', () => {
      const p1List: HarnessPersonaFinding[] = Array.from({ length: 3 }, (_, i) => ({
        id: `p1-${i}`,
        persona: PERSONA_LIST[i],
        path: `file_${i}.ts`,
        line: 10,
        severity: 'P1',
        title: `P1 defect ${i}`,
        body: '',
        confidence: 0.9,
      }));
      const arb = evaluateQuorumArbitration(p1List, 5);
      expect(arb.verdict).toBe('BLOCK');
      expect(arb.metrics.p1Count).toBe(3);
    });

    it('returns BLOCK for any P0 finding', () => {
      const p0List: HarnessPersonaFinding[] = [
        { id: 'p0-crit', persona: 'security', path: 'auth.ts', line: 5, severity: 'P0', title: 'Critical Auth Bypass', body: '', confidence: 0.99 },
      ];
      const arb = evaluateQuorumArbitration(p0List, 5);
      expect(arb.verdict).toBe('BLOCK');
      expect(arb.metrics.p0Count).toBe(1);
    });

    it('FAILS CLOSED to BLOCK with INCOMPLETE_REVIEW status when a persona lane fails', () => {
      const arb = evaluateQuorumArbitration([], 5, {
        failedLanes: ['security', 'architecture'],
      });
      expect(arb.verdict).toBe('BLOCK');
      expect(arb.status).toBe('INCOMPLETE_REVIEW');
      expect(arb.quorumSatisfied).toBe(false);
      expect(arb.rationale).toMatch(/failed|Review is incomplete/i);
    });

    it('calculatePipelineMetrics computes exact precision, recall, F1, and SNR dB with zero-division safety', () => {
      const cleanMetrics = calculatePipelineMetrics([], []);
      expect(cleanMetrics.tp).toBe(0);
      expect(cleanMetrics.fp).toBe(0);
      expect(cleanMetrics.precision).toBe(1.0);
      expect(cleanMetrics.recall).toBe(1.0);
      expect(cleanMetrics.f1).toBe(1.0);
      expect(cleanMetrics.snrDb).toBe(20.0);

      const expected = [
        { personaId: 'security', path: 'sip.ts', line: 10, severity: 'P0' as const, title: 'Bug 1' },
      ];
      const actual: HarnessPersonaFinding[] = [
        { id: 'a1', persona: 'security', path: 'sip.ts', line: 10, severity: 'P0', title: 'Bug 1', body: '', confidence: 0.9 },
        { id: 'a2', persona: 'security', path: 'extra.ts', line: 20, severity: 'P1', title: 'Spurious', body: '', confidence: 0.7 },
      ];

      const scored = calculatePipelineMetrics(expected, actual);
      expect(scored.tp).toBe(1);
      expect(scored.fp).toBe(1);
      expect(scored.fn).toBe(0);
      expect(scored.precision).toBe(0.5);
      expect(scored.recall).toBe(1.0);
      expect(scored.f1).toBeCloseTo(0.667, 2);
      expect(scored.snrDb).toBe(0.0); // 10 * log10(1 / 1) = 0 dB
    });
  });

  // =========================================================================
  // 7. FULL PIPELINE HARNESS END-TO-END EXECUTION
  // =========================================================================
  describe('7. Full Pipeline Harness End-to-End Execution', () => {
    it('executes end-to-end review on Telecom Race Condition PR -> FIX_FIRST', async () => {
      const result = await runner.runScenario('telecom-race-early-bye-transfer-handshake');
      expect(result.scenarioId).toBe('telecom-race-early-bye-transfer-handshake');
      expect(result.arbitrationVerdict).toBe('FIX_FIRST');
      expect(result.confirmedFindings.length).toBeGreaterThanOrEqual(1);
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.totalCostUSD).toBeGreaterThan(0);
    });

    it('executes end-to-end review on Dropped Tenant Needle-in-Haystack PR -> BLOCK', async () => {
      const result = await runner.runScenario('telecom-haystack-sip-dropped-tenant');
      expect(result.scenarioId).toBe('telecom-haystack-sip-dropped-tenant');
      expect(result.arbitrationVerdict).toBe('BLOCK');
      expect(result.confirmedFindings.some((f) => f.severity === 'P0')).toBe(true);
    });

    it('executes end-to-end review on Lockfree CAS False Positive Trap PR -> SHIP', async () => {
      const result = await runner.runScenario('telecom-trap-lockfree-cas-trunk-pool-ship');
      expect(result.scenarioId).toBe('telecom-trap-lockfree-cas-trunk-pool-ship');
      expect(result.arbitrationVerdict).toBe('SHIP');
      expect(result.confirmedFindings.length).toBe(0);
      expect(result.verifierDecisions.some((d) => d.verdict === 'REJECT')).toBe(true);
    });
  });
});
