# Bounded Review Navigation Tools

Review Navigation is an internal, read-only helper registry for a reviewer that already has an
immutable pull-request identity and GitHub API snapshot. It is disabled by default. It does not
provide an MCP server, shell access, repository discovery, GitHub search, mutation APIs, or a way
to select a different repository, pull request, ref, URL, or credential.

## Enabling

The trusted Action/runtime configuration must explicitly set `enabled: true` when constructing the
registry. The caller must also supply:

- an immutable identity: `{ repository, prNumber, headSha, baseSha? }`;
- a matching GitHub API snapshot with the same repository and exact head/base SHAs; and
- a read-only blob client authorized with the Action's GitHub token.

The snapshot lists only reviewed paths and immutable Git blob SHAs. A tool cannot access a path
that is absent from that list. The blob client fetches `GET /repos/{owner}/{repo}/git/blobs/{sha}`;
it never reads a mutable branch ref, invokes GitHub code search, or follows an arbitrary URL.
The built-in client accepts only `https://api.github.com`, sends the token in an authorization
header, and does not return it in receipts or errors.

## Available operations

| Tool | Input | Result |
| --- | --- | --- |
| `file_read` | snapshot path and an optional 1-based line range | bounded UTF-8 content from that file's immutable blob |
| `file_find` | a bounded path substring | matching paths from the existing snapshot only |
| `code_search` | a bounded literal substring | matching lines after reading a bounded number of listed immutable blobs |
| `file_read_diff` | snapshot path | the bounded patch captured in the immutable API snapshot |

Every response includes the fixed review identity. This makes a result from one pull request or
head unusable as evidence for another. `file_read_diff` does not contact GitHub: it serves only
the captured patch associated with the same base and head SHAs.

## Safety limits and failure behavior

Trusted configuration may lower these limits; it cannot raise the hard ceilings:

- at most 40 tool calls, 100 scanned files, 50 find/search results, and 500 returned lines per
  file read;
- at most 64 KiB read from an individual blob and 64 KiB returned by a tool;
- a 250–5000 ms GitHub request deadline; and
- immediate cancellation when the caller's abort signal is set.

Malformed, absolute, backslash, NUL, or traversal paths are rejected. A tool reports `invalid`,
`unavailable`, or `cancelled` rather than falling back to a broader API. Reaching the call budget
does not trigger a retry or an alternate transport. Navigation results are advisory review context
only; they never authorize a review verdict or GitHub mutation.
