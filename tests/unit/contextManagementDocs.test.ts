import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Context Management Documentation (docs/features/context_management.md)', () => {
  const rootRepoDir = path.resolve(__dirname, '../..');
  const docsPath = path.join(rootRepoDir, 'docs/features/context_management.md');

  it('1. verifies docs/features/context_management.md exists and is non-empty', () => {
    expect(fs.existsSync(docsPath)).toBe(true);
    const content = fs.readFileSync(docsPath, 'utf8');
    expect(content.length).toBeGreaterThan(5000);
  });

  it('2. verifies all required sections and headings are present', () => {
    const content = fs.readFileSync(docsPath, 'utf8');

    const requiredHeadings = [
      '# Review Yeti Context Management Architecture',
      '## Table of Contents',
      '## 1. Executive Summary & Architectural Principles',
      '## 2. Dynamic Model Context Window Discovery',
      '## 3. Safe Diff Character Capacity Mathematical Model',
      '## 4. Intelligent Diff & AST Context Compaction',
      '### 4.1 Context Line Bounds Reduction',
      '### 4.2 Change Cluster Splitting on Large Gaps',
      '### 4.3 Mathematical Proof of Line Number Invariance',
      '### 4.4 Lockfile, Minified Bundle, and Generated Asset Stripping',
      '### 4.5 Whitespace and Line Ending Normalization',
      '## 5. Stateful Multi-Turn History Management (`TurnHistoryManager`)',
      '### 5.1 Active Sliding Window',
      '### 5.2 Compact Tool Receipts',
      '### 5.3 Rolling Findings Memory Ledger',
      '### 5.4 Context Token Bounding',
      '## 6. Commit SHA Range Tracking & Zero-Loss File Partitioning',
      '### 6.1 Explicit Commit Range',
      '### 6.2 Complete PR File Manifest Table',
      '### 6.3 Deterministic Zero-Loss Bin-Packing Algorithm',
      '### 6.4 Single Oversized File Hunk-Level Splitting',
      '### 6.5 Cross-Partition Finding Aggregation & Arbitration',
      '### 6.6 PR Comment Coverage Telemetry Badges & Step Outputs',
      '## 7. Operational Configuration Reference',
      '## 8. CLI Usage & Developer Guide',
      '## 9. Benchmark & Quality Gate Verification',
      '## 10. End-to-End Architectural Pipeline Flow',
    ];

    for (const heading of requiredHeadings) {
      expect(content).toContain(heading);
    }
  });

  it('3. verifies safe diff character capacity formulas and mathematical constants', () => {
    const content = fs.readFileSync(docsPath, 'utf8');

    // Mathematical formulas
    expect(content).toMatch(/C_{\\text\{safe\}}/);
    expect(content).toContain('3.8'); // empirical characters per token ratio
    expect(content).toContain('4,000'); // system prompt tokens
    expect(content).toContain('16,000'); // tool reserve tokens
    expect(content).toContain('410,400'); // 128k calculation
    expect(content).toContain('684,000'); // 200k calculation
    expect(content).toContain('3,908,588'); // 1M calculation
    expect(content).toContain('7,893,177'); // 2M calculation
  });

  it('4. verifies static model context matrix covers all approved model families', () => {
    const content = fs.readFileSync(docsPath, 'utf8');

    const expectedModels = [
      'deepseek/deepseek-v4-flash-0731:low',
      'deepseek/deepseek-v4-flash-0731:high',
      'openrouter/5.6-luna-high',
      'qwen/qwen-3.8-27b:high',
      'google/gemini-3.7-flash:high',
      'google/gemini-2.5-pro',
      'anthropic/claude-3.7-sonnet',
      'openai/gpt-4o',
    ];

    for (const model of expectedModels) {
      expect(content).toContain(model);
    }
    expect(content).toContain('128,000 tokens');
    expect(content).toContain('1,048,576 tokens');
    expect(content).toContain('2,097,152 tokens');
    expect(content).toContain('200,000 tokens');
  });

  it('5. verifies diff compaction rules, line number invariance proof, and asset stripping', () => {
    const content = fs.readFileSync(docsPath, 'utf8');

    // ±3 lines context bounds and >6 lines cluster splitting
    expect(content).toContain('Context Line Bounds Reduction');
    expect(content).toContain('Change Cluster Splitting on Large Gaps');
    expect(content).toContain('3 leading context lines');
    expect(content).toContain('3 trailing context lines');
    expect(content).toContain('more than 6 unchanged context lines');

    // Mathematical proof symbols
    expect(content).toContain('changedLineNumbers');
    expect(content).toContain('newStart');
    expect(content).toContain('oldCount');
    expect(content).toContain('newCount');

    // Lockfile and minified bundle patterns
    expect(content).toContain('package-lock.json');
    expect(content).toContain('yarn.lock');
    expect(content).toContain('pnpm-lock.yaml');
    expect(content).toContain('cargo.lock');
    expect(content).toContain('*.min.js');
    expect(content).toContain('500 characters');
  });

  it('6. verifies multi-turn history manager rules, token bounding, and findings ledger', () => {
    const content = fs.readFileSync(docsPath, 'utf8');

    expect(content).toContain('TurnHistoryManager');
    expect(content).toContain('2-Turn Full Fidelity');
    expect(content).toContain('[Compact Receipt:');
    expect(content).toContain('Rolling Findings Memory Ledger');
    expect(content).toContain('<2,000 Tokens');
    expect(content).toMatch(/P0/);
    expect(content).toMatch(/P1/);
    expect(content).toMatch(/P2/);
  });

  it('7. verifies commit SHA range tracking, complete manifest table, and zero-loss partitioning', () => {
    const content = fs.readFileSync(docsPath, 'utf8');

    expect(content).toContain('base_sha...head_sha');
    expect(content).toContain('Complete PR File Manifest Table');
    expect(content).toContain('Zero-Loss Bin-Packing Algorithm');
    expect(content).toContain('Single Oversized File Hunk-Level Splitting');
    expect(content).toContain('Cross-Partition Finding Aggregation');
  });

  it('8. verifies PR comment coverage telemetry and CI step outputs', () => {
    const content = fs.readFileSync(docsPath, 'utf8');

    expect(content).toContain('### 🛡️ Review Yeti Context Coverage Telemetry');
    expect(content).toContain('Coverage: 100%');
    expect(content).toContain('0 omitted');
    expect(content).toContain('files-reviewed=48');
    expect(content).toContain('files-omitted=0');
    expect(content).toContain('partitions-count=2');
    expect(content).toContain('coverage-pct=100');
  });

  it('9. verifies configuration parameters and CLI execution examples', () => {
    const content = fs.readFileSync(docsPath, 'utf8');

    expect(content).toContain('diffBudgetLimitChars');
    expect(content).toContain('fileBudgetLimitChars');
    expect(content).toContain('maxToolCallsPerTurn');
    expect(content).toContain('maxTurnsPerSession');
    expect(content).toContain('enableDiffCompaction');
    expect(content).toContain('evaluate-release-benchmark.mjs');
    expect(content).toContain('compare-release-baselines.mjs');
    expect(content).toContain('--test-partitioning');
    expect(content).toContain('--zero-omissions');
  });

  it('10. verifies Mermaid architectural pipeline flowchart is valid markdown', () => {
    const content = fs.readFileSync(docsPath, 'utf8');

    expect(content).toContain('```mermaid');
    expect(content).toContain('flowchart TD');
    expect(content).toContain('SafeMath');
    expect(content).toContain('PartitionEngine');
  });
});
