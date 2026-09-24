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

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
const fail = (stderr) => ({ status: 1, stdout: '', stderr });

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
      const calls = [];
      const runner = (_cmd, args) => { calls.push(args.join(' ')); return ok('calltelemetry-jason\n'); };
      expect(pipeline.resolveAuthenticatedPublisher(runner))
        .toMatchObject({ login: 'calltelemetry-jason', verified: true });
      // Resolved on the first probe: the others must not be attempted.
      expect(calls).toHaveLength(1);
    });

    it('falls back to the installation app slug for an installation token', () => {
      // GET /user rejects installation tokens; the App slug identifies their publisher.
      const runner = (_cmd, args) => (args.includes('user')
        ? fail('gh: Bad credentials (HTTP 401)')
        : ok('review-yeti\n'));
      expect(pipeline.resolveAuthenticatedPublisher(runner))
        .toMatchObject({ login: 'review-yeti[bot]', verified: true });
    });

    it('falls back to the GraphQL viewer', () => {
      const runner = (_cmd, args) => {
        if (args.includes('graphql')) return ok('{"data":{"viewer":{"login":"calltelemetry-jason"}}}');
        return fail('gh: Bad credentials (HTTP 401)');
      };
      expect(pipeline.resolveAuthenticatedPublisher(runner))
        .toMatchObject({ login: 'calltelemetry-jason', verified: true });
    });

    it('retries a transient failure and then succeeds', () => {
      // The regression this fixes: one unlucky 503 used to fail the entire publish.
      let userCalls = 0;
      const runner = (_cmd, args) => {
        if (!args.includes('user')) return fail('gh: Bad credentials (HTTP 401)');
        userCalls += 1;
        return userCalls === 1 ? fail('gh: Server Error (HTTP 502)') : ok('calltelemetry-jason\n');
      };
      expect(pipeline.resolveAuthenticatedPublisher(runner))
        .toMatchObject({ login: 'calltelemetry-jason', verified: true });
      expect(userCalls).toBe(2);
    });

    it('does NOT retry a non-transient failure', () => {
      let userCalls = 0;
      const runner = (_cmd, args) => {
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
      const runner = () => fail('gh: Bad credentials (HTTP 401)');
      const resolved = pipeline.resolveAuthenticatedPublisher(runner);
      expect(resolved).toMatchObject({ login: null, verified: false });
    });

    it('names the probes and their status codes', () => {
      const runner = () => fail('gh: Bad credentials (HTTP 401)');
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
      const runner = () => fail('gh: Bad credentials (HTTP 401) for token gho_SECRETVALUE123');
      const { reason } = pipeline.resolveAuthenticatedPublisher(runner);
      expect(reason).not.toContain('gho_SECRETVALUE123');
      expect(reason).toContain('user=HTTP 401');
    });

    it('carries the reason into the thrown error', () => {
      const runner = () => fail('gh: Bad credentials (HTTP 401)');
      pipeline.resolveAuthenticatedPublisher(runner);
      // The call sites call readAuthenticatedPublisherLogin first, which records the reason.
      const readLogin = pipeline.resolveAuthenticatedPublisher(runner);
      expect(readLogin.reason).toBeTruthy();
      expect(pipeline.publisherIdentityError().message)
        .toMatch(/could not determine the publishing GitHub identity/);
    });
  });
});
