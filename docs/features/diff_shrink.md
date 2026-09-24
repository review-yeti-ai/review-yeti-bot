# Deterministic diff shrinking

Flag: `REVIEW_YETI_DIFF_SHRINK` on the publishing worker, default off.
Plan: `docs/superpowers/specs/2026-09-23-review-content-shrinking-and-jev-triage.md`, section 4 W2 (REL-1079).
Code: `src/review/diffShrink.ts`, `src/review/gitattributesLinguist.ts`, `src/review/securitySensitivePaths.ts`.

## Enabling

| Value | Effect |
| --- | --- |
| unset, empty, `0`, `false`, `off` | Off. Every change is sent in full. |
| `1`, `true`, `on`, `all` | On for every repository. |
| `owner/repo,owner/other` | On only for the listed repositories (case-insensitive). |

The worker reads the variable from its own environment. The operator does not forward it yet (see "Follow-ups").

## What gets shrunk

The rules run on the files that remain after the existing filters (`path_filters`, lockfiles, generated output). They change only the patch text sent to the models. Every file stays listed to its lanes.

| Rule | Condition | What is sent |
| --- | --- | --- |
| Whitespace-only file | In every hunk, each run of changed lines between context lines differs from what it replaced only in indentation, a CRLF line ending or blank lines | The diff header and one `\ Review Yeti:` note |
| Whitespace-only hunk | The same test for one hunk of a file that also has real changes | Real hunks unchanged; the whitespace hunk becomes one note line |
| Rename or copy | A `rename from` or `copy from` header (git `-M -C`; GitHub's diff already detects renames) | Pure rename: only the header. Modified rename: only the changed hunks. |
| Unpaired move | A deleted file and an added file with byte-identical content and the same mode, when the pair is unique in the diff | One note line on each side |
| `.gitattributes` | The root `.gitattributes` marks the path `linguist-generated` or `linguist-vendored` | The diff header and one note with the changed-line count |

## Never shrunk

- Security-sensitive paths (`isSecuritySensitivePath`): auth, crypto, secrets, CI, containers, IaC, dependency manifests, scripts, migrations and similar. A rule that would have applied is listed as "kept at full depth".
- Whitespace-significant formats: Python, YAML, Makefiles, Markdown, templates and others (`isWhitespaceSignificantPath`).
- Whitespace inside a line, and trailing whitespace. `"a b"` to `"ab"` is a real change, and trailing spaces can be part of a multi-line literal. This check is stricter than `git diff -w`.
- Moved lines. Each run of changed lines is compared in place, so a line removed above a context line and added below it is a real change.
- Hunks that show a multi-line string or here-document delimiter (a backtick, `"""`, `'''`, `<<EOF`, `R"(`).
- Residual risk: an indentation change inside a multi-line literal whose delimiters are outside the hunk's context is still collapsed. The summary lists the file, and the persona can still read the file at head.
- Submodule gitlinks, symlinks, binary files, and files whose mode changes.

## When `.gitattributes` rules apply

The worker reads the root `.gitattributes` at the reviewed head. It uses the rules only when all of these hold:

- The pull request does not change any `.gitattributes` file. The head copy is then the same as the base copy, so a PR cannot mark its own code as generated.
- The repository has no nested `.gitattributes` files. Those can override the root rules, and the worker does not read them.
- The tree listing is not truncated, and every read finishes within one 10-second deadline.

Patterns are matched without regular expressions, in time linear in pattern and path size, because they are repository content.

If any condition fails, no linguist exclusions apply, and the check summary says why.

## One decision

`resolveShrunkReviewApplicability` calls the shared `resolveReviewApplicability` first, on the unshrunk files, and then shrinks only `effectiveFiles[].patch`. As a result:

- The applicable lanes, the no-reviewable-content exemption and the unmatched-path failure match what the trusted completion context derives. It never sees the flag or `.gitattributes`.
- `.gitattributes` exclusions keep the file listed without its content. They do not drop the file the way the built-in generated-file rule does. The service cannot read `.gitattributes`, so dropping the file could change which lanes it requires.
- The fast-ship size bar still sees the original patch size (`byteSize`). Shrinking alone cannot make a file eligible for fast-ship.

## Disclosure

When the flag is on and at least one lane ran, the check summary gets a **Diff shrinking** block with:

- The estimated token count before and after shrinking.
- Every whitespace-only file and every file with collapsed hunks.
- Every rename, move and copy, as `old -> new` with its similarity.
- Every `.gitattributes` exclusion and the attribute that caused it.
- Why the `.gitattributes` rules were not applied, if they were not.
- Every security-sensitive file kept at full depth.

Each list is capped at 15 entries plus a "+N more" count. The worker also logs these counts in a `Diff shrinking applied before review` event.

## Follow-ups

- Operator projection. Forward `REVIEW_YETI_DIFF_SHRINK` from the operator to worker Jobs, in the same allowlist pattern as `ZOEKT_GROUNDING_ENABLED` and the Jev projection (#1000).
- Formatter-only detection (plan W2, fourth bullet) is not implemented. It needs the repository's formatter to run on both sides of the change, and formatter config and plugins are repository code. It stays open until the worker can run a formatter without running repository code (plan section 7, open question 2).
- Non-exact move pairing. A delete/add pair with less than 100% similarity is not paired, because the worker has no clone to run `git diff -M -C` on. The W3 git-based diff source should run `git diff -M -C` so its rename and copy headers reach this module.
- Replay corpus. The plan accepts W2 only once a replay corpus of recent PRs shows the same verdicts and findings with fewer tokens. Run that before enabling the flag beyond review-yeti-bot and ct-meta.
