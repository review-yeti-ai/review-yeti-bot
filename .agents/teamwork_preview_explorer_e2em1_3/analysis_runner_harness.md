# Architectural Analysis & Specification: E2E Test Runner, Fixture Generators & State Harness

**Module**: `ct-review-bot` E2E Test Suite (Milestone E2E-M1)  
**Agent**: `teamwork_preview_explorer_e2em1_3`  
**Target Path**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_e2em1_3/analysis_runner_harness.md`  
**Date**: 2026-07-24  

---

## 1. Executive Summary

This report establishes the architectural specification for the **E2E Test Runner Framework**, **Fixture Generators**, and **Isolated State Harness** for `ct-review-bot`. As defined in `PROJECT.md` and `SCOPE.md`, the E2E test suite operates as a **requirement-driven, opaque-box test runner** that validates the behavior of `ct-review-bot` under Tiers 1-5 test scenarios without depending on internal implementation details.

Key deliverables specified in this document:
1. **Fixture Generators (`fixtureGenerator.ts`)**: Programmatic builders for realistic Git unified diffs (including multi-commit diff deltas), `.ct-review.yaml` / `.coderabbit.yaml` configurations, and `constitution.md` operational guidelines.
2. **Isolated State Management (`stateManager.ts`)**: A robust, zero-side-effect SQLite / JSON DB and filesystem sandbox manager providing complete isolation, dynamic environment variable binding, state inspection, and deterministic teardown across parallel and sequential test runs.
3. **E2E Test Runner & Harness Directory Layout (`tests/e2e/`)**: Comprehensive directory layout and Vitest framework configuration supporting Tiers 1 through 4 test execution, seamless app process bootstrapping (via Express Supertest or spawned subprocess), and custom domain assertion helpers.

---

## 2. Codebase Exploration & Target Component Analysis

`ct-review-bot` is structured as a Node.js / TypeScript microservice executing on Express.js and backed by SQLite (`better-sqlite3`) / JSON state persistence. The test runner and harness must interface with and validate four core subsystems:

### 2.1 Configuration Engine (`src/config/`)
- **Target Files**: `src/config/configLoader.ts`, `src/config/schema.ts`, `src/config/defaultOrgConfig.ts`
- **Behavior**: Reads `.ct-review.yaml` (or `.coderabbit.yaml`), validates against a Zod schema (`CtReviewConfig`), and deep-merges user-supplied settings with organization defaults (`defaultOrgConfig.ts`).
- **Test Requirements**: Fixture generators must produce valid YAML configurations, invalid YAML configurations (syntax errors), out-of-schema YAML (invalid values/types), and legacy `.coderabbit.yaml` configurations.

### 2.2 Operational Constitution Engine (`src/constitution/`)
- **Target File**: `src/constitution/constitutionEngine.ts`
- **Behavior**: Parses `constitution.md` documents, extracts security/architecture/quality directives, and checks code diffs against defined rules, returning `{ compliant: boolean; violations: string[] }`.
- **Test Requirements**: Fixture generators must construct valid `constitution.md` files with varied rule strictness, as well as malformed or missing constitution files.

### 2.3 Incremental Diff State & Persistence Engine (`src/persistence/`, `src/utils/diffHash.ts`)
- **Target Files**: `src/persistence/diffStateManager.ts`, `src/persistence/db.ts`, `src/utils/diffHash.ts`
- **Behavior**: Calculates SHA-256 fingerprint hashes for diff hunks and review findings (nits & PR findings). Tracks finding statuses (`identified` vs `resolved`) across PR commits, preventing duplicate flag comments on unchanged code. Uses `better-sqlite3` or an atomic JSON storage fallback.
- **Test Requirements**: State management harness must provide isolated DB instances (in-memory SQLite or isolated temporary SQLite file/JSON folder), initialize schema, seed initial state, and allow inspecting stored findings and SHA hashes during test assertions.

### 2.4 Test Suite Scaffolding (`tests/`)
- **Target Framework**: Vitest (TypeScript native, superfast ESM/CJS runner with built-in mocking and snapshot capabilities).
- **Directory Layout**:
  - `tests/unit/`: Unit tests for config, ticket, constitution, persistence, router, quorum.
  - `tests/integration/`: Integration tests for Express routes and LLM adapter fan-out.
  - `tests/e2e/`: Requirement-driven opaque-box E2E test suite (Tiers 1-4).

---

## 3. Fixture Generator Specifications (`fixtureGenerator.ts`)

The `FixtureGenerator` utility provides fluent, programmatic builders for generating inputs required by E2E test cases.

### 3.1 Unified Diff Generator
The diff generator constructs RFC 3629 / Git unified diff strings with exact line header counts (`@@ -L,C +L,C @@`), file path indicators (`--- a/...`, `+++ b/...`), deleted (`-`), added (`+`), and context (` `) lines.

```typescript
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  changes: Array<{ type: 'add' | 'delete' | 'context'; content: string }>;
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  isNew?: boolean;
  isDeleted?: boolean;
  isRenamed?: boolean;
  hunks: DiffHunk[];
}
```

#### Pre-Canned Scenario Diffs:
1. **Security Vulnerability Diff**: Contains hardcoded credentials (`AWS_SECRET_KEY = "AKIA..."`) or SQL injection (`db.query("SELECT * FROM users WHERE id = " + req.query.id)`).
2. **Architecture Violation Diff**: Direct database access from frontend component or bypassing OmniRoute adapter.
3. **Clean Diff**: Standard refactoring or feature implementation with clean code, test coverage, and documentation.
4. **Multi-File Diff**: Diffs touching multiple files (`src/api.ts`, `src/db.ts`, `package.json`).
5. **Incremental Commit Diffs**:
   - `Commit A (Initial PR)`: Contains 2 security findings (lines 15 and 42).
   - `Commit B (PR Update / synchronize)`: Line 15 is fixed (deleted), line 42 remains unchanged, new line 88 added with a minor quality nit.

### 3.2 YAML Config Generator
Generates `.ct-review.yaml` or `.coderabbit.yaml` content.

```typescript
export interface CtReviewConfigFixtureOptions {
  version?: string;
  quorum?: {
    minApprovals?: number;
    personas?: Array<'security' | 'architecture' | 'performance' | 'quality'>;
    effortLevel?: 'low' | 'medium' | 'high' | 'reasoning';
  };
  ticketEnforcement?: {
    required?: boolean;
    providers?: Array<'linear' | 'jira' | 'github'>;
    patterns?: string[];
  };
  constitution?: {
    enabled?: boolean;
    path?: string;
  };
}
```

#### Pre-Canned Config Scenarios:
- **Default Full Config**: All personas enabled, ticket enforcement required for Linear & Jira, constitution enabled.
- **Minimal Config**: Only version and default quorum.
- **Strict Security Config**: `minApprovals: 3`, `effortLevel: "high"`, strict Linear ticket pattern `[PROJ-\\d+]`.
- **Invalid Config (Schema Violation)**: Unknown persona `"magic"`, negative `minApprovals`, invalid effort level.
- **Malformed YAML**: Unclosed strings or invalid indentation.

### 3.3 Constitution Document Builder
Constructs Markdown operational guidelines files (`constitution.md`).

```typescript
export interface ConstitutionRule {
  id: string;
  category: 'security' | 'architecture' | 'quality' | 'compliance';
  title: string;
  directive: string;
  forbiddenPatterns?: string[];
  mandatoryGuidelines?: string[];
}
```

#### Complete `fixtureGenerator.ts` Interface Contract:
```typescript
import * as yaml from 'js-yaml';

export class FixtureGenerator {
  /**
   * Builds a Git unified diff string from structured file diff definitions.
   */
  static buildUnifiedDiff(files: FileDiff[]): string {
    let diff = '';
    for (const file of files) {
      const oldHeader = file.isNew ? '/dev/null' : `a/${file.oldPath}`;
      const newHeader = file.isDeleted ? '/dev/null' : `b/${file.newPath}`;
      
      diff += `diff --git a/${file.oldPath} b/${file.newPath}\n`;
      if (file.isNew) diff += `new file mode 100644\n`;
      if (file.isDeleted) diff += `deleted file mode 100644\n`;
      diff += `--- ${oldHeader}\n`;
      diff += `+++ ${newHeader}\n`;
      
      for (const hunk of file.hunks) {
        diff += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
        for (const change of hunk.changes) {
          const prefix = change.type === 'add' ? '+' : change.type === 'delete' ? '-' : ' ';
          diff += `${prefix}${change.content}\n`;
        }
      }
    }
    return diff;
  }

  /**
   * Pre-canned scenario diffs
   */
  static getScenarioDiff(scenario: 'security_vuln' | 'arch_violation' | 'clean' | 'incremental_a' | 'incremental_b'): string {
    switch (scenario) {
      case 'security_vuln':
        return this.buildUnifiedDiff([{
          oldPath: 'src/auth/login.ts',
          newPath: 'src/auth/login.ts',
          hunks: [{
            oldStart: 10, oldLines: 3, newStart: 10, newLines: 5,
            changes: [
              { type: 'context', content: 'export async function login(req: Request) {' },
              { type: 'delete', content: '  const user = await db.findUser(req.body.id);' },
              { type: 'add', content: '  const apiKey = "AKIAIOSFODNN7EXAMPLE"; // HARDCODED SECRET' },
              { type: 'add', content: '  const user = await db.raw(`SELECT * FROM users WHERE id = ${req.body.id}`);' },
              { type: 'context', content: '  return user;' }
            ]
          }]
        }]);
      case 'clean':
        return this.buildUnifiedDiff([{
          oldPath: 'src/utils/math.ts',
          newPath: 'src/utils/math.ts',
          hunks: [{
            oldStart: 1, oldLines: 2, newStart: 1, newLines: 4,
            changes: [
              { type: 'context', content: 'export function add(a: number, b: number): number {' },
              { type: 'add', content: '  // Helper add method' },
              { type: 'context', content: '  return a + b;' },
              { type: 'add', content: '}' }
            ]
          }]
        }]);
      case 'incremental_a':
        return this.buildUnifiedDiff([{
          oldPath: 'src/service.ts',
          newPath: 'src/service.ts',
          hunks: [{
            oldStart: 12, oldLines: 2, newStart: 12, newLines: 3,
            changes: [
              { type: 'context', content: 'function processData(input: string) {' },
              { type: 'add', content: '  eval(input); // Finding #1: Dangerous eval' },
              { type: 'add', content: '  console.log(input); // Finding #2: Console log nit' },
              { type: 'context', content: '}' }
            ]
          }]
        }]);
      case 'incremental_b':
        return this.buildUnifiedDiff([{
          oldPath: 'src/service.ts',
          newPath: 'src/service.ts',
          hunks: [{
            oldStart: 12, oldLines: 3, newStart: 12, newLines: 3,
            changes: [
              { type: 'context', content: 'function processData(input: string) {' },
              { type: 'add', content: '  JSON.parse(input); // Fixed eval -> JSON.parse' },
              { type: 'context', content: '  console.log(input); // Finding #2: Console log nit remains' },
              { type: 'context', content: '}' }
            ]
          }]
        }]);
      default:
        return '';
    }
  }

  /**
   * Builds YAML config string from structured options.
   */
  static buildConfigYaml(options: CtReviewConfigFixtureOptions = {}): string {
    const config = {
      version: options.version ?? '1.0',
      quorum: {
        minApprovals: options.quorum?.minApprovals ?? 2,
        personas: options.quorum?.personas ?? ['security', 'architecture', 'performance', 'quality'],
        effortLevel: options.quorum?.effortLevel ?? 'medium'
      },
      ticketEnforcement: {
        required: options.ticketEnforcement?.required ?? true,
        providers: options.ticketEnforcement?.providers ?? ['linear', 'jira', 'github'],
        patterns: options.ticketEnforcement?.patterns ?? ['\\[[A-Z]+-\\d+\\]', '#\\d+']
      },
      constitution: {
        enabled: options.constitution?.enabled ?? true,
        path: options.constitution?.path ?? '.github/constitution.md'
      }
    };
    return yaml.dump(config);
  }

  /**
   * Builds constitution.md content string.
   */
  static buildConstitutionMarkdown(rules: ConstitutionRule[]): string {
    let md = `# Operational Constitution\n\n`;
    for (const rule of rules) {
      md += `## Rule ${rule.id}: ${rule.title}\n`;
      md += `- **Category**: ${rule.category}\n`;
      md += `- **Directive**: ${rule.directive}\n`;
      if (rule.forbiddenPatterns && rule.forbiddenPatterns.length > 0) {
        md += `- **Forbidden Patterns**:\n`;
        for (const pattern of rule.forbiddenPatterns) {
          md += `  - \`${pattern}\` \n`;
        }
      }
      if (rule.mandatoryGuidelines && rule.mandatoryGuidelines.length > 0) {
        md += `- **Mandatory Guidelines**:\n`;
        for (const guideline of rule.mandatoryGuidelines) {
          md += `  - ${guideline}\n`;
        }
      }
      md += `\n`;
    }
    return md;
  }
}
```

---

## 4. Isolated DB & Filesystem State Management (`stateManager.ts`)

To ensure test isolation, zero cross-test interference, and clean execution under concurrency, `stateManager.ts` manages temporary filesystem directories and database instances.

### 4.1 Database Isolation Architecture
1. **SQLite Strategy**: Each test execution context creates a unique SQLite database file located in a temporary directory (`/tmp/ct-e2e-<uuid>/state.sqlite`) OR connects to a dedicated `:memory:` SQLite instance.
2. **Schema Bootstrapping**: Automatically runs DDL statements on database initialization (`CREATE TABLE IF NOT EXISTS diff_states (...)`, `CREATE TABLE IF NOT EXISTS findings (...)`).
3. **JSON Fallback Strategy**: If running in JSON atomic storage mode, creates an isolated state folder (`/tmp/ct-e2e-<uuid>/state_json/`) with initial empty JSON state files.
4. **Environment Variable Injection**: Dynamically sets `process.env.CT_REVIEW_DB_PATH` and `process.env.CT_REVIEW_STATE_DIR` pointing to the temporary paths before initializing the service under test.

### 4.2 Filesystem Sandbox Structure
For each test run context, `stateManager.ts` builds the following temporary filesystem directory:

```
/tmp/ct-e2e-<test-run-id>/
├── repo/
│   ├── .ct-review.yaml
│   ├── .github/
│   │   └── constitution.md
│   └── src/
├── state/
│   └── review_state.sqlite (or diff_state.json)
└── logs/
    └── test_app.log
```

### 4.3 `stateManager.ts` Specification & API

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';

export interface TestEnvironmentContext {
  testRunId: string;
  rootDir: string;
  repoDir: string;
  stateDir: string;
  dbPath: string;
  configPath: string;
  constitutionPath: string;
  env: Record<string, string>;
  db: InstanceType<typeof Database>;
}

export class StateManager {
  private activeContexts: Map<string, TestEnvironmentContext> = new Map();

  /**
   * Initializes an isolated filesystem sandbox and database context for a test run.
   */
  public async createEnvironment(testRunId: string): Promise<TestEnvironmentContext> {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `ct-e2e-${testRunId}-`));
    const repoDir = path.join(rootDir, 'repo');
    const stateDir = path.join(rootDir, 'state');
    const dbPath = path.join(stateDir, 'review_state.sqlite');
    const configPath = path.join(repoDir, '.ct-review.yaml');
    const constitutionDir = path.join(repoDir, '.github');
    const constitutionPath = path.join(constitutionDir, 'constitution.md');

    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(constitutionDir, { recursive: true });

    // Initialize SQLite database schema
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS pr_diff_states (
        pr_id INTEGER PRIMARY KEY,
        repo_full_name TEXT NOT NULL,
        last_commit_sha TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tracked_findings (
        id TEXT PRIMARY KEY,
        pr_id INTEGER NOT NULL,
        finding_hash TEXT NOT NULL,
        persona TEXT NOT NULL,
        severity TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        status TEXT NOT NULL, -- 'identified' | 'resolved'
        comment_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME
      );
    `);

    const env = {
      NODE_ENV: 'test',
      CT_REVIEW_DB_PATH: dbPath,
      CT_REVIEW_CONFIG_PATH: configPath,
      CT_REVIEW_CONSTITUTION_PATH: constitutionPath,
      CT_REVIEW_STATE_DIR: stateDir,
    };

    const ctx: TestEnvironmentContext = {
      testRunId,
      rootDir,
      repoDir,
      stateDir,
      dbPath,
      configPath,
      constitutionPath,
      env,
      db,
    };

    this.activeContexts.set(testRunId, ctx);
    return ctx;
  }

  /**
   * Writes fixture files (.ct-review.yaml, constitution.md) into the isolated sandbox repo.
   */
  public setupFixtures(ctx: TestEnvironmentContext, configYaml: string, constitutionMd?: string): void {
    fs.writeFileSync(ctx.configPath, configYaml, 'utf-8');
    if (constitutionMd) {
      fs.writeFileSync(ctx.constitutionPath, constitutionMd, 'utf-8');
    }
  }

  /**
   * DB State Inspection Helper: Query tracked findings stored in the isolated database.
   */
  public getTrackedFindings(ctx: TestEnvironmentContext, prId: number): Array<{
    id: string;
    finding_hash: string;
    persona: string;
    severity: string;
    file_path: string;
    line_number: number;
    status: string;
  }> {
    const stmt = ctx.db.prepare('SELECT * FROM tracked_findings WHERE pr_id = ? ORDER BY line_number ASC');
    return stmt.all(prId) as any[];
  }

  /**
   * DB State Inspection Helper: Query PR commit state.
   */
  public getPrState(ctx: TestEnvironmentContext, prId: number): { pr_id: number; repo_full_name: string; last_commit_sha: string } | undefined {
    const stmt = ctx.db.prepare('SELECT * FROM pr_diff_states WHERE pr_id = ?');
    return stmt.get(prId) as any;
  }

  /**
   * Cleanly closes DB connections and removes temporary directories.
   */
  public async teardownEnvironment(testRunId: string): Promise<void> {
    const ctx = this.activeContexts.get(testRunId);
    if (!ctx) return;

    try {
      ctx.db.close();
    } catch (err) {
      // Ignore database close errors if already closed
    }

    try {
      fs.rmSync(ctx.rootDir, { recursive: true, force: true });
    } catch (err) {
      // Directory cleanup warning
    }

    this.activeContexts.delete(testRunId);
  }
}
```

---

## 5. E2E Test Runner Framework & Harness Architecture

### 5.1 Test Runner Selection & Configuration
- **Framework**: **Vitest** v1.5+
- **Rationale**:
  - Native TypeScript execution (no separate compilation step needed).
  - Fast parallel thread worker execution model with isolated worker environments.
  - Express app supertest integration support.
  - Out-of-the-box assertion framework and compatibility with Jest matchers.

#### `vitest.config.e2e.ts`:
```typescript
import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  test: {
    name: 'e2e-test-suite',
    include: ['tests/e2e/**/*.test.ts'],
    globalSetup: ['tests/e2e/harness/globalSetup.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 10000,
    threads: true,
    maxThreads: 4,
    minThreads: 1,
    reporters: ['default', 'junit', 'json'],
    outputFile: {
      junit: 'test-results/e2e-junit.xml',
      json: 'test-results/e2e-results.json',
    },
  },
  resolve: {
    alias: {
      '@src': path.resolve(__dirname, './src'),
      '@harness': path.resolve(__dirname, './tests/e2e/harness'),
    },
  },
});
```

#### npm Package Scripts (`package.json`):
```json
{
  "scripts": {
    "test:e2e": "vitest run --config vitest.config.e2e.ts",
    "test:e2e:tier1": "vitest run --config vitest.config.e2e.ts tests/e2e/tier1",
    "test:e2e:tier2": "vitest run --config vitest.config.e2e.ts tests/e2e/tier2",
    "test:e2e:tier3": "vitest run --config vitest.config.e2e.ts tests/e2e/tier3",
    "test:e2e:tier4": "vitest run --config vitest.config.e2e.ts tests/e2e/tier4"
  }
}
```

---

### 5.2 Harness Directory Layout (`tests/e2e/`)

The layout under `tests/e2e/` strictly adheres to `SCOPE.md` requirements:

```
tests/e2e/
├── harness/
│   ├── e2eTestRunner.ts         # High-level suite runner & orchestrator
│   ├── globalSetup.ts           # Global Vitest setup (port allocation, temp cleanup)
│   ├── mockGithubServer.ts      # Webhook event generator & Octokit REST recorder (Explorer 1)
│   ├── mockOmniRouteServer.ts   # Multi-provider LLM mock server (Explorer 2)
│   ├── mockTicketServer.ts      # Linear / Jira / GitHub API mock server (Explorer 2)
│   ├── fixtureGenerator.ts      # Diff, YAML config & constitution markdown builders
│   ├── stateManager.ts          # SQLite/JSON & temp filesystem sandbox manager
│   ├── appProcessLauncher.ts    # Service under test launcher (Supertest or express app wrapper)
│   └── assertions.ts            # Custom domain assertions (PR comments, decisions, diff hashes)
├── tier1/                       # Tier 1 Feature Coverage Tests (35+ cases)
│   ├── quorum.test.ts
│   ├── config.test.ts
│   ├── ticket.test.ts
│   ├── constitution.test.ts
│   ├── diffState.test.ts
│   ├── omniRoute.test.ts
│   └── webhook.test.ts
├── tier2/                       # Tier 2 Boundary & Corner Case Tests (35+ cases)
│   ├── quorumBoundaries.test.ts
│   ├── configBoundaries.test.ts
│   ├── ticketBoundaries.test.ts
│   ├── constitutionBoundaries.test.ts
│   ├── diffStateBoundaries.test.ts
│   ├── omniRouteBoundaries.test.ts
│   └── webhookBoundaries.test.ts
├── tier3/                       # Tier 3 Cross-Feature Interactions (7+ cases)
│   └── crossFeatureInteractions.test.ts
├── tier4/                       # Tier 4 Real-World PR Workflows (5+ cases)
│   └── realWorldScenarios.test.ts
└── fixtures/                    # Static asset templates & sample diff files
    ├── diffs/
    ├── configs/
    └── constitutions/
```

---

### 5.3 Complete End-to-End Test Execution Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           E2E Test Case Execution                       │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. StateManager.createEnvironment(testId)                               │
│    - Creates /tmp/ct-e2e-<testId>/ sandbox                              │
│    - Initializes SQLite DB schema                                       │
│    - Binds CT_REVIEW_DB_PATH & CT_REVIEW_CONFIG_PATH env vars           │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. Setup Mock Servers & Fixtures                                        │
│    - Start MockGithubServer, MockOmniRouteServer, MockTicketServer     │
│    - FixtureGenerator -> write .ct-review.yaml & constitution.md        │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. AppProcessLauncher.startApp(env)                                     │
│    - Bootstraps Express service bound to mock ports & temp DB           │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. Trigger GitHub Webhook                                               │
│    - MockGithubServer.sendPullRequestEvent(action: "opened", diff)      │
│    - Webhook delivered to Express endpoint POST /github/webhook          │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 5. Asynchronous Processing & Polling                                    │
│    - App parses config, validates ticket, checks constitution          │
│    - App hashes diff, queries diff state DB                             │
│    - App calls MockOmniRouteServer for quorum persona reviews           │
│    - App aggregates consensus -> calls MockGithubServer comment API     │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 6. Assertions & Verification                                            │
│    - E2EAssertions.assertPrReviewSubmitted(mockGithub, expectedDecision)│
│    - StateManager.getTrackedFindings(ctx, prId) -> verify DB state      │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 7. Teardown                                                             │
│    - Stop app process & mock servers                                    │
│    - StateManager.teardownEnvironment(testId) -> clean /tmp dir & DB    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### 5.4 Custom Domain Assertions (`assertions.ts`)

```typescript
import { expect } from 'vitest';
import { MockGithubServer } from './mockGithubServer';
import { StateManager, TestEnvironmentContext } from './stateManager';

export class E2EAssertions {
  /**
   * Asserts that a PR review summary was posted to MockGithubServer with expected decision.
   */
  static assertPrReviewSubmitted(
    mockGithub: MockGithubServer,
    prNumber: number,
    expectedDecision: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  ): void {
    const reviews = mockGithub.getRecordedReviews(prNumber);
    expect(reviews.length).toBeGreaterThan(0);
    const latestReview = reviews[reviews.length - 1];
    expect(latestReview.event).toBe(expectedDecision);
  }

  /**
   * Asserts inline diff comments count and specific finding contents.
   */
  static assertInlineCommentsCount(
    mockGithub: MockGithubServer,
    prNumber: number,
    expectedCount: number
  ): void {
    const comments = mockGithub.getRecordedInlineComments(prNumber);
    expect(comments.length).toBe(expectedCount);
  }

  /**
   * Asserts DB finding tracking state across commit SHAs (incremental diff assertion).
   */
  static assertDbTrackedFindingStatus(
    stateMgr: StateManager,
    ctx: TestEnvironmentContext,
    prId: number,
    filePath: string,
    lineNumber: number,
    expectedStatus: 'identified' | 'resolved'
  ): void {
    const findings = stateMgr.getTrackedFindings(ctx, prId);
    const match = findings.find(f => f.file_path === filePath && f.line_number === lineNumber);
    expect(match).toBeDefined();
    expect(match?.status).toBe(expectedStatus);
  }
}
```

---

## 6. Integration with Peer E2E Mocks

The test runner harness seamlessly integrates with mock modules specified by peer explorers:

1. **`mockGithubServer.ts` (Explorer 1)**:
   - Delivers HMAC-signed Webhook payloads (`X-Hub-Signature-256`) to the application server endpoint `POST /github/webhook`.
   - Records incoming REST Octokit API requests (`POST /repos/{owner}/{repo}/pulls/{pr_number}/reviews`, `POST /repos/{owner}/{repo}/pulls/{pr_number}/comments`).
2. **`mockOmniRouteServer.ts` (Explorer 2)**:
   - Listens on mock HTTP endpoint (e.g. `http://localhost:9090`).
   - Responds to multi-persona LLM completion requests (`security`, `architecture`, `performance`, `quality`).
   - Simulates token refresh routines, effort level behaviors (`low`, `medium`, `high`, `reasoning`), and failover pool switching.
3. **`mockTicketServer.ts` (Explorer 2)**:
   - Listens on mock HTTP endpoints for Linear (`POST /graphql`), Jira (`GET /rest/api/3/issue/{key}`), and GitHub Issues (`GET /repos/{owner}/{repo}/issues/{id}`).
   - Returns valid ticket metadata or 404 Not Found for ticket validation tests.

---

## 7. Verification Method

To verify the test runner framework, fixture generators, and isolated state harness:

1. **Unit Verification of Fixture Generators**:
   - Execute `npx vitest run tests/unit/fixtureGenerator.test.ts`.
   - Verify generated diffs contain valid Git unified headers and hunk line counts.
   - Verify `buildConfigYaml` outputs valid YAML compliant with `CtReviewConfig` schema.
2. **State Harness Isolation Verification**:
   - Create 2 parallel test contexts (`createEnvironment("test_a")` and `createEnvironment("test_b")`).
   - Write unique findings to DB A and DB B.
   - Assert DB A contains only finding A and DB B contains only finding B, confirming complete isolation.
   - Execute `teardownEnvironment` and verify temporary directories under `/tmp` are removed without leaving file leaks.
3. **End-to-End Dry Run**:
   - Execute `npm run test:e2e:tier1`.
   - Confirm all mock servers start, app process connects to isolated test DB, webhook events trigger processing, and assertions evaluate cleanly.

---
