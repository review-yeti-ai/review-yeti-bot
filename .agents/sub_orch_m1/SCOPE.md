# Scope: Milestone 1 — Core Foundations, Config Parser & Diff State Persistence

## Overview
Milestone 1 establishes the bedrock of `ct-review-bot`:
1. **Scaffold & Build Setup**: Node.js + TypeScript environment with `package.json`, `tsconfig.json`, Vitest/Jest test runner, build scripts (`npm run build`, `npm test`).
2. **Config Loader & Parser** (`src/config/`): Load and parse `.ct-review.yaml` and `.coderabbit.yaml`, merge with org defaults, Zod schema validation.
3. **Ticket Linkage Engine** (`src/ticket/ticketValidator.ts`): Validate Linear (`[PROJ-123]`), Jira (`[KEY-456]`), and GitHub (`#789` or `PROJ-789`) issue links in PR titles/bodies.
4. **Operational Constitution Engine** (`src/constitution/constitutionEngine.ts`): Parse `constitution.md` files, extract rules/directives, and evaluate compliance.
5. **Incremental Diff State Manager** (`src/persistence/diffStateManager.ts`): SHA-256 hash tracking of diff hunks and finding fingerprints to persist nit/PX status across commits in SQLite or JSON atomic storage.
6. **Unit & Integration Tests** (`tests/unit/`, `tests/integration/`): Thorough test suites proving build and 100% test pass.

## Code Layout
- `package.json`, `tsconfig.json`, `vitest.config.ts` (or `jest.config.js`)
- `src/config/configLoader.ts`, `src/config/schema.ts`, `src/config/defaultOrgConfig.ts`
- `src/ticket/ticketValidator.ts`
- `src/constitution/constitutionEngine.ts`
- `src/persistence/diffStateManager.ts`, `src/persistence/db.ts`
- `src/utils/logger.ts`, `src/utils/diffHash.ts`
- `tests/unit/config.test.ts`, `tests/unit/ticket.test.ts`, `tests/unit/constitution.test.ts`, `tests/unit/diffState.test.ts`
## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Core Foundations, Config Parser & Diff State Persistence | Scaffold, config loader, ticket validator, constitution engine, diff state persistence, unit/integration/E2E test suites | none | DONE |
