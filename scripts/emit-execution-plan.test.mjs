import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildExecutionPlan,
  buildExecutionPlanFixture,
  canonicalJson,
  sha256,
} from './emit-execution-plan.mjs';

const committedPolicy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
const committedFixture = JSON.parse(
  readFileSync(new URL('../policy/review-yeti-execution-plan.fixture.json', import.meta.url), 'utf8'),
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('emits a credential-free canonical execution plan with a stable digest', () => {
  const fixture = buildExecutionPlanFixture(committedPolicy);
  const rendered = JSON.stringify(fixture);

  assert.equal(fixture.schema, 'exampleorg.review-execution-plan-fixture.v1');
  assert.deepEqual(fixture, committedFixture);
  assert.match(fixture.normalized_plan_sha256, /^[0-9a-f]{64}$/);
  assert.equal(fixture.normalized_plan_sha256, sha256(canonicalJson(fixture.plan)));
  assert.deepEqual(fixture.plan.transport_order, ['openrouter-primary', 'synthetic']);
  assert.deepEqual(fixture.plan.dispatch, {
    mode: 'striped',
    weights: { 'openrouter-primary': 2, synthetic: 1 },
  });
  assert.deepEqual(
    fixture.plan.transports.map((transport) => transport.base_url_class),
    [
      'openrouter-gateway',
      'direct-synthetic-openai-compatible',
    ],
  );
  const openrouter = fixture.plan.transports.find((transport) => transport.name === 'openrouter-primary');
  const synthetic = fixture.plan.transports.find((transport) => transport.name === 'synthetic');
  assert.equal(synthetic.reasoning.wire_shape, 'reasoning_effort');
  assert.deepEqual(synthetic.capacity, {
    max_in_flight: 5,
    concurrency_scope: 'model',
    wait_timeout_ms: 120000,
  });
  assert.deepEqual(synthetic.quota, { probe: 'synthetic-v2' });
  assert.deepEqual(synthetic.retry.rate_limit, {
    scope: 'provider',
    max_retries: 1,
    max_retry_after_ms: 5000,
  });
  assert.equal(openrouter.reasoning.wire_shape, 'reasoning.effort');
  assert.equal(openrouter.model, 'deepseek/deepseek-v4-flash-0731');
  assert.deepEqual(openrouter.capacity, {
    max_in_flight: 2,
    concurrency_scope: 'provider',
    wait_timeout_ms: 120000,
  });
  assert.deepEqual(openrouter.models, ['z-ai/glm-5.3-flash']);
  assert.equal(openrouter.request_extensions.plugins, undefined);
  assert.equal(openrouter.quarantine.on_timeout, false);
  assert.equal(openrouter.privacy.data_collection, 'deny');
  assert.deepEqual(
    openrouter.routing.provider,
    committedPolicy.review_yeti.transports.find((transport) => transport.name === 'openrouter-primary').provider_routing,
  );

  for (const forbidden of [
    'api_key_env',
    'FIREWORKS_PR_REVIEW_API_KEY',
    'OLLAMA_PR_REVIEW_API_KEY',
    'OPENROUTER_PR_REVIEW_API_KEY',
    'https://',
    'authorization',
    'bearer',
  ]) {
    assert.equal(rendered.toLowerCase().includes(forbidden.toLowerCase()), false, `${forbidden} must be absent`);
  }
});

test('derives execution deadlines from each transport handoff contract', () => {
  const plan = buildExecutionPlan(committedPolicy);
  for (const configured of committedPolicy.review_yeti.transports) {
    assert.equal(Number.isSafeInteger(configured.ttft_ms), true, `${configured.name}.ttft_ms must be explicit`);
    assert.equal(Number.isSafeInteger(configured.stall_ms), true, `${configured.name}.stall_ms must be explicit`);
  }
  for (const transport of plan.transports) {
    const configured = committedPolicy.review_yeti.transports.find((candidate) => candidate.name === transport.name);
    assert.deepEqual(transport.timeouts, {
      connect_ms: configured.connect_timeout_ms,
      request_ms: configured.timeout_ms,
      stall_ms: configured.stall_ms,
      ttft_ms: configured.ttft_ms,
    });
  }
});

test('rejects unknown keys at every execution-policy object boundary', () => {
  const cases = [
    ['policy', (policy) => { policy.unexpected = true; }],
    ['policy.review_yeti', (policy) => { policy.review_yeti.unexpected = true; }],
    ['policy.review_yeti.budget', (policy) => { policy.review_yeti.budget.unexpected = true; }],
    ['policy.review_yeti.transports[0]', (policy) => { policy.review_yeti.transports[0].unexpected = true; }],
    [
      'policy.review_yeti.transports[0].provider_routing',
      (policy) => { policy.review_yeti.transports[0].provider_routing.unexpected = true; },
    ],
    [
      'policy.review_yeti.transports[0].provider_routing.preferred_min_throughput',
      (policy) => { policy.review_yeti.transports[0].provider_routing.preferred_min_throughput.unexpected = true; },
    ],
    [
      'policy.review_yeti.transports[0].provider_routing.preferred_max_latency',
      (policy) => { policy.review_yeti.transports[0].provider_routing.preferred_max_latency.unexpected = true; },
    ],
    [
      'policy.review_yeti.transports[0].models',
      (policy) => { policy.review_yeti.transports[0].models = { unexpected: true }; },
    ],
  ];

  for (const [path, mutate] of cases) {
    const policy = clone(committedPolicy);
    mutate(policy);
    if (path.endsWith('.models')) {
      assert.throws(
        () => buildExecutionPlan(policy),
        /policy\.review_yeti\.transports\[0\]\.models must be an array of non-empty strings/,
      );
      continue;
    }
    assert.throws(() => buildExecutionPlan(policy), new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} contains unknown keys: unexpected`));
  }
});

test('rejects an unclassified base URL instead of leaking it into the fixture', () => {
  const policy = clone(committedPolicy);
  policy.review_yeti.transports[0].base_url = 'https://credentials.example.invalid/v1';
  assert.throws(
    () => buildExecutionPlan(policy),
    /base_url has no approved credential-free class/,
  );
});

test('rejects capacity and retry values outside the runtime envelope', () => {
  for (const [mutate, expected] of [
    [(policy) => { policy.review_yeti.transports[0].dispatch_weight = 26; }, /dispatch_weight must be an integer from 1 through 25/],
    [(policy) => { policy.review_yeti.transports[0].max_in_flight = 101; }, /max_in_flight must be an integer from 1 through 100/],
    [(policy) => { policy.review_yeti.transports[0].capacity_wait_timeout_ms = 180001; }, /capacity_wait_timeout_ms must be an integer from 1 through 180000/],
    [(policy) => { policy.review_yeti.transports[0].rate_limit.max_retries = 2; }, /max_retries must be 0 or 1/],
  ]) {
    const policy = clone(committedPolicy);
    mutate(policy);
    assert.throws(() => buildExecutionPlan(policy), expected);
  }
});

test('rejects a missing or malformed rate-limit policy with a structured error', () => {
  for (const value of [undefined, null, []]) {
    const policy = clone(committedPolicy);
    policy.review_yeti.transports[0].rate_limit = value;
    assert.throws(
      () => buildExecutionPlan(policy),
      /policy\.review_yeti\.transports\[0\]\.rate_limit must be an object/,
    );
  }
});
