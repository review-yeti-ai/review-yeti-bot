import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));

/**
 * `fetch failed` is undici's wrapper for every network-layer fault. It carries no
 * errno, so an errno-only list missed it: the attempt was not retried, it classified
 * as `unknown`, and the breaker's scope default is `transport` -- so one blip
 * quarantined every lane on the run and the whole review ended INCOMPLETE.
 *
 * Observed live on review-yeti-bot PRs: `Tripped transport capacity
 * 'transport:openrouter': fetch failed`, five lanes at once, three consecutive runs.
 */
describe('undici fetch failures are treated as retryable transport faults', () => {
  it('classifies the generic wrappers the errno-only list used to miss', () => {
    for (const message of ['fetch failed', 'socket hang up', 'EAI_AGAIN', 'ECONNREFUSED']) {
      expect(pipeline.isTransientSocketError(message), message).toBe(true);
      expect(pipeline.classifyTelemetryTransportError(message), message).toBe('transient_socket');
    }
  });

  it('keeps the errno forms working', () => {
    for (const message of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE']) {
      expect(pipeline.isTransientSocketError(message), message).toBe(true);
    }
  });

  it('unwraps undici causes that carry the real code', () => {
    // The OUTER message must not match, or this passes on the first check and never
    // exercises the recursion. Verified by plant: deleting the whole cause-unwrap
    // block left the earlier version of this test green.
    const wrapped = new Error('upstream request failed');
    (wrapped as any).cause = new Error('ECONNRESET');
    expect(pipeline.isTransientSocketError(wrapped)).toBe(true);
    // And the classifier must agree with the gate on the same object. It stringified
    // first before this fix, so it saw no `cause` and returned `unknown` while the
    // gate returned true -- a divergence on exactly the errors that need agreement.
    expect(pipeline.classifyTelemetryTransportError(wrapped)).toBe('transient_socket');
  });

  it('does NOT widen into faults that should still quarantine', () => {
    // A 502 means the upstream answered and rejected; retrying every lane on it is
    // what turned a capacity fault into a blanket run failure.
    expect(pipeline.isTransientSocketError('HTTP 502')).toBe(false);
    expect(pipeline.classifyTelemetryTransportError('HTTP 502')).toBe('unknown');
    // A timeout has its own recovery path; it must not be reclassified as a socket fault.
    expect(pipeline.classifyTelemetryTransportError('AbortError: aborted')).toBe('timeout');
    expect(pipeline.classifyTelemetryTransportError('empty_sse response')).toBe('malformed_output');
    expect(pipeline.isTransientSocketError('totally unrelated')).toBe(false);
  });

  it('has ONE source of truth for the pattern', () => {
    // Count a SINGLE distinctive token rather than a fixed alternation: matching
    // `ECONNRESET|ETIMEDOUT|EPIPE` failed on a behaviour-preserving reorder AND passed
    // when a duplicate was written in a different order. One token is order-insensitive
    // and still catches a second list.
    const source = fs.readFileSync(path.join(root, '.github/workflows/pipelines/review-pipeline.js'), 'utf8');
    const errnoLists = source.match(/EAI_AGAIN/g) || [];
    expect(errnoLists.length).toBe(1);
    expect(source).toContain('const TRANSIENT_SOCKET_PATTERN');
    // The gate and the classifier must both route through the shared predicate, so a
    // future edit cannot reintroduce a private copy at either site.
    expect(source).toContain('isTransientSocketError(err)');
    expect(source).toContain('isTransientSocketError(error)');
  });
});
