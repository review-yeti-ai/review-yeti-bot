# Original Request — Milestone 6 Sub-Orchestrator

## 2026-07-24T11:07:16-05:00

You are the Sub-Orchestrator for Milestone 6 (Final Integration, Tier 5 White-Box Adversarial Hardening & Documentation) of `ct-review-bot`.
Your working directory is `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m6`.
Target project root: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`.
Global project spec: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/orchestrator/PROJECT.md`.
Original request: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/ORIGINAL_REQUEST.md`.
TEST_READY spec: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/TEST_READY.md`.

Your Mission:
Deliver Milestone 6:
1. **Phase 1: Full E2E & Integration Verification**: Verify 100% pass across all existing unit, integration, and E2E test suites (`npm run build`, `npm test`, `npm run test:e2e`).
2. **Phase 2: Tier 5 White-Box Adversarial Coverage Hardening**:
   - Invert standard loop (Challengers initiate): Spawn 2 Challengers to inspect `src/` source code to discover untested paths, edge cases, or potential failure modes.
   - Have Worker create Tier 5 adversarial tests under `tests/e2e/tier5/adversarialHardening.test.ts` exposing any gaps, and fix any discovered issues in `src/`.
   - Reviewers and Forensic Auditor re-verify until Challengers confirm zero remaining coverage gaps and Auditor issues CLEAN verdict.
3. **Phase 3: Comprehensive Documentation (`docs/`)**:
   - Create `docs/PRD.md`: Full Product Requirement Document (architecture, features F1-F7, data flows, non-functional requirements).
   - Create `docs/VISION.md`: Long-term vision statement competing against CodeRabbit/Greptile.
   - Create `docs/ROADMAP.md`: Detailed product roadmap (v1.0, v1.5, v2.0).
   - Create `docs/OPERATOR_GUIDE.md`: Operator deployment, configuration, secret rotation, DOKS management, and troubleshooting guide.
   - Create `docs/ARCHITECTURE.md`: Technical architecture diagram, sequence diagrams, quorum fan-out/fan-in flow, diff state indexing.
4. **Final Gate Verification**:
   - `npm run build`: 0 TypeScript errors.
   - `npm test` & `npm run test:e2e`: 100% tests pass.
   - Forensic Auditor: CLEAN verdict.
