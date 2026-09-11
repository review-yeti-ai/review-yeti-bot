import { z } from 'zod';
import { generateGitHubAppJwt, type InstallationTokenResult } from './appAuth';
import { BoundedCiTransport, ciUnavailable, type CiTransportOptions } from './boundedCiTransport';
import { ciRepositorySchema, REVIEW_CI_APP_ID, type CiRepository } from './reviewCiClient';

export type CiTokenPurpose = 'repository-dispatch' | 'workflow-dispatch' | 'check-publication' | 'read';
const permissionsFor: Record<CiTokenPurpose, Record<string, 'read' | 'write'>> = {
  'repository-dispatch': { contents: 'write' },
  'workflow-dispatch': { actions: 'write' },
  'check-publication': { checks: 'write' },
  // Admission reads both current candidate truth and the published App-owned gate.
  read: { actions: 'read', contents: 'read', pull_requests: 'read', checks: 'read' },
};

/** Separate CI-only capability. Never widen the existing review read/check
 * minters. The service supplies the exact configured repository and purpose;
 * neither event data nor a worker selects permissions or the App identity. */
export async function getBoundedCiRepositoryToken(config: {
  appId: string; privateKey: string; repository: CiRepository; baseUrl?: string;
}, purpose: CiTokenPurpose, options: Omit<CiTransportOptions, 'baseUrl'> & { signal?: AbortSignal } = {}): Promise<InstallationTokenResult> {
  try {
    if (config.appId !== String(REVIEW_CI_APP_ID) || typeof config.privateKey !== 'string' || !config.privateKey
      || !Object.hasOwn(permissionsFor, purpose)) throw ciUnavailable();
    const repository = ciRepositorySchema.parse(config.repository);
    const permissions = permissionsFor[purpose];
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10_000) throw ciUnavailable();
    const transport = new BoundedCiTransport({ ...options, baseUrl: config.baseUrl, timeoutMs });
    return await transport.run(async (request) => {
      const route = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
      const jwt = generateGitHubAppJwt(config.appId, config.privateKey);
      const installationReply = await request(`${route}/installation`, jwt, 'GET', undefined, 64 * 1024);
      if (installationReply.status !== 200) throw ciUnavailable();
      const installation = z.object({ id: z.number().int().positive().safe(), app_id: z.literal(REVIEW_CI_APP_ID) }).parse(installationReply.data);
      const minted = await request(`/app/installations/${installation.id}/access_tokens`, jwt, 'POST', {
        repository_ids: [repository.repositoryId], permissions,
      }, 64 * 1024);
      if (minted.status !== 201) throw ciUnavailable();
      const result = z.object({ token: z.string().max(512).regex(/^ghs_[A-Za-z0-9_]+$/u),
        expires_at: z.string().datetime({ offset: true }), permissions: z.record(z.string()) }).parse(minted.data);
      if (Date.parse(result.expires_at) <= Date.now()
        || Object.entries(permissions).some(([key, value]) => result.permissions[key] !== value)
        || Object.entries(result.permissions).some(([key, value]) => key === 'metadata' ? value !== 'read' : permissions[key] !== value)) throw ciUnavailable();
      // Installation IDs are not repository IDs. Verify the granted numeric
      // repository still resolves to its configured name before returning it.
      const repoReply = await request(route, result.token, 'GET', undefined, 64 * 1024);
      if (repoReply.status !== 200) throw ciUnavailable();
      const actual = z.object({ id: z.number().int().positive().safe(), full_name: z.string() }).parse(repoReply.data);
      if (actual.id !== repository.repositoryId || actual.full_name !== `${repository.owner}/${repository.repo}`) throw ciUnavailable();
      return { token: result.token, expiresAt: result.expires_at, permissions: result.permissions };
    }, options.signal);
  } catch { throw new Error('Repository CI App token is unavailable'); }
}
