import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PI_AUTHORING_SHA,
  PI_CODING_AGENT_VERSION,
  PI_ENGINE_VERSION,
  PI_MODEL,
  PI_QUALIFICATION_CONCURRENCY,
  PI_QUALIFICATION_TIMEOUT_MS,
  PI_ROW_TIMEOUT_MS,
  buildPiIntent,
  buildPiQualificationReceipt,
  buildPiRuntimeTask,
  normalizePiQualificationInput,
  runPiQualification,
  summarizePiRows,
} from './pi-openrouter-qualification.mjs';
import { readInstalledPiRuntimeVersions, readInvalidOutputIssueCounts } from './run-pi-qualification-row.mjs';

const sha = (character) => character.repeat(40);
const input = {
  confirm: 'QUALIFY_PI',
  repository: 'review-yeti-ai/review-yeti-bot',
  prNumber: 294,
  baseSha: sha('a'),
  headSha: sha('b'),
  botSha: sha('c'),
  botReleaseTag: 'v1.15.2',
  centralSha: sha('d'),
  ctMetaSha: PI_AUTHORING_SHA,
  botRoot: '/tmp/review-yeti-bot',
  ctMetaRoot: '/tmp/example-meta',
  piRuntimeRoot: '/tmp/pi-runtime',
  repetitions: 2,
};

const defectFixture = {
  id: 'vacuous-default-value-test',
  category: 'defect',
  title: 'Recognise both accepted bot markers',
  summary: 'SECRET ANSWER: this test is vacuous',
  expectedPaths: ['tests/test_marker_policy.py'],
  mustMatch: [['default'], ['vacuous']],
  files: [{ path: 'tests/test_marker_policy.py', patch: '@@ -1 +1 @@\n-old\n+new\n' }],
};

test('Pi mode is manual-only, parallel, and capped at fifteen minutes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/openrouter-qualification.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /^\s{2}(schedule|pull_request|pull_request_target|repository_dispatch|workflow_run|push):/mu);
  assert.match(workflow, /timeout-minutes:\s*15\b/u);
  assert.match(workflow, /execution_engine:/u);
  assert.match(workflow, /pi_workflow/u);
  assert.match(workflow, /QUALIFY_EXAMPLE_META_SHA:/u);
  assert.match(workflow, /OPENROUTER_API_KEY:/u);
  assert.match(workflow, /node scripts\/pi-openrouter-qualification\.mjs/u);
  assert.equal(PI_QUALIFICATION_CONCURRENCY, 3);
  assert.equal(PI_QUALIFICATION_TIMEOUT_MS, 600_000);
  assert.ok(PI_ROW_TIMEOUT_MS * 2 <= PI_QUALIFICATION_TIMEOUT_MS);
});

test('Pi qualification requires exact immutable coordinates and dedicated confirmation', () => {
  const normalized = normalizePiQualificationInput(input);
  assert.equal(normalized.prNumber, 294);
  assert.equal(normalized.repetitions, 2);
  assert.equal(normalized.ctMetaSha, PI_AUTHORING_SHA);
  assert.equal(normalized.model, PI_MODEL);
  assert.equal(normalized.piEngineVersion, PI_ENGINE_VERSION);
  assert.equal(normalized.piCodingAgentVersion, PI_CODING_AGENT_VERSION);
  for (const [field, value] of [
    ['confirm', 'QUALIFY'],
    ['repository', 'invalid'],
    ['baseSha', 'short'],
    ['botReleaseTag', 'main'],
    ['botRoot', 'relative'],
    ['ctMetaRoot', 'relative'],
    ['piRuntimeRoot', 'relative'],
  ]) {
    assert.throws(() => normalizePiQualificationInput({ ...input, [field]: value }));
  }
  assert.throws(() => normalizePiQualificationInput({ ...input, headSha: input.baseSha }), /must differ/u);
  assert.throws(() => normalizePiQualificationInput({ ...input, repetitions: 3 }), /repetitions/u);
  assert.throws(() => normalizePiQualificationInput({ ...input, ctMetaSha: sha('e') }), /authoring SHA/u);
});

test('generated intent binds the reviewed Pi engine contract without a fake token knob', () => {
  const intent = buildPiIntent({ fixtureId: defectFixture.id });
  assert.equal(intent.model, PI_MODEL);
  assert.equal(intent.reasoning_effort, 'high');
  assert.equal(intent.topology, 'read-only-audit');
  assert.equal(intent.trigger, 'manual');
  assert.equal(intent.publication, 'none');
  assert.equal(intent.authority, 'evidence-only');
  assert.equal(intent.limits.max_concurrency, 1);
  assert.equal(intent.limits.agent_timeout_ms, intent.limits.run_timeout_ms);
  assert.ok(intent.limits.agent_timeout_ms <= PI_ROW_TIMEOUT_MS);
  assert.equal('max_tokens' in intent, false);
  assert.equal('token_budget' in intent.limits, false);
});

test('runtime lock pins the exact reviewed Pi engine and host packages', () => {
  const lock = JSON.parse(readFileSync(new URL('../qualification/pi-runtime/package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.packages[''].dependencies['@agwab/pi-workflow'], PI_ENGINE_VERSION);
  assert.equal(lock.packages[''].dependencies['@earendil-works/pi-coding-agent'], PI_CODING_AGENT_VERSION);
  assert.equal(lock.packages[''].dependencies['@earendil-works/pi-ai'], PI_CODING_AGENT_VERSION);
  assert.equal(lock.packages['node_modules/@agwab/pi-workflow'].version, PI_ENGINE_VERSION);
  assert.equal(lock.packages['node_modules/@earendil-works/pi-coding-agent'].version, PI_CODING_AGENT_VERSION);
  assert.match(lock.packages['node_modules/@agwab/pi-workflow'].integrity, /^sha512-/u);
  assert.match(lock.packages['node_modules/@earendil-works/pi-coding-agent'].integrity, /^sha512-/u);
});

test('installed runtime attestation does not depend on package.json exports', () => {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-runtime-versions-'));
  try {
    for (const [segments, version] of [
      [['@agwab', 'pi-workflow'], PI_ENGINE_VERSION],
      [['@earendil-works', 'pi-coding-agent'], PI_CODING_AGENT_VERSION],
      [['@earendil-works', 'pi-ai'], PI_CODING_AGENT_VERSION],
    ]) {
      const packageRoot = path.join(runtimeRoot, 'node_modules', ...segments);
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ version }));
    }
    assert.deepEqual(readInstalledPiRuntimeVersions(runtimeRoot), {
      workflow: PI_ENGINE_VERSION,
      codingAgent: PI_CODING_AGENT_VERSION,
      ai: PI_CODING_AGENT_VERSION,
    });
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('invalid Pi outputs expose bounded issue codes without retaining model text', () => {
  const runRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-invalid-output-'));
  const taskRoot = path.join(runRoot, '.pi/workflows/test/tasks/task-1');
  mkdirSync(taskRoot, { recursive: true });
  const task = { files: { result: '.pi/workflows/test/tasks/task-1/result.json' } };
  try {
    writeFileSync(path.join(taskRoot, 'result.invalid-attempt-1.json'), JSON.stringify({ outputValidation: { issues: [{ code: 'invalid_json', message: 'secret model output' }, { code: 'invalid_type' }] } }));
    writeFileSync(path.join(taskRoot, 'result.invalid-attempt-2.json'), JSON.stringify({ outputValidation: { issues: [{ code: 'invalid_json' }] } }));
    writeFileSync(path.join(taskRoot, 'raw.invalid-attempt-1.md'), 'must never enter the receipt');
    assert.deepEqual(readInvalidOutputIssueCounts(runRoot, task), { invalid_json: 2, invalid_type: 1 });
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test('runtime task contains the charter and diff but never leaks grading metadata', () => {
  const task = buildPiRuntimeTask({ fixture: defectFixture, charter: 'TESTING CHARTER CONTENT' });
  assert.match(task, /TESTING CHARTER CONTENT/u);
  assert.match(task, /tests\/test_marker_policy\.py/u);
  assert.match(task, /@@ -1 \+1 @@/u);
  assert.match(task, /Map charter severity P0 to blocker, P1 to high, and P2 to medium/u);
  assert.match(task, /Return exactly <control>\{\.\.\.\}<\/control> followed by <analysis>/u);
  assert.match(task, /file, line_start, and line_end/u);
  assert.doesNotMatch(task, /SECRET ANSWER/u);
  assert.doesNotMatch(task, /expectedPaths|mustMatch|category/u);
  assert.doesNotMatch(task, /vacuous-default-value-test/u);
});

test('summary distinguishes first-pass parsing, repair, terminal errors, quality, and telemetry completeness', () => {
  const rows = [
    {
      fixtureId: 'vacuous-default-value-test', repetition: 1, category: 'defect',
      detected: true, falsePositive: false, errored: false, latencyMs: 100,
      firstAttemptParseable: true, repairAttempts: 0, terminalParsed: true,
      provider: 'openrouter', model: PI_MODEL, inputTokens: 10, outputTokens: 20, costUsd: 0.01,
    },
    {
      fixtureId: 'format-evadable-absence-guard', repetition: 1, category: 'defect',
      detected: false, falsePositive: false, errored: false, latencyMs: 300,
      firstAttemptParseable: false, repairAttempts: 1, terminalParsed: true,
      localRepairCount: 0,
      provider: 'openrouter', model: PI_MODEL, inputTokens: null, outputTokens: null, costUsd: null,
      outputIssueCounts: { invalid_json: 1, invalid_enum: 2 },
    },
    {
      fixtureId: 'clean-behavioural-guard', repetition: 1, category: 'clean',
      detected: false, falsePositive: true, errored: false, latencyMs: 200,
      firstAttemptParseable: false, repairAttempts: 0, localRepairCount: 1, terminalParsed: true,
      provider: 'openrouter', model: PI_MODEL, inputTokens: 5, outputTokens: 6, costUsd: 0.02,
    },
  ];
  const summary = summarizePiRows(rows, { repetitions: 1 });
  assert.equal(summary.rows, 3);
  assert.equal(summary.detected_defect_runs, 1);
  assert.equal(summary.false_positive_runs, 1);
  assert.equal(summary.errored_runs, 0);
  assert.equal(summary.first_attempt_parseable_runs, 1);
  assert.equal(summary.repaired_runs, 2);
  assert.equal(summary.model_repaired_runs, 1);
  assert.equal(summary.locally_repaired_runs, 1);
  assert.equal(summary.repair_attempts, 1);
  assert.equal(summary.local_repairs, 1);
  assert.deepEqual(summary.output_issue_counts, { invalid_json: 1, invalid_enum: 2 });
  assert.equal(summary.latency_ms_median, 200);
  assert.equal(summary.latency_ms_p95, 300);
  assert.equal(summary.provider_attribution_valid, true);
  assert.equal(summary.fixture_set_valid, true);
  assert.equal(summary.token_telemetry_status, 'partial');
  assert.equal(summary.cost_telemetry_status, 'partial');
});

test('receipt is sanitized, non-authoritative, exact-ref bound, and fails integrity closed', () => {
  const normalized = normalizePiQualificationInput(input);
  const rows = [
    {
      fixtureId: 'vacuous-default-value-test', repetition: 1, category: 'defect',
      detected: true, falsePositive: false, errored: false, latencyMs: 100,
      firstAttemptParseable: true, repairAttempts: 0, terminalParsed: true,
      provider: 'openrouter', model: PI_MODEL, inputTokens: 10, outputTokens: 20, costUsd: 0.01,
      promptSha256: `sha256:${'1'.repeat(64)}`, intentSha256: `sha256:${'2'.repeat(64)}`,
      specSha256: `sha256:${'3'.repeat(64)}`, resultSchemaSha256: `sha256:${'4'.repeat(64)}`,
    },
    {
      fixtureId: 'format-evadable-absence-guard', repetition: 1, category: 'defect',
      detected: true, falsePositive: false, errored: false, latencyMs: 120,
      firstAttemptParseable: false, repairAttempts: 1, terminalParsed: true,
      provider: 'openrouter', model: PI_MODEL, inputTokens: 12, outputTokens: 22, costUsd: 0.02,
      promptSha256: `sha256:${'5'.repeat(64)}`, intentSha256: `sha256:${'2'.repeat(64)}`,
      specSha256: `sha256:${'3'.repeat(64)}`, resultSchemaSha256: `sha256:${'4'.repeat(64)}`,
    },
    {
      fixtureId: 'clean-behavioural-guard', repetition: 1, category: 'clean',
      detected: false, falsePositive: false, errored: false, latencyMs: 90,
      firstAttemptParseable: true, repairAttempts: 0, terminalParsed: true,
      provider: 'openrouter', model: PI_MODEL, inputTokens: 9, outputTokens: 18, costUsd: 0.01,
      promptSha256: `sha256:${'6'.repeat(64)}`, intentSha256: `sha256:${'2'.repeat(64)}`,
      specSha256: `sha256:${'3'.repeat(64)}`, resultSchemaSha256: `sha256:${'4'.repeat(64)}`,
    },
  ];
  const receipt = buildPiQualificationReceipt({ input: { ...normalized, repetitions: 1 }, rows, runId: 'test' });
  assert.equal(receipt.schema, 'review-yeti.pi-openrouter-qualification.v1');
  assert.equal(receipt.integrity_gate.passed, true);
  assert.equal(receipt.publication, 'none');
  assert.equal(receipt.provider_mutation, 'none');
  assert.equal(receipt.production_authority, 'unchanged');
  assert.equal(receipt.activation_authorized, false);
  assert.equal(receipt.authoritative_arm, 'none');
  assert.equal(receipt.request_contract.outer_concurrency, 3);
  assert.equal(receipt.request_contract.workflow_max_concurrency, 1);
  assert.equal(receipt.request_contract.output_contract, 'pi-local-schema-and-targeted-repair');
  assert.doesNotMatch(JSON.stringify(receipt), /OPENROUTER_API_KEY|qualification-secret|openrouter-secret/u);

  const invalid = buildPiQualificationReceipt({
    input: { ...normalized, repetitions: 1 },
    rows: rows.map((row, index) => index === 0 ? { ...row, provider: 'fireworks' } : row),
    runId: 'test-invalid',
  });
  assert.equal(invalid.integrity_gate.provider_attribution_valid, false);
  assert.equal(invalid.integrity_gate.passed, false);
});

test('qualification dispatches six sterile rows with no more than three children live', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pi-qualification-orchestration-'));
  const botRoot = path.join(root, 'review-yeti-bot');
  const outputRoot = path.join(root, 'output');
  const fixtureRoot = path.join(botRoot, 'eval-baselines/verified-publication-fixtures');
  const pipelineRoot = path.join(botRoot, '.github/workflows/pipelines');
  const scriptsRoot = path.join(botRoot, 'scripts');
  for (const directory of [fixtureRoot, pipelineRoot, scriptsRoot, outputRoot]) mkdirSync(directory, { recursive: true });
  const fixtures = [
    { ...defectFixture },
    {
      ...defectFixture,
      id: 'format-evadable-absence-guard',
      title: 'Guard against checking out the pull request base SHA',
      expectedPaths: ['tests/test_workflow_guard.py'],
      files: [{ path: 'tests/test_workflow_guard.py', patch: '@@ -1 +1 @@\n-old\n+new\n' }],
    },
    {
      ...defectFixture,
      id: 'clean-behavioural-guard',
      category: 'clean',
      title: 'Anchor the base-SHA guard on the semantic token',
      expectedPaths: [],
      mustMatch: [],
      files: [{ path: 'tests/test_workflow_guard.py', patch: '@@ -1 +1 @@\n-old\n+good\n' }],
    },
  ];
  writeFileSync(path.join(fixtureRoot, 'evaluation-matrix.json'), JSON.stringify({ personaId: 'testing', fixtures }));
  writeFileSync(path.join(pipelineRoot, 'review-pipeline.js'), "module.exports = { PERSONA_CHARTERS: [{ id: 'testing', charter: 'TESTING CHARTER' }] };\n");
  writeFileSync(path.join(scriptsRoot, 'evaluate-verified-publication.mjs'), [
    'export function gradeFindings(fixture, findings, errored) {',
    '  return { errored, detected: !errored && fixture.category === "defect" && findings.length > 0, falsePositive: !errored && fixture.category === "clean" && findings.length > 0 };',
    '}',
    '',
  ].join('\n'));

  let active = 0;
  let maxActive = 0;
  let dispatches = 0;
  const promptDigests = new Map();
  const spawnImpl = (_command, args) => {
    dispatches += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    const inputPath = args[args.indexOf('--input') + 1];
    const outputPath = args[args.indexOf('--out') + 1];
    const childInput = JSON.parse(readFileSync(inputPath, 'utf8'));
    assert.deepEqual(Object.keys(childInput.fixture).sort(), ['files', 'title']);
    assert.doesNotMatch(JSON.stringify(childInput.fixture), /SECRET ANSWER|expectedPaths|mustMatch|category/u);
    const fixtureId = childInput.fixtureId;
    const promptSha256 = promptDigests.get(fixtureId) || `sha256:${String(promptDigests.size + 1).repeat(64)}`;
    promptDigests.set(fixtureId, promptSha256);
    writeFileSync(outputPath, JSON.stringify({
      fixtureId,
      repetition: childInput.repetition,
      provider: 'openrouter',
      model: PI_MODEL,
      firstAttemptParseable: childInput.repetition === 1,
      repairAttempts: childInput.repetition === 1 ? 0 : 1,
      terminalParsed: true,
      errored: false,
      latencyMs: 10,
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.01,
      usageAttempts: childInput.repetition,
      promptSha256,
      intentSha256: `sha256:${'a'.repeat(64)}`,
      specSha256: `sha256:${'b'.repeat(64)}`,
      resultSchemaSha256: `sha256:${'c'.repeat(64)}`,
      findings: fixtureId === 'clean-behavioural-guard' ? [] : [{ path: childInput.fixture.files[0].path, line: 1, title: 'defect', body: 'defect' }],
    }));
    const child = new EventEmitter();
    child.kill = () => true;
    setTimeout(() => {
      active -= 1;
      child.emit('close', 0);
    }, 5);
    return child;
  };
  const fetchImpl = async (url) => {
    if (url.includes('/pulls/')) return { ok: true, json: async () => ({ base: { sha: input.baseSha }, head: { sha: input.headSha } }) };
    if (url.includes('/git/ref/tags/')) return { ok: true, json: async () => ({ object: { type: 'commit', sha: input.botSha } }) };
    return { ok: true, json: async () => ({ commit: { verification: { verified: true } } }) };
  };
  try {
    const result = await runPiQualification({
      input: { ...input, botRoot },
      token: 'read-only-token',
      openRouterApiKey: 'openrouter-secret',
      outputDir: outputRoot,
      fetchImpl,
      spawnImpl,
      runId: 'orchestration-test',
    });
    assert.equal(dispatches, 6);
    assert.equal(maxActive, 3);
    assert.equal(result.receipt.evaluation.rows, 6);
    assert.equal(result.receipt.evaluation.detected_defect_runs, 4);
    assert.equal(result.receipt.evaluation.false_positive_runs, 0);
    assert.equal(result.receipt.evaluation.repaired_runs, 3);
    assert.equal(result.receipt.integrity_gate.passed, true);
    assert.doesNotMatch(readFileSync(result.receiptPath, 'utf8'), /openrouter-secret|SECRET ANSWER/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
