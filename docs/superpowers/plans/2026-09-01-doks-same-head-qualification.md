# DOKS Same-Head Qualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare one real pull-request head through DOKS and the hosted Action without giving the DOKS worker any GitHub write path or changing production routing.

**Architecture:** Add an explicit `same-head` qualification profile beside the existing deterministic `full-panel` profile. A short-lived, repository-scoped GitHub App token may read PR metadata and the diff; the worker validates the projected base/head before and after the read, executes the qualified six-persona panel, writes only a sanitized PVC receipt, and cannot load publication credentials. The operator admits this profile only from an immutable v1alpha2 CR and keeps both worker and Job inside the original 15-minute terminal window.

**Tech Stack:** Node.js 24, TypeScript, Octokit Core, Vitest, Go 1.22+, controller-runtime/Kubernetes v1alpha2 CRD, DOKS, OpenRouter SDK.

**Spec:** `docs/superpowers/specs/2026-08-30-doks-review-dispatch-design.md`

**Status (2026-09-02):** The optional, read-only same-head capability is
implemented and released through `v1.24.0`. Finding fingerprints now permit a
privacy-preserving multiset comparison. A known-defect pair using the same
immutable worker, exact PR head, policy/config digests, direct OpenRouter model,
and eight-lane topology completed without retries or GitHub writes. Both DOKS
and hosted returned `BLOCK` with P0 0, P1 4, and P2 5; both included the planted
line-8 P1 anchor, and five of nine anchors overlapped in the first hosted pair.
DOKS reached the review process in 16 seconds and completed in 186 seconds;
the comparable hosted run reached the engine in 20 seconds and completed in
148 seconds. Production activation remains disabled pending the separately
reviewed App-installation and required-check rollout decision. See
`docs/superpowers/evidence/2026-09-02-doks-same-engine-parity.md`.

## Global Constraints

- No scheduled canary, recurring workflow, traffic split, or automatic production activation.
- `REVIEW_PUBLICATION_MODE=disabled`, `githubWrites=0`, and `automountServiceAccountToken=false` are mandatory.
- The worker receives only a run-scoped GitHub installation token restricted to the qualification repository with `contents: read` and `pull_requests: read`; it never receives the App private key.
- Projected repository, PR, base SHA, and head SHA must match GitHub before and after diff retrieval or the run fails before provider admission.
- The complete run remains bounded by the original 900-second terminal deadline with the existing 60-second worker-to-Job and Job-to-terminal reserves.
- The route remains explicit: `deepseek/deepseek-v4-flash-0731`, then `z-ai/glm-5.3-flash`; `openrouter/auto` is forbidden.
- Receipts contain digests, counts, timings, usage, cost, model attribution, and classified failures only. They never contain a token, private key, authenticated URL, raw diff, prompt, or provider response.
- The hosted Action remains production authority. Required-check publication and unresolved-thread blocking remain a separate plan.

---

### Task 1: Mint a repository-scoped read-only GitHub App token

**Files:**
- Modify: `src/github/appAuth.ts`
- Modify: `tests/unit/appAuth.test.ts`
- Create: `scripts/mint-github-read-token.mjs`
- Create: `tests/unit/githubReadTokenScript.test.ts`

**Interfaces:**
- Consumes: existing App JWT and repository-installation lookup.
- Produces: `getGitHubAppRepositoryReadToken(config, fetchFn): Promise<InstallationTokenResult>` and a pipe-only CLI.

- [x] **Step 1: Write the failing restricted-token test**

Call `getGitHubAppRepositoryReadToken` with a fake fetch implementation. Assert the first request resolves `/repos/review-yeti-ai/ct-pr-operator-sandbox/installation` and the second posts to `/app/installations/42/access_tokens` with exactly:

```json
{
  "repositories": ["ct-pr-operator-sandbox"],
  "permissions": {"contents": "read", "pull_requests": "read"}
}
```

Assert the result begins `ghs_`, every returned permission is `read`, and no request URL contains a credential.

- [x] **Step 2: Run RED**

```bash
npx vitest run tests/unit/appAuth.test.ts
```

Expected: FAIL because the restricted-token function does not exist.

- [x] **Step 3: Implement the restricted exchange**

Add:

```ts
export async function getGitHubAppRepositoryReadToken(
  config: GitHubRepositoryInstallationConfig,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<InstallationTokenResult>
```

Resolve the installation ID, generate a fresh JWT, post the exact repository/permission body with a five-second timeout, and reject a missing/non-`ghs_` token, invalid expiration, write permission, or non-2xx response. Error text contains only status and classification.

- [x] **Step 4: Add and test the pipe-only CLI**

`scripts/mint-github-read-token.mjs` requires `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and one `owner/repo` argument. It writes only the token plus newline to stdout and non-secret diagnostics to stderr. Spawn it against a local fake endpoint; assert stdout is exactly the token and all errors omit the key and token.

```bash
npx vitest run tests/unit/appAuth.test.ts tests/unit/githubReadTokenScript.test.ts
npm run lint
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/github/appAuth.ts tests/unit/appAuth.test.ts scripts/mint-github-read-token.mjs tests/unit/githubReadTokenScript.test.ts
git commit -m "feat(github): mint repository-scoped review tokens"
```

---

### Task 2: Read and bind one exact PR diff without GitHub writes

**Files:**
- Create: `src/github/qualificationReader.ts`
- Create: `tests/unit/qualificationReader.test.ts`
- Modify: `src/cli/workerSelfTestModules.json`

**Interfaces:**
- Consumes: `ghs_` token, `owner/repo`, PR number, expected base SHA, and expected head SHA.
- Produces: `loadSameHeadReviewSource(input, requestFn?): Promise<SameHeadReviewSource>` with `diff`, `diffDigest`, `baseSha`, `headSha`, and `githubReads: 3`.

- [x] **Step 1: Write failing exact-head tests**

Cover: matching metadata/diff/repeated metadata; initial head mismatch; base mismatch; final head movement; empty or greater-than-2,000,000-byte diff; classified 401/403/404/429/5xx; and exactly three GETs with no write verb. Use a hand-calculated literal digest.

- [x] **Step 2: Run RED**

```bash
npx vitest run tests/unit/qualificationReader.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement the read-only boundary**

```ts
export interface SameHeadReviewSource {
  baseSha: string;
  headSha: string;
  diff: string;
  diffDigest: string;
  githubReads: 3;
}

export async function loadSameHeadReviewSource(
  input: {
    token: string;
    repo: string;
    prNumber: number;
    expectedBaseSha: string;
    expectedHeadSha: string;
  },
  requestFn?: Octokit['request'],
): Promise<SameHeadReviewSource>
```

Use PR metadata before and after the PR diff request with `Accept: application/vnd.github.v3.diff`. Reject oversized input rather than truncating it. Do not expose a generic write-capable Octokit client.

- [x] **Step 4: Add the module to the worker self-test and verify**

```bash
npx vitest run tests/unit/qualificationReader.test.ts tests/unit/workerContainerContract.test.ts
npm run build:backend
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/github/qualificationReader.ts tests/unit/qualificationReader.test.ts src/cli/workerSelfTestModules.json
git commit -m "feat(worker): bind qualification input to exact PR head"
```

---

### Task 3: Add the sanitized same-head panel profile

**Files:**
- Modify: `src/cli/runLiveReview.ts`
- Modify: `tests/unit/receiptOnlyWorker.test.ts`

**Interfaces:**
- Consumes: the same-head source loader, existing full-panel config/request policy, `GH_TOKEN`, and immutable projection.
- Produces: `runSameHeadQualificationWorker(env, panelRunner?, client?, sourceLoader?): Promise<SameHeadQualificationReceipt>`.

- [x] **Step 1: Write failing mode-isolation tests**

Prove the mode is valid only when all other worker modes are absent, publication is disabled, receipt path/model are exact, and `GH_TOKEN` begins `ghs_`. Mixed modes, App private key, missing token, or publication enablement must fail before any source/provider call.

- [x] **Step 2: Write the failing receipt test**

Use literal source and complete `PanelResult` fixtures. Require `profile: 'same-head'`, `source: 'github-pull-request'`, projected base/head, diff digest, 6/6 personas, zero optional failures, quorum/verdict, `githubReads: 3`, `githubWrites: 0`, and usage/cost/timing. Serialized output must omit diff, token, prompts, responses, and App credentials.

- [x] **Step 3: Run RED**

```bash
npx vitest run tests/unit/receiptOnlyWorker.test.ts
```

Expected: FAIL because the same-head runner does not exist.

- [x] **Step 4: Extract one shared full-panel executor and implement**

Move fixture-independent execution, accounting, deadline handling, failure classification, and sanitized receipt writing into one internal helper. The deterministic wrapper supplies its fixture; the same-head wrapper supplies parsed GitHub diff files. Preserve DeepSeek-to-GLM policy, three-call concurrency, strict schemas, six required personas, moderator, arbiter, and digest logic.

- [x] **Step 5: Verify success and failure receipts**

Cover SHA mismatch, moved head, GitHub rate limit, structured-output failure, provider timeout, and overall deadline. Every failure receipt remains bounded with `githubWrites: 0`.

```bash
npx vitest run tests/unit/receiptOnlyWorker.test.ts tests/unit/qualificationReader.test.ts tests/unit/openRouterClient.test.ts
npm run build:backend
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/cli/runLiveReview.ts tests/unit/receiptOnlyWorker.test.ts
git commit -m "feat(worker): add same-head DOKS qualification"
```

---

### Task 4: Admit same-head Jobs only by explicit operator profile

**Files:**
- Modify: `k8s-operator/api/v1alpha2/prreviewjob_types.go`
- Modify: `k8s-operator/config/crd/bases/review-yeti.ai_prreviewjobs.yaml`
- Modify: `k8s-operator/api/v1alpha2/crd_contract_test.go`
- Modify: `k8s-operator/pkg/job/job.go`
- Modify: `k8s-operator/pkg/job/job_test.go`

**Interfaces:**
- Consumes: `qualificationProfile: same-head`, explicit model, and a run Secret with `OPENROUTER_API_KEY` plus `GITHUB_READ_TOKEN`.
- Produces: a Job with `REVIEW_SAME_HEAD_QUALIFICATION_ONLY=true`, `GH_TOKEN` from the run Secret, derived deadline, and no App/private/publication credential.

- [x] **Step 1: Write failing CRD tests**

Require exactly `full-panel` and `same-head` in the profile enum. The CEL rule keeps omitted profile/model receipt-only and requires a non-auto model for either explicit profile.

- [x] **Step 2: Write failing Job tests**

Assert the same-head Job has its exclusive mode flag, Secret-backed `GH_TOKEN`/OpenRouter key, `780000`ms internal and `840`s Job deadline when fresh, no App credential, no publication credential, no service-account token, and zero backoff.

- [x] **Step 3: Run RED**

```bash
cd k8s-operator
go test ./api/v1alpha2 ./pkg/job -count=1
```

Expected: FAIL because only `full-panel` is admitted.

- [x] **Step 4: Implement the minimal extension**

Add `same-head` to kubebuilder enum, checked-in CRD, validation helper, and Job environment branch. Do not change dispatcher defaults, receipt-only behavior, replicas, App gate, or publication.

- [x] **Step 5: Verify**

```bash
cd k8s-operator
go test ./...
go vet ./...
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add k8s-operator/api/v1alpha2/prreviewjob_types.go k8s-operator/config/crd/bases/review-yeti.ai_prreviewjobs.yaml k8s-operator/api/v1alpha2/crd_contract_test.go k8s-operator/pkg/job/job.go k8s-operator/pkg/job/job_test.go
git commit -m "feat(doks): admit read-only same-head qualification"
```

---

### Task 5: Land and release the inert capability

**Files:**
- Modify only if protected review requires: files from Tasks 1–4.

**Interfaces:**
- Consumes: focused green suites and protected workflow.
- Produces: merged reviewed source and immutable release; no activation.

- [x] **Step 1: Run pre-PR verification**

```bash
npm test
npm run build
cd k8s-operator && go test ./... && go vet ./...
git diff --check
```

Expected: affected suites pass. Report unrelated baseline separately; never merge over a new affected failure.

- [x] **Step 2: Open and pass the protected PR**

State that the profile is explicit, read-only, nonpublishing, and not wired into Action/default dispatcher. Require exact-head `SHIP`, terminal hosted validation, and clean merge state.

- [x] **Step 3: Release without bypass**

Merge normally, merge the reviewed release PR, wait for the benchmark, and verify `main`, immutable semantic tag, and rolling `v1` resolve to the tested release commit.

- [x] **Step 4: Build immutable qualification images**

Build `linux/amd64` operator/worker OCI indexes from exact merged source with provenance/SBOM. Run the read-only worker self-test. Do not use broad `deploy=true`, which mutates unrelated services.

---

### Task 6: Run one manual same-head comparison and clean up

**Files:**
- Create: `docs/superpowers/evidence/2026-09-01-doks-same-head-qualification.md`
- Modify: this plan's status/next-decision text.

**Interfaces:**
- Consumes: one PR head already reviewed by hosted Action, immutable images, run-scoped OpenRouter key, and repository-scoped GitHub token.
- Produces: sanitized DOKS receipt and comparison of terminal status, verdict, findings, provider/model, usage, cost, timings, and publication suppression.

- [x] **Step 1: Verify the qualification PR identity**

Read repository, PR, base/head, hosted Action run, and merge state. Stop if the head moved or hosted result is not exact-head.

- [x] **Step 2: Install only reviewed additive CRD/operator revisions**

Run `kubectl diff` first. Preserve App gate false, dispatcher/action images, publication, replicas, and rollback digest. Roll back operator immediately on readiness/leader failure.

- [x] **Step 3: Pipe credentials into one run Secret**

Load App ID/private key from the existing cluster Secret only into local process environment, pipe the restricted token directly into the run Secret, and include OpenRouter without printing either. The Secret contains exactly `GITHUB_READ_TOKEN` and `OPENROUTER_API_KEY`.

- [x] **Step 4: Create exactly one same-head CR**

Set explicit profile/model, immutable base/head, disabled publication, exact worker digest, and timestamps exactly 900 seconds apart. Assert generated deadline and credential boundaries before provider execution.

- [x] **Step 5: Enforce acceptance**

Require completion within 15 minutes, stable exact SHA reads, 6/6 personas, zero optional failure, quorum/verdict, zero GitHub writes, and no raw diff/credential. Compare verdict agreement, severity/count deltas, latency, tokens, and cost without requiring identical wording.

- [x] **Step 6: Clean and verify 30-minute expiry**

Delete run Secret and inspector immediately. Preserve the same-PR PVC for 1,800 seconds, then verify operator deletes PVC and Lease. Confirm no Job/Pod/Secret remains and production route/App gate is unchanged.

- [x] **Step 7: Land evidence**

Record exact source/image/run identities and results. State explicitly that a pass still does not authorize required-check publication or production cutover.

---

## Next quality-parity decision

The v1.24.0 fingerprinted known-defect comparison passed. The next highest-ranked
work is a narrowly reviewed rollout boundary, not an automatic fleet flip:

1. Qualify the production GitHub App installation against every intended
   repository with repository-scoped `contents: read` and `pull_requests: read`.
   The current proof covers `review-yeti-ai/ct-pr-operator-sandbox` only.
2. Run manual, non-publishing replays for at least one clean fixture and one
   larger multi-file defect fixture. Require terminal completion, zero writes,
   expected finding direction, and comparable identity. Do not add a timer or
   recurring canary.
3. With separate explicit approval, propose one sandbox repository as the first
   DOKS publisher/required-check authority. Preserve the hosted Action as the
   one-change rollback and do not activate the fleet in the same change.
4. Verify publication, unresolved-thread blocking, exact-head behavior, and
   rollback before proposing any additional repository.

No schedule, recurring canary, automatic traffic split, or production
activation is authorized by this follow-up.
