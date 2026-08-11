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

  it('bounds untrusted output passed to the next turn and stops on unresolved evidence', async () => {
    const runtime = createEvidenceRuntime({ identity, registry: registry({ status: 'unavailable', reason: 'file_not_in_snapshot', content: 'x'.repeat(10_000) }), limits: { maxResultBytes: 100 } });
    const result = await runtime.execute([request]);
    expect(result).toMatchObject({ complete: false, termination: 'unresolved_evidence' });
    expect(Buffer.byteLength(JSON.stringify(result.outputs[0].result), 'utf8')).toBeLessThanOrEqual(160);
  });
});
