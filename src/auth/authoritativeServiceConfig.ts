import { z } from 'zod';
import type { GitHubActionsOidcPolicy } from './githubActionsOidc';
import { reviewPolicySourceSchema } from '../review/authoritativeReviewIdentity';

export const AUTHORITATIVE_REVIEW_APP_ID = 4385771;

const name = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u)
  .refine((value) => value !== '.' && value !== '..');
const sourceSchema = z.object({
  repositoryId: reviewPolicySourceSchema.shape.repositoryId,
  owner: name, repo: name,
  ref: z.string().min(1).max(256).regex(/^[^\u0000-\u0020\u007f]+$/u),
  path: reviewPolicySourceSchema.shape.path,
}).strict();

export interface AuthoritativeServiceConfig {
  expectedAppId: number;
  admissionEnabled: boolean;
  repositoryIds: number[];
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
    const sourceJson = env.AUTHORITATIVE_REVIEW_POLICY_SOURCE;
    if (typeof sourceJson !== 'string' || Buffer.byteLength(sourceJson, 'utf8') > 8_192) throw new Error();
    const source = sourceSchema.parse(JSON.parse(sourceJson));
    reviewPolicySourceSchema.shape.repository.parse(`${source.owner}/${source.repo}`);
    const baseUrl = z.string().min(1).max(2_000).url().parse(env.BIFROST_BASE_URL);
    const url = new URL(baseUrl);
    if (baseUrl.trim() !== baseUrl || /[\u0000-\u0020\u007f\\?#]/u.test(baseUrl)
      || url.protocol !== 'https:' || url.username || url.password) throw new Error();
    const model = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u).parse(env.REVIEW_MODEL);
    if (model.trim() !== model || !model.trim()) throw new Error();
    const tickMs = env.AUTHORITATIVE_REVIEW_TICK_MS === undefined ? 5_000 : integer(env.AUTHORITATIVE_REVIEW_TICK_MS);
    if (tickMs < 1_000 || tickMs > 60_000) throw new Error();
    return {
      expectedAppId, admissionEnabled: admit === 'true', repositoryIds,
      policyRepository: { repositoryId: source.repositoryId, owner: source.owner, repo: source.repo },
      policyRef: source.ref, policyPath: source.path, transport: { baseUrl, model }, tickMs,
    };
  } catch { throw new Error('Authoritative review service configuration is invalid'); }
}
