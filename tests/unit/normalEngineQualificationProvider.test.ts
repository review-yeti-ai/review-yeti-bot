import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OpenRouterRequest } from '../../src/gateway/openRouterClient';
import {
  NORMAL_ENGINE_PROVIDER_CAPTURE_HEADER_NAMES,
  NormalEngineQualificationProviderAttestor,
  normalEngineProviderCaptureV1Schema,
  type NormalEngineQualificationProviderRunContext,
} from '../../src/qualification/normalEngineQualificationProvider';
import type { NormalEngineProviderCaptureBinding } from '../../src/qualification/normalEngineQualification';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const binding: NormalEngineProviderCaptureBinding = {
  runId: 'nq_0123456789abcdef0123456789abcdef',
  phase: 'single',
  caseId: 'ws5-p2-display-sort-v1',
  runtime: {
    sourceRevision: '1'.repeat(40),
    workerImageDigest: `sha256:${'2'.repeat(64)}`,
    runtimeManifestSha256: '3'.repeat(64),
  },
  target: {
    kind: 'public-synthetic-fixture',
    repositoryId: 73004,
    repository: 'synthetic/fixture-display-sort',
    prNumber: 43,
    caseId: 'ws5-p2-display-sort-v1',
    bundleVersion: 'WS5P2DisplaySortBundle.v1',
    bundleSha256: '4'.repeat(64),
    inputSha256: '5'.repeat(64),
    baseSha: '6'.repeat(40),
    headSha: '7'.repeat(40),
    diffSha256: '8'.repeat(64),
  },
  policy: {
    targetRepository: 'synthetic/policy-target',
    selectionPurpose: 'qualification-only-target-binding',
    configurationVariant: 'prepared-policy-default-v1',
    source: {
      repositoryId: 73099,
      owner: 'synthetic',
      repo: 'policy-target',
      ref: '9'.repeat(40),
      path: 'policy/review-yeti.json',
      contentSha256: 'a'.repeat(64),
    },
    effectivePolicyDigest: 'b'.repeat(64),
    effectiveConfigDigest: 'c'.repeat(64),
  },
  groundedEvidenceSemanticsVersion: 'GroundedReviewEvidenceSemantics.v2',
};

function request(model: string, reasoningEffort?: OpenRouterRequest['reasoningEffort'], maxTokens?: number): OpenRouterRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'The request prompt is private and must not be captured.' }],
    timeoutMs: 1_000,
    stream: true,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

function routeBinding(findingFingerprint: string, selectedModel: string): NonNullable<NormalEngineQualificationProviderRunContext['routeBinding']> {
  return {
    findingFingerprint,
    severity: 'P1',
    purpose: 'primary',
    requestedRole: 'primary',
    appliedRole: 'primary',
    configuredAlternateModel: null,
    selectedModel,
  };
}

describe('normal engine qualification provider capture', () => {
  it('binds concurrent calls to dispatch order, hashes only the exact body, and joins CIDs to provider receipts', async () => {
    const completionOrder: string[] = [];
    const attestor = new NormalEngineQualificationProviderAttestor(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, input === 'slow' ? 25 : 0));
      completionOrder.push(String(input));
      return new Response('response-body-must-not-be-captured', {
        status: 200,
        headers: {
          'x-bifrost-provider': input === 'slow' ? 'provider/luna' : 'provider/max',
          'x-bifrost-routing-info-is-fallback': 'false',
          'x-private-response-header': 'must-not-be-captured',
        },
      });
    }, () => inputIds.shift()!);
    const callerBinding = structuredClone(binding);
    attestor.bindCaptureContext(callerBinding);
    const expectedBinding = structuredClone(callerBinding);
    callerBinding.target.diffSha256 = 'd'.repeat(64);
    callerBinding.policy.effectivePolicyDigest = 'e'.repeat(64);
    callerBinding.policy.effectiveConfigDigest = 'f'.repeat(64);
    const bodyA = '{"model":"bifrost/luna","messages":[{"content":"prompt-secret-λ"}],"reasoning_content":"hidden-reasoning-secret","authorization":"body-secret"}';
    const bodyB = '{"model":"bifrost/max","messages":[{"content":"prompt-secret-max"}]}';

    await Promise.all([
      attestor.run(request('bifrost/luna', 'low', 1_234),
        () => attestor.fetch('slow', { method: 'POST', headers: { authorization: 'Bearer auth-header-secret' }, body: bodyA }),
        { routeBinding: routeBinding(`fp1_${'1'.repeat(24)}`, 'bifrost/luna') }),
      attestor.run(request('bifrost/max', 'max', 2_345),
        () => attestor.fetch('fast', { method: 'POST', body: bodyB }),
        { routeBinding: routeBinding(`fp1_${'2'.repeat(24)}`, 'bifrost/max') }),
    ]);

    const capture = attestor.getCapture(expectedBinding);
    expect(completionOrder).toEqual(['fast', 'slow']);
    expect(capture.target.diffSha256).toBe(expectedBinding.target.diffSha256);
    expect(capture.policy.effectivePolicyDigest).toBe(expectedBinding.policy.effectivePolicyDigest);
    expect(capture.policy.effectiveConfigDigest).toBe(expectedBinding.policy.effectiveConfigDigest);
    expect(capture.requests.map((row) => row.physicalOrdinal)).toEqual([1, 2]);
    expect(capture.requests.map((row) => row.cidSha256)).toEqual(inputIdDigests);
    expect(capture.requests.map((row) => row.body.sha256)).toEqual([sha256(bodyA), sha256(bodyB)]);
    expect(capture.requests.map((row) => row.body.byteCount)).toEqual([
      Buffer.byteLength(bodyA, 'utf8'), Buffer.byteLength(bodyB, 'utf8'),
    ]);
    expect(capture.requests.map((row) => [row.requestedModel.value, row.requestedEffort.value, row.outputCap.value])).toEqual([
      ['bifrost/luna', 'low', 1_234], ['bifrost/max', 'max', 2_345],
    ]);
    expect(capture.requests.map((row) => row.routeBinding.findingFingerprint.value)).toEqual([
      `fp1_${'1'.repeat(24)}`, `fp1_${'2'.repeat(24)}`,
    ]);
    expect(capture.requests[0]?.responseHeaders['x-bifrost-provider']?.value).toBe('provider/luna');
    expect(Object.keys(capture.requests[0]!.responseHeaders)).toEqual(NORMAL_ENGINE_PROVIDER_CAPTURE_HEADER_NAMES);
    expect(capture.requests[0]!.responseHeaders).not.toHaveProperty('x-private-response-header');

    const callsByCid = new Map(attestor.snapshot().map((call) => [call.clientRequestIdSha256, call]));
    for (const row of capture.requests) {
      expect(callsByCid.get(row.cidSha256)?.clientRequestIdSha256).toBe(row.cidSha256);
    }
    const privateIdsByDigest = new Map(attestor.privateIdentifiers().map((row) => [
      sha256(row.callerRequestId), row,
    ]));
    expect(capture.requests.every((row) => privateIdsByDigest.has(row.cidSha256))).toBe(true);
    expect(capture.requests.every((row) => row.logicalCallIdSha256.value === null
      && row.logicalCallIdSha256.unavailableReason !== null)).toBe(true);

    const serialized = JSON.stringify(capture);
    for (const privateText of [bodyA, bodyB, 'prompt-secret-λ', 'prompt-secret-max', 'hidden-reasoning-secret',
      'body-secret', 'auth-header-secret',
      'response-body-must-not-be-captured', 'must-not-be-captured']) {
      expect(serialized).not.toContain(privateText);
    }
    expect(Object.keys(capture.requests[0]!)).not.toContain('bodyText');
    expect(() => normalEngineProviderCaptureV1Schema.parse({ ...capture, rawPrompt: 'forbidden' })).toThrow();
    const wrongTarget = structuredClone(expectedBinding);
    wrongTarget.target.headSha = 'd'.repeat(40);
    const wrongPolicy = structuredClone(expectedBinding);
    wrongPolicy.policy.effectivePolicyDigest = 'e'.repeat(64);
    const wrongConfig = structuredClone(expectedBinding);
    wrongConfig.policy.effectiveConfigDigest = 'f'.repeat(64);
    expect(() => attestor.getCapture(wrongTarget)).toThrow('normal_engine_qualification_provider_capture_binding_mismatch');
    expect(() => attestor.getCapture(wrongPolicy)).toThrow('normal_engine_qualification_provider_capture_binding_mismatch');
    expect(() => attestor.getCapture(wrongConfig)).toThrow('normal_engine_qualification_provider_capture_binding_mismatch');
    expect(() => attestor.getCapture(callerBinding)).toThrow('normal_engine_qualification_provider_capture_binding_mismatch');
    expect(() => attestor.bindCaptureContext(expectedBinding)).toThrow('normal_engine_qualification_provider_capture_context_must_be_bound_before_dispatch');
  });

  it('records each failed and retried physical fetch without treating the retry as a logical completion', async () => {
    let attempts = 0;
    const attestor = new NormalEngineQualificationProviderAttestor(async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('network detail must not be captured');
        Object.defineProperty(error, 'cause', { value: { code: 'ECONNRESET' } });
        throw error;
      }
      return new Response('rejected-response-body', { status: 401 });
    }, () => inputIds.shift()!);
    attestor.bindCaptureContext(structuredClone(binding));

    await attestor.run(request('bifrost/max'), async () => {
      try {
        await attestor.fetch('gateway', { method: 'POST', body: '{"messages":[{"content":"retry-secret"}]}' });
      } catch { /* The modeled caller retries the same logical operation once. */ }
      return attestor.fetch('gateway', { method: 'POST', body: '{"messages":[{"content":"retry-secret"}]}' });
    });

    const capture = attestor.getCapture();
    expect(attempts).toBe(2);
    expect(capture.requests.map((row) => row.physicalOrdinal)).toEqual([1, 2]);
    expect(capture.requests.map((row) => row.status)).toEqual(['fetch_failed', 'response_received']);
    expect(capture.requests.map((row) => row.httpStatus.value)).toEqual([null, 401]);
    expect(capture.requests.map((row) => row.fetchFailureClass.value)).toEqual(['connection', 'http_error']);
    expect(capture.requests[0]!.httpStatus.unavailableReason).not.toBeNull();
    expect(JSON.stringify(capture)).not.toContain('network detail');
    expect(JSON.stringify(capture)).not.toContain('retry-secret');
    expect(JSON.stringify(capture)).not.toContain('rejected-response-body');
  });

  it('marks route fields and logical call IDs unavailable without inferring them from model or response headers', async () => {
    const attestor = new NormalEngineQualificationProviderAttestor(async () => new Response('model response', {
      status: 200,
      headers: { 'x-bifrost-original-model': 'bifrost/max', 'x-bifrost-resolved-model': 'provider/max' },
    }), () => inputIds.shift()!);
    attestor.bindCaptureContext(structuredClone(binding));

    await attestor.run(request('bifrost/max'), () => attestor.fetch('gateway', {
      method: 'POST', body: '{"model":"bifrost/max","messages":[{"content":"route-secret"}]}',
    }));

    const row = attestor.getCapture().requests[0]!;
    expect(row.requestedModel).toMatchObject({ value: 'bifrost/max', unavailableReason: null });
    expect(row.routeBinding.selectedModel).toMatchObject({ value: null, unavailableReason: expect.any(String) });
    expect(row.routeBinding.findingFingerprint).toMatchObject({ value: null, unavailableReason: expect.any(String) });
    expect(row.logicalCallIdSha256).toMatchObject({ value: null, unavailableReason: expect.any(String) });
    expect(JSON.stringify(row)).not.toContain('route-secret');
  });

  it('reports absent and non-string request bodies with reasons while retaining dispatch ordinals and CID hashes', async () => {
    const attestor = new NormalEngineQualificationProviderAttestor(async () => new Response(null, { status: 204 }), () => inputIds.shift()!);
    attestor.bindCaptureContext(structuredClone(binding));
    await Promise.all([
      attestor.run(request('bifrost/luna'), () => attestor.fetch('non-string', { method: 'POST', body: new Uint8Array([1, 2, 3]) })),
      attestor.run(request('bifrost/max'), () => attestor.fetch('absent', { method: 'POST' })),
    ]);
    const capture = attestor.getCapture();
    expect(capture.requests.map((row) => row.physicalOrdinal)).toEqual([1, 2]);
    expect(capture.requests.map((row) => row.body)).toEqual([
      { status: 'unavailable', sha256: null, byteCount: null, unavailableReason: 'init_body_not_string' },
      { status: 'unavailable', sha256: null, byteCount: null, unavailableReason: 'init_body_absent' },
    ]);
    expect(capture.requests.every((row) => /^[a-f0-9]{64}$/u.test(row.cidSha256))).toBe(true);
    expect(capture.requests.every((row) => attestor.privateIdentifiers().some((privateRow) =>
      sha256(privateRow.callerRequestId) === row.cidSha256))).toBe(true);
  });

  it('rejects posthoc context after a run or fetch so an unbound receipt cannot be relabeled as qualified', async () => {
    const attestor = new NormalEngineQualificationProviderAttestor(async () => new Response(null, { status: 204 }), () => inputIds.shift()!);
    await attestor.run(request('bifrost/max'), async () => undefined);

    expect(() => attestor.bindCaptureContext(structuredClone(binding)))
      .toThrow('normal_engine_qualification_provider_capture_context_must_be_bound_before_dispatch');
    expect(() => attestor.getCapture(binding))
      .toThrow('normal_engine_qualification_provider_capture_context_not_bound_before_dispatch');

    const fetchAttestor = new NormalEngineQualificationProviderAttestor(async () => new Response(null, { status: 204 }));
    await expect(fetchAttestor.fetch('gateway')).rejects.toThrow('normal_engine_qualification_unbound_provider_call');
    expect(() => fetchAttestor.bindCaptureContext(structuredClone(binding)))
      .toThrow('normal_engine_qualification_provider_capture_context_must_be_bound_before_dispatch');
  });
});

const inputIds = [
  '123e4567-e89b-42d3-a456-426614174000',
  '123e4567-e89b-42d3-a456-426614174001',
  '123e4567-e89b-42d3-a456-426614174002',
  '123e4567-e89b-42d3-a456-426614174003',
  '123e4567-e89b-42d3-a456-426614174004',
  '123e4567-e89b-42d3-a456-426614174005',
  '123e4567-e89b-42d3-a456-426614174006',
];
const inputIdDigests = inputIds.slice(0, 2).map(sha256);
