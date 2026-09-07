# Review Yeti as a public product: plan

Status: proposal. Scope: `review-yeti-ai/review-yeti-bot` (public, MIT). Date: 2026-09-07.

## Thesis

Review Yeti today is an internal merge gate that happens to be public. The repository shows it: 59 inputs, 29 docs files, a Kubernetes dispatch handshake in the second screen of the README, and a `SHIP` verdict that can be issued without a review. A stranger reads all of that as risk. The plan below makes one commitment: **every default is safe for a stranger who gates merges on it, and everything that is not for strangers leaves the repo.** Adoption work comes after that, not before, because a public gate that can say SHIP without reviewing has nothing to market.

The one-sentence positioning to hold every decision against: *"A panel of AI reviewers that runs in your own runner, against the model you choose, and gives you a verdict you can gate on. Nothing leaves your runner except the request to your model."*

## Ordering and what needs a human

Phases 0 and 1 are safe to do now: they remove hazards and delete surface. They spend nothing and need no listing, hosting, or pricing decisions. Phase 2 has one spike that needs a human decision if it fails. Phases 3 and 4 need human decisions on spend and listing before they start. Human decisions are collected at the end.

Each item states the problem in one line, the change, how we know it worked, and size (S under a day, M under a week, L more).

---

## Phase 0: stop the trust hazards (safe now)

### 0.1 Kill passthrough SHIP

- **Problem:** A verdict of SHIP has been published with a body saying no review was conducted, and a PR merged on it.
- **Change:** Add a fourth terminal state, `NO_REVIEW`, alongside SHIP, FIX_FIRST, and BLOCK. Every path that today yields passthrough (no provider, budget exceeded, dispatch unreachable, malformed output, quorum shortfall) resolves to `NO_REVIEW`. The check conclusion for `NO_REVIEW` is `failure` by default. One new input, `on-no-review`, accepts `fail` or `neutral`. The comment body for `NO_REVIEW` leads with the reason and the one thing the operator can do about it. SHIP is only reachable when every required lane returned parsed findings on the exact head.
- **Done when:** A test suite enumerates every failure branch and asserts none produce SHIP. The published comment and the check conclusion agree in every fixture. A grep of the codebase finds no remaining code path that writes SHIP with a "no review" body.
- **Size:** M.

### 0.2 Gate the moving `v1` tag behind a canary

- **Problem:** `v1` auto-advances on every release, and one release broke review publication for every consumer for about 22 hours.
- **Change:** Keep `v1` as the documented convenience tag, because that is what the Actions ecosystem expects. Change how it moves. Releases produce an immutable `vX.Y.Z` tag only. A separate promotion job advances `v1` after the new tag has run the self-review on this repository and on a designated set of internal consumers for a canary window, with zero `NO_REVIEW` outcomes attributable to the action. Promotion is a distinct workflow with a manual rollback that re-points `v1` to the previous `vX.Y.Z`. The README shows two pinning styles side by side: `@v1` for people who want convenience, `@<sha>` for people using it as a merge gate, with an explicit recommendation for the SHA form on gates.
- **Done when:** The release workflow cannot move `v1` directly. A rehearsal that deliberately breaks publication in a canary release leaves `v1` where it was. A CHANGELOG entry exists for every `vX.Y.Z` with a "breaking" heading present or explicitly absent.
- **Size:** M. Canary window length is a human decision (see end).

### 0.3 Publish the data-flow statement and make it checkable

- **Problem:** A stranger is sending a private diff to an LLM and cannot tell what leaves the runner or where it goes.
- **Change:** A single `docs/` page, linked from the second paragraph of the README, states: what is sent (the diff, the file context the lanes request, the persona prompts), where it goes (exactly one outbound host in local mode: the `llm-base-url` you set), what is stored (nothing, unless you enable the ledger, and then where), and what Review Yeti's own servers ever see (nothing in local mode; in dispatch mode, the dispatch payload, described field by field). Make it provable rather than asserted: add a `dry-run` input that resolves the panel, computes what each lane would send, and posts a comment listing outbound hosts, byte counts, and token estimates per lane, with zero model calls. Every real review appends a one-line footer: model, host, total tokens sent, total tokens received, wall time.
- **Done when:** The dry-run comment on this repository's own PRs matches the documented host list byte for byte. The footer appears on every review comment in the self-review.
- **Size:** M.

### 0.4 Move internal artifacts out of the repo

- **Problem:** Repo root and `docs/` contain project-management and operations material that reads as internal and dilutes what a stranger should read.
- **Change:** Remove `ORIGINAL_REQUEST.md` and `PROJECT.md` from the repo root. Move `DOKS_REVIEW_OPERATIONS.md`, `GENERATIONAL_REVIEW_ENGINE_TASKS.md`, `COMPETITIVE_LANDSCAPE.md`, `DOCUMENTATION_AUTHORITY.md`, and `ADVERSARIAL_REVIEW_PATTERNS.md` to the private ct-meta knowledge tree. The adversarial patterns content is good material; if any of it becomes public later, it comes back rewritten as a user-facing "how the personas think" page, not as an internal design note.
- **Done when:** `git ls-files docs/` lists only pages a consumer would read. The repo root has a README, LICENSE, action.yml, CHANGELOG, and source.
- **Size:** S.

### 0.5 Retire the Model Evaluation Matrix

- **Problem:** The published per-release matrix shows three of four models at 100% with precision and recall of 1.0 and two with identical token counts; it cannot rank anything and a skeptical reader sees it as a red flag.
- **Change:** Stop publishing it. Replace the section with one honest sentence: findings precision is not yet measured, a ledger is being turned on, and numbers will appear when the sample is large enough to mean something. Phase 3 replaces it with something that can rank.
- **Done when:** No release notes or docs page carries the saturated table.
- **Size:** S.

---

## Phase 1: shrink the surface to what we will support (safe now)

### 1.1 Tier the 59 inputs into public, advanced, and internal

- **Problem:** 59 inputs with 0 required signals "unfinished" and makes the supported contract impossible to state.
- **Change:** Three tiers, enforced in `action.yml` descriptions and in the docs.
  - **Public (documented in the README, stable under semver):** `llm-base-url`, `model`, `llm-api-key`, `github-token`, `personas` (the enabled lanes), `fail-on` (the lowest verdict that fails the check), `on-no-review` (from 0.1), `max-tokens` (hard budget per review), `dry-run` (from 0.3). Target: ten or fewer.
  - **Advanced (documented in one `docs/` page, stable within a major):** per-lane model overrides, comment formatting, path filters, and the dispatch mode inputs behind a single `execution-mode` switch with values `local` and `dispatch`. `dispatch-url` keeps its consumer-facing default.
  - **Internal (description prefixed `[internal]`, no stability promise, removed in the next major):** everything that exists to operate the hosted lane or to feed the internal ledger.
  - Anything that can be moved out of `action.yml` into a repository config file goes there, so the action surface shrinks even if the capability does not.
- **Done when:** `action.yml` inputs in the public tier are the only ones in the README. A test asserts every input carries a tier marker. The count of non-internal inputs is published in the CHANGELOG each release so growth is visible.
- **Size:** M.

### 1.2 Rewrite the README as a product page, not a manual

- **Problem:** The quickstart is good, then the second section is a Kubernetes dispatch handshake.
- **Change:** README order, and nothing else: one-paragraph positioning; the quickstart exactly as it is today; a screenshot of one real review comment from this repository's own PRs; "how the verdict works" in five lines (four states, what fails the check, what P0/P1 mean, that P2 never gates); "what it costs" with the measured token range and the default model's list price per review; "what leaves your runner" linking the Phase 0.3 page; pinning guidance from 0.2; a link to the advanced page. The Kubernetes and dispatch material moves entirely to the advanced page. Target under 150 lines.
- **Done when:** A reader who stops at the screenshot knows what they get, what it costs, and what it sends. No mention of Kubernetes, DOKS, or dispatch appears in the README body.
- **Size:** S.

### 1.3 Decide the docs set and delete the rest

- **Problem:** 29 files in `docs/` with no site and no index.
- **Change:** After Phase 0.4 removals, cap public docs at six pages: data flow and privacy, configuration reference (advanced tier), verdict and severity model, cost and budget, execution modes (local and dispatch), and troubleshooting `NO_REVIEW`. Everything else is either merged into one of those or deleted. No docs site. GitHub renders Markdown well enough for six pages, and a site is maintenance the product has not earned.
- **Done when:** `docs/` contains six files and a README-linked index of exactly those six.
- **Size:** S.

---

## Phase 2: the first five minutes

### 2.1 Decide the zero-secret path (spike first)

- **Problem:** The biggest barrier for a stranger is not YAML; it is creating an OpenRouter account, adding a payment method, and pasting a key before seeing any value.
- **Change:** Run a one-week spike on GitHub Models as the no-key default: when `llm-api-key` is empty and the workflow grants the `models: read` permission, point at GitHub's OpenAI-compatible inference endpoint with the job's own token. The spike answers three questions with evidence: does a real six-lane review fit within that tier's per-request and per-day limits, which of the available models produces parseable lane output, and what does a review cost in wall time. The likely finding is that six full-diff passes do not fit, which makes 2.3 (the token diet) a prerequisite rather than an optimization. Decision rule, committed now: if a single-pass lite review fits, GitHub Models becomes the documented zero-secret default and OpenRouter becomes the "upgrade for stronger models" path. If it does not fit, do not fake it; keep OpenRouter as the first step and make 2.2 carry the onboarding.
- **Done when:** A stranger can add the four-line quickstart with no `with:` block and receive a real review on a small PR, or the spike report says why not and 2.2 is the fallback.
- **Size:** M for the spike; L if it becomes the default path.

### 2.2 Fail loudly and specifically on first run

- **Problem:** A first run that silently produces nothing, or a `NO_REVIEW` with a generic reason, loses the user before they have seen a review.
- **Change:** A preflight step runs before any model call and posts a single comment on failure naming the exact missing piece: no key and no `models: read` permission, key rejected by the endpoint, model not found at that base URL, diff larger than `max-tokens` allows. Each message contains the one-line fix. Preflight success is silent.
- **Done when:** Each preflight failure has a fixture and a screenshot in the troubleshooting page. Time from a bad key to a readable explanation is one workflow run.
- **Size:** S.

### 2.3 Token diet: send the diff once

- **Problem:** Six lanes each re-send the same diff, roughly 145 to 152 thousand tokens per evaluation, which sets both the cost floor and the free-tier ceiling.
- **Change:** One shared context-building pass produces the diff and file context once; lanes receive the shared context plus a lane-specific instruction, so the diff cost is paid once per review, not six times, on any endpoint that supports prompt caching, and the persona prompts are the only per-lane variance. Add a `lite` panel preset (one lane, one pass, findings only, no arbitration) for small PRs and for the zero-secret tier. The default remains the full panel.
- **Done when:** The Phase 0.3 footer on this repository's own PRs shows the per-review token total falling from the measured range; the target is set from the first week of footers, not guessed here.
- **Size:** L.

---

## Phase 3: evidence a skeptic can check (needs a spend decision)

### 3.1 Turn the ledger on for the self-review

- **Problem:** Precision and false-positive rate are unknown, not merely unpublished.
- **Change:** Enable the Postgres findings ledger for this repository's own PRs only. Record every finding, the lane that produced it, its severity, and its disposition: fixed, dismissed as wrong, dismissed as out of scope, or ignored to merge. Disposition comes from a lightweight reaction or reply convention on the finding comment, documented in the troubleshooting page. Nothing about other consumers is recorded without their opt-in.
- **Done when:** Thirty days of self-review findings have dispositions, and a per-lane precision figure can be computed from them.
- **Size:** M. Hosting the ledger is a human spend decision.

### 3.2 Build a seeded-bug benchmark that can actually rank models

- **Problem:** The retired matrix saturated because its inputs were too easy; an evaluation that returns 1.0 for everything is not an evaluation.
- **Change:** A small public benchmark repository of PRs with planted defects across the six persona domains, plus clean PRs as controls. Each model runs against it and is scored on detected planted defects, false findings on the clean controls, and tokens spent. Publish the scores and the fixture set so anyone can rerun them. The scoring script refuses to publish if every model scores the same, which is the guard against repeating the saturation.
- **Done when:** Published results show separation between at least two models, and a stranger can reproduce a row with their own key.
- **Size:** L.

### 3.3 Publish cost predictability

- **Problem:** A stranger cannot estimate their monthly bill.
- **Change:** `max-tokens` is a hard cap that produces `NO_REVIEW` with reason "budget exceeded" rather than a partial SHIP. The cost page shows the measured token range, the default model's list price, and a worked example per PR and per month for a stated PR volume. The footer from 0.3 makes actuals visible on every run.
- **Done when:** A reader can compute their expected cost from the page alone, and no review can exceed the cap.
- **Size:** S.

---

## Phase 4: adoption (needs listing and hosting decisions)

### 4.1 Marketplace listing

- **Problem:** Zero stars and no discovery path; the branding block already exists, so the listing is cheap.
- **Change:** List after Phases 0 and 1 are merged and one self-review with the new footer is visible. Not before. Listing an action that can still say SHIP without reviewing would be marketing a hazard.
- **Done when:** Listed, with the README screenshot and the quickstart as the first thing shown.
- **Size:** S. Listing is a human decision.

### 4.2 Self-review as the demo

- **Problem:** A skeptic's first question is "does it work on its own code?"
- **Change:** Every PR to this repository is reviewed by the action at the candidate SHA. The README links to the three most recent reviews, kept current by a small workflow. Reviews with `NO_REVIEW` outcomes are linked too; hiding them defeats the purpose.
- **Done when:** The links in the README resolve to live comments with the footer visible.
- **Size:** S.

### 4.3 Three examples, no more

- **Problem:** People copy workflows; they do not read reference pages.
- **Change:** An `examples/` directory with exactly three files: minimal (the quickstart), gated (fail the check on FIX_FIRST or worse, SHA-pinned, budget capped), and lite (one lane for small or high-volume repos). Each has a two-line header saying who it is for.
- **Done when:** Each example runs in this repository's CI on every release.
- **Size:** S.

### 4.4 One honest launch post

- **Problem:** Nobody knows it exists.
- **Change:** One post, after 3.1 has thirty days of data, leading with what it does not do (no auto-fix, no hosted account required, no data retention) and the measured precision from the self-review, whatever it is. No launch before the numbers exist.
- **Done when:** Published with the benchmark and ledger links.
- **Size:** S.

---

## What not to do

- **Do not build a docs site.** Six Markdown pages on GitHub are enough until adoption proves otherwise. A site is a maintenance commitment with no user behind it yet.
- **Do not add personas.** Six lanes already cost six times the diff. The product problem is precision and cost, not coverage.
- **Do not add inputs.** Every new capability goes into the config file or the advanced tier, and the public tier stays at or under ten. Growth in the input count is a regression to be explained in the CHANGELOG.
- **Do not lead with hosted or dispatch mode.** It is the mode with the most trust questions and the least relevance to a stranger. It stays supported and documented in the advanced page.
- **Do not price anything yet.** There is no measured value to price. Pricing a gate with unknown precision is selling a coin flip.
- **Do not make the free tier "work" by degrading silently.** If a review does not fit the budget or the tier, the answer is `NO_REVIEW` with a reason, never a thinner review labelled SHIP.
- **Do not chase auto-fix or suggested-change commits.** It multiplies the trust surface and competes with tools that already do it. The product is a verdict you can gate on.
- **Do not support providers with bespoke adapters.** OpenAI-compatible endpoints only. Anything else is the user's gateway problem.
- **Do not republish a model matrix until the benchmark can produce separation.** A saturated table is worse than no table.
- **Do not let `v1` move on release again**, even for a hotfix. Hotfixes ship as `vX.Y.Z` and go through the same promotion job.

---

## Decisions that need a human

| Decision | Needed before | Recommendation |
|---|---|---|
| Canary window length before `v1` promotion | 0.2 | 24 hours across the self-review and the internal consumers |
| Whether GitHub Models is acceptable as a default endpoint if the spike passes | 2.1 | Yes, with OpenRouter documented as the upgrade path |
| Hosting and spend for the self-review ledger | 3.1 | Smallest managed Postgres, self-review data only |
| Whether to fund the seeded-bug benchmark runs across paid models | 3.2 | Yes, monthly, at a fixed budget |
| Marketplace listing timing | 4.1 | After Phases 0 and 1 merge, not before |
| Whether dispatch mode remains a supported public surface or becomes internal-only | 1.1 | Keep public in the advanced tier; the default URL stays |
| Pricing of any kind | none in this plan | Defer until measured precision exists |

## Sequence at a glance

1. Phase 0 (about two weeks): passthrough removed, `v1` gated, data flow documented and provable, internal docs out, matrix retired.
2. Phase 1 (about one week): input tiers, README rewrite, six docs pages.
3. Phase 2 (two to four weeks): zero-secret spike, preflight, token diet.
4. Phase 3 (thirty days of data after the ledger is on): precision, benchmark, cost page.
5. Phase 4 (after Phase 3 has numbers): listing, self-review links, examples, one post.

The order is deliberate. Trust hazards first, because a public gate that can lie is not a product. Surface second, because a stranger cannot evaluate 59 inputs. Onboarding third, because it depends on the token diet. Evidence fourth, because the numbers do not exist yet. Adoption last, because there is nothing to adopt until the first four are done.
