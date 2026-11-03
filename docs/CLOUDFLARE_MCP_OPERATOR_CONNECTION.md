# Cloudflare MCP operator connection

## Canonical credential source and Worker projection

The deployment workflow reads only `REVIEW_YETI_MCP_AUTH_TOKEN` from a credential-only Doppler
service configuration and projects it into the same-named Cloudflare Worker secret before the
normal Worker deployment. Doppler is the canonical source for this operator credential.

Configure these values in the repository's existing CI configuration stores:

| Name | Store | Purpose |
| --- | --- | --- |
| `REVIEW_YETI_DOPPLER_TOKEN` | CI secret | Scoped read access to the selected Doppler config |
| `REVIEW_YETI_DOPPLER_PROJECT` | CI variable | Doppler project selector |
| `REVIEW_YETI_DOPPLER_CONFIG` | CI variable | Credential-only Doppler config selector |
| `CLOUDFLARE_API_TOKEN` | Existing CI secret | Cloudflare Worker secret update and deployment API access |
| `CLOUDFLARE_ACCOUNT_ID` | Existing CI secret | Cloudflare account selector |

The Doppler service credential and Cloudflare deployment credential have separate roles. Keep the
Doppler config limited to the one operator token; the sync script requests that key by name from the
Doppler secret endpoint and sends one `secret_text` binding to the Worker secrets API. It reads the
Worker name from `cf-orchestrator/wrangler.toml`. It does not download the full Doppler config,
write the fetched value to a file, or include it in process arguments or logs. Requests have a
10-second timeout, a 16 KiB response limit, and redirects are rejected. Missing inputs, provider
errors, malformed responses, and an empty token stop the workflow before the deployment step.

The Cloudflare API token needs the `Workers Scripts Write` permission required by the single-secret
endpoint, alongside the permissions already used by the Wrangler deployment action.

The existing Wrangler deployment remains the source for Worker code, variables, and route/domain
configuration. The projection step updates only the named Worker secret binding.

## Authenticated connection check

Send a `GET` request to either `/api/mcp/auth` or `/mcp/auth` with the operator bearer token:

```http
GET /api/mcp/auth
Authorization: Bearer <operator-token>
```

A valid token receives HTTP 200 with:

```json
{"authenticated":true,"service":"review-yeti","transport":"cloudflare"}
```

Missing or invalid credentials receive HTTP 401, including when `PUBLIC_READ_MCP=true`. The route
does not run a review, publish a result, or return token bytes, a token hash, or caller identity.
Other methods receive HTTP 405.

`GET /api/mcp` and `GET /mcp` continue to expose public MCP server metadata and the tool catalog.
That public discovery response does not validate credentials. Use the dedicated authenticated
health route to check operator connection authentication; do not use a review or publication action
as a connectivity probe.
