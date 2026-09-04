# ☸️ Review Yeti Helm 3 Operations & Deployment Guide

Welcome to the official production Helm 3 deployment guide for **Review Yeti**. This guide walks platform, DevOps, and site reliability engineers through installing, configuring, scaling, upgrading, and troubleshooting Review Yeti across Kubernetes clusters.

---

## 📑 Table of Contents

1. [Architectural Overview](#-architectural-overview)
2. [Prerequisites](#-prerequisites)
3. [Quickstart: 5-Minute Installation](#-quickstart-5-minute-installation)
4. [Detailed Values Tuning](#-detailed-values-tuning)
   - [Dispatcher Service](#1-dispatcher-service-dispatcher)
   - [Operator Controller](#2-operator-controller-operator)
   - [Worker Pod Defaults & Sizing](#3-worker-pod-defaults--sizing-worker)
   - [Ingress & TLS Management](#4-ingress--tls-management-ingress)
   - [Secrets Management](#5-secrets-management-secrets)
   - [CRD Lifecycle](#6-crd-lifecycle-crd)
5. [Cloud Deployment Walk-Throughs](#-cloud-deployment-walk-throughs)
   - [DigitalOcean Kubernetes (DOKS)](#digitalocean-kubernetes-doks)
   - [AWS Elastic Kubernetes Service (EKS)](#aws-elastic-kubernetes-service-eks)
   - [Local Development (Minikube / Kind / K3s)](#local-development-minikube--kind--k3s)
6. [Secrets Management Best Practices](#-secrets-management-best-practices)
7. [Upgrade & Rollback Procedures](#-upgrade--rollback-procedures)
   - [Release Upgrades](#release-upgrades)
   - [Inspection & Revision History](#inspection--revision-history)
   - [Rollback Operations](#rollback-operations)
8. [Cluster Health & Smoke Testing](#-cluster-health--smoke-testing)
9. [Uninstallation & Cleanup](#-uninstallation--cleanup)

---

## 🏗️ Architectural Overview

Review Yeti's Kubernetes execution mode decouples webhook ingestion from computationally intensive AI model evaluations. Instead of running full multi-persona panels inside billable GitHub Actions runners, an ultra-fast GitHub Action shim dispatches the review job to your Kubernetes cluster in **< 10 seconds**, saving 95%+ of runner costs.

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant GHA as GitHub Action Shim (< 10s)
    participant GH_API as GitHub Checks & PR API
    participant Ing as Ingress / LoadBalancer
    participant Disp as Review Yeti Dispatcher
    participant K8s as Kubernetes API (CRD)
    participant Op as Review Yeti Operator
    participant Work as Ephemeral Worker Pod

    Dev->>GHA: Push commit / Open PR
    GHA->>GH_API: Create Check Run (Status: PENDING)
    GHA->>Ing: POST /api/admission/dispatch (JWT + Token)
    Ing->>Disp: Forward Admission Request
    Disp->>Disp: Validate Dispatch Token & Repo Allowlist
    Disp->>K8s: Create PRReviewJob (review-yeti.ai/v1alpha2)
    Disp-->>GHA: 202 Accepted { jobId: "prj-..." }
    Note over GHA: Action terminates immediately (0 billable waste)
    Op->>K8s: Watch & Reconcile PRReviewJob
    Op->>K8s: Spawn batch/v1 Job with Workspace PVC
    K8s->>Work: Launch Ephemeral Worker Container
    Work->>GH_API: Update Check Run (Status: IN_PROGRESS)
    Work->>Work: Run Multi-Persona AI Review Panel
    Work->>GH_API: Post Consolidated PR Comment
    Work->>GH_API: Update Check Run (Status: SUCCESS / FAILURE)
    Work-->>K8s: Exit 0 (Pod cleaned up per TTL)
```

### Components Deployed by the Chart

- **Review Yeti Dispatcher** (`deployment-dispatcher.yaml`): Node.js service receiving HTTP admission requests from the GitHub Action shim, validating bearer dispatch tokens, and committing `PRReviewJob` custom resources to Kubernetes.
- **Review Yeti Operator** (`deployment-operator.yaml`): Namespace-scoped Go controller reconciling `PRReviewJob` resources into ephemeral `batch/v1` Jobs.
- **Worker Specifications** (`values.yaml`): Configuration template injected into ephemeral worker pods executing multi-persona AI reviews.
- **Custom Resource Definition** (`crd.yaml`): The `PRReviewJob` custom resource (`review-yeti.ai/v1alpha2`) with strict Common Expression Language (CEL) validation rules.
- **Security & RBAC** (`rbac.yaml`, `worker-rbac.yaml`): Principle-of-least-privilege ServiceAccounts, Roles, and RoleBindings enforcing non-root execution and namespace scoping.

---

## 📋 Prerequisites

Before deploying Review Yeti with Helm 3, ensure your environment meets the following requirements:

- **Kubernetes Version**: `v1.28+` (supports CEL validation rules in CRD schemas).
- **Helm Version**: `v3.12+` (`helm version` to verify).
- **Storage**: A dynamic PersistentVolume provisioner supporting `ReadWriteOnce` claims (e.g., DigitalOcean Block Storage `do-block-storage`, AWS EBS CSI `gp3`, or Minikube `standard`).
- **Ingress Controller**: Ingress controller exposing the dispatcher (e.g., ingress-nginx, AWS Load Balancer Controller, Traefik).
- **GitHub App**:
  - Registered GitHub App with Private Key (`.pem`), App ID, and Installation ID.
  - Permissions: **Checks: Read & write**, **Pull requests: Read & write**, **Contents: Read**.
- **LLM Provider**: API key from OpenRouter, DeepSeek, Anthropic, OpenAI, or a self-hosted local Ollama endpoint.

---

## ⚡ Quickstart: 5-Minute Installation

The quickest way to deploy Review Yeti into your cluster is using the official chart:

```bash
# 1. Clone or navigate to the repository
cd /tmp/review-yeti-bot

# 2. Create a dedicated namespace
kubectl create namespace review-yeti-system

# 3. Install Review Yeti with required secrets
helm install review-yeti charts/review-yeti \
  --namespace review-yeti-system \
  --set secrets.appId="123456" \
  --set secrets.installationId="98765432" \
  --set secrets.privateKey="$(cat github-app.pem)" \
  --set secrets.dispatchToken="$(openssl rand -hex 32)" \
  --set secrets.openRouterApiKey="sk-or-v1-xxxxxxxxxxxx" \
  --set ingress.enabled=true \
  --set ingress.host="review.example.com"
```

> [!NOTE]
> When installing from an explicit values file, you can pass `-f values.yaml`:
> ```bash
> helm install review-yeti charts/review-yeti -f values.yaml --namespace review-yeti-system
> ```

---

## ⚙️ Detailed Values Tuning

All configuration is centralized in `charts/review-yeti/values.yaml`. Below is an in-depth breakdown of available parameters and tuning recommendations for production.

### 1. Dispatcher Service (`dispatcher`)

The dispatcher service is the admission gateway for incoming webhook reviews.

```yaml
dispatcher:
  enabled: true
  replicaCount: 2  # Run 2+ replicas for high availability

  image:
    repository: ghcr.io/review-yeti-ai/review-yeti-dispatcher
    pullPolicy: IfNotPresent
    tag: "" # Defaults to chart appVersion (1.28.0)

  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi

  securityContext:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    capabilities:
      drop:
        - ALL

  config:
    nodeEnv: production
    host: "0.0.0.0"
    port: 3000
    allowAppGate: true
    # Optional security allowlists (comma-separated):
    repositoryIds: "12345678,87654321"
    ownerIds: "998877"
    workflowRefs: "refs/heads/main"
```

> [!TIP]
> Keep `podAntiAffinity` enabled (default in `values.yaml`) to ensure dispatcher pods are scheduled across separate Kubernetes worker nodes for fault tolerance.

### 2. Operator Controller (`operator`)

The operator reconciles `PRReviewJob` CRDs into ephemeral Kubernetes batch Jobs.

```yaml
operator:
  enabled: true
  replicaCount: 1  # Strictly 1 replica to prevent split-brain leader election contention

  image:
    repository: ghcr.io/review-yeti-ai/review-yeti-operator
    pullPolicy: IfNotPresent
    tag: ""

  config:
    metricsAddr: ":8080"
    healthAddr: ":8081"
    maxConcurrentJobs: 10  # Throttle concurrent worker pods to protect LLM rate limits

  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
```

> [!IMPORTANT]
> The operator uses `deploymentStrategy: Recreate` so that during upgrades, the old pod terminates and releases its coordination lease lock before the new pod initializes.

### 3. Worker Pod Defaults & Sizing (`worker`)

Worker pods are ephemeral `batch/v1` Jobs spawned dynamically per review request.

```yaml
worker:
  image:
    repository: ghcr.io/review-yeti-ai/review-yeti-worker
    pullPolicy: IfNotPresent
    tag: ""

  resources:
    requests:
      cpu: 250m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 1Gi  # Increase to 2Gi for repositories with huge diffs (>5,000 lines)

  storage:
    size: 1Gi
    storageClassName: ""  # Leave blank for default cluster StorageClass

  activeDeadlineSeconds: 840  # 14 minutes hard timeout inside the container
  ttlSecondsAfterFinished: 300 # Retain completed pods for 5 minutes for log inspection
```

> [!WARNING]
> Review Yeti's CRD enforces a strict 15-minute terminal deadline (`terminalDeadline - receivedAt == 900s`) via CEL validation. Worker `activeDeadlineSeconds` should always remain below 900 seconds (recommended: `840s`) so the worker container can gracefully finalize and post failure details before being forcefully evicted.

### 4. Ingress & TLS Management (`ingress`)

Exposes the dispatcher endpoint externally so GitHub Actions shims can reach it over HTTPS.

```yaml
ingress:
  enabled: true
  className: "nginx"
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    kubernetes.io/tls-acme: "true"
  host: review.example.com
  path: /api/admission/dispatch
  pathType: Prefix
  tls:
    enabled: true
    secretName: review-yeti-tls
```

### 5. Secrets Management (`secrets`)

```yaml
secrets:
  create: true
  existingSecretName: ""  # Set this to use an existing secret (Vault, ESO, etc.)
  appId: "123456"
  installationId: "98765432"
  privateKey: |
    -----BEGIN RSA PRIVATE KEY-----
    ...
    -----END RSA PRIVATE KEY-----
  dispatchToken: "super-secret-random-token"
  openRouterApiKey: "sk-or-v1-..."
```

### 6. CRD Lifecycle (`crd`)

```yaml
crd:
  install: true  # Automatically manages the PRReviewJob CRD
```

---

## ☁️ Cloud Deployment Walk-Throughs

Review Yeti provides pre-tested, cloud-optimized values files in `examples/k8s/`.

### DigitalOcean Kubernetes (DOKS)

DigitalOcean Kubernetes provides high-performance NVMe block storage and native Load Balancer integration.

#### 1. Configuration (`examples/k8s/values-doks.yaml`)
Review Yeti uses `do-block-storage` for worker PVCs and configures the DO Load Balancer with HTTPS redirect and Let's Encrypt TLS:

```yaml
# examples/k8s/values-doks.yaml
ingress:
  enabled: true
  className: "nginx"
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    service.beta.kubernetes.io/do-loadbalancer-name: "review-yeti-lb"
    service.beta.kubernetes.io/do-loadbalancer-protocol: "https"
    service.beta.kubernetes.io/do-loadbalancer-tls-ports: "443"
    service.beta.kubernetes.io/do-loadbalancer-redirect-http-to-https: "true"
  host: "review.doks.example.com"
  path: "/api/admission/dispatch"
  pathType: "Prefix"
  tls:
    enabled: true
    secretName: "review-yeti-doks-tls"

worker:
  storage:
    storageClassName: "do-block-storage"
    size: "2Gi"

dispatcher:
  replicaCount: 2

operator:
  replicaCount: 1

secrets:
  create: false
  existingSecretName: "review-yeti-secrets"
```

#### 2. Create the Secret & Deploy to DOKS
```bash
# Create the secret out-of-band
kubectl create secret generic review-yeti-secrets \
  --namespace review-yeti-system \
  --from-literal=APP_ID="123456" \
  --from-literal=INSTALLATION_ID="98765432" \
  --from-file=PRIVATE_KEY=./github-app.pem \
  --from-literal=DISPATCH_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=OPENROUTER_API_KEY="sk-or-v1-..."

# Deploy with DOKS values
helm install review-yeti charts/review-yeti \
  --namespace review-yeti-system \
  --create-namespace \
  -f examples/k8s/values-doks.yaml
```

---

### AWS Elastic Kubernetes Service (EKS)

AWS EKS leverages AWS Load Balancer Controller (ALB) and EBS CSI (`gp3`).

#### 1. Configuration (`examples/k8s/values-eks.yaml`)
```yaml
# examples/k8s/values-eks.yaml
ingress:
  enabled: true
  className: "alb"
  annotations:
    alb.ingress.kubernetes.io/scheme: "internet-facing"
    alb.ingress.kubernetes.io/target-type: "ip"
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
    alb.ingress.kubernetes.io/certificate-arn: "arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012"
    alb.ingress.kubernetes.io/healthcheck-path: "/health"
    alb.ingress.kubernetes.io/healthcheck-port: "3000"
  host: "review.eks.example.com"
  path: "/api/admission/dispatch"
  pathType: "Prefix"
  tls:
    enabled: false  # TLS terminated at AWS ALB via ACM certificate

dispatcher:
  replicaCount: 2
  serviceAccount:
    create: true
    annotations:
      eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/review-yeti-dispatcher-irsa"

worker:
  storage:
    storageClassName: "gp3"
    size: "2Gi"

operator:
  replicaCount: 1

secrets:
  create: false
  existingSecretName: "review-yeti-secrets"
```

#### 2. Deploy to AWS EKS
```bash
helm install review-yeti charts/review-yeti \
  --namespace review-yeti-system \
  --create-namespace \
  -f examples/k8s/values-eks.yaml
```

---

### Local Development (Minikube / Kind / K3s)

For offline development and CI sandbox validation, deploy with local NodePort and Ollama endpoints without requiring external Ingress or cloud storage.

#### 1. Configuration (`examples/k8s/values-local.yaml`)
```yaml
# examples/k8s/values-local.yaml
ingress:
  enabled: false

dispatcher:
  replicaCount: 1
  service:
    type: NodePort
    nodePort: 30080
  resources:
    requests:
      cpu: "50m"
      memory: "64Mi"
    limits:
      cpu: "250m"
      memory: "256Mi"

operator:
  replicaCount: 1
  config:
    maxConcurrentJobs: 2
  resources:
    requests:
      cpu: "50m"
      memory: "64Mi"
    limits:
      cpu: "250m"
      memory: "256Mi"

worker:
  storage:
    storageClassName: "standard" # On K3s, use "local-path"
    size: "500Mi"
  resources:
    requests:
      cpu: "100m"
      memory: "256Mi"
    limits:
      cpu: "500m"
      memory: "512Mi"

secrets:
  create: true
  openRouterBaseUrl: "http://host.minikube.internal:11434/v1"
  openRouterApiKey: "ollama"
  dispatchToken: "local-dev-token"
```

#### 2. Deploy Locally
```bash
helm install review-yeti charts/review-yeti \
  --namespace review-yeti-system \
  --create-namespace \
  -f examples/k8s/values-local.yaml
```

---

## 🔒 Secrets Management Best Practices

Review Yeti consumes sensitive GitHub App private keys and LLM API keys. Follow these enterprise practices:

### Option A: External Secrets Operator (ESO) & Vault (Recommended)
In enterprise environments, store credentials in HashiCorp Vault, AWS Secrets Manager, or Google Secret Manager and sync them to Kubernetes using External Secrets:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: review-yeti-secrets
  namespace: review-yeti-system
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: review-yeti-secrets
  data:
    - secretKey: APP_ID
      remoteRef:
        key: secret/data/review-yeti
        property: app_id
    - secretKey: INSTALLATION_ID
      remoteRef:
        key: secret/data/review-yeti
        property: installation_id
    - secretKey: PRIVATE_KEY
      remoteRef:
        key: secret/data/review-yeti
        property: private_key_pem
    - secretKey: DISPATCH_TOKEN
      remoteRef:
        key: secret/data/review-yeti
        property: dispatch_token
    - secretKey: OPENROUTER_API_KEY
      remoteRef:
        key: secret/data/review-yeti
        property: openrouter_api_key
```

Then configure Helm:
```yaml
secrets:
  create: false
  existingSecretName: "review-yeti-secrets"
```

### Option B: Sealed Secrets
Encrypt your `secrets.yaml` with Bitnami Sealed Secrets before committing to GitOps repositories.

---

## 🔄 Upgrade & Rollback Procedures

### Release Upgrades

When upgrading Review Yeti to a newer version or modifying configuration parameters:

```bash
# 1. Update chart repositories or local files
git pull origin main

# 2. Preview planned changes with dry-run diff
helm diff upgrade review-yeti charts/review-yeti \
  --namespace review-yeti-system \
  -f values-production.yaml

# 3. Perform the release upgrade
helm upgrade review-yeti charts/review-yeti \
  --namespace review-yeti-system \
  -f values-production.yaml
```

The dispatcher will execute a rolling update with zero downtime. The operator will restart to acquire its lease cleanly.

### Inspection & Revision History

View all historical revisions, deployed timestamps, and chart versions:

```bash
helm history review-yeti --namespace review-yeti-system
```

Example output:
```text
REVISION  UPDATED                   STATUS      CHART              APP VERSION  DESCRIPTION
1         Mon Sep 1 10:00:00 2026   superseded  review-yeti-1.0.0  1.28.0       Install complete
2         Wed Sep 3 14:30:00 2026   deployed    review-yeti-1.0.0  1.28.0       Upgrade complete
```

### Rollback Operations

If an upgrade introduces an unexpected issue or invalid configuration, roll back instantly to a known good revision:

```bash
# Roll back to revision 1
helm rollback review-yeti 1 --namespace review-yeti-system
```

> [!TIP]
> Helm rollback restores previous ConfigMaps, Deployments, and RBAC rules immediately. Active ephemeral worker jobs are left to complete normally.

---

## 🩺 Cluster Health & Smoke Testing

Verify the health of your deployed Review Yeti cluster:

### 1. Check Workload Status
```bash
kubectl get pods -n review-yeti-system -l app.kubernetes.io/instance=review-yeti
```

Expected output:
```text
NAME                                      READY   STATUS    RESTARTS   AGE
review-yeti-dispatcher-7c77ffbf4b-k82x2   1/1     Running   0          5m
review-yeti-dispatcher-7c77ffbf4b-x92nm   1/1     Running   0          5m
review-yeti-operator-58cf7b565d-p8zlw     1/1     Running   0          5m
```

### 2. Verify Health Probes
```bash
# Test dispatcher health probe
kubectl exec -n review-yeti-system deploy/review-yeti-dispatcher -c dispatcher -- \
  wget -qO- http://127.0.0.1:3000/health

# Test operator health probe
kubectl exec -n review-yeti-system deploy/review-yeti-operator -c operator -- \
  wget -qO- http://127.0.0.1:8081/healthz
```

### 3. Dispatch a Smoke Test Admission Request
Send a mock dispatch request to verify the admission pipeline:

```bash
DISPATCH_URL="https://review.example.com/api/admission/dispatch"
DISPATCH_TOKEN="your-dispatch-token"

curl -i -X POST "$DISPATCH_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -d '{
    "repository": "test-org/test-repo",
    "pullNumber": 42,
    "commitSha": "e6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
    "baseRef": "main",
    "headRef": "feature/payment-gate"
  }'
```

Expected response:
```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{"status":"admitted","jobId":"prj-test-repo-42-e6a1b2"}
```

Then inspect the generated CRD resource:
```bash
kubectl get prj -n review-yeti-system
kubectl describe prj -n review-yeti-system
```

---

## 🧹 Uninstallation & Cleanup

To cleanly remove Review Yeti from your cluster:

```bash
# 1. Uninstall the Helm release
helm uninstall review-yeti --namespace review-yeti-system

# 2. (Optional) Prune completed batch Jobs and PersistentVolumeClaims
kubectl delete jobs -n review-yeti-system -l app.kubernetes.io/name=review-yeti
kubectl delete pvc -n review-yeti-system -l app.kubernetes.io/name=review-yeti

# 3. (Optional) Remove CRD if no longer managing PRReviewJobs
kubectl delete crd prreviewjobs.review-yeti.ai

# 4. Remove the namespace
kubectl delete namespace review-yeti-system
```

> [!WARNING]
> Deleting the CRD (`prreviewjobs.review-yeti.ai`) will immediately delete all existing `PRReviewJob` custom resources across all namespaces. Only delete the CRD if you are decommissioning Review Yeti entirely.

---

## 📚 Related Documentation

- [Production Troubleshooting Guide](TROUBLESHOOTING.md) — Remediation for HTTP 403, 401, 429, and worker timeouts.
- [Kubernetes Mode Reference](KUBERNETES_MODE.md) — Architecture and security specifications.
- [Examples Gallery](../examples/README.md) — Copy-pasteable workflows and multi-persona charters.
