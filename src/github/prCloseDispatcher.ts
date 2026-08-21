import { ParsedPRPayload } from './eventHandler';
import { GitHubInstallationClient } from './installationClient';
import { loadConfig } from '../config/configLoader';
import { CtReviewConfigV3 } from '../config/schema';
import { executeDocsPersona } from '../personas/docsPersona';
import { executeMarketingPersona } from '../personas/marketingPersona';
import { executeLinearSyncPersona } from '../personas/linearSyncPersona';
import { ReviewModelClient } from '../gateway/openRouterClient';
import { logger } from '../utils/logger';

export interface PRCloseDispatchResult {
  status: 'processed' | 'skipped' | 'failed';
  prNumber: number;
  actionsExecuted: string[];
  followupPRsCreated: Array<{ persona: string; prNumber: number; url: string }>;
  linearSyncResult?: { issuesUpdated: string[]; targetStatus: string };
  productlaneSyncResult?: { status: string };
  errors?: string[];
}

export class PRCloseDispatcher {
  constructor(private readonly modelClient?: ReviewModelClient) {}

  public async dispatchPRCloseActions(
    payload: ParsedPRPayload,
    github: GitHubInstallationClient
  ): Promise<PRCloseDispatchResult> {
    const { owner, repo, prNumber, baseSha } = payload;

    logger.info(`Dispatching PR close actions for ${owner}/${repo} #${prNumber}`);

    // 1. Load Repository Base Policy
    const config: CtReviewConfigV3 = await loadConfig(owner, repo, baseSha, github);
    const policy = config.on_pr_close;

    if (!policy || (!policy.create_followup_prs?.length && !policy.sync_linear_status && !policy.sync_productlane)) {
      logger.info(`No on_pr_close policies configured for ${owner}/${repo} #${prNumber}`);
      return {
        status: 'skipped',
        prNumber,
        actionsExecuted: [],
        followupPRsCreated: [],
      };
    }

    const result: PRCloseDispatchResult = {
      status: 'processed',
      prNumber,
      actionsExecuted: [],
      followupPRsCreated: [],
      errors: [],
    };

    // 2. Execute Follow-up PR Personas
    if (Array.isArray(policy.create_followup_prs)) {
      for (const personaType of policy.create_followup_prs) {
        try {
          if (personaType === 'docs') {
            const docsRes = await executeDocsPersona({ payload, config, github, modelClient: this.modelClient });
            if (docsRes.created) {
              result.actionsExecuted.push('create_followup_prs:docs');
              result.followupPRsCreated.push({ persona: 'docs', prNumber: docsRes.prNumber, url: docsRes.url });
            }
          } else if (personaType === 'marketing') {
            const mktRes = await executeMarketingPersona({ payload, config, github, modelClient: this.modelClient });
            if (mktRes.created) {
              result.actionsExecuted.push('create_followup_prs:marketing');
              result.followupPRsCreated.push({ persona: 'marketing', prNumber: mktRes.prNumber, url: mktRes.url });
            }
          }
        } catch (err: any) {
          const msg = `Failed executing follow-up persona ${personaType}: ${err.message}`;
          logger.error(msg, { error: err });
          result.errors?.push(msg);
        }
      }
    }

    // 3. Execute Linear & Productlane Sync Persona
    if (policy.sync_linear_status || policy.sync_productlane) {
      try {
        const syncRes = await executeLinearSyncPersona({
          payload,
          config,
          targetStatus: policy.sync_linear_status,
          syncProductlane: policy.sync_productlane,
        });
        if (policy.sync_linear_status) {
          result.actionsExecuted.push('sync_linear_status');
          result.linearSyncResult = syncRes.linear;
        }
        if (policy.sync_productlane) {
          result.actionsExecuted.push('sync_productlane');
          result.productlaneSyncResult = syncRes.productlane;
        }
      } catch (err: any) {
        const msg = `Failed executing Linear/Productlane sync: ${err.message}`;
        logger.error(msg, { error: err });
        result.errors?.push(msg);
      }
    }

    if (result.errors?.length && result.actionsExecuted.length === 0) {
      result.status = 'failed';
    }

    return result;
  }
}
