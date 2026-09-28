# E2E Test Infra: DOKS Runner Agentic Harness Improvements (API-3330 & API-3333)

## Test Philosophy
- **Opaque-Box & Requirement-Driven**: Tests validate external wire contracts, Kubernetes manifests, operator reconciliation behavior, and lifecycle invariants derived strictly from `ORIGINAL_REQUEST.md` and `PROJECT.md § Feature Inventory`.
- **Zero Internal Dependency**: No reliance on private methods, unexposed AST functions, or synthetic monkey-patches. All tests interact exclusively through public APIs, wire JSON parsers, schema validators, and Kubernetes CR/Job projections.
- **Strict Invariant Verification**: Rigorous enforcement of tripartite fencing (fencing epoch vs. execution attempt vs. worker lease token), 100% wire parity with `urn:review-yeti:agent-harness:v1`, strict `.000Z` timestamps, payload limits (<=65,536 bytes), controlled namespace boundary (`ct-review-system`), and UNKNOWN effect safety.
- **Methodology**: 4-Tier Test Architecture combining Category-Partition, Boundary Value Analysis (BVA), Pairwise Combinatorial Interaction, and Real-World Lifecycle Scenarios.

---

## Feature Inventory

Every feature from `PROJECT.md § Feature Inventory` is mapped across all 4 tiers:

| # | Feature | Description | Source | Tier 1 (Coverage) | Tier 2 (Boundaries) | Tier 3 (Cross-Feature) | Tier 4 (Real-World) | Total Tests |
|---|---------|-------------|--------|:-----------------:|:-------------------:|:----------------------:|:-------------------:|:-----------:|
| 1 | TS Harness Wire Contracts & Zod Schemas | Schema validation, RFC 8785 canonical JSON, request digest hashing, receipt validation | ORIGINAL_REQUEST R1 & spec_miner | 5 | 5 | ✓ | ✓ | 10+ |
| 2 | Runner WorkRequest Envelope Generation | `K8sJobRunner.buildWorkRequest` with 9 mandatory scope fields, <=65,536 bytes, `.000Z` millis | ORIGINAL_REQUEST R1 & explorer_survey_ts | 5 | 5 | ✓ | ✓ | 10+ |
| 3 | Runner Identity & Fencing Injection | Container environment (`CT_*`), Downward API, volume staging via initContainer | ORIGINAL_REQUEST R1 & explorer_survey_ts | 5 | 5 | ✓ | ✓ | 10+ |
| 4 | Runner Pod Completion & Receipt Validation | Pod wait, receipt extraction, request digest match, evidence invariant enforcement | ORIGINAL_REQUEST R1 & explorer_survey_ts | 5 | 5 | ✓ | ✓ | 10+ |
| 5 | Task Observer Lifecycle Hooks & Phase Mapping | Phase mapping (`INTENT`->`INTENDED`, etc.), <=5 proposals capping, permission denial stop | ORIGINAL_REQUEST R3 & spec_miner | 5 | 5 | ✓ | ✓ | 10+ |
| 6 | Go CRD Identity & Fencing Epoch Fields | `PRReviewJobSpec` & `Status` fencing fields, tripartite identity separation, CEL rules | ORIGINAL_REQUEST R2 & explorer_survey_go | 5 | 5 | ✓ | ✓ | 10+ |
| 7 | Go Operator Fencing Fail-Closed Reconciliation | Epoch & lease token comparison, fail-closed condition setting on mismatch | ORIGINAL_REQUEST R2 & explorer_survey_go | 5 | 5 | ✓ | ✓ | 10+ |
| 8 | Go Operator Safe Pod Termination & UNKNOWN Effect Guard | Preemption/eviction handling, UNKNOWN effect preservation, immutable termination record | ORIGINAL_REQUEST R2 & explorer_survey_go | 5 | 5 | ✓ | ✓ | 10+ |
| 9 | Go Operator Terminal Deletion Receipt Auditability | Persist receipt digest & evidence before resource deletion and secret cleanup | ORIGINAL_REQUEST R2 & explorer_survey_go | 5 | 5 | ✓ | ✓ | 10+ |
| 10 | Controlled Execution Environment Enforcement | Strict namespaced boundary (`ct-review-system`), reject `default` / `kube-*`, zero cluster mutations | ORIGINAL_REQUEST R4 | 5 | 5 | ✓ | ✓ | 10+ |
| 11 | Comprehensive E2E Testing Suite (Tiers 1-4) | Systematic multi-tier tests, runner script, status reporting, exit code semantics | Project Pattern E2E Track | 5 | 5 | ✓ | ✓ | 10+ |
| 12 | Final Integration & Offline Contract Qualification | Parity with `ct-meta` Python validator, Go controller tests, TS unit tests | ORIGINAL_REQUEST Acceptance | 5 | 5 | ✓ | ✓ | 10+ |
| **Total** | | | | **60** | **60** | **8** | **6** | **134** |

---

## Test Architecture

- **Primary Test Runner**: Vitest (`npx vitest run tests/e2e/agentHarnessE2E.test.ts`)
- **Standalone CLI Runner**: Node.js (`node tests/e2e/run-agent-harness-e2e.mjs`)
- **Test File Location**: `tests/e2e/agentHarnessE2E.test.ts`
- **Runner Script Location**: `tests/e2e/run-agent-harness-e2e.mjs`
- **Pass/Fail Semantics**: Clean exit code `0` on 100% pass; non-zero exit code (`1`) on any test failure.
- **Execution Target**: Offline, deterministic, zero network consumption, zero live token budget consumption.

---

## Coverage Goals by Tier

### Tier 1: Feature Coverage (Isolation Happy Paths — >=5 per feature = 60 tests)

#### F1: TS Harness Wire Contracts & Zod Schemas
- `TEST_T1_F1_01`: WorkRequest Schema Validation — Validates a fully-formed `ct-agent-work-request.v1` payload with all 18 closed properties.
- `TEST_T1_F1_02`: ExecutionReceipt Schema Validation — Validates a conforming `ct-agent-execution-receipt.v1` payload with all 12 closed properties.
- `TEST_T1_F1_03`: RFC 8785 Canonical JSON Serialization — Confirms deterministic lexicographical key ordering, UTF-16 code unit ordering, `-0` converted to `"0"`, and unpadded formatting.
- `TEST_T1_F1_04`: Cryptographic Request Digest Hasher — Confirms SHA-256 calculation matches canonical payload with `sha256:` prefix and 64 lowercase hex characters.
- `TEST_T1_F1_05`: Receipt Binding Qualification — Evaluates `checkReceiptBinding` verifying scope, request digest, lease token, clock sequence, and budget constraints.

#### F2: Runner WorkRequest Envelope Generation
- `TEST_T1_F2_01`: WorkRequest Explicit Scope Generation — Confirms `K8sJobRunner.buildWorkRequest` produces valid envelope when all 9 scope fields are explicitly provided.
- `TEST_T1_F2_02`: WorkRequest Default Scope Resolution — Confirms `tenant_id: 'ct'`, `environment_id: 'qualification'`, `workspace_id: 'factory'`, `generation: 1`, `fencing_epoch: 1` are correctly defaulted.
- `TEST_T1_F2_03`: Repository URL Normalization — Normalizes HTTPS, SSH (`git@github.com:...`), and `.git` URLs into standard `owner/repo` format.
- `TEST_T1_F2_04`: Strict Millisecond Timestamp Formatting — Asserts `created_at` and `deadline` strictly match `YYYY-MM-DDTHH:mm:ss.000Z` format with `created_at < deadline`.
- `TEST_T1_F2_05`: Input References & Synthetic Commit Digest — Confirms `input_refs` includes commit artifact with SHA-256 digest and `classification: 'synthetic'`.

#### F3: Runner Identity & Fencing Injection
- `TEST_T1_F3_01`: Container Environment Identity Injection — Asserts all 12 `CT_*` environment variables (`CT_LOGICAL_CHILD_ID`, `CT_FENCING_EPOCH`, `CT_MISSION_ID`, `CT_GENERATION`, `CT_EXECUTION_ID`, `CT_TENANT_ID`, `CT_ENVIRONMENT_ID`, `CT_WORKSPACE_ID`, `CT_REPOSITORY`, `CT_REQUEST_DIGEST`, `CT_WORK_REQUEST_PATH`, `CT_EXECUTION_RECEIPT_PATH`) are properly injected into reviewer container.
- `TEST_T1_F3_02`: Downward API Identity Injection — Asserts `CT_POD_NAME` and `CT_POD_NAMESPACE` use Kubernetes `fieldRef` pointing to `metadata.name` and `metadata.namespace`.
- `TEST_T1_F3_03`: InitContainer WorkRequest Staging — Verifies initContainer `stage-work-request` carries canonical JSON payload in `CT_WORK_REQUEST_PAYLOAD` and writes to `/workspace/.ct-harness/work-request.json`.
- `TEST_T1_F3_04`: Job Metadata Labels & Annotations — Confirms Job and Pod templates inject `review-yeti.ai/logical-child-id`, `review-yeti.ai/fencing-epoch`, and `review-yeti.ai/request-digest`.
- `TEST_T1_F3_05`: Pod Security Context Invariants — Confirms `runAsNonRoot: true`, `runAsUser: 1000`, `allowPrivilegeEscalation: false`, and `capabilities: { drop: ['ALL'] }`.

#### F4: Runner Pod Completion & Receipt Validation
- `TEST_T1_F4_01`: Successful Receipt Extraction & Validation — Validates receipt with outcome `succeeded`, non-empty `evidence_refs`, and all effects `SUCCEEDED`.
- `TEST_T1_F4_02`: Failed Receipt Extraction & Validation — Validates receipt with outcome `failed`, `evidence_refs`, and failure diagnostics.
- `TEST_T1_F4_03`: Canceled Receipt Extraction & Validation — Validates receipt with outcome `cancelled`, verifying effects remain non-promoted.
- `TEST_T1_F4_04`: Request Digest Parity Verification — Validates that `receipt.request_digest` strictly equals `requestDigest(workRequest)`.
- `TEST_T1_F4_05`: Scope Parity Verification — Validates that `receipt.scope` matches `workRequest.scope` across all 9 scope fields.

#### F5: Task Observer Lifecycle Hooks & Phase Mapping
- `TEST_T1_F5_01`: Authoritative Phase Projection — Validates `projectEffectState` accurately projects candidate phases (`INTENT`->`INTENDED`, `EXECUTING`->`IN_FLIGHT`, `SUCCEEDED`->`SUCCEEDED`, `FAILED`->`FAILED`, `UNKNOWN`->`UNKNOWN`, `RECONCILING`->`UNKNOWN`, `MANUAL`->`UNKNOWN`).
- `TEST_T1_F5_02`: Standard Forward Phase Transition — Validates `checkEffectTransition` allows `INTENT` -> `EXECUTING` -> `SUCCEEDED` with valid evidence digest.
- `TEST_T1_F5_03`: Reconciling Phase Transition Sequence — Validates `checkEffectTransition` allows `EXECUTING` -> `UNKNOWN` -> `RECONCILING` -> `SUCCEEDED`.
- `TEST_T1_F5_04`: Checkpoint Proposal Creation & Impact Sorting — Confirms proposals are sorted by impact (`high` > `medium` > `low`) then recurrence descending.
- `TEST_T1_F5_05`: Hard Stop Permission Denial Recording — Confirms `createTaskObserverCheckpoint` records `permission_denied: true` as an immutable hard stop signal.

#### F6: Go CRD Identity & Fencing Epoch Fields
- `TEST_T1_F6_01`: Spec Fencing Fields Serialization — Asserts `PRReviewJobSpec` correctly unmarshals `fencingEpoch`, `workerLeaseToken`, and `logicalChildId`.
- `TEST_T1_F6_02`: Status Audit Fields Serialization — Asserts `PRReviewJobStatus` correctly unmarshals `authoritativeFencingEpoch`, `activeWorkerLeaseToken`, `receiptDigest`.
- `TEST_T1_F6_03`: Tripartite Identity Field Independence — Asserts Mission Fencing Epoch, Child Execution Attempt, and Worker Lease Token are separate non-interchangeable fields.
- `TEST_T1_F6_04`: Condition Constants Definition — Asserts `ConditionFencingEpochMismatch`, `ConditionStaleWorkerLease`, and `ConditionUnknownEffectPending` exist and conform to Kubernetes API standards.
- `TEST_T1_F6_05`: CRD Spec Immutability CEL Assertion — Validates that CEL rule enforces immutability of `fencingEpoch`, `workerLeaseToken`, and `logicalChildId` across spec updates.

#### F7: Go Operator Fencing Fail-Closed Reconciliation
- `TEST_T1_F7_01`: Matching Fencing Epoch Reconcile Success — Verifies reconciliation proceeds when `spec.FencingEpoch == authoritativeEpoch`.
- `TEST_T1_F7_02`: Matching Worker Lease Token Reconcile Success — Verifies reconciliation proceeds when `spec.WorkerLeaseToken == activeLeaseToken`.
- `TEST_T1_F7_03`: Epoch Mismatch Fail-Closed Reconciliation — Verifies reconciliation immediately halts and sets `ConditionFencingEpochMismatch = True` on epoch discrepancy.
- `TEST_T1_F7_04`: Stale Lease Token Fail-Closed Reconciliation — Verifies reconciliation immediately halts and sets `ConditionStaleWorkerLease = True` on stale worker lease.
- `TEST_T1_F7_05`: Reconcile Idempotence on Stale Epoch — Verifies subsequent reconciliation loops remain halted and never overwrite the failure condition.

#### F8: Go Operator Safe Pod Termination & UNKNOWN Effect Guard
- `TEST_T1_F8_01`: Clean Pod Completion Recording — Asserts `WorkerTerminationStatus` records `exitCode: 0`, `reason: "Completed"`, transitioning status phase to `Succeeded`.
- `TEST_T1_F8_02`: Pod OOMKilled Termination Capture — Asserts `WorkerTerminationStatus` records `exitCode: 137`, `reason: "OOMKilled"`, transitioning phase to `Failed`.
- `TEST_T1_F8_03`: Pod Eviction Recording — Asserts `WorkerTerminationStatus` records `podReason: "Evicted"` without corrupting status history.
- `TEST_T1_F8_04`: UNKNOWN External Effect Guard — Asserts that when a pod terminates with unresolved external effects, the status retains `UNKNOWN` and sets `ConditionUnknownEffectPending = True`.
- `TEST_T1_F8_05`: Termination Status Immutability — Asserts that once `WorkerTerminationStatus` is written, subsequent pod events never overwrite it.

#### F9: Go Operator Terminal Deletion Receipt Auditability
- `TEST_T1_F9_01`: Receipt Digest Persisted Prior to Secret Deletion — Asserts `status.ReceiptDigest` is durably written before per-run Secret is deleted.
- `TEST_T1_F9_02`: Receipt Evidence Ref Persisted — Asserts `status.ReceiptEvidenceRef` is recorded before finalizer removal.
- `TEST_T1_F9_03`: Finalizer Sequence Ordering — Verifies `reviewjob.finalizers.review-yeti.ai` blocks resource removal until secret cleanup and status audit sync complete.
- `TEST_T1_F9_04`: Forensic Auditability After Pod TTL Deletion — Asserts PRReviewJob status retains full forensic termination and receipt data after worker Pod is collected.
- `TEST_T1_F9_05`: Idempotent Secret Cleanup — Asserts reconciler safely handles already-deleted run Secrets without blocking finalizer removal.

#### F10: Controlled Execution Environment Enforcement
- `TEST_T1_F10_01`: Default Controlled Namespace Target — Asserts `K8sJobRunner` targets `ct-review-system` by default.
- `TEST_T1_F10_02`: Valid Custom Namespace Acceptance — Asserts `K8sJobRunner` accepts valid non-system namespaces (e.g., `ct-review-staging`).
- `TEST_T1_F10_03`: Generated Manifest Namespace Target — Asserts `manifest.metadata.namespace` is explicitly set to `ct-review-system`.
- `TEST_T1_F10_04`: Operator Namespaced Client Scope — Asserts operator reconciler is scoped exclusively to `ct-review-system`.
- `TEST_T1_F10_05`: Non-Root Security Boundaries — Asserts all generated Job specs enforce non-root execution and drop all capabilities.

#### F11: Comprehensive E2E Testing Suite (Tiers 1-4)
- `TEST_T1_F11_01`: Test Suite Discovery & Execution — Verifies all E2E test files are discovered and executed by Vitest.
- `TEST_T1_F11_02`: Pass/Fail Exit Code Semantics — Asserts test runner returns exit code `0` on success and non-zero on failure.
- `TEST_T1_F11_03`: Tier Classification Reporting — Asserts test report outputs distinct metrics for Tiers 1, 2, 3, and 4.
- `TEST_T1_F11_04`: Opaque-Box Independence — Asserts tests execute without importing or mutating unexported class internals.
- `TEST_T1_F11_05`: Deterministic Execution Invariance — Asserts multiple consecutive runs produce identical results with zero network dependency.

#### F12: Final Integration & Offline Contract Qualification
- `TEST_T1_F12_01`: Upstream Python Schema Parity — Validates that TS wire JSON conforms to `urn:review-yeti:agent-harness:v1` validated by Python validator.
- `TEST_T1_F12_02`: Cross-Language Request Digest Equality — Confirms SHA-256 calculated by TS `requestDigest` matches Python `compute_request_digest`.
- `TEST_T1_F12_03`: Go Operator Reconciliation Tests Pass — Verifies `k8s-operator` controller tests pass cleanly.
- `TEST_T1_F12_04`: TypeScript Unit Test Suite Passes — Verifies `npm test tests/unit/...` passes with zero regressions.
- `TEST_T1_F12_05`: End-to-End Contract Flow Qualification — Validates end-to-end pipeline: WorkRequest -> Job Manifest -> Receipt -> Reconcile.

---

### Tier 2: Boundary & Corner Cases (>=5 per feature = 60 tests)

#### F1: TS Harness Wire Contracts & Zod Schemas
- `TEST_T2_F1_01`: Maximum Payload Size Boundary (65,536 bytes) — Payload of exactly 65,536 bytes passes; payload of 65,537 bytes fails closed with `PAYLOAD_TOO_LARGE`.
- `TEST_T2_F1_02`: Floating Point Rejection in Wire JSON Parser — Rejects numbers with decimal points (`100.5`) or exponents (`1e6`) with `INVALID_JSON`.
- `TEST_T2_F1_03`: Duplicate Key Rejection in Wire JSON Parser — Rejects payloads with duplicate keys (`{"schema":"...", "schema":"..."}`) with `DUPLICATE_JSON_KEY`.
- `TEST_T2_F1_04`: Strict Millisecond Precision Regex Boundary — Rejects timestamps lacking milliseconds (`2026-09-27T18:00:00Z`) or with 4 digits (`.1234Z`) with `INVALID_SHAPE`.
- `TEST_T2_F1_05`: Self-Parenting Execution ID Rejection — Rejects WorkRequests where `parent_execution_id === scope.execution_id` with `SELF_PARENT`.

#### F2: Runner WorkRequest Envelope Generation
- `TEST_T2_F2_01`: Falsy String Coercion Guard — Asserts `tenantId: ""`, `logicalChildId: ""`, or `executionId: ""` fail closed with `INVALID_SHAPE` rather than falling back to defaults.
- `TEST_T2_F2_02`: Fencing Epoch Boundary Value (<= 0) — Asserts `fencingEpoch: 0`, `-1`, `-999` fail closed with `FENCING_MISMATCH`.
- `TEST_T2_F2_03`: PR Number Boundary Value (<= 0) — Asserts `prNumber: 0`, `-5` fail closed with `INVALID_SHAPE`.
- `TEST_T2_F2_04`: Malformed Repository Patterns — Asserts invalid repository URLs (`http://malformed`, `org/repo/extra`, `noslash`) fail closed with `INVALID_SHAPE`.
- `TEST_T2_F2_05`: Maximum Budget Overflow Protection — Asserts oversized budgets or capabilities lists exceeding limits fail closed with `INVALID_SHAPE`.

#### F3: Runner Identity & Fencing Injection
- `TEST_T2_F3_01`: Environment Variable Injection Collision Guard — Confirms custom `spec.envVars` with `CT_*` keys are stripped to prevent overriding authoritative harness identity.
- `TEST_T2_F3_02`: Empty String Image and PVC Claim Guard — Asserts `image: ""` or `pvcClaimName: ""` fail closed with `INVALID_SHAPE`.
- `TEST_T2_F3_03`: Job Name RFC 1123 DNS Subdomain Validation — Asserts uppercase or invalid characters in `jobName` (`ct_agent_job!`) fail closed with `INVALID_SHAPE`.
- `TEST_T2_F3_04`: Kubernetes Label Length Boundary (63 chars) — Asserts labels exceeding 63 characters (e.g. `logical_child_id`) are safely truncated to <= 63 characters.
- `TEST_T2_F3_05`: Volume SubPath Path Traversal Guard — Asserts repo URLs containing `../` or special characters are safely sanitized in volume subPaths.

#### F4: Runner Pod Completion & Receipt Validation
- `TEST_T2_F4_01`: Succeeded Outcome Missing Evidence Rejection — Asserts outcome `succeeded` with `evidence_refs: []` fails closed with `SUCCESS_EVIDENCE_REQUIRED`.
- `TEST_T2_F4_02`: Succeeded Outcome with Unresolved Effects Rejection — Asserts outcome `succeeded` with an effect in state `UNKNOWN` fails closed with `UNRESOLVED_EFFECT`.
- `TEST_T2_F4_03`: Effect SUCCEEDED/FAILED Missing Evidence Ref — Asserts effect in `SUCCEEDED` or `FAILED` with `evidence_ref: null` fails closed with `EFFECT_EVIDENCE_REQUIRED`.
- `TEST_T2_F4_04`: Temporal Paradox Rejection (`started_at > observed_at`) — Asserts receipt where `started_at` is after `observed_at` fails closed with `INVALID_RECEIPT_TIME`.
- `TEST_T2_F4_05`: Budget Limit Exceeded Rejection — Asserts receipt where `metering.cost_microusd > request.budget.max_cost_microusd` fails closed with `BUDGET_EXCEEDED`.

#### F5: Task Observer Lifecycle Hooks & Phase Mapping
- `TEST_T2_F5_01`: Forbidden Phase Transition: UNKNOWN to EXECUTING — Asserts `checkEffectTransition('UNKNOWN', 'EXECUTING')` fails closed with `INVALID_EFFECT_TRANSITION`.
- `TEST_T2_F5_02`: Forbidden Terminal State Transition — Asserts `checkEffectTransition('SUCCEEDED', 'EXECUTING')` fails closed with `INVALID_EFFECT_TRANSITION`.
- `TEST_T2_F5_03`: Checkpoint Proposal Budget Boundary (> 5 Proposals) — Asserts 10 input proposals are strictly capped at 5 and `overflow_count` is set to 5.
- `TEST_T2_F5_04`: Malformed Proposal Shape Rejection — Asserts proposals with negative recurrence, invalid impact, or unknown phase fail closed with `INVALID_SHAPE`.
- `TEST_T2_F5_05`: Non-Boolean Permission Denied Rejection — Asserts non-boolean `permission_denied` (`"true"`, `null`, `1`) fails closed with `INVALID_SHAPE`.

#### F6: Go CRD Identity & Fencing Epoch Fields
- `TEST_T2_F6_01`: Fencing Epoch Boundary Value (<= 0) in CRD — Asserts CRD CEL rule rejects `fencingEpoch: 0` or negative integers.
- `TEST_T2_F6_02`: Fencing Epoch Non-Integer Value in CRD — Asserts CRD schema rejects float or string values for `fencingEpoch`.
- `TEST_T2_F6_03`: Worker Lease Token Empty String in CRD — Asserts CEL minLength rejects `workerLeaseToken: ""`.
- `TEST_T2_F6_04`: Logical Child ID Invalid Pattern in CRD — Asserts regex rejects invalid characters or leading dashes in `logicalChildId`.
- `TEST_T2_F6_05`: Receipt Digest Invalid SHA-256 Pattern in CRD — Asserts CEL pattern rejects non-SHA-256 strings in `status.receiptDigest`.

#### F7: Go Operator Fencing Fail-Closed Reconciliation
- `TEST_T2_F7_01`: Stale Epoch Regression Attempt — Asserts job spec with epoch 1 when mission epoch is 2 fails closed immediately.
- `TEST_T2_F7_02`: Revoked Authoritative Lease Token — Asserts reconciliation fails closed when authoritative lease is revoked or nil while spec holds a token.
- `TEST_T2_F7_03`: Stale Worker Lease with Matching Epoch — Asserts matching epoch does not bypass stale worker lease token rejection.
- `TEST_T2_F7_04`: Mid-Execution Mission Epoch Advancement — Asserts advancing mission epoch while a pod is running prevents the stale pod outcome from committing.
- `TEST_T2_F7_05`: Dynamic Client Malformed Type Injection — Asserts operator reconciler fails closed if dynamic client provides invalid attribute types.

#### F8: Go Operator Safe Pod Termination & UNKNOWN Effect Guard
- `TEST_T2_F8_01`: Preemption Mid-Execution without Receipt — Asserts abrupt SIGKILL preemption retains effects in `UNKNOWN` state without promoting to success.
- `TEST_T2_F8_02`: Termination Message Max Length Truncation (1024 chars) — Asserts termination logs exceeding 1024 characters are safely truncated to the last non-empty line <= 1024 characters.
- `TEST_T2_F8_03`: Credential Redaction in Termination Message — Asserts authorization tokens (`ghp_*`, `Bearer *`, `sk-*`) are redacted before writing to status.
- `TEST_T2_F8_04`: ExitCode Omission for Unscheduled Pods — Asserts eviction before container execution leaves `exitCode` absent and records `podReason: "Evicted"`.
- `TEST_T2_F8_05`: Reconcile Loop Deadlock Guard — Asserts pending `UNKNOWN` effect condition does not spin reconcile loop in a hot busy-wait.

#### F9: Go Operator Terminal Deletion Receipt Auditability
- `TEST_T2_F9_01`: Deletion Attempt with Missing Receipt Digest — Asserts deleting PRReviewJob without receipt digest logs warning and preserves finalizer until terminal state is resolved.
- `TEST_T2_F9_02`: Secret Deletion Transient Error Requeue — Asserts transient error during Secret deletion requeues reconciliation and preserves finalizer.
- `TEST_T2_F9_03`: Deletion Timestamp Set during Active Run — Asserts graceful cancellation sets `cancelRequestedAt` and preserves receipt digest if completed.
- `TEST_T2_F9_04`: Corrupted Receipt Digest Pattern in Status — Asserts malformed receipt digest in status is caught and rejected before secret cleanup.
- `TEST_T2_F9_05`: Cascade Deletion Namespace Boundary Guard — Asserts namespace termination does not cause un-audited external effects to orphan.

#### F10: Controlled Execution Environment Enforcement
- `TEST_T2_F10_01`: Forbidden Namespace Rejection: 'default' — Asserts `new K8sJobRunner({ namespace: 'default' })` fails closed with `INVALID_SHAPE`.
- `TEST_T2_F10_02`: Forbidden Namespace Rejection: 'kube-system' — Asserts `new K8sJobRunner({ namespace: 'kube-system' })` fails closed with `INVALID_SHAPE`.
- `TEST_T2_F10_03`: Forbidden Namespace Prefix Rejection: 'kube-*' — Asserts namespaces starting with `kube-` (e.g. `kube-public`, `kube-node-lease`, `kube-custom`) fail closed with `INVALID_SHAPE`.
- `TEST_T2_F10_04`: Empty String Namespace Rejection — Asserts `namespace: ""` fails closed with `INVALID_SHAPE` without fallback to default.
- `TEST_T2_F10_05`: RFC 1123 Namespace Pattern Validation — Asserts uppercase or invalid characters in `namespace` (`ct_review!`) fail closed with `INVALID_SHAPE`.

#### F11: Comprehensive E2E Testing Suite (Tiers 1-4)
- `TEST_T2_F11_01`: Individual Test Timeout Isolation — Asserts individual test timeout does not terminate test runner process prematurely.
- `TEST_T2_F11_02`: Unhandled Promise Rejection Trap — Asserts unhandled rejections within test cases are trapped and attributed to the offending test.
- `TEST_T2_F11_03`: Concurrency State Isolation — Asserts parallel test workers do not mutate shared global configuration or state.
- `TEST_T2_F11_04`: Mock Cleanup Guarantee — Asserts mock calls and timers are cleanly reset between test runs.
- `TEST_T2_F11_05`: Process Environment Restoration — Asserts modified `process.env` keys are restored to baseline values in `afterEach`.

#### F12: Final Integration & Offline Contract Qualification
- `TEST_T2_F12_01`: Cross-Language Unicode Normalization — Asserts unicode characters (e.g. emojis, accents) produce identical byte lengths and digests in TS and Python.
- `TEST_T2_F12_02`: Safe Integer Boundary Invariance — Asserts max safe integer `9007199254740991` is preserved identically across TS, Go, and Python.
- `TEST_T2_F12_03`: Negative Zero `-0` Serialization Parity — Asserts `-0` is serialized to `"0"` identically across TS and Python per RFC 8785.
- `TEST_T2_F12_04`: Compact Unformatted JSON Invariance — Asserts zero extraneous whitespace or newlines in serialized wire contracts.
- `TEST_T2_F12_05`: Unsupported Schema Kind Rejection — Asserts unrecognized schema identifier (e.g., `ct-agent-work-request.v2`) fails closed across all validators.

---

### Tier 3: Cross-Feature Combinations (Pairwise Interactions — >=8 tests)

- `TEST_T3_PAIR_01`: WorkRequest Generation + Receipt Binding Verification (F2 + F4)
  - Interacts `K8sJobRunner.buildWorkRequest` with `checkReceiptBinding`. Generates a valid WorkRequest envelope, simulates an execution receipt with matching scope and `request_digest`, and asserts `checkReceiptBinding` passes with an authoritative `AdmissionSnapshot`.
- `TEST_T3_PAIR_02`: Fencing Epoch Injection + Operator Fail-Closed Reconciliation (F3 + F7)
  - Interacts `K8sJobRunner.generateJobManifest` injecting `CT_FENCING_EPOCH: 2` with operator reconciliation where active mission epoch is advanced to 3. Asserts operator reconciliation fails closed, sets `ConditionFencingEpochMismatch`, and blocks pod dispatch.
- `TEST_T3_PAIR_03`: Task Observer Phase Transitions + Receipt Effects Qualification (F4 + F5)
  - Interacts task observer state progression (`INTENT` -> `EXECUTING` -> `SUCCEEDED`) with execution receipt validation. Asserts that all effects projected by `projectEffectState` match owner effect intents and that `validateExecutionReceipt` succeeds.
- `TEST_T3_PAIR_04`: WorkRequest Envelope Generation + Controlled Boundary Namespace Enforcement (F2 + F10)
  - Interacts envelope generation and namespace validation. Confirms valid `ct-review-system` generates conforming WorkRequest and Job manifest, while attempting to target `kube-system` halts before envelope construction.
- `TEST_T3_PAIR_05`: Task Observer Permission Denial + Receipt Outcome Canceled/Quarantined (F4 + F5)
  - Interacts task observer hard stop signal (`permission_denied: true`) with receipt outcome processing. Asserts runner produces receipt with outcome `cancelled` and diagnostic code `AUTHORITY_DENIED`, verifying effects remain non-promoted.
- `TEST_T3_PAIR_06`: Worker Preemption + UNKNOWN Effect Preservation + Terminal Receipt Auditability (F8 + F9)
  - Interacts pod preemption, effect safety, and terminal auditability. Asserts that when a worker pod is killed with pending external effects, `WorkerTerminationStatus` captures exit, effects remain `UNKNOWN`, and `status.ReceiptDigest` is preserved before run Secret deletion.
- `TEST_T3_PAIR_07`: Tripartite Fencing Separation across Runner and CRD Spec (F1 + F6 + F7)
  - Interacts Mission Fencing Epoch (`scope.fencing_epoch: 5`), Child Attempt (`attempt: 2`), and Worker Lease Token (`fencing_token: 101`). Asserts updating lease token does not invalidate fencing epoch, but stale lease token halts reconciliation.
- `TEST_T3_PAIR_08`: Cross-Language Digest Parity + InitContainer Staged WorkRequest (F1 + F3 + F12)
  - Interacts initContainer staging command with Python contract validator. Asserts staged `CT_WORK_REQUEST_PAYLOAD` parses cleanly in Python `agent_harness_contract.py` and produces identical SHA-256 digest matching `CT_REQUEST_DIGEST`.

---

### Tier 4: Real-World Scenarios (End-to-End Workflows — >=5 tests)

- `TEST_T4_SCENARIO_01`: Standard Clean PR Review Workflow with Conforming Receipt
  - Full-lifecycle PR review on `review-yeti-ai/review-yeti-bot` (PR #402). `K8sJobRunner` constructs compliant WorkRequest envelope; generates batch/v1 Job manifest with initContainer staging; simulates worker execution producing evidence artifact; verifies conforming `ct-agent-execution-receipt.v1` with outcome `succeeded`; operator reconciles completion and archives audit receipt.
- `TEST_T4_SCENARIO_02`: Spot Node Preemption with UNKNOWN External Effect Preservation
  - Simulates worker pod preemption on a DOKS spot node during a multi-file review while an external review comment effect is in flight (`EXECUTING`). Operator `worker_termination.go` captures `WorkerTerminationStatus` (`exitCode: 137`, `reason: "OOMKilled"`/`Evicted`); external effect is preserved as `UNKNOWN`; condition `UnknownEffectPending = True` is recorded; zero effects promoted to success.
- `TEST_T4_SCENARIO_03`: Stale Worker Lease & Fencing Epoch Mismatch Fence Closure
  - Simulates a race condition where a network partition causes delayed job submission after mission fencing epoch bumped from 1 to 2. TypeScript runner submits job with epoch 1; operator reconciler compares against authoritative mission epoch 2; triggers fail-closed reconciliation, sets `ConditionFencingEpochMismatch = True`, and aborts pod scheduling.
- `TEST_T4_SCENARIO_04`: Task Observer Classifier Permission Denial Hard Halt
  - Simulates an agent attempting to inspect an unauthorized path or policy-restricted tool. Task observer hook triggers `permission_denied: true`; runner treats denial as a hard stop signal; halts execution immediately; emits execution receipt with `outcome: "cancelled"` and diagnostic `AUTHORITY_DENIED`; zero raw transcripts or diff memories retained.
- `TEST_T4_SCENARIO_05`: Large Payload Truncation, Budget Capping & Checkpoint Proposal Trimming
  - Simulates a large PR (150+ files) generating 12 candidate review findings. Task observer proposal budget trims proposals to exactly 5 sorted by impact and recurrence; sets `overflow_count: 7`; canonical JSON serializer asserts payload byte length <= 65,536 bytes; WorkRequest and Receipt pass validation cleanly without memory bloat.
- `TEST_T4_SCENARIO_06`: Boundary Namespace Injection Tampering Attempt & Audit Preservation
  - Simulates an adversarial attempt to submit a PR review job targeting `kube-system` or `default`. `K8sJobRunner` intercepts and fails closed with `INVALID_SHAPE`; audit alert logged; operator verifies zero resources created outside `ct-review-system`.

---

## Total Minimum Tests Target: 134 Tests

| Tier | Category | Minimum Test Count | Status |
|------|----------|:------------------:|:------:|
| Tier 1 | Core Feature Coverage (12 Features x 5 Tests) | 60 | Defined |
| Tier 2 | Boundary & Corner Cases (12 Features x 5 Tests) | 60 | Defined |
| Tier 3 | Cross-Feature Pairwise Combinations | 8 | Defined |
| Tier 4 | Real-World Application Scenarios | 6 | Defined |
| **Total** | | **134** | **Complete** |

---

## Verification & Execution Guide

### 1. Run Vitest E2E Suite
```bash
npx vitest run tests/e2e/agentHarnessE2E.test.ts
```

### 2. Run Standalone Node E2E Runner
```bash
node tests/e2e/run-agent-harness-e2e.mjs
```

### 3. Verify Upstream Python Contract Qualification
```bash
python3 /Users/jasonbarbee/ct-worktrees/ct-meta-main/test/agent_harness_contract_test.py
```

### 4. Verify Go Operator Controller Tests
```bash
cd k8s-operator && go test -count=1 ./controllers/...
```

### 5. Verify TypeScript Unit Suite
```bash
npm test tests/unit/agentHarnessContracts.test.ts tests/unit/k8sJobRunner.contract.test.ts
```
