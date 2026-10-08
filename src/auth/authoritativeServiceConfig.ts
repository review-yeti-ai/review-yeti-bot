import { z } from 'zod';
import type { ActionDispatchConfig } from '../config/actionDispatchConfig';
import {
  PUBLIC_REVIEW_REPOSITORY,
  PUBLIC_REVIEW_REPOSITORY_ID,
  PUBLIC_REVIEW_APP_ID,
  QUALIFICATION_REVIEW_REPOSITORY,
  QUALIFICATION_REVIEW_REPOSITORY_ID,
} from '../config/repositoryReviewAuthorityConstants';
import type { GitHubActionsOidcPolicy } from './githubActionsOidc';
import { reviewPolicySourceSchema } from '../review/authoritativeReviewIdentity';
import { AUTHORITATIVE_REVIEW_APP_ID } from './authoritativeServiceIdentity';
export { AUTHORITATIVE_REVIEW_APP_ID } from './authoritativeServiceIdentity';

const name = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u)
  .refine((value) => value !== '.' && value !== '..');
const sourceSchema = z.object({
  repositoryId: reviewPolicySourceSchema.shape.repositoryId,
  owner: name, repo: name,
  ref: z.string().min(1).max(256).regex(/^[^\u0000-\u0020\u007f]+$/u),
  path: reviewPolicySourceSchema.shape.path,
}).strict();
const repositoryIdentitySchema = z.object({
  repositoryId: reviewPolicySourceSchema.shape.repositoryId,
  owner: name,
  repo: name,
}).strict();

export interface AuthoritativeServiceConfig {
  expectedAppId: number;
  admissionEnabled: boolean;
  /** Present only for the separately deployed qualification service instance. */
  qualificationInstance?: true;
  /** Digest derived from the service-owned worker image reference. */
  qualificationRuntimeImageDigest?: string;
  repositoryIds: number[];
  /** Optional name-to-ID bindings for authenticated transports that carry no repository ID. */
  repositoryIdentities?: Array<{ repositoryId: number; owner: string; repo: string }>;
  publicRepository?: { repositoryId: number; owner: string; repo: string; expectedAppId: number };
  policyRepository: { repositoryId: number; owner: string; repo: string };
  policyRef: string;
  policyPath: string;
  transport: { baseUrl: string; model: string };
  tickMs: number;
}

function integer(value: string | undefined): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) throw new Error();
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error();
  return result;
}

/** Pure startup parsing: explicit pilot opt-in and no credentials, provider
 * defaults, repository fallbacks, process-env reads or runtime activation. */
export function authoritativeServiceConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  oidcPolicy: Pick<GitHubActionsOidcPolicy, 'allowAppGate' | 'repositoryIds'>,
  dispatchConfig: Pick<ActionDispatchConfig,
    'passthroughEnabled' | 'qualificationInstance' | 'qualificationRuntimeImageDigest'
    | 'centralExternalRepositories' | 'centralExternalAppCredentials'>,
): AuthoritativeServiceConfig | undefined {
  try {
    const enabled = env.AUTHORITATIVE_REVIEW_ENABLED;
    if (enabled === undefined || enabled === 'false') return undefined;
    if (enabled !== 'true' || oidcPolicy.allowAppGate !== true) throw new Error();
    const admit = env.AUTHORITATIVE_REVIEW_ADMISSION_ENABLED;
    if (admit !== undefined && admit !== 'false' && admit !== 'true') throw new Error();
    const expectedAppId = integer(env.AUTHORITATIVE_REVIEW_APP_ID);
    if (expectedAppId !== AUTHORITATIVE_REVIEW_APP_ID || integer(env.GITHUB_APP_ID) !== expectedAppId) throw new Error();
    const rawIds = env.AUTHORITATIVE_REVIEW_REPOSITORY_IDS;
    if (typeof rawIds !== 'string' || rawIds.length > 2_000) throw new Error();
    const repositoryIds = rawIds.split(',').map((id) => integer(id.trim()));
    if (repositoryIds.length < 1 || repositoryIds.length > 100
      || new Set(repositoryIds).size !== repositoryIds.length
      || repositoryIds.some((id) => !oidcPolicy.repositoryIds.has(String(id)))) throw new Error();
    // The primary allowlist cannot accidentally grant the public repository
    // primary-App authority. Its existing dedicated App is an exact opt-in.
    if (repositoryIds.includes(PUBLIC_REVIEW_REPOSITORY_ID)) throw new Error();
    if (dispatchConfig.qualificationInstance && (dispatchConfig.passthroughEnabled
      || admit !== 'true'
      || repositoryIds.length !== 1 || repositoryIds[0] !== QUALIFICATION_REVIEW_REPOSITORY_ID
      || !dispatchConfig.qualificationRuntimeImageDigest)) throw new Error();
    let repositoryIdentities: AuthoritativeServiceConfig['repositoryIdentities'];
    const rawIdentities = env.AUTHORITATIVE_REVIEW_REPOSITORY_IDENTITIES;
    if (rawIdentities !== undefined) {
      if (Buffer.byteLength(rawIdentities, 'utf8') > 8_192) throw new Error();
      const entries = z.array(repositoryIdentitySchema).min(1).max(100).parse(JSON.parse(rawIdentities));
      const ids = new Set<number>();
      const names = new Set<string>();
      for (const entry of entries) {
        const key = `${entry.owner}/${entry.repo}`.toLowerCase();
        if (!repositoryIds.includes(entry.repositoryId) || entry.repositoryId === PUBLIC_REVIEW_REPOSITORY_ID
          || ids.has(entry.repositoryId) || names.has(key)) throw new Error();
        ids.add(entry.repositoryId);
        names.add(key);
      }
      repositoryIdentities = entries;
    }
    let publicRepository: AuthoritativeServiceConfig['publicRepository'];
    const externalRepositories = dispatchConfig.centralExternalRepositories;
    const externalCredentials = dispatchConfig.centralExternalAppCredentials;
    if (dispatchConfig.qualificationInstance) {
      if (externalRepositories.size !== 1
        || externalRepositories.get(QUALIFICATION_REVIEW_REPOSITORY) !== QUALIFICATION_REVIEW_REPOSITORY_ID
        || externalCredentials !== undefined
        || !repositoryIdentities || repositoryIdentities.length !== 1
        || repositoryIdentities[0]!.repositoryId !== QUALIFICATION_REVIEW_REPOSITORY_ID
        || repositoryIdentities[0]!.owner !== 'review-yeti-ai'
        || repositoryIdentities[0]!.repo !== 'review-yeti-qualification') throw new Error();
    } else if (externalRepositories.size > 0) {
      if (externalRepositories.size !== 1
        || externalRepositories.get(PUBLIC_REVIEW_REPOSITORY) !== PUBLIC_REVIEW_REPOSITORY_ID
        || externalCredentials?.appId !== String(PUBLIC_REVIEW_APP_ID)
        || (!externalCredentials.privateKey.trim() && dispatchConfig.passthroughEnabled !== true)) throw new Error();
      const [owner, repo] = PUBLIC_REVIEW_REPOSITORY.split('/');
      publicRepository = { repositoryId: PUBLIC_REVIEW_REPOSITORY_ID, owner, repo, expectedAppId: PUBLIC_REVIEW_APP_ID };
      if (repositoryIds.length >= 100) throw new Error();
    } else if (externalCredentials !== undefined) {
      throw new Error();
    }
    const sourceJson = env.AUTHORITATIVE_REVIEW_POLICY_SOURCE;
    if (typeof sourceJson !== 'string' || Buffer.byteLength(sourceJson, 'utf8') > 8_192) throw new Error();
    const source = sourceSchema.parse(JSON.parse(sourceJson));
    reviewPolicySourceSchema.shape.repository.parse(`${source.owner}/${source.repo}`);
    const rawBaseUrl = env.OPENAI_BASE_URL;
    const baseUrl = z.string().min(1).max(2_000).url().parse(rawBaseUrl);
    const url = new URL(baseUrl);
    if (baseUrl.trim() !== baseUrl || /[\u0000-\u0020\u007f\\?#]/u.test(baseUrl)
      || url.protocol !== 'https:' || url.username || url.password) throw new Error();
    const model = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u).parse(env.REVIEW_MODEL);
    if (model.trim() !== model || !model.trim()) throw new Error();
    const tickMs = env.AUTHORITATIVE_REVIEW_TICK_MS === undefined ? 5_000 : integer(env.AUTHORITATIVE_REVIEW_TICK_MS);
    if (tickMs < 1_000 || tickMs > 60_000) throw new Error();
    return {
      expectedAppId, admissionEnabled: admit === 'true', repositoryIds,
      ...(dispatchConfig.qualificationInstance ? { qualificationInstance: true as const } : {}),
      ...(dispatchConfig.qualificationInstance
        ? { qualificationRuntimeImageDigest: dispatchConfig.qualificationRuntimeImageDigest! } : {}),
      ...(repositoryIdentities ? { repositoryIdentities } : {}),
      ...(publicRepository ? { publicRepository } : {}),
      policyRepository: { repositoryId: source.repositoryId, owner: source.owner, repo: source.repo },
      policyRef: source.ref, policyPath: source.path, transport: { baseUrl, model }, tickMs,
    };
  } catch { throw new Error('Authoritative review service configuration is invalid'); }
}
