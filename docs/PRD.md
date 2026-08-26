# Product contract

> [!IMPORTANT]
> **Optional service product record.** Service, OmniRoute, replay, and App claims here do not define
> the public GitHub Action or CallTelemetry fleet. Verify current service source before treating any
> statement as an operational contract. See [Documentation authority](DOCUMENTATION_AUTHORITY.md).

`ct-review-bot` enforces repository-composed review teams. A repository defines
ordered persona lanes, path scope, required status, charter, and provider
fallback in its base-SHA `.ct-review.yaml`.

Acceptance requires:

- every applicable required persona completes;
- the configured number of distinct providers succeeds;
- moderator and arbiter return valid nonce-fenced structured output;
- the independently invoked arbiter's `SHIP`, `FIX_FIRST`, or `BLOCK` verdict
  controls the final GitHub review;
- evidence names only actual models and accounting returned by OmniRoute;
- GitHub writes use only App installation tokens.

There is no fixed four-persona product contract and no single bounded review.
