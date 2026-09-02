import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePolicyForRepository, validatePolicy } from './review-yeti-smoke.mjs';
import { TRANSPORT_RATE_LIMIT_KEYS, validateTransportEnvelope } from './transport-envelope.mjs';

const DEFAULT_POLICY_PATH = fileURLToPath(new URL('../policy/review-yeti.json', import.meta.url));
const DEFAULT_FIXTURE_PATH = fileURLToPath(new URL('../policy/review-yeti-execution-plan.fixture.json', import.meta.url));

const ALLOWED_POLICY_KEYS = ['schema', 'review_yeti', 'forbidden_target_paths'];
const ALLOWED_REVIEW_KEYS = [
  'repository',
  'action_channel',
  'action_channel_pattern',
  'personas',
  'dispatch_mode',
  'transports',
  'openrouter_stream',
  'openrouter_timeout_ms',
  'openrouter_ttft_ms',
  'openrouter_max_attempts',
  'stall_ms',
  'budget',
  'max_diff_chars',
  'max_file_diff_chars',
  'max_incremental_diff_chars',
  'max_passes',
  'exclude',
];
const ALLOWED_BUDGET_KEYS = [
  'lane_deadline_ms',
  'lane_overhead_ms',
  'lane_call_budget',
  'max_investigation_turns',
  'max_review_assignments',
];
const ALLOWED_TRANSPORT_KEYS = [
  'name',
  'enabled',
  'base_url',
  'api_key_env',
  'model',
  'models',
  'compat',
  'timeout_ms',
  'connect_timeout_ms',
  'ttft_ms',
  'stall_ms',
  'max_tokens',
  'stream',
  'structured_output',
  'perf_metrics_in_response',
  'reasoning_effort',
  'quarantine_on_timeout',
  'ignore_providers',
  'provider_routing',
  'plugins',
  'dispatch_weight',
  'max_in_flight',
  'concurrency_scope',
  'capacity_wait_timeout_ms',
  'quota_probe',
  'rate_limit',
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

export function validateExecutionPlanPolicy(policy, repository = '') {
  policy = resolvePolicyForRepository(policy, repository);
  rejectUnknownKeys(policy, ALLOWED_POLICY_KEYS, 'policy');
  rejectUnknownKeys(policy.review_yeti, ALLOWED_REVIEW_KEYS, 'policy.review_yeti');
  rejectUnknownKeys(policy.review_yeti.budget, ALLOWED_BUDGET_KEYS, 'policy.review_yeti.budget');
  if (!['ordered', 'striped'].includes(policy.review_yeti.dispatch_mode)) {
    throw new Error('policy.review_yeti.dispatch_mode must be ordered or striped');
  }

  if (!Array.isArray(policy.review_yeti.transports)) {
    throw new Error('policy.review_yeti.transports must be an array');
  }
  for (const [index, transport] of policy.review_yeti.transports.entries()) {
    const transportPath = `policy.review_yeti.transports[${index}]`;
    rejectUnknownKeys(transport, ALLOWED_TRANSPORT_KEYS, transportPath);
    if (typeof transport.enabled !== 'boolean') {
      throw new Error(`${transportPath}.enabled must be a boolean`);
    }
    if (transport.models !== undefined
      && (!Array.isArray(transport.models)
        || transport.models.some((model) => typeof model !== 'string' || model.length === 0))) {
      throw new Error(`${transportPath}.models must be an array of non-empty strings`);
    }
    if (transport.quota_probe !== undefined && transport.quota_probe !== 'synthetic-v2') {
      throw new Error(`${transportPath}.quota_probe must be synthetic-v2 when declared`);
    }
    if (!transport.rate_limit
      || typeof transport.rate_limit !== 'object'
      || Array.isArray(transport.rate_limit)) {
      throw new Error(`${transportPath}.rate_limit must be an object`);
    }
    rejectUnknownKeys(transport.rate_limit, TRANSPORT_RATE_LIMIT_KEYS, `${transportPath}.rate_limit`);
    validateTransportEnvelope(transport, transportPath);
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

  validatePolicy(policy, repository);
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

export function buildExecutionPlan(policy, repository = '') {
  policy = validateExecutionPlanPolicy(policy, repository);
  const review = policy.review_yeti;
  const transports = review.transports.filter((transport) => transport.enabled === true);
  const maxAttempts = Number(review.openrouter_max_attempts);

  return {
    schema: 'exampleorg.review-execution-plan.v1',
    policy_schema: policy.schema,
    release_channel: review.action_channel,
    transport_order: transports.map((transport) => transport.name),
    dispatch: {
      mode: review.dispatch_mode,
      weights: Object.fromEntries(transports.map((transport) => [transport.name, transport.dispatch_weight])),
    },
    lane: {
      deadline_ms: Number(review.budget.lane_deadline_ms),
      overhead_ms: Number(review.budget.lane_overhead_ms),
      max_investigation_turns: Number(review.budget.max_investigation_turns),
      max_review_assignments: Number(review.budget.max_review_assignments),
    },
    scope: {
      max_diff_chars: Number(review.max_diff_chars),
      max_file_diff_chars: Number(review.max_file_diff_chars),
      max_incremental_diff_chars: Number(review.max_incremental_diff_chars),
    },
    transports: transports.map((transport) => {
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
          stall_ms: transport.stall_ms,
          ttft_ms: transport.ttft_ms,
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
        capacity: {
          max_in_flight: transport.max_in_flight,
          concurrency_scope: transport.concurrency_scope,
          wait_timeout_ms: transport.capacity_wait_timeout_ms,
        },
        quota: {
          probe: transport.quota_probe ?? 'none',
        },
        retry: {
          max_attempts: maxAttempts,
          classification: 'http-status-and-retry-after',
          rate_limit: transport.rate_limit,
        },
        quarantine: {
          on_timeout: configuredOrUnknown(transport.quarantine_on_timeout),
        },
      };
    }),
  };
}

export function buildExecutionPlanFixture(policy, repository = '') {
  const plan = buildExecutionPlan(policy, repository);
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
    repository: process.env.REVIEW_REPOSITORY || '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') options.check = true;
    else if (argument === '--policy') options.policyPath = resolve(argv[++index] ?? '');
    else if (argument === '--fixture') options.fixturePath = resolve(argv[++index] ?? '');
    else if (argument === '--repository') options.repository = argv[++index] ?? '';
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const policy = JSON.parse(readFileSync(options.policyPath, 'utf8'));
  const rendered = `${JSON.stringify(buildExecutionPlanFixture(policy, options.repository), null, 2)}\n`;
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
