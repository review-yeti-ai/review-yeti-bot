# Handoff Report: OmniRoute & Ticket API Mock Servers Design (Milestone E2E-M1)

**Agent**: `teamwork_preview_explorer_e2em1_2`  
**Target Milestone**: E2E-M1 (Harness & Mocks Setup)  
**Report Output**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_e2em1_2/analysis_omniroute_ticket_mocks.md`  

---

## 1. Observation

- Explored workspace files under `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/`.
- Examined architecture specifications in `orchestrator/PROJECT.md`, `sub_orch_e2e/SCOPE.md`, `teamwork_preview_explorer_m1_2/analysis.md`, and `teamwork_preview_explorer_m1_3/analysis.md`.
- Identified requirements for `src/router/` (OmniRoute adapter, OAuth token manager, failover pool, effort levels: `low`, `medium`, `high`, `reasoning`) and `src/ticket/` (ticket validator for Linear, Jira, GitHub issues).
- Designed complete TypeScript implementations for:
  - `tests/e2e/harness/mockOmniRouteServer.ts`: Express-based HTTP server mocking OmniRoute LLM router, OAuth token refresh `/v1/oauth/token`, multi-provider failover (`openai`, `anthropic`, `google`, `deepseek`), effort level response generation, persona review formats, and admin request recording/control (`/__admin/configure`, `/__admin/requests`, `/__admin/reset`).
  - `tests/e2e/harness/mockTicketServer.ts`: Express-based HTTP server mocking issue tracking APIs for Linear GraphQL (`/linear/graphql`), Jira REST v3 (`/jira/rest/api/3/issue/:key`), and GitHub Issues REST v3 (`/github/repos/:owner/:repo/issues/:number`), with dynamic ticket seed/pre-registration and fault injection (`/__admin/tickets`, `/__admin/inject-error`).

---

## 2. Logic Chain

1. **Opaque-Box E2E Testing Requirement**:
   - The test suite must exercise `ct-review-bot` end-to-end via network requests without depending on external production APIs (OmniRoute, Linear, Jira, GitHub).
   - Mock servers must run locally as HTTP servers on configurable ports, intercepting bot outgoing traffic and responding realistically.
2. **OmniRoute Gateway Simulation**:
   - The OmniRoute gateway uses OAuth tokens that expire. `mockOmniRouteServer.ts` simulates 401 token expiry and `/v1/oauth/token` refresh so `tokenManager.ts` can be tested in an opaque-box manner.
   - Failover testing requires setting primary provider failure states (e.g. OpenAI returns 503/429). The admin API allows E2E tests to programmatically trigger failovers to verify `providerPool.ts` retries with secondary providers.
   - Effort levels (`low`, `medium`, `high`, `reasoning`) demand tailored token metrics and reasoning trace headers in responses.
3. **Ticket API Simulation**:
   - Linear uses GraphQL, Jira uses REST v3, and GitHub uses REST v3. `mockTicketServer.ts` unifies all 3 mock APIs into a single controllable server.
   - PR ticket validation tests require verifying valid ticket keys, closed/invalid tickets, and error responses (404, 401, 429, 500).

---

## 3. Caveats

- Implementation of actual TypeScript code files under `tests/e2e/harness/mockOmniRouteServer.ts` and `tests/e2e/harness/mockTicketServer.ts` will be carried out by implementer agents during E2E-M1 construction.
- Port selection defaults to `9090` (OmniRoute) and `9091` (Ticket Server); test runners should support dynamic port assignment (`0` or env vars) to avoid port collisions in CI environments.

---

## 4. Conclusion

The specification in `analysis_omniroute_ticket_mocks.md` provides a complete, production-ready, TypeScript-native architectural design and implementation blueprint for `mockOmniRouteServer.ts` and `mockTicketServer.ts`. These mock servers fulfill all opaque-box E2E testing requirements for multi-provider LLM routing, token refresh lifecycles, provider failover, effort levels, persona findings, and multi-provider ticket API validation.

---

## 5. Verification Method

To verify the mock server design:
1. Review the full report at `.agents/teamwork_preview_explorer_e2em1_2/analysis_omniroute_ticket_mocks.md`.
2. Ensure TypeScript source code specifications in Sections 4.3 and 5.3 compile cleanly with `express` and Node `http`.
3. Verify test integration patterns in Section 6 against Vitest harness specs in `sub_orch_e2e/SCOPE.md`.
