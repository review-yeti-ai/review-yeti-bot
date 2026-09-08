import { describe, expect, it, vi } from 'vitest';
import {
  bifrostTransport,
  classifyFailure,
  createBifrostPublishingConfig,
  isPublishingReviewWorker,
  publishingConclusion,
  publishingReviewIdentity,
  runPublishingReviewWorker,
} from '../../src/cli/publishingReview';

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
    // Retained as a last line of defence. Since the worker now sources the
    // verdict and the blocking count from the same arbitration result, this
    // combination should be unreachable in practice -- but if it ever occurs
    // again, the findings still win over the verdict.
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
    const d = deps({
      panelRunner: vi.fn(async () => ({
        // Anchored to the diff. A bare `{ severity: 'P1' }` is discarded by
        // sanitizeFindings as unanchorable, so it would no longer block -- which
        // is the documented contract, now that the count follows arbitration.
        personas: [{ findings: [{ severity: 'P1', path: 'src/a.ts', line: 1, title: 'Blocking', body: 'Blocking' }] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('failure');
    expect(receipt.blockingFindingCount).toBe(1);
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

  it('parses the changed-file path from the header line, not the whole patch', async () => {
    // The regression: a dotall `b/(.*?)` capture ran to end-of-string and put the
    // entire patch into the path. That path matched no finding, sanitizeFinding
    // discarded every finding for the last file in the diff -- every finding, in a
    // single-file diff -- arbitration saw none, and the lane returned SHIP
    // unconditionally. It could not block on anything.
    const d = deps({
      panelRunner: vi.fn(async () => ({
        personas: [{ findings: [{ severity: 'P1', path: 'src/a.ts', line: 1, title: 'Real', body: 'Real' }] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);

    // A finding anchored to the only file in the diff must survive sanitisation.
    expect(receipt.findingCount).toBe(1);
    expect(receipt.blockingFindingCount).toBe(1);
    expect(receipt.verdict).not.toBe('SHIP');
    expect(receipt.conclusion).toBe('failure');
  });

  it('never publishes a verdict that disagrees with its own finding count', async () => {
    // The observed defect: a published check read `Review Yeti: SHIP` with
    // `blocking P0/P1: 2` and a `failure` conclusion. The two numbers came from
    // different sets -- arbitration counts findings sanitised against the diff,
    // while this lane counted every raw persona finding, so a finding pointing
    // outside the changed files was excluded from the verdict and included in
    // the summary. A verdict and its own evidence must not contradict.
    const d = deps({
      panelRunner: vi.fn(async () => ({
        personas: [{
          findings: [
            // Outside the changed files: arbitration drops it, so it must not be
            // counted as blocking either.
            { severity: 'P1', path: 'src/not-in-this-diff.ts', line: 9, title: 'Elsewhere', body: 'Elsewhere' },
            // Anchored: this one is real and must survive into the counts.
            { severity: 'P1', path: 'src/a.ts', line: 1, title: 'Anchored', body: 'Anchored' },
          ],
        }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);

    // Whatever the verdict is, the counts must be the ones it was computed from.
    if (receipt.verdict === 'SHIP') {
      expect(receipt.blockingFindingCount).toBe(0);
      expect(receipt.conclusion).toBe('success');
    } else {
      expect(receipt.blockingFindingCount).toBeGreaterThan(0);
      expect(receipt.conclusion).toBe('failure');
    }

    // And the published summary must agree with the receipt it was built from.
    const calls = d.checkClient.completeCheck.mock.calls as unknown as Array<[{ title: string; summary: string }]>;
    const call = calls[calls.length - 1][0];
    expect(call.title).toBe(`Review Yeti: ${receipt.verdict}`);
    expect(call.summary).toContain(`blocking P0/P1: ${receipt.blockingFindingCount}`);
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

  it('rejects a malformed identity before creating a check', async () => {
    const d = deps();
    await expect(runPublishingReviewWorker(env({ REVIEW_HEAD_SHA: 'nope' }), d as never))
      .rejects.toThrow(/contract is invalid/u);
    expect(d.checkClient.createCheck).not.toHaveBeenCalled();
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
    ['fetch failed', 'transport'],
  ])('classifies %s as %s', (message, expected) => {
    expect(classifyFailure(new Error(message))).toBe(expected);
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
