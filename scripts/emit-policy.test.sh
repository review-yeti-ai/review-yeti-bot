#!/usr/bin/env bash
set -euo pipefail

# Contract test for the central lane-call budget. The policy is deliberately copied into a
# temporary scripts/policy pair so emit-policy.mjs is exercised at the same relative path used in
# GitHub Actions without changing production policy during the test.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'find "$tmp_dir" -type f -delete; find "$tmp_dir" -depth -type d -empty -delete' EXIT

# Channel-distribution contract: the policy selects the bot by the platform
# release channel (with an empty break-glass override), never a raw SHA pin.
expected_action_channel='v1'
actual_action_channel="$(python3 - "$repo_root/policy/review-yeti.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as handle:
    review = json.load(handle)["review_yeti"]
    assert "action_sha" not in review, "raw action_sha pin must not resurface"
    assert review.get("action_sha_override", None) == "", "override must default to empty"
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
if int(fallback.get('timeout_ms', 0)) > 60_000:
    raise SystemExit('openrouter-fallback timeout must be <= 60000ms')
if fallback.get('stream') is not True:
    raise SystemExit('openrouter-fallback must use streaming for provider attribution')
if review.get('openrouter_stream') != 'true':
    raise SystemExit('global openrouter_stream must be true so Fireworks/Ollama use SSE TTFT')
for transport in review.get('transports', []):
    if transport.get('stream') is not True:
        raise SystemExit(f'{transport.get("name")} must stream')
if 'open-inference' not in fallback.get('ignore_providers', []):
    raise SystemExit('openrouter-fallback must quarantine open-inference')
if 'akashml' not in fallback.get('ignore_providers', []):
    raise SystemExit('openrouter-fallback must quarantine akashml (malformed 10k completions / 60s timeouts)')
if fallback.get('provider_routing', {}).get('sort') != 'throughput':
    raise SystemExit('openrouter-fallback must use throughput routing')
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
budget = review.setdefault('budget', {})
if value == '__missing__':
    budget.pop(key, None)
else:
    budget[key] = value
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

run_case valid lane_call_budget 24 0
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

echo "emit-policy lane_call_budget contract passed"
echo "emit-policy bounded lane contract passed"
