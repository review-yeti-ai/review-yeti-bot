# Bounded full lockfile review

## Scope

Add an optional trusted-policy bound for complete raw lockfile review without
changing generic source truncation or the strict lockfile-only exemption.
Worker and authoritative completion share the prepared configuration value.
Legacy configurations omit the new field; explicit configuration changes the
bound configuration digest.

## Validation

- Node 24.21.0 focused Vitest: three files, 92 tests passed.
- TypeScript `tsc --noEmit` passed.
- Backend build and an expanded eleven-file applicability, caching, budget,
  map-reduce and authoritative-completion suite passed all 727 tests.
- Whitespace validation passed.
- Independent source review is a pre-publication gate; the PR and hosted
  exact-head results remain the authority for landing.

## Review follow-up

The native review at `50db5df` returned SHIP with two advisories. Full CI
also found an introduced privacy-ratchet failure in the new policy fixtures.
The fixtures now reuse the existing schema value; neither the privacy audit
nor its allowlist was weakened. The worker uses the shared cap resolver,
and a regression covers the new-package raw-restoration branch at the raised
cap and summary routing at the default boundary.

Node 24.21.0 backend build, TypeScript validation, and the expanded thirteen-file
suite passed: 748 tests, including the privacy audit. Whitespace checks passed.
These changes require fresh exact-head CI and review; the earlier SHIP does
not qualify the follow-up. No deployment or policy activation is claimed.

## Activation boundary

No central policy value is enabled by this source change. No service deployment
or live hosted review is claimed. Deploy compatible worker and completion
service images first, then configure the central policy. Re-admit a consumer
review only after the new code and policy are verified live.

No credentials, private application code, recordings, session transcripts, or
private environment records are included in this change.
