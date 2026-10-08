import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { canonicalJson } from '../../src/review/reviewCore';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { createBoundExternalNormalV2CaseExecutor, createPinnedWorkerImageExternalNormalV2Adapter,
  trustedPreparedBudget, validateExternalNormalV2PrivateBinding } from '../../src/qualification/normalEngineQualificationExternalV2';

const policyContent = JSON.stringify({ schema: 'exampleorg.review-policy.v1', review_yeti: {
  personas: 'security', profile: 'balanced', review_engine: 'composed', severity_policy: 'review-yeti-severity.v2',
  budget: { max_investigation_turns: 20 },
} });
const candidateSha = createHash('sha256').update(policyContent).digest('hex');
const configSha = '6'.repeat(64);
const centralConfigProjectionSha = '7'.repeat(64);
const inferenceBaseUrl = 'https://gateway.example.invalid/v1';
const testRouteAlias = 'fixture-reviewer';
const policySource = { repository: 'exampleorg/review-yeti-policy-fixture', repositoryId: 73011,
  sourceRef: 'a'.repeat(40), path: 'policy/review-policy-fixture.json',
  contentSha256: candidateSha };
const runtime = { sourceRevision: 'a'.repeat(40), workerImageDigest: `sha256:${'b'.repeat(64)}`, runtimeManifestSha256: 'c'.repeat(64) };
function bindings(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const source = { repositoryId: policySource.repositoryId, repository: policySource.repository, sha: policySource.sourceRef,
    path: policySource.path, contentDigest: candidateSha };
  const transport = { baseUrl: inferenceBaseUrl, model: testRouteAlias };
  const prepared = preparePublishingPolicy({ source, content: policyContent }, transport,
    { owner: 'exampleorg', repo: 'review-yeti-policy-fixture' });
  const config = prepared.config as unknown as Record<string, any>;
  config.review_configuration_receipt.effective.composed_budget = {
    central_policy_total_turns: 100,
    central_policy_max_tasks: 8,
    provider_attempt_budget: { capability_version: 'ReviewProviderAttemptBudget.v1', total_limit: 100,
      investigation_limit: 88, verifier_reserve: 12, operator_override_value: null },
  };
  return {
    ...overrides,
    NODE_ENV: 'test', OPENAI_BASE_URL: transport.baseUrl, OPENAI_API_KEY: 'qualification-test-key', REVIEW_MODEL: transport.model,
    REVIEW_PUBLICATION_MODE: 'disabled', REVIEW_RECEIPT_PATH: '/workspace/.review-yeti/normal-engine-qualification.json',
    REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest, REVIEW_CONFIG_DIGEST: configSha,
    REVIEW_PREPARED_CONFIG_JSON: JSON.stringify({ version: 'PreparedReviewExecution.v1', config, transport }),
    REVIEW_NORMAL_ENGINE_QUALIFICATION_SOURCE_REVISION: runtime.sourceRevision,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_WORKER_IMAGE_DIGEST: runtime.workerImageDigest,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256: runtime.runtimeManifestSha256,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_TARGET: policySource.repository,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_SELECTION_PURPOSE: 'qualification-only-target-binding',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPOSITORY_ID: String(policySource.repositoryId),
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_OWNER: 'exampleorg',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPO: 'review-yeti-policy-fixture',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REF: source.sha,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_PATH: source.path,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_SHA256: candidateSha,
  };
}

const initialEnv = bindings();
const privateBinding = {
  schemaVersion: 'ReviewYetiExternalNormalQualificationPrivateBinding.v1' as const,
  credentialBindingSha256: '0'.repeat(64),
  phaseRoot: { canonicalPath: path.resolve(tmpdir(), 'ws5-test-phase-root'),
    uid: process.getuid?.() ?? 1, gid: process.getgid?.() ?? 1, mode: 0o700 as const, initialEntryCount: 0 as const },
  sourceDescriptor: { ...policySource, candidateHead: 'e'.repeat(40), preparedFixtureReviewHead: 'f'.repeat(40) },
  transport: { selectedBaseUrl: inferenceBaseUrl, modelAlias: testRouteAlias },
  managementBaseUrl: 'https://management.example.invalid',
  policy: {
    candidateGitBlob: '8'.repeat(40), executionPlanFixtureSha256: '9'.repeat(64),
    executionPlanNormalizedSha256: 'a'.repeat(64), preparedExecutionFixtureSha256: 'b'.repeat(64),
    preparedExecutionManifestSha256: 'c'.repeat(64), preparedExecutionSha256: 'd'.repeat(64),
    syntheticProjectionFixtureSha256: 'e'.repeat(64), centralEffectiveConfigProjectionSha256: centralConfigProjectionSha,
    effectiveConfigSha256: configSha, effectivePolicySha256: initialEnv.REVIEW_POLICY_DIGEST!, v1Promotion: 'fixture-v1-promotion',
    policyInputDigests: { candidatePath: candidateSha, executionPlanFixturePath: '9'.repeat(64),
      preparedExecutionFixturePath: 'b'.repeat(64), syntheticProjectionPath: 'e'.repeat(64),
      preparedExecutionManifestPath: 'c'.repeat(64) },
    targetProjections: [73002, 73003, 73004].map((repositoryId) => ({ repositoryId,
      normalizedPlanSha256: 'a'.repeat(64), centralEffectiveConfigProjectionSha256: centralConfigProjectionSha,
      preparedExecutionSha256: 'd'.repeat(64), effectiveConfigSha256: configSha,
      effectivePolicySha256: initialEnv.REVIEW_POLICY_DIGEST!,
      preparedExecutionFile: `prepared-host/prepared-${repositoryId}-default.json` })),
  },
  runtime: { finalSourceRevision: runtime.sourceRevision, workerImageDigest: runtime.workerImageDigest,
    runtimeManifestSha256: runtime.runtimeManifestSha256 },
};

async function persistFakeReceipt(root: string, receipt: Record<string, any>): Promise<void> {
  const relative = path.join('normal-engine-qualification-store', receipt.runId, receipt.phase,
    receipt.target.caseId, 'receipt.json');
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(JSON.parse(canonicalJson(receipt)), null, 2)}\n`;
  await writeFile(absolute, body, { mode: 0o600 });
  await chmod(absolute, 0o600);
  const digest = createHash('sha256').update(body).digest('hex');
  await writeFile(absolute.replace(/\.json$/u, '.sha256'), `${digest}\n`, { mode: 0o600 });
}

const projection = {
  stepId: 'v2-p2-first', caseId: 'ws5-current-1dd-v2-p2',
  inputPath: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/p2.json',
  inputSha256: '4f476e36aa78b6788bb37c02ba5b2fae899c99eeba7d43dae399507cd93ed216', arm: 'p2-only',
  historyMode: 'complete empty context', targetRepositoryId: 73004,
  sourceBundleSha256: '99b707383ec16eea3ef81994c623e956f551a1e9d0b6acf2dd503afc5d41cfe1',
  runId: `nq_${'1'.repeat(32)}`, runtime,
  policy: { candidateHead: 'e'.repeat(40), candidateRawSha256: candidateSha, effectiveConfigSha256: configSha,
    effectivePolicySha256: privateBinding.policy.effectivePolicySha256,
    centralEffectiveConfigProjectionSha256: centralConfigProjectionSha,
    preparedExecutionSha256: privateBinding.policy.preparedExecutionSha256,
    preparedExecutionFile: 'prepared-host/prepared-73004-default.json', policySource,
    routeAlias: testRouteAlias, requestedEffort: 'medium', inferenceBaseUrl },
};

describe('current-source external v2 worker adapter', () => {
  it('rejects private binding source or transport that differs from the trusted prepared environment', () => {
    expect(() => validateExternalNormalV2PrivateBinding(privateBinding, bindings())).not.toThrow();
    expect(() => validateExternalNormalV2PrivateBinding({
      ...privateBinding, transport: { ...privateBinding.transport, selectedBaseUrl: 'https://attacker.example.invalid/v1' },
    }, bindings())).toThrow(/private_binding_environment_mismatch/u);
    expect(() => validateExternalNormalV2PrivateBinding({
      ...privateBinding, sourceDescriptor: { ...privateBinding.sourceDescriptor, repositoryId: 73012 },
    }, bindings())).toThrow(/private_binding_environment_mismatch/u);
    expect(() => validateExternalNormalV2PrivateBinding({ ...privateBinding, unexpectedSecretSelector: 'should-reject' }, bindings()))
      .toThrow(/private_binding_invalid/u);
  });

  it('binds the real single-case worker call and counts every fetch attempt at the fetch boundary', async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), 'external-v2-worker-store-'));
    await chmod(storeRoot, 0o700);
    const fakeFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    let passedEnv: NodeJS.ProcessEnv | undefined;
    const runCase = vi.fn(async (env, dependencies) => {
      passedEnv = env;
      await dependencies.providerFetchImplementation!(`${inferenceBaseUrl}/chat/completions`, {
        headers: { 'x-request-id': '123e4567-e89b-42d3-a456-426614174000' },
      });
      const receipt = {
        runId: projection.runId, phase: 'single', target: { caseId: projection.caseId },
        outcome: { workerOutcomeClass: 'completed_eligible', gateOutcomeClass: 'completed_eligible', agreement: 'agreement',
          canonicalEvidenceSha256: 'd'.repeat(64), gateDecisionSha256: 'e'.repeat(64) },
        history: { source: 'empty-qualification-context', loadStatus: 'complete', snapshotIdSha256: null,
          contextDigest: null, parentRunIdSha256: null },
        qualificationControl: 'none', preflight: null,
        testBudget: { resourceExhaustion: null },
        provider: { calls: [{ clientRequestIdSha256: createHash('sha256').update('123e4567-e89b-42d3-a456-426614174000').digest('hex'),
          bifrostLogRequestIdSha256: createHash('sha256').update('123e4567-e89b-42d3-a456-426614174000').digest('hex'),
          upstreamResponseRequestIdSha256: null, httpStatus: 200, fetchFailureClass: null,
          requestedAlias: 'fixture-reviewer', requestedEffort: 'medium', startedAt: '2026-10-07T20:00:00.000Z',
          tokenUsage: { prompt: 10, completion: 4, total: 14 } }] },
        terminal: { status: 'completed' },
      };
      await persistFakeReceipt(storeRoot, receipt);
      return receipt as never;
    });
    const executor = createBoundExternalNormalV2CaseExecutor({ baseEnv: bindings({ GH_TOKEN: 'must-not-forward',
      REVIEW_NORMAL_ENGINE_QUALIFICATION_EXPECTED_VERDICT: 'must-not-forward' }), fetchImplementation: fakeFetch as never,
      readInferenceKeyInMemory: () => 'qualification-test-key',
      runCase: runCase as never });
    let clientCallCount = 0;
    let blockedClientCallCount = 0;
    const receipt = await executor(projection, { signal: new AbortController().signal, deadlineAt: Date.now() + 240_000,
      artifactStoreRoot: storeRoot,
      captureOutsideChild: true, clientCallAllocation: 58,
      recordClientCall() { clientCallCount += 1; }, get clientCallCount() { return clientCallCount; },
      get blockedClientCallCount() { return blockedClientCallCount; } });

    expect(runCase).toHaveBeenCalledOnce();
    expect(fakeFetch).toHaveBeenCalledOnce();
    expect(clientCallCount).toBe(1);
    expect(passedEnv).not.toHaveProperty('GH_TOKEN');
    expect(passedEnv).not.toHaveProperty('REVIEW_NORMAL_ENGINE_QUALIFICATION_EXPECTED_VERDICT');
    expect(receipt).toMatchObject({ clientCalls: 1, terminalStatus: 'completed', providerCalls: [{
      requestedAlias: 'fixture-reviewer', requestedEffort: 'medium',
    }] });
    expect(receipt).toMatchObject({ outcome: { gateOutcomeClass: 'completed_eligible' }, qualificationControl: 'none',
      artifactReferences: [{ canonicalSha256: expect.any(String) }] });
    await rm(storeRoot, { recursive: true, force: true });
  });

  it('does not copy or read the provisioned inference key for the bounded provider-failure control', async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), 'external-v2-provider-failure-store-'));
    await chmod(storeRoot, 0o700);
    const env = bindings();
    Object.defineProperty(env, 'OPENAI_API_KEY', { enumerable: true, configurable: true,
      get() { throw new Error('provider-failure must not read the provisioned key'); } });
    const failureProjection = { ...projection, caseId: 'ws5-current-1dd-v2-provider-failure', arm: 'provider-failure',
      inputPath: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/provider_failure.json',
      inputSha256: '76278ffbbb439e4e4d7b77dabe6022c01cf2c33d61753127cc82c542a9d1e2bd' };
    let passedEnv: NodeJS.ProcessEnv | undefined;
    const runCase = vi.fn(async (childEnv) => {
      passedEnv = childEnv;
      const receipt = { runId: projection.runId, phase: 'single', target: { caseId: failureProjection.caseId },
        outcome: { workerOutcomeClass: 'incomplete', gateOutcomeClass: 'incomplete', agreement: 'incomplete',
          canonicalEvidenceSha256: null, gateDecisionSha256: 'f'.repeat(64) },
        history: { source: 'empty-qualification-context', loadStatus: 'complete', snapshotIdSha256: null,
          contextDigest: null, parentRunIdSha256: null },
        qualificationControl: 'bifrost-auth-rejection-invalid-inference-key', preflight: null,
        testBudget: { resourceExhaustion: null }, provider: { calls: [] }, terminal: { status: 'incomplete' } };
      await persistFakeReceipt(storeRoot, receipt);
      return receipt as never;
    });
    const executor = createBoundExternalNormalV2CaseExecutor({ baseEnv: env, fetchImplementation: vi.fn() as never,
      runCase: runCase as never });
    await executor(failureProjection, { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000,
      artifactStoreRoot: storeRoot,
      captureOutsideChild: true, clientCallAllocation: 1,
      recordClientCall() { throw new Error('provider-failure mock made no request'); }, get clientCallCount() { return 0; },
      get blockedClientCallCount() { return 0; } });
    expect(runCase).toHaveBeenCalledOnce();
    expect(passedEnv?.OPENAI_API_KEY).toBeUndefined();
    await rm(storeRoot, { recursive: true, force: true });
  });

  it('blocks attempt 59 synchronously at the fetch boundary and excludes it from outbound CID joins', async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), 'external-v2-cap-store-'));
    await chmod(storeRoot, 0o700);
    const outbound = new Set<string>();
    const runCase = vi.fn(async (_env, dependencies) => {
      const calls: Array<Record<string, unknown>> = [];
      for (let index = 1; index <= 59; index += 1) {
        const cid = `123e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`;
        const cidHash = createHash('sha256').update(cid).digest('hex');
        calls.push({ clientRequestIdSha256: cidHash, bifrostLogRequestIdSha256: cidHash,
          upstreamResponseRequestIdSha256: null, requestedAlias: 'fixture-reviewer',
          requestedEffort: 'medium', startedAt: '2026-10-07T20:00:00.000Z', httpStatus: 200,
          fetchFailureClass: null, tokenUsage: null });
        try {
        await dependencies.providerFetchImplementation!(`${inferenceBaseUrl}/chat/completions`, {
            headers: { 'x-request-id': cid },
          });
          outbound.add(cidHash);
        } catch { break; }
      }
      const receipt = { runId: projection.runId, phase: 'single', target: { caseId: projection.caseId },
        outcome: { workerOutcomeClass: 'incomplete', gateOutcomeClass: 'incomplete', agreement: 'incomplete',
          canonicalEvidenceSha256: null, gateDecisionSha256: 'f'.repeat(64) },
        history: { source: 'empty-qualification-context', loadStatus: 'complete', snapshotIdSha256: null,
          contextDigest: null, parentRunIdSha256: null },
        qualificationControl: 'none', preflight: null, testBudget: { resourceExhaustion: null },
        provider: { calls }, terminal: { status: 'incomplete' } };
      await persistFakeReceipt(storeRoot, receipt);
      return receipt as never;
    });
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    const executor = createBoundExternalNormalV2CaseExecutor({ baseEnv: bindings(), fetchImplementation: fetcher as never,
      readInferenceKeyInMemory: () => 'qualification-test-key',
      runCase: runCase as never });
    let clientCallCount = 0; let blockedClientCallCount = 0;
    const receipt = await executor(projection, { signal: new AbortController().signal, deadlineAt: Date.now() + 240_000,
      artifactStoreRoot: storeRoot,
      captureOutsideChild: true, clientCallAllocation: 58,
      recordClientCall() {
        if (clientCallCount >= 58) { blockedClientCallCount += 1; throw new Error('outer arm cap'); }
        clientCallCount += 1;
      }, get clientCallCount() { return clientCallCount; }, get blockedClientCallCount() { return blockedClientCallCount; } });
    expect(fetcher).toHaveBeenCalledTimes(58);
    expect(outbound.size).toBe(58);
    expect(receipt).toMatchObject({ clientCalls: 58, blockedClientCalls: 1, terminalStatus: 'incomplete' });
    expect((receipt.providerCalls as unknown[])).toHaveLength(58);
    expect(receipt.attestorRecordedCalls).toBe(59);
    await rm(storeRoot, { recursive: true, force: true });
  });

  it('fails closed unless the trusted prepared budget is 100 total including the 12-call verifier reserve', () => {
    expect(trustedPreparedBudget(bindings())).toEqual({ total: 100, investigation: 88, verifier: 12, maxTasks: 8 });
    const invalid = bindings();
    const prepared = JSON.parse(invalid.REVIEW_PREPARED_CONFIG_JSON!);
    prepared.config.review_configuration_receipt.effective.composed_budget.provider_attempt_budget.total_limit = 112;
    invalid.REVIEW_PREPARED_CONFIG_JSON = JSON.stringify(prepared);
    expect(() => trustedPreparedBudget(invalid)).toThrow('external_normal_v2_trusted_attempt_budget_mismatch');
  });

  it('launches bounded case children only from the pinned image with RO inputs and no host credentials', async () => {
    const policyRoot = await mkdtemp(path.join(tmpdir(), 'external-v2-policy-inputs-'));
    const phaseRoot = await mkdtemp(path.join(tmpdir(), 'external-v2-phase-output-'));
    await Promise.all([chmod(policyRoot, 0o700), chmod(phaseRoot, 0o700)]);
    const canonicalPolicyRoot = await realpath(policyRoot);
    const canonicalPhaseRoot = await realpath(phaseRoot);
    const imageRef = `ghcr.io/review-yeti-ai/review-yeti-worker@${runtime.workerImageDigest}`;
    const inspected: string[] = [];
    const dockerCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv; stdin: string }> = [];
    const preflightResult = { status: 'ready', mode: 'dns_tls_only', originSha256: createHash('sha256').update(inferenceBaseUrl).digest('hex'),
      sourceRevision: runtime.sourceRevision, workerImageDigest: runtime.workerImageDigest,
      runtimeManifestSha256: runtime.runtimeManifestSha256, resolvedAddressCount: 1,
      resolvedAddressSetSha256: '1'.repeat(64), tlsAuthorized: true, tlsProtocol: 'TLSv1.3',
      peerCertificateSha256: '2'.repeat(64), tlsAddressSha256: '5'.repeat(64), elapsedMs: 17 };
    const caseResult = { clientCalls: 0, blockedClientCalls: 0, terminalStatus: 'incomplete', receiptSha256: '3'.repeat(64),
      failureCode: 'worker_execution_failed', artifactReferences: [], providerCalls: [] };
    const spawnImplementation = ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(command).toBe('docker');
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: () => void };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => undefined;
      let stdin = '';
      child.stdin.on('data', (chunk: Buffer) => { stdin += chunk.toString('utf8'); });
      child.stdin.on('finish', () => {
        dockerCalls.push({ args, env: { ...options.env }, stdin });
        const isProbe = args.includes('--external-normal-v2-transport-preflight');
        child.stdout.end(`startup line ignored\n__EXTERNAL_NORMAL_V2_RESULT__${JSON.stringify(isProbe ? preflightResult : caseResult)}\n`);
        child.stdout.once('end', () => child.emit('close', 0));
      });
      return child;
    }) as never;
    try {
      const adapter = createPinnedWorkerImageExternalNormalV2Adapter({ policyInputRoot: policyRoot, baseEnv: bindings(), privateBinding,
        assertImageAvailable(ref) { inspected.push(ref); },
        readInferenceKeyInMemory() { throw new Error('auth-control must not read the inference key'); },
        spawnImplementation });
      const proof = await adapter.preflight({ phaseId: 'ws5-current-source-external-v2', phasePlanSha256: '4'.repeat(64),
        sourceRevision: runtime.sourceRevision, workerImageDigest: runtime.workerImageDigest,
        runtimeManifestSha256: runtime.runtimeManifestSha256, origin: inferenceBaseUrl,
        deadlineAt: Date.now() + 15_000, artifactStoreRoot: phaseRoot });
      expect(proof).toEqual(preflightResult);
      const failureProjection = { ...projection, arm: 'provider-failure',
        caseId: 'ws5-current-1dd-v2-provider-failure',
        inputPath: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/provider_failure.json',
        inputSha256: '76278ffbbb439e4e4d7b77dabe6022c01cf2c33d61753127cc82c542a9d1e2bd' };
      const result = await adapter.executeCase(failureProjection, { signal: new AbortController().signal,
        deadlineAt: Date.now() + 30_000, captureOutsideChild: true, artifactStoreRoot: phaseRoot,
        clientCallAllocation: 1, recordClientCall() { throw new Error('host must not proxy child HTTP attempts'); },
        get clientCallCount() { return 0; }, get blockedClientCallCount() { return 0; } });
      expect(result).toEqual(caseResult);
      expect(inspected).toEqual([imageRef]);
      expect(dockerCalls).toHaveLength(2);
      expect(dockerCalls[0].args).toContain('--rm');
      expect(dockerCalls[0].args).toContain('--pull=never');
      expect(dockerCalls[0].args).toContain('--read-only');
      expect(dockerCalls[0].args).toContain('bridge');
      expect(dockerCalls[1].args).toContain(`type=bind,source=${canonicalPolicyRoot},target=/phase-inputs,readonly`);
      expect(dockerCalls[1].args).toContain(`type=bind,source=${canonicalPhaseRoot},target=/phase`);
      expect(dockerCalls[1].args).not.toContain('qualification-test-key');
      expect(dockerCalls[1].env).not.toHaveProperty('KUBECONFIG');
      expect(dockerCalls[1].env.OPENAI_API_KEY).toBeUndefined();
      expect(dockerCalls[1].stdin).not.toContain('qualification-test-key');
      const normalAdapter = createPinnedWorkerImageExternalNormalV2Adapter({ policyInputRoot: policyRoot, baseEnv: bindings(), privateBinding,
        assertImageAvailable() {}, readInferenceKeyInMemory() { return 'private-test-key'; }, spawnImplementation });
      const normalResult = await normalAdapter.executeCase(projection, { signal: new AbortController().signal,
        deadlineAt: Date.now() + 240_000, captureOutsideChild: true, artifactStoreRoot: phaseRoot,
        clientCallAllocation: 58, recordClientCall() { throw new Error('host must not proxy child HTTP attempts'); },
        get clientCallCount() { return 0; }, get blockedClientCallCount() { return 0; } });
      expect(normalResult).toEqual(caseResult);
      const normalChild = dockerCalls[2];
      expect(normalChild.args).toContain('--env');
      expect(normalChild.args).toContain('OPENAI_API_KEY');
      expect(normalChild.args).not.toContain('private-test-key');
      expect(normalChild.env.OPENAI_API_KEY).toBe('private-test-key');
      expect(normalChild.env).not.toHaveProperty('credentialBindingSha256');
      expect(normalChild.stdin).not.toContain(privateBinding.credentialBindingSha256);
      expect(normalChild.stdin).not.toContain('private-test-key');
    } finally {
      await Promise.all([rm(policyRoot, { recursive: true, force: true }), rm(phaseRoot, { recursive: true, force: true })]);
    }
  });

  it('marks a terminated case child as possibly having sent requests when its final ledger is missing', async () => {
    const policyRoot = await mkdtemp(path.join(tmpdir(), 'external-v2-policy-interrupted-'));
    const phaseRoot = await mkdtemp(path.join(tmpdir(), 'external-v2-phase-interrupted-'));
    await Promise.all([chmod(policyRoot, 0o700), chmod(phaseRoot, 0o700)]);
    const spawnImplementation = (() => {
      const child = new EventEmitter() as EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; kill: () => boolean };
      child.pid = 4321;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => true;
      child.stdin.on('finish', () => {
        child.stdout.end();
        child.stdout.once('end', () => child.emit('close', 1));
      });
      return child;
    }) as never;
    try {
      const adapter = createPinnedWorkerImageExternalNormalV2Adapter({ policyInputRoot: policyRoot, privateBinding,
        baseEnv: bindings(), assertImageAvailable() {}, readInferenceKeyInMemory() { return 'private-test-key'; },
        spawnImplementation });
      await expect(adapter.executeCase(projection, { signal: new AbortController().signal,
        deadlineAt: Date.now() + 240_000, captureOutsideChild: true, artifactStoreRoot: phaseRoot,
        clientCallAllocation: 58, recordClientCall() {}, get clientCallCount() { return 0; },
        get blockedClientCallCount() { return 0; } })).rejects.toMatchObject({
        clientAttemptsMayHaveBeenSent: true,
      });
    } finally {
      await Promise.all([rm(policyRoot, { recursive: true, force: true }), rm(phaseRoot, { recursive: true, force: true })]);
    }
  });
});
