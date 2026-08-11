# Local `reviewyeti` CLI

The installed `reviewyeti` executable uses the same bounded review engine as the GitHub Action.
Local mode is read-only: it never creates comments, reviews, checks, branches, commits, or pull
requests.

## Sources

Exactly one immutable source is required:

```bash
reviewyeti review --base "$BASE_SHA" --head "$HEAD_SHA" --json
reviewyeti review --diff-file ./change.diff --output ./review-run.json
reviewyeti review --pr review-yeti-ai/review-yeti-bot#31 --json
```

`--base` and `--head` must be full commit SHAs. `--pr` is read-only and rechecks the head SHA
before execution completes. Diff-file mode caps input at 2 MB and derives a synthetic immutable
identity from the exact bytes.

`--json` writes one JSON document to stdout; diagnostics always go to stderr. `--output` uses a
same-directory temporary file, file sync, and atomic rename. Credentials are read from explicit
environment variables (`OPENROUTER_API_KEY`, `GITHUB_TOKEN`, or `GH_TOKEN`) and are never stored.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Complete `SHIP` review |
| 1 | Invalid runtime, provider failure, or output failure |
| 2 | Invalid usage or incomplete/partial coverage |
| 3 | `FIX_FIRST`, `BLOCK`, or blocked terminal outcome |
| 130 | Cancellation/interruption |

## Diagnostics

```bash
reviewyeti doctor --json
```

Doctor reports Node/runtime, repository readability, trusted config parsing, credential presence,
and optional reachability probes. It reports only credential source names, never secret values, and
does not write configuration or credentials.
