# Handoff Report: Core Foundations & Engines Architecture Specification

## 1. Observation
- Target project root: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`
- Inspected global project spec `PROJECT.md` at `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/orchestrator/PROJECT.md` lines 65-184.
- Inspected Milestone 1 scope `SCOPE.md` at `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m1/SCOPE.md` lines 1-21.
- Analyzed contract definitions for `CtReviewConfig`, `TicketValidationInput`, `TicketValidationResult`, `ConstitutionRule`, `ParsedConstitution`, and `ConstitutionEvaluationResult`.
- Confirmed project target paths:
  - Config Loader & Parser: `src/config/schema.ts`, `src/config/defaultOrgConfig.ts`, `src/config/configLoader.ts`
  - Ticket Linkage Engine: `src/ticket/ticketValidator.ts`
  - Operational Constitution Engine: `src/constitution/constitutionEngine.ts`

## 2. Logic Chain
1. **Observation**: `PROJECT.md` defines `CtReviewConfig` schema with `quorum` (`minApprovals`, `personas`, `effortLevel`), `ticketEnforcement` (`required`, `providers`, `patterns`), and `constitution` (`enabled`, `path`).
2. **Logic Step 1**: Standardizing configuration requires Zod runtime validation, fallback deep merging with `defaultOrgConfig.ts`, and translation adapter for alternative formats like `.coderabbit.yaml`.
3. **Observation**: `SCOPE.md` specifies Linear (`[PROJ-123]`), Jira (`[KEY-456]`), and GitHub (`#789` / `PROJ-789`) validation with strict vs advisory modes in `src/ticket/ticketValidator.ts`.
4. **Logic Step 2**: regex scanning across PR title and PR description/body using `matchAll` extracts ticket keys. Strict mode returns `valid: false` with descriptive error when no keys match `config.providers`, while advisory mode populates `ticketsFound` without failing.
5. **Observation**: `SCOPE.md` specifies `constitutionEngine.ts` parsing `constitution.md` files (extracting directives, forbidden patterns, guidelines) and evaluating compliance returning `{ compliant: boolean; violations: string[] }`.
6. **Logic Step 3**: Parsing AST/headings/lists from Markdown extracts structured `ConstitutionRule` items with optional compiled regexes. Evaluating inputs tests forbidden patterns against PR metadata and diffs to report all rule violations.

## 3. Caveats
- Assumptions made: Default constitution path `.github/constitution.md` will be resolved relative to repository root when file reading is wired in higher level integration.
- Areas not investigated: Milestone 2 LLM routing and Milestone 3 Quorum personas (out of scope for M1).

## 4. Conclusion
The technical architecture, module breakdown, Zod schemas, regex specifications, deep merge algorithms, markdown parsing mechanisms, error handling strategies, and test specifications for Config Loader, Ticket Linkage Engine, and Constitution Engine are fully detailed in `analysis.md`. The design is complete, unambiguous, and ready for immediate implementation by Implementer agents.

## 5. Verification Method
1. **File Inspection**:
   - Inspect `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m1_2/analysis.md` for complete TypeScript interfaces, Zod schemas, helper functions, regex patterns, parsing logic, and unit test specifications.
2. **Execution & Test Verification** (post-implementation):
   - Run `npm test` or `npx vitest run tests/unit/config.test.ts tests/unit/ticket.test.ts tests/unit/constitution.test.ts` from project root.
3. **Invalidation Conditions**:
   - If Zod schema `CtReviewConfig` in `analysis.md` fails to match the interface contract in `PROJECT.md`.
   - If regex patterns fail to detect `[PROJ-123]`, `[KEY-456]`, or `#789`.
