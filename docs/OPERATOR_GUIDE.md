# Operator guide

## Deployment

CI builds bot and OmniRoute images, captures their registry digests, creates
runtime secrets from managed GitHub secrets, and runs
`scripts/deploy-doks.sh`. The deploy script rejects tag-only images.

OmniRoute provider state is intentionally not stored in Git. Seed or restore
the `data-omniroute-0` volume through the encrypted OmniRoute backup/restore
procedure, then restart the StatefulSet. `/ready` remains unavailable until all
four exact routes appear in OmniRoute's model catalog.

## Verification

Run `scripts/verify-doks.sh`. It checks:

- OmniRoute and bot rollouts;
- both workload images are digest-pinned;
- services, ingress, and PVC state;
- public `/health` and dependency-aware `/ready`.

For a PR, compare every review/check to the exact head SHA. There must be one
`COMMENT` review per completed persona and only the arbiter may publish
`APPROVE` or `REQUEST_CHANGES`.

Infrastructure, parsing, required-lane, moderator, arbiter, or quorum failures
must leave a failed check and an infrastructure comment. They are not code
verdicts.
