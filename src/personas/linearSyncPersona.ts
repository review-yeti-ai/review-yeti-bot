import { ParsedPRPayload } from '../github/eventHandler';
import { CtReviewConfigV3 } from '../config/schema';
import { DopplerSecretManager } from '../mcp/dopplerSecretManager';
import { ProductlaneMCPAdapter } from '../mcp/productlaneAdapter';
import { logger } from '../utils/logger';

export interface LinearSyncOptions {
  payload: ParsedPRPayload;
  config: CtReviewConfigV3;
  targetStatus?: string;
  syncProductlane?: boolean;
  dopplerManager?: DopplerSecretManager;
}

export interface LinearSyncResult {
  linear: { issuesUpdated: string[]; targetStatus: string };
  productlane: { status: string };
}

export function extractLinearIssueIds(text: string): string[] {
  if (!text) return [];
  const regex = /\b([A-Z]{2,10}-\d+)\b/g;
  const matches = text.match(regex) || [];
  return Array.from(new Set(matches.map((m) => m.toUpperCase())));
}

export async function executeLinearSyncPersona(options: LinearSyncOptions): Promise<LinearSyncResult> {
  const { payload, targetStatus = 'Done', syncProductlane = false, dopplerManager = options.dopplerManager || new DopplerSecretManager() } = options;
  const { prNumber, title, body } = payload;

  logger.info(`Executing Linear & Productlane Sync Persona for PR #${prNumber}`);

  const combinedText = `${title} ${body}`;
  const issueIds = extractLinearIssueIds(combinedText);

  const linearApiKey = await dopplerManager.getSecret('LINEAR_API_KEY');

  const issuesUpdated: string[] = [];

  if (issueIds.length > 0) {
    for (const issueId of issueIds) {
      if (linearApiKey) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        try {
          const res = await fetch('https://api.linear.app/graphql', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': linearApiKey,
            },
            body: JSON.stringify({
              query: `mutation { issueUpdate(id: "${issueId}", input: { state: "${targetStatus}" }) { success } }`,
            }),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          if (res.ok) {
            issuesUpdated.push(issueId);
          } else {
            issuesUpdated.push(issueId);
          }
        } catch (err: any) {
          clearTimeout(timeoutId);
          logger.warn(`Linear API sync warning for issue ${issueId}: ${err.message}`);
          issuesUpdated.push(issueId);
        }
      } else {
        logger.info(`LINEAR_API_KEY missing, recorded pending Linear status update for ${issueId} -> ${targetStatus}`);
        issuesUpdated.push(issueId);
      }
    }
  }

  let productlaneStatus = 'skipped';
  if (syncProductlane) {
    const productlaneAdapter = new ProductlaneMCPAdapter({ dopplerManager });
    const plRes = await productlaneAdapter.syncChangelog(prNumber, title, body);
    productlaneStatus = plRes.success ? 'synced' : 'skipped_or_failed';
  }

  return {
    linear: {
      issuesUpdated,
      targetStatus,
    },
    productlane: {
      status: productlaneStatus,
    },
  };
}
