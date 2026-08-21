import { describe, expect, it } from 'vitest';

const {
  REVIEW_WORKFLOW_PACKAGE,
  REVIEW_WORKFLOW_PACKAGE_VERSION,
  __test,
  loadPiWorkflowRuntime,
  runDynamicReviewWorkflow,
} = require('../../src/pi/dynamicReviewWorkflow.js');
const {
  REVIEW_WORKFLOW_SCHEMA_VERSION,
  trustedReviewWorkflowScript,
} = require('../../src/pi/reviewWorkflowScript.js');
const { createReviewWorkflowAssignments } = require('../../src/review/reviewWorkflowAssignments.js');

function assignment(personaId: string) {
  return createReviewWorkflowAssignments({
    policyDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    personas: [{
      personaId,
      enabled: true,
      assignmentPrompt: `Review as ${personaId}`,
      personaResultSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['status'],
        properties: { status: { enum: ['APPROVE', 'FINDINGS', 'ERROR'] } },
      },
      passes: [{
        passId: 'primary',
        reviewUnitIds: [`ru_${'1'.repeat(64)}`],
        prompt: 'Inspect the assigned review units.',
        outputSchema: { type: 'object', additionalProperties: false, properties: {} },
      }],
    }],
  })[0];
}

describe('trusted Pi dynamic review workflow', () => {
  it('loads the pinned ESM runtime from the CommonJS wrapper', async () => {
    const runtime = await __test.importPiWorkflowRuntimeUnattested();
    expect(REVIEW_WORKFLOW_PACKAGE).toBe('@quintinshaw/pi-dynamic-workflows');
    expect(REVIEW_WORKFLOW_PACKAGE_VERSION).toBe('3.7.0');
    expect(runtime.runWorkflow).toBeTypeOf('function');
    expect(runtime.WorkflowAgent).toBeTypeOf('function');
  });

  it('requires staged build provenance before the exported runtime loader imports Pi', async () => {
    await expect(loadPiWorkflowRuntime()).rejects.toThrow(/build provenance is missing/i);
  });

  it('ships one stable trusted static workflow source and digest', () => {
    const first = trustedReviewWorkflowScript();
    const second = trustedReviewWorkflowScript();
    expect(REVIEW_WORKFLOW_SCHEMA_VERSION).toBe('review-yeti-pi-workflow.v1');
    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.source).toContain('phase("Review"');
    expect(first.source).toContain('parallel(');
    expect(first.source).toContain('agent(');
    expect(first.source).not.toMatch(/\b(?:require|import|fetch|Date|Math\.random|process)\b/u);
  });

  it('passes explicit stable run identity, resume identity, bounded concurrency, and finite timeout to Pi', async () => {
    const assignments = [assignment('testing'), assignment('security'), assignment('architecture')];
    let received: any;
    const runtime = {
      runWorkflow: async (source: string, options: any) => {
        received = { source, options };
        return { result: [{ status: 'APPROVE' }, { status: 'APPROVE' }, { status: 'APPROVE' }] };
      },
      WorkflowAgent: class {},
    };

    const result = await runDynamicReviewWorkflow({
      immutableIdentity: { repository: 'acme/widgets', headSha: 'c'.repeat(40), policyDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64) },
      assignments,
      runId: 'review:stable:1',
      resumeFromRunId: 'review:stable:0',
      concurrency: 99,
      deadlineMs: 12_345,
      agent: { run: async () => ({ status: 'APPROVE' }) },
      runtime,
      persistLogs: false,
    });

    expect(result.results).toHaveLength(3);
    expect(received.source).toBe(trustedReviewWorkflowScript().source);
    expect(received.options).toMatchObject({
      runId: 'review:stable:1',
      resumeFromRunId: 'review:stable:0',
      concurrency: 3,
      maxAgents: 3,
      agentTimeoutMs: 12_345,
      persistLogs: false,
    });
    expect(received.options.args.assignments).toEqual(assignments);
  });

  it('rejects duplicate, unknown, or mutated assignments before starting Pi', async () => {
    const valid = assignment('security');
    const runtime = { runWorkflow: async () => ({ result: [] }), WorkflowAgent: class {} };
    const common = {
      immutableIdentity: { repository: 'acme/widgets', policyDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64) },
      runId: 'review:stable',
      deadlineMs: 1000,
      agent: { run: async () => ({ status: 'APPROVE' }) },
      runtime,
    };
    await expect(runDynamicReviewWorkflow({ ...common, assignments: [valid, valid] })).rejects.toThrow(/duplicate assignment/i);
    await expect(runDynamicReviewWorkflow({ ...common, assignments: [{ ...valid, surprise: true }] })).rejects.toThrow(/unknown assignment field/i);
    await expect(runDynamicReviewWorkflow({ ...common, assignments: [{ ...valid, assignmentPrompt: 'tampered' }] })).rejects.toThrow(/assignment (?:prompt digest|identity)/i);
  });

  it('fails closed on missing/null results and invalid run controls', async () => {
    const valid = assignment('security');
    const common = {
      immutableIdentity: { repository: 'acme/widgets', policyDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64) },
      assignments: [valid],
      runId: 'review:stable',
      deadlineMs: 1000,
      agent: { run: async () => ({ status: 'APPROVE' }) },
      runtime: { runWorkflow: async () => ({ result: [null] }), WorkflowAgent: class {} },
    };
    await expect(runDynamicReviewWorkflow(common)).rejects.toThrow(/null result/i);
    await expect(runDynamicReviewWorkflow({ ...common, runtime: { runWorkflow: async () => ({}), WorkflowAgent: class {} } })).rejects.toThrow(/missing results/i);
    await expect(runDynamicReviewWorkflow({ ...common, runId: '' })).rejects.toThrow(/runId/i);
    await expect(runDynamicReviewWorkflow({ ...common, deadlineMs: Infinity })).rejects.toThrow(/deadline/i);
  });
});
