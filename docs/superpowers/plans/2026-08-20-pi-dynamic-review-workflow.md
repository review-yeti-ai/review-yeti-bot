# Pi Dynamic Review Workflow Implementation Plan

> [!WARNING]
> **Historical plan; non-authoritative.** This records a point-in-time proposal, not current runtime,
> provider, release, or fleet policy. See
> [Documentation authority](../../DOCUMENTATION_AUTHORITY.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Review Yeti's queue-burning persona scheduler with a pinned Pi dynamic workflow shared by hosted reviews, the publication-free CLI, and local Pi handoff.

**Architecture:** A trusted static `review-yeti-pi-workflow.v1` script calls Pi's `parallel()` over deterministic Review Yeti assignments. Hosted CI injects the existing Review Yeti persona-lane runner, while local Pi uses a mutation-denied native agent; Review Yeti remains authoritative for immutable identity, policy, evidence, arbitration, receipts, and publication.

**Tech Stack:** Node.js 24 CommonJS host with dynamic ESM import, `@quintinshaw/pi-dynamic-workflows@3.7.0`, exact Pi `0.84.1` runtime peers, TypeScript declarations, Vitest, Node test runner, GitHub composite Action, Review Yeti CLI.

**Spec:** `docs/superpowers/specs/2026-08-20-pi-dynamic-review-workflow-design.md`

## Global Constraints

- Pin `@quintinshaw/pi-dynamic-workflows` exactly to `3.7.0` with npm integrity `sha512-zouAO72IlCHplCNdY+M3LgdcftDD5AbW3QakCpsbSU5oDRNZSlW+es9hBILXegRlFDHW0VgmfaYSdLCtWgMoJQ==`; pin direct runtime peers `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` to `0.84.1`, plus `typebox` to `1.3.7`, in the same lockfile. Node must be `>=22.19.0`; hosted and release validation use Node 24.
- Hosted workflow source comes only from the pinned Review Yeti Action SHA; never execute workflow source from target or pull-request content.
- Keep Review Yeti authoritative for immutable source, trusted policy, assignments, provider transport, evidence, arbitration, receipts, and GitHub publication.
- The local CLI and local Pi always use `publicationMode: 'none'` and never expose shell, mutation, memory-write, recursive-workflow, or GitHub-publication tools.
- A lane deadline starts inside the agent runner when the assignment starts; scheduler queue time never consumes it.
- Concurrency defaults to the enabled persona count and is clamped to `1..16` and never above the assignment count.
- Null, empty, malformed, missing, cancelled, or incomplete agent results remain fail-closed.
- Journal and assignment-cache reuse require exact repository, source kind, conditional PR number, base/head/diff, config/policy/manifest/assignment/workflow, embedded runtime source revision, runtime graph digest, package version, persona, and assignment identity; hosted reuse additionally requires exact Action SHA.
- Reuse is keyed by an explicit stable `workflowRunId`; never rely on Pi's timestamp-generated run ID across invocations.
- Preserve the existing `AttemptTrace`/`STREAM_SUMMARY` contracts and `queue_wait_ms` stream-gate meaning; add distinct scheduler-wait fields rather than parallel telemetry.
- Receipts never include prompts, credentials, authorization values, hidden reasoning, raw source, tool output, or provider error payloads.
- Preserve a trusted `legacy` rollback engine until the Pi engine passes exact-head promotion gates.
- Use test-first development: every behavior test must be observed failing before implementation and must exercise the real Review Yeti boundary rather than a tautological mock.

---

### Task 1: Pin and package the Pi workflow runtime

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `action.yml`
- Modify: `README.md`
- Modify: `docs/CONFIGURATION_REFERENCE.md`
- Create: `src/pi/dynamicReviewWorkflow.js`
- Create: `src/pi/dynamicReviewWorkflow.d.ts`
- Create: `src/pi/reviewWorkflowScript.js`
- Create: `src/pi/reviewWorkflowScript.d.ts`
- Create: `src/review/reviewWorkflowAssignments.js`
- Create: `src/review/reviewWorkflowAssignments.d.ts`
- Create: `scripts/install-action-runtime.mjs`
- Create: `scripts/generate-build-provenance.mjs`
- Create: `scripts/stage-publish-package.mjs`
- Create: `src/provenance/buildProvenance.js`
- Create: `src/provenance/buildProvenance.d.ts`
- Create: `tests/unit/dynamicReviewWorkflow.test.ts`
- Create: `tests/unit/reviewWorkflowAssignments.test.ts`
- Create: `tests/unit/buildProvenance.test.ts`
- Modify: `tests/unit/reviewActionPackaging.test.ts`

**Interfaces:**
- Produces: `loadPiWorkflowRuntime(): Promise<{ runWorkflow: Function, WorkflowAgent: Function }>`.
- Produces: `REVIEW_WORKFLOW_SCHEMA_VERSION = 'review-yeti-pi-workflow.v1'`.
- Produces: `REVIEW_WORKFLOW_PACKAGE = '@quintinshaw/pi-dynamic-workflows'` and `REVIEW_WORKFLOW_PACKAGE_VERSION = '3.7.0'`.
- Produces: generated `review-yeti-build-provenance.v1` with runtime source revision, exact Pi dependency-closure preimage, and actual runtime graph digest. Action setup generates it from exact Action SHA after lock-valid `npm ci`. Npm `bundledDependencies` ships the five direct Pi packages and their transitive closure inside Review Yeti; runtime attestation requires Pi to resolve from that nested bundle and compares the actual closure before review.
- Produces: `trustedReviewWorkflowScript(): { source: string, digest: string }`.
- Produces: `createReviewWorkflowAssignments(input): readonly ReviewWorkflowAssignment[]` and `digestReviewWorkflowAssignments(assignments): string` using the closed `review-yeti-assignment.v1` schema defined in the design: exactly one assignment per enabled persona, containing its ordered pass descriptors and a persona-result schema.
- Produces: `runDynamicReviewWorkflow(options): Promise<DynamicReviewWorkflowResult>` where options contain immutable identity, assignments, stable `runId`, optional `resumeFromRunId`, concurrency, deadline, injected agent runner, signal, journal, and lifecycle callbacks.
- Consumes: Pi's `runWorkflow(script, { args, agent, runId, resumeFromRunId, concurrency, maxAgents, agentTimeoutMs, signal, resumeJournal, onAgentJournal, persistLogs })`.

- [ ] **Step 1: Add assignment, dependency, build-provenance, and static workflow RED tests.** Assert the closed assignment schema and deterministic ID/digest factory creates one persona assignment with ordered pass descriptors; exact package version/integrity; Action provenance generation requires exact Action SHA and attests the lock-valid Pi closure; `bundledDependencies` names all five direct Pi packages; npm staging includes provenance plus their full transitive closure from the exact clean release commit; an empty consumer `npm install <tarball>` resolves Pi from Review Yeti's nested bundle and runtime attestation matches the hosted digest; deleting/substituting/hoisting a bundled transitive fails before review; dirty/detached-unidentified packaging fails; static script digest stability; deterministic persona order; explicit `runId`/`resumeFromRunId`; concurrency clamp; unknown/duplicate assignment rejection; null result rejection; and dynamic ESM loading from CommonJS.

- [ ] **Step 2: Run the focused test and capture RED.**

Run: `npx vitest run tests/unit/reviewWorkflowAssignments.test.ts tests/unit/buildProvenance.test.ts tests/unit/dynamicReviewWorkflow.test.ts tests/unit/reviewActionPackaging.test.ts`

Expected: FAIL because the runtime modules and composite Action dependency installation do not exist.

- [ ] **Step 3: Pin the package and root runtime peers with npm.**

Run: `npm install --save-exact @quintinshaw/pi-dynamic-workflows@3.7.0 @earendil-works/pi-ai@0.84.1 @earendil-works/pi-coding-agent@0.84.1 @earendil-works/pi-tui@0.84.1 typebox@1.3.7`

Verify exact versions/integrities for all five direct packages from `package-lock.json`, then run the empty-prefix import test under Node 24. The direct `pi-ai` pin is mandatory because dynamic-workflows imports it without declaring it.

- [ ] **Step 4: Implement build provenance, bundled npm runtime, static script, and wrapper.** Generate the bounded Pi dependency closure from the reviewed lock. For hosted use, require exact Action SHA and attest the `npm ci` closure. For npm, configure `bundledDependencies` for all five direct Pi packages, stage provenance into the tarball from the exact clean release commit, and verify the complete transitive closure is nested in the package. On local startup, require Pi resolution from that nested bundle and compare the actual closure to provenance. The wrapper dynamically imports the ESM package only after provenance validation, validates immutable assignments, passes a finite agent timeout, and converts null/missing results into fail-closed errors.

- [ ] **Step 5: Implement one lockfile-backed Pi-engine install script and call it from the composite.** When `review-engine=pi-workflow`, fail fast unless caller-provisioned Node is `>=22.19.0` and document Node 24 as required; copy root `package.json` plus `package-lock.json` into an empty bounded prefix; run `npm ci --prefix <prefix> --omit=dev --ignore-scripts --no-audit --no-fund`; copy the resulting `node_modules` into `GITHUB_ACTION_PATH`; and import both `@quintinshaw/pi-dynamic-workflows` and Review Yeti's wrapper. Preserve the existing minimal legacy dependency bootstrap while `review-engine=legacy`; never use its lockfile-less installs to resolve Pi packages. The packaging test executes the exact Pi install script from an empty prefix under Node 24 rather than grepping YAML. Keep the trusted default on `legacy` until governed consumer workflows provision Node 24.

- [ ] **Step 6: Run focused GREEN tests.**

Run: `npx vitest run tests/unit/reviewWorkflowAssignments.test.ts tests/unit/buildProvenance.test.ts tests/unit/dynamicReviewWorkflow.test.ts tests/unit/reviewActionPackaging.test.ts`

Expected: PASS with no new warnings.

- [ ] **Step 7: Run supply-chain and build checks.**

Run: `npm run test:action-contract && npm run lint && npm run build && npm audit --omit=dev`

Expected: Action contract, lint, and build pass; audit output is recorded and any production vulnerability introduced by the Pi dependency is resolved before commit.

- [ ] **Step 8: Commit.**

```bash
git add -- package.json package-lock.json action.yml README.md docs/CONFIGURATION_REFERENCE.md scripts/install-action-runtime.mjs scripts/generate-build-provenance.mjs scripts/stage-publish-package.mjs src/provenance/buildProvenance.js src/provenance/buildProvenance.d.ts src/pi/dynamicReviewWorkflow.js src/pi/dynamicReviewWorkflow.d.ts src/pi/reviewWorkflowScript.js src/pi/reviewWorkflowScript.d.ts src/review/reviewWorkflowAssignments.js src/review/reviewWorkflowAssignments.d.ts tests/unit/reviewWorkflowAssignments.test.ts tests/unit/buildProvenance.test.ts tests/unit/dynamicReviewWorkflow.test.ts tests/unit/reviewActionPackaging.test.ts
git commit -m "feat(pi): add trusted dynamic review workflow runtime"
```

### Task 2: Integrate hosted persona fan-out and deadline semantics

**Files:**
- Create: `src/review/piHostedAgentRunner.js`
- Create: `src/review/piHostedAgentRunner.d.ts`
- Modify: `.github/workflows/pipelines/review-pipeline.js`
- Modify: `action.yml`
- Create: `tests/unit/piHostedAgentRunner.test.ts`
- Modify: `tests/unit/reviewPipelineModel.test.ts`
- Modify: `tests/unit/reviewPipelineDispatch.test.ts`
- Modify: `tests/integration/reviewWorkflow.integration.test.ts`
- Modify: `src/telemetry/streamSummary.js`
- Modify: `tests/unit/streamSummary.test.ts`
- Modify: `tests/unit/streamSummaryEmission.test.ts`

**Interfaces:**
- Consumes: Task 1 `runDynamicReviewWorkflow()` and trusted workflow constants.
- Produces: `createHostedPiAgentRunner({ assignments, runAssignment, now }): { run(prompt, options): Promise<PersonaResult> }`.
- Produces: trusted engine selection `resolveReviewEngine(value): 'pi-workflow' | 'legacy'`.
- Produces: lifecycle records `{ assignmentId, scheduledAt, startedAt, completedAt, schedulerQueueWaitMs, status }`.
- Preserves: existing `runPersonaLane(persona)` provider/evidence behavior and returned persona result shape.
- Extends: existing `AttemptTrace`/`STREAM_SUMMARY` with `scheduler_queue_wait_ms`; preserves `queue_wait_ms` as legacy stream/provider-admission wait and every existing TTFT/stall/deadline field.

- [ ] **Step 1: Add hosted adapter RED tests.** Consume Task 1's assignment factory and prove five persona assignments can all enter `runAssignment` before any resolves; each invokes its existing ordered multi-pass `runPersonaLane()` exactly once; unknown labels, prompt/digest mismatches, and duplicate starts fail; cancellation reaches every in-flight assignment; and configured concurrency is clamped.

- [ ] **Step 2: Add pipeline RED tests.** Use a frozen scheduler/clock to prove a persona's lane deadline is created only after its Pi agent starts and queue wait does not reduce the lane budget. Prove `legacy` retains the previous scheduler and `pi-workflow` never supplies `streamGate` to persona transports. Force one retryable persona failure and prove the existing bounded-infra retry executes as a second Pi round, reuses successful siblings from the exact-assignment cache, and never calls `runPersonaLane()` outside Pi.

- [ ] **Step 3: Run RED tests.**

Run: `npx vitest run tests/unit/piHostedAgentRunner.test.ts tests/unit/reviewPipelineModel.test.ts tests/unit/reviewPipelineDispatch.test.ts tests/integration/reviewWorkflow.integration.test.ts`

Expected: FAIL because hosted Pi execution and engine selection are absent.

- [ ] **Step 4: Implement the hosted adapter.** Bind labels/prompts to Task 1's frozen assignments, record lifecycle timestamps and distinct scheduler queue wait, create the deadline inside `runAssignment`, and propagate the Pi signal into existing cancellation links.

- [ ] **Step 5: Integrate the Pi scheduler, retry round, and existing telemetry.** Replace the initial persona `Promise.all` and its same-run bounded-infra retry boundary. First round dispatches all persona assignments; after current retry classification, a deterministic second Pi round uses exact-assignment cache hits for successes and invokes only retryable failures. Keep manifest generation, navigation snapshot, evidence registries, provider routing, retry policy, aggregation, arbitration, `AttemptTrace`, `STREAM_SUMMARY`, and publication unchanged. Pi lanes omit the stream gate, retain `queue_wait_ms` as zero/null, and populate `scheduler_queue_wait_ms` separately.

- [ ] **Step 6: Add trusted engine configuration.** Add composite Action input `review-engine` accepting only `pi-workflow|legacy`; inputs may select `legacy` or the trusted default but cannot enable an untrusted engine value.

- [ ] **Step 7: Run focused GREEN tests.**

Run: `npx vitest run tests/unit/piHostedAgentRunner.test.ts tests/unit/reviewPipelineModel.test.ts tests/unit/reviewPipelineDispatch.test.ts tests/integration/reviewWorkflow.integration.test.ts`

Expected: PASS with five-lane fan-out, correct deadline start, and unchanged arbitration fixtures.

- [ ] **Step 8: Run regression suites.**

Run: `npm run test:action-runtime && npm run test:fixtures && npm run test:cassettes && npm run test:chaos`

Expected: PASS; any fixture update is limited to new engine/lifecycle receipt fields.

- [ ] **Step 9: Commit.**

```bash
git add -- src/review/piHostedAgentRunner.js src/review/piHostedAgentRunner.d.ts src/telemetry/streamSummary.js .github/workflows/pipelines/review-pipeline.js action.yml tests/unit/piHostedAgentRunner.test.ts tests/unit/reviewPipelineModel.test.ts tests/unit/reviewPipelineDispatch.test.ts tests/unit/streamSummary.test.ts tests/unit/streamSummaryEmission.test.ts tests/integration/reviewWorkflow.integration.test.ts
git commit -m "feat(review): run persona panel through Pi workflow"
```

### Task 3: Add exact-identity journal and v3 dispatch receipts

**Files:**
- Create: `src/review/piWorkflowJournal.js`
- Create: `src/review/piWorkflowJournal.d.ts`
- Create: `src/review/piAssignmentResultCache.js`
- Create: `src/review/piAssignmentResultCache.d.ts`
- Create: `src/review/piWorkflowPersistence.js`
- Create: `src/review/piWorkflowPersistence.d.ts`
- Modify: `.github/workflows/pipelines/review-pipeline.js`
- Create: `tests/unit/piWorkflowJournal.test.ts`
- Create: `tests/unit/piAssignmentResultCache.test.ts`
- Create: `tests/unit/piWorkflowPersistence.test.ts`
- Modify: `tests/unit/reviewDispatchReceipt.test.ts`
- Modify: `tests/unit/reviewPipelineDispatch.test.ts`
- Modify: `tests/support/reviewYetiReceiptAdapterContract.mjs`
- Modify: `tests/unit/reviewActionPackaging.test.ts`
- Modify: `action.yml`
- Modify: `README.md`
- Modify: `docs/CONFIGURATION_REFERENCE.md`
- Modify: `scripts/assert-test-receipts.mjs`

**Interfaces:**
- Produces: `PI_WORKFLOW_JOURNAL_SCHEMA = 'review-yeti-pi-journal.v1'`.
- Produces: `createPiWorkflowRunIdentity(input)`, `digestPiWorkflowRunIdentity(identity)`, and stable `workflowRunId`; universal identity uses embedded runtime source revision and runtime graph digest, while hosted identity additionally includes Action SHA.
- Produces: `loadPiWorkflowJournal({ path, identity })`, bounded durable journal writes, and an explicit persistence barrier before receipt completion.
- Produces: an exact-identity assignment-result cache keyed by Task 1 `assignmentId`, checked by the injected runner before live dispatch.
- Produces: Action inputs `pi-resume-mode: off|restore-save` and optional exact `pi-resume-source-cache-key`, plus content-addressed successor cache key and journal/cache digest outputs. Persistence uses pinned `@actions/cache` without restore prefixes and treats restored bytes as untrusted.
- Produces: a strict snake_case `review-dispatch-run.v3` sidecar matching the closed schema in the design. PR 1 leaves canonical v2 outputs intact and adds v3 path/digest outputs. The unused standalone v1 helper is out of scope. PR 3 may promote v3 only after all real strict v2 consumers discovered by GitHub code search land dual-read support.

- [ ] **Step 1: Add journal, assignment-cache, and hosted persistence RED tests.** Cover exact identity acceptance; stable explicit run ID reused as Pi `runId`/`resumeFromRunId`; rejection for every base/head/diff/config/policy/manifest/assignment/workflow/package/runtime-source/runtime-graph mismatch and, for hosted state, Action-SHA mismatch; local identity requires null Action SHA; atomic file replacement; `0600` permissions; journal durability before receipt completion; prompt/secret forbidden-field scanning; cancelled/failed/null entries not reusable; and exact successful assignment IDs replayed even when a failed assignment precedes successful siblings. Stub `@actions/cache` to prove `off` never restores/saves; `restore-save` restores only the explicit exact predecessor key with no prefix fallback; state validates identity/generation/parent/content digest before use; changed state saves under a new content-addressed generation key only after durability; unchanged state reuses its key; and cache miss/conflict/API error follows the explicit fail-closed policy. The test sequence is partial generation 0 -> restore/recover/save generation 1 -> restore generation 1 and reuse all.

- [ ] **Step 2: Add receipt RED tests.** Require the exact closed v3 fields and bounds in the design, including hosted/pull-request versus local/commit-range action-SHA and PR-number nullability; engine; workflow schema/script/package/version/run ID; concurrency; lifecycle timestamps; scheduler wait; and reuse metadata. Assert prompts, tokens, auth values, provider error payloads, and raw source remain forbidden.

- [ ] **Step 3: Run RED tests.**

Run: `npx vitest run tests/unit/piWorkflowJournal.test.ts tests/unit/piAssignmentResultCache.test.ts tests/unit/piWorkflowPersistence.test.ts tests/unit/reviewDispatchReceipt.test.ts tests/unit/reviewPipelineDispatch.test.ts tests/unit/reviewActionPackaging.test.ts`

Expected: FAIL because journal and v3 receipt fields do not exist.

- [ ] **Step 4: Implement bounded journal identity, storage, stable run keys, and append-only persistence.** Use canonical JSON/SHA-256 helpers already used by review receipts; derive `workflowRunId` from complete immutable identity; pass it as Pi `runId` and later `resumeFromRunId`; cap entries to Task 1 assignments; reject unknown keys and non-plain objects. Because Pi's callback is synchronous, either synchronously commit bounded atomic records or feed a tracked queue explicitly drained before receipt completion and process exit. For hosted `restore-save`, accept only an explicit predecessor cache key, validate identity/generation/parent/digest, and save changed state under a new generation+content-digest key after the durability barrier; never overwrite an immutable Actions cache key. Emit the successor key, paths, and digests as outputs.

- [ ] **Step 5: Wire positional journal plus exact assignment replay.** Pass validated entries as Pi `resumeJournal`, persist only `onAgentJournal` successes, and wrap the injected runner with an exact-assignment result cache so only failed/missing lanes execute live regardless of call position. Record Pi-prefix reuse and assignment-cache reuse separately in the final receipt.

- [ ] **Step 6: Add v3 sidecar and coordinated consumer compatibility.** Keep canonical v2 builder/output byte-compatible. Add the exact closed v3 snake_case builder/validator in the pipeline, `tests/support/reviewYetiReceiptAdapterContract.mjs`, new Action v3 outputs, README/configuration docs, and test-receipt assertions. Include distinct scheduler queue wait while preserving stream-gate `queue_wait_ms` and AttemptTrace. Construct the same v3 semantic receipt for local runs outside the GitHub-publication guard with `action_sha: null`; local output remains publication-free. Search GitHub code across CallTelemetry for `review-dispatch-run.v2` and current output names, record every real consumer, and create/update the dependent compatibility issue before PR 1 merges.

- [ ] **Step 7: Run GREEN and receipt checks.**

Run: `npx vitest run tests/unit/piWorkflowJournal.test.ts tests/unit/piAssignmentResultCache.test.ts tests/unit/piWorkflowPersistence.test.ts tests/unit/reviewDispatchReceipt.test.ts tests/unit/reviewPipelineDispatch.test.ts tests/unit/reviewActionPackaging.test.ts && npm run test:receipts`

Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add -- src/review/piWorkflowJournal.js src/review/piWorkflowJournal.d.ts src/review/piAssignmentResultCache.js src/review/piAssignmentResultCache.d.ts src/review/piWorkflowPersistence.js src/review/piWorkflowPersistence.d.ts .github/workflows/pipelines/review-pipeline.js tests/unit/piWorkflowJournal.test.ts tests/unit/piAssignmentResultCache.test.ts tests/unit/piWorkflowPersistence.test.ts tests/unit/reviewDispatchReceipt.test.ts tests/unit/reviewPipelineDispatch.test.ts tests/support/reviewYetiReceiptAdapterContract.mjs tests/unit/reviewActionPackaging.test.ts action.yml README.md docs/CONFIGURATION_REFERENCE.md scripts/assert-test-receipts.mjs
git commit -m "feat(review): journal exact Pi workflow assignments"
```

### Task 4: Add publication-free CLI engine and Pi handoff

**Files:**
- Create: `src/pi/piHandoff.js`
- Create: `src/pi/piHandoff.d.ts`
- Create: `src/pi/piLocalRunner.js`
- Create: `src/pi/piLocalRunner.d.ts`
- Create: `src/pi/piToolDefinitions.js`
- Create: `src/pi/piToolDefinitions.d.ts`
- Create: `src/pi/piTrustedResourceLoader.js`
- Create: `src/pi/piTrustedResourceLoader.d.ts`
- Modify: `src/cli/reviewyetiCli.js`
- Modify: `src/cli/reviewyetiCli.d.ts`
- Modify: `src/runtime/reviewPipelineRuntime.js`
- Modify: `bin/reviewyeti.js`
- Create: `tests/unit/piHandoff.test.ts`
- Create: `tests/unit/piLocalRunner.test.ts`
- Modify: `tests/unit/reviewyetiCli.test.ts`
- Modify: `tests/integration/actionCliEquivalence.integration.test.ts`
- Modify: `docs/PI_MCP_ADAPTER.md`
- Modify: `README.md`

**Interfaces:**
- Produces: `PI_HANDOFF_SCHEMA_VERSION = 'review-yeti-pi-handoff.v1'`.
- Produces: `createPiHandoff(input)`, `validatePiHandoff(value)`, `writePiHandoff(path, handoff)`, and `readPiHandoff(path)` with bounded canonical identity preimages plus an overall handoff digest.
- Produces: `createPiSnapshotToolDefinitions(snapshotRoot)` returning only identity-bound `read|grep|find|ls` as the complete positive tool registry. The existing metadata-only Pi/MCP adapter is deliberately not an evidence tool.
- Produces: `createTrustedPiResourceLoader()` that loads packaged Review Yeti resources only and ignores target-repository `AGENTS.md`, `.pi`, skills, prompts, extensions, and themes.
- Produces: `runLocalPiHandoff({ handoff, immutableSnapshot, output, signal })` with sterile agent `cwd`, trusted resource loader, explicit read-only registry, and publication disabled.
- Extends CLI: `review --engine pi-workflow|legacy`, `pi handoff`, and `pi run --handoff`.

- [ ] **Step 1: Add handoff RED tests.** Assert exact schema; `sourceKind=pull_request` requires a positive PR number while `commit_range` requires null; never synthesize a PR number for `--base/--head`; bounded canonical config/policy/manifest/assignment preimages; recomputation of every digest and top-level handoff digest; deterministic serialization; atomic `0600` output; forbidden secret fields; rejection of executable script fields; bounded prompt size; and immutable source selection.

- [ ] **Step 2: Add local runner RED tests.** Assert the actual active Pi tool names are exactly `read`, `grep`, `find`, and `ls`, all rooted at the immutable snapshot; the metadata-only Pi/MCP adapter is absent; mutation and recursive tools are absent and denied; publication is always none; a hostile handoff cannot widen tools; cancellation exits 130; and the shared v3 semantic receipt/output is atomic. Create a mutable `cwd` whose contents disagree with the handoff head and prove those bytes are inaccessible while the verified immutable-head snapshot is readable. Put hostile `AGENTS.md`, `.pi` skills/prompts/extensions/themes, and project instructions in the target snapshot and prove the agent resource loader never consumes them as privileged context.

- [ ] **Step 3: Add CLI RED tests.** Cover help, argument exclusivity, engine values, handoff creation, handoff execution, JSON purity, nonzero fail-closed exits, and no GitHub publication calls.

- [ ] **Step 4: Run RED tests.**

Run: `npx vitest run tests/unit/piHandoff.test.ts tests/unit/piLocalRunner.test.ts tests/unit/reviewyetiCli.test.ts tests/integration/actionCliEquivalence.integration.test.ts`

Expected: FAIL because the commands and contracts are absent.

- [ ] **Step 5: Implement the handoff contract, immutable snapshot, and CLI parsing.** Reuse exact-SHA source adapters to materialize or verify an immutable head snapshot; never point native read tools at the caller's mutable checkout. Include bounded canonical preimages needed to recompute all identity digests plus a top-level handoff digest. Handoff JSON contains no JavaScript source and cannot select tools or publication mode.

- [ ] **Step 6: Implement the local read-only Pi runner, trusted resource loader, and snapshot ToolDefinitions.** Run `WorkflowAgent` from a sterile Review Yeti temporary `cwd` with a custom resource loader exposing packaged trusted instructions only. Give it an explicit complete `read|grep|find|ls` tool list bound to the separate verified immutable snapshot; keep the existing metadata-only Pi/MCP adapter out of the evidence registry; retain mutation/recursive excludes as defense in depth; invoke the same trusted script and shared v3 receipt builder used by hosted CI.

- [ ] **Step 7: Update documentation with exact commands and boundaries.** State that local reviews are read-only, publication-free, and require a trusted repository/Pi installation.

- [ ] **Step 8: Run GREEN tests and CLI smoke.**

Run: `npm run test:cli && npm run test:equivalence && npm run test:pi-adapter && node bin/reviewyeti.js --help`

Expected: PASS and help lists the new engine/handoff commands.

- [ ] **Step 9: Commit.**

```bash
git add -- src/pi/piHandoff.js src/pi/piHandoff.d.ts src/pi/piLocalRunner.js src/pi/piLocalRunner.d.ts src/pi/piToolDefinitions.js src/pi/piToolDefinitions.d.ts src/pi/piTrustedResourceLoader.js src/pi/piTrustedResourceLoader.d.ts src/cli/reviewyetiCli.js src/cli/reviewyetiCli.d.ts src/runtime/reviewPipelineRuntime.js bin/reviewyeti.js tests/unit/piHandoff.test.ts tests/unit/piLocalRunner.test.ts tests/unit/reviewyetiCli.test.ts tests/integration/actionCliEquivalence.integration.test.ts docs/PI_MCP_ADAPTER.md README.md
git commit -m "feat(cli): add read-only Pi workflow handoff"
```

### Task 5: Prove equivalence and promote the Pi engine

**Files:**
- Create: `tests/fixtures/pi-workflow/five-persona-review.json`
- Create: `tests/fixtures/pi-workflow/resume-one-failed.json`
- Create: `tests/fixtures/pi-workflow/malformed-lane.json`
- Create: `tests/integration/piWorkflowEquivalence.integration.test.ts`
- Create: `tests/integration/piWorkflowChaos.integration.test.ts`
- Modify: `tests/integration/actionCliEquivalence.integration.test.ts`
- Modify: `tests/unit/reviewWorkflowFixtures.test.ts`
- Modify: `tests/unit/reviewWorkflowScenarioExpectations.test.ts`
- Modify: `.github/workflows/e2e-review-gate.yml`
- Modify: `scripts/e2e-review-gate.mjs`
- Modify: `action.yml`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/CONFIGURATION_REFERENCE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Tasks 1-4 hosted/local engines and receipts.
- Produces: exact equivalence assertion over verdict, normalized persona results, findings, coverage, dispatch units, and immutable receipt identity.
- Promotes: trusted default `review-engine` from `legacy` to `pi-workflow`; `legacy` remains an explicit rollback value.

- [ ] **Step 1: Add equivalence RED fixtures.** The five-persona fixture must prove all starts occur before the first completion; the resume fixture puts the failure before successful siblings and proves the exact-assignment cache reruns only that failure across a later invocation using the same stable run identity; the malformed fixture proves null/schema failures block.

- [ ] **Step 2: Add chaos RED tests.** Cover cancellation during fan-out, one signal-ignoring runner bounded by finite timeout, provider transient retry, journal corruption, stale head, workflow digest mismatch, and Action dependency import failure.

- [ ] **Step 3: Run RED tests.**

Run: `npx vitest run tests/integration/piWorkflowEquivalence.integration.test.ts tests/integration/piWorkflowChaos.integration.test.ts tests/integration/actionCliEquivalence.integration.test.ts`

Expected: FAIL until all cross-surface normalization and gates are wired.

- [ ] **Step 4: Implement fixture harness and exact comparisons.** Hosted, CLI, and local Pi each build the same validated v3 semantic receipt; local construction occurs without publication and has null Action SHA. Compare semantic fields and normalize only timestamps and run-local paths explicitly declared nondeterministic; never omit verdict, coverage, findings, assignment identity, stable workflow run identity, engine, runtime source revision, runtime graph digest, or workflow digest. Assert hosted Action SHA exactly and local nullability exactly rather than pretending they are identical.

- [ ] **Step 5: Add the Pi workflow to the E2E gate.** Run a no-publication exact-head fixture in CI and upload its v3 dispatch receipt/journal summary.

- [ ] **Step 6: Run all deterministic gates.**

Run: `npm run test:all`

Expected: PASS with no waived baseline or feature failure. If current official `main` is red before implementation, record and resolve that prerequisite separately before using this command as a merge gate.

- [ ] **Step 7: Run package and CLI smoke in clean installs.**

Run: `npm pack --dry-run && npm run build && npm run test:action-contract && npm run test:e2e-review-gate`, then install the produced tarball into an empty Node 24 consumer and run runtime-graph attestation plus CLI help.

Expected: package contains the Pi runtime/CLI files, Action import succeeds, and E2E receipt is complete.

- [ ] **Step 8: Capture provider-backed current-head proof.** Run the trusted hosted workflow against an immutable test PR with five personas, no publication, full concurrency, and exact action SHA. Record workflow URL, base/head/action SHA, workflow/package digests, start/completion timings, zero incomplete lanes, and the v3 receipt artifact.

- [ ] **Step 9: Promote the trusted default.** Change `review-engine` default to `pi-workflow`, retain `legacy`, and rerun the exact deterministic and provider-backed gates on the promotion commit.

- [ ] **Step 10: Commit.**

```bash
git add -- tests/fixtures/pi-workflow/five-persona-review.json tests/fixtures/pi-workflow/resume-one-failed.json tests/fixtures/pi-workflow/malformed-lane.json tests/integration/piWorkflowEquivalence.integration.test.ts tests/integration/piWorkflowChaos.integration.test.ts tests/integration/actionCliEquivalence.integration.test.ts tests/unit/reviewWorkflowFixtures.test.ts tests/unit/reviewWorkflowScenarioExpectations.test.ts .github/workflows/e2e-review-gate.yml scripts/e2e-review-gate.mjs action.yml docs/ARCHITECTURE.md docs/CONFIGURATION_REFERENCE.md README.md
git commit -m "feat(review): promote Pi workflow engine"
```

### Task 6: Split, review, and land the three PRs

**Files:**
- Modify: `docs/superpowers/specs/2026-08-20-pi-dynamic-review-workflow-design.md`
- Modify: `docs/superpowers/plans/2026-08-20-pi-dynamic-review-workflow.md`
- Create through GitHub: three PR descriptions and exact-head validation receipts
- Update through Linear: umbrella issue and three child issues with PR links and final receipts

**Interfaces:**
- PR 1 contains Tasks 1-3 and targets current official `main`.
- PR 2 is prepared locally atop PR 1 but is opened only after PR 1 merges; it then rebases onto and targets current official `main`.
- PR 3 is prepared locally atop PR 2 but is opened only after PR 2 merges; it then rebases onto and targets current official `main`.

- [ ] **Step 1: Run a whole-branch review over each PR slice.** Use the exact merge base/head, review the complete diff, fix all Critical/Important findings, and record any adjudicated minor with rationale.

- [ ] **Step 2: Push PR 1 and link its Linear child.** Use the `jasonbarbee` GitHub account, official remote, base `main`, exact base/head SHAs, package integrity, local test receipts, and rollback value.

- [ ] **Step 3: Monitor PR 1 through required checks.** Rebase if official `main` moves, rerun current-head tests/review, and merge only when Review Yeti's exact-head required check approves.

- [ ] **Step 4: Rebase/push/land PR 2.** Regenerate exact dependency and CLI receipts after rebase; verify local publication remains none.

- [ ] **Step 5: Rebase/push/land PR 3.** Capture provider-backed exact-head receipt after the final rebase and merge only while official `main` remains the tested base.

- [ ] **Step 6: Update Linear and docs with merged SHAs.** Record three PR URLs, tested heads, merge commits, package/workflow digests, hosted run URL, and final engine default. Do not claim success for skipped/no-lane jobs or partial review.

- [ ] **Step 7: Verify official `main`.** Fresh-clone or clean-worktree `npm ci`, `npm run test:all`, CLI help/handoff smoke, Action contract, and one no-publication Pi workflow receipt from the merged SHA.
