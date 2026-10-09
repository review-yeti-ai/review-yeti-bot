#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  R2_BUNDLE_PATH,
  R2_BUNDLE_SHA256,
  R2_COHORT_PLAN_SHA256,
  R2_INPUT_MANIFEST_SHA256,
  R2_PHASE_ID,
  validateExternalNormalR2CohortPlan,
} from './ws5-external-normal-r2-plan.mjs';

export { validateExternalNormalR2CohortPlan };

export const EXTERNAL_NORMAL_V2_PLAN_PATH = 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/phase-plan.json';
export const EXTERNAL_NORMAL_V2_BUNDLE_PATH = 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/source-bundle.json';
export const EXTERNAL_NORMAL_V2_PLAN_SHA256 = '2cf0c2455969df0e1a6cdfa4b97ba4c400cad7e1a2da6f52ebb2bd07e159ffc9';
export const EXTERNAL_NORMAL_V2_BUNDLE_SHA256 = '99b707383ec16eea3ef81994c623e956f551a1e9d0b6acf2dd503afc5d41cfe1';
export const EXTERNAL_NORMAL_V2_ROOT_GO_SCHEMA = 'ReviewYetiExternalNormalQualificationRootGo.v1';
export const EXTERNAL_NORMAL_V2_PRIVATE_BINDING_SCHEMA = 'ReviewYetiExternalNormalQualificationPrivateBinding.v1';
export const EXTERNAL_NORMAL_V2_ROUTE_IDENTITY_SCHEMA = 'ReviewYetiExternalNormalQualificationRouteIdentity.v1';
export const EXTERNAL_NORMAL_R2_ROOT_GO_SCHEMA = 'ReviewYetiExternalNormalQualificationR2RootGo.v1';
export const EXTERNAL_NORMAL_R2_COHORT_PLAN_SHA256 = R2_COHORT_PLAN_SHA256;
export const EXTERNAL_NORMAL_R2_INPUT_MANIFEST_SHA256 = R2_INPUT_MANIFEST_SHA256;
export const EXTERNAL_NORMAL_R2_BUNDLE_PATH = R2_BUNDLE_PATH;
export const EXTERNAL_NORMAL_R2_BUNDLE_SHA256 = R2_BUNDLE_SHA256;
export const EXTERNAL_NORMAL_R2_PHASE_ID = R2_PHASE_ID;

const PHASE_WALL_LIMIT_MS = 1_800_000;
const CLIENT_CALL_LIMIT = 300;
const OVERALL_PHYSICAL_ATTEMPT_CEILING = 2_700;
const HISTORICAL_PHYSICAL_ATTEMPTS = 150;
const R2_PHASE_CLIENT_CALL_LIMIT = 275;
const R2_PRIOR_COHORT_CLIENT_CALLS = 25;
const R2_HISTORICAL_PHYSICAL_ATTEMPTS = HISTORICAL_PHYSICAL_ATTEMPTS + R2_PRIOR_COHORT_CLIENT_CALLS;
const R2_PREPARED_CONFIG_HELPER_SOURCE_FILE_SHA256 = '4ab88f14b6dc7e263b866ae56715d41d25f3ae716b32429f6e92eb991504f4c3';
const R2_PREPARED_CONFIG_HELPER_COMPILED_FILE_SHA256 = '972c1687e4d24f30352fbe464e4f420461aa2a48dbfab69636b24de9f1fd621d';
const NORMAL_ARM_MS = 240_000;
const CAPTURE_RESERVE_MS = 300_000;
const RESERVED_OVERHEAD_MS = 180_000;
const REQUIRED_HISTORY_PREFLIGHT_MS = 15_000;
const TRANSPORT_PREFLIGHT_DEADLINE_MS = 60_000;
const INPUTS = Object.freeze({
  'ws5-current-1dd-v2-p2': { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/p2.json', sha256: '4f476e36aa78b6788bb37c02ba5b2fae899c99eeba7d43dae399507cd93ed216', repositoryId: 73004, arm: 'p2-only', reservationMs: NORMAL_ARM_MS, clientCallAllocation: 58 },
  'ws5-current-1dd-v2-sequence-a': { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/seq_a.json', sha256: '0e3bade3d6d7a148a2a36515ed1b40b9c1ab3f4cc2b2d92343176f2069ca0da9', repositoryId: 73002, arm: 'repair-introduction', reservationMs: NORMAL_ARM_MS, clientCallAllocation: 58 },
  'ws5-current-1dd-v2-sequence-b': { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/seq_b.json', sha256: '52cdd6d19fc5dd042412a85df5b4effe8c9793c43cea3104ab5b35d036b1d1aa', repositoryId: 73002, arm: 'repair-head-history', reservationMs: NORMAL_ARM_MS, clientCallAllocation: 58 },
  'ws5-current-1dd-v2-coverage-hole': { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/coverage_hole.json', sha256: '6cf9a5f6c493f1db2f91f8abc907e9d4f9f9ad1d3c62296298326cb18f78897c', repositoryId: 73003, arm: 'preflight-source-coverage-control', reservationMs: 15_000, clientCallAllocation: 0 },
  'ws5-current-1dd-v2-provider-failure': { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/provider_failure.json', sha256: '76278ffbbb439e4e4d7b77dabe6022c01cf2c33d61753127cc82c542a9d1e2bd', repositoryId: 73004, arm: 'provider-failure', reservationMs: 30_000, clientCallAllocation: 1 },
  'ws5-current-1dd-v2-resource-exhaustion': { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/resource_exhaustion.json', sha256: '015efdfc7c5253cb52e4ec99f22bfc354ea51ae54667f161993a98b1566cd1bc', repositoryId: 73004, arm: 'resource-exhaustion', reservationMs: 60_000, clientCallAllocation: 1 },
});
const POLICY_INPUTS = Object.freeze([
  { key: 'candidatePath', path: 'review-yeti-v2-candidate.json' },
  { key: 'executionPlanFixturePath', path: 'review-yeti-v2-candidate-execution-plan.fixture.json' },
  { key: 'preparedExecutionFixturePath', path: 'review-yeti-v2-prepared-execution-host.fixture.json' },
  { key: 'syntheticProjectionPath', path: 'review-yeti-v2-synthetic-execution-plans-host.fixture.json' },
  { key: 'preparedExecutionManifestPath', path: 'review-yeti-v2-prepared-execution-host.manifest.json' },
]);
const SAFE_STEP_IDS = new Set([
  'v2-p2-first', 'v2-p2-repeat', 'v2-sequence-a', 'v2-sequence-b-history', 'v2-sequence-b-full-source',
  'v2-coverage-hole-control', 'v2-required-history-unavailable-control', 'v2-provider-failure-control', 'v2-resource-exhaustion-control',
]);
const NORMAL_STEP_IDS = new Set([
  'v2-p2-first', 'v2-p2-repeat', 'v2-sequence-a', 'v2-sequence-b-history', 'v2-sequence-b-full-source',
]);
const LAUNCHER_SOURCE_PATHS = Object.freeze([
  'scripts/ws5-external-normal-v2.mjs',
  'scripts/ws5-external-normal-r2-plan.mjs',
  'scripts/ws5-external-bifrost-log-collector.mjs',
  'src/qualification/normalEngineQualificationExternalV2.ts',
  'dist/qualification/normalEngineQualificationExternalV2.js',
  'Dockerfile.worker',
  'scripts/stage-worker-runtime.mjs',
  'scripts/normal-engine-qualification-fixtures.mjs',
  'src/cli/workerSelfTestModules.json',
]);
const FORBIDDEN_KEYS = /^(?:expected|oracle|label|verdict|gate|score|quality|answer|reference|ground_truth)(?:$|[_-])/iu;
const PRIVATE_PROVIDER_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ROUTE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}$/u;
const SAFE_PRE_CHILD_FAILURES = new Set([
  'case_environment:required_binding_missing',
  'inference_credential:inference_credential_unavailable',
  'pinned_image:pinned_worker_image_unavailable',
  'container_spawn:docker_launcher_unavailable',
]);
const SAFE_WORKER_FAILURES = new Set([
  'case_receipt_persistence:receipt_write_failed',
]);

export function externalNormalV2AttemptBounds(knownClientCalls, unknownClientCallUpperBound = 0) {
  if (!Number.isSafeInteger(knownClientCalls) || knownClientCalls < 0
    || !Number.isSafeInteger(unknownClientCallUpperBound) || unknownClientCallUpperBound < 0
    || knownClientCalls + unknownClientCallUpperBound > CLIENT_CALL_LIMIT) {
    throw new Error('external_normal_v2_attempt_bounds_invalid');
  }
  const unknown = unknownClientCallUpperBound > 0;
  return {
    clientCallsKnown: knownClientCalls,
    clientCallCountStatus: unknown ? 'lower_bound_child_ledger_unknown' : 'exact',
    unknownClientCallUpperBound,
    overallPhysicalAttempts: unknown ? null : HISTORICAL_PHYSICAL_ATTEMPTS + knownClientCalls,
    overallPhysicalAttemptsLowerBound: HISTORICAL_PHYSICAL_ATTEMPTS + knownClientCalls,
    overallPhysicalAttemptsUpperBound: HISTORICAL_PHYSICAL_ATTEMPTS + knownClientCalls + unknownClientCallUpperBound,
    remainingOverallPhysicalAttempts: unknown ? null
      : OVERALL_PHYSICAL_ATTEMPT_CEILING - HISTORICAL_PHYSICAL_ATTEMPTS - knownClientCalls,
    possiblePhaseClientCallsUpperBound: knownClientCalls + unknownClientCallUpperBound,
  };
}

function executionAttemptBounds(knownClientCalls, unknownClientCallUpperBound, profile) {
  if (!Number.isSafeInteger(knownClientCalls) || knownClientCalls < 0
    || !Number.isSafeInteger(unknownClientCallUpperBound) || unknownClientCallUpperBound < 0
    || knownClientCalls + unknownClientCallUpperBound > profile.phaseCallLimit) {
    throw new Error('external_normal_v2_attempt_bounds_invalid');
  }
  const unknown = unknownClientCallUpperBound > 0;
  return {
    clientCallsKnown: knownClientCalls,
    clientCallCountStatus: unknown ? 'lower_bound_child_ledger_unknown' : 'exact',
    unknownClientCallUpperBound,
    overallPhysicalAttempts: unknown ? null : profile.historicalPhysicalAttempts + knownClientCalls,
    overallPhysicalAttemptsLowerBound: profile.historicalPhysicalAttempts + knownClientCalls,
    overallPhysicalAttemptsUpperBound: profile.historicalPhysicalAttempts + knownClientCalls + unknownClientCallUpperBound,
    remainingOverallPhysicalAttempts: unknown ? null
      : profile.overallPhysicalAttemptCeiling - profile.historicalPhysicalAttempts - knownClientCalls,
    possiblePhaseClientCallsUpperBound: knownClientCalls + unknownClientCallUpperBound,
  };
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function safeExternalNormalV2PreChildFailure(error) {
  if (!error || typeof error !== 'object' || error.clientAttemptsMayHaveBeenSent !== false) return undefined;
  const failure = error.preChildFailure;
  if (!failure || typeof failure !== 'object' || typeof failure.stage !== 'string' || typeof failure.code !== 'string'
    || !SAFE_PRE_CHILD_FAILURES.has(`${failure.stage}:${failure.code}`)) return undefined;
  return { stage: failure.stage, code: failure.code };
}

export function safeExternalNormalV2WorkerFailure(result) {
  const failure = result?.workerFailure;
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)
    || Object.keys(failure).sort().join('|') !== 'code|stage'
    || typeof failure.stage !== 'string' || typeof failure.code !== 'string'
    || !SAFE_WORKER_FAILURES.has(`${failure.stage}:${failure.code}`)) return undefined;
  return { stage: failure.stage, code: failure.code };
}

async function readRepositoryFileWithoutSymlinks(repositoryRoot, relativePath) {
  const rootInput = path.resolve(repositoryRoot);
  const root = await realpath(rootInput);
  const requestedRootInfo = await lstat(rootInput);
  if (requestedRootInfo.isSymbolicLink()) throw new Error('external_normal_v2_repository_root_symlink_forbidden');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('external_normal_v2_repository_root_invalid');
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('external_normal_v2_descriptor_path_escape');
  let cursor = root;
  const components = path.relative(root, target).split(path.sep);
  for (const component of components) {
    cursor = path.join(cursor, component);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error('external_normal_v2_descriptor_symlink_forbidden');
    if (cursor !== target && !info.isDirectory()) throw new Error('external_normal_v2_descriptor_parent_invalid');
    if (cursor === target && !info.isFile()) throw new Error('external_normal_v2_descriptor_file_invalid');
  }
  return readFile(target);
}

async function canonicalExistingDirectoryWithoutSymlinks(directoryPath, { allowTmpAlias = false } = {}) {
  if (typeof directoryPath !== 'string' || !path.isAbsolute(directoryPath)) throw new Error('external_normal_v2_directory_invalid');
  const requested = path.resolve(directoryPath);
  let canonical;
  if (allowTmpAlias && (requested === '/tmp' || requested.startsWith('/tmp/'))) {
    const aliasTarget = await realpath('/tmp');
    if (aliasTarget !== '/private/tmp') throw new Error('external_normal_v2_tmp_alias_unexpected');
    canonical = path.resolve(aliasTarget, requested === '/tmp' ? '' : requested.slice('/tmp/'.length));
    if (canonical !== aliasTarget && !canonical.startsWith(`${aliasTarget}${path.sep}`)) throw new Error('external_normal_v2_directory_escape');
    let cursor = aliasTarget;
    for (const component of path.relative(aliasTarget, canonical).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('external_normal_v2_directory_symlink_forbidden');
    }
  } else {
    canonical = await realpath(requested);
    const requestedInfo = await lstat(requested);
    if (requestedInfo.isSymbolicLink()) throw new Error('external_normal_v2_directory_symlink_forbidden');
  }
  const info = await lstat(canonical);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('external_normal_v2_directory_invalid');
  return canonical;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertNoOutcomeLabels(value, location = 'plan') {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertNoOutcomeLabels(item, `${location}[${index}]`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw new Error(`external_normal_v2_outcome_label_forbidden:${location}.${key}`);
    assertNoOutcomeLabels(item, `${location}.${key}`);
  }
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`external_normal_v2_${name}_invalid`);
  return value;
}

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

export function validateExternalNormalV2PrivateBinding(binding) {
  const keys = ['schemaVersion', 'credentialBindingSha256', 'phaseRoot', 'sourceDescriptor', 'transport', 'managementBaseUrl', 'policy', 'runtime'];
  const phaseRootKeys = ['canonicalPath', 'uid', 'gid', 'mode', 'initialEntryCount'];
  const sourceKeys = ['repository', 'repositoryId', 'sourceRef', 'path', 'contentSha256', 'candidateHead', 'preparedFixtureReviewHead'];
  const transportKeys = ['selectedBaseUrl', 'modelAlias'];
  const policyKeys = ['candidateGitBlob', 'executionPlanFixtureSha256', 'executionPlanNormalizedSha256',
    'preparedExecutionFixtureSha256', 'preparedExecutionManifestSha256', 'preparedExecutionSha256',
    'syntheticProjectionFixtureSha256', 'centralEffectiveConfigProjectionSha256', 'effectiveConfigSha256',
    'effectivePolicySha256', 'v1Promotion', 'policyInputDigests', 'targetProjections'];
  const targetProjectionKeys = ['repositoryId', 'normalizedPlanSha256', 'centralEffectiveConfigProjectionSha256',
    'preparedExecutionSha256', 'effectiveConfigSha256', 'effectivePolicySha256', 'preparedExecutionFile'];
  const policyInputKeys = ['candidatePath', 'executionPlanFixturePath', 'preparedExecutionFixturePath',
    'syntheticProjectionPath', 'preparedExecutionManifestPath'];
  const runtimeKeys = ['finalSourceRevision', 'workerImageDigest', 'runtimeManifestSha256', 'publicationAttestationSha256'];
  if (!hasExactKeys(binding, keys) || binding.schemaVersion !== EXTERNAL_NORMAL_V2_PRIVATE_BINDING_SCHEMA
    || !/^[a-f0-9]{64}$/iu.test(binding.credentialBindingSha256 || '')
    || !hasExactKeys(binding.phaseRoot, phaseRootKeys)
    || typeof binding.phaseRoot.canonicalPath !== 'string' || !path.isAbsolute(binding.phaseRoot.canonicalPath)
    || path.resolve(binding.phaseRoot.canonicalPath) !== binding.phaseRoot.canonicalPath
    || !Number.isSafeInteger(binding.phaseRoot.uid) || binding.phaseRoot.uid < 0
    || !Number.isSafeInteger(binding.phaseRoot.gid) || binding.phaseRoot.gid < 0
    || binding.phaseRoot.mode !== 0o700 || binding.phaseRoot.initialEntryCount !== 0
    || !hasExactKeys(binding.sourceDescriptor, sourceKeys)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(binding.sourceDescriptor.repository || '')
    || !Number.isSafeInteger(binding.sourceDescriptor.repositoryId) || binding.sourceDescriptor.repositoryId < 1
    || binding.sourceDescriptor.repository.split('/').some((part) => part === '.' || part === '..')
    || !/^[a-f0-9]{40}$/iu.test(binding.sourceDescriptor.sourceRef || '')
    || typeof binding.sourceDescriptor.path !== 'string' || !binding.sourceDescriptor.path
    || path.posix.isAbsolute(binding.sourceDescriptor.path) || binding.sourceDescriptor.path.includes('\\')
    || binding.sourceDescriptor.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    || !/^[a-f0-9]{64}$/iu.test(binding.sourceDescriptor.contentSha256 || '')
    || !/^[a-f0-9]{40}$/iu.test(binding.sourceDescriptor.candidateHead || '')
    || !/^[a-f0-9]{40}$/iu.test(binding.sourceDescriptor.preparedFixtureReviewHead || '')
    || !hasExactKeys(binding.transport, transportKeys)
    || typeof binding.transport.selectedBaseUrl !== 'string'
    || !/^[A-Za-z0-9._/-]+$/u.test(binding.transport.modelAlias || '')
    || typeof binding.managementBaseUrl !== 'string'
    || !hasExactKeys(binding.policy, policyKeys)
    || !/^[a-f0-9]{40}$/iu.test(binding.policy.candidateGitBlob || '')
    || !['executionPlanFixtureSha256', 'executionPlanNormalizedSha256', 'preparedExecutionFixtureSha256',
      'preparedExecutionManifestSha256', 'preparedExecutionSha256', 'syntheticProjectionFixtureSha256',
      'centralEffectiveConfigProjectionSha256', 'effectiveConfigSha256', 'effectivePolicySha256']
      .every((key) => /^[a-f0-9]{64}$/iu.test(binding.policy[key] || ''))
    || typeof binding.policy.v1Promotion !== 'string' || !binding.policy.v1Promotion
    || !hasExactKeys(binding.policy.policyInputDigests, policyInputKeys)
    || !policyInputKeys.every((key) => /^[a-f0-9]{64}$/iu.test(binding.policy.policyInputDigests[key] || ''))
    || binding.policy.policyInputDigests.candidatePath !== binding.sourceDescriptor.contentSha256
    || !Array.isArray(binding.policy.targetProjections) || binding.policy.targetProjections.length !== 3
    || binding.policy.targetProjections.some((target) => !hasExactKeys(target, targetProjectionKeys)
      || !Number.isSafeInteger(target.repositoryId) || target.repositoryId < 1
      || !['normalizedPlanSha256', 'centralEffectiveConfigProjectionSha256', 'preparedExecutionSha256',
        'effectiveConfigSha256', 'effectivePolicySha256'].every((key) => /^[a-f0-9]{64}$/iu.test(target[key] || ''))
      || typeof target.preparedExecutionFile !== 'string'
      || target.preparedExecutionFile !== `prepared-host/prepared-${target.repositoryId}-default.json`)
    || !hasExactKeys(binding.runtime, runtimeKeys)
    || !/^[a-f0-9]{40}$/iu.test(binding.runtime.finalSourceRevision || '')
    || !/^sha256:[a-f0-9]{64}$/iu.test(binding.runtime.workerImageDigest || '')
    || !/^[a-f0-9]{64}$/iu.test(binding.runtime.runtimeManifestSha256 || '')
    || !/^[a-f0-9]{64}$/iu.test(binding.runtime.publicationAttestationSha256 || '')) {
    throw new Error('external_normal_v2_private_binding_invalid');
  }
  let selectedUrl;
  let managementUrl;
  try {
    selectedUrl = new URL(binding.transport.selectedBaseUrl);
    managementUrl = new URL(binding.managementBaseUrl);
  } catch { throw new Error('external_normal_v2_private_binding_invalid'); }
  if (selectedUrl.protocol !== 'https:' || selectedUrl.username || selectedUrl.password || selectedUrl.search || selectedUrl.hash
    || selectedUrl.pathname === '/' || selectedUrl.pathname.endsWith('/')
    || managementUrl.protocol !== 'https:' || managementUrl.username || managementUrl.password
    || managementUrl.search || managementUrl.hash || managementUrl.pathname !== '/') {
    throw new Error('external_normal_v2_private_binding_invalid');
  }
  return binding;
}

const ROUTE_IDENTITY_KEYS = ['schemaVersion', 'routingRuleId', 'routingRuleName', 'provider', 'model',
  'sourceConfigurationSha256'];

export function validateExternalNormalV2RouteIdentity(routeIdentity) {
  if (!hasExactKeys(routeIdentity, ROUTE_IDENTITY_KEYS)
    || routeIdentity.schemaVersion !== EXTERNAL_NORMAL_V2_ROUTE_IDENTITY_SCHEMA
    || !PRIVATE_PROVIDER_REQUEST_ID.test(routeIdentity.routingRuleId || '')
    || !SAFE_ROUTE_IDENTIFIER.test(routeIdentity.routingRuleName || '')
    || !SAFE_ROUTE_IDENTIFIER.test(routeIdentity.provider || '')
    || !SAFE_ROUTE_IDENTIFIER.test(routeIdentity.model || '')
    || !/^[a-f0-9]{64}$/iu.test(routeIdentity.sourceConfigurationSha256 || '')) {
    throw new Error('external_normal_v2_route_identity_binding_invalid');
  }
  return routeIdentity;
}

export function bindExternalNormalV2PrivateInputs(template, binding, routeIdentity) {
  validateExternalNormalV2PrivateBinding(binding);
  validateExternalNormalV2RouteIdentity(routeIdentity);
  const { policyInputDigests: _privateInputDigests, targetProjections: privateTargetProjections,
    ...privatePolicyFields } = binding.policy;
  const targetPins = new Map(privateTargetProjections.map((target) => [target.repositoryId, target]));
  if (targetPins.size !== template.targetProjections.length
    || template.targetProjections.some((target) => !targetPins.has(target.repositoryId))) {
    throw new Error('external_normal_v2_private_binding_target_set_invalid');
  }
  const targetProjections = template.targetProjections.map((target) => ({ ...target, ...targetPins.get(target.repositoryId) }));
  if (targetProjections.some((target) => target.effectiveConfigSha256 !== privatePolicyFields.effectiveConfigSha256
    || target.effectivePolicySha256 !== privatePolicyFields.effectivePolicySha256
    || target.centralEffectiveConfigProjectionSha256 !== privatePolicyFields.centralEffectiveConfigProjectionSha256
    || target.preparedExecutionSha256 !== privatePolicyFields.preparedExecutionSha256)) {
    throw new Error('external_normal_v2_private_binding_target_policy_mismatch');
  }
  return {
    ...template,
    status: 'frozen-ready-awaiting-root-go',
    runtime: { ...template.runtime, ...binding.runtime },
    policy: { ...template.policy, ...privatePolicyFields, candidateRawSha256: binding.sourceDescriptor.contentSha256,
      inferenceBaseUrl: binding.transport.selectedBaseUrl, routeAlias: binding.transport.modelAlias,
      routeIdentity,
      candidateHead: binding.sourceDescriptor.candidateHead,
      preparedFixtureReviewHead: binding.sourceDescriptor.preparedFixtureReviewHead,
      policySource: { repository: binding.sourceDescriptor.repository,
        repositoryId: binding.sourceDescriptor.repositoryId, sourceRef: binding.sourceDescriptor.sourceRef,
        path: binding.sourceDescriptor.path, contentSha256: binding.sourceDescriptor.contentSha256 } },
    targetProjections,
    artifactRoots: { ...template.artifactRoots, phaseRoot: { ...binding.phaseRoot } },
  };
}

export function assertExternalNormalV2PlanMatchesPrivateBinding(plan, binding, routeIdentity) {
  validateExternalNormalV2PrivateBinding(binding);
  validateExternalNormalV2RouteIdentity(routeIdentity);
  const source = binding.sourceDescriptor;
  const policy = binding.policy;
  const targets = new Map(binding.policy.targetProjections.map((target) => [target.repositoryId, target]));
  const policyMatches = plan?.policy?.candidateRawSha256 === source.contentSha256
    && plan.policy.candidateGitBlob === policy.candidateGitBlob
    && plan.policy.executionPlanFixtureSha256 === policy.executionPlanFixtureSha256
    && plan.policy.executionPlanNormalizedSha256 === policy.executionPlanNormalizedSha256
    && plan.policy.preparedExecutionFixtureSha256 === policy.preparedExecutionFixtureSha256
    && plan.policy.preparedExecutionManifestSha256 === policy.preparedExecutionManifestSha256
    && plan.policy.preparedExecutionSha256 === policy.preparedExecutionSha256
    && plan.policy.syntheticProjectionFixtureSha256 === policy.syntheticProjectionFixtureSha256
    && plan.policy.centralEffectiveConfigProjectionSha256 === policy.centralEffectiveConfigProjectionSha256
    && plan.policy.effectiveConfigSha256 === policy.effectiveConfigSha256
    && plan.policy.effectivePolicySha256 === policy.effectivePolicySha256
    && plan.policy.routeAlias === binding.transport.modelAlias
    && canonicalJson(plan.policy.routeIdentity) === canonicalJson(routeIdentity)
    && plan.policy.requestedEffort === 'medium'
    && plan.policy.servedProviderModelEffort === 'medium'
    && plan.policy.v1Promotion === policy.v1Promotion
    && plan.policy.inferenceBaseUrl === binding.transport.selectedBaseUrl
    && plan.policy.candidateHead === source.candidateHead
    && plan.policy.preparedFixtureReviewHead === source.preparedFixtureReviewHead
    && plan.policy.policySource?.repository === source.repository
    && plan.policy.policySource?.repositoryId === source.repositoryId
    && plan.policy.policySource?.sourceRef === source.sourceRef
    && plan.policy.policySource?.path === source.path
    && plan.policy.policySource?.contentSha256 === source.contentSha256;
  const targetRows = plan?.targetProjections;
  const targetMatches = Array.isArray(targetRows) && targetRows.length === targets.size
    && targetRows.every((target) => {
      const pin = targets.get(target.repositoryId);
      return Boolean(pin && target.normalizedPlanSha256 === pin.normalizedPlanSha256
        && target.centralEffectiveConfigProjectionSha256 === pin.centralEffectiveConfigProjectionSha256
        && target.preparedExecutionSha256 === pin.preparedExecutionSha256
        && target.effectiveConfigSha256 === pin.effectiveConfigSha256
        && target.effectivePolicySha256 === pin.effectivePolicySha256
        && target.preparedExecutionFile === pin.preparedExecutionFile);
    });
  if (!policyMatches || !targetMatches
    || canonicalJson(plan.runtime?.finalSourceRevision) !== canonicalJson(binding.runtime.finalSourceRevision)
    || canonicalJson(plan.runtime?.workerImageDigest) !== canonicalJson(binding.runtime.workerImageDigest)
    || canonicalJson(plan.runtime?.runtimeManifestSha256) !== canonicalJson(binding.runtime.runtimeManifestSha256)
    || canonicalJson(plan.runtime?.publicationAttestationSha256) !== canonicalJson(binding.runtime.publicationAttestationSha256)
    || canonicalJson(plan.artifactRoots?.phaseRoot) !== canonicalJson(binding.phaseRoot)) {
    throw new Error('external_normal_v2_private_binding_plan_mismatch');
  }
  return true;
}

function validateStep(step, index, bundleByCase) {
  object(step, 'step');
  if (!SAFE_STEP_IDS.has(step.stepId)) throw new Error('external_normal_v2_step_id_invalid');
  const input = INPUTS[step.caseId];
  const bundled = bundleByCase.get(step.caseId);
  const expectedArm = step.stepId === 'v2-sequence-b-full-source' ? 'repair-head-empty-history'
    : step.stepId === 'v2-required-history-unavailable-control' ? 'repair-head-history-unavailable' : input?.arm;
  if (!input || !bundled || step.inputPath !== input.path || step.inputSha256 !== input.sha256
    || step.arm !== expectedArm || step.targetRepositoryId !== input.repositoryId
    || bundled.inputPath !== input.path || bundled.inputSha256 !== input.sha256) {
    throw new Error(`external_normal_v2_step_input_identity_invalid:${index}`);
  }
  const repeat = step.stepId === 'v2-p2-repeat';
  if ((repeat && step.repeatOfStepId !== 'v2-p2-first') || (!repeat && step.repeatOfStepId !== undefined)) {
    throw new Error('external_normal_v2_repeat_binding_invalid');
  }
  if (step.stepId === 'v2-sequence-b-history' && step.historySourceStepId !== 'v2-sequence-a') {
    throw new Error('external_normal_v2_history_source_binding_invalid');
  }
  if (step.stepId === 'v2-required-history-unavailable-control' && step.historySourceStepId !== 'v2-sequence-a') {
    throw new Error('external_normal_v2_required_history_source_binding_invalid');
  }
  if (step.stepId === 'v2-sequence-b-full-source' && step.pairedStepId !== 'v2-sequence-b-history') {
    throw new Error('external_normal_v2_full_source_pair_binding_invalid');
  }
  const allowedHistorySteps = new Set(['v2-sequence-a', 'v2-sequence-b-history', 'v2-sequence-b-full-source',
    'v2-required-history-unavailable-control']);
  if (allowedHistorySteps.has(step.stepId) !== (typeof step.historySequenceId === 'string')) {
    throw new Error('external_normal_v2_history_sequence_binding_invalid');
  }
  return input;
}

export function validateExternalNormalV2Plan(plan, bundle) {
  object(plan, 'plan'); object(bundle, 'bundle');
  assertNoOutcomeLabels(plan);
  const privatePolicyFields = ['candidateRawSha256', 'candidateGitBlob', 'executionPlanFixtureSha256',
    'executionPlanNormalizedSha256', 'preparedExecutionFixtureSha256', 'preparedExecutionManifestSha256',
    'preparedExecutionSha256', 'syntheticProjectionFixtureSha256', 'centralEffectiveConfigProjectionSha256',
    'effectiveConfigSha256', 'effectivePolicySha256', 'routeAlias', 'v1Promotion'];
  const privateTargetFields = ['normalizedPlanSha256', 'centralEffectiveConfigProjectionSha256',
    'preparedExecutionSha256', 'effectiveConfigSha256', 'effectivePolicySha256', 'preparedExecutionFile'];
  const publicPolicyKeys = ['candidateRawSha256', 'candidateGitBlob', 'executionPlanFixtureSha256',
    'executionPlanNormalizedSha256', 'preparedExecutionFixtureSha256', 'preparedExecutionManifestSha256',
    'preparedExecutionSha256', 'syntheticProjectionFixtureSha256', 'centralEffectiveConfigProjectionSha256',
    'effectiveConfigSha256', 'effectivePolicySha256', 'routeAlias', 'requestedEffort', 'servedProviderModelEffort', 'v1Promotion'];
  const publicTargetKeys = ['repositoryId', 'repository', 'prNumber', ...privateTargetFields];
  if (plan.schemaVersion !== 'ReviewYetiExternalNormalQualificationPlan.v2'
    || plan.phaseId !== 'ws5-current-source-external-v2'
    || plan.status !== 'template-awaiting-private-root-binding'
    || plan.dispatchAuthorization !== false
    || plan.scope?.targetMode !== 'standalone-synthetic-source-snapshots'
    || !hasExactKeys(plan.artifactRoots?.phaseRoot, ['privateBindingRequired', 'mode', 'initialEntryCount'])
    || !hasExactKeys(plan.policy, publicPolicyKeys)
    || !Array.isArray(plan.targetProjections)
    || plan.targetProjections.some((target) => !hasExactKeys(target, publicTargetKeys))
    || plan.artifactRoots?.phaseRoot?.privateBindingRequired !== true
    || Object.hasOwn(plan.artifactRoots?.phaseRoot ?? {}, 'canonicalPath')
    || Object.hasOwn(plan.artifactRoots?.phaseRoot ?? {}, 'uid')
    || Object.hasOwn(plan.artifactRoots?.phaseRoot ?? {}, 'gid')
    || plan.artifactRoots?.phaseRoot?.mode !== 0o700 || plan.artifactRoots?.phaseRoot?.initialEntryCount !== 0
    || plan.artifactRoots?.normalEngineQualificationStore?.relativePath !== 'normal-engine-qualification-store'
    || plan.artifactRoots?.normalEngineQualificationStore?.mode !== 0o700
    || plan.publication?.mode !== 'disabled' || plan.publication.githubWrites !== 0
    || plan.publication.appChecks !== 0 || plan.publication.reviews !== 0 || plan.publication.comments !== 0
    || plan.publication.ordinaryGateTouched !== false
    || plan.sourceBundle?.version !== 'WS5ExternalNormalBundle.v2'
    || plan.sourceBundle.path !== EXTERNAL_NORMAL_V2_BUNDLE_PATH
    || plan.sourceBundle.sha256 !== EXTERNAL_NORMAL_V2_BUNDLE_SHA256
    || bundle.schemaVersion !== 'WS5ExternalNormalBundle.v2'
    || privatePolicyFields.some((key) => plan.policy?.[key] !== null)
    || plan.policy?.requestedEffort !== 'medium'
    || plan.policy?.servedProviderModelEffort !== 'medium'
    || Object.hasOwn(plan.policy ?? {}, 'inferenceBaseUrl')
    || Object.hasOwn(plan.policy ?? {}, 'policySource')
    || Object.hasOwn(plan.policy ?? {}, 'candidateHead')
    || Object.hasOwn(plan.policy ?? {}, 'preparedFixtureReviewHead')
    || Object.hasOwn(plan.policy ?? {}, 'candidatePath')
    || Object.hasOwn(plan.policy ?? {}, 'policyInputDigests')
    || Object.hasOwn(plan.policy ?? {}, 'targetProjections')
    || plan.targetProjections?.some((target) => privateTargetFields.some((key) => target[key] !== null))
    || plan.runtime?.preparedConfigHelperSourceRevision !== 'a755abe90455b2b729c3f2eeaa5367481a90f7f3'
    || plan.runtime?.preparedConfigHelperSourceFileSha256 !== '4ab88f14b6dc7e263b866ae56715d41d25f3ae716b32429f6e92eb991504f4c3'
    || plan.runtime?.preparedConfigHelperCompiledFileSha256 !== '972c1687e4d24f30352fbe464e4f420461aa2a48dbfab69636b24de9f1fd621d'
    || plan.runtime?.executionMode !== 'host-coordinator-with-pinned-worker-image-children'
    || plan.runtime?.executionNetwork !== 'docker-bridge-to-configured-https-origin'
    || plan.runtime?.publicationAttestationSha256 !== null
    || plan.runtime?.executionUser !== 'container runs as the nonroot host uid that owns the private phaseRoot'
    || plan.runtime?.executionOriginReadiness !== 'read-only DNS and certificate-verified TLS proof inside the exact worker image is required before the first model request'
    || plan.runtime?.workerImageRepository !== 'ghcr.io/review-yeti-ai/review-yeti-worker'
    || plan.runtime?.artifactStoreBinding !== 'canonical private phaseRoot/normal-engine-qualification-store'
    || plan.executionEnvelope?.maxPhaseClientCalls !== CLIENT_CALL_LIMIT
    || plan.executionEnvelope?.perArmClientHttpAttemptAllocation?.normalArms !== 58
    || plan.executionEnvelope?.perArmClientHttpAttemptAllocation?.providerFailureControl !== 1
    || plan.executionEnvelope?.perArmClientHttpAttemptAllocation?.resourceExhaustionControl !== 1
    || plan.executionEnvelope?.perArmClientHttpAttemptAllocation?.coveragePreflightControl !== 0
    || plan.executionEnvelope?.perArmClientHttpAttemptAllocation?.declaredArmTotal !== 292
    || plan.executionEnvelope?.perArmClientHttpAttemptAllocation?.unspendableSharedReserve !== 8
    || plan.executionEnvelope?.perArmClientHttpAttemptAllocation?.synchronousBlockBeforeFetch !== true
    || plan.executionEnvelope?.perNormalArmActiveDeadlineMs !== NORMAL_ARM_MS
    || plan.executionEnvelope?.phaseWallLimitMs !== PHASE_WALL_LIMIT_MS
    || plan.executionEnvelope?.captureOutsideChildDeadline !== true
    || plan.executionEnvelope?.workerContainer?.imageRepository !== plan.runtime.workerImageRepository
    || plan.executionEnvelope?.workerContainer?.pullPolicy !== 'never'
    || plan.executionEnvelope?.workerContainer?.rootFilesystemReadOnly !== true
    || plan.executionEnvelope?.workerContainer?.sourceRuntimeFromPinnedImage !== true
    || plan.executionEnvelope?.workerContainer?.hostSourceMounted !== false
    || plan.executionEnvelope?.workerContainer?.policyInputsMount !== 'read-only'
    || plan.executionEnvelope?.workerContainer?.phaseRootMount !== 'read-write'
    || plan.executionEnvelope?.workerContainer?.kubeconfigMounted !== false
    || plan.executionEnvelope?.workerContainer?.gatewayManagementCredentialsPassed !== false
    || plan.executionEnvelope?.workerContainer?.inferenceCredentialEnvironmentNameOnly !== 'OPENAI_API_KEY'
    || plan.executionEnvelope?.qualificationArtifactStoreRelativePath !== 'normal-engine-qualification-store'
    || plan.executionEnvelope?.transportPreflightDeadlineMs !== TRANSPORT_PREFLIGHT_DEADLINE_MS
    || plan.executionEnvelope?.transportPreflightDeadlineMs > RESERVED_OVERHEAD_MS
    || plan.executionEnvelope?.childAbortDrainGraceMs !== 10_000
    || plan.executionEnvelope?.exactLogCaptureReserveMs !== CAPTURE_RESERVE_MS
    || plan.executionEnvelope?.requiredHistoryPreflightReserveMs !== REQUIRED_HISTORY_PREFLIGHT_MS
    || plan.executionEnvelope?.orchestrationAndTeardownReserveMs !== RESERVED_OVERHEAD_MS
    || plan.executionEnvelope?.reservationLedgerMs?.total !== PHASE_WALL_LIMIT_MS
    || plan.executionEnvelope?.operator200AttemptOverride !== 'unset'
    || plan.executionEnvelope?.maxLogicalCompletionAttemptsPerNormalReview !== 100
    || plan.executionEnvelope?.trustedProviderAttemptBudget?.capabilityVersion !== 'ReviewProviderAttemptBudget.v1'
    || plan.executionEnvelope?.trustedProviderAttemptBudget?.totalLimit !== 100
    || plan.executionEnvelope?.trustedProviderAttemptBudget?.investigationLimit !== 88
    || plan.executionEnvelope?.trustedProviderAttemptBudget?.verifierReserve !== 12
    || plan.executionEnvelope?.trustedProviderAttemptBudget?.totalIncludesVerifierReserve !== true
    || plan.executionEnvelope?.trustedProviderAttemptBudget?.operatorOverrideValue !== 'unset'
    || plan.executionEnvelope?.maxTasksPerNormalReview !== 8
    || plan.executionEnvelope?.maxReviewAssignmentsPerNormalReview !== 24
    || plan.executionEnvelope?.verifierReserve !== 'read from the exact trusted prepared configuration; never omit or reduce'
    || plan.executionEnvelope?.concurrency !== 1
    || plan.executionEnvelope?.automaticRetries !== 0) {
    throw new Error('external_normal_v2_plan_contract_invalid');
  }
  if (plan.physicalAttemptAccounting?.historicalConsumedAttempts !== HISTORICAL_PHYSICAL_ATTEMPTS
    || plan.physicalAttemptAccounting?.newPhaseMaximum !== CLIENT_CALL_LIMIT
    || plan.physicalAttemptAccounting?.overallCeiling !== OVERALL_PHYSICAL_ATTEMPT_CEILING
    || plan.physicalAttemptAccounting?.newAttemptsDoNotResetHistoricalConsumption !== true) {
    throw new Error('external_normal_v2_physical_attempt_accounting_invalid');
  }
  const expectedLedger = 5 * NORMAL_ARM_MS + 30_000 + 60_000 + 15_000 + REQUIRED_HISTORY_PREFLIGHT_MS
    + CAPTURE_RESERVE_MS + RESERVED_OVERHEAD_MS;
  if (expectedLedger !== PHASE_WALL_LIMIT_MS
    || plan.executionEnvelope.reservationLedgerMs.fiveNormalArms !== 5 * NORMAL_ARM_MS
    || plan.executionEnvelope.reservationLedgerMs.providerFailureControl !== 30_000
    || plan.executionEnvelope.reservationLedgerMs.resourceExhaustionControl !== 60_000
    || plan.executionEnvelope.reservationLedgerMs.coveragePreflight !== 15_000
    || plan.executionEnvelope.reservationLedgerMs.requiredHistoryPreflight !== REQUIRED_HISTORY_PREFLIGHT_MS
    || plan.executionEnvelope.reservationLedgerMs.exactLogCaptureOutsideChild !== CAPTURE_RESERVE_MS
    || plan.executionEnvelope.reservationLedgerMs.orchestrationAndTeardown !== RESERVED_OVERHEAD_MS) {
    throw new Error('external_normal_v2_reservation_ledger_invalid');
  }
  const bundleByCase = new Map(bundle.cases.map((entry) => [entry.caseId, entry]));
  if (bundleByCase.size !== Object.keys(INPUTS).length || !Array.isArray(plan.runs) || plan.runs.length !== 9
    || plan.targetProjections?.length !== 3 || !plan.targetProjections.every((row) =>
      row.effectiveConfigSha256 === plan.policy.effectiveConfigSha256)) {
    throw new Error('external_normal_v2_case_set_invalid');
  }
  if (!plan.policyInputs || plan.policyInputs.allFilesMode0600 !== true || plan.policyInputs.useOnlyExactDigestsAbove !== true
    || POLICY_INPUTS.some((input) => plan.policyInputs[input.key] !== `policy-inputs/${input.path}`)) {
    throw new Error('external_normal_v2_policy_input_pins_invalid');
  }
  const seen = new Set();
  let allocatedCalls = 0;
  for (const [index, step] of plan.runs.entries()) {
    const input = validateStep(step, index, bundleByCase);
    allocatedCalls += clientCallAllocationForStep(step);
    if (seen.has(step.stepId)) throw new Error('external_normal_v2_duplicate_step');
    seen.add(step.stepId);
  }
  if (seen.size !== SAFE_STEP_IDS.size || [...SAFE_STEP_IDS].some((id) => !seen.has(id))) {
    throw new Error('external_normal_v2_step_set_invalid');
  }
  if (allocatedCalls !== plan.executionEnvelope.perArmClientHttpAttemptAllocation.declaredArmTotal
    || allocatedCalls + plan.executionEnvelope.perArmClientHttpAttemptAllocation.unspendableSharedReserve !== CLIENT_CALL_LIMIT) {
    throw new Error('external_normal_v2_per_arm_call_allocation_invalid');
  }
  return plan;
}

export async function verifyPolicyInputFiles(policyInputRoot, plan, privateBinding) {
  validateExternalNormalV2PrivateBinding(privateBinding);
  const root = await canonicalExistingDirectoryWithoutSymlinks(policyInputRoot, { allowTmpAlias: true });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0) {
    throw new Error('external_normal_v2_policy_root_invalid_or_not_private');
  }
  const parsed = [];
  const actualHashes = [];
  for (const expected of POLICY_INPUTS) {
    const bytes = await readRepositoryFileWithoutSymlinks(root, expected.path);
    const fileInfo = await lstat(path.join(root, expected.path));
    if ((fileInfo.mode & 0o077) !== 0) throw new Error(`external_normal_v2_policy_input_permissions_invalid:${expected.key}`);
    const expectedDigest = privateBinding.policy.policyInputDigests[expected.key];
    if (sha256(bytes) !== expectedDigest) throw new Error(`external_normal_v2_policy_input_digest_mismatch:${expected.key}`);
    parsed.push(JSON.parse(bytes.toString('utf8')));
    actualHashes.push(sha256(bytes));
  }
  const [candidate, execution, preparedFixture, projections, preparedManifest] = parsed;
  const source = privateBinding.sourceDescriptor;
  const sourceOwner = source.repository.split('/')[0];
  if (source.contentSha256 !== plan.policy.candidateRawSha256
    || candidate.schema !== `${sourceOwner}.review-policy.v1`
    || actualHashes[0] !== plan.policy.candidateRawSha256
    || actualHashes[1] !== plan.policy.executionPlanFixtureSha256
    || actualHashes[2] !== plan.policy.preparedExecutionFixtureSha256
    || actualHashes[3] !== plan.policy.syntheticProjectionFixtureSha256
    || actualHashes[4] !== plan.policy.preparedExecutionManifestSha256
    || preparedFixture.schema !== `${sourceOwner}.review-yeti-prepared-execution-host-fixture.v1`
    || preparedFixture.preparation_only !== true || preparedFixture.review_posting_enabled !== false
    || preparedFixture.candidate_policy.repository !== source.repository
    || preparedFixture.candidate_policy.repository_id !== source.repositoryId
    || preparedFixture.candidate_policy.source_sha !== source.sourceRef
    || preparedFixture.candidate_policy.path !== source.path
    || preparedFixture.candidate_policy.content_sha256 !== source.contentSha256
    || preparedFixture.prepared_by.repository !== 'review-yeti-ai/review-yeti-bot'
    || preparedFixture.prepared_by.source_sha !== plan.runtime.preparedConfigHelperSourceRevision
    || preparedFixture.prepared_by.helper !== 'preparePublishingPolicy'
    || preparedFixture.prepared_by.helper_path !== 'src/review/preparedPublishingPolicy.ts'
    || preparedFixture.prepared_by.helper_source_file_sha256 !== plan.runtime.preparedConfigHelperSourceFileSha256
    || preparedFixture.prepared_by.helper_compiled_file_sha256 !== plan.runtime.preparedConfigHelperCompiledFileSha256
    || preparedFixture.prepared_by.worker_image_index_digest !== privateBinding.runtime.workerImageDigest
    || preparedFixture.prepared_by.worker_runtime_manifest_sha256 !== privateBinding.runtime.runtimeManifestSha256
    || preparedFixture.transport.baseUrl !== privateBinding.transport.selectedBaseUrl
    || preparedFixture.transport.model !== privateBinding.transport.modelAlias
    || preparedManifest.schema !== `${sourceOwner}.review-yeti-prepared-execution-host-bundle.v1`
    || preparedManifest.fixture_path !== 'review-yeti-v2-prepared-execution-host.fixture.json'
    || preparedManifest.fixture_sha256 !== actualHashes[2]
    || preparedManifest.prepared_from.repository !== source.repository
    || preparedManifest.prepared_from.repository_id !== source.repositoryId
    || preparedManifest.prepared_from.source_sha !== source.sourceRef
    || preparedManifest.prepared_from.content_sha256 !== source.contentSha256
    || !preparedConfigHelperProvenanceMatchesPlan(preparedManifest, plan)
    || preparedManifest.transport.provider !== 'bifrost' || preparedManifest.transport.baseUrl !== privateBinding.transport.selectedBaseUrl
    || preparedManifest.transport.model !== privateBinding.transport.modelAlias
    || preparedManifest.samples.length !== 6
    || projections.prepared_execution_fixture_sha256 !== actualHashes[2]
    || projections.prepared_execution_fixture_path !== 'review-yeti-v2-prepared-execution-host.fixture.json'
    || projections.source_revision !== source.sourceRef
    || projections.schema !== `${sourceOwner}.review-yeti-offline-candidate-projections.v2`
    || projections.review_posting_enabled !== false
    || projections.policy_sha256 !== expectedPolicyHash(plan)
    || projections.cases.length !== plan.targetProjections.length) {
    throw new Error('external_normal_v2_policy_input_contract_invalid');
  }
  const preparedTargets = [];
  for (const target of plan.targetProjections) {
    const projected = projections.cases.find((row) => row.id === target.repositoryId);
    const preparedTarget = preparedFixture.targets.find((row) => row.id === target.repositoryId);
    const preparedScenario = preparedTarget?.scenarios?.default;
    const projectionPrepared = projected?.prepared_execution?.default;
    const manifestPrepared = preparedManifest.samples.find((row) => row.id === target.repositoryId && row.scenario === 'default');
    if (!projected || projected.repository !== target.repository || projected.pr_number !== target.prNumber
      || projected.central_projection.normalized_plan_sha256 !== target.normalizedPlanSha256
      || projected.central_projection.plan.effective_configuration?.effective?.provider?.model_alias !== plan.policy.routeAlias
      || projected.central_projection.plan.effective_configuration?.effective?.provider?.requested_effort !== plan.policy.requestedEffort
      || projected.central_projection.plan.lane?.max_review_assignments !== plan.executionEnvelope.maxReviewAssignmentsPerNormalReview
      || !preparedScenario || !projectionPrepared
      || !manifestPrepared || path.basename(manifestPrepared.path) !== path.basename(target.preparedExecutionFile)
      || manifestPrepared.prepared_execution_sha256 !== target.preparedExecutionSha256
      || manifestPrepared.effective_config_digest !== target.effectiveConfigSha256
      || manifestPrepared.effective_policy_digest !== target.effectivePolicySha256
      || manifestPrepared.provider_attempt_budget?.total_limit !== 100
      || manifestPrepared.provider_attempt_budget?.investigation_limit !== 88
      || manifestPrepared.provider_attempt_budget?.verifier_reserve !== 12
      || manifestPrepared.provider_attempt_budget?.operator_override_value !== null
      || target.preparedExecutionFile !== `prepared-host/prepared-${target.repositoryId}-default.json`
      || preparedTarget.repository !== target.repository || path.basename(preparedScenario.prepared_execution_file) !== path.basename(target.preparedExecutionFile)
      || preparedScenario.prepared_execution_sha256 !== target.preparedExecutionSha256
      || preparedScenario.effective_config_digest !== target.effectiveConfigSha256
      || preparedScenario.effective_policy_digest !== target.effectivePolicySha256
      || projectionPrepared.prepared_execution_sha256 !== target.preparedExecutionSha256
      || projectionPrepared.effective_config_digest !== target.effectiveConfigSha256
      || projectionPrepared.provider_attempt_budget?.capability_version !== 'ReviewProviderAttemptBudget.v1'
      || projectionPrepared.provider_attempt_budget?.total_limit !== 100
      || projectionPrepared.provider_attempt_budget?.investigation_limit !== 88
      || projectionPrepared.provider_attempt_budget?.verifier_reserve !== 12
      || projectionPrepared.provider_attempt_budget?.operator_override_value !== null) {
      throw new Error('external_normal_v2_target_projection_mismatch');
    }
    const preparedBytes = await readRepositoryFileWithoutSymlinks(root, target.preparedExecutionFile);
    const preparedStat = await lstat(path.join(root, target.preparedExecutionFile));
    if ((preparedStat.mode & 0o077) !== 0 || sha256(preparedBytes) !== target.preparedExecutionSha256) {
      throw new Error('external_normal_v2_prepared_execution_digest_or_permissions_mismatch');
    }
    const prepared = JSON.parse(preparedBytes.toString('utf8'));
    const attemptBudget = prepared.config?.review_configuration_receipt?.effective?.composed_budget?.provider_attempt_budget;
    if (prepared.version !== 'PreparedReviewExecution.v1'
      || prepared.transport?.baseUrl !== privateBinding.transport.selectedBaseUrl
      || prepared.transport?.model !== privateBinding.transport.modelAlias
      || prepared.config?.review_configuration_receipt?.effective?.composed_budget?.central_policy_max_tasks !== plan.executionEnvelope.maxTasksPerNormalReview
      || prepared.config?.review_configuration_receipt?.effective?.composed_budget?.central_policy_total_turns !== 100
      || attemptBudget?.capability_version !== 'ReviewProviderAttemptBudget.v1' || attemptBudget.total_limit !== 100
      || attemptBudget.investigation_limit !== 88 || attemptBudget.verifier_reserve !== 12
      || attemptBudget.operator_override_value !== null
      || prepared.config?.review_configuration_receipt?.effective?.provider?.requested_effort !== plan.policy.requestedEffort) {
      throw new Error('external_normal_v2_prepared_execution_contract_invalid');
    }
    preparedTargets.push({ repositoryId: target.repositoryId,
      file: preparedScenario.prepared_execution_file,
      sha256: sha256(preparedBytes),
      effectiveConfigSha256: preparedScenario.effective_config_digest,
      effectivePolicySha256: preparedScenario.effective_policy_digest,
      totalLimit: attemptBudget.total_limit,
      investigationLimit: attemptBudget.investigation_limit,
      verifierReserve: attemptBudget.verifier_reserve,
      operatorOverrideValue: attemptBudget.operator_override_value,
      centralPolicyMaxTasks: prepared.config.review_configuration_receipt.effective.composed_budget.central_policy_max_tasks,
    });
  }
  const normalizedPlan = execution.plan;
  if (!normalizedPlan || execution.normalized_plan_sha256 !== plan.policy.executionPlanNormalizedSha256
    || sha256(canonicalJson(normalizedPlan)) !== execution.normalized_plan_sha256) {
    throw new Error('external_normal_v2_primary_execution_plan_mismatch');
  }
  return { candidateSha256: actualHashes[0], executionPlanFixtureSha256: actualHashes[1],
    preparedExecutionFixtureSha256: actualHashes[2], projectionSha256: actualHashes[3],
    preparedExecutionSha256: plan.policy.preparedExecutionSha256,
    preparedTargets,
    centralProjectionConfigSha256: plan.policy.centralEffectiveConfigProjectionSha256,
    configSha256: plan.policy.effectiveConfigSha256 };
}

export function preparedConfigHelperProvenanceMatchesPlan(preparedManifest, plan) {
  const helper = preparedManifest?.helper;
  const expectedRevision = plan?.runtime?.preparedConfigHelperSourceRevision;
  const expectedSourceSha256 = plan?.runtime?.preparedConfigHelperSourceFileSha256;
  const expectedCompiledSha256 = plan?.runtime?.preparedConfigHelperCompiledFileSha256;
  return /^[a-f0-9]{40}$/iu.test(expectedRevision || '')
    && /^[a-f0-9]{64}$/iu.test(expectedSourceSha256 || '')
    && /^[a-f0-9]{64}$/iu.test(expectedCompiledSha256 || '')
    && plan?.runtime?.finalSourceRevision === expectedRevision
    && helper?.repository === 'review-yeti-ai/review-yeti-bot'
    && helper?.helper === 'preparePublishingPolicy'
    && helper?.helper_path === 'src/review/preparedPublishingPolicy.ts'
    && helper?.source_sha === expectedRevision
    && helper?.source_file_sha256 === expectedSourceSha256
    && helper?.compiled_file_sha256 === expectedCompiledSha256;
}

function expectedPolicyHash(plan) {
  return plan.policy.candidateRawSha256;
}

export async function readFrozenExternalNormalV2Plan(repositoryRoot) {
  const [planBytes, bundleBytes] = await Promise.all([
    readRepositoryFileWithoutSymlinks(repositoryRoot, EXTERNAL_NORMAL_V2_PLAN_PATH),
    readRepositoryFileWithoutSymlinks(repositoryRoot, EXTERNAL_NORMAL_V2_BUNDLE_PATH),
  ]);
  if (sha256(planBytes) !== EXTERNAL_NORMAL_V2_PLAN_SHA256) throw new Error('external_normal_v2_plan_digest_mismatch');
  if (sha256(bundleBytes) !== EXTERNAL_NORMAL_V2_BUNDLE_SHA256) throw new Error('external_normal_v2_bundle_digest_mismatch');
  let plan; let bundle;
  try { plan = JSON.parse(planBytes.toString('utf8')); bundle = JSON.parse(bundleBytes.toString('utf8')); }
  catch { throw new Error('external_normal_v2_descriptor_json_invalid'); }
  validateExternalNormalV2Plan(plan, bundle);
  for (const [caseId, input] of Object.entries(INPUTS)) {
    const bytes = await readRepositoryFileWithoutSymlinks(repositoryRoot, input.path);
    if (sha256(bytes) !== input.sha256) throw new Error(`external_normal_v2_input_digest_mismatch:${caseId}`);
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`external_normal_v2_input_json_invalid:${caseId}`); }
    assertNoOutcomeLabels(parsed, `input.${caseId}`);
    if (parsed.caseId !== caseId || bundle.cases.find((entry) => entry.caseId === caseId)?.inputSha256 !== input.sha256) {
      throw new Error(`external_normal_v2_input_case_identity_invalid:${caseId}`);
    }
  }
  return { plan, bundle, planSha256: sha256(planBytes), bundleSha256: sha256(bundleBytes) };
}

const R2_ASSESSMENT_STEP_IDS = Object.freeze({
  'r2-s001': 'v2-p2-first',
  'r2-s002': 'v2-p2-repeat',
  'r2-s003': 'v2-sequence-a',
  'r2-s004': 'v2-sequence-b-history',
  'r2-s005': 'v2-sequence-b-full-source',
  'r2-s006': 'v2-coverage-hole-control',
  'r2-s007': 'v2-required-history-unavailable-control',
  'r2-s008': 'v2-provider-failure-control',
  'r2-s009': 'v2-resource-exhaustion-control',
});

function createExternalNormalR2ExecutionPlan(template, admitted, bundle, privateBinding, routeIdentity) {
  const bound = bindExternalNormalV2PrivateInputs(template, privateBinding, routeIdentity);
  if (bound.runtime.preparedConfigHelperSourceFileSha256 !== R2_PREPARED_CONFIG_HELPER_SOURCE_FILE_SHA256
    || bound.runtime.preparedConfigHelperCompiledFileSha256 !== R2_PREPARED_CONFIG_HELPER_COMPILED_FILE_SHA256) {
    throw new Error('external_normal_r2_prepared_config_helper_bytes_invalid');
  }
  const runtime = { ...bound.runtime, preparedConfigHelperSourceRevision: bound.runtime.finalSourceRevision };
  const casesByRepository = new Map();
  for (const entry of admitted.cases) {
    if (!casesByRepository.has(entry.repository.repositoryId)) {
      casesByRepository.set(entry.repository.repositoryId, entry);
    }
  }
  const targetProjections = bound.targetProjections.map((target) => {
    const source = casesByRepository.get(target.repositoryId);
    if (!source) throw new Error('external_normal_r2_policy_target_set_invalid');
    return { ...target, repository: `${source.repository.owner}/${source.repository.repo}`, prNumber: source.prNumber };
  });
  if (targetProjections.length !== 3 || casesByRepository.size !== 3) {
    throw new Error('external_normal_r2_policy_target_set_invalid');
  }
  const sourceBundle = { ...bundle, version: bundle.schemaVersion, path: R2_BUNDLE_PATH, sha256: R2_BUNDLE_SHA256 };
  const allocations = admitted.executionEnvelope.perArmClientCallAllocations;
  const reservations = admitted.executionEnvelope.perArmTimeReservationMs;
  const executionEnvelope = {
    ...bound.executionEnvelope,
    maxPhaseClientCalls: admitted.executionEnvelope.maxPhaseClientCalls,
    perArmClientCallAllocations: allocations,
    perArmTimeReservationMs: reservations,
    normalArmActiveReservationTotalMs: admitted.executionEnvelope.normalArmActiveReservationTotalMs,
    reservationLedgerMs: admitted.executionEnvelope.reservationLedgerMs,
    perArmClientHttpAttemptAllocation: {
      normalArms: admitted.executionEnvelope.perArmClientHttpAttemptAllocation.outerCapPerNormalArm,
      outerCapPerNormalArm: admitted.executionEnvelope.perArmClientHttpAttemptAllocation.outerCapPerNormalArm,
      normalArmAllocationTotal: admitted.executionEnvelope.perArmClientHttpAttemptAllocation.normalArmAllocationTotal,
      providerFailureControl: admitted.executionEnvelope.perArmClientHttpAttemptAllocation.providerAuthControl,
      resourceExhaustionControl: admitted.executionEnvelope.perArmClientHttpAttemptAllocation.resourceExhaustionControl,
      coveragePreflightControl: admitted.executionEnvelope.perArmClientHttpAttemptAllocation.coveragePreflightControl,
      requiredHistoryPreflightControl: admitted.executionEnvelope.perArmClientHttpAttemptAllocation.requiredHistoryPreflightControl,
      declaredArmTotal: admitted.executionEnvelope.declaredArmTotal,
      unspendableSharedReserve: admitted.executionEnvelope.unspendableSharedReserve,
      synchronousBlockBeforeFetch: true,
    },
    phaseWallLimitMs: admitted.executionEnvelope.phaseWallLimitMs,
    exactLogCaptureReserveMs: admitted.executionEnvelope.exactLogCaptureReserveMs,
    requiredHistoryPreflightReserveMs: admitted.executionEnvelope.reservationLedgerMs.requiredHistoryPreflightControl,
    orchestrationAndTeardownReserveMs: admitted.executionEnvelope.orchestrationAndTeardownReserveMs,
    transportPreflightDeadlineMs: TRANSPORT_PREFLIGHT_DEADLINE_MS,
    captureOutsideChildDeadline: true,
    concurrency: 1,
    automaticRetries: 0,
  };
  const runs = admitted.runs;
  return {
    ...bound,
    runtime,
    phaseId: admitted.phaseId,
    status: 'frozen-ready-awaiting-root-go',
    dispatchAuthorization: false,
    sourceBundle,
    targetProjections,
    runs,
    executionEnvelope,
    physicalAttemptAccounting: {
      historicalConsumedAttempts: R2_HISTORICAL_PHYSICAL_ATTEMPTS,
      newPhaseMaximum: admitted.executionEnvelope.maxPhaseClientCalls,
      overallCeiling: OVERALL_PHYSICAL_ATTEMPT_CEILING,
      newAttemptsDoNotResetHistoricalConsumption: true,
    },
  };
}

async function readFrozenExternalNormalR2Inputs(repositoryRoot, executionPlan, sourceBundle, executionPlanSha256,
  executionPlanBytes) {
  const root = repositoryRoot || process.cwd();
  const admitted = validateExternalNormalR2CohortPlan(executionPlan, sourceBundle, executionPlanSha256, executionPlanBytes);
  const bundleBytes = await readRepositoryFileWithoutSymlinks(root, R2_BUNDLE_PATH);
  if (sha256(bundleBytes) !== R2_BUNDLE_SHA256) throw new Error('external_normal_r2_bundle_digest_mismatch');
  let parsedBundle;
  try { parsedBundle = JSON.parse(bundleBytes.toString('utf8')); }
  catch { throw new Error('external_normal_r2_bundle_json_invalid'); }
  if (canonicalJson(parsedBundle) !== canonicalJson(sourceBundle)) {
    throw new Error('external_normal_r2_caller_bundle_mismatch');
  }
  const inputByCase = new Map();
  for (const entry of admitted.cases) {
    const bytes = await readRepositoryFileWithoutSymlinks(root, entry.inputPath);
    if (sha256(bytes) !== entry.inputSha256) throw new Error(`external_normal_r2_input_digest_mismatch:${entry.caseId}`);
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error(`external_normal_r2_input_json_invalid:${entry.caseId}`); }
    assertNoOutcomeLabels(parsed, `input.${entry.caseId}`);
    const source = parsed?.source;
    if (parsed?.schemaVersion !== entry.schemaVersion || parsed?.caseId !== entry.caseId
      || canonicalJson(source?.repository) !== canonicalJson(entry.repository)
      || source?.prNumber !== entry.prNumber || source?.baseSha !== entry.baseSha || source?.headSha !== entry.headSha) {
      throw new Error(`external_normal_r2_input_identity_invalid:${entry.caseId}`);
    }
    inputByCase.set(entry.caseId, parsed);
  }
  return { admitted, bundle: parsedBundle, inputByCase, planSha256: R2_COHORT_PLAN_SHA256 };
}

async function readPinnedExternalNormalR2PolicyTemplate(repositoryRoot) {
  const bytes = await readRepositoryFileWithoutSymlinks(repositoryRoot, EXTERNAL_NORMAL_V2_PLAN_PATH);
  if (sha256(bytes) !== EXTERNAL_NORMAL_V2_PLAN_SHA256) {
    throw new Error('external_normal_r2_policy_template_digest_mismatch');
  }
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('external_normal_r2_policy_template_invalid'); }
}

function buildExternalNormalR2AuthorizationTuple(plan, planSha256, outputRootSha256,
  launcherSourceTupleSha256, artifactStoreIdentitySha256, privateBinding, routeIdentity, admitted) {
  validateExternalNormalV2PrivateBinding(privateBinding);
  assertExternalNormalV2PlanMatchesPrivateBinding(plan, privateBinding, routeIdentity);
  const inputs = admitted.cases.map(({ caseId, inputSha256 }) => ({ caseId, inputSha256 }))
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
  const runtime = plan.runtime || {};
  const policy = plan.policy || {};
  const runtimeTuple = { sourceRevision: runtime.finalSourceRevision, workerImageDigest: runtime.workerImageDigest,
    runtimeManifestSha256: runtime.runtimeManifestSha256, budgetFixSource: runtime.currentBudgetFixCandidate,
    preparedConfigHelperSourceRevision: runtime.preparedConfigHelperSourceRevision,
    preparedConfigHelperSourceFileSha256: runtime.preparedConfigHelperSourceFileSha256,
    preparedConfigHelperCompiledFileSha256: runtime.preparedConfigHelperCompiledFileSha256,
    workerImageRepository: runtime.workerImageRepository, executionMode: runtime.executionMode,
    executionNetwork: runtime.executionNetwork, executionUser: runtime.executionUser,
    artifactStoreBinding: runtime.artifactStoreBinding };
  const policyTuple = { candidateHead: policy.candidateHead, candidateRawSha256: policy.candidateRawSha256,
    candidateGitBlob: policy.candidateGitBlob, preparedFixtureReviewHead: policy.preparedFixtureReviewHead,
    executionPlanFixtureSha256: policy.executionPlanFixtureSha256,
    executionPlanNormalizedSha256: policy.executionPlanNormalizedSha256,
    syntheticProjectionFixtureSha256: policy.syntheticProjectionFixtureSha256, routeAlias: policy.routeAlias,
    requestedEffort: policy.requestedEffort, inferenceBaseUrl: policy.inferenceBaseUrl,
    preparedExecutionFixtureSha256: policy.preparedExecutionFixtureSha256,
    preparedExecutionSha256: policy.preparedExecutionSha256,
    centralEffectiveConfigProjectionSha256: policy.centralEffectiveConfigProjectionSha256,
    effectiveConfigSha256: policy.effectiveConfigSha256, effectivePolicySha256: policy.effectivePolicySha256,
    routeIdentitySha256: sha256(canonicalJson(policy.routeIdentity)),
    servedProviderModelEffort: policy.servedProviderModelEffort, v1Promotion: policy.v1Promotion,
    policyInputDigestsSha256: sha256(canonicalJson(privateBinding.policy.policyInputDigests)),
    targetProjectionPinsSha256: sha256(canonicalJson(privateBinding.policy.targetProjections)),
    policySource: policy.policySource };
  return {
    phaseId: R2_PHASE_ID,
    phasePlanSha256: planSha256,
    cohortDescriptorSha256: R2_COHORT_PLAN_SHA256,
    sourceBundleSha256: R2_BUNDLE_SHA256,
    sourceInputSetSha256: sha256(canonicalJson(inputs)),
    inputManifestSha256: R2_INPUT_MANIFEST_SHA256,
    runtimeTupleSha256: sha256(canonicalJson(runtimeTuple)),
    policyTupleSha256: sha256(canonicalJson(policyTuple)),
    routeIdentitySha256: sha256(canonicalJson(routeIdentity)),
    phaseRootCanonicalPathSha256: sha256(plan.artifactRoots.phaseRoot.canonicalPath),
    phaseRootIdentitySpecSha256: sha256(canonicalJson(plan.artifactRoots.phaseRoot)),
    privateBindingSha256: sha256(canonicalJson(privateBinding)),
    effectiveConfigSha256: policy.effectiveConfigSha256,
    outputRootSha256,
    qualificationArtifactStoreRootSha256: outputRootSha256,
    qualificationArtifactStoreIdentitySha256: artifactStoreIdentitySha256,
    launcherSourceTupleSha256,
  };
}

export function validateExternalNormalR2RootGoGrant(plan, grant, tuple, nowMs = Date.now()) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return false;
  const keys = ['schemaVersion', 'rootGo', 'grantId', 'issuedAt', 'expiresAt', 'binding'];
  if (Object.keys(grant).sort().join('|') !== keys.sort().join('|')
    || grant.schemaVersion !== EXTERNAL_NORMAL_R2_ROOT_GO_SCHEMA || grant.rootGo !== true
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(grant.grantId || '')) return false;
  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  return Number.isFinite(issuedAt) && Number.isFinite(expiresAt) && issuedAt <= nowMs
    && expiresAt > nowMs && expiresAt > issuedAt && expiresAt - issuedAt <= 300_000
    && canonicalJson(grant.binding) === canonicalJson(tuple)
    && plan.phaseId === R2_PHASE_ID && tuple.phaseId === R2_PHASE_ID
    && tuple.phasePlanSha256 === R2_COHORT_PLAN_SHA256
    && tuple.cohortDescriptorSha256 === R2_COHORT_PLAN_SHA256
    && tuple.sourceBundleSha256 === R2_BUNDLE_SHA256
    && tuple.inputManifestSha256 === R2_INPUT_MANIFEST_SHA256
    && /^[a-f0-9]{64}$/u.test(tuple.privateBindingSha256 || '')
    && /^[a-f0-9]{64}$/u.test(tuple.routeIdentitySha256 || '')
    && tuple.outputRootSha256 === tuple.phaseRootCanonicalPathSha256
    && tuple.qualificationArtifactStoreRootSha256 === tuple.outputRootSha256
    && tuple.effectiveConfigSha256 === plan.policy?.effectiveConfigSha256
    && /^[a-f0-9]{64}$/u.test(tuple.runtimeTupleSha256 || '')
    && /^[a-f0-9]{64}$/u.test(tuple.policyTupleSha256 || '')
    && /^[a-f0-9]{64}$/u.test(tuple.sourceInputSetSha256 || '')
    && /^[a-f0-9]{64}$/u.test(tuple.launcherSourceTupleSha256 || '')
    && tuple.phaseRootCanonicalPathSha256 === sha256(plan.artifactRoots?.phaseRoot?.canonicalPath || '')
    && tuple.phaseRootIdentitySpecSha256 === sha256(canonicalJson(plan.artifactRoots?.phaseRoot));
}

async function prepareExternalNormalR2Execution({ repositoryRoot, executionPlan, executionPlanSha256, executionPlanBytes,
  sourceBundle, policyInputRoot, phaseRoot, privateBinding, routeIdentity } = {}) {
  const root = repositoryRoot || process.cwd();
  const r2 = await readFrozenExternalNormalR2Inputs(root, executionPlan, sourceBundle, executionPlanSha256, executionPlanBytes);
  // Only the exact shared runtime/policy shell is inherited; R2 admission and execution always
  // use the independently pinned v3 bundle and nine-step plan above.
  const frozenTemplate = await readPinnedExternalNormalR2PolicyTemplate(root);
  validateExternalNormalV2PrivateBinding(privateBinding);
  validateExternalNormalV2RouteIdentity(routeIdentity);
  const plan = createExternalNormalR2ExecutionPlan(frozenTemplate, r2.admitted, r2.bundle,
    privateBinding, routeIdentity);
  if (plan.status !== 'frozen-ready-awaiting-root-go' || plan.dispatchAuthorization !== false
    || !plan.runtime?.finalSourceRevision || !plan.runtime?.workerImageDigest || !plan.runtime?.runtimeManifestSha256
    || !plan.policy?.effectiveConfigSha256 || !plan.targetProjections.every((target) =>
      target.effectiveConfigSha256 === plan.policy.effectiveConfigSha256)) {
    throw new Error('external_normal_r2_candidate_not_frozen');
  }
  assertExternalNormalV2PlanMatchesPrivateBinding(plan, privateBinding, routeIdentity);
  const verifiedPolicyInputs = await verifyPolicyInputFiles(policyInputRoot, plan, privateBinding);
  if (phaseRoot && phaseRoot !== privateBinding.phaseRoot.canonicalPath) {
    throw new Error('external_normal_r2_phase_root_binding_rejected');
  }
  const canonicalRoot = await canonicalizePhaseRoot(privateBinding.phaseRoot.canonicalPath);
  const rootInfo = await lstat(canonicalRoot);
  if (!validateExternalNormalV2PhaseRootIdentity(plan, canonicalRoot, rootInfo)) {
    throw new Error('external_normal_r2_phase_root_binding_rejected');
  }
  const outputRootSha256 = sha256(canonicalRoot);
  const artifactStoreIdentitySha256 = sha256(canonicalJson({ pathSha256: outputRootSha256,
    uid: rootInfo.uid, gid: rootInfo.gid, mode: rootInfo.mode & 0o777 }));
  const launcherSourceDigests = await readExternalNormalV2LauncherSourceDigests(root);
  const tuple = buildExternalNormalR2AuthorizationTuple(plan, r2.planSha256, outputRootSha256,
    launcherSourceDigests.tupleSha256, artifactStoreIdentitySha256, privateBinding, routeIdentity, r2.admitted);
  return { plan, bundle: r2.bundle, planSha256: r2.planSha256, admitted: r2.admitted,
    inputByCase: r2.inputByCase, tuple,
    canonicalRoot, verifiedPolicyInputs, launcherSourceDigests, artifactStoreIdentitySha256 };
}

export async function prepareExternalNormalR2AuthorizationTuple(input) {
  const prepared = await prepareExternalNormalR2Execution(input);
  return { phaseId: R2_PHASE_ID, phasePlanSha256: R2_COHORT_PLAN_SHA256,
    sourceBundleSha256: R2_BUNDLE_SHA256, authorizationTuple: prepared.tuple };
}

export async function validatePreparedExternalNormalR2Grant(input, grant, nowMs = Date.now()) {
  const prepared = await prepareExternalNormalR2Execution(input);
  const authorized = validateExternalNormalR2RootGoGrant(prepared.plan, grant, prepared.tuple, nowMs);
  return { status: authorized ? 'authorized' : 'authorization_rejected', phaseId: R2_PHASE_ID,
    phasePlanSha256: R2_COHORT_PLAN_SHA256, sourceBundleSha256: R2_BUNDLE_SHA256,
    authorizationTuple: prepared.tuple };
}

export function buildExternalNormalV2AuthorizationTuple(plan, planSha256, outputRootSha256,
  launcherSourceTupleSha256 = '0'.repeat(64), artifactStoreIdentitySha256 = outputRootSha256, privateBinding, routeIdentity) {
  validateExternalNormalV2PrivateBinding(privateBinding);
  assertExternalNormalV2PlanMatchesPrivateBinding(plan, privateBinding, routeIdentity);
  const inputs = Object.entries(INPUTS).map(([caseId, input]) => ({ caseId, inputSha256: input.sha256 })).sort((a, b) => a.caseId.localeCompare(b.caseId));
  const runtime = plan.runtime || {};
  const policy = plan.policy || {};
  const runtimeTuple = { sourceRevision: runtime.finalSourceRevision, workerImageDigest: runtime.workerImageDigest,
    runtimeManifestSha256: runtime.runtimeManifestSha256, budgetFixSource: runtime.currentBudgetFixCandidate,
    preparedConfigHelperSourceRevision: runtime.preparedConfigHelperSourceRevision,
    workerImageRepository: runtime.workerImageRepository,
    executionMode: runtime.executionMode, executionNetwork: runtime.executionNetwork,
    executionUser: runtime.executionUser, artifactStoreBinding: runtime.artifactStoreBinding };
  const policyTuple = { candidateHead: policy.candidateHead, candidateRawSha256: policy.candidateRawSha256,
    candidateGitBlob: policy.candidateGitBlob,
    preparedFixtureReviewHead: policy.preparedFixtureReviewHead,
    executionPlanFixtureSha256: policy.executionPlanFixtureSha256,
    executionPlanNormalizedSha256: policy.executionPlanNormalizedSha256,
    syntheticProjectionFixtureSha256: policy.syntheticProjectionFixtureSha256,
    routeAlias: policy.routeAlias,
    requestedEffort: policy.requestedEffort,
    inferenceBaseUrl: policy.inferenceBaseUrl,
    preparedExecutionFixtureSha256: policy.preparedExecutionFixtureSha256,
    preparedExecutionSha256: policy.preparedExecutionSha256,
    centralEffectiveConfigProjectionSha256: policy.centralEffectiveConfigProjectionSha256,
    effectiveConfigSha256: policy.effectiveConfigSha256,
    effectivePolicySha256: policy.effectivePolicySha256,
    routeIdentitySha256: sha256(canonicalJson(policy.routeIdentity)),
    servedProviderModelEffort: policy.servedProviderModelEffort, v1Promotion: policy.v1Promotion,
    policyInputDigestsSha256: sha256(canonicalJson(privateBinding.policy.policyInputDigests)),
    targetProjectionPinsSha256: sha256(canonicalJson(privateBinding.policy.targetProjections)),
    policySource: policy.policySource };
  const sourceInputSetSha256 = sha256(canonicalJson(inputs));
  const runtimeTupleSha256 = sha256(canonicalJson(runtimeTuple));
  const policyTupleSha256 = sha256(canonicalJson(policyTuple));
  return {
    phaseId: plan.phaseId,
    phasePlanSha256: planSha256,
    sourceBundleSha256: plan.sourceBundle.sha256,
    sourceInputSetSha256,
    runtimeTupleSha256,
    policyTupleSha256,
    phaseRootCanonicalPathSha256: typeof plan.artifactRoots?.phaseRoot?.canonicalPath === 'string'
      ? sha256(plan.artifactRoots.phaseRoot.canonicalPath) : null,
    phaseRootIdentitySpecSha256: plan.artifactRoots?.phaseRoot
      ? sha256(canonicalJson(plan.artifactRoots.phaseRoot)) : null,
    privateBindingSha256: sha256(canonicalJson(privateBinding)),
    effectiveConfigSha256: policy.effectiveConfigSha256,
    outputRootSha256,
    qualificationArtifactStoreRootSha256: outputRootSha256,
    qualificationArtifactStoreIdentitySha256: artifactStoreIdentitySha256,
    launcherSourceTupleSha256,
  };
}

export async function readExternalNormalV2LauncherSourceDigests(repositoryRoot) {
  const entries = [];
  for (const relativePath of LAUNCHER_SOURCE_PATHS) {
    const bytes = await readRepositoryFileWithoutSymlinks(repositoryRoot, relativePath);
    entries.push({ path: relativePath, sha256: sha256(bytes) });
  }
  return { entries, tupleSha256: sha256(canonicalJson(entries)) };
}

export function validateRootGoGrant(plan, grant, tuple, nowMs = Date.now()) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return false;
  const keys = ['schemaVersion', 'rootGo', 'grantId', 'issuedAt', 'expiresAt', 'binding'];
  if (Object.keys(grant).sort().join('|') !== keys.sort().join('|')) return false;
  if (grant.schemaVersion !== EXTERNAL_NORMAL_V2_ROOT_GO_SCHEMA || grant.rootGo !== true
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(grant.grantId || '')) return false;
  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > nowMs
    || expiresAt <= nowMs || expiresAt <= issuedAt || expiresAt - issuedAt > 300_000) return false;
  if (canonicalJson(grant.binding) !== canonicalJson(tuple) || plan.phaseId !== tuple.phaseId) return false;
  const runtime = plan.runtime || {};
  const policy = plan.policy || {};
  const phaseRootPin = plan.artifactRoots?.phaseRoot;
  return /^[a-f0-9]{40}$/u.test(runtime.finalSourceRevision || '')
    && /^sha256:[a-f0-9]{64}$/u.test(runtime.workerImageDigest || '')
    && /^[a-f0-9]{64}$/u.test(runtime.runtimeManifestSha256 || '')
    && /^[a-f0-9]{64}$/u.test(policy.effectiveConfigSha256 || '')
    && policy.effectiveConfigSha256 === plan.targetProjections?.[0]?.effectiveConfigSha256
    && /^[a-f0-9]{64}$/u.test(tuple.privateBindingSha256 || '')
    && typeof phaseRootPin?.canonicalPath === 'string'
    && tuple.phaseRootCanonicalPathSha256 === sha256(phaseRootPin.canonicalPath)
    && tuple.phaseRootIdentitySpecSha256 === sha256(canonicalJson(phaseRootPin))
    && tuple.outputRootSha256 === sha256(phaseRootPin.canonicalPath);
}

export function validateExternalNormalV2PhaseRootIdentity(plan, canonicalPath, identity) {
  const pin = plan?.artifactRoots?.phaseRoot;
  return Boolean(pin && canonicalPath === pin.canonicalPath
    && identity?.uid === pin.uid && identity?.gid === pin.gid
    && (identity?.mode & 0o777) === pin.mode);
}

export function externalNormalV2TransportPreflightDeadlineAt(plan, startedAt) {
  const deadlineMs = plan?.executionEnvelope?.transportPreflightDeadlineMs;
  const deadlineAt = startedAt + deadlineMs;
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1
    || deadlineMs > TRANSPORT_PREFLIGHT_DEADLINE_MS || deadlineMs > RESERVED_OVERHEAD_MS
    || !Number.isSafeInteger(deadlineAt)) {
    throw new Error('external_normal_v2_preflight_deadline_invalid');
  }
  return deadlineAt;
}

export function validateExternalNormalV2TransportPreflight(plan, proof) {
  const originHash = sha256(plan.policy.inferenceBaseUrl);
  const preflightDeadlineMs = plan?.executionEnvelope?.transportPreflightDeadlineMs;
  if (!proof || proof.status !== 'ready' || proof.mode !== 'dns_tls_only'
    || proof.originSha256 !== originHash || proof.workerImageDigest !== plan.runtime.workerImageDigest
    || proof.sourceRevision !== plan.runtime.finalSourceRevision
    || proof.runtimeManifestSha256 !== plan.runtime.runtimeManifestSha256
    || !Number.isSafeInteger(proof.resolvedAddressCount) || proof.resolvedAddressCount < 1
    || !/^[a-f0-9]{64}$/u.test(proof.resolvedAddressSetSha256 || '')
    || proof.tlsAuthorized !== true || !['TLSv1.2', 'TLSv1.3'].includes(proof.tlsProtocol)
    || !/^[a-f0-9]{64}$/u.test(proof.peerCertificateSha256 || '')
    || !/^[a-f0-9]{64}$/u.test(proof.tlsAddressSha256 || '')
    || !Number.isSafeInteger(preflightDeadlineMs) || preflightDeadlineMs < 1
    || preflightDeadlineMs > TRANSPORT_PREFLIGHT_DEADLINE_MS || preflightDeadlineMs > RESERVED_OVERHEAD_MS
    || !Number.isSafeInteger(proof.elapsedMs) || proof.elapsedMs < 0 || proof.elapsedMs > preflightDeadlineMs) {
    return { status: 'unavailable', failureCode: 'container_dns_tls_preflight_invalid' };
  }
  return { status: 'ready', mode: proof.mode, originSha256: proof.originSha256,
    sourceRevision: proof.sourceRevision, workerImageDigest: proof.workerImageDigest,
    runtimeManifestSha256: proof.runtimeManifestSha256,
    resolvedAddressCount: proof.resolvedAddressCount, resolvedAddressSetSha256: proof.resolvedAddressSetSha256,
    tlsAuthorized: true, tlsProtocol: proof.tlsProtocol, peerCertificateSha256: proof.peerCertificateSha256,
    tlsAddressSha256: proof.tlsAddressSha256,
    elapsedMs: proof.elapsedMs };
}

export function clientCallAllocationForStep(step) {
  if (step?.stepId === 'v2-required-history-unavailable-control') return 0;
  const input = INPUTS[step?.caseId];
  if (!input || step.arm !== (step.stepId === 'v2-sequence-b-full-source' ? 'repair-head-empty-history' : input.arm)) {
    throw new Error('external_normal_v2_step_input_identity_invalid');
  }
  return input.clientCallAllocation;
}

export function wallReservationForStep(step) {
  if (step?.stepId === 'v2-coverage-hole-control') return 15_000;
  if (step?.stepId === 'v2-required-history-unavailable-control') return REQUIRED_HISTORY_PREFLIGHT_MS;
  const input = INPUTS[step?.caseId];
  if (!input) throw new Error('external_normal_v2_step_input_identity_invalid');
  return input.reservationMs;
}

async function assertNoSymlinkDescendants(root) {
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) throw new Error('external_normal_v2_phase_root_symlink_forbidden');
      if (info.isDirectory()) await visit(fullPath);
    }
  };
  await visit(root);
}

export async function canonicalizePhaseRoot(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) throw new Error('external_normal_v2_phase_root_invalid');
  if (typeof process.getuid !== 'function' || process.getuid() === 0) throw new Error('external_normal_v2_host_runner_must_be_nonroot');
  const requested = path.resolve(rootPath);
  let canonicalPath;
  if (requested === '/tmp' || requested.startsWith('/tmp/')) {
    const tmpAlias = await realpath('/tmp');
    if (tmpAlias !== '/private/tmp') throw new Error('external_normal_v2_tmp_alias_unexpected');
    const relative = requested === '/tmp' ? '' : requested.slice('/tmp/'.length);
    canonicalPath = path.resolve(tmpAlias, relative);
    if (canonicalPath !== tmpAlias && !canonicalPath.startsWith(`${tmpAlias}${path.sep}`)) {
      throw new Error('external_normal_v2_phase_root_escape');
    }
    let cursor = tmpAlias;
    for (const component of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('external_normal_v2_phase_root_symlink_forbidden');
    }
  } else {
    canonicalPath = path.resolve(await realpath(requested));
    const requestedInfo = await lstat(requested);
    if (requestedInfo.isSymbolicLink()) throw new Error('external_normal_v2_phase_root_symlink_forbidden');
    const info = await lstat(canonicalPath);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('external_normal_v2_phase_root_invalid');
  }
  const info = await lstat(canonicalPath);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) {
    throw new Error('external_normal_v2_phase_root_invalid_or_not_private');
  }
  await assertNoSymlinkDescendants(canonicalPath);
  return canonicalPath;
}

export async function verifyExternalNormalV2ArtifactReferences(storeRoot, references, expectedReceiptSha256) {
  const requestedRoot = path.resolve(storeRoot);
  const root = await realpath(requestedRoot);
  const rootInfo = await lstat(requestedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || (rootInfo.mode & 0o077) !== 0) {
    throw new Error('external_normal_v2_artifact_store_root_invalid');
  }
  if (!Array.isArray(references) || references.length === 0) throw new Error('external_normal_v2_artifact_references_missing');
  const receiptReferences = references.filter((reference) => reference?.path?.endsWith('/receipt.json'));
  if (receiptReferences.length !== 1) throw new Error('external_normal_v2_receipt_artifact_missing_or_ambiguous');
  const verified = [];
  for (const reference of references) {
    const relativePath = reference?.path;
    if (typeof relativePath !== 'string' || !relativePath.startsWith('normal-engine-qualification-store/')
      || path.isAbsolute(relativePath) || relativePath.split('/').some((component) => component === '.' || component === '..')
      || !/^[a-f0-9]{64}$/u.test(reference.sha256 || '')) {
      throw new Error('external_normal_v2_artifact_reference_invalid');
    }
    const absolutePath = path.resolve(root, relativePath);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error('external_normal_v2_artifact_path_escape');
    let cursor = root;
    for (const component of path.relative(root, absolutePath).split(path.sep)) {
      cursor = path.join(cursor, component);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error('external_normal_v2_artifact_symlink_forbidden');
      if (cursor !== absolutePath && (!info.isDirectory() || (info.mode & 0o077) !== 0)) {
        throw new Error('external_normal_v2_artifact_parent_invalid_or_not_private');
      }
      if (cursor === absolutePath && (!info.isFile() || (info.mode & 0o077) !== 0)) {
        throw new Error('external_normal_v2_artifact_file_invalid_or_not_private');
      }
    }
    const bytes = await readFile(absolutePath);
    const rawSha256 = sha256(bytes);
    const isReceipt = relativePath.endsWith('/receipt.json');
    if (!isReceipt && rawSha256 !== reference.sha256) throw new Error('external_normal_v2_artifact_digest_mismatch');
    const checksumPath = absolutePath.replace(/\.json$/u, '.sha256');
    const checksumInfo = await lstat(checksumPath);
    if (checksumInfo.isSymbolicLink() || !checksumInfo.isFile() || (checksumInfo.mode & 0o077) !== 0
      || (await readFile(checksumPath, 'utf8')).trim() !== rawSha256) {
      throw new Error('external_normal_v2_artifact_checksum_invalid');
    }
    let canonicalSha256 = null;
    if (isReceipt) {
      if (!/^[a-f0-9]{64}$/u.test(reference.canonicalSha256 || '')) {
        throw new Error('external_normal_v2_receipt_canonical_digest_missing');
      }
      try { canonicalSha256 = sha256(canonicalJson(JSON.parse(bytes.toString('utf8')))); }
      catch { throw new Error('external_normal_v2_receipt_json_invalid'); }
      if (canonicalSha256 !== reference.canonicalSha256 || canonicalSha256 !== expectedReceiptSha256) {
        throw new Error('external_normal_v2_receipt_canonical_digest_mismatch');
      }
    }
    verified.push({ path: relativePath, sha256: rawSha256, canonicalSha256 });
  }
  return { rootSha256: sha256(root), verifiedCount: verified.length, references: verified };
}

export async function consumeOneShotGrant(root, grant) {
  const binding = grant.binding;
  const markerName = `.root-go-${sha256(`${binding.phaseId}:${binding.phasePlanSha256}`).slice(0, 32)}.used`;
  const markerPath = path.join(root, markerName);
  const entries = await readdir(root);
  if (entries.includes(markerName)) return false;
  if (entries.length !== 0) throw new Error('external_normal_v2_phase_root_not_empty');
  try {
    const handle = await open(markerPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(`${grant.grantId}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

async function persistPhaseSummary(root, summary) {
  const outputPath = path.join(root, 'phase-result.json');
  const body = `${JSON.stringify(summary, null, 2)}\n`;
  const handle = await open(outputPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { await handle.writeFile(body, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await open(root, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return { path: 'phase-result.json', sha256: sha256(body) };
}

export function projectExternalNormalV2Case(step, input, plan, runId, historyRunId) {
  const projection = {
    stepId: step.stepId,
    caseId: step.caseId,
    inputPath: input.path,
    inputSha256: input.sha256,
    arm: step.arm,
    historyMode: step.historyMode,
    targetRepositoryId: input.repositoryId,
    sourceBundleSha256: plan.sourceBundle.sha256,
    runId,
    ...(historyRunId ? { historyRunId } : {}),
    runtime: {
      sourceRevision: plan.runtime.finalSourceRevision,
      workerImageDigest: plan.runtime.workerImageDigest,
      runtimeManifestSha256: plan.runtime.runtimeManifestSha256,
    },
    policy: {
      candidateHead: plan.policy.candidateHead,
      candidateRawSha256: plan.policy.candidateRawSha256,
      effectiveConfigSha256: plan.policy.effectiveConfigSha256,
      effectivePolicySha256: plan.policy.effectivePolicySha256,
      centralEffectiveConfigProjectionSha256: plan.policy.centralEffectiveConfigProjectionSha256,
      preparedExecutionSha256: plan.targetProjections.find((entry) => entry.repositoryId === input.repositoryId)?.preparedExecutionSha256,
      preparedExecutionFile: plan.targetProjections.find((entry) => entry.repositoryId === input.repositoryId)?.preparedExecutionFile,
      policySource: plan.policy.policySource,
      routeAlias: plan.policy.routeAlias,
      requestedEffort: plan.policy.requestedEffort,
      inferenceBaseUrl: plan.policy.inferenceBaseUrl,
    },
  };
  return Object.freeze(projection);
}

function runIdFor(plan, step) {
  return `nq_${sha256(`${plan.phaseId}:${step.stepId}:${step.inputSha256}`).slice(0, 32)}`;
}

function qualificationPhaseForArm(arm) {
  if (arm === 'repair-introduction') return 'repair-introduction';
  if (['repair-head-history', 'repair-head-empty-history', 'repair-head-history-unavailable'].includes(arm)) return 'repair-head';
  return 'single';
}

/**
 * The worker snapshots all attestor IDs after its model work and commits this mode-0600 file
 * atomically before persisting the final case receipt. A valid file is therefore the complete
 * attestor candidate set for that child; it can still include a final pre-fetch blocked attempt,
 * so only exact Bifrost rows count as confirmed sends and the remaining per-arm allocation stays
 * unknown. Raw UUIDs never leave this function.
 */
export async function recoverExternalNormalV2PrivateIdentifierSidecar(rootPath, runId, phase, caseId, allocation) {
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(runId) || !['single', 'repair-introduction', 'repair-head'].includes(phase)
    || !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(caseId) || !Number.isSafeInteger(allocation) || allocation < 1) {
    throw new Error('external_normal_v2_recovery_identity_invalid');
  }
  const requestedRoot = path.resolve(rootPath);
  const root = await realpath(requestedRoot);
  const rootInfo = await lstat(requestedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || rootInfo.uid !== process.getuid()
    || (rootInfo.mode & 0o077) !== 0) throw new Error('external_normal_v2_recovery_root_invalid');
  const relativePath = `normal-engine-qualification-store/${runId}/${phase}/${caseId}`
    + '/provider-identifiers.record/provider-identifiers.json';
  const absolutePath = path.resolve(root, relativePath);
  if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error('external_normal_v2_recovery_path_escape');
  let cursor = root;
  for (const component of path.relative(root, absolutePath).split(path.sep)) {
    cursor = path.join(cursor, component);
    let stat;
    try { stat = await lstat(cursor); }
    catch (error) { if (error?.code === 'ENOENT') return { status: 'absent', candidateCount: 0, calls: [] };
      throw new Error('external_normal_v2_recovery_sidecar_unavailable'); }
    if (stat.isSymbolicLink() || stat.uid !== rootInfo.uid || (cursor !== absolutePath && !stat.isDirectory())
      || (cursor === absolutePath && !stat.isFile()) || (stat.mode & 0o077) !== 0) {
      throw new Error('external_normal_v2_recovery_sidecar_invalid');
    }
  }
  const sidecarBytes = await readFile(absolutePath);
  if (sidecarBytes.byteLength > 1_048_576) throw new Error('external_normal_v2_recovery_sidecar_too_large');
  const sidecarSha256 = sha256(sidecarBytes);
  const checksumPath = path.join(path.dirname(absolutePath), 'provider-identifiers.sha256');
  let checksumStat;
  try { checksumStat = await lstat(checksumPath); }
  catch { throw new Error('external_normal_v2_recovery_checksum_unavailable'); }
  if (checksumStat.isSymbolicLink() || !checksumStat.isFile() || checksumStat.uid !== rootInfo.uid
    || (checksumStat.mode & 0o077) !== 0) {
    throw new Error('external_normal_v2_recovery_checksum_invalid');
  }
  const checksum = (await readFile(checksumPath, 'utf8')).trim();
  if (checksum !== sidecarSha256) throw new Error('external_normal_v2_recovery_digest_mismatch');
  let rows;
  try { rows = JSON.parse(sidecarBytes.toString('utf8')); }
  catch { throw new Error('external_normal_v2_recovery_json_invalid'); }
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 10_000) {
    throw new Error('external_normal_v2_recovery_rows_invalid');
  }
  const seen = new Set();
  for (const row of rows) {
    if (!row || Object.keys(row).sort().join('|') !== ['bifrostLogRequestId', 'callerRequestId', 'upstreamResponseRequestId'].sort().join('|')
      || !PRIVATE_PROVIDER_REQUEST_ID.test(row.callerRequestId || '')
      || row.callerRequestId !== row.bifrostLogRequestId
      || (row.upstreamResponseRequestId !== null && !PRIVATE_PROVIDER_REQUEST_ID.test(row.upstreamResponseRequestId || ''))
      || seen.has(row.callerRequestId)) throw new Error('external_normal_v2_recovery_identifier_row_invalid');
    seen.add(row.callerRequestId);
  }
  const candidateRows = rows.slice(0, allocation);
  const calls = candidateRows.map((row) => ({
    clientRequestIdSha256: sha256(row.callerRequestId.toLowerCase()),
    bifrostLogRequestIdSha256: sha256(row.bifrostLogRequestId.toLowerCase()),
    upstreamResponseRequestIdSha256: row.upstreamResponseRequestId ? sha256(row.upstreamResponseRequestId.toLowerCase()) : null,
    requestedAlias: null, requestedEffort: null, startedAt: null, requestDigest: null,
    workerTokenUsage: null, workerEstimatedUsd: null, httpStatus: null, fetchFailureClass: null,
  }));
  return { status: 'recovered', sidecarSha256, sidecarReference: { path: relativePath, sha256: sidecarSha256 },
    candidateCount: calls.length, blockedAttestorTailCount: Math.max(0, rows.length - calls.length), calls };
}

function privateIdentifierSidecarMatchesProviderCalls(recovered, providerCalls, knownClientCalls) {
  if (recovered?.status !== 'recovered' || !Number.isSafeInteger(knownClientCalls) || knownClientCalls < 1
    || recovered.candidateCount !== knownClientCalls || recovered.calls.length !== knownClientCalls
    || !Array.isArray(providerCalls) || providerCalls.length !== knownClientCalls) return false;
  const callsByCid = new Map(recovered.calls.map((call) => [call.clientRequestIdSha256, call]));
  if (callsByCid.size !== recovered.calls.length) return false;
  return providerCalls.every((call) => {
    const privateCall = callsByCid.get(call.clientRequestIdSha256);
    return Boolean(privateCall && privateCall.bifrostLogRequestIdSha256 === call.bifrostLogRequestIdSha256
      && (privateCall.upstreamResponseRequestIdSha256 ?? null) === (call.upstreamResponseRequestIdSha256 ?? null));
  });
}

function validateExecutionReceipt(result, calls) {
  object(result, 'execution_receipt');
  if (!Number.isSafeInteger(result.blockedClientCalls) || result.blockedClientCalls < 0) {
    throw new Error('external_normal_v2_blocked_attempt_ledger_invalid');
  }
  if (!Number.isSafeInteger(result.clientCalls) || result.clientCalls < 0 || result.clientCalls !== calls
    || !['completed', 'incomplete', 'failed', 'preflight_incomplete'].includes(result.terminalStatus)
    || typeof result.receiptSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(result.receiptSha256)) {
    throw new Error('external_normal_v2_execution_receipt_invalid');
  }
  const providerCalls = result.providerCalls;
  if (!Array.isArray(providerCalls) || providerCalls.length > calls
    || (providerCalls.length !== calls && result.terminalStatus !== 'failed') || providerCalls.some((row) => !row
    || !/^[a-f0-9]{64}$/u.test(row.clientRequestIdSha256 || '')
    || !/^[a-f0-9]{64}$/u.test(row.bifrostLogRequestIdSha256 || '')
    || typeof row.requestedAlias !== 'string' || typeof row.requestedEffort !== 'string'
    || typeof row.startedAt !== 'string' || !/^[a-f0-9]{64}$/u.test(row.requestDigest || ''))) {
    throw new Error('external_normal_v2_provider_request_ledger_invalid');
  }
  if (new Set(providerCalls.map((row) => row.clientRequestIdSha256)).size !== providerCalls.length
    || new Set(providerCalls.map((row) => row.bifrostLogRequestIdSha256)).size !== providerCalls.length) {
    throw new Error('external_normal_v2_provider_request_ledger_duplicate');
  }
  const artifactReferences = result.artifactReferences;
  const partialFailure = result.terminalStatus === 'failed' && result.failureCode === 'worker_execution_failed';
  if (!Array.isArray(artifactReferences) || (!partialFailure && artifactReferences.length === 0)
    || (partialFailure && artifactReferences.length !== 0)
    || artifactReferences.some((row) => !row || typeof row.path !== 'string'
      || !/^[a-f0-9]{64}$/u.test(row.sha256 || '')
      || (row.canonicalSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(row.canonicalSha256)))) {
    throw new Error('external_normal_v2_artifact_reference_invalid');
  }
  if (!partialFailure && artifactReferences.filter((row) => row.path.endsWith('/receipt.json')).length !== 1) {
    throw new Error('external_normal_v2_receipt_artifact_missing_or_ambiguous');
  }
  const outcome = result.outcome && typeof result.outcome === 'object' ? {
    workerOutcomeClass: result.outcome.workerOutcomeClass,
    gateOutcomeClass: result.outcome.gateOutcomeClass,
    agreement: result.outcome.agreement,
    canonicalEvidenceSha256: result.outcome.canonicalEvidenceSha256 ?? null,
    gateDecisionSha256: result.outcome.gateDecisionSha256 ?? null,
  } : null;
  const history = result.history && typeof result.history === 'object' ? {
    source: result.history.source,
    loadStatus: result.history.loadStatus,
    snapshotIdSha256: result.history.snapshotIdSha256 ?? null,
    contextDigest: result.history.contextDigest ?? null,
    parentRunIdSha256: result.history.parentRunIdSha256 ?? null,
  } : null;
  const preflight = result.preflight && typeof result.preflight === 'object' ? {
    control: result.preflight.control,
    sourceCoverage: result.preflight.sourceCoverage,
    withheldPath: result.preflight.withheldPath,
    historyStatus: result.preflight.historyStatus,
    historyFailureClass: result.preflight.historyFailureClass,
    historySourceRunIdSha256: result.preflight.historySourceRunIdSha256,
    physicalClientCalls: result.preflight.physicalClientCalls,
  } : null;
  const exhaustion = result.testBudget?.resourceExhaustion && typeof result.testBudget.resourceExhaustion === 'object'
    ? {
      status: result.testBudget.resourceExhaustion.status,
      physicalRequestCap: result.testBudget.resourceExhaustion.physicalRequestCap,
      logicalCompletionAttempts: result.testBudget.resourceExhaustion.logicalCompletionAttempts,
      physicalRequests: result.testBudget.resourceExhaustion.physicalRequests,
      blockedPhysicalRequestAttempts: result.testBudget.resourceExhaustion.blockedPhysicalRequestAttempts,
      firstResponseHttpStatus: result.testBudget.resourceExhaustion.firstResponseHttpStatus,
      firstLogicalCompletionSucceeded: result.testBudget.resourceExhaustion.firstLogicalCompletionSucceeded,
    } : null;
  const workerFailure = partialFailure ? safeExternalNormalV2WorkerFailure(result) : undefined;
  const canonicalEvidence = result.canonicalReviewEvidence && typeof result.canonicalReviewEvidence === 'object' ? {
    decisionClassification: result.canonicalReviewEvidence.decisionClassification,
    counts: result.canonicalReviewEvidence.counts && typeof result.canonicalReviewEvidence.counts === 'object'
      ? { p0Count: result.canonicalReviewEvidence.counts.p0Count, p1Count: result.canonicalReviewEvidence.counts.p1Count,
        p2Count: result.canonicalReviewEvidence.counts.p2Count, p3Count: result.canonicalReviewEvidence.counts.p3Count,
        nitCount: result.canonicalReviewEvidence.counts.nitCount } : null,
    coverageComplete: result.canonicalReviewEvidence.coverageComplete,
    quorumSatisfied: result.canonicalReviewEvidence.quorumSatisfied,
    blockingFindings: Array.isArray(result.canonicalReviewEvidence.blockingFindings)
      ? result.canonicalReviewEvidence.blockingFindings.map((finding) => ({
        fingerprintSha256: finding.fingerprintSha256, severity: finding.severity, path: finding.path,
        ...(finding.line !== undefined ? { line: finding.line } : {}),
        ...(finding.title !== undefined ? { title: finding.title } : {}),
        ...(finding.claim !== undefined ? { claim: finding.claim } : {}),
        ...(finding.blockerEvidence ? { blockerEvidence: finding.blockerEvidence } : {}),
        verificationStatus: finding.verificationStatus, causalScope: finding.causalScope,
        sourceReviewIdentitySha256: finding.sourceReviewIdentitySha256 ?? null,
        ...(finding.reviewIdentity !== undefined ? { reviewIdentity: finding.reviewIdentity } : {}),
        scopeEvidenceSha256: finding.scopeEvidenceSha256 ?? null,
        blockerEvidenceSha256: finding.blockerEvidenceSha256 ?? null,
        ...(finding.citationEvidence !== undefined ? { citationEvidence: finding.citationEvidence } : {}),
      })) : null,
  } : null;
  return { clientCalls: result.clientCalls, terminalStatus: result.terminalStatus, receiptSha256: result.receiptSha256,
    blockedClientCalls: result.blockedClientCalls,
    attestorRecordedCalls: Number.isSafeInteger(result.attestorRecordedCalls) && result.attestorRecordedCalls >= 0
      ? result.attestorRecordedCalls : providerCalls.length,
    failureCode: partialFailure ? result.failureCode : null,
    ...(workerFailure ? { workerFailure } : {}),
    unidentifiedClientAttempts: calls - providerCalls.length,
    artifactReferences: artifactReferences.map((row) => ({ path: row.path, sha256: row.sha256,
      ...(row.canonicalSha256 ? { canonicalSha256: row.canonicalSha256 } : {}) })),
    outcome, canonicalReviewEvidence: canonicalEvidence, history,
    qualificationControl: typeof result.qualificationControl === 'string' ? result.qualificationControl : null,
    preflight, resourceExhaustion: exhaustion,
    providerCalls: providerCalls.map((row) => ({ clientRequestIdSha256: row.clientRequestIdSha256,
      bifrostLogRequestIdSha256: row.bifrostLogRequestIdSha256, requestedAlias: row.requestedAlias,
      requestedEffort: row.requestedEffort, startedAt: row.startedAt, requestDigest: row.requestDigest,
      upstreamResponseRequestIdSha256: row.upstreamResponseRequestIdSha256 ?? null,
      httpStatus: Number.isSafeInteger(row.httpStatus) ? row.httpStatus : null,
      fetchFailureClass: typeof row.fetchFailureClass === 'string' ? row.fetchFailureClass : null,
      workerTokenUsage: row.workerTokenUsage || null, workerEstimatedUsd: row.workerEstimatedUsd ?? null })) };
}

function validOptionalDigest(value) { return value === null || /^[a-f0-9]{64}$/u.test(value || ''); }

function validPrivateCitationEvidence(value) {
  if (value === undefined || value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !/^[a-f0-9]{64}$/u.test(value.sourceWindowManifestDigest || '')
    || !Array.isArray(value.usedCitationIds) || value.usedCitationIds.length > 64
    || !Array.isArray(value.citations) || value.citations.length > 64) return false;
  const citationIds = new Set();
  for (const citation of value.citations) {
    if (!citation || typeof citation !== 'object' || Array.isArray(citation)
      || typeof citation.id !== 'string' || !citation.id || citationIds.has(citation.id)
      || typeof citation.path !== 'string' || !citation.path || typeof citation.repository !== 'string'
      || !['head', 'base', 'diff'].includes(citation.side)
      || !/^[a-f0-9]{40}$/u.test(citation.revisionSha || '') || !/^[a-f0-9]{40}$/u.test(citation.headSha || '')
      || !/^[a-f0-9]{40}$/u.test(citation.baseSha || '') || !/^[a-f0-9]{64}$/u.test(citation.sourceDigest || '')) return false;
    citationIds.add(citation.id);
    const window = citation.window;
    if (window !== null && window !== undefined && (!window || typeof window !== 'object' || Array.isArray(window)
      || !/^[a-f0-9]{64}$/u.test(window.id || '') || typeof window.role !== 'string'
      || !Number.isSafeInteger(window.startLine) || window.startLine < 0
      || !Number.isSafeInteger(window.endLine) || window.endLine < window.startLine
      || !/^[a-f0-9]{64}$/u.test(window.windowSha256 || '')
      || !/^[a-f0-9]{64}$/u.test(window.fullContentSha256 || '')
      || !/^[a-f0-9]{64}$/u.test(window.regionDigest || ''))) return false;
  }
  return value.usedCitationIds.every((id) => typeof id === 'string' && citationIds.has(id));
}

export function validateCapturedRouteIdentity(calls, rows, expectedAlias, expectedRoute) {
  const expectedRouteKeys = ['schemaVersion', 'routingRuleId', 'routingRuleName', 'provider', 'model',
    'sourceConfigurationSha256'];
  if (!Array.isArray(calls) || !Array.isArray(rows) || !SAFE_ROUTE_IDENTIFIER.test(expectedAlias || '')
    || !hasExactKeys(expectedRoute, expectedRouteKeys)
    || expectedRoute.schemaVersion !== EXTERNAL_NORMAL_V2_ROUTE_IDENTITY_SCHEMA
    || !PRIVATE_PROVIDER_REQUEST_ID.test(expectedRoute.routingRuleId || '')
    || !SAFE_ROUTE_IDENTIFIER.test(expectedRoute.routingRuleName || '')
    || !SAFE_ROUTE_IDENTIFIER.test(expectedRoute.provider || '')
    || !SAFE_ROUTE_IDENTIFIER.test(expectedRoute.model || '')
    || !/^[a-f0-9]{64}$/u.test(expectedRoute.sourceConfigurationSha256 || '')) {
    throw new Error('external_normal_v2_route_identity_inputs_invalid');
  }
  const expectedRuleIdSha256 = sha256(expectedRoute.routingRuleId.toLowerCase());
  const expectedRuleNameSha256 = sha256(expectedRoute.routingRuleName);
  const rowsByCid = new Map();
  for (const row of rows) {
    if (!row || !/^[a-f0-9]{64}$/u.test(row.clientRequestIdSha256 || '')
      || rowsByCid.has(row.clientRequestIdSha256)) throw new Error('external_normal_v2_route_identity_not_proven');
    rowsByCid.set(row.clientRequestIdSha256, row);
  }
  const callIds = new Set(calls.map((call) => call?.clientRequestIdSha256));
  if (callIds.size !== calls.length || callIds.size !== rowsByCid.size
    || [...callIds].some((id) => !/^[a-f0-9]{64}$/u.test(id || '') || !rowsByCid.has(id))) {
    throw new Error('external_normal_v2_route_identity_not_proven');
  }
  const successfulCalls = calls.filter((call) => call?.httpStatus === 200);
  if (successfulCalls.length === 0) throw new Error('external_normal_v2_route_identity_successful_call_missing');
  const observed = [];
  for (const call of successfulCalls) {
    const row = rowsByCid.get(call.clientRequestIdSha256);
    const parentStateValid = ['absent', 'null', 'valid', 'invalid'].includes(row?.parentRequestIdState);
    const retriesStateValid = ['absent', 'null', 'number', 'invalid'].includes(row?.numberOfRetriesState)
      && (row.numberOfRetriesState === 'number'
        ? Number.isSafeInteger(row.numberOfRetries) && row.numberOfRetries >= 0 : row.numberOfRetries === null);
    const serverFallbackStateValid = ['absent', 'null', 'string', 'invalid'].includes(row?.serverSideFallbackModelState)
      && (['absent', 'null'].includes(row.serverSideFallbackModelState)
        ? row.serverSideFallbackModelSha256 === null
        : /^[a-f0-9]{64}$/u.test(row.serverSideFallbackModelSha256 || ''));
    if (!row || call.requestedAlias !== expectedAlias || row.bifrostLogStatus !== 'success'
      || row.provider !== expectedRoute.provider || row.resolvedModel !== expectedRoute.model
      || row.routingRuleIdState !== 'valid' || row.routingRuleIdSha256 !== expectedRuleIdSha256
      || row.routingRuleNameState !== 'valid' || row.routingRuleNameSha256 !== expectedRuleNameSha256
      || row.fallbackIndexState !== 'number' || row.fallbackIndex !== 0
      || !parentStateValid || !retriesStateValid || !serverFallbackStateValid
      || !['absent', 'null'].includes(row.serverSideFallbackModelState)) {
      throw new Error('external_normal_v2_route_identity_not_proven');
    }
    observed.push({ clientRequestIdSha256: call.clientRequestIdSha256, requestedAlias: expectedAlias,
      routingRuleIdSha256: row.routingRuleIdSha256, routingRuleNameSha256: row.routingRuleNameSha256,
      provider: row.provider, resolvedModel: row.resolvedModel,
      fallbackIndex: row.fallbackIndex, parentRequestIdState: row.parentRequestIdState,
      parentRequestIdValueSha256: row.parentRequestIdValueSha256 ?? null,
      numberOfRetriesState: row.numberOfRetriesState, numberOfRetries: row.numberOfRetries,
      serverSideFallbackModelState: row.serverSideFallbackModelState,
      serverSideFallbackModelSha256: row.serverSideFallbackModelSha256 ?? null });
  }
  return { status: 'observed', successfulCallCount: observed.length,
    routeExpectationSha256: sha256(canonicalJson(expectedRoute)),
    identitySetSha256: sha256(canonicalJson(observed)) };
}

function validCompletedNormalReviewEvidence(result) {
  const outcome = result?.outcome;
  const canonical = result?.canonicalReviewEvidence;
  const counts = canonical?.counts;
  if (!outcome || !['completed_eligible', 'completed_ineligible'].includes(outcome.workerOutcomeClass)
    || !['completed_eligible', 'completed_ineligible'].includes(outcome.gateOutcomeClass)
    || outcome.agreement !== 'agreement'
    || !/^[a-f0-9]{64}$/u.test(outcome.canonicalEvidenceSha256 || '')
    || !/^[a-f0-9]{64}$/u.test(outcome.gateDecisionSha256 || '')
    || !canonical || !['SHIP', 'FIX_FIRST', 'INCOMPLETE_REVIEW'].includes(canonical.decisionClassification)
    || !counts || ['p0Count', 'p1Count', 'p2Count', 'p3Count', 'nitCount'].some((key) =>
      !Number.isSafeInteger(counts[key]) || counts[key] < 0)
    || typeof canonical.coverageComplete !== 'boolean' || typeof canonical.quorumSatisfied !== 'boolean'
    || !Array.isArray(canonical.blockingFindings) || canonical.blockingFindings.some((finding) => !finding
      || !/^[a-f0-9]{64}$/u.test(finding.fingerprintSha256 || '') || !['P0', 'P1'].includes(finding.severity)
      || typeof finding.path !== 'string' || !['confirmed', 'contradicted', 'insufficient', 'unavailable'].includes(finding.verificationStatus)
      || !['introduced', 'exacerbated', 'preexisting', 'unproven'].includes(finding.causalScope)
      || (finding.line !== undefined && (!Number.isSafeInteger(finding.line) || finding.line < 1))
      || (finding.title !== undefined && (typeof finding.title !== 'string' || finding.title.length === 0 || finding.title.length > 4_000))
      || (finding.claim !== undefined && (typeof finding.claim !== 'string' || finding.claim.length === 0 || finding.claim.length > 16_000))
      || (finding.blockerEvidence !== undefined && (!finding.blockerEvidence || typeof finding.blockerEvidence !== 'object'
        || typeof finding.blockerEvidence.trigger !== 'string' || typeof finding.blockerEvidence.impact !== 'string'
        || typeof finding.blockerEvidence.violatedContract !== 'string'))
      || (finding.reviewIdentity !== undefined && finding.reviewIdentity !== null
        && (!finding.reviewIdentity || typeof finding.reviewIdentity.repository !== 'string'
          || !/^[a-f0-9]{40}$/u.test(finding.reviewIdentity.baseSha || '')
          || !/^[a-f0-9]{40}$/u.test(finding.reviewIdentity.headSha || '')))
      || !validPrivateCitationEvidence(finding.citationEvidence)
      || !validOptionalDigest(finding.sourceReviewIdentitySha256) || !validOptionalDigest(finding.scopeEvidenceSha256)
      || !validOptionalDigest(finding.blockerEvidenceSha256))) return false;
  return result.terminalStatus === 'completed' && result.qualificationControl === 'none'
    && outcome.workerOutcomeClass !== 'incomplete' && outcome.gateOutcomeClass !== 'incomplete'
    && canonical.coverageComplete && canonical.quorumSatisfied;
}

/** Assesses only actual production receipt facts; planned labels never enter this projection. */
export function assessExternalNormalV2StepReceipt(step, result, expectedHistoryRunId = null, expectedReviewIdentity = null) {
  const incomplete = (reason) => ({ status: 'incomplete', reason });
  const failed = (reason) => ({ status: 'failed', reason });
  const outcome = result?.outcome;
  if (!outcome || !['completed_eligible', 'completed_ineligible', 'incomplete'].includes(outcome.workerOutcomeClass)
    || !['completed_eligible', 'completed_ineligible', 'incomplete'].includes(outcome.gateOutcomeClass)
    || !['agreement', 'disagreement', 'incomplete'].includes(outcome.agreement)
    || !validOptionalDigest(outcome.canonicalEvidenceSha256) || !validOptionalDigest(outcome.gateDecisionSha256)) {
    return incomplete('production_outcome_evidence_missing_or_invalid');
  }
  if (NORMAL_STEP_IDS.has(step?.stepId)) {
    if (!Number.isSafeInteger(result.clientCalls) || result.clientCalls < 1
      || !Array.isArray(result.providerCalls) || result.providerCalls.length < 1) {
      return failed('normal_review_provider_dispatch_not_observed');
    }
    const canonical = result.canonicalReviewEvidence;
    const counts = canonical?.counts;
    if (!canonical || !['SHIP', 'FIX_FIRST', 'INCOMPLETE_REVIEW'].includes(canonical.decisionClassification)
      || !counts || ['p0Count', 'p1Count', 'p2Count', 'p3Count', 'nitCount'].some((key) =>
        !Number.isSafeInteger(counts[key]) || counts[key] < 0)
      || typeof canonical.coverageComplete !== 'boolean' || typeof canonical.quorumSatisfied !== 'boolean'
      || !Array.isArray(canonical.blockingFindings) || canonical.blockingFindings.some((finding) => !finding
        || !/^[a-f0-9]{64}$/u.test(finding.fingerprintSha256 || '') || !['P0', 'P1'].includes(finding.severity)
        || typeof finding.path !== 'string' || !['confirmed', 'contradicted', 'insufficient', 'unavailable'].includes(finding.verificationStatus)
        || !['introduced', 'exacerbated', 'preexisting', 'unproven'].includes(finding.causalScope)
        || (finding.line !== undefined && (!Number.isSafeInteger(finding.line) || finding.line < 1))
        || (finding.title !== undefined && (typeof finding.title !== 'string' || finding.title.length === 0 || finding.title.length > 4_000))
        || (finding.claim !== undefined && (typeof finding.claim !== 'string' || finding.claim.length === 0 || finding.claim.length > 16_000))
        || (finding.blockerEvidence !== undefined && (!finding.blockerEvidence || typeof finding.blockerEvidence !== 'object'
          || typeof finding.blockerEvidence.trigger !== 'string' || typeof finding.blockerEvidence.impact !== 'string'
          || typeof finding.blockerEvidence.violatedContract !== 'string'))
        || (finding.reviewIdentity !== undefined && finding.reviewIdentity !== null
          && (!finding.reviewIdentity || typeof finding.reviewIdentity.repository !== 'string'
            || !/^[a-f0-9]{40}$/u.test(finding.reviewIdentity.baseSha || '')
            || !/^[a-f0-9]{40}$/u.test(finding.reviewIdentity.headSha || '')))
        || !validPrivateCitationEvidence(finding.citationEvidence)
        || !validOptionalDigest(finding.sourceReviewIdentitySha256) || !validOptionalDigest(finding.scopeEvidenceSha256)
        || !validOptionalDigest(finding.blockerEvidenceSha256))) {
      return incomplete('canonical_gate_evidence_projection_missing_or_invalid');
    }
    if (result.terminalStatus !== 'completed' || outcome.agreement !== 'agreement'
      || outcome.workerOutcomeClass === 'incomplete' || outcome.gateOutcomeClass === 'incomplete'
      || !outcome.canonicalEvidenceSha256 || !outcome.gateDecisionSha256 || result.qualificationControl !== 'none') {
      return incomplete('normal_gate_did_not_complete_with_canonical_evidence');
    }
    if (step.stepId === 'v2-p2-first' || step.stepId === 'v2-p2-repeat') {
      if (outcome.workerOutcomeClass !== 'completed_eligible' || outcome.gateOutcomeClass !== 'completed_eligible') {
        return failed('p2_clean_review_not_gate_eligible');
      }
      if (canonical.decisionClassification !== 'SHIP' || counts.p0Count !== 0 || counts.p1Count !== 0
        || !canonical.coverageComplete || !canonical.quorumSatisfied) return failed('p2_canonical_gate_evidence_not_ship');
    }
    if (step.stepId === 'v2-sequence-a') {
      const expectedIdentitySha256 = expectedReviewIdentity ? sha256(canonicalJson(expectedReviewIdentity)) : null;
      const introducedP1 = canonical.blockingFindings.some((finding) => finding.severity === 'P1'
        && finding.path === 'audience-policy.ts' && finding.verificationStatus === 'confirmed'
        && (finding.causalScope === 'introduced' || finding.causalScope === 'exacerbated')
        && finding.sourceReviewIdentitySha256 === expectedIdentitySha256 && finding.scopeEvidenceSha256 !== null
        && finding.blockerEvidenceSha256 !== null && Number.isSafeInteger(finding.line) && finding.line > 0
        && typeof finding.title === 'string' && finding.title.length > 0
        && typeof finding.claim === 'string' && finding.claim.length > 0
        && finding.blockerEvidence && typeof finding.blockerEvidence.trigger === 'string'
        && typeof finding.blockerEvidence.impact === 'string' && typeof finding.blockerEvidence.violatedContract === 'string'
        && finding.reviewIdentity?.repository === expectedReviewIdentity?.repository
        && finding.reviewIdentity?.baseSha === expectedReviewIdentity?.baseSha
        && finding.reviewIdentity?.headSha === expectedReviewIdentity?.headSha
        && /^[a-f0-9]{64}$/u.test(finding.citationEvidence?.sourceWindowManifestDigest || '')
        && Array.isArray(finding.citationEvidence?.usedCitationIds)
        && Array.isArray(finding.citationEvidence?.citations)
        && finding.citationEvidence.citations.some((citation) => finding.citationEvidence.usedCitationIds.includes(citation.id)
          && citation.path === finding.path && citation.repository === expectedReviewIdentity?.repository
          && citation.side === 'head' && citation.headSha === expectedReviewIdentity?.headSha
          && citation.baseSha === expectedReviewIdentity?.baseSha
          && citation.revisionSha === expectedReviewIdentity?.headSha));
      if (outcome.workerOutcomeClass !== 'completed_ineligible' || outcome.gateOutcomeClass !== 'completed_ineligible'
        || canonical.decisionClassification !== 'FIX_FIRST' || counts.p1Count < 1 || !canonical.coverageComplete
        || !canonical.quorumSatisfied || !expectedIdentitySha256 || !introducedP1) {
        return failed('introduced_p1_source_verified_fix_first_not_proven');
      }
    }
    if ((step.stepId === 'v2-sequence-b-history' || step.stepId === 'v2-sequence-b-full-source')
      && (outcome.workerOutcomeClass !== 'completed_eligible' || outcome.gateOutcomeClass !== 'completed_eligible')) {
      return failed('repaired_sequence_b_not_gate_eligible');
    }
    if ((step.stepId === 'v2-sequence-b-history' || step.stepId === 'v2-sequence-b-full-source')
      && (canonical.decisionClassification !== 'SHIP' || counts.p0Count !== 0 || counts.p1Count !== 0
        || !canonical.coverageComplete || !canonical.quorumSatisfied)) {
      return failed('repaired_sequence_b_canonical_gate_not_ship');
    }
    if (step.stepId === 'v2-sequence-b-history') {
      const expectedParentSha = expectedHistoryRunId ? sha256(expectedHistoryRunId) : null;
      if (!expectedParentSha || !result.history || result.history.source !== 'isolated-qualification-store'
        || result.history.loadStatus !== 'complete' || result.history.parentRunIdSha256 !== expectedParentSha
        || !/^[a-f0-9]{64}$/u.test(result.history.snapshotIdSha256 || '')
        || !/^[a-f0-9]{64}$/u.test(result.history.contextDigest || '')) {
        return incomplete('loaded_history_lineage_not_proven');
      }
    }
    if (step.stepId === 'v2-sequence-b-full-source') {
      if (!result.history || result.history.source !== 'empty-qualification-ablation'
        || result.history.parentRunIdSha256 !== null) return incomplete('empty_history_ablation_not_proven');
    }
    return { status: 'accepted', reason: 'actual_worker_and_gate_receipts_complete' };
  }
  const incompleteGate = result?.terminalStatus === 'incomplete'
    && outcome.workerOutcomeClass === 'incomplete' && outcome.gateOutcomeClass === 'incomplete'
    && outcome.agreement === 'incomplete';
  if (!incompleteGate) return failed('control_did_not_fail_closed_in_worker_and_gate');
  if (step.stepId === 'v2-coverage-hole-control') {
    return result.clientCalls === 0 && result.providerCalls.length === 0
      && result.qualificationControl === 'source-coverage-unavailable'
      && result.preflight?.control === 'source-coverage-unavailable' && result.preflight.sourceCoverage === 'unavailable'
      && result.preflight.withheldPath === 'src/modules/module-01.ts' && result.preflight.physicalClientCalls === 0
      ? { status: 'expected_control', reason: 'source_coverage_unavailable_abstained_before_model_call' }
      : failed('source_coverage_control_evidence_invalid');
  }
  if (step.stepId === 'v2-required-history-unavailable-control') {
    const expectedParentSha = expectedHistoryRunId ? sha256(expectedHistoryRunId) : null;
    return result.clientCalls === 0 && result.providerCalls.length === 0 && expectedParentSha
      && result.qualificationControl === 'history-unavailable'
      && result.history?.source === 'unavailable' && result.history.loadStatus === 'unavailable'
      && result.history.parentRunIdSha256 === expectedParentSha
      && result.preflight?.control === 'required-history-unavailable-transport'
      && result.preflight.historyStatus === 'unavailable' && result.preflight.historyFailureClass === 'transport'
      && result.preflight.historySourceRunIdSha256 === expectedParentSha && result.preflight.physicalClientCalls === 0
      ? { status: 'expected_control', reason: 'required_history_transport_failure_abstained_before_planning' }
      : failed('required_history_control_evidence_invalid');
  }
  if (step.stepId === 'v2-provider-failure-control') {
    const call = result.providerCalls[0];
    return result.clientCalls === 1 && result.providerCalls.length === 1
      && result.qualificationControl === 'bifrost-auth-rejection-invalid-inference-key'
      && call?.httpStatus === 401 && call.fetchFailureClass === 'http_error'
      ? { status: 'expected_control', reason: 'configured_origin_client_http_401_without_provider_billing_claim' }
      : failed('provider_auth_failure_control_evidence_invalid');
  }
  if (step.stepId === 'v2-resource-exhaustion-control') {
    const exhaustion = result.resourceExhaustion;
    const call = result.providerCalls[0];
    return result.clientCalls === 1 && result.providerCalls.length === 1
      && result.qualificationControl === 'worker-deadline-test-60s-one-physical-request'
      && call?.httpStatus === 200 && call.fetchFailureClass === null
      && exhaustion?.status === 'observed' && exhaustion.physicalRequestCap === 1
      && exhaustion.physicalRequests === 1 && exhaustion.blockedPhysicalRequestAttempts > 0
      && exhaustion.firstResponseHttpStatus === 200 && exhaustion.firstLogicalCompletionSucceeded === true
      ? { status: 'expected_control', reason: 'second_physical_attempt_blocked_and_gate_abstained' }
      : failed('resource_exhaustion_control_evidence_invalid');
  }
  return failed('step_control_type_unknown');
}

export function validateExactLogLedger(calls, capture) {
  if (calls.length === 0) {
    if (capture?.status !== 'no_calls') throw new Error('external_normal_v2_zero_call_log_ledger_invalid');
    return { status: 'no_calls', matchedRows: 0, requestLedger: [], upstreamLedger: [], tokenLedger: [],
      actualBilledLedger: [], bifrostCalculatedCostLedger: [],
      requestLedgerSha256: sha256(canonicalJson(calls)),
      upstreamLedgerSha256: sha256(canonicalJson([])), tokenLedgerSha256: sha256(canonicalJson([])),
      actualBilledLedgerSha256: sha256(canonicalJson([])), bifrostCalculatedCostLedgerSha256: sha256(canonicalJson([])),
      billedUsd: null, bifrostCalculatedCostUsd: null, estimatedUsd: null };
  }
  if (!capture || capture.status !== 'captured' || !Array.isArray(capture.rows) || capture.rows.length !== calls.length) {
    throw new Error('external_normal_v2_exact_log_rows_missing');
  }
  const byClientId = new Map();
  for (const row of capture.rows) {
    const validIndexedMetadata = (state, value) => state === 'number'
      ? Number.isSafeInteger(value) && value >= 0
      : ['absent', 'null', 'invalid'].includes(state) && value === null;
    const validRuleIdentityMetadata = (state, value) => ['absent', 'null', 'valid', 'invalid'].includes(state)
      && validOptionalDigest(value)
      && (state === 'valid' ? typeof value === 'string' : !['absent', 'null'].includes(state) || value === null);
    const validParentMetadata = ['absent', 'null', 'valid', 'invalid'].includes(row?.parentRequestIdState)
      && validOptionalDigest(row?.parentRequestIdValueSha256 ?? null)
      && validOptionalDigest(row?.bifrostParentRequestIdSha256 ?? null)
      && (row.parentRequestIdState === 'valid'
        ? typeof row.parentRequestIdValueSha256 === 'string'
          && row.bifrostParentRequestIdSha256 === row.parentRequestIdValueSha256
        : ['absent', 'null'].includes(row.parentRequestIdState)
          ? row.parentRequestIdValueSha256 === null && row.bifrostParentRequestIdSha256 === null
          : row.bifrostParentRequestIdSha256 === null);
    const validServerFallbackMetadata = ['absent', 'null', 'string', 'invalid'].includes(row?.serverSideFallbackModelState)
      && validOptionalDigest(row?.serverSideFallbackModelSha256 ?? null)
      && (row.serverSideFallbackModelState === 'string'
        ? typeof row.serverSideFallbackModelSha256 === 'string'
        : !['absent', 'null'].includes(row.serverSideFallbackModelState) || row.serverSideFallbackModelSha256 === null);
    if (!row || !/^[a-f0-9]{64}$/u.test(row.clientRequestIdSha256 || '')
      || !/^[a-f0-9]{64}$/u.test(row.bifrostLogRequestIdSha256 || '')
      || !/^[a-f0-9]{64}$/u.test(row.bifrostLogRowIdSha256 || '')
      || !validOptionalDigest(row.upstreamResponseRequestIdSha256 ?? null)
      || !validOptionalDigest(row.bifrostParentRequestIdSha256 ?? null)
      || !validRuleIdentityMetadata(row?.routingRuleIdState, row?.routingRuleIdSha256 ?? null)
      || !validRuleIdentityMetadata(row?.routingRuleNameState, row?.routingRuleNameSha256 ?? null)
      || !validParentMetadata || !validServerFallbackMetadata
      || !validIndexedMetadata(row?.fallbackIndexState, row?.fallbackIndex)
      || !validIndexedMetadata(row?.numberOfRetriesState, row?.numberOfRetries)
      || row.exactRowCount !== 1 || !/^[a-f0-9]{64}$/u.test(row.exactLogRowSha256 || '')
      || (row.exactLogResponseSha256 !== undefined && row.exactLogResponseSha256 !== null
        && !/^[a-f0-9]{64}$/u.test(row.exactLogResponseSha256))
      || (row.bifrostLogStatus !== undefined && row.bifrostLogStatus !== null
        && !['processing', 'success', 'error'].includes(row.bifrostLogStatus))
      || byClientId.has(row.clientRequestIdSha256)) {
      throw new Error('external_normal_v2_exact_log_row_invalid_or_ambiguous');
    }
    byClientId.set(row.clientRequestIdSha256, row);
  }
  if (byClientId.size !== calls.length || calls.some((call) => {
    const row = byClientId.get(call.clientRequestIdSha256);
    return !row || row.bifrostLogRequestIdSha256 !== call.bifrostLogRequestIdSha256
      || row.bifrostLogRowIdSha256 !== call.bifrostLogRequestIdSha256
      || (row.upstreamResponseRequestIdSha256 ?? null) !== (call.upstreamResponseRequestIdSha256 ?? null);
  })) throw new Error('external_normal_v2_exact_log_cid_join_mismatch');
  const upstream = calls.map((call) => {
    const row = byClientId.get(call.clientRequestIdSha256);
    return { clientRequestIdSha256: call.clientRequestIdSha256, bifrostLogRequestIdSha256: call.bifrostLogRequestIdSha256,
      exactLogRowSha256: row.exactLogRowSha256, bifrostLogStatus: row.bifrostLogStatus ?? null,
      exactLogResponseSha256: row.exactLogResponseSha256 ?? null,
      bifrostLogRowIdSha256: row.bifrostLogRowIdSha256 ?? null,
      upstreamResponseRequestIdSha256: row.upstreamResponseRequestIdSha256 ?? null,
      bifrostParentRequestIdSha256: row.bifrostParentRequestIdSha256 ?? null, provider: row.provider ?? null,
      bifrostAlias: row.bifrostAlias ?? null,
      routingRuleIdState: row.routingRuleIdState, routingRuleIdSha256: row.routingRuleIdSha256 ?? null,
      routingRuleNameState: row.routingRuleNameState, routingRuleNameSha256: row.routingRuleNameSha256 ?? null,
      resolvedModel: row.resolvedModel ?? null, servedModel: row.servedModel ?? null,
      fallbackIndexState: row.fallbackIndexState, fallbackIndex: row.fallbackIndex,
      parentRequestIdState: row.parentRequestIdState,
      parentRequestIdValueSha256: row.parentRequestIdValueSha256 ?? null,
      numberOfRetriesState: row.numberOfRetriesState, numberOfRetries: row.numberOfRetries,
      serverSideFallbackModelState: row.serverSideFallbackModelState,
      serverSideFallbackModelSha256: row.serverSideFallbackModelSha256 ?? null,
      serviceTier: row.serviceTier ?? null, speed: row.speed ?? null, inferenceGeo: row.inferenceGeo ?? null };
  });
  const tokens = calls.map((call) => {
    const row = byClientId.get(call.clientRequestIdSha256);
    return { clientRequestIdSha256: call.clientRequestIdSha256, worker: call.workerTokenUsage,
      gateway: row.gatewayTokenUsage ?? null };
  });
  const billed = calls.map((call) => ({ clientRequestIdSha256: call.clientRequestIdSha256, billedUsd: null }));
  const calculatedCost = calls.map((call) => {
    const row = byClientId.get(call.clientRequestIdSha256);
    const value = row.bifrostCalculatedCostUsd;
    if (value !== null && value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error('external_normal_v2_bifrost_calculated_cost_invalid');
    }
    return { clientRequestIdSha256: call.clientRequestIdSha256, bifrostCalculatedCostUsd: value ?? null };
  });
  const bifrostCalculatedCostUsd = calculatedCost.every((row) => typeof row.bifrostCalculatedCostUsd === 'number')
    ? calculatedCost.reduce((sum, row) => sum + row.bifrostCalculatedCostUsd, 0) : null;
  const estimatedUsd = calls.every((row) => typeof row.workerEstimatedUsd === 'number'
    && Number.isFinite(row.workerEstimatedUsd) && row.workerEstimatedUsd >= 0)
    ? calls.reduce((sum, row) => sum + row.workerEstimatedUsd, 0) : null;
  return { status: 'captured', matchedRows: upstream.length,
    requestLedger: calls.map((call) => ({ clientRequestIdSha256: call.clientRequestIdSha256,
      bifrostLogRequestIdSha256: call.bifrostLogRequestIdSha256,
      upstreamResponseRequestIdSha256: call.upstreamResponseRequestIdSha256 ?? null,
      requestedAlias: call.requestedAlias,
      requestedEffort: call.requestedEffort, clientHttpStatus: call.httpStatus ?? null,
      startedAt: call.startedAt, requestDigest: call.requestDigest })),
    upstreamLedger: upstream,
    tokenLedger: tokens,
    actualBilledLedger: billed,
    bifrostCalculatedCostLedger: calculatedCost,
    requestLedgerSha256: sha256(canonicalJson(calls)), upstreamLedgerSha256: sha256(canonicalJson(upstream)),
    tokenLedgerSha256: sha256(canonicalJson(tokens)), actualBilledLedgerSha256: sha256(canonicalJson(billed)),
    bifrostCalculatedCostLedgerSha256: sha256(canonicalJson(calculatedCost)), billedUsd: null,
    bifrostCalculatedCostUsd, estimatedUsd };
}

function externalNormalExecutionProfile(trustedR2Execution) {
  if (!trustedR2Execution) return {
    phaseCallLimit: CLIENT_CALL_LIMIT,
    historicalPhysicalAttempts: HISTORICAL_PHYSICAL_ATTEMPTS,
    overallPhysicalAttemptCeiling: OVERALL_PHYSICAL_ATTEMPT_CEILING,
    inputForStep: (step) => INPUTS[step.caseId],
    clientCallAllocationForStep,
    workerCallAllocationForStep: clientCallAllocationForStep,
    wallReservationForStep,
    authFailureStepId: 'v2-provider-failure-control',
    historyProducerStepId: 'v2-sequence-a',
    assessStep: assessExternalNormalV2StepReceipt,
  };
  const casesById = new Map(trustedR2Execution.admitted.cases.map((entry) => [entry.caseId, entry]));
  const inputsById = trustedR2Execution.inputByCase;
  const assessmentStepIds = R2_ASSESSMENT_STEP_IDS;
  return {
    phaseCallLimit: R2_PHASE_CLIENT_CALL_LIMIT,
    historicalPhysicalAttempts: R2_HISTORICAL_PHYSICAL_ATTEMPTS,
    overallPhysicalAttemptCeiling: OVERALL_PHYSICAL_ATTEMPT_CEILING,
    inputForStep: (step) => {
      const source = casesById.get(step.caseId);
      if (!source) throw new Error('external_normal_r2_step_input_identity_invalid');
      return { path: source.inputPath, sha256: source.inputSha256, repositoryId: source.repository.repositoryId };
    },
    clientCallAllocationForStep: (step) => {
      if (!Number.isSafeInteger(step?.clientCallAllocation) || step.clientCallAllocation < 0
        || step.clientCallAllocation > 53) throw new Error('external_normal_r2_step_call_allocation_invalid');
      return step.clientCallAllocation;
    },
    workerCallAllocationForStep: (step) => step.clientCallAllocation === 53 ? 58 : step.clientCallAllocation,
    wallReservationForStep: (step) => {
      if (!Number.isSafeInteger(step?.reservationMs) || step.reservationMs < 1) {
        throw new Error('external_normal_r2_step_reservation_invalid');
      }
      return step.reservationMs;
    },
    authFailureStepId: 'r2-s008',
    historyProducerStepId: 'r2-s003',
    assessStep: (step, result, historyRunId, expectedReviewIdentity) => {
      const mappedStep = { ...step, stepId: assessmentStepIds[step.stepId] };
      if (step.stepId === 'r2-s006') {
        const changedPaths = inputsById.get(step.caseId)?.source?.changedPaths;
        const withheldPath = Array.isArray(changedPaths) && changedPaths.length === 1 ? changedPaths[0] : null;
        return result.clientCalls === 0 && result.providerCalls.length === 0
          && typeof withheldPath === 'string'
          && step.fault?.readPath === withheldPath && step.fault.availability === 'unavailable'
          && result.qualificationControl === 'source-coverage-unavailable'
          && result.preflight?.control === 'source-coverage-unavailable'
          && result.preflight.sourceCoverage === 'unavailable' && result.preflight.withheldPath === withheldPath
          && result.preflight.physicalClientCalls === 0
          ? { status: 'expected_control', reason: 'source_coverage_unavailable_abstained_before_model_call' }
          : { status: 'failed', reason: 'source_coverage_control_evidence_invalid' };
      }
      if (step.clientCallAllocation > 0 && !['r2-s008', 'r2-s009'].includes(step.stepId)) {
        if (!Number.isSafeInteger(result?.clientCalls) || result.clientCalls < 1
          || !Array.isArray(result.providerCalls) || result.providerCalls.length < 1) {
          return { status: 'failed', reason: 'normal_review_provider_dispatch_not_observed' };
        }
        if (!validCompletedNormalReviewEvidence(result)) {
          return { status: 'incomplete', reason: 'normal_gate_did_not_complete_with_canonical_evidence' };
        }
        if (step.stepId === 'r2-s004') {
          const expectedParentSha = historyRunId ? sha256(historyRunId) : null;
          if (!expectedParentSha || !result.history || result.history.source !== 'isolated-qualification-store'
            || result.history.loadStatus !== 'complete' || result.history.parentRunIdSha256 !== expectedParentSha
            || !/^[a-f0-9]{64}$/u.test(result.history.snapshotIdSha256 || '')
            || !/^[a-f0-9]{64}$/u.test(result.history.contextDigest || '')) {
            return { status: 'incomplete', reason: 'loaded_history_lineage_not_proven' };
          }
        }
        if (step.stepId === 'r2-s005' && (!result.history
          || result.history.source !== 'empty-qualification-ablation' || result.history.parentRunIdSha256 !== null)) {
          return { status: 'incomplete', reason: 'empty_history_ablation_not_proven' };
        }
        return { status: 'accepted', reason: 'actual_worker_and_gate_receipts_complete' };
      }
      return assessExternalNormalV2StepReceipt(mappedStep, result, historyRunId, expectedReviewIdentity);
    },
  };
}

/** Serial bounded executor. `executeCase` must invoke `recordClientCall` at the actual fetch boundary. */
async function runExternalNormalQualificationCore({
  repositoryRoot, policyInputRoot, phaseRoot, privateBinding, routeIdentity, authorization, executeCase, captureExactLogs,
  preflightExecution, now = Date.now,
} = {}, trustedR2Execution) {
  if (typeof executeCase !== 'function') throw new Error('external_normal_v2_case_executor_required');
  const frozen = trustedR2Execution
    ? { plan: trustedR2Execution.plan, bundle: trustedR2Execution.bundle, planSha256: trustedR2Execution.planSha256 }
    : await readFrozenExternalNormalV2Plan(repositoryRoot || process.cwd());
  const { bundle, planSha256 } = frozen;
  const template = frozen.plan;
  if (!authorization) return { status: 'authorization_required', phaseId: template.phaseId, clientCalls: 0, planSha256 };
  if (!privateBinding) return { status: 'private_binding_required', phaseId: template.phaseId, clientCalls: 0, planSha256 };
  try { validateExternalNormalV2PrivateBinding(privateBinding); }
  catch { return { status: 'private_binding_rejected', phaseId: template.phaseId, clientCalls: 0, planSha256 }; }
  try { validateExternalNormalV2RouteIdentity(routeIdentity); }
  catch { return { status: 'route_identity_rejected', phaseId: template.phaseId, clientCalls: 0, planSha256 }; }
  const plan = trustedR2Execution ? trustedR2Execution.plan
    : bindExternalNormalV2PrivateInputs(template, privateBinding, routeIdentity);
  const profile = externalNormalExecutionProfile(trustedR2Execution);
  if (plan.status !== 'frozen-ready-awaiting-root-go' || plan.dispatchAuthorization !== false
    || !plan.runtime?.finalSourceRevision || !plan.runtime?.workerImageDigest || !plan.runtime?.runtimeManifestSha256
    || !plan.policy?.effectiveConfigSha256 || !plan.targetProjections?.every((row) =>
      row.effectiveConfigSha256 === plan.policy.effectiveConfigSha256)) {
    return { status: 'candidate_not_frozen', phaseId: plan.phaseId, clientCalls: 0, planSha256 };
  }
  if (typeof captureExactLogs !== 'function') {
    return { status: 'exact_log_collector_required', phaseId: plan.phaseId, clientCalls: 0, planSha256 };
  }
  if (typeof preflightExecution !== 'function') {
    return { status: 'execution_preflight_required', phaseId: plan.phaseId, clientCalls: 0, planSha256 };
  }
  const verifiedPolicyInputs = await verifyPolicyInputFiles(policyInputRoot, plan, privateBinding);
  if (phaseRoot && phaseRoot !== privateBinding.phaseRoot.canonicalPath) {
    return { status: 'private_binding_rejected', phaseId: plan.phaseId, clientCalls: 0, planSha256 };
  }
  const canonicalRoot = await canonicalizePhaseRoot(privateBinding.phaseRoot.canonicalPath);
  const outputRootSha256 = sha256(canonicalRoot);
  const rootInfo = await lstat(canonicalRoot);
  if (!validateExternalNormalV2PhaseRootIdentity(plan, canonicalRoot, rootInfo)) {
    return { status: 'phase_root_binding_rejected', phaseId: plan.phaseId, clientCalls: 0, planSha256 };
  }
  const artifactStoreIdentitySha256 = sha256(canonicalJson({ pathSha256: outputRootSha256,
    uid: rootInfo.uid, gid: rootInfo.gid, mode: rootInfo.mode & 0o777 }));
  const launcherSourceDigests = await readExternalNormalV2LauncherSourceDigests(repositoryRoot || process.cwd());
  const tuple = trustedR2Execution
    ? buildExternalNormalR2AuthorizationTuple(plan, planSha256, outputRootSha256,
      launcherSourceDigests.tupleSha256, artifactStoreIdentitySha256, privateBinding, routeIdentity,
      trustedR2Execution.admitted)
    : buildExternalNormalV2AuthorizationTuple(plan, planSha256, outputRootSha256,
      launcherSourceDigests.tupleSha256, artifactStoreIdentitySha256, privateBinding, routeIdentity);
  const validGrant = trustedR2Execution
    ? validateExternalNormalR2RootGoGrant(plan, authorization, tuple, now())
    : validateRootGoGrant(plan, authorization, tuple, now());
  if (!validGrant) {
    return { status: 'authorization_rejected', phaseId: plan.phaseId, clientCalls: 0, planSha256 };
  }
  if (!await consumeOneShotGrant(canonicalRoot, authorization)) {
    return { status: 'authorization_replayed', phaseId: plan.phaseId, clientCalls: 0, planSha256 };
  }
  const started = now();
  let clientCalls = 0;
  let failed = false;
  let incomplete = false;
  let activeElapsedMs = 0;
  let captureElapsedMs = 0;
  const stepResults = [];
  const historyRuns = new Map();
  const capturedLogRows = [];
  const exactLogCaptureBatches = [];
  const routeIdentityProofs = [];
  let exactLogCaptureFailure = null;
  let unknownClientCallUpperBound = 0;
  const captureStepLogs = async (stepResult) => {
    const calls = stepResult?.providerCalls ?? [];
    if (calls.length === 0 || (stepResult.stepId === profile.authFailureStepId && !stepResult.recoveredAttemptLedger)) {
      return { ok: true, status: 'no_calls', matchedCount: 0 };
    }
    const captureReserveRemaining = CAPTURE_RESERVE_MS - captureElapsedMs;
    const phaseRemaining = PHASE_WALL_LIMIT_MS - (now() - started);
    const allowedMs = Math.min(captureReserveRemaining, phaseRemaining);
    if (exactLogCaptureFailure) return { ok: false, status: 'unavailable', matchedCount: 0 };
    if (allowedMs <= 0) {
      exactLogCaptureFailure = { stepId: stepResult.stepId, status: 'unavailable', queriedCallCount: 0,
        matchedRows: 0, unqueriedCallCount: calls.length,
        unqueriedCidSha256: calls.map((call) => call.clientRequestIdSha256).sort(),
        unqueriedCidSetSha256: sha256(canonicalJson(calls.map((call) => call.clientRequestIdSha256).sort())),
        failureCode: 'capture_reserve_no_fit' };
      exactLogCaptureBatches.push(exactLogCaptureFailure);
      return { ok: false, status: 'unavailable', matchedCount: 0 };
    }
    const captureStartedAt = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('external_normal_v2_capture_reserve_exhausted')), allowedMs);
    timer.unref?.();
    let captured;
    let exactCidRowsValidated = false;
    try {
      captured = await captureExactLogs({ phaseId: plan.phaseId, planSha256,
        artifactStoreRoot: canonicalRoot, calls,
        stepReceipts: [{ stepId: stepResult.stepId, runId: stepResult.runId,
          receiptSha256: stepResult.receiptSha256, artifactReferences: stepResult.artifactReferences }],
        deadlineAt: captureStartedAt + allowedMs, signal: controller.signal });
      if (!captured || !['captured', 'unavailable'].includes(captured.status)) {
        throw new Error('external_normal_v2_exact_log_capture_receipt_invalid');
      }
      if (captured.status === 'unavailable') {
        const queriedIds = captured.queriedCidSha256;
        const unqueriedIds = captured.unqueriedCidSha256;
        const expectedIds = calls.map((call) => call.clientRequestIdSha256).sort();
        const reportedIds = Array.isArray(queriedIds) && Array.isArray(unqueriedIds)
          ? [...queriedIds, ...unqueriedIds].sort() : [];
        if (!Number.isSafeInteger(captured.queriedCallCount) || captured.queriedCallCount < 0
          || !Number.isSafeInteger(captured.matchedRows) || captured.matchedRows < 0
          || !Number.isSafeInteger(captured.unqueriedCallCount) || captured.unqueriedCallCount < 0
          || !/^[a-f0-9]{64}$/u.test(captured.unqueriedCidSetSha256 || '')
          || !Array.isArray(queriedIds) || queriedIds.some((id) => !/^[a-f0-9]{64}$/u.test(id))
          || !Array.isArray(unqueriedIds) || unqueriedIds.some((id) => !/^[a-f0-9]{64}$/u.test(id))
          || queriedIds.length !== captured.queriedCallCount || unqueriedIds.length !== captured.unqueriedCallCount
          || new Set(reportedIds).size !== expectedIds.length
          || reportedIds.some((id, index) => id !== expectedIds[index])
          || captured.unqueriedCidSetSha256 !== sha256(canonicalJson(unqueriedIds.slice().sort()))
          || !Array.isArray(captured.rows) || captured.rows.length !== captured.matchedRows
          || typeof captured.failureCode !== 'string' || !/^[a-z0-9_]{1,100}$/u.test(captured.failureCode)) {
          throw new Error('external_normal_v2_partial_capture_receipt_invalid');
        }
        if (captured.rows.length > 0) {
          const callsByCid = new Map(calls.map((call) => [call.clientRequestIdSha256, call]));
          const partialCalls = captured.rows.map((row) => callsByCid.get(row.clientRequestIdSha256));
          if (partialCalls.some((call) => !call) || new Set(captured.rows.map((row) => row.clientRequestIdSha256)).size !== captured.rows.length) {
            throw new Error('external_normal_v2_partial_capture_cid_set_invalid');
          }
          validateExactLogLedger(partialCalls, { status: 'captured', rows: captured.rows });
          capturedLogRows.push(...captured.rows);
        }
        exactLogCaptureFailure = { stepId: stepResult.stepId, status: 'unavailable',
          queriedCallCount: captured.queriedCallCount, matchedRows: captured.matchedRows,
          unqueriedCallCount: captured.unqueriedCallCount,
          queriedCidSha256: queriedIds.slice().sort(), unqueriedCidSha256: unqueriedIds.slice().sort(),
          unqueriedCidSetSha256: captured.unqueriedCidSetSha256,
          partialRowSetSha256: /^[a-f0-9]{64}$/u.test(captured.partialRowSetSha256 || '')
            ? captured.partialRowSetSha256 : null,
          failureCode: captured.failureCode };
        exactLogCaptureBatches.push(exactLogCaptureFailure);
        return { ok: false, status: 'unavailable', matchedCount: captured.rows.length };
      }
      const expectedArtifactSetSha256 = Array.isArray(captured.rows)
        ? sha256(canonicalJson(captured.rows.map((row) => row.exactLogRowSha256).sort())) : null;
      if (!/^[a-f0-9]{64}$/u.test(captured.artifactSetSha256 || '')
        || !Number.isSafeInteger(captured.artifactCount) || captured.artifactCount !== calls.length
        || !Array.isArray(captured.rows) || captured.rows.length !== calls.length
        || !Array.isArray(captured.queriedCidSha256)
        || captured.queriedCidSha256.length !== calls.length
        || captured.queriedCidSha256.slice().sort().some((id, index) => id !== calls.map((call) => call.clientRequestIdSha256).sort()[index])
        || captured.artifactSetSha256 !== expectedArtifactSetSha256) {
        throw new Error('external_normal_v2_exact_log_capture_receipt_invalid');
      }
      validateExactLogLedger(calls, captured);
      exactCidRowsValidated = true;
      const routeIdentity = stepResult.recoveredAttemptLedger
        ? { status: 'client_response_unavailable' }
        : validateCapturedRouteIdentity(calls, captured.rows, plan.policy.routeAlias, plan.policy.routeIdentity);
      capturedLogRows.push(...captured.rows);
      const batch = { stepId: stepResult.stepId, status: 'captured', artifactSetSha256: captured.artifactSetSha256,
        artifactCount: captured.artifactCount, queriedCallCount: captured.artifactCount,
        matchedRows: captured.artifactCount, queriedWithoutMatchCount: 0, unqueriedCallCount: 0,
        queriedCidSha256: captured.queriedCidSha256.slice().sort(), unqueriedCidSha256: [],
        unqueriedCidSetSha256: sha256(canonicalJson([])), routeIdentity };
      exactLogCaptureBatches.push(batch);
      if (!stepResult.recoveredAttemptLedger) routeIdentityProofs.push({ stepId: stepResult.stepId, ...routeIdentity });
      return { ok: true, status: 'captured', routeIdentity, matchedCount: captured.rows.length };
    } catch (error) {
      const failureCode = error?.message && /^[a-z0-9_]{1,100}$/u.test(error.message)
        ? error.message : 'exact_log_capture_failed';
      if (captured?.status === 'captured' && exactCidRowsValidated) {
        capturedLogRows.push(...captured.rows);
        exactLogCaptureFailure = { stepId: stepResult.stepId, status: 'failed',
          queriedCallCount: calls.length, matchedRows: calls.length, queriedWithoutMatchCount: 0,
          unqueriedCallCount: 0, queriedCidSha256: calls.map((call) => call.clientRequestIdSha256).sort(),
          unqueriedCidSha256: [], unqueriedCidSetSha256: sha256(canonicalJson([])),
          artifactSetSha256: captured.artifactSetSha256,
          routeIdentityStatus: 'unproven', failureCode };
      } else if (captured?.status === 'captured') {
        const queriedIds = Array.isArray(captured.queriedCidSha256) ? captured.queriedCidSha256.slice().sort() : [];
        exactLogCaptureFailure = { stepId: stepResult.stepId, status: 'failed',
          queriedCallCount: queriedIds.length, matchedRows: 0, queriedWithoutMatchCount: calls.length,
          unqueriedCallCount: Math.max(0, calls.length - queriedIds.length), queriedCidSha256: queriedIds,
          unqueriedCidSha256: calls.map((call) => call.clientRequestIdSha256)
            .filter((cid) => !queriedIds.includes(cid)).sort(),
          failureCode };
      } else {
        exactLogCaptureFailure = { stepId: stepResult.stepId, status: 'failed',
          queriedCallCount: 0, matchedRows: 0, unqueriedCallCount: calls.length,
          queriedCidSha256: [], unqueriedCidSha256: calls.map((call) => call.clientRequestIdSha256).sort(),
          unqueriedCidSetSha256: sha256(canonicalJson(calls.map((call) => call.clientRequestIdSha256).sort())),
          failureCode };
      }
      exactLogCaptureBatches.push(exactLogCaptureFailure);
      return { ok: false, status: 'failed', matchedCount: exactCidRowsValidated ? calls.length : 0 };
    } finally {
      clearTimeout(timer);
      captureElapsedMs += Math.max(0, now() - captureStartedAt);
    }
  };
  const preflightStartedAt = now();
  let transportPreflight;
  try {
    const proof = await preflightExecution({ phaseId: plan.phaseId, phasePlanSha256: planSha256,
      sourceRevision: plan.runtime.finalSourceRevision, workerImageDigest: plan.runtime.workerImageDigest,
      runtimeManifestSha256: plan.runtime.runtimeManifestSha256,
      origin: plan.policy.inferenceBaseUrl,
      deadlineAt: externalNormalV2TransportPreflightDeadlineAt(plan, preflightStartedAt), artifactStoreRoot: canonicalRoot });
    transportPreflight = validateExternalNormalV2TransportPreflight(plan, proof);
  } catch {
    transportPreflight = { status: 'unavailable', failureCode: 'container_dns_tls_preflight_failed' };
  }
  if (transportPreflight.status !== 'ready') incomplete = true;
  if (transportPreflight.status === 'ready') for (const step of plan.runs) {
    const input = profile.inputForStep(step);
    const reservation = profile.wallReservationForStep(step);
    const armCallAllocation = profile.clientCallAllocationForStep(step);
    const workerCallAllocation = profile.workerCallAllocationForStep(step);
    const notYetReserved = plan.runs.slice(plan.runs.indexOf(step) + 1)
      .reduce((sum, later) => sum + profile.wallReservationForStep(later), 0);
    const currentTime = now();
    const overheadElapsed = Math.max(0, currentTime - started - activeElapsedMs - captureElapsedMs);
    const overheadRemaining = RESERVED_OVERHEAD_MS - overheadElapsed;
    const remainingMs = PHASE_WALL_LIMIT_MS - (currentTime - started);
    const remainingCaptureReserve = Math.max(0, CAPTURE_RESERVE_MS - captureElapsedMs);
    const requiredMs = reservation + notYetReserved + remainingCaptureReserve + Math.max(0, overheadRemaining);
    if (overheadRemaining < 0 || remainingMs < requiredMs) { incomplete = true; break; }
    const historyRunId = step.historySourceStepId ? historyRuns.get(step.historySourceStepId) : undefined;
    if (step.historySourceStepId && !historyRunId) {
      const caseRunId = runIdFor(plan, step);
      stepResults.push({ stepId: step.stepId, runId: caseRunId, clientCallAllocation: armCallAllocation,
        blockedClientCalls: 0, clientCalls: 0, terminalStatus: 'preflight_incomplete',
        receiptSha256: sha256(canonicalJson({ stepId: step.stepId, reason: 'required_history_source_step_incomplete' })),
        artifactReferences: [] });
      incomplete = true;
      continue;
    }
    const caseRunId = runIdFor(plan, step);
    const projection = projectExternalNormalV2Case(step, input, plan, caseRunId, historyRunId);
    const stepStartedAt = now();
    const controller = new AbortController();
    const deadlineAt = stepStartedAt + reservation;
    const timer = setTimeout(() => controller.abort(new Error('external_normal_v2_arm_deadline_exceeded')), reservation);
    timer.unref?.();
    let stepCalls = 0;
    let stepBlockedClientCalls = 0;
    let rawExecutionReceipt;
    let validatedExecutionReceipt;
    let stepResultForCapture;
    let stopAfterStep = false;
    try {
      rawExecutionReceipt = await executeCase(projection, {
        signal: controller.signal,
        deadlineAt,
        clientCallAllocation: workerCallAllocation,
        captureOutsideChild: plan.executionEnvelope.captureOutsideChildDeadline,
        artifactStoreRoot: canonicalRoot,
        recordClientCall() {
          if (now() >= deadlineAt) throw new Error('external_normal_v2_arm_deadline_exceeded');
          if (stepCalls >= armCallAllocation) {
            stepBlockedClientCalls += 1;
            throw new Error('external_normal_v2_per_arm_client_call_cap_exceeded');
          }
          if (clientCalls >= profile.phaseCallLimit) {
            stepBlockedClientCalls += 1;
            throw new Error('external_normal_v2_phase_client_call_cap_exceeded');
          }
          clientCalls += 1; stepCalls += 1;
        },
        get clientCallCount() { return stepCalls; },
        get blockedClientCallCount() { return stepBlockedClientCalls; },
      });
      const reportedChildCalls = Number.isSafeInteger(rawExecutionReceipt?.clientCalls) ? rawExecutionReceipt.clientCalls : null;
      if (reportedChildCalls !== null && stepCalls === 0) {
        if (reportedChildCalls > armCallAllocation || clientCalls + reportedChildCalls > profile.phaseCallLimit) {
          throw new Error('external_normal_v2_child_client_call_budget_exceeded');
        }
        clientCalls += reportedChildCalls;
        stepCalls = reportedChildCalls;
      } else if (reportedChildCalls !== null && reportedChildCalls !== stepCalls) {
        throw new Error('external_normal_v2_child_parent_call_ledger_mismatch');
      }
      const result = validateExecutionReceipt(rawExecutionReceipt, stepCalls);
      validatedExecutionReceipt = result;
      if (result.providerCalls.some((call) => call.requestedAlias !== plan.policy.routeAlias
        || call.requestedEffort !== plan.policy.requestedEffort)) {
        throw new Error('external_normal_v2_requested_route_binding_mismatch');
      }
      const artifactVerification = result.artifactReferences.length > 0
        ? await verifyExternalNormalV2ArtifactReferences(canonicalRoot, result.artifactReferences, result.receiptSha256)
        : null;
      let privateIdentifierSidecarStatus;
      let privateIdentifierSidecarReference;
      if (result.terminalStatus === 'failed' && result.failureCode === 'worker_execution_failed' && stepCalls > 0) {
        try {
          const recovered = await recoverExternalNormalV2PrivateIdentifierSidecar(canonicalRoot, caseRunId,
            qualificationPhaseForArm(step.arm), step.caseId, armCallAllocation);
          if (recovered.status === 'recovered'
            && privateIdentifierSidecarMatchesProviderCalls(recovered, result.providerCalls, stepCalls)) {
            privateIdentifierSidecarStatus = 'bound';
            privateIdentifierSidecarReference = recovered.sidecarReference;
          } else {
            privateIdentifierSidecarStatus = recovered.status === 'absent' ? 'absent'
              : recovered.status === 'unavailable' ? 'unavailable' : 'mismatch';
          }
        } catch { privateIdentifierSidecarStatus = 'unavailable'; }
      }
      const bundledCase = bundle.cases.find((candidate) => candidate.caseId === step.caseId);
      const expectedReviewIdentity = bundledCase ? {
        repository: `${bundledCase.repository.owner}/${bundledCase.repository.repo}`,
        baseSha: bundledCase.baseSha, headSha: bundledCase.headSha,
      } : null;
      const assessment = profile.assessStep(step, result, historyRunId, expectedReviewIdentity);
      stepResultForCapture = { stepId: step.stepId, runId: caseRunId, clientCallAllocation: armCallAllocation,
        clientCalls: stepCalls, blockedClientCalls: stepBlockedClientCalls, artifactVerification, assessment, ...result,
        ...(privateIdentifierSidecarReference ? { artifactReferences: [
          ...result.artifactReferences, privateIdentifierSidecarReference,
        ] } : {}),
        ...(privateIdentifierSidecarStatus ? { privateIdentifierSidecarStatus } : {}) };
      stepResults.push(stepResultForCapture);
      if (step.stepId === profile.historyProducerStepId && assessment.status === 'accepted') {
        historyRuns.set(step.stepId, caseRunId);
      }
      if (assessment.status === 'incomplete' || result.terminalStatus === 'failed') incomplete = true;
      if (assessment.status === 'failed' || result.terminalStatus === 'failed') { failed = true; stopAfterStep = true; }
      if (assessment.status === 'incomplete') stopAfterStep = true;
    } catch (error) {
      failed = true;
      incomplete = true;
      const mayHaveSentRequests = error?.clientAttemptsMayHaveBeenSent === true && armCallAllocation > 0;
      const preChildFailure = safeExternalNormalV2PreChildFailure(error);
      let partial = validatedExecutionReceipt;
      if (!partial && rawExecutionReceipt) {
        try { partial = validateExecutionReceipt(rawExecutionReceipt, stepCalls); } catch { /* preserve count when the receipt shape is invalid */ }
      }
      let recovered = { status: 'absent', candidateCount: 0, calls: [] };
      if (mayHaveSentRequests && !(partial?.providerCalls?.length > 0)) {
        try {
          recovered = await recoverExternalNormalV2PrivateIdentifierSidecar(canonicalRoot, caseRunId,
            qualificationPhaseForArm(step.arm), step.caseId, armCallAllocation);
        } catch { recovered = { status: 'unavailable', candidateCount: 0, calls: [] }; }
      }
      const recoveredAttemptLedger = recovered.status === 'recovered';
      const unknownAttemptsUpperBound = mayHaveSentRequests
        ? recoveredAttemptLedger ? recovered.candidateCount : armCallAllocation : 0;
      unknownClientCallUpperBound += unknownAttemptsUpperBound;
      const recoveredCalls = recoveredAttemptLedger ? recovered.calls.map((call) => ({ ...call,
        requestedAlias: plan.policy.routeAlias, requestedEffort: plan.policy.requestedEffort })) : [];
      const artifactReferences = [...(partial?.artifactReferences ?? [])];
      if (recoveredAttemptLedger && !artifactReferences.some((reference) => reference.path === recovered.sidecarReference.path)) {
        artifactReferences.push(recovered.sidecarReference);
      }
      stepResultForCapture = { stepId: step.stepId, runId: caseRunId, clientCallAllocation: armCallAllocation,
        clientCalls: mayHaveSentRequests ? null : stepCalls, clientCallsKnown: stepCalls,
        blockedClientCalls: stepBlockedClientCalls, terminalStatus: 'failed',
        receiptSha256: sha256(canonicalJson({ stepId: step.stepId, reason: 'case_execution_or_artifact_validation_failed' })),
        artifactReferences, artifactVerification: null,
        clientAttemptsStatus: recoveredAttemptLedger ? 'recovered_private_identifier_sidecar'
          : mayHaveSentRequests ? 'unknown_child_ledger' : 'accounted',
        unidentifiedClientAttempts: mayHaveSentRequests ? null : partial?.unidentifiedClientAttempts ?? stepCalls,
        ...(unknownAttemptsUpperBound > 0 ? { unknownClientCallUpperBound: unknownAttemptsUpperBound } : {}),
        ...(recoveredAttemptLedger ? { recoveredAttemptLedger: true,
          recoveredCandidateAttemptLimit: recovered.candidateCount, recoveredSidecarSha256: recovered.sidecarSha256,
          workerAttestorAttemptsBlockedBeforeFetch: recovered.blockedAttestorTailCount } : {}),
        failureCode: 'case_execution_or_artifact_validation_failed',
        ...(preChildFailure ? { preChildFailure } : {}),
        assessment: { status: 'failed', reason: 'case_execution_or_artifact_validation_failed' },
        providerCalls: partial?.providerCalls?.length ? partial.providerCalls : recoveredCalls };
      stepResults.push(stepResultForCapture);
      stopAfterStep = true;
    } finally {
      clearTimeout(timer);
      activeElapsedMs += Math.min(reservation, Math.max(0, now() - stepStartedAt));
    }
    if (stepResultForCapture?.providerCalls?.length > 0) {
      const capture = await captureStepLogs(stepResultForCapture);
      if (stepResultForCapture.recoveredAttemptLedger) {
        const candidateLimit = stepResultForCapture.recoveredCandidateAttemptLimit;
        const recoveredKnownCalls = Math.min(candidateLimit, capture.matchedCount || 0);
        clientCalls += recoveredKnownCalls;
        unknownClientCallUpperBound = Math.max(0, unknownClientCallUpperBound - recoveredKnownCalls);
        const remainingUnknown = Math.max(0, candidateLimit - recoveredKnownCalls);
        stepResultForCapture.clientCallsKnown = recoveredKnownCalls;
        stepResultForCapture.clientCalls = remainingUnknown > 0 ? null : recoveredKnownCalls;
        stepResultForCapture.unknownClientCallUpperBound = remainingUnknown;
        stepResultForCapture.unidentifiedClientAttempts = remainingUnknown > 0 ? null : 0;
        stepResultForCapture.clientAttemptsStatus = remainingUnknown > 0
          ? 'recovered_rows_with_unknown_remainder' : 'recovered_rows_all_matched';
      }
      if (!capture.ok) {
        incomplete = true;
        stopAfterStep = true;
        if (capture.status === 'failed') failed = true;
      }
    }
    if (stopAfterStep) break;
    if (clientCalls >= profile.phaseCallLimit) { incomplete = true; break; }
  }
  const allProviderCalls = stepResults.flatMap((row) => row.providerCalls ?? []);
  const expectedAuthStep = stepResults.find((row) => row.stepId === profile.authFailureStepId
    && row.assessment?.status === 'expected_control');
  const expectedAuthCalls = expectedAuthStep?.providerCalls ?? [];
  const excludedAuthCidHashes = new Set(expectedAuthCalls.map((call) => call.clientRequestIdSha256));
  const logJoinCalls = allProviderCalls.filter((call) => !excludedAuthCidHashes.has(call.clientRequestIdSha256));
  const capturedCids = new Set(capturedLogRows.map((row) => row.clientRequestIdSha256));
  const knownUnqueriedCalls = logJoinCalls.filter((call) => !capturedCids.has(call.clientRequestIdSha256));
  const queriedCidHashes = new Set(exactLogCaptureBatches.flatMap((batch) => batch.queriedCidSha256 ?? []));
  const knownNeverQueriedCidHashes = logJoinCalls.map((call) => call.clientRequestIdSha256)
    .filter((cid) => !queriedCidHashes.has(cid)).sort();
  let logLedger = null;
  let captureResult;
  if (logJoinCalls.length > 0 && unknownClientCallUpperBound === 0 && knownUnqueriedCalls.length === 0
    && capturedLogRows.length === logJoinCalls.length) {
    logLedger = validateExactLogLedger(logJoinCalls, { status: 'captured', rows: capturedLogRows });
  }
  if (logJoinCalls.length === 0) {
    logLedger = validateExactLogLedger(logJoinCalls, { status: 'no_calls' });
    const knownExcludedCidHashes = expectedAuthCalls.map((call) => call.clientRequestIdSha256).sort();
    captureResult = { status: unknownClientCallUpperBound > 0 ? 'unavailable'
      : allProviderCalls.length === 0 ? 'no_calls' : 'expected_auth_rejection_excluded',
    artifactSetSha256: null, artifactCount: 0, queriedCallCount: 0, matchedRows: 0,
    unqueriedCallCount: expectedAuthCalls.length + unknownClientCallUpperBound,
    unqueriedCidSetSha256: unknownClientCallUpperBound > 0 ? null : sha256(canonicalJson(knownExcludedCidHashes)),
    expectedAuthControlExcludedCount: expectedAuthCalls.length,
    unknownClientAttemptUpperBound: unknownClientCallUpperBound,
    ...(unknownClientCallUpperBound > 0 ? { failureCode: 'child_attempt_ledger_unknown' } : {}) };
  } else if (unknownClientCallUpperBound > 0 || exactLogCaptureFailure
    || knownUnqueriedCalls.length > 0 || capturedLogRows.length !== logJoinCalls.length) {
    incomplete = true;
    const authHashes = expectedAuthCalls.map((call) => call.clientRequestIdSha256);
    const knownUnqueriedHashes = [...knownNeverQueriedCidHashes, ...authHashes].sort();
    const queriedCallCount = queriedCidHashes.size;
    const failureCode = exactLogCaptureFailure?.failureCode
      ?? (unknownClientCallUpperBound > 0 ? 'child_attempt_ledger_unknown' : 'exact_log_capture_incomplete');
    captureResult = { status: 'unavailable', artifactSetSha256: null, artifactCount: capturedLogRows.length,
      queriedCallCount, matchedRows: capturedLogRows.length,
      queriedWithoutMatchCount: Math.max(0, queriedCallCount - capturedLogRows.length),
      unqueriedCallCount: knownNeverQueriedCidHashes.length + expectedAuthCalls.length + unknownClientCallUpperBound,
      unqueriedCidSetSha256: unknownClientCallUpperBound > 0 ? null : sha256(canonicalJson(knownUnqueriedHashes)),
      knownUnqueriedCidSetSha256: sha256(canonicalJson(knownUnqueriedHashes)),
      unknownClientAttemptUpperBound: unknownClientCallUpperBound,
      partialRowSetSha256: capturedLogRows.length > 0
        ? sha256(canonicalJson(capturedLogRows.map((row) => row.exactLogRowSha256).sort())) : null,
      failureCode, batches: exactLogCaptureBatches };
  } else {
    logLedger = validateExactLogLedger(logJoinCalls, { status: 'captured', rows: capturedLogRows });
    const artifactSetSha256 = sha256(canonicalJson(capturedLogRows.map((row) => row.exactLogRowSha256).sort()));
    captureResult = { status: expectedAuthCalls.length > 0 ? 'captured_with_expected_auth_exclusion' : 'captured',
      artifactSetSha256, artifactCount: capturedLogRows.length,
      queriedCallCount: capturedLogRows.length, matchedRows: capturedLogRows.length,
      queriedWithoutMatchCount: 0, unqueriedCallCount: expectedAuthCalls.length,
      unqueriedCidSetSha256: sha256(canonicalJson(expectedAuthCalls.map((call) => call.clientRequestIdSha256).sort())),
      expectedAuthControlExcludedCount: expectedAuthCalls.length, failureCode: null,
      batches: exactLogCaptureBatches };
  }
  if (!logLedger || unknownClientCallUpperBound > 0 || exactLogCaptureFailure) incomplete = true;
  const attemptBounds = executionAttemptBounds(clientCalls, unknownClientCallUpperBound, profile);
  const summary = {
    status: failed ? 'failed' : incomplete ? 'incomplete' : 'completed', phaseId: plan.phaseId,
    planSha256, clientCalls: unknownClientCallUpperBound > 0 ? null : clientCalls,
    previousPhysicalAttempts: profile.historicalPhysicalAttempts,
    ...attemptBounds,
    overallPhysicalAttemptCeiling: profile.overallPhysicalAttemptCeiling,
    phaseAttemptAllocation: { declared: plan.executionEnvelope.perArmClientHttpAttemptAllocation.declaredArmTotal,
      spent: unknownClientCallUpperBound > 0 ? null : clientCalls,
      knownSpent: clientCalls, unknownClientCallUpperBound,
      possibleSpentUpperBound: attemptBounds.possiblePhaseClientCallsUpperBound,
      blockedClientHttpAttemptsBeforeFetch: stepResults.reduce((sum, row) => sum + (row.blockedClientCalls || 0), 0),
      workerPhysicalAttemptsBlockedBeforeFetch: stepResults.reduce((sum, row) =>
        sum + (row.resourceExhaustion?.blockedPhysicalRequestAttempts || 0), 0),
      workerAttestorAttemptsBlockedBeforeFetch: stepResults.reduce((sum, row) =>
        sum + (row.workerAttestorAttemptsBlockedBeforeFetch || 0), 0),
      unidentifiedCountedClientAttempts: stepResults.reduce((sum, row) => sum + (row.unidentifiedClientAttempts || 0), 0),
      unspendableReserve: plan.executionEnvelope.perArmClientHttpAttemptAllocation.unspendableSharedReserve },
    verifiedPolicyInputDigests: verifiedPolicyInputs,
    launcherSourceDigests,
    artifactStoreBinding: { pathSha256: outputRootSha256, identitySha256: artifactStoreIdentitySha256,
      uid: rootInfo.uid, gid: rootInfo.gid, mode: rootInfo.mode & 0o777 },
    stepResults: stepResults.map(({ providerCalls: _calls, ...row }) => row), exactLogCapture: captureResult, logLedger,
    routeIdentityProofs,
    transportPreflight,
    expectedAuthRejectionControl: expectedAuthCalls.length === 1 ? {
      clientRequestIdSha256: expectedAuthCalls[0].clientRequestIdSha256,
      requestedAlias: expectedAuthCalls[0].requestedAlias,
      requestedEffort: expectedAuthCalls[0].requestedEffort,
      clientHttpStatus: expectedAuthCalls[0].httpStatus,
      clientFetchFailureClass: expectedAuthCalls[0].fetchFailureClass,
      bifrostLogRowJoined: false,
      billedUsd: null,
      upstreamCompletion: 'unknown',
    } : null,
    startedAt: new Date(started).toISOString(), completedAt: new Date(now()).toISOString(),
    costAccounting: { workerEstimatedUsd: logLedger?.estimatedUsd ?? null,
      bifrostCalculatedCostUsd: logLedger?.bifrostCalculatedCostUsd ?? null,
      actualProviderBilledUsd: null, actualProviderBilledUsdStatus: 'unknown_without_trusted_invoice_source' },
  };
  summary.phaseSummary = await persistPhaseSummary(canonicalRoot, summary);
  return summary;
}

export async function runExternalNormalQualificationV2(input = {}) {
  return runExternalNormalQualificationCore(input);
}

export async function runExternalNormalQualificationR2(input = {}) {
  if (typeof input.executeCase !== 'function') throw new Error('external_normal_r2_case_executor_required');
  const trustedR2Execution = await prepareExternalNormalR2Execution(input);
  return runExternalNormalQualificationCore(input, trustedR2Execution);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const entryUrl = new URL('../dist/qualification/normalEngineQualificationExternalV2.js', import.meta.url);
  const dynamicImport = new Function('specifier', 'return import(specifier)');
  dynamicImport(entryUrl.href).then(async (entry) => {
    const result = await entry.runCurrentSourceExternalNormalV2FromProcess();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!['authorization_required', 'candidate_not_frozen', 'authorization_rejected', 'exact_log_collector_required'].includes(result.status)
      && result.status !== 'completed') process.exitCode = 1;
  }).catch(() => {
    process.stderr.write('external_normal_v2_runner_failed\n');
    process.exitCode = 1;
  });
}
