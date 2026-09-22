# Prior promoted validator compatibility fixture

These two scripts are verbatim copies from commit
`b9d69e76dedc757f6ed7f19be9657dd99c11b953` of example-review-actions (the locally
recorded promoted v1 when the manual-input repair was reviewed).

Keep this fixture immutable: it deliberately lacks the new normalization
export. The receiver test executes the actual workflow normalization shell
with this older checkout, then feeds its output through the older validator,
including live-state validation with an injected GitHub transport. This catches
main/v1 skew without fetching remote code or depending on local Git history in CI.
No tokens or live dispatches are used.
