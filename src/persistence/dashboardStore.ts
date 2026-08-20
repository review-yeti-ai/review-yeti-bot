import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PRMemoryStore } from '../memory/prMemoryStore';
import { SymbolGraphStore } from '../indexer/symbolGraphStore';
import { providerPool } from '../gateway/providerPool';
import { R4_ALLOWED_MODELS } from '../config/schema';
import { postgresStore } from './postgresStore';

export interface RepoDashboardSetting {
  id?: string;
  name?: string;
  full_name?: string;
  owner: string;
  repo: string;
  private?: boolean;
  automationEnabled: boolean;
  generateArchitecturalFlowchart?: boolean;
  strictnessProfile?: 'chill' | 'balanced' | 'assertive';
  customProfile?: 'chill' | 'balanced' | 'assertive';
  defaultBranch?: string;
  modelOverrides?: Record<string, string>;
  updatedAt: string;
}

export interface PersonaSetting {
  id: string;
  personaId?: string;
  displayName: string;
  name?: string;
  description: string;
  enabled: boolean;
  model: string;
  modelId?: string;
  providerId?: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTurns?: number;
  confidenceThreshold: number;
  customPrompt?: string;
  required?: boolean;
  charter?: string;
  paths?: string[];
  providers?: string[];
}

export interface GitHubAppConfigRecord {
  appId: string;
  installationId?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookSecretConfigured: boolean;
  webhookSecretRaw?: string;
  privateKeyPem?: string;
  privateKeyConfigured: boolean;
  privateKeyPemRaw?: string;
  isVerified?: boolean;
  oauthClientId?: string;
  oauthClientSecretMasked?: string;
  oauthClientSecretRaw?: string;
  status: 'configured' | 'unconfigured' | 'error';
  updatedAt: string;
}

export interface AutoReviewSettings {
  enabled: boolean;
  triggers: string[];
  review_drafts: boolean;
  ignore_drafts: boolean;
  labels: string[];
  ignore_patterns: string[];
}

export interface EnforcementPolicySettings {
  require_all_reviews: boolean;
  failure_action: 'fail_closed' | 'fail_open' | 'quarantine';
  require_ticket_link: boolean;
}

export interface CustomApiBases {
  omniroute_base_url?: string;
  openai_base_url?: string;
  anthropic_base_url?: string;
  deepseek_base_url?: string;
  ollama_base_url?: string;
}

export interface ProviderConfigRecord {
  id: string;
  name?: string;
  displayName: string;
  active?: boolean;
  enabled: boolean;
  apiKey?: string;
  apiKeyMasked?: string;
  apiKeyRaw?: string;
  baseUrl?: string;
  orgId?: string;
  subscriptionTier?: 'Free' | 'Pay-as-you-go' | 'Pro' | 'Team' | 'Enterprise' | 'free' | 'pro' | 'team' | 'enterprise' | 'pay-as-you-go';
  status?: 'connected' | 'error' | 'untested' | 'disabled';
  latencyMs?: number;
  activeModels: string[];
  customModels?: string[];
  updatedAt: string;
}

export interface ModelRegistryItem {
  id: string;
  providerId: string;
  displayName: string;
  enabled: boolean;
  contextWindowTokens?: number;
  costPer1kPromptUSD?: number;
  costPer1kCompletionUSD?: number;
  isCustom?: boolean;
}

export interface PlatformSettings {
  defaultModelOverrides: Record<string, string>;
  defaultMaxTurns?: number;
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  personaSettings?: Record<string, PersonaSetting>;
  providerConfigs?: Record<string, ProviderConfigRecord>;
  modelRegistry?: Record<string, ModelRegistryItem>;
  memoryEngineSettings: {
    autoSuppressNits: boolean;
    learningConfidenceThreshold: number;
    maxLearningsPerRepo: number;
  };
  providerCostCaps: {
    monthlyBudgetUSD: number;
    dailyBudgetUSD: number;
    alertThresholdPercent: number;
    actionOnCapBreach: 'fail_closed' | 'disable_optional';
  };
  githubAppConfig?: GitHubAppConfigRecord;
  autoReviewSettings?: AutoReviewSettings;
  enforcementPolicy?: EnforcementPolicySettings;
  customApiBases?: CustomApiBases;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyHash: string; // SHA-256 hash of raw key
  maskedKey: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface ReviewLogEntry {
  id: string;
  prRun: string;
  repo?: string;
  prNumber?: number;
  title?: string;
  headSha: string;
  personas: string | string[];
  quorum: string;
  arbiterVerdict: string;
  verdict?: 'SHIP' | 'NACK' | 'COMMENT';
  timestamp: string;
  latencyMs?: number;
  costUSD?: number;
  cost?: number;
  tokens?: { prompt?: number; completion?: number; total?: number };
  tokenDetails?: { prompt?: number; completion?: number; total?: number };
  status?: string;
  modelCosts?: Record<string, number>;
  personaLogs?: Array<{
    persona: string;
    displayName?: string;
    decision?: string;
    latencyMs?: number;
    confidence?: number;
    model?: string;
    findingsCount?: number;
    summary?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costUSD?: number;
    outputLog?: string;
    reasoningChain?: string[];
    turnsCount?: number;
    nits?: Array<{
      filePath: string;
      lineNumber: number;
      severity: string;
      title: string;
      description?: string;
      suggestion?: string;
    }>;
  }>;
  mermaidDiagram?: string;
}

export interface IndexerMetrics {
  astParseLatencyMsSum: number;
  astParseCount: number;
  vectorEmbedLatencyMsSum: number;
  vectorEmbedCount: number;
}

export interface IntegrationConfig {
  id: 'linear' | 'github' | 'context7' | 'productlane' | 'posthog' | 'doppler' | 'sentry' | 'jira' | 'slack' | string;
  name: string;
  status: 'connected' | 'disconnected' | 'degraded' | 'error' | 'verifying' | 'configuring';
  apiKeyMasked?: string;
  oauthClientId?: string;
  oauthClientSecretMasked?: string;
  webhookUrl?: string;
  lastSyncAt?: string;
  settings?: Record<string, any>;
  updatedAt: string;
}

export interface CustomMcpServerConfig {
  id: string;
  name: string;
  transport: 'http' | 'stdio' | 'adapter';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  status: 'online' | 'offline' | 'degraded' | 'untested';
  toolsCount?: number;
  lastHealthCheckAt?: string;
  createdAt: string;
  updatedAt: string;
}

export function maskSecretKey(key?: string): string | undefined {
  if (!key) return undefined;
  if (key.length <= 8) return '****';
  const prefix = key.slice(0, 8);
  const suffix = key.slice(-4);
  return `${prefix}...${suffix}`;
}

export function normalizeSubscriptionTier(tier?: string): 'Free' | 'Pay-as-you-go' | 'Pro' | 'Team' | 'Enterprise' {
  if (!tier) return 'Pay-as-you-go';
  const lower = tier.toLowerCase();
  if (lower === 'free') return 'Free';
  if (lower === 'pay-as-you-go' || lower === 'payasyougo') return 'Pay-as-you-go';
  if (lower === 'pro') return 'Pro';
  if (lower === 'team') return 'Team';
  if (lower === 'enterprise') return 'Enterprise';
  return (tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase()) as any;
}

export function validateApiKeyFormat(key: string, providerOrIntegrationId?: string): { valid: boolean; reason?: string } {
  if (!key || typeof key !== 'string') {
    return { valid: false, reason: 'API key must be a non-empty string' };
  }

  const trimmed = key.trim();

  if (trimmed.length < 16) {
    return { valid: false, reason: `API key must be at least 16 characters long (got ${trimmed.length})` };
  }

  const lower = trimmed.toLowerCase();
  const dummyPatterns = [
    'mock',
    'invalid_key',
    'invalid-key',
    'invalidkey',
    'dummy',
    'test_key',
    'test-key',
    'testkey',
    'placeholder',
    '1234567890',
    '12345678',
    '00000000',
  ];

  for (const pattern of dummyPatterns) {
    if (lower.includes(pattern)) {
      return { valid: false, reason: `API key contains prohibited dummy/mock pattern '${pattern}'` };
    }
  }

  const validCharRegex = /^[A-Za-z0-9_\-\.\/:=]+$/;
  if (!validCharRegex.test(trimmed)) {
    return { valid: false, reason: 'API key contains invalid characters' };
  }

  if (providerOrIntegrationId) {
    const id = providerOrIntegrationId.toLowerCase();

    if (id === 'openai' || id === 'custom-openai') {
      const validOpenAIPrefixes = ['sk-proj-', 'sk-', 'sk-admin-', 'sk-svcacct-'];
      if (!validOpenAIPrefixes.some(prefix => trimmed.startsWith(prefix))) {
        return { valid: false, reason: `OpenAI API key must start with valid prefix (e.g. 'sk-proj-', 'sk-')` };
      }
    } else if (id === 'anthropic') {
      if (!trimmed.startsWith('sk-ant-')) {
        return { valid: false, reason: `Anthropic API key must start with 'sk-ant-'` };
      }
    } else if (id === 'gemini' || id === 'google') {
      if (!trimmed.startsWith('AIzaSy')) {
        return { valid: false, reason: `Google Gemini API key must start with 'AIzaSy'` };
      }
    } else if (id === 'grok' || id === 'xai') {
      if (!trimmed.startsWith('xai-')) {
        return { valid: false, reason: `xAI Grok API key must start with 'xai-'` };
      }
    } else if (id === 'deepseek') {
      if (!trimmed.startsWith('sk-ds-') && !trimmed.startsWith('sk-')) {
        return { valid: false, reason: `DeepSeek API key must start with 'sk-ds-' or 'sk-'` };
      }
    } else if (id === 'glm') {
      if (!trimmed.startsWith('sk-glm-') && !trimmed.startsWith('sk-') && !trimmed.startsWith('glm-')) {
        return { valid: false, reason: `GLM API key must start with valid prefix (e.g. 'sk-glm-')` };
      }
    } else if (id === 'doppler') {
      if (!trimmed.startsWith('dp.pt.') && !trimmed.startsWith('dp.st.')) {
        return { valid: false, reason: `Doppler token must start with 'dp.pt.' or 'dp.st.'` };
      }
    } else if (id === 'linear') {
      if (!trimmed.startsWith('lin_api_')) {
        return { valid: false, reason: `Linear API key must start with 'lin_api_'` };
      }
    } else if (id === 'context7') {
      if (!trimmed.startsWith('ctx_live_') && !trimmed.startsWith('ctx_')) {
        return { valid: false, reason: `Context7 API key must start with 'ctx_live_' or 'ctx_'` };
      }
    } else if (id === 'posthog') {
      if (!trimmed.startsWith('phc_') && !trimmed.startsWith('phx_')) {
        return { valid: false, reason: `PostHog API key must start with 'phc_' or 'phx_'` };
      }
    } else if (id === 'sentry') {
      if (!trimmed.startsWith('sntry_') && !/^[a-f0-9]{32,64}$/i.test(trimmed)) {
        return { valid: false, reason: `Sentry API key must start with 'sntry_' or be a valid token hex string` };
      }
    } else if (id === 'jira') {
      if (!trimmed.startsWith('ATATT3') && !trimmed.startsWith('ATATT')) {
        return { valid: false, reason: `Jira API token must start with 'ATATT3'` };
      }
    } else if (id === 'slack') {
      const validSlackPrefixes = ['xoxb-', 'xoxp-', 'xapp-', 'xoxe-'];
      if (!validSlackPrefixes.some(prefix => trimmed.startsWith(prefix))) {
        return { valid: false, reason: `Slack token must start with a valid prefix (e.g. 'xoxb-')` };
      }
    }
  }

  return { valid: true };
}



export interface DashboardData {
  repositories: RepoDashboardSetting[];
  settings: PlatformSettings;
  apiKeys: ApiKeyRecord[];
  reviewCounter: number;
  totalCostUSD: number;
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
  reviewLogs?: ReviewLogEntry[];
  integrations?: Record<string, IntegrationConfig>;
  mcpServers?: CustomMcpServerConfig[];
  indexerMetrics?: IndexerMetrics;
  dailyReviewCounts?: Record<string, number>;
}

export class DashboardStore {
  private specifiedFilePath?: string;
  private overrideFilePath?: string;
  private data: DashboardData;
  private cache: {
    analyticsSummary?: any;
    tokenTimeSeries: Record<string, any>;
    costBreakdown?: any;
    personaAnalytics?: any;
    indexerAnalytics?: any;
    overviewStats?: any;
  } = { tokenTimeSeries: {} };

  private sanitizePath(targetPath: string): string {
    if (targetPath.startsWith('/tmp/')) {
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      }
      return targetPath;
    }
    return targetPath;
  }

  public get filePath(): string {
    const resolved = this.overrideFilePath || this.specifiedFilePath || process.env.CT_DASHBOARD_STORE;
    if (resolved) return this.sanitizePath(resolved);
    let fallbackPath = '/tmp/ct-review-bot/dashboard.json';
    try {
      if (!process.env.VITEST && fs.existsSync('/app/data')) {
        try {
          fs.accessSync('/app/data', fs.constants.W_OK);
          fallbackPath = '/app/data/dashboard.json';
        } catch {
          // /app/data is not writable, keep /tmp/ct-review-bot/dashboard.json
        }
      }
    } catch {}
    return this.sanitizePath(fallbackPath);
  }

  public set filePath(val: string) {
    this.overrideFilePath = val;
    this.invalidateCache();
    this.data = this.load();
  }

  private invalidateCache(): void {
    this.cache = { tokenTimeSeries: {} };
  }

  constructor(filePath?: string) {
    this.specifiedFilePath = filePath;
    this.data = this.load();
    this.initPostgres();
  }

  /** Reload the backing file and clear transient analytics caches. */
  public reset(): void {
    this.overrideFilePath = undefined;
    this.filePath = process.env.CT_DASHBOARD_STORE || path.join(process.cwd(), 'data', 'dashboard-store.json');
    this.invalidateCache();
    this.data = this.load();
  }

  public async initPostgres(): Promise<void> {
    if (postgresStore.isConfigured()) {
      try {
        await postgresStore.initialize(this.data);
        const pgData = await postgresStore.loadAllData();
        if (pgData) {
          if (pgData.repositories && pgData.repositories.length > 0) {
            this.data.repositories = pgData.repositories;
          }
          if (pgData.settings) {
            this.data.settings = { ...this.data.settings, ...pgData.settings };
          }
          if (pgData.reviewLogs && pgData.reviewLogs.length > 0) {
            this.data.reviewLogs = pgData.reviewLogs;
          }
          this.invalidateCache();
        }
      } catch (_) {}
    }
  }

  private defaultData(): DashboardData {
    const now = new Date().toISOString();
    return {
      repositories: [
        {
          id: 'repo-cisco-cdr',
          name: 'cisco-cdr',
          full_name: 'calltelemetry/cisco-cdr',
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          private: false,
          automationEnabled: true,
          generateArchitecturalFlowchart: true,
          strictnessProfile: 'balanced',
          customProfile: 'balanced',
          defaultBranch: 'main',
          updatedAt: now,
        },
        {
          id: 'repo-ct-meta',
          name: 'ct-meta',
          full_name: 'calltelemetry/ct-meta',
          owner: 'calltelemetry',
          repo: 'ct-meta',
          private: true,
          automationEnabled: true,
          generateArchitecturalFlowchart: true,
          strictnessProfile: 'balanced',
          customProfile: 'balanced',
          defaultBranch: 'main',
          updatedAt: now,
        },
        {
          id: 'repo-ct-review-bot',
          name: 'ct-review-bot',
          full_name: 'calltelemetry/ct-review-bot',
          owner: 'calltelemetry',
          repo: 'ct-review-bot',
          private: false,
          automationEnabled: true,
          generateArchitecturalFlowchart: true,
          strictnessProfile: 'assertive',
          customProfile: 'assertive',
          defaultBranch: 'main',
          updatedAt: now,
        },
      ],
      settings: {
        defaultModelOverrides: {
          openrouter: 'openrouter/auto',
          codex: 'codex/gpt-5.6-sol-high',
          claude: 'claude/claude-opus-4-8',
          grok: 'grok-cli/grok-4.5',
          'agy-opus': 'agy/claude-opus-4-6-thinking',
        },
        defaultMaxTurns: 20,
        defaultEffort: 'low',
        personaSettings: {
          security: {
            id: 'security',
            personaId: 'security',
            displayName: '🛡️ Security & Tenancy Guardian',
            name: '🛡️ Security & Tenancy Guardian',
            description: 'Secret scanning, authentication, authorization, OWASP Top 10, multi-tenant isolation.',
            enabled: true,
            required: true,
            charter: 'builtin:security',
            model: 'openrouter/auto',
            modelId: 'openrouter/auto',
            providerId: 'openrouter',
            effort: 'low',
            effortLevel: 'low',
            maxTurns: 20,
            confidenceThreshold: 85,
            customPrompt: `Find security, authentication, authorization, tenant-isolation, secret, and injection defects.

## Domain Charter & Core Scope
- Audit all code modifications for multi-tenant isolation breaches, authentication bypasses, authorization flaws, and privilege escalation hazards.
- Perform explicit auditing for OWASP Top 10 vulnerabilities (A01:2021 Broken Access Control through A10:2021 Server-Side Request Forgery).
- Enforce strict input validation and sanitization using Zod schema verification across all request boundaries and public endpoints.
- Execute regex-based secrets scanning to detect hardcoded API keys, JWT tokens, RSA private keys, AWS access tokens, and bearer credentials.
- Verify multi-tenant isolation through mandatory orgId/tenantId query parameter and database row-level bounds checks on all persistence queries.

## Deep Reasoning Protocol
1. Map data ingress points and trace tainted user inputs through controllers, business logic, Zod sanitizers, and execution sinks.
2. Verify explicit authentication and RBAC/tenant bounds (orgId/tenantId checks) on every public and internal API route and database query.
3. Validate secret handling via regex pattern scanning (API keys, JWT, RSA keys, AWS tokens) and ensure zero secret leakage in logs or responses.
4. Evaluate defense-in-depth mechanisms against OWASP Top 10 (A01-A10), fail-closed handling, rate limiting, and secure token storage.

## Nit Suppression Rules
- Do NOT flag general code style, formatting, or linting preferences unless they directly introduce a security vulnerability.
- Do NOT flag missing docstrings or minor variable naming choices if authorization and tenant-isolation checks are functionally sound.`,
            paths: ['**/*'],
            providers: ['claude', 'codex'],
          },
          architecture: {
            id: 'architecture',
            personaId: 'architecture',
            displayName: '🏛️ System Architecture & Design',
            name: '🏛️ System Architecture & Design',
            description: 'Module boundaries, design patterns, microservice contracts, ADR compliance.',
            enabled: true,
            required: true,
            charter: 'builtin:consistency',
            model: 'openrouter/auto',
            modelId: 'openrouter/auto',
            providerId: 'openrouter',
            effort: 'low',
            effortLevel: 'low',
            maxTurns: 20,
            confidenceThreshold: 75,
            customPrompt: `Find internal consistency, maintainability, repository-convention, and generated-source defects.

## Domain Charter & Core Scope
- Maintain system architectural integrity, clean layer separation, modular coupling boundaries (Presentation -> Application -> Domain -> Infrastructure), and ADR compliance.
- Enforce DRY (Don't Repeat Yourself) compliance, circular dependency prevention, clear domain abstractions, and contract preservation.
- Inspect code cleanliness, modifications to generated sources, core data structures, and cross-cutting components for structural alignment.

## Deep Reasoning Protocol
1. Analyze changed modules against modular coupling boundaries and strict layer hierarchy (Presentation -> Application -> Domain -> Infrastructure).
2. Inspect codebase for DRY compliance, duplicate abstractions, circular dependencies, or tight coupling across module boundaries.
3. Verify alignment with Architecture Decision Records (ADRs) to ensure proposed additions match repository-wide architectural decisions.
4. Evaluate code cleanliness, single-responsibility principle adherence, interface stability, and refactoring safety.

## Nit Suppression Rules
- Do NOT flag local implementation details within a single function unless they violate exported module interfaces or architectural layer boundaries.
- Suppress purely cosmetic suggestions that do not affect structural design or maintainability.`,
            paths: ['**/*'],
            providers: ['grok', 'claude'],
          },
          performance: {
            id: 'performance',
            personaId: 'performance',
            displayName: '⚡ Performance & Scalability',
            name: '⚡ Performance & Scalability',
            description: 'CPU/Memory hotspots, N+1 queries, unindexed lookups, memory leaks.',
            enabled: true,
            required: false,
            charter: 'builtin:performance',
            model: 'openrouter/auto',
            modelId: 'openrouter/auto',
            providerId: 'openrouter',
            effort: 'low',
            effortLevel: 'low',
            maxTurns: 20,
            confidenceThreshold: 70,
            customPrompt: `Identify CPU/memory bottlenecks, N+1 queries, unindexed queries, blocking loops, and memory leaks.

## Domain Charter & Core Scope
- Detect CPU and memory bottlenecks, algorithmic inefficiencies including O(N^2) nested loop prevention, and memory leak vulnerabilities.
- Identify N+1 query patterns, database connection pool sizing limits, missing index requirements, and unindexed lookup paths.
- Audit event loop blocking operations, stream buffer allocations, async I/O bottlenecks, and resource cleanup lifecycle management.

## Deep Reasoning Protocol
1. Analyze execution flow for O(N^2) nested loops, unbounded iterations, and high CPU/memory bottlenecks in critical hot paths.
2. Detect N+1 database query patterns, evaluate connection pool sizing parameters, and verify indexed lookup execution plans.
3. Inspect memory usage patterns, event listener retention, and object lifecycles to prevent memory leaks and garbage collector pressure.
4. Evaluate async I/O concurrency, caching effectiveness, and stream handling under peak throughput conditions.

## Nit Suppression Rules
- Do NOT flag micro-optimizations in cold execution paths (e.g. initialization or CLI startup scripts) unless performance degradation is significant.
- Ignore minor string concatenation choices when total execution impact is negligible.`,
            paths: ['**/*'],
            providers: ['synthetic', 'claude'],
          },
          quality: {
            id: 'quality',
            personaId: 'quality',
            displayName: '✨ Code Quality & Style',
            name: '✨ Code Quality & Style',
            description: 'Idiomatic syntax, readability, type safety, error handling guidelines.',
            enabled: true,
            required: true,
            charter: 'builtin:correctness',
            model: 'openrouter/auto',
            modelId: 'openrouter/auto',
            providerId: 'openrouter',
            effort: 'low',
            effortLevel: 'low',
            maxTurns: 20,
            confidenceThreshold: 70,
            customPrompt: `Find correctness defects, race conditions, unsafe concurrency, and failure-mode errors.

## Domain Charter & Core Scope
- Detect code smells, anti-patterns, cyclomatic complexity threshold violations, and excessive function length.
- Audit exception handling guidelines, error propagation pathways, null/undefined safety, and type safety guarantees.
- Enforce clear naming conventions, idiomatic code constructs, modularity, and deterministic testability.

## Deep Reasoning Protocol
1. Analyze code complexity: identify overly long functions, deep nesting, high cyclomatic complexity, and structural code smells.
2. Inspect exception handling logic: ensure errors are properly typed, caught, logged, and re-thrown without silent suppression or unhandled rejections.
3. Verify variable and function naming conventions for clarity, intent-revealing self-documentation, and domain consistency.
4. Audit concurrency models for race conditions, atomic state updates, and safe resource disposal.

## Nit Suppression Rules
- Do NOT flag subjective style choices or opinionated formatting if existing linter rules pass cleanly.
- Suppress minor variable naming feedback unless names are misleading or obfuscate code correctness.`,
            paths: ['**/*'],
            providers: ['claude'],
          },
          database: {
            id: 'database',
            personaId: 'database',
            displayName: '🗄️ Database & Persistence',
            name: '🗄️ Database & Persistence',
            description: 'Schema migrations, index efficiency, SQL injection, transaction safety.',
            enabled: true,
            required: false,
            charter: 'builtin:database',
            model: 'openrouter/auto',
            modelId: 'openrouter/auto',
            providerId: 'openrouter',
            effort: 'low',
            effortLevel: 'low',
            maxTurns: 20,
            confidenceThreshold: 80,
            customPrompt: `Find database migration hazards, SQL injection vulnerabilities, unsafe transactions, and index inefficiencies.

## Domain Charter & Core Scope
- Audit database operations for proper transaction isolation levels, row/table locking strategies, and deadlock avoidance.
- Inspect SQL queries for index utilization, B-tree query planner efficiency, and parameterization to eliminate SQL injection hazards.
- Verify migration rollback safety, backward-compatible DDL execution, and zero-downtime schema evolution.

## Deep Reasoning Protocol
1. Evaluate transaction boundaries, isolation levels (e.g. Read Committed, Repeatable Read), and lock ordering to prevent deadlocks.
2. Analyze schema migration scripts for rollback safety, non-blocking index creation (CREATE INDEX CONCURRENTLY), and data preservation.
3. Inspect database queries for index utilization, avoiding full-table scans, unindexed joins, or unsafe dynamic query strings.
4. Audit connection pooling, statement timeouts, and multi-tenant row boundary filtering across persistent storage queries.

## Nit Suppression Rules
- Do NOT flag query formatting or keyword casing (e.g., lowercase vs uppercase SQL keywords) if query syntax and performance are valid.
- Suppress index recommendations on small lookup tables (<100 rows) unless proven to cause query bottlenecks.`,
            paths: ['**/*'],
            providers: ['openrouter', 'codex'],
          },
          api_contract: {
            id: 'api_contract',
            personaId: 'api_contract',
            displayName: '🔌 API Contract & Integration',
            name: '🔌 API Contract & Integration',
            description: 'Breaking API changes, OpenAPI/REST schemas, backward compatibility.',
            enabled: true,
            required: true,
            charter: 'builtin:contract',
            model: 'openrouter/auto',
            modelId: 'openrouter/auto',
            providerId: 'openrouter',
            effort: 'low',
            effortLevel: 'low',
            maxTurns: 20,
            confidenceThreshold: 75,
            customPrompt: `Find API, schema, compatibility, regression, and missing-test defects.

## Domain Charter & Core Scope
- Validate non-breaking REST and GraphQL schema changes, maintaining backwards compatibility checks across all API versions.
- Ensure proper deprecation headers (Sunset / Deprecation HTTP headers) on deprecated endpoints and field removals.
- Verify strict alignment between input validation schemas (Zod/OpenAPI/GraphQL) and runtime request/response handler signatures.

## Deep Reasoning Protocol
1. Compare REST/GraphQL schema updates against prior contract specs to guarantee backwards compatibility and detect breaking structural edits.
2. Verify deprecation headers, Sunset policies, and client migration pathways for deprecated fields or endpoints.
3. Validate schema alignment between front-end payloads, API gateways, Zod input validation schemas, and database contract models.
4. Ensure error payload structures, HTTP status codes, and GraphQL error extensions adhere to API contract specifications.

## Nit Suppression Rules
- Do NOT flag minor API documentation phrasing if payload schemas and field descriptions are accurate.
- Suppress cosmetic json field ordering suggestions unless strict key ordering is required by specification.`,
            paths: ['**/*'],
            providers: ['claude'],
          },
          docs_compliance: {
            id: 'docs_compliance',
            personaId: 'docs_compliance',
            displayName: '📝 Documentation & Compliance',
            name: '📝 Documentation & Compliance',
            description: 'Inline docstrings, README updates, ADR registration, open-source licenses.',
            enabled: true,
            required: false,
            charter: 'builtin:docs-compliance',
            model: 'openrouter/auto',
            modelId: 'openrouter/auto',
            providerId: 'openrouter',
            effort: 'low',
            effortLevel: 'low',
            maxTurns: 20,
            confidenceThreshold: 60,
            customPrompt: `Verify public API documentation, inline docstrings, and open-source license compliance.

## Domain Charter & Core Scope
- Verify API doc completeness across external endpoints, public methods, exports, and schema definitions.
- Require inline JSDoc/TSDoc annotations for complex interfaces, parameters, return types, and failure modes.
- Inspect README updates, architectural overview guides, and CHANGELOG.md tracking for new features and breaking changes.

## Deep Reasoning Protocol
1. Audit changed exported modules and public API endpoints to confirm presence of complete inline JSDoc/TSDoc documentation.
2. Check repository documentation files (README.md, docs/) to ensure architectural diagrams, configuration options, and setup guides match code edits.
3. Verify CHANGELOG.md entries accurately reflect feature additions, bug fixes, deprecations, and breaking schema modifications.
4. Inspect open-source license headers, notice files, and third-party library attribution compliance.

## Nit Suppression Rules
- Do NOT flag minor spelling or typographical preferences in internal comments that do not impact public API clarity.
- Suppress docstring enforcement on private internal local variables or trivial getter/setter methods.`,
            paths: ['**/*'],
            providers: ['claude'],
          },
          reliability: {
            id: 'reliability',
            personaId: 'reliability',
            displayName: '💥 Reliability & Resilience (SRE)',
            name: '💥 Reliability & Resilience (SRE)',
            description: 'Rate limiting, circuit breakers, timeout backoffs, fail-closed safety.',
            enabled: true,
            required: false,
            charter: 'builtin:policy-compliance',
            model: 'openrouter/auto',
            modelId: 'openrouter/auto',
            providerId: 'openrouter',
            effort: 'low',
            effortLevel: 'low',
            maxTurns: 20,
            confidenceThreshold: 80,
            customPrompt: `Enforce repository rules, path instructions, release policy, and fail-closed gates.

## Domain Charter & Core Scope
- Enforce system reliability patterns including circuit breakers, exponential backoff with jitter for retries, and graceful degradation paths.
- Ensure comprehensive health check coverage (liveness, readiness, startup probes) and fail-closed security gate policies.
- Audit timeout configurations, fallback mechanisms, fault isolation, and structured telemetry logging across external integration points.

## Deep Reasoning Protocol
1. Audit all network calls and third-party API clients for mandatory circuit breaker wrappers and exponential backoff retry policies with jitter.
2. Verify system health check coverage (readiness/liveness endpoints) and fail-closed behavior across critical authorization and operational gates.
3. Assess graceful degradation strategies: ensure downstream failures return fallback cached data or controlled degraded responses without cascading crashes.
4. Evaluate structured logging, tracing span contexts, and metrics collection for incident diagnosis and SLO/SLA monitoring.

## Nit Suppression Rules
- Do NOT flag missing retry logic on idempotent or lightweight local helper operations.
- Suppress logging format suggestions unless essential context keys (e.g. requestId, tenantId) are omitted.`,
            paths: ['**/*'],
            providers: ['synthetic', 'claude'],
          },
          devops: {
            id: 'devops',
            personaId: 'devops',
            displayName: '🐳 DevOps & Containers',
            name: '🐳 DevOps & Containers',
            description: 'K8s manifests, Dockerfile layer optimization, IAM privilege boundaries.',
            enabled: true,
            required: false,
            charter: 'builtin:devops',
            model: 'openrouter/auto',
            modelId: 'openrouter/auto',
            providerId: 'openrouter',
            effort: 'low',
            effortLevel: 'low',
            maxTurns: 20,
            confidenceThreshold: 75,
            customPrompt: `Verify Kubernetes security contexts, Dockerfile layer optimization, and IAM privileges.

## Domain Charter & Core Scope
- Enforce Kubernetes YAML standards including mandatory securityContext (readOnlyRootFilesystem, drop ALL capabilities), readinessProbe/livenessProbe config, and CPU/RAM resource limits.
- Require Dockerfile multi-stage builds and non-root user enforcement (USER node/appuser) across container base images.
- Audit CI/CD pipeline safety, build layer optimization, IAM privilege boundaries, and infrastructure-as-code configuration.

## Deep Reasoning Protocol
1. Audit Kubernetes YAML manifests for valid securityContext settings, livenessProbe/readinessProbe configuration, and explicit CPU/RAM requests and limits.
2. Verify Dockerfile definitions utilize multi-stage builds, clean up cached build layers, and explicitly enforce non-root user execution.
3. Inspect CI/CD workflows for secret leaks, unpinned GitHub Actions dependencies, and unsafe shell script execution.
4. Evaluate cloud infrastructure configurations (Terraform/Helm) for least-privilege IAM policies and container runtime safety.

## Nit Suppression Rules
- Do NOT flag Dockerfile comment styles or label ordering if security and build performance standards are met.
- Suppress warnings on development/testing container configs unless applied to production manifests.`,
            paths: ['**/*'],
            providers: ['synthetic', 'codex'],
          },
          finops: {
            id: 'finops',
            personaId: 'finops',
            displayName: '💰 FinOps & Token Budget',
            name: '💰 FinOps & Token Budget',
            description: 'Prompt token budget efficiency, model cost tiering, AST hunk filtering.',
            enabled: true,
            required: false,
            charter: 'builtin:finops',
            model: 'openrouter/auto',
            modelId: 'openrouter/auto',
            providerId: 'openrouter',
            effort: 'low',
            effortLevel: 'low',
            maxTurns: 20,
            confidenceThreshold: 70,
            customPrompt: `Optimize prompt token budget consumption, model cost efficiency, AST hunk filtering, and resource limits.

## Domain Charter & Core Scope
- Optimize LLM token consumption, cost tiering, and prompt payload efficiency across all review pipeline lanes.
- Enforce AST diff scope filtering, context window minimization, and payload truncation strategies for large code changes.
- Enable prompt caching mechanisms, eliminate redundant context re-transmissions, and enforce cost-effective provider routing.

## Deep Reasoning Protocol
1. Audit LLM prompt construction to ensure AST diff scope filtering eliminates unchanged code and extraneous metadata from context payloads.
2. Verify prompt caching enablement flags and headers are properly configured to optimize prefix token cache hit rates.
3. Check payload truncation and token budget limits to prevent context window overflow while preserving critical code diff signal.
4. Evaluate model tier selection (e.g., fast/cheap vs reasoning models) based on file complexity and review effort requirements.

## Nit Suppression Rules
- Do NOT flag minor token count variations in low-frequency system execution paths.
- Suppress prompt optimization suggestions if context truncation threatens review coverage or finding accuracy.`,
            paths: ['**/*'],
            providers: ['synthetic'],
          },
          red_team: {
            id: 'red_team',
            personaId: 'red_team',
            displayName: '🎯 Red Team & Skeptic',
            name: '🎯 Red Team & Skeptic',
            description: 'Adversarial vulnerability probe, boundary testing, edge-case bypass attempts.',
            enabled: true,
            required: false,
            charter: 'builtin:red-team',
            model: 'openrouter/auto',
            modelId: 'openrouter/auto',
            providerId: 'openrouter',
            effort: 'low',
            effortLevel: 'low',
            maxTurns: 20,
            confidenceThreshold: 80,
            customPrompt: `Actively challenge PR diff assumptions, surface edge-case bugs, construct failure scenarios, probe unhandled exceptions, and execute dual-model cross-examination.

## Domain Charter & Core Scope
- Maintain an adversarial mindset: execute dual-model adversarial cross-examination to challenge optimistic approvals and detect hidden defects.
- Construct edge-case exploitation scenarios, race condition vectors, boundary overflows, and unhandled failure modes.
- Perform security bypass detection across authentication mechanisms, authorization gates, and multi-tenant boundary checks.

## Deep Reasoning Protocol
1. Analyze pull request changes with explicit skepticism, actively probing for security bypass vectors, missing checks, and logical flaws.
2. Construct edge-case exploitation sequences (e.g. boundary conditions, race conditions, parameter tampering) to test code robustness.
3. Leverage dual-model adversarial cross-examination to validate findings and uncover subtle vulnerabilities missed by standard review lanes.
4. Challenge underlying architecture and error recovery assumptions to expose silent failure modes or privilege escalation hazards.

## Nit Suppression Rules
- Do NOT flag theoretical edge cases that require impossible system states or broken platform invariants.
- Suppress generic skepticism without a concrete, reproducible failure scenario or vulnerability path.`,
            paths: ['**/*'],
            providers: ['claude', 'codex'],
          },
          review_flowchart: {
            id: 'review_flowchart',
            personaId: 'review_flowchart',
            displayName: '📊 Review Flowchart & Architecture',
            name: '📊 Review Flowchart & Architecture',
            description: 'LLM analysis step generating dynamic Mermaid.js sequence and flowchart diagrams.',
            enabled: true,
            required: false,
            charter: 'builtin:review-flowchart',
            model: 'openrouter/auto',
            modelId: 'openrouter/auto',
            providerId: 'openrouter',
            effort: 'low',
            effortLevel: 'low',
            maxTurns: 20,
            confidenceThreshold: 75,
            customPrompt: `Analyze diff and AST changes to generate dynamic Mermaid.js architectural sequence and flowchart diagrams.

## Domain Charter & Core Scope
- Execute architecture diagram generation illustrating modified components, system boundaries, and module interactions.
- Ensure strict valid Mermaid flowchart syntax (flowchart TD / LR) and sequence diagram semantics (sequenceDiagram).
- Provide clear control flow visualization of business logic branches, async pipelines, API request lifecycle, and data flow paths.

## Deep Reasoning Protocol
1. Map changed files, functions, and cross-module interactions into clear, structured control flow visualization models.
2. Generate valid Mermaid flowchart syntax (flowchart TD / LR) or sequence diagrams wrapping code flow within markdown code blocks.
3. Validate syntax correctness: ensure valid node identifiers, proper arrow direction syntax, and absence of unescaped special characters.
4. Highlight major control flow branches, decision nodes, database calls, and external service interactions introduced or modified in the PR.

## Nit Suppression Rules
- Do NOT generate trivial diagrams for minor formatting or docstring changes.
- Ensure all component identifiers in Mermaid code use valid alphanumeric characters and clean labels.`,
            paths: ['**/*'],
            providers: ['claude', 'codex'],
          },
        },
        memoryEngineSettings: {
          autoSuppressNits: true,
          learningConfidenceThreshold: 80,
          maxLearningsPerRepo: 500,
        },
        providerCostCaps: {
          monthlyBudgetUSD: 100.0,
          dailyBudgetUSD: 10.0,
          alertThresholdPercent: 80,
          actionOnCapBreach: 'fail_closed',
        },
        githubAppConfig: {
          appId: process.env.GITHUB_APP_ID || '',
          installationId: process.env.GITHUB_INSTALLATION_ID || '',
          webhookUrl: process.env.WEBHOOK_URL || '/api/webhooks/github',
          webhookSecret: process.env.WEBHOOK_SECRET || '',
          webhookSecretConfigured: Boolean(process.env.WEBHOOK_SECRET),
          webhookSecretRaw: process.env.WEBHOOK_SECRET || '',
          privateKeyPem: process.env.GITHUB_APP_PRIVATE_KEY || '',
          privateKeyConfigured: Boolean(process.env.GITHUB_APP_PRIVATE_KEY),
          privateKeyPemRaw: process.env.GITHUB_APP_PRIVATE_KEY || '',
          isVerified: Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY),
          oauthClientId: process.env.GITHUB_OAUTH_CLIENT_ID || '',
          oauthClientSecretMasked: maskSecretKey(process.env.GITHUB_OAUTH_CLIENT_SECRET),
          oauthClientSecretRaw: process.env.GITHUB_OAUTH_CLIENT_SECRET || '',
          status: 'configured',
          updatedAt: now,
        },
        autoReviewSettings: {
          enabled: true,
          triggers: ['pr_opened', 'pr_synchronize', '@ct-review'],
          review_drafts: false,
          ignore_drafts: true,
          labels: [],
          ignore_patterns: [],
        },
        enforcementPolicy: {
          require_all_reviews: true,
          failure_action: 'fail_closed',
          require_ticket_link: false,
        },
        customApiBases: {
          omniroute_base_url: process.env.OMNIROUTE_BASE_URL || '',
          openai_base_url: process.env.OPENAI_BASE_URL || '',
          anthropic_base_url: process.env.ANTHROPIC_BASE_URL || '',
          deepseek_base_url: process.env.DEEPSEEK_BASE_URL || '',
          ollama_base_url: process.env.OLLAMA_BASE_URL || '',
        },
        providerConfigs: {
          openai: {
            id: 'openai',
            name: 'OpenAI',
            displayName: 'OpenAI',
            enabled: true,
            active: true,
            apiKey: process.env.OPENAI_API_KEY ? maskSecretKey(process.env.OPENAI_API_KEY) : '',
            apiKeyMasked: process.env.OPENAI_API_KEY ? maskSecretKey(process.env.OPENAI_API_KEY) : '',
            apiKeyRaw: process.env.OPENAI_API_KEY || '',
            baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
            orgId: 'org-ct-openai',
            subscriptionTier: 'Pay-as-you-go',
            status: process.env.OPENAI_API_KEY ? 'connected' : 'untested',
            latencyMs: 42,
            activeModels: ['gpt-4o', 'gpt-4o-mini', 'o1-mini', 'o3-mini'],
            customModels: [],
            updatedAt: now,
          },
          anthropic: {
            id: 'anthropic',
            name: 'Anthropic Claude',
            displayName: 'Anthropic Claude',
            enabled: true,
            active: true,
            apiKey: process.env.ANTHROPIC_API_KEY ? maskSecretKey(process.env.ANTHROPIC_API_KEY) : '',
            apiKeyMasked: process.env.ANTHROPIC_API_KEY ? maskSecretKey(process.env.ANTHROPIC_API_KEY) : '',
            apiKeyRaw: process.env.ANTHROPIC_API_KEY || '',
            baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
            orgId: 'org-ct-anthropic',
            subscriptionTier: 'Team',
            status: process.env.ANTHROPIC_API_KEY ? 'connected' : 'untested',
            latencyMs: 38,
            activeModels: ['claude-haiku-4.5', 'claude-5-sonnet', 'claude-3-5-sonnet', 'claude-3-7-sonnet', 'claude-opus-4-8'],
            customModels: [],
            updatedAt: now,
          },
          gemini: {
            id: 'gemini',
            name: 'Google Gemini',
            displayName: 'Google Gemini',
            enabled: true,
            active: true,
            apiKey: process.env.GEMINI_API_KEY ? maskSecretKey(process.env.GEMINI_API_KEY) : '',
            apiKeyMasked: process.env.GEMINI_API_KEY ? maskSecretKey(process.env.GEMINI_API_KEY) : '',
            apiKeyRaw: process.env.GEMINI_API_KEY || '',
            baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
            orgId: 'org-ct-google',
            subscriptionTier: 'Pro',
            status: process.env.GEMINI_API_KEY ? 'connected' : 'untested',
            latencyMs: 55,
            activeModels: ['gemini-1.5-pro', 'gemini-2.0-pro'],
            customModels: [],
            updatedAt: now,
          },
          grok: {
            id: 'grok',
            name: 'xAI Grok',
            displayName: 'xAI Grok',
            enabled: true,
            active: true,
            apiKey: process.env.GROK_API_KEY ? maskSecretKey(process.env.GROK_API_KEY) : '',
            apiKeyMasked: process.env.GROK_API_KEY ? maskSecretKey(process.env.GROK_API_KEY) : '',
            apiKeyRaw: process.env.GROK_API_KEY || '',
            baseUrl: process.env.GROK_BASE_URL || 'https://api.x.ai/v1',
            orgId: 'org-ct-xai',
            subscriptionTier: 'Pro',
            status: process.env.GROK_API_KEY ? 'connected' : 'untested',
            latencyMs: 60,
            activeModels: ['grok-cli/grok-4.5', 'grok-2'],
            customModels: [],
            updatedAt: now,
          },
          deepseek: {
            id: 'deepseek',
            name: 'DeepSeek AI',
            displayName: 'DeepSeek AI',
            enabled: true,
            active: true,
            apiKey: process.env.DEEPSEEK_API_KEY ? maskSecretKey(process.env.DEEPSEEK_API_KEY) : '',
            apiKeyMasked: process.env.DEEPSEEK_API_KEY ? maskSecretKey(process.env.DEEPSEEK_API_KEY) : '',
            apiKeyRaw: process.env.DEEPSEEK_API_KEY || '',
            baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
            orgId: 'org-ct-deepseek',
            subscriptionTier: 'Pay-as-you-go',
            status: process.env.DEEPSEEK_API_KEY ? 'connected' : 'untested',
            latencyMs: 85,
            activeModels: ['deepseek-v3', 'deepseek-r1', 'deepseek-v4-pro'],
            customModels: [],
            updatedAt: now,
          },
          glm: {
            id: 'glm',
            name: 'Synthetic / GLM Router',
            displayName: 'Synthetic / GLM Router',
            enabled: true,
            active: true,
            apiKey: process.env.GLM_API_KEY || process.env.SYNTHETIC_API_KEY ? maskSecretKey(process.env.GLM_API_KEY || process.env.SYNTHETIC_API_KEY || '') : '',
            apiKeyMasked: process.env.GLM_API_KEY || process.env.SYNTHETIC_API_KEY ? maskSecretKey(process.env.GLM_API_KEY || process.env.SYNTHETIC_API_KEY || '') : '',
            apiKeyRaw: process.env.GLM_API_KEY || process.env.SYNTHETIC_API_KEY || '',
            baseUrl: process.env.SYNTHETIC_BASE_URL || 'https://api.omniroute.internal/v1',
            orgId: 'org-ct-glm',
            subscriptionTier: 'Free',
            status: 'disabled',
            latencyMs: 12,
            activeModels: [
              'glm-5.2',
              'synthetic/v1',
              'synthetic/glm-5.2-high',
              'synthetic/hf:zai-org/GLM-5.2',
              'synthetic/hf:moonshotai/Kimi-K3',
              'synthetic/hf:Qwen/Qwen3.6-27B',
              'synthetic/hf:zai-org/GLM-4.7-Flash',
            ],
            customModels: [],
            updatedAt: now,
          },
          openrouter: {
            id: 'openrouter',
            name: 'OpenRouter',
            displayName: 'OpenRouter Unified API',
            enabled: true,
            active: true,
            apiKey: (process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_PR_REVIEW_API_KEY) ? maskSecretKey(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_PR_REVIEW_API_KEY || '') : '',
            apiKeyMasked: (process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_PR_REVIEW_API_KEY) ? maskSecretKey(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_PR_REVIEW_API_KEY || '') : '',
            apiKeyRaw: process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_PR_REVIEW_API_KEY || '',
            baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
            orgId: 'org-ct-openrouter',
            subscriptionTier: 'Pay-as-you-go',
            status: (process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_PR_REVIEW_API_KEY) ? 'connected' : 'untested',
            latencyMs: 35,
            activeModels: [
              'openrouter/auto',
              'openrouter/anthropic/claude-3.7-sonnet',
              'openrouter/deepseek/deepseek-r1',
              'openrouter/google/gemini-2.5-pro',
              'openrouter/qwen/qwen-2.5-72b-instruct',
            ],
            customModels: [],
            updatedAt: now,
          },
          doppler: {
            id: 'doppler',
            name: 'Doppler Secret Sync',
            displayName: 'Doppler Secret Sync',
            enabled: true,
            active: true,
            apiKey: process.env.DOPPLER_TOKEN ? maskSecretKey(process.env.DOPPLER_TOKEN) : '',
            apiKeyMasked: process.env.DOPPLER_TOKEN ? maskSecretKey(process.env.DOPPLER_TOKEN) : '',
            apiKeyRaw: process.env.DOPPLER_TOKEN || '',
            baseUrl: 'https://api.doppler.com/v3',
            orgId: 'org-ct-doppler',
            subscriptionTier: 'Pro',
            status: process.env.DOPPLER_TOKEN ? 'connected' : 'untested',
            latencyMs: 25,
            activeModels: ['doppler-sync-v1'],
            customModels: [],
            updatedAt: now,
          },
          ollama: {
            id: 'ollama',
            name: 'Ollama Local LLM',
            displayName: 'Ollama Local LLM',
            enabled: true,
            active: true,
            baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
            orgId: 'local-ollama',
            subscriptionTier: 'Free',
            status: 'connected',
            latencyMs: 15,
            activeModels: ['llama3.3', 'qwen2.5-coder', 'deepseek-r1:8b'],
            customModels: ['qwen2.5-coder'],
            updatedAt: now,
          },
          'custom-openai': {
            id: 'custom-openai',
            name: 'Custom OpenAI-Compatible',
            displayName: 'Custom OpenAI-Compatible',
            enabled: false,
            active: false,
            apiKey: process.env.CUSTOM_OPENAI_API_KEY ? maskSecretKey(process.env.CUSTOM_OPENAI_API_KEY) : '',
            apiKeyMasked: process.env.CUSTOM_OPENAI_API_KEY ? maskSecretKey(process.env.CUSTOM_OPENAI_API_KEY) : '',
            apiKeyRaw: process.env.CUSTOM_OPENAI_API_KEY || '',
            baseUrl: process.env.CUSTOM_OPENAI_BASE_URL || 'https://api.custom-llm.com/v1',
            orgId: 'org-ct-custom',
            subscriptionTier: 'Pay-as-you-go',
            status: 'untested',
            latencyMs: 0,
            activeModels: ['custom-model-v1'],
            customModels: ['custom-model-v1'],
            updatedAt: now,
          },
          codex: {
            id: 'codex',
            name: 'Codex Gateway',
            displayName: 'Codex Gateway',
            enabled: true,
            active: true,
            baseUrl: 'https://api.codex.internal/v1',
            orgId: 'org-ct-codex',
            subscriptionTier: 'Enterprise',
            status: 'connected',
            latencyMs: 18,
            activeModels: ['codex/gpt-5.6-sol-high', 'gpt-5.6-sol'],
            customModels: [],
            updatedAt: now,
          },
          agy: {
            id: 'agy',
            name: 'AGY Thinking Engine',
            displayName: 'AGY Thinking Engine',
            enabled: true,
            active: true,
            baseUrl: 'https://api.agy.internal/v1',
            orgId: 'org-ct-agy',
            subscriptionTier: 'Enterprise',
            status: 'connected',
            latencyMs: 22,
            activeModels: ['agy/claude-opus-4-6-thinking'],
            customModels: [],
            updatedAt: now,
          },
        },
        modelRegistry: {
          'gpt-4o': { id: 'gpt-4o', providerId: 'openai', displayName: 'GPT-4o', enabled: true, contextWindowTokens: 128000, costPer1kPromptUSD: 0.0025, costPer1kCompletionUSD: 0.01 },
          'gpt-4o-mini': { id: 'gpt-4o-mini', providerId: 'openai', displayName: 'GPT-4o Mini', enabled: true, contextWindowTokens: 128000, costPer1kPromptUSD: 0.00015, costPer1kCompletionUSD: 0.0006 },
          'o1-mini': { id: 'o1-mini', providerId: 'openai', displayName: 'o1-mini Reasoning', enabled: true, contextWindowTokens: 128000, costPer1kPromptUSD: 0.003, costPer1kCompletionUSD: 0.012 },
          'o3-mini': { id: 'o3-mini', providerId: 'openai', displayName: 'o3-mini Reasoning', enabled: true, contextWindowTokens: 200000, costPer1kPromptUSD: 0.0011, costPer1kCompletionUSD: 0.0044 },
          'claude-haiku-4.5': { id: 'claude-haiku-4.5', providerId: 'anthropic', displayName: 'Claude Haiku 4.5', enabled: true, contextWindowTokens: 200000, costPer1kPromptUSD: 0.001, costPer1kCompletionUSD: 0.005 },
          'claude-5-sonnet': { id: 'claude-5-sonnet', providerId: 'anthropic', displayName: 'Claude 5 Sonnet', enabled: true, contextWindowTokens: 200000, costPer1kPromptUSD: 0.003, costPer1kCompletionUSD: 0.015 },
          'claude-opus-4-8': { id: 'claude-opus-4-8', providerId: 'anthropic', displayName: 'Claude Opus 4.8', enabled: true, contextWindowTokens: 200000, costPer1kPromptUSD: 0.015, costPer1kCompletionUSD: 0.075 },
          'gemini-1.5-pro': { id: 'gemini-1.5-pro', providerId: 'gemini', displayName: 'Gemini 1.5 Pro', enabled: true, contextWindowTokens: 1000000, costPer1kPromptUSD: 0.00125, costPer1kCompletionUSD: 0.005 },
          'gemini-2.0-pro': { id: 'gemini-2.0-pro', providerId: 'gemini', displayName: 'Gemini 2.0 Pro', enabled: true, contextWindowTokens: 2000000, costPer1kPromptUSD: 0.0025, costPer1kCompletionUSD: 0.01 },
          'grok-cli/grok-4.5': { id: 'grok-cli/grok-4.5', providerId: 'grok', displayName: 'Grok 4.5', enabled: true, contextWindowTokens: 128000, costPer1kPromptUSD: 0.002, costPer1kCompletionUSD: 0.01 },
          'grok-2': { id: 'grok-2', providerId: 'grok', displayName: 'Grok 2', enabled: true, contextWindowTokens: 128000, costPer1kPromptUSD: 0.002, costPer1kCompletionUSD: 0.01 },
          'deepseek-v3': { id: 'deepseek-v3', providerId: 'deepseek', displayName: 'DeepSeek V3', enabled: true, contextWindowTokens: 64000, costPer1kPromptUSD: 0.0005, costPer1kCompletionUSD: 0.002 },
          'deepseek-r1': { id: 'deepseek-r1', providerId: 'deepseek', displayName: 'DeepSeek R1 Reasoning', enabled: true, contextWindowTokens: 64000, costPer1kPromptUSD: 0.00055, costPer1kCompletionUSD: 0.00219 },
          'deepseek-v4-pro': { id: 'deepseek-v4-pro', providerId: 'deepseek', displayName: 'DeepSeek V4 Pro', enabled: true, contextWindowTokens: 128000, costPer1kPromptUSD: 0.001, costPer1kCompletionUSD: 0.004 },
          'glm-5.2': { id: 'glm-5.2', providerId: 'synthetic', displayName: 'GLM 5.2 Synthetic', enabled: true, contextWindowTokens: 128000, costPer1kPromptUSD: 0.001, costPer1kCompletionUSD: 0.002 },
          'synthetic/v1': { id: 'synthetic/v1', providerId: 'synthetic', displayName: 'Synthetic V1', enabled: true, contextWindowTokens: 128000, costPer1kPromptUSD: 0.001, costPer1kCompletionUSD: 0.002 },
          'synthetic/glm-5.2-high': { id: 'synthetic/glm-5.2-high', providerId: 'synthetic', displayName: 'Synthetic GLM-5.2 High', enabled: true, contextWindowTokens: 128000, costPer1kPromptUSD: 0.001, costPer1kCompletionUSD: 0.002 },
          'synthetic/hf:moonshotai/Kimi-K3': { id: 'synthetic/hf:moonshotai/Kimi-K3', providerId: 'synthetic', displayName: 'Synthetic Kimi K3 (2.8T MoE / 1M Context)', enabled: true, contextWindowTokens: 1000000, costPer1kPromptUSD: 0.001, costPer1kCompletionUSD: 0.002 },
          'synthetic/hf:zai-org/GLM-4.7-Flash': { id: 'synthetic/hf:zai-org/GLM-4.7-Flash', providerId: 'synthetic', displayName: 'Synthetic GLM 4.7 Flash (Cheap)', enabled: true, contextWindowTokens: 128000, costPer1kPromptUSD: 0.0005, costPer1kCompletionUSD: 0.001 },
          'synthetic/hf:Qwen/Qwen3.6-27B': { id: 'synthetic/hf:Qwen/Qwen3.6-27B', providerId: 'synthetic', displayName: 'Synthetic Qwen 3.6 27B', enabled: true, contextWindowTokens: 128000, costPer1kPromptUSD: 0.001, costPer1kCompletionUSD: 0.002 },
          'doppler-sync-v1': { id: 'doppler-sync-v1', providerId: 'doppler', displayName: 'Doppler Secret Sync V1', enabled: true },
          'llama3.3': { id: 'llama3.3', providerId: 'ollama', displayName: 'Llama 3.3 70B', enabled: true, contextWindowTokens: 128000, costPer1kPromptUSD: 0.0, costPer1kCompletionUSD: 0.0 },
          'qwen2.5-coder': { id: 'qwen2.5-coder', providerId: 'ollama', displayName: 'Qwen 2.5 Coder 32B', enabled: true, contextWindowTokens: 32000, costPer1kPromptUSD: 0.0, costPer1kCompletionUSD: 0.0, isCustom: true },
          'deepseek-r1:8b': { id: 'deepseek-r1:8b', providerId: 'ollama', displayName: 'DeepSeek R1 8B Local', enabled: true, contextWindowTokens: 64000, costPer1kPromptUSD: 0.0, costPer1kCompletionUSD: 0.0 },
          'custom-model-v1': { id: 'custom-model-v1', providerId: 'custom-openai', displayName: 'Custom Model V1', enabled: true, isCustom: true },
          'openrouter/auto': { id: 'openrouter/auto', providerId: 'openrouter', displayName: 'OpenRouter Auto Router (openrouter/auto)', enabled: true, contextWindowTokens: 128000, costPer1kPromptUSD: 0.0001, costPer1kCompletionUSD: 0.0003 },
          'openrouter/anthropic/claude-3.7-sonnet': { id: 'openrouter/anthropic/claude-3.7-sonnet', providerId: 'openrouter', displayName: 'Claude 3.7 Sonnet (OpenRouter)', enabled: true, contextWindowTokens: 200000, costPer1kPromptUSD: 0.003, costPer1kCompletionUSD: 0.015 },
          'openrouter/deepseek/deepseek-r1': { id: 'openrouter/deepseek/deepseek-r1', providerId: 'openrouter', displayName: 'DeepSeek R1 (OpenRouter)', enabled: true, contextWindowTokens: 164000, costPer1kPromptUSD: 0.00055, costPer1kCompletionUSD: 0.00219 },
          'openrouter/google/gemini-2.5-pro': { id: 'openrouter/google/gemini-2.5-pro', providerId: 'openrouter', displayName: 'Gemini 2.5 Pro (OpenRouter)', enabled: true, contextWindowTokens: 2000000, costPer1kPromptUSD: 0.0025, costPer1kCompletionUSD: 0.01 },
          'openrouter/qwen/qwen-2.5-72b-instruct': { id: 'openrouter/qwen/qwen-2.5-72b-instruct', providerId: 'openrouter', displayName: 'Qwen 2.5 72B (OpenRouter)', enabled: true, contextWindowTokens: 128000, costPer1kPromptUSD: 0.0004, costPer1kCompletionUSD: 0.0004 },
          'codex/gpt-5.6-sol-high': { id: 'codex/gpt-5.6-sol-high', providerId: 'codex', displayName: 'Codex GPT-5.6 Sol High', enabled: true, contextWindowTokens: 200000, costPer1kPromptUSD: 0.005, costPer1kCompletionUSD: 0.02 },
          'gpt-5.6-sol': { id: 'gpt-5.6-sol', providerId: 'codex', displayName: 'GPT-5.6 Sol Standard', enabled: true, contextWindowTokens: 200000, costPer1kPromptUSD: 0.004, costPer1kCompletionUSD: 0.016 },
          'agy/claude-opus-4-6-thinking': { id: 'agy/claude-opus-4-6-thinking', providerId: 'agy', displayName: 'AGY Claude Opus 4.6 Thinking', enabled: true, contextWindowTokens: 200000, costPer1kPromptUSD: 0.01, costPer1kCompletionUSD: 0.05 },
        },
      },
      apiKeys: [],
      reviewCounter: process.env.CT_DEMO_MODE === 'true' ? 4 : 0,
      totalCostUSD: process.env.CT_DEMO_MODE === 'true' ? 1.745 : 0,
      totalPromptTokens: process.env.CT_DEMO_MODE === 'true' ? 153900 : 0,
      totalCompletionTokens: process.env.CT_DEMO_MODE === 'true' ? 18800 : 0,
      reviewLogs: process.env.CT_DEMO_MODE === 'true' ? [
        {
          id: 'job-prod-3056',
          prRun: 'calltelemetry/cisco-cdr #3056',
          repo: 'calltelemetry/cisco-cdr',
          prNumber: 3056,
          title: 'feat(security): sanitize sql parameter inputs & enforce multi-tenant CDR bounds (PR #3056)',
          headSha: '7da0fe09',
          personas: ['security', 'architecture', 'quality', 'database', 'performance'],
          quorum: '5/5',
          arbiterVerdict: 'SHIP',
          verdict: 'SHIP',
          timestamp: now,
          latencyMs: 1840,
          costUSD: 0.547,
          cost: 0.547,
          tokens: { prompt: 48500, completion: 6200, total: 54700 },
          tokenDetails: { prompt: 48500, completion: 6200, total: 54700 },
          status: 'completed',
          personaLogs: [
            {
              persona: 'security',
              displayName: '🛡️ Security & Tenancy Guardian',
              decision: 'SHIP',
              confidence: 0.98,
              latencyMs: 420,
              model: 'claude-5-sonnet',
              findingsCount: 0,
              summary: 'Verified multi-tenant isolation bounds, zero SQL parameter leakage in 54k diff.',
            },
            {
              persona: 'architecture',
              displayName: '🏛️ System Architecture & Design',
              decision: 'SHIP',
              confidence: 0.96,
              latencyMs: 510,
              model: 'grok-cli/grok-4.5',
              findingsCount: 0,
              summary: 'Approved ingestion layer interface contracts across 14 modified modules.',
            },
            {
              persona: 'quality',
              displayName: '✨ Code Quality & Style',
              decision: 'SHIP',
              confidence: 0.94,
              latencyMs: 380,
              model: 'claude-5-sonnet',
              findingsCount: 0,
              summary: 'Clean TypeScript types with 100% test coverage.',
            },
            {
              persona: 'database',
              displayName: '🗄️ Database & Persistence',
              decision: 'SHIP',
              confidence: 0.92,
              latencyMs: 410,
              model: 'glm-5.2',
              findingsCount: 0,
              summary: 'Validated concurrent B-tree index creation statements.',
            },
          ],
        },
        {
          id: 'job-prod-3054',
          prRun: 'calltelemetry/ct-review-bot #3054',
          repo: 'calltelemetry/ct-review-bot',
          prNumber: 3054,
          title: 'perf(ci): implement relative test execution, Vitest caching, and singleFork pool performance tuning (Commit 6270249)',
          headSha: 'a8e14f2e',
          personas: ['security', 'architecture', 'quality', 'database'],
          quorum: '4/4',
          arbiterVerdict: 'SHIP',
          verdict: 'SHIP',
          timestamp: now,
          latencyMs: 1840,
          costUSD: 0.326,
          cost: 0.326,
          tokens: { prompt: 28400, completion: 4200, total: 32600 },
          tokenDetails: { prompt: 28400, completion: 4200, total: 32600 },
          status: 'completed',
          personaLogs: [
            {
              persona: 'security',
              displayName: '🛡️ Security & Tenancy Guardian',
              decision: 'SHIP',
              confidence: 0.98,
              latencyMs: 420,
              model: 'claude-5-sonnet',
              findingsCount: 0,
              summary: 'Verified CI caching permissions & container isolation.',
            },
            {
              persona: 'architecture',
              displayName: '🏛️ System Architecture & Design',
              decision: 'SHIP',
              confidence: 0.96,
              latencyMs: 510,
              model: 'grok-cli/grok-4.5',
              findingsCount: 0,
              summary: 'Approved Vitest singleFork thread pool configuration.',
            },
          ],
        },
        {
          id: 'job-prod-108',
          prRun: 'calltelemetry/ct-meta #108',
          repo: 'calltelemetry/ct-meta',
          prNumber: 108,
          title: 'feat(contract): OpenAPI v3 schema validation & tenant policy sync for PR #108',
          headSha: 'a1b2c3d',
          personas: ['security', 'architecture', 'api_contract'],
          quorum: '3/3',
          arbiterVerdict: 'SHIP',
          verdict: 'SHIP',
          timestamp: now,
          latencyMs: 2450,
          costUSD: 0.365,
          cost: 0.365,
          tokens: { prompt: 32400, completion: 4100, total: 36500 },
          tokenDetails: { prompt: 32400, completion: 4100, total: 36500 },
          status: 'completed',
          personaLogs: [
            {
              persona: 'security',
              displayName: '🛡️ Security & Tenancy Guardian',
              decision: 'SHIP',
              confidence: 0.97,
              latencyMs: 750,
              model: 'claude-haiku-4.5',
              findingsCount: 0,
              summary: 'Validated tenant policy synchronization and OpenAPI RBAC rules.',
            },
            {
              persona: 'architecture',
              displayName: '🏛️ System Architecture & Design',
              decision: 'SHIP',
              confidence: 0.95,
              latencyMs: 890,
              model: 'grok-cli/grok-4.5',
              findingsCount: 0,
              summary: 'Confirmed schema definitions match enterprise contract spec.',
            },
            {
              persona: 'api_contract',
              displayName: '🔌 API Contract & Integration',
              decision: 'SHIP',
              confidence: 0.94,
              latencyMs: 810,
              model: 'claude-haiku-4.5',
              findingsCount: 0,
              summary: 'No breaking changes detected in v3 endpoint payload schemas.',
            },
          ],
        },
      ] : [],
      integrations: {
        linear: {
          id: 'linear',
          name: 'Linear Issue Tracker',
          status: 'disconnected',
          lastSyncAt: now,
          settings: { teamKey: 'CT' },
          updatedAt: now,
        },
        github: {
          id: 'github',
          name: 'GitHub App Integration',
          status: 'connected',
          settings: { appId: '1092381' },
          updatedAt: now,
        },
        context7: {
          id: 'context7',
          name: 'Context7 Docs MCP',
          status: 'disconnected',
          lastSyncAt: now,
          updatedAt: now,
        },
        productlane: {
          id: 'productlane',
          name: 'Productlane Feedback',
          status: 'disconnected',
          updatedAt: now,
        },
        posthog: {
          id: 'posthog',
          name: 'PostHog Analytics',
          status: 'disconnected',
          settings: { projectId: '10492' },
          updatedAt: now,
        },
        doppler: {
          id: 'doppler',
          name: 'Doppler Secret Manager',
          status: 'disconnected',
          lastSyncAt: now,
          settings: { project: 'ct-review-bot', configName: 'prd' },
          updatedAt: now,
        },
        sentry: {
          id: 'sentry',
          name: 'Sentry Error Tracking',
          status: 'disconnected',
          lastSyncAt: now,
          settings: { orgSlug: 'calltelemetry', projectSlug: 'review-bot' },
          updatedAt: now,
        },
        jira: {
          id: 'jira',
          name: 'Jira Software Integration',
          status: 'disconnected',
          lastSyncAt: now,
          settings: { hostUrl: 'https://calltelemetry.atlassian.net', email: 'bot@calltelemetry.com', projectKey: 'CT' },
          updatedAt: now,
        },
        slack: {
          id: 'slack',
          name: 'Slack Notifications & Webhooks',
          status: 'disconnected',
          webhookUrl: 'https://hooks.slack.com/services/T00/B00/X00',
          lastSyncAt: now,
          settings: { defaultChannel: '#code-reviews' },
          updatedAt: now,
        },
      },
      mcpServers: [
        {
          id: 'builtin-context7',
          name: 'Context7 Documentation MCP',
          transport: 'adapter',
          enabled: true,
          status: 'online',
          toolsCount: 1,
          lastHealthCheckAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
  }

  private load(): DashboardData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        const defaults = this.defaultData();

        const loadedSettings = parsed.settings || {};
        const defaultPersonas = defaults.settings.personaSettings || {};
        const loadedPersonas = loadedSettings.personaSettings || {};

        const mergedPersonas: Record<string, PersonaSetting> = {};
        for (const [key, defaultPersona] of Object.entries(defaultPersonas)) {
          const loadedPersona = loadedPersonas[key] || {};
          mergedPersonas[key] = {
            ...defaultPersona,
            ...loadedPersona,
            id: key,
          };
        }
        for (const [key, loadedPersona] of Object.entries(loadedPersonas)) {
          if (!mergedPersonas[key]) {
            mergedPersonas[key] = {
              ...(loadedPersona as PersonaSetting),
              id: key,
            };
          }
        }

        const defaultProviders = defaults.settings.providerConfigs || {};
        const loadedProviders = loadedSettings.providerConfigs || {};
        const mergedProviders: Record<string, ProviderConfigRecord> = {};
        for (const [key, defaultProv] of Object.entries(defaultProviders)) {
          const loadedProv = loadedProviders[key] || {};
          mergedProviders[key] = {
            ...defaultProv,
            ...loadedProv,
            id: key,
          };
        }
        for (const [key, loadedProv] of Object.entries(loadedProviders)) {
          if (!mergedProviders[key]) {
            mergedProviders[key] = {
              ...(loadedProv as ProviderConfigRecord),
              id: key,
            };
          }
        }

        const defaultModels = defaults.settings.modelRegistry || {};
        const loadedModels = loadedSettings.modelRegistry || {};
        const mergedModels: Record<string, ModelRegistryItem> = {
          ...defaultModels,
          ...loadedModels,
        };

        parsed.settings = {
          ...defaults.settings,
          ...loadedSettings,
          defaultModelOverrides: {
            ...defaults.settings.defaultModelOverrides,
            ...(loadedSettings.defaultModelOverrides || {}),
          },
          personaSettings: mergedPersonas,
          providerConfigs: mergedProviders,
          modelRegistry: mergedModels,
          memoryEngineSettings: {
            ...defaults.settings.memoryEngineSettings,
            ...(loadedSettings.memoryEngineSettings || {}),
          },
          providerCostCaps: {
            ...defaults.settings.providerCostCaps,
            ...(loadedSettings.providerCostCaps || {}),
          },
          githubAppConfig: {
            ...defaults.settings.githubAppConfig,
            ...(loadedSettings.githubAppConfig || {}),
          },
          autoReviewSettings: {
            ...defaults.settings.autoReviewSettings,
            ...(loadedSettings.autoReviewSettings || {}),
          },
          enforcementPolicy: {
            ...defaults.settings.enforcementPolicy,
            ...(loadedSettings.enforcementPolicy || {}),
          },
          customApiBases: {
            ...defaults.settings.customApiBases,
            ...(loadedSettings.customApiBases || {}),
          },
        };

        if (!parsed.repositories || !Array.isArray(parsed.repositories)) {
          parsed.repositories = defaults.repositories;
        }
        if (!parsed.apiKeys || !Array.isArray(parsed.apiKeys)) {
          parsed.apiKeys = defaults.apiKeys;
        }

        return this.ensureDailyCountsSeeded(parsed);
      }
    } catch {
      // Fallback on default data if parse error occurs
    }
    const defaults = this.defaultData();
    this.saveData(defaults);
    return this.ensureDailyCountsSeeded(defaults);
  }

  private ensureDailyCountsSeeded(data: DashboardData): DashboardData {
    if (!data) return data;
    if (!data.dailyReviewCounts) {
      data.dailyReviewCounts = {};
    }
    const logs = data.reviewLogs || [];
    const countsFromLogs: Record<string, number> = {};
    for (const log of logs) {
      if (!log.timestamp) continue;
      try {
        const d = new Date(log.timestamp);
        if (!isNaN(d.getTime())) {
          const dateStr = d.toISOString().slice(0, 10);
          countsFromLogs[dateStr] = (countsFromLogs[dateStr] || 0) + 1;
        }
      } catch {}
    }
    for (const [dateStr, count] of Object.entries(countsFromLogs)) {
      if ((data.dailyReviewCounts[dateStr] || 0) < count) {
        data.dailyReviewCounts[dateStr] = count;
      }
    }
    return data;
  }

  private saveData(data: DashboardData): void {
    this.invalidateCache();
    let dir = path.dirname(this.filePath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch {
      this.filePath = '/tmp/ct-review-bot/dashboard.json';
      dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    const tmp = `${this.filePath}.tmp.${Date.now()}_${Math.random().toString(36).substring(2)}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch {
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
      } catch {
        try {
          const fallback = '/tmp/ct-review-bot/dashboard.json';
          const fallbackDir = path.dirname(fallback);
          if (!fs.existsSync(fallbackDir)) {
            fs.mkdirSync(fallbackDir, { recursive: true });
          }
          fs.writeFileSync(fallback, JSON.stringify(data, null, 2), 'utf8');
          this.filePath = fallback;
        } catch {
          // fallback ignored
        }
      }
    }
    this.data = data;
    this.invalidateCache();
    if (postgresStore.isConfigured()) {
      postgresStore.saveSettings(data.settings).catch(() => {});
      if (data.repositories) {
        data.repositories.forEach((r) => postgresStore.saveRepository(r).catch(() => {}));
      }
      if (data.settings?.personaSettings) {
        Object.values(data.settings.personaSettings).forEach((p) => {
          postgresStore.savePersona(p).catch(() => {});
        });
      }
      if (data.settings?.providerConfigs) {
        Object.values(data.settings.providerConfigs).forEach((pr) => {
          postgresStore.saveProvider(pr).catch(() => {});
        });
      }
    }
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public getRepositories(): RepoDashboardSetting[] {
    return this.data.repositories.map((r) => {
      const owner = r.owner || (r.full_name && r.full_name.includes('/') ? r.full_name.split('/')[0] : '');
      const repo = r.repo || (r.full_name && r.full_name.includes('/') ? r.full_name.split('/')[1] : r.name || '');
      const full_name = r.full_name || `${owner}/${repo}`;
      const name = r.name || repo;
      const id = r.id || full_name;
      const strictnessProfile = r.strictnessProfile || r.customProfile || 'balanced';
      const customProfile = r.customProfile || strictnessProfile;
      return {
        ...r,
        id,
        name,
        full_name,
        owner,
        repo,
        private: r.private !== undefined ? r.private : false,
        automationEnabled: r.automationEnabled !== undefined ? r.automationEnabled : true,
        generateArchitecturalFlowchart: r.generateArchitecturalFlowchart !== undefined ? r.generateArchitecturalFlowchart : true,
        strictnessProfile,
        customProfile,
        defaultBranch: r.defaultBranch || 'main',
        updatedAt: r.updatedAt || new Date().toISOString(),
      };
    });
  }

  public getRepository(owner: string, repo: string): RepoDashboardSetting | undefined {
    return this.getRepositories().find((r) => (r.owner === owner && r.repo === repo) || r.id === `${owner}/${repo}` || r.full_name === `${owner}/${repo}`);
  }

  public updateRepository(owner: string, repo: string, patch: Partial<RepoDashboardSetting>): RepoDashboardSetting {
    let item = this.data.repositories.find((r) => (r.owner === owner && r.repo === repo) || (patch.id && r.id === patch.id) || (patch.full_name && r.full_name === patch.full_name));
    if (!item) {
      const full_name = patch.full_name || `${owner}/${repo}`;
      const name = patch.name || repo;
      const id = patch.id || full_name;
      item = {
        id,
        name,
        full_name,
        owner,
        repo,
        private: patch.private !== undefined ? patch.private : false,
        automationEnabled: patch.automationEnabled !== undefined ? patch.automationEnabled : true,
        generateArchitecturalFlowchart: patch.generateArchitecturalFlowchart !== undefined ? patch.generateArchitecturalFlowchart : true,
        strictnessProfile: patch.strictnessProfile || patch.customProfile || 'balanced',
        customProfile: patch.customProfile || patch.strictnessProfile || 'balanced',
        defaultBranch: patch.defaultBranch || 'main',
        updatedAt: new Date().toISOString(),
      };
      this.data.repositories.push(item);
    }
    if (patch.modelOverrides) {
      for (const [provider, model] of Object.entries(patch.modelOverrides)) {
        if (typeof model !== 'string' || !model.trim()) {
          throw new Error(`model for '${provider}' must be a non-empty string`);
        }
      }
    }
    const strictnessProfile = patch.strictnessProfile || patch.customProfile || item.strictnessProfile || item.customProfile || 'balanced';
    const customProfile = patch.customProfile || patch.strictnessProfile || item.customProfile || item.strictnessProfile || 'balanced';

    Object.assign(item, patch, {
      owner,
      repo,
      name: patch.name || item.name || repo,
      full_name: patch.full_name || item.full_name || `${owner}/${repo}`,
      id: patch.id || item.id || patch.full_name || `${owner}/${repo}`,
      strictnessProfile,
      customProfile,
      updatedAt: new Date().toISOString(),
    });
    this.saveData(this.data);
    return item;
  }

  public isAutomationEnabled(owner: string, repo: string): boolean {
    const repoItem = this.getRepository(owner, repo);
    return repoItem ? repoItem.automationEnabled : true;
  }

  public getSettings(): PlatformSettings {
    const settings = JSON.parse(JSON.stringify(this.data.settings));
    if (settings.defaultMaxTurns === undefined) {
      settings.defaultMaxTurns = 20;
    }
    if (settings.defaultEffort === undefined) {
      settings.defaultEffort = 'low';
    }
    if (settings.providerConfigs) {
      for (const prov of Object.values(settings.providerConfigs as Record<string, any>)) {
        if (prov) {
          delete prov.apiKeyRaw;
          if (prov.apiKey && !prov.apiKey.includes('*') && prov.apiKey.length > 8) {
            prov.apiKey = maskSecretKey(prov.apiKey);
          }
        }
      }
    }
    return settings;
  }

  public getDynamicActiveModels(): string[] {
    const activeModelsSet = new Set<string>();
    const providerConfigs = this.getProviderConfigs();
    const registry = this.data.settings?.modelRegistry || {};

    const getProviderIdForModel = (mId: string, item?: ModelRegistryItem): string | undefined => {
      if (item?.providerId) return item.providerId;
      for (const [providerId, config] of Object.entries(providerConfigs)) {
        if (config.activeModels?.includes(mId) || config.customModels?.includes(mId)) {
          return providerId;
        }
      }
      if (mId.startsWith('claude')) return 'anthropic';
      if (mId.startsWith('gpt-') || mId.startsWith('o1-') || mId.startsWith('o3-')) return 'openai';
      if (mId.startsWith('deepseek')) return 'deepseek';
      if (mId.startsWith('glm') || mId.startsWith('synthetic')) return 'glm';
      if (mId.startsWith('grok')) return 'grok';
      if (mId.startsWith('gemini')) return 'gemini';
      if (mId.startsWith('codex')) return 'codex';
      if (mId.startsWith('agy')) return 'agy';
      if (mId.startsWith('llama') || mId.startsWith('qwen')) return 'ollama';
      if (mId.startsWith('doppler')) return 'doppler';
      return undefined;
    };

    const isProviderEnabled = (providerId: string): boolean => {
      const realId = providerId === 'synthetic' ? 'glm' : providerId;
      const config = providerConfigs[realId];
      if (!config) return true;
      return config.enabled !== false && config.active !== false;
    };

    const isModelAllowedByProvider = (mId: string, providerId: string): boolean => {
      const realId = providerId === 'synthetic' ? 'glm' : providerId;
      const cfg = providerConfigs[realId];
      if (!cfg) return true;
      if (cfg.enabled === false || cfg.active === false) return false;
      if (mId === 'openrouter/auto' || mId.startsWith('synthetic/') || mId.startsWith('glm') || mId.startsWith('opencode')) return true;
      if (Array.isArray(cfg.activeModels) && cfg.activeModels.length > 0) {
        const inActive = cfg.activeModels.includes(mId);
        const inCustom = Array.isArray(cfg.customModels) && cfg.customModels.includes(mId);
        if (!inActive && !inCustom) return false;
      }
      return true;
    };

    for (const [pId, config] of Object.entries(providerConfigs)) {
      if (config.enabled !== false && config.active !== false) {
        if (Array.isArray(config.activeModels)) {
          for (const m of config.activeModels) {
            activeModelsSet.add(m);
          }
        }
        if (Array.isArray(config.customModels)) {
          for (const m of config.customModels) {
            activeModelsSet.add(m);
          }
        }
      }
    }

    for (const [mId, item] of Object.entries(registry)) {
      if (item.enabled !== false && isProviderEnabled(item.providerId) && isModelAllowedByProvider(mId, item.providerId)) {
        activeModelsSet.add(mId);
      }
    }

    for (const mId of R4_ALLOWED_MODELS) {
      const item = registry[mId];
      const pId = getProviderIdForModel(mId, item);
      if (pId && isProviderEnabled(pId) && isModelAllowedByProvider(mId, pId)) {
        if (!item || item.enabled !== false) {
          activeModelsSet.add(mId);
        }
      }
    }

    return Array.from(activeModelsSet);
  }

  public getProviderConfigs(): Record<string, ProviderConfigRecord> {
    // Use raw data directly so apiKeyRaw is available for masking
    const configs = this.data.settings.providerConfigs || this.defaultData().settings.providerConfigs || {};
    const defaults = this.defaultData().settings.providerConfigs || {};
    const result: Record<string, ProviderConfigRecord> = {};

    for (const id of Object.keys({ ...defaults, ...configs })) {
      const cfg = configs[id] || defaults[id] || { id, displayName: id, enabled: true, activeModels: [] };
      const name = cfg.name || cfg.displayName || id;
      const displayName = cfg.displayName || name;
      const active = cfg.active !== undefined ? cfg.active : cfg.enabled;
      const enabled = cfg.enabled !== undefined ? cfg.enabled : active;
      const apiKeyMasked = (cfg.apiKeyRaw && !cfg.apiKeyRaw.includes('*'))
        ? maskSecretKey(cfg.apiKeyRaw)
        : (cfg.apiKeyMasked || maskSecretKey(cfg.apiKey) || '');
      const apiKey = cfg.apiKey || apiKeyMasked;

      let subTier = normalizeSubscriptionTier(cfg.subscriptionTier);

      result[id] = {
        ...cfg,
        id,
        name,
        displayName,
        active,
        enabled,
        apiKey,
        apiKeyMasked,
        baseUrl: cfg.baseUrl || 'https://api.openai.com/v1',
        orgId: cfg.orgId || `org-ct-${id}`,
        subscriptionTier: subTier as any,
        status: cfg.status || 'connected',
        latencyMs: cfg.latencyMs !== undefined ? cfg.latencyMs : 42,
        activeModels: cfg.activeModels || [],
        customModels: cfg.customModels || [],
        apiKeyRaw: cfg.apiKeyRaw || (cfg.apiKey && !cfg.apiKey.includes('*') ? cfg.apiKey : undefined),
        updatedAt: cfg.updatedAt || new Date().toISOString(),
      };
    }
    return result;
  }

  public getProviderConfig(providerId: string): ProviderConfigRecord | undefined {
    const configs = this.getProviderConfigs();
    return configs[providerId];
  }

  public updateProviderConfig(providerId: string, patch: Partial<ProviderConfigRecord>): ProviderConfigRecord {
    if (patch.apiKeyRaw !== undefined || patch.apiKey !== undefined) {
      const rawKey = patch.apiKeyRaw !== undefined ? patch.apiKeyRaw : patch.apiKey;
      if (rawKey !== undefined && rawKey !== '') {
        const check = validateApiKeyFormat(rawKey, providerId);
        if (!check.valid) {
          throw new Error(`Invalid API key format for provider '${providerId}': ${check.reason}`);
        }
      }
    }

    const currentConfigs = this.data.settings.providerConfigs || this.defaultData().settings.providerConfigs || {};
    const defaults = this.defaultData().settings.providerConfigs?.[providerId] || {
      id: providerId,
      displayName: providerId,
      name: providerId,
      enabled: true,
      active: true,
      activeModels: [],
      updatedAt: new Date().toISOString(),
    };
    const current = currentConfigs[providerId] || defaults;

    let subTier = normalizeSubscriptionTier(patch.subscriptionTier !== undefined ? patch.subscriptionTier : current.subscriptionTier);

    const active = patch.active !== undefined ? patch.active : (patch.enabled !== undefined ? patch.enabled : current.active);
    const enabled = patch.enabled !== undefined ? patch.enabled : (patch.active !== undefined ? patch.active : current.enabled);

    const updated: ProviderConfigRecord = {
      ...current,
      ...patch,
      id: providerId,
      name: patch.name || patch.displayName || current.name || current.displayName || providerId,
      displayName: patch.displayName || patch.name || current.displayName || current.name || providerId,
      active: active !== undefined ? active : true,
      enabled: enabled !== undefined ? enabled : true,
      subscriptionTier: subTier as any,
      updatedAt: new Date().toISOString(),
    };
    if (patch.apiKeyRaw || patch.apiKey) {
      const rawKey = patch.apiKeyRaw || patch.apiKey;
      updated.apiKeyRaw = rawKey;
      updated.apiKeyMasked = maskSecretKey(rawKey);
      updated.apiKey = updated.apiKeyMasked;
    }
    if (!this.data.settings.providerConfigs) {
      this.data.settings.providerConfigs = { ...currentConfigs };
    }
    this.data.settings.providerConfigs[providerId] = updated;

    const currentModels = new Set(current.activeModels || []);
    const activePersonas = Object.values(this.getPersonaSettings())
      .filter((p) => p.enabled !== false && (
        p.providerId === providerId
        || p.model?.startsWith(`${providerId}/`)
        || currentModels.has(p.model)
        || (updated.activeModels || []).includes(p.model)
      ));
    const activeModels = new Set(updated.activeModels || []);
    const providerDisabled = patch.enabled === false || patch.active === false;
    if (providerDisabled || patch.activeModels !== undefined) {
      for (const p of activePersonas) {
        if (providerDisabled || !activeModels.has(p.model)) {
          this.data.settings.providerConfigs[providerId] = current;
          throw new Error(
            `Cannot disable provider or model '${providerId}': Active persona '${p.displayName || p.id}' relies on model '${p.model}'`
          );
        }
      }
    }

    this.saveData(this.data);

    try {
      providerPool.upsertProvider({
        id: providerId,
        type: providerId,
        apiKey: updated.apiKeyRaw || current.apiKeyRaw || '',
        baseUrl: updated.baseUrl,
        models: updated.activeModels && updated.activeModels.length > 0 ? updated.activeModels : ['default'],
      });
    } catch (_) {}

    return updated;
  }

  public getModelRegistry(): Record<string, ModelRegistryItem> {
    const settings = this.getSettings();
    return settings.modelRegistry || this.defaultData().settings.modelRegistry || {};
  }

  public validatePersonaSetting(persona: any, id?: string): void {
    if (!persona || typeof persona !== 'object') {
      throw new Error(`Invalid persona settings for '${id || 'unknown'}'`);
    }
    const key = id || persona.id || 'persona';
    if (typeof persona.confidenceThreshold !== 'number' || persona.confidenceThreshold < 0 || persona.confidenceThreshold > 100 || !Number.isFinite(persona.confidenceThreshold)) {
      throw new Error(`confidenceThreshold for '${key}' must be between 0 and 100`);
    }
    const allowedEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (typeof persona.effort !== 'string' || !allowedEfforts.includes(persona.effort)) {
      throw new Error(`effort for '${key}' must be one of low, medium, high, xhigh, max`);
    }
    if (persona.maxTurns !== undefined) {
      if (typeof persona.maxTurns !== 'number' || !Number.isInteger(persona.maxTurns) || persona.maxTurns < 1 || persona.maxTurns > 20) {
        throw new Error(`maxTurns for '${key}' must be an integer between 1 and 20`);
      }
    }
    if (typeof persona.model !== 'string' || !persona.model.trim()) {
      throw new Error(`model for '${key}' must be a non-empty string`);
    }
    if (persona.model.includes('gemini-2.0-flash') && !persona.model.includes('gemini-2.0-flash-lite')) {
      throw new Error(`model '${persona.model}' for '${key}' is a banned model`);
    }

    const allowedModels = this.getDynamicActiveModels();
    const provId = persona.model.startsWith('openrouter/') ? 'openrouter' :
                   persona.model.startsWith('claude') ? 'anthropic' :
                   persona.model.startsWith('gpt-') || persona.model.startsWith('o1-') || persona.model.startsWith('o3-') || persona.model.startsWith('openai/') ? 'openai' :
                   persona.model.startsWith('grok') ? 'grok' :
                   persona.model.startsWith('gemini') || persona.model.startsWith('google/') ? 'gemini' :
                   persona.model.startsWith('deepseek') ? 'deepseek' :
                   persona.model.startsWith('qwen') ? 'qwen' :
                   persona.model.startsWith('codex') ? 'codex' :
                   persona.model.startsWith('glm') || persona.model.startsWith('synthetic') ? 'synthetic' : undefined;

    const provConfigs = this.getProviderConfigs();
    if (provId && provConfigs[provId]) {
      const pCfg = provConfigs[provId];
      if (pCfg.enabled === false || pCfg.active === false) {
        throw new Error(`model '${persona.model}' for '${key}' is not an allowed model override`);
      }
    }

    if (!allowedModels.includes(persona.model) && !R4_ALLOWED_MODELS.includes(persona.model as any)) {
      throw new Error(`model '${persona.model}' for '${key}' is not an allowed model override`);
    }
    if (typeof persona.enabled !== 'boolean') {
      throw new Error(`enabled for '${key}' must be a boolean`);
    }
    if (persona.required !== undefined && typeof persona.required !== 'boolean') {
      throw new Error(`required for '${key}' must be a boolean`);
    }
    if (persona.charter !== undefined && typeof persona.charter !== 'string') {
      throw new Error(`charter for '${key}' must be a string`);
    }
    if (persona.customPrompt !== undefined && typeof persona.customPrompt !== 'string') {
      throw new Error(`customPrompt for '${key}' must be a string`);
    }
    if (persona.paths !== undefined && (!Array.isArray(persona.paths) || persona.paths.some((p: any) => typeof p !== 'string'))) {
      throw new Error(`paths for '${key}' must be an array of strings`);
    }
    if (persona.providers !== undefined && (!Array.isArray(persona.providers) || persona.providers.some((p: any) => typeof p !== 'string'))) {
      throw new Error(`providers for '${key}' must be an array of strings`);
    }
  }

  public getPersonaSettings(): Record<string, PersonaSetting> {
    const settings = this.getSettings();
    const personas = settings.personaSettings || this.defaultData().settings.personaSettings || {};
    const defaults = this.defaultData().settings.personaSettings || {};
    const result: Record<string, PersonaSetting> = {};

    const standardIds = [
      'security', 'architecture', 'performance', 'quality', 'database',
      'api_contract', 'docs_compliance', 'reliability', 'devops', 'finops', 'red_team', 'review_flowchart'
    ];

    for (const key of standardIds) {
      let item = personas[key] || defaults[key];
      if (!item) continue;
      let modelId = item.modelId || item.model;
      let providerId = item.providerId || 'synthetic';

      if (!modelId) {
        const defItem = defaults[key];
        if (defItem) {
          modelId = defItem.modelId || defItem.model;
          providerId = defItem.providerId || 'synthetic';
        } else {
          modelId = 'synthetic/hf:zai-org/GLM-5.2';
          providerId = 'synthetic';
        }
      }

      const defPersona = defaults[key];
      const effortLevel = item.effortLevel || item.effort || 'low';
      const name = item.name || item.displayName || key;
      result[key] = {
        ...item,
        id: key,
        personaId: key,
        name,
        displayName: item.displayName || name,
        model: modelId,
        modelId,
        providerId,
        effort: effortLevel as any,
        effortLevel: effortLevel as any,
        // Preserve an explicit empty override so panelEngine can fall through
        // to a repository/YAML prompt instead of restoring the built-in text.
        customPrompt: item.customPrompt !== undefined ? item.customPrompt : (defPersona?.customPrompt || ''),
        charter: (item.charter !== undefined && item.charter !== '') ? item.charter : (defPersona?.charter || ''),
        maxTurns: item.maxTurns !== undefined ? item.maxTurns : (defPersona?.maxTurns || 20),
        confidenceThreshold: item.confidenceThreshold !== undefined ? item.confidenceThreshold : 75,
      };
    }
    Object.defineProperty(result, 'documentation', {
      get: () => {
        const docs = result['docs_compliance'];
        return docs ? { ...docs, id: 'documentation', personaId: 'documentation' } : undefined;
      },
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(result, 'linear_sync', {
      get: () => {
        const item = result['finops'];
        return item ? { ...item, id: 'linear_sync', personaId: 'linear_sync' } : undefined;
      },
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(result, 'ux_product', {
      get: () => {
        const item = result['red_team'];
        return item ? { ...item, id: 'ux_product', personaId: 'ux_product' } : undefined;
      },
      enumerable: false,
      configurable: true,
    });
    return result;
  }

  public getPersonaSetting(personaId: string): PersonaSetting | undefined {
    const personas = this.getPersonaSettings();
    if (personaId in personas) {
      return personas[personaId];
    }
    const personaAliases: Record<string, string> = {
      documentation: 'docs_compliance',
      linear_sync: 'finops',
      ux_product: 'red_team',
      'sec-lane': 'security',
      'arch-lane': 'architecture',
      'qual-lane': 'quality',
      'correctness-lane': 'quality',
      'contract-lane': 'api_contract',
      'policy-lane': 'reliability',
      'perf-lane': 'performance',
      'db-lane': 'database',
      'finops-lane': 'finops',
      'docs-lane': 'docs_compliance',
      'devops-lane': 'devops',
      'redteam-lane': 'red_team',
      'flowchart-lane': 'review_flowchart',
    };
    const targetId = personaAliases[personaId];
    if (targetId && personas[targetId]) {
      return { ...personas[targetId], id: personaId, personaId };
    }
    return undefined;
  }

  public updatePersonaSetting(personaId: string, patch: Partial<PersonaSetting>): PersonaSetting {
    const personaAliases: Record<string, string> = {
      documentation: 'docs_compliance',
      linear_sync: 'finops',
      ux_product: 'red_team',
    };
    const targetId = personaAliases[personaId] || personaId;

    const standardIds = [
      'security', 'architecture', 'performance', 'quality', 'database',
      'api_contract', 'docs_compliance', 'reliability', 'devops', 'finops', 'red_team', 'review_flowchart'
    ];
    if (!standardIds.includes(targetId)) {
      throw new Error(`Persona '${personaId}' not found`);
    }

    // Validate patch fields BEFORE merging defaults so invalid patch requests return HTTP 400
    if ('model' in patch || 'modelId' in patch) {
      const rawModel = patch.modelId !== undefined ? patch.modelId : patch.model;
      if (typeof rawModel !== 'string' || rawModel.trim() === '') {
        throw new Error(`model for '${personaId}' must be a non-empty string`);
      }
      if (rawModel.includes('gemini-2.0-flash') && !rawModel.includes('gemini-2.0-flash-lite')) {
        throw new Error(`model '${rawModel}' for '${personaId}' is a banned model`);
      }

      const allowedModels = this.getDynamicActiveModels();
      const provId = rawModel.startsWith('openrouter/') ? 'openrouter' :
                     rawModel.startsWith('claude') ? 'anthropic' :
                     rawModel.startsWith('gpt-') || rawModel.startsWith('o1-') || rawModel.startsWith('o3-') || rawModel.startsWith('openai/') ? 'openai' :
                     rawModel.startsWith('grok') ? 'grok' :
                     rawModel.startsWith('gemini') || rawModel.startsWith('google/') ? 'gemini' :
                     rawModel.startsWith('deepseek') ? 'deepseek' :
                     rawModel.startsWith('qwen') ? 'qwen' :
                     rawModel.startsWith('codex') ? 'codex' :
                     rawModel.startsWith('glm') || rawModel.startsWith('synthetic') ? 'synthetic' : undefined;

      const provConfigs = this.getProviderConfigs();
      if (provId && provConfigs[provId]) {
        const pCfg = provConfigs[provId];
        if (pCfg.enabled === false || pCfg.active === false) {
          throw new Error(`model '${rawModel}' for '${personaId}' is not an allowed model override`);
        }
      }

      const isAllowed = allowedModels.includes(rawModel) || R4_ALLOWED_MODELS.includes(rawModel as any);
      if (!isAllowed) {
        throw new Error(`model '${rawModel}' for '${personaId}' is not an allowed model override`);
      }
    }

    if ('effort' in patch || 'effortLevel' in patch) {
      const rawEffort = patch.effortLevel !== undefined ? patch.effortLevel : patch.effort;
      const allowedEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
      if (typeof rawEffort !== 'string' || !allowedEfforts.includes(rawEffort)) {
        throw new Error(`effort for '${personaId}' must be one of low, medium, high, xhigh, max`);
      }
    }

    if ('customPrompt' in patch) {
      if (typeof patch.customPrompt !== 'string') {
        throw new Error(`customPrompt for '${personaId}' must be a string`);
      }
    }

    if ('enabled' in patch) {
      if (typeof patch.enabled !== 'boolean') {
        throw new Error(`enabled for '${personaId}' must be a boolean`);
      }
    }

    if ('confidenceThreshold' in patch) {
      if (
        typeof patch.confidenceThreshold !== 'number' ||
        isNaN(patch.confidenceThreshold) ||
        patch.confidenceThreshold < 0 ||
        patch.confidenceThreshold > 100 ||
        !Number.isFinite(patch.confidenceThreshold)
      ) {
        throw new Error(`confidenceThreshold for '${personaId}' must be between 0 and 100`);
      }
    }

    if (!this.data.settings.personaSettings) {
      this.data.settings.personaSettings = this.defaultData().settings.personaSettings!;
    }
    let current = this.data.settings.personaSettings[targetId];
    if (!current && this.data.settings.personaSettings['documentation']) {
      current = this.data.settings.personaSettings['documentation'];
    }
    if (!current) {
      const defaults = this.defaultData().settings.personaSettings;
      if (defaults && defaults[targetId]) {
        this.data.settings.personaSettings[targetId] = { ...defaults[targetId] };
        current = this.data.settings.personaSettings[targetId];
      }
    }
    if (!current) {
      const defaults = this.defaultData().settings.personaSettings;
      current = defaults?.[targetId] || {
        id: targetId,
        displayName: targetId,
        description: targetId,
        enabled: true,
        model: 'openrouter/auto',
        modelId: 'openrouter/auto',
        providerId: 'openrouter',
        effort: 'low',
        confidenceThreshold: 75,
      };
      this.data.settings.personaSettings[targetId] = current;
    }

    const modelId = patch.modelId !== undefined ? patch.modelId : (patch.model !== undefined ? patch.model : (current.modelId || current.model));
    const effortLevel = patch.effortLevel !== undefined ? patch.effortLevel : (patch.effort !== undefined ? patch.effort : (current.effortLevel || current.effort));
    const name = patch.name || patch.displayName || current.name || current.displayName;

    const merged: PersonaSetting = {
      ...current,
      ...patch,
      id: targetId,
      personaId: targetId,
      name,
      displayName: patch.displayName || name || targetId,
      model: modelId,
      modelId,
      providerId: patch.providerId || current.providerId || 'openrouter',
      effort: effortLevel as any,
      effortLevel: effortLevel as any,
    };

    this.validatePersonaSetting(merged, personaId);
    this.data.settings.personaSettings[targetId] = merged;
    if (this.data.settings.personaSettings['documentation']) {
      delete this.data.settings.personaSettings['documentation'];
    }
    this.saveData(this.data);

    if (personaId !== targetId) {
      return { ...merged, id: personaId, personaId };
    }
    return merged;
  }

  public updateSettings(newSettings: Partial<PlatformSettings>): PlatformSettings {
    if (newSettings.defaultMaxTurns !== undefined) {
      if (typeof newSettings.defaultMaxTurns !== 'number' || !Number.isInteger(newSettings.defaultMaxTurns) || newSettings.defaultMaxTurns < 1 || newSettings.defaultMaxTurns > 20) {
        throw new Error('defaultMaxTurns must be an integer between 1 and 20');
      }
    }
    if (newSettings.defaultEffort !== undefined) {
      const allowedEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
      if (typeof newSettings.defaultEffort !== 'string' || !allowedEfforts.includes(newSettings.defaultEffort)) {
        throw new Error('defaultEffort must be one of low, medium, high, xhigh, max');
      }
    }
    if (newSettings.defaultModelOverrides) {
      for (const [provider, model] of Object.entries(newSettings.defaultModelOverrides)) {
        if (typeof model !== 'string' || !model.trim()) {
          throw new Error(`model for '${provider}' must be a non-empty string`);
        }
      }
    }
    if (newSettings.providerConfigs) {
      for (const [providerId, pConfig] of Object.entries(newSettings.providerConfigs)) {
        if (pConfig) {
          const rawKey = pConfig.apiKeyRaw !== undefined ? pConfig.apiKeyRaw : pConfig.apiKey;
          if (rawKey !== undefined && rawKey !== '') {
            const check = validateApiKeyFormat(rawKey, providerId);
            if (!check.valid) {
              throw new Error(`Invalid API key format for provider '${providerId}': ${check.reason}`);
            }
          }
        }
      }
      const existing = this.data.settings.providerConfigs || {};
      const merged: Record<string, any> = { ...existing };
      for (const [pid, pCfg] of Object.entries(newSettings.providerConfigs)) {
        const item = { ...(existing[pid] || {}), ...pCfg };
        if (pCfg.apiKeyRaw || pCfg.apiKey) {
          const raw = pCfg.apiKeyRaw || pCfg.apiKey;
          if (raw && !raw.includes('*')) {
            item.apiKeyRaw = raw;
            item.apiKeyMasked = maskSecretKey(raw);
            item.apiKey = item.apiKeyMasked;
          }
        }
        merged[pid] = item;
      }
      this.data.settings.providerConfigs = merged;
    }

    const currentPersonas = this.data.settings.personaSettings || {};
    const updatedPersonas: Record<string, PersonaSetting> = { ...currentPersonas };
    if (newSettings.personaSettings) {
      const defaults = this.defaultData().settings.personaSettings || {};
      for (const [key, val] of Object.entries(newSettings.personaSettings)) {
        const current = currentPersonas[key] || defaults[key] || {};
        const merged = { ...current, ...val, id: key } as PersonaSetting;
        this.validatePersonaSetting(merged, key);
        updatedPersonas[key] = merged;
      }
    }
    this.data.settings = {
      ...this.data.settings,
      ...newSettings,
      // providerConfigs was already deep-merged above (line 2270); use the merged result
      providerConfigs: this.data.settings.providerConfigs,
      defaultModelOverrides: {
        ...this.data.settings.defaultModelOverrides,
        ...(newSettings.defaultModelOverrides || {}),
      },
      personaSettings: updatedPersonas,
      memoryEngineSettings: {
        ...this.data.settings.memoryEngineSettings,
        ...(newSettings.memoryEngineSettings || {}),
      },
      providerCostCaps: {
        ...this.data.settings.providerCostCaps,
        ...(newSettings.providerCostCaps || {}),
      },
      githubAppConfig: {
        ...(this.data.settings.githubAppConfig || {} as any),
        ...(newSettings.githubAppConfig || {}),
      },
      autoReviewSettings: {
        ...(this.data.settings.autoReviewSettings || {} as any),
        ...(newSettings.autoReviewSettings || {}),
      },
      enforcementPolicy: {
        ...(this.data.settings.enforcementPolicy || {} as any),
        ...(newSettings.enforcementPolicy || {}),
      },
      customApiBases: {
        ...(this.data.settings.customApiBases || {} as any),
        ...(newSettings.customApiBases || {}),
      },
    };
    this.saveData(this.data);
    return this.getSettings();
  }

  public getGitHubAppConfig(): GitHubAppConfigRecord {
    if (!this.data.settings.githubAppConfig) {
      const defaults = this.defaultData().settings.githubAppConfig!;
      this.data.settings.githubAppConfig = { ...defaults };
    }
    const cfg = this.data.settings.githubAppConfig;
    const rawWebhook = cfg.webhookSecretRaw || cfg.webhookSecret || process.env.WEBHOOK_SECRET || '';
    const rawPem = cfg.privateKeyPemRaw || cfg.privateKeyPem || process.env.GITHUB_APP_PRIVATE_KEY || '';
    const appId = cfg.appId || process.env.GITHUB_APP_ID || '';
    const installationId = cfg.installationId || process.env.GITHUB_INSTALLATION_ID || '';
    const webhookUrl = cfg.webhookUrl || process.env.WEBHOOK_URL || '/api/webhooks/github';

    return {
      appId,
      installationId,
      webhookUrl,
      webhookSecret: rawWebhook,
      webhookSecretConfigured: cfg.webhookSecretConfigured || Boolean(rawWebhook),
      webhookSecretRaw: rawWebhook,
      privateKeyPem: rawPem,
      privateKeyConfigured: cfg.privateKeyConfigured || Boolean(rawPem),
      privateKeyPemRaw: rawPem,
      isVerified: cfg.isVerified !== undefined ? cfg.isVerified : Boolean(appId && (rawPem || cfg.privateKeyConfigured)),
      oauthClientId: cfg.oauthClientId || process.env.GITHUB_OAUTH_CLIENT_ID || '',
      oauthClientSecretMasked: cfg.oauthClientSecretMasked || maskSecretKey(cfg.oauthClientSecretRaw),
      oauthClientSecretRaw: cfg.oauthClientSecretRaw,
      status: cfg.status || (appId ? 'configured' : 'unconfigured'),
      updatedAt: cfg.updatedAt || new Date().toISOString(),
    };
  }

  public updateGitHubAppConfig(patch: Partial<GitHubAppConfigRecord> & { webhookSecret?: string; privateKeyPem?: string; oauthClientSecret?: string }): GitHubAppConfigRecord {
    const current = this.getGitHubAppConfig();
    const now = new Date().toISOString();

    let rawPem = patch.privateKeyPem !== undefined ? patch.privateKeyPem : (patch.privateKeyPemRaw !== undefined ? patch.privateKeyPemRaw : current.privateKeyPemRaw);
    if (rawPem && typeof rawPem === 'string') {
      rawPem = rawPem.replace(/\\n/g, '\n').trim();
    }

    const rawWebhook = patch.webhookSecret !== undefined ? patch.webhookSecret : (patch.webhookSecretRaw !== undefined ? patch.webhookSecretRaw : current.webhookSecretRaw);
    const rawClientSecret = patch.oauthClientSecret !== undefined ? patch.oauthClientSecret : (patch.oauthClientSecretRaw !== undefined ? patch.oauthClientSecretRaw : current.oauthClientSecretRaw);

    const appId = patch.appId !== undefined ? patch.appId : current.appId;
    const installationId = patch.installationId !== undefined ? patch.installationId : current.installationId;
    const webhookUrl = patch.webhookUrl !== undefined ? patch.webhookUrl : current.webhookUrl;
    const isVerified = patch.isVerified !== undefined ? patch.isVerified : current.isVerified;

    const updated: GitHubAppConfigRecord = {
      appId,
      installationId,
      webhookUrl,
      webhookSecret: rawWebhook,
      webhookSecretConfigured: Boolean(rawWebhook),
      webhookSecretRaw: rawWebhook,
      privateKeyPem: rawPem,
      privateKeyConfigured: Boolean(rawPem),
      privateKeyPemRaw: rawPem,
      isVerified: isVerified !== undefined ? isVerified : Boolean(appId && rawPem),
      oauthClientId: patch.oauthClientId !== undefined ? patch.oauthClientId : current.oauthClientId,
      oauthClientSecretMasked: maskSecretKey(rawClientSecret),
      oauthClientSecretRaw: rawClientSecret,
      status: (appId ? 'configured' : 'unconfigured'),
      updatedAt: now,
    };

    this.data.settings.githubAppConfig = updated;
    this.saveData(this.data);
    return updated;
  }

  public resetGitHubAppConfig(): GitHubAppConfigRecord {
    const now = new Date().toISOString();
    const resetConfig: GitHubAppConfigRecord = {
      appId: '',
      installationId: '',
      webhookUrl: process.env.WEBHOOK_URL || '/api/webhooks/github',
      webhookSecret: '',
      webhookSecretConfigured: false,
      webhookSecretRaw: '',
      privateKeyPem: '',
      privateKeyConfigured: false,
      privateKeyPemRaw: '',
      isVerified: false,
      oauthClientId: '',
      oauthClientSecretMasked: '',
      oauthClientSecretRaw: '',
      status: 'unconfigured',
      updatedAt: now,
    };
    this.data.settings.githubAppConfig = resetConfig;
    this.saveData(this.data);
    return resetConfig;
  }



  public getApiKeys(): ApiKeyRecord[] {
    if (!this.data.apiKeys) this.data.apiKeys = [];
    return [...this.data.apiKeys];
  }

  public createApiKey(name: string): { id: string; name: string; rawKey: string; maskedKey: string; createdAt: string } {
    if (!this.data.apiKeys) this.data.apiKeys = [];
    const id = `key_${crypto.randomBytes(4).toString('hex')}`;
    const rawSecret = crypto.randomBytes(16).toString('hex');
    const rawKey = `ct_live_${rawSecret}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const maskedKey = `ct_live_...${rawSecret.slice(-4)}`;
    const createdAt = new Date().toISOString();

    const record: ApiKeyRecord = {
      id,
      name,
      keyHash,
      maskedKey,
      createdAt,
    };
    this.data.apiKeys.push(record);
    this.saveData(this.data);

    return {
      id,
      name,
      rawKey,
      maskedKey,
      createdAt,
    };
  }

  public validateApiKey(rawKey: string): boolean {
    if (!this.data.apiKeys) this.data.apiKeys = [];
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const match = this.data.apiKeys.find((k) => k.keyHash === hash);
    if (match) {
      match.lastUsedAt = new Date().toISOString();
      this.saveData(this.data);
      return true;
    }
    return false;
  }

  public deleteApiKey(id: string): boolean {
    if (!this.data.apiKeys) this.data.apiKeys = [];
    const prevLen = this.data.apiKeys.length;
    this.data.apiKeys = this.data.apiKeys.filter((k) => k.id !== id);
    if (this.data.apiKeys.length !== prevLen) {
      this.saveData(this.data);
      return true;
    }
    return false;
  }

  public recordReviewRun(run: any): void {
    this.data.reviewCounter = (this.data.reviewCounter || 0) + 1;
    const cost = run.costUSD ?? run.costUsd ?? 0;
    if (cost) {
      this.data.totalCostUSD = (this.data.totalCostUSD || 0) + cost;
    }
    const promptTokens = run.promptTokens ?? (run.tokens && run.tokens.prompt) ?? 0;
    if (promptTokens) {
      this.data.totalPromptTokens = (this.data.totalPromptTokens || 0) + promptTokens;
    }
    const completionTokens = run.completionTokens ?? (run.tokens && run.tokens.completion) ?? 0;
    if (completionTokens) {
      this.data.totalCompletionTokens = (this.data.totalCompletionTokens || 0) + completionTokens;
    }

    if (!this.data.reviewLogs) this.data.reviewLogs = [];
    const prRunName = run.prRun || (run.repository ? `${run.repository} #${run.prNumber || 1}` : (run.repo ? `${run.repo} #${run.prNumber || 1}` : `Run-${Date.now()}`));
    const verdict = run.arbiterVerdict || run.verdict || 'SHIP';
    const latencyMs = run.latencyMs ?? run.durationMs ?? 0;

    const logEntry: ReviewLogEntry = {
      id: run.id || `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      prRun: prRunName,
      repo: run.repo || run.repository || prRunName.split(' #')[0].split('#')[0],
      prNumber: run.prNumber || parseInt(prRunName.split('#')[1] || '1', 10),
      title: run.title || `PR #${run.prNumber || 1} Code Review`,
      headSha: run.headSha || '',
      personas: typeof run.personas === 'string' ? run.personas : Array.isArray(run.personas) ? run.personas.map((p: any) => typeof p === 'string' ? p : p.id || p.persona).join(', ') : '',
      quorum: run.quorum ? (typeof run.quorum === 'string' ? run.quorum : `${run.quorum.distinctProviders?.length || 0}/${run.quorum.required || 0}`) : '—',
      arbiterVerdict: verdict,
      verdict: verdict as any,
      timestamp: run.timestamp || new Date().toISOString(),
      latencyMs,
      costUSD: cost,
      cost: cost,
      tokens: run.tokens || (promptTokens || completionTokens ? { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens } : undefined),
      tokenDetails: run.tokenDetails || run.tokens || (promptTokens || completionTokens ? { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens } : undefined),
      status: run.status || 'completed',
      modelCosts: run.modelCosts,
      personaLogs: run.personaLogs || (Array.isArray(run.personas) && typeof run.personas[0] === 'object' ? run.personas : undefined),
      mermaidDiagram: run.mermaidDiagram,
    };

    if (!this.data.dailyReviewCounts) {
      this.data.dailyReviewCounts = {};
    }
    if (logEntry.timestamp) {
      try {
        const d = new Date(logEntry.timestamp);
        if (!isNaN(d.getTime())) {
          const dateStr = d.toISOString().slice(0, 10);
          this.data.dailyReviewCounts[dateStr] = (this.data.dailyReviewCounts[dateStr] || 0) + 1;
        }
      } catch {}
    }

    this.data.reviewLogs.unshift(logEntry);
    if (this.data.reviewLogs.length > 100) this.data.reviewLogs.pop();

    this.invalidateCache();
    this.saveData(this.data);
    if (postgresStore.isConfigured()) {
      postgresStore.saveReviewLog(logEntry).catch(() => {});
    }
  }

  public recordIndexerRun(astParseDurationMs: number, vectorEmbedDurationMs?: number): void {
    if (!this.data.indexerMetrics) {
      this.data.indexerMetrics = {
        astParseLatencyMsSum: 0,
        astParseCount: 0,
        vectorEmbedLatencyMsSum: 0,
        vectorEmbedCount: 0,
      };
    }
    if (astParseDurationMs > 0) {
      this.data.indexerMetrics.astParseLatencyMsSum += astParseDurationMs;
      this.data.indexerMetrics.astParseCount += 1;
    }
    if (vectorEmbedDurationMs && vectorEmbedDurationMs > 0) {
      this.data.indexerMetrics.vectorEmbedLatencyMsSum += vectorEmbedDurationMs;
      this.data.indexerMetrics.vectorEmbedCount += 1;
    }
    this.saveData(this.data);
  }

  public getAnalyticsSummary() {
    if (this.cache.analyticsSummary) return this.cache.analyticsSummary;

    const overview = this.getOverviewStats();
    const totalReviews = overview.totalReviewsExecuted;

    const logs = this.data.reviewLogs || [];
    const logsWithLatency = logs.filter((l) => typeof l.latencyMs === 'number' && l.latencyMs > 0);
    const avgLatencyMs = logsWithLatency.length > 0
      ? Math.round(logsWithLatency.reduce((acc, l) => acc + (l.latencyMs || 0), 0) / logsWithLatency.length)
      : 0;

    const successfulLogs = logs.filter((l) => l.arbiterVerdict === 'SHIP' || l.status === 'success' || l.status === 'processed');
    const successRate = logs.length > 0
      ? parseFloat(((successfulLogs.length / logs.length) * 100).toFixed(1))
      : 100;

    const summary = {
      totalReviews,
      totalSpendUsd: overview.totalCostUSD,
      totalTokens: overview.totalTokens.total,
      avgLatencyMs,
      successRate,
      activeRepositories: overview.activeAutomations,
      memoryRulesCount: overview.memoryGraph.learningsCount,
      timestamp: new Date().toISOString(),
    };

    this.cache.analyticsSummary = summary;
    return summary;
  }

  public getTokenTimeSeries(range = '7d', _interval = 'day') {
    const cacheKey = `${range}_${_interval}`;
    if (this.cache.tokenTimeSeries[cacheKey]) return this.cache.tokenTimeSeries[cacheKey];

    const days = range === '24h' ? 1 : range === '30d' ? 30 : 7;
    const now = new Date();
    const logs = this.data.reviewLogs || [];

    const tokensByDate: Record<string, { prompt: number; completion: number }> = {};
    for (const log of logs) {
      if (!log.timestamp) continue;
      const dateStr = log.timestamp.split('T')[0];
      if (!tokensByDate[dateStr]) {
        tokensByDate[dateStr] = { prompt: 0, completion: 0 };
      }
      const prompt = log.tokens?.prompt || 0;
      const completion = log.tokens?.completion || 0;
      tokensByDate[dateStr].prompt += prompt;
      tokensByDate[dateStr].completion += completion;
    }

    const points: Array<{ timestamp: string; promptTokens: number; completionTokens: number; totalTokens: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];

      const dayData = tokensByDate[dateStr];
      const promptTokens = dayData ? dayData.prompt : 0;
      const completionTokens = dayData ? dayData.completion : 0;

      points.push({
        timestamp: dateStr,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      });
    }

    this.cache.tokenTimeSeries[cacheKey] = points;
    return points;
  }

  public getCostBreakdown() {
    if (this.cache.costBreakdown) return this.cache.costBreakdown;

    const totalSpendUsd = this.data.totalCostUSD || 0;
    const monthlyBudgetUsd = this.data.settings.providerCostCaps.monthlyBudgetUSD;
    const budgetPercentUsed = monthlyBudgetUsd > 0 ? Math.min(100, (totalSpendUsd / monthlyBudgetUsd) * 100) : 0;

    const knownModels = [
      { model: 'claude-5-sonnet', displayName: 'Claude 5 Sonnet', providerId: 'claude' },
      { model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', providerId: 'codex' },
      { model: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', providerId: 'deepseek' },
      { model: 'glm-5.2', displayName: 'GLM 5.2 Arbiter', providerId: 'glm' },
    ];

    const logs = this.data.reviewLogs || [];
    const modelStats: Record<string, { spendUsd: number; promptTokens: number; completionTokens: number; callCount: number }> = {};

    for (const m of knownModels) {
      modelStats[m.model] = { spendUsd: 0, promptTokens: 0, completionTokens: 0, callCount: 0 };
    }

    let loggedSpendSum = 0;
    for (const log of logs) {
      if (log.modelCosts) {
        for (const [mod, cst] of Object.entries(log.modelCosts)) {
          if (!modelStats[mod]) {
            modelStats[mod] = { spendUsd: 0, promptTokens: 0, completionTokens: 0, callCount: 0 };
          }
          modelStats[mod].spendUsd += cst;
          modelStats[mod].callCount += 1;
          loggedSpendSum += cst;
        }
      }
    }

    const totalPrompt = this.data.totalPromptTokens || 0;
    const totalCompletion = this.data.totalCompletionTokens || 0;
    const totalCalls = this.data.reviewCounter || 0;

    const modelKeys = Object.keys(modelStats);
    const breakdown = modelKeys.map((key) => {
      const known = knownModels.find((km) => km.model === key);
      const displayName = known ? known.displayName : key;
      const providerId = known ? known.providerId : key.split('-')[0];

      const stats = modelStats[key];
      let spendUsd = parseFloat(stats.spendUsd.toFixed(4));
      if (loggedSpendSum === 0 && totalSpendUsd > 0) {
        spendUsd = parseFloat((totalSpendUsd / modelKeys.length).toFixed(4));
      }

      const percentage = totalSpendUsd > 0 ? Math.round((spendUsd / totalSpendUsd) * 100) : 0;
      const modelRatio = totalSpendUsd > 0 ? spendUsd / totalSpendUsd : (1 / modelKeys.length);
      const prompt = stats.promptTokens || Math.round(totalPrompt * modelRatio);
      const completion = stats.completionTokens || Math.round(totalCompletion * modelRatio);
      const callCount = stats.callCount || Math.round(totalCalls * modelRatio);

      return {
        model: key,
        displayName,
        providerId,
        spendUsd,
        percentage,
        tokens: {
          prompt,
          completion,
        },
        callCount,
      };
    });

    const result = {
      totalSpendUsd,
      monthlyBudgetUsd,
      budgetPercentUsed: parseFloat(budgetPercentUsed.toFixed(1)),
      breakdown,
    };

    this.cache.costBreakdown = result;
    return result;
  }

  public getPersonaAnalytics() {
    if (this.cache.personaAnalytics) return this.cache.personaAnalytics;

    const standardPersonas = [
      { persona: 'securityArbiter', displayName: 'Security & Auth Arbiter' },
      { persona: 'docsPersona', displayName: 'Documentation & API Spec' },
      { persona: 'linearSyncPersona', displayName: 'Linear Issue & Traceability' },
      { persona: 'marketingPersona', displayName: 'UX & Feature Release' },
    ];

    const logs = this.data.reviewLogs || [];

    const personaStats: Record<string, {
      totalReviews: number;
      verdicts: { SHIP: number; NACK: number; COMMENT: number };
      latencySum: number;
      latencyCount: number;
      confidenceSum: number;
      confidenceCount: number;
    }> = {};

    for (const sp of standardPersonas) {
      personaStats[sp.persona] = {
        totalReviews: 0,
        verdicts: { SHIP: 0, NACK: 0, COMMENT: 0 },
        latencySum: 0,
        latencyCount: 0,
        confidenceSum: 0,
        confidenceCount: 0,
      };
    }

    for (const log of logs) {
      const rawPersonas = log.personas as any;
      const personasInLog = (Array.isArray(rawPersonas) ? rawPersonas.join(', ') : String(rawPersonas || '')).toLowerCase();
      const arbiterVerdict = log.arbiterVerdict || 'SHIP';

      for (const sp of standardPersonas) {
        const pKey = sp.persona;
        const stats = personaStats[pKey];

        const isIncluded = personasInLog.includes(pKey.toLowerCase()) ||
          personasInLog.includes(sp.displayName.toLowerCase()) ||
          personasInLog.includes('persona') ||
          log.personaLogs?.some((pl) => pl.persona === pKey);

        if (isIncluded) {
          stats.totalReviews += 1;
          if (arbiterVerdict === 'SHIP') stats.verdicts.SHIP += 1;
          else if (arbiterVerdict === 'NACK') stats.verdicts.NACK += 1;
          else stats.verdicts.COMMENT += 1;

          if (log.latencyMs) {
            stats.latencySum += log.latencyMs;
            stats.latencyCount += 1;
          }
        }
      }

      if (log.personaLogs) {
        for (const pl of log.personaLogs) {
          if (personaStats[pl.persona]) {
            const stats = personaStats[pl.persona];
            if (pl.decision === 'SHIP') stats.verdicts.SHIP += 1;
            else if (pl.decision === 'NACK') stats.verdicts.NACK += 1;
            else if (pl.decision === 'COMMENT') stats.verdicts.COMMENT += 1;

            if (pl.latencyMs) {
              stats.latencySum += pl.latencyMs;
              stats.latencyCount += 1;
            }
            if (pl.confidence) {
              stats.confidenceSum += pl.confidence;
              stats.confidenceCount += 1;
            }
          }
        }
      }
    }

    const result = standardPersonas.map((sp) => {
      const stats = personaStats[sp.persona];
      const totalReviews = stats.totalReviews > 0 ? stats.totalReviews : logs.length;
      const shipCount = stats.verdicts.SHIP;
      const approvalRate = totalReviews > 0 ? parseFloat((shipCount / totalReviews).toFixed(2)) : 0;

      const avgConfidence = stats.confidenceCount > 0
        ? Math.round(stats.confidenceSum / stats.confidenceCount)
        : 0;

      const avgLatencyMs = stats.latencyCount > 0
        ? Math.round(stats.latencySum / stats.latencyCount)
        : 0;

      return {
        persona: sp.persona,
        displayName: sp.displayName,
        totalReviews,
        approvalRate,
        avgConfidence,
        verdicts: stats.verdicts,
        avgLatencyMs,
      };
    });

    this.cache.personaAnalytics = result;
    return result;
  }

  public getIndexerAnalytics() {
    if (this.cache.indexerAnalytics) return this.cache.indexerAnalytics;

    const overview = this.getOverviewStats();
    const metrics = this.data.indexerMetrics;

    const astParseLatencyMs = metrics && metrics.astParseCount > 0
      ? Math.round(metrics.astParseLatencyMsSum / metrics.astParseCount)
      : 0;

    const vectorEmbedLatencyMs = metrics && metrics.vectorEmbedCount > 0
      ? Math.round(metrics.vectorEmbedLatencyMsSum / metrics.vectorEmbedCount)
      : 0;

    const result = {
      symbolNodesCount: overview.memoryGraph.symbolNodesCount,
      symbolEdgesCount: overview.memoryGraph.symbolEdgesCount,
      astParseLatencyMs,
      vectorEmbedLatencyMs,
      memoryLearningsCount: overview.memoryGraph.learningsCount,
      suppressedNitsCount: overview.memoryGraph.suppressedNitsCount,
    };

    this.cache.indexerAnalytics = result;
    return result;
  }

  public getReviewLogs(): ReviewLogEntry[] {
    const rawLogs = [...(this.data.reviewLogs || [])];
    return rawLogs.map((log: any) => {
      const repo = log.repo || (log.prRun ? log.prRun.split(' #')[0].split('#')[0] : 'unknown/repo');
      const prNumber = log.prNumber || (log.prRun && log.prRun.includes('#') ? parseInt(log.prRun.split('#')[1], 10) : 0);
      const personasList = Array.isArray(log.personas)
        ? log.personas
        : typeof log.personas === 'string'
        ? log.personas.split(', ').map((s: string) => s.trim()).filter(Boolean)
        : [];
      return {
        id: log.id,
        prRun: log.prRun || `${repo} #${prNumber}`,
        repo,
        prNumber: isNaN(prNumber) ? 0 : prNumber,
        title: log.title || `PR Review for ${repo} #${prNumber || 0}`,
        status: log.status || 'completed',
        personas: personasList as any,
        verdict: log.verdict || log.arbiterVerdict || 'SHIP',
        arbiterVerdict: log.arbiterVerdict || log.verdict || 'SHIP',
        tokens: (log.tokens?.total != null ? log.tokens.total : (log.tokens?.prompt != null ? (log.tokens.prompt + (log.tokens.completion ?? 0)) : 0)) as any,
        tokenDetails: log.tokenDetails ?? log.tokens ?? undefined,
        cost: log.costUSD ?? log.cost ?? 0,
        costUSD: log.costUSD ?? log.cost ?? 0,
        latencyMs: log.latencyMs ?? 0,
        timestamp: log.timestamp || new Date().toISOString(),
        headSha: log.headSha || '',
        quorum: log.quorum || '—',
        personaLogs: log.personaLogs,
        mermaidDiagram: log.mermaidDiagram,
        optionalFailures: log.optionalFailures,
      };
    });
  }

  public getOverviewStats(timezone?: string) {
    if (!timezone && this.cache.overviewStats) return this.cache.overviewStats;

    const repos = this.getRepositories();
    const activeAutomations = repos.filter((r) => r.automationEnabled).length;

    let memoryCounts = { learningsCount: 0, suppressedNitsCount: 0, adrConstraintsCount: 0 };
    try {
      const prStorePath = process.env.CT_PR_MEMORY_STORE || process.env.CT_REVIEW_MEMORY_DB || path.join(process.env.CT_REVIEW_DATA_DIR || '/tmp/ct-review-bot', 'pr_memory.db');
      if (fs.existsSync(prStorePath)) {
        const prStore = new PRMemoryStore(prStorePath);
        const fetched = prStore.getCounts();
        if (fetched) memoryCounts = fetched;
        prStore.close();
      }
    } catch {
      // Uninitialized live store returns zero counts
    }

    let symbolCounts = { nodes: 0, edges: 0 };
    try {
      const symStorePath = process.env.CT_SYMBOL_GRAPH_STORE || process.env.CT_REVIEW_SYMBOL_DB || path.join(process.env.CT_REVIEW_DATA_DIR || '/tmp/ct-review-bot', 'symbol_graph.db');
      if (fs.existsSync(symStorePath)) {
        const symStore = new SymbolGraphStore(symStorePath);
        const fetched = symStore.getCounts();
        if (fetched) symbolCounts = fetched;
        symStore.close();
      }
    } catch {
      // Uninitialized live store returns zero counts
    }

    const registeredProviders = providerPool.listProviders();
    const providerHealth = registeredProviders.length > 0
      ? registeredProviders.map((p) => ({
          id: p.id,
          status: 'healthy',
          model: p.models[0] || p.type,
        }))
      : Object.entries(this.data.settings.defaultModelOverrides).map(([id, model]) => ({
          id,
          status: 'healthy',
          model,
        }));

    const logs = this.data.reviewLogs || [];

    const promptTokens = (this.data.totalPromptTokens && this.data.totalPromptTokens > 0)
      ? this.data.totalPromptTokens
      : logs.reduce((sum, log) => sum + (log.tokens?.prompt || log.tokenDetails?.prompt || 0), 0);

    const completionTokens = (this.data.totalCompletionTokens && this.data.totalCompletionTokens > 0)
      ? this.data.totalCompletionTokens
      : logs.reduce((sum, log) => sum + (log.tokens?.completion || log.tokenDetails?.completion || 0), 0);

    const totalCostUSD = logs.reduce((sum, log) => sum + (log.costUSD ?? log.cost ?? 0), 0) || (this.data.totalCostUSD || 0);

    const now = new Date();
    const todayUtcStr = now.toISOString().slice(0, 10);

    const todaysLogsCount = logs.filter((log) => {
      if (!log.timestamp) return false;
      try {
        const logDate = new Date(log.timestamp);
        if (isNaN(logDate.getTime())) return false;
        if (timezone) {
          try {
            const logZoned = logDate.toLocaleDateString('en-CA', { timeZone: timezone });
            const nowZoned = now.toLocaleDateString('en-CA', { timeZone: timezone });
            return logZoned === nowZoned;
          } catch {
            // fallback to UTC if invalid timezone
          }
        }
        return logDate.toISOString().slice(0, 10) === todayUtcStr;
      } catch {
        return false;
      }
    }).length;

    const targetDateKey = timezone ? (() => {
      try {
        return now.toLocaleDateString('en-CA', { timeZone: timezone });
      } catch {
        return todayUtcStr;
      }
    })() : todayUtcStr;

    const dailyRecorded = (this.data.reviewCounter === 0 && (!this.data.reviewLogs || this.data.reviewLogs.length === 0))
      ? 0
      : ((this.data.dailyReviewCounts && this.data.dailyReviewCounts[targetDateKey]) || 0);

    const todaysReviewsCount = Math.max(todaysLogsCount, dailyRecorded);

    // Trailing 24-Hour KPI Summary (Requirement R2)
    const cutoff24h = Date.now() - 86400000;
    const trailing24hLogs = logs.filter((log) => {
      if (!log.timestamp) return false;
      const logTime = new Date(log.timestamp).getTime();
      return !isNaN(logTime) && logTime >= cutoff24h;
    });

    const trailing24hReviewsExecuted = trailing24hLogs.length;
    const trailing24hTotalTokens = trailing24hLogs.reduce((sum, log) => {
      const tok = log.tokens?.total || (typeof log.tokens === 'number' ? log.tokens : 0) || log.tokenDetails?.total || ((log.tokens?.prompt || 0) + (log.tokens?.completion || 0)) || 0;
      return sum + tok;
    }, 0);
    const trailing24hTotalCostUSD = trailing24hLogs.reduce((sum, log) => sum + (log.costUSD ?? log.cost ?? 0), 0);

    const trailing24hAvgTokensPerPR = trailing24hReviewsExecuted > 0
      ? Math.round(trailing24hTotalTokens / trailing24hReviewsExecuted)
      : 0;

    const trailing24hAvgCostPerPR = trailing24hReviewsExecuted > 0
      ? parseFloat((trailing24hTotalCostUSD / trailing24hReviewsExecuted).toFixed(4))
      : 0;

    const overview = {
      totalRepositories: repos.length,
      activeAutomations: activeAutomations,
      totalReviewsExecuted: this.data.reviewCounter || (this.data.reviewLogs ? this.data.reviewLogs.length : 0),
      todaysReviewsExecuted: todaysReviewsCount,
      todaysReviewsCount: todaysReviewsCount,
      todayDateBadge: todayUtcStr,
      trailing24hAvgTokensPerPR,
      trailing24hAvgCostPerPR,
      trailing24hReviewsExecuted,
      totalCostUSD,
      totalPromptTokens: promptTokens,
      totalCompletionTokens: completionTokens,
      monthlyCostCapUSD: this.data.settings.providerCostCaps.monthlyBudgetUSD,
      costCapBreached: totalCostUSD >= this.data.settings.providerCostCaps.monthlyBudgetUSD,
      totalTokens: {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens,
      },
      providerHealth,
      memoryGraph: {
        symbolNodesCount: symbolCounts.nodes,
        symbolEdgesCount: symbolCounts.edges,
        learningsCount: memoryCounts.learningsCount,
        suppressedNitsCount: memoryCounts.suppressedNitsCount,
        adrConstraintsCount: memoryCounts.adrConstraintsCount,
      },
    };

    if (!timezone) {
      this.cache.overviewStats = overview;
    }
    return overview;
  }

  public getIntegrations(): IntegrationConfig[] {
    if (!this.data.integrations) {
      this.data.integrations = this.defaultData().integrations;
      this.saveData(this.data);
    } else {
      const defaults = this.defaultData().integrations || {};
      let updated = false;
      for (const [k, v] of Object.entries(defaults)) {
        if (!this.data.integrations[k]) {
          this.data.integrations[k] = v;
          updated = true;
        }
      }
      if (updated) this.saveData(this.data);
    }
    return Object.values(this.data.integrations!).map((integration) => {
      const sanitized = { ...integration };
      delete (sanitized as any).apiKey;
      delete (sanitized as any).oauthClientSecret;
      return sanitized;
    });
  }

  public getIntegration(id: string): IntegrationConfig | undefined {
    const integrations = this.getIntegrations();
    const item = integrations.find((i) => i.id === id);
    if (!item) return undefined;
    const sanitized = { ...item };
    delete (sanitized as any).apiKey;
    delete (sanitized as any).oauthClientSecret;
    return sanitized;
  }

  public updateIntegration(
    id: string,
    patch: Partial<IntegrationConfig> & { apiKey?: string; oauthClientSecret?: string }
  ): IntegrationConfig {
    if (patch.apiKey !== undefined && patch.apiKey !== '') {
      const check = validateApiKeyFormat(patch.apiKey, id);
      if (!check.valid) {
        throw new Error(`Invalid API key format for integration '${id}': ${check.reason}`);
      }
    }

    if (!this.data.integrations) {
      this.data.integrations = this.defaultData().integrations;
    }
    const current = this.data.integrations![id] || {
      id: id as any,
      name: `${id.slice(0, 1).toUpperCase()}${id.slice(1)} Integration`,
      status: 'disconnected',
      updatedAt: new Date().toISOString(),
    };

    let apiKeyMasked: string | undefined;
    if (patch.apiKey !== undefined) {
      apiKeyMasked = patch.apiKey ? maskSecretKey(patch.apiKey) : undefined;
    } else if ('apiKeyMasked' in patch) {
      apiKeyMasked = patch.apiKeyMasked;
    } else {
      apiKeyMasked = current.apiKeyMasked;
    }

    let oauthClientSecretMasked: string | undefined;
    if (patch.oauthClientSecret !== undefined) {
      oauthClientSecretMasked = patch.oauthClientSecret ? maskSecretKey(patch.oauthClientSecret) : undefined;
    } else if ('oauthClientSecretMasked' in patch) {
      oauthClientSecretMasked = patch.oauthClientSecretMasked;
    } else {
      oauthClientSecretMasked = current.oauthClientSecretMasked;
    }

    const oauthClientId = patch.oauthClientId !== undefined ? patch.oauthClientId : current.oauthClientId;
    const hasCreds = Boolean(apiKeyMasked) || Boolean(oauthClientId);

    let status: IntegrationConfig['status'];
    if (patch.status !== undefined) {
      status = patch.status;
    } else if (patch.apiKey !== undefined || patch.oauthClientId !== undefined) {
      status = hasCreds ? 'connected' : 'disconnected';
    } else {
      status = !hasCreds ? 'disconnected' : current.status;
    }

    const { apiKey, oauthClientSecret, ...restPatch } = patch;

    const updated: IntegrationConfig = {
      ...current,
      ...restPatch,
      status,
      apiKeyMasked,
      oauthClientSecretMasked,
      settings: {
        ...(current.settings || {}),
        ...(restPatch.settings || {}),
      },
      updatedAt: new Date().toISOString(),
    };

    delete (updated as any).apiKey;
    delete (updated as any).oauthClientSecret;

    this.data.integrations![id] = updated;
    this.saveData(this.data);

    const sanitizedResult = { ...updated };
    delete (sanitizedResult as any).apiKey;
    delete (sanitizedResult as any).oauthClientSecret;
    return sanitizedResult;
  }

  public getMcpServers(): CustomMcpServerConfig[] {
    if (!this.data.mcpServers) {
      this.data.mcpServers = this.defaultData().mcpServers;
      this.saveData(this.data);
    }
    return [...this.data.mcpServers!];
  }

  public getMcpServer(id: string): CustomMcpServerConfig | undefined {
    return this.getMcpServers().find((s) => s.id === id);
  }

  public addMcpServer(server: Partial<CustomMcpServerConfig>): CustomMcpServerConfig {
    if (!this.data.mcpServers) {
      this.data.mcpServers = this.defaultData().mcpServers;
    }
    const now = new Date().toISOString();
    const id = server.id || `mcp_${server.transport || 'custom'}_${Date.now()}`;
    const newServer: CustomMcpServerConfig = {
      id,
      name: server.name || 'Custom MCP Server',
      transport: server.transport || 'http',
      url: server.url,
      command: server.command,
      args: server.args || [],
      env: server.env || {},
      enabled: server.enabled ?? true,
      status: server.status || 'online',
      toolsCount: server.toolsCount ?? 0,
      lastHealthCheckAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.data.mcpServers!.push(newServer);
    this.saveData(this.data);
    return newServer;
  }

  public updateMcpServer(id: string, patch: Partial<CustomMcpServerConfig>): CustomMcpServerConfig | undefined {
    if (!this.data.mcpServers) {
      this.data.mcpServers = this.defaultData().mcpServers;
    }
    const index = this.data.mcpServers!.findIndex((s) => s.id === id);
    if (index === -1) return undefined;

    const current = this.data.mcpServers![index];
    const updated: CustomMcpServerConfig = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.data.mcpServers![index] = updated;
    this.saveData(this.data);
    return updated;
  }

  public deleteMcpServer(id: string): boolean {
    if (!this.data.mcpServers) return false;
    const initialLen = this.data.mcpServers.length;
    this.data.mcpServers = this.data.mcpServers.filter((s) => s.id !== id);
    if (this.data.mcpServers.length !== initialLen) {
      this.saveData(this.data);
      return true;
    }
    return false;
  }
}

export const dashboardStore = new DashboardStore();
