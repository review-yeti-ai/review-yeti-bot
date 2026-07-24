import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { parseAndValidateConfig, ConfigValidationError } from '@src/config/configLoader';
import { ctReviewConfigSchema } from '@src/config/schema';
import { queryLinearTicket, queryJiraTicket, queryGithubIssue } from '@src/ticket/ticketProviderClient';
import { validateTicketLinkage } from '@src/ticket/ticketValidator';
import { parseConstitution, evaluateConstitution } from '@src/constitution/constitutionEngine';
import { DiffStateManager } from '@src/persistence/diffStateManager';
import { createDiffStateStorage } from '@src/persistence/db';
import { ProviderPool } from '@src/router/providerPool';
import { TokenManager, TokenRefreshManager, SecureSecretStore } from '@src/router/tokenManager';
import { createWebhookRouter } from '@src/github/webhookServer';
import request from 'supertest';
import express from 'express';

describe('Tier 5 E2E Adversarial Hardening Suite: White-Box Edge Cases & Latent Failure Modes', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier5-adversarial-suite',
    });
  });

  afterAll(async () => {
    await harness.teardown();
  });

  test('1. Config Loader: Top-Level YAML Array input throws ConfigValidationError', () => {
    const yamlArrayInput = `- item1\n- item2\n- item3`;
    expect(() => parseAndValidateConfig(yamlArrayInput)).toThrow(ConfigValidationError);
    expect(() => parseAndValidateConfig(yamlArrayInput)).toThrow(/must be a key-value mapping object/i);
  });

  test('2. Config Schema: Empty ticket providers array throws Zod validation error', () => {
    const emptyProvidersYaml = `
ticketEnforcement:
  required: true
  providers: []
`;
    expect(() => parseAndValidateConfig(emptyProvidersYaml)).toThrow(ConfigValidationError);
  });

  test('3. Ticket Client: GraphQL query injection attempts are sanitized and parameterized', async () => {
    let capturedBody: any = null;
    const mockServer = express();
    mockServer.use(express.json());
    mockServer.post('/linear/graphql', (req, res) => {
      capturedBody = req.body;
      res.json({
        data: {
          issue: {
            id: 'PROJ-123',
            title: 'Test Issue',
            state: { name: 'In Progress' },
          },
        },
      });
    });

    const server = await new Promise<any>((resolve) => {
      const s = mockServer.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const maliciousTicketId = 'PROJ-123") { id } issue(id: "EVIL';
      const result = await queryLinearTicket(baseUrl, maliciousTicketId);
      expect(result.data.issue.id).toBe('PROJ-123');

      // Verify that the query uses parameterized $id variables and strips injected quotes
      expect(capturedBody.query).toContain('query($id: String!)');
      expect(capturedBody.query).not.toContain('EVIL');
      expect(capturedBody.variables.id).not.toContain('"');
    } finally {
      server.close();
    }
  });

  test('4. Ticket Client: REST endpoints encode URI parameters safely', async () => {
    let capturedJiraUrl = '';
    let capturedGithubUrl = '';

    const mockServer = express();
    mockServer.get('/jira/rest/api/3/issue/:key(*)', (req, res) => {
      capturedJiraUrl = req.url;
      res.json({ key: req.params.key, fields: { summary: 'Jira Test', status: { name: 'Open' } } });
    });
    mockServer.get('/github/repos/:owner/:repo/issues/:issueNum', (req, res) => {
      capturedGithubUrl = req.url;
      res.json({ number: Number(req.params.issueNum), title: 'GH Test' });
    });

    const server = await new Promise<any>((resolve) => {
      const s = mockServer.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await queryJiraTicket(baseUrl, 'PROJECT/PROJ 123#test');
      expect(capturedJiraUrl).toContain('PROJECT%2FPROJ%20123%23test');

      await queryGithubIssue(baseUrl, 'owner/name', 'repo/test', '101?query=1');
      expect(capturedGithubUrl).toContain('owner%2Fname');
      expect(capturedGithubUrl).toContain('repo%2Ftest');
    } finally {
      server.close();
    }
  });

  test('5. Ticket Validator: Ignores false positive technical tokens (UTF-8, SHA-256, ISO-8601)', () => {
    const config = {
      required: true,
      providers: ['linear', 'jira'],
      patterns: [],
    };

    const title = 'docs: update UTF-8 encoding and SHA-256 hashing format [PROJ-456]';
    const body = 'Refactored ISO-8601 date timestamps and COVID-19 tracker LOG-1.';

    const result = validateTicketLinkage({ title, body, config });

    expect(result.valid).toBe(true);
    expect(result.ticketsFound).toContain('PROJ-456');
    expect(result.ticketsFound).not.toContain('UTF-8');
    expect(result.ticketsFound).not.toContain('SHA-256');
    expect(result.ticketsFound).not.toContain('ISO-8601');
    expect(result.ticketsFound).not.toContain('COVID-19');
    expect(result.ticketsFound).not.toContain('LOG-1');
  });

  test('6. Constitution Engine: Single hash top-level headings classify forbidden rules correctly', () => {
    const mdContent = `# Forbidden Patterns
- Do not use eval() in production code
- Never hardcode JWT secret keys
`;

    const parsed = parseConstitution(mdContent);
    expect(parsed.rules.length).toBe(2);
    expect(parsed.rules[0].type).toBe('forbidden_pattern');
    expect(parsed.rules[1].type).toBe('forbidden_pattern');
  });

  test('7. Constitution Engine: Conventional Commit breaking change ! syntax is accepted', () => {
    const mdContent = `# Rules
## Directives
- PR title must follow conventional commits format
`;

    const parsed = parseConstitution(mdContent);
    const result = evaluateConstitution({
      constitution: parsed,
      prTitle: 'feat(auth)!: breaking change update to OAuth2 login',
      prBody: 'Detailed description of changes.',
    });

    expect(result.compliant).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test('8. Constitution Engine: Non-regex keyword rules check per-line to avoid distant false positives', () => {
    const mdContent = `# Rules
## Forbidden Patterns
- Never use console.log in code
`;

    const parsed = parseConstitution(mdContent);

    // File with console on line 1 and log on line 100
    let fileContent = 'const console = window.console;\n';
    for (let i = 0; i < 98; i++) fileContent += `const v${i} = ${i};\n`;
    fileContent += 'logger.info("system logging initialized");\n';

    const result = evaluateConstitution({
      constitution: parsed,
      prTitle: 'feat: add logging',
      prBody: 'pr body',
      changedFiles: [{ path: 'src/app.ts', content: fileContent }],
    });

    expect(result.compliant).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test('9. Diff State: Line insertions above untouched findings shift lines and prevent false resolution', async () => {
    const storage = await createDiffStateStorage(':memory:', ':memory:');
    const manager = new DiffStateManager(storage);

    // Commit 1: Register finding at line 30
    await manager.processPRCommitUpdate({
      repoOwner: 'calltelemetry',
      repoName: 'ct-review-bot',
      prNumber: 999,
      headSha: 'commit-1',
      baseSha: 'base-0',
      hunks: [
        { filePath: 'src/service.ts', oldStart: 1, oldLines: 50, newStart: 1, newLines: 50, hunkContent: '...' },
      ],
      quorumFindings: [
        {
          filePath: 'src/service.ts',
          startLine: 30,
          endLine: 30,
          persona: 'security',
          severity: 'major',
          comment: 'Insecure random number generator',
          codeSnippet: 'Math.random()',
        },
      ],
    });

    // Commit 2: Insert 20 lines at lines 1-20 (moving finding from line 30 to line 50)
    const result2 = await manager.processPRCommitUpdate({
      repoOwner: 'calltelemetry',
      repoName: 'ct-review-bot',
      prNumber: 999,
      headSha: 'commit-2',
      baseSha: 'commit-1',
      hunks: [
        { filePath: 'src/service.ts', oldStart: 1, oldLines: 0, newStart: 1, newLines: 20, hunkContent: '...' },
      ],
      quorumFindings: [], // No new findings reported for lines 1-20
    });

    expect(result2.activeFindings).toHaveLength(1);
    expect(result2.resolvedFindings).toHaveLength(0);
    expect(result2.activeFindings[0].startLine).toBe(50);
    expect(result2.activeFindings[0].status).toBe('IDENTIFIED');
  });

  test('10. Router: Circuit breaker trips on HTTP 401 & 403 authentication failures', () => {
    const pool = new ProviderPool('priority_fallback');
    pool.registerProvider({ id: 'openai', name: 'OpenAI', priority: 1 });

    const node = pool.getProvider('openai')!;
    expect(node.circuitState).toBe('CLOSED');
    expect(node.healthState).toBe('healthy');

    // Record HTTP 401 authentication failure
    node.recordFailure(401, 'Unauthorized: Invalid API Key');

    expect(node.circuitState).toBe('OPEN');
    expect(node.healthState).toBe('cooling_down');
    expect(node.isAvailable()).toBe(false);
  });

  test('11. Token Manager: Preemptive token refresh protects against backward clock skew', async () => {
    const store = new SecureSecretStore('master-key-test-12345');
    const refreshManager = new TokenRefreshManager(store);

    let refreshCounter = 0;
    refreshManager.registerRefreshConfig({
      providerId: 'anthropic',
      customRefreshHandler: async () => {
        refreshCounter++;
        return {
          accessToken: `token-v${refreshCounter}`,
          expiresAt: Date.now() + 3600000,
        };
      },
    });

    // Set token with expiresAt in the past (clock skew simulation)
    refreshManager.setOAuthTokenData('anthropic', {
      accessToken: 'stale-token',
      expiresAt: Date.now() - 5000,
    });

    const token = await refreshManager.getValidAccessToken('anthropic');
    expect(token).toBe('token-v1');
    expect(refreshCounter).toBe(1);
  });

  test('12. Webhook Server: Rejects requests with malformed JSON and invalid signature with HTTP 401', async () => {
    const router = createWebhookRouter({ secret: 'super-secret-key' });
    const app = express();
    app.use(router);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', 'sha256=invalid_hmac_hash')
      .send('{ "malformed_json": ');

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error', 'Invalid or missing signature');
  });

  test('13. Index Script: Core module exports and graceful error handling interface', async () => {
    const indexModule = await import('@src/index');
    expect(indexModule.app).toBeDefined();
    expect(indexModule.createApp).toBeDefined();
    expect(indexModule.getProviderPool).toBeDefined();
    expect(indexModule.getTokenManager).toBeDefined();
  });
});
