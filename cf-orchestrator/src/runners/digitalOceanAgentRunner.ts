import type { ContainerJobResult, ContainerJobSpec, ContainerRunner } from './containerRunner.js';
import { redactTokens } from './r2WorkspaceCache.js';
import { calculateRunnerCost } from './runnerCost.js';

export interface DigitalOceanAgentRunnerConfig {
  apiToken?: string;
  agentId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * DigitalOcean Managed Agent Runner
 * Dispatches review sessions to DigitalOcean Managed Agents running in
 * isolated Firecracker microVMs with sub-second launch and agent-aware billing.
 */
export class DigitalOceanAgentRunner implements ContainerRunner {
  private apiToken: string;
  private agentId: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(config: DigitalOceanAgentRunnerConfig = {}) {
    this.apiToken = (config.apiToken || '').trim();
    this.agentId = config.agentId || 'review-yeti-swarm';
    this.baseUrl = (config.baseUrl || 'https://api.digitalocean.com').trim().replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl || fetch;
  }

  async dispatchJob(spec: ContainerJobSpec): Promise<ContainerJobResult> {
    const startedAt = Date.now();

    // Fast-fail if API token is missing or empty
    if (!this.apiToken) {
      return {
        jobId: spec.jobId,
        exitCode: 1,
        durationMs: 0,
        status: 'failed',
        error: 'DigitalOcean API token is required for dispatchJob',
      };
    }

    const endpoint = `${this.baseUrl}/v2/genai/agents/${encodeURIComponent(this.agentId)}/sessions`;

    try {
      // 1. Create agent execution session in Firecracker microVM
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiToken}`,
          'X-Review-Run-Id': spec.runId,
        },
        body: JSON.stringify({
          session_id: spec.jobId,
          image: spec.workerImage,
          environment: spec.env,
          resources: {
            vcpus: spec.cpu ?? 2,
            memory_mb: spec.memoryMb ?? 2048,
          },
          timeout_seconds: spec.timeoutSeconds ?? 1500,
          harness: {
            type: 'hermes',
            command: ['node', '/app/dist/cli/runLiveReview.js'],
          },
        }),
      });

      if (!response.ok) {
        let errorText = '';
        try {
          errorText = await response.text();
        } catch {
          errorText = response.statusText;
        }
        throw new Error(`DO Managed Agent dispatch failed (${response.status}): ${redactTokens(errorText, [this.apiToken])}`);
      }

      let session: any;
      try {
        session = await response.json();
      } catch (jsonErr: any) {
        throw new Error(`Failed to parse DO Managed Agent response JSON: ${jsonErr.message}`);
      }

      const durationMs = Date.now() - startedAt;
      const exitCode = session?.exit_code ?? 0;

      // Status mapping covering timeouts, cancellations, failures, and success
      let status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
      if (session?.status === 'timed_out' || exitCode === 124) {
        status = 'timed_out';
      } else if (session?.status === 'cancelled' || exitCode === 137) {
        status = 'cancelled';
      } else if (
        session?.status === 'failed' ||
        session?.status === 'error' ||
        exitCode !== 0
      ) {
        status = 'failed';
      } else if ((session?.status === 'succeeded' || !session?.status) && exitCode === 0) {
        status = 'succeeded';
      } else {
        status = 'failed';
      }

      const rawOutput = session?.output_log ?? session?.logs;
      const outputLog = rawOutput ? redactTokens(rawOutput, [this.apiToken]) : undefined;
      const error = session?.error ? redactTokens(session.error, [this.apiToken]) : undefined;
      const runnerCost = calculateRunnerCost({
        durationMs,
        vcpus: spec.cpu ?? 2,
        memoryMb: spec.memoryMb ?? 2048,
        runnerType: 'digitalocean',
      });

      return {
        jobId: spec.jobId,
        exitCode,
        durationMs,
        status,
        outputLog,
        receipt: session?.receipt,
        error,
        runnerCost,
      };
    } catch (err: any) {
      const isTimeout = err?.name === 'TimeoutError' || /timed?\s*out/i.test(err?.message || '');
      const isCancelled = err?.name === 'AbortError' || /cancelled|aborted|terminated/i.test(err?.message || '');
      const durationMs = Date.now() - startedAt;
      const runnerCost = calculateRunnerCost({
        durationMs,
        vcpus: spec.cpu ?? 2,
        memoryMb: spec.memoryMb ?? 2048,
        runnerType: 'digitalocean',
      });

      return {
        jobId: spec.jobId,
        exitCode: isTimeout ? 124 : (isCancelled ? 137 : 1),
        durationMs,
        status: isTimeout ? 'timed_out' : (isCancelled ? 'cancelled' : 'failed'),
        error: redactTokens(err?.message || String(err), [this.apiToken]),
        runnerCost,
      };
    }
  }

  async terminateJob(jobId: string, reason?: string): Promise<{ terminated: boolean }> {
    const endpoint = `${this.baseUrl}/v2/genai/agents/${encodeURIComponent(this.agentId)}/sessions/${encodeURIComponent(jobId)}`;

    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'X-Cancel-Reason': reason || 'superseded_or_closed',
        },
      });

      return { terminated: response.ok || response.status === 404 };
    } catch {
      return { terminated: false };
    }
  }
}
