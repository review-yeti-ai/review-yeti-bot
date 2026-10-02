# Bounded full lockfile review

Generic source patches retain their existing 20,000-character context limit.
An optional trusted central policy setting can separately admit a complete raw
lockfile patch for dependency and required reviewers:

```json
{
  "review_yeti": {
    "budget": {
      "max_reviewed_lockfile_patch_chars": 65536
    }
  }
}
```

This fragment is not a complete policy. The value must be a numeric integer
between 20,000 and 65,536. Omission keeps the legacy 20,000-character behavior
without adding a serialized default or changing a prepared configuration hash.
An explicit setting is included in the prepared configuration and its digest.
The authoritative completion service uses that same bound.

For a lockfile accompanying a reviewed change, the admitted patch is restored
byte-for-byte, routed to dependency and required lanes, and available through
the paged diff reader. Patches above the bound still require the existing
verified package summary; unsuccessful verification reports incomplete coverage.
This is not a remote-source allowlist or a no-review exemption. Lockfile-only
changes still pass through the unchanged strict verification path.

Only the immutable central policy supplies this setting. It is not an
ActionDispatch parameter. Deploy compatible worker and completion-service code
before enabling the setting in central policy; otherwise a code merge alone
does not activate the new behavior.

Focused tests cover default and explicit caps, legacy prepared records, both
review engines, exact paged retrieval, authoritative completion parity, invalid
values, over-cap refusal, and unchanged lockfile-only exemption behavior.
