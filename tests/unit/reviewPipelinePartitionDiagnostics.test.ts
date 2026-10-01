import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createScratchOwner, requiredSuiteScratchRoot } from '../support/scratch-lifecycle';

const root = path.resolve(__dirname, '../..');
const diff = [
  'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -0,0 +1,3 @@',
  '+export const a = 1;', '+export const aa = 11;', '+export const aaa = 111;',
  'diff --git a/src/b.ts b/src/b.ts', '--- a/src/b.ts', '+++ b/src/b.ts', '@@ -0,0 +1,3 @@',
  '+export const b = 2;', '+export const bb = 22;', '+export const bbb = 222;', '',
].join('\n');

// Run the actual main() partition reducer, parser, receipt writer and step-output
// publisher. Every model response is synthetic; the child inherits no credentials
// and replaces fetch before main() can issue any request.
const child = String.raw`
const pipeline = require(process.env.PIPELINE);
let malformedCalls = 0;
let successfulCalls = 0;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const prompt = body.messages.map((message) => Array.isArray(message.content)
    ? message.content.map((part) => part.text || '').join('')
    : String(message.content)).join(' ');
  const testing = /You are [^ ]+ Testing/i.test(prompt);
  const firstPartition = prompt.includes('export const aaa = 111;');
  const malformed = testing && (process.env.FAIL_PARTITION === 'first'
    ? firstPartition : process.env.FAIL_PARTITION === 'last' && !firstPartition);
  if (testing) {
    if (malformed) malformedCalls += 1;
    else successfulCalls += 1;
  }
  const content = malformed ? '' : JSON.stringify({ findings: [] });
  const reasoning = malformed ? 'synthetic non-JSON reasoning '.repeat(1_000) : '';
  // These finish reasons are fixture inputs, not claims about the live incident.
  const finish_reason = malformed ? 'length' : 'stop';
  const model = malformed ? 'fixture-malformed-model' : 'fixture-successful-model';
  const usage = { prompt_tokens: 10, completion_tokens: malformed ? 20 : 1 };
  if (body.stream) {
    const payload = { model, usage, choices: [{
      delta: { content, reasoning_content: reasoning }, finish_reason,
    }] };
    return new Response('data: ' + JSON.stringify(payload) + '\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  }
  return new Response(JSON.stringify({ model, usage, choices: [{
    message: { content, reasoning_content: reasoning }, finish_reason,
  }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
pipeline.main().then(() => console.log('FIXTURE_CALLS ' + JSON.stringify({
  malformedCalls, successfulCalls, exitCode: process.exitCode ?? 0,
}))).catch(() => { process.exitCode = 1; });
`;

function runPartitionedReview(failPartition: 'first' | 'last' | 'none') {
  const scratch = createScratchOwner({
    parentDir: requiredSuiteScratchRoot(),
    prefix: 'partition-diagnostics-',
    kind: 'partition-diagnostics-fixture',
  });
  try {
    const result = spawnSync(process.execPath, ['-e', child], {
      cwd: scratch.path,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: scratch.path,
        PIPELINE: path.join(root, '.github/workflows/pipelines/review-pipeline.js'),
        NODE_ENV: 'test',
        VITEST: 'true',
        GITHUB_ACTIONS: 'false',
        PR_DIFF: diff,
        ACTIVE_PERSONAS: JSON.stringify(['security', 'testing']),
        OPENROUTER_API_KEY: 'test-key',
        OPENROUTER_BASE_URL: 'https://opencode.ai/zen/v1',
        OPENROUTER_MODEL: 'glm-5.3-flash',
        REVIEW_TRANSPORT_COMPAT: 'opencode',
        FAIL_PARTITION: failPartition,
        MAX_DIFF_CHARS: '120',
        GITHUB_OUTPUT: path.join(scratch.path, 'output'),
        GITHUB_STEP_SUMMARY: path.join(scratch.path, 'summary.md'),
        RUNNER_TEMP: scratch.path,
        CT_REVIEW_CONFIG_DIR: scratch.path,
        CT_REVIEW_DATA_DIR: scratch.path,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const stdout = `${result.stdout}${result.stderr}`;
    const callsLine = stdout.split('\n').find((line) => line.startsWith('FIXTURE_CALLS '));
    expect(callsLine).toBeDefined();
    const calls = JSON.parse(callsLine!.slice('FIXTURE_CALLS '.length));
    const outputs = Object.fromEntries(fs.readFileSync(path.join(scratch.path, 'output'), 'utf8')
      .trim().split('\n').map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
    const telemetryPaths = fs.readdirSync(scratch.path)
      .filter((name) => name.startsWith('review-yeti-provider-telemetry-'));
    expect(telemetryPaths).toHaveLength(1);
    const telemetry = JSON.parse(fs.readFileSync(path.join(scratch.path, telemetryPaths[0]), 'utf8'));
    const summary = fs.readFileSync(path.join(scratch.path, 'summary.md'), 'utf8');
    return { calls, outputs, telemetry, summary, stdout };
  } finally {
    // spawnSync has returned and the exact child is closed before fixture cleanup.
    scratch.cleanup();
  }
}

describe('partitioned Action diagnostics remain bound to the failed partition', () => {
  it.each(['first', 'last'] as const)('retains the %s partition failure without borrowing successful output', (partition) => {
    const { calls, outputs, telemetry, summary, stdout } = runPartitionedReview(partition);
    expect(stdout).toContain('Partitioned into 2');
    expect(calls).toEqual({ malformedCalls: 2, successfulCalls: 1, exitCode: 0 });
    // Exercise real step publication before asserting diagnostics: a successful
    // sibling never turns a missing lane into SHIP or merge eligibility.
    expect(outputs).toMatchObject({
      verdict: 'BLOCK', 'gate-decision': 'BLOCK', 'merge-eligible': 'false', 'files-omitted': '0',
    });
    expect(summary).toContain('Degraded (1/2 personas)');
    expect(stdout).toContain('[Persona testing] Lane failed: Model response contained no parseable findings JSON.');
    const testing = telemetry.lanes.find((lane: any) => lane.personaId === 'testing');
    expect(testing.responseAttempts).toHaveLength(2);
    expect(testing.modelDigest).toBe(createHash('sha256').update('fixture-malformed-model').digest('hex'));
    expect(testing.requestFingerprint).toBe(testing.responseAttempts.at(-1).requestFingerprint);
    expect(testing).toMatchObject({
      attemptCount: 3,
      failureClass: 'malformed_output',
      responseStatus: 200,
      outputShape: 'no_json',
      finishReason: 'length',
      findingsSource: 'none',
      contentPresent: false,
      reasoningPresent: true,
      contentSizeBucket: 'empty',
      reasoningSizeBucket: 'oversize',
      outputContract: { terminalParsed: false },
    });
    for (const [index, attempt] of testing.responseAttempts.entries()) {
      expect(attempt).toMatchObject({
        attempt: index + 1,
        outcome: 'malformed_output',
        failureClass: 'malformed_output',
        responseStatus: 200,
        outputShape: 'no_json',
        finishReason: 'length',
        findingsSource: 'none',
        contentPresent: false,
        reasoningPresent: true,
        contentSizeBucket: 'empty',
        reasoningSizeBucket: 'oversize',
        outputContract: { terminalParsed: false },
      });
    }
    expect(JSON.stringify(telemetry)).not.toContain('synthetic non-JSON reasoning');
  });

  it('preserves the all-successful partition publication and diagnostics', () => {
    const { calls, outputs, telemetry } = runPartitionedReview('none');
    expect(calls).toEqual({ malformedCalls: 0, successfulCalls: 2, exitCode: 0 });
    expect(outputs).toMatchObject({ verdict: 'SHIP', 'gate-decision': 'PASS', 'merge-eligible': 'true' });
    const testing = telemetry.lanes.find((lane: any) => lane.personaId === 'testing');
    expect(testing).toMatchObject({
      attemptCount: 2, failureClass: null, outputShape: 'direct_json_object', finishReason: 'stop',
      findingsSource: 'content', contentPresent: true, reasoningPresent: false,
      outputContract: { terminalParsed: true },
    });
    expect(testing.responseAttempts).toHaveLength(1);
    expect(testing.responseAttempts[0]).toMatchObject({ outcome: 'parsed', finishReason: 'stop' });
  });
});
