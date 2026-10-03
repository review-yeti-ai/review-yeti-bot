#!/usr/bin/env bash
# Sets a repository-local, organization-neutral commit identity. Run once in every clone or worktree used to
# contribute to this repository; the CI metadata audit rejects commits that carry an organization identity.
set -euo pipefail
git config --local user.name "Review Yeti Maintainers"
git config --local user.email "maintainers@users.noreply.github.com"
echo "commit identity set to: $(git config --local user.name) <$(git config --local user.email)>"
