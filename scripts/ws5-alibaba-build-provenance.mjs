import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WS5_ALIBABA_BUILD_BINDING_SCHEMA = 'ReviewYetiWS5AlibabaDerivedBuildBinding.v1';
export const WS5_ALIBABA_BUILD_BINDING_RECEIPT_SCHEMA = 'ReviewYetiWS5AlibabaDerivedBuildReceipt.v1';

const SOURCE_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const PLAN_PATH = 'eval-baselines/competitive-review-benchmark/ws5-acceptance-v1.json';
const PLAN_SHA256 = '9644d10aa9247d72eedd73cd358725a7dc8f0ff751b788e38965ba874fa09b9c';
const ARM_ID = 'alibaba-open-code-review';
const OLD_DECLARED_BINARY_SHA256 = 'dca5f00262ec9b050ce0fc10ed13eefb4fa2255e3c9c4aebb19723e55cae2779';
const SHA256_RE = /^[a-f0-9]{64}$/u;
const GIT_SHA_RE = /^[a-f0-9]{40}$/u;
const BUILD_COMMAND = 'go build -mod=readonly -trimpath -ldflags "-s -w -X main.Version=v1.12.12 -X main.GitCommit=182898cf522da3d04157b422752d028417974e19" -o <binary> ./cmd/opencodereview';

export const WS5_ALIBABA_BUILD_ARTIFACT_PIN = Object.freeze({
  schemaVersion: 'ReviewYetiWS5AlibabaBuildArtifactPin.v1',
  originalDeclaredBinarySha256: OLD_DECLARED_BINARY_SHA256,
  binarySha256: 'd20c332f55309976c39e53a0f2982270ad04a367edb96522a15e4801df1987af',
  mode: '0o700',
  sizeBytes: 52_967_794,
  platform: 'darwin/arm64',
  plan: { path: PLAN_PATH, sha256: PLAN_SHA256 },
  planField: 'publicRunMatrix.arms[alibaba-open-code-review].build.binarySha256',
  source: {
    repository: 'https://github.com/alibaba/open-code-review',
    commit: '182898cf522da3d04157b422752d028417974e19',
    tree: 'c92f28dfd5125b088461574354bc79abf78b8af5',
    version: 'v1.12.12',
  },
  buildWitness: {
    runnerSourceCommit: 'b54f9e5aa0ae9ac95b1368727ab2a799f06e00d6',
    runnerSourceTree: '44c3aa790429b756e3739e06d911c5cd1eb9b0cd',
    sourceFreezePatchSha256: 'ff277df6c32161658305457ac0be8acc23fca2af3b5f0d2157ab4cb83a1ad7d3',
    adapterSourcePath: 'scripts/ws5-alibaba.mjs',
    adapterSourceSha256: 'f512bffb86952317bd461e836afe357e4e7d07295656eb8f80fefd54e2ea61ca',
    buildScriptPath: 'scripts/build-ws5-alibaba.mjs',
    buildScriptSha256: 'fc886625cdb1f93bcd2eae95d322bce5b8ea1d1686ba2099acb98163c3878661',
    buildCommand: BUILD_COMMAND,
    buildFlagsSha256: '87019b0da1b5bdffbd60444b5ab5e61a2254b91c2098cb7914ef76611a506073',
    toolchain: 'go1.27.1 darwin/arm64',
    node: 'v24.21.0',
    goModSha256: '607f395abc650bb3b935fcbdd9e2ba28b0d385f690df177dd0b2f94cfe769e34',
    goSumSha256: '451c085faa94311114cc3df2e727756354139e8172e35e884976a0b34c3b4514',
    dependencyFetchReceiptSha256: '7ce39088ff25fec8b04877f323b464205c6c871d74e380913ffde8b6958dead4',
    childBoundaryReceiptSha256: '09d9ddb3a8c789f6205a3baa292b6469184080e61f0506c794da11c2214206bc',
    runReceipts: [
      { id: 'run2', sha256: '47d7bf7677a558943c014d78f4a5542d52bccdafe20efed78d40b1fedb6a8f08' },
      { id: 'run3', sha256: 'b1beb01f714c3a12ce4683f68eedb94b021fff75426d35f79269eccbfe42e4d2' },
    ],
  },
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function realDirectory(value, code) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(code);
  try {
    const info = fs.lstatSync(value);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(code);
    return fs.realpathSync(value);
  } catch { throw new Error(code); }
}

function realPrivateFile(value, { mode, sourceRoot, dataRoot, missingCode }) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(missingCode);
  let real;
  let info;
  try {
    info = fs.lstatSync(value);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(missingCode);
    real = fs.realpathSync(value);
  } catch { throw new Error(missingCode); }
  if (isWithin(sourceRoot, real) || isWithin(dataRoot, real)) throw new Error('ws5_alibaba_private_evidence_location_invalid');
  if ((info.mode & 0o777) !== mode) throw new Error('ws5_alibaba_private_evidence_mode_invalid');
  return { path: real, info };
}

function gitIdentity(root) {
  const run = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: process.env.HOME || '/tmp',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_OPTIONAL_LOCKS: '0',
    },
  }).trim();
  try {
    return {
      commit: run(['rev-parse', 'HEAD']),
      tree: run(['rev-parse', 'HEAD^{tree}']),
      clean: run(['status', '--porcelain=v1', '--untracked-files=normal']).length === 0,
    };
  } catch { throw new Error('ws5_alibaba_runner_git_identity_unavailable'); }
}

function gitOrigin(root) {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: process.env.HOME || '/tmp',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0',
      },
    }).trim().replace(/\.git$/u, '');
  } catch { throw new Error('ws5_alibaba_build_source_origin_unavailable'); }
}

function exact(value, expected, code) {
  if (canonicalJson(value) !== canonicalJson(expected)) throw new Error(code);
}

/** Pure fixed-pin claim validator; this checks a narrow provenance binding, not benchmark outcomes. */
export function assertWs5AlibabaDerivedBuildBindingClaims(binding, {
  plan,
  planSha256,
  sourceRootGit,
  externalDataContract,
} = {}) {
  const arm = plan?.publicRunMatrix?.arms?.find((entry) => entry.id === ARM_ID);
  const pin = WS5_ALIBABA_BUILD_ARTIFACT_PIN;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || binding.unitTestOnly === true
    || binding.schemaVersion !== WS5_ALIBABA_BUILD_BINDING_SCHEMA
    || binding.visibility !== 'private'
    || binding.status !== 'derived_from_two_identical_frozen_builds'
    || binding.modelCalls !== 0 || binding.providerCalls !== 0
    || !GIT_SHA_RE.test(String(sourceRootGit?.commit || ''))
    || !GIT_SHA_RE.test(String(sourceRootGit?.tree || '')) || sourceRootGit.clean !== true
    || sourceRootGit.commit !== binding.runnerSourceGit?.commit
    || sourceRootGit.tree !== binding.runnerSourceGit?.tree
    || binding.runnerSourceGit?.clean !== true
    || !externalDataContract || externalDataContract.schemaVersion !== 'ReviewYetiWS5ExternalDataContract.v1'
    || externalDataContract.sourceRootGit?.commit !== sourceRootGit.commit
    || externalDataContract.sourceRootGit?.tree !== sourceRootGit.tree
    || externalDataContract.sourceRootGit?.clean !== true
    || externalDataContract.preservedInputCount !== 22
    || !SHA256_RE.test(String(externalDataContract.sha256 || ''))
    || binding.planBinding?.path !== pin.plan.path
    || binding.planBinding?.sha256 !== pin.plan.sha256
    || planSha256 !== pin.plan.sha256 || binding.planBinding?.armId !== ARM_ID
    || binding.planBinding?.field !== pin.planField
    || binding.planBinding?.originalBinarySha256 !== pin.originalDeclaredBinarySha256
    || arm?.build?.binarySha256 !== pin.originalDeclaredBinarySha256
    || !Array.isArray(arm?.caseIds) || arm.caseIds.length !== 7
    || binding.planBinding?.caseIdsSha256 !== sha256(JSON.stringify(arm.caseIds))
    || binding.planBinding?.plannedMatrixCellCount !== 28
    || binding.planBinding?.supportedAlibabaCellCount !== 6
    || binding.planBinding?.unsupportedAlibabaCaseId !== 'aacr-cpp-85873'
    || binding.privateInputs?.planSha256 !== pin.plan.sha256
    || binding.privateInputs?.privateInputReceiptSha256 !== 'afad95f3b2f607e579a536168ab246ec4842cac8789cacc9a7e138f8f245a05c'
    || binding.privateInputs?.preservedInputCount !== 22
    || binding.privateInputs?.preservedInputSetSha256 !== '46f29b1f940a3cc76978bd0f59052ebbdca79a09268dc9b501c201b107dc1ad6'
    || binding.supersession?.scope !== 'single_existing_alibaba_binary_sha256_field'
    || binding.supersession?.planPath !== pin.plan.path
    || binding.supersession?.planSha256 !== pin.plan.sha256
    || binding.supersession?.field !== pin.planField
    || binding.supersession?.oldSha256 !== pin.originalDeclaredBinarySha256
    || binding.supersession?.selectedSha256 !== pin.binarySha256
    || binding.selectedArtifact?.sha256 !== pin.binarySha256
    || binding.selectedArtifact?.mode !== pin.mode
    || binding.selectedArtifact?.sizeBytes !== pin.sizeBytes
    || binding.selectedArtifact?.platform !== pin.platform
    || binding.selectedArtifact?.repository !== pin.source.repository
    || binding.selectedArtifact?.sourceCommit !== pin.source.commit
    || binding.selectedArtifact?.sourceTree !== pin.source.tree
    || binding.selectedArtifact?.sourceVersion !== pin.source.version) {
    throw new Error('ws5_alibaba_derived_binding_claim_mismatch');
  }
  exact(binding.buildWitness, pin.buildWitness, 'ws5_alibaba_build_witness_mismatch');
  if (binding.buildReceipts?.length !== 2 || binding.buildReceipts.some((receipt, index) =>
    receipt?.runId !== pin.buildWitness.runReceipts[index]?.id
      || receipt?.receiptSha256 !== pin.buildWitness.runReceipts[index]?.sha256
      || !path.isAbsolute(String(receipt?.receiptPath || ''))
      || !path.isAbsolute(String(receipt?.binaryPath || '')))) {
    throw new Error('ws5_alibaba_build_receipt_set_mismatch');
  }
  if (binding.dependencyFetchReceipt?.sha256 !== pin.buildWitness.dependencyFetchReceiptSha256
    || !path.isAbsolute(String(binding.dependencyFetchReceipt?.path || ''))
    || binding.childBoundaryReceipt?.sha256 !== pin.buildWitness.childBoundaryReceiptSha256
    || !path.isAbsolute(String(binding.childBoundaryReceipt?.path || ''))
    || !path.isAbsolute(String(binding.buildSourceCheckout?.path || ''))
    || binding.buildSourceCheckout?.repository !== pin.source.repository
    || binding.buildSourceCheckout?.commit !== pin.source.commit
    || binding.buildSourceCheckout?.tree !== pin.source.tree
    || binding.selectedArtifact?.path !== binding.buildReceipts[0].binaryPath) {
    throw new Error('ws5_alibaba_derived_binding_evidence_mismatch');
  }
  return {
    status: 'binding_claims_match_fixed_provenance',
    selectedBinarySha256: pin.binarySha256,
    supersededBinarySha256: pin.originalDeclaredBinarySha256,
    planSha256: pin.plan.sha256,
    sourceRootGit: { commit: sourceRootGit.commit, tree: sourceRootGit.tree },
    buildReceiptCount: 2,
  };
}

function readPrivateJson(filePath, expectedSha256, roots, mode, code) {
  const selected = realPrivateFile(filePath, {
    mode, sourceRoot: roots.sourceRoot, dataRoot: roots.dataRoot, missingCode: code,
  });
  const bytes = fs.readFileSync(selected.path);
  if (!SHA256_RE.test(String(expectedSha256 || '')) || sha256(bytes) !== expectedSha256) {
    throw new Error('ws5_alibaba_private_evidence_digest_mismatch');
  }
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('ws5_alibaba_private_evidence_invalid_json'); }
  return { path: selected.path, value, sha256: expectedSha256 };
}

function verifyBuildReceipt(receipt, runId, binaryPath, roots) {
  const pin = WS5_ALIBABA_BUILD_ARTIFACT_PIN;
  const witness = pin.buildWitness;
  const run3 = runId === 'run3';
  const source = receipt?.source || {};
  const actualBinaryPath = typeof receipt?.binary?.path === 'string' ? receipt.binary.path : receipt.binaryPath;
  const actualBinarySha = receipt?.binary?.sha256 || receipt?.binarySha256;
  const actualBinaryMode = receipt?.binary?.mode || receipt.binaryMode;
  const failures = run3
    ? receipt?.status !== 'reproduced_binary_digest_variance'
      || receipt?.buildScriptExitCode !== 2
      || receipt?.buildScriptFailureCode !== 'Pinned Alibaba build failed closed: alibaba_binary_digest_mismatch'
      || receipt?.planOrPinModified !== false
      || receipt?.helpExitCode !== 0
      || receipt?.requiredCliFlagsPresent !== true
      || receipt?.previousBuildSha256 !== pin.binarySha256
      || receipt?.declaredExpectedSha256 !== pin.originalDeclaredBinarySha256
      || receipt?.buildFlagsSha256 !== witness.buildFlagsSha256
    : receipt?.status !== 'binary_digest_variance'
      || receipt?.buildFailureClass !== 'Pinned Alibaba build failed closed: alibaba_binary_digest_mismatch\n'
      || receipt?.binary?.expectedSha256 !== pin.originalDeclaredBinarySha256;
  if (failures
    || receipt?.schemaVersion !== (run3 ? 'ReviewYetiAlibabaDeterministicBuildRepeat.v1' : 'ReviewYetiAlibabaBuildProvenance.v1')
    || source.commit && source.commit !== pin.source.commit
    || (run3 ? receipt.sourceCommit : source.commit) !== pin.source.commit
    || (run3 ? receipt.sourceTree : source.tree) !== pin.source.tree
    || (run3 ? receipt.sourceClean : source.clean) !== true
    || (run3 ? receipt.toolchain : receipt.toolchain?.go) !== witness.toolchain
    || receipt.buildScriptSourceCommit !== witness.runnerSourceCommit
    || receipt.buildScriptSourceTree !== witness.runnerSourceTree
    || (run3 ? receipt.sourceFreezePatchSha256 : receipt.sourceFreezePatchSha256) !== witness.sourceFreezePatchSha256
    || (run3 ? receipt.adapterSha256 : receipt.adapterSource?.sha256) !== witness.adapterSourceSha256
    || (run3 ? receipt.buildScriptSha256 : receipt.buildScript?.sha256) !== witness.buildScriptSha256
    || actualBinarySha !== pin.binarySha256 || actualBinaryMode !== pin.mode
    || typeof actualBinaryPath !== 'string' || fs.realpathSync(actualBinaryPath) !== fs.realpathSync(binaryPath)
    || receipt?.sourceFilesUnmodified !== true || receipt?.providerCalls !== 0
    || (!run3 && receipt?.dependencyFetchReceiptSha256 !== witness.dependencyFetchReceiptSha256)
    || (run3 && receipt?.toolchainAutoDownload !== 'disabled (GOTOOLCHAIN=local)')
    || (run3 && (!Array.isArray(receipt.versionOutput)
      || receipt.versionOutput[0] !== `open-code-review ${pin.source.version} (${pin.source.commit}) ${pin.platform}`
      || receipt.versionOutput[1] !== pin.source.repository))) {
    throw new Error('ws5_alibaba_build_receipt_content_mismatch');
  }
  const modBefore = receipt.sourceGoModSha256Before;
  const modAfter = receipt.sourceGoModSha256After;
  const sumBefore = receipt.sourceGoSumSha256Before;
  const sumAfter = receipt.sourceGoSumSha256After;
  if (modBefore !== witness.goModSha256 || modAfter !== modBefore
    || sumBefore !== witness.goSumSha256 || sumAfter !== sumBefore
    || receipt.buildCommand !== witness.buildCommand) {
    throw new Error('ws5_alibaba_build_source_inputs_mismatch');
  }
  return true;
}

/** Verify the private migration binding, its immutable build receipts, and the selected binary bytes. */
export function verifyWs5AlibabaDerivedBuildBinding({
  bindingPath,
  bindingSha256,
  binaryPath,
  sourceRoot,
  dataRoot,
  bundle,
} = {}) {
  if (typeof bindingPath !== 'string' || !path.isAbsolute(bindingPath)
    || !SHA256_RE.test(String(bindingSha256 || ''))
    || typeof binaryPath !== 'string' || !path.isAbsolute(binaryPath)
    || !bundle?.plan || !bundle?.externalDataContract || !bundle?.dataRootPath) {
    throw new Error('ws5_alibaba_derived_binding_required');
  }
  const roots = {
    sourceRoot: realDirectory(sourceRoot, 'ws5_alibaba_runner_source_root_invalid'),
    dataRoot: realDirectory(dataRoot || bundle.dataRootPath, 'ws5_alibaba_data_root_invalid'),
  };
  if (roots.sourceRoot !== SOURCE_ROOT || roots.dataRoot !== realDirectory(bundle.dataRootPath, 'ws5_alibaba_data_root_invalid')) {
    throw new Error('ws5_alibaba_binding_root_mismatch');
  }
  const currentSourceGit = gitIdentity(roots.sourceRoot);
  const bindingFile = readPrivateJson(bindingPath, bindingSha256, roots, 0o600, 'ws5_alibaba_derived_binding_missing');
  const binding = bindingFile.value;
  const { payloadSha256, ...unsigned } = binding;
  if (!SHA256_RE.test(String(payloadSha256 || '')) || sha256(canonicalJson(unsigned)) !== payloadSha256) {
    throw new Error('ws5_alibaba_derived_binding_payload_mismatch');
  }
  assertWs5AlibabaDerivedBuildBindingClaims(binding, {
    plan: bundle.plan,
    planSha256: bundle.panelSha256,
    sourceRootGit: currentSourceGit,
    externalDataContract: bundle.externalDataContract,
  });
  if (binding.externalDataContractSha256 !== bundle.externalDataContract.sha256
    || binding.privateInputs?.privateInputReceiptSha256 !== bundle.externalDataContract.privateInputReceiptSha256) {
    throw new Error('ws5_alibaba_binding_external_data_contract_mismatch');
  }
  const binary = realPrivateFile(binaryPath, {
    mode: 0o700, sourceRoot: roots.sourceRoot, dataRoot: roots.dataRoot, missingCode: 'alibaba_binary_missing',
  });
  if (binary.path !== fs.realpathSync(binding.selectedArtifact.path)
    || binary.info.size !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.sizeBytes
    || sha256(fs.readFileSync(binary.path)) !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.binarySha256) {
    throw new Error('ws5_alibaba_selected_binary_mismatch');
  }
  const receipts = binding.buildReceipts.map((entry, index) => readPrivateJson(
    entry.receiptPath,
    WS5_ALIBABA_BUILD_ARTIFACT_PIN.buildWitness.runReceipts[index].sha256,
    roots,
    0o600,
    'ws5_alibaba_build_receipt_missing',
  ));
  const binaries = binding.buildReceipts.map((entry) => realPrivateFile(entry.binaryPath, {
    mode: 0o700, sourceRoot: roots.sourceRoot, dataRoot: roots.dataRoot, missingCode: 'ws5_alibaba_build_artifact_missing',
  }));
  for (let index = 0; index < receipts.length; index += 1) {
    verifyBuildReceipt(receipts[index].value, binding.buildReceipts[index].runId,
      binding.buildReceipts[index].binaryPath, roots);
    if (binaries[index].path !== fs.realpathSync(binding.buildReceipts[index].binaryPath)
      || binaries[index].info.size !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.sizeBytes
      || sha256(fs.readFileSync(binaries[index].path)) !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.binarySha256) {
      throw new Error('ws5_alibaba_repeat_build_artifact_mismatch');
    }
  }
  if (binaries[0].path === binaries[1].path) throw new Error('ws5_alibaba_repeat_build_not_independent');
  const dependencyReceipt = readPrivateJson(binding.dependencyFetchReceipt.path,
    WS5_ALIBABA_BUILD_ARTIFACT_PIN.buildWitness.dependencyFetchReceiptSha256,
    roots, 0o600, 'ws5_alibaba_dependency_receipt_missing');
  if (dependencyReceipt.value.schemaVersion !== 'ReviewYetiGoPinnedDependencyFetch.v1'
    || dependencyReceipt.value.status !== 'exact_pins_verified'
    || dependencyReceipt.value.sourceCommit !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.source.commit
    || dependencyReceipt.value.toolchain !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.buildWitness.toolchain
    || dependencyReceipt.value.providerCalls !== 0) {
    throw new Error('ws5_alibaba_dependency_receipt_content_mismatch');
  }
  const childBoundaryReceipt = readPrivateJson(binding.childBoundaryReceipt.path,
    WS5_ALIBABA_BUILD_ARTIFACT_PIN.buildWitness.childBoundaryReceiptSha256,
    roots, 0o600, 'ws5_alibaba_child_boundary_receipt_missing');
  const childBoundary = childBoundaryReceipt.value;
  if (childBoundary.schemaVersion !== 'ReviewYetiAlibabaChildBoundary.v1'
    || childBoundary.status !== 'static_source_boundary_verified_binary_pin_reconciliation_required'
    || childBoundary.acceptancePlanSha256 !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.plan.sha256
    || childBoundary.acceptancePlanUnmodified !== true
    || childBoundary.binary?.measuredRun2Sha256 !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.binarySha256
    || childBoundary.binary?.measuredRun3Sha256 !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.binarySha256
    || childBoundary.binary?.declaredPlanSha256 !== OLD_DECLARED_BINARY_SHA256
    || childBoundary.binary?.run2Path !== binding.buildReceipts[0].binaryPath
    || childBoundary.binary?.run3Path !== binding.buildReceipts[1].binaryPath
    || childBoundary.binary?.run2ReceiptSha256 !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.buildWitness.runReceipts[0].sha256
    || childBoundary.binary?.run3ReceiptSha256 !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.buildWitness.runReceipts[1].sha256
    || childBoundary.binary?.repeatIdentical !== true
    || childBoundary.binary?.sourcePlanOrHardcodedPinChanged !== false
    || childBoundary.notAuthorized?.modelCalls !== false
    || childBoundary.notAuthorized?.matrixDispatch !== false
    || childBoundary.notAuthorized?.planMutation !== false
    || childBoundary.source?.sourcePath !== binding.buildSourceCheckout.path
    || childBoundary.source?.repository !== binding.buildSourceCheckout.repository
    || childBoundary.source?.commit !== binding.buildSourceCheckout.commit
    || childBoundary.source?.tree !== binding.buildSourceCheckout.tree
    || childBoundary.source?.clean !== true
    || childBoundary.nativeToolSurface?.shellToolPresent !== false) {
    throw new Error('ws5_alibaba_child_boundary_receipt_content_mismatch');
  }
  const buildSourceRoot = realDirectory(binding.buildSourceCheckout.path, 'ws5_alibaba_build_source_root_invalid');
  if (isWithin(roots.sourceRoot, buildSourceRoot) || isWithin(roots.dataRoot, buildSourceRoot)) {
    throw new Error('ws5_alibaba_build_source_root_invalid');
  }
  const buildSourceGit = gitIdentity(buildSourceRoot);
  if (buildSourceGit.commit !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.source.commit
    || buildSourceGit.tree !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.source.tree || !buildSourceGit.clean
    || gitOrigin(buildSourceRoot) !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.source.repository) {
    throw new Error('ws5_alibaba_build_source_identity_mismatch');
  }
  return {
    status: 'verified_fixed_alibaba_build_binding',
    bindingSha256: bindingFile.sha256,
    binarySha256: WS5_ALIBABA_BUILD_ARTIFACT_PIN.binarySha256,
    binarySizeBytes: WS5_ALIBABA_BUILD_ARTIFACT_PIN.sizeBytes,
    binaryMode: WS5_ALIBABA_BUILD_ARTIFACT_PIN.mode,
    sourceCommit: WS5_ALIBABA_BUILD_ARTIFACT_PIN.source.commit,
    sourceTree: WS5_ALIBABA_BUILD_ARTIFACT_PIN.source.tree,
    sourceVersion: WS5_ALIBABA_BUILD_ARTIFACT_PIN.source.version,
    toolchain: WS5_ALIBABA_BUILD_ARTIFACT_PIN.buildWitness.toolchain,
    buildReceiptCount: 2,
    supersededBinarySha256: OLD_DECLARED_BINARY_SHA256,
    privateDataRootExposedToModelChild: false,
    buildReceiptPathsExposedToModelChild: false,
  };
}

/** Build the payload digest used by the private-only binding writer. */
export function sealWs5AlibabaDerivedBuildBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new Error('ws5_alibaba_derived_binding_invalid');
  }
  const { payloadSha256: _ignored, ...unsigned } = binding;
  return { ...unsigned, payloadSha256: sha256(canonicalJson(unsigned)) };
}
