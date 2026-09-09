import { describe, expect, it } from 'vitest';
import { buildReviewJobProjection, buildRunSecretName, deriveRunSecretExecutionAttempt } from '../../src/k8s/reviewJobProjection';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { sha256 } from '../../src/review/reviewCore';
import { MAX_TERMINAL_DEADLINE_MS, MIN_TERMINAL_DEADLINE_MS, TERMINAL_DEADLINE_MS } from '../../src/config/terminalDeadline';

const receivedAt = Date.parse('2026-08-30T20:00:00.000Z');
const input = {
  runId: `run_${'1'.repeat(32)}`,
  deliveryId: 'actions:98765:2:123:42:head',
  repositoryId: 123,
  repo: 'calltelemetry/cisco-cdr',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  receivedAt,
  terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
  policyDigest: 'c'.repeat(64),
  configDigest: 'd'.repeat(64),
  publicationMode: 'disabled' as const,
  workerImage: `registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:${'e'.repeat(64)}`,
  namespace: 'ct-review-qualification',
};

function preparedInput() {
  const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
    personas: 'security,testing', budget: { max_investigation_turns: 3 },
  } });
  const prepared = preparePublishingPolicy({ content, source: {
    repositoryId: 456, repository: 'example/central-policy', sha: 'c'.repeat(40),
    path: 'policy/review.json', contentDigest: sha256(content),
  } }, { baseUrl: 'https://gateway.example.invalid/v1', model: 'review-model' });
  return { ...input, publicationMode: 'app-gate' as const,
    configDigest: prepared.policy.effectiveConfigDigest,
    preparedReview: JSON.stringify({ version: 'PreparedReviewExecution.v1', config: prepared.config, transport: prepared.transport }, null, 2) };
}

describe('prepared review projection transport', () => {
  it('preserves the exact envelope and otherwise leaves the legacy projection unchanged', () => {
    const request = preparedInput();
    const projection = buildReviewJobProjection(request, receivedAt + 60_000);
    const { preparedReview, ...legacyInput } = request;
    const legacy = buildReviewJobProjection(legacyInput, receivedAt + 60_000);
    expect(projection).toEqual({ ...legacy, spec: { ...legacy.spec, preparedReview } });
    expect(JSON.parse(JSON.stringify(projection)).spec.preparedReview).toBe(preparedReview);
    expect(legacy.spec).not.toHaveProperty('preparedReview');
  });

  it.each(['disabled', 'app-gate'] as const)('leaves prepared mode absent for legacy %s', (publicationMode) => {
    expect(buildReviewJobProjection({ ...input, publicationMode }, receivedAt + 60_000).spec).not.toHaveProperty('preparedReview');
  });

  it('accepts exactly 256 KiB and rejects one more byte without truncation', () => {
    const request = preparedInput();
    const exact = request.preparedReview + ' '.repeat(256 * 1024 - Buffer.byteLength(request.preparedReview));
    expect(buildReviewJobProjection({ ...request, preparedReview: exact }, receivedAt + 60_000).spec.preparedReview).toBe(exact);
    expect(() => buildReviewJobProjection({ ...request, preparedReview: exact + ' ' }, receivedAt + 60_000)).toThrow(/Prepared review execution/u);
  });

  it('enforces the UTF-8 byte limit rather than character count', () => {
    const request = preparedInput();
    const envelope = JSON.parse(request.preparedReview);
    envelope.config.path_instructions = [{ path: '**', instructions: 'é'.repeat(128 * 1024) }];
    const oversized = JSON.stringify(envelope);
    expect(oversized.length).toBeLessThan(256 * 1024);
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(256 * 1024);
    expect(() => buildReviewJobProjection({ ...request, preparedReview: oversized }, receivedAt + 60_000)).toThrow(/Prepared review execution/u);
  });

  it.each(['', ' ', '{', 'null', '[]', '"text"', '{}'])('rejects empty or malformed prepared JSON %j', (preparedReview) => {
    expect(() => buildReviewJobProjection({ ...preparedInput(), preparedReview }, receivedAt + 60_000)).toThrow(/Prepared review execution/u);
  });

  it.each([
    { version: 'PreparedReviewExecution.v2' }, { config: null }, { config: [] },
    { checkId: 4242 }, { token: 'synthetic-secret-must-not-cross' },
    { transport: { baseUrl: 'https://gateway.example.invalid/v1', model: 'review-model', apiKey: 'synthetic-secret-must-not-cross' } },
  ])('rejects an invalid or extra envelope field %j with a redacted error', (change) => {
    const request = preparedInput();
    const preparedReview = JSON.stringify({ ...JSON.parse(request.preparedReview), ...change });
    let error: unknown;
    try { buildReviewJobProjection({ ...request, preparedReview }, receivedAt + 60_000); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Prepared review execution does not match its admitted identity');
    expect((error as Error).stack).not.toContain('synthetic-secret-must-not-cross');
  });

  it('rejects config digest or stored transport mismatch', () => {
    const request = preparedInput();
    expect(() => buildReviewJobProjection({ ...request, configDigest: 'f'.repeat(64) }, receivedAt + 60_000)).toThrow(/Prepared review execution/u);
    const envelope = JSON.parse(request.preparedReview); envelope.transport.model = 'other-model';
    expect(() => buildReviewJobProjection({ ...request, preparedReview: JSON.stringify(envelope) }, receivedAt + 60_000)).toThrow(/Prepared review execution/u);
  });

  it('rejects nonpublishing and generic prepared workers', () => {
    const request = preparedInput();
    expect(() => buildReviewJobProjection({ ...request, publicationMode: 'disabled' }, receivedAt + 60_000)).toThrow(/prebaked app-gate/u);
    expect(() => buildReviewJobProjection({ ...request, runnerMode: 'generic', workerImage: 'node:24-bookworm-slim' }, receivedAt + 60_000)).toThrow(/prebaked app-gate/u);
  });
});

describe('shared run Secret name contract', () => {
  const baseName = `ct-review-run-${'1'.repeat(32)}`;

  // Mirrored by TestBuildWorkerJobRejectsLegacySecretSuffixBoundaries in Go.
  it.each(['-a0', '-a-1', '-anonsense', '-a2147483648', '-a+2', '-a01'])('rejects legacy suffix %s', (suffix) => {
    expect(deriveRunSecretExecutionAttempt(input.runId, baseName + suffix)).toBeUndefined();
  });

  it.each([['', 1], ['-a1', 1], ['-a2', 2], ['-a2147483647', 2_147_483_647]] as const)(
    'derives legacy suffix "%s" as %i', (suffix, attempt) => {
      expect(deriveRunSecretExecutionAttempt(input.runId, baseName + suffix)).toBe(attempt);
    },
  );

  it('binds even a valid suffix to its exact run', () => {
    expect(deriveRunSecretExecutionAttempt(`run_${'2'.repeat(32)}`, `${baseName}-a2`)).toBeUndefined();
    expect(deriveRunSecretExecutionAttempt('invalid', `${baseName}-a2`)).toBeUndefined();
    expect(deriveRunSecretExecutionAttempt(undefined, null)).toBeUndefined();
  });

  it('writes canonical names while retaining the legacy -a1 read alias', () => {
    expect(buildRunSecretName(input.runId, 1)).toBe(baseName);
    expect(buildRunSecretName(input.runId, 2)).toBe(`${baseName}-a2`);
    expect(buildRunSecretName(input.runId, 2_147_483_647)).toBe(`${baseName}-a2147483647`);
  });
});

describe('buildReviewJobProjection', () => {
  it('builds the exact deterministic nonpublishing PRReviewJob contract', () => {
    expect(buildReviewJobProjection(input, receivedAt + 60_000)).toEqual({
      apiVersion: 'review-yeti.ai/v1alpha2',
      kind: 'PRReviewJob',
      metadata: {
        name: `ct-review-${'1'.repeat(32)}`,
        namespace: 'ct-review-qualification',
        labels: {
          'app.kubernetes.io/name': 'review-yeti-worker',
          'review-yeti.ai/publication-mode': 'disabled',
          'review-yeti.ai/run-id': `run_${'1'.repeat(32)}`,
        },
      },
      spec: {
        runId: `run_${'1'.repeat(32)}`,
        deliveryId: input.deliveryId,
        repositoryId: 123,
        repo: 'calltelemetry/cisco-cdr',
        prNumber: 42,
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        receivedAt: '2026-08-30T20:00:00.000Z',
        terminalDeadline: new Date(receivedAt + TERMINAL_DEADLINE_MS).toISOString(),
        policyDigest: 'c'.repeat(64),
        configDigest: 'd'.repeat(64),
        publicationMode: 'disabled',
        workerImage: input.workerImage,
        runSecretName: `ct-review-run-${'1'.repeat(32)}`,
        runnerMode: 'prebaked',
      },
    });
  });

  it('accepts and projects public ghcr.io worker image reference', () => {
    const ghcrWorkerImage = `ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${'f'.repeat(64)}`;
    const projection = buildReviewJobProjection({ ...input, workerImage: ghcrWorkerImage }, receivedAt + 60_000);
    expect(projection.spec.workerImage).toBe(ghcrWorkerImage);
  });

  it('projects an app-gate publication mode onto the PRReviewJob contract', () => {
    const projection = buildReviewJobProjection({ ...input, publicationMode: 'app-gate' }, receivedAt + 60_000);
    expect(projection.metadata.labels['review-yeti.ai/publication-mode']).toBe('app-gate');
    expect(projection.spec.publicationMode).toBe('app-gate');
  });

  it('projects a new Kubernetes identity for a new execution attempt', () => {
    const retry = buildReviewJobProjection({ ...input, executionAttempt: 2 }, receivedAt + 60_000);
    expect(retry.metadata.name).toBe(`ct-review-${'1'.repeat(32)}-a2`);
    expect(retry.spec.runSecretName).toBe(`ct-review-run-${'1'.repeat(32)}-a2`);
    expect(retry.spec.executionAttempt).toBe(2);
    expect(retry.spec.runId).toBe(input.runId);
    expect(retry.spec.deliveryId).toBe(input.deliveryId);
  });

  it('projects an explicit unsuffixed first execution attempt', () => {
    const first = buildReviewJobProjection({ ...input, executionAttempt: 1 }, receivedAt + 60_000);
    expect(first.metadata.name).toBe(`ct-review-${'1'.repeat(32)}`);
    expect(first.spec.runSecretName).toBe(`ct-review-run-${'1'.repeat(32)}`);
    expect(first.spec.executionAttempt).toBe(1);
  });

  it('accepts the maximum execution attempt and preserves its attempt-scoped identity', () => {
    const maxAttempt = 2_147_483_647;
    const projection = buildReviewJobProjection({ ...input, executionAttempt: maxAttempt }, receivedAt + 60_000);
    expect(projection.metadata.name).toBe(`ct-review-${'1'.repeat(32)}-a${maxAttempt}`);
    expect(projection.spec.runSecretName).toBe(`ct-review-run-${'1'.repeat(32)}-a${maxAttempt}`);
    expect(projection.spec.executionAttempt).toBe(maxAttempt);
  });

  it('rejects unknown publication modes and deadline expansion before producing a projection', () => {
    expect(() => buildReviewJobProjection({ ...input, publicationMode: 'enabled' as any }, receivedAt + 60_000))
      .toThrow(/publication mode/i);
    expect(() => buildReviewJobProjection({ ...input, terminalDeadline: receivedAt + MAX_TERMINAL_DEADLINE_MS + 1 }, receivedAt + 60_000))
      .toThrow(/terminal deadline must be between/i);
    // The below-floor rejection is an independent branch from the above-ceiling one
    // (buildReviewJobProjection has its own copy of this check, separate from
    // reviewDispatchRepository's), so it needs its own direct assertion here too.
    expect(() => buildReviewJobProjection({ ...input, terminalDeadline: receivedAt + MIN_TERMINAL_DEADLINE_MS - 1 }, receivedAt + 60_000))
      .toThrow(/terminal deadline must be between/i);
    // A window that is neither a boundary nor the current TERMINAL_DEADLINE_MS --
    // simulating a run admitted before a config change -- must still project
    // cleanly. Derived relative to TERMINAL_DEADLINE_MS itself (not a literal) so
    // this is deterministic regardless of the ambient REVIEW_YETI_TERMINAL_DEADLINE_MS
    // the suite happened to load under: pick the midpoint on whichever side of
    // TERMINAL_DEADLINE_MS still has room, which always differs from it.
    const midWindow = TERMINAL_DEADLINE_MS >= MAX_TERMINAL_DEADLINE_MS
      ? Math.round((MIN_TERMINAL_DEADLINE_MS + TERMINAL_DEADLINE_MS) / 2)
      : Math.round((TERMINAL_DEADLINE_MS + MAX_TERMINAL_DEADLINE_MS) / 2);
    expect(midWindow).not.toBe(TERMINAL_DEADLINE_MS);
    expect(buildReviewJobProjection({ ...input, terminalDeadline: receivedAt + midWindow }, receivedAt + 60_000).spec.runId)
      .toBe(input.runId);
    expect(() => buildReviewJobProjection(input, input.terminalDeadline - 119_999))
      .toThrow(/120 seconds/i);
    expect(buildReviewJobProjection(input, input.terminalDeadline - 120_000).metadata.name)
      .toBe(`ct-review-${'1'.repeat(32)}`);
  });

  it.each([
    `run_${'1'.repeat(31)}`,
    `run_${'A'.repeat(32)}`,
    `job_${'1'.repeat(32)}`,
  ])('rejects malformed run identity %s', (runId) => {
    expect(() => buildReviewJobProjection({ ...input, runId }, receivedAt + 60_000)).toThrow(/run id/i);
  });

  it.each(['', 'x'.repeat(513)])('rejects invalid delivery identity', (deliveryId) => {
    expect(() => buildReviewJobProjection({ ...input, deliveryId }, receivedAt + 60_000)).toThrow(/delivery id/i);
  });

  it.each([
    'registry.digitalocean.com/calltelemetry/review-yeti-worker:latest',
    `registry.digitalocean.com/calltelemetry/review-yeti-worker:v1@sha256:${'e'.repeat(64)}`,
    `registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:${'E'.repeat(64)}`,
    `review-yeti-worker@sha256:${'e'.repeat(63)}`,
  ])('rejects a worker image that is not a strict digest-only reference: %s', (workerImage) => {
    expect(() => buildReviewJobProjection({ ...input, workerImage }, receivedAt + 60_000))
      .toThrow(/digest-pinned worker image/i);
  });

  it('rejects a digest-pinned image from an untrusted repository', () => {
    const workerImage = `attacker.example/review-yeti-worker@sha256:${'e'.repeat(64)}`;
    expect(() => buildReviewJobProjection({ ...input, workerImage }, receivedAt + 60_000))
      .toThrow(/trusted worker image repository/i);
  });

  it('rejects malformed immutable review identity', () => {
    expect(() => buildReviewJobProjection({ ...input, headSha: 'main' }, receivedAt + 60_000)).toThrow(/head sha/i);
    expect(() => buildReviewJobProjection({ ...input, baseSha: 'main' }, receivedAt + 60_000)).toThrow(/base sha/i);
    expect(() => buildReviewJobProjection({ ...input, policyDigest: 'c'.repeat(63) }, receivedAt + 60_000)).toThrow(/policy digest/i);
    expect(() => buildReviewJobProjection({ ...input, configDigest: 'd'.repeat(63) }, receivedAt + 60_000)).toThrow(/config digest/i);
    expect(() => buildReviewJobProjection({ ...input, repo: '../other' }, receivedAt + 60_000)).toThrow(/repository/i);
    expect(() => buildReviewJobProjection({ ...input, namespace: 'INVALID_NS' }, receivedAt + 60_000)).toThrow(/namespace/i);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('rejects invalid execution attempt %s', (executionAttempt) => {
    expect(() => buildReviewJobProjection({ ...input, executionAttempt }, receivedAt + 60_000))
      .toThrow(/execution attempt/i);
  });

  it('rejects projection before the authenticated admission receipt time', () => {
    expect(() => buildReviewJobProjection(input, receivedAt - 1)).toThrow(/cannot precede admission receipt/i);
  });

  it('rejects non-finite projection timestamps', () => {
    expect(() => buildReviewJobProjection({ ...input, receivedAt: Number.POSITIVE_INFINITY }, receivedAt + 60_000))
      .toThrow(/timestamps must be finite/i);
    expect(() => buildReviewJobProjection({ ...input, terminalDeadline: Number.NaN }, receivedAt + 60_000))
      .toThrow(/timestamps must be finite/i);
    expect(() => buildReviewJobProjection(input, Number.POSITIVE_INFINITY)).toThrow(/timestamps must be finite/i);
  });

  it.each([
    ['repository id', { repositoryId: 0 }],
    ['repository id', { repositoryId: 1.5 }],
    ['pull request number', { prNumber: 0 }],
    ['pull request number', { prNumber: 1.5 }],
  ])('rejects invalid numeric %s', (field, override) => {
    expect(() => buildReviewJobProjection({ ...input, ...override }, receivedAt + 60_000))
      .toThrow(new RegExp(field, 'i'));
  });

  it('does not project caller-supplied secret material', () => {
    const projection = buildReviewJobProjection({
      ...input,
      githubAppPrivateKey: 'private-key-must-not-cross',
      providerApiKey: 'provider-key-must-not-cross',
      installationToken: 'installation-token-must-not-cross',
      callbackToken: 'callback-token-must-not-cross',
    } as any, receivedAt + 60_000);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('must-not-cross');
    expect(serialized).not.toMatch(/privateKey|providerApiKey|installationToken|callbackToken/u);
  });
});
