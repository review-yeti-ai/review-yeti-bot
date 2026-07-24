# Project: ct-review-bot
# Scope: Global Project Architecture & Milestone Decomposition

## Architecture Overview
`ct-review-bot` is an enterprise-grade, quorum-based GitHub Code Review Bot service designed to run on DigitalOcean Kubernetes (DOKS). It provides multi-persona AI code reviews, OmniRoute LLM routing with token refresh & failover, persistent incremental diff tracking, ticket linkage enforcement, and GitHub App integration.

```
                  ┌─────────────────────────────────────────┐
                  │          GitHub Webhook Event           │
                  └────────────────────┬────────────────────┘
                                       │
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │       GitHub Webhook Receiver Server    │
                  │   (Express, Signature Verification)     │
                  └────────────────────┬────────────────────┘
                                       │
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │       Config & Ticket Validator         │
                  │  (.ct-review.yaml, Linear/Jira/GitHub)  │
                  └────────────────────┬────────────────────┘
                                       │
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │      Incremental Diff State Engine      │
                  │ (SHA-256 Hashing, SQLite/JSON Storage)  │
                  └────────────────────┬────────────────────┘
                                       │
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │     Quorum Review Panel Engine          │
                  │ ┌──────────────┬──────────────┬───────┐ │
                  │ │   Security   │ Architecture │ Perf  │ │
                  │ └──────┬───────┴──────┬───────┴───┬───┘ │
                  └────────┼──────────────┼───────────┼─────┘
                           │              │           │
                           ▼              ▼           ▼
                  ┌─────────────────────────────────────────┐
                  │       OmniRoute LLM Router & Token      │
                  │       Management (Failover/Refresh)     │
                  └────────────────────┬────────────────────┘
                                       │
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │      Quorum Consensus & Aggregator      │
                  └────────────────────┬────────────────────┘
                                       │
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │       GitHub App Output Publisher       │
                  │ (Inline Diff Comments & PR Summary)     │
                  └─────────────────────────────────────────┘
```

## Tech Stack
- **Language/Runtime**: Node.js v20+ / TypeScript
- **Framework**: Express.js
- **GitHub Integration**: `@octokit/core`, `@octokit/webhooks`, `@octokit/rest`
- **Config & Schema**: `js-yaml`, `zod`
- **Database/Persistence**: `better-sqlite3` / JSON state storage with atomic writes
- **Testing**: `vitest` / `jest`
- **Containerization & Deployment**: Docker (multi-stage build), Kubernetes manifests, Helm, `doctl`, `kubectl`

## Code Layout
```
ct-review-bot/
├── src/
│   ├── index.ts                     # Main service entry point
│   ├── config/                      # Config parser & YAML schema validator
│   │   ├── configLoader.ts
│   │   ├── schema.ts
│   │   └── defaultOrgConfig.ts
│   ├── ticket/                      # Ticket linkage validator (Linear/Jira/GitHub)
│   │   └── ticketValidator.ts
│   ├── constitution/                # Constitution.md enforcement engine
│   │   └── constitutionEngine.ts
│   ├── persistence/                 # Diff delta state manager
│   │   ├── diffStateManager.ts
│   │   └── db.ts
│   ├── router/                      # OmniRoute LLM router & token manager
│   │   ├── omniRouteAdapter.ts
│   │   ├── tokenManager.ts
│   │   └── providerPool.ts
│   ├── quorum/                      # Quorum review panel & aggregation
│   │   ├── mefEngine.ts             # Fan-out / Fan-in orchestrator
│   │   ├── personas/                # Security, Architecture, Performance, Quality
│   │   │   ├── securityPersona.ts
│   │   │   ├── archPersona.ts
│   │   │   ├── perfPersona.ts
│   │   │   └── qualityPersona.ts
│   │   └── consensus.ts             # Aggregator & voting engine
│   ├── github/                      # GitHub App webhook receiver & Octokit publisher
│   │   ├── webhookServer.ts
│   │   ├── signature.ts
│   │   └── commentPublisher.ts
│   └── utils/                       # Shared logger, error handling, hashing
│       ├── logger.ts
│       └── diffHash.ts
├── tests/                           # E2E and Unit test suite
│   ├── unit/
│   ├── integration/
│   └── e2e/                         # Tiers 1-5 test cases
├── docs/                            # PRD, Vision, Roadmap, Operator Guide, Architecture
├── k8s/                             # Kubernetes manifests (Deployment, Service, ConfigMap, Secret, Ingress)
├── Dockerfile                       # Production multi-stage Docker build
├── docker-compose.yml               # Local development setup
├── package.json
└── tsconfig.json
```

## Milestones Decomposition

| # | Milestone Name | Scope Description | Dependencies | Status |
|---|----------------|-------------------|--------------|--------|
| E2E | E2E Testing Track | Requirement-driven test suite (Tiers 1-4) & TEST_READY.md | None | DONE |
| M1 | Core Foundations & Config/State | Project scaffold, YAML config parser (.ct-review.yaml), ticket linkage validator, constitution engine, diff state persistence | None | DONE |
| M2 | OmniRoute LLM Router | Multi-provider LLM adapter, token refresh, effort levels, secret storage, failover pool | M1 | DONE |
| M3 | Quorum Review Panel Engine | Persona fan-out/fan-in, multi-agent review prompts, consensus aggregation, nit filtering | M1, M2 | DONE |
| M4 | GitHub App & Webhook Loop | Express webhook receiver, signature authentication, event handler, inline diff & summary publisher | M1, M3 | DONE |
| M5 | Docker & DOKS Deployment | Dockerfile build, K8s manifests, DOKS deployment scripts, live cluster deployment & verification | M1, M2, M3, M4 | DONE |
| M6 | Integration, Tier 5 & Docs | Pass 100% E2E test suite, Tier 5 adversarial hardening, complete docs/ (PRD, Vision, Roadmap, Operator Guide) | M1-M5, E2E | DONE |

## Interface Contracts

### 1. Config Loader Interface
```typescript
export interface CtReviewConfig {
  version: string;
  quorum: {
    minApprovals: number;
    personas: Array<'security' | 'architecture' | 'performance' | 'quality'>;
    effortLevel: 'low' | 'medium' | 'high' | 'reasoning';
  };
  ticketEnforcement: {
    required: boolean;
    providers: Array<'linear' | 'jira' | 'github'>;
    patterns?: string[];
  };
  constitution: {
    enabled: boolean;
    path?: string;
  };
}
```

### 2. OmniRoute Router Interface
```typescript
export interface LLMRequest {
  prompt: string;
  systemPrompt?: string;
  persona: string;
  effortLevel: 'low' | 'medium' | 'high' | 'reasoning';
  temperature?: number;
}

export interface LLMResponse {
  content: string;
  providerUsed: string;
  modelUsed: string;
  tokensUsed: { prompt: number; completion: number; total: number };
}
```

### 3. Quorum Review Result Interface
```typescript
export interface PersonaFinding {
  persona: string;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  filePath: string;
  lineNumber: number;
  comment: string;
  suggestion?: string;
}

export interface QuorumResult {
  summary: string;
  decision: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  findings: PersonaFinding[];
  ticketValidation: { valid: boolean; ticketsFound: string[]; error?: string };
  constitutionCompliance: { compliant: boolean; violations: string[] };
}
```
