import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePolicy } from './review-yeti-smoke.mjs';

const DEFAULT_POLICY_PATH = fileURLToPath(new URL('../policy/review-yeti.json', import.meta.url));
const DEFAULT_FIXTURE_PATH = fileURLToPath(new URL('../policy/review-yeti-execution-plan.fixture.json', import.meta.url));

const ALLOWED_POLICY_KEYS = ['schema', 'review_yeti', 'forbidden_target_paths'];
const ALLOWED_REVIEW_KEYS = [
  'repository',
  'action_channel',
  'action_channel_pattern',
  'personas',
  'transports',
  'openrouter_stream',
  'openrouter_timeout_ms',
  'openrouter_ttft_ms',
  'openrouter_max_attempts',
  'stall_ms',
  'budget',
  'max_diff_chars',
  'max_file_diff_chars',
  'max_passes',
  'exclude',
];
const ALLOWED_BUDGET_KEYS = [
  'lane_deadline_ms',
  'lane_overhead_ms',
  'lane_call_budget',
  'max_investigation_turns',
];
const ALLOWED_TRANSPORT_KEYS = [
  'name',
  'base_url',
  'api_key_env',
  'model',
  'models',
  'compat',
  'timeout_ms',
  'connect_timeout_ms',
  'max_tokens',
  'stream',
  'structured_output',
  'perf_metrics_in_response',
  'reasoning_effort',
  'quarantine_on_timeout',
  'ignore_providers',
  'provider_routing',
  'plugins',
];
const ALLOWED_ROUTING_KEYS = [
  'allow_fallbacks',
  'require_parameters',
  'ignore',
  'sort',
  'preferred_min_throughput',
  'preferred_max_latency',
  'data_collection',
];
const ALLOWED_PLUGIN_KEYS = [
  'id',
  'allowed_models',
  'excluded_models',
  'cost_quality_tradeoff',
  'cost_tier',
];

const BASE_URL_CLASSES = new Map([
  ['https://generativelanguage.googleapis.com/v1beta/openai', 'direct-gemini-openai-compatible'],
  ['https://api.fireworks.ai/inference/v1', 'direct-fireworks-openai-compatible'],
  ['https://api.synthetic.new/openai/v1', 'direct-synthetic-openai-compatible'],
  ['https://ollama.com/v1', 'direct-ollama-cloud-openai-compatible'],
  ['https://openrouter.ai/api/v1', 'openrouter-gateway'],
]);

function assertObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

function rejectUnknownKeys(value, allowedKeys, path) {
  assertObject(value, path);
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new Error(`${path} contains unknown keys: ${unknown.join(', ')}`);
  }
}

export function validateExecutionPlanPolicy(policy) {
  rejectUnknownKeys(policy, ALLOWED_POLICY_KEYS, 'policy');
  rejectUnknownKeys(policy.review_yeti, ALLOWED_REVIEW_KEYS, 'policy.review_yeti');
  rejectUnknownKeys(policy.review_yeti.budget, ALLOWED_BUDGET_KEYS, 'policy.review_yeti.budget');

  if (!Array.isArray(policy.review_yeti.transports)) {
    throw new Error('policy.review_yeti.transports must be an array');
  }
  for (const [index, transport] of policy.review_yeti.transports.entries()) {
    const transportPath = `policy.review_yeti.transports[${index}]`;
    rejectUnknownKeys(transport, ALLOWED_TRANSPORT_KEYS, transportPath);
    if (transport.models !== undefined
      && (!Array.isArray(transport.models)
        || transport.models.some((model) => typeof model !== 'string' || model.length === 0))) {
      throw new Error(`${transportPath}.models must be an array of non-empty strings`);
    }
    if (transport.provider_routing !== undefined) {
      rejectUnknownKeys(transport.provider_routing, ALLOWED_ROUTING_KEYS, `${transportPath}.provider_routing`);
      if (transport.provider_routing.preferred_min_throughput !== undefined) {
        rejectUnknownKeys(
          transport.provider_routing.preferred_min_throughput,
          ['p90'],
          `${transportPath}.provider_routing.preferred_min_throughput`,
        );
      }
      if (transport.provider_routing.preferred_max_latency !== undefined) {
        rejectUnknownKeys(
          transport.provider_routing.preferred_max_latency,
          ['p99'],
          `${transportPath}.provider_routing.preferred_max_latency`,
        );
      }
    }
    if (transport.plugins !== undefined) {
      if (!Array.isArray(transport.plugins)) {
        throw new Error(`${transportPath}.plugins must be an array`);
      }
      for (const [pluginIndex, plugin] of transport.plugins.entries()) {
        const pluginPath = `${transportPath}.plugins[${pluginIndex}]`;
        rejectUnknownKeys(plugin, ALLOWED_PLUGIN_KEYS, pluginPath);
        if (typeof plugin.id !== 'string' || plugin.id.length === 0) {
          throw new Error(`${pluginPath}.id must be a non-empty string`);
        }
        for (const key of ['allowed_models', 'excluded_models']) {
          if (plugin[key] !== undefined && (!Array.isArray(plugin[key]) || plugin[key].some((model) => typeof model !== 'string' || model.length === 0))) {
            throw new Error(`${pluginPath}.${key} must be an array of non-empty strings`);
          }
        }
        if (plugin.cost_quality_tradeoff !== undefined
          && (!Number.isInteger(plugin.cost_quality_tradeoff) || plugin.cost_quality_tradeoff < 0 || plugin.cost_quality_tradeoff > 10)) {
          throw new Error(`${pluginPath}.cost_quality_tradeoff must be an integer from 0 through 10`);
        }
        if (plugin.cost_tier !== undefined
          && !['low', 'medium', 'high', 'xhigh', 'max'].includes(plugin.cost_tier)) {
          throw new Error(`${pluginPath}.cost_tier must be one of low, medium, high, xhigh, max`);
        }
      }
    }
  }

  validatePolicy(policy);
  return policy;
}

function baseUrlClass(baseUrl) {
  const normalized = String(baseUrl).replace(/\/$/, '');
  const classification = BASE_URL_CLASSES.get(normalized);
  if (!classification) {
    throw new Error(`transport base_url has no approved credential-free class: ${normalized}`);
  }
  return classification;
}

function configuredOrUnknown(value) {
  return value === undefined ? 'runtime-default-uncharacterized' : value;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function buildExecutionPlan(policy) {
  validateExecutionPlanPolicy(policy);
  const review = policy.review_yeti;
  const maxAttempts = Number(review.openrouter_max_attempts);
  const stallTimeoutMs = Number(review.stall_ms);
  const ttftTimeoutMs = Number(review.openrouter_ttft_ms);

  return {
    schema: 'exampleorg.review-execution-plan.v1',
    policy_schema: policy.schema,
    release_channel: review.action_channel,
    transport_order: review.transports.map((transport) => transport.name),
    lane: {
      deadline_ms: Number(review.budget.lane_deadline_ms),
      overhead_ms: Number(review.budget.lane_overhead_ms),
      max_investigation_turns: Number(review.budget.max_investigation_turns),
    },
    transports: review.transports.map((transport) => {
      const gatewayRouting = transport.provider_routing ?? null;
      const isGateway = transport.compat === 'openrouter';
      return {
        name: transport.name,
        base_url_class: baseUrlClass(transport.base_url),
        model: transport.model,
        ...(transport.models !== undefined ? { models: transport.models } : {}),
        compatibility_mode: transport.compat,
        timeouts: {
          connect_ms: transport.connect_timeout_ms,
          request_ms: transport.timeout_ms,
          stall_ms: stallTimeoutMs,
          ttft_ms: ttftTimeoutMs,
        },
        max_output_tokens: configuredOrUnknown(transport.max_tokens),
        streaming: transport.stream,
        structured_output: configuredOrUnknown(transport.structured_output),
        reasoning: {
          effort: configuredOrUnknown(transport.reasoning_effort),
          wire_shape: isGateway ? 'reasoning.effort' : 'reasoning_effort',
        },
        request_extensions: {
          perf_metrics_in_response: transport.perf_metrics_in_response === true,
          ...(transport.plugins !== undefined ? { plugins: transport.plugins } : {}),
        },
        routing: {
          mode: isGateway ? 'gateway-delegated' : 'direct',
          ignore_providers: transport.ignore_providers ?? [],
          provider: gatewayRouting,
        },
        privacy: {
          data_collection: gatewayRouting?.data_collection ?? 'not-declared',
        },
        retry: {
          max_attempts: maxAttempts,
          classification: 'runtime-owned-uncharacterized',
        },
        quarantine: {
          on_timeout: configuredOrUnknown(transport.quarantine_on_timeout),
        },
      };
    }),
  };
}

export function buildExecutionPlanFixture(policy) {
  const plan = buildExecutionPlan(policy);
  return {
    schema: 'exampleorg.review-execution-plan-fixture.v1',
    normalized_plan_sha256: sha256(canonicalJson(plan)),
    plan,
  };
}

function parseArgs(argv) {
  const options = {
    check: false,
    policyPath: DEFAULT_POLICY_PATH,
    fixturePath: DEFAULT_FIXTURE_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') options.check = true;
    else if (argument === '--policy') options.policyPath = resolve(argv[++index] ?? '');
    else if (argument === '--fixture') options.fixturePath = resolve(argv[++index] ?? '');
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const policy = JSON.parse(readFileSync(options.policyPath, 'utf8'));
  const rendered = `${JSON.stringify(buildExecutionPlanFixture(policy), null, 2)}\n`;
  if (options.check) {
    const committed = readFileSync(options.fixturePath, 'utf8');
    if (committed !== rendered) {
      throw new Error(`execution-plan fixture drifted; regenerate ${options.fixturePath}`);
    }
    console.log(`Execution-plan fixture is current: ${options.fixturePath}`);
    return;
  }
  process.stdout.write(rendered);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`::error::Could not emit Review Yeti execution plan: ${error.message}`);
    process.exitCode = 1;
  }
}
