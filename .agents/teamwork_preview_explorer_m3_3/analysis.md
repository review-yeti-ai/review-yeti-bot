# Milestone 3 Analysis Report: Quorum Review Panel Engine & Testing Blueprint

**Author**: Explorer 3 (Milestone 3 — Quorum Review Panel Engine)  
**Target Project Root**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`  
**Working Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m3_3`  
**Date**: 2026-07-24  

---

## Executive Summary

Milestone 3 implements the core intelligence of `ct-review-bot`: the **Quorum Review Panel Engine**. This report provides the definitive architectural blueprint, integration specifications, mock data structures, edge case catalog, and test implementation plan for Worker execution.

The Quorum engine integrates five primary components into a single decision pipeline:
1. **Ticket Linkage Validator** (`src/ticket/ticketValidator.ts`)
2. **Operational Constitution Engine** (`src/constitution/constitutionEngine.ts`)
3. **Incremental Diff Delta State Manager** (`src/persistence/diffStateManager.ts`)
4. **Multi-Agent Persona Fan-Out Engine** (`src/quorum/mefEngine.ts` & `src/quorum/personas/`)
5. **Consensus Aggregator & Markdown Formatter** (`src/quorum/consensus.ts`)

---

## 1. Ticket & Constitution Integration Architecture

### 1.1 Integration Pipeline Data Flow

```
                      ┌──────────────────────────────────────────┐
                      │    Input: PR Payload, Diff, Config       │
                      └────────────────────┬─────────────────────┘
                                           │
                                           ▼
                      ┌──────────────────────────────────────────┐
                      │  Step 1: Ticket & Constitution Checks    │
                      │  - ticketValidator.validateTicketLinkage │
                      │  - constitutionEngine.evaluateConstitution│
                      └────────────────────┬─────────────────────┘
                                           │
                                           ▼
                      ┌──────────────────────────────────────────┐
                      │  Step 2: Incremental Diff Delta Filter   │
                      │  - diffStateManager.getPRState()         │
                      │  - Filter out previously resolved items  │
                      └────────────────────┬─────────────────────┘
                                           │
                                           ▼
                      ┌──────────────────────────────────────────┐
                      │  Step 3: Multi-Agent Fan-Out (mefEngine) │
                      │  - Security, Arch, Perf, Quality personas│
                      │  - OmniRoute LLM completion with effort  │
                      └────────────────────┬─────────────────────┘
                                           │
                                           ▼
                      ┌──────────────────────────────────────────┐
                      │  Step 4: Quorum Consensus & Decision     │
                      │  - Deduplicate findings                  │
                      │  - Evaluate decision matrix              │
                      │  - Generate summary Markdown output      │
                      └──────────────────────────────────────────┘
```

### 1.2 Integration Mechanics

#### A. Ticket Linkage Integration (`ticketValidator.ts`)
- **Input**: `prTitle`, `prBody`, `config.ticketEnforcement`.
- **Function**: `validateTicketLinkage({ title: prTitle, body: prBody, config: config.ticketEnforcement })`.
- **Output**: `TicketValidationResult` containing:
  - `valid: boolean`
  - `ticketsFound: string[]`
  - `error?: string`
  - `mode: 'strict' | 'advisory'`
- **Decision Impact**:
  - If `mode === 'strict'` and `valid === false`: Forces the PR decision to `REQUEST_CHANGES` regardless of persona approvals.
  - If `mode === 'advisory'` and `valid === false`: Appends an advisory warning block to the summary Markdown without triggering a hard request for changes.

#### B. Operational Constitution Integration (`constitutionEngine.ts`)
- **Input**: `parsedConstitution`, `prTitle`, `prBody`, `changedFiles`, `config.constitution`.
- **Function**: `evaluateConstitution({ constitution, prTitle, prBody, changedFiles, config })`.
- **Output**: `ConstitutionEvaluationResult` containing:
  - `compliant: boolean`
  - `violations: string[]`
  - `bypassed?: boolean`
- **Decision Impact**:
  - If `config.constitution.enabled !== false` and `compliant === false`: Forces the PR decision to `REQUEST_CHANGES`. All listed violations are prominently displayed in the summary Markdown.
  - If `config.constitution.enabled === false`: Marked as `bypassed: true` and excluded from blocking criteria.

#### C. Unified Quorum Result Interface (`QuorumResult`)
```typescript
export interface PersonaFinding {
  persona: 'security' | 'architecture' | 'performance' | 'quality';
  severity: 'critical' | 'major' | 'minor' | 'nit';
  filePath: string;
  lineNumber: number;
  comment: string;
  suggestion?: string;
  ruleId?: string;
}

export interface QuorumResult {
  summary: string;
  decision: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  findings: PersonaFinding[];
  ticketValidation: {
    valid: boolean;
    ticketsFound: string[];
    error?: string;
    mode: 'strict' | 'advisory';
  };
  constitutionCompliance: {
    compliant: boolean;
    violations: string[];
    bypassed?: boolean;
  };
  formattedMarkdown: string;
  stats: {
    totalFindings: number;
    filteredFindings: number;
    personasExecuted: string[];
    tokensUsed: number;
  };
}
```

### 1.3 Summary Markdown Generator Specification

The `consensus.ts` module must format a clean, GitHub-flavored Markdown summary report:

```markdown
# 🤖 Quorum Code Review Panel Report

| Status | Decision | Min Approvals | Executed Personas |
|---|---|---|---|
| ❌ Request Changes | **REQUEST_CHANGES** | 2 | security, architecture, performance, quality |

---

## 🎟️ Ticket Linkage Status
- **Status**: ❌ **Failed (Strict)**
- **Tickets Found**: `None`
- **Error**: `No ticket linkage found in PR title or body. Configured required providers: [linear, jira].`

---

## 📜 Operational Constitution Status
- **Compliance**: ❌ **Non-Compliant**
- **Violations**:
  - 🚨 `Forbidden pattern matched in file 'src/auth/jwt.ts' [Rule rule-1]: Prohibit direct eval execution /eval\(.*?/`
  - 🚨 `Directive violation [Rule rule-3]: PR description missing testing steps`

---

## 👥 Persona Breakdown & Verdicts

| Persona | Verdict | Critical | Major | Minor | Nit |
|---|---|---|---|---|---|
| 🛡️ **Security** | ❌ Request Changes | 1 | 0 | 0 | 0 |
| 🏗️ **Architecture** | ✅ Approve | 0 | 0 | 1 | 0 |
| ⚡ **Performance** | ✅ Approve | 0 | 0 | 0 | 0 |
| 🎨 **Quality** | ✅ Approve | 0 | 0 | 0 | 2 |

---

## 🔍 Active Persona Findings (1)

### 🛡️ Security
- **File**: `src/auth/jwt.ts` (Line 15)
- **Severity**: `CRITICAL` [`SEC-NO-EVAL`]
- **Comment**: Avoid `eval()` execution with untrusted JWT tokens.
- **Suggestion**: Use `JSON.parse()` or dedicated JWT verification library.

---

## 📊 Summary Statistics
- **Total Findings**: 4
- **Filtered Nits & Resolved Items**: 3
- **Total LLM Tokens Used**: 1,420
```

---

## 2. Comprehensive Test Plan

### 2.1 Test Suite Organization

| Test File | Focus & Scope | Target Scenarios |
|---|---|---|
| `tests/unit/quorum.test.ts` | Unit tests for `mefEngine.ts` & persona prompts | Persona fan-out, effort level passing, partial persona timeouts/failures, malformed LLM responses |
| `tests/unit/consensus.test.ts` | Unit tests for `consensus.ts` aggregator | Decision matrix, voting threshold, deduplication, nit filtering, ticket & constitution status merging, Markdown formatting |
| `tests/integration/m3_quorum.test.ts` | Integration tests for full M3 Quorum Panel | End-to-end multi-commit PR review lifecycle with mock OmniRoute server, ticketValidator, constitutionEngine, and diffStateManager |

---

### 2.2 Detailed Unit Test Scenarios: `tests/unit/quorum.test.ts`

#### Group 1: Persona Fan-Out Execution (`mefEngine`)
- **Scenario 1.1: Full 4-Persona Fan-Out**:
  - Configure `personas: ['security', 'architecture', 'performance', 'quality']`.
  - Execute `mefEngine.runQuorumReview()`.
  - Assert that `omniRouteAdapter.complete()` is invoked exactly 4 times with corresponding system prompts.
- **Scenario 1.2: Selective Persona Fan-Out**:
  - Configure `personas: ['security', 'quality']`.
  - Assert that only security and quality persona prompts are compiled and executed.
- **Scenario 1.3: Persona Effort Level Propagation**:
  - Set `effortLevel: 'high'`.
  - Assert that all LLM completion calls pass `effortLevel: 'high'`.

#### Group 2: Error Handling & Partial Failures
- **Scenario 2.1: Graceful Degraded Fan-Out on Persona Timeout**:
  - Mock `omniRouteAdapter` to reject with TimeoutError for `perfPersona` while succeeding for security, arch, quality.
  - Assert that `mefEngine` does NOT crash, returns findings from the 3 successful personas, and records `perfPersona` as failed in metadata stats.
- **Scenario 2.2: Handling Malformed / Code-Block LLM Responses**:
  - Mock LLM response containing markdown backticks: ` ```json [{"persona":"security", ...}] ``` ` or invalid raw text.
  - Assert that persona JSON parsing cleanly strips code-block delimiters or gracefully logs and fallback handles raw output without throwing uncaught exceptions.

---

### 2.3 Detailed Unit Test Scenarios: `tests/unit/consensus.test.ts`

#### Group 1: Decision Matrix Verification
- **Scenario 1.1: All Personas Approve, Valid Ticket, Compliant Constitution**:
  - `minApprovals: 2`, 4 approvals, 0 findings -> `decision: 'APPROVE'`.
- **Scenario 1.2: Critical Severity Triggers REQUEST_CHANGES**:
  - 1 Critical security finding present -> `decision: 'REQUEST_CHANGES'`.
- **Scenario 1.3: Major Severity Triggers REQUEST_CHANGES**:
  - 1 Major architecture finding present -> `decision: 'REQUEST_CHANGES'`.
- **Scenario 1.4: Minor & Nit Findings Only**:
  - 0 Critical/Major, 2 Minor, 3 Nits, 4 persona approvals -> `decision: 'APPROVE'` (or `'COMMENT'` if configured).
- **Scenario 1.5: Unmet Min Approvals Deficit**:
  - `minApprovals: 3`, 2 personas executed and approving -> `decision: 'REQUEST_CHANGES'` (or `'COMMENT'`).

#### Group 2: Deduplication & Nit Filtering
- **Scenario 2.1: Overlapping Finding Deduplication**:
  - Security persona and Quality persona both flag line 10 in `src/auth.ts` with similar text.
  - Assert findings are deduplicated into a single active finding prioritizing the higher severity (`critical` > `minor`).
- **Scenario 2.2: Nit Filtering**:
  - Input: 2 Critical findings, 5 Nit findings.
  - Assert `findings` array contains only the 2 Critical findings; `filteredNits` contains the 5 Nit findings.

#### Group 3: Ticket Linkage & Constitution Merging
- **Scenario 3.1: Strict Ticket Validation Failure**:
  - Input: `ticketValidation: { valid: false, mode: 'strict', error: 'Missing ticket' }`.
  - Assert overall `decision: 'REQUEST_CHANGES'` and error message is included in `formattedMarkdown`.
- **Scenario 3.2: Advisory Ticket Validation Failure**:
  - Input: `ticketValidation: { valid: false, mode: 'advisory', error: 'Missing ticket' }`.
  - Personas approve. Assert `decision: 'APPROVE'` with advisory notice in Markdown.
- **Scenario 3.3: Constitution Violation Merging**:
  - Input: `constitutionCompliance: { compliant: false, violations: ['Rule 1 failed'] }`.
  - Assert overall `decision: 'REQUEST_CHANGES'` and violation list is included in Markdown.

---

### 2.4 Detailed Integration Test Scenarios: `tests/integration/m3_quorum.test.ts`

#### Group 1: End-to-End Multi-Commit Lifecycle
- **Scenario 1.1: Commit 1 (Flawed Commit Lifecycle)**
  - Setup: Mock OmniRoute server running.
  - PR Metadata: Title `"feat: initial auth setup"` (Missing ticket), Body `"Adds auth module"`.
  - Diff: Adds `src/auth/jwt.ts` containing `eval(raw)`.
  - Constitution: Rules forbid `eval()`, directive requires testing steps.
  - Execution: Run full Quorum review engine pipeline.
  - Expected Assertions:
    - Ticket validation: `valid: false` (strict).
    - Constitution: `compliant: false` (2 violations: `eval` forbidden pattern, missing testing steps directive).
    - Persona findings: Security persona returns 1 `CRITICAL` finding (`eval(raw)`).
    - Overall decision: `REQUEST_CHANGES`.
    - Diff State Manager: Stores 1 active finding with line fingerprint hash.

- **Scenario 1.2: Commit 2 (Remediated Commit Lifecycle)**
  - Setup: Same PR #101 update.
  - PR Metadata: Updated title `"feat: implement safe JWT parsing [PROJ-202]"` (Valid ticket), Body `"Implements safe JWT parsing. Testing steps: 1. run npm test."` (Compliant body).
  - Diff: `src/auth/jwt.ts` replaced `eval(raw)` with `JSON.parse(raw)`.
  - Execution: Run full Quorum review engine pipeline with `diffStateManager`.
  - Expected Assertions:
    - Ticket validation: `valid: true`, `ticketsFound: ['PROJ-202']`.
    - Constitution: `compliant: true`, `violations: []`.
    - Diff State Manager: Detects `eval(raw)` finding resolved at Commit 2 SHA.
    - Persona findings: 0 active blocking findings.
    - Overall decision: `APPROVE`.

---

## 3. Concrete Mock Data Structures & Fixtures

Worker implementations should use these standard mock structures for unit and integration testing:

### 3.1 Mock OmniRoute Responses

```typescript
export const MOCK_SECURITY_PERSONA_RESPONSE = JSON.stringify([
  {
    persona: 'security',
    severity: 'critical',
    filePath: 'src/auth/jwt.ts',
    lineNumber: 15,
    comment: 'Use of eval() on untrusted JWT payload creates remote code execution vulnerability.',
    suggestion: 'Replace eval() with JSON.parse().',
    ruleId: 'SEC-NO-EVAL',
  },
]);

export const MOCK_ARCH_PERSONA_RESPONSE = JSON.stringify([
  {
    persona: 'architecture',
    severity: 'minor',
    filePath: 'src/auth/jwt.ts',
    lineNumber: 5,
    comment: 'Function export lacks explicit type definition interface.',
    suggestion: 'Export interface JwtPayload and type return value.',
    ruleId: 'ARCH-EXPLICIT-TYPES',
  },
]);

export const MOCK_QUALITY_PERSONA_RESPONSE = JSON.stringify([
  {
    persona: 'quality',
    severity: 'nit',
    filePath: 'src/auth/jwt.ts',
    lineNumber: 2,
    comment: 'Unnecessary trailing whitespace.',
    suggestion: 'Trim line whitespace.',
    ruleId: 'QUAL-TRAILING-WHITESPACE',
  },
]);
```

### 3.2 Mock PR Metadata & Diff Hunks

```typescript
export const MOCK_PR_PAYLOAD_COMMIT1 = {
  owner: 'acme-org',
  repo: 'payment-gateway',
  prNumber: 42,
  headSha: 'a1b2c3d4e5f60000000000000000000000000001',
  baseSha: '0000000000000000000000000000000000000000',
  title: 'feat: add payment processing endpoint',
  body: 'Initial draft implementation.',
  changedFiles: [
    {
      path: 'src/auth/jwt.ts',
      content: 'export function parse(input) { return eval(input); }',
      patch: '@@ -0,0 +1,1 @@\n+export function parse(input) { return eval(input); }',
    },
  ],
  hunks: [
    {
      filePath: 'src/auth/jwt.ts',
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      hunkContent: '+export function parse(input) { return eval(input); }',
    },
  ],
};
```

---

## 4. Edge Cases & Boundary Handling

1. **Empty / Binary File Diffs**:
   - PRs containing binary images or empty files (`.gitkeep`) should skip persona LLM analysis gracefully and return empty findings.
2. **Extremely Large Diffs**:
   - Diffs exceeding model token capacity must be truncated safely per file/hunk before passing to `omniRouteAdapter`.
3. **Markdown Code Block Delimiters in Persona Output**:
   - LLMs often enclose JSON in ` ```json ... ``` `. Persona response parsers must strip backticks prior to `JSON.parse()`.
4. **Conflicting Persona Decisions**:
   - If Security requests changes while Quality approves, the consensus aggregator MUST enforce `REQUEST_CHANGES` because severity `critical` / `major` overrides approvals.
5. **Partial Persona Omniroute Failures**:
   - If 1 persona out of 4 fails due to provider rate limit (429) or network timeout, consensus aggregator evaluates remaining 3 personas and flags persona failure in metadata stats without breaking overall review generation.

---

## 5. Verification & Acceptance Criteria

To pass Milestone 3 gate verification, Worker implementation MUST satisfy:

1. **Compilation Gate**:
   ```bash
   npm run build
   ```
   Must execute `tsc` with **0 errors**.

2. **Test Suite Pass Gate**:
   ```bash
   npm test
   ```
   Must pass **100%** of tests in `tests/unit/quorum.test.ts`, `tests/unit/consensus.test.ts`, and `tests/integration/m3_quorum.test.ts` alongside all existing test files.

3. **Forensic Integrity**:
   - Zero facade/stub code in `src/quorum/`.
   - Genuine fan-out execution via `omniRouteAdapter`.
   - Comprehensive integration with `ticketValidator`, `constitutionEngine`, and `diffStateManager`.

---

## 6. Step-by-Step Testing Recommendations for Worker

1. **Step 1**: Implement/verify `src/quorum/consensus.ts` and test with `tests/unit/consensus.test.ts`. Verify decision matrix rules, deduplication, nit filtering, and Markdown formatting.
2. **Step 2**: Implement/verify `src/quorum/mefEngine.ts` and personas (`src/quorum/personas/`), test with `tests/unit/quorum.test.ts`. Verify fan-out, effort levels, and partial failure handling.
3. **Step 3**: Build `tests/integration/m3_quorum.test.ts` combining ticket validation, constitution compliance, diff state persistence, and mock OmniRoute fan-out.
4. **Step 4**: Run `npm run build` and `npm test` to verify complete workspace health.
