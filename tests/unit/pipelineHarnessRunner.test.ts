/**
 * Unit Test Suite: Review Pipeline Execution Engine
 * Location: tests/unit/pipelineHarnessRunner.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
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
  PersonaFinding,
  VerifierDecision,
  PersonaType,
} from '../../src/evaluation/pipelineHarnessRunner';
import {
  createPiWorkspacePlugin,
  PiWorkspacePlugin,
} from '../../src/sandbox/piWorkspacePlugin';
import {
  EvaluationScenario,
  getScenarioById,
  getAllScenarios,
} from '../../src/evaluation/scenarios';

describe('Pipeline Harness Runner Unit Tests (Milestone M2)', () => {
  const rootRepoDir = path.resolve(__dirname, '../..');
  const telecomWorkspaceRoot = path.resolve(
    rootRepoDir,
    'tests/fixtures/workspaces/telecom-call-engine'
  );

  let runner: PipelineHarnessRunner;
  let plugin: PiWorkspacePlugin;

  beforeEach(() => {
    plugin = createPiWorkspacePlugin({
      workspaceRoot: telecomWorkspaceRoot,
      diffBudgetLimitChars: 24000,
      fileBudgetLimitChars: 8000,
      maxToolCallsPerTurn: 5,
      maxTurnsPerSession: 5,
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
  // 1. STAGE 1: 5-PERSONA PROMPT DISPATCH & DISTINCT CHARTERS
  // =========================================================================
  describe('Stage 1: 5-Persona Prompt Dispatch & Charters', () => {
    it('dispatches exactly 5 specialized reviewer personas', () => {
      expect(PERSONA_LIST).toEqual([
        'security',
        'performance',
        'architecture',
        'testing',
        'dependencies',
      ]);
    });

    it('security persona charter enforces multi-tenant isolation, OWASP top 10, and secrets', () => {
      const charter = PERSONA_CHARTERS.security;
      expect(charter.name).toBe('Security Specialist');
      expect(charter.charter).toContain('multi-tenant isolation');
      expect(charter.charter).toContain('OWASP Top 10');
      expect(charter.deepReasoningProtocol.length).toBeGreaterThanOrEqual(4);
      expect(charter.nitSuppressionRules.length).toBeGreaterThanOrEqual(2);
    });

    it('performance persona charter targets CPU/memory bottlenecks, jitter buffers, and port leaks', () => {
      const charter = PERSONA_CHARTERS.performance;
      expect(charter.name).toBe('Performance Engineer');
      expect(charter.charter).toContain('jitter buffer');
      expect(charter.charter).toContain('Resource leaks');
      expect(charter.deepReasoningProtocol.some((p) => p.includes('O(N^2)'))).toBe(true);
    });

    it('architecture persona charter targets cross-module breakages and race conditions', () => {
      const charter = PERSONA_CHARTERS.architecture;
      expect(charter.name).toBe('Systems Architect');
      expect(charter.charter).toContain('cross-module contract breakage');
      expect(charter.charter).toContain('race conditions');
      expect(charter.proactiveToolStrategy).toContain('cross-folder');
    });

    it('testing persona charter targets missing error branch tests and mock assertions', () => {
      const charter = PERSONA_CHARTERS.testing;
      expect(charter.name).toBe('Quality & Test Engineer');
      expect(charter.charter).toContain('Missing error branch tests');
      expect(charter.charter).toContain('Brittle assertions');
    });

    it('dependencies persona charter targets lockfile synchronization and supply chain risks', () => {
      const charter = PERSONA_CHARTERS.dependencies;
      expect(charter.name).toBe('DevOps & Dependencies Engineer');
      expect(charter.charter).toContain('Lockfile desynchronization');
      expect(charter.charter).toContain('Infrastructure & Deployment');
    });

    it('buildPersonaSystemPrompt generates structured prompts with tools and JSON schema for all 5 personas', () => {
      for (const persona of PERSONA_LIST) {
        const sysPrompt = buildPersonaSystemPrompt(persona);
        expect(sysPrompt).toContain(PERSONA_CHARTERS[persona].name);
        expect(sysPrompt).toContain('pi.fs.readFile');
        expect(sysPrompt).toContain('pi.code.search');
        expect(sysPrompt).toContain('pi.symbol.lookup');
        expect(sysPrompt).toContain('"decision": "APPROVE" | "FINDINGS"');
      }
    });

    it('buildPersonaUserPrompt formats PR metadata, diff budget header, and changed files', () => {
      const scenario: EvaluationScenario = {
        id: 'test-scen',
        name: 'Test Scenario',
        category: 'security',
        description: 'Test',
        diffFiles: [
          { path: 'sip_signaling_service/index.ts', patch: '@@ -1,1 +1,2 @@\n+const x = 1;' },
        ],
        prContext: {
          repo: 'calltelemetry/telecom-engine',
          prNumber: 42,
          title: 'Add call router',
          headSha: 'abc1234',
        },
        expectedFindings: [],
        expectedVerdict: 'SHIP',
      };

      const budget = plugin.applyDiffBudget(scenario.diffFiles);
      const userPrompt = buildPersonaUserPrompt(scenario, budget);

      expect(userPrompt).toContain('PR #42: Add call router');
      expect(userPrompt).toContain('Repository: calltelemetry/telecom-engine');
      expect(userPrompt).toContain('sip_signaling_service/index.ts');
      expect(userPrompt).toContain('+const x = 1;');
    });
  });

  // =========================================================================
  // 2. STAGE 2: MULTI-TURN TOOL CALLING WITH PI WORKSPACE PLUGIN
  // =========================================================================
  describe('Stage 2: Multi-Turn Tool Calling with PiWorkspacePlugin', () => {
    it('parseToolCallsFromText extracts JSON tool calls accurately', () => {
      const text = `I will read the file:\n\`\`\`json\n{\n  "tool": "pi.fs.readFile",\n  "args": { "path": "sip_signaling_service/index.ts", "startLine": 1, "endLine": 10 }\n}\n\`\`\``;
      const calls = parseToolCallsFromText(text);
      expect(calls.length).toBe(1);
      expect(calls[0].name).toBe('pi.fs.readFile');
      expect(calls[0].arguments.path).toBe('sip_signaling_service/index.ts');
    });

    it('parseToolCallsFromText extracts bracket syntax [TOOL_CALL: name(args)]', () => {
      const text = `Let me search the codebase:\n[TOOL_CALL: pi.code.search({"query": "CallTransferCoordinator"})]`;
      const calls = parseToolCallsFromText(text);
      expect(calls.length).toBe(1);
      expect(calls[0].name).toBe('pi.code.search');
      expect(calls[0].arguments.query).toBe('CallTransferCoordinator');
    });

    it('parseToolCallsFromText extracts tool_calls batch arrays', () => {
      const text = `\`\`\`json\n{\n  "tool_calls": [\n    { "name": "pi.symbol.lookup", "arguments": { "symbol": "SipStateMachine" } },\n    { "name": "pi.fs.readFile", "arguments": { "path": "pbx_device_manager/index.ts" } }\n  ]\n}\n\`\`\``;
      const calls = parseToolCallsFromText(text);
      expect(calls.length).toBe(2);
      expect(calls[0].name).toBe('pi.symbol.lookup');
      expect(calls[1].name).toBe('pi.fs.readFile');
    });

    it('enforces 24,000 char diff budget limit with omission header', () => {
      const largeDiff = 'A'.repeat(25000);
      const budgetRes = plugin.applyDiffBudget([
        { path: 'sip_signaling_service/index.ts', patch: largeDiff },
      ]);
      expect(budgetRes.originalTotalChars).toBe(25000);
      expect(budgetRes.includedTotalChars).toBeLessThanOrEqual(24000);
      expect(budgetRes.omittedTotalChars).toBeGreaterThan(0);
      expect(budgetRes.omissionNoticeHeader).toBeDefined();
    });

    it('executes multi-turn tool calling loop across 3 turns with receipts', async () => {
      const scenario: EvaluationScenario = {
        id: 'multi-turn-test',
        name: 'Multi-Turn Test',
        category: 'architecture',
        description: 'Test multi-turn tool interaction',
        diffFiles: [
          { path: 'sip_signaling_service/index.ts', patch: '@@ -1,1 +1,2 @@\n+export const v = 1;' },
        ],
        prContext: {
          repo: 'calltelemetry/telecom-engine',
          prNumber: 99,
          title: 'Multi-turn test PR',
          headSha: 'sha99',
        },
        expectedFindings: [],
        expectedVerdict: 'SHIP',
      };

      let turnCounter = 0;
      const result = await runner.executePipeline(scenario, {
        personas: ['architecture'],
        customAdapter: async (persona, turn, messages, plug) => {
          turnCounter = turn;
          if (turn === 1) {
            return {
              content: '```json\n{ "tool": "pi.fs.readFile", "args": { "path": "sip_signaling_service/index.ts", "startLine": 1, "endLine": 5 } }\n```',
              reasoning: 'Reading file slice in turn 1',
              toolCalls: [{ name: 'pi.fs.readFile', arguments: { path: 'sip_signaling_service/index.ts', startLine: 1, endLine: 5 } }],
            };
          } else if (turn === 2) {
            return {
              content: '```json\n{ "tool": "pi.symbol.lookup", "args": { "symbol": "SipStateMachine" } }\n```',
              reasoning: 'Looking up symbol in turn 2',
              toolCalls: [{ name: 'pi.symbol.lookup', arguments: { symbol: 'SipStateMachine' } }],
            };
          } else {
            return {
              content: '```json\n{ "decision": "APPROVE", "findings": [] }\n```',
              reasoning: 'Completed analysis in turn 3',
              toolCalls: [],
            };
          }
        },
      });

      expect(turnCounter).toBe(3);
      expect(result.personaResults.architecture.toolReceipts.length).toBe(2);
      expect(result.personaResults.architecture.turnCount).toBe(3);
      expect(result.arbitrationVerdict).toBe('SHIP');
    });

    it('enforces rate limit of max 5 tool calls per turn', async () => {
      const calls = Array.from({ length: 6 }, () => ({
        name: 'pi.fs.readFile',
        arguments: { path: 'sip_signaling_service/index.ts', startLine: 1, endLine: 2 },
      }));

      const responses = await plugin.executeTurnBatch('security', 1, calls);
      expect(responses[4].status).toBe('success');
      expect(responses[5].status).toBe('rate_limited');
      expect(responses[5].output).toContain('exceeded');
    });
  });

  // =========================================================================
  // 3. STAGE 3: FINDING SANITIZATION & DEDUPLICATION
  // =========================================================================
  describe('Stage 3: Finding Sanitization & Deduplication', () => {
    it('filters out findings with non-integer or <= 0 line numbers', () => {
      const raw: PersonaFinding[] = [
        { id: '1', persona: 'security', path: 'sip.ts', line: 0, severity: 'P0', title: 'Invalid Zero Line', body: '', confidence: 0.9 },
        { id: '2', persona: 'security', path: 'sip.ts', line: -5, severity: 'P0', title: 'Invalid Neg Line', body: '', confidence: 0.9 },
        { id: '3', persona: 'security', path: 'sip.ts', line: 10, severity: 'P0', title: 'Valid Line', body: 'Valid', confidence: 0.9 },
      ];
      const deduped = sanitizeAndDeduplicateFindings(raw);
      expect(deduped.length).toBe(1);
      expect(deduped[0].id).toBe('3');
    });

    it('filters out findings outside diff hunk lines when changedFiles are provided', () => {
      const changedFiles = [
        {
          path: 'sip_signaling_service/index.ts',
          patch: '@@ -10,3 +10,4 @@\n context\n+added line 11\n+added line 12\n context',
        },
      ];

      const raw: PersonaFinding[] = [
        { id: 'f-valid', persona: 'security', path: 'sip_signaling_service/index.ts', line: 11, severity: 'P0', title: 'Valid Hunk Line', body: 'Body', confidence: 0.95 },
        { id: 'f-invalid', persona: 'security', path: 'sip_signaling_service/index.ts', line: 99, severity: 'P0', title: 'Outside Hunk Line', body: 'Body', confidence: 0.95 },
      ];

      const deduped = sanitizeAndDeduplicateFindings(raw, changedFiles);
      expect(deduped.length).toBe(1);
      expect(deduped[0].id).toBe('f-valid');
    });

    it('deduplicates cross-persona findings within 5 lines and preserves highest severity', () => {
      const raw: PersonaFinding[] = [
        { id: 'f-sec', persona: 'security', path: 'cdr.ts', line: 50, severity: 'P2', title: 'Tenant Quota Omission', body: 'Low sev finding', confidence: 0.7, suggestion: 'Fix A' },
        { id: 'f-perf', persona: 'performance', path: 'cdr.ts', line: 52, severity: 'P1', title: 'Tenant Quota Omission', body: 'Med sev finding', confidence: 0.85, suggestion: 'Fix B' },
        { id: 'f-arch', persona: 'architecture', path: 'cdr.ts', line: 51, severity: 'P0', title: 'Tenant Quota Omission', body: 'Critical breach', confidence: 0.98, suggestion: 'Fix C' },
      ];

      const deduped = sanitizeAndDeduplicateFindings(raw);
      expect(deduped.length).toBe(1);
      expect(deduped[0].severity).toBe('P0');
      expect(deduped[0].confidence).toBe(0.98);
      expect(deduped[0].suggestion).toBeDefined();
    });

    it('retains distinct findings when root causes / titles differ on same line', () => {
      const raw: PersonaFinding[] = [
        { id: 'f-1', persona: 'security', path: 'sip.ts', line: 20, severity: 'P0', title: 'SQL Injection in Tenant Search', body: 'Tainted input', confidence: 0.95 },
        { id: 'f-2', persona: 'performance', path: 'sip.ts', line: 20, severity: 'P1', title: 'Blocking Sleep in Event Loop', body: 'Synchronous wait', confidence: 0.90 },
      ];

      const deduped = sanitizeAndDeduplicateFindings(raw);
      expect(deduped.length).toBe(2);
    });

    it('parseFindingsFromText parses nonced fenced blocks and raw JSON structures', () => {
      const noncedText = `CT_REVIEW_BEGIN:nonce123\n{\n  "findings": [\n    {\n      "path": "sip.ts",\n      "line": 15,\n      "severity": "P0",\n      "title": "Race Condition",\n      "body": "Unsynchronized state update"\n    }\n  ]\n}\nCT_REVIEW_END`;
      const findings = parseFindingsFromText(noncedText, 'architecture');
      expect(findings.length).toBe(1);
      expect(findings[0].severity).toBe('P0');
      expect(findings[0].line).toBe(15);
    });
  });

  // =========================================================================
  // 4. STAGE 4: FINDING VERIFIER STAGE (CHALLENGER MODEL)
  // =========================================================================
  describe('Stage 4: Finding Verifier Stage (Challenger Model)', () => {
    it('buildVerifierSystemPrompt produces authoritative challenger directives', () => {
      const prompt = buildVerifierSystemPrompt();
      expect(prompt).toContain('Finding Verifier and Challenger Model');
      expect(prompt).toContain('CONFIRM');
      expect(prompt).toContain('REJECT');
      expect(prompt).toContain('ADJUST_SEVERITY');
    });

    it('CONFIRM: confirms genuine defects with verified technical rationale', async () => {
      const findings: PersonaFinding[] = [
        {
          id: 'find-real-1',
          persona: 'security',
          path: 'sip_signaling_service/src/dialogManager.ts',
          line: 45,
          severity: 'P0',
          title: 'Unauthenticated BYE Message Processing',
          body: 'Missing authentication signature check in BYE handler',
          confidence: 0.95,
        },
      ];

      const { verifiedFindings, decisions } = await verifyFindings(findings, {
        plugin,
      });

      expect(decisions.length).toBe(1);
      expect(decisions[0].verdict).toBe('CONFIRM');
      expect(verifiedFindings.length).toBe(1);
      expect(verifiedFindings[0].id).toBe('find-real-1');
    });

    it('REJECT: eliminates false positive trap (supervised infinite timeout in listener)', async () => {
      const findings: PersonaFinding[] = [
        {
          id: 'find-trap-timeout',
          persona: 'performance',
          path: 'sip_signaling_service/src/sipServer.ts',
          line: 30,
          severity: 'P1',
          title: 'Infinite Timeout in GenServer Listener',
          body: 'Potential hanging process due to infinite timeout in listener receive block',
          confidence: 0.7,
        },
      ];

      const { verifiedFindings, decisions } = await verifyFindings(findings, {
        plugin,
      });

      expect(decisions.length).toBe(1);
      expect(decisions[0].verdict).toBe('REJECT');
      expect(decisions[0].rationale).toContain('Rejected false positive trap');
      expect(verifiedFindings.length).toBe(0);
    });

    it('REJECT: eliminates lockfree CAS retry loop false positive trap', async () => {
      const findings: PersonaFinding[] = [
        {
          id: 'find-trap-cas',
          persona: 'performance',
          path: 'rtp_media_gateway/src/jitterBuffer.ts',
          line: 120,
          severity: 'P1',
          title: 'Lock-Free CAS Loop Potential Livelock',
          body: 'Atomic compare-and-swap retry loop spins continuously under contention',
          confidence: 0.72,
        },
      ];

      const { verifiedFindings, decisions } = await verifyFindings(findings, {
        plugin,
      });

      expect(decisions[0].verdict).toBe('REJECT');
      expect(verifiedFindings.length).toBe(0);
    });

    it('ADJUST_SEVERITY: downgrades cosmetic or log formatting from P0 to P2', async () => {
      const findings: PersonaFinding[] = [
        {
          id: 'find-nit-p0',
          persona: 'testing',
          path: 'cdr_pipeline/src/logger.ts',
          line: 10,
          severity: 'P0',
          title: 'Missing structured log format key',
          body: 'Log message does not include tenant context key',
          confidence: 0.8,
        },
      ];

      const { verifiedFindings, decisions } = await verifyFindings(findings, {
        plugin,
      });

      expect(decisions[0].verdict).toBe('ADJUST_SEVERITY');
      expect(decisions[0].adjustedSeverity).toBe('P2');
      expect(verifiedFindings.length).toBe(1);
      expect(verifiedFindings[0].severity).toBe('P2');
    });

    it('supports customVerifierAdapter for scenario-specific challenger assertions', async () => {
      const findings: PersonaFinding[] = [
        { id: 'f-custom-1', persona: 'security', path: 'a.ts', line: 1, severity: 'P0', title: 'Bug A', body: '', confidence: 0.9 },
        { id: 'f-custom-2', persona: 'performance', path: 'b.ts', line: 2, severity: 'P1', title: 'Bug B', body: '', confidence: 0.9 },
      ];

      const customVerifier = async (fList: PersonaFinding[]) => [
        { findingId: 'f-custom-1', verdict: 'CONFIRM' as const, rationale: 'Confirmed by custom challenger', confidence: 0.99 },
        { findingId: 'f-custom-2', verdict: 'REJECT' as const, rationale: 'Rejected by custom challenger', confidence: 0.95 },
      ];

      const { verifiedFindings, decisions } = await verifyFindings(findings, {
        plugin,
        customVerifier,
      });

      expect(decisions.length).toBe(2);
      expect(verifiedFindings.length).toBe(1);
      expect(verifiedFindings[0].id).toBe('f-custom-1');
    });
  });

  // =========================================================================
  // 5. STAGE 5: QUORUM ARBITRATION RULES & METRICS CALCULATION
  // =========================================================================
  describe('Stage 5: Quorum Arbitration & Metrics', () => {
    it('verdict is SHIP when 0 findings exist across 5 personas', () => {
      const arb = evaluateQuorumArbitration([], 5);
      expect(arb.verdict).toBe('SHIP');
      expect(arb.quorumSatisfied).toBe(true);
    });

    it('verdict is SHIP when only 1-4 minor P2 findings exist across 5 personas', () => {
      const p2Findings: PersonaFinding[] = [
        { id: '1', persona: 'testing', path: 'test.ts', line: 5, severity: 'P2', title: 'Minor test typo', body: '', confidence: 0.8 },
        { id: '2', persona: 'dependencies', path: 'pkg.json', line: 10, severity: 'P2', title: 'Minor license note', body: '', confidence: 0.8 },
      ];
      const arb = evaluateQuorumArbitration(p2Findings, 5);
      expect(arb.verdict).toBe('SHIP');
    });

    it('verdict is FIX_FIRST when 5 or more P2 findings exist (fixP2 threshold = 5 for 5 personas)', () => {
      const p2Findings: PersonaFinding[] = Array.from({ length: 5 }, (_, i) => ({
        id: `p2-${i}`,
        persona: PERSONA_LIST[i % 5],
        path: `file_${i}.ts`,
        line: 10 + i,
        severity: 'P2',
        title: `Nit ${i}`,
        body: '',
        confidence: 0.8,
      }));
      const arb = evaluateQuorumArbitration(p2Findings, 5);
      expect(arb.verdict).toBe('FIX_FIRST');
      expect(arb.metrics.p2Count).toBe(5);
    });

    it('verdict is FIX_FIRST when 1 or 2 P1 findings exist', () => {
      const p1Findings: PersonaFinding[] = [
        { id: '1', persona: 'performance', path: 'rtp.ts', line: 20, severity: 'P1', title: 'Jitter drift', body: '', confidence: 0.9 },
        { id: '2', persona: 'testing', path: 'sip_test.ts', line: 40, severity: 'P1', title: 'Missing timeout test', body: '', confidence: 0.85 },
      ];
      const arb = evaluateQuorumArbitration(p1Findings, 5);
      expect(arb.verdict).toBe('FIX_FIRST');
    });

    it('verdict is BLOCK when 3 or more P1 findings exist (blockP1 threshold = 3 for 5 personas)', () => {
      const p1Findings: PersonaFinding[] = Array.from({ length: 3 }, (_, i) => ({
        id: `p1-${i}`,
        persona: PERSONA_LIST[i],
        path: `file_${i}.ts`,
        line: 10,
        severity: 'P1',
        title: `High Defect ${i}`,
        body: '',
        confidence: 0.9,
      }));
      const arb = evaluateQuorumArbitration(p1Findings, 5);
      expect(arb.verdict).toBe('BLOCK');
      expect(arb.rationale).toContain('at or above the blocking threshold of 3');
    });

    it('verdict is BLOCK when any P0 finding exists', () => {
      const p0Finding: PersonaFinding[] = [
        { id: 'p0-1', persona: 'security', path: 'sip.ts', line: 15, severity: 'P0', title: 'Critical Auth Bypass', body: '', confidence: 0.99 },
      ];
      const arb = evaluateQuorumArbitration(p0Finding, 5);
      expect(arb.verdict).toBe('BLOCK');
      expect(arb.metrics.p0Count).toBe(1);
    });

    it('fails closed to BLOCK (INCOMPLETE_REVIEW) when a required persona lane errors', () => {
      const arb = evaluateQuorumArbitration([], 5, {
        failedLanes: ['security'],
      });
      expect(arb.verdict).toBe('BLOCK');
      expect(arb.status).toBe('INCOMPLETE_REVIEW');
      expect(arb.quorumSatisfied).toBe(false);
    });

    it('calculatePipelineMetrics computes exact bipartite TP, FP, FN, Precision, Recall, F1, and SNR dB', () => {
      const expected = [
        { personaId: 'security', path: 'sip.ts', line: 10, severity: 'P0' as const, title: 'Bug 1' },
        { personaId: 'architecture', path: 'pbx.ts', line: 30, severity: 'P1' as const, title: 'Bug 2' },
      ];

      const actual: PersonaFinding[] = [
        { id: '1', persona: 'security', path: 'sip.ts', line: 11, severity: 'P0', title: 'Bug 1', body: '', confidence: 0.9 }, // TP (within 5 lines)
        { id: '2', persona: 'architecture', path: 'pbx.ts', line: 32, severity: 'P1', title: 'Bug 2', body: '', confidence: 0.9 }, // TP
        { id: '3', persona: 'testing', path: 'extra.ts', line: 99, severity: 'P2', title: 'Spurious', body: '', confidence: 0.7 }, // FP
      ];

      const metrics = calculatePipelineMetrics(expected, actual);
      expect(metrics.tp).toBe(2);
      expect(metrics.fp).toBe(1);
      expect(metrics.fn).toBe(0);
      expect(metrics.precision).toBeCloseTo(0.667, 2);
      expect(metrics.recall).toBe(1.0);
      expect(metrics.f1).toBeCloseTo(0.8, 1);
      expect(metrics.snrDb).toBeCloseTo(3.01, 1); // 10 * log10(2 / 1) = 3.01 dB
    });

    it('calculatePipelineMetrics handles clean PR with 20.0 dB SNR baseline', () => {
      const metrics = calculatePipelineMetrics([], []);
      expect(metrics.precision).toBe(1.0);
      expect(metrics.recall).toBe(1.0);
      expect(metrics.f1).toBe(1.0);
      expect(metrics.snrDb).toBe(20.0);
    });
  });

  // =========================================================================
  // 6. END-TO-END TELECOM SCENARIO EXECUTION
  // =========================================================================
  describe('Sample Telecom Scenario Execution', () => {
    it('Scenario 1: Attended Transfer Early BYE Race Condition -> FIX_FIRST', async () => {
      const scenario = getScenarioById('telecom-race-early-bye-transfer-handshake');
      expect(scenario).toBeDefined();

      const result = await runner.executePipeline(scenario!);
      expect(result.scenarioId).toBe('telecom-race-early-bye-transfer-handshake');
      expect(result.arbitrationVerdict).toBe('FIX_FIRST');
      expect(result.confirmedFindings.length).toBeGreaterThanOrEqual(1);
      expect(result.metrics?.tp).toBeGreaterThanOrEqual(1);
      expect(result.metrics?.precision).toBeGreaterThanOrEqual(0.8);
      expect(result.metrics?.recall).toBe(1.0);
    });

    it('Scenario 2: CDR Ingestion Dropped Tenant Scope Needle-in-Haystack -> BLOCK', async () => {
      const scenario = getScenarioById('telecom-haystack-sip-dropped-tenant');
      expect(scenario).toBeDefined();

      const result = await runner.executePipeline(scenario!);
      expect(result.scenarioId).toBe('telecom-haystack-sip-dropped-tenant');
      expect(result.arbitrationVerdict).toBe('BLOCK');
      expect(result.confirmedFindings.some((f) => f.severity === 'P0')).toBe(true);
      expect(result.metrics?.tp).toBe(1);
    });

    it('Scenario 3: Lockfree CAS Trunk Pool False Positive Trap PR -> SHIP (Verifier Rejects Trap)', async () => {
      const scenario = getScenarioById('telecom-trap-lockfree-cas-trunk-pool-ship');
      expect(scenario).toBeDefined();

      const result = await runner.executePipeline(scenario!);
      expect(result.scenarioId).toBe('telecom-trap-lockfree-cas-trunk-pool-ship');
      expect(result.arbitrationVerdict).toBe('SHIP');
      expect(result.confirmedFindings.length).toBe(0);
      expect(result.verifierDecisions.some((d) => d.verdict === 'REJECT')).toBe(true);
      expect(result.metrics?.tp).toBe(0);
      expect(result.metrics?.fp).toBe(0);
      expect(result.metrics?.precision).toBe(1.0);
    });

    it('Scenario 4: Supervised Infinite Timeout False Positive Trap PR -> SHIP', async () => {
      const scenario = getScenarioById('telecom-trap-supervised-infinite-timeout-ship');
      expect(scenario).toBeDefined();

      const result = await runner.executePipeline(scenario!);
      expect(result.scenarioId).toBe('telecom-trap-supervised-infinite-timeout-ship');
      expect(result.arbitrationVerdict).toBe('SHIP');
      expect(result.confirmedFindings.length).toBe(0);
      expect(result.verifierDecisions[0]?.verdict).toBe('REJECT');
    });

    it('runPipelineScenario helper executes correctly by scenario ID', async () => {
      const result = await runPipelineScenario('telecom-haystack-sip-dropped-tenant');
      expect(result.scenarioId).toBe('telecom-haystack-sip-dropped-tenant');
      expect(result.arbitrationVerdict).toBe('BLOCK');
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.totalCostUSD).toBeGreaterThan(0);
    });

    it('executeReviewPipeline helper executes correctly with scenario object', async () => {
      const scenario = getScenarioById('telecom-race-early-bye-transfer-handshake')!;
      const result = await executeReviewPipeline(scenario);
      expect(result.scenarioId).toBe('telecom-race-early-bye-transfer-handshake');
      expect(result.arbitrationVerdict).toBe('FIX_FIRST');
    });
  });
});
