## 2026-07-24T11:32:44-05:00
Perform a forensic integrity audit on the `ct-review-bot` codebase, test suites (unit, E2E Tiers 1-5), and documentation.
1. Perform static analysis and code tracing on `src/` and `tests/` to verify genuine implementation without hardcoded mock responses, dummy logic, or test-cheating tricks.
2. Run build and test verification (`npm run build`, `npm test`, `npm run test:e2e`).
3. Check for fake assertions, bypasses, or integrity violations.
4. Issue a formal verdict: CLEAN or INTEGRITY VIOLATION.
5. Write detailed forensic audit report to `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/auditor_m6/handoff.md` and notify orchestrator (conversation ID: 3c6c4ac5-6a1d-479b-9b05-6a0df5ee9759).
