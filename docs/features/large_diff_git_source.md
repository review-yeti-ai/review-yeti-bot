# Git-derived diffs for pull requests GitHub will not render

Work item W3 (REL-1080) of `docs/superpowers/specs/2026-09-23-review-content-shrinking-and-jev-triage.md`.

## Problem

GitHub's diff media type returns HTTP 406 above roughly 20,000 lines or 300 files. Before this change:

- The worker fell back to the paginated pull-files API. That API caps at 3,000 files and leaves out the patch for large files. The worker skipped those files without saying so.
- The trusted completion side fell back to the compare API. That API lists at most 300 files and can rebuild at most 64 truncated patches. Above those limits it failed with `Review reader file count unavailable`, so the pull request could never complete a review.

## Behaviour

When the diff read returns 406, both sides compute the same three-dot diff with git, using the one module `src/github/gitDiffSource.ts`:

1. Read the compare API for the exact `base...head`. Take `merge_base_commit` from that response, and require `base_commit` to be the admitted base.
2. In a fresh bare scratch repository, fetch only the merge-base and head commits, by object id, with `--depth=1 --filter=blob:none`. The diff then fetches the changed blobs lazily, in one batch.
3. Run `git diff` with fixed flags (`GIT_DIFF_ARGS`): Myers with the indent heuristic, 50% rename detection, 3 lines of context, full index lines, and no external diff or textconv.
4. Accept the result only through `verifyGitDerivedDiff`, the one rule both sides share. Every hunk must be closed. No chunk may be unreadable. Paths must be unique. The file count must equal GitHub's `changed_files`. The output must be at most 4 MB, the same bound as the trusted per-file evidence; larger output is rejected, never truncated.

The existing pull reads before and after the diff still bracket it. A head that moves in between is rejected on the worker side and becomes a cancellation on the trusted side, as before. On the worker, the `changed_files` count must also be the same in both reads.

The git output is what GitHub renders. On a real range of this repository, the hunks and added lines were byte-identical to GitHub's compare `.diff`; only the abbreviated `index` lines differed.

## Fallback order

| Side | 406 path |
| --- | --- |
| Worker (`loadSameHeadReviewSource`) | git, then the old pull-files path if git fails |
| Trusted (`AuthoritativeReviewReader.exactCurrentDiff`) | git, then the old compare path if git fails |

A git failure never makes the result worse than it was before this change.

## Safety

Repository content is untrusted:

- The scratch repository is bare. Nothing is checked out, and the candidate's `.gitattributes` is never read.
- System and global git configuration are ignored.
- Only HTTPS transport is allowed.
- Hooks, credential helpers and prompts are disabled.

The installation token travels in an environment-supplied `http.extraHeader`. It never appears in argv or the remote URL. Errors carry only a fixed reason (`GitDiffSourceError.reason`), never git output.

Resources are bounded:

| Side | Timeout | Scratch-disk budget |
| --- | --- | --- |
| Worker | 180 s | 1 GiB |
| Trusted | 10 s, inside the 20 s completion deadline | 16 MiB |

The trusted budget protects the dispatcher's 32Mi `/tmp` emptyDir: a pod that exceeds its emptyDir limit is evicted. A watchdog polls the scratch size every 100 ms and checks it again when git exits.

## Switch

The feature is on by default because it runs only after GitHub has already refused to render the diff. Set `REVIEW_YETI_GIT_DIFF_FALLBACK=off` (or `0`, `false`, `no`, `disabled`) to turn it off on both sides. Both sides then behave exactly as they did before this change.

## Operator notes

- The trusted side runs in the `review-yeti-bot` image, which now installs git (`Dockerfile.bot`). Until an image with git is deployed, the trusted side keeps using the compare path, because a missing git binary is one of the failures that falls back.
- The dispatcher's `/tmp` is a 32Mi emptyDir. Repositories whose depth-1 trees plus changed blobs exceed 16 MiB fall back to the compare path. To cover them, raise the emptyDir limit in ct-infrastructure and, in the same change, raise the code constant `TRUSTED_GIT_DIFF_MAX_SCRATCH_BYTES` in `src/github/largeDiffSourceWiring.ts`. It is not an environment setting; the only environment control is `REVIEW_YETI_GIT_DIFF_FALLBACK`.
- Worker log line: `GitHub could not render this diff; large-diff source selected`, with `source` (`git` or `pull-files`) and, on fallback, `gitDiffFailure`.
