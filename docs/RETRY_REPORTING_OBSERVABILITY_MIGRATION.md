# Retry-reporting observability migration

This is a required consumer migration before deploying the worker's truthful
retry reporting. A completion acknowledgement proves delivery, not admission
or scheduling of another attempt. Do not restore the old scheduling claim to
keep a dashboard populated. Source merge alone does not prove that deployed
dashboards, alerts or saved log queries have migrated.

## Contract

The counter name remains `review_yeti_review_incomplete_infra_total`. Its
`failure_class` and `authoritative` labels are unchanged. The structured
warning's `reasonClass: incomplete_infra` and run/PR/head/attempt coordinates
also remain unchanged. Both the thrown-failure and returned-panel paths use
the following reporting states:

| New `outcome` / `retryStatus` | Meaning |
| --- | --- |
| `not_confirmed` | The execution attempt is eligible for consideration, but this worker has no retry-admission receipt. |
| `cap_exhausted` | Exactly attempt `RECOVERABLE_PANEL_AUTO_RETRY_CAP + 1` exhausted the automatic retry allowance. |
| `unknown` | The attempt value proves neither eligibility nor cap exhaustion. |

The warning payload replaces `retryScheduled: boolean` with `retryStatus`.
There is deliberately no compatibility `retryScheduled: true`: the old value
was derived from eligibility, so emitting it again would repeat the defect.
An actual schedule must be established from the dispatcher's corresponding
accepted-attempt evidence, not this warning or its completion ACK.

## Dashboard and alert queries

Migrate equality selectors explicitly:

| Old selector | New selector | Required wording |
| --- | --- | --- |
| `outcome="retrying"` | `outcome="not_confirmed"` | Retry unconfirmed, not retry scheduled/running. |
| `outcome="exhausted"` | `outcome="cap_exhausted"` | Automatic retry cap exhausted. |
| Only the two old values | Include `unknown` or remove the outcome filter for the total. | Infrastructure-incomplete events; unknown is a separate diagnostic category. |

A mixed-version selector can temporarily use:

```promql
review_yeti_review_incomplete_infra_total{outcome=~"retrying|exhausted|not_confirmed|cap_exhausted|unknown"}
```

This is a selector, not a replacement aggregation. Preserve the existing
worker DELTA aggregation and time window; do not substitute `rate()` or
`increase()` over worker pushes. After old workers have drained, use the
existing total aggregation without an outcome restriction, or select only the
three new states. Preserve any existing repository/authority/failure-class
scope. Do not sum an old and a new unfiltered total over the same samples,
which would double count them. Grouped historical panels must label old
`retrying` series as **legacy eligibility (scheduling unverified)** rather
than presenting them as confirmed dispatches. Retain an independent
`unknown` panel/alert so invalid attempt values do not disappear silently.

For log queries, replace `retryScheduled=true` eligibility filters with
`retryStatus=not_confirmed`; replace the old false bucket with an explicit
`cap_exhausted` or `unknown` category as appropriate. During mixed rollout,
branch on whether `retryStatus` is present, then read the legacy boolean only
for old records and label it scheduling-unverified. This is a consumer
classification rule, not a claim that the old and new fields prove the same
state. Engine-specific saved-query syntax must be validated in that engine.

## Rollout and proof

1. Inventory dashboard JSON, alert rules and saved log queries for this counter,
   `retryScheduled`, and the old outcome values. Record the exact consumer
   repository/revision and any externally managed queries; a tracked-source
   search is not proof about live dashboard state.
2. Land consumer query/copy changes before activating the new worker image.
   Keep the mixed-version query while old workers drain. No provider, Gate,
   retry-cap or deadline change is part of this migration.
3. Validate representative old records and all three new reporting states in
   panels and alert evaluation. The direct worker tests assert the actual
   warning and metric payloads; production display/evaluation still requires
   separate receipts. Verify a dispatcher receipt independently for any
   panel that claims a retry really was scheduled.
4. Record old-worker drainage and remove the old selectors. If rolling back
   the worker, restore the mixed query first; retain the new queries and
   historical data rather than deleting them.

Implementation: `src/cli/publishingReview.ts` and `src/telemetry/metrics.ts`.
Direct payload controls: `tests/unit/rel1124ThrownPanelInfrastructure.test.ts`;
reporting-state controls: `tests/unit/publicationFailurePolicy.test.ts`.
This migration does not qualify a live appliance or settle a provider effect.

## Bounded source inventory

The Review Yeti snapshot `dd3c37f865b30b055ef3c36e1161f36f363f9585`
contains no tracked dashboard, alert or saved-log query using the old fields;
matches are producers, declarations and tests. The checked protected
ct-infrastructure snapshot `9b0d289140398ca6af8f5558f400949b7433e154`
likewise contains no matching tracked consumer, including its Review Yeti
dashboard, alert rules and worker-metrics contracts. This does not establish
that externally managed or live queries have migrated.

Worker DELTA behavior is defined in `src/telemetry/metrics.ts` and independently
checked by the infrastructure
[worker-metrics contract](https://github.com/calltelemetry/ct-infrastructure/blob/9b0d289140398ca6af8f5558f400949b7433e154/scripts/tests/test_review_yeti_worker_metrics.py#L19).
