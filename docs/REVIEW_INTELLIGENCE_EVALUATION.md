# Review intelligence evaluation and promotion

The promotion matrix at `tests/fixtures/review-intelligence/offline-promotion-matrix.json` is a
deterministic, offline gate. It covers repeated pull-request feedback transitions, session recap,
stale heads, provider failure, compaction, OTel receipts, MCP poisoning, leases, replay/dead-letter
handling, and secret-free receipts. The companion versioned cassette is scoped to fixture origins
and keeps authentication values redacted. The gate opens
`tests/fixtures/review-workflows/intelligence-evaluation.json` and verifies every scenario's
identity, declared result, and normalized receipt against deterministic fixture facts; it does not
treat a boolean assertion as evidence. The cassette must declare the same scenario IDs, pass
secret scanning, and match the SHA-256 pinned in the matrix, so missing or changed replay input
fails closed.

Run the offline evidence gates with:

```bash
npm run test:intelligence-eval
npm run test:intelligence-promotion
```

The promotion command also loads the Action runtime under plain Node and confirms it did not pull
in TypeScript-only runtime modules. It reports `liveSmoke.status: "not_run"`; that is deliberate.
Offline cassettes and workflow fixtures are evidence only for deterministic replay, not proof of a
live provider, hosted Action, MCP service, telemetry exporter, or deployment.

`npm run test:live-intelligence-smoke` similarly reports `not_run` by default. Setting
`REVIEW_YETI_LIVE_SMOKE=1` does not fabricate a success: the command exits and states that live
orchestration must happen in a separately authorized environment with real receipts. Do not promote
on an offline score as if it were live ingestion or readiness evidence.

`npm run test:all` includes both deterministic evaluation and the promotion gate after the existing
unit, cassette, workflow, outbox, security, chaos, receipt, and Action-runtime checks.
