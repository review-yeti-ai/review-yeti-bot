# Central dispatch replay fixtures (REL-512)

These fixtures back `scripts/validate-central-dispatch.replay.test.mjs`. They exist so the
central-dispatch validator (`scripts/validate-central-dispatch.mjs`) is proven against the real
shape of GitHub's `actions/runs`, `pulls`, and repository-contents API responses, not a shape the
test author guessed -- REL-512's 2026-09-02 incident was three separate rounds of exactly that:
the contract was guessed, shipped as a required check, and broke on the first real dispatch (see
the "Incident" section of the Linear issue and the commit history of
`scripts/validate-central-dispatch.mjs` for #193/#194/#195/#196/#199).

## Source runs

| Fixture prefix | Run | PR | Repo | What it proves |
|---|---|---|---|---|
| `example-api-4820-*` | [33668880961](https://github.com/exampleorg/example-api/actions/runs/33668880961) | [#4820](https://github.com/exampleorg/example-api/pull/4820) | example-api | Ordinary case: `pull_request_target` run, base branch == default branch (`0.8.7-stable`), `run.head_sha` is the PR head and `run.head_branch` is the PR source branch (not the base branch) -- the exact shape #194/#195 got wrong. |
| `example-api-4804-*` | [33675866048](https://github.com/exampleorg/example-api/actions/runs/33675866048) | [#4804](https://github.com/exampleorg/example-api/pull/4804) | example-api | Divergent case: the PR's base branch (`0.8.8-stable`) differs from the repository's default branch (`0.8.7-stable`). GitHub executes the `pull_request_target` caller workflow from the **default** branch, not `pull.base.ref` -- the exact shape #199 got wrong (example-api's `forward-merge.yml`/API-3142 work explains why 0.8.8-stable existed as a non-default stable line at the time). |

Both runs and PRs were captured live via `gh api` on 2026-09-04 (see each fixture's `_provenance`
block for the exact command). Both PRs have since closed, which changes two things a naive replay
would miss:

1. **`pull_requests` on the run object.** GitHub's Actions runs API stops populating this field
   once the associated PR closes -- both `example-api-4820-run-*.json` and
   `example-api-4804-run-*.json` return `pull_requests: []` today, exactly as GitHub returned them,
   even though both runs actually validated successfully against an open PR in production. The
   replay test restores `pull_requests: [{ "number": <pr> }]` when building the mock fetch
   response for `validateCentralDispatch` (see `withOpenPullRequests` in the test file) -- that is
   what the field held at the moment these runs executed, and it is also its own regression test:
   a second case replays the run object exactly as captured (`pull_requests: []`) and asserts the
   validator correctly rejects it, which is the real, verified behavior a closed-PR replay
   triggers if you don't know about this quirk.
2. **The PR's `head.sha`.** Both PRs have accumulated commits since these runs executed, so the
   *current* PR head no longer matches the run's `head_sha`. Each `*-pull.json` fixture's `head.sha`
   is reconstructed to the value the PR had at run time, not the value `gh api .../pulls/<n>`
   returns today. This is not guessed: `gh api repos/exampleorg/example-api/commits/<sha>/pulls`
   (for #4820) and the commit's author timestamp sitting seconds before the run's `created_at`
   (for #4804, where the direct commit-to-PR association has aged out of GitHub's index) both
   confirm the commit really was that PR's head. Every other field on each `*-pull.json` fixture
   (`base.ref`, `base.repo.default_branch`, `head.ref`) is byte-exact from the live API and has
   not changed, since those are stable PR metadata that don't move once a PR is opened against a
   given base branch.

Each fixture's `_provenance` block spells out exactly which fields are byte-exact and which are
reconstructed, and how. Never delete or "clean up" that block -- it is the point of the fixture.

The validator now also reads the exact head's App-owned `Review Yeti` check ledger before it
admits a worker generation. The historical captures predate that endpoint read, so the replay
test supplies an explicitly synthetic infrastructure-failed `a1` check page while preserving the
run, pull, and workflow objects above unchanged. That mock is deliberately inline and labelled
replay-only; it must not be mistaken for a live-captured check-run object or used to weaken the
byte-exact object replay.

## Caller workflow content

`ct-review-bot-0.8.7-stable.yml` is the real, current byte content of
`exampleorg/example-api`'s `.github/workflows/ct-review-bot.yml` at `0.8.7-stable` (the repository
default branch for both fixtures above), captured via:

```
gh api "repos/exampleorg/example-api/contents/.github/workflows/ct-review-bot.yml?ref=0.8.7-stable"
```

and base64-decoded. It contains no secrets (only `${{ secrets.X }}` GitHub Actions expression
syntax, never a resolved value), so it is stored as plain text rather than the API's base64
envelope, for readability and diffability. The replay test base64-encodes it on the fly to
reconstruct the exact `contents` API response shape `validateCentralDispatch` expects.

## What is intentionally NOT captured

The full `gh api` responses carry roughly twenty `*_url` HATEOAS link fields (`jobs_url`,
`logs_url`, `check_suite_url`, `comments_url`, ...) that `validateCentralDispatch` never reads.
Those are omitted from the fixtures to keep them auditable; nothing sensitive was stripped from
them (they are ordinary GitHub API endpoint templates, not credentials).
