# Security policy

## Reporting a vulnerability

Report security vulnerabilities through **GitHub private vulnerability
reporting**, not a public issue:

1. Go to the [Security tab](https://github.com/review-yeti-ai/review-yeti-bot/security) of this
   repository.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected version/tag/SHA, and, if you have one, a minimal reproduction.

This opens a private advisory visible only to maintainers until a fix is ready, and lets us
coordinate a disclosure timeline and credit with you directly. Do not open a public issue or pull
request describing an unpatched vulnerability.

If GitHub private reporting is unavailable to you for any reason, open a regular issue asking a
maintainer to open a private channel — do not include exploit details in that issue.

## Supported versions

Only the latest `v1` release is supported with security fixes. `v1` receives security patches for
as long as it is the current major channel; see the maintenance-window policy in
[RELEASING.md](docs/RELEASING.md#versioning-policy) for what happens once a `v2` channel opens.

Pre-release (`v1-rc`) and exact-tag/SHA pins are supported on a best-effort basis: if you report a
vulnerability from an older exact-pinned tag, the fix ships in the next `v1.x.y` release and you
are responsible for bumping to it (or moving to the `@v1` floating channel — see
[README.md](README.md#install)).

## Scope

In scope: the Action runtime, the CLI (`reviewyeti`/`review-yeti`), the Pi/MCP adapter
(`src/pi/`), the release/tagging workflow, and this repository's GitHub Actions workflows
themselves. Out of scope: vulnerabilities in the OpenRouter API, GitHub itself, or third-party
provider models you route through your own API key — report those to the relevant vendor.

We treat provenance/verification bypass (an artifact that verifies with `gh attestation verify`
but did not come from this repository's release workflow), publication to the wrong pull request
or exact head, and disclosure of another repository's diff/prompt/API-key content as the highest
severity classes.
