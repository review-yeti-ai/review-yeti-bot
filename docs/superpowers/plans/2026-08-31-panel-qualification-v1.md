# Panel Qualification Worker v1 Plan

> Manual qualification only. No scheduled canary, traffic split, production route change, or GitHub publication is allowed by this plan.

## Goal

Exercise one deterministic fixture through the real persona, moderator, and arbiter pipeline
using one explicitly named OpenRouter model. Capture aggregate telemetry without persisting
findings or provider response text.

## Safety contract

- Require `REVIEW_PANEL_QUALIFICATION_ONLY=true`, `REVIEW_PUBLICATION_MODE=disabled`, and one exact `REVIEW_QUALIFICATION_MODEL`.
- Reject `openrouter/auto`, provider-only mode, receipt-only mode, and invalid combinations.
- Use one required correctness persona, one provider, `fallback: none`, and bounded per-call and total deadlines.
- Do not fetch a GitHub PR, authenticate a GitHub App, post a comment/review, resolve threads, or mutate repository state.
- Persist only run identity, model identity, counts, verdict, aggregate usage/cost, timing, and a digest of the aggregate result.

## Ordered execution

1. Add the mode contract and tests with a red-first TDD cycle.
2. Land behind the normal AI-review and full-test protected checks.
3. Build one digest-pinned worker image and run its offline self-test.
4. Create exactly one manual DOKS Job with a run-scoped OpenRouter Secret, writable `/workspace` and `/tmp`, read-only root, no service-account token, and an 840-second Job deadline.
5. Read the sanitized receipt/log, then delete the Job, Pod, Secret, and temporary workspace by exact identity.
6. Verify the production dispatch Deployment, image, provider policy, and GitHub Action route are unchanged.

## Acceptance

The slice passes only when the Job reaches one terminal success, the real panel path completes
its required persona/moderator/arbiter calls, the quorum is satisfied, `githubWrites=0`,
publication is disabled, aggregate telemetry is bounded, and no secret/raw response is in the
receipt. This is transport/pipeline evidence, not approval for production cutover or a claim of
review-quality parity.

## Rollback

Do not activate the mode. On any failure, delete the temporary resources and leave the existing
receipt-only operator and central GitHub Action paths unchanged.
