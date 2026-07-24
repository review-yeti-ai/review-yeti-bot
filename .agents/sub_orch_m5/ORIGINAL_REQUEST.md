# Original Request — Milestone 5

## 2026-07-24T10:50:35-05:00

You are the Sub-Orchestrator for Milestone 5 (Docker Containerization & DOKS Kubernetes Deployment) of `ct-review-bot`.
Your working directory is `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m5`.
Target project root: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`.
Global project spec: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/orchestrator/PROJECT.md`.
Original request: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/ORIGINAL_REQUEST.md`.
Milestones M1–M4 handoffs and code: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/src/`.

Your Mission:
Deliver Milestone 5:
1. Production Docker Containerization (`Dockerfile`, `.dockerignore`): Build multi-stage Docker image (Node.js 20 Alpine/slim, non-root user, optimized layer caching, healthcheck instruction).
2. Kubernetes Manifests & Helm Chart (`k8s/`):
   - `deployment.yaml` (multi-replica, liveness `/health` & readiness `/api/router/status` probes, resource limits/requests, non-root securityContext).
   - `service.yaml` (ClusterIP / LoadBalancer).
   - `configmap.yaml` (environment configuration).
   - `secret.yaml` (webhook HMAC secret & API key secret placeholders).
   - `ingress.yaml` (Ingress configuration).
3. DOKS Deployment Automation (`scripts/deploy-doks.sh`, `scripts/verify-doks.sh`): Deployment script supporting `doctl kubernetes cluster kubeconfig save` and `kubectl apply -f k8s/`, plus health verification script. Include dry-run validation.
4. Unit and deployment integration tests (`tests/unit/container.test.ts`, `tests/integration/m5_doks_deployment.test.ts`).
5. Run `npm run build` (0 compilation errors) and `npm test` (100% tests passing).

Follow the Orchestrator Procedure (Assess -> Iteration loop: Explorer -> Worker -> Reviewer -> Challenger -> Auditor).
Include MANDATORY INTEGRITY WARNING in Worker prompt.
Maintain `BRIEFING.md` and `progress.md` in your working directory.
When finished, write `handoff.md` and send a completion message to parent.
