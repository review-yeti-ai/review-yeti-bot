import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyQualificationFixtureAllowlist } from '../../scripts/normal-engine-qualification-fixtures.mjs';
import { createExternalNormalV2ExactLogCollector } from '../../scripts/ws5-external-bifrost-log-collector.mjs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const runnerUrl = pathToFileURL(new URL('../../scripts/ws5-external-normal-v2.mjs', import.meta.url).pathname);
const runner = await import(runnerUrl.href).catch(() => null);
const require = createRequire(import.meta.url);
const host = require('../../dist/qualification/normalEngineQualificationExternalV2.js');

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

async function createCoordinatorHarness(repositoryRoot) {
  const { plan: template, bundle, planSha256 } = await runner.readFrozenExternalNormalV2Plan(repositoryRoot);
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
  const runtime = { finalSourceRevision: template.runtime.preparedConfigHelperSourceRevision,
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
      source_sha: template.runtime.preparedConfigHelperSourceRevision, helper: 'preparePublishingPolicy',
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

  const preparedManifest = { schema: 'exampleorg.review-yeti-prepared-execution-host-bundle.v1',
    fixture_path: 'review-yeti-v2-prepared-execution-host.fixture.json',
    fixture_sha256: preparedExecutionFixtureSha256,
    prepared_from: { repository: sourceDescriptor.repository, repository_id: sourceDescriptor.repositoryId,
      source_sha: sourceDescriptor.sourceRef, content_sha256: candidateRawSha256 },
    helper: { repository: 'review-yeti-ai/review-yeti-bot', helper: 'preparePublishingPolicy',
      helper_path: 'src/review/preparedPublishingPolicy.ts',
      source_sha: template.runtime.preparedConfigHelperSourceRevision,
      source_file_sha256: template.runtime.preparedConfigHelperSourceFileSha256,
      compiled_file_sha256: template.runtime.preparedConfigHelperCompiledFileSha256 },
    transport: { provider: 'bifrost', baseUrl: transport.selectedBaseUrl, model: transport.modelAlias },
    samples: template.targetProjections.flatMap((target) => ['default', 'comparison'].map((scenario) => ({
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


async function runLoadedAdapterCollectorHarness({ sidecarMode = 'valid' } = {}) {
  const repositoryRoot = new URL('../../', import.meta.url).pathname;
  const harness = await createCoordinatorHarness(repositoryRoot);
  const syntheticRows = Array.from({ length: 25 }, () => ({ callerRequestId: randomUUID(), bifrostLogRequestId: null,
    upstreamResponseRequestId: randomUUID() }));
  for (const row of syntheticRows) row.bifrostLogRequestId = row.callerRequestId;
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const source = harness.binding.sourceDescriptor;
  const [sourceOwner, sourceRepo] = source.repository.split('/');
  const baseEnv = {
    NODE_ENV: 'test', OPENAI_BASE_URL: harness.binding.transport.selectedBaseUrl,
    REVIEW_MODEL: harness.binding.transport.modelAlias,
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
    REVIEW_CONFIG_DIGEST: harness.binding.policy.effectiveConfigSha256,
    REVIEW_POLICY_DIGEST: harness.binding.policy.effectivePolicySha256,
    REVIEW_PREPARED_CONFIG_JSON: await readFile(path.join(harness.policyInputRoot,
      'prepared-host/prepared-73004-default.json'), 'utf8'),
  };
  const caseMounts = [];
  let childEnvHasInferenceKey = false;
  let argsContainSyntheticCredential = false;
  const spawnImplementation = (command, args, options) => {
    assert.equal(command, 'docker');
    const caseMount = args.find((value) => value.startsWith('type=bind,source=') && value.endsWith(',target=/phase'));
    assert.ok(caseMount, 'case worker must mount the isolated store at /phase');
    const sourcePath = caseMount.slice('type=bind,source='.length, caseMount.lastIndexOf(',target=/phase'));
    caseMounts.push(sourcePath);
    childEnvHasInferenceKey = options?.env?.OPENAI_API_KEY !== undefined;
    argsContainSyntheticCredential = args.includes('synthetic-inference-key-for-offline-test-only');

    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.pid = 4567;
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
        delete request.inferenceCredential;
        assert.equal(request.clientCallAllocation, 58);
        assert.equal(request.projection.stepId, 'v2-p2-first');
        assert.equal(request.projection.arm, 'p2-only');
        const runId = request.projection.runId;
        const caseId = request.projection.caseId;
        const artifactDirectory = path.join(sourcePath, runId, 'single', caseId, 'provider-identifiers.record');
        await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
        const body = `${JSON.stringify(syntheticRows, null, 2)}\n`;
        const bodySha = digest(body);
        const identifierFile = path.join(artifactDirectory, 'provider-identifiers.json');
        const checksumFile = path.join(artifactDirectory, 'provider-identifiers.sha256');
        await writeFile(identifierFile, body, { mode: 0o600 });
        await chmod(identifierFile, 0o600);
        await writeFile(checksumFile, `${sidecarMode === 'corrupt' ? '0'.repeat(64) : bodySha}\n`, { mode: 0o600 });
        await chmod(checksumFile, 0o600);

        const providerCalls = syntheticRows.map((row, index) => ({
          clientRequestIdSha256: digest(row.callerRequestId.toLowerCase()),
          bifrostLogRequestIdSha256: digest(row.bifrostLogRequestId.toLowerCase()),
          upstreamResponseRequestIdSha256: digest(row.upstreamResponseRequestId.toLowerCase()),
          requestedAlias: harness.binding.transport.modelAlias, requestedEffort: 'medium',
          startedAt: new Date(1_800_000_000_000 + index).toISOString(),
          requestDigest: digest(`synthetic-request-${index}`), httpStatus: 200, fetchFailureClass: null,
          workerTokenUsage: null, workerEstimatedUsd: null,
        }));
        const receipt = {
          clientCalls: 25, blockedClientCalls: 0, terminalStatus: 'failed',
          receiptSha256: digest('synthetic-worker-failure-after-25-calls'),
          failureCode: 'worker_execution_failed', artifactReferences: [],
          outcome: null, canonicalReviewEvidence: null, history: null, qualificationControl: null,
          preflight: null, resourceExhaustion: null, attestorRecordedCalls: 25, providerCalls,
        };
        child.stdout.write(`__EXTERNAL_NORMAL_V2_RESULT__${JSON.stringify(receipt)}\n`);
        child.stdout.end();
        child.emit('close', 0);
      })().catch((error) => {
        child.stdout.end();
        child.emit('error', error);
      });
    });
    return child;
  };
  let managementAuthReads = 0;
  let logFetchCalls = 0;
  const adapter = host.createPinnedWorkerImageExternalNormalV2Adapter({
    policyInputRoot: harness.policyInputRoot, baseEnv, privateBinding: harness.binding,
    readInferenceKeyInMemory: () => 'synthetic-inference-key-for-offline-test-only',
    assertImageAvailable: () => {}, spawnImplementation,
  });
  const collector = createExternalNormalV2ExactLogCollector({
    managementBaseUrl: harness.binding.managementBaseUrl, storeRoot: harness.phaseRoot,
    readManagementAuthInMemory: () => { managementAuthReads += 1;
      return { username: 'synthetic-user', password: 'synthetic-password' }; },
    fetchImpl: async (input) => {
      logFetchCalls += 1;
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('limit'), '1');
      const callerRequestId = url.searchParams.get('request_id');
      assert.ok(syntheticRows.some((row) => row.callerRequestId === callerRequestId));
      const expectedRoute = harness.routeIdentity;
      return new Response(JSON.stringify({ data: [{ id: callerRequestId, parent_request_id: null,
        routing_rule_id: expectedRoute.routingRuleId, routing_rule_name: expectedRoute.routingRuleName,
        provider: expectedRoute.provider, alias: null, model: expectedRoute.model, status: 'success',
        fallback_index: 0, number_of_retries: 0, server_side_fallback_model: null }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const now = Date.now();
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
  const result = await runner.runExternalNormalQualificationV2({
    repositoryRoot, policyInputRoot: harness.policyInputRoot, phaseRoot: harness.phaseRoot,
    privateBinding: harness.binding, routeIdentity: harness.routeIdentity, authorization, now: () => now,
    preflightExecution: async ({ origin, sourceRevision, workerImageDigest, runtimeManifestSha256 }) => ({
      status: 'ready', mode: 'dns_tls_only', originSha256: runner.sha256(origin), sourceRevision,
      workerImageDigest, runtimeManifestSha256, resolvedAddressCount: 1,
      resolvedAddressSetSha256: '8'.repeat(64), tlsAuthorized: true, tlsProtocol: 'TLSv1.3',
      peerCertificateSha256: '9'.repeat(64), tlsAddressSha256: 'a'.repeat(64), elapsedMs: 1,
    }),
    executeCase: adapter.executeCase,
    captureExactLogs: collector,
  });
  return { result, harness, caseMounts, managementAuthReads, logFetchCalls, childEnvHasInferenceKey, argsContainSyntheticCredential };
}

test('joins the actual failed case sidecar through the worker mount and collector without recounting calls', async () => {
  const { result, harness, caseMounts, managementAuthReads, logFetchCalls, childEnvHasInferenceKey, argsContainSyntheticCredential } = await runLoadedAdapterCollectorHarness();
  try {
    assert.deepEqual(caseMounts, [path.join(harness.phaseRoot, 'normal-engine-qualification-store')]);
    assert.equal(result.status, 'failed', 'a failed worker receipt must never become a completed phase');
    assert.equal(result.clientCalls, 25);
    assert.equal(result.unknownClientCallUpperBound, 0);
    assert.equal(result.phaseAttemptAllocation.spent, 25);
    assert.equal(result.overallPhysicalAttempts, 175);
    assert.equal(result.stepResults.length, 1);
    assert.equal(result.stepResults[0].terminalStatus, 'failed');
    assert.equal(result.stepResults[0].clientCalls, 25);
    assert.equal(result.stepResults[0].clientCallAllocation, 58);
    assert.equal(result.exactLogCapture.status, 'captured', `safe failure code: ${result.exactLogCapture.failureCode || 'none'}`);
    assert.equal(result.exactLogCapture.queriedCallCount, 25);
    assert.equal(result.exactLogCapture.matchedRows, 25);
    assert.equal(result.exactLogCapture.unqueriedCallCount, 0);
    assert.equal(result.logLedger.matchedRows, 25);
    assert.equal(result.routeIdentityProofs[0].status, 'observed');
    assert.equal(result.routeIdentityProofs[0].routeExpectationSha256,
      runner.sha256(runner.canonicalJson(harness.routeIdentity)));
    assert.equal(result.logLedger.upstreamLedger[0].bifrostAlias, null);
    assert.equal(result.logLedger.upstreamLedger[0].routingRuleIdSha256,
      runner.sha256(harness.routeIdentity.routingRuleId));
    assert.equal(result.logLedger.upstreamLedger[0].routingRuleNameSha256,
      runner.sha256(harness.routeIdentity.routingRuleName));
    assert.equal(result.logLedger.upstreamLedger[0].fallbackIndexState, 'number');
    assert.equal(result.logLedger.upstreamLedger[0].fallbackIndex, 0);
    assert.equal(managementAuthReads, 1);
    assert.equal(childEnvHasInferenceKey, false);
    assert.equal(argsContainSyntheticCredential, false);
    assert.equal(logFetchCalls, 25);
    assert.equal(JSON.stringify(result).includes('callerRequestId'), false);
    assert.equal(JSON.stringify(result).includes(harness.routeIdentity.routingRuleId), false);
    assert.equal(JSON.stringify(result).includes(harness.routeIdentity.routingRuleName), false);
  } finally { await rm(harness.tempRoot, { recursive: true, force: true }); }
});

test('fails closed on a corrupt sidecar without querying any log rows or changing the exact 25-call count', async () => {
  const { result, harness, caseMounts, managementAuthReads, logFetchCalls, childEnvHasInferenceKey, argsContainSyntheticCredential } = await runLoadedAdapterCollectorHarness({ sidecarMode: 'corrupt' });
  try {
    assert.deepEqual(caseMounts, [path.join(harness.phaseRoot, 'normal-engine-qualification-store')]);
    assert.equal(result.status, 'failed');
    assert.equal(result.clientCalls, 25);
    assert.equal(result.unknownClientCallUpperBound, 0);
    assert.equal(result.phaseAttemptAllocation.spent, 25);
    assert.equal(result.overallPhysicalAttempts, 175);
    assert.equal(result.stepResults.length, 1);
    assert.equal(result.stepResults[0].terminalStatus, 'failed');
    assert.equal(result.exactLogCapture.status, 'unavailable');
    assert.equal(result.exactLogCapture.queriedCallCount, 0);
    assert.equal(result.exactLogCapture.matchedRows, 0);
    assert.equal(result.exactLogCapture.unqueriedCallCount, 25);
    assert.ok(['external_normal_v2_private_cid_binding_missing', 'external_normal_v2_recovery_digest_mismatch']
      .includes(result.exactLogCapture.failureCode));
    assert.equal(managementAuthReads, 0);
    assert.equal(logFetchCalls, 0);
    assert.equal(childEnvHasInferenceKey, false);
    assert.equal(argsContainSyntheticCredential, false);
  } finally { await rm(harness.tempRoot, { recursive: true, force: true }); }
});

test('supports a sealed-copy log-only read with separate private input and sanitized output roots', async () => {
  const sourceRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'ws5-v2-log-source-')));
  const diagnosticInputRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'ws5-v2-log-input-')));
  const outputRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'ws5-v2-log-output-')));
  for (const root of [sourceRoot, diagnosticInputRoot, outputRoot]) await chmod(root, 0o700);
  const runId = `nq_${'a'.repeat(32)}`;
  const caseId = 'ws5-current-1dd-v2-p2';
  const rawRows = Array.from({ length: 25 }, () => ({ callerRequestId: randomUUID(), bifrostLogRequestId: null,
    upstreamResponseRequestId: randomUUID() }));
  for (const row of rawRows) row.bifrostLogRequestId = row.callerRequestId;
  const sidecarRelativePath = `${runId}/single/${caseId}/provider-identifiers.record/provider-identifiers.json`;
  const sourceDirectory = path.join(sourceRoot, runId, 'single', caseId, 'provider-identifiers.record');
  await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
  const sidecarBytes = Buffer.from(`${JSON.stringify(rawRows, null, 2)}\n`);
  const sidecarSha256 = createHash('sha256').update(sidecarBytes).digest('hex');
  const sourceSidecarPath = path.join(sourceDirectory, 'provider-identifiers.json');
  const sourceChecksumPath = path.join(sourceDirectory, 'provider-identifiers.sha256');
  await writeFile(sourceSidecarPath, sidecarBytes, { mode: 0o600 });
  await chmod(sourceSidecarPath, 0o600);
  await writeFile(sourceChecksumPath, `${sidecarSha256}\n`, { mode: 0o600 });
  await chmod(sourceChecksumPath, 0o600);

  const copiedRelativePath = `normal-engine-qualification-store/${sidecarRelativePath}`;
  const copiedSidecarPath = path.join(diagnosticInputRoot, copiedRelativePath);
  const copiedChecksumPath = path.join(path.dirname(copiedSidecarPath), 'provider-identifiers.sha256');
  await mkdir(path.dirname(copiedSidecarPath), { recursive: true, mode: 0o700 });
  const sourceReadback = await readFile(sourceSidecarPath);
  const sourceChecksumReadback = (await readFile(sourceChecksumPath, 'utf8')).trim();
  assert.equal(createHash('sha256').update(sourceReadback).digest('hex'), sidecarSha256);
  assert.equal(sourceChecksumReadback, sidecarSha256);
  await writeFile(copiedSidecarPath, sourceReadback, { mode: 0o600 });
  await chmod(copiedSidecarPath, 0o600);
  await writeFile(copiedChecksumPath, `${sourceChecksumReadback}\n`, { mode: 0o600 });
  await chmod(copiedChecksumPath, 0o600);
  sourceReadback.fill(0);
  sidecarBytes.fill(0);

  let authReads = 0;
  let logGets = 0;
  const collector = createExternalNormalV2ExactLogCollector({
    managementBaseUrl: 'https://management.example.invalid', storeRoot: diagnosticInputRoot,
    readManagementAuthInMemory: () => { authReads += 1; return { username: 'synthetic-user', password: 'synthetic-password' }; },
    fetchImpl: async (input) => {
      logGets += 1;
      const requestId = new URL(String(input)).searchParams.get('request_id');
      assert.ok(rawRows.some((row) => row.callerRequestId === requestId));
      return new Response(JSON.stringify({ data: [{ id: requestId, provider: 'fixture-provider',
        alias: 'fixture-reviewer', model: 'fixture-model', status: 'success' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const calls = rawRows.map((row) => ({ clientRequestIdSha256: createHash('sha256').update(row.callerRequestId).digest('hex'),
    bifrostLogRequestIdSha256: createHash('sha256').update(row.bifrostLogRequestId).digest('hex'),
    upstreamResponseRequestIdSha256: createHash('sha256').update(row.upstreamResponseRequestId).digest('hex'),
    requestedAlias: 'fixture-reviewer', requestedEffort: 'medium', startedAt: new Date().toISOString(),
    requestDigest: 'b'.repeat(64), httpStatus: 200, fetchFailureClass: null }));
  const capture = await collector({ phaseId: 'ws5-current-source-external-v2', planSha256: 'c'.repeat(64),
    artifactStoreRoot: diagnosticInputRoot, calls,
    stepReceipts: [{ stepId: 'v2-p2-first', runId, artifactReferences: [{ path: copiedRelativePath, sha256: sidecarSha256 }] }],
    deadlineAt: Date.now() + 30_000 });
  assert.equal(capture.status, 'captured');
  assert.equal(capture.artifactCount, 25);
  assert.equal(capture.rows.length, 25);
  assert.equal(authReads, 1);
  assert.equal(logGets, 25);
  const sanitizedOutputPath = path.join(outputRoot, 'capture-result.json');
  await writeFile(sanitizedOutputPath, JSON.stringify(capture), { mode: 0o600 });
  await chmod(sanitizedOutputPath, 0o600);
  const sanitizedBytes = await readFile(sanitizedOutputPath, 'utf8');
  assert.equal(rawRows.some((row) => sanitizedBytes.includes(row.callerRequestId)), false);
  assert.equal(rawRows.some((row) => sanitizedBytes.includes(row.upstreamResponseRequestId)), false);
  assert.notEqual(sourceRoot, diagnosticInputRoot);
  assert.notEqual(diagnosticInputRoot, outputRoot);
  assert.equal(createHash('sha256').update(await readFile(sourceSidecarPath)).digest('hex'), sidecarSha256);
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(diagnosticInputRoot, { recursive: true, force: true });
  await rm(outputRoot, { recursive: true, force: true });
});
