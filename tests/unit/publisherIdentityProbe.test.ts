import { describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';

/**
 * REL-1107: the publishing identity probes.
 *
 * Review Yeti computes a verdict and then fails to publish it when the identity cannot be
 * resolved. The original resolver discarded every probe's status and stderr, so CI logged a
 * bare "could not determine the publishing GitHub identity" with nothing an operator could act
 * on -- no way to distinguish a missing token from a revoked one from a GitHub 5xx.
 *
 * These tests pin the retry (transient only) and the reason (redacted, actionable).
 */
const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

interface ProbeResult { status: number; stdout: string; stderr: string }
type CommandRunner = (cmd: string, args: string[]) => ProbeResult;

const ok = (stdout: string): ProbeResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr: string): ProbeResult => ({ status: 1, stdout: '', stderr });

describe('publishing identity probes (REL-1107)', () => {
  describe('transient classification', () => {
    it('retries 5xx and secondary rate limits only', () => {
      const { isTransientIdentityProbeFailure } = pipeline;
      // Transient: safe to retry, because these probes mutate nothing.
      expect(isTransientIdentityProbeFailure(1, 'gh: Server Error (HTTP 502)')).toBe(true);
      expect(isTransientIdentityProbeFailure(1, 'gh: Service Unavailable (HTTP 503)')).toBe(true);
      expect(isTransientIdentityProbeFailure(1, 'gh: Gateway Timeout (HTTP 504)')).toBe(true);
      expect(isTransientIdentityProbeFailure(1, 'gh: Too Many Requests (HTTP 429)')).toBe(true);
      expect(isTransientIdentityProbeFailure(1, 'gh: HTTP 403 with retry-after: 30')).toBe(true);
      // BARE codes, not only the "HTTP <code>" form. Real stderr varies: a raw status line or a
      // bare number. Narrowing the regex to the "HTTP " form would silently stop retrying these
      // (REL-1107 review).
      expect(isTransientIdentityProbeFailure(1, 'HTTP/1.1 502 Bad Gateway')).toBe(true);
      expect(isTransientIdentityProbeFailure(1, 'gh: 502 Bad Gateway')).toBe(true);
      expect(isTransientIdentityProbeFailure(1, 'gh: 503')).toBe(true);
      expect(isTransientIdentityProbeFailure(1, 'gh: 429')).toBe(true);
      // Primary-quota exhaustion: a 403 whose headers show the quota is gone.
      expect(isTransientIdentityProbeFailure(1, 'gh: HTTP 403; x-ratelimit-remaining: 0')).toBe(true);
      // NOT transient: a real answer about the credential. Retrying only delays the diagnostic.
      expect(isTransientIdentityProbeFailure(1, 'gh: Bad credentials (HTTP 401)')).toBe(false);
      expect(isTransientIdentityProbeFailure(1, 'gh: Not Found (HTTP 404)')).toBe(false);
      expect(isTransientIdentityProbeFailure(1, 'gh: HTTP 403 (no retry header)')).toBe(false);
      expect(isTransientIdentityProbeFailure(1, 'gh: HTTP 422 Unprocessable Entity')).toBe(false);
      expect(isTransientIdentityProbeFailure(0, '')).toBe(false);
    });
  });

  describe('resolution', () => {
    it('uses GET /user when the token is a user token', () => {
      const calls: string[] = [];
      const runner: CommandRunner = (_cmd, args) => { calls.push(args.join(' ')); return ok('calltelemetry-jason\n'); };
      expect(pipeline.resolveAuthenticatedPublisher(runner))
        .toMatchObject({ login: 'calltelemetry-jason', verified: true });
      // Resolved on the first probe: the others must not be attempted.
      expect(calls).toHaveLength(1);
    });

    it('falls back to the installation app slug for an installation token', () => {
      // GET /user rejects installation tokens; the App slug identifies their publisher.
      const runner: CommandRunner = (_cmd, args) => (args.includes('user')
        ? fail('gh: Bad credentials (HTTP 401)')
        : ok('review-yeti\n'));
      expect(pipeline.resolveAuthenticatedPublisher(runner))
        .toMatchObject({ login: 'review-yeti[bot]', verified: true });
    });

    it('falls back to the GraphQL viewer', () => {
      const runner: CommandRunner = (_cmd, args) => {
        if (args.includes('graphql')) return ok('{"data":{"viewer":{"login":"calltelemetry-jason"}}}');
        return fail('gh: Bad credentials (HTTP 401)');
      };
      expect(pipeline.resolveAuthenticatedPublisher(runner))
        .toMatchObject({ login: 'calltelemetry-jason', verified: true });
    });

    it('retries a transient failure and then succeeds', () => {
      // The regression this fixes: one unlucky 503 used to fail the entire publish.
      let userCalls = 0;
      const runner: CommandRunner = (_cmd, args) => {
        if (!args.includes('user')) return fail('gh: Bad credentials (HTTP 401)');
        userCalls += 1;
        return userCalls === 1 ? fail('gh: Server Error (HTTP 502)') : ok('calltelemetry-jason\n');
      };
      expect(pipeline.resolveAuthenticatedPublisher(runner))
        .toMatchObject({ login: 'calltelemetry-jason', verified: true });
      expect(userCalls).toBe(2);
    });

    it('gives up after exhausting attempts, and reports the LAST status', () => {
      // The third outcome of the loop, which no test took: a transient failure on EVERY attempt.
      // Concrete counterfactual the review named -- changing the bound to `attempt < attempts`
      // (silently halving retries) -- must not survive this.
      let userCalls = 0;
      const runner: CommandRunner = (_cmd, args) => {
        if (!args.includes('user')) return fail('gh: Bad credentials (HTTP 401)');
        userCalls += 1;
        return fail('gh: Server Error (HTTP 502)');
      };
      const resolved = pipeline.resolveAuthenticatedPublisher(runner);
      // Exactly the bound, so a 3-attempt loop is pinned, not a 2-attempt one.
      expect(userCalls).toBe(3);
      expect(resolved).toMatchObject({ login: null, verified: false });
      // ...and the exhausted probe's LAST status reaches the reason, so an operator sees 502
      // rather than only the 401s from its siblings.
      expect(resolved.reason).toContain('user=HTTP 502');
    });

    it('survives a commandRunner that throws on the retry sleep', () => {
      // The `try { commandRunner('sleep', ...) } catch {}` guard is best-effort error handling:
      // a runner image without `sleep`, or a spawn failure, must not crash the probe loop and fail
      // the whole publish. Deleting the guard would crash here (REL-1107 review).
      let userCalls = 0;
      const runner = ((cmd: string, args: string[]) => {
        // The command NAME is the first parameter; args[0] is the delay.
        if (cmd === 'sleep') throw new Error('spawn sleep ENOENT');
        if (!args.includes('user')) return fail('gh: Bad credentials (HTTP 401)');
        userCalls += 1;
        return userCalls === 1 ? fail('gh: Server Error (HTTP 502)') : ok('calltelemetry-jason\n');
      }) as unknown as CommandRunner;
      expect(pipeline.resolveAuthenticatedPublisher(runner))
        .toMatchObject({ login: 'calltelemetry-jason', verified: true });
      // It still retried through the failed sleep rather than abandoning the probe.
      expect(userCalls).toBe(2);
    });

    it('does NOT retry a non-transient failure', () => {
      let userCalls = 0;
      const runner: CommandRunner = (_cmd, args) => {
        if (!args.includes('user')) return fail('gh: Not Found (HTTP 404)');
        userCalls += 1;
        return fail('gh: Bad credentials (HTTP 401)');
      };
      pipeline.resolveAuthenticatedPublisher(runner);
      // A 401 is authoritative: exactly one attempt, no wasted retries.
      expect(userCalls).toBe(1);
    });
  });

  describe('refusal is diagnosable', () => {
    it('never invents an identity when every probe fails', () => {
      // GITHUB_ACTIONS identifies the runner, not the token's publisher. An assumed
      // github-actions[bot] identity must never authorize a mutation.
      const runner: CommandRunner = () => fail('gh: Bad credentials (HTTP 401)');
      const resolved = pipeline.resolveAuthenticatedPublisher(runner);
      expect(resolved).toMatchObject({ login: null, verified: false });
    });

    it('names the probes and their status codes', () => {
      const runner: CommandRunner = () => fail('gh: Bad credentials (HTTP 401)');
      const { reason } = pipeline.resolveAuthenticatedPublisher(runner);
      expect(reason).toContain('identity probes failed');
      expect(reason).toContain('user=HTTP 401');
      expect(reason).toContain('installation=HTTP 401');
      expect(reason).toContain('viewer=HTTP 401');
    });

    it('reports a non-HTTP failure as its exit code rather than silently', () => {
      const runner = () => ({ status: 127, stdout: '', stderr: 'gh: command not found' });
      const { reason } = pipeline.resolveAuthenticatedPublisher(runner);
      expect(reason).toContain('user=exit 127');
    });

    it('never leaks token material into the reason', () => {
      // The reason reaches CI logs, so it must carry status and endpoint only.
      const runner: CommandRunner = () => fail('gh: Bad credentials (HTTP 401) for token gho_SECRETVALUE123');
      const { reason } = pipeline.resolveAuthenticatedPublisher(runner);
      expect(reason).not.toContain('gho_SECRETVALUE123');
      expect(reason).toContain('user=HTTP 401');
    });

    it('carries the reason into the thrown error', () => {
      // `publisherIdentityError(reason)` takes the reason as an ARGUMENT. An earlier revision read
      // it from module state, which made the message depend on hidden call ordering: deleting the
      // write left every test green while the diagnostic regressed to the bare message
      // REL-1107 was filed against (REL-1107 review).
      const reason = pipeline.resolveAuthenticatedPublisher(
        () => fail('gh: Bad credentials (HTTP 401)'),
      ).reason;
      expect(reason).toBeTruthy();
      const message = pipeline.publisherIdentityError(reason).message;
      // The SUFFIX, not merely the prefix: the bare message must not satisfy this.
      expect(message).toContain('identity probes failed');
      expect(message).toContain('user=HTTP 401');
      expect(message).not.toBe('could not determine the publishing GitHub identity');
    });

    it('requirePublisherIdentity returns the login when verified', () => {
      // Behaviour, not source text: an earlier revision pinned exact substrings, which went red
      // on a prettier re-wrap with zero behaviour change (REL-1107 review).
      expect(pipeline.requirePublisherIdentity({ login: 'calltelemetry-jason', verified: true }))
        .toBe('calltelemetry-jason');
    });

    it('requirePublisherIdentity THROWS carrying the reason when unverified', () => {
      // The wiring itself: a call site that dropped the reason would fail here.
      const thrown = (() => {
        try {
          pipeline.requirePublisherIdentity({ login: null, verified: false, reason: 'identity probes failed (user=HTTP 401)' });
          return null;
        } catch (error) { return error as Error; }
      })();
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown?.message).toContain('identity probes failed (user=HTTP 401)');
      expect(thrown?.message).not.toBe('could not determine the publishing GitHub identity');
    });

    it('the refusal text carries the reason when known, and omits it otherwise', () => {
      expect(pipeline.publisherIdentityRefusal({ reason: 'identity probes failed (user=HTTP 401)' }))
        .toContain('identity probes failed (user=HTTP 401)');
      expect(pipeline.publisherIdentityRefusal({}))
        .toMatch(/unverified summary comment$/u);
    });

    it('omits the suffix when no reason is supplied', () => {
      expect(pipeline.publisherIdentityError('').message)
        .toBe('could not determine the publishing GitHub identity');
    });
  });
});
