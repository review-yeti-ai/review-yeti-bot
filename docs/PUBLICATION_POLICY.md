# Review publication policy

Last updated: 2026-09-07

## Overview and findings

Each pull request has one bot-owned sticky overview. Each push or rerun replaces its contents with the latest verdict, reviewed commit, and counts. Previous rounds are not appended. Persona reports and repeated verdict reviews are not posted to the conversation timeline.

All validated file-specific findings, including P2, are published as deduplicated review conversations. Findings with exact diff anchors appear inline. When a changed file is known but its reported line cannot be anchored, the finding becomes a file-level conversation; the bot never guesses a nearby line. Invalid paths remain identified in the overview when no GitHub file conversation can represent them.

There is no default thread-count cap. Callers may still request an explicit cap through the helper API. P2 findings do not change the bot's verdict; repository conversation-resolution requirements continue to apply to review threads at every severity.

## Apply suggestions

A complete replacement can use GitHub's Apply suggestion control only on a validated new-file range. Exact indentation, multiline replacements, and empty-string deletions are preserved. Conflicting patches lose both their replacement code and range through the shared merge policy. File-level feedback and uncertain fixes remain prose.

## Publication evidence

The Action validates the current PR head before writes and after publication. Its sticky overview contains the current head and publication-attempt markers, and must be read back under the authenticated publisher identity with the expected body before publication succeeds. Inline comments are independently verified. Identical retries do not duplicate completed inline writes; a partial failure is repaired on retry.

The App publishes inline comments directly and updates its overview after they succeed. Binding verdicts are delivered through the App check run. The Action workflow gate uses its structured verdict, review-status, gate-decision, merge-eligible, and coverage outputs.

Root review records are no longer the result ledger. Downstream integrations that scraped verdict text from pull-request reviews must use the check/output contract or validate the current bot-owned sticky overview instead. Historical reviews are not deleted.

## Implementation

- Shared finding planner and replacement merge policy: `src/review/findingPublication.js`
- Action publication: `.github/workflows/pipelines/review-pipeline.js`
- App publication: `src/app.ts`, `src/github/commentPublisher.ts`, `src/github/panelPublication.ts`

The Action resolves only its own outdated conversations; current or human-authored threads remain untouched. A resolved finding may still be reported again if the next review independently finds the defect.

Deployment of the updated Action/App is required before existing consumer runs use this policy.
