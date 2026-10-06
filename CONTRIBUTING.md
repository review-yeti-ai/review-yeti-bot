# Contributing

## Commit identity

This repository is public and independent of the organizations that deploy it. Commits must carry a neutral
identity: run `scripts/use-neutral-git-identity.sh` once in every clone or worktree. Pull requests are checked by
`scripts/ci/audit-commit-metadata.mjs`, which rejects commits whose author, committer or message names a deploying
organization or one of its private repositories. Merge pull requests with the **Merge a pull request as the GitHub App** workflow
(`.github/workflows/merge-pr-as-app.yml`, rebase method): a squash merge records the pull request author's identity and a
rebase merge by a person records that person as the committer, so merging with a personal or shared account puts that
identity into the history.

## Tree hygiene

`tests/unit/publicAnonymityAudit.test.ts` fails on any tracked file that names a deploying organization or its
private repositories. Deployment-specific values (hostnames, repositories, origins) are configuration supplied by the
deployer, never constants in this repository.
