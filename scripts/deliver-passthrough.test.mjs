import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Plan item 0.1: passthrough must never publish SHIP.
//
// Before this, the script emitted `verdict: "SHIP"`, `gate-decision=PASS` and
// `merge-eligible=true` while its own comment body said no review was completed
// -- and a pull request merged on one. These fixtures exist so that combination
// cannot come back silently.

const SCRIPT = new URL('./deliver-passthrough.sh', import.meta.url).pathname;

function run(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'passthrough-'));
  const outputs = join(dir, 'gh-output');
  const summary = join(dir, 'step-summary');
  execFileSync('bash', [SCRIPT], {
    env: {
      ...process.env,
      PATH: process.env.PATH,
      TARGET_REPO: 'exampleorg/example-workspace',
      PR_NUMBER: '2629',
      HEAD_SHA: 'a'.repeat(40),
      BASE_SHA: 'b'.repeat(40),
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: outputs,
      GITHUB_STEP_SUMMARY: summary,
      // No GH_TOKEN: comment publishing is skipped, which is the path under test.
      GH_TOKEN: '',
      ...env,
    },
    stdio: 'pipe',
  });
  const report = readdirSync(dir).find((f) => f.startsWith('review-yeti-run-report-'));
  return {
    outputs: readFileSync(outputs, 'utf8'),
    summary: readFileSync(summary, 'utf8'),
    report: JSON.parse(readFileSync(join(dir, report), 'utf8')),
  };
}

test('passthrough never emits a SHIP verdict', () => {
  const { outputs, report } = run();
  assert.equal(report.verdict, 'NO_REVIEW');
  assert.match(outputs, /review-status=NO_REVIEW/);
  assert.doesNotMatch(outputs, /review-status=SHIP/);
});

test('passthrough blocks the gate by default', () => {
  const { outputs } = run();
  assert.match(outputs, /gate-decision=BLOCK/);
  assert.match(outputs, /merge-eligible=false/);
});

test('an operator may explicitly neutralise the gate, but not turn it into SHIP', () => {
  const { outputs, report } = run({ ON_NO_REVIEW: 'neutral' });
  assert.match(outputs, /gate-decision=NEUTRAL/);
  assert.match(outputs, /merge-eligible=true/);
  // The relaxation is of the GATE, never of the verdict.
  assert.equal(report.verdict, 'NO_REVIEW');
  assert.doesNotMatch(outputs, /review-status=SHIP/);
});

test('the run report still records that zero lanes ran', () => {
  const { report } = run();
  assert.deepEqual(report.lanes, []);
  assert.equal(report.scope.fallbackReason, 'passthrough_mode');
});

test('the step summary does not describe the result as an approval', () => {
  const { summary } = run();
  assert.match(summary, /NO_REVIEW/);
  assert.match(summary, /not an approval/i);
  assert.doesNotMatch(summary, /SHIP/);
});

test('an unrecognised on-no-review value fails closed rather than passing', () => {
  // Anything that is not exactly `neutral` must block. A typo must not unblock.
  const { outputs } = run({ ON_NO_REVIEW: 'nuetral' });
  assert.match(outputs, /gate-decision=BLOCK/);
  assert.match(outputs, /merge-eligible=false/);
});
