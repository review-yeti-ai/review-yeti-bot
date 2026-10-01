# Graceful Review Closeout and Exact-Head Resume

Status: source implementation validated; protected landing and deployment pending

## Service contract

- A review has one 25-minute admitted lifecycle deadline.
- Evidence collection ends at the earlier of its configured limit or `terminalDeadline - 5 minutes`.
- The final five minutes are reserved for deterministic synthesis, durable completion, and GitHub publication. The worker Job keeps the existing last-minute hard-stop reserve inside that closeout window.
- Reaching the evidence cutoff is not a code verdict and never becomes `SHIP`. Review Yeti publishes `INCOMPLETE (partial evidence published)` with every validated finding already collected.
- Review tasks run in deterministic risk order: security-sensitive and CI/IaC paths first, then security, contract, dependency, architecture, performance, testing, and licensing work.

## Durable progress

- The worker writes a bounded `ReviewExecutionCheckpoint.v1` after planning and after every completed task.
- The service authenticates the exact live worker token, binds the checkpoint to run/repository/PR/head/base/policy/config, and accepts only increasing revisions.
- Checkpoints contain the validated plan and validated completed-task findings. They never contain prompts, model transcripts, secrets, arbitrary tool output, or an approval claim.
- An exact-head retry re-validates the stored plan and findings against the current diff, restores completed tasks, and dispatches only pending tasks.
- A changed head, policy, config, repository, PR, or run cannot reuse the checkpoint.

## Closeout behavior

1. Stop admitting new evidence work at minute 20.
2. Cancel in-flight provider/tool operations through the shared evidence signal.
3. Fold completed and resumed task findings through canonical arbitration.
4. Mark missing tasks as timeout gaps and keep quorum/coverage fail-closed.
5. Persist the terminal worker result before publishing the raw check.
6. Publish findings, coverage, completed/pending task counts, telemetry, and the resumable `INCOMPLETE` outcome before the Job hard stop.

## Rollout tasks

- [x] Split the admitted lifecycle into 20-minute evidence and 5-minute closeout phases.
- [x] Preserve completed composed-task evidence when the evidence signal expires.
- [x] Add risk-ordered task dispatch.
- [x] Add exact-head monotonic checkpoint storage and worker read/write transport.
- [x] Resume completed tasks without repeating provider work.
- [x] Add focused deadline, graceful-publication, checkpoint-auth, hard-hang closeout, and resume tests.
- [x] Update the operator/CRD/chart deadline contract and regenerate artifacts.
- [ ] Land the source release through protected review.
- [ ] Roll out dispatcher, worker, operator, and CRD in a compatibility-safe order.
- [ ] Run one manual, non-recurring same-head acceptance review and verify partial/final publication telemetry.
