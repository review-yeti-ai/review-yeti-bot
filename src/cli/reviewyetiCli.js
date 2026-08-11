'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveReviewSource, selectSource } = require('./reviewSourceAdapters');
const { writeAtomicOutput, exitCodeForReview } = require('./atomicOutput');
const { runDoctor } = require('./doctor');

const EXIT_CODES = Object.freeze({ PASS: 0, FAIL: 1, USAGE: 2, BLOCKED: 3, CANCELLED: 130 });

function help() {
  return [
    'Review Yeti',
    '',
    'Commands:',
    '  reviewyeti review --base <sha> --head <sha> [--json] [--output <path>]',
    '  reviewyeti review --diff-file <path> [--json] [--output <path>]',
    '  reviewyeti review --pr <owner/repo#number|url> [--json] [--output <path>]',
    '  reviewyeti doctor [--json]',
    '',
    'Local reviews are read-only and never publish to GitHub. Source refs must be full commit SHAs.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = Array.from(argv || []);
  const command = args.shift();
  const values = {};
  const flags = new Set();
  const known = new Set(['--base', '--head', '--diff-file', '--pr', '--json', '--output', '--model', '--repository', '--help', '-h']);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!known.has(token)) throw new TypeError(`unknown option: ${token}`);
    if (token === '--json' || token === '--help' || token === '-h') { flags.add(token); continue; }
    if (values[token]) throw new TypeError(`duplicate option: ${token}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new TypeError(`missing value for ${token}`);
    if (token === '--output' && value === '-') throw new TypeError('--output - is not supported');
    values[token] = value;
  }
  return { command, values, flags };
}

function sourceSelection(values) {
  return selectSource({
    base: values['--base'],
    head: values['--head'],
    diffFile: values['--diff-file'],
    pullRequest: values['--pr'],
    repository: values['--repository'],
  });
}

function writeLine(writer, value) { writer.write(`${value}\n`); }

async function runWithDiagnostics(task, stderr) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => writeLine(stderr, args.join(' '));
  console.warn = (...args) => writeLine(stderr, args.join(' '));
  console.error = (...args) => writeLine(stderr, args.join(' '));
  try { return await task(); } finally { Object.assign(console, original); }
}

async function main(argv = process.argv.slice(2), supplied = {}) {
  const stdout = supplied.stdout || process.stdout;
  const stderr = supplied.stderr || process.stderr;
  let parsed;
  try { parsed = parseArgs(argv); } catch (error) { writeLine(stderr, `reviewyeti: ${error.message}`); return EXIT_CODES.USAGE; }
  if (!parsed.command || parsed.command === '--help' || parsed.command === '-h' || parsed.flags.has('--help') || parsed.flags.has('-h')) { writeLine(stdout, help()); return EXIT_CODES.PASS; }
  if (parsed.command === 'doctor') {
    const receipt = await runDoctor({ ...supplied, env: supplied.env || process.env, cwd: supplied.cwd || process.cwd(), outputDirectory: parsed.values['--output'] });
    if (parsed.flags.has('--json')) writeLine(stdout, JSON.stringify(receipt)); else writeLine(stdout, JSON.stringify(receipt, null, 2));
    return receipt.status === 'error' ? EXIT_CODES.FAIL : EXIT_CODES.PASS;
  }
  if (parsed.command !== 'review') { writeLine(stderr, 'reviewyeti: expected review or doctor'); return EXIT_CODES.USAGE; }
  let source;
  try {
    source = await resolveReviewSource(sourceSelection(parsed.values), { ...supplied, cwd: supplied.cwd || process.cwd(), env: supplied.env || process.env });
  } catch (error) {
    writeLine(stderr, `reviewyeti: ${error.message}`);
    return EXIT_CODES.USAGE;
  }
  writeLine(stderr, `Reviewing immutable source ${source.repository} ${source.baseSha.slice(0, 12)}..${source.headSha.slice(0, 12)} (${source.kind})`);
  const env = { ...(supplied.env || process.env), GITHUB_ACTIONS: 'false', PR_DIFF: '', OPENROUTER_MODEL: parsed.values['--model'] || (supplied.env || process.env).OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash-0731' };
  // Resolve the Action adapter lazily. Keeping this boundary dynamic prevents tsc from pulling
  // the workflow-only pipeline into the CLI compilation root; the package ships that canonical
  // source adapter alongside the compiled CLI.
  const runner = supplied.runReviewPipeline || require(path.resolve(__dirname, '../../src/runtime/reviewPipelineRuntime.js')).runReviewPipeline;
  let result;
  try {
    result = await runWithDiagnostics(() => runner({
      source,
      publicationMode: 'none',
      env,
      cwd: supplied.cwd || process.cwd(),
      fetchImplementation: supplied.fetchImplementation,
      commandRunner: supplied.commandRunner,
      modelClient: supplied.modelClient,
      signal: supplied.signal,
      installProcessHandlers: false,
    }), stderr);
  } catch (error) {
    writeLine(stderr, `reviewyeti: review failed: ${error.message}`);
    return error?.name === 'AbortError' ? EXIT_CODES.CANCELLED : EXIT_CODES.FAIL;
  }
  if (!result) return EXIT_CODES.FAIL;
  const receipt = { schemaVersion: 'review-yeti-review-v1', source, result };
  if (parsed.values['--output']) {
    try {
      await writeAtomicOutput(path.resolve(supplied.cwd || process.cwd(), parsed.values['--output']), `${JSON.stringify(receipt, null, 2)}\n`, { fs: fs.promises, signal: supplied.signal });
      writeLine(stderr, `Wrote atomic receipt to ${parsed.values['--output']}`);
    } catch (error) {
      writeLine(stderr, `reviewyeti: output failed: ${error.message}`);
      return EXIT_CODES.FAIL;
    }
  }
  if (parsed.flags.has('--json')) writeLine(stdout, JSON.stringify(receipt));
  else writeLine(stdout, `Verdict: ${result.verdict || result.coverage?.status || 'INCONCLUSIVE'}\nCoverage: ${result.coverage?.status || 'unknown'}\nPublication: ${result.publication?.mode || 'none'} (posted=${Boolean(result.publication?.postedViaGh)})`);
  return exitCodeForReview(result);
}

module.exports = { EXIT_CODES, help, parseArgs, main };
