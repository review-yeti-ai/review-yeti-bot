import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyQualificationFixtureAllowlist } from '../../scripts/normal-engine-qualification-fixtures.mjs';
import { createExternalNormalV2ExactLogCollector } from '../../scripts/ws5-external-bifrost-log-collector.mjs';
import { pathToFileURL } from 'node:url';

const runnerUrl = pathToFileURL(new URL('../../scripts/ws5-external-normal-v2.mjs', import.meta.url).pathname);
const runner = await import(runnerUrl.href).catch(() => null);

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

test('ships only the exact new synthetic v2 source inputs into the worker image', async () => {
  const root = new URL('../../', import.meta.url).pathname;
  const rows = await verifyQualificationFixtureAllowlist(root);
  const workerRows = await verifyQualificationFixtureAllowlist(root,
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/phase-plan.json']);
  const expected = new Map([
    ['eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/phase-plan.json',
      '0b7650472ee57c906b7a022cb3ee213644acc80cca72c44ab171ed4f72d96733'],
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
  const actual = new Map(rows.map((row) => [row.path, row.actualSha256]));
  for (const [path, digest] of expected) assert.equal(actual.get(path), digest, path);
  assert.equal(rows.length, 17, 'the host validates the complete pinned fixture set');
  assert.equal(workerRows.length, 16, 'the image stages every pinned source input except the host-only phase plan');
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
  const repositoryRoot = new URL('../../', import.meta.url).pathname;
  const template = JSON.parse(await readFile(path.join(repositoryRoot, 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/phase-plan.json')));
  const plan = runner.bindExternalNormalV2PrivateInputs(template, binding);
  const pinnedRootSha = createHash('sha256').update(binding.phaseRoot.canonicalPath).digest('hex');
  const tuple = runner.buildExternalNormalV2AuthorizationTuple(plan, '5'.repeat(64), pinnedRootSha,
    '0'.repeat(64), pinnedRootSha, binding);
  assert.throws(() => runner.validateExternalNormalV2PrivateBinding({
    ...binding, runtime: { finalSourceRevision: binding.runtime.finalSourceRevision,
      workerImageDigest: binding.runtime.workerImageDigest, runtimeManifestSha256: binding.runtime.runtimeManifestSha256 },
  }), /private_binding_invalid/u);
  assert.throws(() => runner.validateExternalNormalV2PrivateBinding({
    ...binding, runtime: { ...binding.runtime, publicationAttestationSha256: 'invalid' },
  }), /private_binding_invalid/u);
  const changedAttestationBinding = { ...binding,
    runtime: { ...binding.runtime, publicationAttestationSha256: '4'.repeat(64) } };
  const changedAttestationPlan = runner.bindExternalNormalV2PrivateInputs(template, changedAttestationBinding);
  const changedAttestationTuple = runner.buildExternalNormalV2AuthorizationTuple(changedAttestationPlan,
    '5'.repeat(64), pinnedRootSha, '0'.repeat(64), pinnedRootSha, changedAttestationBinding);
  assert.notEqual(changedAttestationTuple.privateBindingSha256, tuple.privateBindingSha256);
  assert.throws(() => runner.buildExternalNormalV2AuthorizationTuple({
    ...plan, policy: { ...plan.policy, effectiveConfigSha256: '0'.repeat(64) },
  }, '5'.repeat(64), pinnedRootSha, '0'.repeat(64), pinnedRootSha, binding), /private_binding_plan_mismatch/u);
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
    '0'.repeat(64), '6'.repeat(64), binding);
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
      runtimeManifestSha256: 'd'.repeat(64) } };
  const proof = { status: 'ready', mode: 'dns_tls_only', originSha256: createHash('sha256')
    .update(plan.policy.inferenceBaseUrl).digest('hex'), sourceRevision: plan.runtime.finalSourceRevision,
    workerImageDigest: plan.runtime.workerImageDigest, runtimeManifestSha256: plan.runtime.runtimeManifestSha256,
    resolvedAddressCount: 1, resolvedAddressSetSha256: 'e'.repeat(64), tlsAuthorized: true,
    tlsProtocol: 'TLSv1.3', peerCertificateSha256: 'f'.repeat(64), tlsAddressSha256: '1'.repeat(64), elapsedMs: 250 };
  assert.equal(runner.validateExternalNormalV2TransportPreflight(plan, proof).status, 'ready');
  assert.equal(runner.validateExternalNormalV2TransportPreflight(plan,
    { ...proof, tlsAuthorized: false }).status, 'unavailable');
  assert.equal(runner.validateExternalNormalV2TransportPreflight(plan,
    { ...proof, mode: 'http_probe' }).status, 'unavailable');
  assert.equal(runner.validateExternalNormalV2TransportPreflight(plan,
    { ...proof, sourceRevision: 'a'.repeat(40) }).status, 'unavailable');
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
    bifrostLogStatus: 'success', provider: 'provider-a', bifrostAlias: 'fixture-reviewer',
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
  assert.equal(runner.validateCapturedRouteIdentity(calls, rows, 'fixture-reviewer').status, 'observed');
  assert.throws(() => runner.validateCapturedRouteIdentity(calls,
    [rows[0], { ...rows[1], bifrostAlias: 'other-route' }], 'fixture-reviewer'), /route_identity_not_proven/u);
  assert.notEqual(result.requestLedgerSha256, result.upstreamLedgerSha256);
  assert.notEqual(result.tokenLedgerSha256, result.actualBilledLedgerSha256);
  assert.throws(() => runner.validateExactLogLedger(calls, { status: 'captured', rows: rows.slice(1) }), /exact_log_rows_missing/u);
  assert.throws(() => runner.validateExactLogLedger(calls, { status: 'captured', rows: [rows[0], { ...rows[1], clientRequestIdSha256: '9'.repeat(64) }] }),
    /cid_join_mismatch/u);
  assert.throws(() => runner.validateExactLogLedger(calls, { status: 'captured', rows: [rows[0], { ...rows[1], exactRowCount: 2 }] }),
    /row_invalid_or_ambiguous/u);
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
    const collector = createExternalNormalV2ExactLogCollector({ storeRoot: root,
      managementBaseUrl: 'https://management.example.invalid',
      readManagementAuthInMemory: () => ({ username: 'u', password: 'p' }),
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: rows[0].callerRequestId,
        provider: 'provider-a', alias: 'fixture-reviewer', model: 'model-a', status: 'success' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }) });
    const recoveredCapture = await collector({ phaseId: 'ws5-current-source-external-v2', planSha256: 'b'.repeat(64),
      artifactStoreRoot: root, calls: recovered.calls,
      stepReceipts: [{ stepId: 'v2-p2-first', runId, artifactReferences: [recovered.sidecarReference] }],
      deadlineAt: Date.now() + 10_000 });
    assert.equal(recoveredCapture.status, 'captured', JSON.stringify(recoveredCapture));
    assert.equal(recoveredCapture.rows[0].bifrostAlias, 'fixture-reviewer');
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
