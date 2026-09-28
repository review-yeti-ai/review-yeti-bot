#!/usr/bin/env node

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { getEnabledTransports, loadPolicy, validatePolicy } from './review-yeti-smoke.mjs';
import { loadMcpConfig, summarizeMcpConfig, validateMcpConfig } from './review-yeti-mcp.mjs';

import { isEntrypoint } from './entrypoint-guard.mjs';
const SHA_PATTERN = /^[a-f0-9]{40,64}$/iu;
const PR_PATTERN = /^[^/\s]+\/[^#\s]+#\d+$/u;
const PR_URL_PATTERN = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?$/u;
const DEFAULT_CLI_BIN = 'reviewyeti';

function splitList(value) {
  return String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function integer(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function loadLocalPolicy(policyPath) {
  const policy = loadPolicy(policyPath);
  validatePolicy(policy);
  return policy;
}

export function buildLocalConfig(policy) {
  const review = policy.review_yeti;
  const budget = review.budget;
  const transports = getEnabledTransports(policy);
  // Ollama-only default (ADR 0490 accepted): the primary is the enabled
  // transport; retired OpenRouter lanes keep their declared contracts but are
  // not selectable here.
  const primary = transports[0];
  const routing = primary.provider_routing || {};

  return {
    version: 4,
    review: {
      investigation: {
        max_turns: integer(budget.max_investigation_turns, 'max_investigation_turns'),
      },
    },
    limits: {
      max_diff_bytes: integer(review.max_diff_chars, 'max_diff_chars'),
      max_investigation_turns: integer(budget.max_investigation_turns, 'max_investigation_turns'),
    },
    github_action: {
      dispatch_mode: review.dispatch_mode,
      transports,
      openrouter: {
        model: primary.model,
        data_collection: routing.data_collection,
        models: primary.models,
        ignore_providers: routing.ignore,
        provider_routing: routing,
        stream: review.openrouter_stream === 'true',
        timeout_ms: integer(review.openrouter_timeout_ms, 'openrouter_timeout_ms'),
        connect_timeout_ms: primary.connect_timeout_ms,
        ttft_ms: integer(review.openrouter_ttft_ms, 'openrouter_ttft_ms'),
        max_attempts: integer(review.openrouter_max_attempts, 'openrouter_max_attempts'),
      },
    },
    exclude: splitList(review.exclude),
  };
}

export const RETIRED_PROVIDER_KEY_ENVS = Object.freeze(['FIREWORKS_PR_REVIEW_API_KEY', 'FIREWORKS_API_KEY']);

export function buildLocalEnvironment(policy, configDir, baseEnv = process.env, mcpConfig = undefined) {
  const review = policy.review_yeti;
  const budget = review.budget;
  const personas = splitList(review.personas);
  const transports = getEnabledTransports(policy);

  const environment = {
    ...baseEnv,
    // The installed CLI is the only process allowed to review. It runs the pipeline in
    // publicationMode=none, but keep this explicit even when the caller is a CI shell.
    GITHUB_ACTIONS: 'false',
    GITHUB_OUTPUT: '',
    REVIEW_YETI_CONFIG_DIR: configDir,
    REVIEW_YETI_TRANSPORTS: JSON.stringify(transports),
    REVIEW_YETI_DISPATCH_MODE: review.dispatch_mode,
    ACTIVE_PERSONAS: personas.join(','),
    MAX_PERSONAS: String(personas.length),
    MAX_DIFF_CHARS: String(review.max_diff_chars),
    MAX_FILE_DIFF_CHARS: String(review.max_file_diff_chars),
    MAX_INVESTIGATION_TURNS: String(budget.max_investigation_turns),
    MAX_PASSES: String(review.max_passes),
    LANE_DEADLINE_MS: String(budget.lane_deadline_ms),
    LANE_CALL_BUDGET: String(budget.lane_call_budget),
    EXCLUDE_PATHS: review.exclude,
    OPENROUTER_STREAM: review.openrouter_stream,
    OPENROUTER_TIMEOUT_MS: String(review.openrouter_timeout_ms),
    OPENROUTER_TTFT_MS: String(review.openrouter_ttft_ms),
    OPENROUTER_MAX_ATTEMPTS: String(review.openrouter_max_attempts),
  };
  if (mcpConfig !== undefined) environment.MCP_CONFIG_JSON = JSON.stringify(validateMcpConfig(mcpConfig));
  else delete environment.MCP_CONFIG_JSON;
  const activeKeyEnvs = new Set(transports.map((transport) => transport.api_key_env));
  for (const transport of review.transports) {
    if (!activeKeyEnvs.has(transport.api_key_env)) delete environment[transport.api_key_env];
  }
  // REL-1162: removed providers are no longer declared in policy, so the loop above cannot
  // see their credentials. Scrub them explicitly so a stale key never reaches the engine.
  for (const retired of RETIRED_PROVIDER_KEY_ENVS) delete environment[retired];
  return environment;
}

export function validateReviewSource(source) {
  if (!source || typeof source !== 'object') throw new Error('one immutable review source is required');

  const selected = ['base', 'diff-file', 'pr'].filter((name) => source[name] !== undefined);
  if (selected.length !== 1) throw new Error('choose exactly one source: --base/--head, --diff-file, or --pr');

  if (source.base !== undefined) {
    if (source.head === undefined) throw new Error('--head is required with --base');
    if (!SHA_PATTERN.test(source.base) || !SHA_PATTERN.test(source.head)) {
      throw new Error('--base and --head must be full commit SHAs (40-64 hexadecimal characters)');
    }
    if (source.base.toLowerCase() === source.head.toLowerCase()) throw new Error('--base and --head must differ');
  }
  if (source.head !== undefined && source.base === undefined) throw new Error('--base is required with --head');
  if (source['diff-file'] !== undefined && !String(source['diff-file']).trim()) throw new Error('--diff-file requires a path');
  if (source.pr !== undefined && !PR_PATTERN.test(source.pr) && !PR_URL_PATTERN.test(source.pr)) {
    throw new Error('--pr must be owner/repository#number or a GitHub pull-request URL');
  }
  return source;
}

export function buildReviewInvocation(options) {
  const args = ['review'];
  if (options.base !== undefined) args.push('--base', options.base, '--head', options.head);
  if (options['diff-file'] !== undefined) args.push('--diff-file', options['diff-file']);
  if (options.pr !== undefined) args.push('--pr', options.pr);
  if (options.output !== undefined) args.push('--output', options.output);
  if (options.model !== undefined) args.push('--model', options.model);
  if (options.json) args.push('--json');
  return args;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const subcommand = command === 'mcp' ? args.shift() : undefined;
  const values = {};
  let json = false;
  let help = false;
  const valueOptions = new Set(['--policy', '--cli-bin', '--base', '--head', '--diff-file', '--pr', '--output', '--model', '--mcp-config', '--config']);

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--json') { json = true; continue; }
    if (token === '--help' || token === '-h') { help = true; continue; }
    if (!valueOptions.has(token)) throw new Error(`unknown option: ${token}`);
    if (values[token] !== undefined) throw new Error(`duplicate option: ${token}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    values[token] = value;
  }
  if (values['--mcp-config'] !== undefined && values['--config'] !== undefined) {
    throw new Error('use only one of --mcp-config or --config');
  }

  return {
    command,
    subcommand,
    json,
    help,
    policy: values['--policy'],
    cliBin: values['--cli-bin'],
    base: values['--base'],
    head: values['--head'],
    'diff-file': values['--diff-file'],
    pr: values['--pr'],
    output: values['--output'],
    model: values['--model'],
    mcpConfig: values['--mcp-config'] || values['--config'],
  };
}

function helpText() {
  return [
    'exampleorg Review Yeti local launcher',
    '',
    'Commands:',
    '  scripts/review-yeti-local check [--json]',
    '  scripts/review-yeti-local doctor [--json] [--cli-bin <path>]',
    '  scripts/review-yeti-local mcp validate --config <path> [--json]',
    '  scripts/review-yeti-local review --base <sha> --head <sha> [--json] [--output <path>]',
    '  scripts/review-yeti-local review --diff-file <path> [--json] [--output <path>]',
    '  scripts/review-yeti-local review --pr <owner/repo#number|url> [--json] [--output <path>]',
    '',
    'The launcher validates the central policy, supplies it through an ephemeral 0600 config,',
    'and delegates to an already-installed reviewyeti binary. Local reviews are read-only:',
    'they never publish comments, reviews, checks, branches, commits, or pull requests.',
    'MCP config is JSON, is validated without calling tools, and is passed to the installed',
    'engine only for local read-only review execution.',
    '',
    'Environment:',
    '  REVIEW_YETI_BIN  Override the installed reviewyeti executable.',
    '  REVIEW_YETI_POLICY_PATH  Override the central policy path for policy tests.',
  ].join('\n');
}

function resolveCliBinary(explicit) {
  const candidate = explicit || process.env.REVIEW_YETI_BIN || DEFAULT_CLI_BIN;
  if (!candidate.trim()) throw new Error('reviewyeti binary path is empty');
  return candidate;
}

function writeConfig(policy) {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'ct-review-yeti-local-'));
  const configPath = path.join(configDir, '.review-yeti.yaml');
  writeFileSync(configPath, `${JSON.stringify(buildLocalConfig(policy), null, 2)}\n`, { mode: 0o600 });
  return { configDir, configPath };
}

function policySummary(policy, policyPath) {
  const review = policy.review_yeti;
  const transports = getEnabledTransports(policy);
  const openrouter = transports.find((transport) => transport.compat === 'openrouter');
  return {
    schema: policy.schema,
    policy_source: policyPath || process.env.REVIEW_YETI_POLICY_PATH || 'policy/review-yeti.json',
    dispatch_mode: review.dispatch_mode,
    transports: transports.map((transport) => ({
      name: transport.name,
      compat: transport.compat,
      model: transport.model,
      ...(transport.models !== undefined ? { models: transport.models } : {}),
      api_key_env: transport.api_key_env,
      timeout_ms: transport.timeout_ms,
      connect_timeout_ms: transport.connect_timeout_ms,
      stream: transport.stream,
    })),
    personas: splitList(review.personas),
    limits: {
      max_diff_chars: Number(review.max_diff_chars),
      max_file_diff_chars: Number(review.max_file_diff_chars),
      max_investigation_turns: Number(review.budget.max_investigation_turns),
      lane_deadline_ms: Number(review.budget.lane_deadline_ms),
      lane_call_budget: Number(review.budget.lane_call_budget),
      max_passes: Number(review.max_passes),
    },
    openrouter: {
      data_collection: openrouter.provider_routing?.data_collection,
      ignore_providers: openrouter.provider_routing?.ignore || [],
      sort: openrouter.provider_routing?.sort,
      quantizations: openrouter.provider_routing?.quantizations || [],
    },
  };
}

function writeOutput(value, json, stream = process.stdout) {
  stream.write(`${json ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`);
}

function runDoctor(policy, options, mcpConfig) {
  const cliBin = resolveCliBinary(options.cliBin);
  const probe = spawnSync(cliBin, ['--help'], {
    cwd: process.cwd(),
    env: { ...process.env, GITHUB_ACTIONS: 'false' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const result = {
    schema: 'exampleorg.review-yeti-local-doctor-v1',
    status: probe.error || probe.status !== 0 ? 'error' : 'ok',
    repository: process.cwd(),
    reviewyeti_bin: cliBin,
    reviewyeti_installed: !probe.error && probe.status === 0,
    policy: policySummary(policy, options.policy),
  };
  if (mcpConfig) result.mcp = summarizeMcpConfig(mcpConfig, options.mcpConfig);
  if (probe.error) result.error = `could not execute ${cliBin}: ${probe.error.message}`;
  else if (probe.status !== 0) result.error = `${cliBin} --help exited with status ${probe.status}`;
  return result;
}

function runReview(policy, options) {
  validateReviewSource(options);
  const mcpConfig = options.mcpConfig ? loadMcpConfig(options.mcpConfig) : undefined;
  const { configDir } = writeConfig(policy);
  try {
    const cliBin = resolveCliBinary(options.cliBin);
    const env = buildLocalEnvironment(policy, configDir, process.env, mcpConfig);
    const result = spawnSync(cliBin, buildReviewInvocation(options), {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    });
    if (result.error) throw new Error(`could not execute ${cliBin}: ${result.error.message}`);
    return result.status === null ? 1 : result.status;
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

function runMcp(options) {
  if (!['validate', 'list'].includes(options.subcommand)) {
    throw new Error('MCP command requires validate or list');
  }
  const config = loadMcpConfig(options.mcpConfig);
  return { result: summarizeMcpConfig(config, options.mcpConfig), status: 0 };
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (!options.command || options.help || options.command === '--help' || options.command === '-h') {
      process.stdout.write(`${helpText()}\n`);
      return 0;
    }
    const policy = loadLocalPolicy(options.policy);
    if (options.command === 'check') {
      writeOutput(policySummary(policy, options.policy), options.json);
      return 0;
    }
    if (options.command === 'mcp') {
      const { result, status } = runMcp(options);
      writeOutput(result, options.json);
      return status;
    }
    if (options.command === 'doctor') {
      const mcpConfig = options.mcpConfig ? loadMcpConfig(options.mcpConfig) : undefined;
      const result = runDoctor(policy, options, mcpConfig);
      writeOutput(result, options.json);
      return result.status === 'ok' ? 0 : 1;
    }
    if (options.command === 'review') return runReview(policy, options);
    throw new Error(`unknown command: ${options.command}`);
  } catch (error) {
    process.stderr.write(`review-yeti-local: ${error.message}\n`);
    return 2;
  }
}

if (isEntrypoint(import.meta.url)) process.exitCode = main();
