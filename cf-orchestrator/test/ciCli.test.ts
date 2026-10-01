import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  validateReceipt,
  runCli,
  type ReviewRunReceipt,
} from '../src/compareOrchestratorRuns.js';

describe('CI Parity CLI: validateReceipt', () => {
  const validBaseReceipt: ReviewRunReceipt = {
    orchestrator: 'doks',
    runId: 'doks_run_101',
    repo: 'review-yeti-ai/review-yeti-bot',
    prNumber: 42,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    verdict: 'success',
    findingFingerprints: ['fp_01', 'fp_02'],
    durationMs: 45000,
    tokensUsed: { promptTokens: 10000, completionTokens: 2000, totalTokens: 12000 },
    completedAt: '2026-09-30T14:00:00.000Z',
  };

  it('accepts valid DOKS and Cloudflare receipts', () => {
    const doks = validateReceipt(validBaseReceipt, 'DOKS');
    assert.equal(doks.orchestrator, 'doks');
    assert.equal(doks.runId, 'doks_run_101');

    const cf = validateReceipt(
      { ...validBaseReceipt, orchestrator: 'cloudflare', runId: 'cf_run_101' },
      'Cloudflare'
    );
    assert.equal(cf.orchestrator, 'cloudflare');
    assert.equal(cf.runId, 'cf_run_101');
  });

  it('rejects non-object or null root', () => {
    assert.throws(
      () => validateReceipt(null, 'Test'),
      /Invalid Test receipt: root must be a non-null object/
    );
    assert.throws(
      () => validateReceipt('not an object', 'Test'),
      /Invalid Test receipt: root must be a non-null object/
    );
    assert.throws(
      () => validateReceipt([validBaseReceipt], 'Test'),
      /Invalid Test receipt: root must be a non-null object/
    );
  });

  it('rejects invalid orchestrator', () => {
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, orchestrator: 'kubernetes' }, 'Test'),
      /orchestrator must be 'doks' or 'cloudflare'/
    );
  });

  it('rejects empty or non-string runId', () => {
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, runId: '' }, 'Test'),
      /runId must be a non-empty string/
    );
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, runId: 123 }, 'Test'),
      /runId must be a non-empty string/
    );
  });

  it('rejects empty or non-string repo', () => {
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, repo: '   ' }, 'Test'),
      /repo must be a non-empty string/
    );
  });

  it('rejects invalid prNumber (0, negative, non-integer, non-number)', () => {
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, prNumber: 0 }, 'Test'),
      /prNumber must be a positive integer/
    );
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, prNumber: -5 }, 'Test'),
      /prNumber must be a positive integer/
    );
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, prNumber: 42.5 }, 'Test'),
      /prNumber must be a positive integer/
    );
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, prNumber: '42' }, 'Test'),
      /prNumber must be a positive integer/
    );
  });

  it('rejects invalid headSha (non-string, invalid hex, too short)', () => {
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, headSha: 'short' }, 'Test'),
      /headSha must be a valid commit SHA string/
    );
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, headSha: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }, 'Test'),
      /headSha must be a valid commit SHA string/
    );
  });

  it('rejects invalid verdict', () => {
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, verdict: 'pass' }, 'Test'),
      /verdict must be one of neutral, success, action_required, cancelled/
    );
  });

  it('rejects invalid findingFingerprints (not an array or containing non-strings)', () => {
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, findingFingerprints: 'fp_1' }, 'Test'),
      /findingFingerprints must be an array of strings/
    );
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, findingFingerprints: [123] }, 'Test'),
      /findingFingerprints must be an array of strings/
    );
  });

  it('rejects invalid durationMs (negative, NaN, non-number)', () => {
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, durationMs: -100 }, 'Test'),
      /durationMs must be a non-negative number/
    );
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, durationMs: NaN }, 'Test'),
      /durationMs must be a non-negative number/
    );
    assert.throws(
      () => validateReceipt({ ...validBaseReceipt, durationMs: '5000' }, 'Test'),
      /durationMs must be a non-negative number/
    );
  });
});

describe('CI Parity CLI: runCli in-process execution', () => {
  let tmpDir: string;
  let doksFile: string;
  let cfFileMatch: string;
  let cfFileMismatch: string;
  let invalidJsonFile: string;
  let invalidSchemaFile: string;
  let divergentRepoFile: string;

  const validDoks: ReviewRunReceipt = {
    orchestrator: 'doks',
    runId: 'doks_001',
    repo: 'review-yeti-ai/review-yeti-bot',
    prNumber: 42,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    verdict: 'success',
    findingFingerprints: ['fp_alpha', 'fp_beta'],
    durationMs: 40000,
    tokensUsed: { promptTokens: 10000, completionTokens: 2000, totalTokens: 12000 },
    completedAt: '2026-09-30T14:00:00.000Z',
  };

  const validCfMatch: ReviewRunReceipt = {
    ...validDoks,
    orchestrator: 'cloudflare',
    runId: 'cf_001',
    durationMs: 35000,
    tokensUsed: { promptTokens: 10000, completionTokens: 1980, totalTokens: 11980 },
  };

  const validCfMismatch: ReviewRunReceipt = {
    ...validDoks,
    orchestrator: 'cloudflare',
    runId: 'cf_002',
    verdict: 'action_required',
    findingFingerprints: ['fp_alpha', 'fp_divergent'],
  };

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-cli-test-'));
    doksFile = path.join(tmpDir, 'doks.json');
    cfFileMatch = path.join(tmpDir, 'cf-match.json');
    cfFileMismatch = path.join(tmpDir, 'cf-mismatch.json');
    invalidJsonFile = path.join(tmpDir, 'invalid.json');
    invalidSchemaFile = path.join(tmpDir, 'bad-schema.json');
    divergentRepoFile = path.join(tmpDir, 'divergent-repo.json');

    fs.writeFileSync(doksFile, JSON.stringify(validDoks, null, 2));
    fs.writeFileSync(cfFileMatch, JSON.stringify(validCfMatch, null, 2));
    fs.writeFileSync(cfFileMismatch, JSON.stringify(validCfMismatch, null, 2));
    fs.writeFileSync(invalidJsonFile, '{ "bad_json": [');
    fs.writeFileSync(invalidSchemaFile, JSON.stringify({ orchestrator: 'unknown' }));
    fs.writeFileSync(
      divergentRepoFile,
      JSON.stringify({ ...validCfMatch, repo: 'other-org/other-repo' }, null, 2)
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits with code 0 on --help', () => {
    const code = runCli(['--help']);
    assert.equal(code, 0);
  });

  it('exits with code 2 on missing --doks or --cf arguments', () => {
    assert.equal(runCli([]), 2);
    assert.equal(runCli(['--doks', doksFile]), 2);
    assert.equal(runCli(['--cf', cfFileMatch]), 2);
  });

  it('exits with code 2 on unknown argument', () => {
    const code = runCli(['--doks', doksFile, '--cf', cfFileMatch, '--bogus-flag']);
    assert.equal(code, 2);
  });

  it('exits with code 2 on missing receipt file (ENOENT)', () => {
    const nonExistent = path.join(tmpDir, 'nonexistent.json');
    const code = runCli(['--doks', nonExistent, '--cf', cfFileMatch]);
    assert.equal(code, 2);
  });

  it('exits with code 2 on invalid JSON receipt file', () => {
    const code = runCli(['--doks', invalidJsonFile, '--cf', cfFileMatch]);
    assert.equal(code, 2);
  });

  it('exits with code 2 on schema validation failure', () => {
    const code = runCli(['--doks', invalidSchemaFile, '--cf', cfFileMatch]);
    assert.equal(code, 2);
  });

  it('exits with code 2 when repositories or commit SHAs diverge across receipts', () => {
    const code = runCli(['--doks', doksFile, '--cf', divergentRepoFile]);
    assert.equal(code, 2);
  });

  it('exits with code 0 on parity match without --fail-on-mismatch', () => {
    const code = runCli(['--doks', doksFile, '--cf', cfFileMatch]);
    assert.equal(code, 0);
  });

  it('exits with code 0 on parity match with --fail-on-mismatch', () => {
    const code = runCli(['--doks', doksFile, '--cf', cfFileMatch, '--fail-on-mismatch']);
    assert.equal(code, 0);
  });

  it('exits with code 0 on parity mismatch when --fail-on-mismatch is omitted (advisory mode)', () => {
    const code = runCli(['--doks', doksFile, '--cf', cfFileMismatch]);
    assert.equal(code, 0);
  });

  it('exits with code 1 on parity mismatch when --fail-on-mismatch is enabled', () => {
    const code = runCli(['--doks', doksFile, '--cf', cfFileMismatch, '--fail-on-mismatch']);
    assert.equal(code, 1);
  });

  it('creates nested directories and writes Markdown report with --output', () => {
    const nestedOut = path.join(tmpDir, 'nested', 'reports', 'ledger.md');
    const code = runCli(['--doks', doksFile, '--cf', cfFileMatch, '--output', nestedOut]);
    assert.equal(code, 0);
    assert.ok(fs.existsSync(nestedOut));

    const content = fs.readFileSync(nestedOut, 'utf8');
    assert.ok(content.includes('### Status: ✅ MATCH'));
    assert.ok(content.includes('review-yeti-ai/review-yeti-bot'));
  });

  it('appends Markdown report to GITHUB_STEP_SUMMARY when set', () => {
    const stepSummaryFile = path.join(tmpDir, 'step_summary.md');
    fs.writeFileSync(stepSummaryFile, '# Initial Step Header\n');

    const code = runCli(
      ['--doks', doksFile, '--cf', cfFileMatch, '--github-step-summary'],
      { GITHUB_STEP_SUMMARY: stepSummaryFile }
    );
    assert.equal(code, 0);

    const summaryContent = fs.readFileSync(stepSummaryFile, 'utf8');
    assert.ok(summaryContent.includes('# Initial Step Header'));
    assert.ok(summaryContent.includes('### Status: ✅ MATCH'));
  });

  it('warns and continues cleanly when --github-step-summary is requested but env is unset', () => {
    const code = runCli(
      ['--doks', doksFile, '--cf', cfFileMatch, '--github-step-summary'],
      {} // Empty env, GITHUB_STEP_SUMMARY is undefined
    );
    assert.equal(code, 0);
  });
});

describe('CI Parity CLI: scripts/ci/compare-orchestrator-runs.ts script export parity', () => {
  it('exports validateReceipt and runCli matching src module', async () => {
    const { pathToFileURL } = await import('node:url');
    const cliPath = fs.existsSync(path.resolve(process.cwd(), 'scripts/ci/compare-orchestrator-runs.ts'))
      ? path.resolve(process.cwd(), 'scripts/ci/compare-orchestrator-runs.ts')
      : path.resolve(process.cwd(), '../../scripts/ci/compare-orchestrator-runs.ts');
    const cliModule: any = await import(pathToFileURL(cliPath).href);
    assert.equal(typeof cliModule.runCli, 'function');
    assert.equal(typeof cliModule.validateReceipt, 'function');
    assert.equal(typeof cliModule.compareRuns, 'function');
    assert.equal(typeof cliModule.formatMarkdownLedger, 'function');
    assert.equal(typeof cliModule.sanitizeMarkdownCell, 'function');
    assert.equal(typeof cliModule.computeFingerprint, 'function');

    // Test computeFingerprint and sanitizeMarkdownCell parity
    assert.equal(cliModule.computeFingerprint(null), '');
    assert.equal(
      cliModule.computeFingerprint({ file: 'src/app.ts', line: -5, ruleId: 'R1', severity: 2 }),
      'src/app.ts:1:R1:2'
    );
    assert.equal(cliModule.sanitizeMarkdownCell('a|b\nc`d`'), 'a\\|b c\\`d\\`');
  });

  it('exports matching functions from scripts/ci/compare-orchestrator-runs.js', async () => {
    const { pathToFileURL } = await import('node:url');
    const cliJsPath = fs.existsSync(path.resolve(process.cwd(), 'scripts/ci/compare-orchestrator-runs.js'))
      ? path.resolve(process.cwd(), 'scripts/ci/compare-orchestrator-runs.js')
      : path.resolve(process.cwd(), '../../scripts/ci/compare-orchestrator-runs.js');
    const cliJsModule: any = await import(pathToFileURL(cliJsPath).href);
    assert.equal(typeof cliJsModule.runCli, 'function');
    assert.equal(typeof cliJsModule.validateReceipt, 'function');
    assert.equal(typeof cliJsModule.compareRuns, 'function');
    assert.equal(typeof cliJsModule.formatMarkdownLedger, 'function');
    assert.equal(typeof cliJsModule.sanitizeMarkdownCell, 'function');
    assert.equal(typeof cliJsModule.computeFingerprint, 'function');

    // Test computeFingerprint and sanitizeMarkdownCell parity
    assert.equal(cliJsModule.computeFingerprint(null), '');
    assert.equal(
      cliJsModule.computeFingerprint({ file: 'src/app.ts', line: -5, ruleId: 'R1', severity: 2 }),
      'src/app.ts:1:R1:2'
    );
    assert.equal(cliJsModule.sanitizeMarkdownCell('a|b\nc`d`'), 'a\\|b c\\`d\\`');
  });
});
