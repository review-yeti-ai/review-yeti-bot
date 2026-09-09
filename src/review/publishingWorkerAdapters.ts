import { HttpWorkerCompletionAdapter } from './workerCompletion';
import { HttpWorkerReviewCompletionAdapter } from './workerReviewCompletionHttp';

/** The CLI and tests use one selection boundary. An enrolled worker never
 * falls back to the legacy failure-only callback when its endpoint is absent. */
export function publishingWorkerAdapters(env: Readonly<Record<string, string | undefined>>, token: string): {
  completion?: HttpWorkerCompletionAdapter;
  reviewCompletion?: HttpWorkerReviewCompletionAdapter;
} {
  const endpoint = String(env.REVIEW_COMPLETION_URL || '').trim();
  const flag = String(env.REVIEW_AUTHORITATIVE_GATE || '').trim();
  if (flag && flag !== 'true' && flag !== 'false') throw new Error('Invalid authoritative worker flag');
  if (!endpoint) {
    if (flag === 'true') throw new Error('Authoritative review worker requires its completion endpoint');
    return {};
  }
  return flag === 'true'
    ? { reviewCompletion: new HttpWorkerReviewCompletionAdapter({ token, endpoint }) }
    : { completion: new HttpWorkerCompletionAdapter({ token, endpoint }) };
}
