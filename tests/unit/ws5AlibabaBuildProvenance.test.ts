import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPinnedAlibabaBinary } from '../../scripts/ws5-alibaba.mjs';
import {
  assertWs5AlibabaDerivedBuildBindingClaims,
  sealWs5AlibabaDerivedBuildBinding,
  verifyWs5AlibabaDerivedBuildBinding,
  WS5_ALIBABA_BUILD_ARTIFACT_PIN,
  WS5_ALIBABA_BUILD_BINDING_SCHEMA,
} from '../../scripts/ws5-alibaba-build-provenance.mjs';

const SOURCE_GIT = { commit: '1'.repeat(40), tree: '2'.repeat(40), clean: true };
const EXTERNAL_CONTRACT = {
  schemaVersion: 'ReviewYetiWS5ExternalDataContract.v1',
  sha256: '3'.repeat(64),
  preservedInputCount: 22,
  privateInputReceiptSha256: 'afad95f3b2f607e579a536168ab246ec4842cac8789cacc9a7e138f8f245a05c',
  sourceRootGit: SOURCE_GIT,
};
const CASE_IDS = [
  'aacr-cpp-85873', 'aacr-go-1355', 'aacr-javascript-31402', 'aacr-php-15217',
  'aacr-php-54226', 'aacr-python-6044', 'aacr-typescript-13323',
];
const PLAN = {
  publicRunMatrix: {
    requiredPublicRunCount: 28,
    arms: [{
      id: 'alibaba-open-code-review',
      caseIds: CASE_IDS,
      build: { binarySha256: WS5_ALIBABA_BUILD_ARTIFACT_PIN.originalDeclaredBinarySha256 },
    }],
  },
};

function validBinding() {
  const pin = WS5_ALIBABA_BUILD_ARTIFACT_PIN;
  return sealWs5AlibabaDerivedBuildBinding({
    schemaVersion: WS5_ALIBABA_BUILD_BINDING_SCHEMA,
    visibility: 'private',
    status: 'derived_from_two_identical_frozen_builds',
    modelCalls: 0,
    providerCalls: 0,
    runnerSourceGit: SOURCE_GIT,
    externalDataContractSha256: EXTERNAL_CONTRACT.sha256,
    planBinding: {
      path: pin.plan.path,
      sha256: pin.plan.sha256,
      armId: 'alibaba-open-code-review',
      field: pin.planField,
      originalBinarySha256: pin.originalDeclaredBinarySha256,
      caseIdsSha256: '1527ff5de21401aecbdd89bafb9efe2b7df25eb683d872be15fcc7fbc4c1e62d',
      plannedMatrixCellCount: 28,
      supportedAlibabaCellCount: 6,
      unsupportedAlibabaCaseId: 'aacr-cpp-85873',
    },
    privateInputs: {
      planSha256: pin.plan.sha256,
      privateInputReceiptSha256: 'afad95f3b2f607e579a536168ab246ec4842cac8789cacc9a7e138f8f245a05c',
      preservedInputCount: 22,
      preservedInputSetSha256: '46f29b1f940a3cc76978bd0f59052ebbdca79a09268dc9b501c201b107dc1ad6',
    },
    supersession: {
      scope: 'single_existing_alibaba_binary_sha256_field',
      planPath: pin.plan.path,
      planSha256: pin.plan.sha256,
      field: pin.planField,
      oldSha256: pin.originalDeclaredBinarySha256,
      selectedSha256: pin.binarySha256,
    },
    selectedArtifact: {
      path: '/private-run/run2/bin/ocr',
      sha256: pin.binarySha256,
      mode: pin.mode,
      sizeBytes: pin.sizeBytes,
      platform: pin.platform,
      repository: pin.source.repository,
      sourceCommit: pin.source.commit,
      sourceTree: pin.source.tree,
      sourceVersion: pin.source.version,
    },
    buildWitness: structuredClone(pin.buildWitness),
    buildReceipts: [
      { runId: 'run2', receiptPath: '/private-run/run2/build-receipt.json',
        receiptSha256: pin.buildWitness.runReceipts[0].sha256, binaryPath: '/private-run/run2/bin/ocr' },
      { runId: 'run3', receiptPath: '/private-run/run3/build-receipt.json',
        receiptSha256: pin.buildWitness.runReceipts[1].sha256, binaryPath: '/private-run/run3/bin/ocr' },
    ],
    dependencyFetchReceipt: {
      path: '/private-run/run2/dependency-fetch-receipt.json',
      sha256: pin.buildWitness.dependencyFetchReceiptSha256,
    },
    childBoundaryReceipt: {
      path: '/private-run/run3/child-boundary-receipt.json',
      sha256: pin.buildWitness.childBoundaryReceiptSha256,
    },
    buildSourceCheckout: {
      path: '/private-source/open-code-review',
      repository: pin.source.repository,
      commit: pin.source.commit,
      tree: pin.source.tree,
    },
  });
}

describe('WS5 Alibaba derived build-pin contract', () => {
  it('binds the selected artifact to the exact original plan field and two-build witness', () => {
    const result = assertWs5AlibabaDerivedBuildBindingClaims(validBinding(), {
      plan: PLAN,
      planSha256: WS5_ALIBABA_BUILD_ARTIFACT_PIN.plan.sha256,
      sourceRootGit: SOURCE_GIT,
      externalDataContract: EXTERNAL_CONTRACT,
    });
    expect(result).toMatchObject({
      status: 'binding_claims_match_fixed_provenance',
      selectedBinarySha256: 'd20c332f55309976c39e53a0f2982270ad04a367edb96522a15e4801df1987af',
      supersededBinarySha256: 'dca5f00262ec9b050ce0fc10ed13eefb4fa2255e3c9c4aebb19723e55cae2779',
      buildReceiptCount: 2,
    });
    expect(PLAN.publicRunMatrix.arms[0].build.binarySha256)
      .toBe(WS5_ALIBABA_BUILD_ARTIFACT_PIN.originalDeclaredBinarySha256);
  });

  it.each([
    ['wrong source commit', (binding: any) => { binding.selectedArtifact.sourceCommit = 'f'.repeat(40); }],
    ['wrong source version', (binding: any) => { binding.selectedArtifact.sourceVersion = 'v0.0.0'; }],
    ['unsupported toolchain', (binding: any) => { binding.buildWitness.toolchain = 'go1.28.0 darwin/arm64'; }],
    ['wrong selected digest', (binding: any) => { binding.selectedArtifact.sha256 = '0'.repeat(64); }],
    ['wrong receipt digest', (binding: any) => { binding.buildReceipts[1].receiptSha256 = '0'.repeat(64); }],
    ['wrong prior plan pin', (binding: any) => { binding.supersession.oldSha256 = '0'.repeat(64); }],
  ])('rejects %s', (_label, mutate) => {
    const binding = validBinding();
    mutate(binding);
    expect(() => assertWs5AlibabaDerivedBuildBindingClaims(binding, {
      plan: PLAN,
      planSha256: WS5_ALIBABA_BUILD_ARTIFACT_PIN.plan.sha256,
      sourceRootGit: SOURCE_GIT,
      externalDataContract: EXTERNAL_CONTRACT,
    })).toThrow();
  });

  it('rejects a missing runtime binding before binary or model dispatch', () => {
    expect(() => verifyWs5AlibabaDerivedBuildBinding({
      sourceRoot: process.cwd(),
      dataRoot: process.cwd(),
      bundle: { plan: PLAN, externalDataContract: EXTERNAL_CONTRACT, dataRootPath: process.cwd() },
    })).toThrow('ws5_alibaba_derived_binding_required');
  });

  it('rejects an unpinned local binary before running its CLI', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-alibaba-unpinned-binary-'));
    const candidate = path.join(directory, 'ocr');
    try {
      fs.writeFileSync(candidate, 'not the derived pinned binary\n', { mode: 0o700 });
      expect(() => assertPinnedAlibabaBinary(candidate)).toThrow('alibaba_binary_digest_mismatch');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
