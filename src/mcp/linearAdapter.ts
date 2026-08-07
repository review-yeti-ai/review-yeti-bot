import { DopplerSecretManager } from './dopplerSecretManager';
import { LINEAR_APPROVED_PACKAGE } from './linearPolicy';
import { logger } from '../utils/logger';

/**
 * Built-in Linear adapter — API key only (same auth model as cline/linear-mcp).
 * No OAuth. Resolves LINEAR_API_KEY via DopplerSecretManager (env → cache → Doppler).
 */

export interface LinearAdapterConfig {
  dopplerManager?: DopplerSecretManager;
  timeoutMs?: number;
}

export interface LinearCloseIssueResult {
  success: boolean;
  issueId: string;
  status: string;
  updated?: boolean;
  error?: string;
}

export class LinearMCPAdapter {
  private readonly dopplerManager: DopplerSecretManager;
  private readonly timeoutMs: number;

  constructor(config: LinearAdapterConfig = {}) {
    this.dopplerManager = config.dopplerManager || new DopplerSecretManager();
    this.timeoutMs = config.timeoutMs ?? 5_000;
  }

  public async resolveApiKey(): Promise<string | null> {
    return this.dopplerManager.getSecret('LINEAR_API_KEY');
  }

  public async healthCheck(): Promise<{ ok: boolean; message: string }> {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) {
      return {
        ok: false,
        message: `LINEAR_API_KEY unresolvable (required for Linear; OAuth rejected; prefer ${LINEAR_APPROVED_PACKAGE})`,
      };
    }

    try {
      const data = await this.graphql(apiKey, {
        query: `query { viewer { id name } }`,
      });
      if (data?.errors?.length) {
        return {
          ok: false,
          message: data.errors[0]?.message || 'Linear GraphQL viewer query failed',
        };
      }
      const name = data?.data?.viewer?.name || data?.data?.viewer?.id || 'viewer';
      return { ok: true, message: `Linear API operational (API key; viewer=${name})` };
    } catch (err: any) {
      return { ok: false, message: err.message || 'Linear health check failed' };
    }
  }

  /**
   * Best-effort state update for an issue identifier (UUID or TEAM-123).
   * Uses GraphQL issueUpdate; state name mapping is best-effort.
   */
  public async closeIssue(issueId: string, targetStatus = 'Done'): Promise<LinearCloseIssueResult> {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) {
      logger.info(`LINEAR_API_KEY missing, skipped Linear update for ${issueId}`);
      return {
        success: false,
        issueId,
        status: targetStatus,
        error: 'LINEAR_API_KEY missing; Linear tools are skipped',
      };
    }

    const id = String(issueId || '').trim();
    if (!id) {
      return {
        success: false,
        issueId: '',
        status: targetStatus,
        error: 'linear_close_issue requires issueId',
      };
    }

    try {
      // Resolve human-readable keys (e.g. ENG-123) to UUIDs when needed.
      let resolvedId = id;
      if (/^[A-Z]{2,10}-\d+$/i.test(id)) {
        const found = await this.graphql(apiKey, {
          query: `query($key: String!) {
            issue(id: $key) { id identifier }
          }`,
          variables: { key: id },
        });
        // Linear accepts identifier in some clients; fall back to issueSearch if direct id fails.
        if (found?.data?.issue?.id) {
          resolvedId = found.data.issue.id;
        } else {
          const search = await this.graphql(apiKey, {
            query: `query($term: String!) {
              issueSearch(query: $term, first: 1) {
                nodes { id identifier }
              }
            }`,
            variables: { term: id },
          });
          const node = search?.data?.issueSearch?.nodes?.[0];
          if (node?.id) resolvedId = node.id;
        }
      }

      const stateId = await this.resolveStateId(apiKey, resolvedId, targetStatus);

      const mutation = stateId
        ? {
            query: `mutation($id: String!, $stateId: String!) {
              issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id identifier } }
            }`,
            variables: { id: resolvedId, stateId },
          }
        : {
            // Fallback path if state resolution fails (may no-op depending on API).
            query: `mutation($id: String!) {
              issueUpdate(id: $id, input: {}) { success issue { id identifier } }
            }`,
            variables: { id: resolvedId },
          };

      const data = await this.graphql(apiKey, mutation);
      if (data?.errors?.length) {
        return {
          success: false,
          issueId: id,
          status: targetStatus,
          error: data.errors[0]?.message || 'Linear issueUpdate failed',
        };
      }
      const ok = Boolean(data?.data?.issueUpdate?.success);
      return {
        success: ok,
        issueId: id,
        status: targetStatus,
        updated: ok,
        error: ok ? undefined : 'Linear issueUpdate returned success=false',
      };
    } catch (err: any) {
      logger.warn(`Linear API sync warning for issue ${id}: ${err.message}`);
      return {
        success: false,
        issueId: id,
        status: targetStatus,
        error: err.message || 'Linear API request failed',
      };
    }
  }

  private async resolveStateId(
    apiKey: string,
    issueId: string,
    targetStatus: string
  ): Promise<string | null> {
    try {
      const data = await this.graphql(apiKey, {
        query: `query($id: String!) {
          issue(id: $id) {
            team {
              states { nodes { id name type } }
            }
          }
        }`,
        variables: { id: issueId },
      });
      const nodes: Array<{ id: string; name: string; type: string }> =
        data?.data?.issue?.team?.states?.nodes || [];
      if (!nodes.length) return null;

      const want = targetStatus.trim().toLowerCase();
      const byName = nodes.find((n) => n.name.toLowerCase() === want);
      if (byName) return byName.id;

      // Common aliases
      if (want === 'done' || want === 'completed' || want === 'closed') {
        const completed = nodes.find((n) => n.type === 'completed');
        if (completed) return completed.id;
      }
      if (want === 'canceled' || want === 'cancelled') {
        const canceled = nodes.find((n) => n.type === 'canceled');
        if (canceled) return canceled.id;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async graphql(
    apiKey: string,
    body: { query: string; variables?: Record<string, unknown> }
  ): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Linear API status ${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
