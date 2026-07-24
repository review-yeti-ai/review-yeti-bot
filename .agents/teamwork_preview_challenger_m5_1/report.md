# Milestone 5 Adversarial Stress Test & Challenge Report

**Date**: 2026-07-24  
**Target Project**: `ct-review-bot` (Milestone 5 - Docker Containerization & DOKS Deployment)  
**Agent**: Challenger 1 (EMPIRICAL CHALLENGER)  
**Working Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_challenger_m5_1`

---

## Challenge Summary

**Overall Risk Assessment**: **MEDIUM-HIGH**

While the core TypeScript codebase compiles cleanly (`npm run build`), all 355 unit/integration tests and 113 E2E stress tests pass with 0 failures, and `kubectl apply --dry-run=client -f k8s/` validates without schema syntax errors, our empirical adversarial stress-testing identified several critical security, permissions, data persistence, and script error-handling flaws in the Milestone 5 containerization and Kubernetes infrastructure:

1. **Volume Write Permission Failure (EACCES)**: `k8s/deployment.yaml` sets `runAsUser: 10001` in container `securityContext`, but the container image chowns files to `node:node` (UID 1000) and `spec.template.spec` lacks pod-level `fsGroup: 10001`. On standard Kubernetes clusters (including DOKS), `emptyDir` volumes mounted at `/app/data` default to root-owned (0755), preventing UID 10001 from initializing or writing SQLite database files (`/app/data/pr_states.sqlite`).
2. **Ephemeral Storage & Split-Brain State Anti-Pattern**: `k8s/deployment.yaml` specifies `replicas: 2` with `emptyDir: {}` volume for SQLite storage (`/app/data`). In multi-replica deployments, each pod instance retains a separate, isolated ephemeral SQLite database. Webhooks distributed across replicas will experience desynchronized diff state calculations, duplicate or missing LLM review passes, and total state loss whenever pods restart or reschedule.
3. **Unbound Variable Crash in `scripts/verify-doks.sh`**: Running `./scripts/verify-doks.sh --url` without providing a target URL parameter causes bash to crash with `line 19: $2: unbound variable` due to `set -u` enforcement, bypassing human-readable error validation.
4. **Missing Live SecurityContext Assertions in `scripts/verify-doks.sh`**: In dry-run/mock mode, `verify-doks.sh` reports verification of `runAsNonRoot=true`, `runAsUser=10001`, `allowPrivilegeEscalation=false`, and `drop=ALL`. However, in live cluster execution, the script fetches `POD_SECURITY` via `kubectl` and echoes the raw JSON string without programmatically asserting those security values, allowing misconfigured pods to silently pass verification.
5. **Hardcoded Port in Dockerfile Healthcheck**: `Dockerfile` specifies `HEALTHCHECK --cmd node -e "fetch('http://localhost:3000/health')..."` hardcoding port `3000`. Overriding `PORT` in container environment or Kubernetes ConfigMap causes Docker-level health checks to fail.

---

## Detailed Challenges & Failure Modes

### [HIGH] Challenge 1: Volume Mount Ownership & SQLite EACCES Permission Denied

- **Assumption Challenged**: Mounting an `emptyDir` volume at `/app/data` will allow container process running under `runAsUser: 10001` to read and write the SQLite database file `/app/data/pr_states.sqlite`.
- **Attack / Failure Scenario**: 
  1. `Dockerfile` uses `USER node` (UID 1000) and `COPY --chown=node:node`.
  2. `k8s/deployment.yaml` executes container as UID `10001` (`runAsUser: 10001`).
  3. `data-volume` (`emptyDir: {}`) is mounted at `/app/data`.
  4. Pod `securityContext` lacks `fsGroup: 10001`.
  5. Kubernetes Kubelet creates `/app/data` with `root:root` ownership and `0755` permissions.
  6. Application attempts to open `/app/data/pr_states.sqlite` or write journal/WAL files, throwing `EACCES: permission denied` and crashing the pod.
- **Blast Radius**: Application pod crash loop on boot when SQLite persistence is initialized.
- **Mitigation**:
  1. Add pod-level securityContext in `k8s/deployment.yaml`:
     ```yaml
     spec:
       securityContext:
         fsGroup: 10001
         runAsUser: 10001
         runAsGroup: 10001
     ```
  2. In `Dockerfile`, pre-create `/app/data` directory and chown to `10001:10001`:
     ```dockerfile
     RUN mkdir -p /app/data && chown -R 10001:10001 /app/data
     ```

---

### [HIGH] Challenge 2: Ephemeral SQLite Storage & Multi-Replica Split-Brain Desynchronization

- **Assumption Challenged**: Storing PR diff state in `/app/data/pr_states.sqlite` using `emptyDir: {}` volume across `replicas: 2` supports scalable stateful review processing.
- **Attack / Failure Scenario**:
  1. Pod Replica 1 processes webhook for PR #101 commit `sha1`. Replica 1 records diff state in its local ephemeral SQLite database.
  2. Subsequent webhook for PR #101 commit `sha2` is load-balanced to Pod Replica 2.
  3. Replica 2's SQLite DB has no record of `sha1`. Replica 2 treats `sha2` as the initial commit, recalculating all hunks from scratch and firing duplicate LLM requests.
  4. Node failure or pod rescheduling destroys the `emptyDir` volume, wiping all PR state history.
- **Blast Radius**: Inconsistent review decisions, redundant LLM API calls/costs, lost diff tracking.
- **Mitigation**:
  1. For single-node SQLite state persistence in Kubernetes, use a `PersistentVolumeClaim` with `ReadWriteOnce` access mode and set `replicas: 1`.
  2. For multi-replica horizontal scaling, replace SQLite file storage with a centralized persistent store (e.g., PostgreSQL or Redis) shared across all replicas.

---

### [MEDIUM] Challenge 3: `verify-doks.sh --url` Unbound Variable Crash

- **Assumption Challenged**: `scripts/verify-doks.sh` safely parses command line flags under strict bash flags (`set -euo pipefail`).
- **Attack / Failure Scenario**:
  1. Operator runs `./scripts/verify-doks.sh --url`.
  2. Script executes `TARGET_URL="$2"` on line 19 without verifying whether `$2` is bound.
  3. Bash halts execution immediately with `./scripts/verify-doks.sh: line 19: $2: unbound variable`.
- **Blast Radius**: Unhandled script crash without diagnostic feedback to deployment operators.
- **Mitigation**: Update argument parsing in `scripts/verify-doks.sh` to match `scripts/deploy-doks.sh`:
  ```bash
  --url)
    if [[ -z "${2:-}" ]]; then
      echo "Error: --url requires a non-empty argument." >&2
      exit 1
    fi
    TARGET_URL="$2"
    shift 2
    ;;
  ```

---

### [MEDIUM] Challenge 4: Missing Container SecurityContext Assertions in Live `verify-doks.sh`

- **Assumption Challenged**: `scripts/verify-doks.sh` validates container `securityContext` settings in live cluster deployments.
- **Attack / Failure Scenario**:
  1. A misconfigured `k8s/deployment.yaml` (e.g. `runAsNonRoot: false`, `runAsUser: 0`) is applied to cluster.
  2. Operator runs `scripts/verify-doks.sh`.
  3. Script executes `kubectl get deployment ct-review-bot -o jsonpath='{.spec.template.spec.containers[0].securityContext}'` and echoes string to stdout.
  4. Script does NOT check for expected values (`runAsNonRoot=true`, `runAsUser=10001`), and returns exit code 0 ("All verification checks passed successfully").
- **Blast Radius**: Misconfigured security policies bypass deployment verification checks undetected.
- **Mitigation**: Add explicit assertions on `$POD_SECURITY` in `verify-doks.sh`:
  ```bash
  if ! echo "$POD_SECURITY" | grep -q '"runAsNonRoot":true'; then
    echo "Error: Pod securityContext does not enforce runAsNonRoot=true" >&2
    exit 1
  fi
  if ! echo "$POD_SECURITY" | grep -q '"runAsUser":10001'; then
    echo "Error: Pod securityContext does not set runAsUser=10001" >&2
    exit 1
  fi
  ```

---

### [LOW] Challenge 5: Dockerfile Hardcoded Port & Missing Environment Variable Fallback

- **Assumption Challenged**: `Dockerfile` HEALTHCHECK remains valid when container environment variables change.
- **Attack / Failure Scenario**:
  1. Container environment configures `PORT=8080`.
  2. Application listens on `http://0.0.0.0:8080`.
  3. Docker healthcheck executes `fetch('http://localhost:3000/health')`, receiving connection refused.
  4. Docker marks container as `unhealthy`.
- **Blast Radius**: False positive container healthcheck failures in non-K8s docker environments.
- **Mitigation**: Parameterize HEALTHCHECK script in `Dockerfile`:
  ```dockerfile
  HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const p = process.env.PORT || 3000; fetch('http://localhost:' + p + '/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
  ```

---

## Empirical Stress Test Results

| Test Scenario | Executed Command | Expected Behavior | Actual Behavior | Result |
|---|---|---|---|---|
| **TypeScript Build Verification** | `npm run build` | 0 TS errors, emits `dist/` | Clean build, exit 0 | **PASS** |
| **Unit & Integration Test Suite** | `npm test` | All 355 unit tests pass | 32 files passed, 355 tests passed (4.94s) | **PASS** |
| **End-to-End Stress Test Suite** | `npm run test:e2e` | All 113 E2E tests pass under stress | 18 files passed, 113 tests passed (3.60s) | **PASS** |
| **Kubernetes Manifest Dry-Run** | `kubectl apply --dry-run=client -f k8s/` | All 5 manifests pass client schema validation | ConfigMap, Deployment, Ingress, Secret, Service created (dry run) | **PASS** |
| **Deploy Script Dry-Run** | `./scripts/deploy-doks.sh --dry-run` | Validates manifests cleanly | Output confirmed dry-run success | **PASS** |
| **Deploy Script Invalid Flag** | `./scripts/deploy-doks.sh --invalid-flag` | Exit 1 with error message | `Error: Unknown argument '--invalid-flag'`, exit 1 | **PASS** |
| **Deploy Script Missing Cluster Name** | `./scripts/deploy-doks.sh --cluster-name` | Exit 1 with validation error | `Error: --cluster-name requires a non-empty argument.`, exit 1 | **PASS** |
| **Verify Script Dry-Run** | `./scripts/verify-doks.sh --dry-run` | Output simulated rollout & status | Output confirmed dry-run success | **PASS** |
| **Verify Script Mock Mode** | `./scripts/verify-doks.sh --mock` | Output simulated endpoints & security | Output confirmed mock mode success | **PASS** |
| **Verify Script Missing URL Argument** | `./scripts/verify-doks.sh --url` | Friendly argument validation error | Crashes with `line 19: $2: unbound variable` | **FAIL** |
| **Live SecurityContext Verification Assertions** | Inspect `verify-doks.sh` lines 51-53 | Assert `runAsUser=10001` and `runAsNonRoot=true` | Echoes raw JSON, no assertions or error on invalid securityContext | **FAIL** |
| **Multi-Stage Docker Image Build** | `docker build -t ct-review-bot:test .` | Image compiles & exports cleanly | Built image `ct-review-bot:test` successfully | **PASS** |
| **Volume Permission under UID 10001** | `docker run --rm -u 10001:10001 ct-review-bot:test ...` | Write access to mounted volume | Fails if `fsGroup: 10001` omitted on `/app/data` | **FAIL (Risk)** |

---

## Unchallenged Areas

- **DigitalOcean DOKS Cloud Provisioning**: Physical `doctl kubernetes cluster create` cluster provisioning was not executed live against a cloud billing account (tested via dry-run and local Docker/kubectl toolchains).
- **Ingress Controller NGINX Controller Pod Installation**: NGINX Ingress controller presence in remote cluster assumed based on ingress class `nginx`.
