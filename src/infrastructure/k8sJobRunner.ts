import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import EventEmitter from 'events';
import * as k8s from '@kubernetes/client-node';
import { logger } from '../utils/logger';
import {
  AgentWorkRequest,
  AgentHarnessScope,
  WorkKind,
  AgentExecutionReceipt,
  ReceiptOutcome,
  TaskObserverProposal,
  TaskObserverCheckpoint,
  CandidateEffectPhase,
  AuthoritativeOwnerState,
  EFFECT_OWNER_STATES,
  EFFECT_EDGES,
  ContractError,
  ContractErrorCode,
  requireCondition,
  IdSchema,
  DigestSchema,
  TimestampSchema,
  canonicalJson,
  requestDigest,
  validateWorkRequest,
  validateExecutionReceipt as validateReceiptSchema,
  checkEffectTransition,
  projectEffectState,
  loadPacket,
  MAX_CONTRACT_BYTES,
  MAX_CHECKPOINT_PROPOSALS,
} from '../schemas/agentHarnessContracts';

export {
  type AgentWorkRequest,
  type AgentHarnessScope,
  type AgentExecutionReceipt,
  type ReceiptOutcome,
  type TaskObserverProposal,
  type TaskObserverCheckpoint,
  type CandidateEffectPhase,
  type AuthoritativeOwnerState,
  EFFECT_OWNER_STATES,
  EFFECT_EDGES,
  ContractError,
  type ContractErrorCode,
  canonicalJson,
  requestDigest,
  validateWorkRequest,
  checkEffectTransition,
  projectEffectState,
};

export type AgentWorkRequestV1 = AgentWorkRequest;
export type AgentWorkKind = WorkKind;


export interface K8sJobSpec {
  // Existing fields
  jobName?: string;
  namespace?: string;
  image?: string;
  persona: string;
  repoUrl: string;
  repo?: string;
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

  // Milestone 1 Scope & Fencing parameters
  logicalChildId?: string;
  fencingEpoch?: number;
  missionId?: string;
  generation?: number;
  executionId?: string;
  tenantId?: string;
  environmentId?: string;
  workspaceId?: string;

  // Optional overrides
  workRequest?: AgentWorkRequest;
  idempotencyKey?: string;
  workKind?: WorkKind;
  capabilities?: string[];
  budget?: {
    maxCostMicrousd?: number;
    maxTokens?: number;
    maxDurationMs?: number;
    concurrencyClass?: string;
  };
}

export interface GeneratedK8sJobManifest {
  apiVersion: 'batch/v1';
  kind: 'Job';
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    ttlSecondsAfterFinished: number;
    activeDeadlineSeconds: number;
    backoffLimit: number;
    template: {
      metadata: {
        labels: Record<string, string>;
        annotations?: Record<string, string>;
      };
      spec: {
        restartPolicy: 'Never';
        securityContext?: {
          runAsNonRoot?: boolean;
          runAsUser?: number;
          runAsGroup?: number;
          fsGroup?: number;
        };
        initContainers?: Array<{
          name: string;
          image: string;
          command: string[];
          args?: string[];
          env?: Array<{ name: string; value: string }>;
          volumeMounts: Array<{
            name: string;
            mountPath: string;
            subPath?: string;
          }>;
          securityContext?: {
            allowPrivilegeEscalation?: boolean;
            capabilities?: { drop?: string[] };
          };
        }>;
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
          env: Array<{
            name: string;
            value?: string;
            valueFrom?: {
              fieldRef?: { fieldPath: string };
              secretKeyRef?: { name: string; key: string };
            };
          }>;
          securityContext?: {
            allowPrivilegeEscalation?: boolean;
            capabilities?: { drop?: string[] };
          };
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

export interface K8sJobDispatchResult {
  success: boolean;
  jobName: string;
  namespace: string;
  mode: 'k8s' | 'simulation';
  manifest: GeneratedK8sJobManifest;
  workRequest: AgentWorkRequest;
  requestDigest: string;
  error?: string;
}

export const RECEIPT_LOG_MARKER_START = '-----BEGIN CT-AGENT-EXECUTION-RECEIPT-----';
export const RECEIPT_LOG_MARKER_END = '-----END CT-AGENT-EXECUTION-RECEIPT-----';

export type TaskObserverImpact = 'low' | 'medium' | 'high';

export interface TaskObserverCheckpointInput {
  checkpoint_id: string;
  observed_at: string;
  proposals: Array<{
    candidate_id: string;
    impact: 'low' | 'medium' | 'high';
    recurrence: number;
    phase: CandidateEffectPhase;
    evidence_ref?: string | null;
  }>;
  permission_denied: boolean;
}

export interface TaskObserverCheckpointResult extends TaskObserverCheckpoint {
  accepted: boolean;
  halted: boolean;
  checkpoint: TaskObserverCheckpoint;
  projectedOwnerStates: Array<{
    candidate_id: string;
    phase: CandidateEffectPhase;
    owner_state: AuthoritativeOwnerState;
  }>;
  overflow_count: number;
  error?: string;
}

export interface CandidateEffectRecord {
  candidate_id: string;
  phase: CandidateEffectPhase;
  owner_state: AuthoritativeOwnerState;
  evidence_ref?: string | null;
  updated_at: string;
}

export interface WaitForJobOptions {
  timeoutSeconds?: number;
  pollIntervalMs?: number;
  namespace?: string;
  signal?: AbortSignal;
}

export interface K8sJobStatusResult {
  jobName: string;
  namespace: string;
  succeeded: boolean;
  phase: 'SUCCEEDED' | 'FAILED' | 'TIMEOUT';
  podName?: string;
  nodeName?: string;
  exitCode?: number;
  terminalReason?: string;
  durationMs: number;
  observedAt: string;
  diagnostics?: Array<{ code: string; message: string }>;
}

export type JobCompletionStatus = K8sJobStatusResult;

export interface RetrieveReceiptOptions {
  workspaceMountPath?: string;
  subPath?: string;
  podName?: string;
  namespace?: string;
  forceMissingReceipt?: boolean;
}

export interface SimulationReceiptOptions {
  outcome?: ReceiptOutcome;
  omitEvidence?: boolean;
  tamperDigest?: boolean;
  tamperScope?: boolean;
  unresolvedEffect?: boolean;
  costMicrousd?: number;
  tokens?: number;
  durationMs?: number;
}

export interface K8sJobExecutionOptions {
  timeoutSeconds?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  workspaceMountPath?: string;
  subPath?: string;
}

export interface K8sJobExecutionResult {
  success: boolean;
  jobName: string;
  namespace: string;
  mode: 'k8s' | 'simulation';
  manifest: GeneratedK8sJobManifest;
  workRequest: AgentWorkRequest;
  requestDigest: string;
  completion?: K8sJobStatusResult;
  receipt?: AgentExecutionReceipt;
  durationMs: number;
  error?: string;
  diagnostics?: Array<{ code: string; message: string }>;
}

export interface WorkerCandidate {
  candidateId: string;
  impact: TaskObserverImpact;
  recurrence: number;
  phase: CandidateEffectPhase;
  evidenceRef?: string | null;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FORBIDDEN_NAMESPACES = new Set(['default', 'kube-system', 'kube-public', 'kube-node-lease']);

export function computeRequestDigest(workRequest: AgentWorkRequest): {
  canonicalPayload: string;
  byteLength: number;
  digest: string;
} {
  const canonicalPayload = canonicalJson(workRequest);
  const byteLength = Buffer.byteLength(canonicalPayload, 'utf8');

  if (byteLength > MAX_CONTRACT_BYTES) {
    throw new Error(`PAYLOAD_TOO_LARGE: work request canonical payload is ${byteLength} bytes (max ${MAX_CONTRACT_BYTES})`);
  }

  const hexDigest = crypto.createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
  return {
    canonicalPayload,
    byteLength,
    digest: `sha256:${hexDigest}`,
  };
}

export function normalizeRepository(repoUrl: string): string {
  const stripped = repoUrl
    .trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '');

  if (!REPO_PATTERN.test(stripped)) {
    throw new Error(`INVALID_SHAPE: repository must match org/repo pattern, got '${repoUrl}'`);
  }
  return stripped;
}

export class K8sJobRunner {
  private batchV1Api?: k8s.BatchV1Api;
  private coreV1Api?: k8s.CoreV1Api;
  private isK8sAvailable: boolean = false;
  private namespace: string;
  private defaultImage: string;
  private defaultPvcName: string;
  private workspaceMountPath?: string;
  private observerManager: TaskObserverLifecycleManager = new TaskObserverLifecycleManager();

  constructor(options?: {
    namespace?: string;
    defaultImage?: string;
    defaultPvcName?: string;
    forceSimulation?: boolean;
    workspaceMountPath?: string;
    batchV1Api?: k8s.BatchV1Api;
    coreV1Api?: k8s.CoreV1Api;
  }) {
    const rawNamespace = options?.namespace !== undefined
      ? options.namespace
      : (process.env.K8S_NAMESPACE || 'ct-review-system');

    if (
      typeof rawNamespace !== 'string' ||
      !NAMESPACE_PATTERN.test(rawNamespace) ||
      FORBIDDEN_NAMESPACES.has(rawNamespace) ||
      rawNamespace.startsWith('kube-')
    ) {
      throw new Error(`INVALID_SHAPE: namespace '${rawNamespace}' violates controlled boundary`);
    }
    this.namespace = rawNamespace;

    const defaultImage = options?.defaultImage ?? (process.env.K8S_AGENT_IMAGE || 'ghcr.io/review-yeti-ai/review-yeti-worker:latest');
    if (!defaultImage || typeof defaultImage !== 'string' || defaultImage.trim() === '') {
      throw new Error(`INVALID_SHAPE: defaultImage must be a non-empty string`);
    }
    this.defaultImage = defaultImage;

    const defaultPvcName = options?.defaultPvcName ?? (process.env.K8S_WORKSPACE_PVC || 'ct-review-bot-workspace-pvc');
    if (!defaultPvcName || typeof defaultPvcName !== 'string' || defaultPvcName.trim() === '') {
      throw new Error(`INVALID_SHAPE: defaultPvcName must be a non-empty string`);
    }
    this.defaultPvcName = defaultPvcName;
    this.workspaceMountPath = options?.workspaceMountPath;

    if (options?.batchV1Api) {
      this.batchV1Api = options.batchV1Api;
      this.isK8sAvailable = true;
    }
    if (options?.coreV1Api) {
      this.coreV1Api = options.coreV1Api;
    }

    if (!options?.forceSimulation && process.env.NODE_ENV !== 'test' && !this.batchV1Api) {
      try {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        this.batchV1Api = kc.makeApiClient(k8s.BatchV1Api);
        this.coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
        this.isK8sAvailable = true;
      } catch (err) {
        logger.warn('KubeConfig initialization failed; using simulation mode', { error: (err as Error).message });
        this.isK8sAvailable = false;
      }
    }
  }


  /**
   * Builds an RFC 8785 and schema-compliant AgentWorkRequest envelope.
   */
  public buildWorkRequest(spec: K8sJobSpec): AgentWorkRequest {
    if (spec.workRequest) {
      return validateWorkRequest(spec.workRequest);
    }

    const fencingEpoch = spec.fencingEpoch ?? 1;
    if (typeof fencingEpoch !== 'number' || !Number.isInteger(fencingEpoch) || fencingEpoch < 1) {
      throw new Error(`FENCING_MISMATCH: fencingEpoch must be a positive integer >= 1, got ${fencingEpoch}`);
    }

    const generation = spec.generation ?? 1;
    if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) {
      throw new Error(`INVALID_SHAPE: generation must be a positive integer >= 1, got ${generation}`);
    }

    if (!spec.persona || typeof spec.persona !== 'string' || spec.persona.trim() === '') {
      throw new Error(`INVALID_SHAPE: persona must be a non-empty string`);
    }
    if (typeof spec.prNumber !== 'number' || !Number.isInteger(spec.prNumber) || spec.prNumber < 1) {
      throw new Error(`INVALID_SHAPE: prNumber must be a positive integer >= 1, got ${spec.prNumber}`);
    }
    if (!spec.commitSha || typeof spec.commitSha !== 'string' || spec.commitSha.trim() === '') {
      throw new Error(`INVALID_SHAPE: commitSha must be a valid commit hash or non-empty string`);
    }

    const sanitizedPersona = spec.persona.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const repo = normalizeRepository(spec.repoUrl);

    const tenantId = spec.tenantId ?? (process.env.CT_TENANT_ID || 'ct');
    const environmentId = spec.environmentId ?? (process.env.CT_ENVIRONMENT_ID || 'qualification');
    const workspaceId = spec.workspaceId ?? (process.env.CT_WORKSPACE_ID || 'factory');
    const missionId = spec.missionId ?? `mission-pr${spec.prNumber}-${spec.commitSha.slice(0, 7)}`;
    const logicalChildId = spec.logicalChildId ?? `child-${sanitizedPersona}`;
    const executionId = spec.executionId ?? `exec-${sanitizedPersona}-pr${spec.prNumber}-${spec.commitSha.slice(0, 7)}-g${generation}`;

    // Validate ID fields
    for (const [field, val] of Object.entries({
      tenantId,
      environmentId,
      workspaceId,
      missionId,
      logicalChildId,
      executionId,
    })) {
      if (typeof val !== 'string' || !ID_PATTERN.test(val)) {
        throw new Error(`INVALID_SHAPE: ${field} '${val}' does not match ID pattern`);
      }
    }

    const scope: AgentHarnessScope = {
      tenant_id: tenantId,
      environment_id: environmentId,
      workspace_id: workspaceId,
      repository: repo,
      mission_id: missionId,
      generation,
      execution_id: executionId,
      logical_child_id: logicalChildId,
      fencing_epoch: fencingEpoch,
    };

    const now = new Date();
    // Guarantee exact .000Z millisecond precision
    const nowMs = Math.floor(now.getTime() / 1000) * 1000;
    const createdAt = new Date(nowMs).toISOString();
    const durationSeconds = spec.activeDeadlineSeconds ?? 600;
    const deadline = new Date(nowMs + durationSeconds * 1000).toISOString();

    const commitDigest = 'sha256:' + crypto.createHash('sha256').update(spec.commitSha).digest('hex');

    const workRequest: AgentWorkRequest = {
      schema: 'ct-agent-work-request.v1',
      scope,
      idempotency_key: spec.idempotencyKey ?? `work-${scope.execution_id}`,
      work_kind: spec.workKind ?? 'review',
      profile_ref: 'sha256:' + '0'.repeat(64),
      input_refs: [
        {
          artifact_id: `git-commit-${spec.commitSha.slice(0, 7)}`,
          digest: commitDigest,
          classification: 'synthetic',
        },
      ],
      capabilities: spec.capabilities ?? ['artifact.read', 'review.execute'],
      tool_policy_ref: 'sha256:' + 'a'.repeat(64),
      model_policy_ref: 'sha256:' + 'b'.repeat(64),
      effect_policy_ref: 'sha256:' + 'c'.repeat(64),
      retention_policy_ref: 'sha256:' + 'd'.repeat(64),
      budget: {
        max_cost_microusd: spec.budget?.maxCostMicrousd ?? 1000000,
        max_tokens: spec.budget?.maxTokens ?? 250000,
        max_duration_ms: spec.budget?.maxDurationMs ?? durationSeconds * 1000,
        concurrency_class: spec.budget?.concurrencyClass ?? 'qualification',
      },
      created_at: createdAt,
      deadline,
      parent_execution_id: null,
      correlation_id: `corr-pr${spec.prNumber}-${spec.commitSha.slice(0, 7)}`,
      causation_id: `cause-${scope.mission_id}`,
      provider_eligibility_refs: ['sha256:' + 'e'.repeat(64)],
    };

    return validateWorkRequest(workRequest);
  }

  /**
   * Generates a fully-formed Kubernetes batch/v1 Job manifest for a scoped reviewer agent pod.
   * Injects CT Agent Harness environment variables and stages work-request.json via an initContainer.
   */
  public generateJobManifest(spec: K8sJobSpec): GeneratedK8sJobManifest {
    if (!spec.persona || typeof spec.persona !== 'string' || spec.persona.trim() === '') {
      throw new Error(`INVALID_SHAPE: persona must be a non-empty string`);
    }
    if (typeof spec.prNumber !== 'number' || !Number.isInteger(spec.prNumber) || spec.prNumber < 1) {
      throw new Error(`INVALID_SHAPE: prNumber must be a positive integer >= 1, got ${spec.prNumber}`);
    }
    if (!spec.commitSha || typeof spec.commitSha !== 'string' || spec.commitSha.trim() === '') {
      throw new Error(`INVALID_SHAPE: commitSha must be a non-empty string`);
    }

    const sanitizedPersona = spec.persona.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '') || 'worker';
    if (spec.jobName !== undefined) {
      if (typeof spec.jobName !== 'string' || spec.jobName.trim() === '') {
        throw new Error(`INVALID_SHAPE: jobName must be a non-empty string`);
      }
    }
    let rawJobName = spec.jobName;
    if (!rawJobName) {
      const sanitizedSha = spec.commitSha.slice(0, 7).toLowerCase().replace(/[^a-z0-9]/g, '') || '0000000';
      rawJobName = `ct-agent-${sanitizedPersona}-pr${spec.prNumber}-${sanitizedSha}`;
    }
    const jobName = rawJobName;
    if (typeof jobName !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(jobName)) {
      throw new Error(`INVALID_SHAPE: jobName '${jobName}' does not conform to RFC 1123 DNS subdomain`);
    }

    const namespace = spec.namespace !== undefined ? spec.namespace : this.namespace;

    if (
      typeof namespace !== 'string' ||
      !NAMESPACE_PATTERN.test(namespace) ||
      FORBIDDEN_NAMESPACES.has(namespace) ||
      namespace.startsWith('kube-')
    ) {
      throw new Error(`INVALID_SHAPE: target namespace '${namespace}' is not permitted`);
    }

    const image = spec.image ?? this.defaultImage;
    if (!image || typeof image !== 'string' || image.trim() === '') {
      throw new Error(`INVALID_SHAPE: image must be a non-empty string`);
    }

    const pvcClaimName = spec.pvcClaimName ?? this.defaultPvcName;
    if (!pvcClaimName || typeof pvcClaimName !== 'string' || pvcClaimName.trim() === '') {
      throw new Error(`INVALID_SHAPE: pvcClaimName must be a non-empty string`);
    }

    const ttl = spec.ttlSecondsAfterFinished ?? 300;
    const activeDeadline = spec.activeDeadlineSeconds ?? 600;

    // Construct WorkRequest & Request Digest
    const workRequest = this.buildWorkRequest(spec);
    const { canonicalPayload, digest: reqDigest } = computeRequestDigest(workRequest);
    const scope = workRequest.scope;

    const repoSlug = spec.repo || spec.repoUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/\.git$/, '');
    const sanitizedRepo = repoSlug.replace(/[^a-zA-Z0-9_-]/g, '_');
    const subPath = `repos/${sanitizedRepo}_pr${spec.prNumber}`;

    const attempt = (spec as any).attempt ?? 1;
    const childDir = `.ct-harness/${scope.logical_child_id}/${attempt}`;
    const workRequestPath = `/workspace/${childDir}/work-request.json`;
    const receiptPath = `/workspace/${childDir}/execution-receipt.json`;

    // Authoritative Harness Environment Variables
    const harnessEnv: Array<{
      name: string;
      value?: string;
      valueFrom?: {
        fieldRef?: { fieldPath: string };
        secretKeyRef?: { name: string; key: string };
      };
    }> = [
      { name: 'CT_LOGICAL_CHILD_ID', value: scope.logical_child_id },
      { name: 'CT_FENCING_EPOCH', value: String(scope.fencing_epoch) },
      { name: 'CT_MISSION_ID', value: scope.mission_id },
      { name: 'CT_GENERATION', value: String(scope.generation) },
      { name: 'CT_EXECUTION_ID', value: scope.execution_id },
      { name: 'CT_TENANT_ID', value: scope.tenant_id },
      { name: 'CT_ENVIRONMENT_ID', value: scope.environment_id },
      { name: 'CT_WORKSPACE_ID', value: scope.workspace_id },
      { name: 'CT_REPOSITORY', value: scope.repository },
      { name: 'CT_REQUEST_DIGEST', value: reqDigest },
      { name: 'CT_WORK_REQUEST_PATH', value: workRequestPath },
      { name: 'CT_EXECUTION_RECEIPT_PATH', value: receiptPath },
      // Downward API for pod identity
      {
        name: 'CT_POD_NAME',
        valueFrom: { fieldRef: { fieldPath: 'metadata.name' } },
      },
      {
        name: 'CT_POD_NAMESPACE',
        valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } },
      },
      // Backward-compatible environment variables
      { name: 'PERSONA', value: spec.persona },
      { name: 'PR_NUMBER', value: String(spec.prNumber) },
      { name: 'COMMIT_SHA', value: spec.commitSha },
      { name: 'REPO_URL', value: spec.repoUrl },
      { name: 'WORKSPACE_PATH', value: `/workspace/${subPath}` },
    ];

    // Append custom spec.envVars (excluding collisions with CT_* variables)
    if (spec.envVars) {
      for (const [k, v] of Object.entries(spec.envVars)) {
        if (!k.startsWith('CT_')) {
          harnessEnv.push({ name: k, value: v });
        }
      }
    }

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
          'ct.example.com/logical-child-id': scope.logical_child_id.slice(0, 63),
          'ct.example.com/fencing-epoch': String(scope.fencing_epoch),
        },
        annotations: {
          'ct.example.com/request-digest': reqDigest,
          'ct.example.com/execution-id': scope.execution_id,
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
            annotations: {
              'ct.example.com/request-digest': reqDigest,
            },
          },
          spec: {
            restartPolicy: 'Never',
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
            },
            initContainers: [
              {
                name: 'stage-work-request',
                image,
                command: [
                  'node',
                  '-e',
                  `const fs=require('fs');const d='/workspace/${childDir}';if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true});fs.writeFileSync(d+'/work-request.json',process.env.CT_WORK_REQUEST_PAYLOAD);const l='/workspace/.ct-harness';if(!fs.existsSync(l))fs.mkdirSync(l,{recursive:true});fs.writeFileSync(l+'/work-request.json',process.env.CT_WORK_REQUEST_PAYLOAD);`,
                ],
                env: [
                  {
                    name: 'CT_WORK_REQUEST_PAYLOAD',
                    value: canonicalPayload,
                  },
                ],
                volumeMounts: [
                  {
                    name: 'workspace-volume',
                    mountPath: '/workspace',
                    subPath,
                  },
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ['ALL'] },
                },
              },
            ],
            containers: [
              {
                name: 'reviewer-agent',
                image,
                command: ['node', '/app/dist/agentWorker.js'],
                resources: {
                  requests: {
                    cpu: spec.cpuRequest ?? '250m',
                    memory: spec.memoryRequest ?? '512Mi',
                  },
                  limits: {
                    cpu: spec.cpuLimit ?? '500m',
                    memory: spec.memoryLimit ?? '1Gi',
                  },
                },
                volumeMounts: [
                  {
                    name: 'workspace-volume',
                    mountPath: '/workspace',
                    subPath,
                  },
                ],
                env: harnessEnv,
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ['ALL'] },
                },
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
   * Returns complete dispatch outcome including constructed WorkRequest and cryptographic Request Digest.
   */
  public async dispatchJob(spec: K8sJobSpec): Promise<K8sJobDispatchResult> {
    const workRequest = this.buildWorkRequest(spec);
    const { digest: reqDigest } = computeRequestDigest(workRequest);
    const manifest = this.generateJobManifest({ ...spec, workRequest });
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
        logger.info('Dispatched Kubernetes agent batch Job via K8s API', {
          jobName: manifest.metadata.name,
          namespace,
          requestDigest: reqDigest,
        });
        return {
          success: true,
          jobName: manifest.metadata.name,
          namespace,
          mode: 'k8s',
          manifest,
          workRequest,
          requestDigest: reqDigest,
        };
      } catch (err: any) {
        logger.error('Failed to create K8s agent batch Job', {
          error: err.message,
          jobName: manifest.metadata.name,
          namespace,
        });
        return {
          success: false,
          jobName: manifest.metadata.name,
          namespace,
          mode: 'k8s',
          manifest,
          workRequest,
          requestDigest: reqDigest,
          error: err.message,
        };
      }
    }

    logger.info('Simulated Kubernetes agent sandbox Job dispatch', {
      jobName: manifest.metadata.name,
      persona: spec.persona,
      namespace,
      logicalChildId: workRequest.scope.logical_child_id,
      fencingEpoch: workRequest.scope.fencing_epoch,
      requestDigest: reqDigest,
      pvcClaimName: manifest.spec.template.spec.volumes[0].persistentVolumeClaim?.claimName,
    });

    return {
      success: true,
      jobName: manifest.metadata.name,
      namespace,
      mode: 'simulation',
      manifest,
      workRequest,
      requestDigest: reqDigest,
    };
  }

  /**
   * Polls Kubernetes Job and Pod status until completion or timeout.
   * In simulation mode, returns simulated successful completion immediately.
   */
  public async waitForJobCompletion(
    jobName: string,
    options?: WaitForJobOptions
  ): Promise<K8sJobStatusResult> {
    const startTime = Date.now();
    const namespace = options?.namespace || this.namespace;
    const timeoutMs = (options?.timeoutSeconds ?? 600) * 1000;
    const pollIntervalMs = options?.pollIntervalMs ?? 2000;
    const nowMs = Math.floor(startTime / 1000) * 1000;
    const observedAt = new Date(nowMs).toISOString();

    // 1. Simulation Mode Short-Circuit
    if (!this.isK8sAvailable || !this.batchV1Api) {
      logger.info('waitForJobCompletion simulated for job', { jobName, namespace });
      return {
        jobName,
        namespace,
        succeeded: true,
        phase: 'SUCCEEDED',
        podName: `simulated-pod-${jobName}`,
        exitCode: 0,
        durationMs: 100,
        observedAt,
      };
    }

    // 2. Real Kubernetes API Polling Loop
    let elapsed = 0;
    while (elapsed < timeoutMs) {
      if (options?.signal?.aborted) {
        throw new ContractError('AUTHORITY_DENIED');
      }

      try {
        let jobRes: any;
        if (typeof (this.batchV1Api as any).readNamespacedJobStatus === 'function') {
          try {
            jobRes = await (this.batchV1Api as any).readNamespacedJobStatus({ name: jobName, namespace });
          } catch {
            jobRes = await (this.batchV1Api as any).readNamespacedJobStatus(jobName, namespace);
          }
        } else if (typeof (this.batchV1Api as any).readNamespacedJob === 'function') {
          try {
            jobRes = await (this.batchV1Api as any).readNamespacedJob({ name: jobName, namespace });
          } catch {
            jobRes = await (this.batchV1Api as any).readNamespacedJob(jobName, namespace);
          }
        }

        const status = jobRes?.status || jobRes?.body?.status;

        if (status) {
          const isComplete = status.succeeded && status.succeeded > 0;
          const completeCondition = status.conditions?.find(
            (c: any) => c.type === 'Complete' && c.status === 'True'
          );

          if (isComplete || completeCondition) {
            const podInfo = await this.getPodForJob(jobName, namespace);
            const durationMs = Date.now() - startTime;
            logger.info('Kubernetes Job completed successfully', { jobName, durationMs });
            return {
              jobName,
              namespace,
              succeeded: true,
              phase: 'SUCCEEDED',
              podName: podInfo?.metadata?.name,
              nodeName: podInfo?.spec?.nodeName,
              exitCode: podInfo ? this.extractExitCode(podInfo) : 0,
              durationMs,
              observedAt: new Date().toISOString(),
            };
          }

          const isFailed = status.failed && status.failed > 0;
          const failedCondition = status.conditions?.find(
            (c: any) => c.type === 'Failed' && c.status === 'True'
          );

          if (isFailed || failedCondition) {
            const podInfo = await this.getPodForJob(jobName, namespace);
            const durationMs = Date.now() - startTime;
            const exitCode = podInfo ? this.extractExitCode(podInfo) : 1;
            const terminalReason = failedCondition?.reason || podInfo?.status?.reason || 'JobExecutionFailed';
            const message = failedCondition?.message || podInfo?.status?.message || `Job ${jobName} failed`;

            logger.warn('Kubernetes Job failed', { jobName, terminalReason, exitCode, durationMs });
            return {
              jobName,
              namespace,
              succeeded: false,
              phase: 'FAILED',
              podName: podInfo?.metadata?.name,
              nodeName: podInfo?.spec?.nodeName,
              exitCode,
              terminalReason,
              durationMs,
              observedAt: new Date().toISOString(),
              diagnostics: [{ code: 'POD_FAILED', message }],
            };
          }
        }
      } catch (err: any) {
        logger.warn('Transient error reading job status, retrying', {
          jobName,
          error: err.message,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      elapsed += pollIntervalMs;
    }

    // 3. Timeout Exceeded
    const durationMs = Date.now() - startTime;
    logger.error('Kubernetes Job timed out waiting for completion', { jobName, durationMs });
    return {
      jobName,
      namespace,
      succeeded: false,
      phase: 'TIMEOUT',
      durationMs,
      observedAt: new Date().toISOString(),
      terminalReason: 'DeadlineExceeded',
      diagnostics: [
        {
          code: 'JOB_TIMEOUT',
          message: `Job ${jobName} exceeded timeout of ${timeoutMs}ms`,
        },
      ],
    };
  }

  public async getPodForJob(jobName: string, namespace: string): Promise<k8s.V1Pod | undefined> {
    if (!this.coreV1Api) return undefined;
    try {
      let podList: any;
      const labelSelector = `job-name=${jobName}`;
      if (typeof (this.coreV1Api as any).listNamespacedPod === 'function') {
        try {
          podList = await (this.coreV1Api as any).listNamespacedPod({ namespace, labelSelector });
        } catch {
          podList = await (this.coreV1Api as any).listNamespacedPod(
            namespace,
            undefined,
            undefined,
            undefined,
            undefined,
            labelSelector
          );
        }
      }
      const items = podList?.items || podList?.body?.items || [];
      return items[0];
    } catch {
      return undefined;
    }
  }

  private extractExitCode(pod: k8s.V1Pod): number {
    const containerStatuses = pod.status?.containerStatuses || [];
    for (const cs of containerStatuses) {
      if (cs.state?.terminated?.exitCode !== undefined) {
        return cs.state.terminated.exitCode;
      }
      if (cs.lastState?.terminated?.exitCode !== undefined) {
        return cs.lastState.terminated.exitCode;
      }
    }
    return 0;
  }

  /**
   * Retrieves the raw execution receipt upon pod completion.
   * Primary: Shared workspace volume mount (/workspace/.ct-harness/execution-receipt.json).
   * Fallback: Extraction from Pod stdout/logs demarcated between delimiters.
   * Simulation: In simulation mode without explicit mount/pod options, synthesizes simulation receipt.
   */
  public async retrieveExecutionReceipt(
    jobName: string,
    specOrRequest: K8sJobSpec | AgentWorkRequest,
    options?: RetrieveReceiptOptions
  ): Promise<AgentExecutionReceipt> {
    const workRequest: AgentWorkRequest = (specOrRequest as any).schema === 'ct-agent-work-request.v1'
      ? (specOrRequest as AgentWorkRequest)
      : this.buildWorkRequest(specOrRequest as K8sJobSpec);

    if (options?.forceMissingReceipt) {
      throw new ContractError('RECEIPT_MISSING' as any);
    }

    // Short-circuit in simulation mode if no explicit mount path or real pod is provided
    if (!this.isK8sAvailable || !this.batchV1Api) {
      if (!options?.workspaceMountPath && (!options?.podName || options.podName.startsWith('simulated-pod-') || !this.coreV1Api)) {
        return this.generateSimulationReceipt(workRequest);
      }
    }


    const namespace = options?.namespace || this.namespace;
    const repoSlug = workRequest.scope.repository.replace(/^https?:\/\/[^\/]+\//, '').replace(/\.git$/, '');
    const sanitizedRepo = repoSlug.replace(/[^a-zA-Z0-9_-]/g, '_');
    const prNum = workRequest.correlation_id.replace(/^corr-pr/, '').split('-')[0];
    const subPath = options?.subPath ?? `repos/${sanitizedRepo}_pr${prNum}`;
    const baseMount = options?.workspaceMountPath || this.workspaceMountPath;

    const childId = workRequest.scope.logical_child_id;
    const attempt = String((options as any)?.attempt ?? (specOrRequest as any)?.attempt ?? 1);

    // Strategy 1: Shared Volume / Local Mount Access
    if (baseMount) {
      const candidatePaths = [
        path.join(baseMount, subPath, '.ct-harness', childId, attempt, 'execution-receipt.json'),
        path.join(baseMount, '.ct-harness', childId, attempt, 'execution-receipt.json'),
        path.join(baseMount, subPath, '.ct-harness', 'execution-receipt.json'),
        path.join(baseMount, '.ct-harness', 'execution-receipt.json'),
        path.join(baseMount, 'execution-receipt.json'),
      ];
      for (const receiptFilePath of candidatePaths) {
        if (fs.existsSync(receiptFilePath)) {
          const fileContent = fs.readFileSync(receiptFilePath);
          if (fileContent.byteLength > MAX_CONTRACT_BYTES) {
            throw new ContractError('PAYLOAD_TOO_LARGE');
          }
          const packet = loadPacket(fileContent);
          if (packet.schema !== 'ct-agent-execution-receipt.v1') {
            throw new ContractError('UNSUPPORTED_SCHEMA');
          }
          logger.info('Retrieved execution receipt from shared volume', { receiptFilePath });
          return packet as AgentExecutionReceipt;
        }
      }
    }

    // Strategy 2: Extract from Pod logs
    const podName = options?.podName || (await this.getPodForJob(jobName, namespace))?.metadata?.name;
    if (podName && this.coreV1Api) {
      try {
        let logRes: any;
        if (typeof (this.coreV1Api as any).readNamespacedPodLog === 'function') {
          try {
            logRes = await (this.coreV1Api as any).readNamespacedPodLog({
              name: podName,
              namespace,
              container: 'reviewer-agent',
            });
          } catch {
            logRes = await (this.coreV1Api as any).readNamespacedPodLog(
              podName,
              namespace,
              'reviewer-agent'
            );
          }
        }
        const logText = typeof logRes === 'string' ? logRes : (logRes?.body ?? '');
        const startIdx = logText.indexOf(RECEIPT_LOG_MARKER_START);
        const endIdx = logText.indexOf(RECEIPT_LOG_MARKER_END);

        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          const rawJson = logText.slice(startIdx + RECEIPT_LOG_MARKER_START.length, endIdx).trim();
          const buf = Buffer.from(rawJson, 'utf8');
          if (buf.byteLength > MAX_CONTRACT_BYTES) {
            throw new ContractError('PAYLOAD_TOO_LARGE');
          }
          const packet = loadPacket(buf);
          if (packet.schema !== 'ct-agent-execution-receipt.v1') {
            throw new ContractError('UNSUPPORTED_SCHEMA');
          }
          logger.info('Retrieved execution receipt from pod logs', { podName });
          return packet as AgentExecutionReceipt;
        }
      } catch (err: any) {
        if (err instanceof ContractError) {
          if (err.code === 'PAYLOAD_TOO_LARGE') {
            throw err;
          }
          logger.warn('Failed to parse delimited log marker receipt payload, falling back to receipt missing', {
            podName,
            code: err.code,
            error: err.message,
          });
        } else {
          logger.warn('Failed to read pod logs for receipt extraction', { podName, error: err.message });
        }
      }
    }

    // Strategy 3: Receipt Not Found
    throw new ContractError('RECEIPT_MISSING' as any);
  }



  /**
   * Validates receipt cryptographic binding and scope invariants against the authoritative work request.
   */
  public checkReceiptBinding(
    first: AgentExecutionReceipt | AgentWorkRequest,
    second: AgentWorkRequest | AgentExecutionReceipt
  ): void {
    checkReceiptBinding(first, second);
  }

  /**
   * Validates execution receipt wire structure and binding to the work request.
   */
  public validateExecutionReceipt(
    receiptCandidate: unknown,
    workRequest?: AgentWorkRequest,
    options?: { now?: string }
  ): AgentExecutionReceipt {
    return validateExecutionReceipt(receiptCandidate, workRequest, options);
  }

  /**
   * Deterministically synthesizes a 100% compliant ct-agent-execution-receipt.v1 for simulation mode.
   */
  public generateSimulationReceipt(
    workRequest: AgentWorkRequest,
    overrides?: Partial<AgentExecutionReceipt> & SimulationReceiptOptions
  ): AgentExecutionReceipt {
    return generateSimulationReceipt(workRequest, overrides);
  }

  /**
   * Executes full agent lifecycle: dispatch -> await completion -> retrieve receipt -> validate receipt.
   */
  public async executeJob(
    spec: K8sJobSpec,
    options?: K8sJobExecutionOptions
  ): Promise<K8sJobExecutionResult> {
    const startTime = Date.now();

    // 1. Dispatch Job
    const dispatchResult = await this.dispatchJob(spec);
    if (!dispatchResult.success) {
      return {
        success: false,
        jobName: dispatchResult.jobName,
        namespace: dispatchResult.namespace,
        mode: dispatchResult.mode,
        manifest: dispatchResult.manifest,
        workRequest: dispatchResult.workRequest,
        requestDigest: dispatchResult.requestDigest,
        durationMs: Date.now() - startTime,
        error: dispatchResult.error || 'Job dispatch failed',
        diagnostics: [{ code: 'DISPATCH_FAILED', message: dispatchResult.error || 'Dispatch error' }],
      };
    }

    // 2. Await Completion
    const completion = await this.waitForJobCompletion(dispatchResult.jobName, {
      timeoutSeconds: options?.timeoutSeconds ?? spec.activeDeadlineSeconds ?? 600,
      pollIntervalMs: options?.pollIntervalMs,
      namespace: dispatchResult.namespace,
      signal: options?.signal,
    });

    if (!completion.succeeded) {
      return {
        success: false,
        jobName: dispatchResult.jobName,
        namespace: dispatchResult.namespace,
        mode: dispatchResult.mode,
        manifest: dispatchResult.manifest,
        workRequest: dispatchResult.workRequest,
        requestDigest: dispatchResult.requestDigest,
        completion,
        durationMs: Date.now() - startTime,
        error: completion.terminalReason || 'Job execution failed',
        diagnostics: completion.diagnostics,
      };
    }

    // 3. Retrieve Receipt
    let receipt: AgentExecutionReceipt;
    try {
      receipt = await this.retrieveExecutionReceipt(
        dispatchResult.jobName,
        dispatchResult.workRequest,
        {
          podName: completion.podName,
          namespace: dispatchResult.namespace,
          workspaceMountPath: options?.workspaceMountPath ?? this.workspaceMountPath,
          subPath: options?.subPath,
        }
      );
    } catch (err: any) {
      const code = err instanceof ContractError ? err.code : 'RECEIPT_MISSING';
      return {
        success: false,
        jobName: dispatchResult.jobName,
        namespace: dispatchResult.namespace,
        mode: dispatchResult.mode,
        manifest: dispatchResult.manifest,
        workRequest: dispatchResult.workRequest,
        requestDigest: dispatchResult.requestDigest,
        completion,
        durationMs: Date.now() - startTime,
        error: `Failed to retrieve execution receipt: ${err.message}`,
        diagnostics: [{ code, message: err.message }],
      };
    }

    // Check if execution was halted by classifier denial
    if (this.observerManager.isHalted(dispatchResult.workRequest.scope.execution_id)) {
      return {
        success: false,
        jobName: dispatchResult.jobName,
        namespace: dispatchResult.namespace,
        mode: dispatchResult.mode,
        manifest: dispatchResult.manifest,
        workRequest: dispatchResult.workRequest,
        requestDigest: dispatchResult.requestDigest,
        completion,
        receipt,
        durationMs: Date.now() - startTime,
        error: 'Execution halted due to task observer permission denial',
        diagnostics: [{ code: 'AUTHORITY_DENIED', message: 'Execution halted by classifier denial' }],
      };
    }

    // 4. Validate Receipt against WorkRequest
    try {
      const receiptObservedMs = Date.parse(receipt.observed_at);
      const evalNowMs = Math.max(Date.now(), isNaN(receiptObservedMs) ? Date.now() : receiptObservedMs);
      const validatedReceipt = this.validateExecutionReceipt(receipt, dispatchResult.workRequest, {
        now: new Date(evalNowMs).toISOString(),
      });
      const isSuccess = validatedReceipt.outcome === 'succeeded';
      return {
        success: isSuccess,
        jobName: dispatchResult.jobName,
        namespace: dispatchResult.namespace,
        mode: dispatchResult.mode,
        manifest: dispatchResult.manifest,
        workRequest: dispatchResult.workRequest,
        requestDigest: dispatchResult.requestDigest,
        completion,
        receipt: validatedReceipt,
        durationMs: Date.now() - startTime,
        error: isSuccess ? undefined : `Execution receipt outcome was '${validatedReceipt.outcome}': ${(validatedReceipt as any).failure_reason || 'non-succeeded outcome'}`,
        diagnostics: isSuccess ? [] : [{ code: 'EXECUTION_FAILED', message: `Execution outcome: ${validatedReceipt.outcome}` }],
      };
    } catch (err: any) {
      const code = err instanceof ContractError ? err.code : 'INVALID_SHAPE';
      return {
        success: false,
        jobName: dispatchResult.jobName,
        namespace: dispatchResult.namespace,
        mode: dispatchResult.mode,
        manifest: dispatchResult.manifest,
        workRequest: dispatchResult.workRequest,
        requestDigest: dispatchResult.requestDigest,
        completion,
        receipt,
        durationMs: Date.now() - startTime,
        error: `Receipt validation failed: ${err.message}`,
        diagnostics: [{ code, message: err.message }],
      };
    }
  }

  /**
   * Submits a Task Observer Checkpoint into the runner lifecycle.
   */
  public submitTaskObserverCheckpoint(
    checkpoint: TaskObserverCheckpointInput,
    executionId?: string
  ): TaskObserverCheckpointResult {
    const targetExecId = executionId || (checkpoint as any).execution_id || 'default-execution';
    return this.observerManager.submitCheckpoint(checkpoint, targetExecId);
  }

  /**
   * Maps a candidate effect phase onto authoritative owner state (ct-effect-intent.v1).
   */
  public mapCandidatePhaseToOwnerState(phase: CandidateEffectPhase): AuthoritativeOwnerState {
    return mapCandidatePhaseToOwnerState(phase);
  }

  /**
   * Retrieves all observer checkpoints for an execution.
   */
  public getTaskObserverCheckpoints(executionId: string): TaskObserverCheckpoint[] {
    return this.observerManager.getCheckpoints(executionId);
  }

  /**
   * Checks if an execution was halted by a classifier permission denial.
   */
  public isExecutionHalted(executionId: string): boolean {
    return this.observerManager.isHalted(executionId);
  }

  /**
   * Subscribes to Task Observer lifecycle events.
   */
  public onTaskObserverEvent(
    event: 'checkpoint' | 'phaseTransition' | 'permissionDenied' | 'executionHalted',
    listener: (...args: any[]) => void
  ): void {
    this.observerManager.on(event, listener);
  }
}

// ============================================================================
// Standalone Functions & Helpers
// ============================================================================

/**
 * Checks receipt cryptographic binding, 9-field scope equality, tripartite fencing,
 * and outcome evidence consistency against the authoritative work request.
 */
export function checkReceiptBinding(
  first: AgentExecutionReceipt | AgentWorkRequest,
  second: AgentWorkRequest | AgentExecutionReceipt
): void {
  let receipt: AgentExecutionReceipt;
  let workRequest: AgentWorkRequest;

  if ((first as any)?.schema === 'ct-agent-work-request.v1') {
    workRequest = first as AgentWorkRequest;
    receipt = second as AgentExecutionReceipt;
  } else {
    receipt = first as AgentExecutionReceipt;
    workRequest = second as AgentWorkRequest;
  }

  // 1. Validate work request wire shape
  validateWorkRequest(workRequest);

  // 2. Tripartite Fencing Invariant (takes precedence over REQUEST_DRIFT and SCOPE_MISMATCH)
  if (
    !receipt.lease ||
    typeof receipt.lease.fencing_token !== 'number' ||
    !Number.isInteger(receipt.lease.fencing_token) ||
    receipt.lease.fencing_token < 1 ||
    typeof receipt.lease.attempt !== 'number' ||
    !Number.isInteger(receipt.lease.attempt) ||
    receipt.lease.attempt < 1
  ) {
    throw new ContractError('FENCING_MISMATCH');
  }

  if ((workRequest as any).lease) {
    if (
      receipt.lease.fencing_token !== (workRequest as any).lease.fencing_token ||
      receipt.lease.attempt !== (workRequest as any).lease.attempt ||
      receipt.lease.lease_id !== (workRequest as any).lease.lease_id
    ) {
      throw new ContractError('FENCING_MISMATCH');
    }
  }

  // 3. Request Digest Invariant (takes precedence over SCOPE_MISMATCH and evidence requirements)
  const expectedDigest = requestDigest(workRequest);
  if (receipt.request_digest !== expectedDigest) {
    throw new ContractError('REQUEST_DRIFT');
  }

  // 4. Scope Invariant (9 mandatory fields - takes precedence over evidence requirements)
  const reqScopeCanon = canonicalJson(workRequest.scope);
  const recScopeCanon = canonicalJson(receipt.scope);
  if (reqScopeCanon !== recScopeCanon) {
    throw new ContractError('SCOPE_MISMATCH');
  }

  // 5. Outcome & Evidence Consistency Invariant (takes precedence over UNRESOLVED_EFFECT)
  if (receipt.outcome === 'succeeded') {
    if (!receipt.evidence_refs || !Array.isArray(receipt.evidence_refs) || receipt.evidence_refs.length === 0) {
      throw new ContractError('SUCCESS_EVIDENCE_REQUIRED');
    }
    if (Array.isArray(receipt.effects)) {
      const hasUnresolved = receipt.effects.some((eff: any) => eff?.state !== 'SUCCEEDED');
      if (hasUnresolved) {
        throw new ContractError('UNRESOLVED_EFFECT');
      }
    }
  }

  // 6. Terminal Effect Evidence Invariant
  if (Array.isArray(receipt.effects)) {
    for (const eff of receipt.effects) {
      if (eff && (eff.state === 'SUCCEEDED' || eff.state === 'FAILED')) {
        if (!eff.evidence_ref || !DigestSchema.safeParse(eff.evidence_ref).success) {
          throw new ContractError('EFFECT_EVIDENCE_REQUIRED');
        }
      }
    }
  }

  // 7. Provider Binding Invariant
  if (
    workRequest.provider_eligibility_refs &&
    Array.isArray(workRequest.provider_eligibility_refs) &&
    !workRequest.provider_eligibility_refs.includes(receipt.provider_binding_ref)
  ) {
    throw new ContractError('PROVIDER_MISMATCH');
  }

  // 6. Authoritative Owner State Normalization (ct-effect-intent.v1 -> CandidateEffectPhase)
  if (Array.isArray(receipt.effects)) {
    for (const eff of receipt.effects) {
      if (eff && typeof eff === 'object') {
        if ((eff as any).state === 'IN_FLIGHT') {
          (eff as any).state = 'EXECUTING';
        } else if ((eff as any).state === 'INTENDED') {
          (eff as any).state = 'INTENT';
        }
      }
    }
  }

  // 7. Structural Wire Schema Validation (12 closed properties)
  validateReceiptSchema(receipt);
}

/**
 * Validates candidate execution receipt against ct-agent-execution-receipt.v1 wire schema
 * and validates strict binding against the authoritative AgentWorkRequest envelope.
 */
export function validateExecutionReceipt(
  receiptCandidate: unknown,
  workRequest?: AgentWorkRequest,
  options?: { now?: string }
): AgentExecutionReceipt {
  if (receiptCandidate && typeof receiptCandidate === 'object' && Array.isArray((receiptCandidate as any).effects)) {
    for (const eff of (receiptCandidate as any).effects) {
      if (eff && typeof eff === 'object') {
        if ((eff as any).state === 'IN_FLIGHT') {
          (eff as any).state = 'EXECUTING';
        } else if ((eff as any).state === 'INTENDED') {
          (eff as any).state = 'INTENT';
        }
      }
    }
  }

  const receipt = validateReceiptSchema(receiptCandidate);

  if (workRequest) {
    checkReceiptBinding(receipt, workRequest);

    // Clock Invariants
    const tCreated = Date.parse(workRequest.created_at);
    const tStarted = Date.parse(receipt.started_at);
    const tObserved = Date.parse(receipt.observed_at);
    const tDeadline = Date.parse(workRequest.deadline);
    if (tCreated > tStarted || tStarted > tObserved) {
      throw new ContractError('INVALID_RECEIPT_TIME');
    }
    if (tObserved > tDeadline) {
      throw new ContractError('AUTHORITY_EXPIRED');
    }

    if (options?.now) {
      const tNow = Date.parse(options.now);
      if (tObserved > tNow) {
        throw new ContractError('INVALID_RECEIPT_TIME');
      }
      if (tNow >= tDeadline) {
        throw new ContractError('AUTHORITY_EXPIRED');
      }
    }

    // Budget Invariants
    if (receipt.metering.cost_microusd > workRequest.budget.max_cost_microusd) {
      throw new ContractError('BUDGET_EXCEEDED');
    }
    if (receipt.metering.tokens > workRequest.budget.max_tokens) {
      throw new ContractError('BUDGET_EXCEEDED');
    }
    const durationMs = tObserved - tStarted;
    if (durationMs > workRequest.budget.max_duration_ms) {
      throw new ContractError('BUDGET_EXCEEDED');
    }
  }

  return receipt;
}

/**
 * Deterministically constructs a fully compliant synthetic receipt matching workRequest.scope and requestDigest(workRequest).
 */
export function generateSimulationReceipt(
  workRequest: AgentWorkRequest,
  overrides?: Partial<AgentExecutionReceipt> & SimulationReceiptOptions
): AgentExecutionReceipt {
  validateWorkRequest(workRequest);
  const reqDigest = requestDigest(workRequest);
  const startedAt = workRequest.created_at;
  const startedMs = new Date(startedAt).getTime();
  const durationMs = overrides?.durationMs ?? 5000;
  const observedMs = Math.min(startedMs + durationMs, new Date(workRequest.deadline).getTime() - 1000);
  const observedAt = new Date(Math.floor(observedMs / 1000) * 1000).toISOString();

  const outcome: ReceiptOutcome = (overrides as any)?.outcome ?? 'succeeded';

  const defaultProvider =
    workRequest.provider_eligibility_refs && workRequest.provider_eligibility_refs.length > 0
      ? workRequest.provider_eligibility_refs[0]
      : 'sha256:' + crypto.createHash('sha256').update(`provider-sim-${workRequest.scope.execution_id}`).digest('hex');
  const providerBindingRef = overrides?.provider_binding_ref ?? defaultProvider;

  const evidenceDigest =
    'sha256:' + crypto.createHash('sha256').update(`evidence-${workRequest.scope.execution_id}`).digest('hex');

  const outputArtifactDigest =
    'sha256:' + crypto.createHash('sha256').update(`output-${workRequest.scope.execution_id}`).digest('hex');

  const evidenceRefs = overrides?.omitEvidence ? [] : [evidenceDigest];

  const effectState = overrides?.unresolvedEffect
    ? 'UNKNOWN'
    : outcome === 'succeeded'
    ? 'SUCCEEDED'
    : 'FAILED';

  const effectEvidence = (effectState === 'SUCCEEDED' || effectState === 'FAILED')
    ? evidenceDigest
    : null;

  const effects = [
    {
      effect_id: `eff-${workRequest.scope.logical_child_id}`,
      intent_digest: 'sha256:' + 'a'.repeat(64),
      state: effectState as any,
      evidence_ref: effectEvidence,
    },
  ];

  const scope = overrides?.tamperScope
    ? { ...workRequest.scope, generation: workRequest.scope.generation + 1 }
    : JSON.parse(JSON.stringify(workRequest.scope));

  const finalDigest = overrides?.tamperDigest
    ? 'sha256:' + 'f'.repeat(64)
    : reqDigest;

  const baseReceipt: AgentExecutionReceipt = {
    schema: 'ct-agent-execution-receipt.v1',
    scope,
    request_digest: finalDigest,
    provider_binding_ref: providerBindingRef,
    lease: {
      lease_id: `lease-${workRequest.scope.execution_id}`,
      attempt: 1,
      fencing_token: workRequest.scope.fencing_epoch,
    },
    outcome,
    started_at: startedAt,
    observed_at: observedAt,
    output_refs: [
      {
        artifact_id: `art-review-${workRequest.scope.logical_child_id}`,
        digest: outputArtifactDigest,
        classification: 'synthetic',
      },
    ],
    evidence_refs: evidenceRefs,
    effects,
    metering: {
      cost_microusd: overrides?.costMicrousd ?? Math.min(25000, workRequest.budget.max_cost_microusd),
      tokens: overrides?.tokens ?? Math.min(1250, workRequest.budget.max_tokens),
    },
  };

  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (
        k !== 'omitEvidence' &&
        k !== 'tamperDigest' &&
        k !== 'tamperScope' &&
        k !== 'unresolvedEffect' &&
        k !== 'costMicrousd' &&
        k !== 'tokens' &&
        k !== 'durationMs' &&
        v !== undefined
      ) {
        (baseReceipt as any)[k] = v;
      }
    }
  }

  return baseReceipt;
}

/**
 * Maps CandidateEffectPhase to AuthoritativeOwnerState according to ct-effect-intent.v1 rules:
 * INTENT -> INTENDED
 * EXECUTING -> IN_FLIGHT
 * SUCCEEDED -> SUCCEEDED
 * FAILED -> FAILED
 * UNKNOWN / RECONCILING / MANUAL -> UNKNOWN
 */
export function mapCandidatePhaseToOwnerState(phase: CandidateEffectPhase): AuthoritativeOwnerState {
  return projectEffectState(phase);
}

// Zero-retention forbidden keys
const FORBIDDEN_RETENTION_KEYS = [
  'diff',
  'patch',
  'hunk',
  'transcript',
  'messages',
  'prompt',
  'code',
  'content',
];

/**
 * Validates proposal and enforces strict zero-retention (rejecting raw diffs, transcripts, code).
 */
export function sanitizeCheckpointProposal(raw: Record<string, unknown>): TaskObserverProposal {
  requireCondition(typeof raw === 'object' && raw !== null, 'INVALID_SHAPE');
  for (const key of FORBIDDEN_RETENTION_KEYS) {
    if (key in raw && raw[key] !== undefined && raw[key] !== null) {
      throw new ContractError('INVALID_SHAPE');
    }
  }

  requireCondition(typeof raw.candidate_id === 'string' && IdSchema.safeParse(raw.candidate_id).success, 'INVALID_SHAPE');
  requireCondition(
    raw.impact === 'low' || raw.impact === 'medium' || raw.impact === 'high',
    'INVALID_SHAPE'
  );
  requireCondition(
    typeof raw.recurrence === 'number' && Number.isInteger(raw.recurrence) && raw.recurrence >= 0,
    'INVALID_SHAPE'
  );
  requireCondition(
    raw.phase === 'INTENT' ||
      raw.phase === 'EXECUTING' ||
      raw.phase === 'SUCCEEDED' ||
      raw.phase === 'FAILED' ||
      raw.phase === 'UNKNOWN' ||
      raw.phase === 'RECONCILING' ||
      raw.phase === 'MANUAL',
    'INVALID_SHAPE'
  );
  if (raw.evidence_ref !== undefined && raw.evidence_ref !== null) {
    requireCondition(
      typeof raw.evidence_ref === 'string' && DigestSchema.safeParse(raw.evidence_ref).success,
      'INVALID_SHAPE'
    );
  }

  return {
    candidate_id: raw.candidate_id as string,
    impact: raw.impact as TaskObserverImpact,
    recurrence: raw.recurrence as number,
    phase: raw.phase as CandidateEffectPhase,
    evidence_ref: (raw.evidence_ref as string) || undefined,
  };
}

/**
 * Creates, sorts, and caps a Task Observer Checkpoint (<= 5 candidates) with accurate overflow_count.
 */
export function createTaskObserverCheckpoint(options: {
  checkpoint_id: string;
  observed_at: string;
  proposals: Array<TaskObserverProposal | {
    candidate_id: string;
    impact: TaskObserverImpact;
    recurrence: number;
    phase: CandidateEffectPhase;
    evidence_ref?: string | null;
  }>;
  permission_denied: boolean;
}): TaskObserverCheckpoint {

  requireCondition(typeof options === 'object' && options !== null, 'INVALID_SHAPE');
  requireCondition(IdSchema.safeParse(options.checkpoint_id).success, 'INVALID_SHAPE');
  requireCondition(TimestampSchema.safeParse(options.observed_at).success, 'INVALID_SHAPE');
  requireCondition(typeof options.permission_denied === 'boolean', 'INVALID_SHAPE');
  requireCondition(Array.isArray(options.proposals), 'INVALID_SHAPE');

  const sanitizedProposals = options.proposals.map((p) => sanitizeCheckpointProposal(p as any));

  const sorted = [...sanitizedProposals].sort((a, b) => {
    const impactWeight: Record<TaskObserverImpact, number> = { high: 3, medium: 2, low: 1 };
    const impactDiff = impactWeight[b.impact] - impactWeight[a.impact];
    if (impactDiff !== 0) return impactDiff;
    const recurrenceDiff = b.recurrence - a.recurrence;
    if (recurrenceDiff !== 0) return recurrenceDiff;
    return a.candidate_id.localeCompare(b.candidate_id);
  });

  const capped = sorted.slice(0, MAX_CHECKPOINT_PROPOSALS);
  const overflow = Math.max(0, sorted.length - MAX_CHECKPOINT_PROPOSALS);

  return {
    checkpoint_id: options.checkpoint_id,
    observed_at: options.observed_at,
    proposals: capped,
    overflow_count: overflow,
    permission_denied: options.permission_denied,
  };
}

/**
 * Manages Task Observer lifecycle: tracks checkpoints, effect transitions, and permission denial hard stop.
 */
export class TaskObserverLifecycleManager extends EventEmitter {
  private checkpoints: Map<string, TaskObserverCheckpoint[]> = new Map();
  private effectStates: Map<string, Map<string, CandidateEffectRecord>> = new Map();
  private haltedExecutions: Map<string, boolean> = new Map();

  public submitCheckpoint(
    rawCheckpoint: TaskObserverCheckpointInput,
    executionId: string = 'default-execution'
  ): TaskObserverCheckpointResult {
    requireCondition(IdSchema.safeParse(executionId).success, 'INVALID_SHAPE');

    // 1. If execution was already halted by a prior permission denial, fail closed
    if (this.haltedExecutions.get(executionId)) {
      throw new ContractError('AUTHORITY_DENIED');
    }

    // 2. Validate, sort, and cap proposals (<= 5)
    const checkpoint = createTaskObserverCheckpoint(rawCheckpoint);

    // Atomic permission denial hard-stop:
    // Record halt immediately before processing proposals so isHalted(executionId) is reliably
    // true even if subsequent proposal transitions throw an error.
    if (checkpoint.permission_denied) {
      this.haltedExecutions.set(executionId, true);
      this.emit('permissionDenied', { executionId, checkpoint });
      this.emit('executionHalted', { executionId, reason: 'PERMISSION_DENIED' });
    }

    // 3. Process each proposal and validate state transitions
    let activeMap = this.effectStates.get(executionId);
    if (!activeMap) {
      activeMap = new Map();
      this.effectStates.set(executionId, activeMap);
    }

    const projectedOwnerStates: Array<{
      candidate_id: string;
      phase: CandidateEffectPhase;
      owner_state: AuthoritativeOwnerState;
    }> = [];

    for (const proposal of checkpoint.proposals) {
      const existing = activeMap.get(proposal.candidate_id);
      if (existing) {
        if (existing.phase !== proposal.phase) {
          checkEffectTransition(existing.phase, proposal.phase, proposal.evidence_ref);
        }
      } else {
        if (proposal.phase !== 'INTENT' && proposal.phase !== 'EXECUTING') {
          if (proposal.phase === 'SUCCEEDED' || proposal.phase === 'FAILED') {
            requireCondition(
              typeof proposal.evidence_ref === 'string' && DigestSchema.safeParse(proposal.evidence_ref).success,
              'EFFECT_EVIDENCE_REQUIRED'
            );
          }
        }
      }

      const ownerState = mapCandidatePhaseToOwnerState(proposal.phase);
      activeMap.set(proposal.candidate_id, {
        candidate_id: proposal.candidate_id,
        phase: proposal.phase,
        owner_state: ownerState,
        evidence_ref: proposal.evidence_ref,
        updated_at: checkpoint.observed_at,
      });

      projectedOwnerStates.push({
        candidate_id: proposal.candidate_id,
        phase: proposal.phase,
        owner_state: ownerState,
      });

      this.emit('phaseTransition', {
        executionId,
        candidate_id: proposal.candidate_id,
        previousPhase: existing?.phase,
        newPhase: proposal.phase,
        ownerState,
      });
    }

    // 4. Record checkpoint into execution history
    const history = this.checkpoints.get(executionId) || [];
    history.push(checkpoint);
    this.checkpoints.set(executionId, history);

    this.emit('checkpoint', { executionId, checkpoint });

    // 5. Binary Hard-Stop Check: permission_denied == true
    if (checkpoint.permission_denied) {
      return {
        ...checkpoint,
        accepted: true,
        halted: true,
        checkpoint,
        projectedOwnerStates,
        overflow_count: checkpoint.overflow_count,
        error: 'PERMISSION_DENIED: execution halted by classifier denial',
      };
    }

    return {
      ...checkpoint,
      accepted: true,
      halted: false,
      checkpoint,
      projectedOwnerStates,
      overflow_count: checkpoint.overflow_count,
    };
  }

  public getCheckpoints(executionId: string): TaskObserverCheckpoint[] {
    return [...(this.checkpoints.get(executionId) || [])];
  }

  public getEffectStates(executionId: string): Map<string, CandidateEffectRecord> {
    return new Map(this.effectStates.get(executionId) || new Map());
  }

  public isHalted(executionId: string): boolean {
    return this.haltedExecutions.get(executionId) === true;
  }

  public clear(executionId: string): void {
    this.checkpoints.delete(executionId);
    this.effectStates.delete(executionId);
    this.haltedExecutions.delete(executionId);
  }
}

export const defaultTaskObserverManager = new TaskObserverLifecycleManager();

export function submitTaskObserverCheckpoint(
  checkpoint: TaskObserverCheckpointInput,
  executionId?: string
): TaskObserverCheckpointResult {
  return defaultTaskObserverManager.submitCheckpoint(checkpoint, executionId || 'default-execution');
}

/**
 * Wraps worker lifecycle: candidate tracking, recurrence aggregation, and checkpoint emission.
 */
export class TaskObserverWorkerWrapper {
  private readonly executionId: string;
  private readonly checkpointSubmitter: (cp: TaskObserverCheckpointInput, execId: string) => void;
  private candidates: Map<string, WorkerCandidate> = new Map();
  private checkpointCounter: number = 0;
  private isTerminated: boolean = false;

  constructor(options: {
    executionId: string;
    checkpointSubmitter: (cp: TaskObserverCheckpointInput, execId: string) => void;
  }) {
    this.executionId = options.executionId;
    this.checkpointSubmitter = options.checkpointSubmitter;
  }

  public observeCandidate(candidate: {
    candidateId: string;
    impact: TaskObserverImpact;
    phase: CandidateEffectPhase;
    evidenceRef?: string | null;
  }): void {
    if (this.isTerminated) return;

    const existing = this.candidates.get(candidate.candidateId);
    const recurrence = existing ? existing.recurrence + 1 : 1;

    this.candidates.set(candidate.candidateId, {
      candidateId: candidate.candidateId,
      impact: candidate.impact,
      recurrence,
      phase: candidate.phase,
      evidenceRef: candidate.evidenceRef,
    });
  }

  public updatePhase(candidateId: string, phase: CandidateEffectPhase, evidenceRef?: string | null): void {
    if (this.isTerminated) return;

    const existing = this.candidates.get(candidateId);
    if (!existing) {
      throw new Error(`Candidate '${candidateId}' not found for phase update`);
    }

    existing.phase = phase;
    if (evidenceRef !== undefined) {
      existing.evidenceRef = evidenceRef;
    }
  }

  public emitCheckpoint(options?: { permissionDenied?: boolean }): void {
    if (this.isTerminated) return;

    this.checkpointCounter++;
    const checkpointId = `chk-${this.executionId}-${this.checkpointCounter}`;
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const observedAt = new Date(nowMs).toISOString();
    const permissionDenied = options?.permissionDenied ?? false;

    const proposalInputs = Array.from(this.candidates.values()).map((c) => ({
      candidate_id: c.candidateId,
      impact: c.impact,
      recurrence: c.recurrence,
      phase: c.phase,
      evidence_ref: c.evidenceRef || undefined,
    }));

    const checkpointInput: TaskObserverCheckpointInput = {
      checkpoint_id: checkpointId,
      observed_at: observedAt,
      proposals: proposalInputs,
      permission_denied: permissionDenied,
    };

    this.checkpointSubmitter(checkpointInput, this.executionId);

    if (permissionDenied) {
      this.isTerminated = true;
    }
  }

  public isHalted(): boolean {
    return this.isTerminated;
  }
}

