# Adversarial Challenge Report — Milestone 1

**Target Component**: Milestone 1 (Config Parser, Ticket Linkage Engine, Constitution Engine)  
**Assessor**: Challenger 1 (EMPIRICAL CHALLENGER)  
**Date**: 2026-07-24  
**Verdict**: **FAIL** (7 Critical/High implementation defects found in Ticket Linkage and Constitution Engines; `npm test` baseline failure)

---

## Executive Summary

Empirical stress testing of Milestone 1 revealed that while the **Config Parser** is robust against schema type mismatches and malformed YAML inputs, both the **Ticket Linkage Engine** and **Constitution Engine** suffer from severe logic flaws, rigid regex constraints, and incomplete rule evaluation logic that cause false negatives and allow non-compliant PRs to pass undetected. Furthermore, running `npm test` out-of-the-box fails due to alias resolution issues in `vitest.config.ts`.

Out of **21 stress test scenarios** executed:
- **Passed**: 14
- **Failed**: 7

---

## Baseline Test Execution Findings

- **Command**: `npm test` (`vitest run`)
- **Status**: **FAILED**
- **Error**: `Error: Failed to load url @harness/e2eTestRunner (resolved id: @harness/e2eTestRunner) in tests/e2e/tier1/quorum.test.ts`
- **Root Cause**: `vitest.config.ts` includes `tests/**/*.test.ts` (which includes E2E test files), but does not define `resolve.alias` for `@harness` and `@src`. The alias configuration only exists in `vitest.config.e2e.ts`.
- **Unit/Integration Subset**: `npx vitest run tests/unit tests/integration` passed 47 unit/integration baseline tests (though with fallback warning for SQLite).

---

## Detailed Challenges & Vulnerabilities Found

### [HIGH] Challenge 1: Ticket Engine ignores lowercase ticket keys (e.g., `proj-123`, `key-456`)

- **File & Line**: `src/ticket/ticketValidator.ts`, lines 17–18
- **Assumption Challenged**: Developers and Git branches always use uppercase characters for Jira/Linear ticket keys.
- **Attack Scenario**: A developer creates a PR from a branch named `fix/proj-123-bug` or titles a PR `fix: proj-123 resolve race condition`.
- **Actual Behavior**: The regex patterns `LINEAR` and `JIRA` match only uppercase letter ranges `[A-Z]` and lack the `/i` case-insensitive flag. Lowercase ticket references are ignored (`ticketsFound` returns `[]`).
- **Blast Radius**: Valid PRs with lowercase ticket references are falsely rejected in strict mode.
- **Mitigation**: Add case-insensitive flag `/i` or `[A-Za-z]` character ranges to `LINEAR` and `JIRA` regexes in `TICKET_PATTERNS`.

### [HIGH] Challenge 2: GitHub issue pattern fails when enclosed in parentheses `(#789)` or brackets `[#789]`

- **File & Line**: `src/ticket/ticketValidator.ts`, line 19
- **Assumption Challenged**: Issue references `#123` are always preceded by a space or start of line.
- **Attack Scenario**: Standard PR title conventions like `fix: security vulnerability (#789)` or `[#789] update dependency` are submitted.
- **Actual Behavior**: The GitHub regex `/(?:^|\s)(?:#(\d+)...)/` requires `^` or `\s` before `#`. Since `(` or `[` is neither start-of-line nor whitespace, matching fails and `#789` is missed (`ticketsFound` returns `[]`).
- **Blast Radius**: Valid GitHub issue linkages are falsely missed in strict enforcement mode.
- **Mitigation**: Update GitHub regex prefix matching to allow non-word boundaries or delimiters like `(`, `[`, `:`, e.g., `(?:^|[\s(\[:])`.

### [MEDIUM] Challenge 3: Linear and Jira project keys with >10 characters are truncated/missed

- **File & Line**: `src/ticket/ticketValidator.ts`, lines 17–18
- **Assumption Challenged**: Ticket project prefixes never exceed 10 characters in length.
- **Attack Scenario**: A team uses a project key longer than 10 chars, such as `SUPERLONGPREFIXNAME-123`.
- **Actual Behavior**: Quantifiers `[A-Z]{2,10}` and `[A-Z0-9_]{1,10}` reject project keys with more than 10 characters.
- **Blast Radius**: Enterprise projects with long ticket prefixes cannot be validated.
- **Mitigation**: Increase upper bound of prefix quantifier or remove arbitrary upper limit, e.g., `[A-Z]{2,32}`.

### [HIGH] Challenge 4: Constitution Engine fails to parse regex rules containing escaped slashes `` `/\/api\/v1\//` ``

- **File & Line**: `src/constitution/constitutionEngine.ts`, line 81
- **Assumption Challenged**: Regex rules inside backticks never contain forward slashes `/`.
- **Attack Scenario**: A team defines a rule in `constitution.md`: `- Do not call v1 API \`/\/api\/v1\//\``.
- **Actual Behavior**: The extractor regex `match(/`\/([^/]+)\/([gimsuy]*)`/` uses `[^/]+`, which terminates at the first forward slash `/` even if preceded by `\`. Extraction fails and `pattern` becomes `undefined`.
- **Blast Radius**: Path-based or slash-containing forbidden patterns fail to compile, leaving critical route restrictions unenforced.
- **Mitigation**: Use proper regex literal parser or escaped-slash handling: `/`\/((?:\\\/|[^\/])+)\/([gimsuy]*)/`.

### [CRITICAL] Challenge 5: Constitution Engine completely ignores non-regex forbidden rules (except hardcoded `console.log`)

- **File & Line**: `src/constitution/constitutionEngine.ts`, lines 128–138
- **Assumption Challenged**: Non-regex forbidden rules are checked against PR content via keyword search.
- **Attack Scenario**: A constitution file specifies forbidden rules without explicit backtick regexes, e.g.:
  - `- Never use eval in code`
  - `- Prohibit hardcoded JWT secrets`
- **Actual Behavior**: `evaluateConstitution` contains a hardcoded fallback that ONLY checks `if (lowerDesc.includes('console.log') ...)`. Any other natural language or non-regex forbidden rule is ignored completely. `compliant` returns `true`.
- **Blast Radius**: Security rules written in natural markdown without `/regex/` backticks provide zero protection.
- **Mitigation**: Implement general keyword/phrase extraction or mandatory pattern extraction for all forbidden rules.

### [HIGH] Challenge 6: Constitution Engine directive evaluation requires hardcoded magic phrases

- **File & Line**: `src/constitution/constitutionEngine.ts`, lines 139–146
- **Assumption Challenged**: Directive rules in constitution files are generally evaluated against PR metadata.
- **Attack Scenario**: A team writes a directive rule in `constitution.md`:
  - `- Every pull request must include unit test coverage`
  - `- Mandatory PR summary required`
- **Actual Behavior**: `evaluateConstitution` only triggers if the rule description contains one of three exact hardcoded substrings: `'pr description must contain'`, `'requires description'`, or `'pr description is required'`. All other directives are silently ignored.
- **Blast Radius**: Custom organizational directives are never checked or enforced.
- **Mitigation**: Implement flexible condition evaluation or structured directive criteria.

---

## Empirical Stress Test Execution Matrix

Below are the results from running `.agents/teamwork_preview_challenger_m1_1/run_stress_tests.ts`:

| Scenario ID | Test Description | Expected Result | Actual Result | Status |
|-------------|------------------|-----------------|---------------|--------|
| `CFG-01` | Malformed YAML syntax | Throws `ConfigValidationError` | Throws `ConfigValidationError` | **PASS** |
| `CFG-02` | YAML Array root | Handled gracefully or validates | Handled gracefully | **PASS** |
| `CFG-03` | Schema type mismatch: `minApprovals: "2"` | Throws `ConfigValidationError` | Throws `ConfigValidationError` | **PASS** |
| `CFG-04` | Schema constraint mismatch: `minApprovals: 0` | Throws `ConfigValidationError` | Throws `ConfigValidationError` | **PASS** |
| `CFG-05` | Schema constraint mismatch: `minApprovals: -1` | Throws `ConfigValidationError` | Throws `ConfigValidationError` | **PASS** |
| `CFG-06` | Invalid persona enum `hacker` | Throws `ConfigValidationError` | Throws `ConfigValidationError` | **PASS** |
| `CFG-07` | Empty personas array `[]` | Throws `ConfigValidationError` | Throws `ConfigValidationError` | **PASS** |
| `CFG-08` | Invalid ticket provider `bitbucket` | Throws `ConfigValidationError` | Throws `ConfigValidationError` | **PASS** |
| `TCK-01` | Mixed uppercase tickets (`[PROJ-123]`, `#789`) | All tickets extracted | All tickets extracted | **PASS** |
| `TCK-02` | Lowercase ticket keys (`proj-123`) | `PROJ-123` extracted | `[]` returned | **FAIL** |
| `TCK-03` | Ticket in parentheses `(#789)` | `#789` extracted | `[]` returned | **FAIL** |
| `TCK-04` | Ticket in brackets `[#789]` | `#789` extracted | `[]` returned | **FAIL** |
| `TCK-05` | Ticket inside URL (`jira.company.com/...`) | Ticket extracted | `PROJ-100` extracted | **PASS** |
| `TCK-06` | Long ticket prefix (`SUPERLONGPREFIXNAME-123`) | Ticket extracted | `[]` returned | **FAIL** |
| `TCK-07` | Invalid custom regex pattern | Graceful failure (no crash) | Graceful failure | **PASS** |
| `CST-01` | H1 heading vs section headers | Title set, rules classified | Title set, rules classified | **PASS** |
| `CST-02` | Escaped slashes in backtick regex `` `/\/api\/v1\//` `` | Pattern compiled | `pattern = undefined` | **FAIL** |
| `CST-03` | Non-regex forbidden rule (`Never use eval`) | Violation reported | `compliant: true` | **FAIL** |
| `CST-04` | Indented bullet list parsing | 2 rules extracted | 2 rules extracted | **PASS** |
| `CST-05` | General directive rule evaluation | Violation reported for short PR | No violations reported | **FAIL** |
| `CST-06` | Global regex across multiple files | 3 violations reported | 3 violations reported | **PASS** |

---

## Unchallenged / Out of Scope Areas

- **DiffStateManager & SQLite Storage**: Out of scope for Milestone 1 config/ticket/constitution review; tested briefly as part of baseline integration suite.
- **Express HTTP endpoints beyond /health**: Full HTTP review server behavior is covered in subsequent milestone evaluation.

---

## Final Recommendation

**VERDICT**: **FAIL**  
The Milestone 1 work product cannot pass adversarial review in its current state due to 7 confirmed failure modes in ticket parsing and constitution evaluation, along with an broken baseline `npm test` configuration.
