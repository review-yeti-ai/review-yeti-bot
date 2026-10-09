# 0003. Cloudflare-native Review Yeti operator and edge consolidation

Status: accepted and executed (REL-1616). See Outcome.

## Context

Review Yeti originally ran a hybrid topology:
1. An edge worker (`review-yeti-cf-orchestrator`) running authoritatively as `"Review Yeti"`.
2. A cluster fallback operator and companion control-plane services in Kubernetes:
   - Action dispatch admission (`/api/dispatch/action`)
   - Job dispatcher and Kubernetes CRD controller (`prreviewjobs.review-yeti.ai`)
   - Server-Sent Events (SSE) live review status streaming
   - Mutating MCP server
   - Dedicated cluster quota: 3,328 MiB memory limit and 775m CPU limit for control plane, plus 8,704 MiB memory limit and 850m CPU for worker jobs.

Following 100 consecutive matches in shadow parity, ADR 0822 scaled down the fallback worker operator to 0 replicas. However, four companion services remained on Kubernetes, consuming quota, requiring certificate rotation, and maintaining operational state across two compute planes.

## Decision

Consolidate 100% of review admission, orchestration, gatekeeping, and tool serving into a Cloudflare-native serverless architecture directly within Review Yeti:

1. **Edge GitHub Actions OIDC Admission**:
   - Implement `POST /api/dispatch/action` in `cf-orchestrator` verifying GitHub Actions OIDC tokens using Web Crypto against GitHub's public JWKS.
   - Enforce cryptographic validation of token issuer, audience, and repository identity assertions with fail-closed receipts.

2. **Authoritative Edge App Publisher**:
   - Generate GitHub App JWTs via Web Crypto RS256 with secrets in Cloudflare Secrets storage.
   - Cache installation tokens in Cloudflare KV with bounded TTLs.
   - Direct publication of GitHub Checks and sticky pull request review summary comments.

3. **Concurrency & Gatekeeping in Durable Objects**:
   - `RepoGateDO` coordinates repository serialization, active concurrency budgets, and dynamic passthrough flags without database round-trips.
   - `ReviewRunDO` manages lifecycle states, finding persistence, and signed gate attestations.

4. **Unified Native MCP Server**:
   - Expose mutating tools (`review_yeti_attest_pr_gate`, `review_yeti_trigger_review`, `review_yeti_dispute_finding`) directly on edge worker endpoints (`/api/mcp` and `/mcp`) alongside read-only analytics and observability tools.

5. **Edge Ingress Cutover & Kubernetes Decommission**:
   - Cut over edge DNS and ingress routing to direct 100% of traffic to the Cloudflare Edge Worker.
   - Configure edge WAF skip rules for machine callbacks.
   - Decommission the legacy Kubernetes review system namespace and reclaim all cluster quota.

## Consequences

- **Zero Operational Dependence on Kubernetes**: All review operations run serverlessly on Cloudflare Workers, Durable Objects, Workflows, D1, and KV.
- **Zero GCP Resources**: Entire platform runs on Cloudflare Edge with runners executing on supported serverless or container platforms.
- **Cluster Headroom**: 3,328 MiB of memory limit and 775m CPU control-plane quota reclaimed, plus 8,704 MiB worker quota eliminated from the cluster.
- **Unified Surface**: A single endpoint serves API, webhooks, live state, and MCP clients.

## Outcome

Phases 1 through 5 executed and completed under REL-1616:
- Phase 1: Edge OIDC Action Dispatch landed in PR #1477.
- Phase 2: Authoritative Edge App Publisher landed in PR #1478.
- Phase 3: Unified Edge MCP Server landed in PR #1480.
- Phase 4: DNS, Ingress Cutover, and WAF rules verified live at edge in PR #1482 and PR #1484.
- Phase 5: Kubernetes namespace decommissioned, cluster quota reclaimed, and GitOps overlays updated.
