# 🛠️ Review Yeti Production Troubleshooting Guide

This production guide provides comprehensive diagnostic procedures, root cause analyses, and remediation playbooks for common operational failure modes in **Review Yeti**.

---

## 📑 Table of Contents

1. [Quick Triage Diagnostic Matrix](#-quick-triage-diagnostic-matrix)
2. [Diagnostic Workflows & Essential Commands](#-diagnostic-workflows--essential-commands)
3. [Issue 1: GitHub App Permissions & Authentication (`HTTP 403`)](#-issue-1-github-app-permissions--authentication-http-403)
4. [Issue 2: Webhook & Dispatch Token Validation (`HTTP 401`)](#-issue-2-webhook--dispatch-token-validation-http-401)
5. [Issue 3: LLM Provider Rate Limits & Quotas (`HTTP 429`)](#-issue-3-llm-provider-rate-limits--quotas-http-429)
6. [Issue 4: Worker Lifecycle, Timeouts & Memory (`DeadlineExceeded`)](#-issue-4-worker-lifecycle-timeouts--memory-deadlineexceeded)
7. [Issue 5: Controller Lease Locks & Operator Contention](#-issue-5-controller-lease-locks--operator-contention)
8. [Issue 6: Ingress, TLS & Network Egress](#-issue-6-ingress-tls--network-egress)

---

## ⚡ Quick Triage Diagnostic Matrix

| Symptom / Error Code | Affected Component | Probable Cause | Immediate Remediation |
| :--- | :--- | :--- | :--- |
| **`HTTP 403 Forbidden`**<br>`Resource not accessible by integration` | Worker Pod / Action | GitHub App missing required permissions (`checks:write`, `pull-requests:write`, `contents:read`). | Update permissions in GitHub App settings, accept new permissions in repo/org settings. |
| **`HTTP 401 Unauthorized`**<br>`Invalid authorization token` | Dispatcher Service | Bearer dispatch token mismatch between GitHub secret and Kubernetes Secret. | Synchronize `DISPATCH_TOKEN` in Kubernetes `review-yeti-secrets` and Action secret. |
| **`HTTP 401 Unauthorized`**<br>`Invalid X-Hub-Signature-256` | Dispatcher Service | Webhook HMAC-SHA256 signature validation failure or mutated request payload. | Verify webhook secret; ensure ingress controller does not mutate or buffer raw payload bodies. |
| **`HTTP 429 Too Many Requests`**<br>`Retry-After` header present | Worker Pod / LLM | Provider concurrency/TPM quota exhausted on OpenRouter, Anthropic, or OpenAI. | Reduce `operator.config.maxConcurrentJobs` in `values.yaml` and configure fallback models. |
| **`DeadlineExceeded`**<br>`activeDeadlineSeconds` elapsed | Operator / Worker | PR diff too large (>5,000 lines) or LLM provider latency exceeded 14-minute window. | Configure `path_filters` in `.ct-review.yaml`; increase worker memory or reduce persona roster. |
| **`OOMKilled` (Exit code 137)** | Worker Pod | Node AST parsing and diff chunking exceeded container memory limit. | Increase `worker.resources.limits.memory` to `1.5Gi` or `2Gi` in `values.yaml`. |
| **`failed to acquire leader lease`** | Operator Controller | Multiple operator replicas running or stale lease lock following an ungraceful node shutdown. | Set `operator.replicaCount: 1`, verify `strategy.type: Recreate`, delete stale lease object. |
| **`HTTP 502 / 503 Bad Gateway`** | Ingress Controller | Dispatcher pods not ready, startup probe failing, or port target misconfigured. | Check `kubectl describe pods -l app.kubernetes.io/component=dispatcher` and probe endpoints. |

---

## 🔍 Diagnostic Workflows & Essential Commands

When triaging an incident, execute these commands to isolate the failing component:

### 1. Stream Dispatcher Ingestion Logs
The dispatcher logs all incoming HTTP admission requests, token validations, and CRD creations:

```bash
kubectl logs -n review-yeti-system \
  -l app.kubernetes.io/component=dispatcher \
  --tail=100 -f
```

### 2. Stream Operator Controller Logs
The Go operator logs PRReviewJob reconciliations, Job creation, and cleanup:

```bash
kubectl logs -n review-yeti-system \
  -l app.kubernetes.io/component=operator \
  --tail=100 -f
```

### 3. Inspect PRReviewJob Custom Resources
Review Yeti represents each review request as a `PRReviewJob` (`prj`) custom resource:

```bash
# List all active and completed review jobs
kubectl get prj -n review-yeti-system -o wide

# Inspect full status, CEL validation rules, and condition history
kubectl describe prj <job-name> -n review-yeti-system
```

### 4. Inspect Ephemeral Worker Pods & Logs
```bash
# List worker jobs and pods
kubectl get jobs,pods -n review-yeti-system -l app.kubernetes.io/component=worker

# View full review execution log from a worker container
kubectl logs -n review-yeti-system job/<job-name> -c worker --tail=200
```

### 5. Check Cluster Event Timeline
```bash
kubectl get events -n review-yeti-system \
  --sort-by='.metadata.creationTimestamp' \
  --field-selector type!=Normal
```

---

## 🔐 Issue 1: GitHub App Permissions & Authentication (`HTTP 403`)

### Symptoms
Worker pods fail during the execution phase or GitHub Action shims terminate with:
```text
HttpError: Resource not accessible by integration
    status: 403
    url: https://api.github.com/repos/my-org/my-repo/check-runs
```
Or when attempting to post review comments:
```text
HttpError: Resource not accessible by integration
    status: 403
    url: https://api.github.com/repos/my-org/my-repo/issues/42/comments
```

### Root Cause Analysis
This occurs when the GitHub App installed on the target repository lacks the necessary OAuth/App permission scopes, or when permission updates have not yet been approved by the organization administrator.

### Required Permission Matrix

Ensure your GitHub App has the following permissions configured in **GitHub App Settings > Permissions & events > Repository permissions**:

| Permission Scope | Access Level | Why Review Yeti Requires It |
| :--- | :--- | :--- |
| **Checks** | **Read and write** | Creates initial Check Run (`PENDING`), reports progress (`IN_PROGRESS`), and publishes the final review decision (`SUCCESS` or `FAILURE`). |
| **Pull requests** | **Read and write** | Posts the consolidated review comment, updates comments on new commits, and submits inline code suggestions. |
| **Contents** | **Read** | Reads base-branch `.ct-review.yaml`, persona charters, and git tree hunks to analyze code without requiring full repository checkout. |
| **Actions** | **Read** | *(Optional)* Required only when using `examples/workflows/incremental-review.yml` to download review cache artifacts from prior runs. |

> [!IMPORTANT]
> **Organization Permission Acceptance**: When you modify permissions on an existing GitHub App, GitHub automatically emails organization administrators an approval prompt. The updated permissions will **not** take effect until an organization owner clicks **Accept new permissions** in **Organization Settings > Installed GitHub Apps > Review Yeti**.

### Diagnostic & Remediation Playbook

#### Step 1: Validate Private Key and App ID Pair
Ensure the private key `.pem` corresponds to the configured `APP_ID`:

```bash
# Generate a test JWT valid for 5 minutes
APP_ID="123456"
PEM_FILE="./github-app.pem"

NOW=$(date +%s)
EXP=$((NOW + 300))

HEADER=$(echo -n '{"alg":"RS256","typ":"JWT"}' | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
PAYLOAD=$(echo -n "{\"iat\":$NOW,\"exp\":$EXP,\"iss\":\"$APP_ID\"}" | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
SIGNATURE=$(echo -n "$HEADER.$PAYLOAD" | openssl dgst -sha256 -sign "$PEM_FILE" | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
JWT="$HEADER.$PAYLOAD.$SIGNATURE"

# Test authenticated API call to GitHub
curl -i -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/app
```

Expected response: `HTTP/2 200 OK` with App metadata JSON.

#### Step 2: Validate Repository Access Scope
Check whether the target repository is included in the installation:

```bash
INSTALLATION_ID="98765432"

curl -s -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/app/installations/$INSTALLATION_ID/repositories | jq '.repositories[].full_name'
```

If your repository is missing, go to **Repository Settings > Integrations > GitHub Apps** and grant access.

#### Step 3: Check Branch Protection Rules
If your repository enforces strict branch protection (e.g., restricting which accounts can comment or push status checks), add the Review Yeti bot app to the bypass or allowed list.

---

## 🔑 Issue 2: Webhook & Dispatch Token Validation (`HTTP 401`)

### Symptoms
The GitHub Action shim fails with an authentication error:
```text
Error: Failed to dispatch review to Kubernetes backend: HTTP 401 Unauthorized
Response body: {"error": "Invalid or missing authorization dispatch token"}
```

Or when running direct webhooks:
```text
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{"error": "X-Hub-Signature-256 mismatch"}
```

### Root Cause Analysis
1. **Bearer Token Mismatch**: The secret `REVIEW_DISPATCH_SECRET` stored in GitHub Actions repository secrets does not match the `DISPATCH_TOKEN` mounted into the Review Yeti dispatcher pod.
2. **HMAC Signature Mismatch**: In direct webhook mode, GitHub signs payloads using HMAC-SHA256. If the shared secret differs or an intermediate proxy / Ingress controller modifies request headers or parses and re-serializes JSON (altering whitespace), signature verification fails.
3. **Admission Allowlists Rejection (`HTTP 403`)**: If `dispatcher.config.repositoryIds` or `dispatcher.config.ownerIds` are set in `values.yaml`, admission requests from unlisted repositories will receive `HTTP 403 Forbidden`.

### Remediation Playbook

#### Step 1: Verify Kubernetes Secret Token
Inspect the raw dispatch token configured in the cluster:

```bash
kubectl get secret review-yeti-secrets -n review-yeti-system \
  -o jsonpath="{.data.DISPATCH_TOKEN}" | base64 --decode
echo ""
```

#### Step 2: Test Dispatch Endpoint Directly via cURL
Test authentication against your Ingress endpoint using `curl`:

```bash
DISPATCH_URL="https://review.example.com/api/admission/dispatch"
TOKEN="<your-retrieved-token>"

curl -i -X POST "$DISPATCH_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"repository":"test/test","pullNumber":1,"commitSha":"1111111111111111111111111111111111111111"}'
```

- If you receive `HTTP 202 Accepted` or a structured admission response, the cluster secret and ingress routing are functional. Update your GitHub repository secret `REVIEW_DISPATCH_SECRET` to match.
- If you receive `HTTP 401 Unauthorized`, check `dispatcher.config.allowAppGate` in `values.yaml`.

---

## 🚦 Issue 3: LLM Provider Rate Limits & Quotas (`HTTP 429`)

### Symptoms
Worker pod logs show repeated 429 status errors:
```text
ProviderError: OpenRouter returned 429 Too Many Requests
Headers:
  retry-after: 28
  x-ratelimit-remaining-requests: 0
Body: {"error": {"message": "Rate limit exceeded: concurrent request quota exhausted for model deepseek/deepseek-v4-flash-0731"}}
```

### Root Cause Analysis
Multi-persona evaluation queries 5+ specialized personas simultaneously for every pull request commit. When multiple pull requests are updated concurrently across an organization, total requests can easily spike beyond provider Tier rate limits (RPM: Requests Per Minute, TPM: Tokens Per Minute).

### Remediation Playbook

#### Step 1: Throttle Controller Concurrency in Helm
Limit the maximum number of concurrent worker pods running across the cluster by adjusting `operator.config.maxConcurrentJobs` in `charts/review-yeti/values.yaml`:

```yaml
operator:
  config:
    maxConcurrentJobs: 4  # Reduced from default 10 to throttle total requests
```

Apply the change:
```bash
helm upgrade review-yeti charts/review-yeti \
  --namespace review-yeti-system \
  --reuse-values \
  --set operator.config.maxConcurrentJobs=4
```

#### Step 2: Configure Model Fallback Chains in `.ct-review.yaml`
Configure multi-model fallback resiliency so that if the primary model encounters a `HTTP 429` rate limit or provider outage, Review Yeti automatically fails over:

```yaml
# .ct-review.yaml
version: 3

reviewer_providers:
  default:
    model: "deepseek/deepseek-v4-flash-0731"
    fallback_models:
      - "anthropic/claude-3-5-haiku"
      - "openai/gpt-4o-mini"
```

#### Step 3: Verify Exponential Backoff Behavior
Review Yeti incorporates automated exponential backoff with full jitter and honors the `Retry-After` HTTP response header. When a 429 occurs, the worker pauses for the specified duration before attempting a retry. If retries are exhausted, the job exits with a clear error logged to the GitHub Check Run.

---

## ⏱️ Issue 4: Worker Lifecycle, Timeouts & Memory (`DeadlineExceeded`)

### Symptoms
- Worker pod transitions to `Terminating` or `Failed` status.
- Kubernetes event shows:
  ```text
  Warning  DeadlineExceeded  pod/prj-worker-abc  Pod was active on the node longer than the specified deadline
  ```
- Or worker pod terminates with `OOMKilled` (Exit Code 137).

### Root Cause Analysis

1. **CEL Terminal Deadline Validation**:
   The `PRReviewJob` CRD enforces an immutable 15-minute terminal execution window using Common Expression Language (CEL):
   ```cel
   timestamp(self.terminalDeadline) - timestamp(self.receivedAt) == duration('900s')
   ```
   If a worker pod runs longer than 900 seconds, the Kubernetes job runner marks the custom resource as failed with `DeadlineExceeded`.

2. **Large Pull Request Diffs (> 5,000 Lines)**:
   Massive diffs (e.g. database schema dumps, generated TypeScript types, lockfiles) take excessive time to chunk, tokenize, and evaluate across all personas.

3. **Memory Exhaustion (`OOMKilled` Exit Code 137)**:
   Parsing Abstract Syntax Trees (AST) and holding large git blobs in memory can exceed the default 1Gi memory limit.

### Remediation Playbook

#### Step 1: Filter Unnecessary Files in `.ct-review.yaml`
Prevent the review engine from analyzing auto-generated or vendored assets by adding path filters to your base branch `.ct-review.yaml`:

```yaml
path_filters:
  - "dist/**"
  - "build/**"
  - "node_modules/**"
  - "package-lock.json"
  - "pnpm-lock.yaml"
  - "vendor/**"
  - "**/*.min.js"
  - "**/*.generated.*"
```

#### Step 2: Sizing Worker Memory Limits in Helm
Increase worker memory requests and limits in `charts/review-yeti/values.yaml`:

```yaml
worker:
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 2Gi  # Increased from default 1Gi to accommodate large diffs
  activeDeadlineSeconds: 840  # 14 minutes (graceful timeout before 15m CEL deadline)
```

Apply the sizing upgrade:
```bash
helm upgrade review-yeti charts/review-yeti \
  --namespace review-yeti-system \
  --reuse-values \
  --set worker.resources.limits.memory="2Gi"
```

#### Step 3: Inspect Worker Job Failure Details
```bash
# Locate failed worker pods
kubectl get pods -n review-yeti-system -l app.kubernetes.io/component=worker --field-selector status.phase=Failed

# Check if terminated due to OOM
kubectl get pod <pod-name> -n review-yeti-system -o jsonpath='{.status.containerStatuses[0].state.terminated.reason}'
```
If output is `OOMKilled`, increasing memory limit (Step 2) resolves the issue.

---

## 🔒 Issue 5: Controller Lease Locks & Operator Contention

### Symptoms
The operator controller pod starts, but fails to reconcile any `PRReviewJob` resources. Logs display:
```text
{"level":"info","ts":"...","logger":"leader-election","msg":"attempting to acquire leader lease review-yeti-system/review-yeti-operator-lock..."}
{"level":"info","ts":"...","logger":"leader-election","msg":"failed to acquire lease, another instance is holding it"}
```

### Root Cause Analysis
1. **Multiple Operator Replicas**: The operator is designed as an active-passive controller. If `operator.replicaCount` is greater than `1` without leader election enabled, pods will compete for reconciliation locks.
2. **Stale Lease After Abrupt Node Eviction**: When a Kubernetes node crashes or experiences network partition, the coordination lease lock (`coordination.k8s.io/leases`) held by the previous operator pod may take several minutes to expire.

### Remediation Playbook

#### Step 1: Verify Single Replica Deployment
Ensure `operator.replicaCount` is set to `1` and `deploymentStrategy` is set to `Recreate`:

```bash
kubectl get deployment review-yeti-operator -n review-yeti-system -o yaml | grep -A 2 "replicas:"
```

#### Step 2: Inspect and Release Stale Lease Lock
Inspect the active coordination lease in the namespace:

```bash
kubectl get leases -n review-yeti-system
kubectl describe lease review-yeti-operator-lock -n review-yeti-system
```

If the pod named in `Holder Identity` is terminated or no longer exists, manually delete the stale lease:

```bash
kubectl delete lease review-yeti-operator-lock -n review-yeti-system
```

The running operator pod will immediately acquire the lease and resume reconciliation.

---

## 🌐 Issue 6: Ingress, TLS & Network Egress

### Symptoms
- Action shims cannot reach `https://review.example.com/api/admission/dispatch` (`HTTP 502 Bad Gateway` or `Connection refused`).
- Worker pods fail with `FetchError: request to https://api.github.com/... failed, reason: connect ETIMEDOUT`.

### Diagnostic & Remediation Playbook

#### Step 1: Verify Dispatcher Service Endpoints
Ensure dispatcher pods are passing readiness probes and registered as valid endpoints:

```bash
kubectl get endpoints review-yeti-dispatcher -n review-yeti-system
```

If the endpoints list is empty (`<none>`), inspect dispatcher readiness probe failures:
```bash
kubectl describe pod -n review-yeti-system -l app.kubernetes.io/component=dispatcher
```

#### Step 2: Inspect Ingress TLS Certificate Status
For installations using `cert-manager`:

```bash
kubectl get certificate,certificaterequest,order,challenge -n review-yeti-system
```

If the certificate status is `False`, check cert-manager logs:
```bash
kubectl logs -n cert-manager -l app=cert-manager --tail=100
```

#### Step 3: Check Cluster NetworkPolicy Egress Rules
Review Yeti worker pods require outbound HTTPS egress (TCP port 443) to:
- `api.github.com` (GitHub REST & Checks API)
- `openrouter.ai` / `api.anthropic.com` / `api.openai.com` (LLM Provider endpoints)

If your cluster enforces default-deny NetworkPolicies, ensure an egress rule allows port 443 outbound:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-review-yeti-egress
  namespace: review-yeti-system
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: review-yeti
  policyTypes:
    - Egress
  egress:
    # Allow DNS resolution
    - to:
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
    # Allow external HTTPS to GitHub and AI providers
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - protocol: TCP
          port: 443
```

---

## 🤝 Getting Additional Support

If you encounter an issue not covered in this guide:
1. Collect a diagnostic bundle:
   ```bash
   kubectl get all,prj,leases,events -n review-yeti-system -o yaml > review-yeti-debug.yaml
   ```
2. Open an issue on GitHub: [review-yeti-ai/review-yeti-bot/issues](https://github.com/review-yeti-ai/review-yeti-bot/issues) with the debug log and sanitized environment details.
