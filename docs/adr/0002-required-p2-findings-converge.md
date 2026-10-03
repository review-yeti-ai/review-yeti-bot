# 0002. P2 findings are required, and required findings converge

Status: accepted. Reverses the "P2 is advisory" contract of #1281 and the opt-in variant before it.

## Context

The severity ladder has three levels that can reach a published check: P0 (critical), P1 (defect)
and P2 (smaller defect or quality issue). The policy for P2 has changed twice in a short time:

1. P2 was made blocking with an environment switch. Every P2-only review then published
   `Review Yeti: SHIP` next to a failed raw check, and the summary counted P2s as "blocking P0/P1".
2. #1281 reverted that: only P0/P1 blocked, P2 was advisory again.

The deployer has now decided that P2 findings must be addressed before merge. That decision is the
forcing function for this record. The earlier blocking attempt also showed what goes wrong when P2
blocks with no other change: it does not converge. Every new head is a fresh model run. On the last
batch of pull requests each push produced new P2s on the lines the author had just touched, and the
same nit came back under a new title, so fixing P2s never ended in a green check.

## Decision

P0, P1 and P2 findings all block a merge. There is no environment switch; it is not a deployment
option. To make that policy finite, one shared decision (`src/review/findingConvergence.ts`,
`evaluateFindingConvergence`) decides which findings still block on a given head. Both the worker's
raw `Review Yeti` check and the service Gate use it.

Convergence rules:

1. **Fixed findings drop.** Only findings the current run reports can block. A prior thread whose
   finding is not reported again never counts.
2. **Stable identity across heads.** Every finding has a fingerprint built from its file, its claim
   archetype and the claim tokens of its title. Lines, body wording and severity are excluded. A
   current finding matches a prior thread by exact fingerprint first, then by the existing
   same-claim comparison (`compareClaims`), and inherits the prior fingerprint. A known finding is
   carried, not re-raised as new, and gets no second thread.
3. **The author can close a P2 with a stated reason.** Resolving the finding's review thread with a
   human reply that states why it does not apply satisfies that P2 on every later head. The reason
   and its author are shown in the check summary. One-word acknowledgements, bot replies and a
   resolved thread with no reply do not count. A resolution never satisfies a P0 or P1.
4. **Outside the diff is advisory.** A P2 that is not anchored to a line the pull request adds or
   changes at the new head (or to a changed gitlink path) does not block.

Mechanism:

- Findings are published as pull-request review threads with a hidden marker
  (`<!-- review-yeti:finding v=1 fp=... sev=... t=... -->`). The worker reads threads with its
  repository read token (`pull_requests: read`).
- Only the review App's own threads are trusted: the dispatch service reads threads for the worker
  (and for the Gate) and keeps only those whose author is the App's bot login, resolved once from
  GitHub's authenticated `/app` endpoint. A thread whose author cannot be verified is still used for
  identity (carried or dropped) but never satisfies a P2.
- The worker never holds `pull_requests: write`. It sends new required findings to the dispatch
  service (`POST /api/dispatch/finding-threads`, authenticated with the per-run worker bearer). The
  service checks the execution, the head and that each fingerprint matches its content, mints a
  token whose whole grant is `pull_requests: write`, publishes the threads, and resolves only the
  bot's own threads that GitHub already marks outdated and that this head did not report.
- The canonical arbitration verdict is unchanged and stays the evidence the service re-derives.
  When the verdict is SHIP but a required P2 remains, the published title reads
  `Review Yeti: FIX_FIRST (N required P2)` and the summary says why, so the check never reads SHIP
  next to a failure again.
- The Gate evidence carries a required `p2Count`, the required P2 count after convergence on the
  service's own diff and thread read. Fresh evidence without it is invalid (fail closed); a stored
  gate row written before this decision is normalized to zero at the single place stored rows are
  read for prior-review reuse.

Guardrails this forbids: a P2 switch in configuration; counting a P2 as satisfied when thread state
could not be read (a failed read makes the check stricter, never looser); a resolution clearing a
P0/P1; auto-resolving a current-line thread because one run did not report it.

## Alternatives

- **Keep P2 advisory (#1281).** Rejected by the deployer. Would win again only if the deployer
  reverses the policy decision itself.
- **Block on P2 with no convergence (the first attempt).** Rejected: the evidence above shows it
  loops. Would only be viable with a deterministic reviewer.
- **A P2 count threshold (`p2BlocksMerge`).** Rejected: it measures review volume, not whether the
  author addressed anything, and it does not converge either.
- **Give the worker `pull_requests: write` and publish threads from the pod.** Rejected: the pod
  parses untrusted diffs and model output; the narrow service route keeps the write grant out of it.
- **Accept-risk label for P2.** Not needed: a stated reason on the thread is the per-finding,
  auditable form of the same consent.

## Consequences

- A head with an unresolved, in-diff P2 is red. Authors either fix it or resolve its thread with a
  reason; the next head turns green when nothing else is required.
- A review that still carries a required P2 is not a clean prior for incremental re-review or the
  verdict cache, so those reuse less until the P2s are cleared.
- Scope: the DOKS worker's raw check and the service Gate, which are the production merge contract.
  Two other runtimes have no access to the bot's thread state and are deliberately not changed,
  because blocking on P2 there without convergence is exactly the alternative rejected above: the
  legacy GitHub Action pipeline (`.github/workflows/pipelines/review-pipeline.js`, the `local`
  execution backend), which still gates on the arbitration verdict, and the Cloudflare edge
  orchestrator's PR review payload (`cf-orchestrator/src/reviewPublisher.ts`), which still treats
  P2 as advisory in its review event. Neither publishes the required check.
- Model variance can still raise a new P2 on code the author just changed. That is a real new
  finding under this policy; the author resolves it with a reason if it does not apply.

## Revisit when

- The deployer changes the severity policy.
- The `local` Action backend or the edge orchestrator becomes a primary path again: port the
  convergence decision to it (it needs the thread read), rather than blocking on raw severity.
- Satisfied-by-resolution is abused (for example, resolutions with boilerplate reasons): tighten
  `statedResolutionReason` or require a maintainer reply.
- Fingerprint matching shows false merges (two real defects treated as one) or misses (the same
  claim published twice) in production threads.
