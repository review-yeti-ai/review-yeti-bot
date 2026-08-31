# Provider Qualification Worker v1 Plan

> This plan is a manual qualification lane only. It is not a canary, has no schedule, never publishes to GitHub, and must not change production routing.

## Goal

Prove one explicitly selected OpenRouter model can complete a real streamed request through the admitted worker image while recording bounded, secret-free telemetry. Keep the existing receipt-only DOKS path and central GitHub Action unchanged.

## Safety contract

- The mode requires `REVIEW_PROVIDER_QUALIFICATION_ONLY=true` and `REVIEW_PUBLICATION_MODE=disabled`.
- `openrouter/auto` and `auto` are rejected; every run names one exact model.
- The worker makes one provider call, with a bounded timeout and `stream: true`.
- The worker performs no GitHub reads, GitHub App authentication, comments, reviews, or other writes.
- The receipt stores identity, requested/resolved model, response digest/length, usage, cost, and timestamps only. It never stores response text or credentials.
- The mode is never selected implicitly. Invalid combinations fail closed.

## Ordered execution

1. Add the worker contract and unit tests. Require a red test before implementation, then run the focused worker test and TypeScript check.
2. Review and land the worker change behind protected checks. Do not change the operator deployment, Action routing, model policy, or production image.
3. Build and push one digest-pinned qualification image. Record the exact digest; do not move a production tag.
4. Run one manually created, non-publishing qualification Job with a run-scoped OpenRouter secret, one exact model, and a timeout no greater than 15 minutes. Do not create a recurring Job or traffic split.
5. Read the receipt and provider telemetry, then delete the qualification Job, Pod, Secret, and any temporary workspace. Verify the production deployment and admission image are unchanged.
6. Acceptance for this slice is transport evidence only: one terminal success, one provider call, non-empty response, bounded timing, `githubWrites=0`, `publicationMode=disabled`, and no secret/raw response in the receipt. Review quality remains a separate evaluation and is not inferred from this result.

## Next gate

Only after this single-run evidence is clean should we design a separate fixture-backed panel qualification. That later test must remain manual, non-publishing, and bounded; it is not a production cutover approval.

## Rollback

Do not activate the mode. If the image or qualification fails, delete the temporary resources and leave the existing receipt-only/operator and GitHub Action paths unchanged.
