# 0002. Versioned severity policy and finding convergence

Status: accepted. This versioned revision preserves v1's required-P2 contract while defining the
opt-in v2 severity behavior.

## Context

The original v1 severity ladder had three levels that could reach a published check: P0 (critical),
P1 (defect) and P2 (smaller defect or quality issue). The policy for P2 changed twice in a short time:

1. P2 was made blocking with an environment switch. Every P2-only review then published
   `Review Yeti: SHIP` next to a failed raw check, and the summary counted P2s as "blocking P0/P1".
2. #1281 reverted that: only P0/P1 blocked, P2 was advisory again.

The original required-P2 decision is retained for v1 receipts and configurations. New reviews may
opt into the versioned `review-yeti-severity.v2` contract. This revision keeps the v1 wire meaning
intact while allowing P2, P3 and NIT observations to remain visible without creating required
GitHub conversations.

## Decision

The behavior is selected by an explicit policy version. Without a trusted
`review-yeti-severity.v2` setting, v1 behavior remains unchanged: P0, P1 and P2 findings are
required and use the existing convergence rules. Under v2, P0 and P1 findings block; P2, P3 and NIT
are advisory. P0/P1 blocker claims carry a verified trigger, impact and violated contract. A
confidence score, finding count, or prior thread resolution cannot waive a verified current P0/P1.
If required blocker evidence is absent, the finding is retained as an advisory P2 with provenance.

One shared v2 decision (`src/review/reviewDecision.ts`, `evaluateReviewDecisionV2`) binds policy
version and digest, coverage, quorum, infrastructure state, expected and completed lanes, and all
five severity counts. The worker produces the receipt and the service recomputes it from canonical
findings and trusted coverage before Gate eligibility. A mismatch or incomplete coverage fails
closed. V1 receipts are never silently regraded under v2, and an untrusted worker cannot activate
v2 by setting a receipt field.

Convergence rules:

1. **Fixed findings drop.** Only findings the current run reports can block. A prior thread whose
   finding is not reported again never counts.
2. **Stable identity across heads.** Every finding has a fingerprint built from its file, its claim
   archetype and the claim tokens of its title. Lines, body wording and severity are excluded. A
   current finding matches a prior thread by exact fingerprint first, then by the existing
   same-claim comparison (`compareClaims`), and inherits the prior fingerprint. A known finding is
   carried, not re-raised as new, and gets no second thread.
3. **V1 convergence is preserved.** An author can satisfy a required P2 with a stated reason on its
   resolved review thread; outside-diff P2 findings are advisory. Those rules apply only to v1.
4. **V2 advisories never require a conversation.** P2, P3 and NIT remain in the full versioned
   receipt and may be summarized in check output, but are not published as required inline review
   threads and never appear in a required-finding footer. The check may display the five
   highest-priority advisories while retaining all findings and counts in the receipt.
5. **V2 blockers cannot be cleared by stale thread state.** A current verified P0/P1 remains
   blocking even if an older matching thread was resolved. Only current canonical evidence and
   trusted coverage determine the v2 decision.

Mechanism:

- V1 findings are published as pull-request review threads with a hidden marker
  (`<!-- review-yeti:finding v=1 fp=... sev=... t=... -->`). The worker reads threads with its
  repository read token (`pull_requests: read`).
- Only the review App's own v1 threads are trusted: the dispatch service reads threads for the worker
  (and for the Gate) and keeps only those whose author is the App's bot login, resolved once from
  GitHub's authenticated `/app` endpoint. A thread whose author cannot be verified is still used for
  identity (carried or dropped) but never satisfies a required P2.
- The worker never holds `pull_requests: write`. It sends new required findings to the dispatch
  service (`POST /api/dispatch/finding-threads`, authenticated with the per-run worker bearer). The
  service checks the execution, the head and that each fingerprint matches its content, mints a
  token whose whole grant is `pull_requests: write`, publishes the threads, and resolves only the
  bot's own threads that GitHub already marks outdated and that this head did not report.
- Under v1, the canonical arbitration verdict is unchanged and stays the evidence the service re-derives.
  When the verdict is SHIP but a required P2 remains, the published title reads
  `Review Yeti: FIX_FIRST (N required P2)` and the summary says why, so the check never reads SHIP
  next to a failure again.
- V1 Gate evidence carries the required `p2Count` after convergence on the service's own diff and
  thread read. Fresh v1 evidence without it is invalid (fail closed); historical stored rows are
  normalized at the existing prior-review boundary. V2 Gate evidence instead carries the exact
  recomputed decision receipt; the legacy P2 field must remain zero so a v2 advisory cannot block.

Guardrails this forbids: silently changing the meaning of v1 receipts; worker-controlled v2
activation; altered v2 severity counts or eligibility claims; using a finding-count or confidence
threshold to excuse P0/P1; publishing v2 advisory conversations that can remain unresolved under
repository protection; and a prior resolution clearing a current verified P0/P1.

## Alternatives

- **Regrade every receipt to the newest policy.** Rejected because a v1 receipt's P2 decision must
  keep its original meaning.
- **Publish v2 advisories as inline review threads.** Rejected because unresolved review
  conversations can block merges independently of the Review Yeti Gate.
- **A finding-count threshold.** Rejected because it can excuse a verified P0/P1 and measures
  volume rather than evidence.
- **Give the worker `pull_requests: write` and publish threads from the pod.** Rejected: the pod
  parses untrusted diffs and model output; the narrow service route keeps the write grant out of it.
- **Accept-risk label for P2.** Not needed: a stated reason on the thread is the per-finding,
  auditable form of the same consent.

## Consequences

- V1 heads retain required-P2 convergence behavior. V2 heads block only on verified P0/P1 findings
  and incomplete trusted coverage; P2/P3/NIT stay advisory.
- V2 full receipts retain every finding even when the rendered summary shows only five advisories.
- Scope: the DOKS worker's raw check and the service Gate, which are the production merge contract.
  Two other runtimes have no access to the bot's thread state and are deliberately not changed,
  because blocking on P2 there without convergence is exactly the alternative rejected above: the
  legacy GitHub Action pipeline (`.github/workflows/pipelines/review-pipeline.js`, the `local`
  execution backend), which still gates on the arbitration verdict, and the Cloudflare edge
  orchestrator's PR review payload (`cf-orchestrator/src/reviewPublisher.ts`), which still treats
  P2 as advisory in its review event. Neither publishes the required check.
- Model variance can still raise a new advisory on code the author just changed. V2 does not turn
  its review comment into a merge requirement; a newly verified P0/P1 remains blocking.

## Revisit when

- The deployer changes the severity policy.
- The `local` Action backend or the edge orchestrator becomes a primary path again: port the
  convergence decision to it (it needs the thread read), rather than blocking on raw severity.
- Satisfied-by-resolution is abused (for example, resolutions with boilerplate reasons): tighten
  `statedResolutionReason` or require a maintainer reply.
- Fingerprint matching shows false merges (two real defects treated as one) or misses (the same
  claim published twice) in production threads.
