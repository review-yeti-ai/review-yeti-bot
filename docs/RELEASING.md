# Releasing Review Yeti

> **Authority:** This guide describes the public GitHub Action release path. Central fleet
> provider policy and consumer rollout remain owned by
> `centralized review actions`. See
> [Documentation authority](DOCUMENTATION_AUTHORITY.md).

The immutable release unit is a `vMAJOR.MINOR.PATCH` tag. The `v1` tag is a rolling consumer channel
that may point only at a tested `v1.x.y` release commit during the normal path.

## Normal release path

1. Merge reviewed Conventional Commit changes to `main`.
2. [Release Please](../.github/workflows/release-please.yml) opens or updates a release PR. `feat:`,
   `fix:`, `perf:`, and `revert:` entries participate in the configured changelog; a
   documentation-only merge does not create a release by itself.
3. Review the release PR's version, changelog, manifest, exact head, and required checks. Merge it
   through branch protection.
4. Release Please creates the immutable SemVer tag. The tag triggers
   [`release.yml`](../.github/workflows/release.yml).
5. The release workflow verifies that the tag, package version, checkout, and a commit reachable
   from `main` agree. It then installs the lockfile on Node 24, builds, runs unit and integration
   suites, runs the offline regression benchmark, and publishes the benchmark assets and digest to
   the GitHub release.
6. Only after those gates pass does the second release job move the rolling `v1` tag to the exact
   tested release commit.

### Commit-title requirement

Release Please parses commit titles using the Conventional Commits grammar. An issue-only title such
as `[API-1234] change description` is not parsed and will not be represented in the release PR's
changelog. Use a conventional title such as `fix(review): change description` and put the issue key
in the body or footer. If the release workflow logs an unparsed commit, stop and correct the release
candidate before merging it; do not hand-create a tag to compensate.

An ordinary `main` merge does not advance `v1`. Do not create or move a SemVer tag by hand and do not
use a local force-push as a release procedure.

## Verification receipt

Before describing a release as available to consumers, record and verify:

- the merged release PR and exact merge commit;
- the SemVer tag and its peeled commit;
- the terminal `Release & Benchmark Publishing Pipeline` run for that tag;
- the published benchmark assets and digest;
- the rolling `v1` tag object and its peeled commit; and
- reachability of the released commit from current `main`.

Example read-only checks:

```bash
git fetch origin main --tags
git rev-list -n 1 'v1.12.0^{commit}'
git rev-list -n 1 'v1^{commit}'
git merge-base --is-ancestor "$(git rev-list -n 1 'v1.12.0^{commit}')" origin/main
gh run list --workflow release.yml --limit 10
gh release view v1.12.0
```

Replace the example version with the release being verified. A configured workflow, a created tag,
or a green unrelated run is not sufficient release evidence.

## Recovery and rollback

[`update-major-tag.yml`](../.github/workflows/update-major-tag.yml) is a manual recovery path, not
the normal release path. It accepts an exact 40-character commit, requires that commit to be
reachable from `main`, and normally requires a `v1.x.y` tag at that commit. Its
`unreleased_recovery` mode is break-glass only and can target only the exact current `main` tip after
rerunning the bounded consumer Action contract.

To roll the consumer channel back, select the exact commit of a previously tested `v1.x.y` release,
run the guarded manual workflow, and verify the resulting `v1` peeled commit. Record the prior and
new tag objects, target commit, workflow run, reason, and follow-up decision. This changes the bot
release channel only; it does not change fleet provider order.

## Boundaries

- Never publish from an unreviewed working tree or branch head.
- Never treat `main` as the consumer release channel.
- Never move a SemVer tag.
- Never infer provider activation from a bot release; provider activation is a separate central
  control-plane decision.
- Never add scheduled, recurring, or shadow review traffic to qualify a release.
