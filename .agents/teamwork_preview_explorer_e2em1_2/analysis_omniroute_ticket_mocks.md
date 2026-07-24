# Architectural Specification: OmniRoute LLM & Ticket API Mock Servers (`mockOmniRouteServer.ts` & `mockTicketServer.ts`)

**Milestone**: E2E-M1 (Harness & Mocks Setup)  
**Author**: `teamwork_preview_explorer_e2em1_2`  
**Target Path**: `tests/e2e/harness/mockOmniRouteServer.ts` and `tests/e2e/harness/mockTicketServer.ts`  
**Working Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_e2em1_2`  

---

## 1. Executive Summary

This specification defines the architectural design, API contracts, state management, fault injection capabilities, and implementation code for two core E2E test harness components:
1. **`mockOmniRouteServer.ts`**: Standalone HTTP server mocking the OmniRoute LLM gateway, supporting multi-provider routing (OpenAI, Anthropic, Google, DeepSeek), OAuth 2.0 token refresh lifecycles, provider failover pools, effort level handling (`low`, `medium`, `high`, `reasoning`), persona response generation, and fault injection.
2. **`mockTicketServer.ts`**: Standalone HTTP server mocking enterprise issue tracking APIs, supporting Linear GraphQL (`/linear/graphql`), Jira REST v3 (`/jira/rest/api/3/issue/:id`), and GitHub Issues REST v3 (`/github/repos/:owner/:repo/issues/:id`), with dynamic ticket registration, status verification, and failure injection.

These mock servers enable **opaque-box E2E testing** of `ct-review-bot` by executing real HTTP requests over the network without modifying service code or depending on third-party live services.

---

## 2. OmniRoute & Ticket System Architecture Review

### 2.1 OmniRoute Router Subsystem (`src/router/`)
The `ct-review-bot` uses OmniRoute to decouple persona review engines from specific LLM providers.
- **`omniRouteAdapter.ts`**: Converts system review requests (`LLMRequest`) into provider-specific payloads, executes HTTP requests to the routing gateway, and maps responses to `LLMResponse`.
- **`tokenManager.ts`**: Manages bearer authentication tokens for OmniRoute gateway, auto-refreshing expired tokens via `/v1/oauth/token` before token invalidation breaks active reviews.
- **`providerPool.ts`**: Maintains an ordered list of providers (e.g. `['openai', 'anthropic', 'google', 'deepseek']`). When a provider returns `5xx`, `429 Rate Limit`, `401 Unauthorized`, or times out, the pool triggers failover to the next candidate provider.

### 2.2 Ticket Linkage Subsystem (`src/ticket/`)
The ticket linkage validator inspects PR metadata (titles, descriptions, branch names) and ensures PRs reference valid work tickets.
- **`ticketValidator.ts`**: Regex extractor matching keys for Linear (`PROJ-123`), Jira (`KEY-456`), and GitHub (`#789`, `owner/repo#101`).
- **External API Verification**: In strict verification modes, the validator performs live HTTP calls to verify ticket existence, assignee, and state (e.g., ensuring ticket is not closed or invalid).

---

## 3. Opaque-Box E2E Testing Requirements Analysis

Opaque-box testing requires testing `ct-review-bot` strictly from the outside. The bot process runs with configuration pointing its HTTP endpoints to local mock servers.

```
┌───────────────────────────────────────────────────────────────────┐
│                    ct-review-bot Service Under Test               │
│                                                                   │
│  ┌───────────────────────┐             ┌───────────────────────┐  │
│  │   src/router/         │             │   src/ticket/         │  │
│  │   OmniRoute Adapter   │             │   Ticket Validator    │  │
│  └───────────┬───────────┘             └───────────┬───────────┘  │
└──────────────┼─────────────────────────────────────┼──────────────┘
               │ HTTP                                │ HTTP
               ▼                                     ▼
┌───────────────────────────────┐     ┌───────────────────────────────┐
│     mockOmniRouteServer       │     │       mockTicketServer        │
│  (Port 9090 / Configurable)   │     │  (Port 9091 / Configurable)   │
│  - Multi-Provider Router      │     │  - Linear GraphQL API         │
│  - OAuth Token Refresh        │     │  - Jira REST API v3           │
│  - Failover State Machine     │     │  - GitHub Issues API v3       │
│  - Effort Level Formatting    │     │  - Fault Injection Admin      │
└───────────────────────────────┘     └───────────────────────────────┘
```

### 3.1 Key Requirements for `mockOmniRouteServer.ts`
1. **OAuth Token Lifecycle**: Must accept token exchange requests at `/v1/oauth/token`. Must validate incoming Bearer tokens on LLM routes (`/v1/chat/completions` or `/api/v1/route`), returning HTTP `401 Token Expired` when configured to simulate token expiration.
2. **Provider Failover Simulation**: Must support programmatic failover configuration via `/__admin/configure`. Tests must be able to specify: "Provider `openai` returns HTTP 503 for next 2 requests; Provider `anthropic` succeeds."
3. **Effort Levels & Personas**: Must inspect `effortLevel` (`low`, `medium`, `high`, `reasoning`) and `persona` (`security`, `architecture`, `performance`, `quality`) in the payload, returning appropriate structured review findings and token usage metrics.
4. **Admin Request Inspection**: Must record all incoming HTTP calls for post-test assertions (`/__admin/requests`).

### 3.2 Key Requirements for `mockTicketServer.ts`
1. **Multi-Protocol Mocking**:
   - **Linear**: Support GraphQL queries at `/linear/graphql` (e.g. `query { issue(id: "PROJ-123") { id title state { name } } }`).
   - **Jira**: Support REST v3 GET requests at `/jira/rest/api/3/issue/:key`.
   - **GitHub**: Support REST v3 GET requests at `/github/repos/:owner/:repo/issues/:number`.
2. **Dynamic Ticket Registry**: Allow tests to pre-register valid and invalid tickets (`POST /__admin/tickets`).
3. **Fault & Delay Injection**: Support simulating HTTP 404 (Ticket Not Found), 429 (Rate Limited), 401 (Unauthorized), and 500 (Internal Error) per provider or per ticket ID.

---

## 4. Detailed Design: `mockOmniRouteServer.ts`

### 4.1 Architecture & Lifecycle Management
`MockOmniRouteServer` is encapsulated as a Node.js class wrapping an Express application listening on an ephemeral or configured port.

```typescript
export class MockOmniRouteServer {
  private app: Express;
  private server: Server | null = null;
  private port: number;
  private state: OmniRouteMockState;

  constructor(port = 9090);
  public async start(): Promise<string>; // Returns base URL e.g. http://127.0.0.1:9090
  public async stop(): Promise<void>;
  public reset(): void;
  public configure(config: Partial<OmniRouteMockState>): void;
  public getRecordedRequests(): RecordedRequest[];
}
```

### 4.2 State Contract & Admin API

```typescript
export interface ProviderBehavior {
  status: number; // e.g. 200, 429, 500, 503
  responseBody?: any;
  delayMs?: number;
  failCount?: number; // Number of times to fail before auto-recovering
}

export interface OmniRouteMockState {
  validTokens: Set<string>;
  refreshTokenMap: Map<string, string>; // refresh_token -> access_token
  tokenExpired: boolean;
  activeProvider: string; // e.g. 'openai'
  providerBehaviors: Map<string, ProviderBehavior>;
  defaultPersonaResponses: Map<string, any>;
  recordedRequests: RecordedRequest[];
}
```

#### Admin Routes:
- `POST /__admin/configure`: Updates mock state (tokens, provider failures, latency).
- `GET /__admin/requests`: Returns array of recorded HTTP requests for test verification.
- `POST /__admin/reset`: Resets state to default.

---

### 4.3 Implementation Specification (`tests/e2e/harness/mockOmniRouteServer.ts`)

```typescript
import express, { Request, Response, Express } from 'express';
import { Server } from 'http';

export interface LLMRequestPayload {
  prompt: string;
  systemPrompt?: string;
  persona: 'security' | 'architecture' | 'performance' | 'quality';
  effortLevel: 'low' | 'medium' | 'high' | 'reasoning';
  provider?: string;
  model?: string;
  temperature?: number;
}

export interface LLMResponsePayload {
  content: string;
  providerUsed: string;
  modelUsed: string;
  tokensUsed: {
    prompt: number;
    completion: number;
    total: number;
  };
  reasoningTrace?: string;
}

export interface RecordedRequest {
  timestamp: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

export class MockOmniRouteServer {
  private app: Express;
  private server: Server | null = null;
  public readonly port: number;

  private validTokens: Set<string> = new Set(['valid-access-token-123']);
  private refreshTokens: Map<string, string> = new Map([['valid-refresh-token', 'new-access-token-456']]);
  private tokenExpired = false;
  private providerFailures: Map<string, { status: number; message: string; remainingFails: number }> = new Map();
  private recordedRequests: RecordedRequest[] = [];

  constructor(port = 9090) {
    this.port = port;
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Request recording middleware
    this.app.use((req: Request, _res: Response, next) => {
      if (!req.path.startsWith('/__admin')) {
        this.recordedRequests.push({
          timestamp: new Date().toISOString(),
          method: req.method,
          path: req.path,
          headers: req.headers,
          body: req.body,
        });
      }
      next();
    });

    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.status(200).json({ status: 'ok', service: 'mockOmniRouteServer' });
    });

    // Admin Control Endpoints
    this.app.post('/__admin/configure', (req: Request, res: Response) => {
      const { tokenExpired, failProvider, resetFailures } = req.body;
      if (typeof tokenExpired === 'boolean') {
        this.tokenExpired = tokenExpired;
      }
      if (failProvider) {
        const { provider, status = 503, message = 'Provider Unavailable', failCount = 1 } = failProvider;
        this.providerFailures.set(provider, { status, message, remainingFails: failCount });
      }
      if (resetFailures) {
        this.providerFailures.clear();
      }
      res.status(200).json({ status: 'configured', currentFailures: Array.from(this.providerFailures.entries()) });
    });

    this.app.get('/__admin/requests', (_req: Request, res: Response) => {
      res.status(200).json(this.recordedRequests);
    });

    this.app.post('/__admin/reset', (_req: Request, res: Response) => {
      this.resetState();
      res.status(200).json({ status: 'reset' });
    });

    // OAuth 2.0 Token Refresh Endpoint
    this.app.post('/v1/oauth/token', (req: Request, res: Response) => {
      const { grant_type, refresh_token } = req.body;

      if (grant_type === 'refresh_token') {
        if (this.refreshTokens.has(refresh_token)) {
          const newToken = this.refreshTokens.get(refresh_token)!;
          this.validTokens.add(newToken);
          this.tokenExpired = false; // Reset expired state after refresh
          return res.status(200).json({
            access_token: newToken,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: refresh_token,
          });
        }
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid refresh token' });
      }

      // Default client credentials issuing
      const defaultToken = `token-${Date.now()}`;
      this.validTokens.add(defaultToken);
      return res.status(200).json({
        access_token: defaultToken,
        token_type: 'Bearer',
        expires_in: 3600,
      });
    });

    // OmniRoute Chat Completion & Routing Endpoint
    this.app.post('/v1/chat/completions', (req: Request, res: Response) => {
      // 1. Auth check
      const authHeader = req.headers.authorization;
      const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : null;

      if (this.tokenExpired || !token || !this.validTokens.has(token)) {
        return res.status(401).json({
          error: {
            message: 'Access token expired or invalid',
            type: 'invalid_request_error',
            code: 'token_expired',
          },
        });
      }

      const payload: LLMRequestPayload = req.body;
      const requestedProvider = payload.provider || 'openai';

      // 2. Check for injected provider failures (for failover testing)
      if (this.providerFailures.has(requestedProvider)) {
        const failConfig = this.providerFailures.get(requestedProvider)!;
        if (failConfig.remainingFails > 0) {
          failConfig.remainingFails--;
          if (failConfig.remainingFails === 0) {
            this.providerFailures.delete(requestedProvider);
          }
          return res.status(failConfig.status).json({
            error: {
              message: failConfig.message,
              provider: requestedProvider,
              code: 'provider_error',
            },
          });
        }
      }

      // 3. Generate Effort Level & Persona Response
      const response = this.generateResponse(payload, requestedProvider);
      return res.status(200).json(response);
    });
  }

  private generateResponse(payload: LLMRequestPayload, provider: string): LLMResponsePayload {
    const persona = payload.persona || 'quality';
    const effort = payload.effortLevel || 'medium';

    let promptTokens = 150;
    let completionTokens = 100;
    let reasoningTrace: string | undefined;

    if (effort === 'low') {
      promptTokens = 80;
      completionTokens = 40;
    } else if (effort === 'high') {
      promptTokens = 300;
      completionTokens = 250;
    } else if (effort === 'reasoning') {
      promptTokens = 400;
      completionTokens = 500;
      reasoningTrace = `<thinking>Analyzing ${persona} constraints for requested diff hunk...</thinking>`;
    }

    const content = JSON.stringify({
      findings: [
        {
          persona,
          severity: persona === 'security' ? 'critical' : 'minor',
          filePath: 'src/index.ts',
          lineNumber: 42,
          comment: `[MockOmniRoute:${effort}] Identified ${persona} concern in provided diff.`,
          suggestion: 'Refactor code to follow standard guidelines.',
        },
      ],
      summary: `Automated ${persona} review complete (${effort} effort).`,
    });

    return {
      content,
      providerUsed: provider,
      modelUsed: provider === 'anthropic' ? 'claude-3-5-sonnet' : 'gpt-4o',
      tokensUsed: {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens,
      },
      ...(reasoningTrace ? { reasoningTrace } : {}),
    };
  }

  public resetState(): void {
    this.validTokens = new Set(['valid-access-token-123']);
    this.refreshTokens = new Map([['valid-refresh-token', 'new-access-token-456']]);
    this.tokenExpired = false;
    this.providerFailures.clear();
    this.recordedRequests = [];
  }

  public start(): Promise<string> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        resolve(`http://127.0.0.1:${this.port}`);
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  public getRecordedRequests(): RecordedRequest[] {
    return [...this.recordedRequests];
  }
}
```

---

## 5. Detailed Design: `mockTicketServer.ts`

### 5.1 Architecture & Route Map

`MockTicketServer` handles HTTP requests for Linear (GraphQL), Jira (REST v3), and GitHub Issues (REST v3).

```
mockTicketServer (Port 9091 / Configurable)
├── POST /linear/graphql                     --> Linear GraphQL Handler
├── GET  /jira/rest/api/3/issue/:issueKey    --> Jira REST Handler
├── GET  /github/repos/:owner/:repo/issues/:id --> GitHub Issues Handler
├── POST /__admin/tickets                    --> Admin Pre-register Ticket
├── GET  /__admin/requests                   --> Request Verification API
└── POST /__admin/reset                      --> Reset Mock State
```

### 5.2 Mock Ticket Data Model

```typescript
export interface MockTicket {
  id: string; // e.g. "PROJ-123", "KEY-456", "789"
  provider: 'linear' | 'jira' | 'github';
  title: string;
  status: 'Open' | 'In Progress' | 'Closed' | 'Resolved';
  assignee?: string;
  projectKey?: string;
}
```

---

### 5.3 Implementation Specification (`tests/e2e/harness/mockTicketServer.ts`)

```typescript
import express, { Request, Response, Express } from 'express';
import { Server } from 'http';

export interface MockTicket {
  key: string; // e.g., 'PROJ-123', 'KEY-456', '789'
  provider: 'linear' | 'jira' | 'github';
  title: string;
  status: 'Open' | 'In Progress' | 'Closed' | 'Resolved';
  assignee?: string;
}

export interface TicketRecordedRequest {
  timestamp: string;
  method: string;
  path: string;
  body: any;
  query: any;
}

export class MockTicketServer {
  private app: Express;
  private server: Server | null = null;
  public readonly port: number;

  private tickets: Map<string, MockTicket> = new Map();
  private errorInjections: Map<string, number> = new Map(); // provider or key -> HTTP status
  private recordedRequests: TicketRecordedRequest[] = [];

  constructor(port = 9091) {
    this.port = port;
    this.app = express();
    this.app.use(express.json());
    this.seedDefaultTickets();
    this.setupRoutes();
  }

  private seedDefaultTickets(): void {
    this.tickets.set('PROJ-123', {
      key: 'PROJ-123',
      provider: 'linear',
      title: 'Fix authentication token leak',
      status: 'In Progress',
      assignee: 'Alice',
    });
    this.tickets.set('KEY-456', {
      key: 'KEY-456',
      provider: 'jira',
      title: 'Implement diff state persistence',
      status: 'Open',
      assignee: 'Bob',
    });
    this.tickets.set('789', {
      key: '789',
      provider: 'github',
      title: 'Update Kubernetes deployment manifests',
      status: 'Open',
    });
  }

  private setupRoutes(): void {
    // Recording Middleware
    this.app.use((req: Request, _res: Response, next) => {
      if (!req.path.startsWith('/__admin')) {
        this.recordedRequests.push({
          timestamp: new Date().toISOString(),
          method: req.method,
          path: req.path,
          body: req.body,
          query: req.query,
        });
      }
      next();
    });

    // Admin Endpoints
    this.app.post('/__admin/tickets', (req: Request, res: Response) => {
      const ticketsInput: MockTicket[] = Array.isArray(req.body) ? req.body : [req.body];
      for (const t of ticketsInput) {
        this.tickets.set(t.key.toUpperCase(), t);
      }
      res.status(200).json({ status: 'added', totalTickets: this.tickets.size });
    });

    this.app.post('/__admin/inject-error', (req: Request, res: Response) => {
      const { target, status = 500 } = req.body; // target can be 'linear', 'jira', 'github' or specific key
      this.errorInjections.set(target.toUpperCase(), status);
      res.status(200).json({ status: 'injected', target, httpStatus: status });
    });

    this.app.get('/__admin/requests', (_req: Request, res: Response) => {
      res.status(200).json(this.recordedRequests);
    });

    this.app.post('/__admin/reset', (_req: Request, res: Response) => {
      this.resetState();
      res.status(200).json({ status: 'reset' });
    });

    // 1. Linear GraphQL API Mock
    this.app.post('/linear/graphql', (req: Request, res: Response) => {
      if (this.errorInjections.has('LINEAR')) {
        const status = this.errorInjections.get('LINEAR')!;
        return res.status(status).json({ error: 'Linear API Error Injected' });
      }

      const { query, variables } = req.body;
      const issueKey = variables?.id || (typeof query === 'string' ? query.match(/id:\s*"([^"]+)"/)?.[1] : null);

      if (issueKey && this.tickets.has(issueKey.toUpperCase())) {
        const ticket = this.tickets.get(issueKey.toUpperCase())!;
        return res.status(200).json({
          data: {
            issue: {
              id: ticket.key,
              identifier: ticket.key,
              title: ticket.title,
              state: { name: ticket.status },
              assignee: ticket.assignee ? { name: ticket.assignee } : null,
            },
          },
        });
      }

      return res.status(200).json({
        data: { issue: null },
        errors: [{ message: `Entity not found: ${issueKey}` }],
      });
    });

    // 2. Jira REST API v3 Mock
    this.app.get('/jira/rest/api/3/issue/:issueKey', (req: Request, res: Response) => {
      const key = req.params.issueKey.toUpperCase();

      if (this.errorInjections.has('JIRA') || this.errorInjections.has(key)) {
        const status = this.errorInjections.get('JIRA') || this.errorInjections.get(key)!;
        return res.status(status).json({ errorMessages: ['Jira Error Injected'] });
      }

      if (this.tickets.has(key)) {
        const ticket = this.tickets.get(key)!;
        return res.status(200).json({
          id: '10001',
          key: ticket.key,
          fields: {
            summary: ticket.title,
            status: { name: ticket.status },
            assignee: ticket.assignee ? { displayName: ticket.assignee } : null,
          },
        });
      }

      return res.status(404).json({
        errorMessages: [`Issue ${key} does not exist or you do not have permission to view it.`],
      });
    });

    // 3. GitHub Issues REST API v3 Mock
    this.app.get('/github/repos/:owner/:repo/issues/:issue_number', (req: Request, res: Response) => {
      const issueNumber = req.params.issue_number;

      if (this.errorInjections.has('GITHUB')) {
        const status = this.errorInjections.get('GITHUB')!;
        return res.status(status).json({ message: 'GitHub API Error Injected' });
      }

      if (this.tickets.has(issueNumber)) {
        const ticket = this.tickets.get(issueNumber)!;
        return res.status(200).json({
          number: parseInt(issueNumber, 10),
          title: ticket.title,
          state: ticket.status.toLowerCase() === 'closed' ? 'closed' : 'open',
          user: { login: ticket.assignee || 'octocat' },
        });
      }

      return res.status(404).json({
        message: 'Not Found',
        documentation_url: 'https://docs.github.com/rest/reference/issues#get-an-issue',
      });
    });
  }

  public resetState(): void {
    this.tickets.clear();
    this.errorInjections.clear();
    this.recordedRequests = [];
    this.seedDefaultTickets();
  }

  public start(): Promise<string> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        resolve(`http://127.0.0.1:${this.port}`);
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  public getRecordedRequests(): TicketRecordedRequest[] {
    return [...this.recordedRequests];
  }
}
```

---

## 6. E2E Test Suite Integration Patterns

### 6.1 Test Harness Setup (`tests/e2e/harness/e2eTestRunner.ts`)
The E2E test runner automatically provisions both servers prior to running test suites.

```typescript
import { MockOmniRouteServer } from './mockOmniRouteServer';
import { MockTicketServer } from './mockTicketServer';

export async function setupE2ETestHarness() {
  const omniRouteServer = new MockOmniRouteServer(9090);
  const ticketServer = new MockTicketServer(9091);

  const omniRouteUrl = await omniRouteServer.start();
  const ticketUrl = await ticketServer.start();

  return {
    omniRouteServer,
    ticketServer,
    env: {
      OMNIROUTE_BASE_URL: omniRouteUrl,
      TICKET_API_BASE_URL: ticketUrl,
    },
    async teardown() {
      await omniRouteServer.stop();
      await ticketServer.stop();
    },
  };
}
```

### 6.2 Test Scenario 1: Token Refresh & Failover (Tier 2 Boundary Test)

```typescript
test('OmniRoute auto-refreshes token on 401 and falls back on provider 503', async () => {
  const { omniRouteServer } = harness;

  // Configure token expired & primary provider fail (OpenAI 503)
  omniRouteServer.configure({
    tokenExpired: true,
    failProvider: { provider: 'openai', status: 503, failCount: 1 },
  });

  // Execute bot review pipeline
  const result = await runBotReviewPipeline(samplePR);

  // Assertions
  expect(result.status).toBe('SUCCESS');
  expect(result.providerUsed).toBe('anthropic'); // Successfully failed over from openai to anthropic

  const requests = omniRouteServer.getRecordedRequests();
  expect(requests.some((r) => r.path === '/v1/oauth/token')).toBe(true); // Token refresh was called
});
```

### 6.3 Test Scenario 2: Ticket Validation Failure & Strict Enforcement (Tier 1 Feature Test)

```typescript
test('PR title with invalid Linear ticket fails strict validation', async () => {
  const { ticketServer } = harness;

  // PR has title "feat: add feature [PROJ-999]" (PROJ-999 not in mockTicketServer)
  const pr = { title: 'feat: add feature [PROJ-999]', body: 'Details...' };

  const validationResult = await validatePRTicketLinkage(pr);

  expect(validationResult.valid).toBe(false);
  expect(validationResult.error).toContain('PROJ-999');
});
```

---

## 7. Verification Method

1. **Unit Verification of Mock Servers**:
   - Run unit test suite for mock servers: `npx vitest run tests/unit/mockServers.test.ts`
   - Verify server startup, route handling, request recording, admin state modification, and server shutdown.
2. **Integration Verification**:
   - Start mock servers and execute `curl` requests targeting `/v1/chat/completions`, `/linear/graphql`, and `/jira/rest/api/3/issue/KEY-456`.
3. **Invalidation Conditions**:
   - Server fails to release port on `stop()`.
   - Admin reset fails to restore clean state.
   - Non-standard JSON error payloads returning HTML instead of JSON.
