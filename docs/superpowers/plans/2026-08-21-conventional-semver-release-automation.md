# Conventional SemVer Release Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Turn merges to protected `main` into reviewed Conventional Commit release PRs, then publish and deploy only the immutable semver tag that has passed the existing release gates.

**Architecture:** Release Please watches `main` and opens a release PR that updates the Node package version and changelog from Conventional Commits. Merging that PR creates an immutable `vX.Y.Z` tag, which invokes one canonical benchmark/test/package/deploy workflow; only that successful workflow promotes the matching `v1` rolling tag. Existing `v1.8.5` is preserved as historical state, while future releases are guarded against package/tag drift.

**Tech Stack:** GitHub Actions, `googleapis/release-please-action@v4`, Node.js 24, npm lockfile, Vitest, shell/Node release guards.

**Spec:** Approved in chat on 2026-08-21; the current repository already contains tag-triggered release/deploy and manual rolling-major workflows.

## Global Constraints

- Release bumps follow Conventional Commits: `fix` patch, `feat` minor, `!`/`BREAKING CHANGE` major, and docs/chore/test/ci do not release.
- Release PRs and the existing full required checks remain mandatory; no direct version commits or unreviewed deployment from ordinary `main` merges.
- The existing `v1.8.5` tag is immutable historical state and is not force-moved by this change.
- A future semver release must have a matching `package.json` version and must point at a commit reachable from `main`.
- The rolling `v1` tag moves only after the canonical release workflow's tests, benchmark, artifact publication, and deployment complete successfully.
- No credentials or release secrets are added to the repository.

---

### Task 1: Add fail-closed release-version validation

**Files:**
- Create: `scripts/validate-release-version.mjs`
- Create: `tests/unit/releaseVersion.test.ts`
- Modify: `package.json` (add `test:release-version` script)

**Interfaces:**
- Produces `validateReleaseVersion({ tag, packageVersion, mainSha, checkedOutSha, taggedSha, tagReachableFromMain })` returning `{ normalizedVersion, major, minor, patch }` or throwing a descriptive error.
- CLI accepts `--tag`, `--package-version`, `--main-sha`, `--checked-out-sha`, `--tagged-sha`, and `--tag-reachable-from-main`; the release workflow invokes it with the checked-out tag, peeled tag commit, and ancestry result.

- [ ] **Step 1: Write the failing validator tests** for valid `v1.8.6`, missing `v`, malformed versions, package/tag mismatch, a tag not reachable from `main`, and a tag that points at a different commit.
- [ ] **Step 2: Run `npm run test:release-version` and verify the new tests fail because the module/script is absent.**
- [ ] **Step 3: Implement the pure validator and CLI with strict `vMAJOR.MINOR.PATCH` parsing, exact package equality, and exact SHA checks.**
- [ ] **Step 4: Run `npm run test:release-version` and verify all cases pass.**
- [ ] **Step 5: Commit as `test(release): define semver tag contract`.**

### Task 2: Add reviewed Conventional Commit release PR automation

**Files:**
- Create: `.github/workflows/release-please.yml`
- Create: `release-please-config.json`
- Create: `.release-please-manifest.json`
- Modify: `README.md` (release workflow and commit convention section)
- Test: `tests/unit/releaseWorkflowConfig.test.ts`

**Interfaces:**
- Release Please targets `main`, uses the Node release strategy, and starts from manifest version `1.8.5` (the last pushed semver tag).
- The workflow has `contents: write`, `issues: write`, and `pull-requests: write` permissions and uses the repository's built-in `GITHUB_TOKEN`.

- [ ] **Step 1: Write the static workflow/config tests** asserting the workflow triggers only on `main`, contains the required permissions, uses Release Please v4, targets `main`, and records `1.8.5` as the current release baseline.
- [ ] **Step 2: Run the focused test and verify it fails because the workflow/config files do not exist.**
- [ ] **Step 3: Add the Release Please manifest/config and workflow.** Configure Node release behavior, changelog generation, and Conventional Commit mapping without adding a second publishing path.
- [ ] **Step 4: Run the focused tests plus YAML/JSON parsing checks and verify they pass.**
- [ ] **Step 5: Commit as `feat(release): open reviewed conventional semver release prs`.**

### Task 3: Consolidate tag publishing and gated rolling-v1 promotion

**Files:**
- Modify: `.github/workflows/release.yml`
- Delete: `.github/workflows/release-semver.yaml`
- Modify: `.github/workflows/update-major-tag.yml`
- Create: `tests/unit/releaseWorkflowContract.test.ts`

**Interfaces:**
- `release.yml` is the only semver tag publisher/deployer and triggers on `v*.*.*`; it validates the exact tag/package/commit contract before tests or deployment.
- The release job invokes `scripts/validate-release-version.mjs` and promotes `v1` only after the benchmark, test suite, GitHub Release assets, image push, and Kubernetes rollout succeed.
- Manual `update-major-tag.yml` remains available for recovery and retains exact-SHA/main ancestry checks; it cannot promote an unversioned commit without its explicit recovery input.

- [ ] **Step 1: Write static contract tests** proving the duplicate workflow is absent, the canonical workflow does not trigger on rolling `v1`, version validation precedes deployment, and rolling promotion is downstream of the release gate.
- [ ] **Step 2: Run the focused test and verify it fails against the current duplicate/tag-wildcard workflows.**
- [ ] **Step 3: Restrict `release.yml` to numeric semver tags, call the validator with exact tag and commit data, and add the gated rolling-`v1` promotion after deployment.**
- [ ] **Step 4: Delete `release-semver.yaml` and preserve the richer benchmark/artifact behavior from `release.yml`.**
- [ ] **Step 5: Run the focused contract tests, YAML parsing, and shell syntax checks.**
- [ ] **Step 6: Commit as `fix(release): consolidate semver publishing and gate v1 promotion`.**

### Task 4: Verify the complete release contract and publish the PR

**Files:**
- Modify: `docs/superpowers/plans/2026-08-21-conventional-semver-release-automation.md`
- Modify: `README.md` if verification discovers wording drift.

- [ ] **Step 1: Run `npm run test:release-version`, the workflow-config/contract tests, `npm run lint`, `npm run build`, and `git diff --check`.**
- [ ] **Step 2: Run the complete local test suite (`npm test`) and record the exact result.**
- [ ] **Step 3: Inspect the final diff for accidental generated-output or secret changes.**
- [ ] **Step 4: Push the feature branch and open a draft PR against the current official `main` with the exact base/head SHAs.**
- [ ] **Step 5: Wait for current-head required checks and Review Yeti quorum; do not merge or create another release tag from the feature branch.**

## Self-review

- The existing tag-triggered deployment is preserved, so release automation does not bypass the image/Kubernetes gates already in production.
- The duplicate release workflow is removed, preventing two benchmark/deploy runs for one tag.
- The pre-existing `v1.8.5` mismatch is explicitly fail-closed rather than silently rewritten; the next Release Please PR must establish the first package/tag-consistent release.
- Static tests cover the exact workflow invariants because GitHub Actions behavior cannot be fully exercised locally.
