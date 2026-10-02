# 0001. Organization-neutral functional identifiers

Status: proposed (REL-1282). Nothing in this ADR has been executed.

## Context

This repository is public and independent of the organization that deploys it. Its tracked tree named that
organization (`<org>`) and its private repositories in prose, fixtures, tests and defaults. Phase 1 removed
every reference that is only text (docs, comments, license headers, eval baselines, fixtures, tests) and added
`tests/unit/publicAnonymityAudit.test.ts`, which scans the whole tracked tree and fails on any reference outside
`tests/fixtures/public-anonymity-allowlist.json`.

What remains in the allowlist is not text: it is identifiers that running systems depend on, plus tests and
fixtures that assert them. A search-and-replace would change behavior, so each needs a migration.

## Decision

Migrate the functional identifiers in the order below, one pull request per step, each shrinking the allowlist.
The allowlist is a ratchet: it may only shrink, and an entry must be deleted when its file reaches zero.

| # | Identifier | Where | Runtime impact | Migration |
|---|---|---|---|---|
| 1 | Go module path `github.com/<org>/ct-review-bot/k8s-operator` | `k8s-operator/go.mod`, every Go import, `tests/support/operatorGoFailureReceipt.ts` | None at runtime (compiled in). No external module consumers (no forks, no importers). | Rename to `github.com/review-yeti-ai/review-yeti-bot/k8s-operator` in one mechanical change; run `go build ./... && go test ./...` and the Go-suite wrapper test. Do this first: it removes about a third of the allowlist. |
| 2 | Legacy CRD group `review.<org>.com` (v1alpha1) and annotation key `ct.review.<org>.com/active-slots` | `k8s-operator/api/v1alpha1`, `config/crd/bases/review.<org>.com_prreviewjobs.yaml`, capacity ledger | The live cluster serves only the `review-yeti.ai` group (checked with `kubectl get crd`); the legacy group is not installed. The annotation key is written on live capacity-ledger objects. | (a) Verify no `review.<org>.com` CRs exist in any cluster, then delete the v1alpha1 package, its CRD file and tests. (b) For the annotation key: read both old and new keys for one release, write the new key, then drop the old read. |
| 3 | Registry allowlists `registry.digitalocean.com/<org>/...` and the image pull Secret named after the organization | `scripts/*review*.sh`, `scripts/lib/review-runtime-image-provenance.sh`, `k8s/*.tpl` | Deploy-time validation only. Production pulls public GHCR images. | Remove the legacy registry alternatives from the regexes and the pull-secret references once the deployment repository no longer uses them (coordinate with the deployer; images are public). |
| 4 | Default service URLs (`action.yml` `doks-dispatch-url`, `.github/workflows/review-bot.yaml`, `scripts/dispatch-doks-action.mjs`, `scripts/verify-*.sh`, `cf-orchestrator/wrangler.toml`, `reviewJobWorkflow`) | action defaults, scripts, edge worker config | Consumers that omit the input use the default endpoint. | Make the endpoint a required input / explicit environment value with no organization default; announce, warn for one release when the default is used, then remove. Deployers set the value in their own config. |
| 5 | CORS/MCP origin allowlist and default owner/repo in `cf-orchestrator` tool schemas | `cf-orchestrator/src/mcp/**` | MCP clients that omit `owner`/`repo` rely on the defaults; browsers on the deployer's origin rely on the allowlist. | Read origins from configuration (empty default); make `owner`/`repo` required or neutral placeholders; update the coupled tests. |
| 6 | Dashboard demo defaults and placeholders | `src/app/**`, `src/components/**`, `src/api/**` | Cosmetic (placeholders, sample data); sample repositories shown when no data exists. | Replace with neutral placeholders; regenerate the static export. |
| 7 | Committed static export `public/**`, `legacy_public/**` | build output tracked in git | Served assets. | Stop tracking generated output (build in CI/image), then delete the entries. |
| 8 | Digest-pinned fixtures and cassettes coupled to the identifiers above | `tests/fixtures/cassettes`, `tests/fixtures/review-yeti/rank2a-*`, selected tests/support | Test-only. Request fingerprints and normalized digests include the names. | Re-record or re-normalize after steps 1-6, in the same PRs, updating pinned digests with the reason in the commit message. |

## History

Removing the references from history is a separate, irreversible decision (force-push of a public repository) and
is covered by the dry-run report, not by this ADR. Whichever way it is decided, run the tree migration first,
or exclude the functional patterns from the history rewrite, otherwise the rewritten tip would differ from the
deployed code.

## Consequences

- The audit makes any new reference fail CI immediately.
- Steps 2-5 change what deployers must configure; each must ship with a deployer-facing note and be sequenced
  with the deployment repository.
- Until step 8, a handful of fixtures remain on the allowlist by design.

## Revisit

If an external consumer of the Go module or the action default is discovered, keep a compatibility alias for one
release before removing it.
