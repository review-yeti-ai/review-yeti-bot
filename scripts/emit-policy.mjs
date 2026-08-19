import { appendFileSync, readFileSync } from 'node:fs';

const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
const review = policy.review_yeti;
const budget = review.budget;

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
if (!Array.isArray(review.transports) || review.transports.length === 0) throw new Error('policy must define transports');
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

const outputs = {
  repository: review.repository,
  action_ref: review.action_channel,
  personas: review.personas,
  transports: JSON.stringify(review.transports),
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
