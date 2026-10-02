# Canonical finding identity library — REL-1265

This prerequisite extracts the complete pure identity/extraction helper from PR #1258 and adds eight independent core tests. Active readers, dispute writers, tool registration and review policy remain unchanged.

The tests cover fixed fallback hashes, persisted IDs, newest-attempt selection, supported payload shapes, canonical priority and ambiguous legacy aliases. The original reader/resource assertions and PR #1258 roundtrip suite remain intact.

The qualified runtime/test bytes passed the default CI selector's complete 89-file cohort: 2,112 tests, no failures or skips. Whole-tree lint, backend compilation and three checks against compiler-generated JavaScript passed. The subsequent main advance changed release version metadata only; the qualified helper and test bytes are identical.

The earlier 2,093-pass/two-timeout run and its unchanged two-control passing replay remain separate diagnostic evidence. No test deadline, concurrency, selector or hard review-assignment cap changed.

Native focused V8 measured all helper lines, statements, branches and functions covered. That optional focused coverage command exited 1 against unchanged whole-repository floors; this is helper-only measurement, not a global coverage pass.

Reader adoption is a separate dependent slice retaining all four readers and the complete original roundtrip test. Durable authenticated recheck safety and activation remain with the existing PR #1258 owner. This unused library does not authorize disputes or check mutation.
