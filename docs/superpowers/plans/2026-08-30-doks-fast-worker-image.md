# DOKS Fast Worker Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Review Yeti Job dispatch start in seconds by measuring every startup stage, shipping a small worker-only image, pre-pulling its immutable digest, and overlapping safe workspace preparation.

**Architecture:** A dedicated worker image contains only the Node 24 review entrypoint, traced runtime dependencies, and required Git tools. The release pipeline builds and validates it once, pushes it to the same-region DigitalOcean registry, and rolls a secret-free pre-pull DaemonSet to every eligible node. Dispatch records cold/warm stage timestamps and prepares PVC/token work concurrently without creating unschedulable review Pods.

**Tech Stack:** Node.js 24+, TypeScript 5, Docker BuildKit/buildx, DigitalOcean Container Registry, Kubernetes Jobs/DaemonSets/PVCs, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-doks-review-dispatch-design.md`

## Global Constraints

- Prerequisite: complete Tasks 8 and 9 of `2026-08-30-doks-review-dispatch.md`; the worker must use exact-head workspace checkout and receipt handoff before image optimization.
- Never build, install packages, or resolve a moving image tag during review dispatch.
- Worker image is digest-pinned, non-root, read-only, and contains no App private key, `gh` CLI, frontend/dashboard, tests, compiler, or npm cache.
- Compressed image is at most 300 MiB and at least 50% smaller than the released service image.
- Warm image process start is p95 at most 2 seconds after kubelet reports the image ready.
- Webhook-to-process p95 is at most 5s warm/reused, 20s warm/new-PVC, and 60s on a qualification cold node.
- Webhook-to-first-provider-request p95 is at most 10s, 30s, and 90s for the same tiers.
- Image pre-pulling performs no GitHub/provider request and is not a scheduled canary.
- Performance misses never extend the original 15-minute terminal deadline.

---

### Task 1: Instrument and benchmark the dispatch critical path

**Files:**

- Create: `src/telemetry/reviewDispatchTiming.ts`
- Modify: `src/telemetry/metrics.ts`
- Create: `scripts/benchmark-worker-dispatch.mjs`
- Create: `tests/unit/reviewDispatchTiming.test.ts`

**Interfaces:**

- Consumes: persisted ingress timestamps, custom-resource/Job/Pod Kubernetes timestamps, workspace events, and first provider request timestamp.
- Produces:

```ts
export type DispatchTier = 'warm_reused' | 'warm_new_workspace' | 'cold_node';

export interface ReviewDispatchTimingV1 {
  version: 'ReviewDispatchTiming.v1';
  runId: string;
  tier: DispatchTier;
  webhookReceivedAt: number;
  admissionCommittedAt: number;
  projectionCreatedAt: number;
  workspaceReadyAt: number;
  jobCreatedAt: number;
  podScheduledAt: number;
  imageReadyAt: number;
  processStartedAt: number;
  checkoutReadyAt: number;
  firstProviderRequestAt: number;
}

export interface DispatchBenchmarkSummary {
  tier: DispatchTier;
  sampleCount: number;
  processStartP50Ms: number;
  processStartP95Ms: number;
  firstProviderRequestP50Ms: number;
  firstProviderRequestP95Ms: number;
  passed: boolean;
}
```

- [ ] **Step 1: Write failing timing-validation tests**

Test monotonic timestamps, missing stages, a timestamp beyond the 15-minute deadline, tier classification, nearest-rank p50/p95 for at least 20 samples, and exact tier gates. No raw repository, PR, SHA, token, prompt, or exception text may become a metric label.

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/unit/reviewDispatchTiming.test.ts`

Expected: FAIL because the timing contract does not exist.

- [ ] **Step 3: Implement stage validation and summaries**

Export `validateDispatchTiming(record)`, `summarizeDispatchTier(records, tier)`, and `assertDispatchGates(summaries)`. Use the original webhook timestamp for every total; never reset the clock at Job creation.

- [ ] **Step 4: Implement a read-only benchmark CLI**

The CLI accepts newline-delimited `ReviewDispatchTiming.v1` records, emits JSON summaries, and exits nonzero on insufficient samples or a failed gate. Require at least 20 samples per tier for a p95 claim. Redact authenticated URLs and reject unknown fields that resemble secrets.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/unit/reviewDispatchTiming.test.ts && npm run lint`

Expected: PASS.

```bash
git add src/telemetry/reviewDispatchTiming.ts src/telemetry/metrics.ts scripts/benchmark-worker-dispatch.mjs tests/unit/reviewDispatchTiming.test.ts
git commit -m "feat(perf): measure review dispatch startup stages"
```

---

### Task 2: Build a worker-only immutable runtime image

**Files:**

- Create: `Dockerfile.worker`
- Modify: `.dockerignore`
- Create: `.github/worker-image.env`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `scripts/stage-worker-runtime.mjs`
- Modify: `src/cli/runLiveReview.ts`
- Create: `tests/unit/workerContainerContract.test.ts`
- Modify: `.github/workflows/ci-cd.yaml`

**Interfaces:**

- Consumes: compiled `dist/cli/runLiveReview.js`, root lockfile, immutable Node 24 base-image digest, worker self-test fixtures.
- Produces: an OCI reference in `registry.digitalocean.com/review-yeti/review-yeti-worker` whose digest matches `^sha256:[a-f0-9]{64}$`, plus an SBOM, provenance attestation, compressed-size receipt, and self-test receipt.

- [ ] **Step 1: Write failing runtime-closure and Dockerfile tests**

Require:

```ts
expect(inspected.config.Entrypoint).toEqual(['node', '/app/dist/cli/runLiveReview.js']);
expect(inspected.config.User).toBe('node');
expect(await commandsPresent(image, ['node', 'git', 'rg'])).toEqual([true, true, true]);
expect(await commandsPresent(image, ['gh', 'npm', 'tsc', 'next'])).toEqual([false, false, false, false]);
expect(await pathsPresent(image, ['/app/tests', '/app/.git', '/app/public'])).toEqual([false, false, false]);
```

Define `commandsPresent()` by running `command -v` in the built image and `pathsPresent()` by running `test -e`; both helpers use `execFile` argument arrays, never a shell-built image name.

Parse Dockerfile stages and reject unpinned final bases, `npm install` in the final stage, `curl | sh`, `latest`, embedded ENV secrets, a service healthcheck, or the service `dist/index.js` entrypoint.

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/unit/workerContainerContract.test.ts`

Expected: FAIL because `Dockerfile.worker` and the worker staging script do not exist.

- [ ] **Step 3: Trace and stage the worker dependency closure**

Add `@vercel/nft` version `1.11.0` as an exact dev dependency. `stage-worker-runtime.mjs` traces `dist/cli/runLiveReview.js`, copies only traced application files/packages, and explicitly includes these dynamically loaded packages before emitting `runtime-manifest.json` with a SHA-256 for every file:

```js
const requiredDynamicPackages = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
  '@quintinshaw/pi-dynamic-workflows',
  'typebox',
];
```

Fail if a traced path escapes the repository, contains a test/coverage/git directory, or if the self-test imports a module absent from the manifest.

- [ ] **Step 4: Add a worker self-test mode**

`node dist/cli/runLiveReview.js --self-test` imports the admitted provider adapters, receipt serializer, exact-head workspace manager, panel/arbiter code, and Git subprocess wrapper without making a network call. It returns JSON with `ok`, Node version, runtime manifest digest, and loaded module IDs.

- [ ] **Step 5: Create the multi-stage image**

Use a build argument that is mandatory and already contains an immutable Node 24 Bookworm slim digest:

```dockerfile
# syntax=docker/dockerfile:1.7
ARG NODE_BASE_IMAGE
FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build:backend \
 && node scripts/stage-worker-runtime.mjs /out

FROM ${NODE_BASE_IMAGE} AS worker
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out/ /app/
USER node
ENV NODE_ENV=production
ENTRYPOINT ["node", "/app/dist/cli/runLiveReview.js"]
```

The workflow resolves/reviews the base digest in a dependency-update PR, records the immutable reference as `NODE_BASE_IMAGE=` in `.github/worker-image.env`, passes it explicitly, builds only the DOKS node architecture plus provenance/SBOM, runs the self-test, scans the image, pushes once, and records the resulting worker digest. Tests require the value to match `^node:24-bookworm-slim@sha256:[a-f0-9]{64}$`. Review dispatch accepts only the resulting worker digest.

- [ ] **Step 6: Enforce size and completeness**

Compute compressed size by summing manifest layer sizes from `docker buildx imagetools inspect --raw`. Compare with the current released service image using the same method. Fail unless worker size is `<= 314572800` bytes and `workerBytes * 2 <= serviceBytes`.

- [ ] **Step 7: Build, test, and commit**

Run locally with the reviewed immutable base reference:

```bash
review_worker_base_image="$(sed -n 's/^NODE_BASE_IMAGE=//p' .github/worker-image.env)"
test -n "$review_worker_base_image"
docker buildx build --load --build-arg NODE_BASE_IMAGE="$review_worker_base_image" -f Dockerfile.worker -t review-yeti-worker:test .
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m review-yeti-worker:test --self-test
npm test -- tests/unit/workerContainerContract.test.ts
```

Expected: self-test JSON has `ok: true`; container tests and both size gates pass.

```bash
git add Dockerfile.worker .dockerignore .github/worker-image.env package.json package-lock.json scripts/stage-worker-runtime.mjs src/cli/runLiveReview.ts tests/unit/workerContainerContract.test.ts .github/workflows/ci-cd.yaml
git commit -m "feat(worker): build small immutable review runtime image"
```

---

### Task 3: Pre-pull the digest and overlap workspace preparation

**Files:**

- Create: `k8s/worker-image-cache-daemonset.yaml.tpl`
- Modify: `k8s/operator-deployment.yaml.tpl`
- Modify: `k8s/review-network-policies.yaml`
- Modify: `k8s-operator/controllers/prreviewjob_controller.go`
- Modify: `k8s-operator/controllers/prreviewjob_controller_test.go`
- Create: `tests/unit/workerImageCacheManifest.test.ts`
- Modify: `.github/workflows/ci-cd.yaml`

**Interfaces:**

- Consumes: immutable worker digest, eligible review-node selector, accepted `PRReviewJob`, and four-slot capacity state.
- Produces: all eligible nodes image-ready before activation; PVC/token preparation overlaps; only a capacity-granted run creates a review Pod.

- [ ] **Step 1: Write failing manifest and reconciliation tests**

Require the DaemonSet to use the exact Job digest, `IfNotPresent`, no Secret/envFrom/service-account token/host mount/privilege, requests at most `5m CPU/16Mi`, limits at most `25m/64Mi`, and a shell-only idle command. Assert it cannot reach GitHub/provider endpoints under NetworkPolicy.

Operator tests must prove PVC create/bind and run-Secret preparation may proceed concurrently while queued, but Job creation waits for one of four slots. At most eight runs—the four active and next four FIFO—may hold prepared PVCs. A superseded/expired queued run deletes its one-time Secret, releases its Lease, and lets the 30-minute PVC idle clock proceed.

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/unit/workerImageCacheManifest.test.ts && (cd k8s-operator && go test ./controllers)`

Expected: FAIL because the image cache manifest and overlapped preparation do not exist.

- [ ] **Step 3: Implement the secret-free pre-pull DaemonSet**

Template only `${CT_REVIEW_WORKER_IMAGE}` and the reviewed node selector. Use the worker image with:

```yaml
command: ["/bin/sh", "-c"]
args: ["trap 'exit 0' TERM INT; while :; do sleep 3600; done"]
```

Set `automountServiceAccountToken: false`, read-only root filesystem, non-root, drop all capabilities, runtime-default seccomp, and no volumes. Label it separately from review workers so worker egress NetworkPolicy does not apply provider access to it.

- [ ] **Step 4: Gate releases on digest readiness**

After pushing a digest, update the DaemonSet and wait for `numberReady == desiredNumberScheduled` and `numberUnavailable == 0`. Inspect every eligible node's DaemonSet Pod `imageID` and require the expected digest before updating the operator's admitted worker digest. A failed rollout leaves the previous worker digest active.

- [ ] **Step 5: Overlap safe preparation**

On accepted custom resource, the dispatcher concurrently mints/creates the deterministic one-time Secret while the operator ensures/reuses the PR-scoped PVC for runs inside the eight-run preparation window. Do not acquire an execution slot or create the Job until both are ready. This overlap cannot renew the PVC idle clock for another PR, prepare more than eight PVCs, or exceed four active Jobs.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- tests/unit/workerImageCacheManifest.test.ts && (cd k8s-operator && go test -race ./controllers)`

Expected: PASS.

```bash
git add k8s/worker-image-cache-daemonset.yaml.tpl k8s/operator-deployment.yaml.tpl k8s/review-network-policies.yaml k8s-operator/controllers/prreviewjob_controller.go k8s-operator/controllers/prreviewjob_controller_test.go tests/unit/workerImageCacheManifest.test.ts .github/workflows/ci-cd.yaml
git commit -m "feat(k8s): pre-pull workers and overlap workspace readiness"
```

---

### Task 4: Prove warm, new-PVC, and cold-node dispatch latency

**Files:**

- Create: `scripts/qualify-worker-dispatch-latency.mjs`
- Create: `tests/integration/workerDispatchLatency.test.ts`
- Modify: `docs/DOKS_REVIEW_OPERATIONS.md`
- Modify: `docs/superpowers/evidence/doks-review-dispatch-evidence-template.md`

**Interfaces:**

- Consumes: non-publishing qualification run IDs, timing records, Pod events, image digest/size receipts, PVC reuse identity.
- Produces: one signed evidence bundle with per-tier samples and pass/fail gates.

- [ ] **Step 1: Write failing qualification-report tests**

Require at least 20 samples per tier, exact worker/service digests and sizes, stage percentiles, zero 15-minute misses, zero provider calls from pre-pull Pods, and no omitted/negative/nonmonotonic timestamp. Fail the entire report if any tier fails.

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/integration/workerDispatchLatency.test.ts`

Expected: FAIL because the qualification report does not exist.

- [ ] **Step 3: Run isolated manual samples**

In the disposable qualification namespace:

- warm/reused: 20 non-publishing runs reusing one same-PR PVC with the image already present;
- warm/new-workspace: 20 distinct PR workspace claims on warm eligible nodes;
- cold-node: 20 runs across explicitly approved disposable qualification nodes that start without the worker digest.

Do not evict images or alter production nodes to manufacture cold samples. Do not create a recurring workflow or scheduled canary. Provider response content may use the existing deterministic qualification transport; the timestamp is first request emission, so model generation latency does not contaminate dispatch startup.

- [ ] **Step 4: Apply exact gates**

Run:

```bash
node scripts/qualify-worker-dispatch-latency.mjs evidence/dispatch-timings.ndjson
```

Expected:

- warm/reused process p95 `<=5000ms`, first-provider-request p95 `<=10000ms`;
- warm/new-workspace process p95 `<=20000ms`, first-provider-request p95 `<=30000ms`;
- cold-node process p95 `<=60000ms`, first-provider-request p95 `<=90000ms`;
- warm image-ready-to-process p95 `<=2000ms`;
- compressed image `<=314572800` bytes and at least 50% smaller than service image.

- [ ] **Step 5: Document bottlenecks, verify, and commit**

Record p50/p95 for every timing span, not only totals. If a gate fails, identify the dominant stage and keep DOKS activation disabled; do not raise the limit to make the test pass.

Run: `npm test -- tests/unit/reviewDispatchTiming.test.ts tests/unit/workerContainerContract.test.ts tests/unit/workerImageCacheManifest.test.ts tests/integration/workerDispatchLatency.test.ts`

Expected: PASS only with a complete evidence bundle.

```bash
git add scripts/qualify-worker-dispatch-latency.mjs tests/integration/workerDispatchLatency.test.ts docs/DOKS_REVIEW_OPERATIONS.md docs/superpowers/evidence/doks-review-dispatch-evidence-template.md
git commit -m "test(perf): qualify fast DOKS worker dispatch"
```

## Acceptance checklist

- [ ] Worker image is immutable, worker-only, complete, and passes the offline self-test.
- [ ] Compressed image is at most 300 MiB and at least 50% smaller than service image.
- [ ] Pre-pull DaemonSet is secret-free, network-isolated, and ready on every eligible node.
- [ ] Reviews never build an image or install packages at dispatch time.
- [ ] PVC/token preparation overlaps without creating more than four active Jobs.
- [ ] Warm/reused process-start p95 is at most 5 seconds.
- [ ] Warm/new-PVC process-start p95 is at most 20 seconds.
- [ ] Qualification cold-node process-start p95 is at most 60 seconds.
- [ ] All first-provider-request and 15-minute terminal gates pass without limit changes.
