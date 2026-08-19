import { describe, expect, it } from 'vitest';
import { createEvidenceRuntime } from '../../src/review/evidenceRuntime';

const identity = { provider: 'github', repository: 'owner/repo', prNumber: 22, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
const request = { personaId: 'persona-1', riskId: 'risk-1', tool: 'file_read', args: { path: 'src/a.js', startLine: 1, endLine: 20 }, reason: 'inspect guard' };

function registry(result = { status: 'ok', content: 'sensitive source text', byteCount: 21 }) {
  return { call: async () => result };
}

describe('evidence runtime', () => {
  it('terminates on the third identical normalized call and retains two receipts', async () => {
    const runtime = createEvidenceRuntime({ identity, registry: registry(), limits: { maxCalls: 12, maxRepeatedCalls: 2 }, clock: () => 100 });
    await runtime.execute([request]);
    await runtime.execute([request]);
    const third = await runtime.execute([request]);
    expect(third).toMatchObject({ complete: false, termination: 'repeated_call' });
    expect(runtime.receipts()).toHaveLength(2);
  });

  it('records a digest and counts but never raw tool content in persisted receipts', async () => {
    const runtime = createEvidenceRuntime({ identity, registry: registry(), clock: () => 100 });
    await runtime.execute([request]);
    expect(runtime.receipts()[0]).toMatchObject({ status: 'ok', byteCount: expect.any(Number), resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(runtime.receipts()[0])).not.toContain('sensitive source text');
  });

  it('bounds untrusted output and continues so monorepo misses do not kill the persona lane', async () => {
    const runtime = createEvidenceRuntime({ identity, registry: registry({ status: 'unavailable', reason: 'file_not_in_snapshot', content: 'x'.repeat(10_000) }), limits: { maxResultBytes: 100 } });
    const result = await runtime.execute([request]);
    // Soft-fail: deliver the bounded unavailable receipt and keep complete so the
    // model can disposition risks instead of ERROR → BLOCK (unresolved_evidence).
    expect(result).toMatchObject({ complete: true, termination: 'continue' });
    expect(result.outputs[0].result.status).toBe('unavailable');
    expect(String(result.outputs[0].result.reason || '')).toMatch(/file_not_in_snap/);
    expect(Buffer.byteLength(JSON.stringify(result.outputs[0].result), 'utf8')).toBeLessThanOrEqual(160);
  });

  it('executes a library_docs request through the same receipted path as the other tools', async () => {
    const libraryDocsRequest = { personaId: 'persona-1', riskId: 'risk-1', tool: 'library_docs', args: { library: 'react', topic: 'useEffect cleanup' }, reason: 'check current API shape' };
    const runtime = createEvidenceRuntime({
      identity,
      registry: registry({ status: 'ok', library: 'react', topic: 'useEffect cleanup', snippets: [{ title: 'Hooks', content: 'cleanup runs on unmount' }], byteCount: 40 }),
      clock: () => 100,
    });

    const result = await runtime.execute([libraryDocsRequest]);

    expect(result).toMatchObject({ complete: true, termination: 'continue' });
    expect(result.outputs[0]).toMatchObject({ tool: 'library_docs', riskId: 'risk-1' });
    expect(runtime.receipts()[0]).toMatchObject({ tool: 'library_docs', status: 'ok' });
  });

  // Negative security case (required): a Context7 timeout/outage must degrade this one call to
  // 'unavailable' and keep the lane going, never abort the whole persona investigation.
  it('degrades a library_docs timeout to an unavailable receipt without breaking the lane', async () => {
    const libraryDocsRequest = { personaId: 'persona-1', riskId: 'risk-1', tool: 'library_docs', args: { library: 'react', topic: 'hooks' }, reason: 'docs check' };
    const runtime = createEvidenceRuntime({
      identity,
      registry: registry({ status: 'unavailable', reason: 'context7_timeout' }),
      clock: () => 100,
    });

    const result = await runtime.execute([libraryDocsRequest]);

    expect(result).toMatchObject({ complete: true, termination: 'continue' });
    expect(result.outputs[0].result).toMatchObject({ status: 'unavailable', reason: 'context7_timeout' });
    expect(runtime.receipts()[0]).toMatchObject({ status: 'unavailable', reason: 'context7_timeout' });
  });
});
