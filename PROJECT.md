# Project: Review Yeti Benchmark Suite Expansion

## Architecture
Review Yeti is an automated PR code review and benchmark evaluation engine. This project expands the benchmark evaluation suite by 2x (from 94 to 190 total scenarios) using realistic telecom SWE-bench style multi-file codebases and upgrading the multi-turn workspace runner.

The system is organized into the following major modules and tracks:
1. **Generic Telecom Call Engine Workspace (`tests/fixtures/workspaces/telecom-call-engine/`)**:
   - `sip_signaling_service`: RFC 3261 SIP state machine, dialog tracker, RFC 4566 SDP offer/answer negotiation, blind/attended transfer coordinator.
   - `rtp_media_gateway`: RFC 3550 RTP/RTCP packet handling, adaptive jitter buffer, G.711/Opus codecs, dynamic UDP port pool manager.
   - `cdr_pipeline`: CDR record normalization, E.164 Radix Trie tariff rate engine, tenant quota tracker, async batch SQL logger.
   - `pbx_device_manager`: SIP user-agent registration, RFC 2617 MD5 Digest Auth, trunk lease allocator, CTI webhook event emitter.
   - Zero proprietary IP: 100% RFC-standard generic telephony abstractions.
2. **Scenario Catalog & Diff Fixtures (`src/evaluation/scenarios.ts` & `tests/fixtures/scenarios/`)**:
   - Expanded from 94 to 190 scenarios (96 new scenarios #2101–#2196).
   - 4 challenge archetypes: Needle-in-a-Haystack (300–1,500 lines), Cross-Module Contract Breaks, Distributed Concurrency Races, False Positive Traps.
   - 1-to-1 matching `.diff` unified patch fixtures under `tests/fixtures/scenarios/`.
3. **Workspace-Aware Multi-Turn Runner (`src/evaluation/evaluationRunner.ts`)**:
   - Multi-turn repository tool interaction loop (`file_read`, `code_search`, `symbol_lookup`).
   - Dual execution modes: Live OpenRouter streaming with token/latency/cost tracking, and deterministic offline replay simulation.
4. **Release Baseline v4 & Quality Gate (`eval-baselines/` & `scripts/compare-release-baselines.mjs`)**:
   - Canonical `model-benchmark-matrix-v4.json` and `.md` across all 190 scenarios for approved 4 models.
   - Automated quality gate comparisons enforcing zero recall/accuracy regression and 0 new false negatives.
5. **E2E Testing Track (`TEST_INFRA.md` & `tests/e2e/`)**:
   - Dual track independent test harness covering Tiers 1–4 requirement tests and Tier 5 adversarial coverage hardening.

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Telecom Workspace - SIP Signaling Service | Implement RFC 3261 state machine, dialog manager, SDP negotiator, and call transfer coordinator | M1 | R1 / ORIGINAL_REQUEST |
| 2 | Telecom Workspace - RTP Media Gateway | Implement RTP packet jitter buffers, audio transcoding (G.711/Opus), and UDP port allocation pool | M1 | R1 / ORIGINAL_REQUEST |
| 3 | Telecom Workspace - CDR Pipeline | Implement CDR ingestion, E.164 tariff rating, multi-tenant quota enforcement, and batch SQL logger | M1 | R1 / ORIGINAL_REQUEST |
| 4 | Telecom Workspace - PBX Device Manager | Implement SIP registration, RFC 2617 Digest Auth, trunk lease allocator, and CTI webhook emitter | M1 | R1 / ORIGINAL_REQUEST |
| 5 | Telecom Workspace - IP Protection Audit | Verify zero proprietary IP, real company names, or internal schemas across all workspace files | M1 | R1 / ORIGINAL_REQUEST |
| 6 | Needle-in-a-Haystack Scenarios (24 PRs) | 300–1,500 line large refactors with 1 subtle critical bug (PR #2101–#2124) | M2 | R2 / ORIGINAL_REQUEST |
| 7 | Cross-Module Architectural Breakages (24 PRs) | PR diffs that break un-modified downstream subscribers/DB schemas (PR #2125–#2148) | M2 | R2 / ORIGINAL_REQUEST |
| 8 | High-Concurrency Race Condition Scenarios (24 PRs) | Distributed race conditions, early BYE transfer races, trunk split-brain leases (PR #2149–#2172) | M2 | R2 / ORIGINAL_REQUEST |
| 9 | False Positive & Hallucination Traps (24 PRs) | Complex idiomatic clean PRs testing model hallucination resistance (PR #2173–#2196) | M2 | R2 / ORIGINAL_REQUEST |
| 10 | Unified Diff Fixtures Authoring | Generate 96 corresponding `.diff` files in `tests/fixtures/scenarios/` matching scenario diffs | M2 | R2 / ORIGINAL_REQUEST |
| 11 | Workspace Tool Support in Evaluation Runner | Implement `file_read`, `code_search`, `symbol_lookup` against mounted workspace | M3 | R3 / ORIGINAL_REQUEST |
| 12 | Multi-Turn Runner Execution Loop | Support multi-turn model tool conversations in live mode and deterministic offline replay mode | M3 | R3 / ORIGINAL_REQUEST |
| 13 | OpenRouter Live Pricing & Latency Tracking | Maintain model pricing and latency telemetry for approved 4-model lineup | M3 | R3 / ORIGINAL_REQUEST |
| 14 | Baseline Matrix v4 Generation | Generate canonical `eval-baselines/model-benchmark-matrix-v4.json` and `.md` across 190 scenarios | M4 | R4 / ORIGINAL_REQUEST |
| 15 | Release Quality Gate Verification | Validate 0 regression breaches via `scripts/compare-release-baselines.mjs` against v3 and v1 | M4 | R4 / ORIGINAL_REQUEST |
| 16 | E2E Testing Infrastructure (Tiers 1–4) | Implement opaque-box test suite for feature coverage, boundary cases, pairwise, and application scenarios | M5 | Dual Track / ORIGINAL_REQUEST |
| 17 | Adversarial Coverage Hardening (Tier 5) | White-box adversarial testing, edge-case validation, and 100% test pass rate verification | M5 | Dual Track / ORIGINAL_REQUEST |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Generic Telecom Workspace Architecture (R1) | Build `tests/fixtures/workspaces/telecom-call-engine/` with SIP, RTP, CDR, PBX services | none | DONE |
| M2 | 96 New Evaluation Scenarios & Diff Fixtures (R2) | Author 96 new scenarios (#2101–#2196) in `src/evaluation/scenarios.ts` and `tests/fixtures/scenarios/` | M1 | DONE |
| M3 | Workspace-Aware Multi-Turn Runner (R3) | Upgrade `src/evaluation/evaluationRunner.ts` with workspace tool mounting & multi-turn loop | M1 | DONE |
| M4 | Baseline v4 Release & Quality Gate (R4) | Generate `eval-baselines/model-benchmark-matrix-v4.json/.md` and run quality gate | M2, M3 | DONE |
| M5 | E2E Testing Track & Adversarial Hardening (Dual Track) | Comprehensive E2E test suite (Tiers 1–4) and adversarial coverage hardening (Tier 5) | M1, M2, M3, M4 | DONE |

---

## Interface Contracts

### 1. Evaluation Scenario Registry (`src/evaluation/scenarios.ts`)
```typescript
export interface EvaluationScenario {
  id: string;                      // e.g. "2101"
  title: string;                   // Scenario title
  category: ScenarioCategory;      // 'architecture' | 'concurrency' | 'refactor' | 'security' | etc.
  difficulty: 'easy' | 'medium' | 'hard' | 'extreme';
  expectedVerdict: ArbitrationVerdict; // 'BLOCK' | 'FIX_FIRST' | 'SHIP'
  expectedFindings: ExpectedFinding[];
  diffFiles: DiffFile[];
  prContext: PRContext;
  sessionContext?: SessionContext;
  evidenceRequirements?: EvidenceRequirement[];
  workspaceRoot?: string;          // Optional workspace path relative to project root
  requiredToolQueries?: { tool: string; query: string; expectedSubstring?: string }[];
}
```

### 2. Workspace Tool Protocol (`src/evaluation/evaluationRunner.ts`)
```typescript
export interface WorkspaceToolExecutor {
  fileRead(relPath: string): Promise<string>;
  codeSearch(pattern: string, fileGlob?: string): Promise<Array<{ path: string; line: number; match: string }>>;
  symbolLookup(symbolName: string): Promise<Array<{ path: string; line: number; kind: string }>>;
}
```

### 3. Model Baseline Schema (`eval-baselines/model-benchmark-matrix-v4.json`)
```typescript
export interface ModelBenchmarkMatrixV4 {
  version: "v4";
  generatedAt: string;
  totalScenarios: number;          // >= 188 (190 total)
  models: {
    [modelId: string]: {
      summary: ModelSummaryMetrics;
      scenarios: Record<string, ScenarioEvaluationResult>;
    }
  }
}
```

---

## Code Layout
- `src/evaluation/scenarios.ts`: All 190 scenario definitions
- `src/evaluation/evaluationRunner.ts`: Evaluation engine, metrics calculation, workspace tool executor, multi-turn loop
- `tests/fixtures/scenarios/*.diff`: Unified diff fixture files for all 190 scenarios
- `tests/fixtures/workspaces/telecom-call-engine/`:
  - `sip_signaling_service/`: SIP state machine, dialogs, SDP negotiation, call transfer
  - `rtp_media_gateway/`: RTP/RTCP handlers, jitter buffers, audio codecs, port allocator
  - `cdr_pipeline/`: Ingestion, rating engine, tenant quota, SQL batch logger
  - `pbx_device_manager/`: Registration, digest auth, trunk leases, CTI webhook dispatcher
- `eval-baselines/`:
  - `model-benchmark-matrix-v3.json` & `.md`: 94-scenario baseline
  - `model-benchmark-matrix-v4.json` & `.md`: 190-scenario canonical baseline
- `scripts/`:
  - `evaluate-release-benchmark.mjs`: Benchmark execution script
  - `compare-release-baselines.mjs`: Regression quality gate script
- `tests/e2e/`:
  - `releaseBenchmark.test.ts`: E2E benchmark test suite
  - `telecomWorkspace.test.ts`: Workspace integrity test suite
