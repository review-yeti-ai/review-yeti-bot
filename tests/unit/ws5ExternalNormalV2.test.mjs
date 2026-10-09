import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { verifyQualificationFixtureAllowlist } from '../../scripts/normal-engine-qualification-fixtures.mjs';
import { createExternalNormalV2ExactLogCollector } from '../../scripts/ws5-external-bifrost-log-collector.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const runnerUrl = pathToFileURL(new URL('../../scripts/ws5-external-normal-v2.mjs', import.meta.url).pathname);
const runner = await import(runnerUrl.href).catch(() => null);
const r2PlanBytes = await readFile(new URL('../fixtures/qualification/ws5-r2-cohort-plan.json', import.meta.url));
const r2PlanTemplate = JSON.parse(r2PlanBytes.toString('utf8'));
const R2_RUNTIME_SOURCE_REVISION = 'f8a07165a478b499536f55a80f0003b8540eaed0';
const R2_HELPER_SOURCE_SHA256 = '4ab88f14b6dc7e263b866ae56715d41d25f3ae716b32429f6e92eb991504f4c3';
const R2_HELPER_COMPILED_SHA256 = '972c1687e4d24f30352fbe464e4f420461aa2a48dbfab69636b24de9f1fd621d';
const require = createRequire(import.meta.url);
const loadedHostAdapter = require('../../dist/qualification/normalEngineQualificationExternalV2.js');
await import('./ws5ExternalNormalR2Plan.test.mjs');

function privateBinding(canonicalPath = path.join(tmpdir(), 'ws5-private-phase-root')) {
  return {
    schemaVersion: runner.EXTERNAL_NORMAL_V2_PRIVATE_BINDING_SCHEMA,
    credentialBindingSha256: 'a'.repeat(64),
    phaseRoot: { canonicalPath, uid: process.getuid?.() ?? 1, gid: process.getgid?.() ?? 1,
      mode: 0o700, initialEntryCount: 0 },
    sourceDescriptor: { repository: 'exampleorg/review-policy-fixture', repositoryId: 73,
      sourceRef: 'b'.repeat(40), path: 'policy/candidate.json', contentSha256: 'c'.repeat(64),
      candidateHead: 'd'.repeat(40), preparedFixtureReviewHead: 'e'.repeat(40) },
    transport: { selectedBaseUrl: 'https://gateway.example.invalid/v1', modelAlias: 'fixture-reviewer' },
    managementBaseUrl: 'https://management.example.invalid',
    policy: {
      candidateGitBlob: '6'.repeat(40),
      executionPlanFixtureSha256: '7'.repeat(64), executionPlanNormalizedSha256: '8'.repeat(64),
      preparedExecutionFixtureSha256: '9'.repeat(64), preparedExecutionManifestSha256: 'a'.repeat(64),
      preparedExecutionSha256: '8'.repeat(64), syntheticProjectionFixtureSha256: 'c'.repeat(64),
      centralEffectiveConfigProjectionSha256: 'd'.repeat(64), effectiveConfigSha256: 'e'.repeat(64),
      effectivePolicySha256: 'f'.repeat(64), v1Promotion: 'fixture-v1-promotion',
      policyInputDigests: { candidatePath: 'c'.repeat(64), executionPlanFixturePath: '2'.repeat(64),
        preparedExecutionFixturePath: '3'.repeat(64), syntheticProjectionPath: '4'.repeat(64),
        preparedExecutionManifestPath: '5'.repeat(64) },
      targetProjections: [73002, 73003, 73004].map((repositoryId) => ({ repositoryId,
        normalizedPlanSha256: '7'.repeat(64), centralEffectiveConfigProjectionSha256: 'd'.repeat(64),
        preparedExecutionSha256: '8'.repeat(64), effectiveConfigSha256: 'e'.repeat(64),
        effectivePolicySha256: 'f'.repeat(64), preparedExecutionFile: `prepared-host/prepared-${repositoryId}-default.json` })),
    },
    runtime: { finalSourceRevision: 'f'.repeat(40), workerImageDigest: `sha256:${'1'.repeat(64)}`,
      runtimeManifestSha256: '2'.repeat(64), publicationAttestationSha256: '3'.repeat(64) },
  };
}

function routeIdentityFixture() {
  return { schemaVersion: runner.EXTERNAL_NORMAL_V2_ROUTE_IDENTITY_SCHEMA,
    routingRuleId: '11111111-1111-4111-8111-111111111111', routingRuleName: 'fixture-reviewer-route',
    provider: 'fixture-provider', model: 'fixture-model', sourceConfigurationSha256: 'b'.repeat(64) };
}

const fixtureBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function createCoordinatorHarness(repositoryRoot, { r2Cases, runtimeSourceRevision } = {}) {
  const { plan: frozenTemplate, bundle, planSha256 } = await runner.readFrozenExternalNormalV2Plan(repositoryRoot);
  const r2Targets = new Map((r2Cases ?? []).map((entry) => [entry.repository.repositoryId, entry]));
  const template = r2Targets.size === 0 ? frozenTemplate : {
    ...frozenTemplate,
    targetProjections: frozenTemplate.targetProjections.map((target) => {
      const source = r2Targets.get(target.repositoryId);
      return source ? { ...target, repository: `${source.repository.owner}/${source.repository.repo}`,
        prNumber: source.prNumber } : target;
    }),
  };
  const tempRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'ws5-v2-allocation-forwarding-')));
  const phaseRoot = path.join(tempRoot, 'phase-root');
  const policyInputRoot = path.join(tempRoot, 'policy-inputs');
  await mkdir(phaseRoot, { mode: 0o700 });
  await chmod(phaseRoot, 0o700);
  const phaseRootInfo = await lstat(phaseRoot);
  await mkdir(policyInputRoot, { mode: 0o700 });
  await chmod(policyInputRoot, 0o700);

  const transport = { selectedBaseUrl: 'https://gateway.example.invalid/v1', modelAlias: 'fixture-reviewer' };
  const routeIdentity = routeIdentityFixture();
  const sourceDescriptor = { repository: 'exampleorg/review-policy-fixture', repositoryId: 73,
    sourceRef: 'b'.repeat(40), path: 'policy/candidate.json', candidateHead: 'd'.repeat(40),
    preparedFixtureReviewHead: 'e'.repeat(40) };
  const helperSourceRevision = runtimeSourceRevision ?? template.runtime.preparedConfigHelperSourceRevision;
  const runtime = { finalSourceRevision: helperSourceRevision,
    workerImageDigest: `sha256:${'1'.repeat(64)}`, runtimeManifestSha256: '2'.repeat(64),
    publicationAttestationSha256: '3'.repeat(64) };
  const candidateBytes = fixtureBytes({ schema: 'exampleorg.review-policy.v1' });
  const candidateRawSha256 = runner.sha256(candidateBytes);
  sourceDescriptor.contentSha256 = candidateRawSha256;

  const normalizedPlan = { schema: 'ReviewPolicyExecutionPlan.v1', fixture: 'coordinator-allocation-forwarding' };
  const executionPlanNormalizedSha256 = runner.sha256(Buffer.from(runner.canonicalJson(normalizedPlan)));
  const executionBytes = fixtureBytes({ plan: normalizedPlan,
    normalized_plan_sha256: executionPlanNormalizedSha256 });

  const preparedExecution = { version: 'PreparedReviewExecution.v1', transport: {
    baseUrl: transport.selectedBaseUrl, model: transport.modelAlias }, config: { review_configuration_receipt: {
      effective: { composed_budget: { central_policy_max_tasks: 8, central_policy_total_turns: 100,
        provider_attempt_budget: { capability_version: 'ReviewProviderAttemptBudget.v1', total_limit: 100,
          investigation_limit: 88, verifier_reserve: 12, operator_override_value: null } },
      provider: { requested_effort: 'medium' } } } } };
  const preparedExecutionBytes = fixtureBytes(preparedExecution);
  const preparedExecutionSha256 = runner.sha256(preparedExecutionBytes);
  const centralEffectiveConfigProjectionSha256 = '4'.repeat(64);
  const effectiveConfigSha256 = '5'.repeat(64);
  const effectivePolicySha256 = '6'.repeat(64);
  const targetProjections = template.targetProjections.map((target) => ({ repositoryId: target.repositoryId,
    normalizedPlanSha256: runner.sha256(Buffer.from(`normalized:${target.repositoryId}`)),
    centralEffectiveConfigProjectionSha256, preparedExecutionSha256, effectiveConfigSha256,
    effectivePolicySha256, preparedExecutionFile: `prepared-host/prepared-${target.repositoryId}-default.json` }));

  const preparedFixture = { schema: 'exampleorg.review-yeti-prepared-execution-host-fixture.v1',
    preparation_only: true, review_posting_enabled: false,
    candidate_policy: { repository: sourceDescriptor.repository, repository_id: sourceDescriptor.repositoryId,
      source_sha: sourceDescriptor.sourceRef, path: sourceDescriptor.path, content_sha256: candidateRawSha256 },
    prepared_by: { repository: 'review-yeti-ai/review-yeti-bot',
      source_sha: helperSourceRevision, helper: 'preparePublishingPolicy',
      helper_path: 'src/review/preparedPublishingPolicy.ts',
      helper_source_file_sha256: template.runtime.preparedConfigHelperSourceFileSha256,
      helper_compiled_file_sha256: template.runtime.preparedConfigHelperCompiledFileSha256,
      worker_image_index_digest: runtime.workerImageDigest,
      worker_runtime_manifest_sha256: runtime.runtimeManifestSha256 },
    transport: { baseUrl: transport.selectedBaseUrl, model: transport.modelAlias },
    targets: template.targetProjections.map((target) => ({ id: target.repositoryId, repository: target.repository,
      scenarios: { default: { prepared_execution_file: `prepared-${target.repositoryId}-default.json`,
        prepared_execution_sha256: preparedExecutionSha256, effective_config_digest: effectiveConfigSha256,
        effective_policy_digest: effectivePolicySha256 } } })) };
  const preparedFixtureBytes = fixtureBytes(preparedFixture);
  const preparedExecutionFixtureSha256 = runner.sha256(preparedFixtureBytes);

  const providerAttemptBudget = { capability_version: 'ReviewProviderAttemptBudget.v1', total_limit: 100,
    investigation_limit: 88, verifier_reserve: 12, operator_override_value: null };
  const projections = { schema: 'exampleorg.review-yeti-offline-candidate-projections.v2',
    prepared_execution_fixture_path: 'review-yeti-v2-prepared-execution-host.fixture.json',
    prepared_execution_fixture_sha256: preparedExecutionFixtureSha256, source_revision: sourceDescriptor.sourceRef,
    review_posting_enabled: false, policy_sha256: candidateRawSha256,
    cases: template.targetProjections.map((target, index) => ({ id: target.repositoryId,
      repository: target.repository, pr_number: target.prNumber,
      central_projection: { normalized_plan_sha256: targetProjections[index].normalizedPlanSha256,
        plan: { effective_configuration: { effective: { provider: { model_alias: transport.modelAlias,
          requested_effort: 'medium' } } }, lane: { max_review_assignments: 24 } } },
      prepared_execution: { default: { prepared_execution_sha256: preparedExecutionSha256,
        effective_config_digest: effectiveConfigSha256, provider_attempt_budget: providerAttemptBudget } } })) };
  const projectionsBytes = fixtureBytes(projections);

  const manifestScenarios = r2Cases ? ['default'] : ['default', 'comparison'];
  const preparedManifest = { schema: 'exampleorg.review-yeti-prepared-execution-host-bundle.v1',
    fixture_path: 'review-yeti-v2-prepared-execution-host.fixture.json',
    fixture_sha256: preparedExecutionFixtureSha256,
    prepared_from: { repository: sourceDescriptor.repository, repository_id: sourceDescriptor.repositoryId,
      source_sha: sourceDescriptor.sourceRef, content_sha256: candidateRawSha256 },
    helper: { repository: 'review-yeti-ai/review-yeti-bot', helper: 'preparePublishingPolicy',
      helper_path: 'src/review/preparedPublishingPolicy.ts',
      source_sha: helperSourceRevision,
      source_file_sha256: template.runtime.preparedConfigHelperSourceFileSha256,
      compiled_file_sha256: template.runtime.preparedConfigHelperCompiledFileSha256 },
    transport: { provider: 'bifrost', baseUrl: transport.selectedBaseUrl, model: transport.modelAlias },
    samples: template.targetProjections.flatMap((target) => manifestScenarios.map((scenario) => ({
      id: target.repositoryId, scenario, path: `prepared-host/prepared-${target.repositoryId}-default.json`,
      prepared_execution_sha256: preparedExecutionSha256, effective_config_digest: effectiveConfigSha256,
      effective_policy_digest: effectivePolicySha256,
      provider_attempt_budget: { total_limit: 100, investigation_limit: 88, verifier_reserve: 12,
        operator_override_value: null } }))) };
  const preparedManifestBytes = fixtureBytes(preparedManifest);

  const inputFiles = [
    ['review-yeti-v2-candidate.json', candidateBytes],
    ['review-yeti-v2-candidate-execution-plan.fixture.json', executionBytes],
    ['review-yeti-v2-prepared-execution-host.fixture.json', preparedFixtureBytes],
    ['review-yeti-v2-synthetic-execution-plans-host.fixture.json', projectionsBytes],
    ['review-yeti-v2-prepared-execution-host.manifest.json', preparedManifestBytes],
  ];
  for (const [relativePath, bytes] of inputFiles) {
    const targetPath = path.join(policyInputRoot, relativePath);
    await writeFile(targetPath, bytes, { mode: 0o600 });
    await chmod(targetPath, 0o600);
  }
  for (const target of targetProjections) {
    const targetPath = path.join(policyInputRoot, target.preparedExecutionFile);
    await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    await writeFile(targetPath, preparedExecutionBytes, { mode: 0o600 });
    await chmod(targetPath, 0o600);
  }

  const policyInputDigests = {
    candidatePath: runner.sha256(candidateBytes), executionPlanFixturePath: runner.sha256(executionBytes),
    preparedExecutionFixturePath: runner.sha256(preparedFixtureBytes), syntheticProjectionPath: runner.sha256(projectionsBytes),
    preparedExecutionManifestPath: runner.sha256(preparedManifestBytes),
  };
  const binding = { schemaVersion: runner.EXTERNAL_NORMAL_V2_PRIVATE_BINDING_SCHEMA,
    credentialBindingSha256: 'a'.repeat(64),
    phaseRoot: { canonicalPath: phaseRoot, uid: phaseRootInfo.uid, gid: phaseRootInfo.gid,
      mode: phaseRootInfo.mode & 0o777, initialEntryCount: 0 },
    sourceDescriptor,
    transport,
    managementBaseUrl: 'https://management.example.invalid',
    policy: { candidateGitBlob: '7'.repeat(40), executionPlanFixtureSha256: runner.sha256(executionBytes),
      executionPlanNormalizedSha256, preparedExecutionFixtureSha256, preparedExecutionManifestSha256: runner.sha256(preparedManifestBytes),
      preparedExecutionSha256, syntheticProjectionFixtureSha256: runner.sha256(projectionsBytes),
      centralEffectiveConfigProjectionSha256, effectiveConfigSha256, effectivePolicySha256,
      v1Promotion: 'fixture-v1-promotion', policyInputDigests, targetProjections },
    runtime };
  assert.doesNotThrow(() => runner.validateExternalNormalV2PrivateBinding(binding));
  return { tempRoot, phaseRoot, policyInputRoot, binding, routeIdentity, template, bundle, planSha256 };
}

test('forwards the frozen arm allocation through the real coordinator executor context', async () => {
  const repositoryRoot = new URL('../../', import.meta.url).pathname;
  const harness = await createCoordinatorHarness(repositoryRoot);
  let observedProjection;
  let observedContext;
  const now = Date.now();
  try {
    const boundPlan = runner.bindExternalNormalV2PrivateInputs(harness.template, harness.binding, harness.routeIdentity);
    const canonicalRoot = await realpath(harness.phaseRoot);
    const rootInfo = await lstat(canonicalRoot);
    const outputRootSha256 = runner.sha256(canonicalRoot);
    const artifactStoreIdentitySha256 = runner.sha256(runner.canonicalJson({ pathSha256: outputRootSha256,
      uid: rootInfo.uid, gid: rootInfo.gid, mode: rootInfo.mode & 0o777 }));
    const launcherSource = await runner.readExternalNormalV2LauncherSourceDigests(repositoryRoot);
    const tuple = runner.buildExternalNormalV2AuthorizationTuple(boundPlan, harness.planSha256,
      outputRootSha256, launcherSource.tupleSha256, artifactStoreIdentitySha256, harness.binding, harness.routeIdentity);
    const authorization = { schemaVersion: runner.EXTERNAL_NORMAL_V2_ROOT_GO_SCHEMA, rootGo: true,
      grantId: randomUUID(), issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(), binding: tuple };

    const result = await runner.runExternalNormalQualificationV2({ repositoryRoot,
      policyInputRoot: harness.policyInputRoot, phaseRoot: harness.phaseRoot,
      privateBinding: harness.binding, routeIdentity: harness.routeIdentity, authorization, now: () => now,
      captureExactLogs: async () => ({ status: 'no_calls' }),
      preflightExecution: async ({ origin, sourceRevision, workerImageDigest, runtimeManifestSha256 }) => ({
        status: 'ready', mode: 'dns_tls_only', originSha256: runner.sha256(origin), sourceRevision,
        workerImageDigest, runtimeManifestSha256, resolvedAddressCount: 1,
        resolvedAddressSetSha256: '8'.repeat(64), tlsAuthorized: true, tlsProtocol: 'TLSv1.3',
        peerCertificateSha256: '9'.repeat(64), tlsAddressSha256: 'a'.repeat(64), elapsedMs: 1,
      }),
      executeCase: async (projection, context) => {
        observedProjection = projection;
        observedContext = context;
        const error = new Error('synthetic stop before child execution');
        error.clientAttemptsMayHaveBeenSent = false;
        error.preChildFailure = { stage: 'case_environment', code: 'required_binding_missing' };
        throw error;
      },
    });

    assert.ok(observedProjection, JSON.stringify(result));
    assert.equal(observedProjection.stepId, 'v2-p2-first');
    assert.equal(observedProjection.arm, 'p2-only');
    assert.equal(observedContext.clientCallAllocation, 58);
    assert.equal(result.status, 'failed');
    assert.equal(result.clientCalls, 0);
    assert.equal(result.phaseAttemptAllocation.declared, 292);
    assert.equal(result.phaseAttemptAllocation.spent, 0);
    assert.equal(result.phaseAttemptAllocation.unspendableReserve, 8);
    assert.equal(result.phaseAttemptAllocation.declared + result.phaseAttemptAllocation.unspendableReserve, 300);
    assert.equal(result.stepResults[0].clientCallAllocation, 58);
    assert.deepEqual(result.stepResults[0].preChildFailure,
      { stage: 'case_environment', code: 'required_binding_missing' });
    assert.equal(JSON.stringify(result).includes('synthetic stop before child execution'), false);
  } finally {
    await rm(harness.tempRoot, { recursive: true, force: true });
  }
});

test('binds the private identifier sidecar for a resolved failed worker without recounting known calls', async () => {
  const repositoryRoot = new URL('../../', import.meta.url).pathname;
  const harness = await createCoordinatorHarness(repositoryRoot);
  const requestIds = Array.from({ length: 25 }, () => randomUUID());
  const providerCalls = requestIds.map((requestId) => ({
    clientRequestIdSha256: createHash('sha256').update(requestId.toLowerCase()).digest('hex'),
    bifrostLogRequestIdSha256: createHash('sha256').update(requestId.toLowerCase()).digest('hex'),
    upstreamResponseRequestIdSha256: null,
    requestedAlias: 'fixture-reviewer', requestedEffort: 'medium', startedAt: new Date().toISOString(),
    requestDigest: createHash('sha256').update(`request:${requestId}`).digest('hex'),
    httpStatus: 200, fetchFailureClass: null, workerTokenUsage: { prompt: 1, completion: 1, total: 2 },
    workerEstimatedUsd: null,
  }));
  const sidecarRows = requestIds.map((requestId) => ({ callerRequestId: requestId,
    bifrostLogRequestId: requestId, upstreamResponseRequestId: null }));
  const sidecarBytes = Buffer.from(`${JSON.stringify(sidecarRows, null, 2)}\n`);
  const sidecarSha256 = runner.sha256(sidecarBytes);
  let sidecarPath;
  let captureRequest;
  let executorCalls = 0;
  const now = Date.now();
  try {
    const boundPlan = runner.bindExternalNormalV2PrivateInputs(harness.template, harness.binding, harness.routeIdentity);
    const canonicalRoot = await realpath(harness.phaseRoot);
    const rootInfo = await lstat(canonicalRoot);
    const outputRootSha256 = runner.sha256(canonicalRoot);
    const artifactStoreIdentitySha256 = runner.sha256(runner.canonicalJson({ pathSha256: outputRootSha256,
      uid: rootInfo.uid, gid: rootInfo.gid, mode: rootInfo.mode & 0o777 }));
    const launcherSource = await runner.readExternalNormalV2LauncherSourceDigests(repositoryRoot);
    const tuple = runner.buildExternalNormalV2AuthorizationTuple(boundPlan, harness.planSha256,
      outputRootSha256, launcherSource.tupleSha256, artifactStoreIdentitySha256, harness.binding, harness.routeIdentity);
    const authorization = { schemaVersion: runner.EXTERNAL_NORMAL_V2_ROOT_GO_SCHEMA, rootGo: true,
      grantId: randomUUID(), issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(), binding: tuple };

    const result = await runner.runExternalNormalQualificationV2({ repositoryRoot,
      policyInputRoot: harness.policyInputRoot, phaseRoot: harness.phaseRoot,
      privateBinding: harness.binding, routeIdentity: harness.routeIdentity, authorization, now: () => now,
      captureExactLogs: async (request) => {
        captureRequest = request;
        const unqueriedCidSha256 = request.calls.map((call) => call.clientRequestIdSha256).sort();
        return { status: 'unavailable', queriedCallCount: 0, matchedRows: 0,
          unqueriedCallCount: unqueriedCidSha256.length, queriedCidSha256: [], unqueriedCidSha256,
          unqueriedCidSetSha256: createHash('sha256').update(runner.canonicalJson(unqueriedCidSha256)).digest('hex'),
          rows: [], failureCode: 'synthetic_log_capture_unavailable' };
      },
      preflightExecution: async ({ origin, sourceRevision, workerImageDigest, runtimeManifestSha256 }) => ({
        status: 'ready', mode: 'dns_tls_only', originSha256: runner.sha256(origin), sourceRevision,
        workerImageDigest, runtimeManifestSha256, resolvedAddressCount: 1,
        resolvedAddressSetSha256: '8'.repeat(64), tlsAuthorized: true, tlsProtocol: 'TLSv1.3',
        peerCertificateSha256: '9'.repeat(64), tlsAddressSha256: 'a'.repeat(64), elapsedMs: 1,
      }),
      executeCase: async (projection, context) => {
        executorCalls += 1;
        assert.equal(projection.stepId, 'v2-p2-first');
        assert.equal(context.clientCallAllocation, 58);
        sidecarPath = `normal-engine-qualification-store/${projection.runId}/single/${projection.caseId}`
          + '/provider-identifiers.record/provider-identifiers.json';
        const absoluteSidecarPath = path.join(canonicalRoot, sidecarPath);
        await mkdir(path.dirname(absoluteSidecarPath), { recursive: true, mode: 0o700 });
        await writeFile(absoluteSidecarPath, sidecarBytes, { mode: 0o600 });
        await chmod(absoluteSidecarPath, 0o600);
        await writeFile(path.join(path.dirname(absoluteSidecarPath), 'provider-identifiers.sha256'),
          `${sidecarSha256}\n`, { mode: 0o600 });
        await chmod(path.join(path.dirname(absoluteSidecarPath), 'provider-identifiers.sha256'), 0o600);
        return { clientCalls: 25, blockedClientCalls: 0, terminalStatus: 'failed',
          receiptSha256: 'b'.repeat(64), failureCode: 'worker_execution_failed', artifactReferences: [],
          workerFailure: { stage: 'case_receipt_persistence', code: 'receipt_write_failed' },
          providerCalls, outcome: null, history: null, qualificationControl: null, preflight: null,
          resourceExhaustion: null, attestorRecordedCalls: 25 };
      },
    });

    assert.equal(executorCalls, 1, 'a failed first step must stop the remaining arms');
    assert.equal(result.status, 'failed');
    assert.equal(result.clientCalls, 25);
    assert.equal(result.unknownClientCallUpperBound, 0);
    assert.equal(result.phaseAttemptAllocation.spent, 25);
    assert.equal(result.phaseAttemptAllocation.possibleSpentUpperBound, 25);
    assert.equal(result.stepResults.length, 1);
    assert.equal(result.stepResults[0].terminalStatus, 'failed');
    assert.equal(result.stepResults[0].failureCode, 'worker_execution_failed');
    assert.deepEqual(result.stepResults[0].workerFailure,
      { stage: 'case_receipt_persistence', code: 'receipt_write_failed' });
    assert.equal(result.stepResults[0].assessment.status, 'incomplete');
    assert.equal(result.stepResults[0].outcome, null);
    assert.equal(result.stepResults[0].canonicalReviewEvidence, null);
    assert.ok(captureRequest, 'exact log capture must still be attempted for known provider calls');
    assert.equal(captureRequest.calls.length, 25);
    assert.deepEqual(captureRequest.stepReceipts[0].artifactReferences,
      [{ path: sidecarPath, sha256: sidecarSha256 }]);
    assert.deepEqual(result.stepResults[0].artifactReferences,
      [{ path: sidecarPath, sha256: sidecarSha256 }]);
    for (const requestId of requestIds) assert.equal(JSON.stringify(result).includes(requestId), false);
  } finally {
    await rm(harness.tempRoot, { recursive: true, force: true });
  }
});

test('does not invoke a worker without a root-go receipt bound to the exact phase', async () => {
  assert.ok(runner, 'the current-source external v2 runner module must exist');
  assert.equal(typeof runner.runExternalNormalQualificationV2, 'function');

  let workerInvocations = 0;
  const result = await runner.runExternalNormalQualificationV2({
    repositoryRoot: new URL('../../', import.meta.url).pathname,
    phaseRoot: '/tmp/not-created-without-rootgo',
    authorization: null,
    executeCase: async () => { workerInvocations += 1; return null; },
  });

  assert.equal(workerInvocations, 0);
  assert.equal(result.status, 'authorization_required');
  assert.equal(result.clientCalls, 0);
});

test('R2 parent entry validates the v3 cohort and rejects an invalid grant before callbacks', async () => {
  assert.ok(runner, 'the current-source external runner module must exist');
  assert.equal(typeof runner.runExternalNormalQualificationR2, 'function');
  assert.equal(typeof runner.validateExternalNormalR2CohortPlan, 'function');
  const repositoryRoot = new URL('../../', import.meta.url).pathname;
  const bundleRelative = 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v3';
  const sourceBundlePath = path.join(repositoryRoot, bundleRelative, 'source-bundle.json');
  const sourceBundle = JSON.parse(await readFile(sourceBundlePath, 'utf8'));
  const harness = await createCoordinatorHarness(repositoryRoot, { r2Cases: sourceBundle.cases,
    runtimeSourceRevision: R2_RUNTIME_SOURCE_REVISION });
  const executionPlanSha256 = runner.sha256(r2PlanBytes);
  assert.equal(executionPlanSha256, '37fcfc37440e249e97b892186c2a0683b31654a540e146232ec579012160c233');
  let callbacks = 0;
  try {
    const executionPlan = structuredClone(r2PlanTemplate);
    const admitted = runner.validateExternalNormalR2CohortPlan(executionPlan, sourceBundle,
      executionPlanSha256, r2PlanBytes);
    assert.equal(admitted.phaseId, 'ws5-current-source-external-v2-r2');
    assert.equal(admitted.runs.length, 9);
    assert.deepEqual(admitted.runs.map((step) => step.stepId), [
      'r2-s001', 'r2-s002', 'r2-s003', 'r2-s004', 'r2-s005', 'r2-s006', 'r2-s007', 'r2-s008', 'r2-s009',
    ]);
    assert.deepEqual([...new Set(admitted.runs.map((step) => step.caseId))].sort(), [
      'ws5-r2-c001', 'ws5-r2-c002', 'ws5-r2-c003', 'ws5-r2-c004',
    ]);
    assert.equal(admitted.executionEnvelope.maxPhaseClientCalls, 275);
    assert.deepEqual(admitted.runs.map((step) => step.clientCallAllocation), [53, 53, 53, 53, 53, 0, 0, 1, 1]);

    const prepared = await runner.prepareExternalNormalR2AuthorizationTuple({ repositoryRoot,
      executionPlan, executionPlanSha256, executionPlanBytes: r2PlanBytes,
      sourceBundle, policyInputRoot: harness.policyInputRoot, phaseRoot: harness.phaseRoot,
      privateBinding: harness.binding, routeIdentity: harness.routeIdentity });
    assert.equal(prepared.phaseId, 'ws5-current-source-external-v2-r2');
    assert.equal(prepared.phasePlanSha256, '37fcfc37440e249e97b892186c2a0683b31654a540e146232ec579012160c233');
    assert.equal(prepared.sourceBundleSha256, 'd83b08f04890604fd1bfe98105e6db7ad70945afb1e5471218ca62d2204cc3bc');
    assert.equal(prepared.authorizationTuple.phaseId, prepared.phaseId);
    assert.equal(prepared.authorizationTuple.phasePlanSha256, prepared.phasePlanSha256);
    assert.equal(prepared.authorizationTuple.sourceBundleSha256, prepared.sourceBundleSha256);
    assert.equal(prepared.authorizationTuple.inputManifestSha256,
      'fa792e36e552e025b9756a3d7ab58bc02db31f5d51b52156ec76d9be1500649f');
    assert.equal(prepared.authorizationTuple.privateBindingSha256, runner.sha256(runner.canonicalJson(harness.binding)));
    const preparedFixture = JSON.parse(await readFile(path.join(harness.policyInputRoot,
      'review-yeti-v2-prepared-execution-host.fixture.json'), 'utf8'));
    const preparedManifest = JSON.parse(await readFile(path.join(harness.policyInputRoot,
      'review-yeti-v2-prepared-execution-host.manifest.json'), 'utf8'));
    assert.equal(preparedFixture.prepared_by.source_sha, R2_RUNTIME_SOURCE_REVISION);
    assert.equal(preparedManifest.helper.source_sha, R2_RUNTIME_SOURCE_REVISION);
    assert.equal(preparedManifest.helper.source_file_sha256, R2_HELPER_SOURCE_SHA256);
    assert.equal(preparedManifest.helper.compiled_file_sha256, R2_HELPER_COMPILED_SHA256);
    assert.equal(preparedManifest.samples.length, 3);
    assert.ok(preparedManifest.samples.every((sample) => sample.scenario === 'default'));
    const manifestPath = path.join(harness.policyInputRoot,
      'review-yeti-v2-prepared-execution-host.manifest.json');
    const invalidManifestBytes = fixtureBytes({ ...preparedManifest,
      samples: [...preparedManifest.samples, { ...preparedManifest.samples[0], scenario: 'comparison' }] });
    await writeFile(manifestPath, invalidManifestBytes, { mode: 0o600 });
    await chmod(manifestPath, 0o600);
    const invalidBinding = structuredClone(harness.binding);
    const invalidManifestSha256 = runner.sha256(invalidManifestBytes);
    invalidBinding.policy.preparedExecutionManifestSha256 = invalidManifestSha256;
    invalidBinding.policy.policyInputDigests.preparedExecutionManifestPath = invalidManifestSha256;
    await assert.rejects(() => runner.prepareExternalNormalR2AuthorizationTuple({ repositoryRoot,
      executionPlan, executionPlanSha256, executionPlanBytes: r2PlanBytes, sourceBundle,
      policyInputRoot: harness.policyInputRoot, phaseRoot: harness.phaseRoot,
      privateBinding: invalidBinding, routeIdentity: harness.routeIdentity }),
    /external_normal_v2_policy_input_contract_invalid/u);
    await writeFile(manifestPath, fixtureBytes(preparedManifest), { mode: 0o600 });
    await chmod(manifestPath, 0o600);
    const now = Date.now();
    const rootGo = { schemaVersion: runner.EXTERNAL_NORMAL_R2_ROOT_GO_SCHEMA, rootGo: true,
      grantId: randomUUID(), issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(), binding: prepared.authorizationTuple };
    const grantValidation = await runner.validatePreparedExternalNormalR2Grant({ repositoryRoot,
      executionPlan, executionPlanSha256: prepared.phasePlanSha256, executionPlanBytes: r2PlanBytes, sourceBundle,
      policyInputRoot: harness.policyInputRoot, phaseRoot: harness.phaseRoot,
      privateBinding: harness.binding, routeIdentity: harness.routeIdentity }, rootGo, now);
    assert.equal(grantValidation.status, 'authorized');
    assert.deepEqual(grantValidation.authorizationTuple, prepared.authorizationTuple);
    const wrongGrant = { ...rootGo, binding: { ...prepared.authorizationTuple, sourceBundleSha256: '0'.repeat(64) } };
    assert.equal((await runner.validatePreparedExternalNormalR2Grant({ repositoryRoot,
      executionPlan, executionPlanSha256: prepared.phasePlanSha256, executionPlanBytes: r2PlanBytes, sourceBundle,
      policyInputRoot: harness.policyInputRoot, phaseRoot: harness.phaseRoot,
      privateBinding: harness.binding, routeIdentity: harness.routeIdentity }, wrongGrant, now)).status,
    'authorization_rejected');
    assert.deepEqual(await readdir(harness.phaseRoot), []);

    const result = await runner.runExternalNormalQualificationR2({
      repositoryRoot,
      executionPlan,
      executionPlanSha256,
      executionPlanBytes: r2PlanBytes,
      sourceBundle,
      policyInputRoot: harness.policyInputRoot,
      phaseRoot: harness.phaseRoot,
      privateBinding: harness.binding,
      routeIdentity: harness.routeIdentity,
      authorization: { schemaVersion: runner.EXTERNAL_NORMAL_R2_ROOT_GO_SCHEMA, rootGo: false,
        grantId: randomUUID(), issuedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(), binding: {} },
      executeCase: async () => { callbacks += 1; return null; },
      captureExactLogs: async () => { callbacks += 1; return { status: 'no_calls' }; },
      preflightExecution: async () => { callbacks += 1; return { status: 'ready' }; },
    });
    assert.equal(result.status, 'authorization_rejected');
    assert.equal(result.phaseId, 'ws5-current-source-external-v2-r2');
    assert.equal(result.planSha256, '37fcfc37440e249e97b892186c2a0683b31654a540e146232ec579012160c233');
    assert.equal(result.clientCalls, 0);
    assert.equal(callbacks, 0);
    assert.deepEqual(await readdir(harness.phaseRoot), []);
  } finally {
    await rm(harness.tempRoot, { recursive: true, force: true });
  }
});

test('R2 runner joins a failed loaded-worker sidecar through the exact R2 collector binding', async () => {
  const repositoryRoot = new URL('../../', import.meta.url).pathname;
  const bundleRelative = 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v3';
  const sourceBundle = JSON.parse(await readFile(path.join(repositoryRoot, bundleRelative, 'source-bundle.json'), 'utf8'));
  const harness = await createCoordinatorHarness(repositoryRoot, { r2Cases: sourceBundle.cases,
    runtimeSourceRevision: R2_RUNTIME_SOURCE_REVISION });
  const syntheticRows = Array.from({ length: 25 }, () => ({ callerRequestId: randomUUID(),
    bifrostLogRequestId: null, upstreamResponseRequestId: null }));
  for (const row of syntheticRows) row.bifrostLogRequestId = row.callerRequestId;
  const digest = (value) => runner.sha256(value);
  const source = harness.binding.sourceDescriptor;
  const [sourceOwner, sourceRepo] = source.repository.split('/');
  const baseEnv = {
    NODE_ENV: 'test', OPENAI_BASE_URL: harness.binding.transport.selectedBaseUrl,
    REVIEW_MODEL: harness.binding.transport.modelAlias,
    REVIEW_CONFIG_DIGEST: harness.binding.policy.effectiveConfigSha256,
    REVIEW_POLICY_DIGEST: harness.binding.policy.effectivePolicySha256,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_TARGET: source.repository,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPOSITORY_ID: String(source.repositoryId),
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_OWNER: sourceOwner,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPO: sourceRepo,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REF: source.sourceRef,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_PATH: source.path,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_SHA256: source.contentSha256,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_SOURCE_REVISION: harness.binding.runtime.finalSourceRevision,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_WORKER_IMAGE_DIGEST: harness.binding.runtime.workerImageDigest,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256: harness.binding.runtime.runtimeManifestSha256,
    REVIEW_PREPARED_CONFIG_JSON: await readFile(path.join(harness.policyInputRoot,
      'prepared-host/prepared-73004-default.json'), 'utf8'),
  };
  const caseMounts = [];
  let forwardedChildAllocation;
  let childEnvHasInferenceKey = false;
  let argsContainSyntheticCredential = false;
  const spawnImplementation = (command, args, options) => {
    assert.equal(command, 'docker');
    const caseMount = args.find((value) => value.startsWith('type=bind,source=') && value.endsWith(',target=/phase'));
    assert.ok(caseMount, 'R2 child must mount the isolated phase store at /phase');
    const sourcePath = caseMount.slice('type=bind,source='.length, caseMount.lastIndexOf(',target=/phase'));
    caseMounts.push(sourcePath);
    childEnvHasInferenceKey = options?.env?.OPENAI_API_KEY !== undefined;
    argsContainSyntheticCredential = args.includes('offline-synthetic-inference-key');

    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.pid = 4519;
    child.kill = () => true;
    const stdinChunks = [];
    child.stdin.on('data', (chunk) => stdinChunks.push(Buffer.from(chunk)));
    child.stdin.on('finish', () => {
      void (async () => {
        const stdin = Buffer.concat(stdinChunks);
        for (const chunk of stdinChunks) chunk.fill(0);
        let request;
        try { request = JSON.parse(stdin.toString('utf8')); }
        finally { stdin.fill(0); }
        const parsedImageRequest = loadedHostAdapter.parseExternalNormalV2ImageCaseRequest(request);
        forwardedChildAllocation = parsedImageRequest.clientCallAllocation;
        assert.equal(request.projection.stepId, 'r2-s001');
        assert.equal(request.projection.caseId, 'ws5-r2-c001');
        assert.equal(request.projection.arm, 'p2-only');
        const runId = request.projection.runId;
        const caseId = request.projection.caseId;
        const artifactDirectory = path.join(sourcePath, runId, 'single', caseId, 'provider-identifiers.record');
        await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
        const sidecarBody = `${JSON.stringify(syntheticRows, null, 2)}\n`;
        const sidecarDigest = digest(sidecarBody);
        await writeFile(path.join(artifactDirectory, 'provider-identifiers.json'), sidecarBody, { mode: 0o600 });
        await chmod(path.join(artifactDirectory, 'provider-identifiers.json'), 0o600);
        await writeFile(path.join(artifactDirectory, 'provider-identifiers.sha256'), `${sidecarDigest}\n`, { mode: 0o600 });
        await chmod(path.join(artifactDirectory, 'provider-identifiers.sha256'), 0o600);
        const providerCalls = syntheticRows.map((row, index) => ({
          clientRequestIdSha256: digest(row.callerRequestId.toLowerCase()),
          bifrostLogRequestIdSha256: digest(row.bifrostLogRequestId.toLowerCase()),
          upstreamResponseRequestIdSha256: null,
          requestedAlias: harness.binding.transport.modelAlias, requestedEffort: 'medium',
          startedAt: new Date(1_800_000_000_000 + index).toISOString(),
          requestDigest: digest(`r2-offline-request-${index}`), httpStatus: 200, fetchFailureClass: null,
          workerTokenUsage: null, workerEstimatedUsd: null,
        }));
        const receipt = {
          clientCalls: 25, blockedClientCalls: 0, terminalStatus: 'failed',
          receiptSha256: digest('r2-synthetic-worker-failure-after-25-calls'),
          failureCode: 'worker_execution_failed', artifactReferences: [],
          outcome: null, canonicalReviewEvidence: null, history: null, qualificationControl: null,
          preflight: null, resourceExhaustion: null, attestorRecordedCalls: 25, providerCalls,
        };
        child.stdout.write(`__EXTERNAL_NORMAL_V2_RESULT__${JSON.stringify(receipt)}\n`);
        child.stdout.end();
        child.emit('close', 0);
      })().catch((error) => { child.stdout.end(); child.emit('error', error); });
    });
    return child;
  };

  let managementAuthReads = 0;
  let logFetchCalls = 0;
  const adapter = loadedHostAdapter.createPinnedWorkerImageExternalNormalV2Adapter({
    policyInputRoot: harness.policyInputRoot,
    baseEnv,
    privateBinding: harness.binding,
    readInferenceKeyInMemory: () => 'offline-synthetic-inference-key',
    assertImageAvailable: () => {},
    spawnImplementation,
  });
  const collector = createExternalNormalV2ExactLogCollector({
    managementBaseUrl: harness.binding.managementBaseUrl,
    storeRoot: harness.phaseRoot,
    readManagementAuthInMemory: () => { managementAuthReads += 1;
      return { username: 'offline-user', password: 'offline-password' }; },
    fetchImpl: async (input) => {
      logFetchCalls += 1;
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('limit'), '1');
      const callerRequestId = url.searchParams.get('request_id');
      assert.ok(syntheticRows.some((row) => row.callerRequestId === callerRequestId));
      return new Response(JSON.stringify({ data: [{ id: callerRequestId,
        routing_rule_id: harness.routeIdentity.routingRuleId,
        routing_rule_name: harness.routeIdentity.routingRuleName,
        provider: harness.routeIdentity.provider,
        alias: null,
        model: harness.routeIdentity.model,
        status: 'success', fallback_index: 0, parent_request_id: null, number_of_retries: 0,
        server_side_fallback_model: null }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  try {
    const prepared = await runner.prepareExternalNormalR2AuthorizationTuple({ repositoryRoot,
      executionPlan: r2PlanTemplate, executionPlanSha256: runner.sha256(r2PlanBytes), executionPlanBytes: r2PlanBytes,
      sourceBundle, policyInputRoot: harness.policyInputRoot, phaseRoot: harness.phaseRoot,
      privateBinding: harness.binding, routeIdentity: harness.routeIdentity });
    const now = Date.now();
    const authorization = { schemaVersion: runner.EXTERNAL_NORMAL_R2_ROOT_GO_SCHEMA, rootGo: true,
      grantId: randomUUID(), issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(), binding: prepared.authorizationTuple };
    const result = await runner.runExternalNormalQualificationR2({
      repositoryRoot, executionPlan: r2PlanTemplate, executionPlanSha256: prepared.phasePlanSha256,
      executionPlanBytes: r2PlanBytes, sourceBundle,
      policyInputRoot: harness.policyInputRoot, phaseRoot: harness.phaseRoot,
      privateBinding: harness.binding, routeIdentity: harness.routeIdentity, authorization,
      now: () => now, executeCase: adapter.executeCase, captureExactLogs: collector,
      preflightExecution: async ({ origin, sourceRevision, workerImageDigest, runtimeManifestSha256 }) => ({
        status: 'ready', mode: 'dns_tls_only', originSha256: runner.sha256(origin), sourceRevision,
        workerImageDigest, runtimeManifestSha256, resolvedAddressCount: 1,
        resolvedAddressSetSha256: '8'.repeat(64), tlsAuthorized: true, tlsProtocol: 'TLSv1.3',
        peerCertificateSha256: '9'.repeat(64), tlsAddressSha256: 'a'.repeat(64), elapsedMs: 1,
      }),
    });
    assert.deepEqual(caseMounts, [path.join(harness.phaseRoot, 'normal-engine-qualification-store')]);
    assert.equal(result.status, 'failed', 'a worker failure remains failed after exact R2 capture');
    assert.equal(result.phaseId, 'ws5-current-source-external-v2-r2');
    assert.equal(result.clientCalls, 25);
    assert.equal(forwardedChildAllocation, 53,
      'the coordinator allocation must reach and pass the loaded child parser unchanged');
    assert.equal(result.unknownClientCallUpperBound, 0);
    assert.equal(result.phaseAttemptAllocation.spent, 25);
    assert.equal(result.phaseAttemptAllocation.declared, 267);
    assert.equal(result.overallPhysicalAttempts, 200);
    assert.equal(result.stepResults.length, 1, 'later R2 arms must stop after the worker failure');
    assert.equal(result.stepResults[0].stepId, 'r2-s001');
    assert.equal(result.stepResults[0].clientCallAllocation, 53);
    assert.equal(result.stepResults[0].terminalStatus, 'failed');
    assert.equal(result.exactLogCapture.status, 'captured');
    assert.equal(result.exactLogCapture.queriedCallCount, 25);
    assert.equal(result.exactLogCapture.matchedRows, 25);
    assert.equal(result.exactLogCapture.unqueriedCallCount, 0);
    assert.equal(result.logLedger.matchedRows, 25);
    assert.equal(result.routeIdentityProofs[0].status, 'observed');
    assert.equal(managementAuthReads, 1);
    assert.equal(logFetchCalls, 25);
    assert.equal(childEnvHasInferenceKey, false);
    assert.equal(argsContainSyntheticCredential, false);
    assert.equal(JSON.stringify(result).includes(syntheticRows[0].callerRequestId), false);
  } finally { await rm(harness.tempRoot, { recursive: true, force: true }); }
});

test('R2 cohort admission rejects altered case IDs, input hashes, and call caps', async () => {
  assert.ok(runner, 'the current-source external runner module must exist');
  assert.equal(typeof runner.validateExternalNormalR2CohortPlan, 'function');
  const repositoryRoot = new URL('../../', import.meta.url).pathname;
  const sourceBundle = JSON.parse(await readFile(path.join(repositoryRoot,
    'eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/source-bundle.json'), 'utf8'));
  const plan = structuredClone(r2PlanTemplate);
  const descriptorSha256 = runner.sha256(r2PlanBytes);
  const changedCase = structuredClone(plan);
  changedCase.steps[0].caseId = 'ws5-r2-c002';
  assert.throws(() => runner.validateExternalNormalR2CohortPlan(changedCase, sourceBundle, descriptorSha256, r2PlanBytes));
  const changedInputHash = structuredClone(plan);
  changedInputHash.steps[0].inputSha256 = '0'.repeat(64);
  assert.throws(() => runner.validateExternalNormalR2CohortPlan(changedInputHash, sourceBundle, descriptorSha256, r2PlanBytes));
  const changedCap = structuredClone(plan);
  changedCap.steps[0].clientCallCap = 54;
  assert.throws(() => runner.validateExternalNormalR2CohortPlan(changedCap, sourceBundle, descriptorSha256, r2PlanBytes));
  assert.throws(() => runner.validateExternalNormalR2CohortPlan(plan, sourceBundle, '0'.repeat(64), r2PlanBytes));
});

test('public phase plan is a non-dispatchable template and requires a private root binding', async () => {
  const root = new URL('../../', import.meta.url).pathname;
  const plan = JSON.parse(await readFile(path.join(root, 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/phase-plan.json')));
  const bundle = JSON.parse(await readFile(path.join(root, 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/source-bundle.json')));
  assert.equal(plan.status, 'template-awaiting-private-root-binding');
  assert.equal(plan.dispatchAuthorization, false);
  assert.equal(plan.runtime.publicationAttestationSha256, null);
  assert.equal(Object.hasOwn(plan.policy, 'policySource'), false);
  assert.equal(Object.hasOwn(plan.policy, 'inferenceBaseUrl'), false);
  assert.equal(plan.policy.routeAlias, null);
  assert.equal(plan.policy.candidateRawSha256, null);
  assert.equal(plan.policy.effectiveConfigSha256, null);
  assert.equal(plan.policy.effectivePolicySha256, null);
  assert.equal(plan.targetProjections.every((row) => row.preparedExecutionSha256 === null
    && row.effectiveConfigSha256 === null && row.effectivePolicySha256 === null
    && row.preparedExecutionFile === null), true);
  assert.equal(Object.hasOwn(plan.artifactRoots.phaseRoot, 'canonicalPath'), false);
  assert.equal(Object.hasOwn(plan.artifactRoots.phaseRoot, 'uid'), false);
  assert.equal(Object.hasOwn(plan.artifactRoots.phaseRoot, 'gid'), false);
  assert.doesNotThrow(() => runner.validateExternalNormalV2PrivateBinding(privateBinding()));
  assert.throws(() => runner.validateExternalNormalV2PrivateBinding({}), /private_binding_invalid/u);

  const result = await runner.runExternalNormalQualificationV2({
    repositoryRoot: root,
    phaseRoot: '/tmp/not-created-without-private-binding',
    authorization: { schemaVersion: runner.EXTERNAL_NORMAL_V2_ROOT_GO_SCHEMA, rootGo: true },
    executeCase: async () => { throw new Error('must not dispatch'); },
    captureExactLogs: async () => ({ ok: true }),
    preflightExecution: async () => ({ status: 'ready' }),
  });
  assert.equal(result.status, 'private_binding_required');
  runner.validateExternalNormalV2Plan(plan, bundle);
});

test('allows the container runtime check within a 60-second preflight bounded by existing overhead', async () => {
  const repositoryRoot = new URL('../../', import.meta.url).pathname;
  const { plan } = await runner.readFrozenExternalNormalV2Plan(repositoryRoot);
  assert.equal(plan.executionEnvelope.transportPreflightDeadlineMs, 60_000);
  assert.equal(plan.executionEnvelope.phaseWallLimitMs, 1_800_000);
  assert.ok(plan.executionEnvelope.transportPreflightDeadlineMs <= 180_000);
  assert.equal(runner.externalNormalV2TransportPreflightDeadlineAt(plan, 10_000), 70_000);
  assert.throws(() => runner.externalNormalV2TransportPreflightDeadlineAt({
    executionEnvelope: { transportPreflightDeadlineMs: 60_001 },
  }, 10_000), /preflight_deadline_invalid/u);
});

test('pins prepared helper provenance to the exact source revision and bytes admitted by the host plan', async () => {
  const repositoryRoot = new URL('../../', import.meta.url).pathname;
  const { plan } = await runner.readFrozenExternalNormalV2Plan(repositoryRoot);
  const helperBytes = await readFile(path.join(repositoryRoot, 'src/review/preparedPublishingPolicy.ts'));
  const helperSha256 = createHash('sha256').update(helperBytes).digest('hex');

  assert.equal(plan.runtime.preparedConfigHelperSourceRevision, 'a755abe90455b2b729c3f2eeaa5367481a90f7f3');
  assert.equal(plan.runtime.preparedConfigHelperSourceFileSha256, helperSha256);
  assert.equal(plan.runtime.preparedConfigHelperCompiledFileSha256,
    '972c1687e4d24f30352fbe464e4f420461aa2a48dbfab69636b24de9f1fd621d');
  const boundPlan = { ...plan, runtime: { ...plan.runtime,
    finalSourceRevision: plan.runtime.preparedConfigHelperSourceRevision } };
  const preparedManifest = { helper: {
    repository: 'review-yeti-ai/review-yeti-bot',
    helper: 'preparePublishingPolicy',
    helper_path: 'src/review/preparedPublishingPolicy.ts',
    source_sha: plan.runtime.preparedConfigHelperSourceRevision,
    source_file_sha256: plan.runtime.preparedConfigHelperSourceFileSha256,
    compiled_file_sha256: plan.runtime.preparedConfigHelperCompiledFileSha256,
  } };
  assert.equal(runner.preparedConfigHelperProvenanceMatchesPlan(preparedManifest, boundPlan), true);
  assert.equal(runner.preparedConfigHelperProvenanceMatchesPlan({ helper: {
    ...preparedManifest.helper, source_sha: '1917204826d9a145dc7db8217b01978dad679e2b',
  } }, boundPlan), false);
  assert.equal(runner.preparedConfigHelperProvenanceMatchesPlan({ helper: {
    ...preparedManifest.helper, source_file_sha256: '54f90267c4e97ae5ec50d77e7241151e0d81f156305ad031326cea1c34535bb0',
  } }, boundPlan), false);
  assert.equal(runner.preparedConfigHelperProvenanceMatchesPlan({ helper: {
    ...preparedManifest.helper, compiled_file_sha256: '0'.repeat(64),
  } }, boundPlan), false);
  assert.equal(runner.preparedConfigHelperProvenanceMatchesPlan({ helper: {
    ...preparedManifest.helper, source_file_sha256: '0'.repeat(64),
  } }, boundPlan), false);
  assert.equal(runner.preparedConfigHelperProvenanceMatchesPlan(preparedManifest, { ...boundPlan,
    runtime: { ...boundPlan.runtime, finalSourceRevision: 'b'.repeat(40) } }), false);

  const r2BoundPlan = { ...plan, runtime: { ...plan.runtime,
    finalSourceRevision: R2_RUNTIME_SOURCE_REVISION,
    preparedConfigHelperSourceRevision: R2_RUNTIME_SOURCE_REVISION } };
  const r2PreparedManifest = { helper: { ...preparedManifest.helper,
    source_sha: R2_RUNTIME_SOURCE_REVISION } };
  assert.equal(runner.preparedConfigHelperProvenanceMatchesPlan(r2PreparedManifest, r2BoundPlan), true);
  assert.equal(runner.preparedConfigHelperProvenanceMatchesPlan({ helper: {
    ...r2PreparedManifest.helper, source_file_sha256: '54f90267c4e97ae5ec50d77e7241151e0d81f156305ad031326cea1c34535bb0',
  } }, r2BoundPlan), false);
  assert.equal(runner.preparedConfigHelperProvenanceMatchesPlan({ helper: {
    ...r2PreparedManifest.helper, compiled_file_sha256: '0'.repeat(64),
  } }, r2BoundPlan), false);
  assert.equal(runner.preparedConfigHelperProvenanceMatchesPlan({ helper: {
    ...r2PreparedManifest.helper, source_sha: 'a755abe90455b2b729c3f2eeaa5367481a90f7f3',
  } }, r2BoundPlan), false);
  assert.equal(runner.preparedConfigHelperProvenanceMatchesPlan({ helper: {
    ...r2PreparedManifest.helper, source_file_sha256: '0'.repeat(64),
  } }, r2BoundPlan), false);
});

test('ships only the exact pinned v2 and v3 source inputs into the worker image', async () => {
  const root = new URL('../../', import.meta.url).pathname;
  const rows = await verifyQualificationFixtureAllowlist(root);
  const workerRows = await verifyQualificationFixtureAllowlist(root,
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/phase-plan.json']);
  const expected = new Map([
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/phase-plan.json',
      '2cf0c2455969df0e1a6cdfa4b97ba4c400cad7e1a2da6f52ebb2bd07e159ffc9'],
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/source-bundle.json',
      '99b707383ec16eea3ef81994c623e956f551a1e9d0b6acf2dd503afc5d41cfe1'],
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/p2.json',
      '4f476e36aa78b6788bb37c02ba5b2fae899c99eeba7d43dae399507cd93ed216'],
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/seq_a.json',
      '0e3bade3d6d7a148a2a36515ed1b40b9c1ab3f4cc2b2d92343176f2069ca0da9'],
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/seq_b.json',
      '52cdd6d19fc5dd042412a85df5b4effe8c9793c43cea3104ab5b35d036b1d1aa'],
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/coverage_hole.json',
      '6cf9a5f6c493f1db2f91f8abc907e9d4f9f9ad1d3c62296298326cb18f78897c'],
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/provider_failure.json',
      '76278ffbbb439e4e4d7b77dabe6022c01cf2c33d61753127cc82c542a9d1e2bd'],
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/resource_exhaustion.json',
      '015efdfc7c5253cb52e4ec99f22bfc354ea51ae54667f161993a98b1566cd1bc'],
  ]);
  const v3Inputs = new Map([
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/source-bundle.json',
      'd83b08f04890604fd1bfe98105e6db7ad70945afb1e5471218ca62d2204cc3bc'],
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/inputs/input-001.json',
      '54bb996bbd1caee73b313bc25676253469bdc9f40496ed937a0cfad32c29b162'],
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/inputs/input-002.json',
      'f1b5a2f7b838cacd039972da5de7cb066ca838882e31e840190850591ae5c37f'],
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/inputs/input-003.json',
      '6fcfa7a254eb960ae3a2ef79358e06205e6812c748e353679ead1578b11a1e84'],
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/inputs/input-004.json',
      'e3cfadf9e9937c66d4c8fdfd90d97668fc691a185bba6960cb8379b276b9cb97'],
  ]);
  const actual = new Map(rows.map((row) => [row.path, row.actualSha256]));
  const staged = new Map(workerRows.map((row) => [row.path, row.actualSha256]));
  for (const [path, digest] of expected) assert.equal(actual.get(path), digest, path);
  for (const [path, digest] of v3Inputs) {
    assert.equal(actual.get(path), digest, path);
    assert.equal(staged.get(path), digest, `staged ${path}`);
  }
  assert.equal(rows.length, 22, 'the host validates the complete pinned fixture set');
  assert.equal(workerRows.length, 21, 'the image stages every pinned source input except the host-only phase plan');
  assert.equal(workerRows.some((row) => row.path.endsWith('/phase-plan.json')), false);
});

test('rejects an expected-label marker and keeps worker projections outcome-blind', async () => {
  const root = new URL('../../', import.meta.url).pathname;
  const plan = JSON.parse(await readFile(path.join(root, 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/phase-plan.json')));
  const bundle = JSON.parse(await readFile(path.join(root, 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/source-bundle.json')));
  const first = plan.runs[0];
  assert.throws(() => runner.validateExternalNormalV2Plan({ ...plan, runs: [{ ...first, expected: 'SHIP' }, ...plan.runs.slice(1)] }, bundle),
    /outcome_label_forbidden/u);

  const safeStep = { ...first, expected: 'must never enter worker request' };
  const sourceCase = bundle.cases.find((entry) => entry.caseId === first.caseId);
  const projected = runner.projectExternalNormalV2Case(safeStep,
    { path: sourceCase.inputPath, sha256: sourceCase.inputSha256, repositoryId: sourceCase.repository.repositoryId, arm: 'p2-only' },
    { ...plan, runtime: { finalSourceRevision: 'a'.repeat(40), workerImageDigest: `sha256:${'b'.repeat(64)}`,
      runtimeManifestSha256: 'c'.repeat(64) } }, `nq_${'d'.repeat(32)}`);
  assert.equal(Object.hasOwn(projected, 'expected'), false);
  assert.equal(JSON.stringify(projected).includes('must never enter worker request'), false);
});

test('binds a private server-route expectation separately from the requested model alias', async () => {
  const binding = privateBinding();
  const routeIdentity = routeIdentityFixture();
  assert.doesNotThrow(() => runner.validateExternalNormalV2RouteIdentity(routeIdentity));
  const repositoryRoot = new URL('../../', import.meta.url).pathname;
  const { plan: template } = await runner.readFrozenExternalNormalV2Plan(repositoryRoot);
  const plan = runner.bindExternalNormalV2PrivateInputs(template, binding, routeIdentity);
  assert.equal(plan.policy.routeAlias, binding.transport.modelAlias);
  assert.deepEqual(plan.policy.routeIdentity, routeIdentity);
  assert.doesNotThrow(() => runner.assertExternalNormalV2PlanMatchesPrivateBinding(plan, binding, routeIdentity));
  const changedRouteIdentity = { ...routeIdentity, sourceConfigurationSha256: 'c'.repeat(64) };
  assert.throws(() => runner.assertExternalNormalV2PlanMatchesPrivateBinding(plan, binding, changedRouteIdentity),
    /private_binding_plan_mismatch/u);
  assert.throws(() => runner.validateExternalNormalV2RouteIdentity({ ...routeIdentity,
    sourceConfigurationSha256: 'not-a-digest' }), /route_identity_binding_invalid/u);
  for (const invalid of [
    { ...routeIdentity, routingRuleId: 'not-a-uuid' },
    { ...routeIdentity, routingRuleName: '' },
    { ...routeIdentity, provider: '' },
    { ...routeIdentity, model: '' },
    { ...routeIdentity, sourceConfigurationSha256: 'd'.repeat(63) },
  ]) {
    assert.throws(() => runner.validateExternalNormalV2RouteIdentity(invalid), /route_identity_binding_invalid/u);
  }
});

test('uses the five-by-58 review allocations plus one-call fault controls and keeps eight attempts unspendable', async () => {
  const root = new URL('../../', import.meta.url).pathname;
  const plan = JSON.parse(await readFile(path.join(root, 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/phase-plan.json')));
  const bundle = JSON.parse(await readFile(path.join(root, 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/source-bundle.json')));
  runner.validateExternalNormalV2Plan(plan, bundle);
  assert.throws(() => runner.validateExternalNormalV2Plan({ ...plan, artifactRoots: {
    ...plan.artifactRoots, phaseRoot: { ...plan.artifactRoots.phaseRoot, canonicalPath: `${plan.artifactRoots.phaseRoot.canonicalPath}-replay` },
  } }, bundle), /plan_contract_invalid/u);
  const allocations = plan.runs.map((step) => runner.clientCallAllocationForStep(step));
  assert.deepEqual(allocations, [58, 58, 58, 58, 58, 0, 0, 1, 1]);
  assert.equal(allocations.reduce((sum, value) => sum + value, 0), 292);
  assert.equal(plan.executionEnvelope.perArmClientHttpAttemptAllocation.unspendableSharedReserve, 8);
});

test('ROOTGO binds phase, exact plan, output root, runtime and policy tuple and rejects stale or replayed grants', async () => {
  const binding = privateBinding();
  const routeIdentity = routeIdentityFixture();
  const repositoryRoot = new URL('../../', import.meta.url).pathname;
  const template = JSON.parse(await readFile(path.join(repositoryRoot, 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/phase-plan.json')));
  const plan = runner.bindExternalNormalV2PrivateInputs(template, binding, routeIdentity);
  const pinnedRootSha = createHash('sha256').update(binding.phaseRoot.canonicalPath).digest('hex');
  const tuple = runner.buildExternalNormalV2AuthorizationTuple(plan, '5'.repeat(64), pinnedRootSha,
    '0'.repeat(64), pinnedRootSha, binding, routeIdentity);
  assert.throws(() => runner.validateExternalNormalV2PrivateBinding({
    ...binding, runtime: { finalSourceRevision: binding.runtime.finalSourceRevision,
      workerImageDigest: binding.runtime.workerImageDigest, runtimeManifestSha256: binding.runtime.runtimeManifestSha256 },
  }), /private_binding_invalid/u);
  assert.throws(() => runner.validateExternalNormalV2PrivateBinding({
    ...binding, runtime: { ...binding.runtime, publicationAttestationSha256: 'invalid' },
  }), /private_binding_invalid/u);
  const changedAttestationBinding = { ...binding,
    runtime: { ...binding.runtime, publicationAttestationSha256: '4'.repeat(64) } };
  const changedAttestationPlan = runner.bindExternalNormalV2PrivateInputs(template, changedAttestationBinding, routeIdentity);
  const changedAttestationTuple = runner.buildExternalNormalV2AuthorizationTuple(changedAttestationPlan,
    '5'.repeat(64), pinnedRootSha, '0'.repeat(64), pinnedRootSha, changedAttestationBinding, routeIdentity);
  assert.notEqual(changedAttestationTuple.privateBindingSha256, tuple.privateBindingSha256);
  const changedRouteIdentity = { ...routeIdentity, sourceConfigurationSha256: 'c'.repeat(64) };
  const changedRoutePlan = runner.bindExternalNormalV2PrivateInputs(template, binding, changedRouteIdentity);
  const changedRouteTuple = runner.buildExternalNormalV2AuthorizationTuple(changedRoutePlan,
    '5'.repeat(64), pinnedRootSha, '0'.repeat(64), pinnedRootSha, binding, changedRouteIdentity);
  assert.notEqual(changedRouteTuple.policyTupleSha256, tuple.policyTupleSha256);
  assert.throws(() => runner.buildExternalNormalV2AuthorizationTuple({
    ...plan, policy: { ...plan.policy, effectiveConfigSha256: '0'.repeat(64) },
  }, '5'.repeat(64), pinnedRootSha, '0'.repeat(64), pinnedRootSha, binding, routeIdentity), /private_binding_plan_mismatch/u);
  assert.equal(tuple.qualificationArtifactStoreRootSha256, pinnedRootSha);
  assert.equal(tuple.qualificationArtifactStoreIdentitySha256, pinnedRootSha);
  assert.equal(tuple.launcherSourceTupleSha256, '0'.repeat(64));
  const now = Date.parse('2026-10-07T20:00:00.000Z');
  const grant = { schemaVersion: runner.EXTERNAL_NORMAL_V2_ROOT_GO_SCHEMA, rootGo: true, grantId: randomUUID(),
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), binding: tuple };
  assert.equal(runner.validateRootGoGrant(plan, grant, tuple, now), true);
  assert.equal(runner.validateRootGoGrant({ ...plan, artifactRoots: undefined }, grant, tuple, now), false);
  assert.equal(runner.validateRootGoGrant(plan, { ...grant, binding: { ...tuple, phaseId: 'wrong-phase' } }, tuple, now), false);
  assert.equal(runner.validateRootGoGrant(plan, { ...grant, binding: { ...tuple, phasePlanSha256: '4'.repeat(64) } }, tuple, now), false);
  assert.equal(runner.validateRootGoGrant(plan, { ...grant, expiresAt: new Date(now - 1).toISOString() }, tuple, now), false);
  const freshRootGrantTuple = runner.buildExternalNormalV2AuthorizationTuple(plan, '5'.repeat(64), '6'.repeat(64),
    '0'.repeat(64), '6'.repeat(64), binding, routeIdentity);
  assert.equal(runner.validateRootGoGrant(plan, { ...grant, grantId: randomUUID(), binding: freshRootGrantTuple },
    freshRootGrantTuple, now), false);
  assert.equal(runner.validateExternalNormalV2PhaseRootIdentity(plan, binding.phaseRoot.canonicalPath,
    { uid: binding.phaseRoot.uid, gid: binding.phaseRoot.gid, mode: 0o700 }), true);
  assert.equal(runner.validateExternalNormalV2PhaseRootIdentity(plan, `${binding.phaseRoot.canonicalPath}-replay`,
    { uid: binding.phaseRoot.uid, gid: binding.phaseRoot.gid, mode: 0o700 }), false);

  const root = await mkdtemp(path.join(tmpdir(), 'ws5-v2-once-'));
  try {
    assert.equal(await runner.consumeOneShotGrant(root, grant), true);
    const freshGrantSamePhase = { ...grant, grantId: randomUUID() };
    assert.equal(await runner.consumeOneShotGrant(root, freshGrantSamePhase), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('accepts only an in-image DNS plus verified TLS preflight bound to the route and runtime', async () => {
  const plan = { policy: { inferenceBaseUrl: 'https://gateway.example.invalid/v1' },
    runtime: { finalSourceRevision: 'b'.repeat(40), workerImageDigest: `sha256:${'c'.repeat(64)}`,
      runtimeManifestSha256: 'd'.repeat(64) }, executionEnvelope: { transportPreflightDeadlineMs: 60_000 } };
  const proof = { status: 'ready', mode: 'dns_tls_only', originSha256: createHash('sha256')
    .update(plan.policy.inferenceBaseUrl).digest('hex'), sourceRevision: plan.runtime.finalSourceRevision,
    workerImageDigest: plan.runtime.workerImageDigest, runtimeManifestSha256: plan.runtime.runtimeManifestSha256,
    resolvedAddressCount: 1, resolvedAddressSetSha256: 'e'.repeat(64), tlsAuthorized: true,
    tlsProtocol: 'TLSv1.3', peerCertificateSha256: 'f'.repeat(64), tlsAddressSha256: '1'.repeat(64), elapsedMs: 27_363 };
  assert.equal(runner.validateExternalNormalV2TransportPreflight(plan, proof).status, 'ready');
  assert.equal(runner.validateExternalNormalV2TransportPreflight(plan,
    { ...proof, elapsedMs: 60_001 }).status, 'unavailable');
  assert.equal(runner.validateExternalNormalV2TransportPreflight(plan,
    { ...proof, tlsAuthorized: false }).status, 'unavailable');
  assert.equal(runner.validateExternalNormalV2TransportPreflight(plan,
    { ...proof, mode: 'http_probe' }).status, 'unavailable');
  assert.equal(runner.validateExternalNormalV2TransportPreflight(plan,
    { ...proof, sourceRevision: 'a'.repeat(40) }).status, 'unavailable');
});

test('surfaces only an allowlisted pre-child diagnostic and drops raw error data', () => {
  const known = runner.safeExternalNormalV2PreChildFailure({
    clientAttemptsMayHaveBeenSent: false,
    preChildFailure: { stage: 'case_environment', code: 'required_binding_missing', detail: 'must not escape' },
    message: 'synthetic raw error content',
  });
  assert.deepEqual(known, { stage: 'case_environment', code: 'required_binding_missing' });
  assert.equal(runner.safeExternalNormalV2PreChildFailure({
    clientAttemptsMayHaveBeenSent: false,
    preChildFailure: { stage: 'case_environment', code: 'unrecognized' },
    message: 'synthetic raw error content',
  }), undefined);
  assert.equal(runner.safeExternalNormalV2PreChildFailure({
    clientAttemptsMayHaveBeenSent: true,
    preChildFailure: { stage: 'container_spawn', code: 'docker_launcher_unavailable' },
  }), undefined);
});

test('surfaces only the allowlisted worker receipt-persistence stage and code', () => {
  assert.deepEqual(runner.safeExternalNormalV2WorkerFailure({ workerFailure: {
    stage: 'case_receipt_persistence', code: 'receipt_write_failed', detail: 'synthetic raw failure',
  } }), undefined, 'extra worker failure fields must be discarded fail-closed');
  assert.deepEqual(runner.safeExternalNormalV2WorkerFailure({ workerFailure: {
    stage: 'case_receipt_persistence', code: 'receipt_write_failed',
  } }), { stage: 'case_receipt_persistence', code: 'receipt_write_failed' });
  assert.equal(runner.safeExternalNormalV2WorkerFailure({ workerFailure: {
    stage: 'worker_runtime', code: 'unrecognized',
  } }), undefined);
});

test('requires a private canonical phase root and rejects nested symlinks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ws5-v2-root-'));
  try {
    assert.equal(await runner.canonicalizePhaseRoot(root), await import('node:fs/promises').then((fs) => fs.realpath(root)));
    await symlink(path.join(root, 'target'), path.join(root, 'nested-link'));
    await assert.rejects(runner.canonicalizePhaseRoot(root), /symlink_forbidden/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verifies worker artifacts inside the ROOTGO-bound private phase root', async () => {
  assert.equal(typeof runner.verifyExternalNormalV2ArtifactReferences, 'function');
  const root = await mkdtemp(path.join(tmpdir(), 'ws5-v2-artifacts-'));
  try {
    const relative = 'normal-engine-qualification-store/nq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/single/ws5-current-1dd-v2-p2/receipt.json';
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await writeFile(target, '{"schemaVersion":"ReviewYetiNormalQualification.v1"}\n', { mode: 0o600 });
    await chmod(target, 0o600);
    const bodySha256 = createHash('sha256').update(await readFile(target)).digest('hex');
    const canonicalSha256 = createHash('sha256').update(runner.canonicalJson({ schemaVersion: 'ReviewYetiNormalQualification.v1' })).digest('hex');
    const checksumPath = target.replace(/\.json$/u, '.sha256');
    await writeFile(checksumPath, `${bodySha256}\n`, { mode: 0o600 });
    await chmod(checksumPath, 0o600);
    const reference = { path: relative, sha256: bodySha256, canonicalSha256 };
    assert.equal((await runner.verifyExternalNormalV2ArtifactReferences(root, [reference], canonicalSha256)).verifiedCount, 1);
    await assert.rejects(runner.verifyExternalNormalV2ArtifactReferences(root,
      [{ ...reference, canonicalSha256: 'f'.repeat(64) }], canonicalSha256), /receipt_canonical_digest_mismatch/u);
    const linkPath = path.join(path.dirname(target), 'linked.json');
    await symlink(target, linkPath);
    await assert.rejects(runner.verifyExternalNormalV2ArtifactReferences(root, [reference, {
      path: relative.replace(/receipt\.json$/u, 'linked.json'), sha256: bodySha256,
    }], canonicalSha256), /artifact_symlink_forbidden/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('accepts only one exact Bifrost row for every client CID and keeps cost ledgers separate', () => {
  const expectedRoute = { schemaVersion: runner.EXTERNAL_NORMAL_V2_ROUTE_IDENTITY_SCHEMA,
    routingRuleId: '11111111-1111-4111-8111-111111111111',
    routingRuleName: 'fixture-reviewer-route', provider: 'provider-a', model: 'model-a',
    sourceConfigurationSha256: 'b'.repeat(64) };
  const calls = [
    { clientRequestIdSha256: 'a'.repeat(64), bifrostLogRequestIdSha256: 'a'.repeat(64),
      upstreamResponseRequestIdSha256: 'c'.repeat(64),
      requestedAlias: 'fixture-reviewer', requestedEffort: 'medium', startedAt: '2026-10-07T20:00:00.000Z',
      requestDigest: 'c'.repeat(64), workerTokenUsage: { prompt: 10, completion: 5, total: 15 }, workerEstimatedUsd: 0.01,
      httpStatus: 200 },
    { clientRequestIdSha256: 'd'.repeat(64), bifrostLogRequestIdSha256: 'e'.repeat(64),
      upstreamResponseRequestIdSha256: 'f'.repeat(64),
      requestedAlias: 'fixture-reviewer', requestedEffort: 'medium', startedAt: '2026-10-07T20:01:00.000Z',
      requestDigest: 'f'.repeat(64), workerTokenUsage: { prompt: 20, completion: 8, total: 28 }, workerEstimatedUsd: 0.02,
      httpStatus: 200 },
  ];
  const rows = calls.map((call, index) => ({ clientRequestIdSha256: call.clientRequestIdSha256,
    bifrostLogRequestIdSha256: call.bifrostLogRequestIdSha256, exactRowCount: 1, exactLogRowSha256: String(index + 1).repeat(64),
    bifrostLogRowIdSha256: call.bifrostLogRequestIdSha256,
    upstreamResponseRequestIdSha256: call.upstreamResponseRequestIdSha256,
    bifrostParentRequestIdSha256: String(index + 5).repeat(64),
    parentRequestIdValueSha256: String(index + 5).repeat(64), parentRequestIdState: 'valid',
    routingRuleIdSha256: runner.sha256(expectedRoute.routingRuleId), routingRuleIdState: 'valid',
    routingRuleNameSha256: runner.sha256(expectedRoute.routingRuleName), routingRuleNameState: 'valid',
    fallbackIndex: 0, fallbackIndexState: 'number', numberOfRetries: 0, numberOfRetriesState: 'number',
    serverSideFallbackModelSha256: null, serverSideFallbackModelState: 'null',
    bifrostLogStatus: 'success', provider: 'provider-a', bifrostAlias: null,
    resolvedModel: 'model-a', servedModel: null, serviceTier: 'default', speed: 'standard', inferenceGeo: 'global',
    gatewayTokenUsage: { prompt: 10, completion: 5, total: 15 },
    bifrostCalculatedCostUsd: index === 0 ? 0.01 : 0.02 }));
  const result = runner.validateExactLogLedger(calls, { status: 'captured', rows });
  assert.equal(result.status, 'captured');
  assert.equal(result.matchedRows, 2);
  assert.equal(result.billedUsd, null, 'missing exact billed cost remains unknown');
  assert.equal(result.bifrostCalculatedCostUsd, 0.03, 'gateway-calculated pricing is not provider invoice billing');
  assert.equal(result.estimatedUsd, 0.03);
  assert.equal(result.upstreamLedger[0].bifrostLogRowIdSha256, calls[0].bifrostLogRequestIdSha256);
  assert.equal(result.upstreamLedger[0].upstreamResponseRequestIdSha256, calls[0].upstreamResponseRequestIdSha256);
  assert.equal(result.upstreamLedger[0].bifrostParentRequestIdSha256, '5'.repeat(64));
  assert.equal(runner.validateCapturedRouteIdentity(calls, rows, 'fixture-reviewer', expectedRoute).status, 'observed');
  assert.equal(runner.validateCapturedRouteIdentity(calls,
    [rows[0], { ...rows[1], bifrostAlias: 'key-level-model-alias' }], 'fixture-reviewer', expectedRoute).status, 'observed');
  assert.notEqual(result.requestLedgerSha256, result.upstreamLedgerSha256);
  assert.notEqual(result.tokenLedgerSha256, result.actualBilledLedgerSha256);
  assert.throws(() => runner.validateExactLogLedger(calls, { status: 'captured', rows: rows.slice(1) }), /exact_log_rows_missing/u);
  assert.throws(() => runner.validateExactLogLedger(calls, { status: 'captured', rows: [rows[0], { ...rows[1], clientRequestIdSha256: '9'.repeat(64) }] }),
    /cid_join_mismatch/u);
  assert.throws(() => runner.validateExactLogLedger(calls, { status: 'captured', rows: [rows[0], { ...rows[1], exactRowCount: 2 }] }),
    /row_invalid_or_ambiguous/u);
});

test('proves the server routing rule separately from the client-requested model alias', () => {
  const call = { clientRequestIdSha256: 'a'.repeat(64), requestedAlias: 'fixture-reviewer', httpStatus: 200 };
  const expectedRoute = { schemaVersion: runner.EXTERNAL_NORMAL_V2_ROUTE_IDENTITY_SCHEMA,
    routingRuleId: '11111111-1111-4111-8111-111111111111',
    routingRuleName: 'fixture-reviewer-route', provider: 'provider-a', model: 'model-a',
    sourceConfigurationSha256: 'b'.repeat(64) };
  const row = { clientRequestIdSha256: call.clientRequestIdSha256, bifrostLogStatus: 'success',
    bifrostAlias: null, provider: 'provider-a', resolvedModel: 'model-a',
    routingRuleIdSha256: runner.sha256(expectedRoute.routingRuleId),
    routingRuleIdState: 'valid', routingRuleNameSha256: runner.sha256(expectedRoute.routingRuleName),
    routingRuleNameState: 'valid',
    fallbackIndex: 0, fallbackIndexState: 'number', parentRequestIdState: 'null',
    bifrostParentRequestIdSha256: null, numberOfRetries: 0, numberOfRetriesState: 'number',
    serverSideFallbackModel: null, serverSideFallbackModelSha256: null, serverSideFallbackModelState: 'null' };

  assert.equal(runner.validateCapturedRouteIdentity([call], [row], 'fixture-reviewer', expectedRoute).status, 'observed');
  assert.equal(row.bifrostAlias, null, 'the server route proof must not copy the client model alias into the log alias');
  assert.equal(runner.validateCapturedRouteIdentity([call], [{ ...row, numberOfRetries: 2 }],
    'fixture-reviewer', expectedRoute).status, 'observed', 'provider retries are distinct from route fallback');
  assert.equal(runner.validateCapturedRouteIdentity([call], [{ ...row, parentRequestIdState: 'valid',
    parentRequestIdValueSha256: 'd'.repeat(64), bifrostParentRequestIdSha256: 'd'.repeat(64) }],
  'fixture-reviewer', expectedRoute).status, 'observed', 'parent linkage alone is not a routing fallback');

  const missingRuleId = { ...row };
  delete missingRuleId.routingRuleIdSha256;
  delete missingRuleId.routingRuleIdState;
  const missingRuleName = { ...row };
  delete missingRuleName.routingRuleNameSha256;
  delete missingRuleName.routingRuleNameState;
  const invalidRows = [
    missingRuleId,
    { ...row, routingRuleIdSha256: null },
    { ...row, routingRuleIdSha256: 'c'.repeat(64) },
    missingRuleName,
    { ...row, routingRuleNameSha256: null },
    { ...row, routingRuleNameSha256: 'c'.repeat(64) },
    { ...row, provider: 'provider-b' },
    { ...row, resolvedModel: 'model-b' },
    { ...row, bifrostLogStatus: 'error' },
    { ...row, fallbackIndex: 1 },
    { ...row, fallbackIndex: 1, parentRequestIdState: 'valid',
      parentRequestIdValueSha256: 'd'.repeat(64), bifrostParentRequestIdSha256: 'd'.repeat(64) },
    { ...row, fallbackIndex: null, fallbackIndexState: 'absent' },
    { ...row, fallbackIndex: null, fallbackIndexState: 'null' },
    { ...row, serverSideFallbackModel: 'model-b', serverSideFallbackModelState: 'string' },
  ];
  for (const invalid of invalidRows) {
    assert.throws(() => runner.validateCapturedRouteIdentity([call], [invalid], 'fixture-reviewer', expectedRoute),
      /route_identity_not_proven/u);
  }
  assert.throws(() => runner.validateCapturedRouteIdentity([call], [{ ...row,
    clientRequestIdSha256: 'd'.repeat(64) }], 'fixture-reviewer', expectedRoute), /route_identity_not_proven/u);
  assert.throws(() => runner.validateCapturedRouteIdentity([{ ...call, requestedAlias: 'other-requested-alias' }],
    [row], 'fixture-reviewer', expectedRoute), /route_identity_not_proven/u);
});

test('charges a terminated child to its arm upper bound and marks phase totals unknown', () => {
  assert.deepEqual(runner.externalNormalV2AttemptBounds(0, 58), {
    clientCallsKnown: 0, clientCallCountStatus: 'lower_bound_child_ledger_unknown', unknownClientCallUpperBound: 58,
    overallPhysicalAttempts: null, overallPhysicalAttemptsLowerBound: 150, overallPhysicalAttemptsUpperBound: 208,
    remainingOverallPhysicalAttempts: null, possiblePhaseClientCallsUpperBound: 58,
  });
  assert.deepEqual(runner.externalNormalV2AttemptBounds(17, 0), {
    clientCallsKnown: 17, clientCallCountStatus: 'exact', unknownClientCallUpperBound: 0,
    overallPhysicalAttempts: 167, overallPhysicalAttemptsLowerBound: 167, overallPhysicalAttemptsUpperBound: 167,
    remainingOverallPhysicalAttempts: 2533, possiblePhaseClientCallsUpperBound: 17,
  });
  assert.throws(() => runner.externalNormalV2AttemptBounds(250, 58), /attempt_bounds_invalid/u);
});

test('recovers only digest-checked private IDs and bounds them to the arm allocation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ws5-v2-recover-cids-'));
  await chmod(root, 0o700);
  const runId = `nq_${'a'.repeat(32)}`;
  const caseId = 'ws5-current-1dd-v2-p2';
  const directory = path.join(root, 'normal-engine-qualification-store', runId, 'single', caseId,
    'provider-identifiers.record');
  const rows = [0, 1].map(() => ({ callerRequestId: randomUUID(), bifrostLogRequestId: null,
    upstreamResponseRequestId: randomUUID() }));
  for (const row of rows) row.bifrostLogRequestId = row.callerRequestId;
  const body = `${JSON.stringify(rows, null, 2)}\n`;
  const bodySha = createHash('sha256').update(body).digest('hex');
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, 'provider-identifiers.json'), body, { mode: 0o600 });
    await chmod(path.join(directory, 'provider-identifiers.json'), 0o600);
    await writeFile(path.join(directory, 'provider-identifiers.sha256'), `${bodySha}\n`, { mode: 0o600 });
    await chmod(path.join(directory, 'provider-identifiers.sha256'), 0o600);
    const recovered = await runner.recoverExternalNormalV2PrivateIdentifierSidecar(root, runId, 'single', caseId, 1);
    assert.equal(recovered.status, 'recovered');
    assert.equal(recovered.candidateCount, 1);
    assert.equal(recovered.blockedAttestorTailCount, 1);
    assert.equal(recovered.sidecarReference.sha256, bodySha);
    assert.equal(recovered.calls[0].clientRequestIdSha256, createHash('sha256').update(rows[0].callerRequestId).digest('hex'));
    assert.equal(JSON.stringify(recovered).includes(rows[0].callerRequestId), false);
    const logRow = { id: rows[0].callerRequestId, parent_request_id: null,
      routing_rule_id: '11111111-1111-4111-8111-111111111111', routing_rule_name: 'fixture-reviewer-route',
      provider: 'provider-a', alias: null, model: 'model-a', served_model: null, status: 'success',
      service_tier: 'default', fallback_index: 0, number_of_retries: 0,
      server_side_fallback_model: null };
    const captureRow = async (value, { phaseId = 'ws5-current-source-external-v2',
      planSha256 = 'b'.repeat(64), stepId = 'v2-p2-first' } = {}) => {
      const collector = createExternalNormalV2ExactLogCollector({ storeRoot: root,
        managementBaseUrl: 'https://management.example.invalid',
        readManagementAuthInMemory: () => ({ username: 'u', password: 'p' }),
        fetchImpl: async () => new Response(JSON.stringify({ data: [value] }),
          { status: 200, headers: { 'content-type': 'application/json' } }) });
      return collector({ phaseId, planSha256,
        artifactStoreRoot: root, calls: recovered.calls,
        stepReceipts: [{ stepId, runId, artifactReferences: [recovered.sidecarReference] }],
        deadlineAt: Date.now() + 10_000 });
    };
    const recoveredCapture = await captureRow(logRow);
    assert.equal(recoveredCapture.status, 'captured', JSON.stringify(recoveredCapture));
    const r2Capture = await captureRow(logRow, { phaseId: runner.EXTERNAL_NORMAL_R2_PHASE_ID,
      planSha256: runner.EXTERNAL_NORMAL_R2_COHORT_PLAN_SHA256, stepId: 'r2-s001' });
    assert.equal(r2Capture.status, 'captured', JSON.stringify(r2Capture));
    await assert.rejects(captureRow(logRow, { phaseId: runner.EXTERNAL_NORMAL_R2_PHASE_ID,
      planSha256: '0'.repeat(64), stepId: 'r2-s001' }), /exact_log_capture_request_invalid/u);
    await assert.rejects(captureRow(logRow, { phaseId: 'ws5-arbitrary-phase',
      planSha256: 'b'.repeat(64), stepId: 'r2-s001' }), /exact_log_capture_request_invalid/u);
    assert.equal(recoveredCapture.rows[0].bifrostAlias, null);
    assert.equal(recoveredCapture.rows[0].routingRuleIdSha256, runner.sha256(logRow.routing_rule_id));
    assert.equal(recoveredCapture.rows[0].routingRuleNameSha256, runner.sha256(logRow.routing_rule_name));
    assert.equal(recoveredCapture.rows[0].fallbackIndex, 0);
    assert.equal(recoveredCapture.rows[0].fallbackIndexState, 'number');
    assert.equal(recoveredCapture.rows[0].parentRequestIdState, 'null');
    assert.equal(recoveredCapture.rows[0].numberOfRetries, 0);
    assert.equal(recoveredCapture.rows[0].numberOfRetriesState, 'number');
    assert.equal(recoveredCapture.rows[0].serverSideFallbackModelState, 'null');
    const changedRuleCapture = await captureRow({ ...logRow, routing_rule_id: '22222222-2222-4222-8222-222222222222' });
    assert.notEqual(changedRuleCapture.rows[0].exactLogRowSha256, recoveredCapture.rows[0].exactLogRowSha256);
    const changedRuleNameCapture = await captureRow({ ...logRow, routing_rule_name: 'other-route' });
    assert.notEqual(changedRuleNameCapture.rows[0].exactLogRowSha256, recoveredCapture.rows[0].exactLogRowSha256);
    const fallbackCapture = await captureRow({ ...logRow, fallback_index: 1 });
    assert.notEqual(fallbackCapture.rows[0].exactLogRowSha256, recoveredCapture.rows[0].exactLogRowSha256);
    const parentId = randomUUID();
    const validParentCapture = await captureRow({ ...logRow, parent_request_id: parentId });
    assert.equal(validParentCapture.rows[0].parentRequestIdState, 'valid');
    assert.equal(validParentCapture.rows[0].bifrostParentRequestIdSha256, runner.sha256(parentId.toLowerCase()));
    assert.equal(JSON.stringify(validParentCapture).includes(parentId), false);
    const invalidParentCapture = await captureRow({ ...logRow, parent_request_id: 'invalid-parent-id' });
    assert.equal(invalidParentCapture.rows[0].parentRequestIdState, 'invalid');
    assert.equal(invalidParentCapture.rows[0].parentRequestIdValueSha256, runner.sha256('invalid-parent-id'));
    assert.equal(JSON.stringify(invalidParentCapture).includes('invalid-parent-id'), false);
    const absentParentCapture = await captureRow(Object.fromEntries(Object.entries(logRow).filter(([key]) => key !== 'parent_request_id')));
    assert.equal(absentParentCapture.rows[0].parentRequestIdState, 'absent');
    assert.notEqual(absentParentCapture.rows[0].exactLogRowSha256, recoveredCapture.rows[0].exactLogRowSha256);
    const absentFallbackCapture = await captureRow(Object.fromEntries(Object.entries(logRow).filter(([key]) => key !== 'fallback_index')));
    assert.equal(absentFallbackCapture.rows[0].fallbackIndexState, 'absent');
    const nullFallbackCapture = await captureRow({ ...logRow, fallback_index: null });
    assert.equal(nullFallbackCapture.rows[0].fallbackIndexState, 'null');
    assert.equal(JSON.stringify(recoveredCapture).includes(rows[0].callerRequestId), false);
    assert.equal((await runner.recoverExternalNormalV2PrivateIdentifierSidecar(root, runId, 'single',
      'ws5-current-1dd-v2-provider-failure', 1)).status, 'absent');
    await writeFile(path.join(directory, 'provider-identifiers.sha256'), `${'f'.repeat(64)}\n`, { mode: 0o600 });
    await assert.rejects(runner.recoverExternalNormalV2PrivateIdentifierSidecar(root, runId, 'single', caseId, 1),
      /recovery_digest_mismatch/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('requires actual Gate, history, and typed preflight evidence for each normal/control receipt', async () => {
  assert.equal(typeof runner.assessExternalNormalV2StepReceipt, 'function');
  const root = new URL('../../', import.meta.url).pathname;
  const plan = JSON.parse(await readFile(path.join(root,
    'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/phase-plan.json'), 'utf8'));
  const digest = (character) => character.repeat(64);
  const p2 = plan.runs.find((step) => step.stepId === 'v2-p2-first');
  const eligible = { stepId: p2.stepId, terminalStatus: 'completed', clientCalls: 3,
    providerCalls: [{ clientRequestIdSha256: digest('7'), bifrostLogRequestIdSha256: digest('7'),
      requestedAlias: 'fixture-reviewer', requestedEffort: 'medium', startedAt: '2026-10-07T20:00:00.000Z',
      requestDigest: digest('8') }],
    outcome: { workerOutcomeClass: 'completed_eligible', gateOutcomeClass: 'completed_eligible', agreement: 'agreement',
      canonicalEvidenceSha256: digest('a'), gateDecisionSha256: digest('b') },
    canonicalReviewEvidence: { decisionClassification: 'SHIP', counts: { p0Count: 0, p1Count: 0, p2Count: 1, p3Count: 0, nitCount: 0 },
      coverageComplete: true, quorumSatisfied: true, blockingFindings: [] },
    qualificationControl: 'none' };
  assert.equal(runner.assessExternalNormalV2StepReceipt(p2, eligible).status, 'accepted');
  assert.equal(runner.assessExternalNormalV2StepReceipt(p2,
    { ...eligible, clientCalls: 0, providerCalls: [] }).status, 'failed');
  assert.equal(runner.assessExternalNormalV2StepReceipt(p2, { ...eligible, outcome: undefined }).status, 'incomplete');
  assert.equal(runner.assessExternalNormalV2StepReceipt(p2, { ...eligible,
    outcome: { ...eligible.outcome, gateOutcomeClass: 'completed_ineligible' } }).status, 'failed');

  const sequenceA = plan.runs.find((step) => step.stepId === 'v2-sequence-a');
  const sequenceAInput = JSON.parse(await readFile(path.join(root,
    'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/seq_a.json'), 'utf8'));
  const sequenceAIdentity = { repository: `${sequenceAInput.source.repository.owner}/${sequenceAInput.source.repository.repo}`,
    baseSha: sequenceAInput.source.baseSha, headSha: sequenceAInput.source.headSha };
  const sequenceACitation = { sourceWindowManifestDigest: digest('3'), usedCitationIds: ['cite-head-audience-policy'],
    citations: [{ id: 'cite-head-audience-policy', path: 'audience-policy.ts', repository: sequenceAIdentity.repository,
      side: 'head', revisionSha: sequenceAIdentity.headSha, headSha: sequenceAIdentity.headSha,
      baseSha: sequenceAIdentity.baseSha, sourceDigest: digest('4'), window: null }] };
  const introducedP1 = { ...eligible, stepId: sequenceA.stepId,
    outcome: { ...eligible.outcome, workerOutcomeClass: 'completed_ineligible', gateOutcomeClass: 'completed_ineligible' },
    canonicalReviewEvidence: { decisionClassification: 'FIX_FIRST', counts: { p0Count: 0, p1Count: 1, p2Count: 0, p3Count: 0, nitCount: 0 },
      coverageComplete: true, quorumSatisfied: true, blockingFindings: [{ fingerprintSha256: digest('8'), severity: 'P1',
        path: 'audience-policy.ts', line: 17, title: 'Route audience is bypassed', claim: 'The missing audience is defaulted to a permissive value.',
        blockerEvidence: { trigger: 'A request has no audience.', impact: 'An excluded route can be selected.',
          violatedContract: 'Requests must satisfy the selected route audience.' },
        reviewIdentity: sequenceAIdentity, citationEvidence: sequenceACitation,
        verificationStatus: 'confirmed', causalScope: 'introduced',
        sourceReviewIdentitySha256: createHash('sha256').update(runner.canonicalJson(sequenceAIdentity)).digest('hex'),
        scopeEvidenceSha256: digest('9'), blockerEvidenceSha256: digest('7') }] } };
  assert.equal(runner.assessExternalNormalV2StepReceipt(sequenceA, introducedP1, null, sequenceAIdentity).status, 'accepted');
  assert.equal(runner.assessExternalNormalV2StepReceipt(sequenceA, eligible, null, sequenceAIdentity).status, 'failed');
  assert.equal(runner.assessExternalNormalV2StepReceipt(sequenceA, { ...introducedP1, canonicalReviewEvidence: {
    ...introducedP1.canonicalReviewEvidence,
    blockingFindings: [{ ...introducedP1.canonicalReviewEvidence.blockingFindings[0], sourceReviewIdentitySha256: digest('6') }],
  } }, null, sequenceAIdentity).status, 'failed');

  const sequenceBHistory = plan.runs.find((step) => step.stepId === 'v2-sequence-b-history');
  const sourceRunId = 'nq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const repairedB = { ...eligible, stepId: sequenceBHistory.stepId,
    history: { source: 'isolated-qualification-store', loadStatus: 'complete', snapshotIdSha256: digest('3'),
      contextDigest: digest('4'), parentRunIdSha256: createHash('sha256').update(sourceRunId).digest('hex') } };
  assert.equal(runner.assessExternalNormalV2StepReceipt(sequenceBHistory, repairedB, sourceRunId).status, 'accepted');
  assert.equal(runner.assessExternalNormalV2StepReceipt(sequenceBHistory, repairedB, 'nq_wrong').status, 'incomplete');
  const sequenceBFullSource = plan.runs.find((step) => step.stepId === 'v2-sequence-b-full-source');
  assert.equal(runner.assessExternalNormalV2StepReceipt(sequenceBFullSource,
    { ...eligible, stepId: sequenceBFullSource.stepId,
      history: { source: 'empty-qualification-ablation', loadStatus: 'complete', snapshotIdSha256: null,
        contextDigest: null, parentRunIdSha256: null } }).status, 'accepted');

  const providerFailure = plan.runs.find((step) => step.stepId === 'v2-provider-failure-control');
  const authReceipt = { stepId: providerFailure.stepId, terminalStatus: 'incomplete', clientCalls: 1, blockedClientCalls: 0,
    outcome: { workerOutcomeClass: 'incomplete', gateOutcomeClass: 'incomplete', agreement: 'incomplete',
      canonicalEvidenceSha256: null, gateDecisionSha256: digest('c') },
    qualificationControl: 'bifrost-auth-rejection-invalid-inference-key',
    providerCalls: [{ clientRequestIdSha256: digest('d'), bifrostLogRequestIdSha256: digest('d'), httpStatus: 401,
      fetchFailureClass: 'http_error' }] };
  assert.equal(runner.assessExternalNormalV2StepReceipt(providerFailure, authReceipt).status, 'expected_control');
  assert.equal(runner.assessExternalNormalV2StepReceipt(providerFailure,
    { ...authReceipt, terminalStatus: 'completed' }).status, 'failed');
  assert.equal(runner.assessExternalNormalV2StepReceipt(providerFailure,
    { ...authReceipt, providerCalls: [{ ...authReceipt.providerCalls[0], httpStatus: 200 }] }).status, 'failed');

  const coverage = plan.runs.find((step) => step.stepId === 'v2-coverage-hole-control');
  const coverageReceipt = { stepId: coverage.stepId, terminalStatus: 'incomplete', clientCalls: 0, blockedClientCalls: 0,
    outcome: { workerOutcomeClass: 'incomplete', gateOutcomeClass: 'incomplete', agreement: 'incomplete',
      canonicalEvidenceSha256: null, gateDecisionSha256: digest('e') }, qualificationControl: 'source-coverage-unavailable',
    providerCalls: [],
    preflight: { control: 'source-coverage-unavailable', sourceCoverage: 'unavailable',
      withheldPath: 'src/modules/module-01.ts', physicalClientCalls: 0 } };
  assert.equal(runner.assessExternalNormalV2StepReceipt(coverage, coverageReceipt).status, 'expected_control');
  assert.equal(runner.assessExternalNormalV2StepReceipt(coverage,
    { ...coverageReceipt, preflight: { ...coverageReceipt.preflight, physicalClientCalls: 1 } }).status, 'failed');

  const historyFailure = plan.runs.find((step) => step.stepId === 'v2-required-history-unavailable-control');
  const expectedHistorySourceSha = createHash('sha256').update('nq_source').digest('hex');
  const historyReceipt = { stepId: historyFailure.stepId, terminalStatus: 'incomplete', clientCalls: 0, blockedClientCalls: 0,
    outcome: { workerOutcomeClass: 'incomplete', gateOutcomeClass: 'incomplete', agreement: 'incomplete',
      canonicalEvidenceSha256: null, gateDecisionSha256: digest('f') }, qualificationControl: 'history-unavailable',
    providerCalls: [],
    history: { source: 'unavailable', loadStatus: 'unavailable', snapshotIdSha256: null, contextDigest: null,
      parentRunIdSha256: expectedHistorySourceSha },
    preflight: { control: 'required-history-unavailable-transport', historyStatus: 'unavailable',
      historyFailureClass: 'transport', historySourceRunIdSha256: expectedHistorySourceSha, physicalClientCalls: 0 } };
  assert.equal(runner.assessExternalNormalV2StepReceipt(historyFailure, historyReceipt, 'nq_source').status, 'expected_control');
  assert.equal(runner.assessExternalNormalV2StepReceipt(historyFailure,
    { ...historyReceipt, preflight: { ...historyReceipt.preflight, historyFailureClass: 'not-found' } }, 'nq_source').status, 'failed');

  const exhaustion = plan.runs.find((step) => step.stepId === 'v2-resource-exhaustion-control');
  const exhaustionReceipt = { stepId: exhaustion.stepId, terminalStatus: 'incomplete', clientCalls: 1, blockedClientCalls: 1,
    outcome: { workerOutcomeClass: 'incomplete', gateOutcomeClass: 'incomplete', agreement: 'incomplete',
      canonicalEvidenceSha256: null, gateDecisionSha256: digest('2') },
    qualificationControl: 'worker-deadline-test-60s-one-physical-request',
    providerCalls: [{ clientRequestIdSha256: digest('3'), bifrostLogRequestIdSha256: digest('3'), httpStatus: 200,
      fetchFailureClass: null }],
    resourceExhaustion: { status: 'observed', physicalRequestCap: 1, logicalCompletionAttempts: 2,
      physicalRequests: 1, blockedPhysicalRequestAttempts: 1, firstResponseHttpStatus: 200,
      firstLogicalCompletionSucceeded: true } };
  assert.equal(runner.assessExternalNormalV2StepReceipt(exhaustion, exhaustionReceipt).status, 'expected_control');
  assert.equal(runner.assessExternalNormalV2StepReceipt(exhaustion,
    { ...exhaustionReceipt, resourceExhaustion: { ...exhaustionReceipt.resourceExhaustion, status: 'not_observed' } }).status, 'failed');
});

test('does not mutate an output root before an exact phase-bound grant is valid', async () => {
  const repositoryRoot = new URL('../../', import.meta.url).pathname;
  const phaseRoot = await mkdtemp(path.join(tmpdir(), 'ws5-v2-invalid-rootgo-'));
  let workerInvocations = 0;
  try {
    const result = await runner.runExternalNormalQualificationV2({ repositoryRoot, phaseRoot,
      authorization: { rootGo: true, phaseId: 'wrong' }, executeCase: async () => { workerInvocations += 1; } });
    assert.equal(result.status, 'private_binding_required');
    assert.equal(workerInvocations, 0);
    assert.deepEqual(await (await import('node:fs/promises')).readdir(phaseRoot), []);
  } finally { await rm(phaseRoot, { recursive: true, force: true }); }
});

test('rejects symlinks in pinned plan, bundle and source-input descendants', async () => {
  const sourceRoot = new URL('../../', import.meta.url).pathname;
  const root = await mkdtemp(path.join(tmpdir(), 'ws5-v2-input-tree-'));
  const relative = 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2';
  const source = path.join(sourceRoot, relative);
  const target = path.join(root, relative);
  try {
    await mkdir(path.join(target, 'inputs'), { recursive: true });
    await cp(path.join(source, 'phase-plan.json'), path.join(target, 'phase-plan.json'));
    await cp(path.join(source, 'source-bundle.json'), path.join(target, 'source-bundle.json'));
    await cp(path.join(source, 'inputs'), path.join(target, 'inputs'), { recursive: true });
    const input = path.join(target, 'inputs/p2.json');
    await rm(input);
    await symlink(path.join(source, 'inputs/p2.json'), input);
    await assert.rejects(runner.readFrozenExternalNormalV2Plan(root), /descriptor_symlink_forbidden/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
