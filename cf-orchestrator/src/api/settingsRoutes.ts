import type { Env } from '../types.js';
import { constantTimeEquals } from '../mcp/mcpRouter.js';
import {
  fetchOrganizationsFromDb,
  fetchOrganizationFromDb,
  saveOrganizationToDb,
  deleteOrganizationFromDb,
  fetchRepositoriesFromDb,
  fetchRepositoryFromDb,
  updateRepositoryInDb,
  deleteRepositoryFromDb,
  type OrganizationRecord,
  type RepositoryRecord,
} from '../storage/d1Client.js';
import { getInstallationToken, signGitHubAppJwt } from '../github/githubAppAuth.js';

function corsHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
  };
}

export function authenticateSettingsRequest(
  request: Request,
  env: Env
): { authorized: boolean; error?: string } {
  const configuredToken = (env.REVIEW_YETI_MCP_AUTH_TOKEN || '').trim();
  if (!configuredToken) {
    return { authorized: false, error: 'Unauthorized: Administrative authentication token not configured' };
  }

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : (request.headers.get('x-api-key') || '').trim();

  if (!token || !constantTimeEquals(token, configuredToken)) {
    return { authorized: false, error: 'Unauthorized: Valid administrative token required' };
  }

  return { authorized: true };
}

async function resolveNumericRepoId(
  env: Env,
  owner: string,
  repo: string,
  installationId?: number
): Promise<number | undefined> {
  try {
    const token = await getInstallationToken(env, owner, repo, installationId);
    if (!token || token.startsWith('ghs_dummy_') || token.startsWith('ghs_ephemeral_')) {
      return undefined;
    }
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'review-yeti-cf-orchestrator',
        Accept: 'application/vnd.github.v3+json',
      },
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      if (typeof data.id === 'number') {
        return data.id;
      }
    }
  } catch {
    // Non-fatal
  }
  return undefined;
}

export async function handleSettingsApi(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Handle CORS pre-flight
  if (request.method === 'OPTIONS' && (path.startsWith('/api/settings') || path.startsWith('/api/auth/github'))) {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (!path.startsWith('/api/settings') && !path.startsWith('/api/auth/github')) {
    return null;
  }

  // Public GitHub App installation URL endpoint (no admin token required)
  if ((path === '/api/settings/github/install-url' || path === '/api/auth/github/install-url') && request.method === 'GET') {
    const appSlug = (env.GITHUB_APP_SLUG || 'review-yeti-bot').trim();
    const installUrl = `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;
    return new Response(
      JSON.stringify({ success: true, slug: appSlug, url: installUrl }),
      { headers: corsHeaders() }
    );
  }

  // Enforce administrative authentication for all other settings endpoints
  const auth = authenticateSettingsRequest(request, env);
  if (!auth.authorized) {
    return new Response(
      JSON.stringify({ success: false, error: auth.error }),
      { status: 401, headers: corsHeaders() }
    );
  }

  // 1. Overall Settings Status
  if (path === '/api/settings/status' && request.method === 'GET') {
    const [orgs, repos] = await Promise.all([
      fetchOrganizationsFromDb(env.DB),
      fetchRepositoriesFromDb(env.DB),
    ]);
    const passthroughRepos = repos.filter((r) => r.passthroughEnabled);
    const activeRepos = repos.filter((r) => r.automationEnabled);

    return new Response(
      JSON.stringify({
        success: true,
        status: {
          totalOrganizations: orgs.length,
          totalRepositories: repos.length,
          activeRepositories: activeRepos.length,
          passthroughRepositories: passthroughRepos.length,
          storageBackend: env.DB ? 'd1' : 'in-memory',
        },
      }),
      { headers: corsHeaders() }
    );
  }

  // 2. Organization Routes
  // GET /api/settings/orgs, POST /api/settings/orgs
  if (path === '/api/settings/orgs') {
    if (request.method === 'GET') {
      const orgs = await fetchOrganizationsFromDb(env.DB);
      return new Response(
        JSON.stringify({ success: true, organizations: orgs, count: orgs.length }),
        { headers: corsHeaders() }
      );
    }

    if (request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as any;
      const owner = (body.owner || body.org || body.id || '').trim();
      if (!owner || !/^[a-zA-Z0-9_-]+$/.test(owner)) {
        return new Response(
          JSON.stringify({ success: false, error: 'Invalid or missing "owner" identifier' }),
          { status: 400, headers: corsHeaders() }
        );
      }

      const name = (body.name || owner).trim();
      const installationId = typeof body.installationId === 'number'
        ? body.installationId
        : (env.GITHUB_APP_INSTALLATION_ID ? parseInt(env.GITHUB_APP_INSTALLATION_ID, 10) : undefined);
      const appId = typeof body.appId === 'number' ? body.appId : 4385771;
      const enabled = body.enabled !== undefined ? Boolean(body.enabled) : true;
      const passthroughEnabled = body.passthroughEnabled !== undefined ? Boolean(body.passthroughEnabled) : true;
      const settingsJson = typeof body.settingsJson === 'object' ? body.settingsJson : {};

      const orgRecord: OrganizationRecord = {
        id: owner.toLowerCase(),
        name,
        installationId,
        appId,
        enabled,
        passthroughEnabled,
        settingsJson,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const saved = await saveOrganizationToDb(env.DB, orgRecord);
      return new Response(
        JSON.stringify({ success: true, organization: saved }),
        { status: 201, headers: corsHeaders() }
      );
    }
  }

  // Sync Organization Repositories from GitHub App: POST /api/settings/orgs/:owner/sync
  const syncMatch = path.match(/^\/api\/settings\/orgs\/([^/]+)\/sync$/);
  if (syncMatch && request.method === 'POST') {
    const owner = syncMatch[1].trim();
    const org = await fetchOrganizationFromDb(env.DB, owner);
    const installationId = org?.installationId || (env.GITHUB_APP_INSTALLATION_ID ? parseInt(env.GITHUB_APP_INSTALLATION_ID, 10) : undefined);

    if (!installationId) {
      return new Response(
        JSON.stringify({ success: false, error: `No installationId configured for organization "${owner}"` }),
        { status: 400, headers: corsHeaders() }
      );
    }

    try {
      const token = await getInstallationToken(env, owner, '', installationId);
      if (!token || token.startsWith('ghs_dummy_') || token.startsWith('ghs_ephemeral_')) {
        return new Response(
          JSON.stringify({ success: false, error: 'Unable to mint authentic GitHub App installation token for sync' }),
          { status: 502, headers: corsHeaders() }
        );
      }

      const ghRes = await fetch('https://api.github.com/installation/repositories?per_page=100', {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'review-yeti-cf-orchestrator',
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!ghRes.ok) {
        return new Response(
          JSON.stringify({ success: false, error: `GitHub installation/repositories failed: HTTP ${ghRes.status}` }),
          { status: 502, headers: corsHeaders() }
        );
      }

      const ghData = (await ghRes.json()) as any;
      const ghRepos: any[] = Array.isArray(ghData.repositories) ? ghData.repositories : [];
      const synced: RepositoryRecord[] = [];

      for (const r of ghRepos) {
        const rOwner = r.owner?.login || owner;
        const rRepo = r.name;
        const saved = await updateRepositoryInDb(env.DB, rOwner, rRepo, {
          repositoryId: r.id,
          installationId,
          defaultBranch: r.default_branch || 'main',
          automationEnabled: true,
          passthroughEnabled: org ? org.passthroughEnabled : true,
          generateFlowchart: true,
          customProfile: 'assertive',
        });
        synced.push(saved);
      }

      return new Response(
        JSON.stringify({ success: true, count: synced.length, repositories: synced }),
        { headers: corsHeaders() }
      );
    } catch (err: any) {
      return new Response(
        JSON.stringify({ success: false, error: err?.message || String(err) }),
        { status: 500, headers: corsHeaders() }
      );
    }
  }

  // GET/PATCH/DELETE /api/settings/orgs/:owner
  const orgMatch = path.match(/^\/api\/settings\/orgs\/([^/]+)$/);
  if (orgMatch) {
    const owner = orgMatch[1].trim();

    if (request.method === 'GET') {
      const org = await fetchOrganizationFromDb(env.DB, owner);
      if (!org) {
        return new Response(
          JSON.stringify({ success: false, error: `Organization "${owner}" not found` }),
          { status: 404, headers: corsHeaders() }
        );
      }
      return new Response(
        JSON.stringify({ success: true, organization: org }),
        { headers: corsHeaders() }
      );
    }

    if (request.method === 'PATCH') {
      const existing = await fetchOrganizationFromDb(env.DB, owner);
      if (!existing) {
        return new Response(
          JSON.stringify({ success: false, error: `Organization "${owner}" not found` }),
          { status: 404, headers: corsHeaders() }
        );
      }

      const body = (await request.json().catch(() => ({}))) as any;
      const updated: OrganizationRecord = {
        ...existing,
        name: body.name !== undefined ? String(body.name).trim() : existing.name,
        installationId: body.installationId !== undefined ? Number(body.installationId) : existing.installationId,
        appId: body.appId !== undefined ? Number(body.appId) : existing.appId,
        enabled: body.enabled !== undefined ? Boolean(body.enabled) : existing.enabled,
        passthroughEnabled: body.passthroughEnabled !== undefined ? Boolean(body.passthroughEnabled) : existing.passthroughEnabled,
        settingsJson: body.settingsJson !== undefined ? body.settingsJson : existing.settingsJson,
        updatedAt: Date.now(),
      };

      const saved = await saveOrganizationToDb(env.DB, updated);
      return new Response(
        JSON.stringify({ success: true, organization: saved }),
        { headers: corsHeaders() }
      );
    }

    if (request.method === 'DELETE') {
      const cascade = url.searchParams.get('cascade') === 'true';
      const result = await deleteOrganizationFromDb(env.DB, owner, cascade);
      return new Response(
        JSON.stringify({ success: true, deleted: result.deleted, deletedReposCount: result.deletedReposCount }),
        { headers: corsHeaders() }
      );
    }
  }

  // 3. Repository Bulk Onboard: POST /api/settings/repos/bulk
  if (path === '/api/settings/repos/bulk' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as any;
    const repoList: any[] = Array.isArray(body.repositories) ? body.repositories : [];
    if (repoList.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Expected non-empty "repositories" array' }),
        { status: 400, headers: corsHeaders() }
      );
    }

    const savedList: RepositoryRecord[] = [];
    for (const item of repoList) {
      const owner = (item.owner || (item.id ? item.id.split('/')[0] : '')).trim();
      const repo = (item.repo || (item.id ? item.id.split('/')[1] : '')).trim();
      if (!owner || !repo) continue;

      let repositoryId = typeof item.repositoryId === 'number' ? item.repositoryId : undefined;
      let installationId = typeof item.installationId === 'number' ? item.installationId : undefined;

      if (!repositoryId) {
        repositoryId = await resolveNumericRepoId(env, owner, repo, installationId);
      }
      if (!installationId) {
        const org = await fetchOrganizationFromDb(env.DB, owner);
        if (org?.installationId) installationId = org.installationId;
      }

      const saved = await updateRepositoryInDb(env.DB, owner, repo, {
        repositoryId,
        installationId,
        defaultBranch: item.defaultBranch || 'main',
        automationEnabled: item.automationEnabled !== undefined ? Boolean(item.automationEnabled) : true,
        passthroughEnabled: item.passthroughEnabled !== undefined ? Boolean(item.passthroughEnabled) : true,
        generateFlowchart: item.generateFlowchart !== undefined ? Boolean(item.generateFlowchart) : true,
        customProfile: item.customProfile || 'assertive',
        settingsJson: typeof item.settingsJson === 'object' ? item.settingsJson : {},
      });
      savedList.push(saved);
    }

    return new Response(
      JSON.stringify({ success: true, count: savedList.length, repositories: savedList }),
      { status: 201, headers: corsHeaders() }
    );
  }

  // 4. Repository Routes
  // GET /api/settings/repos, POST /api/settings/repos
  if (path === '/api/settings/repos') {
    if (request.method === 'GET') {
      const ownerFilter = url.searchParams.get('owner') || undefined;
      const enabledOnly = url.searchParams.get('enabled') === 'true';
      const passthroughOnly = url.searchParams.get('passthrough') === 'true';

      const repos = await fetchRepositoriesFromDb(env.DB, {
        owner: ownerFilter,
        enabledOnly,
        passthroughOnly,
      });

      return new Response(
        JSON.stringify({ success: true, repositories: repos, count: repos.length }),
        { headers: corsHeaders() }
      );
    }

    if (request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as any;
      const owner = (body.owner || (body.id ? body.id.split('/')[0] : '')).trim();
      const repo = (body.repo || (body.id ? body.id.split('/')[1] : '')).trim();

      if (!owner || !repo) {
        return new Response(
          JSON.stringify({ success: false, error: 'Missing required "owner" and "repo" parameters' }),
          { status: 400, headers: corsHeaders() }
        );
      }

      let repositoryId = typeof body.repositoryId === 'number' ? body.repositoryId : undefined;
      let installationId = typeof body.installationId === 'number' ? body.installationId : undefined;

      // Auto-resolve numeric repositoryId via GitHub API if omitted
      if (!repositoryId) {
        repositoryId = await resolveNumericRepoId(env, owner, repo, installationId);
      }

      // Inherit installationId from parent organization if omitted
      if (!installationId) {
        const org = await fetchOrganizationFromDb(env.DB, owner);
        if (org?.installationId) {
          installationId = org.installationId;
        }
      }

      const saved = await updateRepositoryInDb(env.DB, owner, repo, {
        repositoryId,
        installationId,
        defaultBranch: body.defaultBranch || 'main',
        automationEnabled: body.automationEnabled !== undefined ? Boolean(body.automationEnabled) : true,
        passthroughEnabled: body.passthroughEnabled !== undefined ? Boolean(body.passthroughEnabled) : true,
        generateFlowchart: body.generateFlowchart !== undefined ? Boolean(body.generateFlowchart) : true,
        customProfile: body.customProfile || 'assertive',
        settingsJson: typeof body.settingsJson === 'object' ? body.settingsJson : {},
      });

      return new Response(
        JSON.stringify({ success: true, repository: saved }),
        { status: 201, headers: corsHeaders() }
      );
    }
  }

  // GET/PATCH/DELETE /api/settings/repos/:owner/:repo
  const repoMatch = path.match(/^\/api\/settings\/repos\/([^/]+)\/([^/]+)$/);
  if (repoMatch) {
    const owner = repoMatch[1].trim();
    const repo = repoMatch[2].trim();

    if (request.method === 'GET') {
      const r = await fetchRepositoryFromDb(env.DB, owner, repo);
      if (!r) {
        return new Response(
          JSON.stringify({ success: false, error: `Repository "${owner}/${repo}" not found` }),
          { status: 404, headers: corsHeaders() }
        );
      }
      return new Response(
        JSON.stringify({ success: true, repository: r }),
        { headers: corsHeaders() }
      );
    }

    if (request.method === 'PATCH') {
      const existing = await fetchRepositoryFromDb(env.DB, owner, repo);
      if (!existing) {
        return new Response(
          JSON.stringify({ success: false, error: `Repository "${owner}/${repo}" not found` }),
          { status: 404, headers: corsHeaders() }
        );
      }

      const body = (await request.json().catch(() => ({}))) as any;
      const patch: Partial<RepositoryRecord> = {};

      if (body.repositoryId !== undefined) patch.repositoryId = Number(body.repositoryId);
      if (body.installationId !== undefined) patch.installationId = Number(body.installationId);
      if (body.defaultBranch !== undefined) patch.defaultBranch = String(body.defaultBranch);
      if (body.automationEnabled !== undefined) patch.automationEnabled = Boolean(body.automationEnabled);
      if (body.passthroughEnabled !== undefined) patch.passthroughEnabled = Boolean(body.passthroughEnabled);
      if (body.generateFlowchart !== undefined) patch.generateFlowchart = Boolean(body.generateFlowchart);
      if (body.customProfile !== undefined) patch.customProfile = body.customProfile;
      if (body.settingsJson !== undefined) patch.settingsJson = body.settingsJson;

      const saved = await updateRepositoryInDb(env.DB, owner, repo, patch);
      return new Response(
        JSON.stringify({ success: true, repository: saved }),
        { headers: corsHeaders() }
      );
    }

    if (request.method === 'DELETE') {
      const deleted = await deleteRepositoryFromDb(env.DB, owner, repo);
      return new Response(
        JSON.stringify({ success: true, deleted }),
        { headers: corsHeaders() }
      );
    }
  }

  // 6. Sync Repositories & Org from GitHub Installation
  const instSyncMatch = path.match(/^\/api\/settings\/github\/installations\/(\d+)\/sync$/);
  if (instSyncMatch && request.method === 'POST') {
    const installationId = parseInt(instSyncMatch[1], 10);
    if (isNaN(installationId) || installationId <= 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Valid positive numeric installationId required' }),
        { status: 400, headers: corsHeaders() }
      );
    }

    let orgLogin = '';
    let orgName = '';
    let repos: Array<{ id: number; name: string; full_name: string; default_branch?: string }> = [];

    // Fetch metadata from GitHub API if credentials exist
    if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
      try {
        const jwt = await signGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
        // Get installation info
        const instRes = await fetch(`https://api.github.com/app/installations/${installationId}`, {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'review-yeti-cf-orchestrator',
          },
        });
        if (instRes.ok) {
          const instData = (await instRes.json()) as any;
          if (instData?.account?.login) {
            orgLogin = String(instData.account.login).toLowerCase();
            orgName = instData.account.name || instData.account.login;
          }
        }

        // Get installation access token to list repositories
        const token = await getInstallationToken(env, '', '', installationId);
        if (token && !token.startsWith('ghs_dummy_') && !token.startsWith('ghs_ephemeral_')) {
          const reposRes = await fetch(`https://api.github.com/installation/repositories?per_page=100`, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github.v3+json',
              'User-Agent': 'review-yeti-cf-orchestrator',
            },
          });
          if (reposRes.ok) {
            const reposData = (await reposRes.json()) as any;
            if (Array.isArray(reposData.repositories)) {
              repos = reposData.repositories;
            }
          }
        }
      } catch {
        // Fallback to request body if supplied
      }
    }

    // Support fallback/manual payload in body if GitHub API could not be reached (e.g. in test environments or offline)
    const body = (await request.json().catch(() => ({}))) as any;
    if (!orgLogin && body.organization) {
      orgLogin = String(body.organization).toLowerCase().trim();
      orgName = body.organizationName || orgLogin;
    }
    if (repos.length === 0 && Array.isArray(body.repositories)) {
      repos = body.repositories.map((r: any) => ({
        id: typeof r.id === 'number' ? r.id : 0,
        name: r.name || (r.full_name ? r.full_name.split('/')[1] : r),
        full_name: r.full_name || (orgLogin ? `${orgLogin}/${r.name || r}` : String(r)),
        default_branch: r.default_branch || 'main',
      }));
    }

    if (!orgLogin) {
      return new Response(
        JSON.stringify({ success: false, error: 'Could not determine organization from GitHub installation or request payload' }),
        { status: 400, headers: corsHeaders() }
      );
    }

    // Upsert Organization in D1
    const savedOrg = await saveOrganizationToDb(env.DB, {
      id: orgLogin,
      name: orgName || orgLogin,
      installationId,
      appId: env.GITHUB_APP_ID ? parseInt(env.GITHUB_APP_ID, 10) : 4385771,
      enabled: true,
      passthroughEnabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Upsert Repositories in D1
    const savedRepos: RepositoryRecord[] = [];
    for (const r of repos) {
      const parts = r.full_name.split('/');
      const owner = (parts[0] || orgLogin).toLowerCase();
      const repoName = parts[1] || r.name;
      const saved = await updateRepositoryInDb(env.DB, owner, repoName, {
        repositoryId: r.id || undefined,
        installationId,
        defaultBranch: r.default_branch || 'main',
        automationEnabled: true,
        passthroughEnabled: true,
      });
      savedRepos.push(saved);
    }

    return new Response(
      JSON.stringify({
        success: true,
        organization: savedOrg,
        repositories: savedRepos,
        count: savedRepos.length,
      }),
      { headers: corsHeaders() }
    );
  }

  // 7. Get Synced Installation details from D1
  const getInstMatch = path.match(/^\/api\/settings\/github\/installations\/(\d+)$/);
  if (getInstMatch && request.method === 'GET') {
    const installationId = parseInt(getInstMatch[1], 10);
    const [allOrgs, allRepos] = await Promise.all([
      fetchOrganizationsFromDb(env.DB),
      fetchRepositoriesFromDb(env.DB),
    ]);

    const org = allOrgs.find((o) => o.installationId === installationId);
    const repos = allRepos.filter((r) => r.installationId === installationId);

    if (!org && repos.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: `No organization or repositories found for installation ${installationId}` }),
        { status: 404, headers: corsHeaders() }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        organization: org || null,
        repositories: repos,
        count: repos.length,
      }),
      { headers: corsHeaders() }
    );
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders() });
}
