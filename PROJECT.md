# Project: Review Yeti — Modern AI PR Review Product & Interactive Dashboard

## Architecture

Review Yeti (`review-yeti-bot`) v1.103.3 provides an enterprise multi-persona AI PR code review engine and interactive dashboard benchmarked against CodeRabbit and Greptile.
The architecture comprises:
1. **Frontend**: Next.js 14 App Router (statically exported via `output: 'export'`) with Tailwind CSS, Radix UI primitives, Recharts, and custom hooks (`useSSE`).
2. **Backend**: Express.js server providing REST APIs for authentication, repositories, pull requests, live streaming (SSE), human-in-the-loop controls, and executive analytics.
3. **Review Pipeline & Multi-Persona Panel**: `panelEngine.ts` orchestrates 11 specialized reviewer personas, executes read-only analysis tools (`toolRuntime.ts`), and streams reasoning traces and tool calls.
4. **Persistence Layer**: PostgreSQL store (`postgresStore.ts`) and `dashboardStore.ts` with in-memory fallbacks, persisting review logs, gate attempts, audit trails, and repository settings.
5. **Real-time Event Streaming**: `LiveStreamBus` singleton broadcasting Server-Sent Events (`/api/live/stream`) with double-buffered batching.
6. **Downstream Gate & Check Publishing**: `ReviewGatePublisher` and `GitHubReviewGateClient` syncing authoritative review verdicts to GitHub Check Runs (`Review Yeti Gate`).

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Next.js 14 Web Frontend                         │
│  - Live Review Inspector & Streaming Reasoning Feed (/live)            │
│  - Interactive Line-Anchored Diff Viewer & Finding Cards               │
│  - Human-in-the-Loop Controls (Dismiss, Steering, Overrides)           │
│  - Executive & Engineering Analytics Dashboard (p95, Cost, Burn)       │
│  - GitHub OAuth Login & Organization / Repo Management (/repos)        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP / SSE
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          Express.js Server                             │
│  - /api/auth/github, /api/auth/session, /api/github/orgs, /repos       │
│  - /api/live/stream, /api/live/diff, /api/live/active                  │
│  - /api/reviews/:id/findings, /override, /guidance, /audit-trail       │
│  - /api/analytics/summary, /tokens, /costs, /findings (24h/7d/30d)     │
└───────────────────────┬──────────────────────────┬─────────────────────┘
                        │                          │
                        ▼                          ▼
         ┌──────────────────────────────┐   ┌─────────────────────────────┐
         │       LiveStreamBus          │   │      PostgreSQL Store       │
         │  - persona:start / complete  │   │  - review_logs, review_runs │
         │  - reasoning:chunk (live)    │   │  - review_gate_attempts     │
         │  - tool:start / result       │   │  - review_verdict_overrides │
         │  - persona:finding           │   │  - review_audit_events      │
         └──────────────┬───────────────┘   │  - review_prompt_guidance   │
                        │                   └──────────────┬──────────────┘
                        ▼                                  │
         ┌──────────────────────────────┐                  │
         │         Panel Engine         │                  │
         │  - 11 Reviewer Personas      │                  │
         │  - Read-Only Tool Execution  │                  │
         │  - Prompt Steering Guidance  │                  │
         └──────────────────────────────┘                  │
                                                           ▼
                                            ┌─────────────────────────────┐
                                            │     ReviewGatePublisher     │
                                            │  - Syncs to GitHub Check    │
                                            │    Run ("Review Yeti Gate") │
                                            └─────────────────────────────┘
```

---

## Feature Inventory

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | GitHub OAuth Initiation Route | `GET /api/auth/github` resolving OAuth client ID, generating CSRF state, and redirecting to GitHub | M1 | ORIGINAL_REQUEST R4 & Spec Miner 3 §4.1 |
| 2 | GitHub OAuth Callback Handler | `GET /api/auth/github/callback` exchanging code for access token, fetching user profile, and minting session | M1 | ORIGINAL_REQUEST R4 & Spec Miner 3 §4.1 |
| 3 | GitHub Session Introspection & Logout | `GET /api/auth/session` returning user details and role, `DELETE /api/auth/session` revoking session | M1 | ORIGINAL_REQUEST R4 & Spec Miner 3 §4.1 |
| 4 | Accessible Organizations Listing | `GET /api/github/orgs` listing user's personal account and accessible GitHub organizations | M1 | ORIGINAL_REQUEST R4 & Spec Miner 3 §4.2 |
| 5 | Accessible Repositories Listing | `GET /api/github/repos` listing organization repos with 1-click monitoring toggle correlation | M1 | ORIGINAL_REQUEST R4 & Spec Miner 3 §4.2 |
| 6 | Active Pull Requests Discovery & Inspection | `GET /api/github/repos/:owner/:repo/pulls` querying open PRs joined with review logs and active streams | M1 | ORIGINAL_REQUEST R4 & Spec Miner 3 §4.3 |
| 7 | On-Demand Pull Request Review Dispatch | `POST /api/github/repos/:owner/:repo/pulls/:prNumber/review` triggering immediate review run | M1 | ORIGINAL_REQUEST R4 & Spec Miner 3 §4.3 |
| 8 | Repository Review Rules CRUD Endpoints | `GET` and `PUT` on `/api/dashboard/repositories/:owner/:repo/rules` with Zod schema validation | M1 | ORIGINAL_REQUEST R4 & Spec Miner 3 §4.4 |
| 9 | Organization & Repo Management UI | Modernized `/repos` page with org selector, repository cards, active PR list, and review rule modal | M1 | ORIGINAL_REQUEST R4 & Explorer 1 §1.1 |
| 10 | Streaming Reasoning Traces Pipeline | Gateway SSE capture of `delta.reasoning` / `delta.reasoning_content` emitted as `reasoning:chunk` to `LiveStreamBus` | M2 | ORIGINAL_REQUEST R1 & Explorer 1 §1.3 |
| 11 | Live Tool Execution Streaming | `tool:start`, `tool:result`, `tool:error` emitted around `runReadOnlyTool` in `panelEngine.ts` | M2 | ORIGINAL_REQUEST R1 & Explorer 1 §1.3 |
| 12 | Live Finding Discovery Events | `persona:finding` emitted over SSE to `LiveStreamBus` as personas discover findings | M2 | ORIGINAL_REQUEST R1 & Explorer 1 §1.4 |
| 13 | Live Diff API Endpoints | `GET /api/live/diff?jobId=...` and `/api/dashboard/reviews/:jobId/diff` serving changed files and unified diff hunks | M2 | ORIGINAL_REQUEST R1 & Explorer 1 §1.4 |
| 14 | Interactive Unified Diff Viewer UI Component | `DiffViewer` rendering unified patch hunks, line numbers, green/red addition/deletion highlights, file accordion | M2 | ORIGINAL_REQUEST R1 & Explorer 1 §1.4 |
| 15 | Line-Anchored Finding Diff Cards UI Component | `FindingDiffCard` rendering inline annotations directly below annotated lines with P0/P1/P2 badges, title, description, code suggestions | M2 | ORIGINAL_REQUEST R1 & Explorer 1 §1.4 |
| 16 | Live Streaming Inspector UI Update | `LiveDashboardView.tsx` updated with live reasoning trace accordion, tool execution feed, and interactive diff viewer | M2 | ORIGINAL_REQUEST R1 & Explorer 1 §1.2 |
| 17 | Deterministic Finding Identifier Generator | Stable finding ID generation (`sha256(repo + ':' + file + ':' + line + ':' + title)`) | M3 | ORIGINAL_REQUEST R2 & Explorer 2 §1.B |
| 18 | Finding Dismissal & Severity Adjustment API | `POST /api/reviews/:id/findings/:findingId/dismiss` and `PATCH /api/reviews/:id/findings/:findingId/severity` | M3 | ORIGINAL_REQUEST R2 & Explorer 2 §1.B |
| 19 | Interactive Finding Control Buttons UI | One-click false-positive dismissal and severity adjustment buttons in finding cards and review detail modal | M3 | ORIGINAL_REQUEST R2 & Explorer 2 §1.B |
| 20 | Review Prompt Guidance Injection | `review_prompt_guidance` persistence, `POST /api/reviews/:id/guidance`, dynamically injected into persona `rules` | M3 | ORIGINAL_REQUEST R2 & Explorer 2 §1.B |
| 21 | Authoritative Manual Verdict Overrides (SHIP vs BLOCK) | `POST /api/reviews/:id/override` recording human verdict override in `review_verdict_overrides` | M3 | ORIGINAL_REQUEST R2 & Explorer 2 §1.B |
| 22 | Downstream Check Publishing Sync | Incrementing `desired_version` in `review_gate_attempts` on manual override so `ReviewGatePublisher` updates GitHub Check Run | M3 | ORIGINAL_REQUEST R2 & Explorer 2 §1.B |
| 23 | Audit Persistence & History | `review_audit_events` table and `GET /api/reviews/:id/audit-trail` capturing actor, action, previous/new state, timestamp | M3 | ORIGINAL_REQUEST R2 & Explorer 2 §1.B |
| 24 | p95 Review Latency Aggregation | PostgreSQL `PERCENTILE_CONT(0.95)` with in-memory percentile fallback across 24h, 7d, 30d windows | M4 | ORIGINAL_REQUEST R3 & Explorer 2 §1.C |
| 25 | Model & Repository Spend Intelligence | `SUM(costUSD) GROUP BY repo` and per-PR cost analytics in `/api/analytics/costs` | M4 | ORIGINAL_REQUEST R3 & Explorer 2 §1.C |
| 26 | Token Burn Curves Time Series | `GET /api/analytics/tokens` enhanced with cumulative burn curves, budget comparison, and repo filtering across 24h, 7d, 30d | M4 | ORIGINAL_REQUEST R3 & Explorer 2 §1.C |
| 27 | Finding Severity Ratios & Quality Metrics | P0/P1/P2 ratios, acceptance vs dismissal rates via `GET /api/analytics/findings` and `/api/analytics/summary` | M4 | ORIGINAL_REQUEST R3 & Explorer 2 §1.C |
| 28 | Executive & Engineering Analytics UI Dashboard | Recharts widgets for p95 duration, spend per repo, token burn, severity ratios with 24h/7d/30d filter toggles | M4 | ORIGINAL_REQUEST R3 & Explorer 2 §1.C |
| 29 | End-to-End Automated Test Suite | Comprehensive Tier 1-4 tests verifying dashboard API endpoints, streaming feeds, diff viewer, HITL overrides, analytics, and OAuth flow | M5 | ORIGINAL_REQUEST Acceptance & Spec Miner 3 §5 |
| 30 | Production Build Verification & Adversarial Coverage Hardening | Tier 5 adversarial testing, `npm run build` verification with zero errors | M5 | ORIGINAL_REQUEST Acceptance & Spec Miner 3 §5 |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | R4: GitHub OAuth, Organization/Repo Management & Review Rules | GitHub OAuth initiate/callback/session routes, accessible org & repo listing, active PR inspection API, review rules CRUD, and modernized `/repos` UI. | none | DONE |
| M2 | R1: Live Review Inspector, Streaming Reasoning/Tools & Interactive Diff Viewer | Gateway reasoning SSE streaming, tool execution events, live diff API endpoint, React DiffViewer component, Line-anchored finding cards, and LiveDashboardView integration. | none | DONE |
| M3 | R2: Human-in-the-Loop Controls, Verdict Overrides & Audit Persistence | Deterministic finding IDs, dismissal & severity adjustment API/UI, prompt steering guidance injection, manual SHIP/BLOCK override with GitHub Check Run sync, and audit trail persistence. | M1, M2 | DONE |
| M4 | R3: Executive & Engineering Analytics Dashboard | p95 review turnaround latency, cost per repository/PR, token burn curves, finding severity ratios, acceptance vs dismissal metrics across 24h/7d/30d time windows, and full Recharts UI dashboard. | M1 | DONE |
| M5 | Final Verification, 100% E2E Test Pass & Adversarial Hardening | Pass 100% of the E2E test suite from the E2E Testing Track, adversarial challenge testing, production build (`npm run build`) verification with zero regressions. | M1, M2, M3, M4 | DONE |

---

## Interface Contracts

### 1. GitHub OAuth & Session Contract (`src/api/authApi.ts`, `src/dashboard/authService.ts`)
```typescript
export interface GitHubUserProfile {
  id: string;
  username: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  role: 'admin' | 'reviewer' | 'viewer';
  provider: 'github';
  accessToken?: string;
}

export interface UserSession {
  token: string;
  user: GitHubUserProfile;
  expiresAt: string;
}
```

### 2. Organization, Repository & Pull Request Contract (`src/api/githubAppApi.ts`, `src/api/dashboardApi.ts`)
```typescript
export interface GitHubOrganizationSummary {
  id: number;
  login: string;
  name: string;
  avatarUrl: string;
  installationId?: number;
  monitoredCount: number;
  totalReposCount: number;
}

export interface ActivePullRequestSummary {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  author: { login: string; avatarUrl: string };
  headSha: string;
  headBranch: string;
  baseBranch: string;
  createdAt: string;
  updatedAt: string;
  reviewStatus?: {
    status: 'pending' | 'running' | 'completed' | 'failed';
    verdict?: 'SHIP' | 'BLOCK' | 'NEUTRAL';
    findingsCount: number;
    durationMs?: number;
    reviewedAt?: string;
  };
}
```

### 3. Live Streaming & Reasoning Event Contract (`src/types/live.ts`, `src/live/liveStreamBus.ts`)
```typescript
export type LiveStreamEventType =
  | 'persona:start'
  | 'persona:chunk'
  | 'persona:reasoning'
  | 'reasoning:chunk'
  | 'persona:finding'
  | 'persona:complete'
  | 'tool:start'
  | 'tool:result'
  | 'tool:error'
  | 'llm:prompt'
  | 'llm:token'
  | 'llm:error'
  | 'job:queued'
  | 'job:dispatched'
  | 'job:complete';

export interface ReasoningChunkPayload {
  jobId: string;
  personaId: string;
  reasoning: string;
  turn?: number;
  timestamp: string;
}

export interface ToolExecutionPayload {
  jobId: string;
  personaId: string;
  tool: string;
  args: Record<string, unknown>;
  output?: string;
  error?: string;
  durationMs?: number;
  timestamp: string;
}
```

### 4. Interactive Diff & Line-Anchored Finding Contract (`src/api/liveApi.ts`, `src/review/findings.ts`)
```typescript
export interface ChangedFileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  patch?: string;
  additions: number;
  deletions: number;
  hunks: Array<{
    header: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
}

export interface AnchoredFinding {
  id: string; // sha256(repo:file:line:title)
  severity: 'P0' | 'P1' | 'P2';
  file: string;
  line: number;
  title: string;
  description: string;
  suggestion?: string;
  status: 'active' | 'dismissed' | 'resolved';
  dismissedReason?: string;
}
```

### 5. Human-in-the-Loop Controls & Override Contract (`src/api/reviewHitlApi.ts`)
```typescript
export interface FindingDismissalRequest {
  findingId: string;
  reason: string;
  dismissedBy: string;
}

export interface VerdictOverrideRequest {
  overrideVerdict: 'SHIP' | 'BLOCK';
  reason: string;
  overriddenBy: string;
}

export interface PromptGuidanceRequest {
  guidanceText: string;
  targetPersonas?: string[];
  createdBy: string;
}

export interface ReviewAuditEvent {
  id: string;
  reviewId: string;
  actor: string;
  action: 'finding_dismissed' | 'severity_changed' | 'verdict_overridden' | 'guidance_added';
  previousState?: Record<string, unknown>;
  newState: Record<string, unknown>;
  justification?: string;
  timestamp: string;
}
```

### 6. Executive & Engineering Analytics Contract (`src/api/analytics.ts`)
```typescript
export interface AnalyticsTimeFilter {
  range: '24h' | '7d' | '30d';
  repo?: string;
}

export interface AnalyticsSummaryResponse {
  totalReviews: number;
  p95DurationMs: number;
  avgDurationMs: number;
  totalSpendUsd: number;
  totalTokens: number;
  successRate: number;
  findingSeverityRatio: {
    p0: number;
    p1: number;
    p2: number;
  };
  acceptanceRate: number; // accepted vs dismissed
}

export interface RepoSpendBreakdown {
  repo: string;
  spendUsd: number;
  reviewCount: number;
  avgSpendPerPR: number;
  totalTokens: number;
}
```

---

## Code Layout

- `src/api/authApi.ts` & `src/dashboard/authService.ts`: GitHub OAuth initiation, code callback exchange, session creation and validation
- `src/api/githubAppApi.ts` & `src/api/dashboardApi.ts`: Organization listing, repository listing, active PR queries, and review rules
- `src/github/installationClient.ts`: GitHub API methods for `listPullRequests`, `listInstallations`, and `listInstallationRepositories`
- `src/app/repos/page.tsx`: Organization and repository management UI with 1-click toggles and PR inspection table
- `src/gateway/openRouterClient.ts`: Streaming reasoning delta extraction and chunk callbacks
- `src/panel/panelEngine.ts`: Instrumenting `runReadOnlyTool` with live tool execution events, injecting prompt steering guidance
- `src/live/liveStreamBus.ts`: Supporting reasoning, tool, and finding event types
- `src/api/liveApi.ts`: Live diff endpoint (`GET /api/live/diff`) and finding emission
- `src/components/live/diff-viewer.tsx` & `finding-diff-card.tsx`: Interactive diff viewer with inline line-anchored finding cards
- `src/components/live/LiveDashboardView.tsx`: Integrated live reasoning traces and tool feed
- `src/persistence/postgresStore.ts` & `dashboardStore.ts`: Tables and repositories for `review_verdict_overrides`, `finding_dismissals`, `review_prompt_guidance`, `review_audit_events`
- `src/api/reviewHitlApi.ts`: REST endpoints for finding dismissal, severity adjustment, verdict override, guidance, and audit history
- `src/review/reviewGatePublisher.ts`: Syncing manual verdict overrides to GitHub Check Runs
- `src/api/analytics.ts`: Endpoints for p95 duration, repo spend breakdown, token burn curves, and finding quality metrics with 24h/7d/30d filtering
- `src/app/page.tsx` & `src/components/dashboard/`: Executive and engineering analytics dashboard UI with Recharts
- `tests/e2e/`: End-to-end automated test suites for OAuth, streaming feeds, diff viewer, HITL controls, and analytics
