# Skip the moderator on empty, fully covered runs

Flag: `REVIEW_YETI_SKIP_EMPTY_MODERATION` on the publishing worker. It is **off by default and is not enabled anywhere**.
Issue: REL-1139, from §6 #12 of the 2026-09-25 calibration report. Policy: ct-meta ADR 0687 (status proposed). Do not turn the flag on in production before that ADR is accepted.

Code:
- `src/review/emptyModeration.ts` is the one shared decision (`decideEmptyModeration`), the flag grammar and the published reason.
- `src/panel/emptyModerationSkip.ts` reduces the panel's plans and disclosures to the decision's facts and builds the deterministic moderator result.
- `src/panel/panelEngine.ts` evaluates the decision on every run and skips the moderator call only when the flag is also on.
- `src/review/workerReviewCompletion.ts` (`deriveCanonicalWorkerReviewEvidence`) re-runs the same decision on the trusted side.

## What it does

When the flag covers the repository and the run is eligible, the panel engine does not call the **moderator**. It uses a deterministic `RECONCILED` result with an empty ledger (model `skipped-empty-moderation`, zero cost), and sets `moderation: 'skipped-empty'` on the result.

Nothing else changes:
- **The arbiter still runs**, on the empty ledger.
- Lanes always run, and file depth is never reduced.
- The verdict is still computed from the lane findings (`computeArbitration`). On an eligible run every lane approved with no findings, so it is `SHIP`.

The worker's check summary carries one line saying the moderator was skipped and why. The worker's completion carries `moderation: 'skipped-empty'`.

## Eligibility (the shared decision)

Every condition must hold. Any other shape calls the moderator exactly as before. A missing or malformed fact counts as ineligible.

| Reason when not eligible | Condition that fails |
| --- | --- |
| `no-lanes` | There is at least one required lane, and at least one lane result. |
| `lane-failed` | No lane failed, timed out, errored or is in `optionalFailures`. |
| `lane-missing` | The lanes that returned are exactly the required roster. |
| `lane-not-applicable` | No lane was replaced by a synthetic not-applicable result. |
| `lane-not-approve` / `lane-findings` | Every lane decided APPROVE with zero findings of any severity. |
| `coverage-incomplete` | Coverage is complete: no unreadable diff header, and quorum is satisfied. |
| `security-sensitive-file` | No changed file matches the REL-1135 predicate (`isSecuritySensitivePath`), which covers lockfiles, toolchain pins, manifests, CI, IaC and auth, crypto and secrets paths. |
| `truncated` / `patch-unavailable` / `omitted-source` | The REL-1092 disclosures are all empty. |
| `routed-files` / `uncovered-paths` | No file was routed to a lane outside its paths, and no path is uncovered. |
| `reduced-depth` | Nothing was shrunk (W2), budget-reduced or unbudgeted (W5), or map-reduced (W6). |
| `incremental-carry-forward` / `verdict-cache-served` | Nothing was carried forward (W7) or served from the verdict cache (W8). |
| `analyzer-hypotheses` | No static-analyzer hypothesis was waiting for adjudication. |

## Worker and trusted completion agree

The trusted completion context (`authoritativeCompletionContext.ts`) already runs the same `resolveReviewApplicability` on the exact-head diff. It now also passes that decision's truncated, unavailable, omitted, routed and uncovered counts in its coverage contract.

When a completion claims `moderation: 'skipped-empty'`, `deriveCanonicalWorkerReviewEvidence` runs `decideEmptyModeration` on the trusted roster, lanes, coverage and changed paths, and on those counts. It refuses the completion as invalid evidence when:
- the decision is not eligible;
- the canonical verdict is not SHIP;
- the contract carries no disclosures;
- the completion is a documentation-only exemption.

A completion without the claim is unaffected.

A few facts are visible only to the worker: W2, W5 and W6 depth reductions, and analyzer hypotheses. On those the worker is the stricter side. Everything the service can see, it re-decides.

## Shadow telemetry (on every run, whatever the flag says)

The `Panel phase timing` line carries:
- `moderator_shadow_skip_eligible`: `true` or `false`;
- `moderator_shadow_skip_reason`: the first failing condition, when not eligible;
- `moderation`: `called` or `skipped-empty`.

This is the evidence ADR 0687 asks for while the flag stays off:

```logsql
_time:7d event:"panel_phase_timing"
| stats count() runs, count() if (moderator_shadow_skip_eligible:"true") eligible
```

The reason breakdown: `... | stats by (moderator_shadow_skip_reason) count()`.

## Enabling (after ADR 0687 is accepted)

The flag uses the same grammar as `REVIEW_YETI_INCREMENTAL`:

| Setting | Effect |
| --- | --- |
| unset, empty, `0`, `false`, `off` | Off (the default). |
| `1`, `true`, `on`, `all` | On for every repository. |
| `owner/repo,owner/other` | On only for the listed repositories. The list is comma- or space-separated and case-insensitive. |

In Helm the value is `publishing.skipEmptyModeration`, which is empty by default. The operator Deployment gets `REVIEW_YETI_SKIP_EMPTY_MODERATION`, and the operator passes a non-empty value unchanged to app-gate worker Jobs only. It refuses to create a Job if the value contains a line break. To revert, set the value back to empty.

## Projected saving (VictoriaLogs, 2026-09-24T13:24Z to 2026-09-26T13:19Z, before the flag existed)

| Measure | Value |
| --- | --- |
| Panel runs | 469 |
| Would be eligible (every lane 0 findings, no failed lane outcome, nothing truncated, no security-sensitive file) | **110 (23.5%)**, from 102 distinct PRs |
| Verdict on those runs | 110 of 110 SHIP; 0 had a published finding |
| Excluded by the security-sensitive rule alone | 75 runs. ADR 0687's upper-bound query, which has no sensitive-file exclusion, counts 185. |
| Moderator share of all tokens, every-call basis | 2.8% (n=54 token-accounting lines since 09-25T17:33Z) |
| Moderator tokens per run | Median 3.1k over all runs; median 2.5k on eligible runs (n=8) |
| Projected token saving at `all` | About 0.3% to 0.7% of all tokens. The low figure is the n=8 direct sample; the high figure is 23.5% × 2.8%. |
| Moderator wall time | p50 15.5s and p90 63s over all runs (n=49). On eligible runs, p50 1.5s and max 67s (n=8). |

The saving is small. The calibration report's "about 20%" for the moderator plus the arbiter was an artifact of counting only each lane's last turn. The main effect is removing one serial call, and one failure mode, from the tail of about a quarter of runs.

The eligible-run token and timing samples are small (n=8), because both lines only exist since 1.92.7. The shadow field above closes that gap.
