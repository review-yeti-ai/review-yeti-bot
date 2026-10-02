# Gate-bound abandoned failure publication

The abandoned-run claim and locked reconciliation excluded every run with a
service-reserved Gate App. An operator-delegated failed worker could therefore
remain unpublished even when its exact current Gate was bound and no verdict
had been recorded.

The shared SQL fence now admits a matching current, bound, result-free Gate
alongside the legacy path. Failure or deadline evidence remains required.
App, repository, head, generation, execution attempt and full coordinates must
agree. The reaper checks the reserved App against its authenticated publisher
before preparing a GitHub client. It does not synthesize review approval.

Synthetic PostgreSQL regressions reproduced the exclusion through delegated,
deadline and durable-failure routes. The unchanged baseline repeated 12 failures
and one pass; eight of those failures stopped at the initial positive claim
prerequisite rather than demonstrating additional defects. The separate unit
control reproduced publication through a mismatched authenticated App.

The repaired four-file cohort passed 523 tests. One earlier full run passed 521
of 522, with an existing generation-recovery five-second timeout; its exact
unchanged replay passed before the final cohort. Backend TypeScript build and
the repository-wide test parse/import check passed. The real repository/reaper
path reaches one mocked failure PATCH for the exact synthetic App/head/attempt,
preserves absent verdict evidence, and produces no second write on another sweep.

The instrumented 523-test run passed again. Native V8/Istanbul line coverage was
648/708 (91.5%) across the two changed modules, with 4/4 changed executable lines
hit at an 80% threshold. SQL template text is not counted as executable V8 lines;
its predicates are exercised by the real PostgreSQL controls.

All PostgreSQL tests use an owned disposable loopback fixture. Qualification
does not establish deployment, live GitHub publication, or completed review.
