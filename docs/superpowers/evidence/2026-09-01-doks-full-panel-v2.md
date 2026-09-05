# DOKS full-panel qualification v2 — 2026-09-01

Status: failed closed in the licensing persona. The DOKS pod, image pull,
OpenRouter stream, concurrency limiter, and bounded deadline all behaved as
designed. No review was published and no production workload was changed.

## Run contract

- Job: `ct-review-full-panel-3afd91f`
- Run: `run_3afd91f3cdc5320d55678c45b2272d53`
- Worker image: `registry.digitalocean.com/review-yeti/review-yeti-worker@sha256:d7166346c05554dd585f90e43ea1830b7f17aff0b2899bd103e7446ad860c2e7`
- Requested model: `deepseek/deepseek-v4-flash-0731`
- Qualification timeout: 780 seconds (195 seconds per request)
- Kubernetes Job deadline: 840 seconds
- Publication mode: `disabled`
- Service-account token: disabled
- Provider concurrency: three in-flight requests

## Result

The pod started on `workers-memory-8gb-3qb9f1`, pulled the digest-pinned image
in 2.846 seconds, and ran for about 142 seconds before the required licensing
lane failed closed:

`licensing PanelConfigurationError: persona licensing failed closed: qualification: invalid JSON inside nonce fence`

The Job ended with `BackoffLimitExceeded`. No aggregate receipt was written,
so the full-panel acceptance gate was not met. In particular, this run does
not prove six-persona completion, quorum, arbiter completion, or quality parity.

## Interpretation

This is a structured-output contract failure, not a DOKS scheduling, image,
credential, or connection timeout. The same worker reached the panel and
received a provider response; the licensing response remained unparsable after
the bounded correction behavior. Increasing the outer deadline or changing
provider concurrency would not address this failure.

The earlier GLM full-panel attempts failed on the per-request stream deadline,
while the DeepSeek attempts reached the panel and failed on persona response
contracts. The next safe enhancement is therefore a provider-independent,
strictly bounded structured-output strategy for persona lanes, followed by one
new manual non-publishing run. Do not activate the operator path or change
production routing until that run produces a complete sanitized receipt.

## Cleanup and production readback

The Job and Pod were deleted by exact name. No full-panel qualification Jobs or
Pods remain. Production remained unchanged:

- `ct-review-yeti-operator`: 1/1,
  `sha256:c976628f6afa0cdbe8907c806557b2677c92f44d206f8d6f81b6cfec3a226f09`
- `ct-review-job-dispatcher`: 1/1,
  `sha256:db2d14e07cf28ac11ba46fa391934e26805fb175f9aa69180a194ff7e2342e54`

## Remediation prepared after RCA

No second cluster run is claimed in this evidence record. The next worker
revision now sends provider-native `json_object` requests with the nonce inside
the object, propagates the DeepSeek-to-GLM fallback and provider routing policy
to every persona/moderator/arbiter call, and preserves per-attempt usage/cost
plus a sanitized failure receipt. OpenRouter failures also retain the
generation identifier and classified status for support correlation. Focused
regression coverage protects both request parity and fail-closed nonce
validation; a new digest-pinned manual run remains required for runtime proof.
