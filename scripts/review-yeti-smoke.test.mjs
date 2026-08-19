import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EXPECTED_OPENROUTER_ROUTING,
  EXPECTED_TRANSPORT_ORDER,
  buildRequest,
  runSmoke,
  validatePolicy,
} from './review-yeti-smoke.mjs';

function policyFixture() {
  return {
    schema: 'exampleorg.review-policy.v1',
    review_yeti: {
      transports: [
        { name: 'fireworks', base_url: 'https://fireworks.test/v1', api_key_env: 'FIREWORKS_PR_REVIEW_API_KEY', model: 'fireworks-model', compat: 'openai' },
        { name: 'ollama', base_url: 'https://ollama.test/v1', api_key_env: 'OLLAMA_PR_REVIEW_API_KEY', model: 'ollama-model', compat: 'openai' },
        {
          name: 'openrouter-fallback',
          base_url: 'https://openrouter.test/api/v1',
          api_key_env: 'OPENROUTER_PR_REVIEW_API_KEY',
          model: 'openrouter-model',
          compat: 'openrouter',
          provider_routing: EXPECTED_OPENROUTER_ROUTING,
        },
      ],
    },
  };
}

test('the smoke contract pins the approved transport order', () => {
  const transports = validatePolicy(policyFixture());
  assert.deepEqual(transports.map((transport) => transport.name), EXPECTED_TRANSPORT_ORDER);
  assert.deepEqual(buildRequest(transports[2]).provider, EXPECTED_OPENROUTER_ROUTING);
  assert.deepEqual(buildRequest(transports[0]).response_format, { type: 'json_object' });
  assert.equal(buildRequest(transports[0]).max_tokens, 128);
});

test('the committed OpenRouter fallback enforces full quantization and performance preferences', () => {
  const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
  const transports = validatePolicy(policy);
  const openrouter = transports.find((transport) => transport.name === 'openrouter-fallback');

  assert.deepEqual(openrouter.provider_routing, EXPECTED_OPENROUTER_ROUTING);
  assert.equal(openrouter.provider_routing.ignore, undefined);
  assert.equal(openrouter.provider_routing.only, undefined);
});

test('the smoke suite probes every configured transport without logging credentials', async () => {
  const calls = [];
  const logs = [];
  const env = {
    FIREWORKS_PR_REVIEW_API_KEY: 'fireworks-secret',
    OLLAMA_PR_REVIEW_API_KEY: 'ollama-secret',
    OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret',
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization, request: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true,"review":"SMOKE_OK"}' } }] }) };
  };

  const result = await runSmoke({ policy: policyFixture(), env, fetchImpl, log: (line) => logs.push(line) });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://fireworks.test/v1/chat/completions',
    'https://ollama.test/v1/chat/completions',
    'https://openrouter.test/api/v1/chat/completions',
  ]);
  assert.deepEqual(result.healthy, EXPECTED_TRANSPORT_ORDER);
  assert.equal(logs.some((line) => line.includes('secret')), false);
  assert.equal(JSON.stringify(logs).includes('fireworks-secret'), false);
});

test('the smoke suite fails closed when no provider can complete the real request shape', async () => {
  const logs = [];
  await assert.rejects(
    runSmoke({
      policy: policyFixture(),
      env: {
        FIREWORKS_PR_REVIEW_API_KEY: 'fireworks-secret',
        OLLAMA_PR_REVIEW_API_KEY: 'ollama-secret',
        OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret',
      },
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      log: (line) => logs.push(line),
    }),
    /no healthy Review Yeti transport/,
  );
  assert.equal(JSON.stringify(logs).includes('secret'), false);
});

test('the smoke suite keeps healthy transports usable when an optional fallback is unhealthy', async () => {
  const logs = [];
  const result = await runSmoke({
    policy: policyFixture(),
    env: {
      FIREWORKS_PR_REVIEW_API_KEY: 'fireworks-secret',
      OLLAMA_PR_REVIEW_API_KEY: 'ollama-secret',
      OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret',
    },
    fetchImpl: async (url) => {
      if (url.startsWith('https://openrouter.test/')) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true,"review":"SMOKE_OK"}' } }] }) };
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(result.healthy, ['fireworks', 'ollama']);
  assert.equal(logs.some((line) => line.includes('unhealthy optional transport(s): openrouter-fallback (http_401)')), true);
});

test('the smoke suite treats missing keys as unavailable and still accepts a healthy fallback', async () => {
  const result = await runSmoke({
    policy: policyFixture(),
    env: { OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '```json\n{"ok":true,"review":"SMOKE_OK"}\n```' } }] }) }),
    log: () => {},
  });

  assert.deepEqual(result.healthy, ['openrouter-fallback']);
  assert.deepEqual(result.results.map((result) => result.status), ['missing', 'missing', 'healthy']);
});

test('the smoke suite rejects policy drift before any network request', () => {
  const policy = policyFixture();
  policy.review_yeti.transports.reverse();
  assert.throws(() => validatePolicy(policy), /transport order/);
});

test('the smoke suite rejects weakened OpenRouter routing before any network request', () => {
  const policy = policyFixture();
  policy.review_yeti.transports[2].provider_routing = {
    ...policy.review_yeti.transports[2].provider_routing,
  };
  delete policy.review_yeti.transports[2].provider_routing.quantizations;
  assert.throws(() => validatePolicy(policy), /OpenRouter routing/);
});
