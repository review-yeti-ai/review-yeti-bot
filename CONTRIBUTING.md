# Contributing

## Dev setup

```bash
git clone https://github.com/review-yeti-ai/review-yeti-bot.git
cd review-yeti-bot
npm ci
```

`npm ci`, not `npm install` — the lockfile is authoritative and CI uses `npm ci` too, so a
diverging local `node_modules` is not representative of what will run.

Node `>=20` (see `engines` in `package.json`); CI matrixes the Action runtime lane across Node 20
and 24.

## Running tests

```bash
npm test              # full suite (Vitest), no network access required
npm run lint           # tsc --noEmit
npm run test:all       # the extended PR gate — same battery CI and release.yml both require
```

Tests run fully offline against recorded cassettes in `tests/fixtures/cassettes/`. Replay is
fail-closed: an unmatched request throws rather than reaching the network. See
[TEST_INFRA.md](TEST_INFRA.md) for the full boundary-replay contract, and
[docs/EVAL_AND_TEST_SUITE.md](docs/EVAL_AND_TEST_SUITE.md) for the evaluation-lane detail.

`npm run test:all` is what both `ci-cd.yaml` and the release workflow require green — see
[docs/RELEASING.md](docs/RELEASING.md#what-the-gate-runs). Run it locally before opening a PR for
anything touching the review engine, Action contract, or publication path; it is slower than
`npm test` but catches Action-contract and CLI/Action-equivalence regressions the fast suite
does not.

Live provider credentials are never required for any lane in `test:all`. Live evaluation
(`test:live-intelligence-smoke`, `test:dependency-live-eval`) is a separate, explicit, manual
step — see [docs/EVALUATION_CLI.md](docs/EVALUATION_CLI.md) and
[docs/OPERATIONS.md](docs/OPERATIONS.md#evaluation-evidence).

## Commit and PR conventions

Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope)?: summary`, where `type` is one of
`feat|fix|perf|refactor|docs|test|build|ci|chore|style|revert`. PR titles are enforced by CI
(`.github/workflows/conventional-pr-title.yaml`) — a non-conforming title fails the check.

Examples: `fix: handle empty diffs`, `feat(cli): add --json output mode`,
`docs: clarify rollback command`.

## PR expectations

- Keep the diff scoped to one change; split unrelated refactors into a separate PR.
- Add or update tests for any behavior change — see
  [docs/ADVERSARIAL_REVIEW_PATTERNS.md](docs/ADVERSARIAL_REVIEW_PATTERNS.md) for the reasoning
  behind this repository's test-first review culture.
- If you touch `action.yml`, the review pipeline, or publication behavior, run
  `npm run test:action-contract` and `npm run test:equivalence` locally — these assert the Action
  and CLI stay behaviorally equivalent and catch a large class of accidental contract breaks
  before CI does.
- If you touch anything under `.github/workflows/`, `.review-yeti.yaml`, or the release/tag
  machinery, read [docs/RELEASING.md](docs/RELEASING.md) first — several invariants there
  (immutable release tags, protected `v1`/`v1-rc`) are enforced by CI, not just convention.
- This repository reviews its own pull requests with Review Yeti
  (`.github/workflows/review-bot.yaml`) using the locally checked-out action source. Expect a
  review comment on your PR from the bot itself; treat its findings the same as a human
  reviewer's.
- No AI-attribution trailers (`Generated with...`, `Co-Authored-By: <AI tool>`) in commit
  messages — attribute commits to the human author.

## Reporting bugs and requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`. For a bug against a specific review run,
include the run URL, the posted verdict, and the run-report failure line if there is one — see the
bug template for the exact fields.

For security vulnerabilities, do not open a public issue — see [SECURITY.md](SECURITY.md).
