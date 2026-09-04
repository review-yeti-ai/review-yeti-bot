# DigitalOcean Kubernetes (DOKS) Review Operations

This guide covers operational management and cluster verification for running Review Yeti on **DigitalOcean Kubernetes (DOKS)**.

For the general architecture, async dispatch handshake, and cost analysis across any Kubernetes cluster, see the [Kubernetes & DOKS Execution Mode Guide](KUBERNETES_MODE.md).

---

## 🛠️ Installing the Runtime

From your Review Yeti repository checkout with `kubectl` configured for your target DOKS cluster:

```bash
# Set your container image registries and cluster network endpoints
REVIEW_OPERATOR_IMAGE='registry.example.com/review-yeti/operator@sha256:<digest>' \
REVIEW_DISPATCHER_IMAGE='registry.example.com/review-yeti/dispatcher@sha256:<digest>' \
REVIEW_WORKER_IMAGE='registry.example.com/review-yeti/worker@sha256:<digest>' \
KUBERNETES_SERVICE_IP='<service-ip>' \
KUBERNETES_API_ENDPOINT_CIDR='<control-plane-cidr>' \
scripts/install-doks-review-runtime.sh
```

The installer verifies:
- Immutable container digests (`sha256:...`).
- Least-privilege RBAC definitions in an isolated namespace.
- Application of the `review-yeti.ai/v1alpha2` Custom Resource Definition (CRD).

---

## 📋 Operational Verification & Qualification Order

To verify your cluster deployment before rolling out to production repositories:

1. **Verify CRD & Namespaces**:
   ```bash
   kubectl get crd | grep prreviewjobs
   kubectl get pods -n review-yeti-system
   ```
2. **Run a Receipt-Only Worker Test**:
   Execute one receipt-only worker with `publicationMode=disabled` to verify container startup, git access, and network egress without making live model calls or writing to GitHub.
3. **Run Single Deterministic Review**:
   Execute a manual review against a known sample PR diff fixture and verify that persona evaluations complete and output valid JSON.
4. **End-to-End Validation**:
   Dispatch a test review from a GitHub Actions workflow using `execution-backend: doks` and verify:
   - Initial check run appears as `review-status: DISPATCHED`, `gate-decision: PENDING`.
   - GitHub Actions runner exits in under 10 seconds.
   - Worker pod schedules on the DOKS cluster and processes the diff.
   - Worker updates the check run to `success` or `failure` and posts the consolidated review comment.
