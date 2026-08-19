import { appendFileSync, readFileSync } from 'node:fs';

const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
const review = policy.review_yeti;
const budget = review.budget;
const channelPattern = /^v[0-9]+(\.[0-9]+){0,2}$/;
const shaPattern = /^[0-9a-f]{40}$/;

if (policy.schema !== 'exampleorg.review-policy.v1') throw new Error('unsupported policy schema');
if (!channelPattern.test(review.action_channel)) throw new Error('review_yeti.action_channel must match ^v[0-9]+(\\.[0-9]+){0,2}$');
if (review.action_sha_override !== '' && !shaPattern.test(review.action_sha_override)) {
  throw new Error('review_yeti.action_sha_override must be empty or an immutable commit SHA');
}
const actionRefIsOverride = review.action_sha_override !== '';
const actionRef = actionRefIsOverride ? review.action_sha_override : review.action_channel;
if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
  throw new Error('review_yeti.budget must be an object');
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
}

const outputs = {
  action_ref: actionRef,
  action_ref_is_override: String(actionRefIsOverride),
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
