# Review workflow fixtures

Each JSON file is a deterministic, sanitized workflow contract for `acme/review-yeti#42`.
The `github.responses`, `model.responses`, and `memory.providerResponse` sections are isolated
replay inputs; tests must not substitute live defaults. `expected` is the corresponding receipt.

Fixtures must not contain credentials, author names, raw command text or reasons, source bodies,
or strings longer than 12,000 characters. Use opaque identifiers and short normalized summaries.
