# REL-861: incomplete review execution recovery

## Observed failure

The legacy review of `calltelemetry/ct-lab-mcp#63` at head
`9974d6deb66a0f1572bd382aa5dd19e8358f7710` completed three of five reviewer
lanes, failed two, and reported zero findings. It published `Review Yeti: BLOCK`
without the typed terminal failure callback. The normal deadline handler later
retired the run; that does not make the old check retryable or successful.

## Repairs

- Keep valid incomplete no-findings legacy panels failed, but publish the
  existing recoverable failure title and report exact attempt/check identity.
- Preserve all raw/canonical findings, invalid rosters, unreadable diff and
  authoritative service handling outside that narrow branch.
- Publish bounded counts and failure classification, never raw failed-lane
  provider response text. Failed check/callback acknowledgement remains failed.
- Remove the prior `INCOMPLETE` with empty findings to `APPROVE` normalization.
  Required incomplete lanes fail; optional incomplete lanes remain failed calls.
- No historical check, database row, policy, provider or deployment was changed.

## Verification

- 284 tests pass across publishingReview, workerCompletion, reviewRecoveryPolicy,
  panelEngineDeep and panelEngineExpansion.
- Backend TypeScript build and full-tree `tsc --noEmit` pass.
- Regression cases cover exact attempt identity, redaction, lost publication
  and callback acknowledgement, P1/P2 findings, discarded raw findings, and
  required/optional incomplete responses.

Central decision: ct-meta ADR 0595. Independent review, protected CI/landing,
immutable release deployment and live retry acceptance remain separate gates.
The parent REL-822 HMR/dashboard/video mission is not complete.
