# Technical Analysis & Architecture Specification: Consensus Aggregator & Incremental Diff Delta Filtering (Milestone 3)

**Author**: Explorer 2 (Milestone 3 Quorum Review Panel Engine)  
**Date**: 2026-07-24  
**Target Repository**: `ct-review-bot`  
**Output Target File**: `src/quorum/consensus.ts`  
**Working Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m3_2`

---

## 1. Executive Summary

Milestone 3 delivers the **Quorum Review Panel Engine** for `ct-review-bot`. This report provides a complete, production-grade technical specification for:
1. **`src/quorum/consensus.ts` (Consensus Aggregator)**: Aggregates findings from parallel persona agents (`security`, `architecture`, `performance`, `quality`), executes cross-persona deduplication, computes final PR decision (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`), formats GitHub inline review comments with code suggestion blocks, and generates a formatted Markdown PR review summary.
2. **Incremental Diff Delta Filtering Integration (`diffStateManager`)**: Integrates persistent incremental diff tracking across commit SHAs to skip previously resolved nits & findings, re-open critical issues if re-flagged, and maintain line-shift resilient SHA-256 fingerprint hashes via `src/utils/diffHash.ts`.

---

## 2. System Architecture & Data Flow

```
                      ┌─────────────────────────────────────────┐
                      │   Input: PR Payload, Diff, Config       │
                      └────────────────────┬────────────────────┘
                                           │
                                           ▼
                      ┌─────────────────────────────────────────┐
                      │    Ticket & Constitution Checks         │
                      │  (ticketValidator & constitutionEngine) │
                      └────────────────────┬────────────────────┘
                                           │
                                           ▼
                      ┌─────────────────────────────────────────┐
                      │      Parallel Persona Review Fan-Out    │
                      │         (mefEngine.ts -> LLMs)          │
                      └────────────────────┬────────────────────┘
                                           │
                                           ▼
                      ┌─────────────────────────────────────────┐
                      │      Raw Persona Findings Collection    │
                      │(security, architecture, perf, quality)  │
                      └────────────────────┬────────────────────┘
                                           │
                                           ▼
                      ┌─────────────────────────────────────────┐
                      │     Cross-Persona Deduplication Engine  │
                      │   (deduplicateAcrossPersonas in consensus)
                      └────────────────────┬────────────────────┘
                                           │
                                           ▼
                      ┌─────────────────────────────────────────┐
                      │   Incremental Diff Delta Filtering      │
                      │  (diffStateManager.processPRCommitUpdate)
                      └────────────────────┬────────────────────┘
                                           │
                                           ▼
                      ┌─────────────────────────────────────────┐
                      │       Quorum Decision Voting Matrix     │
                      │   (APPROVE / REQUEST_CHANGES / COMMENT) │
                      └────────────────────┬────────────────────┘
                                           │
                                           ▼
                      ┌─────────────────────────────────────────┐
                      │       Output Formatting Engine          │
                      │  (Inline Diff Comments & Markdown Summary)
                      └─────────────────────────────────────────┘
```

---

## 3. Objective 1: `src/quorum/consensus.ts` Specification

### 3.1 Data Structures & TypeScript Interfaces

`src/quorum/consensus.ts` MUST export the following standardized types and interfaces, aligning with global specs in `PROJECT.md` and `SCOPE.md`:

```typescript
import { Persona, CtReviewConfig } from '../config/schema';
import { PRDiffState, TrackedFinding } from '../persistence/db';
import { IncomingHunkInput } from '../persistence/diffStateManager';

export type SeverityLevel = 'critical' | 'major' | 'minor' | 'nit';
export type QuorumDecision = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface PersonaFinding {
  persona: Persona;
  severity: SeverityLevel;
  filePath: string;
  lineNumber: number;
  endLineNumber?: number;
  comment: string;
  suggestion?: string;
  ruleId?: string;
  codeSnippet: string;
  coSponsoringPersonas?: Persona[];
}

export interface TicketValidationSummary {
  valid: boolean;
  ticketsFound: string[];
  required: boolean;
  error?: string;
}

export interface ConstitutionComplianceSummary {
  compliant: boolean;
  violations: string[];
  enabled: boolean;
}

export interface InlineReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side: 'RIGHT';
  body: string;
}

export interface ConsensusInput {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  config: CtReviewConfig;
  hunks: IncomingHunkInput[];
  personaFindingsMap: Record<Persona, PersonaFinding[]>;
  ticketValidation: TicketValidationSummary;
  constitutionCompliance: ConstitutionComplianceSummary;
  personasExecuted: Persona[];
  tokensUsedTotal: number;
}

export interface QuorumResult {
  summary: string;
  decision: QuorumDecision;
  findings: PersonaFinding[];
  activeFindings: PersonaFinding[];
  filteredNits: PersonaFinding[];
  resolvedFindings: TrackedFinding[];
  suppressedFindingHashes: string[];
  ticketValidation: TicketValidationSummary;
  constitutionCompliance: ConstitutionComplianceSummary;
  formattedMarkdown: string;
  inlineComments: InlineReviewComment[];
  stats: {
    totalFindingsRaw: number;
    totalFindingsDeduplicated: number;
    activeFindingsCount: number;
    filteredNitsCount: number;
    resolvedFindingsCount: number;
    suppressedFindingsCount: number;
    personasExecuted: Persona[];
    approvingPersonas: Persona[];
    requestingChangesPersonas: Persona[];
    tokensUsed: number;
  };
}
```

---

### 3.2 Finding Aggregation & Cross-Persona Deduplication Logic

When parallel LLM personas analyze the same PR diff, multiple personas (e.g., `security` and `quality`, or `architecture` and `performance`) may flag the **same code location** for related concerns.

#### Matching Criteria:
Two findings `A` and `B` are considered duplicate cross-persona findings if:
1. `A.filePath === B.filePath`
2. Line overlap exists: `Math.max(A.lineNumber, B.lineNumber) <= Math.min(A.endLineNumber || A.lineNumber, B.endLineNumber || B.lineNumber) + 2` (allowing a 2-line tolerance window).
3. **Code Snippet Similarity**: Either normalized code snippets match (`normalizeSnippet(A.codeSnippet) === normalizeSnippet(B.codeSnippet)`), or rule IDs match (`A.ruleId && A.ruleId === B.ruleId`).

#### Merging Protocol:
When `A` and `B` match:
* **Primary Persona**: The finding with higher severity becomes primary (`critical` > `major` > `minor` > `nit`). If severities are equal, order by persona precedence (`security` > `architecture` > `performance` > `quality`).
* **Co-Sponsoring Personas**: The non-primary persona is appended to `coSponsoringPersonas`.
* **Severity Escalation**: The merged finding assumes `max(A.severity, B.severity)`.
* **Comment Synthesis**: If comments differ substantially, append secondary comment as `"[Also noted by ${secondaryPersona}]: ${comment}"`.
* **Suggestion Block**: Keep the primary persona's code suggestion (or the more specific one if primary has none).

---

### 3.3 Final PR Decision Logic (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`)

The decision engine evaluates active (unresolved, non-suppressed) findings alongside ticket linkage and constitution checks.

```
+-------------------------------------------------------------------------+
|                         Decision Voting Tree                            |
+-------------------------------------------------------------------------+
                                     │
           Is Ticket Linkage Invalid (required=true)?
           OR Does Constitution Compliance Fail (enabled=true)?
           OR Are there any Active CRITICAL or MAJOR findings?
                                     │
                    ┌────────────────┴────────────────┐
                    │ YES                             │ NO
                    ▼                                 ▼
         [ REQUEST_CHANGES ]              Are approving personas >=
                                          minApprovals requirement?
                                                      │
                                     ┌────────────────┴────────────────┐
                                     │ YES                             │ NO
                                     ▼                                 ▼
                                [ APPROVE ]                       [ COMMENT ]
```

#### Exact Decision Conditions:

1. **`REQUEST_CHANGES`** if ANY of the following occur:
   - Active `critical` or `major` severity finding exists after diff delta filtering.
   - `ticketValidation.required === true` AND `ticketValidation.valid === false`.
   - `constitutionCompliance.enabled === true` AND `constitutionCompliance.compliant === false` with 1+ violations.

2. **`APPROVE`** if ALL of the following occur:
   - `REQUEST_CHANGES` conditions are NOT met.
   - Number of approving personas >= `config.quorum.minApprovals`. (A persona is "approving" if it flagged 0 active `critical` or `major` findings).
   - Ticket check passes (or is not required).
   - Constitution check passes (or is not required).

3. **`COMMENT`** if ALL of the following occur:
   - `REQUEST_CHANGES` conditions are NOT met.
   - Number of approving personas < `config.quorum.minApprovals` (e.g. only 1 persona executed or approved out of minApprovals=2).
   - OR PR contains only `minor` or `nit` findings but fails quorum threshold quota.

---

### 3.4 Inline Comment Formatting & Suggestion Blocks

Each active finding (including `minor` and `nit` if configured) on a modified diff line is formatted into an `InlineReviewComment`.

#### Format Template:
```markdown
### 🛡️ [Security] Critical: Hardcoded Secret Token
**Persona**: `security` *(co-sponsored by `quality`)* | **Severity**: `CRITICAL`

Hardcoded secret token detected in auth middleware.

```suggestion
const token = process.env.AUTH_TOKEN;
```

---
*Flagged by ct-review-bot Quorum Engine*
```

#### Rules for Inline Comments:
- **`path`**: `filePath`
- **`line`**: `lineNumber`
- **`side`**: `'RIGHT'`
- **Suggestion Blocks**: If `suggestion` field exists and is non-empty, enclose in standard GitHub Markdown suggestion fence:
  ```
  ```suggestion
  <suggestion_code>
  ```
  ```

---

### 3.5 Markdown PR Review Summary Generation

The Consensus Aggregator constructs a clean, standardized Markdown report to serve as the main PR review comment body.

```markdown
# 🔴 Quorum Code Review: CHANGES REQUESTED

## Executive Summary
The **Quorum Review Panel Engine** evaluated commit `a1b2c3d` across **4 personas** (`security`, `architecture`, `performance`, `quality`). **1 blocking issue** was identified requiring resolution before merge.

---

## 📊 Quorum Persona Voting Breakdown

| Persona | Status | Severity Flagged | Findings Count |
|---|---|---|---|
| 🛡️ Security | ❌ Request Changes | CRITICAL | 1 active |
| 🏗️ Architecture | ✅ Approve | - | 0 |
| ⚡ Performance | ✅ Approve | - | 0 |
| 🎨 Quality | ✅ Approve | NIT | 1 filtered |

*Quorum Requirement*: Minimum **2 approvals** required (Achieved: 3 approving personas).

---

## 🎟️ Ticket Linkage Status
- **Status**: ✅ VALID
- **Tickets Identified**: `[PROJ-123]` (Linear)

---

## 📜 Operational Constitution Compliance
- **Status**: ✅ COMPLIANT
- **Violations**: None

---

## ⚠️ Active Findings Requiring Attention

### 1. 🛡️ `src/auth.ts`: Line 42 (CRITICAL)
**Persona**: Security | **Rule**: `SEC-001`
> Hardcoded secret token in auth.ts

```suggestion
const token = process.env.AUTH_TOKEN;
```

---

## 🧹 Incremental Diff Filtering Summary
- **Previously Resolved Issues Skipped**: 2
- **Filtered Nits**: 1
- **Active Findings**: 1

---
*Generated by **ct-review-bot** v1.0 | Tokens Used: 1,420*
```

---

## 4. Objective 2: Incremental Diff Delta Filtering Integration

### 4.1 Integration Pipeline & Data Flow

`src/quorum/consensus.ts` interfaces directly with `DiffStateManager` (`src/persistence/diffStateManager.ts`).

```
Persona Findings -> Cross-Persona Deduplication -> IncomingFindingInput[]
                                                            │
                                                            ▼
                                        diffStateManager.processPRCommitUpdate(...)
                                                            │
                                                            ▼
                                        ProcessPRUpdateResult {
                                          activeFindings,
                                          resolvedFindings,
                                          suppressedFindingHashes
                                        }
                                                            │
                                                            ▼
                                        Filtered Active Findings -> Consensus Decision & Markdown
```

### 4.2 SHA-256 Fingerprint Hashing Alignment

To prevent duplicate re-flagging of previously resolved issues, `diffHash.ts` calculates a line-shift resilient SHA-256 fingerprint hash:

```typescript
export function computeFindingHash(input: FindingInput): string {
  const normalizedCode = normalizeSnippet(input.codeSnippet);
  const keyId = input.findingId || input.ruleId;
  const normalizedSummary = keyId
    ? normalizeComment(keyId)
    : normalizeComment(input.comment);

  const rawString = `${input.filePath}|${input.persona.toLowerCase()}|${normalizedCode}|${normalizedSummary}`;
  return crypto.createHash('sha256').update(rawString, 'utf8').digest('hex');
}
```

#### Hash Alignment Contract:
1. **Persona Consistency**: For deduplicated findings with co-sponsors, use the **primary persona** name in `FindingInput.persona`.
2. **Code Snippet Normalization**: Strip carriage returns (`\r\n` -> `\n`), trim leading/trailing whitespace per line, ignore empty lines.
3. **Comment Normalization**: Convert to lowercase, remove non-alphanumeric punctuation, collapse whitespace. If `ruleId` is present, use `ruleId` as summary key.

### 4.3 State Transition Matrix

| Previous State | Current Review | Severity | Action Taken | New Finding Status |
|---|---|---|---|---|
| *None* (New) | Flagged | Any | Record new finding | `IDENTIFIED` |
| `IDENTIFIED` | Flagged | Any | Update `lastSeenCommit`, keep active | `IDENTIFIED` |
| `IDENTIFIED` | Not Flagged (in modified hunk) | Any | Mark fixed by developer | `RESOLVED` (`resolvedAtCommit` set) |
| `IDENTIFIED` | Not Flagged (in unmodified hunk) | Any | Carry over untouched | `IDENTIFIED` |
| `RESOLVED` | Flagged | `critical` | **Re-open critical defect** | `IDENTIFIED` (`resolvedAtCommit` reset to `null`) |
| `RESOLVED` | Flagged | `major` / `minor` / `nit` | **Suppress duplicate resolved issue** | `SUPPRESSED` |
| `SUPPRESSED` | Flagged | Non-critical | Keep suppressed | `SUPPRESSED` |

---

## 5. Step-by-Step Worker Implementation Recommendations

### Step 1: Create `src/quorum/consensus.ts`
Implement core types, `deduplicateAcrossPersonas()`, and `evaluateQuorumDecision()`.

### Step 2: Implement `filterFindingsWithDiffState()`
Integrate `DiffStateManager` to transform deduplicated findings into `IncomingFindingInput[]`, execute `processPRCommitUpdate()`, and extract `activeFindings`, `resolvedFindings`, and `suppressedFindingHashes`.

### Step 3: Implement `formatInlineComments()` and `generateMarkdownSummary()`
Format GitHub-compliant inline comments with suggestion blocks and generate the multi-section Markdown report.

### Step 4: Implement Main Entry Point `aggregateQuorumConsensus()`
Export main function:
```typescript
export async function aggregateQuorumConsensus(
  input: ConsensusInput,
  diffStateManager?: DiffStateManager
): Promise<QuorumResult>
```

### Step 5: Unit & Integration Tests
1. `tests/unit/consensus.test.ts`: Test deduplication, decision matrix, comment formatting, and markdown generation.
2. `tests/integration/m3_quorum.test.ts`: End-to-end integration across `mefEngine`, `consensus.ts`, and `diffStateManager`.

---

## 6. Edge Cases & Risk Mitigation Matrix

| Edge Case | Description | Expected Behavior |
|---|---|---|
| **0 Personas Executed** | All persona calls time out or fail. | Return decision `COMMENT` with warning summary: "Quorum review incomplete due to LLM provider failures". |
| **All Findings Filtered as Nits** | Only `nit` findings exist. | Decision is `APPROVE` (nits do not block). Nits included in summary table under "Filtered Nits". |
| **Ticket Missing on Draft PR** | Ticket linkage missing, but PR is draft. | Log warning; flag `REQUEST_CHANGES` if ticket enforcement `required: true`. |
| **Re-opened Critical Finding** | Previously resolved critical issue re-introduced. | `diffStateManager` resets status to `IDENTIFIED`, decision evaluates to `REQUEST_CHANGES`. |
| **Overlapping Cross-Persona Findings** | Security & Quality flag same line. | Deduplicate to 1 finding; assign `critical` severity, merge comments, add co-sponsor `quality`. |

---

## 7. Verification Method

To verify the implementation:

```bash
cd /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot

# 1. TypeCheck & Build
npm run build

# 2. Execute Unit Tests for Consensus & Quorum
npx vitest run tests/unit/consensus.test.ts
npx vitest run tests/unit/quorum.test.ts

# 3. Execute Full Test Suite
npm test
```
