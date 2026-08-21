#!/usr/bin/env bash
# Fetch a PR's unified diff, with a fallback for diffs GitHub refuses to serve.
#
# `gh pr diff` hits the `.diff` media type, which GitHub caps at 300 files:
#
#   HTTP 406: Sorry, the diff exceeded the maximum number of files (300).
#   Consider using 'List pull requests files' API or locally cloning the
#   repository instead.
#
# Measured on calltelemetry/ct-meta#2118 (325 files): the fetch step exited 1,
# every downstream step went `conclusion=skipped`, and the run surfaced only
# "Review Yeti did not produce a verdict; an earlier workflow step failed" --
# naming neither the file count nor the 406. A large PR is exactly the kind that
# most wants review, and it silently got none.
#
# So: try the fast path, and on failure reconstruct the same unified diff from
# the Files API, which pages to 3000 files. This is the fallback GitHub's own
# error message recommends.
#
# Usage: fetch-pr-diff.sh <pr-number> <owner/repo> <output-path>
set -euo pipefail

PR="${1:?pr number required}"
REPO="${2:?owner/repo required}"
OUT="${3:?output path required}"

if gh pr diff "$PR" --repo "$REPO" >"$OUT" 2>"${OUT}.err"; then
  echo "Fetched $(wc -l <"$OUT") diff lines."
  rm -f "${OUT}.err"
  exit 0
fi

err="$(cat "${OUT}.err" 2>/dev/null || true)"
rm -f "${OUT}.err"

# Only the size cap is recoverable this way. A 404, an auth failure or a network
# error must still fail loudly -- reconstructing a diff from a Files API call
# that is itself broken would hand the panel a silently empty review.
if ! grep -qiE "exceeded the maximum number of files|too_large" <<<"$err"; then
  echo "::error::could not fetch PR diff for ${REPO}#${PR}: ${err}" >&2
  exit 1
fi

echo "::warning::${REPO}#${PR} exceeds GitHub's 300-file .diff cap; reconstructing from the Files API."

# --paginate walks every page (100/file max per page, 3000 files total).
gh api --paginate "repos/${REPO}/pulls/${PR}/files" \
  --jq '.[] | {filename, previous_filename, status, patch}' >"${OUT}.jsonl"

stats="$(node - "$OUT" <<'NODE'
const fs = require('node:fs');
const out = process.argv[2];
const lines = fs.readFileSync(`${out}.jsonl`, 'utf8').split('\n').filter(Boolean);

const chunks = [];
let omitted = 0;

for (const line of lines) {
  const f = JSON.parse(line);
  const to = f.filename;
  const from = f.previous_filename || f.filename;

  // Binary files and patches GitHub declines to render carry no `patch`. Emitting
  // a header with no hunks would be a lie the parser cannot detect, so count them
  // and let the caller report the number instead.
  if (typeof f.patch !== 'string' || f.patch.length === 0) {
    omitted += 1;
    continue;
  }

  chunks.push(`diff --git a/${from} b/${to}`);
  if (f.status === 'added') {
    chunks.push('--- /dev/null', `+++ b/${to}`);
  } else if (f.status === 'removed') {
    chunks.push(`--- a/${from}`, '+++ /dev/null');
  } else {
    chunks.push(`--- a/${from}`, `+++ b/${to}`);
  }
  chunks.push(f.patch.replace(/\n$/, ''));
}

fs.writeFileSync(out, chunks.length ? `${chunks.join('\n')}\n` : '');
fs.rmSync(`${out}.jsonl`, { force: true });
process.stdout.write(`${lines.length}\t${omitted}\n`);
NODE
)"

total="${stats%%$'\t'*}"
omitted="${stats##*$'\t'}"

echo "Fetched $(wc -l <"$OUT") diff lines via the Files API (${total} files)."
if [ "${omitted:-0}" -gt 0 ]; then
  # Never let a dropped file pass as a reviewed one. The panel already has a
  # FILES_OMITTED concept; surface the count rather than shipping a diff that
  # looks complete.
  echo "::warning::${omitted} of ${total} file(s) carried no patch (binary or oversized) and are absent from the reconstructed diff."
fi
