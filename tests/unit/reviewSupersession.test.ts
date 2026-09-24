/**
 * REL-1057: a newer push that lands while a run is queued or reviewing
 * supersedes that run. The worker must end it as superseded -- a neutral check
 * on the old head and no failure callback -- instead of failing it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker, type PublishingReviewDeps } from '../../src/cli/publishingReview';
import {
  GitHubPullRequestIdentityMovedError,
  GitHubQualificationReadError,
  loadSameHeadReviewSource,
  readPullRequestIdentity,
} from '../../src/github/qualificationReader';
import {
  ReviewSupersededError,
  WORKER_SUPERSEDED_TERMINATION_MARKER,
  workerSupersededTerminationMessage,
} from '../../src/review/reviewSupersession';
import { HttpWorkerCompletionAdapter, WorkerCompletionHttpError } from '../../src/review/workerCompletion';
import { logger } from '../../src/utils/logger';
import { PanelCancellationError } from '../../src/panel/panelEngine';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const NEWER_HEAD = 'e'.repeat(40);
const NEWER_BASE = 'f'.repeat(40);
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

afterEach(() => vi.restoreAllMocks());

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    REVIEW_PUBLICATION_MODE: 'app-gate',
    REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
    REVIEW_REPO: 'calltelemetry/ct-meta',
    REVIEW_REPOSITORY_ID: '1339040553',
    REVIEW_POLICY_DIGEST: 'c'.repeat(64),
    REVIEW_CONFIG_DIGEST: 'd'.repeat(64),
    REVIEW_EXECUTION_ATTEMPT: '1',
    REVIEW_PR_NUMBER: '3403',
    REVIEW_HEAD_SHA: HEAD,
    REVIEW_BASE_SHA: BASE,
    REVIEW_MODEL: 'ollama/glm-5.3-flash',
    OPENAI_BASE_URL: 'https://gateway.example.invalid/v1',
    OPENAI_API_KEY: 'vk-test',
    GH_TOKEN: 'ghs_test',
    ...overrides,
  };
}

function harness(over: Partial<PublishingReviewDeps> = {}) {
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  const checkClient = { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async () => {}) };
  const completion = {
    reportTerminalFailure: vi.fn(async () => {}),
    reportTerminalSuccess: vi.fn(async () => {}),
  };
  const panelRunner = vi.fn(async () => ({
    applicablePersonaIds: ['sec-lane'],
    personas: [{ id: 'sec-lane', findings: [] }],
    optionalFailures: [],
    quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
    arbiter: { verdict: 'SHIP' },
  }));
  const deps = {
    checkClient,
    completion,
    sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })),
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    panelRunner,
    client: {},
    ...over,
  } as unknown as PublishingReviewDeps;
  return { deps, checkClient, completion, panelRunner };
}

function movedHead(message = 'GitHub projected pull request identity mismatch') {
  return new GitHubPullRequestIdentityMovedError(message, 1, HEAD, NEWER_HEAD, BASE);
}

function expectNeutralSupersededCheck(checkClient: { completeCheck: ReturnType<typeof vi.fn> }) {
  expect(checkClient.completeCheck).toHaveBeenCalledExactlyOnceWith({
    owner: 'calltelemetry', repo: 'ct-meta', checkId: 4242, conclusion: 'neutral',
    title: 'Review Yeti: review superseded', summary: 'Superseded by a newer pull request head.',
  });
}

describe('qualification read identity (REL-1057)', () => {
  function reader(sequence: Array<{ base: string; head: string }>) {
    let call = 0;
    return vi.fn(async (_route: string, parameters: Record<string, unknown>) => {
      if ((parameters.headers as Record<string, string> | undefined)?.accept) return { data: DIFF };
      const identity = sequence[Math.min(call, sequence.length - 1)];
      call += 1;
      return { data: { base: { sha: identity.base }, head: { sha: identity.head } } };
    });
  }
  const input = { token: 'ghs_x', repo: 'calltelemetry/ct-meta', prNumber: 3403, expectedBaseSha: BASE, expectedHeadSha: HEAD };

  it('reports the current head when the projected head moved before the read', async () => {
    const error = await loadSameHeadReviewSource(input, reader([{ base: BASE, head: NEWER_HEAD }])).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubPullRequestIdentityMovedError);
    // Still the same error class and message, so existing classifiers keep working.
    expect(error).toBeInstanceOf(GitHubQualificationReadError);
    expect(error.message).toBe('GitHub projected pull request identity mismatch');
    expect(error).toMatchObject({ headMoved: true, currentHeadSha: NEWER_HEAD, currentBaseSha: BASE });
  });

  it('reports a head that moved during the read', async () => {
    const error = await loadSameHeadReviewSource(input, reader([
      { base: BASE, head: HEAD }, { base: BASE, head: NEWER_HEAD },
    ])).catch((e) => e);
    expect(error.message).toBe('GitHub pull request moved during qualification read');
    expect(error).toMatchObject({ headMoved: true, currentHeadSha: NEWER_HEAD });
  });

  it('does not call a base-only move a head move', async () => {
    const error = await loadSameHeadReviewSource(input, reader([{ base: NEWER_BASE, head: HEAD }])).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubPullRequestIdentityMovedError);
    expect(error.headMoved).toBe(false);
  });

  it('reads the current pull request identity in one request', async () => {
    const request = reader([{ base: BASE, head: NEWER_HEAD }]);
    await expect(readPullRequestIdentity({ token: 'ghs_x', repo: 'calltelemetry/ct-meta', prNumber: 3403 }, request))
      .resolves.toEqual({ baseSha: BASE, headSha: NEWER_HEAD });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('publishing worker: head moved before the review (pre_review)', () => {
  it('ends superseded with a neutral check and no failure callback', async () => {
    const h = harness({ sourceLoader: vi.fn(async () => { throw movedHead(); }) as never });
    const error = await runPublishingReviewWorker(env({ REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion' }), h.deps)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ReviewSupersededError);
    expect(error).toMatchObject({ stage: 'pre_review', reviewedHeadSha: HEAD, currentHeadSha: NEWER_HEAD });
    expect(h.panelRunner).not.toHaveBeenCalled();
    expectNeutralSupersededCheck(h.checkClient);
    expect(h.completion.reportTerminalFailure).not.toHaveBeenCalled();
  });

  it('treats a head that moved during the qualification read the same way', async () => {
    const h = harness({
      sourceLoader: vi.fn(async () => { throw movedHead('GitHub pull request moved during qualification read'); }) as never,
    });
    await expect(runPublishingReviewWorker(env(), h.deps)).rejects.toBeInstanceOf(ReviewSupersededError);
    expectNeutralSupersededCheck(h.checkClient);
  });

  it('keeps a base-only move a failure: the admitted head is still the one to review', async () => {
    const h = harness({
      sourceLoader: vi.fn(async () => {
        throw new GitHubPullRequestIdentityMovedError('GitHub projected pull request identity mismatch', 1, HEAD, HEAD, NEWER_BASE);
      }) as never,
    });
    const error = await runPublishingReviewWorker(env(), h.deps).catch((e) => e);
    expect(error).not.toBeInstanceOf(ReviewSupersededError);
    expect(h.checkClient.completeCheck).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'failure' }));
    expect(h.completion.reportTerminalFailure).toHaveBeenCalledTimes(1);
  });

  it('reports to the authoritative service, which owns the cancellation decision', async () => {
    // The trusted completion path re-reads GitHub and resolves a moved head as
    // cancellation(); the worker still delivers its result so the service, not
    // the worker, decides. Uses the real prepared-config fixture shape.
    const { preparePublishingPolicy } = await import('../../src/review/preparedPublishingPolicy');
    const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'prepared-review-model' };
    const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
      personas: 'security,testing', budget: { max_investigation_turns: 1 } } });
    const prepared = preparePublishingPolicy({ content, source: {
      repositoryId: 987, repository: 'example/policy', sha: 'e'.repeat(40), path: 'policy/review.json',
      contentDigest: createHash('sha256').update(content).digest('hex'),
    } }, transport);
    const reportReviewResult = vi.fn(async () => {});
    const h = harness({
      completion: undefined,
      reviewCompletion: { reportReviewResult },
      sourceLoader: vi.fn(async () => { throw movedHead(); }) as never,
    });
    const authoritativeEnv = env({
      REVIEW_AUTHORITATIVE_GATE: 'true',
      REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest,
      REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
      REVIEW_PREPARED_CONFIG_JSON: JSON.stringify({ version: 'PreparedReviewExecution.v1', config: prepared.config, transport }),
      REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
      REVIEW_MODEL: transport.model,
      REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
    });
    await expect(runPublishingReviewWorker(authoritativeEnv, h.deps)).rejects.toBeInstanceOf(ReviewSupersededError);
    expect(reportReviewResult).toHaveBeenCalledTimes(1);
    expectNeutralSupersededCheck(h.checkClient);
  });
});

describe('publishing worker: run superseded mid-review (during_review)', () => {
  it('ends superseded when the service says the run is no longer current', async () => {
    let current = true;
    const h = harness({
      isCurrentHead: () => current,
      panelRunner: vi.fn(async () => {
        current = false;
        throw new Error('panel aborted');
      }) as never,
    });
    const error = await runPublishingReviewWorker(env(), h.deps).catch((e) => e);
    expect(error).toBeInstanceOf(ReviewSupersededError);
    expect(error.stage).toBe('during_review');
    expectNeutralSupersededCheck(h.checkClient);
    expect(h.completion.reportTerminalFailure).not.toHaveBeenCalled();
  });

  it('keeps a panel failure on a still-current head a failure', async () => {
    const h = harness({
      isCurrentHead: () => true,
      panelRunner: vi.fn(async () => { throw new Error('panel aborted'); }) as never,
    });
    const error = await runPublishingReviewWorker(env(), h.deps).catch((e) => e);
    expect(error).not.toBeInstanceOf(ReviewSupersededError);
    expect(h.completion.reportTerminalFailure).toHaveBeenCalledTimes(1);
  });
});

describe('publishing worker: Job deleted by a cancellation (REL-1093)', () => {
  // The operator cancels a superseded run by deleting its worker Job; the pod
  // sees only SIGTERM, which aborts the root signal, and the panel throws
  // "review panel was cancelled". The service poller is not configured.
  // SIGTERM lands while the panel runs: the root signal aborts and the panel
  // throws its cancellation error.
  function sigtermDuringPanel() {
    const controller = new AbortController();
    const panelRunner = vi.fn(async () => {
      controller.abort(new Error('Process received SIGTERM'));
      throw new PanelCancellationError();
    }) as never;
    return { signal: controller.signal, panelRunner };
  }

  it('ends superseded (neutral check, no failure callback) when the head moved', async () => {
    const pullRequestIdentityReader = vi.fn(async () => ({ baseSha: BASE, headSha: NEWER_HEAD }));
    const h = harness({ ...sigtermDuringPanel(), pullRequestIdentityReader });
    const error = await runPublishingReviewWorker(env({ REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion' }), h.deps)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ReviewSupersededError);
    expect(error).toMatchObject({ stage: 'during_review', reviewedHeadSha: HEAD, currentHeadSha: NEWER_HEAD });
    expect(pullRequestIdentityReader).toHaveBeenCalledExactlyOnceWith({ token: 'ghs_test', repo: 'calltelemetry/ct-meta', prNumber: 3403 });
    expectNeutralSupersededCheck(h.checkClient);
    expect(h.completion.reportTerminalFailure).not.toHaveBeenCalled();
  });

  it('keeps a SIGTERM on an unchanged head (deadline expiry, eviction) a failure', async () => {
    const h = harness({
      ...sigtermDuringPanel(),
      pullRequestIdentityReader: vi.fn(async () => ({ baseSha: BASE, headSha: HEAD })),
    });
    const error = await runPublishingReviewWorker(env({ REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion' }), h.deps)
      .catch((e) => e);
    expect(error).not.toBeInstanceOf(ReviewSupersededError);
    expect(error.message).toBe('review panel was cancelled');
    expect(h.checkClient.completeCheck).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conclusion: 'failure' }));
    expect(h.completion.reportTerminalFailure).toHaveBeenCalledTimes(1);
  });

  it('keeps the failure when the head cannot be read', async () => {
    const h = harness({
      ...sigtermDuringPanel(),
      pullRequestIdentityReader: vi.fn(async () => { throw new Error('GitHub down'); }),
    });
    const error = await runPublishingReviewWorker(env(), h.deps).catch((e) => e);
    expect(error).toBeInstanceOf(PanelCancellationError);
    expect(h.checkClient.completeCheck).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'failure' }));
  });

  it('keeps the failure when the head read does not answer within the bound', async () => {
    const h = harness({
      ...sigtermDuringPanel(), abortHeadReadTimeoutMs: 10,
      pullRequestIdentityReader: vi.fn(() => new Promise(() => {})) as never,
    });
    const error = await runPublishingReviewWorker(env(), h.deps).catch((e) => e);
    expect(error).toBeInstanceOf(PanelCancellationError);
    expect(h.checkClient.completeCheck).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'failure' }));
  });

  it('never reads the head for a failure that was not caused by an abort', async () => {
    const pullRequestIdentityReader = vi.fn(async () => ({ baseSha: BASE, headSha: NEWER_HEAD }));
    const h = harness({
      signal: new AbortController().signal,
      panelRunner: vi.fn(async () => { throw new Error('panel aborted'); }) as never,
      pullRequestIdentityReader,
    });
    const error = await runPublishingReviewWorker(env(), h.deps).catch((e) => e);
    expect(error).not.toBeInstanceOf(ReviewSupersededError);
    expect(pullRequestIdentityReader).not.toHaveBeenCalled();
    expect(h.checkClient.completeCheck).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'failure' }));
  });
});

describe('publishing worker: completion 409 after the head moved (completion)', () => {
  function conflictingCompletion(status = 409) {
    return {
      reportTerminalFailure: vi.fn(async () => {}),
      reportTerminalSuccess: vi.fn(async () => { throw new WorkerCompletionHttpError(status); }),
    };
  }

  it('maps a 409 to superseded when GitHub shows a newer head', async () => {
    const completion = conflictingCompletion();
    const pullRequestIdentityReader = vi.fn(async () => ({ baseSha: BASE, headSha: NEWER_HEAD }));
    const h = harness({ completion, pullRequestIdentityReader });
    const error = await runPublishingReviewWorker(env(), h.deps).catch((e) => e);
    expect(error).toBeInstanceOf(ReviewSupersededError);
    expect(error).toMatchObject({ stage: 'completion', currentHeadSha: NEWER_HEAD });
    expect(pullRequestIdentityReader).toHaveBeenCalledWith({ token: 'ghs_test', repo: 'calltelemetry/ct-meta', prNumber: 3403 });
    // The review's own success check stays; nothing contradicts it afterwards.
    expect(h.checkClient.completeCheck).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conclusion: 'success' }));
    expect(completion.reportTerminalFailure).not.toHaveBeenCalled();
  });

  it('keeps a 409 on an unchanged head as the original error', async () => {
    const h = harness({
      completion: conflictingCompletion(),
      pullRequestIdentityReader: vi.fn(async () => ({ baseSha: BASE, headSha: HEAD })),
    });
    const error = await runPublishingReviewWorker(env(), h.deps).catch((e) => e);
    expect(error).toBeInstanceOf(WorkerCompletionHttpError);
    expect(error.message).toBe('worker completion callback failed with HTTP 409');
  });

  it('keeps a 409 as the original error when the head cannot be read', async () => {
    const h = harness({
      completion: conflictingCompletion(),
      pullRequestIdentityReader: vi.fn(async () => { throw new Error('GitHub down'); }),
    });
    await expect(runPublishingReviewWorker(env(), h.deps)).rejects.toBeInstanceOf(WorkerCompletionHttpError);
  });

  it('never reinterprets a non-409 completion failure', async () => {
    const pullRequestIdentityReader = vi.fn(async () => ({ baseSha: BASE, headSha: NEWER_HEAD }));
    const h = harness({ completion: conflictingCompletion(503), pullRequestIdentityReader });
    await expect(runPublishingReviewWorker(env(), h.deps)).rejects.toBeInstanceOf(WorkerCompletionHttpError);
    expect(pullRequestIdentityReader).not.toHaveBeenCalled();
  });
});

describe('completion transport status (REL-1057)', () => {
  it('carries the HTTP status on a rejected legacy completion without changing its message', async () => {
    const adapter = new HttpWorkerCompletionAdapter({
      token: 'ghs_test',
      endpoint: 'https://dispatch.example.invalid/api/dispatch/completion',
      fetchImplementation: vi.fn(async () => new Response('{}', { status: 409 })) as never,
    });
    const error = await adapter.reportTerminalSuccess({} as never).catch((e) => e);
    expect(error).toBeInstanceOf(WorkerCompletionHttpError);
    expect(error.httpStatus).toBe(409);
    expect(error.message).toBe('worker completion callback failed with HTTP 409');
  });
});

describe('worker/operator superseded marker contract', () => {
  it('matches the operator constant', () => {
    const go = readFileSync(join(__dirname, '../../k8s-operator/controllers/worker_superseded.go'), 'utf8');
    // Whitespace-tolerant: gofmt may realign `=` across a const block.
    expect(/\bworkerSupersededMarker\s*=\s*"([^"]*)"/u.exec(go)?.[1]).toBe(WORKER_SUPERSEDED_TERMINATION_MARKER);
  });

  it('leads the termination message with the marker on a single line', () => {
    const message = workerSupersededTerminationMessage(new ReviewSupersededError('pre_review', HEAD, NEWER_HEAD));
    expect(message.startsWith(`${WORKER_SUPERSEDED_TERMINATION_MARKER} `)).toBe(true);
    expect(message.trim().split('\n')).toHaveLength(1);
  });
});
