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
    // undici often nests the errno rather than putting it in the message.
    const wrapped = new Error('fetch failed');
    (wrapped as any).cause = Object.assign(new Error('other'), { code: 'ECONNRESET' });
    expect(pipeline.isTransientSocketError(wrapped)).toBe(true);
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
    // The retry gate and the classifier previously each carried their own copy of
    // this list, which is exactly how one of them fell behind the other.
    const source = fs.readFileSync(path.join(root, '.github/workflows/pipelines/review-pipeline.js'), 'utf8');
    const inlineCopies = source.match(/ECONNRESET\|ETIMEDOUT\|EPIPE/g) || [];
    expect(inlineCopies.length).toBe(1);
    expect(source).toContain('const TRANSIENT_SOCKET_PATTERN');
  });
});
