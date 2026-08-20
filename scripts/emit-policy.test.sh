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
transports = review.get('transports', [])
if [item.get('name') for item in transports] != ['fireworks', 'ollama', 'openrouter-fallback']:
    raise SystemExit('policy must preserve Fireworks -> Ollama -> OpenRouter order')
if [item.get('reasoning_effort') for item in transports] != ['max', 'high', 'max']:
    raise SystemExit('reasoning must be Fireworks=max, Ollama=high, OpenRouter=max')
if transports[0].get('structured_output') != 'strict':
    raise SystemExit('Fireworks must use the strict investigation response schema')
if transports[0].get('perf_metrics_in_response') is not True:
    raise SystemExit('Fireworks must return performance metrics')
if review.get('openrouter_max_attempts') != '2':
    raise SystemExit('each transport must retain one retry')
budget = review.get('budget')
if not isinstance(budget, dict):
    raise SystemExit('policy must keep lane limits in review_yeti.budget')
for key in ('lane_deadline_ms', 'lane_call_budget', 'max_investigation_turns'):
    if key not in budget:
        raise SystemExit(f'policy budget is missing {key}')
fallback = next((item for item in review.get('transports', []) if item.get('name') == 'openrouter-fallback'), None)
if not fallback:
    raise SystemExit('policy must define the openrouter-fallback transport')
if fallback.get('stream') is not True:
    raise SystemExit('openrouter-fallback must use streaming for provider attribution')
if fallback.get('model') != 'deepseek/deepseek-v4-flash-0731':
    raise SystemExit('openrouter-fallback must use the approved structured-output fallback model')
if fallback.get('structured_output') != 'strict':
    raise SystemExit('openrouter-fallback must use strict investigation output')
if fallback.get('allow_banned_providers') is not None:
    raise SystemExit('openrouter-fallback must not re-enable the hard-banned Fireworks provider')
if fallback.get('quarantine_on_timeout') is not False:
    raise SystemExit('OpenRouter must own timeout rerouting without dynamic provider bans')
routing = fallback.get('provider_routing') or {}
if 'fireworks' not in (routing.get('ignore') or []):
    raise SystemExit('openrouter-fallback must explicitly ignore the hard-banned Fireworks provider')
if routing.get('allow_fallbacks') is not True:
    raise SystemExit('openrouter-fallback must allow cheap hosts to fall')
if routing.get('sort') != 'throughput':
    raise SystemExit('openrouter-fallback must sort by throughput')
if routing.get('quantizations') != ['bf16', 'fp16']:
    raise SystemExit('openrouter-fallback must require full-precision quantizations')
if routing.get('preferred_min_throughput') != {'p90': 40}:
    raise SystemExit('openrouter-fallback must enforce the p90 throughput floor')
if routing.get('preferred_max_latency') != {'p99': 3}:
    raise SystemExit('openrouter-fallback must enforce the p99 latency preference')
if routing.get('only') or routing.get('order'):
    raise SystemExit('openrouter-fallback must not pin provider.only or provider.order')
if review.get('openrouter_stream') != 'true':
    raise SystemExit('global openrouter_stream must be true so configured transports use SSE TTFT')
for transport in review.get('transports', []):
    if transport.get('stream') is not True:
        raise SystemExit(f'{transport.get("name")} must stream')
    for key in ('timeout_ms', 'connect_timeout_ms'):
        value = transport.get(key)
        if type(value) is not int or not 1 <= value <= 180_000:
            raise SystemExit(f"{transport.get('name', '<unnamed>')} {key} must be between 1ms and 180000ms")

# Hard arithmetic invariant: a lane advances through every declared transport in order, retrying
# each transport up to openrouter_max_attempts before it gives up. If that worst-case product exceeds
# the lane deadline, the later transports -- the OpenRouter fallback most of all -- are structurally
# unreachable in exactly the case they exist for (a slow or stalled primary). This is the same
# invariant emit-policy.mjs enforces at policy-load time; re-checking it here against the real
# committed policy keeps the two in lockstep. Sums over however many transports the policy declares
# -- not hardcoded to today's count -- so it stays meaningful if that count changes.
lane_deadline_ms = int(budget['lane_deadline_ms'])
max_attempts = int(review['openrouter_max_attempts'])
max_investigation_turns = int(budget['max_investigation_turns'])
transport_timeout_sum_ms = sum(t['timeout_ms'] for t in transports)
worst_case_transport_ms = transport_timeout_sum_ms * max_attempts * max_investigation_turns
if worst_case_transport_ms > lane_deadline_ms:
    raise SystemExit(
        f'worst-case transport budget ({worst_case_transport_ms}ms = {transport_timeout_sum_ms}ms across '
        f'{len(transports)} transports x {max_attempts} attempts x {max_investigation_turns} turns) '
        f'exceeds review_yeti.budget.lane_deadline_ms ({lane_deadline_ms}ms); a full sequential '
        'failover could never reach the last transport'
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
if not str(review.get('openrouter_ttft_ms', '')).isdigit() or int(review['openrouter_ttft_ms']) < 1:
    raise SystemExit('openrouter_ttft_ms must be a positive integer string')
print('policy budget source passed')
PY

mkdir -p "$tmp_dir/scripts" "$tmp_dir/policy"
cp "$repo_root/scripts/emit-policy.mjs" "$tmp_dir/scripts/emit-policy.mjs"

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
transport = policy['review_yeti']['transports'][0]
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

# Counterfactual proof for the lane-deadline arithmetic guard: every transport individually stays
# inside the per-transport 1ms-180000ms cap (so that check does not fire first), but each transport
# is set high enough that the sum across all configured transports exceeds the committed lane
# deadline -- derived from the deadline and transport count rather than hardcoded, so this stays
# meaningful if a transport is added or removed again.
write_transport_budget_overflow_policy() {
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" <<'PY'
import json
import sys

source, destination = sys.argv[1:]
policy = json.load(open(source))
transports = policy['review_yeti']['transports']
lane_deadline_ms = int(policy['review_yeti']['budget']['lane_deadline_ms'])
overflow_timeout_ms = min(180_000, (lane_deadline_ms // len(transports)) + 10_000)
for transport in transports:
    transport['timeout_ms'] = overflow_timeout_ms
    transport['connect_timeout_ms'] = min(transport.get('connect_timeout_ms', 30_000), overflow_timeout_ms)
# A generated cap can otherwise land exactly on the lane deadline. Nudge
# the fixture deadline just below the resulting sum while keeping the retry-envelope check valid.
if overflow_timeout_ms * len(transports) <= lane_deadline_ms:
    lane_deadline_ms = overflow_timeout_ms * len(transports) - 1
    policy['review_yeti']['budget']['lane_deadline_ms'] = str(lane_deadline_ms)
# Keep the retry-envelope guard from firing first; this fixture is specifically proving that
# the sum across transports is checked independently of the OpenRouter retry count.
policy['review_yeti']['openrouter_max_attempts'] = '1'
policy['review_yeti']['openrouter_timeout_ms'] = str(overflow_timeout_ms)
with open(destination, 'w') as handle:
    json.dump(policy, handle)
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

write_transport_retry_budget_overflow_policy() {
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" <<'PY'
import json
import sys

source, destination = sys.argv[1:]
policy = json.load(open(source))
review = policy['review_yeti']
transports = review['transports']
lane_deadline_ms = int(review['budget']['lane_deadline_ms'])
max_attempts = int(review['openrouter_max_attempts'])
retry_timeout_ms = min(180_000, (lane_deadline_ms // (len(transports) * max_attempts)) + 10_000)
for transport in transports:
    transport['timeout_ms'] = retry_timeout_ms
    transport['connect_timeout_ms'] = min(transport.get('connect_timeout_ms', 30_000), retry_timeout_ms)
openrouter = next(item for item in transports if item['name'] == 'openrouter-fallback')
review['openrouter_timeout_ms'] = str(openrouter['timeout_ms'])
with open(destination, 'w') as handle:
    json.dump(policy, handle)
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
  grep -q 'worst-case transport budget' "$tmp_dir/transport-retry-budget-overflow.log"
  echo "[transport-retry-budget-overflow] passed"
}

# Counterfactual proof for the TTFT-as-total-generation-cap guard. The committed policy's
# The committed policy streams on every transport and keeps a first-token budget below the total
# timeout. The danger is the OTHER combination: a transport declared non-streaming with a tighter
# ttft, where a live run
# showed the "TTFT" abort silently becomes a total-generation cap wrapping the entire request.
# Both ways a transport can end up declared non-streaming are exercised: per-transport
# `stream: false`, and the global `openrouter_stream` flag.
write_ttft_unsafe_policy() {
  local stream_scope="$1"
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" "$stream_scope" <<'PY'
import json
import sys

source, destination, stream_scope = sys.argv[1:]
policy = json.load(open(source))
review = policy['review_yeti']
review['openrouter_ttft_ms'] = '30000'
if stream_scope == 'transport':
    review['transports'][0]['stream'] = False
elif stream_scope == 'global':
    review['openrouter_stream'] = 'false'
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
if [item.get('name') for item in plan] != ['fireworks', 'ollama', 'openrouter-fallback']:
    raise SystemExit('base64 transport plan must preserve Fireworks -> Ollama -> OpenRouter order')
if any(item.get('stream') is not True for item in plan):
    raise SystemExit('base64 transport plan must preserve streaming for every transport')
PY
grep -A1 '^openrouter_data_collection<<' "$tmp_dir/valid.output" | grep -qx 'deny'
grep -A1 '^openrouter_ignore_providers<<' "$tmp_dir/valid.output" | grep -qx 'fireworks,open-inference,akashml'
grep -A1 '^openrouter_provider_routing<<' "$tmp_dir/valid.output" | grep -Fq '"ignore":["fireworks","open-inference","akashml"]'
grep -qx 'v1' "$tmp_dir/valid.output"
grep -q '^repository<<' "$tmp_dir/valid.output"
grep -qx 'review-yeti-ai/review-yeti-bot' "$tmp_dir/valid.output"
grep -q '^lane_call_budget<<' "$tmp_dir/valid.output"
grep -qx '24' "$tmp_dir/valid.output"

run_case valid-lane-deadline lane_deadline_ms 600000 0
grep -q '^lane_deadline_ms<<' "$tmp_dir/valid-lane-deadline.output"
grep -qx '600000' "$tmp_dir/valid-lane-deadline.output"

run_case valid-investigation-turns max_investigation_turns 2 0
grep -q '^max_investigation_turns<<' "$tmp_dir/valid-investigation-turns.output"
grep -qx '2' "$tmp_dir/valid-investigation-turns.output"

for value in 0 -1 abc '24 ' ''; do
  run_case "invalid-${value:-empty}" lane_call_budget "$value" 1
  grep -q 'lane_call_budget must be a positive integer string' "$tmp_dir/invalid-${value:-empty}.log"
done

run_case missing lane_call_budget __missing__ 1
grep -q 'lane_call_budget must be a positive integer string' "$tmp_dir/missing.log"

for key in lane_deadline_ms max_investigation_turns; do
  for value in 0 -1 abc ''; do
    name="invalid-${key}-${value:-empty}"
    run_case "$name" "$key" "$value" 1
    grep -q "review_yeti.budget.${key} must be a positive integer string" "$tmp_dir/${name}.log"
  done
  name="missing-${key}"
  run_case "$name" "$key" __missing__ 1
  grep -q "review_yeti.budget.${key} must be a positive integer string" "$tmp_dir/${name}.log"
done

for field in timeout_ms connect_timeout_ms; do
  for value in 0 -1 180001 true 1.5 ''; do
    name="invalid-transport-${field}-${value:-empty}"
    run_case "$name" "transport.0.${field}" "$value" 1
    grep -q "transport fireworks.${field} must be an integer between 1ms and 180000ms" "$tmp_dir/${name}.log"
  done
done

run_transport_relation_case
run_transport_budget_overflow_case
run_transport_retry_budget_overflow_case
run_ttft_unsafe_case transport
run_ttft_unsafe_case global

write_openrouter_timeout_mismatch_policy() {
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" <<'PY'
import json
import sys

source, destination = sys.argv[1:]
policy = json.load(open(source))
openrouter = next(item for item in policy['review_yeti']['transports'] if item['name'] == 'openrouter-fallback')
openrouter['timeout_ms'] += 1
with open(destination, 'w') as handle:
    json.dump(policy, handle)
PY
}

run_openrouter_timeout_mismatch_case() {
  local output_file="$tmp_dir/invalid-openrouter-timeout.output"
  write_openrouter_timeout_mismatch_policy
  set +e
  (cd "$tmp_dir/scripts" && GITHUB_OUTPUT="$output_file" node emit-policy.mjs) >"$tmp_dir/invalid-openrouter-timeout.log" 2>&1
  local rc=$?
  set -e
  [[ "$rc" -eq 1 ]]
  grep -q 'openrouter-fallback.timeout_ms must equal review_yeti.openrouter_timeout_ms' "$tmp_dir/invalid-openrouter-timeout.log"
  echo "[invalid-openrouter-timeout] passed"
}

write_short_lane_deadline_policy() {
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" <<'PY'
import json
import sys

source, destination = sys.argv[1:]
policy = json.load(open(source))
# Derive so this case always isolates the envelope guard. A pinned literal was tuned to a
# previous openrouter_timeout_ms; once that value changed, the envelope stopped binding and a
# different guard fired first, failing this case for the wrong reason. Same defect class as #74.
envelope = int(policy['review_yeti']['openrouter_timeout_ms']) * int(policy['review_yeti']['openrouter_max_attempts'])
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
  grep -q 'lane_deadline_ms must cover the OpenRouter request retry envelope' "$tmp_dir/invalid-lane-envelope.log"
  echo "[invalid-lane-envelope] passed"
}

run_openrouter_timeout_mismatch_case
run_short_lane_deadline_case

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

echo "emit-policy action channel and lane_call_budget contract passed"
