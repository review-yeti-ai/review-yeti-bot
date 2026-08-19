#!/usr/bin/env bash
set -euo pipefail

# Contract test proving the exact-head race behavior of validate-review-request.sh:
#   - a head-changed PR must self-cancel this run (request cancellation + confirm it) rather
#     than paint a plain failure on an already-superseded SHA.
#   - every OTHER failure path (repo identity, base SHA, PR state) is untouched and still a
#     plain exit 1 -- only the head-changed branch may cancel.
#   - no path -- including the cancel path -- ever exits 0 for a stale SHA. The script's own
#     exit code must stay non-zero even when self-cancel-run.sh confirms cancellation, because
#     confirming this step's cancellation is a GitHub-run-level signal, not permission for this
#     process to report success.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'find "$tmp_dir" -type f -delete; find "$tmp_dir" -depth -type d -empty -delete' EXIT

mkdir -p "$tmp_dir/bin"

# Fake `gh` covering every call validate-review-request.sh (and the self-cancel-run.sh it may
# invoke) can make: PR metadata, changed-files listing, forbidden-path contents probes, and the
# run cancel/view pair.
cat >"$tmp_dir/bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" == "run" ]]; then
  sub="$2"
  case "$sub" in
    cancel)
      run_id="$3"
      echo "cancel $run_id" >>"$CALL_LOG"
      exit 0
      ;;
    view)
      run_id="$3"
      echo "view $run_id" >>"$CALL_LOG"
      printf '%s' "$RUN_VIEW_JSON"
      exit 0
      ;;
    *)
      echo "unexpected fake gh run call: $*" >&2
      exit 1
      ;;
  esac
fi

# `gh api [--paginate] [--slurp] [--jq EXPR] ENDPOINT`
shift # drop "api"
endpoint=""
jqexpr=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --jq) jqexpr="$2"; shift 2 ;;
    --paginate|--slurp) shift ;;
    *) endpoint="$1"; shift ;;
  esac
done

case "$endpoint" in
  repos/exampleorg/example/pulls/7)
    body="$PR_METADATA_JSON"
    ;;
  repos/exampleorg/example/pulls/7/files*)
    body='[[]]'
    ;;
  repos/exampleorg/example/contents/*)
    echo "HTTP 404: Not Found" >&2
    exit 1
    ;;
  *)
    echo "unexpected fake gh api call: $endpoint" >&2
    exit 1
    ;;
esac

if [[ -n "$jqexpr" ]]; then
  printf '%s' "$body" | jq -r "$jqexpr"
else
  printf '%s\n' "$body"
fi
FAKE_GH
chmod +x "$tmp_dir/bin/gh"

base_sha="deadbeefcafef00ddeadbeefcafef00ddeadbeef"
head_sha="0123456789012345678901234567890123456789"
newer_head_sha="abcdefabcdefabcdefabcdefabcdefabcdefabcd"

run_script() {
  local pr_json="$1" run_view_json="${2-}"
  if [[ -z "$run_view_json" ]]; then
    run_view_json='{"status":"in_progress","conclusion":null}'
  fi
  local call_log
  call_log="$(mktemp)"
  set +e
  output="$(
    PATH="$tmp_dir/bin:$PATH" \
      GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example REVIEW_PR_NUMBER=7 \
      EXPECTED_BASE_SHA="$base_sha" EXPECTED_HEAD_SHA="$head_sha" \
      GITHUB_RUN_ID=999 \
      SELF_CANCEL_WAIT_ATTEMPTS=1 SELF_CANCEL_WAIT_INTERVAL=0 \
      PR_METADATA_JSON="$pr_json" RUN_VIEW_JSON="$run_view_json" CALL_LOG="$call_log" \
      "$repo_root/scripts/validate-review-request.sh" 2>&1
  )"
  rc=$?
  set -e
  cancel_called=0
  [[ -f "$call_log" ]] && grep -q '^cancel 999$' "$call_log" && cancel_called=1
  rm -f "$call_log"
}

pr_json() {
  local head="$1" base="$2" repo="$3" state="$4"
  printf '{"base":{"repo":{"full_name":"%s"},"sha":"%s"},"head":{"sha":"%s"},"state":"%s"}' \
    "$repo" "$base" "$head" "$state"
}

# 1. Head changed while the run was in flight: must self-cancel (request + attempt to confirm),
#    must still exit non-zero (never a green for a stale SHA), and must NOT reuse the old plain
#    "PR head SHA changed" wording -- that message paints the run "failure", which is exactly the
#    noisy outcome this fix removes.
run_script "$(pr_json "$newer_head_sha" "$base_sha" exampleorg/example open)" '{"status":"completed","conclusion":"cancelled"}'
if [[ "$rc" -eq 0 ]]; then
  echo "[head-changed] expected non-zero exit even though cancellation was confirmed, got 0" >&2
  echo "$output" >&2
  exit 1
fi
if [[ "$cancel_called" -ne 1 ]]; then
  echo "[head-changed] expected gh run cancel 999 to be invoked" >&2
  echo "$output" >&2
  exit 1
fi
if grep -Fq "PR head SHA changed: expected" <<<"$output"; then
  echo "[head-changed] expected the self-cancel path, not the old plain failure message" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "Self-cancelling" <<<"$output" || { echo "[head-changed] expected a self-cancel notice" >&2; echo "$output" >&2; exit 1; }
echo "[head-changed] passed (cancelled, exit $rc, no plain-failure wording)"

# 1b. Same head-changed scenario, but the cancellation is never confirmed. Must still be exit
#     non-zero -- proving the fail-closed backstop, not a hidden dependency on GitHub confirming.
run_script "$(pr_json "$newer_head_sha" "$base_sha" exampleorg/example open)" in_progress
if [[ "$rc" -eq 0 ]]; then
  echo "[head-changed-unconfirmed] expected non-zero exit, got 0" >&2
  echo "$output" >&2
  exit 1
fi
echo "[head-changed-unconfirmed] passed (unconfirmed cancel, exit $rc)"

# 2. Base changed (head untouched): must remain the plain exit-1 failure path, no cancellation.
run_script "$(pr_json "$head_sha" "ffffffffffffffffffffffffffffffffffffff" exampleorg/example open)"
if [[ "$rc" -eq 0 ]]; then
  echo "[base-changed] expected non-zero exit, got 0" >&2
  exit 1
fi
if [[ "$cancel_called" -eq 1 ]]; then
  echo "[base-changed] did not expect gh run cancel to be invoked for a base-SHA failure" >&2
  exit 1
fi
grep -Fq "PR base SHA changed" <<<"$output" || { echo "[base-changed] expected the plain base-SHA failure message" >&2; echo "$output" >&2; exit 1; }
echo "[base-changed] passed (plain exit 1, no cancel)"

# 3. Repository identity changed: must remain the plain exit-1 failure path, no cancellation.
run_script "$(pr_json "$head_sha" "$base_sha" exampleorg/other open)"
if [[ "$rc" -eq 0 ]]; then
  echo "[repo-changed] expected non-zero exit, got 0" >&2
  exit 1
fi
if [[ "$cancel_called" -eq 1 ]]; then
  echo "[repo-changed] did not expect gh run cancel to be invoked for a repo-identity failure" >&2
  exit 1
fi
grep -Fq "PR repository identity changed" <<<"$output" || { echo "[repo-changed] expected the plain repo-identity failure message" >&2; echo "$output" >&2; exit 1; }
echo "[repo-changed] passed (plain exit 1, no cancel)"

# 4. PR closed (head/base/repo all match): must remain the plain exit-1 failure path, no
#    cancellation.
run_script "$(pr_json "$head_sha" "$base_sha" exampleorg/example closed)"
if [[ "$rc" -eq 0 ]]; then
  echo "[pr-closed] expected non-zero exit, got 0" >&2
  exit 1
fi
if [[ "$cancel_called" -eq 1 ]]; then
  echo "[pr-closed] did not expect gh run cancel to be invoked for a closed-PR failure" >&2
  exit 1
fi
grep -Fq "PR is not open" <<<"$output" || { echo "[pr-closed] expected the plain not-open failure message" >&2; echo "$output" >&2; exit 1; }
echo "[pr-closed] passed (plain exit 1, no cancel)"

# 5. Exact match: still passes cleanly, unaffected by the new branch.
run_script "$(pr_json "$head_sha" "$base_sha" exampleorg/example open)"
if [[ "$rc" -ne 0 ]]; then
  echo "[exact-match] expected exit 0, got $rc" >&2
  echo "$output" >&2
  exit 1
fi
echo "[exact-match] passed"

echo "validate-review-request self-cancel contract passed"
