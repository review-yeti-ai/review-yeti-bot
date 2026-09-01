# DOKS Review Operations

The DOKS review runtime is an opt-in qualification path. The central GitHub
Action remains the production review authority until the manual qualification
gates in the dispatch plan are approved.

## Install the inert runtime

Run this from an exact Review Yeti release checkout with `kubectl` pointed at
the intended DOKS cluster:

```bash
CT_REVIEW_OPERATOR_IMAGE='registry.digitalocean.com/calltelemetry/review-yeti-operator@sha256:<64-hex>' \
CT_REVIEW_JOB_DISPATCHER_IMAGE='registry.digitalocean.com/calltelemetry/ct-review-bot@sha256:<64-hex>' \
CT_REVIEW_WORKER_IMAGE='registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:<64-hex>' \
KUBERNETES_SERVICE_IP='<service-ip>' \
KUBERNETES_API_ENDPOINT_CIDR='<translated-control-plane-cidr>' \
KUBERNETES_API_CIDR='<public-control-plane-cidr>' \
scripts/install-doks-review-runtime.sh
```

The installer refuses mutable or untrusted images, broad default CIDRs, an
already-active operator or dispatcher, and an incomplete dispatcher database
secret. It applies only the namespaced `review-yeti.ai/v1alpha2` CRD and
least-privilege manifests. Both Deployments must remain at `replicas: 0`.

This command does not scale workloads, create a review Job, call a provider,
write to GitHub, or enable App-gate publication. A later qualification command
must be separately reviewed and must retain the original 15-minute deadline.

## Qualification order

1. Verify the CRD and inert Deployments in the isolated namespace.
2. Run one receipt-only worker with `publicationMode=disabled`; require zero
   provider calls and zero GitHub writes.
3. Run one manual non-publishing provider review on a deterministic fixture.
4. Compare the same PR head through DOKS and the hosted Action, recording
   terminal status, stage timings, provider usage/cost, CPU/memory, and PVC
   reuse.
5. Collect the planned warm/reused, warm/new-workspace, and cold-node samples
   before requesting any production activation decision.

No scheduled canary or automatic traffic split is part of this path.
