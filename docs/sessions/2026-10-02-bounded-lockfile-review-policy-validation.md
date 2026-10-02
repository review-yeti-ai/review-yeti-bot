# Bounded lockfile review policy validation

## Scope

Support the optional trusted worker setting
`review_yeti.budget.max_reviewed_lockfile_patch_chars`. A shared validator admits
only numeric integers from 20,000 through 65,536. The emitter and smoke admission
call it; the execution-plan validator permits only the named additional key.
Other unknown budget keys still fail execution-plan validation.

The setting is not emitted as an ActionDispatch input or transport-plan field.
Existing execution-plan output and fixture digests remain unchanged. The isolated
shell emitter fixture includes the new helper.

## Validation

- Node 24.21.0: initial policy budget, execution plan and smoke tests, 52 passed.
- Complete emitter shell regression suite passed on Node 24.21.0.
- Execution-plan fixture verification and whitespace checks passed.
- Independent review of the source/test delta reported no P0/P1/P2 findings.

Hosted review at `402ee9f` returned SHIP with two architecture advisories.
The follow-up makes malformed budget containers fail in the helper itself and
calls the shared bound validator directly in execution-plan admission. Those
changes require a fresh exact-head review; the earlier SHIP is historical.
The follow-up Node suite passes 53 tests; emitter shell regressions, actionlint
and whitespace checks also pass. The committed central policy still omits the
cap, so this follow-up is not activation.

## Activation

This change deliberately does not add a value to the committed central policy.
Worker and authoritative-completion code must be deployed and verified first.
Only a later qualified central policy change may enable the bounded full-patch
path for newly admitted reviews. No deployment or successful hosted review is
claimed by this validation-only change.
