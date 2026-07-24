# Milestone 5 Analysis Report: Containerization & DigitalOcean Kubernetes (DOKS) Deployment

**Project Target Root:** `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`  
**Date:** July 24, 2026  
**Author:** Explorer 1 (Milestone 5)

---

## 1. Executive Summary

`ct-review-bot` is an enterprise-grade quorum-based GitHub Code Review Bot service built with Node.js 20, TypeScript, Express, Zod, and SQLite (`better-sqlite3` with JSON file storage fallback). It implements a 6-stage review pipeline evaluating PRs via configurable personas, ticket validation, constitution enforcement, incremental diff delta tracking, and OmniRoute LLM gateway calls.

This investigation evaluated the codebase (`src/`, `package.json`, `tsconfig.json`, `tests/`) to identify exact requirements for containerizing the application with Docker and deploying it to DigitalOcean Kubernetes Service (DOKS). All 346 unit/integration tests and 113 E2E tests pass cleanly against Node 20.

**Key Findings:**
1. **Host Binding Fix Required:** In `src/index.ts:11`, `app.listen` hardcodes the host address to `'127.0.0.1'`. In Docker/Kubernetes container networking, binding to loopback prevents external ingress traffic and pod health probes from reaching the server. It must be updated to bind to `process.env.HOST || '0.0.0.0'`.
2. **Health & Metrics Endpoints:** The application already implements HTTP `GET /health` (providing status, uptime, and router pool snapshot) and `GET /api/router/status` (router snapshot + token metrics). `/health` is fully ready for Kubernetes Liveness and Readiness probes.
3. **Native Dependencies:** SQLite persistence uses `better-sqlite3` (in `optionalDependencies`). Multi-stage Docker build must include build tools (`python3`, `make`, `g++`) in the builder stage to compile native C++ bindings, or leverage clean failover to `JsonFileDiffStateStorage`.
4. **Configuration & Secrets:** Non-sensitive configs (`LOG_LEVEL`, `OMNIROUTE_BASE_URL`, `.ct-review.yaml`, `CONSTITUTION.md`) should be managed via Kubernetes `ConfigMap`. Sensitive tokens (`GITHUB_TOKEN`, `WEBHOOK_SECRET`, `CT_SECRET_MASTER_KEY`, `CT_SECRET_SALT`) must be injected via Kubernetes `Secret`.

---

## 2. Architecture & Entry Point Analysis

### 2.1 Entry Point & Lifecycle (`src/index.ts` & `src/app.ts`)
* **Entry Point File:** `src/index.ts`
* **Transpiled Executable:** `dist/index.js` (generated via `npm run build` / `tsc`).
* **Package.json Main & Start:**
  ```json
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  }
  ```
* **Port & Binding Configuration:**
  ```typescript
  // src/index.ts (lines 8-16)
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const app = createApp();

  const server = app.listen(PORT, '127.0.0.1', () => {
    logger.info(`ct-review-bot service listening on port ${PORT}`, {
      port: PORT,
      nodeEnv: process.env.NODE_ENV || 'development'
    });
  });
  ```
* **Issue Analysis:** `app.listen(PORT, '127.0.0.1')` restricts socket listening to local loopback interface. Inside a Docker container, traffic forwarded from host port mappings or K8s Service proxying originates from bridge/pod IP addresses, resulting in `Connection refused`.
* **Proposed Code Modification (`src/index.ts`):**
  ```typescript
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const HOST = process.env.HOST || '0.0.0.0';
  const app = createApp();

  const server = app.listen(PORT, HOST, () => {
    logger.info(`ct-review-bot service listening on ${HOST}:${PORT}`, {
      port: PORT,
      host: HOST,
      nodeEnv: process.env.NODE_ENV || 'development'
    });
  });
  ```
* **Graceful Shutdown:** `src/index.ts` listens for `SIGTERM` and `SIGINT`, initiating `server.close()` with a 10-second timeout force exit (`setTimeout(..., 10000).unref()`). This complies directly with Kubernetes pod termination lifecycle (`preStop` / `SIGTERM` terminationGracePeriodSeconds).

---

## 3. Routes & Kubernetes Health Probes

### 3.1 `/health` Route Endpoint (`src/app.ts:385-399`)
* **HTTP Method:** `GET`
* **Path:** `/health`
* **Response Payload Example:**
  ```json
  {
    "status": "ok",
    "service": "ct-review-bot",
    "timestamp": "2026-07-24T15:51:39.000Z",
    "uptimeSeconds": 124.5,
    "router": {
      "activeProviders": 4,
      "totalProviders": 4,
      "poolStatus": "healthy"
    }
  }
  ```
* **Status Code Behavior:** Returns HTTP 200 JSON. When provider pool status is `exhausted`, `status` reports `degraded` while maintaining HTTP 200, allowing pod to stay alive while signaling operational degradation.
* **Kubernetes Probe Recommendation:**
  * **LivenessProbe:**
    ```yaml
    livenessProbe:
      httpGet:
        path: /health
        port: http
      initialDelaySeconds: 10
      periodSeconds: 15
      timeoutSeconds: 5
      failureThreshold: 3
    ```
  * **ReadinessProbe:**
    ```yaml
    readinessProbe:
      httpGet:
        path: /health
        port: http
      initialDelaySeconds: 5
      periodSeconds: 5
      timeoutSeconds: 3
      failureThreshold: 2
    ```

### 3.2 `/api/router/status` Route Endpoint (`src/app.ts:402-411`)
* **HTTP Method:** `GET`
* **Path:** `/api/router/status`
* **Response Payload:** Detailed JSON containing provider snapshot, circuit breaker states, latency metrics, and token usage metrics. Suitable for Prometheus exporter scrapers or internal status monitoring.

### 3.3 Webhook Routes (`src/github/webhookServer.ts:114-118`)
* **HTTP Method:** `POST`
* **Paths:** `/webhook` and `/api/webhook/github`
* **Payload Verification:** Validates GitHub HMAC header `X-Hub-Signature-256` using `WEBHOOK_SECRET` / `GITHUB_WEBHOOK_SECRET`. Returns HTTP 401 if missing/invalid, HTTP 200 with JSON status on success.

---

## 4. Environment Variables & Secrets Reference

| Variable Name | Required / Optional | Default Value | Description | Recommended Storage |
|---|---|---|---|---|
| `PORT` | Optional | `3000` | Port for Express server listener | ConfigMap |
| `HOST` | Optional | `0.0.0.0` | Binding network interface address | ConfigMap |
| `NODE_ENV` | Optional | `production` | Node execution environment (`production` enables structured JSON logging) | ConfigMap |
| `LOG_LEVEL` | Optional | `info` | Logging level (`debug`, `info`, `warn`, `error`) | ConfigMap |
| `WEBHOOK_SECRET` | Required (Prod) | `development-webhook-secret-key-12345` | GitHub Webhook HMAC signature key | Secret |
| `GITHUB_WEBHOOK_SECRET` | Optional | Alias for `WEBHOOK_SECRET` | Fallback alias for webhook secret | Secret |
| `GITHUB_TOKEN` | Required (Prod) | None | GitHub Personal Access Token / App Installation Token | Secret |
| `GITHUB_API_BASE_URL` | Optional | `https://api.github.com` | Base URL for GitHub API (useful for GitHub Enterprise) | ConfigMap |
| `OMNIROUTE_BASE_URL` | Optional | `http://127.0.0.1:9090` | Endpoint URL for OmniRoute LLM Router Service | ConfigMap (e.g. `http://omniroute-service:9090`) |
| `CT_REVIEW_DB_PATH` | Optional | `:memory:` | Path to SQLite database file (e.g., `/data/pr_state.db`) | ConfigMap |
| `CT_REVIEW_CONFIG_PATH` | Optional | None | Path to custom `.ct-review.yaml` file | ConfigMap (Mounted Volume) |
| `CT_REVIEW_CONSTITUTION_PATH` | Optional | None | Path to custom `CONSTITUTION.md` file | ConfigMap (Mounted Volume) |
| `CT_SECRET_SALT` | Optional | `ct-review-bot-master-salt` | Salt string for TokenManager cryptographic operations | Secret |
| `CT_SECRET_MASTER_KEY` | Optional | None | 32-byte hex master key for TokenManager encryption | Secret |

---

## 5. Containerization Strategy (Dockerfile Design)

### 5.1 Base Image Selection & Architecture
* **Base Image:** `node:20-alpine` (or `node:20-slim`). `alpine` produces minimal image size (~150MB).
* **Multi-Stage Build Pattern:**
  * **Stage 1 (`builder`):** Installs build tooling (`python3`, `make`, `g++`), copies package files, executes `npm ci`, compiles TypeScript (`npm run build`), and prunes devDependencies (`npm prune --production`).
  * **Stage 2 (`runner` / `production`):** Copies built `dist/` and production `node_modules/` from builder. Runs under unprivileged user `node` (UID 1000).

### 5.2 Proposed Dockerfile Specification
```dockerfile
# Stage 1: Build & Compile TypeScript
FROM node:20-alpine AS builder

WORKDIR /app

# Install native compilation dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Prune development dependencies
RUN npm prune --production

# Stage 2: Production Execution Image
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Copy node_modules and built code from builder stage
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Create persistent storage directory with proper permissions
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/index.js"]
```

### 5.3 `.dockerignore` Specification
```dockerfile
node_modules
dist
coverage
.git
.agents
tests
*.log
.env
.DS_Store
```

---

## 6. DigitalOcean Kubernetes Service (DOKS) Deployment Specification

### 6.1 Kubernetes Resources Required

1. **Deployment (`deploy/k8s/deployment.yaml`)**
   * **Replicas:** 2 (for HA load distribution).
   * **Strategy:** RollingUpdate (`maxSurge: 1`, `maxUnavailable: 0`).
   * **SecurityContext:**
     ```yaml
     securityContext:
       runAsNonRoot: true
       runAsUser: 1000
       runAsGroup: 1000
       fsGroup: 1000
     ```
   * **Resource Limits & Requests:**
     ```yaml
     resources:
       requests:
         cpu: 100m
         memory: 128Mi
       limits:
         cpu: 500m
         memory: 512Mi
     ```
   * **Environment Variables:** Loaded via `envFrom` referencing `ConfigMap` and `Secret`.

2. **Service (`deploy/k8s/service.yaml`)**
   * **Type:** `ClusterIP`
   * **Port:** 80 -> targetPort `http` (3000).

3. **Ingress (`deploy/k8s/ingress.yaml`)**
   * **Annotations:** DigitalOcean Ingress / NGINX Ingress controller annotations, cert-manager Let's Encrypt TLS annotations.
   * **Hosts:** `ct-review-bot.yourdomain.com` routing paths `/webhook` and `/api/webhook/github`.

4. **ConfigMap (`deploy/k8s/configmap.yaml`)**
   * Contains `PORT: "3000"`, `HOST: "0.0.0.0"`, `LOG_LEVEL: "info"`, `OMNIROUTE_BASE_URL: "http://omniroute-service.default.svc.cluster.local:9090"`, `CT_REVIEW_DB_PATH: "/app/data/pr_state.db"`.
   * Optionally embeds default `.ct-review.yaml` and `CONSTITUTION.md`.

5. **Secret (`deploy/k8s/secret.yaml`)**
   * Encrypted/Base64 credentials for `WEBHOOK_SECRET`, `GITHUB_TOKEN`, `CT_SECRET_MASTER_KEY`, `CT_SECRET_SALT`.

6. **PersistentVolumeClaim / Persistence Strategy**
   * If SQLite persistence is desired across pod lifecycle restarts, mount a ReadWriteOnce PVC at `/app/data`. Note: SQLite file locking works best on a single pod instance. For multi-replica deployments, SQLite storage can either use stateless `:memory:` / JSON sync, or be backed by a persistent volume per pod / shared external DB if scaled out.

---

## 7. Actionable Recommendations & Proposed Changes

1. **Modify `src/index.ts`:** Update `app.listen(PORT, '127.0.0.1')` to `app.listen(PORT, HOST)` where `HOST = process.env.HOST || '0.0.0.0'`.
2. **Create Docker artifacts:**
   - Write multi-stage `Dockerfile` in project root.
   - Write `.dockerignore` in project root.
3. **Create Kubernetes manifests in `deploy/k8s/` or Helm chart in `deploy/helm/`:**
   - ConfigMap (`configmap.yaml`)
   - Secret template (`secret.yaml`)
   - Deployment (`deployment.yaml`)
   - Service (`service.yaml`)
   - Ingress (`ingress.yaml`)
4. **Add Docker & Deployment Scripts:**
   - Add `npm run docker:build` and `npm run docker:run` scripts to `package.json` for developer workflow ease.

---
