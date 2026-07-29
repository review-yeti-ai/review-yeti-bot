import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchPersonas,
  updatePersona,
  fetchOverviewStats,
  fetchReviewLogs,
  fetchRepositories,
  updateRepository,
  fetchGitHubAppConfig,
  updateGitHubAppConfig,
  runOnboardingScan,
} from '@/lib/api-client';

describe('API Client Utility Module Unit Tests', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetchPersonas requests GET /api/dashboard/personas and returns personas object', async () => {
    const mockPersonas = {
      security: { id: 'security', displayName: 'Security', enabled: true },
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: true, personas: mockPersonas }),
    });

    const result = await fetchPersonas();
    expect(global.fetch).toHaveBeenCalledWith('/api/dashboard/personas', expect.any(Object));
    expect(result).toEqual(mockPersonas);
  });

  it('updatePersona sends PUT request with JSON payload', async () => {
    const mockUpdated = { id: 'security', displayName: 'Security', enabled: true, customPrompt: 'New prompt' };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: true, persona: mockUpdated }),
    });

    const result = await updatePersona('security', { customPrompt: 'New prompt' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dashboard/personas/security',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ customPrompt: 'New prompt' }),
      })
    );
    expect(result).toEqual(mockUpdated);
  });

  it('fetchOverviewStats requests GET /api/dashboard/overview', async () => {
    const mockOverview = { totalReviewsExecuted: 42, activeAutomations: 2 };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: true, overview: mockOverview }),
    });

    const result = await fetchOverviewStats();
    expect(result).toEqual(mockOverview);
  });

  it('fetchRepositories requests GET /api/dashboard/repositories', async () => {
    const mockRepos = [{ owner: 'calltelemetry', repo: 'cisco-cdr', automationEnabled: true }];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: true, repositories: mockRepos }),
    });

    const result = await fetchRepositories();
    expect(result).toEqual(mockRepos);
  });

  it('updateRepository sends PATCH request to target owner/repo endpoint', async () => {
    const mockRepo = { owner: 'calltelemetry', repo: 'cisco-cdr', automationEnabled: false };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: true, repository: mockRepo }),
    });

    const result = await updateRepository('calltelemetry', 'cisco-cdr', { automationEnabled: false });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dashboard/repositories/calltelemetry/cisco-cdr',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ automationEnabled: false }),
      })
    );
    expect(result).toEqual(mockRepo);
  });

  it('throws an Error when fetch response is not ok or success is false', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: false, error: 'Invalid payload' }),
    });

    await expect(fetchPersonas()).rejects.toThrow('Invalid payload');
  });

  it('runOnboardingScan sends POST request to /api/onboarding/wizard', async () => {
    const mockResult = { repoPath: '/test/repo', valid: true, detectedPersonas: ['security'] };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: true, result: mockResult }),
    });

    const res = await runOnboardingScan('/test/repo');
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/onboarding/wizard',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ repoPath: '/test/repo' }),
      })
    );
    expect(res).toEqual(mockResult);
  });
});
