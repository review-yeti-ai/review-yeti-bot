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
  assert.deepEqual(fixture.plan.transport_order, ['ollama', 'fireworks', 'openrouter-fallback']);
  assert.deepEqual(
    fixture.plan.transports.map((transport) => transport.base_url_class),
    [
      'direct-ollama-cloud-openai-compatible',
      'direct-fireworks-openai-compatible',
      'openrouter-gateway',
    ],
  );
  const ollama = fixture.plan.transports.find((transport) => transport.name === 'ollama');
  const fireworks = fixture.plan.transports.find((transport) => transport.name === 'fireworks');
  const openrouter = fixture.plan.transports.find((transport) => transport.name === 'openrouter-fallback');
  assert.equal(ollama.reasoning.wire_shape, 'reasoning_effort');
  assert.equal(openrouter.reasoning.wire_shape, 'reasoning.effort');
  assert.deepEqual(fireworks.timeouts, {
    connect_ms: 15_000,
    request_ms: 120_000,
    stall_ms: 20_000,
    ttft_ms: 30_000,
  });
  assert.equal(ollama.structured_output, 'runtime-default-uncharacterized');
  assert.equal(ollama.retry.classification, 'runtime-owned-uncharacterized');
  assert.equal(ollama.quarantine.on_timeout, 'runtime-default-uncharacterized');
  assert.equal(openrouter.quarantine.on_timeout, false);
  assert.equal(openrouter.privacy.data_collection, 'deny');
  assert.equal(ollama.routing.provider, null);
  assert.deepEqual(
    openrouter.routing.provider,
    committedPolicy.review_yeti.transports.find((transport) => transport.name === 'openrouter-fallback').provider_routing,
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

test('rejects unknown keys at every execution-policy object boundary', () => {
  const cases = [
    ['policy', (policy) => { policy.unexpected = true; }],
    ['policy.review_yeti', (policy) => { policy.review_yeti.unexpected = true; }],
    ['policy.review_yeti.budget', (policy) => { policy.review_yeti.budget.unexpected = true; }],
    ['policy.review_yeti.transports[0]', (policy) => { policy.review_yeti.transports[0].unexpected = true; }],
    [
      'policy.review_yeti.transports[2].provider_routing',
      (policy) => { policy.review_yeti.transports[2].provider_routing.unexpected = true; },
    ],
    [
      'policy.review_yeti.transports[2].provider_routing.preferred_min_throughput',
      (policy) => { policy.review_yeti.transports[2].provider_routing.preferred_min_throughput.unexpected = true; },
    ],
    [
      'policy.review_yeti.transports[2].provider_routing.preferred_max_latency',
      (policy) => { policy.review_yeti.transports[2].provider_routing.preferred_max_latency.unexpected = true; },
    ],
  ];

  for (const [path, mutate] of cases) {
    const policy = clone(committedPolicy);
    mutate(policy);
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
