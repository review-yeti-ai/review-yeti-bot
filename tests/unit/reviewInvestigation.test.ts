import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runPersonaInvestigation } from '../../src/review/reviewInvestigation';

const identity = { provider: 'github', repository: 'owner/repo', prNumber: 22, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
const assignedUnitId = `ru_${'1'.repeat(64)}`;
const outsideUnitId = `ru_${'2'.repeat(64)}`;
const dispatchAssignment = {
  id: assignedUnitId,
  status: 'selected',
  persona: 'security',
  ruleId: 'security-specific',
  files: ['src/a.js'],
};
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
  it('replays the bounded provider-response fixture matrix without a clean approval on failure', async () => {
    const fixturePath = path.join(process.cwd(), 'tests/fixtures/bounded-investigation-responses/response-cases.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as { cases: Array<Record<string, any>> };

    for (const testCase of fixture.cases) {
      const providerResponse = testCase.providerResponse || {
        ok: true,
        content: testCase.content,
        model: 'test/model',
        provider: 'morph',
        generationId: `gen-${testCase.id}`,
      };
      const result = await runPersonaInvestigation({
        ...baseInput,
        providerRouting: { only: ['morph'], allow_fallbacks: false },
        modelTurn: sequence([providerResponse]),
      });

      if (testCase.expected === 'complete') {
        expect(result.personaResult.decision, testCase.id).toBe('APPROVE');
        expect(result.executionReceipt.termination, testCase.id).toBe('completed');
      } else {
        expect(result.personaResult.decision, testCase.id).toBe('ERROR');
        expect(result.personaResult.failure?.class, testCase.id).toBe(testCase.expected);
        expect(result.personaResult.failure?.reason, testCase.id).toBe(testCase.reason);
        expect(result.personaResult.failure?.personaId, testCase.id).toBe('security');
        expect(result.personaResult.failure?.provider, testCase.id).toBe(providerResponse.provider || 'morph');
        expect(result.personaResult.failure?.model, testCase.id).toBe(providerResponse.model || 'test/model');
        expect(result.personaResult.failure?.attempt, testCase.id).toBeGreaterThan(0);
        expect(result.personaResult.failure).not.toHaveProperty('content');
      }
    }
  });

  it('nudges the model instead of terminating the lane on a repeated evidence call', async () => {
    const calls: any[] = [];
    let index = 0;
    const responses = [needsEvidenceResponse(), needsEvidenceResponse(), completeResponse()];
    const modelTurn = async (turnInput: any) => {
      calls.push(turnInput);
      return responses[Math.min(index++, responses.length - 1)];
    };
    // maxRepeatedCalls 1 so the second identical request triggers repeated_call on a
    // non-final turn (maxTurns 3 is the post-REL-272 hard ceiling), exercising the nudge.
    const result = await runPersonaInvestigation({ ...baseInput, modelTurn, limits: { maxTurns: 3, maxRepeatedCalls: 1 } });
    // Turn 3 repeats the same evidence request past maxRepeatedCalls (2); the lane
    // must get a corrective nudge and continue to a normal completion, not die as
    // termination=repeated_call (which forced a degraded-quorum BLOCK).
    expect(result.personaResult.decision).toBe('APPROVE');
    expect(result.executionReceipt.termination).toBe('completed');
    // The nudge is present in the final turn's messages (the final-turn
    // decision instruction may be appended after it).
    expect(JSON.stringify(calls[calls.length - 1].messages)).toContain('Do not request that same evidence again');
  });

  it('tells the model explicitly when it is on its final turn', async () => {
    const calls: any[] = [];
    let index = 0;
    const responses = [needsEvidenceResponse(), completeResponse()];
    const modelTurn = async (turnInput: any) => {
      calls.push(turnInput);
      return responses[Math.min(index++, responses.length - 1)];
    };
    const result = await runPersonaInvestigation({ ...baseInput, modelTurn, limits: { maxTurns: 2 } });
    expect(result.personaResult.decision).toBe('APPROVE');
    // Turn 1 (not final) carries no final-turn order; turn 2 (final) must.
    expect(JSON.stringify(calls[0].messages)).not.toContain('FINAL TURN');
    const lastMessages = calls[1].messages;
    expect(calls[1].finalOnly).toBe(true);
    expect(lastMessages[lastMessages.length - 1].role).toBe('user');
    expect(lastMessages[lastMessages.length - 1].content).toContain('FINAL TURN');
  });

  it('completes a clean review without forcing a tool call', async () => {
    const result = await runPersonaInvestigation({ ...baseInput, modelTurn: sequence([completeResponse()]) });
    expect(result.personaResult).toMatchObject({ decision: 'APPROVE', findings: [] });
    expect(result.executionReceipt).toMatchObject({ termination: 'completed', turns: 1, evidenceCalls: 0 });
  });

  it('credits the bounded batch when a completed clean response has no explicit risk plan', async () => {
    const result = await runPersonaInvestigation({
      ...baseInput,
      investigationUnitIds: ['ru_auth', 'ru_events'],
      modelTurn: sequence([completeResponse({ risk_plan: [], risk_dispositions: [] })]),
    });

    expect(result.executionReceipt).toMatchObject({
      termination: 'completed',
      completedUnitIds: ['ru_auth', 'ru_events'],
    });
  });

  it('does not fill in units omitted by an explicit partial risk plan', async () => {
    const result = await runPersonaInvestigation({
      ...baseInput,
      investigationUnitIds: ['ru_auth', 'ru_events'],
      modelTurn: sequence([completeResponse()]),
    });

    expect(result.executionReceipt.completedUnitIds).toEqual(['ru_auth']);
  });

  it('does not fill in units when an explicit risk plan has no unit assignment', async () => {
    const result = await runPersonaInvestigation({
      ...baseInput,
      investigationUnitIds: ['ru_auth', 'ru_events'],
      modelTurn: sequence([completeResponse({
        risk_plan: [{ id: 'risk-1', unit_ids: [], statement: 'unassigned review risk', evidence_needed: [], allowed_tools: [] }],
      })]),
    });

    expect(result.executionReceipt.completedUnitIds).toEqual([]);
  });

  it('rejects a finding citing an unissued receipt and recovers via the corrective re-ask', async () => {
    let call = 0;
    const modelTurn = async ({ messages }: { messages: Array<{ content: string }> }) => {
      call += 1;
      if (call === 1) return needsEvidenceResponse();
      const joined = messages.map((m: any) => m.content).join('\n');
      const realId = JSON.parse(joined.match(/<evidence_results>\n([\s\S]*?)\n<\/evidence_results>/u)![1])[0].receipt_id;
      const finding = (id: string) => ({ severity: 'P1', path: 'src/a.js', line: 1, side: 'RIGHT', title: 'guard', body: 'trigger', risk_id: 'risk-1', evidence_receipt_ids: [id] });
      if (call === 2) return completeResponse({ findings: [finding('er_' + 'f'.repeat(64))] });
      // The corrective re-ask names the bounded rejection; answer with the real receipt.
      expect(joined).toContain('rejected before publication');
      return completeResponse({ findings: [finding(realId)] });
    };
    const result = await runPersonaInvestigation({ ...baseInput, modelTurn });
    expect(result.personaResult).toMatchObject({ decision: 'FINDINGS' });
    expect(result.executionReceipt.termination).toBe('completed');
  });

  it('executes requested evidence and requires a final response', async () => {
    let call = 0;
    const modelTurn = async ({ messages }: { messages: Array<{ content: string }> }) => {
      call += 1;
      if (call === 1) return needsEvidenceResponse();
      // Evidence results may not be the last message (the final-turn decision
      // instruction is appended after them on the final turn) — scan all messages.
      const evidenceMessage = messages.map((m: any) => m.content).join('\n');
      const evidenceId = JSON.parse(evidenceMessage.match(/<evidence_results>\n([\s\S]*?)\n<\/evidence_results>/u)[1])[0].receipt_id;
      return completeResponse({ findings: [{ severity: 'P1', path: 'src/a.js', line: 1, side: 'RIGHT', title: 'guard', body: 'trigger', risk_id: 'risk-1', evidence_receipt_ids: [evidenceId] }] });
    };
    const result = await runPersonaInvestigation({ ...baseInput, modelTurn });
    expect(result.executionReceipt).toMatchObject({ termination: 'completed', turns: 2, evidenceCalls: 1 });
    expect(result.personaResult).toMatchObject({ decision: 'FINDINGS', findings: [{ evidence_receipt_ids: [expect.stringMatching(/^er_/)] }] });
  });

  it('strips an unknown follow-up field and completes instead of failing the lane', async () => {
    // Rejecting unknown keys made benign extra fields fatal across every transport at
    // once (cisco-cdr#4337 canary 7); extras are now stripped and never published.
    const result = await runPersonaInvestigation({
      ...baseInput,
      providerRouting: { only: ['morph'], allow_fallbacks: false },
      modelTurn: sequence([
        { ...needsEvidenceResponse(), model: 'deepseek/deepseek-v4-flash-0731', provider: 'Morph', generationId: 'gen-first' },
        {
          ok: true,
          content: JSON.stringify({ review_status: 'COMPLETE', risk_plan: [], evidence_requests: [], risk_dispositions: [], findings: [], unexpected_model_field: 'do-not-publish-this' }),
          model: 'deepseek/deepseek-v4-flash-0731',
          provider: 'Morph',
          generationId: 'gen-second',
        },
      ]),
    });

    expect(result.personaResult.decision).toBe('APPROVE');
    expect(result.executionReceipt).toMatchObject({ termination: 'completed' });
    expect(JSON.stringify(result.personaResult)).not.toContain('do-not-publish-this');
  });

  it('fails closed with a bounded semantic failure and resolved route when the strict evidence follow-up is invalid', async () => {
    const result = await runPersonaInvestigation({
      ...baseInput,
      providerRouting: { only: ['morph'], allow_fallbacks: false },
      modelTurn: sequence([
        { ...needsEvidenceResponse(), model: 'deepseek/deepseek-v4-flash-0731', provider: 'Morph', generationId: 'gen-first' },
        {
          ok: true,
          content: JSON.stringify({ review_status: 'NOT_A_REAL_STATUS', risk_plan: [], evidence_requests: [], risk_dispositions: [], findings: [] }),
          model: 'deepseek/deepseek-v4-flash-0731',
          provider: 'Morph',
          generationId: 'gen-second',
        },
      ]),
    });

    expect(result.personaResult).toMatchObject({
      decision: 'ERROR',
      error: 'malformed_response',
      failure: {
        class: 'semantic_invalid_response',
        reason: 'invalid_review_status',
        route: { provider: 'Morph', model: 'deepseek/deepseek-v4-flash-0731', generationId: 'gen-second' },
      },
    });
    expect(result.personaResult.failure).not.toHaveProperty('content');
    expect(result.executionReceipt).toMatchObject({ termination: 'malformed_response', complete: false });
  });

  it('completes only the deterministic dispatch unit assigned to the persona', async () => {
    const response = completeResponse({
      risk_plan: [{ id: 'risk-1', unit_ids: [assignedUnitId], statement: 'auth guard can be bypassed', evidence_needed: [], allowed_tools: [] }],
      risk_dispositions: [{ risk_id: 'risk-1', status: 'rejected', reason: 'guard is present' }],
    });
    const result = await runPersonaInvestigation({
      ...baseInput,
      dispatchAssignment,
      modelTurn: sequence([response]),
    });

    expect(result.personaResult.decision).toBe('APPROVE');
    expect(result.executionReceipt.completedUnitIds).toEqual([assignedUnitId]);
  });

  it('fails closed when a model risk plan escapes the deterministic dispatch assignment', async () => {
    const result = await runPersonaInvestigation({
      ...baseInput,
      dispatchAssignment,
      modelTurn: sequence([completeResponse({
        risk_plan: [{ id: 'risk-1', unit_ids: [outsideUnitId], statement: 'unassigned risk', evidence_needed: [], allowed_tools: [] }],
        risk_dispositions: [{ risk_id: 'risk-1', status: 'rejected', reason: 'not defective' }],
      })]),
    });

    expect(result.personaResult).toMatchObject({ decision: 'ERROR', error: 'malformed_response' });
    expect(result.executionReceipt).toMatchObject({ termination: 'malformed_response', complete: false });
  });

  it('fails closed before tool execution when evidence names an unassigned unit', async () => {
    let evidenceCalls = 0;
    const result = await runPersonaInvestigation({
      ...baseInput,
      dispatchAssignment,
      evidenceRegistry: {
        capabilities: { enabled: true, readOnly: true, tools: ['file_read'] },
        call: async () => { evidenceCalls += 1; return { status: 'ok', content: 'guard', byteCount: 5 }; },
      },
      modelTurn: sequence([{
        ...needsEvidenceResponse(),
        content: JSON.stringify({
          review_status: 'NEEDS_EVIDENCE',
          risk_plan: [{ id: 'risk-1', unit_ids: [assignedUnitId], statement: 'auth risk', evidence_needed: ['caller'], allowed_tools: ['file_read'] }],
          evidence_requests: [{ risk_id: 'risk-1', unit_id: outsideUnitId, tool: 'file_read', args: { path: 'src/a.js', startLine: 1, endLine: 20 }, reason: 'escape assignment' }],
          risk_dispositions: [],
          findings: [],
        }),
      }]),
    });

    expect(evidenceCalls).toBe(0);
    expect(result.personaResult.decision).toBe('ERROR');
    expect(result.executionReceipt.termination).toBe('malformed_response');
  });

  it.each([
    { globalMaxCalls: 12, unitMaxCalls: 1, label: 'unit budget lowers the global budget' },
    { globalMaxCalls: 1, unitMaxCalls: 12, label: 'unit budget cannot raise the global budget' },
  ])('$label', async ({ globalMaxCalls, unitMaxCalls }) => {
    let evidenceCalls = 0;
    const scopedNeedsEvidence = (path: string) => ({
      ...needsEvidenceResponse(path),
      provider: 'openrouter',
      content: JSON.stringify({
        review_status: 'NEEDS_EVIDENCE',
        risk_plan: [{ id: 'risk-1', unit_ids: [assignedUnitId], statement: 'auth risk', evidence_needed: ['caller'], allowed_tools: ['file_read'] }],
        evidence_requests: [{ risk_id: 'risk-1', unit_id: assignedUnitId, tool: 'file_read', args: { path, startLine: 1, endLine: 20 }, reason: 'bounded read' }],
        risk_dispositions: [],
        findings: [],
      }),
    });
    const result = await runPersonaInvestigation({
      ...baseInput,
      dispatchAssignment: { ...dispatchAssignment, limits: { maxCalls: unitMaxCalls } },
      limits: { maxCalls: globalMaxCalls },
      evidenceRegistry: {
        capabilities: { enabled: true, readOnly: true, tools: ['file_read'] },
        call: async () => { evidenceCalls += 1; return { status: 'ok', content: 'guard', byteCount: 5 }; },
      },
      modelTurn: sequence([scopedNeedsEvidence('src/a.js'), scopedNeedsEvidence('src/b.js')]),
    });

    expect(evidenceCalls).toBe(1);
    expect(result.personaResult).toMatchObject({ decision: 'ERROR', error: 'budget_exhausted' });
    expect(result.executionReceipt).toMatchObject({ termination: 'budget_exhausted', evidenceCalls: 1, complete: false });
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

  // REL-271 (D5): the lane-level quarantine restart (reset turn=1, exclude the failed provider,
  // replay the whole conversation) is gone. MAX_LANE_PROVIDER_RETRIES=0 -- a single unresolved
  // evidence response fails the lane on the first call; the per-request attempt loop in
  // review-pipeline.js's reviewWithModel is the only retry left, and it never touches this
  // lane-scoped providerIgnore path.
  it('fails closed on the first unresolved-evidence response instead of quarantine-restarting the provider', async () => {
    const calls: Array<{ providerIgnore?: string[]; turn: number }> = [];
    const modelTurn = async ({ providerIgnore, turn }: { providerIgnore?: string[]; turn: number }) => {
      calls.push({ providerIgnore, turn });
      return { ok: false, error: 'unresolved_evidence', model: 'test/model', provider: 'test' };
    };
    const result = await runPersonaInvestigation({
      ...baseInput,
      modelTurn,
    });

    expect(calls).toEqual([{ providerIgnore: undefined, turn: 1 }]);
    expect(result.executionReceipt).toMatchObject({ termination: 'unresolved_evidence', complete: false });
    expect(result.personaResult).toMatchObject({ decision: 'ERROR', error: 'unresolved_evidence' });
  });

  it('grants one corrective re-ask on a malformed response, then fails closed — never a quarantine restart', async () => {
    const calls: Array<{ providerIgnore?: string[]; turn: number; messages: any[] }> = [];
    const modelTurn = async ({ providerIgnore, turn, messages }: { providerIgnore?: string[]; turn: number; messages: any[] }) => {
      calls.push({ providerIgnore, turn, messages });
      return { ok: true, content: '{not valid json', model: 'test/model', provider: 'morph' };
    };

    const result = await runPersonaInvestigation({
      ...baseInput,
      providerRouting: { only: ['morph'], allow_fallbacks: false },
      modelTurn,
    });

    // Exactly two calls, both on turn 1 (a corrective re-ask, not a turn=1 reset
    // with provider exclusion) — the second carries the bounded rejection class.
    expect(calls.map((c) => ({ providerIgnore: c.providerIgnore, turn: c.turn }))).toEqual([
      { providerIgnore: undefined, turn: 1 },
      { providerIgnore: undefined, turn: 1 },
    ]);
    const reask = calls[1].messages[calls[1].messages.length - 1];
    expect(reask.role).toBe('user');
    expect(reask.content).toContain('rejected before publication: invalid_json');
    expect(result.executionReceipt).toMatchObject({ termination: 'malformed_response', complete: false });
    expect(result.personaResult).toMatchObject({ decision: 'ERROR', error: 'malformed_response' });
  });

  it('fails closed after one corrective re-ask on an unresolved-OpenRouter-route empty response', async () => {
    const calls: Array<{ providerIgnore?: string[] }> = [];
    const modelTurn = async ({ providerIgnore }: { providerIgnore?: string[] }) => {
      calls.push({ providerIgnore });
      return { ok: true, content: '', model: 'openai/gpt-5.6-luna', provider: 'openrouter' };
    };

    const result = await runPersonaInvestigation({ ...baseInput, modelTurn });

    // One original attempt + one corrective re-ask; never a provider exclusion.
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.providerIgnore === undefined)).toBe(true);
    expect(result.personaResult).toMatchObject({ decision: 'ERROR', error: 'malformed_response' });
    expect(result.personaResult.failure).toMatchObject({ class: 'semantic_invalid_response', reason: 'empty_response' });
  });

  // Regression coverage for the architecture-lane near-miss (2026-08-12, evidence:
  // calltelemetry/cisco-cdr run 31601485579) that originally motivated a depth-2 quarantine
  // ceiling. REL-271/REL-270 supersede that fix: the operator directive is "1 retry max per
  // lane, no client-side provider bans on that retry" -- so instead of surviving a run of
  // provider failures via lane-level restarts, the lane now fails fast on the very first
  // failure, and the retry that remains (review-pipeline.js's per-request attempt loop) never
  // grows this lane-scoped providerIgnore list.
  describe('lane-level quarantine retry removed (REL-271 D5)', () => {
    it('does not survive a second, distinct failure after the first -- the attempt loop is the only retry now', async () => {
      const calls: Array<{ providerIgnore?: string[] }> = [];
      const modelTurn = async ({ providerIgnore }: { providerIgnore?: string[] }) => {
        calls.push({ providerIgnore });
        if (calls.length === 1) return { ok: false, error: 'provider_failure', model: 'test/model', provider: 'ionstream' };
        if (calls.length === 2) return { ok: true, content: '', model: 'test/model', provider: 'akashml' };
        return completeResponse();
      };

      const result = await runPersonaInvestigation({ ...baseInput, modelTurn });

      // Exactly one call: MAX_LANE_PROVIDER_RETRIES=0 means no restart, so the lane never sees
      // the second (would-be-recoverable) response at all.
      expect(calls).toEqual([{ providerIgnore: undefined }]);
      expect(result.executionReceipt).toMatchObject({ termination: 'provider_failure', complete: false });
      expect(result.personaResult).toMatchObject({ decision: 'ERROR', error: 'provider_failure' });
    });

    it('a counting mock proves the lane makes at most 1 model call regardless of how many distinct providers would fail', async () => {
      const calls: Array<{ providerIgnore?: string[] }> = [];
      let providerIndex = 0;
      const providers = ['ionstream', 'akashml', 'digitalocean', 'phala', 'ionstream-again'];
      const modelTurn = async ({ providerIgnore }: { providerIgnore?: string[] }) => {
        calls.push({ providerIgnore });
        return { ok: false, error: 'provider_failure', model: 'test/model', provider: providers[providerIndex++] };
      };

      const result = await runPersonaInvestigation({ ...baseInput, modelTurn });

      expect(calls).toHaveLength(1);
      // No quarantine list is ever populated -- this lane-scoped ban set stays empty.
      expect(calls.every((call) => call.providerIgnore === undefined)).toBe(true);
      expect(result.personaResult).toMatchObject({ decision: 'ERROR', error: 'provider_failure' });
      expect(result.executionReceipt).toMatchObject({ termination: 'provider_failure', complete: false });
    });
  });

  // Regression coverage for the cisco-cdr false-SHIP near-miss (2026-08-11, caught before
  // merging PR #43). An earlier version of the fix reasoned "with evidence tooling off, a
  // persona structurally cannot produce a finding with valid evidence receipt ids, so it's safe
  // to trust an APPROVE verdict downstream." That premise was true but the conclusion was wrong:
  // the finding is not merely unverifiable when evidence is off, it was being silently DISCARDED
  // and the persona relabelled APPROVE -- turning a real reported defect into a manufactured
  // clean review. The live cisco-cdr runs between the navigation-cap fix and the pin
  // (PRs #4187/#4209/#4210) show exactly this: 5/5 personas APPROVE, 0 findings, including on a
  // PR containing a genuine correctness defect.
  describe('evidence-tooling-unavailable does not silently discard a real finding', () => {
    const disabledRegistry = Object.freeze({
      capabilities: Object.freeze({ enabled: false, readOnly: true, tools: [] }),
      call: async () => ({ status: 'unavailable', reason: 'disabled' }),
    });
    const enabledRegistry = { capabilities: { enabled: true, readOnly: true, tools: ['file_read'] }, call: async () => ({ status: 'ok', content: 'irrelevant', byteCount: 8 }) };

    it('ACCEPTANCE: retains a P1 finding reported without an evidence receipt when evidence tooling is disabled, marked unverified', async () => {
      const result = await runPersonaInvestigation({
        ...baseInput,
        evidenceRegistry: disabledRegistry,
        modelTurn: sequence([completeResponse({
          findings: [{
            severity: 'P1', path: 'src/a.js', line: 1, side: 'RIGHT',
            title: 'insert_all skips usec cast', body: 'insert_all bypasses the changeset cast on a :utc_datetime_usec column, truncating precision on every row.',
            risk_id: 'risk-1',
          }],
        })]),
      });
      expect(result.personaResult.decision).toBe('FINDINGS');
      expect(result.personaResult.findings).toEqual([
        expect.objectContaining({ severity: 'P1', title: 'insert_all skips usec cast', unverified: true, evidence_receipt_ids: [] }),
      ]);
    });

    it('DANGER GUARD: still rejects an evidence-less finding when evidence tooling IS enabled -- grounding discipline is unchanged', async () => {
      const result = await runPersonaInvestigation({
        ...baseInput,
        evidenceRegistry: enabledRegistry,
        modelTurn: sequence([completeResponse({
          findings: [{ severity: 'P1', path: 'src/a.js', line: 1, side: 'RIGHT', title: 'ungrounded claim', body: 'no evidence gathered', risk_id: 'risk-1' }],
        })]),
      });
      // parseInvestigationResponse rejects the response entirely (malformed_response) because
      // the model was told evidence receipts are required when tooling is enabled -- the same
      // hard failure as before this fix, for a well-behaved evidence-enabled run.
      expect(result.executionReceipt.termination).toBe('malformed_response');
      expect(result.personaResult.decision).toBe('ERROR');
      expect(result.personaResult.findings).toEqual([]);
    });

    it('still rejects a finding whose cited evidence receipt does not exist, even with evidence tooling disabled', async () => {
      const result = await runPersonaInvestigation({
        ...baseInput,
        evidenceRegistry: disabledRegistry,
        modelTurn: sequence([completeResponse({
          findings: [{ severity: 'P1', path: 'src/a.js', line: 1, side: 'RIGHT', title: 'fabricated receipt', body: 'cites a receipt that was never emitted', risk_id: 'risk-1', evidence_receipt_ids: ['er_never_emitted'] }],
        })]),
      });
      expect(result.personaResult.findings).toEqual([]);
    });
  });
});
