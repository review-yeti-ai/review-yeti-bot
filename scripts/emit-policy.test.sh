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

python3 - "$repo_root/policy/review-yeti.json" <<'PY'
import json
import sys

review = json.load(open(sys.argv[1]))['review_yeti']
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
if fallback.get('allow_banned_providers') is not None:
    raise SystemExit('openrouter-fallback must not re-enable the hard-banned Fireworks provider')
routing = fallback.get('provider_routing') or {}
if 'fireworks' not in (routing.get('ignore') or []):
    raise SystemExit('openrouter-fallback must explicitly ignore the hard-banned Fireworks provider')
if routing.get('allow_fallbacks') is not True:
    raise SystemExit('openrouter-fallback must allow cheap hosts to fall')
if routing.get('quantizations') != ['bf16', 'fp16']:
    raise SystemExit('openrouter-fallback must require full-precision bf16/fp16 quants')
if routing.get('sort') != 'throughput':
    raise SystemExit('openrouter-fallback must sort by throughput')
if (routing.get('preferred_min_throughput') or {}).get('p90') != 40:
    raise SystemExit('openrouter-fallback must require p90 throughput >= 40')
if (routing.get('preferred_max_latency') or {}).get('p99') != 3:
    raise SystemExit('openrouter-fallback must require p99 latency <= 3s')
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

run_case valid lane_call_budget 24 0
grep -q '^action_ref<<' "$tmp_dir/valid.output"
grep -qx 'v1' "$tmp_dir/valid.output"
grep -q '^repository<<' "$tmp_dir/valid.output"
grep -qx 'review-yeti-ai/review-yeti-bot' "$tmp_dir/valid.output"
grep -q '^lane_call_budget<<' "$tmp_dir/valid.output"
grep -qx '24' "$tmp_dir/valid.output"

run_case valid-lane-deadline lane_deadline_ms 240000 0
grep -q '^lane_deadline_ms<<' "$tmp_dir/valid-lane-deadline.output"
grep -qx '240000' "$tmp_dir/valid-lane-deadline.output"

run_case valid-investigation-turns max_investigation_turns 3 0
grep -q '^max_investigation_turns<<' "$tmp_dir/valid-investigation-turns.output"
grep -qx '3' "$tmp_dir/valid-investigation-turns.output"

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
