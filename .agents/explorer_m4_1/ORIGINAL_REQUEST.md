## 2026-07-24T15:34:47Z
You are Explorer 1 for Milestone 4 (GitHub App & Webhook Receiver Event Loop) of `ct-review-bot`.
Your working directory is: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/explorer_m4_1`.
Target project root: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`.

Read the following project specifications and previous handoffs:
- Project spec: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/orchestrator/PROJECT.md`
- Scope document: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m4/SCOPE.md`
- Milestone 1 handoff: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m1/handoff.md`
- Milestone 2 handoff: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m2/handoff.md`
- Milestone 3 handoff: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m3/handoff.md`

Your task:
Investigate and design implementation specs for:
1. `src/github/signature.ts`: HMAC SHA-256 signature verification for GitHub webhooks (`X-Hub-Signature-256`). Standard constant-time comparison (`crypto.timingSafeEqual`), error handling, edge cases.
2. `src/github/webhookServer.ts`: Express web server receiving POST `/webhook` (or configurable endpoint), raw body parsing needed for HMAC verification (e.g. `express.raw` or body-parser preserving `req.rawBody`), secret management (`WEBHOOK_SECRET` env / config), route handling, return status codes (200 OK, 401 Unauthorized, 400 Bad Request, 500 Internal Server Error).
3. Investigate existing package dependencies (`express`, `@octokit/rest`, etc. in `package.json`).

Maintain `progress.md` in your working directory.
Write a comprehensive design & analysis report to `analysis.md` and `handoff.md` in your working directory.
When done, send a message to the caller (parent subagent ID: `bff3d692-29d2-4abc-9b6f-67d7d7176f1f`).
Remember: You are READ-ONLY exploration agent. Do NOT modify source code files.
