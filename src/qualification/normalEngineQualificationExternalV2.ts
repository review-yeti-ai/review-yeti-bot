import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { canonicalJson } from '../review/reviewCore';
import { verifyWorkerRuntimeManifest } from '../cli/workerRuntimeManifest';
import type { FetchImplementation } from '../gateway/openRouterClient';
import { NormalEngineQualificationHistoryStore } from './normalEngineQualificationHistory';
import {
  parseNormalEngineQualificationRequest,
  persistNormalEngineQualificationComposedResources,
  persistNormalEngineQualificationProviderIdentifiers,
  persistNormalEngineQualificationReceipt,
  WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE,
} from './normalEngineQualification';
import { NormalEngineQualificationReceiptPersistError, persistNormalEngineQualificationProviderCapture,
  runNormalEngineQualificationCase } from './normalEngineQualificationWorker';

interface ExternalNormalV2Projection {
  stepId: string;
  caseId: string;
  inputPath: string;
  inputSha256: string;
  arm: string;
  historyMode: string;
  targetRepositoryId: number;
  sourceBundleSha256: string;
  runId: string;
  historyRunId?: string;
  runtime: { sourceRevision: string; workerImageDigest: string; runtimeManifestSha256: string };
  policy: { candidateHead: string; candidateRawSha256: string; effectiveConfigSha256: string;
    effectivePolicySha256: string; centralEffectiveConfigProjectionSha256: string;
    preparedExecutionSha256: string; preparedExecutionFile: string;
    routeAlias: string; requestedEffort: string; inferenceBaseUrl: string;
    policySource: { repository: string; repositoryId: number; sourceRef: string; path: string; contentSha256: string } };
}

interface ExternalNormalV2Context {
  signal: AbortSignal;
  deadlineAt: number;
  captureOutsideChild: true;
  artifactStoreRoot: string;
  clientCallAllocation: number;
  recordClientCall(): void;
  readonly clientCallCount: number;
  readonly blockedClientCallCount: number;
}

export interface ExternalNormalV2RouteIdentity {
  schemaVersion: 'ReviewYetiExternalNormalQualificationRouteIdentity.v1';
  routingRuleId: string;
  routingRuleName: string;
  provider: string;
  model: string;
  sourceConfigurationSha256: string;
}

interface ExternalNormalV2MjsRunner {
  validateExternalNormalV2RouteIdentity(value: unknown): ExternalNormalV2RouteIdentity;
  runExternalNormalQualificationV2(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface ExternalNormalV2CollectorModule {
  createExternalNormalV2ExactLogCollector(input: Record<string, unknown>):
    (request: Record<string, unknown>) => Promise<unknown>;
}

type Env = NodeJS.ProcessEnv;

export interface ExternalNormalV2PrivateBinding {
  schemaVersion: 'ReviewYetiExternalNormalQualificationPrivateBinding.v1';
  credentialBindingSha256: string;
  phaseRoot: { canonicalPath: string; uid: number; gid: number; mode: 0o700; initialEntryCount: 0 };
  sourceDescriptor: { repository: string; repositoryId: number; sourceRef: string; path: string;
    contentSha256: string; candidateHead: string; preparedFixtureReviewHead: string };
  transport: { selectedBaseUrl: string; modelAlias: string };
  managementBaseUrl: string;
  policy: {
    candidateGitBlob: string;
    executionPlanFixtureSha256: string;
    executionPlanNormalizedSha256: string;
    preparedExecutionFixtureSha256: string;
    preparedExecutionManifestSha256: string;
    preparedExecutionSha256: string;
    syntheticProjectionFixtureSha256: string;
    centralEffectiveConfigProjectionSha256: string;
    effectiveConfigSha256: string;
    effectivePolicySha256: string;
    v1Promotion: string;
    policyInputDigests: Record<string, string>;
    targetProjections: Array<{ repositoryId: number; normalizedPlanSha256: string;
      centralEffectiveConfigProjectionSha256: string; preparedExecutionSha256: string;
      effectiveConfigSha256: string; effectivePolicySha256: string; preparedExecutionFile: string }>;
  };
  runtime: { finalSourceRevision: string; workerImageDigest: string; runtimeManifestSha256: string;
    publicationAttestationSha256: string };
}

const WORKER_IMAGE_REPOSITORY = 'ghcr.io/review-yeti-ai/review-yeti-worker';
const IMAGE_RESULT_MARKER = '__EXTERNAL_NORMAL_V2_RESULT__';
const MAX_IMAGE_STDOUT_BYTES = 512 * 1024;
const MAX_IMAGE_STDOUT_LINE_BYTES = 128 * 1024;

type ExternalNormalV2PreChildFailure =
  | { stage: 'case_environment'; code: 'required_binding_missing' }
  | { stage: 'inference_credential'; code: 'inference_credential_unavailable' }
  | { stage: 'pinned_image'; code: 'pinned_worker_image_unavailable' }
  | { stage: 'container_spawn'; code: 'docker_launcher_unavailable' };

type ExternalNormalV2ChildError = Error & { clientAttemptsMayHaveBeenSent: boolean;
  preChildFailure?: ExternalNormalV2PreChildFailure };

function childExecutionError(code: string, clientAttemptsMayHaveBeenSent: boolean,
  preChildFailure?: ExternalNormalV2PreChildFailure): ExternalNormalV2ChildError {
  return Object.assign(new Error(code), { clientAttemptsMayHaveBeenSent,
    ...(preChildFailure ? { preChildFailure } : {}) });
}

const QUALIFICATION_ENV_ALLOWLIST = [
  'NODE_ENV', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'REVIEW_MODEL', 'REVIEW_PREPARED_CONFIG_JSON',
  'REVIEW_POLICY_DIGEST', 'REVIEW_CONFIG_DIGEST', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_SOURCE_REVISION',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_WORKER_IMAGE_DIGEST', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_TARGET', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_SELECTION_PURPOSE',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPOSITORY_ID', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_OWNER',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPO', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REF',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_PATH', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_SHA256',
] as const;
const WORKER_CASE_REQUIRED_ENV_KEYS = [
  'NODE_ENV', 'OPENAI_BASE_URL', 'REVIEW_MODEL', 'REVIEW_CONFIG_DIGEST', 'REVIEW_POLICY_DIGEST',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_TARGET', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPOSITORY_ID',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_OWNER', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPO',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REF', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_PATH',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_SHA256',
] as const;

function buildPinnedWorkerCaseEnvironment(binding: ExternalNormalV2PrivateBinding): Env {
  const source = binding.sourceDescriptor;
  const [sourceOwner, sourceRepo] = source.repository.split('/');
  const workerEnv: Env = {
    NODE_ENV: 'production',
    OPENAI_BASE_URL: binding.transport.selectedBaseUrl,
    REVIEW_MODEL: binding.transport.modelAlias,
    REVIEW_CONFIG_DIGEST: binding.policy.effectiveConfigSha256,
    REVIEW_POLICY_DIGEST: binding.policy.effectivePolicySha256,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_TARGET: source.repository,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPOSITORY_ID: String(source.repositoryId),
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_OWNER: sourceOwner,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPO: sourceRepo,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REF: source.sourceRef,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_PATH: source.path,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_SHA256: source.contentSha256,
  };
  if (!sourceOwner || !sourceRepo || WORKER_CASE_REQUIRED_ENV_KEYS.some((key) => !workerEnv[key]?.trim())) {
    throw childExecutionError('external_normal_v2_worker_case_environment_invalid', false,
      { stage: 'case_environment', code: 'required_binding_missing' });
  }
  return workerEnv;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requiredEnv(env: Env, key: string): string {
  const value = String(env[key] ?? '').trim();
  if (!value) throw new Error(`external_normal_v2_required_binding_missing:${key}`);
  return value;
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|'));
}

const EXTERNAL_NORMAL_V2_CREDENTIAL_FREE_ARMS = new Set([
  'provider-failure', 'preflight-source-coverage-control', 'repair-head-history-unavailable',
]);
const EXTERNAL_NORMAL_V2_SUPPORTED_CASE_ARMS = new Set([
  'p2-only', 'repair-introduction', 'repair-head-history', 'repair-head-empty-history', 'provider-failure',
  'resource-exhaustion', 'repair-head-history-unavailable', 'preflight-source-coverage-control',
]);
const EXTERNAL_NORMAL_V2_PROJECTION_KEYS = new Set([
  'stepId', 'caseId', 'inputPath', 'inputSha256', 'arm', 'historyMode', 'targetRepositoryId',
  'sourceBundleSha256', 'runId', 'historyRunId', 'runtime', 'policy',
]);
const EXTERNAL_NORMAL_V2_REQUIRED_PROJECTION_KEYS = [
  'stepId', 'caseId', 'inputPath', 'inputSha256', 'arm', 'historyMode', 'targetRepositoryId',
  'sourceBundleSha256', 'runId', 'runtime', 'policy',
];
const MAX_EXTERNAL_NORMAL_V2_CREDENTIAL_BYTES = 8 * 1024;

function isValidInferenceCredential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    && Buffer.byteLength(value, 'utf8') <= MAX_EXTERNAL_NORMAL_V2_CREDENTIAL_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function hasValidExternalNormalV2Projection(value: unknown): value is ExternalNormalV2Projection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const projection = value as Record<string, unknown>;
  const arm = projection.arm;
  return Object.keys(projection).every((key) => EXTERNAL_NORMAL_V2_PROJECTION_KEYS.has(key))
    && EXTERNAL_NORMAL_V2_REQUIRED_PROJECTION_KEYS.every((key) => Object.hasOwn(projection, key))
    && typeof arm === 'string' && EXTERNAL_NORMAL_V2_SUPPORTED_CASE_ARMS.has(arm);
}

export function validateExternalNormalV2PrivateBinding(value: unknown, env?: Env): ExternalNormalV2PrivateBinding {
  const binding = value as unknown as ExternalNormalV2PrivateBinding;
  const bindingKeys = ['schemaVersion', 'credentialBindingSha256', 'phaseRoot', 'sourceDescriptor', 'transport', 'managementBaseUrl', 'policy', 'runtime'];
  const phaseRootKeys = ['canonicalPath', 'uid', 'gid', 'mode', 'initialEntryCount'];
  const sourceKeys = ['repository', 'repositoryId', 'sourceRef', 'path', 'contentSha256', 'candidateHead', 'preparedFixtureReviewHead'];
  const transportKeys = ['selectedBaseUrl', 'modelAlias'];
  const policyKeys = ['candidateGitBlob', 'executionPlanFixtureSha256', 'executionPlanNormalizedSha256',
    'preparedExecutionFixtureSha256', 'preparedExecutionManifestSha256', 'preparedExecutionSha256',
    'syntheticProjectionFixtureSha256', 'centralEffectiveConfigProjectionSha256', 'effectiveConfigSha256',
    'effectivePolicySha256', 'v1Promotion', 'policyInputDigests', 'targetProjections'];
  const policyInputKeys = ['candidatePath', 'executionPlanFixturePath', 'preparedExecutionFixturePath',
    'syntheticProjectionPath', 'preparedExecutionManifestPath'];
  const targetKeys = ['repositoryId', 'normalizedPlanSha256', 'centralEffectiveConfigProjectionSha256',
    'preparedExecutionSha256', 'effectiveConfigSha256', 'effectivePolicySha256', 'preparedExecutionFile'];
  const policyDigestKeys = ['executionPlanFixtureSha256', 'executionPlanNormalizedSha256', 'preparedExecutionFixtureSha256',
    'preparedExecutionManifestSha256', 'preparedExecutionSha256', 'syntheticProjectionFixtureSha256',
    'centralEffectiveConfigProjectionSha256', 'effectiveConfigSha256', 'effectivePolicySha256'] as const;
  const targetDigestKeys = ['normalizedPlanSha256', 'centralEffectiveConfigProjectionSha256',
    'preparedExecutionSha256', 'effectiveConfigSha256', 'effectivePolicySha256'] as const;
  const runtimeKeys = ['finalSourceRevision', 'workerImageDigest', 'runtimeManifestSha256', 'publicationAttestationSha256'];
  if (!hasExactKeys(value, bindingKeys) || binding.schemaVersion !== 'ReviewYetiExternalNormalQualificationPrivateBinding.v1'
    || typeof binding.credentialBindingSha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(binding.credentialBindingSha256)
    || !hasExactKeys(binding.phaseRoot, phaseRootKeys) || typeof binding.phaseRoot.canonicalPath !== 'string'
    || !resolve(binding.phaseRoot.canonicalPath).startsWith('/') || resolve(binding.phaseRoot.canonicalPath) !== binding.phaseRoot.canonicalPath
    || !Number.isSafeInteger(binding.phaseRoot.uid) || (binding.phaseRoot.uid as number) < 0
    || !Number.isSafeInteger(binding.phaseRoot.gid) || (binding.phaseRoot.gid as number) < 0
    || binding.phaseRoot.mode !== 0o700 || binding.phaseRoot.initialEntryCount !== 0
    || !hasExactKeys(binding.sourceDescriptor, sourceKeys)
    || typeof binding.sourceDescriptor.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(binding.sourceDescriptor.repository)
    || binding.sourceDescriptor.repository.split('/').some((part) => part === '.' || part === '..')
    || !Number.isSafeInteger(binding.sourceDescriptor.repositoryId) || (binding.sourceDescriptor.repositoryId as number) < 1
    || typeof binding.sourceDescriptor.sourceRef !== 'string' || !/^[a-f0-9]{40}$/iu.test(binding.sourceDescriptor.sourceRef)
    || typeof binding.sourceDescriptor.path !== 'string' || !binding.sourceDescriptor.path
    || binding.sourceDescriptor.path.startsWith('/') || binding.sourceDescriptor.path.includes('\\')
    || binding.sourceDescriptor.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    || typeof binding.sourceDescriptor.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(binding.sourceDescriptor.contentSha256)
    || typeof binding.sourceDescriptor.candidateHead !== 'string' || !/^[a-f0-9]{40}$/iu.test(binding.sourceDescriptor.candidateHead)
    || typeof binding.sourceDescriptor.preparedFixtureReviewHead !== 'string'
    || !/^[a-f0-9]{40}$/iu.test(binding.sourceDescriptor.preparedFixtureReviewHead)
    || !hasExactKeys(binding.transport, transportKeys) || typeof binding.transport.selectedBaseUrl !== 'string'
    || typeof binding.transport.modelAlias !== 'string' || !/^[A-Za-z0-9._/-]+$/u.test(binding.transport.modelAlias)
    || typeof binding.managementBaseUrl !== 'string'
    || !hasExactKeys(binding.policy, policyKeys)
    || typeof binding.policy.candidateGitBlob !== 'string' || !/^[a-f0-9]{40}$/iu.test(binding.policy.candidateGitBlob)
    || !policyDigestKeys
      .every((key) => typeof binding.policy[key] === 'string' && /^[a-f0-9]{64}$/iu.test(binding.policy[key]))
    || typeof binding.policy.v1Promotion !== 'string' || !binding.policy.v1Promotion
    || !hasExactKeys(binding.policy.policyInputDigests, policyInputKeys)
    || !policyInputKeys.every((key) => typeof binding.policy.policyInputDigests[key] === 'string'
      && /^[a-f0-9]{64}$/iu.test(binding.policy.policyInputDigests[key]))
    || binding.policy.policyInputDigests.candidatePath !== binding.sourceDescriptor.contentSha256
    || !Array.isArray(binding.policy.targetProjections) || binding.policy.targetProjections.length !== 3
    || binding.policy.targetProjections.some((target) => !hasExactKeys(target, targetKeys)
      || !Number.isSafeInteger(target.repositoryId) || (target.repositoryId as number) < 1
      || !targetDigestKeys.every((key) => typeof target[key] === 'string'
          && /^[a-f0-9]{64}$/iu.test(target[key] as string))
      || target.preparedExecutionSha256 !== binding.policy.preparedExecutionSha256
      || target.centralEffectiveConfigProjectionSha256 !== binding.policy.centralEffectiveConfigProjectionSha256
      || target.effectiveConfigSha256 !== binding.policy.effectiveConfigSha256
      || target.effectivePolicySha256 !== binding.policy.effectivePolicySha256
      || target.preparedExecutionFile !== `prepared-host/prepared-${target.repositoryId}-default.json`)
    || !hasExactKeys(binding.runtime, runtimeKeys)
    || typeof binding.runtime.finalSourceRevision !== 'string' || !/^[a-f0-9]{40}$/iu.test(binding.runtime.finalSourceRevision)
    || typeof binding.runtime.workerImageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/iu.test(binding.runtime.workerImageDigest)
    || typeof binding.runtime.runtimeManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(binding.runtime.runtimeManifestSha256)
    || typeof binding.runtime.publicationAttestationSha256 !== 'string'
    || !/^[a-f0-9]{64}$/iu.test(binding.runtime.publicationAttestationSha256)) {
    throw new Error('external_normal_v2_private_binding_invalid');
  }
  let selectedBase: URL; let managementBase: URL;
  try {
    selectedBase = new URL(binding.transport.selectedBaseUrl);
    managementBase = new URL(binding.managementBaseUrl);
  } catch { throw new Error('external_normal_v2_private_binding_invalid'); }
  if (selectedBase.protocol !== 'https:' || selectedBase.username || selectedBase.password || selectedBase.search || selectedBase.hash
    || selectedBase.pathname === '/' || selectedBase.pathname.endsWith('/')
    || managementBase.protocol !== 'https:' || managementBase.username || managementBase.password
    || managementBase.search || managementBase.hash || managementBase.pathname !== '/') {
    throw new Error('external_normal_v2_private_binding_invalid');
  }
  if (env) {
    const [owner, repository] = binding.sourceDescriptor.repository.split('/');
    if (requiredEnv(env, 'OPENAI_BASE_URL') !== binding.transport.selectedBaseUrl
      || requiredEnv(env, 'REVIEW_MODEL') !== binding.transport.modelAlias
      || requiredEnv(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_TARGET') !== binding.sourceDescriptor.repository
      || Number(requiredEnv(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPOSITORY_ID')) !== binding.sourceDescriptor.repositoryId
      || requiredEnv(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_OWNER') !== owner
      || requiredEnv(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPO') !== repository
      || requiredEnv(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REF') !== binding.sourceDescriptor.sourceRef
      || requiredEnv(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_PATH') !== binding.sourceDescriptor.path
      || requiredEnv(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_SHA256') !== binding.sourceDescriptor.contentSha256
      || requiredEnv(env, 'REVIEW_CONFIG_DIGEST') !== binding.policy.effectiveConfigSha256
      || requiredEnv(env, 'REVIEW_POLICY_DIGEST') !== binding.policy.effectivePolicySha256
      || requiredEnv(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_SOURCE_REVISION') !== binding.runtime.finalSourceRevision
      || requiredEnv(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_WORKER_IMAGE_DIGEST') !== binding.runtime.workerImageDigest
      || requiredEnv(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256') !== binding.runtime.runtimeManifestSha256) {
      throw new Error('external_normal_v2_private_binding_environment_mismatch');
    }
    let prepared: { transport?: { baseUrl?: unknown; model?: unknown };
      config?: { review_configuration_receipt?: { effective?: { provider?: { requested_effort?: unknown } } } } };
    try { prepared = JSON.parse(requiredEnv(env, 'REVIEW_PREPARED_CONFIG_JSON')) as typeof prepared; }
    catch { throw new Error('external_normal_v2_private_binding_prepared_config_invalid'); }
    if (prepared.transport?.baseUrl !== binding.transport.selectedBaseUrl || prepared.transport?.model !== binding.transport.modelAlias
      || prepared.config?.review_configuration_receipt?.effective?.provider?.requested_effort !== 'medium') {
      throw new Error('external_normal_v2_private_binding_prepared_transport_mismatch');
    }
  }
  return binding;
}

export function trustedPreparedBudget(env: Env): { total: number; investigation: number; verifier: number; maxTasks: number } {
  const raw = requiredEnv(env, 'REVIEW_PREPARED_CONFIG_JSON');
  let prepared: unknown;
  try { prepared = JSON.parse(raw); } catch { throw new Error('external_normal_v2_prepared_execution_invalid'); }
  const root = prepared as { config?: { review_configuration_receipt?: { effective?: {
    composed_budget?: { provider_attempt_budget?: Record<string, unknown>; central_policy_max_tasks?: unknown;
      central_policy_total_turns?: unknown };
  } } } };
  const composedBudget = root.config?.review_configuration_receipt?.effective?.composed_budget;
  const budget = composedBudget?.provider_attempt_budget;
  const centralTotalTurns = composedBudget?.central_policy_total_turns;
  const total = budget?.total_limit;
  const investigation = budget?.investigation_limit;
  const verifier = budget?.verifier_reserve;
  const maxTasks = composedBudget?.central_policy_max_tasks;
  if (budget?.capability_version !== 'ReviewProviderAttemptBudget.v1'
    || total !== 100 || investigation !== 88 || verifier !== 12
    || budget.operator_override_value !== null
    || centralTotalTurns !== 100
    || maxTasks !== 8) {
    throw new Error('external_normal_v2_trusted_attempt_budget_mismatch');
  }
  return { total, investigation, verifier, maxTasks };
}

async function readPreparedExecutionJson(policyInputRoot: string, projection: ExternalNormalV2Projection): Promise<string> {
  const relativePath = projection.policy.preparedExecutionFile;
  if (relativePath !== `prepared-host/prepared-${projection.targetRepositoryId}-default.json`) {
    throw new Error('external_normal_v2_prepared_target_file_invalid');
  }
  const requestedRoot = resolve(policyInputRoot);
  const root = await realpath(requestedRoot);
  const rootInfo = await lstat(requestedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || (rootInfo.mode & 0o077) !== 0) {
    throw new Error('external_normal_v2_prepared_root_invalid');
  }
  const absolute = resolve(root, relativePath);
  if (!absolute.startsWith(`${root}/`)) throw new Error('external_normal_v2_prepared_target_path_escape');
  let cursor = root;
  for (const segment of relativePath.split('/')) {
    cursor = resolve(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error('external_normal_v2_prepared_target_symlink_forbidden');
    if (cursor !== absolute && !info.isDirectory()) throw new Error('external_normal_v2_prepared_target_parent_invalid');
    if (cursor === absolute && (!info.isFile() || (info.mode & 0o077) !== 0)) {
      throw new Error('external_normal_v2_prepared_target_file_invalid');
    }
  }
  const bytes = await readFile(absolute);
  if (sha256(bytes.toString('utf8')) !== projection.policy.preparedExecutionSha256) {
    throw new Error('external_normal_v2_prepared_execution_digest_mismatch');
  }
  return bytes.toString('utf8');
}

async function validateArtifactStoreRoot(storeRoot: string): Promise<string> {
  if (typeof storeRoot !== 'string' || !resolve(storeRoot).startsWith('/')) {
    throw new Error('external_normal_v2_artifact_store_root_invalid');
  }
  const canonical = await realpath(resolve(storeRoot));
  const info = await lstat(resolve(storeRoot));
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
    throw new Error('external_normal_v2_artifact_store_root_invalid');
  }
  return canonical;
}

async function ensureNormalEngineQualificationStoreRoot(phaseRoot: string): Promise<string> {
  const storeRoot = resolve(phaseRoot, 'normal-engine-qualification-store');
  try { await mkdir(storeRoot, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('external_normal_v2_artifact_store_unavailable');
  }
  const [rootInfo, storeInfo] = await Promise.all([lstat(phaseRoot), lstat(storeRoot)]);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || storeInfo.isSymbolicLink() || !storeInfo.isDirectory()
    || storeInfo.uid !== rootInfo.uid || (storeInfo.mode & 0o077) !== 0 || (storeInfo.mode & 0o700) !== 0o700) {
    throw new Error('external_normal_v2_artifact_store_invalid');
  }
  const canonicalStoreRoot = await realpath(storeRoot);
  if (canonicalStoreRoot !== storeRoot) throw new Error('external_normal_v2_artifact_store_invalid');
  return canonicalStoreRoot;
}

function buildCaseEnvironment(baseEnv: Env, projection: ExternalNormalV2Projection,
  privateBinding: ExternalNormalV2PrivateBinding | undefined, inferenceKey?: string,
  preparedExecutionJson?: string): Env {
  if (!projection || Object.keys(projection).some((key) => ![
    'stepId', 'caseId', 'inputPath', 'inputSha256', 'arm', 'historyMode', 'targetRepositoryId',
    'sourceBundleSha256', 'runId', 'historyRunId', 'runtime', 'policy',
  ].includes(key))) throw new Error('external_normal_v2_worker_projection_invalid');
  const required = new Set<string>(QUALIFICATION_ENV_ALLOWLIST);
  const childEnv: Env = { NODE_ENV: baseEnv.NODE_ENV || 'production' };
  for (const key of required) {
    if (key === 'OPENAI_API_KEY') continue;
    const value = baseEnv[key];
    if (value !== undefined) childEnv[key] = value;
  }
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_ONLY = 'true';
  childEnv.REVIEW_PUBLICATION_MODE = 'disabled';
  childEnv.REVIEW_RECEIPT_PATH = '/workspace/.review-yeti/normal-engine-qualification.json';
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID = projection.runId;
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID = projection.caseId;
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM = projection.arm;
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT = 'prepared-policy-default-v1';
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_SOURCE_REVISION = projection.runtime.sourceRevision;
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_WORKER_IMAGE_DIGEST = projection.runtime.workerImageDigest;
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256 = projection.runtime.runtimeManifestSha256;
  childEnv.REVIEW_PREPARED_CONFIG_JSON = preparedExecutionJson ?? requiredEnv(baseEnv, 'REVIEW_PREPARED_CONFIG_JSON');
  childEnv.REVIEW_POLICY_DIGEST = projection.policy.effectivePolicySha256;
  childEnv.REVIEW_CONFIG_DIGEST = projection.policy.effectiveConfigSha256;
  if (privateBinding) validateExternalNormalV2PrivateBinding(privateBinding, baseEnv);
  const [policyOwner, policyRepo] = projection.policy.policySource.repository.split('/');
  const preparedTargetBinding = privateBinding?.policy.targetProjections
    .find((target) => target.repositoryId === projection.targetRepositoryId);
  if (!policyOwner || !policyRepo
    || (privateBinding && (projection.policy.policySource.repository !== privateBinding.sourceDescriptor.repository
      || projection.policy.policySource.repositoryId !== privateBinding.sourceDescriptor.repositoryId
      || projection.policy.policySource.sourceRef !== privateBinding.sourceDescriptor.sourceRef
      || projection.policy.policySource.path !== privateBinding.sourceDescriptor.path
      || projection.policy.policySource.contentSha256 !== privateBinding.sourceDescriptor.contentSha256
      || projection.policy.candidateHead !== privateBinding.sourceDescriptor.candidateHead
      || projection.policy.candidateRawSha256 !== privateBinding.sourceDescriptor.contentSha256
      || projection.policy.effectiveConfigSha256 !== privateBinding.policy.effectiveConfigSha256
      || projection.policy.effectivePolicySha256 !== privateBinding.policy.effectivePolicySha256
      || projection.policy.centralEffectiveConfigProjectionSha256 !== privateBinding.policy.centralEffectiveConfigProjectionSha256
      || !preparedTargetBinding
      || projection.policy.preparedExecutionSha256 !== preparedTargetBinding.preparedExecutionSha256
      || projection.policy.effectiveConfigSha256 !== preparedTargetBinding.effectiveConfigSha256
      || projection.policy.effectivePolicySha256 !== preparedTargetBinding.effectivePolicySha256
      || projection.policy.centralEffectiveConfigProjectionSha256 !== preparedTargetBinding.centralEffectiveConfigProjectionSha256))
    || requiredEnv(baseEnv, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_TARGET') !== projection.policy.policySource.repository
    || Number(requiredEnv(baseEnv, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPOSITORY_ID')) !== projection.policy.policySource.repositoryId
    || requiredEnv(baseEnv, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_OWNER') !== policyOwner
    || requiredEnv(baseEnv, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPO') !== policyRepo
    || requiredEnv(baseEnv, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REF') !== projection.policy.policySource.sourceRef
    || requiredEnv(baseEnv, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_PATH') !== projection.policy.policySource.path
    || requiredEnv(baseEnv, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_SHA256') !== projection.policy.policySource.contentSha256
    || requiredEnv(baseEnv, 'REVIEW_CONFIG_DIGEST') !== projection.policy.effectiveConfigSha256
    || requiredEnv(baseEnv, 'REVIEW_POLICY_DIGEST') !== projection.policy.effectivePolicySha256
    || requiredEnv(baseEnv, 'OPENAI_BASE_URL') !== projection.policy.inferenceBaseUrl
    || requiredEnv(baseEnv, 'REVIEW_MODEL') !== projection.policy.routeAlias
    || projection.policy.requestedEffort !== 'medium'
    || projection.policy.policySource.contentSha256 !== projection.policy.candidateRawSha256) {
    throw new Error('external_normal_v2_policy_source_binding_invalid');
  }
  const selectedBaseUrl = privateBinding?.transport.selectedBaseUrl ?? projection.policy.inferenceBaseUrl;
  const selectedModelAlias = privateBinding?.transport.modelAlias ?? projection.policy.routeAlias;
  const parentSourceId = Number(requiredEnv(baseEnv, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPOSITORY_ID'));
  if (parentSourceId !== projection.policy.policySource.repositoryId) {
    throw new Error('external_normal_v2_policy_source_id_mismatch');
  }
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_TARGET = projection.policy.policySource.repository;
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPOSITORY_ID = String(projection.policy.policySource.repositoryId);
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_OWNER = policyOwner;
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPO = policyRepo;
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REF = projection.policy.policySource.sourceRef;
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_PATH = projection.policy.policySource.path;
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_SHA256 = projection.policy.policySource.contentSha256;
  childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_SELECTION_PURPOSE = 'qualification-only-target-binding';
  childEnv.OPENAI_BASE_URL = selectedBaseUrl;
  childEnv.REVIEW_MODEL = selectedModelAlias;
  if (projection.historyRunId) childEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_RUN_ID = projection.historyRunId;
  if (inferenceKey !== undefined && projection.arm !== 'provider-failure') childEnv.OPENAI_API_KEY = inferenceKey;
  else delete childEnv.OPENAI_API_KEY;
  const parsed = parseNormalEngineQualificationRequest(childEnv);
  const prepared = JSON.parse(requiredEnv(childEnv, 'REVIEW_PREPARED_CONFIG_JSON')) as {
    transport?: { baseUrl?: unknown; model?: unknown };
    config?: { review_configuration_receipt?: { effective?: { provider?: { requested_effort?: unknown } } } };
  };
  if (parsed.runId !== projection.runId || parsed.fixture.caseId !== projection.caseId
    || parsed.fixture.inputSha256 !== projection.inputSha256 || parsed.fixture.repository.repositoryId !== projection.targetRepositoryId
    || parsed.arm !== projection.arm || parsed.policy.configDigest !== projection.policy.effectiveConfigSha256
    || parsed.policy.policyDigest !== projection.policy.effectivePolicySha256
    || parsed.policy.sourceOwner !== policyOwner || parsed.policy.sourceRepo !== policyRepo
    || parsed.policy.sourceRef !== projection.policy.policySource.sourceRef
    || parsed.policy.sourcePath !== projection.policy.policySource.path
    || parsed.policy.sourceContentSha256 !== projection.policy.policySource.contentSha256
    || parsed.runtime.sourceRevision !== projection.runtime.sourceRevision
    || parsed.runtime.workerImageDigest !== projection.runtime.workerImageDigest
    || parsed.runtime.runtimeManifestSha256 !== projection.runtime.runtimeManifestSha256
    || childEnv.OPENAI_BASE_URL !== selectedBaseUrl
    || childEnv.REVIEW_MODEL !== selectedModelAlias
    || prepared.transport?.baseUrl !== selectedBaseUrl
    || prepared.transport?.model !== selectedModelAlias
    || prepared.config?.review_configuration_receipt?.effective?.provider?.requested_effort !== 'medium'
    || parsed.historyRunId !== (projection.historyRunId ?? null)) {
    throw new Error('external_normal_v2_worker_binding_mismatch');
  }
  return childEnv;
}

function budgetProfileForArm(arm: string): string {
  if (arm === 'preflight-source-coverage-control') return 'source-coverage-preflight-15s';
  if (arm === 'provider-failure') return 'bifrost-auth-rejection-30s-one-request';
  if (arm === 'resource-exhaustion') return 'resource-exhaustion-60s-one-request';
  if (arm === 'repair-head-history-unavailable') return 'required-history-preflight-15s';
  if (['p2-only', 'repair-introduction', 'repair-head-history', 'repair-head-empty-history'].includes(arm)) {
    return 'normal-canary-240s-capture-outside-child';
  }
  throw new Error('external_normal_v2_arm_budget_unavailable');
}

function outerCallAllocationForArm(arm: string): number {
  if (['p2-only', 'repair-introduction', 'repair-head-history', 'repair-head-empty-history'].includes(arm)) return 58;
  if (arm === 'provider-failure' || arm === 'resource-exhaustion') return 1;
  if (arm === 'repair-head-history-unavailable') return 0;
  if (arm === 'preflight-source-coverage-control') return 0;
  throw new Error('external_normal_v2_arm_call_allocation_unavailable');
}

export function parseExternalNormalV2ImageCaseRequest(value: unknown): ExternalNormalV2ImageCaseRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('external_normal_v2_child_case_request_invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (!hasValidExternalNormalV2Projection(candidate.projection)) {
    throw new Error('external_normal_v2_child_case_request_invalid');
  }
  const arm = candidate.projection.arm;
  const credentialRequired = !EXTERNAL_NORMAL_V2_CREDENTIAL_FREE_ARMS.has(arm);
  const requestKeys = ['projection', 'clientCallAllocation', 'deadlineAt',
    ...(credentialRequired ? ['inferenceCredential'] : [])];
  if (!hasExactKeys(value, requestKeys)
    || !Number.isSafeInteger(candidate.clientCallAllocation)
    || candidate.clientCallAllocation !== outerCallAllocationForArm(arm)
    || !Number.isSafeInteger(candidate.deadlineAt) || (candidate.deadlineAt as number) <= Date.now()
    || (credentialRequired && !isValidInferenceCredential(candidate.inferenceCredential))) {
    throw new Error('external_normal_v2_child_case_request_invalid');
  }
  return value as unknown as ExternalNormalV2ImageCaseRequest;
}

export function createBoundExternalNormalV2CaseExecutor(input: {
  baseEnv?: Env;
  fetchImplementation?: FetchImplementation;
  runCase?: typeof runNormalEngineQualificationCase;
  historyStore?: NormalEngineQualificationHistoryStore;
  policyInputRoot?: string;
  privateBinding?: ExternalNormalV2PrivateBinding;
  readInferenceKeyInMemory?: (signal?: AbortSignal) => Promise<string> | string;
} = {}): (projection: ExternalNormalV2Projection, context: ExternalNormalV2Context) => Promise<Record<string, unknown>> {
  const baseEnv = input.baseEnv ?? process.env;
  const privateBinding = input.privateBinding ? validateExternalNormalV2PrivateBinding(input.privateBinding, baseEnv) : undefined;
  let historyStore = input.historyStore;
  let boundArtifactStoreRoot: string | undefined;
  const runCase = input.runCase ?? runNormalEngineQualificationCase;
  const realFetch = input.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  return async (projection, context) => {
    if (context.captureOutsideChild !== true || context.clientCallAllocation !== outerCallAllocationForArm(projection.arm)) {
      throw new Error('external_normal_v2_arm_execution_envelope_mismatch');
    }
    const artifactStoreRoot = await validateArtifactStoreRoot(context.artifactStoreRoot);
    if (boundArtifactStoreRoot && boundArtifactStoreRoot !== artifactStoreRoot) {
      throw new Error('external_normal_v2_artifact_store_root_changed');
    }
    boundArtifactStoreRoot = artifactStoreRoot;
    historyStore ??= new NormalEngineQualificationHistoryStore(artifactStoreRoot);
    const preparedExecutionJson = input.policyInputRoot
      ? await readPreparedExecutionJson(input.policyInputRoot, projection)
      : requiredEnv(baseEnv, 'REVIEW_PREPARED_CONFIG_JSON');
    const env = buildCaseEnvironment(baseEnv, projection, privateBinding, undefined, preparedExecutionJson);
    const serviceBudget = trustedPreparedBudget(env);
    if (serviceBudget.total !== 100 || serviceBudget.investigation !== 88 || serviceBudget.verifier !== 12
      || serviceBudget.maxTasks !== 8) throw new Error('external_normal_v2_prepared_budget_binding_mismatch');
    if (!EXTERNAL_NORMAL_V2_CREDENTIAL_FREE_ARMS.has(projection.arm)) {
      if (!input.readInferenceKeyInMemory) throw new Error('external_normal_v2_parent_credential_reader_required');
      const credential = await input.readInferenceKeyInMemory(context.signal);
      if (!isValidInferenceCredential(credential)) {
        throw new Error('external_normal_v2_child_inference_credential_invalid');
      }
      env.OPENAI_API_KEY = credential;
    }
    let actualFetchAttempts = 0;
    const actualRequestAttempts: Array<Record<string, unknown>> = [];
    const outboundCids = new Set<string>();
    const countedFetch: FetchImplementation = async (resource, init) => {
      context.recordClientCall();
      actualFetchAttempts += 1;
      const cid = new Headers(init?.headers).get('x-request-id');
      if (!cid || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(cid)) {
        throw new Error('external_normal_v2_outbound_cid_unavailable');
      }
      const cidSha256 = sha256(cid.toLowerCase());
      if (outboundCids.has(cidSha256)) throw new Error('external_normal_v2_outbound_cid_duplicate');
      outboundCids.add(cidSha256);
      const attempt: Record<string, unknown> = { clientRequestIdSha256: cidSha256, bifrostLogRequestIdSha256: cidSha256,
        upstreamResponseRequestIdSha256: null, requestedAlias: projection.policy.routeAlias,
        requestedEffort: projection.policy.requestedEffort, startedAt: new Date().toISOString(),
        requestDigest: sha256(canonicalJson({ alias: projection.policy.routeAlias, effort: projection.policy.requestedEffort })),
        httpStatus: null, fetchFailureClass: null, workerTokenUsage: null, workerEstimatedUsd: null };
      actualRequestAttempts.push(attempt);
      const response = await realFetch(resource, init);
      attempt.httpStatus = response.status;
      const responseRequestId = response.headers.get('x-request-id');
      if (responseRequestId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(responseRequestId)) {
        attempt.upstreamResponseRequestIdSha256 = sha256(responseRequestId.toLowerCase());
      }
      return response;
    };
    const profile = budgetProfileForArm(projection.arm);
    let receipt;
    try { receipt = await runCase(env, {
      historyStore,
      signal: context.signal,
      testBudgetProfile: profile as never,
      providerFetchImplementation: countedFetch,
      persistCaseReceipt: (value) => persistNormalEngineQualificationReceipt(value, artifactStoreRoot),
      persistProviderCapture: (value, binding) => persistNormalEngineQualificationProviderCapture(value, binding, artifactStoreRoot),
      persistComposedResources: (value, runId, phase, caseId) => persistNormalEngineQualificationComposedResources(
        value, runId, phase, caseId, artifactStoreRoot),
      persistProviderIdentifiers: (value, runId, phase, caseId) => persistNormalEngineQualificationProviderIdentifiers(
        value, runId, phase, caseId, artifactStoreRoot),
    }); } catch (error) {
      const workerFailure = error instanceof NormalEngineQualificationReceiptPersistError
        ? error.workerFailure : undefined;
      return {
        clientCalls: context.clientCallCount,
        blockedClientCalls: context.blockedClientCallCount,
        terminalStatus: 'failed',
        receiptSha256: sha256(canonicalJson({ phaseId: projection.stepId, runId: projection.runId,
          failureCode: 'worker_execution_failed' })),
        failureCode: 'worker_execution_failed',
        artifactReferences: [], outcome: null, history: null, qualificationControl: null,
        preflight: null, resourceExhaustion: null,
        attestorRecordedCalls: null,
        providerCalls: actualRequestAttempts,
        ...(workerFailure ? { workerFailure } : {}),
      };
    } finally {
      if (env.OPENAI_API_KEY !== undefined) env.OPENAI_API_KEY = '';
      delete env.OPENAI_API_KEY;
    }
    const providerCallByCid = new Map(receipt.provider.calls.map((call) => [call.clientRequestIdSha256, call]));
    if (providerCallByCid.size !== receipt.provider.calls.length || actualFetchAttempts !== context.clientCallCount
      || outboundCids.size !== actualFetchAttempts || [...outboundCids].some((cid) => !providerCallByCid.has(cid))) {
      throw new Error('external_normal_v2_client_attempt_ledger_mismatch');
    }
    const providerCalls = [...outboundCids].map((cid) => {
      const call = providerCallByCid.get(cid)!;
      if (call.bifrostLogRequestIdSha256 !== cid) throw new Error('external_normal_v2_bifrost_cid_binding_mismatch');
      return {
        clientRequestIdSha256: call.clientRequestIdSha256,
        bifrostLogRequestIdSha256: call.bifrostLogRequestIdSha256,
        upstreamResponseRequestIdSha256: call.upstreamResponseRequestIdSha256,
        requestedAlias: call.requestedAlias,
        requestedEffort: call.requestedEffort ?? 'unknown',
        startedAt: call.startedAt,
        requestDigest: sha256(canonicalJson({ alias: call.requestedAlias, effort: call.requestedEffort,
          outputCap: call.outputCap, stream: call.stream, providerPreference: call.requestedProviderPreference })),
        workerTokenUsage: call.tokenUsage,
        workerEstimatedUsd: null,
        httpStatus: call.httpStatus,
        fetchFailureClass: call.fetchFailureClass,
      };
    });
    const phase = receipt.phase;
    const caseId = receipt.target.caseId;
    const receiptPath = `normal-engine-qualification-store/${receipt.runId}/${phase}/${caseId}/receipt.json`;
    const receiptCanonicalSha256 = sha256(canonicalJson(receipt));
    const artifactReferences: Array<{ path: string; sha256: string; canonicalSha256?: string }> = [
      { path: receiptPath, sha256: receiptCanonicalSha256, canonicalSha256: receiptCanonicalSha256 },
    ];
    if (receipt.provider.capturePath && receipt.provider.captureSha256) {
      artifactReferences.push({ path: receipt.provider.capturePath, sha256: receipt.provider.captureSha256 });
    }
    if (receipt.provider.privateIdentifiersSha256) {
      artifactReferences.push({
        path: `normal-engine-qualification-store/${receipt.runId}/${phase}/${caseId}`
          + '/provider-identifiers.record/provider-identifiers.json',
        sha256: receipt.provider.privateIdentifiersSha256,
      });
    }
    if (receipt.composedResourcesPath && receipt.composedResourcesSha256) {
      artifactReferences.push({ path: receipt.composedResourcesPath, sha256: receipt.composedResourcesSha256 });
    }
    let historyArtifactFailure = false;
    try {
      const lineage = WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE;
      const historyArtifacts = projection.arm === 'repair-introduction'
        ? await historyStore.historyArtifactsFor({ runId: receipt.runId, sequenceId: lineage.sequenceId,
          caseId: lineage.sourceCaseId })
        : projection.arm === 'repair-head-history' || projection.arm === 'repair-head-empty-history'
          ? await historyStore.artifactsForRepairRun({ runId: receipt.runId,
            sourceRunId: projection.historyRunId ?? null, sequenceId: lineage.sequenceId,
            sourceCaseId: lineage.sourceCaseId, repairCaseId: lineage.repairCaseId })
          : [];
      for (const artifact of historyArtifacts) {
        artifactReferences.push({ path: artifact.recordPath, sha256: artifact.recordSha256 });
      }
    } catch { historyArtifactFailure = true; }
    return {
      clientCalls: actualFetchAttempts,
      blockedClientCalls: context.blockedClientCallCount,
      terminalStatus: historyArtifactFailure ? 'failed' : receipt.terminal.status,
      receiptSha256: sha256(canonicalJson(receipt)),
      artifactReferences,
      outcome: receipt.outcome,
      canonicalReviewEvidence: receipt.canonicalReviewEvidence ?? null,
      history: receipt.history,
      qualificationControl: receipt.qualificationControl,
      preflight: receipt.preflight ?? null,
      resourceExhaustion: receipt.testBudget.resourceExhaustion,
      attestorRecordedCalls: receipt.provider.calls.length,
      ...(historyArtifactFailure ? { failureCode: 'history_artifact_capture_failed' } : {}),
      providerCalls,
    };
  };
}

interface ExternalNormalV2ImageCaseRequest {
  projection: ExternalNormalV2Projection;
  clientCallAllocation: number;
  deadlineAt: number;
  inferenceCredential?: string;
}

interface ExternalNormalV2TransportProbeRequest {
  origin: string;
  sourceRevision: string;
  workerImageDigest: string;
  runtimeManifestSha256: string;
  deadlineAt: number;
}

interface ImageTransportPreflightRequest {
  phaseId: string;
  phasePlanSha256: string;
  workerImageDigest: string;
  sourceRevision: string;
  runtimeManifestSha256: string;
  origin: string;
  deadlineAt: number;
  artifactStoreRoot: string;
}

async function readBoundedStdin(maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const inputChunk of process.stdin) {
    const chunk = Buffer.isBuffer(inputChunk) ? inputChunk : Buffer.from(inputChunk);
    totalBytes += chunk.byteLength;
    if (totalBytes > maximumBytes) {
      chunks.forEach((existing) => existing.fill(0));
      throw new Error('external_normal_v2_child_input_too_large');
    }
    chunks.push(Buffer.from(chunk));
  }
  const result = Buffer.concat(chunks);
  chunks.forEach((existing) => existing.fill(0));
  return result;
}

async function resolveTransportHost(hostname: string, deadlineAt: number): Promise<Array<{ address: string; family: number }>> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('external_normal_v2_transport_preflight_deadline');
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('external_normal_v2_transport_dns_timeout')), remaining);
        timer.unref?.();
      }),
    ]);
  } catch { throw new Error('external_normal_v2_transport_dns_unavailable'); }
  finally { if (timer) clearTimeout(timer); }
}

async function verifiedTlsPeer(hostname: string, address: string, deadlineAt: number): Promise<{
  authorized: true; protocol: 'TLSv1.2' | 'TLSv1.3'; peerCertificateSha256: string; address: string;
}> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('external_normal_v2_transport_preflight_deadline');
  return await new Promise((resolvePeer, rejectPeer) => {
    const socket = tlsConnect({ host: address, port: 443, servername: hostname,
      rejectUnauthorized: true, timeout: Math.min(5_000, remaining) });
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectPeer(new Error('external_normal_v2_transport_tls_unavailable'));
    };
    socket.once('secureConnect', () => {
      if (settled) return;
      const certificate = socket.getPeerCertificate(true);
      const protocol = socket.getProtocol();
      if (!socket.authorized || !certificate.raw || (protocol !== 'TLSv1.2' && protocol !== 'TLSv1.3')) return fail();
      settled = true;
      const peerCertificateSha256 = createHash('sha256').update(certificate.raw).digest('hex');
      socket.end();
      resolvePeer({ authorized: true, protocol, peerCertificateSha256, address });
    });
    socket.once('error', fail);
    socket.once('timeout', fail);
  });
}

/** The image performs DNS and certificate-verified TLS only; no HTTP request is sent. */
export async function runExternalNormalV2TransportPreflightFromImage(
  input: ExternalNormalV2TransportProbeRequest,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const origin = new URL(input.origin);
  if (origin.protocol !== 'https:' || origin.hostname !== 'llm-gateway.tailebe851.ts.net'
    || (origin.port && origin.port !== '443') || origin.pathname !== '/v1'
    || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('external_normal_v2_transport_origin_not_admitted');
  }
  if (process.env.REVIEW_NORMAL_ENGINE_QUALIFICATION_WORKER_IMAGE_DIGEST !== input.workerImageDigest
    || process.env.REVIEW_NORMAL_ENGINE_QUALIFICATION_SOURCE_REVISION !== input.sourceRevision
    || process.env.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256 !== input.runtimeManifestSha256
    || await verifyWorkerRuntimeManifest('/app/runtime-manifest.json') !== input.runtimeManifestSha256) {
    throw new Error('external_normal_v2_transport_runtime_binding_mismatch');
  }
  const addresses = await resolveTransportHost(origin.hostname, input.deadlineAt);
  if (addresses.length === 0) throw new Error('external_normal_v2_transport_dns_empty');
  let tls: Awaited<ReturnType<typeof verifiedTlsPeer>> | undefined;
  for (const address of addresses.slice().sort((left, right) => left.family - right.family)) {
    try { tls = await verifiedTlsPeer(origin.hostname, address.address, input.deadlineAt); break; } catch { /* try the remaining resolved addresses */ }
  }
  if (!tls) throw new Error('external_normal_v2_transport_tls_unavailable');
  return { status: 'ready', mode: 'dns_tls_only', originSha256: sha256(input.origin),
    sourceRevision: input.sourceRevision, workerImageDigest: input.workerImageDigest,
    runtimeManifestSha256: input.runtimeManifestSha256,
    resolvedAddressCount: addresses.length,
    resolvedAddressSetSha256: sha256(canonicalJson(addresses.map(({ address, family }) => ({ address, family }))
      .sort((left, right) => left.address.localeCompare(right.address) || left.family - right.family))),
    tlsAuthorized: true, tlsProtocol: tls.protocol, peerCertificateSha256: tls.peerCertificateSha256,
    tlsAddressSha256: sha256(tls.address),
    elapsedMs: Date.now() - startedAt };
}

/** Image-only child entrypoint; this path invokes the compiled worker code in the pinned image. */
export async function runExternalNormalV2CaseFromImage(): Promise<Record<string, unknown>> {
  const inputBytes = await readBoundedStdin(64 * 1024);
  let request: ExternalNormalV2ImageCaseRequest;
  try { request = parseExternalNormalV2ImageCaseRequest(JSON.parse(inputBytes.toString('utf8'))); }
  catch { inputBytes.fill(0); throw new Error('external_normal_v2_child_case_request_invalid'); }
  inputBytes.fill(0);
  const executor = createBoundExternalNormalV2CaseExecutor({ baseEnv: process.env, policyInputRoot: '/phase-inputs',
    readInferenceKeyInMemory: () => request.inferenceCredential ?? '' });
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(new Error('external_normal_v2_child_deadline_exceeded')),
    Math.max(1, request.deadlineAt - Date.now()));
  deadlineTimer.unref?.();
  let clientCalls = 0;
  let blockedClientCalls = 0;
  try {
    return await executor(request.projection, {
      signal: controller.signal, deadlineAt: request.deadlineAt, captureOutsideChild: true,
      artifactStoreRoot: '/phase', clientCallAllocation: request.clientCallAllocation,
      recordClientCall() {
        if (Date.now() >= request.deadlineAt) throw new Error('external_normal_v2_child_deadline_exceeded');
        if (clientCalls >= request.clientCallAllocation) {
          blockedClientCalls += 1;
          throw new Error('external_normal_v2_child_attempt_cap_exceeded');
        }
        clientCalls += 1;
      },
      get clientCallCount() { return clientCalls; },
      get blockedClientCallCount() { return blockedClientCalls; },
    });
  } finally {
    clearTimeout(deadlineTimer);
    delete request.inferenceCredential;
  }
}

function dockerCliEnvironment(workerEnv?: Env): Env {
  const result: Env = { NODE_ENV: 'production', PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || '/tmp' };
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    if (process.env[key]) result[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(workerEnv ?? {})) {
    if (key !== 'OPENAI_API_KEY' && value !== undefined) result[key] = value;
  }
  return result;
}

function pinnedImageReference(workerImageDigest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(workerImageDigest)) throw new Error('external_normal_v2_worker_image_digest_invalid');
  return `${WORKER_IMAGE_REPOSITORY}@${workerImageDigest}`;
}

function assertPinnedImageAvailable(imageRef: string): void {
  let raw: string;
  try {
    raw = execFileSync('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', imageRef], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, maxBuffer: 16 * 1024,
      env: dockerCliEnvironment(),
    }).trim();
  } catch { throw new Error('external_normal_v2_pinned_worker_image_unavailable_locally'); }
  let repoDigests: unknown;
  try { repoDigests = JSON.parse(raw); } catch { throw new Error('external_normal_v2_image_inspection_invalid'); }
  if (!Array.isArray(repoDigests) || !repoDigests.includes(imageRef)) {
    throw new Error('external_normal_v2_worker_image_digest_not_present_locally');
  }
}

function mountablePath(input: string): string {
  const canonical = resolve(input);
  if (/[,:\r\n]/u.test(canonical)) throw new Error('external_normal_v2_container_mount_path_invalid');
  return canonical;
}

function runPinnedWorkerContainer(input: {
  imageRef: string; mode: '--external-normal-v2-case' | '--external-normal-v2-transport-preflight';
  workerEnv: Env; phaseRoot?: string; policyInputRoot?: string; stdinJson: string;
  signal?: AbortSignal; deadlineAt: number; spawnImplementation?: typeof spawn;
}): Promise<Record<string, unknown>> {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function' || process.getuid() === 0) {
    return Promise.reject(new Error('external_normal_v2_host_runner_must_be_nonroot'));
  }
  const args = ['run', '--interactive', '--rm', '--pull=never', '--read-only', '--init', '--network', 'bridge',
    '--user', `${process.getuid()}:${process.getgid()}`, '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--workdir', '/app'];
  if (input.phaseRoot) args.push('--mount', `type=bind,source=${mountablePath(input.phaseRoot)},target=/phase`);
  if (input.policyInputRoot) args.push('--mount', `type=bind,source=${mountablePath(input.policyInputRoot)},target=/phase-inputs,readonly`);
  args.push('--env', 'HOME=/tmp');
  for (const key of Object.keys(input.workerEnv).sort()) {
    if (key !== 'OPENAI_API_KEY' && input.workerEnv[key] !== undefined) args.push('--env', key);
  }
  args.push('--entrypoint', 'node', input.imageRef,
    '/app/dist/qualification/normalEngineQualificationExternalV2.js', input.mode);
  const spawnImpl = input.spawnImplementation ?? spawn;
  const launchEnv = dockerCliEnvironment(input.workerEnv);
  const stdinBytes = Buffer.from(input.stdinJson, 'utf8');
  input.stdinJson = '';
  const maxStdinBytes = input.mode === '--external-normal-v2-case' ? 64 * 1024 : 16 * 1024;
  if (stdinBytes.byteLength > maxStdinBytes) {
    stdinBytes.fill(0);
    return Promise.reject(childExecutionError('external_normal_v2_child_input_too_large', false));
  }
  let child: ChildProcessByStdio<Writable, Readable, null>;
  try { child = spawnImpl('docker', args, { env: launchEnv, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch {
    stdinBytes.fill(0);
    return Promise.reject(childExecutionError('external_normal_v2_docker_launcher_unavailable', false,
      { stage: 'container_spawn', code: 'docker_launcher_unavailable' }));
  }
  return new Promise((resolveResult, rejectResult) => {
    let pending = Buffer.alloc(0);
    let resultLine: Buffer | undefined;
    let totalOutput = 0;
    let didReject = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const clean = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener('abort', onAbort);
      stdinBytes.fill(0);
      pending.fill(0);
      resultLine?.fill(0);
    };
    const fail = (code: string) => {
      if (didReject) return;
      didReject = true;
      try { child.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1_000);
      rejectResult(childExecutionError(code, input.mode === '--external-normal-v2-case' && child.pid !== undefined));
    };
    const onAbort = () => {
      const reason = input.signal?.reason;
      if (reason instanceof Error && reason.message === 'external_normal_v2_arm_deadline_exceeded'
        && input.mode === '--external-normal-v2-case' && Date.now() < input.deadlineAt + 10_000) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        timeoutTimer = setTimeout(() => fail('external_normal_v2_child_drain_grace_exhausted'),
          Math.max(1, input.deadlineAt + 10_000 - Date.now()));
        return;
      }
      fail('external_normal_v2_child_aborted');
    };
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener('abort', onAbort, { once: true });
    const drainGraceMs = input.mode === '--external-normal-v2-case' ? 10_000 : 0;
    timeoutTimer = setTimeout(() => fail('external_normal_v2_child_deadline_and_drain_exhausted'),
      Math.max(1, input.deadlineAt + drainGraceMs - Date.now()));
    timeoutTimer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      totalOutput += chunk.length;
      if (totalOutput > MAX_IMAGE_STDOUT_BYTES) return fail('external_normal_v2_child_output_limit_exceeded');
      const combined = Buffer.concat([pending, chunk]);
      let offset = 0;
      for (;;) {
        const newline = combined.indexOf(0x0a, offset);
        if (newline < 0) break;
        const line = combined.subarray(offset, newline);
        if (line.subarray(0, Buffer.byteLength(IMAGE_RESULT_MARKER)).toString('utf8') === IMAGE_RESULT_MARKER) {
          if (resultLine) return fail('external_normal_v2_child_result_duplicate');
          resultLine = Buffer.from(line.subarray(Buffer.byteLength(IMAGE_RESULT_MARKER)));
        }
        offset = newline + 1;
      }
      pending.fill(0);
      pending = Buffer.from(combined.subarray(offset));
      combined.fill(0);
      if (pending.length > MAX_IMAGE_STDOUT_LINE_BYTES) fail('external_normal_v2_child_stdout_line_limit_exceeded');
    });
    child.once('error', () => {
      const clientAttemptsMayHaveBeenSent = input.mode === '--external-normal-v2-case' && child.pid !== undefined;
      clean();
      rejectResult(childExecutionError('external_normal_v2_docker_launcher_unavailable', clientAttemptsMayHaveBeenSent,
        clientAttemptsMayHaveBeenSent ? undefined : { stage: 'container_spawn', code: 'docker_launcher_unavailable' }));
    });
    child.once('close', (code) => {
      if (didReject) { clean(); return; }
      if (code !== 0 || !resultLine) {
        clean(); rejectResult(childExecutionError(code === 0 ? 'external_normal_v2_child_result_missing' : 'external_normal_v2_child_process_failed',
          input.mode === '--external-normal-v2-case' && child.pid !== undefined));
        return;
      }
      let result: unknown;
      try { result = JSON.parse(resultLine.toString('utf8')); }
      catch { clean(); rejectResult(childExecutionError('external_normal_v2_child_result_invalid',
        input.mode === '--external-normal-v2-case' && child.pid !== undefined)); return; }
      clean();
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        rejectResult(childExecutionError('external_normal_v2_child_result_invalid',
          input.mode === '--external-normal-v2-case' && child.pid !== undefined)); return;
      }
      resolveResult(result as Record<string, unknown>);
    });
    child.stdin.end(stdinBytes, () => stdinBytes.fill(0));
  });
}

export function createPinnedWorkerImageExternalNormalV2Adapter(input: {
  policyInputRoot: string;
  baseEnv?: Env;
  privateBinding: ExternalNormalV2PrivateBinding;
  readInferenceKeyInMemory: (signal?: AbortSignal) => Promise<string> | string;
  assertImageAvailable?: (imageRef: string) => void;
  spawnImplementation?: typeof spawn;
}): {
  executeCase: (projection: ExternalNormalV2Projection, context: ExternalNormalV2Context) => Promise<Record<string, unknown>>;
  preflight: (request: ImageTransportPreflightRequest) => Promise<Record<string, unknown>>;
} {
  const baseEnv = input.baseEnv ?? process.env;
  const privateBinding = validateExternalNormalV2PrivateBinding(input.privateBinding, baseEnv);
  let inspectedImageRef: string | undefined;
  const ensureImage = (digest: string) => {
    const imageRef = pinnedImageReference(digest);
    if (inspectedImageRef !== imageRef) {
      try { (input.assertImageAvailable ?? assertPinnedImageAvailable)(imageRef); }
      catch {
        throw childExecutionError('external_normal_v2_pinned_worker_image_unavailable_locally', false,
          { stage: 'pinned_image', code: 'pinned_worker_image_unavailable' });
      }
      inspectedImageRef = imageRef;
    }
    return imageRef;
  };
  const preflight = async (request: ImageTransportPreflightRequest) => {
    if (request.origin !== privateBinding.transport.selectedBaseUrl
      || request.sourceRevision !== privateBinding.runtime.finalSourceRevision
      || request.workerImageDigest !== privateBinding.runtime.workerImageDigest
      || request.runtimeManifestSha256 !== privateBinding.runtime.runtimeManifestSha256) {
      throw new Error('external_normal_v2_private_preflight_binding_mismatch');
    }
    const imageRef = ensureImage(request.workerImageDigest);
    const workerEnv: Env = { NODE_ENV: 'production',
      REVIEW_NORMAL_ENGINE_QUALIFICATION_SOURCE_REVISION: request.sourceRevision,
      REVIEW_NORMAL_ENGINE_QUALIFICATION_WORKER_IMAGE_DIGEST: request.workerImageDigest,
      REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256: request.runtimeManifestSha256 };
    return runPinnedWorkerContainer({ imageRef, mode: '--external-normal-v2-transport-preflight', workerEnv,
      stdinJson: JSON.stringify({ origin: request.origin, sourceRevision: request.sourceRevision,
        workerImageDigest: request.workerImageDigest,
        runtimeManifestSha256: request.runtimeManifestSha256, deadlineAt: request.deadlineAt }),
      deadlineAt: request.deadlineAt, spawnImplementation: input.spawnImplementation });
  };
  const executeCase = async (projection: ExternalNormalV2Projection, context: ExternalNormalV2Context) => {
    validateExternalNormalV2PrivateBinding(privateBinding, baseEnv);
    if (!hasValidExternalNormalV2Projection(projection)) {
      throw new Error('external_normal_v2_worker_projection_invalid');
    }
    const targetBinding = privateBinding.policy.targetProjections
      .find((target) => target.repositoryId === projection.targetRepositoryId);
    if (projection.runtime.sourceRevision !== privateBinding.runtime.finalSourceRevision
      || projection.runtime.workerImageDigest !== privateBinding.runtime.workerImageDigest
      || projection.runtime.runtimeManifestSha256 !== privateBinding.runtime.runtimeManifestSha256
      || projection.policy.inferenceBaseUrl !== privateBinding.transport.selectedBaseUrl
      || projection.policy.routeAlias !== privateBinding.transport.modelAlias
      || projection.policy.requestedEffort !== 'medium'
      || projection.policy.candidateHead !== privateBinding.sourceDescriptor.candidateHead
      || projection.policy.candidateRawSha256 !== privateBinding.sourceDescriptor.contentSha256
      || projection.policy.policySource.repository !== privateBinding.sourceDescriptor.repository
      || projection.policy.policySource.repositoryId !== privateBinding.sourceDescriptor.repositoryId
      || projection.policy.policySource.sourceRef !== privateBinding.sourceDescriptor.sourceRef
      || projection.policy.policySource.path !== privateBinding.sourceDescriptor.path
      || projection.policy.policySource.contentSha256 !== privateBinding.sourceDescriptor.contentSha256
      || projection.policy.effectiveConfigSha256 !== privateBinding.policy.effectiveConfigSha256
      || projection.policy.effectivePolicySha256 !== privateBinding.policy.effectivePolicySha256
      || projection.policy.centralEffectiveConfigProjectionSha256 !== privateBinding.policy.centralEffectiveConfigProjectionSha256
      || !targetBinding || projection.policy.preparedExecutionSha256 !== targetBinding.preparedExecutionSha256
      || projection.policy.effectiveConfigSha256 !== targetBinding.effectiveConfigSha256
      || projection.policy.effectivePolicySha256 !== targetBinding.effectivePolicySha256) {
      throw new Error('external_normal_v2_private_case_binding_mismatch');
    }
    const workerEnv = buildPinnedWorkerCaseEnvironment(privateBinding);
    const imageRef = ensureImage(projection.runtime.workerImageDigest);
    if (context.clientCallAllocation !== outerCallAllocationForArm(projection.arm)) {
      throw new Error('external_normal_v2_arm_execution_envelope_mismatch');
    }
    const phaseRoot = await validateArtifactStoreRoot(context.artifactStoreRoot);
    // The coordinator owns phaseRoot. The immutable worker writes `/phase/<runId>/...`,
    // while its artifact references are relative to the phase root and begin with this store name.
    const workerStoreRoot = await ensureNormalEngineQualificationStoreRoot(phaseRoot);
    const requestedPolicyRoot = resolve(input.policyInputRoot);
    const policyRoot = await realpath(requestedPolicyRoot);
    const policyRootInfo = await lstat(requestedPolicyRoot);
    if (policyRootInfo.isSymbolicLink() || !policyRootInfo.isDirectory() || (policyRootInfo.mode & 0o077) !== 0) {
      throw new Error('external_normal_v2_policy_root_invalid_or_not_private');
    }
    let inferenceCredential: string | undefined;
    let caseRequestJson = '';
    try {
      if (!EXTERNAL_NORMAL_V2_CREDENTIAL_FREE_ARMS.has(projection.arm)) {
        try { inferenceCredential = await input.readInferenceKeyInMemory(context.signal); }
        catch {
          throw childExecutionError('external_normal_v2_parent_inference_credential_unavailable', false,
            { stage: 'inference_credential', code: 'inference_credential_unavailable' });
        }
        if (!isValidInferenceCredential(inferenceCredential)) {
          throw childExecutionError('external_normal_v2_parent_inference_credential_invalid', false,
            { stage: 'inference_credential', code: 'inference_credential_unavailable' });
        }
      }
      caseRequestJson = JSON.stringify({ projection, clientCallAllocation: context.clientCallAllocation,
        deadlineAt: context.deadlineAt,
        ...(inferenceCredential === undefined ? {} : { inferenceCredential }) });
      return await runPinnedWorkerContainer({ imageRef, mode: '--external-normal-v2-case', workerEnv,
        phaseRoot: workerStoreRoot, policyInputRoot: policyRoot,
        stdinJson: caseRequestJson,
        signal: context.signal, deadlineAt: context.deadlineAt, spawnImplementation: input.spawnImplementation });
    } finally {
      inferenceCredential = undefined;
      caseRequestJson = '';
    }
  };
  return { executeCase, preflight };
}

/** Production entrypoint: host coordinator, scoped secret/log callbacks, and pinned image case children. */
export async function runCurrentSourceExternalNormalV2FromProcess(input: {
  captureExactLogs?: (request: Record<string, unknown>) => Promise<unknown>;
  privateBinding?: ExternalNormalV2PrivateBinding;
  routeIdentity?: ExternalNormalV2RouteIdentity;
  readInferenceKeyInMemory?: (signal?: AbortSignal) => Promise<string> | string;
  readManagementAuthInMemory?: (signal?: AbortSignal) => Promise<{ username: string; password: string }>
    | { username: string; password: string };
  baseEnv?: Env;
} = {}): Promise<Record<string, unknown>> {
  const baseEnv = input.baseEnv ?? process.env;
  const rootGoRaw = String(baseEnv.REVIEW_YETI_EXTERNAL_NORMAL_V2_ROOT_GO ?? '').trim();
  let authorization: unknown = null;
  if (rootGoRaw) {
    try { authorization = JSON.parse(rootGoRaw); } catch { return { status: 'authorization_rejected', clientCalls: 0 }; }
  }
  const dynamicImport = new Function('specifier', 'return import(specifier)') as
    (specifier: string) => Promise<ExternalNormalV2MjsRunner>;
  const scriptUrl = pathToFileURL(resolve(__dirname, '../../scripts/ws5-external-normal-v2.mjs')).href;
  const runner = await dynamicImport(scriptUrl);
  if (!authorization) {
    return runner.runExternalNormalQualificationV2({ repositoryRoot: process.cwd(), authorization,
      executeCase: async () => { throw new Error('external_normal_v2_authorization_required'); } });
  }
  if (!input.privateBinding) return { status: 'private_binding_required', clientCalls: 0 };
  let privateBinding: ExternalNormalV2PrivateBinding;
  try { privateBinding = validateExternalNormalV2PrivateBinding(input.privateBinding, baseEnv); }
  catch { return { status: 'private_binding_rejected', clientCalls: 0 }; }
  if (!input.routeIdentity) return { status: 'route_identity_required', clientCalls: 0 };
  let routeIdentity: ExternalNormalV2RouteIdentity;
  try { routeIdentity = runner.validateExternalNormalV2RouteIdentity(input.routeIdentity); }
  catch { return { status: 'route_identity_rejected', clientCalls: 0 }; }
  if (!input.readInferenceKeyInMemory || (!input.captureExactLogs && !input.readManagementAuthInMemory)) {
    return { status: 'private_parent_callbacks_required', clientCalls: 0 };
  }
  const phaseRoot = privateBinding.phaseRoot.canonicalPath;
  let captureExactLogs = input.captureExactLogs;
  if (!captureExactLogs) {
    const collectorUrl = pathToFileURL(resolve(__dirname, '../../scripts/ws5-external-bifrost-log-collector.mjs')).href;
    const collector = await dynamicImport(collectorUrl) as unknown as ExternalNormalV2CollectorModule;
    captureExactLogs = collector.createExternalNormalV2ExactLogCollector({
      managementBaseUrl: privateBinding.managementBaseUrl,
      readManagementAuthInMemory: input.readManagementAuthInMemory!,
      ...(phaseRoot ? { storeRoot: phaseRoot } : {}),
    });
  }
  const canCollectLogs = typeof captureExactLogs === 'function';
  const policyInputRoot = authorization && canCollectLogs ? requiredEnv(baseEnv, 'REVIEW_YETI_EXTERNAL_NORMAL_V2_POLICY_ROOT') : undefined;
  if (!policyInputRoot) {
    return runner.runExternalNormalQualificationV2({ repositoryRoot: process.cwd(), privateBinding, routeIdentity, authorization,
      executeCase: async () => { throw new Error('external_normal_v2_authorized_policy_root_required'); }, captureExactLogs,
      preflightExecution: async () => { throw new Error('external_normal_v2_authorized_policy_root_required'); } });
  }
  const adapter = createPinnedWorkerImageExternalNormalV2Adapter({ baseEnv, policyInputRoot, privateBinding,
    readInferenceKeyInMemory: input.readInferenceKeyInMemory });
  return runner.runExternalNormalQualificationV2({ repositoryRoot: process.cwd(), ...(policyInputRoot ? { policyInputRoot } : {}),
    phaseRoot, privateBinding, routeIdentity,
    authorization, executeCase: adapter.executeCase, captureExactLogs, preflightExecution: adapter.preflight });
}

async function runImageTransportPreflightFromStdin(): Promise<Record<string, unknown>> {
  const bytes = await readBoundedStdin(16 * 1024);
  let request: ExternalNormalV2TransportProbeRequest;
  try { request = JSON.parse(bytes.toString('utf8')) as ExternalNormalV2TransportProbeRequest; }
  catch { bytes.fill(0); throw new Error('external_normal_v2_transport_probe_request_invalid'); }
  bytes.fill(0);
  if (!request || !Number.isSafeInteger(request.deadlineAt) || request.deadlineAt <= Date.now()) {
    throw new Error('external_normal_v2_transport_probe_request_invalid');
  }
  return runExternalNormalV2TransportPreflightFromImage(request);
}

if (require.main === module) {
  const mode = process.argv[2];
  void (async () => {
    try {
      const result = mode === '--external-normal-v2-case'
        ? await runExternalNormalV2CaseFromImage()
        : mode === '--external-normal-v2-transport-preflight'
          ? await runImageTransportPreflightFromStdin()
          : (() => { throw new Error('external_normal_v2_image_mode_invalid'); })();
      process.stdout.write(`${IMAGE_RESULT_MARKER}${JSON.stringify(result)}\n`);
    } catch {
      process.stderr.write('external_normal_v2_image_child_failed\n');
      process.exitCode = 1;
    }
  })();
}
