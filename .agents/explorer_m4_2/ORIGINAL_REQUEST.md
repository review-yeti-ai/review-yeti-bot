## 2026-07-24T10:34:47Z
You are Explorer 2 for Milestone 4 (GitHub App & Webhook Receiver Event Loop) of `ct-review-bot`.
Your working directory is: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/explorer_m4_2`.
Target project root: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`.

Read the following project specifications and previous handoffs:
- Project spec: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/orchestrator/PROJECT.md`
- Scope document: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m4/SCOPE.md`
- Milestone 1 handoff: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m1/handoff.md`
- Milestone 2 handoff: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m2/handoff.md`
- Milestone 3 handoff: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m3/handoff.md`

Your task:
Investigate and design implementation specs for:
1. `src/github/eventHandler.ts`: Webhook Event Dispatcher & Listener handling:
   - PR events (`pull_request`: `opened`, `synchronize`, `reopened`).
   - Comment command triggers (`issue_comment` / `pull_request_review_comment`: `@ct-review review`, `@bot review`).
   - Label/tag triggers (e.g. `labeled` event or labels in PR payload).
   - Background job queueing / async dispatching mechanism so webhook responds quickly (200 OK) while review workflow runs.
2. Interface definitions for webhook events, payload mapping to internal review data structures.

Maintain `progress.md` in your working directory.
Write a comprehensive design & analysis report to `analysis.md` and `handoff.md` in your working directory.
When done, send a message to the caller (parent subagent ID: `bff3d692-29d2-4abc-9b6f-67d7d7176f1f`).
Remember: You are READ-ONLY exploration agent. Do NOT modify source code files.
