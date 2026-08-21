import { describe, expect, it } from 'vitest';

const {
  REVIEW_WORKFLOW_ASSIGNMENT_SCHEMA,
  createReviewWorkflowAssignments,
  digestReviewWorkflowAssignments,
} = require('../../src/review/reviewWorkflowAssignments.js');

const policyDigest = 'a'.repeat(64);
const manifestDigest = 'b'.repeat(64);
const personaResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'findings'],
  properties: {
    status: { enum: ['APPROVE', 'FINDINGS', 'ERROR'] },
    findings: { type: 'array', items: { type: 'object' } },
  },
};

function persona(personaId: string, passIds: string[]) {
  return {
    personaId,
    enabled: true,
    assignmentPrompt: `Review as ${personaId}`,
    personaResultSchema,
    passes: passIds.map((passId, index) => ({
      passId,
      reviewUnitIds: [`ru_${String(index + 1).padStart(64, '0')}`],
      prompt: `${personaId} ${passId}`,
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['decision'],
        properties: { decision: { type: 'string' } },
      },
    })),
  };
}

describe('Review Yeti Pi workflow assignments', () => {
  it('creates one deeply frozen assignment per enabled persona in canonical persona order', () => {
    const assignments = createReviewWorkflowAssignments({
      policyDigest,
      manifestDigest,
      personas: [
        persona('testing', ['tests']),
        { ...persona('disabled', ['ignored']), enabled: false },
        persona('architecture', ['structure']),
      ],
    });

    expect(assignments.map((assignment: any) => assignment.personaId)).toEqual(['architecture', 'testing']);
    expect(assignments.every((assignment: any) => assignment.schema === REVIEW_WORKFLOW_ASSIGNMENT_SCHEMA)).toBe(true);
    expect(Object.isFrozen(assignments)).toBe(true);
    expect(Object.isFrozen(assignments[0])).toBe(true);
    expect(Object.isFrozen(assignments[0].passes)).toBe(true);
    expect(Object.isFrozen(assignments[0].personaResultSchema)).toBe(true);
    expect(assignments[0]).toEqual({
      schema: 'review-yeti-assignment.v1',
      assignmentId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      personaId: 'architecture',
      passes: [
        {
          passId: 'structure',
          reviewUnitIds: [`ru_${'1'.padStart(64, '0')}`],
          prompt: 'architecture structure',
          promptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['decision'],
            properties: { decision: { type: 'string' } },
          },
          outputSchemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
      assignmentPrompt: 'Review as architecture',
      assignmentPromptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      personaResultSchema,
      personaResultSchemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('keeps ordered pass descriptors while making assignment identity independent of persona input order', () => {
    const architecture = persona('architecture', ['structure', 'boundaries']);
    const testing = persona('testing', ['unit', 'integration']);
    const first = createReviewWorkflowAssignments({ policyDigest, manifestDigest, personas: [testing, architecture] });
    const second = createReviewWorkflowAssignments({ policyDigest, manifestDigest, personas: [architecture, testing] });

    expect(first).toEqual(second);
    expect(first[0].passes.map((pass: any) => pass.passId)).toEqual(['structure', 'boundaries']);
    expect(first[1].passes.map((pass: any) => pass.passId)).toEqual(['unit', 'integration']);
    expect(digestReviewWorkflowAssignments(first)).toBe(digestReviewWorkflowAssignments(second));
    expect(digestReviewWorkflowAssignments(first)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('binds assignment identity to policy, manifest, prompts, schemas, and ordered review units', () => {
    const base = persona('security', ['auth']);
    const original = createReviewWorkflowAssignments({ policyDigest, manifestDigest, personas: [base] })[0];
    const mutations = [
      { policyDigest: 'c'.repeat(64), manifestDigest, personas: [base] },
      { policyDigest, manifestDigest: 'd'.repeat(64), personas: [base] },
      { policyDigest, manifestDigest, personas: [{ ...base, assignmentPrompt: 'different' }] },
      { policyDigest, manifestDigest, personas: [{ ...base, personaResultSchema: { type: 'null' } }] },
      { policyDigest, manifestDigest, personas: [{ ...base, passes: [{ ...base.passes[0], reviewUnitIds: [`ru_${'9'.repeat(64)}`] }] }] },
    ];

    for (const input of mutations) {
      expect(createReviewWorkflowAssignments(input)[0].assignmentId).not.toBe(original.assignmentId);
    }
  });

  it('rejects duplicate personas and malformed or unknown assignment input', () => {
    const security = persona('security', ['auth']);
    expect(() => createReviewWorkflowAssignments({ policyDigest, manifestDigest, personas: [security, security] }))
      .toThrow(/duplicate persona/i);
    expect(() => createReviewWorkflowAssignments({ policyDigest, manifestDigest, personas: [{ ...security, surprise: true }] }))
      .toThrow(/unknown persona field/i);
    expect(() => createReviewWorkflowAssignments({ policyDigest, manifestDigest, personas: [{ ...security, passes: [] }] }))
      .toThrow(/at least one pass/i);
    expect(() => createReviewWorkflowAssignments({ policyDigest: 'not-a-digest', manifestDigest, personas: [security] }))
      .toThrow(/policyDigest/i);
  });
});
