# Technical Specification & Analysis: Incremental Diff State Manager & M1 Test Strategy

## 1. Overview & Architecture

The **Incremental Diff State Manager** is the persistence and state tracking engine of `ct-review-bot`. When PRs evolve across multiple commits, re-evaluating unchanged code hunks or re-flagging previously resolved issues burns unnecessary LLM tokens and creates developer fatigue with repetitive GitHub comments.

This specification details:
1. **SHA-256 Hashing & Fingerprinting Engine** (`src/utils/diffHash.ts`): Unique, whitespace-normalized fingerprinting for diff hunks and review findings (nits & PXs).
2. **Dual-Tier Persistence Layer** (`src/persistence/db.ts`): Primary storage in SQLite (`better-sqlite3`) with an atomic JSON storage fallback.
3. **Incremental Diff State Manager** (`src/persistence/diffStateManager.ts`): State machine and delta engine comparing PR commit updates, updating finding resolution status, suppressing duplicate findings, and reducing token load.
4. **M1 Unit & Integration Test Strategy** (`tests/unit/`, `tests/integration/`): Comprehensive test suite covering config loading, ticket validation, constitution enforcement, diff hashing, persistence, and multi-commit PR state transitions.

```
                    ┌───────────────────────────────────────────────┐
                    │          GitHub PR Update (Commit C2)         │
                    └───────────────────────┬───────────────────────┘
                                            │
                                            ▼
                    ┌───────────────────────────────────────────────┐
                    │      Diff Hunk & Finding Fingerprinter       │
                    │         (SHA-256, Normalized Snippets)        │
                    └───────────────────────┬───────────────────────┘
                                            │
                                            ▼
                    ┌───────────────────────────────────────────────┐
                    │         Incremental Diff State Engine         │
                    │  ┌─────────────────────────────────────────┐  │
                    │  │ Load State (C1) from SQLite / JSON DB   │  │
                    │  ├─────────────────────────────────────────┤  │
                    │  │ Delta Matrix: Compare C2 Diff vs C1 Diff│  │
                    │  ├─────────────────────────────────────────┤  │
                    │  │ Mark Fixed Items: IDENTIFIED -> RESOLVED │  │
                    │  ├─────────────────────────────────────────┤  │
                    │  │ Suppress Re-flagging: Active/Resolved    │  │
                    │  └─────────────────────────────────────────┘  │
                    └───────────────────────┬───────────────────────┘
                                            │
                                            ▼
                    ┌───────────────────────────────────────────────┐
                    │     Filtered Unreviewed Hunks & New Findings   │
                    │           (Minimizes Quorum Token Load)       │
                    └───────────────────────────────────────────────┘
```

---

## 2. Hashing & Fingerprinting Specification (`src/utils/diffHash.ts`)

To track diff changes and review findings robustly across line number shifts, fingerprinting uses SHA-256 hashes computed over normalized representations of code hunks and findings.

### 2.1 Code Hunk Fingerprinting (`computeHunkHash`)
- **Inputs**:
  - `filePath`: string (e.g. `src/auth/jwt.ts`)
  - `hunkHeader`: string (e.g. `@@ -15,6 +15,9 @@`)
  - `hunkContent`: string (diff lines containing context, additions, deletions)
- **Normalization Process**:
  1. Strip trailing whitespace from every line.
  2. Normalize line endings to `\n` (`\r\n` -> `\n`).
  3. Strip git diff metadata prefixes (`+`, `-`, ` `) if computing content-only hash, or preserve prefixes for structural diff hash.
- **Algorithm**:
  `SHA256(filePath + "\n" + normalizedHunkContent)`
- **Output**: 64-character hex string.

### 2.2 Finding Fingerprint Hash (`computeFindingHash`)
Finding line numbers shift when lines are added or removed above the finding. A line-number-only key fails across multi-commit PRs. Finding fingerprints must be line-resilient.

- **Inputs**:
  - `filePath`: string
  - `persona`: `'security' | 'architecture' | 'performance' | 'quality'`
  - `severity`: `'critical' | 'major' | 'minor' | 'nit'`
  - `codeSnippet`: string (surrounding 3-5 lines of code context)
  - `ruleIdOrSummary`: string (canonical category, e.g., `SEC-UNSANITIZED-INPUT` or normalized comment body summary)
- **Normalization Process**:
  1. `normalizedSnippet`: Remove all leading/trailing whitespace per line, collapse internal whitespace.
  2. `normalizedSummary`: Convert to lowercase, remove punctuation, trim.
- **Algorithm**:
  `SHA256(filePath + "|" + persona + "|" + normalizedSnippet + "|" + normalizedSummary)`
- **Output**: 64-character hex string.

### 2.3 Interface Definition (`src/utils/diffHash.ts`)

```typescript
export interface HunkInput {
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  hunkContent: string;
}

export interface FindingInput {
  filePath: string;
  persona: string;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  codeSnippet: string;
  comment: string;
  ruleId?: string;
}

export interface DiffHashUtil {
  computeHunkHash(input: HunkInput): string;
  computeFindingHash(input: FindingInput): string;
  normalizeSnippet(snippet: string): string;
  normalizeComment(comment: string): string;
}
```

---

## 3. Persistence Layer Specification (`src/persistence/db.ts`)

The storage system uses a unified storage interface (`IDiffStateStorage`), supporting **SQLite** (via `better-sqlite3`) as the primary database, and an **Atomic JSON File Storage** fallback.

### 3.1 Data Schema

#### Data Models (TypeScript Interfaces)

```typescript
export type FindingStatus = 'IDENTIFIED' | 'RESOLVED' | 'SUPPRESSED';

export interface TrackedFinding {
  id?: number;
  prStateId?: number;
  fingerprintHash: string;
  filePath: string;
  startLine: number;
  endLine: number;
  persona: string;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  comment: string;
  status: FindingStatus;
  firstSeenCommit: string;
  lastSeenCommit: string;
  resolvedAtCommit: string | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface TrackedHunk {
  id?: number;
  prStateId?: number;
  filePath: string;
  hunkHash: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  commitSha: string;
  createdAt: string;
}

export interface PRDiffState {
  id?: number;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  updatedAt: string;
  hunks: TrackedHunk[];
  findings: TrackedFinding[];
}
```

### 3.2 Primary Engine: SQLite Schema (`better-sqlite3`)

```sql
CREATE TABLE IF NOT EXISTS pr_states (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(repo_owner, repo_name, pr_number)
);

CREATE TABLE IF NOT EXISTS diff_hunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_state_id INTEGER NOT NULL REFERENCES pr_states(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    hunk_hash TEXT NOT NULL,
    old_start INTEGER NOT NULL,
    old_lines INTEGER NOT NULL,
    new_start INTEGER NOT NULL,
    new_lines INTEGER NOT NULL,
    commit_sha TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracked_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_state_id INTEGER NOT NULL REFERENCES pr_states(id) ON DELETE CASCADE,
    fingerprint_hash TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    persona TEXT NOT NULL,
    severity TEXT NOT NULL,
    comment TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('IDENTIFIED', 'RESOLVED', 'SUPPRESSED')),
    first_seen_commit TEXT NOT NULL,
    last_seen_commit TEXT NOT NULL,
    resolved_at_commit TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(pr_state_id, fingerprint_hash)
);

CREATE INDEX IF NOT EXISTS idx_pr_states_lookup ON pr_states(repo_owner, repo_name, pr_number);
CREATE INDEX IF NOT EXISTS idx_findings_lookup ON tracked_findings(pr_state_id, fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_hunks_lookup ON diff_hunks(pr_state_id, file_path);
```

### 3.3 Storage Fallback: Atomic JSON Engine

When `better-sqlite3` native module loading is unavailable or restricted:
- File path: Configurable (default: `./data/pr_states.json`).
- Atomic Write Procedure:
  1. Serialize state map to JSON string.
  2. Write to temp file: `${filePath}.tmp.${Date.now()}_${process.pid}`.
  3. Flush to disk via `fs.fsyncSync`.
  4. Perform atomic rename via `fs.renameSync` over `${filePath}`.
- Guarantees zero data loss or partial file corruption during sudden crashes or interrupts.

### 3.4 Unified Storage Abstraction (`IDiffStateStorage`)

```typescript
export interface IDiffStateStorage {
  init(): Promise<void>;
  getPRState(owner: string, repo: string, prNumber: number): Promise<PRDiffState | null>;
  savePRState(state: PRDiffState): Promise<void>;
  getFindings(owner: string, repo: string, prNumber: number): Promise<TrackedFinding[]>;
  updateFindingStatus(
    owner: string,
    repo: string,
    prNumber: number,
    fingerprintHash: string,
    status: FindingStatus,
    commitSha: string
  ): Promise<void>;
  close(): Promise<void>;
}
```

---

## 4. Incremental Diff State Manager Logic (`src/persistence/diffStateManager.ts`)

### 4.1 State Machine Lifecycle & Finding Status Transitions

Findings transition through 3 core states:
1. `IDENTIFIED`: Finding initially discovered by Quorum review panel in Commit `C1`.
2. `RESOLVED`: Finding was present in `C1`, but code in affected hunk was modified in `C2` such that the finding condition no longer matches or the hunk was removed.
3. `SUPPRESSED`: Finding is either already marked `RESOLVED` (preventing re-flagging in `C2`), or active finding is already commented on in previous commit and hunk is unchanged.

```
                    ┌─────────────────────────┐
                    │    Quorum Discovery     │
                    └────────────┬────────────┘
                                 │
                                 ▼
                     ┌───────────────────────┐
                     │      IDENTIFIED       │
                     └───────────┬───────────┘
                                 │
                   Code Fix / Hunk Modification
                                 │
                                 ▼
                     ┌───────────────────────┐
                     │       RESOLVED        │
                     └───────────┬───────────┘
                                 │
                 PR Re-run / Re-evaluation Check
                                 │
                                 ▼
                     ┌───────────────────────┐
                     │      SUPPRESSED       │
                     └───────────────────────┘
```

### 4.2 Incremental Comparison Algorithm (`processPRCommitUpdate`)

Given a new PR commit (`headSha = C2`, `baseSha`):

1. **Fetch Prior PR State**:
   - Query storage for state matching `owner/repo#prNumber`.
   - If `null` (Initial PR commit `C1`):
     - Calculate hunk hashes for all hunks in `C1`.
     - Save initial state with all findings marked `IDENTIFIED`.
     - Return full diff hunks for initial Quorum evaluation.

2. **Incremental Delta Analysis (Commit `C2` vs Commit `C1`)**:
   - Compare `C2` hunks against `C1` stored hunks.
   - Categorize hunks into:
     - `UNCHANGED_HUNKS`: Hunk hash in `C2` matches hunk hash in `C1`.
     - `MODIFIED_HUNKS`: Same file, overlapping line ranges, but hunk hash changed.
     - `NEW_HUNKS`: File/hunk not present in `C1`.
     - `DELETED_HUNKS`: Hunk present in `C1` but removed in `C2`.

3. **Finding Resolution & Suppression Processing**:
   - For every existing finding in state:
     - **Case A**: Finding belongs to `UNCHANGED_HUNK`:
       - If status == `IDENTIFIED`: Finding remains `IDENTIFIED`, but comment output is suppressed on re-review if already posted.
       - If status == `RESOLVED`: Finding remains `RESOLVED`, suppressed from re-flagging.
     - **Case B**: Finding belongs to `MODIFIED_HUNK` or `DELETED_HUNK`:
       - Check if new code in `C2` still exhibits the finding fingerprint.
       - If fingerprint is absent in `C2`: Mark status = `RESOLVED`, `resolvedAtCommit = C2`.
     - **Case C**: New findings in `C2` Quorum output:
       - Compute `fingerprintHash`.
       - If matching `fingerprintHash` exists in DB with status `RESOLVED`:
         - Suppress duplicate notification unless severity is `critical`.
       - If new fingerprint: Insert with status = `IDENTIFIED`, `firstSeenCommit = C2`.

4. **Token Optimization Strategy**:
   - Pass only `MODIFIED_HUNKS` and `NEW_HUNKS` to Quorum LLM panel, paired with a compact summary of previously resolved/active findings. Unchanged hunks bypass fresh LLM inference, reducing LLM token consumption up to 80% on multi-commit PR updates.

---

## 5. M1 Unit and Integration Test Strategy (`tests/unit/`, `tests/integration/`)

### 5.1 Test Framework Setup
- **Framework**: Vitest (fast TypeScript-native test runner).
- **Directory Layout**:
  - `tests/unit/config.test.ts`
  - `tests/unit/ticket.test.ts`
  - `tests/unit/constitution.test.ts`
  - `tests/unit/diffState.test.ts`
  - `tests/integration/m1_foundations.test.ts`

### 5.2 Unit Test Matrix

| Test Suite | Target Module | Test Scenarios | Expected Output / Assertion |
|------------|---------------|----------------|-----------------------------|
| `config.test.ts` | `src/config/` | 1. Valid `.ct-review.yaml`<br>2. Missing required fields<br>3. Invalid types/values<br>4. `.coderabbit.yaml` migration/fallback<br>5. Org default fallback merge | 1. Parses valid Zod object<br>2. Throws Zod error<br>3. Validation failure message<br>4. Successfully maps schema<br>5. Correctly applies defaults |
| `ticket.test.ts` | `src/ticket/ticketValidator.ts` | 1. Linear tag `[PROJ-123]` in title<br>2. Jira tag `[KEY-456]` in body<br>3. GitHub issue `#789` or `PROJ-789`<br>4. Missing ticket when required<br>5. Multiple ticket links | 1. `valid: true, tickets: ['PROJ-123']`<br>2. `valid: true, tickets: ['KEY-456']`<br>3. `valid: true, tickets: ['#789']`<br>4. `valid: false, error: 'No ticket link'`<br>5. `tickets: ['PROJ-123', 'PROJ-456']` |
| `constitution.test.ts` | `src/constitution/constitutionEngine.ts` | 1. Standard `constitution.md` parsing<br>2. MUST directive violation<br>3. MUST NOT directive compliance<br>4. Non-existent path handling | 1. Extracts array of directives<br>2. `compliant: false, violations: [...]`<br>3. `compliant: true`<br>4. Uses default empty constitution |
| `diffState.test.ts` | `src/utils/diffHash.ts`, `src/persistence/` | 1. SHA-256 Hunk hashing consistency<br>2. Finding fingerprint line-shift resilience<br>3. SQLite database CRUD & schema initialization<br>4. JSON atomic fallback write & recovery<br>5. Finding status transition (`IDENTIFIED` -> `RESOLVED`) | 1. Deterministic 64-char hex<br>2. Same hash despite shifted line #<br>3. Rows persisted and retrieved<br>4. File atomic replace without corruption<br>5. Status updated correctly |

### 5.3 Integration Test Specification (`tests/integration/m1_foundations.test.ts`)

#### Scenario: Multi-Commit PR Review Cycle Flow
Simulate an end-to-end PR lifecycle across 2 commits with ticket validation, constitution enforcement, and diff state persistence:

- **Setup**: Initialize in-memory SQLite (or temp SQLite DB) & mock config loader.
- **Commit 1 Execution**:
  1. Title: `"feat(auth): add JWT validation [PROJ-101]"`
  2. PR Body contains constitution violation (e.g. prohibited raw console log).
  3. Diff contains 2 hunks: `src/auth.ts` (Hunk 1: JWT check, Hunk 2: SQL query).
  4. Run Ticket Validator -> Pass (`[PROJ-101]`).
  5. Run Constitution Engine -> Flag violation (prohibited console.log).
  6. Compute Hunk & Finding Fingerprints -> Store State for Commit 1 (`c11111`).
  7. Findings stored: `F1` (Nit: console.log, status: `IDENTIFIED`), `F2` (PX Security: unsanitized query, status: `IDENTIFIED`).
- **Commit 2 Execution**:
  1. Developer pushes Commit 2 (`c22222`), removing the console log and fixing `F1`, while keeping `F2` unchanged.
  2. Run Diff State Manager with Commit 2 diff.
  3. Process delta comparison against stored Commit 1 state.
  4. Assertions:
     - `F1` (console.log) status is updated to `RESOLVED` at commit `c22222`.
     - `F1` is added to suppression list for re-flagging.
     - `F2` (SQL query) remains `IDENTIFIED`.
     - State in DB reflects `headSha = c22222`, 1 `IDENTIFIED` finding, 1 `RESOLVED` finding.

---

## 6. Verification Method & Test Command

To verify the design and implementation when built:
1. Build command: `npm run build` (compiles TypeScript to `dist/`).
2. Test commands:
   - Unit tests: `npx vitest run tests/unit/`
   - Integration tests: `npx vitest run tests/integration/`
   - All tests: `npm test`
3. Verification Invalidation Conditions:
   - Any test failure in `diffState.test.ts` or `m1_foundations.test.ts`.
   - SQLite schema failure or JSON atomic fallback failover error.
   - Non-deterministic SHA-256 fingerprint generation across line shifts.
