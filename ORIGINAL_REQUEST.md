# Original User Request

## Initial Request — 2026-07-26T22:50:30-05:00

Redesign and build a world-class, Linear-grade real-time streaming Web Dashboard (`ct-review-bot`) with real-time SSE streaming for live GitHub review jobs, terminal log streams, active job lists, and an interactive Persona System Prompt Editor.

Working directory: /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot
Integrity mode: development

## Requirements

### R1. Real-Time Live Job Streaming Dashboard (`/dashboard/live`)
- Build an interactive real-time Live Job Viewer streaming active GitHub PR review runs via Server-Sent Events (SSE `/api/live/stream`).
- Display a live active jobs list sidebar, real-time terminal stdout/stderr stream, active persona execution progress bars, and streaming LLM token metrics.
- Support public unauthenticated SSE stream connections so GitHub PR comment links jump directly into the live agent stream.

### R2. Interactive Persona System Prompt & Settings Editor (`/dashboard/settings`)
- Build an interactive Persona Control Panel allowing users to view, test, customize, and save system prompts for all reviewer personas (`security`, `architecture`, `performance`, `quality`, `database`, `api_contract`, `reliability`, `devops`, `docs_compliance`, `finops`, `red_team`).
- Add typed REST API endpoints (`GET /api/dashboard/personas` & `PUT /api/dashboard/personas/:persona`) with persistent YAML/store overrides.

### R3. Linear-Grade Premium Dark Aesthetic & UI Redesign
- Redesign the Web UI using modern Vanilla CSS with Linear dark aesthetics (`hsl(220, 15%, 8%)`), sleek glassmorphism, responsive navigation drawers, live status pulse badges, and zero generic browser defaults.

## Acceptance Criteria

### Live Stream & Dashboard UX
- [ ] `/dashboard/live` renders a real-time active jobs sidebar, tabbed persona log viewer, and live SSE terminal log feed.
- [ ] SSE stream updates active agent logs with < 50ms latency without page reloads.

### Persona Prompt Editor & Settings
- [ ] `/dashboard/settings` renders interactive code editors for reviewing and customizing persona system prompts.
- [ ] `PUT /api/dashboard/personas/:persona` updates system prompts and persists changes across server restarts.
- [ ] 100% test pass rate across unit, integration, and UI test suites.

## Follow-up — 2026-07-27T13:22:06Z

Build a modern, production-grade Next.js / React Web Application for `ct-review-bot` styled with Shadcn/ui, Radix UI primitives, Lucide icons, and Tailwind CSS following Linear dark design principles, integrating with the stable Node.js backend API and Server-Sent Events (SSE) live streaming pipeline.

Working directory: /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot
Integrity mode: development

## Requirements

### R1. Modern Next.js React & Shadcn/ui Dashboard Frontend
- Build a modern React frontend application using Next.js / React, Shadcn/ui components (Radix primitives, Lucide icons, Tailwind CSS), and TypeScript.
- Implement responsive Linear-style dark mode layouts (`hsl(220, 15%, 8%)`), glassmorphism cards, interactive tabs, data tables, and modal dialogs.
- Pages: Overview Dashboard (`/`), Live Agent Terminal Stream (`/live`), Repositories (`/repos`), Persona System Prompt Editor (`/settings`), Integrations (`/integrations`), and GitHub App Onboarding (`/github-app`).

### R2. Real-Time SSE Event Stream & Typed API Client Integration
- Connect Next.js frontend pages to backend REST APIs (`/api/dashboard/*`, `/api/analytics/*`) and real-time Server-Sent Events (SSE `/api/live/stream`).
- Render live terminal logs, token consumption charts (Recharts / ECharts), active job progress bars, and toast notifications.

### R3. Build Pipeline & Express Static Serving Refactor
- Configure build scripts (`npm run build` outputting static assets) served seamlessly by Express backend (`src/app.ts`).
- Update automated test suite (Vitest + React Testing Library) to verify frontend component rendering and API integration.

## Acceptance Criteria

### Next.js & Shadcn/ui Web App
- [ ] Next.js React application compiles cleanly with 0 TypeScript or Tailwind errors.
- [ ] Web UI incorporates Shadcn/ui design components, Radix primitives, Lucide icons, and Linear dark styling.
- [ ] Live terminal stream (`/live`) renders real-time SSE events with < 50ms latency.
- [ ] Persona System Prompt Editor allows viewing and editing system prompts interactively.

### Quality & Build Pipelines
- [ ] Production build pipeline (`npm run build`) builds web assets into backend distribution directory seamlessly.
- [ ] 100% test pass rate across unit, integration, and UI component test suites.

## Follow-up — 2026-07-27T16:20:42-05:00

Enhance dashboard interactivity across all pages (`/`, `/live`, `/repos`, `/settings`, `/integrations`):
1. Clicking any row in the **Recent PR Review Executions** table opens a centered **Full PR Review Detail Modal** showing per-PR stats, persona verdicts, token counts, latency, and Mermaid diagrams.
2. Clicking KPI cards navigates directly to target pages or opens edit/inspection modals:
   - **Active Repositories**: Navigates cleanly to `/repos`.
   - **Monthly Spend / Cap**: Opens an **Edit Spending Cap & Budget Modal** to modify and save monthly spending limits.
   - **Memory Graph Nodes**: Opens an interactive **AST Codebase Memory Graph Inspector Modal**.
   - **Total PR Reviews**: Navigates cleanly to `/live`.
3. Enhance `/integrations` page with status badges, inline credential editing, and connection verification tests.

Working directory: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`
Integrity mode: benchmark

## Requirements

### R1. Interactive PR History & Full PR Details Modal
Make every PR row in the **Recent PR Review Executions** table clickable. Clicking a PR opens a centered modal dialog displaying per-PR metrics: total latency, token usage by model, persona verdict breakdown, file diff stats, and generated architecture diagrams.

### R2. Interactive KPI Card Navigation & Spending Cap Editor
Make all 4 top dashboard KPI cards interactive with hover effects and pointer cursors:
- **Active Repositories**: Navigates to `/repos`.
- **Monthly Spend / Cap**: Opens a budget modal allowing users to edit monthly spending cap limits and save back via `PUT /api/dashboard/config`.
- **Memory Graph Nodes**: Opens an AST graph inspection modal displaying symbol nodes, edge counts, and code memory queries.
- **Total PR Reviews**: Navigates to `/live`.

### R3. Enhanced Integrations UI & Connection Manager
Enhance `/integrations` to support instant status checks, modal credential forms for Doppler, Sentry, Jira, and Slack, and real-time connection test feedback.

## Acceptance Criteria

### Click Navigation & Modal Editing
- [ ] Clicking any PR row opens a centered PR inspection modal with full persona breakdown and stats.
- [ ] Clicking 'Monthly Spend / Cap' opens an Edit Budget Cap modal, updates the spend limit, and saves changes.
- [ ] Clicking 'Active Repositories' navigates cleanly to `/repos`.
- [ ] Clicking 'Memory Graph Nodes' opens code graph details modal.

### Quality & Test Verification
- [ ] Next.js build (`npm run build`) compiles cleanly without TypeScript or routing errors.
- [ ] Automated test suite (`npm test`) passes 100% of unit and integration tests (1,341 / 1,341 passing).

## Follow-up — 2026-07-27T23:31:21Z

<USER_REQUEST>
Conduct a comprehensive page-by-page visual and functional audit of all 6 Next.js routes (`/`, `/live`, `/repos`, `/settings`, `/integrations`, `/github-app`), capture screenshots of each page, identify UX friction points, and implement frontend & API enhancements for a world-class Linear-style application.

Working directory: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`
Integrity mode: benchmark

## Requirements

### R1. Full Page Visual Audit & Responsive Layout Polish
Audit and verify all 6 Next.js routes (`/`, `/live`, `/repos`, `/settings`, `/integrations`, `/github-app`). Ensure 100% fluid responsiveness across mobile (375px), tablet (768px), and desktop (1440px+) viewports with zero layout overlap, text clipping, or unhandled empty states.

### R2. End-to-End API Wiring & Interactive Features
Ensure every interactive modal, drawer, form control, and filter on all pages is 100% backed by working REST endpoints with real-time feedback and persistent storage:
- **Overview Dashboard (`/`)**: Clickable Recent PR rows open full PR detail modal with Mermaid diagrams; top KPI cards support interactive edit/inspect modals (`Edit Cap →`, `Inspect →`).
- **Live Stream (`/live`)**: `Stream Default Job` button triggers simulated/live SSE review streaming with terminal feed output and tabbed persona logs.
- **Repositories (`/repos`)**: `Trigger Onboarding Scan` opens repo scanner modal and generates `.ct-review.yaml`.
- **Settings / Persona Control Panel (`/settings`)**: Persona selection updates prompt editor, model dropdown, effort levels, confidence slider, and persists via `PUT /api/personas`.
- **Integrations (`/integrations`)**: Modal credential forms for Doppler, Sentry, Jira, and Slack with connection test verification (`POST /api/dashboard/integrations/:platform/test`).
- **GitHub App Onboarding (`/github-app`)**: Step-by-step onboarding wizard for App ID, Installation ID, RS256 key pair upload, and credential verification.

### R3. Quality Assurance & Automated Verification
Guarantee that `npm run build` succeeds with zero errors and `npm test` achieves a 100% pass rate across all 1,341 unit and integration tests.

## Acceptance Criteria

### Page-by-Page Audit & Visual Cleanliness
- [ ] Every route (`/`, `/live`, `/repos`, `/settings`, `/integrations`, `/github-app`) renders cleanly without visual defects.
- [ ] Playwright screenshots captured for all 6 pages.

### API & Feature Wiring
- [ ] All forms, search filters, modals, and persona prompt editors update backend state with toast feedback.
- [ ] `Stream Default Job` on `/live` populates terminal feed output.

### Verification
- [ ] Next.js static export (`npm run build`) builds cleanly.
- [ ] Test suite (`npm test`) passes 100% (1,341 / 1,341 passing).
</USER_REQUEST>

## Follow-up — 2026-07-27T22:36:25-05:00

Add an AI Providers & Models Management system accessible from the sidebar navigation (dedicated tab under `/settings?tab=models` or `/settings/models`). Users will be able to add/configure AI Providers (OpenAI, Anthropic, Google Gemini, xAI Grok, DeepSeek, Zhipu GLM, Doppler, Ollama, custom OpenAI-compatible endpoints), manage API keys, subscriptions, and enable specific models for review personas. A code generation script (`scripts/generate-omniroute-providers.ts`) will parse OmniRoute source files (`src/gateway/omniRouteClient.ts` and `src/config/schema.ts`) to auto-generate provider schemas and model registry defaults whenever OmniRoute is updated.

Working directory: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`
Integrity mode: demo

## Requirements

### R1. AI Providers & Models Configuration UI
- Add an **"AI Models & Providers"** navigation link in the sidebar leading to the dedicated models configuration interface inside Settings (`/settings?tab=models`).
- Build interactive provider cards/forms allowing users to add, edit, and toggle AI Providers (OpenAI, Anthropic, Gemini, Grok, DeepSeek, GLM, Doppler, Ollama, Custom OpenAI-compatible).
- Support provider fields: API Key, Base URL, Organization ID, Subscription Tier (e.g. Pay-as-you-go, Tier 1-5, Enterprise), and Active status toggle.
- Build a Model Registry table allowing users to register models, set max context tokens, cost per 1k prompt/completion tokens, and enable/disable models for reviewer personas.

### R2. Auto-Generator Script for OmniRoute Schemas
- Create a generator script (`scripts/generate-omniroute-providers.ts` registered as `npm run generate:providers`).
- Parse OmniRoute source files (`src/gateway/omniRouteClient.ts` and `src/config/schema.ts`) to auto-generate TypeScript provider types (`src/types/providers.generated.ts`), default model lists, and form validation schemas.
- Ensure running `npm run generate:providers` automatically updates available providers and models across the entire application without manual schema editing.

### R3. DashboardStore & Persona Assignment Sync
- Persist configured providers, API key records, and model enablement settings in `DashboardStore` (`/app/data/dashboard.json`).
- Dynamically update model dropdown selectors in the Persona Editor so any newly added or enabled model immediately becomes selectable for review personas.

## Acceptance Criteria

### UI & Navigation
- [ ] Sidebar includes "AI Models & Providers" navigation link.
- [ ] Users can add, edit, and toggle AI providers (OpenAI, Anthropic, Gemini, etc.) and model registries.
- [ ] Models enabled in the provider manager immediately appear as selectable options in the Persona Editor.

### Auto-Generator Script
- [ ] `npm run generate:providers` parses OmniRoute source files and outputs updated provider schemas & model lists.

### Persistence & Verification
- [ ] `npm run build` static export and server compilation succeed cleanly with 0 errors.
- [ ] `npm test` passes 100%.

## Follow-up — 2026-07-28T19:25:38Z

Redesign the Overview Dashboard into a clean, clutter-free Progressive Overview, add a dedicated "Memory Engine & Graph" navigation page on the sidebar (`/memory`), upgrade the Recent Reviews Table with column sorting, pagination, search, and manual refresh, and fix the Memory Graph Node, Learned Rules/Nits, and Semantic Code Search REST endpoints & UI lookup engines.

Working directory: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`
Integrity mode: demo

## Requirements

### R1. Progressive Dashboard Overview & Dedicated Memory Sidebar Page (`/memory`)
- Redesign `/` (Overview Dashboard) into a streamlined, clutter-free Progressive Overview layout:
  - High-level KPI summary header (Total Reviews, Active Repos, Cost vs Budget Cap, Memory Status).
  - Main focus on Recent PR Review Executions Table and Persona Arbitration Health.
- Add a dedicated **"Memory Engine & Graph"** sidebar navigation item (`/memory` page) housing:
  - Symbol & AST Dependency Graph Viewer (`/api/memory/graph`).
  - Learned Repository Rules & Suppressed Nits Inspector (`/api/memory/learnings`).
  - Codebase Semantic Vector & AST Search Engine (`/api/memory/search`).

### R2. Recent PR Review Executions Table UX Enhancements
- Upgrade `RecentReviewsTable` (`src/components/dashboard/recent-reviews-table.tsx`):
  - **Column Sorting**: Clickable column headers (Repository, PR Title, Verdict, Latency, Cost, Timestamp) with ascending/descending indicators.
  - **Pagination**: Page size selector (10, 25, 50 rows per page) and previous/next page navigation buttons.
  - **Search & Filtering**: Search input filtering by repository, PR number, title, or verdict.
  - **Manual Refresh Button**: Interactive refresh button triggering an API refetch.

### R3. Memory Engine & Graph Lookup API Fixes
- Fix backend REST API endpoints and UI lookup engines:
  - **Memory Graph Nodes (`/api/memory/graph`)**: Ensure querying memory graph loads and renders AST symbol nodes, caller/callee edges, and cross-repo dependencies.
  - **Learned Rules & Nits (`/api/memory/learnings`)**: Ensure querying learnings returns active repository rules, user feedback overrides, and suppressed nit patterns.
  - **Semantic Code Search (`/api/memory/search`)**: Ensure executing semantic code search returns matching code symbols, vector embeddings, and file locations with relevance scores.

### R4. Persistence & API Synchronization
- Connect all memory engine queries, table filters, and sidebar pages directly to `DashboardStore` and Memory Engine REST endpoints with complete error boundaries.

## Acceptance Criteria

### Dashboard UX & Sidebar Navigation
- [ ] Overview page is simplified into a progressive layout with top summary KPIs and primary reviews table.
- [ ] Sidebar includes "Memory Engine" (`/memory`) dedicated page housing graph node viewer, learned rules, and semantic search.
- [ ] Recent Reviews Table supports column sorting, pagination, search filtering, and manual refresh.

### Memory Engine Queries
- [ ] Memory Graph Node lookup returns active symbol nodes and dependencies.
- [ ] Learned Rules & Nits query returns active learnings and suppressed nit patterns.
- [ ] Semantic Code Search query executes vector search and displays matching code symbols with scores.

### Verification & Testing
- [ ] `npm run build` static export and server compilation succeed with 0 errors.
- [ ] `npm test` passes 100%.

## Follow-up — 2026-07-29T02:22:42Z

<USER_REQUEST>
Migrate Codebase Memory concepts (Learned Rules, Developer Feedback, and Suppressed Nits) to SQL relational tables in Managed PostgreSQL, redesign the Persona Editor into an interactive card-based card grid interface, and augment all default reviewer persona prompts with domain best practices. (Symbol dependency graph migration is out of scope for this turn).

Working directory: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`
Integrity mode: demo

## Requirements

### R1. Durable PostgreSQL Memory Concept Storage (SQL-Based)
- Migrate memory rules, developer feedback overrides, and suppressed nits from SQLite (`pr_memory.db`) to SQL relational tables in the Managed PostgreSQL database (connected via `DATABASE_URL` / `POSTGRES_URL`).
- Provide dual-store fallback logic so rules/nits save to PVC local storage if PostgreSQL is disconnected.
- Note: Symbol dependency graph database migration is out of scope for this turn and should remain unchanged.

### R2. Interactive Card-Based Persona Grid UI
- Redesign the Persona Editor ([`/settings?tab=personas`](https://review-bot.calltelemetry.com/settings?tab=personas)) layout:
  - Replace the dropdown layout with a grid of interactive **Persona Cards** showcasing status badges, model assignment, effort tier, and active toggle switches.
  - Clicking any card opens a slide-over drawer or modal dialog to edit the system prompt template, model overrides, and confidence threshold.

### R3. augmented Default Persona Prompts
- Analyze and update all 12 default reviewer persona prompt templates in `dashboardStore.ts` with advanced domain best practices:
  - **Security Persona**: Explicit auditing rules for OWASP Top 10, sanitization, secrets scanning, and tenant isolation.
  - **Architecture Persona**: Modular coupling boundaries, DRY compliance, ADR structure alignment, and code cleanliness.
  - **Performance, API Contract, and DevOps Personas**: Optimized CPU/memory bottlenecks, API breaking changes, and CI/CD/Kubernetes YAML standards.

### R4. Persistence & API Synchronization
- Connect all augmented prompts, card settings, and PostgreSQL memory queries directly to REST API endpoints and `DashboardStore`.

## Acceptance Criteria

### PostgreSQL Memory Storage
- [ ] Learned rules and nits are stored and queried from PostgreSQL relational tables when configured.
- [ ] Schema table migration runs automatically on startup.
- [ ] Symbol dependency graph features remain functional with original local database file.

### Card-Based Persona UI & augmented Prompts
- [ ] Persona editor renders as a grid of cards with toggles and editor drawers.
- [ ] Default system prompts contain upgraded OWASP and ADR guidelines.

### Verification & Testing
- [ ] `npm run build` static export and server compilation succeed with 0 errors.
- [ ] `npm test` passes 100%.
</USER_REQUEST>
