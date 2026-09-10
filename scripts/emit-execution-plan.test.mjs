import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildExecutionPlan,
  buildExecutionPlanFixture,
  canonicalJson,
  sha256,
} from './emit-execution-plan.mjs';
import { EXAMPLE_API_REPOSITORY } from './review-yeti-smoke.mjs';

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
  assert.deepEqual(fixture.plan.transport_order, ['bifrost', 'openrouter-primary']);
  assert.deepEqual(fixture.plan.dispatch, {
    mode: 'ordered',
    weights: { bifrost: 1, 'openrouter-primary': 2 },
  });
  assert.deepEqual(fixture.plan.scope, {
    max_diff_chars: 2000000,
    max_file_diff_chars: 524288,
    max_incremental_diff_chars: 60000,
  });
  assert.equal(fixture.plan.lane.max_review_assignments, 24);
  assert.deepEqual(
    fixture.plan.transports.map((transport) => transport.base_url_class),
    ['exampleorg-bifrost-openai-compatible', 'openrouter-gateway'],
  );
  const bifrost = fixture.plan.transports.find((transport) => transport.name === 'bifrost');
  assert.equal(bifrost.reasoning.wire_shape, 'reasoning_effort');
  assert.equal(bifrost.model, 'ollama/glm-5.3-flash');
  assert.deepEqual(bifrost.capacity, {
    max_in_flight: 4,
    concurrency_scope: 'provider',
    wait_timeout_ms: 30000,
  });
  assert.equal(bifrost.retry.rate_limit.max_retries, 1);
  assert.equal(bifrost.quarantine.on_timeout, false);

  for (const forbidden of [
    'api_key_env',
    'BIFROST_PR_REVIEW_API_KEY',
    'REVIEW_YETI_BIFROST_API_KEY',
    'FIREWORKS_PR_REVIEW_API_KEY',
    'OLLAMA_PR_REVIEW_API_KEY',
    'OPENROUTER_PR_REVIEW_API_KEY',
    'OPENROUTER_REVIEW_FLEET_KEY',
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
      ...(configured.max_wall_clock_ms !== undefined
        ? { max_wall_clock_ms: configured.max_wall_clock_ms }
        : {}),
    });
  }
});

test('Every repository emits Bifrost primary plus OpenRouter fleet fallback', () => {
  const defaultPlan = buildExecutionPlan(committedPolicy);
  const ciscoPlan = buildExecutionPlan(committedPolicy, EXAMPLE_API_REPOSITORY);

  assert.deepEqual(defaultPlan.transport_order, ['bifrost', 'openrouter-primary']);
  assert.equal(defaultPlan.dispatch.mode, 'ordered');
  assert.deepEqual(ciscoPlan.transport_order, ['bifrost', 'openrouter-primary']);
  assert.deepEqual(ciscoPlan.dispatch, { mode: 'ordered', weights: { bifrost: 1, 'openrouter-primary': 2 } });
  assert.deepEqual(ciscoPlan.transports[0].capacity, {
    max_in_flight: 4,
    concurrency_scope: 'provider',
    wait_timeout_ms: 30000,
  });
  assert.equal(ciscoPlan.transports[0].timeouts.connect_ms, 90000);
  assert.equal(ciscoPlan.transports[0].base_url_class, 'exampleorg-bifrost-openai-compatible');
  assert.equal(ciscoPlan.transports.length, 2, 'bifrost primary plus OpenRouter fallback');
  assert.equal(ciscoPlan.transports[1].name, 'openrouter-primary');
  assert.equal(ciscoPlan.transport_order.includes('synthetic'), false);
  assert.equal(ciscoPlan.transport_order.includes('fireworks'), false);
  assert.equal(ciscoPlan.transport_order.includes('ollama'), false);
});

test('rejects unknown keys at every execution-policy object boundary', () => {
  const openrouterIndex = committedPolicy.review_yeti.transports.findIndex((transport) => transport.name === 'openrouter-primary');
  const cases = [
    ['policy', (policy) => { policy.unexpected = true; }],
    ['policy.review_yeti', (policy) => { policy.review_yeti.unexpected = true; }],
    ['policy.review_yeti.budget', (policy) => { policy.review_yeti.budget.unexpected = true; }],
    ['policy.review_yeti.transports[0]', (policy) => { policy.review_yeti.transports[0].unexpected = true; }],
    [
      `policy.review_yeti.transports[${openrouterIndex}].provider_routing`,
      (policy) => { policy.review_yeti.transports[openrouterIndex].provider_routing.unexpected = true; },
    ],
    [
      `policy.review_yeti.transports[${openrouterIndex}].provider_routing.preferred_min_throughput`,
      (policy) => {
        policy.review_yeti.transports[openrouterIndex].provider_routing.preferred_min_throughput.unexpected = true;
      },
    ],
    [
      `policy.review_yeti.transports[${openrouterIndex}].provider_routing.preferred_max_latency`,
      (policy) => {
        policy.review_yeti.transports[openrouterIndex].provider_routing.preferred_max_latency.unexpected = true;
      },
    ],
    [
      `policy.review_yeti.transports[${openrouterIndex}].models`,
      (policy) => { policy.review_yeti.transports[openrouterIndex].models = { unexpected: true }; },
    ],
  ];

  for (const [path, mutate] of cases) {
    const policy = clone(committedPolicy);
    mutate(policy);
    if (path.endsWith('.models')) {
      assert.throws(
        () => buildExecutionPlan(policy),
        /policy\.review_yeti\.transports\[\d+\]\.models must be an array of non-empty strings/,
      );
      continue;
    }
    assert.throws(() => buildExecutionPlan(policy), new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} contains unknown keys: unexpected`));
  }
});

test('rejects an unclassified base URL instead of leaking it into the fixture', () => {
  const policy = clone(committedPolicy);
  const bifrost = policy.review_yeti.transports.find((transport) => transport.name === 'bifrost');
  bifrost.base_url = 'https://credentials.example.invalid/v1';
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
