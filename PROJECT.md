# Project: Review Yeti — Miller Tool Retirement & Pre-Check System

## Architecture
Review Yeti is an agentic code review platform. This project retires the legacy AST diff context filtering tool (`miller`) and replaces its responsibilities with:
1. Deterministic **Zoekt-Driven Symbol & Context Pre-Check** for PR diff hunks, discovering external callers and definitions across the repository before persona evaluation.
2. Deterministic **Sandbox Static Analyzers** (CodeRabbit pattern) executing linters/scanners in an isolated sandbox, formatting hits into structured **Candidate Hypotheses** for persona verification or refutation.
3. Centralized **Configuration Schema & Default-On Wiring** in `.ct-review.yaml` (`pre_checks`), defaulting to enabled when omitted and failing soft if tools or indices are absent.

```
                      ┌─────────────────────────────────┐
                      │        .ct-review.yaml          │
                      │  pre_checks: (default-on: true) │
                      └────────────────┬────────────────┘
                                       │
                                       ▼
                      ┌─────────────────────────────────┐
                      │       ConfigResolver /          │
                      │     schema.ts (pre_checks)      │
                      └────────────────┬────────────────┘
                                       │
                ┌──────────────────────┴──────────────────────┐
                ▼                                             ▼
  ┌───────────────────────────┐                 ┌───────────────────────────┐
  │  Zoekt Pre-Check (M3)     │                 │  Sandbox Analyzers (M4)   │
  │  - Symbol discovery       │                 │  - eslint, semgrep        │
  │  - Callers & definitions  │                 │  - credo, sobelow         │
  │  - Diff hunk context      │                 │  - govet, gitleaks        │
  │  - Fail-soft handling     │                 │  - Fail-soft handling     │
  └─────────────┬─────────────┘                 └─────────────┬─────────────┘
                │                                             │
                │  Discovered Symbol Context                  │  Candidate Hypotheses
                │  (definitions, call sites)                  │  (path, line, rule, msg)
                └──────────────────────┬──────────────────────┘
                                       │
                                       ▼
                      ┌─────────────────────────────────┐
                      │     src/panel/panelEngine.ts    │
                      │  - Injects pre-checks into      │
                      │    reviewer persona context     │
                      └────────────────┬────────────────┘
                                       │
                                       ▼
                      ┌─────────────────────────────────┐
                      │    Agentic Reviewer Personas    │
                      │  - Verify / refute hypotheses   │
                      │  - Contextualize review diff    │
                      └─────────────────────────────────┘
```

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Delete Miller Files | Completely delete `src/services/millerTool.ts` and `tests/unit/millerTool.test.ts` | M1 | ORIGINAL_REQUEST R1 |
| 2 | Strip Miller from Panel Engine | Remove imports, tool declarations, prompt references, whitelist checks, and execution blocks in `src/panel/panelEngine.ts` | M1 | ORIGINAL_REQUEST R1 |
| 3 | Remove Miller from Challenger Test | Remove Miller unit tests from `tests/unit/r2EmpiricalChallenger.test.ts` and add strict disallowed-tool test | M1 | ORIGINAL_REQUEST R1 |
| 4 | Clean Evaluation Baselines | Remove `miller` from description strings in `scripts/evaluate-ablations.mjs` and `eval-baselines/ablation-study-v1.json` | M1 | ORIGINAL_REQUEST R1 |
| 5 | Extend Zod Config Schema | Add `preChecksSchema`, `zoektPreCheckSchema`, and `analyzersPreCheckSchema` to `src/config/schema.ts` | M2 | ORIGINAL_REQUEST R4 |
| 6 | Default-On Config Loader | Update `createDefaultV3Config()` in `src/config/configLoader.ts` to enable pre-checks by default | M2 | ORIGINAL_REQUEST R4 |
| 7 | 3-Tier Config Merger | Update `deepMergeConfigs()` in `src/config/configResolver.ts` for deep merging of `pre_checks` | M2 | ORIGINAL_REQUEST R4 |
| 8 | Diff Symbol Extraction | Extract candidate symbols from modified lines in diff hunks using `ASTParser` and language patterns | M3 | ORIGINAL_REQUEST R2 |
| 9 | Zoekt Query Execution | Query Zoekt index for external definitions and call sites, capped at `max_symbols` | M3 | ORIGINAL_REQUEST R2 |
| 10 | Zoekt Fail-Soft Handling | Soft fail when Zoekt is disabled, unindexed, or binary is missing, recording receipt status | M3 | ORIGINAL_REQUEST R2 |
| 11 | Persona Symbol Evidence Injection | Format discovered symbols into structured pre-check evidence in `panelEngine.ts` | M3 | ORIGINAL_REQUEST R2 |
| 12 | Sandbox Analyzer Runner | Execute `eslint`, `semgrep`, `credo`, `sobelow`, `govet`, `gitleaks` in isolated sandbox | M4 | ORIGINAL_REQUEST R3 |
| 13 | Candidate Hypotheses Modeling | Transform raw analyzer outputs into structured `CandidateHypothesis[]` | M4 | ORIGINAL_REQUEST R3 |
| 14 | Analyzer Fail-Soft Handling | Gracefully handle missing binaries (`ENOENT`), timeouts, and non-fatal lint exit codes | M4 | ORIGINAL_REQUEST R3 |
| 15 | Persona Hypotheses Injection | Inject candidate hypotheses into reviewer persona prompt context for verification/refutation | M4 | ORIGINAL_REQUEST R3 |
| 16 | E2E Test Suite Validation | 100% pass of requirement-derived E2E test suite across Tiers 1-4 and Tier 5 coverage hardening | M5 | ORIGINAL_REQUEST Acceptance |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Miller Tool Complete Retirement | Delete miller files, remove all references in panelEngine, update r2EmpiricalChallenger test, clean baseline scripts | none | DONE |
| M2 | Configuration Schema & Default-On Wiring | Extend schema.ts with pre_checks, wire configLoader defaults, wire configResolver deep merge, verify with unit tests | none | DONE |
| M3 | Zoekt-Driven Symbol & Context Pre-Check | Implement zoektPreCheckService, diff symbol extraction, call site/definition search, fail-soft receipts, panelEngine injection | M1, M2 | DONE |
| M4 | Deterministic Sandbox Static Analyzers | Implement analyzerRunner, multi-ecosystem scanner execution, candidate hypotheses parser, fail-soft handling, panelEngine injection | M1, M2 | DONE |
| M5 | Final Integration & E2E Validation | Pass 100% of E2E test suite (Tiers 1-4) and adversarial coverage hardening (Tier 5) | M1, M2, M3, M4 | DONE |

## Interface Contracts

### Configuration Schema Contract (`src/config/schema.ts`)
```typescript
export interface PreChecksZoektConfig {
  enabled: boolean;        // default: true
  max_symbols: number;     // default: 25
  timeoutMs?: number;      // default: 5000
  indexDir?: string;
}

export interface PreChecksAnalyzersConfig {
  enabled: boolean;        // default: true
  linters: boolean;        // default: true
  security: boolean;       // default: true
  secrets: boolean;        // default: true
}

export interface PreChecksConfig {
  enabled: boolean;        // default: true
  zoekt: PreChecksZoektConfig;
  analyzers: PreChecksAnalyzersConfig;
}
```

### Zoekt Pre-Check Contract (`src/services/zoektPreCheckService.ts`)
```typescript
export interface ZoektSymbolMatch {
  path: string;
  line: number;
  text: string;
}

export interface DiscoveredSymbolContext {
  symbol: string;
  kind?: string;
  sourcePath: string;
  isModifiedDefinition: boolean;
  definitions: ZoektSymbolMatch[];
  callSites: ZoektSymbolMatch[];
}

export interface ZoektPreCheckResult {
  status: 'ok' | 'unavailable' | 'disabled' | 'skipped';
  reason?: string;
  scannedSymbolsCount: number;
  matchedSymbolsCount: number;
  symbols: DiscoveredSymbolContext[];
  receipt: {
    indexDir?: string;
    totalQueries: number;
    durationMs: number;
    truncated?: boolean;
  };
}
```

### Sandbox Analyzers Contract (`src/sandbox/analyzerRunner.ts`)
```typescript
export type AnalyzerCategory = 'linter' | 'security' | 'secrets';
export type AnalyzerSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface CandidateHypothesis {
  id: string; // e.g. "hyp:eslint:no-unused-vars:src/app.ts:15"
  analyzer: 'eslint' | 'semgrep' | 'credo' | 'sobelow' | 'govet' | 'gitleaks' | string;
  category: AnalyzerCategory;
  ruleId: string;
  path: string;
  line: number;
  endLine?: number;
  column?: number;
  message: string;
  severity: AnalyzerSeverity;
  confidence: 'low' | 'medium' | 'high';
  snippet?: string;
  rawDetails?: string;
}

export interface PreCheckAnalyzerReceipt {
  tool: string;
  category: AnalyzerCategory;
  available: boolean;
  exitStatus: number | 'timeout' | 'error' | 'not_installed';
  durationMs: number;
  hypotheses: CandidateHypothesis[];
  error?: string;
}

export interface PreCheckSummary {
  enabled: boolean;
  analyzersExecuted: number;
  hypothesesCount: number;
  receipts: PreCheckAnalyzerReceipt[];
  hypotheses: CandidateHypothesis[];
}
```

## Code Layout
- `src/services/millerTool.ts` -> DELETED
- `tests/unit/millerTool.test.ts` -> DELETED
- `src/config/schema.ts` -> Pre-checks Zod schema definitions
- `src/config/configLoader.ts` -> Default pre-checks config generator
- `src/config/configResolver.ts` -> Deep merge for pre-checks
- `src/services/zoektPreCheckService.ts` -> Zoekt symbol discovery & diff hunk inspection
- `src/sandbox/analyzerRunner.ts` -> Sandboxed analyzer execution & candidate hypotheses formatter
- `src/panel/panelEngine.ts` -> Miller removal + Pre-check evidence and hypotheses injection
- `tests/unit/preChecksConfig.test.ts` -> Pre-checks config schema unit tests
- `tests/unit/zoektPreCheckService.test.ts` -> Zoekt pre-check unit tests
- `tests/unit/analyzerRunner.test.ts` -> Analyzer runner unit tests
- `tests/unit/r2EmpiricalChallenger.test.ts` -> Negative test for Miller rejection
