import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import * as ws5 from '../../scripts/ws5-acceptance.mjs';
import * as externalData from '../../scripts/ws5-external-data-contract.mjs';

const temporaryRoots: string[] = [];
const sha256 = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeContractFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-external-contract-test-'));
  temporaryRoots.push(root);
  const sourceRoot = path.join(root, 'source');
  const dataRoot = path.join(root, 'data');
  const contractRoot = path.join(root, 'private-contract');
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(dataRoot);
  fs.mkdirSync(contractRoot);
  execFileSync('git', ['init', '--quiet', sourceRoot], { stdio: 'ignore' });
  execFileSync('git', ['-C', sourceRoot, 'config', 'user.name', 'WS5 test fixture'], { stdio: 'ignore' });
  execFileSync('git', ['-C', sourceRoot, 'config', 'user.email', 'ws5-test@example.invalid'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(sourceRoot, 'source.txt'), 'unit-only source root\n');
  execFileSync('git', ['-C', sourceRoot, 'add', 'source.txt'], { stdio: 'ignore' });
  execFileSync('git', ['-C', sourceRoot, 'commit', '--quiet', '-m', 'unit-only source fixture'], { stdio: 'ignore' });
  const sourceRootGit = {
    commit: execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    tree: execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
    clean: true,
  };
  const planPath = 'eval-baselines/competitive-review-benchmark/ws5-acceptance-v1.json';
  const planBytes = Buffer.from('{"unitTestOnly":true}\n');
  const planFile = path.join(dataRoot, planPath);
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, planBytes);
  const inputs = [];
  for (let index = 0; index < 22; index += 1) {
    const id = `unit-input-${String(index + 1).padStart(2, '0')}`;
    const relativePath = index === 0 ? planPath
      : index === 1 ? 'eval-baselines/oracle/unit/oracle.json' : `retained/${id}.json`;
    const bytes = index === 0 ? planBytes : Buffer.from(`${id}\n`);
    const file = path.join(dataRoot, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (index !== 0) fs.writeFileSync(file, bytes);
    inputs.push({ id, path: relativePath, sha256: sha256(bytes),
      role: index === 0 ? 'acceptance-plan' : index === 1 ? 'scorer-oracle' : 'synthetic-worker-input' });
  }
  const contractPayload = {
    schemaVersion: externalData.WS5_EXTERNAL_DATA_CONTRACT_SCHEMA,
    unitTestOnly: true,
    acceptancePlan: { path: planPath, sha256: sha256(planBytes) },
    sourceRootGit,
    preservedInputCount: 22,
    privateInputReceipt: { sha256: 'c'.repeat(64), count: 22 },
    sourceProfileMapping: {
      schemaVersion: externalData.WS5_SOURCE_PROFILE_MAPPING_SCHEMA,
      mode: 'verified_v2_current_profile',
      status: 'verified',
      v1ProfileSha256: 'd'.repeat(64),
      v2ProfileSha256: 'e'.repeat(64),
      v1ProfilePath: 'eval-baselines/competitive-review-benchmark/aacr-ws5-source-profile-v1.json',
      normalizationReportSha256: 'f'.repeat(64),
      normalizationReportPath: 'eval-baselines/competitive-review-benchmark/aacr-ws5-index-normalization-v1.json',
      v2ProfilePath: 'eval-baselines/competitive-review-benchmark/aacr-ws5-source-profile-v2.json',
    },
    publicSourceProfile: {
      schemaVersion: 'WS5SourceProfile.v2',
      path: 'eval-baselines/competitive-review-benchmark/aacr-ws5-source-profile-v2.json',
      sha256: 'e'.repeat(64),
    },
    childVisibleInputIds: ['unit-input-03'],
    inputs,
  };
  const contract = externalData.sealWs5ExternalDataContract(contractPayload);
  const contractBytes = Buffer.from(JSON.stringify(contract, null, 2) + '\n');
  const contractPath = path.join(contractRoot, 'external-data-contract.json');
  fs.writeFileSync(contractPath, contractBytes, { mode: 0o600 });
  return { sourceRoot, dataRoot, contractPath, contractSha256: sha256(contractBytes), planPath,
    planSha256: sha256(planBytes), oraclePath: path.join(dataRoot, inputs[1].path) };
}

describe('WS5 external private-data contract', () => {
  it('requires explicit external data-root and plan paths instead of defaulting to source files', () => {
    expect(() => ws5.loadPinnedAcceptancePlan()).toThrow('ws5_external_data_bundle_required');
  });

  it('binds 22 retained external inputs to a clean source-root Git identity and keeps oracle IDs out of child-visible inputs', () => {
    const fixture = makeContractFixture();
    const verified = externalData.verifyWs5ExternalDataContract({
      sourceRoot: fixture.sourceRoot,
      dataRoot: fixture.dataRoot,
      contractPath: fixture.contractPath,
      expectedContractSha256: fixture.contractSha256,
      expectedPlanPath: fixture.planPath,
      expectedPlanSha256: fixture.planSha256,
      allowUnitTestOnly: true,
    });
    expect(verified).toMatchObject({
      sourceRoot: fs.realpathSync(fixture.sourceRoot),
      dataRoot: fs.realpathSync(fixture.dataRoot),
      preservedInputCount: 22,
      scorerOracleCount: 1,
      childVisibleInputCount: 1,
      sourceRootGit: { clean: true },
    });
    expect(verified).not.toHaveProperty('oraclePaths');
    expect(() => externalData.verifyWs5ExternalDataContract({
      sourceRoot: fixture.sourceRoot,
      dataRoot: fixture.dataRoot,
      contractPath: fixture.contractPath,
      expectedContractSha256: fixture.contractSha256,
      expectedPlanPath: fixture.planPath,
      expectedPlanSha256: fixture.planSha256,
    })).toThrow('ws5_external_data_contract_unit_fixture_forbidden');
  });

  it('refuses external data paths that traverse up or follow a symlink', () => {
    const fixture = makeContractFixture();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-external-outside-'));
    temporaryRoots.push(outsideRoot);
    const outside = path.join(outsideRoot, 'private.txt');
    fs.writeFileSync(outside, 'not an allowed panel input');
    fs.symlinkSync(outside, path.join(fixture.dataRoot, 'escape-link'));
    expect(() => externalData.resolveWs5ExternalDataPath(fixture.dataRoot, '../private.txt'))
      .toThrow('ws5_external_data_path_invalid');
    expect(() => externalData.resolveWs5ExternalDataPath(fixture.dataRoot, 'escape-link'))
      .toThrow('ws5_external_data_symlink_forbidden');
  });

  it('stages only exact manifest and case bytes for the model child outside source and private data roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-child-stage-test-'));
    temporaryRoots.push(root);
    const sourceRoot = path.join(root, 'source');
    const dataRoot = path.join(root, 'private-data');
    const stageRoot = path.join(root, 'stage');
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(dataRoot);
    fs.mkdirSync(stageRoot);
    const manifest = Buffer.from('{"schemaVersion":"unit-only-manifest"}\n');
    const cases = Buffer.from('{"schemaVersion":"unit-only-input","cases":[{"caseId":"unit-case"}]}\n');
    const policy = Buffer.from('{"unitOnly":true}\n');
    const stage = externalData.createWs5PublicInputStage({
      rootPath: sourceRoot, dataRootPath: dataRoot,
      pinnedChildInputBytes: { manifest, discovery: cases, verification: cases },
    }, stageRoot, 'discovery', { policyProjectionBytes: policy });
    expect(fs.readFileSync(stage.manifestPath)).toEqual(manifest);
    expect(fs.readFileSync(stage.casesPath)).toEqual(cases);
    const adapterPolicyPath = stage.adapterPolicyPath;
    expect(typeof adapterPolicyPath).toBe('string');
    if (typeof adapterPolicyPath !== 'string') throw new Error('test_policy_stage_missing');
    expect(fs.readFileSync(adapterPolicyPath)).toEqual(policy);
    expect(fs.readdirSync(stageRoot).sort()).toEqual(['cases.json', 'manifest.json', 'policy-projection.json']);
    expect(fs.statSync(stage.casesPath).mode & 0o777).toBe(0o400);
    expect(stage).toMatchObject({ adapterPolicyStaged: true, externalDataRootPathExposed: false,
      privateOraclePathStaged: false });
    expect(path.relative(sourceRoot, stage.casesPath).startsWith('..')).toBe(true);
    expect(path.relative(dataRoot, stage.casesPath).startsWith('..')).toBe(true);
  });
});
