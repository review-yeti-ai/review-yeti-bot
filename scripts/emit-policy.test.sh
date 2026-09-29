#!/usr/bin/env bash
set -euo pipefail

# Contract test for the central lane-call budget. The policy is deliberately copied into a
# temporary scripts/policy pair so emit-policy.mjs is exercised at the same relative path used in
# GitHub Actions without changing production policy during the test.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'find "$tmp_dir" -type f -delete; find "$tmp_dir" -depth -type d -empty -delete' EXIT

# Channel-distribution contract: the policy selects the bot by the platform
# release channel, never a raw SHA pin or per-repository override.
expected_action_channel='v1'
actual_action_channel="$(python3 - "$repo_root/policy/review-yeti.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as handle:
    review = json.load(handle)["review_yeti"]
    assert "action_sha" not in review, "raw action_sha pin must not resurface"
    assert "action_sha_override" not in review, "per-repository SHA overrides must not resurface"
    print(review["action_channel"])
PY
)"
if [[ "$actual_action_channel" != "$expected_action_channel" ]]; then
  echo "policy must select the platform release channel ${expected_action_channel}; got ${actual_action_channel}" >&2
  exit 1
fi

python3 - "$repo_root/policy/review-yeti.json" "$repo_root/.github/workflows/review-yeti.yml" <<'PY'
import json
import re
import sys

review = json.load(open(sys.argv[1]))['review_yeti']
personas = [item.strip() for item in review.get('personas', '').split(',') if item.strip()]
if personas != ['architecture', 'security', 'documentation']:
    raise SystemExit(
        'policy must include the documentation persona so docs-only pull requests '
        'receive a binding Review Yeti verdict'
    )
configured_transports = review.get('transports', [])
if any(type(item.get('enabled')) is not bool for item in configured_transports):
    raise SystemExit('every configured transport must declare enabled as a boolean')
transports = [item for item in configured_transports if item.get('enabled') is True]
if [item.get('name') for item in transports] != ['bifrost']:
    raise SystemExit('policy must be the single Bifrost flash-pool lane (ADR 0652 supersedes REL-710)')
if review.get('dispatch_mode') != 'ordered':
    raise SystemExit('policy must use ordered persona dispatch with Bifrost first')
if {item.get('name'): item.get('dispatch_weight') for item in transports} != {'bifrost': 1}:
    raise SystemExit('the single Bifrost lane must carry dispatch_weight 1')
# Measured ablation 2026-08-20: reasoning_effort=max scored recall 0.425 with 25/72 errors,
# versus unset at 0.750 with 7/72. Never 'max'. Operator 2026-09-03 (REL-525):
# with NO max_tokens on the wire the provider's own limit ended high-effort
# reasoning at finish_reason=length with empty content on 3 of 6 lanes (run
# 33785366231), while the old 24576 cap starved the answer. Live transports must
# declare an explicit budget of at least 65536 tokens; small caps stay forbidden.
# Wall-clock guards (timeout_ms, stall_ms, max_wall_clock_ms) still bound time.
# REL-525 follow-up (run 33791242325, same day): even with the 65536 budget, 'high'
# effort spent 66,880-67,758 reasoning tokens on 2 of 6 lanes and left no room for the
# findings JSON ("no parseable findings JSON"). Live Ollama effort is 'medium': bounded
# reasoning that fits the budget. 'high' and 'max' are both forbidden on the live lane.
if any(item.get('reasoning_effort') == 'max' for item in transports):
    raise SystemExit("reasoning_effort 'max' is forbidden; measured worst arm (recall 0.425, 35% errors)")
if any(item.get('name') == 'bifrost' and item.get('reasoning_effort') not in ('medium', 'none') for item in transports):
    raise SystemExit("Bifrost must use reasoning_effort 'medium' or 'none' (REL-525: 'high' overran the 65536 budget on 2 of 6 lanes)")
if any(item.get('name') == 'bifrost' and (not isinstance(item.get('max_tokens'), int) or item.get('max_tokens') < 32768) for item in transports):
    raise SystemExit('Bifrost must declare an explicit max_tokens budget of at least 32768')
bifrost = next((item for item in configured_transports if item.get('name') == 'bifrost'), None)
ollama = next((item for item in configured_transports if item.get('name') == 'ollama'), None)
gemini = next((item for item in configured_transports if item.get('name') == 'gemini'), None)
if not ollama or not gemini or not bifrost:
    raise SystemExit('policy must define named Gemini, Ollama, and Bifrost transports')
if gemini.get('enabled') is not False or ollama.get('enabled') is not False or bifrost.get('enabled') is not True:
    raise SystemExit('Bifrost must stay enabled; Gemini and Ollama must stay declared-but-disabled')
# REL-896: the synthetic.new account was cancelled and the transport was fully removed (not
# merely disabled). It must never resurface -- a reintroduced declaration, even disabled, means
# the removal PR was reverted or partially reapplied without a fresh review of this contract.
if any(item.get('name') == 'synthetic' for item in configured_transports):
    raise SystemExit('Synthetic transport must not be declared -- the provider account was cancelled (REL-896)')
if any(
    item.get('name') == 'openrouter-primary'
    or item.get('compat') == 'openrouter'
    or 'openrouter.ai' in str(item.get('base_url', '')).lower()
    for item in configured_transports
):
    raise SystemExit('OpenRouter transport must not be declared -- Review Yeti uses NeuralWatt through Bifrost (REL-976)')
# REL-1162: Fireworks was removed (suspended account, HTTP 412). Like Synthetic, absent -- not disabled.
if any(item.get('name') == 'fireworks' or 'fireworks.ai' in str(item.get('base_url', '')) for item in configured_transports):
    raise SystemExit('Fireworks transport must not be declared -- removed from Review Yeti (REL-1162)')
if (gemini.get('base_url'), gemini.get('api_key_env'), gemini.get('model'), gemini.get('compat')) != (
    'https://generativelanguage.googleapis.com/v1beta/openai', 'GEMINI_API_KEY', 'gemini-3.7-flash', 'openai'
):
    raise SystemExit('Gemini must remain pinned to the Google OpenAI-compatible contract')
if review.get('max_attempts') != '2':
    raise SystemExit('each transport must retain one retry')
budget = review.get('budget')
if not isinstance(budget, dict):
    raise SystemExit('policy must keep lane limits in review_yeti.budget')
for key in ('lane_deadline_ms', 'lane_overhead_ms', 'lane_call_budget', 'max_review_assignments', 'max_investigation_turns'):
    if key not in budget:
        raise SystemExit(f'policy budget is missing {key}')
for t in configured_transports:
    t_name = t.get('name', '<unnamed>')
    for required_field in ('name', 'enabled', 'base_url', 'api_key_env', 'model', 'compat', 'stream', 'timeout_ms'):
        if required_field not in t:
            raise SystemExit(f'transport {t_name} is missing required field: {required_field}')
    t_json = json.dumps(t).lower()
    if 'deepseek' in t_json:
        raise SystemExit(f'transport {t_name} contains forbidden legacy deepseek reference: {t_json}')
    if ':latest' in str(t.get('model', '')) or t.get('model', '').endswith('/latest'):
        raise SystemExit(f'transport {t_name} uses unpinned latest model tag: {t.get("model")}')
    if t.get('stream') is not True:
        raise SystemExit(f'transport {t_name} must declare stream: true')
if review.get('stream') != 'true':
    raise SystemExit('legacy action streaming input must stay true so configured transports use SSE TTFT')
for transport in review.get('transports', []):
    if transport.get('stream') is not True:
        raise SystemExit(f'{transport.get("name")} must stream')
    for key in ('timeout_ms', 'connect_timeout_ms', 'ttft_ms', 'stall_ms'):
        value = transport.get(key)
        if type(value) is not int or not 1 <= value <= 180_000:
            raise SystemExit(f"{transport.get('name', '<unnamed>')} {key} must be between 1ms and 180000ms")

# Hard arithmetic invariant (post review-yeti-bot#163): an actively-streaming call is never
# aborted by a duration cap -- the stall/idle timer re-arms on every SSE chunk, so timeout_ms no
# longer bounds a lane's worst-case wall time and must not be summed across every transport x
# attempt x turn (that pre-#163 model rejected healthy configs, which is exactly why
# a direct provider timeout had to be cut from a requested 120000 to 75000). What genuinely bounds a
# lane's worst case is the failure path where a transport never produces a first byte:
# connect_timeout_ms plus one stall_ms interval, summed across every transport, attempt, and
# investigation turn. This is the same invariant emit-policy.mjs enforces at policy-load time;
# re-checking it here against the real committed policy keeps the two in lockstep. Sums over
# however many enabled transports the policy admits -- not hardcoded to today's count -- so it stays
# meaningful if that count changes.
lane_deadline_ms = int(budget['lane_deadline_ms'])
lane_overhead_ms = int(budget['lane_overhead_ms'])
max_attempts = int(review['max_attempts'])
transport_connect_sum_ms = sum(t['connect_timeout_ms'] for t in transports)
transport_stall_sum_ms = sum(t['stall_ms'] for t in transports)
stall_envelope_ms = transport_connect_sum_ms + transport_stall_sum_ms
worst_case_dead_call_ms = stall_envelope_ms * max_attempts
required_lane_budget_ms = worst_case_dead_call_ms + lane_overhead_ms
if required_lane_budget_ms > lane_deadline_ms:
    raise SystemExit(
        f'worst-case dead-transport budget ({worst_case_dead_call_ms}ms = ({transport_connect_sum_ms}ms '
        f'connect + {transport_stall_sum_ms}ms stall) across {len(transports)} transports x '
        f'{max_attempts} attempts) plus lane overhead reserve '
        f'({lane_overhead_ms}ms) exceeds review_yeti.budget.lane_deadline_ms ({lane_deadline_ms}ms); '
        'a full sequential failover of never-connecting or never-streaming transports could never '
        'finish the last transport'
    )
wall_clocks = [
    int(t['max_wall_clock_ms'])
    for t in transports
    if isinstance(t.get('max_wall_clock_ms'), int) and t['max_wall_clock_ms'] > 0
]
if wall_clocks:
    max_wall_clock_ms = max(wall_clocks)
    required_wall_budget_ms = max_wall_clock_ms + lane_overhead_ms
    if required_wall_budget_ms > lane_deadline_ms:
        raise SystemExit(
            f'generation wall clock ({max_wall_clock_ms}ms) plus lane overhead reserve '
            f'({lane_overhead_ms}ms) exceeds review_yeti.budget.lane_deadline_ms ({lane_deadline_ms}ms); '
            'a healthy thinking stream can never finish the lane'
        )

# Second half of the same invariant: a hosted run can retry up to max_passes lanes, so the worst
# case for one job is max_passes full lane deadlines back to back. If that exceeds the job's own
# timeout-minutes, the job gets killed mid-lane instead of failing closed on its own terms.
workflow_text = open(sys.argv[2]).read()
timeout_minutes_match = re.search(r'timeout-minutes:\s*(\d+)', workflow_text)
if not timeout_minutes_match:
    raise SystemExit('could not find timeout-minutes in review-yeti.yml to check the job-cap invariant')
job_cap_ms = int(timeout_minutes_match.group(1)) * 60_000
max_passes = int(review['max_passes'])
if max_passes * lane_deadline_ms > job_cap_ms:
    raise SystemExit(
        f'max_passes({max_passes}) * lane_deadline_ms({lane_deadline_ms}ms) = '
        f'{max_passes * lane_deadline_ms}ms exceeds the job cap {job_cap_ms}ms (timeout-minutes '
        f'in .github/workflows/review-yeti.yml)'
    )

# On a non-streaming fallback, the "TTFT" abort wraps the entire request rather than just the wait
# for a first byte. The committed policy declares streaming on every transport, so a tight TTFT is
# legitimate here; the invariant for any future non-streaming change is exercised below.
# The hosted action still exposes this legacy-named input. Preserve the qualified
# 75000ms first-token budget independently of the selected Bifrost provider.
if review.get('ttft_ms') != '75000':
    raise SystemExit('ttft_ms must preserve the qualified 75000ms large-diff first-token budget')
print('policy budget source passed')
PY

mkdir -p "$tmp_dir/scripts" "$tmp_dir/policy"
cp "$repo_root/scripts/emit-policy.mjs" "$tmp_dir/scripts/emit-policy.mjs"
cp "$repo_root/scripts/lane-deadline-invariant.mjs" "$tmp_dir/scripts/lane-deadline-invariant.mjs"
cp "$repo_root/scripts/repository-policy.mjs" "$tmp_dir/scripts/repository-policy.mjs"
cp "$repo_root/scripts/review-yeti-smoke.mjs" "$tmp_dir/scripts/review-yeti-smoke.mjs"
cp "$repo_root/scripts/streaming-fetch-dispatcher.mjs" "$tmp_dir/scripts/streaming-fetch-dispatcher.mjs"
cp "$repo_root/scripts/transport-envelope.mjs" "$tmp_dir/scripts/transport-envelope.mjs"

write_policy() {
  local key="$1" value="$2"
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" "$key" "$value" <<'PY'
import json
import sys

source, destination, key, value = sys.argv[1:]
policy = json.load(open(source))
review = policy['review_yeti']
if key.startswith('transport.'):
    _, index, field = key.split('.', 2)
    transport = review['transports'][int(index)]
    if value == '__missing__':
        transport.pop(field, None)
    elif value in ('true', 'false'):
        transport[field] = value == 'true'
    else:
        try:
            transport[field] = int(value)
        except ValueError:
            transport[field] = value
elif key.startswith('review.'):
    _, field = key.split('.', 1)
    if value == '__missing__':
        review.pop(field, None)
    else:
        review[field] = value
else:
    budget = review.setdefault('budget', {})
    if value == '__missing__':
        budget.pop(key, None)
    else:
        budget[key] = value
with open(destination, 'w') as handle:
    json.dump(policy, handle)
PY
}

write_channel_policy() {
  local value="$1"
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" "$value" <<'PY'
import json
import sys

source, destination, value = sys.argv[1:]
policy = json.load(open(source))
policy['review_yeti']['action_channel'] = value
with open(destination, 'w') as handle:
    json.dump(policy, handle)
PY
}

run_case() {
  local name="$1" key="$2" value="$3" expected_rc="$4"
  local output_file="$tmp_dir/${name}.output"
  write_policy "$key" "$value"
  set +e
  (cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$output_file" node emit-policy.mjs) >"$tmp_dir/${name}.log" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -ne "$expected_rc" ]]; then
    echo "[$name] expected exit $expected_rc, got $rc" >&2
    cat "$tmp_dir/${name}.log" >&2
    exit 1
  fi
  echo "[$name] passed"
}

write_invalid_transport_relation_policy() {
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" <<'PY'
import json
import sys

source, destination = sys.argv[1:]
policy = json.load(open(source))
transport = next(item for item in policy['review_yeti']['transports'] if item['name'] == 'gemini')
transport['timeout_ms'] = 1_000
transport['connect_timeout_ms'] = 1_001
with open(destination, 'w') as handle:
    json.dump(policy, handle)
PY
}

run_transport_relation_case() {
  local output_file="$tmp_dir/invalid-transport-relation.output"
  write_invalid_transport_relation_policy
  set +e
  (cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$output_file" node emit-policy.mjs) >"$tmp_dir/invalid-transport-relation.log" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -ne 1 ]]; then
    echo "[invalid-transport-relation] expected exit 1, got $rc" >&2
    cat "$tmp_dir/invalid-transport-relation.log" >&2
    exit 1
  fi
  grep -q 'connect_timeout_ms must not exceed timeout_ms' "$tmp_dir/invalid-transport-relation.log"
  echo "[invalid-transport-relation] passed"
}

# Counterfactual proof for the lane-deadline arithmetic guard, post review-yeti-bot#163: since
# timeout_ms no longer bounds an actively-streaming call, this fixture must overflow via the
# quantity that DOES still bound the worst case -- connect_timeout_ms plus one stall_ms interval
# per transport. Every transport individually stays inside the 1ms-180000ms per-field cap (so that
# check does not fire first), but connect_timeout_ms is set high enough that the summed
# connect+stall envelope across all enabled transports exceeds the committed lane deadline --
# derived from the deadline and transport count rather than hardcoded, so this stays meaningful if
# a transport is added or removed again.
write_transport_budget_overflow_policy() {
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" <<'PY'
import json
import sys

source, destination = sys.argv[1:]
policy = json.load(open(source))
review = policy['review_yeti']
# Ollama-only: the enabled lane's six-lane/90s contract is hard-pinned by
# emit-policy, so the overflow fixture drives the lane deadline over the
# edge via the declared overhead reserve instead of mutating the transport.
lane_deadline_ms = int(review['budget']['lane_deadline_ms'])
attempts = int(review['max_attempts'])
enabled = [item for item in review['transports'] if item.get('enabled') is True]
base_sum = sum(item['connect_timeout_ms'] + item['stall_ms'] for item in enabled)
# Smallest overhead that makes required exceed the lane deadline:
required_without_overhead = base_sum * attempts
review['budget']['lane_overhead_ms'] = str(lane_deadline_ms - required_without_overhead + 1)
json.dump(policy, open(destination, 'w'))
PY
}
run_transport_budget_overflow_case() {
  local output_file="$tmp_dir/transport-budget-overflow.output"
  write_transport_budget_overflow_policy
  set +e
  (cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$output_file" node emit-policy.mjs) >"$tmp_dir/transport-budget-overflow.log" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -ne 1 ]]; then
    echo "[transport-budget-overflow] expected exit 1, got $rc" >&2
    cat "$tmp_dir/transport-budget-overflow.log" >&2
    exit 1
  fi
  grep -q 'exceeds review_yeti.budget.lane_deadline_ms' "$tmp_dir/transport-budget-overflow.log"
  echo "[transport-budget-overflow] passed"
}

# Same failure mode, isolated to the retry multiplier: a modest connect+stall envelope that fits
# once but overflows once multiplied by max_attempts.
write_transport_retry_budget_overflow_policy() {
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" <<'PY'
import json
import sys

source, destination = sys.argv[1:]
policy = json.load(open(source))
review = policy['review_yeti']
# A lane deadline that covers the legacy action request retry budget but cannot
# fit the full connect+stall dead-call envelope plus overhead.
review['budget']['lane_deadline_ms'] = '300000'
json.dump(policy, open(destination, 'w'))
PY
}
run_transport_retry_budget_overflow_case() {
  local output_file="$tmp_dir/transport-retry-budget-overflow.output"
  write_transport_retry_budget_overflow_policy
  set +e
  (cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$output_file" node emit-policy.mjs) >"$tmp_dir/transport-retry-budget-overflow.log" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -ne 1 ]]; then
    echo "[transport-retry-budget-overflow] expected exit 1, got $rc" >&2
    cat "$tmp_dir/transport-retry-budget-overflow.log" >&2
    exit 1
  fi
  grep -q 'worst-case dead-transport budget' "$tmp_dir/transport-retry-budget-overflow.log"
  echo "[transport-retry-budget-overflow] passed"
}

# A lane also spends time outside provider generation: acquiring the streaming gate, validating
# structured output, dispatching a failover, and recording evidence. The production incident in
# run 32326867604 reached the final transport with only 23s left and was cancelled by the lane
# deadline even though that transport was actively streaming. Prove the raw connect+stall
# dead-transport envelope is not sufficient unless the declared overhead reserve also fits.
write_transport_overhead_overflow_policy() {
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" <<'PY'
import json
import sys

source, destination = sys.argv[1:]
policy = json.load(open(source))
review = policy['review_yeti']
budget = review['budget']
budget['lane_overhead_ms'] = '120000'
transports = [item for item in review['transports'] if item.get('enabled') is True]
raw_dead_call_budget = (
    sum(item['connect_timeout_ms'] + item['stall_ms'] for item in transports)
    * int(review['max_attempts'])
)
budget['lane_deadline_ms'] = str(raw_dead_call_budget)
with open(destination, 'w') as handle:
    json.dump(policy, handle)
PY
}

run_transport_overhead_overflow_case() {
  local output_file="$tmp_dir/transport-overhead-overflow.output"
  write_transport_overhead_overflow_policy
  set +e
  (cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$output_file" node emit-policy.mjs) >"$tmp_dir/transport-overhead-overflow.log" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -ne 1 ]]; then
    echo "[transport-overhead-overflow] expected exit 1, got $rc" >&2
    cat "$tmp_dir/transport-overhead-overflow.log" >&2
    exit 1
  fi
  grep -q 'plus lane overhead reserve' "$tmp_dir/transport-overhead-overflow.log"
  echo "[transport-overhead-overflow] passed"
}

# Counterfactual proof for the TTFT-as-total-generation-cap guard. The committed policy's
# The committed policy streams on every transport and keeps a first-token budget below the total
# timeout. The danger is the OTHER combination: a transport declared non-streaming with a tighter
# ttft, where a live run
# showed the "TTFT" abort silently becomes a total-generation cap wrapping the entire request.
# Both ways a transport can end up declared non-streaming are exercised: per-transport
# `stream: false`, and the global stream flag.
write_ttft_unsafe_policy() {
  local stream_scope="$1"
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" "$stream_scope" <<'PY'
import json
import sys

source, destination, stream_scope = sys.argv[1:]
policy = json.load(open(source))
review = policy['review_yeti']
review['ttft_ms'] = '30000'
next(item for item in review['transports'] if item['name'] == 'bifrost')['ttft_ms'] = 30_000
if stream_scope == 'transport':
    next(item for item in review['transports'] if item['name'] == 'bifrost')['stream'] = False
elif stream_scope == 'global':
    review['stream'] = 'false'
else:
    raise SystemExit(f'unknown stream_scope {stream_scope!r}')
with open(destination, 'w') as handle:
    json.dump(policy, handle)
PY
}

run_ttft_unsafe_case() {
  local stream_scope="$1"
  local name="ttft-unsafe-${stream_scope}"
  local output_file="$tmp_dir/${name}.output"
  write_ttft_unsafe_policy "$stream_scope"
  set +e
  (cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$output_file" node emit-policy.mjs) >"$tmp_dir/${name}.log" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -ne 1 ]]; then
    echo "[$name] expected exit 1, got $rc" >&2
    cat "$tmp_dir/${name}.log" >&2
    exit 1
  fi
  grep -q 'is tighter than the largest configured timeout' "$tmp_dir/${name}.log"
  grep -q 'streaming is not declared on for every transport' "$tmp_dir/${name}.log"
  echo "[$name] passed"
}

run_case valid lane_call_budget 24 0
grep -q '^action_ref<<' "$tmp_dir/valid.output"
grep -q '^transport_plan<<' "$tmp_dir/valid.output"
grep -q '^transport_plan_b64<<' "$tmp_dir/valid.output"
transport_plan_b64=$(awk '/^transport_plan_b64<</{getline; print; exit}' "$tmp_dir/valid.output")
TRANSPORT_PLAN_B64="$transport_plan_b64" python3 - <<'PY'
import base64, json, os
plan = json.loads(base64.b64decode(os.environ['TRANSPORT_PLAN_B64']).decode())
if [item.get('name') for item in plan] != ['bifrost']:
    raise SystemExit('base64 transport plan must carry the single Bifrost lane (ADR 0652)')
if any(item.get('stream') is not True for item in plan):
    raise SystemExit('base64 transport plan must preserve streaming for every transport')
PY
grep -A1 '^openrouter_data_collection<<' "$tmp_dir/valid.output" | tail -1 | grep -qx ''
grep -A1 '^openrouter_ignore_providers<<' "$tmp_dir/valid.output" | tail -1 | grep -qx ''
grep -A1 '^openrouter_provider_routing<<' "$tmp_dir/valid.output" | grep -Fqx '{}'
grep -qx 'v1' "$tmp_dir/valid.output"
grep -q '^repository<<' "$tmp_dir/valid.output"
grep -qx 'review-yeti-ai/review-yeti-bot' "$tmp_dir/valid.output"
grep -q '^lane_call_budget<<' "$tmp_dir/valid.output"
grep -qx '24' "$tmp_dir/valid.output"
grep -q '^max_review_assignments<<' "$tmp_dir/valid.output"
grep -q '^max_incremental_diff_chars<<' "$tmp_dir/valid.output"
grep -qx '60000' "$tmp_dir/valid.output"

run_case valid-lane-deadline lane_deadline_ms 1200000 0
grep -q '^lane_deadline_ms<<' "$tmp_dir/valid-lane-deadline.output"
grep -qx '1200000' "$tmp_dir/valid-lane-deadline.output"

run_case valid-investigation-turns max_investigation_turns 20 0
grep -q '^max_investigation_turns<<' "$tmp_dir/valid-investigation-turns.output"
grep -qx '20' "$tmp_dir/valid-investigation-turns.output"

for value in 0 -1 abc '24 ' ''; do
  run_case "invalid-${value:-empty}" lane_call_budget "$value" 1
  grep -q 'lane_call_budget must be a positive integer string' "$tmp_dir/invalid-${value:-empty}.log"
done

run_case missing lane_call_budget __missing__ 1
grep -q 'lane_call_budget must be a positive integer string' "$tmp_dir/missing.log"

for value in 0 -1 abc ''; do
  name="invalid-max-incremental-diff-chars-${value:-empty}"
  run_case "$name" review.max_incremental_diff_chars "$value" 1
  grep -q 'review_yeti.max_incremental_diff_chars must be a positive integer string' "$tmp_dir/${name}.log"
done

run_case missing-max-incremental-diff-chars review.max_incremental_diff_chars __missing__ 1
grep -q 'review_yeti.max_incremental_diff_chars must be a positive integer string' "$tmp_dir/missing-max-incremental-diff-chars.log"

for key in lane_deadline_ms lane_overhead_ms max_review_assignments max_investigation_turns; do
  for value in 0 -1 abc ''; do
    name="invalid-${key}-${value:-empty}"
    run_case "$name" "$key" "$value" 1
    grep -q "review_yeti.budget.${key} must be a positive integer string" "$tmp_dir/${name}.log"
  done
  name="missing-${key}"
  run_case "$name" "$key" __missing__ 1
  grep -q "review_yeti.budget.${key} must be a positive integer string" "$tmp_dir/${name}.log"
done

for field in timeout_ms connect_timeout_ms ttft_ms stall_ms; do
  for value in 0 -1 180001 true 1.5 ''; do
    name="invalid-transport-${field}-${value:-empty}"
    # OpenRouter, Synthetic, and Fireworks are absent; index 2 is Ollama.
    run_case "$name" "transport.2.${field}" "$value" 1
    grep -q "transport ollama.${field} must be an integer between 1ms and 180000ms" "$tmp_dir/${name}.log"
  done
done

run_transport_relation_case

# REL-1162: a reintroduced Fireworks transport -- disabled, or renamed but pointed at the
# Fireworks endpoint -- must be refused. Absence is the contract.
for fw_case in disabled renamed; do
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" "$fw_case" <<'PY'
import json
import sys

source, destination, case = sys.argv[1:]
policy = json.load(open(source))
transports = policy['review_yeti']['transports']
if case == 'disabled':
    template = dict(next(item for item in transports if item['name'] == 'gemini'))
    template.update(name='fireworks', enabled=False, base_url='https://api.fireworks.ai/inference/v1',
                    api_key_env='FIREWORKS_PR_REVIEW_API_KEY', model='accounts/fireworks/models/glm-5p3-flash')
    transports.append(template)
else:
    next(item for item in transports if item['name'] == 'gemini')['base_url'] = 'https://api.fireworks.ai/inference/v1'
with open(destination, 'w') as handle:
    json.dump(policy, handle)
PY
  set +e
  (cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$tmp_dir/fireworks-${fw_case}.output" node emit-policy.mjs) >"$tmp_dir/fireworks-${fw_case}.log" 2>&1
  fw_rc=$?
  set -e
  if [[ "$fw_rc" -ne 1 ]] || ! grep -q 'Fireworks transport must not be declared' "$tmp_dir/fireworks-${fw_case}.log"; then
    echo "[fireworks-${fw_case}-rejected] expected Fireworks rejection, got rc=$fw_rc" >&2
    cat "$tmp_dir/fireworks-${fw_case}.log" >&2
    exit 1
  fi
  echo "[fireworks-${fw_case}-rejected] passed"
done

# REL-976: OpenRouter is removed rather than parked. Reject a transport by its
# historical name, compatibility mode, or endpoint even when disabled.
for openrouter_case in name compat endpoint; do
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" "$openrouter_case" <<'PY'
import json
import sys

source, destination, case = sys.argv[1:]
policy = json.load(open(source))
transports = policy['review_yeti']['transports']
template = dict(next(item for item in transports if item['name'] == 'gemini'))
template['name'] = 'candidate-provider'
if case == 'name':
    template['name'] = 'openrouter-primary'
elif case == 'compat':
    template['compat'] = 'openrouter'
elif case == 'endpoint':
    template['base_url'] = 'https://openrouter.ai/api/v1'
else:
    raise SystemExit(f'unknown OpenRouter case: {case}')
transports.append(template)
with open(destination, 'w') as handle:
    json.dump(policy, handle)
PY
  set +e
  (cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$tmp_dir/openrouter-${openrouter_case}.output" node emit-policy.mjs) >"$tmp_dir/openrouter-${openrouter_case}.log" 2>&1
  openrouter_rc=$?
  set -e
  if [[ "$openrouter_rc" -ne 1 ]] || ! grep -q 'OpenRouter transport must not be declared' "$tmp_dir/openrouter-${openrouter_case}.log"; then
    echo "[openrouter-${openrouter_case}-rejected] expected OpenRouter rejection, got rc=$openrouter_rc" >&2
    cat "$tmp_dir/openrouter-${openrouter_case}.log" >&2
    exit 1
  fi
  echo "[openrouter-${openrouter_case}-rejected] passed"
done
run_transport_budget_overflow_case
run_transport_retry_budget_overflow_case
run_ttft_unsafe_case transport
run_ttft_unsafe_case global

write_short_lane_deadline_policy() {
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" <<'PY'
import json
import sys

source, destination = sys.argv[1:]
policy = json.load(open(source))
# Derive so this case always isolates the envelope guard. A pinned literal was tuned to a
# previous request_timeout_ms; once that value changed, the envelope stopped binding and a
# different guard fired first, failing this case for the wrong reason. Same defect class as #74.
envelope = int(policy['review_yeti']['request_timeout_ms']) * int(policy['review_yeti']['max_attempts'])
policy['review_yeti']['budget']['lane_deadline_ms'] = str(envelope - 1)
with open(destination, 'w') as handle:
    json.dump(policy, handle)
PY
}

run_short_lane_deadline_case() {
  local output_file="$tmp_dir/invalid-lane-envelope.output"
  write_short_lane_deadline_policy
  set +e
  (cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$output_file" node emit-policy.mjs) >"$tmp_dir/invalid-lane-envelope.log" 2>&1
  local rc=$?
  set -e
  [[ "$rc" -eq 1 ]]
  grep -q 'lane_deadline_ms must cover the request retry envelope' "$tmp_dir/invalid-lane-envelope.log"
  echo "[invalid-lane-envelope] passed"
}

write_stall_ms_policy() {
  local value="$1"
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" "$value" <<'PY'
import json
import sys

source, destination, value = sys.argv[1:]
policy = json.load(open(source))
review = policy['review_yeti']
if value == '__missing__':
    review.pop('stall_ms', None)
else:
    review['stall_ms'] = value
with open(destination, 'w') as handle:
    json.dump(policy, handle)
PY
}

for value in 0 -1 abc '' __missing__; do
  name="invalid-stall-ms-${value:-empty}"
  write_stall_ms_policy "$value"
  set +e
  (cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$tmp_dir/${name}.output" node emit-policy.mjs) >"$tmp_dir/${name}.log" 2>&1
  rc=$?
  set -e
  [[ "$rc" -eq 1 ]]
  grep -q 'review_yeti.stall_ms must be a positive integer string' "$tmp_dir/${name}.log"
  echo "[$name] passed"
done

run_short_lane_deadline_case
run_transport_overhead_overflow_case

echo "emit-policy lane_call_budget contract passed"
echo "emit-policy bounded lane contract passed"

write_channel_policy main
set +e
(cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$tmp_dir/invalid-channel.output" node emit-policy.mjs) >"$tmp_dir/invalid-channel.log" 2>&1
rc=$?
set -e
[[ "$rc" -eq 1 ]]
grep -q 'review_yeti.action_channel is not a permitted release channel' "$tmp_dir/invalid-channel.log"
echo "[invalid-channel] passed"

write_channel_policy v1.2.3
set +e
(cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$tmp_dir/valid-multi-segment.output" node emit-policy.mjs) >"$tmp_dir/valid-multi-segment.log" 2>&1
rc=$?
set -e
[[ "$rc" -eq 0 ]]
grep -qx 'v1.2.3' "$tmp_dir/valid-multi-segment.output"
echo "[valid-multi-segment] passed"

for value in v v1.2.3.4; do
  write_channel_policy "$value"
  set +e
  (cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$tmp_dir/invalid-channel-${value}.output" node emit-policy.mjs) >"$tmp_dir/invalid-channel-${value}.log" 2>&1
  rc=$?
  set -e
  [[ "$rc" -eq 1 ]]
  grep -q 'review_yeti.action_channel is not a permitted release channel' "$tmp_dir/invalid-channel-${value}.log"
done
echo "[channel-edge-cases] passed"

# Exact repository overrides are resolved centrally. Every consumer emits only
# the Bifrost NeuralWatt route; Example API keeps the bounded admission envelope.
cp "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json"
cisco_output="$tmp_dir/cisco-policy.output"
(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-api GITHUB_OUTPUT="$cisco_output" node emit-policy.mjs)
python3 - "$cisco_output" <<'PY'
import json
import sys

lines = open(sys.argv[1]).read().splitlines()
start = next(i for i, line in enumerate(lines) if line.startswith('transports<<'))
end = next(i for i in range(start + 1, len(lines)) if lines[i] == lines[start].split('<<', 1)[1])
transports = json.loads('\n'.join(lines[start + 1:end]))
if [transport['name'] for transport in transports] != ['bifrost']:
    raise SystemExit('Example API must emit the single Bifrost lane (ADR 0652)')
bifrost = transports[0]
if (bifrost.get('max_in_flight'), bifrost.get('concurrency_scope'), bifrost.get('capacity_wait_timeout_ms'), bifrost.get('connect_timeout_ms'), bifrost.get('max_wall_clock_ms')) != (4, 'provider', 30000, 90000, 900000):
    raise SystemExit('Example API Bifrost admission must cover the 4-lane ceiling, a 90s connect deadline, and a 15-minute live thinking stream')
PY
echo "[cisco-bifrost-primary] passed"

# Bifrost set covers example-release, example-meta, and example-infra too
for repo in exampleorg/example-release exampleorg/example-meta exampleorg/example-infra; do
  repo_output="$tmp_dir/${repo##*/}-policy.output"
  (cd "$tmp_dir/scripts" && REVIEW_REPOSITORY="$repo" GITHUB_OUTPUT="$repo_output" node emit-policy.mjs)
  python3 - "$repo_output" "$repo" <<'PY'
import json
import sys

lines = open(sys.argv[1]).read().splitlines()
start = next(i for i, line in enumerate(lines) if line.startswith('transports<<'))
end = next(i for i in range(start + 1, len(lines)) if lines[i] == lines[start].split('<<', 1)[1])
transports = json.loads('\n'.join(lines[start + 1:end]))
if [transport['name'] for transport in transports] != ['bifrost']:
    raise SystemExit(f'{sys.argv[2]} must emit the single Bifrost lane (ADR 0652)')
if transports[0].get('max_in_flight') != 4 or transports[0].get('connect_timeout_ms') != 90000:
    raise SystemExit(f'{sys.argv[2]} Bifrost admission must cover the 4-lane ceiling and a 90s connect deadline')
PY
  echo "[$repo bifrost-primary] passed"
done

# REL-550: review_yeti.incremental gates the "trusted repair delta" mode's repository
# allowlist and chain-depth cap. incremental_enabled is true iff the reviewed repository
# (REVIEW_REPOSITORY) is listed or the block uses the "*" wildcard; a missing block defaults to
# disabled with chain depth 5; a present-but-malformed block fails closed.
write_incremental_policy() {
  local mode="$1"
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" "$mode" <<'PY'
import json
import sys

source, destination, mode = sys.argv[1:]
policy = json.load(open(source))
review = policy['review_yeti']
if mode == 'missing':
    review.pop('incremental', None)
elif mode == 'allowlist-match':
    review['incremental'] = {'repositories': ['exampleorg/example-api'], 'max_incremental_chain': '3'}
elif mode == 'wildcard':
    review['incremental'] = {'repositories': ['*'], 'max_incremental_chain': '7'}
elif mode == 'non-match':
    review['incremental'] = {'repositories': ['exampleorg/example-api'], 'max_incremental_chain': '4'}
elif mode == 'malformed-not-object':
    review['incremental'] = 'nope'
elif mode == 'malformed-repositories-not-array':
    review['incremental'] = {'repositories': 'exampleorg/example-api', 'max_incremental_chain': '5'}
elif mode == 'malformed-repositories-empty':
    review['incremental'] = {'repositories': [], 'max_incremental_chain': '5'}
elif mode == 'malformed-repositories-blank-entry':
    review['incremental'] = {'repositories': [''], 'max_incremental_chain': '5'}
elif mode == 'malformed-chain-not-integer':
    review['incremental'] = {'repositories': ['*'], 'max_incremental_chain': 'abc'}
elif mode == 'malformed-chain-zero':
    review['incremental'] = {'repositories': ['*'], 'max_incremental_chain': '0'}
else:
    raise SystemExit(f'unknown incremental fixture mode {mode}')
with open(destination, 'w') as handle:
    json.dump(policy, handle)
PY
}

write_incremental_policy allowlist-match
(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-api REVIEW_YETI_RESOLVED_BACKEND=local GITHUB_OUTPUT="$tmp_dir/incremental-match.output" node emit-policy.mjs >/dev/null)
grep -A1 '^incremental_enabled<<' "$tmp_dir/incremental-match.output" | grep -qx 'true'
grep -A1 '^max_incremental_chain<<' "$tmp_dir/incremental-match.output" | grep -qx '3'
echo "[incremental-allowlist-match] passed"

write_incremental_policy wildcard
(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/anything REVIEW_YETI_RESOLVED_BACKEND=local GITHUB_OUTPUT="$tmp_dir/incremental-wildcard.output" node emit-policy.mjs >/dev/null)
grep -A1 '^incremental_enabled<<' "$tmp_dir/incremental-wildcard.output" | grep -qx 'true'
grep -A1 '^max_incremental_chain<<' "$tmp_dir/incremental-wildcard.output" | grep -qx '7'
echo "[incremental-wildcard] passed"

write_incremental_policy non-match
(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-ui GITHUB_OUTPUT="$tmp_dir/incremental-non-match.output" node emit-policy.mjs >/dev/null)
grep -A1 '^incremental_enabled<<' "$tmp_dir/incremental-non-match.output" | grep -qx 'false'
grep -A1 '^max_incremental_chain<<' "$tmp_dir/incremental-non-match.output" | grep -qx '4'
echo "[incremental-non-match] passed"

write_incremental_policy missing
(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-api GITHUB_OUTPUT="$tmp_dir/incremental-missing.output" node emit-policy.mjs >/dev/null)
grep -A1 '^incremental_enabled<<' "$tmp_dir/incremental-missing.output" | grep -qx 'false'
grep -A1 '^max_incremental_chain<<' "$tmp_dir/incremental-missing.output" | grep -qx '5'
echo "[incremental-missing-block] passed"

for mode in malformed-repositories-not-array malformed-repositories-empty malformed-repositories-blank-entry; do
  write_incremental_policy "$mode"
  set +e
  (cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$tmp_dir/incremental-${mode}.output" node emit-policy.mjs) >"$tmp_dir/incremental-${mode}.log" 2>&1
  rc=$?
  set -e
  [[ "$rc" -eq 1 ]]
  grep -q 'review_yeti.incremental.repositories must be an array of non-empty strings' "$tmp_dir/incremental-${mode}.log"
  echo "[incremental-${mode}] passed"
done

write_incremental_policy malformed-not-object
set +e
(cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$tmp_dir/incremental-malformed-not-object.output" node emit-policy.mjs) >"$tmp_dir/incremental-malformed-not-object.log" 2>&1
rc=$?
set -e
[[ "$rc" -eq 1 ]]
grep -q 'review_yeti.incremental must be an object' "$tmp_dir/incremental-malformed-not-object.log"
echo "[incremental-malformed-not-object] passed"

for mode in malformed-chain-not-integer malformed-chain-zero; do
  write_incremental_policy "$mode"
  set +e
  (cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$tmp_dir/incremental-${mode}.output" node emit-policy.mjs) >"$tmp_dir/incremental-${mode}.log" 2>&1
  rc=$?
  set -e
  [[ "$rc" -eq 1 ]]
  grep -q 'review_yeti.incremental.max_incremental_chain must be a positive integer string' "$tmp_dir/incremental-${mode}.log"
  echo "[incremental-${mode}] passed"
done

echo "emit-policy incremental repository allowlist contract passed"

# incremental enabled => backend == local is an ENFORCED invariant, not a convention. Incremental
# "trusted repair delta" review is implemented ONLY by the legacy local pipeline
# (.github/workflows/pipelines/review-pipeline.js); the DOKS worker entrypoint
# (dist/cli/runLiveReview.js) has zero references to the incremental scope or domain index and
# would silently run a full review instead. REVIEW_YETI_RESOLVED_BACKEND mirrors review-yeti.yml's
# `inputs.execution_backend || vars.REVIEW_YETI_EXECUTION_BACKEND || 'doks'` resolution, so this
# checks the run's actual backend (catching an execution_backend input override too), not just a
# repository-level default; it defaults to "doks" (matching that same expression's tail) when unset.

# 1. Today's committed policy carries no review_yeti.incremental block at all (the canary was
#    narrowed to nothing in the same change that added this assertion, because DOKS cannot
#    run it). Proves the combination is coherent. The backend is set explicitly here: the
#    fail-safe default is now "local", and a "doks" run must also declare a publish mode.
write_incremental_policy missing
(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-api REVIEW_YETI_RESOLVED_BACKEND=doks REVIEW_YETI_DOKS_PUBLISH_MODE=app-gate GITHUB_OUTPUT="$tmp_dir/backend-committed-policy.output" node emit-policy.mjs >/dev/null)
grep -A1 '^incremental_enabled<<' "$tmp_dir/backend-committed-policy.output" | grep -qx 'false'
echo "[incremental-backend-committed-policy-doks] passed"
if grep -Fq '"incremental"' "$repo_root/policy/review-yeti.json"; then
  echo "policy/review-yeti.json must not re-enroll review_yeti.incremental while doks is the fleet default backend" >&2
  exit 1
fi
echo "[incremental-backend-committed-policy-no-canary] passed"

# 2. A repository enrolled in review_yeti.incremental while the resolved backend is doks must
#    fail loudly, and the message must explain WHY the combination is impossible (DOKS has no
#    incremental implementation) rather than a generic "invalid config".
write_incremental_policy allowlist-match
set +e
(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-api REVIEW_YETI_RESOLVED_BACKEND=doks REVIEW_YETI_DOKS_PUBLISH_MODE=app-gate GITHUB_OUTPUT="$tmp_dir/backend-doks-blocked.output" node emit-policy.mjs) >"$tmp_dir/backend-doks-blocked.log" 2>&1
rc=$?
set -e
[[ "$rc" -eq 1 ]]
grep -q 'review_yeti.incremental is enabled for exampleorg/example-api' "$tmp_dir/backend-doks-blocked.log"
grep -q 'resolved execution-backend for this run is "doks", not "local"' "$tmp_dir/backend-doks-blocked.log"
grep -q 'dist/cli/runLiveReview.js' "$tmp_dir/backend-doks-blocked.log"
echo "[incremental-backend-doks-blocked] passed"

# 2b. An unset REVIEW_YETI_RESOLVED_BACKEND now resolves to "local", mirroring the workflow's
#     trailing `|| 'local'`. The old fail-safe was `doks`, which meant an unconfigured
#     repository fell back to a dispatch-only backend and silently stopped being reviewed --
#     the default itself was the outage. Omitting the signal must land on the backend that
#     returns a verdict, and incremental is therefore coherent under it.
(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-api GITHUB_OUTPUT="$tmp_dir/backend-default-local.output" node emit-policy.mjs >/dev/null)
grep -A1 '^incremental_enabled<<' "$tmp_dir/backend-default-local.output" | grep -qx 'true'
echo "[incremental-backend-default-is-local] passed"

# 2c. When REVIEW_YETI_DOKS_PUBLISH_MODE is explicitly disabled, a doks run must fail
#     because such a run accepts the dispatch and never reports a verdict for the head.
#     Incremental is cleared first so this isolates the publish axis: the incremental guard
#     runs earlier and would otherwise report its own (different) incoherence.
write_incremental_policy missing
set +e
(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-api REVIEW_YETI_RESOLVED_BACKEND=doks REVIEW_YETI_DOKS_PUBLISH_MODE=disabled GITHUB_OUTPUT="$tmp_dir/backend-doks-nopublish.output" node emit-policy.mjs) >"$tmp_dir/backend-doks-nopublish.log" 2>&1
rc=$?
set -e
[[ "$rc" -eq 1 ]]
grep -q 'publish mode is "disabled", not "app-gate"' "$tmp_dir/backend-doks-nopublish.log"
grep -q 'never reports a verdict for the head' "$tmp_dir/backend-doks-nopublish.log"
echo "[backend-doks-without-publish-blocked] passed"

# 2d. A doks run that DOES declare publishing is accepted -- the guard gates the incoherent
#     combination, it does not ban the backend.
write_incremental_policy missing
(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-api REVIEW_YETI_RESOLVED_BACKEND=doks REVIEW_YETI_DOKS_PUBLISH_MODE=app-gate GITHUB_OUTPUT="$tmp_dir/backend-doks-publishing.output" node emit-policy.mjs >/dev/null)
# "enabled" is not a value the action accepts (dispatch-doks-action.mjs admits only
# disabled|app-gate), so it must be refused here rather than passed through to fail
# at dispatch on an unusable value.
if (cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-api REVIEW_YETI_RESOLVED_BACKEND=doks REVIEW_YETI_DOKS_PUBLISH_MODE=enabled GITHUB_OUTPUT="$tmp_dir/backend-doks-enabled.output" node emit-policy.mjs >/dev/null 2>&1); then
  echo "emit-policy accepted publish mode 'enabled', which the action cannot accept" >&2
  exit 1
fi
grep -A1 '^doks_publish_mode<<' "$tmp_dir/backend-doks-publishing.output" | grep -qx 'app-gate'
echo "[backend-doks-with-publish-allowed] passed"
write_incremental_policy allowlist-match

# 2e. MARS backend rejects incremental review (incremental is local-only) and requires app-gate
write_incremental_policy allowlist-match
set +e
(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-api REVIEW_YETI_RESOLVED_BACKEND=mars REVIEW_YETI_DOKS_PUBLISH_MODE=app-gate GITHUB_OUTPUT="$tmp_dir/backend-mars-blocked.output" node emit-policy.mjs) >"$tmp_dir/backend-mars-blocked.log" 2>&1
rc=$?
set -e
[[ "$rc" -eq 1 ]]
grep -q 'review_yeti.incremental is enabled for exampleorg/example-api' "$tmp_dir/backend-mars-blocked.log"
grep -q 'resolved execution-backend for this run is "mars", not "local"' "$tmp_dir/backend-mars-blocked.log"
echo "[incremental-backend-mars-blocked] passed"

write_incremental_policy missing
set +e
(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-api REVIEW_YETI_RESOLVED_BACKEND=mars REVIEW_YETI_DOKS_PUBLISH_MODE=disabled GITHUB_OUTPUT="$tmp_dir/backend-mars-nopublish.output" node emit-policy.mjs) >"$tmp_dir/backend-mars-nopublish.log" 2>&1
rc=$?
set -e
[[ "$rc" -eq 1 ]]
grep -q 'publish mode is "disabled", not "app-gate"' "$tmp_dir/backend-mars-nopublish.log"
echo "[backend-mars-without-publish-blocked] passed"

(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-api REVIEW_YETI_RESOLVED_BACKEND=mars REVIEW_YETI_DOKS_PUBLISH_MODE=app-gate GITHUB_OUTPUT="$tmp_dir/backend-mars-publishing.output" node emit-policy.mjs >/dev/null)
grep -A1 '^doks_publish_mode<<' "$tmp_dir/backend-mars-publishing.output" | grep -qx 'app-gate'
echo "[backend-mars-with-publish-allowed] passed"
write_incremental_policy allowlist-match

# 3. The identical repository allowlist must pass once the resolved backend is local -- the only
#    backend that implements incremental review.
(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-api REVIEW_YETI_RESOLVED_BACKEND=local GITHUB_OUTPUT="$tmp_dir/backend-local-allowed.output" node emit-policy.mjs >/dev/null)
grep -A1 '^incremental_enabled<<' "$tmp_dir/backend-local-allowed.output" | grep -qx 'true'
echo "[incremental-backend-local-allowed] passed"

echo "emit-policy incremental-backend invariant contract passed"

echo "emit-policy action channel and lane_call_budget contract passed"
