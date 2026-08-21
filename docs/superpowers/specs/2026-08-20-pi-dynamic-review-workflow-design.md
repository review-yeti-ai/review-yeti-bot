# Pi Dynamic Review Workflow Design

**Status:** Approved for implementation on 2026-08-20

**Owner:** Review Yeti

**Target branch:** `review-yeti-ai/review-yeti-bot` `main`

## Summary

Review Yeti will use `@quintinshaw/pi-dynamic-workflows@3.7.0` as the shared orchestration kernel for hosted reviews, the local `reviewyeti` CLI, and local Pi handoff. Review Yeti remains the authority for immutable source resolution, trusted policy, review-unit assignment, provider transport, evidence tools, arbitration, receipts, and GitHub publication. Pi owns deterministic workflow execution, bounded concurrency, cancellation propagation, per-agent lifecycle, journaled resume, and local background execution.

The hosted workflow is a reviewed static script shipped with Review Yeti. Pull-request content may supply review data but can never supply executable workflow source. The local CLI remains exact-SHA, read-only, and publication-free.

## Problem

The current hosted pipeline launches persona promises together, but every streaming model request contends for a shared `streamGate`. The default five-person panel receives only two streaming slots. A persona's lane deadline is created before the gate admits the request, so later personas can spend most or all of their wall-clock budget waiting for siblings. The resulting failures look like provider timeouts even though the lane may not have reached a provider until late in its budget.

The implementation also has two orchestration surfaces:

- the hosted Action and local CLI share Review Yeti's monolithic pipeline; and
- local Pi can access a bounded MCP adapter but cannot execute the same review workflow as a first-class local handoff.

This design replaces the persona scheduler without creating a second review engine.

## Goals

- Dispatch the complete persona panel through one deterministic Pi workflow.
- Start each persona deadline when its agent actually starts.
- Fan out up to the configured panel size, with an explicit maximum of 16 enforced by Pi.
- Preserve Review Yeti's provider routing, bounded evidence investigation, structured output, arbitration, and publication behavior.
- Retry or resume only failed review assignments when immutable identity is unchanged.
- Produce equivalent hosted, CLI, and local Pi results for the same immutable input.
- Keep every incomplete, malformed, or missing lane fail-closed.
- Support a secret-free local Pi handoff without granting mutation or publication capabilities.
- Retain a bounded `legacy` rollback engine until the Pi engine passes promotion gates.

## Non-goals

- Letting models author hosted workflow source.
- Executing workflow code from the target repository or pull-request head.
- Replacing Review Yeti's provider transport with Pi's provider configuration in hosted CI.
- Giving local review agents write, shell, memory-write, or GitHub-publication tools.
- Changing review policy, persona charters, severity thresholds, or merge arbitration.
- Making partial quorum merge-eligible.
- Using Pi's Node VM as a security boundary.

## Approved dependency

Pin the orchestration package and its root-import/runtime peers exactly:

```json
"@quintinshaw/pi-dynamic-workflows": "3.7.0",
"@earendil-works/pi-ai": "0.84.1",
"@earendil-works/pi-coding-agent": "0.84.1",
"@earendil-works/pi-tui": "0.84.1",
"typebox": "1.3.7"
```

The reviewed npm integrities are:

| Package | Integrity |
|---|---|
| `@quintinshaw/pi-dynamic-workflows@3.7.0` | `sha512-zouAO72IlCHplCNdY+M3LgdcftDD5AbW3QakCpsbSU5oDRNZSlW+es9hBILXegRlFDHW0VgmfaYSdLCtWgMoJQ==` |
| `@earendil-works/pi-ai@0.84.1` | `sha512-wMsAdJMxuNri08vLqTyYVI201DQQezGhPSTkzYsHdw5dYX3rCNwEmSvpaAwhi7ELKI/2tE/CEgSWg/6iRxSgdQ==` |
| `@earendil-works/pi-coding-agent@0.84.1` | `sha512-ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A==` |
| `@earendil-works/pi-tui@0.84.1` | `sha512-udeXFbgEhJ6JiB0uguwNVNkDy2FENfmtQwPcY+/iJ8GWeq18wkal1tKqa5YyeH0IqtX1vG0cGh8zfSYzyzVuLA==` |
| `typebox@1.3.7` | `sha512-meKuifc33Pccx0O6PdIzYMq3Og8zvP4TIi/a+Bw3AEMZMxOD0+RHGQvpglEe6Zdy3wZ8nqn/j95h8LUZLk/6Hg==` |

The package requires Pi `>=0.80.8`; Review Yeti pins the tested `0.84.1` graph. `@quintinshaw/pi-dynamic-workflows@3.7.0` imports `@earendil-works/pi-ai` from its root without declaring it, so that package is an explicit direct dependency rather than an accidental npm-hoist assumption. These Pi packages require Node `>=22.19.0`; Review Yeti's supported Pi runtime is Node 24. Because the composite cannot safely invoke a nested `setup-node` action, callers selecting `pi-workflow` must provision Node 24 before invoking Review Yeti; that engine path performs a fail-fast semantic version check with a precise remediation message. The `legacy` engine does not import Pi and remains available during caller migration. Pi cannot become the default until every governed caller proves Node 24. Review Yeti's `package-lock.json` is the dependency ground truth for the complete production graph, including the exact direct packages above and Acorn. The Pi engine copies `package.json` and `package-lock.json` into an empty bounded prefix, runs `npm ci --omit=dev --ignore-scripts`, and copies that exact `node_modules` tree into `GITHUB_ACTION_PATH`; the legacy path preserves its current minimal dependency bootstrap until retirement. Neither path may resolve floating Pi peers in a consumer repository. An executable packaging test must reproduce the Pi install from an empty prefix under Node 24 and import both the package and Review Yeti's wrapper.

## Architecture

```text
immutable PR snapshot
  -> trusted Review Yeti policy
  -> review-unit manifest and deterministic persona assignments
  -> trusted Pi workflow script
       -> hosted injected agent runner -> existing Review Yeti lane implementation
       -> local read-only Pi runner     -> Pi agent sessions with mutation tools denied
  -> normalized persona results
  -> Review Yeti arbitration and receipt
       -> hosted GitHub publication
       -> local JSON/output file only
```

### Shared workflow script

Review Yeti ships one static script with schema version `review-yeti-pi-workflow.v1`. The script:

1. enters a `Review` phase;
2. calls `parallel()` over deterministic `args.assignments` order;
3. calls one `agent()` per assignment;
4. supplies the assignment ID as the label and a strict JSON Schema;
5. returns the ordered results array without model-authored orchestration;
6. never imports modules, reads files, accesses the network, or reads wall-clock/random state.

The script digest, cross-surface build provenance, base SHA, head SHA, diff digest, policy digest, manifest digest, and assignment digest are bound into the run identity. Build provenance schema `review-yeti-build-provenance.v1` contains a 40-hex `runtimeSourceRevision`, the exact package versions, the bounded canonical Pi dependency closure rooted at the five direct Pi packages, and `runtimeGraphDigest`. It is generated from the exact source revision during Action setup or npm `prepack`; it is not a self-referential checked-in file. Hosted generation requires the trusted exact Action SHA and validates the installed Pi closure after lockfile-backed `npm ci`. For npm, `bundledDependencies` includes all five direct Pi packages and npm packs their complete transitive closure inside Review Yeti. Installed-package execution resolves Pi only from that nested bundled tree, traverses it, and computes the actual `runtimeGraphDigest`; missing, hoisted, substituted, or mismatched packages fail before review. Source-checkout local runs require a clean exact commit and lock-valid install. Packaging tests install the produced tarball as an ordinary dependency into an empty consumer project, prove the Pi packages resolve from Review Yeti's bundled `node_modules`, attest the entire actual closure, and compare its digest to the hosted graph. Thus local execution does not pretend to possess an Action SHA or silently float transitive dependencies. Hosted receipts additionally bind the actual Action SHA; local receipts set that hosted-only field to null.

### Assignment contract

Every surface consumes the same closed `ReviewWorkflowAssignment` object. Its ID is:

```text
sha256(canonicalJson({
  schema: "review-yeti-assignment.v1",
  personaId,
  passes,
  assignmentPromptDigest,
  personaResultSchemaDigest,
  policyDigest,
  manifestDigest
}))
```

There is exactly one assignment per enabled persona. The object contains only `schema`, `assignmentId`, `personaId`, ordered `passes`, `assignmentPrompt`, `assignmentPromptDigest`, `personaResultSchema`, and `personaResultSchemaDigest`. Each closed pass descriptor contains `passId`, ordered `reviewUnitIds`, `prompt`, `promptDigest`, `outputSchema`, and `outputSchemaDigest`. A single `createReviewWorkflowAssignments()` producer builds the frozen persona list from current persona, pass, and review-unit manifest data. The hosted adapter invokes the existing `runPersonaLane()` once for that persona, preserving its ordered pass loop; it never fans individual passes out as separate agents. The local agent consumes the same ordered descriptors and must return the same persona-result schema. `digestReviewWorkflowAssignments()` digests that exact list. Hosted scheduling, journal identity, handoff serialization, local execution, and receipts consume this producer; they do not reconstruct assignment IDs independently.

### Hosted agent adapter

`runWorkflow()` accepts an injected object with `run(prompt, options)`. The hosted adapter resolves `options.label` to a precompiled Review Yeti assignment and invokes the existing bounded persona lane. It ignores model-authored routing changes and rejects unknown labels, prompt mismatches, duplicate starts, missing schemas, and assignments outside the immutable plan.

The persona lane creates its lane deadline inside the adapter invocation. No lane deadline exists while Pi is scheduling the assignment. The old shared stream gate is not supplied to Pi-engine lanes. Review Yeti's per-request TTFT, response timeout, per-lane call budget, provider quarantine, structured-output repair, evidence limits, cancellation signal, `AttemptTrace`, and `STREAM_SUMMARY` remain unchanged. Existing `queue_wait_ms` retains its meaning: time waiting for the legacy stream/provider-admission gate. Pi-engine attempts set it to zero or null. Pi scheduling delay is recorded separately as `scheduler_queue_wait_ms`/`schedulerQueueWaitMs`; the implementation extends the existing telemetry contracts rather than creating a parallel trace.

### Concurrency

The default Pi concurrency is the number of enabled personas, clamped to `1..16`. The trusted Action input/config may lower the limit but may not exceed the panel size or 16. All assignments are scheduled immediately. Pi's semaphore controls active agent calls, and Review Yeti records `scheduledAt`, `startedAt`, `completedAt`, and `schedulerQueueWaitMs` separately.

### Journal and resume

Successful assignments may be journaled. Review Yeti derives a stable `workflowRunId` from immutable run identity and explicitly passes it as Pi's `runId`; a later invocation passes the same value as `resumeFromRunId`. Auto-generated timestamp run IDs are not eligible for cross-invocation reuse. A journal entry is reusable only when all of these match exactly:

- repository, source kind, and pull-request number when source kind is `pull_request`;
- base SHA and head SHA;
- diff digest;
- trusted config and policy digests;
- manifest and assignment digests;
- workflow schema and script digest;
- Pi package version, runtime source revision, and runtime graph digest;
- exact Review Yeti action SHA for hosted-to-hosted reuse, or null for local-to-local reuse;
- persona ID and assignment ID.

Any identity mismatch rejects the entire resume request rather than mixing evidence. Failed, cancelled, empty, malformed, or incomplete assignments are never cached as successful.

Pi 3.7.0's native journal replays only the longest unchanged successful call prefix. That is insufficient when an early assignment fails but later siblings succeed. Review Yeti therefore adds an exact-assignment result cache above Pi's journal. The injected runner checks the immutable `assignmentId` cache first and returns a validated successful result with lifecycle status `reused`; only a cache miss invokes the live lane. This guarantees that a retry executes only failed or missing assignments regardless of original position. Pi's positional journal remains enabled as an optimization, not the correctness boundary.

`onAgentJournal` is synchronous in Pi. Review Yeti either performs a bounded synchronous atomic append or queues writes and explicitly awaits the drain before constructing the final receipt or exiting the Action. A receipt cannot claim reusable evidence until the positional journal and assignment cache are durable. Corrupt, partial, stale, or identity-mismatched state fails closed.

Hosted cross-invocation reuse is explicit and opt-in. The Action exposes `pi-resume-mode: off|restore-save` (default `off`), optional `pi-resume-source-cache-key`, and outputs the new content-addressed cache key plus journal/cache digests. In `restore-save` mode it restores only the caller-supplied exact predecessor key; it never uses prefix restore keys. Each validated state records `generation`, nullable `parent_cache_key`, and its content digest. After the durability barrier, changed state is saved under an append-only key derived from repository ID, action SHA, runtime graph digest, stable `workflowRunId`, generation, and content digest. Unchanged complete state reuses its existing key. Because Actions caches are immutable, the implementation never attempts to overwrite a prior key. Restored bytes are untrusted and must pass complete identity, parent-chain, schema, size, digest, and forbidden-field validation before use. Cache miss/conflict/API error starts clean or fails closed according to explicit mode and is recorded without weakening review. The three-run acceptance fixture proves partial generation 0 save, exact generation 0 restore plus recovery and generation 1 save, then exact generation 1 restore with all assignments reused. Local handoff uses explicit `--journal`/`--assignment-cache` paths under the same validation contract.

The existing one-bounded-infrastructure retry remains governed by Pi. After the first workflow returns, Review Yeti persists successful assignment results, classifies retryable failures with the existing policy, and if needed invokes a second trusted Pi workflow round over the same ordered persona assignments. Its injected runner returns cached successes and executes only retryable misses; no persona lane is called directly outside Pi. The retry round uses a deterministic `workflowRunId:infra-retry-1` suffix while retaining the same immutable identity and records both rounds in lifecycle/receipt data.

### Failure behavior

- A null agent result becomes an explicit `ERROR` persona result.
- A thrown recoverable transport failure follows the existing one-bounded-infra-retry policy.
- A second failure remains incomplete and blocks publication approval.
- A malformed structured result is a schema failure, not an approval.
- Cancellation propagates to Pi and every hosted provider request.
- A run timeout aborts outstanding agents and produces a fail-closed receipt.
- No failed lane causes already completed sibling evidence to be discarded.

## Local CLI and Pi handoff

### CLI engine selection

The local CLI adds:

```text
reviewyeti review ... --engine pi-workflow
reviewyeti review ... --engine legacy
```

`pi-workflow` becomes the default only after promotion. Both engines call the canonical Review Yeti runtime with `publicationMode: 'none'`.

### Handoff contract

The CLI adds:

```text
reviewyeti pi handoff --base <sha> --head <sha> --output <path>
reviewyeti pi handoff --pr <owner/repo#number> --output <path>
reviewyeti pi run --handoff <path> [--output <path>]
```

The output schema is `review-yeti-pi-handoff.v1` and contains:

- immutable repository, `sourceKind: "pull_request" | "commit_range"`, conditionally nullable PR number, base SHA, head SHA, and diff digest;
- bounded canonical config, policy, manifest, and assignment preimages plus their digests;
- workflow schema/package versions;
- deterministic assignments and bounded prompts;
- concurrency, timeout, retry, and token-budget controls;
- `publicationMode: "none"` and `readOnly: true`.

It also contains a top-level digest over the complete canonical handoff. This lets `pi run` recompute every declared digest rather than trusting unverifiable digest strings. It must not contain credentials, authorization headers, provider keys, raw environment values, GitHub tokens, memory write handles, or publication capabilities. The file is written atomically with mode `0600`.

`pi run` validates every digest before execution. It resolves an immutable head snapshot and verifies that its repository/head/diff identity matches the handoff; mutable or dirty caller `cwd` contents are not a review evidence source. The native `WorkflowAgent` itself runs with a sterile temporary `cwd` owned by Review Yeti and a custom resource loader that exposes only packaged Review Yeti instructions; it must not auto-load target `AGENTS.md`, `.pi`, skills, prompts, extensions, or themes as privileged context. The agent receives an explicit complete `tools` list containing only Pi read-only `read`, `grep`, `find`, and `ls` definitions whose roots are bound to the immutable snapshot. The existing Pi/MCP adapter remains metadata-only by design and is not exposed as an evidence tool in v1; no adapter metadata is misrepresented as file content. `bash`, `edit`, `write`, `workflow`, and `workflow_control` remain denied as defense in depth, but the positive active-tool registry is the security contract and is asserted at runtime and in tests. Local runs never call the GitHub publisher.

## Receipts and observability

Add a strict provider-owned sidecar receipt `review-dispatch-run.v3` in `.github/workflows/pipelines/review-pipeline.js`, updating its real consumers and documentation together. The existing canonical v2 output remains unchanged during PR 1; new `review-dispatch-v3-digest` and `review-dispatch-v3-receipt-path` outputs provide the sidecar. PR 3 may switch canonical outputs only after repository-wide GitHub code search identifies every strict v2 consumer, each consumer has landed dual-read support, and compatibility tests prove both versions. The standalone `src/review/reviewDispatchReceipt.*` v1 helper is not the live provider-owned boundary.

V3 retains every v2 snake_case field and bound, except `action_sha` becomes 40-hex-or-null and is required to be 40-hex for `execution_context: "hosted"` and null for `"local"`, while `pr_number` becomes positive-integer-or-null. `source_kind: "pull_request"` requires a positive PR number; `"commit_range"` requires null. Hosted execution requires `pull_request`. It adds these closed fields:

- `engine`: `"pi-workflow" | "legacy"`;
- `execution_context`: `"hosted" | "local"`;
- `source_kind`: `"pull_request" | "commit_range"`;
- `runtime_source_revision`: full 40-hex SHA;
- `runtime_graph_digest`: SHA-256;
- `workflow_schema_version`: `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`;
- `workflow_script_digest`: SHA-256;
- `workflow_package`: exactly `@quintinshaw/pi-dynamic-workflows`;
- `workflow_package_version`: exactly `3.7.0` for v1;
- `workflow_run_id`: `^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$`;
- `concurrency`: integer `1..16`;
- `assignment_lifecycle`: array of at most 32 closed objects `{assignment_id, persona_id, round, scheduled_at_ms, started_at_ms, completed_at_ms, scheduler_queue_wait_ms, status, reuse_source}` where `assignment_id` is 64 lowercase hex, `persona_id` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`, `round` is `0|1`, timestamps are safe integers `0..8640000000000000` with `scheduled <= started <= completed`, wait is a safe integer equal to `started-scheduled`, status is `completed|reused|failed|cancelled|timed_out`, and reuse source is `none|pi_journal|assignment_cache` consistent with status;
- `resume`: closed object `{mode, source_run_id, journal_digest, assignment_cache_digest, reused_assignment_ids}` where mode is `off|restore-save|local-path`, source run ID is null or the workflow-run pattern above, each digest is null or 64 lowercase hex, and reused IDs are at most 16 unique 64-lowercase-hex assignment IDs;
- `failure_classifications`: at most 32 closed objects `{assignment_id, round, classification}` where assignment ID is 64 lowercase hex, round is `0|1`, and classification is `transport|timeout|cancelled|schema|missing|null_result|identity|persistence`.

Raw prompts, secrets, hidden reasoning, and provider error payloads remain forbidden receipt fields.

Receipt construction is separate from publication. Hosted and local executions build and validate the same v3 semantic receipt, but only hosted execution may publish it to GitHub. Local CLI/Pi writes the receipt atomically under `publicationMode: "none"`. Equivalence compares immutable identity, normalized assignment results, coverage, findings, and arbitration while explicitly normalizing timestamps and run-local paths.

## Security model

- Hosted workflow source comes only from the pinned Review Yeti action SHA.
- Target repository and PR-head files are untrusted data.
- Pi's VM provides deterministic orchestration, not process isolation.
- Hosted execution uses an injected Review Yeti runner, so Pi receives no filesystem or GitHub mutation tools.
- Local native agents deny mutation, shell, recursive workflow, and publication tools.
- Handoff files are data, never imported JavaScript.
- Publication remains available only through the hosted canonical Review Yeti publisher.
- Exact package, embedded build provenance, runtime graph, workflow, policy, manifest, and hosted action digests are recorded and validated.

## Delivery topology

### PR 1: Trusted Pi orchestration kernel

- Pin and package the dependency for npm and the composite Action.
- Add the static workflow, hosted adapter, identity validation, journal store, and v3 receipt fields.
- Integrate the Pi engine behind `review-engine` with `legacy` rollback.
- Correct deadline start semantics and remove pre-provider stream-gate budget burn.

### PR 2: CLI and local Pi handoff

- Add engine selection and handoff commands.
- Add the read-only native Pi runner.
- Add handoff validation, atomic output, and documentation.
- Keep all local execution publication-free.

### PR 3: Equivalence and default promotion

- Add deterministic hosted/CLI/Pi equivalence fixtures.
- Add cancellation, resume, malformed output, and supply-chain tests.
- Run current-head provider-backed proof.
- Switch the trusted default to `pi-workflow` only after all gates pass.

PR 1 blocks PR 2; PR 2 blocks PR 3. Each PR targets official `main` and must be rebased onto current `main` immediately before final validation and merge.

## Acceptance criteria

- Five persona assignments are scheduled as one Pi workflow and may all start before any completes.
- Queue wait never consumes lane deadline.
- One failed lane can be retried/resumed without rerunning completed lanes, including when it precedes successful siblings.
- Identity drift, including runtime-source, runtime-graph, or hosted action-SHA drift, refuses journal or assignment-cache reuse.
- Null, malformed, missing, and incomplete lanes block.
- Hosted, CLI, and local Pi normalize the same fixture to the same arbitration result.
- Local CLI/Pi never publish or expose write tools.
- Composite Action installation uses `npm ci` from the reviewed lockfile in an empty prefix, and its executable import smoke test passes.
- Unit, integration, action packaging, CLI, Pi adapter, cassette, chaos, and equivalence tests pass.
- A current-head provider-backed run returns a complete receipt with no hidden queue burn.
- Review Yeti's protected required checks approve the exact merge head.

## Alternatives considered

### Shell out to `pi`

Rejected because startup, authentication, session ownership, cancellation, and receipt extraction are harder in hosted Actions. Library embedding provides the same runtime contract with a narrower boundary.

### Keep the internal scheduler and export only a Pi handoff

Rejected because hosted and local execution would continue to use different orchestrators, preserving the queue/deadline defect and making equivalence weaker.

### Load workflow scripts from the target repository

Rejected because target content is untrusted and Pi does not claim to sandbox hostile workflow code.
