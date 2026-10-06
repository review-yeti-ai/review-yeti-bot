# Contributing

## Commit identity

This repository is public and independent of the organizations that deploy it. Commits must carry a neutral
identity: run `scripts/use-neutral-git-identity.sh` once in every clone or worktree. Pull requests are checked by
`scripts/ci/audit-commit-metadata.mjs`, which rejects commits whose author, committer or message names a deploying
organization or one of its private repositories. A squash merge records the pull request author's identity and a rebase merge by a person records that person as the
committer, so merging with a personal or shared account puts that identity into the history. Merge with an identity that
is itself neutral. The review GitHub App would be that identity, but it is not installed on this repository yet (an
organization owner has to install it with contents and pull-request write access); until then, merges by a person
must be followed by a metadata cleanup of the resulting commits.

## Tree hygiene

`tests/unit/publicAnonymityAudit.test.ts` fails on any tracked file that names a deploying organization or its
private repositories. Deployment-specific values (hostnames, repositories, origins) are configuration supplied by the
deployer, never constants in this repository.
