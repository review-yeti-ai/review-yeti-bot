# Contributing

## Commit identity

Personal, organization, shared-account, and bot identities are welcome as authors, committers, co-authors,
and merge actors. GitHub may record the merging account's name and email in the commit metadata; this is
normal attribution and does not require anonymization or a history rewrite.

`scripts/use-neutral-git-identity.sh` remains an optional convenience for contributors who prefer that identity.
`scripts/ci/audit-commit-metadata.mjs` checks commit subjects and narrative bodies for private deployment details.
It permits contributor names and emails in identity fields and trailing `Co-authored-by` credits.
Keep private repository names, deployment configuration, credentials, and operational details out of commit
subjects, narrative bodies, pull request descriptions, and tracked files.

## Tree hygiene

`tests/unit/publicAnonymityAudit.test.ts` fails on any tracked file that names a deploying organization or its
private repositories. Deployment-specific values (hostnames, repositories, origins) are configuration supplied by the
deployer, never constants in this repository.
