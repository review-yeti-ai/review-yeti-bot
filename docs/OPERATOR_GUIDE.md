# ct-review-bot — Enterprise Operator & Deployment Guide

## Overview
This document describes production deployment procedures for `ct-review-bot` on DigitalOcean Kubernetes (DOKS), secret management via Doppler & Kubernetes Secrets, and default provider allocations.

## Default LLM Provider Allocation
As of **v1.5.1**, the default provider for review synthesis and arbiter quorum is **Synthetic API** with model **`glm-5.2`** (high reasoning effort).

```yaml
reviewers:
  execution: personas
  providers:
    - id: synthetic
      enabled: true
      model: glm-5.2
      effort: max
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [synthetic, codex, claude]
```

## Secret Management & Pre-Deployment Procedures

### 1. Doppler Secret Management (Recommended)
Store `SYNTHETIC_API_KEY` securely in Doppler:
```bash
doppler secrets set SYNTHETIC_API_KEY=syn_caed4a04054f3d66e707e63b31cae88e --project ct-review-bot --config dev
```

### 2. Kubernetes Secret Deployment (DOKS Cluster)
Deploy the secret to your DigitalOcean Kubernetes cluster (`ct-review-bot` namespace):
```bash
kubectl create secret generic ct-review-bot-secrets \
  --from-literal=SYNTHETIC_API_KEY=syn_caed4a04054f3d66e707e63b31cae88e \
  --namespace=ct-review-bot
```

Or apply via manifest template:
```bash
kubectl apply -f k8s/synthetic-secret.yaml
```

### 3. Verification & Health Check
Verify Kubernetes secrets and server readiness:
```bash
kubectl get secret ct-review-bot-secrets -n ct-review-bot
curl -s https://ct-review-bot.calltelemetry.com/health | jq .
```
