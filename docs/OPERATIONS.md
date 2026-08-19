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

## Incident response: bad release

A "bad release" is a published `v1.x.y` commit that is causing consumers running `@v1` to see
verdict-gate failures, malformed output, or a review that never publishes — something the full
`test:all` gate should have caught but did not, or a regression that only shows up against real
provider traffic.

### Detection signals

Treat any of these as reason to open an incident, not just a support ticket:

- A spike in `INCOMPLETE_REVIEW`/`PARTIAL_REVIEW` or a new failure class in run reports across
  multiple unrelated consumer repositories at the same commit.
- Consumer-side merge-gate failures that correlate with a specific `v1` commit (check the run's
  resolved Action SHA, not just the `v1` tag name, in the workflow logs or run report).
- The compact per-head review receipt (see [`PUBLICATION_POLICY.md`](PUBLICATION_POLICY.md))
  missing, malformed, or asserting a verdict the sticky summary does not support.
- Reports from `calltelemetry/ct-review-actions`-fronted org consumers (the `pull_request_target`
  shim) failing their provenance gate — this can mean the resolved bot SHA stopped being
  release-tagged and reachable from `main`, which is itself a signal something upstream is wrong.

Confirm against the exact SHA before acting: resolve what `v1` currently points at
(`git rev-parse v1`) and compare it to the SHA in the failing run's logs. Do not roll back on a
consumer report alone — reproduce or confirm the resolved SHA first.

### Rollback

Once a bad `v1` commit is confirmed:

```bash
git push origin "+<good-sha>:refs/tags/v1"
```

See [`RELEASING.md`](RELEASING.md#rollback) for the full contract this command has: it is a
one-line, audited, required-checks-untouched tag move, and every consumer on `@v1` picks it up on
their next review run — typically minutes, not a fleet-wide re-pin. Do not delete or force-push
`main`, and do not touch the bad `vX.Y.Z` tag itself; it stays immutable as a historical record.
Open the incident issue in this repository before or immediately after the tag move, whichever is
faster — do not let the rollback wait on writing the issue first.

### Org break-glass override

Org consumers (calltelemetry and any other `ct-review-actions`-fronted org) select the bot by
channel (`action_channel: v1`) in their policy file, not by SHA. The `v1` rollback above heals
them automatically. Use the break-glass override only when a specific org needs to pin off the
channel entirely while a rollback is still in flight or under investigation:

1. In the `ct-review-actions` policy file, set `action_sha_override` to the last known-good bot
   SHA for the affected consumer(s).
2. This bypasses channel resolution for exactly those consumers; the provenance gate still
   requires the overridden SHA to be release-tagged and reachable from bot `main` — an override to
   an unreleased or dangling SHA is rejected, not silently accepted.
3. Remove the override once the `v1` tag rollback (or forward-fix release) is confirmed live and
   the affected consumers have run clean at least once. An override left in place indefinitely
   defeats the point of channel-based distribution — it is a bridge, not a new steady state.

Break-glass overrides are an org-level policy edit, not a per-repository consumer action; they go
through the same PR + required-checks path as any other `ct-review-actions` policy change.

### Comms

Post one status line per affected surface (org Slack channel, or a GitHub issue comment on the
incident issue) as soon as detection is confirmed, and update it at each state change:

```
Review Yeti: <what broke> — <what to do: nothing | re-run affected PRs> — <eta or "fixed as of <sha/tag>">
```

Example:

```
Review Yeti: v1.3.1 shipped a regression causing INCOMPLETE_REVIEW on Node 20 runners.
What to do: nothing — v1 has been rolled back to v1.3.0, re-run any PR that failed in the last 30
minutes. Fixed as of the v1 tag move at <timestamp>.
```

Keep it to the three fields — what broke, what the consumer does, and current status. Do not name
individual affected customers or organizations in the public status line or the incident issue;
describe the failure shape (endpoint, failure class, affected version) instead.
