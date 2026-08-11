import { describe, expect, it } from 'vitest';
import { runPersonaInvestigation } from '../../src/review/reviewInvestigation';

const identity = { provider: 'github', repository: 'owner/repo', prNumber: 22, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
const baseInput = {
  identity,
  persona: { id: 'security', name: 'Security reviewer', charter: 'Review authorization changes.' },
  manifest: 'ru_auth src/a.js',
  diffText: '@@ -1 +1 @@\n+guard()',
  evidenceRegistry: { call: async () => ({ status: 'ok', content: 'guard is present', byteCount: 16 }) },
  clock: () => 100,
};

function sequence(responses: Array<Record<string, unknown>>) {
  let index = 0;
  return async () => responses[Math.min(index++, responses.length - 1)];
}

function completeResponse(extra = {}) {
  return { ok: true, content: JSON.stringify({ review_status: 'COMPLETE', risk_plan: [{ id: 'risk-1', unit_ids: ['ru_auth'], statement: 'auth guard can be bypassed', evidence_needed: ['caller'], allowed_tools: ['file_read'] }], evidence_requests: [], risk_dispositions: [{ risk_id: 'risk-1', status: 'rejected', reason: 'guard is present' }], findings: [], ...extra }), model: 'test/model', provider: 'test', usage: { promptTokens: 10, completionTokens: 5 } };
}

function needsEvidenceResponse(path = 'src/a.js') {
  return { ok: true, content: JSON.stringify({ review_status: 'NEEDS_EVIDENCE', risk_plan: [{ id: 'risk-1', unit_ids: ['ru_auth'], statement: 'auth guard can be bypassed', evidence_needed: ['caller'], allowed_tools: ['file_read'] }], evidence_requests: [{ risk_id: 'risk-1', tool: 'file_read', args: { path, startLine: 1, endLine: 40 }, reason: 'verify caller guard' }], risk_dispositions: [], findings: [] }), model: 'test/model', provider: 'test', usage: { promptTokens: 10, completionTokens: 5 } };
}

describe('persona investigation state machine', () => {
  it('completes a clean review without forcing a tool call', async () => {
    const result = await runPersonaInvestigation({ ...baseInput, modelTurn: sequence([completeResponse()]) });
    expect(result.personaResult).toMatchObject({ decision: 'APPROVE', findings: [] });
    expect(result.executionReceipt).toMatchObject({ termination: 'completed', turns: 1, evidenceCalls: 0 });
  });

  it('executes requested evidence and requires a final response', async () => {
    let call = 0;
    const modelTurn = async ({ messages }: { messages: Array<{ content: string }> }) => {
      call += 1;
      if (call === 1) return needsEvidenceResponse();
      const evidenceId = JSON.parse(messages.at(-1).content.match(/<evidence_results>\n([\s\S]*?)\n<\/evidence_results>/u)[1])[0].receipt_id;
      return completeResponse({ findings: [{ severity: 'P1', path: 'src/a.js', line: 1, side: 'RIGHT', title: 'guard', body: 'trigger', risk_id: 'risk-1', evidence_receipt_ids: [evidenceId] }] });
    };
    const result = await runPersonaInvestigation({ ...baseInput, modelTurn });
    expect(result.executionReceipt).toMatchObject({ termination: 'completed', turns: 2, evidenceCalls: 1 });
    expect(result.personaResult).toMatchObject({ decision: 'FINDINGS', findings: [{ evidence_receipt_ids: [expect.stringMatching(/^er_/)] }] });
  });

  it('fails closed when the final-turn reserve is reached without COMPLETE', async () => {
    let turn = 0;
    const result = await runPersonaInvestigation({ ...baseInput, limits: { maxTurns: 4 }, modelTurn: async () => needsEvidenceResponse(`src/a${turn++}.js`) });
    expect(result.executionReceipt).toMatchObject({ termination: 'budget_exhausted', complete: false });
    expect(result.personaResult.decision).toBe('ERROR');
  });

  it('does not retain a finding that cites an unknown evidence receipt', async () => {
    const result = await runPersonaInvestigation({ ...baseInput, modelTurn: sequence([completeResponse({ findings: [{ severity: 'P1', path: 'src/a.js', line: 1, side: 'RIGHT', title: 'bad', body: 'bad', risk_id: 'risk-1', evidence_receipt_ids: ['er_unknown'] }] })]) });
    expect(result.personaResult.findings).toEqual([]);
  });

  it('retries unresolved evidence once while excluding the failed provider', async () => {
    const calls: Array<{ providerIgnore?: string[]; turn: number }> = [];
    const modelTurn = async ({ providerIgnore, turn }: { providerIgnore?: string[]; turn: number }) => {
      calls.push({ providerIgnore, turn });
      if (calls.length === 1) return { ok: false, error: 'unresolved_evidence', model: 'test/model', provider: 'test' };
      return completeResponse();
    };
    const result = await runPersonaInvestigation({
      ...baseInput,
      modelTurn,
    });

    expect(calls).toEqual([
      { providerIgnore: undefined, turn: 1 },
      { providerIgnore: ['test'], turn: 1 },
    ]);
    expect(result.executionReceipt).toMatchObject({ termination: 'completed', turns: 1, evidenceCalls: 0 });
    expect(result.personaResult).toMatchObject({ decision: 'APPROVE', partial: 0 });
  });
});
