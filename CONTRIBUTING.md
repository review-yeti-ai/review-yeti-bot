# Contributing

## Commit identity

This repository is public and independent of the organizations that deploy it. Commits must carry a neutral
identity: run `scripts/use-neutral-git-identity.sh` once in every clone or worktree. Pull requests are checked by
`scripts/ci/audit-commit-metadata.mjs`, which rejects commits whose author, committer or message names a deploying
organization or one of its private repositories. Pull requests should be opened and merged by an identity that is
itself neutral (for example a GitHub App); a squash merge records the pull request author's identity.

## Tree hygiene

`tests/unit/publicAnonymityAudit.test.ts` fails on any tracked file that names a deploying organization or its
private repositories. Deployment-specific values (hostnames, repositories, origins) are configuration supplied by the
deployer, never constants in this repository.
