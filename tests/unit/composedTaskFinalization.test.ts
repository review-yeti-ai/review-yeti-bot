import { describe, expect, it, vi } from 'vitest';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { extractMessageContentText } from '../../src/panel/panelEngine';
import { parseChangedFiles } from '../../src/review/changedFiles';

const changedFiles = parseChangedFiles([
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1 @@',
  '-export const value = 1;',
  '+export const value = 2;',
  '',
].join('\n')).files;

const config = ctReviewConfigV3Schema.parse({
  ...createDefaultV3Config(),
  quorum: 1,
  personas: [{ id: 'architecture', enabled: true, required: true, charter: 'builtin:architecture', paths: ['**/*'], providers: ['bifrost'] }],
  reviewers: {
    execution: 'personas', fallback: 'none', overall_timeout_s: 30,
    providers: [{ id: 'bifrost', enabled: true, model: 'pr-reviewer', effort: 'medium', review_timeout_s: 15, arbiter_timeout_s: 15 }],
    arbiter: { order: ['bifrost'] },
  },
  review_engine: 'composed',
  composed: { max_tasks: 1 },
});

function makeClient(alwaysRequestToolOnFinal = false) {
  let taskTurns = 0;
  const complete = vi.fn(async (request: any) => {
    const prompt = request.messages.map((message: any) => extractMessageContentText(message.content)).join('\n');
    const nonces = [...prompt.matchAll(/CT_REVIEW_NONCE:([a-f0-9-]+)/gu)];
    const nonce = nonces.at(-1)?.[1];
    if (!nonce) throw new Error('task or plan nonce missing');
    let body: unknown;
    if (!prompt.includes('WORK TURN')) {
      body = { nonce, tasks: [{ id: 'verify-change', dimension: 'architecture', paths: ['src/app.ts'], question: 'Is this change sound?', rationale: 'Review changed code.' }] };
    } else {
      taskTurns += 1;
      body = taskTurns <= 10 || (alwaysRequestToolOnFinal && taskTurns <= 12)
        ? { tool: 'read_file', args: { path: 'src/app.ts' } }
        : { nonce, task: 'verify-change', status: 'COMPLETE', findings: [] };
    }
    return { model: 'pr-reviewer', content: JSON.stringify(body), usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0, raw: {} };
  });
  return { complete, getTaskTurns: () => taskTurns };
}

describe('composed task finalization', () => {
  it('accepts a bound verdict after nine read-only turns and one corrected final turn', async () => {
    const client = makeClient();
    const result = await executeComposedReview({
      config, changedFiles, repository: 'acme/app', headSha: 'a'.repeat(40), client: client as never,
    });
    expect(client.getTaskTurns()).toBe(11);
    expect(result.applicablePersonaIds).toEqual(['verify-change']);
    expect(result.personas).toMatchObject([{ id: 'verify-change', decision: 'APPROVE', toolTurns: 9 }]);
    expect(result.unreportedLanes).toEqual([]);
    const finalCall = client.complete.mock.calls.at(-1)?.[0] as any;
    expect(finalCall.responseFormat.json_schema.name).toBe('ct_review_task_result_v1');
    expect(finalCall.messages.some((message: any) => extractMessageContentText(message.content).includes('TASK_FINALIZATION'))).toBe(true);
  });

  it('keeps a task off the roster if every finalization response is still a tool request', async () => {
    const client = makeClient(true);
    const result = await executeComposedReview({
      config, changedFiles, repository: 'acme/app', headSha: 'b'.repeat(40), client: client as never,
    });
    expect(client.getTaskTurns()).toBe(12);
    expect(result.personas).toEqual([]);
    expect(result.unreportedLanes).toMatchObject([{ id: 'verify-change', failureClass: 'malformed_output' }]);
  });
});
