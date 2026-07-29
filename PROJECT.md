# Project: CodeRabbit-Style GitHub Organization Registration & AI Model Onboarding Wizard

## Architecture
The CodeRabbit-style GitHub Organization Registration & AI Model Onboarding Wizard provides a full 5-step onboarding experience on `/onboarding` (full page) and `/github-app` (embedded management panel).

### Components & Data Flow:
1. **Frontend UI & Routes**:
   - `/onboarding`: Full page wizard route (`src/app/onboarding/page.tsx`).
   - `/github-app`: Embedded panel route (`src/app/github-app/page.tsx`).
   - `OnboardingWizardContainer` & `FiveStepWizard` (`src/components/onboarding/five-step-wizard.tsx`): Manages state across 5 steps:
     - Step 1: GitHub Organization Connection (Install GitHub App button, manifest JSON wizard, webhook URL `/api/webhooks/github`, secret key, RS256 private key PEM upload).
     - Step 2: Monitored Repositories Picker (repositories list with `Active`/`Paused` toggles, strictness profiles `Chill`, `Balanced`, `Assertive`).
     - Step 3: AI Providers & All OmniRoute Models Setup (OpenAI, Anthropic Claude, Google Gemini, xAI Grok, DeepSeek, Zhipu GLM, Doppler, Ollama, Custom OpenAI-compatible; API key masked, Base URL, Org ID, Subscription Tier `Free`/`Pay-as-you-go`/`Pro`/`Team`/`Enterprise`, Active toggle, Test Connection button).
     - Step 4: Reviewer Persona Model Ensemble Assignment (dynamic dropdown selectors for 11 personas: Security, Architecture, Performance, Quality, Database, API Contract, Documentation, Linear Sync, UX/Product, DevOps, Reliability).
     - Step 5: Verification & Diagnostic Test Scan (end-to-end webhook delivery HMAC SHA256 test, provider latency ping & TTFT, persona arbitration with distinct-provider quorum check).
   - R2 Drawers, Guides & Tooltips:
     - `ManifestDrawer`: Slide-over drawer with copyable `.ct-review.yml` & GitHub App manifest JSON.
     - `HowToGuideCard`: Accordion guide for creating GitHub Apps & finding API keys.
     - `CostEstimatorCard`: Cost cap guidance and token estimator.
     - Tooltips across form controls.

2. **Backend & Persistence**:
   - `DashboardStore` (`src/persistence/dashboardStore.ts` / `/app/data/dashboard.json`): Saves credentials, repos, provider keys with subscription tiers, persona mappings.
   - API Routes:
     - `POST /api/onboarding/wizard/scan`: Tech stack scanner.
     - `POST /api/onboarding/wizard/generate`: Config YAML generator.
     - `POST /api/github/app-config/verify`: RS256 key and JWT validator.
     - `GET /api/github/manifest-callback`: GitHub App manifest exchange.
     - `PATCH /api/github/app-config/monitored-repos`: Repos & strictness profile updater.
     - `POST /api/dashboard/providers/:id/test`: Connectivity & latency test.
     - `POST /api/onboarding/diagnostic`: Diagnostic scan execution for Webhook delivery, TTFT latency, and 11-persona arbitration.

3. **Build & Route Synchronization (0-Error Static Export)**:
   - Synchronized across 4 files:
     1. `src/app/onboarding/page.tsx`
     2. `next.config.js` (`ensureManifestsExist`)
     3. `scripts/postbuild.js` (`routeCandidates`)
     4. `src/app.ts` (Express static SPA handler `app.get('/onboarding', ...)`)

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Data Store, Schemas & API Sync | `DashboardStore` schema expansion, API endpoints for repos, subscription tiers, keys, provider pings, persona mappings | None | PLANNED |
| 2 | Multi-Step Wizard UI & Routing | `/onboarding` page, `/github-app` panel, step indicator, 5 step components, navigation links (`sidebar.tsx`, `topbar.tsx`), static build sync (`next.config.js`, `postbuild.js`, `app.ts`) | M1 | PLANNED |
| 3 | How-To Guides, Manifest Drawer & Tooltips | Manifest JSON builder drawer with copy button, API key tooltips, cost cap & spending dialog integration | M2 | PLANNED |
| 4 | Diagnostic Scan Engine & Probes | Diagnostic scan endpoint (`POST /api/onboarding/diagnostic`) executing HMAC Webhook delivery, TTFT latency, persona arbitration quorum | M1, M2 | PLANNED |
| Final | E2E Test Suite Pass & Hardening | Pass 100% E2E tests (Tiers 1-4), Tier 5 white-box adversarial coverage hardening, Forensic Audit verdict CLEAN | M1-M4 | PLANNED |

## Interface Contracts
### DashboardStore ↔ Onboarding UI
- `GitHubAppConfig`: `{ appId: string, installationId: string, webhookUrl: string, webhookSecret: string, privateKeyPem: string, isVerified: boolean }`
- `MonitoredRepository`: `{ id: string, name: string, full_name: string, private: boolean, automationEnabled: boolean, strictnessProfile: 'chill' | 'balanced' | 'assertive', defaultBranch: string }`
- `AIProviderConfig`: `{ id: string, name: string, apiKey: string, baseUrl: string, orgId?: string, subscriptionTier: 'Free' | 'Pay-as-you-go' | 'Pro' | 'Team' | 'Enterprise', active: boolean, status: 'connected' | 'error' | 'untested', latencyMs?: number }`
- `PersonaMapping`: `{ personaId: string, name: string, modelId: string, providerId: string, effortLevel: 'low' | 'medium' | 'high' | 'max', confidenceThreshold: number }`

### Diagnostic Scan API
- Endpoint: `POST /api/onboarding/diagnostic`
- Request: `{ appId?: string, providerIds?: string[], repoId?: string }`
- Response:
  ```json
  {
    "success": true,
    "probe1_webhook": { "status": "accepted", "deliveryId": "del_123", "latencyMs": 42 },
    "probe2_latency": { "activeProviders": 4, "avgLatencyMs": 120, "providers": [{ "id": "openai", "latencyMs": 95, "ttftMs": 45 }] },
    "probe3_arbitration": { "personasEvaluated": 11, "distinctProvidersUsed": 4, "quorumPassed": true, "verdict": "SHIP" }
  }
  ```

## Code Layout
- `src/app/onboarding/page.tsx` — Full-page Onboarding Wizard route.
- `src/app/github-app/page.tsx` — Embedded GitHub App management panel.
- `src/components/onboarding/`
  - `five-step-wizard.tsx` — Container managing steps 1-5 state.
  - `step-indicator.tsx` — Visual step progress header.
  - `steps/step-1-github-app.tsx` — GitHub App connection & PEM upload.
  - `steps/step-2-repos-picker.tsx` — Monitored repositories & strictness profile.
  - `steps/step-3-ai-providers.tsx` — Provider keys, URLs, subscription tiers, test connection.
  - `steps/step-4-persona-ensemble.tsx` — 11 Reviewer persona model selectors.
  - `steps/step-5-diagnostic-scan.tsx` — Webhook, latency & arbitration diagnostic scan.
  - `manifest-drawer.tsx` — Copyable YAML/JSON drawer.
  - `how-to-guide-card.tsx` — Accordions & help guides.
  - `cost-estimator-card.tsx` — Cost cap & token cost estimator.
- `src/components/ui/copy-button.tsx` — One-click copy-to-clipboard component.
- `src/components/layout/sidebar.tsx` & `topbar.tsx` — Sidebar & topbar navigation.
- `src/persistence/dashboardStore.ts` — Data store schemas & JSON file persistence.
- `src/api/onboarding.ts` & `src/api/githubAppApi.ts` — Onboarding & diagnostic API routes.
- `tests/unit/components/` — Vitest + JSDOM component test suite.
- `tests/integration/` — API integration test suite.
- `tests/e2e/` — E2E test suite.
