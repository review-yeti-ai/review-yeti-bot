# ct-review-bot architecture

The canonical contract is the version 3 `.ct-review.yaml` schema maintained by
`ct-meta`. The bot executes that repository-owned contract; it has no universal
persona roster.

```text
GitHub webhook
  -> verify HMAC and persist delivery id
  -> mint per-installation ghs_ token
  -> read policy at PR base SHA
  -> fetch exact-head diff
  -> run applicable enabled persona lanes concurrently
  -> require every required lane
  -> require distinct successful provider quorum
  -> moderator reconciliation call
  -> separate binding arbiter call
  -> persona COMMENT reviews + exact-head check
  -> arbiter APPROVE or REQUEST_CHANGES review
```

OmniRoute 3.8.48 is an internal-only StatefulSet. Its encrypted provider state
is stored on a persistent volume. The bot rejects any returned model that is
not the exact model requested by the closed-world registry.

GitHub publishing accepts only an explicitly minted `ghs_` installation token.
No PAT, `GITHUB_TOKEN`, personal account, or `gh` executable is in the runtime
trust boundary.

The bot and OmniRoute use digest-pinned images. Only webhook, liveness, and
readiness paths are exposed through `review-bot.calltelemetry.com`; OmniRoute
has no ingress.
