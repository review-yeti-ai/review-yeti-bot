import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const workflowPath = path.join(root, '.github/workflows/ct-review-bot.yml');
const source = readFileSync(workflowPath, 'utf8');

function stepBody(name) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step ${name}`);
  const blockStart = start + marker.length;
  const next = source.indexOf('\n      - name: ', blockStart);
  const block = source.slice(blockStart, next === -1 ? source.length : next + 1);
  const run = block.match(/^        run: \|\n([\s\S]*)$/mu);
  assert.ok(run, `missing run body for ${name}`);
  return run[1].split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

function runBody(body, overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-yeti-self-'));
  const log = path.join(directory, 'gh.log');
  const output = path.join(directory, 'github-output');
  const fakeGh = path.join(directory, 'gh');
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_LOG"
case "$*" in
  *'/check-runs?filter=all&per_page=100'*)
    if [[ "\${CHECKS_EXIT:-0}" != 0 ]]; then exit "$CHECKS_EXIT"; fi
    printf '%s\\n' "$CHECKS_JSON"
    ;;
  *'/pulls/'*)
    if [[ "\${PULL_EXIT:-0}" != 0 ]]; then exit "$PULL_EXIT"; fi
    printf '%s\\n' "$LIVE_COORDINATES"
    ;;
  *'repos/exampleorg/example-review-actions/dispatches'*)
    cat > "$PAYLOAD_CAPTURE"
    exit "\${POST_EXIT:-0}"
    ;;
  *) exit 92 ;;
esac
`);
  chmodSync(fakeGh, 0o755);
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    GH_LOG: log,
    GITHUB_OUTPUT: output,
    PAYLOAD_CAPTURE: path.join(directory, 'payload.json'),
    GH_TOKEN: 'app-token',
    EVENT_ACTION: 'labeled',
    REQUIRED_APP_ID: '4385771',
    CHECKS_EXIT: '0',
    CHECKS_JSON: JSON.stringify({ check_runs: [] }),
    PULL_EXIT: '0',
    LIVE_COORDINATES: `open\t${'a'.repeat(40)}\t${'b'.repeat(40)}`,
    POST_EXIT: '0',
    CENTRAL_EVENT_TYPE: 'review-yeti-request',
    REQUEST_ID: `example-review-actions:293:${'b'.repeat(40)}:123:1`,
    TARGET_REPOSITORY: 'exampleorg/example-review-actions',
    PR_NUMBER: '293',
    EXPECTED_BASE_SHA: 'a'.repeat(40),
    EXPECTED_HEAD_SHA: 'b'.repeat(40),
    ...overrides,
  };
  const result = spawnSync('bash', ['-c', body], { cwd: root, env, encoding: 'utf8' });
  return {
    ...result,
    output: readFileSync(output, { encoding: 'utf8', flag: 'a+' }),
    payload: readFileSync(env.PAYLOAD_CAPTURE, { encoding: 'utf8', flag: 'a+' }),
  };
}

function checkRun({
  appId = 4_385_771,
  head = 'b'.repeat(40),
  status = 'completed',
  conclusion = 'success',
  title = 'Review Yeti: SHIP',
} = {}) {
  return {
    id: 100,
    name: 'Review Yeti',
    head_sha: head,
    app: { id: appId },
    status,
    conclusion,
    output: { title },
  };
}

test('self-review is a bounded App-only dispatch-and-exit caller', () => {
  assert.match(source, /pull_request_target:/u);
  assert.match(source, /types: \[opened, synchronize, reopened, ready_for_review, labeled, unlabeled\]/u);
  assert.match(source, /repos\/exampleorg\/example-review-actions\/dispatches/u);
  assert.match(source, /create-github-app-token@[0-9a-f]{40}/u);
  assert.match(source, /^\s+permission-checks: read$/mu);
  assert.match(source, /^\s+permission-contents: write$/mu);
  assert.match(source, /^\s+permission-pull-requests: read$/mu);
  assert.doesNotMatch(source, /^\s+permission-checks: write$/mu);
  assert.match(source, /^permissions:\n  actions: read\n  contents: read\n  pull-requests: read$/mu);
  assert.doesNotMatch(source, /review-yeti\.yml@|secrets\s*:\s*inherit|OPENROUTER|FIREWORKS|GEMINI|OLLAMA_PR_REVIEW/u);
  const shell = [
    'Decide whether this head still needs a panel',
    'Validate immutable review coordinates',
    'Dispatch central Review Yeti',
  ].map(stepBody).join('\n');
  assert.doesNotMatch(shell, /(^|[;&|]\s*)(while|until)\b|\bsleep\b|\/actions\/runs|gh run (watch|view)/mu);
});

test('label replay deduplicates only an in-flight or terminal exact-App verdict', () => {
  const body = stepBody('Decide whether this head still needs a panel');
  const cases = [
    [checkRun({ status: 'in_progress', conclusion: '', title: 'Configurable persona panel running' }), 'false'],
    [checkRun(), 'false'],
    [checkRun({ conclusion: 'failure', title: 'Review Yeti: review did not complete' }), 'true'],
    [checkRun({ appId: 15368 }), 'true'],
    [checkRun({ head: 'c'.repeat(40) }), 'true'],
  ];
  for (const [run, expected] of cases) {
    const result = runBody(body, { CHECKS_JSON: JSON.stringify({ check_runs: [run] }) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, new RegExp(`dispatch=${expected}`, 'u'));
  }
});

test('coordinate guard binds repository, PR, base, head, and API success', () => {
  const body = stepBody('Validate immutable review coordinates');
  assert.equal(runBody(body).status, 0);
  assert.notEqual(runBody(body, { TARGET_REPOSITORY: 'exampleorg/not-central' }).status, 0);
  assert.notEqual(runBody(body, { LIVE_COORDINATES: `open\t${'a'.repeat(40)}\t${'c'.repeat(40)}` }).status, 0);
  assert.equal(runBody(body, { PULL_EXIT: '17' }).status, 17);
});

test('dispatch emits the exact immutable payload and propagates failure', () => {
  const body = stepBody('Dispatch central Review Yeti');
  const result = runBody(body);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.payload), {
    event_type: 'review-yeti-request',
    client_payload: {
      request_id: `example-review-actions:293:${'b'.repeat(40)}:123:1`,
      repository: 'exampleorg/example-review-actions',
      pr_number: 293,
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
    },
  });
  assert.equal(runBody(body, { POST_EXIT: '17' }).status, 17);
});

test('dispatch confirmation names the raw App check without promising a DOKS Gate check', () => {
  const body = stepBody('Confirm central Review Yeti dispatch');
  const result = runBody(body);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /App ID 4385771 publishes Review Yeti\./u);
  assert.doesNotMatch(result.stdout, /Review Yeti Gate/u);
});
