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
configured_transports = review.get('transports', [])
if any(type(item.get('enabled')) is not bool for item in configured_transports):
    raise SystemExit('every configured transport must declare enabled as a boolean')
transports = [item for item in configured_transports if item.get('enabled') is True]
if [item.get('name') for item in transports] != ['bifrost']:
    raise SystemExit('policy must be Bifrost-only (operator 2026-09-03: Bifrost LLM gateway primary)')
if review.get('dispatch_mode') != 'ordered':
    raise SystemExit('policy must use ordered persona dispatch for the Bifrost-only default')
if {item.get('name'): item.get('dispatch_weight') for item in transports} != {'bifrost': 1}:
    raise SystemExit('active provider weights must keep the single Bifrost lane at weight 1')
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
if any(item.get('reasoning_effort') not in ('medium', 'none') for item in transports):
    raise SystemExit("live transports must use reasoning_effort 'medium' or 'none' (REL-525: 'high' overran the 65536 budget on 2 of 6 lanes)")
if any(not isinstance(item.get('max_tokens'), int) or item.get('max_tokens') < 65536 for item in transports):
    raise SystemExit('live transports must declare an explicit max_tokens budget of at least 65536')
bifrost = next((item for item in configured_transports if item.get('name') == 'bifrost'), None)
ollama = next((item for item in configured_transports if item.get('name') == 'ollama'), None)
gemini = next((item for item in configured_transports if item.get('name') == 'gemini'), None)
synthetic = next((item for item in configured_transports if item.get('name') == 'synthetic'), None)
openrouter = next((item for item in configured_transports if item.get('name') == 'openrouter-primary'), None)
if not openrouter or not ollama or not gemini or not synthetic or not bifrost:
    raise SystemExit('policy must define named OpenRouter, Gemini, Ollama, Synthetic, and Bifrost transports')
if gemini.get('enabled') is not False or ollama.get('enabled') is not False or bifrost.get('enabled') is not True:
    raise SystemExit('Bifrost must be the only enabled transport; Gemini and Ollama must stay declared-but-disabled')
if synthetic is None or synthetic.get('enabled') is not False:
    raise SystemExit('Synthetic must be declared-but-disabled (retired)')
if openrouter is None or openrouter.get('enabled') is not False:
    raise SystemExit('OpenRouter must be declared-but-disabled (retired)')
if any(item.get('name') == 'fireworks' for item in transports):
    raise SystemExit('Fireworks transport must be disabled')
fireworks = next((item for item in configured_transports if item.get('name') == 'fireworks'), None)
if not fireworks or fireworks.get('enabled') is not False:
    raise SystemExit('Fireworks must remain declared with enabled: false')
if (gemini.get('base_url'), gemini.get('api_key_env'), gemini.get('model'), gemini.get('compat')) != (
    'https://generativelanguage.googleapis.com/v1beta/openai', 'GEMINI_API_KEY', 'gemini-3.7-flash', 'openai'
):
    raise SystemExit('Gemini must remain pinned to the Google OpenAI-compatible contract')
if (synthetic.get('base_url'), synthetic.get('api_key_env'), synthetic.get('model'), synthetic.get('compat')) != (
    'https://api.synthetic.new/openai/v1', 'SYNTHETIC_API_KEY', 'hf:zai-org/GLM-5.3-Flash', 'openai'
):
    raise SystemExit('Synthetic must remain pinned to its OpenAI-compatible contract')
if (synthetic.get('max_in_flight'), synthetic.get('concurrency_scope'), synthetic.get('quota_probe')) != (
    5, 'model', 'synthetic-v2'
):
    raise SystemExit('Synthetic must retain the five-pack per-model ceiling plus quota-bounded admission')
if synthetic.get('quarantine_on_timeout') is not False:
    raise SystemExit('Synthetic timeouts must remain lane-local so one slow lane cannot quarantine the transport for the run')
if review.get('openrouter_max_attempts') != '2':
    raise SystemExit('each transport must retain one retry')
budget = review.get('budget')
if not isinstance(budget, dict):
    raise SystemExit('policy must keep lane limits in review_yeti.budget')
for key in ('lane_deadline_ms', 'lane_overhead_ms', 'lane_call_budget', 'max_review_assignments', 'max_investigation_turns'):
    if key not in budget:
        raise SystemExit(f'policy budget is missing {key}')
if openrouter is None:
    openrouter = next((item for item in configured_transports if item.get('name') == 'openrouter-primary'), None)
if openrouter is None:
    raise SystemExit('policy must define the openrouter-primary transport (declared, disabled)')
if openrouter.get('stream') is not True:
    raise SystemExit('openrouter-primary must use streaming for provider attribution')
if openrouter.get('model') != 'z-ai/glm-5.3-flash':
    raise SystemExit('openrouter-primary must use the explicit GLM-5.3 Flash route')
if openrouter.get('models') != ['deepseek/deepseek-v4-flash-0731']:
    raise SystemExit('openrouter-primary must use DeepSeek V4 Flash 0731 as its only model fallback')
if (openrouter.get('max_in_flight'), openrouter.get('capacity_wait_timeout_ms')) != (2, 180000):
    raise SystemExit('openrouter-primary must bound large-diff concurrency and queue admission at 2/180000ms')
if 'plugins' in openrouter:
    raise SystemExit('openrouter-primary must not use the Auto Router plugin')
if openrouter.get('structured_output') != 'strict':
    raise SystemExit('openrouter-primary must use strict investigation output')
if openrouter.get('allow_banned_providers') is not None:
    raise SystemExit('openrouter-primary must not use the deprecated provider-ban override')
if openrouter.get('quarantine_on_timeout') is not False:
    raise SystemExit('OpenRouter must own timeout rerouting without dynamic provider bans')
routing = openrouter.get('provider_routing') or {}
if routing.get('ignore') != ['morph', 'fireworks']:
    raise SystemExit('openrouter-primary must exclude the verified Morph and Fireworks outages')
if routing.get('allow_fallbacks') is not True:
    raise SystemExit('openrouter-primary must allow cheap hosts to fall')
if routing.get('sort') != 'throughput':
    raise SystemExit('openrouter-primary must sort by throughput')
if 'quantizations' in routing:
    raise SystemExit('openrouter-primary must delegate quantization to live routing')
if routing.get('preferred_min_throughput') != {'p90': 40}:
    raise SystemExit('openrouter-primary must enforce the p90 throughput floor')
if routing.get('preferred_max_latency') != {'p99': 3}:
    raise SystemExit('openrouter-primary must enforce the p99 latency preference')
if routing.get('only') or routing.get('order'):
    raise SystemExit('openrouter-primary must not pin provider.only or provider.order')
if review.get('openrouter_stream') != 'true':
    raise SystemExit('global openrouter_stream must be true so configured transports use SSE TTFT')
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
max_attempts = int(review['openrouter_max_attempts'])
max_investigation_turns = int(budget['max_investigation_turns'])
transport_connect_sum_ms = sum(t['connect_timeout_ms'] for t in transports)
transport_stall_sum_ms = sum(t['stall_ms'] for t in transports)
stall_envelope_ms = transport_connect_sum_ms + transport_stall_sum_ms
worst_case_dead_call_ms = stall_envelope_ms * max_attempts * max_investigation_turns
required_lane_budget_ms = worst_case_dead_call_ms + lane_overhead_ms
if required_lane_budget_ms > lane_deadline_ms:
    raise SystemExit(
        f'worst-case dead-transport budget ({worst_case_dead_call_ms}ms = ({transport_connect_sum_ms}ms '
        f'connect + {transport_stall_sum_ms}ms stall) across {len(transports)} transports x '
        f'{max_attempts} attempts x {max_investigation_turns} turns) plus lane overhead reserve '
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
# Raised 60000->75000 (REL-499): example-api PR #4764 showed two of six persona lanes time out on
# openrouter-primary and fail over, with one lane exhausting every transport into a BLOCK verdict.
# example-meta ADR 0481 records the incident and the decision to widen the OpenRouter TTFT/stall
# window (deepseek/deepseek-v4-flash-0731 on openrouter.ai) rather than reopen Fireworks admission.
if review.get('openrouter_ttft_ms') != '75000':
    raise SystemExit('openrouter_ttft_ms must preserve the qualified 75000ms large-diff first-token budget')
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
attempts = int(review['openrouter_max_attempts'])
turns = int(review['budget']['max_investigation_turns'])
enabled = [item for item in review['transports'] if item.get('enabled') is True]
base_sum = sum(item['connect_timeout_ms'] + item['stall_ms'] for item in enabled)
# Smallest overhead that makes required exceed the lane deadline:
required_without_overhead = base_sum * attempts * turns
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
# once but overflows once multiplied by openrouter_max_attempts x max_investigation_turns.
write_transport_retry_budget_overflow_policy() {
  python3 - "$repo_root/policy/review-yeti.json" "$tmp_dir/policy/review-yeti.json" <<'PY'
import json
import sys

source, destination = sys.argv[1:]
policy = json.load(open(source))
review = policy['review_yeti']
# Ollama-only: ollama's six-lane/90s contract is hard-pinned, so this fixture
# overflows the lane deadline by multiplying the investigation-turn budget
# (the same worst-case dead-transport sum, more turns).
turns = int(review['budget']['max_investigation_turns'])
review['budget']['max_investigation_turns'] = str(turns * 3)
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
    * int(review['openrouter_max_attempts'])
    * int(budget['max_investigation_turns'])
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
next(item for item in review['transports'] if item['name'] == 'openrouter-primary')['ttft_ms'] = 30_000
if stream_scope == 'transport':
    next(item for item in review['transports'] if item['name'] == 'bifrost')['stream'] = False
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
if [item.get('name') for item in plan] != ['bifrost']:
    raise SystemExit('base64 transport plan must be Bifrost-only (operator 2026-09-03)')
if any(item.get('stream') is not True for item in plan):
    raise SystemExit('base64 transport plan must preserve streaming for every transport')
PY
grep -A1 '^openrouter_data_collection<<' "$tmp_dir/valid.output" | grep -qx 'deny'
grep -A1 '^openrouter_ignore_providers<<' "$tmp_dir/valid.output" | grep -Fx 'morph,fireworks'
grep -A1 '^openrouter_provider_routing<<' "$tmp_dir/valid.output" | grep -Fq '"ignore":["morph","fireworks"]'
grep -qx 'v1' "$tmp_dir/valid.output"
grep -q '^repository<<' "$tmp_dir/valid.output"
grep -qx 'review-yeti-ai/review-yeti-bot' "$tmp_dir/valid.output"
grep -q '^lane_call_budget<<' "$tmp_dir/valid.output"
grep -qx '24' "$tmp_dir/valid.output"
grep -q '^max_review_assignments<<' "$tmp_dir/valid.output"
grep -q '^max_incremental_diff_chars<<' "$tmp_dir/valid.output"
grep -qx '60000' "$tmp_dir/valid.output"

run_case valid-lane-deadline lane_deadline_ms 1080000 0
grep -q '^lane_deadline_ms<<' "$tmp_dir/valid-lane-deadline.output"
grep -qx '1080000' "$tmp_dir/valid-lane-deadline.output"

run_case valid-investigation-turns max_investigation_turns 2 0
grep -q '^max_investigation_turns<<' "$tmp_dir/valid-investigation-turns.output"
grep -qx '2' "$tmp_dir/valid-investigation-turns.output"

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
    run_case "$name" "transport.3.${field}" "$value" 1
    grep -q "transport synthetic.${field} must be an integer between 1ms and 180000ms" "$tmp_dir/${name}.log"
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
openrouter = next(item for item in policy['review_yeti']['transports'] if item['name'] == 'openrouter-primary')
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
  grep -q 'openrouter-primary.timeout_ms must equal review_yeti.openrouter_timeout_ms' "$tmp_dir/invalid-openrouter-timeout.log"
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

run_openrouter_timeout_mismatch_case
run_short_lane_deadline_case
run_case invalid-openrouter-capacity-wait transport.0.capacity_wait_timeout_ms 179999 1
grep -q 'openrouter-primary.capacity_wait_timeout_ms must cover the OpenRouter request retry envelope' "$tmp_dir/invalid-openrouter-capacity-wait.log"
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

# Exact repository overrides are resolved centrally. Example API gets only Ollama with a
# six-lane/30-second admission envelope; unrelated consumers retain the default.
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
    raise SystemExit('Example API must emit only the Bifrost transport (operator 2026-09-03)')
bifrost = transports[0]
if (bifrost.get('max_in_flight'), bifrost.get('concurrency_scope'), bifrost.get('capacity_wait_timeout_ms'), bifrost.get('connect_timeout_ms'), bifrost.get('max_wall_clock_ms')) != (6, 'provider', 30000, 90000, 900000):
    raise SystemExit('Example API Bifrost admission must cover the six-persona panel, a 90s connect deadline, and a 15-minute live thinking stream')
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
    raise SystemExit(f'{sys.argv[2]} must emit only the Bifrost transport (operator directive 2026-09-03)')
if transports[0].get('max_in_flight') != 6 or transports[0].get('connect_timeout_ms') != 90000:
    raise SystemExit(f'{sys.argv[2]} Bifrost admission must cover the six-persona panel and a 90s connect deadline')
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

# 2c. The publish axis cannot be bypassed by omitting its signal either: a doks run with no
#     REVIEW_YETI_DOKS_PUBLISH_MODE must fail, because the action's own default is "disabled"
#     and such a run accepts the dispatch and never reports a verdict for the head.
#     Incremental is cleared first so this isolates the publish axis: the incremental guard
#     runs earlier and would otherwise report its own (different) incoherence.
write_incremental_policy missing
set +e
(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-api REVIEW_YETI_RESOLVED_BACKEND=doks GITHUB_OUTPUT="$tmp_dir/backend-doks-nopublish.output" node emit-policy.mjs) >"$tmp_dir/backend-doks-nopublish.log" 2>&1
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

# 3. The identical repository allowlist must pass once the resolved backend is local -- the only
#    backend that implements incremental review.
(cd "$tmp_dir/scripts" && REVIEW_REPOSITORY=exampleorg/example-api REVIEW_YETI_RESOLVED_BACKEND=local GITHUB_OUTPUT="$tmp_dir/backend-local-allowed.output" node emit-policy.mjs >/dev/null)
grep -A1 '^incremental_enabled<<' "$tmp_dir/backend-local-allowed.output" | grep -qx 'true'
echo "[incremental-backend-local-allowed] passed"

echo "emit-policy incremental-backend invariant contract passed"

echo "emit-policy action channel and lane_call_budget contract passed"
