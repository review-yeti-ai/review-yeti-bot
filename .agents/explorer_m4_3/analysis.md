# Milestone 4 Technical Analysis & Design Specification
## Component 4: Octokit PR Comment Publisher (`src/github/commentPublisher.ts`)
## Component 5: Native Event Loop Integration (`src/app.ts`)
## Component 6: Test Suite Architecture (`tests/unit/webhook.test.ts`, `tests/unit/publisher.test.ts`, `tests/integration/m4_webhook.test.ts`)

---

## 1. Executive Summary

Milestone 4 completes the operational feedback loop for `ct-review-bot` by connecting incoming GitHub Webhook events directly to the core analysis engines developed in Milestones 1–3 (Config Parser, Ticket Linkage, Constitution Engine, Incremental Diff State Manager, and Quorum Review Panel), and publishing structured inline code review suggestions and top-level PR reviews back to GitHub via Octokit.

This report provides the detailed engineering specification for:
1. `src/github/commentPublisher.ts`: The Octokit PR Comment & Review Publisher with exponential backoff, rate-limit retry, inline ` ```suggestion ` formatting, and thread deduplication.
2. `src/app.ts`: The native Express event loop connecting all 6 pipeline stages with short-circuit gating for tickets and constitution compliance.
3. Test suite specifications (`tests/unit/webhook.test.ts`, `tests/unit/publisher.test.ts`, `tests/integration/m4_webhook.test.ts`).

---

## 2. Component Design: Octokit PR Comment Publisher (`src/github/commentPublisher.ts`)

### 2.1 Interface & Data Models

```typescript
import { PersonaFinding } from '../quorum/quorumEngine';
import { QuorumResult } from '../quorum/consensus';

export interface CommentPublisherOptions {
  githubToken?: string;
  baseUrl?: string; // Supports mock GitHub server or GitHub Enterprise Base URL
  maxRetries?: number;
  initialRetryDelayMs?: number;
  maxDelayMs?: number;
  userAgent?: string;
}

export interface PublishInlineCommentRequest {
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  path: string;
  line: number;
  side?: 'LEFT' | 'RIGHT';
  startLine?: number;
  finding: PersonaFinding;
}

export interface PublishReviewRequest {
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  body: string;
  inlineComments?: PublishInlineCommentRequest[];
}

export interface PublishResult {
  success: boolean;
  reviewId?: number;
  commentsCreated: number;
  rateLimitRemaining?: number;
  errors?: string[];
}
```

### 2.2 Formatting Inline Comments & ` ```suggestion ` Blocks

When a persona finding includes code recommendations or suggestions, `CommentPublisher` formats the inline comment body with standard GitHub markdown suggestion blocks:

```typescript
export function formatInlineCommentBody(finding: PersonaFinding): string {
  const personaEmoji: Record<string, string> = {
    security: '🛡️',
    architecture: '📐',
    performance: '⚡',
    quality: '🔍',
  };

  const emoji = personaEmoji[finding.persona.toLowerCase()] || '🤖';
  const severityFormatted = finding.severity.toUpperCase();

  let body = `### ${emoji} [${finding.persona.toUpperCase()}] Severity: ${severityFormatted}\n\n`;
  body += `${finding.comment}\n`;

  if (finding.suggestion || finding.codeSnippet) {
    const code = finding.suggestion || finding.codeSnippet;
    body += `\n\`\`\`suggestion\n${code}\n\`\`\`\n`;
  }

  return body;
}
```

### 2.3 Existing Thread & Comment Deduplication

To avoid redundant notifications and duplicate inline comments on identical lines across PR re-reviews:
1. `CommentPublisher` queries `GET /repos/{owner}/{repo}/pulls/{pr_number}/comments`.
2. Compares line numbers, file path, and signature (or fingerprint hash) of active comments against new findings.
3. If an unresolved comment already exists for `(path, line, persona)`, the publisher skips posting a duplicate comment.

### 2.4 Rate Limit, Exponential Backoff & Retry Logic

GitHub API requests are wrapped in an exponential backoff helper that respects `Retry-After`, `x-ratelimit-remaining`, and `x-ratelimit-reset` headers:

```typescript
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  pubOptions: CommentPublisherOptions
): Promise<Response> {
  const maxRetries = pubOptions.maxRetries ?? 3;
  let delay = pubOptions.initialRetryDelayMs ?? 1000;
  const maxDelay = pubOptions.maxDelayMs ?? 10000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (response.status === 429 || response.status === 403) {
        const retryAfter = response.headers.get('retry-after');
        const rateLimitReset = response.headers.get('x-ratelimit-reset');

        let waitMs = delay;
        if (retryAfter) {
          waitMs = parseInt(retryAfter, 10) * 1000;
        } else if (rateLimitReset) {
          const resetTimeMs = parseInt(rateLimitReset, 10) * 1000;
          waitMs = Math.max(0, resetTimeMs - Date.now());
        }

        waitMs = Math.min(waitMs, maxDelay);
        const jitter = Math.floor(Math.random() * 200);

        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, waitMs + jitter));
          delay *= 2;
          continue;
        }
      }

      return response;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw new Error('Max retries reached');
}
```

---

## 3. Native Event Loop Integration (`src/app.ts`)

### 3.1 6-Stage Execution Pipeline

```
  ┌─────────────────────────────────────────────────────────┐
  │ 1. Express Webhook Receiver & HMAC Signature Check      │
  └────────────────────────────┬────────────────────────────┘
                               │
                               ▼
  ┌─────────────────────────────────────────────────────────┐
  │ 2. Config Loader (.ct-review.yaml / Zod Schema)         │
  └────────────────────────────┬────────────────────────────┘
                               │
                               ▼
  ┌─────────────────────────────────────────────────────────┐
  │ 3. Ticket Linkage Validator (Linear/Jira/GitHub Regex)  │
  └────────────────────────────┬────────────────────────────┘
                               │
                               ▼
  ┌─────────────────────────────────────────────────────────┐
  │ 4. Constitution Engine (CONSTITUTION.md Evaluation)     │
  └────────────────────────────┬────────────────────────────┘
                               │
             ┌─────────────────┴─────────────────┐
             │ Ticket or Constitution Fail?      │
             └─────────┬─────────────────┬───────┘
                     YES │                 │ NO
                         ▼                 ▼
   ┌───────────────────────────┐ ┌───────────────────────────┐
   │ Short-Circuit Gating:     │ │ 5. Incremental Diff State │
   │ Decision: REQUEST_CHANGES │ │    Engine (SQLite / SHA)   │
   │ Skip LLM Router Calls     │ └─────────────┬─────────────┘
   └─────────────┬─────────────┘               │
                 │                ┌────────────┴────────────┐
                 │                │ Diff Unchanged?         │
                 │                └─────┬──────────────┬────┘
                 │                  YES │              │ NO
                 │                      ▼              ▼
                 │        ┌──────────────────┐ ┌──────────────────┐
                 │        │ Decision:        │ │ 6. Quorum Engine │
                 │        │ APPROVE          │ │    Fan-Out LLMs  │
                 │        │ Skip LLM Router  │ └────────┬─────────┘
                 │        └─────────┬────────┘          │
                 │                  │                   │
                 └──────────────────┼───────────────────┘
                                    │
                                    ▼
  ┌─────────────────────────────────────────────────────────┐
  │ 7. Octokit Comment Publisher                            │
  │    (Post Inline Suggestions & Top-Level Review Summary)  │
  └─────────────────────────────────────────────────────────┘
```

### 3.2 Key Integration Logic in `src/app.ts`

```typescript
// Pipeline Execution Flow within Express Webhook Handler
async function handleWebhookPipeline(payload: any, event: string): Promise<WebhookPipelineResult> {
  const pr = payload.pull_request || {};
  const repo = payload.repository || {};
  const owner = repo.owner?.login || 'calltelemetry';
  const repoName = repo.name || 'ai-workspace';
  const prNumber = pr.number || payload.number;
  const headSha = pr.head?.sha || 'head-sha-latest';
  const baseSha = pr.base?.sha || 'base-sha-latest';
  const title = pr.title || '';
  const body = pr.body || '';

  // Stage 1: Load Repository Config
  const config = loadRepositoryConfig();

  // Stage 2: Validate Ticket Linkage
  const ticketResult = validateTicketLinkage({ title, body, config: config.ticketEnforcement });

  // Stage 3: Evaluate Constitution Compliance
  const changedFiles = await getPRChangedFiles(owner, repoName, prNumber);
  const parsedConstitution = loadRepositoryConstitution();
  const constitutionResult = evaluateConstitution({
    constitution: parsedConstitution,
    config: config.constitution,
    prTitle: title,
    prBody: body,
    changedFiles,
  });

  // Short-Circuit Gating Check for Ticket or Constitution Failures
  if (!ticketResult.valid || !constitutionResult.compliant) {
    const summaryBody = formatFailureSummary({ ticketResult, constitutionResult });
    const publisher = new CommentPublisher({ baseUrl: process.env.GITHUB_API_BASE_URL });
    await publisher.publishReview({
      owner,
      repo: repoName,
      prNumber,
      commitSha: headSha,
      event: 'REQUEST_CHANGES',
      body: summaryBody,
    });

    return { decision: 'REQUEST_CHANGES', ticketValid: ticketResult.valid, constitutionCompliant: constitutionResult.compliant };
  }

  // Stage 4: Incremental Diff Delta Calculation
  const stateMgr = await getDiffStateManager();
  const updateResult = await stateMgr.processPRCommitUpdate({
    repoOwner: owner,
    repoName,
    prNumber,
    headSha,
    baseSha,
    hunks: changedFilesToHunks(changedFiles),
  });

  if (updateResult.previousState && updateResult.hunksToReview.length === 0) {
    // Diff unchanged: return APPROVE and skip LLM calls
    const publisher = new CommentPublisher({ baseUrl: process.env.GITHUB_API_BASE_URL });
    await publisher.publishReview({
      owner,
      repo: repoName,
      prNumber,
      commitSha: headSha,
      event: 'APPROVE',
      body: 'No diff changes detected since previous review pass. Review approved.',
    });
    return { decision: 'APPROVE', ticketValid: true, constitutionCompliant: true };
  }

  // Stage 5: Quorum Review Panel Engine Evaluation
  const quorumResult = await runQuorumReviewPanel({
    config,
    owner,
    repoName,
    prNumber,
    hunks: updateResult.hunksToReview,
  });

  // Persist findings in Diff State Persistence
  await stateMgr.processPRCommitUpdate({
    repoOwner: owner,
    repoName,
    prNumber,
    headSha,
    baseSha,
    hunks: changedFilesToHunks(changedFiles),
    quorumFindings: quorumResult.findings,
  });

  // Stage 6: Octokit Publisher Dispatch
  const publisher = new CommentPublisher({ baseUrl: process.env.GITHUB_API_BASE_URL });
  await publisher.publishQuorumReview({
    owner,
    repo: repoName,
    prNumber,
    commitSha: headSha,
    quorumResult,
    ticketResult,
    constitutionResult,
  });

  return {
    decision: quorumResult.decision,
    ticketValid: true,
    constitutionCompliant: true,
    findingsCount: quorumResult.findings.length,
  };
}
```

---

## 4. Test Suite Architecture & Specifications

### 4.1 Unit Test Suite 1: `tests/unit/webhook.test.ts`
- **Objective**: Validate Webhook Receiver HTTP endpoints, raw body retention, and HMAC SHA-256 signature verification.
- **Test Specifications**:
  1. `verifyWebhookSignature()` accurately verifies valid `X-Hub-Signature-256` computed over raw HTTP body buffers.
  2. `POST /webhook` returns `401 Unauthorized` when `X-Hub-Signature-256` is omitted or invalid.
  3. `POST /webhook` with event `ping` returns `200 OK { status: 'pong' }`.
  4. Unsupported webhook events/actions return `200 OK { status: 'ignored' }`.
  5. Exceptions occurring during processing return structured `500 Internal Server Error` JSON payload without crashing the Express server.

### 4.2 Unit Test Suite 2: `tests/unit/publisher.test.ts`
- **Objective**: Validate Octokit `CommentPublisher` inline comment formatting, review submission, thread deduplication, and rate-limit backoff logic.
- **Test Specifications**:
  1. `formatInlineCommentBody()` properly structures Markdown header, severity badge, emoji, comment text, and ` ```suggestion ` blocks.
  2. `publishInlineComment()` dispatches `POST /repos/:owner/:repo/pulls/:pr_number/comments` with correct parameters (`path`, `line`, `side: 'RIGHT'`).
  3. `publishReview()` dispatches `POST /repos/:owner/:repo/pulls/:pr_number/reviews` with specified review event (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`).
  4. Exponential backoff handler retries requests on HTTP 429 / 403 responses and respects `Retry-After` header values.
  5. Thread deduplication skips posting duplicate inline comments on paths and lines where active unresolved comments exist.

### 4.3 Integration Test Suite: `tests/integration/m4_webhook.test.ts`
- **Objective**: End-to-end integration of Webhook Receiver -> Config -> Ticket -> Constitution -> Diff State -> Quorum -> Octokit Publisher using `MockGithubServer` and Express.
- **Test Specifications**:
  1. **Full Approval Flow**: Valid ticket, compliant constitution, clean code -> returns `200 OK { decision: 'APPROVE' }` and posts `APPROVE` review to MockGithubServer.
  2. **Ticket Gating Short-Circuit**: Missing ticket in PR title/body -> short-circuits to `REQUEST_CHANGES`, 0 OmniRoute LLM calls made, posts `REQUEST_CHANGES` review detailing ticket failure.
  3. **Constitution Gating Short-Circuit**: Violation of forbidden path/rule -> short-circuits to `REQUEST_CHANGES`, 0 OmniRoute LLM calls made, posts `REQUEST_CHANGES` review.
  4. **Re-Review Trigger (`@ct-review review`)**: `issue_comment` payload with bot review command triggers full pipeline review pass.
  5. **Incremental Diff Filtering**: Subsequent PR commit with unchanged hunks skips LLM re-analysis and re-approves instantly.

---

## 5. Verification & Invalidation Conditions

### Verification Method
```bash
# 1. Verify TypeScript Compilation
npm run build

# 2. Execute Unit & Integration Test Suites
npm test

# 3. Verify Full E2E Test Suite Execution
npm run test:e2e
```

### Invalidation Conditions
- Any TypeScript compilation failure in `src/github/commentPublisher.ts` or `src/app.ts`.
- Failure to preserve raw request body for HMAC verification.
- Failure to short-circuit LLM router calls when ticket or constitution checks fail.
- Failure to format ` ```suggestion ` code blocks correctly.
- Failing any unit, integration, or E2E tests.
