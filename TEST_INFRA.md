# E2E Test Infra: CodeRabbit-Style GitHub Organization Registration & AI Model Onboarding Wizard

## Test Philosophy
- Opaque-box, requirement-driven. No dependency on implementation design.
- Methodology: Category-Partition + BVA + Pairwise + Workload Testing.

## Feature Inventory
| # | Feature | Source (requirement) | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---------|---------------------|:------:|:------:|:------:|:------:|
| 1 | GitHub Organization Connection & App Registration | R1 Step 1, R2 | 5 | 5 | ✓ | ✓ |
| 2 | Monitored Repositories Picker & Strictness Profiles | R1 Step 2 | 5 | 5 | ✓ | ✓ |
| 3 | AI Providers, Keys & Subscription Tiers | R1 Step 3, R2 | 5 | 5 | ✓ | ✓ |
| 4 | Reviewer Persona Model Ensemble Assignment | R1 Step 4 | 5 | 5 | ✓ | ✓ |
| 5 | Verification & Diagnostic Test Scan | R1 Step 5 | 5 | 5 | ✓ | ✓ |
| 6 | How-To Guides, Tooltips & Manifest JSON Drawers | R2 | 5 | 5 | ✓ | ✓ |

## Test Architecture
- Test runner: `npm test` (Vitest)
- Test environment: JSDOM for UI components, Node for API endpoints
- Dynamic test runner script: `npm test`

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Complete Onboarding Workflow from Step 1 to Step 5 | F1, F2, F3, F4, F5 | High |
| 2 | Add Custom OpenAI-compatible Provider with Enterprise Subscription Tier | F3, F4, F5 | Medium |
| 3 | Monitored Repo Strictness Profile Change (Chill -> Assertive) & Automation Toggle | F2, F5 | Medium |
| 4 | GitHub App Manifest JSON Copy and Webhook Secret Re-verification | F1, F6 | Medium |
| 5 | Diagnostic Scan Execution with Provider Latency Ping & 11-Persona Arbitration | F4, F5 | High |

## Coverage Thresholds
- Tier 1: ≥5 per feature (Total 30)
- Tier 2: ≥5 per feature boundary (Total 30)
- Tier 3: Pairwise combinations (Total 10)
- Tier 4: Real-world application scenarios (Total 5)
- Total minimum test cases: 75
