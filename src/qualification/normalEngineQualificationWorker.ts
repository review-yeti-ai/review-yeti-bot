import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { RepoFileProvider } from '../panel/panelEngine';
import { createPathMatcher } from '../panel/pathMatch';
import { OpenRouterClient, OpenRouterTimeoutError, type FetchImplementation,
  type GroundedVerifierRequestContextV1, type OpenRouterRequest, type OpenRouterResponse, type ReviewModelClient } from '../gateway/openRouterClient';
import { runPublishingReviewWorker, createNormalEngineQualificationCheckClient,
  type NormalEngineQualificationHistorySource, type PublishingReviewReceipt } from '../cli/publishingReview';
import { openaiTransport } from '../review/openaiTransport';
import { parsePreparedReviewExecution } from '../review/preparedPublishingPolicy';
import { parseChangedFiles } from '../review/changedFiles';
import { buildEffectiveReviewFiles } from '../review/personaApplicability';
import { buildDeterministicCoverageManifest, GROUNDED_DEFAULT_BUDGET } from '../review/groundedReviewEngine';
import { resolveComposedEngineMaxFindings, resolveComposedEngineWorkBudget,
  resolveComposedTaskConcurrency } from '../panel/composedEngine';
import { canonicalJson } from '../review/reviewCore';
import { composedRuntimeResourcesSchema } from '../panel/composedResourceReceipt';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION, GROUNDED_REVIEW_RECEIPT_V2_VERSION } from '../review/groundedEvidenceV2';
import { deriveCanonicalWorkerReviewEvidence, parseWorkerReviewCompletion,
  type TrustedReviewCoverageContract, type WorkerReviewCompletion } from '../review/workerReviewCompletion';
import { REVIEW_SEVERITY_POLICY_V2 } from '../review/reviewDecision';
import { evaluateReviewGate } from '../review/reviewGatePolicy';
import { resolveComposedMaxTasks } from '../reviewTaskContract';
import { verifyWorkerRuntimeManifest } from '../cli/workerRuntimeManifest';
import {
  NORMAL_ENGINE_QUALIFICATION_STORE_ROOT,
  NORMAL_ENGINE_QUALIFICATION_PLAN_DESCRIPTOR_PATH,
  NORMAL_ENGINE_QUALIFICATION_PLAN_DESCRIPTOR_SHA256,
  NORMAL_ENGINE_QUALIFICATION_PLAN_ID,
  NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT,
  buildNormalEngineQualificationSourceInput,
  parseNormalEngineQualificationPlanRequest,
  parseNormalEngineQualificationRequest,
  normalEngineQualificationComposedResourcesRelativePath,
  persistNormalEngineQualificationComposedResources,
  persistNormalEngineQualificationProviderIdentifiers,
  persistNormalEngineQualificationPlanReceipt,
  persistNormalEngineQualificationReceipt,
  projectNormalEngineQualificationOutcomes,
  qualificationArmAllowedForFixture,
  qualificationFixturePin,
  qualificationPhaseForArm,
  validateQualificationFixtureInput,
  type NormalEngineQualificationArm,
  type NormalEngineQualificationBudgetProfile,
  type NormalEngineQualificationRequest,
  type NormalEngineQualificationPlanRequest,
  type NormalEngineQualificationReceipt,
  type NormalEngineQualificationPlanReceipt,
  type NormalEngineProviderCaptureBinding,
  type NormalEngineProviderCaptureV1,
  type NormalEngineProviderCaptureRouteBindingInput,
  type NormalEngineProviderCaptureValue,
} from './normalEngineQualification';
import { NormalEngineQualificationHistoryStore, type NormalEngineQualificationHistoryState,
  selectQualificationAdjudicatorRecheckTarget,
  type NormalEngineQualificationVerificationSetIdentity } from './normalEngineQualificationHistory';
import { NormalEngineQualificationProviderAttestor, normalEngineQualificationProviderIdentityStatus,
  normalEngineProviderCaptureV1Schema, normalEngineQualificationProviderCaptureRelativePath } from './normalEngineQualificationProvider';
import {
  NORMAL_ENGINE_QUALIFICATION_CAPTURE_OUTCOME_PURPOSE,
  NORMAL_ENGINE_QUALIFICATION_CAPTURE_OUTCOME_VERSION,
  normalEngineQualificationCaptureArtifactSource,
  persistNormalEngineQualificationCaptureOutcome,
  waitForNormalEngineQualificationCapture,
  writeNormalEngineQualificationCaptureReady,
  type NormalEngineQualificationCaptureWaitResult,
  type PersistedNormalEngineQualificationCaptureReady,
} from './normalEngineQualificationCapture';

export {
  NORMAL_ENGINE_QUALIFICATION_CAPTURE_ACK_PATH as NORMAL_ENGINE_QUALIFICATION_CAPTURE_SENTINEL,
  NORMAL_ENGINE_QUALIFICATION_CAPTURE_TIMEOUT_MS,
  waitForNormalEngineQualificationCapture,
} from './normalEngineQualificationCapture';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function captureRouteBinding(context?: GroundedVerifierRequestContextV1): NormalEngineProviderCaptureRouteBindingInput | undefined {
  if (!context || context.version !== 'GroundedVerifierRequestContext.v1') return undefined;
  return {
    findingFingerprint: context.findingFingerprint,
    severity: context.severity,
    purpose: context.purpose,
    requestedRole: context.requestedRole,
    appliedRole: context.appliedRole,
    configuredAlternateModel: context.configuredAlternateModel,
    selectedModel: context.selectedModel,
  };
}

function availableCaptureValue<T>(field: NormalEngineProviderCaptureValue<T>): T | undefined {
  return field.availability === 'available' ? field.value : undefined;
}

export interface PersistedNormalEngineQualificationProviderCapture {
  path: string;
  sha256: string;
  idempotent: boolean;
}

export async function persistNormalEngineQualificationProviderCapture(
  input: unknown,
  binding: NormalEngineProviderCaptureBinding,
  rootDirectory: string = NORMAL_ENGINE_QUALIFICATION_STORE_ROOT,
): Promise<PersistedNormalEngineQualificationProviderCapture> {
  const parsed = normalEngineProviderCaptureV1Schema.safeParse(input);
  if (!parsed.success || parsed.data.runId !== binding.runId || parsed.data.phase !== binding.phase
    || parsed.data.caseId !== binding.caseId || canonicalJson(parsed.data.runtime) !== canonicalJson(binding.runtime)
    || canonicalJson(parsed.data.target) !== canonicalJson(binding.target)
    || canonicalJson(parsed.data.policy) !== canonicalJson(binding.policy)
    || parsed.data.groundedEvidenceSemanticsVersion !== binding.groundedEvidenceSemanticsVersion) {
    throw new Error('normal-engine qualification provider capture does not match its pre-dispatch identity');
  }
  const path = normalEngineQualificationProviderCaptureRelativePath(binding);
  const body = `${JSON.stringify(parsed.data, null, 2)}\n`;
  const digest = sha256(body);
  const directory = join(rootDirectory, binding.runId, binding.phase, binding.caseId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('normal-engine qualification provider capture directory is invalid');
  }
  await chmod(directory, 0o700);
  const recordDirectory = join(directory, 'provider-capture.record');
  const capturePath = join(recordDirectory, 'provider-capture.json');
  const sha256Path = join(recordDirectory, 'provider-capture.sha256');
  const readExisting = async (): Promise<PersistedNormalEngineQualificationProviderCapture | undefined> => {
    try {
      const [existingBody, existingDigest] = await Promise.all([readFile(capturePath, 'utf8'), readFile(sha256Path, 'utf8')]);
      const actualDigest = sha256(existingBody);
      if (actualDigest !== existingDigest.trim()) throw new Error('normal-engine qualification provider capture store is corrupt');
      if (actualDigest !== digest || existingBody !== body) throw new Error('normal-engine qualification provider capture identity conflict');
      return { path, sha256: actualDigest, idempotent: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const existing = await readExisting();
  if (existing) return existing;
  const temporaryDirectory = join(directory, `.tmp-provider-capture-${randomUUID()}`);
  await mkdir(temporaryDirectory, { mode: 0o700 });
  try {
    const captureFile = await open(join(temporaryDirectory, 'provider-capture.json'), 'wx', 0o600);
    try { await captureFile.writeFile(body, 'utf8'); await captureFile.sync(); }
    finally { await captureFile.close(); }
    const digestFile = await open(join(temporaryDirectory, 'provider-capture.sha256'), 'wx', 0o600);
    try { await digestFile.writeFile(`${digest}\n`, 'utf8'); await digestFile.sync(); }
    finally { await digestFile.close(); }
    const parentHandle = await open(directory, 'r');
    try { await parentHandle.sync(); } finally { await parentHandle.close(); }
    try { await rename(temporaryDirectory, recordDirectory); }
    catch (error) {
      const raced = await readExisting();
      if (raced) return raced;
      throw error;
    }
    const finalParentHandle = await open(directory, 'r');
    try { await finalParentHandle.sync(); } finally { await finalParentHandle.close(); }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return { path, sha256: digest, idempotent: false };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096
    && !path.startsWith('/') && !path.includes('\\') && !/[\x00-\x1f\x7f]/u.test(path)
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

interface PinnedFile {
  path: string;
  content: string;
  sha256: string;
  gitBlobSha: string;
}

interface PinnedRevision {
  commitSha: string;
  files: Map<string, PinnedFile>;
}

function pinnedFiles(request: NormalEngineQualificationRequest): {
  revisions: Map<string, PinnedRevision>;
  baseRevision: PinnedRevision;
  headRevision: PinnedRevision;
  patches: Map<string, string>;
} {
  const input = buildNormalEngineQualificationSourceInput(request);
  const revisions = new Map<string, PinnedRevision>();
  for (const entry of input.source.revisions) {
    const commitSha = entry.commitSha;
    if (typeof commitSha !== 'string' || !/^[a-f0-9]{40}$/u.test(commitSha) || revisions.has(commitSha)
      || !Array.isArray(entry.files)) throw new Error('normal_engine_qualification_fixture_revision_invalid');
    const files = new Map<string, PinnedFile>();
    for (const rawFile of entry.files) {
      const file = objectRecord(rawFile);
      if (!file || !validPath(file.path) || typeof file.content !== 'string'
        || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)
        || typeof file.gitBlobSha !== 'string' || !/^[a-f0-9]{40}$/u.test(file.gitBlobSha)
        || files.has(file.path)) throw new Error('normal_engine_qualification_fixture_file_invalid');
      const bytes = Buffer.from(file.content, 'utf8');
      const contentSha256 = sha256(bytes);
      const gitBlobSha = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
      if (contentSha256 !== file.sha256 || gitBlobSha !== file.gitBlobSha) {
        throw new Error('normal_engine_qualification_fixture_file_digest_mismatch');
      }
      files.set(file.path, { path: file.path, content: file.content, sha256: contentSha256, gitBlobSha });
    }
    revisions.set(commitSha, { commitSha, files });
  }
  const baseRevision = revisions.get(input.source.baseSha);
  const headRevision = revisions.get(input.source.headSha);
  if (!baseRevision || !headRevision) throw new Error('normal_engine_qualification_fixture_revision_pin_mismatch');
  const patches = new Map<string, string>();
  for (const patch of input.source.patches) {
    if (!validPath(patch.path) || typeof patch.patch !== 'string' || sha256(patch.patch) !== patch.sha256
      || patches.has(patch.path)) throw new Error('normal_engine_qualification_fixture_patch_invalid');
    patches.set(patch.path, patch.patch);
  }
  const changedPaths = [...input.source.changedPaths].sort();
  if (new Set(changedPaths).size !== changedPaths.length
    || changedPaths.some((path) => !validPath(path))
    || canonicalJson(changedPaths) !== canonicalJson([...patches.keys()].sort())) {
    throw new Error('normal_engine_qualification_fixture_changed_paths_mismatch');
  }
  return { revisions, baseRevision, headRevision, patches };
}

export function createNormalEngineQualificationRepoFileProvider(
  request: NormalEngineQualificationRequest,
): RepoFileProvider {
  const input = buildNormalEngineQualificationSourceInput(request);
  const source = pinnedFiles(request);
  const repository = `${input.source.repository.owner}/${input.source.repository.repo}`;
  const changedFiles = new Map(parseChangedFiles(input.source.patches.map((entry) => entry.patch).join('\n'), {
    repository, baseSha: input.source.baseSha, headSha: input.source.headSha,
  }).files.map((file) => [file.path, file]));
  const readAt = async (path: string, side: 'head' | 'base' | 'merge-base') => {
    if (!validPath(path)) throw new Error('normal_engine_qualification_source_path_invalid');
    if (request.arm === 'preflight-source-coverage-control' && side === 'head' && path === 'src/modules/module-01.ts') {
      return { content: null, sha: input.source.headSha, presence: 'unavailable' as const,
        source: { repository, path, side }, unavailableReason: 'qualification coverage fault withholds this exact head window' };
    }
    const revision = side === 'head' ? source.headRevision : side === 'base' ? source.baseRevision : undefined;
    if (!revision) return { content: null, sha: input.source.headSha, presence: 'unavailable' as const,
      source: { repository, path, side } };
    const file = revision.files.get(path);
    const result = {
      content: file?.content ?? null,
      sha: revision.commitSha,
      presence: file ? 'present' as const : 'absent' as const,
      source: { repository, path, side },
      ...(file ? { contentSha256: file.sha256 } : {}),
    };
    return result;
  };
  return {
    async findFiles(query) {
      const matches = createPathMatcher(query);
      return [...source.headRevision.files.keys()].filter(matches).sort();
    },
    async readFile(path) {
      return validPath(path) ? source.headRevision.files.get(path)?.content ?? null : null;
    },
    async readFileAt(path, side) {
      return readAt(path, side);
    },
    readDiff(path) {
      const changed = changedFiles.get(path);
      return changed && typeof changed.patch === 'string' ? {
        patch: changed.patch,
        originalPatchLength: Buffer.byteLength(changed.patch, 'utf8'),
        identity: { repository, baseSha: input.source.baseSha, headSha: input.source.headSha },
      } : null;
    },
    async treeTruncated() { return false; },
  };
}

export interface NormalEngineQualificationPlanStep {
  descriptorRunId: string;
  arm: NormalEngineQualificationArm;
  caseId: string;
  phase: NormalEngineQualificationRequest['phase'];
  historySourceDescriptorRunId: string | null;
  budgetProfile: NormalEngineQualificationBudgetProfile;
  inputSha256: string;
  bundleSha256: string;
  configurationVariant: NormalEngineQualificationPlanRequest['configurationVariant'];
}

export interface ParsedNormalEngineQualificationPlan {
  planId: typeof NORMAL_ENGINE_QUALIFICATION_PLAN_ID;
  descriptorSha256: string;
  configurationVariant: NormalEngineQualificationPlanRequest['configurationVariant'];
  maxActiveDurationMs: number;
  steps: NormalEngineQualificationPlanStep[];
}

const ARM_BY_DESCRIPTOR_RUN_ID: Readonly<Record<string, NormalEngineQualificationArm>> = {
  'ws5-sequence-a-v1': 'repair-introduction',
  'ws5-p2-display-sort-v1': 'p2-only',
  'ws5-sequence-b-v1': 'repair-head-history',
  'ws5-sequence-b-repeat-v1': 'repair-head-repeat',
  'ws5-sequence-b-no-history-v1': 'repair-head-empty-history',
  'ws5-sequence-b-history-unavailable-v1': 'repair-head-history-unavailable',
  'ws5-sequence-b-verifier-unavailable-v1': 'repair-head-verifier-unavailable',
  'ws5-large-crossfile-v1': 'large-crossfile',
  'ws5-provider-failure-v1': 'provider-failure',
  'ws5-resource-exhaustion-v1': 'resource-exhaustion',
  'ws5-sequence-a-adjudicator-v1': 'adjudicator-recheck',
};

const PHASE_BY_DESCRIPTOR_RUN_ID: Readonly<Record<string, NormalEngineQualificationRequest['phase']>> = {
  'ws5-sequence-a-v1': 'repair-introduction',
  'ws5-sequence-b-v1': 'repair-head',
  'ws5-sequence-b-repeat-v1': 'repair-head',
  'ws5-sequence-b-no-history-v1': 'repair-head',
  'ws5-sequence-b-history-unavailable-v1': 'repair-head',
  'ws5-sequence-b-verifier-unavailable-v1': 'repair-head',
  'ws5-p2-display-sort-v1': 'single',
  'ws5-large-crossfile-v1': 'single',
  'ws5-provider-failure-v1': 'single',
  'ws5-resource-exhaustion-v1': 'single',
  'ws5-sequence-a-adjudicator-v1': 'same-head-recheck',
};
const DESCRIPTOR_PHASE_LABEL_BY_RUN_ID: Readonly<Record<string, string>> = {
  'ws5-sequence-a-v1': 'introduction',
  'ws5-p2-display-sort-v1': 'p2_display_sort_normal_gate',
  'ws5-sequence-b-v1': 'repair',
  'ws5-sequence-b-repeat-v1': 'repair_repeat',
  'ws5-sequence-b-no-history-v1': 'repair_no_history_control',
  'ws5-sequence-b-history-unavailable-v1': 'repair_history_unavailable_fresh_fallback',
  'ws5-sequence-b-verifier-unavailable-v1': 'repair_verifier_unavailable_control',
  'ws5-large-crossfile-v1': 'large_crossfile_canary',
  'ws5-provider-failure-v1': 'provider_failure_fail_closed_control',
  'ws5-resource-exhaustion-v1': 'resource_exhaustion_fail_closed_control',
  'ws5-sequence-a-adjudicator-v1': 'same_head_adjudicator_recheck',
};

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  const record = recordValue(value);
  if (!record) throw new Error(`normal_engine_qualification_plan_${name}_invalid`);
  return record;
}

export function normalEngineQualificationBudgetProfileForArm(
  arm: NormalEngineQualificationArm, caseId?: string,
): NormalEngineQualificationBudgetProfile {
  if ((caseId === 'ws5-current-1dd-v2-sequence-b' || caseId === 'ws5-r2-c003')
    && arm === 'repair-head-history-unavailable') {
    return 'required-history-preflight-15s';
  }
  if ((caseId?.startsWith('ws5-current-1dd-v2-')
      || ['ws5-r2-c001', 'ws5-r2-c002', 'ws5-r2-c003'].includes(caseId || ''))
    && ['p2-only', 'repair-introduction', 'repair-head-history', 'repair-head-empty-history'].includes(arm)) {
    return 'normal-canary-240s-capture-outside-child';
  }
  if (arm === 'adjudicator-recheck') return 'normal-canary-120s';
  if (arm === 'provider-failure') return 'bifrost-auth-rejection-30s-one-request';
  if (arm === 'resource-exhaustion') return 'resource-exhaustion-60s-one-request';
  if (arm === 'preflight-source-coverage-control') return 'source-coverage-preflight-15s';
  if (arm === 'large-crossfile') return 'large-crossfile-canary-300s';
  if (['p2-only', 'repair-introduction', 'repair-head-history', 'repair-head-repeat',
    'repair-head-empty-history', 'repair-head-history-unavailable', 'repair-head-verifier-unavailable'].includes(arm)) {
    return 'normal-canary-120s';
  }
  return 'prepared-policy-default';
}

/** Validates the exact public, outcome-blind eleven-arm source plan before any case can call Bifrost. */
export function parseNormalEngineQualificationPlanDescriptor(bytes?: Buffer): ParsedNormalEngineQualificationPlan {
  const descriptorBytes = bytes ?? readFileSync(resolve(__dirname, '../..', NORMAL_ENGINE_QUALIFICATION_PLAN_DESCRIPTOR_PATH));
  const descriptorSha256 = sha256(descriptorBytes);
  if (descriptorSha256 !== NORMAL_ENGINE_QUALIFICATION_PLAN_DESCRIPTOR_SHA256) {
    throw new Error('normal_engine_qualification_plan_descriptor_digest_mismatch');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(descriptorBytes.toString('utf8')); }
  catch { throw new Error('normal_engine_qualification_plan_descriptor_invalid'); }
  const descriptor = requiredRecord(parsed, 'descriptor');
  const execution = requiredRecord(descriptor.execution, 'execution');
  const repair = requiredRecord(descriptor.repairBundle, 'repair_bundle');
  const p2 = requiredRecord(descriptor.p2DisplaySortBundle, 'p2_bundle');
  const large = requiredRecord(descriptor.largeCrossfileBundle, 'large_bundle');
  const blindness = requiredRecord(descriptor.blindness, 'blindness');
  const providerControl = requiredRecord(execution.providerFailureControl, 'provider_failure_control');
  const resourceControl = requiredRecord(execution.resourceExhaustionControl, 'resource_exhaustion_control');
  const adjudicatorControl = requiredRecord(descriptor.adjudicatorRecheckControl, 'adjudicator_recheck_control');
  const configurationVariant = descriptor.configurationVariant;
  const arms = descriptor.arms;
  if (descriptor.schemaVersion !== 'ReviewYetiNormalCanaryPlan.v1'
    || descriptor.planId !== NORMAL_ENGINE_QUALIFICATION_PLAN_ID
    || configurationVariant !== NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT
    || execution.configurationVariant !== NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT
    || descriptor.purpose !== 'qualification_only_source_contract'
    || execution.maxCaseRuns !== 11 || execution.maxConcurrentCases !== 1 || execution.automaticRetries !== 0
    || execution.ordinaryPrComments !== false || execution.productionDatabaseWrites !== false
    || execution.isolatedQualificationStoreOnly !== true
    || execution.providerCallsAuthorizedByThisFile !== false
    || execution.maxPlanActiveSeconds !== 1650 || execution.captureHoldMaxSeconds !== 900
    || execution.normalArmPanelBudgetSeconds !== 120 || execution.largeCrossfilePanelBudgetSeconds !== 300
    || execution.providerFailurePanelBudgetSeconds !== 30 || execution.resourceExhaustionPanelBudgetSeconds !== 60
    || execution.totalPlannedPanelBudgetSeconds !== 1350
    || execution.preparedProductionPolicyAndConfigDigestsMutated !== false
    || repair.descriptorSha256 !== 'e6b6e359d6c6676c8ab3461b7e576b2d14a77ed92fb7178b0ba0b6cc69d14329'
    || p2.descriptorSha256 !== 'ff43921f3c8188d6a0efd8a257c310f1ac1d8cefcc32fd1f8fba242c1ecb26af'
    || p2.inputSha256 !== 'c71cd3b3cdf2efd6d83705be5aef8eaa8fe3bb8418e24dfbc0b0a565bf660b2e'
    || large.descriptorSha256 !== '1e929cc12ef523e523dc67e1ee7c3d7ef83268f1e2c4734615c219523e4813c9'
    || large.inputSha256 !== 'ad360475a095d194b933f2323b7226f057cc617f8cbb605d5473bd00f00b62f5'
    || providerControl.mode !== 'single-bounded-bifrost-auth-rejection'
    || providerControl.existingProvisionedKeyReadOrMutated !== false
    || providerControl.physicalModelRequestsMax !== 1
    || resourceControl.testDeadlineSeconds !== 60 || resourceControl.physicalModelRequestsMax !== 1
    || resourceControl.production100RequestEnvelopeMutation !== false
    || adjudicatorControl.mode !== 'same-phase-a-source-and-head-fresh-run'
    || adjudicatorControl.requiresPriorRunId !== 'ws5-sequence-a-v1'
    || adjudicatorControl.historySource !== 'completed_phase_a_v2_history_in_isolated_qualification_store'
    || adjudicatorControl.sourceSelection !== 'deterministic_unique_authenticated_confirmed_blocking_p1_tuple'
    || adjudicatorControl.currentHeadBound !== true || adjudicatorControl.policyAndConfigurationDigestsMustMatchPriorRun !== true
    || adjudicatorControl.modelOrOracleMayAuthorizeTuple !== false || adjudicatorControl.configuredSelectorMustBeAvailableAndUnchanged !== true
    || adjudicatorControl.freshProviderExecutionRequired !== true || adjudicatorControl.cachedReceiptReuse !== false
    || adjudicatorControl.ordinaryPublication !== false
    || blindness.inputProjectionOnly !== true || blindness.expectedLabelsAndOracleBytesExcludedFromWorkerImage !== true
    || blindness.expectedLabelsAndOracleBytesExcludedFromModelContext !== true
    || !Array.isArray(arms) || arms.length !== 11) {
    throw new Error('normal_engine_qualification_plan_descriptor_contract_invalid');
  }
  const seenIds = new Set<string>();
  const steps: NormalEngineQualificationPlanStep[] = [];
  const sourceRunIds = new Map<string, string>();
  for (const rawArm of arms) {
    const armRecord = requiredRecord(rawArm, 'arm');
    const descriptorRunId = armRecord.runId;
    const caseId = armRecord.caseId;
    const inputId = armRecord.inputId;
    if (typeof descriptorRunId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(descriptorRunId)
      || seenIds.has(descriptorRunId) || typeof caseId !== 'string' || inputId !== caseId) {
      throw new Error('normal_engine_qualification_plan_arm_identity_invalid');
    }
    const arm = ARM_BY_DESCRIPTOR_RUN_ID[descriptorRunId];
    const phase = PHASE_BY_DESCRIPTOR_RUN_ID[descriptorRunId];
    const pin = qualificationFixturePin(caseId);
    if (!arm || !phase || !pin || !qualificationArmAllowedForFixture(pin.caseId, arm)
      || phase !== qualificationPhaseForArm(arm)) {
      throw new Error('normal_engine_qualification_plan_arm_pin_mismatch');
    }
    validateQualificationFixtureInput(caseId);
    if (armRecord.phase !== DESCRIPTOR_PHASE_LABEL_BY_RUN_ID[descriptorRunId]) {
      throw new Error('normal_engine_qualification_plan_phase_mismatch');
    }
    const sourceParent = armRecord.requiresPriorRunId;
    if (['repair-head-history', 'repair-head-repeat', 'repair-head-history-unavailable',
      'repair-head-verifier-unavailable', 'adjudicator-recheck'].includes(arm)) {
      if (sourceParent !== 'ws5-sequence-a-v1' || !sourceRunIds.has(sourceParent)) {
        throw new Error('normal_engine_qualification_plan_history_lineage_invalid');
      }
    } else if (sourceParent !== undefined) {
      throw new Error('normal_engine_qualification_plan_unexpected_history_lineage');
    }
    const profile = normalEngineQualificationBudgetProfileForArm(arm);
    steps.push({ descriptorRunId, arm, caseId, phase,
      historySourceDescriptorRunId: typeof sourceParent === 'string' ? sourceParent : null,
      budgetProfile: profile, inputSha256: pin.sha256, bundleSha256: pin.bundleSha256,
      configurationVariant: NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT });
    seenIds.add(descriptorRunId);
    sourceRunIds.set(descriptorRunId, descriptorRunId);
  }
  const adjudicatorStep = steps.find((step) => step.arm === 'adjudicator-recheck');
  if (steps[0]?.descriptorRunId !== 'ws5-sequence-a-v1' || !adjudicatorStep
    || adjudicatorStep.caseId !== 'ws5-sequence-a-v1' || adjudicatorStep.phase !== 'same-head-recheck'
    || adjudicatorStep.historySourceDescriptorRunId !== 'ws5-sequence-a-v1'
    || arms[10] === undefined
    || (arms[10] as Record<string, unknown>).configurationVariant !== NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT) {
    throw new Error('normal_engine_qualification_plan_adjudicator_arm_invalid');
  }
  return { planId: NORMAL_ENGINE_QUALIFICATION_PLAN_ID, descriptorSha256,
    configurationVariant: NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT, maxActiveDurationMs: 1_650_000, steps };
}

function syntheticWorkerRunId(request: NormalEngineQualificationRequest): string {
  return `run_${request.runId.slice(3)}`;
}

function qualificationHistoryBinding(
  request: NormalEngineQualificationRequest,
  workerEnv: NodeJS.ProcessEnv,
): import('./normalEngineQualificationHistory').NormalEngineQualificationHistoryBinding | undefined {
  if (!request.historyRunId) return undefined;
  const lineage = request.historyLineage;
  if (!lineage) throw new Error('normal_engine_qualification_history_lineage_missing');
  const repair = buildNormalEngineQualificationSourceInput(request);
  const sameHeadRecheck = request.arm === 'adjudicator-recheck';
  return {
    runId: request.historyRunId,
    repairRunId: request.runId,
    sequenceId: lineage.sequenceId,
    sourceCaseId: lineage.sourceCaseId,
    repairCaseId: sameHeadRecheck ? lineage.sourceCaseId : lineage.repairCaseId,
    bundleSha256: request.fixture.bundleSha256,
    sourceInputSha256: lineage.sourceInputSha256,
    repairInputSha256: lineage.repairInputSha256,
    repositoryId: request.fixture.repository.repositoryId,
    repository: `${request.fixture.repository.owner}/${request.fixture.repository.repo}`,
    currentBaseSha: repair.source.baseSha,
    currentHeadSha: repair.source.headSha,
    policyDigest: String(workerEnv.REVIEW_POLICY_DIGEST || ''),
    configDigest: String(workerEnv.REVIEW_CONFIG_DIGEST || ''),
    configurationVariant: request.configurationVariant,
    runtime: request.runtime,
    mode: sameHeadRecheck ? 'same-head-recheck' : 'repair-head',
    currentInputSha256: request.fixture.inputSha256,
  };
}

function qualificationHistorySource(
  request: NormalEngineQualificationRequest,
  workerEnv: NodeJS.ProcessEnv,
  store: NormalEngineQualificationHistoryStore,
): NormalEngineQualificationHistorySource | undefined {
  const binding = qualificationHistoryBinding(request, workerEnv);
  if (binding) {
    if (request.arm === 'adjudicator-recheck') return store.sourceForSameHeadAdjudicatorRecheck(binding);
    if (request.arm !== 'repair-head-history-unavailable') return store.sourceForRepair(binding);
    return {
      purpose: 'normal-engine-qualification-history',
      async read() {
        return {
          status: 'unavailable' as const, events: [], findings: [], eventCount: 0, findingCount: 0,
          loadedEventCount: 0, loadedFindingCount: 0, eventOmittedCount: 0, findingOmittedCount: 0,
          legacyOmittedCount: 0, omissions: [request.fixture.bundleVersion === 'WS5ExternalNormalBundle.v2'
            ? 'injected required-history transport failure before planning' : 'qualification history access unavailable for this fixed arm'],
        };
      },
      async recordVerification() { return false; },
    };
  }
  const emptyContextArms = new Set<NormalEngineQualificationArm>([
    'repair-head-empty-history', 'p2-only', 'large-crossfile', 'provider-failure', 'resource-exhaustion',
  ]);
  if (!emptyContextArms.has(request.arm)) return undefined;
  const source = buildNormalEngineQualificationSourceInput(request);
  const ablation = request.arm === 'repair-head-empty-history';
  const mode = ablation ? 'empty-qualification-ablation' : 'empty-qualification-context';
  const snapshotId = uuidFromDigest(sha256(`${request.runId}:${mode}:${request.fixture.inputSha256}`));
  const contextDigest = sha256(canonicalJson({ purpose: mode,
    policyDigest: request.policy.policyDigest, configDigest: request.policy.configDigest,
    repository: source.source.repository, baseSha: source.source.baseSha, headSha: source.source.headSha }));
  const eventsDigest = sha256(canonicalJson([]));
  const findingsDigest = sha256(canonicalJson([]));
  const emptyLoad = {
    status: 'complete' as const, snapshotId, contextDigest, events: [], findings: [],
    eventCount: 0, findingCount: 0, loadedEventCount: 0, loadedFindingCount: 0,
    eventOmittedCount: 0, findingOmittedCount: 0, legacyOmittedCount: 0,
    eventsDigest, findingsDigest, omissions: [],
  };
  return {
    purpose: 'normal-engine-qualification-history',
    async read() { return structuredClone(emptyLoad); },
    async recordVerification() { return false; },
  };
}

function uuidFromDigest(value: string): string {
  const chars = value.slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16]!, 16) % 4]!;
  const raw = chars.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function historyStateFromCompletion(
  request: NormalEngineQualificationRequest,
  completion: WorkerReviewCompletion,
  receipt: PublishingReviewReceipt,
  disputedBlockerAdjudicator: NormalEngineQualificationReceipt['policy']['disputedBlockerAdjudicator'],
  canonicalEvidenceSha256: string | null,
  gateDecisionSha256: string,
): NormalEngineQualificationHistoryState | undefined {
  if (request.arm !== 'repair-introduction' || !completion.result.groundedReview
    || !request.historyLineage
    || !canonicalEvidenceSha256 || receipt.coverage.fullPanelComplete !== true
    || receipt.coverage.groundedReviewComplete === false) return undefined;
  const configuredAdjudicator = request.configurationVariant === NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT;
  if ((configuredAdjudicator && (disputedBlockerAdjudicator.state !== 'available' || !disputedBlockerAdjudicator.modelAlias
      || !disputedBlockerAdjudicator.reasoningEffort))
    || (!configuredAdjudicator && disputedBlockerAdjudicator.state === 'available')) return undefined;
  const grounded = completion.result.groundedReview;
  if (grounded.version !== GROUNDED_REVIEW_RECEIPT_V2_VERSION
    || grounded.semanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
    || grounded.verification.semanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION) return undefined;
  if (!grounded.coverage.complete || !grounded.verification.coverageComplete) return undefined;
  const verifiedAdjudicator: NormalEngineQualificationHistoryState['disputedBlockerAdjudicator'] = configuredAdjudicator
    ? { state: 'available', modelAlias: disputedBlockerAdjudicator.modelAlias!,
      reasoningEffort: disputedBlockerAdjudicator.reasoningEffort! }
    : { state: disputedBlockerAdjudicator.state === 'inactive' ? 'inactive' : 'unconfigured',
      modelAlias: null, reasoningEffort: null };
  const contextDigest = grounded.coverage.digest;
  const outcomes = grounded.verification.outcomes;
  const events = outcomes.map((outcome) => {
    const eventId = uuidFromDigest(sha256(`${completion.runId}:event:${outcome.fingerprint}`));
    return {
      eventId,
      eventType: outcome.status === 'confirmed' ? 'finding-observed'
        : outcome.status === 'contradicted' ? 'finding-contradicted' : 'finding-insufficient',
      runId: completion.runId,
      executionAttempt: completion.executionAttempt,
      evidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
      headSha: completion.headSha,
      baseSha: completion.baseSha,
      policyDigest: completion.policyDigest,
      configDigest: completion.configDigest,
      contextDigest,
      ...(outcome.evidenceDigest ? { evidenceDigest: outcome.evidenceDigest } : {}),
      verificationStatus: outcome.status,
      verification: {
        findingEventId: uuidFromDigest(sha256(`${completion.runId}:finding:${outcome.fingerprint}`)),
        fingerprint: outcome.fingerprint,
        status: outcome.status,
        currentAffectedContextDigest: outcome.affectedContextDigest,
      },
    };
  });
  const findings = outcomes.filter((outcome) => outcome.status === 'confirmed').map((outcome) => ({
    findingEventId: uuidFromDigest(sha256(`${completion.runId}:finding:${outcome.fingerprint}`)),
    fingerprint: outcome.fingerprint,
    path: outcome.path,
    regionStart: outcome.line,
    regionEnd: outcome.line,
    firstSeenHead: completion.headSha,
    lastSeenHead: completion.headSha,
    affectedContextDigest: outcome.affectedContextDigest,
    sourceSeverity: outcome.severity,
    effectiveSeverity: outcome.severity,
    disposition: 'open',
    blocking: outcome.severity === 'P0' || outcome.severity === 'P1',
    verificationStatus: 'confirmed' as const,
    evidenceDigest: outcome.evidenceDigest!,
  }));
  const canonicalEventIds = events.map((event) => event.eventId);
  const canonicalFindingIds = findings.map((finding) => finding.findingEventId);
  const historyLoad = {
    status: 'complete' as const, snapshotId: uuidFromDigest(sha256(`${completion.runId}:snapshot:${contextDigest}`)),
    contextDigest, events, findings,
    eventCount: events.length, findingCount: findings.length,
    loadedEventCount: events.length, loadedFindingCount: findings.length,
    eventOmittedCount: 0, findingOmittedCount: 0, legacyOmittedCount: 0,
    eventsDigest: sha256(canonicalJson(canonicalEventIds)),
    findingsDigest: sha256(canonicalJson(canonicalFindingIds)),
    omissions: [],
  };
  return {
    schemaVersion: 'ReviewYetiNormalQualificationHistory.v2',
    purpose: 'normal-engine-qualification-history',
    evidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
    configurationVariant: request.configurationVariant,
    executionAttempt: completion.executionAttempt,
    disputedBlockerAdjudicator: verifiedAdjudicator,
    adjudicatorRecheckTarget: configuredAdjudicator ? selectQualificationAdjudicatorRecheckTarget({
      historyLoad,
      qualificationRunId: request.runId,
      workerRunId: completion.runId,
      executionAttempt: completion.executionAttempt,
      baseSha: completion.baseSha,
      headSha: completion.headSha,
      policyDigest: completion.policyDigest,
      configDigest: completion.configDigest,
    }) : null,
    runId: request.runId,
    sequenceId: request.historyLineage.sequenceId,
    caseId: request.historyLineage.sourceCaseId,
    bundleSha256: request.fixture.bundleSha256,
    inputSha256: request.historyLineage.sourceInputSha256,
    repairCaseId: request.historyLineage.repairCaseId,
    repairInputSha256: request.historyLineage.repairInputSha256,
    repairBaseSha: request.historyLineage.repairBaseSha,
    repairHeadSha: request.historyLineage.repairHeadSha,
    repositoryId: request.fixture.repository.repositoryId,
    repository: `${request.fixture.repository.owner}/${request.fixture.repository.repo}`,
    baseSha: request.fixture.baseSha,
    headSha: request.fixture.headSha,
    policyDigest: request.policy.policyDigest,
    configDigest: request.policy.configDigest,
    runtime: request.runtime,
    workerCompletionSha256: sha256(canonicalJson(completion)),
    canonicalEvidenceSha256,
    gateDecisionSha256,
    historyLoad,
  };
}

export interface NormalEngineQualificationWorkerDependencies {
  verifyRuntimeManifest?: (path: string) => Promise<string>;
  runPublishingWorker?: typeof runPublishingReviewWorker;
  clientFactory?: (request: NormalEngineQualificationRequest, attestor: NormalEngineQualificationProviderAttestor) => ReviewModelClient;
  providerFetchImplementation?: FetchImplementation;
  persistProviderCapture?: typeof persistNormalEngineQualificationProviderCapture;
  persistComposedResources?: typeof persistNormalEngineQualificationComposedResources;
  persistProviderIdentifiers?: typeof persistNormalEngineQualificationProviderIdentifiers;
  historyStore?: NormalEngineQualificationHistoryStore;
  now?: () => number;
  signal?: AbortSignal;
  testBudgetProfile?: NormalEngineQualificationBudgetProfile;
  runQualificationCase?: typeof runNormalEngineQualificationCase;
  persistCaseReceipt?: typeof persistNormalEngineQualificationReceipt;
  persistPlanReceipt?: typeof persistNormalEngineQualificationPlanReceipt;
  persistCaptureReady?: typeof writeNormalEngineQualificationCaptureReady;
  persistCaptureOutcome?: typeof persistNormalEngineQualificationCaptureOutcome;
  waitForCapture?: typeof waitForNormalEngineQualificationCapture;
  historyArtifacts?: (input: {
    sourceRunId: string;
    repairRuns: NormalEngineQualificationVerificationSetIdentity[];
  }) => Promise<NormalEngineQualificationPlanReceipt['historyArtifacts']>;
}

export class NormalEngineQualificationReceiptPersistError extends Error {
  readonly workerFailure = { stage: 'case_receipt_persistence', code: 'receipt_write_failed' } as const;

  constructor() {
    super('normal_engine_qualification_case_receipt_persist_failed');
    this.name = 'NormalEngineQualificationReceiptPersistError';
  }
}

const PROVIDER_FAILURE_INVALID_KEY = 'qualification-invalid-bifrost-inference-key';
const COMPOSED_ENGINE_AMBIENT_OVERRIDE_KEYS = [
  'COMPOSED_ENGINE_MAX_TURNS',
  'COMPOSED_ENGINE_MAX_FINDINGS',
  'REVIEW_YETI_MAX_FINDINGS',
  'REVIEW_YETI_MAX_CONCURRENT_LANES',
] as const;
const QUALIFICATION_CHILD_ENVIRONMENT_KEYS = [
  'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'REVIEW_MODEL',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_ONLY', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_RUN_ID', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_SOURCE_REVISION',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_WORKER_IMAGE_DIGEST', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_TARGET', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_SELECTION_PURPOSE',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPOSITORY_ID', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_OWNER',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPO', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REF',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_PATH', 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_SHA256',
  'REVIEW_NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT',
  'REVIEW_POLICY_DIGEST', 'REVIEW_CONFIG_DIGEST', 'REVIEW_PREPARED_CONFIG_JSON',
  'REVIEW_PUBLICATION_MODE', 'REVIEW_RECEIPT_PATH', 'REVIEW_REPOSITORY_VISIBILITY',
  'REVIEW_RUNTIME_MANIFEST_PATH', 'REVIEW_YETI_PASSTHROUGH',
] as const;

/** The composed engine reads these process-level operator overrides; a qualification receipt cannot bind them. */
function assertNoAmbientComposedEngineOverrides(): void {
  if (COMPOSED_ENGINE_AMBIENT_OVERRIDE_KEYS.some((key) => typeof process.env[key] === 'string'
    && process.env[key]!.trim().length > 0)) {
    throw new Error('normal_engine_qualification_ambient_composed_override_disallowed');
  }
}

/** Only the fixed qualification runtime inputs cross into a case worker; publisher credentials/adapters are absent. */
function qualificationChildEnvironment(env: NodeJS.ProcessEnv, arm: NormalEngineQualificationArm): NodeJS.ProcessEnv {
  const child: Record<string, string | undefined> = {};
  for (const key of QUALIFICATION_CHILD_ENVIRONMENT_KEYS) {
    if (key === 'OPENAI_API_KEY' && arm === 'provider-failure') continue;
    const value = env[key];
    if (typeof value === 'string') child[key] = value;
  }
  if (arm === 'provider-failure') child.OPENAI_API_KEY = PROVIDER_FAILURE_INVALID_KEY;
  child.REVIEW_REPOSITORY_VISIBILITY = 'PUBLIC';
  return child as NodeJS.ProcessEnv;
}

function emptyPublication() {
  return { mode: 'disabled' as const, githubWrites: 0 as const, appChecks: 0 as const, reviews: 0 as const,
    comments: 0 as const, ordinaryGateTouched: false as const, promptsPersisted: false as const,
    responsesPersisted: false as const, providerCredentialsPersisted: false as const };
}

function qualificationGroundedVerification(
  completion: WorkerReviewCompletion | undefined,
): NormalEngineQualificationReceipt['groundedVerification'] {
  const grounded = completion?.result.groundedReview;
  if (!grounded || grounded.version !== GROUNDED_REVIEW_RECEIPT_V2_VERSION
    || grounded.semanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
    || grounded.verification.semanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION) {
    return { evidenceSemanticsVersion: null, callCount: null, outcomeCount: null, coverageComplete: null, routeReceipts: [] };
  }
  return {
    evidenceSemanticsVersion: grounded.semanticsVersion,
    callCount: grounded.verification.calls,
    outcomeCount: grounded.verification.outcomes.length,
    coverageComplete: grounded.verification.coverageComplete,
    routeReceipts: grounded.verification.outcomes.flatMap((outcome) => outcome.verifierRoute ? [{
      findingFingerprint: outcome.fingerprint,
      path: outcome.path,
      severity: outcome.severity,
      status: outcome.status,
      route: outcome.verifierRoute,
    }] : []),
  };
}

function panelSecondsForBudget(profile: NormalEngineQualificationBudgetProfile): number | null {
  switch (profile) {
    case 'normal-canary-120s': return 120;
    case 'normal-canary-240s-capture-outside-child': return 240;
    case 'large-crossfile-canary-300s': return 300;
    case 'bifrost-auth-rejection-30s-one-request': return 30;
    case 'resource-exhaustion-60s-one-request': return 60;
    case 'source-coverage-preflight-15s': return 15;
    case 'required-history-preflight-15s': return 15;
    case 'prepared-policy-default': return null;
  }
}

/** Capture is a separate post-child phase when true, so it cannot extend the review worker deadline. */
export function normalEngineQualificationChildDeadlineAt(
  nowMs: number,
  activeMs: number,
  captureOutsideChild: boolean,
): string | null {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(activeMs) || activeMs <= 0) return null;
  const deadline = nowMs + activeMs + (captureOutsideChild ? 0 : 300_000);
  if (!Number.isSafeInteger(deadline)) return null;
  return new Date(deadline).toISOString();
}

export async function runNormalEngineQualificationCase(
  env: NodeJS.ProcessEnv,
  dependencies: NormalEngineQualificationWorkerDependencies = {},
): Promise<NormalEngineQualificationReceipt> {
  const request = parseNormalEngineQualificationRequest(env);
  assertNoAmbientComposedEngineOverrides();
  const caseEnv = qualificationChildEnvironment(env, request.arm);
  const manifestPath = String(caseEnv.REVIEW_RUNTIME_MANIFEST_PATH || '/app/runtime-manifest.json').trim();
  const manifestDigest = await (dependencies.verifyRuntimeManifest || verifyWorkerRuntimeManifest)(manifestPath);
  if (manifestDigest !== request.runtime.runtimeManifestSha256) {
    throw new Error('normal_engine_qualification_runtime_manifest_mismatch');
  }
  const input = buildNormalEngineQualificationSourceInput(request);
  const sourceDiff = input.source.patches.map((patch) => patch.patch).join('\n');
  const diffSha256 = sha256(sourceDiff);
  const parsedDiff = parseChangedFiles(sourceDiff, { repository: `${input.source.repository.owner}/${input.source.repository.repo}`,
    baseSha: input.source.baseSha, headSha: input.source.headSha });
  if (parsedDiff.files.length === 0 || parsedDiff.unreadable.length > 0) {
    throw new Error('normal_engine_qualification_fixture_diff_invalid');
  }
  const transport = openaiTransport(caseEnv);
  const prepared = parsePreparedReviewExecution(String(caseEnv.REVIEW_PREPARED_CONFIG_JSON || ''), request.policy.configDigest,
    { baseUrl: transport.baseUrl, model: transport.model });
  const preparedEffectiveConfiguration = prepared.config.review_configuration_receipt;
  const primaryVerifierModel = prepared.config.reviewers.providers.find((provider) => provider.id === 'bifrost')?.model;
  if (!preparedEffectiveConfiguration || !primaryVerifierModel) {
    throw new Error('normal_engine_qualification_prepared_composed_configuration_missing');
  }
  const cleanBudgetEnvironment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  const effectiveWorkBudget = resolveComposedEngineWorkBudget(cleanBudgetEnvironment, prepared.config.composed?.max_turns_total,
    GROUNDED_DEFAULT_BUDGET.callsPerTask);
  const effectiveComposedLimits: NormalEngineQualificationReceipt['composedLimits'] = {
    configuredTotalTurns: effectiveWorkBudget.totalTurns + effectiveWorkBudget.verificationReserveTurns,
    investigationTurns: effectiveWorkBudget.totalTurns,
    verificationReserveTurns: effectiveWorkBudget.verificationReserveTurns,
    maxFindings: resolveComposedEngineMaxFindings(cleanBudgetEnvironment, prepared.config.composed?.max_findings_total),
    maxConcurrentTasks: resolveComposedTaskConcurrency(cleanBudgetEnvironment, false),
    ambientOverrides: 'absent',
  };
  const configuredAdjudicatorModel = preparedEffectiveConfiguration.effective.disputed_blocker_adjudicator?.state === 'available'
    ? preparedEffectiveConfiguration.effective.disputed_blocker_adjudicator.model_alias : undefined;
  const preparedAdjudicatorReceipt = preparedEffectiveConfiguration.effective.disputed_blocker_adjudicator;
  const disputedBlockerAdjudicatorPolicy: NormalEngineQualificationReceipt['policy']['disputedBlockerAdjudicator'] = preparedAdjudicatorReceipt
    ? { state: preparedAdjudicatorReceipt.state, modelAlias: preparedAdjudicatorReceipt.model_alias ?? null,
      reasoningEffort: preparedAdjudicatorReceipt.reasoning_effort ?? null }
    : { state: 'unconfigured', modelAlias: null, reasoningEffort: null };
  if (configuredAdjudicatorModel && prepared.config.disputed_blocker_adjudicator?.model !== configuredAdjudicatorModel) {
    throw new Error('normal_engine_qualification_adjudicator_config_mismatch');
  }
  const selectorConfigured = preparedAdjudicatorReceipt?.state === 'available';
  if ((request.configurationVariant === NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT) !== selectorConfigured
    || (request.arm === 'adjudicator-recheck' && (!selectorConfigured || !configuredAdjudicatorModel
      || preparedAdjudicatorReceipt?.reasoning_effort === undefined))) {
    throw new Error('normal_engine_qualification_configuration_variant_mismatch');
  }
  const sourceCoverageComplete = request.arm === 'preflight-source-coverage-control'
    ? false : buildDeterministicCoverageManifest(parsedDiff.files).complete;
  const effectiveChangedPaths = buildEffectiveReviewFiles(parsedDiff.files, { pathFilters: prepared.config.path_filters })
    .files.map((file) => file.path);
  const now = dependencies.now || Date.now;
  const startedAt = new Date(now()).toISOString();
  const testBudgetProfile = dependencies.testBudgetProfile
    ?? normalEngineQualificationBudgetProfileForArm(request.arm, request.fixture.caseId);
  if (testBudgetProfile !== normalEngineQualificationBudgetProfileForArm(request.arm, request.fixture.caseId)) {
    throw new Error('normal_engine_qualification_test_budget_profile_mismatch');
  }
  const panelBudgetSeconds = panelSecondsForBudget(testBudgetProfile);
  const providerFailureController = request.arm === 'provider-failure' ? new AbortController() : undefined;
  const executionSignal = providerFailureController
    ? dependencies.signal ? AbortSignal.any([dependencies.signal, providerFailureController.signal]) : providerFailureController.signal
    : dependencies.signal;
  let providerFailureLogicalCalls = 0;
  let providerFailurePhysicalRequests = 0;
  let resourceExhaustionLogicalCalls = 0;
  let resourceExhaustionPhysicalRequests = 0;
  let resourceExhaustionBlockedPhysicalAttempts = 0;
  let resourceExhaustionFirstResponseHttpStatus: number | null = null;
  const fetchImplementation = request.arm === 'provider-failure'
    ? dependencies.providerFetchImplementation || ((input, init) => globalThis.fetch(input, init))
    : dependencies.providerFetchImplementation;
  const boundedProviderFailureFetch: FetchImplementation | undefined = request.arm === 'provider-failure' ? async (input, init) => {
    if (providerFailurePhysicalRequests >= 1) {
      providerFailureController!.abort(new Error('qualification provider-failure physical request cap reached'));
      throw new Error('qualification provider-failure physical request cap reached');
    }
    providerFailurePhysicalRequests += 1;
    return fetchImplementation!(input, init);
  } : undefined;
  const boundedResourceExhaustionFetch: FetchImplementation | undefined = request.arm === 'resource-exhaustion' ? async (input, init) => {
    if (resourceExhaustionPhysicalRequests >= 1) {
      resourceExhaustionBlockedPhysicalAttempts += 1;
      throw new OpenRouterTimeoutError('Qualification resource-exhaustion physical request budget exhausted', 'request');
    }
    resourceExhaustionPhysicalRequests += 1;
    const response = await (dependencies.providerFetchImplementation || ((requestInput, requestInit) =>
      globalThis.fetch(requestInput, requestInit)))(input, { ...init, redirect: 'manual' });
    if (resourceExhaustionPhysicalRequests === 1) resourceExhaustionFirstResponseHttpStatus = response.status;
    return response;
  } : undefined;
  const attestor = new NormalEngineQualificationProviderAttestor(
    boundedProviderFailureFetch || boundedResourceExhaustionFetch || dependencies.providerFetchImplementation);
  const providerCaptureBinding: NormalEngineProviderCaptureBinding = {
    runId: request.runId,
    phase: request.phase,
    caseId: request.fixture.caseId,
    runtime: {
      sourceRevision: request.runtime.sourceRevision,
      workerImageDigest: request.runtime.workerImageDigest,
      runtimeManifestSha256: request.runtime.runtimeManifestSha256,
    },
    target: {
      kind: 'public-synthetic-fixture',
      repositoryId: input.source.repository.repositoryId,
      repository: `${input.source.repository.owner}/${input.source.repository.repo}`,
      prNumber: input.source.prNumber,
      caseId: request.fixture.caseId,
      bundleVersion: request.fixture.bundleVersion,
      bundleSha256: request.fixture.bundleSha256,
      inputSha256: request.fixture.inputSha256,
      baseSha: input.source.baseSha,
      headSha: input.source.headSha,
      diffSha256,
    },
    policy: {
      targetRepository: request.policy.targetRepository,
      selectionPurpose: request.policy.selectionPurpose,
      configurationVariant: request.configurationVariant,
      source: {
        repositoryId: request.policy.sourceRepositoryId,
        owner: request.policy.sourceOwner,
        repo: request.policy.sourceRepo,
        ref: request.policy.sourceRef,
        path: request.policy.sourcePath,
        contentSha256: request.policy.sourceContentSha256,
      },
      effectivePolicyDigest: request.policy.policyDigest,
      effectiveConfigDigest: request.policy.configDigest,
    },
    groundedEvidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
  };
  attestor.bindCaptureContext(providerCaptureBinding);
  const client = dependencies.clientFactory?.(request, attestor)
    || (() => {
      const provider = new OpenRouterClient({ baseUrl: transport.baseUrl, apiKey: transport.apiKey, fetchImplementation: attestor.fetch,
        ...(request.arm === 'provider-failure' || request.arm === 'resource-exhaustion' ? { maxRetries: 0 } : {}) });
      return { complete: (modelRequest: OpenRouterRequest, context?: GroundedVerifierRequestContextV1) =>
        attestor.run(modelRequest, () => provider.complete(modelRequest), {
          ...(captureRouteBinding(context) ? { routeBinding: captureRouteBinding(context) } : {}),
        }) };
    })();
  let resourceArmCallCount = 0;
  const boundedClient: ReviewModelClient = request.arm === 'resource-exhaustion' ? {
    complete: async (modelRequest, context) => {
      resourceExhaustionLogicalCalls += 1;
      return client.complete({ ...modelRequest, signal: modelRequest.signal ?? executionSignal }, context);
    },
  } : request.arm === 'provider-failure' ? {
    complete: async (modelRequest, context) => {
      providerFailureLogicalCalls += 1;
      if (providerFailureLogicalCalls > 1) {
        const error = new OpenRouterTimeoutError('Qualification provider-failure completion cap reached', 'request');
        providerFailureController!.abort(error);
        throw error;
      }
      return client.complete({ ...modelRequest, signal: modelRequest.signal ?? executionSignal }, context);
    },
  } : client;
  const verifierUnavailable = request.arm === 'repair-head-verifier-unavailable';
  const groundedVerifierClient: ReviewModelClient | undefined = verifierUnavailable ? {
    async complete() { throw new OpenRouterTimeoutError('Grounded verifier was unavailable', 'request'); },
  } : undefined;
  const workerRunId = syntheticWorkerRunId(request);
  const workerEnv: NodeJS.ProcessEnv = {
    ...caseEnv,
    REVIEW_RUN_ID: workerRunId,
    REVIEW_REPO: `${input.source.repository.owner}/${input.source.repository.repo}`,
    REVIEW_REPOSITORY_ID: String(input.source.repository.repositoryId),
    REVIEW_PR_NUMBER: String(input.source.prNumber),
    REVIEW_BASE_SHA: input.source.baseSha,
    REVIEW_HEAD_SHA: input.source.headSha,
    REVIEW_PUBLICATION_MODE: 'disabled',
  };
  const terminalDeadlineAt = panelBudgetSeconds === null ? null
    : normalEngineQualificationChildDeadlineAt(now(), panelBudgetSeconds * 1_000,
      !['normal-canary-240s-capture-outside-child', 'source-coverage-preflight-15s', 'required-history-preflight-15s'].includes(testBudgetProfile)
        && request.arm !== 'resource-exhaustion' && request.arm !== 'provider-failure');
  if (terminalDeadlineAt) workerEnv.REVIEW_TERMINAL_DEADLINE = terminalDeadlineAt;
  let completion: WorkerReviewCompletion | undefined;
  let workerReceipt: PublishingReviewReceipt | undefined;
  let workerError: unknown;
  const store = dependencies.historyStore || new NormalEngineQualificationHistoryStore();
  const history = qualificationHistorySource(request, workerEnv, store);
  let authenticatedDisputeSelection: NormalEngineQualificationReceipt['history']['authenticatedDisputeSelection'] = null;
  if (['repair-head-history', 'repair-head-repeat', 'repair-head-verifier-unavailable', 'adjudicator-recheck'].includes(request.arm)) {
    if (!history) throw new Error('normal_engine_qualification_history_preflight_unavailable');
    const loaded = await history.read(executionSignal);
    if (loaded.status !== 'complete' || !loaded.snapshotId || !loaded.contextDigest) {
      throw new Error('normal_engine_qualification_history_preflight_incomplete');
    }
    if (request.arm === 'adjudicator-recheck') {
      const projection = loaded.authenticatedDisputes;
      if (!projection || projection.status !== 'complete' || projection.disputes.length !== 1 || projection.paths.length !== 1) {
        throw new Error('normal_engine_qualification_adjudicator_projection_unavailable');
      }
      const tuple = projection.disputes[0]!;
      const matches = loaded.findings.filter((finding) => finding.fingerprint === tuple.findingFingerprint
        && finding.path === projection.paths[0] && finding.findingEventId === tuple.priorFindingEventId
        && finding.sourceSeverity === 'P1' && finding.effectiveSeverity === 'P1' && finding.blocking
        && finding.disposition === 'open' && finding.verificationStatus === 'confirmed'
        && finding.firstSeenHead === request.fixture.headSha && finding.lastSeenHead === request.fixture.headSha
        && finding.evidenceDigest === tuple.priorEvidenceDigest);
      const linkedEvents = loaded.events.filter((event) => event.verification?.findingEventId === tuple.priorFindingEventId
        && event.verification.fingerprint === tuple.findingFingerprint);
      if (matches.length !== 1 || linkedEvents.length !== 1 || projection.paths[0] !== matches[0]!.path
        || linkedEvents[0]!.verificationStatus !== 'confirmed' || linkedEvents[0]!.verification?.status !== 'confirmed'
        || linkedEvents[0]!.evidenceSemanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
        || linkedEvents[0]!.evidenceDigest !== tuple.priorEvidenceDigest
        || linkedEvents[0]!.headSha !== request.fixture.headSha || linkedEvents[0]!.baseSha !== request.fixture.baseSha
        || linkedEvents[0]!.policyDigest !== request.policy.policyDigest || linkedEvents[0]!.configDigest !== request.policy.configDigest
        || linkedEvents[0]!.contextDigest !== loaded.contextDigest) {
        throw new Error('normal_engine_qualification_adjudicator_projection_binding_invalid');
      }
      authenticatedDisputeSelection = { findingFingerprint: tuple.findingFingerprint, path: projection.paths[0]!,
        priorFindingEventIdSha256: sha256(tuple.priorFindingEventId), priorEvidenceDigest: tuple.priorEvidenceDigest };
    }
  }
  const fixtureProvider = createNormalEngineQualificationRepoFileProvider(request);
  let sourceCoverageControlSatisfied = false;
  let requiredHistoryControlSatisfied = false;
  try {
    assertNoAmbientComposedEngineOverrides();
    workerReceipt = await (dependencies.runPublishingWorker || runPublishingReviewWorker)(workerEnv, {
      checkClient: createNormalEngineQualificationCheckClient(),
      ...(executionSignal ? { signal: executionSignal } : {}),
      client: boundedClient,
      ...(groundedVerifierClient ? { groundedVerifierClient } : {}),
      normalEngineQualification: {
        purpose: 'normal-engine-qualification',
        runId: request.runId,
        caseId: request.fixture.caseId,
        fixtureBundleSha256: request.fixture.bundleSha256,
        fixtureInputSha256: request.fixture.inputSha256,
        workerSourceRevision: request.runtime.sourceRevision,
        workerImageDigest: request.runtime.workerImageDigest,
        runtimeManifestSha256: request.runtime.runtimeManifestSha256,
        sourceRepositoryId: input.source.repository.repositoryId,
        sourceRepository: `${input.source.repository.owner}/${input.source.repository.repo}`,
        baseSha: input.source.baseSha,
        headSha: input.source.headSha,
        policyTarget: request.policy.targetRepository,
        policySelectionPurpose: request.policy.selectionPurpose,
        policySourceRepositoryId: request.policy.sourceRepositoryId,
        policySourceOwner: request.policy.sourceOwner,
        policySourceRepo: request.policy.sourceRepo,
        policySourceRef: request.policy.sourceRef,
        policySourcePath: request.policy.sourcePath,
        policySourceContentSha256: request.policy.sourceContentSha256,
        policyDigest: request.policy.policyDigest,
        configDigest: request.policy.configDigest,
        onWorkerCompletion: async (event) => { completion = parseWorkerReviewCompletion(event); },
        ...(history ? { history } : {}),
      },
      sourceLoader: async (sourceRequest) => {
        if (sourceRequest.repo !== `${input.source.repository.owner}/${input.source.repository.repo}`
          || sourceRequest.prNumber !== input.source.prNumber || sourceRequest.expectedBaseSha !== input.source.baseSha
          || sourceRequest.expectedHeadSha !== input.source.headSha) throw new Error('qualification source identity mismatch');
        if (request.arm === 'preflight-source-coverage-control') {
          const readFileAt = fixtureProvider.readFileAt;
          if (!readFileAt) throw new Error('normal_engine_qualification_source_window_provider_unavailable');
          const withheld = await readFileAt('src/modules/module-01.ts', 'head');
          sourceCoverageControlSatisfied = withheld.presence === 'unavailable' && withheld.content === null
            && withheld.source?.side === 'head' && withheld.source?.path === 'src/modules/module-01.ts';
          if (!sourceCoverageControlSatisfied) throw new Error('normal_engine_qualification_coverage_fault_not_observed');
          throw new Error('normal_engine_qualification_required_source_window_unavailable');
        }
        if (request.arm === 'repair-head-history-unavailable' && request.fixture.bundleVersion === 'WS5ExternalNormalBundle.v2') {
          if (!history) throw new Error('normal_engine_qualification_required_history_source_missing');
          const historyLoad = await history.read(executionSignal);
          requiredHistoryControlSatisfied = historyLoad.status === 'unavailable' && historyLoad.eventCount === 0
            && historyLoad.findingCount === 0;
          if (!requiredHistoryControlSatisfied) throw new Error('normal_engine_qualification_required_history_transport_fault_not_observed');
          throw new Error('normal_engine_qualification_required_history_unavailable_transport');
        }
        return { baseSha: input.source.baseSha, headSha: input.source.headSha, diff: sourceDiff, diffDigest: diffSha256, githubReads: 0 };
      },
      currentPullRequestVerifier: async (candidate) => {
        if (candidate.repo !== `${input.source.repository.owner}/${input.source.repository.repo}`
          || candidate.prNumber !== input.source.prNumber || candidate.expectedHeadSha !== input.source.headSha) {
          throw new Error('qualification current-head identity mismatch');
        }
      },
      pullRequestIdentityReader: async (candidate) => {
        if (candidate.repo !== `${input.source.repository.owner}/${input.source.repository.repo}`
          || candidate.prNumber !== input.source.prNumber) throw new Error('qualification current-identity mismatch');
        return { baseSha: input.source.baseSha, headSha: input.source.headSha };
      },
      visibilityLookup: async () => 'PUBLIC',
      repoFileProviderFactory: () => fixtureProvider,
      zoektGrounding: async () => ({ reason: 'qualification uses only pinned fixture source' }),
    });
  } catch (error) {
    workerError = error;
  }
  if (request.arm === 'preflight-source-coverage-control' && sourceCoverageControlSatisfied
    && workerError instanceof Error && workerError.message === 'normal_engine_qualification_required_source_window_unavailable') {
    workerError = undefined;
  }
  if (request.arm === 'repair-head-history-unavailable' && request.fixture.bundleVersion === 'WS5ExternalNormalBundle.v2'
    && requiredHistoryControlSatisfied && workerError instanceof Error
    && workerError.message === 'normal_engine_qualification_required_history_unavailable_transport') {
    workerError = undefined;
  }
  assertNoAmbientComposedEngineOverrides();

  if ((request.phase === 'repair-head' || request.phase === 'same-head-recheck')
    && !(request.fixture.bundleVersion === 'WS5ExternalNormalBundle.v2'
      && request.arm === 'repair-head-history-unavailable' && requiredHistoryControlSatisfied)) {
    const lineage = request.historyLineage;
    if (!lineage) throw new Error('normal_engine_qualification_history_lineage_missing');
    const mode = request.arm === 'repair-head-empty-history' ? 'empty-context' as const
      : request.arm === 'repair-head-history-unavailable' ? 'history-unavailable' as const
        : request.arm === 'repair-head-verifier-unavailable' ? 'verifier-unavailable' as const
          : request.arm === 'adjudicator-recheck' ? 'adjudicator-recheck' as const : 'history' as const;
    const binding = qualificationHistoryBinding(request, workerEnv);
    const identity: NormalEngineQualificationVerificationSetIdentity = {
      runId: request.runId,
      sourceRunId: mode === 'empty-context' ? null : request.historyRunId,
      sequenceId: lineage.sequenceId,
      sourceCaseId: lineage.sourceCaseId,
      repairCaseId: request.phase === 'same-head-recheck' ? lineage.sourceCaseId : lineage.repairCaseId,
    };
    try {
      const verificationSet = await store.finalizeVerificationSet(identity, mode, binding);
      if (request.arm === 'adjudicator-recheck' && verificationSet.status !== 'complete') {
        throw new Error('qualification adjudicator recheck verification set is incomplete');
      }
    } catch (error) {
      workerError ||= error;
    }
  }

  let canonicalEvidenceSha256: string | null = null;
  let gateDecision: ReturnType<typeof evaluateReviewGate>;
  let gateDecisionSha256: string;
  let canonicalEvidenceValid = false;
  let canonicalReviewEvidence: NonNullable<NormalEngineQualificationReceipt['canonicalReviewEvidence']> | null = null;
  if (completion && workerReceipt
    && completion.result.groundedReview?.version === GROUNDED_REVIEW_RECEIPT_V2_VERSION
    && completion.result.groundedReview.semanticsVersion === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
    && completion.result.groundedReview.verification.semanticsVersion === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION) {
    const coordinates = {
      runId: completion.runId, repositoryId: completion.repositoryId, owner: completion.owner, repo: completion.repo,
      prNumber: completion.prNumber, headSha: completion.headSha, baseSha: completion.baseSha,
      policyDigest: completion.policyDigest, configDigest: completion.configDigest,
      executionAttempt: completion.executionAttempt,
    };
      const contract: TrustedReviewCoverageContract = {
      expectedCoordinates: coordinates,
      expectedPersonaIds: prepared.config.personas.filter((persona) => persona.enabled).map((persona) => persona.id),
      reviewEngine: 'composed', reviewDecisionPolicy: REVIEW_SEVERITY_POLICY_V2,
      composedEffectiveConfiguration: preparedEffectiveConfiguration,
      groundedVerifierRouting: { primaryModel: primaryVerifierModel,
        ...(configuredAdjudicatorModel ? { disputedBlockerAdjudicatorModel: configuredAdjudicatorModel } : {}) },
      composedChangedPaths: effectiveChangedPaths,
      composedMaxTasks: resolveComposedMaxTasks(prepared.config.composed?.max_tasks),
      changedFiles: parsedDiff.files,
      coverageComplete: sourceCoverageComplete,
      quorumSatisfied: workerReceipt.coverage.quorumSatisfied,
    };
    const derived = deriveCanonicalWorkerReviewEvidence(completion, contract);
    canonicalEvidenceValid = derived.valid;
    canonicalEvidenceSha256 = derived.valid ? sha256(canonicalJson({ canonical: derived.canonical, evidence: derived.evidence })) : null;
    if (derived.valid) {
      const verificationOutcomes = completion.result.groundedReview.verification.outcomes;
      canonicalReviewEvidence = {
        decisionClassification: derived.evidence.reviewDecision?.classification ?? 'INCOMPLETE_REVIEW',
        counts: { p0Count: derived.evidence.p0Count, p1Count: derived.evidence.p1Count,
          p2Count: derived.evidence.p2Count, p3Count: derived.canonical.metrics.p3Count,
          nitCount: derived.canonical.metrics.nitCount },
        coverageComplete: derived.evidence.coverageComplete,
        quorumSatisfied: derived.evidence.quorumSatisfied,
        blockingFindings: (derived.evidence.blockingFindings ?? []).map((finding) => {
          const verified = verificationOutcomes.find((outcome) => outcome.fingerprint === finding.fingerprint);
          const scope = verified?.evidence && 'scopeDecision' in verified.evidence ? verified.evidence.scopeDecision : undefined;
          const reviewIdentity = scope?.reviewIdentity ? { repository: scope.reviewIdentity.repository,
            baseSha: scope.reviewIdentity.baseSha, headSha: scope.reviewIdentity.headSha } : null;
          const verifierEvidence = verified?.evidence && 'citations' in verified.evidence
            && 'sourceWindowManifestDigest' in verified.evidence ? verified.evidence : undefined;
          const citationEvidence = verifierEvidence ? {
            sourceWindowManifestDigest: verifierEvidence.sourceWindowManifestDigest,
            usedCitationIds: verifierEvidence.usedCitationIds,
            citations: verifierEvidence.citations.map((citation) => ({ id: citation.id, path: citation.path,
              repository: citation.repository, side: citation.side, revisionSha: citation.revisionSha,
              headSha: citation.headSha, baseSha: citation.baseSha, sourceDigest: citation.sourceDigest,
              window: citation.window ? { id: citation.window.id, role: citation.window.role,
                startLine: citation.window.startLine, endLine: citation.window.endLine,
                windowSha256: citation.window.windowSha256, fullContentSha256: citation.window.fullContentSha256,
                regionDigest: citation.window.regionDigest } : null })),
          } : null;
          return { fingerprintSha256: sha256(finding.fingerprint), severity: finding.severity, path: finding.path,
            line: finding.line, title: finding.title, claim: finding.body, blockerEvidence: finding.blockerEvidence,
            verificationStatus: verified?.status ?? 'unavailable', causalScope: scope?.causalScope ?? 'unproven',
            sourceReviewIdentitySha256: reviewIdentity ? sha256(canonicalJson(reviewIdentity)) : null,
            reviewIdentity,
            scopeEvidenceSha256: scope?.evidenceDigest ?? null,
            blockerEvidenceSha256: sha256(canonicalJson(finding.blockerEvidence)), citationEvidence };
        }),
      };
    }
    const candidate = { repositoryId: input.source.repository.repositoryId, prNumber: input.source.prNumber,
      headSha: input.source.headSha, baseSha: input.source.baseSha, policyDigest: request.policy.policyDigest };
    gateDecision = evaluateReviewGate({ candidate, current: { ...candidate, open: true, draft: false },
      ...(derived.valid ? { evidence: derived.evidence } : {}) });
    gateDecisionSha256 = sha256(canonicalJson(gateDecision));
  } else {
    const candidate = { repositoryId: input.source.repository.repositoryId, prNumber: input.source.prNumber,
      headSha: input.source.headSha, baseSha: input.source.baseSha, policyDigest: request.policy.policyDigest };
    gateDecision = evaluateReviewGate({ candidate, current: { ...candidate, open: true, draft: false } });
    gateDecisionSha256 = sha256(canonicalJson(gateDecision));
  }
  const workerCompletionSha256 = completion ? sha256(canonicalJson(completion)) : null;
  let composedResourcesStatus: NormalEngineQualificationReceipt['composedResourcesStatus'] = 'unavailable';
  let composedResourcesPath: string | null = null;
  let composedResourcesSha256: string | null = null;
  let composedResourcesUnavailableReason: NormalEngineQualificationReceipt['composedResourcesUnavailableReason'] = completion
    ? 'resource-evidence-unavailable' : 'worker-completion-unavailable';
  let composedResourcesComplete = false;
  const rawComposedResources = completion?.result.composedResources;
  if (rawComposedResources !== undefined) {
    const parsedResources = composedRuntimeResourcesSchema.safeParse(rawComposedResources);
    if (!parsedResources.success || parsedResources.data.stage !== 'worker_completion') {
      composedResourcesUnavailableReason = 'resource-evidence-invalid';
    } else {
      try {
        const persistedResources = await (dependencies.persistComposedResources || persistNormalEngineQualificationComposedResources)(
          parsedResources.data, request.runId, request.phase, request.fixture.caseId,
        );
        composedResourcesStatus = 'captured';
        composedResourcesPath = persistedResources.path;
        composedResourcesSha256 = persistedResources.sha256;
        composedResourcesUnavailableReason = null;
      } catch (error) {
        composedResourcesUnavailableReason = 'resource-sidecar-persistence-failed';
        workerError ||= error;
      }
      const expectedConfiguration = prepared.config.review_configuration_receipt;
      const resourceBudget = parsedResources.data.budget;
      composedResourcesComplete = parsedResources.data.engineExecutionState === 'complete'
        && parsedResources.data.coverage.remainingPaths.count === 0
        && resourceBudget.configuredTotalTurns === effectiveComposedLimits.configuredTotalTurns
        && resourceBudget.investigationTurns === effectiveComposedLimits.investigationTurns
        && resourceBudget.verificationReserveTurns === effectiveComposedLimits.verificationReserveTurns
        && parsedResources.data.configDigest.value === request.policy.configDigest
        && expectedConfiguration !== undefined && parsedResources.data.configuration.value !== null
        && canonicalJson(parsedResources.data.configuration.value) === canonicalJson(expectedConfiguration);
    }
  }
  const workerOutcome = projectNormalEngineQualificationOutcomes({
    workerConclusion: workerReceipt?.conclusion,
    workerVerdict: workerReceipt?.verdict,
    workerCoverageComplete: workerReceipt?.coverage.fullPanelComplete === true
      && workerReceipt?.coverage.groundedReviewComplete !== false && composedResourcesComplete,
    gateDecision,
    gateEvidenceValid: canonicalEvidenceValid,
  });
  const calls = attestor.snapshot();
  if (request.arm === 'preflight-source-coverage-control'
    && (!sourceCoverageControlSatisfied || calls.length !== 0 || gateDecision.eligible)) {
    workerError ||= new Error('qualification source coverage fault did not abstain before model calls');
  }
  if (request.arm === 'repair-head-history-unavailable' && request.fixture.bundleVersion === 'WS5ExternalNormalBundle.v2'
    && (!requiredHistoryControlSatisfied || calls.length !== 0 || gateDecision.eligible)) {
    workerError ||= new Error('qualification required history transport failure did not abstain before model calls');
  }
  let providerCapture: NormalEngineProviderCaptureV1 | undefined;
  let providerCaptureStatus: NormalEngineQualificationReceipt['provider']['captureStatus'] = 'unavailable';
  let providerCapturePath: string | null = null;
  let providerCaptureSha256: string | null = null;
  let providerCaptureUnavailableReason: NormalEngineQualificationReceipt['provider']['captureUnavailableReason'] = 'provider-capture-context-unavailable';
  try {
    const observedCapture = attestor.getCapture(providerCaptureBinding);
    const validatedCapture = normalEngineProviderCaptureV1Schema.safeParse(observedCapture);
    if (!validatedCapture.success) {
      providerCaptureUnavailableReason = 'provider-capture-invalid';
      workerError ||= new Error('normal_engine_qualification_provider_capture_invalid');
    } else {
      providerCapture = validatedCapture.data;
      try {
        const persistedCapture = await (dependencies.persistProviderCapture || persistNormalEngineQualificationProviderCapture)(
          providerCapture, providerCaptureBinding,
        );
        providerCaptureStatus = 'captured';
        providerCapturePath = persistedCapture.path;
        providerCaptureSha256 = persistedCapture.sha256;
        providerCaptureUnavailableReason = null;
      } catch (error) {
        providerCaptureUnavailableReason = 'provider-capture-sidecar-persistence-failed';
        workerError ||= error;
      }
    }
  } catch (error) {
    providerCaptureUnavailableReason = 'provider-capture-context-unavailable';
    workerError ||= error;
  }
  const groundedVerification = qualificationGroundedVerification(completion);
  const adjudicatorRoutes = groundedVerification.routeReceipts.filter((row) =>
    row.route.appliedRole === 'disputed-blocker-adjudicator');
  const providerAdjudicatorRequests = providerCapture?.requests.filter((row =>
    availableCaptureValue(row.routeBinding.appliedRole) === 'disputed-blocker-adjudicator')) ?? [];
  const providerAdjudicatorRouteBound = providerCaptureStatus === 'captured' && providerAdjudicatorRequests.length > 0
    && providerAdjudicatorRequests.every((row) =>
      availableCaptureValue(row.routeBinding.findingFingerprint) === authenticatedDisputeSelection?.findingFingerprint
      && availableCaptureValue(row.routeBinding.severity) === 'P1'
      && availableCaptureValue(row.routeBinding.purpose) === 'disputed-blocker-recheck'
      && availableCaptureValue(row.routeBinding.requestedRole) === 'disputed-blocker-adjudicator'
      && availableCaptureValue(row.routeBinding.configuredAlternateModel) === configuredAdjudicatorModel
      && availableCaptureValue(row.routeBinding.selectedModel) === configuredAdjudicatorModel);
  const adjudicatorRecheckControlSatisfied = request.arm !== 'adjudicator-recheck' || (
    authenticatedDisputeSelection !== null && adjudicatorRoutes.length === 1
      && adjudicatorRoutes[0]?.findingFingerprint === authenticatedDisputeSelection.findingFingerprint
      && adjudicatorRoutes[0]?.path === authenticatedDisputeSelection.path
      && adjudicatorRoutes[0]?.status !== 'insufficient'
      && adjudicatorRoutes[0]?.route.purpose === 'disputed-blocker-recheck'
      && adjudicatorRoutes[0]?.route.selectedModel === configuredAdjudicatorModel
      && adjudicatorRoutes[0]?.route.configuredAlternateModel === configuredAdjudicatorModel
      && groundedVerification.evidenceSemanticsVersion === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
      && groundedVerification.coverageComplete === true && canonicalEvidenceValid && calls.length > 0
      && providerAdjudicatorRouteBound
      && workerOutcome.agreement === 'agreement' && workerOutcome.workerOutcomeClass !== 'incomplete'
      && workerOutcome.gateOutcomeClass !== 'incomplete');
  if (request.arm === 'adjudicator-recheck' && !adjudicatorRecheckControlSatisfied) {
    workerError ||= new Error('qualification adjudicator recheck did not use the exact authenticated route with fresh complete evidence');
  }
  const providerFailureControlSatisfied = request.arm !== 'provider-failure' || (
    providerFailureLogicalCalls === 1 && providerFailurePhysicalRequests === 1 && calls.length === 1
      && calls[0]?.httpStatus === 401 && calls[0]?.fetchFailureClass === 'http_error'
      && providerCaptureStatus === 'captured' && providerCapture?.requests.length === 1
      && availableCaptureValue(providerCapture.requests[0]!.httpStatus) === 401
      && availableCaptureValue(providerCapture.requests[0]!.fetchFailureClass) === 'http_error'
      && workerOutcome.workerOutcomeClass === 'incomplete' && workerOutcome.gateOutcomeClass === 'incomplete');
  if (request.arm === 'provider-failure' && !providerFailureControlSatisfied) {
    workerError ||= new Error('qualification provider-failure control did not observe exactly one Bifrost 401 with incomplete worker and Gate outcomes');
  }
  const resourceExhaustion = request.arm === 'resource-exhaustion' ? {
    status: resourceExhaustionBlockedPhysicalAttempts > 0 ? 'observed' as const : 'not_observed' as const,
    physicalRequestCap: 1 as const,
    logicalCompletionAttempts: resourceExhaustionLogicalCalls,
    physicalRequests: resourceExhaustionPhysicalRequests,
    blockedPhysicalRequestAttempts: resourceExhaustionBlockedPhysicalAttempts,
    firstResponseHttpStatus: resourceExhaustionFirstResponseHttpStatus,
    firstLogicalCompletionSucceeded: (() => {
      const firstRequest = providerCapture?.requests.slice().sort((left, right) =>
        left.physicalOrdinal - right.physicalOrdinal)[0];
      if (!firstRequest || firstRequest.status !== 'response_received'
        || firstRequest.httpStatus.availability !== 'available' || firstRequest.httpStatus.value !== 200) return false;
      return calls.some((call) => call.clientRequestIdSha256 === firstRequest.cidSha256
        && call.httpStatus === 200 && call.fetchFailureClass === null);
    })(),
  } : null;
  const resourceExhaustionControlSatisfied = request.arm !== 'resource-exhaustion' || (
    resourceExhaustionPhysicalRequests === 1 && resourceExhaustionBlockedPhysicalAttempts > 0
      && resourceExhaustionFirstResponseHttpStatus === 200
      && resourceExhaustion?.firstLogicalCompletionSucceeded === true
      && providerCaptureStatus === 'captured'
      && providerCapture?.requests.some((row) => row.httpStatus.availability === 'available' && row.httpStatus.value === 200) === true
      && providerCapture.requests.some((row) => row.status === 'fetch_failed'
        && row.fetchFailureClass.availability === 'available' && row.fetchFailureClass.value !== null
        && row.fetchFailureClass.value !== 'http_error') === true
      && workerOutcome.workerOutcomeClass === 'incomplete' && workerOutcome.gateOutcomeClass === 'incomplete');
  if (request.arm === 'resource-exhaustion' && !resourceExhaustionControlSatisfied) {
    workerError ||= new Error('qualification resource-exhaustion control did not observe one successful request, a blocked second physical request, and incomplete worker and Gate outcomes');
  }
  const privateIdentifiers = attestor.privateIdentifiers();
  const sidecar = privateIdentifiers.length > 0
    ? await (dependencies.persistProviderIdentifiers || persistNormalEngineQualificationProviderIdentifiers)(privateIdentifiers, request.runId, request.phase,
      request.fixture.caseId)
    : undefined;
  const completedAt = new Date(now()).toISOString();
  const historySummary = completion?.result.groundedReview?.history;
  const historySource = request.arm === 'repair-head-history-unavailable'
    ? 'unavailable' as const
    : request.historyRunId ? 'isolated-qualification-store' as const
      : request.arm === 'repair-head-empty-history' ? 'empty-qualification-ablation' as const
        : ['p2-only', 'large-crossfile', 'provider-failure', 'resource-exhaustion'].includes(request.arm)
          ? 'empty-qualification-context' as const : 'unavailable' as const;
  const qualificationReceipt: NormalEngineQualificationReceipt = {
    schemaVersion: 'ReviewYetiNormalQualification.v1',
    purpose: 'normal-engine-qualification',
    runId: request.runId,
    arm: request.arm,
    phase: request.phase,
    target: {
      kind: 'public-synthetic-fixture',
      repositoryId: input.source.repository.repositoryId,
      repository: `${input.source.repository.owner}/${input.source.repository.repo}`,
      prNumber: input.source.prNumber,
      caseId: request.fixture.caseId,
      bundleVersion: request.fixture.bundleVersion,
      bundleSha256: request.fixture.bundleSha256,
      inputSha256: request.fixture.inputSha256,
      baseSha: input.source.baseSha,
      headSha: input.source.headSha,
      diffSha256,
    },
    runtime: {
      sourceRevision: request.runtime.sourceRevision,
      workerImageDigest: request.runtime.workerImageDigest,
      runtimeManifestSha256: request.runtime.runtimeManifestSha256,
    },
    policy: {
      targetRepository: request.policy.targetRepository,
      selectionPurpose: request.policy.selectionPurpose,
      configurationVariant: request.configurationVariant,
      source: {
        repositoryId: request.policy.sourceRepositoryId,
        owner: request.policy.sourceOwner, repo: request.policy.sourceRepo, ref: request.policy.sourceRef,
        path: request.policy.sourcePath, contentSha256: request.policy.sourceContentSha256,
      },
      effectivePolicyDigest: request.policy.policyDigest,
      effectiveConfigDigest: request.policy.configDigest,
      groundedEvidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
      disputedBlockerAdjudicator: disputedBlockerAdjudicatorPolicy,
      engine: 'composed', severityPolicy: 'review-yeti-severity.v2',
    },
    history: {
      purpose: 'normal-engine-qualification-history',
      source: historySource,
      loadStatus: historySummary?.status ?? 'unavailable',
      snapshotIdSha256: historySummary?.snapshotId ? sha256(historySummary.snapshotId) : null,
      contextDigest: historySummary?.contextDigest ?? null,
      parentRunIdSha256: request.historyRunId ? sha256(request.historyRunId) : null,
      authenticatedDisputeSelection,
    },
    outcome: {
      ...workerOutcome,
      workerCompletionSha256,
      canonicalEvidenceSha256,
      gateDecisionSha256,
    },
    canonicalReviewEvidence,
    ...(request.arm === 'preflight-source-coverage-control' ? { preflight: {
      control: 'source-coverage-unavailable' as const, sourceCoverage: 'unavailable' as const,
      withheldPath: 'src/modules/module-01.ts' as const, physicalClientCalls: 0 as const,
    } } : request.arm === 'repair-head-history-unavailable' && request.fixture.bundleVersion === 'WS5ExternalNormalBundle.v2'
      && requiredHistoryControlSatisfied ? { preflight: {
        control: 'required-history-unavailable-transport' as const, historyStatus: 'unavailable' as const,
        historyFailureClass: 'transport' as const, historySourceRunIdSha256: sha256(request.historyRunId!),
        physicalClientCalls: 0 as const,
      } } : {}),
    composedLimits: effectiveComposedLimits,
    composedResourcesStatus,
    composedResourcesPath,
    composedResourcesSha256,
    composedResourcesUnavailableReason,
    groundedVerification,
    qualificationControl: request.arm === 'preflight-source-coverage-control' ? 'source-coverage-unavailable'
      : request.arm === 'repair-head-empty-history' ? 'empty-history-ablation'
      : request.arm === 'repair-head-history-unavailable' ? 'history-unavailable'
      : request.arm === 'repair-head-verifier-unavailable' ? 'grounded-verifier-unavailable'
      : request.arm === 'adjudicator-recheck' ? 'authenticated-adjudicator-recheck'
          : request.arm === 'provider-failure' ? 'bifrost-auth-rejection-invalid-inference-key'
            : request.arm === 'resource-exhaustion' ? 'worker-deadline-test-60s-one-physical-request' : 'none',
    provider: {
      identityStatus: normalEngineQualificationProviderIdentityStatus(calls),
      upstreamProviderIdentity: 'unknown',
      exactBifrostLogStatus: 'not_available',
      privateIdentifiersSha256: sidecar?.privateIdentifiersSha256 ?? null,
      captureStatus: providerCaptureStatus,
      capturePath: providerCapturePath,
      captureSha256: providerCaptureSha256,
      captureUnavailableReason: providerCaptureUnavailableReason,
      calls,
    },
    testBudget: {
      profile: testBudgetProfile,
      panelBudgetSeconds,
      maxPhysicalModelRequests: testBudgetProfile === 'bifrost-auth-rejection-30s-one-request'
        || request.arm === 'resource-exhaustion' ? 1 : null,
      terminalDeadlineAt,
      resourceExhaustion,
    },
    publication: emptyPublication(),
    terminal: {
      status: (request.arm === 'provider-failure' && !providerFailureControlSatisfied)
        || (request.arm === 'resource-exhaustion' && !resourceExhaustionControlSatisfied)
        || (request.arm === 'adjudicator-recheck' && !adjudicatorRecheckControlSatisfied) ? 'failed' : workerError
        ? ['repair-head-verifier-unavailable', 'provider-failure', 'resource-exhaustion'].includes(request.arm) ? 'incomplete' : 'failed'
        : (request.arm === 'preflight-source-coverage-control' && sourceCoverageControlSatisfied)
          || (request.arm === 'repair-head-history-unavailable' && request.fixture.bundleVersion === 'WS5ExternalNormalBundle.v2'
            && requiredHistoryControlSatisfied) ? 'incomplete'
          : workerOutcome.gateOutcomeClass === 'incomplete' || workerOutcome.workerOutcomeClass === 'incomplete' ? 'incomplete'
          : composedResourcesComplete ? 'completed' : 'failed',
      startedAt, completedAt,
    },
  };
  if (request.arm === 'repair-introduction' && completion && workerReceipt && canonicalEvidenceSha256) {
    const state = historyStateFromCompletion(request, completion, workerReceipt, disputedBlockerAdjudicatorPolicy,
      canonicalEvidenceSha256, gateDecisionSha256);
    if (state) await store.persistInitial(state);
  }
  try {
    await (dependencies.persistCaseReceipt || persistNormalEngineQualificationReceipt)(qualificationReceipt);
  } catch {
    throw new NormalEngineQualificationReceiptPersistError();
  }
  return qualificationReceipt;
}

function derivePlanRunId(rootRunId: string, descriptorRunId: string): string {
  return `nq_${sha256(`${NORMAL_ENGINE_QUALIFICATION_PLAN_ID}:${rootRunId}:${descriptorRunId}`).slice(0, 32)}`;
}

function planCaseEnvironment(
  env: NodeJS.ProcessEnv,
  step: NormalEngineQualificationPlanStep,
  runId: string,
  historyRunId: string | null,
): NodeJS.ProcessEnv {
  const child = qualificationChildEnvironment(env, step.arm);
  child.REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN = '';
  child.REVIEW_NORMAL_ENGINE_QUALIFICATION_CAPTURE_HOLD = '';
  child.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID = runId;
  child.REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID = step.caseId;
  child.REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM = step.arm;
  child.REVIEW_NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT = step.configurationVariant;
  if (historyRunId) child.REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_RUN_ID = historyRunId;
  else delete child.REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_RUN_ID;
  return child;
}

function perArmReceiptPath(caseRunId: string, receipt: NormalEngineQualificationReceipt): string {
  return `normal-engine-qualification-store/${caseRunId}/${receipt.phase}/${receipt.target.caseId}/receipt.json`;
}

/** Executes only the immutable public plan serially so A history survives into repair and same-head rechecks. */
export async function runNormalEngineQualificationPlan(
  env: NodeJS.ProcessEnv,
  dependencies: NormalEngineQualificationWorkerDependencies = {},
): Promise<NormalEngineQualificationPlanReceipt> {
  const planRequest = parseNormalEngineQualificationPlanRequest(env);
  const plan = parseNormalEngineQualificationPlanDescriptor();
  if (plan.planId !== planRequest.planId || plan.descriptorSha256 !== NORMAL_ENGINE_QUALIFICATION_PLAN_DESCRIPTOR_SHA256
    || plan.configurationVariant !== planRequest.configurationVariant) {
    throw new Error('normal_engine_qualification_plan_identity_mismatch');
  }
  const runtimeManifestPath = String(env.REVIEW_RUNTIME_MANIFEST_PATH || '/app/runtime-manifest.json').trim();
  const runtimeManifestSha256 = await (dependencies.verifyRuntimeManifest || verifyWorkerRuntimeManifest)(runtimeManifestPath);
  if (runtimeManifestSha256 !== planRequest.runtime.runtimeManifestSha256) {
    throw new Error('normal_engine_qualification_runtime_manifest_mismatch');
  }

  const now = dependencies.now || Date.now;
  const startedAt = new Date(now()).toISOString();
  const store = dependencies.historyStore || new NormalEngineQualificationHistoryStore();
  const runIdsByDescriptorId = new Map<string, string>();
  const receiptsByDescriptorId = new Map<string, NormalEngineQualificationReceipt>();
  const caseArtifacts: NormalEngineQualificationPlanReceipt['cases'] = [];
  let failed = false;
  const controller = new AbortController();
  const planDeadline = now() + plan.maxActiveDurationMs;
  const planTimer = setTimeout(() => controller.abort(new Error('qualification plan active budget exhausted')),
    plan.maxActiveDurationMs);
  planTimer.unref?.();
  try {
    for (const step of plan.steps) {
      if (controller.signal.aborted || now() >= planDeadline) { failed = true; break; }
      const runId = derivePlanRunId(planRequest.runId, step.descriptorRunId);
      const historyRunId = step.historySourceDescriptorRunId
        ? runIdsByDescriptorId.get(step.historySourceDescriptorRunId) || null : null;
      if (step.historySourceDescriptorRunId && !historyRunId) { failed = true; break; }
      if (step.arm === 'adjudicator-recheck') {
        const source = receiptsByDescriptorId.get('ws5-sequence-a-v1');
        if (!source || source.terminal.status !== 'completed'
          || source.arm !== 'repair-introduction' || source.target.caseId !== step.caseId
          || source.target.baseSha !== '1fd9256afcf0250975c69410a766629c4d4225ad'
          || source.target.headSha !== '1035dc8db9a222447aa774fd9660c224e5d37655'
          || source.target.inputSha256 !== step.inputSha256
          || source.target.bundleSha256 !== step.bundleSha256
          || source.policy.configurationVariant !== step.configurationVariant
          || source.policy.effectivePolicyDigest !== planRequest.policy.policyDigest
          || source.policy.effectiveConfigDigest !== planRequest.policy.configDigest
          || source.policy.disputedBlockerAdjudicator.state !== 'available'
          || source.policy.disputedBlockerAdjudicator.modelAlias === null
          || source.policy.disputedBlockerAdjudicator.reasoningEffort === null
          || source.runtime.sourceRevision !== planRequest.runtime.sourceRevision
          || source.runtime.workerImageDigest !== planRequest.runtime.workerImageDigest
          || source.runtime.runtimeManifestSha256 !== planRequest.runtime.runtimeManifestSha256
          || source.runId !== historyRunId) {
          failed = true;
          break;
        }
      }
      const childEnv = planCaseEnvironment(env, step, runId, historyRunId);
      let receipt: NormalEngineQualificationReceipt;
      try {
        receipt = await (dependencies.runQualificationCase || runNormalEngineQualificationCase)(childEnv, {
          ...dependencies,
          verifyRuntimeManifest: async () => runtimeManifestSha256,
          historyStore: store,
          signal: controller.signal,
          testBudgetProfile: step.budgetProfile,
        });
      } catch {
        failed = true;
        break;
      }
      const persisted = await (dependencies.persistCaseReceipt || persistNormalEngineQualificationReceipt)(receipt);
      const providerIdentifiersPath = receipt.provider.privateIdentifiersSha256 === null ? null
        : `normal-engine-qualification-store/${runId}/${receipt.phase}/${receipt.target.caseId}`
          + '/provider-identifiers.record/provider-identifiers.json';
      caseArtifacts.push({
        arm: step.arm, caseId: step.caseId, runId, phase: receipt.phase,
        configurationVariant: step.configurationVariant,
        inputSha256: step.inputSha256, bundleSha256: step.bundleSha256,
        receiptPath: perArmReceiptPath(runId, receipt), receiptSha256: persisted.receiptSha256,
        terminalStatus: receipt.terminal.status, budgetProfile: receipt.testBudget.profile,
        providerIdentifiersPath,
        providerIdentifiersSha256: receipt.provider.privateIdentifiersSha256,
        providerCaptureStatus: receipt.provider.captureStatus,
        providerCapturePath: receipt.provider.capturePath,
        providerCaptureSha256: receipt.provider.captureSha256,
        providerCaptureUnavailableReason: receipt.provider.captureUnavailableReason,
        composedResourcesPath: receipt.composedResourcesPath,
        composedResourcesSha256: receipt.composedResourcesSha256,
        composedResourcesStatus: receipt.composedResourcesStatus,
        composedResourcesUnavailableReason: receipt.composedResourcesUnavailableReason,
      });
      runIdsByDescriptorId.set(step.descriptorRunId, runId);
      receiptsByDescriptorId.set(step.descriptorRunId, receipt);
      if (receipt.terminal.status === 'failed'
        || (step.arm === 'adjudicator-recheck' && receipt.terminal.status !== 'completed')) { failed = true; break; }
    }
  } finally {
    clearTimeout(planTimer);
  }

  let historyArtifacts: NormalEngineQualificationPlanReceipt['historyArtifacts'] = [];
  let historyArtifactSetComplete = false;
  const sourceRunId = runIdsByDescriptorId.get('ws5-sequence-a-v1');
  if (sourceRunId) {
    const expectedHistorySteps = plan.steps.filter((step) => ['repair-head-history', 'repair-head-repeat',
      'repair-head-empty-history', 'repair-head-history-unavailable', 'repair-head-verifier-unavailable',
      'adjudicator-recheck'].includes(step.arm));
    const repairRuns = expectedHistorySteps.flatMap((step) => {
      const currentRunId = runIdsByDescriptorId.get(step.descriptorRunId);
      return currentRunId ? [{ runId: currentRunId,
        sourceRunId: step.arm === 'repair-head-empty-history' ? null : sourceRunId,
        sequenceId: 'ws5-repair-sequence-v1', sourceCaseId: 'ws5-sequence-a-v1', repairCaseId: step.caseId }] : [];
    });
    let capturedSourceHistory = false;
    let capturedRepairSets = 0;
    try {
      if (dependencies.historyArtifacts) {
        const artifacts = await dependencies.historyArtifacts({ sourceRunId, repairRuns });
        historyArtifacts.push(...artifacts.map((artifact) => ({
          ...artifact,
          recordPath: `normal-engine-qualification-store/${artifact.recordPath}`,
          sha256Path: `normal-engine-qualification-store/${artifact.sha256Path}`,
        })));
        capturedSourceHistory = historyArtifacts.some((artifact) => artifact.kind === 'history' && artifact.runId === sourceRunId);
        capturedRepairSets = repairRuns.filter((run) => historyArtifacts.some((artifact) =>
          artifact.kind === 'verification-set' && artifact.runId === run.runId)).length;
      } else {
        try {
          const sourceArtifacts = await store.historyArtifactsFor({ runId: sourceRunId,
            sequenceId: 'ws5-repair-sequence-v1', caseId: 'ws5-sequence-a-v1' });
          historyArtifacts.push(...sourceArtifacts.map((artifact) => ({
            ...artifact,
            recordPath: `normal-engine-qualification-store/${artifact.recordPath}`,
            sha256Path: `normal-engine-qualification-store/${artifact.sha256Path}`,
          })));
          capturedSourceHistory = true;
        } catch { /* Keep partial index empty of unverified history records. */ }
        for (const repairRun of repairRuns) {
          try {
            const artifacts = await store.artifactsForRepairRun(repairRun);
            historyArtifacts.push(...artifacts.map((artifact) => ({
              ...artifact,
              recordPath: `normal-engine-qualification-store/${artifact.recordPath}`,
              sha256Path: `normal-engine-qualification-store/${artifact.sha256Path}`,
            })));
            if (artifacts.some((artifact) => artifact.kind === 'verification-set' && artifact.runId === repairRun.runId)) {
              capturedRepairSets += 1;
            }
          } catch { /* A missing/bad set keeps the final manifest incomplete. */ }
        }
      }
    } catch {
      historyArtifacts = [];
    }
    historyArtifactSetComplete = capturedSourceHistory && repairRuns.length === expectedHistorySteps.length
      && capturedRepairSets === expectedHistorySteps.length;
  }
  const completedAt = new Date(now()).toISOString();
  const index: NormalEngineQualificationPlanReceipt = {
    schemaVersion: 'ReviewYetiNormalQualificationPlan.v1',
    purpose: 'normal-engine-qualification-plan',
    planId: planRequest.planId,
    runId: planRequest.runId,
    descriptorSha256: plan.descriptorSha256,
    runtime: planRequest.runtime,
    policy: {
      targetRepository: planRequest.policy.targetRepository,
      selectionPurpose: planRequest.policy.selectionPurpose,
      configurationVariant: planRequest.configurationVariant,
      source: {
        repositoryId: planRequest.policy.sourceRepositoryId,
        owner: planRequest.policy.sourceOwner,
        repo: planRequest.policy.sourceRepo,
        ref: planRequest.policy.sourceRef,
        path: planRequest.policy.sourcePath,
        contentSha256: planRequest.policy.sourceContentSha256,
      },
      effectivePolicyDigest: planRequest.policy.policyDigest,
      effectiveConfigDigest: planRequest.policy.configDigest,
    },
    cases: caseArtifacts,
    historyArtifacts,
    historyArtifactSetComplete,
    caseCount: caseArtifacts.length,
    expectedReceiptCount: plan.steps.length,
    completedReceiptCount: caseArtifacts.filter((artifact) => /^[a-f0-9]{64}$/u.test(artifact.receiptSha256)).length,
    receiptSetComplete: caseArtifacts.length === plan.steps.length,
    publication: emptyPublication(),
    terminal: {
      status: failed || caseArtifacts.length !== plan.steps.length || !historyArtifactSetComplete ? 'failed' : 'completed',
      startedAt, completedAt,
    },
  };
  const persistedPlan = await (dependencies.persistPlanReceipt || persistNormalEngineQualificationPlanReceipt)(index);
  const captureRequested = String(env.REVIEW_NORMAL_ENGINE_QUALIFICATION_CAPTURE_HOLD || '').trim() !== '';
  let captureReady: PersistedNormalEngineQualificationCaptureReady | null = null;
  let captureWaitResult: NormalEngineQualificationCaptureWaitResult | undefined;
  try {
    if (env.REVIEW_NORMAL_ENGINE_QUALIFICATION_CAPTURE_HOLD?.trim() === 'true') {
      try {
        captureReady = await (dependencies.persistCaptureReady || writeNormalEngineQualificationCaptureReady)(
          normalEngineQualificationCaptureArtifactSource(index), persistedPlan, dirname(persistedPlan.planPath));
      } catch {
        captureWaitResult = { requested: true, status: 'invalid_ack', readySha256: null, ackSha256: null,
          artifactSetSha256: null, artifactCount: 0, reason: 'ready-manifest-invalid' };
      }
    }
    if (!captureWaitResult) {
      captureWaitResult = await (dependencies.waitForCapture || waitForNormalEngineQualificationCapture)(env, captureReady);
    }
  } catch {
    captureWaitResult = captureRequested
      ? { requested: true, status: 'invalid_ack', readySha256: captureReady?.sha256 ?? null, ackSha256: null,
        artifactSetSha256: captureReady?.artifactSetSha256 ?? null, artifactCount: captureReady?.artifactCount ?? 0,
        reason: captureReady ? 'ack-invalid' : 'ready-manifest-invalid' }
      : { requested: false, status: 'not_requested', readySha256: null, ackSha256: null,
        artifactSetSha256: null, artifactCount: 0, reason: 'hold-disabled' };
  } finally {
    captureWaitResult ??= { requested: false, status: 'not_requested', readySha256: null, ackSha256: null,
      artifactSetSha256: null, artifactCount: 0, reason: 'hold-disabled' };
    const captureOutcome = {
      schemaVersion: NORMAL_ENGINE_QUALIFICATION_CAPTURE_OUTCOME_VERSION,
      purpose: NORMAL_ENGINE_QUALIFICATION_CAPTURE_OUTCOME_PURPOSE,
      planId: index.planId,
      runId: index.runId,
      planSha256: persistedPlan.planSha256,
      planTerminalStatus: index.terminal.status,
      captureRequested,
      captureStatus: captureWaitResult.status,
      readySha256: captureWaitResult.readySha256,
      ackSha256: captureWaitResult.ackSha256,
      artifactSetSha256: captureWaitResult.artifactSetSha256,
      artifactCount: captureWaitResult.artifactCount,
      captureReason: captureWaitResult.reason,
      completedAt: new Date(now()).toISOString(),
    } as const;
    await (dependencies.persistCaptureOutcome || persistNormalEngineQualificationCaptureOutcome)(
      captureOutcome, dirname(persistedPlan.planPath));
  }
  if (!captureWaitResult) throw new Error('normal_engine_qualification_capture_outcome_missing');
  if (captureRequested && captureWaitResult.status !== 'acknowledged') {
    throw new Error('normal_engine_qualification_capture_failed');
  }
  if (index.terminal.status === 'failed') throw new Error('normal_engine_qualification_plan_incomplete');
  return index;
}

export async function runNormalEngineQualificationWorker(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: NormalEngineQualificationWorkerDependencies = {},
): Promise<void> {
  if (env.REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN !== NORMAL_ENGINE_QUALIFICATION_PLAN_ID) {
    throw new Error('normal_engine_qualification_fixed_plan_required');
  }
  await runNormalEngineQualificationPlan(env, dependencies);
}
