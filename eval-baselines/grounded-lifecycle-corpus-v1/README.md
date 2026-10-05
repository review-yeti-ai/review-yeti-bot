# Grounded lifecycle corpus v1

This is a public-neutral synthetic qualification corpus for exact-source and lifecycle handling. Each file in `inputs/` is independently replayable and contains deterministic Git commits, source blobs, current normalized claims, and a worker-visible history load. The keyed `oracle/GroundedLifecycleOracle.v1.json` file is separate and contains expected receipt projections. A runtime loader must never merge that sidecar into worker or verifier inputs.

The source files use `synthetic/fixture-project`; all identities, receipts, and code are fabricated. No provider calls or review-quality measurements are embedded. Oracle values are expectations for a future accepted engine run, not evidence that a provider produced them and not a publication or approval instruction.

The test-only candidate projection carries only the normalized claim fields (`severity`, `path`, `line`, `title`, `claimType`, and `fingerprint`). It drops proposer rationale, receipts, history, and oracle fields. The production verifier remains responsible for retrieving exact base/head source and diff through its own source provider.

Every revision records its Git commit/tree/blob identifiers and a SHA-256 for file bytes. Corpus tests rebuild the commits in a disposable temporary Git repository and compare the commits and patches, so source edits require regenerated identities. History loads model complete, rejected stale, and partial digest-mismatch states. Repeated replay metadata requests identical independent runs for the same target identity; it does not impose a review-round limit.
