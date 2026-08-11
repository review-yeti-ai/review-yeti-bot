# Review Yeti operations

## Exact-head verification

Record the immutable base/head SHAs and source digest from the CLI receipt. The Action receipt and
the local receipt for identical inputs can be compared without comparing timestamps or publication
metadata:

```bash
node scripts/verify-action-cli-equivalence.mjs \
  --action-receipt ./action-receipt.json \
  --cli-receipt ./review-run.json
```

The command emits one `action-cli-equivalence-v1` JSON result and exits nonzero on an authority
receipt mismatch. A mismatch is evidence of an adapter bug, not a reason to ignore the result.

## Termination and rollback

Evidence budget exhaustion, repeated calls, provider failure, cancellation, missing units,
incomplete verification, invalid anchors, or stale identity produce `PARTIAL_REVIEW` or
`INCOMPLETE_REVIEW`; they are never a successful local review. Inspect the investigation and
review-unit receipts before retrying against the same immutable source.

The production rollback is a normal Git revert of the bounded-engine merge commit, followed by
the exact-head CI and Action checks. There is no shadow flag or default-off switch that pretends the
new engine is active while routing around its coverage contract.

## Evaluation evidence

The offline matrix is credential-free and deterministic:

```bash
npm run test:bounded-review-eval
npm run test:equivalence
```

Live provider evaluation is explicit and manual. Provider-reported token usage and cost are copied
from receipts; cost remains `null` when a provider omits it and is never estimated from runner
duration. Keep live receipts outside Git and redact provider credentials/transcripts.
