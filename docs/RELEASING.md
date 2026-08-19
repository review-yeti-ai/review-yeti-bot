# Releasing

How a Review Yeti release is cut, how the `v1`/`v1-rc` channel tags move, how
to roll one back, and what tag-protection and versioning consumers can rely
on.

## Distribution model

Review Yeti ships two things a consumer can depend on:

- **Immutable semver tags** — `vX.Y.Z`, each a real GitHub Release with
  provenance attestation. These never move once published.
- **Floating channel tags** — `v1` (recommended default) and `v1-rc`
  (pre-release, fast-forwards on every `main` merge). A floating tag is a
  pointer, not a release; it is moved only by `release.yml`, never by hand and
  never from a developer machine.

`v1` and `v1-rc` are ordinary annotated tags force-updated to a commit that
has already passed the full gate below. Nothing else in this repository is
permitted to push to them — see [Tag protection](#tag-protection).

## Cutting a release

Releases are cut by dispatching `.github/workflows/release.yml`, not by a
local `git tag && git push`. Local tagging can't attest provenance and can't
enforce the gate.

1. Confirm `main` is green and contains everything you intend to ship.
2. Dispatch the workflow with the version and channel:

   ```bash
   gh workflow run release.yml \
     -f version=1.3.0 \
     -f channel=v1
   ```

   - `version` is the semver number for the new immutable tag (`v1.3.0`).
   - `channel` selects which floating tag advances to the new release:
     `v1` for a normal release, `v1-rc` for a pre-release/candidate cut that
     should not yet reach `v1` consumers.

3. The workflow runs the full gate (below), and only on a fully green run
   does it:
   - publish the immutable `vX.Y.Z` tag as a GitHub Release with build
     provenance attestation, then
   - force-update the selected floating tag (`v1` or `v1-rc`) to that same
     commit.

A red gate stops at step 3 — no tag moves, no release is published. There is
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

## How `v1` and `v1-rc` move

| Tag | Moves on | Points at |
|---|---|---|
| `v1-rc` | Every `main` merge (fast-forward), gated by the same `test:all` battery as a release. | The latest candidate commit — may be ahead of the latest published `vX.Y.Z`. |
| `v1` | Only an explicit `release.yml` dispatch with `channel=v1`. | The most recently published immutable `v1.x.y` release. |

`v1-rc` exists so hardened consumers who want to track `main` closely (or who
are validating an upcoming release before it reaches `v1`) have a channel that
still passed the full gate — it is never an unvetted moving target.

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
