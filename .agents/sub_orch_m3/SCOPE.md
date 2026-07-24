# Scope: Milestone 3 — Quorum Review Panel Engine

## Architecture & Responsibilities
Milestone 3 implements the Quorum Review Panel Engine (`src/quorum/`), orchestrating multi-agent persona analysis, consensus aggregation, diff delta filtering, ticket linkage integration, and constitution compliance checking.

```
                         ┌────────────────────────────────────┐
                         │   Input: PR Payload, Diff, Config  │
                         └─────────────────┬──────────────────┘
                                           │
                                           ▼
                         ┌────────────────────────────────────┐
                         │      Ticket & Constitution Checks  │
                         │(ticketValidator & constitutionEngine)│
                         └─────────────────┬──────────────────┘
                                           │
                                           ▼
                         ┌────────────────────────────────────┐
                         │      Incremental Diff Delta Filter │
                         │        (diffStateManager)          │
                         └─────────────────┬──────────────────┘
                                           │
                                           ▼
                         ┌────────────────────────────────────┐
                         │        Quorum Fan-Out Engine       │
                         │          (mefEngine.ts)            │
                         └───────┬───────┬────────┬───────────┘
                                 │       │        │
             ┌───────────────────┴─┐ ┌───┴────┐ ┌─┴──────────┐ ┌──────────────┐
             │Security Persona     │ │Arch    │ │Perf        │ │Quality/Nits  │
             │(securityPersona.ts) │ │Persona │ │Persona     │ │Persona       │
             └───────────────────┬─┘ └───┬────┘ └─┬──────────┘ └──────────────┘
                                 │       │        │                  │
                                 └───────┼────────┴──────────────────┘
                                         │  (omniRouteAdapter calls)
                                         ▼
                         ┌────────────────────────────────────┐
                         │       Quorum Consensus Engine      │
                         │          (consensus.ts)            │
                         └─────────────────┬──────────────────┘
                                           │
                                           ▼
                         ┌────────────────────────────────────┐
                         │    QuorumResult Output & Markdown  │
                         └────────────────────────────────────┘
```

## Detailed Work Items
1. **Quorum Engine / Multi-Agent Fan-Out Fan-In (`src/quorum/mefEngine.ts`)**:
   - Executes parallel persona reviews across enabled active personas (`security`, `architecture`, `performance`, `quality`).
   - Translates PR payload + diff into structured persona prompts.
   - Invokes `omniRouteAdapter` for each persona with specified model effort configuration (`low`, `medium`, `high`, `reasoning`).
   - Gathers persona outputs, handles partial failures / timeouts gracefully per persona.
2. **Personas (`src/quorum/personas/`)**:
   - `securityPersona.ts`: Security vulnerabilities, secret leaks, injection risks, auth flaws.
   - `archPersona.ts`: Architectural design, module boundaries, design patterns, separation of concerns.
   - `perfPersona.ts`: Algorithm complexity, memory leaks, database query performance, sync/async blocking.
   - `qualityPersona.ts`: Code readability, style, testability, nitpicks, refactoring.
   - Support model effort configuration per persona.
3. **Consensus Aggregator (`src/quorum/consensus.ts`)**:
   - Aggregates findings from all personas.
   - Resolves overlapping or duplicate findings across personas.
   - Determines final PR verdict: `APPROVE`, `REQUEST_CHANGES`, or `COMMENT` based on findings severity and config rules (e.g. `minApprovals`, critical/major findings trigger `REQUEST_CHANGES`).
   - Formats comprehensive PR review summary markdown (including summary table, persona breakdown, inline comment recommendations, ticket linkage status, constitution compliance status).
4. **Incremental Diff Delta Filtering Integration**:
   - Integrates `diffStateManager` to compare newly identified findings against stored SHA-256 fingerprint hashes across commit SHAs.
   - Filters out / skips previously resolved nits & PXs so existing resolved issues are not re-flagged.
   - Records new active findings in `diffStateManager`.
5. **Ticket Linkage & Constitution Compliance Integration**:
   - Integrates `ticketValidator` output (`valid`, `ticketsFound`, `error`).
   - Integrates `constitutionEngine` output (`compliant`, `violations`).
   - Merges ticket and constitution check results directly into `QuorumResult` and summary markdown output.
6. **Testing & Verification**:
   - Unit tests: `tests/unit/quorum.test.ts`, `tests/unit/consensus.test.ts`.
   - Integration tests: `tests/integration/m3_quorum.test.ts`.
   - Ensure 0 build errors (`npm run build`) and 100% test pass (`npm test`).

## Interface Contracts (Global alignment)
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
  ticketValidation: { valid: boolean; ticketsFound: string[]; error?: string };
  constitutionCompliance: { compliant: boolean; violations: string[] };
  formattedMarkdown: string;
  stats: {
    totalFindings: number;
    filteredFindings: number;
    personasExecuted: string[];
    tokensUsed: number;
  };
}
```

## Milestone Status
| Step | Task | Status |
|------|------|--------|
| 1 | Explorer Analysis & Technical Blueprint | IN_PROGRESS |
| 2 | Worker Implementation & Tests | PLANNED |
| 3 | Reviewer Verification | PLANNED |
| 4 | Challenger Empirical Stress Verification | PLANNED |
| 5 | Forensic Auditor Verification | PLANNED |
