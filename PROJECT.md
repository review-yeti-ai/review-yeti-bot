# Project: Review Yeti — Swarm Context Isolation, Diff Compaction, Findings Decomposition & File-Coverage Quorum

## Architecture

Review Yeti (`review-yeti-bot`) next-generation review architecture eliminates monolithic diff broadcasting, cuts token consumption by 60–70%, bounds conversational context, and replaces all-tasks-must-report quorum with 100% file coverage and blocker fast-pathing.

```
┌────────────────────────────────────────────────────────────────────────┐
│                     Git Diff & Changed File Source                     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   AST File-Tree Outline Dispatcher                     │
│  - Parses AST symbols (classes, functions, methods, interfaces)        │
│  - Intersects symbol line ranges with diff changed line numbers        │
│  - Generates lean AST file-tree outline (<500 tokens vs 15k+ diff)     │
│  - Domain boundary mapper (security, persistence, API, runtime, UI)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│            Swarm Context Isolation & Ephemeral Diff Lifecycle          │
│  - Domain-bounded tasks receive ONLY path/symbol AST outlines          │
│  - Monolithic staticPrefixText diff broadcasting eliminated            │
│  - On-demand get_hunk(filePath, startLine, endLine) retrieval          │
│  - Inspected hunks evicted into [DIFF_EVICTION_RECEIPT] synopses       │
│  - Turn history remains bounded (<2k tokens) and token burn stays flat │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│             Findings Decomposition Contract (ReviewTaskContract v2)    │
│  - Initial sweep emits lean 5-tuple digests:                           │
│      (severity, file, line, fingerprint, summary)                      │
│  - Decoupled on-demand Remediation Subagent for code patches / fixes   │
│  - Downstream hydration preserves line anchoring for Check Runs        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│         File Coverage Validation & Blocker Fast-Path Quorum            │
│  - Replaces rigid "all-tasks-must-report" quorum                       │
│  - 100% file coverage by applicable domains satisfies quorum           │
│  - Verified P0 / Blocker findings trigger immediate early-exit abort   │
│  - Clean gate conclusion: status=failure, reason=blocking-findings     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Feature Inventory

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | AST Diff Parser & Outline Generator | `astOutlineGenerator.ts`: extracts changed lines and intersects with `ASTParser` symbols to generate lean AST file-tree outlines. | M1 | Survey 1 §1.2 & Spec Miner §3.1 |
| 2 | Domain Path Boundary Partitioning | `pathDomainContract.ts`: partitions touched files into domain lanes (`security_auth`, `data_persistence`, `api_contracts`, `system_runtime`, `ui_frontend`). | M1 | Survey 1 §1.3 & Spec Miner §3.2 |
| 3 | Swarm Context Isolation & Prefill Elimination | `composedEngine.ts` & `panelEngine.ts`: eliminates monolithic `staticPrefixText` prefill; dispatches domain-isolated AST outlines to tasks. | M1 | Survey 1 §1.1, Spec Miner §3.3 |
| 4 | On-Demand `get_hunk` Retrieval Tool | `toolRuntime.ts`: implements `get_hunk(filePath, startLine, endLine)` returning anchored diff hunks; registered in `COMPOSED_READ_ONLY_TOOL_CONTRACT`. | M2 | Survey 1 §1.4 & Spec Miner §3.4 |
| 5 | Ephemeral Diff Lifecycle & Synopsis Compaction | `messageWindow.ts`: classifies `get_hunk` as ephemeral, evicts raw hunks from older turns, and compacts into `[DIFF_EVICTION_RECEIPT]` synopses. | M2 | Survey 1 §1.5 & Spec Miner §3.5 |
| 6 | `ReviewTaskContract` v2 Lean Finding Digest | `reviewTaskContract.ts`: lean 5-tuple schema `(severity, file, line, fingerprint, summary)`; LLM schema `ct_review_task_result_v2`. | M3 | Survey 2 §1.1 & Spec Miner §3.6 |
| 7 | Decoupled Remediation Subagent | `remediationSubagent.ts`: on-demand subagent generating code replacements, suggestions, and fix options for verified findings. | M3 | Survey 2 §2.1 & Spec Miner §3.8 |
| 8 | Downstream Gate Publishing Hydration | `publishingReview.ts` & `reviewGatePublisher.ts`: hydrates `LeanFindingSummary` into `PanelFinding`, preserving line anchoring for GitHub Check Runs. | M3 | Survey 2 §2.3 & Spec Miner §3.6 |
| 9 | 100% File Coverage Quorum Validator | `reviewTaskContract.ts` & `reviewCore.js`: replaces all-tasks-must-report with 100% file coverage by completed domain tasks. | M4 | Survey 2 §2.2 & Spec Miner §3.9 |
| 10 | Blocker Fast-Path Quorum & Early-Exit | `composedEngine.ts`, `reviewGatePolicy.ts`, `publishingReview.ts`: immediate early exit on verified P0, setting `blockerFastPath: true` and `blocking-findings`. | M4 | Survey 2 §2.2 & Spec Miner §3.10 |
| 11 | Configuration Schema Extensions | `src/config/schema.ts`: extends Zod schemas with `context_isolation`, `diff_compaction`, `decomposed_findings`, `quorum_mode`. | M4 | Spec Miner §3.11 |
| 12 | Full Regression & Multi-Tier E2E Suite Pass | End-to-end integration and 4-tier test suite pass with zero regressions, zero mock facades, and zero unhandled rejections. | M5 | Spec Miner §5 & ORIGINAL_REQUEST |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Swarm Context Isolation & AST File-Tree Dispatcher | Implement AST outline generator (`astOutlineGenerator.ts`), domain path partitioning, and replace monolithic `staticPrefixText` diff broadcasting with domain-isolated AST outlines. | none | DONE |
| M2 | Ephemeral Diff Lifecycle & Sliding Context Compaction | Implement `get_hunk` tool in `toolRuntime.ts`, register in `COMPOSED_READ_ONLY_TOOL_CONTRACT`, and implement ephemeral diff eviction & synopsis compaction in `messageWindow.ts`. | none | DONE |
| M3 | Findings Decomposition Contract & Decoupled Remediation | Implement `ReviewTaskContract` v2 lean finding summary schema, decoupled remediation subagent, and downstream hydration preserving exact line anchoring across GitHub Check Runs. | none | DONE |
| M4 | File Coverage Validation & Blocker Fast-Path Quorum | Implement 100% file coverage quorum validator, blocker fast-path early exit on verified P0 findings with clean `blocking-findings` gate resolution, and configuration schema extensions in `src/config/schema.ts`. | M3 | DONE |
| M5 | Full Integration & E2E Validation | Full regression suite pass (`npm test`), 4-tier E2E tests, zero mock facades, adversarial coverage hardening, and final verification report. | M1, M2, M3, M4 | DONE |

---

## Interface Contracts

### 1. AST File-Tree Outline Contract (`src/panel/astOutlineContract.ts`)
```typescript
export interface ASTSymbolOutline {
  name: string;
  kind: 'function' | 'method' | 'class' | 'interface' | 'variable' | 'type';
  startLine: number;
  endLine: number;
  exported: boolean;
  signature?: string;
  containerName?: string;
}

export interface DiffHunkBoundary {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section?: string;
}

export interface ASTFileOutline {
  filePath: string;
  domainLane: DomainLane;
  additions: number;
  deletions: number;
  hunkBoundaries: DiffHunkBoundary[];
  modifiedSymbols: ASTSymbolOutline[];
}

export interface FileTreeOutline {
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  files: ASTFileOutline[];
  filesByDomain: Record<DomainLane, ASTFileOutline[]>;
  summaryText: string;
}
```

### 2. `get_hunk` Tool Contract (`src/panel/toolRuntime.ts`)
```typescript
export interface GetHunkArgs {
  filePath: string;
  startLine?: number;
  endLine?: number;
  contextLines?: number;
}

export interface HunkResult {
  filePath: string;
  startLine: number;
  endLine: number;
  patch: string;
  modifiedLines: number[];
  isExhaustive: boolean;
}
```

### 3. `ReviewTaskContract` v2 Lean Finding Schema (`src/reviewTaskContract.ts`)
```typescript
export interface LeanFindingSummary {
  severity: 'P0' | 'P1' | 'P2';
  file: string;
  line: number;
  fingerprint: string;
  summary: string; // concise <= 400 chars
}

export interface ReviewTaskResultV2 {
  nonce: string;
  task: string;
  status: 'COMPLETE' | 'BLOCKED';
  blockedReason?: string | null;
  findings: LeanFindingSummary[];
}
```

### 4. File Coverage & Blocker Fast-Path Contract (`src/reviewTaskContract.ts`, `src/review/reviewGatePolicy.ts`)
```typescript
export interface FileCoverageValidationResult {
  satisfied: boolean;
  coveragePct: number;
  coveredPaths: string[];
  uncoveredPaths: string[];
  securityCoverageSatisfied: boolean;
  missingSecurityPaths: string[];
}

export interface QuorumResult {
  required: number;
  distinctProviders: string[];
  satisfied: boolean;
  coverageMode: 'file_coverage' | 'all_tasks';
  fileCoverage?: FileCoverageValidationResult;
  blockerFastPath?: boolean;
}
```

---

## Code Layout

- `src/panel/astOutlineGenerator.ts`: AST diff parsing, symbol intersection, file-tree outline generation.
- `src/panel/astOutlineContract.ts`: Type definitions for AST outlines and file-tree summaries.
- `src/panel/composedEngine.ts`: Elimination of `staticPrefixText` diff broadcasting, task context isolation, blocker fast-path handling.
- `src/panel/panelEngine.ts`: Removal of monolithic diff inlining in `buildScopedDiffSection`.
- `src/panel/toolRuntime.ts`: Implementation of `get_hunk(filePath, startLine, endLine)` tool.
- `src/panel/messageWindow.ts`: Ephemeral diff eviction and synopsis compaction.
- `src/reviewTaskContract.ts`: `ReviewTaskContract` v2 schema, `isFileCoverageSatisfied` validator.
- `src/review/remediationSubagent.ts`: Decoupled on-demand remediation generation.
- `src/review/publishingReview.ts` & `src/review/reviewGatePublisher.ts`: Hydration of lean findings into check run annotations.
- `src/review/reviewGatePolicy.ts`: Blocker fast-path early exit support (`blocking-findings`).
- `src/config/schema.ts`: Configuration extensions for swarm context isolation and diff compaction.
- `tests/unit/`: Unit tests for AST outlines, `get_hunk`, compaction, v2 contracts, and file coverage quorum.
- `tests/e2e/`: Multi-tier E2E tests validating token reduction, context isolation, and blocker fast-pathing.
