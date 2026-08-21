# Project: Review Yeti Dynamic Context Management & Compaction Architecture

## Architecture

The system refactors Review Yeti's context handling architecture to eliminate arbitrary diff truncation and support massive PRs across models ranging from 128k to 1M+ tokens:

1. **Dynamic Model Context Window Discovery & Budget Calculation (`src/gateway/openRouterClient.ts`, `src/config/schema.ts`)**:
   - Resolves model context window limits dynamically via OpenRouter API metadata (`GET /models`) with 1-hour TTL caching, single-flight async deduplication, and deterministic static fallback tables.
   - Computes safe diff character capacity dynamically:
     $$C_{\text{safe}} = (\text{ContextTokens} - \text{SystemPromptTokens} - \text{ToolReserveTokens}) \times 3.8$$
     Yielding ~410,400 chars (~10,260 lines) for 128k models and ~3,908,588 chars (~97,700 lines) for 1M models, replacing static 24,000 char limits.
   - Raises config schema ceilings (`max_prompt_tokens` up to 4,000,000; `max_diff_bytes` up to 10,000,000).

2. **Diff & Multi-Turn History Compaction Engine (`src/pipeline/diffCompactor.ts`, `src/pipeline/turnHistoryManager.ts`)**:
   - **Diff Compactor**: Collapses unchanged context lines to tight $\pm 3$ line bounds, splits distant change clusters (>6 context lines) into distinct hunks, recalculates `oldStart, oldCount, newStart, newCount` preserving exact line number invariance (`changedLineNumbers`), strips minified bundles/lockfiles, and normalizes whitespace.
   - **Turn History Manager**: Manages multi-turn persona tool loops with a 2-turn active full-fidelity window while compacting older turns ($1 \dots k-2$) into structured tool receipts and rolling findings memory, bounding historical context to <2k tokens per persona.

3. **Commit SHA Range & Zero-Loss Batch Partitioning (`src/pipeline/shaPartitionManager.ts`)**:
   - Injects explicit commit SHA ranges (`base_sha...head_sha`) and complete file manifest tables into reviewer prompts.
   - Implements deterministic zero-loss file partitioning: splits PRs exceeding $C_{\text{safe}}$ into parallel batches across review lanes, ensuring 100% of files are audited with 0 files dropped.
   - Emits transparent coverage telemetry in PR review comments (`"Coverage: 100% (X/X files reviewed across Y partitions, 0 omitted)"`) and step outputs (`files-reviewed`, `files-omitted=0`, `partitions-count`, `coverage-pct=100`).

4. **Evaluation Harness Augmentation & Documentation (`src/evaluation/pipelineHarnessRunner.ts`, `docs/features/context_management.md`)**:
   - Augments `pipelineHarnessRunner.ts`, `scripts/evaluate-release-benchmark.mjs`, and `scripts/compare-release-baselines.mjs` to benchmark compaction, SHA partitioning, and multi-turn scaling, enforcing zero-omission quality gates.
   - Authors comprehensive architectural and operational documentation in `docs/features/context_management.md`.

```
                    ┌─────────────────────────────────────────────────────────┐
                    │               PR Ingestion & Commit SHA Range           │
                    │         (base_sha...head_sha + Full File Manifest)      │
                    └──────────────────────────┬──────────────────────────────┘
                                               │
                                               ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │       Dynamic Model Discovery & Safe Capacity (C_safe)  │
                    │   - OpenRouter API / Static Fallback (128k - 1M+ tokens)│
                    │   - C_safe = (T_ctx - T_sys - T_reserve) * 3.8          │
                    └──────────────────────────┬──────────────────────────────┘
                                               │
                                               ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │            Intelligent Diff Compaction Engine           │
                    │   - +/- 3 Context Line Collapsing & Hunk Recalculation  │
                    │   - Minified / Bundle Stripping & Whitespace Compaction │
                    └──────────────────────────┬──────────────────────────────┘
                                               │
                                               ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │      Zero-Loss File Partitioning (if Diff > C_safe)     │
                    │   - Bin-packing into K parallel review partition lanes  │
                    │   - 100% file coverage guarantee (0 dropped files)      │
                    └──────────────────────────┬──────────────────────────────┘
                                               │
                                               ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │        Multi-Turn Tool Loop & Sliding Turn Compactor    │
                    │   - 2-turn full fidelity active window                  │
                    │   - Sliding tool receipts & findings memory ledger      │
                    └──────────────────────────┬──────────────────────────────┘
                                               │
                                               ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │         Finding Aggregation, Verification & Telemetry   │
                    │   - Cross-partition finding deduplication & verifier    │
                    │   - Telemetry: "Coverage: 100% (X/X files, 0 omitted)"  │
                    └─────────────────────────────────────────────────────────┘
```

---

## Feature Inventory

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Dynamic Model Context Window Discovery | Query OpenRouter metadata API with caching and fallback tables for 128k–1M+ models | M1 | ORIGINAL_REQUEST §R1 |
| 2 | Dynamic Safe Diff Capacity Calculator | Compute $C_{\text{safe}} = (ContextTokens - 4000 - 16000) \times 3.8$ per target model | M1 | ORIGINAL_REQUEST §R1 |
| 3 | Config Schema Boundary Expansion | Raise schema bounds for `max_prompt_tokens` (4M) and `max_diff_bytes` (10MB) | M1 | ORIGINAL_REQUEST §R1 |
| 4 | Static Truncation Cap Removal | Eliminate static 24,000 char limits across pipeline, sandbox, and harness | M1 | ORIGINAL_REQUEST §R1 |
| 5 | Unified Diff Context Compactor | Collapse context lines to $\pm 3$ lines, cluster split $>6$ lines, recalculate hunk headers | M2 | ORIGINAL_REQUEST §R2 |
| 6 | Line Number Invariance Guarantee | Ensure `changedLineNumbers` produces identical line numbers before and after compaction | M2 | ORIGINAL_REQUEST §R2 |
| 7 | Minified Artifact & Whitespace Compactor | Strip lockfiles, bundle maps, lines >500 chars, and redundant whitespace | M2 | ORIGINAL_REQUEST §R2 |
| 8 | Sliding Multi-Turn History Compactor | 2-turn active window, older turns compacted into structured tool receipts and findings ledger | M2 | ORIGINAL_REQUEST §R2 |
| 9 | Commit SHA Range Header Injection | Inject explicit `base_sha...head_sha` range and full file manifest table into prompts | M3 | ORIGINAL_REQUEST §R3 |
| 10 | Zero-Loss File Partitioning Engine | Deterministic bin-packing partitioning for PRs exceeding $C_{\text{safe}}$ with 0 dropped files | M3 | ORIGINAL_REQUEST §R3 |
| 11 | Parallel Partition Execution & Aggregation | Execute review lanes across partitions, aggregate and deduplicate findings globally | M3 | ORIGINAL_REQUEST §R3 |
| 12 | PR Comment Coverage Telemetry | Output `"Coverage: 100% (X/X files reviewed across Y partitions, 0 omitted)"` and step outputs | M3 | ORIGINAL_REQUEST §R3 |
| 13 | Evaluation Harness Multi-Partition Support | Augment `pipelineHarnessRunner.ts` to test compaction, partitioning, and scaling | M4 | ORIGINAL_REQUEST §R4 |
| 14 | Baseline Quality Gate Coverage Enforcement | Enforce 0-dropped-files and coverage checks in `compare-release-baselines.mjs` | M4 | ORIGINAL_REQUEST §R4 |
| 15 | Context Management Feature Documentation | Create comprehensive `docs/features/context_management.md` architecture guide | M4 | ORIGINAL_REQUEST §R4 |
| 16 | E2E Dual-Track Verification & Adversarial Audit | 100% test pass rate across all suites + Tier 5 adversarial audit + forensic clean audit | M5 | Acceptance Criteria |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Dynamic Model Context Window Discovery & Budget Calculation | `src/gateway/openRouterClient.ts`, `src/config/schema.ts`, `tests/unit/openRouterClient.test.ts`, `tests/unit/config.test.ts` | none | DONE |
| M2 | Diff & Multi-Turn History Compaction Engine | `src/pipeline/diffCompactor.ts`, `src/pipeline/turnHistoryManager.ts`, `src/sandbox/piWorkspacePlugin.ts`, `tests/unit/diffCompactor.test.ts`, `tests/unit/turnHistoryManager.test.ts` | M1 | DONE |
| M3 | Commit SHA Range & Zero-Loss Batch Partitioning | `src/pipeline/shaPartitionManager.ts`, `.github/workflows/pipelines/review-pipeline.js`, `tests/unit/shaPartitionManager.test.ts` | M1, M2 | DONE |
| M4 | Evaluation Harness Augmentation & Documentation | `src/evaluation/pipelineHarnessRunner.ts`, `scripts/compare-release-baselines.mjs`, `scripts/evaluate-release-benchmark.mjs`, `docs/features/context_management.md` | M2, M3 | DONE |
| M5 | E2E Dual-Track Testing & Final Milestone Verification | Full test suite execution, Tier 5 adversarial stress testing, Forensic Integrity Audit | M1, M2, M3, M4 | DONE |

---

## Interface Contracts

### Dynamic Model Metadata (`src/gateway/openRouterClient.ts`)
```typescript
export interface ModelMetadata {
  id: string;
  name: string;
  contextLength: number;
  maxCompletionTokens?: number;
  promptCostPer1M: number;
  completionCostPer1M: number;
  supportsTools: boolean;
  supportsReasoning?: boolean;
}

export function resolveModelMetadata(modelId: string, apiKey?: string): Promise<ModelMetadata>;
export function getStaticModelMetadata(modelId: string): ModelMetadata;
export function calculateSafeDiffCapacity(
  modelId: string,
  options?: { systemPromptTokens?: number; toolReserveTokens?: number; charsPerToken?: number }
): {
  contextTokens: number;
  usableDiffTokens: number;
  safeDiffChars: number;
  systemPromptTokens: number;
  toolReserveTokens: number;
};
```

### Diff Compaction Engine (`src/pipeline/diffCompactor.ts`)
```typescript
export interface DiffCompactionOptions {
  contextLines?: number;         // default: 3
  maxLineLength?: number;        // default: 500
  stripMinified?: boolean;       // default: true
  splitClusterGaps?: boolean;    // default: true
  maxClusterGap?: number;        // default: 6
}

export interface CompactedDiffResult {
  compactedPatch: string;
  originalChars: number;
  compactedChars: number;
  savingsRatio: number;
  hunkCount: number;
  strippedArtifacts: string[];
}

export function compactUnifiedDiff(rawPatch: string, options?: DiffCompactionOptions): CompactedDiffResult;
export function compactFileListDiffs(
  files: Array<{ path: string; patch?: string; content?: string }>,
  options?: DiffCompactionOptions
): {
  files: Array<{ path: string; patch: string; originalChars: number; compactedChars: number }>;
  totalOriginalChars: number;
  totalCompactedChars: number;
  totalSavingsRatio: number;
};
```

### Multi-Turn History Manager (`src/pipeline/turnHistoryManager.ts`)
```typescript
export interface TurnMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolReceipts?: Array<{ callId: string; tool: string; status: string; output: string }>;
}

export interface TurnHistoryManagerOptions {
  activeTurnWindow?: number;      // default: 2
  maxTurnHistoryTokens?: number;  // default: 8000
}

export class TurnHistoryManager {
  constructor(options?: TurnHistoryManagerOptions);
  addTurn(role: 'user' | 'assistant', content: string, toolReceipts?: Array<{ callId: string; tool: string; status: string; output: string }>): void;
  getFormattedMessages(): TurnMessage[];
  getEstimatedTokens(): number;
  getReceiptLedger(): Array<{ turn: number; tool: string; summary: string }>;
  getFindingsLedger(): Array<{ id: string; summary: string; severity: string }>;
}
```

### Commit SHA Range & Partition Manager (`src/pipeline/shaPartitionManager.ts`)
```typescript
export interface DiffPartition {
  partitionIndex: number;
  totalPartitions: number;
  files: Array<{ path: string; patch: string; originalChars: number; compactedChars: number }>;
  totalChars: number;
  baseSha: string;
  headSha: string;
}

export interface PartitionPlan {
  baseSha: string;
  headSha: string;
  totalFiles: number;
  totalOriginalChars: number;
  totalCompactedChars: number;
  partitions: DiffPartition[];
  coveragePercent: 100;
  omittedFilesCount: 0;
  fileManifest: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; partitionIndex: number }>;
}

export function createPartitionPlan(
  files: Array<{ path: string; patch?: string; status?: string }>,
  baseSha: string,
  headSha: string,
  safeDiffChars: number
): PartitionPlan;

export function formatCoverageComment(plan: PartitionPlan): string;
export function formatPromptManifestHeader(partition: DiffPartition, plan: PartitionPlan): string;
```

---

## Code Layout

- `src/gateway/` — `openRouterClient.ts`, model metadata resolution, dynamic safe diff capacity.
- `src/config/` — `schema.ts`, review limits schema with expanded token and byte ceilings.
- `src/pipeline/` — `diffCompactor.ts`, `turnHistoryManager.ts`, `shaPartitionManager.ts`.
- `src/sandbox/` — `piWorkspacePlugin.ts` updated with dynamic capacity, compaction, and zero-loss handling.
- `src/evaluation/` — `pipelineHarnessRunner.ts`, `reviewCassetteEngine.ts`, `evaluationRunner.ts`.
- `.github/workflows/pipelines/` — `review-pipeline.js` action script.
- `docs/features/` — `context_management.md` comprehensive architecture & configuration guide.
- `scripts/` — `evaluate-release-benchmark.mjs`, `compare-release-baselines.mjs`.
- `tests/unit/` — Unit test suites for all new components and updated gateways.
- `tests/e2e/` — End-to-end integration and benchmark verification suites.
