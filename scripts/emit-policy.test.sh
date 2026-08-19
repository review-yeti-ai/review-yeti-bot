#!/usr/bin/env bash
set -euo pipefail

# Contract test for the central lane-call budget. The policy is deliberately copied into a
# temporary scripts/policy pair so emit-policy.mjs is exercised at the same relative path used in
# GitHub Actions without changing production policy during the test.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'find "$tmp_dir" -type f -delete; find "$tmp_dir" -depth -type d -empty -delete' EXIT

expected_action_sha='32e64e6e3ceec7a3888d80fac8536f4a4730d6f6'
actual_action_sha="$(python3 - "$repo_root/policy/review-yeti.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as handle:
    print(json.load(handle)["review_yeti"]["action_sha"])
PY
)"
if [[ "$actual_action_sha" != "$expected_action_sha" ]]; then
  echo "policy must pin the approved immutable action SHA ${expected_action_sha}; got ${actual_action_sha}" >&2
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
if 'open-inference' not in fallback.get('ignore_providers', []):
    raise SystemExit('openrouter-fallback must quarantine open-inference')
if fallback.get('provider_routing', {}).get('sort') != 'throughput':
    raise SystemExit('openrouter-fallback must use throughput routing')
print('policy budget source passed')
PY

mkdir -p "$tmp_dir/scripts" "$tmp_dir/policy"
cp "$repo_root/scripts/emit-policy.mjs" "$tmp_dir/scripts/emit-policy.mjs"

write_policy() {
  local value="$1"
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" "$value" <<'PY'
import json
import sys

source, destination, value = sys.argv[1:]
policy = json.load(open(source))
review = policy['review_yeti']
if value == '__missing__':
    review.setdefault('budget', {}).pop('lane_call_budget', None)
else:
    review.setdefault('budget', {})['lane_call_budget'] = value
with open(destination, 'w') as handle:
    json.dump(policy, handle)
PY
}

run_case() {
  local name="$1" value="$2" expected_rc="$3"
  local output_file="$tmp_dir/${name}.output"
  write_policy "$value"
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

run_case valid 24 0
grep -q '^lane_call_budget<<' "$tmp_dir/valid.output"
grep -qx '24' "$tmp_dir/valid.output"

for value in 0 -1 abc '24 ' ''; do
  run_case "invalid-${value:-empty}" "$value" 1
  grep -q 'lane_call_budget must be a positive integer string' "$tmp_dir/invalid-${value:-empty}.log"
done

run_case missing __missing__ 1
grep -q 'lane_call_budget must be a positive integer string' "$tmp_dir/missing.log"

echo "emit-policy lane_call_budget contract passed"
echo "emit-policy bounded lane contract passed"
