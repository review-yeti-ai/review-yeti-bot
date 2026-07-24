## 2026-07-24T13:48:38Z
You are Explorer 2 for Milestone 1 of ct-review-bot.
Your working directory is `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m1_2`.
Target project root: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`.
Global project spec: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/orchestrator/PROJECT.md`.
Milestone 1 Scope: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m1/SCOPE.md`.

Your Task:
Investigate and analyze requirements for:
1. Config Loader & Parser (`src/config/configLoader.ts`, `src/config/schema.ts`, `src/config/defaultOrgConfig.ts`):
   - Parse `.ct-review.yaml` and `.coderabbit.yaml` format.
   - Schema validation with Zod (`CtReviewConfig` matching PROJECT.md interface contract).
   - Deep merge user config with org default config (`defaultOrgConfig.ts`).
2. Ticket Linkage Engine (`src/ticket/ticketValidator.ts`):
   - Structural & regex validation for Linear (`[PROJ-123]`), Jira (`[KEY-456]`), and GitHub (`#789` or `PROJ-789`) in PR title and PR description/body.
   - Support strict enforcement mode vs advisory mode.
3. Operational Constitution Engine (`src/constitution/constitutionEngine.ts`):
   - Parse `constitution.md` files (extract directives, rules, forbidden patterns, mandatory guidelines).
   - Rule enforcement interface returning `{ compliant: boolean; violations: string[] }`.

Inspect existing project files if any.
Produce a detailed implementation specification in `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m1_2/analysis.md` and a handoff report in `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m1_2/handoff.md`. Send a completion message when done.
