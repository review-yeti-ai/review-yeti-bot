# Releasing

How a Review Yeti release is cut, how the `v1`/`v1-rc` channel tags move, how
to roll one back, and what tag-protection and versioning consumers can rely
on.

## Distribution model

Review Yeti ships two things a consumer can depend on:

- **Immutable semver tags** — `vX.Y.Z`, each a real GitHub Release with
  provenance attestation. These never move once published.
- **Floating channel tags** — `v1` (recommended default, release-gated) and
  `v1-rc` (pre-release, fast-forwards on every push to `main`, **ungated** —
  see the [`v1-rc` fast-forward](#v1-rc-fast-forward-ungated) section below).
  A floating tag is a pointer, not a release; `v1` is moved only by
  `release.yml`, `v1-rc` only by `.github/workflows/channel-rc.yml`, never by
  hand and never from a developer machine.

`v1` is an ordinary annotated tag force-updated to a commit that has already
passed the full gate below. `v1-rc` is force-updated to whatever commit was
just pushed to `main`, with no gate of its own — see below. Nothing else in
this repository is permitted to push to either tag — see
[Tag protection](#tag-protection).

## Cutting a release

Releases are cut by dispatching `.github/workflows/release.yml`, not by a
local `git tag && git push`. Local tagging can't attest provenance and can't
enforce the gate.

1. Confirm `main` is green and contains everything you intend to ship.
2. **`channel=v1` only**: confirm the [E2E review gate](#e2e-review-gate-before-advancing-v1) is
   green for the candidate commit. `npm run test:all` (the battery below) is entirely
   credential-free by design and cannot catch a regression that only shows up against a real
   provider — see [OPERATIONS.md's incident writeup](OPERATIONS.md#incident-response-bad-release)
   for the 2026-08-19 outage this requirement exists because of: the in-run chat preflight (see
   [`OPERATIONS.md`](OPERATIONS.md)) reported "healthy http=200" while the streamed review path
   was actually broken, and nothing in `test:all` would have caught it either, since every lane
   there replays a recorded cassette.
3. Dispatch the workflow with the version and channel:

   ```bash
   gh workflow run release.yml \
     -f version=1.3.0 \
     -f channel=v1
   ```

   - `version` is the semver number for the new immutable tag (`v1.3.0`).
   - `channel` selects which floating tag advances to the new release:
     `v1` for a normal release, `v1-rc` for a pre-release/candidate cut that
     should not yet reach `v1` consumers.

4. The workflow runs the full gate (below), and only on a fully green run
   does it:
   - publish the immutable `vX.Y.Z` tag as a GitHub Release with build
     provenance attestation, then
   - force-update the selected floating tag (`v1` or `v1-rc`) to that same
     commit.

A red gate stops at step 4 — no tag moves, no release is published. There is
no partial-credit release.

## What the gate runs

`release.yml` requires the same full battery `npm run test:all` runs in CI —
unit, cassette replay, fixture, memory VCR, workflow, outbox, security,
chaos, receipt, Action contract, Action runtime (matrixed Node versions),
Pi/MCP adapter, review-intelligence and bounded-review-engine evaluation,
dependency evaluation, CLI/Action equivalence, intelligence promotion, lint,
and build. See [`TEST_INFRA.md`](../TEST_INFRA.md) and the `test:*` scripts in
[`package.json`](../package.json) for what each lane covers. Nothing in the
release path is allowed to skip a lane that PR CI runs.

Every lane in that battery is entirely credential-free by design (see
[`TEST_INFRA.md`](../TEST_INFRA.md)'s fail-closed cassette-replay boundary) — it proves the
engine's *logic* against recorded provider responses, never that a real, live provider call still
works end to end today. That gap is exactly what let the 2026-08-19 SSE-termination regression
ship on `v1`: the in-run chat preflight reported "healthy http=200", `test:all` was fully green,
and persona lanes still hung to the lane deadline against the real provider. See the [E2E review
gate](#e2e-review-gate-before-advancing-v1) below for the live check that closes this gap.

## E2E review gate (before advancing `v1`)

**`v1` must not be advanced (a `release.yml` dispatch with `channel=v1`) unless
[`.github/workflows/e2e-review-gate.yml`](../.github/workflows/e2e-review-gate.yml) is green for
the candidate commit.** `v1-rc` is unaffected — it keeps fast-forwarding on every green `main`
merge as before; this requirement is scoped to the tag real consumer fleets resolve.

This is enforced, not just documented: `release.yml`'s `e2e_gate` job calls this workflow
(`workflow_call`) as a hard `needs:` dependency of the `release` job, scoped to
`channel=v1` only (`v1-rc` dispatches skip it, matching the paragraph above). A red or
non-green gate stops the release before any tag moves — there is no path from a
`channel=v1` dispatch to a moved tag that does not pass through this workflow.

The workflow (`npm run test:e2e-review-gate`, `scripts/e2e-review-gate.mjs`) runs the `security`
persona through the real bounded investigation path (`runPersonaInvestigation` +
`buildInvestigationMessages` — the same production engine `review-pipeline.js`'s `main()` runs on
every real PR review) against two fixture diffs, using a real `OPENROUTER_API_KEY` and a real
provider call — not a cassette:

- [`tests/fixtures/e2e-review-gate/red-known-bug.diff`](../tests/fixtures/e2e-review-gate/red-known-bug.diff)
  plants an unambiguous, in-charter P0 (a live-looking secret-key literal) and must produce
  **>= 1 finding on a completed (non-`ERROR`) lane**.
- [`tests/fixtures/e2e-review-gate/green-clean.diff`](../tests/fixtures/e2e-review-gate/green-clean.diff)
  is a trivial, safe refactor and must produce **0 findings on a completed lane**.

An `ERROR`ed lane never counts as a pass on either fixture, even with a finding count that would
otherwise look right — see `src/review/e2eReviewGate.js` (unit-tested in
`tests/unit/e2eReviewGate.test.ts`) for the exact pass/fail rule. A missing `OPENROUTER_API_KEY`
fails the gate closed with an explicit reason; it never reports a soft skip that could be misread
as a green run.

`release.yml` dispatches it automatically for `channel=v1` (see above) — no manual step is
required before cutting a release. It remains available for an ad hoc manual check against an
arbitrary ref outside a release:

```bash
gh workflow run e2e-review-gate.yml -f ref=<candidate-sha-or-branch>
```

**Resolved (API-2902):** `OPENROUTER_API_KEY` is confirmed provisioned to Actions in
`review-yeti-ai/review-yeti-bot` (run `32331379188`, 2026-08-20 — the gate reached the provider
and got an HTTP 401, not a "not configured" failure), and the gate is now a hard `release.yml`
dependency for `channel=v1`, as above. Note the 401: the currently-provisioned key is invalid or
expired, which means the next `channel=v1` release attempt will fail closed on this gate until
the key is rotated — that is this gate doing its job, not a regression.

## How `v1` and `v1-rc` move

| Tag | Moves on | Gate | Points at |
|---|---|---|---|
| `v1-rc` | Every push to `main` (fast-forward, `channel-rc.yml`). | **None.** The workflow's only trigger is `on: push: branches: [main]` — it does not `need:` `test:all`, the E2E review gate, or any other check, and `main` itself is not a protected branch (no required status checks). A push that would fail CI still moves `v1-rc` the moment it lands. | The latest commit pushed to `main` — may be ahead of the latest published `vX.Y.Z` and may be red. |
| `v1` | Only an explicit `release.yml` dispatch with `channel=v1`. | The full `test:all` battery, plus (channel=v1 only) the live [E2E review gate](#e2e-review-gate-before-advancing-v1). | The most recently published immutable `v1.x.y` release. |

### `v1-rc` fast-forward (ungated)

`v1-rc` exists so hardened consumers who want to track `main` closely (or who
are validating an upcoming release before it reaches `v1`) have a channel one
commit ahead of `v1`. It is **not** a vetted channel: it is a bare
fast-forward of whatever lands on `main`, with no test battery, no live
provider gate, and no branch protection standing in front of it. Any gating
`v1-rc` gets comes entirely from PR review discipline on `main` before merge,
not from anything `channel-rc.yml` itself checks. Treat `v1-rc` as "the tip of
`main`," not as "the last thing that passed CI."

## Rollback

Rolling back is one audited tag move, not a revert-and-rebuild:

```bash
git push origin "+<good-sha>:refs/tags/v1"
```

This force-updates the `v1` tag to the last known-good commit. Every consumer
pinned to `@v1` picks up the good SHA on their next review run — typically
within minutes, with no consumer-side PR, no re-pin, and no required check
bypassed. Consumers pinned to an exact `vX.Y.Z` tag or SHA are unaffected by
a `v1` rollback and must move to the new/older tag explicitly; this is the
trade-off of a hardened pin (see [README.md](../README.md#install)).

Use this when a published `v1` commit is confirmed bad — see
[`OPERATIONS.md`](OPERATIONS.md#incident-response-bad-release) for detection
signals and the full incident procedure, including the org-level break-glass
override for `calltelemetry/ct-review-actions` consumers who cannot wait for
the tag move to propagate.

Do not delete or re-tag a published `vX.Y.Z` release to "fix" it. Immutable
tags stay immutable, including bad ones — ship a new patch version and move
`v1` to it (or roll `v1` back to the prior good `vX.Y.Z`, as above). A bad
immutable tag is a historical record, not something to erase.

## Tag protection

`v1` and `v1-rc` are configured as protected tags in this repository (Settings
→ Tags → rulesets). Only `release.yml`'s runner identity may push to them. A
direct `git push` to either tag from a developer token is expected to be
rejected. If it is not, that is a configuration regression — file an issue
before doing anything else, and treat any unattributed floating-tag move as a
possible incident (see `OPERATIONS.md`).

`vX.Y.Z` release tags are immutable by convention and by the release workflow
never overwriting an existing tag; a second `release.yml` dispatch for a
version that already exists fails rather than clobbering the prior release.

## Versioning policy

Review Yeti follows semver with an explicit floating-channel contract on top:

- **Patch (`v1.Y.Z` → `v1.Y.Z+1`)** — bug fixes, no config or behavior
  changes a consumer would need to react to. Always safe on `v1`.
- **Minor (`v1.Y.Z` → `v1.Y+1.0`)** — additive: new personas, new config keys
  with safe defaults, new optional inputs. Always safe on `v1`.
- **Breaking** — a change that alters existing behavior a consumer configured
  against (removed/renamed input, changed default, changed comment/finding
  shape a consumer parses) ships on a **new major channel** (`v2`), never as
  a `v1` release. `v1` does not receive breaking changes under any
  circumstance — that is the entire point of consumers pinning `@v1`.
- **Maintenance window** — when `v2` opens, `v1` is maintained (security and
  critical-bug patches only) through a stated transition window announced in
  the release notes of the `v2.0.0` release and in this file. `v1` is not
  dropped the day `v2` ships.
- **Deprecations** — any input, config key, or behavior slated for removal is
  announced in release notes at least one minor version before removal, with
  the version it will be removed in stated explicitly.

## Verifying a release

Every `vX.Y.Z` release carries build provenance attestation. Verify what you
pulled actually came from this repository's release workflow:

```bash
gh attestation verify oci://ghcr.io/review-yeti-ai/review-yeti-bot:vX.Y.Z \
  --owner review-yeti-ai
```

or, for the tag/commit form:

```bash
gh attestation verify --repo review-yeti-ai/review-yeti-bot <artifact-or-tag>
```

Hardened consumers who pin an exact tag or SHA (see
[README.md](../README.md#install)) should verify on every bump, not just the
first pin.
