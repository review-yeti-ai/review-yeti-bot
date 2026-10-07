import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const WS5_EXTERNAL_DATA_CONTRACT_SCHEMA = 'ReviewYetiWS5ExternalDataContract.v1';
export const WS5_SOURCE_PROFILE_MAPPING_SCHEMA = 'ReviewYetiWS5SourceProfileMapping.v1';
export const WS5_EXTERNAL_DATA_INPUT_COUNT = 22;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const GIT_SHA_RE = /^[a-f0-9]{40}$/u;
const INPUT_ROLES = new Set([
  'acceptance-plan',
  'public-manifest',
  'legacy-source-profile',
  'source-profile-v2',
  'legacy-prepared-input',
  'prepared-input-v2',
  'policy-projection',
  'synthetic-descriptor',
  'synthetic-worker-input',
  'scorer-oracle',
  'normalization-report',
  'live-arm-descriptor',
]);

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

function realDirectory(value, failureCode) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(failureCode);
  let real;
  try { real = fs.realpathSync(value); } catch { throw new Error(failureCode); }
  let info;
  try { info = fs.lstatSync(value); } catch { throw new Error(failureCode); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(failureCode);
  return real;
}

export function resolveWs5ExternalDataRoots(sourceRoot, dataRoot) {
  const source = realDirectory(sourceRoot, 'ws5_external_source_root_invalid');
  const data = realDirectory(dataRoot, 'ws5_external_data_root_invalid');
  if (isWithin(source, data) || isWithin(data, source)) throw new Error('ws5_external_data_root_must_be_separate');
  return { sourceRoot: source, dataRoot: data };
}

/** Resolve an untrusted repository-relative input without following any symlink component. */
export function resolveWs5ExternalDataPath(dataRoot, relativePath) {
  const root = realDirectory(dataRoot, 'ws5_external_data_root_invalid');
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)
    || relativePath.includes('\0') || relativePath.includes('\\')
    || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('ws5_external_data_path_invalid');
  }
  const candidate = path.resolve(root, ...relativePath.split('/'));
  if (!isWithin(root, candidate) || candidate === root) throw new Error('ws5_external_data_path_escape');
  let cursor = root;
  for (const segment of relativePath.split('/')) {
    cursor = path.join(cursor, segment);
    let info;
    try { info = fs.lstatSync(cursor); } catch { throw new Error('ws5_external_data_file_missing'); }
    if (info.isSymbolicLink()) throw new Error('ws5_external_data_symlink_forbidden');
  }
  let real;
  try { real = fs.realpathSync(candidate); } catch { throw new Error('ws5_external_data_file_missing'); }
  if (!isWithin(root, real) || !fs.statSync(real).isFile()) throw new Error('ws5_external_data_path_escape');
  return real;
}

function assertNoPrivateCaseFields(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoPrivateCaseFields);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (['oracle', 'history', 'expectedDecision', 'expectedOutcome', 'expectedFindings', 'expectedLabel']
      .includes(key)) throw new Error('ws5_child_input_contains_private_scoring_field');
    assertNoPrivateCaseFields(entry);
  }
}

/** Stage exact public manifest/case bytes without exposing a data-root or scorer path to the child. */
/** @param {any} bundle @param {string} directory @param {'discovery'|'verification'} panelKind
 * @param {{policyProjectionBytes?: Buffer|null}} [options]
 * @returns {{manifestPath:string,casesPath:string,adapterPolicyPath?:string,stagedFileNames:string[],adapterPolicyStaged:boolean,privateOraclePathStaged:false,externalDataRootPathExposed:false}} */
export function createWs5PublicInputStage(bundle, directory, panelKind, { policyProjectionBytes = null } = {}) {
  const sourceRoot = realDirectory(bundle?.rootPath, 'ws5_child_stage_source_root_invalid');
  const dataRoot = realDirectory(bundle?.dataRootPath, 'ws5_child_stage_data_root_invalid');
  if (isWithin(sourceRoot, dataRoot) || isWithin(dataRoot, sourceRoot)
    || !['discovery', 'verification'].includes(panelKind)
    || !Buffer.isBuffer(bundle?.pinnedChildInputBytes?.manifest)
    || !Buffer.isBuffer(bundle?.pinnedChildInputBytes?.[panelKind])) {
    throw new Error('ws5_child_stage_input_invalid');
  }
  const stageDir = path.resolve(directory || '');
  let stageReal;
  try { stageReal = fs.realpathSync(stageDir); } catch { throw new Error('ws5_child_stage_directory_invalid'); }
  const stageInfo = fs.lstatSync(stageDir);
  if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink()
    || isWithin(sourceRoot, stageReal) || isWithin(dataRoot, stageReal)
    || fs.readdirSync(stageReal).length !== 0) throw new Error('ws5_child_stage_directory_invalid');

  const selectedBytes = bundle.pinnedChildInputBytes[panelKind];
  const selected = JSON.parse(selectedBytes.toString('utf8'));
  assertNoPrivateCaseFields(selected);
  const manifest = JSON.parse(bundle.pinnedChildInputBytes.manifest.toString('utf8'));
  assertNoPrivateCaseFields(manifest);
  if (policyProjectionBytes !== null) {
    if (!Buffer.isBuffer(policyProjectionBytes)) throw new Error('ws5_child_stage_policy_projection_invalid');
    try { JSON.parse(policyProjectionBytes.toString('utf8')); }
    catch { throw new Error('ws5_child_stage_policy_projection_invalid'); }
  }
  const manifestPath = path.join(stageReal, 'manifest.json');
  const casesPath = path.join(stageReal, 'cases.json');
  fs.writeFileSync(manifestPath, bundle.pinnedChildInputBytes.manifest, { mode: 0o400, flag: 'wx' });
  fs.writeFileSync(casesPath, selectedBytes, { mode: 0o400, flag: 'wx' });
  fs.chmodSync(manifestPath, 0o400);
  fs.chmodSync(casesPath, 0o400);
  let adapterPolicyPath = null;
  if (policyProjectionBytes !== null) {
    adapterPolicyPath = path.join(stageReal, 'policy-projection.json');
    fs.writeFileSync(adapterPolicyPath, policyProjectionBytes, { mode: 0o400, flag: 'wx' });
    fs.chmodSync(adapterPolicyPath, 0o400);
  }
  return {
    manifestPath,
    casesPath,
    ...(adapterPolicyPath ? { adapterPolicyPath } : {}),
    stagedFileNames: ['manifest.json', 'cases.json', ...(adapterPolicyPath ? ['policy-projection.json'] : [])],
    adapterPolicyStaged: Boolean(adapterPolicyPath),
    privateOraclePathStaged: false,
    externalDataRootPathExposed: false,
  };
}

function actualSourceGitIdentity(sourceRoot) {
  const git = (args) => execFileSync('git', args, {
    cwd: sourceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: process.env.HOME || '/tmp',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_OPTIONAL_LOCKS: '0',
    },
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  }).trim();
  try {
    return {
      commit: git(['rev-parse', 'HEAD']),
      tree: git(['rev-parse', 'HEAD^{tree}']),
      clean: git(['status', '--porcelain=v1', '--untracked-files=normal']).length === 0,
    };
  } catch { throw new Error('ws5_external_source_git_identity_unavailable'); }
}

export function sealWs5ExternalDataContract(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('ws5_external_data_contract_invalid');
  }
  const { payloadSha256: _ignored, ...unsigned } = payload;
  return { ...unsigned, payloadSha256: sha256(canonicalJson(unsigned)) };
}

/** Validate a private input manifest and hash every retained data-root file without parsing it. */
/** @param {{sourceRoot: string, dataRoot: string, contractPath: string, expectedContractSha256: string,
 * expectedPlanPath: string, expectedPlanSha256: string, requireCleanSourceRoot?: boolean,
 * allowUnitTestOnly?: boolean}} options */
export function verifyWs5ExternalDataContract({
  sourceRoot,
  dataRoot,
  contractPath,
  expectedContractSha256,
  expectedPlanPath,
  expectedPlanSha256,
  requireCleanSourceRoot = true,
  allowUnitTestOnly = false,
} = {}) {
  const roots = resolveWs5ExternalDataRoots(sourceRoot, dataRoot);
  if (typeof expectedPlanPath !== 'string' || !expectedPlanPath
    || typeof expectedPlanSha256 !== 'string' || !SHA256_RE.test(expectedPlanSha256)
    || !SHA256_RE.test(String(expectedContractSha256 || ''))
    || typeof contractPath !== 'string' || !path.isAbsolute(contractPath)) {
    throw new Error('ws5_external_data_contract_binding_invalid');
  }
  let contractReal;
  try { contractReal = fs.realpathSync(contractPath); } catch { throw new Error('ws5_external_data_contract_missing'); }
  const contractStat = fs.lstatSync(contractPath);
  if (!contractStat.isFile() || contractStat.isSymbolicLink()
    || isWithin(roots.sourceRoot, contractReal) || isWithin(roots.dataRoot, contractReal)) {
    throw new Error('ws5_external_data_contract_location_invalid');
  }
  if ((contractStat.mode & 0o077) !== 0) throw new Error('ws5_external_data_contract_permissions_invalid');
  const contractBytes = fs.readFileSync(contractReal);
  const contractSha256 = sha256(contractBytes);
  if (contractSha256 !== expectedContractSha256) throw new Error('ws5_external_data_contract_digest_mismatch');
  let contract;
  try { contract = JSON.parse(contractBytes.toString('utf8')); }
  catch { throw new Error('ws5_external_data_contract_invalid_json'); }
  if (contract.unitTestOnly === true && allowUnitTestOnly !== true) {
    throw new Error('ws5_external_data_contract_unit_fixture_forbidden');
  }
  if (contract.schemaVersion !== WS5_EXTERNAL_DATA_CONTRACT_SCHEMA
    || contract.acceptancePlan?.path !== expectedPlanPath
    || contract.acceptancePlan?.sha256 !== expectedPlanSha256
    || contract.preservedInputCount !== WS5_EXTERNAL_DATA_INPUT_COUNT
    || !Array.isArray(contract.inputs) || contract.inputs.length !== WS5_EXTERNAL_DATA_INPUT_COUNT
    || !contract.sourceRootGit || !GIT_SHA_RE.test(String(contract.sourceRootGit.commit || ''))
    || !GIT_SHA_RE.test(String(contract.sourceRootGit.tree || ''))
    || (requireCleanSourceRoot && contract.sourceRootGit.clean !== true)
    || !contract.privateInputReceipt || contract.privateInputReceipt.count !== WS5_EXTERNAL_DATA_INPUT_COUNT
    || !SHA256_RE.test(String(contract.privateInputReceipt.sha256 || ''))
    || contract.sourceProfileMapping?.schemaVersion !== WS5_SOURCE_PROFILE_MAPPING_SCHEMA
    || contract.sourceProfileMapping?.mode !== 'verified_v2_current_profile'
    || contract.sourceProfileMapping?.status !== 'verified'
    || !SHA256_RE.test(String(contract.sourceProfileMapping?.v1ProfileSha256 || ''))
    || !SHA256_RE.test(String(contract.sourceProfileMapping?.v2ProfileSha256 || ''))
    || !SHA256_RE.test(String(contract.sourceProfileMapping?.normalizationReportSha256 || ''))
    || typeof contract.sourceProfileMapping?.v1ProfilePath !== 'string'
    || typeof contract.sourceProfileMapping?.normalizationReportPath !== 'string'
    || contract.sourceProfileMapping?.v2ProfileSha256 !== contract.publicSourceProfile?.sha256
    || contract.sourceProfileMapping?.v2ProfilePath !== contract.publicSourceProfile?.path
    || contract.publicSourceProfile?.schemaVersion !== 'WS5SourceProfile.v2'
    || !SHA256_RE.test(String(contract.publicSourceProfile?.sha256 || ''))
    || !Array.isArray(contract.childVisibleInputIds)) {
    throw new Error('ws5_external_data_contract_shape_invalid');
  }
  const { payloadSha256, ...unsigned } = contract;
  if (!SHA256_RE.test(String(payloadSha256 || '')) || sha256(canonicalJson(unsigned)) !== payloadSha256) {
    throw new Error('ws5_external_data_contract_payload_digest_mismatch');
  }
  const currentGit = actualSourceGitIdentity(roots.sourceRoot);
  if (currentGit.commit !== contract.sourceRootGit.commit || currentGit.tree !== contract.sourceRootGit.tree
    || (requireCleanSourceRoot && !currentGit.clean)) {
    throw new Error('ws5_external_source_root_git_identity_mismatch');
  }
  const inputsById = new Map();
  const inputsByPath = new Set();
  const rolesById = new Map();
  let scorerOracleCount = 0;
  for (const entry of contract.inputs) {
    if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,80}$/u.test(entry.id)
      || inputsById.has(entry.id) || typeof entry.path !== 'string' || inputsByPath.has(entry.path)
      || !SHA256_RE.test(String(entry.sha256 || '')) || !INPUT_ROLES.has(entry.role)) {
      throw new Error('ws5_external_data_contract_input_invalid');
    }
    const resolved = resolveWs5ExternalDataPath(roots.dataRoot, entry.path);
    if (sha256(fs.readFileSync(resolved)) !== entry.sha256) throw new Error('ws5_external_data_input_digest_mismatch');
    if (entry.role === 'scorer-oracle') {
      if (!/(?:^|\/)oracle(?:\/|$)/u.test(entry.path)) throw new Error('ws5_external_oracle_role_mismatch');
      scorerOracleCount += 1;
    } else if (/(?:^|\/)oracle(?:\/|$)/u.test(entry.path)) {
      throw new Error('ws5_external_oracle_role_mismatch');
    }
    inputsById.set(entry.id, entry);
    inputsByPath.add(entry.path);
    rolesById.set(entry.id, entry.role);
  }
  if (!Array.isArray(contract.childVisibleInputIds)
    || new Set(contract.childVisibleInputIds).size !== contract.childVisibleInputIds.length
    || contract.childVisibleInputIds.some((id) => !inputsById.has(id)
      || ['scorer-oracle', 'legacy-source-profile', 'legacy-prepared-input'].includes(rolesById.get(id)))) {
    throw new Error('ws5_external_child_input_visibility_invalid');
  }
  const planPath = resolveWs5ExternalDataPath(roots.dataRoot, expectedPlanPath);
  if (sha256(fs.readFileSync(planPath)) !== expectedPlanSha256) throw new Error('ws5_acceptance_plan_digest_mismatch');
  const planEntry = contract.inputs.find((entry) => entry.role === 'acceptance-plan');
  if (!planEntry || planEntry.path !== expectedPlanPath || planEntry.sha256 !== expectedPlanSha256) {
    throw new Error('ws5_external_data_contract_plan_binding_mismatch');
  }
  return {
    sourceRoot: roots.sourceRoot,
    dataRoot: roots.dataRoot,
    planPath,
    contractPath: contractReal,
    contractSha256,
    contract,
    sourceRootGit: currentGit,
    preservedInputCount: contract.inputs.length,
    scorerOracleCount,
    childVisibleInputCount: contract.childVisibleInputIds.length,
    sourceProfileMapping: contract.sourceProfileMapping,
  };
}
