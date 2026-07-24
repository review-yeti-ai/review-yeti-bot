# Handoff Report: E2E Test Suite GitHub Mocking Design (Milestone E2E-M1)

**Agent**: `teamwork_preview_explorer_e2em1_1`  
**Milestone**: E2E-M1 (Harness & Mocks Setup)  
**Date**: 2026-07-24  
**Status**: Hard Handoff (Completed)  

---

## 1. Observation

- **Worktree Location**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/`
- **Working Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_e2em1_1`
- **Key Project Files Inspected**:
  - `PROJECT.md` (`.agents/orchestrator/PROJECT.md` lines 1 to 184): Outlines global architecture, Express webhook receiver with HMAC signature validation, Octokit publisher, and tech stack (`@octokit/core`, `@octokit/rest`, `@octokit/webhooks`, `express`, `zod`, `js-yaml`, `vitest`).
  - `plan.md` (`.agents/orchestrator/plan.md` lines 1 to 68): Defines E2E Testing Track roadmap (E2E-M1 through E2E-M6) and Milestone M4 GitHub App webhook receiver loop.
  - `SCOPE.md` (`.agents/sub_orch_e2e/SCOPE.md` lines 1 to 68): Establishes E2E Test Runner layout (`tests/e2e/harness/mockGithubServer.ts`) and opaque-box test requirements.
  - Peer agent reports:
    - `teamwork_preview_explorer_m1_1/analysis.md`: Configured Express `rawBody` retention middleware (`app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }))`).
    - `teamwork_preview_explorer_e2em1_2/analysis_omniroute_ticket_mocks.md`: Specified `mockOmniRouteServer.ts` and `mockTicketServer.ts`.
    - `teamwork_preview_explorer_e2em1_3/analysis_runner_harness.md`: Specified `fixtureGenerator.ts`, `stateManager.ts`, and `vitest.config.e2e.ts`.
- **Output Report Created**:
  - `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_e2em1_1/analysis_github_mocks.md`

---

## 2. Logic Chain

1. **Observation 1**: `PROJECT.md` and `webhookServer.ts` specs require GitHub Webhooks to be delivered with `X-Hub-Signature-256` HMAC validation computed over unparsed request body bytes (`req.rawBody`).
2. **Observation 2**: Opaque-box E2E testing demands that webhooks are delivered over HTTP to the running Express app process without modifying internal code or bypassing auth checks.
3. **Logic Step 1**: `mockGithubServer.ts` must include an HMAC SHA-256 generator (`generateSignature()`) that computes `sha256=<hex_digest>` using `crypto.createHmac('sha256', secret)`. It must support delivering valid signatures, corrupted signatures, or missing signature headers to test both happy paths (Tier 1) and security boundary failures (Tier 2).
4. **Observation 3**: The bot service uses Octokit REST endpoints to publish review summaries (`POST /repos/{owner}/{repo}/pulls/{pr_number}/reviews`) and inline comments (`POST /repos/{owner}/{repo}/pulls/{pr_number}/comments`).
5. **Logic Step 2**: `mockGithubServer.ts` must operate a mock HTTP server recording all incoming Octokit REST requests and providing inspection methods (`getRecordedReviews`, `getRecordedInlineComments`) so E2E test scripts can assert review decisions (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`), comment paths, and line numbers.
6. **Observation 4**: PR workflows encompass initial PR opening (`opened`), code updates (`synchronize`), PR reopening (`reopened`), and manual re-trigger comments (`@bot review`).
7. **Logic Step 3**: `mockGithubServer.ts` must provide builder functions (`buildPullRequestEvent`, `buildIssueCommentEvent`) to easily construct valid, realistic GitHub event payloads for these test scenarios.

---

## 3. Caveats

- **No live GitHub Network Calls**: All interactions are mocked locally over HTTP (`http://127.0.0.1:9092`). No live GitHub App installation keys or tokens are required.
- **Port Allocation**: Default port is set to `9092`. The implementation supports passing dynamic options (`{ port: 0 }` or custom ports) if parallel test runners require isolated ports.
- **Scope Alignment**: `mockGithubServer.ts` focuses strictly on GitHub Webhooks and Octokit REST API mocking. OmniRoute LLM routing and Linear/Jira ticket API mocking are covered by `teamwork_preview_explorer_e2em1_2` (`mockOmniRouteServer.ts`, `mockTicketServer.ts`).

---

## 4. Conclusion

`mockGithubServer.ts` is fully designed and specified for implementation under `tests/e2e/harness/mockGithubServer.ts`. The comprehensive technical report has been published to `analysis_github_mocks.md`. It provides:
1. Complete Express server implementation with Octokit REST recording endpoints.
2. Webhook delivery engine with HMAC SHA-256 signature generation and fault simulation.
3. Builder methods for `opened`, `synchronize`, `reopened`, and `@bot review` events.
4. Clean integration patterns with Vitest E2E test scripts.

---

## 5. Verification Method

1. **Inspect Analysis Output File**:
   - File path: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_e2em1_1/analysis_github_mocks.md`
2. **Verify Code Implementation Specification**:
   - Confirm Section 5 of `analysis_github_mocks.md` contains complete, compilable TypeScript code for `MockGithubServer`.
3. **Downstream Implementation Check**:
   - When built by worker agents in E2E-M1, verify unit tests via `npx vitest run tests/unit/mockGithubServer.test.ts`.
