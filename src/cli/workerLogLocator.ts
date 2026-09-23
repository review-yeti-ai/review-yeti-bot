/**
 * REL-1038: a pointer from the published check to this run's worker logs.
 *
 * The operator projects the worker Pod's own name and namespace into the
 * container through the Kubernetes downward API (REVIEW_WORKER_POD_NAME and
 * REVIEW_WORKER_POD_NAMESPACE). The check output prints them as a VictoriaLogs
 * LogsQL query, so whoever reads a failed check can go straight to the full
 * worker log after the Pod itself is gone. The query names only the namespace
 * and Pod: no host, URL, credential, or log content.
 */

export const WORKER_POD_NAME_ENV = 'REVIEW_WORKER_POD_NAME';
export const WORKER_POD_NAMESPACE_ENV = 'REVIEW_WORKER_POD_NAMESPACE';

// Kubernetes object-name grammar. Anything else is refused rather than
// escaped, so a malformed value can never inject LogsQL or Markdown.
const POD_NAME = /^(?=.{1,253}$)[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/u;
const NAMESPACE = /^(?=.{1,63}$)[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u;

/** The LogsQL query for this worker Pod, or null when the identity is absent or malformed. */
export function workerLogsQuery(env: NodeJS.ProcessEnv): string | null {
  const podName = String(env[WORKER_POD_NAME_ENV] || '').trim();
  const namespace = String(env[WORKER_POD_NAMESPACE_ENV] || '').trim();
  if (!POD_NAME.test(podName) || !NAMESPACE.test(namespace)) return null;
  return `kubernetes.pod_namespace:"${namespace}" AND kubernetes.pod_name:"${podName}" | sort by (_time)`;
}

/** The check-output section carrying the locator, or null when there is no usable identity. */
export function renderWorkerLogLocator(env: NodeJS.ProcessEnv): string | null {
  const query = workerLogsQuery(env);
  if (!query) return null;
  return ['Worker logs (VictoriaLogs LogsQL):', '```', query, '```'].join('\n');
}
