# Original Request

## 2026-07-24T10:34:25Z

You are the Sub-Orchestrator for Milestone 4 (GitHub App & Webhook Receiver Event Loop) of `ct-review-bot`.
Your working directory is `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m4`.
Target project root: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`.
Global project spec: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/orchestrator/PROJECT.md`.
Original request: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/ORIGINAL_REQUEST.md`.
Milestone 1 handoff: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m1/handoff.md`.
Milestone 2 handoff: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m2/handoff.md`.
Milestone 3 handoff: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m3/handoff.md`.

Your Mission:
Deliver Milestone 4:
1. Implement Express GitHub Webhook Receiver (`src/github/webhookServer.ts`, `src/github/signature.ts`): HMAC SHA-256 signature verification (`X-Hub-Signature-256`), raw body parsing, secret management, and robust error handling.
2. Implement Webhook Event Dispatcher & Listener (`src/github/eventHandler.ts`): Handle Pull Request events (`opened`, `synchronize`, `reopened`), comment command triggers (`@ct-review review`, `@bot review`), label/tag triggers, and background job queueing.
3. Implement Octokit PR Comment Publisher (`src/github/commentPublisher.ts`): Create granular inline code diff comments on unresolved threads with ` ```suggestion ` blocks, submit top-level PR summary reviews (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`), and handle GitHub API rate limits.
4. Integrate native event loop into `src/app.ts` connecting Webhook Receiver -> Config Parser -> Ticket Linkage -> Constitution Engine -> Diff State Manager -> Quorum Engine -> Octokit Publisher.
5. Implement unit and integration tests (`tests/unit/webhook.test.ts`, `tests/unit/publisher.test.ts`, `tests/integration/m4_webhook.test.ts`).
6. Run `npm run build` (0 compilation errors) and `npm test` (100% tests passing).
