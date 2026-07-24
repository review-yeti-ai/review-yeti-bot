## 2026-07-24T15:36:34Z
<USER_REQUEST>
You are the Worker for Milestone 4 (GitHub App & Webhook Receiver Event Loop) of `ct-review-bot`.
Your working directory is: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/implementer_m4`.
Target project root: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Refer to the technical design specifications produced by the Explorers:
- Explorer 1 (Signature & Webhook Server): `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/explorer_m4_1/analysis.md`
- Explorer 2 (Event Dispatcher & Listener): `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/explorer_m4_2/analysis.md`
- Explorer 3 (Publisher & App Event Loop): `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/explorer_m4_3/analysis.md`

Your Tasks:
1. Implement `src/github/signature.ts`: HMAC SHA-256 signature verification (`X-Hub-Signature-256`) using `crypto.timingSafeEqual`, handling missing headers, raw body buffers, and timing attack protection.
2. Implement `src/github/webhookServer.ts`: Express GitHub Webhook Server & middleware retaining raw body (`req.rawBody`), secret management (`WEBHOOK_SECRET` / `GITHUB_WEBHOOK_SECRET`), route mounting (`/webhook` & `/api/webhook/github`), and HTTP status codes (`200 OK`, `401 Unauthorized`, `400 Bad Request`, `500 Internal Server Error`).
3. Implement `src/github/eventHandler.ts`: Webhook Event Dispatcher & Listener handling PR lifecycle events (`opened`, `synchronize`, `reopened`), comment command triggers (`@ct-review review`, `@bot review`, `@ct-review-bot review`), label/tag triggers, bot self-loop prevention, normalized PR payload extraction, and async background job queueing.
4. Implement `src/github/commentPublisher.ts`: Octokit PR Comment Publisher for inline code diff comments with ` ```suggestion ` blocks, thread deduplication, top-level PR summary reviews (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`), and exponential backoff retry for rate limits.
5. Integrate native event loop into `src/app.ts` connecting Webhook Receiver -> Config Parser -> Ticket Linkage -> Constitution Engine -> Diff State Manager -> Quorum Engine -> Octokit Publisher.
6. Implement unit & integration tests:
   - `tests/unit/webhook.test.ts`
   - `tests/unit/publisher.test.ts`
   - `tests/integration/m4_webhook.test.ts`
7. Execute verification commands:
   - `npm run build` (must complete with 0 compilation errors)
   - `npm test` (must complete with 100% tests passing)
   - `npm run test:e2e` (if present)

Document your progress in `progress.md` in your working directory and write a complete handoff report to `handoff.md` including exact command outputs and passing test summaries.
When finished, send a message to caller (parent subagent ID: `bff3d692-29d2-4abc-9b6f-67d7d7176f1f`).
</USER_REQUEST>
