# Memory Provider Operations

The PR gate is deterministic and network-free. It uses sanitized VCR cassettes and workflow fixtures; it never needs Mem0, Hindsight, Supermemory, or RetainDB credentials.

Live provider evidence is collected separately with `Memory Provider Canary` (`workflow_dispatch`). The canary selects exactly one provider, generates a synthetic repository/PR/head identity, performs health/query/append/readiness checks, and uploads only a sanitized receipt. Missing credentials produce `not_configured`; they do not claim provider readiness.

Provider promotion requires:

- green provider cassette and contract tests;
- exact-head and repository isolation evidence;
- live health, accepted write, and eventual-readiness evidence;
- documented retention/deletion and idempotency semantics;
- no redaction, prompt-injection, or cross-tenant failures;
- Review Yeti workflow corpus passing with the provider selected alone.

Supermemory and RetainDB remain experimental until those gates are recorded. Provider failure degrades to GitHub-ledger-only review behavior; memory never controls arbitration or publication.
