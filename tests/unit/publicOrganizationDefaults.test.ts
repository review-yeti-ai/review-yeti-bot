import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createGitHubAppApiRouter } from '../../src/api/githubAppApi';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { fetchGitHubAppConfig, updateGitHubAppConfig } from '../../src/lib/api-client';

const emptyConfig = { appId: '', installationId: '', webhookSecretConfigured: false, privateKeyConfigured: false, status: 'unconfigured' as const, updatedAt: '' };

describe('public organization defaults', () => {
  let app: express.Express;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/github', createGitHubAppApiRouter());
    vi.spyOn(dashboardStore, 'getGitHubAppConfig').mockReturnValue(emptyConfig);
    vi.spyOn(dashboardStore, 'getRepositories').mockReturnValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns no organization or installation for a brand-new store', async () => {
    const response = await request(app).get('/api/github/orgs');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, organizations: [] });
  });

  it('preserves configured owners and installation IDs rather than renaming real tenants', async () => {
    vi.mocked(dashboardStore.getGitHubAppConfig).mockReturnValue({ ...emptyConfig, installationId: '9002' });
    vi.mocked(dashboardStore.getRepositories).mockReturnValue([{ owner: 'OperatorOrg', repo: 'service', automationEnabled: true, customProfile: 'balanced', updatedAt: '' }]);
    const response = await request(app).get('/api/github/orgs');
    expect(response.body.organizations).toEqual([expect.objectContaining({ login: 'OperatorOrg', name: 'OperatorOrg', installationId: 9002, monitoredCount: 1, totalReposCount: 1 })]);
  });

  it('does not invent an installation ID for a stored owner', async () => {
    vi.mocked(dashboardStore.getRepositories).mockReturnValue([{ owner: 'operator-org', repo: 'service', automationEnabled: false, customProfile: 'balanced', updatedAt: '' }]);
    const response = await request(app).get('/api/github/orgs');
    expect(response.body.organizations[0].login).toBe('operator-org');
    expect(response.body.organizations[0]).not.toHaveProperty('installationId');
  });

  it('reports discovery failure instead of returning a fabricated organization', async () => {
    vi.mocked(dashboardStore.getRepositories).mockImplementation(() => { throw new Error('unavailable'); });
    const response = await request(app).get('/api/github/orgs');
    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body).not.toHaveProperty('organizations');
  });
});

describe('GitHub App browser response contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([fetchGitHubAppConfig, () => updateGitHubAppConfig({ appId: '9001' })])('accepts the canonical appConfig response', async (loadConfig) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true, appConfig: { ...emptyConfig, appId: '9001' }, config: { ...emptyConfig, appId: 'legacy' } }));
    expect((await loadConfig()).appId).toBe('9001');
  });

  it.each([fetchGitHubAppConfig, () => updateGitHubAppConfig({ appId: '9001' })])('accepts older config responses without replacing explicit configuration', async (loadConfig) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true, config: { ...emptyConfig, appId: '9001' } }));
    expect((await loadConfig()).appId).toBe('9001');
  });

  it.each([fetchGitHubAppConfig, () => updateGitHubAppConfig({ appId: '9001' })])('rejects missing configuration instead of silently returning undefined', async (loadConfig) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true }));
    await expect(loadConfig()).rejects.toThrow('configuration was missing from the response');
  });
});
