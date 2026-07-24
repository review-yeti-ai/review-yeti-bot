## 2026-07-24T14:40:29Z
You are a Worker agent assigned to execute the Milestone E2E-M4 Audit Remediation for `ct-review-bot`.

Working Directory: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_e2e/worker_e2e_m4_remediation`
Project Root: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Technical Blueprint from Explorer 1 (`/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_e2e/explorer_e2e_m4_remediation/handoff.md`):

Your Tasks:
1. **Work Package A: Native Application Integration in `src/app.ts`**:
   - Import `OmniRouteClient` from `./gateway/omniRouteClient` and `evaluateQuorum` from `./quorum/quorumEngine`.
   - Update `src/app.ts` webhook handler (`/api/webhook/github`) so that it natively executes the full pipeline end-to-end:
     a. **Ticket & Constitution Gates**: If ticket validation fails (`!ticketResult.valid`) or constitution fails (`!constitutionResult.compliant`), set `decision = 'REQUEST_CHANGES'`, post review summary to mock GitHub (`${githubApiBase}/repos/${owner}/${repoName}/pulls/${prNumber}/reviews`), and skip OmniRoute LLM calls.
     b. **Diff Delta & Quorum Evaluation**: If ticket and constitution pass:
        - Check if `updateResult.hunksToReview` contains hunks (or first pass):
          - Invoke `OmniRouteClient.completion` for each configured persona (e.g. `['security', 'architecture', 'performance', 'quality']`).
          - Pass returned findings to `evaluateQuorum({ minApprovals: config.quorum.minApprovals, configuredPersonas: config.quorum.personas, personaFindings })`.
          - Set `decision = quorumResult.decision`.
        - Else (unchanged diff delta): keep decision and skip issuing new OmniRoute calls.
     c. **GitHub API Publication**:
        - Natively POST inline comments for findings to `${githubApiBase}/repos/${owner}/${repoName}/pulls/${prNumber}/comments`.
        - Natively POST review summary to `${githubApiBase}/repos/${owner}/${repoName}/pulls/${prNumber}/reviews`.

2. **Work Package B: Pure HTTP E2E Test Suite in `tests/e2e/tier3/crossFeatureInteractions.test.ts`**:
   - Refactor all 7 test cases in `crossFeatureInteractions.test.ts` so that ALL test interactions occur PURELY via HTTP POST requests to `appUrl/api/webhook/github`.
   - Eliminate ALL out-of-band instantiations in test code (`new OmniRouteClient`, `evaluateQuorum`, `new DiffStateManager`, `validateTicketLinkage`, or manual `fetch` calls to mock GitHub ports).
   - Assert all side effects via:
     - Webhook response `statusCode`, `body.decision`, `body.ticketValid`, `body.constitutionCompliant`.
     - Recorded requests on mock servers: `harness.mockGithub.getRecordedReviews()`, `harness.mockGithub.getRecordedInlineComments()`, `harness.mockOmniRoute.getRecordedRequests()`.

3. **Build & Test Verification**:
   - Run `npm run build`
   - Run `./node_modules/.bin/vitest run tests/e2e/tier3/crossFeatureInteractions.test.ts --config vitest.config.e2e.ts`
   - Run full E2E test suite `./node_modules/.bin/vitest run --config vitest.config.e2e.ts`
   - Run unit/tier1/tier2 suites to confirm zero regressions across all 16 test files.

4. **Reporting**:
   - Write detailed handoff report to `.agents/sub_orch_e2e/worker_e2e_m4_remediation/handoff.md`.
   - Send completion message to orchestrator (`72a8331a-dd28-4aa2-a01b-79a86287c45e`).
