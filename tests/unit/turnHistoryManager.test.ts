/**
 * Turn History Manager Unit & Compaction Test Suite (Tiers 1-3)
 * Location: tests/unit/turnHistoryManager.test.ts
 *
 * Requirements: R2 (Multi-Turn History Compaction & Rolling Findings Memory)
 * - Tier 1: 2-turn sliding window fidelity.
 * - Tier 2: Multi-turn tool execution (5+ turns) verifying old tool outputs are summarized into receipts while findings ledger is preserved.
 * - Tier 3: Token budget bounding (<2000 tokens for historical turns).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  TurnHistoryManager,
} from '../../src/pipeline/turnHistoryManager';
import type {
  TurnMessage,
  TurnHistoryManagerOptions,
  FindingEntry,
  ReceiptEntry,
} from '../../src/pipeline/turnHistoryManager';

export type {
  TurnMessage,
  TurnHistoryManagerOptions,
  FindingEntry,
  ReceiptEntry,
};
export { TurnHistoryManager };

// ============================================================================
// TEST SUITE: TIERS 1 TO 3
// ============================================================================

describe('TurnHistoryManager Unit & Compaction Tests (Tiers 1-3)', () => {
  let manager: TurnHistoryManager;

  beforeEach(() => {
    manager = new TurnHistoryManager({ activeTurnWindow: 2, maxTurnHistoryTokens: 8000 });
  });

  // ==========================================================================
  // TIER 1: 2-TURN SLIDING WINDOW FIDELITY
  // ==========================================================================
  describe('Tier 1: 2-Turn Sliding Window Fidelity', () => {
    it('TEST_T1_01: single turn retains 100% full content and tool receipts', () => {
      const rawOutput = 'const a = 1;\nconst b = 2;\nconst c = 3;';
      manager.addTurn('user', 'Please review this module', [
        { callId: 'c1', tool: 'pi.fs.readFile', status: 'success', output: rawOutput },
      ]);

      const messages = manager.getFormattedMessages();
      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Please review this module');
      expect(messages[0].toolReceipts?.[0].output).toBe(rawOutput);
    });

    it('TEST_T1_02: two turns maintain 100% full fidelity with zero compaction', () => {
      manager.addTurn('user', 'Turn 1 initial prompt');
      manager.addTurn('assistant', 'Turn 2 assistant response with analysis', [
        { callId: 'c2', tool: 'pi.code.search', status: 'success', output: 'Match found at line 42' },
      ]);

      const messages = manager.getFormattedMessages();
      expect(messages.length).toBe(2);
      expect(messages[0].content).toBe('Turn 1 initial prompt');
      expect(messages[1].content).toBe('Turn 2 assistant response with analysis');
      expect(messages[1].toolReceipts?.[0].output).toBe('Match found at line 42');
    });

    it('TEST_T1_03: system prompt is preserved at index 0 without alteration', () => {
      const customManager = new TurnHistoryManager({
        activeTurnWindow: 2,
        systemPrompt: 'You are the Security persona reviewer.',
      });

      customManager.addTurn('user', 'Turn 1');
      const messages = customManager.getFormattedMessages();

      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toBe('You are the Security persona reviewer.');
      expect(messages[1].role).toBe('user');
    });

    it('TEST_T1_04: custom activeTurnWindow (e.g. 3) preserves 3 active turns', () => {
      const customManager = new TurnHistoryManager({ activeTurnWindow: 3 });
      customManager.addTurn('user', 'Turn 1');
      customManager.addTurn('assistant', 'Turn 2');
      customManager.addTurn('user', 'Turn 3');

      const messages = customManager.getFormattedMessages();
      expect(messages.length).toBe(3);
      // None of the 3 turns should be prefixed with [Historical Turn]
      expect(messages.every((m) => !m.content.startsWith('[Historical Turn'))).toBe(true);
    });

    it('TEST_T1_05: formatted messages strictly conform to TurnMessage contract', () => {
      manager.addTurn('user', 'Analyze diff', [
        { callId: 'call_1', tool: 'pi.fs.readFile', status: 'success', output: 'line 1' },
      ]);
      const [msg] = manager.getFormattedMessages();

      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('content');
      expect(msg).toHaveProperty('toolReceipts');
      expect(['system', 'user', 'assistant', 'tool']).toContain(msg.role);
    });
  });

  // ==========================================================================
  // TIER 2: MULTI-TURN TOOL EXECUTION (5+ TURNS) & FINDINGS PRESERVATION
  // ==========================================================================
  describe('Tier 2: Multi-Turn Tool Execution (5+ Turns) & Ledger Preservation', () => {
    it('TEST_T2_01: 5-turn session compacts turns 1-3 while turns 4-5 remain full fidelity', () => {
      for (let i = 1; i <= 5; i++) {
        manager.addTurn(
          i % 2 === 1 ? 'user' : 'assistant',
          `Turn ${i} verbose reasoning and queries for file inspection...`,
          [{ callId: `c_${i}`, tool: 'pi.fs.readFile', status: 'success', output: `File output for turn ${i}` }]
        );
      }

      const messages = manager.getFormattedMessages();
      expect(messages.length).toBe(5);

      // Turns 1, 2, 3 must be compacted
      expect(messages[0].content).toContain('[Historical Turn 1]');
      expect(messages[1].content).toContain('[Historical Turn 2]');
      expect(messages[2].content).toContain('[Historical Turn 3]');
      expect(messages[0].toolReceipts?.[0].output).toContain('[Compact Receipt: success');

      // Turns 4, 5 must be in full fidelity
      expect(messages[3].content).toBe('Turn 4 verbose reasoning and queries for file inspection...');
      expect(messages[4].content).toBe('Turn 5 verbose reasoning and queries for file inspection...');
      expect(messages[4].toolReceipts?.[0].output).toBe('File output for turn 5');
    });

    it('TEST_T2_02: findings discovered in early turns are strictly preserved in getFindingsLedger()', () => {
      // Turn 1 discovers a P0 bug
      manager.addTurn('assistant', JSON.stringify({
        findings: [{ id: 'p0-sql-injection', severity: 'P0', title: 'SQL Injection in Auth query' }],
      }));

      // Turn 2 discovers a P1 bug
      manager.addTurn('assistant', JSON.stringify({
        findings: [{ id: 'p1-memory-leak', severity: 'P1', title: 'Unreleased buffer in RTP handler' }],
      }));

      // Turns 3, 4, 5 are subsequent investigative chatter
      manager.addTurn('user', 'Look for additional concurrency hazards');
      manager.addTurn('assistant', 'Searching workspace for mutex locks...');
      manager.addTurn('user', 'Final turn question');

      const findings = manager.getFindingsLedger();
      expect(findings.length).toBe(2);
      expect(findings.find((f) => f.id === 'p0-sql-injection')).toEqual({
        id: 'p0-sql-injection',
        summary: 'SQL Injection in Auth query',
        severity: 'P0',
      });
      expect(findings.find((f) => f.id === 'p1-memory-leak')).toEqual({
        id: 'p1-memory-leak',
        summary: 'Unreleased buffer in RTP handler',
        severity: 'P1',
      });
    });

    it('TEST_T2_03: receipt ledger maintains ordered history of all tool executions across turns', () => {
      manager.addTurn('assistant', 'Search step', [
        { callId: 'c1', tool: 'pi.code.search', status: 'success', output: 'Found 3 results' },
      ]);
      manager.addTurn('assistant', 'Read step', [
        { callId: 'c2', tool: 'pi.fs.readFile', status: 'success', output: 'export function processCall()' },
      ]);
      manager.addTurn('assistant', 'Symbol step', [
        { callId: 'c3', tool: 'pi.symbol.lookup', status: 'success', output: 'class SipStateMachine' },
      ]);

      const receipts = manager.getReceiptLedger();
      expect(receipts.length).toBe(3);
      expect(receipts[0].tool).toBe('pi.code.search');
      expect(receipts[1].tool).toBe('pi.fs.readFile');
      expect(receipts[2].tool).toBe('pi.symbol.lookup');
      expect(receipts[0].turn).toBe(1);
      expect(receipts[1].turn).toBe(2);
      expect(receipts[2].turn).toBe(3);
    });

    it('TEST_T2_04: deduplicates findings with identical IDs across multiple turns', () => {
      manager.addTurn('assistant', JSON.stringify({
        findings: [{ id: 'duplicate-bug', severity: 'P1', title: 'First mention of race condition' }],
      }));
      manager.addTurn('assistant', JSON.stringify({
        findings: [{ id: 'duplicate-bug', severity: 'P1', title: 'Confirmed race condition' }],
      }));

      const findings = manager.getFindingsLedger();
      expect(findings.length).toBe(1);
      expect(findings[0].id).toBe('duplicate-bug');
    });

    it('TEST_T2_05: parses unstructured finding format (Finding [P0]: ...)', () => {
      manager.addTurn('assistant', 'During my review I noticed Finding [P0]: Critical unauthenticated bypass in sip.ts');
      const findings = manager.getFindingsLedger();

      expect(findings.length).toBe(1);
      expect(findings[0].severity).toBe('P0');
      expect(findings[0].summary).toContain('Critical unauthenticated bypass in sip.ts');
    });
  });

  // ==========================================================================
  // TIER 3: TOKEN BUDGET BOUNDING (<2000 TOKENS FOR HISTORICAL TURNS)
  // ==========================================================================
  describe('Tier 3: Token Budget Bounding (<2000 Tokens for Historical Turns)', () => {
    it('TEST_T3_01: massive 30,000 char tool outputs in turns 1-3 are compacted to <2000 tokens', () => {
      // Simulate heavy tool outputs in turns 1-3
      for (let i = 1; i <= 3; i++) {
        manager.addTurn('assistant', `Turn ${i} review commentary`, [
          {
            callId: `heavy_call_${i}`,
            tool: 'pi.fs.readFile',
            status: 'success',
            output: 'A'.repeat(10000), // 10,000 chars each turn
          },
        ]);
      }

      // Add turns 4 and 5 (active window)
      manager.addTurn('user', 'Can you verify line 50?');
      manager.addTurn('assistant', 'Line 50 is verified clean.');

      // Check tokens of historical messages
      const formatted = manager.getFormattedMessages();
      const historicalMessages = formatted.slice(0, 3);

      let historicalChars = 0;
      for (const msg of historicalMessages) {
        historicalChars += msg.content.length;
        if (msg.toolReceipts) {
          for (const r of msg.toolReceipts) {
            historicalChars += r.output.length;
          }
        }
      }

      const historicalTokens = Math.ceil(historicalChars / 3.8);
      // Historical turns had 30,000+ chars (~8,000 tokens), now compacted to < 2,000 tokens
      expect(historicalTokens).toBeLessThan(2000);
      expect(manager.getEstimatedTokens()).toBeLessThan(3000);
    });

    it('TEST_T3_02: token reduction ratio on heavy historical turns exceeds 75%', () => {
      const rawHistoricalChars = 20000;
      manager.addTurn('assistant', 'A'.repeat(5000), [
        { callId: 'c1', tool: 'pi.fs.readFile', status: 'success', output: 'X'.repeat(rawHistoricalChars) },
      ]);
      manager.addTurn('assistant', 'A'.repeat(5000), [
        { callId: 'c2', tool: 'pi.fs.readFile', status: 'success', output: 'Y'.repeat(rawHistoricalChars) },
      ]);
      manager.addTurn('user', 'Active turn 3');
      manager.addTurn('assistant', 'Active turn 4');

      const messages = manager.getFormattedMessages();
      const compactedTurn1Chars = messages[0].content.length + (messages[0].toolReceipts?.[0].output.length || 0);

      const savings = (rawHistoricalChars + 5000 - compactedTurn1Chars) / (rawHistoricalChars + 5000);
      expect(savings).toBeGreaterThan(0.75);
    });

    it('TEST_T3_03: empty content and zero tool receipts handle gracefully without negative tokens', () => {
      manager.addTurn('user', '');
      manager.addTurn('assistant', '');

      expect(manager.getEstimatedTokens()).toBe(0);
      const messages = manager.getFormattedMessages();
      expect(messages.length).toBe(2);
    });
  });
});
