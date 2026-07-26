import * as k8s from '@kubernetes/client-node';
import { logger } from '../utils/logger';

export interface K8sJobSpec {
  jobName?: string;
  namespace?: string;
  image?: string;
  persona: string;
  repoUrl: string;
  prNumber: number;
  commitSha: string;
  pvcClaimName?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  cpuRequest?: string;
  memoryRequest?: string;
  ttlSecondsAfterFinished?: number;
  activeDeadlineSeconds?: number;
  envVars?: Record<string, string>;
}

export interface GeneratedK8sJobManifest {
  apiVersion: 'batch/v1';
  kind: 'Job';
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
  };
  spec: {
    ttlSecondsAfterFinished: number;
    activeDeadlineSeconds: number;
    backoffLimit: number;
    template: {
      metadata: {
        labels: Record<string, string>;
      };
      spec: {
        restartPolicy: 'Never';
        containers: Array<{
          name: string;
          image: string;
          command: string[];
          resources: {
            requests: { cpu: string; memory: string };
            limits: { cpu: string; memory: string };
          };
          volumeMounts: Array<{
            name: string;
            mountPath: string;
            subPath?: string;
          }>;
          env: Array<{ name: string; value: string }>;
        }>;
        volumes: Array<{
          name: string;
          persistentVolumeClaim?: { claimName: string };
          emptyDir?: {};
        }>;
      };
    };
  };
}

export class K8sJobRunner {
  private batchV1Api?: k8s.BatchV1Api;
  private isK8sAvailable: boolean = false;
  private namespace: string;
  private defaultImage: string;
  private defaultPvcName: string;

  constructor(options?: {
    namespace?: string;
    defaultImage?: string;
    defaultPvcName?: string;
    forceSimulation?: boolean;
  }) {
    this.namespace = options?.namespace || process.env.K8S_NAMESPACE || 'ct-review-system';
    this.defaultImage = options?.defaultImage || process.env.K8S_AGENT_IMAGE || 'registry.digitalocean.com/calltelemetry/ct-review-agent:latest';
    this.defaultPvcName = options?.defaultPvcName || process.env.K8S_WORKSPACE_PVC || 'ct-review-bot-workspace-pvc';

    if (!options?.forceSimulation && process.env.NODE_ENV !== 'test') {
      try {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        this.batchV1Api = kc.makeApiClient(k8s.BatchV1Api);
        this.isK8sAvailable = true;
      } catch (err) {
        logger.warn('KubeConfig initialization failed; using simulation mode', { error: (err as Error).message });
        this.isK8sAvailable = false;
      }
    }
  }

  /**
   * Generates a fully-formed Kubernetes batch/v1 Job manifest for a scoped reviewer agent pod.
   * Leverages a shared PVC so parallel persona pods reuse the exact same git workspace.
   */
  public generateJobManifest(spec: K8sJobSpec): GeneratedK8sJobManifest {
    const sanitizedPersona = spec.persona.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const jobName = spec.jobName || `ct-agent-${sanitizedPersona}-pr${spec.prNumber}-${spec.commitSha.slice(0, 7)}`;
    const namespace = spec.namespace || this.namespace;
    const image = spec.image || this.defaultImage;
    const pvcClaimName = spec.pvcClaimName || this.defaultPvcName;
    const ttl = spec.ttlSecondsAfterFinished ?? 300;
    const activeDeadline = spec.activeDeadlineSeconds ?? 600;
    const subPath = `repos/${spec.repoUrl.replace(/[^a-zA-Z0-9_-]/g, '_')}_pr${spec.prNumber}`;

    const envArray = Object.entries({
      PERSONA: spec.persona,
      PR_NUMBER: String(spec.prNumber),
      COMMIT_SHA: spec.commitSha,
      REPO_URL: spec.repoUrl,
      WORKSPACE_PATH: `/workspace/${subPath}`,
      ...(spec.envVars || {}),
    }).map(([name, value]) => ({ name, value }));

    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace,
        labels: {
          app: 'ct-review-agent',
          persona: sanitizedPersona,
          prNumber: String(spec.prNumber),
          commitSha: spec.commitSha.slice(0, 7),
        },
      },
      spec: {
        ttlSecondsAfterFinished: ttl,
        activeDeadlineSeconds: activeDeadline,
        backoffLimit: 1,
        template: {
          metadata: {
            labels: {
              app: 'ct-review-agent',
              persona: sanitizedPersona,
            },
          },
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'reviewer-agent',
                image,
                command: ['node', '/app/dist/agentWorker.js'],
                resources: {
                  requests: {
                    cpu: spec.cpuRequest || '250m',
                    memory: spec.memoryRequest || '512Mi',
                  },
                  limits: {
                    cpu: spec.cpuLimit || '500m',
                    memory: spec.memoryLimit || '1Gi',
                  },
                },
                volumeMounts: [
                  {
                    name: 'workspace-volume',
                    mountPath: '/workspace',
                    subPath,
                  },
                ],
                env: envArray,
              },
            ],
            volumes: [
              {
                name: 'workspace-volume',
                persistentVolumeClaim: {
                  claimName: pvcClaimName,
                },
              },
            ],
          },
        },
      },
    };
  }

  /**
   * Simulates/Executes Kubernetes Job dispatch on DOKS cluster.
   */
  public async dispatchJob(spec: K8sJobSpec): Promise<{
    success: boolean;
    jobName: string;
    namespace: string;
    mode: 'k8s' | 'simulation';
    manifest: GeneratedK8sJobManifest;
  }> {
    const manifest = this.generateJobManifest(spec);
    const namespace = manifest.metadata.namespace;

    if (this.isK8sAvailable && this.batchV1Api) {
      try {
        if (typeof (this.batchV1Api as any).createNamespacedJob === 'function') {
          try {
            await (this.batchV1Api as any).createNamespacedJob({ namespace, body: manifest as any });
          } catch (e: any) {
            await (this.batchV1Api as any).createNamespacedJob(namespace, manifest as any);
          }
        }
        logger.info('Dispatched Kubernetes agent batch Job via K8s API', { jobName: manifest.metadata.name, namespace });
        return { success: true, jobName: manifest.metadata.name, namespace, mode: 'k8s', manifest };
      } catch (err: any) {
        logger.error('Failed to create K8s agent batch Job', { error: err.message, jobName: manifest.metadata.name });
        return { success: false, jobName: manifest.metadata.name, namespace, mode: 'k8s', manifest };
      }
    }

    logger.info('Simulated Kubernetes agent sandbox Job dispatch', {
      jobName: manifest.metadata.name,
      persona: spec.persona,
      namespace,
      pvcClaimName: manifest.spec.template.spec.volumes[0].persistentVolumeClaim?.claimName,
    });

    return {
      success: true,
      jobName: manifest.metadata.name,
      namespace,
      mode: 'simulation',
      manifest,
    };
  }
}

