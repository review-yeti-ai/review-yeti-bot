# Milestone 4 Explorer 2 Handoff Report — Webhook Event Dispatcher & Listener (`src/github/eventHandler.ts`)

**From**: Explorer 2 (`explorer_m4_2`)  
**To**: Milestone 4 Sub-Orchestrator (`bff3d692-29d2-4abc-9b6f-67d7d7176f1f`)  
**Date**: 2026-07-24  
**Working Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/explorer_m4_2`  
**Status**: **COMPLETED (Hard Handoff - Webhook Event Dispatcher Design Complete)**

---

## 1. Observation

1. **Target Architecture & Scope**:
   - `PROJECT.md` lines 7-53 and `SCOPE.md` specify `src/github/eventHandler.ts` as the Webhook Event Dispatcher & Listener.
   - Core triggers required:
     - PR lifecycle events (`pull_request`: `opened`, `synchronize`, `reopened`).
     - Comment commands (`issue_comment` / `pull_request_review_comment`: `@ct-review review`, `@bot review`, `@ct-review-bot review`).
     - Label/tag triggers (`pull_request`: `labeled` or PR labels matching `ct-review`, `ai-review`, `needs-review`, `bot-review`).
     - Background job queueing / async dispatching mechanism so HTTP webhooks return `200 OK` immediately (< 100ms) with a `jobId` while LLM reviews execute asynchronously in the background.
2. **Existing Implementation Analysis**:
   - `src/app.ts` currently handles webhooks synchronously (lines 142-475) inside a single inline route handler.
   - Existing mock test harness `tests/e2e/harness/mockGithubServer.ts` (lines 330-420) constructs standard GitHub `pull_request` and `issue_comment` payloads.
3. **Design Blueprint Completed**:
   - Comprehensive technical design document created at `.agents/explorer_m4_2/analysis.md` detailing interface definitions (`WebhookEvent`, `ParsedPRPayload`, `TriggerResult`, `ReviewJob`), class structure (`GitHubEventHandler`), trigger regex evaluator, bot self-loop prevention guard, FIFO async job queue, and integration guidelines for `webhookServer.ts` and `app.ts`.

---

## 2. Logic Chain

1. **Webhook Timeout Risk**: GitHub webhooks time out if an HTTP response is not sent within ~10 seconds. LLM multi-persona reviews involving ticket validation, constitution enforcement, diff state hashing, OmniRoute API calls, and Octokit comment posting take 2s–30s+. Therefore, synchronous processing inside Express HTTP handlers is unsuitable for production webhooks.
2. **Decoupled Architecture**: By implementing an asynchronous job queue (`AsyncJobQueue` / `GitHubEventHandler`) in `src/github/eventHandler.ts`:
   - Express server acknowledges webhook receipt within < 100ms with HTTP `200 OK` and `{ status: "queued", jobId: "job-..." }`.
   - The queue worker processes jobs asynchronously up to configurable concurrency limit (`maxConcurrency = 3`), executing the review pipeline via a `ReviewRunnerCallback`.
3. **Payload Normalization**: Different GitHub webhook events supply PR data in different shapes (e.g. `payload.pull_request` vs. `payload.issue` vs. `payload.comment`). Extracting metadata into a normalized `ParsedPRPayload` object insulates downstream evaluation engines from GitHub payload variations.
4. **Loop & Noise Prevention**: Checking `sender.login.includes('[bot]')` or matching bot usernames prevents infinite feedback loops where bot review comments trigger additional review cycles.

---

## 3. Caveats

1. **In-Memory Queue Persistence**: The proposed background job queue in `GitHubEventHandler` operates in-memory. If the process is terminated (e.g., container restart), queued or processing jobs will be lost unless re-delivered by GitHub. For digital transformation to production persistent queues (e.g., Redis/BullMQ), the queue interface can be swapped cleanly.
2. **GitHub API PR Resolution for Issue Comments**: When a user comments `@ct-review review` on a PR, the `issue_comment` event payload might omit `head.sha` or `changed_files`. The `ReviewRunnerCallback` or `commentPublisher` must fall back to fetching PR details via GitHub REST API (`GET /repos/{owner}/{repo}/pulls/{number}`) if `headSha` is not embedded in the webhook payload.

---

## 4. Conclusion

The design specification for `src/github/eventHandler.ts` is **fully complete**, self-contained, and ready for immediate implementation by Worker agents. All required data interfaces (`WebhookEvent`, `ParsedPRPayload`, `TriggerResult`, `ReviewJob`), trigger evaluators, bot guards, async queue mechanics, and integration blueprints are documented in `.agents/explorer_m4_2/analysis.md`.

---

## 5. Verification Method

To verify this design upon implementation:
1. Inspect design document:
   ```bash
   cat /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/explorer_m4_2/analysis.md
   ```
2. Verify TypeScript compilation after Worker implements `src/github/eventHandler.ts`:
   ```bash
   npm run build
   ```
3. Run unit and integration tests:
   ```bash
   npm test
   ```
