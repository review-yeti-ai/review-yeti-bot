import { appendFileSync, readFileSync } from 'node:fs';

const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
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
for (const key of ['lane_deadline_ms', 'lane_call_budget', 'max_investigation_turns']) {
  if (!/^[1-9][0-9]*$/.test(String(budget[key] ?? ''))) {
    throw new Error(`review_yeti.budget.${key} must be a positive integer string`);
  }
}
for (const key of ['openrouter_timeout_ms', 'openrouter_ttft_ms', 'openrouter_max_attempts']) {
  if (!/^[1-9][0-9]*$/.test(String(review[key] ?? ''))) {
    throw new Error(`review_yeti.${key} must be a positive integer string`);
  }
}
const openrouterTimeoutMs = Number(review.openrouter_timeout_ms);
const openrouterTtftMs = Number(review.openrouter_ttft_ms);
const openrouterMaxAttempts = Number(review.openrouter_max_attempts);
if (openrouterTtftMs > openrouterTimeoutMs) {
  throw new Error('review_yeti.openrouter_ttft_ms must not exceed openrouter_timeout_ms');
}
if (!Array.isArray(review.transports) || review.transports.length === 0) throw new Error('policy must define transports');
if (!openrouterTransport) throw new Error('policy must define an OpenRouter fallback transport');
const transportNames = review.transports.map((transport) => transport.name);
if (new Set(transportNames).size !== transportNames.length) throw new Error('transport names must be unique');
for (const transport of review.transports) {
  if (!transport.name || !transport.base_url || !transport.api_key_env || !transport.model || !transport.compat) {
    throw new Error(`transport ${transport.name || '<unnamed>'} is incomplete`);
  }
  for (const key of ['timeout_ms', 'connect_timeout_ms']) {
    if (!Number.isInteger(transport[key]) || transport[key] < 1 || transport[key] > 180000) {
      throw new Error(`transport ${transport.name}.${key} must be an integer between 1ms and 180000ms`);
    }
  }
  if (transport.connect_timeout_ms > transport.timeout_ms) {
    throw new Error(`transport ${transport.name}.connect_timeout_ms must not exceed timeout_ms`);
  }
}
if (openrouterTransport.timeout_ms !== openrouterTimeoutMs) {
  throw new Error('openrouter-fallback.timeout_ms must equal review_yeti.openrouter_timeout_ms');
}
if (Number(budget.lane_deadline_ms) < openrouterTimeoutMs * openrouterMaxAttempts) {
  throw new Error('review_yeti.budget.lane_deadline_ms must cover the OpenRouter request retry envelope');
}

// A lane advances through the declared transports in order, retrying each transport up to
// openrouter_max_attempts before moving on. The worst case for one lane is therefore every
// transport burning its full timeout_ms on every attempt before the lane gives up -- if that
// product exceeds the lane deadline, later transports (the OpenRouter fallback most of all) are
// structurally unreachable in exactly the case they exist for: a slow or stalled primary. This
// sums over however many transports the policy declares, not a hardcoded count, so it stays
// correct as that count changes.
const laneDeadlineMs = Number(budget.lane_deadline_ms);
const maxAttempts = Number(review.openrouter_max_attempts);
if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
  throw new Error('review_yeti.openrouter_max_attempts must be a positive integer string');
}
const transportTimeoutSumMs = review.transports.reduce((sum, transport) => sum + transport.timeout_ms, 0);
const worstCaseTransportMs = transportTimeoutSumMs * maxAttempts;
if (worstCaseTransportMs > laneDeadlineMs) {
  throw new Error(
    `worst-case transport budget (${worstCaseTransportMs}ms = ${transportTimeoutSumMs}ms across `
    + `${review.transports.length} transports x ${maxAttempts} attempts) `
    + `exceeds review_yeti.budget.lane_deadline_ms (${laneDeadlineMs}ms); a full sequential failover `
    + 'could never reach the last transport',
  );
}

// On a non-streaming call, the abort controller that "TTFT" is named for wraps the *entire*
// fetch, not just the wait for the first byte -- headers on a buffered response do not arrive
// until generation is done. So on that path openrouter_ttft_ms is not a time-to-first-token gate;
// it is a hard total-generation cap. This is not hypothetical: a live run showed a Fireworks call
// silently fall back to non-streaming and get killed mid-generation by the TTFT budget. Streaming
// is being made unconditional in the hosted action itself (a separate fix, not in this repo); this
// policy's job is to make sure that IF a transport is ever declared non-streaming, a tight TTFT can
// never silently become a generation ceiling -- that must be a loud policy-load failure instead of
// a config footgun that reappears the next time someone edits `stream`.
const declaredNonStreamingTransports = review.transports.filter((transport) => transport.stream !== true);
const streamingDeclaredGlobally = review.openrouter_stream === 'true';
if (declaredNonStreamingTransports.length > 0 || !streamingDeclaredGlobally) {
  const maxTimeoutMs = Math.max(
    ...review.transports.map((transport) => transport.timeout_ms),
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
  transports: JSON.stringify(review.transports),
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
  lane_deadline_ms: budget.lane_deadline_ms,
  lane_call_budget: budget.lane_call_budget,
  max_investigation_turns: budget.max_investigation_turns,
  max_diff_chars: review.max_diff_chars,
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

console.log(`Loaded standard policy ${policy.schema} with ${review.transports.length} transports and ${review.personas.split(',').length} personas.`);
