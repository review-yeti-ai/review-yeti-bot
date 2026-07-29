# Project: Durable PostgreSQL Vector & Graph Migration + Interactive Persona Grid UI

## Summary of Requirements
1. **R1: Durable PostgreSQL Vector & Graph Migration**
   - Migrate SQLite stores (`pr_memory.db` and `symbol_graph.db`) to Managed PostgreSQL database (`DATABASE_URL` / `POSTGRES_URL`).
   - Vector Memory: Utilize `pgvector` extension for storing and querying semantic vector code embeddings, falling back to SQLite if `pgvector` is unavailable.
   - Symbol Dependency Graph: Store AST nodes, calls, and import edges in PostgreSQL tables, supporting hierarchical recursive CTE lookups for callers/callees.
   - Schema table migration runs automatically on startup.
2. **R2: Interactive Card-Based Persona Grid UI**
   - Redesign Persona Editor (`/settings?tab=personas`) from dropdown layout into a grid of interactive Persona Cards showcasing status badges, model assignment, effort tier, and active toggle switches.
   - Clicking any card opens a slide-over drawer or modal dialog to edit system prompt template, model overrides, and confidence threshold.
3. **R3: Augmented Default Persona Prompts**
   - Analyze and update all 12 default reviewer persona prompt templates in `dashboardStore.ts` with advanced domain best practices:
     - Security: OWASP Top 10, sanitization, secrets scanning, tenant isolation.
     - Architecture: Modular coupling boundaries, DRY compliance, ADR structure alignment, code cleanliness.
     - Performance, API Contract, DevOps: CPU/memory bottlenecks, API breaking changes, CI/CD/Kubernetes YAML standards.
4. **R4: Persistence & API Synchronization**
   - Connect all augmented prompts, card settings, and PostgreSQL vector queries directly to REST API endpoints and `DashboardStore`.
5. **Acceptance Criteria**
   - `npm run build` static export and server compilation succeed with 0 errors.
   - `npm test` passes 100%.

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | PostgreSQL Vector & Graph Migration | PostgreSQL migration (pgvector fallback, AST/call/import schema, recursive CTE lookups, startup auto-migration) | none | IN_PROGRESS |
| 2 | Interactive Persona Grid UI & Augmented Prompts | Card grid UI (`/settings?tab=personas`), slide-over/modal drawer, 12 augmented persona prompts in `dashboardStore.ts` | none | PLANNED |
| 3 | Persistence, API Synchronization & Acceptance Verification | REST API endpoints sync with `DashboardStore` & PostgreSQL vector queries, build & test verification (`npm run build`, `npm test`) | M1, M2 | PLANNED |

## Code Layout
- Backend / Database: TBD by Explorer
- UI Components: TBD by Explorer
- Tests: TBD by Explorer
