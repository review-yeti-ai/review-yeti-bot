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
  }, 15000);

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
  }, 15000);

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
  }, 15000);
});

// Every assertion calls the same exported helper used by main(). No source
// extraction, expression matching, runtime mutation or test-only selector port.
function loadPartitionReducer() {
  const filename = path.join(root, '.github/workflows/pipelines/review-pipeline.js');
  return createRequire(import.meta.url)(filename);
}

function createGuardedPartitionPlan(sourcePatch: string, safeDiffCapacityChars: number, partitionManager?: any) {
  const pipeline = loadPartitionReducer();
  const input = {
    files: [{
      path: 'src/partition-parity.ts',
      patch: sourcePatch,
      originalChars: sourcePatch.length,
      compactedChars: sourcePatch.length,
      status: 'modified',
    }],
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    safeDiffCapacityChars,
    modelConfig: {
      guardedGatewayDestination: true,
      model: pipeline.DIGEST_PINNED_GATEWAY_MODEL_ALIAS,
    },
    ...(partitionManager ? { partitionManager } : {}),
  };
  return pipeline.createReviewPartitionPlan(input);
}

function hunksFromPartitionPatch(patch: string, fileHeader: string): string[] {
  const lines = patch.slice(fileHeader.length).replace(/\n+$/u, '').split('\n');
  const hunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current.length > 0) hunks.push(current.join('\n'));
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) hunks.push(current.join('\n'));
  return hunks;
}

function runCanonicalPartitionProbe(sourcePatch: string, safeDiffCapacityChars: number, missingHelper?: string) {
  const pipelinePath = path.join(root, '.github/workflows/pipelines/review-pipeline.js');
  const script = String.raw`
    const Module = require('node:module');
    const originalLoad = Module._load;
    let parseCalls = 0;
    let rangeCalls = 0;
    let canonicalPath = null;
    Module._load = function canonicalHelperProbe(request, parent, isMain) {
      const value = originalLoad.call(this, request, parent, isMain);
      const normalized = String(request).replace(/\\/g, '/');
      if (!normalized.endsWith('/src/pipeline/shaPartitionManager.ts')) return value;
      canonicalPath = parent?.filename ? require('node:path').resolve(require('node:path').dirname(parent.filename), request) : normalized;
      return new Proxy(value, {
        get(target, key, receiver) {
          if (key === process.env.MISSING_CANONICAL_HELPER) return undefined;
          const helper = Reflect.get(target, key, receiver);
          if (key === 'parseUnifiedHunk' && typeof helper === 'function') {
            return (...args) => { parseCalls += 1; return Reflect.apply(helper, target, args); };
          }
          if (key === 'unifiedFragmentRangeStart' && typeof helper === 'function') {
            return (...args) => { rangeCalls += 1; return Reflect.apply(helper, target, args); };
          }
          return helper;
        },
      });
    };
    const pipeline = require(process.argv[1]);
    const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
    let result;
    try {
      const plan = pipeline.createReviewPartitionPlan({
        files: [{ path: 'src/partition-parity.ts', patch: input.sourcePatch, status: 'modified' }],
        baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        safeDiffCapacityChars: input.safeDiffCapacityChars,
        modelConfig: { guardedGatewayDestination: true, model: pipeline.DIGEST_PINNED_GATEWAY_MODEL_ALIAS },
      });
      result = {
        partitionCount: plan.partitions.length,
        partitionChars: plan.partitions.map((partition) => partition.totalChars),
        patches: plan.partitions.flatMap((partition) => partition.files.map((file) => file.patch)),
      };
    } catch (error) {
      result = { error: error?.message || String(error) };
    }
    process.stdout.write(JSON.stringify({ canonicalPath, parseCalls, rangeCalls, ...result }));
  `;
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_PATH;
  for (const key of Object.keys(childEnv)) if (key.startsWith('TS_NODE_')) delete childEnv[key];
  if (missingHelper) childEnv.MISSING_CANONICAL_HELPER = missingHelper;
  else delete childEnv.MISSING_CANONICAL_HELPER;
  const result = spawnSync(process.execPath, ['-e', script, pipelinePath], {
    cwd: root,
    env: childEnv,
    input: JSON.stringify({ sourcePatch, safeDiffCapacityChars }),
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`canonical partition probe failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

describe('guarded partition producer and validator stay in lossless parity', () => {
  const filePath = 'src/partition-parity.ts';
  const fileHeader = `diff --git a/${filePath} b/${filePath}\nindex 0000000..1111111 100644\n--- a/${filePath}\n+++ b/${filePath}\n`;
  const marker = '\\ No newline at end of file';

  it('routes guarded range and body validation through the canonical partition-manager helpers', () => {
    const sourcePatch = `${fileHeader}@@ -0,0 +1,4 @@ literal insertion\n+one\n+two\n+three\n+four\n`;
    const expected = [
      '@@ -0,0 +1,1 @@ literal insertion\n+one',
      '@@ -0,0 +2,1 @@ literal insertion\n+two',
      '@@ -0,0 +3,1 @@ literal insertion\n+three',
      '@@ -0,0 +4,1 @@ literal insertion\n+four',
    ];
    const safeDiffCapacityChars = fileHeader.length + Math.max(...expected.map((fragment) => fragment.length + 1));
    const probe = runCanonicalPartitionProbe(sourcePatch, safeDiffCapacityChars);
    const actual = probe.patches.flatMap((patch: string) => hunksFromPartitionPatch(patch, fileHeader));
    expect(probe.partitionCount).toBeGreaterThan(1);
    expect(actual).toEqual(expected); // independent literal anchor/body oracle
    expect(probe.parseCalls).toBeGreaterThan(0);
    expect(probe.rangeCalls).toBeGreaterThan(0);
  });

  it.each(['parseUnifiedHunk', 'unifiedFragmentRangeStart'] as const)(
    'fails closed when canonical validator helper %s is unavailable',
    (helper) => {
      const sourcePatch = `${fileHeader}@@ -0,0 +1,3 @@ missing helper\n+one\n+two\n+three\n`;
      const expected = [
        '@@ -0,0 +1,1 @@ missing helper\n+one',
        '@@ -0,0 +2,1 @@ missing helper\n+two',
        '@@ -0,0 +3,1 @@ missing helper\n+three',
      ];
      const safeDiffCapacityChars = fileHeader.length + Math.max(...expected.map((fragment) => fragment.length + 1));
      const probe = runCanonicalPartitionProbe(sourcePatch, safeDiffCapacityChars, helper);
      expect(probe.error).toBe(`lossless partition validator helper ${helper} is unavailable`);
    },
  );

  it.each([
    {
      name: 'zero old range at insertion start',
      sourceHeader: '@@ -0,0 +1,2 @@',
      body: ['+inserted-one', '+inserted-two'],
      expected: [
        '@@ -0,0 +1,1 @@\n+inserted-one',
        '@@ -0,0 +2,1 @@\n+inserted-two',
      ],
    },
    {
      name: 'zero old range at insertion end',
      sourceHeader: '@@ -2,0 +3,2 @@',
      body: ['+inserted-one', '+inserted-two'],
      expected: [
        '@@ -2,0 +3,1 @@\n+inserted-one',
        '@@ -2,0 +4,1 @@\n+inserted-two',
      ],
    },
    {
      name: 'zero new range for pure deletion',
      sourceHeader: '@@ -3,2 +2,0 @@',
      body: ['-removed-one', '-removed-two'],
      expected: [
        '@@ -3,1 +2,0 @@\n-removed-one',
        '@@ -4,1 +2,0 @@\n-removed-two',
      ],
    },
    {
      name: 'mixed insertion with a zero-side fragment between context lines',
      sourceHeader: '@@ -1,2 +1,4 @@',
      body: [' context-before', '+inserted-one', '+inserted-two', ' context-after'],
      expected: [
        '@@ -1,1 +1,1 @@\n context-before',
        '@@ -1,0 +2,1 @@\n+inserted-one',
        '@@ -1,0 +3,1 @@\n+inserted-two',
        '@@ -2,1 +4,1 @@\n context-after',
      ],
    },
    {
      name: 'omitted single counts in replacement',
      sourceHeader: '@@ -1 +1 @@',
      body: ['-old-line', '+new-line'],
      expected: [
        '@@ -1,1 +0,0 @@\n-old-line',
        '@@ -1,0 +1,1 @@\n+new-line',
      ],
    },
    {
      name: 'no-newline marker stays in the atom owned by its preceding deletion',
      sourceHeader: '@@ -1 +1 @@',
      body: ['-old-without-newline', marker, '+new-with-newline'],
      expected: [
        `@@ -1,1 +0,0 @@\n-old-without-newline\n${marker}`,
        '@@ -1,0 +1,1 @@\n+new-with-newline',
      ],
    },
    {
      name: 'no-newline marker stays in the atom owned by its preceding addition',
      sourceHeader: '@@ -1 +1 @@',
      body: ['-old-with-newline', '+new-without-newline', marker],
      expected: [
        '@@ -1,1 +0,0 @@\n-old-with-newline',
        `@@ -1,0 +1,1 @@\n+new-without-newline\n${marker}`,
      ],
    },
    {
      name: 'both replacement sides own their separate no-newline markers',
      sourceHeader: '@@ -1 +1 @@',
      body: ['-old-without-newline', marker, '+new-without-newline', marker],
      expected: [
        `@@ -1,1 +0,0 @@\n-old-without-newline\n${marker}`,
        `@@ -1,0 +1,1 @@\n+new-without-newline\n${marker}`,
      ],
    },
    {
      name: 'context owns its no-newline marker without consuming an extra range line',
      sourceHeader: '@@ -1,2 +1,2 @@',
      body: ['-old-before-unchanged-last-context', '+new-before-unchanged-last-context', ' shared-last-line', marker],
      expected: [
        '@@ -1,1 +0,0 @@\n-old-before-unchanged-last-context',
        '@@ -1,0 +1,1 @@\n+new-before-unchanged-last-context',
        `@@ -2,1 +2,1 @@\n shared-last-line\n${marker}`,
      ],
    },
  ])('accepts literal canonical ranges for $name', ({ sourceHeader, body, expected }) => {
    const sourcePatch = `${fileHeader}${sourceHeader}\n${body.join('\n')}\n`;
    const safeDiffCapacityChars = fileHeader.length + Math.max(...expected.map((fragment) => fragment.length + 1));
    expect(sourcePatch.length).toBeGreaterThan(safeDiffCapacityChars);

    const plan = createGuardedPartitionPlan(sourcePatch, safeDiffCapacityChars);
    const actual = plan.partitions.flatMap((partition: any) => partition.files)
      .flatMap((file: any) => hunksFromPartitionPatch(file.patch, fileHeader));

    expect(plan.partitions.length).toBeGreaterThan(1);
    expect(plan.partitions.every((partition: any) => partition.totalChars <= safeDiffCapacityChars)).toBe(true);
    // Expected ranges are literal controls independent of either implementation's cursor math.
    expect(actual).toEqual(expected);
  });

  it('rejects a producer plan whose zero-count anchor is shifted without changing coverage bytes', () => {
    const sourceHeader = '@@ -0,0 +1,3 @@';
    const body = ['+inserted-one', '+inserted-two', '+inserted-three'];
    const sourcePatch = `${fileHeader}${sourceHeader}\n${body.join('\n')}\n`;
    const expected = body.map((line, index) => `@@ -0,0 +${index + 1},1 @@\n${line}`);
    const safeDiffCapacityChars = fileHeader.length + Math.max(...expected.map((fragment) => fragment.length + 1));
    const pipeline = loadPartitionReducer();
    const partitionManager = {
      createPartitionPlan(...args: any[]) {
        const plan = pipeline.shaPartitionManager.createPartitionPlan(...args);
        const first = plan.partitions.flatMap((partition: any) => partition.files)[0];
        first.patch = first.patch.replace(/^@@ -0,0 /mu, '@@ -1,0 ');
        return plan;
      },
    };

    expect(() => createGuardedPartitionPlan(sourcePatch, safeDiffCapacityChars, partitionManager))
      .toThrow('lossless partition manager did not produce complete, bounded file and hunk coverage');
  });

  it('rejects moving a no-newline marker to a different changed line in an otherwise valid multi-copy plan', () => {
    const oldLine = '-old-without-newline';
    const newLine = '+new-with-newline';
    const firstHunk = `@@ -1 +1 @@ replacement\n${oldLine}\n${marker}\n${newLine}`;
    const laterLines = Array.from({ length: 24 }, (_unused, index) => `+later-${index}-${'y'.repeat(20)}`);
    const laterHunk = `@@ -40,0 +41,24 @@ later insertions\n${laterLines.join('\n')}`;
    const sourcePatch = `${fileHeader}${firstHunk}\n${laterHunk}\n`;
    const safeDiffCapacityChars = fileHeader.length + firstHunk.length + 1;
    const pipeline = loadPartitionReducer();
    const partitionManager = {
      createPartitionPlan(...args: any[]) {
        const plan = pipeline.shaPartitionManager.createPartitionPlan(...args);
        const target = plan.partitions.flatMap((partition: any) => partition.files)
          .find((file: any) => file.patch.includes(oldLine));
        expect(target).toBeDefined();
        target.patch = target.patch.replace(
          `${oldLine}\n${marker}\n${newLine}`,
          `${oldLine}\n${newLine}\n${marker}`,
        );
        return plan;
      },
    };

    expect(() => createGuardedPartitionPlan(sourcePatch, safeDiffCapacityChars, partitionManager))
      .toThrow('lossless partition manager did not produce complete, bounded file and hunk coverage');
  });

  it.each([
    ['orphaned before any diff line', [marker, '-old', '+new']],
    ['duplicated after its owning line', ['-old', marker, marker, '+new']],
  ] as const)('fails closed when source has a %s', (_name, malformedBody) => {
    const malformedHunk = `@@ -1,1 +1,1 @@ malformed marker control\n${malformedBody.join('\n')}`;
    const laterLines = Array.from({ length: 24 }, (_unused, index) => `+later-${index}-${'z'.repeat(20)}`);
    const laterHunk = `@@ -40,0 +41,24 @@ force bounded multi-copy admission\n${laterLines.join('\n')}`;
    const sourcePatch = `${fileHeader}${malformedHunk}\n${laterHunk}\n`;
    const safeDiffCapacityChars = fileHeader.length + malformedHunk.length + 160;

    expect(sourcePatch.length).toBeGreaterThan(safeDiffCapacityChars);
    expect(() => createGuardedPartitionPlan(sourcePatch, safeDiffCapacityChars))
      .toThrow('lossless partition manager did not produce complete, bounded file and hunk coverage');
  });

  it.each([
    ['incorrect old count', '@@ -1,2 +1,1 @@'],
    ['incorrect new count', '@@ -1,1 +1,2 @@'],
    ['unsafe old start', '@@ -9007199254740992,1 +1,1 @@'],
    ['unsafe new start', '@@ -1,1 +9007199254740992,1 @@'],
    ['unsafe old count', '@@ -1,9007199254740992 +1,1 @@'],
    ['unsafe new count', '@@ -1,1 +1,9007199254740992 @@'],
  ])('fails closed on a source header with %s', (_name, malformedHeader) => {
    const malformedHunk = `${malformedHeader}\n-old\n+new`;
    const laterLines = Array.from({ length: 24 }, (_unused, index) => `+later-${index}-${'z'.repeat(20)}`);
    const laterHunk = `@@ -40,0 +41,24 @@ force bounded multi-copy admission\n${laterLines.join('\n')}`;
    const sourcePatch = `${fileHeader}${malformedHunk}\n${laterHunk}\n`;
    const safeDiffCapacityChars = fileHeader.length + malformedHunk.length + 160;

    expect(sourcePatch.length).toBeGreaterThan(safeDiffCapacityChars);
    expect(() => createGuardedPartitionPlan(sourcePatch, safeDiffCapacityChars))
      .toThrow('lossless partition manager did not produce complete, bounded file and hunk coverage');
  });
});

type TerminalDiagnostics = {
  responseStatus?: number | null;
  errorCode?: string | null;
  generationIdDigest?: string | null;
  routerAttempt?: number | null;
  responseMode?: 'stream' | 'buffered' | null;
  outputShape?: string | null;
  finishReason?: string | null;
  findingsSource?: string | null;
  contentSizeBucket?: string | null;
  reasoningSizeBucket?: string | null;
  outputContract?: {
    policyDeclared: string; requestObserved: string;
    providerSupported: string; terminalParsed: boolean;
  } | null;
};

function diagnosticLane(kind: 'failed' | 'successful', recoveryAction: string | null) {
  const failed = kind === 'failed';
  const provider = failed ? 'anthropic' : 'openai';
  const transport = failed ? 'anthropic-failed' : 'openai-successful';
  const requestFingerprint = (failed ? 'a' : 'b').repeat(64);
  const terminalDiagnostics: TerminalDiagnostics = {
    responseStatus: failed ? 200 : 201,
    errorCode: failed ? 'parse_failed' : 'recovered_rate_limit',
    generationIdDigest: (failed ? 'e' : 'f').repeat(64),
    routerAttempt: failed ? 2 : 1,
    responseMode: failed ? 'stream' : 'buffered',
    outputShape: failed ? 'no_json' : 'direct_json_object',
    finishReason: failed ? 'length' : 'stop',
    findingsSource: failed ? 'none' : 'content',
    contentSizeBucket: failed ? 'empty' : 'small',
    reasoningSizeBucket: failed ? 'oversize' : 'empty',
    outputContract: {
      policyDeclared: failed ? 'json_schema' : 'json_object',
      requestObserved: failed ? 'json_schema' : 'json_object',
      providerSupported: failed ? 'unreported' : 'accepted', terminalParsed: !failed,
    },
  };
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
      responseStatus: terminalDiagnostics.responseStatus,
      generationIdDigest: terminalDiagnostics.generationIdDigest,
      responseMode: terminalDiagnostics.responseMode,
    }],
    recoveryAction,
    failureClass: failed ? 'malformed_output' : null,
    contentPresent: !failed, reasoningPresent: failed,
    ...terminalDiagnostics, attemptCount: 1,
  };
}

function laterFailedLane(recoveryAction: string | null) {
  const lane = { ...diagnosticLane('failed', recoveryAction), ttftMs: 149,
    responseStatus: 206, errorCode: 'later_parse_failed', generationIdDigest: 'c'.repeat(64),
    routerAttempt: 3, responseMode: 'buffered' as const,
    outputShape: 'truncated_json', finishReason: 'content_filter', findingsSource: 'reasoning',
    contentSizeBucket: 'tiny', reasoningSizeBucket: 'large',
    outputContract: { policyDeclared: 'json_object', requestObserved: 'json_object',
      providerSupported: 'rejected', terminalParsed: false } };
  lane.responseAttempts = [{ ...lane.responseAttempts[0], ttftMs: lane.ttftMs,
    responseStatus: lane.responseStatus, generationIdDigest: lane.generationIdDigest,
    responseMode: lane.responseMode, outputShape: lane.outputShape, finishReason: lane.finishReason }];
  return lane;
}

function expectTerminalAttribution(result: any, receipt: any, lane: ReturnType<typeof diagnosticLane>) {
  // All fixture values are valid literal contracts; absence must become null,
  // never a sibling's value. Do not use production normalizers as the oracle.
  const expected = {
    responseStatus: lane.responseStatus ?? null,
    errorCode: lane.errorCode ?? null,
    generationIdDigest: lane.generationIdDigest ?? null,
    routerAttempt: lane.routerAttempt ?? null,
    responseMode: lane.responseMode ?? null,
    outputShape: lane.outputShape ?? null, finishReason: lane.finishReason ?? 'missing',
    findingsSource: lane.findingsSource ?? null,
    contentSizeBucket: lane.contentSizeBucket ?? null, reasoningSizeBucket: lane.reasoningSizeBucket ?? null,
    outputContract: lane.outputContract ?? {
      policyDeclared: 'unknown', requestObserved: 'unknown', providerSupported: 'unreported', terminalParsed: false,
    },
  };
  expect(result).toMatchObject(expected);
  expect(receipt).toMatchObject(expected);
}

function withoutNullableDiagnostics(lane: ReturnType<typeof diagnosticLane>, absent: null | undefined) {
  return { ...lane, responseStatus: absent, errorCode: absent,
    generationIdDigest: absent, routerAttempt: absent, responseMode: absent,
    outputShape: absent, finishReason: absent, findingsSource: absent,
    contentSizeBucket: absent, reasoningSizeBucket: absent, outputContract: absent };
}

function reduceDiagnosticLanes(lanes: ReturnType<typeof diagnosticLane>[]) {
  const fixture = loadPartitionReducer();
  const [result] = fixture.aggregatePartitionPersonaResults(lanes.map((lane) => [lane]), [{ id: 'testing', name: 'Testing' }]);
  const receipt = fixture.buildProviderTelemetryReceipt([result], { repo: 'fixture/example', prNumber: 1 });
  return { result, receipt: receipt.lanes[0] };
}

function expectFailedAttribution(result: any, receipt: any, failed: ReturnType<typeof diagnosticLane>) {
  expectTerminalAttribution(result, receipt, failed);
  expect(result).toMatchObject({
    decision: 'ERROR', transport: failed.transport, provider: failed.provider, model: failed.model,
    ttftMs: failed.ttftMs, routerMetadata: failed.routerMetadata,
    recoveryAction: failed.recoveryAction, requestFingerprint: failed.requestFingerprint,
    contentPresent: failed.contentPresent, reasoningPresent: failed.reasoningPresent,
  });
  expect(result.responseAttempts).toHaveLength(1);
  expect(result.responseAttempts[0]).toMatchObject({
    transport: failed.provider, provider: failed.provider, ttftMs: failed.ttftMs,
    requestFingerprint: failed.requestFingerprint, outcome: 'malformed_output',
    responseStatus: failed.responseAttempts[0].responseStatus,
    responseMode: failed.responseAttempts[0].responseMode,
    generationIdDigest: failed.responseAttempts[0].generationIdDigest,
  });
  expect(receipt).toMatchObject({
    configuredTransport: failed.provider, resolvedProvider: failed.provider,
    modelDigest: createHash('sha256').update(failed.model).digest('hex'),
    routerMetadata: failed.routerMetadata, recoveryAction: failed.recoveryAction,
    requestFingerprint: failed.requestFingerprint,
    failureClass: 'malformed_output',
    contentPresent: failed.contentPresent, reasoningPresent: failed.reasoningPresent,
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
    const last = laterFailedLane(lastRecovery);
    const lanes = reversed ? [last, first] : [first, last];
    const { result, receipt } = reduceDiagnosticLanes(lanes);
    expectFailedAttribution(result, receipt, lanes[0]);
    expect(result.error).toBe(lanes[0].error);
  });

  it.each([
    ['first', null], ['last', null], ['first', undefined], ['last', undefined],
  ] as const)('keeps all missing %s failed diagnostics absent=%s instead of borrowing success', (order, absent) => {
    const failed = withoutNullableDiagnostics(diagnosticLane('failed', null), absent);
    const successful = diagnosticLane('successful', 'rate_limit_retry');
    const { result, receipt } = reduceDiagnosticLanes(order === 'first' ? [failed, successful] : [successful, failed]);
    expectFailedAttribution(result, receipt, failed);
    expect(result.recoveryAction).toBeNull();
    expect(receipt.recoveryAction).toBeNull();
  });

  it.each([null, undefined])('keeps absent=%s first-error diagnostics instead of borrowing later failure', (absent) => {
    const failed = withoutNullableDiagnostics(diagnosticLane('failed', null), absent);
    const { result, receipt } = reduceDiagnosticLanes([failed, laterFailedLane('structured_output_fallback')]);
    expectFailedAttribution(result, receipt, failed);
    expect(result.error).toBe(failed.error);
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
    const last = { ...laterFailedLane('structured_output_fallback'),
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
      routerMetadata: { strategy: 'last', region: 'eu', attempt: 4 }, requestFingerprint: 'd'.repeat(64),
      responseStatus: 202, errorCode: 'last_success_recovered', generationIdDigest: 'd'.repeat(64),
      routerAttempt: 4, responseMode: 'stream' as const, reasoningPresent: true,
      outputShape: 'fenced_json_object', finishReason: 'tool_calls', findingsSource: 'reasoning',
      contentSizeBucket: 'medium', reasoningSizeBucket: 'tiny',
      outputContract: { policyDeclared: 'json_schema', requestObserved: 'json_schema',
        providerSupported: 'unreported', terminalParsed: true } };
    const { result, receipt } = reduceDiagnosticLanes([base, last]);
    // Transport/model/attempts come from base; terminal diagnostics come from last.
    expectTerminalAttribution(result, receipt, last);
    expect(result).toMatchObject({ contentPresent: true, reasoningPresent: true });
    expect(receipt).toMatchObject({ contentPresent: true, reasoningPresent: true });
    expect(result).toMatchObject({
      decision: 'APPROVE', transport: base.transport, provider: base.provider, model: base.model,
      ttftMs: base.ttftMs, routerMetadata: base.routerMetadata,
      requestFingerprint: base.requestFingerprint, responseAttempts: base.responseAttempts,
      recoveryAction: recoveryOrder === 'first' ? 'rate_limit_retry' : 'structured_output_fallback',
    });
  });

  it.each([null, undefined])('all-success absent=%s last diagnostics do not borrow populated base', (absent) => {
    const base = diagnosticLane('successful', 'rate_limit_retry');
    const last = withoutNullableDiagnostics(diagnosticLane('successful', null), absent);
    const { result, receipt } = reduceDiagnosticLanes([base, last]);
    expectTerminalAttribution(result, receipt, last);
    expect(result).toMatchObject({ decision: 'APPROVE', transport: base.transport,
      provider: base.provider, model: base.model, responseAttempts: base.responseAttempts,
      recoveryAction: 'rate_limit_retry' });
    expect(receipt.recoveryAction).toBe('rate_limit_retry');
  });
});

// Observe the real Action entrypoint's module-load and provider/timer boundaries
// in a credential-free child. The only network seam is the child's fetch stub;
// this does not call OpenRouter or any configured provider.
const sdkRouteProbeChild = String.raw`
const events = [];
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function observeOpenRouterSdk(request, parent, isMain) {
  if (request === '@openrouter/sdk') {
    events.push('openrouter-sdk-load');
    if (process.env.DENY_OPENROUTER_SDK === 'true') {
      throw new Error('fixture denied optional OpenRouter SDK load');
    }
  }
  return Reflect.apply(originalLoad, this, [request, parent, isMain]);
};
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = function observeProviderStart(callback, delay, ...args) {
  if (delay === 15_000) events.push('provider-heartbeat-timer');
  return Reflect.apply(originalSetInterval, this, [callback, delay, ...args]);
};
globalThis.fetch = async (url) => {
  const requestUrl = String(url);
  if (requestUrl.includes('/chat/completions')) {
    events.push(requestUrl.includes('openrouter.ai')
      ? 'openrouter-completions-fetch'
      : requestUrl.includes('api.openai.com')
        ? 'direct-completions-fetch'
        : 'gateway-completions-fetch');
  }
  return new Response(JSON.stringify({
    id: 'chatcmpl-fixture', object: 'chat.completion', created: 1_790_000_000,
    model: 'fixture-model',
    choices: [{ index: 0, message: { role: 'assistant', content: '{"findings":[]}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const pipeline = require(process.env.PIPELINE);
events.push('entrypoint-import-complete');
pipeline.main().then(() => {
  const exitCode = process.exitCode ?? 0;
  console.log('SDK_ROUTE_PROBE ' + JSON.stringify({ events, exitCode }));
  // The child reports the Action's exit code in the fixture record; keep the
  // harness successful so negative fail-closed cases remain assertable.
  process.exitCode = 0;
}).catch(() => { process.exitCode = 1; });
`;

function runSdkRouteProbe(
  route: 'none' | 'direct' | 'gateway' | 'openrouter' | 'openrouter-fallback',
  denySdk = false,
) {
  const scratch = createScratchOwner({
    parentDir: requiredSuiteScratchRoot(),
    prefix: 'sdk-route-probe-',
    kind: 'sdk-route-probe-fixture',
  });
  try {
    const openrouterTransport = {
      name: 'openrouter-fixture', provider: 'openrouter', compat: 'openrouter',
      base_url: 'https://openrouter.ai/api/v1', api_key_env: 'OPENROUTER_API_KEY',
      model: 'openai/gpt-4o-mini', stream: false,
    };
    const directTransport = {
      name: 'openai-fixture', provider: 'openai',
      base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY',
      model: 'gpt-4o-mini', stream: false,
    };
    const transports = route === 'none' ? [] : route === 'openrouter'
      ? [openrouterTransport]
      : route === 'openrouter-fallback'
        ? [openrouterTransport, directTransport]
        : [route === 'gateway'
          ? {
              name: 'gateway-fixture', provider: 'openrouter', compat: 'openrouter',
              base_url: 'https://gateway.exampleorg.invalid/v1', api_key_env: 'OPENROUTER_API_KEY',
              model: 'pr-reviewer', stream: false,
            }
          : directTransport];
    const result = spawnSync(process.execPath, ['-e', sdkRouteProbeChild], {
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
        OPENROUTER_API_KEY: route === 'openrouter' || route === 'gateway' || route === 'openrouter-fallback'
          ? 'fixture-openrouter-key' : '',
        OPENAI_API_KEY: route === 'direct' || route === 'openrouter-fallback' ? 'fixture-openai-key' : '',
        DENY_OPENROUTER_SDK: denySdk ? 'true' : 'false',
        REVIEW_YETI_TRANSPORTS: JSON.stringify(transports),
        MAX_DIFF_CHARS: '10000',
        GITHUB_OUTPUT: path.join(scratch.path, 'output'),
        GITHUB_STEP_SUMMARY: path.join(scratch.path, 'summary.md'),
        RUNNER_TEMP: scratch.path,
        CT_REVIEW_CONFIG_DIR: scratch.path,
        CT_REVIEW_DATA_DIR: scratch.path,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    const probeLine = output.split('\n').find((line) => line.startsWith('SDK_ROUTE_PROBE '));
    expect(probeLine).toBeDefined();
    const outputs = fs.existsSync(path.join(scratch.path, 'output'))
      ? Object.fromEntries(fs.readFileSync(path.join(scratch.path, 'output'), 'utf8')
          .trim().split('\n').filter(Boolean).map((line) => {
            const separator = line.indexOf('=');
            return [line.slice(0, separator), line.slice(separator + 1)];
          }))
      : {};
    const telemetryName = fs.readdirSync(scratch.path)
      .find((name) => name.startsWith('review-yeti-provider-telemetry-'));
    const telemetry = telemetryName
      ? JSON.parse(fs.readFileSync(path.join(scratch.path, telemetryName), 'utf8'))
      : null;
    return {
      ...(JSON.parse(probeLine!.slice('SDK_ROUTE_PROBE '.length)) as { events: string[]; exitCode: number }),
      output,
      outputs,
      telemetry,
    };
  } finally {
    // The child is closed before this exact scratch owner is cleaned up.
    scratch.cleanup();
  }
}

describe('OpenRouter SDK initialization follows the selected transport', () => {
  it.each(['none', 'direct', 'gateway'] as const)('does not initialize the SDK for the %s route', (route) => {
    const { events } = runSdkRouteProbe(route);
    expect(events).not.toContain('openrouter-sdk-load');
    if (route === 'direct') expect(events).toContain('direct-completions-fetch');
    if (route === 'gateway') expect(events).toContain('gateway-completions-fetch');
    if (route === 'none') expect(events).not.toContain('direct-completions-fetch');
  });

  it('prewarms the SDK only after OpenRouter is selected and before provider timing starts', () => {
    const { events } = runSdkRouteProbe('openrouter');
    const importComplete = events.indexOf('entrypoint-import-complete');
    const sdkLoad = events.indexOf('openrouter-sdk-load');
    const providerTimer = events.indexOf('provider-heartbeat-timer');
    const providerFetch = events.indexOf('openrouter-completions-fetch');
    expect(importComplete).toBeGreaterThanOrEqual(0);
    expect(sdkLoad).toBeGreaterThanOrEqual(0);
    expect(sdkLoad).toBeGreaterThan(importComplete);
    expect(providerTimer).toBeGreaterThan(sdkLoad);
    expect(providerFetch).toBeGreaterThan(providerTimer);
    expect(events.filter((event) => event === 'openrouter-sdk-load')).toHaveLength(1);
  });

  it('keeps an OpenRouter-only route fail-closed when the optional SDK cannot load', () => {
    const { events, exitCode, output, outputs, telemetry } = runSdkRouteProbe('openrouter', true);
    expect(exitCode).not.toBe(0);
    expect(outputs.verdict).not.toBe('SHIP');
    expect(output).toContain('OpenRouter official SDK is unavailable: fixture denied optional OpenRouter SDK load');
    expect(events).not.toContain('openrouter-completions-fetch');
    expect(telemetry.lanes).toHaveLength(2);
    expect(telemetry.lanes.every((lane: any) => lane.failureClass === 'unknown')).toBe(true);
    expect(telemetry.lanes.every((lane: any) => lane.responseAttempts[0]?.failureClass === 'unknown')).toBe(true);
  });

  it('uses an already-configured direct fallback when the OpenRouter SDK cannot load', () => {
    const { events, exitCode, outputs, telemetry } = runSdkRouteProbe('openrouter-fallback', true);
    expect(exitCode).toBe(0);
    expect(outputs.verdict).toBe('SHIP');
    expect(events).toContain('openrouter-sdk-load');
    expect(events).toContain('direct-completions-fetch');
    expect(events).not.toContain('openrouter-completions-fetch');
    expect(telemetry.lanes).toHaveLength(2);
    expect(telemetry.lanes.every((lane: any) => lane.responseAttempts.some(
      (attempt: any) => attempt.failureClass === 'unknown' && attempt.outcome === 'transport_error',
    ))).toBe(true);
    expect(telemetry.lanes.every((lane: any) => lane.responseAttempts.some(
      (attempt: any) => attempt.outcome === 'parsed',
    ))).toBe(true);
  });
});
