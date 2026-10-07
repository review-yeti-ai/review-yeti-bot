import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sha256 = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');
const sha1 = (value: string) => crypto.createHash('sha1').update(value).digest('hex');

// The production planner has one reserved source-scope abstention cell. Its case identifier is
// retained solely to exercise that existing branch; all metadata and source bytes here are synthetic.
export const UNIT_TEST_RESERVED_ABSTENTION_CASE_ID = 'aacr-cpp-85873';

function writeJson(root: string, relativePath: string, value: unknown) {
  const destination = path.join(root, relativePath);
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes, { mode: 0o600 });
  return { path: relativePath, sha256: sha256(bytes), bytes };
}

function gitBlobSha(content: string) {
  const bytes = Buffer.from(content, 'utf8');
  return sha1(`blob ${bytes.length}\0${content}`);
}

function makeSyntheticSource(caseId: string, ordinal: number, unsupported = false) {
  const datasetBaseSha = sha1(`unit-dataset-base:${caseId}`);
  const diffBaseSha = sha1(`unit-diff-base:${caseId}`);
  const headSha = sha1(`unit-head:${caseId}`);
  const repository = `synthetic/ws5-unit-${String(ordinal).padStart(2, '0')}`;
  const changedFiles = [{
    path: `src/unit-review-${String(ordinal).padStart(2, '0')}.ts`,
    patch: `--- a/src/unit-review-${String(ordinal).padStart(2, '0')}.ts\n+++ b/src/unit-review-${String(ordinal).padStart(2, '0')}.ts\n@@ -1 +1 @@\n-export const mode = "old-${ordinal}";\n+export const mode = "new-${ordinal}";\n`,
    originalPatchLength: 136,
  }];
  if (unsupported) changedFiles.push({
    path: 'assets/unit-boundary.unitbin',
    patch: 'Binary fixture boundary; generated for the unit-only scope test.\n',
    originalPatchLength: 64,
  });

  const source = {
    repository: { repositoryId: 900_000 + ordinal, owner: 'synthetic', repo: `ws5-unit-${String(ordinal).padStart(2, '0')}` },
    prNumber: 9_000 + ordinal,
    datasetBaseSha,
    diffBaseSha,
    mergeBaseSha: diffBaseSha,
    baseSha: diffBaseSha,
    headSha,
    changedPaths: changedFiles.map((entry) => entry.path),
    revisions: [
      {
        commitSha: diffBaseSha,
        treeSha: sha1(`unit-base-tree:${caseId}`),
        files: changedFiles.map((entry) => {
          const content = `export const fixtureCase = ${JSON.stringify(caseId)};\n`;
          return { path: entry.path, mode: '100644', sha256: sha256(content), gitBlobSha: gitBlobSha(content), content };
        }),
      },
      {
        commitSha: headSha,
        treeSha: sha1(`unit-head-tree:${caseId}`),
        files: changedFiles.map((entry) => {
          const content = `export const fixtureCase = ${JSON.stringify(caseId)};\nexport const revision = ${ordinal};\n`;
          return { path: entry.path, mode: '100644', sha256: sha256(content), gitBlobSha: gitBlobSha(content), content };
        }),
      },
    ],
    patches: changedFiles.map((entry) => ({ ...entry, sha256: sha256(entry.patch) })),
  };
  const inputValue = { schemaVersion: 'WS5UnitReviewInput.v1', caseId, unitFixture: true, source };
  return {
    inputValue,
    caseMetadata: {
      id: caseId,
      repository,
      prNumber: source.prNumber,
      datasetBaseSha,
      diffBaseSha,
      mergeBaseSha: diffBaseSha,
      baseSha: diffBaseSha,
      headSha,
      language: 'Synthetic',
      referenceContextLevels: ['Diff Level', 'File Level', 'Repo Level'],
    },
    sourceCase: {
      caseId,
      repository: source.repository.owner + '/' + source.repository.repo,
      prNumber: source.prNumber,
      datasetBaseSha,
      diffBaseSha,
      mergeBaseSha: diffBaseSha,
      baseSha: diffBaseSha,
      headSha,
      changedFiles: source.patches.map(({ path: filePath, patch, originalPatchLength }) => ({
        path: filePath, patch, originalPatchLength,
      })),
      sourceOmissions: [],
      sourceReadOmissions: [],
    },
  };
}

/**
 * Builds a temporary, public-neutral bundle for WS5 unit contracts. It carries no AACR rows,
 * held-out source, runtime qualification pins, or scoring oracle. Unit labels stay outside every
 * reviewer input and are exposed only as clearly marked test annotations.
 */
export function createWs5PublicTestFixture(repoRoot = process.cwd()) {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-public-unit-fixture-'));
  const caseIds = [
    UNIT_TEST_RESERVED_ABSTENTION_CASE_ID,
    ...Array.from({ length: 6 }, (_, index) => `unit-case-${String(index + 2).padStart(2, '0')}`),
  ];
  const sourceItems = caseIds.map((caseId, index) => makeSyntheticSource(caseId, index + 1, index === 0));
  const datasetSha256 = sha256('Review Yeti WS5 unit-only synthetic panel v1\n');
  const manifest = {
    schemaVersion: 'ReviewYetiWS5UnitManifest.v1',
    unitTestOnly: true,
    datasetSha256,
    cases: sourceItems.map((entry) => entry.caseMetadata),
  };
  const manifestArtifact = writeJson(artifactRoot, 'metadata/unit-manifest.json', manifest);

  const preparedDiscovery = {
    schemaVersion: 'ReviewYetiWS5UnitDiscoveryInput.v1',
    heldoutManifestSha256: manifestArtifact.sha256,
    cases: sourceItems.map((entry) => ({ ...entry.sourceCase })),
  };
  const discoveryArtifact = writeJson(artifactRoot, 'metadata/unit-prepared-discovery.json', preparedDiscovery);

  const verificationCaseIds = Array.from({ length: 28 }, (_, index) =>
    `unit-verification-${String(index + 1).padStart(2, '0')}`);
  const preparedVerification = {
    schemaVersion: 'ReviewYetiWS5UnitVerificationInput.v1',
    heldoutManifestSha256: manifestArtifact.sha256,
    cases: verificationCaseIds.map((caseId, index) => ({
      caseId,
      context: index < 10 ? 'Diff Level' : index < 19 ? 'File Level' : 'Repo Level',
      changedFiles: [{ path: `src/unit-verification-${String(index + 1).padStart(2, '0')}.ts`, patch: 'synthetic source only' }],
      sourceOmissions: [],
    })),
  };
  const verificationArtifact = writeJson(artifactRoot, 'metadata/unit-prepared-verification.json', preparedVerification);

  const sourceProfile = {
    schemaVersion: 'ReviewYetiWS5UnitSourceProfile.v1',
    heldoutManifestSha256: manifestArtifact.sha256,
    cases: sourceItems.map((entry) => ({
      caseId: entry.caseMetadata.id,
      diffBaseSha: entry.caseMetadata.diffBaseSha,
      datasetBaseSha: entry.caseMetadata.datasetBaseSha,
      headSha: entry.caseMetadata.headSha,
      changedFileCount: entry.sourceCase.changedFiles.length,
      preparedCaseSourceOmissions: [],
      compare: { status: 'verified' },
    })),
  };
  const sourceProfileArtifact = writeJson(artifactRoot, 'metadata/unit-source-profile.json', sourceProfile);

  const limitations = [{ path: 'assets/unit-boundary.unitbin', extension: '.unitbin', reason: 'unsupported_ext' }];
  const arms = [
    {
      id: 'yeti-v1-native-baseline', engine: 'Review Yeti', purpose: 'baseline',
      runtimeSha: 'a'.repeat(40), runtimeShaBinding: 'unit_test_only', effortProfile: 'native_omitted',
      verifierMode: 'absent_in_selected_v1_baseline', modelAlias: 'pr-reviewer',
      coverageModel: 'persona_panel', caseIds,
    },
    {
      id: 'yeti-revised-medium', engine: 'Review Yeti', purpose: 'qualification',
      runtimeSha: 'b'.repeat(40), runtimeShaBinding: 'unit_test_only', effortProfile: 'medium',
      verifierMode: 'production_independent_verifier_required', modelAlias: 'pr-reviewer',
      coverageModel: 'persona_panel', caseIds,
    },
    {
      id: 'alibaba-open-code-review', engine: 'OpenCodeReview', purpose: 'unit_comparator',
      runtimeSha: null, modelAlias: 'pr-reviewer',
      coverageModel: 'single_agent_file_manifest_no_persona_quorum', caseIds,
      nativeSourceLimitations: { [UNIT_TEST_RESERVED_ABSTENTION_CASE_ID]: limitations },
    },
    {
      id: 'yeti-revised-medium-repeat', engine: 'Review Yeti', purpose: 'repeat_stability',
      runtimeSha: 'b'.repeat(40), runtimeShaBinding: 'unit_test_only', effortProfile: 'medium',
      verifierMode: 'production_independent_verifier_required', modelAlias: 'pr-reviewer',
      coverageModel: 'persona_panel', caseIds,
    },
  ];
  const plan = {
    schemaVersion: 'ReviewYetiWS5Acceptance.v1',
    testFixture: { classification: 'unit-test-only', runtimeQualificationEligible: false },
    publicPanel: {
      datasetSha256,
      manifestPath: manifestArtifact.path,
      manifestSha256: manifestArtifact.sha256,
      sourceProfilePath: sourceProfileArtifact.path,
      sourceProfileSha256: sourceProfileArtifact.sha256,
      preparedInputSha256: discoveryArtifact.sha256,
      preparedInputs: {
        discovery: { path: discoveryArtifact.path, sha256: discoveryArtifact.sha256 },
        verification: { path: verificationArtifact.path, sha256: verificationArtifact.sha256 },
      },
      caseIds,
    },
    publicRunMatrix: {
      requiredPublicRunCount: 28,
      arms,
      comparisonDenominators: { AlibabaNativeSourceComplete: 6 },
    },
    verificationPanel: {
      preparedInputSha256: verificationArtifact.sha256,
      diffLevelCaseIds: verificationCaseIds.slice(0, 10),
      labelCounts: { positive: 7, negative: 3, total: 10 },
    },
    providerIdentityGate: { primaryModelAlias: 'pr-reviewer' },
  };
  const planArtifact = writeJson(artifactRoot, 'metadata/unit-acceptance-plan.json', plan);

  const syntheticCases = sourceItems.slice(0, 1).flatMap(() => Array.from({ length: 8 }, (_, index) => {
    const caseId = `unit-lifecycle-${String(index + 1).padStart(2, '0')}`;
    const inputValue = {
      schemaVersion: 'WS5UnitLifecycleInput.v1',
      caseId,
      unitFixture: true,
      source: { repository: { owner: 'synthetic', repo: 'unit-lifecycle' }, revision: index + 1,
        changedPaths: [`src/lifecycle-${index + 1}.ts`], patch: `+export const revision = ${index + 1};\n` },
    };
    const artifact = writeJson(artifactRoot, `inputs/${caseId}.json`, inputValue);
    return { caseId, inputPath: artifact.path, inputSha256: artifact.sha256, inputValue };
  }));

  // These labels exist only to prove separation in the unit harness; never attach them to any input.
  const unitOnlyLabels = {
    classification: 'unit-test-only',
    cases: verificationCaseIds.slice(0, 10).map((caseId, index) => ({
      caseId,
      label: index < 7 ? 'synthetic_positive' : 'synthetic_negative',
    })),
  };

  // Copy only the small, checked-in public policy projections used by the production normalizer.
  for (const file of ['yeti-v1-native-omitted.json', 'yeti-v1-medium.json']) {
    const source = path.join(repoRoot, 'eval-baselines/competitive-review-benchmark/policy-projections', file);
    const destination = path.join(artifactRoot, 'eval-baselines/competitive-review-benchmark/policy-projections', file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }

  return {
    artifactRoot,
    unitOnlyLabels,
    bundle: {
      rootPath: artifactRoot,
      plan,
      panelSha256: planArtifact.sha256,
      manifest,
      manifestSha256: manifestArtifact.sha256,
      sourceProfile,
      preparedDiscovery,
      preparedVerification,
      liveArms: {
        arms: Array.from({ length: 10 }, (_, index) => ({
          runId: `unit-live-run-${index + 1}`, caseId: caseIds[index % caseIds.length], inputId: `unit-input-${index + 1}`,
        })),
        execution: {
          providerFailureControl: { physicalModelRequestsMax: 1 },
          resourceExhaustionControl: { testDeadlineSeconds: 60 },
        },
      },
      syntheticCases,
      reservedAbstentionCaseId: UNIT_TEST_RESERVED_ABSTENTION_CASE_ID,
      metadataPaths: {
        plan: path.join(artifactRoot, planArtifact.path),
        manifest: path.join(artifactRoot, manifestArtifact.path),
        sourceProfile: path.join(artifactRoot, sourceProfileArtifact.path),
        preparedDiscovery: path.join(artifactRoot, discoveryArtifact.path),
        preparedVerification: path.join(artifactRoot, verificationArtifact.path),
      },
    },
    cleanup: () => fs.rmSync(artifactRoot, { recursive: true, force: true }),
  };
}
