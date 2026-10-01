import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
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
const partitionCalls = new Map();
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
  const key = String(firstPartition);
  const call = (partitionCalls.get(key) || 0) + 1;
  if (testing) partitionCalls.set(key, call);
  if (process.env.RECOVERY_FIXTURE && testing && call === 1) {
    if (!malformed) {
      return new Response(JSON.stringify({ error: { message: 'fixture rate limit' } }), {
        status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0.001' },
      });
    }
    if (process.env.RECOVERY_FIXTURE === 'present') {
      return new Response(JSON.stringify({ error: { message: 'response_format json_schema is not supported' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }
  }
  const content = malformed ? '' : JSON.stringify({ findings: [] });
  const reasoning = malformed ? 'synthetic non-JSON reasoning '.repeat(1_000) : '';
  // These finish reasons are fixture inputs, not claims about the live incident.
  const finish_reason = malformed ? 'length' : 'stop';
  const model = malformed ? 'fixture-malformed-model' : 'fixture-successful-model';
  const provider = malformed ? 'anthropic' : 'openai';
  const openrouter_metadata = { strategy: malformed ? 'fallback' : 'primary',
    region: malformed ? 'eu' : 'us', attempt: malformed ? 2 : 1 };
  const usage = { prompt_tokens: 10, completion_tokens: malformed ? 20 : 1 };
  if (body.stream) {
    const payload = { model, provider, openrouter_metadata, usage, choices: [{
      delta: { content, reasoning_content: reasoning }, finish_reason,
    }] };
    return new Response('data: ' + JSON.stringify(payload) + '\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  }
  return new Response(JSON.stringify({ model, provider, openrouter_metadata, usage, choices: [{
    message: { content, reasoning_content: reasoning }, finish_reason,
  }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
pipeline.main().then(() => console.log('FIXTURE_CALLS ' + JSON.stringify({
  malformedCalls, successfulCalls, exitCode: process.exitCode ?? 0,
}))).catch(() => { process.exitCode = 1; });
`;

function runPartitionedReview(failPartition: 'first' | 'last' | 'none', recoveryFixture?: 'present' | 'absent') {
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
        ...(recoveryFixture ? {
          RECOVERY_FIXTURE: recoveryFixture,
          REVIEW_YETI_TRANSPORTS: JSON.stringify([{
            name: 'openai-fixture', provider: 'openai', base_url: 'https://opencode.ai/zen/v1',
            api_key_env: 'OPENROUTER_API_KEY', model: 'glm-5.3-flash', stream: true,
            structured_output_mode: 'json_schema',
            rate_limit: { max_retries: 1, max_retry_after_ms: 100 },
          }]),
        } : {}),
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
      resolvedProvider: 'anthropic',
      routerMetadata: { strategy: 'fallback', region: 'eu', attempt: 2 },
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
      recoveryAction: null,
      outputContract: { terminalParsed: true },
    });
    expect(testing.responseAttempts).toHaveLength(1);
    expect(testing.responseAttempts[0]).toMatchObject({ outcome: 'parsed', finishReason: 'stop' });
  });

  it.each([
    ['first', 'present'], ['last', 'present'], ['first', 'absent'], ['last', 'absent'],
  ] as const)('publishes BLOCK with real %s failure recovery %s', (partition, recovery) => {
    const { calls, outputs, telemetry, summary, stdout } = runPartitionedReview(partition, recovery);
    expect(calls).toEqual({ malformedCalls: 2, successfulCalls: 2, exitCode: 0 });
    expect(outputs).toMatchObject({ verdict: 'BLOCK', 'gate-decision': 'BLOCK', 'merge-eligible': 'false', 'files-omitted': '0' });
    expect(summary).toContain('Degraded (1/2 personas)');
    // The actual request loop, not a stamped result, sets these recovery actions:
    // malformed lane: optional schema fallback; successful sibling: 429 retry.
    expect(stdout).toContain('honoring bounded Retry-After');
    const testing = telemetry.lanes.find((lane: any) => lane.personaId === 'testing');
    expect(testing).toMatchObject({
      configuredTransport: 'openai', resolvedProvider: 'anthropic',
      recoveryAction: recovery === 'present' ? 'structured_output_fallback' : null,
      failureClass: 'malformed_output', outputShape: 'no_json', finishReason: 'length',
      routerMetadata: { strategy: 'fallback', region: 'eu', attempt: 2 },
    });
    expect(testing.responseAttempts).toHaveLength(2);
    expect(testing.responseAttempts.at(-1)).toMatchObject({ outcome: 'malformed_output', provider: 'anthropic' });
    expect(JSON.stringify(telemetry)).not.toContain('synthetic non-JSON reasoning');
  });
});

// Every assertion calls the same exported helper used by main(). No source
// extraction, expression matching, runtime mutation or test-only selector port.
function loadPartitionReducer() {
  const filename = path.join(root, '.github/workflows/pipelines/review-pipeline.js');
  return createRequire(import.meta.url)(filename);
}

function diagnosticLane(kind: 'failed' | 'successful', recoveryAction: string | null) {
  const failed = kind === 'failed';
  const provider = failed ? 'anthropic' : 'openai';
  const transport = failed ? 'anthropic-failed' : 'openai-successful';
  const requestFingerprint = (failed ? 'a' : 'b').repeat(64);
  return {
    personaId: 'testing', findings: [], decision: failed ? 'ERROR' : 'APPROVE',
    ...(failed ? { error: 'Model response contained no parseable findings JSON.' } : {}),
    transport, provider, model: `fixture-${kind}-model`,
    ttftMs: failed ? 137 : 23,
    routerMetadata: { strategy: failed ? 'fallback' : 'primary', region: failed ? 'eu' : 'us', attempt: failed ? 2 : 1 },
    requestFingerprint,
    responseAttempts: [{
      attempt: 1, outcome: failed ? 'malformed_output' : 'parsed', transport, provider,
      ttftMs: failed ? 137 : 23, requestFingerprint,
      outputShape: failed ? 'no_json' : 'direct_json_object',
      finishReason: failed ? 'length' : 'stop',
    }],
    recoveryAction,
    failureClass: failed ? 'malformed_output' : null,
    outputShape: failed ? 'no_json' : 'direct_json_object',
    finishReason: failed ? 'length' : 'stop',
    contentPresent: !failed, reasoningPresent: failed,
    responseStatus: 200, attemptCount: 1,
  };
}

function reduceDiagnosticLanes(lanes: ReturnType<typeof diagnosticLane>[]) {
  const fixture = loadPartitionReducer();
  const [result] = fixture.aggregatePartitionPersonaResults(lanes.map((lane) => [lane]), [{ id: 'testing', name: 'Testing' }]);
  const receipt = fixture.buildProviderTelemetryReceipt([result], { repo: 'fixture/example', prNumber: 1 });
  return { result, receipt: receipt.lanes[0] };
}

function expectFailedAttribution(result: any, receipt: any, failed: ReturnType<typeof diagnosticLane>) {
  expect(result).toMatchObject({
    decision: 'ERROR', transport: failed.transport, provider: failed.provider, model: failed.model,
    ttftMs: failed.ttftMs, routerMetadata: failed.routerMetadata,
    recoveryAction: failed.recoveryAction, requestFingerprint: failed.requestFingerprint,
  });
  expect(result.responseAttempts).toHaveLength(1);
  expect(result.responseAttempts[0]).toMatchObject({
    transport: failed.provider, provider: failed.provider, ttftMs: failed.ttftMs,
    requestFingerprint: failed.requestFingerprint, outcome: 'malformed_output',
  });
  expect(receipt).toMatchObject({
    configuredTransport: failed.provider, resolvedProvider: failed.provider,
    modelDigest: createHash('sha256').update(failed.model).digest('hex'),
    routerMetadata: failed.routerMetadata, recoveryAction: failed.recoveryAction,
    requestFingerprint: failed.requestFingerprint,
    failureClass: 'malformed_output', outputShape: 'no_json', finishReason: 'length',
  });
}

describe('production partition reducer attribution and recovery branches', () => {
  it.each([
    [false, 'rate_limit_retry', 'structured_output_fallback'],
    [true, 'rate_limit_retry', 'structured_output_fallback'],
    [false, null, 'structured_output_fallback'],
    [true, null, 'structured_output_fallback'],
    [false, 'rate_limit_retry', null],
    [true, 'rate_limit_retry', null],
  ] as const)('binds two real failed runs with reversed=%s and recovery=%s/%s', (reversed, firstRecovery, lastRecovery) => {
    const first = diagnosticLane('failed', firstRecovery);
    const last = { ...diagnosticLane('failed', lastRecovery), ttftMs: 149 };
    last.responseAttempts = [{ ...last.responseAttempts[0], ttftMs: last.ttftMs }];
    const lanes = reversed ? [last, first] : [first, last];
    const { result, receipt } = reduceDiagnosticLanes(lanes);
    expectFailedAttribution(result, receipt, lanes[0]);
    expect(result.error).toBe(lanes[0].error);
  });

  it.each([
    ['first', 'structured_output_fallback'], ['last', 'structured_output_fallback'],
    ['first', null], ['last', null],
  ] as const)('retains %s failure recoveryAction=%s without borrowing sibling recovery', (order, recoveryAction) => {
    const failed = diagnosticLane('failed', recoveryAction);
    const successful = diagnosticLane('successful', 'rate_limit_retry');
    const { result, receipt } = reduceDiagnosticLanes(order === 'first' ? [failed, successful] : [successful, failed]);
    expectFailedAttribution(result, receipt, failed);
    // Explicit absent value, not a truthiness assertion: never borrow the
    // successful partition's recorded recovery action for the failed lane.
    expect(result.recoveryAction).toBe(recoveryAction);
    expect(receipt.recoveryAction).toBe(recoveryAction);
  });

  it('keeps the first failure representative when a later failure has distinct metadata', () => {
    const first = diagnosticLane('failed', 'rate_limit_retry');
    const last = { ...diagnosticLane('failed', 'structured_output_fallback'), ttftMs: 149,
      transport: 'gemini-failed', provider: 'gemini', error: 'Fixture last malformed response.',
      routerMetadata: { strategy: 'last-failure', region: 'eu', attempt: 3 },
      model: 'fixture-last-failure-model', requestFingerprint: 'c'.repeat(64) };
    last.responseAttempts = [{ ...last.responseAttempts[0], transport: last.transport, provider: last.provider,
      ttftMs: last.ttftMs, requestFingerprint: last.requestFingerprint }];
    const { result, receipt } = reduceDiagnosticLanes([first, last]);
    expectFailedAttribution(result, receipt, first);
    expect(result.error).toBe(first.error);
  });

  it.each(['first', 'last'] as const)('all-success keeps base attribution and the %s recorded recovery', (recoveryOrder) => {
    const base = diagnosticLane('successful', recoveryOrder === 'first' ? 'rate_limit_retry' : null);
    const last = { ...diagnosticLane('successful', 'structured_output_fallback'),
      transport: 'anthropic-last', provider: 'anthropic', model: 'fixture-last-success', ttftMs: 999,
      routerMetadata: { strategy: 'last', region: 'eu', attempt: 4 }, requestFingerprint: 'd'.repeat(64) };
    const { result } = reduceDiagnosticLanes([base, last]);
    expect(result).toMatchObject({
      decision: 'APPROVE', transport: base.transport, provider: base.provider, model: base.model,
      ttftMs: base.ttftMs, routerMetadata: base.routerMetadata,
      requestFingerprint: base.requestFingerprint, responseAttempts: base.responseAttempts,
      recoveryAction: recoveryOrder === 'first' ? 'rate_limit_retry' : 'structured_output_fallback',
    });
  });
});
