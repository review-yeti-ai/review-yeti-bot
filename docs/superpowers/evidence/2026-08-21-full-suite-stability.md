# Full Suite Stability Evidence

## Scope

This receipt covers the follow-up repairs after the Pi runtime merge on the
`codex/REL-325-runtime-followups` branch. It records local reproducibility and
does not substitute for the exact-head hosted `test` and Review Yeti gates.

## Baseline

| Check | Baseline result | Classification |
| --- | --- | --- |
| `npm test` on `c4a616fde1ac0f5930cb295b77b2343193b82b90` | 320 files: 9 failed; 3,511 tests: 15 failed; 215 uncaught errors | reproducible contract/fixture drift |
| Model/provider focused suites | duplicate fallback IDs, namespace resolution, stale model options/version | stale contracts plus provider identity regression |
| Replay suites | request system prompts no longer matched `reviewWithModel` | stale cassette fixture |
| Router HTTP fixtures | Node 26 `IncomingMessage` abort cleanup raised `removeListener` errors | test-fixture compatibility |

Environment: Node `v26.7.0`, npm `11.19.0`.

## Repairs and focused receipts

- Explicit model namespace precedence now resolves `agy/`, `synthetic/`,
  `opencode-go/`, `codex/`, and `openrouter/` before generated metadata.
- Fallback model IDs are unique; the current Kimi synthetic option is present
  in the onboarding model selector; release assertions use synchronized
  package/lockfile versions.
- Replay request prompts and cassette system messages were regenerated from the
  current pipeline contract, offline, with response bodies and interaction
  counts preserved.
- Synthetic Express requests now use initialized `http.IncomingMessage`
  instances with a bounded socket fixture, avoiding Node 26 abort-cleanup
  errors without suppressing uncaught exceptions.
- The offline Linear test explicitly disables ambient Doppler lookup so the
  fallback contract is deterministic and credential-free.

Focused receipts:

```text
model/provider suites: 6 files, 59 tests, 0 failures
replay suites:         2 files, 7 tests, 0 failures
HTTP/Linear fixtures:  4 files, 36 tests, 0 failures, 0 uncaught errors
```

## Final local verification

```text
npm test
  Test Files  320 passed (320)
  Tests       3511 passed (3511)
  Errors      0

npm run lint       PASS (tsc --noEmit)
npm run build      PASS (Next production build + server tsc)
node --check scripts/install-action-runtime.mjs       PASS
node --check scripts/boundedDirectoryGuard.js         PASS
git diff --check                                      PASS
```

## Hosted landing gate

The branch must be rebased onto the current `official/main`, pushed, and then
validated on the exact pushed SHA. Merge remains blocked until hosted `test`
passes and Review Yeti reports `SHIP`, quorum satisfied, 5/5 personas, and zero
P0/P1/P2 findings. A local receipt, skipped lane, provider timeout, or stale
review is not a merge receipt.
