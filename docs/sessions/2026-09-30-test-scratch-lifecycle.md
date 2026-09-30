# Test scratch lifecycle (REL-1209)

## Scope

Fix isolated test-file scratch ownership and release fixture allocation.
Suite `afterAll` closes resources and retires its exact root. A manifest-backed
run owner covers normal close and collection-only leftovers. No prefix-wide
deletion or crash reaper is added.

## Evidence

Three focused files pass 21 tests; two opt-in interruption/failure probes are
skipped in ordinary runs. Focused V8 helper coverage passes enforced 80%
thresholds: 90.62% lines, 89.78% statements, 87.30% branches, 100% functions.
Negative cases hold replaced roots/parents/manifests, failed resource closure,
live child ownership and unowned entries. Immutable release copying excludes
tracked runtime/evidence paths and ignores dirty/untracked source contents.

Actual isolated pass, intentional assertion failure, collection-only and watch
close probes all leave zero completed-run roots. A watch keeps its run owner
until close. SIGTERM and SIGKILL probes retain owner-attributed run roots;
only the exact probe processes were stopped. Abrupt CLI termination does not
automatically reap children or authorize deletion. The fixture roots and logs
remain private evidence, not production or customer data.

## Lifecycle discovery

Review follow-up replaced source-substring coverage with actual file removal
and a self-contained reset-hook regression. It exposed a real ordering bug: restoring
the baseline environment before cleanup lost the prior random store path.
Capture that path first. A planted wrong anchor fails the behavioral test;
restored behavior passes, preserving outside/prefix-sharing/symlink-escaped
files. Fixture parents also explicitly require current suite ownership; an
unset root no longer silently falls back to shared OS temp.

The reset regression passes alone and shuffled, without sibling-test state.
Fixture exclusion expectations are independently pinned; removing the
production `node_modules` exclusion makes the archive test fail, and restoring
it passes. These counterfactuals test behavior, not source substrings.

Vitest 4 runs global teardown before closing its worker pool. Run retirement
there would either delete live collection scratch or fail while workers are
still closing. The supported `onClose` hook runs alongside pool close; bounded
PID inspection waits for owned suites to stop and fails closed on uncertainty.
Close-hook failures set a nonzero CLI exit status and remain observable.

The normal lint wrapper collects the entire suite. Its local collection was
stopped after discovering that behavior; focused collection and typechecking
are the bounded checks. Heavy registry-backed release tests remain a hosted
release-lane responsibility, not a laptop disk-pressure workaround.

## Completion boundaries

Protected exact-head hosted CI and Review Yeti remain merge requirements.
Merge does not prove all active local harnesses have adopted these changes.
Cross-harness admission, crash-owner reconciliation and consumer skill
activation remain separate work under acceptance parent REL-1208.
