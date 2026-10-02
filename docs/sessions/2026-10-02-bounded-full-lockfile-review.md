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

## Activation boundary

No central policy value is enabled by this source change. No service deployment
or live hosted review is claimed. Deploy compatible worker and completion
service images first, then configure the central policy. Re-admit a consumer
review only after the new code and policy are verified live.

No credentials, private application code, recordings, session transcripts, or
private environment records are included in this change.
