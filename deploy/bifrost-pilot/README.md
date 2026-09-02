# Bifrost internal pilot

This directory owns the lean, single-writer Bifrost qualification deployment
for exampleorg internal LLM traffic. It does not change the current Review
Yeti provider route by itself.

## Fixed pilot shape

- namespace: `ct-llm-gateway`
- Helm chart: `bifrost/bifrost` `2.1.37`
- application: Bifrost `v1.5.13`, pinned to the Linux AMD64 image digest
- topology: one replica, no HPA, `Recreate` rollout
- resources: 500m CPU/512Mi requested, 1 CPU/1Gi limited
- namespace quota: the workload envelope plus 100m CPU/128Mi memory headroom
  for one transient cert-manager HTTP-01 solver during certificate renewal
- state: existing DigitalOcean managed PostgreSQL, dedicated
  `bifrost_gateway` database and user
- provider: Ollama Cloud only, ten active requests and a 100-request buffer
- content: prompt and response logging disabled
- dependencies: no embedded PostgreSQL, PVC, Redis/Valkey, vector store, or
  bundled monitoring stack

`Recreate` is intentional. OSS Bifrost keeps provider, budget, and governance
state in memory and does not support correct multi-node synchronization. A
rolling surge would briefly create two independent admission owners and could
exceed Ollama's ten-request entitlement.

## Required secret contract

Create a `bifrost-runtime` secret in `ct-llm-gateway` with exactly these keys:

| Key | Source | Purpose |
| --- | --- | --- |
| `ollama-api-key` | Rotated Ollama API key in the gateway's Doppler project | Upstream provider authentication |
| `postgres-password` | Dedicated managed PostgreSQL user | Bifrost config and metadata stores |
| `encryption-key` | Random gateway-only value | Encryption of sensitive Bifrost state |
| `setup-token` | Random gateway-only value | First-admin bootstrap |
| `admin-username` | Gateway operator identity | Management API and UI authentication |
| `admin-password` | Random gateway-only value | Management API and UI authentication |

Never put these values in this repository, a calling repository, Helm values,
command output, or a GitHub Actions artifact. The operator-designated Ollama
credential is held only in the restricted gateway Doppler config and is
materialized into the runtime secret by the guarded deployment path.

The Doppler `ct-llm-gateway/prd` config uses these source names:

| Doppler name | Kubernetes Secret key |
| --- | --- |
| `OLLAMA_API_KEY` | `ollama-api-key` |
| `BIFROST_POSTGRES_PASSWORD` | `postgres-password` |
| `BIFROST_ENCRYPTION_KEY` | `encryption-key` |
| `BIFROST_SETUP_TOKEN` | `setup-token` |
| `BIFROST_ADMIN_USERNAME` | `admin-username` |
| `BIFROST_ADMIN_PASSWORD` | `admin-password` |

## Render and validate

```bash
helm repo add bifrost https://maximhq.github.io/bifrost/helm-charts --force-update
helm repo update bifrost
scripts/bifrost-pilot-contract.test.sh
```

The contract test validates the values against the pinned chart, renders the
full manifest, and rejects changes that add a second replica, a rolling surge,
persistent volumes, embedded state services, a provider other than Ollama,
content logging, direct provider keys, or a resource request above the approved
pilot envelope. Namespace quota is intentionally slightly larger than the
Bifrost workload envelope so cert-manager can solve or renew the ingress
certificate without preventing a `Recreate` replacement pod from starting.

## Bootstrap sequence

1. Create the dedicated `bifrost_gateway` database and `bifrost_gateway` user.
2. Create the `ct-llm-gateway` Doppler project and `prd` config.
3. Insert the six required secrets directly into Doppler with restricted
   visibility.
4. Materialize `bifrost-runtime` from Doppler without printing its contents.
5. Apply `namespace.yaml`.
6. Install the pinned chart with `values.yaml`.
7. Point a DNS-only `A` record for `llm-gateway.example.com` at the live
   external address of the `ct-dev/ingress-haproxy-admin-lb` service, and wait
   for the certificate to become ready. Resolve the service directly; an
   ingress object's cached status address can be stale.
8. Use an authenticated port-forward to create the first virtual key. Create a
   separate key for Review Yeti and each workstation/service; never share them.
9. Store only the Review Yeti virtual key as a secret in
   `exampleorg/example-review-actions`.
10. Run protocol, budget, cancellation, restart, and 20-request/ten-slot load
   qualification before changing the central provider route.

After review, the guarded operator entry point performs steps 4-6:

```bash
DEPLOY_BIFROST_PILOT=YES scripts/deploy-bifrost-pilot.sh
```

It refuses every Kubernetes context except `do-nyc1-cluster-ny1`. Restricted
Doppler values are read with either an explicitly supplied, config-scoped
`DOPPLER_TOKEN` or a 15-minute read-only service token minted by the operator
and revoked on exit. The token is passed only through process environment. The
secret materializer sends base64 data between processes on stdin; it does not
write a secret file or place secret values in command arguments.

The public ingress exposes only `/v1`; management paths remain cluster-local.
Dashboard and management routes require Basic authentication. `/v1` does not
accept those admin credentials: inference requires the scoped Bifrost virtual
key, so OpenAI-compatible clients can use their virtual key as the standard
Bearer token without receiving a second shared credential.
Bifrost `v1.5.13` is the minimum supported pilot version because it fixes the
virtual-key inference rejection that occurs in `v1.5.12` when dashboard
password authentication is enabled.
The existing Prometheus deployment does not currently have a secret-aware
Bifrost scrape job. During qualification, inspect `/metrics` through an
authenticated port-forward. Production cutover requires a source-controlled
authenticated scrape or content-free OTel export.

## Budget qualification boundary

Bifrost supports virtual-key budgets and rate limits, but an already admitted
request may finish above its dollar limit. Ollama subscription calls must also
return usable cost data or receive an approved pricing override before a dollar
budget can be treated as meaningful. Until that is proven, enforce request,
token, model, and concurrency limits and report dollar budget status as
unqualified rather than zero-cost.

## Rollback

Keep Review Yeti on its existing route until qualification passes. If the pilot
fails, disable its virtual keys, remove the ingress route, and scale Bifrost to
zero. Do not restore or distribute upstream provider keys to consumer
repositories.
