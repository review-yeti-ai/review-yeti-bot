#!/usr/bin/env bash
set -euo pipefail

# Contract test for self-cancel-run.sh in isolation, independent of either caller. Uses a fake
# `gh` so no network access or real Actions run is required.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'find "$tmp_dir" -type f -delete; find "$tmp_dir" -depth -type d -empty -delete' EXIT

mkdir -p "$tmp_dir/bin"

# Fake `gh` that records every `run cancel` invocation to CALL_LOG and reports the run status and
# conclusion from STATUS_SEQUENCE_FILE, popping one JSON object per `run view` poll. This lets a
# test control exactly how many polls occur before (or whether) the run reports cancelled.
cat >"$tmp_dir/bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail

cmd="$1"; shift
sub="$1"; shift || true

case "$cmd $sub" in
  "run cancel")
    run_id="$1"; shift
    repo=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --repo) repo="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    printf 'cancel %s %s\n' "$run_id" "$repo" >>"$CALL_LOG"
    exit 0
    ;;
  "run view")
    run_id="$1"; shift
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --repo|--json|--jq) shift 2 ;;
        *) shift ;;
      esac
    done
    printf 'view %s\n' "$run_id" >>"$CALL_LOG"
    if [[ -s "$STATUS_SEQUENCE_FILE" ]]; then
      next="$(head -n1 "$STATUS_SEQUENCE_FILE")"
      sed -i.bak '1d' "$STATUS_SEQUENCE_FILE" && rm -f "$STATUS_SEQUENCE_FILE.bak"
      if jq -e '(.status == "completed") and (.conclusion == "cancelled")' >/dev/null <<<"$next"; then
        printf 'cancelled'
      else
        printf 'not-cancelled'
      fi
    else
      printf 'in_progress'
    fi
    exit 0
    ;;
  *)
    echo "unexpected fake gh call: $cmd $sub $*" >&2
    exit 1
    ;;
esac
FAKE_GH
chmod +x "$tmp_dir/bin/gh"

run_case() {
  local name="$1"; shift
  local statuses="$1"; shift
  local expect_rc="$1"; shift

  local call_log status_seq
  call_log="$(mktemp)"
  status_seq="$(mktemp)"
  printf '%s' "$statuses" >"$status_seq"

  set +e
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test GITHUB_RUN_ID=123456 REVIEW_REPOSITORY=exampleorg/example \
    SELF_CANCEL_WAIT_ATTEMPTS=3 SELF_CANCEL_WAIT_INTERVAL=0 \
    CALL_LOG="$call_log" STATUS_SEQUENCE_FILE="$status_seq" \
    "$repo_root/scripts/self-cancel-run.sh"
  rc=$?
  set -e

  if [[ "$rc" -ne "$expect_rc" ]]; then
    echo "[$name] expected exit $expect_rc, got $rc" >&2
    exit 1
  fi
  if ! grep -q "^cancel 123456 exampleorg/example$" "$call_log"; then
    echo "[$name] expected a 'gh run cancel 123456 --repo exampleorg/example' call" >&2
    cat "$call_log" >&2
    exit 1
  fi
  rm -f "$call_log" "$status_seq"
  echo "[$name] passed"
}

# The run reports cancelled on the first poll: confirm quickly and exit 0.
run_case "confirms-cancelled" $'{"status":"completed","conclusion":"cancelled"}\n' 0

# The run never reports cancelled within the bounded attempts: this is the fail-closed backstop.
# self-cancel-run.sh must not claim success for a cancellation it never confirmed.
run_case "never-confirms" $'{"status":"in_progress","conclusion":null}\n{"status":"in_progress","conclusion":null}\n{"status":"completed","conclusion":"failure"}\n' 1

echo "self-cancel-run contract passed"
