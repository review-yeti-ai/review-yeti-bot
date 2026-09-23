import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredReviewGate } from '../../src/persistence/reviewGateRepository';
import { AuthoritativeReviewReader } from '../../src/github/authoritativeReviewReader';
import { AuthoritativePublishingResolver } from '../../src/review/authoritativePublishingResolver';
import { createAuthoritativeCompletionContext, type AuthoritativeCompletionContextOptions } from '../../src/review/authoritativeCompletionContext';
import { buildAuthoritativeReviewIdentity } from '../../src/review/authoritativeReviewIdentity';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { sha256 } from '../../src/review/reviewCore';
import { deriveCanonicalWorkerReviewEvidence } from '../../src/review/workerReviewCompletion';
import { evaluateReviewGate } from '../../src/review/reviewGatePolicy';
import { TrustedCompletionResolutionError, isDeterministicCompletionFailure }
  from '../../src/review/workerCompletionPersistenceError';
import * as personaApplicability from '../../src/review/personaApplicability';

// Pass-through wrapper so a test can observe the options the service hands to
// the shared applicability decision (REL-1058). Behaviour is the real one.
vi.mock('../../src/review/personaApplicability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/review/personaApplicability')>();
  return { ...actual, resolveReviewApplicability: vi.fn(actual.resolveReviewApplicability) };
});

const target = { repositoryId: 123, owner: 'example', repo: 'candidate', prNumber: 42,
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
const current = { ...target, open: true, draft: false };
const diff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
const privateText = 'ghs_SYNTHETIC_PRIVATE_CONTEXT_MARKER';
function policyFile(turns = 3, personas = 'security,testing') {
  const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
    personas, budget: { max_investigation_turns: turns },
  } });
  return { content, source: { repositoryId: 456, repository: 'example/central-policy',
    sha: 'c'.repeat(40), path: 'policy/review.json', contentDigest: sha256(content) } };
}
function prepared(turns = 3, personas = 'security,testing') {
  return preparePublishingPolicy(policyFile(turns, personas),
  { baseUrl: 'https://gateway.example.invalid/v1', model: 'review-model' });
}
function resolution(policy = prepared()) {
  return { current: { ...current }, prepared: policy,
    identity: buildAuthoritativeReviewIdentity({ requested: target, current, policy: policy.policy }) };
}
function fixture(overrides: Partial<AuthoritativeCompletionContextOptions> = {}, stored = prepared()) {
  const refreshed = structuredClone(stored);
  const gate: StoredReviewGate = {
    coordinates: { ...target, runId: `run_${'1'.repeat(32)}`, policyDigest: stored.policy.effectivePolicyDigest,
      attemptId: `run_${'1'.repeat(32)}-g0-e2`, executionAttempt: 2 },
    reviewGeneration: 0, expectedAppId: 1234, externalId: 'service-gate', checkId: 456,
    creationState: 'bound', desiredState: 'in_progress', desiredVersion: 1, publishedVersion: 1, current: true,
  };
  const getStoredPrepared = vi.fn<AuthoritativeCompletionContextOptions['getStoredPrepared']>(async () => stored);
  const currentCandidate = vi.fn(async () => ({ ...current }));
  const exactCurrentDiff = vi.fn<AuthoritativeReviewReader['exactCurrentDiff']>(async () => ({ current: { ...current }, diff, expectedFileCount: 1 }));
  const readerFactory = vi.fn<AuthoritativeCompletionContextOptions['readerFactory']>(async () => ({ currentCandidate, exactCurrentDiff }));
  const resolve = vi.fn<AuthoritativeCompletionContextOptions['publishingResolver']['resolve']>(async () => resolution(refreshed));
  const options = { getStoredPrepared, readerFactory, publishingResolver: { resolve }, ...overrides };
  return { context: createAuthoritativeCompletionContext(options), options, gate, stored,
    getStoredPrepared, currentCandidate, exactCurrentDiff, readerFactory, resolve };
}
async function rejected(pending: Promise<unknown>): Promise<Error> {
  try { await pending; } catch (error) { expect(error).toBeInstanceOf(Error); return error as Error; }
  throw new Error('Expected rejection');
}
function redacted(error: Error) {
  expect(error.message).toBe('Authoritative completion context unavailable');
  expect(error.cause).toBeUndefined();
  expect(`${error.stack}\n${JSON.stringify(error)}`).not.toContain(privateText);
}

describe('REL-1056 trusted-completion failure classification', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => vi.useRealTimers());

  /** A rejection must carry a finite service-owned class, never upstream text. */
  async function reasonOfRejection(pending: Promise<unknown>): Promise<string> {
    try { await pending; } catch (error) {
      expect(error).toBeInstanceOf(TrustedCompletionResolutionError);
      const typed = error as TrustedCompletionResolutionError;
      // The class is a fixed token from the taxonomy, not a free-form message.
      expect(typed.reason).toMatch(/^[a-z][a-z0-9-]*$/u);
      // Nothing upstream may ride along in the public surface.
      expect(typed.message).toBe('Authoritative completion context unavailable');
      expect(typed.cause).toBeUndefined();
      return typed.reason;
    }
    throw new Error('Expected rejection');
  }

  it('classifies a diff with no applicable persona as deterministic coverage', async () => {
    // A path NO enabled persona claims, and which is not documentation or an
    // asset, so the trusted side cannot derive a required lane. This is the class
    // that used to surface as a retryable 503 for workflow/scripts-only diffs.
    const unmatched = 'diff --git a/odd/thing.unknownext b/odd/thing.unknownext\n--- a/odd/thing.unknownext\n+++ b/odd/thing.unknownext\n@@ -1 +1 @@\n-a\n+b\n';
    const f = fixture();
    f.exactCurrentDiff.mockResolvedValue({ current, expectedFileCount: 1, diff: '',
      changedFiles: [{ path: 'odd/thing.unknownext', patch: unmatched }] });
    const reason = await reasonOfRejection(f.context(f.gate));
    expect(reason).toBe('coverage-no-persona');
    // This is the class that used to be reported as a retryable 503.
    expect(isDeterministicCompletionFailure(reason as never)).toBe(true);
  });

  it('classifies a patch-less file entry as deterministic, not transient', async () => {
    // GitHub returns no patch for an empty added file or a large generated file.
    const f = fixture();
    f.exactCurrentDiff.mockResolvedValue({ current, expectedFileCount: 1, diff: '',
      changedFiles: [{ path: 'src/generated.json', patch: '' }] });
    const reason = await reasonOfRejection(f.context(f.gate));
    expect(reason).toBe('no-patch-file');
    expect(isDeterministicCompletionFailure(reason as never)).toBe(true);
  });

  it('classifies an over-bound file set as deterministic bounds', async () => {
    const f = fixture();
    f.exactCurrentDiff.mockResolvedValue({ current, expectedFileCount: 1, diff: '',
      changedFiles: [{ path: 'src/a.ts', patch: 'x'.repeat(1_100_001) }] });
    const reason = await reasonOfRejection(f.context(f.gate));
    expect(reason).toBe('bounds');
    expect(isDeterministicCompletionFailure(reason as never)).toBe(true);
  });

  it('never marks an unclassified failure as deterministic', async () => {
    // A reader blow-up is transient: it must stay retryable, so the class must
    // not be one of the deterministic set.
    const f = fixture();
    f.exactCurrentDiff.mockRejectedValue(new Error('transient upstream'));
    const reason = await reasonOfRejection(f.context(f.gate));
    expect(isDeterministicCompletionFailure(reason as never)).toBe(false);
  });

  it('loses nothing of the redaction contract', async () => {
    // The classification must not become a leak channel: the private marker is
    // still absent, and no upstream cause is attached.
    const unmatched = 'diff --git a/odd/thing.unknownext b/odd/thing.unknownext\n--- a/odd/thing.unknownext\n+++ b/odd/thing.unknownext\n@@ -1 +1 @@\n-a\n+b\n';
    const f = fixture();
    f.exactCurrentDiff.mockResolvedValue({ current, expectedFileCount: 1, diff: '',
      changedFiles: [{ path: `odd/${privateText}.unknownext`, patch: unmatched }] });
    const error = await (async () => {
      try { await f.context(f.gate); } catch (e) { return e as Error; }
      throw new Error('Expected rejection');
    })();
    redacted(error);
  });
});

describe('service-owned authoritative completion context', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => { try { expect(vi.getTimerCount()).toBe(0); } finally { vi.useRealTimers(); } });

  it.each([false, true])('returns only trusted current/coverage while preserving draft=%s', async (draft) => {
    const f = fixture();
    f.exactCurrentDiff.mockResolvedValue({ current: { ...current, draft }, diff, expectedFileCount: 1 });
    const context = await f.context(f.gate);
    expect(context).toEqual({ current: { ...current, draft, policyDigest: f.gate.coordinates.policyDigest }, coverage: {
      expectedPersonaIds: ['sec-lane', 'qual-lane'], changedFiles: [{ path: 'src/a.ts', patch: diff }],
      coverageComplete: true, quorumSatisfied: true,
    } });
    expect(context).not.toHaveProperty('evidence');
    expect(context).not.toHaveProperty('verdict');
    expect(JSON.stringify(context)).not.toContain(privateText);
    expect(f.getStoredPrepared).toHaveBeenCalledExactlyOnceWith(f.gate.coordinates.policyDigest, expect.any(AbortSignal));
    expect(f.readerFactory).toHaveBeenCalledExactlyOnceWith({ repositoryId: 123, owner: 'example', repo: 'candidate' }, expect.any(AbortSignal));
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith(target);
    expect(f.exactCurrentDiff).toHaveBeenCalledExactlyOnceWith(target, expect.any(AbortSignal));
    const order = [f.getStoredPrepared, f.readerFactory, f.currentCandidate, f.resolve, f.exactCurrentDiff]
      .map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(f.readerFactory.mock.calls[0][1].aborted).toBe(true);
  });

  it('derives the authoritative roster from immutable persona paths and the exact current diff', async () => {
    const stored = prepared(3, 'security,testing,documentation');
    const f = fixture({}, stored);

    const context = await f.context(f.gate);

    expect(stored.expectedPersonaIds).toEqual(['sec-lane', 'qual-lane', 'documentation']);
    expect(context.coverage.expectedPersonaIds).toEqual(['sec-lane', 'qual-lane']);
    expect(context.coverage.quorumSatisfied).toBe(true);
  });

  it('fails closed when no enabled immutable persona covers an analyzable source path', async () => {
    const f = fixture();
    f.exactCurrentDiff.mockResolvedValue({
      current: { ...current },
      diff: '',
      changedFiles: [{ path: 'src/main.lua', patch: '@@ -1 +1 @@\n-old\n+new' }],
      expectedFileCount: 1,
    });

    redacted(await rejected(f.context(f.gate)));
  });

  it('preserves the admitted roster for the audited zero-lane documentation exemption', async () => {
    const f = fixture();
    f.exactCurrentDiff.mockResolvedValue({
      current: { ...current },
      diff: '',
      changedFiles: [{ path: 'docs/operator-guide.rst', patch: '@@ -1 +1 @@\n-old\n+new' }],
      expectedFileCount: 1,
    });

    const context = await f.context(f.gate);

    expect(context.coverage).toMatchObject({
      expectedPersonaIds: f.stored.expectedPersonaIds,
      coverageComplete: true,
      quorumSatisfied: true,
    });
  });

  // REL-1058: the service must reach the worker's applicability decision, not
  // a separately derived one, or a failed or passing worker result for the
  // same head cannot be acknowledged (REL-1056).
  it('routes a docs-only .mdx change to the required lane instead of exempting or failing it', async () => {
    const f = fixture({}, prepared(3, 'architecture,security'));
    f.exactCurrentDiff.mockResolvedValue({
      current: { ...current },
      diff: '',
      changedFiles: [{ path: 'docusaurus/docs/deployment/appliance-firewall-requirements.mdx', patch: '@@ -1 +1 @@\n-old\n+new' }],
      expectedFileCount: 1,
    });

    const context = await f.context(f.gate);

    expect(context.coverage).toMatchObject({ expectedPersonaIds: ['sec-lane'], coverageComplete: true });
  });

  it('requires the architecture lane for a submodule pointer bump', async () => {
    const f = fixture({}, prepared(3, 'architecture,security,documentation'));
    const gitlinkDiff = 'diff --git a/ct-dashboard b/ct-dashboard\nindex 6c3f36d89d..f84610fbbf 160000\n'
      + '--- a/ct-dashboard\n+++ b/ct-dashboard\n@@ -1 +1 @@\n'
      + '-Subproject commit 6c3f36d89d675d27c0a8b88f684d57c6185a7e6b\n'
      + '+Subproject commit f84610fbbf478540b07861fa7a18174126ffe5bb\n';
    f.exactCurrentDiff.mockResolvedValue({ current: { ...current }, diff: gitlinkDiff, expectedFileCount: 1 });

    const context = await f.context(f.gate);

    expect(context.coverage.expectedPersonaIds).toEqual(['arch-lane']);
  });

  it('routes a pointer bump to the required lane when the roster has no architecture persona', async () => {
    const f = fixture({}, prepared(3, 'security,documentation'));
    f.exactCurrentDiff.mockResolvedValue({
      current: { ...current },
      diff: '',
      changedFiles: [{ path: 'ct-dashboard', patch: '@@ -1 +1 @@\n-Subproject commit 6c3f36d89d675d27c0a8b88f684d57c6185a7e6b\n+Subproject commit f84610fbbf478540b07861fa7a18174126ffe5bb' }],
      expectedFileCount: 1,
    });

    const context = await f.context(f.gate);

    expect(context.coverage.expectedPersonaIds).toEqual(['sec-lane']);
  });

  it('keeps gitlink mode metadata the worker sees instead of dropping it in the hunk filter', async () => {
    const f = fixture({}, prepared(3, 'architecture,security'));
    f.exactCurrentDiff.mockResolvedValue({
      current: { ...current },
      diff: '',
      changedFiles: [{ path: 'ct-dashboard', patch: '@@ -1 +1 @@\n-6c3f36d\n+f84610f', mode: '160000', isSubmodule: true }],
      expectedFileCount: 1,
    });

    const context = await f.context(f.gate);

    expect(context.coverage.expectedPersonaIds).toEqual(['arch-lane']);
  });

  it('derives applicability through the shared decision with the admitted config roster and path_filters', async () => {
    const spy = vi.mocked(personaApplicability.resolveReviewApplicability);
    spy.mockClear();
    const f = fixture();

    await f.context(f.gate);

    expect(spy).toHaveBeenCalledTimes(1);
    const [personas, files, options] = spy.mock.calls[0];
    expect(personas.map((persona) => persona.id)).toEqual(['sec-lane', 'qual-lane']);
    expect(files.map((file) => file.path)).toEqual(['src/a.ts']);
    expect(options).toEqual({ pathFilters: f.stored.config.path_filters });
  });

  it('fails closed when every changed file is only located under a build output directory', async () => {
    const f = fixture();
    f.exactCurrentDiff.mockResolvedValue({
      current: { ...current },
      diff: '',
      changedFiles: [{ path: 'dist/bundle.js', patch: '@@ -1 +1 @@\n-old\n+new' }],
      expectedFileCount: 1,
    });

    redacted(await rejected(f.context(f.gate)));
  });

  // REL-972: a Dependabot lockfile bump is the audited no-reviewable-content
  // exemption on the trusted side too, end to end through gate evaluation.
  const NPM_BUMP = '@@ -1,4 +1,4 @@\n     "node_modules/lodash": {\n'
    + '-      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",\n'
    + '+      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",\n';
  const lockPatch = (path: string) => (path.endsWith('package-lock.json') ? NPM_BUMP : '@@ -1 +1 @@\n-old\n+new');

  it.each([
    ['package-lock.json'],
    ['yarn.lock'],
    ['mix.lock'],
    ['web/package-lock.json', 'api/mix.lock'],
    // Worker and service previously disagreed here: the worker exempted it (the
    // lockfile is filtered, the rest is prose) and the service refused the
    // documentation-only completion because yarn.lock is not documentation.
    ['docs/upgrade.md', 'yarn.lock'],
  ])('accepts a lockfile/generated-only diff %s as the no-reviewable-content exemption', async (...paths: string[]) => {
    const f = fixture();
    const changedFiles = paths.map((path) => ({ path, patch: lockPatch(path) }));
    f.exactCurrentDiff.mockResolvedValue({
      current: { ...current }, diff: '', changedFiles, expectedFileCount: changedFiles.length,
    });

    const context = await f.context(f.gate);
    expect(context.coverage).toMatchObject({
      expectedPersonaIds: f.stored.expectedPersonaIds, coverageComplete: true, quorumSatisfied: true,
    });

    const { attemptId: _, ...coordinates } = f.gate.coordinates;
    const expectedCoordinates = { ...coordinates, configDigest: f.stored.policy.effectiveConfigDigest };
    const derived = deriveCanonicalWorkerReviewEvidence({ version: 'WorkerReviewCompletion.v1', ...expectedCoordinates,
      result: { version: 'WorkerReviewResult.v1', completedAt: '2026-09-09T18:00:00Z', coverageComplete: true,
        quorumSatisfied: true, personas: [{ id: 'documentation-only', decision: 'APPROVE', status: 'COMPLETE', findings: [] }] } },
    { ...context.coverage, expectedCoordinates });
    expect(derived.valid).toBe(true);
    expect(derived.evidence?.exemption?.kind).toBe('no-reviewable-content');
    expect(evaluateReviewGate({ candidate: f.gate.coordinates, current: context.current, evidence: derived.evidence }))
      .toMatchObject({ status: 'success', reason: 'central-exemption' });
  });

  it.each([
    ['a lockfile bump redirected off the registry', [{ path: 'package-lock.json',
      patch: NPM_BUMP.replace('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', 'https://evil.example/l.tgz') }]],
    ['a generated artifact only', [{ path: 'assets/app.min.js', patch: '@@ -1 +1 @@\n-old\n+new' }]],
  ])('fails %s closed as a coverage gap', async (_label, changedFiles) => {
    const f = fixture();
    f.exactCurrentDiff.mockResolvedValue({ current: { ...current }, diff: '', changedFiles, expectedFileCount: 1 });

    const error = await rejected(f.context(f.gate));
    expect((error as TrustedCompletionResolutionError).reason).toBe('coverage-no-persona');
  });

  it('refuses a documentation-only completion over an unverifiable lockfile', () => {
    // Defense in depth behind the shared decision: the completion check itself
    // re-verifies each admitted lockfile change.
    const f = fixture();
    const { attemptId: _, ...coordinates } = f.gate.coordinates;
    const expectedCoordinates = { ...coordinates, configDigest: f.stored.policy.effectiveConfigDigest };
    const derive = (patch: string) => deriveCanonicalWorkerReviewEvidence({ version: 'WorkerReviewCompletion.v1', ...expectedCoordinates,
      result: { version: 'WorkerReviewResult.v1', completedAt: '2026-09-09T18:00:00Z', coverageComplete: true,
        quorumSatisfied: true, personas: [{ id: 'documentation-only', decision: 'APPROVE', status: 'COMPLETE', findings: [] }] } },
    { expectedPersonaIds: ['sec-lane'], coverageComplete: true, quorumSatisfied: true, expectedCoordinates,
      changedFiles: [{ path: 'package-lock.json', patch }] });
    expect(derive(NPM_BUMP).valid).toBe(true);
    expect(derive(NPM_BUMP.replace('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', 'https://evil.example/l.tgz')).valid)
      .toBe(false);
  });

  it('requires a real lane, not the exemption, for a manifest change beside its lockfile', async () => {
    const f = fixture();
    const changedFiles = ['package.json', 'package-lock.json'].map((path) => ({ path, patch: lockPatch(path) }));
    f.exactCurrentDiff.mockResolvedValue({ current: { ...current }, diff: '', changedFiles, expectedFileCount: 2 });

    const context = await f.context(f.gate);
    expect(context.coverage.expectedPersonaIds).toEqual(['sec-lane']);

    // A worker claiming the zero-lane exemption for this diff is refused.
    const { attemptId: _, ...coordinates } = f.gate.coordinates;
    const expectedCoordinates = { ...coordinates, configDigest: f.stored.policy.effectiveConfigDigest };
    const derived = deriveCanonicalWorkerReviewEvidence({ version: 'WorkerReviewCompletion.v1', ...expectedCoordinates,
      result: { version: 'WorkerReviewResult.v1', completedAt: '2026-09-09T18:00:00Z', coverageComplete: true,
        quorumSatisfied: true, personas: [{ id: 'documentation-only', decision: 'APPROVE', status: 'COMPLETE', findings: [] }] } },
    { ...context.coverage, expectedCoordinates });
    expect(derived.valid).toBe(false);
  });

  it('still fails uncovered source beside a lockfile closed as a coverage gap', async () => {
    const f = fixture();
    const changedFiles = ['src/main.lua', 'yarn.lock'].map((path) => ({ path, patch: '@@ -1 +1 @@\n-old\n+new' }));
    f.exactCurrentDiff.mockResolvedValue({ current: { ...current }, diff: '', changedFiles, expectedFileCount: 2 });

    const error = await rejected(f.context(f.gate));
    expect((error as TrustedCompletionResolutionError).reason).toBe('coverage-no-persona');
  });

  it('does not turn a trusted required-lane contract into successful worker evidence', async () => {
    const f = fixture();
    const context = await f.context(f.gate);
    const { attemptId: _, ...coordinates } = f.gate.coordinates;
    const expectedCoordinates = { ...coordinates, configDigest: f.stored.policy.effectiveConfigDigest };
    const derived = deriveCanonicalWorkerReviewEvidence({ version: 'WorkerReviewCompletion.v1', ...expectedCoordinates,
      result: { version: 'WorkerReviewResult.v1', completedAt: '2026-09-09T18:00:00Z', coverageComplete: true,
        quorumSatisfied: true, personas: [{ id: 'sec-lane', decision: 'APPROVE', findings: [] }] } },
    { ...context.coverage, expectedCoordinates });
    expect(derived.valid).toBe(true);
    expect(derived.evidence?.quorumSatisfied).toBe(false);
    expect(evaluateReviewGate({ candidate: f.gate.coordinates, current: context.current, evidence: derived.evidence }).status).toBe('failure');
  });

  it('completes a 130-file oversized PR through the real reader and still requires complete worker coverage', async () => {
    const entries = Array.from({ length: 130 }, (_, index) => ({ sha: 'd'.repeat(40), filename: `src/file-${index}.ts`,
      status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' }));
    const body = { number: target.prNumber, state: 'open', draft: false, merged: false, changed_files: 130,
      head: { sha: target.headSha }, base: { sha: target.baseSha, repo: { id: target.repositoryId, full_name: 'example/candidate' } } };
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    const fetcher = vi.fn<typeof fetch>();
    for (const value of [response(body), response(body), response({ errors: [
      { resource: 'PullRequest', field: 'diff', code: 'too_large' },
    ] }, 406), response({
      url: `https://api.github.com/repos/example/candidate/compare/${target.baseSha}...${target.headSha}`,
      base_commit: { sha: target.baseSha }, merge_base_commit: { sha: target.baseSha },
      status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, files: entries,
    }), response(body)]) {
      fetcher.mockResolvedValueOnce(value);
    }
    const reader = new AuthoritativeReviewReader({ token: 'ghs_large-pr.header.signature', fetchImplementation: fetcher });
    const f = fixture({ readerFactory: async () => reader });
    const context = await f.context(f.gate);
    expect(context.coverage.coverageComplete).toBe(true);
    expect(context.coverage.changedFiles).toHaveLength(130);
    const { attemptId: _, ...coordinates } = f.gate.coordinates;
    const expectedCoordinates = { ...coordinates, configDigest: f.stored.policy.effectiveConfigDigest };
    for (const coverageComplete of [true, false]) {
      const derived = deriveCanonicalWorkerReviewEvidence({ version: 'WorkerReviewCompletion.v1', ...expectedCoordinates,
        result: { version: 'WorkerReviewResult.v1', completedAt: '2026-09-22T18:00:00Z', coverageComplete,
          quorumSatisfied: true, personas: ['sec-lane', 'qual-lane'].map((id) => ({ id, decision: 'APPROVE', findings: [] })) } },
      { ...context.coverage, expectedCoordinates });
      expect(derived.valid).toBe(true);
      expect(evaluateReviewGate({ candidate: f.gate.coordinates, current: context.current, evidence: derived.evidence }).status)
        .toBe(coverageComplete ? 'success' : 'failure');
    }
    for (const finding of [{ path: 'src/file-129.ts', line: 2 }, { path: 'src/not-changed.ts', line: 1 }]) {
      const derived = deriveCanonicalWorkerReviewEvidence({ version: 'WorkerReviewCompletion.v1', ...expectedCoordinates,
        result: { version: 'WorkerReviewResult.v1', completedAt: '2026-09-22T18:00:00Z', coverageComplete: true,
          quorumSatisfied: true, personas: ['sec-lane', 'qual-lane'].map((id) => ({ id, decision: 'FINDINGS', findings: [
            { ...finding, severity: 'P1', title: 'Invalid authorization', body: 'The check accepts the wrong identity.' },
          ] })) } }, { ...context.coverage, expectedCoordinates });
      expect(derived.valid).toBe(false);
    }
  });

  it.each([
    { diff, changedFiles: [{ path: 'src/a.ts', patch: diff }] },
    { diff: '', changedFiles: [] },
    { diff: '', changedFiles: [{ path: '', patch: diff }] },
    { diff: '', changedFiles: [{ path: 'src/a.ts', patch: '' }] },
    { diff: '', changedFiles: [{ path: 'src/a.ts', patch: 'x'.repeat(1_100_001) }] },
    { diff: '', changedFiles: Array.from({ length: 5 }, (_, i) => ({ path: `${i}.ts`, patch: 'x'.repeat(900_000) })) },
  ])('rejects conflicting/empty/unbounded trusted file representations %#', async (source) => {
    const f = fixture(); f.exactCurrentDiff.mockResolvedValue({ current, expectedFileCount: 1, ...source });
    redacted(await rejected(f.context(f.gate)));
  });

  it.each([
    { changedFiles: [{ path: 'src/a.ts', patch: diff }], expectedFileCount: undefined },
    { changedFiles: [{ path: 'src/a.ts', patch: diff }], expectedFileCount: 2 },
    { changedFiles: [{ path: 'src/a.ts', patch: diff }, { path: 'src/a.ts', patch: diff }], expectedFileCount: 2 },
  ])('does not certify incomplete or duplicate trusted file inventories %#', async (source) => {
    const f = fixture(); f.exactCurrentDiff.mockResolvedValue({ current, diff: '', ...source });
    expect((await f.context(f.gate)).coverage.coverageComplete).toBe(false);
  });

  it('refreshes through the existing configured publishing resolver without candidate-selected policy', async () => {
    const policyRepository = { repositoryId: 456, owner: 'example', repo: 'central-policy' };
    const resolvePolicyRevision = vi.fn(async () => 'c'.repeat(40));
    const immutablePolicyFile = vi.fn(async () => policyFile());
    const policyReaderFactory = vi.fn(async () => ({ resolvePolicyRevision, immutablePolicyFile }));
    const candidateRead = vi.fn(async () => ({ ...current }));
    const publishingResolver = new AuthoritativePublishingResolver({
      policyRepository, policyRef: 'refs/heads/service-policy', policyPath: 'policy/review.json',
      transport: prepared().transport, candidateReaderFactory: async () => ({ currentCandidate: candidateRead }),
      policyReaderFactory, timeoutMs: 250,
    });
    const f = fixture({ publishingResolver });
    expect((await f.context(f.gate)).coverage.coverageComplete).toBe(true);
    expect(candidateRead).toHaveBeenCalledTimes(2);
    expect(policyReaderFactory).toHaveBeenCalledExactlyOnceWith(policyRepository, expect.any(AbortSignal));
    expect(resolvePolicyRevision).toHaveBeenCalledExactlyOnceWith(
      policyRepository, 'refs/heads/service-policy', expect.any(AbortSignal),
    );
    expect(immutablePolicyFile).toHaveBeenCalledExactlyOnceWith(
      policyRepository, 'c'.repeat(40), 'policy/review.json', expect.any(AbortSignal),
    );
  });

  it('aborts a real reader stalled body at the context deadline, even with a longer reader timeout', async () => {
    const pull = () => new Response(JSON.stringify({ number: 42, state: 'open', merged: false, draft: false,
      head: { sha: target.headSha }, base: { sha: target.baseSha, repo: { id: 123, full_name: 'example/candidate' } },
      changed_files: 1 }));
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(pull()).mockResolvedValueOnce(pull())
      .mockResolvedValueOnce(new Response(body));
    const reader = new AuthoritativeReviewReader({ token: 'ghs_context_read_only', timeoutMs: 5_000, fetchImplementation: fetcher });
    const f = fixture({ readerFactory: async () => reader, timeoutMs: 250 });
    const pending = rejected(f.context(f.gate));
    await vi.advanceTimersByTimeAsync(249); expect(body.locked).toBe(true);
    await vi.advanceTimersByTimeAsync(1); redacted(await pending);
    expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3); expect(fetcher.mock.calls[2][1]?.signal?.aborted).toBe(true);
  });

  it.each([{ open: false }, { headSha: 'd'.repeat(40) }, { baseSha: 'e'.repeat(40) }])(
    'cancels a fresh changed/closed candidate %j without policy or diff reads', async (change) => {
      const f = fixture(); f.currentCandidate.mockResolvedValue({ ...current, ...change });
      const context = await f.context(f.gate);
      expect(context.current).toEqual({ ...current, ...change, policyDigest: f.gate.coordinates.policyDigest });
      expect(context.coverage).toMatchObject({ changedFiles: [], coverageComplete: false, quorumSatisfied: false });
      expect(evaluateReviewGate({ candidate: f.gate.coordinates, current: context.current }).status).toBe('cancelled');
      expect(f.resolve).not.toHaveBeenCalled(); expect(f.exactCurrentDiff).not.toHaveBeenCalled();
    },
  );

  it('returns fresh changed policy identity for cancellation without fetching a diff', async () => {
    const f = fixture(); const fresh = prepared(4); f.resolve.mockResolvedValue(resolution(fresh));
    const context = await f.context(f.gate);
    expect(context.current.policyDigest).toBe(fresh.policy.effectivePolicyDigest);
    expect(context.coverage).toMatchObject({ changedFiles: [], coverageComplete: false, quorumSatisfied: false });
    expect(evaluateReviewGate({ candidate: f.gate.coordinates, current: context.current }).status).toBe('cancelled');
    expect(f.exactCurrentDiff).not.toHaveBeenCalled();
  });

  it.each([{ open: false }, { headSha: 'd'.repeat(40) }, { baseSha: 'e'.repeat(40) }])(
    'returns cancellation for a resolver-time candidate race %j only after fresh readback', async (change) => {
      const f = fixture(); f.resolve.mockRejectedValue(new Error(privateText));
      f.currentCandidate.mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, ...change });
      const context = await f.context(f.gate);
      expect(context.current).toMatchObject(change);
      expect(context.coverage.coverageComplete).toBe(false);
      expect(f.exactCurrentDiff).not.toHaveBeenCalled();
    },
  );

  it.each([{ open: false }, { headSha: 'd'.repeat(40) }, { baseSha: 'e'.repeat(40) }])(
    'discards all diff evidence after a final candidate race %j', async (change) => {
      const f = fixture(); f.exactCurrentDiff.mockResolvedValue({ current: { ...current, ...change }, diff, expectedFileCount: 1 });
      const context = await f.context(f.gate);
      expect(context.current).toMatchObject(change);
      expect(context.coverage).toMatchObject({ changedFiles: [], coverageComplete: false, quorumSatisfied: false });
    },
  );

  it.each([{ repositoryId: 999 }, { owner: 'other' }, { repo: 'other' }, { prNumber: 43 }, { headSha: 'main' }])(
    'rejects wrong repository/PR or malformed current coordinates %j', async (change) => {
      const f = fixture(); f.currentCandidate.mockResolvedValue({ ...current, ...change });
      redacted(await rejected(f.context(f.gate)));
      expect(f.resolve).not.toHaveBeenCalled();
    },
  );

  it.each(['initial', 'final'] as const)('rejects wrong repository identity in %s returned evidence', async (stage) => {
    const f = fixture();
    if (stage === 'initial') f.resolve.mockResolvedValue({ ...resolution(), current: { ...current, repositoryId: 999 } });
    else f.exactCurrentDiff.mockResolvedValue({ current: { ...current, repositoryId: 999 }, diff, expectedFileCount: 1 });
    redacted(await rejected(f.context(f.gate)));
  });

  it.each(['missing', 'version', 'digest', 'config', 'transport', 'empty-personas', 'extra-persona', 'duplicate-persona', 'source'])(
    'rejects %s stored preparation before minting a token', async (kind) => {
      const f = fixture(); const bad = structuredClone(f.stored);
      if (kind === 'missing') f.getStoredPrepared.mockResolvedValue(null);
      if (kind === 'version') (bad as any).version = 'unknown';
      if (kind === 'digest') bad.policy.effectivePolicyDigest = 'f'.repeat(64);
      if (kind === 'config') bad.config.profile = 'chill';
      if (kind === 'transport') bad.transport.model = 'other';
      if (kind === 'empty-personas') bad.expectedPersonaIds = [];
      if (kind === 'extra-persona') bad.expectedPersonaIds = ['sec-lane', 'unrequired'];
      if (kind === 'duplicate-persona') bad.expectedPersonaIds = ['sec-lane', 'sec-lane'];
      if (kind === 'source') bad.policy.sources[0].sha = privateText;
      if (kind !== 'missing') f.getStoredPrepared.mockResolvedValue(bad);
      redacted(await rejected(f.context(f.gate)));
      expect(f.readerFactory).not.toHaveBeenCalled();
    },
  );

  it('rejects corrupted stored provenance even if its claimed policy digest matches', async () => {
    const f = fixture(); f.stored.policy.sources[0].sha = 'f'.repeat(40);
    redacted(await rejected(f.context(f.gate)));
    expect(f.exactCurrentDiff).not.toHaveBeenCalled();
  });

  it('rejects a refreshed identity inconsistent with the fresh prepared policy', async () => {
    const f = fixture(); const result = resolution(); result.identity.configDigest = 'f'.repeat(64);
    f.resolve.mockResolvedValue(result);
    redacted(await rejected(f.context(f.gate)));
    expect(f.exactCurrentDiff).not.toHaveBeenCalled();
  });

  it.each([
    { diff, expectedFileCount: undefined }, { diff, expectedFileCount: 0 }, { diff, expectedFileCount: 2 },
    { diff: diff + 'diff --git nonsense\n@@ -1 +1 @@\n-old\n+new\n', expectedFileCount: 2 },
    { diff: diff + diff, expectedFileCount: 2 },
  ])('never asserts complete coverage for missing/count-mismatched/unreadable diff evidence %#', async (source) => {
    const f = fixture(); f.exactCurrentDiff.mockResolvedValue({ current, ...source });
    expect((await f.context(f.gate)).coverage.coverageComplete).toBe(false);
  });

  it.each(['', 'not a diff', 'diff --git nonsense\n@@ -1 +1 @@\n-old\n+new\n'])(
    'rejects same-head evidence with no readable files rather than manufacturing an exemption %#', async (diff) => {
      const f = fixture(); f.exactCurrentDiff.mockResolvedValue({ current, diff, expectedFileCount: 0 });
      redacted(await rejected(f.context(f.gate)));
    },
  );

  it.each([2_000_001, 1_100_001])('rejects oversized diff/individual patch (%i bytes) rather than truncating it', async (size) => {
    const f = fixture(); f.exactCurrentDiff.mockResolvedValue({ current, diff: diff + 'a'.repeat(size), expectedFileCount: 1 });
    redacted(await rejected(f.context(f.gate)));
  });

  it.each([
    ['storage', 'stored-policy'], ['factory', 'token'], ['current', 'current-candidate'],
    ['policy', 'policy-refresh'], ['diff', 'exact-diff'],
  ])('redacts and classifies %s failures as %s', async (stage, substage) => {
    const f = fixture(); const fail = new Error(privateText);
    if (stage === 'storage') f.getStoredPrepared.mockRejectedValue(fail);
    if (stage === 'factory') f.readerFactory.mockRejectedValue(fail);
    if (stage === 'current') f.currentCandidate.mockRejectedValue(fail);
    if (stage === 'policy') f.resolve.mockRejectedValue(fail);
    if (stage === 'diff') f.exactCurrentDiff.mockRejectedValue(fail);
    const failure = await rejected(f.context(f.gate));
    redacted(failure);
    expect(failure).toMatchObject({ substage });
  });

  it('classifies a failed resolver-race re-read as current-candidate', async () => {
    const f = fixture();
    f.resolve.mockRejectedValue(new Error(privateText));
    f.currentCandidate.mockResolvedValueOnce(current).mockRejectedValueOnce(new Error(privateText));
    const failure = await rejected(f.context(f.gate));
    redacted(failure);
    expect(failure).toMatchObject({ substage: 'current-candidate' });
    expect(f.currentCandidate).toHaveBeenCalledTimes(2);
    expect(f.exactCurrentDiff).not.toHaveBeenCalled();
  });

  it.each([
    ['storage', 'stored-policy'], ['factory', 'token'], ['current', 'current-candidate'],
    ['policy', 'policy-refresh'], ['diff', 'exact-diff'],
  ] as const)('bounds a non-cooperative %s promise at 20 seconds as %s', async (stage, substage) => {
    const f = fixture(); const hang = () => new Promise<never>(() => undefined);
    if (stage === 'storage') f.getStoredPrepared.mockImplementation(hang);
    if (stage === 'factory') f.readerFactory.mockImplementation(hang);
    if (stage === 'current') f.currentCandidate.mockImplementation(hang);
    if (stage === 'policy') f.resolve.mockImplementation(hang);
    if (stage === 'diff') f.exactCurrentDiff.mockImplementation(hang);
    let settled = false;
    const pending = rejected(f.context(f.gate)).then((error) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(19_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); const failure = await pending; redacted(failure);
    expect(failure).toMatchObject({ substage });
    expect(f.getStoredPrepared.mock.calls[0][1].aborted).toBe(true);
    if (stage !== 'diff') expect(f.exactCurrentDiff).not.toHaveBeenCalled();
  });

  it('does not resume policy/diff reads after a timed-out token mint finally resolves', async () => {
    const f = fixture({ timeoutMs: 250 });
    let finish!: (reader: Awaited<ReturnType<AuthoritativeCompletionContextOptions['readerFactory']>>) => void;
    f.readerFactory.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = rejected(f.context(f.gate)); await vi.advanceTimersByTimeAsync(250); redacted(await pending);
    finish({ currentCandidate: f.currentCandidate, exactCurrentDiff: f.exactCurrentDiff });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.currentCandidate).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled();
  });

  it('does not fetch a diff or re-read the candidate after a late policy resolution', async () => {
    const f = fixture({ timeoutMs: 250 });
    let finish!: (value: ReturnType<typeof resolution>) => void;
    f.resolve.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = rejected(f.context(f.gate)); await vi.advanceTimersByTimeAsync(250); redacted(await pending);
    finish(resolution()); await vi.advanceTimersByTimeAsync(0);
    expect(f.currentCandidate).toHaveBeenCalledOnce(); expect(f.exactCurrentDiff).not.toHaveBeenCalled();
  });

  it('uses one cumulative deadline rather than restarting it for each dependency', async () => {
    const f = fixture({ timeoutMs: 250 });
    f.getStoredPrepared.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 150)); return f.stored; });
    f.readerFactory.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 150)); return { currentCandidate: f.currentCandidate, exactCurrentDiff: f.exactCurrentDiff };
    });
    const pending = rejected(f.context(f.gate)); await vi.advanceTimersByTimeAsync(250); redacted(await pending);
    await vi.advanceTimersByTimeAsync(50);
    expect(f.currentCandidate).not.toHaveBeenCalled();
  });

  it('allows bounded policy refresh and exact-diff reconstruction beyond the old ten-second budget', async () => {
    const f = fixture();
    f.resolve.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return resolution();
    });
    f.exactCurrentDiff.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 7_000));
      return { current: { ...current }, diff, expectedFileCount: 1 };
    });
    let settled = false;
    const pending = f.context(f.gate).then(
      (value) => { settled = true; return { value }; },
      (error: Error) => { settled = true; return { error }; },
    );
    await vi.advanceTimersByTimeAsync(12_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw result.error;
    expect(result.value.coverage.coverageComplete).toBe(true);
    expect(f.exactCurrentDiff).toHaveBeenCalledOnce();
  });

  it.each([249, 20_001, 1.5, NaN, Infinity])('rejects invalid operation deadline %s', (timeoutMs) => {
    expect(() => fixture({ timeoutMs })).toThrow('Authoritative completion context configuration invalid');
  });
});
