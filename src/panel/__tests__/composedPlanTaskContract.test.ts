import { describe, expect, it, vi } from 'vitest';
import { parseAndValidateConfig } from '../../config/configLoader';
import type { OpenRouterResponse } from '../../gateway/openRouterClient';
import { buildPlanDirective, executeComposedReview } from '../composedEngine';
import { validateTaskPlan, type RawReviewTask } from '../reviewTask';
import { MAX_TASK_ID_LENGTH, MAX_TASK_TEXT_LENGTH, TASK_DIMENSIONS, TASK_ID_PATTERN } from '../../reviewTaskContract';

const changedPath = 'src/auth/guard.ts';
const changedFiles = [{
  path: changedPath,
  patch: '@@ -1,1 +1,2 @@\n+export function guard() { return true; }',
}];

const mockYaml = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: security
    charter: builtin:security
    providers: [codex]
    paths: ["**/*"]
    required: true
    enabled: true
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 30
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 5
      arbiter_timeout_s: 5
  arbiter:
    order: [codex]
`;

function config() {
  return parseAndValidateConfig(mockYaml) as any;
}

function fakeResponse(content: string): OpenRouterResponse {
  return {
    model: 'test-model',
    content,
    usage: { prompt: 10, completion: 10, total: 20 },
    costUSD: 0.001,
    raw: {},
  };
}

function messageText(message: any): string {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('\n');
  }
  return '';
}

function requestLastText(request: any): string {
  const messages = request.messages as any[];
  return messageText(messages[messages.length - 1]);
}

function issuedNonce(messages: any[]): string {
  const matches = [...messages.map(messageText).join('\n').matchAll(/CT_REVIEW_NONCE:([a-f0-9-]+)/gu)];
  const match = matches.at(-1);
  if (!match) throw new Error('test fixture could not find issued request nonce');
  return match[1];
}

function validTask() {
  return {
    id: 'security-auth-example',
    dimension: 'security',
    paths: [changedPath],
    question: 'What regression risk should be checked in this changed path?',
    rationale: 'This task examines the changed path for a concrete behavior regression.',
  };
}

function expectedPlanExample(nonce: string): string {
  return JSON.stringify({ nonce, tasks: [validTask()] });
}

function expectTaskContractGuidance(text: string, nonce: string): void {
  const idRule = `Task ids must match ${TASK_ID_PATTERN.source} (1-${MAX_TASK_ID_LENGTH} characters).`;
  expect(text.split(idRule)).toHaveLength(2);
  expect(text).toContain('include these nested fields: "id", "dimension", "paths", "question", and "rationale"');
  expect(text).toContain(`question and rationale must each be nonempty, non-whitespace strings of at most ${MAX_TASK_TEXT_LENGTH} characters`);
  expect(text).toContain(`The "dimension" must be one of: ${TASK_DIMENSIONS.join(', ')}.`);
  expect(text).toContain(expectedPlanExample(nonce));
  expect(text).toContain('top-level fields "nonce" and "tasks"');
}

describe('composed plan task-field contract clarity', () => {
  it('preserves the existing ID-pattern source and flags while sharing its bound', () => {
    expect(MAX_TASK_ID_LENGTH).toBe(128);
    expect(TASK_ID_PATTERN.source).toBe('^[a-z][a-z0-9_-]{0,127}$');
    expect(TASK_ID_PATTERN.flags).toBe('u');
  });

  it('omits the positive task example when no changed code path is available', () => {
    const nonce = 'empty-path-fixture-nonce';
    const text = buildPlanDirective(4, [], nonce);

    expect(text).toContain('include these nested fields: "id", "dimension", "paths", "question", and "rationale"');
    expect(text).toContain(`question and rationale must each be nonempty, non-whitespace strings of at most ${MAX_TASK_TEXT_LENGTH} characters`);
    expect(text).toContain(`Task ids must match ${TASK_ID_PATTERN.source} (1-${MAX_TASK_ID_LENGTH} characters).`);
    expect(text).toContain(`The "dimension" must be one of: ${TASK_DIMENSIONS.join(', ')}.`);
    expect(text).toContain('No changed code path is available for a positive task example.');
    expect(text).not.toContain('Positive example of the complete plan/task JSON shape');
    expect(text).not.toContain('"paths":[null]');
    expect(text).toContain(`CT_REVIEW_NONCE:${nonce}`);
  });

  it.each(['src/util/format.ts', 'src/utils/name, "quoted".ts'])(
    'uses the valid non-security example for the exact changed path %s', (path) => {
      const nonce = 'non-security-example-nonce';
      const text = buildPlanDirective(4, [path], nonce, []);
      const task = { ...validTask(), id: 'testing-contract-example', dimension: 'testing', paths: [path] };

      expect(text).toContain(JSON.stringify({ nonce, tasks: [task] }));
      expect(text).not.toContain('security-auth-example');
      expect(text.split(`Task ids must match ${TASK_ID_PATTERN.source} (1-${MAX_TASK_ID_LENGTH} characters).`)).toHaveLength(2);
      expect(validateTaskPlan({ tasks: [task] }, { changedFiles: [path] })).toMatchObject({ valid: true, tasks: [task] });
    },
  );

  it.each([
    ['question', 'missing', undefined],
    ['question', 'empty', ''],
    ['question', 'whitespace-only', ' \t\n'],
    ['rationale', 'missing', undefined],
    ['rationale', 'empty', ''],
    ['rationale', 'whitespace-only', ' \t\n'],
  ] as const)('keeps %s %s plans fail-closed', (field, shape, invalidValue) => {
    const task: RawReviewTask = {
      id: 'security-auth-example',
      dimension: 'security',
      paths: [changedPath],
      question: 'What could fail?',
      rationale: 'The changed path has a relevant behavior.',
    };
    if (shape === 'missing') delete task[field];
    else task[field] = invalidValue;

    expect(validateTaskPlan({ tasks: [task] }, { changedFiles: [changedPath] })).toMatchObject({
      valid: false,
      reason: 'invalid_task_fields',
    });
  });

  it.each([MAX_TASK_ID_LENGTH, MAX_TASK_ID_LENGTH + 1])('keeps the validator task-id boundary at %i characters', (length) => {
    const id = 'a'.repeat(length);
    expect(TASK_ID_PATTERN.test(id)).toBe(length === MAX_TASK_ID_LENGTH);
    expect(validateTaskPlan({ tasks: [{ ...validTask(), id }] }, { changedFiles: [changedPath] }).valid).toBe(length === MAX_TASK_ID_LENGTH);
  });

  it.each(['blank fields', 'nonce mismatch', 'oversized id'] as const)(
    'captures a valid correction after %s and includes the full nonce/path/task contract in both requests', async (firstFailure) => {
    const requests: any[] = [];
    const checkpoints: any[] = [];
    const correctedTask = {
      ...validTask(),
      id: 'security-auth-corrected',
      question: 'Does the actual corrected task preserve its own supplied question?',
      rationale: 'Corrected model values are deliberately distinct from the prompt example.',
    };
    const complete = vi.fn(async (request: any) => {
      requests.push(request);
      const latest = requestLastText(request);
      const nonce = issuedNonce(request.messages);
      if (latest.includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({
          nonce: firstFailure === 'nonce mismatch' ? 'wrong-issued-nonce' : nonce,
          tasks: [{
            ...validTask(),
            ...(firstFailure === 'blank fields' ? { question: '   ', rationale: '' } : {}),
            ...(firstFailure === 'oversized id' ? { id: 'a'.repeat(MAX_TASK_ID_LENGTH + 1) } : {}),
          }],
        }));
      }
      if (latest.includes('PLAN_CORRECTION')) {
        return fakeResponse(JSON.stringify({ nonce, tasks: [correctedTask] }));
      }
      if (latest.includes('WORK TURN')) {
        return fakeResponse(JSON.stringify({ nonce, task: correctedTask.id, status: 'COMPLETE', findings: [] }));
      }
      throw new Error('unexpected engine request phase');
    });

    const result = await executeComposedReview({
      config: config(),
      changedFiles,
      repository: 'acme/reviewer-fixture',
      headSha: 'a'.repeat(40),
      client: { complete },
      checkpoint: {
        resumed: null,
        capture: (snapshot) => { checkpoints.push(structuredClone(snapshot)); },
        save: async () => {},
      },
    });

    expect(complete).toHaveBeenCalledTimes(3);
    expect(requests.map(requestLastText)).toEqual(expect.arrayContaining([
      expect.stringContaining('PLAN TURN'),
      expect.stringContaining('PLAN_CORRECTION'),
      expect.stringContaining('WORK TURN'),
    ]));

    const initialText = requestLastText(requests[0]);
    const correctionText = requestLastText(requests[1]);
    const nonce = issuedNonce(requests[0].messages);
    expectTaskContractGuidance(initialText, nonce);
    expectTaskContractGuidance(correctionText, nonce);
    if (firstFailure === 'blank fields') {
      expect(correctionText).toContain('missing or blank question or rationale');
      expect(correctionText).toContain('security-auth-example');
      expect(correctionText).toContain(`Changed files you may name, and no others: ${JSON.stringify([changedPath])}.`);
    } else if (firstFailure === 'nonce mismatch') {
      expect(correctionText).toContain('the "nonce" field did not match the nonce issued for this request');
    } else {
      expect(correctionText).toContain(`Changed files you may name, and no others: ${JSON.stringify([changedPath])}.`);
    }
    expect(checkpoints.at(-1)?.plannerPlan).toEqual([correctedTask]);
    expect(checkpoints.at(-1)?.plan).toEqual(result.taskPlan);
    expect(result.taskPlan).toEqual([{
      ...correctedTask,
      question: `Test a specific changed behavior; rules=architecture,correctness,performance; risk=security-sensitive:0. ${correctedTask.question}`,
      rationale: expect.stringMatching(/^Regions=[a-f0-9]{64}\. Caller\/contract context: \[\]\. Required: trace the changed security boundary through the enforcing caller and protected operation\. Corrected model values are deliberately distinct from the prompt example\.$/u),
    }]);
    expect(result.personas).toMatchObject([{ id: correctedTask.id, decision: 'APPROVE', findings: [] }]);
    },
  );

  it('rejects a second invalid plan after exactly one correction and makes no task request', async () => {
    const requests: any[] = [];
    const complete = vi.fn(async (request: any) => {
      requests.push(request);
      const latest = requestLastText(request);
      const nonce = issuedNonce(request.messages);
      if (latest.includes('PLAN TURN') || latest.includes('PLAN_CORRECTION')) {
        return fakeResponse(JSON.stringify({ nonce, tasks: [{
          id: 'security-auth-example',
          dimension: 'security',
          paths: [changedPath],
          question: '',
          rationale: ' \t ',
        }] }));
      }
      throw new Error('a task request must not follow a second invalid plan');
    });

    await expect(executeComposedReview({
      config: config(),
      changedFiles,
      repository: 'acme/reviewer-fixture',
      headSha: 'b'.repeat(40),
      client: { complete },
    })).rejects.toMatchObject({
      failureClass: 'contract',
      message: expect.stringContaining('after its one corrective turn'),
    });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(requests.map(requestLastText)).toEqual(expect.arrayContaining([
      expect.stringContaining('PLAN TURN'),
      expect.stringContaining('PLAN_CORRECTION'),
    ]));
    expect(requests.some((request) => requestLastText(request).includes('WORK TURN'))).toBe(false);
  });
});
