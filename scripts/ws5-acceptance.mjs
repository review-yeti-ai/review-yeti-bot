#!/usr/bin/env node

/**
 * Frozen, finite WS5 panel and post-run scoring gates.
 *
 * Reviewer-visible source inputs, synthetic scoring oracles, and post-run human
 * judgments are loaded through separate paths. This module never sends a model
 * request and never treats unmatched AACR comments as false positives.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  AACR_BENCHMARK,
  V1_BASELINE_RUNTIME_SHA,
  V1_POLICY_PROVENANCE,
  WS5_AACR_MANIFEST_SHA256,
  buildDiscoveryPolicy,
  assertBlindDiscoveryInputCases,
  assertCanonicalHeldoutManifestBytes,
  assertExactCaseIdSet,
  discoveryResourceProfile,
} from './competitive-review-benchmark.mjs';
import { resolveWs5ExternalDataPath, verifyWs5ExternalDataContract } from './ws5-external-data-contract.mjs';

export { WS5_AACR_MANIFEST_SHA256 };

export const WS5_ACCEPTANCE_PLAN_SHA256 = '9644d10aa9247d72eedd73cd358725a7dc8f0ff751b788e38965ba874fa09b9c';
const PLAN_PATH = 'eval-baselines/competitive-review-benchmark/ws5-acceptance-v1.json';
const PROFILE_PATH = 'eval-baselines/competitive-review-benchmark/aacr-ws5-source-profile-v2.json';
const LEGACY_PROFILE_PATH = 'eval-baselines/competitive-review-benchmark/aacr-ws5-source-profile-v1.json';
const MANIFEST_PATH = 'eval-baselines/competitive-review-benchmark/aacr-ws5-heldout-v1.json';
const DISCOVERY_INPUT_PATH = 'eval-baselines/competitive-review-benchmark/ws5-acceptance-inputs/discovery-v2-full-index.json';
const VERIFICATION_INPUT_PATH = 'eval-baselines/competitive-review-benchmark/ws5-acceptance-inputs/verification-v2-full-index.json';
const LEGACY_DISCOVERY_INPUT_PATH = 'eval-baselines/competitive-review-benchmark/ws5-acceptance-inputs/discovery-v1.json';
const LEGACY_VERIFICATION_INPUT_PATH = 'eval-baselines/competitive-review-benchmark/ws5-acceptance-inputs/verification-v1.json';
const NATIVE_OMITTED_POLICY_PATH = 'eval-baselines/competitive-review-benchmark/policy-projections/yeti-v1-native-omitted.json';
const MEDIUM_POLICY_PATH = 'eval-baselines/competitive-review-benchmark/policy-projections/yeti-v1-medium.json';
const LIFECYCLE_DESCRIPTOR_PATH = 'eval-baselines/competitive-review-benchmark/ws5-lifecycle-inputs-v1.json';
const REPAIR_DESCRIPTOR_PATH = 'eval-baselines/competitive-review-benchmark/ws5-repair-sequence-v1/descriptor.json';
const LIVE_ARMS_DESCRIPTOR_PATH = 'eval-baselines/competitive-review-benchmark/ws5-live-arms-v1.json';
const GIT_SHA_RE = /^[a-f0-9]{40}$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/iu;
const IMAGE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const WS5_RESUME_MAX_REQUESTS_PER_CELL = 100;
const CAUSAL_CLASSES = new Set([
  'introduced_defect', 'preexisting_defect', 'nit', 'false_positive', 'unresolved',
]);
const SOURCE_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeRepoPath(root, relativePath) {
  try { return resolveWs5ExternalDataPath(root, relativePath); }
  catch (error) {
    const code = String(error?.message || '');
    throw new Error(code === 'ws5_external_data_path_escape' || code === 'ws5_external_data_path_invalid'
      ? 'panel_artifact_path_escape' : 'panel_artifact_path_invalid');
  }
}

function readPinnedDataJson(dataRoot, relativePath, expectedSha256, reasonCode) {
  if (typeof expectedSha256 !== 'string' || !SHA256_RE.test(expectedSha256)) throw new Error(reasonCode);
  const resolved = resolveWs5ExternalDataPath(dataRoot, relativePath);
  const bytes = fs.readFileSync(resolved);
  if (sha256(bytes) !== expectedSha256) throw new Error(reasonCode);
  try { return { value: JSON.parse(bytes.toString('utf8')), bytes, path: resolved }; }
  catch { throw new Error('panel_artifact_invalid_json'); }
}

function readPinnedRepoJson(sourceRoot, relativePath, expectedSha256, reasonCode) {
  if (typeof expectedSha256 !== 'string' || !SHA256_RE.test(expectedSha256)) throw new Error(reasonCode);
  const resolved = safeRepoPath(sourceRoot, relativePath);
  const bytes = fs.readFileSync(resolved);
  if (sha256(bytes) !== expectedSha256) throw new Error(reasonCode);
  try { return { value: JSON.parse(bytes.toString('utf8')), bytes, path: resolved }; }
  catch { throw new Error('panel_artifact_invalid_json'); }
}

function externalDataContractEntry(binding, relativePath) {
  return binding?.contract?.inputs?.find((entry) => entry.path === relativePath) || null;
}

function assertExternalDataContractEntry(binding, relativePath, role, expectedSha256) {
  const entry = externalDataContractEntry(binding, relativePath);
  if (!entry || entry.role !== role || entry.sha256 !== expectedSha256) {
    throw new Error('ws5_external_data_contract_asset_binding_mismatch');
  }
  return entry;
}

function verifyInputRecord(sourceRoot, record) {
  if (!record || typeof record.caseId !== 'string' || !SHA256_RE.test(record.inputSha256 || '')) {
    throw new Error('synthetic_input_manifest_invalid');
  }
  const bytes = fs.readFileSync(safeRepoPath(sourceRoot, record.inputPath));
  if (sha256(bytes) !== record.inputSha256) throw new Error('synthetic_input_digest_mismatch');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('synthetic_input_invalid_json'); }
  if (value.caseId !== record.caseId) throw new Error('synthetic_input_case_id_mismatch');
  return value;
}

function gitBlobSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([
    Buffer.from(`blob ${bytes.byteLength}\0`, 'utf8'), bytes,
  ])).digest('hex');
}

function verifyFullRevision(revision) {
  if (!revision || !/^[a-f0-9]{40}$/iu.test(revision.commitSha || '')
    || !/^[a-f0-9]{40}$/iu.test(revision.treeSha || '') || !Array.isArray(revision.files)
    || revision.files.length === 0) throw new Error('synthetic_full_revision_snapshot_missing');
  const seenPaths = new Set();
  for (const file of revision.files) {
    if (typeof file.path !== 'string' || path.isAbsolute(file.path)
      || file.path.split('/').some((part) => part === '.' || part === '..')
      || !['100644', '100755'].includes(file.mode) || typeof file.content !== 'string'
      || !SHA256_RE.test(file.sha256 || '') || file.sha256 !== sha256(file.content)
      || !/^[a-f0-9]{40}$/iu.test(file.gitBlobSha || '') || file.gitBlobSha !== gitBlobSha(file.content)
      || seenPaths.has(file.path)) throw new Error('synthetic_full_revision_snapshot_digest_mismatch');
    seenPaths.add(file.path);
  }
  return seenPaths.size;
}

function assertNoWorkerHistoryOrOracle(value, { forbidCandidates = false } = {}) {
  if (Object.hasOwn(value, 'history') || Object.hasOwn(value, 'oracle') || Object.hasOwn(value, 'expectedDecision')
    || (forbidCandidates && Object.hasOwn(value, 'candidates'))
    || (Object.hasOwn(value, 'candidates') && (!Array.isArray(value.candidates) || value.candidates.length > 0))) {
    throw new Error('synthetic_source_input_contains_out_of_band_state');
  }
}

function matchesPerRequestAttestation(attempts, attestation) {
  if (!attestation || attestation.status !== 'verified'
    || attestation.evidenceSource !== 'parent_broker_independent_telemetry'
    || !SHA256_RE.test(attestation.evidenceDigest || '') || !Array.isArray(attempts)
    || !Array.isArray(attestation.requests) || attestation.requests.length !== attempts.length) return false;
  const byOrdinal = new Map(attestation.requests.map((entry) => [entry.localAttemptOrdinal, entry]));
  if (byOrdinal.size !== attempts.length) return false;
  return attempts.every((attempt) => {
    const proof = byOrdinal.get(attempt.localAttemptOrdinal);
    if (!proof || !Number.isSafeInteger(attempt.localAttemptOrdinal) || attempt.localAttemptOrdinal < 1
      || proof.localAttemptOrdinal !== attempt.localAttemptOrdinal
      || (proof.requestIdDigest !== null && !/^[a-f0-9]{16}$/u.test(proof.requestIdDigest))
      || !SHA256_RE.test(proof.evidenceDigest || '')) return false;
    const digests = [...new Set(Array.isArray(attempt.gatewayRequestIdDigests)
      ? attempt.gatewayRequestIdDigests : [])];
    if (digests.length > 1 || digests.some((digest) => !/^[a-f0-9]{16}$/u.test(digest))) return false;
    if (digests.length) {
      if (proof.requestIdDigest !== digests[0]) return false;
    } else if (proof.requestIdDigest !== null) return false;
    if (proof.disposition === 'provider_completed') {
      return proof.requestIdDigest !== null
        && typeof proof.provider === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}$/u.test(proof.provider)
        && typeof proof.servedModel === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}$/u.test(proof.servedModel)
        && (proof.servedEffort === null || proof.servedEffort === undefined
          || /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(proof.servedEffort));
    }
    if (proof.disposition === 'not_relayed_or_provider_completed') {
      return typeof proof.reasonCode === 'string' && /^[a-z0-9_]{1,80}$/u.test(proof.reasonCode);
    }
    return false;
  });
}

/** Load the pinned panel from an explicit external data bundle; sourceRoot remains the Git runner. */
export function loadPinnedAcceptancePlan({
  repoRoot = SOURCE_ROOT,
  dataRoot,
  planPath,
  externalDataContractPath,
  externalDataContractSha256,
} = {}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)
    || typeof planPath !== 'string' || !planPath
    || typeof externalDataContractPath !== 'string' || !path.isAbsolute(externalDataContractPath)
    || typeof externalDataContractSha256 !== 'string' || !SHA256_RE.test(externalDataContractSha256)) {
    throw new Error('ws5_external_data_bundle_required');
  }
  const root = fs.realpathSync(path.resolve(repoRoot));
  if (root !== SOURCE_ROOT) throw new Error('ws5_runner_source_root_mismatch');
  if (planPath !== PLAN_PATH) throw new Error('ws5_external_acceptance_plan_path_invalid');
  const externalBinding = verifyWs5ExternalDataContract({
    sourceRoot: root,
    dataRoot,
    contractPath: externalDataContractPath,
    expectedContractSha256: externalDataContractSha256,
    expectedPlanPath: planPath,
    expectedPlanSha256: WS5_ACCEPTANCE_PLAN_SHA256,
  });
  const planInput = readPinnedDataJson(dataRoot, planPath, WS5_ACCEPTANCE_PLAN_SHA256,
    'ws5_acceptance_plan_digest_mismatch');
  assertExternalDataContractEntry(externalBinding, planPath, 'acceptance-plan', WS5_ACCEPTANCE_PLAN_SHA256);
  const plan = planInput.value;
  const panelSha256 = sha256(planInput.bytes);
  if (plan.schemaVersion !== 'ReviewYetiWS5Acceptance.v1'
    || plan.publicPanel?.datasetSha256 !== AACR_BENCHMARK.sha256) {
    throw new Error('ws5_acceptance_plan_incompatible');
  }

  const manifestPath = plan.publicPanel.manifestPath || MANIFEST_PATH;
  if (manifestPath !== MANIFEST_PATH) throw new Error('ws5_public_manifest_path_mismatch');
  const manifestBytes = fs.readFileSync(safeRepoPath(root, manifestPath));
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== plan.publicPanel.manifestSha256
    || manifestSha256 !== WS5_AACR_MANIFEST_SHA256) throw new Error('ws5_acceptance_manifest_digest_mismatch');
  assertExternalDataContractEntry(externalBinding, manifestPath, 'public-manifest', manifestSha256);
  const { manifest } = assertCanonicalHeldoutManifestBytes(manifestBytes);
  assertExactCaseIdSet(manifest.cases.map((entry) => entry.id), plan.publicPanel.caseIds);
  if (manifest.cases.length !== 7) throw new Error('ws5_acceptance_public_case_count_mismatch');

  const sourceProfilePath = plan.publicPanel.sourceProfilePath || PROFILE_PATH;
  if (sourceProfilePath !== PROFILE_PATH) throw new Error('ws5_source_profile_v2_required');
  const sourceProfileBytes = fs.readFileSync(safeRepoPath(root, sourceProfilePath));
  const sourceProfileSha256 = sha256(sourceProfileBytes);
  if (sourceProfileSha256 !== plan.publicPanel.sourceProfileSha256
    || sourceProfileSha256 !== externalBinding.sourceProfileMapping.v2ProfileSha256) {
    throw new Error('ws5_source_profile_digest_mismatch');
  }
  assertExternalDataContractEntry(externalBinding, sourceProfilePath, 'source-profile-v2', sourceProfileSha256);
  let sourceProfile;
  try { sourceProfile = JSON.parse(sourceProfileBytes.toString('utf8')); }
  catch { throw new Error('ws5_source_profile_invalid_json'); }
  if (sourceProfile.schemaVersion !== 'WS5SourceProfile.v2'
    || sourceProfile.heldoutManifestSha256 !== manifestSha256
    || sourceProfile.cases?.length !== manifest.cases.length
    || sourceProfile.cases.some((entry, index) => entry.caseId !== manifest.cases[index].id
      || entry.diffBaseSha !== manifest.cases[index].diffBaseSha
      || entry.datasetBaseSha !== manifest.cases[index].datasetBaseSha
      || entry.headSha !== manifest.cases[index].headSha
      || entry.preparedCaseSourceOmissions?.length !== 0
      || entry.compare?.status !== 'verified')) {
    throw new Error('ws5_source_profile_identity_or_completeness_mismatch');
  }
  const mapping = externalBinding.sourceProfileMapping;
  const normalization = plan.publicPanel.indexMetadataCanonicalization;
  const discoveryPin = plan.publicPanel.preparedInputs?.discovery;
  const verificationPin = plan.publicPanel.preparedInputs?.verification;
  const legacyInputs = mapping?.legacyPreparedInputs;
  const currentInputs = mapping?.currentPreparedInputs;
  if (mapping?.status !== 'verified'
    || mapping?.v1ProfilePath !== LEGACY_PROFILE_PATH
    || !externalDataContractEntry(externalBinding, LEGACY_PROFILE_PATH)
    || externalDataContractEntry(externalBinding, LEGACY_PROFILE_PATH)?.role !== 'legacy-source-profile'
    || externalDataContractEntry(externalBinding, LEGACY_PROFILE_PATH)?.sha256 !== mapping?.v1ProfileSha256
    || mapping?.normalizationReportPath !== normalization?.reportPath
    || mapping?.normalizationReportSha256 !== normalization?.reportSha256
    || legacyInputs?.discovery?.path !== LEGACY_DISCOVERY_INPUT_PATH
    || legacyInputs?.discovery?.sha256 !== normalization?.oldDiscoveryInputSha256
    || legacyInputs?.verification?.path !== LEGACY_VERIFICATION_INPUT_PATH
    || legacyInputs?.verification?.sha256 !== normalization?.oldVerificationInputSha256
    || currentInputs?.discovery?.path !== DISCOVERY_INPUT_PATH
    || currentInputs?.discovery?.sha256 !== discoveryPin?.sha256
    || currentInputs?.verification?.path !== VERIFICATION_INPUT_PATH
    || currentInputs?.verification?.sha256 !== verificationPin?.sha256) {
    throw new Error('ws5_source_profile_v2_migration_receipt_mismatch');
  }
  for (const legacyInput of Object.values(legacyInputs || {})) {
    if (!legacyInput || typeof legacyInput.path !== 'string'
      || externalDataContractEntry(externalBinding, legacyInput.path)?.role !== 'legacy-prepared-input'
      || externalDataContractEntry(externalBinding, legacyInput.path)?.sha256 !== legacyInput.sha256) {
      throw new Error('ws5_source_profile_v2_migration_receipt_mismatch');
    }
  }
  if (sourceProfile.indexNormalization?.path !== normalization?.reportPath
    || sourceProfile.indexNormalization?.sha256 !== normalization?.reportSha256
    || sourceProfile.indexNormalization?.mode !== 'full_index_blob_ids') {
    throw new Error('ws5_source_profile_v2_normalization_binding_mismatch');
  }

  if (discoveryPin?.path !== DISCOVERY_INPUT_PATH || verificationPin?.path !== VERIFICATION_INPUT_PATH
    || discoveryPin.sha256 !== plan.publicPanel.preparedInputSha256
    || verificationPin.sha256 !== plan.verificationPanel?.preparedInputSha256) {
    throw new Error('ws5_v2_prepared_input_paths_required');
  }
  assertExternalDataContractEntry(externalBinding, discoveryPin.path, 'prepared-input-v2', discoveryPin.sha256);
  assertExternalDataContractEntry(externalBinding, verificationPin.path, 'prepared-input-v2', verificationPin.sha256);
  const childInputPaths = new Set(externalBinding.contract.childVisibleInputIds.map((id) =>
    externalBinding.contract.inputs.find((entry) => entry.id === id)?.path).filter(Boolean));
  if (childInputPaths.size !== 3 || !childInputPaths.has(manifestPath)
    || !childInputPaths.has(discoveryPin.path) || !childInputPaths.has(verificationPin.path)) {
    throw new Error('ws5_external_child_input_set_mismatch');
  }
  const discoveryInput = readPinnedDataJson(dataRoot, discoveryPin.path, discoveryPin.sha256,
    'ws5_prepared_discovery_input_digest_mismatch');
  const verificationInput = readPinnedDataJson(dataRoot, verificationPin.path, verificationPin.sha256,
    'ws5_prepared_verification_input_digest_mismatch');
  const nativePolicyPin = assertExternalDataContractEntry(externalBinding, NATIVE_OMITTED_POLICY_PATH,
    'policy-projection', externalDataContractEntry(externalBinding, NATIVE_OMITTED_POLICY_PATH)?.sha256);
  const mediumPolicyPin = assertExternalDataContractEntry(externalBinding, MEDIUM_POLICY_PATH,
    'policy-projection', externalDataContractEntry(externalBinding, MEDIUM_POLICY_PATH)?.sha256);
  const nativePolicyBytes = fs.readFileSync(safeRepoPath(root, nativePolicyPin.path));
  const mediumPolicyBytes = fs.readFileSync(safeRepoPath(root, mediumPolicyPin.path));
  if (sha256(nativePolicyBytes) !== nativePolicyPin.sha256 || sha256(mediumPolicyBytes) !== mediumPolicyPin.sha256) {
    throw new Error('ws5_policy_projection_digest_mismatch');
  }
  for (const policyBytes of [nativePolicyBytes, mediumPolicyBytes]) {
    try { JSON.parse(policyBytes.toString('utf8')); } catch { throw new Error('ws5_policy_projection_invalid_json'); }
  }
  const preparedDiscovery = discoveryInput.value;
  const preparedVerification = verificationInput.value;
  if (preparedDiscovery.heldoutManifestSha256 !== manifestSha256
    || preparedDiscovery.cases?.length !== 7 || preparedDiscovery.cases.some((entry, index) =>
      entry.caseId !== manifest.cases[index].id || entry.sourceOmissions?.length !== 0)
    || preparedVerification.heldoutManifestSha256 !== manifestSha256
    || preparedVerification.cases?.length !== 28) throw new Error('ws5_prepared_input_panel_identity_mismatch');
  assertBlindDiscoveryInputCases(preparedDiscovery.cases);
  assertBlindDiscoveryInputCases(preparedVerification.cases);
  const verificationIds = plan.verificationPanel.diffLevelCaseIds;
  if (verificationIds.length !== 10 || preparedVerification.cases.filter((entry) => verificationIds.includes(entry.caseId)).length !== 10) {
    throw new Error('ws5_verification_input_case_set_mismatch');
  }

  const lifecycleDescriptorPath = plan.synthetic.lifecycleDescriptorPath || LIFECYCLE_DESCRIPTOR_PATH;
  const lifecycleDescriptorRead = readPinnedRepoJson(root, lifecycleDescriptorPath,
    plan.synthetic.lifecycleDescriptorSha256, 'ws5_lifecycle_descriptor_digest_mismatch');
  const lifecycleDescriptor = lifecycleDescriptorRead.value;
  if (!Array.isArray(lifecycleDescriptor.cases) || lifecycleDescriptor.cases.length !== 8) {
    throw new Error('ws5_lifecycle_case_count_mismatch');
  }
  const syntheticCases = lifecycleDescriptor.cases.map((record) => ({
    ...record,
    inputValue: verifyInputRecord(root, record),
  }));
  assertBlindDiscoveryInputCases(syntheticCases.map((entry) => entry.inputValue));

  const repairDescriptorPath = plan.synthetic.repairDescriptorPath || REPAIR_DESCRIPTOR_PATH;
  const repairDescriptorRead = readPinnedRepoJson(root, repairDescriptorPath,
    plan.synthetic.repairDescriptorSha256, 'ws5_repair_descriptor_digest_mismatch');
  assertExternalDataContractEntry(externalBinding, repairDescriptorPath, 'synthetic-descriptor',
    plan.synthetic.repairDescriptorSha256);
  const repairDescriptor = repairDescriptorRead.value;
  if (!Array.isArray(repairDescriptor.phases) || repairDescriptor.phases.length !== 2) {
    throw new Error('ws5_repair_phase_count_mismatch');
  }
  const repairCases = repairDescriptor.phases.map((record) => ({
    ...record,
    inputValue: (() => {
      assertExternalDataContractEntry(externalBinding, record.inputPath, 'synthetic-worker-input', record.inputSha256);
      return verifyInputRecord(root, record);
    })(),
  }));
  assertBlindDiscoveryInputCases(repairCases.map((entry) => entry.inputValue));
  const repairCommits = repairDescriptor.commitChain || [];
  if (repairCommits.length !== 3 || repairCommits.some((entry, index) => entry.parentSha !== (index ? repairCommits[index - 1].commitSha : null))
    || repairCases[0].inputValue.source.revisions.length !== 2
    || repairCases[1].inputValue.source.revisions.length !== 3
    || repairCases.some((record) => {
      assertNoWorkerHistoryOrOracle(record.inputValue);
      return record.inputValue.source.revisions.some((revision, index) => {
        verifyFullRevision(revision);
        return revision.commitSha !== repairCommits[index]?.commitSha;
      });
    })) throw new Error('ws5_repair_commit_chain_or_full_source_mismatch');

  const largePlan = plan.synthetic.largeCrossfile;
  if (!largePlan || largePlan.descriptorPath !== 'eval-baselines/competitive-review-benchmark/ws5-large-crossfile-v1/descriptor.json') {
    throw new Error('ws5_large_crossfile_plan_missing');
  }
  const largeDescriptor = readPinnedRepoJson(root, largePlan.descriptorPath,
    largePlan.descriptorSha256, 'ws5_large_crossfile_descriptor_digest_mismatch').value;
  assertExternalDataContractEntry(externalBinding, largePlan.descriptorPath, 'synthetic-descriptor',
    largePlan.descriptorSha256);
  const largeInputRecord = {
    caseId: largeDescriptor.caseId,
    inputPath: largeDescriptor.inputPath,
    inputSha256: largeDescriptor.inputSha256,
  };
  assertExternalDataContractEntry(externalBinding, largeInputRecord.inputPath, 'synthetic-worker-input', largeInputRecord.inputSha256);
  const largeCrossfileInput = verifyInputRecord(root, largeInputRecord);
  assertBlindDiscoveryInputCases([largeCrossfileInput]);
  assertNoWorkerHistoryOrOracle(largeCrossfileInput);
  const largeRevisionCommitShas = new Set((largeDescriptor.commitChain || []).map((entry) => entry.commitSha));
  if (largeCrossfileInput.source.revisions?.length !== 2
    || largeCrossfileInput.source.revisions.some((revision) => {
      verifyFullRevision(revision);
      return !largeRevisionCommitShas.has(revision.commitSha);
    })) throw new Error('ws5_large_crossfile_full_source_snapshot_mismatch');
  const changedPatchBytes = largeCrossfileInput.source.patches
    .reduce((sum, entry) => sum + Buffer.byteLength(String(entry.patch || ''), 'utf8'), 0);
  if (largeCrossfileInput.source.changedPaths.length !== largeDescriptor.changedFileCount
    || largeDescriptor.changedFileCount < 20
    || changedPatchBytes < 24_000
    || largeCrossfileInput.source.baseSha !== largeDescriptor.baseSha
    || largeCrossfileInput.source.headSha !== largeDescriptor.headSha) {
    throw new Error('ws5_large_crossfile_fixture_not_within_frozen_size_contract');
  }
  const p2Plan = plan.synthetic.p2DisplaySort;
  const p2Descriptor = readPinnedRepoJson(root, p2Plan.descriptorPath,
    p2Plan.descriptorSha256, 'ws5_p2_descriptor_digest_mismatch').value;
  assertExternalDataContractEntry(externalBinding, p2Plan.descriptorPath, 'synthetic-descriptor',
    p2Plan.descriptorSha256);
  const p2InputRecord = { caseId: p2Descriptor.caseId, inputPath: p2Descriptor.inputPath, inputSha256: p2Descriptor.inputSha256 };
  assertExternalDataContractEntry(externalBinding, p2InputRecord.inputPath, 'synthetic-worker-input', p2InputRecord.inputSha256);
  const p2Input = verifyInputRecord(root, p2InputRecord);
  assertBlindDiscoveryInputCases([p2Input]);
  assertNoWorkerHistoryOrOracle(p2Input, { forbidCandidates: true });
  const p2RevisionShas = new Set((p2Descriptor.commitChain || []).map((entry) => entry.commitSha));
  if (p2Input.source.revisions?.length !== 2 || p2Input.source.revisions.some((revision) => {
    verifyFullRevision(revision);
    return !p2RevisionShas.has(revision.commitSha);
  })) throw new Error('ws5_p2_full_source_snapshot_mismatch');
  const liveArms = readPinnedRepoJson(root, plan.synthetic.normalCanaryArmDescriptorPath,
    plan.synthetic.normalCanaryArmDescriptorSha256, 'ws5_live_arms_descriptor_digest_mismatch').value;
  assertExternalDataContractEntry(externalBinding, plan.synthetic.normalCanaryArmDescriptorPath,
    'live-arm-descriptor', plan.synthetic.normalCanaryArmDescriptorSha256);
  if (liveArms.arms?.length !== 10 || liveArms.execution?.maxCaseRuns !== 10
    || liveArms.arms.some((entry) => !entry.runId || !entry.caseId || !entry.inputId)) {
    throw new Error('ws5_live_arms_descriptor_invalid');
  }
  const assertOraclePin = (oraclePath, oracleSha256) => {
    const entry = externalDataContractEntry(externalBinding, oraclePath);
    if (!entry || entry.role !== 'scorer-oracle' || entry.sha256 !== oracleSha256) {
      throw new Error('ws5_oracle_contract_binding_mismatch');
    }
    return { path: oraclePath, sha256: oracleSha256, visibility: 'post_run_scorer_only' };
  };
  const oraclePath = plan.synthetic.oraclePath;
  const oraclePin = assertOraclePin(oraclePath, plan.synthetic.oracleSha256);
  const repairOraclePin = assertOraclePin(plan.synthetic.repairOraclePath, plan.synthetic.repairOracleSha256);
  const largeOraclePin = assertOraclePin(largePlan.oraclePath, largePlan.oracleSha256);
  const p2OraclePin = assertOraclePin(p2Plan.oraclePath, p2Plan.oracleSha256);
  if (lifecycleDescriptor.cases.some((entry) => entry.inputPath === oraclePath)
    || repairDescriptor.phases.some((entry) => entry.inputPath === oraclePath || entry.inputPath === repairOraclePin.path)
    || largeInputRecord.inputPath === largeOraclePin.path || p2InputRecord.inputPath === p2OraclePin.path
    || liveArms.p2DisplaySortBundle?.inputSha256 !== p2InputRecord.inputSha256) {
    throw new Error('ws5_oracle_must_not_be_a_worker_input');
  }

  const publicLargeDescriptor = structuredClone(largeDescriptor);
  delete publicLargeDescriptor.oraclePath;
  delete publicLargeDescriptor.oracleSha256;
  const publicP2Descriptor = structuredClone(p2Descriptor);
  delete publicP2Descriptor.oraclePath;
  delete publicP2Descriptor.oracleSha256;
  const runtimePlan = structuredClone(plan);
  delete runtimePlan.synthetic.oraclePath;
  delete runtimePlan.synthetic.oracleSha256;
  delete runtimePlan.synthetic.repairOraclePath;
  delete runtimePlan.synthetic.repairOracleSha256;
  delete runtimePlan.synthetic.largeCrossfile.oraclePath;
  delete runtimePlan.synthetic.largeCrossfile.oracleSha256;
  delete runtimePlan.synthetic.p2DisplaySort.oraclePath;
  delete runtimePlan.synthetic.p2DisplaySort.oracleSha256;
  delete runtimePlan.publicPanel.preparedVerificationInputSha256;
  delete runtimePlan.publicPanel.indexMetadataCanonicalization;
  const bundle = {
    rootPath: root,
    externalDataContract: {
      schemaVersion: 'ReviewYetiWS5ExternalDataContract.v1',
      sha256: externalBinding.contractSha256,
      preservedInputCount: externalBinding.preservedInputCount,
      privateInputReceiptSha256: externalBinding.contract.privateInputReceipt.sha256,
      scorerOracleCount: externalBinding.scorerOracleCount,
      childVisibleInputCount: externalBinding.childVisibleInputCount,
      sourceRootGit: externalBinding.sourceRootGit,
      sourceProfileMapping: {
        status: externalBinding.sourceProfileMapping.status,
        v2ProfileSha256: externalBinding.sourceProfileMapping.v2ProfileSha256,
        normalizationReportSha256: externalBinding.sourceProfileMapping.normalizationReportSha256,
      },
    },
    plan: runtimePlan,
    panelSha256,
    manifest,
    manifestSha256,
    sourceProfile,
    preparedDiscovery,
    preparedVerification,
    syntheticCases,
    repairCases,
    liveArms,
    p2DisplaySort: {
      descriptor: publicP2Descriptor,
      inputRecord: p2InputRecord,
      inputValue: p2Input,
    },
    largeCrossfile: {
      descriptor: publicLargeDescriptor,
      inputRecord: largeInputRecord,
      inputValue: largeCrossfileInput,
      changedPatchBytes,
    },
  };
  Object.defineProperties(bundle, {
    dataRootPath: { enumerable: false, value: externalBinding.dataRoot },
    planPath: { enumerable: false, value: externalBinding.planPath },
  });
  Object.defineProperty(bundle, 'pinnedChildInputBytes', {
    enumerable: false,
    value: Object.freeze({
      manifest: Buffer.from(manifestBytes),
      discovery: Buffer.from(discoveryInput.bytes),
      verification: Buffer.from(verificationInput.bytes),
      policyProjections: {
        native_omitted: Buffer.from(nativePolicyBytes),
        medium: Buffer.from(mediumPolicyBytes),
      },
    }),
  });
  return bundle;
}

export function expectedPublicRunCells(plan) {
  const cases = plan?.publicPanel?.caseIds;
  const arms = plan?.publicRunMatrix?.arms;
  if (!Array.isArray(cases) || !Array.isArray(arms)) throw new Error('ws5_public_run_matrix_missing');
  return arms.flatMap((arm) => {
    if (typeof arm.id !== 'string' || !Array.isArray(arm.caseIds)) throw new Error('ws5_public_run_arm_invalid');
    assertExactCaseIdSet(arm.caseIds, cases);
    return cases.map((caseId) => ({ armId: arm.id, caseId }));
  });
}

/** Expand the frozen four-arm matrix into its one-time serial execution schedule. */
export function createPublicRunCellPlan(plan) {
  const cells = expectedPublicRunCells(plan);
  const expectedCount = plan?.publicRunMatrix?.requiredPublicRunCount;
  if (expectedCount !== 28 || cells.length !== expectedCount) throw new Error('ws5_public_run_cell_count_mismatch');
  return cells.map((cell, index) => {
    const arm = plan.publicRunMatrix.arms.find((entry) => entry.id === cell.armId);
    const limitations = arm?.nativeSourceLimitations?.[cell.caseId] || [];
    if (limitations.length > 0 && (cell.armId !== 'alibaba-open-code-review' || cell.caseId !== 'aacr-cpp-85873')) {
      throw new Error('ws5_unplanned_source_scope_limitation');
    }
    return {
      ordinal: index + 1,
      armId: cell.armId,
      caseId: cell.caseId,
      purpose: arm?.purpose || null,
      runtimeSha: arm?.runtimeSha || null,
      runtimeShaBinding: arm?.runtimeShaBinding || null,
      modelAlias: arm?.modelAlias || null,
      effortProfile: arm?.effortProfile || null,
      verifierMode: arm?.verifierMode || null,
      sourceCommit: arm?.sourceCommit || null,
      binarySha256: arm?.build?.binarySha256 || null,
      execution: limitations.length > 0 ? 'preflight_abstention' : 'model_run',
      noModelDispatch: limitations.length > 0,
      nativeSourceLimitations: limitations.map((entry) => ({ ...entry })),
      qualityScore: null,
    };
  });
}

function assertRootDispatchPreflight(bundle, receipt) {
  const expectedIds = bundle.plan.publicPanel.caseIds;
  const preparedCaseById = new Map(bundle.preparedDiscovery.cases.map((entry) => [entry.caseId, entry]));
  const limitations = bundle.plan.publicRunMatrix.arms.find((entry) => entry.id === 'alibaba-open-code-review')
    ?.nativeSourceLimitations?.['aacr-cpp-85873'];
  if (!receipt || receipt.status !== 'ready_for_root_dispatch'
    || receipt.planSha256 !== bundle.panelSha256
    || receipt.manifestSha256 !== bundle.manifestSha256
    || receipt.preparedInputSha256 !== bundle.plan.publicPanel.preparedInputSha256
    || JSON.stringify(receipt.sourceCases?.map((entry) => entry.caseId)) !== JSON.stringify(expectedIds)
    || receipt.sourceCases.some((entry) => entry.status !== 'verified' || entry.sourceOmissions?.length !== 0)
    || receipt.alibaba?.status !== 'READY_FOR_PROVIDER_PREFLIGHT_WITH_DECLARED_COMPARATOR_SCOPE_LIMITATION'
    || receipt.alibaba.providerCalls !== 0
    || receipt.alibaba.sourceCompleteCaseCount !== expectedIds.length
    || receipt.alibaba.comparatorScopeUnsupportedCaseCount !== 1
    || JSON.stringify(receipt.alibaba.panelCaseIds) !== JSON.stringify(expectedIds)
    || JSON.stringify(receipt.alibaba.cases?.map((entry) => entry.caseId)) !== JSON.stringify(expectedIds)
    || receipt.alibaba.cases.some((entry) => entry.sourceCachePreflight?.status !== 'verified'
      || entry.changedFileCount !== preparedCaseById.get(entry.caseId)?.changedFiles?.length
      || !SHA256_RE.test(entry.preview?.changedPathsSha256 || ''))
    || receipt.alibaba.cases.some((entry) => entry.caseId === 'aacr-cpp-85873'
      ? entry.status !== 'source_scope_unsupported'
        || JSON.stringify(entry.preview?.unsupportedExclusions) !== JSON.stringify(limitations)
        || JSON.stringify(entry.preview?.unreviewedPaths) !== JSON.stringify(limitations)
      : entry.status !== 'ready')
    || receipt.provider?.status !== 'ready'
    || receipt.provider.modelAlias !== 'pr-reviewer'
    || receipt.provider.providerCalls !== 0) {
    throw new Error('ws5_root_dispatch_preflight_not_ready');
  }
  return receipt;
}

function assertPublicReceiptFields(value) {
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    for (const [key, child] of Object.entries(entry)) {
      if (/^(?:api_?key|secret|password|authorization|access_?token|gateway_?base_?url|base_?url)$/iu.test(key)) {
        throw new Error('ws5_private_receipt_field_rejected');
      }
      visit(child);
    }
  };
  visit(value);
}

function writeExclusiveJson(filePath, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return sha256(bytes);
}

function safeFailureCode(error) {
  const candidate = String(error?.message || '');
  return /^[a-z0-9_]{1,80}$/u.test(candidate) ? candidate : 'cell_dispatch_failed';
}

const WS5_RESUME_MAX_COMBINED_PHYSICAL_ATTEMPTS = 2_700;

function assertPrivateOwnedPath(filePath, kind, failureCode) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { throw new Error(failureCode); }
  const expectedType = kind === 'directory' ? stat.isDirectory() : stat.isFile();
  const ownerMatches = typeof process.getuid !== 'function' || stat.uid === process.getuid();
  if (!expectedType || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || !ownerMatches
    || (kind === 'file' && stat.nlink !== 1)) throw new Error(failureCode);
  return stat;
}

function readPrivateJsonArtifact(filePath, failureCode) {
  assertPrivateOwnedPath(filePath, 'file', failureCode);
  let bytes;
  try { bytes = fs.readFileSync(filePath); } catch { throw new Error(failureCode); }
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(failureCode); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(failureCode);
  return { bytes, sha256: sha256(bytes), value };
}

function writeExclusiveBytes(filePath, bytes) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function createPublicPreflightInput(acceptance) {
  return {
    planSha256: acceptance.panelSha256,
    manifestSha256: acceptance.manifestSha256,
    preparedInputSha256: acceptance.plan.publicPanel.preparedInputSha256,
    caseIds: [...acceptance.plan.publicPanel.caseIds],
    arms: acceptance.plan.publicRunMatrix.arms.map((arm) => ({
      id: arm.id,
      caseIds: [...arm.caseIds],
      runtimeSha: arm.runtimeSha,
      modelAlias: arm.modelAlias || null,
      nativeSourceLimitations: arm.nativeSourceLimitations || {},
    })),
    preparedDiscovery: acceptance.preparedDiscovery,
  };
}

function summarizePublicPreflight(preflight) {
  return {
    status: preflight.status,
    planSha256: preflight.planSha256,
    manifestSha256: preflight.manifestSha256,
    preparedInputSha256: preflight.preparedInputSha256,
    sourceCaseIds: preflight.sourceCases.map((entry) => entry.caseId),
    allSourceCachesVerified: true,
    alibabaStatus: preflight.alibaba.status,
    alibabaBinarySha256: preflight.alibaba.binary?.sha256 || null,
    alibabaCaseStatuses: preflight.alibaba.cases.map((entry) => ({
      caseId: entry.caseId,
      status: entry.status,
      changedFileCount: entry.changedFileCount,
      sourceCachePreflightStatus: entry.sourceCachePreflight.status,
      changedPathsSha256: entry.preview.changedPathsSha256,
    })),
    alibabaProviderCalls: preflight.alibaba.providerCalls,
    providerStatus: preflight.provider.status,
    providerModelAlias: preflight.provider.modelAlias,
    providerCalls: preflight.provider.providerCalls,
  };
}

function assertPrivateDirectory(directoryPath, failureCode) {
  assertPrivateOwnedPath(directoryPath, 'directory', failureCode);
  let realPath;
  try { realPath = fs.realpathSync(directoryPath); } catch { throw new Error(failureCode); }
  return realPath;
}

function assertOutsideRoots(candidatePath, roots, failureCode) {
  for (const rootPath of roots) {
    if (typeof rootPath !== 'string' || rootPath.length === 0) continue;
    const root = fs.realpathSync(rootPath);
    const relative = path.relative(root, candidatePath);
    if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep))) {
      throw new Error(failureCode);
    }
  }
}

function expectedCellReceiptFile(cell) {
  return `cell-${String(cell.ordinal).padStart(2, '0')}-${cell.armId}-${cell.caseId}.json`;
}

function assertWs5ResumeExecutionBindings(parentEnvelope, currentExecutionBindings) {
  if (!currentExecutionBindings || typeof currentExecutionBindings !== 'object') {
    throw new Error('ws5_resume_execution_binding_mismatch');
  }
  const bindingFields = [
    'runnerSourceRootGit', 'externalDataContractSha256', 'sourceFreeze', 'revisedRuntime',
    'hostExecutionByArm', 'transportProfilesByArm', 'workerImageProvenanceReference', 'workerImageExecution',
  ];
  for (const field of bindingFields) {
    if (!Object.hasOwn(currentExecutionBindings, field)
      || !isDeepStrictEqual(parentEnvelope[field], currentExecutionBindings[field])) {
      throw new Error('ws5_resume_execution_binding_mismatch');
    }
  }
  const hostSource = currentExecutionBindings.hostOrchestratorSource;
  if (!hostSource || !GIT_SHA_RE.test(String(hostSource.commit || ''))
    || !GIT_SHA_RE.test(String(hostSource.tree || '')) || hostSource.worktreeClean !== true) {
    throw new Error('ws5_resume_host_orchestrator_identity_invalid');
  }
  return currentExecutionBindings;
}

function validateResumeBrokerEvidence(evidence, schedule, receiptCounts, expectedCount) {
  if (evidence.schemaVersion !== 'ReviewYetiWS5ParentBrokerEvidence.v1'
    || evidence.visibility !== 'private_receipt'
    || evidence.source !== 'parent_broker_independent_telemetry'
    || !Number.isSafeInteger(evidence.capturedUpstreamAttemptCount)
    || evidence.capturedUpstreamAttemptCount !== expectedCount
    || !Array.isArray(evidence.requests) || !Array.isArray(evidence.unlinkedUpstreamAttempts)
    || evidence.requests.length + evidence.unlinkedUpstreamAttempts.length !== expectedCount
    || !Number.isSafeInteger(evidence.failedExactLogQueryCount) || evidence.failedExactLogQueryCount < 0
    || evidence.successfulResponseMissingRouteIdentityCount !== 0) {
    throw new Error('ws5_resume_parent_broker_evidence_invalid');
  }
  if (evidence.requests.some((row) => row.exactLogStatus !== 'exact_row_matched')
    || evidence.unlinkedUpstreamAttempts.some((row) => !['query_failed', 'not_attested'].includes(row.exactLogStatus)
      || row.captureJoinStatus !== 'attestation_callback_interrupted')
    || evidence.unlinkedUpstreamAttempts.filter((row) => row.exactLogStatus === 'query_failed').length
      !== evidence.failedExactLogQueryCount
    || [...evidence.requests, ...evidence.unlinkedUpstreamAttempts].some((row) =>
      row.requestState !== 'response_received' || row.gatewayHttpStatus !== 200)
    || evidence.requests.some((row) => typeof row.provider !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}$/u.test(row.provider)
      || typeof row.servedModel !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}$/u.test(row.servedModel)
      || (row.servedEffort !== null && row.servedEffort !== undefined
        && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(row.servedEffort)))) {
    throw new Error('ws5_resume_parent_broker_attestation_state_invalid');
  }
  const scheduleByKey = new Map(schedule.map((cell) => [`${cell.armId}\u0000${cell.caseId}`, cell]));
  const physicalRanges = [];
  let nextPhysicalOrdinal = 1;
  for (const cell of schedule) {
    if (cell.execution !== 'model_run') continue;
    const count = receiptCounts.get(cell.ordinal) || 0;
    if (count > 0) {
      physicalRanges.push({ cell, start: nextPhysicalOrdinal, end: nextPhysicalOrdinal + count - 1 });
      nextPhysicalOrdinal += count;
    }
  }
  if (nextPhysicalOrdinal - 1 !== expectedCount) throw new Error('ws5_resume_parent_broker_receipt_count_mismatch');
  const physicalOrdinals = new Set();
  const callerIds = new Set();
  const responseIds = new Set();
  const perCellCounts = new Map();
  const validateRow = (row, unlinked) => {
    let cell = null;
    if (typeof row?.armId === 'string' && typeof row?.caseId === 'string') {
      cell = scheduleByKey.get(`${row.armId}\u0000${row.caseId}`) || null;
    } else if (unlinked && row?.armId === undefined && row?.caseId === undefined) {
      cell = physicalRanges.find((range) => row?.physicalOrdinal >= range.start
        && row?.physicalOrdinal <= range.end)?.cell || null;
    }
    const cellRange = cell && physicalRanges.find((range) => range.cell.ordinal === cell.ordinal);
    if (!cell || !cellRange || !Number.isSafeInteger(row.physicalOrdinal) || row.physicalOrdinal < 1
      || row.physicalOrdinal > expectedCount || physicalOrdinals.has(row.physicalOrdinal)
      || !Number.isSafeInteger(row.localAttemptOrdinal) || row.localAttemptOrdinal < 1
      || row.localAttemptOrdinal !== row.physicalOrdinal - cellRange.start + 1
      || !SHA256_RE.test(row.callerRequestIdSha256 || '')
      || !SHA256_RE.test(row.providerResponseRequestIdSha256 || '')
      || !/^[a-f0-9]{16}$/u.test(row.providerResponseRequestIdDigest || '')
      || !SHA256_RE.test(row.requestBodySha256 || '')) {
      throw new Error('ws5_resume_parent_broker_attempt_invalid');
    }
    if (callerIds.has(row.callerRequestIdSha256) || responseIds.has(row.providerResponseRequestIdDigest)) {
      throw new Error('ws5_resume_parent_broker_duplicate_request_id');
    }
    physicalOrdinals.add(row.physicalOrdinal);
    callerIds.add(row.callerRequestIdSha256);
    responseIds.add(row.providerResponseRequestIdDigest);
    perCellCounts.set(cell.ordinal, (perCellCounts.get(cell.ordinal) || 0) + 1);
  };
  for (const row of evidence.requests) validateRow(row, false);
  for (const row of evidence.unlinkedUpstreamAttempts) validateRow(row, true);
  if (!hasExactOrdinalSet([...physicalOrdinals], expectedCount)) {
    throw new Error('ws5_resume_parent_broker_physical_ordinal_mismatch');
  }
  for (const cell of schedule) {
    if ((perCellCounts.get(cell.ordinal) || 0) !== (receiptCounts.get(cell.ordinal) || 0)) {
      throw new Error('ws5_resume_parent_broker_receipt_count_mismatch');
    }
  }
  return {
    capturedUpstreamAttemptCount: expectedCount,
    matchedExactLogRows: evidence.requests.length,
    failedExactLogQueryCount: evidence.failedExactLogQueryCount,
    unlinkedAttemptCount: evidence.unlinkedUpstreamAttempts.length,
    responseReceivedCount: [...evidence.requests, ...evidence.unlinkedUpstreamAttempts]
      .filter((row) => row.requestState === 'response_received').length,
    http200ResponseCount: [...evidence.requests, ...evidence.unlinkedUpstreamAttempts]
      .filter((row) => row.gatewayHttpStatus === 200).length,
    providerIdentityUnknownCount: evidence.unlinkedUpstreamAttempts.length,
    successfulResponseMissingRouteIdentityCount: evidence.successfulResponseMissingRouteIdentityCount,
    perCellCounts,
  };
}

function readWs5OnceMarker(onceMarkerPath, expectedOnceMarkerSha256) {
  const markerArtifact = readPrivateJsonArtifact(onceMarkerPath, 'ws5_resume_once_marker_invalid');
  if (markerArtifact.sha256 !== expectedOnceMarkerSha256) throw new Error('ws5_resume_once_marker_digest_mismatch');
  const marker = markerArtifact.value;
  if (typeof marker.schemaVersion !== 'string'
    || !/^ReviewYetiWS5PrimaryDiscoveryOneShot\.[A-Za-z0-9.-]+\.v1$/u.test(marker.schemaVersion)
    || typeof marker.createdAt !== 'string' || !Number.isFinite(Date.parse(marker.createdAt))
    || new Date(Date.parse(marker.createdAt)).toISOString() !== marker.createdAt
    || typeof marker.authorization !== 'string' || marker.authorization.length === 0
    || !GIT_SHA_RE.test(marker.hostRunnerCommit || '') || !GIT_SHA_RE.test(marker.engineRuntimeCommit || '')
    || !IMAGE_DIGEST_RE.test(marker.workerImageDigest || '')
    || typeof marker.workerImagePlatform !== 'string'
    || !SHA256_RE.test(marker.launcherSha256 || '') || !SHA256_RE.test(marker.mockTestSha256 || '')
    || !SHA256_RE.test(marker.readinessSha256 || '')) {
    throw new Error('ws5_resume_once_marker_contract_invalid');
  }
  return {
    schemaVersion: marker.schemaVersion,
    createdAt: marker.createdAt,
    hostRunnerCommit: marker.hostRunnerCommit,
    engineRuntimeCommit: marker.engineRuntimeCommit,
    workerImageDigest: marker.workerImageDigest,
    workerImagePlatform: marker.workerImagePlatform,
    launcherSha256: marker.launcherSha256,
    mockTestSha256: marker.mockTestSha256,
    readinessSha256: marker.readinessSha256,
    markerSha256: markerArtifact.sha256,
  };
}

export function readWs5ResumeStartMarker({ onceMarkerPath, expectedOnceMarkerSha256 } = {}) {
  return readWs5OnceMarker(onceMarkerPath, expectedOnceMarkerSha256);
}

function loadWs5ResumeContext(acceptance, options) {
  const schedule = createPublicRunCellPlan(acceptance.plan);
  if (schedule.length !== 28 || schedule.filter((cell) => cell.execution === 'model_run').length !== 27
    || schedule.filter((cell) => cell.execution === 'preflight_abstention').length !== 1) {
    throw new Error('ws5_resume_frozen_schedule_invalid');
  }
  const {
    priorOutputDirectory,
    expectedPriorRun,
    onceMarkerPath,
    expectedOnceMarkerSha256,
    currentExecutionBindings,
    expectedConsumedOrdinals,
    expectedNeverDispatchedOrdinals,
    expectedPriorPhysicalRequestAttempts,
    maxPanelWallMs,
    maxPreflightWallMs,
    maxCellWallMs,
    maxFinalizationWallMs,
    maxForwardedModelRequestsPerCell,
  } = options;
  if (typeof priorOutputDirectory !== 'string' || typeof onceMarkerPath !== 'string'
    || !expectedPriorRun || !SHA256_RE.test(expectedPriorRun.runManifestSha256 || '')
    || !SHA256_RE.test(expectedPriorRun.executionEnvelopeSha256 || '')
    || !SHA256_RE.test(expectedPriorRun.brokerEvidenceSha256 || '')
    || !SHA256_RE.test(expectedOnceMarkerSha256 || '')
    || !Number.isSafeInteger(expectedPriorPhysicalRequestAttempts) || expectedPriorPhysicalRequestAttempts < 0
    || !Number.isSafeInteger(maxPanelWallMs) || !Number.isSafeInteger(maxPreflightWallMs)
    || !Number.isSafeInteger(maxCellWallMs) || !Number.isSafeInteger(maxFinalizationWallMs)
    || !Number.isSafeInteger(maxForwardedModelRequestsPerCell)
    || !Array.isArray(expectedConsumedOrdinals) || !Array.isArray(expectedNeverDispatchedOrdinals)
    || (typeof currentExecutionBindings !== 'function'
      && (!currentExecutionBindings || typeof currentExecutionBindings !== 'object'))) {
    throw new Error('ws5_resume_contract_input_invalid');
  }
  const sourceRoot = fs.realpathSync(SOURCE_ROOT);
  const dataRoot = fs.realpathSync(acceptance.dataRootPath || acceptance.rootPath || SOURCE_ROOT);
  const priorPath = path.resolve(priorOutputDirectory);
  assertPrivateDirectory(priorPath, 'ws5_resume_prior_directory_not_private');
  assertOutsideRoots(priorPath, [sourceRoot, dataRoot], 'ws5_resume_prior_directory_inside_protected_root');

  const manifestArtifact = readPrivateJsonArtifact(path.join(priorPath, 'run-manifest.json'),
    'ws5_resume_parent_manifest_invalid');
  const envelopeArtifact = readPrivateJsonArtifact(path.join(priorPath, 'execution-envelope.json'),
    'ws5_resume_parent_envelope_invalid');
  const brokerArtifact = readPrivateJsonArtifact(path.join(priorPath, 'parent-broker-attestation.json'),
    'ws5_resume_parent_broker_evidence_invalid');
  if (manifestArtifact.sha256 !== expectedPriorRun.runManifestSha256
    || envelopeArtifact.sha256 !== expectedPriorRun.executionEnvelopeSha256
    || brokerArtifact.sha256 !== expectedPriorRun.brokerEvidenceSha256) {
    throw new Error('ws5_resume_parent_artifact_hash_mismatch');
  }
  const manifest = manifestArtifact.value;
  const envelope = envelopeArtifact.value;
  if (manifest.schemaVersion !== 'ReviewYetiWS5RunManifest.v1' || manifest.status !== 'incomplete'
    || manifest.noAutomaticRetries !== true || manifest.expectedCells !== schedule.length
    || manifest.modelRunCells !== 27
    || !Number.isSafeInteger(manifest.preflightAbstentions) || manifest.preflightAbstentions < 0
    || manifest.preflightAbstentions > 1
    || manifest.preflightAbstentions !== manifest.cells?.filter((row) => row.status === 'source_scope_unsupported').length
    || manifest.planSha256 !== acceptance.panelSha256 || manifest.manifestSha256 !== acceptance.manifestSha256
    || manifest.preparedInputSha256 !== acceptance.plan.publicPanel.preparedInputSha256
    || !isDeepStrictEqual(manifest.caseIds, acceptance.plan.publicPanel.caseIds)
    || !Array.isArray(manifest.cells) || manifest.cells.length !== schedule.length
    || !manifest.preflightSummary
    || manifest.preflightSummarySha256 !== sha256(JSON.stringify(manifest.preflightSummary))) {
    throw new Error('ws5_resume_parent_manifest_binding_mismatch');
  }
  if (envelope.schemaVersion !== 'ReviewYetiWS5MatrixExecutionEnvelope.v1'
    || envelope.status !== 'incomplete_global_wall_or_operator_abort'
    || envelope.noAutomaticRetries !== true || envelope.runManifestSha256 !== manifestArtifact.sha256
    || envelope.expectedCells !== 28 || envelope.modelRunCells !== 27
    || envelope.maxConcurrentCells !== 1 || envelope.maxForwardedModelRequestsPerCell !== maxForwardedModelRequestsPerCell
    || envelope.maxPreflightWallMs !== maxPreflightWallMs || envelope.maxCellWallMs !== maxCellWallMs
    || envelope.maxFinalizationWallMs !== maxFinalizationWallMs || envelope.maxPanelWallMs !== maxPanelWallMs
    || envelope.qualityScore !== null || envelope.billedRequestCount !== null || envelope.actualCostUsd !== null) {
    throw new Error('ws5_resume_parent_envelope_binding_mismatch');
  }
  if (typeof currentExecutionBindings !== 'function') {
    assertWs5ResumeExecutionBindings(envelope, currentExecutionBindings);
  }
  if (envelope.maxPanelWallMs !== maxPanelWallMs || envelope.maxPreflightWallMs !== maxPreflightWallMs
    || envelope.maxCellWallMs !== maxCellWallMs || envelope.maxFinalizationWallMs !== maxFinalizationWallMs
    || envelope.maxForwardedModelRequestsPerCell !== maxForwardedModelRequestsPerCell
    || maxForwardedModelRequestsPerCell !== WS5_RESUME_MAX_REQUESTS_PER_CELL) {
    throw new Error('ws5_resume_resource_cap_mismatch');
  }

  const expectedReceiptFiles = [];
  const parentCells = [];
  const receiptCounts = new Map();
  const physicalRequestIds = new Set();
  const consumedOrdinals = [];
  const neverDispatchedOrdinals = [];
  const abstentionOrdinals = [];
  let priorPhysicalAttempts = 0;
  for (let index = 0; index < schedule.length; index += 1) {
    const cell = schedule[index];
    const row = manifest.cells[index];
    const fileName = expectedCellReceiptFile(cell);
    if (!row || row.ordinal !== cell.ordinal || row.armId !== cell.armId || row.caseId !== cell.caseId
      || row.execution !== cell.execution || row.receiptFile !== fileName || row.noAutomaticRetry !== true
      || row.noModelDispatch !== (cell.execution === 'preflight_abstention')
      || !SHA256_RE.test(row.receiptSha256 || '')) {
      throw new Error('ws5_resume_parent_cell_manifest_invalid');
    }
    expectedReceiptFiles.push(fileName);
    const receiptArtifact = readPrivateJsonArtifact(path.join(priorPath, fileName), 'ws5_resume_prior_receipt_invalid');
    if (receiptArtifact.sha256 !== row.receiptSha256) throw new Error('ws5_resume_prior_receipt_digest_mismatch');
    const receipt = receiptArtifact.value;
    if (receipt.armId !== cell.armId || receipt.caseId !== cell.caseId || receipt.status !== row.status
      || receipt.qualityScore !== null || receipt.noAutomaticRetry !== true) {
      throw new Error('ws5_resume_prior_receipt_identity_mismatch');
    }
    assertPublicReceiptFields(receipt);
    let physicalAttempts = 0;
    if (cell.execution === 'preflight_abstention') {
      const modelAttempts = receipt.model?.httpAttempts;
      if (row.noModelDispatch !== true || receipt.noModelDispatch !== true || receipt.providerAttestation !== null
        || (Array.isArray(modelAttempts) && modelAttempts.length !== 0)
        || (Number.isSafeInteger(receipt.model?.callAccounting?.localHttpRequestAttempts)
          && receipt.model.callAccounting.localHttpRequestAttempts !== 0)) {
        throw new Error('ws5_resume_prior_abstention_attempted_model');
      }
      abstentionOrdinals.push(cell.ordinal);
    } else {
      const attempts = receipt.model?.httpAttempts;
      const accounting = receipt.model?.callAccounting;
      if (!Array.isArray(attempts) || !Number.isSafeInteger(accounting?.localHttpRequestAttempts)
        || accounting.localHttpRequestAttempts !== attempts.length || attempts.length > maxForwardedModelRequestsPerCell
        || attempts.some((attempt, attemptIndex) => attempt?.localAttemptOrdinal !== attemptIndex + 1)) {
        throw new Error('ws5_resume_prior_attempt_accounting_invalid');
      }
      physicalAttempts = attempts.length;
      for (const attempt of attempts) {
        const digest = attempt.gatewayRequestIdDigests?.[0];
        if (digest !== undefined) {
          if (!/^[a-f0-9]{16}$/u.test(digest) || physicalRequestIds.has(digest)) {
            throw new Error('ws5_resume_prior_duplicate_request_id');
          }
          physicalRequestIds.add(digest);
        }
      }
      if (physicalAttempts > 0) {
        consumedOrdinals.push(cell.ordinal);
        if (receipt.status !== 'completed' && receipt.status !== 'incomplete') {
          throw new Error('ws5_resume_consumed_receipt_status_invalid');
        }
      } else {
        const failureCode = receipt.outcome?.failureCode || receipt.runnerFailureCode || null;
        if (receipt.status !== 'incomplete' || failureCode !== 'ws5_parent_cancelled'
          || receipt.providerAttestation !== null
          || ![null, 0].includes(accounting.logicalCompletionDispatches)) {
          throw new Error('ws5_resume_zero_attempt_cell_not_proven_undispatched');
        }
        neverDispatchedOrdinals.push(cell.ordinal);
      }
    }
    priorPhysicalAttempts += physicalAttempts;
    receiptCounts.set(cell.ordinal, physicalAttempts);
    parentCells.push({ cell, row, receipt, fileName, receiptBytes: receiptArtifact.bytes, physicalAttempts });
  }
  const expectedFiles = [...expectedReceiptFiles, 'run-manifest.json', 'execution-envelope.json', 'parent-broker-attestation.json'];
  const actualFiles = fs.readdirSync(priorPath).sort();
  if (!isDeepStrictEqual(actualFiles, expectedFiles.sort())) throw new Error('ws5_resume_parent_directory_contents_invalid');

  const brokerAccounting = validateResumeBrokerEvidence(brokerArtifact.value, schedule, receiptCounts,
    expectedPriorPhysicalRequestAttempts);
  if (priorPhysicalAttempts !== expectedPriorPhysicalRequestAttempts
    || brokerAccounting.capturedUpstreamAttemptCount !== priorPhysicalAttempts) {
    throw new Error('ws5_resume_prior_physical_attempt_count_mismatch');
  }
  if (!isDeepStrictEqual(consumedOrdinals, expectedConsumedOrdinals)
    || !isDeepStrictEqual(neverDispatchedOrdinals, expectedNeverDispatchedOrdinals)
    || !isDeepStrictEqual(abstentionOrdinals, schedule.filter((cell) => cell.execution === 'preflight_abstention')
      .map((cell) => cell.ordinal))) {
    throw new Error('ws5_resume_schedule_state_mismatch');
  }

  const onceMarker = readWs5OnceMarker(onceMarkerPath, expectedOnceMarkerSha256);
  if (onceMarker.hostRunnerCommit !== envelope.sourceFreeze?.headCommitSha
    || onceMarker.hostRunnerCommit !== envelope.hostExecutionByArm?.baseline?.runnerSourceCommit
    || onceMarker.hostRunnerCommit !== envelope.hostExecutionByArm?.revised?.runnerSourceCommit
    || onceMarker.hostRunnerCommit !== envelope.hostExecutionByArm?.repeated?.runnerSourceCommit
    || onceMarker.engineRuntimeCommit !== envelope.revisedRuntime?.commit
    || onceMarker.workerImageDigest !== envelope.workerImageProvenanceReference?.imageDigest
    || onceMarker.workerImagePlatform !== envelope.workerImageProvenanceReference?.platform
    || envelope.workerImageProvenanceReference?.sourceCommit !== envelope.revisedRuntime?.commit) {
    throw new Error('ws5_resume_once_marker_binding_mismatch');
  }
  const originalStartedAtMs = Date.parse(onceMarker.createdAt);
  const absoluteDeadlineMs = originalStartedAtMs + maxPanelWallMs;
  if (!Number.isSafeInteger(absoluteDeadlineMs) || Date.now() >= absoluteDeadlineMs) {
    throw new Error('ws5_resume_absolute_deadline_exceeded');
  }
  const parentReceiptLedger = parentCells.map(({ cell, row, physicalAttempts }) => ({
    ordinal: cell.ordinal, armId: cell.armId, caseId: cell.caseId, status: row.status,
    receiptFile: row.receiptFile, receiptSha256: row.receiptSha256, physicalAttempts,
  }));
  const parentReceiptLedgerSha256 = sha256(JSON.stringify(parentReceiptLedger));
  const parentArtifactFiles = expectedFiles.map((name) => {
    const filePath = path.join(priorPath, name);
    const bytes = fs.readFileSync(filePath);
    return { name, sha256: sha256(bytes), bytes };
  });
  const parentRunTreeSha256 = sha256(JSON.stringify(parentArtifactFiles.map(({ name, sha256: digest }) => ({ name, sha256: digest }))));
  return {
    parentPath: priorPath,
    parentManifest: manifest,
    parentManifestSha256: manifestArtifact.sha256,
    parentEnvelope: envelope,
    parentEnvelopeSha256: envelopeArtifact.sha256,
    parentBrokerEvidenceSha256: brokerArtifact.sha256,
    parentBrokerEvidenceSummary: {
      capturedUpstreamAttemptCount: brokerAccounting.capturedUpstreamAttemptCount,
      matchedExactLogRows: brokerAccounting.matchedExactLogRows,
      failedExactLogQueryCount: brokerAccounting.failedExactLogQueryCount,
      unlinkedAttemptCount: brokerAccounting.unlinkedAttemptCount,
      responseReceivedCount: brokerAccounting.responseReceivedCount,
      http200ResponseCount: brokerAccounting.http200ResponseCount,
      providerIdentityUnknownCount: brokerAccounting.providerIdentityUnknownCount,
      successfulResponseMissingRouteIdentityCount: brokerAccounting.successfulResponseMissingRouteIdentityCount,
    },
    parentCells,
    parentCellsByOrdinal: new Map(parentCells
      .filter((entry) => consumedOrdinals.includes(entry.cell.ordinal))
      .map((entry) => [entry.cell.ordinal, entry])),
    parentArtifactFiles,
    parentReceiptLedger,
    parentReceiptLedgerSha256,
    parentRunTreeSha256,
    consumedOrdinals,
    neverDispatchedOrdinals,
    abstentionOrdinals,
    priorPhysicalAttempts,
    onceMarker,
    onceMarkerSha256: onceMarker.markerSha256,
    originalStartedAtMs,
    absoluteDeadlineMs,
    currentExecutionBindings,
    maxForwardedModelRequestsPerCell,
    maxCombinedPhysicalAttempts: WS5_RESUME_MAX_COMBINED_PHYSICAL_ATTEMPTS,
    maxNewAttemptsFromCellLimits: Math.min(
      WS5_RESUME_MAX_COMBINED_PHYSICAL_ATTEMPTS - priorPhysicalAttempts,
      neverDispatchedOrdinals.length * WS5_RESUME_MAX_REQUESTS_PER_CELL,
    ),
  };
}

function copyResumeParentRun(resumeContext, outputPath) {
  const priorDirectory = path.join(outputPath, 'prior');
  fs.mkdirSync(priorDirectory, { recursive: false, mode: 0o700 });
  for (const entry of resumeContext.parentArtifactFiles) {
    writeExclusiveBytes(path.join(priorDirectory, entry.name), entry.bytes);
    if (sha256(fs.readFileSync(path.join(priorDirectory, entry.name))) !== entry.sha256) {
      throw new Error('ws5_resume_parent_copy_digest_mismatch');
    }
  }
  const currentDirectory = path.join(outputPath, 'current');
  fs.mkdirSync(currentDirectory, { recursive: false, mode: 0o700 });
  return { priorDirectory, currentDirectory };
}

function hasExactOrdinalSet(ordinals, count) {
  if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(ordinals) || ordinals.length !== count) return false;
  const unique = new Set(ordinals);
  return unique.size === count && ordinals.every((ordinal) => Number.isSafeInteger(ordinal)
    && ordinal >= 1 && ordinal <= count) && Array.from({ length: count }, (_, index) => index + 1)
    .every((ordinal) => unique.has(ordinal));
}

/** Validate physical-to-logical membership without relying on completion or flatten order. */
function hasExactLogicalAttemptMapping(httpAttempts, dispatches, physicalCount, logicalCount) {
  if (!Array.isArray(httpAttempts) || !Array.isArray(dispatches) || dispatches.length !== logicalCount
    || !hasExactOrdinalSet(dispatches.map((dispatch) => dispatch?.logicalDispatchOrdinal), logicalCount)) return false;
  const attemptsByOrdinal = new Map(httpAttempts.map((attempt) => [attempt?.localAttemptOrdinal, attempt]));
  if (attemptsByOrdinal.size !== physicalCount
    || !hasExactOrdinalSet([...attemptsByOrdinal.keys()], physicalCount)) return false;
  const assignedAttempts = new Set();
  for (const dispatch of dispatches) {
    if (!Number.isSafeInteger(dispatch?.localHttpRequestAttempts) || dispatch.localHttpRequestAttempts < 0
      || !Array.isArray(dispatch.localAttemptOrdinals)
      || dispatch.localAttemptOrdinals.length !== dispatch.localHttpRequestAttempts
      || new Set(dispatch.localAttemptOrdinals).size !== dispatch.localAttemptOrdinals.length) return false;
    for (const ordinal of dispatch.localAttemptOrdinals) {
      const attempt = attemptsByOrdinal.get(ordinal);
      if (!Number.isSafeInteger(ordinal) || !attempt || assignedAttempts.has(ordinal)
        || attempt.logicalDispatchOrdinal !== dispatch.logicalDispatchOrdinal) return false;
      assignedAttempts.add(ordinal);
    }
  }
  return hasExactOrdinalSet([...assignedAttempts], physicalCount);
}

function validatePlannedCellReceipt(cell, rawReceipt) {
  if (!rawReceipt || rawReceipt.armId !== cell.armId || rawReceipt.caseId !== cell.caseId) {
    throw new Error('ws5_cell_receipt_identity_mismatch');
  }
  if (cell.execution === 'preflight_abstention') {
    if (rawReceipt.status !== 'source_scope_unsupported'
      || rawReceipt.preflightAbstention?.reason !== 'unsupported_ext'
      || rawReceipt.preflightAbstention?.noModelDispatch !== true
      || JSON.stringify(rawReceipt.preflightAbstention?.unsupportedPaths) !== JSON.stringify(cell.nativeSourceLimitations)
      || rawReceipt.source?.sourceOmissions?.length !== 0
      || rawReceipt.source?.sourceReadOmissions?.length !== 0
      || rawReceipt.source?.sourceCachePreflight?.status !== 'verified'
      || rawReceipt.providerAttestation !== null
      || rawReceipt.model?.httpAttempts?.length !== 0
      || rawReceipt.model?.callAccounting?.logicalCompletionDispatches !== 0
      || rawReceipt.model?.callAccounting?.localHttpRequestAttempts !== 0
      || rawReceipt.model?.callAccounting?.requestAttemptAccountingMatches !== true
      || rawReceipt.model?.callAccounting?.dispatchAttemptAccountingMatches !== true
      || rawReceipt.qualityScore !== null) {
      throw new Error('ws5_preflight_abstention_receipt_invalid');
    }
  } else if (!['completed', 'incomplete'].includes(rawReceipt.status)) {
    throw new Error('ws5_model_cell_receipt_status_invalid');
  }
  assertPublicReceiptFields(rawReceipt);
  return { ...rawReceipt, ordinal: cell.ordinal, noAutomaticRetry: true, qualityScore: null };
}

/** Execute the frozen panel serially using parent-owned, in-memory adapters. */
/** @param {any} bundle @param {{outputDirectory?: string, authorizeModelDispatch?: boolean,
 * preflightPanel?: (input: any) => Promise<any>, dispatchCell?: (cell: any) => Promise<any>,
 * preflightAbstention?: (cell: any, preflight: any) => Promise<any>}} options */
async function runPublicRunCellsCore(bundle, {
  outputDirectory,
  authorizeModelDispatch = false,
  preflightPanel,
  dispatchCell,
  preflightAbstention,
} = {}, resumeContext = null) {
  const acceptance = bundle?.plan ? bundle : null;
  if (!acceptance || !Array.isArray(acceptance.plan?.publicPanel?.caseIds)) throw new Error('ws5_panel_bundle_missing');
  const cells = createPublicRunCellPlan(acceptance.plan);
  if (cells.some((cell) => cell.execution === 'model_run') && authorizeModelDispatch !== true) {
    throw new Error('ws5_model_dispatch_not_authorized_by_root');
  }
  if (typeof preflightPanel !== 'function') throw new Error('ws5_root_dispatch_preflight_required');
  if (cells.some((cell) => cell.execution === 'model_run') && typeof dispatchCell !== 'function') {
    throw new Error('ws5_parent_dispatch_adapter_required');
  }
  if (cells.some((cell) => cell.execution === 'preflight_abstention') && typeof preflightAbstention !== 'function') {
    throw new Error('ws5_preflight_abstention_adapter_required');
  }

  if (typeof outputDirectory !== 'string' || outputDirectory.length === 0) throw new Error('ws5_run_output_directory_required');
  const projectRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const outputPath = path.resolve(outputDirectory);
  if (resumeContext && fs.existsSync(outputPath)) throw new Error('ws5_resume_output_directory_must_be_new');
  const lexicalOutputRelative = path.relative(projectRoot, outputPath);
  const lexicalOutputIsInsideSource = !lexicalOutputRelative
    || (lexicalOutputRelative !== '..' && !lexicalOutputRelative.startsWith('..' + path.sep));
  if (lexicalOutputIsInsideSource) throw new Error('ws5_run_output_must_be_outside_source_tree');
  fs.mkdirSync(outputPath, { recursive: true, mode: 0o700 });
  const outputStats = fs.lstatSync(outputPath);
  const realOutputPath = fs.realpathSync(outputPath);
  const outputRelative = path.relative(projectRoot, realOutputPath);
  if (!outputStats.isDirectory() || outputStats.isSymbolicLink()
    || !outputRelative || (outputRelative !== '..' && !outputRelative.startsWith('..' + path.sep))) {
    throw new Error('ws5_run_output_must_be_outside_source_tree');
  }
  if (resumeContext && ((outputStats.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && outputStats.uid !== process.getuid()))) {
    throw new Error('ws5_resume_output_directory_not_private');
  }
  if (fs.readdirSync(outputPath).length !== 0) throw new Error('ws5_run_output_directory_not_empty');
  if (resumeContext) copyResumeParentRun(resumeContext, outputPath);

  const publicPreflightInput = createPublicPreflightInput(acceptance);
  let preflight = resumeContext?.preflight || null;
  let preflightFailure = null;
  if (!preflight) {
    try {
      assertBlindDiscoveryInputCases(publicPreflightInput.preparedDiscovery.cases);
      preflight = assertRootDispatchPreflight(acceptance, await preflightPanel(publicPreflightInput));
    } catch (error) {
      preflightFailure = safeFailureCode(error);
    }
  }

  if (preflightFailure) {
    const rows = [];
    const results = [];
    for (const cell of cells) {
      const receipt = {
        ordinal: cell.ordinal,
        armId: cell.armId,
        caseId: cell.caseId,
        status: 'incomplete',
        outcome: { terminalState: 'preflight_aborted', failureCode: preflightFailure },
        noAutomaticRetry: true,
        noModelDispatch: true,
        providerAttestation: null,
        qualityScore: null,
      };
      const fileName = `cell-${String(cell.ordinal).padStart(2, '0')}-${cell.armId}-${cell.caseId}.json`;
      const receiptSha256 = writeExclusiveJson(path.join(outputPath, fileName), receipt);
      const result = { ...cell, ...receipt, execution: cell.execution, noModelDispatch: true,
        receiptFile: fileName, receiptSha256 };
      results.push(result);
      rows.push({ ordinal: cell.ordinal, armId: cell.armId, caseId: cell.caseId,
        execution: cell.execution, status: 'incomplete', receiptFile: fileName, receiptSha256,
        noAutomaticRetry: true, noModelDispatch: true });
    }
    const runManifest = {
      schemaVersion: 'ReviewYetiWS5RunManifest.v1',
      status: 'incomplete',
      planSha256: acceptance.panelSha256,
      manifestSha256: acceptance.manifestSha256,
      preparedInputSha256: acceptance.plan.publicPanel.preparedInputSha256,
      caseIds: [...acceptance.plan.publicPanel.caseIds],
      expectedCells: cells.length,
      modelRunCells: 0,
      preflightAbstentions: 0,
      incompleteCells: cells.length,
      noAutomaticRetries: true,
      providerRoutePreflight: 'not_ready',
      preflightPerformedBeforeFirstModelRunCell: true,
      preflightSummary: { status: 'not_ready', failureCode: preflightFailure, modelDispatches: 0 },
      preflightSummarySha256: sha256(JSON.stringify({ status: 'not_ready', failureCode: preflightFailure, modelDispatches: 0 })),
      localHttpRequestAttempts: null,
      logicalCompletionDispatches: null,
      localAttemptRecordsComplete: false,
      gatewayRelayCount: null,
      providerCompletionCount: null,
      billedRequestCount: null,
      actualCostUsd: null,
      providerAttestation: 'not_started_preflight_failed',
      acceptanceGate: {
        status: 'INCOMPLETE_PREFLIGHT_ABORT',
        expectedCells: cells.length,
        completeCells: 0,
        preflightAbstentionCells: 0,
        accountedCells: 0,
        commonComparatorCaseIds: [],
        commonComparatorDenominator: 0,
        armCompletion: [],
        issues: [`root_preflight_failed:${preflightFailure}`],
        qualityScore: null,
      },
      qualityScore: null,
      cells: rows,
    };
    const manifestSha256 = writeExclusiveJson(path.join(outputPath, 'run-manifest.json'), runManifest);
    return { manifest: runManifest, manifestSha256, cells: results, outputDirectory: outputPath };
  }

  const rows = [];
  const results = [];
  let modelRunCells = resumeContext?.consumedOrdinals.length || 0;
  let preflightAbstentions = 0;
  const currentDirectory = resumeContext ? path.join(outputPath, 'current') : outputPath;
  for (const cell of cells) {
    const consumedReceipt = resumeContext?.parentCellsByOrdinal.get(cell.ordinal);
    if (consumedReceipt) {
      const receiptFile = path.posix.join('prior', consumedReceipt.fileName);
      const result = {
        ...cell,
        ...consumedReceipt.receipt,
        ordinal: cell.ordinal,
        armId: cell.armId,
        caseId: cell.caseId,
        execution: cell.execution,
        noModelDispatch: false,
        noAutomaticRetry: true,
        qualityScore: null,
        receiptFile,
        receiptSha256: consumedReceipt.row.receiptSha256,
      };
      results.push(result);
      rows.push({ ordinal: cell.ordinal, armId: cell.armId, caseId: cell.caseId, execution: cell.execution,
        status: result.status, receiptFile, receiptSha256: consumedReceipt.row.receiptSha256,
        noAutomaticRetry: true, noModelDispatch: false });
      continue;
    }
    let receipt;
    let executionFailure = null;
    try {
      if (cell.execution === 'preflight_abstention') {
        receipt = await preflightAbstention(cell, preflight.alibaba);
      } else {
        modelRunCells += 1;
        receipt = await dispatchCell(cell);
      }
      receipt = validatePlannedCellReceipt(cell, receipt);
    } catch (error) {
      executionFailure = safeFailureCode(error);
      receipt = {
        ordinal: cell.ordinal,
        armId: cell.armId,
        caseId: cell.caseId,
        status: 'incomplete',
        outcome: { terminalState: 'runner_error', failureCode: executionFailure },
        noAutomaticRetry: true,
        noModelDispatch: cell.execution === 'preflight_abstention',
        providerAttestation: null,
        qualityScore: null,
      };
    }
    if (receipt.status === 'source_scope_unsupported') preflightAbstentions += 1;
    const fileName = `cell-${String(cell.ordinal).padStart(2, '0')}-${cell.armId}-${cell.caseId}.json`;
    const receiptFile = resumeContext ? path.posix.join('current', fileName) : fileName;
    const receiptPath = path.join(currentDirectory, fileName);
    const receiptSha256 = writeExclusiveJson(receiptPath, receipt);
    const result = { ...cell, ...receipt, ordinal: cell.ordinal, armId: cell.armId, caseId: cell.caseId,
      execution: cell.execution, noModelDispatch: cell.noModelDispatch, noAutomaticRetry: true,
      qualityScore: null, receiptFile, receiptSha256,
      ...(executionFailure ? { runnerFailureCode: executionFailure } : {}) };
    results.push(result);
    rows.push({ ordinal: cell.ordinal, armId: cell.armId, caseId: cell.caseId, execution: cell.execution,
      status: result.status, receiptFile, receiptSha256,
      noAutomaticRetry: true, noModelDispatch: cell.execution === 'preflight_abstention' });
  }

  const incompleteCells = results.filter((entry) => entry.status === 'incomplete').length;
  const modelRunResults = results.filter((entry) => entry.execution === 'model_run');
  const modelAccounting = modelRunResults.map((entry) => entry.model?.callAccounting);
  const localAccountingComplete = modelAccounting.length === 27 && modelAccounting.every((entry, index) => {
    const physicalCount = entry?.localHttpRequestAttempts;
    const logicalCount = entry?.logicalCompletionDispatches;
    const attempts = modelRunResults[index].model?.httpAttempts;
    const dispatches = entry?.dispatches;
    return Number.isSafeInteger(physicalCount) && physicalCount >= 0
      && Number.isSafeInteger(logicalCount) && logicalCount >= 0
      && Array.isArray(attempts) && attempts.length === physicalCount
      && attempts.every((attempt, attemptIndex) => attempt.localAttemptOrdinal === attemptIndex + 1)
      && entry.requestAttemptAccountingMatches === true && entry.requestProfileAttemptCount === physicalCount
      && entry.dispatchAttemptAccountingMatches === true
      && hasExactLogicalAttemptMapping(attempts, dispatches, physicalCount, logicalCount);
  });
  const acceptanceGate = validatePublicRunCells(acceptance.plan, results);
  const providerAttestationComplete = acceptanceGate.status.startsWith('READY_FOR_BLIND_ADJUDICATION');
  const preflightSummary = summarizePublicPreflight(preflight);
  let resumeManifest = null;
  let resumeManifestSha256 = null;
  let resumePhysicalAccounting = null;
  if (resumeContext) {
    const newPhysicalRequestAttempts = resumeContext.neverDispatchedOrdinals.reduce((sum, ordinal) => {
      const cell = results.find((entry) => entry.ordinal === ordinal);
      const attempts = cell?.model?.httpAttempts;
      if (!Array.isArray(attempts) || attempts.length > resumeContext.maxForwardedModelRequestsPerCell) {
        throw new Error('ws5_resume_new_attempt_accounting_invalid');
      }
      return sum + attempts.length;
    }, 0);
    const cumulativePhysicalRequestAttempts = resumeContext.priorPhysicalAttempts + newPhysicalRequestAttempts;
    if (newPhysicalRequestAttempts > resumeContext.maxNewAttemptsFromCellLimits
      || cumulativePhysicalRequestAttempts > resumeContext.maxCombinedPhysicalAttempts) {
      throw new Error('ws5_resume_physical_request_budget_exceeded');
    }
    const currentReceiptLedger = rows.map((row) => ({
      ordinal: row.ordinal, armId: row.armId, caseId: row.caseId,
      receiptFile: row.receiptFile, receiptSha256: row.receiptSha256, status: row.status,
    }));
    const currentReceiptLedgerSha256 = sha256(JSON.stringify(currentReceiptLedger));
    const newlyDispatchedOrdinals = resumeContext.neverDispatchedOrdinals.filter((ordinal) => {
      const cell = results.find((entry) => entry.ordinal === ordinal);
      return Array.isArray(cell?.model?.httpAttempts) && cell.model.httpAttempts.length > 0;
    });
    const zeroAttemptCandidateOrdinals = resumeContext.neverDispatchedOrdinals
      .filter((ordinal) => !newlyDispatchedOrdinals.includes(ordinal));
    const sourceRoles = {
      hostOrchestrator: {
        role: 'host_orchestrator',
        sourceCommit: resumeContext.currentExecutionBindings.hostOrchestratorSource.commit,
        sourceTree: resumeContext.currentExecutionBindings.hostOrchestratorSource.tree,
        sourceClean: resumeContext.currentExecutionBindings.hostOrchestratorSource.worktreeClean,
      },
      frozenBenchmarkSource: {
        role: 'frozen_benchmark_source',
        commit: resumeContext.currentExecutionBindings.sourceFreeze.headCommitSha,
        tree: resumeContext.currentExecutionBindings.sourceFreeze.gitTreeOid,
      },
      engineRuntime: {
        role: 'engine_runtime',
        commit: resumeContext.currentExecutionBindings.revisedRuntime.commit,
        tree: resumeContext.currentExecutionBindings.revisedRuntime.tree,
      },
      workerImage: {
        role: 'worker_image_provenance_reference_only',
        digest: resumeContext.currentExecutionBindings.workerImageProvenanceReference.imageDigest,
        platform: resumeContext.currentExecutionBindings.workerImageProvenanceReference.platform,
        executedByHostRunner: false,
      },
    };
    const resumeManifestBody = {
      schemaVersion: 'ReviewYetiWS5PartialResumeManifest.v1',
      contractVersion: 'ReviewYetiWS5PartialResume.v1',
      resumeId: crypto.randomUUID(),
      status: incompleteCells > 0 ? 'incomplete' : acceptanceGate.status,
      sourceRoles,
      frozenInputs: {
        planSha256: acceptance.panelSha256,
        manifestSha256: acceptance.manifestSha256,
        preparedInputSha256: acceptance.plan.publicPanel.preparedInputSha256,
        caseIds: [...acceptance.plan.publicPanel.caseIds],
        cellScheduleSha256: sha256(JSON.stringify(cells.map(({ ordinal, armId, caseId, execution }) => ({
          ordinal, armId, caseId, execution,
        })))),
      },
      resourceCaps: {
        maxConcurrentCells: 1,
        maxForwardedModelRequestsPerCell: resumeContext.maxForwardedModelRequestsPerCell,
        maxPreflightWallMs: resumeContext.parentEnvelope.maxPreflightWallMs,
        maxCellWallMs: resumeContext.parentEnvelope.maxCellWallMs,
        maxFinalizationWallMs: resumeContext.parentEnvelope.maxFinalizationWallMs,
        maxPanelWallMs: resumeContext.parentEnvelope.maxPanelWallMs,
        originalStartedAt: new Date(resumeContext.originalStartedAtMs).toISOString(),
        absoluteDeadlineAt: new Date(resumeContext.absoluteDeadlineMs).toISOString(),
        elapsedWallMs: Math.max(0, Date.now() - resumeContext.originalStartedAtMs),
        remainingWallMs: Math.max(0, resumeContext.absoluteDeadlineMs - Date.now()),
      },
      parent: {
        runManifestSchemaVersion: resumeContext.parentManifest.schemaVersion,
        executionEnvelopeSchemaVersion: resumeContext.parentEnvelope.schemaVersion,
        brokerEvidenceSchemaVersion: 'ReviewYetiWS5ParentBrokerEvidence.v1',
        runManifestSha256: resumeContext.parentManifestSha256,
        executionEnvelopeSha256: resumeContext.parentEnvelopeSha256,
        brokerEvidenceSha256: resumeContext.parentBrokerEvidenceSha256,
        brokerEvidenceSummary: resumeContext.parentBrokerEvidenceSummary,
        onceMarkerSha256: resumeContext.onceMarkerSha256,
        receiptLedgerSha256: resumeContext.parentReceiptLedgerSha256,
        runTreeSha256: resumeContext.parentRunTreeSha256,
        copiedDirectory: 'prior',
        artifactFiles: resumeContext.parentArtifactFiles.map(({ name, sha256: digest }) => ({ name, sha256: digest })),
      },
      selection: {
        consumedOrdinals: resumeContext.consumedOrdinals,
        candidateOrdinals: resumeContext.neverDispatchedOrdinals,
        adapterInvokedOrdinals: resumeContext.neverDispatchedOrdinals,
        newlyDispatchedOrdinals,
        zeroAttemptCandidateOrdinals,
        abstentionOrdinals: resumeContext.abstentionOrdinals,
      },
      priorReceipts: resumeContext.parentReceiptLedger,
      currentReceipts: currentReceiptLedger,
      currentReceiptLedgerSha256,
      physicalAccounting: {
        priorPhysicalRequestAttempts: resumeContext.priorPhysicalAttempts,
        newPhysicalRequestAttempts,
        cumulativePhysicalRequestAttempts,
        maximumCombinedPhysicalRequestAttempts: resumeContext.maxCombinedPhysicalAttempts,
        remainingGlobalAttemptCeiling: resumeContext.maxCombinedPhysicalAttempts - resumeContext.priorPhysicalAttempts,
        maximumNewAttemptsFromCellLimits: resumeContext.maxNewAttemptsFromCellLimits,
        localAttemptRecordsComplete: localAccountingComplete,
        gatewayRelayCount: null,
        providerCompletionCount: null,
        billedRequestCount: null,
        actualCostUsd: null,
      },
      qualityScore: null,
    };
    const lineageSha256 = sha256(JSON.stringify({
      parentRunManifestSha256: resumeManifestBody.parent.runManifestSha256,
      parentExecutionEnvelopeSha256: resumeManifestBody.parent.executionEnvelopeSha256,
      parentBrokerEvidenceSha256: resumeManifestBody.parent.brokerEvidenceSha256,
      parentReceiptLedgerSha256: resumeManifestBody.parent.receiptLedgerSha256,
      parentRunTreeSha256: resumeManifestBody.parent.runTreeSha256,
      onceMarkerSha256: resumeManifestBody.parent.onceMarkerSha256,
      currentReceiptLedgerSha256,
    }));
    resumeManifest = { ...resumeManifestBody, lineageSha256 };
    resumeManifestSha256 = writeExclusiveJson(path.join(outputPath, 'resume-manifest.json'), resumeManifest);
    resumePhysicalAccounting = resumeManifest.physicalAccounting;
  }
  const runManifest = {
    schemaVersion: 'ReviewYetiWS5RunManifest.v1',
    status: incompleteCells > 0 ? 'incomplete' : acceptanceGate.status,
    planSha256: acceptance.panelSha256,
    manifestSha256: acceptance.manifestSha256,
    preparedInputSha256: acceptance.plan.publicPanel.preparedInputSha256,
    caseIds: [...acceptance.plan.publicPanel.caseIds],
    expectedCells: cells.length,
    modelRunCells,
    preflightAbstentions,
    incompleteCells,
    noAutomaticRetries: true,
    providerRoutePreflight: 'ready_before_first_run_cell',
    preflightPerformedBeforeFirstModelRunCell: true,
    preflightSummary,
    preflightSummarySha256: sha256(JSON.stringify(preflightSummary)),
    localHttpRequestAttempts: localAccountingComplete
      ? modelAccounting.reduce((sum, entry) => sum + entry.localHttpRequestAttempts, 0) : null,
    logicalCompletionDispatches: localAccountingComplete
      ? modelAccounting.reduce((sum, entry) => sum + entry.logicalCompletionDispatches, 0) : null,
    localAttemptRecordsComplete: localAccountingComplete,
    gatewayRelayCount: null,
    providerCompletionCount: null,
    billedRequestCount: null,
    actualCostUsd: null,
    providerAttestation: providerAttestationComplete ? 'verified_for_all_dispatched_attempts'
      : 'incomplete_or_unattested',
    acceptanceGate: {
      status: acceptanceGate.status,
      expectedCells: acceptanceGate.expectedCells,
      completeCells: acceptanceGate.completeCells,
      preflightAbstentionCells: acceptanceGate.preflightAbstentionCells,
      accountedCells: acceptanceGate.accountedCells,
      commonComparatorCaseIds: acceptanceGate.commonComparatorCaseIds,
      commonComparatorDenominator: acceptanceGate.commonComparatorDenominator,
      armCompletion: acceptanceGate.armCompletion,
      issues: acceptanceGate.issues,
      qualityScore: null,
    },
    qualityScore: null,
    ...(resumeContext ? {
      partialResumeContractVersion: 'ReviewYetiWS5PartialResume.v1',
      partialResumeManifestSha256: resumeManifestSha256,
      ...resumePhysicalAccounting,
    } : {}),
    cells: rows,
  };
  const runManifestSha256 = writeExclusiveJson(path.join(outputPath, 'run-manifest.json'), runManifest);
  return { manifest: runManifest, manifestSha256: runManifestSha256, cells: results, outputDirectory: outputPath,
    ...(resumeContext ? { resumeManifest, resumeManifestSha256 } : {}) };
}

export function runPublicRunCells(bundle, options = {}) {
  return runPublicRunCellsCore(bundle, options, null);
}

function assertFreshResumeOutputDirectory(acceptance, outputDirectory, priorOutputDirectory) {
  if (typeof outputDirectory !== 'string' || outputDirectory.length === 0) {
    throw new Error('ws5_run_output_directory_required');
  }
  const target = path.resolve(outputDirectory);
  if (fs.existsSync(target) || target === path.resolve(priorOutputDirectory)) {
    throw new Error('ws5_resume_output_directory_must_be_new');
  }
  const parent = path.dirname(target);
  const realParent = assertPrivateDirectory(parent, 'ws5_resume_output_parent_not_private');
  const realTarget = path.join(realParent, path.basename(target));
  const projectRoot = fs.realpathSync(SOURCE_ROOT);
  const dataRoot = fs.realpathSync(acceptance.dataRootPath || acceptance.rootPath || SOURCE_ROOT);
  assertOutsideRoots(realTarget, [projectRoot, dataRoot], 'ws5_run_output_must_be_outside_source_tree');
  if (realTarget === fs.realpathSync(priorOutputDirectory)) throw new Error('ws5_resume_output_directory_must_be_new');
}

/**
 * Continue an immutable v1 parent run in a fresh private directory. The caller pins the
 * parent artifact hashes, one-shot marker, prior consumed/undispatched ordinals, and the
 * unchanged runtime bindings; this function never replays a cell with physical attempts.
 * @param {any} bundle
 * @param {Record<string, any>} options
 */
export async function resumePublicRunCells(bundle, options = {}) {
  const acceptance = bundle?.plan ? bundle : null;
  if (!acceptance || !Array.isArray(acceptance.plan?.publicPanel?.caseIds)) throw new Error('ws5_panel_bundle_missing');
  const cells = createPublicRunCellPlan(acceptance.plan);
  if (cells.some((cell) => cell.execution === 'model_run') && options.authorizeModelDispatch !== true) {
    throw new Error('ws5_model_dispatch_not_authorized_by_root');
  }
  if (typeof options.preflightPanel !== 'function') throw new Error('ws5_root_dispatch_preflight_required');
  if (cells.some((cell) => cell.execution === 'model_run') && typeof options.dispatchCell !== 'function') {
    throw new Error('ws5_parent_dispatch_adapter_required');
  }
  if (cells.some((cell) => cell.execution === 'preflight_abstention') && typeof options.preflightAbstention !== 'function') {
    throw new Error('ws5_preflight_abstention_adapter_required');
  }
  const resumeContext = loadWs5ResumeContext(acceptance, options);
  assertFreshResumeOutputDirectory(acceptance, options.outputDirectory, resumeContext.parentPath);

  let preflight;
  try {
    const publicPreflightInput = createPublicPreflightInput(acceptance);
    assertBlindDiscoveryInputCases(publicPreflightInput.preparedDiscovery.cases);
    preflight = assertRootDispatchPreflight(acceptance, await options.preflightPanel(publicPreflightInput));
  } catch {
    throw new Error('ws5_resume_current_preflight_not_ready');
  }
  const preflightSummary = summarizePublicPreflight(preflight);
  if (!isDeepStrictEqual(preflightSummary, resumeContext.parentManifest.preflightSummary)) {
    throw new Error('ws5_resume_preflight_binding_mismatch');
  }
  const suppliedBindings = typeof options.currentExecutionBindings === 'function'
    ? options.currentExecutionBindings() : options.currentExecutionBindings;
  const currentExecutionBindings = suppliedBindings || preflight.executionBindings;
  resumeContext.currentExecutionBindings = assertWs5ResumeExecutionBindings(
    resumeContext.parentEnvelope, currentExecutionBindings,
  );
  resumeContext.preflight = preflight;
  return runPublicRunCellsCore(bundle, options, resumeContext);
}

/** Join parent-broker Bifrost evidence to every physical local HTTP attempt by hashed request ID. */
export function joinGatewayRequestAttestation(localAttempts, gatewayEvidence) {
  const attempts = Array.isArray(localAttempts) ? localAttempts : null;
  const proofs = Array.isArray(gatewayEvidence?.requests) ? gatewayEvidence.requests : null;
  if (gatewayEvidence?.status !== 'verified'
    || gatewayEvidence?.source !== 'parent_broker_independent_telemetry'
    || !SHA256_RE.test(gatewayEvidence?.evidenceDigest || '')) {
    throw new Error('gateway_parent_broker_evidence_unverified');
  }
  if (!attempts || !proofs || attempts.length !== proofs.length) throw new Error('gateway_request_id_join_count_mismatch');
  const attemptOrdinals = new Set();
  const attemptDigests = new Set();
  const proofOrdinals = new Set();
  const proofDigests = new Set();
  const byDigest = new Map();
  const byOrdinal = new Map();
  const attemptsByOrdinal = new Map();
  for (const attempt of attempts) {
    if (!attempt || !Number.isSafeInteger(attempt.localAttemptOrdinal) || attempt.localAttemptOrdinal < 1
      || attemptsByOrdinal.has(attempt.localAttemptOrdinal)) throw new Error('gateway_local_attempt_ordinal_invalid');
    attemptsByOrdinal.set(attempt.localAttemptOrdinal, attempt);
  }
  if (!hasExactOrdinalSet([...attemptsByOrdinal.keys()], attempts.length)) {
    throw new Error('gateway_local_attempt_ordinal_invalid');
  }
  for (const proof of proofs) {
    if (!proof || !SHA256_RE.test(proof.evidenceDigest || '')) throw new Error('gateway_request_evidence_digest_invalid');
    if (proof.requestIdDigest === null) {
      if (!Number.isSafeInteger(proof.localAttemptOrdinal) || proof.localAttemptOrdinal < 1
        || proofOrdinals.has(proof.localAttemptOrdinal)) throw new Error('gateway_request_id_join_mismatch');
      proofOrdinals.add(proof.localAttemptOrdinal);
      byOrdinal.set(proof.localAttemptOrdinal, proof);
      continue;
    }
    if (!/^[a-f0-9]{16}$/u.test(proof.requestIdDigest) || proofDigests.has(proof.requestIdDigest)) {
      throw new Error('gateway_request_id_join_ambiguous');
    }
    proofDigests.add(proof.requestIdDigest);
    if (proof.localAttemptOrdinal !== undefined) {
      if (!Number.isSafeInteger(proof.localAttemptOrdinal) || proof.localAttemptOrdinal < 1
        || proofOrdinals.has(proof.localAttemptOrdinal)) throw new Error('gateway_request_id_join_ambiguous');
      proofOrdinals.add(proof.localAttemptOrdinal);
    }
    byDigest.set(proof.requestIdDigest, proof);
  }

  const usedProofs = new Set();
  const orderedAttempts = [...attemptsByOrdinal.values()].sort((a, b) => a.localAttemptOrdinal - b.localAttemptOrdinal);
  const requests = orderedAttempts.map((attempt) => {
    attemptOrdinals.add(attempt.localAttemptOrdinal);
    const digests = [...new Set(Array.isArray(attempt.gatewayRequestIdDigests)
      ? attempt.gatewayRequestIdDigests : [])];
    if (digests.length > 1 || digests.some((digest) => !/^[a-f0-9]{16}$/u.test(digest))) {
      throw new Error('gateway_request_id_join_ambiguous');
    }
    const digest = digests[0] || null;
    if (digest && attemptDigests.has(digest)) throw new Error('gateway_request_id_join_ambiguous');
    if (digest) attemptDigests.add(digest);
    const proof = digest ? byDigest.get(digest) : byOrdinal.get(attempt.localAttemptOrdinal);
    if (!proof || proof.requestIdDigest !== digest
      || (proof.localAttemptOrdinal !== undefined && proof.localAttemptOrdinal !== attempt.localAttemptOrdinal)) {
      throw new Error('gateway_request_id_join_mismatch');
    }
    if (usedProofs.has(proof)) throw new Error('gateway_request_id_join_ambiguous');
    usedProofs.add(proof);
    if (proof.disposition === 'provider_completed') {
      if (digest === null || typeof proof.provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}$/u.test(proof.provider)
        || typeof proof.servedModel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}$/u.test(proof.servedModel)
        || (proof.servedEffort !== null && proof.servedEffort !== undefined
          && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(proof.servedEffort))) {
        throw new Error('gateway_provider_identity_invalid');
      }
      return {
        localAttemptOrdinal: attempt.localAttemptOrdinal,
        requestIdDigest: digest,
        disposition: proof.disposition,
        provider: proof.provider,
        servedModel: proof.servedModel,
        servedEffort: proof.servedEffort || null,
        evidenceDigest: proof.evidenceDigest,
      };
    }
    if (proof.disposition === 'not_relayed_or_provider_completed'
      && typeof proof.reasonCode === 'string' && /^[a-z0-9_]{1,80}$/u.test(proof.reasonCode)) {
      return {
        localAttemptOrdinal: attempt.localAttemptOrdinal,
        requestIdDigest: digest,
        disposition: proof.disposition,
        reasonCode: proof.reasonCode,
        evidenceDigest: proof.evidenceDigest,
      };
    }
    throw new Error('gateway_request_disposition_invalid');
  });
  if (attemptOrdinals.size !== attempts.length || usedProofs.size !== proofs.length) {
    throw new Error('gateway_request_id_join_ambiguous');
  }
  return {
    status: 'verified',
    evidenceSource: gatewayEvidence.source,
    evidenceDigest: gatewayEvidence.evidenceDigest,
    localAttemptCount: attempts.length,
    matchedGatewayRequestCount: requests.filter((entry) => entry.requestIdDigest !== null).length,
    requests,
    gatewayRelayCount: null,
    providerCompletionCount: null,
    billedRequestCount: null,
    actualCostUsd: null,
  };
}

/**
 * Validate a flattened set of per-arm/per-case receipts. Incomplete source, coverage,
 * provider identity, or missing cells abstain; the function never emits a partial score.
 */
export function validatePublicRunCells(plan, cells) {
  const expected = expectedPublicRunCells(plan);
  const key = (entry) => entry.armId + '\u0000' + entry.caseId;
  const expectedKeys = new Set(expected.map(key));
  const seen = new Set();
  const issues = [];
  let completeCells = 0;
  let preflightAbstentionCells = 0;
  const validCellsByKey = new Map();
  for (const cell of Array.isArray(cells) ? cells : []) {
    const cellKey = key(cell || {});
    if (!expectedKeys.has(cellKey)) {
      issues.push('unexpected_arm_or_case');
      continue;
    }
    if (seen.has(cellKey)) {
      issues.push('duplicate_arm_case_receipt');
      continue;
    }
    seen.add(cellKey);
    const arm = plan?.publicRunMatrix?.arms?.find((entry) => entry.id === cell.armId);
    const declaredLimitations = arm?.nativeSourceLimitations?.[cell.caseId] || [];
    const unsupportedPaths = cell.preflightAbstention?.unsupportedPaths;
    const declaredPreflightAbstention = cell.status === 'source_scope_unsupported'
      && declaredLimitations.length > 0
      && cell.preflightAbstention?.reason === 'unsupported_ext'
      && cell.preflightAbstention?.noModelDispatch === true
      && JSON.stringify(unsupportedPaths) === JSON.stringify(declaredLimitations);
    if (declaredLimitations.length > 0 && !declaredPreflightAbstention) {
      issues.push('declared_comparator_scope_limitation_not_reported');
    }
    if (cell.status === 'source_scope_unsupported' && !declaredPreflightAbstention) {
      issues.push('unplanned_comparator_scope_limitation');
    }
    const omissions = cell.source?.sourceOmissions;
    const preflight = cell.source?.sourceCachePreflight?.status;
    const sourceReadOmissions = cell.source?.sourceReadOmissions;
    const sourceComplete = Array.isArray(omissions) && omissions.length === 0
      && Array.isArray(sourceReadOmissions) && sourceReadOmissions.length === 0
      && ['verified', 'prepared_input_only'].includes(preflight);
    const coverage = cell.coverage || cell.receipt?.coverage;
    const nativeCoverageComplete = arm?.coverageModel === 'single_agent_file_manifest_no_persona_quorum'
      ? coverage?.quorumSatisfied === null && coverage?.quorumComparable === false
        && coverage?.rosterValid === true && coverage?.fullPanelComplete === true
      : coverage?.quorumSatisfied === true && coverage?.rosterValid === true && coverage?.fullPanelComplete === true;
    const coverageComplete = nativeCoverageComplete;
    const attemptsForAttestation = cell.model?.httpAttempts;
    const callAccounting = cell.model?.callAccounting;
    const attempts = callAccounting?.localHttpRequestAttempts;
    const logical = callAccounting?.logicalCompletionDispatches ?? cell.model?.calls;
    const physicalAttemptOrdinals = Array.isArray(attemptsForAttestation)
      ? attemptsForAttestation.map((attempt) => attempt?.localAttemptOrdinal) : [];
    const physicalAttemptsComplete = Number.isSafeInteger(attempts) && attempts >= 0
      && Array.isArray(attemptsForAttestation) && attemptsForAttestation.length === attempts
      && physicalAttemptOrdinals.every((ordinal, index) => ordinal === index + 1);
    const dispatches = callAccounting?.dispatches;
    const dispatchAttemptsComplete = Number.isSafeInteger(attempts) && attempts >= 0
      && Number.isSafeInteger(logical) && logical >= 0
      && hasExactLogicalAttemptMapping(attemptsForAttestation, dispatches, attempts, logical);
    const providerVerified = cell.providerAttestation?.status === 'verified'
      && physicalAttemptsComplete
      && matchesPerRequestAttestation(attemptsForAttestation, cell.providerAttestation);
    const callAccountingComplete = Number.isSafeInteger(attempts) && attempts >= 0
      && Number.isSafeInteger(logical) && logical >= 0
      && callAccounting?.requestAttemptAccountingMatches === true
      && callAccounting?.requestProfileAttemptCount === attempts
      && Array.isArray(dispatches)
      && dispatches.length === logical
      && callAccounting.dispatchAttemptAccountingMatches === true
      && physicalAttemptsComplete && dispatchAttemptsComplete;
    const noModelDispatched = declaredPreflightAbstention && attempts === 0 && logical === 0
      && Array.isArray(attemptsForAttestation) && attemptsForAttestation.length === 0
      && callAccountingComplete && cell.providerAttestation === null;
    if (cell.status !== 'completed' && !declaredPreflightAbstention) issues.push('runtime_case_incomplete');
    if (!sourceComplete) issues.push('source_preflight_incomplete');
    if (!coverageComplete && !declaredPreflightAbstention) issues.push('coverage_or_quorum_incomplete');
    if (!providerVerified && !noModelDispatched) issues.push('provider_identity_unattested');
    if (declaredPreflightAbstention && !noModelDispatched) issues.push('preflight_abstention_has_model_dispatch');
    if (!Number.isSafeInteger(cell.metrics?.totalTokens) || cell.metrics.totalTokens < 0
      || !Number.isSafeInteger(cell.metrics?.totalDurationMs) || cell.metrics.totalDurationMs < 0) {
      issues.push('token_or_wall_metrics_missing');
    }
    if (Number.isSafeInteger(attempts) && attempts >= 0 && !physicalAttemptsComplete) {
      issues.push('local_http_attempt_record_count_mismatch');
    }
    if (Number.isSafeInteger(attempts) && attempts >= 0 && callAccounting?.requestProfileAttemptCount !== attempts) {
      issues.push('request_profile_attempt_count_mismatch');
    }
    if (Number.isSafeInteger(logical) && logical >= 0 && !dispatchAttemptsComplete) {
      issues.push('logical_dispatch_attempt_mapping_mismatch');
    }
    if (!callAccountingComplete) issues.push('logical_dispatch_classification_incomplete');
    if (cell.status === 'completed' && sourceComplete && coverageComplete && providerVerified && callAccountingComplete) {
      completeCells += 1;
      validCellsByKey.set(cellKey, cell);
    } else if (noModelDispatched && sourceComplete && callAccountingComplete) {
      preflightAbstentionCells += 1;
      validCellsByKey.set(cellKey, cell);
    }
  }
  const missingCells = expected.filter((entry) => !seen.has(key(entry)));
  if (missingCells.length) issues.push('expected_arm_case_receipts_missing');
  const armCaseSets = plan.publicRunMatrix.arms.map((arm) => new Set((arm.caseIds || []).filter((caseId) =>
    validCellsByKey.get(key({ armId: arm.id, caseId }))?.status === 'completed')));
  const commonComparatorCaseIds = plan.publicPanel.caseIds.filter((caseId) =>
    armCaseSets.every((caseSet) => caseSet.has(caseId)));
  const expectedCommon = plan.publicRunMatrix.comparisonDenominators?.AlibabaNativeSourceComplete;
  if (Number.isSafeInteger(expectedCommon) && commonComparatorCaseIds.length !== expectedCommon) {
    issues.push('common_comparator_denominator_mismatch');
  }
  const allAccounted = expected.length === seen.size && issues.length === 0
    && completeCells + preflightAbstentionCells === expected.length;
  const hasComparatorScopeLimitations = preflightAbstentionCells > 0;
  const armCompletion = plan.publicRunMatrix.arms.map((arm, index) => ({
    armId: arm.id,
    completeCaseCount: [...armCaseSets[index]].length,
    plannedUnsupportedCaseCount: arm.nativeSourceLimitations ? Object.keys(arm.nativeSourceLimitations).length : 0,
  }));
  return {
    status: allAccounted ? hasComparatorScopeLimitations
      ? 'READY_FOR_BLIND_ADJUDICATION_WITH_DECLARED_COMPARATOR_SCOPE_LIMITATION'
      : 'READY_FOR_BLIND_ADJUDICATION' : 'ABSTAIN',
    expectedCells: expected.length,
    completeCells,
    preflightAbstentionCells,
    accountedCells: completeCells + preflightAbstentionCells,
    missingCells: missingCells.map((entry) => ({ ...entry })),
    commonComparatorCaseIds,
    commonComparatorDenominator: commonComparatorCaseIds.length,
    armCompletion,
    issues: [...new Set(issues)].sort(),
    qualityScore: null,
    note: 'Run completeness is not a quality score; blind adjudication is required.',
  };
}

function assertDiscoveryRunArmBinding(bundle, arm, run, expectedRuntimeSha, expectedHostExecution) {
  if (arm?.engine !== 'Review Yeti'
    || !['baseline', 'qualification', 'repeat_stability'].includes(arm.purpose)) {
    throw new Error('ws5_discovery_arm_not_supported');
  }
  const baseline = arm.purpose === 'baseline';
  const purpose = baseline ? 'baseline' : 'qualification';
  const expectedExecutionPurpose = baseline ? 'actual_production_entrypoint_v1_baseline_input'
    : 'actual_production_entrypoint_qualification_input';
  const expectedCaseExecutionPurpose = baseline ? 'full_production_envelope_v1_baseline_input'
    : 'full_production_envelope_quality_input';
  if (run.executionPurpose !== expectedExecutionPurpose
    || run.sourceSnapshotVerification !== 'preparation_stage_only_not_reverified_at_run') {
    throw new Error('ws5_discovery_execution_purpose_mismatch');
  }

  const acceptedRuntimeSha = arm.runtimeSha || expectedRuntimeSha;
  if (arm.runtimeSha === null && !expectedRuntimeSha) throw new Error('ws5_discovery_expected_runtime_sha_required');
  if (!GIT_SHA_RE.test(String(acceptedRuntimeSha || ''))
    || (arm.runtimeSha && expectedRuntimeSha && expectedRuntimeSha !== arm.runtimeSha)
    || (!baseline && acceptedRuntimeSha === V1_BASELINE_RUNTIME_SHA)
    || run.runtime?.commit !== acceptedRuntimeSha || !GIT_SHA_RE.test(String(run.runtime?.tree || ''))
    || run.runtime?.worktreeClean !== true) {
    throw new Error('ws5_discovery_runtime_pin_mismatch');
  }
  const host = run.runtime?.hostExecution;
  const requiredHostHashes = [
    'nodeExecutableSha256', 'runnerSourceSha256', 'runnerPackageLockSha256',
    'runtimePackageLockSha256', 'tsNodeLoaderSha256', 'typescriptEntrySha256', 'runtimeEntryFilesSha256',
  ];
  if (!host || host.executionMode !== 'host_node'
    || host.workerImageExecution !== 'provenance_reference_only_not_executed_by_ws5_host_runner'
    || typeof host.nodeVersion !== 'string' || !host.nodeVersion.startsWith('v')
    || typeof host.platform !== 'string' || typeof host.architecture !== 'string'
    || !GIT_SHA_RE.test(String(host.runnerSourceCommit || ''))
    || !GIT_SHA_RE.test(String(host.runnerSourceTree || ''))
    || typeof host.runnerSourceClean !== 'boolean'
    || requiredHostHashes.some((field) => !SHA256_RE.test(String(host[field] || '')))
    || !expectedHostExecution || !isDeepStrictEqual(host, expectedHostExecution)) {
    throw new Error('ws5_discovery_host_execution_identity_mismatch');
  }

  const effortProfile = arm.effortProfile;
  const projectionSha256 = V1_POLICY_PROVENANCE.projectionSha256ByEffort[effortProfile];
  const projectionPath = effortProfile === 'native_omitted'
    ? 'eval-baselines/competitive-review-benchmark/policy-projections/yeti-v1-native-omitted.json'
    : effortProfile === 'medium'
      ? 'eval-baselines/competitive-review-benchmark/policy-projections/yeti-v1-medium.json'
      : null;
  if (!projectionPath || !projectionSha256) throw new Error('ws5_discovery_arm_policy_not_supported');
  const root = bundle?.dataRootPath || bundle?.rootPath
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const projectionBytes = fs.readFileSync(safeRepoPath(root, projectionPath));
  if (sha256(projectionBytes) !== projectionSha256) throw new Error('ws5_discovery_policy_projection_pin_mismatch');
  let sourcePolicy;
  try { sourcePolicy = JSON.parse(projectionBytes.toString('utf8')); }
  catch { throw new Error('ws5_discovery_policy_projection_invalid'); }
  const expectedPolicy = buildDiscoveryPolicy(sourcePolicy, { purpose, effortProfile });
  const expectedVerifierMode = baseline ? 'absent_in_selected_v1_baseline'
    : 'production_independent_verifier_required';
  if (run.policy?.sourcePolicySourceRevision !== V1_POLICY_PROVENANCE.revision
    || run.policy?.sourcePolicySourceSha256 !== V1_POLICY_PROVENANCE.sourceSha256
    || run.policy?.policyProjectionFileSha256 !== projectionSha256
    || run.policy?.materialization !== 'local_benchmark_policy_projection_not_authenticated_service_admission'
    || run.policy?.effortProfile !== effortProfile
    || run.policy?.effortInjection !== 'runtime_native'
    || run.policy?.verifierMode !== expectedVerifierMode) {
    throw new Error('ws5_discovery_policy_binding_mismatch');
  }
  const verificationReserveTurns = baseline ? 0 : 12;
  const expectedResourceProfile = discoveryResourceProfile(expectedPolicy, {
    verificationReserveTurns,
    env: {},
  });
  if (!isDeepStrictEqual(run.requestedResourceLimits, expectedResourceProfile)) {
    throw new Error('ws5_discovery_resource_profile_mismatch');
  }
  return { expectedCaseExecutionPurpose };
}

function normalizeFindingEvidence(runtimeReceipt) {
  if (!runtimeReceipt || typeof runtimeReceipt !== 'object' || !Array.isArray(runtimeReceipt.findings)) return null;
  const boundedText = (value, maxLength) => typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').slice(0, maxLength) : null;
  return {
    findings: runtimeReceipt.findings.slice(0, 500).map((finding, index) => {
      const pathValue = typeof finding?.path === 'string' ? finding.path : '';
      const safePath = !pathValue || (!path.isAbsolute(pathValue) && !/^[A-Za-z]:[\\/]/u.test(pathValue)
        && !pathValue.startsWith('\\\\') && !pathValue.split(/[\\/]/u).includes('..'));
      const title = boundedText(finding?.title, 300);
      const comment = boundedText(finding?.comment, 2_000);
      const recommendation = boundedText(finding?.recommendation, 1_000);
      return {
        id: typeof finding?.id === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(finding.id)
          ? finding.id : `finding-${index + 1}`,
        severity: typeof finding?.severity === 'string' && /^[A-Za-z0-9_-]{1,24}$/u.test(finding.severity)
          ? finding.severity : 'unknown',
        path: safePath ? pathValue.slice(0, 1_000) : '',
        line: Number.isSafeInteger(finding?.line) && finding.line > 0 ? finding.line : null,
        lane: typeof finding?.lane === 'string' && /^[A-Za-z0-9._:-]{1,80}$/u.test(finding.lane)
          ? finding.lane : 'unknown',
        ...(title ? { title } : {}),
        ...(comment ? { comment } : {}),
        ...(recommendation ? { recommendation } : {}),
      };
    }),
  };
}

/** Normalize one arm-bound actual run while keeping per-request gateway attestation separate. */
/** @param {any} plan @param {string} armId @param {any} run @param {Map<string, any>|Record<string, any>} providerAttestations
 * @param {{expectedRuntimeSha?: string, expectedHostExecution?: any, selectedCaseId?: string}} options */
export function normalizeDiscoveryRunEnvelope(plan, armId, run, providerAttestations,
  { expectedRuntimeSha, expectedHostExecution, selectedCaseId } = {}) {
  const bundle = plan?.plan ? plan : null;
  const acceptancePlan = bundle ? bundle.plan : plan;
  if (!run || run.task !== 'discovery' || !Array.isArray(run.cases)
    || !Array.isArray(run.selectedCaseIds) || !Array.isArray(run.panelCaseIds)) {
    throw new Error('ws5_discovery_run_envelope_invalid');
  }
  const arm = acceptancePlan?.publicRunMatrix?.arms?.find((entry) => entry.id === armId);
  if (!arm || run.datasetSha256 !== acceptancePlan.publicPanel.datasetSha256
    || run.heldoutManifestSha256 !== acceptancePlan.publicPanel.manifestSha256
    || run.preparedInputSha256 !== acceptancePlan.publicPanel.preparedInputSha256) {
    throw new Error('ws5_discovery_run_pin_mismatch');
  }
  const { expectedCaseExecutionPurpose } = assertDiscoveryRunArmBinding(
    bundle, arm, run, expectedRuntimeSha, expectedHostExecution,
  );
  assertExactCaseIdSet(run.panelCaseIds, acceptancePlan.publicPanel.caseIds);
  const expectedSelectedIds = selectedCaseId === undefined ? arm.caseIds : [selectedCaseId];
  if (selectedCaseId !== undefined && !arm.caseIds.includes(selectedCaseId)) {
    throw new Error('ws5_discovery_case_not_in_selected_arm');
  }
  assertExactCaseIdSet(run.selectedCaseIds, expectedSelectedIds);
  const attestationByCase = providerAttestations instanceof Map
    ? providerAttestations : new Map(Object.entries(providerAttestations || {}));
  const selectedSet = new Set(run.selectedCaseIds);
  if (selectedSet.size !== run.selectedCaseIds.length || selectedSet.size !== run.cases.length
    || run.cases.some((entry) => !selectedSet.has(entry.caseId))) {
    throw new Error('ws5_discovery_run_case_set_mismatch');
  }
  const sourceProfileById = new Map((bundle?.sourceProfile?.cases || []).map((entry) => [entry.caseId, entry]));
  const manifestById = new Map(bundle?.manifest?.cases?.map((entry) => [entry.id, entry]) || []);
  return run.cases.map((entry) => {
    const expected = manifestById.get(entry.caseId);
    const observed = entry.source || {};
    if (!expected || observed.repository !== expected.repository || observed.prNumber !== expected.prNumber
      || observed.datasetBaseSha !== expected.datasetBaseSha || observed.diffBaseSha !== expected.diffBaseSha
      || observed.mergeBaseSha !== expected.mergeBaseSha || observed.headSha !== expected.headSha) {
      throw new Error('ws5_discovery_case_source_identity_mismatch');
    }
    if (entry.executionPurpose !== expectedCaseExecutionPurpose
      || entry.model?.requestedAlias !== acceptancePlan.providerIdentityGate?.primaryModelAlias
      || entry.model?.effortInjection !== 'runtime_native') {
      throw new Error('ws5_discovery_case_arm_configuration_mismatch');
    }
    const profile = sourceProfileById.get(entry.caseId);
    if (!profile || observed.changedFiles !== profile.changedFileCount
      || observed.sourceCachePreflight?.status !== 'verified') throw new Error('ws5_discovery_case_source_profile_mismatch');
    return {
      armId,
      caseId: entry.caseId,
      status: entry.status,
      source: entry.source,
      coverage: entry.receipt?.coverage,
      metrics: entry.receipt?.metrics,
      model: entry.model,
      runtimeExecution: run.runtime.hostExecution,
      runtimeReceipt: normalizeFindingEvidence(entry.runtimeReceipt),
      providerAttestation: attestationByCase.get(entry.caseId) || null,
      responseReportedIdentity: {
        providers: entry.model?.responseReportedProviders || [],
        models: entry.model?.responseReportedModels || [],
        routeHints: entry.model?.responseRouteHints || [],
      },
    };
  });
}

/** Deduplicate findings by independently assigned causal identity, not wording or occurrence. */
export function summarizeFindingJudgments(generatedFindings, adjudication) {
  const findings = Array.isArray(generatedFindings) ? generatedFindings : [];
  const judgments = Array.isArray(adjudication?.judgments) ? adjudication.judgments : [];
  const findingIds = findings.map((entry) => entry.findingId);
  const judgmentIds = judgments.map((entry) => entry.findingId);
  const validFindingIds = new Set(findingIds.filter((entry) => typeof entry === 'string' && entry.length > 0));
  const duplicateFindingIds = findingIds.length !== validFindingIds.size;
  const duplicateJudgmentIds = new Set(judgmentIds).size !== judgmentIds.length;
  const byId = new Map(judgments.map((entry) => [entry.findingId, entry]));
  const causes = new Map();
  let unresolvedCount = 0;
  for (const finding of findings) {
    const judgment = byId.get(finding.findingId);
    if (!judgment || !CAUSAL_CLASSES.has(judgment.class) || typeof judgment.causalId !== 'string'
      || judgment.causalId.trim().length === 0 || judgment.class === 'unresolved') {
      unresolvedCount += 1;
      continue;
    }
    if (!causes.has(judgment.causalId)) causes.set(judgment.causalId, { class: judgment.class, occurrenceCount: 0 });
    const causal = causes.get(judgment.causalId);
    if (causal.class !== judgment.class) causal.class = 'unresolved';
    causal.occurrenceCount += 1;
  }
  const countClass = (value) => [...causes.values()].filter((entry) => entry.class === value).length;
  const repeatPairs = [...causes]
    .filter(([, entry]) => entry.occurrenceCount > 1)
    .map(([causalId, entry]) => ({ causalId, occurrenceCount: entry.occurrenceCount }))
    .sort((a, b) => a.causalId.localeCompare(b.causalId));
  const judgmentCoverageComplete = !duplicateFindingIds && !duplicateJudgmentIds
    && judgments.length === findings.length
    && judgmentIds.every((findingId) => validFindingIds.has(findingId))
    && findings.every((finding) => byId.has(finding.findingId));
  const judgedCount = countClass('introduced_defect') + countClass('preexisting_defect')
    + countClass('nit') + countClass('false_positive');
  return {
    generatedFindingCount: findings.length,
    uniqueCausalFindingCount: causes.size,
    introducedDefectCount: countClass('introduced_defect'),
    preexistingFindingCount: countClass('preexisting_defect'),
    nitCount: countClass('nit'),
    falsePositiveCount: countClass('false_positive'),
    unresolvedCount,
    judgmentsComplete: judgmentCoverageComplete && unresolvedCount === 0,
    introducedDefectPrecision: judgedCount
      ? countClass('introduced_defect') / judgedCount : null,
    repeatPairs,
    judgeIdentity: adjudication?.judge?.kind === 'independent_human'
      && typeof adjudication.judge.protocolId === 'string' ? adjudication.judge.protocolId : null,
    qualificationReason: !judgmentCoverageComplete ? 'independent_judgment_incomplete'
      : unresolvedCount > 0 ? 'unresolved_generated_findings' : null,
  };
}
