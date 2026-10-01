import { isGitHubInstallationToken } from '../github/githubTransportPolicy';
import { validateWorkerCompletionEndpoint } from './workerCompletion';
import {
  MAX_REVIEW_CHECKPOINT_BYTES,
  parseReviewExecutionCheckpoint,
  type ReviewExecutionCheckpoint,
} from './reviewExecutionCheckpoint';

export interface ReviewExecutionCheckpointAdapter {
  read(signal?: AbortSignal): Promise<ReviewExecutionCheckpoint | null>;
  write(checkpoint: ReviewExecutionCheckpoint, signal?: AbortSignal): Promise<number>;
}
export class HttpReviewExecutionCheckpointAdapter implements ReviewExecutionCheckpointAdapter {
  private readonly endpoint: string;
  private revisionOffset = 0;

  constructor(private readonly options: {
    token: string;
    completionEndpoint: string;
    runId: string;
    executionAttempt: number;
    fetchImplementation?: typeof fetch;
  }) {
    if (!isGitHubInstallationToken(options.token) || !/^run_[a-f0-9]{32}$/u.test(options.runId)
      || !Number.isSafeInteger(options.executionAttempt) || options.executionAttempt < 1) {
      throw new Error('Invalid review checkpoint identity');
    }
    const url = new URL(validateWorkerCompletionEndpoint(options.completionEndpoint));
    if (url.search || url.hash || !url.pathname.endsWith('/completion')) throw new Error('Invalid review checkpoint endpoint');
    url.pathname = `${url.pathname.slice(0, -'/completion'.length)}/review-checkpoint`;
    this.endpoint = url.toString();
  }

  async read(signal?: AbortSignal): Promise<ReviewExecutionCheckpoint | null> {
    const json = await this.post({ version: 'ReviewExecutionCheckpointRead.v1', runId: this.options.runId,
      executionAttempt: this.options.executionAttempt }, signal);
    if (json?.version !== 'ReviewExecutionCheckpointReadResult.v1'
      || json.runId !== this.options.runId || json.executionAttempt !== this.options.executionAttempt) {
      throw new Error('Review checkpoint response identity mismatch');
    }
    return json.checkpoint === null ? null : parseReviewExecutionCheckpoint(json.checkpoint);
  }

  async write(checkpoint: ReviewExecutionCheckpoint, signal?: AbortSignal): Promise<number> {
    const parsed = parseReviewExecutionCheckpoint(checkpoint);
    if (parsed.runId !== this.options.runId || parsed.executionAttempt !== this.options.executionAttempt) {
      throw new Error('Review checkpoint write identity mismatch');
    }
    const candidate = parseReviewExecutionCheckpoint({ ...parsed, revision: parsed.revision + this.revisionOffset });
    let json = await this.post(candidate, signal);
    if (json?.version !== 'ReviewExecutionCheckpointAccepted.v1' || json.runId !== this.options.runId
      || !['recorded', 'stale'].includes(String(json.status))
      || !Number.isSafeInteger(json.revision) || json.revision < 1) {
      throw new Error('Review checkpoint write was not acknowledged');
    }
    if (json.status === 'stale') {
      const rebased = parseReviewExecutionCheckpoint({ ...parsed, revision: json.revision + 1 });
      json = await this.post(rebased, signal);
      if (json?.version !== 'ReviewExecutionCheckpointAccepted.v1' || json.runId !== this.options.runId
        || json.status !== 'recorded' || json.revision !== rebased.revision) {
        throw new Error('Review checkpoint stale-write recovery was not acknowledged');
      }
    } else if (json.revision !== candidate.revision) {
      throw new Error('Review checkpoint recorded revision mismatch');
    }
    this.revisionOffset = json.revision - parsed.revision;
    return json.revision;
  }

  private async post(body: unknown, parentSignal?: AbortSignal): Promise<any> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    if (parentSignal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await (this.options.fetchImplementation ?? globalThis.fetch)(this.endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status !== 200 || response.redirected || !response.body) throw new Error('Review checkpoint unavailable');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_REVIEW_CHECKPOINT_BYTES + 16_384) throw new Error('Review checkpoint response exceeds its bound');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
}
