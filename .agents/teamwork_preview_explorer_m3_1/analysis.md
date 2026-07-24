# Milestone 3 Technical Architecture Blueprint & Analysis Report

**Author**: Explorer 1 (`teamwork_preview_explorer_m3_1`)  
**Target Milestone**: Milestone 3 — Quorum Review Panel Engine  
**Project Root**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`  
**Working Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m3_1`  
**Date**: 2026-07-24  

---

## 1. Executive Summary & Scope Alignment

Milestone 3 (Quorum Review Panel Engine) implements the multi-agent code analysis pipeline for `ct-review-bot`. It takes incoming Pull Request payloads and diffs, executes 4 specialized expert personas in parallel via `omniRouteAdapter`, processes findings through incremental diff state tracking (`diffStateManager`), enforces ticket linkage (`ticketValidator`) and constitution rules (`constitutionEngine`), and synthesizes the final consensus decision (`APPROVE`, `REQUEST_CHANGES`, or `COMMENT`) alongside formatted Markdown output for GitHub comments.

This analysis blueprint provides explicit specifications, interface contracts, prompt engineering templates, error isolation strategies, and step-by-step implementation instructions for the Worker agent.

---

## 2. Architecture Blueprint & System Data Flow

```
                                  ┌───────────────────────────────────────────────────────────┐
                                  │                  Incoming GitHub PR Event                 │
                                  └─────────────────────────────┬─────────────────────────────┘
                                                                │
                                                                ▼
                                  ┌───────────────────────────────────────────────────────────┐
                                  │       ticketValidator & constitutionEngine Checks         │
                                  └─────────────────────────────┬─────────────────────────────┘
                                                                │
                                                                ▼
                                  ┌───────────────────────────────────────────────────────────┐
                                  │      diffStateManager.processPRCommitUpdate (Hunks)       │
                                  └─────────────────────────────┬─────────────────────────────┘
                                                                │
                                                                ▼
                                  ┌───────────────────────────────────────────────────────────┐
                                  │          mefEngine (Multi-Agent Fan-Out Orchestrator)     │
                                  └───────┬────────────────┬─────────────────┬────────────────┘
                                          │                │                 │
                      ┌───────────────────┴───┐ ┌──────────┴────────┐ ┌──────┴──────────┐ ┌───────────────────┐
                      │    securityPersona    │ │    archPersona    │ │   perfPersona   │ │  qualityPersona   │
                      └───────────────────┬───┘ └──────────┬────────┘ └──────┬──────────┘ └───────────────────┘
                                          │                │                 │                      │
                                          └────────────────┼─────────────────┴──────────────────────┘
                                                           │ (LLM Request per Persona via omniRouteAdapter)
                                                           ▼
                                  ┌───────────────────────────────────────────────────────────┐
                                  │            omniRouteAdapter / ProviderPool                │
                                  │  (Quota reservation, Token refresh, Provider failover)    │
                                  └─────────────────────────────┬─────────────────────────────┘
                                                                │
                                                                ▼
                                  ┌───────────────────────────────────────────────────────────┐
                                  │               Consensus Aggregator Engine                 │
                                  │          (evaluateQuorum & Deduplication)                 │
                                  └─────────────────────────────┬─────────────────────────────┘
                                                                │
                                                                ▼
                                  ┌───────────────────────────────────────────────────────────┐
                                  │      diffStateManager.processPRCommitUpdate (Findings)    │
                                  │           (Fingerprint hashing & resolution)              │
                                  └─────────────────────────────┬─────────────────────────────┘
                                                                │
                                                                ▼
                                  ┌───────────────────────────────────────────────────────────┐
                                  │          QuorumResult & Formatted Summary Markdown        │
                                  └───────────────────────────────────────────────────────────┘
```

---

## 3. Multi-Agent Fan-Out Fan-In Orchestrator (`src/quorum/mefEngine.ts`)

### 3.1 Responsibilities
1. Receive PR diff hunks/files, configuration (`CtReviewConfig`), and optional persona effort overrides.
2. Determine which active personas are enabled in `config.quorum.personas` (`security`, `architecture`, `performance`, `quality`).
3. Construct persona-specific prompts using dedicated persona modules.
4. Execute LLM requests concurrently using `Promise.allSettled` to prevent one persona failure/timeout from crashing the pipeline.
5. Enforce per-persona timeout limits (e.g. 30,000 ms) via `Promise.race`.
6. Map effort levels per persona (overrides > YAML config > global default).
7. Collect, validate, and parse raw LLM JSON outputs into structured `PersonaFinding[]`.

### 3.2 Interface Specifications (`src/quorum/mefEngine.ts`)

```typescript
import { Persona, EffortLevel, CtReviewConfig } from '../config/schema';
import { OmniRouteAdapter } from '../router/omniRouteAdapter';

export interface PRDiffFile {
  filePath: string;
  patch: string;
  oldPath?: string;
  newPath?: string;
}

export interface QuorumReviewContext {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  prTitle: string;
  prBody: string;
  diffFiles: PRDiffFile[];
}

export interface PersonaFinding {
  persona: Persona;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  filePath: string;
  lineNumber: number;
  comment: string;
  suggestion?: string;
  ruleId?: string;
  codeSnippet?: string;
}

export interface mefEngineOptions {
  config: CtReviewConfig;
  router: OmniRouteAdapter;
  personaEffortOverrides?: Partial<Record<Persona, EffortLevel>>;
  timeoutMsPerPersona?: number; // Default: 30000ms
}

export interface PersonaExecutionResult {
  persona: Persona;
  success: boolean;
  findings: PersonaFinding[];
  rawResponse?: string;
  tokensUsed?: { prompt: number; completion: number; total: number };
  providerUsed?: string;
  modelUsed?: string;
  executionTimeMs: number;
  error?: string;
}

export interface mefEngineResult {
  personaResults: Record<string, PersonaExecutionResult>;
  allFindings: PersonaFinding[];
  stats: {
    totalPersonasConfigured: number;
    personasExecuted: Persona[];
    personasFailed: Persona[];
    totalTokensUsed: number;
    totalExecutionTimeMs: number;
  };
}
```

### 3.3 Core Execution Flow Pseudocode

```typescript
export async function executeQuorumFanOut(
  context: QuorumReviewContext,
  options: mefEngineOptions
): Promise<mefEngineResult> {
  const startTime = Date.now();
  const configuredPersonas = options.config.quorum.personas || ['security', 'architecture', 'performance', 'quality'];
  const globalEffort = options.config.quorum.effortLevel || 'medium';
  const timeoutMs = options.timeoutMsPerPersona || 30000;

  const personaTasks = configuredPersonas.map(async (persona) => {
    const pStartTime = Date.now();
    const effortLevel = options.personaEffortOverrides?.[persona] || globalEffort;

    // Get persona runner module
    const runner = getPersonaRunner(persona);
    const systemPrompt = runner.getSystemPrompt();
    const userPrompt = runner.buildUserPrompt(context);

    // Timeout Promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Persona ${persona} timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    // LLM Execution Promise via omniRouteAdapter
    const llmPromise = options.router.complete({
      persona,
      effortLevel,
      prompt: userPrompt,
      systemPrompt,
    });

    try {
      const llmRes = await Promise.race([llmPromise, timeoutPromise]);
      const findings = runner.parseResponse(llmRes.content, context);

      return {
        persona,
        success: true,
        findings,
        rawResponse: llmRes.content,
        tokensUsed: llmRes.tokensUsed,
        providerUsed: llmRes.providerUsed,
        modelUsed: llmRes.modelUsed,
        executionTimeMs: Date.now() - pStartTime,
      } as PersonaExecutionResult;
    } catch (err: any) {
      return {
        persona,
        success: false,
        findings: [],
        executionTimeMs: Date.now() - pStartTime,
        error: err.message || String(err),
      } as PersonaExecutionResult;
    }
  });

  const results = await Promise.allSettled(personaTasks);

  const personaResults: Record<string, PersonaExecutionResult> = {};
  const allFindings: PersonaFinding[] = [];
  const personasExecuted: Persona[] = [];
  const personasFailed: Persona[] = [];
  let totalTokens = 0;

  results.forEach((res, index) => {
    const persona = configuredPersonas[index];
    if (res.status === 'fulfilled') {
      const pResult = res.value;
      personaResults[persona] = pResult;
      if (pResult.success) {
        personasExecuted.push(persona);
        allFindings.push(...pResult.findings);
        if (pResult.tokensUsed) {
          totalTokens += pResult.tokensUsed.total;
        }
      } else {
        personasFailed.push(persona);
      }
    } else {
      personasFailed.push(persona);
      personaResults[persona] = {
        persona,
        success: false,
        findings: [],
        executionTimeMs: Date.now() - startTime,
        error: res.reason?.message || 'Unhandled promise rejection',
      };
    }
  });

  return {
    personaResults,
    allFindings,
    stats: {
      totalPersonasConfigured: configuredPersonas.length,
      personasExecuted,
      personasFailed,
      totalTokensUsed: totalTokens,
      totalExecutionTimeMs: Date.now() - startTime,
    },
  };
}
```

---

## 4. Persona Module Specifications (`src/quorum/personas/`)

Each persona is implemented in its own module inside `src/quorum/personas/`:
- `securityPersona.ts`
- `archPersona.ts`
- `perfPersona.ts`
- `qualityPersona.ts`

### 4.1 Persona Base Contract (`src/quorum/personas/basePersona.ts`)

```typescript
import { Persona } from '../../config/schema';
import { PersonaFinding, QuorumReviewContext } from '../mefEngine';

export interface IPersonaRunner {
  persona: Persona;
  getSystemPrompt(): string;
  buildUserPrompt(context: QuorumReviewContext): string;
  parseResponse(rawContent: string, context: QuorumReviewContext): PersonaFinding[];
}
```

### 4.2 Response Parsing Helper (`src/quorum/personas/parseHelper.ts`)
To make parsing robust against variations in LLM outputs (e.g. markdown code blocks, stray text outside JSON arrays, trailing commas):

```typescript
export function extractAndParseJSONFindings(
  rawContent: string,
  persona: Persona
): PersonaFinding[] {
  if (!rawContent || typeof rawContent !== 'string') return [];

  let jsonText = rawContent.trim();

  // Try extracting markdown json code block
  const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch) {
    jsonText = codeBlockMatch[1].trim();
  } else {
    // Attempt finding first '[' and last ']'
    const firstBracket = jsonText.indexOf('[');
    const lastBracket = jsonText.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      jsonText = jsonText.substring(firstBracket, lastBracket + 1);
    }
  }

  try {
    const rawList = JSON.parse(jsonText);
    if (!Array.isArray(rawList)) return [];

    return rawList
      .map((item: any) => {
        if (!item || typeof item !== 'object') return null;
        
        const severity = ['critical', 'major', 'minor', 'nit'].includes(item.severity)
          ? item.severity
          : 'minor';

        return {
          persona,
          severity,
          filePath: String(item.filePath || 'unknown'),
          lineNumber: typeof item.lineNumber === 'number' ? item.lineNumber : 1,
          comment: String(item.comment || '').trim(),
          suggestion: item.suggestion ? String(item.suggestion).trim() : undefined,
          ruleId: item.ruleId ? String(item.ruleId).trim() : undefined,
          codeSnippet: item.codeSnippet ? String(item.codeSnippet).trim() : undefined,
        } as PersonaFinding;
      })
      .filter((f): f is PersonaFinding => f !== null && f.comment.length > 0);
  } catch (err) {
    return [];
  }
}
```

---

### 4.3 Detailed Specifications per Persona

#### 4.3.1 `securityPersona.ts`
- **Domain Focus**: Vulnerabilities (OWASP Top 10), secret exposure (API tokens, private keys, hardcoded JWTs), injection attacks (SQLi, Command Injection, XSS), unsafe deserialization, authentication/authorization gaps, weak cryptography.
- **Default Recommended Effort**: `high` or `reasoning`.
- **System Prompt**:
  ```
  You are a Senior Security Auditor specializing in enterprise code security analysis.
  Analyze the provided PR diff for security vulnerabilities, OWASP Top 10 risks, hardcoded credentials, injection flaws, authentication errors, and memory safety issues.
  Output ONLY a JSON array of findings matching this exact schema:
  [
    {
      "filePath": "string",
      "lineNumber": number,
      "severity": "critical" | "major" | "minor" | "nit",
      "comment": "string describing the vulnerability",
      "suggestion": "string detailing remediation code/fix",
      "ruleId": "SEC-xxx"
    }
  ]
  Do not include any conversational preamble or markdown explanations outside the JSON array.
  ```

#### 4.3.2 `archPersona.ts`
- **Domain Focus**: Architectural design, boundary violations, circular dependencies, breaking public API changes, tight coupling, violation of separation of concerns, scalability risks.
- **Default Recommended Effort**: `medium` or `high`.
- **System Prompt**:
  ```
  You are a Principal Software Architect evaluating codebase design, modularity, and API design.
  Analyze the provided PR diff for architectural regressions, broken component boundaries, API breaking changes, circular dependencies, and tight coupling.
  Output ONLY a JSON array of findings matching this exact schema:
  [
    {
      "filePath": "string",
      "lineNumber": number,
      "severity": "critical" | "major" | "minor" | "nit",
      "comment": "string describing architectural issue",
      "suggestion": "string detailing refactoring recommendation",
      "ruleId": "ARCH-xxx"
    }
  ]
  Do not include any conversational preamble or markdown explanations outside the JSON array.
  ```

#### 4.3.3 `perfPersona.ts`
- **Domain Focus**: Time/space complexity (N+1 query loops, O(N^2) inner loops), synchronous I/O on async event loops, memory leaks, unindexed queries, redundant allocations.
- **Default Recommended Effort**: `medium` or `high`.
- **System Prompt**:
  ```
  You are a Performance Optimization Engineer analyzing runtime speed, memory usage, and concurrency.
  Analyze the provided PR diff for efficiency bottlenecks, N+1 query patterns, unthrottled loop allocations, memory leaks, and blocking synchronous operations.
  Output ONLY a JSON array of findings matching this exact schema:
  [
    {
      "filePath": "string",
      "lineNumber": number,
      "severity": "critical" | "major" | "minor" | "nit",
      "comment": "string describing performance issue",
      "suggestion": "string detailing performance fix",
      "ruleId": "PERF-xxx"
    }
  ]
  Do not include any conversational preamble or markdown explanations outside the JSON array.
  ```

#### 4.3.4 `qualityPersona.ts`
- **Domain Focus**: Code readability, maintainability, error handling gaps, missing unit test coverage, non-idiomatic style, code duplication, nitpicks.
- **Default Recommended Effort**: `low` or `medium`.
- **System Prompt**:
  ```
  You are a Senior Code Quality Lead focusing on code readability, error handling, maintainability, and test coverage.
  Analyze the provided PR diff for unhandled exceptions, dead code, poor variable naming, lack of test assertions, and style nits.
  Output ONLY a JSON array of findings matching this exact schema:
  [
    {
      "filePath": "string",
      "lineNumber": number,
      "severity": "critical" | "major" | "minor" | "nit",
      "comment": "string describing code quality issue",
      "suggestion": "string detailing quality improvement",
      "ruleId": "QUAL-xxx"
    }
  ]
  Do not include any conversational preamble or markdown explanations outside the JSON array.
  ```

---

## 5. Consensus Aggregator & State Integration (`src/quorum/consensus.ts`)

### 5.1 Responsibilities
1. Evaluate quorum voting decision using `evaluateQuorum()` (`src/quorum/quorumEngine.ts`).
2. Integrate `diffStateManager` to register incoming findings, separate active findings vs suppressed nits / resolved issues.
3. Integrate `ticketValidator` and `constitutionEngine` results.
4. Render GitHub PR Summary Markdown with formatted status tables, decision badges, and inline review suggestions.

### 5.2 Interface Contract (`src/quorum/consensus.ts`)

```typescript
import { CtReviewConfig } from '../config/schema';
import { PersonaFinding, mefEngineResult } from './mefEngine';
import { TicketValidationResult } from '../ticket/ticketValidator';
import { ConstitutionEvaluationResult } from '../constitution/constitutionEngine';
import { DiffStateManager, ProcessPRUpdateResult } from '../persistence/diffStateManager';

export interface QuorumConsensusInput {
  mefResult: mefEngineResult;
  ticketResult: TicketValidationResult;
  constitutionResult: ConstitutionEvaluationResult;
  diffStateResult?: ProcessPRUpdateResult;
  config: CtReviewConfig;
}

export interface QuorumConsensusOutput {
  summary: string;
  decision: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  approvingPersonas: string[];
  requestingChangesPersonas: string[];
  activeFindings: PersonaFinding[];
  filteredNits: PersonaFinding[];
  ticketValidation: TicketValidationResult;
  constitutionCompliance: ConstitutionEvaluationResult;
  formattedMarkdown: string;
  stats: {
    totalFindings: number;
    activeFindingsCount: number;
    filteredNitsCount: number;
    personasExecuted: string[];
    personasFailed: string[];
    tokensUsed: number;
  };
}
```

### 5.3 Verdict & Decision Logic

```typescript
export function aggregateQuorumConsensus(input: QuorumConsensusInput): QuorumConsensusOutput {
  const { mefResult, ticketResult, constitutionResult, config } = input;
  const minApprovals = config.quorum.minApprovals || 2;
  const configuredPersonas = config.quorum.personas || ['security', 'architecture', 'performance', 'quality'];

  // Map persona findings per persona
  const personaFindings: Record<string, PersonaFinding[]> = {};
  for (const p of configuredPersonas) {
    personaFindings[p] = mefResult.allFindings.filter((f) => f.persona === p);
  }

  // Use quorumEngine core evaluation
  const evalResult = evaluateQuorum({
    minApprovals,
    configuredPersonas,
    personaFindings,
  });

  // Calculate verdict overrides:
  // REQUEST_CHANGES if ticket validation fails in strict mode OR constitution rules violated
  let finalDecision = evalResult.decision;
  if (!ticketResult.valid && ticketResult.mode === 'strict') {
    finalDecision = 'REQUEST_CHANGES';
  }
  if (!constitutionResult.compliant) {
    finalDecision = 'REQUEST_CHANGES';
  }

  const formattedMarkdown = buildPRSummaryMarkdown({
    decision: finalDecision,
    evalResult,
    ticketResult,
    constitutionResult,
    mefResult,
  });

  return {
    summary: `Quorum review evaluation completed with decision: ${finalDecision}`,
    decision: finalDecision,
    approvingPersonas: evalResult.approvingPersonas,
    requestingChangesPersonas: evalResult.requestingChangesPersonas,
    activeFindings: evalResult.activeFindings,
    filteredNits: evalResult.filteredNits,
    ticketValidation: ticketResult,
    constitutionCompliance: constitutionResult,
    formattedMarkdown,
    stats: {
      totalFindings: mefResult.allFindings.length,
      activeFindingsCount: evalResult.activeFindings.length,
      filteredNitsCount: evalResult.filteredNits.length,
      personasExecuted: mefResult.stats.personasExecuted,
      personasFailed: mefResult.stats.personasFailed,
      tokensUsed: mefResult.stats.totalTokensUsed,
    },
  };
}
```

---

## 6. PR Summary Markdown Template Design

```markdown
## 🤖 ct-review-bot Quorum Review Summary

### Verdict: **${decisionBadge}**

| Persona | Status | Active Findings | Nits Filtered |
|---|---|:---:|:---:|
| 🛡️ Security | ${securityStatus} | ${secCount} | ${secNits} |
| 🏗️ Architecture | ${archStatus} | ${archCount} | ${archNits} |
| ⚡ Performance | ${perfStatus} | ${perfCount} | ${perfNits} |
| 🧹 Code Quality | ${qualityStatus} | ${qualCount} | ${qualNits} |

---

### 📋 Governance & Policy Checks
- **Ticket Linkage**: ${ticketStatusIcon} ${ticketMessage}
- **Constitution Compliance**: ${constitutionStatusIcon} ${constitutionMessage}

---

### ⚠️ Key Active Findings (${activeFindingsCount})
${activeFindingsTableOrList}

<details>
<summary>💡 Suppressed Nits & Minor Style Notes (${nitsCount})</summary>
${nitsTableOrList}
</details>

---
*Reviewed via OmniRoute LLM Engine • Effort Level: ${effortLevel}*
```

---

## 7. Error Handling & Fault Tolerance Strategy

1. **Partial Persona Failures**:
   - If 1 out of 4 personas fails (e.g. rate limit, network glitch, timeout), `mefEngine` captures the error in `personaResults[persona]` with `success: false`.
   - Remaining personas evaluate normally.
   - If remaining approving personas satisfy `minApprovals`, and no `critical`/`major` active findings are raised by successful personas, the decision can still be `APPROVE`. If failed personas reduce active persona count below `minApprovals`, the decision defaults safely to `REQUEST_CHANGES`.

2. **Malformed LLM Output**:
   - `extractAndParseJSONFindings` employs a 3-layer fallback parser:
     1. Direct `JSON.parse()` on raw response.
     2. Regex extraction of ```json ... ``` codeblocks.
     3. Substring extraction between first `[` and last `]`.
   - If all 3 layers fail, returns empty array `[]` rather than throwing, preventing unhandled crash.

3. **Diff State Resilience**:
   - SHA-256 fingerprint hashing tracks findings across commit SHAs.
   - `RESOLVED` findings stay suppressed unless a `critical` finding re-occurs, triggering auto re-open (`IDENTIFIED`).

---

## 8. Step-by-Step Implementation Recommendations for Worker

### Phase 1: Create Persona Modules (`src/quorum/personas/`)
1. Create `src/quorum/personas/parseHelper.ts` with `extractAndParseJSONFindings()`.
2. Create `src/quorum/personas/basePersona.ts`.
3. Implement:
   - `securityPersona.ts`
   - `archPersona.ts`
   - `perfPersona.ts`
   - `qualityPersona.ts`

### Phase 2: Implement Orchestrator (`src/quorum/mefEngine.ts`)
1. Export `executeQuorumFanOut()` supporting `Promise.allSettled` and per-persona timeout control.
2. Connect `omniRouteAdapter.complete()` for persona execution.

### Phase 3: Implement Consensus Aggregator (`src/quorum/consensus.ts`)
1. Export `aggregateQuorumConsensus()`.
2. Integrate `evaluateQuorum()` from `src/quorum/quorumEngine.ts`.
3. Integrate `diffStateManager`, `ticketValidator`, and `constitutionEngine`.
4. Implement Markdown summary renderer.

### Phase 4: Create Comprehensive Unit Tests
1. `tests/unit/quorum.test.ts`: Verify `mefEngine` fan-out, persona execution, timeout handling, partial persona failures.
2. `tests/unit/consensus.test.ts`: Verify consensus aggregation, threshold boundary conditions, Markdown formatting, ticket & constitution merging.

### Phase 5: Verification & Gate Checks
1. `npm run build`: Verify 0 TypeScript compilation errors.
2. `npm test`: Run full Vitest suite (including existing M1 and M2 tests + new M3 tests).

---

## 9. Conclusion

This blueprint details the complete design, interfaces, prompts, fault-tolerance mechanisms, and consensus aggregation for Milestone 3. The specifications align 100% with the existing `omniRouteAdapter`, `diffStateManager`, `ticketValidator`, and `constitutionEngine` contracts.

Worker can proceed immediately with implementation following the phase-by-phase recommendation.
