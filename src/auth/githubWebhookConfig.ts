import type { GitHubActionsOidcPolicy } from './githubActionsOidc';

/**
 * The canonical env spellings for the GitHub App webhook secret.
 *
 * Owned HERE because this module is where webhook verification lives: the app,
 * the wizard and every synced environment use `GITHUB_WEBHOOK_SECRET`. The
 * legacy `WEBHOOK_SECRET` is accepted only as a rollout fallback.
 *
 * Readiness consumes this through the resolver rather than re-listing names, so
 * the probe and webhook verification cannot disagree about what configures the
 * webhook (REL-1069 review).
 */
export function resolveWebhookSecret(environment: NodeJS.ProcessEnv): string {
  return String(environment.GITHUB_WEBHOOK_SECRET || '').trim()
    || String(environment.WEBHOOK_SECRET || '').trim();
}


export interface GitHubWebhookConfig {
  secret: string;
  admissionEnabled: boolean;
  repositoryIds: ReadonlySet<string>;
  ownerIds: ReadonlySet<string>;
}

function finiteIds(value: string | undefined, name: string, maximum: number): Set<string> {
  const entries = String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length < 1 || entries.length > maximum || new Set(entries).size !== entries.length
    || entries.some((entry) => !/^[1-9][0-9]*$/u.test(entry) || !Number.isSafeInteger(Number(entry)))) {
    throw new Error(`${name} must contain unique positive integer ids`);
  }
  return new Set(entries);
}

/**
 * Parse the opt-in GitHub App webhook lane. Its repository enrollment is a
 * strict subset of the existing Actions/OIDC allowlist so enabling the ingress
 * cannot silently widen the production review fleet.
 */
export function githubWebhookConfigFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
  actionPolicy: Pick<GitHubActionsOidcPolicy, 'allowAppGate' | 'repositoryIds' | 'ownerIds'>,
): GitHubWebhookConfig | undefined {
  const enabled = environment.GITHUB_APP_WEBHOOK_ENABLED;
  if (enabled === undefined || enabled === 'false') return undefined;
  if (enabled !== 'true' || actionPolicy.allowAppGate !== true) {
    throw new Error('GitHub App webhook configuration is invalid');
  }

  const secret = environment.GITHUB_WEBHOOK_SECRET || '';
  const admission = environment.GITHUB_APP_WEBHOOK_ADMISSION_ENABLED;
  const repositoryIds = finiteIds(environment.GITHUB_APP_WEBHOOK_REPOSITORY_IDS,
    'GITHUB_APP_WEBHOOK_REPOSITORY_IDS', 100);
  const ownerIds = finiteIds(environment.GITHUB_APP_WEBHOOK_OWNER_IDS,
    'GITHUB_APP_WEBHOOK_OWNER_IDS', 10);
  if (Buffer.byteLength(secret, 'utf8') < 32 || Buffer.byteLength(secret, 'utf8') > 1_024
    || (admission !== undefined && admission !== 'false' && admission !== 'true')
    || [...repositoryIds].some((id) => !actionPolicy.repositoryIds.has(id))
    || [...ownerIds].some((id) => !actionPolicy.ownerIds.has(id))) {
    throw new Error('GitHub App webhook configuration is invalid');
  }
  return { secret, admissionEnabled: admission === 'true', repositoryIds, ownerIds };
}
