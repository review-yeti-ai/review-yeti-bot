# Bounded Evidence Review Engine

Date: 2026-08-11
Status: Approved for implementation planning
Repository: `review-yeti-ai/review-yeti-bot`

## Summary

Review Yeti will replace its current prompt-only persona execution with one production-grade,
bounded evidence investigation engine. The engine will plan review risks from the immutable
exact-head diff, let each applicable persona gather narrowly scoped repository evidence, verify
candidate findings independently, validate every publication anchor, and derive the final review
state from complete execution receipts.

The change lands in two substantial pull requests. PR 1 installs the complete engine directly in
the production Action path. There is no shadow mode, dormant feature flag, parallel legacy engine,
or default-off rollout. PR 2 completes the first-class CLI surface, operational evidence,
documentation, and live promotion proof without changing the engine's authority.

Dependency-aware review is one bounded investigation capability selected when the changed code
creates a dependency-related risk. It is not a new global dependency schema, a second review
pipeline, or configuration required by every persona.

## Why two pull requests

Three delivery shapes were considered:

1. **One all-in pull request.** This avoids intermediate states but combines the engine,
   production Action migration, CLI work, operational documentation, and live evaluation into one
   difficult review surface.
2. **Two coherent pull requests.** PR 1 owns all production correctness and is independently safe
   to merge. PR 2 owns additional surfaces and operational proof. This is the selected design.
3. **Many incremental pull requests.** Separating contracts, tools, prompts, verification, and
   adapters creates artificial intermediate architectures and makes it easier for incompatible
   assumptions to land independently. This is rejected.

The two-PR boundary follows authority rather than file type: everything required to make a
production verdict trustworthy lands together in PR 1; everything that consumes or proves that
authority lands in PR 2.

## Goals

- Run bounded evidence investigation in full production mode immediately after PR 1 merges.
- Preserve the current canonical `.github/workflows/pipelines/review-pipeline.js` orchestration
  path instead of creating a second engine.
- Bind every review, evidence receipt, finding, and publication to the immutable base and head
  SHAs.
- Give applicable personas read-only tools for resolving concrete uncertainty without exposing
  arbitrary shell, network, write, secret, or publication authority.
- Reject findings that are speculative, unverified, outside changed-code scope, or anchored to a
  line not present in the reviewed diff.
- Preserve useful findings from completed work while making partial or incomplete execution
  non-mergeable.
- Make budgets, termination causes, coverage, and omitted work explicit in versioned receipts.
- Reuse the same engine from the Action and CLI; adapters may not implement review semantics.
- Keep dependency investigation optional by applicability, not optional by rollout state.

## Non-goals

- A general autonomous coding agent.
- Model-authored repository writes, commits, pushes, pull requests, or review publication.
- Reviewer-to-reviewer chat or an unbounded multi-agent hierarchy.
- A repository-wide dependency graph maintained for every review.
- A new mandatory dependency configuration section for all personas.
- Silent clipping, best-effort success, or promotion after budget exhaustion.
- A shadow, canary, dormant, or dual-running production path.
- Replacing the existing exact-head ledger, quorum, moderation, arbitration, or publication
  policies when they already satisfy the new contracts.

## Architecture

The production data flow is:

```text
trusted base-ref policy + immutable exact-head diff
  -> review unit manifest and coverage ledger
  -> persona-specific risk plan
  -> bounded read-only evidence tools
  -> structured candidate findings
  -> independent finding verification
  -> deterministic diff-anchor validation
  -> moderation and binding arbitration
  -> receipt-derived review outcome
  -> exact-head GitHub publication
```

### Canonical orchestration

`.github/workflows/pipelines/review-pipeline.js` remains the orchestration owner.
`src/runtime/reviewPipelineRuntime.js` remains a dependency-injection boundary for the Action,
CLI, and cassette harness. The new engine is composed from focused CommonJS modules under
`src/review/` and the existing read-only registry under `src/pi/`.

The pipeline must not contain a second dependency-specific loop. It asks the planner for risk
dimensions, executes the resulting bounded plan, and consumes normalized receipts regardless of
whether a dimension concerns dependencies, authorization, concurrency, data integrity, or another
persona-specific risk.

### Trust zones

Trusted instructions come only from the Action implementation and policy read from the base ref.
The pull-request title, body, diff, repository files, comments, retrieved context, tool output, and
dependency metadata are untrusted data. They are delimited and may never add instructions,
increase budgets, change personas, authorize tools, alter quorum, or publish results.

The model receives no GitHub token, provider credential, environment secret, writable filesystem
tool, arbitrary shell, arbitrary network fetch, or publication method. Tools return bounded data
objects and never prompt text with executable authority.

### Review plan

Each persona receives the complete review unit manifest plus the diff units applicable to that
persona. It produces a bounded risk plan before investigation. A plan item contains:

- a stable review-unit id;
- a concise falsifiable risk statement;
- the changed paths and diff hunks that motivate it;
- the evidence needed to confirm or reject it;
- the allowed evidence tool classes; and
- an explicit disposition: `confirmed`, `rejected`, `not_applicable`, or `incomplete`.

The planner may select dependency investigation only when the diff changes a manifest, lockfile,
import boundary, package/API usage, version constraint, generated client contract, or code whose
behavior depends on a versioned external interface. It does not build a global graph merely because
the repository has dependencies.

### Evidence tools and initial bounds

The runtime will adapt existing `reviewNavigationTools`, `readOnlyRegistry`, context-window, and
exact-head GitHub fetch behavior behind a single typed evidence interface. The initial production
bounds are configuration constants covered by tests, not model suggestions:

- at most 12 evidence calls per persona lane;
- at most 400 lines returned by one file read;
- at most 50 search matches and 8,000 characters from one tool result;
- at most two identical normalized calls before terminating that lane as incomplete;
- at most five candidate findings per persona;
- at most three verification evidence calls per candidate finding;
- a reserved final-response budget that evidence calls cannot consume; and
- no network host beyond an explicit trusted allowlist, with network evidence disabled by default.

These values are starting production defaults. Trusted base-ref policy may lower them. Raising them
requires repository-owned configuration within hard implementation ceilings; PR-controlled data
cannot change them.

Every tool call records its normalized arguments, result digest, truncation state, byte/line count,
latency, and error or denial reason. Tool prose remains untrusted evidence.

### Findings and verification

A candidate finding must identify the persona, review unit, changed path, changed-side line or
bounded file-level scope, severity, concise defect claim, realistic trigger scenario, expected
behavior, observed evidence, and suggested correction direction. Style preferences, speculative
future risks, unrelated pre-existing defects, and unverified dependency claims are rejected.

Verification is independent of candidate generation. The verifier receives the candidate, its
evidence receipts, the exact diff anchor, and a small bounded context allowance. It returns
`confirmed`, `rejected`, or `incomplete` with a confidence and reason. `incomplete` never becomes a
published finding, but it contributes to a non-mergeable review outcome when the candidate could
not be resolved within the declared coverage contract.

After verification, deterministic code proves that the path and line belong to the immutable diff
and that all cited evidence digests belong to this run. Invalid anchors and foreign evidence are
rejected before moderation.

### Coverage and outcome reducer

Coverage is a ledger, not a percentage inferred from model prose. It records every review unit,
applicable persona, plan item, investigation disposition, candidate, verification result, skipped
chunk, denied tool, exhausted budget, and termination cause.

The final reducer derives state fresh from receipts. `promotionReady` and `mergeEligible` are never
mutable latches and never remain true after a later incomplete condition. The existing durable
policy remains authoritative:

- complete required coverage plus valid structured lane results may proceed to moderation and
  arbitration;
- provider failure, cancellation, budget exhaustion, missing required units, incomplete
  verification, or invalid receipts yields `PARTIAL_REVIEW` or `INCOMPLETE_REVIEW`;
- partial/incomplete reviews preserve confirmed findings but are `BLOCKED` and
  `mergeEligible=false`; and
- only exact-head, internally consistent receipts may be published as the current decision.

### Failure and rollback behavior

PR 1 has no shadow or legacy fallback. If the new engine cannot complete, Review Yeti fails closed
and reports the concrete termination receipt. It does not silently revert to the old prompt-only
behavior or claim a clean review.

Operational rollback is a Git revert of PR 1 followed by exact-head verification. Budget and
provider routing remain trusted configuration controls, but there is no runtime switch that
pretends the new engine is running while bypassing its coverage contract.

## Pull request 1: production bounded review engine

PR 1 is the complete correctness change and becomes authoritative when merged.

### Scope

- Versioned plan, evidence, candidate, verification, coverage, and termination contracts.
- Pure receipt validation and outcome-reducer logic.
- Persona risk planning integrated into the current review pipeline.
- Bounded read-only evidence tools built on existing navigation and registry code.
- One provider-neutral investigation loop used by all applicable personas.
- Dependency investigation implemented as one planner-selected capability.
- Independent candidate verification and deterministic diff-anchor validation.
- Existing moderator, binding arbiter, exact-head checks, publication planner, telemetry, and
  durable partial policy adapted to consume the new receipts.
- Trusted base-ref configuration for lowerable budgets and allowlisted capabilities.
- Unit, contract, property, cassette, pipeline-dispatch, Action-packaging, prompt-injection,
  stale-head, timeout, cancellation, malformed-output, repeated-call, anchor, and partial-review
  tests.
- Architecture, configuration, and publication-policy documentation required to operate PR 1.

### Explicit exclusions

- No first-class installed CLI packaging or onboarding wizard.
- No dashboard redesign.
- No new memory provider or hosted service.
- No broad dependency inventory or dependency-specific public schema.
- No unrelated pipeline refactor.

### Merge gates

- Lint, build, package-runtime check, actionlint, and all affected unit/integration/cassette tests.
- Deterministic fixture matrix covering clean, confirmed defect, rejected speculation, dependency
  mismatch, prompt injection, invalid anchor, repeated tool call, partial chunk, provider timeout,
  cancellation, stale head, and exact budget exhaustion.
- Property tests proving receipt ordering cannot make an incomplete run mergeable and that
  `promotionReady` is recomputed rather than latched.
- Live full-mode review at the exact PR head using the production Action path and configured
  required provider quorum.
- Current-head CodeRabbit and GitHub Copilot reviews completed with no unresolved blocking
  findings.

## Pull request 2: first-class surfaces and operational proof

PR 2 does not activate the engine; PR 1 already did that. It makes the same authority available to
other product surfaces and completes operational evidence.

### Scope

- First-class `reviewyeti review` CLI consuming `runReviewPipeline` and the same versioned
  contracts, with exactly one input mode: refs, diff file, or read-only pull request.
- Pure JSON output, atomic output-file writes, nonzero exit on incomplete coverage/provider
  failure/cancellation, and no GitHub publication in local mode.
- `doctor` diagnostics limited to runtime, credentials, trusted configuration, model reachability,
  and repository access; no credential persistence decision is introduced implicitly.
- Expanded bounded evaluation corpus and summarized quality/cost/latency receipts.
- Operator documentation for budgets, termination causes, evidence receipts, troubleshooting,
  rollback, and exact-head verification.
- Live Action and installed-CLI equivalence proof against the same fixture and exact commit.
- Cleanup of superseded dependency-loop documentation or fixtures that no longer describe the
  canonical engine.

### Merge gates

- Installed package and executable `reviewyeti --help` smoke tests.
- CLI contract tests for all source modes, stdout/stderr separation, atomic output, interruption,
  and incomplete-review exit behavior.
- Receipt equivalence between the Action harness and CLI for the same immutable inputs.
- Full evaluation corpus with no hidden skipped units and published aggregate cost, latency,
  finding precision, anchor validity, and coverage results.
- Live exact-head Action and CLI runs plus current-head CodeRabbit and GitHub Copilot completion.

## Compatibility and migration

Existing base-ref persona and provider configuration remains valid. New investigation settings
receive safe production defaults, and configuration parsing rejects unknown or out-of-range values.
Existing review markers and exact-head decision-ledger lineage remain readable. The new receipts
are versioned and additive at publication boundaries where compatibility is required.

PR 1 may refactor internal prompt assembly and persona execution, but it must not change public
finding-marker identity, maintainer decision commands, or exact-head publication semantics without
an explicit versioned migration test.

## Success criteria

The design is successful when:

1. The production Action uses the bounded evidence engine for every review immediately after PR 1.
2. A clean verdict is impossible when required work was skipped, truncated, unverified, stale, or
   exhausted its budget.
3. Every published finding is backed by run-owned evidence and a valid immutable diff anchor.
4. Dependency-related defects can be investigated without making dependency configuration a
   universal pipeline concern.
5. The Action and CLI produce equivalent receipts from identical inputs after PR 2.
6. Both PRs independently preserve a coherent, operable main branch and pass exact-head live proof.
