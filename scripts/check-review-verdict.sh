#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REVIEW_REPOSITORY:?REVIEW_REPOSITORY is required}"
: "${REVIEW_PR_NUMBER:?REVIEW_PR_NUMBER is required}"
: "${EXPECTED_BASE_SHA:?EXPECTED_BASE_SHA is required}"
: "${EXPECTED_HEAD_SHA:?EXPECTED_HEAD_SHA is required}"
# REVIEW_STATUS/GATE_DECISION/MERGE_ELIGIBLE/FILES_OMITTED default to empty
# (rather than `:?`-crashing) so a failure in an earlier workflow step -- which
# leaves every review-action output empty -- is reported as the clean
# "did not produce a verdict" error below instead of a raw parameter-expansion
# crash that obscures the actual failed setup step.
: "${REVIEW_STATUS:=}"
: "${GATE_DECISION:=}"
: "${MERGE_ELIGIBLE:=}"
: "${FILES_OMITTED:=}"
# DISPATCH_REFLECTION_STATUS and PROVIDER_RECEIPT_DIGEST are legitimately empty
# on a verdict where zero review lanes ran -- either a non-SHIP verdict (e.g.
# INCOMPLETE_REVIEW/BLOCKED) or the "no reviewable files remained after policy
# exclusion(s)" trivial SHIP (example-api #4386: a PR touching only an excluded
# generated file). The upstream review-yeti-bot action never emits these two
# outputs for a zero-lane run, so a bare `:?` here crashes AFTER a verdict was
# already published, turning a legitimate SHIP into a red gate.
#
# Do not `:?`-crash the whole script on either one. Once the run report is
# parsed below, the lane-count-gated checks decide whether their absence is
# expected (lane_count == 0) or a fail-closed BLOCK (lane_count > 0, i.e. a
# real review ran and MUST have produced both).
: "${DISPATCH_REFLECTION_STATUS:=}"
: "${PROVIDER_RECEIPT_DIGEST:=}"

metadata="$(gh api "repos/${REVIEW_REPOSITORY}/pulls/${REVIEW_PR_NUMBER}")"
actual_base="$(jq -r '.base.sha // empty' <<<"$metadata")"
actual_head="$(jq -r '.head.sha // empty' <<<"$metadata")"

[[ "$actual_base" == "$EXPECTED_BASE_SHA" ]] || { echo "::error::Review became stale because the PR base changed"; exit 1; }

# See validate-review-request.sh for the full rationale: a superseded head means a newer run
# already owns this PR, so cancel instead of failing a dead SHA. Only this branch may cancel;
# every other check below keeps a plain exit 1, and this branch's own exit code stays non-zero
# regardless of whether cancellation is confirmed -- a SHIP/PASS verdict must never be accepted
# for a head that no longer matches the PR.
if [[ "$actual_head" != "$EXPECTED_HEAD_SHA" ]]; then
  echo "::notice::Review became stale because the PR head changed from $EXPECTED_HEAD_SHA to $actual_head. Self-cancelling instead of failing a superseded SHA that no longer blocks merge."
  "$(dirname "${BASH_SOURCE[0]}")/self-cancel-run.sh" || true
  exit 1
fi

[[ -n "$REVIEW_STATUS" ]] || {
  echo "::error::Review Yeti did not produce a verdict; an earlier workflow step failed"
  exit 1
}

if [[ "$REVIEW_STATUS" == "DISPATCHED" && "$GATE_DECISION" == "PENDING" ]]; then
  echo "::notice::Review Yeti dispatched asynchronously to DOKS queue. Verdict enforcement will be reported via Review Yeti GitHub App gate."
  if [[ -f "$(dirname "${BASH_SOURCE[0]}")/otel-metrics.mjs" ]]; then
    node "$(dirname "${BASH_SOURCE[0]}")/otel-metrics.mjs" emit-dispatch \
      --repo "$REVIEW_REPOSITORY" \
      --pr "$REVIEW_PR_NUMBER" \
      --status "success" \
      --backend "kubernetes" >/dev/null 2>&1 || true
  fi
  exit 0
fi

[[ "$REVIEW_STATUS" == SHIP ]] || { echo "::error::Review Yeti verdict is ${REVIEW_STATUS}, not SHIP"; exit 1; }
[[ "$GATE_DECISION" == PASS ]] || { echo "::error::Review Yeti gate decision is ${GATE_DECISION}, not PASS"; exit 1; }
[[ "$MERGE_ELIGIBLE" == true ]] || { echo "::error::Review Yeti did not declare this exact-head review merge eligible"; exit 1; }
[[ "$FILES_OMITTED" == 0 ]] || { echo "::error::Review Yeti omitted ${FILES_OMITTED} changed files"; exit 1; }
[[ -n "${RUN_REPORT_PATH:-}" ]] || { echo "::error::Review Yeti run report path is missing"; exit 1; }

[[ -f "$RUN_REPORT_PATH" ]] || { echo "::error::Review Yeti run report is missing: ${RUN_REPORT_PATH}"; exit 1; }

report_summary="$({
  jq -er \
    --arg expected_repository "$REVIEW_REPOSITORY" \
    --arg expected_pr "$REVIEW_PR_NUMBER" \
    --arg expected_base "$EXPECTED_BASE_SHA" \
    --arg expected_head "$EXPECTED_HEAD_SHA" \
    --arg expected_status "$REVIEW_STATUS" \
    '
      def nonnegative_integer:
        type == "number" and floor == . and . >= 0;
      def valid_pr_number:
        if (.prNumber | type) != "number" then
          false
        elif (.prNumber | floor) != .prNumber then
          false
        else
          .prNumber == ($expected_pr | tonumber)
        end;
      def valid_lane:
        type == "object"
        and (.decision | type == "string")
        and (.findings | type == "array")
        and (.severity | type == "object")
        and ((.severity) as $severity
          | (["P0", "P1", "P2"] | all(.[]; . as $key | ($severity[$key] | nonnegative_integer))));
      def valid_finding:
        type == "object"
        and (.severity == "P0" or .severity == "P1" or .severity == "P2");
      # scope.chainDepth is optional (older reports and any report from a transport that never
      # ran an incremental "trusted repair delta" lane omit it entirely); when present it must be
      # a nonnegative integer, never a malformed or negative value silently accepted.
      def valid_chain_depth:
        . == null or (type == "number" and floor == . and . >= 0);
      # A lane whose evidence was reused from a prior run (evidenceSource == "parent", i.e. the
      # incremental "trusted repair delta" mode did not re-review that lane on this exact head)
      # must never carry unresolved P0/P1 findings forward under a SHIP verdict -- SHIP means
      # this exact head is clear, and a reused lane cannot attest to that for a diff it never
      # examined. P2-only reused lanes remain advisory, same as a live lane P2 finding.
      def has_blocking_reused_lane:
        any(.lanes[]?; .evidenceSource == "parent"
          and (((.severity.P0 // 0) > 0) or ((.severity.P1 // 0) > 0)));

      if .schemaVersion != "review-run-report-v1" then
        error("unsupported run-report schema")
      elif (.repository | type) != "string" or .repository != $expected_repository then
        error("run-report repository does not match the reviewed repository")
      elif (valid_pr_number | not) then
        error("run-report PR number does not match the reviewed PR")
      elif .baseSha != $expected_base or .headSha != $expected_head then
        error("run-report base/head does not match the exact reviewed head")
      elif .verdict != $expected_status then
        error("run-report verdict does not match the action output")
      elif (.lanes | type) != "array" then
        error("run-report lanes are missing")
      elif any(.lanes[]; valid_lane | not) then
        error("run-report contains an invalid lane")
      elif any(.lanes[]?.findings[]?; valid_finding | not) then
        error("run-report contains an invalid finding")
      elif (.scope.chainDepth | valid_chain_depth | not) then
        error("run-report scope.chainDepth must be a nonnegative integer")
      elif .verdict == "SHIP" and has_blocking_reused_lane then
        error("run-report carries a reused lane with blocking findings under a SHIP verdict")
      else
        ([.lanes[]?.findings[]? | select(.severity == "P2")] | length) as $finding_p2
        | ([.lanes[]?.severity.P2] | add // 0) as $summary_p2
        | if $finding_p2 != $summary_p2 then
            error("run-report P2 count is inconsistent")
          else
            { p2_count: $finding_p2, lane_count: (.lanes | length) }
          end
      end
    ' \
    "$RUN_REPORT_PATH"
} 2>&1)" || {
  echo "::error::Review Yeti run report failed closed: ${report_summary}";
  exit 1;
}

# P2 is advisory: report it, do not fail on it. An advisory that blocks is not an advisory.
#
# The bot's verdict engine already applies severity thresholds to DEDUPED cluster counts --
# `p2Count >= fixP2` escalates SHIP to FIX_FIRST on its own. This gate was applying a second,
# stricter opinion to RAW per-lane P2 counts, so a run could legitimately reach `Verdict: SHIP`
# and still get a red required check. Observed live: example-api run 32369789786 / PR #4425 --
# `[Verdict] SHIP` followed by `1 unresolved P2 advisory finding(s); SHIP/PASS is blocked`.
# #152's near-duplicate clustering widened the split further: three lanes reporting one nit
# count once for the verdict and three times here.
#
# Option A of the three written up in example-meta docs/plans/2026-08-20-review-yeti-known-gaps.md.
# P0/P1 gating is untouched -- only the advisory tier stops failing the check.
p2_count="$(jq -er '.p2_count' <<<"$report_summary")"
if [[ "$p2_count" != 0 ]]; then
  echo "::warning::Review Yeti reported ${p2_count} unresolved P2 advisory finding(s); advisory only, not blocking";
  jq -r '.p2_findings[]? | "::warning::P2 advisory: \(.path // "?"):\(.line // "?") \(.title // .summary // "")"' <<<"$report_summary" 2>/dev/null || true;
fi

lane_count="$(jq -er '.lane_count' <<<"$report_summary")"
if [[ "$lane_count" -eq 0 ]]; then
  # Zero review lanes ran (e.g. "no reviewable files remained after policy
  # exclusion(s)"). The upstream action never emits dispatch-reflection-status
  # or a provider-receipt-digest for a run that dispatched no lanes, so their
  # absence here is the *expected* shape, not a defect. But if either field IS
  # present, it must be internally consistent -- a zero-lane run claiming a
  # non-"complete" reflection status, or a receipt digest for a review that
  # never called a model, is a contradiction and fails closed rather than
  # being silently accepted.
  [[ -z "$DISPATCH_REFLECTION_STATUS" || "$DISPATCH_REFLECTION_STATUS" == complete ]] || {
    echo "::error::Review Yeti dispatch reflection is ${DISPATCH_REFLECTION_STATUS} on a zero-lane run, which is inconsistent";
    exit 1;
  }
  [[ -z "$PROVIDER_RECEIPT_DIGEST" || "$PROVIDER_RECEIPT_DIGEST" =~ ^[0-9a-fA-F]{64}$ ]] || {
    echo "::error::Review Yeti provider receipt digest is invalid";
    exit 1;
  }
else
  # A real review ran at least one lane: both fields are mandatory and must
  # hold their normal, strict values. This branch is unchanged from before --
  # nothing about the zero-lane accommodation above loosens this gate.
  [[ "$DISPATCH_REFLECTION_STATUS" == complete ]] || {
    echo "::error::Review Yeti dispatch reflection is ${DISPATCH_REFLECTION_STATUS}, not complete";
    exit 1;
  }
  [[ "$PROVIDER_RECEIPT_DIGEST" =~ ^[0-9a-fA-F]{64}$ ]] || {
    echo "::error::Review Yeti provider receipt digest is missing or invalid";
    exit 1;
  }
fi

if [[ "$lane_count" -eq 0 ]]; then
  if [[ "${REVIEW_YETI_PASSTHROUGH:-}" == "true" ]]; then
    # Passthrough emits NO_REVIEW and never reaches here, so a SHIP carrying zero
    # lanes under passthrough is a synthetic verdict from some other path. This
    # branch used to accept it and print "Review Yeti: SHIP (Passthrough Mode)"
    # above a body stating no review was completed -- a heading that asserted an
    # approval its own text denied. Reject it instead: nothing reviewed this head.
    summary_line="NO_REVIEW: Review Yeti is in passthrough mode for ${REVIEW_REPOSITORY}#${REVIEW_PR_NUMBER} at exact head ${EXPECTED_HEAD_SHA}. No review was completed, so this is not an approval."
    echo "::error::${summary_line}"
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      {
        echo "### 🛑 Review Yeti: NO_REVIEW (Passthrough Mode)"
        echo "${summary_line}"
      } >>"$GITHUB_STEP_SUMMARY"
    fi
    exit 1
  else
    # A SHIP verdict with zero lanes means nothing was reviewed -- every
    # changed file was excluded by policy (e.g. example-api #4386: the PR's only
    # file was a generated priv/repo/structure.sql). That is a legitimate
    # outcome for a generated-file-only PR, but it must never be reported or
    # counted the same as an actual multi-persona review. Do not fail the
    # gate here -- blocking would wedge every legitimate generated-file-only
    # PR and push people toward --admin, which is worse. Instead, report the
    # outcome under a name a human (or a required-checks policy) can tell
    # apart from real review evidence: NO_REVIEWABLE_CONTENT, not "accepted".
    summary_line="NO_REVIEWABLE_CONTENT: Review Yeti dispatched zero review lanes for ${REVIEW_REPOSITORY}#${REVIEW_PR_NUMBER} at exact head ${EXPECTED_HEAD_SHA} -- every changed file was excluded by policy. This is NOT review evidence; no persona reviewed this diff. The gate is not failed because a generated-file-only PR should not require a bot review, but nothing here should be read as an approval."
    echo "::warning::${summary_line}"
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      {
        echo "### Review Yeti: NO_REVIEWABLE_CONTENT"
        echo "${summary_line}"
      } >>"$GITHUB_STEP_SUMMARY"
    fi
    echo "$summary_line"
  fi
else
  echo "Review Yeti SHIP/PASS accepted for ${REVIEW_REPOSITORY}#${REVIEW_PR_NUMBER} at exact head ${EXPECTED_HEAD_SHA}."
fi

if [[ -f "$(dirname "${BASH_SOURCE[0]}")/otel-metrics.mjs" ]]; then
  node "$(dirname "${BASH_SOURCE[0]}")/otel-metrics.mjs" emit-verdict \
    --repo "$REVIEW_REPOSITORY" \
    --pr "$REVIEW_PR_NUMBER" \
    --verdict "$REVIEW_STATUS" \
    --p0 "${p0_count:-0}" \
    --p1 "${p1_count:-0}" \
    --p2 "${p2_count:-0}" >/dev/null 2>&1 || true
fi
