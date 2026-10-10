import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import type { Env } from '../src/types.js';
import { defaultMcpRouter } from '../src/mcp/mcpRouter.js';
import { inMemoryStore } from '../src/storage/d1Client.js';

const ADMIN_TOKEN = 'test-admin-secret-token-xyz';

function createMockEnv(): Env {
  return {
    ENVIRONMENT: 'production',
    PARALLEL_MODE: 'true',
    PILOT_REPOSITORIES: 'all',
    REVIEW_YETI_MCP_AUTH_TOKEN: ADMIN_TOKEN,
    GITHUB_APP_ID: '4385771',
    GITHUB_APP_PRIVATE_KEY: '',
  } as unknown as Env;
}

function authedHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
}

describe('Settings & Onboarding API (/api/settings/*)', () => {
  describe('Authentication & Authorization', () => {
    it('returns HTTP 401 when no auth token is provided', async () => {
      const env = createMockEnv();
      const req = new Request('https://worker.dev/api/settings/status', { method: 'GET' });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 401);
      const body = (await res.json()) as any;
      assert.equal(body.success, false);
      assert.ok(body.error.includes('token required'));
    });

    it('returns HTTP 401 when invalid auth token is provided', async () => {
      const env = createMockEnv();
      const req = new Request('https://worker.dev/api/settings/status', {
        method: 'GET',
        headers: { Authorization: 'Bearer wrong-secret' },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 401);
    });

    it('accepts valid token via Authorization: Bearer header', async () => {
      const env = createMockEnv();
      const req = new Request('https://worker.dev/api/settings/status', {
        method: 'GET',
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
    });

    it('accepts valid token via x-api-key header', async () => {
      const env = createMockEnv();
      const req = new Request('https://worker.dev/api/settings/status', {
        method: 'GET',
        headers: { 'x-api-key': ADMIN_TOKEN },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
    });

    it('OPTIONS request returns HTTP 204 with permissive CORS headers without requiring auth', async () => {
      const env = createMockEnv();
      const req = new Request('https://worker.dev/api/settings/repos', { method: 'OPTIONS' });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
      assert.ok(res.headers.get('Access-Control-Allow-Methods')?.includes('GET'));
      assert.ok(res.headers.get('Access-Control-Allow-Methods')?.includes('POST'));
    });
  });

  describe('Status Endpoint (/api/settings/status)', () => {
    it('returns health, storage mode, and repository count', async () => {
      const env = createMockEnv();
      const req = new Request('https://worker.dev/api/settings/status', {
        method: 'GET',
        headers: authedHeaders(),
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.ok(body.status.totalRepositories >= 0);
      assert.equal(body.status.storageBackend, 'in-memory');
    });
  });

  describe('Organization CRUD (/api/settings/orgs)', () => {
    const testOrg = 'test-acme-corp';

    it('creates an organization via POST /api/settings/orgs', async () => {
      const env = createMockEnv();
      const payload = {
        org: testOrg,
        name: 'Acme Corporation',
        installationId: 987654,
        defaultProfile: 'balanced',
        passthroughDefault: true,
        settingsJson: { notificationsEmail: 'devs@acme.com' },
      };

      const req = new Request('https://worker.dev/api/settings/orgs', {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify(payload),
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 201);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.organization.id, testOrg);
      assert.equal(body.organization.name, 'Acme Corporation');
      assert.equal(body.organization.installationId, 987654);
      assert.equal(body.organization.passthroughEnabled, true);
    });

    it('retrieves the organization via GET /api/settings/orgs/:owner', async () => {
      const env = createMockEnv();
      const req = new Request(`https://worker.dev/api/settings/orgs/${testOrg}`, {
        method: 'GET',
        headers: authedHeaders(),
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.organization.id, testOrg);
    });

    it('updates organization settings via PATCH /api/settings/orgs/:owner', async () => {
      const env = createMockEnv();
      const req = new Request(`https://worker.dev/api/settings/orgs/${testOrg}`, {
        method: 'PATCH',
        headers: authedHeaders(),
        body: JSON.stringify({
          name: 'Acme Corporation Renamed',
          passthroughEnabled: false,
        }),
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.organization.name, 'Acme Corporation Renamed');
      assert.equal(body.organization.passthroughEnabled, false);
    });

    it('lists organizations via GET /api/settings/orgs', async () => {
      const env = createMockEnv();
      const req = new Request('https://worker.dev/api/settings/orgs', {
        method: 'GET',
        headers: authedHeaders(),
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.ok(Array.isArray(body.organizations));
      assert.ok(body.organizations.some((o: any) => o.id === testOrg));
    });

    it('deletes organization via DELETE /api/settings/orgs/:owner', async () => {
      const env = createMockEnv();
      const req = new Request(`https://worker.dev/api/settings/orgs/${testOrg}`, {
        method: 'DELETE',
        headers: authedHeaders(),
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.deleted, true);

      // Verify 404 after deletion
      const getReq = new Request(`https://worker.dev/api/settings/orgs/${testOrg}`, {
        method: 'GET',
        headers: authedHeaders(),
      });
      const getRes = await worker.fetch(getReq, env);
      assert.equal(getRes.status, 404);
    });
  });

  describe('Repository CRUD (/api/settings/repos)', () => {
    const testOwner = 'calltelemetry';
    const testRepo = 'ct-billing';

    it('enrolls a repository via POST /api/settings/repos', async () => {
      const env = createMockEnv();
      const payload = {
        owner: testOwner,
        repo: testRepo,
        repositoryId: 55443322,
        installationId: 445566,
        defaultBranch: 'main',
        automationEnabled: true,
        passthroughEnabled: true,
        customProfile: 'assertive',
        generateFlowchart: true,
      };

      const req = new Request('https://worker.dev/api/settings/repos', {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify(payload),
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 201);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.repository.id, `${testOwner}/${testRepo}`);
      assert.equal(body.repository.repositoryId, 55443322);
      assert.equal(body.repository.passthroughEnabled, true);
      assert.equal(body.repository.automationEnabled, true);
    });

    it('retrieves the enrolled repository via GET /api/settings/repos/:owner/:repo', async () => {
      const env = createMockEnv();
      const req = new Request(`https://worker.dev/api/settings/repos/${testOwner}/${testRepo}`, {
        method: 'GET',
        headers: authedHeaders(),
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.repository.id, `${testOwner}/${testRepo}`);
      assert.equal(body.repository.repositoryId, 55443322);
    });

    it('updates repository configuration via PATCH /api/settings/repos/:owner/:repo', async () => {
      const env = createMockEnv();
      const req = new Request(`https://worker.dev/api/settings/repos/${testOwner}/${testRepo}`, {
        method: 'PATCH',
        headers: authedHeaders(),
        body: JSON.stringify({
          customProfile: 'chill',
          generateFlowchart: false,
        }),
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.repository.customProfile, 'chill');
      assert.equal(body.repository.generateFlowchart, false);
      assert.equal(body.repository.repositoryId, 55443322); // Preserves existing fields
    });

    it('lists repositories with filters via GET /api/settings/repos', async () => {
      const env = createMockEnv();
      const req = new Request(`https://worker.dev/api/settings/repos?owner=${testOwner}&passthroughOnly=true`, {
        method: 'GET',
        headers: authedHeaders(),
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.ok(Array.isArray(body.repositories));
      assert.ok(body.repositories.some((r: any) => r.id === `${testOwner}/${testRepo}`));
    });

    it('deletes repository via DELETE /api/settings/repos/:owner/:repo', async () => {
      const env = createMockEnv();
      const req = new Request(`https://worker.dev/api/settings/repos/${testOwner}/${testRepo}`, {
        method: 'DELETE',
        headers: authedHeaders(),
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.deleted, true);

      // Verify 404 after deletion
      const getReq = new Request(`https://worker.dev/api/settings/repos/${testOwner}/${testRepo}`, {
        method: 'GET',
        headers: authedHeaders(),
      });
      const getRes = await worker.fetch(getReq, env);
      assert.equal(getRes.status, 404);
    });
  });

  describe('Bulk Repository Onboarding (/api/settings/repos/bulk)', () => {
    it('onboards multiple repositories in a single request', async () => {
      const env = createMockEnv();
      const payload = {
        repositories: [
          { owner: 'calltelemetry', repo: 'bulk-repo-1', repositoryId: 1001, passthroughEnabled: true },
          { owner: 'calltelemetry', repo: 'bulk-repo-2', repositoryId: 1002, passthroughEnabled: false },
          { owner: 'calltelemetry', repo: 'bulk-repo-3', repositoryId: 1003, passthroughEnabled: true },
        ],
      };

      const req = new Request('https://worker.dev/api/settings/repos/bulk', {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify(payload),
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 201);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.count, 3);

      // Verify enrolled in storage
      const repo1 = inMemoryStore.getRepository('calltelemetry', 'bulk-repo-1');
      assert.ok(repo1);
      assert.equal(repo1.repositoryId, 1001);
      assert.equal(repo1.passthroughEnabled, true);

      const repo2 = inMemoryStore.getRepository('calltelemetry', 'bulk-repo-2');
      assert.ok(repo2);
      assert.equal(repo2.repositoryId, 1002);
      assert.equal(repo2.passthroughEnabled, false);
    });
  });

  describe('MCP Tools for Settings Management', () => {
    it('executes review_yeti_onboard_organization tool via JSON-RPC', async () => {
      const env = createMockEnv();
      const rpcReq: any = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'review_yeti_onboard_organization',
          arguments: {
            org: 'mcp-test-org',
            displayName: 'MCP Test Organization',
            defaultProfile: 'chill',
            passthroughDefault: true,
          },
        },
      };

      const req = new Request('https://worker.dev/api/mcp', {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify(rpcReq),
      });

      const res = await defaultMcpRouter.handleHttpRequest(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.jsonrpc, '2.0');
      assert.ok(!body.error);
      assert.ok(body.result);
      const textItem = body.result.content?.find((c: any) => c.text?.includes('Organization Onboarded'));
      assert.ok(textItem);
    });

    it('executes review_yeti_onboard_repository tool via JSON-RPC', async () => {
      const env = createMockEnv();
      const rpcReq: any = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'review_yeti_onboard_repository',
          arguments: {
            owner: 'calltelemetry',
            repo: 'mcp-managed-repo',
            repositoryId: 77889900,
            passthroughEnabled: true,
            customProfile: 'balanced',
          },
        },
      };

      const req = new Request('https://worker.dev/api/mcp', {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify(rpcReq),
      });

      const res = await defaultMcpRouter.handleHttpRequest(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.jsonrpc, '2.0');
      assert.ok(!body.error);
      const textItem = body.result.content?.find((c: any) => c.text?.includes('Repository Onboarded'));
      assert.ok(textItem);

      const saved = inMemoryStore.getRepository('calltelemetry', 'mcp-managed-repo');
      assert.ok(saved);
      assert.equal(saved.repositoryId, 77889900);
      assert.equal(saved.customProfile, 'balanced');
    });

    it('executes review_yeti_update_repository_settings tool via JSON-RPC', async () => {
      const env = createMockEnv();
      const rpcReq: any = {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'review_yeti_update_repository_settings',
          arguments: {
            owner: 'calltelemetry',
            repo: 'mcp-managed-repo',
            customProfile: 'assertive',
            automationEnabled: false,
          },
        },
      };

      const req = new Request('https://worker.dev/api/mcp', {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify(rpcReq),
      });

      const res = await defaultMcpRouter.handleHttpRequest(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.jsonrpc, '2.0');
      assert.ok(!body.error);

      const updated = inMemoryStore.getRepository('calltelemetry', 'mcp-managed-repo');
      assert.ok(updated);
      assert.equal(updated.customProfile, 'assertive');
      assert.equal(updated.automationEnabled, false);
      assert.equal(updated.repositoryId, 77889900); // Preserved
    });

    it('executes review_yeti_sync_github_installation tool via JSON-RPC', async () => {
      const env = createMockEnv();
      const rpcReq: any = {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'review_yeti_sync_github_installation',
          arguments: {
            installationId: 667788,
            organization: 'mcp-synced-org',
            organizationName: 'MCP Synced Org Inc',
            repositories: ['mcp-synced-org/repo-alpha', 'mcp-synced-org/repo-beta'],
            passthroughEnabled: true,
            customProfile: 'assertive',
          },
        },
      };

      const req = new Request('https://worker.dev/api/mcp', {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify(rpcReq),
      });

      const res = await defaultMcpRouter.handleHttpRequest(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.jsonrpc, '2.0');
      assert.ok(!body.error);
      const textItem = body.result.content?.find((c: any) => c.text?.includes('GitHub Installation Synced'));
      assert.ok(textItem);

      const org = inMemoryStore.getOrganization('mcp-synced-org');
      assert.ok(org);
      assert.equal(org.installationId, 667788);

      const repo = inMemoryStore.getRepository('mcp-synced-org', 'repo-alpha');
      assert.ok(repo);
      assert.equal(repo.passthroughEnabled, true);
    });

    it('executes review_yeti_get_onboarding_status tool via JSON-RPC', async () => {
      const env = createMockEnv();
      const rpcReq: any = {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'review_yeti_get_onboarding_status',
          arguments: {},
        },
      };

      const req = new Request('https://worker.dev/api/mcp', {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify(rpcReq),
      });

      const res = await defaultMcpRouter.handleHttpRequest(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.jsonrpc, '2.0');
      assert.ok(!body.error);
      const textItem = body.result.content?.find((c: any) => c.text?.includes('Review Yeti Onboarding Status'));
      assert.ok(textItem);
      const jsonItem = body.result.content?.find((c: any) => {
        try {
          const parsed = JSON.parse(c.text);
          return parsed.ok && typeof parsed.totalOrganizations === 'number';
        } catch {
          return false;
        }
      });
      assert.ok(jsonItem);
    });

    it('executes review_yeti_list_repositories tool via JSON-RPC with filter', async () => {
      const env = createMockEnv();
      const rpcReq: any = {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'review_yeti_list_repositories',
          arguments: {
            owner: 'mcp-synced-org',
            passthroughOnly: true,
          },
        },
      };

      const req = new Request('https://worker.dev/api/mcp', {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify(rpcReq),
      });

      const res = await defaultMcpRouter.handleHttpRequest(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.jsonrpc, '2.0');
      assert.ok(!body.error);
      const jsonItem = body.result.content?.find((c: any) => {
        try {
          const parsed = JSON.parse(c.text);
          return parsed.ok && Array.isArray(parsed.repositories);
        } catch {
          return false;
        }
      });
      assert.ok(jsonItem);
      const data = JSON.parse(jsonItem.text);
      assert.ok(data.count >= 2);
      assert.ok(data.repositories.every((r: any) => r.owner === 'mcp-synced-org' && r.passthroughEnabled));
    });
  });

  describe('GitHub Installation Onboarding & Sync (/api/settings/github/*)', () => {
    it('GET /api/settings/github/install-url returns public install URL without authentication', async () => {
      const env = { ...createMockEnv(), GITHUB_APP_SLUG: 'review-yeti-test-app' };
      const req = new Request('https://worker.dev/api/settings/github/install-url', {
        method: 'GET',
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.success, true);
      assert.equal(data.slug, 'review-yeti-test-app');
      assert.equal(data.url, 'https://github.com/apps/review-yeti-test-app/installations/new');
    });

    it('POST /api/settings/github/installations/:id/sync syncs organization and repos', async () => {
      const env = createMockEnv();
      const payload = {
        organization: 'acme-corp',
        organizationName: 'ACME Corporation',
        repositories: [
          { id: 991122, name: 'api-gateway', full_name: 'acme-corp/api-gateway', default_branch: 'main' },
          { id: 991123, name: 'auth-service', full_name: 'acme-corp/auth-service', default_branch: 'develop' },
        ],
      };

      const req = new Request('https://worker.dev/api/settings/github/installations/554433/sync', {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify(payload),
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.success, true);
      assert.equal(data.organization.id, 'acme-corp');
      assert.equal(data.organization.installationId, 554433);
      assert.equal(data.count, 2);

      const repo1 = inMemoryStore.getRepository('acme-corp', 'api-gateway');
      assert.ok(repo1);
      assert.equal(repo1.repositoryId, 991122);
      assert.equal(repo1.passthroughEnabled, true);
      assert.equal(repo1.automationEnabled, true);

      const repo2 = inMemoryStore.getRepository('acme-corp', 'auth-service');
      assert.ok(repo2);
      assert.equal(repo2.defaultBranch, 'develop');
    });

    it('GET /api/settings/github/installations/:id retrieves synced installation from D1', async () => {
      const env = createMockEnv();
      const req = new Request('https://worker.dev/api/settings/github/installations/554433', {
        method: 'GET',
        headers: authedHeaders(),
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.success, true);
      assert.equal(data.organization.id, 'acme-corp');
      assert.equal(data.repositories.length, 2);
    });
  });

  describe('GitHub Webhook Installation Auto-Enrollment', () => {
    const WEBHOOK_SECRET = 'whsec_test_secret_12345';

    async function signedWebhookRequest(event: string, payload: any, env: any): Promise<Response> {
      const body = JSON.stringify(payload);
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(WEBHOOK_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sigBytes = await crypto.subtle.sign('HMAC', key, enc.encode(body));
      const hex = Array.from(new Uint8Array(sigBytes))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const req = new Request('https://worker.dev/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': event,
          'X-Hub-Signature-256': `sha256=${hex}`,
        },
        body,
      });

      return await worker.fetch(req, {
        ...env,
        GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      });
    }

    it('auto-registers organization and repos on installation.created event', async () => {
      const env = createMockEnv();
      const payload = {
        action: 'created',
        installation: {
          id: 771122,
          app_id: 4385771,
          account: {
            login: 'auto-enrolled-org',
            name: 'Auto Enrolled Org',
          },
        },
        repositories: [
          { id: 11223344, name: 'core-api', full_name: 'auto-enrolled-org/core-api' },
        ],
      };

      const res = await signedWebhookRequest('installation', payload, env);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'processed_installation');
      assert.equal(data.organization, 'auto-enrolled-org');
      assert.equal(data.repositoriesCount, 1);

      const org = inMemoryStore.getOrganization('auto-enrolled-org');
      assert.ok(org);
      assert.equal(org.enabled, true);
      assert.equal(org.installationId, 771122);

      const repo = inMemoryStore.getRepository('auto-enrolled-org', 'core-api');
      assert.ok(repo);
      assert.equal(repo.passthroughEnabled, true);
      assert.equal(repo.automationEnabled, true);
    });

    it('disables organization on installation.deleted event', async () => {
      const env = createMockEnv();
      const payload = {
        action: 'deleted',
        installation: {
          id: 771122,
          account: {
            login: 'auto-enrolled-org',
          },
        },
      };

      const res = await signedWebhookRequest('installation', payload, env);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'processed_installation');
      assert.equal(data.action, 'deleted');

      const org = inMemoryStore.getOrganization('auto-enrolled-org');
      assert.ok(org);
      assert.equal(org.enabled, false);
      assert.equal(org.passthroughEnabled, false);
    });

    it('auto-registers repos on installation_repositories.added event', async () => {
      const env = createMockEnv();
      const payload = {
        action: 'added',
        installation: {
          id: 771122,
          account: {
            login: 'auto-enrolled-org',
          },
        },
        repositories_added: [
          { id: 556677, name: 'extra-service', full_name: 'auto-enrolled-org/extra-service' },
        ],
      };

      const res = await signedWebhookRequest('installation_repositories', payload, env);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'processed_installation_repositories');
      assert.equal(data.addedCount, 1);

      const repo = inMemoryStore.getRepository('auto-enrolled-org', 'extra-service');
      assert.ok(repo);
      assert.equal(repo.passthroughEnabled, true);
      assert.equal(repo.automationEnabled, true);
    });

    it('pauses repos on installation_repositories.removed event', async () => {
      const env = createMockEnv();
      const payload = {
        action: 'removed',
        installation: {
          id: 771122,
          account: {
            login: 'auto-enrolled-org',
          },
        },
        repositories_removed: [
          { id: 556677, name: 'extra-service', full_name: 'auto-enrolled-org/extra-service' },
        ],
      };

      const res = await signedWebhookRequest('installation_repositories', payload, env);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'processed_installation_repositories');
      assert.equal(data.removedCount, 1);

      const repo = inMemoryStore.getRepository('auto-enrolled-org', 'extra-service');
      assert.ok(repo);
      assert.equal(repo.automationEnabled, false);
      assert.equal(repo.passthroughEnabled, false);
    });
  });
});
