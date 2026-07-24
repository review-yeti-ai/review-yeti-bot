## 2026-07-24T15:53:18Z
<USER_REQUEST>
You are the Worker for Milestone 5 (Docker Containerization & DOKS Deployment).
Working directory: /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_m5_1
Target project root: /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Mission:
Implement all components of Milestone 5:

1. **Source Fix (`src/index.ts`)**:
   Update `src/index.ts` line 11 so that `app.listen` binds to `process.env.HOST || '0.0.0.0'` instead of strictly hardcoding `'127.0.0.1'`. Verify that existing tests continue to pass.

2. **Production Docker Containerization (`Dockerfile`, `.dockerignore`)**:
   - Create `Dockerfile` at project root:
     - Multi-stage build (Stage 1: `builder`, Stage 2: `runner`).
     - Base image: `node:20-alpine`.
     - In `builder`: install build tools (`python3 make g++`), copy `package.json` & `package-lock.json`, run `npm ci`, copy `src/` & `tsconfig.json`, run `npm run build`, prune devDependencies (`npm prune --production`).
     - In `runner`: set `WORKDIR /app`, copy `package.json`, production `node_modules`, and compiled `dist/` from `builder`.
     - Set non-root security: `USER node` and `COPY --chown=node:node`.
     - `EXPOSE 3000`.
     - `HEALTHCHECK`: `--interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"`
     - `CMD ["node", "dist/index.js"]`.
   - Create `.dockerignore` at project root:
     - Ignore `node_modules`, `dist`, `coverage`, `.git`, `.agents`, `.env`, `tests`, `*.log`, `tmp`, `Dockerfile`, `.dockerignore`, `.gitignore`, `README.md`.

3. **Kubernetes Manifests & Helm Chart (`k8s/`)**:
   Create directory `k8s/` containing:
   - `k8s/deployment.yaml`: Deployment with 2 replicas, selector `app: ct-review-bot`, strategy `RollingUpdate`, container `ct-review-bot` on port 3000, `securityContext` (`runAsNonRoot: true`, `runAsUser: 10001`, `allowPrivilegeEscalation: false`, `capabilities: drop: ["ALL"]`), `livenessProbe` (httpGet `/health` port 3000, initialDelaySeconds 10, periodSeconds 15), `readinessProbe` (httpGet `/api/router/status` port 3000, initialDelaySeconds 5, periodSeconds 10), `resources` (requests: cpu 250m, memory 512Mi; limits: cpu 1000m, memory 1Gi), `envFrom` referring to ConfigMap `ct-review-bot-config` and Secret `ct-review-bot-secret`, volume mount for `/app/data` using `emptyDir`.
   - `k8s/service.yaml`: Service `ct-review-bot-service`, type `ClusterIP`, port 3000, targetPort 3000, selector `app: ct-review-bot`.
   - `k8s/configmap.yaml`: ConfigMap `ct-review-bot-config` with data (`PORT: "3000"`, `HOST: "0.0.0.0"`, `NODE_ENV: "production"`, `LOG_LEVEL: "info"`, `OMNIROUTE_BASE_URL: "http://omniroute-service.default.svc.cluster.local:9090"`, `CT_REVIEW_DB_PATH: "/app/data/pr_states.sqlite"`).
   - `k8s/secret.yaml`: Secret `ct-review-bot-secret` (Opaque) with placeholder base64/stringData entries for `WEBHOOK_SECRET`, `GITHUB_TOKEN`, `CT_SECRET_SALT`, `CT_SECRET_MASTER_KEY`.
   - `k8s/ingress.yaml`: Ingress `ct-review-bot-ingress` with annotations (`kubernetes.io/ingress.class: nginx`), rule for host routing traffic to `ct-review-bot-service` port 3000.

4. **DOKS Deployment Automation (`scripts/deploy-doks.sh`, `scripts/verify-doks.sh`)**:
   Create directory `scripts/` containing:
   - `scripts/deploy-doks.sh`: Shell script (chmod +x) accepting optional flags `--dry-run`, `--skip-doctl`, `--cluster-name <name>`. Performs `doctl kubernetes cluster kubeconfig save <cluster-name>` (unless `--skip-doctl` or `--dry-run`), dry-run validation (`kubectl apply --dry-run=client -f k8s/`), and manifest application (`kubectl apply -f k8s/`). Handles error conditions gracefully.
   - `scripts/verify-doks.sh`: Shell script (chmod +x) accepting optional `--mock` or `--dry-run` flag. Checks deployment rollout status (`kubectl rollout status deployment/ct-review-bot`), verifies pod securityContext, and tests `/health` and `/api/router/status` endpoint responses.

5. **Unit and Deployment Integration Tests (`tests/unit/container.test.ts`, `tests/integration/m5_doks_deployment.test.ts`)**:
   - `tests/unit/container.test.ts`: Vitest test suite reading `Dockerfile` and `.dockerignore` using `fs.readFileSync`. Asserts multi-stage build, base image `node:20-alpine`, non-root user `USER node`, `HEALTHCHECK` with `/health`, `EXPOSE 3000`, `CMD ["node", "dist/index.js"]`, `.dockerignore` exclusions.
   - `tests/integration/m5_doks_deployment.test.ts`: Vitest test suite using `js-yaml` to parse `k8s/*.yaml` manifests and validate structure, `securityContext`, `livenessProbe` `/health`, `readinessProbe` `/api/router/status`, `resources`, `service` targetPort, `configmap` keys, `ingress` paths. Also tests `scripts/deploy-doks.sh --dry-run` execution using `child_process.execSync`.

6. **Compilation and Full Test Suite Execution**:
   - Run `npm run build` and ensure 0 compilation errors.
   - Run `npm test` and ensure 100% tests pass (both existing unit/integration/e2e and new M5 tests).

Document your changes and build/test results in your handoff report at `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_m5_1/handoff.md`.
Send a message when finished referencing the path to your handoff report.
</USER_REQUEST>
