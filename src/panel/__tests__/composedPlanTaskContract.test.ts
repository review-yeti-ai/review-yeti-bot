import { describe, expect, it, vi } from 'vitest';
import { parseAndValidateConfig } from '../../config/configLoader';
import type { OpenRouterResponse } from '../../gateway/openRouterClient';
import { buildPlanDirective, executeComposedReview } from '../composedEngine';
import { validateTaskPlan, type RawReviewTask } from '../reviewTask';
import { MAX_TASK_TEXT_LENGTH, TASK_DIMENSIONS, TASK_ID_PATTERN } from '../../reviewTaskContract';

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
  expect(text).toContain(`Task ids must match ${TASK_ID_PATTERN.source} (1-128 characters).`);
  expect(text).toContain('include these nested fields: "id", "dimension", "paths", "question", and "rationale"');
  expect(text).toContain(`question and rationale must each be nonempty, non-whitespace strings of at most ${MAX_TASK_TEXT_LENGTH} characters`);
  expect(text).toContain(`The "dimension" must be one of: ${TASK_DIMENSIONS.join(', ')}.`);
  expect(text).toContain(expectedPlanExample(nonce));
  expect(text).toContain('top-level fields "nonce" and "tasks"');
}

describe('composed plan task-field contract clarity', () => {
  it('omits the positive task example when no changed code path is available', () => {
    const nonce = 'empty-path-fixture-nonce';
    const text = buildPlanDirective(4, [], nonce);

    expect(text).toContain('include these nested fields: "id", "dimension", "paths", "question", and "rationale"');
    expect(text).toContain(`question and rationale must each be nonempty, non-whitespace strings of at most ${MAX_TASK_TEXT_LENGTH} characters`);
    expect(text).toContain(`Task ids must match ${TASK_ID_PATTERN.source} (1-128 characters).`);
    expect(text).toContain('No changed code path is available for a positive task example.');
    expect(text).not.toContain('Positive example of the complete plan/task JSON shape');
    expect(text).not.toContain('"paths":[null]');
    expect(text).toContain(`CT_REVIEW_NONCE:${nonce}`);
  });

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

  it.each([128, 129])('keeps the validator task-id boundary at %i characters', (length) => {
    const id = 'a'.repeat(length);
    expect(TASK_ID_PATTERN.test(id)).toBe(length === 128);
    expect(validateTaskPlan({ tasks: [{ ...validTask(), id }] }, { changedFiles: [changedPath] }).valid).toBe(length === 128);
  });

  it.each(['blank fields', 'nonce mismatch', 'oversized id'] as const)(
    'captures a valid correction after %s and includes the full nonce/path/task contract in both requests', async (firstFailure) => {
    const requests: any[] = [];
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
            ...(firstFailure === 'oversized id' ? { id: 'a'.repeat(129) } : {}),
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
    expect(result.taskPlan).toEqual([correctedTask]);
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
