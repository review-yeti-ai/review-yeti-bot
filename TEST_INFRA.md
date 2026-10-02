# E2E Test Infra: Review Yeti Interactive Dashboard & Management Suite (M1-M4)

## Test Philosophy
- **Opaque-Box & Requirement-Driven**: Tests validate external HTTP/SSE REST contracts, payload schemas, and event stream invariants derived strictly from `ORIGINAL_REQUEST.md` (2026-10-01T14:02:49Z) and `PROJECT.md § Feature Inventory`.
- **Zero Internal Monkey-Patching**: All tests interact exclusively through public Express routes, Server-Sent Events streams, and standard authentication headers (`Authorization: Bearer <token>`).
- **Deterministic & Offline-Verifiable**: Zero reliance on live external cloud providers or live GitHub network connections. All upstream services (GitHub OAuth, GitHub App REST API, LLM Gateways) have deterministic in-memory/mock qualification paths.
- **4-Tier Test Architecture**:
  - **Tier 1: Feature Coverage (Category-Partition)**: Isolation happy paths testing primary behavior for each feature (>=5 per feature).
  - **Tier 2: Boundary & Corner Cases (BVA)**: Stress testing edge values, malformed inputs, CSRF state mismatches, invalid tokens, 400/401/404 handling (>=5 per feature).
  - **Tier 3: Cross-Feature Combinations (Pairwise)**: Multi-step integration sequences exercising contract boundaries between auth, repos, PR dispatch, streaming, HITL overrides, and analytics.
  - **Tier 4: Real-World Workload Scenarios**: Complete end-to-end workflows modeling enterprise developer and executive personas.

---

## Feature Inventory

Mapping all requirements (R1 - R4) from `PROJECT.md` and `ORIGINAL_REQUEST.md` across all 4 tiers:

| # | Feature Area | Description | Requirement | Tier 1 (Coverage) | Tier 2 (Boundaries) | Tier 3 (Cross-Feature) | Tier 4 (Real-World) | Total Tests |
|---|--------------|-------------|:-----------:|:-----------------:|:-------------------:|:----------------------:|:-------------------:|:-----------:|
| F1 | GitHub OAuth Initiation Route | `GET /api/auth/github` client ID resolution, CSRF state nonce, authorize redirect URL | R4 | 5 | 5 | ✓ | ✓ | 10+ |
| F2 | GitHub Session Validation & Logout | `GET /api/auth/session`, `DELETE /api/auth/session`, user role & profile | R4 | 5 | 5 | ✓ | ✓ | 10+ |
| F3 | Accessible Orgs & Repos Listing | `GET /api/github/orgs`, `GET /api/github/repos`, 1-click monitoring toggle | R4 | 5 | 5 | ✓ | ✓ | 10+ |
| F4 | Active PR Discovery & Review Dispatch | `GET /api/github/repos/:owner/:repo/pulls`, on-demand review dispatch | R4 | 5 | 5 | ✓ | ✓ | 10+ |
| F5 | SSE Live Streaming & Reasoning | `/api/live/stream`, `reasoning:chunk`, `tool:start`, active jobs query | R1 | 5 | 5 | ✓ | ✓ | 10+ |
| F6 | Interactive Diff Retrieval & Hunks | `GET /api/live/diff`, unified diff hunks, addition/deletion line anchors | R1 | 5 | 5 | ✓ | ✓ | 10+ |
| F7 | Finding Dismissal & Severity Adjustment | `POST /api/reviews/:id/findings/:findingId/dismiss`, `PATCH .../severity` | R2 | 5 | 5 | ✓ | ✓ | 10+ |
| F8 | Review Prompt Guidance Injection | `POST /api/reviews/:id/guidance`, dynamic persona rule injection | R2 | 5 | 5 | ✓ | ✓ | 10+ |
| F9 | Authoritative Manual Verdict Overrides | `POST /api/reviews/:id/override` (SHIP vs BLOCK), Check Run version bump | R2 | 5 | 5 | ✓ | ✓ | 10+ |
| F10 | Executive & Engineering Analytics | `/api/analytics/summary`, `/costs`, `/tokens`, `/findings` (24h/7d/30d) | R3 | 5 | 5 | ✓ | ✓ | 10+ |
| **Total** | | | | **50** | **50** | **8** | **5** | **113** |

---

## Test Architecture

- **Primary Test Runner**: Vitest (`npx vitest run tests/e2e/reviewYetiDashboardE2E.test.ts`)
- **API Testing Client**: Supertest v7.0.0
- **Test File Location**: `tests/e2e/reviewYetiDashboardE2E.test.ts`
- **Pass/Fail Semantics**: Clean exit code `0` on 100% pass; non-zero exit code (`1`) on any test failure.
- **Execution Target**: Deterministic, offline, zero token consumption, isolated ephemeral scratch lifecycle.

---

## Coverage Goals by Tier

### Tier 1: Core Feature Coverage (Happy Paths — 10 Features x 5 Tests = 50 Tests)

#### F1: GitHub OAuth Initiation Route
- `TEST_T1_F1_01`: Resolves client ID from env/store and generates 302 redirect to GitHub authorize URL.
- `TEST_T1_F1_02`: Returns JSON authorization URL when `Accept: application/json` is requested.
- `TEST_T1_F1_03`: Generates cryptographically secure, unique CSRF state parameter for each request.
- `TEST_T1_F1_04`: Includes default requested OAuth scopes (`read:user`, `user:email`, `read:org`, `repo`).
- `TEST_T1_F1_05`: Respects custom `return_to` parameter preserving post-login navigation path.

#### F2: GitHub Session Validation & Logout
- `TEST_T1_F2_01`: Successfully validates active Bearer session token returning user profile, role, and expiry.
- `TEST_T1_F2_02`: Supports public demo session tokens (`demo_token_public`, `public_viewer_token`) with viewer role.
- `TEST_T1_F2_03`: Returns 200 and revokes session token upon `DELETE /api/auth/session`.
- `TEST_T1_F2_04`: Validates user session created via OAuth callback with GitHub user metadata.
- `TEST_T1_F2_05`: Session introspection reports ISO-8601 UTC timestamp format for `expiresAt`.

#### F3: Accessible Organizations & Repositories Listing
- `TEST_T1_F3_01`: `GET /api/github/orgs` returns list of accessible organizations with avatar, login, and monitored repo counts.
- `TEST_T1_F3_02`: `GET /api/github/repos` returns repositories belonging to user or organization.
- `TEST_T1_F3_03`: Repository listing includes 1-click monitoring toggle status (`automationEnabled: boolean`).
- `TEST_T1_F3_04`: Repository listing correlates strictness profile (`chill` | `balanced` | `assertive`).
- `TEST_T1_F3_05`: Supports filtering repositories by organization name query parameter (`?org=calltelemetry`).

#### F4: Active Pull Requests Discovery & Review Dispatch
- `TEST_T1_F4_01`: `GET /api/github/repos/:owner/:repo/pulls` returns open PRs with title, author, branch, head SHA, and draft status.
- `TEST_T1_F4_02`: Pull requests are joined with existing Review Yeti review logs (verdict, findings count, duration).
- `TEST_T1_F4_03`: `POST /api/github/repos/:owner/:repo/pulls/:prNumber/review` initiates on-demand review and returns job status.
- `TEST_T1_F4_04`: Review dispatch publishes `job:queued` or `job:dispatched` event to `LiveStreamBus`.
- `TEST_T1_F4_05`: Supports state filtering (`?state=open`, `?state=closed`, `?state=all`).

#### F5: SSE Live Streaming & Reasoning Endpoints
- `TEST_T1_F5_01`: `GET /api/live/stream?jobId=...` establishes Server-Sent Events connection with `Content-Type: text/event-stream`.
- `TEST_T1_F5_02`: SSE stream broadcasts `reasoning:chunk` events containing live persona reasoning traces.
- `TEST_T1_F5_03`: SSE stream broadcasts `tool:start` and `tool:result` events for sandboxed read-only tools.
- `TEST_T1_F5_04`: `GET /api/live/active` returns active in-flight review jobs and queue metrics.
- `TEST_T1_F5_05`: `GET /api/live/history?jobId=...` replays cached event buffer for specified job ID.

#### F6: Interactive Diff Retrieval & Hunk Slicing
- `TEST_T1_F6_01`: `GET /api/live/diff?jobId=...` returns list of changed files with additions, deletions, and status.
- `TEST_T1_F6_02`: Diff response provides structured unified patch hunks with old/new line numbers and header.
- `TEST_T1_F6_03`: Supports retrieving diff by review run ID (`/api/dashboard/reviews/:runId/diff`).
- `TEST_T1_F6_04`: File patch correctly distinguishes added lines (`+`), deleted lines (`-`), and context lines.
- `TEST_T1_F6_05`: Maps changed files to persona lane affinity (e.g. security lane for auth files).

#### F7: Line-Anchored Finding Dismissals & Severity Adjustments
- `TEST_T1_F7_01`: Generates deterministic finding ID via `sha256(repo + ':' + file + ':' + line + ':' + title)`.
- `TEST_T1_F7_02`: `POST /api/reviews/:id/findings/:findingId/dismiss` marks finding as dismissed with reason.
- `TEST_T1_F7_03`: `PATCH /api/reviews/:id/findings/:findingId/severity` updates finding severity (`P0` -> `P1` -> `P2`).
- `TEST_T1_F7_04`: Line anchoring correctly associates finding with file path and 1-indexed line number in diff hunk.
- `TEST_T1_F7_05`: Dismissing a finding updates active findings count and recalculates gate eligibility.

#### F8: Review Prompt Guidance Injection
- `TEST_T1_F8_01`: `POST /api/reviews/:id/guidance` persists human reviewer steering instructions.
- `TEST_T1_F8_02`: Guidance payload includes `guidanceText`, `createdBy`, and optional `targetPersonas`.
- `TEST_T1_F8_03`: Dynamically injects steering guidance into persona `rules` for subsequent review turns.
- `TEST_T1_F8_04`: `GET /api/reviews/:id/guidance` retrieves existing guidance history for the review.
- `TEST_T1_F8_05`: Emits `guidance:added` audit log event upon successful submission.

#### F9: Authoritative Manual Verdict Overrides & Downstream Check Sync
- `TEST_T1_F9_01`: `POST /api/reviews/:id/override` accepts manual verdict override (`SHIP` vs `BLOCK`).
- `TEST_T1_F9_02`: Override records `overrideVerdict`, `reason`, `overriddenBy`, and ISO timestamp.
- `TEST_T1_F9_03`: Increments `desired_version` in `review_gate_attempts` triggering downstream check sync.
- `TEST_T1_F9_04`: Manual override to `SHIP` clears blocking state even if open P0/P1 findings remain.
- `TEST_T1_F9_05`: Manual override to `BLOCK` forces gate failure even if panel consensus was SHIP.

#### F10: Executive & Engineering Analytics Dashboard
- `TEST_T1_F10_01`: `GET /api/analytics/summary` returns review counts, p95 latency, total spend, tokens, and success rate.
- `TEST_T1_F10_02`: `GET /api/analytics/costs` returns model spend breakdown and per-repository spend.
- `TEST_T1_F10_03`: `GET /api/analytics/tokens` returns token time-series with cumulative burn curve.
- `TEST_T1_F10_04`: `GET /api/analytics/findings` returns severity breakdown (P0/P1/P2) and acceptance vs dismissal rates.
- `TEST_T1_F10_05`: Analytics endpoints support selectable time filters (`?range=24h`, `?range=7d`, `?range=30d`).

---

### Tier 2: Boundary & Corner Cases (10 Features x 5 Tests = 50 Tests)

#### F1: GitHub OAuth Initiation Route
- `TEST_T2_F1_01`: Rejects or fails closed with 500/503 when OAuth client ID is completely unconfigured.
- `TEST_T2_F1_02`: Handles open redirect defense (rejects non-relative or external `return_to` like `https://attacker.com`).
- `TEST_T2_F1_03`: Rejects oversized or invalid custom scopes exceeding maximum allowed length.
- `TEST_T2_F1_04`: Rejects empty or whitespace-only scope parameters.
- `TEST_T2_F1_05`: Handles state collision or replay attack protection (ensures state nonce is single-use).

#### F2: GitHub Session Validation & Logout
- `TEST_T2_F2_01`: Returns 401 Unauthorized when Authorization header is missing.
- `TEST_T2_F2_02`: Returns 401 Unauthorized for malformed Bearer prefix (`Basic abc`, `Token xyz`, bare token).
- `TEST_T2_F2_03`: Returns 401 Unauthorized for nonexistent, forged, or random session token.
- `TEST_T2_F2_04`: Returns 401 Unauthorized when session token has expired (`expiresAt < Date.now()`).
- `TEST_T2_F2_05`: Calling `DELETE /api/auth/session` with invalid token returns 200 idempotently without crashing.

#### F3: Accessible Organizations & Repositories Listing
- `TEST_T2_F3_01`: Returns 401 Unauthorized for `GET /api/github/orgs` when unauthenticated.
- `TEST_T2_F3_02`: Returns empty array or 404 for unknown or unauthorized organization filter (`?org=nonexistent_org`).
- `TEST_T2_F3_03`: Rejects malformed organization names containing illegal characters or path traversal (`?org=../`).
- `TEST_T2_F3_04`: Handles empty repository lists gracefully without throwing null pointer exceptions.
- `TEST_T2_F3_05`: Pagination parameter boundary handling (negative `page`, excessive `per_page` clamped to maximum).

#### F4: Active Pull Requests Discovery & Review Dispatch
- `TEST_T2_F4_01`: Returns 404 Not Found when owner/repo does not exist.
- `TEST_T2_F4_02`: Returns 400 Bad Request when PR number is non-numeric, 0, or negative.
- `TEST_T2_F4_03`: Returns 400/409 Conflict when attempting to trigger review on a closed PR without override flag.
- `TEST_T2_F4_04`: Rejects dispatch when repository automation is explicitly disabled (`automationEnabled: false`).
- `TEST_T2_F4_05`: Returns 401 Unauthorized when attempting to trigger review without valid session or API key.

#### F5: SSE Live Streaming & Reasoning Endpoints
- `TEST_T2_F5_01`: Handles client disconnect mid-stream cleanly without leaking listeners or throwing unhandled errors.
- `TEST_T2_F5_02`: Returns empty history array (count 0) for non-existent or expired `jobId`.
- `TEST_T2_F5_03`: Event buffer capping boundary (buffer does not exceed 500 events per job, dropping oldest).
- `TEST_T2_F5_04`: Rejects malformed publish payloads on `POST /api/live/publish` with 400 Bad Request.
- `TEST_T2_F5_05`: Handles extreme job ID strings (empty, special characters, 256+ characters) safely.

#### F6: Interactive Diff Retrieval & Hunk Slicing
- `TEST_T2_F6_01`: Returns 404 Not Found when requested `jobId` or `runId` has no associated diff or snapshot.
- `TEST_T2_F6_02`: Returns 400 Bad Request when `jobId` query parameter is missing or empty.
- `TEST_T2_F6_03`: Gracefully handles binary files or unpatchable assets (`patch: null` or `isBinary: true`).
- `TEST_T2_F6_04`: Handles empty PR diffs (0 changed files) with 200 OK and empty files list.
- `TEST_T2_F6_05`: Massive diff boundary: safely truncates or paginates files exceeding size limit (>500KB patch).

#### F7: Line-Anchored Finding Dismissals & Severity Adjustments
- `TEST_T2_F7_01`: Returns 404 Not Found when review ID or finding ID does not exist.
- `TEST_T2_F7_02`: Returns 400 Bad Request when dismissal request is missing `reason` or `dismissedBy`.
- `TEST_T2_F7_03`: Returns 400 Bad Request when setting an invalid severity value (`P3`, `CRITICAL`, `UNKNOWN`).
- `TEST_T2_F7_04`: Dismissal idempotency: dismissing an already-dismissed finding succeeds without duplicate audit entries.
- `TEST_T2_F7_05`: Rejects finding mutation when review ID format is malformed or invalid UUID/slug.

#### F8: Review Prompt Guidance Injection
- `TEST_T2_F8_01`: Returns 400 Bad Request when `guidanceText` is empty, whitespace-only, or missing.
- `TEST_T2_F8_02`: Rejects prompt guidance exceeding maximum character limit (e.g. > 4,000 characters).
- `TEST_T2_F8_03`: Returns 404 Not Found when review ID does not exist.
- `TEST_T2_F8_04`: Handles invalid persona IDs in `targetPersonas` array (rejects unknown personas).
- `TEST_T2_F8_05`: Rejects unauthenticated guidance submission with 401 Unauthorized.

#### F9: Authoritative Manual Verdict Overrides & Downstream Check Sync
- `TEST_T2_F9_01`: Returns 400 Bad Request when `overrideVerdict` is not `SHIP` or `BLOCK` (e.g. `MAYBE`, `PASS`).
- `TEST_T2_F9_02`: Returns 400 Bad Request when override `reason` is missing or shorter than minimum required length.
- `TEST_T2_F9_03`: Returns 404 Not Found when target review ID does not exist.
- `TEST_T2_F9_04`: Returns 403 Forbidden when user role is `viewer` (only `admin` or `reviewer` permitted).
- `TEST_T2_F9_05`: Rejects override on already finalized or superseded review runs.

#### F10: Executive & Engineering Analytics Dashboard
- `TEST_T2_F10_01`: Returns 400 Bad Request for unsupported time range (`?range=90d`, `?range=year`, `?range=invalid`).
- `TEST_T2_F10_02`: Returns empty/zero metrics gracefully when database has zero review runs in time window.
- `TEST_T2_F10_03`: Repository filter boundary: returns empty metrics for unknown repository filter (`?repo=nonexistent/repo`).
- `TEST_T2_F10_04`: Calculates p95 accurately with small sample sets (e.g. 1 review, 2 reviews, 5 reviews).
- `TEST_T2_F10_05`: Returns 401 Unauthorized when accessing analytics without authentication.

---

### Tier 3: Cross-Feature Combinations (Pairwise Interaction Workflows — 8 Tests)

- `TEST_T3_PAIR_01`: **OAuth Login -> Session Introspection -> Accessible Organizations & Repositories Discovery (F1 + F2 + F3)**
  - Exchanges mock OAuth authorization code, obtains session token, introspects session profile, and queries accessible organizations and repositories.
- `TEST_T3_PAIR_02`: **Repository Selection -> Active PR Inspection -> On-Demand Review Dispatch (F3 + F4)**
  - Selects monitored repository, discovers open pull requests, selects an unreviewed PR, and triggers an on-demand review run.
- `TEST_T3_PAIR_03`: **Review Dispatch -> SSE Stream Connection -> Live Reasoning Token Broadcast (F4 + F5)**
  - Connects client to `/api/live/stream?jobId=...`, triggers review run, and verifies reception of `reasoning:chunk` events as personas deliberate.
- `TEST_T3_PAIR_04`: **Live Review Execution -> Read-Only Tool Invocation -> Live Tool Event Emission (F5 + F6)**
  - Observes reviewer persona executing a read-only analysis tool (e.g. `ast_lookup`), verifying immediate emission of `tool:start` and `tool:result` on the SSE stream.
- `TEST_T3_PAIR_05`: **Review Completion -> Unified Diff Retrieval -> Inline Line-Anchored Finding Discovery (F5 + F6 + F7)**
  - Receives review completion event, fetches unified diff hunks, verifies line-anchored annotations match diff line coordinates and severity badges.
- `TEST_T3_PAIR_06`: **Finding Discovery -> False-Positive Dismissal -> Review Audit Trail Recording (F7 + F8)**
  - Dismisses a false-positive P1 finding with audit reasoning; confirms finding status transitions to `dismissed` and audit event is recorded in audit trail.
- `TEST_T3_PAIR_07`: **Finding Discovery -> Manual Verdict Override -> Downstream Gate Check Attempt Sync (F7 + F9)**
  - Review panel reports `BLOCK` due to P0 finding; human reviewer submits authoritative verdict override `SHIP`; confirms `desired_version` increments and gate check updates to Approved.
- `TEST_T3_PAIR_08`: **Review Execution & Dismissal Activity -> Executive Analytics Summary & Severity Ratio Update (F7 + F10)**
  - Completes review execution and triage; queries `/api/analytics/summary` and `/api/analytics/findings`; confirms metrics accurately reflect turnaround latency, spend, and acceptance/dismissal ratios.

---

### Tier 4: Real-World Scenarios (Comprehensive End-to-End Workflows — 5 Tests)

- `TEST_T4_SCENARIO_01`: **Developer Happy-Path: OAuth Login -> Repo Discovery -> Active PR Review -> Clean SSE Stream -> SHIP Consensus**
  - Full engineer workflow: logs in via GitHub OAuth, navigates to `calltelemetry/cisco-cdr`, selects active PR #402, monitors live reasoning feed over SSE, all 11 personas finish with zero P0/P1 findings, panel issues SHIP verdict, and PR check marks success.
- `TEST_T4_SCENARIO_02`: **Human-in-the-Loop False-Positive Triage: Security Lane P1 Finding Dismissal -> Auto-Approval Gate Update**
  - Security persona flags a suspected secret in test fixture; developer inspects inline finding card on diff viewer; clicks "Dismiss as False Positive" with justification; active findings drop to 0; gate automatically clears and downstream check updates to SHIP.
- `TEST_T4_SCENARIO_03`: **Authoritative Executive Override: Critical Blocked Review Overridden to SHIP for Emergency Hotfix Deployment**
  - High-priority production incident hotfix PR triggers review; quality persona raises blocking P0 finding; engineering director performs manual verdict override to `SHIP` with incident justification; gate attempt updates `desired_version`; check run transitions to Approved.
- `TEST_T4_SCENARIO_04`: **Prompt Steering Mid-Review: Prompt Guidance Injected to Guide Reviewer Personas on Architecture Patterns**
  - Multi-turn review running in sandbox; tech lead submits inline prompt guidance instructing personas to evaluate against RFC-8785 canonical JSON; subsequent persona reasoning traces incorporate guidance into deliberation.
- `TEST_T4_SCENARIO_05`: **Executive Spend & Velocity Intelligence: Multi-PR Batch Evaluation -> 24h/7d/30d Spend, Token Burn & p95 Analytics**
  - Engineering manager reviews team velocity; filters analytics across 24h, 7d, 30d; compares token burn curves against monthly budget; inspects p95 turnaround duration and per-repository spend breakdown.

---

## Verification & Execution Guide

### 1. Run Vitest E2E Suite
```bash
npx vitest run tests/e2e/reviewYetiDashboardE2E.test.ts
```

### 2. Run All E2E Suites
```bash
npm run test:e2e
```

### 3. Verify TypeScript Build
```bash
npm run build:backend
```
