# Full-panel DOKS qualification v2

**Status:** worker implemented; one manual DOKS execution completed and failed
closed in the licensing lane. See
`docs/superpowers/evidence/2026-09-01-doks-full-panel-v2.md`.

## Purpose

Exercise the complete Review Yeti panel path against one explicitly selected
OpenRouter model: six scoped personas, the moderator, and the arbiter. The
run is a qualification measurement only. It must not publish to GitHub, alter
the production route, or create a scheduled canary.

## Worker contract

Set all of the following in the disposable qualification Job:

- `REVIEW_FULL_PANEL_QUALIFICATION_ONLY=true`
- `REVIEW_PANEL_QUALIFICATION_ONLY=false`
- `REVIEW_PROVIDER_QUALIFICATION_ONLY=false`
- `REVIEW_RECEIPT_ONLY=false`
- `REVIEW_PUBLICATION_MODE=disabled`
- `REVIEW_RECEIPT_PATH=/workspace/.review-yeti/receipt.json`
- one exact `REVIEW_QUALIFICATION_MODEL` (for example `z-ai/glm-5.3-flash`)
- `REVIEW_QUALIFICATION_TIMEOUT_MS` no greater than `900000`

The worker rejects mixed modes, `openrouter/auto`, missing identity digests,
and any publication-enabled configuration. The OpenRouter credential must be
provided through the existing run-scoped Secret; it is never written to the
receipt or to the Job manifest as a literal value.

## What the run measures

The aggregate `ReviewYetiPanelQualification.v1` receipt records:

- eight or more streamed provider calls (six personas plus moderator and arbiter;
  bounded correction/retry calls may increase this count);
- `profile: full-panel`, `expectedPersonaCount: 6`, and actual `personaCount`;
- aggregate prompt/completion/total tokens, provider-reported cost, duration,
  model resolution, verdict, and a result digest;
- `publicationMode: disabled` and `githubWrites: 0`.

The six lanes are security, performance, architecture, testing, dependencies,
and licensing. All six are required for this qualification, so a missing lane
or optional failure fails closed instead of being hidden by a one-persona
quorum.

## Manual execution and acceptance

Create exactly one disposable Job from a digest-pinned worker image, using a
writable `/workspace`/`/tmp`, no service-account token, and a 15-minute outer
deadline. Read the sanitized receipt and pod timing, then remove the Job, Pod,
temporary Secret, and workspace by exact identity. No recurring resource is
permitted.

Accept only when:

1. the Job reaches a terminal success within the original 15-minute window;
2. `personaCount=6`, `expectedPersonaCount=6`, and `optionalFailureCount=0`;
3. quorum and arbiter verdict are present;
4. `publicationMode=disabled`, `githubWrites=0`, and no raw response or secret
   appears in the receipt; and
5. production Action/dispatcher/operator images and provider policy are
   unchanged.

This is a full-engine and transport measurement. It is not a quality-parity
claim and it does not exercise the central Action's striped multi-transport
planner; that remains a separate, explicitly designed experiment.

## Rollback

There is no activation switch to roll back. If the Job fails, delete its
disposable resources and leave the existing receipt-only operator and central
GitHub Action path unchanged.

## Next decision

Do not repeat the same Job unchanged. The next bounded change must address the
provider-independent structured-output contract (or add a provider-native JSON
response mode with an explicit nonce field) and add a focused regression test
for malformed fenced JSON. Re-run exactly one disposable full-panel Job only
after that change; production routing and the operator admission contract stay
unchanged until a complete sanitized receipt is observed.
