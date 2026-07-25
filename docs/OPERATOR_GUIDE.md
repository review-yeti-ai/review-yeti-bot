# Operator & Deployment Guide — ct-review-bot

## 1. Overview
`ct-review-bot` runs as a containerized microservice on DigitalOcean Kubernetes (DOKS `cluster-ny1`). It handles incoming GitHub webhook events, performs AST symbol & vector code indexing via the in-house `ct-indexer`, manages Context7 MCP integration via Doppler, and dispatches multi-persona quorum reviews.

---

## 2. Deployment Architecture
- **Cluster**: DigitalOcean Kubernetes (`cluster-ny1`)
- **Container Registry**: `registry.digitalocean.com/calltelemetry/ct-review-bot`
- **CI/CD Platform**: Blacksmith Runners (`blacksmith.sh`) with Docker Buildx `type=gha` layer caching.
- **Image Architecture**: Native `linux/amd64` multi-arch compilation.

---

## 3. Environment Variables & Secret Management

### Required Environment Secrets (`k8s/secret.yaml` / GitHub Secrets)
- `GITHUB_APP_ID`: `4385771`
- `GITHUB_APP_CLIENT_ID`: `Iv23liHmE9qxSkdvGMMJ`
- `GITHUB_APP_CLIENT_SECRET`: Managed in Doppler / GitHub Secrets
- `GITHUB_APP_PRIVATE_KEY`: RSA 2048-bit Private Key for RS256 JWT signing
- `GITHUB_WEBHOOK_SECRET`: HMAC SHA-256 webhook signature validation key
- `DOPPLER_TOKEN`: Service token for dynamic secret routing (`CONTEXT7_API_KEY`)

---

## 4. In-House Code Indexer & Memory Storage (`ct-indexer`)
- **AST Indexer**: Tree-sitter parser extracting classes, functions, interfaces, imports, and call graphs.
- **Database**: SQLite WAL mode database (`data/symbol_graph.db` and `.ct-memory/pr_memory.sqlite`).
- **Memory API Endpoints**:
  - `POST /api/memory/query`: Query past review findings and resolved nit patterns.
  - `GET /api/code/symbol-graph`: Fetch caller/callee AST graph node trees.
  - `POST /api/code/search`: Semantic vector & keyword code search across indexed repos.

---

## 5. Verification & Health Monitoring

Run `scripts/verify-doks.sh` to execute live cluster readiness checks:

```bash
# Verify DOKS pod status, readiness probes, and ingress routing
./scripts/verify-doks.sh
```

Checks performed:
- `1/1 READY Running` status on `ct-review-bot` pods.
- HTTP 200 responses on `/health`, `/ready`, and `/api/router/status`.
- HMAC signature verification on `/webhook` routes.
