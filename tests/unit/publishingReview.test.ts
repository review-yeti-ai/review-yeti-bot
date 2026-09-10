import { describe, expect, it, vi } from 'vitest';
import {
  bifrostTransport,
  classifyFailure,
  createBifrostPublishingConfig,
  isPublishingReviewWorker,
  parseChangedFiles,
  publishingConclusion,
  publishingReviewIdentity,
  resolveWorkerConfig,
  runPublishingReviewWorker,
} from '../../src/cli/publishingReview';
import { HttpWorkerCompletionAdapter } from '../../src/review/workerCompletion';
import {
  OpenRouterConnectionError,
  OpenRouterResponseError,
  OpenRouterTimeoutError,
} from '../../src/gateway/openRouterClient';
import { UpstreamCapacityRejectionError } from '../../src/gateway/providerCapacityManager';
import { logger } from '../../src/utils/logger';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  // This repo's ProcessEnv is augmented with a required NODE_ENV.
  return {
    NODE_ENV: 'test',
    REVIEW_PUBLICATION_MODE: 'app-gate',
    REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
    REVIEW_REPO: 'calltelemetry/ct-meta',
    REVIEW_REPOSITORY_ID: '1339040553',
    REVIEW_POLICY_DIGEST: 'c'.repeat(64),
    REVIEW_CONFIG_DIGEST: 'd'.repeat(64),
    REVIEW_EXECUTION_ATTEMPT: '1',
    REVIEW_PR_NUMBER: '2795',
    REVIEW_HEAD_SHA: HEAD,
    REVIEW_BASE_SHA: BASE,
    REVIEW_MODEL: 'ollama/glm-5.3-flash',
    BIFROST_BASE_URL: 'https://gateway.example.invalid/v1',
    BIFROST_PR_REVIEW_API_KEY: 'vk-test',
    GH_TOKEN: 'ghs_test',
    ...overrides,
  };
}

function checkClient() {
  return {
    createCheck: vi.fn(async () => 4242),
    completeCheck: vi.fn(async () => {}),
  };
}

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

function deps(over: Record<string, unknown> = {}) {
  return {
    checkClient: checkClient(),
    sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    panelRunner: vi.fn(async () => ({
      personas: [{ findings: [] }],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    })) as never,
    client: {} as never,
    ...over,
  };
}

describe('qualification source arguments', () => {
  it('passes the full owner/repo, and no owner field, to the source loader', async () => {
    // The loader's input has no `owner` key and parses the slash out of `repo`
    // itself. Passing the bare repo name made every real app-gate run die with
    // "GitHub qualification repository is invalid" while this suite stayed green,
    // because the mock accepted any arguments. Assert the arguments, not just the
    // call.
    const loader = vi.fn(async () => ({ diff: DIFF, githubReads: 1 }));
    await runPublishingReviewWorker(env(), deps({ sourceLoader: loader as never }));

    expect(loader).toHaveBeenCalledTimes(1);
    const arg = (loader.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(arg.repo).toBe('calltelemetry/ct-meta');
    expect(arg).not.toHaveProperty('owner');
    expect(arg.prNumber).toBe(2795);
  });
});

describe('check run ownership', () => {
  it('reuses REVIEW_CHECK_ID from environment and does not call createCheck', async () => {
    const d = deps();
    await runPublishingReviewWorker(env({ REVIEW_CHECK_ID: '998877' }), d);
    expect(d.checkClient.createCheck).not.toHaveBeenCalled();
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ checkId: 998877 }),
    );
  });

  it('calls createCheck when REVIEW_CHECK_ID is absent', async () => {
    const d = deps();
    await runPublishingReviewWorker(env(), d);
    expect(d.checkClient.createCheck).toHaveBeenCalledWith('calltelemetry', 'ct-meta', HEAD,
      `${env().REVIEW_RUN_ID}:a1`);
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ checkId: 4242 }),
    );
  });
});

describe('callback rollout compatibility', () => {
  it.each(['0', '-1', '1.5', 'not-a-number', 'NaN', 'Infinity', '9007199254740992'])(
    'rejects explicit invalid execution attempt %s even with callbacks disabled', (attempt) => {
      // Every other identity field is valid; this must reach the attempt guard.
      expect(publishingReviewIdentity(env()).executionAttempt).toBe(1);
      for (const callbackEnabled of [false, true]) {
        expect(() => publishingReviewIdentity(env({ REVIEW_EXECUTION_ATTEMPT: attempt }), { callbackEnabled }))
          .toThrow(/contract is invalid/u);
      }
    },
  );

  it.each([1, 2, Number.MAX_SAFE_INTEGER])('accepts explicit safe execution attempt %s', (attempt) => {
    expect(publishingReviewIdentity(env({ REVIEW_EXECUTION_ATTEMPT: String(attempt) }), { callbackEnabled: true })
      .executionAttempt).toBe(attempt);
  });

  it.each([undefined, '', '   '])('requires an execution attempt for an injected adapter without a URL: %s', async (attempt) => {
    const workerEnv = env();
    workerEnv.REVIEW_EXECUTION_ATTEMPT = attempt;
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const d = deps({ completion });
    await expect(runPublishingReviewWorker(workerEnv, d)).rejects.toThrow(/contract is invalid/u);
    expect(d.checkClient.createCheck).not.toHaveBeenCalled();
    expect(d.checkClient.completeCheck).not.toHaveBeenCalled();
    expect(d.sourceLoader).not.toHaveBeenCalled();
    expect(d.panelRunner).not.toHaveBeenCalled();
    expect(completion.reportTerminalFailure).not.toHaveBeenCalled();
  });

  it('uses execution attempt 1 for a legacy worker with callback disabled', () => {
    expect(publishingReviewIdentity(env({ REVIEW_EXECUTION_ATTEMPT: '' })).executionAttempt).toBe(1);
  });

  it('requires an injected execution attempt when callback reporting is enabled', () => {
    expect(() => publishingReviewIdentity(env({
      REVIEW_EXECUTION_ATTEMPT: '',
      REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
    }))).toThrow(/contract is invalid/u);
  });

  it('fails closed for an explicit malformed callback URL', async () => {
    const d = deps();
    await expect(runPublishingReviewWorker(env({ REVIEW_COMPLETION_URL: 'http://dispatch.example.invalid/completion' }), d as never))
      .rejects.toThrow(/contract is invalid/u);
    expect(d.checkClient.createCheck).not.toHaveBeenCalled();
  });

  it.each([
    'not-a-url',
    'http://dispatch.example.invalid/completion',
    'https://user:password@dispatch.example.invalid/completion',
    'https://dispatch.example.invalid/completion#redirect',
  ])('validates an explicit callback URL before side effects with an injected adapter: %s', async (endpoint) => {
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const d = deps({ completion });
    await expect(runPublishingReviewWorker(env({ REVIEW_COMPLETION_URL: endpoint }), d as never))
      .rejects.toThrow(/contract is invalid/u);
    expect(d.checkClient.createCheck).not.toHaveBeenCalled();
    expect(completion.reportTerminalFailure).not.toHaveBeenCalled();
  });

  it('does not silently ignore a valid callback URL without an adapter', async () => {
    const d = deps();
    await expect(runPublishingReviewWorker(env({
      REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
    }), d as never)).rejects.toThrow(/contract is invalid/u);
    expect(d.checkClient.createCheck).not.toHaveBeenCalled();
  });
});

describe('publishing review lane admission', () => {
  it('admits only an app-gate dispatch', () => {
    expect(isPublishingReviewWorker(env())).toBe(true);
    expect(isPublishingReviewWorker(env({ REVIEW_PUBLICATION_MODE: 'disabled' }))).toBe(false);
  });

  it.each([
    'REVIEW_RECEIPT_ONLY',
    'REVIEW_FULL_PANEL_QUALIFICATION_ONLY',
    'REVIEW_SAME_HEAD_QUALIFICATION_ONLY',
    'REVIEW_PANEL_QUALIFICATION_ONLY',
    'REVIEW_PROVIDER_QUALIFICATION_ONLY',
  ])('never admits a run that is also %s', (flag) => {
    // Each lane is excluded explicitly, so a future lane cannot fall into
    // publishing merely by not being named here.
    expect(isPublishingReviewWorker(env({ [flag]: 'true' }))).toBe(false);
  });
});

describe('Bifrost is the only transport', () => {
  it('accepts the gateway', () => {
    expect(bifrostTransport(env()).baseUrl).toBe('https://gateway.example.invalid/v1');
  });

  it.each(['BIFROST_BASE_URL', 'BIFROST_PR_REVIEW_API_KEY', 'REVIEW_MODEL'])(
    'refuses to run when %s is absent rather than defaulting',
    (name) => {
      // The legacy runner defaults its base URL to openrouter.ai. Defaulting here
      // would silently review against the wrong provider.
      expect(() => bifrostTransport(env({ [name]: '' }))).toThrow(/contract is invalid/u);
    },
  );

  it('refuses a non-https gateway', () => {
    expect(() => bifrostTransport(env({ BIFROST_BASE_URL: 'http://gateway.example.invalid/v1' })))
      .toThrow(/contract is invalid/u);
  });

  it('builds a single-provider panel from the operator-injected model', () => {
    const config = createBifrostPublishingConfig('ollama/glm-5.3-flash');

    expect(config.reviewers.fallback).toBe('none');
    expect(config.reviewers.providers).toEqual([expect.objectContaining({
      id: 'bifrost',
      enabled: true,
      model: 'ollama/glm-5.3-flash',
    })]);
    expect(config.reviewers.arbiter.order).toEqual(['bifrost']);
    expect(config.personas.every((persona) => persona.providers.every((provider) => provider === 'bifrost'))).toBe(true);
  });
});

describe('fail-closed conclusion mapping', () => {
  it('passes only a clean SHIP', () => {
    expect(publishingConclusion('SHIP', 0)).toBe('success');
  });

  it.each([['BLOCK', 0], ['FIX_FIRST', 0], ['', 0], ['UNKNOWN_VERDICT', 0], ['SHIP', 1]] as const)(
    'fails verdict=%s blocking=%s',
    (verdict, blocking) => {
      expect(publishingConclusion(verdict, blocking)).toBe('failure');
    },
  );

  it('fails a SHIP that still carries a blocking finding', () => {
    // A verdict and its findings can disagree; the findings win.
    expect(publishingConclusion('SHIP', 2)).toBe('failure');
  });
});

describe('runPublishingReviewWorker', () => {
  it('publishes success for a clean panel', async () => {
    const d = deps();
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('success');
    expect(receipt.transport).toBe('bifrost');
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'success', checkId: 4242 }),
    );
  });

  it('publishes failure when the panel blocks', async () => {
    // The finding must carry a path inside the diff. Arbitration drops findings
    // it cannot attribute to a changed file, and the blocking count is now taken
    // from that canonical set -- so a pathless finding is not blocking, it is
    // unusable. See the sibling test below.
    const d = deps({
      panelRunner: vi.fn(async () => ({
        personas: [{ findings: [{ severity: 'P1', path: 'src/a.ts', line: 1, title: 'Blocking', body: 'Must fix' }] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('failure');
    expect(receipt.blockingFindingCount).toBe(1);
  });

  it('does not count a finding that arbitration discarded', async () => {
    // Regression: the blocking count came from raw persona output while the
    // verdict came from the canonical set, so a check could read `SHIP` and
    // `blocking P0/P1: 13` at once and publish nothing an author could act on.
    const d = deps({
      panelRunner: vi.fn(async () => ({
        personas: [{ findings: [{ severity: 'P1' }] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.blockingFindingCount).toBe(0);
    expect(receipt.conclusion).toBe('success');
  });

  it('publishes the findings into the check output', async () => {
    // A count with nothing attached is not reviewable. `text` and annotations
    // need only `checks: write`, which this worker already holds.
    const client = checkClient();
    const d = deps({
      checkClient: client,
      panelRunner: vi.fn(async () => ({
        personas: [{ findings: [{ severity: 'P1', path: 'src/a.ts', line: 1, title: 'Null deref', body: 'Crashes on empty input' }] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    await runPublishingReviewWorker(env(), d as never);
    const arg = (client.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(String(arg.text)).toContain('Null deref');
    expect(String(arg.text)).toContain('src/a.ts');
    const annotations = arg.annotations as Array<Record<string, unknown>>;
    expect(annotations).toHaveLength(1);
    expect(annotations[0].path).toBe('src/a.ts');
    expect(annotations[0].annotation_level).toBe('failure');
  });

  it('fails the check when a diff header cannot be read, and names it', async () => {
    // The headline safety behaviour of this change: a header no path can be read
    // from means an UNREVIEWED file, so a verdict published over it describes
    // less than the diff. Deleting the `unreadable` branch must not stay green.
    const client = checkClient();
    const d = deps({
      checkClient: client,
      sourceLoader: vi.fn(async () => ({
        diff: `${DIFF}diff --git nonsense\n@@ -1 +1 @@\n-a\n+b\n`,
        githubReads: 1,
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);

    // The panel still saw the readable file, and still said SHIP.
    expect(receipt.verdict).toBe('SHIP');
    expect(receipt.blockingFindingCount).toBe(0);
    // The check does not.
    expect(receipt.conclusion).toBe('failure');
    const arg = (client.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(arg.conclusion).toBe('failure');
    expect(String(arg.summary)).toContain('diff --git nonsense');
    expect(String(arg.summary)).toContain('were NOT reviewed');
  });

  it('reports the findings arbitration discarded', async () => {
    // A discarded finding used to vanish with no trace. If the model locates a
    // real blocking finding on the wrong line, the count is the only signal that
    // anything was dropped.
    const client = checkClient();
    const d = deps({
      checkClient: client,
      panelRunner: vi.fn(async () => ({
        personas: [{
          findings: [
            { severity: 'P2', path: 'src/a.ts', line: 1, title: 'Kept', body: 'anchored' },
            { severity: 'P1', title: 'Dropped', body: 'no path, cannot be anchored' },
          ],
        }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    await runPublishingReviewWorker(env(), d as never);
    const arg = (client.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(String(arg.summary)).toContain('1 raw finding(s) were discarded as unanchorable');
  });

  it('does not mention discards when nothing was discarded', async () => {
    const client = checkClient();
    const d = deps({ checkClient: client });
    await runPublishingReviewWorker(env(), d as never);
    const arg = (client.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(String(arg.summary)).not.toContain('discarded as unanchorable');
  });

  it('keeps every annotation path inside the diff', async () => {
    // A guard, not a behaviour: sanitizeFinding already drops off-diff findings,
    // so nothing should ever reach the annotation set with a foreign path.
    // GitHub rejects such an annotation and fails the whole PATCH, which would
    // take the verdict with it.
    const client = checkClient();
    const d = deps({
      checkClient: client,
      panelRunner: vi.fn(async () => ({
        personas: [{ findings: [{ severity: 'P1', path: 'src/a.ts', line: 1, title: 'InDiff', body: 'x' }] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    await runPublishingReviewWorker(env(), d as never);
    const arg = (client.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    for (const a of (arg.annotations as Array<Record<string, unknown>>)) {
      expect(a.path).toBe('src/a.ts');
    }
  });

  it('keeps P2-only findings advisory even when the model arbiter says FIX_FIRST', async () => {
    const d = deps({
      panelRunner: vi.fn(async () => ({
        personas: [{ findings: [{ severity: 'P2', path: 'docs/guide.md', line: 1, title: 'Advisory', body: 'Advisory' }] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'FIX_FIRST' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.verdict).toBe('SHIP');
    expect(receipt.conclusion).toBe('success');
    expect(receipt.blockingFindingCount).toBe(0);
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'success', title: 'Review Yeti: SHIP' }),
    );
  });

  it('concludes failure — never neutral or success — when the provider fails', async () => {
    // The whole point of fail-closed: an outage must block, not silently stop
    // enforcing. completeCheck cannot express neutral, and success is never used.
    const d = deps({ panelRunner: vi.fn(async () => { throw new Error('429 rate limit'); }) as never });
    await expect(runPublishingReviewWorker(env(), d as never)).rejects.toThrow(/rate limit/u);
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'failure' }),
    );
  });

  it('reports a typed terminal failure after fail-closed publication', async () => {
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const d = deps({
      completion,
      panelRunner: vi.fn(async () => { throw new Error('429 rate limit'); }) as never,
    });
    await expect(runPublishingReviewWorker(env(), d as never)).rejects.toThrow(/rate limit/u);
    expect(completion.reportTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      version: 'WorkerTerminalFailure.v1',
      runId: env().REVIEW_RUN_ID,
      checkId: 4242,
      failureClass: 'rate_limit',
    }));
  });

  it('does not report completion for a successful review', async () => {
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const d = deps({ completion });
    await runPublishingReviewWorker(env(), d as never);
    expect(completion.reportTerminalFailure).not.toHaveBeenCalled();
  });

  it('refuses to ship an empty diff as a clean review', async () => {
    const d = deps({ sourceLoader: vi.fn(async () => ({ diff: '', githubReads: 1 })) as never });
    await expect(runPublishingReviewWorker(env(), d as never)).rejects.toThrow(/no reviewable diff/u);
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'failure' }),
    );
  });

  it('still fails the job when the fail-closed publish itself cannot be written', async () => {
    const cc = { createCheck: vi.fn(async () => 1), completeCheck: vi.fn(async () => { throw new Error('GitHub down'); }) };
    const d = deps({ checkClient: cc, panelRunner: vi.fn(async () => { throw new Error('boom'); }) as never });
    // The original failure propagates so the Job fails and the admission deadline
    // can reap it, rather than being masked by the publish error.
    await expect(runPublishingReviewWorker(env(), d as never)).rejects.toThrow(/boom/u);
  });

  it('reports a durable failure when check creation fails before a check id exists', async () => {
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const d = deps({
      checkClient: {
        createCheck: vi.fn(async () => { throw new Error('check provider response contains sensitive detail'); }),
        completeCheck: vi.fn(async () => {}),
      },
      completion,
    });
    await expect(runPublishingReviewWorker(env(), d as never)).rejects.toThrow(/sensitive detail/u);
    expect(d.checkClient.completeCheck).not.toHaveBeenCalled();
    expect(completion.reportTerminalFailure).toHaveBeenCalledOnce();
    const event = (completion.reportTerminalFailure as any).mock.calls[0][0] as Record<string, unknown>;
    expect(event).not.toHaveProperty('checkId');
    expect(event).toMatchObject({
      runId: env().REVIEW_RUN_ID,
      repositoryId: 1339040553,
      executionAttempt: 1,
      failureClass: 'provider_error',
    });
  });

  it('reports a durable contract failure after check creation instead of skipping the callback', async () => {
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const d = deps({ completion });
    await expect(runPublishingReviewWorker(env({ BIFROST_BASE_URL: '' }), d as never))
      .rejects.toThrow(/contract is invalid/u);
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(expect.objectContaining({
      checkId: 4242,
      conclusion: 'failure',
    }));
    expect(completion.reportTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      checkId: 4242,
      failureClass: 'contract',
    }));
  });

  it('rejects a malformed identity before creating a check', async () => {
    const d = deps();
    await expect(runPublishingReviewWorker(env({ REVIEW_HEAD_SHA: 'nope' }), d as never))
      .rejects.toThrow(/contract is invalid/u);
    expect(d.checkClient.createCheck).not.toHaveBeenCalled();
  });

  it('preserves the check-creation error when the completion callback also fails', async () => {
    const original = new Error('check creation rejected');
    const callbackError = new Error('private callback response ghs_do_not_log');
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const completion = { reportTerminalFailure: vi.fn().mockRejectedValue(callbackError) };
    const cc = checkClient();
    cc.createCheck.mockRejectedValue(original);
    const d = deps({ checkClient: cc, completion });

    await expect(runPublishingReviewWorker(env(), d)).rejects.toBe(original);
    expect(cc.completeCheck).not.toHaveBeenCalled();
    expect(d.sourceLoader).not.toHaveBeenCalled();
    expect(d.panelRunner).not.toHaveBeenCalled();
    expect(completion.reportTerminalFailure).toHaveBeenCalledOnce();
    expect(completion.reportTerminalFailure.mock.calls[0][0]).not.toHaveProperty('checkId');
    expect(log).toHaveBeenCalledExactlyOnceWith('Failed to persist worker terminal failure', {
      runId: env().REVIEW_RUN_ID, failureClass: 'internal_error', reason: 'completion_callback_failed',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(callbackError.message);
  });

  it('still reports the exact run failure when failure publication and the callback both fail', async () => {
    const original = new Error('429 private provider response');
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const cc = checkClient();
    cc.completeCheck.mockRejectedValue(new Error('private check response ghs_do_not_log'));
    const completion = { reportTerminalFailure: vi.fn().mockRejectedValue(new Error('private callback response')) };
    const d = deps({ checkClient: cc, completion, panelRunner: vi.fn().mockRejectedValue(original) });

    await expect(runPublishingReviewWorker(env({ REVIEW_EXECUTION_ATTEMPT: '2' }), d)).rejects.toBe(original);
    expect(cc.completeCheck).toHaveBeenCalledOnce();
    expect(cc.completeCheck).toHaveBeenCalledWith(expect.objectContaining({ checkId: 4242, conclusion: 'failure' }));
    expect(completion.reportTerminalFailure).toHaveBeenCalledExactlyOnceWith({
      version: 'WorkerTerminalFailure.v1', runId: env().REVIEW_RUN_ID,
      repositoryId: 1339040553, owner: 'calltelemetry', repo: 'ct-meta', prNumber: 2795,
      headSha: HEAD, baseSha: BASE, policyDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64),
      executionAttempt: 2, checkId: 4242, failureClass: 'rate_limit',
    });
    expect(log.mock.calls).toEqual([
      ['Failed to publish the fail-closed conclusion', {
        runId: env().REVIEW_RUN_ID, failureClass: 'rate_limit', reason: 'check_publication_failed',
      }],
      ['Failed to persist worker terminal failure', {
        runId: env().REVIEW_RUN_ID, failureClass: 'rate_limit', reason: 'completion_callback_failed',
      }],
    ]);
    expect(JSON.stringify([log.mock.calls, completion.reportTerminalFailure.mock.calls, cc.completeCheck.mock.calls]))
      .not.toContain('private');
  });

  it('reports a source-load failure without invoking the panel', async () => {
    const original = new Error('fetch failed');
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const d = deps({ completion, sourceLoader: vi.fn().mockRejectedValue(original) });
    await expect(runPublishingReviewWorker(env(), d)).rejects.toBe(original);
    expect(d.panelRunner).not.toHaveBeenCalled();
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'failure' }));
    expect(completion.reportTerminalFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      checkId: 4242, failureClass: 'transport',
    }));
  });

  it('reports a terminal failure when publishing a successful review fails', async () => {
    const original = new Error('check publication timeout');
    const cc = checkClient();
    cc.completeCheck.mockRejectedValueOnce(original);
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    await expect(runPublishingReviewWorker(env(), deps({ checkClient: cc, completion }))).rejects.toBe(original);
    expect(cc.completeCheck).toHaveBeenNthCalledWith(1, expect.objectContaining({ conclusion: 'success', checkId: 4242 }));
    expect(cc.completeCheck).toHaveBeenNthCalledWith(2, expect.objectContaining({ conclusion: 'failure', checkId: 4242 }));
    expect(completion.reportTerminalFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      checkId: 4242, failureClass: 'timeout',
    }));
  });
});

describe('identity and failure classification', () => {
  it('parses owner and repo', () => {
    const id = publishingReviewIdentity(env());
    expect(id.owner).toBe('calltelemetry');
    expect(id.repoName).toBe('ct-meta');
  });

  it.each([
    ['virtual key not found', 'auth'],
    ['429 rate limit', 'rate_limit'],
    ['request timed out', 'timeout'],
    ['persona dep-lane failed closed: bifrost: OpenRouter compatibility response exceeded total deadline of 300000ms', 'timeout'],
    ['fetch failed', 'transport'],
    ['invalid native JSON response object', 'malformed_output'],
    ['invalid findings contract at index 0', 'malformed_output'],
    ['APPROVE cannot contain findings', 'malformed_output'],
    ['FINDINGS requires at least one finding', 'malformed_output'],
    ['nonce-fenced structured output rejected', 'malformed_output'],
    ['gateway returned an unexpected payload', 'provider_error'],
  ])('classifies %s as %s', (message, expected) => {
    expect(classifyFailure(new Error(message))).toBe(expected);
  });

  it('does not label an unknown worker exception as a provider outage', () => {
    expect(classifyFailure(new Error('unexpected invariant violation'))).toBe('internal_error');
  });

  it.each([
    [new OpenRouterTimeoutError('deadline'), 'timeout'],
    [new OpenRouterConnectionError('socket closed'), 'transport'],
    [new OpenRouterResponseError('unauthorized', 401), 'auth'],
    [new OpenRouterResponseError('forbidden', 403), 'auth'],
    [new OpenRouterResponseError('busy', 429), 'rate_limit'],
    [new OpenRouterResponseError('upstream failed', 503), 'provider_error'],
    [new UpstreamCapacityRejectionError('bifrost', 'queue full'), 'rate_limit'],
  ])('classifies typed gateway error %s as %s', (error, expected) => {
    expect(classifyFailure(error)).toBe(expected);
  });
});

describe('worker terminal failure adapter', () => {
  it('sends only the typed failure event with the scoped worker token', async () => {
    const fetchImplementation = vi.fn(async () => new Response('', { status: 202 }));
    const adapter = new HttpWorkerCompletionAdapter({
      token: 'ghs_test',
      endpoint: 'https://dispatch.example.test/completion',
      fetchImplementation,
    });
    const event = {
      version: 'WorkerTerminalFailure.v1' as const,
      runId: `run_${'c'.repeat(32)}`,
      repositoryId: 1339040553,
      owner: 'calltelemetry',
      repo: 'ct-meta',
      prNumber: 2795,
      headSha: HEAD,
      baseSha: BASE,
      policyDigest: 'c'.repeat(64),
      configDigest: 'd'.repeat(64),
      executionAttempt: 1,
      checkId: 4242,
      failureClass: 'provider_error' as const,
    };

    await adapter.reportTerminalFailure(event);

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://dispatch.example.test/completion',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer ghs_test' }),
        body: JSON.stringify(event),
        redirect: 'error',
      }),
    );
  });

  it('rejects a non-HTTPS completion endpoint', () => {
    expect(() => new HttpWorkerCompletionAdapter({
      token: 'ghs_test',
      endpoint: 'http://dispatch.example.test/completion',
    })).toThrow(/HTTPS/u);
  });

  it('rejects completion endpoint userinfo', () => {
    expect(() => new HttpWorkerCompletionAdapter({
      token: 'ghs_test',
      endpoint: 'https://user:password@dispatch.example.test/completion',
    })).toThrow(/userinfo/u);
  });
});

describe('worker dispatch ordering (safety critical)', () => {
  it('routes an app-gate dispatch to the publishing lane, never the legacy runner', async () => {
    // runLiveReviewMain resolves repo/PR from argv with a hardcoded fallback and
    // defaults its base URL to openrouter.ai. If app-gate ever fell through to it,
    // a DOKS dispatch would review the wrong repository against the wrong provider.
    const { runWorker } = await import('../../src/cli/runLiveReview');
    const live = vi.fn(async () => {});
    const publishing = vi.fn(async () => {});
    const noop = vi.fn(async () => {});

    await runWorker(env(), live, noop, noop, noop, noop, publishing);

    expect(publishing).toHaveBeenCalledTimes(1);
    expect(live).not.toHaveBeenCalled();
  });

  it('still routes a disabled dispatch to receipt-only, not publishing or legacy', async () => {
    const { runWorker } = await import('../../src/cli/runLiveReview');
    const live = vi.fn(async () => {});
    const publishing = vi.fn(async () => {});
    const noop = vi.fn(async () => {});

    // runReceiptOnlyWorker is called directly rather than through an injected
    // runner, so reaching it is observable as its own contract error on this
    // deliberately minimal env. That it throws *that* error -- rather than
    // invoking either spy -- is the proof the dispatch landed in receipt-only.
    await expect(runWorker(
      env({ REVIEW_PUBLICATION_MODE: 'disabled', REVIEW_RECEIPT_ONLY: 'true' }),
      live, noop, noop, noop, noop, publishing,
    )).rejects.toThrow(/receipt-only worker contract is invalid/u);

    expect(publishing).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
  });
});

describe('the worker never holds the App private key', () => {
  it('refuses to publish without a ghs_ scoped token', async () => {
    // The operator asserts the same boundary. This pod parses untrusted diffs and
    // executes model output; an App private key here would let a compromised
    // worker mint tokens for every installation.
    const { runWorker } = await import('../../src/cli/runLiveReview');
    const noop = vi.fn(async () => {});
    await expect(runWorker(
      env({ GITHUB_PUBLISH_TOKEN: '' }),
      noop, noop, noop, noop, noop,
    )).rejects.toThrow(/requires a ghs_ installation token/u);
  });

  it('refuses a token that is not an installation token', async () => {
    const { runWorker } = await import('../../src/cli/runLiveReview');
    const noop = vi.fn(async () => {});
    // A PAT or App JWT would carry far broader scope than one repository.
    await expect(runWorker(
      env({ GITHUB_PUBLISH_TOKEN: 'ghp_personal_access_token' }),
      noop, noop, noop, noop, noop,
    )).rejects.toThrow(/requires a ghs_ installation token/u);
  });
});

describe('resolveWorkerConfig policy projection & telemetry persistence', () => {
  const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'vk-test', model: 'ollama/glm-5.3-flash' };

  it('defaults to 6 central personas and max 2 turns under default env', () => {
    const config = resolveWorkerConfig(env(), transport);
    expect(config.personas).toHaveLength(6);
    expect(config.personas.map((p) => p.id)).toEqual([
      'sec-lane',
      'perf-lane',
      'arch-lane',
      'qual-lane',
      'dep-lane',
      'policy-lane',
    ]);
    expect(config.personas.find((p) => p.id === 'sec-lane')?.required).toBe(true);
    expect(config.personas.find((p) => p.id === 'perf-lane')?.required).toBe(false);
    expect(config.personas.every((p) => p.providers.length === 1 && p.providers[0] === 'bifrost')).toBe(true);
    expect(config.default_max_turns).toBe(2);
    expect(config.reviewers.arbiter.order).toEqual(['bifrost']);
    expect(config.reviewers.providers[0].id).toBe('bifrost');
    expect(config.reviewers.providers[0].model).toBe('ollama/glm-5.3-flash');
  });

  it('projects central policy from REVIEW_YETI_POLICY_JSON', () => {
    const policyJson = JSON.stringify({
      schema: 'calltelemetry.review-policy.v1',
      review_yeti: {
        personas: 'security,architecture,testing',
        budget: {
          max_investigation_turns: '3',
          lane_call_budget: '24',
        },
      },
    });
    const config = resolveWorkerConfig(env({ REVIEW_YETI_POLICY_JSON: policyJson }), transport);
    expect(config.personas.map((p) => p.id)).toEqual(['sec-lane', 'arch-lane', 'qual-lane']);
    expect(config.default_max_turns).toBe(3);
  });

  it('caps default_max_turns at 3 even if policy declares higher turns', () => {
    const policyJson = JSON.stringify({
      review_yeti: {
        personas: 'security',
        budget: { max_investigation_turns: '10' },
      },
    });
    const config = resolveWorkerConfig(env({ REVIEW_YETI_POLICY_JSON: policyJson }), transport);
    expect(config.default_max_turns).toBe(3);
  });

  it('persists per-lane metrics and totals in receipt', async () => {
    const d = deps({
      panelRunner: vi.fn(async () => ({
        personas: [
          {
            id: 'sec-lane',
            decision: 'APPROVE',
            findings: [],
            turnsCount: 2,
            toolCalls: [{ tool: 'read_file' }],
            promptTokens: 1200,
            completionTokens: 300,
            totalTokens: 1500,
            durationMs: 4000,
          },
          {
            id: 'perf-lane',
            decision: 'APPROVE',
            findings: [],
            turnsCount: 1,
            toolCalls: [],
            promptTokens: 800,
            completionTokens: 200,
            totalTokens: 1000,
            durationMs: 2500,
          },
        ],
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('success');
    expect(receipt.personas).toHaveLength(2);
    expect(receipt.personas?.[0].id).toBe('sec-lane');
    expect(receipt.personas?.[0].turnsCount).toBe(2);
    expect(receipt.personas?.[0].toolCallsCount).toBe(1);
    expect(receipt.metrics).toEqual({
      totalPromptTokens: 2000,
      totalCompletionTokens: 500,
      totalTokens: 2500,
      totalTurns: 3,
      totalToolCalls: 1,
      totalDurationMs: 6500,
    });
  });
});

describe('parseChangedFiles', () => {
  it('reads a path containing spaces', () => {
    // Regression: the header matcher used `(\S+)`, which stopped at the first
    // space. `a/sip message.txt` produced no path, the file silently dropped out
    // of the reviewed set, and any finding on it was discarded -- a review that
    // reported success over a file it never saw. cisco-cdr has eight such paths.
    const { files, unreadable } = parseChangedFiles(
      'diff --git a/test/sip message.txt b/test/sip message.txt\n' +
      'index 111..222 100644\n--- a/test/sip message.txt\n+++ b/test/sip message.txt\n' +
      '@@ -1 +1 @@\n-old\n+new\n',
    );
    expect(unreadable).toEqual([]);
    expect(files.map((f) => f.path)).toEqual(['test/sip message.txt']);
  });

  it('reads a rename, and reports the destination', () => {
    const { files } = parseChangedFiles(
      'diff --git a/old name.ts b/new name.ts\nsimilarity index 100%\n' +
      'rename from old name.ts\nrename to new name.ts\n',
    );
    expect(files.map((f) => f.path)).toEqual(['new name.ts']);
  });

  it('reads a quoted non-ASCII path', () => {
    const { files } = parseChangedFiles(
      'diff --git "a/docs/caf\\303\\251.md" "b/docs/caf\\303\\251.md"\n' +
      '--- "a/docs/caf\\303\\251.md"\n+++ "b/docs/caf\\303\\251.md"\n@@ -1 +1 @@\n-a\n+b\n',
    );
    expect(files.map((f) => f.path)).toEqual(['docs/café.md']);
  });

  it('decodes the simple escapes, not just octal ones', () => {
    // `unquoteGitPath` has two decode paths: three-digit octal and a small table
    // of `\\n \\t \\r \\" \\\\`. Only the octal path was covered, so removing an entry
    // from the table stayed green while a real path stopped matching changedPaths.
    const { files } = parseChangedFiles(
      'diff --git "a/x\\\\y \\"q\\".md" "b/x\\\\y \\"q\\".md"\n' +
      '--- "a/x\\\\y \\"q\\".md"\n+++ "b/x\\\\y \\"q\\".md"\n@@ -1 +1 @@\n-a\n+b\n',
    );
    expect(files.map((f) => f.path)).toEqual(['x\\y "q".md']);
  });

  it('reads a deletion from the pre-image', () => {
    const { files } = parseChangedFiles(
      'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n' +
      '--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n',
    );
    expect(files.map((f) => f.path)).toEqual(['gone.ts']);
  });

  it('reads a binary file with no hunk lines', () => {
    const { files } = parseChangedFiles(
      'diff --git a/logo.png b/logo.png\nindex 111..222 100644\n' +
      'Binary files a/logo.png and b/logo.png differ\n',
    );
    expect(files.map((f) => f.path)).toEqual(['logo.png']);
  });

  it('does not split on a diff header that appears inside a patch body', () => {
    const { files } = parseChangedFiles(
      'diff --git a/doc.md b/doc.md\n--- a/doc.md\n+++ b/doc.md\n' +
      '@@ -1 +1,2 @@\n a\n+diff --git a/fake.ts b/fake.ts\n',
    );
    expect(files.map((f) => f.path)).toEqual(['doc.md']);
  });

  it('reports an unreadable header instead of dropping the file', () => {
    const { files, unreadable } = parseChangedFiles('diff --git nonsense\n@@ -1 +1 @@\n-a\n+b\n');
    expect(files).toEqual([]);
    expect(unreadable).toEqual(['diff --git nonsense']);
  });
});

describe('hosted lane — repository visibility resolution', () => {
  const summaryOf = (client: ReturnType<typeof checkClient>) =>
    String(((client.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>).summary);

  it('trusts a definite value from the dispatching workflow and does not look up', async () => {
    const client = checkClient();
    const visibilityLookup = vi.fn(async () => 'PUBLIC' as const);
    await runPublishingReviewWorker(env({ REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE' }), deps({ checkClient: client, visibilityLookup }) as never);
    expect(visibilityLookup).not.toHaveBeenCalled();
    expect(summaryOf(client)).toContain('Repository visibility: PRIVATE.');
  });

  it("asks GitHub with the run's own token when the workflow did not say", async () => {
    // The first live run after visibility was introduced published UNKNOWN for a
    // private repository because nothing in production sets the env var. The lane
    // already holds a repository-scoped read token for the diff; it can ask.
    const client = checkClient();
    const visibilityLookup = vi.fn(async () => 'PRIVATE' as const);
    await runPublishingReviewWorker(env(), deps({ checkClient: client, visibilityLookup }) as never);
    expect(visibilityLookup).toHaveBeenCalledWith({ owner: 'calltelemetry', repo: 'ct-meta', token: 'ghs_test' });
    expect(summaryOf(client)).toContain('Repository visibility: PRIVATE.');
  });

  it('settles to UNKNOWN and still completes the review when the lookup fails', async () => {
    const client = checkClient();
    const visibilityLookup = vi.fn(async () => { throw new Error('repos 502'); });
    const receipt = await runPublishingReviewWorker(env(), deps({ checkClient: client, visibilityLookup }) as never);
    expect(receipt.conclusion).toBe('success');
    expect(summaryOf(client)).toContain('Repository visibility: UNKNOWN.');
  });

  it('publishes Review Yeti: SHIP (fast-ship) and fast-ship summary for fastShip panel result', async () => {
    const client = checkClient();
    const d = deps({
      checkClient: client,
      panelRunner: vi.fn(async () => ({
        isFastShip: true,
        classifierRationale: 'Docs only modification',
        tokensSaved: 12500,
        personas: [{ id: 'fast-ship', findings: [] }],
        quorum: { required: 0, distinctProviders: [], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('success');
    expect(client.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Review Yeti: SHIP (fast-ship)',
        summary: expect.stringContaining('### Review Yeti: SHIP (fast-ship)'),
      }),
    );
    expect(summaryOf(client)).toContain('Docs only modification');
    expect(summaryOf(client)).toContain('12,500 tokens saved');
  });

  it('publishes normal Review Yeti: SHIP with Telemetry line for standard panel result', async () => {
    const client = checkClient();
    const d = deps({
      checkClient: client,
      panelRunner: vi.fn(async () => ({
        personas: [{ id: 'sec-lane', findings: [] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('success');
    expect(client.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Review Yeti: SHIP',
        summary: expect.stringContaining('Telemetry:'),
      }),
    );
  });

  it('publishes only the Review Yeti check on clean SHIP review completion', async () => {
    const publishGateCheck = vi.fn(async () => 7777);
    const client = {
      ...checkClient(),
      publishGateCheck,
    };
    const d = deps({
      checkClient: client,
      panelRunner: vi.fn(async () => ({
        personas: [{ id: 'sec-lane', findings: [] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('success');
    expect(publishGateCheck).not.toHaveBeenCalled();
  });

  it('does not create a second gate check when Review Yeti fails closed', async () => {
    const publishGateCheck = vi.fn(async () => 8888);
    const client = {
      ...checkClient(),
      publishGateCheck,
    };
    const d = deps({
      checkClient: client,
      panelRunner: vi.fn(async () => {
        throw new Error('LLM Provider Outage');
      }) as never,
    });
    await expect(runPublishingReviewWorker(env(), d as never)).rejects.toThrow('LLM Provider Outage');
    expect(publishGateCheck).not.toHaveBeenCalled();
  });
});
