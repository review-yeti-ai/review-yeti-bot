import { appendFileSync, readFileSync } from 'node:fs';
import { checkDeadTransportEnvelope } from './lane-deadline-invariant.mjs';
import {
  EXAMPLE_API_REPOSITORY,
  resolvePolicyForRepository,
} from './repository-policy.mjs';
import { validateTransportEnvelope } from './transport-envelope.mjs';

const targetRepository = process.env.REVIEW_REPOSITORY || '';
const policy = resolvePolicyForRepository(
  JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8')),
  targetRepository,
);
const review = policy.review_yeti;
const budget = review.budget;
const openrouterTransport = review.transports?.find((transport) => transport.compat === 'openrouter');

if (policy.schema !== 'exampleorg.review-policy.v1') throw new Error('unsupported policy schema');
if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
  throw new Error('review_yeti.budget must be an object');
}
if (typeof review.action_channel_pattern !== 'string' || review.action_channel_pattern.length === 0) {
  throw new Error('review_yeti.action_channel_pattern is required');
}
let channelPattern;
try {
  channelPattern = new RegExp(review.action_channel_pattern);
} catch {
  throw new Error('review_yeti.action_channel_pattern must be a valid regular expression');
}
if (!channelPattern.test(review.action_channel || '')) {
  throw new Error('review_yeti.action_channel is not a permitted release channel');
}
for (const key of ['lane_deadline_ms', 'lane_overhead_ms', 'lane_call_budget', 'max_review_assignments', 'max_investigation_turns']) {
  if (!/^[1-9][0-9]*$/.test(String(budget[key] ?? ''))) {
    throw new Error(`review_yeti.budget.${key} must be a positive integer string`);
  }
}
for (const key of ['openrouter_timeout_ms', 'openrouter_ttft_ms', 'openrouter_max_attempts', 'stall_ms', 'max_incremental_diff_chars']) {
  if (!/^[1-9][0-9]*$/.test(String(review[key] ?? ''))) {
    throw new Error(`review_yeti.${key} must be a positive integer string`);
  }
}
const openrouterTimeoutMs = Number(review.openrouter_timeout_ms);
const openrouterTtftMs = Number(review.openrouter_ttft_ms);
const openrouterMaxAttempts = Number(review.openrouter_max_attempts);
const maxInvestigationTurns = Number(budget.max_investigation_turns);
const stallMs = Number(review.stall_ms);
if (openrouterTtftMs > openrouterTimeoutMs) {
  throw new Error('review_yeti.openrouter_ttft_ms must not exceed openrouter_timeout_ms');
}
if (!Array.isArray(review.transports) || review.transports.length === 0) throw new Error('policy must define transports');
if (!['ordered', 'striped'].includes(review.dispatch_mode)) {
  throw new Error('review_yeti.dispatch_mode must be ordered or striped');
}
if (!openrouterTransport || (targetRepository !== EXAMPLE_API_REPOSITORY && openrouterTransport.enabled !== true)) {
  throw new Error('policy must define an enabled OpenRouter primary transport');
}
const enabledTransports = review.transports.filter((transport) => transport.enabled === true);
const transportNames = enabledTransports.map((transport) => transport.name);
if (new Set(transportNames).size !== transportNames.length) throw new Error('transport names must be unique');
for (const transport of review.transports) {
  if (typeof transport.enabled !== 'boolean') {
    throw new Error(`transport ${transport.name || '<unnamed>'} enabled must be a boolean`);
  }
  if (!transport.name || !transport.base_url || !transport.api_key_env || !transport.model || !transport.compat) {
    throw new Error(`transport ${transport.name || '<unnamed>'} is incomplete`);
  }
  for (const key of ['timeout_ms', 'connect_timeout_ms', 'ttft_ms', 'stall_ms']) {
    if (!Number.isInteger(transport[key]) || transport[key] < 1 || transport[key] > 180000) {
      throw new Error(`transport ${transport.name}.${key} must be an integer between 1ms and 180000ms`);
    }
  }
  for (const key of ['connect_timeout_ms', 'ttft_ms', 'stall_ms']) {
    if (transport[key] > transport.timeout_ms) {
      throw new Error(`transport ${transport.name}.${key} must not exceed timeout_ms`);
    }
  }
  validateTransportEnvelope(transport);
}
const expectedTransportNames = targetRepository === EXAMPLE_API_REPOSITORY
  ? ['ollama']
  : ['openrouter-primary', 'synthetic'];
if (JSON.stringify(transportNames) !== JSON.stringify(expectedTransportNames)) {
  throw new Error(`enabled transport order must be ${expectedTransportNames.join(' -> ')}`);
}
if (targetRepository === EXAMPLE_API_REPOSITORY && review.dispatch_mode !== 'ordered') {
  throw new Error('Example API must use ordered Ollama-only dispatch');
}
const fireworksTransport = review.transports.find((transport) => transport.name === 'fireworks');
if (!fireworksTransport || fireworksTransport.enabled !== false) {
  throw new Error('Fireworks must remain declared with enabled: false');
}
const ollamaTransport = review.transports.find((transport) => transport.name === 'ollama');
if (!ollamaTransport
    || ollamaTransport.max_in_flight !== 6
    || ollamaTransport.concurrency_scope !== 'provider'
    || ollamaTransport.capacity_wait_timeout_ms !== 30000
    || ollamaTransport.connect_timeout_ms !== 60000) {
  throw new Error('Ollama must use a six-lane ceiling and a 60s connect deadline so concurrent persona streams can establish');
}
if (openrouterTransport.timeout_ms !== openrouterTimeoutMs) {
  throw new Error('openrouter-primary.timeout_ms must equal review_yeti.openrouter_timeout_ms');
}
if (openrouterTransport.ttft_ms !== openrouterTtftMs) {
  throw new Error('openrouter-primary.ttft_ms must equal review_yeti.openrouter_ttft_ms');
}
if (openrouterTransport.stall_ms !== stallMs) {
  throw new Error('openrouter-primary.stall_ms must equal review_yeti.stall_ms');
}
if (Number(budget.lane_deadline_ms) < openrouterTimeoutMs * openrouterMaxAttempts) {
  throw new Error('review_yeti.budget.lane_deadline_ms must cover the OpenRouter request retry envelope');
}
if (openrouterTransport.capacity_wait_timeout_ms < openrouterTimeoutMs * openrouterMaxAttempts) {
  throw new Error('openrouter-primary.capacity_wait_timeout_ms must cover the OpenRouter request retry envelope');
}

// A lane advances through the enabled transports in order, retrying each transport up to
// openrouter_max_attempts before moving on. The released runtime re-arms its stall/idle timer on
// every SSE chunk and also enforces timeout_ms as a hard total generation ceiling. This invariant
// specifically protects the earlier failure path where a transport NEVER
// produces a first byte: connect_timeout_ms (time to establish the connection) plus one stall_ms
// interval (the engine's liveness window -- if no chunk arrives inside it, the call is declared
// dead and the lane fails over). That sum, not timeout_ms, is what has to fit inside the lane
// deadline across every transport, attempt, and investigation turn. This sums over however many
// enabled transports the policy admits, not a hardcoded count, so it stays correct as that count
// changes.
const laneDeadlineMs = Number(budget.lane_deadline_ms);
const laneOverheadMs = Number(budget.lane_overhead_ms);
const maxAttempts = Number(review.openrouter_max_attempts);
if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
  throw new Error('review_yeti.openrouter_max_attempts must be a positive integer string');
}
if (!Number.isSafeInteger(maxInvestigationTurns) || maxInvestigationTurns < 1) {
  throw new Error('review_yeti.budget.max_investigation_turns must be a positive integer string');
}
if (!Number.isSafeInteger(laneOverheadMs) || laneOverheadMs < 1) {
  throw new Error('review_yeti.budget.lane_overhead_ms must be a positive integer string');
}
checkDeadTransportEnvelope({
  transports: enabledTransports,
  maxAttempts,
  maxInvestigationTurns,
  laneOverheadMs,
  laneDeadlineMs,
});

// On a non-streaming call, the abort controller that "TTFT" is named for wraps the *entire*
// fetch, not just the wait for the first byte -- headers on a buffered response do not arrive
// until generation is done. So on that path openrouter_ttft_ms is not a time-to-first-token gate;
// it is a hard total-generation cap. This is not hypothetical: a live run showed a Fireworks call
// silently fall back to non-streaming and get killed mid-generation by the TTFT budget. Streaming
// is being made unconditional in the hosted action itself (a separate fix, not in this repo); this
// policy's job is to make sure that IF a transport is ever declared non-streaming, a tight TTFT can
// never silently become a generation ceiling -- that must be a loud policy-load failure instead of
// a config footgun that reappears the next time someone edits `stream`.
const declaredNonStreamingTransports = enabledTransports.filter((transport) => transport.stream !== true);
const streamingDeclaredGlobally = review.openrouter_stream === 'true';
if (declaredNonStreamingTransports.length > 0 || !streamingDeclaredGlobally) {
  const maxTimeoutMs = Math.max(
    ...enabledTransports.map((transport) => transport.timeout_ms),
    Number(review.openrouter_timeout_ms),
  );
  if (Number(openrouterTtftMs) < maxTimeoutMs) {
    const offenders = declaredNonStreamingTransports.map((transport) => transport.name).join(', ')
      || '(review_yeti.openrouter_stream is not "true")';
    throw new Error(
      `review_yeti.openrouter_ttft_ms (${openrouterTtftMs}ms) is tighter than the largest configured `
      + `timeout (${maxTimeoutMs}ms) while streaming is not declared on for every transport `
      + `(non-streaming: ${offenders}); on a non-streaming fallback the "TTFT" abort wraps the entire `
      + 'request and would silently become a tighter total-generation cap than the timeout it is '
      + 'supposed to live inside. Either declare stream: true on every transport (and '
      + 'openrouter_stream: "true"), or raise openrouter_ttft_ms to at least the largest timeout.',
    );
  }
}

const outputs = {
  repository: review.repository,
  action_ref: review.action_channel,
  personas: review.personas,
  dispatch_mode: review.dispatch_mode,
  transports: JSON.stringify(enabledTransports),
  // Explicit name plus a base64 twin. GitHub Actions can drop a JSON output that
  // contains credential environment names when it is forwarded into an input of
  // the same name; the action decodes transport_plan_b64 before the JSON/YAML plan.
  transport_plan: JSON.stringify(enabledTransports),
  transport_plan_b64: Buffer.from(JSON.stringify(enabledTransports), 'utf8').toString('base64'),
  openrouter_data_collection: openrouterTransport.data_collection ?? openrouterTransport.provider_routing?.data_collection ?? '',
  openrouter_ignore_providers: [
    ...(openrouterTransport.ignore_providers ?? []),
    ...(openrouterTransport.provider_routing?.ignore ?? []),
  ].filter((provider, index, providers) => providers.indexOf(provider) === index).join(','),
  openrouter_provider_routing: JSON.stringify(openrouterTransport.provider_routing ?? {}),
  openrouter_stream: review.openrouter_stream,
  openrouter_timeout_ms: review.openrouter_timeout_ms,
  openrouter_ttft_ms: review.openrouter_ttft_ms,
  openrouter_max_attempts: review.openrouter_max_attempts,
  stall_ms: review.stall_ms,
  lane_deadline_ms: budget.lane_deadline_ms,
  lane_call_budget: budget.lane_call_budget,
  max_review_assignments: budget.max_review_assignments,
  max_investigation_turns: budget.max_investigation_turns,
  max_diff_chars: review.max_diff_chars,
  max_incremental_diff_chars: review.max_incremental_diff_chars,
  max_file_diff_chars: review.max_file_diff_chars,
  max_passes: review.max_passes,
  exclude: review.exclude,
};

const outputPath = process.env.GITHUB_OUTPUT;
if (!outputPath) throw new Error('GITHUB_OUTPUT is required');
for (const [name, value] of Object.entries(outputs)) {
  const delimiter = `CT_REVIEW_${name.toUpperCase()}_${process.pid}`;
  appendFileSync(outputPath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

console.log(`Loaded standard policy ${policy.schema} with ${enabledTransports.length} enabled transports and ${review.personas.split(',').length} personas.`);
