import * as k8s from '@kubernetes/client-node';
import { logger } from '../utils/logger';

export interface DispatchJobOptions {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha?: string;
  jobId: string;
  namespace?: string;
  image?: string;
  timeoutSeconds?: number;
}

export interface DispatchJobResult {
  success: boolean;
  jobName: string;
  pvcName: string;
  outputLog?: string;
  durationMs: number;
  error?: string;
}

export class K8sJobDispatcher {
  private batchApi: k8s.BatchV1Api;
  private coreApi: k8s.CoreV1Api;
  private namespace: string;

  constructor(namespace?: string) {
    const kc = new k8s.KubeConfig();
    try {
      kc.loadFromCluster();
    } catch {
      try {
        kc.loadFromDefault();
      } catch {
        // Fallback for non-k8s test environments
      }
    }
    this.batchApi = kc.makeApiClient(k8s.BatchV1Api);
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.namespace = namespace || process.env.K8S_NAMESPACE || 'ct-review-system';
  }

  /**
   * Helper to build clean K8s names for PVC and Job
   */
  public getNames(owner: string, repo: string, prNumber: number, headSha: string) {
    const cleanRepo = `${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
    const shortSha = headSha.slice(0, 7);
    const baseName = `ct-review-${cleanRepo}-pr${prNumber}-${shortSha}`;
    return {
      jobName: `job-${baseName}`.slice(0, 63),
      pvcName: `pvc-${baseName}`.slice(0, 63),
    };
  }

  /**
   * Builds PVC manifest for 1Gi ephemeral storage
   */
  public buildPvcManifest(pvcName: string): k8s.V1PersistentVolumeClaim {
    return {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: pvcName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/name': 'ct-review-bot-worker',
          'ct-review/ttl': '1800',
        },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: {
          requests: {
            storage: '1Gi',
          },
        },
      },
    };
  }

  /**
   * Builds batch/v1 Job manifest with 1800s (30m) TTL and 1Gi memory limits
   */
  public buildJobManifest(
    jobName: string,
    pvcName: string,
    options: DispatchJobOptions
  ): k8s.V1Job {
    const workerImage =
      options.image ||
      process.env.WORKER_IMAGE ||
      process.env.CONTAINER_IMAGE ||
      'registry.digitalocean.com/calltelemetry/ct-review-bot:v46-wall-time-responsive-fix';

    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/name': 'ct-review-bot-worker',
          'ct-review/pr': String(options.prNumber),
          'ct-review/repo': `${options.owner}-${options.repo}`.slice(0, 50),
        },
      },
      spec: {
        ttlSecondsAfterFinished: 1800, // 30 minutes durability before K8s GC
        backoffLimit: 1,
        activeDeadlineSeconds: options.timeoutSeconds || 300,
        template: {
          metadata: {
            labels: {
              'app.kubernetes.io/name': 'ct-review-bot-worker',
              'ct-review/job-id': options.jobId,
            },
          },
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'worker',
                image: workerImage,
                imagePullPolicy: 'IfNotPresent',
                command: ['node', 'dist/cli/runLiveReview.js'],
                args: [
                  `--repo=${options.owner}/${options.repo}`,
                  `--pr=${options.prNumber}`,
                  `--sha=${options.headSha}`,
                ],
                env: [
                  { name: 'WORKER_MODE', value: 'true' },
                  { name: 'REPO', value: `${options.owner}/${options.repo}` },
                  { name: 'PR_NUMBER', value: String(options.prNumber) },
                  { name: 'HEAD_SHA', value: options.headSha },
                  { name: 'BASE_SHA', value: options.baseSha || '' },
                  { name: 'JOB_ID', value: options.jobId },
                  { name: 'OMNIROUTE_BASE_URL', value: process.env.OMNIROUTE_BASE_URL || 'http://omniroute-service:8000' },
                  { name: 'OMNIROUTE_ACCESS_TOKEN', value: process.env.OMNIROUTE_ACCESS_TOKEN || '' },
                  { name: 'WORKSPACE_DIR', value: '/app/data/pr-workspace' },
                ],
                resources: {
                  requests: {
                    memory: '512Mi',
                    cpu: '100m',
                  },
                  limits: {
                    memory: '1Gi',
                    cpu: '500m',
                  },
                },
                volumeMounts: [
                  {
                    name: 'pr-workspace',
                    mountPath: '/app/data/pr-workspace',
                  },
                ],
              },
            ],
            volumes: [
              {
                name: 'pr-workspace',
                persistentVolumeClaim: {
                  claimName: pvcName,
                },
              },
            ],
          },
        },
      },
    };
  }

  /**
   * Dispatch PVC & Job to Kubernetes cluster and wait for completion
   */
  public async dispatchWorkerJob(options: DispatchJobOptions): Promise<DispatchJobResult> {
    const startTime = Date.now();
    const { jobName, pvcName } = this.getNames(
      options.owner,
      options.repo,
      options.prNumber,
      options.headSha
    );

    logger.info(`Dispatching ephemeral K8s worker Job & PVC for ${options.owner}/${options.repo} #${options.prNumber}`, {
      jobName,
      pvcName,
      namespace: this.namespace,
    });

    try {
      // 1. Create PVC
      const pvcManifest = this.buildPvcManifest(pvcName);
      try {
        await (this.coreApi as any).createNamespacedPersistentVolumeClaim({ namespace: this.namespace, body: pvcManifest });
        logger.info(`Created PVC ${pvcName} (1Gi) in namespace ${this.namespace}`);
      } catch (err: any) {
        if (err?.response?.statusCode !== 409 && err?.statusCode !== 409) {
          throw err;
        }
        logger.info(`PVC ${pvcName} already exists, reusing existing claim`);
      }

      // 2. Create Job
      const jobManifest = this.buildJobManifest(jobName, pvcName, options);
      await (this.batchApi as any).createNamespacedJob({ namespace: this.namespace, body: jobManifest });
      logger.info(`Created batch/v1 Job ${jobName} with 30m TTL in namespace ${this.namespace}`);

      // 3. Poll for completion
      const maxWaitMs = (options.timeoutSeconds || 300) * 1000;
      const pollIntervalMs = 3000;
      let elapsed = 0;
      let jobFinished = false;
      let jobSucceeded = false;

      while (elapsed < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        elapsed += pollIntervalMs;

        try {
          const res = await (this.batchApi as any).readNamespacedJobStatus({ name: jobName, namespace: this.namespace });
          const status = res?.body?.status || res?.status;
          if (status) {
            if (status.succeeded && status.succeeded > 0) {
              jobFinished = true;
              jobSucceeded = true;
              break;
            }
            if (status.failed && status.failed > 0) {
              jobFinished = true;
              jobSucceeded = false;
              break;
            }
          }
        } catch {
          // Ignore transient status read errors
        }
      }

      const durationMs = Date.now() - startTime;

      if (!jobFinished) {
        logger.warn(`K8s worker job ${jobName} timed out after ${durationMs}ms`);
        return {
          success: false,
          jobName,
          pvcName,
          durationMs,
          error: `Job timed out after ${durationMs}ms`,
        };
      }

      logger.info(`K8s worker job ${jobName} finished in ${durationMs}ms (succeeded: ${jobSucceeded})`);

      return {
        success: jobSucceeded,
        jobName,
        pvcName,
        durationMs,
        ...(jobSucceeded ? {} : { error: `Job ${jobName} failed execution in worker container` }),
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      logger.error(`Failed to dispatch K8s worker job ${jobName}`, { error: err?.message || String(err) });
      return {
        success: false,
        jobName,
        pvcName,
        durationMs,
        error: err?.message || String(err),
      };
    }
  }
}
