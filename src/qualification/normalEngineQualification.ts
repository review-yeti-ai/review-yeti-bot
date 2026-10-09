import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION } from '../review/groundedEvidenceV2';
import { groundedVerifierRouteV1Schema, type GroundedVerifierRouteV1 } from '../review/groundedVerifierRoute';
import { composedRuntimeResourcesSchema } from '../panel/composedResourceReceipt';

const FIXTURE_BUNDLE_VERSION = 'GroundedLifecycleFixtureBundle.v1' as const;
const FIXTURE_BUNDLE_SHA256 = '73c7f949da51b0202d6903f795acf10f58b41fd17403ae267bb7297b150f9373';
const REPAIR_BUNDLE_VERSION = 'WS5RepairSequenceBundle.v1' as const;
const REPAIR_BUNDLE_SHA256 = 'e6b6e359d6c6676c8ab3461b7e576b2d14a77ed92fb7178b0ba0b6cc69d14329';
const LARGE_BUNDLE_VERSION = 'WS5LargeCrossfileBundle.v1' as const;
const LARGE_BUNDLE_SHA256 = '1e929cc12ef523e523dc67e1ee7c3d7ef83268f1e2c4734615c219523e4813c9';
const P2_BUNDLE_VERSION = 'WS5P2DisplaySortBundle.v1' as const;
const P2_BUNDLE_SHA256 = 'ff43921f3c8188d6a0efd8a257c310f1ac1d8cefcc32fd1f8fba242c1ecb26af';
const EXTERNAL_V2_BUNDLE_VERSION = 'WS5ExternalNormalBundle.v2' as const;
const EXTERNAL_V2_BUNDLE_SHA256 = '99b707383ec16eea3ef81994c623e956f551a1e9d0b6acf2dd503afc5d41cfe1';
const EXTERNAL_V2_BUNDLE_DESCRIPTOR_PATH = 'competitive-review-benchmark/ws5-external-normal-v2/source-bundle.json';
const EXTERNAL_V3_BUNDLE_VERSION = 'WS5ExternalNormalBundle.v3' as const;
const EXTERNAL_V3_BUNDLE_SHA256 = 'd83b08f04890604fd1bfe98105e6db7ad70945afb1e5471218ca62d2204cc3bc';
const EXTERNAL_V3_BUNDLE_DESCRIPTOR_PATH = 'competitive-review-benchmark/ws5-external-normal-v3/source-bundle.json';
const REPOSITORY_ROOT = resolve(__dirname, '../..');
const FIXTURE_ROOT = resolve(REPOSITORY_ROOT, 'eval-baselines');
export const NORMAL_ENGINE_QUALIFICATION_RECEIPT_PATH = '/workspace/.review-yeti/normal-engine-qualification.json';
export const NORMAL_ENGINE_QUALIFICATION_STORE_ROOT = '/workspace/.review-yeti/normal-engine-qualification-store';
const QUALIFICATION_SELECTION_PURPOSE = 'qualification-only-target-binding' as const;
export const NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT = 'configured-disputed-blocker-adjudicator-v1' as const;
export type NormalEngineQualificationConfigurationVariant = 'prepared-policy-default-v1'
  | typeof NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT;
const RUN_ID_PATTERN = /^nq_[a-f0-9]{32}$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const QUALIFICATION_RESOURCE_UNAVAILABLE_REASONS = ['worker-completion-unavailable', 'resource-evidence-unavailable',
  'resource-evidence-invalid', 'resource-sidecar-persistence-failed'] as const;
const QUALIFICATION_PROVIDER_CAPTURE_UNAVAILABLE_REASONS = ['provider-capture-context-unavailable', 'provider-capture-invalid',
  'provider-capture-sidecar-persistence-failed'] as const;

export function normalEngineQualificationComposedResourcesRelativePath(
  runId: string, phase: NormalEngineQualificationReceipt['phase'], caseId: string,
): string {
  if (!RUN_ID_PATTERN.test(runId) || !['single', 'repair-introduction', 'repair-head', 'same-head-recheck'].includes(phase)
    || !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(caseId)) {
    throw new Error('normal-engine qualification composed resource identity is invalid');
  }
  return `normal-engine-qualification-store/${runId}/${phase}/${caseId}`
    + '/composed-resources.record/composed-runtime-resources.json';
}

export interface FixturePin {
  caseId: string;
  path: string;
  sha256: string;
  schemaVersion: string;
  bundleVersion: string;
  bundleSha256: string;
  repository: { repositoryId: number; owner: string; repo: string };
  prNumber: number;
  baseSha: string;
  headSha: string;
}

export interface NormalEngineQualificationHistoryLineage {
  sequenceId: string;
  sourceCaseId: string;
  repairCaseId: string;
  sourceInputSha256: string;
  repairInputSha256: string;
  repairBaseSha: string;
  repairHeadSha: string;
}

export const WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE = Object.freeze({
  sequenceId: 'ws5-current-source-external-v2',
  sourceCaseId: 'ws5-current-1dd-v2-sequence-a',
  repairCaseId: 'ws5-current-1dd-v2-sequence-b',
  bundleSha256: EXTERNAL_V2_BUNDLE_SHA256,
  sourceInputSha256: '0e3bade3d6d7a148a2a36515ed1b40b9c1ab3f4cc2b2d92343176f2069ca0da9',
  repairInputSha256: '52cdd6d19fc5dd042412a85df5b4effe8c9793c43cea3104ab5b35d036b1d1aa',
  repairBaseSha: '1035dc8db9a222447aa774fd9660c224e5d37655',
  repairHeadSha: '1b183caf5f8c518a3acda3fb2d8eea38133eed98',
});

export const WS5_EXTERNAL_NORMAL_V3_HISTORY_LINEAGE = Object.freeze({
  sequenceId: 'ws5-r2-h001',
  sourceCaseId: 'ws5-r2-c002',
  repairCaseId: 'ws5-r2-c003',
  bundleSha256: EXTERNAL_V3_BUNDLE_SHA256,
  sourceInputSha256: 'f1b5a2f7b838cacd039972da5de7cb066ca838882e31e840190850591ae5c37f',
  repairInputSha256: '6fcfa7a254eb960ae3a2ef79358e06205e6812c748e353679ead1578b11a1e84',
  repairBaseSha: 'e62ac7e8846d80864cacc65699268097caa31223',
  repairHeadSha: '81d910d8a133563e76e5a700ba65fb58b7dcdc72',
});

export function isExternalNormalQualificationBundle(bundleVersion: string): boolean {
  return bundleVersion === EXTERNAL_V2_BUNDLE_VERSION || bundleVersion === EXTERNAL_V3_BUNDLE_VERSION;
}

export function externalNormalQualificationHistoryLineageForCase(caseId: string) {
  if (caseId === WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.sourceCaseId
    || caseId === WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.repairCaseId) {
    return WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE;
  }
  if (caseId === WS5_EXTERNAL_NORMAL_V3_HISTORY_LINEAGE.sourceCaseId
    || caseId === WS5_EXTERNAL_NORMAL_V3_HISTORY_LINEAGE.repairCaseId) {
    return WS5_EXTERNAL_NORMAL_V3_HISTORY_LINEAGE;
  }
  return undefined;
}

const LEGACY_REPAIR_HISTORY_LINEAGE: NormalEngineQualificationHistoryLineage = {
  sequenceId: 'ws5-repair-sequence-v1',
  sourceCaseId: 'ws5-sequence-a-v1',
  repairCaseId: 'ws5-sequence-b-v1',
  sourceInputSha256: '31feff802596e9e8b52aa45b64a1a00fc2af5e221158815c007188b3b11877a5',
  repairInputSha256: '4023515cfc0daef0b1c00089924ca12d5071080da4e97d6e964c03c8596bbceb',
  repairBaseSha: '1035dc8db9a222447aa774fd9660c224e5d37655',
  repairHeadSha: '1b183caf5f8c518a3acda3fb2d8eea38133eed98',
};

const FIXTURE_PINS: readonly FixturePin[] = [
  { caseId: 'lc_0d8f4a7c2b9e41f8', path: 'eval-baselines/grounded-lifecycle-corpus-v1/inputs/lc_0d8f4a7c2b9e41f8.json',
    sha256: '8bd26520e0b3149e0f3b8fdc637f0e5390b737354ee59f53c63e4b32e27b11ef',
    schemaVersion: 'GroundedLifecycleInput.v1', bundleVersion: FIXTURE_BUNDLE_VERSION, bundleSha256: FIXTURE_BUNDLE_SHA256,
    repository: { repositoryId: 73001, owner: 'synthetic', repo: 'fixture-project' },
    prNumber: 41,
    baseSha: 'b5bf7b68ece2f674d88356749aa4575edc5e510d', headSha: 'c9b23312180a753ed222814a7ec4380ae0e850a5' },
  { caseId: 'lc_13b6e2d6a9084f51', path: 'eval-baselines/grounded-lifecycle-corpus-v1/inputs/lc_13b6e2d6a9084f51.json',
    sha256: '31aa88dba3065ff8dc345e20da1a5376c05f26ee235c666ae046c63a4e123a67',
    schemaVersion: 'GroundedLifecycleInput.v1', bundleVersion: FIXTURE_BUNDLE_VERSION, bundleSha256: FIXTURE_BUNDLE_SHA256,
    repository: { repositoryId: 73001, owner: 'synthetic', repo: 'fixture-project' },
    prNumber: 41,
    baseSha: '2e6836c32f24a7992ebe257cb45c016baa85a25e', headSha: 'e75cb98e36ecc53bccf72faf3e829c8a437e15e2' },
  { caseId: 'lc_2a904d7c1e5b43f6', path: 'eval-baselines/grounded-lifecycle-corpus-v1/inputs/lc_2a904d7c1e5b43f6.json',
    sha256: '3b447c585a03ed3bcebaa1ce7df6e4fb4faed39f36bc7268a73f3347be145951',
    schemaVersion: 'GroundedLifecycleInput.v1', bundleVersion: FIXTURE_BUNDLE_VERSION, bundleSha256: FIXTURE_BUNDLE_SHA256,
    repository: { repositoryId: 73001, owner: 'synthetic', repo: 'fixture-project' },
    prNumber: 41,
    baseSha: 'db95eda4303656720a9b3b1779a9bc88f634401a', headSha: '2e0b7855fae1da30490e3cb3924503ad2f5b0382' },
  { caseId: 'lc_38e1a5d904bf62c7', path: 'eval-baselines/grounded-lifecycle-corpus-v1/inputs/lc_38e1a5d904bf62c7.json',
    sha256: '5b8ab57432b2d01ac0af0b2c08f92a72b43948db1b407f2b56ba473da2c1f62c',
    schemaVersion: 'GroundedLifecycleInput.v1', bundleVersion: FIXTURE_BUNDLE_VERSION, bundleSha256: FIXTURE_BUNDLE_SHA256,
    repository: { repositoryId: 73001, owner: 'synthetic', repo: 'fixture-project' },
    prNumber: 41,
    baseSha: '6e5d67004a209e98c660f083b78509d374e44384', headSha: 'f1b3054ed9f8dfb90d66747b2f9ddb67ccd63161' },
  { caseId: 'lc_41c8d2f709ae35b6', path: 'eval-baselines/grounded-lifecycle-corpus-v1/inputs/lc_41c8d2f709ae35b6.json',
    sha256: '1d59fe948b08209be1cecfd1b108e37fdf66d2d8e681adb9720d9af9b61549f7',
    schemaVersion: 'GroundedLifecycleInput.v1', bundleVersion: FIXTURE_BUNDLE_VERSION, bundleSha256: FIXTURE_BUNDLE_SHA256,
    repository: { repositoryId: 73001, owner: 'synthetic', repo: 'fixture-project' },
    prNumber: 41,
    baseSha: '8667659d4ba0e2181d1b2b473923785eff33b604', headSha: 'ea555cbb2d769228ff8c6a8c8aa491b8f6de55fa' },
  { caseId: 'lc_5b2f07c913de4a68', path: 'eval-baselines/grounded-lifecycle-corpus-v1/inputs/lc_5b2f07c913de4a68.json',
    sha256: '523c70aef278cc5f18b304083842b6ac8c20c77fce45b33ff2db51a16f3ee142',
    schemaVersion: 'GroundedLifecycleInput.v1', bundleVersion: FIXTURE_BUNDLE_VERSION, bundleSha256: FIXTURE_BUNDLE_SHA256,
    repository: { repositoryId: 73001, owner: 'synthetic', repo: 'fixture-project' },
    prNumber: 41,
    baseSha: '24505fd6419f54b6a8d9d63ec8db99e10d414a99', headSha: '223ac9e2a3a810125d381aedd60e7e34c894b86a' },
  { caseId: 'lc_6d10a4e82f739b05', path: 'eval-baselines/grounded-lifecycle-corpus-v1/inputs/lc_6d10a4e82f739b05.json',
    sha256: '9a9466ed21208f3787bb4dcb56fd3de7ceb7422356c14aaf370cae27f253e7c2',
    schemaVersion: 'GroundedLifecycleInput.v1', bundleVersion: FIXTURE_BUNDLE_VERSION, bundleSha256: FIXTURE_BUNDLE_SHA256,
    repository: { repositoryId: 73001, owner: 'synthetic', repo: 'fixture-project' },
    prNumber: 41,
    baseSha: 'befbc648aa877789bb45f41bb3a157f086198afa', headSha: '2793109115e7f6044ba13ae59401fa93e0f60eea' },
  { caseId: 'lc_7a3c5e91d4b8062f', path: 'eval-baselines/grounded-lifecycle-corpus-v1/inputs/lc_7a3c5e91d4b8062f.json',
    sha256: 'c1039f31d8d063de5d72c56229c62863653fa0f03f1a8a0781aeea3e0a2d8d7f',
    schemaVersion: 'GroundedLifecycleInput.v1', bundleVersion: FIXTURE_BUNDLE_VERSION, bundleSha256: FIXTURE_BUNDLE_SHA256,
    repository: { repositoryId: 73001, owner: 'synthetic', repo: 'fixture-project' },
    prNumber: 41,
    baseSha: '72cb38c139136fdadb2124baa413894d8f88bd3b', headSha: 'd7ad692f8aefe0419cae05cde8b8afa3ad4dd7d1' },
  { caseId: 'ws5-sequence-a-v1', path: 'eval-baselines/competitive-review-benchmark/ws5-repair-sequence-v1/inputs/ws5-sequence-a-v1.json',
    sha256: '31feff802596e9e8b52aa45b64a1a00fc2af5e221158815c007188b3b11877a5',
    schemaVersion: 'WS5RepairReviewInput.v1', bundleVersion: REPAIR_BUNDLE_VERSION, bundleSha256: REPAIR_BUNDLE_SHA256,
    repository: { repositoryId: 73002, owner: 'synthetic', repo: 'fixture-sequence' }, prNumber: 41,
    baseSha: '1fd9256afcf0250975c69410a766629c4d4225ad', headSha: '1035dc8db9a222447aa774fd9660c224e5d37655' },
  { caseId: 'ws5-sequence-b-v1', path: 'eval-baselines/competitive-review-benchmark/ws5-repair-sequence-v1/inputs/ws5-sequence-b-v1.json',
    sha256: '4023515cfc0daef0b1c00089924ca12d5071080da4e97d6e964c03c8596bbceb',
    schemaVersion: 'WS5RepairReviewInput.v1', bundleVersion: REPAIR_BUNDLE_VERSION, bundleSha256: REPAIR_BUNDLE_SHA256,
    repository: { repositoryId: 73002, owner: 'synthetic', repo: 'fixture-sequence' }, prNumber: 41,
    baseSha: '1035dc8db9a222447aa774fd9660c224e5d37655', headSha: '1b183caf5f8c518a3acda3fb2d8eea38133eed98' },
  { caseId: 'ws5-large-crossfile-v1', path: 'eval-baselines/competitive-review-benchmark/ws5-large-crossfile-v1/inputs/ws5-large-crossfile-v1.json',
    sha256: 'ad360475a095d194b933f2323b7226f057cc617f8cbb605d5473bd00f00b62f5',
    schemaVersion: 'WS5LargeCrossfileInput.v1', bundleVersion: LARGE_BUNDLE_VERSION, bundleSha256: LARGE_BUNDLE_SHA256,
    repository: { repositoryId: 73003, owner: 'synthetic', repo: 'fixture-large-crossfile' }, prNumber: 42,
    baseSha: 'f83c7fbab1909ebc8e3b1a905c4d93a6ffdf8448', headSha: 'cef2d6d195ad1ec19ec6a745363a804fd679b369' },
  { caseId: 'ws5-p2-display-sort-v1', path: 'eval-baselines/competitive-review-benchmark/ws5-p2-display-sort-v1/inputs/ws5-p2-display-sort-v1.json',
    sha256: 'c71cd3b3cdf2efd6d83705be5aef8eaa8fe3bb8418e24dfbc0b0a565bf660b2e',
    schemaVersion: 'WS5P2DisplaySortInput.v1', bundleVersion: P2_BUNDLE_VERSION, bundleSha256: P2_BUNDLE_SHA256,
    repository: { repositoryId: 73004, owner: 'synthetic', repo: 'fixture-display-sort' }, prNumber: 43,
    baseSha: '740ca081f3ec2399ea72a329fbe4b2e7eeb47cd7', headSha: 'e4edc4bd9f74fd9ec3e8f8f7d9a83bd821832497' },
  { caseId: 'ws5-current-1dd-v2-p2', path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/p2.json',
    sha256: '4f476e36aa78b6788bb37c02ba5b2fae899c99eeba7d43dae399507cd93ed216',
    schemaVersion: 'WS5P2DisplaySortInput.v1', bundleVersion: EXTERNAL_V2_BUNDLE_VERSION, bundleSha256: EXTERNAL_V2_BUNDLE_SHA256,
    repository: { repositoryId: 73004, owner: 'synthetic', repo: 'fixture-display-sort' }, prNumber: 43,
    baseSha: '740ca081f3ec2399ea72a329fbe4b2e7eeb47cd7', headSha: 'e4edc4bd9f74fd9ec3e8f8f7d9a83bd821832497' },
  { caseId: 'ws5-current-1dd-v2-sequence-a', path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/seq_a.json',
    sha256: '0e3bade3d6d7a148a2a36515ed1b40b9c1ab3f4cc2b2d92343176f2069ca0da9',
    schemaVersion: 'WS5RepairReviewInput.v1', bundleVersion: EXTERNAL_V2_BUNDLE_VERSION, bundleSha256: EXTERNAL_V2_BUNDLE_SHA256,
    repository: { repositoryId: 73002, owner: 'synthetic', repo: 'fixture-sequence' }, prNumber: 41,
    baseSha: '1fd9256afcf0250975c69410a766629c4d4225ad', headSha: '1035dc8db9a222447aa774fd9660c224e5d37655' },
  { caseId: 'ws5-current-1dd-v2-sequence-b', path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/seq_b.json',
    sha256: '52cdd6d19fc5dd042412a85df5b4effe8c9793c43cea3104ab5b35d036b1d1aa',
    schemaVersion: 'WS5RepairReviewInput.v1', bundleVersion: EXTERNAL_V2_BUNDLE_VERSION, bundleSha256: EXTERNAL_V2_BUNDLE_SHA256,
    repository: { repositoryId: 73002, owner: 'synthetic', repo: 'fixture-sequence' }, prNumber: 41,
    baseSha: '1035dc8db9a222447aa774fd9660c224e5d37655', headSha: '1b183caf5f8c518a3acda3fb2d8eea38133eed98' },
  { caseId: 'ws5-current-1dd-v2-coverage-hole', path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/coverage_hole.json',
    sha256: '6cf9a5f6c493f1db2f91f8abc907e9d4f9f9ad1d3c62296298326cb18f78897c',
    schemaVersion: 'WS5LargeCrossfileInput.v1', bundleVersion: EXTERNAL_V2_BUNDLE_VERSION, bundleSha256: EXTERNAL_V2_BUNDLE_SHA256,
    repository: { repositoryId: 73003, owner: 'synthetic', repo: 'fixture-large-crossfile' }, prNumber: 42,
    baseSha: 'f83c7fbab1909ebc8e3b1a905c4d93a6ffdf8448', headSha: 'cef2d6d195ad1ec19ec6a745363a804fd679b369' },
  { caseId: 'ws5-current-1dd-v2-provider-failure', path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/provider_failure.json',
    sha256: '76278ffbbb439e4e4d7b77dabe6022c01cf2c33d61753127cc82c542a9d1e2bd',
    schemaVersion: 'WS5P2DisplaySortInput.v1', bundleVersion: EXTERNAL_V2_BUNDLE_VERSION, bundleSha256: EXTERNAL_V2_BUNDLE_SHA256,
    repository: { repositoryId: 73004, owner: 'synthetic', repo: 'fixture-display-sort' }, prNumber: 43,
    baseSha: '740ca081f3ec2399ea72a329fbe4b2e7eeb47cd7', headSha: 'e4edc4bd9f74fd9ec3e8f8f7d9a83bd821832497' },
  { caseId: 'ws5-current-1dd-v2-resource-exhaustion', path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/resource_exhaustion.json',
    sha256: '015efdfc7c5253cb52e4ec99f22bfc354ea51ae54667f161993a98b1566cd1bc',
    schemaVersion: 'WS5P2DisplaySortInput.v1', bundleVersion: EXTERNAL_V2_BUNDLE_VERSION, bundleSha256: EXTERNAL_V2_BUNDLE_SHA256,
    repository: { repositoryId: 73004, owner: 'synthetic', repo: 'fixture-display-sort' }, prNumber: 43,
    baseSha: '740ca081f3ec2399ea72a329fbe4b2e7eeb47cd7', headSha: 'e4edc4bd9f74fd9ec3e8f8f7d9a83bd821832497' },
  { caseId: 'ws5-r2-c001', path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/inputs/input-001.json',
    sha256: '54bb996bbd1caee73b313bc25676253469bdc9f40496ed937a0cfad32c29b162',
    schemaVersion: 'WS5RepairReviewInput.v1', bundleVersion: EXTERNAL_V3_BUNDLE_VERSION, bundleSha256: EXTERNAL_V3_BUNDLE_SHA256,
    repository: { repositoryId: 73004, owner: 'synthetic', repo: 'fixture-display-sort' }, prNumber: 51,
    baseSha: '9d9232e0fae8d370ef2570c1129f836b9b1a1c36', headSha: '5440774cbd3465150755f08a917bf724c92a372d' },
  { caseId: 'ws5-r2-c002', path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/inputs/input-002.json',
    sha256: 'f1b5a2f7b838cacd039972da5de7cb066ca838882e31e840190850591ae5c37f',
    schemaVersion: 'WS5RepairReviewInput.v1', bundleVersion: EXTERNAL_V3_BUNDLE_VERSION, bundleSha256: EXTERNAL_V3_BUNDLE_SHA256,
    repository: { repositoryId: 73002, owner: 'synthetic', repo: 'fixture-sequence' }, prNumber: 52,
    baseSha: 'b2beab2ab2c6369a0d6352a78af795d92246b7f3', headSha: 'e62ac7e8846d80864cacc65699268097caa31223' },
  { caseId: 'ws5-r2-c003', path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/inputs/input-003.json',
    sha256: '6fcfa7a254eb960ae3a2ef79358e06205e6812c748e353679ead1578b11a1e84',
    schemaVersion: 'WS5RepairReviewInput.v1', bundleVersion: EXTERNAL_V3_BUNDLE_VERSION, bundleSha256: EXTERNAL_V3_BUNDLE_SHA256,
    repository: { repositoryId: 73002, owner: 'synthetic', repo: 'fixture-sequence' }, prNumber: 52,
    baseSha: 'e62ac7e8846d80864cacc65699268097caa31223', headSha: '81d910d8a133563e76e5a700ba65fb58b7dcdc72' },
  { caseId: 'ws5-r2-c004', path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/inputs/input-004.json',
    sha256: 'e3cfadf9e9937c66d4c8fdfd90d97668fc691a185bba6960cb8379b276b9cb97',
    schemaVersion: 'WS5RepairReviewInput.v1', bundleVersion: EXTERNAL_V3_BUNDLE_VERSION, bundleSha256: EXTERNAL_V3_BUNDLE_SHA256,
    repository: { repositoryId: 73003, owner: 'synthetic', repo: 'fixture-large-crossfile' }, prNumber: 53,
    baseSha: 'a3e317cb730f8001039869c522d79f5793ccdc85', headSha: 'ebd7011b8170dd4b650ce924c335a6cd84fccbfe' },
].sort((left, right) => left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0);

const LIFECYCLE_PINS = FIXTURE_PINS.filter((pin) => pin.bundleVersion === FIXTURE_BUNDLE_VERSION);
const EXPECTED_BUNDLE_DESCRIPTOR = {
  schemaVersion: FIXTURE_BUNDLE_VERSION,
  cases: LIFECYCLE_PINS.map(({ caseId, path, sha256, repository, baseSha, headSha }) => ({
    caseId, path, sha256, repository, baseSha, headSha,
  })),
};
const actualBundleDigest = createHash('sha256')
  .update(`${JSON.stringify(EXPECTED_BUNDLE_DESCRIPTOR)}\n`, 'utf8')
  .digest('hex');
if (actualBundleDigest !== FIXTURE_BUNDLE_SHA256) {
  throw new Error('normal-engine qualification fixture descriptor digest is invalid');
}

export interface NormalEngineQualificationRequest {
  purpose: 'normal-engine-qualification';
  runId: string;
  arm: NormalEngineQualificationArm;
  phase: 'single' | 'repair-introduction' | 'repair-head' | 'same-head-recheck';
  configurationVariant: NormalEngineQualificationConfigurationVariant;
  historyRunId: string | null;
  historyLineage: NormalEngineQualificationHistoryLineage | null;
  fixture: {
    bundleVersion: string;
    bundleSha256: string;
    caseId: string;
    inputSha256: string;
    repository: FixturePin['repository'];
    prNumber: number;
    baseSha: string;
    headSha: string;
  };
  runtime: { sourceRevision: string; workerImageDigest: string; runtimeManifestSha256: string };
  policy: {
    targetRepository: string;
    selectionPurpose: typeof QUALIFICATION_SELECTION_PURPOSE;
    sourceRepositoryId: number;
    sourceOwner: string;
    sourceRepo: string;
    sourceRef: string;
    sourcePath: string;
    sourceContentSha256: string;
    policyDigest: string;
    configDigest: string;
  };
  publicationMode: 'disabled';
}

export interface NormalEngineQualificationSourceInput {
  fixtureId: string;
  source: {
    repository: FixturePin['repository'];
    prNumber: number;
    baseSha: string;
    headSha: string;
    changedPaths: string[];
    patches: Array<{ path: string; patch: string; sha256: string }>;
    revisions: Array<Record<string, unknown>>;
  };
}

export type NormalEngineQualificationArm =
  | 'single'
  | 'repair-introduction'
  | 'repair-head-history'
  | 'repair-head-repeat'
  | 'repair-head-empty-history'
  | 'repair-head-history-unavailable'
  | 'repair-head-verifier-unavailable'
  | 'provider-failure'
  | 'resource-exhaustion'
  | 'preflight-source-coverage-control'
  | 'p2-only'
  | 'large-crossfile'
  | 'adjudicator-recheck';

export type NormalEngineQualificationBudgetProfile = 'prepared-policy-default'
  | 'normal-canary-120s' | 'normal-canary-240s-capture-outside-child' | 'large-crossfile-canary-300s'
  | 'bifrost-auth-rejection-30s-one-request' | 'resource-exhaustion-60s-one-request'
  | 'source-coverage-preflight-15s' | 'required-history-preflight-15s';

export const NORMAL_ENGINE_QUALIFICATION_PLAN_ID = 'ws6-normal-canary-v1' as const;
export const NORMAL_ENGINE_QUALIFICATION_PLAN_DESCRIPTOR_PATH =
  'eval-baselines/competitive-review-benchmark/ws6-normal-canary-v1.json' as const;
export const NORMAL_ENGINE_QUALIFICATION_PLAN_DESCRIPTOR_SHA256 =
  '60f724e4ae3782ec8b5be7705d97d5dace662938570a34ac73bd566749e5dc99';
export const NORMAL_ENGINE_QUALIFICATION_PLAN_CASE_IDS = Object.freeze([
  'ws5-sequence-a-v1', 'ws5-sequence-b-v1', 'ws5-p2-display-sort-v1', 'ws5-large-crossfile-v1',
  'ws5-current-1dd-v2-p2', 'ws5-current-1dd-v2-sequence-a', 'ws5-current-1dd-v2-sequence-b',
  'ws5-current-1dd-v2-coverage-hole', 'ws5-current-1dd-v2-provider-failure',
  'ws5-current-1dd-v2-resource-exhaustion',
  'ws5-r2-c001', 'ws5-r2-c002', 'ws5-r2-c003', 'ws5-r2-c004',
] as const);

export interface NormalEngineQualificationPlanRequest {
  purpose: 'normal-engine-qualification-plan';
  planId: typeof NORMAL_ENGINE_QUALIFICATION_PLAN_ID;
  runId: string;
  runtime: NormalEngineQualificationRequest['runtime'];
  configurationVariant: NormalEngineQualificationConfigurationVariant;
  policy: NormalEngineQualificationRequest['policy'];
  publicationMode: 'disabled';
  captureHold: boolean;
}

export interface NormalEngineQualificationPlanReceipt {
  schemaVersion: 'ReviewYetiNormalQualificationPlan.v1';
  purpose: 'normal-engine-qualification-plan';
  planId: typeof NORMAL_ENGINE_QUALIFICATION_PLAN_ID;
  runId: string;
  descriptorSha256: string;
  runtime: { sourceRevision: string; workerImageDigest: string; runtimeManifestSha256: string };
  policy: {
    targetRepository: string;
    selectionPurpose: typeof QUALIFICATION_SELECTION_PURPOSE;
    configurationVariant: NormalEngineQualificationConfigurationVariant;
    source: { repositoryId: number; owner: string; repo: string; ref: string; path: string; contentSha256: string };
    effectivePolicyDigest: string;
    effectiveConfigDigest: string;
  };
  cases: Array<{
    arm: NormalEngineQualificationArm;
    caseId: string;
    runId: string;
    phase: NormalEngineQualificationReceipt['phase'];
    configurationVariant: NormalEngineQualificationConfigurationVariant;
    inputSha256: string;
    bundleSha256: string;
    receiptPath: string;
    receiptSha256: string;
    terminalStatus: NormalEngineQualificationReceipt['terminal']['status'];
    budgetProfile: NormalEngineQualificationBudgetProfile;
    providerIdentifiersPath: string | null;
    providerIdentifiersSha256: string | null;
    providerCaptureStatus: 'captured' | 'unavailable';
    providerCapturePath: string | null;
    providerCaptureSha256: string | null;
    providerCaptureUnavailableReason: typeof QUALIFICATION_PROVIDER_CAPTURE_UNAVAILABLE_REASONS[number] | null;
    composedResourcesPath: string | null;
    composedResourcesSha256: string | null;
    composedResourcesStatus: 'captured' | 'unavailable';
    composedResourcesUnavailableReason: typeof QUALIFICATION_RESOURCE_UNAVAILABLE_REASONS[number] | null;
  }>;
  historyArtifacts: Array<{
    kind: 'history' | 'verification-set' | 'verification';
    runId: string;
    sourceRunId: string | null;
    sequenceId: string;
    caseId: string;
    findingEventId: string | null;
    recordPath: string;
    recordSha256: string;
    sha256Path: string;
    sha256FileSha256: string;
  }>;
  historyArtifactSetComplete: boolean;
  caseCount: number;
  expectedReceiptCount: number;
  completedReceiptCount: number;
  receiptSetComplete: boolean;
  publication: {
    mode: 'disabled'; githubWrites: 0; appChecks: 0; reviews: 0; comments: 0;
    ordinaryGateTouched: false; promptsPersisted: false; responsesPersisted: false; providerCredentialsPersisted: false;
  };
  terminal: { status: 'completed' | 'failed'; startedAt: string; completedAt: string };
}

export type NormalEngineQualificationOutcomeClass =
  | 'completed_eligible'
  | 'completed_ineligible'
  | 'incomplete';

export type NormalEngineQualificationAgreement = 'agreement' | 'disagreement' | 'incomplete';

export function projectNormalEngineQualificationOutcomes(input: {
  workerConclusion: unknown;
  workerVerdict: unknown;
  workerCoverageComplete: unknown;
  gateDecision?: unknown;
  gateEvidenceValid: boolean;
}): {
  workerOutcomeClass: NormalEngineQualificationOutcomeClass;
  gateOutcomeClass: NormalEngineQualificationOutcomeClass;
  agreement: NormalEngineQualificationAgreement;
} {
  const workerOutcomeClass: NormalEngineQualificationOutcomeClass = input.workerCoverageComplete !== true
    || input.workerVerdict === 'INCOMPLETE'
    || (input.workerConclusion !== 'success' && input.workerConclusion !== 'failure')
    ? 'incomplete'
    : input.workerConclusion === 'success' && input.workerVerdict === 'SHIP'
      ? 'completed_eligible' : 'completed_ineligible';

  let gateOutcomeClass: NormalEngineQualificationOutcomeClass = 'incomplete';
  if (input.gateEvidenceValid && input.gateDecision && typeof input.gateDecision === 'object') {
    const gate = input.gateDecision as { status?: unknown; eligible?: unknown; reason?: unknown };
    if (gate.status === 'success' && gate.eligible === true) gateOutcomeClass = 'completed_eligible';
    else if (gate.status === 'failure' && gate.eligible === false
      && !['incomplete-review', 'infrastructure-failure', 'invalid-evidence'].includes(String(gate.reason))) {
      gateOutcomeClass = 'completed_ineligible';
    }
  }

  const agreement: NormalEngineQualificationAgreement = !input.gateEvidenceValid
    ? 'incomplete' : workerOutcomeClass === gateOutcomeClass ? 'agreement' : 'disagreement';
  return { workerOutcomeClass, gateOutcomeClass, agreement };
}

export interface NormalEngineQualificationReceipt {
  schemaVersion: 'ReviewYetiNormalQualification.v1';
  purpose: 'normal-engine-qualification';
  runId: string;
  arm: NormalEngineQualificationArm;
  phase: 'single' | 'repair-introduction' | 'repair-head' | 'same-head-recheck';
  target: {
    kind: 'public-synthetic-fixture';
    repositoryId: number;
    repository: string;
    prNumber: number;
    caseId: string;
    bundleVersion: string;
    bundleSha256: string;
    inputSha256: string;
    baseSha: string;
    headSha: string;
    diffSha256: string;
  };
  runtime: {
    sourceRevision: string;
    workerImageDigest: string;
    runtimeManifestSha256: string;
  };
  policy: {
    targetRepository: string;
    selectionPurpose: typeof QUALIFICATION_SELECTION_PURPOSE;
    configurationVariant: NormalEngineQualificationConfigurationVariant;
    source: {
      repositoryId: number;
      owner: string;
      repo: string;
      ref: string;
      path: string;
      contentSha256: string;
    };
    effectivePolicyDigest: string;
    effectiveConfigDigest: string;
    groundedEvidenceSemanticsVersion: typeof GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION;
    disputedBlockerAdjudicator: {
      state: 'unconfigured' | 'inactive' | 'available';
      modelAlias: string | null;
      reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
    };
    engine: 'composed';
    severityPolicy: 'review-yeti-severity.v2';
  };
  history: {
    purpose: 'normal-engine-qualification-history';
    source: 'none' | 'unavailable' | 'isolated-qualification-store' | 'empty-qualification-ablation' | 'empty-qualification-context';
    loadStatus: 'complete' | 'partial' | 'unavailable';
    snapshotIdSha256: string | null;
    contextDigest: string | null;
    parentRunIdSha256: string | null;
    authenticatedDisputeSelection: {
      findingFingerprint: string;
      path: string;
      priorFindingEventIdSha256: string;
      priorEvidenceDigest: string;
    } | null;
  };
  outcome: {
    workerOutcomeClass: NormalEngineQualificationOutcomeClass;
    gateOutcomeClass: NormalEngineQualificationOutcomeClass;
    agreement: NormalEngineQualificationAgreement;
    workerCompletionSha256: string | null;
    canonicalEvidenceSha256: string | null;
    gateDecisionSha256: string | null;
  };
  /** Private final finding text and source-window references needed to adjudicate the synthetic P1 claim. */
  canonicalReviewEvidence?: {
    decisionClassification: 'SHIP' | 'FIX_FIRST' | 'INCOMPLETE_REVIEW';
    counts: { p0Count: number; p1Count: number; p2Count: number; p3Count: number; nitCount: number };
    coverageComplete: boolean;
    quorumSatisfied: boolean;
    blockingFindings: Array<{ fingerprintSha256: string; severity: 'P0' | 'P1'; path: string; line?: number;
      title?: string; claim?: string; blockerEvidence?: { trigger: string; impact: string; violatedContract: string };
      verificationStatus: 'confirmed' | 'contradicted' | 'insufficient' | 'unavailable';
      causalScope: 'introduced' | 'exacerbated' | 'preexisting' | 'unproven';
      sourceReviewIdentitySha256: string | null; reviewIdentity?: { repository: string; baseSha: string; headSha: string } | null;
      scopeEvidenceSha256: string | null; blockerEvidenceSha256: string | null;
      citationEvidence?: { sourceWindowManifestDigest: string; usedCitationIds: string[];
        citations: Array<{ id: string; path: string; repository: string; side: 'head' | 'base' | 'diff';
          revisionSha: string; headSha: string; baseSha: string; sourceDigest: string;
          window: { id: string; role: string; startLine: number; endLine: number; windowSha256: string;
            fullContentSha256: string; regionDigest: string } | null }> } | null }>;
  } | null;
  preflight?: { control: 'source-coverage-unavailable'; sourceCoverage: 'unavailable';
    withheldPath: 'src/modules/module-01.ts'; physicalClientCalls: 0 } | { control: 'required-history-unavailable-transport';
    historyStatus: 'unavailable'; historyFailureClass: 'transport'; historySourceRunIdSha256: string; physicalClientCalls: 0 };
  composedLimits: {
    configuredTotalTurns: number;
    investigationTurns: number;
    verificationReserveTurns: number;
    maxFindings: number;
    maxConcurrentTasks: number;
    ambientOverrides: 'absent';
  };
  composedResourcesStatus: 'captured' | 'unavailable';
  composedResourcesPath: string | null;
  composedResourcesSha256: string | null;
  composedResourcesUnavailableReason: typeof QUALIFICATION_RESOURCE_UNAVAILABLE_REASONS[number] | null;
  groundedVerification: {
    evidenceSemanticsVersion: typeof GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION | null;
    callCount: number | null;
    outcomeCount: number | null;
    coverageComplete: boolean | null;
    routeReceipts: Array<{
      findingFingerprint: string;
      path: string;
      severity: 'P0' | 'P1' | 'P2' | 'P3' | 'NIT';
      status: 'confirmed' | 'contradicted' | 'insufficient';
      route: GroundedVerifierRouteV1;
    }>;
  };
  qualificationControl: 'none' | 'empty-history-ablation' | 'history-unavailable' | 'grounded-verifier-unavailable'
    | 'bifrost-auth-rejection-invalid-inference-key' | 'worker-deadline-test-60s-one-physical-request'
    | 'authenticated-adjudicator-recheck' | 'source-coverage-unavailable';
  testBudget: { profile: NormalEngineQualificationBudgetProfile; panelBudgetSeconds: number | null;
    maxPhysicalModelRequests: number | null; terminalDeadlineAt: string | null;
    resourceExhaustion: { status: 'observed' | 'not_observed'; physicalRequestCap: 1; logicalCompletionAttempts: number;
      physicalRequests: number; blockedPhysicalRequestAttempts: number; firstResponseHttpStatus: number | null;
      firstLogicalCompletionSucceeded: boolean } | null };
  provider: {
    identityStatus: 'unknown' | 'response_reported_unverified';
    upstreamProviderIdentity: 'unknown';
    exactBifrostLogStatus: 'not_available';
    privateIdentifiersSha256: string | null;
    captureStatus: 'captured' | 'unavailable';
    capturePath: string | null;
    captureSha256: string | null;
    captureUnavailableReason: typeof QUALIFICATION_PROVIDER_CAPTURE_UNAVAILABLE_REASONS[number] | null;
    calls: NormalEngineQualificationProviderCall[];
  };
  publication: {
    mode: 'disabled';
    githubWrites: 0;
    appChecks: 0;
    reviews: 0;
    comments: 0;
    ordinaryGateTouched: false;
    promptsPersisted: false;
    responsesPersisted: false;
    providerCredentialsPersisted: false;
  };
  terminal: {
    status: 'completed' | 'incomplete' | 'failed';
    startedAt: string;
    completedAt: string;
  };
}

export interface NormalEngineQualificationProviderCall {
  clientRequestIdSha256: string;
  bifrostLogRequestIdSha256: string;
  upstreamResponseRequestIdSha256: string | null;
  requestedAlias: string;
  requestedProviderPreference: string | null;
  requestedEffort: string | null;
  outputCap: number | null;
  stream: boolean | null;
  httpStatus: number | null;
  responseReportedModel: string | null;
  responseReportedProvider: string | null;
  responseHeaderRouteHints: string[];
  tokenUsage: { prompt: number | null; completion: number | null; total: number | null } | null;
  startedAt: string;
  headersAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  fetchFailureClass: 'connection' | 'timeout' | 'aborted' | 'http_error' | 'other' | null;
  contentPersisted: false;
  gatewayEvidence: {
    status: 'not_available' | 'headers_unverified';
    provider: string | null;
    originalModel: string | null;
    resolvedModel: string | null;
    fallbackIndex: number | null;
    requestType: string | null;
    upstreamLatencyMs: number | null;
    routingInfo: {
      provider: string | null;
      model: string | null;
      isFallback: string | null;
      primaryProvider: string | null;
      primaryModel: string | null;
      serverSideFallbackModel: string | null;
      aliasModelId: string | null;
      aliasModelName: string | null;
      aliasModelFamily: string | null;
    };
    exactLogRowStatus: 'not_available';
    parentRequestIdSha256: null;
    servedModel: null;
    serviceTier: null;
    speed: null;
    inferenceGeo: null;
  };
}

export const NORMAL_ENGINE_PROVIDER_CAPTURE_VERSION = 'NormalEngineProviderCapture.v1' as const;
export const NORMAL_ENGINE_PROVIDER_CAPTURE_PURPOSE = 'normal-engine-provider-capture' as const;

export type NormalEngineProviderCaptureValue<T> =
  | { availability: 'available'; value: T; unavailableReason: null }
  | { availability: 'unavailable'; value: null; unavailableReason: string };

export type NormalEngineProviderCaptureFailureClass = 'connection' | 'timeout' | 'aborted' | 'http_error' | 'other';
export type NormalEngineProviderCaptureSeverity = 'P0' | 'P1' | 'P2' | 'P3' | 'NIT';
export type NormalEngineProviderCaptureRoutePurpose = 'primary' | 'disputed-blocker-recheck';
export type NormalEngineProviderCaptureRouteRole = 'primary' | 'disputed-blocker-adjudicator';
export const NORMAL_ENGINE_PROVIDER_CAPTURE_HEADER_NAMES = [
  'x-bifrost-provider', 'x-bifrost-original-model', 'x-bifrost-resolved-model',
  'x-bifrost-fallback-index', 'x-bifrost-request-type', 'x-bifrost-upstream-latency-ms',
  'x-bifrost-routing-info-provider', 'x-bifrost-routing-info-model',
  'x-bifrost-routing-info-is-fallback', 'x-bifrost-routing-info-primary-provider',
  'x-bifrost-routing-info-primary-model', 'x-bifrost-routing-info-server-side-fallback-model',
  'x-bifrost-routing-info-alias-model-id', 'x-bifrost-routing-info-alias-model-name',
  'x-bifrost-routing-info-alias-model-family',
] as const;
export type NormalEngineProviderCaptureHeaderName = typeof NORMAL_ENGINE_PROVIDER_CAPTURE_HEADER_NAMES[number];

/** Only explicitly request-scoped verifier routing facts can enter a provider capture. */
export interface NormalEngineProviderCaptureRouteBindingInput {
  findingFingerprint?: string;
  severity?: NormalEngineProviderCaptureSeverity;
  purpose?: NormalEngineProviderCaptureRoutePurpose;
  requestedRole?: NormalEngineProviderCaptureRouteRole;
  appliedRole?: NormalEngineProviderCaptureRouteRole;
  configuredAlternateModel?: string | null;
  selectedModel?: string;
}

export interface NormalEngineProviderCaptureRouteBinding {
  findingFingerprint: NormalEngineProviderCaptureValue<string>;
  severity: NormalEngineProviderCaptureValue<NormalEngineProviderCaptureSeverity>;
  purpose: NormalEngineProviderCaptureValue<NormalEngineProviderCaptureRoutePurpose>;
  requestedRole: NormalEngineProviderCaptureValue<NormalEngineProviderCaptureRouteRole>;
  appliedRole: NormalEngineProviderCaptureValue<NormalEngineProviderCaptureRouteRole>;
  configuredAlternateModel: NormalEngineProviderCaptureValue<string | null>;
  selectedModel: NormalEngineProviderCaptureValue<string>;
}

export interface NormalEngineProviderCaptureBinding {
  runId: string;
  phase: NormalEngineQualificationReceipt['phase'];
  caseId: string;
  runtime: NormalEngineQualificationReceipt['runtime'];
  target: NormalEngineQualificationReceipt['target'];
  policy: Pick<NormalEngineQualificationReceipt['policy'], 'targetRepository' | 'selectionPurpose'
    | 'configurationVariant' | 'source' | 'effectivePolicyDigest' | 'effectiveConfigDigest'>;
  groundedEvidenceSemanticsVersion: typeof GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION;
}

export interface NormalEngineProviderCaptureRequest {
  physicalOrdinal: number;
  dispatchStartedAt: string;
  logicalCallIdSha256: NormalEngineProviderCaptureValue<string>;
  cidSha256: string;
  body: {
    status: 'captured' | 'unavailable';
    sha256: string | null;
    byteCount: number | null;
    unavailableReason: string | null;
  };
  requestedModel: NormalEngineProviderCaptureValue<string>;
  requestedEffort: NormalEngineProviderCaptureValue<string>;
  outputCap: NormalEngineProviderCaptureValue<number>;
  status: 'dispatching' | 'response_received' | 'fetch_failed';
  httpStatus: NormalEngineProviderCaptureValue<number>;
  responseHeaders: Record<NormalEngineProviderCaptureHeaderName, NormalEngineProviderCaptureValue<string>>;
  fetchFailureClass: NormalEngineProviderCaptureValue<NormalEngineProviderCaptureFailureClass | null>;
  routeBinding: NormalEngineProviderCaptureRouteBinding;
  completedAt: NormalEngineProviderCaptureValue<string>;
  durationMs: NormalEngineProviderCaptureValue<number>;
}

export interface NormalEngineProviderCaptureV1 {
  schemaVersion: typeof NORMAL_ENGINE_PROVIDER_CAPTURE_VERSION;
  purpose: typeof NORMAL_ENGINE_PROVIDER_CAPTURE_PURPOSE;
  runId: string;
  phase: NormalEngineQualificationReceipt['phase'];
  caseId: string;
  runtime: NormalEngineQualificationReceipt['runtime'];
  target: NormalEngineQualificationReceipt['target'];
  policy: NormalEngineProviderCaptureBinding['policy'];
  groundedEvidenceSemanticsVersion: typeof GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION;
  requests: NormalEngineProviderCaptureRequest[];
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const shaSchema = z.string().regex(SHA_PATTERN);
const repositoryPathSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const relativePolicyPathSchema = z.string().min(1).max(512).refine((path) => !path.startsWith('/')
  && !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  && !/[\\\u0000-\u001f\u007f]/u.test(path));
const qualificationProviderCallSchema = z.object({
  clientRequestIdSha256: digestSchema,
  bifrostLogRequestIdSha256: digestSchema,
  upstreamResponseRequestIdSha256: digestSchema.nullable(),
  requestedAlias: z.string().min(1).max(256),
  requestedProviderPreference: z.string().max(256).nullable(),
  requestedEffort: z.string().max(32).nullable(),
  outputCap: z.number().int().positive().safe().nullable(),
  stream: z.boolean().nullable(),
  httpStatus: z.number().int().min(100).max(599).safe().nullable(),
  responseReportedModel: z.string().max(256).nullable(),
  responseReportedProvider: z.string().max(256).nullable(),
  responseHeaderRouteHints: z.array(z.string().max(120)).max(16),
  tokenUsage: z.object({
    prompt: z.number().int().nonnegative().safe().nullable(),
    completion: z.number().int().nonnegative().safe().nullable(),
    total: z.number().int().nonnegative().safe().nullable(),
  }).strict().nullable(),
  startedAt: z.string().datetime(),
  headersAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative().safe().nullable(),
  fetchFailureClass: z.enum(['connection', 'timeout', 'aborted', 'http_error', 'other']).nullable(),
  contentPersisted: z.literal(false),
  gatewayEvidence: z.object({
    status: z.enum(['not_available', 'headers_unverified']),
    provider: z.string().max(120).nullable(),
    originalModel: z.string().max(256).nullable(),
    resolvedModel: z.string().max(256).nullable(),
    fallbackIndex: z.number().int().nonnegative().safe().nullable(),
    requestType: z.string().max(120).nullable(),
    upstreamLatencyMs: z.number().int().nonnegative().safe().nullable(),
    routingInfo: z.object({
      provider: z.string().max(120).nullable(), model: z.string().max(256).nullable(),
      isFallback: z.string().max(16).nullable(), primaryProvider: z.string().max(120).nullable(),
      primaryModel: z.string().max(256).nullable(), serverSideFallbackModel: z.string().max(256).nullable(),
      aliasModelId: z.string().max(256).nullable(), aliasModelName: z.string().max(256).nullable(),
      aliasModelFamily: z.string().max(256).nullable(),
    }).strict(),
    exactLogRowStatus: z.literal('not_available'),
    parentRequestIdSha256: z.null(), servedModel: z.null(), serviceTier: z.null(), speed: z.null(), inferenceGeo: z.null(),
  }).strict(),
}).strict();
const qualificationGroundedVerifierRouteSchema = z.object({
  findingFingerprint: z.string().min(1).max(500),
  path: z.string().min(1).max(4096),
  severity: z.enum(['P0', 'P1', 'P2', 'P3', 'NIT']),
  status: z.enum(['confirmed', 'contradicted', 'insufficient']),
  route: groundedVerifierRouteV1Schema,
}).strict();

const qualificationReceiptSchema = z.object({
  schemaVersion: z.literal('ReviewYetiNormalQualification.v1'),
  purpose: z.literal('normal-engine-qualification'),
  runId: z.string().regex(RUN_ID_PATTERN),
  arm: z.enum(['single', 'repair-introduction', 'repair-head-history', 'repair-head-repeat',
    'repair-head-empty-history', 'repair-head-history-unavailable', 'repair-head-verifier-unavailable',
    'provider-failure', 'resource-exhaustion', 'preflight-source-coverage-control', 'p2-only', 'large-crossfile', 'adjudicator-recheck']),
  phase: z.enum(['single', 'repair-introduction', 'repair-head', 'same-head-recheck']),
  target: z.object({
    kind: z.literal('public-synthetic-fixture'),
    repositoryId: z.number().int().positive().safe(),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    prNumber: z.number().int().positive().safe(),
    caseId: z.string().min(1).max(100),
    bundleVersion: z.string().min(1).max(100),
    bundleSha256: digestSchema, inputSha256: digestSchema, diffSha256: digestSchema,
    baseSha: z.string().regex(SHA_PATTERN), headSha: z.string().regex(SHA_PATTERN),
  }).strict(),
  runtime: z.object({
    sourceRevision: z.string().regex(SHA_PATTERN),
    workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    runtimeManifestSha256: digestSchema,
  }).strict(),
  policy: z.object({
    targetRepository: repositoryPathSchema,
    selectionPurpose: z.literal(QUALIFICATION_SELECTION_PURPOSE),
    configurationVariant: z.enum(['prepared-policy-default-v1', NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT]),
    source: z.object({
      repositoryId: z.number().int().positive().safe(), owner: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
      repo: z.string().regex(/^[A-Za-z0-9_.-]+$/u), ref: z.string().regex(SHA_PATTERN),
      path: relativePolicyPathSchema, contentSha256: digestSchema,
    }).strict(),
    effectivePolicyDigest: digestSchema, effectiveConfigDigest: digestSchema,
    groundedEvidenceSemanticsVersion: z.literal(GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION),
    disputedBlockerAdjudicator: z.object({
      state: z.enum(['unconfigured', 'inactive', 'available']),
      modelAlias: z.string().min(1).max(256).nullable(),
      reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable(),
    }).strict(),
    engine: z.literal('composed'), severityPolicy: z.literal('review-yeti-severity.v2'),
  }).strict(),
  history: z.object({
    purpose: z.literal('normal-engine-qualification-history'),
    source: z.enum(['none', 'unavailable', 'isolated-qualification-store', 'empty-qualification-ablation', 'empty-qualification-context']),
    loadStatus: z.enum(['complete', 'partial', 'unavailable']),
    snapshotIdSha256: digestSchema.nullable(), contextDigest: digestSchema.nullable(), parentRunIdSha256: digestSchema.nullable(),
    authenticatedDisputeSelection: z.object({ findingFingerprint: z.string().min(1).max(500),
      path: z.string().min(1).max(4096), priorFindingEventIdSha256: digestSchema, priorEvidenceDigest: digestSchema }).strict().nullable(),
  }).strict(),
  outcome: z.object({
    workerOutcomeClass: z.enum(['completed_eligible', 'completed_ineligible', 'incomplete']),
    gateOutcomeClass: z.enum(['completed_eligible', 'completed_ineligible', 'incomplete']),
    agreement: z.enum(['agreement', 'disagreement', 'incomplete']),
    workerCompletionSha256: digestSchema.nullable(), canonicalEvidenceSha256: digestSchema.nullable(),
    gateDecisionSha256: digestSchema.nullable(),
  }).strict(),
  preflight: z.discriminatedUnion('control', [
    z.object({ control: z.literal('source-coverage-unavailable'), sourceCoverage: z.literal('unavailable'),
      withheldPath: z.literal('src/modules/module-01.ts'), physicalClientCalls: z.literal(0) }).strict(),
    z.object({ control: z.literal('required-history-unavailable-transport'), historyStatus: z.literal('unavailable'),
      historyFailureClass: z.literal('transport'), historySourceRunIdSha256: digestSchema, physicalClientCalls: z.literal(0) }).strict(),
  ]).optional(),
  canonicalReviewEvidence: z.object({
    decisionClassification: z.enum(['SHIP', 'FIX_FIRST', 'INCOMPLETE_REVIEW']),
    counts: z.object({ p0Count: z.number().int().nonnegative().safe(), p1Count: z.number().int().nonnegative().safe(),
      p2Count: z.number().int().nonnegative().safe(), p3Count: z.number().int().nonnegative().safe(),
      nitCount: z.number().int().nonnegative().safe() }).strict(),
    coverageComplete: z.boolean(), quorumSatisfied: z.boolean(),
    blockingFindings: z.array(z.object({ fingerprintSha256: digestSchema, severity: z.enum(['P0', 'P1']),
      path: z.string().min(1).max(4096), line: z.number().int().positive().safe().optional(),
      title: z.string().min(1).max(4_000).optional(), claim: z.string().min(1).max(16_000).optional(),
      blockerEvidence: z.object({ trigger: z.string().min(12).max(2_000),
        impact: z.string().min(12).max(2_000), violatedContract: z.string().min(12).max(2_000) }).strict().optional(),
      verificationStatus: z.enum(['confirmed', 'contradicted', 'insufficient', 'unavailable']),
      causalScope: z.enum(['introduced', 'exacerbated', 'preexisting', 'unproven']),
      sourceReviewIdentitySha256: digestSchema.nullable(),
      reviewIdentity: z.object({ repository: z.string().min(3).max(500), baseSha: shaSchema, headSha: shaSchema }).strict().nullable().optional(),
      scopeEvidenceSha256: digestSchema.nullable(), blockerEvidenceSha256: digestSchema.nullable(),
      citationEvidence: z.object({ sourceWindowManifestDigest: digestSchema,
        usedCitationIds: z.array(z.string().min(1).max(4096)).max(64),
        citations: z.array(z.object({ id: z.string().min(1).max(4096), path: z.string().min(1).max(4096),
          repository: z.string().min(3).max(500), side: z.enum(['head', 'base', 'diff']), revisionSha: shaSchema,
          headSha: shaSchema, baseSha: shaSchema, sourceDigest: digestSchema,
          window: z.object({ id: digestSchema, role: z.string().min(1).max(64), startLine: z.number().int().nonnegative().safe(),
            endLine: z.number().int().nonnegative().safe(), windowSha256: digestSchema,
            fullContentSha256: digestSchema, regionDigest: digestSchema }).strict().nullable() }).strict()).max(64) }).strict().nullable().optional() }).strict()).max(10_000),
  }).strict().nullable().optional(),
  composedLimits: z.object({
    configuredTotalTurns: z.number().int().positive().safe(),
    investigationTurns: z.number().int().positive().safe(),
    verificationReserveTurns: z.number().int().nonnegative().safe(),
    maxFindings: z.number().int().positive().safe(),
    maxConcurrentTasks: z.number().int().positive().safe(),
    ambientOverrides: z.literal('absent'),
  }).strict().superRefine((limits, context) => {
    if (limits.configuredTotalTurns !== limits.investigationTurns + limits.verificationReserveTurns) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['configuredTotalTurns'],
        message: 'qualification composed limits must account for the verification reserve' });
    }
  }),
  composedResourcesStatus: z.enum(['captured', 'unavailable']),
  composedResourcesPath: z.string().regex(/^normal-engine-qualification-store\/nq_[a-f0-9]{32}\/(?:single|repair-introduction|repair-head|same-head-recheck)\/[a-z0-9][a-z0-9_-]{0,99}\/composed-resources\.record\/composed-runtime-resources\.json$/u).nullable(),
  composedResourcesSha256: digestSchema.nullable(),
  composedResourcesUnavailableReason: z.enum(QUALIFICATION_RESOURCE_UNAVAILABLE_REASONS).nullable(),
  groundedVerification: z.object({
    evidenceSemanticsVersion: z.literal(GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION).nullable(),
    callCount: z.number().int().nonnegative().safe().nullable(),
    outcomeCount: z.number().int().nonnegative().safe().nullable(),
    coverageComplete: z.boolean().nullable(),
    routeReceipts: z.array(qualificationGroundedVerifierRouteSchema).max(10_000),
  }).strict().superRefine((verification, context) => {
    if (verification.evidenceSemanticsVersion === null
      ? verification.callCount !== null || verification.outcomeCount !== null || verification.coverageComplete !== null
        || verification.routeReceipts.length !== 0
      : verification.callCount === null || verification.outcomeCount === null || verification.coverageComplete === null
        || verification.routeReceipts.length > verification.outcomeCount) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidenceSemanticsVersion'],
        message: 'qualification verifier route evidence is inconsistent' });
    }
    if (new Set(verification.routeReceipts.map((route) => route.findingFingerprint)).size !== verification.routeReceipts.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['routeReceipts'], message: 'qualification route fingerprints must be unique' });
    }
  }),
  qualificationControl: z.enum(['none', 'empty-history-ablation', 'history-unavailable',
    'grounded-verifier-unavailable', 'bifrost-auth-rejection-invalid-inference-key',
    'worker-deadline-test-60s-one-physical-request', 'authenticated-adjudicator-recheck', 'source-coverage-unavailable']),
  testBudget: z.object({
    profile: z.enum(['prepared-policy-default', 'normal-canary-120s', 'normal-canary-240s-capture-outside-child', 'large-crossfile-canary-300s',
      'bifrost-auth-rejection-30s-one-request', 'resource-exhaustion-60s-one-request', 'source-coverage-preflight-15s',
      'required-history-preflight-15s']),
    panelBudgetSeconds: z.number().int().positive().safe().nullable(),
    maxPhysicalModelRequests: z.number().int().positive().safe().nullable(),
    terminalDeadlineAt: z.string().datetime().nullable(),
    resourceExhaustion: z.object({
      status: z.enum(['observed', 'not_observed']),
      physicalRequestCap: z.literal(1),
      logicalCompletionAttempts: z.number().int().nonnegative().safe(),
      physicalRequests: z.number().int().nonnegative().safe(),
      blockedPhysicalRequestAttempts: z.number().int().nonnegative().safe(),
      firstResponseHttpStatus: z.number().int().min(100).max(599).nullable(),
      firstLogicalCompletionSucceeded: z.boolean(),
    }).strict().nullable(),
  }).strict(),
  provider: z.object({
    identityStatus: z.enum(['unknown', 'response_reported_unverified']),
    upstreamProviderIdentity: z.literal('unknown'), exactBifrostLogStatus: z.literal('not_available'),
    privateIdentifiersSha256: digestSchema.nullable(),
    captureStatus: z.enum(['captured', 'unavailable']),
    capturePath: z.string().regex(/^normal-engine-qualification-store\/nq_[a-f0-9]{32}\/(?:single|repair-introduction|repair-head|same-head-recheck)\/[a-z0-9][a-z0-9_-]{0,99}\/provider-capture\.record\/provider-capture\.json$/u).nullable(),
    captureSha256: digestSchema.nullable(),
    captureUnavailableReason: z.enum(QUALIFICATION_PROVIDER_CAPTURE_UNAVAILABLE_REASONS).nullable(),
    calls: z.array(qualificationProviderCallSchema).max(10_000),
  }).strict(),
  publication: z.object({
    mode: z.literal('disabled'), githubWrites: z.literal(0), appChecks: z.literal(0),
    reviews: z.literal(0), comments: z.literal(0), ordinaryGateTouched: z.literal(false),
    promptsPersisted: z.literal(false), responsesPersisted: z.literal(false), providerCredentialsPersisted: z.literal(false),
  }).strict(),
  terminal: z.object({
    status: z.enum(['completed', 'incomplete', 'failed']),
    startedAt: z.string().datetime(), completedAt: z.string().datetime(),
  }).strict(),
}).strict();

const OFFICIAL_REVIEW_FIELDS = new Set([
  'verdict', 'conclusion', 'eligible', 'reviewCompleted', 'mergeEligible', 'checkId', 'appId',
  'appCheckId', 'gateCheckId', 'expectedOutcome', 'oracle',
]);

function hasOfficialReviewField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasOfficialReviewField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => OFFICIAL_REVIEW_FIELDS.has(key) || hasOfficialReviewField(child));
}

export function assertNormalEngineQualificationReceipt(input: unknown): NormalEngineQualificationReceipt {
  const parsed = qualificationReceiptSchema.safeParse(input);
  if (!parsed.success || hasOfficialReviewField(input)) {
    throw new Error('normal-engine qualification receipt contract is invalid');
  }
  const pin = FIXTURE_PINS.find((entry) => entry.caseId === parsed.data.target.caseId);
  if (!pin || !armAllowedForPin(pin, parsed.data.arm) || parsed.data.phase !== phaseForArm(parsed.data.arm)
    || parsed.data.target.bundleVersion !== pin.bundleVersion || parsed.data.target.bundleSha256 !== pin.bundleSha256
    || parsed.data.target.inputSha256 !== pin.sha256 || parsed.data.target.repositoryId !== pin.repository.repositoryId
    || parsed.data.target.repository !== `${pin.repository.owner}/${pin.repository.repo}`
    || parsed.data.target.prNumber !== pin.prNumber || parsed.data.target.baseSha !== pin.baseSha
    || parsed.data.target.headSha !== pin.headSha) {
    throw new Error('normal-engine qualification fixture identity is invalid');
  }
  if (parsed.data.policy.targetRepository !== `${parsed.data.policy.source.owner}/${parsed.data.policy.source.repo}`) {
    throw new Error('normal-engine qualification policy target/source binding is invalid');
  }
  const expectedResourcesPath = normalEngineQualificationComposedResourcesRelativePath(parsed.data.runId,
    parsed.data.phase, parsed.data.target.caseId);
  const resourceCaptured = parsed.data.composedResourcesStatus === 'captured';
  if ((resourceCaptured && (parsed.data.composedResourcesPath !== expectedResourcesPath
      || parsed.data.composedResourcesSha256 === null || parsed.data.composedResourcesUnavailableReason !== null))
    || (!resourceCaptured && (parsed.data.composedResourcesPath !== null || parsed.data.composedResourcesSha256 !== null
      || parsed.data.composedResourcesUnavailableReason === null))) {
    throw new Error('normal-engine qualification composed resource sidecar binding is invalid');
  }
  if (parsed.data.terminal.status === 'completed' && !resourceCaptured) {
    throw new Error('normal-engine qualification completed receipt lacks composed resource evidence');
  }
  const expectedProviderCapturePath = `normal-engine-qualification-store/${parsed.data.runId}/${parsed.data.phase}/${parsed.data.target.caseId}/provider-capture.record/provider-capture.json`;
  const captureAvailable = parsed.data.provider.captureStatus === 'captured';
  if ((captureAvailable && (parsed.data.provider.capturePath !== expectedProviderCapturePath
      || parsed.data.provider.captureSha256 === null || parsed.data.provider.captureUnavailableReason !== null))
    || (!captureAvailable && (parsed.data.provider.capturePath !== null || parsed.data.provider.captureSha256 !== null
      || parsed.data.provider.captureUnavailableReason === null))) {
    throw new Error('normal-engine qualification provider capture sidecar binding is invalid');
  }
  if (parsed.data.terminal.status === 'completed' && !captureAvailable) {
    throw new Error('normal-engine qualification completed receipt lacks provider capture evidence');
  }
  const adjudicator = parsed.data.policy.disputedBlockerAdjudicator;
  const expectedConfiguredAlternate = adjudicator.state === 'available' ? adjudicator.modelAlias : null;
  for (const observation of parsed.data.groundedVerification.routeReceipts) {
    if (observation.route.configuredAlternateModel !== expectedConfiguredAlternate
      || (observation.route.appliedRole === 'disputed-blocker-adjudicator'
        && (adjudicator.state !== 'available' || observation.route.selectedModel !== adjudicator.modelAlias))) {
      throw new Error('normal-engine qualification verifier route disagrees with the prepared adjudicator selector');
    }
  }
  if ((adjudicator.state === 'available') !== (adjudicator.modelAlias !== null && adjudicator.reasoningEffort !== null)) {
    throw new Error('normal-engine qualification adjudicator selector metadata is inconsistent');
  }
  if (parsed.data.terminal.status === 'completed'
    && (parsed.data.groundedVerification.evidenceSemanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
      || parsed.data.groundedVerification.callCount === null || parsed.data.groundedVerification.outcomeCount === null
      || parsed.data.groundedVerification.coverageComplete !== true
      || parsed.data.outcome.workerCompletionSha256 === null || parsed.data.outcome.canonicalEvidenceSha256 === null
      || parsed.data.outcome.gateDecisionSha256 === null || parsed.data.outcome.agreement !== 'agreement'
      || parsed.data.outcome.workerOutcomeClass === 'incomplete' || parsed.data.outcome.gateOutcomeClass === 'incomplete')) {
    throw new Error('normal-engine qualification completed receipt lacks agreed complete grounded v2 evidence');
  }
  const exhaustion = parsed.data.testBudget.resourceExhaustion;
  if (parsed.data.arm === 'resource-exhaustion') {
    const observed = exhaustion?.status === 'observed'
      && exhaustion.physicalRequestCap === 1
      && exhaustion.physicalRequests === 1
      && exhaustion.blockedPhysicalRequestAttempts > 0
      && exhaustion.firstResponseHttpStatus === 200
      && exhaustion.firstLogicalCompletionSucceeded;
    const incompleteWorkerAndGate = parsed.data.outcome.workerOutcomeClass === 'incomplete'
      && parsed.data.outcome.gateOutcomeClass === 'incomplete';
    if (parsed.data.testBudget.profile !== 'resource-exhaustion-60s-one-request'
      || parsed.data.testBudget.panelBudgetSeconds !== 60 || parsed.data.testBudget.maxPhysicalModelRequests !== 1
      || !exhaustion || exhaustion.physicalRequests > 1
      || exhaustion.logicalCompletionAttempts < exhaustion.physicalRequests
      || (exhaustion.status === 'observed' && (exhaustion.blockedPhysicalRequestAttempts === 0
        || exhaustion.physicalRequests !== 1))
      || (exhaustion.status === 'not_observed' && exhaustion.blockedPhysicalRequestAttempts !== 0)
      || (exhaustion.firstLogicalCompletionSucceeded
        && (exhaustion.physicalRequests !== 1 || exhaustion.firstResponseHttpStatus !== 200))
      || (parsed.data.terminal.status === 'completed')
      || (parsed.data.terminal.status === 'incomplete' && (!observed || !incompleteWorkerAndGate))) {
      throw new Error('normal-engine qualification resource-exhaustion control evidence is invalid');
    }
  } else if (exhaustion !== null) {
    throw new Error('normal-engine qualification resource-exhaustion evidence is not allowed for this arm');
  }
  if (parsed.data.arm === 'adjudicator-recheck') {
    const selected = parsed.data.history.authenticatedDisputeSelection;
    const selectedRoutes = parsed.data.groundedVerification.routeReceipts.filter((row) =>
      row.route.appliedRole === 'disputed-blocker-adjudicator');
    if (parsed.data.policy.configurationVariant !== NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT
      || adjudicator.state !== 'available' || parsed.data.history.source !== 'isolated-qualification-store'
      || parsed.data.history.loadStatus !== 'complete' || parsed.data.history.snapshotIdSha256 === null
      || parsed.data.history.contextDigest === null || parsed.data.history.parentRunIdSha256 === null
      || (parsed.data.terminal.status === 'completed'
        && (!selected || selectedRoutes.length !== 1
          || selectedRoutes[0]!.findingFingerprint !== selected.findingFingerprint
          || selectedRoutes[0]!.path !== selected.path
          || selectedRoutes[0]!.status === 'insufficient'
          || selectedRoutes[0]!.route.configuredAlternateModel !== adjudicator.modelAlias
          || selectedRoutes[0]!.route.selectedModel !== adjudicator.modelAlias
          || parsed.data.outcome.agreement !== 'agreement'
          || parsed.data.outcome.workerOutcomeClass === 'incomplete'
          || parsed.data.outcome.gateOutcomeClass === 'incomplete'
          || parsed.data.groundedVerification.coverageComplete !== true))) {
      throw new Error('normal-engine qualification adjudicator recheck receipt is incomplete');
    }
  }
  return parsed.data;
}

function canonicalQualificationJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalQualificationJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalQualificationJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface PersistedQualificationReceipt {
  receiptPath: string;
  sha256Path: string;
  receiptSha256: string;
  idempotent: boolean;
}

const privateProviderIdentifierSchema = z.object({
  callerRequestId: z.string().uuid(),
  bifrostLogRequestId: z.string().uuid(),
  upstreamResponseRequestId: z.string().uuid().nullable(),
}).strict().refine((row) => row.callerRequestId === row.bifrostLogRequestId,
  'Bifrost request ID must remain the original caller request ID');

export interface PersistedQualificationProviderIdentifiers {
  identifiersPath: string;
  sha256Path: string;
  privateIdentifiersSha256: string;
  idempotent: boolean;
}

export interface PersistedNormalEngineQualificationComposedResources {
  path: string;
  sha256: string;
  idempotent: boolean;
}

/** Stores only validated task/path/config evidence; model prompts and responses are not included. */
export async function persistNormalEngineQualificationComposedResources(
  input: unknown,
  runId: string,
  phase: NormalEngineQualificationReceipt['phase'],
  caseId: string,
  rootDirectory: string = NORMAL_ENGINE_QUALIFICATION_STORE_ROOT,
): Promise<PersistedNormalEngineQualificationComposedResources> {
  const relativePath = normalEngineQualificationComposedResourcesRelativePath(runId, phase, caseId);
  const parsed = composedRuntimeResourcesSchema.safeParse(input);
  if (!parsed.success || parsed.data.stage !== 'worker_completion') {
    throw new Error('normal-engine qualification composed resource contract is invalid');
  }
  const body = `${JSON.stringify(parsed.data, null, 2)}\n`;
  const digest = createHash('sha256').update(body, 'utf8').digest('hex');
  const directory = join(rootDirectory, runId, phase, caseId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('normal-engine qualification composed resource directory is invalid');
  }
  await chmod(directory, 0o700);
  const recordDirectory = join(directory, 'composed-resources.record');
  const resourcePath = join(recordDirectory, 'composed-runtime-resources.json');
  const sha256Path = join(recordDirectory, 'composed-runtime-resources.sha256');
  const readExisting = async (): Promise<PersistedNormalEngineQualificationComposedResources | undefined> => {
    try {
      const [existingBody, existingDigest] = await Promise.all([readFile(resourcePath, 'utf8'), readFile(sha256Path, 'utf8')]);
      const actualDigest = createHash('sha256').update(existingBody, 'utf8').digest('hex');
      if (actualDigest !== existingDigest.trim()) throw new Error('normal-engine qualification composed resource store is corrupt');
      if (actualDigest !== digest || existingBody !== body) {
        throw new Error('normal-engine qualification composed resource identity conflict');
      }
      return { path: relativePath, sha256: actualDigest, idempotent: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const existing = await readExisting();
  if (existing) return existing;
  const temporaryDirectory = join(directory, `.tmp-composed-resources-${randomUUID()}`);
  await mkdir(temporaryDirectory, { mode: 0o700 });
  try {
    const resourceFile = await open(join(temporaryDirectory, 'composed-runtime-resources.json'), 'wx', 0o600);
    try { await resourceFile.writeFile(body, 'utf8'); await resourceFile.sync(); }
    finally { await resourceFile.close(); }
    const digestFile = await open(join(temporaryDirectory, 'composed-runtime-resources.sha256'), 'wx', 0o600);
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
  return { path: relativePath, sha256: digest, idempotent: false };
}

/** Exact nonsecret request IDs are retained only in this private, mode-0600 qualification sidecar. */
export async function persistNormalEngineQualificationProviderIdentifiers(
  input: unknown,
  runId: string,
  phase: NormalEngineQualificationReceipt['phase'],
  caseId: string,
  rootDirectory: string = NORMAL_ENGINE_QUALIFICATION_STORE_ROOT,
): Promise<PersistedQualificationProviderIdentifiers> {
  if (!RUN_ID_PATTERN.test(runId) || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(caseId)) {
    throw new Error('normal-engine qualification provider identifier identity is invalid');
  }
  const rows = z.array(privateProviderIdentifierSchema).max(10_000).safeParse(input);
  if (!rows.success) throw new Error('normal-engine qualification provider identifier contract is invalid');
  const body = `${JSON.stringify(rows.data, null, 2)}\n`;
  const digest = createHash('sha256').update(body, 'utf8').digest('hex');
  const directory = join(rootDirectory, runId, phase, caseId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('normal-engine qualification provider identifier path is invalid');
  }
  await chmod(directory, 0o700);
  const recordDirectory = join(directory, 'provider-identifiers.record');
  const identifiersPath = join(recordDirectory, 'provider-identifiers.json');
  const sha256Path = join(recordDirectory, 'provider-identifiers.sha256');
  const readExisting = async (): Promise<PersistedQualificationProviderIdentifiers | undefined> => {
    try {
      const [existingBody, existingDigest] = await Promise.all([readFile(identifiersPath, 'utf8'), readFile(sha256Path, 'utf8')]);
      const actualDigest = createHash('sha256').update(existingBody, 'utf8').digest('hex');
      if (actualDigest !== existingDigest.trim()) throw new Error('normal-engine qualification provider identifier store is corrupt');
      if (actualDigest !== digest || existingBody !== body) {
        throw new Error('normal-engine qualification provider identifier identity conflict');
      }
      return { identifiersPath, sha256Path, privateIdentifiersSha256: digest, idempotent: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const existing = await readExisting();
  if (existing) return existing;
  const temporaryDirectory = join(directory, `.tmp-provider-identifiers-${randomUUID()}`);
  await mkdir(temporaryDirectory, { mode: 0o700 });
  try {
    const data = await open(join(temporaryDirectory, 'provider-identifiers.json'), 'wx', 0o600);
    try { await data.writeFile(body, 'utf8'); await data.sync(); }
    finally { await data.close(); }
    const checksum = await open(join(temporaryDirectory, 'provider-identifiers.sha256'), 'wx', 0o600);
    try { await checksum.writeFile(`${digest}\n`, 'utf8'); await checksum.sync(); }
    finally { await checksum.close(); }
    try { await rename(temporaryDirectory, recordDirectory); }
    catch (error) {
      const raced = await readExisting();
      if (raced) return raced;
      throw error;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return { identifiersPath, sha256Path, privateIdentifiersSha256: digest, idempotent: false };
}

export async function persistNormalEngineQualificationReceipt(
  input: unknown,
  rootDirectory: string = NORMAL_ENGINE_QUALIFICATION_STORE_ROOT,
): Promise<PersistedQualificationReceipt> {
  const receipt = assertNormalEngineQualificationReceipt(input);
  const body = `${JSON.stringify(JSON.parse(canonicalQualificationJson(receipt)), null, 2)}\n`;
  const receiptBytes = Buffer.from(body, 'utf8');
  const digest = createHash('sha256').update(receiptBytes).digest('hex');
  const digestBytes = Buffer.from(`${digest}\n`, 'utf8');
  const storeRoot = resolve(rootDirectory);
  const runDirectory = join(storeRoot, receipt.runId);
  const finalDirectory = join(runDirectory, receipt.phase, receipt.target.caseId);
  const receiptPath = join(finalDirectory, 'receipt.json');
  const sha256Path = join(finalDirectory, 'receipt.sha256');
  const phaseDirectory = join(runDirectory, receipt.phase);

  const ensureDirectory = async (directoryPath: string, errorMessage: string, createParents = false) => {
    if (createParents) await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    else {
      try { await mkdir(directoryPath, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const info = await lstat(directoryPath);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(errorMessage);
    await chmod(directoryPath, 0o700);
  };
  await ensureDirectory(storeRoot, 'normal-engine qualification store path is invalid', true);
  await ensureDirectory(runDirectory, 'normal-engine qualification store path is invalid');
  await ensureDirectory(phaseDirectory, 'normal-engine qualification store path is invalid');
  await ensureDirectory(finalDirectory, 'normal-engine qualification receipt directory is invalid');

  const readPrivateFile = async (filePath: string): Promise<Buffer | undefined> => {
    try {
      const info = await lstat(filePath);
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
        throw new Error('normal-engine qualification receipt file is invalid');
      }
      return await readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const readExisting = async (): Promise<PersistedQualificationReceipt | undefined> => {
    const [existingBody, existingDigest] = await Promise.all([
      readPrivateFile(receiptPath), readPrivateFile(sha256Path),
    ]);
    if (!existingBody && !existingDigest) return undefined;
    if (existingBody) {
      const actualDigest = createHash('sha256').update(existingBody).digest('hex');
      if (actualDigest !== digest || !existingBody.equals(receiptBytes)) {
        throw new Error('normal-engine qualification receipt identity conflict');
      }
      if (existingDigest && existingDigest.toString('utf8').trim() !== actualDigest) {
        throw new Error('normal-engine qualification receipt store is corrupt');
      }
      if (existingDigest) return { receiptPath, sha256Path, receiptSha256: actualDigest, idempotent: true };
    }
    if (existingDigest && existingDigest.toString('utf8').trim() !== digest) {
      throw new Error('normal-engine qualification receipt identity conflict');
    }
    return undefined;
  };
  const existing = await readExisting();
  if (existing) return existing;

  const temporaryDirectory = join(finalDirectory, `.tmp-receipt-${randomUUID()}`);
  await mkdir(temporaryDirectory, { mode: 0o700 });
  try {
    const temporaryReceiptPath = join(temporaryDirectory, 'receipt.json');
    const receiptHandle = await open(temporaryReceiptPath, 'wx', 0o600);
    try { await receiptHandle.writeFile(receiptBytes); await receiptHandle.sync(); }
    finally { await receiptHandle.close(); }
    const temporarySha256Path = join(temporaryDirectory, 'receipt.sha256');
    const digestHandle = await open(temporarySha256Path, 'wx', 0o600);
    try { await digestHandle.writeFile(digestBytes); await digestHandle.sync(); }
    finally { await digestHandle.close(); }

    const publishFile = async (temporaryPath: string, finalPath: string, expected: Buffer): Promise<boolean> => {
      try {
        await link(temporaryPath, finalPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existingFile = await readPrivateFile(finalPath);
        if (!existingFile?.equals(expected)) throw new Error('normal-engine qualification receipt identity conflict');
        return false;
      }
    };

    // Publish the digest first so a crash between links can be completed idempotently on retry.
    const digestCreated = await publishFile(temporarySha256Path, sha256Path, digestBytes);
    const receiptCreated = await publishFile(temporaryReceiptPath, receiptPath, receiptBytes);
    const directoryHandle = await open(finalDirectory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    const persisted = await readExisting();
    if (!persisted) throw new Error('normal-engine qualification receipt write incomplete');
    return { ...persisted, idempotent: !digestCreated && !receiptCreated };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const qualificationPlanReceiptSchema = z.object({
  schemaVersion: z.literal('ReviewYetiNormalQualificationPlan.v1'),
  purpose: z.literal('normal-engine-qualification-plan'),
  planId: z.literal(NORMAL_ENGINE_QUALIFICATION_PLAN_ID),
  runId: z.string().regex(RUN_ID_PATTERN),
  descriptorSha256: digestSchema,
  runtime: z.object({ sourceRevision: z.string().regex(SHA_PATTERN),
    workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), runtimeManifestSha256: digestSchema }).strict(),
  policy: z.object({
    targetRepository: repositoryPathSchema,
    selectionPurpose: z.literal(QUALIFICATION_SELECTION_PURPOSE),
    configurationVariant: z.enum(['prepared-policy-default-v1', NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT]),
    source: z.object({ repositoryId: z.number().int().positive().safe(), owner: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
      repo: z.string().regex(/^[A-Za-z0-9_.-]+$/u), ref: z.string().regex(SHA_PATTERN), path: relativePolicyPathSchema,
      contentSha256: digestSchema }).strict(),
    effectivePolicyDigest: digestSchema,
    effectiveConfigDigest: digestSchema,
  }).strict(),
  cases: z.array(z.object({
    arm: z.enum(['single', 'repair-introduction', 'repair-head-history', 'repair-head-repeat',
      'repair-head-empty-history', 'repair-head-history-unavailable', 'repair-head-verifier-unavailable',
      'provider-failure', 'resource-exhaustion', 'p2-only', 'large-crossfile', 'adjudicator-recheck']),
    caseId: z.string().min(1).max(100),
    runId: z.string().regex(RUN_ID_PATTERN),
    phase: z.enum(['single', 'repair-introduction', 'repair-head', 'same-head-recheck']),
    configurationVariant: z.enum(['prepared-policy-default-v1', NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT]),
    inputSha256: digestSchema,
    bundleSha256: digestSchema,
    receiptPath: z.string().regex(/^normal-engine-qualification-store\/nq_[a-f0-9]{32}\/(?:single|repair-introduction|repair-head|same-head-recheck)\/[a-z0-9][a-z0-9_-]{0,99}\/receipt\.json$/u),
    receiptSha256: digestSchema,
    terminalStatus: z.enum(['completed', 'incomplete', 'failed']),
    budgetProfile: z.enum(['prepared-policy-default', 'normal-canary-120s', 'normal-canary-240s-capture-outside-child', 'large-crossfile-canary-300s',
      'bifrost-auth-rejection-30s-one-request', 'resource-exhaustion-60s-one-request', 'source-coverage-preflight-15s',
      'required-history-preflight-15s']),
    providerIdentifiersPath: z.string().regex(/^normal-engine-qualification-store\/nq_[a-f0-9]{32}\/(?:single|repair-introduction|repair-head|same-head-recheck)\/[a-z0-9][a-z0-9_-]{0,99}\/provider-identifiers\.record\/provider-identifiers\.json$/u).nullable(),
    providerIdentifiersSha256: digestSchema.nullable(),
    providerCaptureStatus: z.enum(['captured', 'unavailable']),
    providerCapturePath: z.string().regex(/^normal-engine-qualification-store\/nq_[a-f0-9]{32}\/(?:single|repair-introduction|repair-head|same-head-recheck)\/[a-z0-9][a-z0-9_-]{0,99}\/provider-capture\.record\/provider-capture\.json$/u).nullable(),
    providerCaptureSha256: digestSchema.nullable(),
    providerCaptureUnavailableReason: z.enum(QUALIFICATION_PROVIDER_CAPTURE_UNAVAILABLE_REASONS).nullable(),
    composedResourcesPath: z.string().regex(/^normal-engine-qualification-store\/nq_[a-f0-9]{32}\/(?:single|repair-introduction|repair-head|same-head-recheck)\/[a-z0-9][a-z0-9_-]{0,99}\/composed-resources\.record\/composed-runtime-resources\.json$/u).nullable(),
    composedResourcesSha256: digestSchema.nullable(),
    composedResourcesStatus: z.enum(['captured', 'unavailable']),
    composedResourcesUnavailableReason: z.enum(QUALIFICATION_RESOURCE_UNAVAILABLE_REASONS).nullable(),
  }).strict()).max(64),
  historyArtifacts: z.array(z.object({
    kind: z.enum(['history', 'verification-set', 'verification']),
    runId: z.string().regex(RUN_ID_PATTERN),
    sourceRunId: z.string().regex(RUN_ID_PATTERN).nullable(),
    sequenceId: z.literal('ws5-repair-sequence-v1'),
    caseId: z.enum(['ws5-sequence-a-v1', 'ws5-sequence-b-v1']),
    findingEventId: z.string().uuid().nullable(),
    recordPath: z.string().min(1).max(1024),
    recordSha256: digestSchema,
    sha256Path: z.string().min(1).max(1040),
    sha256FileSha256: digestSchema,
  }).strict()).max(10_000),
  historyArtifactSetComplete: z.boolean(),
  caseCount: z.number().int().nonnegative().safe(),
  expectedReceiptCount: z.number().int().positive().safe(),
  completedReceiptCount: z.number().int().nonnegative().safe(),
  receiptSetComplete: z.boolean(),
  publication: z.object({ mode: z.literal('disabled'), githubWrites: z.literal(0), appChecks: z.literal(0),
    reviews: z.literal(0), comments: z.literal(0), ordinaryGateTouched: z.literal(false),
    promptsPersisted: z.literal(false), responsesPersisted: z.literal(false), providerCredentialsPersisted: z.literal(false) }).strict(),
  terminal: z.object({ status: z.enum(['completed', 'failed']), startedAt: z.string().datetime(), completedAt: z.string().datetime() }).strict(),
}).strict().superRefine((receipt, context) => {
  if (receipt.caseCount !== receipt.cases.length || receipt.completedReceiptCount !== receipt.cases.length
    || receipt.cases.length > receipt.expectedReceiptCount
    || receipt.receiptSetComplete !== (receipt.cases.length === receipt.expectedReceiptCount)
    || (receipt.terminal.status === 'completed' && (!receipt.receiptSetComplete || !receipt.historyArtifactSetComplete))
    || new Set(receipt.cases.map((item) => item.runId)).size !== receipt.cases.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['cases'], message: 'qualification plan receipt set is inconsistent' });
  }
  for (const item of receipt.cases) {
    const target = FIXTURE_PINS.find((pin) => pin.caseId === item.caseId);
    if (!target || target.sha256 !== item.inputSha256 || target.bundleSha256 !== item.bundleSha256
      || !armAllowedForPin(target, item.arm) || phaseForArm(item.arm) !== item.phase
      || item.configurationVariant !== receipt.policy.configurationVariant
      || item.receiptPath !== `normal-engine-qualification-store/${item.runId}/${item.phase}/${item.caseId}/receipt.json`) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['cases'], message: 'qualification plan case identity is invalid' });
    }
    if ((item.providerIdentifiersPath === null) !== (item.providerIdentifiersSha256 === null)
      || (item.providerIdentifiersPath !== null
        && item.providerIdentifiersPath !== `normal-engine-qualification-store/${item.runId}/${item.phase}/${item.caseId}/provider-identifiers.record/provider-identifiers.json`)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['cases'], message: 'qualification provider identifier artifact path is invalid' });
    }
    const expectedProviderCapturePath = `normal-engine-qualification-store/${item.runId}/${item.phase}/${item.caseId}/provider-capture.record/provider-capture.json`;
    if ((item.providerCaptureStatus === 'captured' && (item.providerCapturePath !== expectedProviderCapturePath
        || item.providerCaptureSha256 === null || item.providerCaptureUnavailableReason !== null))
      || (item.providerCaptureStatus === 'unavailable' && (item.providerCapturePath !== null
        || item.providerCaptureSha256 !== null || item.providerCaptureUnavailableReason === null))
      || (item.terminalStatus === 'completed' && item.providerCaptureStatus !== 'captured')) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['cases'], message: 'qualification provider capture artifact path or status is invalid' });
    }
    const expectedResourcesPath = normalEngineQualificationComposedResourcesRelativePath(item.runId, item.phase, item.caseId);
    if ((item.composedResourcesStatus === 'captured' && (item.composedResourcesPath !== expectedResourcesPath
        || item.composedResourcesSha256 === null || item.composedResourcesUnavailableReason !== null))
      || (item.composedResourcesStatus === 'unavailable' && (item.composedResourcesPath !== null
        || item.composedResourcesSha256 !== null || item.composedResourcesUnavailableReason === null))
      || (item.terminalStatus === 'completed' && item.composedResourcesStatus !== 'captured')) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['cases'], message: 'qualification composed resource artifact path or status is invalid' });
    }
  }
  const sourceCase = receipt.cases.find((item) => item.arm === 'repair-introduction');
  const artifactKeys = new Set<string>();
  for (const artifact of receipt.historyArtifacts) {
    const prefix = `normal-engine-qualification-store/${artifact.runId}/${artifact.sequenceId}/${artifact.caseId}/`;
    const expectedRecord = artifact.kind === 'history'
      ? `${prefix}history/record.json`
      : artifact.kind === 'verification-set' ? `${prefix}verification-set/record.json`
        : artifact.findingEventId ? `${prefix}verifications/${artifact.findingEventId}/record.json` : '';
    const owningCase = receipt.cases.find((item) => item.runId === artifact.runId);
    const expectedCase = artifact.kind === 'history' ? 'ws5-sequence-a-v1' : owningCase?.caseId;
    const expectedSourceRunId = artifact.kind === 'history' ? null
      : owningCase?.arm === 'repair-head-empty-history' ? null : sourceCase?.runId;
    const key = `${artifact.kind}:${artifact.runId}:${artifact.findingEventId ?? ''}`;
    if (!expectedRecord || artifact.recordPath !== expectedRecord || artifact.sha256Path !== `${expectedRecord}.sha256`
      || artifact.caseId !== expectedCase || artifact.sourceRunId !== expectedSourceRunId
      || (artifact.kind === 'history' && artifact.findingEventId !== null)
      || (artifact.kind === 'verification-set' && artifact.findingEventId !== null)
      || (artifact.kind === 'verification' && artifact.findingEventId === null) || artifactKeys.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['historyArtifacts'], message: 'qualification history artifact path is invalid' });
    }
    artifactKeys.add(key);
  }
  const sourceHistoryRow = sourceCase && receipt.historyArtifacts.some((item) => item.kind === 'history'
    && item.runId === sourceCase.runId && item.caseId === 'ws5-sequence-a-v1');
  const expectedHistoryArms = ['repair-head-history', 'repair-head-repeat',
    'repair-head-empty-history', 'repair-head-history-unavailable', 'repair-head-verifier-unavailable',
    'adjudicator-recheck'] as const;
  const repairSetCases = receipt.cases.filter((item) => expectedHistoryArms.includes(item.arm as typeof expectedHistoryArms[number]));
  const allExpectedHistoryRowsPresent = expectedHistoryArms.every((arm) => receipt.cases.some((item) => item.arm === arm));
  const repairSetsPresent = repairSetCases.length === expectedHistoryArms.length && repairSetCases.every((item) => receipt.historyArtifacts.some((artifact) =>
    artifact.kind === 'verification-set' && artifact.runId === item.runId && artifact.caseId === item.caseId
      && artifact.sourceRunId === (item.arm === 'repair-head-empty-history' ? null : sourceCase?.runId)));
  if (receipt.historyArtifactSetComplete !== Boolean(sourceHistoryRow && allExpectedHistoryRowsPresent && repairSetsPresent)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['historyArtifactSetComplete'], message: 'qualification history artifact set is incomplete' });
  }
});

export function assertNormalEngineQualificationPlanReceipt(input: unknown): NormalEngineQualificationPlanReceipt {
  const parsed = qualificationPlanReceiptSchema.safeParse(input);
  if (!parsed.success || hasOfficialReviewField(input)) throw new Error('normal-engine qualification plan receipt contract is invalid');
  if (parsed.data.descriptorSha256 !== NORMAL_ENGINE_QUALIFICATION_PLAN_DESCRIPTOR_SHA256
    || parsed.data.expectedReceiptCount !== 11
    || parsed.data.policy.configurationVariant !== NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT) {
    throw new Error('normal-engine qualification plan identity is not the frozen eleven-arm plan');
  }
  if (parsed.data.policy.targetRepository !== `${parsed.data.policy.source.owner}/${parsed.data.policy.source.repo}`) {
    throw new Error('normal-engine qualification plan policy target/source binding is invalid');
  }
  return parsed.data;
}

export interface PersistedNormalEngineQualificationPlanReceipt {
  planPath: string;
  sha256Path: string;
  planSha256: string;
  idempotent: boolean;
}

/** Atomically writes the non-approval suite index at the one fixed workflow capture path. */
export async function persistNormalEngineQualificationPlanReceipt(
  input: unknown,
  outputPath: string = NORMAL_ENGINE_QUALIFICATION_RECEIPT_PATH,
): Promise<PersistedNormalEngineQualificationPlanReceipt> {
  if (outputPath !== NORMAL_ENGINE_QUALIFICATION_RECEIPT_PATH) throw new Error('normal-engine qualification plan output path is fixed');
  const receipt = assertNormalEngineQualificationPlanReceipt(input);
  const body = `${JSON.stringify(JSON.parse(canonicalQualificationJson(receipt)), null, 2)}\n`;
  const digest = createHash('sha256').update(body, 'utf8').digest('hex');
  const planPath = outputPath;
  const sha256Path = `${outputPath}.sha256`;
  const directory = dirname(outputPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('normal-engine qualification plan directory is invalid');
  await chmod(directory, 0o700);
  const existing = async (): Promise<PersistedNormalEngineQualificationPlanReceipt | undefined> => {
    try {
      const [existingBody, existingDigest] = await Promise.all([readFile(planPath, 'utf8'), readFile(sha256Path, 'utf8')]);
      const actual = createHash('sha256').update(existingBody, 'utf8').digest('hex');
      if (actual !== existingDigest.trim()) throw new Error('normal-engine qualification plan store is corrupt');
      if (actual !== digest || existingBody !== body) throw new Error('normal-engine qualification plan identity conflict');
      return { planPath, sha256Path, planSha256: actual, idempotent: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const prior = await existing();
  if (prior) return prior;
  const temporaryPath = `${planPath}.tmp-${randomUUID()}`;
  const temporaryShaPath = `${sha256Path}.tmp-${randomUUID()}`;
  try {
    const planFile = await open(temporaryPath, 'wx', 0o600);
    try { await planFile.writeFile(body, 'utf8'); await planFile.sync(); }
    finally { await planFile.close(); }
    const hashFile = await open(temporaryShaPath, 'wx', 0o600);
    try { await hashFile.writeFile(`${digest}\n`, 'utf8'); await hashFile.sync(); }
    finally { await hashFile.close(); }
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    await rename(temporaryPath, planPath);
    await rename(temporaryShaPath, sha256Path);
    const finalDirectoryHandle = await open(directory, 'r');
    try { await finalDirectoryHandle.sync(); } finally { await finalDirectoryHandle.close(); }
  } catch (error) {
    const raced = await existing();
    if (raced) return raced;
    throw error;
  } finally {
    await rm(temporaryPath, { force: true });
    await rm(temporaryShaPath, { force: true });
  }
  return { planPath, sha256Path, planSha256: digest, idempotent: false };
}

function nonempty(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] || '').trim();
}

const HISTORY_BEARING_REPAIR_ARMS = new Set<NormalEngineQualificationArm>([
  'repair-head-history', 'repair-head-repeat', 'repair-head-history-unavailable', 'repair-head-verifier-unavailable',
  'adjudicator-recheck',
]);

function phaseForArm(arm: NormalEngineQualificationArm): NormalEngineQualificationRequest['phase'] {
  if (arm === 'repair-introduction') return 'repair-introduction';
  if (arm.startsWith('repair-head-')) return 'repair-head';
  if (arm === 'adjudicator-recheck') return 'same-head-recheck';
  return 'single';
}

function armAllowedForPin(pin: FixturePin, arm: NormalEngineQualificationArm): boolean {
  if (pin.caseId.startsWith('lc_')) return arm === 'single';
  if (pin.caseId === 'ws5-sequence-a-v1') return ['repair-introduction', 'adjudicator-recheck'].includes(arm);
  if (pin.caseId === 'ws5-sequence-b-v1') return [
    'repair-head-history', 'repair-head-repeat', 'repair-head-empty-history',
    'repair-head-history-unavailable', 'repair-head-verifier-unavailable',
  ].includes(arm);
  if (pin.caseId === 'ws5-p2-display-sort-v1') return ['p2-only', 'provider-failure', 'resource-exhaustion'].includes(arm);
  if (pin.caseId === 'ws5-large-crossfile-v1') return arm === 'large-crossfile';
  if (pin.bundleVersion === EXTERNAL_V2_BUNDLE_VERSION) {
    if (pin.caseId === 'ws5-current-1dd-v2-p2') return arm === 'p2-only';
    if (pin.caseId === 'ws5-current-1dd-v2-sequence-a') return arm === 'repair-introduction';
    if (pin.caseId === 'ws5-current-1dd-v2-sequence-b') {
      return ['repair-head-history', 'repair-head-empty-history', 'repair-head-history-unavailable'].includes(arm);
    }
    if (pin.caseId === 'ws5-current-1dd-v2-coverage-hole') return arm === 'preflight-source-coverage-control';
    if (pin.caseId === 'ws5-current-1dd-v2-provider-failure') return arm === 'provider-failure';
    if (pin.caseId === 'ws5-current-1dd-v2-resource-exhaustion') return arm === 'resource-exhaustion';
  }
  if (pin.bundleVersion === EXTERNAL_V3_BUNDLE_VERSION) {
    if (pin.caseId === 'ws5-r2-c001') return ['p2-only', 'provider-failure', 'resource-exhaustion'].includes(arm);
    if (pin.caseId === 'ws5-r2-c002') return arm === 'repair-introduction';
    if (pin.caseId === 'ws5-r2-c003') {
      return ['repair-head-history', 'repair-head-empty-history', 'repair-head-history-unavailable'].includes(arm);
    }
    if (pin.caseId === 'ws5-r2-c004') return arm === 'preflight-source-coverage-control';
  }
  return false;
}

export function qualificationArmAllowedForFixture(caseId: string, arm: NormalEngineQualificationArm): boolean {
  const pin = FIXTURE_PINS.find((entry) => entry.caseId === caseId);
  return Boolean(pin && armAllowedForPin(pin, arm));
}

export function qualificationFixturePin(caseId: string): FixturePin | undefined {
  const pin = FIXTURE_PINS.find((entry) => entry.caseId === caseId);
  return pin ? { ...pin, repository: { ...pin.repository } } : undefined;
}

export function validateQualificationFixtureInput(caseId: string): void {
  const pin = FIXTURE_PINS.find((entry) => entry.caseId === caseId);
  if (!pin) throw new Error('normal_engine_qualification_fixture_identity_mismatch');
  assertFixtureBundleDescriptor(pin);
  readPinnedInput(pin);
}

export function qualificationPhaseForArm(arm: NormalEngineQualificationArm): NormalEngineQualificationRequest['phase'] {
  return phaseForArm(arm);
}

function assertFixtureBundleDescriptor(pin: FixturePin): void {
  if (pin.bundleVersion === FIXTURE_BUNDLE_VERSION && pin.bundleSha256 === FIXTURE_BUNDLE_SHA256) return;
  const descriptorPath = pin.bundleVersion === REPAIR_BUNDLE_VERSION
    ? resolve(FIXTURE_ROOT, 'competitive-review-benchmark/ws5-repair-sequence-v1/descriptor.json')
    : pin.bundleVersion === LARGE_BUNDLE_VERSION
      ? resolve(FIXTURE_ROOT, 'competitive-review-benchmark/ws5-large-crossfile-v1/descriptor.json')
      : pin.bundleVersion === P2_BUNDLE_VERSION
        ? resolve(FIXTURE_ROOT, 'competitive-review-benchmark/ws5-p2-display-sort-v1/descriptor.json')
        : pin.bundleVersion === EXTERNAL_V2_BUNDLE_VERSION
          ? resolve(FIXTURE_ROOT, EXTERNAL_V2_BUNDLE_DESCRIPTOR_PATH)
          : pin.bundleVersion === EXTERNAL_V3_BUNDLE_VERSION
            ? resolve(FIXTURE_ROOT, EXTERNAL_V3_BUNDLE_DESCRIPTOR_PATH) : '';
  if (!descriptorPath) throw new Error('normal_engine_qualification_fixture_bundle_unknown');
  const bytes = readFileSync(descriptorPath);
  if (createHash('sha256').update(bytes).digest('hex') !== pin.bundleSha256) {
    throw new Error('normal_engine_qualification_fixture_descriptor_digest_mismatch');
  }
  let descriptor: unknown;
  try { descriptor = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('normal_engine_qualification_fixture_descriptor_invalid'); }
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error('normal_engine_qualification_fixture_descriptor_invalid');
  }
  const value = descriptor as Record<string, unknown>;
  if (pin.bundleVersion === EXTERNAL_V2_BUNDLE_VERSION) {
    if (value.schemaVersion !== EXTERNAL_V2_BUNDLE_VERSION || !Array.isArray(value.cases)) {
      throw new Error('normal_engine_qualification_fixture_descriptor_invalid');
    }
    const externalPins = FIXTURE_PINS.filter((entry) => entry.bundleVersion === EXTERNAL_V2_BUNDLE_VERSION);
    if (value.cases.length !== externalPins.length) {
      throw new Error('normal_engine_qualification_fixture_descriptor_identity_mismatch');
    }
    const entry = value.cases.find((candidate) => candidate && typeof candidate === 'object'
      && !Array.isArray(candidate) && (candidate as Record<string, unknown>).caseId === pin.caseId) as Record<string, unknown> | undefined;
    if (!entry || entry.inputPath !== pin.path || entry.inputSha256 !== pin.sha256
      || entry.schemaVersion !== pin.schemaVersion || entry.repository === undefined
      || JSON.stringify(entry.repository) !== JSON.stringify(pin.repository)
      || entry.prNumber !== pin.prNumber || entry.baseSha !== pin.baseSha || entry.headSha !== pin.headSha) {
      throw new Error('normal_engine_qualification_fixture_descriptor_identity_mismatch');
    }
    for (const candidate of externalPins) {
      const candidateEntry = value.cases.find((row) => row && typeof row === 'object'
        && !Array.isArray(row) && (row as Record<string, unknown>).caseId === candidate.caseId) as Record<string, unknown> | undefined;
      if (!candidateEntry || candidateEntry.inputPath !== candidate.path || candidateEntry.inputSha256 !== candidate.sha256
        || candidateEntry.schemaVersion !== candidate.schemaVersion
        || JSON.stringify(candidateEntry.repository) !== JSON.stringify(candidate.repository)
        || candidateEntry.prNumber !== candidate.prNumber || candidateEntry.baseSha !== candidate.baseSha
        || candidateEntry.headSha !== candidate.headSha) {
        throw new Error('normal_engine_qualification_fixture_descriptor_identity_mismatch');
      }
    }
    return;
  }
  if (pin.bundleVersion === EXTERNAL_V3_BUNDLE_VERSION) {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['cases', 'schemaVersion'])
      || value.schemaVersion !== EXTERNAL_V3_BUNDLE_VERSION || !Array.isArray(value.cases)) {
      throw new Error('normal_engine_qualification_fixture_descriptor_invalid');
    }
    const externalPins = FIXTURE_PINS.filter((entry) => entry.bundleVersion === EXTERNAL_V3_BUNDLE_VERSION);
    const caseIds = value.cases.map((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>).caseId : undefined);
    if (value.cases.length !== externalPins.length
      || JSON.stringify([...caseIds].sort()) !== JSON.stringify(externalPins.map((entry) => entry.caseId).sort())) {
      throw new Error('normal_engine_qualification_fixture_descriptor_identity_mismatch');
    }
    const expectedKeys = ['baseSha', 'caseId', 'headSha', 'inputPath', 'inputSha256', 'prNumber', 'repository', 'schemaVersion']
      .sort();
    for (const candidate of externalPins) {
      const entry = value.cases.find((row) => row && typeof row === 'object' && !Array.isArray(row)
        && (row as Record<string, unknown>).caseId === candidate.caseId) as Record<string, unknown> | undefined;
      if (!entry || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expectedKeys)
        || entry.inputPath !== candidate.path || entry.inputSha256 !== candidate.sha256
        || entry.schemaVersion !== candidate.schemaVersion
        || JSON.stringify(entry.repository) !== JSON.stringify(candidate.repository)
        || entry.prNumber !== candidate.prNumber || entry.baseSha !== candidate.baseSha
        || entry.headSha !== candidate.headSha) {
        throw new Error('normal_engine_qualification_fixture_descriptor_identity_mismatch');
      }
    }
    return;
  }
  if (value.schemaVersion !== pin.bundleVersion || value.repository === undefined) {
    throw new Error('normal_engine_qualification_fixture_descriptor_invalid');
  }
  const repository = value.repository as Record<string, unknown>;
  if (repository.repositoryId !== pin.repository.repositoryId || repository.owner !== pin.repository.owner
    || repository.repo !== pin.repository.repo || value.prNumber !== pin.prNumber) {
    throw new Error('normal_engine_qualification_fixture_descriptor_identity_mismatch');
  }
  if (pin.bundleVersion === REPAIR_BUNDLE_VERSION) {
    const phases = value.phases;
    const phase = Array.isArray(phases) ? phases.find((entry) => entry && typeof entry === 'object'
      && !Array.isArray(entry) && (entry as Record<string, unknown>).caseId === pin.caseId) as Record<string, unknown> | undefined : undefined;
    if (!phase || phase.inputPath !== pin.path || phase.inputSha256 !== pin.sha256
      || phase.baseSha !== pin.baseSha || phase.headSha !== pin.headSha) {
      throw new Error('normal_engine_qualification_fixture_descriptor_identity_mismatch');
    }
  } else if (value.caseId !== pin.caseId || value.inputPath !== pin.path || value.inputSha256 !== pin.sha256
    || value.baseSha !== pin.baseSha || value.headSha !== pin.headSha) {
    throw new Error('normal_engine_qualification_fixture_descriptor_identity_mismatch');
  }
}

function rejectExternalEffectsAndOracle(env: NodeJS.ProcessEnv): void {
  const forbiddenExact = [
    'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PUBLISH_TOKEN', 'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_APP_ID', 'GITHUB_INSTALLATION_ID', 'REVIEW_WORKER_TOKEN', 'REVIEW_DISPATCH_TOKEN',
    'REVIEW_COMPLETION_URL', 'REVIEW_STATUS_URL', 'REVIEW_DISPATCH_STATUS_URL', 'REVIEW_CHECK_ID',
    'REVIEW_RECEIPT_ONLY', 'REVIEW_FULL_PANEL_QUALIFICATION_ONLY', 'REVIEW_SAME_HEAD_QUALIFICATION_ONLY',
    'REVIEW_PANEL_QUALIFICATION_ONLY', 'REVIEW_PROVIDER_QUALIFICATION_ONLY', 'REVIEW_AUTHORITATIVE_GATE',
    'REVIEW_NORMAL_ENGINE_QUALIFICATION_FIXTURE_ROOT', 'REVIEW_RUN_ID', 'REVIEW_DELIVERY_ID',
    'REVIEW_REPOSITORY_ID', 'REVIEW_REPO', 'REVIEW_PR_NUMBER', 'REVIEW_BASE_SHA', 'REVIEW_HEAD_SHA',
    'OPENROUTER_API_KEY', 'OPENROUTER_REVIEW_FLEET_KEY', 'OPENROUTER_PR_REVIEW_API_KEY', 'OPENROUTER_BASE_URL',
    'REVIEW_TERMINAL_DEADLINE',
  ];
  if (forbiddenExact.some((name) => nonempty(env, name))) throw new Error('normal_engine_qualification_contract_invalid');
  if (Object.keys(env).some((name) => /^REVIEW_.*(?:ORACLE|EXPECTED.*(?:OUTCOME|VERDICT|GATE))/iu.test(name)
    && nonempty(env, name) !== '')) {
    throw new Error('normal_engine_qualification_contract_invalid');
  }
  if (nonempty(env, 'REVIEW_YETI_PASSTHROUGH').toLowerCase() === 'false') {
    throw new Error('normal_engine_qualification_contract_invalid');
  }
}

function validatePinnedInputBytes(pin: FixturePin, bytes: Buffer): Record<string, unknown> {
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== pin.sha256) throw new Error('normal_engine_qualification_fixture_digest_mismatch');
  let input: unknown;
  try { input = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('normal_engine_qualification_fixture_invalid'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('normal_engine_qualification_fixture_invalid');
  }
  const record = input as Record<string, unknown>;
  const source = record.source as Record<string, unknown> | undefined;
  const repository = source?.repository as Record<string, unknown> | undefined;
  if (record.schemaVersion !== pin.schemaVersion || record.caseId !== pin.caseId
    || source?.baseSha !== pin.baseSha || source?.headSha !== pin.headSha
    || repository?.repositoryId !== pin.repository.repositoryId
    || repository?.owner !== pin.repository.owner || repository?.repo !== pin.repository.repo
    || (pin.bundleVersion === EXTERNAL_V3_BUNDLE_VERSION && hasOfficialReviewField(record))
    || !Array.isArray(source?.changedPaths) || !Array.isArray(source?.patches) || !Array.isArray(source?.revisions)) {
    throw new Error('normal_engine_qualification_fixture_identity_mismatch');
  }
  return record;
}

export function validateQualificationFixtureInputBytes(caseId: string, bytes: Buffer): void {
  const pin = FIXTURE_PINS.find((entry) => entry.caseId === caseId);
  if (!pin) throw new Error('normal_engine_qualification_fixture_identity_mismatch');
  assertFixtureBundleDescriptor(pin);
  validatePinnedInputBytes(pin, bytes);
}

function readPinnedInput(pin: FixturePin): { bytes: Buffer; input: Record<string, unknown> } {
  assertFixtureBundleDescriptor(pin);
  const bytes = readFileSync(resolve(REPOSITORY_ROOT, pin.path));
  const input = validatePinnedInputBytes(pin, bytes);
  return { bytes, input };
}

const HISTORY_LINEAGE_ENV_KEYS = Object.freeze({
  sequenceId: 'REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_SEQUENCE_ID',
  sourceCaseId: 'REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_SOURCE_CASE_ID',
  repairCaseId: 'REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_REPAIR_CASE_ID',
  sourceInputSha256: 'REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_SOURCE_INPUT_SHA256',
  repairInputSha256: 'REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_REPAIR_INPUT_SHA256',
  repairBaseSha: 'REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_REPAIR_BASE_SHA',
  repairHeadSha: 'REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_REPAIR_HEAD_SHA',
});

function historyLineageForRequest(
  env: NodeJS.ProcessEnv,
  caseId: string,
  arm: NormalEngineQualificationArm,
): NormalEngineQualificationHistoryLineage | null {
  const needsLineage = arm === 'repair-introduction' || arm === 'adjudicator-recheck' || arm.startsWith('repair-head-');
  if (!needsLineage) return null;
  const externalLineageForCase = externalNormalQualificationHistoryLineageForCase(caseId);
  const raw = Object.fromEntries(Object.entries(HISTORY_LINEAGE_ENV_KEYS).map(([key, envName]) => [key, nonempty(env, envName)])) as
    Record<keyof NormalEngineQualificationHistoryLineage, string>;
  const present = Object.values(raw).filter(Boolean).length;
  let lineage: NormalEngineQualificationHistoryLineage;
  if (present === 0) {
    if (caseId === LEGACY_REPAIR_HISTORY_LINEAGE.sourceCaseId || caseId === LEGACY_REPAIR_HISTORY_LINEAGE.repairCaseId) {
      lineage = { ...LEGACY_REPAIR_HISTORY_LINEAGE };
    } else if (externalLineageForCase) {
      const { bundleSha256: _bundleSha256, ...externalLineage } = externalLineageForCase;
      lineage = { ...externalLineage };
    } else {
      throw new Error('normal_engine_qualification_history_lineage_required');
    }
  } else {
    if (present !== Object.keys(HISTORY_LINEAGE_ENV_KEYS).length) {
      throw new Error('normal_engine_qualification_history_lineage_incomplete');
    }
    lineage = raw;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(lineage.sequenceId)
    || !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(lineage.sourceCaseId)
    || !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(lineage.repairCaseId)
    || !DIGEST_PATTERN.test(lineage.sourceInputSha256) || !DIGEST_PATTERN.test(lineage.repairInputSha256)
    || !SHA_PATTERN.test(lineage.repairBaseSha) || !SHA_PATTERN.test(lineage.repairHeadSha)) {
    throw new Error('normal_engine_qualification_history_lineage_invalid');
  }
  const externalLineage = externalLineageForCase?.sequenceId === lineage.sequenceId ? externalLineageForCase : undefined;
  const expectedLineage: NormalEngineQualificationHistoryLineage = externalLineage ? {
    sequenceId: externalLineage.sequenceId,
    sourceCaseId: externalLineage.sourceCaseId,
    repairCaseId: externalLineage.repairCaseId,
    sourceInputSha256: externalLineage.sourceInputSha256,
    repairInputSha256: externalLineage.repairInputSha256,
    repairBaseSha: externalLineage.repairBaseSha,
    repairHeadSha: externalLineage.repairHeadSha,
  } : { ...LEGACY_REPAIR_HISTORY_LINEAGE };
  if (JSON.stringify(lineage) !== JSON.stringify(expectedLineage)
    || (arm === 'repair-introduction' && caseId !== lineage.sourceCaseId)
    || (arm === 'adjudicator-recheck' && caseId !== lineage.sourceCaseId)
    || (arm.startsWith('repair-head-') && caseId !== lineage.repairCaseId)) {
    throw new Error('normal_engine_qualification_history_lineage_binding_invalid');
  }
  return lineage;
}

export function parseNormalEngineQualificationRequest(
  env: NodeJS.ProcessEnv = process.env,
): NormalEngineQualificationRequest {
  rejectExternalEffectsAndOracle(env);
  const runId = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID');
  const caseId = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID');
  const armRaw = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM');
  const historyRunIdRaw = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_RUN_ID');
  const configurationVariantRaw = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT');
  const configurationVariant = configurationVariantRaw || 'prepared-policy-default-v1';
  const policyDigest = nonempty(env, 'REVIEW_POLICY_DIGEST');
  const configDigest = nonempty(env, 'REVIEW_CONFIG_DIGEST');
  const sourceRevision = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_SOURCE_REVISION');
  const workerImageDigest = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_WORKER_IMAGE_DIGEST');
  const runtimeManifestSha256 = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256');
  const policyTargetRepository = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_TARGET');
  const policySelectionPurpose = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_SELECTION_PURPOSE');
  const policySourceRepositoryId = Number(nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPOSITORY_ID'));
  const policySourceOwner = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_OWNER');
  const policySourceRepo = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPO');
  const policySourceRef = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REF');
  const policySourcePath = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_PATH');
  const policySourceSha256 = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_SHA256');
  const pin = FIXTURE_PINS.find((entry) => entry.caseId === caseId);
  const validArms: readonly NormalEngineQualificationArm[] = [
    'single', 'repair-introduction', 'repair-head-history', 'repair-head-repeat', 'repair-head-empty-history',
    'repair-head-history-unavailable', 'repair-head-verifier-unavailable', 'provider-failure',
    'resource-exhaustion', 'preflight-source-coverage-control', 'p2-only', 'large-crossfile', 'adjudicator-recheck',
  ];
  const arm = validArms.find((candidate) => candidate === armRaw);
  const historyRunId = historyRunIdRaw || null;
  const historyLineage = arm ? historyLineageForRequest(env, caseId, arm) : null;
  if (nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_ONLY') !== 'true'
    || nonempty(env, 'REVIEW_PUBLICATION_MODE') !== 'disabled'
    || nonempty(env, 'REVIEW_RECEIPT_PATH') !== NORMAL_ENGINE_QUALIFICATION_RECEIPT_PATH
    || !RUN_ID_PATTERN.test(runId) || !pin || !arm || !armAllowedForPin(pin, arm)
    || !DIGEST_PATTERN.test(policyDigest) || !DIGEST_PATTERN.test(configDigest)
    || !SHA_PATTERN.test(sourceRevision) || !/^sha256:[a-f0-9]{64}$/u.test(workerImageDigest)
    || !DIGEST_PATTERN.test(runtimeManifestSha256)
    || !(['prepared-policy-default-v1', NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT] as string[]).includes(configurationVariant)
    || !repositoryPathSchema.safeParse(policyTargetRepository).success
    || policySelectionPurpose !== QUALIFICATION_SELECTION_PURPOSE
    || !Number.isSafeInteger(policySourceRepositoryId) || policySourceRepositoryId <= 0
    || !/^[A-Za-z0-9_.-]+$/u.test(policySourceOwner) || !/^[A-Za-z0-9_.-]+$/u.test(policySourceRepo)
    || policyTargetRepository !== `${policySourceOwner}/${policySourceRepo}`
    || !SHA_PATTERN.test(policySourceRef) || !relativePolicyPathSchema.safeParse(policySourcePath).success
    || !DIGEST_PATTERN.test(policySourceSha256)
    || !nonempty(env, 'REVIEW_PREPARED_CONFIG_JSON')
    || nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN') !== ''
    || nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_CAPTURE_HOLD') !== ''
    || (HISTORY_BEARING_REPAIR_ARMS.has(arm) && (!historyRunId || !RUN_ID_PATTERN.test(historyRunId) || historyRunId === runId))
    || (!HISTORY_BEARING_REPAIR_ARMS.has(arm) && historyRunId !== null)
    || (arm === 'adjudicator-recheck' && configurationVariant !== NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT)) {
    throw new Error('normal_engine_qualification_contract_invalid');
  }
  readPinnedInput(pin);
  return {
    purpose: 'normal-engine-qualification',
    runId,
    arm,
    phase: phaseForArm(arm),
    configurationVariant: configurationVariant as NormalEngineQualificationConfigurationVariant,
    historyRunId,
    historyLineage,
    fixture: {
      bundleVersion: pin.bundleVersion,
      bundleSha256: pin.bundleSha256,
      caseId: pin.caseId,
      inputSha256: pin.sha256,
      repository: pin.repository,
      prNumber: pin.prNumber,
      baseSha: pin.baseSha,
      headSha: pin.headSha,
    },
    runtime: { sourceRevision, workerImageDigest, runtimeManifestSha256 },
    policy: {
      targetRepository: policyTargetRepository,
      selectionPurpose: QUALIFICATION_SELECTION_PURPOSE,
      sourceRepositoryId: policySourceRepositoryId,
      sourceOwner: policySourceOwner,
      sourceRepo: policySourceRepo,
      sourceRef: policySourceRef,
      sourcePath: policySourcePath,
      sourceContentSha256: policySourceSha256,
      policyDigest,
      configDigest,
    },
    publicationMode: 'disabled',
  };
}

export function isNormalEngineQualificationWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN') !== '') {
      parseNormalEngineQualificationPlanRequest(env);
    } else {
      parseNormalEngineQualificationRequest(env);
    }
    return true;
  } catch {
    return false;
  }
}

/** Parses the fixed suite entry without admitting caller-selected case or arm data. */
export function parseNormalEngineQualificationPlanRequest(
  env: NodeJS.ProcessEnv = process.env,
): NormalEngineQualificationPlanRequest {
  const planId = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN');
  const captureHold = nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_CAPTURE_HOLD');
  if (planId !== NORMAL_ENGINE_QUALIFICATION_PLAN_ID
    || nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID') !== ''
    || nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM') !== ''
    || nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_RUN_ID') !== ''
    || nonempty(env, 'REVIEW_NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT') !== NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT
    || (captureHold !== '' && captureHold !== 'true')) {
    throw new Error('normal_engine_qualification_plan_contract_invalid');
  }
  const caseEnv: NodeJS.ProcessEnv = { ...env,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN: '',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_CAPTURE_HOLD: '',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID: 'ws5-sequence-a-v1',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM: 'repair-introduction',
  };
  const request = parseNormalEngineQualificationRequest(caseEnv);
  return {
    purpose: 'normal-engine-qualification-plan',
    planId: NORMAL_ENGINE_QUALIFICATION_PLAN_ID,
    runId: request.runId,
    runtime: request.runtime,
    configurationVariant: request.configurationVariant,
    policy: request.policy,
    publicationMode: 'disabled',
    captureHold: captureHold === 'true',
  };
}

/** Exposes only immutable source data; lifecycle history, candidates, and oracle fields stay outside the model input. */
export function buildNormalEngineQualificationSourceInput(
  request: NormalEngineQualificationRequest,
): NormalEngineQualificationSourceInput {
  const pin = FIXTURE_PINS.find((entry) => entry.caseId === request.fixture.caseId);
  if (!pin || request.fixture.bundleVersion !== pin.bundleVersion || request.fixture.bundleSha256 !== pin.bundleSha256
    || request.fixture.inputSha256 !== pin.sha256 || request.fixture.baseSha !== pin.baseSha
    || request.fixture.headSha !== pin.headSha || request.fixture.prNumber !== pin.prNumber
    || !armAllowedForPin(pin, request.arm) || request.phase !== phaseForArm(request.arm)) {
    throw new Error('normal_engine_qualification_fixture_identity_mismatch');
  }
  const { input } = readPinnedInput(pin);
  const source = input.source as Record<string, unknown>;
  return {
    fixtureId: pin.caseId,
    source: {
      repository: pin.repository,
      prNumber: pin.prNumber,
      baseSha: pin.baseSha,
      headSha: pin.headSha,
      changedPaths: [...source.changedPaths as string[]],
      patches: (source.patches as Array<Record<string, unknown>>).map((entry) => ({
        path: String(entry.path), patch: String(entry.patch), sha256: String(entry.sha256),
      })),
      revisions: source.revisions as Array<Record<string, unknown>>,
    },
  };
}
